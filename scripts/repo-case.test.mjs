// macOS and Windows file systems ignore letter case, so two modules whose import paths differ
// only in case (promoCode.ts and PromoCode.tsx) build on Linux but break `tsc -b` on the
// owner's Mac, where releases are built. Keep every import path unique without case.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'

const repo = resolve(import.meta.dirname, '..')

test('no two files or modules differ only in letter case', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  const seen = new Map()
  const clashes = []
  for (const file of files) {
    for (const key of new Set([file, file.replace(/\.(d\.ts|tsx|ts|jsx|js|mjs|cjs)$/, '')])) {
      const folded = key.toLowerCase()
      const other = seen.get(folded)
      if (other && other.key !== key) clashes.push(`${other.file} and ${file}`)
      else if (!other) seen.set(folded, { key, file })
    }
  }
  assert.deepEqual(clashes, [])
})
