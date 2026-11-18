// ── Casting: fling a media URL to Chromecast / AirPlay receivers ──────────────
// Electron ships Chromium WITHOUT the Google Cast media-router component, so the
// Presentation/Remote-Playback APIs find no devices. Rather than bundle that
// component we speak the two open receiver protocols directly, matching the
// house style of the recon section (raw net/tls/dns built from Node primitives):
//   • Chromecast  — the CASTV2 protocol over TLS:8009 (length-prefixed protobuf
//                   envelopes carrying JSON payloads). We LAUNCH the Default
//                   Media Receiver and LOAD a media URL.
//   • AirPlay     — the AirPlay "video" HTTP API: POST /play with a
//                   Content-Location. The Apple TV fetches + plays the URL.
// Both are "fling" (the receiver streams the URL itself), not tab mirroring —
// that would need native code. Works for direct media URLs (mp4/webm/m3u8/mp3…).

import * as tls from 'node:tls'
import * as http from 'node:http'
// multicast-dns is pure-JS (dns-packet + dgram); bundles cleanly under esbuild.
// No bundled @types, but build.mjs uses esbuild (no typecheck) so this is fine.
// @ts-ignore
import makeMdns from 'multicast-dns'

export interface CastDevice {
  id: string            // stable key: `${kind}:${host}:${port}`
  name: string
  host: string
  port: number
  kind: 'chromecast' | 'airplay'
}
export interface CastState {
  casting: boolean
  device?: string
  kind?: 'chromecast' | 'airplay'
  media?: string
  error?: string
}

// ── mDNS discovery ────────────────────────────────────────────────────────────
const CAST_SVC = '_googlecast._tcp.local'
const AIRPLAY_SVC = '_airplay._tcp.local'
const STALE_MS = 60_000

// Accumulators keyed by mDNS record name — merged across packets since a single
// response often carries only part of the SRV/A/TXT set for a device.
const srv = new Map<string, { target: string; port: number; ts: number }>()   // instance → SRV
const addr = new Map<string, { ip: string; ts: number }>()                     // host → A
const txt = new Map<string, { data: Record<string, string>; ts: number }>()    // instance → TXT
const ptr = new Map<string, { kind: CastDevice['kind']; ts: number }>()        // instance → service kind

let mdns: any = null
let queryTimer: ReturnType<typeof setInterval> | null = null

function unescapeName(n: string): string {
  return n.replace(/\\(\d{3})/g, (_, d) => String.fromCharCode(parseInt(d, 10))).replace(/\\(.)/g, '$1')
}
function instanceLabel(instance: string, svc: string): string {
  const suffix = '.' + svc
  const label = instance.toLowerCase().endsWith(suffix.toLowerCase())
    ? instance.slice(0, instance.length - suffix.length)
    : instance
  return unescapeName(label)
}
function parseTxt(raw: unknown[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of raw || []) {
    const s = Buffer.isBuffer(item) ? item.toString('utf8') : String(item)
    const eq = s.indexOf('=')
    if (eq > 0) out[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1)
  }
  return out
}

export function startDiscovery(): void {
  if (mdns) return
  try { mdns = makeMdns() } catch { mdns = null; return }
  mdns.on('warning', () => {})
  mdns.on('error', () => {})
  mdns.on('response', (packet: any) => {
    const now = Date.now()
    const records = [...(packet.answers || []), ...(packet.additionals || [])]
    for (const r of records) {
      if (r.type === 'PTR' && (r.name === CAST_SVC || r.name === AIRPLAY_SVC)) {
        ptr.set(r.data, { kind: r.name === CAST_SVC ? 'chromecast' : 'airplay', ts: now })
      } else if (r.type === 'SRV') {
        srv.set(r.name, { target: r.data.target, port: r.data.port, ts: now })
      } else if (r.type === 'A') {
        addr.set(r.name, { ip: r.data, ts: now })
      } else if (r.type === 'TXT') {
        txt.set(r.name, { data: parseTxt(Array.isArray(r.data) ? r.data : [r.data]), ts: now })
      }
    }
  })
  const query = () => {
    try {
      mdns.query([
        { name: CAST_SVC, type: 'PTR' },
        { name: AIRPLAY_SVC, type: 'PTR' },
      ])
    } catch {}
  }
  query()
  queryTimer = setInterval(query, 5_000)
  queryTimer.unref?.()
}

export function stopDiscovery(): void {
  if (queryTimer) { clearInterval(queryTimer); queryTimer = null }
  if (mdns) { try { mdns.destroy() } catch {} mdns = null }
}

function prune(map: Map<string, { ts: number }>, now: number) {
  for (const [k, v] of map) if (now - v.ts > STALE_MS) map.delete(k)
}

