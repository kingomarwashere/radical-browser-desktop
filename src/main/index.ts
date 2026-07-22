import { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, MenuItem, MenuItemConstructorOptions, clipboard, shell } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import * as dns from 'node:dns/promises'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { spawn, execFile } from 'node:child_process'
import { homedir } from 'node:os'

// ── Bookmarks ─────────────────────────────────────────────────────────────────
interface Bookmark { url: string; title: string; favicon?: string }
function bookmarksPath() { return join(app.getPath('userData'), 'bookmarks.json') }
function loadBookmarks(): Bookmark[] {
  try { return existsSync(bookmarksPath()) ? JSON.parse(readFileSync(bookmarksPath(), 'utf8')) : [] }
  catch { return [] }
}
function saveBookmarks(bms: Bookmark[]) {
  try { writeFileSync(bookmarksPath(), JSON.stringify(bms, null, 2)) } catch {}
}

// ── Session restore ───────────────────────────────────────────────────────────
interface SavedSession { tabs: string[]; activeIndex: number }
function sessionPath() { return join(app.getPath('userData'), 'session.json') }
function saveSession(data: SavedSession) {
  try { writeFileSync(sessionPath(), JSON.stringify(data)) } catch {}
}
function loadSession(): SavedSession | null {
  try {
    if (!existsSync(sessionPath())) return null
    const d = JSON.parse(readFileSync(sessionPath(), 'utf8'))
    if (d && Array.isArray(d.tabs)) return { tabs: d.tabs, activeIndex: d.activeIndex ?? 0 }
  } catch {}
  return null
}

// ── Ad-block list ─────────────────────────────────────────────────────────────
const BLOCKED_HOSTS = new Set([
  // General
  'googlesyndication.com', 'doubleclick.net', 'googleadservices.com',
  'adservice.google.com', 'amazon-adsystem.com', 'ads.youtube.com',
  'scorecardresearch.com', 'quantserve.com', 'taboola.com', 'outbrain.com',
  'adsafeprotected.com', 'moatads.com', 'casalemedia.com', 'pubmatic.com',
  'rubiconproject.com', 'openx.net', 'rlcdn.com', 'adnxs.com',
  // Adult ad networks
  'trafficjunky.net', 'trafficjunky.com',
  'exoclick.com', 'juicyads.com', 'plugrush.com',
  'hilltopads.net', 'hilltopads.com',
  'bngpt.com', 'bidgear.com',
  'adspyglass.com', 'popads.net', 'popcash.net',
  'propellerads.com', 'propellerclick.com',
  'ero-advertising.com', 'adultadworld.com',
  'fuckingawesome.com', 'awempire.com',
  'traffichaus.com', 'adtng.com',
  'tpc.googlesyndication.com', 'pagead2.googlesyndication.com',
  'ads.trafficjunky.net',
  // Tracking / analytics
  'segment.io', 'segment.com', 'mixpanel.com',
  'hotjar.com', 'fullstory.com', 'mouseflow.com',
  'crazyegg.com', 'clarity.ms',
])
function isBlocked(url: string): boolean {
  // Hot path: runs on every network request. Walk the domain labels
  // (host, then each parent domain) doing O(labels) Set lookups — no array
  // allocation or full-list scan. Equivalent to exact-or-suffix match.
  let h: string
  try { h = new URL(url).hostname.toLowerCase() } catch { return false }
  if (h.startsWith('www.')) h = h.slice(4)
  while (h) {
    if (BLOCKED_HOSTS.has(h)) return true
    const dot = h.indexOf('.')
    if (dot === -1) return false
    h = h.slice(dot + 1)
  }
  return false
}

// ── Resource type normalisation (webRequest → CDP style) ──────────────────────
function normType(t: string): string {
  const m: Record<string, string> = {
    mainFrame: 'Document', subFrame: 'Document', stylesheet: 'Stylesheet',
    script: 'Script', image: 'Image', font: 'Font', xhr: 'XHR', fetch: 'Fetch',
    media: 'Media', websocket: 'WebSocket', other: 'Other',
  }
  return m[t] ?? t
}

// ── State ─────────────────────────────────────────────────────────────────────
interface TabMeta { title: string; url: string; favicon?: string }
let win: BrowserWindow
let paletteWin: BrowserWindow | null = null
const tabs    = new Map<number, WebContentsView>()
const tabMeta = new Map<number, TabMeta>()
let activeId: number | null = null

// ── Sleeping tabs (memory saver) ──────────────────────────────────────────────
// A background tab idle past the threshold is "slept": navigated to about:blank
// to release its page's DOM/JS heap/images (the bulk of a tab's RAM), keeping
// the real URL to restore on wake. The webContents (and thus the tab id) stays
// stable, so nothing downstream breaks. Never sleeps the active tab, a tab the
// user pinned awake, or a tab playing audio.
const SLEEP_AFTER_MS = 30 * 60 * 1000            // 30 min idle → sleep
const lastActive  = new Map<number, number>()    // tabId → ms it last went inactive
const keepAwake   = new Set<number>()            // tabs the user pinned awake
const sleepingIds = new Set<number>()            // tabs currently slept (on about:blank)
const sleepUrl    = new Map<number, string>()    // tabId → URL to restore on wake
let panelView: WebContentsView | null = null
let panelH    = 400
let panelVisible = false
let htmlFullscreen = false   // a page element (e.g. video) is in HTML fullscreen

// pending webRequest entries: reqId → tabId + startTime
const pendingReqs = new Map<number, { tabId: number; startTime: number }>()

function viewBounds() {
  const { width, height } = win.getContentBounds()
  return { x: 0, y: 88, width, height: height - 88 }
}

// Whole window, chrome included — used while a video is in fullscreen so the
// tab content covers the tab bar / nav bar entirely.
function fullBounds() {
  const { width, height } = win.getContentBounds()
  return { x: 0, y: 0, width, height }
}

function panelBounds() {
  const { width, height } = win.getContentBounds()
  return { x: 0, y: height - panelH, width, height: panelH }
}

