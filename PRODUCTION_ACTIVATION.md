# KissMyApps production activation runbook

This is the production-only release and incident runbook for the Partner/Admin
dashboard, tracking gateway, Supabase database, Edge Functions, Stripe ingestion,
and workers. The only Supabase target is `mmyruzjemjecqyivhrgr` (`KissMyApps`). Do
not create or use a local or staging Supabase runtime.

## Current decision: host the control surfaces; do not activate tracking

The Partner/Admin control surfaces and fail-closed redirect gateway are live, but
the platform is not ready for acquisition traffic. Keep
`tracking_enabled = false`. The additive production database foundation and ten
fail-closed Edge Functions were deployed on 2026-08-28. On 2026-08-30, the
immutable dashboard release was deployed beside DramaPal on the Hostinger VPS,
the three `kissmyapps.dev` hosts received valid TLS, and hosted Auth moved from
localhost to the exact production callbacks. Do not configure Stripe/funnel
secrets, schedule workers, enable email, configure a payout provider, or turn on
tracking until the remaining gates below are approved.

The following inputs are still hard blockers:

- The confirmed apex is `kissmyapps.dev`. Production hosts are
  `partners.kissmyapps.dev`, `admin.kissmyapps.dev`, and `go.kissmyapps.dev`.
  Hosting and DNS are complete; this does not authorize tracking traffic.
- This checkout still has no Git `HEAD`. The initial backend release was recorded
  with aggregate source digest
  `698c58044508e0ea5e6d10461477eec79038f3d5ba6e6660711d27463f30f2c6`;
  establish a reviewed commit/tag before any later release.
- All 12 migration versions through `20260828220000` now match the linked remote
  history exactly. Continue reconciling the history before every later release.
- There is no approved real product/funnel, live Stripe credential or Price ID,
  bilaterally signed commission document, payout provider/operating procedure, or
  approved data-retention schedule. Resend remains deferred.
- The current QA administrator is Operations, while enabling tracking requires a
  password-proven Owner. Provisioning or changing that authority needs approval.

## Production topology and invariants

| Surface           | Production value                        | Invariant                                                                                 |
| ----------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Supabase          | `mmyruzjemjecqyivhrgr`                  | Verify this ref before every database, secret, or Function action.                        |
| Partner dashboard | `https://partners.kissmyapps.dev`       | Hostinger/Caddy immutable build; publishable key only; preview disabled.                  |
| Admin dashboard   | `https://admin.kissmyapps.dev`          | Same artifact, hostname-default Admin workspace; authorization remains server-controlled. |
| Redirect gateway  | `https://go.kissmyapps.dev`             | Existing edge Caddy forwards only `GET /r/*`; never cache redirects.                      |
| Funnel            | Exact approved HTTPS origin(s)          | No wildcard CORS or redirect origins.                                                     |
| Tracking          | `tracking_enabled = false` during setup | It is the final activation switch, never a deployment convenience.                        |

Use UTC in the release record. Record the approver, operator, source revision,
artifact digest, migration list, backup/restore-point ID, hosting deployment IDs,
Function versions, Stripe endpoint ID, secret version/fingerprint (never the
value), configuration record IDs, test evidence, and rollback owner.

## 1. Release preflight (read-only)

1. Confirm all three exact production hosts still resolve to the approved
   Hostinger VPS and retain valid TLS before a later release. Do not change the
   apex or nameservers as part of this platform release.
2. Confirm the release is a clean reviewed commit/tag and that no credential is
   present in tracked files or build output. If source control is still absent,
   stop and establish it before another production release.
3. Confirm `supabase/.temp/project-ref`, the CLI target, and the release record all
   identify `mmyruzjemjecqyivhrgr`. Stop on any mismatch.
4. Run the source checks from the release revision:

   ```bash
   pnpm install --frozen-lockfile
   pnpm validate
   deno fmt --check supabase/functions supabase/config.toml
   deno lint --config supabase/functions/deno.json supabase/functions
   deno check --config supabase/functions/deno.json \
     supabase/functions/{tracking-redirect,browser-events,funnel-events,checkout-session,stripe-price-verifier,stripe-webhook,stripe-worker,commercial-worker,metrics-worker,reconciliation-worker}/index.ts
   deno test --config supabase/functions/deno.json --allow-env supabase/functions
   pnpm exec supabase migration list --project-ref mmyruzjemjecqyivhrgr
   pnpm exec supabase db push --dry-run --project-ref mmyruzjemjecqyivhrgr
   ```

5. Inventory current Auth users/roles, storage buckets/objects, public row counts,
   migration history, Functions, secrets by name, hosted Auth settings, and current
   DNS/hosting records. Never export secret values into the release record.

