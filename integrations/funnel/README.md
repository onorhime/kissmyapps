# Funnel integration

The complete current contract is [API_CONTRACT.md](./API_CONTRACT.md), version
1.3, including BC Learn setup, embedded checkout, email prefill, verified payment status,
deployment gates and live acceptance steps. New funnels should use
`createFunnelCheckoutProxy` from `checkout-proxy.ts`, not a raw passthrough route.
The foundational reference below describes the legacy two-field HMAC checkout;
the v1.3 adapter adds a server-owned quoted offer version, receipt cookies and
an embedded presentation with automatic server-verified confirmation.

Future product-app access is documented in
[section 7.1](./API_CONTRACT.md#71-future-app-access--not-implemented).
BC Learn has no product app/backend yet. App login, secure subscription linking
and an authenticated access API are deferred, not included in the live v1.3 API.

This package is the production integration contract between a future product
funnel and the affiliate platform. It contains no environment credentials, seed
transactions, domain assumptions, or deployment step.

## Request flow

1. The affiliate redirect appends one opaque `kma_click` value to the funnel
   URL.
2. The funnel calls `captureAttributionFromUrl()` before loading analytics or
   third-party assets. It holds the click as pending, then removes only
   `kma_click` from the address bar. A successful browser event or checkout
   promotes that pending token into the 30-day confirmed attribution; a
   syntactically valid but unknown token cannot overwrite the last confirmed
   click. The maximum supported client TTL is 90 days; database agreement rules
   remain the final attribution authority. A later server-accepted affiliate
   click replaces the earlier confirmed click (last-click behavior on that
   funnel origin).
3. The browser may send only `landing_viewed`, `funnel_started`,
   `payment_viewed`, or `app_store_clicked` to `browser-events`. The helper
   forwards the stored click ID and blocks unsupported/identifying properties.
4. Checkout starts at a funnel-owned server route. The browser helper sends only
   `{ click_id, offer_key }` to that route. The route signs the exact body and
   calls `checkout-session`; the HMAC secret must never reach browser code.
5. Trusted funnel events are signed server-to-server and sent to
   `funnel-events`. Payment, refund, and dispute truth comes from the verified
   Stripe webhook, not a browser event.

The click ID is an opaque public token. Do not replace it with a partner ID,
email, Stripe customer ID, or another user identifier.

## Browser setup

Copy `browser-attribution.ts` into the funnel application or import it from a
private shared package. Configure these values from the funnel's production
environment:

```ts
import { captureAttributionFromUrl, sendBrowserEvent } from './browser-attribution.ts'

const { clickId } = captureAttributionFromUrl()

if (clickId) {
  await sendBrowserEvent({
    endpoint: browserEventsEndpoint,
    eventName: 'landing_viewed',
    clickId,
    properties: { page_path: window.location.pathname },
  })
}
```

`browserEventsEndpoint` must be the HTTPS production `browser-events` URL, and
the exact funnel origin must be present in `BROWSER_EVENT_ALLOWED_ORIGINS`.
Storage denial is non-fatal: `captureAttributionFromUrl()` still returns the
captured click for the current page so it can be passed explicitly. Await the
initial browser-event receipt so a new token is confirmed before later pages
rely on stored attribution.

For checkout, point `requestCheckout()` at a same-site, funnel-owned HTTPS
route—not directly at Supabase:

```ts
import { requestCheckout } from './browser-attribution.ts'

const checkout = await requestCheckout({
  endpoint: checkoutProxyEndpoint,
  offerKey: selectedOfferKey,
})

if (checkout.checkout_url) window.location.assign(checkout.checkout_url)
// For embedded receipts, mount Stripe using the v1.3 contract example instead.
```

The backend owns the offer price, currency, billing mode, success URL, and
cancel URL. The browser never supplies those commercial values.

## Server setup

Keep the HMAC key ID and secret in the funnel server's production secret store.
The same key ID, secret, exact product UUID, and exact funnel UUID are
configured in `FUNNEL_HMAC_BINDINGS` on the Edge runtime. A key is never shared
across funnels. Do not expose it through a `VITE_`, `NEXT_PUBLIC_`, or similar
browser-visible variable.

```ts
import { sendServerEvent } from './server-events.ts'

await sendServerEvent({
  endpoint: funnelEventsEndpoint,
  signing: { keyId: funnelKeyId, secret: funnelHmacSecret },
  event: {
    event_id: crypto.randomUUID(),
    event_name: 'lead_created',
    click_id: clickId,
    occurred_at: new Date().toISOString(),
    properties: {},
  },
})
```

The event name and every property name must be included in the production
`FUNNEL_EVENT_ALLOWED_NAMES` and `FUNNEL_EVENT_ALLOWED_PROPERTIES` values.
Generate one `event_id` per logical event and reuse it on retries so ingestion
is idempotent.

`createSignedRequest()` implements the shared server request contract used by
both `funnel-events` and `checkout-session`:

```text
HMAC-SHA256(secret, "<unix_timestamp>.<nonce>.<exact_raw_body>")
```

Send the lowercase hexadecimal signature in `x-kma-signature`, alongside
`x-kma-key-id`, `x-kma-timestamp`, and `x-kma-nonce`. Send the returned body
unchanged. For checkout retries, keep one nonce per logical attempt and sign it
again with a current timestamp; the nonce is the checkout idempotency key.

See `examples/browser.ts` and `examples/server.ts` for framework-neutral wiring.

## Production activation checklist

- Confirm the final dashboard, redirect, and funnel domains before DNS or CORS
  configuration.
- Configure `BROWSER_EVENT_ALLOWED_ORIGINS` with exact HTTPS funnel origins.
- Generate and store a 32+ character funnel HMAC secret on both servers, bound
  to that one product UUID and funnel UUID.
- Configure the exact server event/property allowlists.
- Configure a live billing offer and Stripe live credentials before enabling
  checkout.
- Exercise redirect → capture → browser event → signed event → checkout →
  webhook with a real approved product before launch.
- Confirm refund/dispute normalization, commission calculation, reconciliation,
  and payout operations separately; this client package does not manufacture
  commercial facts or transfer money.
