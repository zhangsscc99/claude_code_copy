import { Kafka, type Consumer, type Producer } from 'kafkajs'
import type { TraceSpan } from './span.js'

/**
 * Kafka sits between ingest and indexing the same way it does in production
 * telemetry: the HTTP edge stays dumb and fast, the broker absorbs bursts and
 * retains spans for replay, and the consumer group does the stateful work.
 * TRACE_KAFKA=off bypasses it for local dev — ingest applies spans directly.
 */

export interface Pipeline {
  /** Publish an already-validated span. Resolves once the broker has it. */
  publish(span: TraceSpan): Promise<void>
  mode: 'kafka' | 'direct'
  close(): Promise<void>
}

export function createPipeline(options: {
  brokers: string[]
  topic: string
  groupId: string
  apply: (span: TraceSpan) => Promise<void> | void
}): Pipeline {
  if (options.brokers.length === 0) {
    return {
      mode: 'direct',
      publish: (span) => Promise.resolve(options.apply(span)),
      close: () => Promise.resolve(),
    }
  }

  const kafka = new Kafka({ clientId: 'ccc-trace-server', brokers: options.brokers })
  const producer: Producer = kafka.producer()
  const consumer: Consumer = kafka.consumer({ groupId: options.groupId })

  const ready = (async () => {
    await producer.connect()
    await consumer.connect()
    await consumer.subscribe({ topic: options.topic, fromBeginning: true })
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return
        let span: TraceSpan
        try {
          span = JSON.parse(message.value.toString('utf8')) as TraceSpan
        } catch {
          return
        }
        await options.apply(span)
      },
    })
  })()

  return {
    mode: 'kafka',
    async publish(span) {
      await ready
      await producer.send({ topic: options.topic, messages: [{ value: JSON.stringify(span) }] })
    },
    async close() {
      await consumer.disconnect().catch(() => {})
      await producer.disconnect().catch(() => {})
    },
  }
}
