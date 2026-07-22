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

  if (tabItems.length)  sections.push({ section: 'Open Tabs', items: tabItems })
  if (bmItems.length)   sections.push({ section: 'Bookmarks', items: bmItems })
  if (cmdItems.length)  sections.push({ section: 'Commands', items: cmdItems })
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
        <span class="icon">${item.favicon ? `<img src="${item.favicon}">` : '›'}</span>
        <span class="label">${item.label}</span>
        ${item.sub ? `<span class="sub">${item.sub.replace(/^https?:\/\//, '')}</span>` : ''}
        ${item.key ? `<span class="key">${item.key}</span>` : ''}
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
