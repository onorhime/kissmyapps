# Creator settlements — local implementation and acceptance

Date: 14 October 2026. No deployment, hosted database migration, provider configuration, real Stripe transfer, payout or email was performed.

## Current implementation — 15 October 2026

The six integration gaps identified below are corrected in local source. Existing KMA admin and creator dashboards are reused; the local standalone page is only a fixture harness.

- Existing signed agreements and purchase rules are the commercial authority. External settlement now binds to their IDs, versions, document and fingerprint, instead of another pricing form. Existing signed v1 hashes stay unchanged; new policy requires a new signed revision.
- The agreement's attribution window, minimum payout and cadence are consumed. Validation waiting time is separate. Each agreement minimum is respected when older and newer agreement revisions share a batch; approved older batches remain valid across later payout periods.
- The existing rule editor includes basis choice and optional ordinary-refund cutoff. Blank preserves unlimited ordinary-refund adjustments. Refund occurrence time determines inclusion at the exact elapsed-day boundary. Late delivery does not move the deadline. Legacy subscription processing also freezes and enforces its signed cutoff without replacing its existing balance-impact method.
- New signed v2 external awards support cumulative proportional partial refunds, deduplicated individual refunds and incremental recovery after transfer. Complete won/lost dispute evidence has explicit handling separate from ordinary refunds. Conflicts and historical negative-evidence holds remain for review.
- Approved receiving-merchant/funding-platform mappings support KMA-funded payouts for a separate merchant. KMA must be funded independently; no automatic cross-account movement or currency conversion is implied.
- Country/currency eligibility uses current provider evidence and approved routes, plus account capability and settlement-currency checks. Manual batch review/approval remains mandatory.
- Merchant refund/dispute webhooks and funding-platform transfer/bank events are separated. Early merchant events are immutable and scoped; account/creator/currency/test-live isolation and replay protections remain enforced.
- Read-only provider preflight no longer consumes the 23-hour mutation window. A lease-scoped database marker is persisted immediately before a possible POST; genuine uncertain attempts retain their original timestamp and GET-only recovery limit.

Administrator and creator views expose frozen terms, refund policy and payout schedule separately from validation holds. Missing charge/fee references retry; incompatible fee currency is explicitly held. Unmatched manual provider reversals freeze further settlement until verified reconciliation.

No hosted migrations, deployment, provider configuration, real email, charge, transfer or bank payout were performed. Test policy values remain synthetic, not production defaults. See [operations and policy details](CREATOR_CONNECT_LOCAL.md).

### Current acceptance evidence

| Check | Current evidence |
| --- | --- |
| Complete application tests | 859 tests in 65 files passed; `/tmp/kma-canonical-final-tests-20261015.log` |
| Node operational tests | 11 passed; same log |
| Production build / lint | Passed; `/tmp/kma-canonical-final-build-20261015.log` and `/tmp/kma-canonical-final-lint-20261015.log`. Existing bundle-size warning remains. |
| Final browser-fix regressions | 24 settlement tests, TypeScript and lint passed after funding-selector identity and approval-summary fixes. Full formatting, funnel contract check and production build passed afterward. |
| Complete edge gate | Formatting, lint, TypeScript and 204 tests passed; `/tmp/kma-canonical-final-edge-20261015.log` |
| Native database replay | 56 migrations, 43 suites passed, 0 failed, 3 explicit operator-only skips; `/tmp/kma-all-sql-db.ibi5rO/result.json` |
| Actual RPC + fake Stripe | 15 scenarios passed; `/tmp/kma-all-sql-db.ibi5rO/edge-sql-evidence.log`. Includes aged preflight recovery, genuine expired ambiguous POST recovery, webhook replay, early refunds and exactly-once transfer/reversal. |

The three skipped database suites are 28 (existing named BC Learn agreement/member), 31 (production traffic/cache) and 33 (production billing/cache). They require real existing operator data and were not replaced with invented success. Local provider transport cannot contact Stripe. Actual sandbox/onboarding/funding/webhook and bank-delivery acceptance remain separate.

Browser acceptance uses `http://127.0.0.1:5189/funnel-metrics-local.html` and the fresh `ibi5rO` database. The earlier `crOL6D` fixture remains untouched. The current browser saved and separately approved a synthetic future mapping to `acct_browserplatform` for 1 December 2026, using the existing signed fixture policy. These values are not production settings. Browser checks verified full signed-policy approval details, separate funding identities, unchanged prior balances, creator isolation, and admin/creator 390px layouts without document overflow. The future mapping remains provider-disabled. Screenshots: [approved local mapping](evidence/canonical-settlements-2026-10-15/admin-approved.png), [review details](evidence/canonical-settlements-2026-10-15/funding-review.png), [admin mobile](evidence/canonical-settlements-2026-10-15/admin-mobile.png), [creator mobile](evidence/canonical-settlements-2026-10-15/creator-mobile.png), [unrelated creator](evidence/canonical-settlements-2026-10-15/unrelated-creator.png).

