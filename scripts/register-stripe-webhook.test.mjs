// Run: node --experimental-vm-modules --test scripts/register-stripe-webhook.test.mjs
// Every provider, control-plane, credential, terminal and write operation is fake.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm'
import { createHash, createHmac } from 'node:crypto'

const scriptUrl = new URL('./register-stripe-webhook.mjs', import.meta.url)
const source = readFileSync(scriptUrl, 'utf8')
const endpoint = 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/stripe-webhook'
const whsec = 'whsec_TestFixtureOnlyNotReal'
async function run(options = {}) {
  const calls = [],
    logs = [],
    reports = []
  let created = null,
    saved = false
  const prior = [
    {
      id: 'we_Unrelated1234',
      url: 'https://other.example.invalid/hook',
      status: 'enabled',
      api_version: '2024-04-10',
      enabled_events: ['charge.succeeded'],
    },
  ]
  if (options.existing) prior.push({ id: 'we_KmaExists1234', url: endpoint })
  const stdin = {
    isTTY: true,
    setRawMode() {},
    pause() {},
    resume() {},
    off() {},
    on(_name, fn) {
      queueMicrotask(() =>
        fn(Buffer.from(`${options.key ?? 'rk_live_TestFixtureOnlyNotARealKey'}\n`)),
      )
    },
  }
  const ctx = createContext({
    Buffer,
    URL,
    URLSearchParams,
    AbortSignal,
    process: {
      argv: ['node', scriptUrl.pathname, options.mode ?? '--create-approved'],
      env: { SUPABASE_ACCESS_TOKEN: 'test-only-control-plane-token' },
      stdin,
      stdout: { write: (text) => logs.push(text) },
      exit: () => {
        throw Error('test process exit')
      },
    },
    console: { log: (text) => logs.push(text), error: (text) => logs.push(text) },
    fetch: async (urlValue, init = {}) => {
      const url = new URL(urlValue)
      calls.push({ url, init })
      if (url.hostname === 'api.stripe.com') {
        if (url.pathname.startsWith('/v1/prices/'))
          return Response.json({
            livemode: true,
            product: 'prod_VCii4guzoryBtZ',
            currency: 'usd',
            unit_amount: 100,
          })
        assert.equal(url.pathname, '/v1/webhook_endpoints')
        if (init.method === 'POST') {
          if (options.denied)
            return Response.json({ message: 'private provider contents' }, { status: 403 })
          if (options.badJson)
            return new Response('invalid JSON containing private provider contents')
          const form = new URLSearchParams(init.body)
          created = {
            id: 'we_KmaDedicated1234',
            url: form.get('url'),
            api_version: form.get('api_version'),
            enabled_events: form.getAll('enabled_events[]'),
            livemode: true,
            status: 'enabled',
            secret: whsec,
          }
          return Response.json(created)
        }
        return Response.json({
          object: 'list',
          has_more: false,
          data: [...prior, ...(created ? [created] : [])],
        })
      }
      if (url.hostname === 'api.supabase.com') {
        if (url.pathname.endsWith('/functions'))
          return Response.json([
            {
              slug: 'stripe-webhook',
              status: 'ACTIVE',
              version: 12,
              ezbr_sha256: 'f735bc20e435a82f3b47455acf605c1795cb85fc9ada1d36ce6f564bbb28575b',
            },
          ])
        if (url.pathname.endsWith('/database/query')) {
          const sql = JSON.parse(init.body).query
          assert.match(sql, /^select /)
          return Response.json(sql.includes('to_regprocedure') ? [{ ready: true }] : [{ n: 0 }])
        }
        assert.ok(url.pathname.endsWith('/secrets'))
        if (init.method === 'POST') {
          assert.deepEqual(JSON.parse(init.body), [{ name: 'STRIPE_WEBHOOK_SECRET', value: whsec }])
          saved = true
          return new Response(null, { status: 201 })
        }
        return Response.json([
          { name: 'STRIPE_SECRET_KEY', value: 'unchanged-digest' },
          ...(saved
            ? [
                {
                  name: 'STRIPE_WEBHOOK_SECRET',
                  value: createHash('sha256').update(whsec).digest('hex'),
                },
              ]
            : []),
        ])
      }
      assert.equal(url.href, endpoint)
      const signature = init.headers['stripe-signature']
      if (!signature) return Response.json({ error: 'invalid_signature' }, { status: 400 })
      const [time, digest] = signature.split(',').map((part) => part.slice(part.indexOf('=') + 1))
      assert.equal(digest, createHmac('sha256', whsec).update(`${time}.${init.body}`).digest('hex'))
      assert.deepEqual(JSON.parse(init.body).data.object.metadata, {})
      return Response.json({ ignored: true })
    },
  })
  const module = new SourceTextModule(source, {
    context: ctx,
    identifier: scriptUrl.href,
    initializeImportMeta(meta) {
      meta.url = scriptUrl.href
    },
  })
  await module.link(async (name) => {
    const exports =
      name === 'node:fs'
        ? {
            mkdirSync() {},
            writeFileSync(path, data) {
              reports.push({ path, data })
            },
          }
        : name === 'node:child_process'
          ? {
              execFileSync() {
                throw Error('A real credential read must never run in this test')
              },
            }
          : await import(name)
    const mock = new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
      },
      { context: ctx },
    )
    return mock
  })
  await module.evaluate()
  return { calls, logs: logs.join('\n'), reports, saved, created }
}

