# Controlled BC Learn checkout enablement — September 6, 2026

Enabled only the separate partner funnel for the user's approved $0 checkout
test. No Checkout Session, subscription, charge, cancellation, refund or coupon
redemption was initiated by this release. Full payment-pipeline acceptance is
still pending the user's actual test.

## Change and deployment

- Vercel project: `bc-learn-partner-funnel`,
  `prj_FttYGokNkTc0yfHKiajJLueErWSf`.
- Production alias: https://bc-learn-partner-funnel.vercel.app.
- Updated the existing production-only environment record
  `KMA_CHECKOUT_ENABLED` (`xEjp01uQ8dxj7ZQj`) from `false` to `true`. No duplicate,
  preview or development variable was added. This is a server setting, not an
  Admin dashboard control.
- Redeployed the exact existing deployment files, using Vercel's redeploy API;
  no new local source upload or latest Git commit was requested.
- Current deployment: `dpl_9jtZDFXHbkArTx8ffpiaAh5hgba3`, READY, production alias
  assigned. URL:
  `bc-learn-partner-funnel-kskyhs7n0-victory-onorhimes-projects.vercel.app`.
- Previous deployment / rollback reference:
  `dpl_3xTHuaCvFicLkQGPpPtrSJU4fBwa`.
- Other environment record metadata and returned value fingerprints were
  unchanged. Sensitive values were neither exported nor decrypted; absent API
  values are not cryptographic proof of secret equality. The successful signed
  offer request verifies the working existing funnel HMAC integration.
- Project build settings were unchanged. Original `bc-learn-funnel` deployment
  remains `dpl_Cwjmx2EjoeKYEDLVaLLdgwMahkf8`. Sites metadata hash remains
  `1c2354c182e3a5ddb23388694c1bbac189488639380611050de6a3a08b94808b`.
  No Sites publication, Hostinger/dashboard deployment or backend mutation was
  performed. Existing unrelated work was preserved.

## Safeguards and live verification

- Read-only checkout preflight at **19:46:39 UTC** passed: verified $1/month USD
  offer; valid BC Learn-only 100%-off forever coupon and promotion; one unused
  redemption; no expiry, customer or minimum-amount blocker. Restricted-key
  bounded read probes passed. Checkout write permission was not exercised.
- Processing health at approximately **19:47 UTC** reported enabled, no attention
  required, and no pending/failed/processing/expired Stripe, commercial or metric
  queue entries. External transfers remain disabled. Empty queue health does
  not prove processing of a real Stripe delivery.
- Funnel retains `requireNoPayment: true`. Backend discount validation and
  Stripe zero-total validation remain required; no paid fallback is enabled.
- The canonical contract parity check passed: four SDK modules, two published
  contract copies and three adapters match v1.2.
- Public alias acceptance at **19:56:00 UTC**, reusing an existing user click:
  - Offer endpoint: HTTP **200**, `monthly` v1, USD 100 minor units every month,
    `checkout_enabled: true`.
  - Checkout endpoint, deliberately omitting the signed quote cookie: HTTP
    **409**, `offer_review_required`. Source confirms this stops before the
    upstream Checkout handler. No successful checkout request was submitted.
  - Checkout attempts, provider events, subscriptions, transactions and
    commissions were **0 before and after**.
  - No tracking URL was opened and no click or browser event was fabricated.
    Offer reads may refresh quote/rate-limit state.

## User test and remaining proof

Reopen the partner TikTok link, finish the questionnaire/email step, review the
offer and proceed to Stripe. The backend applies the recurring 100%-off
promotion automatically. Confirm only if Stripe shows **$0 due**. If any amount
is due or a gate errors, stop and report it. There is one available redemption;
do not assume subsequent tests can reuse it.

After the user completes the test, verify the real Checkout write, dedicated
webhook delivery, worker normalization, click/source attribution, subscription
state and receipt. A free invoice must not become a paid purchase or paid
commission. Positive revenue, renewals, refunds/disputes, entitlement access and
payout release remain separate acceptance work. Cancellation requires a
separate authorized action.

## Disable / rollback

Set the same **production** `KMA_CHECKOUT_ENABLED` record to `false`, then redeploy
the same `bc-learn-partner-funnel` project. Verify the offer returns
`checkout_enabled: false` and submissions return `checkout_not_enabled`.
Do not remove the zero-total guard, rotate unrelated credentials, modify the
original funnel or delete business records. Disabling creation does not cancel
an existing Checkout Session or subscription.

Vercel environment changes require a deployment to become effective; see the
[official environment-variable guidance](https://vercel.com/docs/environment-variables/managing-environment-variables).

## Evidence

Sanitized JSON records are retained in the ignored directory
`.cache/release-backups/20260906-checkout-enable/`: project/deployment and
environment fingerprints before/after, the exact flag change, deployment
submission/status, read-only preflight snapshot and public acceptance. No
plaintext credentials, quote cookies or public click identifiers are saved.
Application source was reused unchanged; only release documentation was edited
locally after the deployment.
