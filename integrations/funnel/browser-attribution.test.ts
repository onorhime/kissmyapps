import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ATTRIBUTION_QUERY_PARAMETER,
  ATTRIBUTION_STORAGE_KEY,
  captureAttributionFromUrl,
  createBrowserEventPayload,
  DEFAULT_ATTRIBUTION_TTL_MILLISECONDS,
  FunnelIntegrationError,
  PENDING_ATTRIBUTION_STORAGE_KEY,
  readStoredClickId,
  requestCheckout,
  sendBrowserEvent,
  stripAttributionParameter,
  type StorageLike,
} from './browser-attribution.ts'

const CLICK_ID = 'click_public_00000001'
const EVENT_ID = '018f47a1-2403-7b10-9234-123456789abc'

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('browser attribution capture', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
  })

  it('captures one valid click, strips it, and preserves unrelated URL bytes', () => {
    const replaceUrl = vi.fn()
    const href = `https://funnel.example/offer?name=Jane+Doe&${ATTRIBUTION_QUERY_PARAMETER}=${CLICK_ID}&next=%2Fthanks#pricing`

    const result = captureAttributionFromUrl({
      href,
      storage,
      replaceUrl,
      nowMilliseconds: 1_800_000_000_000,
    })

    expect(result).toEqual({
      clickId: CLICK_ID,
      captured: true,
      persisted: true,
      cleanedUrl: 'https://funnel.example/offer?name=Jane+Doe&next=%2Fthanks#pricing',
    })
    expect(replaceUrl).toHaveBeenCalledOnce()
    expect(replaceUrl).toHaveBeenCalledWith(result.cleanedUrl)
    expect(readStoredClickId(storage, 1_800_000_000_001)).toBeNull()
    expect(storage.getItem(PENDING_ATTRIBUTION_STORAGE_KEY)).toContain(CLICK_ID)
  })

  it('strips encoded and duplicated click parameters without overwriting good attribution', () => {
    captureAttributionFromUrl({
      href: `https://funnel.example/?${ATTRIBUTION_QUERY_PARAMETER}=${CLICK_ID}`,
      storage,
      replaceUrl: vi.fn(),
      nowMilliseconds: 1_800_000_000_000,
    })

    const result = captureAttributionFromUrl({
      href: 'https://funnel.example/?%6bma_click=bad&kma_click=also_bad&campaign=launch',
      storage,
      replaceUrl: vi.fn(),
      nowMilliseconds: 1_800_000_000_100,
    })

    expect(result.captured).toBe(false)
    expect(result.clickId).toBe(CLICK_ID)
    expect(result.cleanedUrl).toBe('https://funnel.example/?campaign=launch')
  })

  it('expires and removes stale or overlong stored attribution', () => {
    storage.setItem(
      ATTRIBUTION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        click_id: CLICK_ID,
        captured_at: 1_800_000_000_000,
        expires_at: 1_800_000_000_000 + DEFAULT_ATTRIBUTION_TTL_MILLISECONDS,
      }),
    )

    expect(
      readStoredClickId(storage, 1_800_000_000_000 + DEFAULT_ATTRIBUTION_TTL_MILLISECONDS),
    ).toBeNull()
    expect(storage.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull()
  })

  it('removes only the attribution query field', () => {
    expect(
      stripAttributionParameter(
        `https://funnel.example/path?before=1&${ATTRIBUTION_QUERY_PARAMETER}=${CLICK_ID}&after=two+words#section`,
      ),
    ).toBe('https://funnel.example/path?before=1&after=two+words#section')
  })
})

