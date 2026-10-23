import { webcrypto } from 'node:crypto'
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createFunnelCheckoutProxy } from './checkout-proxy.ts'
import { isPaywallOffer } from './checkout-contract.ts'

const origin = 'https://funnel.example'
const click = 'c'.repeat(48)
const attempt = 'a'.repeat(48)
const session = 'cs_live_fixture123456789'
const offer = {
  key: 'monthly',
  version: 1,
  name: 'Test monthly',
  currency: 'USD',
  unit_amount_minor: 100,
  billing_mode: 'subscription',
  interval: 'month',
  interval_count: 1,
}
const receipt = {
  checkout_url: 'https://checkout.stripe.com/c/pay/fixture',
  attempt_id: attempt,
  expires_at: '2027-01-01T00:00:00Z',
  request_id: 'request',
}
function request(action: string, payload: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/partner/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: JSON.stringify(payload),
  })
}
function fixture(enabled = true, requireNoPayment = false) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.action === 'offer') return Response.json({ offer, request_id: 'request' })
    if (body.action === 'status')
      return Response.json({
        status: 'pending',
        request_id: 'request',
        email: 'never-forward@example.invalid',
      })
    return Response.json(receipt, { status: 201 })
  })
  const proxy = createFunnelCheckoutProxy({
    origin,
    backendBaseUrl: 'https://backend.example/functions/v1',
    offerKey: 'monthly',
    signing: { keyId: 'fixture', secret: 'not-a-real-secret-only-unit-test-fixture' },
    checkoutEnabled: enabled,
    requireNoPayment,
    fetcher: fetcher as typeof fetch,
  })
  const quote = async () =>
    (await proxy.offer(request('offer', { click_id: click }))).headers
      .get('set-cookie')!
      .split(';')[0]
  const pay = async () =>
    proxy.checkout(
      request(
        'checkout',
        { click_id: click, offer_key: 'monthly' },
        { cookie: await quote(), 'idempotency-key': 'logical_attempt_000001' },
      ),
    )
  return { proxy, fetcher, quote, pay }
}
const originalCrypto = globalThis.crypto
beforeAll(() => vi.stubGlobal('crypto', webcrypto))
afterAll(() => vi.stubGlobal('crypto', originalCrypto))
afterEach(() => vi.restoreAllMocks())

