# KissMyApps funnel integration — v1.3

Status: implementation contract for the BC Learn test funnel. This document does
not certify deployment, live payment acceptance, app entitlement or payout release.
The context endpoint, zero-total processing and embedded-checkout migrations
must be deployed before using the v1.3 flow. US$1/month is approved; the
operator requires a 100% recurring discount, not a real charge, for this test.

## 1. The complete flow

Partner link → go.kissmyapps.dev records click → BC Learn captures kma_click →
original welcome + three questions → saved email → verified paywall → embedded Stripe Checkout.
Customer confirmation: receipt-bound server verification → confirmed funnel screen.
Reporting, independently: signed Stripe webhook → normalization worker → commercial ledger → partner metrics.

The original /speak design is duplicated at /. Its welcome, three question pages
and email/plan screen are retained; the paywall is the sixth screen, immediately
after successful email saving. Answers personalize the summary, not the price or
commission. /speak itself still ends with waitlist confirmation and optional matching.
The earlier redesigned PartnerTestFunnel is no longer the active root component.
The unrelated 32-screen /plan entry redirects to /, and its standalone Stripe
API returns 410. There is no unaffiliated checkout fallback.

Production funnel origin: https://bc-learn-partner-funnel.vercel.app
Partner dashboard: https://partners.kissmyapps.dev
Admin dashboard: https://admin.kissmyapps.dev
Tracking links: https://go.kissmyapps.dev
Backend base: https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1

## 2. What the admin configures

1. Create a COMMERCIAL product and one live default HTTPS funnel at the origin
   above. Tracking-only products can test clicks/events but cannot accept payment.
2. Configure the partner's actual commission rule and agreement. Upload the
   real versioned PDF, have the partner sign, countersign as an authorized admin,
   and activate it. A funnel buyer's checkbox is NOT this bilateral agreement.
3. Create the approved US$1/month live recurring Stripe Price. Configure a
   product-applicable 100%-off FOREVER coupon and active promotion code; do not
   use a once-only coupon that would charge on renewal. Configure and verify the matching billing offer: exact
   Price ID, currency, minor-unit amount, subscription mode and stable offer key.
4. Set the offer success URL to:
   https://bc-learn-partner-funnel.vercel.app/checkout/complete?session_id={CHECKOUT_SESSION_ID}
   Set its cancellation URL to:
   https://bc-learn-partner-funnel.vercel.app/?checkout=cancelled
5. Activate the product, then activate its verified offer. Issue the partner main link, and create distinct
   source links for TikTok, Instagram, etc. Select the correct funnel/source/
   campaign in the dashboard and enable the production tracking gateway.
6. Configure the backend and funnel secrets below; activate and verify the Stripe
   webhook and scheduled Stripe/commercial/metrics workers. Review final buyer
   terms, cancellation/refund instructions and support contact. Only then set
   KMA_CHECKOUT_ENABLED=true for the approved no-charge test. Do not remove the
   discount from the resulting subscription. Restrict redemption and access to
   this test funnel; an open promotion endpoint lets any eligible visitor use it.

Price IDs do not belong in partner links. Link codes resolve to server-owned
partner/product/funnel/source/campaign dimensions. TikTok or Instagram may add
their own click parameters, but those are not a reliable substitute for creating
and distributing the right source-specific partner link. Referrers may be absent.
Changing a browser query must never reassign the owning partner or commission.

## 3. Browser attribution and events

Use the versioned browser-attribution.ts helper. Capture before initializing
optional third-party analytics:

```ts
const attribution = captureAttributionFromUrl()
if (attribution.clickId) {
  await sendBrowserEvent({
    endpoint: BACKEND + '/browser-events',
    clickId: attribution.clickId,
    eventName: 'landing_viewed',
    eventId: crypto.randomUUID(),
    occurredAt: new Date(),
    properties: { page_path: '/', page_name: 'welcome' },
  })
}
```