## Historical implementation — 14 October

- Separate external purchase commission ledger with versioned approved terms, prospective effective dates, verified post-discount/tax/shipping-exclusive basis, immutable scope and audit history.
- Creator/product/funnel/currency/test-live isolation. Demo or paused commercial scope cannot become payable. Missing terms or tax evidence stays held; no guessed rate or zero tax.
- Explicit prepare/review/approve/hold/cancel batch flow, full frozen line items, revision checks, audit reasons and idempotent request retry.
- Authenticated creator Connect onboarding, server-owned exact callback URLs/country scope, stable account creation identity, fresh capabilities and requirements.
- Approved transfers, stable provider identities, worker leases, bounded retry backoff, read-only reconciliation after ambiguous results and the 23-hour mutation cutoff. Failed bank payouts remain distinct from successful Stripe transfers.
- Full-refund reversals and recovery, debt protected from being hidden by new earnings, durable provider events before order ingestion and monotonic refund evidence. Partial refunds and unresolved disputes are held for finance review.
- Admin and creator screens show commission states, transfer batches, account-wide bank payouts, recorded balances and recovery/review holds. Admins can inspect provider failures and request a receipt check without authorizing another payment.
- Local opt-in worker supervisor; real provider bindings and money movement disabled by default.

The legacy subscription money system is untouched by the new settlement path. Funnel metric counts remain nonfinancial evidence.

## Historical evidence — 14 October

| Check | Result / evidence |
| --- | --- |
| Complete application tests | 838 tests in 63 files passed; `/tmp/kma-creator-settlements-all-tests.log` |
| Node operational tests | 11 passed, including the local creator-worker supervisor; same log |
| Production build | Passed; `/tmp/kma-creator-settlements-build.log`. Existing bundle-size warning remains. |
| Typecheck / lint | Passed locally; `/tmp/kma-creator-settlements-lint.log` |
| Native database | 53 migrations, 39 suites passed, 0 failed, 3 operator-only skipped; `/tmp/kma-all-sql-db.crOL6D/final-result.json` |
| External merchant basis contract | 9 tests passed with provider network unavailable; `/tmp/kma-external-basis-tests.log` |
| Creator provider handlers | 24 edge tests passed (7 Connect, 10 worker, 7 webhook); 2 supervisor tests passed. |
| Native edge + SQL + fake Stripe | 14 scenarios passed using actual RPCs and no provider network; `/tmp/kma-all-sql-db.crOL6D/edge-sql-evidence.log`. |
| Browser acceptance | Chrome: saved and separately approved synthetic future terms, confirmed frozen batch amount, creator isolation, failed bank payout and recovered balance; 390px mobile document has no horizontal overflow. Screenshots: `/tmp/kma-settlement-browser-evidence/`. |

The last display refinement distinguishes missing purchase basis from a verified zero commission; all 16 settlement tests, typecheck/build and lint passed again (`/tmp/kma-creator-final-targeted.log`). Browser terms were synthetic 20%, 14-day hold, 30-day window, effective 1 December 2026; they are not owner-approved production terms. Earlier recorded balances stayed unchanged.

The first attempted full database run exhausted local disk and is not counted as a valid code result. Regenerated files from stopped disposable test databases were removed while retaining their logs/results. The successful replay above supersedes that environmental failure.

## Integration audit and owner correction — 15 October 2026

This audit supersedes any implication that the external payout implementation is ready for production or that the owner must hardcode a second set of commercial terms. The 20% / 30-day / 14-day values remain isolated test examples only.

Confirmed product direction:
- Extend the existing KissMyApps admin and creator dashboards. The local standalone page is a disposable test harness, not another production dashboard.
- Configure commissions, attribution and payout policy through KMA's existing per-product partner agreements and commission rules. Do not ask administrators to maintain independent external-purchase policy values in Payouts.
- Keep Stripe Connect and manual payout approval. Use the existing KMA Stripe platform as the intended funding account, subject to completing its provider setup and correctly implementing separate merchant/funding reconciliation.
- Support all countries and currencies eligible for that actual Stripe platform and integration. This is not a worldwide unchecked allowlist or permission to enable unsupported provider routes.
- Make the ordinary-refund commission cutoff an explicit configurable policy. The owner expects refunds after that cutoff not to reduce creator commission; chargebacks/disputes must retain separate explicit treatment.

