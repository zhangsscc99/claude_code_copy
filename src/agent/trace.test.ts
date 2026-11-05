import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTraceSettings, Span, TraceBus, type TraceSpan } from './trace.js'

function fakeSink(collected: TraceSpan[], fail = false) {
  return {
    async send(spans: TraceSpan[]) {
      if (fail) throw new Error('collector down')
      collected.push(...spans)
    },
  }
}

function span(bus: TraceBus, name: string) {
  return new Span(bus, { traceId: 't1', kind: 'tool_call', name })
}

test('span end emits a completed span with duration and seq', async () => {
  const collected: TraceSpan[] = []
  const bus = new TraceBus(fakeSink(collected), { queueSize: 10, batchSize: 10, flushMs: 60_000 })
  const s = span(bus, 'bash')
  s.end({ attrs: { ok: 1 } })
  await bus.drain()
  assert.equal(collected.length, 1)
  assert.equal(collected[0].schema, 'agent-trace/1')
  assert.equal(collected[0].seq, 1)
  assert.equal(collected[0].status, 'ok')
  assert.equal(collected[0].attrs?.ok, 1)
  assert.ok(collected[0].durationMs >= 0)
  await bus.close()
})

test('child spans link parentSpanId inside one trace', async () => {
  const collected: TraceSpan[] = []
  const bus = new TraceBus(fakeSink(collected), { queueSize: 10, batchSize: 10, flushMs: 60_000 })
  const run = new Span(bus, { traceId: 'abc', kind: 'run', name: 'agent_run' })
  const tool = run.child({ kind: 'tool_call', name: 'read', turn: 1 })
  tool.end()
  run.end()
  await bus.drain()
  const [toolSpan, runSpan] = collected
  assert.equal(toolSpan.traceId, 'abc')
  assert.equal(toolSpan.parentSpanId, runSpan.spanId)
  assert.equal(runSpan.parentSpanId, undefined)
  await bus.close()
})

test('queue is bounded: oldest spans drop and are counted', async () => {
  const collected: TraceSpan[] = []
  const bus = new TraceBus(fakeSink(collected), { queueSize: 3, batchSize: 100, flushMs: 60_000 })
  for (let i = 0; i < 5; i++) span(bus, `t${i}`).end()
  assert.equal(bus.stats.queued, 3)
  assert.equal(bus.stats.dropped, 2)
  await bus.drain()
  assert.deepEqual(collected.map((s) => s.name), ['t2', 't3', 't4'])
  await bus.close()
})

test('sink failure is at-most-once: batch drops, loop stays alive', async () => {
  const bus = new TraceBus(fakeSink([], true), { queueSize: 10, batchSize: 10, flushMs: 60_000 })
  span(bus, 'a').end()
  await bus.drain()
  assert.equal(bus.stats.failed, 1)
  span(bus, 'b').end()
  await bus.close()
})

test('double end emits only once; disabled bus tolerates spans', async () => {
  const collected: TraceSpan[] = []
  const bus = new TraceBus(fakeSink(collected), { queueSize: 10, batchSize: 10, flushMs: 60_000 })
  const s = span(bus, 'x')
  s.end()
  s.end()
  const orphan = new Span(undefined, { traceId: 't', kind: 'run', name: 'n' })
  orphan.child({ kind: 'turn', name: 't1' }).end()
  orphan.end()
  await bus.drain()
  assert.equal(collected.length, 1)
  await bus.close()
})

test('settings: defaults on, env switches respected', () => {
  const off = loadTraceSettings({ AGENT_TRACE: '0' } as NodeJS.ProcessEnv)
  assert.equal(off.enabled, false)
  const kafka = loadTraceSettings({ AGENT_TRACE_BROKERS: 'a:9092, b:9092' } as NodeJS.ProcessEnv)
  assert.deepEqual(kafka.brokers, ['a:9092', 'b:9092'])
  assert.equal(kafka.topic, 'agent.trace.spans')
})
