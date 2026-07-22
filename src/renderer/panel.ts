declare const panel: {
  getResponseBody: (tabId: number, reqId: string) => Promise<{ body: string; base64Encoded: boolean } | null>
  getCookies:      (tabId: number)                => Promise<any[]>
  replay:          (opts: object)                 => Promise<any>
  setPanelHeight:  (h: number)                    => Promise<void>
  reconDns:        (host: string)   => Promise<any>
  reconReverseDns: (ip: string)     => Promise<any>
  reconPortscan:   (host: string)   => Promise<any>
  reconTls:        (host: string)   => Promise<any>
  reconWhois:      (domain: string) => Promise<any>
  reconHttp:       (url: string)    => Promise<any>
  reconSubdomains: (domain: string) => Promise<any>
  reconDetectTools:()               => Promise<any[]>
  reconRunTool:    (key: string, target: string) => Promise<any>
  reconCancelTool: (runId: string)  => Promise<any>
  on:              (ch: string, fn: (...a: unknown[]) => void) => void
}

interface NetEntry {
  id: string; method: string; url: string; type?: string
  reqHeaders?: Record<string, string>; reqBody?: string | null; initiator?: string
  status?: number; statusText?: string; mimeType?: string
  resHeaders?: Record<string, string>; remoteIP?: string; protocol?: string; securityState?: string
  startTime: number; endTime?: number; size?: number; failed?: boolean; cancelled?: boolean
  warns: string[]
}

// ── Security checks ──────────────────────────────────────────────────────
interface SecCheck { header: string; label: string; desc: string; severity: string; points: number }
const SEC_CHECKS: SecCheck[] = [
  { header: 'strict-transport-security', label: 'HSTS',                   desc: 'Forces HTTPS. Prevents MITM and protocol downgrade.',       severity: 'critical', points: 30 },
  { header: 'content-security-policy',   label: 'Content-Security-Policy', desc: 'Mitigates XSS. Specifies trusted content sources.',         severity: 'high',     points: 25 },
  { header: 'x-content-type-options',    label: 'X-Content-Type-Options',  desc: 'Prevents MIME-sniffing. Should be "nosniff".',              severity: 'medium',   points: 10 },
  { header: 'x-frame-options',           label: 'X-Frame-Options',         desc: 'Prevents clickjacking. Use DENY or SAMEORIGIN.',           severity: 'medium',   points: 10 },
  { header: 'referrer-policy',           label: 'Referrer-Policy',         desc: 'Controls referrer data sent with requests.',                severity: 'low',      points: 8  },
  { header: 'permissions-policy',        label: 'Permissions-Policy',      desc: 'Controls browser features (camera, mic, geolocation).',    severity: 'low',      points: 7  },
  { header: 'cross-origin-opener-policy',label: 'COOP',                    desc: 'Prevents cross-origin window.opener exploits.',            severity: 'medium',   points: 5  },
  { header: 'cross-origin-resource-policy', label: 'CORP',                desc: 'Prevents cross-origin resource reads.',                     severity: 'low',      points: 5  },
]

function scoreGrade(score: number): { letter: string; cls: string } {
  if (score >= 90) return { letter: 'A+', cls: 'grade-a' }
  if (score >= 75) return { letter: 'A',  cls: 'grade-a' }
  if (score >= 55) return { letter: 'B',  cls: 'grade-b' }
  if (score >= 35) return { letter: 'C',  cls: 'grade-c' }
  if (score >= 15) return { letter: 'D',  cls: 'grade-df' }
  return { letter: 'F', cls: 'grade-df' }
}

function fingerprintTech(headers: Record<string, string>): { label: string; warn: boolean }[] {
  const h = (k: string) => (headers[k] || headers[k.toLowerCase()] || '').toLowerCase()
  const out: { label: string; warn: boolean }[] = []

  const server = h('server')
  if (server.includes('nginx'))      out.push({ label: 'Nginx', warn: false })
  else if (server.includes('apache')) out.push({ label: 'Apache', warn: false })
  else if (server.includes('cloudflare')) out.push({ label: 'Cloudflare', warn: false })
  else if (server.includes('iis'))    out.push({ label: 'IIS', warn: false })
  else if (server.includes('litespeed')) out.push({ label: 'LiteSpeed', warn: false })
  else if (server.includes('caddy'))  out.push({ label: 'Caddy', warn: false })
  if (server && /\d+\.\d+/.test(server)) out.push({ label: `⚠ Server version: ${server}`, warn: true })

  const pb = h('x-powered-by')
  if (pb) {
    if (pb.includes('php'))    out.push({ label: `PHP${pb.match(/[\d.]+/)?.[0] ? ' '+pb.match(/[\d.]+/)![0] : ''}`, warn: false })
    else if (pb.includes('asp.net')) out.push({ label: 'ASP.NET', warn: false })
    else if (pb.includes('express')) out.push({ label: 'Express.js', warn: false })
    else if (pb.includes('next.js')) out.push({ label: 'Next.js', warn: false })
    else out.push({ label: pb, warn: false })
    if (/\d/.test(pb)) out.push({ label: `⚠ Framework version disclosed`, warn: true })
  }

  if (h('cf-ray') || h('cf-cache-status'))       out.push({ label: 'Cloudflare CDN', warn: false })
  if (h('x-fastly-request-id'))                  out.push({ label: 'Fastly CDN', warn: false })
  if (h('x-amz-cf-id'))                          out.push({ label: 'AWS CloudFront', warn: false })
  if (h('x-aspnet-version'))                     out.push({ label: `⚠ ASP.NET: ${h('x-aspnet-version')}`, warn: true })
  if (h('x-generator')?.includes('wordpress'))   out.push({ label: 'WordPress', warn: false })
  if (h('x-drupal-cache'))                       out.push({ label: 'Drupal', warn: false })
  if (h('x-shopify-stage') || h('x-shardid'))    out.push({ label: 'Shopify', warn: false })

  const cors = h('access-control-allow-origin')
  if (cors === '*') out.push({ label: '⚠ CORS: Allow-Origin wildcard', warn: true })

  return out
}

