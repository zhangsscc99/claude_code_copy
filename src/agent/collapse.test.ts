import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PermissionGate } from '../permissions.js'
import type { AssistantMessage, LlmClient, LlmRequest, Message, TokenUsage } from '../types.js'
import {
  collapseHardTokens,
  collapseIfNeeded,
  collapseStartTokens,
  createCollapseStore,
  estimateProjectedTokens,
  getCollapseStats,
  planNextSpan,
  projectView,
  type CollapseCommit,
  type CollapseSettings,
} from './collapse.js'
import { mergeAdjacentRoles } from '../llm/client.js'
import { runAgent } from './loop.js'

// effective window 10000: collapse starts at 9000 and hard-stops at 9500.
const SETTINGS: CollapseSettings = {
  contextWindow: 12_000,
  summaryReserve: 2_000,
  startRatio: 0.9,
  hardRatio: 0.95,
  targetRatio: 0.8,
  keepTurns: 1,
}

test('the collapse ladder is derived from the effective window', () => {
  assert.equal(collapseStartTokens(SETTINGS), 9_000)
  assert.equal(collapseHardTokens(SETTINGS), 9_500)
})

test('projection replaces committed spans and keeps later messages raw', () => {
  const history: Message[] = [user('one'), assistantText('a1'), user('two'), assistantText('a2'), user('three')]
  const commits = [commit('c1', 0, 1, 'FIRST'), commit('c2', 2, 3, 'SECOND')]
  const view = projectView(history, commits)

  assert.equal(view.length, 3)
  assert.equal(textOf(view[0] as Message), '<collapsed id="c1">\nFIRST\n</collapsed>')
  assert.equal(textOf(view[1] as Message), '<collapsed id="c2">\nSECOND\n</collapsed>')
  assert.equal(textOf(view[2] as Message), 'three')
  // The caller's history is untouched.
  assert.equal(history.length, 5)
})

test('an out-of-range commit is skipped instead of corrupting the view', () => {
  const history: Message[] = [user('one'), assistantText('a1')]
  const view = projectView(history, [commit('c1', 0, 99, 'STALE')])
  assert.equal(view.length, 2)
  assert.equal(textOf(view[0] as Message), 'one')
})

test('projected views are merged into alternating API roles', () => {
  const history: Message[] = [user('one'), assistantText('a1'), user('two'), assistantText('a2'), user('three')]
  const view = projectView(history, [commit('c1', 0, 1, 'FIRST')])
  assert.deepEqual(view.map((message) => message.role), ['user', 'user', 'assistant', 'user'])

  const merged = mergeAdjacentRoles(view)
  assert.deepEqual(merged.map((message) => message.role), ['user', 'assistant', 'user'])
  assert.equal(merged[0]?.content.length, 2)
  assert.match(textOf(merged[0] as Message), /<collapsed id="c1">[\s\S]*two/)
})

test('the next span stops at turn boundaries and keeps the latest closed turn', () => {
  const history: Message[] = [user('one'), assistantText('a1'), user('two'), assistantText('a2'), user('three')]
  const store = createCollapseStore()

  assert.deepEqual(planNextSpan(history, store, SETTINGS), { start: 0, end: 1, turns: 1 })
  assert.deepEqual(planNextSpan(history, store, SETTINGS, 0), { start: 0, end: 3, turns: 2 })

  store.commits.push(commit('c1', 0, 1, 'FIRST'))
  assert.deepEqual(planNextSpan(history, store, SETTINGS, 0), { start: 2, end: 3, turns: 1 })
  store.commits.push(commit('c2', 2, 3, 'SECOND'))
  assert.equal(planNextSpan(history, store, SETTINGS, 0), null)
})

test('a tool round stays inside one span', () => {
  const history: Message[] = [
    user('task'),
    assistant([{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 't1', name: 'read', input: {} }]),
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
    user('next'),
  ]
  const plan = planNextSpan(history, createCollapseStore(), SETTINGS, 0)
  assert.deepEqual(plan, { start: 0, end: 2, turns: 1 })
  assert.equal(history[plan!.end]?.role, 'user')
})

