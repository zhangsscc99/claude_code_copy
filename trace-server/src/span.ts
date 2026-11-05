/** Wire format shared with the agent emitter (src/agent/trace.ts). */

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
  name: string
  turn?: number
  model?: string
  startedAt: number
  endedAt: number
  durationMs: number
  status: 'ok' | 'error'
  error?: string
  attrs?: Record<string, unknown>
}

const KINDS = new Set<SpanKind>(['run', 'turn', 'llm_call', 'tool_call', 'permission', 'compact', 'collapse'])

export function isTraceSpan(value: unknown): value is TraceSpan {
  if (!value || typeof value !== 'object') return false
  const span = value as Record<string, unknown>
  return (
    typeof span.seq === 'number' &&
    typeof span.traceId === 'string' &&
    typeof span.spanId === 'string' &&
    typeof span.kind === 'string' &&
    KINDS.has(span.kind as SpanKind) &&
    typeof span.name === 'string' &&
    typeof span.startedAt === 'number' &&
    typeof span.endedAt === 'number' &&
    (span.status === 'ok' || span.status === 'error')
  )
}
