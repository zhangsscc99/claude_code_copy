import { randomUUID } from 'node:crypto'
import type { AssistantContent, AssistantMessage, LlmClient, LlmRequest, Message } from '../types.js'

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
      messages: request.messages.map(toAnthropicMessage),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
    }),
  })
  const body = await readBody(response)
  if (!response.ok) throw new Error(`Anthropic API ${response.status}: ${snippet(body)}`)
  const parsed = JSON.parse(body) as { content?: unknown[] }
  return { role: 'assistant', content: anthropicContent(parsed.content) }
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
  }
  const message = parsed.choices?.[0]?.message
  if (!message) throw new Error(`OpenAI API returned no message: ${snippet(body)}`)
  return { role: 'assistant', content: openAIContent(message) }
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
