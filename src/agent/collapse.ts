import { randomUUID } from 'node:crypto'
import type { LlmClient, Message, UserMessage } from '../types.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  SUMMARY_OUTPUT_RESERVE,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  formatCompactSummary,
} from './compact.js'

/**
 * Context collapse, the read-time alternative to compaction.
 *
 * Older completed turns are summarized into commits. The REPL history is never
 * rewritten: every request projects a view in which committed spans become
 * `<collapsed id="...">` placeholders, so the original messages survive and the
 * projection can be rebuilt on every turn.
 *
 * This is a deliberately smaller design than the one in the reference source
 * (whose contextCollapse modules are not part of the published package):
 * no staged queue, no background summarizer agent, no cross-process restore.
 */

export const COLLAPSE_START_RATIO = 0.9
export const COLLAPSE_HARD_RATIO = 0.95
export const COLLAPSE_TARGET_RATIO = 0.8
export const COLLAPSE_KEEP_TURNS = 1
export const MAX_COLLAPSE_FAILURES = 3
export const MAX_COMMITS_PER_RUN = 4
/** Keep one summary request below this share of the raw window. */
export const MAX_SPAN_RATIO = 0.35

export type CollapseReason = 'auto' | 'manual' | 'overflow'

export interface CollapseSettings {
  contextWindow: number
  summaryReserve: number
  startRatio: number
  hardRatio: number
  targetRatio: number
  keepTurns: number
}

export interface CollapseCommit {
  /** `c1`, `c2`, ... in commit order. */
  id: string
  /** Inclusive indices into the history array at commit time. */
  firstIndex: number
  lastIndex: number
  /** Stable message ids, mirroring the source's archived-span UUIDs. */
  firstMessageId: string
  lastMessageId: string
  summary: string
  tokensBefore: number
  tokensAfter: number
  turns: number
  createdAt: string
}

/** Per-session collapse state. Kept by the CLI and each web session. */
export interface CollapseStore {
  commits: CollapseCommit[]
  nextId: number
  /** Bumped on every commit; a response made before it holds stale usage. */
  version: number
  responseVersion: number
  consecutiveFailures: number
}

export interface CollapseOutcome {
  commits: CollapseCommit[]
  before: number
  after: number
  messages: Message[]
  /** Overflow mode only: still above the hard limit after every safe span. */
  exhausted: boolean
}

export interface CollapseOptions {
  history: Message[]
  system: string
  llm: LlmClient
  model?: string
  store: CollapseStore
  settings?: CollapseSettings
  mode: CollapseReason
  keepTurns?: number
  maxCommits?: number
  onCommit?: (commit: CollapseCommit) => void | Promise<void>
  onStart?: (reason: CollapseReason) => void
}

export function createCollapseStore(): CollapseStore {
  return { commits: [], nextId: 1, version: 0, responseVersion: 0, consecutiveFailures: 0 }
}

export function loadCollapseSettings(env: NodeJS.ProcessEnv = process.env): CollapseSettings {
  return {
    contextWindow: positiveInteger(env.AGENT_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW, 'AGENT_CONTEXT_WINDOW'),
    summaryReserve: SUMMARY_OUTPUT_RESERVE,
    startRatio: COLLAPSE_START_RATIO,
    hardRatio: COLLAPSE_HARD_RATIO,
    targetRatio: COLLAPSE_TARGET_RATIO,
    keepTurns: COLLAPSE_KEEP_TURNS,
  }
}

export function isContextCollapseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !envFlag(env.DISABLE_COLLAPSE) && envFlag(env.AGENT_CONTEXT_COLLAPSE)
}

export function effectiveCollapseWindow(settings: CollapseSettings): number {
  return settings.contextWindow - settings.summaryReserve
}

export function collapseStartTokens(settings: CollapseSettings): number {
  return Math.floor(effectiveCollapseWindow(settings) * settings.startRatio)
}

export function collapseHardTokens(settings: CollapseSettings): number {
  return Math.floor(effectiveCollapseWindow(settings) * settings.hardRatio)
}

export function collapseTargetTokens(settings: CollapseSettings): number {
  return Math.floor(effectiveCollapseWindow(settings) * settings.targetRatio)
}

