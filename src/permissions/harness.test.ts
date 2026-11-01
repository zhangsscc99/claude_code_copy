import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PermissionGate } from '../permissions.js'
import { loadPermissionSettings } from './settings.js'
import { parseRule } from './rules.js'
import { createBuiltinTools } from '../tools/builtin.js'

const tools = Object.fromEntries(createBuiltinTools().map((tool) => [tool.name, tool]))

test('deny beats allow, bypass, and auto', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-deny-'))
  try {
    const rules = [
      parseRule('Bash(rm:*)', 'deny', 'user'),
      parseRule('Bash', 'allow', 'user'),
    ]
    for (const mode of ['default', 'bypassPermissions', 'auto'] as const) {
      const gate = new PermissionGate(mode, async () => 'once', {
        cwd: dir,
        rules,
        classifier: async () => ({ decision: 'allow', reason: 'no' }),
      })
      const decision = await gate.check(tools.bash!, { command: 'rm -rf /' })
      assert.equal(decision.allowed, false, mode)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a whole-tool ask still prompts in bypass and auto, and dontAsk denies it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-ask-'))
  try {
    const rules = [parseRule('Bash', 'ask', 'project')]
    let prompts = 0
    const asking = new PermissionGate('bypassPermissions', async () => {
      prompts += 1
      return 'deny'
    }, { cwd: dir, rules })
    assert.equal((await asking.check(tools.bash!, { command: 'pwd' })).allowed, false)
    assert.equal(prompts, 1)

    let autoPrompts = 0
    const auto = new PermissionGate('auto', async () => {
      autoPrompts += 1
      return 'deny'
    }, { cwd: dir, rules, classifier: async () => ({ decision: 'allow', reason: 'skip' }) })
    assert.equal((await auto.check(tools.bash!, { command: 'pwd' })).allowed, false)
    assert.equal(autoPrompts, 1)

    let dontPrompts = 0
    const quiet = new PermissionGate('dontAsk', async () => {
      dontPrompts += 1
      return 'once'
    }, { cwd: dir, rules })
    assert.equal((await quiet.check(tools.bash!, { command: 'pwd' })).allowed, false)
    assert.equal(dontPrompts, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('git metadata and shell startup files stay gated', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-safe-'))
  try {
    const git = path.join(dir, '.git', 'config')
    await mkdir(path.dirname(git), { recursive: true })
    await writeFile(git, '')
    await writeFile(path.join(dir, '.bashrc'), '')
    const calls: string[] = []
    const classifier = async () => {
      calls.push('classifier')
      return { decision: 'deny' as const, reason: 'sensitive' }
    }
    for (const mode of ['acceptEdits', 'bypassPermissions'] as const) {
      const gate = new PermissionGate(mode, async () => 'deny', { cwd: dir })
      const decision = await gate.check(tools.edit_file!, { path: '.git/config', old_string: '', new_string: 'x' })
      assert.equal(decision.allowed, false, mode)
    }
    const auto = new PermissionGate('auto', async () => 'deny', { cwd: dir, classifier })
    const bashrc = await auto.check(tools.write_file!, { path: '.bashrc', content: 'x' })
    assert.equal(bashrc.allowed, false)
    assert.deepEqual(calls, ['classifier'])
    const windows = new PermissionGate('auto', async () => {
      throw new Error('windows path should stay a prompt')
    }, {
      cwd: dir,
      classifier: async () => {
        throw new Error('classifier should not see a windows path')
      },
      canPrompt: false,
    })
    const suspicious = await windows.check(tools.write_file!, { path: 'file.txt::$DATA', content: 'x' })
    assert.equal(suspicious.allowed, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto allows ordinary edits and reads without the classifier', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-auto-'))
  try {
    let calls = 0
    const gate = new PermissionGate('auto', async () => 'deny', {
      cwd: dir,
      classifier: async () => {
        calls += 1
        return { decision: 'deny', reason: 'no' }
      },
    })
    assert.equal((await gate.check(tools.edit_file!, { path: 'src/a.ts', old_string: 'a', new_string: 'b' })).allowed, true)
    assert.equal((await gate.check(tools.read_file!, { path: '../outside.txt' })).allowed, true)
    assert.equal((await gate.check(tools.glob!, { pattern: '*.ts', path: '..' })).allowed, true)
    assert.equal((await gate.check(tools.grep!, { pattern: 'x', path: '..' })).allowed, true)
    assert.equal(calls, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash prefixes do not cross segment or word boundaries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-bash-'))
  try {
    const rules = [parseRule('Bash(npm test:*)', 'allow', 'user'), parseRule('Bash(echo:*)', 'allow', 'user')]
    const gate = new PermissionGate('default', async () => 'deny', { cwd: dir, rules })
    assert.equal((await gate.check(tools.bash!, { command: 'npm test --watch' })).allowed, true)
    assert.equal((await gate.check(tools.bash!, { command: 'npm testing' })).allowed, false)
    assert.equal((await gate.check(tools.bash!, { command: 'npm test && rm -rf /' })).allowed, false)
    await mkdir(path.join(dir, '.git'), { recursive: true })
    assert.equal((await gate.check(tools.bash!, { command: 'echo hi > .git/config' })).allowed, false)
    const exact = new PermissionGate('default', async () => 'once', {
      cwd: dir,
      rules: [parseRule('Bash(echo $(whoami))', 'deny', 'user')],
    })
    assert.equal((await exact.check(tools.bash!, { command: 'echo $(whoami)' })).allowed, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plan denies bash and edits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-plan-'))
  try {
    const gate = new PermissionGate('plan', async () => {
      throw new Error('plan should not ask')
    }, { cwd: dir })
    assert.equal((await gate.check(tools.bash!, { command: 'ls' })).allowed, false)
    assert.equal((await gate.check(tools.edit_file!, { path: 'a.ts', old_string: 'a', new_string: 'b' })).allowed, false)
    assert.equal((await gate.check(tools.read_file!, { path: 'a.ts' })).allowed, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto falls back to a prompt after three denials and denies when the classifier fails', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-limit-'))
  try {
    let prompts = 0
    const gate = new PermissionGate('auto', async () => {
      prompts += 1
      return 'once'
    }, {
      cwd: dir,
      classifier: async () => ({ decision: 'deny', reason: 'no' }),
    })
    assert.equal((await gate.check(tools.bash!, { command: 'rm one' })).allowed, false)
    assert.equal((await gate.check(tools.bash!, { command: 'rm two' })).allowed, false)
    assert.equal((await gate.check(tools.bash!, { command: 'rm three' })).allowed, true)
    assert.equal(prompts, 1)

    const failed = new PermissionGate('auto', async () => 'once', {
      cwd: dir,
      classifier: async () => ({ decision: 'unavailable' }),
    })
    const decision = await failed.check(tools.bash!, { command: 'curl example.com' })
    assert.equal(decision.allowed, false)
    assert.match(decision.reason, /没有返回结果/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('project autoMode is ignored and local allow rules are saved', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-settings-'))
  const home = await mkdtemp(path.join(tmpdir(), 'ccc-home-'))
  try {
    await mkdir(path.join(dir, '.ccc'), { recursive: true })
    await writeFile(path.join(dir, '.ccc', 'settings.json'), JSON.stringify({
      autoMode: { allow: ['FROM_PROJECT'] },
      permissions: { allow: ['Bash(pwd)'] },
    }))
    await writeFile(path.join(dir, '.ccc', 'settings.local.json'), JSON.stringify({
      autoMode: { allow: ['FROM_LOCAL'] },
    }))
    const loaded = loadPermissionSettings(dir, home)
    assert.deepEqual(loaded.autoAllow, ['FROM_LOCAL'])
    assert.equal(loaded.rules.some((rule) => rule.raw === 'Bash(pwd)'), true)

    let prompts = 0
    const gate = new PermissionGate('default', async () => {
      prompts += 1
      return 'local'
    }, { cwd: dir, rules: loaded.rules, autoAllow: loaded.autoAllow })
    assert.equal((await gate.check(tools.bash!, { command: 'npm test --watch' })).allowed, true)
    const saved = await readFile(path.join(dir, '.ccc', 'settings.local.json'), 'utf8')
    assert.match(saved, /Bash\(npm test:\*\)/)
    prompts = 0
    assert.equal((await gate.check(tools.bash!, { command: 'npm test' })).allowed, true)
    assert.equal(prompts, 0)

    const hidden = new PermissionGate('default', async () => 'local', { cwd: dir })
    await hidden.check(tools.edit_file!, { path: '.ccc/settings.local.json', old_string: '{', new_string: '{}' })
    const after = await readFile(path.join(dir, '.ccc', 'settings.local.json'), 'utf8')
    assert.equal(after.includes('.ccc/settings.local.json'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('a symlink to a sensitive file is judged by its target', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'ccc-out-'))
  const dir = await mkdtemp(path.join(tmpdir(), 'ccc-link-'))
  try {
    const secret = path.join(outside, '.bashrc')
    await writeFile(secret, 'export A=1\n')
    await symlink(secret, path.join(dir, 'link-rc'))
    const gate = new PermissionGate('acceptEdits', async () => 'deny', { cwd: dir })
    const decision = await gate.check(tools.edit_file!, { path: 'link-rc', old_string: 'A', new_string: 'B' })
    assert.equal(decision.allowed, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