test('registration: exact dedicated endpoint, pinned API, selected events and only signing-secret write', async () => {
  const result = await run()
  const stripeWrites = result.calls.filter(
    (c) => c.url.hostname === 'api.stripe.com' && c.init.method === 'POST',
  )
  assert.equal(stripeWrites.length, 1)
  const form = new URLSearchParams(stripeWrites[0].init.body)
  assert.equal(form.get('url'), endpoint)
  assert.equal(form.get('api_version'), '2026-02-25.clover')
  assert.equal(form.get('connect'), 'false')
  assert.equal(form.getAll('enabled_events[]').length, 11)
  assert.equal(form.getAll('enabled_events[]').includes('*'), false)
  assert.equal(result.saved, true)
  assert.equal(result.reports.length, 1)
  const report = JSON.parse(result.reports[0].data)
  assert.equal(report.realStripeDeliveryVerified, false)
  assert.equal(report.checkoutEnabledChanged, false)
  assert.equal(report.chargesCreated, 0)
  assert.equal(result.logs.includes(whsec), false)
  assert.equal(result.reports[0].data.includes(whsec), false)
  assert.equal(result.logs.includes('rk_live_TestFixtureOnly'), false)
})
test('registration: existing destination never duplicates or rotates its secret', async () => {
  const result = await run({ existing: true })
  assert.equal(result.created, null)
  assert.equal(result.saved, false)
  assert.match(result.logs, /already exists/)
})
test('registration: restricted-key denial creates no secret and prints no provider body', async () => {
  const result = await run({ denied: true })
  assert.equal(result.saved, false)
  assert.match(result.logs, /Stripe HTTP 403/)
  assert.equal(result.logs.includes('private provider contents'), false)
})
test('registration: unexpected parse errors do not echo sensitive payload snippets', async () => {
  const result = await run({ badJson: true })
  assert.equal(result.saved, false)
  assert.match(result.logs, /Sensitive error details were not printed/)
  assert.equal(result.logs.includes('private provider contents'), false)
})
test('registration: non-live key never reaches any provider', async () => {
  const result = await run({ key: 'rk_test_TestFixtureOnlyNotARealKey' })
  assert.equal(result.calls.length, 0)
  assert.match(result.logs, /live server key is required/)
})
test('registration: check mode performs no Stripe or secret writes', async () => {
  const result = await run({ mode: '--check' })
  assert.equal(result.created, null)
  assert.equal(result.saved, false)
  assert.match(result.logs, /Read-only checks passed/)
})
