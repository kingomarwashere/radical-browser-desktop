#!/usr/bin/env node
// Generates assets/icon.png — no external deps, pure Node.js + zlib
import { deflateSync } from 'zlib'
import { writeFileSync, mkdirSync } from 'fs'

const W = 1024, H = 1024
const rgba = new Uint8Array(W * H * 4)

function px(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= W || y < 0 || y >= H) return
  const i = (y * W + x) * 4
  rgba[i] = r; rgba[i+1] = g; rgba[i+2] = b; rgba[i+3] = a
}

function fillRect(x0, y0, x1, y1, r, g, b, a = 255) {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      px(x, y, r, g, b, a)
}

// smooth circle with anti-aliasing
function fillCircle(cx, cy, radius, r, g, b) {
  const r2 = radius * radius
  for (let y = cy - radius - 1; y <= cy + radius + 1; y++) {
    for (let x = cx - radius - 1; x <= cx + radius + 1; x++) {
      const dx = x - cx, dy = y - cy
      const d2 = dx*dx + dy*dy
      if (d2 < r2) {
        const edge = Math.sqrt(d2)
        const alpha = Math.min(255, Math.max(0, (radius - edge + 0.5) * 255)) | 0
        if (alpha === 255) { px(x, y, r, g, b) }
        else {
          const i = (y * W + x) * 4
          if (x >= 0 && x < W && y >= 0 && y < H) {
            rgba[i] = r; rgba[i+1] = g; rgba[i+2] = b; rgba[i+3] = alpha
          }
        }
      }
    }
  }
}

// thick line segment
function thickLine(x0, y0, x1, y1, thickness, r, g, b) {
  const dx = x1 - x0, dy = y1 - y0
  const len = Math.sqrt(dx*dx + dy*dy)
  const nx = -dy/len, ny = dx/len
  const t = thickness / 2
  const steps = Math.ceil(len * 2)
  for (let s = 0; s <= steps; s++) {
    const t_ = s / steps
    const cx = x0 + dx * t_
    const cy = y0 + dy * t_
    for (let w = -t; w <= t; w++) {
      const wx = Math.round(cx + nx * w)
      const wy = Math.round(cy + ny * w)
      // simple AA at edge
      const edge = Math.abs(w) - t + 0.5
      const alpha = edge < 0 ? 255 : Math.max(0, (0.5 - edge) * 255) | 0
      if (wx >= 0 && wx < W && wy >= 0 && wy < H) {
        const i = (wy * W + wx) * 4
        if (alpha === 255 || rgba[i+3] === 0) {
          rgba[i] = r; rgba[i+1] = g; rgba[i+2] = b; rgba[i+3] = alpha
        }
      }
    }
  }
}

// ── Draw icon ──────────────────────────────────────────────────────────────

// Background — dark
fillRect(0, 0, W, H, 10, 10, 12)

// Rounded square — slightly lighter bg
const PAD = 60, CORNER = 180
for (let y = PAD; y < H - PAD; y++) {
  for (let x = PAD; x < W - PAD; x++) {
    const dx = Math.max(0, Math.max(PAD + CORNER - x, x - (W - PAD - CORNER)))
    const dy = Math.max(0, Math.max(PAD + CORNER - y, y - (H - PAD - CORNER)))
    if (dx*dx + dy*dy < CORNER*CORNER) px(x, y, 18, 18, 22)
  }
}

// Blue glow circle behind "R"
fillCircle(512, 512, 280, 30, 60, 130)

// Draw "R" letterform using thick lines + filled shapes
// Vertical stem
fillRect(300, 260, 380, 760, 240, 248, 255)

// Top bowl — horizontal top
fillRect(300, 260, 660, 340, 240, 248, 255)
// Inner bowl — horizontal middle
fillRect(300, 490, 620, 570, 240, 248, 255)
// Right side of bowl — vertical
fillRect(580, 340, 660, 570, 240, 248, 255)

// Leg — diagonal kick from bottom-right of bowl
thickLine(580, 560, 710, 760, 78, 240, 248, 255)

// Round off the bowl corners with circles
fillCircle(620, 340, 40, 240, 248, 255)
fillCircle(620, 570, 40, 240, 248, 255)

// Accent dot — bottom right
fillCircle(700, 720, 30, 79, 142, 247)

// ── Encode PNG ────────────────────────────────────────────────────────────

function u32be(n) {
  const b = Buffer.alloc(4); b.writeUInt32BE(n); return b
}

const crcTable = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let v = i
  for (let k = 0; k < 8; k++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1)
  crcTable[i] = v
}
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function chunk(type, data) {
  const tb = Buffer.from(type, 'ascii')
  const body = Buffer.concat([tb, data])
  return Buffer.concat([u32be(data.length), body, u32be(crc32(body))])
}

// RGBA scanlines with filter byte
const raw = Buffer.alloc(H * (1 + W * 4))
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0
  for (let x = 0; x < W; x++) {
    const src = (y * W + x) * 4
    const dst = y * (1 + W * 4) + 1 + x * 4
    raw[dst]   = rgba[src]
    raw[dst+1] = rgba[src+1]
    raw[dst+2] = rgba[src+2]
    raw[dst+3] = rgba[src+3]
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8; ihdr[9] = 6  // 8-bit RGBA

const png = Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 6 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync('assets', { recursive: true })
writeFileSync('assets/icon.png', png)
console.log('assets/icon.png created (' + Math.round(png.length / 1024) + 'KB)')
