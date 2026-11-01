const transcript = document.querySelector('#transcript')
const input = document.querySelector('#input')
const composer = document.querySelector('#composer')
const send = document.querySelector('#send')
const mode = document.querySelector('#mode')
const cwd = document.querySelector('#cwd')
const model = document.querySelector('#model')
const status = document.querySelector('#status')
const newChat = document.querySelector('#new-chat')

const state = { items: [], busy: false, mode: 'default' }

boot().catch((error) => setStatus(error.message))

async function boot() {
  const response = await fetch('/api/state')
  const body = await response.json()
  state.items = body.timeline ?? []
  state.busy = Boolean(body.busy)
  state.mode = body.permissionMode
  cwd.textContent = body.cwd
  model.textContent = `${body.provider} / ${body.model}`
  mode.value = body.permissionMode
  render()
  listen()
}

function listen() {
  const source = new EventSource('/api/events')
  source.onmessage = (event) => {
    const data = JSON.parse(event.data)
    apply(data)
    render()
  }
  source.onerror = () => setStatus('连接中断，正在重连')
}

function apply(event) {
  if (event.type === 'ready') return
  if (event.type === 'busy') {
    state.busy = event.busy
    setStatus(event.busy ? '处理中' : '就绪')
    return
  }
  if (event.type === 'mode') {
    state.mode = event.mode
    mode.value = event.mode
    return
  }
  if (event.type === 'cleared') {
    state.items = []
    return
  }
  if (event.type === 'user') state.items.push({ kind: 'user', text: event.text })
  if (event.type === 'assistant') state.items.push({ kind: 'assistant', text: event.text })
  if (event.type === 'notice') state.items.push({ kind: 'notice', text: event.text })
  if (event.type === 'tool_start') {
    state.items.push({ kind: 'tool', name: event.name, preview: event.preview, output: '', isError: false, pending: true })
  }
  if (event.type === 'tool_end') {
    const tool = [...state.items].reverse().find((item) => item.kind === 'tool' && item.pending)
    if (tool) {
      tool.output = event.output
      tool.isError = event.isError
      tool.pending = false
    }
  }
  if (event.type === 'permission') {
    state.items.push({
      kind: 'permission',
      id: event.id,
      name: event.name,
      preview: event.preview,
      reason: event.reason,
      saveRule: event.saveRule,
      status: 'pending',
    })
  }
  if (event.type === 'permission_resolved') {
    const card = state.items.find((item) => item.kind === 'permission' && item.id === event.id)
    if (card) card.status = event.answer
  }
}

function render() {
  const stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80
  transcript.replaceChildren()
  const column = document.createElement('div')
  column.className = 'column'
  if (state.items.length === 0) {
    column.append(emptyState())
  } else {
    for (const item of state.items) column.append(renderItem(item))
  }
  transcript.append(column)
  send.disabled = state.busy
  newChat.disabled = state.busy
  input.disabled = state.busy
  if (stick) transcript.scrollTop = transcript.scrollHeight
}

function emptyState() {
  const block = document.createElement('div')
  block.className = 'empty'
  const title = document.createElement('h1')
  title.textContent = '今天想改什么？'
  const copy = document.createElement('p')
  copy.textContent = '直接描述任务。读文件会在工作目录里进行，改文件和命令需要你确认。'
  block.append(title, copy)
  return block
}

function renderItem(item) {
  if (item.kind === 'user') return block('user turn', item.text)
  if (item.kind === 'assistant') return assistantBlock(item.text)
  if (item.kind === 'notice') return block('notice', item.text)
  if (item.kind === 'tool') return toolBlock(item)
  return permissionBlock(item)
}

function block(className, text) {
  const node = document.createElement('div')
  node.className = className
  node.textContent = text
  return node
}

function assistantBlock(text) {
  const node = document.createElement('div')
  node.className = 'assistant turn'
  const pattern = /```([\s\S]*?)```/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    appendText(node, text.slice(cursor, match.index))
    const pre = document.createElement('pre')
    pre.textContent = match[1].replace(/^\w+\n/, '')
    node.append(pre)
    cursor = match.index + match[0].length
  }
  appendText(node, text.slice(cursor))
  return node
}

function appendText(node, text) {
  const parts = text.split(/(`[^`]+`)/g)
  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = document.createElement('code')
      code.textContent = part.slice(1, -1)
      node.append(code)
    } else if (part) {
      node.append(document.createTextNode(part))
    }
  }
}

function toolBlock(item) {
  const wrap = document.createElement('div')
  wrap.className = 'tool'
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'tool-row'
  const name = document.createElement('span')
  name.className = 'tool-name'
  name.textContent = labelFor(item.name)
  const dot = document.createElement('span')
  dot.className = 'dot'
  const summary = document.createElement('span')
  summary.className = 'tool-summary'
  summary.textContent = item.preview
  const marker = document.createElement('span')
  marker.className = `tool-state ${item.pending ? '' : item.isError ? 'bad' : 'ok'}`
  marker.textContent = item.pending ? '进行中' : item.isError ? '失败' : '完成'
  row.append(name, dot, summary, marker)
  const body = document.createElement('pre')
  body.className = 'tool-body'
  body.hidden = true
  body.textContent = item.output || '还没有输出'
  row.addEventListener('click', () => {
    body.hidden = !body.hidden
  })
  wrap.append(row, body)
  return wrap
}

function permissionBlock(item) {
  const card = document.createElement('div')
  card.className = 'permission'
  const reason = document.createElement('p')
  reason.textContent = item.reason
  const preview = document.createElement('p')
  preview.textContent = `${labelFor(item.name)}  ${item.preview}`
  const save = document.createElement('div')
  save.className = 'save'
  save.textContent = item.saveRule
  card.append(reason, preview, save)
  if (item.status === 'pending') {
    const actions = document.createElement('div')
    actions.className = 'actions'
    for (const choice of [
      ['once', '允许一次', 'primary'],
      ['session', '本会话允许', ''],
      ['local', '写入本地设置', ''],
      ['deny', '拒绝', 'danger'],
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = choice[2]
      button.textContent = choice[1]
      button.addEventListener('click', () => answer(item.id, choice[0], actions))
      actions.append(button)
    }
    card.append(actions)
  } else {
    const done = document.createElement('p')
    done.textContent = answered(item.status)
    card.append(done)
  }
  return card
}

async function answer(id, choice, actions) {
  actions.querySelectorAll('button').forEach((button) => {
    button.disabled = true
  })
  await fetch('/api/permissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, answer: choice }),
  })
}

composer.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (!text || state.busy) return
  input.value = ''
  input.style.height = 'auto'
  await fetch('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
})

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    composer.requestSubmit()
  }
})

input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`
})

mode.addEventListener('change', () => {
  fetch('/api/mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: mode.value }),
  })
})

newChat.addEventListener('click', () => {
  fetch('/api/clear', { method: 'POST' })
})

function labelFor(name) {
  return { read_file: 'Read', write_file: 'Write', edit_file: 'Edit', glob: 'Glob', grep: 'Grep', bash: 'Bash' }[name] ?? name
}

function answered(status) {
  return { once: '已允许这一次', session: '本会话内允许', local: '已写入本地设置', deny: '已拒绝' }[status] ?? status
}

function setStatus(text) {
  status.textContent = text
}
