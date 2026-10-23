# Managed worker local release checks — October 18, 2026

The missing worker schedule and callback lease gap are implemented locally. No provider, hosted database, webhook, live checkout, email delivery, payout, cron or deployment setting was changed.

Evidence:

- `native-scheduler.json`: disposable PostgreSQL applied all migrations; scheduler/outbox SQL tests passed; six independent worker starts produced one durable owner; a concurrent tick was locked out. Tick HTTP was a recording stub, not hosted `pg_net` delivery. Checks cover disabled/auth boundaries, issued/replayed/stale run IDs, crash/timeout pause, safe expired recovery, exact callback identities/lease rotation, duplicate completion, and existing operations alert aggregation. No provider requests.
- `database-suite.json`: broad isolated SQL suite, 50 passed and zero failed, with three pre-existing suites skipped because they require named production fixtures. This is not a claim that hosted migrations were applied.
- Worker + managed checkout/provider/webhook regressions: 54 passed; worker + updated alert regressions: 19 passed (the seven worker tests overlap these totals).
- Admin Data Health UI/parser: 18 passed, including the new managed checkout alert and delivery summary, backward-compatible absent summary, malformed/inconsistent attention and expired lease counts.

The new schedule is disabled by default. It requires migration `20261018100000_managed_checkout_schedule.sql`, updated worker and alert handler, matching dedicated Vault/Edge secret and one cron entry during a separately approved release. The legacy processing chain and alert recipient/enablement remain unchanged. Sales and creator payouts are separately gated and were not enabled.

The approved hosted release must still verify actual cron/Edge delivery, secret parity, callback response delivery and independent monitor notification. Local scheduler transport is stubbed; response timeout behavior, queues and ownership are real local SQL. See [runbook](../../MANAGED_CHECKOUT_SCHEDULER_RUNBOOK.md) for the staged release and exact recovery checks.
