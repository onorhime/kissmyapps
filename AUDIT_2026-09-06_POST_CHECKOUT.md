# BC Learn post-checkout audit — September 6, 2026

Scope: read-only inspection of the user's completed $0 subscription, production
records, Stripe Dashboard, the existing receipt page, funnel source and API
documentation. No new Checkout Session, subscription, charge, event replay,
configuration change or deployment was performed. Only this audit report was
added. The existing receipt's **Check again** action was used once to verify its
current status; it does not create another checkout.

## Confirmed live

- Stripe subscription `sub_1UCmHcE47mNwFlz1iWElnMWs` is **active**, for BC Learn
  Test, with **100% off forever**. The first invoice
  `in_1UCmHcE47mNwFlz1RHaSIJan` is Paid for **US$0.00**. The next invoice preview
  is also US$0.00, October 6. No cash payment was collected for this checkout.
- The dedicated webhook received three signature-verified live events at
  approximately **20:03:23 UTC**: `checkout.session.completed`,
  `customer.subscription.created`, and `invoice.paid`.
- Checkout attempt `db6f376d-d233-47d1-822c-e25e080b6cca` became completed at
  **20:06:01 UTC**. The same acquisition is resolved and its subscription active.
- Attribution is **TikTok / sub1=profile_bio**; sub2/sub3 are empty. The click is
  not classified as a bot. Exactly one `checkout.no_payment_required` event was
  found for the acquisition. Transactions and commission entries remain zero.
- The user's original browser receipt now displays **Your no-charge test
  subscription is confirmed** after its existing read-only retry.

## Findings, in priority order

### P1 — Two real Stripe events failed normalization

1. `customer.subscription.created` failed with `invalid_subscription_state`.
   The webhook projection in `supabase/functions/_shared/stripe.ts`,
   `projectSubscriptionObject`, retains legacy top-level periods but drops
   `items.data[].current_period_start/end`. The current Stripe subscription
   schema places periods on items. The worker supports item periods but cannot
   access them after projection. The stored event has neither period shape.
   Checkout itself succeeded because its separate path retrieves the subscription
   from Stripe and obtains its periods there.
2. `invoice.paid` failed with `invoice_not_paid`. The stored signed event has
   status=paid and amount_paid=0, but no legacy `paid` boolean. The worker's
   `invoiceInput` requires `invoice.paid === true`; the SQL zero-total normalizer
   also requires that removed field. This is our schema compatibility defect,
   not evidence that the Stripe invoice is unpaid.

Both events were terminally failed after one attempt. The scheduler reports
attention required. The full pipeline is **not cleanly accepted** merely because
the Checkout branch created the subscription. Repair the projection, worker and
database validation together; recover/reprocess these exact owned events using
trusted Stripe evidence while preserving immutable source history and idempotency.
Do not manufacture replacement payment facts or create another subscription.

Primary schema references:
[subscription item periods](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end?locale=en-GB),
[removed Invoice paid field](https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices?locale=en-GB).

### P1 — Customer confirmation waits for the reporting worker

`get_funnel_checkout_context` reads the normalized local attempt, not current
Stripe Session evidence. The worker cycle processed the completed checkout
approximately **158 seconds after webhook receipt**. The funnel's
`app/checkout/complete/CompleteClient.tsx` polls only 12 times, five seconds apart,
then leaves a manual retry. That polling window ends before this worker cycle.
The manual button also appears during ordinary pending checks, giving users an
unnecessary operator-facing decision.

Recommended separation: verify the exact receipt-bound Session server-side with
Stripe, validate its ownership, expected offer and payment/no-payment status, then
automatically show the next funnel step. Keep commission/reporting normalization
asynchronous. Never derive success from a query parameter or client callback
alone. Use a brief in-place verifying state and automatic bounded retries;
delayed payment methods/outages still require an honest pending/error fallback.
Do not promise instant confirmation for every payment method.

### P2 — Funnel email is deliberately not forwarded

The email step saves to the existing waitlist workflow. PartnerPaywall receives
no email prop; the checkout contract accepts only click_id/offer_key, and the
server does not set Stripe `customer_email`. The API guide explicitly documents
separate Stripe billing-email entry. This matches current implementation but not
the desired customer experience.

Add a validated, purpose-limited checkout email handoff and prefill Stripe. Keep
it out of tracking URLs, browser analytics, partner reports and diagnostic logs.
Email prefill is not email verification or authorization to link an existing
customer/account. Preserve attempt ownership and retry semantics.
See [Stripe customer_email](https://docs.stripe.com/api/checkout/sessions/create?lang=node).

### P2 — Inline checkout and wallets are not implemented in this contract

The guide describes hosted Stripe Checkout; the SDK returns `checkout_url`,
validates the Stripe-hosted origin and navigates away with `window.location.assign`.
No embedded client-secret response, Stripe.js component or embedded completion
callback exists in this funnel integration.

The published Markdown contract on the partner funnel's Vercel domain byte-matches
the local v1.2 contract and explicitly describes hosted Checkout/separate email
entry. The equivalent `/developers/funnels/funnel-api.md` path on
`partners.kissmyapps.dev` currently returns the dashboard HTML fallback (HTTP 200,
text/html), not the Markdown download. Do not use that partner-domain URL as
evidence that the developer contract is published there; include documentation
hosting and download/content-type checks in the next contract release.

Extend the versioned contract and SDK for embedded Stripe checkout, implement it
inside the existing BC Learn flow, and preserve hosted compatibility deliberately.
This requires the account's publishable key in the funnel, never its secret key,
and domain/payment-method eligibility checks. Apple Pay/Google Pay availability
depends on the enabled account methods, registered domain, device/browser and
customer wallet. Some bank authentication/methods may still leave the page.

The $0 test explicitly sets `payment_method_collection=if_required` and did not
exercise a card/wallet payment. It is not Apple Pay, paid-payment or churn proof.
See [embedded completion](https://docs.stripe.com/payments/checkout/custom-success-page?payment-ui=embedded-page)
and [payment-method domains](https://docs.stripe.com/payments/payment-methods/pmd-registration?dashboard-or-api=dashboard).

## Recommended next work

1. Correct/reconcile the two event failures and verify the existing subscription.
2. Decouple customer confirmation from reporting-worker latency.
3. Add secure email prefill and embedded checkout, then update the shared SDK,
   OpenAPI and hosted developer guide together.
4. Verify authenticated status/ownership, idempotent retries, no-charge protection,
   delayed responses and eligible wallet UI before another supervised test.

Retain the original `bc-learn-funnel` Vercel app and existing Sites publication.
No app entitlement, real-money billing, renewal normalization, refunds/disputes
or payout acceptance is established by this single no-charge subscription.
