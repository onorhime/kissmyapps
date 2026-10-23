# External one-time purchases: SpeakSix Marathon

Status: implemented locally; canonical agreement and refund-policy integration updated 15 October 2026. The endpoint, migrations, merchant scope and keys have **not** been deployed or configured on hosted KMA. No live Stripe requests, transfers or payouts were made. Synthetic commissions and transfers are exercised only in isolated local fixtures.

## Why this endpoint exists

The later local commission implementation is documented in [Creator Connect and external commissions](../../docs/CREATOR_CONNECT_LOCAL.md). Raw commerce receipts still return `commission_status:"held"` for compatibility; calculated earnings and approved transfers now live in separate, scoped settlement tables. A held receipt alone never authorizes payment.

The existing KMA `funnel-events` endpoint accepts nonfinancial funnel evidence. Its successful `event_id` is the internal KMA receipt UUID, not the submitted external UUID. Its caller must retain both IDs.

KMA's existing checkout/Stripe worker handles KMA-owned subscription checkout attempts and rejects `mode=payment`. SpeakSix owns its separate one-time Marathon checkout and Stripe merchant. Routing that payment through `funnel-events` or the subscription worker would bypass the correct ownership contract.

The new `POST /functions/v1/external-commerce` accepts `purchase` and `refund`. It uses the same exact-body HMAC header format as `funnel-events`, but a separately configured key and merchant scope. It independently reads the configured Stripe account, Checkout Session, PaymentIntent and (for refunds) Refund before recording evidence. All provider requests are GET requests to the fixed Stripe API origin, with redirects disabled.

## Exact request and response

Send these fields only:

```json
{
  "event_id": "a stable UUID for this logical delivery",
  "kind": "purchase",
  "click_id": "the captured opaque kma_click",
  "occurred_at": "2026-10-13T11:00:00Z",
  "order_id": "the immutable SpeakSix order UUID",
  "checkout_session_id": "cs_...",
  "payment_intent_id": "pi_...",
  "account_id": "acct_...",
  "livemode": false,
  "amount_minor": 17900,
  "currency": "USD",
  "attribution": {
    "kmaClick": "the same opaque kma_click",
    "status": "unverified",
    "capturedAt": "2026-10-13T10:00:00Z"
  }
}
```

For refunds set `kind` to `refund` and add `refund_id: "re_..."`. This HMAC Marathon contract accepts successful full refunds. It rejects partial or nonfinal refunds instead of interpreting them as complete reversals. The separate signed merchant webhook now records successful individual partial refunds and dispute lifecycles for the canonical settlement policy described below. `attribution` must be the full immutable SpeakSix order snapshot, including any allowed `ref`, `utmSource`, `utmMedium`, `utmCampaign`, `utmContent` fields. The handler hashes that exact canonical snapshot and compares it with **both** Stripe objects' `attribution_sha256` metadata. Sending a different click cannot reassign an existing payment.

Sign `<unix_timestamp>.<nonce>.<exact UTF-8 body>` with HMAC SHA-256, lowercase hex. Headers: `x-kma-key-id`, `x-kma-timestamp`, `x-kma-nonce`, `x-kma-signature`. Browser requests carrying `Origin` are rejected. Timestamp tolerance is five minutes.

Success returns `{accepted:true,event_id:<internal ledger UUID>,duplicate:boolean,commission_status:"held",request_id:string}`. Retry the identical external event ID and evidence after ambiguous network failure. Duplicate provider facts with new external IDs resolve to the same internal fact. Changed facts using an old event or order identity are rejected.

## Financial and attribution boundaries

- The signed key binds a specific product, funnel, Stripe merchant and test/live mode. SQL independently checks that the merchant scope is enabled and that the opaque click belongs to its product/funnel and a valid acquisition.
- KMA derives the affiliate and acquisition from its own click records. The caller cannot submit an affiliate, commission rate or payout destination.
- Stripe must show a completed, paid one-time session and matching succeeded PaymentIntent, amount, currency, order ID, merchant ID and attribution digest. Connect transfers/application fees are outside this contract.
- SpeakSix must send the session belonging to its **primary captured checkout attempt**, which may be a retry, rather than its first expired checkout session. Accidental duplicate captures/refunds do not create another attributed sale.
- The append-only ledger keeps one order, one purchase and one full refund fact. It accepts out-of-order refund/purchase delivery without double-counting. Evidence rows cannot be updated or deleted. Receipt aliases are immutable.
- Every order remains `commission_status=held`. The original held-commerce ledger does not calculate or pay commissions. The separate settlement worker now calculates awards from reviewed canonical policy; ingress alone creates no approved transfer or payout. The provider object creation timestamp is preserved separately from SpeakSix's recorded occurrence timestamp; neither is a contractual payout date.

