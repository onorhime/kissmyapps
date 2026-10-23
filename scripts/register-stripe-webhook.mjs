// One-time dedicated endpoint registration. No payments, checkout, customers,
// coupons, account defaults or existing endpoints are changed. Keys stay in RAM.
import { execFileSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const project = 'mmyruzjemjecqyivhrgr'
const endpoint = `https://${project}.supabase.co/functions/v1/stripe-webhook`
const apiVersion = '2026-02-25.clover'
const events = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'refund.created',
  'refund.updated',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
]
const output = resolve(root, '.cache/release-backups/20260906-stripe-webhook-ownership')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

class SetupError extends Error {}

async function hiddenKey() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode)
    throw new SetupError('Run in an interactive Terminal; do not put the key in command arguments.')
  process.stdout.write('Paste the existing Stripe live key (hidden), then press Enter: ')
  return await new Promise((resolveKey, reject) => {
    let key = ''
    const clean = () => {
      process.stdin.off('data', receive)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
    }
    const receive = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') {
          clean()
          reject(new SetupError('Cancelled'))
          return
        }
        if (char === '\r' || char === '\n') {
          clean()
          resolveKey(key.trim())
          return
        }
        if (char === '\u007f' || char === '\b') key = key.slice(0, -1)
        else if (/^[A-Za-z0-9_]$/.test(char)) key += char
        else if (char.trim()) {
          clean()
          reject(new SetupError('Key contains unsupported characters'))
          return
        }
        if (key.length > 512) {
          clean()
          reject(new SetupError('Key is too long'))
          return
        }
      }
    }
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', receive)
  })
}

