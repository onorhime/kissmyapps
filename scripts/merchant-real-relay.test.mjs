import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { relayStripeCli } from './merchant-real-relay.mjs'
const now = 1792240000000,
  cli = 'whsec_sharedFixtureOnly',
  local = { platform: 'whsec_platformLocal', connected: 'whsec_connectedLocal' }
const signed = (raw, secret = cli) =>
  `t=${now / 1000},v1=${createHmac('sha256', secret)
    .update(now / 1000 + '.')
    .update(raw)
    .digest('hex')}`
test('relay rejects unauthenticated, stale, changed and wrong-scope events before forwarding', async () => {
  let calls = 0
  const options = {
    cliSecrets: { platform: cli, connected: cli },
    localSecrets: local,
    now: () => now,
    forward: async () => {
      calls++
      return Response.json({})
    },
  }
  const raw = JSON.stringify({
    id: 'evt_fixture',
    type: 'application_fee.created',
    livemode: false,
  })
  for (const [body, signature, scope] of [
    [raw, '', 'platform'],
    [raw, signed(raw, 'whsec_wrong'), 'platform'],
    [raw + ' ', signed(raw), 'platform'],
    [raw, signed(raw).replace(String(now / 1000), String(now / 1000 - 400)), 'platform'],
    [raw, signed(raw), 'connected'],
  ]) {
    const r = await relayStripeCli(
      new Request('http://127.0.0.1/' + scope, {
        method: 'POST',
        headers: { 'stripe-signature': signature },
        body,
      }),
      options,
    )
    assert(!r.ok)
  }
  assert.equal(calls, 0)
})
test('relay keeps authenticated raw payload unchanged and uses separate local scope secrets', async () => {
  const receipts = [],
    forwards = []
  const options = {
    cliSecrets: { platform: cli, connected: cli },
    localSecrets: local,
    now: () => now,
    record: (r) => receipts.push(r),
    forward: async (raw, headers) => {
      forwards.push({ raw: new TextDecoder().decode(raw), headers })
      return Response.json({ received: true })
    },
  }
  for (const scope of ['platform', 'connected']) {
    const raw = JSON.stringify({
      id: 'evt_' + scope,
      type: scope === 'platform' ? 'application_fee.created' : 'checkout.session.completed',
      livemode: false,
      ...(scope === 'connected' ? { account: 'acct_merchant' } : {}),
    })
    const response = await relayStripeCli(
      new Request('http://127.0.0.1/' + scope, {
        method: 'POST',
        headers: { 'stripe-signature': signed(raw) },
        body: raw,
      }),
      options,
    )
    assert.equal(response.status, 200)
    assert.equal(forwards.at(-1).raw, raw)
    assert.equal(forwards.at(-1).headers['stripe-signature'], signed(raw, local[scope]))
  }
  assert.equal(receipts.length, 2)
  assert(receipts.every((r) => r.cliSignatureVerified))
})
