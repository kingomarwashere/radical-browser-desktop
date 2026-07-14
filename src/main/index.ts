import { app, BrowserWindow, WebContentsView, ipcMain, session } from 'electron'
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

let win: BrowserWindow
const tabs = new Map<number, WebContentsView>()
let activeId: number | null = null

function viewBounds() {
  const { width, height } = win.getContentBounds()
  return { x: 0, y: 88, width, height: height - 88 }
}

function newTab(url = 'https://duckduckgo.com'): number {
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  win.contentView.addChildView(view)
  view.setVisible(false)
  view.webContents.loadURL(url.startsWith('http') ? url : `https://${url}`)

  const id = view.webContents.id
  tabs.set(id, view)

  const push = (ch: string, data: object) => win.webContents.send(ch, data)
  view.webContents.on('did-navigate', (_, u) => push('nav', { id, url: u }))
  view.webContents.on('did-navigate-in-page', (_, u) => push('nav', { id, url: u }))
  view.webContents.on('page-title-updated', (_, title) => push('title', { id, title }))
  view.webContents.on('did-start-loading', () => push('loading', { id, v: true }))
  view.webContents.on('did-stop-loading', () => push('loading', { id, v: false }))
  view.webContents.on('page-favicon-updated', (_, favicons) => {
    if (favicons[0]) push('favicon', { id, url: favicons[0] })
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

app.whenReady().then(() => {
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

  ipcMain.handle('tab:back', (_, id: number) => tabs.get(id)?.webContents.goBack())
  ipcMain.handle('tab:forward', (_, id: number) => tabs.get(id)?.webContents.goForward())
  ipcMain.handle('tab:reload', (_, id: number) => tabs.get(id)?.webContents.reload())
  ipcMain.handle('tab:stop', (_, id: number) => tabs.get(id)?.webContents.stop())

  win.webContents.once('did-finish-load', () => {
    const id = newTab()
    activateTab(id)
    win.webContents.send('init', id)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
