# Reusable funnel measurement — local implementation

**Configurable journeys update (22 October 2026):** this document describes the custom metric-card contract and its historical releases. Product-specific stages, ordered conversion rates and paths now have their own visible, versioned configuration; the webinar journey is an optional template. See [configurable funnel journeys](configurable-funnel-journeys.md) for setup, event registration, permissions, version selection and the distinction between independent person paths and the earlier fixed exclusive-order report. Publishing configuration does not wire a product's sender or enable checkout/payouts.

This feature is independent of payouts and the canonical revenue/earnings cards. Definitions are product-funnel configuration, not product-specific code. The same six metric types support webinar, sales, subscription and custom funnels.

## Definition lifecycle

`get_admin_funnel_metrics_config(p_funnel_id)` returns product/funnel identity, a draft with `revision`, `template`, `metrics`, and immutable published `versions`. Only owner/operations may save or publish; other admins can read/preview. Saving uses `save_admin_funnel_metrics_draft(p_input)` with `{funnel_id,expected_revision,template,metrics}`; stale revisions fail `40001`. Publishing uses `publish_admin_funnel_metrics(p_funnel_id,p_expected_revision)` and increments the draft revision. Each publication closes the previous effective interval and creates a new version. It does not recalculate old events under new definitions. A report may explicitly select an archived version; its labels/rules and effective interval are preserved. Late events fall into the publication interval containing their event time.

A definition is `{key,label,type,visible?,event_name?,state_value?,numerator_key?,denominator_key?}`. The ordered array is display order; `visible` defaults true. At most 24 metrics. Key/state use lowercase snake case up to 50 characters; event names up to 80; labels up to 80. No executable expression, SQL, arbitrary JSON path or financial field is accepted.

- `event_count`: number of distinct accepted occurrences in the selected dates. Event-ID retries are not new occurrences.
- `unique_people`: distinct opaque product subjects in the selected dates.
- `unique_per_context`: distinct subject/context pairs in the dates. The same person can count once in each webinar or other context.
- `current_state`: latest state by event time per subject/context, matching `state_value`, as of report end. Report start does not discard earlier still-current states within the selected published version. Ties resolve by stable external event ID, not delivery order.
- `live_presence`: latest event per subject/context/session as of report end, active and unexpired; count distinct subject/context, so multiple tabs do not inflate a context. Presence expires without requiring a leave event.
- `ratio`: `100 * numerator / denominator`, rounded to two decimals. References must name preceding non-ratio metrics. Zero denominator is unavailable. Ratios are not silently capped; comparing occurrences with people can exceed 100%.

## Signed server ingestion

`POST /functions/v1/funnel-metric-events` uses the existing HMAC header protocol and `FUNNEL_HMAC_BINDINGS` key format. The key binding supplies product/funnel; the caller cannot choose those or an affiliate in its body. The database verifies the existing non-bot click/acquisition belongs to that scope and derives the immutable affiliate/link/acquisition identity from it. Browser requests carrying an Origin header are rejected. Raw events and helper RPCs have no authenticated-browser grants.

Body (8 KiB maximum):

```json
{
  "event_id": "33333333-3333-4333-8333-333333333333",
  "event_name": "assessment_completed",
  "click_id": "opaque_tracking_click_123456",
  "subject_id": "product_scoped_account_digest_123456",
  "context_id": "webinar_123",
  "occurred_at": "2026-10-14T12:00:00Z"
}
```

Required: stable UUID `event_id`, registered `event_name`, valid `click_id`, nonpersonal opaque product-scoped `subject_id` (16–128 alphanumeric/underscore/hyphen), timezone-qualified finite `occurred_at`. Optional opaque `context_id`, `session_id` (1–128 characters), `state_value`, `presence_expires_at`. No properties, email, affiliate, revenue or earnings fields. Caller must derive `subject_id` from a stable product-local account identifier without personal information. Published definitions enforce required context/state/presence fields for their metric types.

Presence requires context, session, active/left state and explicit expiry between occurrence and 300 seconds later. Send periodic active heartbeats and a left event when available. No arrival-time extension occurs. Future timestamps beyond five minutes are rejected. Delayed events are accepted, but events preceding first publication do not invent historical metric coverage. Retrying the exact same event is idempotent; changing its evidence conflicts.

Response: `{accepted:true,event_id:<internal UUID>,duplicate:boolean,request_id:string}`. No financial mutation occurs. The only ingestion SQL RPC, `ingest_funnel_metric_event(p_product_id,p_funnel_id,p_event)`, is service-role-only and repeats validation/scope checks.

## Reports and availability

