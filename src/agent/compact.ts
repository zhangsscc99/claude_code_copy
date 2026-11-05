import type { LlmClient, Message, TokenUsage, UserMessage } from '../types.js'

/**
 * Context compaction, modelled on Claude Code's services/compact:
 * estimate the context, summarize the older portion with the same model, then
 * replace the history with boundary + summary + the most recent closed round.
 */

export const DEFAULT_CONTEXT_WINDOW = 128_000
// p99.99 of a compact summary is ~17.4k tokens; reserve the same 20k ceiling.
export const SUMMARY_OUTPUT_RESERVE = 20_000
export const AUTO_COMPACT_BUFFER = 13_000
export const MAX_CONSECUTIVE_FAILURES = 3
export const MAX_PTL_RETRIES = 3
export const COMPACT_BOUNDARY_PREFIX = '[compacted]'

const PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]'

export interface CompactionSettings {
  contextWindow: number
  summaryReserve: number
  autoBuffer: number
}

/** Per-session breaker state. Survives across turns. */
export interface CompactionTracking {
  consecutiveFailures: number
}

export type CompactReason = 'auto' | 'manual'
export type CompactSource = 'agent' | 'compact'

export interface CompactionOutcome {
  before: number
  after: number
  boundary: UserMessage
  summaryMessage: UserMessage
  messages: Message[]
}

export function loadCompactionSettings(env: NodeJS.ProcessEnv = process.env): CompactionSettings {
  return {
    contextWindow: positiveInteger(env.AGENT_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW, 'AGENT_CONTEXT_WINDOW'),
    summaryReserve: SUMMARY_OUTPUT_RESERVE,
    autoBuffer: AUTO_COMPACT_BUFFER,
  }
}

export function effectiveContextWindow(settings: CompactionSettings): number {
  return settings.contextWindow - settings.summaryReserve
}

/** The count that triggers automatic compaction. 128k -> 128000-20000-13000 = 95000. */
export function autoCompactThreshold(settings: CompactionSettings): number {
  return effectiveContextWindow(settings) - settings.autoBuffer
}

export function isCompactionDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env.DISABLE_COMPACT)
}

export function isAutoCompactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isCompactionDisabled(env) && !envFlag(env.DISABLE_AUTO_COMPACT)
}

export function shouldAutoCompact(
  messages: Message[],
  settings: CompactionSettings,
  tracking?: CompactionTracking,
  source: CompactSource = 'agent',
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // A compaction request must never compact itself.
  if (source === 'compact') return false
  if (!isAutoCompactionEnabled(env)) return false
  if (tracking && tracking.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false
  if (!hasCompleteExchange(messages)) return false
  return estimateTokens(messages) >= autoCompactThreshold(settings)
}

/**
 * Prefer the last API-reported context size, then estimate whatever was added
 * after it. Without usage, fall back to chars/4 over the whole history.
 */
export function estimateTokens(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.usage) {
      return usageTotal(message.usage) + estimateMessagesTokens(messages.slice(index + 1))
    }
  }
  return estimateMessagesTokens(messages)
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) total += estimateMessageTokens(message)
  return total
}

export function estimateMessageTokens(message: Message): number {
  let chars = 4
  for (const block of message.content) {
    if (block.type === 'text') {
      chars += block.text.length
    } else if (block.type === 'tool_use') {
      chars += block.name.length + safeJson(block.input).length
    } else {
      chars += block.tool_use_id.length + block.content.length
    }
  }
  return Math.ceil(chars / 4)
}

/** A user turn followed by an assistant turn; before that there is nothing to summarize. */
export function hasCompleteExchange(messages: Message[]): boolean {
  let sawUser = false
  for (const message of messages) {
    if (message.role === 'user') sawUser = true
    else if (sawUser) return true
  }
  return false
}

/**
 * Splits history into the part to summarize and the tail to keep verbatim.
 * The tail starts at the most recent user text so a tool_use can never be
 * separated from its tool_result. If the tail alone is already half the
 * automatic threshold, the tail is summarized too.
 */
