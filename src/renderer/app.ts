declare const browser: {
  newTab:         (url?: string)            => Promise<number>
  activateTab:    (id: number)              => Promise<void>
  closeTab:       (id: number)              => Promise<number[]>
  go:             (id: number, url: string) => Promise<void>
  back:           (id: number)              => Promise<void>
  forward:        (id: number)              => Promise<void>
  reload:         (id: number)              => Promise<void>
  stop:           (id: number)              => Promise<void>
  setPanelHeight: (h: number)              => Promise<void>
  on:             (ch: string, fn: (...a: unknown[]) => void) => void
}

interface Tab     { id: number; title: string; url: string; favicon?: string; loading: boolean }
interface NetEntry {
  id: string; method: string; url: string; type?: string
  status?: number; mimeType?: string
  startTime: number; endTime?: number; size?: number; failed?: boolean
}

// ── element refs ──────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!
const tabBar      = $('tab-bar')
const urlBar      = $('url-bar')      as HTMLInputElement
const btnBack     = $('btn-back')
const btnFwd      = $('btn-forward')
const btnRld      = $('btn-reload')
const panel       = $('panel')
const netTbody    = $('net-tbody')
const netEmpty    = $('net-empty')
const filterIn    = $('panel-filter') as HTMLInputElement
const btnPreserve = $('btn-preserve')

// ── tab state ─────────────────────────────────────────────────────────────
const tabs = new Map<number, Tab>()
let active: number | null = null

// ── net state ─────────────────────────────────────────────────────────────
const netLog  = new Map<number, NetEntry[]>()
const netById = new Map<number, Map<string, NetEntry>>()
let panelOpen   = false
let preserveLog = false
let netFilter   = ''
const PANEL_H   = 260