## Activation prerequisites

Configure **after** the separate production approval:

1. Include `20261013100000_external_commerce_held_ledger.sql` and `20261014120000_external_commission_settlement.sql` in the reviewed dependency order before releasing this version of `external-commerce`. The current handler records verified commission basis through the latter migration. `20261014130000_creator_connect_receipts.sql` is additionally required for creator provider callbacks. The current source also requires `20261015100000_canonical_external_commercial_policy.sql`, `20261015110000_legacy_commission_refund_policy.sql` and `20261015120000_external_merchant_adjustment_receipts.sql`, in order. Review all intervening dependencies; this list is not a blanket release manifest. The ingress uses JWT verification disabled and requires its own HMAC authentication.
2. Set `EXTERNAL_COMMERCE_HMAC_BINDINGS` to a JSON map: `{keyId:{secret,product_id,funnel_id,stripe_account_id,livemode,stripe_read_key}}`. Use a dedicated long HMAC secret and a restricted read-only Stripe key (`rk_test_...` or `rk_live_...`) for the approved SpeakSix account. Required read access: account, Checkout Sessions, PaymentIntents, Charges, Balance Transactions, Refunds and Disputes. Do not use a general write/payout key.
3. Insert the exact product/funnel/account/mode row into `external_commerce_merchants`. Rows default to disabled; enable only the independently verified scope.
4. Configure SpeakSix's separate funnel and commerce endpoints/signing keys, selected merchant account/mode, and an explicit delivery release boundary. SpeakSix migrations install its evidence queue held by default. Historical events need deliberate review/release; stale funnel events cannot be redated to fit the seven-day API window.
5. Verify one real test-mode purchase/refund and attribution link before enabling live delivery. Test and live facts stay separated.
6. Separately approve the creator agreements, commission basis, attribution window, refunds/disputes policy, reporting presentation and payout process. The held ledger must not be treated as paid or approved earnings. No percentage has been assumed.

For another product, a server binding may provide `metadata_purpose`, for example `course_programme`. Its exact value must match both the Checkout Session and PaymentIntent metadata. Omission preserves the legacy `speaksix_marathon` value. Product/funnel/merchant attribution checks still apply; changing this label cannot bypass them.

The current ingress verifies the post-discount amount excluding tax and shipping from provider totals. It stores this as a separate immutable attestation, preserving existing receipt bytes on replay. Missing or inconsistent totals leave the basis unknown and commission on hold; they are never assumed to mean zero tax.

## Canonical policy and merchant adjustments — 15 October 2026

Commercial policy comes from the existing KMA product agreement and its signed purchase rule. The payout UI only binds that policy to the receiving merchant and intended funding platform; it does not maintain another commission rate, attribution window, hold, cadence or minimum. Existing signed policy-v1 fingerprints remain unchanged. New policy-v2 rules include an optional ordinary-refund cutoff and explicit commission basis.

An external purchase can use verified subtotal after discounts excluding tax/shipping, or the existing net-after-fees basis. For net-after-fees, the receiving merchant's same-currency Charge/Balance Transaction supplies fees. When Stripe has not yet attached the charge or balance-transaction reference, the endpoint preserves the idempotent purchase/basis receipt and returns a retryable 503. A referenced provider object that returns 404 is rejected with 409 before ingestion; that is not treated as the same pending-reference case. Retry the same external event and evidence. FX or incompatible fee evidence produces an explicit hold, never a guessed zero fee.

`external-commerce-webhook?binding_id=<merchant-binding-id>` verifies raw Stripe signatures and retrieves authoritative objects using the receiving merchant's credential. Configure `stripe_webhook_secret_env` on that existing HMAC binding and opt in with `EXTERNAL_COMMERCE_WEBHOOK_ENABLED=true` only after release approval. Keep funding-platform account/transfer/bank events on `creator-connect-webhook`; that endpoint no longer applies merchant refund policy.

