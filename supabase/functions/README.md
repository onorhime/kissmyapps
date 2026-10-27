# Production Edge Function foundation

These functions target the linked KissMyApps production Supabase project. They
contain no sandbox mode or seed data. Deployment is manual; local entrypoints
are not a hosted inventory. The 2026-09-04 audit verified eleven hosted
functions, but that historical inventory does not prove later local changes have
been deployed. See the dated audit repair evidence for release status.

Public boundaries:

- `merchant-connect`: only `request_invitation_code` permits a pre-sign-in POST,
  authorized by a valid invitation bearer token. It checks the exact recipient
  portal and uses service-only rate/deduplication RPCs before sending a normal
  Supabase Auth code to the saved invitation email. It accepts no caller email,
  account, metadata or redirect. All other merchant/admin/OAuth actions retain
  verified-user authentication and their existing role/invitation checks. This
  path requires migration `20261019100000_merchant_invitation_otp`; its presence
  in source does not establish deployment. See
  `docs/merchant-connections-local.md`.

- `funnel-checkout-context`: new server-HMAC endpoint for verified paywall
  descriptors and receipt-scoped webhook-backed checkout status. It requires
  migration `20260905110000_funnel_checkout_context` before deployment; its
  source presence does not mean it is hosted. See
  `integrations/funnel/API_CONTRACT.md`.

- `tracking-redirect`: accepts the original `/r/<affiliate-slug>/<public-code>`
  addresses and additional stable `/<product>/<creator>[/<link-name>]`
  addresses. Unicode public names are retained; extra suffixes resolve actual
  collisions. The service-only `register_short_tracking_click` resolves an
  immutable alias and delegates to the same `register_tracking_click` boundary,
  preserving all eligibility checks and attribution before redirecting with an
  opaque `kma_click`. Readable routes require migration
  `20261018120000_readable_creator_links` and the corresponding gateway routes.
  Deleted or archived targets do not release their addresses for reuse.
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

- `checkout-preflight`: operator-only BC Learn readiness diagnostic, not a
  scheduled worker. An empty POST authenticated with the existing
  `PROCESSING_SCHEDULER_SECRET` performs only fixed, bounded Stripe GETs using
  the hosted key. It checks the exact $1/month offer and one-use, product-bound
  100%-off recurring promotion, accepts no caller-selected IDs or URLs, and
  never creates Checkout or changes configuration. The cron does not invoke it.
  Run `node scripts/check-bc-checkout-readiness.mjs --check` for the sanitized
  report. Successful reads do not establish Checkout write permission or real
  webhook delivery. See `RELEASE_EVIDENCE_2026-09-06_CHECKOUT_PREFLIGHT.md`.

- `agreement-notify`: authenticates an empty maintenance request and leases
  committed milestone/recipient outbox jobs. Exact email envelopes are frozen
  before sending with per-job idempotency keys. It also processes explicitly
  queued unreferenced document cleanup. The 2026-09-05 version requires the
  audit migrations, a rotated credential, and explicit schedule activation; it
  cannot be rolled out as a function-only update to the old schema.

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
- `processing-dispatch`: authenticates the dedicated scheduler credential and
  atomically claims only the current database-issued stage before invoking one
  of the three workers above. No arbitrary URLs, reconciliation calls or
  checkout calls are accepted. See `PROCESSING_SCHEDULER_RUNBOOK.md` for the
  sequential minute tick, health thresholds and pause/recovery procedure.
- `processing-alerts`: independent operational email monitor. It accepts only an
  empty POST with its dedicated alert credential, observes processing health and
  leases one server-owned notification. Frozen envelopes and stable Resend
  idempotency keys prevent duplicate logical sends within the bounded retry
  window. It cannot accept arbitrary recipients or restart workers. Deployed
  September 7 with a separate minute cron; see
  `RELEASE_EVIDENCE_2026-09-07_PROCESSING_ALERTS.md`. Provider acceptance is not
  inbox-delivery proof, and this is not outside-Supabase outage monitoring.
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
- `BROWSER_EVENT_ALLOWED_ORIGINS_EXTRA` (optional; more origins, added without rewriting the list above)
- `EXTERNAL_COMMERCE_HMAC_BINDINGS` (JSON object keyed by `x-kma-key-id`; every
  value has one 32+ character `secret`, exact `product_id`, and exact
  `funnel_id`)