/** Project the collapsed view: committed spans become placeholder messages. */
export function projectView(history: Message[], commits: CollapseCommit[]): Message[] {
  if (commits.length === 0) return history
  const ordered = [...commits].sort((a, b) => a.firstIndex - b.firstIndex)
  const view: Message[] = []
  let cursor = 0
  for (const commit of ordered) {
    if (commit.firstIndex < cursor || commit.lastIndex < commit.firstIndex) continue
    // A commit that runs past the end of the array belongs to a history that was
    // replaced (e.g. by compaction), so it cannot be projected any more.
    if (commit.firstIndex >= history.length || commit.lastIndex >= history.length) continue
    view.push(...history.slice(cursor, commit.firstIndex))
    view.push(collapsePlaceholder(commit))
    cursor = Math.min(commit.lastIndex + 1, history.length)
  }
  view.push(...history.slice(cursor))
  return view
}

export function collapsePlaceholder(commit: Pick<CollapseCommit, 'id' | 'summary'>): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: `<collapsed id="${commit.id}">\n${commit.summary}\n</collapsed>` }],
  }
}

/**
 * Usage from the last response describes the view that was current when it was
 * produced. After a commit that view no longer exists, so fall back to chars.
 */
export function estimateProjectedTokens(history: Message[], store: CollapseStore): number {
  const view = projectView(history, store.commits)
  if (store.version !== store.responseVersion) return estimateMessagesTokens(view)
  return estimateTokens(view)
}

export function noteCollapseResponse(store: CollapseStore): void {
  store.responseVersion = store.version
}

export function resetCollapseStore(store: CollapseStore): void {
  store.commits.length = 0
  store.nextId = 1
  store.version = 0
  store.responseVersion = 0
  store.consecutiveFailures = 0
}

export function getCollapseStats(store: CollapseStore): {
  commits: number
  messages: number
  savedTokens: number
} {
  return {
    commits: store.commits.length,
    messages: store.commits.reduce((total, commit) => total + (commit.lastIndex - commit.firstIndex + 1), 0),
    savedTokens: store.commits.reduce((total, commit) => total + Math.max(0, commit.tokensBefore - commit.tokensAfter), 0),
  }
}

export interface SpanPlan {
  start: number
  end: number
  turns: number
}

/**
 * The next span to summarize: the oldest completed turns that are not yet
 * committed, capped in size and leaving `keepTurns` recent closed turns raw.
 * Spans always end at a turn boundary, so a tool_use is never split from its
 * tool_result.
 */
export function planNextSpan(
  history: Message[],
  store: CollapseStore,
  settings: CollapseSettings,
  keepTurns = settings.keepTurns,
): SpanPlan | null {
  const starts = userTurnStarts(history)
  if (starts.length < 2) return null
  const completed = starts.slice(0, -1)
  const currentTurnStart = starts[starts.length - 1]!
  const lastCommittedEnd = store.commits.at(-1)?.lastIndex ?? -1
  const first = completed.findIndex((start) => start > lastCommittedEnd)
  if (first < 0) return null
  const allowed = completed.length - Math.max(0, keepTurns)
  if (first >= allowed) return null

  const maxTokens = Math.max(2_000, Math.floor(settings.contextWindow * MAX_SPAN_RATIO))
  let last = first
  let tokens = 0
  for (let index = first; index < allowed; index += 1) {
    const start = completed[index]!
    const next = completed[index + 1] ?? currentTurnStart
    const turnTokens = estimateMessagesTokens(history.slice(start, next))
    if (index > first && tokens + turnTokens > maxTokens) break
    tokens += turnTokens
    last = index
  }
  const next = completed[last + 1] ?? currentTurnStart
  return { start: completed[first]!, end: next - 1, turns: last - first + 1 }
}

