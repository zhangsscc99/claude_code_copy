import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PermissionGate } from '../permissions.js'
import type { AssistantMessage, LlmClient, LlmRequest, Message, TokenUsage } from '../types.js'
import {
  autoCompactThreshold,
  compactHistory,
  compactSession,
  effectiveContextWindow,
  estimateMessageTokens,
  estimateTokens,
  formatCompactSummary,
  selectHistoryTail,
  shouldAutoCompact,
  type CompactionSettings,
} from './compact.js'
import { runAgent } from './loop.js'

// effective window 20000, automatic threshold 7000.
const SETTINGS: CompactionSettings = { contextWindow: 40_000, summaryReserve: 20_000, autoBuffer: 13_000 }

test('the automatic threshold subtracts the summary reserve and the buffer', () => {
  assert.equal(effectiveContextWindow(SETTINGS), 20_000)
  assert.equal(autoCompactThreshold(SETTINGS), 7_000)
})

test('estimation prefers the last usage and estimates only newer messages', () => {
  const history: Message[] = [
    user('hi'),
    assistantText('hello', { inputTokens: 120_000, outputTokens: 500 }),
    user('next'),
  ]
  assert.equal(estimateTokens(history), 120_500 + estimateMessageTokens(history[2] as Message))
  assert.ok(estimateTokens(history) > estimateTokens(history.slice(0, 2)))
})

test('the tail starts at the last user text and a huge tail is summarized too', () => {
  const history: Message[] = [user('old'), assistantText('x'.repeat(40_000)), user('new')]
  const split = selectHistoryTail(history, SETTINGS)
  assert.equal(split.prefix.length, 2)
  assert.equal(split.tail.length, 1)
  assert.equal(textOf(split.tail[0] as Message), 'new')

  const huge: Message[] = [user('task'), assistantText('y'.repeat(40_000))]
  const all = selectHistoryTail(huge, SETTINGS)
  assert.equal(all.prefix.length, 2)
  assert.equal(all.tail.length, 0)
})

test('formatting drops the analysis scratchpad', () => {
  const raw = '<analysis>private reasoning</analysis>\n<summary>\n1. Keep this\n</summary>'
  const formatted = formatCompactSummary(raw)
  assert.match(formatted, /Keep this/)
  assert.equal(formatted.includes('private reasoning'), false)
  assert.equal(formatCompactSummary('<analysis>only scratch</analysis>'), '')
})

test('compaction replaces older messages with boundary and summary', async () => {
  const history: Message[] = [user('old task'), assistantText('OLD_ANSWER'), user('new task')]
  const requests: LlmRequest[] = []
  const llm = capturingLlm(requests, () => assistantText('<analysis>scratch</analysis><summary>KEEP THIS</summary>'))

  const outcome = await compactHistory({
    history,
    system: 'test',
    llm,
    reason: 'auto',
    settings: SETTINGS,
  })

  assert.equal(requests[0]?.tools.length, 0)
  assert.match(textOf(requests[0]?.messages.at(-1) as Message), /CRITICAL: Respond with TEXT ONLY/)
  assert.ok(requests[0]?.messages.some((message) => textOf(message) === 'OLD_ANSWER'))
  assert.match(textOf(outcome.messages[0] as Message), /^\[compacted\].*自动压缩/)
  assert.match(textOf(outcome.messages[1] as Message), /KEEP THIS/)
  assert.equal(textOf(outcome.messages[1] as Message).includes('scratch'), false)
  assert.equal(textOf(outcome.messages[2] as Message), 'new task')
  // compactHistory never mutates the caller's array; compactSession does.
  assert.equal(history.length, 3)
  assert.ok(outcome.before > 0 && outcome.after > 0)
})

test('a prompt-too-long summary drops the oldest turn and retries', async () => {
  const history: Message[] = [
    user('first'),
    assistantText('a1'),
    user('second'),
    assistantText('a2'),
    user('third'),
    assistantText('a3'),
    user('latest'),
  ]
  const requests: LlmRequest[] = []
  let calls = 0
  const llm: LlmClient = {
    async complete(request) {
      requests.push(cloneRequest(request))
      calls += 1
      if (calls === 1) throw new Error('Anthropic API 400: {"error":{"message":"prompt is too long: 240000 tokens"}}')
      return assistantText('<summary>RETRIED</summary>')
    },
  }

  const outcome = await compactHistory({ history, system: 'test', llm, reason: 'manual', settings: SETTINGS })

  assert.equal(requests.length, 2)
  assert.equal(textOf(requests[1]?.messages[0] as Message), 'second')
  assert.equal(requests[1]?.messages.some((message) => textOf(message) === 'first'), false)
  assert.match(textOf(outcome.messages[1] as Message), /RETRIED/)
})

