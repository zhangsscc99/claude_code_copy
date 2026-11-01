import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Tool, ToolContext } from '../types.js'
import { assertNotGit, matchGlob, resolveInside, walkFiles, workspaceRoot } from './workspace.js'

const execFileAsync = promisify(execFile)
const MAX_READ_BYTES = 2_000_000
const MAX_GREP_BYTES = 1_000_000
const OUTPUT_LIMIT = 30_000

export function createBuiltinTools(): Tool[] {
  return [readFileTool, writeFileTool, editFileTool, globTool, grepTool, bashTool]
}

const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a UTF-8 text file with line numbers. Use offset (1-based) and limit for large files.',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path inside the workspace' },
      offset: { type: 'integer', description: 'First line to return, starting at 1' },
      limit: { type: 'integer', description: 'Maximum number of lines. Default 500.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const file = await resolveInside(ctx.cwd, requireString(input, 'path'))
    const info = await stat(file)
    if (!info.isFile()) throw new Error('Not a file')
    if (info.size > MAX_READ_BYTES) throw new Error('File is larger than 2MB. Use grep or bash.')
    const text = await readFile(file, 'utf8')
    if (text.includes('\0')) throw new Error('File looks binary')
    const offset = optionalInt(input, 'offset') ?? 1
    const limit = optionalInt(input, 'limit') ?? 500
    if (offset < 1 || limit < 1) throw new Error('offset and limit must be >= 1')
    const lines = text.split(/\n/)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    if (slice.length === 0) return `No lines at offset ${offset}. File has ${lines.length} lines.`
    const body = slice.map((line, index) => `${String(offset + index).padStart(6)}|${line}`).join('\n')
    const truncated = offset - 1 + slice.length < lines.length ? `\n[showing ${slice.length} of ${lines.length} lines]` : ''
    return body + truncated
  },
}

const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Create or overwrite a UTF-8 text file. Creates parent directories.',
  kind: 'edit',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const root = await workspaceRoot(ctx.cwd)
    const file = await resolveInside(ctx.cwd, requireString(input, 'path'))
    assertNotGit(root, file)
    const content = requireText(input, 'content')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
    return `Wrote ${path.relative(root, file) || file} (${content.length} chars)`
  },
}

const editFileTool: Tool = {
  name: 'edit_file',
  description: 'Replace one exact occurrence of old_string with new_string. old_string must be unique in the file.',
  kind: 'edit',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const root = await workspaceRoot(ctx.cwd)
    const file = await resolveInside(ctx.cwd, requireString(input, 'path'))
    assertNotGit(root, file)
    const oldString = requireString(input, 'old_string')
    const newString = requireText(input, 'new_string')
    if (oldString === newString) throw new Error('old_string and new_string are the same')
    const text = await readFile(file, 'utf8')
    const count = countOccurrences(text, oldString)
    if (count === 0) throw new Error('old_string was not found')
    if (count > 1) throw new Error(`old_string appears ${count} times. Add surrounding lines so it is unique.`)
    const index = text.indexOf(oldString)
    const next = text.slice(0, index) + newString + text.slice(index + oldString.length)
    await writeFile(file, next)
    return `Updated ${path.relative(root, file) || file}`
  },
}

const globTool: Tool = {
  name: 'glob',
  description: 'Find files by a glob pattern such as *.ts or src/**/*.ts. Skips .git, node_modules, and dist.',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Directory to search. Defaults to the workspace root.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const pattern = requireString(input, 'pattern')
    const root = await searchRoot(ctx, optionalString(input, 'path'))
    const matches: string[] = []
    await walkFiles(root, (_abs, rel) => {
      if (matchGlob(rel, pattern)) matches.push(rel)
      return matches.length < 200
    })
    if (matches.length === 0) return 'No files matched.'
    matches.sort()
    const note = matches.length >= 200 ? '\n[stopped at 200 matches]' : ''
    return matches.join('\n') + note
  },
}