Admin: `get_admin_funnel_metrics_report(p_input)`; creator: `get_partner_funnel_metrics_report(p_input)`. Input: product/funnel UUID, date_from/date_to as inclusive `YYYY-MM-DD`, IANA `time_zone`, optional `link_id`, optional published `version`. Admin may add `affiliate_id`; a creator may not. Creator identity is derived from the signed-in active membership and requires product visibility. Unsupported filters are rejected. Range maximum is 367 inclusive calendar days. Date boundaries respect timezone/DST.

Reports return version/effective timestamps, `as_of`, freshness, definitions' values and availability. Hidden definitions are removed from the creator result after dependent ratios are calculated. A never-observed event source in that published version is `awaiting_data` with null value. A connected source with no matching events in the selected dates yields a real zero. Zero denominator is separate. Live snapshots clamp to current time; archived versions clamp to their closing instant. Production samples are never substituted for unavailable data.

The `commerce` section reads the existing independently verified external merchant ledger: purchases, refunds, gross/refunded/net minor units grouped separately by currency **and livemode**. Attribution/date/link filters match the report. Source is `external_verified_ledger`, commission status is always `held`. It never invents rates, commission earnings or payouts and never writes canonical commerce rows. An unconfigured source is `unconnected`; an enabled merchant with no transactions is available with an empty currency list. Canonical cards retain their existing accounting semantics.

## Preview and validation

`preview_admin_funnel_metrics(p_input:{funnel_id,metrics,sample_events})` evaluates at most 100 isolated sample events; it neither reads production evidence nor writes events. Samples use the same structural fields but may omit click/event IDs. Supplied sample event IDs must be unique. `validate_admin_funnel_metric_event(p_input:{funnel_id,event})` checks full packet structure and returns valid/errors. It does not claim that a sample click is real or that a provider is connected. Ingestion additionally enforces the published event configuration and real acquisition scope.

## Local verification

`node scripts/test-external-commerce-local.mjs --keep` initializes native PostgreSQL 17 on a disposable Unix socket, replays all migrations, runs commerce + metric SQL tests and publishes fixture configurations. It never connects to hosted Supabase or providers. The existing local fixture handler exposes `/functions/v1/funnel-metric-events` using injected native SQL and fake local keys. Test admin/creator IDs are in `supabase/tests/fixtures/funnel-metrics-local.sql`. A second course product proves that definitions are reusable. No Zoom attendance is fabricated; its presence and attendance sources remain awaiting data.

`deno test --config supabase/functions/deno.json --allow-env supabase/functions/funnel-metric-events/index_test.ts` covers signed scope, forged fields, browser/signature rejection, opaque identity and presence/time bounds. SQL covers replay idempotency, conflicts, unique people/context counts, out-of-order state, presence expiry, creator/product/link isolation, archived versions, true ratios, previews, verified commerce/refunds and unchanged payouts.

Deployment, production key configuration and live Zoom/provider connection are separate steps and have not been performed by these local changes.

### Broader local regression result (2026-10-14)

**Later same-day update:** the nine failures described below have now been repaired. A fresh 51-migration replay passes all 37 locally runnable suites, with zero failures and the same three operator-only skips. See [database regression repairs](database-regression-repairs-2026-10-14.md). The comparison below is retained as the original diagnostic evidence, not the current failing status.

`node scripts/test-database-native.mjs` runs every locally reproducible database suite in separate rollback transactions. It composes the original synthetic checkout fixtures for their dependent suites and supplies only a disposable native Auth/Storage/pgTAP bootstrap. It skips tests 28, 31 and 33 because they explicitly require named production BC Learn users/agreements/traffic; it never contacts production to satisfy them. `--without-funnel-metrics` repeats the historical tests without this migration.

