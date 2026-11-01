import path from 'node:path'
import type { Tool } from './types.js'
import { checkBashCommand } from './permissions/bash.js'
import type { AutoClassifier } from './permissions/classify.js'
import { isPermissionMode, normalizePermissionMode, PERMISSION_MODES, type PermissionMode } from './permissions/modes.js'
import { checkReadPath, checkWritePath, workspaceRoot } from './permissions/paths.js'
import { bashSaveRule, canonicalToolName, parseRule, rulesFor, type CanonicalTool, type PermissionRule } from './permissions/rules.js'
import { appendLocalAllow } from './permissions/settings.js'

export { PERMISSION_MODES, isPermissionMode, normalizePermissionMode }
export type { PermissionMode }

export type PermissionAnswer = 'once' | 'session' | 'local' | 'deny'

export interface PermissionDecision {
  allowed: boolean
  reason: string
}

export interface AskDetail {
  reason: string
  saveRule: string
}

export type AskFn = (tool: Tool, input: Record<string, unknown>, detail: AskDetail) => Promise<PermissionAnswer>

const READ_TOOLS = new Set<CanonicalTool>(['Read', 'Glob', 'Grep'])
const DENIAL_LIMITS = { consecutive: 3, total: 20 }

export interface GateOptions {
  cwd?: string
  rules?: PermissionRule[]
  autoAllow?: string[]
  autoSoftDeny?: string[]
  classifier?: AutoClassifier
  canPrompt?: boolean
}

export class PermissionGate {
  private mode: PermissionMode
  private readonly rules: PermissionRule[]
  private readonly cwd: string
  private readonly autoAllow: string[]
  private readonly autoSoftDeny: string[]
  private readonly classifier?: AutoClassifier
  private readonly canPrompt: boolean
  private transcript = ''
  private consecutiveDenials = 0
  private totalDenials = 0

  constructor(
    mode: string,
    private readonly ask: AskFn,
    options: GateOptions = {},
  ) {
    const normalized = normalizePermissionMode(mode)
    if (!normalized) throw new Error(`未知权限模式 ${mode}`)
    this.mode = normalized
    this.rules = options.rules ?? []
    this.cwd = options.cwd ?? process.cwd()
    this.autoAllow = options.autoAllow ?? []
    this.autoSoftDeny = options.autoSoftDeny ?? []
    this.classifier = options.classifier
    this.canPrompt = options.canPrompt ?? true
  }

  getMode(): PermissionMode {
    return this.mode
  }

  setMode(mode: string): void {
    const normalized = normalizePermissionMode(mode)
    if (!normalized) throw new Error(`未知权限模式 ${mode}`)
    this.mode = normalized
  }

  setTranscript(transcript: string): void {
    this.transcript = transcript
  }

  async check(tool: Tool, input: Record<string, unknown>): Promise<PermissionDecision> {
    const name = canonicalToolName(tool.name)
    if (!name) return this.finishAsk(tool, input, { behavior: 'ask', reason: `未知工具 ${tool.name}`, saveRule: tool.name, askRule: true })
    if (rulesFor(this.rules, name, 'deny').some((rule) => rule.content === undefined)) {
      return blocked(`整类工具被拒绝：${name}`)
    }
    if (rulesFor(this.rules, name, 'ask').some((rule) => rule.content === undefined)) {
      return this.finishAsk(tool, input, { behavior: 'ask', reason: `整类工具需要确认：${name}`, saveRule: name, askRule: true, forcePrompt: true })
    }
    if (this.mode === 'plan' && !READ_TOOLS.has(name)) {
      return blocked(`Plan mode only allows read-only tools. ${name} was blocked.`)
    }

    const inspected = await this.inspect(name, input)
    if (this.mode === 'plan') {
      return inspected.behavior === 'allow' ? allowed(inspected.reason) : blocked(inspected.reason || 'Plan mode blocks this read.')
    }
    if (inspected.behavior === 'deny') return blocked(inspected.reason)
    if (inspected.behavior === 'allow') return allowed(inspected.reason)
    if (inspected.safety || inspected.askRule) {
      return this.finishAsk(tool, input, { ...inspected, forcePrompt: false })
    }
    if (this.mode === 'bypassPermissions') return allowed('bypassPermissions')
    return this.finishAsk(tool, input, { ...inspected, forcePrompt: false })
  }

  private async inspect(name: CanonicalTool, input: Record<string, unknown>): Promise<Inspected> {
    if (name === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : ''
      const decision = await checkBashCommand({ cwd: this.cwd, command, rules: this.rules, mode: this.mode === 'auto' ? 'default' : this.mode })
      return { ...decision, saveRule: bashSaveRule(command) }
    }
    const filePath = fileInput(name, input)
    const checker = READ_TOOLS.has(name) ? checkReadPath : checkWritePath
    const decision = await checker({
      cwd: this.cwd,
      inputPath: filePath,
      tool: name,
      rules: this.rules,
      mode: this.mode === 'auto' || this.mode === 'dontAsk' || this.mode === 'bypassPermissions' ? 'default' : this.mode,
    })
    const root = await workspaceRoot(this.cwd).catch(() => this.cwd)
    const absolute = path.resolve(this.cwd, filePath || '.')
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    const shown = relative.startsWith('..') ? absolute : relative
    return { ...decision, saveRule: `${name}(${shown})` }
  }

