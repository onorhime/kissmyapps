import { createSignedRequest, type FunnelSigningConfiguration } from './server-events.ts'
import { isPaywallOffer } from './checkout-contract.ts'

export interface FunnelProxyConfiguration {
  origin: string
  backendBaseUrl: string
  signing: FunnelSigningConfiguration
  offerKey: string
  checkoutEnabled: boolean
  requireNoPayment?: boolean
  uiMode?: 'hosted' | 'embedded'
  /** Public Stripe key for the same account as the backend live key. */
  stripePublishableKey?: string
  fetcher?: typeof fetch
  /** Bounded operational codes only. Never receives headers, bodies or secrets. */
  diagnostic?: (entry: { stage: string; category: string }) => void
}

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/
const ATTEMPT = /^[A-Za-z0-9_-]{32,128}$/
const SESSION = /^cs_live_[A-Za-z0-9_]{8,160}$/
const OFFER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const COOKIE = 'kma_checkout_receipt'
const QUOTE_COOKIE = 'kma_checkout_quote'
const COOKIE_SECONDS = 2 * 24 * 60 * 60
const encoder = new TextEncoder()
class ProxyError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  })
}

async function body(
  request: Request,
  keys: readonly string[],
  optional: readonly string[] = [],
): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new ProxyError(415, 'json_required')
  }
  const reader = request.body?.getReader()
  if (!reader) throw new ProxyError(400, 'invalid_request')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > 4096) {
      await reader.cancel()
      throw new ProxyError(413, 'request_too_large')
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ProxyError(400, 'invalid_request')
  }
  if (
    !object(value) ||
    Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key)) ||
    keys.some((key) => !(key in value))
  )
    throw new ProxyError(400, 'invalid_request')
  return value
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
function decode64(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  )
}