One opaque kma_click is held as pending and removed from the address bar.
A successful event or checkout promotes it to confirmed storage (default 30 days,
client maximum 90 days); server agreement windows remain authoritative.
An unknown token cannot replace the last confirmed token. Do not silently assign
an organic visit to an arbitrary partner. BC Learn blocks checkout without a
usable partner click; its questions still work.

Allowed browser events: landing_viewed, funnel_started, payment_viewed,
app_store_clicked. BC Learn sends the first three; there is no app-store CTA yet.
No browser purchase, revenue, refund or commission event is accepted.
Event payload fields are exactly event_id (UUID), event_name, click_id,
occurred_at (ISO timestamp), and properties. Keep the same ID, timestamp and
properties for retries of one logical event. Successful response:
{accepted:true,event_id,duplicate:boolean,request_id}.

Only allowlisted, non-identifying properties are permitted. BC Learn sends
page_path without queries and page_name only. Never send answers, emails,
passwords, card data, access tokens or full URLs to this endpoint.
The current funnel makes bounded best-effort behavioral sends; it does not
include a durable offline event queue. A browser-event outage does not fabricate
a conversion. Server checkout and verified payment remain authoritative.

Amplitude is optional, consent-controlled UX analytics already in the funnel.
It is not the commission ledger. Declining it does not disable the flow.
The operator must approve applicable attribution notice/consent requirements
before public launch.

## 4. Same-origin browser API

### BC Learn email step (existing waitlist API)

POST /api/waitlist with {email,answers,context,session_id}. This existing BC Learn
lead-capture endpoint is separate from the partner financial API. It stores the
email and allowed questionnaire/context fields in the existing Firestore waitlist
and may send its configured Resend welcome email for a new record. It does not
create a partner account, grant entitlement, record a purchase or earn a commission.
The copied UI opens the paywall only after an HTTP-success response with {ok:true}.
An invalid email or failed save leaves the email screen visible for correction/retry.
The existing Firestore service-account configuration is required; do not bypass a
failed save or claim the email is stored when it is not. Never put these secrets
in browser code. Production deployment also needs review of the existing waitlist
endpoint's abuse controls and welcome-email behavior.

Email and answers stay in component memory, not browser storage. Neither is sent
to browser-events. Checkout sends only the entered email as `customer_email` for
Stripe billing prefill; answers are never forwarded. Email is not proof of identity,
does not select an existing Customer, and is excluded from attribution metadata,
DB records and logs. Stripe's final billing identity remains authoritative.
Refreshing restarts the questionnaire;
resubmitting the same email updates its existing waitlist record rather than
creating a duplicate. This does not reset checkout idempotency keys.

### Partner API protections

All routes below are POST, application/json, no-store and exact-origin protected.
Maximum request body: 4096 bytes. Include same-origin cookies; never call the
server-HMAC endpoint directly from a browser. Unknown fields are rejected.

### POST /api/partner/offer

Body: {click_id}
Response: {offer,checkout_enabled}

offer = {key,version,name,currency,unit_amount_minor,billing_mode:"subscription",
interval:"day"|"week"|"month"|"year",interval_count}.

The backend reads an active, verified offer bound to the click's product and
checks the current live Stripe Price. Currency is uppercase; amount is an integer
in minor units. The UI must show today's charge, renewal amount/interval and no
free-trial claim. BC Learn displays the USD list price plus its mandatory 100%
recurring discount. Additional currencies, taxes, partial discounts, trials and
usage-based pricing remain outside this test contract.

The adapter sets a signed HttpOnly kma_checkout_quote cookie, valid 15 minutes,
SameSite=Lax, Path=/api/partner, Secure in production. It binds click, offer and
displayed version. Price or version changes require a new review.

### POST /api/partner/checkout

Body: {click_id,offer_key,customer_email}. Email is required by this embedded BC Learn adapter;
it remains optional for backwards-compatible hosted integrations.
Header: Idempotency-Key: <16–128 character logical-attempt token>

