import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('omni', {
  onItems: (fn: (d: unknown) => void) => ipcRenderer.on('omni:items', (_, d) => fn(d)),
  onSel:   (fn: (i: unknown) => void) => ipcRenderer.on('omni:sel',   (_, i) => fn(i)),
  pick:    (url: string)              => ipcRenderer.send('omni:pick', url),
})
