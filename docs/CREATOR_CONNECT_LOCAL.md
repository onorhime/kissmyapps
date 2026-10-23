# Creator Connect and canonical commissions

Local implementation, 15 October 2026. No hosted migration, deployment, provider activation, real charge, transfer or bank payout was performed.

## Configure commercial terms once

Use the existing product configuration → partner agreement and commission rule. The agreement owns attribution window, payout currency, payout frequency and minimum payout. The commission rule owns percentage/fixed/hybrid calculation, validation waiting time, commission basis and the optional ordinary-refund cutoff.

- Blank refund cutoff means unlimited, preserving the prior ordinary-refund behavior. A number is elapsed 24-hour days from the stored verified purchase anchor. For external purchases, that anchor is `PaymentIntent.created`, after verifying the session is paid and the PaymentIntent succeeded; it is not a capture or bank-settlement timestamp and may predate completion for delayed payment methods. Legacy purchases retain their canonical transaction occurrence time. A refund at the deadline qualifies; one after it does not. Late webhook delivery does not change the deadline.
- Validation waiting time is a separate payout hold. It is not the refund cutoff or payout frequency.
- `net_after_fees` preserves the canonical legacy basis: verified total minus payment fees and tax. External orders require verified same-currency provider fee evidence.
- `subtotal_ex_tax_shipping` uses the verified post-discount subtotal excluding tax and shipping. It is supported by the external purchase integration. Legacy subscription transactions do not contain shipping evidence and cannot silently use that alternative.
- New policy fields belong to new signed revisions. Existing document fingerprints are preserved, and active/signed commercial terms cannot be edited in place.

The existing Admin Payouts screen selects a signed agreement and purchase rule and records the operational receiving-merchant/funding-platform mapping. It no longer asks for a second rate, attribution window, minimum or payout delay. Each award freezes the selected IDs, versions, signed fingerprint and calculation terms.

## Funding and payout timing

The receiving merchant and funding platform can be different Stripe accounts. A `prefunded_platform` binding uses the KMA platform's available balance; it does not move SpeakSix's balance into KMA. There is no foreign `source_transaction`, automatic cross-account funding or automatic currency conversion. `merchant_direct` is restricted to the same receiving and funding account.

External settlement periods are anchored to the signed agreement start and frequency. Only completed periods and matured earnings are considered; the signed minimum is enforced. A below-minimum balance stays available for a later eligible period. Prepare, review and explicit admin approval remain separate steps. Provider account/currency eligibility is checked again before transfer.

The legacy statement flow retains its existing 14-day calendar restriction and reconciliation gates. Its validation waiting time is now enforced as well. No legacy transfer writer has been enabled.

A Stripe transfer credits the creator's connected account. It is not a completed bank payout. Account-wide bank payout events are shown separately, and no manual bank-payout API is called.

## Refunds and disputes

New signed policy-v2 external commissions use cumulative proportional correction: original commission × qualifying gross refund / original gross purchase, rounded down on the cumulative amount. Individual Stripe refund IDs are deduplicated. Refunds outside the signed cutoff remain recorded but do not reduce commission.

Each additional qualifying refund can produce an additional recovery for a previously transferred award. Frozen or in-flight transfer/reversal amounts are never edited. Recovery and duplicate webhook processing retain stable identities and cannot exceed the original commission. Pending recoveries and financial review holds block further settlement in that funding account/currency.

Open disputes hold settlement. A verified won outcome can release its corresponding complete lifecycle hold; historical negative-evidence holds still require review; verified lost disputes are handled separately from ordinary-refund cutoffs, with total reductions capped. Conflicting evidence remains held. Historical policy-v1 partial-refund/dispute cases retain review requirements rather than acquiring new unsigned proportional terms. The legacy purchase path continues using its verified Stripe balance-impact calculation for refunds and disputes.

Provider events received before attribution are retained and applied when the exact merchant/mode/payment/order identity becomes available. Missing charge/fee references are retried; incompatible fee currency is explicitly held rather than guessed as zero.

## Provider endpoints

- `external-commerce`: authenticated merchant HMAC ingress verifies purchases with that receiving merchant's Stripe credential and persists independent basis/fee evidence.
- `external-commerce-webhook?binding_id=<merchant-binding>`: raw Stripe signature and merchant scope verification for refunds/disputes. Uses receiving-merchant credentials, not the KMA funding key.
- `creator-connect`: authenticated creator status/onboarding. Membership controls identity, sessions require fresh KMA authentication, and country/currency availability is resolved from current provider evidence and approved platform routes.
- `creator-payout-worker`: server-secret endpoint. Calculates commissions; enabled funding bindings can reconcile receipts. New transfers additionally require both activation flags and an approved database job.
- `creator-connect-webhook?binding_id=<funding-binding>`: funding-platform accounts/transfers and connected-account bank payouts. Refund/dispute policy belongs to the merchant webhook.