export async function collapseIfNeeded(options: CollapseOptions): Promise<CollapseOutcome | null> {
  const settings = options.settings ?? loadCollapseSettings()
  const store = options.store
  const mode = options.mode
  const maxCommits = options.maxCommits ?? MAX_COMMITS_PER_RUN
  const start = collapseStartTokens(settings)
  const hard = collapseHardTokens(settings)
  const target = collapseTargetTokens(settings)
  const before = estimateProjectedTokens(options.history, store)
  // At the hard limit even the most recent closed turn stops being protected,
  // mirroring the source's 90% commit / 95% blocking-spawn ladder.
  const keepTurns =
    options.keepTurns ??
    (mode === 'auto' ? (before >= hard ? 0 : settings.keepTurns) : 0)

  if (mode === 'auto') {
    if (store.consecutiveFailures >= MAX_COLLAPSE_FAILURES) return null
    if (before < start) return null
  }

  const commits: CollapseCommit[] = []
  let started = false

  for (let index = 0; index < maxCommits; index += 1) {
    const tokens = estimateProjectedTokens(options.history, store)
    // Automatic and manual collapse aim for the 80% target: one pass should
    // leave enough headroom that the next turns do not trigger again.
    if (mode !== 'overflow' && commits.length > 0 && tokens < target) break
    // Overflow is only reached after a real 413, so always drain at least one
    // span even if the character estimate disagrees with the API.
    if (mode === 'overflow' && commits.length > 0 && tokens < hard) break

    const plan = planNextSpan(options.history, store, settings, keepTurns)
    if (!plan) break

    if (!started) {
      started = true
      options.onStart?.(mode)
    }

    ensureMessageIds(options.history)
    const span = options.history.slice(plan.start, plan.end + 1)
    let summary: string
    try {
      summary = await summarizeSpan(span, options)
    } catch (error) {
      store.consecutiveFailures += 1
      throw error
    }

    const commit: CollapseCommit = {
      id: `c${store.nextId}`,
      firstIndex: plan.start,
      lastIndex: plan.end,
      firstMessageId: span[0]?.id ?? '',
      lastMessageId: span[span.length - 1]?.id ?? '',
      summary,
      tokensBefore: estimateMessagesTokens(span),
      tokensAfter: 0,
      turns: plan.turns,
      createdAt: new Date().toISOString(),
    }
    commit.tokensAfter = estimateMessageTokens(collapsePlaceholder(commit))
    store.nextId += 1
    store.commits.push(commit)
    store.version += 1
    commits.push(commit)
    try {
      await options.onCommit?.(commit)
    } catch {
      // The transcript is an audit trail; failing to write it must not undo a
      // collapse that already happened in memory.
    }
  }

  if (commits.length === 0) return null
  store.consecutiveFailures = 0
  const messages = projectView(options.history, store.commits)
  const after = estimateProjectedTokens(options.history, store)
  return {
    commits,
    before,
    after,
    messages,
    exhausted: mode === 'overflow' && after >= hard,
  }
}

async function summarizeSpan(
  span: Message[],
  options: Pick<CollapseOptions, 'system' | 'llm' | 'model'>,
): Promise<string> {
  const response = await options.llm.complete({
    system: options.system,
    messages: [...span, { role: 'user', content: [{ type: 'text', text: COLLAPSE_PROMPT }] }],
    // No tools: the summarizer may only return text.
    tools: [],
    model: options.model,
  })
  const summary = formatCompactSummary(textOf(response))
  if (!summary) throw new Error('折叠失败：模型没有返回摘要。')
  return summary
}

export function ensureMessageIds(messages: Message[]): void {
  for (const message of messages) {
    if (!message.id) message.id = randomUUID()
  }
}

function userTurnStarts(messages: Message[]): number[] {
  const starts: number[] = []
  messages.forEach((message, index) => {
    if (message.role !== 'user') return
    if (message.content.some((block) => block.type === 'text' && block.text.trim() !== '')) starts.push(index)
  })
  return starts
}

function textOf(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
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

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Tool calls will be rejected and waste your only turn.
- You already have everything you need in the conversation above.

`

const COLLAPSE_PROMPT = `${NO_TOOLS_PREAMBLE}The conversation above is an older segment of a session that is still in progress. Write a compact summary that will replace those messages in the model's context.
Keep everything needed to continue the work: the user's requests, decisions and their reasons, files and paths touched, commands run, errors and fixes, and open tasks. Drop greetings, restated instructions, and raw file dumps.
Aim for at most 15% of the segment's length. Return only the summary text, with no preamble and no tags.`