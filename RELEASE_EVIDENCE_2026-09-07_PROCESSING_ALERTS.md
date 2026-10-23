# Processing diagnostics and operational alerts — September 7, 2026

## Outcome and scope

Deployed to Supabase `mmyruzjemjecqyivhrgr` and the existing KissMyApps dashboard
on Hostinger. Failure/recovery operational email is enabled for the user-supplied
`onorhimevictory2017@gmail.com`. The setup test was accepted by Resend; recipient
inbox delivery has not been verified. The independent alert minute job is not an
external monitor for a complete Supabase outage.

No checkout, subscription, provider event, transaction or commission was created
or rewritten by this release. No payout, transfer, refund, promotion or app
entitlement was created. Stripe workers/webhook, the Vercel funnel, agreement
maintenance and its email template were not deployed or changed by this release.

## Historical incident investigation

The previously recovered metrics run was
`409f4981-dad5-4fbd-817e-87811be6ad37`. Provider logs showed a metrics HTTP 502 at
09:17:00.436 UTC, duration 4 ms, with null function/execution identifiers and no
matching metrics boot in the inspected 09:16–09:19 window. Provider request ID:
`01a07b28-1890-765d-a6a0-1581a2fbc49f`.

The dispatcher returned HTTP 503 at 09:17:00.441 UTC after 395 ms, with
`EDGE_FUNCTION_ERROR`, execution `d02ab9c4-4c83-4b53-8b90-03786b46005f` and request
`01a07b28-170e-72f5-868e-bf9f28fe8107`. The original generic scheduler error did
not retain the upstream 502. This suggests a platform/routing failure before an
identifiable worker execution; the exact internal Supabase cause is unproven.
This release improves evidence capture, not a proven repair to metrics SQL or
Supabase internals. The earlier approved recovery audit
`4ec8a62f-c1b5-42c6-92bd-fd2d88a93736` was not repeated.

## Implemented protections

- Write-once current-run diagnostic: fixed code, worker/run identity, bounded
  HTTP status and duration; no response bodies, headers or customer information.
- Dispatcher request correlation and 4 KiB bounded worker response reads.
- Password-proven Owner/Operations Admin Data Health read model; missing or stale
  information is not converted into a healthy state or fabricated zero.
- Independent notification cron, dedicated secret and private outbox. One failure
  and one stable recovery per incident; no repeated reminders or worker restarts.
- Frozen envelopes, per-job Resend idempotency, two-minute leases, strict send
  ordering and bounded retry handling. Accepted is distinct from delivered.

The recovery policy includes a one-hour recent-worker-issue lookback plus at
least two minutes of clear health and a post-incident completed cycle. See
`PROCESSING_SCHEDULER_RUNBOOK.md` for operation, alert delivery limits and rollback.

## Validation

- Frontend: 700 tests across 49 files passed; focused processing-health suite:
  16 tests. TypeScript and production build passed, with the existing chunk-size
  warning.
- Backend: 147 tests passed, including 11 alert tests. Deno lint checked 58 files;
  new alert formatting and type checks passed.
- Rollback-only database checks: 49 diagnostics/access assertions and 30 alert
  assertions passed. Failure/recovery, lease, retry, ordering, immutable envelope
  and authorization cases did not leave synthetic production facts behind.
- Anonymous alert request: 401. A caller-selected recipient payload: 400.
  Authenticated empty request while disabled: 200, no jobs or sends.
- No production failure was intentionally induced. Earlier synthetic desktop/
  390 px UI checks and current unit tests are not authenticated production UI
  acceptance. The production Admin browser check reached sign-in, so the new
  authenticated panel still needs the user's visual acceptance.

## Production database and functions

Applied at 15:29:51 UTC:

| Migration                                          | Applied transaction-body SHA-256                                   |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `20260907160000_processing_reliability_visibility` | `ae8adeee124c9bd6b12ef8b9d374d0b5d68f473bac5f0a507414313dcb9b491b` |
| `20260907170000_processing_alerts`                 | `3f0a049d63b683d4240c56c0c188efe5c109ece09a0c2c781ae25a4c437fe3f6` |