The comparison completed with **28 passing suites, 9 pre-existing failing suites and 3 production-only skips**; the baseline was **27 passing, the identical 9 failing suites, and 4 skips** (including this feature's new suite). The only status difference was the new funnel-metrics suite passing. Historical failures are in 00/01/02/05/06/10/17/20/21: old exact schema/RPC expectations, existing seeded source keys, changed commercial/activation constraints, revoked legacy payout writers, existing attribution expectations, and an unavailable `has_policy` helper in native pgTAP. These are recorded limitations, not a claim that the whole historical suite is green.

### Final focused checks and evidence

- Native PostgreSQL focused check: **50 migrations replayed; external-commerce and funnel-metrics suites passed**. Final log: `/tmp/kma-external-commerce-db.v4zfHF/tests.log`; runner output: `/tmp/kma-funnel-metrics-final.log`.
- Deno type checking passed for `funnel-metric-events/index.ts` and `external-commerce/local-fixture.ts`.
- Combined Deno ingress tests: **12 passed, 0 failed** — four metric-ingress tests, six existing external-commerce tests and two existing funnel-ingress tests. These test handlers use injected dependencies; they do not call real providers.
- Broad candidate result: `/tmp/kma-all-sql-db.dEWCU7/result.json`, detailed log `/tmp/kma-all-sql-db.dEWCU7/tests.log`.
- Broad pre-change baseline: `/tmp/kma-all-sql-db.RQ11mq/result.json`, detailed log `/tmp/kma-all-sql-db.RQ11mq/tests.log`.

The historical suite comparison supports only this statement: **no additional historical suite failed in this isolated native comparison; the same nine suites already failed without the funnel-metrics migration**. It does not establish that those failures are harmless, that the entire application is regression-free, or that hosted production/provider behavior has been verified. The focused feature checks passed independently.

| Remaining suite                            | Observed failure in both candidate and baseline                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00_schema_contract.sql`                   | Exact product/link browser-column lists and authenticated RPC allowlist differ from the current schema. The new feature's exact seven browser RPCs and anonymous denial are checked separately in suite 39.                                 |
| `01_security_and_history.sql`              | Fixture inserts duplicate seeded source key `newsletter`.                                                                                                                                                                                   |
| `02_money_and_reconciliation.sql`          | Existing conversion fixture is rejected by the commercial eligibility guard.                                                                                                                                                                |
| `05_tracking_identity.sql`                 | Fixture inserts duplicate seeded source key `tiktok`.                                                                                                                                                                                       |
| `06_admin_commercial_configuration.sql`    | Existing assertions for rejecting non-string product/identity UUID inputs fail.                                                                                                                                                             |
| `10_commercial_metrics_reconciliation.sql` | Historical fixture calls `advance_admin_payout_period`, whose execution is denied.                                                                                                                                                          |
| `17_admin_attribution_overview.sql`        | Existing assertions for empty collections, source-filter catalog and support/nonmember/inactive-admin denial outcomes fail. These assertions remain unresolved; the baseline comparison is not a security clearance for that older feature. |
| `20_tracking_only_demo_mode.sql`           | Historical active-membership fixture lacks a valid activation timestamp and violates `affiliate_users_activation_state_valid`.                                                                                                              |
| `21_agreement_signing.sql`                 | Installed native pgTAP lacks the requested `has_policy(unknown,unknown,unknown)` helper.                                                                                                                                                    |

Three older operator suites were deliberately not run: `28_partner_readiness_access.sql`, `31_partner_traffic_metric_availability.sql` and `33_partner_billing_metric_availability.sql` require specific production BC Learn identities, agreements or cached traffic/billing rows. The baseline additionally skips new suite 39 because its migration is absent.

All of this verification is **local only**. Native test clusters use disposable local sockets, synthetic fixture identities and HTTP-rejecting stubs; no hosted database, Zoom connection, external provider, production key, canonical earnings or payout operation was changed. The kept browser fixture is separate and is never touched by the broad runner. Deployment and live integration acceptance remain separate.

### 2026-10-15: generic dimensions and signed order eligibility

The existing event envelope now optionally accepts `channel`, `entry_variant`, `webinar_id` and `intake_id` (opaque strings), alongside `context_id`. Reports accept these filters in both the admin and creator surfaces. Connected sources with no matching evidence report zero; missing sources remain unavailable. Ratios compare counts inside the selected period, not acquisition-cohort conversion rates. Dimension-filtered sales require matching verified order context.

Optional first-purchase-only and verified-fulfilment requirements belong to new signed canonical commission-rule versions. They are not metric configuration and are off for existing agreements. The separate signed `/functions/v1/funnel-order-eligibility` endpoint records immutable order identity/service evidence without changing commission percentage, attribution, refund cutoff, payout cadence or manual batch approval. Full contract, implementation boundaries, and local evidence: [workflow tracking and eligibility](workflow-tracking-eligibility-local-2026-10-15.md).

### 2026-10-22: historical fixture isolation completed

The earlier three operator-only skips have been removed from the normal local runner. Tests 28, 31 and 33 now use guarded synthetic launch/reporting fixtures and retain their access, completeness, queue freshness and currency assertions. Fresh local replay: **68 migrations; 58 passing suites; zero failures and zero skips**, at `/tmp/kma-all-sql-db.DBbn83/result.json`. The old traffic/billing check scripts now invoke the local runner and never query or temporarily mutate hosted Supabase. Historical results above remain historical; hosted/provider acceptance is still a separate check.