function analyseWarns(entry: NetEntry): string[] {
  const w: string[] = []
  const h = entry.resHeaders ?? {}
  const lh = (k: string) => h[k] || h[k.toLowerCase()] || ''
  if (entry.url.startsWith('http://') && !entry.url.startsWith('http://localhost')) w.push('NO HTTPS')
  if (entry.type === 'Document' || entry.type === 'document') {
    if (!lh('strict-transport-security')) w.push('NO HSTS')
    if (!lh('content-security-policy'))   w.push('NO CSP')
  }
  const server = lh('server')
  const pb = lh('x-powered-by')
  if (server && /\d+\.\d+/.test(server)) w.push('VER DISCLOSURE')
  if (pb && /\d/.test(pb))               w.push('FRAMEWORK VER')
  if (lh('x-aspnet-version'))            w.push('ASPNET VER')
  if (lh('access-control-allow-origin') === '*') w.push('CORS WILDCARD')
  return w
}

// ── Helpers ───────────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!

function fmtSize(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)}K`
  return `${(b / 1048576).toFixed(1)}M`
}

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function b64urlDecode(s: string): string {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + (4 - s.length % 4) % 4, '=')
  try { return atob(pad) } catch { return s }
}

function decodeJWT(token: string) {
  const parts = token.trim().split('.')
  if (parts.length !== 3) return null
  try {
    return {
      header:  JSON.parse(b64urlDecode(parts[0])),
      payload: JSON.parse(b64urlDecode(parts[1])),
      sig:     parts[2],
    }
  } catch { return null }
}

async function sha256(msg: string): Promise<string> {
  const buf = new TextEncoder().encode(msg)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}
async function sha512(msg: string): Promise<string> {
  const buf = new TextEncoder().encode(msg)
  const hash = await crypto.subtle.digest('SHA-512', buf)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── State ─────────────────────────────────────────────────────────────────
const netLog  = new Map<number, NetEntry[]>()
const netById = new Map<number, Map<string, NetEntry>>()
let active: number | null = null
let preserveLog  = false
let netFilter    = ''
let panelH       = 400
let panelTab     = 'network'
let detailTab    = 'headers'
let selectedReq: NetEntry | null = null
let pageHeaders: Record<string, string> | null = null
let pageUrl = ''
let toolTab = 'base64'
let reconTool = 'dns'

const filterIn = $('panel-filter') as HTMLInputElement

// ── Panel resize ──────────────────────────────────────────────────────────
let resizing = false, resizeStartY = 0, resizeStartH = 0

$('panel-resize').addEventListener('mousedown', e => {
  resizing = true; resizeStartY = e.clientY; resizeStartH = panelH
  $('panel-resize').classList.add('dragging')
  e.preventDefault()
})
document.addEventListener('mousemove', e => {
  if (!resizing) return
  const delta = resizeStartY - e.clientY
  panelH = Math.max(180, Math.min(window.screen.height - 160, resizeStartH + delta))
})
document.addEventListener('mouseup', async () => {
  if (!resizing) return
  resizing = false
  $('panel-resize').classList.remove('dragging')
  await panel.setPanelHeight(panelH)
})

// ── Panel tab switching ───────────────────────────────────────────────────
function setPanelTab(t: string) {
  panelTab = t
  document.querySelectorAll('.ptab').forEach(el => {
    el.classList.toggle('active', (el as HTMLElement).dataset.ptab === t)
  })
  document.querySelectorAll('.ptab-content').forEach(el => {
    el.classList.toggle('active', el.id === `ptab-${t}`)
  })
  if (t === 'security') renderSecurity()
  if (t === 'cookies')  loadCookies()
  if (t === 'tools')    renderTool(toolTab)
  if (t === 'recon')    prepRecon()
}

document.querySelectorAll('.ptab').forEach(el => {
  el.addEventListener('mousedown', () => setPanelTab((el as HTMLElement).dataset.ptab!))
})

// ── Network rendering ─────────────────────────────────────────────────────
function getOrCreate(tabId: number) {
  if (!netLog.has(tabId))  netLog.set(tabId, [])
  if (!netById.has(tabId)) netById.set(tabId, new Map())
  return { log: netLog.get(tabId)!, idx: netById.get(tabId)! }
}

function renderNet() {
  const tabId = active ?? -1
  const log   = netLog.get(tabId) ?? []
  const rows  = netFilter ? log.filter(e => e.url.toLowerCase().includes(netFilter)) : log
  const empty = $('net-empty')
  empty.style.display = rows.length === 0 ? '' : 'none'

  const tbody = $('net-tbody')
  tbody.innerHTML = rows.map(e => {
    const cls = !e.status ? (e.failed ? 's-fail' : 's-pending')
              : e.status < 300 ? 's-ok'
              : e.status < 400 ? 's-redirect'
              : e.status < 500 ? 's-warn'
              : 's-error'
    const time   = e.endTime ? `${((e.endTime - e.startTime) * 1000) | 0}ms` : '…'
    const size   = e.size != null ? fmtSize(e.size) : '—'
    const status = e.failed && !e.status ? 'ERR' : (e.status ?? '…')
    const type   = e.type ?? (e.mimeType ? e.mimeType.split('/')[1] : '—')
    const short  = e.url.replace(/^https?:\/\/[^/]+/, '') || '/'
    const warnTip = e.warns.join(' | ')
    const sel    = selectedReq?.id === e.id ? ' sel' : ''
    return `<tr class="${cls}${e.warns.length ? ' has-warn' : ''}${sel}" data-id="${escHtml(e.id)}">
      <td class="nc-method">${e.method}</td>
      <td class="nc-url" title="${escHtml(e.url)}">${escHtml(short || e.url)}</td>
      <td class="nc-status">${status}</td>
      <td class="nc-type">${escHtml(type)}</td>
      <td class="nc-size">${size}</td>
      <td class="nc-time">${time}</td>
      <td class="nc-warn" title="${escHtml(warnTip)}">${e.warns.length ? '⚠' : ''}</td>
    </tr>`
  }).join('')

  const wrap = $('net-list-wrap')
  if (wrap) wrap.scrollTop = wrap.scrollHeight
}

// Coalesce bursts of net events (req/res/done can fire hundreds of times per
// page load) into at most one table rebuild per animation frame.
let netRenderQueued = false
function scheduleNetRender() {
  if (netRenderQueued) return
  netRenderQueued = true
  requestAnimationFrame(() => { netRenderQueued = false; renderNet() })
}

// One delegated click handler instead of re-binding every row on every render.
$('net-tbody').addEventListener('mousedown', e => {
  const tr = (e.target as HTMLElement).closest('tr') as HTMLElement | null
  if (!tr || active === null) return
  const entry = netById.get(active)?.get(tr.dataset.id ?? '')
  if (entry) selectReq(entry)
})

function selectReq(e: NetEntry) {
  selectedReq = e
  renderNet()
  $('net-detail').classList.add('open')
  renderDetail()
}

function renderDetail() {
  if (!selectedReq) return
  const e = selectedReq
  const body = $('detail-body')

  if (detailTab === 'headers') {
    const reqH = e.reqHeaders ?? {}
    const resH = e.resHeaders ?? {}
    const warns = e.warns.map(w => `<span class="warn-badge wb-medium">${escHtml(w)}</span>`).join('')

    body.innerHTML = `
      ${warns ? `<div style="margin-bottom:8px">${warns}</div>` : ''}
      <div class="dhead">Request Headers</div>
      <div class="dkv"><span class="dk">Method</span><span class="dv">${e.method}</span></div>
      <div class="dkv"><span class="dk">URL</span><span class="dv">${escHtml(e.url)}</span></div>
      ${e.initiator ? `<div class="dkv"><span class="dk">Initiator</span><span class="dv">${e.initiator}</span></div>` : ''}
      ${Object.entries(reqH).map(([k,v]) => `<div class="dkv"><span class="dk">${escHtml(k)}</span><span class="dv">${escHtml(v)}</span></div>`).join('')}
      ${e.reqBody ? `<div class="dhead">Request Body</div><div class="dv" style="word-break:break-all;white-space:pre-wrap">${escHtml(e.reqBody)}</div>` : ''}
      <div class="dhead">Response Headers</div>
      <div class="dkv"><span class="dk">Status</span><span class="dv">${e.status ?? '—'} ${e.statusText ?? ''}</span></div>
      ${e.remoteIP ? `<div class="dkv"><span class="dk">Remote IP</span><span class="dv">${e.remoteIP}</span></div>` : ''}
      ${e.protocol ? `<div class="dkv"><span class="dk">Protocol</span><span class="dv">${e.protocol}</span></div>` : ''}
      ${Object.entries(resH).map(([k,v]) => `<div class="dkv"><span class="dk">${escHtml(k)}</span><span class="dv">${escHtml(v)}</span></div>`).join('')}
    `
  } else if (detailTab === 'body') {
    body.innerHTML = `<div style="color:var(--text3);font-size:11px">Loading body…</div>`
    if (active !== null && e.id) {
      panel.getResponseBody(active, e.id).then(result => {
        if (!result) { body.innerHTML = `<div style="color:var(--text3)">Body not available (may have been evicted from buffer)</div>`; return }
        const content = result.base64Encoded
          ? atob(result.body).slice(0, 50000)
          : result.body.slice(0, 50000)
        const trimmed = result.body.length > 50000 ? '\n\n… (truncated at 50KB)' : ''
        body.innerHTML = `<pre style="white-space:pre-wrap;word-break:break-all;font-size:10px;color:var(--text)">${escHtml(content)}${trimmed}</pre>`
      })
    }
  } else if (detailTab === 'replay') {
    // Pre-fill replay tool from selected request
    renderTool('replay', e)
    setPanelTab('tools')
    document.querySelectorAll('.ttab').forEach(el => {
      el.classList.toggle('active', (el as HTMLElement).dataset.ttab === 'replay')
    })
    toolTab = 'replay'
  }
}

// ── Detail tab switching ──────────────────────────────────────────────────
document.querySelectorAll('.dtab').forEach(el => {
  el.addEventListener('mousedown', () => {
    detailTab = (el as HTMLElement).dataset.dtab!
    document.querySelectorAll('.dtab').forEach(d => d.classList.toggle('active', d === el))
    renderDetail()
  })
})
$('detail-close').addEventListener('mousedown', () => {
  selectedReq = null
  $('net-detail').classList.remove('open')
  renderNet()
})

// ── Security scanner ──────────────────────────────────────────────────────
function renderSecurity() {
  const intro = $('sec-intro')
  const data  = $('sec-data')
  if (!pageHeaders) { intro.style.display = ''; data.style.display = 'none'; return }
  intro.style.display = 'none'; data.style.display = ''

  const h = (k: string) => pageHeaders![k] || pageHeaders![k.toLowerCase()] || ''
  $('sec-url').textContent = pageUrl

  let score = 0
  const checks = SEC_CHECKS.map(c => {
    const val = h(c.header)
    const pass = !!val
    if (pass) score += c.points
    return { ...c, pass, val }
  })

  const { letter, cls } = scoreGrade(score)
  $('sec-grade').className = `grade ${cls}`
  $('sec-grade').textContent = letter

  $('sec-checks').innerHTML = checks.map(c => `
    <div class="sec-check sev-${c.severity}">
      <div class="sec-check-icon">${c.pass ? '✓' : '✗'}</div>
      <div class="sec-check-body">
        <div class="sec-check-name">${c.label}</div>
        ${c.pass ? `<div class="sec-check-value">${escHtml(c.val.slice(0,80))}</div>` : `<div class="sec-check-desc">${c.desc}</div>`}
      </div>
      <div>${c.pass
        ? `<span class="warn-badge wb-ok">PASS</span>`
        : `<span class="warn-badge wb-${c.severity === 'critical' ? 'critical' : c.severity === 'high' ? 'high' : 'medium'}">${c.severity.toUpperCase()}</span>`
      }</div>
    </div>
  `).join('')

  const techs = fingerprintTech(pageHeaders!)
  $('sec-tech').innerHTML = techs.length
    ? techs.map(t => `<span class="tech-badge${t.warn ? ' warn' : ''}">${escHtml(t.label)}</span>`).join('')
    : `<span style="color:var(--text3);font-size:11px">Nothing detected</span>`
}

// ── Cookies ───────────────────────────────────────────────────────────────
async function loadCookies() {
  if (active === null) return
  $('cookie-msg').textContent = 'Loading…'
  const cookies = await panel.getCookies(active)
  if (!cookies.length) { $('cookie-msg').textContent = 'No cookies found'; return }
  $('cookie-msg').style.display = 'none'
  const ct = $('cookie-table') as HTMLTableElement
  ct.style.display = ''
  $('cookie-tbody').innerHTML = cookies.map((c: any) => `
    <tr>
      <td title="${escHtml(c.name)}">${escHtml(c.name)}</td>
      <td title="${escHtml(c.value)}">${escHtml(c.value.slice(0,30))}${c.value.length > 30 ? '…' : ''}</td>
      <td>${escHtml(c.domain)}</td>
      <td>${escHtml(c.path)}</td>
      <td class="${c.httpOnly ? 'ck-flag-y' : 'ck-flag-n'}">${c.httpOnly ? '✓' : '✗'}</td>
      <td class="${c.secure   ? 'ck-flag-y' : 'ck-flag-n'}">${c.secure   ? '✓' : '✗'}</td>
      <td>${escHtml(c.sameSite || '—')}</td>
    </tr>
  `).join('')
}

// ── Tools ─────────────────────────────────────────────────────────────────
function renderTool(t: string, prefill?: NetEntry) {
  const c = $('tools-content')
  if (t === 'base64') {
    c.innerHTML = `
      <div class="tool-col">
        <div class="tool-label">Input</div>
        <textarea class="tool-textarea" id="b64-in" placeholder="Enter text to encode or base64 to decode…"></textarea>
        <div class="tool-btns">
          <button class="tool-btn primary" id="b64-enc">Encode</button>
          <button class="tool-btn" id="b64-dec">Decode</button>
          <button class="tool-btn" id="b64-clear">Clear</button>
        </div>
      </div>
      <div class="tool-col">
        <div class="tool-label">Output</div>
        <textarea class="tool-textarea" id="b64-out" readonly style="height:100px;user-select:text;-webkit-user-select:text"></textarea>
      </div>`
    const i = $('b64-in') as HTMLTextAreaElement
    const o = $('b64-out') as HTMLTextAreaElement
    $('b64-enc').addEventListener('click', () => { try { o.value = btoa(unescape(encodeURIComponent(i.value))) } catch { o.value = 'Error: invalid input' } })
    $('b64-dec').addEventListener('click', () => { try { o.value = decodeURIComponent(escape(atob(i.value.trim()))) } catch { o.value = 'Error: invalid base64' } })
    $('b64-clear').addEventListener('click', () => { i.value = ''; o.value = '' })

  } else if (t === 'url') {
    c.innerHTML = `
      <div class="tool-col">
        <div class="tool-label">Input</div>
        <textarea class="tool-textarea" id="url-in" placeholder="Enter text or encoded URL…"></textarea>
        <div class="tool-btns">
          <button class="tool-btn primary" id="url-enc">Encode</button>
          <button class="tool-btn" id="url-dec">Decode</button>
          <button class="tool-btn" id="url-full">Full URL Parse</button>
        </div>
      </div>
      <div class="tool-col">
        <div class="tool-label">Output</div>
        <textarea class="tool-textarea" id="url-out" readonly style="height:140px;user-select:text;-webkit-user-select:text"></textarea>
      </div>`
    const i = $('url-in') as HTMLTextAreaElement
    const o = $('url-out') as HTMLTextAreaElement
    $('url-enc').addEventListener('click',  () => { try { o.value = encodeURIComponent(i.value) } catch { o.value = 'Error' } })
    $('url-dec').addEventListener('click',  () => { try { o.value = decodeURIComponent(i.value) } catch { o.value = 'Error: invalid encoding' } })
    $('url-full').addEventListener('click', () => {
      try {
        const u = new URL(i.value.includes('://') ? i.value : 'https://' + i.value)
        o.value = [
          `Protocol:  ${u.protocol}`,
          `Host:      ${u.hostname}`,
          `Port:      ${u.port || '(default)'}`,
          `Path:      ${u.pathname}`,
          `Query:     ${u.search || '(none)'}`,
          `Hash:      ${u.hash || '(none)'}`,
          '',
          ...Array.from(u.searchParams.entries()).map(([k,v]) => `  ?${k} = ${v}`),
        ].join('\n')
      } catch { o.value = 'Error: invalid URL' }
    })

  } else if (t === 'jwt') {
    c.innerHTML = `
      <div class="tool-col">
        <div class="tool-label">JWT Token</div>
        <textarea class="tool-textarea" id="jwt-in" placeholder="Paste JWT here (eyJ…)"></textarea>
        <div class="tool-btns">
          <button class="tool-btn primary" id="jwt-dec">Decode</button>
          <button class="tool-btn" id="jwt-clear">Clear</button>
        </div>
        <div id="jwt-out"></div>
      </div>`
    const i = $('jwt-in') as HTMLTextAreaElement
    const o = $('jwt-out')
    $('jwt-dec').addEventListener('click', () => {
      const r = decodeJWT(i.value)
      if (!r) { o.innerHTML = `<div style="color:var(--red2);font-size:11px">Not a valid JWT</div>`; return }
      o.innerHTML = `
        <div class="jwt-section"><div class="jwt-label">Header</div><div class="jwt-val">${escHtml(JSON.stringify(r.header, null, 2))}</div></div>
        <div class="jwt-section"><div class="jwt-label">Payload</div><div class="jwt-val">${escHtml(JSON.stringify(r.payload, null, 2))}</div></div>
        <div class="jwt-section"><div class="jwt-label">Signature (raw)</div><div class="jwt-val" style="word-break:break-all;color:var(--text3)">${r.sig}</div></div>
        ${r.payload.exp ? `<div style="font-size:10px;color:${Date.now()/1000 > r.payload.exp ? 'var(--red2)' : 'var(--green2)'};margin-top:6px">
          Expires: ${new Date(r.payload.exp * 1000).toISOString()} — ${Date.now()/1000 > r.payload.exp ? '⚠ EXPIRED' : '✓ Valid'}
        </div>` : ''}
      `
    })
    $('jwt-clear').addEventListener('click', () => { i.value = ''; o.innerHTML = '' })

  } else if (t === 'hash') {
    c.innerHTML = `
      <div class="tool-col">
        <div class="tool-label">Input</div>
        <textarea class="tool-textarea" id="hash-in" placeholder="Enter text to hash…"></textarea>
        <div class="tool-btns">
          <button class="tool-btn primary" id="hash-sha256">SHA-256</button>
          <button class="tool-btn" id="hash-sha512">SHA-512</button>
        </div>
      </div>
      <div class="tool-col">
        <div class="tool-label">Output</div>
        <textarea class="tool-textarea" id="hash-out" readonly style="height:100px;user-select:text;-webkit-user-select:text;word-break:break-all"></textarea>
      </div>`
    const i = $('hash-in') as HTMLTextAreaElement
    const o = $('hash-out') as HTMLTextAreaElement
    $('hash-sha256').addEventListener('click', async () => { o.value = 'Computing…'; o.value = await sha256(i.value) })
    $('hash-sha512').addEventListener('click', async () => { o.value = 'Computing…'; o.value = await sha512(i.value) })

  } else if (t === 'replay') {
    const method  = prefill?.method ?? 'GET'
    const url     = prefill?.url ?? ''
    const headers = prefill?.reqHeaders ?? {}
    const body    = prefill?.reqBody ?? ''
    const headerStr = Object.entries(headers).map(([k,v]) => `${k}: ${v}`).join('\n')

    c.innerHTML = `
      <div style="flex:1;display:flex;flex-direction:column;gap:8px">
        <div class="tool-label">Request</div>
        <div class="replay-row">
          <select class="replay-method" id="rp-method">
            ${['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map(m =>
              `<option${m===method?' selected':''}>${m}</option>`).join('')}
          </select>
          <input class="replay-url" id="rp-url" value="${escHtml(url)}" placeholder="https://…">
        </div>
        <div class="tool-label">Headers (one per line: Key: Value)</div>
        <textarea class="tool-textarea" id="rp-headers" style="height:70px">${escHtml(headerStr)}</textarea>
        <div class="tool-label">Body</div>
        <textarea class="tool-textarea" id="rp-body" style="height:50px">${escHtml(body || '')}</textarea>
        <div class="tool-btns">
          <button class="tool-btn primary" id="rp-send">Send Request</button>
          <button class="tool-btn" id="rp-clear-res">Clear</button>
        </div>
        <div class="tool-label">Response</div>
        <div id="replay-res">—</div>
      </div>`
    $('rp-send').addEventListener('click', async () => {
      const rMethod  = ($('rp-method') as HTMLSelectElement).value
      const rUrl     = ($('rp-url') as HTMLInputElement).value
      const rHeaders = Object.fromEntries(
        ($('rp-headers') as HTMLTextAreaElement).value.split('\n')
          .filter(l => l.includes(':'))
          .map(l => { const i = l.indexOf(':'); return [l.slice(0,i).trim(), l.slice(i+1).trim()] })
      )
      const rBody = ($('rp-body') as HTMLTextAreaElement).value
      $('replay-res').textContent = 'Sending…'
      const res = await panel.replay({ method: rMethod, url: rUrl, headers: rHeaders, body: rBody || undefined })
      if (res.ok === false) {
        $('replay-res').textContent = `Error: ${res.error}`
      } else {
        $('replay-res').innerHTML = `<span style="color:${res.status<400?'var(--green2)':'var(--red2)'}">${res.status} ${res.statusText}</span>\n` +
          Object.entries(res.headers as Record<string,string>).map(([k,v]) => `${k}: ${v}`).join('\n') +
          '\n\n' + (res.body?.slice(0, 8000) ?? '')
      }
    })
    $('rp-clear-res').addEventListener('click', () => { $('replay-res').textContent = '—' })
  }
}

document.querySelectorAll('.ttab[data-ttab]').forEach(el => {
  el.addEventListener('mousedown', () => {
    toolTab = (el as HTMLElement).dataset.ttab!
    document.querySelectorAll('.ttab[data-ttab]').forEach(t => t.classList.toggle('active', t === el))
    renderTool(toolTab)
  })
})

// ── Recon ─────────────────────────────────────────────────────────────────
let currentHost = ''

function hostFrom(u: string): string {
  try { return new URL(u.includes('://') ? u : 'https://' + u).hostname } catch { return '' }
}

function prepRecon() {
  const inp = $('recon-target') as HTMLInputElement
  // Default target to the active tab's hostname if the field is empty
  if (!inp.value.trim()) {
    const host = currentHost || hostFrom(pageUrl)
    if (host) inp.value = host
  }
}

document.querySelectorAll('.ttab[data-rtab]').forEach(el => {
  el.addEventListener('mousedown', () => {
    reconTool = (el as HTMLElement).dataset.rtab!
    document.querySelectorAll('.ttab[data-rtab]').forEach(t => t.classList.toggle('active', t === el))
    const runBtn = $('recon-run') as HTMLButtonElement
    if (reconTool === 'power') {
      runBtn.style.display = 'none'
      renderPowerTools()
    } else {
      runBtn.style.display = ''
      $('recon-output').textContent = `Ready — ${reconTool.toUpperCase()}. Enter a target and hit Run.`
    }
  })
})

// ── Power tools (external pentest binaries) ────────────────────────────────
let activeRunId: string | null = null

async function renderPowerTools() {
  const out = $('recon-output')
  out.innerHTML = `<div class="recon-dim">Detecting installed tools…</div>`
  const tools = await panel.reconDetectTools()
  const cards = tools.map((t: any) => `
    <div class="pt-card${t.available ? '' : ' off'}">
      <div class="pt-info">
        <div class="pt-name">${escHtml(t.label)} <span class="recon-dim" style="font-weight:400">${escHtml(t.kind)}</span></div>
        <div class="pt-desc">${escHtml(t.desc)}</div>
      </div>
      ${t.available
        ? `<span class="pt-badge on">INSTALLED</span><button class="tool-btn primary pt-run" data-tool="${escHtml(t.key)}">Run</button>`
        : `<span class="pt-badge no">brew/go install ${escHtml(t.bin)}</span>`}
    </div>`).join('')
  const anyAvailable = tools.some((t: any) => t.available)
  out.innerHTML =
    `<div class="recon-head">External Tools — target: <span class="recon-v">set above</span></div>` +
    cards +
    (anyAvailable ? '' : `<div class="recon-dim" style="margin-top:8px">No tools found in PATH. Install any of the above (e.g. <span class="recon-v">brew install nmap</span>, <span class="recon-v">go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest</span>) and reopen this tab.</div>`) +
    `<div id="pt-console-wrap"></div>`

  out.querySelectorAll('.pt-run').forEach(btn => {
    btn.addEventListener('click', () => runPowerTool((btn as HTMLElement).dataset.tool!))
  })
}

async function runPowerTool(key: string) {
  const inp = $('recon-target') as HTMLInputElement
  const target = inp.value.trim()
  const wrap = $('pt-console-wrap')
  if (!target) { wrap.innerHTML = `<div class="recon-red" style="margin-top:8px">Enter a target above first.</div>`; return }
  if (activeRunId) { await panel.reconCancelTool(activeRunId); activeRunId = null }

  wrap.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
      <div class="recon-head" style="margin:0">${escHtml(key)} → ${escHtml(target)}</div>
      <button class="tool-btn pt-stop" id="pt-stop">Stop</button>
    </div>
    <div class="pt-console" id="pt-console"></div>`
  $('pt-stop').addEventListener('click', async () => {
    if (activeRunId) { await panel.reconCancelTool(activeRunId); activeRunId = null }
  })

  const res = await panel.reconRunTool(key, target)
  if (!res.ok) {
    $('pt-console').innerHTML = `<span class="err">${escHtml(res.error || 'Failed to start')}</span>`
    return
  }
  activeRunId = res.runId
}

