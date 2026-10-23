# Partner recorded billing and click-count clarity — September 7, 2026

## Result

Deployed and verified in an authenticated Chrome Partner session. BC Learn now shows:

- Verified clicks: **5**.
- Recorded paid purchases: **0**.
- Recorded earnings: **USD 0.00**, explicitly preliminary and not available for payout.
- Active / trial subscriptions: **2**, including the two completed no-charge tests.
- TikTok source breakdown: **5 clicks, 5 funnel starts, 5 payment views, 0 app-store clicks**.
- Links & Sources: **6 raw clicks, all time**, with an explanation of bot filtering and reporting windows. Prior read-only reconciliation found one bot-classified visit among those six.

The second embedded test is represented by subscription `sub_1UD1UpE47mNwFlz1wfTNhxFa` and invoice `in_1UD1UpE47mNwFlz1UR5eNZBX`. Stripe's active subscription, paid zero-dollar invoice, forever discount, and matching attribution metadata were independently checked in the preceding verification turn. This reporting change does not create another checkout or subscription.

## Cause and bounded change

The commercial summary/trend RPCs withheld every financial metric unless every cached row was globally complete. The metrics worker deliberately marks rows partial while Singular is unavailable, including subscription snapshots. That optional analytics dependency hid known processed Stripe data indefinitely.

Migration `20260907150000_partner_billing_metric_availability.sql`:

- Separates recorded billing availability from optional analytics, using Stripe freshness plus successful cache-refresh evidence. Legacy complete rows remain supported.
- Withholds billing totals while Stripe receipts or commercial calculations remain unresolved, and while the partner/product reporting range has an unfinished metric refresh. The upstream queue check is intentionally conservative across Stripe/commercial work because receipts may lack partner attribution until normalized.
- Rejects partial cached billing when refresh evidence is missing or newer than the cache. Missing/malformed freshness remains unknown, never a fabricated zero.
- Keeps traffic and paid amounts separate from subscription snapshots; snapshots alone cannot invent zero revenue or clicks. Uses the latest eligible snapshot rather than summing subscription snapshots.
- Retains currency aggregation checks, preliminary reconciliation, lead/install unknowns, existing caller authorization, function contracts, private helper access, and every payout rule.
- Changes reporting definitions only. It does not mark rows globally complete, recalculate money, grant base-table access, release payouts, or alter financial facts.

Frontend changes are limited to `LivePartnerPortal.tsx`, `LiveLinksPage.tsx`, and their tests: explicit recorded-paid labels, a subscription count, preliminary/non-payable guidance, and raw-versus-filtered click explanations.

## Validation

- 121 database assertions passed inside a transaction that rolled back completely. Covered measured zero, nonzero cached amounts, absent/malformed freshness, stale cache, unknown snapshot, pending/failed Stripe processing, missing/unfinished metric evidence, unfinished commercial calculation, legacy complete rows, mixed known/unknown dates, empty filters, nonmembers, foreign products, anonymous denial, and private helper/base-table restrictions.
- The unmatched-currency test is rejected by the existing agreement-integrity trigger. No trigger was disabled and no foreign-currency agreement was manufactured. Cross-currency aggregation guards remain in both RPCs.
- 246 focused Partner/UI tests passed; the broader `src` application suite passed **684 tests across 48 files**. These overlap and are not additive. This is not a claim that every integration/Node-only runner was rerun.
- TypeScript/Vite production build, lint, changed-file formatting, and `git diff --check` passed. Existing nonfatal bundle-size and jsdom canvas notices remain.
- Existing-record acceptance ran twice with rollback, then inside the deployment transaction. Public function contracts/grants, all other public function definitions, and record fingerprints matched before/after.

## Production database

- Project: `mmyruzjemjecqyivhrgr`.
- Applied at approximately `2026-09-07T13:15:57Z`; migration count **43 → 44**, one scoped migration, no bulk push.
- Migration SHA-256: `9b4fc883e112721011f8cc5ac7fcff6a91970e48950325cc28f45bc345afee32`.
- Summary definition MD5: `c0c77b9ea209d282895ef1b1230edaa2`.
- Trend definition MD5: `0339e9599ebcf3790ff105e8ce42ae58`.
- The release script pins the prior definitions/history and rejects rerunning against drifted or already-applied state. Do not reuse its one-shot apply command for another release.

## Production frontend

- Current: `/srv/kissmyapps/releases/20260907T131413Z-partner-billing-c6854b31bcb9`.
- Previous retained: `/srv/kissmyapps/releases/20260907T091300Z-funnel-docs-v13`.
- Manifest SHA-256: `c6854b31bcb98dfbcccd6fab565ed161547b7e2ba9b2fa403c44860bc4f74f5a`.
- Index SHA-256: `84742aa3520752f49efff7f6c1303a4d49b2cbfc5217dfff4038b21b975fa096`.
- Package changes only `dist/index.html` and two new hashed JavaScript files. All 45 other existing public files, including v1.3 developer docs omitted from the previous release's legacy manifest, are preserved. New manifest covers 48 files.
- Both public hosts matched all 48 file hashes; both health endpoints returned HTTP 200.
- Only `kissmyapps-dashboard` was recreated. Other container IDs and Compose/Caddy configuration hashes stayed unchanged. No edge proxy restart, Stripe/Edge Function change, or Vercel deployment occurred.
- Generated AppleDouble packaging sidecars were removed from this new release's public `dist` directory after inventory; actual public assets remained hash-verified. The original archive retains those recoverable metadata sidecars. No user-authored content was removed.
- Authenticated desktop DOM and visual inspection confirmed the four reporting cards and explanatory text. Live Links & Sources confirmed the raw-click label and count. No tracking URL was opened for this release.

## Processing and remaining gates

At `2026-09-07T13:18:16Z`, the scheduler was enabled and unpaused; all three queues had zero unfinished/failed items and no expired leases. Health still retained the earlier automatic retry in its one-hour degraded-run window. Records remained at two checkout attempts, six provider receipts, two subscriptions, zero transactions, and zero commissions. External transfers remained disabled.

This closes the reporting availability/click-label gap. It does not establish paid revenue, refunds, settled commissions/payouts, device wallet availability, or app-entitlement fulfillment. Explicit confirmation of the user's email-prefill/inline/automatic-success experience remains separate from backend recording proof. Earlier scheduler HTTP-502 root-cause/alerting work remains open.

Local release evidence and rollback script: `/tmp/kma-billing-release.0HDOQI/`. Server evidence: `/srv/kissmyapps/release-evidence/20260907T131413Z-partner-billing-c6854b31bcb9/`.

Frontend rollback must hold the release lock, assert the current pointer, restore the exact retained previous release, and recreate only the dashboard with the unchanged Compose definition. This compatible reporting migration need not be rolled back with the frontend. A database rollback must be separately reviewed, restoring only the two previous reporting definitions and removing the unused private helper, never rewriting business records.
