import { stat } from 'node:fs/promises'
import readline from 'node:readline'
import { runAgent } from './agent/loop.js'
import { loadConfig, loadDotEnv, missingKeyMessage, type Config } from './config.js'
import { createAutoClassifier } from './permissions/classify.js'
import { loadPermissionSettings, type LoadedSettings } from './permissions/settings.js'
import { parseRule, type PermissionRule } from './permissions/rules.js'
import {
  isPermissionMode,
  normalizePermissionMode,
  PermissionGate,
  type AskFn,
  type PermissionAnswer,
  type PermissionMode,
} from './permissions.js'
import { createLlmClient } from './llm/client.js'
import { buildSystemPrompt } from './prompt.js'
import { createBuiltinTools } from './tools/builtin.js'
import { appendTranscript } from './transcript.js'
import type { Message, Tool } from './types.js'

const VERSION = '0.1.0'

interface Args {
  help: boolean
  version: boolean
  print?: string
  cwd?: string
  model?: string
  provider?: string
  permissionMode?: string
  allowedTools: string[]
  disallowedTools: string[]
  maxTurns?: number
  dangerouslySkipPermissions: boolean
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(helpText())
    return
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  const cwd = args.cwd ?? process.cwd()
  const cwdInfo = await stat(cwd).catch(() => undefined)
  if (!cwdInfo?.isDirectory()) throw new Error(`不是目录：${cwd}`)
  loadDotEnv(cwd)
  const settings = loadPermissionSettings(cwd)
  const config = loadConfig(cwd)
  if (!args.permissionMode && !args.dangerouslySkipPermissions && !process.env.AGENT_PERMISSION_MODE && settings.defaultMode) {
    config.permissionMode = settings.defaultMode
  }
  applyArgs(config, args)
  if (config.permissionMode === 'bypassPermissions' && settings.disableBypass) {
    throw new Error('设置关闭了 bypassPermissions。')
  }
  if (config.permissionMode === 'auto' && settings.disableAuto) {
    throw new Error('设置关闭了 auto。')
  }
  if (!config.apiKey) throw new Error(missingKeyMessage())

  if (config.permissionMode === 'bypassPermissions') {
    process.stderr.write('权限模式是 bypassPermissions：通过自检后不再询问。拒绝规则、ask 规则和安全路径仍然有效。\n')
  }

  const tools = createBuiltinTools()
  const llm = createLlmClient(config)
  const system = buildSystemPrompt(config.cwd)
  const history: Message[] = []
  const rules = [
    ...settings.rules,
    ...cliRules(args.allowedTools, 'allow'),
    ...cliRules(args.disallowedTools, 'deny'),
  ]

  if (args.print !== undefined) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
    const rl = interactive
      ? readline.createInterface({ input: process.stdin, output: process.stdout })
      : undefined
    const gate = createGate(config, settings, rules, rl ? (tool, input, detail) => askOn(rl, tool.name, input, detail) : denyAsk, !interactive)
    try {
      const code = await runTurn({ config, tools, llm, system, history, gate, userText: args.print })
      if (code !== 0) process.exitCode = code
    } finally {
      rl?.close()
    }
    return
  }

  await repl({ config, settings, rules, tools, llm, system, history })
}