// ── helpers ───────────────────────────────────────────────────────────────
function toURL(s: string): string {
  s = s.trim()
  if (!s) return 'https://search.theradicalparty.com'
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  if (/^localhost(:\d+)?/.test(s) || /^[\d.]+:\d+/.test(s)) return `http://${s}`
  if (s.includes('.') && !s.includes(' ') && !s.startsWith('/')) return `https://${s}`
  return `https://search.theradicalparty.com/?q=${encodeURIComponent(s)}`
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)}K`
  return `${(b / 1048576).toFixed(1)}M`
}

// ── tab rendering ─────────────────────────────────────────────────────────
function renderTabs() {
  document.querySelectorAll('.tab').forEach(el => el.remove())
  const newBtn = $('btn-new-tab')
  tabs.forEach(tab => {
    const el      = document.createElement('div')
    el.className  = `tab${tab.id === active ? ' active' : ''}`
    el.dataset.id = String(tab.id)

    const fav  = document.createElement('img')
    fav.className = `tab-favicon${tab.favicon ? '' : ' hidden'}`
    if (tab.favicon) fav.src = tab.favicon

    const title = document.createElement('span')
    title.className   = 'tab-title'
    title.textContent = tab.loading ? 'Loading…' : (tab.title || tab.url || 'New Tab')

    const close = document.createElement('span')
    close.className   = 'tab-close'
    close.textContent = '×'
    close.addEventListener('mousedown', e => { e.stopPropagation(); closeTab(tab.id) })

    el.append(fav, title, close)
    el.addEventListener('mousedown', () => { if (tab.id !== active) activateTab(tab.id) })
    tabBar.insertBefore(el, newBtn)
  })
}

function syncURLBar() {
  if (active === null) return
  const tab = tabs.get(active)
  urlBar.value = (!tab || !tab.url || tab.url === 'about:blank') ? '' : tab.url
}

async function activateTab(id: number) {
  await browser.activateTab(id)
  active = id
  syncURLBar()
  renderTabs()
  if (panelOpen) renderNet()
}

async function closeTab(id: number) {
  const remaining = await browser.closeTab(id)
  tabs.delete(id)
  netLog.delete(id)
  netById.delete(id)
  if (remaining.length === 0) {
    const newId = await browser.newTab()
    tabs.set(newId, { id: newId, title: 'New Tab', url: '', loading: true })
    active = newId
  }
  syncURLBar()
  renderTabs()
  if (panelOpen) renderNet()
}

// ── network inspector ─────────────────────────────────────────────────────
async function togglePanel() {
  panelOpen = !panelOpen
  panel.classList.toggle('open', panelOpen)
  $('btn-net').style.color = panelOpen ? 'var(--accent)' : 'var(--text3)'
  await browser.setPanelHeight(panelOpen ? PANEL_H : 0)
  if (panelOpen) renderNet()
}

function renderNet() {
  const log  = netLog.get(active ?? -1) ?? []
  const rows = netFilter ? log.filter(e => e.url.toLowerCase().includes(netFilter)) : log

  netEmpty.style.display = rows.length === 0 ? '' : 'none'
  netTbody.innerHTML = rows.map(e => {
    const cls    = !e.status ? (e.failed ? 's-fail' : 's-pending')
                 : e.status < 300 ? 's-ok'
                 : e.status < 400 ? 's-redirect'
                 : 's-error'
    const time   = e.endTime ? `${((e.endTime - e.startTime) * 1000) | 0}ms` : '…'
    const size   = e.size != null ? fmtSize(e.size) : '—'
    const status = e.failed && !e.status ? 'fail' : (e.status ?? '…')
    const type   = e.type ?? (e.mimeType ? e.mimeType.split('/')[1] : '—')
    const short  = e.url.replace(/^https?:\/\/[^/]+/, '') || e.url
    return `<tr class="${cls}">
      <td class="net-method">${e.method}</td>
      <td class="net-url" title="${e.url}">${short || e.url}</td>
      <td class="net-status">${status}</td>
      <td class="net-type">${type}</td>
      <td class="net-size">${size}</td>
      <td class="net-time">${time}</td>
    </tr>`
  }).join('')

  $('net-table-wrap').scrollTop = $('net-table-wrap').scrollHeight
}

function getOrCreate(tabId: number) {
  if (!netLog.has(tabId))  netLog.set(tabId, [])
  if (!netById.has(tabId)) netById.set(tabId, new Map())
  return { log: netLog.get(tabId)!, idx: netById.get(tabId)! }
}

// ── net events ────────────────────────────────────────────────────────────
browser.on('net:req', (raw: unknown) => {
  const d = raw as { tabId: number; id: string; method: string; url: string; type: string; startTime: number }
  const { log, idx } = getOrCreate(d.tabId)
  const entry: NetEntry = { id: d.id, method: d.method, url: d.url, type: d.type, startTime: d.startTime }
  if (log.length > 500) idx.delete(log.shift()!.id)
  log.push(entry); idx.set(d.id, entry)
  if (d.tabId === active && panelOpen) renderNet()
})

browser.on('net:res', (raw: unknown) => {
  const d = raw as { tabId: number; id: string; status: number; mimeType: string }
  const entry = netById.get(d.tabId)?.get(d.id)
  if (!entry) return
  entry.status = d.status; entry.mimeType = d.mimeType
  if (d.tabId === active && panelOpen) renderNet()
})

browser.on('net:done', (raw: unknown) => {
  const d = raw as { tabId: number; id: string; endTime: number; size: number }
  const entry = netById.get(d.tabId)?.get(d.id)
  if (!entry) return
  entry.endTime = d.endTime; entry.size = d.size
  if (d.tabId === active && panelOpen) renderNet()
})

browser.on('net:fail', (raw: unknown) => {
  const d = raw as { tabId: number; id: string }
  const entry = netById.get(d.tabId)?.get(d.id)
  if (!entry) return
  entry.failed = true
  if (d.tabId === active && panelOpen) renderNet()
})

browser.on('net:clear', (raw: unknown) => {
  const { tabId } = raw as { tabId: number }
  if (preserveLog) return
  netLog.set(tabId, []); netById.set(tabId, new Map())
  if (tabId === active && panelOpen) renderNet()
})

// ── main process events ───────────────────────────────────────────────────
browser.on('init', (id: unknown) => {
  const tabId = id as number
  tabs.set(tabId, { id: tabId, title: 'New Tab', url: 'https://search.theradicalparty.com', loading: true })
  active = tabId
  renderTabs()
})

browser.on('activated', (id: unknown) => {
  active = id as number
  syncURLBar()
  renderTabs()
  if (panelOpen) renderNet()
})

browser.on('nav', (data: unknown) => {
  const { id, url } = data as { id: number; url: string }
  const tab = tabs.get(id); if (!tab) return
  tab.url = url
  if (id === active) syncURLBar()
})

browser.on('title', (data: unknown) => {
  const { id, title } = data as { id: number; title: string }
  const tab = tabs.get(id); if (!tab) return
  tab.title = title; renderTabs()
})

browser.on('loading', (data: unknown) => {
  const { id, v } = data as { id: number; v: boolean }
  const tab = tabs.get(id); if (!tab) return
  tab.loading = v
  if (id === active) btnRld.textContent = v ? '×' : '↻'
  renderTabs()
})

browser.on('favicon', (data: unknown) => {
  const { id, url } = data as { id: number; url: string }
  const tab = tabs.get(id); if (!tab) return
  tab.favicon = url; renderTabs()
})

// ── keyboard from main (menu shortcuts + WebContentsView interception) ────
browser.on('key', (k: unknown) => handleKey(k as string))

async function handleKey(key: string) {
  switch (key) {
    case 'i': togglePanel(); break
    case 't': {
      const id = await browser.newTab()
      tabs.set(id, { id, title: 'New Tab', url: '', loading: true })
      active = id; renderTabs(); urlBar.focus(); break
    }
    case 'w': if (active !== null) closeTab(active); break
    case 'l': urlBar.focus(); break
    case 'r': if (active !== null) browser.reload(active); break
    case '[': if (active !== null) browser.back(active); break
    case ']': if (active !== null) browser.forward(active); break
  }
}

// ── chrome renderer keyboard (URL bar has focus, etc.) ───────────────────
document.addEventListener('keydown', e => {
  if (e.metaKey && e.key !== 'k') handleKey(e.key.toLowerCase())
})

// ── UI events ─────────────────────────────────────────────────────────────
$('btn-new-tab').addEventListener('click', async () => {
  const id = await browser.newTab()
  tabs.set(id, { id, title: 'New Tab', url: '', loading: true })
  active = id; renderTabs(); urlBar.focus()
})

urlBar.addEventListener('keydown', async e => {
  if (e.key !== 'Enter' || active === null) return
  await browser.go(active, toURL(urlBar.value))
})
urlBar.addEventListener('focus', () => urlBar.select())

btnBack.addEventListener('click',  () => active !== null && browser.back(active))
btnFwd.addEventListener('click',   () => active !== null && browser.forward(active))
btnRld.addEventListener('click',   () => {
  if (active === null) return
  tabs.get(active)?.loading ? browser.stop(active) : browser.reload(active)
})
$('btn-net').addEventListener('click', togglePanel)

$('btn-net-clear').addEventListener('click', () => {
  if (active !== null) { netLog.set(active, []); netById.set(active, new Map()); renderNet() }
})
btnPreserve.addEventListener('click', () => {
  preserveLog = !preserveLog
  btnPreserve.classList.toggle('active', preserveLog)
})
filterIn.addEventListener('input', () => { netFilter = filterIn.value.toLowerCase(); renderNet() })
