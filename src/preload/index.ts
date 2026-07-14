import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('browser', {
  newTab:      (url?: string)                    => ipcRenderer.invoke('tab:new', url),
  activateTab: (id: number)                      => ipcRenderer.invoke('tab:activate', id),
  closeTab:    (id: number)                      => ipcRenderer.invoke('tab:close', id),
  go:          (id: number, url: string)         => ipcRenderer.invoke('tab:go', { id, url }),
  back:        (id: number)                      => ipcRenderer.invoke('tab:back', id),
  forward:     (id: number)                      => ipcRenderer.invoke('tab:forward', id),
  reload:      (id: number)                      => ipcRenderer.invoke('tab:reload', id),
  stop:        (id: number)                      => ipcRenderer.invoke('tab:stop', id),
  on: (channel: string, fn: (...a: unknown[]) => void) => {
    ipcRenderer.on(channel, (_, ...args) => fn(...args))
  },
})