```ts
const receipt = await requestCheckout({
  endpoint: '/api/partner/checkout',
  clickId,
  offerKey: offer.key,
  customerEmail: email.trim(),
  idempotencyKey: savedLogicalAttemptKey,
})
if (receipt.checkout_url === null) {
  const stripe = await loadStripe(receipt.publishable_key)
  const checkout = await stripe.createEmbeddedCheckoutPage({
    clientSecret: receipt.client_secret,
    onComplete: () => verifyReceiptAndContinue(receipt.session_id),
  })
  checkout.mount('#checkout')
} else window.location.assign(receipt.checkout_url) // legacy hosted mode only
```

Review the offer first so its signed quote cookie exists. Reuse one key for every
retry of that click/offer/version. Do not generate a fresh key on a timeout.
BC Learn keeps it in session storage with an in-memory fallback. Storage loss,
another device or clearing data is not a cross-device duplicate-purchase guard.

Embedded response: {ui_mode:"embedded",checkout_url:null,client_secret,session_id,
publishable_key,attempt_id,expires_at,request_id}. Client secrets stay only in
component memory: never URLs, browser storage, analytics, logs or database records.
Legacy hosted response: {checkout_url,attempt_id,expires_at,request_id}; only an
https://checkout.stripe.com URL is accepted. The adapter sets a signed HttpOnly
kma_checkout_receipt cookie (same path; two-day maximum age), binding the embedded
session as well as its click and attempt. Payment fields are owned by Stripe's iframe.
KMA_CHECKOUT_ENABLED=false causes 503 checkout_not_enabled before checkout creation.

The adapter adds offer_version from the signed quote and forwards the same
idempotency token as the HMAC nonce. The database locks the displayed active
version while snapshotting the checkout. Stripe receives its own stable
kma-checkout-<internal attempt UUID> idempotency key and server-owned metadata.
An immutable keyed fingerprint also binds UI mode, email and the no-charge guard
to the attempt. Changed retry input fails closed. Open-session retries retrieve
that exact session instead of creating another one. The adapter alone chooses
`uiMode:"embedded"`, with `KMA_STRIPE_PUBLISHABLE_KEY=pk_live_...` for the SAME Stripe
account. It must never contain an rk_live/sk_live key. Stripe receives ui_mode=embedded,
return_url (the approved success URL), and redirect_on_completion=if_required;
success_url/cancel_url are omitted in embedded mode. Ordinary completion stays
inline; bank authentication can still require a redirect.

Apple Pay / Google Pay depend on Stripe account settings, eligible browser/device,
and payment-method domain registration for the exact deployed funnel hostname.
A zero-total subscription may not show wallets at all. This $0 test cannot prove
positive-value card, wallet or refund behavior. Never promise every wallet on every device.

### POST /api/partner/status

Body: {session_id} — a live Checkout Session ID returned by Stripe.
Requires the signed receipt cookie from checkout creation.
Response: {status:"pending"|"paid"|"no_payment_required"|"expired"|"failed",request_id}.

"no_payment_required" means Stripe's completed checkout is verified as zero-total;
normalization can finish independently. No paid conversion or commission is due. This does not prove
the positive-payment, refund or payout path. A query string cannot set this status.

A session URL alone is not proof or permission to read payment state.
The backend matches session + public attempt + click + product + funnel.
No email, customer identifier, card data or internal ledger record is returned.
"paid" means the backend verified a completed live paid Checkout Session (or an
already-normalized payment), not simply that the browser reached the return URL.
The backend reads the exact session after DB ownership checks and validates all
attribution metadata, currency, mode and amount. Complete-but-unpaid remains pending.
BC Learn checks automatically up to 20 times, three seconds apart; a safe retry
appears only after the bounded wait. Worker lag alone does not keep buyers pending.
This status endpoint does not create ledger entries, commissions or app entitlements.
No valid cookie (another browser, expired cookie, blocked cookies) means the
receipt cannot be verified here; consult Stripe receipt/the operator, do not
automatically pay again. A cancelled return does not cancel an existing subscription.

