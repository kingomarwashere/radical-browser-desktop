import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('browser', {
  newTab:          (url?: string)                    => ipcRenderer.invoke('tab:new', url),
  activateTab:     (id: number)                      => ipcRenderer.invoke('tab:activate', id),
  closeTab:        (id: number)                      => ipcRenderer.invoke('tab:close', id),
  go:              (id: number, url: string)         => ipcRenderer.invoke('tab:go', { id, url }),
  back:            (id: number)                      => ipcRenderer.invoke('tab:back', id),
  forward:         (id: number)                      => ipcRenderer.invoke('tab:forward', id),
  reload:          (id: number)                      => ipcRenderer.invoke('tab:reload', id),
  hardReload:      (id: number)                      => ipcRenderer.invoke('tab:hard-reload', id),
  stop:            (id: number)                      => ipcRenderer.invoke('tab:stop', id),
  tabMenu:         (id: number)                      => ipcRenderer.invoke('tab:menu', id),
  togglePanel:     ()                                => ipcRenderer.invoke('panel:toggle'),
  torStatus:       ()                                => ipcRenderer.invoke('tor:status'),
  torToggle:       ()                                => ipcRenderer.invoke('tor:toggle'),
  getBookmarks:    ()                                => ipcRenderer.invoke('bookmarks:get'),
  toggleBookmark:  (bm: object)                      => ipcRenderer.invoke('bookmarks:toggle', bm),
  saveSession:     (data: object)                    => ipcRenderer.send('session:save', data),
  omniQuery:       (text: string, left: number, width: number) => ipcRenderer.invoke('omni:query', { text, left, width }),
  omniSelect:      (sel: number)                     => ipcRenderer.invoke('omni:select', sel),
  omniHide:        ()                                => ipcRenderer.invoke('omni:hide'),
  getResponseBody: (tabId: number, reqId: string)    => ipcRenderer.invoke('net:body', { tabId, reqId }),
  getCookies:      (tabId: number)                   => ipcRenderer.invoke('net:cookies', tabId),
  replay:          (opts: object)                    => ipcRenderer.invoke('net:replay', opts),
  on: (channel: string, fn: (...a: unknown[]) => void) => {
    ipcRenderer.on(channel, (_, ...args) => fn(...args))
  },
})
