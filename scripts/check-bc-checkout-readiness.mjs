// Deploy/invoke only the protected GET-only BC Learn preflight. The Stripe key
// never leaves Supabase; the existing operator credential is used only in RAM.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { priorFunctionBundlesUnchanged, sameFunctionBundle } from './processing-release-guards.mjs'
const project = 'mmyruzjemjecqyivhrgr'
const out = '.cache/release-backups/20260906-checkout-preflight'
const run = (args, input) =>
  execFileSync('pnpm', ['exec', 'supabase', ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  })
const query = (sql) =>
  JSON.parse(
    run(
      [
        'db',
        'query',
        '--linked',
        '--project-ref',
        project,
        '--file',
        '/dev/stdin',
        '--output',
        'json',
      ],
      sql,
    ),
  ).rows
const save = (name, data) => writeFileSync(`${out}/${name}.json`, JSON.stringify(data, null, 2))
const state = () =>
  query(`select jsonb_build_object(
  'checkout_attempts',(select count(*) from public.checkout_attempts),
  'provider_events',(select count(*) from public.provider_events),
  'subscriptions',(select count(*) from public.subscriptions),
  'transactions',(select count(*) from public.transactions),
  'commissions',(select count(*) from public.commission_entries),
  'products',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.products t),
  'offers',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.billing_offers t),
  'agreements',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.agreements t),
  'documents',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.documents t),
  'schedules',(select md5(jsonb_agg(to_jsonb(t) order by jobid)::text) from cron.job t)
) as state`)[0].state
let phase = 'read-only preflight'
try {
  if (!['--deploy-approved', '--refresh-preflight-approved', '--check'].includes(process.argv[2]))
    throw Error('Mode required')
  mkdirSync(out, { recursive: true })
  const before = state()
  if (
    ['checkout_attempts', 'provider_events', 'subscriptions', 'transactions', 'commissions'].some(
      (k) => before[k] !== 0,
    )
  )
    throw Error('Commercial facts exist; inspect before initial readiness check')
  const offer =
    query(`select stripe_price_id,currency,unit_amount_minor,billing_mode from public.billing_offers
    where product_id='fdbabb87-9743-4521-bc8d-11804fe1185f' and key='monthly' and status='active'`)
  if (
    offer.length !== 1 ||
    offer[0].stripe_price_id !== 'price_1UCJHDE47mNwFlz1NEFOTxtB' ||
    offer[0].currency !== 'USD' ||
    offer[0].unit_amount_minor !== 100 ||
    offer[0].billing_mode !== 'subscription'
  )
    throw Error('Offer differs from scoped preflight')
  const stored =
    process.env.SUPABASE_ACCESS_TOKEN ||
    execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 20000,
      },
    ).trim()
  const access = stored.startsWith('go-keyring-base64:')
    ? Buffer.from(stored.slice('go-keyring-base64:'.length), 'base64').toString('utf8')
    : stored
  const api = async (path, body) => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${project}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    })
    if (!r.ok) throw Error('Control-plane failure')
    const text = await r.text()
    return text ? JSON.parse(text) : null
  }
  const beforeFunctions = await api('functions')
  const secretDigests = async () => {
    const rows = await api('secrets')
    if (
      !Array.isArray(rows) ||
      rows.some((s) => typeof s.value !== 'string' || !/^[a-f0-9]{64}$/.test(s.value))
    )
      throw Error('Unexpected secret metadata shape')
    return rows
      .map((s) => ({ name: s.name, digest: s.value }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
  const secretsBefore = await secretDigests()
  if (process.argv[2] !== '--check') {
    const refresh = process.argv[2] === '--refresh-preflight-approved'
    if (!refresh && beforeFunctions.some((f) => f.slug === 'checkout-preflight'))
      throw Error('Already exists; inspect before replacing')
    if (refresh) {
      const previous = JSON.parse(readFileSync(`${out}/deployment.json`, 'utf8'))
      if (
        !sameFunctionBundle(
          previous.function,
          beforeFunctions.find((f) => f.slug === 'checkout-preflight'),
        )
      )
        throw Error('Diagnostic bundle drift')
      save(`preflight-v${previous.function.version}`, previous)
      save(
        `readiness-v${previous.function.version}`,
        JSON.parse(readFileSync(`${out}/readiness.json`, 'utf8')),
      )
      mkdirSync(`${out}/rollback-preflight-v${previous.function.version}`, { recursive: true })
      run([
        'functions',
        'download',
        'checkout-preflight',
        '--project-ref',
        project,
        '--use-api',
        '--workdir',
        `${out}/rollback-preflight-v${previous.function.version}`,
      ])
    }
    save(refresh ? 'before-refresh' : 'before', {
      at: new Date().toISOString(),
      before,
      functions: beforeFunctions,
      secretDigests: secretsBefore,
    })
    phase = 'deploy only protected read-only preflight'
    run([
      'functions',
      'deploy',
      'checkout-preflight',
      '--project-ref',
      project,
      '--no-verify-jwt',
      '--use-api',
    ])
    const afterFunctions = await api('functions')
    if (
      !priorFunctionBundlesUnchanged(
        beforeFunctions.filter((f) => f.slug !== 'checkout-preflight'),
        afterFunctions,
      )
    )
      throw Error('Existing bundle drift')
    save('deployment', {
      at: new Date().toISOString(),
      project,
      function: afterFunctions.find((f) => f.slug === 'checkout-preflight'),
      priorFunctionsUnchanged: true,
    })
  } else {
    const deployed = JSON.parse(readFileSync(`${out}/deployment.json`, 'utf8'))
    if (
      !sameFunctionBundle(
        deployed.function,
        beforeFunctions.find((f) => f.slug === 'checkout-preflight'),
      )
    )
      throw Error('Diagnostic bundle drift')
  }
  phase = 'verify endpoint boundary'
  const endpoint = `https://${project}.supabase.co/functions/v1/checkout-preflight`
  const denied = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(20000),
  })
  await denied.arrayBuffer()
  if (denied.status !== 401) throw Error('Unauthenticated endpoint not denied')
  // This is the scheduler/operator credential, NEVER the Stripe key.
  phase = 'load existing operator credential'
  const credentials = await api('database/query', {
    query:
      "select decrypted_secret as value from vault.decrypted_secrets where name='kma_processing_scheduler'",
  })
  const operator = credentials[0]?.value
  if (typeof operator !== 'string' || operator.length < 32)
    throw Error('Operator credential missing')
  phase = 'verify authenticated parameter rejection'
  const arbitrary = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-kma-scheduler-secret': operator },
    body: '{"url":"https://example.invalid"}',
    signal: AbortSignal.timeout(20000),
  })
  await arbitrary.arrayBuffer()
  if (arbitrary.status !== 400) throw Error('Parameter boundary failed')
  phase = 'live GET-only Stripe readiness'
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-kma-scheduler-secret': operator },
    body: '{}',
    signal: AbortSignal.timeout(25000),
  })
  const result = await response.json()
  const after = state()
  const secretsAfter = await secretDigests()
  const unchanged =
    JSON.stringify(before) === JSON.stringify(after) &&
    JSON.stringify(secretsBefore) === JSON.stringify(secretsAfter)
  const readOnlyPreflightPassed =
    response.status === 200 &&
    unchanged &&
    result.discountReady === true &&
    Object.values(result.checks ?? {}).every((check) =>
      ['retrieved', 'empty_scoped_list', 'missing_resource_not_permission_denied'].includes(
        check.result,
      ),
    )
  const report = {
    at: new Date().toISOString(),
    project,
    httpStatus: response.status,
    unauthorized: denied.status,
    arbitraryInput: arbitrary.status,
    configurationAndFactsUnchanged: unchanged,
    readOnlyPreflightPassed,
    result,
    before,
    after,
  }
  save('readiness', report)
  console.log(JSON.stringify(report))
  if (response.status !== 200 || !unchanged) process.exitCode = 1
  else if (!readOnlyPreflightPassed) process.exitCode = 2
} catch {
  console.error(
    `Stopped during ${phase}. No checkout was requested. Inspect scoped state before retrying.`,
  )
  process.exitCode = 1
}
