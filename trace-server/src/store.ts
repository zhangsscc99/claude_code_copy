import { appendFile, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import type { TraceSpan } from './span.js'

/**
 * Storage = append-only JSONL WAL + in-memory materialized views.
 * The WAL gives durability and replay; the in-memory trace map (LRU-capped)
 * serves waterfall queries without scanning. Swap the view layer for
 * ClickHouse/PG in production — the pipeline shape stays identical.
 */

export interface TraceSummary {
  traceId: string
  name: string
  status: 'ok' | 'error' | 'running'
  startedAt: number
  lastActivity: number
  durationMs: number
  spanCount: number
  errorCount: number
  inputTokens: number
  outputTokens: number
  stopReason?: string
  model?: string
}

interface TraceEntry {
  spans: TraceSpan[]
  byId: Map<string, TraceSpan>
  lastActivity: number
}

const MAX_TRACES = 5000

export class TraceStore {
  private readonly traces = new Map<string, TraceEntry>()
  private spansSeen = 0
  private seqMax = 0
  private seqGaps = 0
  private wal?: Awaited<ReturnType<typeof open>>
  private walQueue: Promise<void> = Promise.resolve()

  constructor(private readonly dir: string) {}

  /** Replay the WAL tail so a restart keeps recent history. */
  async init(replayLines = 50_000): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const file = path.join(this.dir, 'spans.jsonl')
    this.wal = await open(file, 'a+')
    try {
      const stat = await this.wal.stat()
      const readSize = Math.min(stat.size, 32 * 1024 * 1024)
      const buffer = Buffer.alloc(readSize)
      await this.wal.read(buffer, 0, readSize, Math.max(0, stat.size - readSize))
      const lines = buffer.toString('utf8').split('\n').slice(-replayLines)
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const span = JSON.parse(line) as TraceSpan
          if (span && typeof span.traceId === 'string') this.index(span)
        } catch {
          // A torn last line is normal after a crash; skip it.
        }
      }
    } finally {
      // Keep the handle open for appends.
    }
  }

  get counts(): { traces: number; spans: number; seqGaps: number } {
    return { traces: this.traces.size, spans: this.spansSeen, seqGaps: this.seqGaps }
  }

  async ingest(span: TraceSpan): Promise<void> {
    this.index(span)
    this.walQueue = this.walQueue.then(() => this.wal?.appendFile(JSON.stringify(span) + '\n') as Promise<void>)
    await this.walQueue
  }

  private index(span: TraceSpan): void {
    this.spansSeen += 1
    if (span.seq > this.seqMax + 1) this.seqGaps += span.seq - this.seqMax - 1
    if (span.seq > this.seqMax) this.seqMax = span.seq

    let entry = this.traces.get(span.traceId)
    if (!entry) {
      entry = { spans: [], byId: new Map(), lastActivity: 0 }
      this.traces.set(span.traceId, entry)
    }
    // Map#delete+set keeps insertion order == recency for LRU eviction.
    this.traces.delete(span.traceId)
    this.traces.set(span.traceId, entry)
    if (!entry.byId.has(span.spanId)) {
      entry.byId.set(span.spanId, span)
      entry.spans.push(span)
      entry.spans.sort((a, b) => a.startedAt - b.startedAt)
    }
    entry.lastActivity = Math.max(entry.lastActivity, span.endedAt)

    while (this.traces.size > MAX_TRACES) {
      const oldestKey = this.traces.keys().next().value
      if (oldestKey === undefined) break
      this.traces.delete(oldestKey)
    }
  }

  list(limit: number, before?: number): TraceSummary[] {
    const entries = [...this.traces.entries()]
      .map(([traceId, entry]) => summarize(traceId, entry))
      .filter((summary) => before === undefined || summary.lastActivity < before)
      .sort((a, b) => b.lastActivity - a.lastActivity)
    return entries.slice(0, Math.max(1, Math.min(limit, 500)))
  }

  get(traceId: string): { summary: TraceSummary; spans: TraceSpan[] } | undefined {
    const entry = this.traces.get(traceId)
    if (!entry) return undefined
    return { summary: summarize(traceId, entry), spans: entry.spans }
  }

  async close(): Promise<void> {
    await this.walQueue
    await this.wal?.close()
  }
}

function summarize(traceId: string, entry: TraceEntry): TraceSummary {
  const run = entry.spans.find((span) => span.kind === 'run')
  const startedAt = run?.startedAt ?? entry.spans[0]?.startedAt ?? 0
  const endedAt = run?.endedAt ?? entry.lastActivity
  let errorCount = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const span of entry.spans) {
    if (span.status === 'error') errorCount += 1
    if (span.kind === 'llm_call') {
      inputTokens += numberAttr(span, 'inputTokens')
      outputTokens += numberAttr(span, 'outputTokens')
    }
  }
  const stopReason = run?.attrs?.stopReason
  const summary: TraceSummary = {
    traceId,
    name: run?.name ?? 'run',
    status: run ? run.status : 'running',
    startedAt,
    lastActivity: entry.lastActivity,
    durationMs: Math.max(0, endedAt - startedAt),
    spanCount: entry.spans.length,
    errorCount,
    inputTokens,
    outputTokens,
    ...(typeof stopReason === 'string' ? { stopReason } : {}),
    ...(run?.model ? { model: run.model } : {}),
  }
  return summary
}

function numberAttr(span: TraceSpan, key: string): number {
  const value = span.attrs?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
