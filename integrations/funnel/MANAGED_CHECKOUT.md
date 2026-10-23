# KMA-managed one-time checkout (local implementation)

This path lets a product create a programme purchase or reserve a matched place, then ask KMA to collect a one-time payment through the Stripe account configured for that integration. KMA owns the verified billing offer and sends signed payment snapshots back to the product. The product owns matching, reservation capacity, enrolment and access. Existing KMA agreements, commission rules, eligibility, refund cutoffs and admin-approved creator payouts remain authoritative. This does not add product-owner settlement or move money between Stripe accounts.

All switches default off. Nothing in this implementation enables production checkout, creates a Stripe Price/account, registers a webhook, deploys a worker or sends a real payment/refund/transfer. The test transport refuses external network calls.

## Configuration

`MANAGED_CHECKOUT_BINDINGS_JSON` is a server-only map from integration ID to:

```json
{
  "speaksix-test": {
    "secret": "separate-inbound-secret-at-least-32-characters",
    "product_id": "00000000-0000-4000-8000-000000000001",
    "funnel_id": "00000000-0000-4000-8000-000000000002",
    "account_id": "acct_example",
    "livemode": false,
    "stripe_key_env": "MANAGED_TEST_STRIPE_SECRET_KEY",
    "webhook_secret_env": "MANAGED_TEST_STRIPE_WEBHOOK_SECRET",
    "callback_url": "http://127.0.0.1:3200/api/marathon/kma-webhook",
    "callback_key_id": "speaksix-test-callback",
    "callback_secret": "separate-outbound-secret-at-least-32-characters",
    "redirect_origins": ["http://127.0.0.1:3200"]
  }
}
```

Use the product's actual configured callback route. HTTP callbacks/returns are permitted only for loopback test bindings. Live bindings require HTTPS. Stripe secret keys and Price attestations are isolated by account and mode. `MANAGED_CHECKOUT_ENABLED=true` allows new quote/create requests; `MANAGED_CHECKOUT_WORKER_ENABLED=true` enables reconciliation and callback delivery. Worker authentication uses `INTERNAL_WORKER_SECRET` (at least 32 characters). Product opt-in (`managed_payment_products.enabled`) is also required, and defaults false.

A password-confirmed admin verifies a draft one-time offer through `managed-price-verifier`, with `{billing_offer_id,binding_id,stripe_price_id}`. The server reads the configured Stripe account and verifies an active, one-time, per-unit Price with the saved amount/currency. It records proof for the exact offer version, account and mode. The same commercial offer can have separate test/live Price mappings. An edited offer invalidates old proof. Activation requires managed opt-in and current proof; checkout requires proof for its exact binding. Existing subscription verification/launch behavior is unchanged.

## Server contract

POST `/functions/v1/managed-checkout`; never call it from the browser. Sign the exact JSON bytes with HMAC SHA-256 over `timestamp.nonce.body`. Headers: `x-kma-key-id`, `x-kma-timestamp`, `x-kma-nonce`, `x-kma-signature` (hex). Browser Origin requests are rejected.

- `quote`: `{action:"quote",offer_key}` returns `{accepted:true,checkout_enabled:true,offer:{key,version,name,billing_mode:"payment",currency,unit_amount_minor}}`.
- `create`: `{action:"create",request_id,order_id,attempt_id,learner_id,reservation_id,reservation_expires_at,checkout_expires_at,offer_key,offer_version,amount_minor,currency,success_url,cancel_url,context:{calendar_hash,registration_id,cohort_id},customer_email?,click_id?,attribution?}`. `request_id` equals `attempt_id`; UUIDs identify the immutable attempt and business order. The reservation ID is its calendar hash. `reservation_expires_at` is the immutable business reservation deadline; `checkout_expires_at` is the individual session deadline and may change only for a fresh attempt after verified expiry. The product validates its applicable enrollment rules before signing. Amount and version are assertions against KMA's saved offer, never a client-defined price. Organic buyers need no affiliate click. If provided, click/attribution must agree with KMA's product/funnel scope.
- For pay-first programme purchases, `context` is instead exactly `{purchase_id,intake_id,terms_hash}`. `purchase_id` must equal `order_id`; `terms_hash` must equal `reservation_id` and binds the frozen programme dates, duration and price. No registration, assessment or cohort is required at checkout. `learner_id` may be a stable purchase-scoped identifier until the product verifies and claims the buyer account. Mixing the two context formats is rejected. The product checks enrollment cutoff before checkout and handles any verified late capture through its refund policy.
- `status`: `{action:"status",order_id,attempt_id}`.
- `expire`: `{action:"expire",request_id,order_id,attempt_id}` with its own stable operation UUID.
- `refund`: `{action:"refund",request_id,order_id,attempt_id,amount_minor,reason,refund_remaining?}` with its own stable operation UUID. Full or partial refunds may not exceed verified remaining payment. For full cancellation, send `refund_remaining:true` and the original order total as the immutable amount assertion; KMA freezes the currently refundable balance on the first operation so retries cannot silently change intent. A pending refund retains its provider identity and a durable revision without claiming refunded funds.

