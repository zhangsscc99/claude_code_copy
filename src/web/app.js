const transcript = document.querySelector('#transcript')
const input = document.querySelector('#input')
const composer = document.querySelector('#composer')
const send = document.querySelector('#send')
const mode = document.querySelector('#mode')
const cwd = document.querySelector('#cwd')
const model = document.querySelector('#model')
const status = document.querySelector('#status')
const newChat = document.querySelector('#new-chat')
const compactButton = document.querySelector('#compact')
const collapseButton = document.querySelector('#collapse')

const NEAR_BOTTOM = 80
const state = { items: [], busy: false, compacting: false, collapsing: false, mode: 'default' }
let sending = false

boot().catch((error) => setStatus(error instanceof Error ? error.message : String(error)))

async function boot() {
  const response = await fetch('/api/state')
  if (!response.ok) throw new Error('无法读取会话状态')
  const body = await response.json()
  state.items = Array.isArray(body.timeline) ? body.timeline : []
  state.busy = Boolean(body.busy)
  state.compacting = Boolean(body.compacting)
  state.collapsing = Boolean(body.collapsing)
  state.mode = body.permissionMode
  cwd.textContent = body.cwd ?? ''
  cwd.title = cwd.textContent
  model.textContent = `${body.provider ?? ''} / ${body.model ?? ''}`
  model.title = model.textContent
  if (typeof body.permissionMode === 'string') mode.value = body.permissionMode
  render()
  listen()
}

function listen() {
  const source = new EventSource('/api/events')
  source.onmessage = (event) => {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (apply(data)) render()
  }
  source.onerror = () => setStatus('连接中断，正在重连')
}

function apply(event) {
  if (!event || typeof event !== 'object') return false
  if (event.type === 'ready') {
    setStatus(state.collapsing ? '正在折叠上下文' : state.busy ? '处理中' : '就绪')
    return false
  }
  if (event.type === 'busy') {
    state.busy = Boolean(event.busy)
    return true
  }
  if (event.type === 'compacting') {
    state.compacting = Boolean(event.compacting)
    return true
  }
  if (event.type === 'collapsing') {
    state.collapsing = Boolean(event.collapsing)
    return true
  }
  if (event.type === 'mode') {
    state.mode = event.mode
    if (typeof event.mode === 'string') mode.value = event.mode
    return true
  }
  if (event.type === 'cleared') {
    state.items = []
    return true
  }
  if (event.type === 'user') {
    state.items.push({ kind: 'user', text: event.text ?? '' })
    return true
  }
  if (event.type === 'assistant') {
    state.items.push({ kind: 'assistant', text: event.text ?? '' })
    return true
  }
  if (event.type === 'notice') {
    state.items.push({ kind: 'notice', text: event.text ?? '' })
    return true
  }
  if (event.type === 'tool_start') {
    state.items.push({
      kind: 'tool',
      name: event.name,
      preview: event.preview ?? '',
      output: '',
      isError: false,
      pending: true,
      open: false,
    })
    return true
  }
  if (event.type === 'tool_end') {
    const tool = findPendingTool()
    if (tool) {
      tool.output = event.output ?? ''
      tool.isError = Boolean(event.isError)
      tool.pending = false
    }
    return true
  }
  if (event.type === 'permission') {
    state.items.push({
      kind: 'permission',
      id: event.id,
      name: event.name,
      preview: event.preview ?? '',
      reason: event.reason ?? '',
      saveRule: event.saveRule ?? '',
      status: 'pending',
    })
    return true
  }
  if (event.type === 'permission_resolved') {
    const card = state.items.find((item) => item.kind === 'permission' && item.id === event.id)
    if (card) card.status = event.answer
    return true
  }
  return false
}

function findPendingTool() {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index]
    if (item.kind === 'tool' && item.pending) return item
  }
  return undefined
}

function render() {
  const distance = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
  const stick = distance < NEAR_BOTTOM
  const previousTop = transcript.scrollTop
  transcript.replaceChildren()
  const column = document.createElement('div')
  column.className = 'column'
  if (state.items.length === 0) column.append(emptyState())
  else {
    for (const item of state.items) column.append(renderItem(item))
  }
  transcript.append(column)
  const locked = state.busy || state.compacting || state.collapsing
  input.disabled = locked
  send.disabled = locked
  newChat.disabled = locked
  compactButton.disabled = locked
  collapseButton.disabled = locked
  setStatus(state.compacting ? '正在压缩上下文' : state.collapsing ? '正在折叠上下文' : state.busy ? '处理中' : '就绪')
  transcript.scrollTop = stick ? transcript.scrollHeight : previousTop
}

function emptyState() {
  const block = document.createElement('div')
  block.className = 'emptyState'
  const title = document.createElement('h2')
  title.textContent = '今天想改什么？'
  const copy = document.createElement('p')
  copy.textContent = '直接描述任务。读文件会在工作目录里进行，改文件和命令需要你确认。'
  block.append(title, copy)
  return block
}