// When a page enters HTML fullscreen (video full-screen button), take the OS
// into fullscreen and expand the active tab over the whole window so the tab
// bar and nav bar disappear. Restore everything on exit.
function enterHtmlFullscreen(id: number) {
  if (id !== activeId) return
  htmlFullscreen = true
  if (panelView) panelView.setVisible(false)
  if (!win.isFullScreen()) win.setFullScreen(true)
  tabs.get(id)?.setBounds(fullBounds())
}
function leaveHtmlFullscreen(id: number) {
  if (!htmlFullscreen) return
  htmlFullscreen = false
  if (win.isFullScreen()) win.setFullScreen(false)
  tabs.get(id)?.setBounds(viewBounds())
  if (panelVisible && panelView) { panelView.setVisible(true); panelView.setBounds(panelBounds()) }
}

function sendToAll(ch: string, data: unknown) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(ch, data)
  if (panelView && !panelView.webContents.isDestroyed()) {
    panelView.webContents.send(ch, data)
  }
}

// net:* events are consumed only by the inspector panel — send there alone.
function pushToRenderer(ch: string, tabId: number, data: object) {
  if (panelView && !panelView.webContents.isDestroyed()) {
    panelView.webContents.send(ch, { tabId, ...data })
  }
}

// ── Tor integration ──────────────────────────────────────────────────────────
const TOR_SOCKS_PORT = 9050
let torProc: ReturnType<typeof spawn> | null = null
let torState: 'off' | 'starting' | 'on' = 'off'
let torProgress = 0

function findTorBin(): string | null {
  for (const c of ['/opt/homebrew/bin/tor', '/usr/local/bin/tor', '/usr/bin/tor']) {
    if (existsSync(c)) return c
  }
  return null
}
function torDataDir() { return join(app.getPath('userData'), 'tor-data') }

function pushTorStatus(extra: object = {}) {
  sendToAll('tor:status', { installed: !!findTorBin(), state: torState, progress: torProgress, ...extra })
}

function reloadActive() {
  if (activeId !== null) { sendToAll('net:clear', { tabId: activeId }); tabs.get(activeId)?.webContents.reload() }
}

function startTor() {
  const bin = findTorBin()
  if (!bin) { torState = 'off'; pushTorStatus({ error: 'Tor not installed' }); return }
  if (torProc) return
  torState = 'starting'; torProgress = 0; pushTorStatus()
  try { mkdirSync(torDataDir(), { recursive: true, mode: 0o700 }) } catch {}
  torProc = spawn(bin, [
    '--SocksPort', String(TOR_SOCKS_PORT),
    '--DataDirectory', torDataDir(),
    '--ClientOnly', '1',
    '--RunAsDaemon', '0',
  ])
  torProc.stdout?.on('data', (b: Buffer) => {
    const s = b.toString()
    const m = s.match(/Bootstrapped (\d+)%/)
    if (m) { torProgress = parseInt(m[1]); pushTorStatus() }
    if (/Bootstrapped 100%/.test(s) && torState !== 'on') {
      // socks5:// makes Chromium resolve DNS remotely through Tor (no DNS leak)
      session.defaultSession.setProxy({ proxyRules: `socks5://127.0.0.1:${TOR_SOCKS_PORT}` }).then(() => {
        torState = 'on'; pushTorStatus(); reloadActive()
      })
    }
  })
  torProc.on('error', () => { torProc = null; torState = 'off'; pushTorStatus({ error: 'Failed to launch Tor' }) })
  torProc.on('close', () => {
    torProc = null
    if (torState !== 'off') {
      torState = 'off'
      session.defaultSession.setProxy({ mode: 'direct' }).then(() => pushTorStatus())
    }
  })
}

async function stopTor() {
  torState = 'off'; torProgress = 0
  await session.defaultSession.setProxy({ mode: 'direct' })
  if (torProc) { try { torProc.kill('SIGTERM') } catch {} torProc = null }
  pushTorStatus(); reloadActive()
}

// ── Keyboard shortcut handler (single source of truth) ───────────────────────
function handleShortcut(key: string) {
  switch (key) {
    case 't': {
      const id = newTab()
      activateTab(id, true)
      win.webContents.send('tab:opened', id)
      break
    }
    case 'w': if (activeId !== null) win.webContents.send('key', 'w'); break
    case 'r': if (activeId !== null) { sendToAll('net:clear', { tabId: activeId }); tabs.get(activeId)?.webContents.reload() } break
    case 'R': if (activeId !== null) { sendToAll('net:clear', { tabId: activeId }); tabs.get(activeId)?.webContents.reloadIgnoringCache() } break
    case '[': if (activeId !== null) { sendToAll('net:clear', { tabId: activeId }); tabs.get(activeId)?.webContents.navigationHistory.goBack() } break
    case ']': if (activeId !== null) { sendToAll('net:clear', { tabId: activeId }); tabs.get(activeId)?.webContents.navigationHistory.goForward() } break
    case 'l': win.webContents.send('key', 'l'); break
    case 'i': win.webContents.send('key', 'i'); break
    case 'k': showPalette(); break
  }
}

const HANDLED_KEYS = new Set(['t', 'w', 'r', '[', ']', 'l', 'i', 'k'])