## 2. Backup and migration replay gate

Migration replay on the only real project is destructive maintenance, not a
normal deploy step. It requires a separate approval naming the exact scope,
maintenance window, expected data loss, operator, and rollback decision. Never
run a reset, `DROP`, migration-history repair, or the script under
`supabase/retirement/` from this runbook.

Before an approved replay:

1. Stop writes: confirm tracking is false, pause active offers/funnels if any,
   stop worker schedules, and prevent Admin/Partner mutations during the window.
2. Create and verify a provider-managed restore point/PITR snapshot. Also write
   encrypted logical schema, data, and role dumps to an approved path outside the
   repository. A database dump alone is not proof that Auth state or Storage
   objects can be recovered; inventory and back those up separately.
3. Perform a restore drill or provider verification and record the recovery point
   and recovery owner before destructive work begins.
4. With the separate approval in hand, replay only `supabase/migrations/` in
   timestamp order against `mmyruzjemjecqyivhrgr`. Do not seed business records;
   `supabase/seed.sql` intentionally contains none.
5. Require the remote migration list to match the checked-in list exactly. Run
   the complete transactional pgTAP suite against a fresh isolated PostgreSQL 17
   replay before the change, then run linked remote lint after the change. The
   linked migration login intentionally cannot query the protected base tables,
   so do not weaken grants merely to run pgTAP remotely:

   ```bash
   # Fresh isolated PostgreSQL 17 replay: migrations, then tests 00-13.
   pnpm exec supabase db lint --project-ref mmyruzjemjecqyivhrgr --fail-on error
   ```

6. Reconcile the pre/post inventories: Auth identities and roles, partner/admin
   access, private document bucket/object counts, public row counts, RLS/grants,
   audit history, and migration history. On any mismatch, keep tracking false and
   restore or forward-fix under the recorded incident decision.

For an ordinary additive release, review the dry run and use a separately approved
`db push`; do not edit an already-applied migration. Database rollback is a
forward migration or an approved restore, never an improvised down migration.

## 3. Domains, dashboard, and hosted Auth

The first hosting release completed these steps on 2026-08-30. Repeat them for a
later release without broadening the boundaries:

1. Keep hosted Supabase Auth Site URL at
   `https://partners.kissmyapps.dev` and the redirect allowlist at exactly
   `https://partners.kissmyapps.dev/#auth/reset` and
   `https://admin.kissmyapps.dev/#auth/reset`. Preserve the checked-in token-hash
   invite callback. Do not add wildcard or local production URLs.
2. Build the dashboard with only:
   `VITE_SUPABASE_URL=https://mmyruzjemjecqyivhrgr.supabase.co` and the production
   publishable key. A service-role/secret key must never be a `VITE_` value.
3. Deploy the immutable `dist/` artifact to a new
   `/srv/kissmyapps/releases/<release-id>` directory, switch
   `/srv/kissmyapps/current`, and recreate only `kissmyapps-dashboard`. Production
   builds must remove preview statements.
4. Validate the full edge Caddyfile, back up the active DramaPal Caddyfile, write
   the candidate into the existing bind-mounted inode, and restart only
   `dramapal-caddy-1`. Do not run or prune the mixed historical DramaPal Compose
   project. The edge forwards only `GET /r/*` on `go.kissmyapps.dev`.
5. While tracking remains false, prove TLS, security/no-store headers, dashboard
   Auth routing, a fail-closed redirect response, and every existing DramaPal
   route before and after activation. Acquisition traffic stays off.

## 4. Hosted Edge configuration and deployment

Store production values in the hosted secret manager, never in Git, Vite, command
history, screenshots, or the release record. Set values through an untracked,
access-controlled temporary environment file and delete it securely after the
secret manager confirms receipt.

Required names (values deliberately omitted):

- `TRACKING_HASH_SECRET`
- `ADMIN_ALLOWED_ORIGINS`
- `BROWSER_EVENT_ALLOWED_ORIGINS`
- `CHECKOUT_ALLOWED_REDIRECT_ORIGINS`
- `FUNNEL_HMAC_BINDINGS`
- `FUNNEL_EVENT_ALLOWED_NAMES`
- optional `FUNNEL_EVENT_ALLOWED_PROPERTIES`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `INTERNAL_WORKER_SECRET`

Supabase provides its hosted URL and secret/service-role key mapping. Do not copy
those into frontend variables. Confirm secret names with `supabase secrets list`;
do not print values.