Important safe errors: 400 invalid_request/invalid_offer; 403 origin_not_allowed/
receipt_unavailable; 409 offer_review_required/free_discount_unavailable/no_charge_required;
404 not_found; 429 rate_limited;
503 configuration_pending/checkout_not_enabled/checkout_unavailable.
On price-review errors reload the offer and require new acceptance. On transient
failure reuse the attempt. Never expose raw provider error bodies or secrets.

## 5. Funnel server setup

Canonical shared files (copy all four without local divergence):
browser-attribution.ts, server-events.ts, checkout-contract.ts, checkout-proxy.ts.
BC Learn vendors them in lib/kma. The parity check verifies SHA-256 digests.

```ts
const proxy = createFunnelCheckoutProxy({
  origin: configuredExactOrigin,
  backendBaseUrl: 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1',
  signing: { keyId: serverKeyId, secret: serverHmacSecret },
  offerKey: configuredOfferKey,
  checkoutEnabled: approvedEnabledFlag,
  uiMode: 'embedded',
  stripePublishableKey: configuredStripePublishableKey, // pk_live_, same Stripe account
  requireNoPayment: true, // BC Learn test: server-owned, never accepted from browser
})
// Wire proxy.offer / proxy.checkout / proxy.status to the three POST routes.
```

BC Learn server environment:
KMA_FUNNEL_ORIGIN=https://bc-learn-partner-funnel.vercel.app
KMA_FUNNEL_KEY_ID=<unique per-funnel key ID>
KMA_FUNNEL_HMAC_SECRET=<random 32+ character server secret>
KMA_OFFER_KEY=<approved stable billing-offer key>
KMA_CHECKOUT_ENABLED=false
KMA_STRIPE_PUBLISHABLE_KEY=<pk_live key for the backend Stripe account; public, not secret>

Do not use NEXT_PUBLIC_ or VITE_ for these secrets. No Supabase service role,
Stripe private key, or partner credentials belong in the funnel browser or code.
Keep the existing .env.local intact. Only the production Vercel environment
should receive approved production credentials; arbitrary preview hosts are
not trusted. HTTP localhost is permitted by the adapter solely for local UI/
mock tests, not by production backend origin allowlists.

## 6. Server-to-server HMAC API

Headers: x-kma-key-id, x-kma-timestamp (Unix seconds), x-kma-nonce
(16–128 letters/digits/underscore/hyphen), x-kma-signature (lowercase SHA-256 hex).
Sign UTF-8 bytes of:
<unix_timestamp>.<nonce>.<exact_raw_request_body>
using HMAC-SHA256. Send serialized bytes unchanged. Clock tolerance is 300 seconds.
The key resolves to one product UUID and one funnel UUID in FUNNEL_HMAC_BINDINGS.
A key cannot read or charge a different funnel's clicks. These endpoints reject
browser Origin headers; authentication is HMAC, not an anonymous Supabase JWT.

POST /funnel-checkout-context:

- Offer body: {action:"offer",click_id,offer_key}; reply {offer,request_id}.
- Status body: {action:"status",click_id,attempt_id,session_id};
  reply {status,request_id}.
- Requires migrations 20260905110000_funnel_checkout_context and
  20260907093000_embedded_checkout_presentation for receipt verification.
- Durable limits per click/minute: 10 offers, 30 status reads.

POST /checkout-session:

- New adapter body: {click_id,offer_key,offer_version,require_no_payment?:true,ui_mode?:"embedded"|"hosted",customer_email?:string}.
- BC Learn always sets require_no_payment=true and ui_mode=embedded server-side.
  Browser bodies contain {click_id,offer_key,customer_email}; clients cannot select a coupon or disable this guard.
- Legacy signed two-field bodies remain supported for compatibility, but new
  integrations MUST use the reviewed-quote adapter.
- Response 201: legacy hosted receipt or {ui_mode:"embedded",checkout_url:null,
  client_secret,session_id,attempt_id,expires_at,request_id}. The same-origin adapter
  supplies the public key; the Edge never exposes a private key.
- Durable limit: 6 checkout requests per click/minute, including retries.
- Price, currency, mode, redirects, affiliate and attribution are database-owned.