export function listDevices(): CastDevice[] {
  const now = Date.now()
  prune(ptr, now); prune(srv, now); prune(addr, now); prune(txt, now)
  const out: CastDevice[] = []
  const seen = new Set<string>()
  for (const [instance, { kind }] of ptr) {
    const s = srv.get(instance)
    if (!s) continue
    const a = addr.get(s.target)
    if (!a) continue
    const t = txt.get(instance)?.data || {}
    const svc = kind === 'chromecast' ? CAST_SVC : AIRPLAY_SVC
    const name = (kind === 'chromecast' ? t.fn : (t.name || instanceLabel(instance, svc)))
      || instanceLabel(instance, svc) || a.ip
    const id = `${kind}:${a.ip}:${s.port}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, name, host: a.ip, port: s.port, kind })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ── Content-type guess from URL extension ─────────────────────────────────────
function guessContentType(url: string): string {
  const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
  const map: Record<string, string> = {
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mkv: 'video/x-matroska', ogv: 'video/ogg', m3u8: 'application/x-mpegURL',
    mpd: 'application/dash+xml', mp3: 'audio/mpeg', m4a: 'audio/mp4',
    aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  }
  return map[ext] || 'video/mp4'
}

// ── Chromecast (CASTV2) — minimal hand-rolled protobuf envelope ───────────────
// CastMessage { 1:protocol_version(varint) 2:source_id 3:destination_id
//               4:namespace 5:payload_type(varint) 6:payload_utf8 }
// All payloads we send/receive are JSON strings (payload_type = STRING = 0).
const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection'
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat'
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver'
const NS_MEDIA = 'urn:x-cast:com.google.cast.media'
const DEFAULT_MEDIA_RECEIVER = 'CC1AD845'

function encodeVarint(n: number): Buffer {
  const bytes: number[] = []
  while (n > 0x7f) { bytes.push((n & 0x7f) | 0x80); n >>>= 7 }
  bytes.push(n)
  return Buffer.from(bytes)
}
function encodeStringField(field: number, s: string): Buffer {
  const body = Buffer.from(s, 'utf8')
  return Buffer.concat([Buffer.from([(field << 3) | 2]), encodeVarint(body.length), body])
}
function encodeVarintField(field: number, n: number): Buffer {
  return Buffer.concat([Buffer.from([(field << 3) | 0]), encodeVarint(n)])
}
function encodeCastMessage(source: string, dest: string, namespace: string, payload: string): Buffer {
  const msg = Buffer.concat([
    encodeVarintField(1, 0),               // protocol_version = CASTV2_1_0
    encodeStringField(2, source),
    encodeStringField(3, dest),
    encodeStringField(4, namespace),
    encodeVarintField(5, 0),               // payload_type = STRING
    encodeStringField(6, payload),
  ])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(msg.length, 0)
  return Buffer.concat([len, msg])
}
function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0, shift = 0, p = pos
  while (p < buf.length) {
    const b = buf[p++]
    result |= (b & 0x7f) << shift
    if (!(b & 0x80)) break
    shift += 7
  }
  return [result >>> 0, p]
}
function decodeCastMessage(buf: Buffer): { namespace: string; payload: string } {
  let pos = 0, namespace = '', payload = ''
  while (pos < buf.length) {
    const [key, p1] = readVarint(buf, pos); pos = p1
    const field = key >>> 3, wire = key & 7
    if (wire === 0) { const [, p2] = readVarint(buf, pos); pos = p2 }
    else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos); pos = p2
      const slice = buf.slice(pos, pos + len); pos += len
      if (field === 4) namespace = slice.toString('utf8')
      else if (field === 6) payload = slice.toString('utf8')
    } else break
  }
  return { namespace, payload }
}

interface ActiveCast {
  kind: 'chromecast' | 'airplay'
  device: CastDevice
  socket?: tls.TLSSocket
  heartbeat?: ReturnType<typeof setInterval>
  transportId?: string
  sessionId?: string
}
let active: ActiveCast | null = null
let requestId = 1

function castChromecast(device: CastDevice, mediaUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = 'sender-0'
    let settled = false
    let hb: ReturnType<typeof setInterval> | undefined
    const fail = (e: Error) => { if (!settled) { settled = true; reject(e) } }
    const socket = tls.connect({ host: device.host, port: device.port, rejectUnauthorized: false, servername: device.host }, () => {
      const send = (dest: string, ns: string, payload: object) =>
        socket.write(encodeCastMessage(source, dest, ns, JSON.stringify(payload)))

      send('receiver-0', NS_CONNECTION, { type: 'CONNECT' })
      send('receiver-0', NS_HEARTBEAT, { type: 'PING' })
      send('receiver-0', NS_RECEIVER, { type: 'LAUNCH', appId: DEFAULT_MEDIA_RECEIVER, requestId: requestId++ })

      hb = setInterval(() => { try { send('receiver-0', NS_HEARTBEAT, { type: 'PING' }) } catch {} }, 5_000)
      hb.unref?.()
      if (active) active.heartbeat = hb
    })
    if (active) active.socket = socket

    // A disconnect at any point must stop the heartbeat (it was only ever cleared
    // in teardown(), so a drop AFTER a successful cast leaked a timer writing to a
    // dead socket forever). If the drop happens post-success, also reflect that
    // we've stopped casting so the menu/UI update.
    const onDisconnect = (e: Error) => {
      if (hb) { clearInterval(hb); hb = undefined }
      if (!settled) { fail(e); return }
      if (active && active.socket === socket) { active = null; setState({ casting: false }) }
    }

    let buf = Buffer.alloc(0)
    let launched = false
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0)
        if (buf.length < 4 + len) break
        const frame = buf.slice(4, 4 + len)
        buf = buf.slice(4 + len)
        let msg
        try { msg = decodeCastMessage(frame) } catch { continue }
        let data: any
        try { data = JSON.parse(msg.payload) } catch { continue }

        if (msg.namespace === NS_HEARTBEAT && data.type === 'PING') {
          socket.write(encodeCastMessage(source, 'receiver-0', NS_HEARTBEAT, JSON.stringify({ type: 'PONG' })))
        } else if (msg.namespace === NS_RECEIVER && data.type === 'RECEIVER_STATUS') {
          const app = (data.status?.applications || []).find((a: any) => a.appId === DEFAULT_MEDIA_RECEIVER)
          if (app && !launched) {
            launched = true
            const transportId = app.transportId
            const sessionId = app.sessionId
            if (active) { active.transportId = transportId; active.sessionId = sessionId }
            // Connect to the app's transport, then LOAD the media.
            socket.write(encodeCastMessage(source, transportId, NS_CONNECTION, JSON.stringify({ type: 'CONNECT' })))
            socket.write(encodeCastMessage(source, transportId, NS_MEDIA, JSON.stringify({
              type: 'LOAD', requestId: requestId++, sessionId,
              media: { contentId: mediaUrl, streamType: 'BUFFERED', contentType: guessContentType(mediaUrl) },
              autoplay: true, currentTime: 0,
            })))
          }
        } else if (msg.namespace === NS_MEDIA) {
          if (data.type === 'MEDIA_STATUS' && Array.isArray(data.status) && data.status.length) {
            if (!settled) { settled = true; resolve() }
          } else if (data.type === 'LOAD_FAILED' || data.type === 'INVALID_REQUEST') {
            fail(new Error('Receiver rejected the media (unsupported format or URL).'))
          }
        }
      }
    })
    socket.on('error', (e) => onDisconnect(e))
    socket.on('close', () => onDisconnect(new Error('Connection to Chromecast closed.')))
    socket.setTimeout(15_000, () => fail(new Error('Chromecast did not start playback in time.')))
    // Resolve optimistically once LOAD is acknowledged; if nothing within 8s but
    // no error either, treat as success (some receivers delay MEDIA_STATUS).
    setTimeout(() => { if (!settled && launched) { settled = true; resolve() } }, 8_000)
  })
}

// ── AirPlay video fling over HTTP ─────────────────────────────────────────────
function airplayRequest(device: CastDevice, path: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: device.host, port: device.port, path, method: 'POST',
      headers: {
        'Content-Type': 'text/parameters',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'MediaControl/1.0',
      },
    }, (res) => {
      res.resume()
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve()
      else if (res.statusCode === 403 || res.statusCode === 453)
        reject(new Error('This Apple TV requires pairing for casting (AirPlay access is restricted).'))
      else reject(new Error(`AirPlay error (HTTP ${res.statusCode}).`))
    })
    req.on('error', (e) => reject(e))
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('AirPlay device did not respond.')) })
    req.end(body)
  })
}
function castAirplay(device: CastDevice, mediaUrl: string): Promise<void> {
  const body = `Content-Location: ${mediaUrl}\r\nStart-Position: 0\r\n`
  return airplayRequest(device, '/play', body)
}

// ── Public API ────────────────────────────────────────────────────────────────
let state: CastState = { casting: false }
let stateCb: ((s: CastState) => void) | null = null
export function onStateChange(cb: (s: CastState) => void) { stateCb = cb }
function setState(s: CastState) { state = s; stateCb?.(s) }
export function getState(): CastState { return state }

async function teardown() {
  if (!active) return
  const a = active
  active = null
  if (a.heartbeat) clearInterval(a.heartbeat)
  if (a.kind === 'chromecast' && a.socket) {
    try {
      // STOP the receiver app so the TV returns to its home screen.
      a.socket.write(encodeCastMessage('sender-0', 'receiver-0', NS_RECEIVER,
        JSON.stringify({ type: 'STOP', sessionId: a.sessionId, requestId: requestId++ })))
    } catch {}
    try { a.socket.destroy() } catch {}
  } else if (a.kind === 'airplay') {
    try { await airplayRequest(a.device, '/stop', '') } catch {}
  }
}

export async function startCast(deviceId: string, mediaUrl: string): Promise<CastState> {
  const device = listDevices().find(d => d.id === deviceId)
  if (!device) { setState({ casting: false, error: 'Device is no longer available.' }); return state }
  await stopCast()
  active = { kind: device.kind, device }
  try {
    if (device.kind === 'chromecast') await castChromecast(device, mediaUrl)
    else await castAirplay(device, mediaUrl)
    setState({ casting: true, device: device.name, kind: device.kind, media: mediaUrl })
  } catch (e: any) {
    await teardown()
    setState({ casting: false, error: e?.message || 'Casting failed.' })
  }
  return state
}

export async function stopCast(): Promise<CastState> {
  await teardown()
  setState({ casting: false })
  return state
}