panel.on('recon:tool-out', (raw: unknown) => {
  const d = raw as { runId: string; line: string; stream: string }
  if (d.runId !== activeRunId) return
  const con = document.getElementById('pt-console')
  if (!con) return
  const cls = d.stream === 'cmd' ? 'cmd' : d.stream === 'stderr' ? 'err' : ''
  const span = document.createElement('span')
  if (cls) span.className = cls
  span.textContent = d.line
  con.appendChild(span)
  con.scrollTop = con.scrollHeight
})

panel.on('recon:tool-done', (raw: unknown) => {
  const d = raw as { runId: string; code: number; error?: string }
  if (d.runId !== activeRunId) return
  const con = document.getElementById('pt-console')
  if (con) {
    const span = document.createElement('span')
    span.className = d.code === 0 ? 'done' : 'err'
    span.textContent = `\n── finished (exit ${d.code})${d.error ? ' — ' + d.error : ''} ──\n`
    con.appendChild(span)
    con.scrollTop = con.scrollHeight
  }
  const stop = document.getElementById('pt-stop')
  if (stop) (stop as HTMLButtonElement).textContent = 'Done'
  activeRunId = null
})

function reconKV(k: string, v: string, cls = ''): string {
  return `<div class="recon-kv"><span class="recon-k">${escHtml(k)}</span><span class="recon-v ${cls}">${escHtml(v)}</span></div>`
}

