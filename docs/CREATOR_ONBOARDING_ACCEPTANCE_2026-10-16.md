# Creator onboarding — local Stripe test acceptance

> Follow-up: the confirmed hidden-form recovery defect is now fixed, and real local password/MFA acceptance passed. See [17 October recovery acceptance](CREATOR_RECOVERY_ACCEPTANCE_2026-10-17.md). Earlier open items below describe the 16 October checkpoint.

## Latest result — 16 October 2026, 22:24 UTC

**The approved synthetic creator submission completed inside KMA.** A fresh provider read and the locally persisted account both report `status=ready`, `detailsSubmitted=true`, `transfersEnabled=true`, `payoutsEnabled=true`, and no outstanding requirements. The browser displays “Your Stripe account verification is complete.” This is actual Stripe TEST verification, not a mocked provider result, a live payout, or production approval.

The same account, `acct_1URJIdE2asTL6F4V`, was reused across eight successful Account Sessions; only one connected account was created for this embedded rehearsal. Details, Stripe's test identity/address documents, test bank and the approved agreement were completed without leaving the KMA page or opening a separate Stripe login. Earlier save/resume and local fixture sign-out/sign-in checks also passed.

The named FunnelFox TEST webhook `we_1Sc90yE47mNwFlz1GHigAmee` was restored and verified enabled with its original configuration after submission. No live payment, transfer, payout, deployment or hosted migration occurred. The runner prevents money movement.

### Open acceptance issues

- **First-load/session recovery reliability remains open.** In instrumented Chrome, first loads sometimes timed out. After waiting for agreement approval, Stripe also reported an expired AccountSession; retry obtained a fresh server session but the error persisted until a full reload and retry. Submission then succeeded. Source and public-loader review found no proven publishable-key instance cache, server idempotency replay, stale React error callback or API-contract mismatch. Do not apply an unsupported logout/reset workaround or claim this issue fixed.
- **Real authentication acceptance remains separate.** The local runner uses a synthetic HttpOnly creator session and fresh password AMR. Actual Supabase password confirmation and enrolled TOTP are covered by unit adapters, not by a real authentication-service browser rehearsal.
- **Live eligibility and money movement remain separate.** The verified Canadian test account supports CAD transfers. This does not establish all countries/currencies, live account approval, creator transfer execution or receipt in a bank. Existing commission/refund rules and manual admin payout approval remain unchanged.

Final evidence:

- `qa/stripe-test-2026-10-16/embedded-creator-complete.json`
- `qa/stripe-test-2026-10-16/embedded-creator-complete.png`
- `qa/stripe-test-2026-10-16/embedded-webhook-restored.json`

The local rehearsal runner (PID `19234`, execution session `84498`) was stopped after evidence capture. Its disposable database and server are no longer running; both Stripe test accounts and evidence are retained. The earlier records below are historical checkpoints and do not override this final result.

## Earlier partial acceptance

Recorded **16 October 2026, 21:33 UTC**. This is partial acceptance, not completed onboarding or production approval.

The local browser page uses the actual `CreatorConnectCard`, `EmbeddedPayoutSetup`, Stripe Connect.js and `creator-connect` handler. Its authenticated creator is synthetic: an HttpOnly local fixture session and a disposable PostgreSQL database exercise the existing permission and account-persistence functions. This does not test real Supabase sign-in.

The verified KMA platform was `acct_1SaSp9E47mNwFlz1`, with Stripe reporting `livemode=false`. Only the approved FunnelFox **test** webhook was paused for this rehearsal. It was subsequently restored and verified enabled with its original configuration; proof is in `qa/stripe-test-2026-10-16/webhook-restored.json`. No deployment or live activation was performed.

## Verified

- The actual browser flow created **one** Stripe test connected account: `acct_1URIf1E2tb2tfp7B`.
- **Two Account Sessions succeeded**, both reusing that same account. Retrying did not create another connected account.
- After retry, the actual Stripe onboarding iframe loaded. Its **Add information** action opened the Stripe test-login popup, including **Use test phone number**.
- Backend status refresh succeeded twice. The acceptance runner issued **zero transfers or payouts**; its provider allowlist blocks money movement and no payout worker runs.
- Account Session secrets and API keys were not included in persisted acceptance evidence.

## Still pending

The displayed Stripe agreement step is awaiting user confirmation. Form completion, submitted details, successful verification, completed bank setup, completed save/resume after submitting information, and browser sign-out acceptance are **not yet passed**.

The latest verified account state is `restricted`, with `detailsSubmitted=false`, `payoutsEnabled=false`, and `transfersEnabled=false`. Required fields remain `business_type`, `external_account`, `tos_acceptance.date`, and `tos_acceptance.ip`. Opening or exiting the form is not proof of approval.

The first status request failed and the first iframe attempt remained blank/loading. Subsequent retries succeeded. Their exact causes were not retained by the sanitized diagnostics and remain **unconfirmed**; this evidence does not establish a persistent application bug or a proven network timeout.