  private async finishAsk(tool: Tool, input: Record<string, unknown>, inspected: Inspected & { forcePrompt?: boolean }): Promise<PermissionDecision> {
    if (this.mode === 'dontAsk') return blocked(`dontAsk 拒绝了需要确认的操作：${inspected.reason}`)
    if (this.mode === 'auto' && !inspected.forcePrompt && inspected.safety !== 'windows') {
      return this.autoDecide(tool, input, inspected)
    }
    if (!this.canPrompt) {
      return blocked(`非交互模式已拒绝 ${tool.name}。需要规则、acceptEdits、auto 或 bypassPermissions。${inspected.reason}`)
    }
    const answer = normalizeAnswer(await this.ask(tool, input, { reason: inspected.reason, saveRule: inspected.saveRule }))
    if (answer === 'deny') return blocked(`Permission denied for ${tool.name}.`)
    this.consecutiveDenials = 0
    if (answer === 'session') this.remember(inspected.saveRule)
    if (answer === 'local' && await appendLocalAllow(this.cwd, inspected.saveRule)) this.remember(inspected.saveRule)
    return allowed(answer === 'local' ? `已处理本地设置：${inspected.saveRule}` : inspected.reason)
  }

  private async autoDecide(tool: Tool, input: Record<string, unknown>, inspected: Inspected): Promise<PermissionDecision> {
    const name = canonicalToolName(tool.name)
    if (name && (name === 'Write' || name === 'Edit' || name === 'Bash')) {
      const asAccept = await this.inspectAsAcceptEdits(name, input)
      if (asAccept.behavior === 'allow') {
        this.consecutiveDenials = 0
        return allowed('auto 按 acceptEdits 放行。')
      }
    }
    if (name && READ_TOOLS.has(name)) {
      this.consecutiveDenials = 0
      return allowed('auto 放行读取和搜索。')
    }
    const result = this.classifier
      ? await this.classifier({
        transcript: this.transcript,
        toolName: name ?? tool.name,
        input,
        allow: this.autoAllow,
        softDeny: this.autoSoftDeny,
      })
      : { decision: 'unavailable' as const }
    if (result.decision === 'too_long') {
      return this.canPrompt
        ? this.promptOnly(tool, input, '分类器的对话记录过长，改为提问。', inspected.saveRule)
        : blocked('分类器的对话记录过长，非交互模式已拒绝。')
    }
    if (result.decision === 'unavailable') return blocked('auto 分类器没有返回结果，已拒绝。')
    if (result.decision === 'allow') {
      this.consecutiveDenials = 0
      return allowed(`auto 分类器允许：${result.reason}`)
    }
    this.consecutiveDenials += 1
    this.totalDenials += 1
    if (this.consecutiveDenials >= DENIAL_LIMITS.consecutive || this.totalDenials >= DENIAL_LIMITS.total) {
      return this.promptOnly(tool, input, `分类器已连续或累计拒绝多次：${result.reason}`, inspected.saveRule)
    }
    return blocked(`auto 分类器拒绝了这次操作：${result.reason}`)
  }

  private async inspectAsAcceptEdits(name: CanonicalTool, input: Record<string, unknown>): Promise<Inspected> {
    const saved = this.mode
    this.mode = 'acceptEdits'
    try {
      return await this.inspect(name, input)
    } finally {
      this.mode = saved
    }
  }

  private async promptOnly(tool: Tool, input: Record<string, unknown>, reason: string, saveRule: string): Promise<PermissionDecision> {
    if (!this.canPrompt) return blocked(`${reason} 非交互模式已拒绝。`)
    const answer = normalizeAnswer(await this.ask(tool, input, { reason, saveRule }))
    if (answer === 'deny') return blocked(`Permission denied for ${tool.name}.`)
    this.consecutiveDenials = 0
    if (answer === 'session') this.remember(saveRule)
    if (answer === 'local' && await appendLocalAllow(this.cwd, saveRule)) this.remember(saveRule)
    return allowed(reason)
  }

  private remember(spec: string): void {
    this.rules.push(parseRule(spec, 'allow', 'session'))
  }
}

interface Inspected {
  behavior: 'allow' | 'deny' | 'ask'
  reason: string
  safety?: 'windows' | 'sensitive'
  askRule: boolean
  saveRule: string
}

function fileInput(name: CanonicalTool, input: Record<string, unknown>): string {
  if (typeof input.path === 'string' && input.path.length > 0) return input.path
  if (name === 'Glob' || name === 'Grep' || name === 'Read') return '.'
  return ''
}

function allowed(reason: string): PermissionDecision {
  return { allowed: true, reason }
}

function blocked(reason: string): PermissionDecision {
  return { allowed: false, reason }
}

export function normalizeAnswer(value: string): PermissionAnswer {
  const answer = value.trim().toLowerCase()
  if (answer === 'once' || answer === '1' || answer === 'y' || answer === 'yes' || answer === 'allow') return 'once'
  if (answer === 'session' || answer === '2' || answer === 'always') return 'session'
  if (answer === 'local' || answer === '3') return 'local'
  return 'deny'
}
