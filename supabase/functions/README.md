# Production Edge Function foundation

These functions target the linked KissMyApps production Supabase project. They
contain no sandbox mode or seed data. All ten functions were deployed manually
on 2026-08-28; there is no automatic CI deployment.

Public boundaries:

- `tracking-redirect`: records a click through the service-only
  `register_tracking_click` RPC, then redirects with an opaque `kma_click`.
- `browser-events`: accepts only the four non-commercial browser events enforced
  again by `ingest_browser_event`.
- `funnel-events`: verifies the exact raw body with the `x-kma-*` HMAC headers
  before calling `ingest_funnel_event`.
- `checkout-session`: accepts the same server-only HMAC contract, resolves an
  active server-owned subscription offer from the click acquisition, and creates
  an idempotent live Stripe Checkout Session. Its direct Stripe call has an
  eight-second abort deadline. Browser-supplied price, amount, currency, mode,
  and redirect values are rejected.
- `stripe-price-verifier`: accepts only an allowlisted production Admin origin
  and password-proven Owner/Operations session, loads the expected draft offer
  from the database, verifies the Price directly against Stripe live mode, and
  records the matching service-only attestation. Its direct Stripe call has an
  eight-second abort deadline. The browser supplies only the offer UUID.
- `stripe-webhook`: verifies Stripe's exact raw-body signature, accepts only the
  documented live-mode event allowlist, computes an exact-body SHA-256 digest,
  and stores only the normalization fields in the immutable provider-event
  queue. It does not persist the raw body or customer contact, address, or
  payment details. Reuse of a Stripe event ID with a different digest fails as
  an identity conflict; an exact retry remains idempotent.

Authenticated worker boundaries:

- `stripe-worker`: leases signature-verified provider events and normalizes
  supported subscription Checkout, subscription, paid-invoice, succeeded-refund,
  and dispute evidence into canonical database facts. Unsupported or incomplete
  provider shapes fail closed. Each invocation leases at most eight events for
  90 seconds, stops starting new items after 45 seconds, and gives every direct
  Stripe request an eight-second abort deadline. A claimed remainder is reported
  as `deferred` and becomes claimable again when its lease expires.
- `commercial-worker`: creates deterministic purchase conversions and
  integer-minor-unit CPA, revenue-share, or hybrid ledger entries only when one
  effective agreement, active rule, and bilaterally signed document match. It
  also applies refund/dispute reversals without rewriting history.
- `metrics-worker`: refreshes partner daily metrics from canonical facts.
  Singular data remains explicitly unavailable until that integration exists.
- `reconciliation-worker`: compares canonical totals to separately recorded,
  immutable provider evidence. It does not invent or fetch a Stripe provider
  total. A valid completed comparison whose totals disagree is a business
  failure, returned as `business_failed` and emitted as a structured operational
  diagnostic.

