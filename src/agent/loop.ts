import { randomUUID } from 'node:crypto'
import type { PermissionGate } from '../permissions.js'
import { appendCollapseCommit } from '../transcript.js'
import { Span, type TraceBus } from './trace.js'
import type {
  AssistantMessage,
  LlmClient,
  Message,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
  UserMessage,
} from '../types.js'
import {
  compactHistory,
  isCompactionDisabled,
  isPromptTooLongError,
  loadCompactionSettings,
  shouldAutoCompact,
  type CompactReason,
  type CompactSource,
  type CompactionSettings,
  type CompactionTracking,
} from './compact.js'
import {
  collapseIfNeeded,
  createCollapseStore,
  isContextCollapseEnabled,
  loadCollapseSettings,
  noteCollapseResponse,
  projectView,
  resetCollapseStore,
  type CollapseReason,
  type CollapseSettings,
  type CollapseStore,
} from './collapse.js'

export interface AgentHooks {
  onAssistantText?: (text: string) => void
  onToolStart?: (name: string, input: Record<string, unknown>) => void
  onToolEnd?: (name: string, output: string, isError: boolean) => void
  onCompactStart?: (reason: CompactReason) => void
  onCompactEnd?: (info: { reason: CompactReason; before: number; after: number }) => void
  onCompactError?: (reason: CompactReason, message: string) => void
  onCollapseStart?: (reason: CollapseReason) => void
  onCollapseEnd?: (info: { reason: CollapseReason; commits: number; before: number; after: number }) => void
  onCollapseError?: (reason: CollapseReason, message: string) => void
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
  /** A request made by the compactor itself must not be compacted again. */
  source?: CompactSource
  compaction?: {
    settings?: CompactionSettings
    tracking?: CompactionTracking
  }
  collapse?: {
    settings?: CollapseSettings
    store?: CollapseStore
    enabled?: boolean
  }
  hooks?: AgentHooks
  /** Telemetry bus; undefined means tracing is off. Never blocks the loop. */
  trace?: TraceBus
}