async function runRecon() {
  const inp = $('recon-target') as HTMLInputElement
  const target = inp.value.trim()
  const out = $('recon-output')
  if (!target) { out.textContent = 'Enter a target first.'; return }
  out.textContent = `Running ${reconTool.toUpperCase()} on ${target}…`
  try {
    if (reconTool === 'dns') {
      const r = await panel.reconDns(target)
      let html = ''
      const section = (label: string, lines: string[]) => {
        html += `<div class="recon-head">${escHtml(label)}</div>`
        html += lines.length ? lines.map(l => `<div class="recon-v">${escHtml(l)}</div>`).join('') : `<div class="recon-dim">— none —</div>`
      }
      section('A', r.A)
      section('AAAA', r.AAAA)
      section('MX', (r.MX || []).map((m: any) => `${m.priority}  ${m.exchange}`))
      section('TXT', (r.TXT || []).map((t: string[]) => t.join('')))
      section('NS', r.NS)
      section('CNAME', r.CNAME)
      section('SOA', r.SOA ? [`${r.SOA.nsname} ${r.SOA.hostmaster} serial=${r.SOA.serial}`] : [])
      section('CAA', (r.CAA || []).map((c: any) => JSON.stringify(c)))
      out.innerHTML = html

    } else if (reconTool === 'ports') {
      const r = await panel.reconPortscan(target)
      const open = r.ports.filter((p: any) => p.open)
      const closed = r.ports.length - open.length
      let html = reconKV('Resolved IP', r.ip)
      html += `<div class="recon-head">Open Ports (${open.length})</div>`
      html += open.length
        ? open.map((p: any) => `<div class="recon-open">${p.port}/tcp  ${escHtml(p.service)}  OPEN</div>`).join('')
        : `<div class="recon-dim">No open ports found among the ${r.ports.length} scanned</div>`
      html += `<div class="recon-head recon-dim">${closed} closed / filtered</div>`
      out.innerHTML = html

    } else if (reconTool === 'tls') {
      const r = await panel.reconTls(target)
      if (!r.ok) { out.innerHTML = `<span class="recon-red">${escHtml(r.error || 'TLS handshake failed')}</span>`; return }
      const cn = (o: any) => o?.CN || o?.O || JSON.stringify(o)
      let html = ''
      html += reconKV('Subject', cn(r.subject))
      html += reconKV('Issuer', cn(r.issuer))
      html += reconKV('Valid From', r.valid_from)
      html += reconKV('Valid To', r.valid_to)
      html += reconKV('Days to Expiry', String(r.daysToExpiry), r.daysToExpiry < 30 ? 'recon-red' : '')
      html += reconKV('Currently Valid', r.valid ? 'YES' : 'NO', r.valid ? 'recon-open' : 'recon-red')
      html += reconKV('Serial', r.serialNumber || '')
      html += reconKV('Protocol', r.protocol || '')
      html += reconKV('Cipher', `${r.cipherName || ''} ${r.cipherVersion || ''}`.trim())
      html += reconKV('Fingerprint256', r.fingerprint256 || '')
      html += `<div class="recon-head">Subject Alt Names</div>`
      html += `<div class="recon-v">${escHtml((r.subjectAltNames || '').replace(/,\s*/g, '\n'))}</div>`
      html += `<div class="recon-head">Chain</div>`
      html += (r.chain || []).map((c: string, i: number) => `<div class="recon-v">${' '.repeat(i * 2)}${escHtml(c)}</div>`).join('')
      out.innerHTML = html

    } else if (reconTool === 'whois') {
      const r = await panel.reconWhois(target)
      if (!r.ok) { out.innerHTML = `<span class="recon-red">${escHtml(r.error || 'WHOIS failed')}</span>`; return }
      out.innerHTML = `<div class="recon-head">${escHtml('via ' + r.server)}${r.note ? ' — ' + escHtml(r.note) : ''}</div><pre>${escHtml(r.text)}</pre>`

    } else if (reconTool === 'http') {
      const r = await panel.reconHttp(target)
      if (!r.ok) { out.innerHTML = `<span class="recon-red">${escHtml(r.error || 'HTTP recon failed')}</span>`; return }
      let html = reconKV('Origin', r.origin)
      html += r.results.map((p: any) => {
        const cls = p.found ? 'recon-open' : 'recon-dim'
        const snippet = p.snippet ? `<div class="recon-v recon-dim">${escHtml(p.snippet.slice(0, 300))}${p.snippet.length > 300 ? '…' : ''}</div>` : ''
        return `<div class="recon-head" style="margin-bottom:2px"><span class="${cls}">${p.status || 'ERR'}</span>  ${escHtml(p.path)}</div>${p.found ? snippet : ''}`
      }).join('')
      out.innerHTML = html

    } else if (reconTool === 'subdomains') {
      const r = await panel.reconSubdomains(target)
      if (!r.ok) { out.innerHTML = `<span class="recon-red">${escHtml(r.error || 'Subdomain scan failed')}</span>`; return }
      let html = `<div class="recon-head">Found ${r.found.length} subdomain(s) for ${escHtml(r.domain)}</div>`
      html += r.found.length
        ? r.found.map((s: any) => `<div class="recon-open">${escHtml(s.subdomain)}</div><div class="recon-v recon-dim">  ${escHtml(s.ips.join(', '))}</div>`).join('')
        : `<div class="recon-dim">No subdomains resolved from the wordlist</div>`
      out.innerHTML = html
    }
  } catch (e: any) {
    out.innerHTML = `<span class="recon-red">${escHtml('Error: ' + (e?.message || String(e)))}</span>`
  }
}

