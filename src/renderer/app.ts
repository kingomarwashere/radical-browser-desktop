declare const browser: {
  newTab:          (url?: string)            => Promise<number>
  activateTab:     (id: number)              => Promise<void>
  closeTab:        (id: number)              => Promise<number[]>
  go:              (id: number, url: string) => Promise<void>
  back:            (id: number)              => Promise<void>
  forward:         (id: number)              => Promise<void>
  reload:          (id: number)              => Promise<void>
  hardReload:      (id: number)              => Promise<void>
  stop:            (id: number)              => Promise<void>
  tabMenu:         (id: number)              => Promise<void>
  togglePanel:     ()                        => Promise<{ open: boolean }>
  torStatus:       ()                        => Promise<{ installed: boolean; state: string; progress: number }>
  torToggle:       ()                        => Promise<{ installed: boolean; state: string; progress: number }>
  saveSession:     (data: object)           => void
  getBookmarks:    ()                        => Promise<{ url: string; title: string; favicon?: string }[]>
  toggleBookmark:  (bm: object)             => Promise<{ url: string; title: string; favicon?: string }[]>
  on:              (ch: string, fn: (...a: unknown[]) => void) => void
}

interface Tab { id: number; title: string; url: string; favicon?: string; loading: boolean; sleeping?: boolean; keepAwake?: boolean }

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!
const tabBar  = $('tab-bar')
const urlBar  = $('url-bar')    as HTMLInputElement
const btnBack = $('btn-back')
const btnFwd  = $('btn-forward')
const btnRld  = $('btn-reload')

// ── Tab state ─────────────────────────────────────────────────────────────
const tabs = new Map<number, Tab>()
let active: number | null = null
// Explicit display order of tab ids (Map insertion order would always append).
const order: number[] = []

// Place a newly-opened tab: right after the currently-active tab, so ⌘T opens
// next to the tab you're on rather than at the far end of the bar.
function placeTab(id: number) {
  if (order.includes(id)) return
  const i = active !== null ? order.indexOf(active) : -1
  if (i >= 0) order.splice(i + 1, 0, id)
  else order.push(id)
}

// Persist the open tabs (URLs, order, active) so a restart restores them.
// Debounced — bursts of nav/open/close events collapse into one write.
let restoring = false
let sessionTimer: ReturnType<typeof setTimeout> | undefined
function persistSession() {
  if (restoring) return
  clearTimeout(sessionTimer)
  sessionTimer = setTimeout(() => {
    const ids = order.filter(id => tabs.has(id))
    const urls = ids.map(id => {
      const u = tabs.get(id)!.url
      return u && u !== 'about:blank' ? u : 'about:blank'
    })
    const activeIndex = active !== null ? Math.max(0, ids.indexOf(active)) : 0
    browser.saveSession({ tabs: urls, activeIndex })
  }, 500)
}

// ── Bookmark state ────────────────────────────────────────────────────────
let bookmarkedURLs = new Set<string>()
browser.getBookmarks().then(bms => { bookmarkedURLs = new Set(bms.map(b => b.url)); updateBookmarkBtn() })

function updateBookmarkBtn() {
  const tab    = active !== null ? tabs.get(active) : null
  const url    = tab?.url || ''
  const btn    = $('btn-bookmark')
  const valid  = !!url && url !== 'about:blank'
  const marked = valid && bookmarkedURLs.has(url)
  btn.textContent = marked ? '★' : '☆'
  btn.classList.toggle('bookmarked', marked)
  btn.style.opacity = valid ? '1' : '0.3'
}

// ── Helpers ───────────────────────────────────────────────────────────────
const SEARCH_URL = 'https://search.theradicalparty.com'
function toURL(s: string): string {
  s = s.trim()
  if (!s) return SEARCH_URL
  // Explicit schemes pass through
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:') || s.startsWith('view-source:')) return s
  // localhost / IP:port → http
  if (/^localhost(:\d+)?(\/.*)?$/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(s)) return `http://${s}`
  // Looks like a real domain: host.tld (2+ letter TLD), optional port/path, no spaces
  const domainLike = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/.*)?$/i
  if (!s.includes(' ') && domainLike.test(s)) return `https://${s}`
  // Everything else → radical search
  return `${SEARCH_URL}/?q=${encodeURIComponent(s)}`
}

// ── Tab rendering (incremental — reuse elements, no full teardown) ──────────
// Rebuilding the whole bar on every title/favicon/loading event recreated each
// <img>, causing favicon flicker + re-fetch and re-attached listeners. Instead
// we keep a persistent element per tab and mutate only what changed.
const tabEls = new Map<number, HTMLElement>()

