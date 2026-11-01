import path from 'node:path'
import { checkWritePath, isInsideWorkspace, workspaceRoot, type PathDecision } from './paths.js'
import { bashSegmentMatches, rulesFor, type PermissionRule } from './rules.js'
import type { PermissionMode } from './modes.js'

export interface BashDecision {
  behavior: 'allow' | 'deny' | 'ask'
  reason: string
  safety?: 'windows' | 'sensitive'
  askRule: boolean
}

export async function checkBashCommand(options: {
  cwd: string
  command: string
  rules: PermissionRule[]
  mode: PermissionMode
}): Promise<BashDecision> {
  const command = options.command.trim()
  if (hasUnbalancedQuotes(command) || hasSubstitution(command)) {
    const exactDeny = rulesFor(options.rules, 'Bash', 'deny').find((rule) => rule.content === command)
    if (exactDeny) return { behavior: 'deny', reason: `命令被规则拒绝：${exactDeny.raw}`, askRule: false }
    return { behavior: 'ask', reason: '命令含有替换、进程替换，或引号不完整。', askRule: false }
  }

  const segments = splitSegments(command)
  let safety: BashDecision['safety']
  let askRule = false
  let sawAsk = false
  for (const segment of segments) {
    const { command: bare, targets } = stripRedirects(segment)
    const segmentDecision = matchSegment(bare, options.rules)
    if (segmentDecision === 'deny') return { behavior: 'deny', reason: `命令段被拒绝：${bare}`, askRule: false }
    if (segmentDecision === 'ask') sawAsk = true
    if (segmentDecision === 'ask-rule') {
      sawAsk = true
      askRule = true
    }
    const root = await workspaceRoot(options.cwd)
    if (cdLeavesWorkspace(bare, root)) {
      sawAsk = true
    }
    for (const target of targets) {
      const write = await checkWritePath({
        cwd: options.cwd,
        inputPath: target,
        tool: 'Write',
        rules: options.rules,
        mode: options.mode,
      })
      const redirected = redirectDecision(write)
      if (redirected.behavior === 'deny') return { behavior: 'deny', reason: redirected.reason, askRule: false }
      if (redirected.behavior === 'ask') {
        sawAsk = true
        safety = redirected.safety ?? safety
        askRule = askRule || redirected.askRule
      }
    }
  }
  if (sawAsk) {
    return { behavior: 'ask', reason: '命令需要确认。', safety, askRule }
  }
  return { behavior: 'allow', reason: '命令的每一段都被允许。', askRule: false }
}

function matchSegment(segment: string, rules: PermissionRule[]): 'allow' | 'deny' | 'ask' | 'ask-rule' {
  const ordered: Array<['deny' | 'ask' | 'allow', boolean]> = [
    ['deny', false],
    ['deny', true],
    ['ask', false],
    ['ask', true],
    ['allow', false],
    ['allow', true],
  ]
  for (const [behavior, prefix] of ordered) {
    const hit = rulesFor(rules, 'Bash', behavior).find((rule) => {
      const isPrefix = rule.content?.endsWith(':*') === true
      if (isPrefix !== prefix) return false
      return bashSegmentMatches(rule.content, segment)
    })
    if (hit) return behavior === 'ask' ? (hit.content === undefined ? 'ask' : 'ask-rule') : behavior
  }
  return 'ask'
}

function redirectDecision(write: PathDecision): BashDecision {
  if (write.behavior === 'allow') return { behavior: 'allow', reason: write.reason, askRule: false }
  if (write.behavior === 'deny') return { behavior: 'deny', reason: write.reason, askRule: false }
  if (write.safety || write.askRule || write.outsideWorkspace) {
    return { behavior: 'ask', reason: write.reason, safety: write.safety, askRule: write.askRule }
  }
  return { behavior: 'allow', reason: '重定向目标在工作目录内。', askRule: false }
}

function cdLeavesWorkspace(segment: string, root: string): boolean {
  const tokens = segment.trim().split(/\s+/)
  if (tokens[0] !== 'cd' || !tokens[1]) return false
  const target = path.resolve(root, tokens[1])
  return !isInsideWorkspace(root, target)
}

export function splitSegments(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''
    if (quote) {
      current += char
      if (char === quote && !escaped(command, index)) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (command.startsWith('&&', index) || command.startsWith('||', index)) {
      parts.push(current)
      current = ''
      index += 1
      continue
    }
    if (char === ';' || char === '\n' || char === '|' || (char === '&' && !isRedirectAmpersand(command, index))) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

function stripRedirects(segment: string): { command: string; targets: string[] } {
  const targets: string[] = []
  let command = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] ?? ''
    if (quote) {
      command += char
      if (char === quote && !escaped(segment, index)) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      command += char
      continue
    }
    if (char === '>' && !isRedirectAmpersand(segment, index)) {
      if (segment[index + 1] === '>') index += 1
      const target = readTarget(segment, index + 1)
      if (target.value) targets.push(target.value)
      index = target.next - 1
      continue
    }
    command += char
  }
  return { command: command.trim(), targets }
}

function readTarget(input: string, start: number): { value: string; next: number } {
  let index = start
  while (input[index] === ' ' || input[index] === '\t') index += 1
  const quote = input[index]
  if (quote === '"' || quote === "'") {
    const end = input.indexOf(quote, index + 1)
    if (end === -1) return { value: input.slice(index + 1), next: input.length }
    return { value: input.slice(index + 1, end), next: end + 1 }
  }
  const matched = /^[^\s;|&]+/.exec(input.slice(index))
  return { value: matched?.[0] ?? '', next: index + (matched?.[0].length ?? 0) }
}

function hasUnbalancedQuotes(command: string): boolean {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if ((char === '"' || char === "'") && !escaped(command, index)) {
      quote = quote === char ? null : quote ?? char
    }
  }
  return quote !== null
}

function hasSubstitution(command: string): boolean {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''
    if (char === "'" && !escaped(command, index)) {
      quote = quote === "'" ? null : quote ?? "'"
      continue
    }
    if (char === '"' && !escaped(command, index) && quote !== "'") {
      quote = quote === '"' ? null : '"'
      continue
    }
    if (quote === "'") continue
    if (char === '`' || command.startsWith('$(', index) || command.startsWith('<(', index) || command.startsWith('>(', index)) {
      return true
    }
  }
  return false
}

function escaped(input: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && input[cursor] === '\\'; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

function isRedirectAmpersand(input: string, index: number): boolean {
  return input[index - 1] === '>' || input[index + 1] === '>'
}
