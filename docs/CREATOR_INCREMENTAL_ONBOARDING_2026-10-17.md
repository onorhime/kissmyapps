# Incremental creator payout setup — local acceptance, 17 October 2026

## Status

Implementation and local acceptance are complete for this synthetic Stripe TEST creator. After the user explicitly approved the final agreement, the resumed Safari session submitted the form and KMA refreshed the provider-backed account status to **ready**: details submitted, no currently due requirements, transfers enabled and payouts enabled. Prefill, submitted-step recovery and sign-out were also verified. The local runner is stopped, its fixture is retained, and the approved TEST webhook has been restored. This establishes completed onboarding for this test account, not live eligibility or a completed payout. No deployment or hosted database migration is included.

## Implemented behavior

The actual embedded Stripe onboarding component now requests `fields: 'currently_due'` with `futureRequirements: 'omit'`. The same options apply when the form is reopened or retried. Stripe determines which information is required for the creator's account; collecting current requirements does not guarantee that no further information will be needed later.

The form explains that submitted details are retained by Stripe, while unsubmitted entries may need to be re-entered. Its close button is now **Close for now**: closing does not submit the form or approve payouts. Closing refreshes the provider status. Pending verification is described as submitted but not ready; a ready account still requires the existing earnings and payout approval process. The UI continues to distinguish receipt of a transfer from a bank payout.

For a new account, the server can prefill these existing, explicitly saved values:

| Source | Stripe creation field | Boundary |
| --- | --- | --- |
| Authenticated actor's confirmed Supabase email | `email` | Unconfirmed email and user metadata are not used. This is the account contact email, not an inferred individual's identity email. |
| Saved affiliate entity type | `business_type` | Only `individual` or `company`; no default is inferred from a display name. |
| Saved company legal name | `company[name]` | Only when the saved entity type is `company`. |
| Saved website | `business_profile[url]` | Only a valid HTTPS URL without embedded credentials. |

Optional values are trimmed and validated, including length and control-character checks. Unsupported or invalid legacy values are omitted. Individual legal names, addresses, dates of birth, identity numbers, business classification and bank information are not invented or extracted from display names. Sensitive identity and bank details remain collected directly by Stripe's component.

Migration `20261017010000_creator_connect_prefill.sql` adds `external_creator_accounts.account_creation_prefill` and updates the service-only reservation RPC. The verified request actor must be an activated owner or finance member of the exact creator before profile data can be read. Browser-supplied profile fields are not accepted. The snapshot is frozen at the first account-creation reservation, preserving the same provider request through retries, profile changes or another authorized finance user's retry. Existing reservations retain their previous empty snapshot; existing connected accounts are reused without overwriting their Stripe information.

Account ownership checks, account-controller validation, scoped short-lived sessions, recent KMA authentication and enrolled MFA requirements remain in place. The component remains embedded; no hosted onboarding fallback was introduced. Commission settings, payout settings and manual payout approval are unchanged.

## Automated checks passed

- **50 focused frontend tests** passed across `embedded-payout-setup.test.tsx` and `settlements.test.tsx`. Coverage includes current-only collection after retry, expiry/scope checks, recovery, sign-out, and closing a form while status remains pending rather than showing it as ready. Only a later verified ready response changes that state.
- **249 edge tests** passed, including prefill sanitization, provider payload/ownership checks and authentication boundaries.
- **48 database suites passed; 3 existing suites were skipped.** The new prefill suite checks service-only access, unrelated and unauthorized actors, ignored caller-supplied profile values, a frozen retry snapshot, reserved-country consistency, legacy reservations, unconfirmed email, missing entity type and existing-account preservation. Skipped suites require named existing production fixtures and are not counted as passed. [Saved database summary](qa/creator-incremental-2026-10-17/database-summary.json), copied from `/tmp/kma-all-sql-db.1ihEu2/result.json`.
- **7 real local Supabase Auth scenarios** passed with all **61 migrations** applied. The actual frontend gateway and handler used genuine password and TOTP authentication; a native PostgreSQL RPC adapter replaced PostgREST and Stripe transport was fake. This run created one fake account and three fake sessions. [Saved safe evidence](qa/creator-incremental-2026-10-17/real-auth.json), copied from `/tmp/kma-real-auth.EW6yjh/acceptance.json`. See [the real Auth acceptance report](CREATOR_REAL_AUTH_ACCEPTANCE_2026-10-17.md) for the scenarios and proof boundaries.
- TypeScript and focused lint/format checks passed. The production build passed with the pre-existing large-chunk warning.

The real Auth scenarios verify wrong-password/code rejection, stale-password AMR remaining stale after token refresh, actual password reauthentication, enrolled TOTP/AAL2, tampered-token rejection, unrelated-user isolation and sign-out. Original and reauthenticated JWTs are compared at the same simulated authentication clock; provider/database timestamps use real wall time. This is separate from the synthetic-auth browser rehearsal below.

## Real Stripe TEST browser rehearsal — complete

The disposable local fixture is `/tmp/kma-creator-browser.Mm0pjJ`, using test connected account `acct_1URL8yCwssLKlEpr`. It mounts the actual KMA components, real Connect.js and the real creator-connect handler against a local database. Browser authentication is a synthetic local fixture; it does not replace the separate genuine Supabase Auth acceptance.

Verified in the initial run:

- Safari loaded the real embedded form on its first attempt and displayed the prefilled contact email and saved entity type.
- Chrome's initial load was delayed, and Retry recovered the actual component. The browser tool reported paused document responses during the delay; the cause remains inconclusive and no application defect was proved by this observation. This run is not evidence of a successful first load in both browsers.
- After the test identity step was submitted, **Close for now** closed the form and KMA refreshed the account as restricted. Identity requirements had disappeared from the returned outstanding requirements. Reopening resumed at **Business details**, rather than asking for identity again, on the same account without another account creation.
- The saved initial-run evidence records **one account creation and five successful Account Sessions**, all for the same account, with no provider HTTP failures or denied provider calls. Prefill evidence confirms the saved contact email and entity type; no individual name was invented and only the transfers capability was requested.
- At the last server refresh after the identity step, the account was still `restricted`, `details_submitted=false`, with business, bank and terms requirements outstanding. Transfers and bank payouts were not enabled. These fields describe that refresh, not a completed final submission.
- The browser subsequently reached **Review and submit**, using Stripe's synthetic TEST bank button. That run stopped before accepting the final agreement while awaiting the user's action-time confirmation. The [review screen](qa/creator-incremental-2026-10-17/review-before-submit.png) records that earlier stage, not verification approval.
- **Sign out of local creator** was clicked while that final review form was open. The Stripe iframe was removed, and KMA displayed: “Local creator signed out. Reload this page to sign in to the same disposable fixture.” The [sign-out screenshot](qa/creator-incremental-2026-10-17/signed-out.png) records this browser result.
- Zero settlement jobs and no money movement were recorded. The runner does not perform charges, transfers, payouts or account updates outside the embedded form.

The [saved initial browser evidence](qa/creator-incremental-2026-10-17/stripe-browser.json) preserves the pre-submission run. It contains safe operation counts, account identifiers, status and requirement names, not credentials, Account Session secrets or bank/identity values. Its restricted status belongs to that earlier refresh and is superseded by the completed-run evidence below.

After the user approved **Agree and submit**, the exact retained fixture and connected account were resumed in Safari:

- The embedded form resumed directly at **Review and submit**, retaining the submitted identity, business details and synthetic bank. Only `tos_acceptance.date` and `tos_acceptance.ip` remained due before submission.
- **Agree and submit** was clicked inside Stripe's own embedded form. The form closed automatically and KMA displayed the ready state. **Refresh status** was then clicked explicitly, so completion is supported by a new provider read rather than the form's completion screen alone.
- The refreshed account was `ready`, with `detailsSubmitted=true`, `requirementsDue=[]`, `transfersEnabled=true` and `payoutsEnabled=true`. Its verification timestamp is `2026-10-17T01:30:35.316+01:00`.
- The resumed run recorded **zero account creations, one successful Account Session, four status checks and 23 provider reads**, with no provider HTTP failures or denied calls. The account remained `acct_1URL8yCwssLKlEpr`. Counters restart per run; the initial and resumed records are preserved separately.
- **Sign out of local creator** was clicked in Safari after completion. Safari's accessibility state confirmed the local creator was signed out. The earlier sign-out screenshot remains the visual record of removing an open component; a transitional post-completion screenshot was discarded rather than presented as completed sign-out proof.
- There were **zero settlement jobs** and `moneyMovementEnabled=false`. Stripe enabling test-account capabilities does not enable a payout worker or transfer money.

The [completed browser evidence](qa/creator-incremental-2026-10-17/stripe-browser-completed.json) preserves the resumed run. Its `creationPrefill=null` means no account creation occurred in that run; the initial record proves prefill. The [ready-state screenshot](qa/creator-incremental-2026-10-17/payout-ready.png) shows KMA's refreshed provider status. Actual agreement submission was performed in Safari; the screenshot was captured read-only in the in-app browser because the native Safari screenshot was distorted.

## Acceptance record

- [x] Confirm submitted identity details survive close/reopen on the same account without another account creation.
- [x] Complete the currently required TEST form and read back the resulting provider verification/capability status: ready, no currently due requirements, transfers and payouts enabled for this TEST account.
- [x] Confirm sign-out removes the open component for this run.
- [x] Record final sanitized evidence, local runner shutdown and restoration of the temporarily paused, approved FunnelFox TEST webhook.

## Cleanup and retained fixture

The approved FunnelFox TEST endpoint `we_1Sc90yE47mNwFlz1GHigAmee` was restored after each run and read back as enabled, with `livemode=false` and `configurationPreserved=true`. The [initial restoration evidence](qa/creator-incremental-2026-10-17/webhook-restored.json) is retained. The [completed-run restoration evidence](qa/creator-incremental-2026-10-17/webhook-restored-completed.json) was copied from `/tmp/kma-stripe-rehearsal-20261016/webhook-restored.json`; its check timestamp is `2026-10-17T00:31:11.457Z`.

The resumed launcher received SIGINT and exited with code 0. A subsequent process check confirmed the runner, bridge and fixture PostgreSQL were stopped. Temporary test tabs were closed. The disposable database at `/tmp/kma-creator-browser.Mm0pjJ` and test account `acct_1URL8yCwssLKlEpr` were retained, not deleted.

To continue this exact fixture from the KMA repository:

```sh
node scripts/creator-connect-browser-from-env.mjs --resume-fixture /tmp/kma-creator-browser.Mm0pjJ --expected-account acct_1URL8yCwssLKlEpr
```

Before any further provider testing, temporarily pause **only the already approved FunnelFox TEST webhook** and verify its test identity. Restore that endpoint with its original configuration afterward. Do not alter other endpoints or live settings. The resume command checks the retained fixture and expected account rather than creating a replacement. This account's approved final agreement submission is complete; no further submission is needed for this acceptance. Refresh the actual provider status when continuing, since requirements may change later.

Production activation, hosted authentication configuration, live country/currency eligibility and actual transfers/bank payouts remain separate. This change does not enable money movement or alter commission terms.
