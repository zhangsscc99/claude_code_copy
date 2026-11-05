import { stat } from 'node:fs/promises'
import readline from 'node:readline'
import { compactSession, loadCompactionSettings, type CompactionSettings, type CompactionTracking } from './agent/compact.js'
import {
  collapseIfNeeded,
  createCollapseStore,
  isContextCollapseEnabled,
  loadCollapseSettings,
  resetCollapseStore,
  type CollapseSettings,
  type CollapseStore,
} from './agent/collapse.js'
import { runAgent } from './agent/loop.js'
import { createTraceBusFromEnv, type TraceBus } from './agent/trace.js'
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
import { startWebServer } from './server/http.js'
import { WebSession } from './server/session.js'
import { appendCollapseCommit, appendTranscript } from './transcript.js'
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
  cli: boolean
  port?: number
  noOpen: boolean
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
  const compaction = {
    settings: loadCompactionSettings(),
    tracking: { consecutiveFailures: 0 },
  }
  const collapse = {
    settings: loadCollapseSettings(),
    store: createCollapseStore(),
    enabled: isContextCollapseEnabled(),
  }
  const rules = [
    ...settings.rules,
    ...cliRules(args.allowedTools, 'allow'),
    ...cliRules(args.disallowedTools, 'deny'),
  ]
  const trace = createTraceBusFromEnv()

  if (args.print !== undefined) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
    const rl = interactive
      ? readline.createInterface({ input: process.stdin, output: process.stdout })
      : undefined
    const gate = createGate(config, settings, rules, rl ? (tool, input, detail) => askOn(rl, tool.name, input, detail) : denyAsk, !interactive)
    try {
      const code = await runTurn({ config, tools, llm, system, history, gate, userText: args.print, compaction, collapse, trace })
      if (code !== 0) process.exitCode = code
    } finally {
      rl?.close()
      await trace?.close()
    }
    return
  }

  if (!args.cli) {
    const session = new WebSession({
      config,
      tools,
      llm,
      system,
      version: VERSION,
      rules,
      autoAllow: settings.autoAllow,
      autoSoftDeny: settings.autoSoftDeny,
      classifier: createAutoClassifier(config),
      trace,
    })
    await startWebServer({ session, port: args.port ?? 3080, openBrowser: !args.noOpen })
    return
  }

  await repl({ config, settings, rules, tools, llm, system, history, compaction, collapse, trace })
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
  compaction: { settings: CompactionSettings; tracking: CompactionTracking }
  collapse: { settings: CollapseSettings; store: CollapseStore; enabled: boolean }
  trace?: TraceBus
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
        options.compaction.tracking.consecutiveFailures = 0
        resetCollapseStore(options.collapse.store)
        process.stdout.write('会话已清空。\n')
        continue
      }
      if (line === '/compact') {
        await compactInRepl(options)
        continue
      }
      if (line === '/collapse') {
        await collapseInRepl(options)
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
    await options.trace?.close()
  }
}