The merchant endpoint supports successful individual refunds, including partial refunds, plus dispute lifecycle events. External policy uses the verified `PaymentIntent.created` timestamp as its purchase anchor, after checking paid/succeeded status. This can predate completion for delayed payment methods and is not a capture/settlement timestamp. Refund occurrence time (`Refund.created`) is compared with the purchase's frozen cutoff; late delivery does not extend it. New v2 awards use cumulative proportional corrections and stable incremental recovery jobs. Disputes are separate from the ordinary-refund cutoff: open evidence holds settlement, a verified won outcome can release the corresponding complete lifecycle hold, and lost disputes can reduce earnings. Conflicts and historical negative-evidence holds remain held for review, including historical v1 dispute and partial-refund cases.

Events received before attribution are persisted as immutable receipts and bound once to the exact merchant, mode, payment, order, product, funnel, amount and currency. Duplicate delivery cannot count a refund twice. Browser roles and service-role clients cannot directly rewrite that evidence.

The funding platform may be KMA while the receiving merchant is SpeakSix. This requires an approved `prefunded_platform` binding and sufficient KMA balance; it does not transfer money automatically from SpeakSix. All payout batches still require manual review and approval. See [Creator Connect operations](../../docs/CREATOR_CONNECT_LOCAL.md) for eligibility and activation gates.

## Local checks

Run the new handler tests without provider network permissions:

```sh
deno fmt --check --config supabase/functions/deno.json supabase/functions/external-commerce
deno lint --config supabase/functions/deno.json supabase/functions/external-commerce
deno test --node-modules-dir=manual --cached-only --config supabase/functions/deno.json --allow-env supabase/functions/external-commerce
node scripts/test-external-commerce-local.mjs
```

The native PostgreSQL runner requires `/opt/homebrew/opt/postgresql@17/bin`, applies every repository migration, and runs the new regression in a fresh temporary database. It replaces only the unavailable `pg_net` extension with a stub that rejects every HTTP attempt, then stops the database. It never connects to hosted Supabase. `--keep` leaves the isolated socket and synthetic KMA click ready for the SpeakSix connected HTTP test.

Start the actual KMA handlers on port 3203 with the printed socket:

```sh
deno run --node-modules-dir=manual --cached-only --config supabase/functions/deno.json \
  --allow-env --allow-run=/opt/homebrew/opt/postgresql@17/bin/psql \
  --allow-net=127.0.0.1:3202,127.0.0.1:3203 \
  supabase/functions/external-commerce/local-fixture.ts /tmp/kma-external-commerce-db.EXAMPLE
```

The fixture injects the SpeakSix Stripe fixture on port 3202; external network access is denied. Its HMAC ID is `speaksix-local`, test-only secret is `speaksix-local-kma-signing-secret-fixture-only`, and test click is `opaque_fixture_click_123456`. `/__fixture/status` reports synthetic counts. The SpeakSix `tests/marathon-attribution-http.mts` then exercises real admin release/worker routes, signatures, scope checks and both SQL stores. This fixture is not imported by the deployable endpoint.

### Completed connected rehearsal

On 13 October 2026 the connected local rehearsal passed through the real SpeakSix admin/worker routes, signed KMA handlers, and both native SQL stores:

- Registration, assessment, pool joining, group proposal and group confirmation each received their own KMA receipt.
- The first checkout expired; its replacement became the primary captured payment. The attributed purchase used that replacement session. A late duplicate capture was refunded and did not become a second attributed purchase.
- Cancelling only the synthetic financial-test group produced confirmed fixture refunds. The primary refund was independently verified by KMA and reversed the same attributed order.
- Final ledger for that order: **one purchase, one full refund, net 0 minor units, commission held**. Provider receipt IDs remained separate from SpeakSix delivery IDs.

From the SpeakSix checkout, after its connected HTTP test has created a new private evidence file:

```sh
node --experimental-strip-types tests/marathon-attribution-http.mts /tmp/speaksix-marathon-connected-EXAMPLE.json --financial
```

To test reversal, cancel only that new synthetic group using the local administrator and process integration jobs. Then:

```sh
node --experimental-strip-types tests/marathon-attribution-http.mts /tmp/speaksix-marathon-connected-EXAMPLE.json --financial --refund
```

Do not cancel another group's browser-acceptance fixture or restart either provider transport between purchase and refund checks. The evidence file contains temporary authentication cookies; keep it private and do not commit it. This rehearsal used no actual card, provider email, external API request or payout.
