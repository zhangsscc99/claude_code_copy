import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { isPermissionMode, normalizeAnswer, type PermissionAnswer } from '../permissions.js'
import type { WebSession } from './session.js'

const MAX_JSON_BYTES = 1_000_000
const indexHtmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url))
const tokensCssPath = fileURLToPath(new URL('../web/dsh-tokens.css', import.meta.url))
const shellCssPath = fileURLToPath(new URL('../web/dsh-shell.css', import.meta.url))
const appJsPath = fileURLToPath(new URL('../web/app.js', import.meta.url))

export function startWebServer(options: {
  session: WebSession
  port: number
  openBrowser: boolean
}): Promise<void> {
  const { session, port, openBrowser } = options
  const server = createServer((req, res) => {
    handle(req, res, session, port).catch((error: unknown) => {
      if (res.headersSent || res.writableEnded) {
        res.destroy()
        return
      }
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, status, { error: status === 500 ? '服务器错误' : message })
    })
  })

  // The promise stays pending after a successful listen. Node keeps the process
  // alive because this server handle stays referenced.
  return new Promise<void>((_resolve, reject) => {
    let settled = false
    server.on('error', (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    try {
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
          if (!settled) {
            settled = true
            server.close()
            reject(new Error('web server listened on an unexpected address'))
          }
          return
        }
        process.stdout.write(`ccc web  http://127.0.0.1:${port}\n`)
        if (openBrowser) openPage(`http://127.0.0.1:${port}`)
      })
    } catch (error) {
      if (!settled) {
        settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, session: WebSession, port: number): Promise<void> {
  req.on('error', () => {})
  if (!isLocalHost(req.headers.host, port)) {
    req.resume()
    sendJson(res, 403, { error: '只允许本机访问' })
    return
  }

  const pathname = pathnameOf(req, port)
  const method = req.method ?? 'GET'

  if (method === 'GET' && pathname === '/') {
    await serveFile(res, indexHtmlPath, 'text/html; charset=utf-8')
    return
  }
  if (method === 'GET' && pathname === '/dsh-tokens.css') {
    await serveFile(res, tokensCssPath, 'text/css; charset=utf-8')
    return
  }
  if (method === 'GET' && pathname === '/dsh-shell.css') {
    await serveFile(res, shellCssPath, 'text/css; charset=utf-8')
    return
  }
  if (method === 'GET' && pathname === '/app.js') {
    await serveFile(res, appJsPath, 'text/javascript; charset=utf-8')
    return
  }
  if (method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, session.getState())
    return
  }
  if (method === 'GET' && pathname === '/api/events') {
    serveEvents(req, res, session)
    return
  }
  if (method === 'POST' && pathname === '/api/messages') {
    await postMessage(req, res, session)
    return
  }
  if (method === 'POST' && pathname === '/api/permissions') {
    await postPermission(req, res, session)
    return
  }
  if (method === 'POST' && pathname === '/api/mode') {
    await postMode(req, res, session)
    return
  }
  if (method === 'POST' && pathname === '/api/clear') {
    await postClear(req, res, session)
    return
  }

  if (knownPath(pathname)) {
    sendJson(res, 405, { error: '方法不允许' })
    return
  }
  sendJson(res, 404, { error: '没有这个接口' })
}

function serveEvents(req: IncomingMessage, res: ServerResponse, session: WebSession): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const queued: string[] = []
  let open = false
  let closed = false

  function cleanup(): void {
    if (closed) return
    closed = true
    clearInterval(ping)
    unsubscribe()
  }

  const unsubscribe = session.subscribe((event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`
    if (!open) {
      queued.push(line)
      return
    }
    writeRaw(res, line, cleanup)
  })
  const ping = setInterval(() => {
    writeRaw(res, ': ping\n\n', cleanup)
  }, 15_000)
  ping.unref()

  res.on('close', cleanup)
  req.on('error', () => {})
  req.resume()
  res.write('data: {"type":"ready"}\n\n')
  open = true
  while (queued.length > 0) {
    const line = queued.shift()
    if (line) writeRaw(res, line, cleanup)
  }
}

async function postMessage(req: IncomingMessage, res: ServerResponse, session: WebSession): Promise<void> {
  const body = await readJson(req)
  if (!isRecord(body) || typeof body.text !== 'string') {
    sendJson(res, 400, { error: '消息是空的' })
    return
  }
  let pending: Promise<void>
  try {
    pending = session.send(body.text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, message === '正在处理上一条消息' ? 409 : 400, { error: message })
    return
  }
  pending.catch(() => {
    // Agent failures are already stored as notices. Ignore the rejection so the process stays up.
  })
  sendJson(res, 202, { ok: true })
}

async function postPermission(req: IncomingMessage, res: ServerResponse, session: WebSession): Promise<void> {
  const body = await readJson(req)
  if (!isRecord(body) || !normalizePermissionAnswer(body.answer)) {
    sendJson(res, 400, { error: 'answer 只能是 once、session、local、deny' })
    return
  }
  const answer = normalizePermissionAnswer(body.answer)
  if (!answer) return
  if (typeof body.id !== 'string' || body.id === '') {
    sendJson(res, 400, { error: '缺少 id' })
    return
  }
  if (!session.answerPermission(body.id, answer)) {
    sendJson(res, 404, { error: '这条权限请求已经结束' })
    return
  }
  sendJson(res, 200, { ok: true })
}

async function postMode(req: IncomingMessage, res: ServerResponse, session: WebSession): Promise<void> {
  const body = await readJson(req)
  if (!isRecord(body) || typeof body.mode !== 'string' || !isPermissionMode(body.mode)) {
    sendJson(res, 400, { error: '权限模式无效' })
    return
  }
  session.setMode(body.mode)
  sendJson(res, 200, { ok: true })
}

async function postClear(req: IncomingMessage, res: ServerResponse, session: WebSession): Promise<void> {
  await readBody(req)
  try {
    session.clear()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, 409, { error: message })
    return
  }
  sendJson(res, 200, { ok: true })
}

async function serveFile(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
  let body: Buffer
  try {
    body = await readFile(filePath)
  } catch {
    sendText(res, 404, 'Not found')
    return
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
  })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = (await readBody(req)).toString('utf8').trim()
  if (!text) throw new HttpError(400, '需要 JSON')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new HttpError(400, 'JSON 无法解析')
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = contentLength(req)
  if (declared !== undefined && declared > MAX_JSON_BYTES) {
    discard(req)
    throw new HttpError(413, '请求体太大')
  }
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of req) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      total += buffer.length
      if (total > MAX_JSON_BYTES) throw new HttpError(413, '请求体太大')
      chunks.push(buffer)
    }
  } catch (error) {
    discard(req)
    throw error
  }
  return Buffer.concat(chunks)
}

function discard(req: IncomingMessage): void {
  req.on('error', () => {})
  if (!req.readableEnded) req.resume()
}

function contentLength(req: IncomingMessage): number | undefined {
  const header = req.headers['content-length']
  if (header === undefined) return undefined
  const raw = Array.isArray(header) ? header[0] : header
  if (!/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

function pathnameOf(req: IncomingMessage, port: number): string {
  try {
    return new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname
  } catch {
    return ''
  }
}

function isLocalHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false
  const host = hostHeader.trim().toLowerCase()
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

function knownPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/dsh-tokens.css' ||
    pathname === '/dsh-shell.css' ||
    pathname === '/app.js' ||
    pathname === '/api/state' ||
    pathname === '/api/events' ||
    pathname === '/api/messages' ||
    pathname === '/api/permissions' ||
    pathname === '/api/mode' ||
    pathname === '/api/clear'
  )
}

function normalizePermissionAnswer(value: unknown): PermissionAnswer | undefined {
  if (typeof value !== 'string') return undefined
  if (!['once', 'session', 'local', 'deny', 'allow', 'always', '1', '2', '3', '4', 'y', 'n'].includes(value)) return undefined
  return normalizeAnswer(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  })
  res.end(payload)
}

function sendText(res: ServerResponse, status: number, body: string): void {
  const payload = Buffer.from(body, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
  })
  res.end(payload)
}

function writeRaw(res: ServerResponse, chunk: string, onFailure: () => void): void {
  if (res.destroyed || res.writableEnded) {
    onFailure()
    return
  }
  try {
    res.write(chunk)
  } catch {
    onFailure()
  }
}

function openPage(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined
  if (!command) return
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // A missing opener must not stop the server.
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
