import { randomUUID } from 'node:crypto'
import { runAgent } from '../agent/loop.js'
import type { Config } from '../config.js'
import type { AutoClassifier } from '../permissions/classify.js'
import type { PermissionRule } from '../permissions/rules.js'
import { PermissionGate, type AskDetail, type PermissionAnswer, type PermissionMode } from '../permissions.js'
import type { LlmClient, Message, Tool } from '../types.js'

export interface PublicState {
  cwd: string
  model: string
  provider: string
  version: string
  permissionMode: PermissionMode
  busy: boolean
  timeline: TimelineItem[]
}

export type TimelineItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; preview: string; output: string; isError: boolean; pending: boolean }
  | { kind: 'permission'; id: string; name: string; preview: string; reason: string; saveRule: string; status: 'pending' | PermissionAnswer }
  | { kind: 'notice'; text: string }

export type SessionEvent =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool_start'; name: string; preview: string }
  | { type: 'tool_end'; name: string; preview: string; output: string; isError: boolean }
  | { type: 'permission'; id: string; name: string; preview: string; reason: string; saveRule: string }
  | { type: 'permission_resolved'; id: string; answer: PermissionAnswer }
  | { type: 'notice'; text: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'cleared' }

const PREVIEW_LIMIT = 160

export class WebSession {
  private readonly history: Message[] = []
  private readonly timeline: TimelineItem[] = []
  private readonly listeners = new Set<(event: SessionEvent) => void>()
  private readonly pending = new Map<string, (answer: PermissionAnswer) => void>()
  private readonly gate: PermissionGate
  private busy = false

  constructor(
    private readonly options: {
      config: Config
      tools: Tool[]
      llm: LlmClient
      system: string
      version: string
      rules?: PermissionRule[]
      autoAllow?: string[]
      autoSoftDeny?: string[]
      classifier?: AutoClassifier
    },
  ) {
    this.gate = new PermissionGate(options.config.permissionMode, (tool, input, detail) => this.requestPermission(tool, input, detail), {
      cwd: options.config.cwd,
      rules: options.rules,
      autoAllow: options.autoAllow,
      autoSoftDeny: options.autoSoftDeny,
      classifier: options.classifier,
      canPrompt: true,
    })
  }

  getState(): PublicState {
    return {
      cwd: this.options.config.cwd,
      model: this.options.config.model,
      provider: this.options.config.provider,
      version: this.options.version,
      permissionMode: this.gate.getMode(),
      busy: this.busy,
      timeline: this.timeline.map((item) => structuredClone(item)),
    }
  }

  isBusy(): boolean {
    return this.busy
  }

  setMode(mode: PermissionMode): void {
    this.gate.setMode(mode)
    this.options.config.permissionMode = mode
    this.emit({ type: 'mode', mode })
  }

  clear(): void {
    if (this.busy) throw new Error('正在处理上一条消息')
    this.history.length = 0
    this.timeline.length = 0
    this.emit({ type: 'cleared' })
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  answerPermission(id: string, answer: PermissionAnswer): boolean {
    const resolve = this.pending.get(id)
    if (!resolve) return false
    this.pending.delete(id)
    for (const item of this.timeline) {
      if (item.kind === 'permission' && item.id === id) {
        item.status = answer
        break
      }
    }
    this.emit({ type: 'permission_resolved', id, answer })
    resolve(answer)
    return true
  }

  send(text: string): Promise<void> {
    if (this.busy) throw new Error('正在处理上一条消息')
    if (text.trim() === '') throw new Error('消息是空的')
    this.busy = true
    this.emit({ type: 'busy', busy: true })
    this.timeline.push({ kind: 'user', text })
    this.emit({ type: 'user', text })
    return this.finishSend(text)
  }

  private async finishSend(text: string): Promise<void> {
    try {
      const result = await runAgent({
        history: this.history,
        userText: text,
        system: this.options.system,
        llm: this.options.llm,
        tools: this.options.tools,
        permissions: this.gate,
        maxTurns: this.options.config.maxTurns,
        cwd: this.options.config.cwd,
        model: this.options.config.model,
        hooks: {
          onAssistantText: (assistantText) => {
            this.timeline.push({ kind: 'assistant', text: assistantText })
            this.emit({ type: 'assistant', text: assistantText })
          },
          onToolStart: (name, input) => {
            const preview = previewFor(name, input)
            this.timeline.push({
              kind: 'tool',
              name,
              preview,
              output: '',
              isError: false,
              pending: true,
            })
            this.emit({ type: 'tool_start', name, preview })
          },
          onToolEnd: (name, output, isError) => {
            let preview = ''
            for (let index = this.timeline.length - 1; index >= 0; index -= 1) {
              const item = this.timeline[index]
              if (item && item.kind === 'tool' && item.pending) {
                item.output = output
                item.isError = isError
                item.pending = false
                preview = item.preview
                break
              }
            }
            this.emit({ type: 'tool_end', name, preview, output, isError })
          },
        },
      })
      if (result.stopReason === 'error') {
        this.pushNotice(result.error ?? '未知错误')
      } else if (result.stopReason === 'max_turns') {
        this.pushNotice(`达到最大轮数 ${this.options.config.maxTurns}`)
      }
    } catch (error) {
      this.pushNotice(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      this.busy = false
      this.emit({ type: 'busy', busy: false })
    }
  }

  private requestPermission(tool: Tool, input: Record<string, unknown>, detail?: AskDetail): Promise<PermissionAnswer> {
    const id = randomUUID()
    const preview = previewFor(tool.name, input)
    const reason = detail?.reason ?? '需要确认这个操作。'
    const saveRule = detail?.saveRule ?? tool.name
    this.timeline.push({
      kind: 'permission',
      id,
      name: tool.name,
      preview,
      reason,
      saveRule,
      status: 'pending',
    })
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.emit({ type: 'permission', id, name: tool.name, preview, reason, saveRule })
    })
  }

  private pushNotice(text: string): void {
    this.timeline.push({ kind: 'notice', text })
    this.emit({ type: 'notice', text })
  }

  private emit(event: SessionEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // One broken listener must not stop the turn or the other listeners.
      }
    }
  }
}

function previewFor(name: string, input: Record<string, unknown>): string {
  const selected = name === 'bash' ? input.command : name === 'grep' || name === 'glob' ? input.pattern : input.path
  const text = typeof selected === 'string' ? selected : stringifyInput(input)
  return text.length > PREVIEW_LIMIT ? text.slice(0, PREVIEW_LIMIT) : text
}

function stringifyInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return ''
  }
}
