# Partner traffic reporting — production release, September 6, 2026

Status: deployed, healthy, and verified in the existing authenticated Partner
session. This release exposes known traffic independently from unavailable
analytics/financial totals. It does not enable checkout or establish payment,
commission, subscription, entitlement or payout acceptance.

## Approved scope and database result

- Production Supabase: `mmyruzjemjecqyivhrgr`.
- Only migration `20260906140000_partner_traffic_metric_availability.sql` applied;
  history increased from 40 to 41 entries. No bulk `db push` was used.
- Migration SHA-256:
  `98b5d000c018a2b32175f8a1158e82789841db92407bf558b5dbc51ddd503b8b`.
- Post-commit verification: `2026-09-06T19:26:48.424Z`.
- Current production definitions matched the expected pre-release hashes before
  application. A new rollback-only candidate check confirmed exact source parity:
  only five traffic aggregates changed in each of the two commercial reporting
  functions. Function ownership, arguments, results, grants, stable execution,
  security-definer settings and empty search paths stayed unchanged.
- The deployment transaction used a release advisory lock, bounded lock/statement
  timeouts, pre-state guards, actual partner-context acceptance and a single
  matching migration-history entry. It contained no test fixture writes.
- Private function execution, anonymous report denial and partner restrictions
  on the metric base table remained intact. Non-traffic summary/trend values
  matched the pre-release values. No data was marked globally complete.
- Product, agreement, link and billing-offer fingerprints matched before/after.
  Source records stayed at three clicks and ten browser events; checkout
  attempts, subscriptions, transactions and commissions stayed at zero.

Existing traffic had increased from two to three clicks since the earlier
diagnostic. The current scoped report returns clicks 3, visitors 3, funnel starts
3, payment views 3 and app-store clicks 0. The TikTok breakdown has the same
traffic counts. These are recorded events, not a claim of three distinct humans.
Purchases and earnings remain null, and reconciliation remains preliminary.

## Frontend deployment and preservation

| Item | Value |
| --- | --- |
| Active release | `/srv/kissmyapps/releases/20260906T192427Z-partner-traffic-6afc1b5cbbbb` |
| Rollback release | `/srv/kissmyapps/releases/20260906T082010Z-partner-access-4a011f6f471a` |
| Manifest SHA-256 | `6afc1b5cbbbb3b8c8e1b4f57c802c5fc1c8539ad48d9a874d7e0b9e1fbc4d0ff` |
| Archive SHA-256 | `5d0eacd64316a5f4f06d2e9a9efe63f6b92dd43e30ad4a83c5401d954f71ec00` |
| Index SHA-256 | `0dd632e57dfadd0e4b4e318320a743787ac17acd49117127edd05d9b434ad618` |
| Healthy dashboard container | `d27bbb8e6ff6b82b45dd72563483436a203cf19a7738dfea5668b8de249ea586` |

The package starts with the verified current immutable release. Only
`dist/index.html`, `dist/assets/dashboard-Y1gkqfTB.js` and
`dist/assets/TrendChart-D6EhyXza.js` differ. All 40 other existing files are
byte-identical; older hashed assets are retained, for 43 files total. CSS, fonts,
icons, public files and the deployed demo funnel are preserved. The package
excludes local developer/checkout/fixture artifacts and contains no detected
server-key or service-role credential patterns. No entire local `dist` tree was
published blindly.

Alongside the reporting work, the bundle retains the previously requested
explanatory source-link/Sub-ID copy. Inspection of source modification times
since the previous release found only that Partner link page and the scoped
reporting/provider/type/test files changed; unrelated dirty files were preserved.
No Admin, authentication, Edge Function, Vercel, Stripe or server configuration
change is part of this release.

Activation held `/srv/kissmyapps/.release.lock`, verified the prior pointer,
manifest and Compose/Caddy digests, atomically switched `current`, and recreated
only `kissmyapps-dashboard` using the existing Compose definition with
`--no-deps --force-recreate --pull never`. The running index hash and health probe
matched. All unrelated container IDs and server configuration hashes stayed
unchanged. No shared edge-proxy restart or container prune occurred.

Public checks matched all 43 file hashes on both `partners.kissmyapps.dev` and
`admin.kissmyapps.dev`; both health endpoints returned 200. HTML retained
`no-store, max-age=0` and `X-Frame-Options: DENY`. No tracking URL was opened.

## Authenticated browser acceptance

A fresh Chrome tab reused the existing `nobrainer.ng@gmail.com` Partner session
without disturbing user forms. Before deployment it showed dashes. After the
release it showed:

- BC Learn, Victory Onorhime, Revenue Share · USD, Active · Active.
- Clicks **3**; purchases and earnings **—**, not fabricated zero totals.
- TikTok row: **3 clicks, 3 funnel starts, 3 payment views, 0 app-store clicks**.
- Guidance explaining background refresh, processing delay, unknown values and
  event counts versus unique people. The rendered source table was visually checked.

Read-only network observation recorded summary/trend HTTP 200 responses on
initial load and again approximately 62 seconds later without user refresh.
No document request or page navigation occurred during that refresh window.
The page stayed at `window.scrollY = 100`, and the table retained its values.
Local tests cover hidden/editing pauses, overlapping reads, stale-response
protection, route/account cleanup and unavailable-source handling; production
errors were not deliberately induced. No physical-device or screen-reader
acceptance is claimed.

## Validation and checkout boundary

- Rebuilt final source: TypeScript/build passed, matching the tested asset names.
- Repeated application suite: **712 tests across 53 files passed**.
- Focused Partner provider/UI suite: **35 tests passed**.
- Separate Node-only suites: **9 tests passed**.
- Lint and `git diff --check` passed. Existing nonfatal canvas/bundle warnings
  remain. Unfiltered `pnpm test` still includes the pre-existing Node-only runner
  incompatibility; those suites were run with Node, not misreported as Vitest.
- Earlier hosted fixture regression: **57 assertions**, fully rolled back.
  This release also passed fresh rollback-only and committed existing-record
  acceptance; only the former earlier test used temporary metric fixtures.
- Offer-only verification at `2026-09-06T19:27:38.993Z` reused an existing click:
  HTTP 200, BC Learn Monthly v1, USD 100 minor units/month,
  **`checkout_enabled=false`**. It did not create a Checkout Session.

Next is a separately approved supervised no-charge checkout test: recheck the
100%-off recurring discount and readiness, enable only that controlled test,
have the user confirm a $0 total, then verify the real Stripe webhook,
subscription and attribution. A $0 checkout does not prove paid-revenue,
commission/refund or payout correctness. Never continue if any amount is due.

## Evidence and rollback

Raw local evidence: `/tmp/kma-traffic-release.uqNcbB/`. Durable evidence is retained
under `/srv/kissmyapps/release-evidence/20260906T192427Z-partner-traffic-6afc1b5cbbbb/`.
It includes before/candidate/after database definitions and grants, business
fingerprints, migration identity, tests, source/package manifests, public
verification, offer check and the activation's container/configuration checks.
These artifacts contain no plaintext operator or Stripe credentials.

Frontend rollback must hold the same release lock, assert the current release is
the one above, atomically restore the exact retained rollback path, and recreate
only the dashboard with the existing Compose definition. Keep the compatible
database reporting fix in place unless a database rollback is separately needed.
For such a rollback, inspect current definitions against the captured post-state,
then use the captured pre-state definitions in a new reviewed corrective
migration. Do not delete migration history or business records. Restoring the old
report definitions would reintroduce the hidden-traffic problem.