export interface RunAgentResult {
  history: Message[]
  /** Messages appended to history during this run, including compact boundary and summary. */
  produced: Message[]
  turns: number
  stopReason: 'end_turn' | 'max_turns' | 'error'
  error?: string
  compaction?: { before: number; after: number }
  collapse?: { commits: number; before: number; after: number }
}

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const history = options.history
  const produced: Message[] = []
  const settings = options.compaction?.settings ?? loadCompactionSettings()
  const tracking = options.compaction?.tracking ?? { consecutiveFailures: 0 }
  const source = options.source ?? 'agent'
  const collapseSettings = options.collapse?.settings ?? loadCollapseSettings()
  const collapseEnabled = options.collapse?.enabled ?? isContextCollapseEnabled()
  const collapseStore = options.collapse?.store ?? (collapseEnabled ? createCollapseStore() : undefined)
  const collapseOn = collapseEnabled && collapseStore !== undefined && source !== 'compact'
  let compaction: { before: number; after: number } | undefined
  let collapse: { commits: number; before: number; after: number } | undefined

  const userMessage: UserMessage = { role: 'user', content: [{ type: 'text', text: options.userText }] }
  history.push(userMessage)
  produced.push(userMessage)

  const runSpan = new Span(options.trace, {
    traceId: randomUUID(),
    kind: 'run',
    name: 'agent_run',
    ...(options.model ? { model: options.model } : {}),
    attrs: { maxTurns: options.maxTurns, source },
  })

  const finish = (result: RunAgentResult): RunAgentResult => {
    runSpan.end({
      status: result.stopReason === 'error' ? 'error' : 'ok',
      ...(result.error ? { error: result.error } : {}),
      attrs: { stopReason: result.stopReason, turns: result.turns },
    })
    return result
  }

  for (let turn = 1; turn <= options.maxTurns; turn++) {
    const turnSpan = runSpan.child({ kind: 'turn', name: `turn_${turn}`, turn, ...(options.model ? { model: options.model } : {}) })
    // Collapse owns the headroom ladder when it is on, so autocompact must not
    // race it (same rule as the reference autoCompact.ts).
    if (!collapseOn && shouldAutoCompact(history, settings, tracking, source)) {
      options.hooks?.onCompactStart?.('auto')
      const compactSpan = turnSpan.child({ kind: 'compact', name: 'auto_compact', turn })
      try {
        const result = await compactHistory({
          history,
          system: options.system,
          llm: options.llm,
          model: options.model,
          reason: 'auto',
          settings,
        })
        // Replace in place: every caller holds this array.
        history.splice(0, history.length, ...result.messages)
        produced.push(result.boundary, result.summaryMessage)
        tracking.consecutiveFailures = 0
        compaction = { before: result.before, after: result.after }
        compactSpan.end({ attrs: { before: result.before, after: result.after } })
        options.hooks?.onCompactEnd?.({ reason: 'auto', before: result.before, after: result.after })
      } catch (error) {
        // Auto compaction must not fail the user's turn: keep the original
        // history and let the breaker stop pointless retries.
        tracking.consecutiveFailures += 1
        compactSpan.end({ status: 'error', error: messageOf(error) })
        options.hooks?.onCompactError?.('auto', messageOf(error))
      }
    }

    if (collapseOn) {
      const collapseSpan = turnSpan.child({ kind: 'collapse', name: 'auto_collapse', turn })
      try {
        const outcome = await collapseIfNeeded({
          history,
          system: options.system,
          llm: options.llm,
          model: options.model,
          store: collapseStore,
          settings: collapseSettings,
          mode: 'auto',
          onStart: (reason) => options.hooks?.onCollapseStart?.(reason),
          onCommit: (commit) => appendCollapseCommit(options.cwd, commit),
        })
        if (outcome) {
          collapse = mergeCollapse(collapse, outcome)
          collapseSpan.end({
            attrs: { commits: outcome.commits.length, before: outcome.before, after: outcome.after },
          })
          options.hooks?.onCollapseEnd?.({
            reason: 'auto',
            commits: outcome.commits.length,
            before: outcome.before,
            after: outcome.after,
          })
        } else {
          collapseSpan.end()
        }
      } catch (error) {
        collapseSpan.end({ status: 'error', error: messageOf(error) })
        options.hooks?.onCollapseError?.('auto', messageOf(error))
      }
    }

    let assistant: AssistantMessage
    let attempt = 0
    for (;;) {
      const messages = collapseOn ? projectView(history, collapseStore.commits) : history
      const llmSpan = turnSpan.child({
        kind: 'llm_call',
        name: 'llm.complete',
        turn,
        ...(options.model ? { model: options.model } : {}),
        attrs: { attempt, messageCount: messages.length },
      })
      try {
        assistant = await options.llm.complete({
          system: options.system,
          messages,
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
          model: options.model,
        })
        llmSpan.end({
          attrs: {
            inputTokens: assistant.usage?.inputTokens,
            outputTokens: assistant.usage?.outputTokens,
            toolCalls: assistant.content.filter((block) => block.type === 'tool_use').length,
          },
        })
        if (collapseOn) noteCollapseResponse(collapseStore)
        break
      } catch (error) {
        const text = messageOf(error)
        llmSpan.end({ status: 'error', error: text })
        if (!collapseOn || !isPromptTooLongError(text) || attempt >= 2) {
          turnSpan.end({ status: 'error', error: text })
          return finish({
            history,
            produced,
            turns: turn,
            stopReason: 'error',
            error: text,
            ...(compaction ? { compaction } : {}),
            ...(collapse ? { collapse } : {}),
          })
        }
        attempt += 1

        // First recovery: drain what collapse can still summarize, then retry.
        const overflowSpan = turnSpan.child({ kind: 'collapse', name: 'overflow_collapse', turn })
        try {
          const outcome = await collapseIfNeeded({
            history,
            system: options.system,
            llm: options.llm,
            model: options.model,
            store: collapseStore,
            settings: collapseSettings,
            mode: 'overflow',
            onStart: (reason) => options.hooks?.onCollapseStart?.(reason),
            onCommit: (commit) => appendCollapseCommit(options.cwd, commit),
          })
          if (outcome) {
            collapse = mergeCollapse(collapse, outcome)
            overflowSpan.end({
              attrs: {
                commits: outcome.commits.length,
                before: outcome.before,
                after: outcome.after,
                exhausted: outcome.exhausted,
              },
            })
            options.hooks?.onCollapseEnd?.({
              reason: 'overflow',
              commits: outcome.commits.length,
              before: outcome.before,
              after: outcome.after,
            })
            if (!outcome.exhausted) continue
          } else {
            overflowSpan.end()
          }
        } catch (collapseError) {
          overflowSpan.end({ status: 'error', error: messageOf(collapseError) })
          options.hooks?.onCollapseError?.('overflow', messageOf(collapseError))
        }

        // Second recovery: a single huge turn cannot be collapsed. Fall back to
        // compaction, which may summarize inside the turn.
        if (!isCompactionDisabled()) {
          const recoverySpan = turnSpan.child({ kind: 'compact', name: 'recovery_compact', turn })
          try {
            options.hooks?.onCompactStart?.('auto')
            const result = await compactHistory({
              history,
              system: options.system,
              llm: options.llm,
              model: options.model,
              reason: 'auto',
              settings,
            })
            history.splice(0, history.length, ...result.messages)
            produced.push(result.boundary, result.summaryMessage)
            tracking.consecutiveFailures = 0
            compaction = { before: result.before, after: result.after }
            resetCollapseStore(collapseStore)
            // The commits no longer exist; do not report them as this turn's result.
            collapse = undefined
            recoverySpan.end({ attrs: { before: result.before, after: result.after } })
            options.hooks?.onCompactEnd?.({ reason: 'auto', before: result.before, after: result.after })
            continue
          } catch (compactError) {
            recoverySpan.end({ status: 'error', error: messageOf(compactError) })
            options.hooks?.onCompactError?.('auto', messageOf(compactError))
          }
        }

        turnSpan.end({ status: 'error', error: text })
        return finish({
          history,
          produced,
          turns: turn,
          stopReason: 'error',
          error: text,
          ...(compaction ? { compaction } : {}),
          ...(collapse ? { collapse } : {}),
        })
      }
    }

    if (assistant.content.length === 0) {
      turnSpan.end()
      return finish({
        history,
        produced,
        turns: turn,
        stopReason: 'end_turn',
        ...(compaction ? { compaction } : {}),
        ...(collapse ? { collapse } : {}),
      })
    }

    history.push(assistant)
    produced.push(assistant)
    const text = assistant.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text) options.hooks?.onAssistantText?.(text)

    const calls = assistant.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
    if (calls.length === 0) {
      turnSpan.end()
      return finish({
        history,
        produced,
        turns: turn,
        stopReason: 'end_turn',
        ...(compaction ? { compaction } : {}),
        ...(collapse ? { collapse } : {}),
      })
    }

    options.permissions.setTranscript(transcriptOf(history))

    const results: ToolResultBlock[] = []
    for (const call of calls) results.push(await executeToolCall(call, options, turnSpan))
    turnSpan.end()
    const toolMessage: UserMessage = { role: 'user', content: results }
    history.push(toolMessage)
    produced.push(toolMessage)
  }

  return finish({
    history,
    produced,
    turns: options.maxTurns,
    stopReason: 'max_turns',
    ...(compaction ? { compaction } : {}),
    ...(collapse ? { collapse } : {}),
  })
}

