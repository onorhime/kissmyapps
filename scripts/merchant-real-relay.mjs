/** Loopback TEST adapter: authenticates Stripe CLI before scope-specific local forwarding. */
import { createHmac, timingSafeEqual } from 'node:crypto'
export async function relayStripeCli(request, options) {
  const scope = new URL(request.url).pathname.slice(1)
  if (request.method !== 'POST' || !['platform', 'connected'].includes(scope))
    return Response.json({ error: 'Unsupported local relay route.' }, { status: 404 })
  const cliSecret = options.cliSecrets[scope],
    localSecret = options.localSecrets[scope]
  if (!cliSecret || !localSecret)
    return Response.json({ error: 'Local relay signing is not ready.' }, { status: 503 })
  const raw = new Uint8Array(await request.arrayBuffer())
  if (raw.length > 512 * 1024) return Response.json({ error: 'Event too large.' }, { status: 413 })
  const parts = (request.headers.get('stripe-signature') ?? '')
    .split(',')
    .map((v) => v.trim().split('='))
  const timestamp = parts.find(([k]) => k === 't')?.[1] ?? ''
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000)
  if (!/^\d{10,12}$/.test(timestamp) || Math.abs(Number(timestamp) - now) > 300)
    return Response.json({ error: 'Stripe CLI signature rejected.' }, { status: 400 })
  const expected = createHmac('sha256', cliSecret)
    .update(timestamp + '.')
    .update(raw)
    .digest()
  const valid = signatures.some(
    (v) => /^[a-f0-9]{64}$/.test(v ?? '') && timingSafeEqual(Buffer.from(v, 'hex'), expected),
  )
  if (!valid) return Response.json({ error: 'Stripe CLI signature rejected.' }, { status: 400 })
  let event
  try {
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    return Response.json({ error: 'Malformed signed event.' }, { status: 400 })
  }
  if (
    event.livemode !== false ||
    !/^evt_[A-Za-z0-9_]+$/.test(event.id ?? '') ||
    typeof event.type !== 'string' ||
    (scope === 'platform'
      ? event.account != null
      : !/^acct_[A-Za-z0-9]+$/.test(event.account ?? ''))
  )
    return Response.json({ error: 'Signed event scope rejected.' }, { status: 409 })
  const localSignature = createHmac('sha256', localSecret)
    .update(now + '.')
    .update(raw)
    .digest('hex')
  const response = await options.forward(raw, {
    'content-type': 'application/json',
    'stripe-signature': `t=${now},v1=${localSignature}`,
  })
  options.record?.({
    id: event.id,
    type: event.type,
    account: event.account ?? null,
    scope,
    cliSignatureVerified: true,
    forwardedStatus: response.status,
    signingBoundary:
      'Real Stripe CLI signature verified; unchanged payload re-signed using a local scope secret.',
  })
  return response
}
