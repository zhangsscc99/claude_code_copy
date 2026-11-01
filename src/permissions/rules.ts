import path from 'node:path'
import { matchGlob } from '../tools/workspace.js'

export const CANONICAL_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const
export type CanonicalTool = (typeof CANONICAL_TOOLS)[number]
export type RuleBehavior = 'allow' | 'deny' | 'ask'
export type RuleSource = 'user' | 'project' | 'local' | 'session' | 'cli'

export interface PermissionRule {
  tool: CanonicalTool
  content?: string
  behavior: RuleBehavior
  source: RuleSource
  raw: string
}

const TOOL_ALIASES: Record<string, CanonicalTool> = {
  read: 'Read',
  read_file: 'Read',
  write: 'Write',
  write_file: 'Write',
  edit: 'Edit',
  edit_file: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
}

export function canonicalToolName(name: string): CanonicalTool | undefined {
  return TOOL_ALIASES[name.trim().toLowerCase()]
}

export function parseRule(spec: string, behavior: RuleBehavior, source: RuleSource, file = ''): PermissionRule {
  const trimmed = spec.trim()
  const match = /^([A-Za-z0-9_]+)(?:\((.*)\))?$/.exec(trimmed)
  const tool = match ? canonicalToolName(match[1] ?? '') : undefined
  if (!match || !tool) {
    throw new Error(`无法解析权限规则 ${JSON.stringify(spec)}${file ? `（${file}）` : ''}`)
  }
  const inside = match[2]
  const content = inside === undefined || inside.trim() === '' || inside.trim() === '*' ? undefined : inside.trim()
  return { tool, content, behavior, source, raw: trimmed }
}

export function pathMatchesRule(content: string | undefined, absolutePath: string, root: string): boolean {
  if (content === undefined) return true
  const pattern = content.replaceAll('\\', '/').toLowerCase()
  const absolute = absolutePath.replaceAll('\\', '/').toLowerCase()
  const relative = path.relative(root, absolutePath).split(path.sep).join('/').toLowerCase()
  return matchGlob(relative, pattern) || matchGlob(absolute, pattern)
}

export function bashSegmentMatches(content: string | undefined, segment: string): boolean {
  if (content === undefined) return true
  const command = segment.trim()
  if (content.endsWith(':*')) {
    const prefix = content.slice(0, -2).trim()
    if (!prefix) return true
    return command === prefix || command.startsWith(`${prefix} `) || command.startsWith(`${prefix}\t`)
  }
  return command === content.trim()
}

export function rulesFor(
  rules: PermissionRule[],
  tool: CanonicalTool,
  behavior: RuleBehavior,
  source?: RuleSource,
): PermissionRule[] {
  return rules.filter((rule) => rule.tool === tool && rule.behavior === behavior && (source === undefined || rule.source === source))
}

export function bashSaveRule(command: string): string {
  const stripped = stripLeadingAssignments(command.trim())
  const tokens = stripped.split(/\s+/).filter(Boolean)
  const second = tokens[1]
  if (tokens.length >= 2 && second && /^[a-z][a-z0-9-]*$/.test(second)) {
    return `Bash(${tokens[0]} ${second}:*)`
  }
  return `Bash(${stripped})`
}

function stripLeadingAssignments(command: string): string {
  const tokens = command.split(/\s+/)
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index] ?? '')) index += 1
  return tokens.slice(index).join(' ')
}
