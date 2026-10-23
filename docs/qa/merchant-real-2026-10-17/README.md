# Local merchant-direct Stripe TEST acceptance — 17 October 2026

The existing SpeakSix sandbox was connected to KMA through real Stripe TEST OAuth. Application data remained in disposable local KMA and SpeakSix PostgreSQL databases. No production deployment or creator payout was performed.

## Verified results

- Exact merchant `acct_1UMD6aCYo7AEhAYn`, KMA platform `acct_1SaSp9E47mNwFlz1`, and merchant-owned one-time Price `price_1URacfCYo7AEhAYnpMEMZH9l` were verified in TEST mode.
- A referred and an organic purchase each paid **USD 169.00** through real Stripe test checkout. The referred purchase collected **USD 42.25** under the existing synthetic 25% agreement; the organic purchase collected no application fee or commission.
- Both SpeakSix purchases were recorded before assessment or matching, with registration and cohort unset. Both product callbacks completed. The referred commission used the existing validation window; no creator payout jobs were created.
- Both purchases were fully refunded. The single commission was reversed by USD 42.25 and its application-fee refund completed through the normal service path.
- Repeating both refund requests passed the idempotency assertions: customer-refund provider writes stayed **2 → 2**, fee-refund writes stayed **1 → 1**, and the same completed refund identity was retained. No duplicate ledger entry or money movement occurred.
- Ten relevant accepted webhook receipts were joined by exact event ID to actual Stripe CLI deliveries with valid raw signatures and the correct connected-account/platform scopes. They include both purchases, customer refunds and the application-fee refund.
- All **47** managed-checkout, merchant, pay-first, worker and webhook regression tests passed. The **8** rehearsal guard, admin-separation, signature-relay and manual-inventory tests passed.

## Bug found and fixed during the real test

Stripe represented the application-fee refund as **CAD 59.76**, while the linked platform balance debit and original fee were **USD 42.25**. The old code incorrectly required the refund object's currency and minor-unit amount to equal the original fee. The refund had succeeded at Stripe but remained incomplete in the local accounting queue.

The provider now verifies the exact refund-to-balance-transaction link, platform scope, parent fee, transaction type, canonical currency and debit, operation/order metadata, and parent fee's cumulative refunded amount. The canonical completion receipt comes from that verified debit. Missing or conflicting evidence remains blocked.

The same fixture was recovered through the actual `ManagedCheckoutService` and normal completion RPC, using a transport that allowed **26 provider GETs and zero provider writes**. No completion flag was manually changed, no refund was repeated, and no fixture was replaced to hide the failure. Regression tests cover converted refunds, incorrect debit/linkage, pending evidence and recovery without duplicate provider writes.

## Evidence and limits

- `merchant-real-paid.json`: exact paid-stage assertions and canonical earned ledger.
- `merchant-real-refunded.json`: both full refunds, one reversed ledger entry and completed application-fee operation.
- `merchant-real-recovery.json`: normal service completion with zero provider writes, exact USD debit and CAD refund evidence.
- `merchant-real-repeat-refund.json`: repeated-request assertions and unchanged provider write counts.
- `merchant-real-result.json`: final sanitized runtime state, two fully refunded orders, no pending callbacks, no payout jobs and no remaining error.
- `merchant-real-webhook-proof.json`: joined real delivery/handler receipts by event ID and scope.
- `merchant-refunded.jpg`: local final result screenshot.
- `webhook-restored.json`: FunnelFox TEST endpoint restored to enabled with its configuration preserved, confirmed at 16:56:50 UTC.
- The provider setup/checkout used Stripe TEST mode and synthetic buyer details. Local operator identities were synthetic; this is not a new acceptance test of actual emailed merchant authentication.
- Stripe CLI returned one shared signing secret for both scopes. A loopback-only relay verified the original raw Stripe signature before forwarding the unchanged payload under separate local scope secrets. **Distinct hosted destination signing secrets remain untested.**
- The connected merchant's webhook inventory API returned exact `403 oauth_not_supported`. Its empty TEST destination table was manually verified in the exact sandbox dashboard. The fallback was account-bound, screenshot-hashed and time-limited. Platform inventory remained API verified. This limitation is explicit in the sanitized runtime evidence.
- Creator transfers/payouts, production checkout activation and deployment were not performed.

The exact FunnelFox TEST endpoint was restored to enabled and its original configuration was preserved. The owned local server, bridge, PostgreSQL database process, signature relay and both Stripe CLI listeners were stopped cleanly. A fresh process check confirmed all recorded process IDs were absent. The temporary test browser tab was closed. Fixture files, sanitized evidence and provider TEST records were retained; nothing was deployed.
