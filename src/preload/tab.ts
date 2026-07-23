import { ipcRenderer } from 'electron'

// Electron doesn't implement window.prompt() — it returns null and warns, so
// pages that gate on `prompt()` (e.g. a password check) break silently. Provide
// a working prompt backed by a native dialog in the main process. Synchronous,
// matching the DOM contract. (Runs in the page's world — tabs use
// contextIsolation:false so this override is in place before page scripts run.)
window.prompt = (message?: string, defaultValue?: string): string | null => {
  try {
    const r = ipcRenderer.sendSync('window-prompt', {
      message: String(message ?? ''),
      defaultValue: defaultValue == null ? '' : String(defaultValue),
    })
    return typeof r === 'string' ? r : null
  } catch {
    return null
  }
}
