# KMA backend release — 22 October 2026

The journey backend was deployed with checkout, creator onboarding, transfers, external-commerce ingestion and live merchant connection gates still disabled. This is a backend release receipt; frontend and SpeakSix deployment are recorded separately.

- Applied migration `20261022100000` once, atomically with its registry entry: 67 → 68 migrations. The guarded transaction preserved all 114 original tables and did not classify or export historical journey data.
- Deployed only `funnel-metric-events`, version 4 → 5, retaining `verify_jwt=false` and the receiver’s server-side signature authentication. Eight deployed source modules match the frozen package exactly.
- Ten affected SQL definitions and their role privileges match the locally verified candidate. The other 28 edge functions, unrelated SQL definitions, cron configuration, custom secrets, all secret names/digests and financial gates remain unchanged.
- Unsigned POST, browser-origin POST and GET requests were rejected with HTTP 401, 403 and 405 respectively. No signed synthetic business events were submitted.
- Supabase refreshed `updated_at` metadata on seven built-in `SUPABASE_*` secrets during deployment. Their values/digests were unchanged.
- Existing scheduled reconciliation continued independently; worker and health timestamps and the existing refunded TEST order can refresh. This is separate from the migration’s exact in-transaction preservation check.

The hosted journey tables remain empty: no configuration, classified clicks, identities or v2 events. SpeakSix capture/delivery gates and historical outbox release must remain off in this gated release. No payment, refund, payout, email, onboarding or Zoom action was initiated.

Local frozen edge tests (7), atomic migration rehearsal/apply and the journey SQL regression passed. The hosted rollback-only rehearsal and deployment verification also passed. Full hashes, checks and scope are preserved in [backend-release.json](backend-release.json). The exact previous receiver bundle and source are retained in the private release packet for rollback.

This is not approval to activate financial flows or to claim live Zoom attendance acceptance.
