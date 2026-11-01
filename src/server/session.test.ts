import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Config } from '../config.js'
import { createBuiltinTools } from '../tools/builtin.js'
import type { AssistantMessage, LlmClient } from '../types.js'
import { WebSession, type SessionEvent } from './session.js'

test('default mode asks, then records the allowed bash turn', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-web-'))
  try {
    const session = makeSession(dir, scripted([
      assistant([{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'printf ok' } }]),
      assistant([{ type: 'text', text: '命令输出是 ok' }]),
    ]))
    const events: SessionEvent[] = []
    session.subscribe(() => {
      throw new Error('listener failed')
    })
    session.subscribe((event) => {
      events.push(event)
      if (event.type === 'permission') {
        assert.equal(session.answerPermission(event.id, 'once'), true)
      }
    })

    await session.send('跑一下')

    const state = session.getState()
    assert.equal(state.busy, false)
    assert.equal(session.isBusy(), false)
    assert.equal(state.permissionMode, 'default')
    assert.equal(state.cwd, dir)
    assert.equal(state.model, 'test-model')
    assert.equal(state.provider, 'anthropic')
    assert.equal(state.version, '0.1.0')
    assert.equal(JSON.stringify(state).includes('sk-test-secret'), false)
    assert.equal(JSON.stringify(events).includes('sk-test-secret'), false)

    const user = state.timeline.find((item) => item.kind === 'user')
    assert.ok(user && user.kind === 'user')
    assert.equal(user.text, '跑一下')

    const tool = state.timeline.find((item) => item.kind === 'tool')
    assert.ok(tool && tool.kind === 'tool')
    assert.equal(tool.name, 'bash')
    assert.equal(tool.preview, 'printf ok')
    assert.equal(tool.pending, false)
    assert.equal(tool.isError, false)
    assert.match(tool.output, /ok/)

    const reply = state.timeline.find((item) => item.kind === 'assistant')
    assert.ok(reply && reply.kind === 'assistant')
    assert.equal(reply.text, '命令输出是 ok')

    const permission = state.timeline.find((item) => item.kind === 'permission')
    assert.ok(permission && permission.kind === 'permission')
    assert.equal(permission.status, 'once')
    assert.equal(events.at(-1)?.type, 'busy')
    assert.equal(events.at(-1)?.type === 'busy' && events.at(-1)?.busy, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('answerPermission returns false for an unknown id', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-web-miss-'))
  try {
    const session = makeSession(dir, scripted([]))
    assert.throws(() => session.send(''), /消息是空的/)
    assert.throws(() => session.send('   '), /消息是空的/)
    assert.equal(session.isBusy(), false)
    assert.equal(session.answerPermission('missing', 'once'), false)
    assert.equal(session.answerPermission('missing', 'deny'), false)
    assert.equal(session.answerPermission('missing', 'deny'), false)
    assert.deepEqual(session.getState().timeline, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('clear removes timeline and history when not busy', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-web-clear-'))
  try {
    const seen: number[] = []
    const blockers: Array<(message: AssistantMessage) => void> = []
    let blockNext = true
    const llm: LlmClient = {
      complete(request) {
        seen.push(request.messages.length)
        if (blockNext) {
          blockNext = false
          return new Promise((resolve) => {
            blockers.push(resolve)
          })
        }
        return Promise.resolve(assistant([{ type: 'text', text: 'ok' }]))
      },
    }
    const session = makeSession(dir, llm)
    let cleared = 0
    session.subscribe((event) => {
      if (event.type === 'cleared') cleared += 1
    })

    const pending = session.send('first')
    assert.equal(session.isBusy(), true)
    assert.throws(() => session.clear(), /正在处理上一条消息/)
    assert.equal(cleared, 0)
    assert.equal(blockers.length, 1)
    blockers[0]!({ role: 'assistant', content: [{ type: 'text', text: 'done' }] })
    await pending
    assert.equal(session.isBusy(), false)
    assert.ok(session.getState().timeline.length > 0)

    session.clear()
    assert.equal(cleared, 1)
    assert.deepEqual(session.getState().timeline, [])
    assert.equal(session.isBusy(), false)

    await session.send('second')
    assert.deepEqual(seen, [1, 1])
    const users = session.getState().timeline.filter((item) => item.kind === 'user')
    assert.equal(users.length, 1)
    assert.equal(users[0]?.kind === 'user' && users[0].text, 'second')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('notices, mode, and previews follow the session rules', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-web-notice-'))
  try {
    const pattern = 'p'.repeat(180)
    const failing = makeSession(dir, {
      async complete() {
        throw new Error('模型暂时不可用')
      },
    })
    await failing.send('hello')
    assert.equal(failing.isBusy(), false)
    const failure = failing.getState().timeline.find((item) => item.kind === 'notice')
    assert.ok(failure && failure.kind === 'notice')
    assert.equal(failure.text, '模型暂时不可用')

    const limited = makeSession(
      dir,
      scripted([
        assistant([{ type: 'tool_use', id: 'g1', name: 'grep', input: { pattern } }]),
        assistant([{ type: 'tool_use', id: 'b1', name: 'bash', input: { command: 12 } }]),
      ]),
      2,
    )
    limited.setMode('plan')
    assert.equal(limited.getState().permissionMode, 'plan')
    await limited.send('search')
    const state = limited.getState()
    const grep = state.timeline.find((item) => item.kind === 'tool' && item.name === 'grep')
    assert.ok(grep && grep.kind === 'tool')
    assert.equal(grep.preview.length, 160)
    assert.equal(grep.preview, pattern.slice(0, 160))
    const bash = state.timeline.find((item) => item.kind === 'tool' && item.name === 'bash')
    assert.ok(bash && bash.kind === 'tool')
    assert.equal(bash.preview, JSON.stringify({ command: 12 }))
    assert.equal(bash.pending, false)
    assert.equal(bash.isError, true)
    const notice = state.timeline.find((item) => item.kind === 'notice')
    assert.ok(notice && notice.kind === 'notice')
    assert.equal(notice.text, '达到最大轮数 2')
    assert.equal(state.timeline.some((item) => item.kind === 'permission'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function makeSession(cwd: string, llm: LlmClient, maxTurns = 4): WebSession {
  return new WebSession({
    config: testConfig(cwd, maxTurns),
    tools: createBuiltinTools(),
    llm,
    system: 'test',
    version: '0.1.0',
  })
}

function testConfig(cwd: string, maxTurns = 4): Config {
  return {
    provider: 'anthropic',
    apiKey: 'sk-test-secret',
    baseUrl: 'https://example.invalid',
    model: 'test-model',
    maxTurns,
    maxTokens: 128,
    permissionMode: 'default',
    cwd,
  }
}

function scripted(responses: AssistantMessage[]): LlmClient {
  let index = 0
  return {
    async complete() {
      const next = responses[index]
      index += 1
      if (!next) throw new Error('mock model ran out of responses')
      return next
    },
  }
}

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return { role: 'assistant', content }
}
