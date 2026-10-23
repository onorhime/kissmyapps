# Payment processing scheduler

Scope: Supabase `mmyruzjemjecqyivhrgr`. The processing chain processes recorded
facts; it does not create Checkout sessions, enable checkout, approve payouts,
transfer money, send emails, or fetch reconciliation evidence. A separate
notification monitor, deployed September 7, sends operational alerts only.

## Operation

`kma-processing-chain` runs `kma_internal.tick_processing_schedule()` every
minute. The persisted sequence is Stripe → commercial → metrics → repeat. A
tick starts at most one stage, and only after the preceding HTTP response has
been validated. A normal cycle takes about three minutes; this is an initial
low-volume cadence, not a payment-to-dashboard latency guarantee.

The new `processing-dispatch` function accepts only the current, once-claimed
database-issued run ID and an allowlisted worker. Its dedicated credential is
stored encrypted in Supabase Vault (`kma_processing_scheduler`) and in the Edge
secret `PROCESSING_SCHEDULER_SECRET`. It calls the existing workers with the
existing `INTERNAL_WORKER_SECRET`, which is not rotated or exposed to cron.
Agreement maintenance, webhook ingestion, and the worker source bundles are
independent and unchanged.

Each worker keeps its existing idempotency, database leases and per-item retry
policy. A completed batch with retried/failed/deferred items is recorded as
degraded, then the chain continues so valid downstream facts can progress.
Stripe attempts cap at ten; commercial/metrics attempts cap at eight. This
scheduler does not reset attempts or resubmit a terminally failed financial fact.

An unknown/missing response, transport timeout, non-200 response or malformed
result pauses the chain and retains its in-flight identity. There is no timed
automatic reset that could overlap a worker still running. Dispatch HTTP waits
up to 80 seconds; pg_net waits up to 100 seconds; a missing response is treated
as unknown after three minutes. Existing unrelated external invocations cannot
be governed by this scheduler, but the workers' fact-level leases still apply.

## Health and initial thresholds

From the dashboard checkout directory:

```sh
node scripts/release-processing-scheduler.mjs health
```

Or through an authorized SQL console:

```sql
select public.processing_scheduler_health();
```

Only privileged operators/service-role callers can read this original RPC.
Admin → Data Health now uses a separate `get_admin_processing_health` read model
restricted to password-authenticated Owner/Operations accounts. It exposes
aggregate queues, freshness, the latest historical issue and notification
health, not the recipient, provider payloads or secrets. Browser users cannot
start workers, change scheduling, read the original privileged report or read
the scheduler credential. The UI refreshes each minute while visible, retains
scroll position and reports unavailable/stale data instead of assuming health.

`attention_required` becomes true for a pause, no tick for three minutes, no
completed cycle for ten minutes, degraded/failed stages in the last hour,
terminally failed facts, or unfinished queues older than ten minutes. These are
initial operator review thresholds, not a commercial uptime/SLA promise. Inspect
`expired_leases` as well. A newly enabled schedule reports attention until its
first complete cycle; that is expected.

Check Supabase Cron → `kma-processing-chain` for tick failures and Edge Function
logs for the relevant worker. The SQL dispatcher emits fixed-code warnings for
pauses and degraded batches. Do not export `net.http_request_queue`, secret
tables, request headers or complete provider payloads when collecting evidence.

During supervised acceptance tests, check health before and after each phase.
Scheduler run logs are not automatically deleted; approve a retention policy
before public launch.

## Independent operational email alerts

Deployed and enabled September 7, 2026 for `onorhimevictory2017@gmail.com`.
`kma-processing-alerts` invokes `kma_internal.dispatch_processing_alerts()` every
minute independently of the Stripe → commercial → metrics chain. It can observe
a paused worker chain while Supabase Cron, the database and Edge Functions remain
available. **It cannot provide outside-system monitoring for a complete Supabase
outage.** An independent external uptime/paging service remains a launch gap.

The `processing-alerts` Edge Function requires its own `PROCESSING_ALERT_SECRET`,
matched to encrypted Vault entry `kma_processing_alerts`. Only an empty POST is
accepted; callers cannot supply recipients, messages, links or payment actions.
The server-owned recipient receives:

- One failure notification per incident for a paused chain, stale heartbeat or
  cycle, recent failed/degraded worker, terminal failure, expired lease or stalled
  queue. No repeated reminders are sent for an unchanged open incident.
- One recovery notification after all reasons clear, a full cycle completes
  after the incident opened and health remains clear for at least two minutes.
  A recent failed/degraded stage remains a reason for one hour, so recovery mail
  can be delayed until that lookback expires, then the stability period passes.
