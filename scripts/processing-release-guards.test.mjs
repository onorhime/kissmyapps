import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { priorFunctionBundlesUnchanged, sameFunctionBundle } from './processing-release-guards.mjs'
const prior = { slug: 'stripe-worker', ezbr_sha256: 'a'.repeat(64) }
test('adding a new function preserves all prior pinned bundles', () => {
  assert.equal(
    priorFunctionBundlesUnchanged(
      [prior],
      [prior, { slug: 'processing-dispatch', ezbr_sha256: 'b'.repeat(64) }],
    ),
    true,
  )
})
test('missing or incorrect API digest fields do not prove preservation', () => {
  assert.equal(sameFunctionBundle({ slug: 'x' }, { slug: 'x' }), false)
  assert.equal(
    sameFunctionBundle(
      { slug: 'x', sha256: 'a'.repeat(64) },
      { slug: 'x', sha256: 'a'.repeat(64) },
    ),
    false,
  )
  assert.equal(
    sameFunctionBundle({ ...prior, ezbr_sha256: 'short' }, { ...prior, ezbr_sha256: 'short' }),
    false,
  )
})
test('removed, modified and ambiguous prior functions fail closed', () => {
  assert.equal(priorFunctionBundlesUnchanged([prior], []), false)
  assert.equal(
    priorFunctionBundlesUnchanged([prior], [{ ...prior, ezbr_sha256: 'b'.repeat(64) }]),
    false,
  )
  assert.equal(priorFunctionBundlesUnchanged([prior], [prior, prior]), false)
  assert.equal(priorFunctionBundlesUnchanged([], []), false)
})