## Historical Express session

Safe snapshot: `/tmp/kma-creator-browser.SUzPGC/acceptance-evidence.json`.

At recording time: `mode=stripe-test`, `reads=19`, `accountCreates=1`, `accountSessions=2`, `successfulSessions=2`, `statusChecks=2`, `deniedProviderCalls=0`, `databaseOnlyLocal=true`, `moneyMovementEnabled=false`.

Browser: `http://127.0.0.1:5193/creator-connect-local.html`. Tool execution session: **24215**. That runner was stopped with SIGINT during the subsequent embedded-account rehearsal; the test account was retained. Before continuing provider mutations, reapply the approved temporary pause of the named FunnelFox test webhook, then restore it again afterward. The open form is not permission to send test events to other integrations.

The runner PID was verified as **6283** (`node scripts/creator-connect-browser-local.mjs --stripe-test`). After confirming that PID still belongs to this runner, stop it with `kill -INT 6283`. Its handler saves final safe evidence and stops Vite, the bridge and the disposable database. This does not delete the Stripe test account or restore the paused webhook; the main test controller must verify restoration separately.


## Fully embedded account rehearsal — 16 October 2026, 22:18 UTC

**Implementation is local; final test agreement submission is pending confirmation.** No deployment, hosted migration, real identity, live payment or payout occurred. The historical Express account above was retained. A new disposable creator received one new Stripe test account, `acct_1URJIdE2asTL6F4V`, under the same verified KMA test platform.

### Verified in the actual Stripe component

- Account creation uses application-managed requirements and no Stripe dashboard. The returned Account Session confirms `disable_stripe_user_authentication=true` and `external_account_collection=true`.
- The business, identity, verification-document, bank and final-review steps rendered **inside KMA**. No separate Stripe login page or authentication popup appeared with this account configuration.
- Synthetic personal and business information was submitted. Stripe's built-in **Use test account** supplied its Canadian test bank; **Use test document** supplied both identity and address verification fixtures. No real bank data, identity document or biometric data was used.
- On closing the form, provider status reported only `tos_acceptance.date` and `tos_acceptance.ip` outstanding. Details and bank setup survived save/resume and local fixture sign-out/sign-in.
- Five successful Account Sessions reused the same single connected account. There were no transfer/payout calls and no payout worker.
- Browser sign-out initially hung because cleanup awaited a Stripe SDK instance that never resolved after an earlier failed iframe load. The SDK cleanup now has a two-second bound, and the local form is removed immediately. Retest visibly confirmed local sign-out; regression also verifies that an identity mismatch reaches Supabase sign-out even if SDK cleanup hangs.

### Remaining boundaries

The enabled **Agree and submit** button expressly accepts Stripe's Connected Account Agreement and fee disclosures. It was left untouched awaiting per-action confirmation. `detailsSubmitted`, `payoutsEnabled` and `transfersEnabled` therefore remain false; completion and payout readiness must be checked after submission.

The first iframe load after opening/reloading the instrumented Chrome page stalled; the displayed retry successfully loaded the form. This reproduced after reload. Review found no proven mismatch with the installed Connect.js bootstrap/lifecycle contract. A browser instrumentation or provider loading issue remains possible but unconfirmed. Do not claim first-load reliability is fully accepted from this rehearsal.

The local browser runner uses a synthetic HttpOnly creator session and explicitly simulated fresh password AMR. Real Supabase password confirmation and TOTP were tested with unit adapters, **not with a live Supabase authentication service**. Production sign-in acceptance and live country/currency eligibility remain separate gates.

### Local checks

- 49 backend tests passed across creator authentication, account/session boundaries, payout-worker safeguards and Connect webhooks.
- 46 frontend tests passed, including password/TOTP confirmation, creator identity changes, no redirect, session refresh and bounded SDK cleanup.
- Native SQL regression, fake browser smoke, three local provider-policy guards, targeted Deno checks/lint and frontend TypeScript passed.
- No schema change is needed for this account-configuration/UI adjustment. Existing commission settings, refund cutoff and admin payout approval logic remain in place.

### Retained evidence and resume point

- `qa/stripe-test-2026-10-16/embedded-creator-acceptance.json`
- `qa/stripe-test-2026-10-16/embedded-creator-review.png`
- `qa/stripe-test-2026-10-16/embedded-creator-signout.png`
- `qa/stripe-test-2026-10-16/embedded-webhook-restored.json`

The approved FunnelFox **test** webhook was restored and verified enabled with its exact prior configuration before waiting for the agreement response. Re-pause that exact webhook before further test mutations and restore it afterward.

Local handoff: `http://127.0.0.1:5193/creator-connect-local.html`, browser tab `55533296`, runner execution session `84498`, PID `19234`, disposable database/evidence directory `/tmp/kma-creator-browser.O5Dl02`. Confirm PID identity before stopping. The form is open at its completed review. The test creator account must not be recreated just to resume.
