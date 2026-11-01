import type { PermissionGate } from '../permissions.js'
import type {
  AssistantMessage,
  LlmClient,
  Message,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from '../types.js'

export interface AgentHooks {
  onAssistantText?: (text: string) => void
  onToolStart?: (name: string, input: Record<string, unknown>) => void
  onToolEnd?: (name: string, output: string, isError: boolean) => void
}

export interface RunAgentOptions {
  history: Message[]
  userText: string
  system: string
  llm: LlmClient
  tools: Tool[]
  permissions: PermissionGate
  maxTurns: number
  cwd: string
  model?: string
  hooks?: AgentHooks
}

export interface RunAgentResult {
  history: Message[]
  turns: number
  stopReason: 'end_turn' | 'max_turns' | 'error'
  error?: string
}

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const history = options.history
  history.push({ role: 'user', content: [{ type: 'text', text: options.userText }] })

  for (let turn = 1; turn <= options.maxTurns; turn++) {
    let assistant: AssistantMessage
    try {
      assistant = await options.llm.complete({
        system: options.system,
        messages: history,
        tools: options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
        model: options.model,
      })
    } catch (error) {
      return { history, turns: turn, stopReason: 'error', error: messageOf(error) }
    }

    if (assistant.content.length === 0) {
      return { history, turns: turn, stopReason: 'end_turn' }
    }

    history.push(assistant)
    const text = assistant.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text) options.hooks?.onAssistantText?.(text)

    const calls = assistant.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
    if (calls.length === 0) return { history, turns: turn, stopReason: 'end_turn' }

    const results: ToolResultBlock[] = []
    for (const call of calls) results.push(await executeToolCall(call, options))
    history.push({ role: 'user', content: results })
  }

  return { history, turns: options.maxTurns, stopReason: 'max_turns' }
}

async function executeToolCall(call: ToolUseBlock, options: RunAgentOptions): Promise<ToolResultBlock> {
  const tool = options.tools.find((item) => item.name === call.name)
  if (!tool) return errorResult(call.id, `Unknown tool: ${call.name}`)

  options.hooks?.onToolStart?.(tool.name, call.input)
  const decision = await options.permissions.check(tool, call.input)
  if (!decision.allowed) {
    options.hooks?.onToolEnd?.(tool.name, decision.reason, true)
    return errorResult(call.id, decision.reason)
  }

  try {
    const output = await tool.execute(call.input, { cwd: options.cwd })
    options.hooks?.onToolEnd?.(tool.name, output, false)
    return { type: 'tool_result', tool_use_id: call.id, content: output }
  } catch (error) {
    const output = messageOf(error)
    options.hooks?.onToolEnd?.(tool.name, output, true)
    return errorResult(call.id, output)
  }
}

function errorResult(id: string, content: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: id, content, is_error: true }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
