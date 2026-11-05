import { randomUUID } from 'node:crypto'
import type {
  AssistantContent,
  AssistantMessage,
  LlmClient,
  LlmRequest,
  Message,
  TokenUsage,
} from '../types.js'

export function createLlmClient(options: {
  provider: 'anthropic' | 'openai'
  apiKey: string
  baseUrl: string
  model: string
  maxTokens: number
}): LlmClient {
  return {
    complete(request) {
      const model = request.model || options.model
      const maxTokens = request.maxTokens || options.maxTokens
      if (options.provider === 'anthropic') {
        return completeAnthropic(options.apiKey, options.baseUrl, model, maxTokens, request)
      }
      return completeOpenAI(options.apiKey, options.baseUrl, model, maxTokens, request)
    },
  }
}

async function completeAnthropic(
  apiKey: string,
  baseUrl: string,
  model: string,
  maxTokens: number,
  request: LlmRequest,
): Promise<AssistantMessage> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: request.system,
      messages: mergeAdjacentRoles(request.messages).map(toAnthropicMessage),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
    }),
  })
  const body = await readBody(response)
  if (!response.ok) throw new Error(`Anthropic API ${response.status}: ${snippet(body)}`)
  const parsed = JSON.parse(body) as { content?: unknown[]; usage?: unknown }
  const message: AssistantMessage = { role: 'assistant', content: anthropicContent(parsed.content) }
  const usage = tokenUsage(parsed.usage)
  if (usage) message.usage = usage
  return message
}

async function completeOpenAI(
  apiKey: string,
  baseUrl: string,
  model: string,
  maxTokens: number,
  request: LlmRequest,
): Promise<AssistantMessage> {
  const response = await fetch(chatCompletionsUrl(baseUrl), {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: toOpenAIMessages(request),
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
    }),
  })
  const body = await readBody(response)
  if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${snippet(body)}`)
  const parsed = JSON.parse(body) as {
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
      }
    }>
    usage?: unknown
  }
  const message = parsed.choices?.[0]?.message
  if (!message) throw new Error(`OpenAI API returned no message: ${snippet(body)}`)
  const assistant: AssistantMessage = { role: 'assistant', content: openAIContent(message) }
  const usage = tokenUsage(parsed.usage)
  if (usage) assistant.usage = usage
  return assistant
}

/**
 * The projected collapse view puts a summary placeholder directly before the
 * next real user turn, and compaction can emit boundary + summary back to back.
 * Anthropic wants alternating roles, so combine same-role neighbours (the same
 * normalization the reference source calls mergeUserMessages).
 */
export function mergeAdjacentRoles(messages: Message[]): Message[] {
  const merged: Message[] = []
  for (const message of messages) {
    const previous = merged[merged.length - 1]
    if (!previous || previous.role !== message.role) {
      merged.push(message)
      continue
    }
    if (previous.role === 'user' && message.role === 'user') {
      merged[merged.length - 1] = {
        role: 'user',
        content: [...previous.content, ...message.content],
        ...(previous.id ? { id: previous.id } : {}),
      }
    } else if (previous.role === 'assistant' && message.role === 'assistant') {
      merged[merged.length - 1] = {
        role: 'assistant',
        content: [...previous.content, ...message.content],
        ...(message.usage ? { usage: message.usage } : previous.usage ? { usage: previous.usage } : {}),
        ...(previous.id ? { id: previous.id } : {}),
      }
    }
  }
  return merged
}

function toAnthropicMessage(message: Message): unknown {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content.map((block) =>
        block.type === 'text'
          ? { type: 'text', text: block.text }
          : { type: 'tool_use', id: block.id, name: block.name, input: block.input },
      ),
    }
  }
  return {
    role: 'user',
    content: message.content.map((block) => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      }
    }),
  }
}

function toOpenAIMessages(request: LlmRequest): unknown[] {
  const messages: unknown[] = [{ role: 'system', content: request.system }]
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      const toolCalls = message.content.filter((block) => block.type === 'tool_use')
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((block) => ({
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: JSON.stringify(block.input) },
              })),
            }
          : {}),
      })
      continue
    }
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (text) messages.push({ role: 'user', content: text })
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue
      messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content })
    }
  }
  return messages
}

function anthropicContent(content: unknown[] | undefined): AssistantContent[] {
  const blocks: AssistantContent[] = []
  for (const block of content ?? []) {
    if (!block || typeof block !== 'object') continue
    const record = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown }
    if (record.type === 'text' && record.text) blocks.push({ type: 'text', text: record.text })
    if (record.type === 'tool_use' && record.name) {
      blocks.push({
        type: 'tool_use',
        id: record.id || randomUUID(),
        name: record.name,
        input: asRecord(record.input),
      })
    }
  }
  return blocks
}

function openAIContent(message: {
  content?: string | null
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
}): AssistantContent[] {
  const blocks: AssistantContent[] = []
  if (message.content) blocks.push({ type: 'text', text: message.content })
  for (const call of message.tool_calls ?? []) {
    const name = call.function?.name
    if (!name) continue
    blocks.push({
      type: 'tool_use',
      id: call.id || randomUUID(),
      name,
      input: parseArguments(call.function?.arguments),
    })
  }
  return blocks
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  const parsed = JSON.parse(raw) as unknown
  return asRecord(parsed)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/**
 * Reads usage from both providers. Anthropic reports the cached part
 * separately; OpenAI-compatible endpoints already fold it into prompt_tokens.
 */
function tokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const input = numberOrUndefined(record.input_tokens) ?? numberOrUndefined(record.prompt_tokens)
  const output = numberOrUndefined(record.output_tokens) ?? numberOrUndefined(record.completion_tokens)
  if (input === undefined && output === undefined) return undefined
  const cacheRead = numberOrUndefined(record.cache_read_input_tokens) ?? 0
  const cacheWrite = numberOrUndefined(record.cache_creation_input_tokens) ?? 0
  return {
    inputTokens: (input ?? 0) + cacheRead + cacheWrite,
    ...(output === undefined ? {} : { outputTokens: output }),
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function chatCompletionsUrl(baseUrl: string): string {
  if (baseUrl.endsWith('/chat/completions')) return baseUrl
  if (baseUrl.endsWith('/v1')) return `${baseUrl}/chat/completions`
  return `${baseUrl}/v1/chat/completions`
}

async function readBody(response: Response): Promise<string> {
  return response.text()
}

function snippet(body: string): string {
  return body.slice(0, 500)
}
