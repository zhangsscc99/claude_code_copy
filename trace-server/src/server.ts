import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Aggregator } from './aggregate.js'
import type { Pipeline } from './kafka.js'
import { isTraceSpan } from './span.js'
import type { TraceStore } from './store.js'

const MAX_JSON_BYTES = 4_000_000
const MAX_SPANS_PER_BATCH = 1000

const indexHtmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url))
const appJsPath = fileURLToPath(new URL('../web/app.js', import.meta.url))
const styleCssPath = fileURLToPath(new URL('../web/style.css', import.meta.url))

export interface ServerDeps {
  store: TraceStore
  aggregator: Aggregator
  pipeline: Pipeline
  port: number
}

export type TraceEvent = { type: string; data: unknown }
type Listener = (event: TraceEvent) => void

export interface EventBus {
  subscribe(fn: Listener): () => void
  broadcast(event: TraceEvent): void
}

export function createEventBus(): EventBus {
  const listeners = new Set<Listener>()
  return {
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    broadcast(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch {
          // A dead SSE client must not break the pipeline.
        }
      }
    },
  }
}

export function startServer(deps: ServerDeps, bus: EventBus): Promise<void> {
  const server = createServer((req, res) => {
    handle(req, res, deps, bus).catch((error: unknown) => {
      if (res.headersSent || res.writableEnded) {
        res.destroy()
        return
      }
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  return new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    server.listen(deps.port, '0.0.0.0', () => {
      process.stdout.write(`trace-server  http://127.0.0.1:${deps.port}  (${deps.pipeline.mode})\n`)
      resolve()
    })
  })
}

/** Called by the consumer (Kafka) or ingest (direct mode) for each span. */
export function makeApply(
  deps: Pick<ServerDeps, 'store' | 'aggregator'>,
  bus: EventBus,
): (span: Parameters<TraceStore['ingest']>[0]) => Promise<void> {
  return async (span) => {
    await deps.store.ingest(span)
    deps.aggregator.apply(span)
    bus.broadcast({ type: 'span', data: span })
    if (span.kind === 'run') {
      bus.broadcast({ type: 'trace', data: deps.store.get(span.traceId)?.summary })
    }
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  bus: EventBus,
): Promise<void> {
  req.on('error', () => {})
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const pathname = url.pathname
  const method = req.method ?? 'GET'

  if (method === 'GET' && pathname === '/') return serveFile(res, indexHtmlPath, 'text/html; charset=utf-8')
  if (method === 'GET' && pathname === '/app.js') return serveFile(res, appJsPath, 'text/javascript; charset=utf-8')
  if (method === 'GET' && pathname === '/style.css') return serveFile(res, styleCssPath, 'text/css; charset=utf-8')

  if (method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true, mode: deps.pipeline.mode, ...deps.store.counts })
    return
  }

  if (method === 'GET' && pathname === '/api/stats') {
    sendJson(res, 200, deps.aggregator.snapshot())
    return
  }

  if (method === 'GET' && pathname === '/api/traces') {
    const limit = Number(url.searchParams.get('limit') ?? '50')
    const beforeRaw = url.searchParams.get('before')
    const before = beforeRaw ? Number(beforeRaw) : undefined
    sendJson(res, 200, {
      traces: deps.store.list(Number.isInteger(limit) ? limit : 50, before !== undefined && Number.isFinite(before) ? before : undefined),
    })
    return
  }

  const traceMatch = pathname.match(/^\/api\/traces\/([^/]+)$/)
  if (method === 'GET' && traceMatch) {
    const trace = deps.store.get(traceMatch[1]!)
    if (!trace) {
      sendJson(res, 404, { error: 'trace not found' })
      return
    }
    sendJson(res, 200, trace)
    return
  }

  if (method === 'GET' && pathname === '/api/events') {
    serveEvents(req, res, bus.subscribe)
    return
  }

  if (method === 'POST' && pathname === '/v1/spans') {
    const body = await readJson(req)
    const spans = (body as { spans?: unknown })?.spans
    if (!Array.isArray(spans) || spans.length === 0) {
      sendJson(res, 400, { error: 'spans must be a non-empty array' })
      return
    }
    if (spans.length > MAX_SPANS_PER_BATCH) {
      sendJson(res, 413, { error: `batch too large (max ${MAX_SPANS_PER_BATCH})` })
      return
    }
    const valid = spans.filter(isTraceSpan)
    if (valid.length === 0) {
      sendJson(res, 400, { error: 'no valid spans' })
      return
    }
    try {
      for (const span of valid) await deps.pipeline.publish(span)
    } catch (error) {
      sendJson(res, 503, { error: `pipeline unavailable: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    sendJson(res, 202, { accepted: valid.length, dropped: spans.length - valid.length })
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

function serveEvents(
  req: IncomingMessage,
  res: ServerResponse,
  subscribe: (fn: Listener) => () => void,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })
  const unsubscribe = subscribe((event) => {
    try {
      res.write(`data: ${JSON.stringify({ type: event.type, ...((event.data && typeof event.data === 'object') ? { data: event.data } : {}) })}\n\n`)
    } catch {
      cleanup()
    }
  })
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      cleanup()
    }
  }, 15_000)
  ping.unref()
  const cleanup = () => {
    clearInterval(ping)
    unsubscribe()
  }
  res.on('close', cleanup)
  req.resume()
  res.write('data: {"type":"ready"}\n\n')
}

async function serveFile(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
  try {
    const body = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length })
    res.end(body)
  } catch {
    sendJson(res, 404, { error: 'not found' })
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_JSON_BYTES) throw new Error('body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) throw new Error('expected JSON body')
  return JSON.parse(text)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Access-Control-Allow-Origin': '*',
  })
  res.end(payload)
}
