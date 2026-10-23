# Database regression repairs — 14 October 2026

All nine previously failing database suites are repaired locally. No hosted migration, deployment, provider operation or payment was performed.

## Result

Fresh native PostgreSQL replay: **51 migrations, 37 passing suites, zero failing suites, three operator-only checks skipped**. Final evidence: `/tmp/kma-all-sql-db.vynCJG/result.json` and `tests.log`; runner output: `/tmp/kma-database-repairs-final.log`. The preceding independent combined run also passed at `/tmp/kma-all-sql-db.6NAfJU/result.json`.

These are application database tests using an isolated Unix socket and synthetic identities. The native HTTP stub rejects provider access. This result does not establish real Stripe, email, Zoom or production-host acceptance.

## What was fixed

| Suite | Cause and repair |
| --- | --- |
| 00 — Schema contract | Browser views and the exact RPC allowlist predated newer features. Reviewed the added grants against their migrations and updated the explicit allowlist. Added checks that retired payout writers and metric ingestion remain inaccessible to browser roles. |
| 01 — Security/history | Fixture collided with seeded source keys; used incomplete JWT identity changes, an obsolete tracking origin and nonportable storage fixture identifiers. Corrected the fixtures while retaining row isolation and history assertions. |
| 02 — Money/reconciliation | Old synthetic server events omitted the newer trust/commercial-eligibility fields, and JWT role switching was incomplete. Marked only trusted financial fixtures eligible and added proof that browser events cannot create payable conversions. |
| 05 — Tracking identity | Fixture reused a seeded source key and expected older guard messages/origins. Updated the synthetic source, canonical tracking origin and current rejection messages; identity checks remain. |
| 06 — Commercial configuration | Some expected error messages had changed. Expanded tests also found a real regression: a later agreement RPC replacement had dropped blank-ID, model and currency validation. The new migration restores those checks and gives controlled invalid-input errors before business lookups or casts. Main-link input shape/type errors are separated. |
| 10 — Commercial metrics | Tests directly called legacy payout writers whose browser execution was intentionally revoked. They now use the current versioned, idempotent admin payout action. Tests prove legacy calls remain denied and unhealthy processing blocks review, then isolate the readiness dependency to exercise real reconciliation/ledger behavior. No money is sent. |
| 17 — Admin attribution | Role tests changed one JWT setting while the full claims still identified the owner. They now set both and verify the effective identity before each denial test. Catalog assertions account for migration-seeded public sources and retain the exact public-field allowlist. No runtime authorization change was required. |
| 20 — Tracking-only mode | Old fixtures lacked completed activation, read private tables through restricted roles, and tried to rewrite append-only timestamps. Use completed activation and correctly dated inserts, preserve service API tests, and explicitly assert raw-read denial and timestamp immutability. |
| 21 — Agreement signing | Installed native pgTAP does not provide the requested `has_policy` helper. Query `pg_policies` explicitly and strengthen privilege checks. Existing transaction/constraint repairs were preserved. |

## Runtime change

`supabase/migrations/20261014110000_database_validation_repairs.sql` replaces only `create_admin_agreement(jsonb)` and `issue_admin_main_link(jsonb)`.

The change retains password-authenticated admin checks, the empty SECURITY DEFINER search path, existing grants/revokes, version locks, enriched agreement response, main-link idempotency, signed-agreement eligibility and tracking-only approval checks. An independent comparison against the immediately preceding function definitions found no unrelated behavior changes.

The migration has only been applied to disposable local databases. It still needs inclusion in a separately approved, reviewed release.

## Three deliberately unrun operator checks

These are not failing test cases and were not weakened or populated with invented production facts:

- `28_partner_readiness_access.sql`: existing named BC Learn agreement/member and actual authenticated directory access.
- `31_partner_traffic_metric_availability.sql`: existing named BC Learn traffic/cache rows.
- `33_partner_billing_metric_availability.sql`: existing named BC Learn billing/cache and provider receipts.

Their assumptions and exact target records must be reviewed against the actual environment before a future bounded operator run. This turn did not access production to satisfy them. They remain separate from the local regression result and real-provider acceptance.

## Reproduce

```sh
node scripts/test-database-native.mjs
```

The runner creates and stops its own disposable PostgreSQL cluster, replays all migrations, runs each suite in a rollback transaction and writes `result.json` plus a test log. It does not use linked Supabase credentials. Existing browser acceptance fixtures are preserved.

This result is the historical checkpoint before the subsequent local worker and settlement implementation. That later implementation is covered by `docs/CREATOR_CONNECT_LOCAL.md` and the sibling SpeakSix `docs/marathon-worker.md`; it does not change the evidence recorded above. The current launch checklist is the sibling SpeakSix `docs/marathon-release-remaining-2026-10-14.md`. Isolated tests are not real-provider or production acceptance.

## Follow-up — 22 October 2026

The three historical operator checks above have now been converted to local, fixture-independent regressions. A fresh PostgreSQL run applied **68 migrations and passed all 58 suites, with zero failures and zero skips**. Evidence: `/tmp/kma-all-sql-db.DBbn83/result.json` and `tests.log`. Suite 31 ran 57 assertions; suite 33 ran 121. Suite 28 retains authenticated readiness, complete directory projections and access-denial checks.

The fixtures create synthetic owners, creators, signed agreements and issued links using the real authorization/activation RPCs. Reporting-cache inputs model complete traffic, a zero-revenue subscription snapshot, and verified or unavailable billing evidence; actual zero-total payment normalization remains covered separately by suite 26. All fixtures require the disposable-harness marker and roll back. No historical production account, contact email or cache row is needed.

The old `check-partner-traffic-reporting.mjs` and `check-partner-billing-reporting.mjs` entry points now run this local harness instead of temporarily changing hosted function/cache state. This replaces their execution path, not the historical evidence above. Passing these regressions does not prove hosted migration state, queue health, provider connectivity or rollout readiness. No deployment or hosted mutation was performed.

Both compatibility entry points were also executed independently after the change: traffic `/tmp/kma-all-sql-db.ipDfSq/result.json` and billing `/tmp/kma-all-sql-db.UP2uCV/result.json` each report 68 migrations, 58 passes, zero failures and zero skips. Both reject `--deploy` before starting the harness. All three test clusters stopped automatically.