function applyArgs(config: Config, args: Args): void {
  if (args.provider) {
    if (args.provider !== 'anthropic' && args.provider !== 'openai') {
      throw new Error('--provider 只能是 anthropic 或 openai')
    }
    config.provider = args.provider
    if (args.provider === 'anthropic') {
      config.apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? ''
      config.baseUrl = (process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com').replace(/\/+$/, '')
      config.model = process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-5'
    } else {
      config.apiKey = process.env.OPENAI_API_KEY?.trim() ?? ''
      config.baseUrl = (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '')
      config.model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o'
    }
  }
  if (args.model) config.model = args.model
  if (args.maxTurns) config.maxTurns = args.maxTurns
  if (args.permissionMode) {
    if (!isPermissionMode(args.permissionMode) && args.permissionMode !== 'bypass') {
      throw new Error('--permission-mode 只能是 default、acceptEdits、plan、bypassPermissions、dontAsk、auto')
    }
    config.permissionMode = normalizePermissionMode(args.permissionMode) ?? 'default'
  } else if (args.dangerouslySkipPermissions) {
    config.permissionMode = 'bypassPermissions'
  }
}

async function repl(options: {
  config: Config
  settings: LoadedSettings
  rules: PermissionRule[]
  tools: Tool[]
  llm: ReturnType<typeof createLlmClient>
  system: string
  history: Message[]
}): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let closed = false
  rl.on('close', () => {
    closed = true
  })
  const gate = createGate(options.config, options.settings, options.rules, (tool, input, detail) => askOn(rl, tool.name, input, detail), false)
  process.stdout.write(welcome(options.config))
  try {
    while (!closed) {
      const line = (await question(rl, '› ')).trim()
      if (closed) return
      if (!line) continue
      if (line === '/exit' || line === '/quit') return
      if (line === '/help') {
        process.stdout.write(slashHelp())
        continue
      }
      if (line === '/clear') {
        options.history.length = 0
        process.stdout.write('会话已清空。\n')
        continue
      }
      if (line === '/tools') {
        process.stdout.write(`${options.tools.map((tool) => `${tool.name}  ${tool.kind}`).join('\n')}\n`)
        continue
      }
      if (line.startsWith('/mode')) {
        const next = line.split(/\s+/)[1] ?? ''
        if (!isPermissionMode(next) && next !== 'bypass') {
          process.stdout.write('用法：/mode default|acceptEdits|plan|bypassPermissions|dontAsk|auto\n')
          continue
        }
        const mode = normalizePermissionMode(next)
        if (!mode) continue
        gate.setMode(mode)
        options.config.permissionMode = mode
        process.stdout.write(`权限模式：${next}\n`)
        continue
      }
      await runTurn({ ...options, gate, userText: line })
    }
  } finally {
    rl.close()
  }
}

async function runTurn(options: {
  config: Config
  tools: Tool[]
  llm: ReturnType<typeof createLlmClient>
  system: string
  history: Message[]
  gate: PermissionGate
  userText: string
}): Promise<number> {
  const before = options.history.length
  const result = await runAgent({
    history: options.history,
    userText: options.userText,
    system: options.system,
    llm: options.llm,
    tools: options.tools,
    permissions: options.gate,
    maxTurns: options.config.maxTurns,
    cwd: options.config.cwd,
    model: options.config.model,
    hooks: {
      onAssistantText(text) {
        process.stdout.write(`\n${text}\n`)
      },
      onToolStart(name, input) {
        process.stdout.write(`\n· ${name} ${preview(name, input)}\n`)
      },
      onToolEnd(_name, output, isError) {
        const first = output.split('\n')[0] ?? ''
        process.stdout.write(`  ${isError ? '失败' : '完成'} ${first.slice(0, 180)}\n`)
      },
    },
  })
  try {
    await appendTranscript(options.config.cwd, options.history.slice(before))
  } catch {
    process.stderr.write('会话记录没有写进 .copy-agent/session.jsonl\n')
  }
  if (result.stopReason === 'error') {
    process.stderr.write(`\n${result.error}\n`)
    return 1
  }
  if (result.stopReason === 'max_turns') {
    process.stderr.write(`\n达到最大轮数 ${options.config.maxTurns}。可以继续说下一步。\n`)
  }
  return 0
}

async function askOn(
  rl: readline.Interface,
  name: string,
  input: Record<string, unknown>,
  detail: { reason: string; saveRule: string },
): Promise<PermissionAnswer> {
  const answer = (await question(
    rl,
    `\n${detail.reason}\n${name} ${preview(name, input)}\n保存为 ${detail.saveRule}\n[1/y] 允许一次  [2] 本会话允许  [3] 写入本地设置  [4/n] 拒绝：`,
  )).trim().toLowerCase()
  if (answer === '1' || answer === 'y' || answer === 'yes') return 'once'
  if (answer === '2') return 'session'
  if (answer === '3') return 'local'
  return 'deny'
}

