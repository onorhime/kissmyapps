# Admin Payouts — internal review workflow

Status: implemented and validated locally; **not deployed**. No actual payout,
destination, reconciliation, period, role, subscription, or charge was created or
changed in production. Candidate database tests ran in one transaction that was
rolled back. This is not evidence of a live paid-payout lifecycle.

## Delivered scope

- Protected `#admin/payouts` route with desktop/mobile navigation and host isolation.
- Password-authenticated Owner/Finance mutation access; Owner/Finance/Operations/
  Analyst read access. Support and recovery-only sessions are rejected server-side.
- Period selection, literal partner/product/statement search, status filters and
  bounded pagination, with explicit loading, unavailable, and empty states.
- 14-day UTC period creation, review, closure and ledger-backed statement preparation.
- Statement detail: signed ledger amounts, frozen agreement versions/minimums/
  cadence, destination labels and reconciliation state. Internal notes and provider
  references are not exposed. The detail is not a downloadable payment receipt.
- Review, hold, eligible resume, internal approval, and below-minimum signed
  carry-forward. All changes require an audit reason and server-side authority.
- Confirmation dialogs, top-right success notices, persistent action errors,
  disabled duplicate submissions, and refreshes that keep existing rows mounted.
- Server-owned calculations: no amount, destination, paid-state or transfer fields
  are accepted from the browser. Approval freezes the existing verified destination.
- Explicit **approved is not paid** messaging throughout. No send-money, schedule,
  release-transfer, or mark-paid action exists in this contract.

## Database and retry safety

Candidate: `supabase/migrations/20260907190000_admin_payout_workflow.sql`.

New browser RPCs:

1. `get_admin_payout_workspace(uuid,text,text,integer,integer)`
2. `get_admin_payout_statement(uuid)`
3. `perform_admin_payout_action(jsonb)`

The action wrapper serializes human operations, rechecks authority after waiting,
checks the expected row timestamp, locks affected rows, and retains the exact
request and response under a private request UUID. A retry with the same actor and
same payload returns the original result; a changed payload is rejected. The UI
locks a submitted payload for retry when the response is uncertain.

Direct authenticated execution of the three legacy period/preparation writers is
revoked, so browser writes must use the wrapper. Existing foundation triggers,
private tables, financial history and reconciliation evidence stay protected.

Approval requires a closed period, matching ledger/snapshots, an active partner,
current healthy processing, sufficient positive balance, exact-window and exact-
currency passed Stripe reconciliation with no unexplained difference/exceptions,
and a verified eligible destination whose security hold is complete. Approved
holds can resume only with the original destination and current readiness.

Preparation corrects eligible revenue to count each referenced transaction once,
matching the foundation's finalization invariant; several entries referencing the
same transaction must not multiply its eligible revenue. No monetary input is
accepted from an operator. Synthetic adjustment fixtures do not constitute a
paid-commission test of this aggregation.

## Deliberate limitations / remaining work

- Only **14-day agreement cadences** can finalize through this version. Other
  cadences display a blocker pending a settlement policy; they are not silently
  paid on the wrong schedule.
- Carry-forward supports a single frozen agreement per statement, preserving the
  entire positive or negative balance in one immutable entry. Mixed-agreement
  balances are blocked until an allocation policy is designed and tested.
- At most 200 recent periods are selectable; workspace pages contain at most 100
  statements (UI uses 25). Statement detail shows the first 500 ledger entries and
  explicitly reports truncation. Older/full-ledger investigation remains operational.
- No payment-destination onboarding/verification integration is provided here.
  Partner reauthentication, email confirmation, masked destination entry, provider
  verification and the 48-hour hold require their own end-to-end implementation.
  Do not seed a fake verified destination to bypass this requirement.
- No statement PDF generation, document delivery, payout notification, provider
  transfer, or transfer reconciliation is included. No manual mark-paid shortcut.