Order actions return `{accepted:true,order}`. Order snapshots include KMA ID, external order/attempt IDs, binding product/funnel/account/mode, immutable learner/reservation/context and offer key/version/amount/currency, session/payment IDs, expiry, status, paid time, cumulative successful refunds, latest refund identity/status, dispute status, duplicate-capture flag and monotonic revision. Private email/input, keys and internal reconciliation fields are excluded.

Statuses are `creating`, `open`, `processing`, `paid`, `expired`, `partially_refunded`, `refunded`, `disputed`. Card-only Checkout avoids introducing delayed-payment methods. A completed but unpaid provider session remains processing; it cannot open a replacement payment. Reservations need at least 31 minutes remaining at first creation. Session expiry must be between 31 minutes and 23 hours 55 minutes away and cannot exceed the reservation.

## Recovery and reconciliation

Persist the exact create request and attempt ID before sending it. A lost reply must recover the same attempt through status or the same exact create request. Status 404 is not proof that a provider payment failed: retry the original create identity, not a new attempt. KMA preserves existing frozen attempts when the current catalog changes. Renewed attempts for the same unexpired business reservation retain the agreed offer version and Price, which the provider re-verifies before creating a new session. A new attempt for the same business order requires all prior attempts to be definitively expired. The first verified capture owns the business purchase; late captures on prior attempts are marked duplicate and never award another commission. The product refunds duplicates rather than granting more access.

Provider mutations have stable idempotency keys and a 23-hour retry boundary; older unresolved writes require reconciliation/manual attention rather than blind recreation. Current Stripe session, PaymentIntent, Charge, refund and dispute objects are retrieved and verified before accepting payment truth. The worker retries failures with durable backoff, and scans paid orders for 180 days. Webhooks remain the primary path for later refund/dispute changes.

`managed-checkout-webhook?binding_id=<integration>` verifies Stripe's raw-body signature and exact test/live scope. Register checkout completion/expiry/async payment events, refund created/updated, charge refunded and dispute created/updated/closed when explicitly activating the integration. Webhook delivery is safely repeatable.

The outbound worker signs `{version:1,event_id,type,occurred_at,product_id,funnel_id,account_id,livemode,order}` using the separate callback key/secret. Types: `order.paid`, `order.expired`, `order.refunded`, `order.partially_refunded`, `order.disputed`, `order.dispute_closed`. It omits the checkout URL. The product must validate exact scope and immutable order fields, persist event/revision idempotently, and reply `{accepted:true,event_id:<same UUID>}` only after durable acceptance. All failed HTTP statuses (including 400), network failures and incorrect acknowledgements retain the same event for retry. Out-of-order revisions cannot restore old access.

Commission awards reuse `ingest_external_commerce` and verified basis evidence. Refund/dispute evidence reaches the existing canonical adjustment pipeline before optional fee enrichment. Matching/cohort confirmation still determines product eligibility; a paid redirect alone does not grant commission eligibility or learner access.

## Local checks and release boundary

- `deno test --allow-env --config supabase/functions/deno.json supabase/functions/managed-checkout/index_test.ts supabase/functions/managed-checkout/edges_test.ts supabase/functions/managed-price-verifier/index_test.ts`
- `node scripts/test-database-native.mjs` creates/discards an isolated local PostgreSQL cluster.
- `pnpm test:managed:crossapp` exercises both application databases, real KMA handlers/worker and SpeakSix adapter with a synthetic Stripe transport.

Production activation still requires deployment/migrations, configured secrets and exact account/mode Price proofs, a scheduled authenticated worker invocation, registered provider webhooks, current Stripe account capabilities and an authorized Stripe test-mode rehearsal before enabling live checkout. Local synthetic acceptance is not evidence of a real charge, bank payout or hosted deployment.

Managed checkout reconciliation now has a separate disabled-by-default database scheduler with durable run ownership, bounded work and private health reporting. Deployment/monitoring/recovery instructions: [`docs/MANAGED_CHECKOUT_SCHEDULER_RUNBOOK.md`](../../docs/MANAGED_CHECKOUT_SCHEDULER_RUNBOOK.md). The new worker requires migration `20261018100000_managed_checkout_schedule.sql`; it remains independent of sales and creator payout enablement.