## Disabled-by-default configuration

`CREATOR_CONNECT_ENABLED=false`, `CREATOR_TRANSFERS_ENABLED=false` and `EXTERNAL_COMMERCE_WEBHOOK_ENABLED=false` are independent defaults. Saving an agreement or funding mapping does not enable them. Each database funding platform must also be explicitly enabled before approved jobs are claimable.

Example funding binding (placeholders only):

```json
{
  "test-platform": {
    "platform_account_id": "acct_REPLACE",
    "livemode": false,
    "secret_env": "CREATOR_TEST_STRIPE_SECRET",
    "publishable_key_env": "CREATOR_TEST_STRIPE_PUBLISHABLE_KEY",
    "webhook_secret_env": "CREATOR_TEST_WEBHOOK_SECRET",
    "origin": "http://127.0.0.1:5173",
    "return_url": "http://127.0.0.1:5173/partner?connect=return",
    "refresh_url": "http://127.0.0.1:5173/partner?connect=refresh",
    "country_policy": { "type": "domestic" }
  }
}
```

Store this in `CREATOR_CONNECT_BINDINGS_JSON`; secret and webhook keys remain server-only. The binding's public key is returned only with an authorized embedded setup session. Live origin/callbacks require HTTPS. The old arbitrary `allowed_countries` list has been removed. Country policy choices:

- `domestic`: default, provider's platform country only.
- `connect_cross_border` with `approval_reference`: provider-supported Connect regions intersected with current country specifications.
- `approved_countries` with `approval_reference` and `approved_countries`: explicit provider-approved routes, still intersected with current specifications.

Country Specs are a catalog, not proof that this platform is activated for every route. Actual setup, approval, capabilities, available funding currency and recipient settlement route remain required. Unsupported FX and fractional whole-unit currency transfers stay blocked; no exchange rate is invented.

## Embedded creator setup (local, 16 October 2026)

Creator Payout settings opens Stripe's embedded account-onboarding component inside KissMyApps. Following the 16 October request for fully in-app setup, new accounts explicitly use `controller.requirement_collection=application`, `controller.stripe_dashboard.type=none`, `controller.fees.payer=application`, and `controller.losses.payments=application`. Only the `transfers` capability is requested. KMA owns creator authentication, outstanding-requirement collection and the platform responsibilities of this account configuration; this is more than a visual replacement of the Express login page.

The earlier real Stripe test used Express and opened Stripe's authentication popup. Its acceptance record remains historical evidence only. Express or other incompatible existing accounts now fail with `embedded_account_incompatible`; they are never silently unlinked, converted, deleted or replaced. New-account idempotency and recovery preserve the original account key.

`POST creator-connect` with `{ "action": "session", "binding_id": "test-platform", "country": "US" }` creates a short-lived Account Session. Country is needed only before the creator has an account. Authenticated membership resolves the creator and stored account; caller-supplied account IDs, components, URLs and identity fields are rejected. Responses contain the normal bindings plus `account_session` with binding ID, account ID, platform ID, mode, scoped publishable key, expiry and client secret. Account Sessions enable only `account_onboarding`, with `external_account_collection=true` and `disable_stripe_user_authentication=true`, never payouts, transfers or payment management. Before each session, the provider re-reads the account and checks creator/platform/account-key metadata plus all required controller settings. The returned session must confirm both features and cannot enable another component. The hosted onboarding provider method is disabled and makes no Account Link request.

The optional `publishable_key_env` must resolve to the **same platform's publishable key in the same test/live mode** as that binding's secret. No frontend global key is used. Server checks the platform secret's identity/mode and rejects a wrong key mode before any mutation; Stripe itself verifies the publishable key/session pairing when Connect.js loads. Missing embedded configuration prevents setup without creating a new account. Read-only status and receipt handling remain available; there is no hosted fallback.

Before issuing an embedded session, the server verifies the exact Supabase bearer token, binds its subject to the authenticated user and checks a primary authentication method within ten minutes. Token refresh alone does not count. Existing verified MFA additionally requires a fresh TOTP verification at AAL2. KMA displays password confirmation and enrolled authenticator verification inline, using Supabase Auth only; these secrets never go to creator-connect or Stripe. User identity is checked before and after both authentication and Account Session requests. Unsupported MFA methods fail closed with sign-in guidance. The local Stripe browser fixture simulates this authentication boundary; real Supabase password/MFA acceptance is a separate check.