async function compactInRepl(options: {
  config: Config
  llm: ReturnType<typeof createLlmClient>
  system: string
  history: Message[]
  compaction: { settings: CompactionSettings; tracking: CompactionTracking }
  collapse: { settings: CollapseSettings; store: CollapseStore; enabled: boolean }
}): Promise<void> {
  process.stdout.write('正在压缩上下文\n')
  try {
    const outcome = await compactSession({
      history: options.history,
      system: options.system,
      llm: options.llm,
      model: options.config.model,
      settings: options.compaction.settings,
      tracking: options.compaction.tracking,
    })
    resetCollapseStore(options.collapse.store)
    process.stdout.write(`已压缩：${outcome.before} → ${outcome.after} 估算 token。\n`)
    try {
      await appendTranscript(options.config.cwd, [outcome.boundary, outcome.summaryMessage])
    } catch {
      process.stderr.write('会话记录没有写进 .copy-agent/session.jsonl\n')
    }
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`)
  }
}

async function collapseInRepl(options: {
  config: Config
  llm: ReturnType<typeof createLlmClient>
  system: string
  history: Message[]
  collapse: { settings: CollapseSettings; store: CollapseStore; enabled: boolean }
}): Promise<void> {
  if (!options.collapse.enabled) {
    process.stdout.write('上下文折叠没有开启：设置 AGENT_CONTEXT_COLLAPSE=1。\n')
    return
  }
  process.stdout.write('正在折叠上下文\n')
  try {
    const outcome = await collapseIfNeeded({
      history: options.history,
      system: options.system,
      llm: options.llm,
      model: options.config.model,
      store: options.collapse.store,
      settings: options.collapse.settings,
      mode: 'manual',
      onCommit: (commit) => appendCollapseCommit(options.config.cwd, commit),
    })
    if (!outcome) {
      process.stdout.write('还没有可以折叠的完整轮次。\n')
      return
    }
    process.stdout.write(
      `已折叠 ${outcome.commits.length} 段：${outcome.before} → ${outcome.after} 估算 token。\n`,
    )
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`)
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
  compaction: { settings: CompactionSettings; tracking: CompactionTracking }
  collapse: { settings: CollapseSettings; store: CollapseStore; enabled: boolean }
  trace?: TraceBus
}): Promise<number> {
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
    compaction: options.compaction,
    collapse: options.collapse,
    trace: options.trace,
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
      onCompactStart(reason) {
        if (reason === 'auto') process.stdout.write('\n正在压缩上下文\n')
      },
      onCompactEnd({ reason, before, after }) {
        if (reason === 'auto') process.stdout.write(`上下文已压缩：${before} → ${after} 估算 token\n`)
      },
      onCompactError(reason, message) {
        process.stderr.write(`上下文压缩失败（${reason === 'auto' ? '自动' : '手动'}）：${message}\n`)
      },
      onCollapseStart(reason) {
        if (reason === 'auto') process.stdout.write('\n正在折叠上下文\n')
      },
      onCollapseEnd({ reason, commits, before, after }) {
        process.stdout.write(`上下文已折叠：${commits} 段，${before} → ${after} 估算 token（${reason === 'overflow' ? '溢出恢复' : '自动'}）\n`)
      },
      onCollapseError(reason, message) {
        process.stderr.write(`上下文折叠失败（${reason === 'overflow' ? '溢出恢复' : '自动'}）：${message}\n`)
      },
    },
  })
  try {
    await appendTranscript(options.config.cwd, result.produced)
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
    '/compact  把较早的对话收成摘要，保留最近的来回',
    '/collapse 把较早的完整轮次折叠成占位摘要（需 AGENT_CONTEXT_COLLAPSE=1）',
    '/clear    清空这次会话',
    '/exit     退出',
    '',
  ].join('\n')
}

function helpText(): string {
  return `ccc ${VERSION}

用法
  ccc                         打开本地网页 http://127.0.0.1:3080
  ccc --cli                   在终端里对话
  ccc -p "看一下这个仓库"      跑一轮然后退出

选项
  --cli                       使用终端，不打开网页
  --port <端口>               网页端口，默认 3080
  --no-open                   启动网页但不打开浏览器
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

上下文压缩
  AGENT_CONTEXT_WINDOW=128000   上下文长度，自动阈值 = 窗口 - 20000 - 13000
  DISABLE_AUTO_COMPACT=1        只关掉自动压缩，/compact 仍可用
  DISABLE_COMPACT=1             自动和手动都停

上下文折叠
  AGENT_CONTEXT_COLLAPSE=1      开启折叠：90% 起折叠旧轮次，95% 强制排空
  DISABLE_COLLAPSE=1            关闭折叠
  折叠和自动压缩互斥；413 时先折叠，折叠不了再回落到压缩

链路追踪
  AGENT_TRACE=0                 关闭遥测（默认开）
  AGENT_TRACE_URL=...           collector 地址，默认 http://127.0.0.1:4120
  AGENT_TRACE_BROKERS=k1:9092   直连 Kafka（优先于 URL），topic 用 AGENT_TRACE_TOPIC
  AGENT_TRACE_QUEUE_SIZE=2048   有界队列，满了丢弃最旧的 span
  AGENT_TRACE_BATCH_SIZE=50     一批最多多少 span
  AGENT_TRACE_FLUSH_MS=2000     批量发送的最长等待

环境变量见 .env.example。规则见 docs/permission-harness.md，压缩见 docs/context-compact.md，折叠见 docs/context-collapse.md。
`
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    version: false,
    dangerouslySkipPermissions: false,
    allowedTools: [],
    disallowedTools: [],
    cli: false,
    noOpen: false,
  }
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
      case '--cli':
        args.cli = true
        break
      case '--port':
        args.port = Number(next())
        break
      case '--no-open':
        args.noOpen = true
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
  if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535)) {
    throw new Error('--port 必须是 1 到 65535 的整数')
  }
  return args
}