// ── Palette ───────────────────────────────────────────────────────────────────
function showPalette() {
  // Toggle: close if already open
  if (paletteWin && !paletteWin.isDestroyed()) { paletteWin.close(); paletteWin = null; return }

  const { x, y, width, height } = win.getBounds()
  const pw = 580, ph = 440
  paletteWin = new BrowserWindow({
    x: x + Math.floor((width - pw) / 2),
    y: y + Math.floor((height - ph) * 0.48),
    width: pw, height: ph,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false,
    parent: win,
    webPreferences: {
      preload: join(__dirname, '../preload/palette.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  })
  paletteWin.loadFile(join(__dirname, '../renderer/palette.html'))
  paletteWin.on('blur',   () => { paletteWin?.close(); paletteWin = null })
  paletteWin.on('closed', () => { paletteWin = null })
  // Cmd+K inside the palette closes it
  paletteWin.webContents.on('before-input-event', (event, input) => {
    if (input.meta && input.type === 'keyDown' && input.key.toLowerCase() === 'k') {
      event.preventDefault()
      paletteWin?.close(); paletteWin = null
    }
  })
  paletteWin.webContents.once('did-finish-load', () => {
    const tabsData = [...tabMeta.entries()].map(([id, m]) => ({ id, ...m }))
    paletteWin?.webContents.send('palette:init', { tabs: tabsData, activeId, bookmarks: loadBookmarks() })
  })

  ipcMain.removeAllListeners('palette:select')
  ipcMain.removeAllListeners('palette:command')
  ipcMain.removeAllListeners('palette:close')
  ipcMain.on('palette:select',  (_, tabId: number) => { paletteWin?.close(); activateTab(tabId) })
  ipcMain.on('palette:close',   ()                 => { paletteWin?.close() })
  ipcMain.on('palette:command', (_, cmd: string)   => {
    paletteWin?.close()
    if (cmd.startsWith('navigate:')) {
      const url = cmd.slice(9)
      if (activeId !== null) {
        sendToAll('net:clear', { tabId: activeId })
        tabs.get(activeId)?.webContents.loadURL(url)
      }
      return
    }
    const map: Record<string, string> = {
      'new-tab': 't', 'close-tab': 'w', 'reload': 'r', 'back': '[',
      'forward': ']', 'focus-url': 'l', 'toggle-inspector': 'i',
    }
    if (map[cmd]) handleShortcut(map[cmd])
  })
}

// ── Intercept shortcuts in tab WebContentsViews ───────────────────────────────
function interceptShortcuts(view: WebContentsView) {
  view.webContents.on('before-input-event', (event, input) => {
    if (!input.meta || input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    // Cmd+Shift+R → hard reload (ignore cache)
    if (key === 'r' && input.shift) { event.preventDefault(); handleShortcut('R'); return }
    if (!HANDLED_KEYS.has(key)) return
    event.preventDefault()
    handleShortcut(key)
  })
}

// ── Tab lifecycle ─────────────────────────────────────────────────────────────
function newTab(url = 'about:blank'): number {
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  win.contentView.addChildView(view)
  // Re-add panelView to keep it on top of the z-order
  if (panelView) win.contentView.addChildView(panelView)
  view.setVisible(false)

  // Register in tabs BEFORE loadURL so onBeforeRequest can find this tab
  const id = view.webContents.id
  tabs.set(id, view)
  tabMeta.set(id, { title: 'New Tab', url })
  lastActive.set(id, Date.now())
  interceptShortcuts(view)

  const push = (ch: string, data: object) => {
    if (!win.isDestroyed()) win.webContents.send(ch, data)
  }
  const pushNav = (u: string) => {
    if (sleepingIds.has(id)) return   // ignore the about:blank sleep navigation
    tabMeta.set(id, { ...tabMeta.get(id)!, url: u })
    push('nav', { id, url: u })
    push('nav-state', {
      id,
      canGoBack:    view.webContents.navigationHistory.canGoBack(),
      canGoForward: view.webContents.navigationHistory.canGoForward(),
    })
  }

  view.webContents.on('did-navigate',         (_, u) => pushNav(u))
  view.webContents.on('did-navigate-in-page', (_, u) => pushNav(u))
  view.webContents.on('page-title-updated',   (_, title) => {
    if (sleepingIds.has(id)) return   // keep the pre-sleep title in the tab bar
    tabMeta.set(id, { ...tabMeta.get(id)!, title })
    push('title', { id, title })
  })
  view.webContents.on('did-start-loading', () => { if (!sleepingIds.has(id)) push('loading', { id, v: true }) })
  view.webContents.on('did-stop-loading',  () => { if (!sleepingIds.has(id)) push('loading', { id, v: false }) })
  view.webContents.on('page-favicon-updated', (_, favicons) => {
    if (sleepingIds.has(id)) return
    if (favicons[0]) {
      tabMeta.set(id, { ...tabMeta.get(id)!, favicon: favicons[0] })
      push('favicon', { id, url: favicons[0] })
    }
  })
  // Video (or any element) going fullscreen → cover the whole window
  view.webContents.on('enter-html-full-screen', () => enterHtmlFullscreen(id))
  view.webContents.on('leave-html-full-screen', () => leaveHtmlFullscreen(id))

  view.webContents.on('context-menu', (_, params) => {
    const items: MenuItemConstructorOptions[] = []

    if (params.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => {
          const newId = newTab(params.linkURL)
          activateTab(newId)
          win.webContents.send('tab:opened', newId)
        }},
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      )
    }

    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => {
          const newId = newTab(params.srcURL)
          activateTab(newId)
          win.webContents.send('tab:opened', newId)
        }},
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' },
      )
    }

    if (params.mediaType === 'video' && params.srcURL) {
      items.push(
        { label: 'Open Video in New Tab', click: () => {
          const newId = newTab(params.srcURL)
          activateTab(newId)
          win.webContents.send('tab:opened', newId)
        }},
        { label: 'Copy Video Address', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' },
      )
    }

    if (params.selectionText) {
      items.push(
        { label: 'Copy', click: () => view.webContents.copy() },
        { label: `Search for "${params.selectionText.slice(0, 30)}${params.selectionText.length > 30 ? '…' : ''}"`, click: () => {
          const newId = newTab(`https://search.theradicalparty.com/?q=${encodeURIComponent(params.selectionText)}`)
          activateTab(newId)
          win.webContents.send('tab:opened', newId)
        }},
        { type: 'separator' },
      )
    }

    if (!params.selectionText && !params.linkURL) {
      items.push(
        { label: 'Back',    enabled: view.webContents.navigationHistory.canGoBack(),    click: () => { sendToAll('net:clear', { tabId: id }); view.webContents.navigationHistory.goBack() } },
        { label: 'Forward', enabled: view.webContents.navigationHistory.canGoForward(), click: () => { sendToAll('net:clear', { tabId: id }); view.webContents.navigationHistory.goForward() } },
        { label: 'Reload',  click: () => { sendToAll('net:clear', { tabId: id }); view.webContents.reload() } },
        { type: 'separator' },
      )
    }

    items.push(
      { label: 'Save Page As…', click: () => view.webContents.downloadURL(view.webContents.getURL()) },
      { label: 'View Page Source', click: () => {
        const newId = newTab(`view-source:${view.webContents.getURL()}`)
        activateTab(newId)
        win.webContents.send('tab:opened', newId)
      }},
      { label: 'Inspect (Network Inspector)', click: () => win.webContents.send('key', 'i') },
    )

    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })

  view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    const newId = newTab(targetUrl)
    activateTab(newId)
    win.webContents.send('tab:opened', newId)
    return { action: 'deny' }
  })

  // Load AFTER registering in tabs and setting up handlers so onBeforeRequest sees it
  view.webContents.loadURL(url === 'about:blank' || url.startsWith('http') ? url : `https://${url}`)

  return id
}

