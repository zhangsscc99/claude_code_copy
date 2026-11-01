import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { matchGlob, resolveInside } from './workspace.js'

test('resolveInside keeps new files in the workspace and rejects parents', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-path-'))
  try {
    const root = await realpath(dir)
    const created = await resolveInside(dir, 'sub/new.txt')
    assert.equal(created.startsWith(`${root}${path.sep}`), true)
    await assert.rejects(() => resolveInside(dir, '../outside.txt'), /escapes workspace/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('glob patterns match nested files and can stay in one directory', async () => {
  assert.equal(matchGlob('src/a.ts', '*.ts'), true)
  assert.equal(matchGlob('a.ts', '*.ts'), true)
  assert.equal(matchGlob('src/a.ts', 'src/*.ts'), true)
  assert.equal(matchGlob('src/b/c.ts', 'src/*.ts'), false)
  assert.equal(matchGlob('src/b/c.ts', 'src/**/*.ts'), true)
  assert.equal(matchGlob('lib/a.ts', 'src/**/*.ts'), false)
})

test('resolveInside rejects a symlink that points outside the workspace', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'ccc-out-'))
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-link-'))
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'nope')
    const { symlink } = await import('node:fs/promises')
    await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'secret.txt'))
    await assert.rejects(() => resolveInside(dir, 'secret.txt'), /escapes workspace/)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
