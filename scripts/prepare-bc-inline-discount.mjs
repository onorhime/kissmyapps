// Narrow preparation approved on 2026-09-07. Coupon/code were created in the
// Stripe dashboard with one redemption, 100% forever and BC Learn-only scope.
// No Stripe write, Checkout Session, subscription, charge or scheduler action.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { priorFunctionBundlesUnchanged } from './processing-release-guards.mjs'

const project = 'mmyruzjemjecqyivhrgr'
const product = 'fdbabb87-9743-4521-bc8d-11804fe1185f'
const previous = JSON.stringify({ [product]: 'promo_1UCbsJE47mNwFlz1xm9WkRWY' })
const replacement = JSON.stringify({ [product]: 'promo_1UCzV4E47mNwFlz1P3dsXuUT' })
const name = 'FREE_CHECKOUT_PROMOTION_BINDINGS'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
let phase = 'read-only preflight'
try {
  const mode = process.argv[2]
  if (!['--apply-approved', '--verify'].includes(mode)) throw Error('Mode required')
  const stored = execFileSync('/usr/bin/security',
    ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 }).trim()
  const access = stored.startsWith('go-keyring-base64:')
    ? Buffer.from(stored.slice('go-keyring-base64:'.length), 'base64').toString('utf8') : stored
  const api = async (path, body) => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${project}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    })
    if (!r.ok) throw Error('Control-plane request failed')
    const text = await r.text()
    return text ? JSON.parse(text) : null
  }
  const state = async () => (await api('database/query', { query: `select jsonb_build_object(
    'checkout_attempts',(select count(*) from public.checkout_attempts),
    'provider_events',(select count(*) from public.provider_events),
    'subscriptions',(select count(*) from public.subscriptions),
    'transactions',(select count(*) from public.transactions),
    'commissions',(select count(*) from public.commission_entries),
    'products',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.products t),
    'offers',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.billing_offers t),
    'agreements',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.agreements t),
    'documents',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.documents t),
    'schedule',(select to_jsonb(s)-'last_tick_at' from kma_internal.processing_schedule s)
  ) as state` }))[0].state
  const before = await state()
  const secretsBefore = await api('secrets')
  if (!Array.isArray(secretsBefore) || secretsBefore.some(s => !/^[a-f0-9]{64}$/.test(s.value)))
    throw Error('Unexpected secret digest shape')
  const current = secretsBefore.find(s => s.name === name)?.value
  // Fail closed on any extra/unknown product bindings. Never overwrite them.
  if (![sha256(previous), sha256(replacement)].includes(current)) throw Error('Binding drift')
  const functionsBefore = await api('functions')
  if (mode === '--apply-approved') {
    phase = 'connect only the approved BC Learn discount'
    if (current === sha256(previous)) await api('secrets', [{ name, value: replacement }])
    phase = 'update only the protected GET-only diagnostic IDs'
    execFileSync('pnpm', ['exec', 'supabase', 'functions', 'deploy', 'checkout-preflight',
      '--project-ref', project, '--no-verify-jwt', '--use-api'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 })
  }
  const functionsAfter = await api('functions')
  if (!priorFunctionBundlesUnchanged(functionsBefore.filter(f => f.slug !== 'checkout-preflight'), functionsAfter))
    throw Error('Unrelated function drift')
  const secretsAfter = await api('secrets')
  if (secretsAfter.find(s => s.name === name)?.value !== sha256(replacement) ||
    secretsAfter.length !== secretsBefore.length ||
    secretsBefore.some(s => s.name !== name && secretsAfter.find(a => a.name === s.name)?.value !== s.value))
    throw Error('Secret preservation mismatch')
  phase = 'read-only live Stripe verification'
  const credentials = await api('database/query', {
    query: "select decrypted_secret as value from vault.decrypted_secrets where name='kma_processing_scheduler'",
  })
  const operator = credentials[0]?.value
  if (typeof operator !== 'string' || operator.length < 32) throw Error('Missing operator credential')
  const endpoint = `https://${project}.supabase.co/functions/v1/checkout-preflight`
  const invoke = async (body, authenticated) => {
    const r = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(authenticated ? { 'x-kma-scheduler-secret': operator } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    })
    return { status: r.status, body: await r.json() }
  }
  const unauthorized = await invoke({}, false)
  const arbitrary = await invoke({ url: 'https://example.invalid' }, true)
  if (unauthorized.status !== 401 || arbitrary.status !== 400) throw Error('Diagnostic auth boundary')
  const live = await invoke({}, true)
  const after = await state()
  const factsAndConfigurationUnchanged = JSON.stringify(before) === JSON.stringify(after)
  const verified = live.status === 200 && live.body.discountReady === true &&
    factsAndConfigurationUnchanged
  console.log(JSON.stringify({ at: new Date().toISOString(), project,
    code: 'BCLEARN-INLINE-SEP07', coupon: 'Kc9faGnA', promotion: 'promo_1UCzV4E47mNwFlz1P3dsXuUT',
    verified, unauthorized: unauthorized.status, arbitraryInput: arbitrary.status,
    priorSecretsPreserved: true, priorFunctionsPreserved: true, factsAndConfigurationUnchanged,
    checkoutCalled: false, schedulerChanged: false, before, after, readiness: live.body }))
  if (!verified) process.exitCode = 1
} catch {
  console.error(`Stopped during ${phase}; no Checkout was requested. Inspect before retrying.`)
  process.exitCode = 1
}
