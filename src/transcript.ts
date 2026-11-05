import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { CollapseCommit } from './agent/collapse.js'
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

/**
 * Collapse commits are append-only, like the reference source's
 * `marble-origami-commit` transcript entries. Restoring them is out of scope
 * (there is no session resume yet), so the indices are relative to the history
 * array of the process that wrote them; the message ids make a later replay
 * possible.
 */
export async function appendCollapseCommit(cwd: string, commit: CollapseCommit): Promise<void> {
  const dir = path.join(cwd, '.copy-agent')
  await mkdir(dir, { recursive: true })
  await appendFile(path.join(dir, 'session.jsonl'), `${JSON.stringify({ ts: commit.createdAt, collapse: commit })}\n`)
}
