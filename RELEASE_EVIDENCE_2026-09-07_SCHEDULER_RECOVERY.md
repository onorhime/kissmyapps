# Supervised scheduler recovery — 2026-09-07

User explicitly approved recovering the paused scheduler before the next inline
checkout test. No new checkout, charge, coupon, event replay, payout activation,
credential rotation, migration or function deployment was authorized or performed.

## Pre-recovery inspection

- Exact failed run: `409f4981-dad5-4fbd-817e-87811be6ad37`, metrics-worker.
- Invocation logs previously showed metrics HTTP 502, dispatch HTTP 503 at
  09:17 UTC. The stored HTTP receipt confirmed completed status 503, no timeout
  and no transport error. Stage marked failed/finished at 09:18 UTC.
- At 10:21 UTC, zero active stages and zero pending, processing, failed or expired
  lease entries in all three work queues. Minute cron remained installed/active.
- All three workers and dispatch responded HTTP 401 to unauthenticated probes:
  endpoints boot/respond again and unauthenticated calls do not start work.
- An exact runtime-log query previously returned no rows. The underlying
  provider/runtime cause of the original 502 is not conclusively established;
  this is supervised recovery, not proof that intermittent gateway errors cannot recur.

## Approved mutation

`scripts/recover-processing-scheduler.mjs --test` passed against production in a
rolled-back transaction: scheduler control, original failed stage, cron and
financial evidence remained unchanged. Six dispatch unit tests also passed.

At `2026-09-07T10:23:43.126638Z`, `--resume-approved` reset only scheduler control
to enabled, Stripe-first, no pause reason and no in-flight identity. Inserted audit
row `4ec8a62f-c1b5-42c6-92bd-fd2d88a93736` (`processing.scheduler_recovered`).
The original failed stage remains unchanged. The script is pinned to this exact
run, guards against active work/state drift, and rejects repeated resets.

Complete hashes of checkout attempts, original provider events, subscriptions,
transactions and commissions matched before/after. Counts remained one checkout
attempt, three provider events, one subscription, zero transactions, zero commissions.
No manual worker call or extra cron tick was used; the existing cron resumes work.

## Acceptance

Passed at `2026-09-07T10:27:11.755261Z`. The existing minute cron completed:

| Stage | Run | Completed UTC | HTTP |
| --- | --- | --- | --- |
| Stripe | `45fab58d-83c0-43f0-96d8-6e5f83b267ec` | 10:25:00 | 200 |
| Commercial | `b9f8f057-a2ff-42d6-b326-95d4ee1d48ad` | 10:26:00 | 200 |
| Metrics | `a060cd1f-4a1d-417c-9cb4-30344ff98e4e` | 10:27:00 | 200 |

All succeeded with zero claimed, processed, retried, deferred or failed items
(an empty-queue recovery, not a new-payment test). Scheduler remains enabled,
pause reason null, `attention_required: false`, completed cycle at 10:27 UTC.
The next Stripe stage was already running normally. All queues have zero
pending/processing/failed/expired-lease entries.

Financial record hashes, the original failed-stage row and cron configuration
still match the pre-recovery snapshot. Counts remain one checkout attempt,
three provider receipts, one subscription, zero transactions/commissions.
External transfers remain disabled.

Fresh GET-only coupon validation at `2026-09-07T10:25:17.907Z` returned HTTP 200,
`discountReady: true`, all six term checks true and zero Stripe writes. The
single-use BC Learn 100%-off-forever promotion remains unused and server-applied.

The supervised scheduler recovery is accepted. The next outstanding step is the
user's fresh inline $0 checkout; embedded email prefill, automatic confirmation
and post-checkout reporting still need that actual user acceptance result.
