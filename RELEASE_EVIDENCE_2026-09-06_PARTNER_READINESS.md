# Partner readiness and launch completion — 6 September 2026

## Scope and root cause

Approved scope: repair the Partner product/link-options read permissions and the Admin/Partner status presentation. No products, agreements, signatures, links, tracking events, payments, checkout sessions, discounts, emails or payouts were created or changed by this repair. No pending checkout migration, Edge Function or Vercel deployment is included. Unrelated dirty workspace changes are preserved.

Authenticated production diagnosis on 5 September showed HTTP 403 / PostgreSQL `42501`, `permission denied for function agreement_is_launch_ready`, from both `partner_product_directory` and `partner_link_option_directory`. The same session could read the existing active BC Learn agreement. Admin still showed the saved main link. These were data-read and presentation failures, not missing configuration.

The product view only reached its private agreement readiness call after the current main link and commercial launch conditions existed. The link-options view also called that private helper; the tracking-only branch contained another private helper. Simply granting execution on the original helpers would not be an adequate partner-scoped access boundary.

## Database release (completed before the usage-limit interruption)

- Supabase project: `mmyruzjemjecqyivhrgr`.
- Applied only `20260905223000_partner_readiness_access.sql`, at `2026-09-05T22:33:22.478Z`.
- Migration SHA-256: `f27604306f5fe5bc4d18ae4e5bfbd4a70382bee880dc704c6f1f06f19b250770`.
- Migration count: 35 → 36. Checkout migrations `20260905110000` and `20260905120000` remain outside this release.
- Two stable, empty-search-path, security-definer boolean wrappers check `auth.uid()` and current active membership before evaluating readiness. Product readiness checks an existing relationship through agreements, links, payouts or metrics; it does not expose arbitrary product readiness or raw destinations.
- Wrapper execution is restricted to `authenticated`; anonymous execution remains denied. Original internal helpers, base-table grants, view security barriers and view grants remain unchanged. The only changes to the existing view definitions are the two scoped helper references.
- Application fingerprints matched for products, funnels, agreements, documents, commission rules, affiliate links and billing offers.

`supabase/tests/database/28_partner_readiness_access.sql` is an operator acceptance script for the existing BC Learn chain, not a fixture-independent pgTAP suite. Before deployment it passed in a fully rolled-back transaction with the migration, then passed inside the approved deployment transaction and again after deployment. It uses actual `SET LOCAL ROLE authenticated` and local JWT claims to check current-member reads, missing-session/non-member denial, null/unknown IDs, full view projections, existing main-link availability, unchanged internal-helper/base-table restrictions and anonymous execution grants. It creates no fixture identities or application records.

After the database release, the real Chrome partner session loaded BC Learn, `Revenue Share · USD`, the active agreement and its existing main link. Product, link-options, agreement, link-history, document and reporting reads returned HTTP 200. No tracking URL was opened during acceptance.

## Frontend changes

- Already-active products show `Product activation is complete` instead of failing the draft/paused activation prerequisite. The actual activation guard still rejects duplicate activation.
- Once every currently eligible partner has an active main link, issuance shows completed. Partners with existing links remain excluded from duplicate issuance. A paused link, revoked agreement or disabled tracking gate is not falsely marked complete.
- Failed product reads show `Products unavailable`, `Agreement details unavailable` and a read-only retry action instead of claiming that configuration does not exist. Successful empty reads remain distinct; Profile & Documents remains independently accessible.

New regression cases cover completion, duplicate-action guards, paused/revoked states, multiple eligible partners, partial permission failures on three Partner routes, retry recovery without a write and true empty configuration. One prior unconfigured-shell test now expects unavailable rather than a fabricated zero-product state. No authentication implementation changed.

## Frontend release

Status: deployed, healthy and authenticated-browser acceptance passed on both production dashboard domains.

