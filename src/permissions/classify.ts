import type { Config } from '../config.js'

export type ClassifierResult =
  | { decision: 'allow' | 'deny'; reason: string }
  | { decision: 'unavailable' }
  | { decision: 'too_long' }

export interface ClassifierRequest {
  transcript: string
  toolName: string
  input: Record<string, unknown>
  allow: string[]
  softDeny: string[]
}

export type AutoClassifier = (request: ClassifierRequest) => Promise<ClassifierResult>

const TRANSCRIPT_LIMIT = 80_000

export function createAutoClassifier(config: Config): AutoClassifier {
  const model = process.env.AUTO_MODEL?.trim() || config.model
  return async (request) => {
    if (request.transcript.length > TRANSCRIPT_LIMIT) return { decision: 'too_long' }
    try {
      const text = config.provider === 'anthropic'
        ? await anthropicText(config, model, request)
        : await openaiText(config, model, request)
      return parseDecision(text)
    } catch {
      return { decision: 'unavailable' }
    }
  }
}

async function openaiText(config: Config, model: string, request: ClassifierRequest): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, '')
  const url = base.endsWith('/chat/completions')
    ? base
    : `${base.endsWith('/v1') ? base : `${base}/v1`}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      messages: [
        { role: 'system', content: CLASSIFIER_PROMPT },
        { role: 'user', content: userPrompt(request) },
      ],
    }),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(body.slice(0, 300))
  const parsed = JSON.parse(body) as { choices?: Array<{ message?: { content?: string | null } }> }
  return parsed.choices?.[0]?.message?.content ?? ''
}

async function anthropicText(config: Config, model: string, request: ClassifierRequest): Promise<string> {
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      system: CLASSIFIER_PROMPT,
      messages: [{ role: 'user', content: userPrompt(request) }],
    }),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(body.slice(0, 300))
  const parsed = JSON.parse(body) as { content?: Array<{ type?: string; text?: string }> }
  return parsed.content?.find((block) => block.type === 'text')?.text ?? ''
}

function parseDecision(text: string): ClassifierResult {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) return { decision: 'unavailable' }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { decision?: unknown; reason?: unknown }
    if (parsed.decision !== 'allow' && parsed.decision !== 'deny') return { decision: 'unavailable' }
    return { decision: parsed.decision, reason: typeof parsed.reason === 'string' ? parsed.reason : '' }
  } catch {
    return { decision: 'unavailable' }
  }
}

function userPrompt(request: ClassifierRequest): string {
  return [
    `允许说明：${request.allow.join('；') || '无'}`,
    `倾向拒绝：${request.softDeny.join('；') || '无'}`,
    `最近对话：\n${request.transcript || '无'}`,
    `工具：${request.toolName}`,
    `参数：${JSON.stringify(request.input)}`,
  ].join('\n\n')
}

const CLASSIFIER_PROMPT = `你只判断这一次工具调用能不能执行。它必须落在用户刚刚交代的任务里。
拒绝破坏、外传数据、扩大权限，以及用户没有明确要求的敏感文件修改。
只回复 JSON：{"decision":"allow"或"deny","reason":"一句理由"}`
