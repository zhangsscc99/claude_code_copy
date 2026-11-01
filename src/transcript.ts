import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Message } from './types.js'

export async function appendTranscript(cwd: string, messages: Message[]): Promise<void> {
  if (messages.length === 0) return
  const dir = path.join(cwd, '.copy-agent')
  await mkdir(dir, { recursive: true })
  const lines = messages
    .map((message) => JSON.stringify({ ts: new Date().toISOString(), message }))
    .join('\n')
  await appendFile(path.join(dir, 'session.jsonl'), `${lines}\n`)
}