Stripe compatibility is source-pinned to `2026-02-25.clover` for every direct
REST request. Configure the production webhook endpoint to render events with
that exact API version. A signed event with a different explicit `api_version`
is rejected. Stripe documents `Event.api_version` as nullable for events created
before 2014-10-31, so a missing/null version is accepted for legacy replay and
emits a metadata-only warning instead of being rejected. See Stripe's
[API versioning](https://docs.stripe.com/api/versioning) and
[Event object](https://docs.stripe.com/api/events/object) documentation.

Worker failure diagnostics are JSON objects containing only bounded operational
metadata such as worker name, outcome, non-sensitive internal IDs, event type,
attempt count, error code, and request ID. They never include webhook payloads,
claim tokens, authorization headers, Stripe secrets, HMAC values, or customer
data. HTTP error responses remain generic.

No worker schedules, approves a payout, or executes an external transfer. Worker
deployment also does not schedule invocation; production scheduling is a
separate activation step after live Stripe and operational configuration exist.

Required hosted secrets/configuration:

- `TRACKING_HASH_SECRET` (32 or more characters)
- `ADMIN_ALLOWED_ORIGINS` (exact production dashboard HTTPS origin)
- `BROWSER_EVENT_ALLOWED_ORIGINS` (comma-separated production HTTPS origins)
- `FUNNEL_HMAC_BINDINGS` (JSON object keyed by `x-kma-key-id`; every value has
  one 32+ character `secret`, exact `product_id`, and exact `funnel_id`)
- `FUNNEL_EVENT_ALLOWED_NAMES` (comma-separated event allowlist)
- optional `FUNNEL_EVENT_ALLOWED_PROPERTIES` (comma-separated property
  allowlist)
- `CHECKOUT_ALLOWED_REDIRECT_ORIGINS` (comma-separated production HTTPS origins)
- `STRIPE_SECRET_KEY` (a live-mode server key; never a browser variable)
- `STRIPE_WEBHOOK_SECRET`
- `INTERNAL_WORKER_SECRET` (32 or more characters)

The checked-in `.env.example` deliberately uses `INVALID` for secret values.
Generate real random values; the runtime rejects the example placeholders.

Configure the Stripe webhook endpoint for only the supported production event
contract and pin the endpoint to API version `2026-02-25.clover`:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `refund.created`,
`refund.updated`, `charge.dispute.created`, `charge.dispute.updated`, and
`charge.dispute.closed`.

Stripe privacy and retention:

- The signed raw request exists only in memory long enough to verify the HMAC,
  compute its SHA-256 digest, parse it, and build the allowlisted projection. It
  must not be logged or copied to telemetry. The digest is non-reversible and is
  retained only to prove exact retry identity. Immutable rows created before the
  digest migration remain unchanged, may contain the earlier full payload, and
  have a null digest; treat those legacy rows under the stricter historical-data
  access and retention policy.
- Persisted object fields are limited to Stripe identifiers, timestamps,
  statuses, integer amounts, currencies, KissMyApps attribution metadata, and
  dispute balance evidence required by `normalize_stripe_provider_event`. Names,
  emails, phone numbers, addresses, shipping/billing details, card or bank
  details, customer-provided descriptions, and unrelated metadata are discarded
  before the database call.
- The service role has no direct access to the provider tables. One
  security-definer RPC atomically inserts the minimized event and processing
  record, accepts an exact digest/payload retry, and rejects a reused Stripe
  event ID whose signed bytes differ.
- `provider_events` is append-only financial and dispute evidence. Retain the
  minimized rows and digests only for the accounting, dispute, fraud, and legal
  period approved by Finance/Legal. This repository does not silently delete
  immutable evidence; an approved archive or expiry policy must use a separate,
  audited operations process and must preserve canonical facts that still have a
  retention obligation.

Supabase supplies `SUPABASE_URL` and either its current secret-key map or the
legacy service-role key to hosted functions. Secrets must never be placed in the
frontend environment or committed to this repository.

Funnel HMAC canonical input is:

```text
<unix_timestamp>.<nonce>.<exact_raw_request_body>
```

The signature is lowercase HMAC-SHA256 hex in `x-kma-signature`, with
`x-kma-key-id`, `x-kma-timestamp`, and `x-kma-nonce` also required. After
signature verification, the database independently confirms that the opaque
click belongs to the configured product/funnel binding. A key for one funnel
cannot submit events or create Checkout for another funnel. Rotate a key by
briefly configuring two key IDs with the same scope, then remove the old key
after callers switch.

Validation:

```bash
deno fmt --check supabase/functions supabase/config.toml
deno lint --config supabase/functions/deno.json supabase/functions
deno check --config supabase/functions/deno.json \
  supabase/functions/{tracking-redirect,browser-events,funnel-events,checkout-session,stripe-price-verifier,stripe-webhook,stripe-worker,commercial-worker,metrics-worker,reconciliation-worker}/index.ts
deno test --config supabase/functions/deno.json --allow-env supabase/functions
```
