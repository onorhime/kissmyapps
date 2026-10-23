import {
  createSignedRequest,
  sendServerEvent,
  type FunnelSigningConfiguration,
} from '../server-events.ts'

export interface ServerIntegrationConfiguration {
  funnelEventsEndpoint: string
  checkoutSessionEndpoint: string
  signing: FunnelSigningConfiguration
}

/** Example of a server-authenticated, allowlisted non-payment funnel event. */
export async function reportLeadCreated(
  configuration: ServerIntegrationConfiguration,
  clickId: string,
): Promise<void> {
  await sendServerEvent({
    endpoint: configuration.funnelEventsEndpoint,
    signing: configuration.signing,
    event: {
      event_id: crypto.randomUUID(),
      event_name: 'lead_created',
      click_id: clickId,
      occurred_at: new Date().toISOString(),
      properties: {},
    },
  })
}

/**
 * Your server route can use this to call `checkout-session`. Return the JSON
 * response to the browser only after checking `response.ok`.
 */
export async function createCheckoutOnServer(
  configuration: ServerIntegrationConfiguration,
  input: { clickId: string; offerKey: string; offerVersion: number; idempotencyKey: string },
): Promise<Response> {
  const request = await createSignedRequest({
    endpoint: configuration.checkoutSessionEndpoint,
    signing: configuration.signing,
    nonce: input.idempotencyKey,
    body: { click_id: input.clickId, offer_key: input.offerKey, offer_version: input.offerVersion },
  })
  return fetch(request.endpoint, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  })
}