let phase = 'preflight'
let createdEndpointId = null
try {
  const mode = process.argv[2]
  if (!['--check', '--create-approved'].includes(mode))
    throw new SetupError(
      'Use --check (read-only) or --create-approved (registers this one dedicated webhook).',
    )
  const key = await hiddenKey()
  if (!/^(rk|sk)_live_[A-Za-z0-9_]{16,480}$/.test(key))
    throw new SetupError('A live server key is required. No key was saved.')
  // Existing CLI credential, kept in memory. Never read another app's secrets.
  const stored =
    process.env.SUPABASE_ACCESS_TOKEN ||
    execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000 },
    ).trim()
  const token = stored.startsWith('go-keyring-base64:')
    ? Buffer.from(stored.slice('go-keyring-base64:'.length), 'base64').toString('utf8')
    : stored
  const supabase = async (path, body) => {
    const response = await fetch(`https://api.supabase.com/v1/projects/${project}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new SetupError(`Supabase control-plane HTTP ${response.status}`)
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }
  const stripe = async (path, body) => {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'Stripe-Version': apiVersion,
        ...(body
          ? {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Idempotency-Key': `kma-${project}-webhook-20260906-v1`,
            }
          : {}),
      },
      body,
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      // Do not print Stripe bodies, which can include customer/key information.
      throw new SetupError(
        `Stripe HTTP ${response.status}. The key needs BC Learn Price read and Webhook Endpoints read/write permission.`,
      )
    }
    return await response.json()
  }
  const price = await stripe('prices/price_1UCJHDE47mNwFlz1NEFOTxtB')
  if (
    price.livemode !== true ||
    price.product !== 'prod_VCii4guzoryBtZ' ||
    price.unit_amount !== 100 ||
    price.currency !== 'usd'
  )
    throw new SetupError('Wrong Stripe account/price. Nothing created.')
  const before = await stripe('webhook_endpoints?limit=100')
  if (before.object !== 'list' || before.has_more !== false || !Array.isArray(before.data))
    throw new SetupError('Could not inspect all existing destinations safely.')
  const matching = before.data.filter((row) => row.url === endpoint)
  if (matching.length)
    throw new SetupError(
      `The dedicated destination already exists (${matching.map((r) => r.id).join(', ')}). Do not create another. Recover its signing secret in Stripe and save it in Supabase.`,
    )
  const secretsBefore = await supabase('secrets')
  if (
    !Array.isArray(secretsBefore) ||
    secretsBefore.some((s) => s.name === 'STRIPE_WEBHOOK_SECRET')
  )
    throw new SetupError('A webhook secret already exists; investigate before changing it.')
  const functions = await supabase('functions')
  const handler = functions.find((f) => f.slug === 'stripe-webhook')
  if (
    !handler ||
    handler.status !== 'ACTIVE' ||
    handler.ezbr_sha256 !== 'f735bc20e435a82f3b47455acf605c1795cb85fc9ada1d36ce6f564bbb28575b'
  )
    throw new SetupError('Deploy the ownership-protected webhook before registering it.')
  const query = await supabase('database/query', {
    query:
      "select to_regprocedure('public.stripe_webhook_owns_reference(text,text,jsonb)') is not null ready",
  })
  if (!Array.isArray(query) || query[0]?.ready !== true)
    throw new SetupError('Ownership migration is not installed.')
  if (mode === '--check') {
    console.log(
      'Read-only checks passed. No webhook, secret, subscription or charge was created. Write permission is checked only when registering.',
    )
    process.exit(0)
  }
  phase = 'create the dedicated Stripe destination'
  const body = new URLSearchParams({
    url: endpoint,
    api_version: apiVersion,
    connect: 'false',
    description: 'KissMyApps production payments — dedicated, ownership-filtered endpoint',
    'metadata[kma_supabase_project]': project,
  })
  for (const type of events) body.append('enabled_events[]', type)
  const created = await stripe('webhook_endpoints', body)
  createdEndpointId =
    typeof created.id === 'string' && /^we_[A-Za-z0-9]+$/.test(created.id) ? created.id : null
  if (
    !createdEndpointId ||
    !/^we_[A-Za-z0-9]+$/.test(createdEndpointId) ||
    created.url !== endpoint ||
    created.api_version !== apiVersion ||
    created.livemode !== true ||
    created.status !== 'enabled' ||
    JSON.stringify([...created.enabled_events].sort()) !== JSON.stringify([...events].sort()) ||
    typeof created.secret !== 'string' ||
    !/^whsec_[A-Za-z0-9]+$/.test(created.secret)
  )
    throw new SetupError(
      'Endpoint response did not match the requested configuration. Inspect Stripe before retrying.',
    )
  phase = 'save its signing secret only to KissMyApps Supabase'
  await supabase('secrets', [{ name: 'STRIPE_WEBHOOK_SECRET', value: created.secret }])
  const secretsAfter = await supabase('secrets')
  if (
    secretsAfter.find((s) => s.name === 'STRIPE_WEBHOOK_SECRET')?.value !== sha256(created.secret)
  )
    throw new SetupError('Signing-secret digest did not match.')
  if (
    secretsBefore.some((s) => secretsAfter.find((next) => next.name === s.name)?.value !== s.value)
  )
    throw new SetupError('An unrelated secret changed; inspect possible concurrent setup.')
  phase = 'verify endpoint configuration and signature/ignore boundary'
  const after = await stripe('webhook_endpoints?limit=100')
  if (
    after.has_more !== false ||
    before.data.some((old) => {
      const next = after.data.find((row) => row.id === old.id)
      return (
        !next ||
        ['url', 'status', 'api_version', 'enabled_events'].some(
          (field) => JSON.stringify(old[field]) !== JSON.stringify(next[field]),
        )
      )
    })
  )
    throw new SetupError('Existing endpoint state changed; inspect concurrency.')
  // Synthetic SECURITY probe only: impossible foreign session, no financial
  // amount/metadata, must return ignored and must never persist a Stripe fact.
  const probe = JSON.stringify({
    id: 'evt_KmaSetupUnrelatedProbe20260906',
    type: 'checkout.session.completed',
    livemode: true,
    api_version: apiVersion,
    data: { object: { id: 'cs_live_KmaSetupUnrelatedProbe20260906', metadata: {} } },
  })
  const timestamp = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', created.secret).update(`${timestamp}.${probe}`).digest('hex')
  const signed = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${sig}` },
    body: probe,
    signal: AbortSignal.timeout(20_000),
  })
  const signedBody = await signed.json()
  const unsigned = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: probe,
    signal: AbortSignal.timeout(20_000),
  })
  if (signed.status !== 200 || signedBody.ignored !== true || unsigned.status !== 400)
    throw new SetupError('Boundary probe failed. Checkout must stay off.')
  const probeStored = await supabase('database/query', {
    query:
      "select count(*)::integer n from public.provider_events where provider='stripe' and provider_event_id='evt_KmaSetupUnrelatedProbe20260906'",
  })
  if (!Array.isArray(probeStored) || probeStored[0]?.n !== 0)
    throw new SetupError(
      'Security probe was unexpectedly persisted. Keep checkout off and investigate.',
    )
  const report = {
    at: new Date().toISOString(),
    project,
    endpoint,
    stripeEndpointId: createdEndpointId,
    apiVersion,
    enabledEvents: events,
    priorDestinationsUnchanged: true,
    secretDigestMatched: true,
    syntheticSignedUnrelatedProbe: '200 ignored',
    unsignedProbe: unsigned.status,
    realStripeDeliveryVerified: false,
    checkoutEnabledChanged: false,
    subscriptionsCreated: 0,
    chargesCreated: 0,
    plaintextSecretsPersistedLocally: false,
  }
  mkdirSync(output, { recursive: true })
  writeFileSync(resolve(output, 'registration.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  console.log(
    'Dedicated webhook configured. Checkout is still disabled. Real Stripe delivery and workers need separate verification.',
  )
} catch (error) {
  // Error messages are fixed local messages/HTTP status only. Never log raw
  // response bodies, subprocess output, headers, typed keys or signing secrets.
  console.error(
    `Stopped during ${phase}. ${error instanceof SetupError ? error.message : 'Unexpected tool or network failure. Sensitive error details were not printed.'}`,
  )
  if (createdEndpointId)
    console.error(
      `Created endpoint: ${createdEndpointId}. Do not duplicate it; recover its signing secret in Stripe if saving failed.`,
    )
  process.exitCode = 1
}
