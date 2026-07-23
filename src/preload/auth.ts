import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('auth', {
  onInfo: (fn: (d: unknown) => void) => ipcRenderer.on('auth:info', (_, d) => fn(d)),
  submit: (username: string, password: string) => ipcRenderer.send('auth:submit', { username, password }),
  cancel: () => ipcRenderer.send('auth:cancel'),
})
