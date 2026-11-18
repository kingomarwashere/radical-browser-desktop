import { build } from 'esbuild'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'

// Production builds minify (smaller bundles = faster V8 parse on the cold-start
// path, where the main + preload scripts run before anything paints). Set
// NODE_ENV=development for readable output + inline sourcemaps while debugging.
const prod = process.env.NODE_ENV !== 'development'
const base = {
  bundle: true,
  minify: prod,
  sourcemap: prod ? false : 'inline',
  legalComments: 'none',
  drop: prod ? ['debugger'] : [],
}

// Wipe stale compiled output so a renamed/removed entry point can't linger in
// build/ and get packaged.
rmSync('build', { recursive: true, force: true })

try {
await Promise.all([
  build({
    ...base,
    entryPoints: ['src/main/index.ts'],
    outdir: 'build/main',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...base,
    entryPoints: ['src/preload/index.ts'],
    outdir: 'build/preload',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...base,
    entryPoints: ['src/preload/palette.ts'],
    outdir: 'build/preload',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...base,
    entryPoints: ['src/renderer/app.ts'],
    outdir: 'build/renderer',
    platform: 'browser',
    target: 'chrome124',
    format: 'iife',
  }),
  build({
    ...base,
    entryPoints: ['src/renderer/palette.ts'],
    outdir: 'build/renderer',
    platform: 'browser',
    target: 'chrome124',
    format: 'iife',
  }),
  build({
    ...base,
    entryPoints: ['src/preload/panel.ts'],
    outdir: 'build/preload',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...base,
    entryPoints: ['src/renderer/panel.ts'],
    outdir: 'build/renderer',
    platform: 'browser',
    target: 'chrome124',
    format: 'iife',
  }),
  build({
    ...base,
    entryPoints: ['src/preload/omnibox.ts'],
    outdir: 'build/preload',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...base,
    entryPoints: ['src/renderer/omnibox.ts'],
    outdir: 'build/renderer',
    platform: 'browser',
    target: 'chrome124',
    format: 'iife',
  }),
  build({
    ...base,
    entryPoints: ['src/preload/auth.ts'],
    outdir: 'build/preload',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...base,
    entryPoints: ['src/preload/tab.ts'],
    outdir: 'build/preload',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...base,
    entryPoints: ['src/renderer/auth.ts'],
    outdir: 'build/renderer',
    platform: 'browser',
    target: 'chrome124',
    format: 'iife',
  }),
])

mkdirSync('build/renderer', { recursive: true })
copyFileSync('src/renderer/index.html', 'build/renderer/index.html')
copyFileSync('src/renderer/palette.html', 'build/renderer/palette.html')
copyFileSync('src/renderer/panel.html', 'build/renderer/panel.html')
copyFileSync('src/renderer/omnibox.html', 'build/renderer/omnibox.html')
copyFileSync('src/renderer/auth.html', 'build/renderer/auth.html')

console.log(`build done${prod ? ' (minified)' : ' (dev)'}`)
} catch (err) {
  console.error('build FAILED:', err)
  process.exit(1)
}
