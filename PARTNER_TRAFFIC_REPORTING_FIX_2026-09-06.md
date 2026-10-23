# Partner traffic reporting repair — September 6, 2026

Status: **deployed after explicit approval**, September 6, 2026. See
[production release evidence](RELEASE_EVIDENCE_2026-09-06_PARTNER_TRAFFIC.md).
The approved release applied only this migration and the scoped frontend bundle.
The earlier fixture test was fully rolled back. Checkout remains disabled; no
checkout, subscription, charge, tracking click, email or financial fact was
created by the reporting repair. An offer-only check reused an existing click.

## Diagnosis

The production BC Learn records contained 2 non-bot TikTok clicks, 2 funnel-start
events and 2 paywall-view events. The latest click was recorded at 12:30:52 UTC.
The latter two counts are events for that click, not two unique people. The
metrics worker refreshed the report at 12:35:01 UTC. Nevertheless, the actual
partner-scoped summary returned `has_data=true`, `clicks=null` and unavailable
financial totals, matching the browser's dashes.

The worker records per-source freshness (`click_tracker=complete`,
`first_party=complete`, `singular=unavailable`) but intentionally leaves overall
completeness partial. Both commercial reporting RPCs previously required every
row to be globally complete before returning any count. A partial subscription
snapshot could also hide otherwise complete traffic. Refresh alone could not
resolve those nulls.

The redirect and funnel behavior are independent of this bug: the funnel captures
`kma_click`, retains attribution, and cleans the visible URL. The observed funnel
events remain linked to the TikTok click. An offer-only production read returned
HTTP 200, USD 100 minor units/month and `checkout_enabled=false`.

## Narrow database change

Migration: `20260906140000_partner_traffic_metric_availability.sql`.
SHA-256: `98b5d000c018a2b32175f8a1158e82789841db92407bf558b5dbc51ddd503b8b`.

Only five traffic aggregates in each existing commercial implementation change:
clicks/visitors use click-tracker freshness; funnel starts/payment views/app-store
clicks use first-party freshness. Complete legacy rows still work. Subscription
snapshots are excluded from traffic availability and sums. Missing, malformed or
incomplete source freshness remains unknown, including mixed known/unknown
buckets. An explicitly measured zero stays zero; an empty result remains null.

Source comparison confirmed all other function text is unchanged: membership,
product authorization, timezone/date/dimension filters, return contracts,
financial gates and reconciliation labels. No whole metric row is marked
complete. Tracking-only routing and private function grants remain unchanged.
Financial and install metrics are deliberately outside this repair.

## Frontend change

- The read-only Performance page requests a background refresh at most once per
  minute while visible, and checks on return to a stale tab.
- Hidden tabs, open forms/dialogs, focused editing controls, pending mutations
  and in-flight automatic reads prevent a new automatic request. Other Partner
  routes do not opt in. Listeners/timers are cleaned up on route/account changes
  and unmount.
- The prior snapshot remains mounted during refresh: no loading-screen swap,
  page reload, navigation or scroll command. Explicit post-save/manual refreshes
  can supersede an older read; a stale response cannot replace the newer result.
- The existing traffic-source table is also available for commercial products.
  Its date buckets preserve unknown values rather than treating them as zero.
  It shows event counts, not unique-person counts.
- Visible guidance explains automatic refresh, processing delay and that a dash
  is unavailable data rather than zero. Preliminary money is not shown as earned
  or payable merely because traffic is available.

## Validation

- Hosted rollback check: **57 assertions passed** using the actual authenticated
  Partner role. Tests cover real traffic, partial snapshots, source-specific
  gaps, malformed/missing freshness, legacy complete rows, measured zero, mixed
  buckets, empty source, unauthorized product/nonmember access and unchanged
  private execution/base-table restrictions.
- The fixture briefly varied only this Partner/product's cached metric rows and
  an unused prior-day cached row. All were rolled back; source clicks, events and
  financial facts were not edited. Before/after definition, metric, product and
  agreement fingerprints, migration count and event/financial counts matched.
- Operator check: `node scripts/check-partner-traffic-reporting.mjs`. It has no
  deployment mode. Sanitized machine evidence is in the ignored
  `.cache/qa/20260906-partner-traffic/database.json`.
- Focused UI/provider suite: **35 tests passed**, including background stability,
  hidden/editing pause, focus coalescing, no automatic overlap, explicit refresh
  superseding an older read, logout/unmount cleanup and commercial source counts
  without fabricated financial zeros.
- Application suite: **712 tests across 53 files passed**, using
  `pnpm exec vitest run --maxWorkers=1 --exclude 'scripts/*.test.mjs'`.
- The two existing Node-only suites pass separately: **9 tests**, using
  `node --experimental-vm-modules --test scripts/register-stripe-webhook.test.mjs scripts/processing-release-guards.test.mjs`.
  The unfiltered `pnpm test` command still incorrectly picks up these Node-only
  suites in Vitest; runner configuration was not changed as part of this repair.
- TypeScript, lint, production build, scoped formatting and `git diff --check`
  passed. Existing bundle-size and jsdom canvas warnings remain non-fatal.

Authenticated Chrome acceptance of the production build subsequently passed:
three existing TikTok clicks, three funnel starts and three payment views were
visible; purchases and earnings remained unknown. Background reporting reads
completed after approximately one minute without a document reload or scroll
reset. Physical-device and screen-reader checks remain separate.

## Deployment boundary

Approval was received and the single migration/scoped frontend release completed.
For future releases, resolve and record the current Hostinger release, preserve the rollback
directory and unrelated containers/configuration, and compare the candidate
against the current deployed assets before activation. This dirty checkout has
unrelated work: do not blindly publish the entire local build or run all pending
migrations. Do not change Edge Functions, Vercel configuration or Stripe.

The existing signed-in Partner account and existing clicks verified the reported
traffic/source counts, unknown financial totals, visible freshness guidance and
background refresh without reload. Product access and private grants were
rechecked. Checkout remains disabled until separately approved.
