# Managed Checkout: real Stripe test acceptance — 16 October 2026

Status: six real Stripe test purchases, six full test refunds and repeated cancellation acceptance passed against disposable local KMA and SpeakSix databases. Owned checkout processes and disposable databases are stopped. The temporarily paused FunnelFox test webhook is restored with its configuration unchanged. Nothing was deployed or enabled for live checkout.

## Environment and boundary

- Stripe account: KMA Futura Funds `acct_1SaSp9E47mNwFlz1`; test mode verified before starting.
- Dedicated test Price: `price_1URIc0E47mNwFlz15KgkKFdd`, one-time USD 169.00.
- Actual managed checkout, price verifier, webhook and worker handlers; actual SpeakSix payment adapter and database RPCs.
- Actual Stripe test Checkout in the browser, actual test-card payments/refunds, and Stripe CLI events forwarded to the local raw-signature webhook handler.
- Both application databases, learners, matching reservations, signed commission agreement and administrator identity were local fixtures. Backend price verification used an authenticated local administrator fixture; this does not establish real hosted admin login/UI acceptance.
- The fixture's existing signed agreement specifies 25%, a one-hour validation window and a 30-day refund cutoff. These are test terms, not newly imposed production defaults. Commission and payout configuration remains the existing KMA machinery.
- No deployment, hosted database write, live payment, creator transfer or bank payout occurred.

## Observed results

| Check | Result |
| --- | --- |
| Price verification | Actual managed-price-verifier compared the saved local draft offer with the real Stripe test Price, recorded account/mode-scoped proof and activated only the local offer. |
| Webhook isolation | Existing enabled FunnelFox test listener was paused with explicit user approval before the test. The runner refused conflicting enabled listeners. Restoration is separately recorded below. |
| Browser back/cancel before paying | Learner 4 returned using Stripe's back link. The order remained open and unpaid; there were only three captures and no lesson entitlements. |
| Reopen checkout | Learner 4 reopened the existing attempt. Seven browser checkout openings yielded six distinct saved Checkout sessions, six orders and six provider create operations. |
| Matching gate | The first five paid learners had no entitlements while the cohort was incomplete. |
| Completed cohort | Six verified payments confirmed the cohort and created 216 local lesson entitlements, 36 per learner. |
| Payment webhooks | Six forwarded Stripe payment events were accepted by the actual signed webhook handler; signed KMA callbacks were acknowledged with no pending delivery before cancellation. |
| Commissions | Six canonical awards, each with USD 169.00 post-discount/ex-tax/shipping basis and USD 42.25 commission. Total USD 253.50 held under the existing signed test terms; no duplicate award. |
| Cancellation | Actual administrator cohort cancellation revoked all 216 entitlements. |
| Refunds | Actual SpeakSix refund adapter called KMA; six Stripe test refunds succeeded, USD 169.00 each, totaling USD 1,014.00. |
| Refund accounting | Six SpeakSix refund receipts, six commission reversals totaling USD 253.50, current commission amount zero. No pending refund operation or callback remained. |
| Repeated cancellation | The second action completed with the same six refund IDs, six refund operations, six reversals, six refund receipts and one cancellation audit. No additional refund or duplicate accounting entry. |
| Payout isolation | Zero settlement jobs and no creator payout/transfer. |
| Local route protection | Cancellation without the local control token returned HTTP 403. A raw HTTP request with a foreign Host header returned HTTP 403. |

SpeakSix intentionally stores cumulative refund amounts on its capture ledger and individual provider refund identity/status in `marathon_kma_order_state.snapshot`. Legacy single-refund fields can remain null; they are not incorrectly bound to a cumulative total that could represent multiple partial refunds.

During concurrent refund processing, one periodic local reconciliation tick produced a generic retained warning. Its exact transient cause was not logged. There was no persisted KMA reconciliation error or PostgreSQL error. The full refund request and subsequent reconciliation completed, the warning cleared, and direct database checks confirmed zero pending callbacks and refund operations. This is recovered transient behavior, not proof of its specific cause.

## Evidence

Retained safe evidence: [docs/qa/stripe-test-2026-10-16](qa/stripe-test-2026-10-16/). Temporary full stage directory: `/tmp/kma-managed-crossapp.NwsULU/`.

- `cancel-before-payment.json`: three captures, the fourth order open/unpaid, zero entitlements.
- `commission-and-session-proof.json`: per-order commission basis/rate and one create operation per attempt, with session hashes.
- `before-cancellation.json`: six captures, confirmed cohort, 216 entitlements, six awards, six sessions/create operations, zero duplicates, zero pending callbacks and zero settlement jobs.
- `after-first-refund.json`: real refund IDs/statuses, full cumulative refunds, six refund receipts, reversals and cleared pending work.
- `after-repeat-refund.json`: asserted unchanged provider refund identities and counts after the repeated action; 24 forwarded payment/refund webhooks accepted, zero rejected, zero pending work and no remaining warning.
- `stage-###.json`: chronological safe snapshots preserve intermediate progress.
- `real-stripe-test-result.json`: latest safe status, including forwarded webhook and signed callback counts.

Evidence excludes credentials, signing secrets, customer email addresses and Checkout URLs. Stripe test objects remain in the test account for inspection.

Browser evidence: [six-learner-payment-proof.jpg](qa/stripe-test-2026-10-16/six-learner-payment-proof.jpg). The separate onboarding screenshot in that directory does not change the checkout-only acceptance boundary of this report.

## Final operator confirmations

- Repeated cancellation/refund action: passed; operator confirmed completion at 21:37:34 UTC, followed by direct assertions against both local databases.
- Temporary FunnelFox test webhook restored and configuration verified unchanged: confirmed at 21:38:02 UTC; [webhook-restored.json](qa/stripe-test-2026-10-16/webhook-restored.json) records `enabled`, `livemode=false` and `configurationPreserved=true` for `we_1Sc90yE47mNwFlz1GHigAmee`.
- Owned local runner, CLI, monitor and disposable databases stopped: confirmed. Both local listeners (59063 and 59065) are closed and the disposable PostgreSQL PID file is absent.

The separate embedded creator onboarding rehearsal is outside this checkout report. Production activation still requires its own deployment, configuration and launch approval.
