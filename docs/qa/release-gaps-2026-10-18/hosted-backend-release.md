# KMA backend release — 18 October 2026

The approved backend release is deployed to Supabase project `mmyruzjemjecqyivhrgr`. This record covers schema, Edge deployment and protected-boundary checks. Successful signed webhook delivery and email receipt are separate coordinated acceptance work.

## Installed and preserved

- Applied exactly `20261017100000_merchant_connections.sql` and `20261018100000_managed_checkout_schedule.sql`; hosted migration count is now 63.
- The transaction was first rehearsed and rolled back. Both rehearsal and commit preserved original-column row fingerprints across 98 existing tables, all existing agreement terms and the three legacy cron definitions.
- The new merchant tables are empty and RLS-protected, sensitive RPCs remain service-only, and the new managed schedule is disabled with no worker runs.
- Deployed exactly ten functions: `external-commerce`, `external-commerce-webhook`, `funnel-order-eligibility`, `managed-checkout`, `managed-checkout-webhook`, `managed-checkout-worker`, `managed-price-verifier`, `merchant-connect`, `merchant-connect-webhook`, and `processing-alerts`.
- All 19 unrelated Edge function bundle hashes and JWT settings were preserved. Independent SQL catalog comparison found 270 unchanged functions and 13 intentionally changed existing functions.
- All pre-existing secret digests were preserved. No secret, Auth setting, cron job, Stripe endpoint, provider account or financial record was changed by this backend release.

## Validation at the backend checkpoint

Seventeen hosted HTTP method/access rejection checks passed. The new merchant endpoints are deployed and reject requests while unconfigured. The managed worker rejects unauthenticated/browser requests. These checks do not establish successful signature acceptance or delivery.

Managed orders, managed deliveries, merchant connections and worker runs were all zero. `MANAGED_CHECKOUT_ENABLED`, `MANAGED_CHECKOUT_WORKER_ENABLED`, `CREATOR_TRANSFERS_ENABLED`, `CREATOR_CONNECT_ENABLED` and `EXTERNAL_COMMERCE_WEBHOOK_ENABLED` were each verified by their stored digest as `false`. This is a checkpoint before root-coordinated acceptance; refresh gates after any subsequent configuration work.

## Recovery material

Private local directory: `.cache/release-backups/20261018-kma-backend/`. It contains the migration baseline/catalog, existing Edge bundle backups, migration rehearsal/commit SQL and results, frozen source manifest/archive, deployment receipt, function preservation comparison and `post-release-verification.json`.

Frozen function source archive SHA256: `77be4ba257f18bf6e6b844b81f2cdade270624b7dfec2a49ba89472b5af280e4`.

Supabase reported seven physical backups; the newest completed backup was recorded at `2026-10-17T09:37:16.852Z`. No restore was performed. Schema recovery requires a reviewed forward fix or separately approved restore; no destructive down migration was prepared.
