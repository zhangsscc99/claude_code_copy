import type { TraceSpan } from './span.js'

/**
 * Streaming aggregation: every span updates the rollup incrementally, so reads
 * are O(1) — the classic online-vs-at-query-time tradeoff. Latency percentiles
 * come from a bounded reservoir per kind (approximate, memory-capped).
 */

const RESERVOIR_CAP = 512
const MINUTE_BUCKETS = 24 * 60

export interface ModelAgg {
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
}

export interface KindAgg {
  count: number
  errors: number
  totalMs: number
  p50: number
  p95: number
}

export interface MinuteBucket {
  minute: number
  spans: number
  errors: number
  inputTokens: number
  outputTokens: number
}

export class Aggregator {
  private spansTotal = 0
  private errorsTotal = 0
  private inputTokensTotal = 0
  private outputTokensTotal = 0
  private runs = new Map<string, 'ok' | 'error'>()
  private readonly models = new Map<string, ModelAgg>()
  private readonly kinds = new Map<string, { count: number; errors: number; totalMs: number; samples: number[] }>()
  private readonly minutes = new Map<number, MinuteBucket>()

  apply(span: TraceSpan): void {
    this.spansTotal += 1
    if (span.status === 'error') this.errorsTotal += 1

    const inputTokens = numberAttr(span, 'inputTokens')
    const outputTokens = numberAttr(span, 'outputTokens')
    this.inputTokensTotal += inputTokens
    this.outputTokensTotal += outputTokens

    if (span.kind === 'run') this.runs.set(span.traceId, span.status)

    const kind = this.kinds.get(span.kind) ?? { count: 0, errors: 0, totalMs: 0, samples: [] }
    kind.count += 1
    kind.totalMs += span.durationMs
    if (span.status === 'error') kind.errors += 1
    if (span.durationMs >= 0) {
      if (kind.samples.length < RESERVOIR_CAP) kind.samples.push(span.durationMs)
      else kind.samples[Math.floor(Math.random() * kind.samples.length)] = span.durationMs
    }
    this.kinds.set(span.kind, kind)

    if (span.model) {
      const model = this.models.get(span.model) ?? { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0 }
      if (span.kind === 'llm_call') {
        model.calls += 1
        model.inputTokens += inputTokens
        model.outputTokens += outputTokens
        if (span.status === 'error') model.errors += 1
      }
      this.models.set(span.model, model)
    }

    const minute = Math.floor(span.startedAt / 60_000)
    const bucket = this.minutes.get(minute) ?? { minute, spans: 0, errors: 0, inputTokens: 0, outputTokens: 0 }
    bucket.spans += 1
    if (span.status === 'error') bucket.errors += 1
    bucket.inputTokens += inputTokens
    bucket.outputTokens += outputTokens
    this.minutes.set(minute, bucket)
    if (this.minutes.size > MINUTE_BUCKETS) {
      const oldest = Math.min(...this.minutes.keys())
      this.minutes.delete(oldest)
    }
  }

  snapshot(): {
    totals: { traces: number; spans: number; errors: number; inputTokens: number; outputTokens: number; failedRuns: number }
    models: Record<string, ModelAgg>
    kinds: Record<string, KindAgg>
    minutes: MinuteBucket[]
  } {
    const kinds: Record<string, KindAgg> = {}
    for (const [name, agg] of this.kinds) {
      const sorted = [...agg.samples].sort((a, b) => a - b)
      kinds[name] = {
        count: agg.count,
        errors: agg.errors,
        totalMs: agg.totalMs,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
      }
    }
    return {
      totals: {
        traces: this.runs.size,
        spans: this.spansTotal,
        errors: this.errorsTotal,
        inputTokens: this.inputTokensTotal,
        outputTokens: this.outputTokensTotal,
        failedRuns: [...this.runs.values()].filter((status) => status === 'error').length,
      },
      models: Object.fromEntries(this.models),
      kinds,
      minutes: [...this.minutes.values()].sort((a, b) => a.minute - b.minute),
    }
  }
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

function numberAttr(span: TraceSpan, key: string): number {
  const value = span.attrs?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