$('recon-run').addEventListener('click', runRecon)
;($('recon-target') as HTMLInputElement).addEventListener('keydown', e => {
  if ((e as KeyboardEvent).key === 'Enter') runRecon()
})

// ── Net events ────────────────────────────────────────────────────────────
panel.on('net:req-headers', (raw: unknown) => {
  const d = raw as { tabId: number; id: string; reqHeaders: Record<string, string> }
  const entry = netById.get(d.tabId)?.get(d.id)
  if (entry) entry.reqHeaders = d.reqHeaders
})

panel.on('net:req', (raw: unknown) => {
  const d = raw as { tabId: number; id: string; method: string; url: string; type: string; startTime: number; reqHeaders?: Record<string,string>; reqBody?: string | null; initiator?: string }
  const { log, idx } = getOrCreate(d.tabId)
  const entry: NetEntry = {
    id: d.id, method: d.method, url: d.url, type: d.type, startTime: d.startTime,
    reqHeaders: d.reqHeaders, reqBody: d.reqBody, initiator: d.initiator, warns: [],
  }
  if (log.length > 500) idx.delete(log.shift()!.id)
  log.push(entry); idx.set(d.id, entry)
  if (d.tabId === active && panelTab === 'network') scheduleNetRender()
})

panel.on('net:res', (raw: unknown) => {
  const d = raw as { tabId: number; id: string; status: number; statusText?: string; mimeType: string; resHeaders?: Record<string,string>; remoteIP?: string; protocol?: string; securityState?: string }
  const entry = netById.get(d.tabId)?.get(d.id)
  if (!entry) return
  entry.status = d.status; entry.statusText = d.statusText
  entry.mimeType = d.mimeType; entry.resHeaders = d.resHeaders
  entry.remoteIP = d.remoteIP; entry.protocol = d.protocol; entry.securityState = d.securityState
  entry.warns = analyseWarns(entry)

  // Track page-level headers for security tab
  if (d.tabId === active && (entry.type === 'Document' || entry.type === 'document')) {
    pageHeaders = d.resHeaders ?? null
    pageUrl = entry.url
    currentHost = hostFrom(entry.url)
    if (panelTab === 'security') renderSecurity()
  }

  if (d.tabId === active && panelTab === 'network') scheduleNetRender()
  if (selectedReq?.id === d.id) renderDetail()
})

