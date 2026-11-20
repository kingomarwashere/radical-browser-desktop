declare const browser: {
  on: (ch: string, fn: (...a: unknown[]) => void) => void
  palette: {
    select:  (tabId: number) => void
    command: (cmd: string)   => void
    close:   ()              => void
  }
}

interface PTab      { id: number; title: string; url: string; favicon?: string }
interface PBookmark { url: string; title: string; favicon?: string }
interface PItem     { favicon?: string; label: string; sub?: string; key?: string; onSelect: () => void }

const input   = document.getElementById('input')   as HTMLInputElement
const results = document.getElementById('results')!

let allTabs:      PTab[]      = []
let allBookmarks: PBookmark[] = []
let sel  = 0
let flat: PItem[] = []

// Tab/bookmark titles, URLs and favicon URLs are page-controlled (a site sets
// its own document.title and favicon), so every one of them MUST be escaped
// before going into innerHTML — otherwise a page titled `<img onerror=…>` runs
// script in this palette window, which holds the privileged `browser` bridge.
function esc(s: string) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
}

const SEARCH_URL  = 'https://search.theradicalparty.com'
const SEARCH_HOST = 'search.theradicalparty.com'
// Mirror the address bar's heuristic: a scheme, localhost/IP, or host.tld with no
// spaces is a URL; anything else is a search query.
function looksLikeUrl(s: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:')) return true
  if (s.includes(' ')) return false
  return /^localhost(:\d+)?(\/.*)?$/i.test(s)
    || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(s)
    || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)
}
function toUrl(s: string): string {
  return (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:')) ? s : `https://${s}`
}

const COMMANDS: PItem[] = [
  { label: 'New Tab',                  key: '⌘T', onSelect: () => browser.palette.command('new-tab') },
  { label: 'Close Tab',               key: '⌘W', onSelect: () => browser.palette.command('close-tab') },
  { label: 'Reload',                   key: '⌘R', onSelect: () => browser.palette.command('reload') },
  { label: 'Go Back',                  key: '⌘[', onSelect: () => browser.palette.command('back') },
  { label: 'Go Forward',              key: '⌘]', onSelect: () => browser.palette.command('forward') },
  { label: 'Focus URL Bar',           key: '⌘L', onSelect: () => browser.palette.command('focus-url') },
  { label: 'Toggle Network Inspector', key: '⌘I', onSelect: () => browser.palette.command('toggle-inspector') },
]

function getSections(q: string) {
  const lq = q.toLowerCase()
  const sections: { section: string; items: PItem[] }[] = []

  const tabItems = allTabs
    .filter(t => !lq || t.title.toLowerCase().includes(lq) || t.url.toLowerCase().includes(lq))
    .map(t => ({
      favicon: t.favicon,
      label: t.title || t.url || 'New Tab',
      sub: t.url,
      onSelect: () => browser.palette.select(t.id),
    }))

  const cmdItems = COMMANDS.filter(c => !lq || c.label.toLowerCase().includes(lq))

  const bmAll = allBookmarks.filter(b =>
    !lq || b.title.toLowerCase().includes(lq) || b.url.toLowerCase().includes(lq)
  )
  const bmItems = (lq ? bmAll : bmAll.slice(0, 6)).map(b => ({
    favicon: b.favicon,
    label: b.title || b.url,
    sub: b.url.replace(/^https?:\/\//, ''),
    onSelect: () => browser.palette.command('navigate:' + b.url),
  }))

  // Spotlight-style fallback: anything you type can be opened as a URL or sent to
  // web search. Listed last so a matching tab/bookmark still wins by default, but
  // when nothing matches this is the top (and Enter-able) result.
  const query = q.trim()
  const searchItems: PItem[] = []
  if (query) {
    if (looksLikeUrl(query)) {
      searchItems.push({ label: `Open ${query}`, sub: query, onSelect: () => browser.palette.command('navigate:' + toUrl(query)) })
    }
    searchItems.push({
      label: `Search the web for “${query}”`, sub: SEARCH_HOST,
      onSelect: () => browser.palette.command('navigate:' + SEARCH_URL + '/?q=' + encodeURIComponent(query)),
    })
  }

  if (tabItems.length)    sections.push({ section: 'Open Tabs', items: tabItems })
  if (bmItems.length)     sections.push({ section: 'Bookmarks', items: bmItems })
  if (cmdItems.length)    sections.push({ section: 'Commands', items: cmdItems })
  if (searchItems.length) sections.push({ section: 'Search', items: searchItems })
  return sections
}

function render(q: string) {
  sel = 0
  const sections = getSections(q)
  flat = sections.flatMap(s => s.items)

  if (!flat.length) {
    results.innerHTML = '<div class="empty">No results</div>'
    return
  }

  let idx = 0
  results.innerHTML = sections.map(({ section, items }) => `
    <div class="section">${section}</div>
    ${items.map(item => {
      const i = idx++
      return `<div class="item${i === 0 ? ' sel' : ''}" data-idx="${i}">
        <span class="icon">${item.favicon ? `<img src="${esc(item.favicon)}">` : '›'}</span>
        <span class="label">${esc(item.label)}</span>
        ${item.sub ? `<span class="sub">${esc(item.sub.replace(/^https?:\/\//, ''))}</span>` : ''}
        ${item.key ? `<span class="key">${esc(item.key)}</span>` : ''}
      </div>`
    }).join('')}
  `).join('')
}

function move(dir: 1 | -1) {
  const els = results.querySelectorAll<HTMLElement>('.item')
  if (!els.length) return
  els[sel]?.classList.remove('sel')
  sel = (sel + dir + els.length) % els.length
  els[sel]?.classList.add('sel')
  els[sel]?.scrollIntoView({ block: 'nearest' })
}

function activate() {
  flat[sel]?.onSelect()
}

browser.on('palette:init', (raw: unknown) => {
  const { tabs, bookmarks } = raw as { tabs: PTab[]; bookmarks?: PBookmark[] }
  allTabs = tabs
  allBookmarks = bookmarks ?? []
  render('')
  input.focus()
})

input.addEventListener('input', () => render(input.value))

input.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown')  { e.preventDefault(); move(1) }
  if (e.key === 'ArrowUp')    { e.preventDefault(); move(-1) }
  if (e.key === 'Enter')      { e.preventDefault(); activate() }
  if (e.key === 'Escape')     { browser.palette.close() }
})

results.addEventListener('mousedown', e => {
  const el = (e.target as Element).closest('.item') as HTMLElement | null
  if (!el) return
  sel = parseInt(el.dataset.idx ?? '0')
  activate()
})