`FUNNEL_HMAC_BINDINGS` is one structured, server-only JSON map keyed by
`x-kma-key-id`. Each entry contains exactly `secret`, `product_id`, and
`funnel_id`. Use one independently generated 32+ character secret and key ID per
funnel; never bind one key across funnels. The same mapping belongs in the funnel
server and Edge secret stores, never browser code. The current Functions verify
the signature and then verify that the key's product/funnel binding matches the
canonical click/acquisition. Rotate by overlapping a new key ID, switching the
funnel server, proving it, and then removing the old entry.

The initial versions of these ten Functions are active on the exact project ref
with gateway JWT verification disabled as designed. For a later release, deploy
the reviewed sources with the explicit import map and do not use `--prune`:

```bash
pnpm exec supabase functions deploy \
  tracking-redirect browser-events funnel-events checkout-session \
  stripe-price-verifier stripe-webhook stripe-worker commercial-worker \
  metrics-worker reconciliation-worker \
  --project-ref mmyruzjemjecqyivhrgr \
  --no-verify-jwt --use-api --import-map supabase/functions/deno.json
```

All ten Functions intentionally have gateway JWT verification disabled in
`supabase/config.toml` because each implements its own boundary (public route,
origin check, HMAC, Stripe signature, bearer session, or worker secret). Verify
those application-level controls; do not make an unauthenticated worker public.

## 5. Real commercial configuration

Keep tracking false while an approved Owner/Operations operator creates the real
draft product, exact funnel destination, source/campaign records, billing offer,
partner agreement/rule, and main link. Do not use fixture data or `.invalid`
URLs.

Before any product, funnel, offer, agreement, or link becomes active, retain
evidence that:

- the destination and checkout redirect origins are exact production HTTPS URLs;
- the partner, product, default funnel, campaign/source (when present), and link
  are in compatible active/live states;
- the agreement/rule is versioned and effective, and the commission document is
  signed by both the Partner and KissMyApps;
- the Stripe Price is live, active, and exactly matches mode, currency, and
  integer minor amount through `stripe-price-verifier`; and
- payout destination verification, holds, human approval, reconciliation, and
  statement handling have an approved operator even though no provider transfer
  worker exists.

The current Stripe normalizer supports subscription Checkout. It rejects
one-time `payment` Checkout events; a one-time offer is therefore a launch blocker
until the normalization path and its tests are extended.

## 6. Stripe endpoint

Create one live webhook endpoint at:

`https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/stripe-webhook`

Pin the endpoint to `2026-02-25.clover`, matching the source-pinned version used
by every direct Stripe request. Allow only:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `customer.subscription.created`, `.updated`, `.deleted`
- `invoice.paid`
- `refund.created`, `refund.updated`
- `charge.dispute.created`, `.updated`, `.closed`

Do not subscribe to `charge.refunded`; the worker rejects that aggregate event.
The webhook must receive the exact raw body, verify its Stripe signature, accept
only live-mode events, and persist duplicate IDs idempotently. Record endpoint ID,
API version, event selection, and secret version—not the secret.

## 7. Workers, scheduling, and monitoring

Deploying a worker does not schedule it. No scheduler or alert thresholds are
checked in, so cadence, retry/backlog SLOs, log retention, paging destination,
and on-call ownership must be approved before scheduling.

Invoke each worker with `POST` and `x-kma-worker-secret`, in dependency order:

1. `stripe-worker` — at most eight 90-second leases; stops starting work after
   45 seconds and reports any remainder as `deferred`.
2. `commercial-worker` — turns normalized facts into deterministic conversions
   and ledger entries, including refund/dispute reversals.
3. `metrics-worker` — refreshes partner daily metrics.
4. `reconciliation-worker` — run only after immutable provider evidence and a
   reconciliation run exist. It compares recorded evidence; it does not fetch a
   Stripe total. The implementation plan's target is nightly reconciliation.

Do not schedule overlapping chains until real run duration and backlog behavior
are measured. Alert on non-2xx responses, authentication/configuration failures,
`retried`, terminal `failed`, unexpected `deferred`, growing/old queues, lease
expiry loops, and reconciliation `business_failed`. Correlate only bounded
`request_id`/internal IDs. Logs must not contain webhook payloads, claim tokens,
authorization headers, customer data, or secret/HMAC values.

Workers never approve a payout or transfer funds. If a worker is faulty, pause
its schedule while leaving the signed Stripe webhook ingesting durable events;
repair, replay the queue idempotently, and reconcile before resuming.

## 8. Privacy and retention gate

