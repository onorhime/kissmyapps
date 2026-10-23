import {
  captureAttributionFromUrl,
  requestCheckout,
  sendBrowserEvent,
} from '../browser-attribution.ts'

export interface BrowserIntegrationConfiguration {
  browserEventsEndpoint: string
  checkoutProxyEndpoint: string
}

/** Call this before loading analytics or other third-party browser scripts. */
export async function initializeFunnelPage(
  configuration: BrowserIntegrationConfiguration,
): Promise<void> {
  const attribution = captureAttributionFromUrl()
  if (!attribution.clickId) return

  await sendBrowserEvent({
    endpoint: configuration.browserEventsEndpoint,
    eventName: 'landing_viewed',
    properties: {
      page_path: window.location.pathname,
      referrer_host: document.referrer ? new URL(document.referrer).hostname : null,
    },
    clickId: attribution.clickId,
  })
}

/** Hosted-only example; embedded integrations mount the returned client secret. */
export async function beginCheckout(
  configuration: BrowserIntegrationConfiguration,
  offerKey: string,
  idempotencyKey: string,
): Promise<string> {
  const checkout = await requestCheckout({
    endpoint: configuration.checkoutProxyEndpoint,
    offerKey,
    idempotencyKey,
  })
  if (!checkout.checkout_url) throw new Error('Mount embedded checkout instead of navigating')
  return checkout.checkout_url
}