POST /funnel-events (optional; not needed for these three quiz questions):

- {event_id,event_name,click_id,occurred_at,properties}
- Only configured FUNNEL_EVENT_ALLOWED_NAMES / PROPERTIES are accepted.
- Use sendServerEvent; preserve the logical event ID and payload on retries.
- Do not send payment truth here; Stripe webhook owns it.

Backend secrets (Supabase only):
BROWSER_EVENT_ALLOWED_ORIGINS must include the exact production funnel origin.
CHECKOUT_ALLOWED_REDIRECT_ORIGINS must include that same origin.
FUNNEL_HMAC_BINDINGS maps the unique key ID to {secret,product_id,funnel_id}.
STRIPE_SECRET_KEY must be a live server key; STRIPE_WEBHOOK_SECRET verifies Stripe.
FREE_CHECKOUT_PROMOTION_BINDINGS is a JSON object mapping internal product UUIDs
to approved live Stripe promo_ IDs. Keep it on Supabase only, not in browser URLs.
Only an active, valid, price-applicable 100%-off FOREVER coupon is accepted.
The server pre-applies it with discounts[0][promotion_code] and uses
payment_method_collection=if_required. It checks Stripe's resulting total is 0
and the discount equals the full stored price before returning any Checkout URL.
Missing configuration, an expired code, a restricted/inapplicable coupon or any
nonzero total fails closed; the code never silently retries without the discount.
Do not enable arbitrary promotion-code entry: partial-discount accounting has
not been implemented. Configure limits/customer restrictions in Stripe and
cancel the test subscription after verification; never remove its discount.
INTERNAL_WORKER_SECRET authenticates scheduled workers; never send it to a funnel.
Preserve other funnels' bindings/origins and existing notification configuration.

## 7. Payment processing and dashboard attribution

Stripe webhook URL:
https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/stripe-webhook

Pin webhook API version to the backend's source-pinned 2026-02-25.clover.
Subscribe only to the supported events:
checkout.session.completed, checkout.session.async_payment_succeeded,
customer.subscription.created, customer.subscription.updated,
customer.subscription.deleted, invoice.paid, refund.created, refund.updated,
charge.dispute.created, charge.dispute.updated, charge.dispute.closed.

The webhook verifies raw Stripe signatures/live mode and queues minimized
evidence. stripe-worker normalizes it; commercial-worker calculates deterministic
integer-minor-unit commissions under the effective signed agreement;
metrics-worker refreshes dashboard totals. Scheduling those workers is a separate
production operation, not implied by uploading a function.

The funnel need not share a database or install the dashboard. It talks only to
the documented event/checkout interfaces. Attribution metadata is added by the
backend to Checkout and the subscription/payment intent. Renewals, refunds and
disputes attach through verified provider identities and canonical acquisitions.

A paid test does not yet grant BC Learn app access. App entitlement integration
is separate. Ledger calculation is not an external bank transfer: payout
approval/reconciliation/release remains a separate controlled operation.
No platform worker silently pays affiliates.

Zero-total callbacks use normalize_stripe_zero_total_event (migration
20260905120000_zero_total_checkout). Verified fully discounted checkout resolves
the same canonical click/acquisition/customer and subscription, but emits
checkout.no_payment_required with commercial_eligible=false. Zero-total invoice.paid
emits invoice.no_payment_required without looking for a nonexistent PaymentIntent.
Both paths require a valid worker lease and signed live provider evidence;
foreign ownership, incomplete discount evidence and positive unpaid amounts fail.
Original positive-payment normalization remains separate and unchanged.

### 7.1 Future app access — not implemented

As confirmed on September 7, 2026, BC Learn has no product app/backend yet.
App access is deferred until that app is built. The current test ends at verified
checkout confirmation and partner reporting; it does not create an app login or
unlock premium features. An entitlement table is not a working entitlement API.

The future developer must implement this separate flow:

1. **Authenticate the buyer in the product app.** Use its real sign-in system and
   validate the stable user ID server-side. A partner dashboard login is not a
   buyer account, and the funnel waitlist email is not proof of account ownership.
2. **Securely link that user to the verified subscription.** Bind identity before
   checkout, or implement an authenticated, short-lived, single-use purchase-claim
   flow afterward. Verify both the purchase and the app account. Never grant
   access from a billing email match, URL parameter, click ID or Checkout Session
   ID alone. Preserve the original partner attribution and immutable billing facts.
3. **Check access after app login.** Build a product-scoped authenticated access
   API returning only the user's access state and expiry/recheck information.
   Enforce the result in the app/backend's protected features, not just the UI.
   Keep secrets and entitlement writes server-only; funnel credentials must not
   gain authority to grant access.
4. **Keep access current.** Define and implement the policy for renewals,
   cancellation at period end, failed payments, trials, refunds, disputes and
   multiple subscriptions. Handle retries/out-of-order events idempotently and
   define safe behavior when evidence is missing, stale or temporarily unavailable.
5. **Verify the real app integration before release.** Test legitimate access,
   foreign-user/product denial, expired/replayed claims and lifecycle changes.
   Select the actual app/deep-link destinations only when the app exists.

Payment confirmation, app access and affiliate earnings are separate outcomes.
A permitted discounted subscription can grant access without generating paid
revenue, but these BC Learn no-charge test subscriptions remain non-unlocking
unless explicitly approved otherwise. No existing test account is automatically
backfilled or granted access.

There is no callable app-access or purchase-claim endpoint in v1.3. Endpoint paths,
authentication, request/response schemas and any app credential setup will be
added to the versioned documentation when the integration is implemented and
deployed. Do not invent an endpoint or treat /api/partner/status as an access API.

## 8. Deployment and acceptance checklist

Before deployment:

- Run frontend/shared SDK tests, Edge checks, both Vinext and Next production
  builds, and the bounded hosted rollback SQL regression. No local Supabase.
- Verify SDK/document parity and no server secrets in generated client bundles.
- Review migration, endpoint deployment order, price, buyer terms and cancellation.
- Existing Sites project is a separate publication; do not deploy there when
  the approved target is bc-learn-partner-funnel.vercel.app.

Deployment order after approval:

1. Apply migrations 20260905110000, 20260905120000, 20260907090000
   (Clover compatibility) and 20260907093000 (embedded presentation), in order;
   deploy funnel-checkout-context, checkout-session, stripe-webhook and stripe-worker.
2. Preserve/extend exact allowlists and per-funnel secret bindings.
3. Verify live Price, webhook pin/events and worker schedules.
4. For an initial rollout, publish to bc-learn-partner-funnel with checkout OFF.
   For approved upgrades, preserve the existing switch and mandatory $0 guard;
   never deploy over the separate bc-learn-funnel project.
5. Check mobile/desktop/browser flow, then explicitly enable any new test scope.
   An exhausted single-redemption code requires a separately approved replacement;
   do not widen redemption limits or remove the discount to make a retry work.

Live acceptance (not performed by source/unit checks):

- Make distinct TikTok and Instagram source links and inspect their redirects.
- Confirm the click and allowed events appear under the correct partner/product/
  source, with no fabricated cross-source or organic reassignment.
- Complete one $0 discounted checkout; wait for the verified webhook, normalized
  subscription and no_payment_required receipt. Expect zero cash transactions,
  zero paid conversions and zero commissions. Do not confirm a nonzero amount.
- A real positive payment, commission, refund and payout test remains a separate
  future approval gate; a free checkout cannot certify it.
- Refresh/retry without a duplicate checkout or commission. Exercise invalid
  token, expired quote, changed offer, cancellation, delayed webhook and denied
  cookies. Cross-funnel/foreign receipts must fail.
- Confirm renewal/refund/dispute behavior and schedule cleanup/cancellation of the
  recurring test subscription with the operator. Do not erase financial evidence.
- Check keyboard navigation, focus after advancing, small-screen layout and
  screen-reader announcements before public launch.
