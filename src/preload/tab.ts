import { ipcRenderer } from 'electron'
import './youtube'   // YouTube video-ad stripping (list-based blocking can't reach these)

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

// ── Cosmetic ad-blocking: inject element-hiding CSS for this page ─────────────
// Base + hostname rules go in immediately; then we feed the page's element
// classes/ids to the engine (initial sweep + a throttled MutationObserver) to
// pull the generic rules that actually match this page's ad slots.
;(function cosmetics() {
  if (!/^https?:/.test(location.href)) return
  let styleEl: HTMLStyleElement | null = null
  const injectedRules = new Set<string>()
  function inject(css: string) {
    if (!css) return
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.setAttribute('data-radical-adblock', '')
      ;(document.head || document.documentElement).appendChild(styleEl)
    }
    let add = ''
    for (const rule of css.split('\n')) {
      if (rule && !injectedRules.has(rule)) { injectedRules.add(rule); add += rule + '\n' }
    }
    if (add) styleEl.textContent += add
  }
  const seenC = new Set<string>(), seenI = new Set<string>()
  function harvest() {
    const classes: string[] = [], ids: string[] = []
    try {
      document.querySelectorAll('[class],[id]').forEach(el => {
        const cn = (el as HTMLElement).className
        if (typeof cn === 'string') for (const c of cn.split(/\s+/)) if (c && !seenC.has(c)) { seenC.add(c); classes.push(c) }
        const idv = (el as HTMLElement).id
        if (idv && !seenI.has(idv)) { seenI.add(idv); ids.push(idv) }
      })
    } catch {}
    return { classes, ids }
  }
  function pull(dom: boolean) {
    const sig = dom ? harvest() : { classes: [], ids: [] }
    if (dom && !sig.classes.length && !sig.ids.length) return
    ipcRenderer.invoke('adblock:cosmetics', { url: location.href, classes: sig.classes, ids: sig.ids }).then(inject).catch(() => {})
  }
  pull(false)   // base + hostname rules, right away
  const start = () => {
    pull(true)  // generics matched to elements already on the page
    let t: ReturnType<typeof setTimeout>
    new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => pull(true), 300) })
      .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