/** Thin same-origin adapter. Stripe credentials, prices and attribution stay upstream. */
export function createFunnelCheckoutProxy(config: FunnelProxyConfiguration) {
  const origin = new URL(config.origin)
  const local =
    origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  const backend = new URL(config.backendBaseUrl)
  if (
    (!local && origin.protocol !== 'https:') ||
    origin.origin !== config.origin ||
    backend.protocol !== 'https:' ||
    backend.username ||
    backend.password ||
    backend.search ||
    backend.hash ||
    !OFFER.test(config.offerKey) ||
    config.signing.secret.length < 32
  )
    throw new Error('invalid_proxy_configuration')
  const embedded = config.uiMode === 'embedded'
  if (embedded && !/^pk_live_[A-Za-z0-9_]{16,256}$/.test(config.stripePublishableKey ?? ''))
    throw new Error('invalid_publishable_key')

  const upstream = async (endpoint: string, payload: unknown, nonce?: string) => {
    const signed = await createSignedRequest({
      endpoint: `${config.backendBaseUrl.replace(/\/$/, '')}/${endpoint}`,
      signing: config.signing,
      body: payload,
      nonce,
    }).catch((error: unknown) => {
      config.diagnostic?.({ stage: 'sign_request', category: 'signing_failure' })
      throw error
    })
    let response: Response
    try {
      response = await (config.fetcher ?? fetch)(signed.endpoint, {
        method: 'POST',
        headers: signed.headers,
        body: signed.body,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      })
    } catch (error) {
      config.diagnostic?.({
        stage: 'fetch_backend',
        category:
          typeof AbortSignal.timeout !== 'function'
            ? 'timeout_api_unavailable'
            : error instanceof Error && error.name === 'TimeoutError'
              ? 'timeout'
              : 'transport_failure',
      })
      throw error
    }
    let result: unknown
    try {
      result = await response.json()
    } catch {
      throw new ProxyError(502, 'backend_unavailable')
    }
    if (!response.ok) {
      const safeCodes = [
        'free_discount_unavailable',
        'no_charge_required',
        'click_unavailable',
        'scope_rejected',
        'checkout_rejected',
        'not_found',
        'rate_limited',
        'offer_changed',
        'offer_unavailable',
      ]
      const code =
        object(result) && safeCodes.includes(String(result.error))
          ? String(result.error)
          : 'checkout_unavailable'
      throw new ProxyError(
        [400, 403, 404, 409, 429, 503].includes(response.status) ? response.status : 502,
        code,
      )
    }
    if (!object(result)) throw new ProxyError(502, 'invalid_backend_response')
    return result
  }
  const wrap = (action: (request: Request) => Promise<Response>) => async (request: Request) => {
    try {
      if (request.method !== 'POST') throw new ProxyError(405, 'method_not_allowed')
      if (
        request.headers.get('origin') !== config.origin ||
        (request.headers.get('sec-fetch-site') &&
          request.headers.get('sec-fetch-site') !== 'same-origin')
      ) {
        throw new ProxyError(403, 'origin_not_allowed')
      }
      return await action(request)
    } catch (error) {
      return json(error instanceof ProxyError ? error.status : 503, {
        error: error instanceof ProxyError ? error.code : 'backend_unavailable',
      })
    }
  }
  const clickInput = (value: unknown): string => {
    if (typeof value !== 'string' || !TOKEN.test(value))
      throw new ProxyError(400, 'missing_attribution')
    return value
  }
  return {
    offer: wrap(async (request) => {
      const input = await body(request, ['click_id'])
      const result = await upstream('funnel-checkout-context', {
        action: 'offer',
        click_id: clickInput(input.click_id),
        offer_key: config.offerKey,
      })
      if (!isPaywallOffer(result.offer) || result.offer.key !== config.offerKey)
        throw new ProxyError(502, 'invalid_backend_response')
      const claim = base64url(
        encoder.encode(
          JSON.stringify({
            click_id: input.click_id,
            offer_key: config.offerKey,
            version: result.offer.version,
            expires: Math.floor(Date.now() / 1000) + 900,
          }),
        ),
      )
      const signature = base64url(
        new Uint8Array(
          await crypto.subtle.sign(
            'HMAC',
            await signingKey(config.signing.secret),
            encoder.encode(`kma-quote-v1.${claim}`),
          ),
        ),
      )
      return json(
        200,
        { offer: result.offer, checkout_enabled: config.checkoutEnabled },
        {
          'Set-Cookie': `${QUOTE_COOKIE}=${claim}.${signature}; Path=/api/partner; Max-Age=900; HttpOnly; SameSite=Lax${local ? '' : '; Secure'}`,
        },
      )
    }),
    checkout: wrap(async (request) => {
      const input = await body(request, ['click_id', 'offer_key'], ['customer_email'])
      if (
        (embedded && !input.customer_email) ||
        ('customer_email' in input &&
          (typeof input.customer_email !== 'string' ||
            input.customer_email.length > 254 ||
            !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.customer_email)))
      )
        throw new ProxyError(400, 'invalid_email')
      const clickId = clickInput(input.click_id)
      if (input.offer_key !== config.offerKey) throw new ProxyError(400, 'invalid_offer')
      const nonce = request.headers.get('idempotency-key') ?? ''
      if (!TOKEN.test(nonce)) throw new ProxyError(400, 'idempotency_key_required')
      if (!config.checkoutEnabled) throw new ProxyError(503, 'checkout_not_enabled')
      const rawQuote = request.headers
        .get('cookie')
        ?.split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(`${QUOTE_COOKIE}=`))
        ?.slice(QUOTE_COOKIE.length + 1)
      let version: number
      try {
        if (!rawQuote || rawQuote.length > 2048) throw new Error()
        const [encoded, signature, extra] = rawQuote.split('.')
        if (
          !encoded ||
          !signature ||
          extra ||
          !(await crypto.subtle.verify(
            'HMAC',
            await signingKey(config.signing.secret),
            Uint8Array.from(decode64(signature)).buffer,
            encoder.encode(`kma-quote-v1.${encoded}`),
          ))
        )
          throw new Error()
        const quote: unknown = JSON.parse(new TextDecoder().decode(decode64(encoded)))
        if (
          !object(quote) ||
          quote.click_id !== clickId ||
          quote.offer_key !== config.offerKey ||
          typeof quote.expires !== 'number' ||
          quote.expires <= Date.now() / 1000 ||
          quote.expires > Date.now() / 1000 + 960 ||
          !Number.isSafeInteger(quote.version) ||
          Number(quote.version) < 1
        )
          throw new Error()
        version = Number(quote.version)
      } catch {
        throw new ProxyError(409, 'offer_review_required')
      }
      const receipt = await upstream(
        'checkout-session',
        {
          click_id: clickId,
          offer_key: config.offerKey,
          offer_version: version,
          ...(config.uiMode ? { ui_mode: config.uiMode } : {}),
          ...(input.customer_email ? { customer_email: input.customer_email } : {}),
          ...(config.requireNoPayment ? { require_no_payment: true } : {}),
        },
        nonce,
      )
      let target: URL | null = null
      try {
        if (!embedded) target = new URL(String(receipt.checkout_url))
      } catch {
        throw new ProxyError(502, 'invalid_backend_response')
      }
      if (
        (!embedded &&
          (!target ||
            target.origin !== 'https://checkout.stripe.com' ||
            target.username ||
            target.password)) ||
        (embedded &&
          (receipt.ui_mode !== 'embedded' ||
            receipt.checkout_url !== null ||
            typeof receipt.session_id !== 'string' ||
            !SESSION.test(receipt.session_id) ||
            typeof receipt.client_secret !== 'string' ||
            receipt.client_secret.length > 512 ||
            !receipt.client_secret.startsWith(`${receipt.session_id}_secret_`))) ||
        typeof receipt.attempt_id !== 'string' ||
        !ATTEMPT.test(receipt.attempt_id) ||
        typeof receipt.expires_at !== 'string' ||
        !Number.isFinite(Date.parse(receipt.expires_at)) ||
        typeof receipt.request_id !== 'string'
      )
        throw new ProxyError(502, 'invalid_backend_response')
      const claim = base64url(
        encoder.encode(
          JSON.stringify({
            click_id: clickId,
            attempt_id: receipt.attempt_id,
            ...(embedded ? { session_id: receipt.session_id } : {}),
            expires: Math.floor(Date.now() / 1000) + COOKIE_SECONDS,
          }),
        ),
      )
      const signature = base64url(
        new Uint8Array(
          await crypto.subtle.sign(
            'HMAC',
            await signingKey(config.signing.secret),
            encoder.encode(`kma-receipt-v1.${claim}`),
          ),
        ),
      )
      return json(
        200,
        {
          checkout_url: target?.toString() ?? null,
          ...(embedded
            ? {
                ui_mode: 'embedded',
                client_secret: receipt.client_secret,
                session_id: receipt.session_id,
                publishable_key: config.stripePublishableKey,
              }
            : {}),
          attempt_id: receipt.attempt_id,
          expires_at: receipt.expires_at,
          request_id: receipt.request_id,
        },
        {
          'Set-Cookie': `${COOKIE}=${claim}.${signature}; Path=/api/partner; Max-Age=${COOKIE_SECONDS}; HttpOnly; SameSite=Lax${local ? '' : '; Secure'}`,
        },
      )
    }),
    status: wrap(async (request) => {
      const input = await body(request, ['session_id'])
      if (typeof input.session_id !== 'string' || !SESSION.test(input.session_id))
        throw new ProxyError(400, 'invalid_session')
      const raw = request.headers
        .get('cookie')
        ?.split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(`${COOKIE}=`))
        ?.slice(COOKIE.length + 1)
      if (!raw || raw.length > 2048) throw new ProxyError(403, 'receipt_unavailable')
      let claim: Record<string, unknown>
      try {
        const [encoded, signature, extra] = raw.split('.')
        if (
          !encoded ||
          !signature ||
          extra ||
          !(await crypto.subtle.verify(
            'HMAC',
            await signingKey(config.signing.secret),
            Uint8Array.from(decode64(signature)).buffer,
            encoder.encode(`kma-receipt-v1.${encoded}`),
          ))
        )
          throw new Error()
        const decoded: unknown = JSON.parse(new TextDecoder().decode(decode64(encoded)))
        if (
          !object(decoded) ||
          typeof decoded.expires !== 'number' ||
          decoded.expires <= Date.now() / 1000 ||
          decoded.expires > Date.now() / 1000 + COOKIE_SECONDS + 60 ||
          typeof decoded.attempt_id !== 'string' ||
          !ATTEMPT.test(decoded.attempt_id)
        )
          throw new Error()
        claim = decoded
      } catch {
        throw new ProxyError(403, 'receipt_unavailable')
      }
      if (claim.session_id && claim.session_id !== input.session_id)
        throw new ProxyError(403, 'receipt_unavailable')
      const result = await upstream('funnel-checkout-context', {
        action: 'status',
        click_id: clickInput(claim.click_id),
        attempt_id: claim.attempt_id,
        session_id: input.session_id,
      })
      if (
        !['pending', 'paid', 'no_payment_required', 'expired', 'failed'].includes(
          String(result.status),
        ) ||
        typeof result.request_id !== 'string'
      )
        throw new ProxyError(502, 'invalid_backend_response')
      return json(200, { status: result.status, request_id: result.request_id })
    }),
  }
}
