import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('panel', {
  getResponseBody: (tabId: number, reqId: string) => ipcRenderer.invoke('net:body', { tabId, reqId }),
  getCookies:      (tabId: number)                => ipcRenderer.invoke('net:cookies', tabId),
  replay:          (opts: object)                 => ipcRenderer.invoke('net:replay', opts),
  setPanelHeight:  (h: number)                    => ipcRenderer.invoke('panel:height', h),
  reconDns:        (host: string)   => ipcRenderer.invoke('recon:dns', host),
  reconReverseDns: (ip: string)     => ipcRenderer.invoke('recon:reverse-dns', ip),
  reconPortscan:   (host: string)   => ipcRenderer.invoke('recon:portscan', host),
  reconTls:        (host: string)   => ipcRenderer.invoke('recon:tls', host),
  reconWhois:      (domain: string) => ipcRenderer.invoke('recon:whois', domain),
  reconHttp:       (url: string)    => ipcRenderer.invoke('recon:http-recon', url),
  reconSubdomains: (domain: string) => ipcRenderer.invoke('recon:subdomains', domain),
  reconDetectTools:()               => ipcRenderer.invoke('recon:detect-tools'),
  reconRunTool:    (key: string, target: string) => ipcRenderer.invoke('recon:run-tool', { key, target }),
  reconCancelTool: (runId: string)  => ipcRenderer.invoke('recon:cancel-tool', runId),
  on: (channel: string, fn: (...a: unknown[]) => void) => {
    ipcRenderer.on(channel, (_, ...args) => fn(...args))
  },
})
