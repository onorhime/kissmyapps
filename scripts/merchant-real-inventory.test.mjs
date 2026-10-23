import { test } from 'node:test'
import assert from 'node:assert/strict'
import { manualMerchantInventory } from './merchant-real-inventory.mjs'

const now = Date.parse('2026-10-17T16:00:00Z')
const evidence = {
  accountId: 'acct_correct',
  livemode: false,
  method: 'stripe-dashboard-manual',
  observedAt: new Date(now - 60000).toISOString(),
  expiresAt: new Date(now + 20 * 60000).toISOString(),
  totalDestinations: 0,
  enabledDestinations: 0,
  screenshotPath: '/tmp/exact-sandbox-inventory.jpg',
  screenshotSha256: 'a'.repeat(64),
  observation:
    'Exact SpeakSix sandbox account and sandbox banner verified; Event destinations table has no rows.',
}
test('manual merchant inventory is narrowly bound to actual OAuth inventory restriction', () => {
  const checked = manualMerchantInventory(evidence, 'acct_correct', 403, 'oauth_not_supported', now)
  assert.equal(checked.method, 'stripe-dashboard-manual')
  assert.match(checked.limitation, /not verified through the API/)
  for (const [account, status, code] of [
    [undefined, 403, 'oauth_not_supported'],
    ['acct_other', 403, 'oauth_not_supported'],
    ['acct_correct', 401, 'oauth_not_supported'],
    ['acct_correct', 403, 'permission_denied'],
    ['acct_correct', 500, 'api_error'],
    ['acct_correct', 200, undefined],
  ])
    assert.throws(() => manualMerchantInventory(evidence, account, status, code, now))
})
test('manual inventory rejects live, nonempty, stale, missing or unsupported evidence', () => {
  for (const patch of [
    { livemode: true },
    { totalDestinations: 1 },
    { enabledDestinations: 1 },
    { observedAt: new Date(now + 60000).toISOString() },
    { expiresAt: new Date(now).toISOString() },
    { expiresAt: new Date(now + 31 * 60000).toISOString() },
    { screenshotPath: 'relative.jpg' },
    { screenshotSha256: '' },
    { observation: '' },
  ])
    assert.throws(() =>
      manualMerchantInventory(
        { ...evidence, ...patch },
        'acct_correct',
        403,
        'oauth_not_supported',
        now,
      ),
    )
  assert.throws(() =>
    manualMerchantInventory(undefined, 'acct_correct', 403, 'oauth_not_supported', now),
  )
})
