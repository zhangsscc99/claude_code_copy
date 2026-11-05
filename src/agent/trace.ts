import { randomUUID } from 'node:crypto'

/**
 * Dynamic workflow trace collection for the agent loop.
 *
 * Design (OTel-shaped, telemetry must never hurt the agent):
 * - Spans form a tree per run: run > turn > llm_call | tool_call | compact | collapse.
 * - The bus is a bounded MPSC queue; when full it drops the oldest span and
 *   counts it, so a dead collector can never block or OOM the agent.
 * - A background flusher ships batches by size or time. Delivery is
 *   at-most-once; every span carries a monotonically increasing `seq` so the
 *   collector can detect gaps.
 * - Sinks are pluggable: HTTP batch POST to a collector (OTLP-ish) or direct
 *   Kafka produce. Kafka is loaded lazily so the dependency stays optional.
 */

export type SpanKind =
  | 'run'
  | 'turn'
  | 'llm_call'
  | 'tool_call'
  | 'permission'
  | 'compact'
  | 'collapse'

export interface TraceSpan {
  schema: 'agent-trace/1'
  seq: number
  traceId: string
  spanId: string
  parentSpanId?: string
  kind: SpanKind
  /** tool name, model id, or phase label */
  name: string
  turn?: number
  model?: string
  /** epoch ms */
  startedAt: number
  endedAt: number
  durationMs: number
  status: 'ok' | 'error'
  error?: string
  attrs?: Record<string, unknown>
}

export interface TraceSettings {
  enabled: boolean
  /** HTTP collector base url, e.g. http://127.0.0.1:4120 */
  url: string
  /** Kafka broker list; when set it wins over url. Empty = HTTP path. */
  brokers: string[]
  topic: string
  queueSize: number
  batchSize: number
  flushMs: number
}

export interface TraceSink {
  send(spans: TraceSpan[]): Promise<void>
  close?(): Promise<void>
}