test('below the start threshold automatic collapse does nothing', async () => {
  const history: Message[] = [user('one'), assistantText('a1', { inputTokens: 5_000 }), user('two')]
  const requests: LlmRequest[] = []
  const outcome = await collapseIfNeeded({
    history,
    system: 'test',
    llm: capturingLlm(requests, () => assistantText('<summary>SUMMARY</summary>')),
    store: createCollapseStore(),
    settings: SETTINGS,
    mode: 'auto',
  })

  assert.equal(outcome, null)
  assert.equal(requests.length, 0)
})

test('over the threshold the oldest closed turn becomes one commit', async () => {
  const history: Message[] = [
    user(`one ${'x'.repeat(4_000)}`),
    assistantText(`a1 ${'y'.repeat(4_000)}`, { inputTokens: 9_200 }),
    user('two'),
    assistantText('a2'),
    user('three'),
  ]
  const requests: LlmRequest[] = []
  const store = createCollapseStore()
  const outcome = await collapseIfNeeded({
    history,
    system: 'test',
    llm: capturingLlm(requests, () => assistantText('<analysis>scratch</analysis><summary>KEEP THIS</summary>')),
    store,
    settings: SETTINGS,
    mode: 'auto',
  })

  assert.ok(outcome)
  assert.equal(outcome.commits.length, 1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.tools.length, 0)
  assert.ok(requests[0]?.messages.some((message) => textOf(message).startsWith('one')))
  assert.match(textOf(requests[0]?.messages.at(-1) as Message), /older segment/)

  const saved = store.commits[0]!
  assert.equal(saved.id, 'c1')
  assert.equal(saved.firstIndex, 0)
  assert.equal(saved.lastIndex, 1)
  assert.equal(saved.turns, 1)
  assert.ok(saved.firstMessageId && saved.lastMessageId)
  assert.ok(saved.tokensBefore > saved.tokensAfter)
  assert.match(saved.summary, /KEEP THIS/)
  assert.equal(saved.summary.includes('scratch'), false)

  assert.equal(textOf(outcome.messages[0] as Message), '<collapsed id="c1">\nSummary:\nKEEP THIS\n</collapsed>')
  assert.equal(textOf(outcome.messages[3] as Message), 'three')
  assert.equal(outcome.after < outcome.before, true)
  assert.deepEqual(getCollapseStats(store), {
    commits: 1,
    messages: 2,
    savedTokens: saved.tokensBefore - saved.tokensAfter,
  })
})

test('above the hard limit the latest closed turn is collapsible too', async () => {
  const history: Message[] = [
    user('one'),
    assistantText('a1', { inputTokens: 9_600 }),
    user('two'),
    assistantText('a2'),
    user('three'),
  ]
  const store = createCollapseStore()
  const outcome = await collapseIfNeeded({
    history,
    system: 'test',
    llm: capturingLlm([], () => assistantText('SUMMARY')),
    store,
    settings: SETTINGS,
    mode: 'auto',
  })

  assert.ok(outcome)
  assert.deepEqual(outcome.commits.map((item) => [item.firstIndex, item.lastIndex, item.turns]), [[0, 3, 2]])
})

test('manual collapse forces a span even below the threshold', async () => {
  const history: Message[] = [user('one'), assistantText('a1'), user('two')]
  const store = createCollapseStore()
  const outcome = await collapseIfNeeded({
    history,
    system: 'test',
    llm: capturingLlm([], () => assistantText('SUMMARY')),
    store,
    settings: SETTINGS,
    mode: 'manual',
  })

  assert.ok(outcome)
  assert.equal(outcome.commits[0]?.turns, 1)
  assert.equal(store.commits.length, 1)
})

test('manual collapse without a closed turn returns null', async () => {
  const history: Message[] = [user('only turn')]
  const outcome = await collapseIfNeeded({
    history,
    system: 'test',
    llm: capturingLlm([], () => assistantText('SUMMARY')),
    store: createCollapseStore(),
    settings: SETTINGS,
    mode: 'manual',
  })
  assert.equal(outcome, null)
})