Migration inventory increased from 44 to 46. The original stage start, finish,
tick and scheduler-health definitions remained unchanged. Alerts were disabled
during schema/function installation.

- `processing-dispatch`: ACTIVE, version 4,
  `bec60a23-cd3c-407d-a2e5-805e13bd068c`.
- `processing-alerts`: ACTIVE, version 1,
  `6fb95cc9-afa3-4b81-b448-641fad251dc9`.

The deployment command exited with a local error after Supabase accepted the
functions. It was not blindly retried: both hosted source bodies were downloaded
and compared byte-for-byte with the intended local entrypoints. Existing shared
dispatcher dependencies were compared before deployment. Dedicated Edge/Vault
alert credential digests matched; prior secrets were preserved. No plaintext
secret was persisted locally or included in this report.

Enabled at 15:33:53 UTC: only the new `kma-processing-alerts` minute job was added.
Existing jobs `kma-agreement-maintenance` and `kma-processing-chain` retained their
IDs, commands, schedules and active state.

## Dashboard release

Current release:
`/srv/kissmyapps/releases/20260907T153008Z-processing-alerts-5cccaca551ee`

Previous, retained for rollback:
`/srv/kissmyapps/releases/20260907T131413Z-partner-billing-c6854b31bcb9`

- Manifest SHA-256:
  `5cccaca551ee8677ddc36688a7b2d225325f3449a788d73f9ce611ea1860c900`.
- Index SHA-256:
  `000f7419960c0fd7a855ba17188f6591f6b8f91d018e2cf8dda154e9babb66cb`.
- Archive SHA-256:
  `b161a4a781221c4e5a49f30e4d0e65cf15117f0beaf34c5261f6e0463a88224b`.
- All 51 manifested files were fetched from both `partners.kissmyapps.dev` and
  `admin.kissmyapps.dev` and matched the candidate hashes.
- Only the dashboard container was recreated; it reported healthy. Other
  container identities, Compose and Caddy configurations remained unchanged.
- Existing public developer documentation was preserved byte-for-byte. Unrelated
  local future-app-access documentation was not silently published by this
  release. Synthetic UI fixtures were not included in the build.

Server evidence directory:
`/srv/kissmyapps/release-evidence/20260907T153008Z-processing-alerts-5cccaca551ee/`.

## Setup email and final live health

One setup test was queued, with no simulated processing incident:

- Outbox job: `0865c137-381a-4907-ae03-570867d5690e`.
- Subject: `[KissMyApps] Processing alerts: setup test`.
- Recipient: `onorhimevictory2017@gmail.com`.
- Resend receipt: `d0538c6f-5203-480e-bf6f-e13b1a271c89`.
- Accepted at 15:35:01.514707 UTC, attempts 1, last error null.

The Resend browser was signed out, so provider delivery/bounce status and inbox
arrival are unverified. Do not equate API acceptance with inbox delivery or send
another test merely because receipt is uncertain.

Live read-only check at 15:37:13 UTC confirmed:

- Processing enabled, no attention required, heartbeat 15:37:00 and latest full
  cycle 15:36:00. Post-deployment Stripe, commercial and metrics stages each
  completed with HTTP 200 and succeeded outcomes.
- Each queue had zero pending, processing, terminally failed and expired leases.
- Alert cron enabled; its latest observation was 15:37:00.367104 UTC.
- Financial fingerprints matched the pre-release snapshot: attempts
  `14c730b2945bc901ae17f6b770188ee9`, events
  `ba13b95436d518fc93f30123011a3950`, subscriptions
  `05c23091be9c11c4da810bcda01b9a1b`, transactions and commissions
  `d41d8cd98f00b204e9800998ecf8427e`.

## Remaining acceptance and next scope

Confirm the labelled setup email in the recipient inbox and inspect the live
Admin → Data Health panel after signing in. External platform-outage monitoring,
retention ownership and paid financial/payout acceptance remain separate gates.
The next planned product feature is Admin Subscriptions; it was not implemented
or enabled by this operational reliability release.