function mergeCollapse(
  current: { commits: number; before: number; after: number } | undefined,
  outcome: { commits: unknown[]; before: number; after: number },
): { commits: number; before: number; after: number } {
  return {
    commits: (current?.commits ?? 0) + outcome.commits.length,
    before: current?.before ?? outcome.before,
    after: outcome.after,
  }
}

async function executeToolCall(
  call: ToolUseBlock,
  options: RunAgentOptions,
  turnSpan: Span,
): Promise<ToolResultBlock> {
  const tool = options.tools.find((item) => item.name === call.name)
  if (!tool) return errorResult(call.id, `Unknown tool: ${call.name}`)

  const toolSpan = turnSpan.child({
    kind: 'tool_call',
    name: tool.name,
    attrs: { inputPreview: previewInput(call.input) },
  })
  options.hooks?.onToolStart?.(tool.name, call.input)

  const permissionSpan = toolSpan.child({ kind: 'permission', name: 'permission.check' })
  const decision = await options.permissions.check(tool, call.input)
  permissionSpan.end({
    status: decision.allowed ? 'ok' : 'error',
    ...(decision.allowed ? {} : { error: decision.reason }),
    attrs: { allowed: decision.allowed },
  })

  if (!decision.allowed) {
    toolSpan.end({ status: 'error', error: decision.reason, attrs: { denied: true } })
    options.hooks?.onToolEnd?.(tool.name, decision.reason, true)
    return errorResult(call.id, decision.reason)
  }

  try {
    const output = await tool.execute(call.input, { cwd: options.cwd })
    toolSpan.end({ attrs: { outputBytes: output.length } })
    options.hooks?.onToolEnd?.(tool.name, output, false)
    return { type: 'tool_result', tool_use_id: call.id, content: output }
  } catch (error) {
    const output = messageOf(error)
    toolSpan.end({ status: 'error', error: output })
    options.hooks?.onToolEnd?.(tool.name, output, true)
    return errorResult(call.id, output)
  }
}

function previewInput(input: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(input) ?? ''
    return text.length > 500 ? text.slice(0, 500) : text
  } catch {
    return ''
  }
}

function errorResult(id: string, content: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: id, content, is_error: true }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function transcriptOf(messages: Message[]): string {
  return messages.map((message) => {
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    return `${message.role}: ${text}`
  }).join('\n').slice(-20_000)
}