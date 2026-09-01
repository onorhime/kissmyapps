import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FunnelIntegrationError,
  type BrowserEventOptions,
  type BrowserEventReceipt,
} from '../../integrations/funnel/browser-attribution.ts'
import { BROWSER_EVENTS_ENDPOINT, initializeDemoFunnel } from './demo-funnel.ts'

const CLICK_ID = 'click_public_00000001'

function renderFixture(): void {
  document.body.innerHTML = `
    <section id="demo-status" data-state="checking">
      <strong id="demo-status-title"></strong>
      <span id="demo-status-message"></span>
    </section>
    <button type="button" data-demo-event="funnel_started" disabled>Record funnel start</button>
    <button type="button" data-demo-event="payment_viewed" disabled>Record payment view</button>
    <button type="button" data-demo-event="app_store_clicked" disabled>Record app-store click</button>
  `
}

function acceptedReceipt(eventId = crypto.randomUUID()) {
  return {
    accepted: true as const,
    event_id: eventId,
    duplicate: false,
    request_id: `request-${eventId}`,
  }
}

function acceptedSender() {
  return vi.fn(async (_options: BrowserEventOptions): Promise<BrowserEventReceipt> =>
    acceptedReceipt(),
  )
}

describe('tracking-only demo funnel', () => {
  beforeEach(() => renderFixture())

  it('captures attribution and sends landing_viewed before enabling demo events', async () => {
    const send = acceptedSender()
    const controller = initializeDemoFunnel({
      document,
      pagePath: '/demo-funnel.html',
      tracker: {
        capture: () => ({
          clickId: CLICK_ID,
          captured: true,
          persisted: true,
          cleanedUrl: 'https://partners.kissmyapps.dev/demo-funnel.html',
        }),
        send,
      },
    })

    expect(document.querySelector('#demo-status-title')).toHaveTextContent('Partner click captured')
    expect(document.querySelectorAll('button:disabled')).toHaveLength(3)

    await controller.ready

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: BROWSER_EVENTS_ENDPOINT,
        eventName: 'landing_viewed',
        clickId: CLICK_ID,
        properties: {
          page_name: 'tracking_demo',
          page_path: '/demo-funnel.html',
        },
      }),
    )
    expect(document.querySelector('#demo-status')).toHaveAttribute('data-state', 'ready')
    expect(document.querySelector('#demo-status-title')).toHaveTextContent('Attribution connected')
    expect(document.querySelectorAll('button:enabled')).toHaveLength(3)
  })

  it('records only an explicitly selected allowlisted demo event', async () => {
    const send = acceptedSender()
    const controller = initializeDemoFunnel({
      document,
      pagePath: '/demo-funnel.html',
      tracker: {
        capture: () => ({
          clickId: CLICK_ID,
          captured: true,
          persisted: true,
          cleanedUrl: 'https://partners.kissmyapps.dev/demo-funnel.html',
        }),
        send,
      },
    })
    await controller.ready

    const button = document.querySelector<HTMLButtonElement>('[data-demo-event="payment_viewed"]')
    button?.click()

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        eventName: 'payment_viewed',
        clickId: CLICK_ID,
      }),
    )
    await vi.waitFor(() => expect(button).toHaveTextContent('Event recorded'))
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('data-complete', 'true')
  })

  it('keeps every event control disabled when no partner click is available', async () => {
    const send = acceptedSender()
    const controller = initializeDemoFunnel({
      document,
      tracker: {
        capture: () => ({
          clickId: null,
          captured: false,
          persisted: false,
          cleanedUrl: 'https://partners.kissmyapps.dev/demo-funnel.html',
        }),
        send,
      },
    })

    await controller.ready

    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector('#demo-status')).toHaveAttribute('data-state', 'missing')
    expect(document.querySelector('#demo-status-title')).toHaveTextContent(
      'Open this page from a partner link',
    )
    expect(document.querySelectorAll('button:disabled')).toHaveLength(3)
  })

  it('shows a safe service error and does not enable the event controls', async () => {
    const controller = initializeDemoFunnel({
      document,
      tracker: {
        capture: () => ({
          clickId: CLICK_ID,
          captured: true,
          persisted: true,
          cleanedUrl: 'https://partners.kissmyapps.dev/demo-funnel.html',
        }),
        send: vi.fn(async () => {
          throw new FunnelIntegrationError(
            'Internal service detail that should not be rendered.',
            'origin_not_allowed',
            403,
          )
        }),
      },
    })

    await controller.ready

    expect(document.querySelector('#demo-status')).toHaveAttribute('data-state', 'error')
    expect(document.querySelector('#demo-status-message')).toHaveTextContent(
      'This demo origin is not authorized by the attribution service.',
    )
    expect(document.body).not.toHaveTextContent('Internal service detail')
    expect(document.querySelectorAll('button:disabled')).toHaveLength(3)
  })
})