function sleepTab(id: number, force = false) {
  const view = tabs.get(id)
  if (!view || sleepingIds.has(id) || id === activeId) return
  if (!force && keepAwake.has(id)) return
  const url = tabMeta.get(id)?.url
  if (!url || !/^https?:/i.test(url)) return          // only sleep real web pages
  if (view.webContents.isCurrentlyAudible()) return   // never sleep audible tabs
  sleepUrl.set(id, url)
  sleepingIds.add(id)
  view.webContents.loadURL('about:blank').catch(() => {})
  if (!win.isDestroyed()) win.webContents.send('tab:sleep', { id })
}

function wakeTab(id: number) {
  if (!sleepingIds.has(id)) return
  const url = sleepUrl.get(id)
  sleepingIds.delete(id); sleepUrl.delete(id)
  if (url) tabs.get(id)?.webContents.loadURL(url).catch(() => {})
  if (!win.isDestroyed()) win.webContents.send('tab:wake', { id })
}

function activateTab(id: number, focusURL = false) {
  if (activeId !== null && activeId !== id) lastActive.set(activeId, Date.now())
  if (activeId !== null) tabs.get(activeId)?.setVisible(false)
  const view = tabs.get(id)
  if (!view) return
  wakeTab(id)                      // clicking a slept tab wakes it instantly
  view.setVisible(true)
  view.setBounds(viewBounds())
  activeId = id
  lastActive.set(id, Date.now())
  sendToAll('activated', id)
  win.webContents.send('nav-state', {
    id,
    canGoBack:    view.webContents.navigationHistory.canGoBack(),
    canGoForward: view.webContents.navigationHistory.canGoForward(),
  })
  if (focusURL) {
    // Short delay so the view doesn't steal focus back before we reclaim it
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.focus()
        win.webContents.focus()
        win.webContents.send('focus-url', null)
      }
    }, 80)
  }
}

// ── Menu ──────────────────────────────────────────────────────────────────────
app.setName('Radical Browser')