Session secrets are returned only to the signed-in creator, with `Cache-Control: no-store`; they are not stored in the database, logs, browser storage or URLs. Connect.js requests authenticated replacement sessions on expiry. The UI rejects scope changes on refresh, shows retryable load errors, permits closing and resuming, and refreshes actual provider verification when the form exits. Exiting is not proof of approval. Sign-out invalidates remembered Connect sessions; normal page navigation only unmounts the form.

Sensitive identity and bank details are entered into Stripe's component. KMA stores account identifiers, capability/verification status and requirement names, plus the limited account-creation profile snapshot described below; no raw bank details or identity numbers were added.

The 17 October incremental setup change requests only `currently_due` fields and omits future requirements. Stripe can request additional information later. **Close for now** closes the form and refreshes verification; it does not submit unsaved entries or mean payouts are approved. Submitted details remain with Stripe.

New account creation can prefill the signed-in actor's confirmed Auth email, saved affiliate entity type, explicit company legal name and a valid HTTPS website. The service-only reservation validates the actor's owner/finance membership and freezes this source snapshot in `account_creation_prefill` before the first create attempt. Retries keep that snapshot even after profile edits; legacy reservations remain empty and existing Stripe accounts are not overwritten. Individual legal names, identity/bank details and business classifications are not inferred. This requires local migration `20261017010000_creator_connect_prefill.sql`. See [incremental setup acceptance](CREATOR_INCREMENTAL_ONBOARDING_2026-10-17.md) for completed automated checks and the completed real Stripe TEST browser setup: the retained account reached ready after approved submission and an explicit provider refresh, with no money movement or deployment.

Before production, verify the platform permits the controller configuration and Account Sessions, and complete a new test creator through Stripe's actual component in Chrome/Safari. Verify that the form stays inside KMA, that KMA authentication and MFA guards work, and that verified status comes back from Stripe. These are not established by the earlier Express rehearsal. If hosting sets CSP, allow `https://connect-js.stripe.com` and `https://js.stripe.com` in `script-src` and `frame-src`, `https://*.stripe.com` in `img-src`, and Stripe's documented empty-style hash in `style-src`. Retain the documented Connect.js window/header compatibility; do not use a restrictive opener policy as a way to suppress an unexpected authentication popup. Embedded webviews are not supported by Stripe's web components; use a normal browser for provider acceptance.

Local tests use fake provider transport and mocked Connect.js. They verify ownership, permissions, expiry refresh, status reload, retry, sign-out lifecycle and that secrets are excluded from persisted state. They do not establish a real Stripe identity verification, supported live route or bank payout. No activation flags have been enabled.

The existing merchant HMAC binding may add `stripe_webhook_secret_env` for its own signing secret. The merchant webhook accepts `charge.refunded`, `refund.created`, `refund.updated`, and dispute created/updated/closed/funds-withdrawn/funds-reinstated events. Configure these on the receiving account only after later release approval.

## Retry and recovery

Stable provider idempotency keys survive worker retries. Each attempt searches for its exact provider object before issuing a POST. Retry backoff is bounded. The 23-hour clock starts immediately before the first possible provider POST, after read-only preflight and receipt checks; failed preflight does not consume it. After that mutation window, recovery is GET-only; a missing receipt remains unresolved instead of causing a new payment identity. Admin reconciliation does not authorize a new transfer.

The local supervisor remains opt-in:

```sh
node scripts/creator-payout-loop.mjs --run
```

It defaults off; `--run --once` performs one tick. The URL is restricted to loopback, server authentication is required, and SIGINT/SIGTERM stops the loop. This is not a deployed production scheduler.

## Local verification

From the KMA repository, with Deno and PostgreSQL17 installed:

```sh
pnpm test
pnpm build
pnpm lint
node scripts/test-database-native.mjs
node scripts/test-creator-connect-native.mjs
```

The native runners use socket-only PostgreSQL and fake provider transport. No hosted credentials or provider money movement are part of these tests. See `creator-settlements-local-2026-10-14.md` for recorded acceptance results and limitations.

## Provider references

### Actual Stripe test onboarding on a local database

After verifying the intended KMA Stripe platform and obtaining authorization for test-account creation, put only its test keys in the Git-ignored `.env.stripe-test.local` file:

- `KMA_REAL_TEST_STRIPE_SECRET_KEY` (`sk_test_…` or suitably scoped `rk_test_…`)
- `KMA_REAL_TEST_STRIPE_PUBLISHABLE_KEY` (`pk_test_…` for the same account)
- `KMA_REAL_TEST_STRIPE_ACCOUNT_ID` (the verified KMA platform `acct_…`)

Start with `node scripts/creator-connect-browser-from-env.mjs`. The launcher passes credentials over a private stdin pipe; no credentials are printed, added to command arguments, written to the fixture database, or passed to Vite. Live keys are refused before the database/provider starts. The provider then verifies its account identity and test balance mode using read-only calls. A secret/publishable key account mismatch still must be rejected by the actual Stripe component.

Open `http://127.0.0.1:5193/creator-connect-local.html` in Chrome or Safari. This mounts the actual `CreatorConnectCard` and `EmbeddedPayoutSetup` with a synthetic creator authenticated by an HttpOnly loopback session. The actual creator-connect handler uses the normal PostgreSQL permission and persistence functions in a new socket-only disposable database. Only the browser operator's **Set up payouts** action creates the test connected account and Account Session. Use [Stripe's documented test identity and bank details](https://docs.stripe.com/connect/testing), never real identity/bank information. With the updated controller/session configuration, a separate Stripe user login is not expected. If it appears, stop and diagnose the account/controller/session evidence; do not bypass the popup or accept terms without the browser operator's authorization.

Verify the form loads; submit a step and use **Close for now**; reopen the same account and check the submitted details; complete test onboarding; close and refresh provider status; sign out and confirm the SDK session closes. The transport allowlist permits only account/country/balance reads, connected-account creation and Account Sessions. Charges, transfers, payouts, refunds and account updates are blocked. No deployed configuration changes and no payout workers are involved.

Safe evidence is updated at `/tmp/kma-creator-browser.<id>/acceptance-evidence.json`: provider operation counts, test account ID, verification status and requirement names only. Account Session secrets and bank/identity values are never persisted by the runner. Ctrl-C stops the local app, bridge and database; fixture evidence remains. This does **not** delete the test account from Stripe. A new run intentionally uses a new disposable creator-account identity.

Preparation smoke test without any external provider: `node scripts/creator-connect-browser-local.mjs --fake-smoke`. Policy checks: `node --test scripts/creator-connect-browser-policy.test.mjs`. Passing fake transport checks does not establish actual Connect.js or provider acceptance.

Provider regressions for the fully embedded configuration: `deno test --config supabase/functions/deno.json --allow-env supabase/functions/creator-connect/provider_embedded_test.ts`. They check explicit account-controller settings, account reuse, incompatible Express rejection without replacement, creator-binding revalidation, exact returned session permissions and disabled hosted fallback. Real verification and bank-payout acceptance remain separate.

- [Separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers)
- [Connect cross-border payouts](https://docs.stripe.com/connect/cross-border-payouts)
- [Country specifications](https://docs.stripe.com/api/country_specs/object)
- [Hosted onboarding](https://docs.stripe.com/connect/hosted-onboarding)
- [Embedded onboarding](https://docs.stripe.com/connect/embedded-onboarding)
- [Embedded components, session refresh and header requirements](https://docs.stripe.com/connect/get-started-connect-embedded-components?platform=web)
- [Account Session security](https://docs.stripe.com/api/account_sessions/object)
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Connected-account bank payouts](https://docs.stripe.com/connect/payouts-connected-accounts)

## Recovery and real local authentication acceptance — 17 October 2026

See [recovery acceptance](CREATOR_RECOVERY_ACCEPTANCE_2026-10-17.md) for the repaired timeout/retry behavior and successful actual Stripe first-load checks in Safari and Chrome. Run `node scripts/test-creator-real-auth.mjs` for genuine local Supabase password/TOTP acceptance; see [the authentication report](CREATOR_REAL_AUTH_ACCEPTANCE_2026-10-17.md) for its transport boundaries. No production activation is implied.

To resume the specifically verified stopped browser fixture without reseeding or creating another Stripe account, use `node scripts/creator-connect-browser-from-env.mjs --resume-fixture /tmp/kma-creator-browser.O5Dl02 --expected-account acct_1URJIdE2asTL6F4V`. The runner validates fixture ownership, test account/platform identity and existing local data before starting; account creation is forbidden on resume. Use the approved test-webhook isolation procedure before actual provider tests and restore it afterward.
