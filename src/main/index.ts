import { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, MenuItemConstructorOptions } from 'electron'
import { join } from 'path'

const BLOCKED_HOSTS = new Set([
  'googlesyndication.com', 'doubleclick.net', 'googleadservices.com',
  'adservice.google.com', 'amazon-adsystem.com', 'ads.youtube.com',
  'scorecardresearch.com', 'quantserve.com', 'taboola.com', 'outbrain.com',
  'adsafeprotected.com', 'moatads.com', 'casalemedia.com', 'pubmatic.com',
  'rubiconproject.com', 'openx.net', 'rlcdn.com', 'adnxs.com',
])

function isBlocked(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return BLOCKED_HOSTS.has(host) || [...BLOCKED_HOSTS].some(b => host.endsWith('.' + b))
  } catch {
    return false
  }
}

interface TabMeta { title: string; url: string; favicon?: string }

let win: BrowserWindow
let paletteWin: BrowserWindow | null = null
const tabs    = new Map<number, WebContentsView>()
const tabMeta = new Map<number, TabMeta>()
let activeId: number | null = null
let panelH = 0

function viewBounds() {
  const { width, height } = win.getContentBounds()
  return { x: 0, y: 88, width, height: height - 88 - panelH }
}

function showPalette() {
  if (paletteWin && !paletteWin.isDestroyed()) {
    paletteWin.focus()
    return
  }

  const { x, y, width } = win.getBounds()
  const pw = 580

  paletteWin = new BrowserWindow({
    x: x + Math.floor((width - pw) / 2),
    y: y + 100,
    width: pw,
    height: 440,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    parent: win,
    webPreferences: {
      preload: join(__dirname, '../preload/palette.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  paletteWin.loadFile(join(__dirname, '../renderer/palette.html'))

  paletteWin.on('blur', () => { paletteWin?.close(); paletteWin = null })
  paletteWin.on('closed', () => { paletteWin = null })

  paletteWin.webContents.once('did-finish-load', () => {
    const tabsData = [...tabMeta.entries()].map(([id, m]) => ({ id, ...m }))
    paletteWin?.webContents.send('palette:init', { tabs: tabsData, activeId })
  })

  ipcMain.removeAllListeners('palette:select')
  ipcMain.removeAllListeners('palette:command')
  ipcMain.removeAllListeners('palette:close')

  ipcMain.on('palette:select', (_, tabId: number) => {
    paletteWin?.close()
    activateTab(tabId)
  })

  ipcMain.on('palette:close', () => {
    paletteWin?.close()
  })

  ipcMain.on('palette:command', (_, cmd: string) => {
    paletteWin?.close()
    switch (cmd) {
      case 'new-tab':          { const id = newTab(); activateTab(id); win.webContents.send('key', 't-done'); break }
      case 'close-tab':        if (activeId !== null) { win.webContents.send('key', 'w'); } break
      case 'reload':           tabs.get(activeId!)?.webContents.reload(); break
      case 'back':             tabs.get(activeId!)?.webContents.goBack(); break
      case 'forward':          tabs.get(activeId!)?.webContents.goForward(); break
      case 'focus-url':        win.webContents.send('key', 'l'); break
      case 'toggle-inspector': win.webContents.send('key', 'i'); break
    }
  })
}

function interceptShortcuts(view: WebContentsView) {
  view.webContents.on('before-input-event', (event, input) => {
    if (!input.meta || input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if (key === 'k') { event.preventDefault(); showPalette(); return }
    const others = new Set(['i', 't', 'w', 'r', 'l', '[', ']'])
    if (others.has(key)) {
      event.preventDefault()
      win.webContents.send('key', key)
    }
  })
}

function attachDebugger(view: WebContentsView, tabId: number) {
  const dbg = view.webContents.debugger
  try { dbg.attach('1.3') } catch { return }

  dbg.sendCommand('Network.enable')

  dbg.on('message', (_, method, params) => {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    const push = (ch: string, data: object) => win.webContents.send(ch, { tabId, ...data })
    if (method === 'Network.requestWillBeSent') {
      push('net:req', {
        id: params.requestId,
        method: params.request.method,
        url: params.request.url,
        type: params.type,
        startTime: params.timestamp,
      })
    }
    if (method === 'Network.responseReceived') {
      push('net:res', {
        id: params.requestId,
        status: params.response.status,
        mimeType: params.response.mimeType,
      })
    }
    if (method === 'Network.loadingFinished') {
      push('net:done', {
        id: params.requestId,
        endTime: params.timestamp,
        size: params.encodedDataLength,
      })
    }
    if (method === 'Network.loadingFailed') {
      push('net:fail', { id: params.requestId, error: params.errorText })
    }
  })

  view.webContents.on('did-navigate', () => {
    win.webContents.send('net:clear', { tabId })
  })
}

function newTab(url = 'https://search.theradicalparty.com'): number {
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  win.contentView.addChildView(view)
  view.setVisible(false)
  view.webContents.loadURL(url.startsWith('http') ? url : `https://${url}`)

  const id = view.webContents.id
  tabs.set(id, view)
  tabMeta.set(id, { title: 'New Tab', url })
  interceptShortcuts(view)
  attachDebugger(view, id)

  const push = (ch: string, data: object) => {
    if (!win.isDestroyed()) win.webContents.send(ch, data)
  }
  view.webContents.on('did-navigate', (_, u) => {
    tabMeta.set(id, { ...tabMeta.get(id)!, url: u })
    push('nav', { id, url: u })
  })
  view.webContents.on('did-navigate-in-page', (_, u) => {
    tabMeta.set(id, { ...tabMeta.get(id)!, url: u })
    push('nav', { id, url: u })
  })
  view.webContents.on('page-title-updated', (_, title) => {
    tabMeta.set(id, { ...tabMeta.get(id)!, title })
    push('title', { id, title })
  })
  view.webContents.on('did-start-loading', () => push('loading', { id, v: true }))
  view.webContents.on('did-stop-loading',  () => push('loading', { id, v: false }))
  view.webContents.on('page-favicon-updated', (_, favicons) => {
    if (favicons[0]) {
      tabMeta.set(id, { ...tabMeta.get(id)!, favicon: favicons[0] })
      push('favicon', { id, url: favicons[0] })
    }
  })

  return id
}

function activateTab(id: number) {
  if (activeId !== null) tabs.get(activeId)?.setVisible(false)
  const view = tabs.get(id)
  if (!view) return
  view.setVisible(true)
  view.setBounds(viewBounds())
  activeId = id
  win.webContents.send('activated', id)
}

app.setName('Radical Browser')

function buildMenu() {
  const send = (key: string) => () => win?.webContents.send('key', key)
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Radical Browser',
      submenu: [
        { role: 'about', label: 'About Radical Browser' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Radical Browser' },
      ],
    },
    {
      label: 'Browser',
      submenu: [
        { label: 'New Tab',               accelerator: 'CmdOrCtrl+T', click: send('t') },
        { label: 'Close Tab',             accelerator: 'CmdOrCtrl+W', click: send('w') },
        { type: 'separator' },
        { label: 'Command Palette',       accelerator: 'CmdOrCtrl+K', click: () => showPalette() },
        { label: 'Network Inspector',     accelerator: 'CmdOrCtrl+I', click: send('i') },
        { type: 'separator' },
        { label: 'Focus URL Bar',         accelerator: 'CmdOrCtrl+L', click: send('l') },
        { label: 'Reload',                accelerator: 'CmdOrCtrl+R', click: send('r') },
        { label: 'Go Back',               accelerator: 'CmdOrCtrl+[', click: send('[') },
        { label: 'Go Forward',            accelerator: 'CmdOrCtrl+]', click: send(']') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  buildMenu()

  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    cb({ cancel: isBlocked(details.url) })
  })

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 20 },
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadFile(join(__dirname, '../renderer/index.html'))

  win.on('resize', () => {
    if (activeId !== null) tabs.get(activeId)?.setBounds(viewBounds())
  })

  ipcMain.handle('tab:new', (_, url?: string) => {
    const id = newTab(url)
    activateTab(id)
    return id
  })

  ipcMain.handle('tab:activate', (_, id: number) => activateTab(id))

  ipcMain.handle('tab:close', (_, id: number) => {
    const view = tabs.get(id)
    if (!view) return [...tabs.keys()]
    win.contentView.removeChildView(view)
    view.webContents.close()
    tabs.delete(id)
    tabMeta.delete(id)
    if (activeId === id) {
      activeId = null
      const remaining = [...tabs.keys()]
      if (remaining.length > 0) activateTab(remaining[remaining.length - 1])
    }
    return [...tabs.keys()]
  })

  ipcMain.handle('tab:go', (_, { id, url }: { id: number; url: string }) => {
    tabs.get(id)?.webContents.loadURL(url.startsWith('http') ? url : `https://${url}`)
  })

  ipcMain.handle('tab:back',    (_, id: number) => tabs.get(id)?.webContents.goBack())
  ipcMain.handle('tab:forward', (_, id: number) => tabs.get(id)?.webContents.goForward())
  ipcMain.handle('tab:reload',  (_, id: number) => tabs.get(id)?.webContents.reload())
  ipcMain.handle('tab:stop',    (_, id: number) => tabs.get(id)?.webContents.stop())

  ipcMain.handle('panel:height', (_, h: number) => {
    panelH = h
    if (activeId !== null) tabs.get(activeId)?.setBounds(viewBounds())
  })

  win.webContents.once('did-finish-load', () => {
    const id = newTab()
    activateTab(id)
    win.webContents.send('init', id)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
