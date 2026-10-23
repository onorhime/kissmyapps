# Production processing scheduler — September 6, 2026

Authorized scope: configure and verify the background Stripe → commercial →
metrics chain while leaving checkout disabled. No Stripe customer, subscription,
payment, discount redemption, refund, payout transfer or reconciliation was
initiated. The four pre-existing Stripe destinations and the new dedicated
webhook were not modified in this release.

## Released

- Supabase project: `mmyruzjemjecqyivhrgr`.
- Migration: `20260906130000_processing_scheduler.sql` (40 migrations total).
- Migration SHA-256:
  `f1638f4e7ba1e0d1c2706696ac98c29b0ee4a70bc12c39e14db7345ccf3a6cd6`.
- New Edge Function: `processing-dispatch`, version 1, ACTIVE, gateway JWT check
  disabled; dedicated credential and current-run checks are enforced internally.
- Function ID: `bec60a23-cd3c-407d-a2e5-805e13bd068c`.
- Deployed bundle `ezbr_sha256`:
  `fc5b4f726a7225d199cc8ef3ca248d382aa116dd430f6516701c756ae049027b`.
- New cron: `kma-processing-chain`, one tick per minute, sequential persistent
  stages. One complete cycle normally takes about three minutes at low volume.
- A new random scheduler-only credential was stored in Supabase Vault and Edge
  secrets. Digests matched; all existing secret digests were preserved. No
  plaintext credential was persisted locally or printed.

All twelve previous function bundle hashes matched their pre-release values.
The six downloaded TypeScript files in the new deployed bundle byte-match the
local handler and shared dependencies. The `kma-agreement-maintenance` cron row
fingerprint was unchanged. No Vercel, Hostinger, Sites or dashboard UI deployment
was performed.

## Validation

- `pnpm test:edge`: formatting, lint, types and **120 tests passed**, including
  six new dispatch tests for authentication, current-run gating, allowlisting,
  duplicate prevention, transport/response failure and safe result projection.
- **64 hosted database assertions passed inside BEGIN/ROLLBACK**. They exercised
  permissions, ordering, once-only starts, stale/duplicate results, malformed
  counts, pause-on-uncertainty, waiting, expired dispatches and health reporting.
  No worker, network request or financial processing RPC was called by this
  SQL fixture. Application fingerprints were identical after rollback.
- Three release-guard tests passed. Missing bundle metadata fails closed; the
  guards use the actual Management API `ezbr_sha256` field.
- Node syntax, scoped formatting and `git diff --check` passed.
- Live unauthenticated POSTs to all three workers and the new dispatcher returned
  **401**. A correctly authenticated but unissued run returned **409**, without
  starting a worker.

## Observed automatic execution

Acceptance snapshot: **2026-09-06 11:12:44 UTC**.

| Scheduled stage | Dispatched UTC | Validated response | Claimed / processed |
| --------------- | -------------- | ------------------ | ------------------- |
| Stripe          | 11:09          | HTTP 200           | 0 / 0               |
| Commercial      | 11:10          | HTTP 200           | 0 / 0               |
| Metrics         | 11:11          | HTTP 200           | 1 / 1               |

The metrics item was an existing refresh queued at 09:43, not a synthetic payment
or newly fabricated test event. The next Stripe stage began at 11:12 after the
metrics result was validated. All four observed cron ticks succeeded. Responses
are recorded when the next tick consumes them; the recorded finish time is not
an exact measurement of worker execution duration.

At acceptance, all three queues had zero pending, processing, failed and expired
lease counts. `attention_required=false`, schedule enabled, no pause reason.
Products, offers, agreements, documents and agreement-cron fingerprints matched
pre-release values. Checkout attempts, provider events, subscriptions,
transactions and commissions remained zero.

The offer-only check reused the existing BC Learn public click ID. It returned
HTTP 200, `monthly` version 1, USD 100 minor units per month, and
`checkout_enabled=false`. This lookup can refresh the offer quote/rate counter;
it does not create traffic, a Checkout session or a payment. An earlier diagnostic
used the internal click-record UUID and correctly returned `not_found`; the
acceptance check uses `public_click_id`, as required by the funnel contract.

Machine-readable evidence and the downloaded source bundle are in the ignored
`.cache/release-backups/20260906-processing-scheduler/` directory:
`database-test.json`, `database-release.json`, `pre-deploy.json`,
`function-release.json`, `schedule-release.json`, `live-acceptance.json`, and
`deployed/`. These reports contain operational IDs/hashes, not credential values.

## Boundaries and next gates

The automatic chain and a real metrics refresh are verified. Empty Stripe and
commercial runs do **not** prove financial event normalization or commission
calculation against a real Stripe delivery. The dedicated webhook registration
report from the prior release verified signature probes, not a real Stripe
payment event.

Next: verify restricted-key discount/resource permissions and the product-bound
100%-off recurring promotion. Obtain approval for enabling the gated checkout
and creating/cancelling the actual zero-total subscription. Then observe real
Stripe delivery → normalization → dashboard state, while ensuring a zero-total
subscription does not create a paid commission. Paid billing, refund/dispute
reconciliation, entitlements and payout release remain separate acceptance work.

Health reporting and fixed-code logs are implemented; external paging/email
alerts, public-launch ownership and log retention policy are not configured.
See `PROCESSING_SCHEDULER_RUNBOOK.md` for thresholds, supervised-test checks,
pause and guarded recovery. Reconciliation is intentionally not scheduled.

## Rollback

Pause with `node scripts/release-processing-scheduler.mjs pause-approved` from
this checkout. It disables further scheduled stages while retaining in-flight
identity and history. Leave signed webhook ingestion active. No existing worker
bundle needs restoration. Never delete financial facts or clear an ambiguous
run/lease until its underlying invocation is proven finished.
