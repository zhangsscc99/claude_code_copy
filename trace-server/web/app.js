const tracesEl = document.getElementById('traces')
const statsEl = document.getElementById('stats')
const emptyEl = document.getElementById('empty')
const waterfallEl = document.getElementById('waterfall')
const rowsEl = document.getElementById('rows')
const metaEl = document.getElementById('trace-meta')
const spanDetailEl = document.getElementById('span-detail')

let selected = null

const fmt = {
  ms: (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`),
  time: (v) => new Date(v).toLocaleTimeString(),
  num: (v) => (v >= 10000 ? `${(v / 1000).toFixed(1)}k` : String(v)),
}

async function loadStats() {
  const stats = await fetch('/api/stats').then((r) => r.json())
  const t = stats.totals
  const models = Object.entries(stats.models)
    .map(([m, a]) => `${m}: ${a.calls} calls ${fmt.num(a.inputTokens)}in/${fmt.num(a.outputTokens)}out`)
    .join(' · ')
  statsEl.innerHTML =
    `<span>traces <b>${t.traces}</b></span>` +
    `<span>spans <b>${t.spans}</b></span>` +
    `<span>errors <b>${t.errors}</b></span>` +
    `<span>tokens <b>${fmt.num(t.inputTokens)}</b> in / <b>${fmt.num(t.outputTokens)}</b> out</span>` +
    (models ? `<span>${models}</span>` : '')
}

async function loadTraces() {
  const { traces } = await fetch('/api/traces?limit=100').then((r) => r.json())
  tracesEl.innerHTML = ''
  for (const t of traces) {
    const li = document.createElement('li')
    li.dataset.id = t.traceId
    if (t.traceId === selected) li.classList.add('active')
    li.innerHTML =
      `<div class="t-line"><span>${t.name}</span><span class="badge ${t.status}">${t.status}</span></div>` +
      `<div class="t-line"><span class="t-id">${t.traceId.slice(0, 8)}</span>` +
      `<span class="t-id">${fmt.time(t.startedAt)} · ${fmt.ms(t.durationMs)} · ${t.spanCount} spans` +
      (t.errorCount ? ` · ${t.errorCount} err` : '') +
      (t.inputTokens ? ` · ${fmt.num(t.inputTokens)}tok` : '') +
      `</span></div>`
    li.onclick = () => selectTrace(t.traceId)
    tracesEl.appendChild(li)
  }
}

async function selectTrace(id) {
  selected = id
  for (const li of tracesEl.children) li.classList.toggle('active', li.dataset.id === id)
  const { summary, spans } = await fetch(`/api/traces/${id}`).then((r) => r.json())
  render(summary, spans)
}

function render(summary, spans) {
  emptyEl.hidden = true
  waterfallEl.hidden = false
  const t0 = Math.min(...spans.map((s) => s.startedAt))
  const t1 = Math.max(...spans.map((s) => s.endedAt))
  const range = Math.max(1, t1 - t0)

  metaEl.innerHTML =
    `<span>trace <b>${summary.traceId}</b></span>` +
    `<span>status <b>${summary.status}</b></span>` +
    (summary.model ? `<span>model <b>${summary.model}</b></span>` : '') +
    (summary.stopReason ? `<span>stop <b>${summary.stopReason}</b></span>` : '') +
    `<span>duration <b>${fmt.ms(summary.durationMs)}</b></span>` +
    `<span>tokens <b>${fmt.num(summary.inputTokens)}</b> in / <b>${fmt.num(summary.outputTokens)}</b> out</span>`

  // depth for indentation: walk parents
  const byId = new Map(spans.map((s) => [s.spanId, s]))
  const depth = (s) => {
    let d = 0
    let cur = s
    while (cur.parentSpanId && byId.has(cur.parentSpanId)) {
      d += 1
      cur = byId.get(cur.parentSpanId)
      if (d > 8) break
    }
    return d
  }

  rowsEl.innerHTML = ''
  const axis = document.createElement('div')
  axis.className = 'axis'
  axis.innerHTML = `<span>${fmt.time(t0)}</span><span>+${fmt.ms(range)}</span>`
  rowsEl.appendChild(axis)

  for (const s of spans) {
    const row = document.createElement('div')
    row.className = 'row'
    const left = ((s.startedAt - t0) / range) * 100
    const width = Math.max(0.4, (s.durationMs / range) * 100)
    row.innerHTML =
      `<span class="label"><span class="indent">${'· '.repeat(depth(s))}</span>${s.kind}:${s.name}</span>` +
      `<span class="bar-area"><span class="bar ${s.kind} ${s.status === 'error' ? 'error' : ''}" ` +
      `style="left:${left}%;width:${width}%"></span>` +
      `<span class="dur" style="left:${Math.min(left + width + 0.5, 92)}%">${fmt.ms(s.durationMs)}</span></span>`
    row.onclick = () => showSpan(s)
    rowsEl.appendChild(row)
  }
}

function showSpan(s) {
  spanDetailEl.hidden = false
  const attrs = s.attrs ? JSON.stringify(s.attrs, null, 2) : '{}'
  spanDetailEl.innerHTML =
    `<h3>${s.kind}: ${s.name}${s.status === 'error' ? ' <span class="err">✕</span>' : ''}</h3>` +
    `span ${s.spanId}\nparent ${s.parentSpanId ?? '-'}\n` +
    `${fmt.time(s.startedAt)} → +${fmt.ms(s.durationMs)}${s.model ? `\nmodel ${s.model}` : ''}` +
    (s.error ? `\n<span class="err">error: ${s.error}</span>` : '') +
    `\nattrs ${attrs}`
  spanDetailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

// live updates
const es = new EventSource('/api/events')
es.onmessage = (msg) => {
  let event
  try {
    event = JSON.parse(msg.data)
  } catch {
    return
  }
  if (event.type === 'trace' || event.type === 'span') {
    loadTraces()
    loadStats()
    if (selected && event.data && event.data.traceId === selected) selectTrace(selected)
  }
}

loadStats()
loadTraces()
setInterval(loadStats, 5000)
