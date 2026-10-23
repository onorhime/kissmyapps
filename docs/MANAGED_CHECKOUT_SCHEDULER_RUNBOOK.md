# Managed checkout reconciliation schedule

Status: implemented and tested locally on October 18, 2026. Nothing here has been applied to hosted Supabase. Checkout, creator payouts, and the new database schedule remain disabled. This is a separate schedule; the existing Stripe → commercial → metrics processing chain is unchanged.

## Runtime behavior

The minute tick is `kma_internal.tick_managed_checkout_schedule()`. It issues a database-owned run ID and calls only `managed-checkout-worker` with the dedicated `MANAGED_CHECKOUT_SCHEDULER_SECRET`. The matching Vault secret is named `kma_managed_checkout_scheduler`; it is provisioned separately, never committed. Browser-origin requests are rejected. An unauthenticated caller, wrong secret, arbitrary run ID, replayed run, or concurrent invocation cannot begin work.

A singleton row serializes both scheduled and explicitly authenticated manual worker invocations. `MANAGED_CHECKOUT_WORKER_ENABLED=true` is required in either case. Manual reconciliation may run while the schedule is intentionally disabled, but cannot bypass an occupied or failed/paused run. Enabling reconciliation does not enable new quote/create requests or creator transfers. Those existing money gates remain independent.

Each run starts at most six reconciliation/callback work units, with a 45-second overall provider/callback transport deadline and five-second database request timeouts. The worker checks the deadline before every new work RPC and provider request. It claims one callback immediately before sending it, with a 15-second request timeout. This replaces the unsafe pattern of leasing ten callbacks and sending them serially against the same 60-second lease. Late acknowledgements cannot finish an expired callback lease.

Successful callbacks must return `accepted: true` and the exact stable `event_id`. Bodies over 4 KiB, wrong acknowledgements, redirects, HTTP failures and transport timeouts remain retryable. Existing event identities, capped backoff, provider idempotency keys, historical account/mode resolution and commission/refund rules are preserved. The worker never creates a new checkout or transfers money to a creator. Reconciliation can complete an already authorized/idempotent application-fee refund.

The run lease is 120 seconds, is never renewed indefinitely, and its heartbeat is recorded between work units. Binding order rotates using a durable cursor so a bounded run can continue across configurations. A crashed, expired, rejected or ambiguous dispatch is retained and the schedule pauses. It is never automatically cleared simply because an HTTP request timed out.

## Release checklist — requires deployment approval

1. Apply `20261018100000_managed_checkout_schedule.sql` before deploying the updated worker. The migration creates a disabled control row, run history, private monitoring/recovery RPCs, and strict callback lease completion. It installs no secret, cron job or activation.
2. Deploy `managed-checkout-worker`, the updated `processing-alerts` reason allowlist, and their shared dependencies. Deploy the admin health summary with its backward-compatible parser. Keep `MANAGED_CHECKOUT_ENABLED=false` and all creator transfer/payout gates disabled. Set `MANAGED_CHECKOUT_WORKER_ENABLED` only as explicitly approved for reconciliation acceptance.
3. Generate a dedicated secret of at least 32 characters, store it in Edge secrets as `MANAGED_CHECKOUT_SCHEDULER_SECRET`, and in Vault as `kma_managed_checkout_scheduler`. Do not reuse the manual worker secret or a webhook signing secret. Inspect the expected project URL in the tick function before installing in another project.
4. Inspect `cron.job` for the exact name `kma-managed-checkout`. Install one minute job only if absent; never replace or unschedule legacy jobs:

   ```sql
   select cron.schedule(
     'kma-managed-checkout', '* * * * *',
     'select kma_internal.tick_managed_checkout_schedule();'
   );
   ```

   While the control row is disabled this job only updates its heartbeat and returns `paused`; it does not invoke an Edge worker. The local native tests stub `pg_net`, so actual hosted `pg_cron`/`pg_net` delivery, Vault/Edge secret parity and deployed runtime timing remain release acceptance checks.
5. Read `public.managed_checkout_scheduler_health()` using a service role or trusted operator session. Verify one cron definition and fresh tick timestamp. Confirm the private health endpoint and tokens are inaccessible to anonymous/users.
6. Enable only this control row after worker/provider/callback configuration has been verified and operator approval permits reconciliation. Observe at least two successful run receipts and a real signed TEST callback acknowledgement before declaring hosted delivery accepted. Keep checkout and payouts disabled during this staged release.
7. Restore/pause any temporary TEST provider endpoints according to the existing test isolation plan. No live charges or payouts are part of this checklist.

## Monitoring and incident recovery

`public.managed_checkout_scheduler_health()` reports schedule state, current run, heartbeat, twelve recent outcomes, callback pending/leased/expired/retry counts, oldest unfinished callback, reconciliation due/retry counts, and attention status. It deliberately reports scheduler capabilities, not guessed runtime checkout/payout flags. This summary also appears in the existing Admin Data Health panel. The existing independent alert monitor receives `managed_checkout_issue` whenever managed delivery needs attention; its recipient, enablement and delivery workflow remain unchanged. No new emails are enabled or sent by this migration. Missing/stale heartbeat is detectable even if the worker never starts. Verify the existing alert monitor is configured and delivers a controlled TEST failure/recovery notification during the approved release acceptance; a local outbox test is not proof of hosted email delivery.

A run error is retained without payloads, secrets or customer data. `failed`/`degraded` runs remain visible for an hour; a stale enabled scheduler, old callback backlog, expired running heartbeat, or repeated reconciliation failures require attention.

Pause future dispatches without clearing ownership:

```sql
update kma_internal.managed_checkout_schedule set enabled=false where singleton;
```

For a failed or unknown invocation, inspect its function logs, current ownership, expired callbacks and provider receipts. After the actual runtime has ended and the cause is repaired, an operator may recover **the exact failed run**:

```sql
select kma_internal.recover_managed_checkout_schedule('<inspected-run-uuid>');
```

Recovery refuses a wrong ID, enabled/unpaused schedule, active lease, or a run younger than three minutes. It preserves history and leaves the schedule disabled. A separate explicit enable is required to resume scheduled dispatch. Do not clear financial facts, fabricate payment receipts, reset callback IDs or repeat a new charge/refund to recover delivery.

Rollback: pause this schedule and optionally remove only its exact cron job/worker release under approval. Keep the disabled schema/run history and provider ingestion intact. Never roll back by deleting order, commission, refund or callback evidence.

## Local evidence

- `deno test --config supabase/functions/deno.json --allow-env supabase/functions/managed-checkout-worker/index_test.ts` covers default secret separation, disabled/browser rejection, concurrent worker exclusion, one-at-a-time claims, finite work, deadline stop, wrong/oversized acknowledgement, and lost database completion.
- `node scripts/test-managed-worker-native.mjs` applies every migration to disposable local PostgreSQL, runs real schedule/outbox SQL assertions, races six independent connections for one owner, and checks advisory-lock tick exclusion. Network transport is stubbed and no provider is called.
- `node scripts/test-database-native.mjs` runs the broad isolated database suite. Three historical tests needing named production fixtures remain documented skips; this is not hosted database verification.
- Root cross-application tests additionally exercise pay-first and legacy matching-first callbacks with receiving checkout disabled, using bounded repeated worker passes.
