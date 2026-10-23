# Hosted merchant admin connection fix — 2026-10-18

## Issue and cause

An authenticated owner could open **Admin → Products → SpeakSix Marathon Test → Configure → Merchant Stripe connection**, but the status request failed with a generic retry message. Hosted logs showed repeated OPTIONS 403 responses. The API accepted only the partner portal origin, while the admin portal uses a separate host. Its binding lookup also reused the merchant recipient origin for admin requests, so widening CORS alone would not solve the issue.

## Released change

Deployed only the reviewed merchant-connect function and two configuration changes: MERCHANT_CONNECT_ALLOWED_ORIGINS includes both approved portals, and the existing TEST binding explicitly allows admin.kissmyapps.dev through admin_origins. The recipient origin and callback remain partners.kissmyapps.dev and https://partners.kissmyapps.dev/merchant/callback.

Admin actions retain their authenticated database role/password checks. Recipient invitation/OAuth actions reject the admin origin before consuming invitation or OAuth state. Wrong portals and unconfigured LIVE mode remain rejected. Existing same-origin bindings and the disabled-status read-only response remain compatible.

## Verification

- 26 targeted tests passed, including seven new regressions; independently repeated before release. Focused lint, format and both entrypoint typechecks passed.
- Seven deployed application source modules match the frozen reviewed source. Only merchant-connect index/provider application code changed; no schema or frontend release.
- Merchant function code revision 2 → 3. Applying the two environment settings refreshed all 29 function revision counters once; merchant final revision is 4. All 28 other function bundle hashes and settings are unchanged. This was the provider's environment refresh, not additional code releases.
- Admin and partner preflight return 204 with their exact origin; an unconfigured origin returns 403.
- Root verified the real owner Safari session: Reload connections cleared the error and displayed the empty merchant list, invitation form and TEST environment option. The dropdown was dismissed without selecting or submitting.
- Checkout, creator transfers, creator onboarding, external commerce webhook and LIVE merchant connection flags remain false. TEST credentials, callback, other secret digests, all 65 migrations, cron definitions and four original paused jobs remain unchanged. No merchant invitation, assignment, OAuth connection, email, charge or payout was created.

## Remaining product setup

The user's **SpeakSix Marathon Test** product still requires its own managed product/funnel integration binding, draft billing offer and merchant-owned Stripe Price. The existing managed binding belongs only to the isolated QA fixture. Fixing the account-connection interface does not create or activate the product's payment configuration. These records were left untouched.

Stripe's own OAuth callback allowlist was not inspected or changed in this narrow fix. The existing configured callback is preserved. LIVE merchant onboarding, checkout and payouts remain separate activation work.

## Recovery and evidence

Private backups, exact prior configuration, original function bundle, extracted prior source, reviewed frozen source and verification receipts are under .cache/release-backups/20261018-merchant-admin-origin/. Rollback consists of restoring the two prior origin settings and deploying the preserved previous merchant-connect source; no database rollback is needed.
