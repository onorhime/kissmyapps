# BC Learn checkout preflight — September 6, 2026

Historical preflight release. Checkout was subsequently enabled with explicit
user approval; see [checkout enablement](RELEASE_EVIDENCE_2026-09-06_CHECKOUT_ENABLEMENT.md).
The disabled state below describes this preflight release, not the current gate.

The live discount and limited Stripe read-access checks passed. Checkout remains
disabled. No Stripe Checkout session, subscription, charge, customer, promotion
redemption, webhook change or provider write was initiated in this release.

## Released

Supabase project: `mmyruzjemjecqyivhrgr`.

| Function             | Version | Function ID                            | Deployed bundle `ezbr_sha256`                                      |
| -------------------- | ------- | -------------------------------------- | ------------------------------------------------------------------ |
| `checkout-preflight` | 3       | `eb5fb504-1022-46fe-87fd-96836236d436` | `f088099e465e0246bb66f5a70b3d88ce5374c94c10020156129f6f8f4c3274b7` |
| `checkout-session`   | 14      | `08d9a2a3-34c2-4429-a643-92ce2fe4c67f` | `3c83e7effc0172bb54336bf3e9fd7159c7bd123ff844a84fca103e0f62bf562c` |

The new preflight function accepts only an empty POST with the existing dedicated
scheduler credential, checked internally with constant-time comparison. Gateway
JWT verification is disabled, but unauthenticated requests are rejected before
any Stripe request. The function is not scheduled. It contains fixed BC Learn
identifiers, accepts no caller-owned URLs or object IDs, and makes only bounded
GET requests to Stripe using the existing hosted restricted live key. Provider
payloads, customer data and keys are never returned. No Stripe key was exported
from Supabase, and no hosted credentials or secret digests changed.

The only source difference from the downloaded prior `checkout-session` bundle
was `_shared/free-checkout.ts`: explicitly expand `promotion.coupon.applies_to`
and reject omitted applicability data. Stripe documents coupon applicability as
an expandable field; omitting it cannot establish that a coupon is unrestricted.
The validation now fails closed when the field is absent, while explicit null
retains its existing unrestricted meaning. The real BC Learn coupon is scoped
to the exact BC Learn Stripe product. See the
[Stripe coupon object](https://docs.stripe.com/api/coupons/object).

The checkout handler, zero-total requirement and all other shared dependencies
were unchanged. The 11 TypeScript files in the downloaded current checkout
bundle and 9 in the preflight bundle byte-match the local source. All other
hosted function bundle hashes were unchanged. No migration, Vercel, Hostinger,
Sites or dashboard UI deployment was performed.

## Live read-only acceptance

Preflight snapshot: **2026-09-06 11:54:28 UTC**.

- BC Learn product: `fdbabb87-9743-4521-bc8d-11804fe1185f`.
- Stripe product: `prod_VCii4guzoryBtZ`.
- Price: `price_1UCJHDE47mNwFlz1NEFOTxtB`, active/live, USD 100 minor units,
  recurring monthly.
- Coupon: `eHVv5Ucg`, valid, 100% off forever, applies only to BC Learn.
- Promotion: `promo_1UCbsJE47mNwFlz1xm9WkRWY`, active and not expired.
- Coupon and promotion each allow one redemption and have zero redemptions.
- No customer-specific, first-transaction or minimum-amount restriction.
- Exact production checkout discount validator passed against the live GET
  responses. The backend applies the configured promotion automatically.
- Price, coupon and promotion reads returned HTTP 200.
- Invoice Payments read returned HTTP 200 with an empty list, scoped to future
  creation timestamps and limit 1 so no existing shared-account payment records
  were fetched. The filter is supported by the
  [Invoice Payments list API](https://docs.stripe.com/api/invoice-payment/list).
- Nonexistent-ID reads for Subscriptions, Invoices, Charges, PaymentIntents and
  BalanceTransactions returned HTTP 404 `resource_missing`, not HTTP 401/403.
  These are limited probes, not proof that a real object can be processed.
- Unauthenticated preflight returned 401; authenticated arbitrary input returned 400. Both stop before provider access.

All provider requests used source-pinned API version `2026-02-25.clover`.
**Checkout Sessions write permission was not exercised.** Read success cannot
prove write permission; Stripe enforces the configured restricted-key grants.
See [Stripe API keys](https://docs.stripe.com/keys).

Product, billing-offer, agreement, document and cron fingerprints were unchanged.
Checkout attempts, provider events, subscriptions, transactions and commissions
remained zero. No business history was deleted or rewritten.

Final offer-only and scheduler snapshot: **2026-09-06 11:55:52 UTC**.

- Funnel offer endpoint returned HTTP 200, `monthly` v1, $1/month.
- `checkoutEnabled=false`; the checkout endpoint was not called.
- The existing public click ID was reused; no tracking link was clicked and no
  new click was fabricated. The offer read can refresh quote/rate-limit state.
- Scheduler enabled, `attentionRequired=false`.
- Stripe, commercial and metrics queues all had zero pending, processing,
  failed and expired-lease counts.

## Local validation and evidence

- `pnpm test:edge`: format, lint, type checks and **126 tests passed**.
- Six new preflight tests cover authentication, parameter rejection, GET-only
  allowlisting, output redaction, invalid binding/key, discount restrictions and
  unavailable/denied reads. The future-only Invoice Payments request is asserted.
- Discount and Checkout regression tests reject omitted coupon applicability;
  the focused preflight/discount/checkout run passed 16 tests.
- Three release-guard tests passed; Node syntax, scoped formatting and
  `git diff --check` passed.

Sanitized machine evidence and source backups are in the ignored directory
`.cache/release-backups/20260906-checkout-preflight/`: `before.json`,
`deployment.json`, `readiness.json`, `checkout-scope-release.json`,
`final-acceptance.json`, `deployed-checkout/`, `deployed-preflight/`, and
`rollback-checkout/`. Intermediate preflight versions are preserved separately.
The final acceptance supersedes their earlier inconclusive checks.

Read-only operator rerun:

```bash
node scripts/check-bc-checkout-readiness.mjs --check
```

The script reads the existing operator credential into memory, never the Stripe
key. It compares secret digests and business fingerprints before/after, saves
only sanitized results, and neither enables checkout nor creates provider data.

## Next gate and limits

Obtain approval to enable the funnel's gated checkout for the user's supervised
zero-total test. The actual Checkout creation will establish write access; the
user must see $0 due before completing it. Do not proceed if Stripe shows an
amount due. Then verify real Stripe delivery, normalization and partner state.
The first subscription is expected to be free and must not generate a paid
purchase or paid commission. Any cancellation is a separately scoped action.

The coupon has only one available redemption. A later run requires checking its
remaining use again; never silently fall back to a paid checkout. Actual Stripe
delivery, real-object normalization, paid billing, refunds/disputes,
entitlements, reconciliation and payout release remain unproven by this
read-only preflight. Healthy empty queues are not financial acceptance proof.

## Rollback reference

The prior checkout bundle was observed as version 13 with hash
`490ec517d6fc34643879656ba9bb73a86baeb5e7ffff0731d5ba529d21eaf62b`.
Its exact downloaded source is preserved in `rollback-checkout/`. Keep checkout
disabled if an issue appears; prefer a forward fix to removing the new
fail-closed applicability guard. Do not restore the old bundle while a test is
open. The protected read-only preflight can remain unused; deletion requires a
separate request. No financial rows or credentials need restoration.
