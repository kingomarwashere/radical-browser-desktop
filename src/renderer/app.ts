declare const browser: {
  newTab:      (url?: string)            => Promise<number>
  activateTab: (id: number)              => Promise<void>
  closeTab:    (id: number)              => Promise<number[]>
  go:          (id: number, url: string) => Promise<void>
  back:        (id: number)              => Promise<void>
  forward:     (id: number)             => Promise<void>
  reload:      (id: number)              => Promise<void>
  stop:        (id: number)              => Promise<void>
  on:          (ch: string, fn: (...a: unknown[]) => void) => void
}

interface Tab { id: number; title: string; url: string; favicon?: string; loading: boolean }

const $ = (id: string) => document.getElementById(id)!
const tabBar   = $('tab-bar')
const urlBar   = $('url-bar') as HTMLInputElement
const btnBack  = $('btn-back')
const btnFwd   = $('btn-forward')
const btnRld   = $('btn-reload')

const state = new Map<number, Tab>()
let active: number | null = null

function toURL(input: string): string {
  const s = input.trim()
  if (!s) return 'https://duckduckgo.com'
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  if (/^localhost(:\d+)?/.test(s) || /^[\d.]+:\d+/.test(s)) return `http://${s}`
  if (s.includes('.') && !s.includes(' ') && !s.startsWith('/')) return `https://${s}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`
}

function renderTabs() {
  document.querySelectorAll('.tab').forEach(el => el.remove())
  const newBtn = $('btn-new-tab')
  state.forEach(tab => {
    const el = document.createElement('div')
    el.className = `tab${tab.id === active ? ' active' : ''}`
    el.dataset.id = String(tab.id)

    const fav = document.createElement('img')
    fav.className = `tab-favicon${tab.favicon ? '' : ' hidden'}`
    if (tab.favicon) fav.src = tab.favicon

    const title = document.createElement('span')
    title.className = 'tab-title'
    title.textContent = tab.loading ? 'Loading…' : (tab.title || tab.url || 'New Tab')

    const close = document.createElement('span')
    close.className = 'tab-close'
    close.textContent = '×'
    close.addEventListener('mousedown', e => { e.stopPropagation(); closeTab(tab.id) })

    el.append(fav, title, close)
    el.addEventListener('mousedown', () => { if (tab.id !== active) activateTab(tab.id) })
    tabBar.insertBefore(el, newBtn)
  })
}

function syncURLBar() {
  if (active === null) return
  const tab = state.get(active)
  if (!tab) return
  urlBar.value = tab.url === 'about:blank' || !tab.url ? '' : tab.url
}

async function activateTab(id: number) {
  await browser.activateTab(id)
  active = id
  syncURLBar()
  renderTabs()
}

async function closeTab(id: number) {
  const remaining = await browser.closeTab(id)
  state.delete(id)
  if (remaining.length === 0) {
    const newId = await browser.newTab()
    state.set(newId, { id: newId, title: 'New Tab', url: '', loading: true })
    active = newId
  }
  syncURLBar()
  renderTabs()
}

// ── main process events ────────────────────────────────────────────────────

browser.on('init', (id: unknown) => {
  const tabId = id as number
  state.set(tabId, { id: tabId, title: 'New Tab', url: 'https://duckduckgo.com', loading: true })
  active = tabId
  renderTabs()
})

browser.on('activated', (id: unknown) => {
  active = id as number
  syncURLBar()
  renderTabs()
})

browser.on('nav', (data: unknown) => {
  const { id, url } = data as { id: number; url: string }
  const tab = state.get(id)
  if (!tab) return
  tab.url = url
  if (id === active) syncURLBar()
})

browser.on('title', (data: unknown) => {
  const { id, title } = data as { id: number; title: string }
  const tab = state.get(id)
  if (!tab) return
  tab.title = title
  renderTabs()
})

browser.on('loading', (data: unknown) => {
  const { id, v } = data as { id: number; v: boolean }
  const tab = state.get(id)
  if (!tab) return
  tab.loading = v
  if (id === active) btnRld.textContent = v ? '×' : '↻'
  renderTabs()
})

browser.on('favicon', (data: unknown) => {
  const { id, url } = data as { id: number; url: string }
  const tab = state.get(id)
  if (!tab) return
  tab.favicon = url
  renderTabs()
})

// ── UI events ──────────────────────────────────────────────────────────────

$('btn-new-tab').addEventListener('click', async () => {
  const id = await browser.newTab()
  state.set(id, { id, title: 'New Tab', url: '', loading: true })
  active = id
  renderTabs()
  urlBar.focus()
})

urlBar.addEventListener('keydown', async e => {
  if (e.key !== 'Enter' || active === null) return
  const url = toURL(urlBar.value)
  await browser.go(active, url)
})

urlBar.addEventListener('focus', () => urlBar.select())

btnBack.addEventListener('click',   () => active !== null && browser.back(active))
btnFwd.addEventListener('click',    () => active !== null && browser.forward(active))
btnRld.addEventListener('click',    () => {
  if (active === null) return
  const tab = state.get(active)
  tab?.loading ? browser.stop(active) : browser.reload(active)
})

// ── keyboard shortcuts ────────────────────────────────────────────────────

document.addEventListener('keydown', async e => {
  if (e.metaKey && e.key === 't') {
    e.preventDefault()
    const id = await browser.newTab()
    state.set(id, { id, title: 'New Tab', url: '', loading: true })
    active = id
    renderTabs()
    urlBar.focus()
  }
  if (e.metaKey && e.key === 'w') {
    e.preventDefault()
    if (active !== null) closeTab(active)
  }
  if (e.metaKey && e.key === 'l') {
    e.preventDefault()
    urlBar.focus()
  }
  if (e.metaKey && e.key === 'r') {
    e.preventDefault()
    if (active !== null) browser.reload(active)
  }
  if (e.metaKey && e.key === '[') {
    e.preventDefault()
    if (active !== null) browser.back(active)
  }
  if (e.metaKey && e.key === ']') {
    e.preventDefault()
    if (active !== null) browser.forward(active)
  }
})