const grepTool: Tool = {
  name: 'grep',
  description: 'Search file contents with a JavaScript regular expression. Returns path:line:text.',
  kind: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the workspace root.' },
      glob: { type: 'string', description: 'Optional glob filter, for example *.ts' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const pattern = requireString(input, 'pattern')
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (error) {
      throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
    }
    const glob = optionalString(input, 'glob')
    const start = await resolveInside(ctx.cwd, optionalString(input, 'path') ?? '.')
    const info = await stat(start)
    const files: string[] = []
    if (info.isFile()) files.push(start)
    else if (info.isDirectory()) {
      await walkFiles(start, (abs, rel) => {
        if (!glob || matchGlob(rel, glob)) files.push(abs)
        return true
      })
    } else {
      throw new Error('Search path is not a file or directory')
    }

    const hits: string[] = []
    const root = await workspaceRoot(ctx.cwd)
    for (const file of files) {
      if (hits.length >= 100) break
      const fileInfo = await stat(file)
      if (fileInfo.size > MAX_GREP_BYTES) continue
      const text = await readFile(file, 'utf8')
      if (text.includes('\0')) continue
      const rel = path.relative(root, file).split(path.sep).join('/')
      const lines = text.split(/\n/)
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= 100) break
        if (regex.test(lines[i] ?? '')) hits.push(`${rel}:${i + 1}:${lines[i]}`)
        regex.lastIndex = 0
      }
    }
    if (hits.length === 0) return 'No matches.'
    const note = hits.length >= 100 ? '\n[stopped at 100 matches]' : ''
    return hits.join('\n') + note
  },
}

const bashTool: Tool = {
  name: 'bash',
  description: 'Run a shell command in the workspace. Use this for tests, git, and project scripts.',
  kind: 'exec',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_ms: { type: 'integer', description: 'Timeout in milliseconds. Default 30000, max 120000.' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const command = requireString(input, 'command')
    const requested = optionalInt(input, 'timeout_ms') ?? 30_000
    const timeout = Math.min(Math.max(requested, 1), 120_000)
    const root = await workspaceRoot(ctx.cwd)
    const { shell, args } = shellCommand(command)
    try {
      const { stdout, stderr } = await execFileAsync(shell, args, {
        cwd: root,
        timeout,
        maxBuffer: 1_000_000,
        encoding: 'utf8',
        env: process.env,
      })
      return truncate(joinOutput(asText(stdout), asText(stderr), 0))
    } catch (error) {
      const failed = error as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown; code?: number | string }
      const code = typeof failed.code === 'number' ? failed.code : 1
      const stderr = asText(failed.stderr) || failed.message
      throw new Error(truncate(joinOutput(asText(failed.stdout), stderr, code)))
    }
  },
}

function shellCommand(command: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') return { shell: 'cmd.exe', args: ['/d', '/s', '/c', command] }
  return { shell: 'bash', args: ['-lc', command] }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

function joinOutput(stdout: string, stderr: string, code: number): string {
  const parts = [`exit ${code}`]
  if (stdout.trim()) parts.push(stdout.replace(/\s+$/, ''))
  if (stderr.trim()) parts.push(stderr.replace(/\s+$/, ''))
  return parts.join('\n')
}

function truncate(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text
  return `${text.slice(0, OUTPUT_LIMIT)}\n\n[truncated ${text.length - OUTPUT_LIMIT} chars]`
}

async function searchRoot(ctx: ToolContext, inputPath: string | undefined): Promise<string> {
  const resolved = await resolveInside(ctx.cwd, inputPath ?? '.')
  const info = await stat(resolved)
  if (!info.isDirectory()) throw new Error('glob path must be a directory')
  return resolved
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`\`${key}\` must be a non-empty string`)
  }
  return value
}

function requireText(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new Error(`\`${key}\` must be a string`)
  return value
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`\`${key}\` must be a non-empty string`)
  return value
}

function optionalInt(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`\`${key}\` must be an integer`)
  return value
}

function countOccurrences(text: string, needle: string): number {
  let count = 0
  let from = 0
  while (from <= text.length) {
    const index = text.indexOf(needle, from)
    if (index === -1) return count
    count += 1
    from = index + needle.length
  }
  return count
}