describe('funnel checkout adapter contract', () => {
  it('only the server opts into no-charge checkout; browser overrides are rejected', async () => {
    const { proxy, fetcher, pay, quote } = fixture(true, true)
    expect((await pay()).status).toBe(200)
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body)).require_no_payment).toBe(true)
    expect(
      (
        await proxy.checkout(
          request(
            'checkout',
            { click_id: click, offer_key: 'monthly', require_no_payment: false },
            { cookie: await quote(), 'idempotency-key': 'logical_attempt_000001' },
          ),
        )
      ).status,
    ).toBe(400)
  })
  it('validates real subscription descriptors without coercion', () => {
    expect(isPaywallOffer(offer)).toBe(true)
    for (const change of [
      { version: 0 },
      { currency: 'usd' },
      { unit_amount_minor: '100' },
      { interval: 'minute' },
      { interval_count: 0 },
      { billing_mode: 'payment' },
      { private_email: 'never-forward@example.invalid' },
    ]) {
      expect(isPaywallOffer({ ...offer, ...change })).toBe(false)
    }
  })
  it('rejects absent, hostile and cross-site origins before upstream', async () => {
    const { proxy, fetcher } = fixture()
    const headerCases: Record<string, string>[] = [
      { origin: '' },
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
    ]
    for (const headers of headerCases) {
      expect((await proxy.offer(request('offer', { click_id: click }, headers))).status).toBe(403)
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects wrong methods, extra fields, malformed identifiers and oversized bodies', async () => {
    const { proxy, fetcher } = fixture()
    expect((await proxy.offer(new Request(origin))).status).toBe(405)
    for (const value of [{ click_id: click, price: 1 }, { click_id: 'bad' }, null]) {
      expect((await proxy.offer(request('offer', value))).status).toBe(400)
    }
    expect((await proxy.offer(request('offer', { click_id: 'a'.repeat(5000) }))).status).toBe(413)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('requires enabled checkout and a same-click signed reviewed offer', async () => {
    const { proxy, fetcher } = fixture()
    const headers = { 'idempotency-key': 'logical_attempt_000001' }
    const missing = await proxy.checkout(
      request('checkout', { click_id: click, offer_key: 'monthly' }, headers),
    )
    expect(await missing.json()).toEqual({ error: 'offer_review_required' })
    const { pay } = fixture(false)
    expect(await (await pay()).json()).toEqual({ error: 'checkout_not_enabled' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('quotes prices in signed HttpOnly cookies and binds checkout to the displayed version', async () => {
    const { proxy, quote, fetcher } = fixture()
    const cookie = await quote()
    const response = await proxy.checkout(
      request(
        'checkout',
        { click_id: click, offer_key: 'monthly' },
        { cookie, 'idempotency-key': 'logical_attempt_000001' },
      ),
    )
    expect(response.status).toBe(200)
    const init = fetcher.mock.calls[1][1]!
    expect(JSON.parse(String(init.body))).toEqual({
      click_id: click,
      offer_key: 'monthly',
      offer_version: 1,
    })
    expect(new Headers(init.headers).get('x-kma-nonce')).toBe('logical_attempt_000001')
    expect(new Headers(init.headers).get('x-kma-signature')).toMatch(/^[a-f0-9]{64}$/)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax; Secure')
    expect(response.headers.get('set-cookie')).toContain('Path=/api/partner')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
  it('rejects tampered, expired and different-click quotes', async () => {
    const { proxy, quote, fetcher } = fixture()
    const cookie = await quote()
    for (const [value, header] of [
      [click, `${cookie}x`],
      ['d'.repeat(48), cookie],
    ]) {
      expect(
        (
          await proxy.checkout(
            request(
              'checkout',
              { click_id: value, offer_key: 'monthly' },
              { cookie: header, 'idempotency-key': 'logical_attempt_000001' },
            ),
          )
        ).status,
      ).toBe(409)
    }
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901000)
    expect(
      (
        await proxy.checkout(
          request(
            'checkout',
            { click_id: click, offer_key: 'monthly' },
            { cookie, 'idempotency-key': 'logical_attempt_000001' },
          ),
        )
      ).status,
    ).toBe(409)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('preserves the logical nonce when checkout is retried', async () => {
    const { pay, fetcher } = fixture()
    await pay()
    await pay()
    const attempts = fetcher.mock.calls.filter((call) =>
      String(call[0]).endsWith('checkout-session'),
    )
    expect(attempts).toHaveLength(2)
    expect(new Headers(attempts[0][1]!.headers).get('x-kma-nonce')).toBe(
      new Headers(attempts[1][1]!.headers).get('x-kma-nonce'),
    )
  })
  it('refuses arbitrary checkout redirects and does not leak provider messages', async () => {
    const { proxy, quote, fetcher } = fixture()
    const cookie = await quote()
    fetcher.mockResolvedValueOnce(
      Response.json({ ...receipt, checkout_url: 'https://evil.example' }),
    )
    const make = () =>
      request(
        'checkout',
        { click_id: click, offer_key: 'monthly' },
        { cookie, 'idempotency-key': 'logical_attempt_000001' },
      )
    expect(await (await proxy.checkout(make())).json()).toEqual({
      error: 'invalid_backend_response',
    })
    fetcher.mockResolvedValueOnce(
      Response.json({ error: 'secret provider message', detail: 'secret' }, { status: 500 }),
    )
    expect(await (await proxy.checkout(make())).json()).toEqual({ error: 'checkout_unavailable' })
  })
  it('status needs the signed receipt; a URL alone is never payment proof', async () => {
    const { proxy, pay, fetcher } = fixture()
    expect((await proxy.status(request('status', { session_id: session }))).status).toBe(403)
    const cookie = (await pay()).headers.get('set-cookie')!.split(';')[0]
    const response = await proxy.status(request('status', { session_id: session }, { cookie }))
    expect(await response.json()).toEqual({ status: 'pending', request_id: 'request' })
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body))).toEqual({
      action: 'status',
      click_id: click,
      attempt_id: attempt,
      session_id: session,
    })
    fetcher.mockResolvedValueOnce(
      Response.json({ status: 'no_payment_required', request_id: 'request' }),
    )
    expect(
      await (await proxy.status(request('status', { session_id: session }, { cookie }))).json(),
    ).toEqual({ status: 'no_payment_required', request_id: 'request' })
    expect(
      (await proxy.status(request('status', { session_id: session }, { cookie: `${cookie}x` })))
        .status,
    ).toBe(403)
  })
  it('reports bounded transport diagnostics without secrets or request data', async () => {
    const diagnostic = vi.fn()
    const proxy = createFunnelCheckoutProxy({
      origin,
      backendBaseUrl: 'https://backend.example/functions/v1',
      offerKey: 'monthly',
      signing: { keyId: 'fixture', secret: 'unit-test-only-not-a-production-secret' },
      checkoutEnabled: false,
      diagnostic,
      fetcher: vi.fn(async () => {
        throw new Error('private provider secret and request body')
      }),
    })
    const response = await proxy.offer(request('offer', { click_id: click }))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'backend_unavailable' })
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      stage: 'fetch_backend',
      category: 'transport_failure',
    })
  })
})