The tracker persists keyed hashes of IP, session, and user agent—not raw IP—and
sets an HttpOnly/Secure/SameSite=Lax `kma_sid` cookie for one year. Funnel browser
attribution defaults to 30 days and is capped at 90 days. Event properties are
allowlisted and common direct identifiers are rejected. New Stripe rows store
only the allowlisted normalization fields plus an exact SHA-256 fingerprint of
the signature-verified raw body; names, emails, addresses, and payment details
are discarded before persistence. Private documents and canonical financial
history still have separate legal sensitivity.

Before public collection, approve and publish a data map and retention/deletion
schedule covering cookies/local storage, clicks/acquisitions, event properties,
Stripe payloads and canonical financial facts, Auth/profile data, private
documents, audit logs, worker diagnostics, and backups. Document purpose, lawful
basis/consent where applicable, access owner, retention clock, deletion or
anonymization method, backup expiry, and data-subject request handling.

There is no checked-in purge/anonymization job. Do not promise automatic deletion
or delete immutable agreement, commission, payout, audit, or reconciliation
evidence ad hoc. Implement and test the approved policy, keep event/property
allowlists free of PII, and complete cookie/privacy notice review before launch.

## 9. Acceptance evidence and final activation

All evidence must come from the real project and confirmed production hosts:

- source revision clean; `pnpm validate` and all Deno checks pass;
- backup/restore evidence complete; remote migration list exact; remote lint and
  all transactional database tests pass; RLS/base-table grants remain fail-closed;
- desktop/mobile Auth invitation, password setup, sign-in, refresh, role gates,
  Partner/Admin switching, recovery, and sign-out pass on hosted production;
- preview mode is unavailable; unauthenticated/unauthorized tenant access fails;
- dashboard and redirect TLS/DNS/header checks pass, and disabled tracking fails
  closed without creating click/acquisition rows;
- one approved partner/product/funnel/agreement/rule/offer/link is fully ready;
- browser CORS allowlist and event/property allowlists pass; wrong origin, wrong
  HMAC, stale timestamp, conflicting retry, and cross-funnel key/click attempts
  fail, while exact retries remain idempotent;
- redirect -> `kma_click` capture -> browser event -> signed funnel event -> live
  subscription Checkout -> signed webhook -> Stripe normalization -> commercial
  ledger -> metrics -> reconciliation is proven with exact canonical IDs;
- duplicate and out-of-order webhooks, renewal, cancellation, refund, dispute,
  worker retry/lease recovery, and queue drain are evidenced; unexplained
  reconciliation difference is `$0.00`;
- payout calculation/statement and human approval are proven without an external
  transfer, and the privacy/retention/monitoring/on-call gates are signed off.

`tracking_enabled` must remain false until the full E2E evidence is approved and
is then changed only as the final Owner/password-authenticated launch action.
There is an important current limitation: `tracking-redirect` cannot create the
first canonical click while that flag is false, and the repository has no canary
bypass. Therefore a literal production redirect-to-money E2E cannot presently be
completed before the first true state. Do not weaken the database gate. Either
add and verify an approved private canary mechanism first, or obtain a separate
approval for a time-boxed final enable-and-smoke window with no public traffic.
On any failure, immediately return the flag to false.

After the successful final smoke, recheck queue age, worker responses, Stripe
delivery, canonical totals, partner-visible metrics, and error logs before public
traffic is released.

## 10. Rollback and kill switch

1. **Stop acquisition first:** use the password-proven Owner tracking action
   (`configure_admin_tracking`) to retain the confirmed base URL but set
   `enabled: false`. Verify new `/r/*` requests fail closed and create no rows.
2. **Stop new Checkout:** pause the affected active billing offer(s). Disabling
   tracking alone does not invalidate previously created click IDs. Pause the
   funnel/link as a secondary containment control.
3. **Preserve provider truth:** keep the Stripe webhook accepting signed events.
   Pause worker schedules only if processing is unsafe; otherwise drain and
   reconcile already accepted events. Never delete queues or financial history.
4. **Application/gateway rollback:** repoint `/srv/kissmyapps/current` to the last
   known-good immutable release and recreate only `kissmyapps-dashboard`. For an
   edge rollback, copy the recorded Caddyfile backup back into the existing
   bind-mounted inode, validate it, and restart only `dramapal-caddy-1`. Do not
   run/prune the historical DramaPal Compose project or change nameservers.
5. **Function rollback:** redeploy the last known-good tagged Function sources to
   the same project. Rotate a compromised tracking, HMAC, worker, or Stripe secret
   through both sides of its contract and record the new secret version.
6. **Database rollback:** prefer a reviewed forward fix. Restore the verified
   backup only under incident approval after recording the recovery point and
   expected loss window.
7. Re-run authorization, queue, reconciliation, and partner-visible checks. Keep
   tracking false until a new acceptance record is approved.
