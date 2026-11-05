import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createCollapseStore, type CollapseSettings, type CollapseStore } from '../agent/collapse.js'
import type { Config } from '../config.js'
import { createBuiltinTools } from '../tools/builtin.js'
import type { AssistantMessage, LlmClient, LlmRequest, Message } from '../types.js'
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

test('web collapse folds a closed turn and the next request uses the placeholder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-web-collapse-'))
  try {
    const requests: LlmRequest[] = []
    const llm: LlmClient = {
      async complete(request) {
        requests.push(structuredClone(request))
        const last = request.messages.at(-1)
        if (last && /CRITICAL: Respond with TEXT ONLY/.test(textOf(last))) {
          return assistant([{ type: 'text', text: '<summary>OLD TURNS</summary>' }])
        }
        return assistant([{ type: 'text', text: `answer ${requests.length}` }])
      },
    }
    const session = makeSession(dir, llm, 4, undefined, {
      enabled: true,
      settings: {
        contextWindow: 128_000,
        summaryReserve: 20_000,
        startRatio: 0.9,
        hardRatio: 0.95,
        targetRatio: 0.8,
        keepTurns: 1,
      },
      store: createCollapseStore(),
    })

    await session.send('first task')
    await session.send('second task')
    await session.collapseNow()

    const state = session.getState()
    assert.equal(state.busy, false)
    assert.equal(state.collapsing, false)
    assert.equal(state.collapse.enabled, true)
    assert.equal(state.collapse.commits, 1)
    assert.ok(
      state.timeline.some((item) => item.kind === 'notice' && /上下文已折叠：1 段/.test(item.text)),
    )

    await session.send('third task')
    const main = requests
      .filter((request) => {
        const last = request.messages.at(-1)
        return !(last && /CRITICAL: Respond with TEXT ONLY/.test(textOf(last)))
      })
      .at(-1)!
    assert.match(textOf(main.messages[0] as Message), /^<collapsed id="c1">/)
    assert.equal(main.messages.some((message) => textOf(message) === 'first task'), false)
    assert.equal(textOf(main.messages.at(-1) as Message), 'third task')
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

test('manual compaction replaces history and reports tokens as notices', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-web-compact-'))
  try {
    const requests: LlmRequest[] = []
    let calls = 0
    const llm: LlmClient = {
      async complete(request) {
        requests.push({ ...request, messages: structuredClone(request.messages) })
        calls += 1
        if (calls === 1) return assistant([{ type: 'text', text: 'hello' }])
        if (calls === 2) return assistant([{ type: 'text', text: '<analysis>draft</analysis><summary>WEB_SUMMARY</summary>' }])
        return assistant([{ type: 'text', text: 'next' }])
      },
    }
    const session = makeSession(dir, llm)
    const events: SessionEvent[] = []
    session.subscribe((event) => events.push(event))

    await session.send('hi')
    await session.compact()

    const state = session.getState()
    assert.equal(state.busy, false)
    assert.equal(state.compacting, false)
    const notices = state.timeline.flatMap((item) => (item.kind === 'notice' ? [item.text] : []))
    assert.ok(notices.includes('正在压缩上下文'))
    assert.ok(notices.some((text) => text.includes('上下文已压缩') && text.includes('→')))
    assert.equal(events.some((event) => event.type === 'compacting' && event.compacting), true)
    assert.equal(events.at(-1)?.type, 'busy')

    await session.send('next')
    const last = requests.at(-1)
    assert.ok(last)
    assert.match(textOf(last.messages[0] as Message), /^\[compacted\].*手动压缩/)
    assert.match(textOf(last.messages[1] as Message), /WEB_SUMMARY/)
    assert.equal(textOf(last.messages[2] as Message), 'next')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('compact refuses while a turn is running', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-web-compact-busy-'))
  try {
    let release: ((message: AssistantMessage) => void) | undefined
    const session = makeSession(dir, {
      complete() {
        return new Promise<AssistantMessage>((resolve) => {
          release = resolve
        })
      },
    })
    const pending = session.send('hi')
    assert.throws(() => session.compact(), /正在处理上一条消息/)
    assert.ok(release)
    release({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
    await pending
    assert.equal(session.getState().compacting, false)
    assert.equal(session.getState().busy, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto compaction shows the status, leaves notices, and hides the summary', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-web-auto-compact-'))
  try {
    await writeFile(path.join(dir, 'big.txt'), 'r'.repeat(10_000))
    const requests: LlmRequest[] = []
    let calls = 0
    const llm: LlmClient = {
      async complete(request) {
        requests.push({ ...request, messages: structuredClone(request.messages) })
        calls += 1
        if (calls === 1) return assistant([{ type: 'text', text: 'a'.repeat(20_000) }])
        if (calls === 2) {
          return assistant([{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'big.txt' } }])
        }
        if (calls === 3) return assistant([{ type: 'text', text: '<analysis>draft</analysis><summary>AUTO_WEB</summary>' }])
        return assistant([{ type: 'text', text: 'done' }])
      },
    }
    const session = makeSession(dir, llm, 4, {
      contextWindow: 40_000,
      summaryReserve: 20_000,
      autoBuffer: 13_000,
    })
    const events: SessionEvent[] = []
    session.subscribe((event) => events.push(event))

    await session.send('hi')
    await session.send('again')

    const state = session.getState()
    assert.equal(calls, 4)
    assert.equal(state.busy, false)
    assert.equal(state.compacting, false)
    assert.equal(events.some((event) => event.type === 'compacting' && event.compacting), true)
    const notices = state.timeline.flatMap((item) => (item.kind === 'notice' ? [item.text] : []))
    assert.ok(notices.includes('正在压缩上下文'))
    assert.ok(notices.some((text) => text.includes('上下文已压缩')))
    assert.equal(
      state.timeline.some((item) => item.kind === 'assistant' && item.text.includes('AUTO_WEB')),
      false,
    )

    const final = requests.at(-1)
    assert.ok(final)
    assert.match(textOf(final.messages[0] as Message), /^\[compacted\].*自动压缩/)
    assert.match(textOf(final.messages[1] as Message), /AUTO_WEB/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function makeSession(cwd: string, llm: LlmClient, maxTurns = 4, compaction?: {
  contextWindow: number
  summaryReserve: number
  autoBuffer: number
}, collapse?: {
  enabled?: boolean
  settings?: CollapseSettings
  store?: CollapseStore
}): WebSession {
  return new WebSession({
    config: testConfig(cwd, maxTurns),
    tools: createBuiltinTools(),
    llm,
    system: 'test',
    version: '0.1.0',
    compaction: compaction ? { settings: compaction, tracking: { consecutiveFailures: 0 } } : undefined,
    collapse,
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

function textOf(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}
