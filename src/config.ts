import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { normalizePermissionMode, type PermissionMode } from './permissions.js'

export type Provider = 'anthropic' | 'openai'

export interface Config {
  provider: Provider
  apiKey: string
  baseUrl: string
  model: string
  maxTurns: number
  maxTokens: number
  permissionMode: PermissionMode
  cwd: string
}

export function loadDotEnv(cwd: string): void {
  const file = path.join(cwd, '.env')
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export function loadConfig(cwd: string): Config {
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? ''
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? ''
  const requested = process.env.AGENT_PROVIDER?.trim()
  let provider: Provider
  if (requested) {
    if (requested !== 'anthropic' && requested !== 'openai') {
      throw new Error('AGENT_PROVIDER 只能是 anthropic 或 openai')
    }
    provider = requested
  } else if (anthropicKey && openaiKey) {
    throw new Error('同时设置了 ANTHROPIC_API_KEY 和 OPENAI_API_KEY。请设置 AGENT_PROVIDER。')
  } else if (openaiKey) {
    provider = 'openai'
  } else {
    provider = 'anthropic'
  }

  const modeValue = normalizePermissionMode(process.env.AGENT_PERMISSION_MODE?.trim() || 'default')
  if (!modeValue) {
    throw new Error('AGENT_PERMISSION_MODE 只能是 default、acceptEdits、plan、bypassPermissions、dontAsk、auto')
  }

  const maxTurns = numberFromEnv('AGENT_MAX_TURNS', 25)
  const maxTokens = numberFromEnv('AGENT_MAX_TOKENS', 8192)

  if (provider === 'anthropic') {
    return {
      provider,
      apiKey: anthropicKey,
      baseUrl: trimSlash(process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com'),
      model: process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-5',
      maxTurns,
      maxTokens,
      permissionMode: modeValue,
      cwd,
    }
  }

  return {
    provider,
    apiKey: openaiKey,
    baseUrl: trimSlash(process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1'),
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-4o',
    maxTurns,
    maxTokens,
    permissionMode: modeValue,
    cwd,
  }
}

export function missingKeyMessage(): string {
  return [
    '没有找到 API key。',
    'Anthropic：export ANTHROPIC_API_KEY=...，可选 ANTHROPIC_MODEL、ANTHROPIC_BASE_URL',
    'OpenAI 兼容接口：export OPENAI_API_KEY=... OPENAI_BASE_URL=... OPENAI_MODEL=...',
  ].join('\n')
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数`)
  }
  return value
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
