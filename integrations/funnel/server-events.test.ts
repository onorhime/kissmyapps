import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { verifyFunnelSignature } from '../../supabase/functions/_shared/crypto.ts'
import {
  createSignedRequest,
  sendServerEvent,
  ServerIntegrationError,
  type ServerEventPayload,
} from './server-events.ts'

const SECRET = 'a-production-secret-placeholder-32-bytes-long'
const CLICK_ID = 'click_public_00000001'
const EVENT_ID = '018f47a1-2403-7b10-9234-123456789abc'
const NONCE = 'nonce_000000000000000000000001'

function event(): ServerEventPayload {
  return {
    event_id: EVENT_ID,
    event_name: 'lead_created',
    click_id: CLICK_ID,
    occurred_at: '2026-08-28T12:00:00.000Z',
    properties: { page_name: 'offer' },
  }
}

describe('server-authenticated funnel requests', () => {
  it('signs the exact serialized bytes using the Edge Function canonical input', async () => {
    const request = await createSignedRequest({
      endpoint: 'https://functions.example/funnel-events',
      body: event(),
      signing: { keyId: 'funnel_primary', secret: SECRET },
      nonce: NONCE,
      timestampSeconds: 1_800_000_000,
    })

    const expected = createHmac('sha256', SECRET)
      .update(`1800000000.${NONCE}.${request.body}`)
      .digest('hex')
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      'x-kma-key-id': 'funnel_primary',
      'x-kma-timestamp': '1800000000',
      'x-kma-nonce': NONCE,
      'x-kma-signature': expected,
    })
    await expect(
      verifyFunnelSignature(
        new TextEncoder().encode(request.body),
        {
          keyId: 'funnel_primary',
          timestamp: 1_800_000_000,
          nonce: NONCE,
          signature: expected,
        },
        new Map([['funnel_primary', SECRET]]),
        1_800_000_000,
      ),
    ).resolves.toBeUndefined()
  })

  it('sends the unchanged signed body and accepts an idempotent receipt', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        accepted: true,
        event_id: EVENT_ID,
        duplicate: true,
        request_id: 'request-3',
      }),
    )

    const receipt = await sendServerEvent({
      endpoint: 'https://functions.example/funnel-events',
      event: event(),
      signing: { keyId: 'funnel_primary', secret: SECRET },
      nonce: NONCE,
      timestampSeconds: 1_800_000_000,
      fetcher: fetcher as typeof fetch,
    })

    expect(receipt.duplicate).toBe(true)
    const [, init] = fetcher.mock.calls[0]
    expect(init?.body).toBe(JSON.stringify(event()))
    expect(new Headers(init?.headers).get('x-kma-signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects short secrets, insecure endpoints, and identifying properties', async () => {
    await expect(
      createSignedRequest({
        endpoint: 'http://functions.example/funnel-events',
        body: event(),
        signing: { keyId: 'funnel_primary', secret: SECRET },
      }),
    ).rejects.toBeInstanceOf(ServerIntegrationError)

    await expect(
      createSignedRequest({
        endpoint: 'https://functions.example/funnel-events',
        body: event(),
        signing: { keyId: 'funnel_primary', secret: 'too-short' },
      }),
    ).rejects.toBeInstanceOf(ServerIntegrationError)

    await expect(
      sendServerEvent({
        endpoint: 'https://functions.example/funnel-events',
        event: { ...event(), properties: { email: 'not-allowed' } },
        signing: { keyId: 'funnel_primary', secret: SECRET },
      }),
    ).rejects.toMatchObject({ code: 'invalid_event' })
  })
})
