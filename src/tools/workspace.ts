import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.copy-agent'])

export async function resolveInside(cwd: string, inputPath: string): Promise<string> {
  if (!inputPath || inputPath.includes('\0')) {
    throw new Error('Invalid path')
  }
  const root = await realpath(cwd)
  const abs = path.resolve(root, inputPath)
  const missing: string[] = []
  let current = abs
  while (true) {
    try {
      const real = await realpath(current)
      const finalPath = path.resolve(real, ...missing.reverse())
      assertInside(root, finalPath)
      return finalPath
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw new Error(`Path escapes workspace: ${inputPath}`)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

export function assertNotGit(root: string, target: string): void {
  const rel = path.relative(root, target)
  if (rel === '.git' || rel.startsWith(`.git${path.sep}`)) {
    throw new Error('Refusing to modify .git')
  }
}

export function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const three = pattern.slice(i, i + 3)
    const two = pattern.slice(i, i + 2)
    if (three === '**/') {
      source += '(?:.*/)?'
      i += 2
      continue
    }
    if (two === '**') {
      source += '.*'
      i += 1
      continue
    }
    const char = pattern[i] ?? ''
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += escapeRegExp(char)
  }
  return new RegExp(`^${source}$`)
}

export function matchGlob(relPosix: string, pattern: string): boolean {
  const normalized = pattern.includes('/') ? pattern : `**/${pattern}`
  return globToRegExp(normalized).test(relPosix)
}

export async function walkFiles(
  root: string,
  onFile: (abs: string, relPosix: string) => boolean | Promise<boolean>,
): Promise<void> {
  const realRoot = await realpath(root)
  let seen = 0
  let stopped = false
  const maxFiles = 5000

  async function rec(dir: string): Promise<void> {
    if (stopped || seen >= maxFiles) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (stopped || seen >= maxFiles) return
      if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await rec(abs)
        continue
      }
      if (!entry.isFile()) continue
      seen += 1
      const rel = path.relative(realRoot, abs).split(path.sep).join('/')
      const keepGoing = await onFile(abs, rel)
      if (!keepGoing) {
        stopped = true
        return
      }
    }
  }

  await rec(realRoot)
}

export async function workspaceRoot(cwd: string): Promise<string> {
  const info = await stat(cwd)
  if (!info.isDirectory()) throw new Error(`Workspace is not a directory: ${cwd}`)
  return realpath(cwd)
}

function assertInside(root: string, target: string): void {
  const rel = path.relative(root, target)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return
  throw new Error(`Path escapes workspace: ${target}`)
}

function escapeRegExp(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}