- One explicitly labelled setup test. It does not simulate a payment failure.

Mail uses the existing Resend credential and
`KissMyApps Operations <partners@send.kissmyapps.dev>`. Messages contain fixed
operational reasons and timestamps, never customer/payment payloads or secrets.
The outbox freezes each envelope before sending, serializes logical sends and
uses `processing-alert/<job UUID>` as the stable idempotency key. A two-minute
lease and bounded exponential backoff allow retries; jobs stop after eight
attempts or a twenty-hour retry window. This stays within Resend's documented
[24-hour idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys).
An ambiguous send must not be retried with a new key or after that window without
first checking its exact provider receipt.

Read-only operator verification:

```sh
node scripts/processing-alerts-ops.mjs status
```

Inspect monitor freshness, pending/failed notifications and the provider ID for
each job. `accepted` means Resend accepted the request, **not** inbox delivery.
Check the matching ID in Resend for delivery/bounce status. The Admin panel warns
if the monitor check is missing/over three minutes old or an email job failed;
it is not a second email channel for failure of the notification system itself.

The September 7 setup test was accepted on its first attempt at 15:35:01 UTC,
provider ID `d0538c6f-5203-480e-bf6f-e13b1a271c89`. Inbox delivery remains to be
confirmed by the recipient. See
`RELEASE_EVIDENCE_2026-09-07_PROCESSING_ALERTS.md` for complete release proof.

Deployment modes in `scripts/processing-alerts-ops.mjs` are guarded one-time
operations, not recurring maintenance commands. Do not rerun them to recover a
worker or force another test. The monitor never restarts workers, resets retries,
replays payments or changes financial records. Retain incident/outbox evidence.

## Failure diagnostics

The dispatcher now forwards the database-issued run ID as `x-request-id` and
records a write-once current-run diagnostic for worker HTTP failure, transport
failure or malformed response. Only the worker, run ID, fixed code, bounded
upstream HTTP status and duration are retained. Worker response reads are capped
at 4 KiB; raw bodies and headers are never included in this diagnostic table.
Original scheduler start/finish/tick/health definitions and recovery rules remain
unchanged. Old incidents can lack these new fields; missing evidence is not
backfilled or guessed.

## Pause, recovery and rollback

```sh
node scripts/release-processing-scheduler.mjs pause-approved
```

This disables future stages without clearing the current identity, touching
financial rows, or disabling signed Stripe ingestion. The minute cron can remain
installed: while disabled it only updates its heartbeat and returns `paused`.

On failure, first inspect the stage, underlying function completion and all
three lease queues. Repair the cause. Do not clear an ambiguous run while its
worker could still be executing. After an operator explicitly approves recovery
and verifies no invocation/lease is active, reset only the scheduler control row
to Stripe, clear its in-flight fields and pause reason, then enable it. Retain
all stage history and financial evidence. A future tick resumes the existing
queues idempotently; do not fabricate or replay raw payments to unstick a run.

The supervised September 7 recovery is recorded by
`scripts/recover-processing-scheduler.mjs`. Its `--status` mode is read-only.
Its `--test` mode rolls back all changes. `--resume-approved` is deliberately
pinned to the inspected failed run, requires a completed non-timeout HTTP receipt
older than ten minutes, no unfinished stages, empty work queues and one active
minute cron. It changes only the scheduler control row and appends an audit row.
It refuses repeated recovery of that run. Do not generalize the target or bypass
its guards to recover a later failure without separately inspecting that failure.

Rollback is to pause this schedule; all pre-existing worker and webhook source
bundles are unchanged. Remove only this cron job/new dispatcher if subsequently
requested. The disabled schema and its audit history can safely remain.
Reconciliation scheduling is deliberately excluded until provider evidence and
the separate reconciliation procedure are ready.

To roll back **notifications only**, first obtain operator approval, disable the
singleton in `kma_internal.processing_alert_config` and unschedule only the
exact `kma-processing-alerts` cron job. Do not change agreement maintenance or the
processing chain. An already submitted provider request may still complete;
inspect its receipt instead of deleting or re-enqueuing it. Preserve the outbox,
incidents and diagnostics. The retained previous dashboard release can be
restored separately if needed; no financial migration rollback is required.

## Implementation references

The scheduling mechanism follows Supabase's
[scheduled Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)
and [pg_net response handling](https://supabase.com/docs/guides/database/extensions/pg_net).
Credential provisioning is separate from migration history. See
`scripts/release-processing-scheduler.mjs` for guarded release modes and
`supabase/tests/database/30_processing_scheduler.sql` for rollback-only tests.