- `FUNNEL_EVENT_ALLOWED_NAMES` (comma-separated event allowlist)
- optional `FUNNEL_EVENT_ALLOWED_PROPERTIES` (comma-separated property
  allowlist)
- `CHECKOUT_ALLOWED_REDIRECT_ORIGINS` (comma-separated production HTTPS origins)
- `STRIPE_SECRET_KEY` (a live-mode restricted `rk_live_` server key is
  preferred; standard `sk_live_` is also supported; never a browser variable)
- `STRIPE_WEBHOOK_SECRET`
- `INTERNAL_WORKER_SECRET` (32 or more characters)
- `PROCESSING_SCHEDULER_SECRET` (separate credential, matched to the encrypted
  Vault secret `kma_processing_scheduler`; never include its value in migration
  history, cron commands or local environment files)
- `PROCESSING_ALERT_SECRET` (separate notification credential, matched to the
  encrypted Vault secret `kma_processing_alerts`; provision out of band, never
  include its value in source, cron commands or local environment files)
- `AGREEMENT_NOTIFY_SECRET` (separate random credential, matched to the private
  database `agreement_notify` setting; provision out of band, never in SQL
  source)
- `RESEND_API_KEY` and optional `AGREEMENT_EMAIL_FROM`

The checked-in `.env.example` deliberately uses `INVALID` for secret values.
Generate real random values; the runtime rejects the example placeholders.

Restricted Stripe key compatibility uses `_shared/stripe-auth.ts`. This only
validates a live server-key format; Stripe still enforces resource permissions.
Test-mode, publishable, missing and malformed keys are rejected, with no
fallback to another credential and no key values in errors. The price verifier
needs Prices read permission. Checkout additionally needs Checkout Sessions
write and the discount reads used by `_shared/free-checkout.ts`; the
normalization worker needs the subscription/invoice/payment reads it performs.
Verify those permissions before enabling the funnel. Do not grant payouts,
transfers or refund write access for these flows, and do not reuse or change
unrelated integrations' credentials.

For deployment state, see the dated restricted-key release evidence. A local
compatibility edit does not mean every affected checkout/worker has been
deployed.

Configure the Stripe webhook endpoint for only the supported production event
contract and pin the endpoint to API version `2026-02-25.clover`:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `refund.created`,
`refund.updated`, `charge.dispute.created`, `charge.dispute.updated`, and
`charge.dispute.closed`.

Stripe privacy and retention:

- Before persistence, `stripe-webhook` verifies ownership against committed
  KissMyApps Checkout attempts, canonical subscriptions and charge evidence. A
  product ID alone is not proof. Unknown invoice/refund/dispute references use
  bounded, ID-scoped read-only Stripe lookups so out-of-order delivery is not
  discarded just because normalization has not run. The service-only
  `stripe_webhook_owns_reference` RPC returns only a boolean and grants no
  direct table access. Unrelated signed events return 200 `ignored: true`
  without a DB event/processing row. Inconclusive lookups return 503 for Stripe
  to retry. Financial normalization still reconciles the full immutable
  attribution and commercial evidence; ingress ownership does not replace those
  checks.
- Ownership fallback needs read access to Subscriptions, Charges, Invoices and
  Invoice Payments on the existing restricted live Stripe key. It never lists
  events/customers account-wide or creates provider objects. All provider GETs
  share a seven-second timeout budget. Raw lookup responses are never logged or
  persisted. Verify these permissions before enabling checkout.
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
  supabase/functions/*/index.ts
deno test --config supabase/functions/deno.json --allow-env supabase/functions
```

`pnpm validate:all` runs frontend/build and Edge checks. The separate, explicit
`pnpm test:db:audit` applies pending audit definitions and bounded synthetic SQL
fixtures against the exact hosted project in one rollback-only transaction. It
never invokes HTTP/email delivery or starts a local Supabase instance. Do not
run the older entire database suite against production: other test files contain
extension setup or commits.

### Generic order eligibility

`funnel-order-eligibility` reuses `EXTERNAL_COMMERCE_HMAC_BINDINGS` and accepts
server-verified order identity and service state. It is separate from reporting
metrics: only explicitly signed canonical rules that opt into
first-purchase/fulfilment requirements use it to hold/release eligibility. See
[the local implementation and contract](../../docs/workflow-tracking-eligibility-local-2026-10-15.md).
Deployment of the function and migrations is not automatic.
