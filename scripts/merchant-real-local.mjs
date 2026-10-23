#!/usr/bin/env node
/** Real Stripe TEST OAuth/checkout rehearsal; application data stays disposable/local. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, lstat } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import {
  createCrossAppFixture,
  fixtureIds,
  literal,
  kmaRoot,
  speaksixRoot,
} from './managed-checkout-crossapp-fixture.mjs'
import { merchantRealOptions, merchantOrigin } from './merchant-real-policy.mjs'
import { manualMerchantInventory } from './merchant-real-inventory.mjs'

const args = process.argv.slice(2)
if (args.length !== 1 || !['--run', '--smoke'].includes(args[0]))
  throw Error(
    'Use --run for the explicitly approved TEST rehearsal or --smoke for local-only startup validation.',
  )
const smoke = args[0] === '--smoke'
let merchantWebhookInventory
if (process.env.KMA_MERCHANT_WEBHOOK_INVENTORY) {
  const path = process.env.KMA_MERCHANT_WEBHOOK_INVENTORY
  const stat = await lstat(path)
  if (!path.startsWith('/') || !stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
    throw Error('Explicit local inventory evidence file required.')
  const supplied = JSON.parse(await readFile(path, 'utf8'))
  const screenshot = await lstat(supplied.screenshotPath)
  if (!screenshot.isFile() || screenshot.isSymbolicLink() || screenshot.size > 10 * 1024 * 1024)
    throw Error('Local inventory screenshot required.')
  supplied.screenshotSha256 = createHash('sha256')
    .update(await readFile(supplied.screenshotPath))
    .digest('hex')
  merchantWebhookInventory = manualMerchantInventory(
    supplied,
    supplied.accountId,
    403,
    'oauth_not_supported',
  )
}
let options
if (smoke)
  options = merchantRealOptions({
    enabled: true,
    key: 'sk_test_localfixture123456789',
    platformAccountId: 'acct_localplatform',
    clientId: 'ca_localfixture',
  })
else {
  const path = join(kmaRoot, '.env.stripe-test.local'),
    stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error('Private TEST credentials file required.')
  const env = parseEnv(await readFile(path, 'utf8'))
  options = merchantRealOptions({
    enabled: true,
    key: env.KMA_REAL_TEST_STRIPE_SECRET_KEY,
    platformAccountId: env.KMA_REAL_TEST_STRIPE_ACCOUNT_ID,
    clientId: process.env.KMA_MERCHANT_TEST_CLIENT_ID || env.KMA_MERCHANT_TEST_CLIENT_ID,
  })
}
const secrets = Object.fromEntries(
  ['control', 'admin', 'merchant', 'inbound', 'outbound'].map((k) => [
    k,
    randomBytes(32).toString('hex'),
  ]),
)
const safeEnv = { PATH: process.env.PATH, USER: process.env.USER, LANG: 'C', LC_ALL: 'C' }
let fixture,
  server,
  bridge,
  bridgeOrigin,
  invitation,
  connection,
  payments,
  signature,
  ready = false,
  stopping = false,
  timer,
  busy = false,
  intakeId,
  orders = [],
  offerId,
  preparing,
  preparedTerms
let lastError = null
const evidence = {
  startedAt: new Date().toISOString(),
  realStripe: !smoke,
  livemode: false,
  applicationData: 'disposable local PostgreSQL',
  authentication: 'synthetic local fixture identity',
  platformAccountId: options.platformAccountId,
  payoutsEnabled: false,
}
const json = (res, status, body) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}
async function rpc(db, name, value, admin = false) {
  const r = await fixture.rpc(db, name, value, admin)
  if (r.error) throw Error(`Local database operation ${name} rejected (${r.error.code}).`)
  return r.data
}
async function bridgeCall(path, value = {}, extra = {}) {
  const r = await fetch(bridgeOrigin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-local-control': secrets.control, ...extra },
    body: JSON.stringify(value),
    redirect: 'error',
  })
  const data = await r.json()
  if (!r.ok) {
    const error = Error(data.message || data.error || 'Local operation failed.')
    error.safe = data
    throw error
  }
  return data
}
async function merchantAction(input) {
  const admin = ['status', 'create_invitation', 'assign_product', 'revoke'].includes(input.action)
  return bridgeCall('/merchant', input, {
    origin: merchantOrigin,
    authorization: `Bearer ${admin ? secrets.admin : secrets.merchant}`,
  })
}
async function snapshot() {
  const sql = `select jsonb_build_object('orders',(select coalesce(jsonb_agg(jsonb_build_object('id',external_order_id,'attempt_id',attempt_id,'status',status,'payment_status',payment_status,'account_id',account_id,'platform_account_id',platform_account_id,'amount_minor',amount_minor,'currency',currency,'application_fee_amount',application_fee_amount,'application_fee_id',application_fee_id,'application_fee_refunded_amount',application_fee_refunded_amount,'application_fee_verified_at',application_fee_verified_at,'refunded_amount_minor',refunded_amount_minor)),'[]') from public.managed_checkout_orders),'commissions',(select coalesce(jsonb_agg(jsonb_build_object('order_id',o.external_order_id,'original',a.original_commission_minor,'current',a.commission_minor,'reversed',a.reversed_minor,'status',a.status,'blocker',a.blocker)),'[]') from public.external_commission_awards a join public.external_commerce_orders o on o.id=a.order_id),'fee_refunds',(select coalesce(jsonb_agg(jsonb_build_object('amount_minor',amount_minor,'completed',completed_at is not null,'refund_id',refund_id)),'[]') from public.managed_application_fee_refunds),'pending_callbacks',(select count(*) from public.managed_checkout_outbox where state<>'delivered'),'payout_jobs',(select count(*) from public.external_settlement_jobs))`
  const kma = JSON.parse(await fixture.sql('kma', sql))
  const speaksix = JSON.parse(
    await fixture.sql(
      'speaksix',
      `select jsonb_build_object('pay_first_orders',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'registration_id',registration_id,'cohort_id',cohort_id,'refunded',cumulative_refunded_amount_cents)),'[]') from public.marathon_orders where intake_id is not null),'captures',(select count(*) from public.marathon_payment_captures))`,
    ),
  )
  Object.assign(evidence, {
    checkedAt: new Date().toISOString(),
    ready,
    ...(connection
      ? {
          merchant: {
            accountId: connection.account_id ?? connection.candidate?.account_id,
            status: connection.status,
            businessName: connection.business_name,
          },
        }
      : {}),
    kma,
    speaksix,
    bridge: await bridgeCall('/state'),
    lastError,
  })
  await writeFile(
    join(fixture.directory, 'merchant-real-result.json'),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  )
  return evidence
}
async function reconcile() {
  if (!ready) return
  await fixture.sql(
    'kma',
    "update public.managed_checkout_orders set next_reconcile_at=now();update public.managed_checkout_outbox set next_attempt_at=now() where state='pending'",
  )
  await bridgeCall('/worker')
  const attempts = JSON.parse(
    await fixture.sql(
      'speaksix',
      "select coalesce(jsonb_agg(id),'[]') from public.marathon_checkout_attempts",
    ),
  )
  for (const id of attempts) await payments.reconcileAttempt(id)
  await rpc('kma', 'process_external_commissions', { p_limit: 100 })
}
async function prepare(priceId) {
  if (ready) throw Error('This fixture is already prepared; do not change its account or price.')
  if (!/^price_[A-Za-z0-9_]{8,128}$/.test(priceId ?? ''))
    throw Error('A verified merchant TEST Price ID is required.')
  const result = await merchantAction({
    action: 'connection_status',
    invitation_id: invitation.invitation_id,
  })
  connection = result.connection
  if (connection.status !== 'connected')
    throw Error('Explicitly confirm the real returned merchant before assigning it.')
  const merchantAccount = connection.account_id ?? connection.candidate?.account_id
  if (
    !/^acct_[A-Za-z0-9]+$/.test(merchantAccount ?? '') ||
    merchantAccount === options.platformAccountId
  )
    throw Error('Distinct merchant account required.')
  if (preparing && (preparing.priceId !== priceId || preparing.merchantAccount !== merchantAccount))
    throw Error(
      'This preparation is already pinned to its merchant and price. Resume the same values.',
    )
  preparing = { priceId, merchantAccount }
  await merchantAction({
    action: 'assign_product',
    product_id: fixtureIds.product,
    merchant_id: invitation.merchant_id,
    livemode: false,
  })
  // This reuses the already-signed synthetic agreement/rule from the canonical fixture.
  const prior = Number(
    await fixture.sql(
      'kma',
      `select coalesce(max(version),0) from public.external_commission_terms where stripe_account_id=${literal(merchantAccount)} and not livemode`,
    ),
  )
  if (!preparedTerms) {
    const terms = await rpc(
      'kma',
      'configure_admin_external_commission_terms',
      {
        p_input: {
          request_id: randomUUID(),
          agreement_id: 'ac570000-0000-4000-8000-000000000021',
          commission_rule_id: 'ac570000-0000-4000-8000-000000000022',
          product_id: fixtureIds.product,
          funnel_id: fixtureIds.funnel,
          affiliate_id: fixtureIds.creator,
          stripe_account_id: merchantAccount,
          platform_account_id: options.platformAccountId,
          livemode: false,
          currency: 'USD',
          funding_model: 'application_fee',
          effective_from: new Date().toISOString(),
          effective_until: null,
          expected_version: prior,
          reason:
            'Approved local TEST merchant application-fee rehearsal using existing signed synthetic agreement',
        },
      },
      true,
    )
    preparedTerms = {
      id: terms.id,
      revision: terms.revision,
      approvalId: randomUUID(),
      approved: false,
    }
  }
  if (!preparedTerms.approved) {
    await rpc(
      'kma',
      'perform_admin_external_settlement_action',
      {
        p_input: {
          request_id: preparedTerms.approvalId,
          action: 'approve_terms',
          id: preparedTerms.id,
          expected_revision: preparedTerms.revision,
          reason: 'Approve only the disposable TEST commission binding',
        },
      },
      true,
    )
    preparedTerms.approved = true
  }
  await fixture.sql(
    'kma',
    `update public.billing_offers set stripe_price_id=${literal(priceId)} where id=${literal(offerId)}`,
  )
  const verified = await bridgeCall('/prepare-price', { offerId, priceId })
  const offerVersion = Number(
    await fixture.sql(
      'kma',
      `select version from public.billing_offers where id=${literal(offerId)}`,
    ),
  )
  intakeId = randomUUID()
  await fixture.sql(
    'speaksix',
    `insert into public.marathon_intakes(id,title,start_date,end_date,timezone,enrollment_closes_at,months,weeks,lessons,capacity,invitation_hours,price_cents,currency,status,pay_first,kma_product_id,kma_funnel_id,kma_offer_key,kma_offer_version) values(${literal(intakeId)},'TEST merchant pay-first Marathon',current_date+30,current_date+120,'UTC',now()+interval '29 days',3,12,36,6,48,16900,'USD','open',true,${literal(fixtureIds.product)},${literal(fixtureIds.funnel)},'marathon',${offerVersion})`,
  )
  for (const [i, attributed] of [true, false].entries()) {
    const id = await rpc('speaksix', 'marathon_prepare_purchase', {
      intake: intakeId,
      request_key: randomUUID(),
      verified_user: null,
      customer_email: `merchant-rehearsal-${i}@example.invalid`,
      customer_name: 'Synthetic TEST buyer',
      guest_scope_hash: randomBytes(32).toString('hex'),
      source: attributed
        ? { kmaClick: fixtureIds.click, capturedAt: new Date().toISOString() }
        : {},
    })
    orders.push({ id, userId: id, attributed, refundRequestId: randomUUID() })
  }
  const paymentModule = await import(
    pathToFileURL(join(speaksixRoot, 'src/lib/marathon/kma-checkout.ts'))
  )
  const { createMarathonCheckoutRepository } = await import(
    pathToFileURL(join(speaksixRoot, 'src/lib/marathon/checkout-attempts.ts'))
  )
  const client = fixture.client('speaksix')
  signature = paymentModule.kmaCheckoutSignature
  payments = paymentModule.createKmaCheckoutPayments(
    {
      enabled: true,
      callbacksEnabled: true,
      local: true,
      origin: merchantOrigin,
      endpoint: bridgeOrigin + '/functions/v1/managed-checkout',
      keyId: 'merchant-real-test',
      secret: secrets.inbound,
      webhookKeys: { 'managed-callback': secrets.outbound },
      productId: fixtureIds.product,
      funnelId: fixtureIds.funnel,
      accountId: merchantAccount,
      livemode: false,
      offerKey: 'marathon',
    },
    createMarathonCheckoutRepository(client),
    paymentModule.createKmaCheckoutRepository(client),
    {
      fetch: (url, init) => {
        if (String(url) !== bridgeOrigin + '/functions/v1/managed-checkout')
          throw Error('Only local checkout endpoint allowed.')
        return fetch(url, {
          ...init,
          headers: { ...init.headers, 'x-local-control': secrets.control },
        })
      },
    },
  )
  ready = true
  return {
    ...verified,
    offerVersion,
    orders: orders.map(({ id, attributed }) => ({ id, attributed })),
  }
}
async function refund(index) {
  const o = orders[index]
  if (!o) throw Error('Unknown fixture order.')
  const attempt = JSON.parse(
    await fixture.sql(
      'kma',
      `select jsonb_build_object('id',attempt_id,'amount',amount_minor) from public.managed_checkout_orders where external_order_id=${literal(o.id)} order by created_at desc limit 1`,
    ),
  )
  const body = JSON.stringify({
    action: 'refund',
    request_id: o.refundRequestId,
    order_id: o.id,
    attempt_id: attempt.id,
    amount_minor: attempt.amount,
    refund_remaining: true,
    reason: 'requested_by_customer',
  })
  const r = await fetch(bridgeOrigin + '/functions/v1/managed-checkout', {
    method: 'POST',
    headers: {
      ...signature(body, 'merchant-real-test', secrets.inbound),
      'x-local-control': secrets.control,
    },
    body,
    redirect: 'error',
  })
  if (!r.ok) {
    const failure = await r.json()
    throw Error(failure.message || failure.error || 'TEST refund could not be verified.')
  }
  await reconcile()
  return snapshot()
}
async function assertStage(stage) {
  if (!['paid', 'refunded'].includes(stage)) throw Error('Choose paid or refunded evidence stage.')
  await reconcile()
  const result = await snapshot(),
    rows = result.kma.orders
  assert.equal(rows.length, 2, 'Both referred and organic purchases must exist.')
  assert.equal(result.speaksix.pay_first_orders.length, 2)
  assert.equal(result.speaksix.captures, 2)
  for (const row of rows) {
    assert.equal(row.account_id, result.bridge.permittedMerchant)
    assert.equal(row.platform_account_id, options.platformAccountId)
    assert.equal(row.currency, 'USD')
    assert.equal(row.amount_minor, 16900)
    assert.equal(row.status, stage)
  }
  const referred = rows.find((o) => o.id === orders[0].id),
    organic = rows.find((o) => o.id === orders[1].id)
  assert.equal(referred.application_fee_amount, 4225)
  assert.match(referred.application_fee_id ?? '', /^fee_/)
  assert(
    referred.application_fee_verified_at,
    'Actual fee funding still needs verification; inspect currency evidence.',
  )
  assert.equal(organic.application_fee_amount, 0)
  assert.equal(organic.application_fee_id, null)
  const fundedAwards = result.kma.commissions.filter((a) => a.original > 0)
  assert.equal(fundedAwards.length, 1)
  assert.equal(fundedAwards[0].order_id, referred.id)
  assert.equal(fundedAwards[0].original, 4225)
  assert.equal(result.kma.payout_jobs, 0)
  assert.equal(result.kma.pending_callbacks, 0)
  assert(
    result.bridge.webhookEvidence.some(
      (e) =>
        !e.ignored &&
        e.account === result.bridge.permittedMerchant &&
        e.type === 'checkout.session.completed',
    ),
    'A relevant real connected-account payment webhook is required.',
  )
  assert(
    result.bridge.webhookEvidence.some(
      (e) => !e.ignored && e.account === null && e.type === 'application_fee.created',
    ),
    'A relevant real platform application-fee webhook is required.',
  )
  const ledger = JSON.parse(
    await fixture.sql(
      'kma',
      "select jsonb_build_object('earned',(select count(*) from public.external_commission_ledger where kind='earned'),'earned_amount',(select sum(amount_minor) from public.external_commission_ledger where kind='earned'),'reversed',(select count(*) from public.external_commission_ledger where kind='reversed'),'reversed_amount',(select coalesce(sum(amount_minor),0) from public.external_commission_ledger where kind='reversed'))",
    ),
  )
  assert.equal(ledger.earned, 1)
  assert.equal(ledger.earned_amount, 4225)
  if (stage === 'paid') {
    assert.equal(ledger.reversed, 0)
    assert.equal(referred.application_fee_refunded_amount, 0)
    assert.equal(result.kma.fee_refunds.length, 0)
    for (const order of result.speaksix.pay_first_orders) {
      assert.equal(order.status, 'paid')
      assert.equal(order.registration_id, null)
      assert.equal(order.cohort_id, null)
    }
  } else {
    assert(
      result.bridge.webhookEvidence.some(
        (e) =>
          !e.ignored &&
          e.account === result.bridge.permittedMerchant &&
          ['refund.created', 'refund.updated', 'charge.refunded'].includes(e.type),
      ),
      'A relevant real connected-account refund webhook is required.',
    )
    assert(
      result.bridge.webhookEvidence.some(
        (e) =>
          !e.ignored &&
          e.account === null &&
          ['application_fee.refunded', 'application_fee.refund.updated'].includes(e.type),
      ),
      'A relevant real platform fee-refund webhook is required.',
    )
    assert.equal(ledger.reversed, 1)
    assert.equal(ledger.reversed_amount, -4225)
    assert.equal(referred.application_fee_refunded_amount, 4225)
    assert.equal(result.kma.fee_refunds.length, 1)
    assert.equal(result.kma.fee_refunds[0].amount_minor, 4225)
    assert.equal(result.kma.fee_refunds[0].completed, true)
    for (const row of rows) assert.equal(row.refunded_amount_minor, 16900)
    for (const order of result.speaksix.pay_first_orders) assert.equal(order.status, 'refunded')
  }
  const acceptance = {
    checkedAt: new Date().toISOString(),
    stage,
    passed: true,
    ledger,
    provider: result.bridge.accountingEvidence,
  }
  await writeFile(
    join(fixture.directory, `merchant-real-${stage}.json`),
    JSON.stringify(acceptance, null, 2),
    { mode: 0o600 },
  )
  return acceptance
}
async function assertRepeatedRefund() {
  await assertStage('refunded')
  const before = await snapshot()
  for (const index of [0, 1]) await refund(index)
  const after = await snapshot()
  assert.equal(after.bridge.refundWrites, before.bridge.refundWrites)
  assert.equal(after.bridge.feeRefundWrites, before.bridge.feeRefundWrites)
  assert.deepEqual(after.kma.fee_refunds, before.kma.fee_refunds)
  await assertStage('refunded')
  const acceptance = {
    checkedAt: new Date().toISOString(),
    passed: true,
    customerRefundWritesBefore: before.bridge.refundWrites,
    customerRefundWritesAfter: after.bridge.refundWrites,
    feeRefundWritesBefore: before.bridge.feeRefundWrites,
    feeRefundWritesAfter: after.bridge.feeRefundWrites,
    feeRefunds: after.kma.fee_refunds,
  }
  await writeFile(
    join(fixture.directory, 'merchant-real-repeat-refund.json'),
    JSON.stringify(acceptance, null, 2),
    { mode: 0o600 },
  )
  return acceptance
}
const html = () =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>KMA merchant TEST rehearsal</title><style>body{font:16px system-ui;background:#f7f7f2;color:#153e37;max-width:880px;margin:32px auto;padding:16px}section{background:white;padding:20px;margin:16px 0;border:1px solid #cad9cf;border-radius:14px}button,input{padding:12px;max-width:100%;box-sizing:border-box;margin:5px}button{cursor:pointer;background:#194e42;color:white;border:0;border-radius:8px}input{width:100%;border:1px solid #b8cabf}pre{white-space:pre-wrap;overflow-wrap:anywhere}#notice{color:#a43b22}</style><h1>Merchant connection · Stripe TEST</h1><p>Actual Stripe OAuth and payment handlers. Application databases and signed commission agreement are disposable local fixtures. This operator page uses a synthetic local identity; it does not test real email sign-in. No live checkout or creator payout is enabled.</p><section><button data-action="preflight">Check TEST isolation</button><button data-action="invite">Create local invitation</button><button data-action="start">Connect with Stripe</button><button data-action="confirm">Confirm displayed merchant</button><pre id="candidate"></pre></section><section><label>Merchant TEST Price ID<input id="price" placeholder="price_…"></label><button data-action="prepare">Assign merchant and verify $169 TEST Price</button><button data-action="checkout" data-index="0">Pay referred TEST purchase</button><button data-action="checkout" data-index="1">Pay organic TEST purchase</button></section><section><button data-action="reconcile">Reconcile</button><button data-action="refund" data-index="0">Refund referred TEST purchase</button><button data-action="refund" data-index="1">Refund organic TEST purchase</button><p>Refund actions use the signed local KMA refund endpoint and preserve each request ID on repetition. No creator transfer or bank payout occurs.</p></section><p id="notice"></p><pre id="state"></pre><script>const token=${JSON.stringify(secrets.control)};async function call(action,value={}){const r=await fetch('/api/'+action,{method:'POST',headers:{'content-type':'application/json','x-local-control':token},body:JSON.stringify(value)});const d=await r.json();if(!r.ok)throw Error(d.message||d.error||'Local step failed');return d}async function state(){document.querySelector('#state').textContent=JSON.stringify(await call('state'),null,2)}document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{b.disabled=true;try{document.querySelector('#notice').textContent='Working…';const d=await call(b.dataset.action,{index:Number(b.dataset.index||0),priceId:document.querySelector('#price').value});if(d.authorization_url||d.url){location.assign(d.authorization_url||d.url);return}if(d.connection)document.querySelector('#candidate').textContent=JSON.stringify(d.connection,null,2);document.querySelector('#notice').textContent='Verified this step.';await state()}catch(e){document.querySelector('#notice').textContent=e.message}finally{b.disabled=false}});const q=new URLSearchParams(location.search);const code=q.get('code'),oauthState=q.get('state'),error=q.get('error');history.replaceState(null,'','/');(async()=>{if(error)document.querySelector('#notice').textContent='Stripe authorisation was cancelled. Start a new attempt.';else if(code&&oauthState){try{const d=await call('complete',{code,state:oauthState});document.querySelector('#candidate').textContent=JSON.stringify(d.connection,null,2);document.querySelector('#notice').textContent='Review this exact account, then confirm it.'}catch(e){document.querySelector('#notice').textContent=e.message}}await state()})();</script>`
async function shutdown() {
  if (stopping) return
  stopping = true
  clearInterval(timer)
  if (fixture && bridgeOrigin) await snapshot().catch(() => {})
  bridge?.kill('SIGTERM')
  if (server) {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
  await fixture?.stop()
  console.log(
    'Local merchant rehearsal stopped; TEST provider objects retained. No deployment occurred.',
  )
}
try {
  fixture = await createCrossAppFixture({ privateStatements: true, unverifiedManagedOffer: true })
  await fixture.sql(
    'kma',
    "insert into auth.users(id,email,email_confirmed_at) values('ac570000-0000-4000-8000-000000000080','merchant-rehearsal@example.invalid',now());update auth.users set email_confirmed_at=now() where email_confirmed_at is null",
  )
  offerId = await fixture.sql(
    'kma',
    `select id from public.billing_offers where product_id=${literal(fixtureIds.product)} and key='marathon'`,
  )
  server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    try {
      if (req.headers.host !== new URL(merchantOrigin).host)
        return json(res, 403, { error: 'Local host required.' })
      const url = new URL(req.url, merchantOrigin)
      if (
        req.method === 'GET' &&
        ['/', '/merchant/connect', '/merchant/callback', '/marathon/enrollment'].includes(
          url.pathname,
        )
      ) {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(html())
        return
      }
      let raw = ''
      for await (const part of req) {
        raw += part
        if (raw.length > 262144) throw Error('Request too large.')
      }
      if (url.pathname === '/kma-events') {
        if (!payments) throw Error('Payment adapter not ready.')
        return json(res, 200, await payments.webhook(raw, new Headers(req.headers)))
      }
      if (
        req.method !== 'POST' ||
        req.headers['x-local-control'] !== secrets.control ||
        (req.headers.origin && req.headers.origin !== merchantOrigin)
      )
        return json(res, 403, { error: 'Local control required.' })
      const body = JSON.parse(raw || '{}')
      if (url.pathname === '/__local/rpc')
        return json(res, 200, await fixture.rpc('kma', body.name, body.args, body.admin === true))
      if (url.pathname === '/api/state') return json(res, 200, await snapshot())
      if (url.pathname === '/api/preflight') return json(res, 200, await bridgeCall('/preflight'))
      if (url.pathname === '/api/webhook-secrets')
        return json(res, 200, await bridgeCall('/webhook-secrets', body))
      if (url.pathname === '/api/invite') {
        invitation = await merchantAction({
          action: 'create_invitation',
          request_id: randomUUID(),
          binding_id: 'merchant-real-test',
          business_name: 'SpeakSix TEST merchant',
          email: 'merchant-rehearsal@example.invalid',
          ...(invitation ? { merchant_id: invitation.merchant_id } : {}),
        })
        await writeFile(
          join(fixture.directory, 'invitation-private.json'),
          JSON.stringify(invitation),
          { mode: 0o600 },
        )
        return json(res, 200, { created: true, invitation_id: invitation.invitation_id })
      }
      if (url.pathname === '/api/start') {
        const preflight = await bridgeCall('/preflight')
        if (preflight.conflicts.length)
          return json(res, 409, {
            error: 'Enabled TEST webhook destinations need isolation first.',
            conflicts: preflight.conflicts,
          })
        if (!invitation) throw Error('Create the local invitation first.')
        return json(
          res,
          200,
          await merchantAction({
            action: 'start_connection',
            invite_token: new URL(invitation.invitation_url).hash.slice('#invite='.length),
          }),
        )
      }
      if (url.pathname === '/api/complete') {
        const result = await merchantAction({
          action: 'complete_connection',
          state: body.state,
          code: body.code,
        })
        connection = result.connection
        return json(res, 200, result)
      }
      if (url.pathname === '/api/confirm') {
        const result = await merchantAction({
          action: 'confirm_connection',
          invitation_id: invitation.invitation_id,
        })
        connection = result.connection
        return json(res, 200, result)
      }
      if (url.pathname === '/api/prepare') return json(res, 200, await prepare(body.priceId))
      if (url.pathname === '/api/checkout') {
        if (!ready || !orders[body.index])
          throw Error('Prepare the verified merchant and TEST Price first.')
        if (!(await bridgeCall('/state')).webhooksReady)
          throw Error('Configure both distinct TEST webhook signing secrets before payment.')
        const order = orders[body.index]
        return json(res, 200, await payments.checkout(order.id, order.userId))
      }
      if (url.pathname === '/api/reconcile') {
        await reconcile()
        return json(res, 200, await snapshot())
      }
      if (url.pathname === '/api/refund') return json(res, 200, await refund(body.index))
      if (url.pathname === '/api/assert-repeat-refund')
        return json(res, 200, await assertRepeatedRefund())
      if (url.pathname === '/api/assert') return json(res, 200, await assertStage(body.stage))
      return json(res, 404, { error: 'Unknown local route.' })
    } catch (error) {
      lastError = error.message
      return json(res, 409, {
        message: error.message,
        ...(error.safe?.conflicts ? { conflicts: error.safe.conflicts } : {}),
      })
    }
  })
  server.listen(5194, '127.0.0.1')
  await once(server, 'listening')
  bridge = spawn(
    'deno',
    [
      'run',
      '--cached-only',
      '--config',
      'supabase/functions/deno.json',
      '--allow-env',
      `--allow-net=127.0.0.1${smoke ? '' : ',api.stripe.com,connect.stripe.com'}`,
      'scripts/merchant-real-bridge.ts',
    ],
    { cwd: kmaRoot, env: safeEnv, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  bridge.stdin.end(
    JSON.stringify({ ...options, ...secrets, merchantWebhookInventory, enabled: true }),
  )
  let logs = ''
  bridge.stderr.on('data', (chunk) => {
    logs = (logs + chunk).slice(-4000)
  })
  const started = await new Promise((resolve, reject) => {
    let text = ''
    const t = setTimeout(() => reject(Error('Local bridge readiness timed out.')), 20000)
    bridge.stdout.on('data', (chunk) => {
      text += chunk
      const line = text.split('\n').find((l) => l.startsWith('{'))
      if (line) {
        clearTimeout(t)
        resolve(JSON.parse(line))
      }
    })
    bridge.once('exit', () => {
      clearTimeout(t)
      reject(Error('Local bridge stopped before readiness.'))
    })
  })
  bridgeOrigin = `http://127.0.0.1:${started.port}`
  await writeFile(
    join(fixture.directory, 'controller-private.json'),
    JSON.stringify({ origin: merchantOrigin, bridgeOrigin, control: secrets.control }),
    { mode: 0o600 },
  )
  await snapshot()
  console.log(
    JSON.stringify({
      ready: true,
      providerCallsStarted: false,
      localUrl: merchantOrigin,
      callbackUrl: merchantOrigin + '/merchant/callback',
      webhookUrl:
        bridgeOrigin + '/functions/v1/managed-checkout-webhook?binding_id=merchant-real-test',
      evidence: join(fixture.directory, 'merchant-real-result.json'),
      controllerFile: join(fixture.directory, 'controller-private.json'),
    }),
  )
  if (smoke) {
    const invite = await merchantAction({
      action: 'create_invitation',
      request_id: randomUUID(),
      binding_id: 'merchant-real-test',
      business_name: 'Local TEST merchant',
      email: 'merchant-rehearsal@example.invalid',
    })
    if (!invite.invitation_id) throw Error('Local invitation failed.')
    console.log('PASS local startup and invitation; network excludes Stripe.')
    await shutdown()
  } else {
    timer = setInterval(async () => {
      if (busy || stopping || !ready) return
      busy = true
      try {
        await reconcile()
        await snapshot()
        lastError = null
      } catch {
        lastError = 'Reconciliation incomplete; retry safely.'
      } finally {
        busy = false
      }
    }, 15000)
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, () => shutdown().then(() => process.exit(0)))
  }
} catch (error) {
  console.error(error.message)
  await shutdown()
  process.exitCode = 1
}
