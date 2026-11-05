export type TextBlock = { type: 'text'; text: string }

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type AssistantContent = TextBlock | ToolUseBlock
export type UserContent = TextBlock | ToolResultBlock

/**
 * Corpus size reported by one API response. Input already includes cache reads
 * and cache writes. Kept on the assistant message so the next turn can measure
 * the context without re-tokenizing the whole history.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens?: number
}

/** Optional stable id; collapse commits reference spans by id as well as index. */
export type UserMessage = { role: 'user'; content: UserContent[]; id?: string }
export type AssistantMessage = { role: 'assistant'; content: AssistantContent[]; usage?: TokenUsage; id?: string }
export type Message = UserMessage | AssistantMessage

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties: false
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: ToolInputSchema
}

export interface LlmRequest {
  system: string
  messages: Message[]
  tools: ToolSchema[]
  model?: string
  maxTokens?: number
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<AssistantMessage>
}

export type ToolKind = 'read' | 'edit' | 'exec'

export interface ToolContext {
  cwd: string
}

export interface Tool {
  name: string
  description: string
  kind: ToolKind
  inputSchema: ToolInputSchema
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>
}