| Item | Value |
| --- | --- |
| Active release | `/srv/kissmyapps/releases/20260906T082010Z-partner-access-4a011f6f471a` |
| Rollback release | `/srv/kissmyapps/releases/20260905T213049Z-ui-interactions-8009b8a54f85` |
| Active manifest SHA-256 | `4a011f6f471a0f924ca2a12c1247c391cda6ba47c2ae56d1555baffa20a4bd75` |
| Rollback manifest SHA-256 | `8009b8a54f853e93fad5044061df4a8d4bb8c95dc8fe9a83d9ed32bac594a80d` |
| Archive SHA-256 | `e6613ecd5a863a25547c221feb4dde48875141f7916aa16ff941ce35a191defe` |
| Active index SHA-256 | `c907349457d18d2e40a2787c597ac1b3f944d1e97e6f6a89ef7f332c1a4d2f86` |
| Healthy dashboard container | `b252c0384dd75388acfbd9f9ca5e552ef2e912da0e12cfcc229ea42558d2792f` |

Only `dist/index.html`, `dist/assets/dashboard-IULno7y9.js` and `dist/assets/TrendChart-Dbxjxnce.js` differ. All 38 other prior files are byte-identical; old hashed assets are retained (41 total files). The package preserves the deployed demo funnel and public files, excludes unreleased local developer/checkout/fixture artifacts and contains no detected server-key/service-role credential patterns.

## Verification and rollback boundary

Build, application TypeScript, lint, focused formatting and `git diff --check` passed. The final full application run passed all 703 tests with zero failures (`frontend-tests-release.json`). The existing Vite large-chunk warning and jsdom canvas notices remain non-fatal.

The activation held the release lock, verified the exact prior release and both configuration digests, atomically switched the release pointer and recreated only the dashboard container. It became healthy; the running index matched the package. All other running container IDs and the Compose/Caddy configuration hashes were unchanged. The prior immutable release is retained.

Public post-release checks matched all 41 packaged file hashes on both `partners.kissmyapps.dev` and `admin.kissmyapps.dev`. Both health endpoints returned HTTP 200, HTML remained `no-store, max-age=0`, and `X-Frame-Options` remained `DENY` (`public-verification.json`). These checks did not open the tracking gateway.

Fresh authenticated Chrome tabs verified the deployed frontend without reloading existing user tabs or drafts:

- Admin (onorhimevictory2017@gmail.com): BC Learn shows green `Product activation is complete` and `All eligible partners already have an active main link` indicators, the completed-issuance banner, and exactly one existing main link. The duplicate-issuance button remains disabled. The former false eligibility warning is absent. The green indicators were also checked visually.
- Partner (nobrainer.ng@gmail.com, Victory Onorhime): BC Learn is selected, `Revenue Share · USD` and `Active · Active` appear, and the existing main URL is present. The source-link form opens with the live `bclearn` funnel and all 12 sources, including Instagram and TikTok. It was cancelled without submission; the count remains zero source variants. The main link was not opened or copied.
- Unavailable/error and true-empty states were covered by local regression tests; production failures were not deliberately induced. No physical-device or screen-reader acceptance is claimed.

Frontend rollback must hold `/srv/kissmyapps/.release.lock`, assert the exact current pointer, atomically restore the prior immutable directory and recreate only `kissmyapps-dashboard` with the existing Compose definition, `--no-deps --force-recreate --pull never`. Do not restart the shared edge proxy or prune unrelated services.

The database fix is compatible with the prior frontend and should remain during a frontend rollback. If a database rollback is specifically required, inspect current state and the captured pre-apply view definitions first; restoring those definitions would reintroduce the reported Partner failure. Do not delete signed evidence or edit migration history as a rollback shortcut.

Temporary raw evidence: `/tmp/kma-partner-access.IQ0dUD/`. Before/after database definitions and fingerprints, the rollback-only test report, migration identity, frontend test reports and package hashes contain no credentials. Durable deployment evidence is retained under `/srv/kissmyapps/release-evidence/20260906T082010Z-partner-access-4a011f6f471a/`, including this record, the scoped SQL migration/acceptance checks, database reports, final test report, package report and public verification report. Activation also saved before/after container and configuration checks there.

Payment/checkout integration and live attribution-click acceptance are not claimed by this repair. Physical-device and screen-reader checks remain separate gates.