The audit initially found these integration defects (corrected by the 15 October implementation recorded above):
1. The new independent `external_commission_terms` form and table duplicate KMA's existing `agreements` / `commission_rules`. The external processor has no agreement/rule link and does not enforce the existing signed-agreement selection. Bind to the canonical configuration and keep immutable evidence snapshots rather than a second commercial setup.
2. Existing agreement minimum payouts and payout cadence are not consumed by the external batch preparation flow. The legacy payout review supports 14-day cadence and blocks other cadences pending policy; the newer positive-balance batch path must not bypass these settings.
3. Existing legacy eligible revenue deducts provider fees and tax, while the new external basis excludes tax/shipping but not provider fees. Resolve this through one explicit canonical basis policy; do not silently change existing contracts.
4. `validation_window_hours` is stored, displayed and snapshotted but is not enforced as a refund cutoff by the current legacy commission processor. Legacy refunds recalculate commission regardless of age; the new external full-refund recovery also has no age cutoff. A cutoff is not already implemented. Payout hold, payout frequency and refund cutoff are distinct concepts.
5. New settlement schema currently requires merchant account to equal funding account. That does not yet implement the owner's intended KMA-funded payout for purchases received by a separate SpeakSix Stripe account. Preserve merchant verification, add reviewed funding mapping/accounting, and never fabricate a cross-account Stripe transfer.
6. Country availability in the local handler is still a configured allowlist; no complete provider/account-derived country/currency eligibility resolver has been implemented.

Current authenticated Stripe observation (read-only, 15 October 2026):
- Existing account: Futura Funds Inc., `acct_1SaSp9E47mNwFlz1`.
- Current `/settings/connect/platform-setup` summary says connected accounts collect payments directly from buyers (direct charges), Stripe bears negative-balance losses, seller accounts pay processing fees, and dashboard type is none.
- `/settings/connect/onboarding-options/countries` says the platform profile must be completed to use Connect with live accounts. The Express-specific country controls are disabled; Canada is the sole selected country. This is not evidence that every payout method or currency is available.
- No acknowledgement, Connect setting, key, transfer or payout was changed. This browser read verifies provider account identity/setup only, not the deployed server key binding. Account observations were read directly from the authenticated accessibility tree; the native screenshot was unreadable and was not retained as evidence.

Source pointers: `AgreementSection.tsx` (attribution, payout frequency/currency/minimum, revenue share and validation fields); `20260828190000_commercial_metrics_reconciliation.sql` (signed agreement/rule selection and refund recalculation); `20260907190000_admin_payout_workflow.sql` (minimum/cadence); `20261014120000_external_commission_settlement.sql` (independent terms and same-account restriction). Admin/creator additions are mounted in existing `PayoutsPage.tsx` and `LivePartnerPortal.tsx`.

This section preserves the pre-fix audit. The implementation and current acceptance at the top supersede these outstanding-code findings. Neither historical nor current local tests prove live payout readiness.

## Historical decisions and limits before the corrections

On 15 October 2026, the owner selected percentage-based commissions and Stripe Connect only, with explicit admin batch approval. These choices match the implemented flow and do not authorize provider activation, deployment or money movement. KMA remains configurable across products; the owner selection is the SpeakSix approach.

The owner subsequently authorized our recommendations for this local test: 20% commission, a 30-day first verified click window, a 14-day hold and a post-discount basis excluding tax/shipping. The hold starts from the later of provider purchase time and verified receipt time. USD is the existing synthetic fixture currency, not a production currency selection. These values match the browser acceptance terms above; that future-effective fixture and historical recorded earnings have not been rewritten. The owner's later correction requires production values to come from the existing KMA agreement/rule UI. Existing payout minimum and cadence settings must be reused rather than reselected in chat.

The owner chose the existing KMA Stripe platform for creator funding. Its identity and Connect setup have now been inspected in the signed-in dashboard as recorded above; the deployed server binding and funding arrangements remain unverified. The local same-merchant restriction must be refactored to support that chosen model without pretending funds move automatically from SpeakSix's separate Stripe balance. No real account, provider setting or payout has been changed.

Full refunds have an automatic recovery path. Partial-refund correction, release after a won dispute and arbitrary admin amount adjustments are not implemented. These exceptions remain visible and block settlement pending a defined policy and reviewed resolution workflow. A transfer with no recoverable provider receipt after its safe retry window remains unresolved; the system never guesses success or creates another payment identity.

Real Stripe sandbox onboarding/funding/transfers/reversals/webhooks/bank status, hosted authentication, email delivery and production scheduling are separate acceptance steps. No local test represents real bank delivery.

## Reproduction and remaining provider acceptance

The retained local test UI is `http://127.0.0.1:5189/funnel-metrics-local.html`. Choose “Creator commissions and payouts” and switch fixture identity to Administrator, Attributed creator or Unrelated creator. It uses real local PostgreSQL RPCs and synthetic identities; hosted services and real payouts are disabled.

See [Creator Connect operations](CREATOR_CONNECT_LOCAL.md), [external merchant contract](../integrations/funnel/EXTERNAL_COMMERCE.md) and the sibling SpeakSix `docs/marathon-worker.md`. The current launch checklist is SpeakSix `docs/marathon-release-remaining-2026-10-14.md`.

The three unrun database operator suites (28, 31, 33) depend on actual existing BC Learn account/traffic/billing data. They were not replaced with artificial production success. Both repositories remain dirty with other unreleased work; prepare an explicit migration/source release manifest before any later deployment.
