#!/usr/bin/env node
/** Actual KMA handler/worker + SpeakSix adapter/RPC acceptance. No live providers.
 * Run: node --conditions=react-server scripts/test-managed-checkout-crossapp.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createCrossAppFixture,
  kmaRoot,
  speaksixRoot,
  fixtureIds,
  literal,
} from './managed-checkout-crossapp-fixture.mjs'
const secret = 'crossapp-control-secret-fixture-only'
const checks = []
const merchantDirect = process.argv.includes('--merchant-direct')
let fixture,
  server,
  deno,
  payments,
  callbackPayments,
  dropCallbackAck = false,
  bridgeOrigin,
  failed
const callbacks = []
async function check(name, work) {
  await work()
  checks.push(name)
  console.log(`PASS ${name}`)
}
async function body(request) {
  let content = ''
  for await (const chunk of request) {
    content += chunk
    if (content.length > 262144) throw Error('Fixture body exceeded limit')
  }
  return content
}
const readJson = async (response) => {
  const text = await response.text()
  if (!response.ok) throw Error(`Fixture HTTP ${response.status}: ${text}`)
  return JSON.parse(text)
}
const control = (path, input) =>
  fetch(bridgeOrigin + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-fixture-control': secret },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }).then(readJson)
try {
  fixture = await createCrossAppFixture({ merchantDirect })
  console.log(`Evidence: ${fixture.directory}`)
  server = createServer(async (request, response) => {
    try {
      const raw = await body(request)
      if (request.url === '/rpc/kma' && request.headers['x-fixture-control'] === secret) {
        const { name, args } = JSON.parse(raw)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(await fixture.rpc('kma', name, args)))
        return
      }
      if (request.url === '/kma-events') {
        const headers = new Headers(
          Object.entries(request.headers).flatMap(([key, value]) =>
            typeof value === 'string' ? [[key, value]] : [],
          ),
        )
        callbacks.push({ body: raw, headers: Object.fromEntries(headers) })
        const ack = await callbackPayments.webhook(raw, headers)
        if (dropCallbackAck) {
          dropCallbackAck = false
          response.statusCode = 503
          response.end('Synthetic acknowledgement lost after commit')
          return
        }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(ack))
        return
      }
      response.statusCode = 404
      response.end('Unknown isolated fixture route')
    } catch (error) {
      response.statusCode = 400
      response.end(error.message)
      await writeFile(join(fixture.directory, 'callback-errors.log'), String(error.stack) + '\n', {
        flag: 'a',
      })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('PG') && !/SUPABASE|STRIPE|RESEND|OPENAI|ZOOM|KMA|MARATHON/.test(key),
    ),
  )
  deno = spawn(
    'deno',
    [
      'run',
      '--cached-only',
      '--config',
      'supabase/functions/deno.json',
      '--allow-env',
      '--allow-net=127.0.0.1',
      'scripts/managed-checkout-crossapp-bridge.ts',
    ],
    {
      cwd: kmaRoot,
      env: {
        ...env,
        CROSSAPP_CONTROL_ORIGIN: origin,
        CROSSAPP_MERCHANT_DIRECT: merchantDirect ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let logs = '',
    output = ''
  deno.stderr.on('data', (chunk) => {
    logs += chunk
  })
  const listening = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Bridge did not start: ' + logs)), 20000)
    deno.stdout.on('data', (chunk) => {
      output += chunk
      const line = output.split('\n').find((v) => v.startsWith('{'))
      if (line) {
        try {
          const result = JSON.parse(line)
          clearTimeout(timeout)
          resolve(result)
        } catch {}
      }
    })
    deno.once('exit', (code) => {
      clearTimeout(timeout)
      reject(Error(`Bridge exited ${code}: ${logs}`))
    })
  })
  deno.once('exit', () => writeFile(join(fixture.directory, 'bridge.log'), logs))
  bridgeOrigin = `http://127.0.0.1:${listening.port}`
  const { createKmaCheckoutPayments, createKmaCheckoutRepository, kmaCheckoutSignature } =
    await import(pathToFileURL(join(speaksixRoot, 'src/lib/marathon/kma-checkout.ts')))
  const { createMarathonCheckoutRepository } = await import(
    pathToFileURL(join(speaksixRoot, 'src/lib/marathon/checkout-attempts.ts'))
  )
  const config = {
    enabled: true,
    callbacksEnabled: true,
    local: true,
    origin,
    endpoint: bridgeOrigin + '/functions/v1/managed-checkout',
    keyId: listening.binding.id,
    secret: listening.binding.secret,
    webhookKeys: { [listening.binding.callbackKeyId]: listening.binding.callbackSecret },
    productId: fixtureIds.product,
    funnelId: fixtureIds.funnel,
    accountId: fixtureIds.account,
    livemode: false,
    offerKey: fixtureIds.offer,
  }
  const client = fixture.client('speaksix'),
    repository = createMarathonCheckoutRepository(client),
    managed = createKmaCheckoutRepository(client)
  payments = createKmaCheckoutPayments(config, repository, managed)
  // Receiving durable payment facts must not reopen sales or require outbound credentials.
  callbackPayments = createKmaCheckoutPayments(
    { ...config, enabled: false, endpoint: '', keyId: '', secret: '' },
    repository,
    managed,
  )
  const query = (db, sql) => fixture.sql(db, sql),
    count = (db, table, where = 'true') =>
      query(db, `select count(*) from public.${table} where ${where}`).then(Number)
  async function drainWorker(complete) {
    // Each production tick has a strict work/time budget. Exercise successive
    // ticks instead of assuming an entire batch fits inside one worker lease.
    for (let tick = 0; tick < 12; tick++) {
      const result = await control('/__fixture/worker', {})
      assert.equal(result.failed, 0)
      if (await complete()) return
    }
    assert.fail('Local callback queue did not drain within twelve bounded ticks')
  }
  const first = fixture.orders[0]
  let checkout
  await check('Disabled checkout and another learner cannot create a payment', async () => {
    await assert.rejects(
      createKmaCheckoutPayments({ ...config, enabled: false }, repository, managed).checkout(
        first.id,
        first.userId,
      ),
      /disabled/,
    )
    await assert.rejects(payments.checkout(first.id, fixture.orders[1].userId), /another learner/)
    assert.equal((await control('/__fixture/state')).sessions.length, 0)
  })
  await check('Lost provider response recovers the same durable payment attempt', async () => {
    await control('/__fixture/control', { action: 'lose-create' })
    await assert.rejects(payments.checkout(first.id, first.userId))
    checkout = await payments.checkout(first.id, first.userId)
    const state = await control('/__fixture/state')
    assert.equal(state.sessions.length, 1)
    assert.equal(
      state.calls.filter((c) => c.path === 'checkout/sessions' && c.method === 'POST').length,
      1,
    )
    assert.equal(await count('speaksix', 'marathon_checkout_attempts'), 1)
    assert.equal((await payments.checkout(first.id, first.userId)).attemptId, checkout.attemptId)
    assert.equal((await control('/__fixture/state')).sessions.length, 1)
  })
  await check(
    'With sales closed, a paid callback commits one capture even when its acknowledgement is lost',
    async () => {
      dropCallbackAck = true
      await control('/__fixture/control', { action: 'pay', sessionId: checkout.sessionId })
      await query('kma', `update public.managed_checkout_orders set next_reconcile_at=now()`)
      const result = await control('/__fixture/worker', {})
      assert.equal(result.reconciled, 1)
      assert.equal(result.failed, 1)
      assert.equal(await count('speaksix', 'marathon_payment_captures'), 1)
      assert.equal(await count('speaksix', 'marathon_entitlements'), 0)
      assert.equal(await count('kma', 'managed_checkout_outbox', "state='pending'"), 1)
    },
  )
  await check(
    'Retry and duplicate callback acknowledge the same event without double fulfillment',
    async () => {
      await query('kma', `update public.managed_checkout_outbox set next_attempt_at=now()`)
      const result = await control('/__fixture/worker', {})
      assert.equal(result.delivered, 1)
      assert.equal(callbacks[0].body, callbacks[1].body)
      const event = JSON.parse(callbacks[0].body)
      const signed = kmaCheckoutSignature(
        callbacks[0].body,
        listening.binding.callbackKeyId,
        listening.binding.callbackSecret,
      )
      const ack = await callbackPayments.webhook(callbacks[0].body, new Headers(signed))
      assert.equal(ack.event_id, event.event_id)
      assert.equal(await count('speaksix', 'marathon_payment_captures'), 1)
      assert.equal(await count('kma', 'external_commerce_orders'), 1)
    },
  )
  await check(
    'Bad signatures and signed wrong-mode callbacks cannot modify payment truth',
    async () => {
      const event = JSON.parse(callbacks[0].body),
        before = await count('speaksix', 'marathon_kma_payment_receipts')
      await assert.rejects(
        createKmaCheckoutPayments(
          { ...config, callbacksEnabled: false },
          repository,
          managed,
        ).webhook(callbacks[0].body, new Headers(callbacks[0].headers)),
        /callbacks are disabled/,
      )
      await assert.rejects(callbackPayments.webhook(callbacks[0].body, new Headers()), /signature/)
      event.livemode = true
      const raw = JSON.stringify(event),
        signed = kmaCheckoutSignature(
          raw,
          listening.binding.callbackKeyId,
          listening.binding.callbackSecret,
        )
      await assert.rejects(callbackPayments.webhook(raw, new Headers(signed)), /scope/)
      assert.equal(await count('speaksix', 'marathon_kma_payment_receipts'), before)
    },
  )
  await check(
    'Existing signed commission terms create one award and one earned ledger entry',
    async () => {
      const result = await fixture.rpc('kma', 'process_external_commissions', { p_limit: 100 })
      assert.equal(result.error, null)
      const awards = JSON.parse(
        await query(
          'kma',
          `select jsonb_agg(jsonb_build_object('original',original_commission_minor,'amount',commission_minor,'status',status,'blocker',blocker,'rule',terms_snapshot->>'commission_rule_id')) from public.external_commission_awards`,
        ),
      )
      assert.equal(awards.length, 1)
      assert.equal(awards[0].original, 4225)
      assert.equal(awards[0].rule, 'ac570000-0000-4000-8000-000000000022')
      assert.equal(awards[0].blocker, 'validation_window')
      assert.equal(await count('kma', 'external_commission_ledger', "kind='earned'"), 1)
      await payments.reconcileAttempt(checkout.attemptId)
      await fixture.rpc('kma', 'process_external_commissions', { p_limit: 100 })
      assert.equal(await count('kma', 'external_commission_ledger', "kind='earned'"), 1)
    },
  )
  await check('Lost initial KMA request is recovered by the same saved attempt', async () => {
    const order = fixture.orders[1]
    let lost = false
    const interrupted = createKmaCheckoutPayments(config, repository, managed, {
      fetch: async (url, init) => {
        if (!lost && JSON.parse(String(init?.body)).action === 'create') {
          lost = true
          throw new Error('Synthetic request lost before KMA handler')
        }
        return fetch(url, init)
      },
    })
    await assert.rejects(interrupted.checkout(order.id, order.userId), /Synthetic request lost/)
    const attempt = await managed.latestAttempt(order.id)
    assert.ok(attempt)
    assert.equal(await count('kma', 'managed_checkout_orders'), 1)
    const recovered = await payments.reconcileAttempt(attempt.id)
    assert.equal(recovered.attemptId, attempt.id)
    assert.equal(recovered.status, 'open')
    assert.equal((await payments.checkout(order.id, order.userId)).attemptId, attempt.id)
    assert.equal(await count('speaksix', 'marathon_checkout_attempts'), 2)
    assert.equal((await control('/__fixture/state')).sessions.length, 2)
  })
  await check(
    'A definitively expired session renews within the same reservation and frozen offer',
    async () => {
      const order = fixture.orders[1]
      const initial = await payments.checkout(order.id, order.userId)
      const initialAttempt = await repository.attempt(initial.attemptId)
      await control('/__fixture/control', { action: 'expire', sessionId: initial.sessionId })
      assert.equal((await payments.reconcileAttempt(initial.attemptId)).status, 'expired')
      // A new catalog version must not silently replace the price already accepted
      // for this still-valid reservation. Subsequent new orders use v2 normally.
      await query(
        'kma',
        `update public.billing_offers set status='paused' where product_id=${literal(fixtureIds.product)} and key='marathon' and version=1;
      insert into public.billing_offers(product_id,key,version,name,billing_mode,stripe_price_id,currency,unit_amount_minor,success_url_template,cancel_url,status)
      values(${literal(fixtureIds.product)},'marathon',2,'Synthetic new catalog version','payment','price_ManagedCrossappReferenceV2','USD',16900,'https://marathon.speaksix.com/complete?session_id={CHECKOUT_SESSION_ID}','https://marathon.speaksix.com/enrollment','active');
      insert into public.managed_payment_offer_prices(offer_id,account_id,livemode,stripe_price_id,currency,unit_amount_minor,offer_version,configured_price_id)
      select id,${literal(fixtureIds.account)},false,${literal(fixtureIds.price)},currency,unit_amount_minor,version,stripe_price_id from public.billing_offers where product_id=${literal(fixtureIds.product)} and key='marathon' and version=2;`,
      )
      const renewed = await payments.checkout(order.id, order.userId)
      assert.notEqual(renewed.attemptId, initial.attemptId)
      assert.notEqual(renewed.sessionId, initial.sessionId)
      assert.equal((await managed.route(order.id)).offerVersion, 1)
      const newAttempt = await repository.attempt(renewed.attemptId)
      assert.ok(+new Date(newAttempt.expiresAt) >= +new Date(initialAttempt.expiresAt))
      const terms = JSON.parse(
        await query(
          'kma',
          `select jsonb_agg(jsonb_build_object('reservation',reservation_expires_at,'version',offer_version,'status',status) order by created_at) from public.managed_checkout_orders where external_order_id=${literal(order.id)}`,
        ),
      )
      assert.equal(terms.length, 2)
      assert.equal(terms[0].reservation, terms[1].reservation)
      assert.equal(terms[0].version, 1)
      assert.equal(terms[1].version, 1)
      assert.equal(terms[0].status, 'expired')
      assert.equal(terms[1].status, 'open')
      assert.equal((await payments.checkout(order.id, order.userId)).attemptId, renewed.attemptId)
    },
  )
  await check(
    'All six matching-first reservations fulfill only after six verified paid orders',
    async () => {
      for (const order of fixture.orders.slice(1)) {
        const result = await payments.checkout(order.id, order.userId)
        await control('/__fixture/control', { action: 'pay', sessionId: result.sessionId })
      }
      await query('kma', `update public.managed_checkout_orders set next_reconcile_at=now()`)
      await drainWorker(
        async () =>
          (await count('speaksix', 'marathon_payment_captures')) === 6 &&
          (await count('kma', 'managed_checkout_outbox', "state<>'delivered'")) === 0,
      )
      assert.equal(await count('speaksix', 'marathon_payment_captures'), 6)
      assert.equal(await count('speaksix', 'marathon_entitlements'), 216)
      assert.equal(await count('speaksix', 'marathon_cohorts', "status='confirmed'"), 1)
      await fixture.rpc('kma', 'process_external_commissions', { p_limit: 100 })
      assert.equal(await count('kma', 'external_commission_ledger', "kind='earned'"), 6)
    },
  )
  await check(
    'Cancellation refund recovers a lost response and reverses commission once',
    async () => {
      const cohort = await query(
        'speaksix',
        `select cohort_id from public.marathon_orders where id=${literal(first.id)}`,
      )
      await query(
        'speaksix',
        `begin;set local role authenticated;do $$begin perform set_config('request.jwt.claims','{"sub":"fa520000-0000-4000-8000-000000000001","role":"authenticated"}',true);end $$;select public.marathon_cancel_cohort(${literal(cohort)},'Synthetic cross-app cancellation');commit;`,
      )
      const capture = await query(
        'speaksix',
        `select id from public.marathon_payment_captures where order_id=${literal(first.id)}`,
      )
      await control('/__fixture/control', { action: 'lose-refund' })
      await assert.rejects(payments.refundCapture(capture))
      const result = await payments.refundCapture(capture)
      assert.equal(result.refunded, true)
      const state = await control('/__fixture/state')
      assert.equal(state.refunds.length, 1)
      assert.equal(state.calls.filter((c) => c.path === 'refunds' && c.method === 'POST').length, 1)
      await query(
        'kma',
        `update public.managed_checkout_orders set next_reconcile_at=now();update public.managed_checkout_outbox set next_attempt_at=now()`,
      )
      await drainWorker(
        async () => (await count('kma', 'managed_checkout_outbox', "state<>'delivered'")) === 0,
      )
      await fixture.rpc('kma', 'process_external_commissions', { p_limit: 100 })
      assert.equal(await count('speaksix', 'marathon_payment_captures', "status='refunded'"), 1)
      assert.equal(await count('speaksix', 'marathon_entitlements', "status='cancelled'"), 216)
      assert.equal(await count('kma', 'external_commission_ledger', "kind='reversed'"), 1)
      await payments.refundCapture(capture)
      await fixture.rpc('kma', 'process_external_commissions', { p_limit: 100 })
      assert.equal(await count('kma', 'external_commission_ledger', "kind='reversed'"), 1)
      assert.equal(await count('kma', 'external_settlement_jobs'), 0)
      if (merchantDirect) {
        const provider = await control('/__fixture/state')
        assert.equal(provider.fees.length, 6)
        assert.equal(provider.feeRefunds.length, 1)
        assert.equal(provider.feeRefunds[0].amount, 4225)
        assert.ok(
          provider.calls
            .filter((c) => c.method === 'POST' && c.path === 'checkout/sessions')
            .every((c) => c.account === fixtureIds.account),
        )
        assert.ok(
          provider.calls
            .filter((c) => c.path.startsWith('application_fees/'))
            .every((c) => c.account === null),
        )
        assert.equal(
          await count('kma', 'managed_application_fee_refunds', 'completed_at is not null'),
          1,
        )
      }
    },
  )
  await check(
    'Pay-first intake purchase crosses both real schemas without a registration or cohort',
    async () => {
      const intakeId = crypto.randomUUID(),
        scopeHash = 'c'.repeat(64)
      await query(
        'speaksix',
        `insert into public.marathon_intakes(id,title,start_date,end_date,timezone,enrollment_closes_at,months,weeks,lessons,capacity,invitation_hours,price_cents,currency,status,pay_first,kma_product_id,kma_funnel_id,kma_offer_key,kma_offer_version)
      values(${literal(intakeId)},'Cross-app pay-first programme',current_date+30,current_date+120,'UTC',now()+interval '29 days',3,12,36,6,48,16900,'USD','open',true,${literal(fixtureIds.product)},${literal(fixtureIds.funnel)},'marathon',2)`,
      )
      const prepared = await fixture.rpc('speaksix', 'marathon_prepare_purchase', {
        intake: intakeId,
        request_key: crypto.randomUUID(),
        verified_user: null,
        customer_email: 'payfirst-crossapp@example.invalid',
        customer_name: 'Synthetic pay-first buyer',
        guest_scope_hash: scopeHash,
        source: {},
      })
      if (prepared.error) throw Error(prepared.error.message)
      const orderId = prepared.data
      const opened = await payments.checkout(orderId, orderId)
      const route = await managed.route(orderId)
      assert.equal(route.offerVersion, 2)
      const context = JSON.parse(
        await query(
          'kma',
          `select context::text from public.managed_checkout_orders where external_order_id=${literal(orderId)}`,
        ),
      )
      assert.equal(context.purchase_id, orderId)
      assert.equal(context.intake_id, intakeId)
      assert.equal(context.terms_hash.length, 64)
      assert.equal('cohort_id' in context, false)
      await control('/__fixture/control', { action: 'pay', sessionId: opened.sessionId })
      await query(
        'kma',
        `update public.managed_checkout_orders set next_reconcile_at=now() where external_order_id=${literal(orderId)}`,
      )
      await drainWorker(
        async () =>
          (await count('speaksix', 'marathon_payment_captures', `order_id=${literal(orderId)}`)) ===
            1 && (await count('kma', 'managed_checkout_outbox', "state<>'delivered'")) === 0,
      )
      const purchased = JSON.parse(
        await query(
          'speaksix',
          `select jsonb_build_object('status',status,'registration',registration_id,'cohort',cohort_id)::text from public.marathon_orders where id=${literal(orderId)}`,
        ),
      )
      assert.deepEqual(purchased, { status: 'paid', registration: null, cohort: null })
      assert.equal(
        await count('speaksix', 'marathon_payment_captures', `order_id=${literal(orderId)}`),
        1,
      )
      const event = callbacks
        .map((item) => JSON.parse(item.body))
        .find((item) => item.order.external_order_id === orderId)
      assert(event, 'The signed KMA callback reaches the new intake purchase')
      const capture = await query(
        'speaksix',
        `select id from public.marathon_payment_captures where order_id=${literal(orderId)}`,
      )
      await assert.rejects(
        payments.refundCapture(capture),
        /persistence failed/,
        'A paid purchase alone is not a refund instruction',
      )
      // Fixture-only business cancellation: the refund worker consumes this obligation.
      await query(
        'speaksix',
        `update public.marathon_orders set status='refund_required' where id=${literal(orderId)}`,
      )
      await payments.refundCapture(capture)
      await query(
        'kma',
        `update public.managed_checkout_orders set next_reconcile_at=now() where external_order_id=${literal(orderId)};update public.managed_checkout_outbox set next_attempt_at=now()`,
      )
      await drainWorker(
        async () => (await count('kma', 'managed_checkout_outbox', "state<>'delivered'")) === 0,
      )
      assert.equal(
        await query(
          'speaksix',
          `select status from public.marathon_orders where id=${literal(orderId)}`,
        ),
        'refunded',
      )
    },
  )
  await writeFile(
    join(fixture.directory, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        migrations: fixture.migrations,
        boundary:
          'Actual KMA HTTP/service/worker and both PostgreSQL schemas; actual SpeakSix Node adapter accepts callbacks with sales disabled and no outbound checkout credentials. Stripe transport and callbacks run only in isolated local fixtures. No live Stripe, email, bank transfer or deployment.',
      },
      null,
      2,
    ),
  )
  console.log(
    `PASS ${checks.length} cross-app acceptance checks. Evidence: ${fixture.directory}/result.json`,
  )
} catch (error) {
  failed = error
  console.error(error)
  if (fixture)
    await writeFile(
      join(fixture.directory, 'result.json'),
      JSON.stringify({ passed: false, checks, error: error.stack }, null, 2),
    )
} finally {
  if (deno) {
    const exited = once(deno, 'exit').catch(() => {})
    deno.kill()
    await exited
  }
  if (server) await new Promise((resolve) => server.close(resolve))
  if (fixture) await fixture.stop()
}
if (failed) process.exitCode = 1
