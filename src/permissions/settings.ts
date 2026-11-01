import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { normalizePermissionMode, type PermissionMode } from './modes.js'
import { parseRule, type PermissionRule } from './rules.js'

export interface LoadedSettings {
  rules: PermissionRule[]
  defaultMode?: PermissionMode
  disableBypass: boolean
  disableAuto: boolean
  autoAllow: string[]
  autoSoftDeny: string[]
}

export function loadPermissionSettings(cwd: string, home = homedir()): LoadedSettings {
  const loaded: LoadedSettings = { rules: [], disableBypass: false, disableAuto: false, autoAllow: [], autoSoftDeny: [] }
  const files = [
    { file: path.join(home, '.ccc', 'settings.json'), source: 'user' as const, trusted: true },
    { file: path.join(cwd, '.ccc', 'settings.json'), source: 'project' as const, trusted: false },
    { file: path.join(cwd, '.ccc', 'settings.local.json'), source: 'local' as const, trusted: true },
  ]
  for (const entry of files) {
    if (!existsSync(entry.file)) continue
    const parsed = parseJson(entry.file)
    const permissions = record(parsed.permissions)
    for (const behavior of ['deny', 'ask', 'allow'] as const) {
      for (const spec of stringList(permissions[behavior])) {
        loaded.rules.push(parseRule(spec, behavior, entry.source, entry.file))
      }
    }
    const mode = permissions.defaultMode
    if (typeof mode === 'string') {
      const normalized = normalizePermissionMode(mode)
      if (!normalized) throw new Error(`无法解析 defaultMode ${JSON.stringify(mode)}（${entry.file}）`)
      loaded.defaultMode = normalized
    }
    if (!entry.trusted) continue
    if (permissions.disableBypassPermissionsMode === 'disable') loaded.disableBypass = true
    if (permissions.disableAutoMode === 'disable') loaded.disableAuto = true
    const autoMode = record(parsed.autoMode)
    loaded.autoAllow.push(...stringList(autoMode.allow))
    loaded.autoSoftDeny.push(...stringList(autoMode.soft_deny))
  }
  return loaded
}

export async function appendLocalAllow(cwd: string, spec: string): Promise<boolean> {
  if (spec.replaceAll('\\', '/').toLowerCase().includes('.ccc')) return false
  const file = path.join(cwd, '.ccc', 'settings.local.json')
  const parsed = existsSync(file) ? parseJson(file) : {}
  const permissions = record(parsed.permissions)
  const allow = stringList(permissions.allow)
  if (!allow.includes(spec)) allow.push(spec)
  permissions.allow = allow
  parsed.permissions = permissions
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`)
  return true
}

function parseJson(file: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`无法解析 ${file}：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`无法解析 ${file}：根必须是对象`)
  }
  return parsed as Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}
