import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PermissionGate } from '../permissions.js'
import type { AssistantMessage, LlmClient, Message } from '../types.js'
import { createBuiltinTools } from '../tools/builtin.js'
import { runAgent } from './loop.js'

test('the loop runs a tool and then stops on text', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-loop-'))
  try {
    await writeFile(path.join(dir, 'hello.txt'), 'hello\n')
    const history: Message[] = []
    const result = await runAgent({
      history,
      userText: 'read hello.txt',
      system: 'test',
      llm: scripted([
        assistant([{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'hello.txt' } }]),
        assistant([{ type: 'text', text: '文件里是 hello' }]),
      ]),
      tools: createBuiltinTools(),
      permissions: new PermissionGate('bypass', async () => 'deny'),
      maxTurns: 5,
      cwd: dir,
    })
    assert.equal(result.stopReason, 'end_turn')
    const toolResult = history.find((message) => message.role === 'user' && message.content.some((block) => block.type === 'tool_result'))
    assert.ok(toolResult && toolResult.role === 'user')
    const block = toolResult.content.find((item) => item.type === 'tool_result')
    assert.ok(block && block.type === 'tool_result')
    assert.match(block.content, /hello/)
    assert.equal(block.is_error, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plan mode blocks bash and still returns a tool result', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-plan-'))
  try {
    const history: Message[] = []
    const result = await runAgent({
      history,
      userText: 'run tests',
      system: 'test',
      llm: scripted([
        assistant([{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm test' } }]),
        assistant([{ type: 'text', text: '计划模式不能跑命令' }]),
      ]),
      tools: createBuiltinTools(),
      permissions: new PermissionGate('plan', async () => {
        throw new Error('plan mode should not ask')
      }),
      maxTurns: 4,
      cwd: dir,
    })
    assert.equal(result.stopReason, 'end_turn')
    const toolMessage = history.find((message) => message.role === 'user' && message.content.some((block) => block.type === 'tool_result'))
    assert.ok(toolMessage && toolMessage.role === 'user')
    const block = toolMessage.content[0]
    assert.ok(block && block.type === 'tool_result')
    assert.equal(block.is_error, true)
    assert.match(block.content, /Plan mode/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

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
