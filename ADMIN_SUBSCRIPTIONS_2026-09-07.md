# Admin Subscriptions — implementation and acceptance

Status: **deployed September 7, 2026** after explicit user approval. The hosted
schema now has 47 migrations and the read-only RPC is live. Public asset checks,
database acceptance and Partner-host separation passed. The Admin browser is
signed out, so the final password-authenticated Admin visual check remains open.
See `RELEASE_EVIDENCE_2026-09-07_ADMIN_SUBSCRIPTIONS.md`.

## Scope

The Admin navigation and `#admin/subscriptions` route now lead to a read-only
directory. Search supports partner name, product name, Stripe subscription ID or
internal account ID. Product/status filters, newest/oldest ordering and 25-row
server pagination accompany filtered status counts. A focused detail dialog
shows recorded billing periods, source/campaign/funnel, click Sub 1–3 values,
acquisition identity, original checkout list price and zero-total evidence.

No cancellation, refund, payment, entitlement, replay, export or transfer action
was added. Buyer emails, Stripe customer IDs, public checkout tokens, payment
details, raw events and destination URLs are excluded from the projection.

`get_admin_subscriptions` is a password-proven Owner/Operations/Finance/Analyst
read contract. Support, non-admin, missing-session and recovery-only sessions
are denied. It grants no direct base-table access and changes no existing RLS,
normalizers, financial facts, scheduler, secrets or Edge Functions.

## Meaning of the data

- Active and trial subscriptions are distinct from paid invoices or revenue.
- Zero-total checkout is shown only when an exact normalized
  `checkout.no_payment_required` fact matches the subscription, account,
  acquisition and product. It does not promise future renewals are free.
- List price comes from the original Checkout attempt, not an inferred amount
  collected. USD is displayed in dollars; other currencies retain explicitly
  labelled provider minor units rather than assuming a two-decimal exponent.
- Paid invoice count uses canonical positive-gross transactions. It excludes
  zero-total invoices, does not subtract refunds and is not a net-revenue KPI.
- Missing timestamps/attribution remain “Not recorded”. Period end is not a
  guaranteed charge date. Subscription status is not an app-access grant.
- Pending/unprocessed Stripe receipts produce a visible preliminary-state
  warning. Snapshot timestamps are shown in UTC and become visibly stale after
  three minutes. Refresh is manual and does not unmount the current table while
  loading; a failed/unauthorized refresh removes outdated data.
- Search/filter changes reset pagination. Request cleanup ignores out-of-date
  responses. The shared dialog preserves keyboard focus and scroll position.

## Validation completed

- `vitest run src integrations deploy --maxWorkers=1`: **757 passed, 56 files**.
- `node --experimental-vm-modules --test` for the two existing operations script
  suites: **9 passed**. The unscoped Vitest command still discovers these
  Node-specific suites and fails to bundle `node:test`; they must be run with
  their documented Node runner. No unrelated test configuration was rewritten.
- TypeScript project build, targeted lint, formatting and production Vite build
  passed. Existing large-chunk warnings remain. No synthetic subscription
  fixture text was found in the production asset bundle.
- Database checks: **50 assertions passed**, including actual authenticated
  role execution, each allowed role, denied roles/session types, literal search,
  bounded pagination, exact subscription/source/partner/placement/list-price
  mapping and zero-total versus paid-invoice evidence. All candidate DDL and
  temporary role changes rolled back.
- Local browser: 1280-pixel directory and detail dialog visually inspected;
  390-pixel directory/dialog, empty and unavailable states inspected. Document
  width stayed 390 px, with only the labelled table region horizontally
  scrollable. Escape restored focus to the original details button. Automated
  axe checks passed for the directory/dialog with jsdom color-contrast disabled;
  this is not native-device or screen-reader acceptance. The viewport override
  was reset after testing.

Read-only candidate check at **2026-09-07 16:15:56 UTC** returned two active
subscriptions, both verified zero-total initial checkouts, zero recorded paid
invoices and no unprocessed Stripe receipts. This check does not make a fresh
provider call, verify future renewals, or prove paid commission/payout acceptance.

Before/after fingerprints matched:

| Evidence                   | Fingerprint                        |
| -------------------------- | ---------------------------------- |
| Subscriptions              | `05c23091be9c11c4da810bcda01b9a1b` |
| Provider events            | `ba13b95436d518fc93f30123011a3950` |
| Checkout attempts          | `14c730b2945bc901ae17f6b770188ee9` |
| Transactions / commissions | `d41d8cd98f00b204e9800998ecf8427e` |
| Admin roles                | `d06e90918d9ecfc971f0126194d216ec` |

## Files and local preview

- `supabase/migrations/20260907180000_admin_subscriptions.sql`.
- `supabase/tests/database/36_admin_subscriptions.sql` and
  `scripts/check-admin-subscriptions.mjs` (rollback-only; no deployment mode).
- `src/features/admin/api/subscriptions.ts` and gateway/type wiring.
- `src/features/admin/subscriptions/` plus Admin navigation/App route tests.
- Local synthetic preview:
  `http://127.0.0.1:3011/integrations/admin-subscriptions-ui-check/`.
  The preview is labelled synthetic and makes no Supabase/Stripe/email calls.
  Its `?state=empty`, `?state=error` and `?state=pending` variants are QA-only.

Candidate migration SHA-256:
`0f19a97e9f11948a382020b1c13c2af103274e4b36eedc0d1e11c65e933d022d`.

## Production release and remaining acceptance

The user requested “deploy and tell me whats next”. Applied only the additive
RPC migration and deployed a scoped dashboard package retaining all 50 existing
manifest-listed non-entrypoint files, including developer documentation. Three
new hashed assets and the dashboard entrypoint changed. No Edge Function,
secret, Stripe, funnel, billing record, admin role, base-table ACL/RLS policy,
existing database function or cron definition changed.

Fresh pre-release checks: 113 focused UI tests, 50 rollback-only database
assertions, TypeScript and production build passed. Post-release verification
matched all 54 files on each public host (108 checks). A read-only SQL transaction
using the actual `authenticated` database role and an existing Owner's password
claims returned two active TikTok-attributed subscriptions, two zero-total
checkouts, no paid invoices and no pending Stripe receipts. This is database
role-context acceptance, not a password login through the live Admin browser.

The existing signed-in Partner session correctly routed an Admin hash back to
Partner Performance. Its five clicks, two subscriptions and zero paid purchases
remained visible. The signed-out Admin route correctly required login. Remaining:
sign in at `https://admin.kissmyapps.dev/#admin/subscriptions`, check both rows,
open a detail dialog, and exercise search/filter/refresh. Support denial passed
the database regression suite; an actual Support-browser session was not tested.

If rollback is needed, restore the retained prior dashboard release documented
in the release evidence; the unused read-only RPC may remain without affecting
billing processing. Next development scope is Admin Payouts and a controlled,
human-approved payout workflow, not automatic transfers.