test('overflow collapse drains every closed turn including the recent one', async () => {
  const history: Message[] = [
    user('one'),
    assistantText('a1'),
    user('two'),
    assistantText('a2'),
    user('three'),
  ]
  const store = createCollapseStore()
  const outcome = await collapseIfNeeded({
    history,
    system: 'test',
    llm: capturingLlm([], () => assistantText('SUMMARY')),
    store,
    settings: SETTINGS,
    mode: 'overflow',
  })

  assert.ok(outcome)
  assert.deepEqual(outcome.commits.map((item) => [item.firstIndex, item.lastIndex]), [[0, 3]])
  assert.equal(outcome.exhausted, false)
})

test('the loop collapses, sends the projected view, and records the commit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-collapse-'))
  try {
    const history: Message[] = [
      user('one'),
      assistantText('a1', { inputTokens: 9_200 }),
      user('two'),
      assistantText('a2'),
    ]
    const requests: LlmRequest[] = []
    const llm = capturingLlm(requests, (request) =>
      isSummaryRequest(request) ? assistantText('<summary>SUMMARY 1</summary>') : assistantText('final'),
    )
    const store = createCollapseStore()
    const result = await runAgent({
      history,
      userText: 'three',
      system: 'test',
      llm,
      tools: [],
      permissions: new PermissionGate('bypass', async () => 'deny'),
      maxTurns: 1,
      cwd: dir,
      collapse: { settings: SETTINGS, store, enabled: true },
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(requests.length, 2)
    assert.equal(isSummaryRequest(requests[0]!), true)
    const main = requests[1]!
    assert.equal(main.messages[0]?.role, 'user')
    assert.match(textOf(main.messages[0] as Message), /^<collapsed id="c1">/)
    assert.equal(main.messages.some((message) => textOf(message) === 'one'), false)
    assert.equal(main.messages.some((message) => textOf(message) === 'two'), true)
    assert.equal(textOf(main.messages.at(-1) as Message), 'three')
    assert.equal(result.collapse?.commits, 1)
    assert.ok(result.collapse && result.collapse.after < result.collapse.before)

    const log = await readFile(path.join(dir, '.copy-agent', 'session.jsonl'), 'utf8')
    assert.match(log, /"collapse"/)
    assert.match(log, /SUMMARY 1/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collapse suppresses autocompact when both would fire', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-collapse-suppress-'))
  try {
    const history: Message[] = [
      user('one'),
      assistantText('a1', { inputTokens: 4_000 }),
      user('two'),
      assistantText('a2'),
    ]
    const requests: LlmRequest[] = []
    const llm = capturingLlm(requests, (request) =>
      isSummaryRequest(request) ? assistantText('SUMMARY') : assistantText('final'),
    )
    const starts: string[] = []
    const result = await runAgent({
      history,
      userText: 'three',
      system: 'test',
      llm,
      tools: [],
      permissions: new PermissionGate('bypass', async () => 'deny'),
      maxTurns: 1,
      cwd: dir,
      compaction: {
        settings: { contextWindow: 5_000, summaryReserve: 2_000, autoBuffer: 1_000 },
        tracking: { consecutiveFailures: 0 },
      },
      collapse: {
        settings: { ...SETTINGS, contextWindow: 5_000, summaryReserve: 1_000 },
        store: createCollapseStore(),
        enabled: true,
      },
      hooks: {
        onCompactStart: () => starts.push('compact'),
        onCollapseStart: () => starts.push('collapse'),
      },
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.deepEqual(starts, ['collapse'])
    assert.equal(result.history.some((message) => textOf(message).startsWith('[compacted]')), false)
    const main = requests.at(-1)!
    assert.match(textOf(main.messages[0] as Message), /^<collapsed/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a prompt-too-long response drains more spans and retries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-collapse-413-'))
  try {
    const history: Message[] = [
      user('one'),
      assistantText('a1', { inputTokens: 9_200 }),
      user('two'),
      assistantText('a2'),
    ]
    const requests: LlmRequest[] = []
    let summary = 0
    let main = 0
    const llm: LlmClient = {
      async complete(request) {
        requests.push(cloneRequest(request))
        if (isSummaryRequest(request)) {
          summary += 1
          return assistantText(`SUMMARY_${summary}`)
        }
        main += 1
        if (main === 1) throw new Error('prompt is too long: 200000 tokens > 128000 maximum')
        return assistantText('recovered')
      },
    }
    const result = await runAgent({
      history,
      userText: 'three',
      system: 'test',
      llm,
      tools: [],
      permissions: new PermissionGate('bypass', async () => 'deny'),
      maxTurns: 1,
      cwd: dir,
      collapse: { settings: SETTINGS, store: createCollapseStore(), enabled: true },
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(main, 2)
    assert.equal(result.collapse?.commits, 2)
    const retry = requests.filter((request) => !isSummaryRequest(request))[1]!
    assert.match(textOf(retry.messages[0] as Message), /^<collapsed id="c1">/)
    assert.match(textOf(retry.messages[1] as Message), /^<collapsed id="c2">/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a span that cannot be summarized falls back to compaction', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-collapse-fallback-'))
  try {
    const history: Message[] = [
      user('one'),
      assistantText('a1', { inputTokens: 9_200 }),
      user('two'),
      assistantText('a2'),
    ]
    const requests: LlmRequest[] = []
    let summary = 0
    let main = 0
    const llm: LlmClient = {
      async complete(request) {
        requests.push(cloneRequest(request))
        if (isSummaryRequest(request)) {
          summary += 1
          if (summary === 1) return assistantText('<summary>COLLAPSED</summary>')
          if (summary === 2) throw new Error('prompt is too long')
          return assistantText('<summary>COMPACTED</summary>')
        }
        main += 1
        if (main === 1) throw new Error('prompt is too long')
        return assistantText('recovered')
      },
    }
    const store = createCollapseStore()
    const result = await runAgent({
      history,
      userText: 'three',
      system: 'test',
      llm,
      tools: [],
      permissions: new PermissionGate('bypass', async () => 'deny'),
      maxTurns: 1,
      cwd: dir,
      collapse: { settings: SETTINGS, store, enabled: true },
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.match(textOf(result.history[0] as Message), /^\[compacted\]/)
    assert.equal(store.commits.length, 0)
    assert.equal(requests.filter((request) => !isSummaryRequest(request)).length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('disabled collapse leaves the raw history untouched', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-collapse-off-'))
  try {
    const history: Message[] = [
      user('one'),
      assistantText('a1', { inputTokens: 9_200 }),
      user('two'),
      assistantText('a2'),
    ]
    const requests: LlmRequest[] = []
    const llm = capturingLlm(requests, () => assistantText('final'))
    const result = await runAgent({
      history,
      userText: 'three',
      system: 'test',
      llm,
      tools: [],
      permissions: new PermissionGate('bypass', async () => 'deny'),
      maxTurns: 1,
      cwd: dir,
      collapse: { settings: SETTINGS, store: createCollapseStore(), enabled: false },
    })

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.messages.some((message) => textOf(message).startsWith('<collapsed')), false)
    assert.equal(result.collapse, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('usage taken before a commit is not trusted afterwards', () => {
  const history: Message[] = [
    user('one'),
    assistantText('a1', { inputTokens: 9_200 }),
    user('two'),
    assistantText('a2'),
    user('three'),
  ]
  const store = createCollapseStore()
  assert.ok(estimateProjectedTokens(history, store) >= 9_200)

  store.commits.push(commit('c1', 0, 1, 'FIRST'))
  store.version += 1
  const projected = estimateProjectedTokens(history, store)
  assert.ok(projected < 1_000)
})

function commit(id: string, firstIndex: number, lastIndex: number, summary: string): CollapseCommit {
  return {
    id,
    firstIndex,
    lastIndex,
    firstMessageId: `id-${firstIndex}`,
    lastMessageId: `id-${lastIndex}`,
    summary,
    tokensBefore: 1_000,
    tokensAfter: 100,
    turns: 1,
    createdAt: new Date().toISOString(),
  }
}

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function assistantText(text: string, usage?: TokenUsage): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], ...(usage ? { usage } : {}) }
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

function isSummaryRequest(request: LlmRequest): boolean {
  const last = request.messages.at(-1)
  return last !== undefined && /CRITICAL: Respond with TEXT ONLY/.test(textOf(last))
}

function cloneRequest(request: LlmRequest): LlmRequest {
  return { ...request, messages: structuredClone(request.messages) }
}

function capturingLlm(requests: LlmRequest[], reply: (request: LlmRequest) => AssistantMessage): LlmClient {
  return {
    async complete(request) {
      requests.push(cloneRequest(request))
      return reply(request)
    },
  }
}