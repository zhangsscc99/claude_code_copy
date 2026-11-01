import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathMatchesRule, rulesFor, type CanonicalTool, type PermissionRule } from './rules.js'
import type { PermissionMode } from './modes.js'

const DANGEROUS_DIRECTORIES = ['.git', '.vscode', '.idea', '.claude', '.ccc']
const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
]

export type SafetyFlag = 'windows' | 'sensitive'

export interface PathDecision {
  behavior: 'allow' | 'deny' | 'ask'
  reason: string
  safety?: SafetyFlag
  askRule: boolean
  outsideWorkspace: boolean
}

export async function workspaceRoot(cwd: string): Promise<string> {
  return realpath(cwd)
}

export function isSuspiciousWindowsPath(filePath: string): boolean {
  if (filePath.includes('::$DATA') || filePath.includes('...')) return true
  if (/^\\\\[?.]\\/.test(filePath) || /^\/\/[?.]\//.test(filePath)) return true
  const segments = filePath.split(/[/\\]/).filter(Boolean)
  for (const segment of segments) {
    if (segment.includes(':') && !/^[A-Za-z]:$/.test(segment)) return true
    if (/^[A-Za-z0-9]{1,6}~[0-9](?:\.[A-Za-z0-9]{1,3})?$/.test(segment)) return true
    if (segment.endsWith('.') || segment.endsWith(' ')) return true
  }
  return false
}

export async function pathCandidates(cwd: string, inputPath: string): Promise<string[]> {
  if (inputPath.startsWith('\\\\') || inputPath.startsWith('//')) return [inputPath]
  const root = await workspaceRoot(cwd)
  const absolute = path.resolve(root, inputPath)
  const found = [absolute]
  try {
    const real = await realpath(absolute)
    if (real !== absolute) found.push(real)
  } catch {
    // Missing files are checked by their resolved absolute path.
  }
  return found
}

export function isInsideWorkspace(root: string, candidate: string): boolean {
  if (candidate.startsWith('\\\\') || candidate.startsWith('//')) return false
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function isSensitivePath(filePath: string): boolean {
  const segments = filePath.split(/[/\\]/).filter(Boolean)
  for (const segment of segments) {
    if (DANGEROUS_DIRECTORIES.includes(segment.toLowerCase())) return true
  }
  const base = segments.at(-1)?.toLowerCase()
  return Boolean(base && DANGEROUS_FILES.includes(base))
}

export async function checkReadPath(options: {
  cwd: string
  inputPath: string
  tool: CanonicalTool
  rules: PermissionRule[]
  mode: PermissionMode
}): Promise<PathDecision> {
  const root = await workspaceRoot(options.cwd)
  const candidates = await pathCandidates(options.cwd, options.inputPath || '.')
  const suspicious = candidates.some((candidate) => isUnc(candidate) || isSuspiciousWindowsPath(candidate))
  if (suspicious) {
    return ask('Windows 可疑路径或 UNC 路径需要确认。', 'windows', false)
  }
  const denied = matching(options.rules, options.tool, 'deny', candidates, root)
  if (denied) return deny(`读取被规则拒绝：${denied.raw}`)
  const asked = matching(options.rules, options.tool, 'ask', candidates, root)
  if (asked) return ask(`读取需要确认：${asked.raw}`, undefined, false, true)
  for (const writeTool of ['Edit', 'Write'] as const) {
    const writeAllowed = await checkWritePath({ ...options, tool: writeTool })
    if (writeAllowed.behavior === 'allow') {
      return { behavior: 'allow', reason: '写权限包含读权限。', askRule: false, outsideWorkspace: false }
    }
  }
  const outside = candidates.some((candidate) => !isInsideWorkspace(root, candidate))
  if (!outside) return { behavior: 'allow', reason: '路径在工作目录内。', askRule: false, outsideWorkspace: false }
  const allowed = matching(options.rules, options.tool, 'allow', candidates, root)
  if (allowed) return { behavior: 'allow', reason: `读取被规则允许：${allowed.raw}`, askRule: false, outsideWorkspace: true }
  return ask('路径在工作目录外。', undefined, true)
}

export async function checkWritePath(options: {
  cwd: string
  inputPath: string
  tool: CanonicalTool
  rules: PermissionRule[]
  mode: PermissionMode
}): Promise<PathDecision> {
  const root = await workspaceRoot(options.cwd)
  const candidates = await pathCandidates(options.cwd, options.inputPath)
  const outside = candidates.some((candidate) => !isInsideWorkspace(root, candidate))
  const denied = matching(options.rules, options.tool, 'deny', candidates, root)
  if (denied) return deny(`写入被规则拒绝：${denied.raw}`)
  if (candidates.some((candidate) => isUnc(candidate) || isSuspiciousWindowsPath(candidate))) {
    return ask('Windows 可疑路径或 UNC 路径需要确认。', 'windows', outside)
  }
  if (candidates.some((candidate) => isSensitivePath(candidate))) {
    const relative = path.relative(root, candidates[0] ?? options.inputPath).split(path.sep).join('/')
    if (sessionOpensCcc(options.rules, options.tool, candidates, root)) {
      return { behavior: 'allow', reason: '本会话允许修改 .ccc。', askRule: false, outsideWorkspace: outside }
    }
    return ask(`敏感路径需要确认：${relative}`, 'sensitive', outside)
  }
  const asked = matching(options.rules, options.tool, 'ask', candidates, root)
  if (asked) return ask(`写入需要确认：${asked.raw}`, undefined, outside, true)
  if (options.mode === 'acceptEdits' && !outside) {
    return { behavior: 'allow', reason: 'acceptEdits 允许工作目录内的修改。', askRule: false, outsideWorkspace: false }
  }
  const allowed = matching(options.rules, options.tool, 'allow', candidates, root)
  if (allowed) return { behavior: 'allow', reason: `写入被规则允许：${allowed.raw}`, askRule: false, outsideWorkspace: outside }
  return ask(outside ? '路径在工作目录外。' : '修改文件需要确认。', undefined, outside)
}

function matching(
  rules: PermissionRule[],
  tool: CanonicalTool,
  behavior: 'allow' | 'deny' | 'ask',
  candidates: string[],
  root: string,
): PermissionRule | undefined {
  return rulesFor(rules, tool, behavior).find((rule) =>
    candidates.some((candidate) => pathMatchesRule(rule.content, candidate, root)),
  )
}

function sessionOpensCcc(rules: PermissionRule[], tool: CanonicalTool, candidates: string[], root: string): boolean {
  return rulesFor(rules, tool, 'allow', 'session').some((rule) => {
    const content = rule.content?.replaceAll('\\', '/') ?? ''
    return content.toLowerCase().includes('.ccc') && !content.includes('..')
      && candidates.some((candidate) => pathMatchesRule(rule.content, candidate, root))
  })
}

function ask(reason: string, safety: SafetyFlag | undefined, outsideWorkspace: boolean, askRule = false): PathDecision {
  return { behavior: 'ask', reason, safety, askRule, outsideWorkspace }
}

function deny(reason: string): PathDecision {
  return { behavior: 'deny', reason, askRule: false, outsideWorkspace: false }
}

function isUnc(filePath: string): boolean {
  return filePath.startsWith('\\\\') || filePath.startsWith('//')
}
