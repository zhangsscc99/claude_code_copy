import type { Tool } from './types.js'

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypass'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export type PermissionAnswer = 'allow' | 'deny' | 'always'

export interface PermissionDecision {
  allowed: boolean
  reason: string
}

export type AskFn = (tool: Tool, input: Record<string, unknown>) => Promise<PermissionAnswer>

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value)
}

export class PermissionGate {
  private readonly always = new Set<string>()

  constructor(
    private mode: PermissionMode,
    private readonly ask: AskFn,
  ) {}

  getMode(): PermissionMode {
    return this.mode
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  async check(tool: Tool, input: Record<string, unknown>): Promise<PermissionDecision> {
    if (this.mode === 'bypass') {
      return { allowed: true, reason: 'bypass' }
    }
    if (this.mode === 'plan' && tool.kind !== 'read') {
      return {
        allowed: false,
        reason: `Plan mode only allows read-only tools. ${tool.name} was blocked.`,
      }
    }
    if (tool.kind === 'read') {
      return { allowed: true, reason: 'read' }
    }
    if (this.mode === 'acceptEdits' && tool.kind === 'edit') {
      return { allowed: true, reason: 'acceptEdits' }
    }
    if (this.always.has(tool.name)) {
      return { allowed: true, reason: 'always' }
    }
    const answer = await this.ask(tool, input)
    if (answer === 'always') {
      this.always.add(tool.name)
      return { allowed: true, reason: 'always' }
    }
    if (answer === 'allow') {
      return { allowed: true, reason: 'allow' }
    }
    return { allowed: false, reason: `Permission denied for ${tool.name}.` }
  }
}
