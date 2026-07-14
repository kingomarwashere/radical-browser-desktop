import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'

const base = { bundle: true, sourcemap: false, minify: false }

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
    entryPoints: ['src/renderer/app.ts'],
    outdir: 'build/renderer',
    platform: 'browser',
    target: 'chrome124',
    format: 'iife',
  }),
])

mkdirSync('build/renderer', { recursive: true })
copyFileSync('src/renderer/index.html', 'build/renderer/index.html')

console.log('build done')
