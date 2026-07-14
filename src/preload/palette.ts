import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('browser', {
  on: (channel: string, fn: (...a: unknown[]) => void) => {
    ipcRenderer.on(channel, (_, ...args) => fn(...args))
  },
  palette: {
    select:  (tabId: number) => ipcRenderer.send('palette:select', tabId),
    command: (cmd: string)   => ipcRenderer.send('palette:command', cmd),
    close:   ()              => ipcRenderer.send('palette:close'),
  },
})
