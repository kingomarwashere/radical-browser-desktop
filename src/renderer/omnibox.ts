declare const omni: {
  onItems: (fn: (d: { items: Item[]; sel: number }) => void) => void
  onSel:   (fn: (i: number) => void) => void
  pick:    (url: string) => void
}
interface Item { url: string; title: string; bookmark: boolean }

const list = document.getElementById('list')!
let items: Item[] = []
let sel = -1

function omniEsc(s: string) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
}
function omniPretty(u: string) {
  return u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
}

function omniRender() {
  list.innerHTML = items.map((it, i) => `
    <div class="row${i === sel ? ' sel' : ''}" data-i="${i}">
      <span class="ico">${it.bookmark ? '★' : '↗'}</span>
      <span class="u">${omniEsc(omniPretty(it.url))}</span>
      ${it.title ? `<span class="t">${omniEsc(it.title)}</span>` : ''}
    </div>`).join('')
}

// mousedown (not click) so it fires before the URL bar's blur hides us
list.addEventListener('mousedown', e => {
  const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null
  if (!row) return
  e.preventDefault()
  omni.pick(items[Number(row.dataset.i)].url)
})

omni.onItems(d => { items = d.items; sel = d.sel; omniRender() })
omni.onSel(i => { sel = i; omniRender() })