export function selectHistoryTail(
  history: Message[],
  settings: CompactionSettings,
): { prefix: Message[]; tail: Message[] } {
  const start = lastUserTextIndex(history)
  if (start < 0) return { prefix: history.slice(), tail: [] }
  const tail = history.slice(start)
  if (estimateTokens(tail) > autoCompactThreshold(settings) / 2) {
    return { prefix: history.slice(), tail: [] }
  }
  return { prefix: history.slice(0, start), tail }
}

export async function compactHistory(options: {
  history: Message[]
  system: string
  llm: LlmClient
  model?: string
  reason: CompactReason
  settings: CompactionSettings
}): Promise<CompactionOutcome> {
  const before = estimateTokens(options.history)
  const selection = selectHistoryTail(options.history, options.settings)
  let prefix = selection.prefix
  let tail = selection.tail
  if (prefix.length === 0) {
    prefix = options.history.slice()
    tail = []
  }
  if (prefix.length === 0) throw new Error('还没有足够的历史可以压缩。')

  const summary = await requestSummary(prefix, options)
  const boundary = createBoundaryMessage(options.reason, before)
  const summaryMessage = createSummaryMessage(summary)
  // Kept messages were generated while the summarized context was still in the
  // request, so their usage describes a corpus that no longer exists. Drop it
  // or the next estimate would overstate the post-compaction context.
  const messages = [boundary, summaryMessage, ...tail.map(stripStaleUsage)]
  return { before, after: estimateTokens(messages), boundary, summaryMessage, messages }
}

/**
 * Manual /compact. Ignores the automatic threshold, refuses short or disabled
 * histories, and replaces the caller's array in place so every holder sees it.
 */
export async function compactSession(options: {
  history: Message[]
  system: string
  llm: LlmClient
  model?: string
  settings?: CompactionSettings
  tracking?: CompactionTracking
  env?: NodeJS.ProcessEnv
}): Promise<CompactionOutcome> {
  const env = options.env ?? process.env
  if (isCompactionDisabled(env)) throw new Error('压缩已被 DISABLE_COMPACT 关闭。')
  if (!hasCompleteExchange(options.history)) throw new Error('还没有足够的历史可以压缩。')
  const outcome = await compactHistory({
    history: options.history,
    system: options.system,
    llm: options.llm,
    model: options.model,
    reason: 'manual',
    settings: options.settings ?? loadCompactionSettings(env),
  })
  options.history.splice(0, options.history.length, ...outcome.messages)
  if (options.tracking) options.tracking.consecutiveFailures = 0
  return outcome
}

export function createBoundaryMessage(reason: CompactReason, beforeTokens: number): UserMessage {
  const label = reason === 'auto' ? '自动压缩' : '手动压缩'
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `${COMPACT_BOUNDARY_PREFIX} ${label}：压缩前估算 ${beforeTokens} token。以下摘要替代了更早的对话，原文仍保存在会话记录里。`,
      },
    ],
  }
}

