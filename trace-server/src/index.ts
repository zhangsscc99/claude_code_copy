import path from 'node:path'
import { Aggregator } from './aggregate.js'
import { createPipeline } from './kafka.js'
import { createEventBus, makeApply, startServer } from './server.js'
import { TraceStore } from './store.js'

const port = Number(process.env.TRACE_PORT ?? '4120')
const dataDir = process.env.TRACE_DATA_DIR ?? path.join(process.cwd(), 'data')
const topic = process.env.TRACE_TOPIC ?? 'agent.trace.spans'
const groupId = process.env.TRACE_GROUP_ID ?? 'ccc-trace-server'
const kafkaOff = process.env.TRACE_KAFKA === 'off'
const brokers = kafkaOff
  ? []
  : (process.env.TRACE_KAFKA_BROKERS ?? '127.0.0.1:9092')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)

const store = new TraceStore(dataDir)
await store.init()
const aggregator = new Aggregator()
// Rebuild the streaming rollup from the replayed WAL so stats survive restarts.
for (const summary of store.list(5000)) {
  for (const span of store.get(summary.traceId)?.spans ?? []) aggregator.apply(span)
}
const bus = createEventBus()
const apply = makeApply({ store, aggregator }, bus)
const pipeline = createPipeline({ brokers, topic, groupId, apply })

await startServer({ store, aggregator, pipeline, port: Number.isInteger(port) ? port : 4120 }, bus)

process.on('SIGINT', () => {
  void (async () => {
    await pipeline.close()
    await store.close()
    process.exit(0)
  })()
})