function buildMenu() {
  // registerAccelerator:false → shortcut shows in menu but only fires via our handler
  const sc = (a: string) => ({ accelerator: a, registerAccelerator: false })
  const template: MenuItemConstructorOptions[] = [
    { label: 'Radical Browser', submenu: [
      { role: 'about', label: 'About Radical Browser' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
      { role: 'quit', label: 'Quit Radical Browser' },
    ]},
    { label: 'Browser', submenu: [
      { label: 'New Tab',           ...sc('CmdOrCtrl+T'), click: () => handleShortcut('t') },
      { label: 'Close Tab',         ...sc('CmdOrCtrl+W'), click: () => handleShortcut('w') },
      { type: 'separator' },
      { label: 'Command Palette',   accelerator: 'CmdOrCtrl+K', click: () => showPalette() },
      { label: 'Network Inspector', ...sc('CmdOrCtrl+I'), click: () => handleShortcut('i') },
      { type: 'separator' },
      { label: 'Focus URL Bar',     ...sc('CmdOrCtrl+L'), click: () => handleShortcut('l') },
      { label: 'Reload',            ...sc('CmdOrCtrl+R'),       click: () => handleShortcut('r') },
      { label: 'Hard Reload',       ...sc('CmdOrCtrl+Shift+R'), click: () => handleShortcut('R') },
      { label: 'Go Back',           ...sc('CmdOrCtrl+['), click: () => handleShortcut('[') },
      { label: 'Go Forward',        ...sc('CmdOrCtrl+]'), click: () => handleShortcut(']') },
    ]},
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
    { label: 'Window', submenu: [
      { role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' },
    ]},
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  buildMenu()

  // ── Network monitoring via webRequest (no CDP required) ───────────────────
  // Single onBeforeRequest handler: ad-block + capture requests
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    const cancel = isBlocked(details.url)
    const tabId  = details.webContentsId ?? 0
    // Only capture request metadata when the inspector is actually open.
    // Ad-block (cancel) still runs always. Downstream listeners no-op when a
    // request isn't recorded in pendingReqs, so this gates the whole chain.
    if (!cancel && panelVisible && tabId > 0 && tabs.has(tabId)) {
      const startTime = Date.now() / 1000
      pendingReqs.set(details.id, { tabId, startTime })
      pushToRenderer('net:req', tabId, {
        id:         String(details.id),
        method:     details.method,
        url:        details.url,
        type:       normType(details.resourceType ?? 'other'),
        startTime,
        reqHeaders: {},
        reqBody:    null,
        initiator:  'other',
        warns:      [],
      })
    }
    cb({ cancel })
  })

  session.defaultSession.webRequest.onSendHeaders({ urls: ['*://*/*'] }, (details) => {
    const req = pendingReqs.get(details.id)
    if (!req) return
    pushToRenderer('net:req-headers', req.tabId, {
      id:         String(details.id),
      reqHeaders: details.requestHeaders ?? {},
    })
  })

  session.defaultSession.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, cb) => {
    const req = pendingReqs.get(details.id)
    if (req) {
      const rawH  = details.responseHeaders ?? {}
      const resH: Record<string, string> = {}
      for (const [k, v] of Object.entries(rawH)) resH[k.toLowerCase()] = Array.isArray(v) ? v[0] : String(v)
      const mime  = (resH['content-type'] ?? '').split(';')[0].trim()
      const stText = (details.statusLine ?? '').replace(/^HTTP\/\S+\s+\d+\s*/, '')
      pushToRenderer('net:res', req.tabId, {
        id:         String(details.id),
        status:     details.statusCode,
        statusText: stText,
        mimeType:   mime,
        resHeaders: resH,
        remoteIP:   null,
        protocol:   null,
        securityState: null,
      })
    }
    cb({ responseHeaders: details.responseHeaders })
  })

  session.defaultSession.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    const req = pendingReqs.get(details.id)
    if (req) {
      pushToRenderer('net:done', req.tabId, {
        id:      String(details.id),
        endTime: Date.now() / 1000,
        size:    details.responseSize ?? 0,
      })
      pendingReqs.delete(details.id)
    }
  })

  session.defaultSession.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details) => {
    const req = pendingReqs.get(details.id)
    if (req) {
      pushToRenderer('net:fail', req.tabId, {
        id:        String(details.id),
        cancelled: details.error === 'net::ERR_ABORTED',
      })
      pendingReqs.delete(details.id)
    }
  })

  // ── BrowserWindow ─────────────────────────────────────────────────────────
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 800, minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 20 },
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  })

  win.loadFile(join(__dirname, '../renderer/index.html'))
  const layoutActive = () => {
    if (activeId !== null) tabs.get(activeId)?.setBounds(htmlFullscreen ? fullBounds() : viewBounds())
    if (panelVisible && panelView && !htmlFullscreen) panelView.setBounds(panelBounds())
  }
  win.on('resize', layoutActive)
  // The OS fullscreen transition fires resize mid-animation; reassert bounds
  // when it settles so a fullscreen video covers the chrome cleanly.
  win.on('enter-full-screen', layoutActive)
  win.on('leave-full-screen', layoutActive)

  // Sleep tabs left idle in the background past the threshold (memory saver).
  setInterval(() => {
    const now = Date.now()
    for (const id of tabs.keys()) {
      if (id === activeId || keepAwake.has(id) || sleepingIds.has(id)) continue
      if (now - (lastActive.get(id) ?? now) > SLEEP_AFTER_MS) sleepTab(id)
    }
  }, 60 * 1000).unref?.()

  // ── IPC ───────────────────────────────────────────────────────────────────
  ipcMain.handle('tab:new', (_, url?: string) => {
    const id = newTab(url)
    activateTab(id, !url)
    win.webContents.send('tab:opened', id)
    return id
  })

  ipcMain.handle('tab:activate', (_, id: number) => activateTab(id))

  ipcMain.handle('tab:close', (_, id: number) => {
    const view = tabs.get(id)
    if (!view) return [...tabs.keys()]
    // Closing the tab that's in fullscreen would leave the window stuck in OS
    // fullscreen (its leave event never fires) — bail out of fullscreen first.
    if (htmlFullscreen && id === activeId) { htmlFullscreen = false; if (win.isFullScreen()) win.setFullScreen(false) }
    win.contentView.removeChildView(view)
    view.webContents.close()
    tabs.delete(id); tabMeta.delete(id)
    lastActive.delete(id); keepAwake.delete(id); sleepingIds.delete(id); sleepUrl.delete(id)
    if (activeId === id) {
      activeId = null
      const remaining = [...tabs.keys()]
      if (remaining.length > 0) activateTab(remaining[remaining.length - 1])
    }
    return [...tabs.keys()]
  })

  // Right-click a tab → keep-awake toggle / sleep-now (see app.ts contextmenu)
  ipcMain.handle('tab:menu', (_, id: number) => {
    if (!tabs.has(id)) return
    const items: MenuItemConstructorOptions[] = [
      { label: 'Keep Tab Awake', type: 'checkbox', checked: keepAwake.has(id), click: () => {
        if (keepAwake.has(id)) keepAwake.delete(id)
        else { keepAwake.add(id); lastActive.set(id, Date.now()) }
        if (!win.isDestroyed()) win.webContents.send('tab:keepawake', { id, on: keepAwake.has(id) })
      }},
      { label: 'Sleep Tab Now', enabled: id !== activeId && !sleepingIds.has(id),
        click: () => sleepTab(id, true) },
    ]
    Menu.buildFromTemplate(items).popup({ window: win })
  })

  ipcMain.handle('tab:go', (_, { id, url }: { id: number; url: string }) => {
    // Clear net log synchronously before loadURL so net:clear arrives before net:req
    sendToAll('net:clear', { tabId: id })
    tabs.get(id)?.webContents.loadURL(url === 'about:blank' || url.startsWith('http') ? url : `https://${url}`)
  })

  ipcMain.handle('tab:back',   (_, id: number) => { sendToAll('net:clear', { tabId: id }); tabs.get(id)?.webContents.navigationHistory.goBack() })
  ipcMain.handle('tab:forward',(_, id: number) => { sendToAll('net:clear', { tabId: id }); tabs.get(id)?.webContents.navigationHistory.goForward() })
  ipcMain.handle('tab:reload', (_, id: number) => { sendToAll('net:clear', { tabId: id }); tabs.get(id)?.webContents.reload() })
  ipcMain.handle('tab:hard-reload', (_, id: number) => { sendToAll('net:clear', { tabId: id }); tabs.get(id)?.webContents.reloadIgnoringCache() })

  ipcMain.handle('tor:status', () => ({ installed: !!findTorBin(), state: torState, progress: torProgress }))
  ipcMain.handle('tor:toggle', () => {
    if (torState === 'off') startTor(); else stopTor()
    return { installed: !!findTorBin(), state: torState, progress: torProgress }
  })
  ipcMain.handle('tab:stop',   (_, id: number) => tabs.get(id)?.webContents.stop())

  ipcMain.handle('net:body', async (_, { tabId, reqId }: { tabId: number; reqId: string }) => {
    // Best-effort CDP body fetch — may not be available
    const view = tabs.get(tabId)
    if (!view) return null
    const dbg = view.webContents.debugger
    try {
      if (!dbg.isAttached()) dbg.attach()
      return await dbg.sendCommand('Network.getResponseBody', { requestId: reqId })
    } catch { return null }
  })

  ipcMain.handle('net:cookies', async (_, tabId: number) => {
    const view = tabs.get(tabId)
    if (!view) return []
    const dbg = view.webContents.debugger
    try {
      if (!dbg.isAttached()) dbg.attach()
      const r = await dbg.sendCommand('Network.getAllCookies')
      return r.cookies ?? []
    } catch { return [] }
  })

  ipcMain.handle('net:replay', async (_, opts: { method: string; url: string; headers: Record<string, string>; body?: string }) => {
    try {
      const res = await fetch(opts.url, {
        method: opts.method, headers: opts.headers,
        body: ['GET','HEAD'].includes(opts.method.toUpperCase()) ? undefined : (opts.body || undefined),
      })
      const resHeaders: Record<string, string> = {}
      res.headers.forEach((v, k) => { resHeaders[k] = v })
      const body = await res.text()
      return { ok: true, status: res.status, statusText: res.statusText, headers: resHeaders, body }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('panel:toggle', () => {
    // Lazily spin up the inspector's renderer process on first use only —
    // saves a whole WebContentsView's memory for sessions that never open it.
    if (!panelView) createPanelView()
    panelVisible = !panelVisible
    panelView!.setVisible(panelVisible)
    if (panelVisible) panelView!.setBounds(panelBounds())
    return { open: panelVisible }
  })

  ipcMain.handle('panel:height', (_, h: number) => {
    panelH = h
    if (panelVisible && panelView) panelView.setBounds(panelBounds())
  })

  // Renderer owns tab display-order + URLs, so it computes the session blob
  // (debounced) and we just persist it here.
  ipcMain.on('session:save', (_, data: SavedSession) => {
    if (data && Array.isArray(data.tabs)) saveSession(data)
  })

  ipcMain.handle('bookmarks:get', () => loadBookmarks())
  ipcMain.handle('bookmarks:toggle', (_, bm: Bookmark) => {
    const bms = loadBookmarks()
    const idx = bms.findIndex(b => b.url === bm.url)
    if (idx >= 0) bms.splice(idx, 1)
    else bms.unshift(bm)
    saveBookmarks(bms)
    return bms
  })

  // ── Recon / security tooling (pure Node built-ins) ────────────────────────
  const cleanHost = (h: string) => h.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')

  // 1. DNS lookup — all record types, each isolated in try/catch
  ipcMain.handle('recon:dns', async (_, host: string) => {
    const h = cleanHost(host)
    const grab = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await fn() } catch { return fallback }
    }
    const [A, AAAA, MX, TXT, NS, CNAME, SOA, CAA] = await Promise.all([
      grab(() => dns.resolve4(h), [] as string[]),
      grab(() => dns.resolve6(h), [] as string[]),
      grab(() => dns.resolveMx(h), [] as any[]),
      grab(() => dns.resolveTxt(h), [] as string[][]),
      grab(() => dns.resolveNs(h), [] as string[]),
      grab(() => dns.resolveCname(h), [] as string[]),
      grab(() => dns.resolveSoa(h), null as any),
      grab(() => dns.resolveCaa(h), [] as any[]),
    ])
    return { A, AAAA, MX, TXT, NS, CNAME, SOA, CAA }
  })

  // 2. Reverse DNS
  ipcMain.handle('recon:reverse-dns', async (_, ip: string) => {
    try { return { ok: true, hostnames: await dns.reverse(ip.trim()) } }
    catch (e: any) { return { ok: false, error: e.message, hostnames: [] } }
  })

  // 3. TCP-connect port scan of common ports
  const COMMON_PORTS: [number, string][] = [
    [21, 'ftp'], [22, 'ssh'], [23, 'telnet'], [25, 'smtp'], [53, 'dns'],
    [80, 'http'], [110, 'pop3'], [143, 'imap'], [443, 'https'], [445, 'smb'],
    [993, 'imaps'], [995, 'pop3s'], [1433, 'mssql'], [3306, 'mysql'], [3389, 'rdp'],
    [5432, 'postgres'], [5900, 'vnc'], [6379, 'redis'], [8080, 'http-alt'], [8443, 'https-alt'],
    [27017, 'mongodb'], [9200, 'elasticsearch'], [11211, 'memcached'],
  ]
  const probePort = (ip: string, port: number, timeout = 2000): Promise<boolean> => new Promise(resolve => {
    const sock = new net.Socket()
    let done = false
    const finish = (open: boolean) => { if (done) return; done = true; sock.destroy(); resolve(open) }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error',   () => finish(false))
    try { sock.connect(port, ip) } catch { finish(false) }
  })
  ipcMain.handle('recon:portscan', async (_, host: string) => {
    const h = cleanHost(host)
    let ip = h
    if (!net.isIP(h)) {
      try { ip = (await dns.resolve4(h))[0] || h } catch { ip = h }
    }
    const results = await Promise.all(COMMON_PORTS.map(async ([port, service]) => ({
      port, service, open: await probePort(ip, port),
    })))
    return { ip, ports: results }
  })

  // 4. TLS / certificate inspector
  ipcMain.handle('recon:tls', async (_, host: string) => {
    const h = cleanHost(host)
    return await new Promise<any>(resolve => {
      let done = false
      const finish = (v: any) => { if (done) return; done = true; try { sock.destroy() } catch {} resolve(v) }
      const sock = tls.connect(443, h, { servername: h, rejectUnauthorized: false }, () => {
        try {
          const cert = sock.getPeerCertificate(true)
          const cipher = sock.getCipher()
          const protocol = sock.getProtocol()
          if (!cert || !cert.subject) return finish({ ok: false, error: 'No certificate returned' })
          const validTo = new Date(cert.valid_to)
          const validFrom = new Date(cert.valid_from)
          const now = Date.now()
          const daysToExpiry = Math.floor((validTo.getTime() - now) / 86400000)
          // Walk issuer chain
          const chain: string[] = []
          let cur: any = cert
          const seen = new Set<string>()
          while (cur && cur.subject) {
            const cn = cur.subject.CN || cur.subject.O || '(unknown)'
            if (seen.has(cur.fingerprint256 || cn)) break
            seen.add(cur.fingerprint256 || cn)
            chain.push(cn)
            if (!cur.issuerCertificate || cur.issuerCertificate === cur) break
            cur = cur.issuerCertificate
          }
          finish({
            ok: true,
            subject: cert.subject,
            issuer: cert.issuer,
            valid_from: cert.valid_from,
            valid_to: cert.valid_to,
            daysToExpiry,
            valid: now >= validFrom.getTime() && now <= validTo.getTime(),
            serialNumber: cert.serialNumber,
            fingerprint256: cert.fingerprint256,
            subjectAltNames: cert.subjectaltname || '',
            protocol,
            cipherName: cipher?.name || '',
            cipherVersion: cipher?.version || '',
            chain,
          })
        } catch (e: any) { finish({ ok: false, error: e.message }) }
      })
      sock.setTimeout(8000, () => finish({ ok: false, error: 'Connection timed out' }))
      sock.once('error', (e: any) => finish({ ok: false, error: e.message }))
    })
  })

  // 5. WHOIS — raw client via whois.iana.org referral
  const whoisQuery = (server: string, query: string, timeout = 10000): Promise<string> => new Promise((resolve, reject) => {
    const sock = new net.Socket()
    let data = ''
    let done = false
    const fail = (e: Error) => { if (done) return; done = true; sock.destroy(); reject(e) }
    sock.setTimeout(timeout)
    sock.once('timeout', () => fail(new Error('WHOIS timeout')))
    sock.once('error', fail)
    sock.connect(43, server, () => sock.write(query + '\r\n'))
    sock.on('data', chunk => { data += chunk.toString('utf8') })
    sock.on('close', () => { if (done) return; done = true; resolve(data) })
  })
  ipcMain.handle('recon:whois', async (_, domain: string) => {
    const d = cleanHost(domain)
    try {
      const iana = await whoisQuery('whois.iana.org', d)
      const refer = iana.match(/refer:\s*(\S+)/i)?.[1]
      if (refer) {
        try {
          const authoritative = await whoisQuery(refer, d)
          return { ok: true, server: refer, text: authoritative }
        } catch (e: any) {
          return { ok: true, server: 'whois.iana.org', text: iana, note: `Referral to ${refer} failed: ${e.message}` }
        }
      }
      return { ok: true, server: 'whois.iana.org', text: iana }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  // 6. HTTP recon — probe well-known sensitive paths
  ipcMain.handle('recon:http-recon', async (_, url: string) => {
    let origin: string
    try {
      const raw = /^https?:\/\//.test(url) ? url : `https://${cleanHost(url)}`
      origin = new URL(raw).origin
    } catch { return { ok: false, error: 'Invalid URL' } }
    const paths = ['/robots.txt', '/sitemap.xml', '/.well-known/security.txt', '/security.txt', '/.git/HEAD', '/.env', '/humans.txt']
    const results = await Promise.all(paths.map(async path => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 5000)
      try {
        const res = await fetch(origin + path, { signal: ctrl.signal, redirect: 'manual' })
        const text = await res.text().catch(() => '')
        return { path, status: res.status, found: res.status < 400, snippet: text.slice(0, 2048) }
      } catch (e: any) {
        return { path, status: 0, found: false, snippet: `error: ${e.name === 'AbortError' ? 'timeout' : e.message}` }
      } finally { clearTimeout(timer) }
    }))
    return { ok: true, origin, results }
  })

  // 7. Subdomain finder — DNS dictionary discovery, throttled
  const SUBDOMAIN_WORDS = [
    'www', 'mail', 'ftp', 'webmail', 'smtp', 'pop', 'ns1', 'ns2', 'admin', 'api',
    'dev', 'staging', 'test', 'portal', 'vpn', 'remote', 'blog', 'shop', 'store', 'm',
    'mobile', 'app', 'apps', 'cdn', 'static', 'assets', 'img', 'images', 'media', 'docs',
    'support', 'help', 'status', 'dashboard', 'panel', 'cpanel', 'git', 'gitlab', 'jenkins', 'ci',
    'jira', 'confluence', 'wiki', 'secure', 'login', 'auth', 'sso', 'beta', 'demo', 'sandbox',
    'internal', 'intranet', 'proxy', 'gateway', 'db', 'database', 'redis', 'mysql', 'mongo', 'elastic',
    'kibana', 'grafana', 'prometheus',
  ]
  ipcMain.handle('recon:subdomains', async (_, domain: string) => {
    const d = cleanHost(domain)
    const found: { subdomain: string; ips: string[] }[] = []
    const queue = [...SUBDOMAIN_WORDS]
    const CONCURRENCY = 20
    const worker = async () => {
      while (queue.length) {
        const word = queue.shift()
        if (!word) break
        const fqdn = `${word}.${d}`
        try {
          const ips = await dns.resolve4(fqdn)
          if (ips.length) found.push({ subdomain: fqdn, ips })
        } catch {}
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
    found.sort((a, b) => a.subdomain.localeCompare(b.subdomain))
    return { ok: true, domain: d, found }
  })

  // ── External pentest tools (optional — shell out if installed) ────────────
  // GUI-launched apps get a minimal PATH; augment with common bin locations.
  const EXTRA_PATH = [
    '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin',
    join(homedir(), 'go', 'bin'), join(homedir(), '.local', 'bin'),
    join(homedir(), '.cargo', 'bin'),
  ]
  const toolEnv = () => ({
    ...process.env,
    PATH: [process.env.PATH || '', ...EXTRA_PATH].filter(Boolean).join(':'),
  })

  // key → binary, label, arg builder (target), description, and target kind
  interface ExtTool {
    bin: string; label: string; desc: string; kind: 'url' | 'host' | 'domain'
    args: (target: string) => string[]
  }
  const EXT_TOOLS: Record<string, ExtTool> = {
    nuclei:    { bin: 'nuclei',     label: 'Nuclei',    kind: 'url',    desc: 'Template-based vulnerability scanner (ProjectDiscovery)', args: t => ['-u', t, '-silent', '-nc'] },
    nmap:      { bin: 'nmap',       label: 'Nmap',      kind: 'host',   desc: 'Service/version detection port scan',                    args: t => ['-T4', '-F', '-sV', t] },
    subfinder: { bin: 'subfinder',  label: 'Subfinder', kind: 'domain', desc: 'Passive subdomain enumeration (ProjectDiscovery)',       args: t => ['-d', t, '-silent'] },
    httpx:     { bin: 'httpx',      label: 'httpx',     kind: 'url',    desc: 'HTTP probe: status, title, tech-detect',                 args: t => ['-u', t, '-silent', '-status-code', '-title', '-tech-detect', '-nc'] },
    testssl:   { bin: 'testssl.sh', label: 'testssl.sh',kind: 'host',   desc: 'Deep TLS/SSL cipher & vulnerability testing',            args: t => ['--color', '0', t] },
    whatweb:   { bin: 'whatweb',    label: 'WhatWeb',   kind: 'url',    desc: 'Web technology fingerprinting',                          args: t => [t] },
    nikto:     { bin: 'nikto',      label: 'Nikto',     kind: 'url',    desc: 'Web server misconfiguration scanner',                    args: t => ['-h', t, '-nointeractive'] },
    wafw00f:   { bin: 'wafw00f',    label: 'wafw00f',   kind: 'url',    desc: 'WAF detection & fingerprinting',                         args: t => [t] },
    katana:    { bin: 'katana',     label: 'Katana',    kind: 'url',    desc: 'Fast web crawler (ProjectDiscovery)',                    args: t => ['-u', t, '-silent', '-nc'] },
    dnsx:      { bin: 'dnsx',       label: 'dnsx',      kind: 'domain', desc: 'Fast DNS toolkit (ProjectDiscovery)',                    args: t => ['-d', t, '-silent', '-a', '-resp'] },
  }

  const which = (bin: string): Promise<string | null> => new Promise(resolve => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [bin], { env: toolEnv() }, (err, stdout) => {
      resolve(err ? null : (stdout.toString().trim().split('\n')[0] || null))
    })
  })

  ipcMain.handle('recon:detect-tools', async () => {
    const entries = await Promise.all(Object.entries(EXT_TOOLS).map(async ([key, t]) => {
      const path = await which(t.bin)
      return { key, bin: t.bin, label: t.label, desc: t.desc, kind: t.kind, available: !!path, path }
    }))
    return entries
  })

  // Streaming tool runner. Returns runId; output streamed via recon:tool-out / recon:tool-done
  const runningTools = new Map<string, ReturnType<typeof spawn>>()
  const shapeTarget = (kind: string, raw: string): string => {
    const bare = cleanHost(raw)
    if (kind === 'url')    return /^https?:\/\//.test(raw.trim()) ? raw.trim() : `https://${bare}`
    return bare // host / domain
  }
  // Only allow safe target chars (spawn without shell already blocks injection, but be strict)
  const SAFE_TARGET = /^[a-zA-Z0-9._:\/-]+$/

  ipcMain.handle('recon:run-tool', async (_, { key, target }: { key: string; target: string }) => {
    const tool = EXT_TOOLS[key]
    if (!tool) return { ok: false, error: 'Unknown tool' }
    const shaped = shapeTarget(tool.kind, target)
    const forCheck = shaped.replace(/^https?:\/\//, '')
    if (!SAFE_TARGET.test(forCheck)) return { ok: false, error: 'Invalid target' }
    if (!(await which(tool.bin)))  return { ok: false, error: `${tool.bin} not found in PATH` }

    const runId = `${key}-${Date.now()}`
    const args = tool.args(shaped)
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(tool.bin, args, { env: toolEnv() })
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
    runningTools.set(runId, proc)
    sendToAll('recon:tool-out', { runId, line: `$ ${tool.bin} ${args.join(' ')}\n`, stream: 'cmd' })

    const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      sendToAll('recon:tool-out', { runId, line: chunk.toString('utf8'), stream })
    }
    proc.stdout?.on('data', onData('stdout'))
    proc.stderr?.on('data', onData('stderr'))
    proc.on('error', (e: any) => {
      sendToAll('recon:tool-done', { runId, code: -1, error: e.message })
      runningTools.delete(runId)
    })
    proc.on('close', (code: number | null) => {
      sendToAll('recon:tool-done', { runId, code: code ?? 0 })
      runningTools.delete(runId)
    })
    return { ok: true, runId, cmd: `${tool.bin} ${args.join(' ')}` }
  })

  ipcMain.handle('recon:cancel-tool', (_, runId: string) => {
    const proc = runningTools.get(runId)
    if (proc) { try { proc.kill('SIGTERM') } catch {} runningTools.delete(runId); return { ok: true } }
    return { ok: false }
  })


  // ── Panel WebContentsView ─────────────────────────────────────────────────
  function createPanelView() {
    panelView = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/panel.js'),
        contextIsolation: true, nodeIntegration: false,
      }
    })
    win.contentView.addChildView(panelView)
    panelView.setVisible(false)
    panelView.webContents.loadFile(join(__dirname, '../renderer/panel.html'))
  }
  // Panel is created lazily on first inspector toggle — see panel:toggle above.

  win.webContents.once('did-finish-load', () => {
    const sess = loadSession()
    const urls = (sess?.tabs ?? []).filter(u => typeof u === 'string' && u.length > 0)
    if (urls.length === 0) {
      // Fresh start — single default tab.
      const id = newTab()
      activateTab(id)
      sendToAll('init', id)
      return
    }
    // Restore the previous session, preserving order + which tab was active.
    const created = urls.map(u => ({ id: newTab(u === 'about:blank' ? 'about:blank' : u), url: u }))
    const ai = Math.min(Math.max(sess!.activeIndex ?? 0, 0), created.length - 1)
    activateTab(created[ai].id)
    win.webContents.send('session:restore', { tabs: created, activeId: created[ai].id })
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (torProc) { try { torProc.kill('SIGTERM') } catch {} torProc = null }
})