panel.on('net:done', (raw: unknown) => {
  const d = raw as { tabId: number; id: string; endTime: number; size: number }
  const entry = netById.get(d.tabId)?.get(d.id)
  if (!entry) return
  entry.endTime = d.endTime; entry.size = d.size
  if (d.tabId === active && panelTab === 'network') scheduleNetRender()
})

panel.on('net:fail', (raw: unknown) => {
  const d = raw as { tabId: number; id: string; cancelled?: boolean }
  const entry = netById.get(d.tabId)?.get(d.id)
  if (!entry) return
  entry.failed = true; entry.cancelled = d.cancelled
  if (d.tabId === active && panelTab === 'network') scheduleNetRender()
})

panel.on('net:clear', (raw: unknown) => {
  const { tabId } = raw as { tabId: number }
  if (preserveLog) return
  netLog.set(tabId, []); netById.set(tabId, new Map())
  if (tabId === active) { pageHeaders = null; pageUrl = '' }
  if (tabId === active) { renderNet(); if (panelTab === 'security') renderSecurity() }
})

panel.on('activated', (id: unknown) => {
  active = id as number
  renderNet()
  if (panelTab === 'security') renderSecurity()
})

panel.on('init', (id: unknown) => {
  active = id as number
})

// ── UI events ─────────────────────────────────────────────────────────────
$('btn-net-clear').addEventListener('click', () => {
  if (active !== null) {
    netLog.set(active, []); netById.set(active, new Map())
    pageHeaders = null; pageUrl = ''
    renderNet()
    if (panelTab === 'security') renderSecurity()
  }
})
$('btn-preserve').addEventListener('click', () => {
  preserveLog = !preserveLog
  $('btn-preserve').classList.toggle('active', preserveLog)
})
filterIn.addEventListener('input', () => { netFilter = filterIn.value.toLowerCase(); renderNet() })

// Initial render
renderNet()
