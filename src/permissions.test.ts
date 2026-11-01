import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PermissionGate } from './permissions.js'
import { createBuiltinTools } from './tools/builtin.js'

const tools = Object.fromEntries(createBuiltinTools().map((tool) => [tool.name, tool]))

test('default mode allows reads and asks before bash', async () => {
  let asked = 0
  const gate = new PermissionGate('default', async () => {
    asked += 1
    return 'deny'
  })
  const read = await gate.check(tools.read_file!, { path: 'a.txt' })
  const bash = await gate.check(tools.bash!, { command: 'ls' })
  assert.equal(read.allowed, true)
  assert.equal(bash.allowed, false)
  assert.equal(asked, 1)
})

test('acceptEdits allows writes and still asks before bash', async () => {
  const asked: string[] = []
  const gate = new PermissionGate('acceptEdits', async (tool) => {
    asked.push(tool.name)
    return 'deny'
  })
  const write = await gate.check(tools.write_file!, { path: 'a.txt', content: 'x' })
  const bash = await gate.check(tools.bash!, { command: 'ls' })
  assert.equal(write.allowed, true)
  assert.equal(bash.allowed, false)
  assert.deepEqual(asked, ['bash'])
})

test('always remembers the tool for the rest of the session', async () => {
  let asked = 0
  const gate = new PermissionGate('default', async () => {
    asked += 1
    return 'always'
  })
  const first = await gate.check(tools.bash!, { command: 'ls' })
  const second = await gate.check(tools.bash!, { command: 'pwd' })
  assert.equal(first.allowed, true)
  assert.equal(second.allowed, true)
  assert.equal(asked, 1)
})
