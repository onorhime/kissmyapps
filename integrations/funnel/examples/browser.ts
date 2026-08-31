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

/** Use the returned Stripe URL for a top-level browser navigation. */
export async function beginCheckout(
  configuration: BrowserIntegrationConfiguration,
  offerKey: string,
): Promise<string> {
  const checkout = await requestCheckout({
    endpoint: configuration.checkoutProxyEndpoint,
    offerKey,
  })
  return checkout.checkout_url
}
