# Hosted creator-link readiness migration — 18 October 2026

Applied only `20261018110000_admin_managed_link_readiness.sql` to KMA project `mmyruzjemjecqyivhrgr`. Hosted migration count increased from 63 to 64. Readback completed at 11:18:39 UTC.

The migration makes creator-link readiness recognize a verified managed one-time offer as well as the existing subscription path. Managed evidence must match the current offer version, price, currency, amount and active LIVE merchant where assigned. It does not create offers, links or merchant assignments, and does not activate checkout or payouts. The separately frozen frontend release is outside this database record.

## Verification

- Rehearsed the exact SQL in a transaction and rolled it back successfully before committing.
- Rehearsal and commit each preserved every row across all 107 existing application tables; table schemas also remain unchanged.
- Exactly six intended existing SQL functions changed, with one internal helper and two private wrappers added. The other 308 SQL functions and all deployed Edge function versions remain unchanged.
- The new helper and renamed wrappers have no execution permission for `anon`, `authenticated` or `service_role`. Protected admin reader entry points retain their authenticated-only exposure and existing authorization checks.
- All stored secret digests remain unchanged. `MANAGED_CHECKOUT_ENABLED`, `CREATOR_TRANSFERS_ENABLED`, `CREATOR_CONNECT_ENABLED` and `EXTERNAL_COMMERCE_WEBHOOK_ENABLED` remain `false`.
- The exact four pending legacy provider events and their processing records remain unchanged: pending, zero attempts, no claims. The legacy scheduler remains paused with its existing failed-run identity. Cron definitions were preserved.
- No Stripe request, email, worker execution, queue recovery or financial mutation was performed.

## Evidence and recovery material

Migration SHA256: `581753241a31d4e7eb64982b20bdf39b9e8f658dfb54b9d6de2823165ed6b37d`.

Sanitized machine-readable evidence: `hosted-creator-link-readiness-release.json`.

Private, ignored backup directory: `.cache/release-backups/20261018-kma-link-readiness/`. It contains frozen migration SQL, before/after catalogs, migration history, secret digests, paused-job fingerprints, Edge inventory, guarded rehearsal/commit SQL and receipts. Existing reader definitions are retained there. No reverse migration or queue recovery has been run.

No production creator link was created as part of this release. The user's configured product, offer and agreement still need to satisfy the readiness conditions before a commercial link can be issued.
