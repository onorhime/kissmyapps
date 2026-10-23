# KMA production release — 17 October 2026

KMA was deployed with managed checkout, creator onboarding/provider access and creator transfers disabled. No payment, payout approval, transfer, provider onboarding, agreement dispatch or backlog release was performed.

## Deployed artifacts

- Supabase project: `mmyruzjemjecqyivhrgr`.
- Database: 61 migrations, including the 14 pending migrations from `20260907190000` through `20261017010000`.
- Frontend: `20261017T092800Z-kma-speaksix-c79405e9efef`.
- Frontend archive SHA256: `280709521cca8d05e94ca9a12a668408b281b2c4e6a207281afe87cf9b91515e`.
- Frontend asset manifest SHA256: `c79405e9efef91d6889e1c1a88612ae415a14c69f8e15aca5fdf4ecd20577ed0`.
- Frozen source archive SHA256: `e8c4454ffd72aeab945573bcd6bf07f05c10ca307b0f32af5bd618fc9c93103e`.
- Current VPS directory: `/srv/kissmyapps/releases/20261017T092800Z-kma-speaksix-c79405e9efef`.
- Previous release retained: `20260907T170053Z-admin-subscriptions-12ffc5170853`.

Eleven new Edge handlers were deployed: `creator-connect`, `creator-connect-webhook`, `creator-payout-worker`, `external-commerce`, `external-commerce-webhook`, `funnel-metric-events`, `funnel-order-eligibility`, `managed-checkout`, `managed-checkout-webhook`, `managed-checkout-worker`, and `managed-price-verifier`.

All 16 pre-existing function source bundles and JWT settings remained unchanged, including the unrelated `sbfenv` function. Setting the release switches caused Supabase to advance their versions by one. Existing secret digests were preserved.

## Validation and preservation

- Local validation: 894 frontend tests, 18 Node tests, 249 Edge tests, formatting, lint, type checks and production build passed on Node 24.19.0.
- Unchanged local database acceptance: 48 suites passed; three production-record-dependent suites were explicitly skipped.
- Production rollback-only migration rehearsal passed before the commit. The same guarded SQL then committed all 14 updates in one transaction.
- Independent post-commit checks confirmed original migration history, existing commercial settings, agreement terms and payout records were preserved.
- All 36 new tables were empty, RLS-protected and inaccessible directly to browser roles. All 22 inspected sensitive RPCs retained service-only access.
- Existing Cron definitions were unchanged; normal scheduler heartbeat rows continued advancing.
- Production smoke: 32 backend checks plus 74 frontend checks passed. Both dashboard domains served the exact accepted index and all 34 assets.
- Only `kissmyapps-dashboard` was recreated. Fifteen other VPS containers retained their image IDs and start times during that cutover.

## Disabled production gates

The following five flags were explicitly set and their stored digests verified as `false`:

```text
MANAGED_CHECKOUT_ENABLED
MANAGED_CHECKOUT_WORKER_ENABLED
CREATOR_TRANSFERS_ENABLED
CREATOR_CONNECT_ENABLED
EXTERNAL_COMMERCE_WEBHOOK_ENABLED
```

Both existing products have managed checkout disabled. There are no enabled settlement platforms, creator accounts, transfer jobs or managed orders. Existing legacy commercial product settings were preserved; this release does not claim that a separate legacy checkout switch changed.

No authenticated payment or valid-token worker action was used for smoke testing. The payout worker received GET only. These checks establish deployment, access control and disabled gates; they are not evidence of a live payment or bank payout.

## Recovery and evidence

The Supabase dashboard showed restorable daily physical backups, latest `2026-10-16T09:34:27Z`, with seven days visible. A restore was not attempted; storage objects are excluded from these database backups. Private schema/function/history snapshots and data fingerprints were captured before the migration.

Frontend rollback material is retained under the new release's `rollback/` directory: previous pointer, Compose file and Caddy configuration. Restore those and recreate only the dashboard container if needed. Additive database updates require a reviewed forward fix or separately authorized provider restore; do not improvise destructive down migrations.

Private local evidence: `.cache/release-backups/20261017-kma-speaksix/`, including the frozen source and frontend archives, package report, migration apply result, independent verification, function comparisons and production smoke reports.

Payment activation still requires verified production product/funnel/offer and signing bindings, creator platform configuration, and its separate launch checks. The new payment and payout workers were not scheduled by this deployment.