describe('browser forwarding', () => {
  it('posts the exact allowlisted browser event contract with stored attribution', async () => {
    const storage = new MemoryStorage()
    captureAttributionFromUrl({
      href: `https://funnel.example/?${ATTRIBUTION_QUERY_PARAMETER}=${CLICK_ID}`,
      storage,
      replaceUrl: vi.fn(),
    })
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        accepted: true,
        event_id: EVENT_ID,
        duplicate: false,
        request_id: 'request-1',
      }),
    )

    const receipt = await sendBrowserEvent({
      endpoint: 'https://functions.example/browser-events',
      eventName: 'landing_viewed',
      properties: { page_path: '/offer', variant: 'hero-a' },
      storage,
      eventId: EVENT_ID,
      occurredAt: new Date('2026-08-28T12:00:00.000Z'),
      fetcher: fetcher as typeof fetch,
    })

    expect(receipt.duplicate).toBe(false)
    expect(readStoredClickId(storage)).toBe(CLICK_ID)
    expect(storage.getItem(PENDING_ATTRIBUTION_STORAGE_KEY)).toBeNull()
    expect(fetcher).toHaveBeenCalledOnce()
    const [endpoint, init] = fetcher.mock.calls[0]
    expect(endpoint).toBe('https://functions.example/browser-events')
    expect(JSON.parse(String(init?.body))).toEqual({
      event_id: EVENT_ID,
      event_name: 'landing_viewed',
      click_id: CLICK_ID,
      occurred_at: '2026-08-28T12:00:00.000Z',
      properties: { page_path: '/offer', variant: 'hero-a' },
    })
  })

  it('keeps confirmed attribution when a well-formed pending click is rejected by the server', async () => {
    const storage = new MemoryStorage()
    const rejectedClickId = 'click_public_00000002'
    captureAttributionFromUrl({
      href: `https://funnel.example/?${ATTRIBUTION_QUERY_PARAMETER}=${CLICK_ID}`,
      storage,
      replaceUrl: vi.fn(),
    })
    await sendBrowserEvent({
      endpoint: 'https://functions.example/browser-events',
      eventName: 'landing_viewed',
      storage,
      eventId: EVENT_ID,
      fetcher: vi.fn(async () =>
        Response.json({
          accepted: true,
          event_id: EVENT_ID,
          duplicate: false,
          request_id: 'request-confirmed',
        }),
      ) as typeof fetch,
    })

    captureAttributionFromUrl({
      href: `https://funnel.example/?${ATTRIBUTION_QUERY_PARAMETER}=${rejectedClickId}`,
      storage,
      replaceUrl: vi.fn(),
    })
    expect(readStoredClickId(storage)).toBe(CLICK_ID)
    expect(storage.getItem(PENDING_ATTRIBUTION_STORAGE_KEY)).toContain(rejectedClickId)

    await expect(
      sendBrowserEvent({
        endpoint: 'https://functions.example/browser-events',
        eventName: 'landing_viewed',
        storage,
        eventId: '018f47a1-2403-7b10-9234-123456789abd',
        fetcher: vi.fn(async () =>
          Response.json(
            { error: 'click_unavailable', message: 'The affiliate click is unavailable.' },
            { status: 404 },
          ),
        ) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'click_unavailable', status: 404 })

    expect(storage.getItem(PENDING_ATTRIBUTION_STORAGE_KEY)).toBeNull()
    expect(readStoredClickId(storage)).toBe(CLICK_ID)
  })

  it('rejects unsupported or identifying browser properties before fetch', () => {
    expect(() =>
      createBrowserEventPayload({
        eventName: 'landing_viewed',
        clickId: CLICK_ID,
        eventId: EVENT_ID,
        properties: { email: 'not-allowed' } as never,
      }),
    ).toThrowError(FunnelIntegrationError)
  })

  it('forwards only the click and offer key to a funnel-owned checkout route', async () => {
    const storage = new MemoryStorage()
    captureAttributionFromUrl({
      href: `https://funnel.example/?${ATTRIBUTION_QUERY_PARAMETER}=${CLICK_ID}`,
      storage,
      replaceUrl: vi.fn(),
    })
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(
        {
          checkout_url: 'https://checkout.stripe.com/c/pay/cs_live_example',
          attempt_id: 'attempt_public_00000000000000000001',
          expires_at: '2026-08-28T13:00:00.000Z',
          request_id: 'request-2',
        },
        { status: 201 },
      ),
    )

    const receipt = await requestCheckout({
      endpoint: 'https://funnel.example/api/checkout',
      offerKey: 'annual-offer',
      storage,
      fetcher: fetcher as typeof fetch,
    })

    expect(receipt.checkout_url).toContain('https://checkout.stripe.com/')
    const [, init] = fetcher.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toEqual({
      click_id: CLICK_ID,
      offer_key: 'annual-offer',
    })
    expect(readStoredClickId(storage)).toBe(CLICK_ID)
    expect(storage.getItem(PENDING_ATTRIBUTION_STORAGE_KEY)).toBeNull()
  })
})