export function loadTraceSettings(env: NodeJS.ProcessEnv = process.env): TraceSettings {
  return {
    enabled: env.AGENT_TRACE !== '0',
    url: (env.AGENT_TRACE_URL?.trim() || 'http://127.0.0.1:4120').replace(/\/+$/, ''),
    brokers: (env.AGENT_TRACE_BROKERS?.trim() ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    topic: env.AGENT_TRACE_TOPIC?.trim() || 'agent.trace.spans',
    queueSize: positiveInt(env.AGENT_TRACE_QUEUE_SIZE, 2048),
    batchSize: positiveInt(env.AGENT_TRACE_BATCH_SIZE, 50),
    flushMs: positiveInt(env.AGENT_TRACE_FLUSH_MS, 2000),
  }
}

export function createTraceSink(settings: TraceSettings): TraceSink {
  if (settings.brokers.length > 0) return new KafkaSink(settings.brokers, settings.topic)
  return new HttpSink(settings.url)
}

/** Bounded queue + size/time batching + drop-oldest backpressure. */
export class TraceBus {
  private queue: TraceSpan[] = []
  private seq = 0
  private dropped = 0
  private failed = 0
  private flushing = false
  private readonly timer: NodeJS.Timeout

  constructor(
    private readonly sink: TraceSink,
    private readonly options: { queueSize: number; batchSize: number; flushMs: number },
  ) {
    this.timer = setInterval(() => {
      void this.flush()
    }, options.flushMs)
    this.timer.unref()
  }

  /** Stats surfaced to /health-style endpoints and gap detection. */
  get stats(): { queued: number; dropped: number; failed: number } {
    return { queued: this.queue.length, dropped: this.dropped, failed: this.failed }
  }

  nextSeq(): number {
    this.seq += 1
    return this.seq
  }

  emit(span: Omit<TraceSpan, 'schema' | 'seq'>): void {
    const full: TraceSpan = { schema: 'agent-trace/1', seq: this.nextSeq(), ...span }
    if (this.queue.length >= this.options.queueSize) {
      this.queue.shift()
      this.dropped += 1
    }
    this.queue.push(full)
    if (this.queue.length >= this.options.batchSize) void this.flush()
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    this.flushing = true
    const batch = this.queue.splice(0, this.options.batchSize)
    try {
      await this.sink.send(batch)
    } catch {
      // At-most-once: a failed batch is dropped, never retried into the loop's way.
      this.failed += batch.length
    } finally {
      this.flushing = false
      if (this.queue.length >= this.options.batchSize) void this.flush()
    }
  }

  async drain(): Promise<void> {
    while (this.queue.length > 0) await this.flush()
  }

  async close(): Promise<void> {
    clearInterval(this.timer)
    await this.drain()
    await this.sink.close?.()
  }
}

/** A span handle: started now, closed once. Parent linkage is carried in fields. */
export class Span {
  readonly traceId: string
  readonly spanId = randomUUID()
  readonly startedAt = Date.now()
  private ended = false

  constructor(
    private readonly bus: TraceBus | undefined,
    private readonly fields: {
      traceId: string
      parentSpanId?: string
      kind: SpanKind
      name: string
      turn?: number
      model?: string
      attrs?: Record<string, unknown>
    },
  ) {
    this.traceId = fields.traceId
  }

  end(extra?: { status?: 'ok' | 'error'; error?: string; attrs?: Record<string, unknown> }): void {
    if (this.ended || !this.bus) return
    this.ended = true
    const endedAt = Date.now()
    this.bus.emit({
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.fields.parentSpanId ? { parentSpanId: this.fields.parentSpanId } : {}),
      kind: this.fields.kind,
      name: this.fields.name,
      ...(this.fields.turn !== undefined ? { turn: this.fields.turn } : {}),
      ...(this.fields.model ? { model: this.fields.model } : {}),
      startedAt: this.startedAt,
      endedAt,
      durationMs: endedAt - this.startedAt,
      status: extra?.status ?? 'ok',
      ...(extra?.error ? { error: extra.error } : {}),
      ...(this.fields.attrs || extra?.attrs
        ? { attrs: { ...this.fields.attrs, ...extra?.attrs } }
        : {}),
    })
  }

  child(fields: Omit<ConstructorParameters<typeof Span>[1], 'traceId' | 'parentSpanId'>): Span {
    return new Span(this.bus, { ...fields, traceId: this.traceId, parentSpanId: this.spanId })
  }
}

export function createTraceBusFromEnv(env: NodeJS.ProcessEnv = process.env): TraceBus | undefined {
  const settings = loadTraceSettings(env)
  if (!settings.enabled) return undefined
  return new TraceBus(createTraceSink(settings), settings)
}

class HttpSink implements TraceSink {
  constructor(private readonly baseUrl: string) {}

  async send(spans: TraceSpan[]): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/spans`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spans }),
    })
    if (!response.ok) throw new Error(`trace collector ${response.status}`)
  }
}

/** Direct Kafka produce; kafkajs is loaded lazily so it stays an optional path. */
class KafkaSink implements TraceSink {
  private producer?: { connect(): Promise<void>; send(record: { topic: string; messages: { value: string }[] }): Promise<unknown>; disconnect(): Promise<void> }
  private ready?: Promise<void>

  constructor(
    private readonly brokers: string[],
    private readonly topic: string,
  ) {}

  private async connect(): Promise<void> {
    this.ready ??= (async () => {
      const { Kafka } = (await import('kafkajs')) as {
        Kafka: new (config: { clientId: string; brokers: string[] }) => {
          producer(): NonNullable<KafkaSink['producer']> & { connect(): Promise<void> }
        }
      }
      this.producer = new Kafka({ clientId: 'ccc-agent', brokers: this.brokers }).producer()
      await this.producer!.connect()
    })()
    await this.ready
  }

  async send(spans: TraceSpan[]): Promise<void> {
    await this.connect()
    await this.producer!.send({
      topic: this.topic,
      messages: spans.map((span) => ({ value: JSON.stringify(span) })),
    })
  }

  async close(): Promise<void> {
    await this.producer?.disconnect()
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}
