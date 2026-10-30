/** Builds the merchant analytics web SDK for the script tag: dist/sdk/kma.js and,
 * loaded only when session replay starts, dist/sdk/kma-replay.js. */
import { build } from 'vite'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const bundles = [
  ['integrations/analytics-web/src/global.ts', 'kma.js', 'kmaSdk'],
  ['integrations/analytics-web/src/replay-global.ts', 'kma-replay.js', 'kmaReplay'],
]

for (const [entry, fileName, name] of bundles) {
  await build({
    configFile: false,
    publicDir: false,
    root,
    logLevel: 'warn',
    build: {
      outDir: resolve(root, process.env.SDK_OUT_DIR ?? 'dist/sdk'),
      emptyOutDir: false,
      target: 'es2019',
      minify: true,
      sourcemap: true,
      lib: { entry: resolve(root, entry), name, formats: ['iife'], fileName: () => fileName },
    },
  })
}
