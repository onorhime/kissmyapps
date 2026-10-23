# KissMyApps workflow release — 15 October 2026

## Release state

Production deployment is approved by the user. **No production change has been
made by this release yet.** The hosted backend access gate is unresolved. Keep
the current frontend active until the required backend contracts are available.

The current workspace intentionally contains earlier uncommitted work. Preserve
it; the release package includes a complete source snapshot rather than relying
on the old Git HEAD as the release identity.

## Verified preflight

- Intended Supabase project: `mmyruzjemjecqyivhrgr` (KissMyApps).
- Both existing macOS Keychain Supabase CLI entries authenticate, but neither
  account has this project in its accessible project list. Targeted migration,
  function and secret inventory requests return HTTP 403. The browser is signed
  in to the same unrelated organization set. No credentials were rotated.
- Relevant repository environment files, existing release backups, CLI config
  and VPS deployment paths did not provide a separate KMA management credential.
- Both production dashboard hosts return HTTP 200 with no-store and security
  headers. They continue to serve the previous release.
- Active VPS pointer:
  `/srv/kissmyapps/releases/20260907T170053Z-admin-subscriptions-12ffc5170853`.
- The isolated `kissmyapps-dashboard` container uses the existing Caddy image and
  read-only bind mounts. This release needs no image build or shared proxy edit.
- VPS free space was 3.4 GB. Recheck immediately before staging; no cleanup is
  authorized as part of this release.
- Frontend build passes. Full Edge formatting, lint, type checking and **208
  tests** pass. Local workflow testing previously passed 45 native PostgreSQL
  suites, 864 frontend tests and 11 Node tests. Three operator-only database
  suites still require hosted identities; these were explicitly skipped locally.
- The real cross-application local fixture passed signed purchase ingestion,
  pending → fulfilled eligibility, duplicate receipt handling, scoped dimensions,
  canonical commission calculation and hold preservation. This is not a live
  provider payment or payout acceptance result.

## Local recovery material

Directory: `.cache/release-backups/20261015-marathon-workflow/`.

- `source-snapshot.tar.gz`: tracked and untracked non-ignored source, excluding
  environment files. No clean/reset operation was used.
- `20261015T-workflow-a7f47643f89f.tar.gz`: immutable frontend candidate.
- `SHA256SUMS` and `package-report.json`: exact asset manifest and package size.
- Manifest SHA-256:
  `a7f47643f89f16d454ca8dbbfa7d7076fece230262ae1afad793cc64a2756dd4`.
- Frontend package: 659,359 bytes, 33 files.

The source snapshot must be refreshed if code or documentation changes before
release. The asset digest changes only when the built frontend changes.

## Resume sequence after access is restored

1. Reconfirm the exact project and read the actual remote migration history,
   function versions/bundle digests, secret **names/digests only**, Auth settings,
   scheduled jobs, merchant scopes, products/funnels, and commercial configuration.
   The existing frontend release does not prove the backend migration baseline.
2. Save private schema/function definitions and configuration fingerprints before
   change. Verify provider backup/restore coverage. Do not export secret values or
   customer data into the repository or release evidence.
3. Compare the live migration history against local timestamps. Likely pending
   work is the September admin payout migration and the October migrations below,
   but this list is **not an authorized substitute for checking the live history**:

   - `20260907190000_admin_payout_workflow`
   - `20261013100000_external_commerce_held_ledger`
   - `20261014100000_funnel_metrics`
   - `20261014110000_database_validation_repairs`
   - `20261014120000_external_commission_settlement`
   - `20261014130000_creator_connect_receipts`
   - `20261015100000_canonical_external_commercial_policy`
   - `20261015110000_legacy_commission_refund_policy`
   - `20261015120000_external_merchant_adjustment_receipts`
   - `20261015130000_canonical_order_eligibility`
   - `20261015140000_funnel_reporting_dimensions`

4. Review and apply only absent additive migrations, with a bounded lock timeout,
   transaction and migration-history checks. Never replay an already-applied
   file, reset the database or repair history to conceal a mismatch. Verify
   existing agreements, payout settings and scheduled jobs remain unchanged.
5. Deploy the new handlers `external-commerce`, `funnel-metric-events`,
   `funnel-order-eligibility`, `creator-connect`, `creator-connect-webhook`,
   `creator-payout-worker` and `external-commerce-webhook`. Compare already
   deployed handlers/shared dependencies before deciding which need updating.
   Use the established explicit project deployment, custom handler authentication
   and no-prune procedure. Do not overwrite unrelated functions.
6. Keep `CREATOR_TRANSFERS_ENABLED=false`. Preserve existing settings and do not
   enable `CREATOR_CONNECT_ENABLED`, `EXTERNAL_COMMERCE_WEBHOOK_ENABLED`, schedules
   or a backlog merely to make a smoke test pass. The payout worker must not be
   invoked with transfer permission, and no payout batch may be approved.
7. Coordinate producer/receiver configuration with the SpeakSix release. Metrics
   use `FUNNEL_HMAC_BINDINGS`; commerce and order eligibility share
   `EXTERNAL_COMMERCE_HMAC_BINDINGS`. Bind only verified production product,
   funnel, merchant account and live/test mode. Never reuse local fixture IDs or
   credentials. Missing bindings are a visible integration gate, not a reason to
   create new agreements or change existing commercial terms.
8. Run non-mutating or deliberately rollback-only backend acceptance first:
   anonymous denial, browser-origin rejection, invalid signature rejection,
   handler availability, migration contracts and authenticated read-only reports.
   Do not manufacture live purchases or fulfillment evidence for a smoke test.
9. Stage the verified frontend under a new immutable VPS release directory,
   verify `SHA256SUMS`, record the previous pointer and container identity, switch
   `/srv/kissmyapps/current` and recreate **only** `kissmyapps-dashboard`.
   The root release agent owns shared Caddy/SpeakSix changes.
10. Verify the container health, exact served asset hashes, both dashboard hosts,
    protected admin/creator routes, report empty/held states and existing routes.
    Record actual migration/function versions and remaining integration gates.

## Rollback

Frontend: restore the previous `/srv/kissmyapps/current` pointer and recreate only
`kissmyapps-dashboard`. Retain both immutable artifacts.

Backend: use a reviewed forward fix or verified provider restore under explicit
scope. Do not improvise destructive down migrations. Newly deployed inactive
handlers can remain fail-closed without releasing work.

Deployment does not authorize sending agreement/marketing backlogs, modifying
commission agreements, approving payouts, initiating transfers/reversals, or
accepting legal provider onboarding.
