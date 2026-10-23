# Second no-charge checkout preparation — 2026-09-07

## Authorized preparation completed

Created in the existing Futura Funds Inc. live Stripe account through its dashboard:

- Coupon `Kc9faGnA`: BC Learn inline no-charge test Sep 07.
- Promotion `promo_1UCzV4E47mNwFlz1P3dsXuUT`: `BCLEARN-INLINE-SEP07`.
- 100% off forever, restricted to `prod_VCii4guzoryBtZ` (BC Learn Test).
- Coupon AND promotion limited to one redemption; both unused (0/1).
- No customer, minimum, first-order or expiry restriction.

Connected only BC Learn's `FREE_CHECKOUT_PROMOTION_BINDINGS` entry after proving
the previous secret digest exactly matched the known single-entry old mapping.
All other secret digests preserved. Updated only the protected, GET-only
`checkout-preflight` diagnostic's exact coupon/promotion IDs. Other function
bundle hashes preserved. No Vercel or dashboard deployment performed.

At `2026-09-07T10:13:00.549Z`, live preflight returned `discountReady: true` and
passed the real shared checkout discount validator. All six term checks passed;
unauthorized request 401, arbitrary input 400. Price remains active USD 100 minor
units monthly. Six diagnostic tests passed using the functions Deno config;
format and JavaScript syntax checks passed.

The preparation created no Checkout Session, subscription or charge. Database
counts remained: one checkout attempt, three provider events, one subscription,
zero transactions, zero commission entries. Product, offer, agreement, document
hashes and scheduler control state remained unchanged. Old coupon/subscription
were not edited. The new discount is server-applied; users do not need to type it.

## Original test rechecked in the live database

The original non-bot click joins to BC Learn, source TikTok and placement
`profile_bio`; product/funnel/partner/source match the subscription acquisition.
Recorded browser events: `landing_viewed`, `funnel_started`, `payment_viewed`.
Recorded normalized provider events: `checkout.no_payment_required`,
`subscription.active`, `invoice.no_payment_required`.

All three original Stripe receipts have processed status and null errors.
Partner/product daily metrics for September 6 contain four clicks (the day's
aggregate, not four clicks asserted for this visit) and zero paid purchases.
Zero transactions/commissions are correct for a fully discounted subscription.
This proves recovered persistence and attribution, not a clean original UX pass,
positive-payment accounting or acceptance of the newly embedded checkout UI.

## New current blocker — do not call the next test ready

The earlier release evidence describes health at its earlier checkpoint. The
fresh health check found a subsequent failure at `2026-09-07T09:17:00Z`:

- metrics-worker invocation HTTP 502; processing-dispatch HTTP 503.
- Scheduler run `409f4981-dad5-4fbd-817e-87811be6ad37` was marked failed.
- Scheduler disabled with `paused_reason: worker_http_failure` and its in-flight
  identity preserved; cron heartbeat continues while paused.
- All three work queues have zero pending, processing, failed or expired leases.
- Exact function runtime log query for the failure window returned no rows;
  the underlying 502 cause has NOT been established.

No scheduler reset, worker invocation, event replay or automatic recovery was
performed during this preparation. Recovery requires inspection and explicit
approval as described in `PROCESSING_SCHEDULER_RUNBOOK.md`. Keep failed-run
history and all financial evidence intact.

Next acceptance: recover the scheduler, verify a full healthy cycle, then one
user-completed fresh inline $0 checkout to validate email prefill, inline
completion, automatic confirmation and subsequent partner reporting.
Positive-payment/commission/refund/payout, wallet/device and app-entitlement
acceptance remain separate and unproven by this no-charge test.

Follow-up: user-approved scheduler recovery completed at 10:27 UTC. All three
scheduled stages passed HTTP 200, queues remained empty and health attention
cleared. See `RELEASE_EVIDENCE_2026-09-07_SCHEDULER_RECOVERY.md` for the exact
control-row audit and preservation checks. The historical failure above remains
part of the record; no error history was erased.
