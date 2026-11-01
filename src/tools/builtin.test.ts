import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createBuiltinTools } from './builtin.js'

const tools = Object.fromEntries(createBuiltinTools().map((tool) => [tool.name, tool]))

test('write, edit, read, glob, and grep stay inside the workspace', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-tools-'))
  try {
    const ctx = { cwd: dir }
    await tools.write_file!.execute({ path: 'src/a.txt', content: 'alpha beta alpha\n' }, ctx)
    await assert.rejects(
      () => tools.edit_file!.execute({ path: 'src/a.txt', old_string: 'alpha', new_string: 'x' }, ctx),
      /appears 2 times/,
    )
    await tools.edit_file!.execute({ path: 'src/a.txt', old_string: 'beta', new_string: 'gamma' }, ctx)
    assert.equal(await readFile(path.join(dir, 'src/a.txt'), 'utf8'), 'alpha gamma alpha\n')

    const read = await tools.read_file!.execute({ path: 'src/a.txt' }, ctx)
    assert.match(read, /gamma/)
    await assert.rejects(() => tools.read_file!.execute({ path: '../secret.txt' }, ctx), /escapes workspace/)

    await tools.write_file!.execute({ path: 'notes.md', content: '# notes\n' }, ctx)
    const listed = await tools.glob!.execute({ pattern: '*.txt' }, ctx)
    assert.match(listed, /src\/a\.txt/)
    assert.doesNotMatch(listed, /notes\.md/)

    const found = await tools.grep!.execute({ pattern: 'gamma', glob: '*.txt' }, ctx)
    assert.match(found, /src\/a\.txt:1:/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash runs in the workspace', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-bash-'))
  try {
    const root = await realpath(dir)
    const output = await tools.bash!.execute({ command: 'pwd && printf hi' }, { cwd: dir })
    assert.match(output, /exit 0/)
    assert.match(output, /hi/)
    assert.match(output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