- Existing passed reconciliation windows are immutable and unique. Late evidence
  can make a statement fail freshness checks; this requires investigation and a
  separately reviewed reconciliation policy, not clearing or replacing evidence.
- A $0 checkout is not proof of positive revenue, paid commission, paid renewal,
  refund reversal, or successful payout. Real paid acceptance remains outstanding.
- Authenticated production Admin visual acceptance, physical devices, screen-reader
  use and full manual keyboard/zoom acceptance remain separate gates.
- Other retained work: Admin Documents and scoped View as Partner; app entitlement
  when the product app exists; Singular/Amplitude; full-outage monitoring.

## Validation evidence

September 7, 2026:

- 73 rollback-only database assertions passed. Covers actual authenticated wrapper
  execution, role/recovery/anonymous restrictions, stale versions, forbidden money
  actions and fields, idempotent preparation/approval/carry, arithmetic snapshots,
  missing evidence, revoked destinations, holds/resume, negative and positive carry,
  unsupported cadence, and processing-health blockers.
- Database tests contain clearly synthetic adjustment, destination and reconciliation
  fixtures. The healthy/unhealthy scheduler cases override **only the new candidate
  helper** inside that rollback transaction; no existing scheduler/cron is changed.
- Before/after fingerprints matched for subscriptions, provider events, checkout
  attempts, transactions, commission entries, payouts, periods, destinations,
  destination events, snapshots, reconciliation runs, products, agreements, admin
  users and audit logs. Migration count remained 47; the candidate RPC remained absent.
- 786 Vitest tests passed across 58 files, including new payout mapper/gateway/UI,
  navigation and host separation checks. The suite emits the existing jsdom canvas
  warning; no test failed in the final full run.
- 9 Node operational guard/webhook registration tests passed separately.
- After the final response-validation hardening, 125 focused gateway, payout,
  navigation and host-isolation tests passed again; TypeScript, lint and the
  production build were rerun successfully.
- TypeScript build, focused lint and whitespace checks passed. Production build
  passed; the existing large dashboard-chunk warning remains.
- Browser verified local synthetic desktop workspace and statement/action dialogs,
  audit reason, success toast, focus restoration, and mobile period form. At 390px,
  page scroll width was 390px; modal client/scroll width was 358px. The modal scrolls
  vertically to its controls without horizontal overflow. Viewport restored afterward.
- Automated axe structure checks passed; jsdom color-contrast was disabled and is
  not represented as a full accessibility certification. Browser visuals were inspected.

Repeat candidate checks (never deployment commands):

```sh
node scripts/check-admin-payouts.mjs
./node_modules/.bin/tsc -b
./node_modules/.bin/vitest run src integrations deploy --maxWorkers=1
node --experimental-vm-modules --test scripts/processing-release-guards.test.mjs scripts/register-stripe-webhook.test.mjs
./node_modules/.bin/vite build
```

The local visual fixture is `/integrations/admin-payouts-ui-check/` on port 3011.
It uses synthetic browser-memory responses and is not a production build entrypoint.

## Deployment handoff — approval required

1. Recheck production migration inventory (47 at validation), candidate absence,
   role/financial fingerprints, current Hostinger release, and scheduler health.
2. With explicit approval, apply only this candidate migration; do not bulk-push
   the dirty worktree's migrations or replay older releases.
3. Publish the dashboard using the existing immutable Hostinger release procedure,
   preserving public developer documentation and all unrelated application assets.
4. Verify exact deployed hashes on Admin and Partner, new role-scoped RPC access,
   protected route behavior and a truthful empty payout workspace.
5. Let the authorized operator choose the real UTC period dates. Do not create
   synthetic earnings, destinations, reconciliation passes or payouts in production.
6. Keep transfers disabled. Proceed separately to destination/provider integration,
   approved paid billing acceptance, and controlled payout release verification.

The earlier Admin Subscriptions deployment is unchanged. Its final signed-in Admin
visual check is still open; this local payout preview does not close that gate.