function denyAsk(tool: Tool): Promise<PermissionAnswer> {
  process.stderr.write(`非交互模式已拒绝 ${tool.name}。需要规则、acceptEdits、auto 或 bypassPermissions。\n`)
  return Promise.resolve('deny')
}

function createGate(
  config: Config,
  settings: LoadedSettings,
  rules: PermissionRule[],
  ask: AskFn,
  headless: boolean,
): PermissionGate {
  return new PermissionGate(config.permissionMode, ask, {
    cwd: config.cwd,
    rules,
    autoAllow: settings.autoAllow,
    autoSoftDeny: settings.autoSoftDeny,
    classifier: createAutoClassifier(config),
    canPrompt: !headless,
  })
}

function cliRules(specs: string[], behavior: 'allow' | 'deny'): PermissionRule[] {
  return specs.flatMap((spec) => spec.split(',')).map((spec) => spec.trim()).filter(Boolean).map((spec) => parseRule(spec, behavior, 'cli'))
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve))
}

function preview(name: string, input: Record<string, unknown>): string {
  const value = name === 'bash' ? input.command
    : name === 'grep' ? input.pattern
      : name === 'glob' ? input.pattern
        : input.path
  const text = typeof value === 'string' ? value : JSON.stringify(input)
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

function welcome(config: Config): string {
  return [
    `ccc ${VERSION}  ${config.provider} / ${config.model}`,
    `目录 ${config.cwd}`,
    `权限 ${config.permissionMode}    /help 看命令，/exit 退出`,
    '',
  ].join('\n')
}

function slashHelp(): string {
  return [
    '/help     显示命令',
    '/tools    列出工具',
    '/mode     default | acceptEdits | plan | bypassPermissions | dontAsk | auto',
    '/clear    清空这次会话',
    '/exit     退出',
    '',
  ].join('\n')
}

function helpText(): string {
  return `ccc ${VERSION}

用法
  ccc                         进入对话
  ccc -p "看一下这个仓库"      跑一轮然后退出
  ccc --permission-mode plan  只读，不改文件、不跑命令

选项
  -p, --print <文本>          单轮任务
  --cwd <目录>                工作目录，默认当前目录
  --provider anthropic|openai
  --model <模型名>
  --permission-mode <模式>    default | acceptEdits | plan | bypassPermissions | dontAsk | auto
  --allowed-tools <规则>      例如 Bash(npm test:*)，可重复或用逗号分隔
  --disallowed-tools <规则>   例如 Bash(rm:*)
  --max-turns <次数>          一轮里模型最多调用几次，默认 25
  --dangerously-skip-permissions
  -h, --help
  -v, --version

环境变量见 .env.example。规则见 docs/permission-harness.md。
`
}

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false, version: false, dangerouslySkipPermissions: false, allowedTools: [], disallowedTools: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value || value.startsWith('-')) throw new Error(`缺少 ${token} 的参数`)
      return value
    }
    switch (token) {
      case '-h':
      case '--help':
        args.help = true
        break
      case '-v':
      case '--version':
        args.version = true
        break
      case '-p':
      case '--print':
        args.print = next()
        break
      case '--cwd':
        args.cwd = next()
        break
      case '--model':
        args.model = next()
        break
      case '--provider':
        args.provider = next()
        break
      case '--permission-mode':
        args.permissionMode = next()
        break
      case '--allowed-tools':
        args.allowedTools.push(next())
        break
      case '--disallowed-tools':
        args.disallowedTools.push(next())
        break
      case '--max-turns':
        args.maxTurns = Number(next())
        break
      case '--dangerously-skip-permissions':
        args.dangerouslySkipPermissions = true
        break
      default:
        throw new Error(`未知参数 ${token}`)
    }
  }
  if (args.maxTurns !== undefined && (!Number.isInteger(args.maxTurns) || args.maxTurns < 1)) {
    throw new Error('--max-turns 必须是正整数')
  }
  return args
}