export function createSummaryMessage(summary: string): UserMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}`,
      },
    ],
  }
}

/**
 * Drops <analysis> drafting and keeps the <summary> body. Falls back to the
 * remaining text when the model did not emit tags.
 */
export function formatCompactSummary(raw: string): string {
  let text = raw.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (match) {
    text = text.replace(/<summary>[\s\S]*?<\/summary>/i, `Summary:\n${(match[1] ?? '').trim()}`)
  }
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/** Drops the oldest user-turn group. Returns null when nothing useful is left. */
export function dropOldestGroup(messages: Message[]): Message[] | null {
  const groups = groupByUserTurn(stripRetryMarker(messages))
  if (groups.length < 2) return null
  const rest = groups.slice(1).flat()
  if (rest[0]?.role === 'assistant') return [retryMarkerMessage(), ...rest]
  return rest
}

async function requestSummary(
  prefix: Message[],
  options: { system: string; llm: LlmClient; model?: string },
): Promise<string> {
  let messages = prefix.slice()
  let retries = 0

  for (;;) {
    let text: string
    try {
      const response = await options.llm.complete({
        system: options.system,
        messages: [
          ...messages,
          { role: 'user', content: [{ type: 'text', text: SUMMARY_PROMPT }] },
        ],
        // No tools: the model may only return text.
        tools: [],
        model: options.model,
      })
      text = textOf(response)
    } catch (error) {
      const message = messageOf(error)
      if (!isPromptTooLongError(message)) throw error
      text = message
    }

    if (isPromptTooLongError(text)) {
      const next = retries < MAX_PTL_RETRIES ? dropOldestGroup(messages) : null
      if (!next) throw new Error('压缩失败：对话太长，摘要请求也被拒绝。')
      messages = next
      retries += 1
      continue
    }

    const summary = formatCompactSummary(text)
    if (!summary) throw new Error('压缩失败：模型没有返回摘要。')
    if (looksLikeApiError(summary)) throw new Error(summary)
    return summary
  }
}

function groupByUserTurn(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  let current: Message[] = []
  for (const message of messages) {
    if (isUserText(message) && current.length > 0) {
      groups.push(current)
      current = [message]
      continue
    }
    current.push(message)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

function stripRetryMarker(messages: Message[]): Message[] {
  const first = messages[0]
  if (first && isUserText(first) && textOf(first).trim() === PTL_RETRY_MARKER) return messages.slice(1)
  return messages
}

function retryMarkerMessage(): UserMessage {
  return { role: 'user', content: [{ type: 'text', text: PTL_RETRY_MARKER }] }
}

function lastUserTextIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    // A previous boundary/summary is synthetic context, not a real user turn:
    // a second compaction must absorb it instead of preserving it as the tail.
    if (message && isUserText(message) && !isSyntheticCompactionMessage(message)) return index
  }
  return -1
}

function isSyntheticCompactionMessage(message: Message): boolean {
  if (message.role !== 'user') return false
  const text = textOf(message).trim()
  return (
    text.startsWith(COMPACT_BOUNDARY_PREFIX) ||
    text.startsWith('This session is being continued from a previous conversation that ran out of context.')
  )
}

function isUserText(message: Message): boolean {
  if (message.role !== 'user') return false
  return message.content.some((block) => block.type === 'text' && block.text.trim() !== '')
}

function textOf(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function usageTotal(usage: TokenUsage): number {
  return usage.inputTokens + (usage.outputTokens ?? 0)
}

function stripStaleUsage(message: Message): Message {
  if (message.role !== 'assistant' || message.usage === undefined) return message
  return { role: 'assistant', content: message.content }
}

export function isPromptTooLongError(text: string): boolean {
  return /prompt is too long|prompt_too_long|context[_ ]length[_ ]exceeded|too many tokens|maximum context length|input is too long/i.test(
    text,
  )
}

function looksLikeApiError(text: string): boolean {
  return /^(Anthropic API|OpenAI API|API Error)\b/.test(text.trim())
}

function envFlag(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`)
  return value
}

function safeJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return '[tool input]'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

const SUMMARY_PROMPT = `${NO_TOOLS_PREAMBLE}Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures, and file edits
   - Errors that you ran into and how you fixed them
   - Specific user feedback, especially when the user told you to do something differently
2. Double-check for technical accuracy and completeness.

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents in detail.
2. Key Technical Concepts: List the important technical concepts, technologies, APIs, and interfaces used.
3. Files and Code Sections: Enumerate the files read or changed, why each matters, and include the important snippets.
4. Errors and fixes: List every error you ran into and how you fixed it. Quote the user's corrections verbatim.
5. Pending Tasks: Outline the tasks that are still open.
6. Current Work and Next Step: Describe precisely what was being worked on immediately before this summary request, and the next step. The next step must stay within the user's most recent explicit request; do not reopen work that is already finished.

Wrap the final summary in <summary> tags. Write the summary in the language the user has been using in the conversation.

<example>
<analysis>
[Your thought process, covering every section above]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File name]
      - [Why it matters and what changed]
      - [Important snippet]

4. Errors and fixes:
   - [Error and fix]

5. Pending Tasks:
   - [Task]

6. Current Work and Next Step:
   [What was in progress and what comes next]
</summary>
</example>

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`