test('a summary that stays too long fails after the retries', async () => {
  const history: Message[] = [
    user('first'),
    assistantText('a1'),
    user('second'),
    assistantText('a2'),
    user('latest'),
  ]
  const llm: LlmClient = {
    async complete() {
      throw new Error('OpenAI API 400: context_length_exceeded')
    },
  }
  await assert.rejects(
    () => compactHistory({ history, system: 'test', llm, reason: 'manual', settings: SETTINGS }),
    /对话太长/,
  )
})

test('auto compaction keeps a recent tool round intact', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-compact-round-'))
  try {
    const history: Message[] = [user('old task'), assistantText('a'.repeat(20_000))]
    const requests: LlmRequest[] = []
    let calls = 0
    const llm: LlmClient = {
      async complete(request) {
        requests.push(cloneRequest(request))
        calls += 1
        if (calls === 1) {
          return assistant([
            { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'big.txt' } },
          ])
        }
        if (calls === 2) return assistantText('<analysis>draft</analysis><summary>SUMMARY_TEXT</summary>')
        return assistantText('done')
      },
    }

    const result = await runAgent({
      history,
      userText: 'continue',
      system: 'test',
      llm,
      tools: [bigReadTool()],
      permissions: new PermissionGate('bypass', async () => 'deny'),
      maxTurns: 4,
      cwd: dir,
      compaction: { settings: SETTINGS, tracking: { consecutiveFailures: 0 } },
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(requests.length, 3)
    assert.equal(requests[1]?.tools.length, 0)
    assert.ok(result.compaction)
    assert.ok(result.compaction!.after < result.compaction!.before)

    const sent = requests[2]?.messages ?? []
    assert.match(textOf(sent[0] as Message), /^\[compacted\].*自动压缩/)
    assert.match(textOf(sent[1] as Message), /SUMMARY_TEXT/)
    assert.equal(textOf(sent[2] as Message), 'continue')

    const toolUseIndex = sent.findIndex((message) => message.content.some((block) => block.type === 'tool_use'))
    const toolResultIndex = sent.findIndex((message) => message.content.some((block) => block.type === 'tool_result'))
    assert.ok(toolUseIndex >= 0 && toolResultIndex === toolUseIndex + 1)
    assert.equal(sent.some((message) => textOf(message) === 'old task'), false)

    const log = result.produced.map(textOf)
    assert.ok(log.includes('continue'))
    assert.ok(log.some((text) => text.startsWith('[compacted]')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto compaction failure keeps the history and trips the breaker after three tries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-compact-breaker-'))
  try {
    const history: Message[] = [user('old'), assistantText('a'.repeat(40_000))]
    const tracking = { consecutiveFailures: 0 }
    let summaryCalls = 0
    const llm: LlmClient = {
      async complete(request) {
        if (request.tools.length === 0) {
          summaryCalls += 1
          throw new Error('模型暂时不可用')
        }
        return assistantText('ok')
      },
    }

    for (let turn = 0; turn < 4; turn += 1) {
      await runAgent({
        history,
        userText: `turn ${turn}`,
        system: 'test',
        llm,
        tools: [bigReadTool()],
        permissions: new PermissionGate('bypass', async () => 'deny'),
        maxTurns: 1,
        cwd: dir,
        compaction: { settings: SETTINGS, tracking },
      })
    }

    assert.equal(summaryCalls, 3)
    assert.equal(tracking.consecutiveFailures, 3)
    assert.equal(history.some((message) => textOf(message).startsWith('[compacted]')), false)
    assert.equal(shouldAutoCompact(history, SETTINGS, tracking), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('DISABLE_AUTO_COMPACT turns automatic compaction off but keeps /compact working', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-compact-env-'))
  const previous = process.env.DISABLE_AUTO_COMPACT
  process.env.DISABLE_AUTO_COMPACT = '1'
  try {
    const history: Message[] = [user('old'), assistantText('a'.repeat(40_000))]
    const tracking = { consecutiveFailures: 2 }
    let summaryCalls = 0
    let calls = 0
    const llm: LlmClient = {
      async complete(request) {
        calls += 1
        if (request.tools.length === 0) {
          summaryCalls += 1
          return assistantText('<summary>MANUAL_SUMMARY</summary>')
        }
        return assistantText('ok')
      },
    }

    await runAgent({
      history,
      userText: 'turn',
      system: 'test',
      llm,
      tools: [bigReadTool()],
      permissions: new PermissionGate('bypass', async () => 'deny'),
      maxTurns: 1,
      cwd: dir,
      compaction: { settings: SETTINGS, tracking },
    })
    assert.equal(calls, 1)

    const outcome = await compactSession({
      history,
      system: 'test',
      llm,
      settings: SETTINGS,
      tracking,
    })
    assert.equal(summaryCalls, 1)
    assert.equal(tracking.consecutiveFailures, 0)
    assert.match(textOf(outcome.messages[0] as Message), /^\[compacted\].*手动压缩/)
    assert.equal(textOf(history[1] as Message).includes('MANUAL_SUMMARY'), true)
    assert.equal(history.some((message) => textOf(message).length > 30_000), false)
  } finally {
    if (previous === undefined) delete process.env.DISABLE_AUTO_COMPACT
    else process.env.DISABLE_AUTO_COMPACT = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('a request whose source is compact never compacts itself', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-compact-source-'))
  try {
    const history: Message[] = [user('old'), assistantText('a'.repeat(40_000))]
    let summaryCalls = 0
    const llm: LlmClient = {
      async complete(request) {
        if (request.tools.length === 0) summaryCalls += 1
        return assistantText('ok')
      },
    }
    await runAgent({
      history,
      userText: 'turn',
      system: 'test',
      llm,
      tools: [bigReadTool()],
      permissions: new PermissionGate('bypass', async () => 'deny'),
      maxTurns: 1,
      cwd: dir,
      source: 'compact',
      compaction: { settings: SETTINGS, tracking: { consecutiveFailures: 0 } },
    })
    assert.equal(summaryCalls, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manual compaction refuses a short history and a disabled configuration', async () => {
  const short: Message[] = [user('only a prompt')]
  const llm: LlmClient = { async complete() { return assistantText('unused') } }
  await assert.rejects(
    () => compactSession({ history: short, system: 'test', llm, settings: SETTINGS }),
    /还没有足够的历史/,
  )

  const previous = process.env.DISABLE_COMPACT
  process.env.DISABLE_COMPACT = '1'
  try {
    const history: Message[] = [user('a'), assistantText('b')]
    await assert.rejects(
      () => compactSession({ history, system: 'test', llm, settings: SETTINGS }),
      /DISABLE_COMPACT/,
    )
  } finally {
    if (previous === undefined) delete process.env.DISABLE_COMPACT
    else process.env.DISABLE_COMPACT = previous
  }
})

test('the kept tail drops pre-compaction usage', async () => {
  const history: Message[] = [
    user('old task'),
    assistantText('OLD_ANSWER'),
    user('new task'),
    assistantText('NEW_ANSWER', { inputTokens: 2_000, outputTokens: 20 }),
  ]
  const llm = capturingLlm([], () => assistantText('<summary>SUMMARY</summary>'))
  const outcome = await compactHistory({ history, system: 'test', llm, reason: 'auto', settings: SETTINGS })

  assert.equal(outcome.messages.length, 4)
  assert.equal(textOf(outcome.messages[3] as Message), 'NEW_ANSWER')
  assert.equal(outcome.messages.some((message) => message.role === 'assistant' && message.usage !== undefined), false)
  // The fresh summary is measured by characters, not by the stale 2k usage.
  assert.ok(estimateTokens(outcome.messages) < 1_000)
})

test('a second compaction absorbs the earlier boundary and summary', async () => {
  const history: Message[] = [user('first task'), assistantText('FIRST_ANSWER')]
  const requests: LlmRequest[] = []
  let summary = 0
  const llm: LlmClient = {
    async complete(request) {
      requests.push(cloneRequest(request))
      summary += 1
      return assistantText(`<summary>SUMMARY_${summary}</summary>`)
    },
  }

  await compactSession({ history, system: 'test', llm, settings: SETTINGS })
  history.push(user('next task'), assistantText('NEXT_ANSWER'))
  await compactSession({ history, system: 'test', llm, settings: SETTINGS })

  assert.equal(history.filter((message) => textOf(message).startsWith('This session is being continued')).length, 1)
  assert.equal(history.filter((message) => textOf(message).startsWith('[compacted]')).length, 1)
  assert.equal(textOf(history[2] as Message), 'next task')
  const secondRequest = requests.at(-1)
  assert.ok(secondRequest)
  assert.ok(secondRequest.messages.some((message) => textOf(message).includes('SUMMARY_1')))
  assert.match(textOf(secondRequest.messages[0] as Message), /^\[compacted\]/)
})

test('below the threshold the loop sends the original history once', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-compact-below-'))
  try {
    const history: Message[] = [user('a'), assistantText('b')]
    const requests: LlmRequest[] = []
    const llm = capturingLlm(requests, () => assistantText('answer'))
    await runAgent({
      history,
      userText: 'c',
      system: 'test',
      llm,
      tools: [bigReadTool()],
      permissions: new PermissionGate('bypass', async () => 'deny'),
      maxTurns: 1,
      cwd: dir,
      compaction: { settings: SETTINGS, tracking: { consecutiveFailures: 0 } },
    })
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.messages.some((message) => textOf(message).startsWith('[compacted]')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

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

function bigReadTool() {
  return {
    name: 'read_file',
    description: 'read a file',
    kind: 'read' as const,
    inputSchema: {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false as const,
    },
    async execute() {
      return 'r'.repeat(10_000)
    },
  }
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