function makeTabEl(id: number): HTMLElement {
  const el = document.createElement('div')
  el.dataset.id = String(id)
  const fav = document.createElement('img')
  fav.className = 'tab-favicon hidden'
  const title = document.createElement('span')
  title.className = 'tab-title'
  const close = document.createElement('span')
  close.className = 'tab-close'; close.textContent = '×'
  close.addEventListener('mousedown', e => { e.stopPropagation(); closeTab(id) })
  el.append(fav, title, close)
  el.addEventListener('mousedown', () => { if (id !== active) activateTab(id) })
  // Right-click → keep-awake / sleep-now menu (native, built in main)
  el.addEventListener('contextmenu', e => { e.preventDefault(); browser.tabMenu(id) })
  tabEls.set(id, el)
  return el
}

function renderTabs() {
  const newBtn = $('btn-new-tab')
  // Reconcile the order list with live tabs: append any that arrived without an
  // explicit position, drop any that closed. Keeps display order authoritative.
  tabs.forEach((_, id) => { if (!order.includes(id)) order.push(id) })
  for (let i = order.length - 1; i >= 0; i--) if (!tabs.has(order[i])) order.splice(i, 1)
  // Drop elements for tabs that no longer exist
  for (const [id, el] of tabEls) {
    if (!tabs.has(id)) { el.remove(); tabEls.delete(id) }
  }
  order.forEach(id => {
    const tab = tabs.get(id)!
    const el = tabEls.get(tab.id) ?? makeTabEl(tab.id)
    const activeCls = `tab${tab.id === active ? ' active' : ''}${tab.sleeping ? ' sleeping' : ''}`
    if (el.className !== activeCls) el.className = activeCls
    // Slept tabs dim; keep the pointer affordance out of the way
    const wantOpacity = tab.sleeping ? '0.5' : ''
    if (el.style.opacity !== wantOpacity) el.style.opacity = wantOpacity

    const fav = el.firstChild as HTMLImageElement
    const wantFav = tab.favicon || ''
    if ((fav.getAttribute('src') || '') !== wantFav) {
      if (wantFav) { fav.src = wantFav; fav.classList.remove('hidden') }
      else { fav.removeAttribute('src'); fav.classList.add('hidden') }
    }

    const title = fav.nextSibling as HTMLElement
    const base = tab.loading ? 'Loading…' : (tab.title || tab.url || 'New Tab')
    const wantTitle = `${tab.keepAwake ? '📌 ' : ''}${tab.sleeping ? '💤 ' : ''}${base}`
    if (title.textContent !== wantTitle) title.textContent = wantTitle
    const wantTip = tab.keepAwake ? 'Kept awake — right-click to allow sleeping' : (tab.sleeping ? 'Sleeping to save memory — click to wake' : '')
    if (title.getAttribute('title') !== wantTip) title.setAttribute('title', wantTip)

    // Keep DOM order in sync (moving an existing node doesn't reload its img)
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
  active = id; syncURLBar(); renderTabs()
}

async function closeTab(id: number) {
  const remaining = await browser.closeTab(id)
  tabs.delete(id)
  if (remaining.length === 0) {
    const newId = await browser.newTab()
    tabs.set(newId, { id: newId, title: 'New Tab', url: '', loading: true })
    active = newId
  }
  syncURLBar(); renderTabs(); persistSession()
}

// ── Panel toggle ──────────────────────────────────────────────────────────
let panelToggling = false
async function togglePanel() {
  if (panelToggling) return
  panelToggling = true
  try {
    await browser.togglePanel()
  } finally {
    panelToggling = false
  }
}

// ── Main process events ───────────────────────────────────────────────────
browser.on('init', (id: unknown) => {
  const tabId = id as number
  tabs.set(tabId, { id: tabId, title: 'New Tab', url: 'https://search.theradicalparty.com', loading: true })
  active = tabId; renderTabs()
})
// Rebuild the tab strip from a saved session (order + active preserved).
browser.on('session:restore', (data: unknown) => {
  const { tabs: list, activeId } = data as { tabs: { id: number; url: string }[]; activeId: number }
  restoring = true
  tabs.clear(); order.length = 0
  list.forEach(t => {
    tabs.set(t.id, { id: t.id, title: '', url: t.url === 'about:blank' ? '' : t.url, loading: true })
    order.push(t.id)
  })
  active = activeId
  syncURLBar(); renderTabs(); updateBookmarkBtn()
  restoring = false
  persistSession()
})
browser.on('activated', (id: unknown) => {
  active = id as number; syncURLBar(); renderTabs(); updateBookmarkBtn(); persistSession()
})
browser.on('nav', (data: unknown) => {
  const { id, url } = data as { id: number; url: string }
  const tab = tabs.get(id); if (!tab) return
  tab.url = url; if (id === active) { syncURLBar(); updateBookmarkBtn() }
  persistSession()
})
browser.on('nav-state', (data: unknown) => {
  const { id, canGoBack, canGoForward } = data as { id: number; canGoBack: boolean; canGoForward: boolean }
  if (id !== active) return
  btnBack.classList.toggle('dim', !canGoBack)
  btnFwd.classList.toggle('dim', !canGoForward)
})
browser.on('focus-url', () => { urlBar.focus(); urlBar.select() })
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
browser.on('tab:sleep', (data: unknown) => {
  const { id } = data as { id: number }
  const tab = tabs.get(id); if (!tab) return
  tab.sleeping = true; tab.loading = false; renderTabs()
})
browser.on('tab:wake', (data: unknown) => {
  const { id } = data as { id: number }
  const tab = tabs.get(id); if (!tab) return
  tab.sleeping = false; renderTabs()
})
browser.on('tab:keepawake', (data: unknown) => {
  const { id, on } = data as { id: number; on: boolean }
  const tab = tabs.get(id); if (!tab) return
  tab.keepAwake = on; renderTabs()
})

// ── Key handler ───────────────────────────────────────────────────────────
browser.on('key', (k: unknown) => handleKey(k as string))
document.addEventListener('keydown', e => {
  if (!e.metaKey) return
  const key = e.key.toLowerCase()
  if (key === 'k') return  // palette handled in main
  if (key === 'r' && e.shiftKey) { e.preventDefault(); handleKey('R'); return }  // hard reload
  if (!['t','w','r','[',']','l','i'].includes(key)) return
  e.preventDefault()
  handleKey(key)
})

// tab:opened fires when main creates a new tab (menu, palette, or btn)
browser.on('tab:opened', (id: unknown) => {
  const tabId = id as number
  tabs.set(tabId, { id: tabId, title: 'New Tab', url: '', loading: true })
  placeTab(tabId)   // insert right after the tab that was active when ⌘T fired
  active = tabId; renderTabs(); persistSession()
  setTimeout(() => { urlBar.focus(); urlBar.select() }, 60)
})

async function handleKey(key: string) {
  switch (key) {
    case 't': browser.newTab(); break
    case 'w': if (active !== null) closeTab(active); break
    case 'r': if (active !== null) browser.reload(active); break
    case 'R': if (active !== null) browser.hardReload(active); break
    case '[': if (active !== null) browser.back(active); break
    case ']': if (active !== null) browser.forward(active); break
    case 'l': urlBar.focus(); urlBar.select(); break
    case 'i': togglePanel(); break
  }
}

// ── UI events ─────────────────────────────────────────────────────────────
$('btn-new-tab').addEventListener('click', () => browser.newTab())
urlBar.addEventListener('keydown', async e => {
  if (e.key !== 'Enter' || active === null) return
  await browser.go(active, toURL(urlBar.value))
})
urlBar.addEventListener('focus', () => urlBar.select())
btnBack.addEventListener('click',  () => active !== null && browser.back(active))
btnFwd.addEventListener('click',   () => active !== null && browser.forward(active))
btnRld.addEventListener('click',   e => {
  if (active === null) return
  if (tabs.get(active)?.loading) { browser.stop(active); return }
  ;(e as MouseEvent).shiftKey ? browser.hardReload(active) : browser.reload(active)
})
$('btn-bookmark').addEventListener('click', async () => {
  if (active === null) return
  const tab = tabs.get(active)
  if (!tab?.url || tab.url === 'about:blank') return
  const bms = await browser.toggleBookmark({ url: tab.url, title: tab.title || tab.url, favicon: tab.favicon })
  bookmarkedURLs = new Set(bms.map(b => b.url))
  updateBookmarkBtn()
})

// ── Tor toggle ─────────────────────────────────────────────────────────────
function renderTor(s: { installed: boolean; state: string; progress: number }) {
  const btn = $('btn-tor')
  btn.classList.toggle('starting', s.state === 'starting')
  btn.classList.toggle('on', s.state === 'on')
  const pct = s.state === 'starting' ? `<span class="tor-pct">${s.progress}</span>` : ''
  btn.innerHTML = `🧅${pct}`
  if (!s.installed)          btn.title = 'Tor: not installed (brew install tor)'
  else if (s.state === 'on') btn.title = 'Tor: ON — traffic routed through Tor. Click to disable.'
  else if (s.state === 'starting') btn.title = `Tor: connecting… ${s.progress}%`
  else                       btn.title = 'Tor: off. Click to route traffic through Tor.'
}
browser.on('tor:status', (raw: unknown) => renderTor(raw as any))
browser.torStatus().then(renderTor)
$('btn-tor').addEventListener('click', async () => renderTor(await browser.torToggle()))