function renderItem(item) {
  if (item.kind === 'user') return userBubble(item.text)
  if (item.kind === 'assistant') return assistantBlock(item.text)
  if (item.kind === 'notice') return notice(item.text)
  if (item.kind === 'tool') return toolBlock(item)
  if (item.kind === 'permission') return permissionBlock(item)
  return document.createElement('div')
}

function userBubble(text) {
  const node = document.createElement('div')
  node.className = 'userBubble'
  node.textContent = text
  return node
}

function notice(text) {
  const node = document.createElement('div')
  node.className = 'notice'
  node.textContent = text
  return node
}

function assistantBlock(text) {
  const node = document.createElement('div')
  node.className = 'assistantText'
  const pattern = /```([\s\S]*?)```/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    appendText(node, text.slice(cursor, index))
    const pre = document.createElement('pre')
    pre.textContent = (match[1] ?? '').replace(/^\w+\n/, '')
    node.append(pre)
    cursor = index + match[0].length
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
      continue
    }
    appendPlain(node, part)
  }
}

function appendPlain(node, text) {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) node.append(document.createElement('br'))
    if (lines[index]) node.append(document.createTextNode(lines[index]))
  }
}

function toolBlock(item) {
  const wrap = document.createElement('div')
  wrap.className = 'tool'
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'toolRow'
  row.setAttribute('aria-expanded', item.open ? 'true' : 'false')
  const title = document.createElement('span')
  title.className = 'toolTitle'
  title.textContent = labelFor(item.name)
  const sep = document.createElement('span')
  sep.className = 'toolSep'
  sep.setAttribute('aria-hidden', 'true')
  const summary = document.createElement('span')
  summary.className = 'toolSummary'
  summary.textContent = item.preview ?? ''
  const marker = document.createElement('span')
  marker.className = 'toolState'
  marker.textContent = item.pending ? '进行中' : item.isError ? '失败' : '完成'
  if (!item.pending && item.isError) {
    wrap.dataset.state = 'error'
    marker.dataset.state = 'error'
  }
  row.append(title, sep, summary, marker)
  const body = document.createElement('pre')
  body.className = 'toolBody'
  body.hidden = !item.open
  body.textContent = item.output ?? ''
  row.addEventListener('click', () => {
    item.open = !item.open
    body.hidden = !item.open
    row.setAttribute('aria-expanded', item.open ? 'true' : 'false')
  })
  wrap.append(row, body)
  return wrap
}

function permissionBlock(item) {
  const card = document.createElement('div')
  card.className = 'permissionCard'
  card.append(line(item.reason), line(`${labelFor(item.name)}  ${item.preview ?? ''}`), line(item.saveRule))
  if (item.status === 'pending') {
    const actions = document.createElement('div')
    actions.className = 'permissionActions'
    for (const [answer, label] of [
      ['once', '允许一次'],
      ['session', '本会话允许'],
      ['local', '写入本地设置'],
      ['deny', '拒绝'],
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.disabled = Boolean(item.answering)
      button.addEventListener('click', () => respond(item, answer))
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

function line(text) {
  const node = document.createElement('div')
  node.textContent = text ?? ''
  return node
}

async function respond(item, answer) {
  if (item.status !== 'pending' || item.answering) return
  item.answering = true
  render()
  try {
    const response = await fetch('/api/permissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, answer }),
    })
    if (!response.ok) {
      item.answering = false
      render()
    }
  } catch {
    item.answering = false
    render()
  }
}

composer.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (!text || state.busy || sending) return
  sending = true
  input.value = ''
  growInput()
  try {
    await fetch('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  } finally {
    sending = false
  }
})

input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  if (state.busy || sending || send.disabled) return
  composer.requestSubmit()
})

input.addEventListener('input', growInput)

mode.addEventListener('change', () => {
  fetch('/api/mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: mode.value }),
  })
})

newChat.addEventListener('click', () => {
  if (state.busy || newChat.disabled) return
  fetch('/api/clear', { method: 'POST' })
})

compactButton.addEventListener('click', () => {
  if (state.busy || state.compacting || state.collapsing) return
  fetch('/api/compact', { method: 'POST' })
})

collapseButton.addEventListener('click', () => {
  if (state.busy || state.compacting || state.collapsing) return
  fetch('/api/collapse', { method: 'POST' })
})

function growInput() {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`
}

function labelFor(name) {
  return (
    {
      read_file: 'Read',
      write_file: 'Write',
      edit_file: 'Edit',
      glob: 'Glob',
      grep: 'Grep',
      bash: 'Bash',
    }[name] ?? name
  )
}

function answered(statusValue) {
  return (
    {
      once: '已允许这一次',
      session: '本会话内允许',
      local: '已写入本地设置',
      deny: '已拒绝',
    }[statusValue] ?? statusValue
  )
}

function setStatus(text) {
  status.textContent = text
}
