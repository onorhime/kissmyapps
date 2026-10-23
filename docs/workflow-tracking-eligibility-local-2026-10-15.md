# Workflow tracking and signed commission eligibility — local implementation

Date: 2026-10-15. No hosted migration, deployment, provider-account change, real email or money movement was performed for this work.

## What already existed

KissMyApps already had generic custom funnel metrics, immutable published metric versions, six counting methods, server-signed event ingestion, creator-scoped reports, and the canonical commission/attribution/refund/payout settings. The external commerce ledger and Stripe Connect payout flow already used those settings and required manual batch approval. This release extends those paths; it does not create a SpeakSix dashboard or another commission engine.

## Added now

- Optional opaque `channel`, `entry_variant`, `webinar_id`, and `intake_id` dimensions on existing metric events, alongside `context_id`.
- Admin recorded-performance reporting and creator filters for those five dimensions. A connected source with no matching events shows zero; an unconnected/unobserved event source remains unavailable. Ratios are comparisons of event counts inside the reporting period, not acquisition-cohort conversion rates.
- Dimension-filtered external sales use verified immutable order context. Historical orders without context are excluded from those filters, rather than inferred from a shared click. They still appear in unfiltered sales.
- Two optional settings in the existing commission-rule editor: first verified product purchase only; verified service fulfilment required. Both are off by default and require a newly signed version-3 agreement before applying. Existing version-1/version-2 agreement snapshots and behavior remain intact.
- Fulfilment-required rules start the existing validation hold from verified fulfilment. Refund eligibility still uses the existing purchase-based refund cutoff. Payout cadence, minimum balance, Connect identity/currency support, and manual approval remain the canonical existing settings.
- A held first purchase can become payable only after all required evidence and the existing validation window pass. Later purchases cannot qualify for a first-purchase-only rule. Verified service cancellation holds any not-yet-transferred award/batch; it does not silently create a refund, transfer, or reversal.

## Generic eligibility API

`POST /functions/v1/funnel-order-eligibility` uses the existing `EXTERNAL_COMMERCE_HMAC_BINDINGS` key binding and the same request signing protocol as the funnel metrics/commerce APIs. Never expose signing secrets to the browser.

```json
{
  "event_id": "e49b51ca-87b1-4d88-8a57-9437d05d3726",
  "click_id": "opaque_attribution_click",
  "external_order_id": "a8163cbc-2e27-445d-b0d7-f357fa3ce180",
  "stripe_account_id": "acct_bound_merchant",
  "livemode": false,
  "subject_id": "opaque_stable_customer_identifier",
  "purchase_sequence": 1,
  "context_id": "opaque_service_or_group_id",
  "status": "pending",
  "occurred_at": "2026-10-15T10:00:00Z",
  "channel": "creator",
  "entry_variant": "starter_pack",
  "webinar_id": "opaque_webinar_id",
  "intake_id": "opaque_intake_id"
}
```

The last four fields are optional. Values must match the documented opaque-ID contract; do not send email addresses or other personal information. `status` is `pending`, `fulfilled`, or `cancelled`. The verified commerce order, click, bound product/funnel, merchant account, and test/live mode must agree. Missing verified purchase returns retryable HTTP 409 (`verified_purchase_pending`). Identity, purchase sequence, service context, and dimensions cannot change once recorded. Replaying the exact event is idempotent; conflicting reuse is rejected. Cancellation is terminal for that service context.

The producing product must count **all** successful primary purchases for each customer/product/mode, including purchases without creator attribution. Otherwise it cannot reliably assert that an attributed order is the customer's first purchase. This count must be fixed transactionally, not recomputed from client data. Send only a stable opaque customer ID, not an email.

`cancelled` is evidence that the promised service/group was actually cancelled. Do not send it merely because a payment was refunded or a member became inactive after a refund. Financial refunds/disputes use the existing verified commerce-adjustment path and signed cutoff. A late ordinary refund must not be relabelled as service cancellation to bypass that cutoff.

Unsupported legacy billing sources refuse these new eligibility flags rather than silently paying an award without evidence. Existing rules without the flags continue through their original paths.

## Local validation

- Native PostgreSQL: 58 migrations, 45 passing database suites, no failures. Three existing operator-only suites are skipped by the native runner because they require specific hosted identities.
- Database tests cover signed term snapshots, pending/fulfilled/cancelled transitions, immutable identities and sequence, later-purchase rejection, duplicate evidence, account/mode isolation, hold start, cancellation after manual batch approval, browser restrictions, existing refund cutoff, metric dimensions and unrelated-creator isolation.
- Signed edge-handler tests: 8 passing tests exercise derived scope, signature rejection, malformed evidence, metadata allowlisting, and browser rejection. Deno type checking and lint pass for the changed endpoints.
- Full frontend regression: 864 tests in 65 files and 11 Node script tests passed. Production build (TypeScript and Vite) passed, with the existing large-chunk advisory. Targeted UI lint and `git diff --check` passed.
- Chrome acceptance against the real local RPC bridge demonstrated 2 signups unfiltered → 1 creator-channel signup → 0 for a nonmatching webinar → 1 for the correct webinar/intake; the unrelated creator could not view the funnel. Both existing creator and admin report surfaces were used.
- Local preview: `http://127.0.0.1:5189/funnel-metrics-local.html`; identities and events are synthetic. Local edge fixture: port 3203 with network permissions restricted to loopback.

Proof images: [admin filtered report](qa/workflow-2026-10-15/admin-filtered-report.jpg), [creator filters](qa/workflow-2026-10-15/creator-filters.jpg).

## Release boundary

No existing funnel definitions or commercial agreements are republished by these migrations. Operators still choose and publish their funnel metrics, configure a product event sender, and obtain a newly signed agreement if they want the new eligibility options. Real Zoom attendance, production provider onboarding, and real Stripe payouts are separate acceptance gates. Nothing in the local fixtures is evidence of production payment or attendance.

### Cross-application worker rehearsal

The actual SpeakSix local worker delivered an attributed purchase, metrics, and separate pending/fulfilled eligibility events through HMAC HTTP into KMA's actual receiver and disposable PostgreSQL database. A synthetic newly signed 25% rule with both eligibility options, a one-hour validation hold, and a one-day refund cutoff was used only for this fixture. The verified $179 test purchase produced a $44.75 held award: missing identity → awaiting service fulfilment → existing validation window after group confirmation. The same opaque customer remained purchase sequence 1, with immutable group/webinar/intake context. The filtered report counted one confirmed member and one verified sale. Replaying the exact fulfilled event returned duplicate success; changing merchant or payment mode returned HTTP 403. See [sanitized cross-app evidence](qa/workflow-2026-10-15/crossapp-evidence.json).

The fixture initially lacked Stripe total/charge/balance-transaction evidence; the receiver correctly kept the sale held and requested retry. After the isolated provider fixture supplied that evidence, the same event completed. No validation was weakened. The one-hour hold was not bypassed in the HTTP rehearsal; elapsed-hold eligibility and late-refund-cutoff behavior are covered by native SQL tests. No real Connect transfer was performed.

Browser proof from the same cross-app fixture: [verified sale and filtered metrics](qa/workflow-2026-10-15/admin-crossapp-sales.jpg), [creator report](qa/workflow-2026-10-15/creator-crossapp-report.jpg), [held commission and exact signed terms](qa/workflow-2026-10-15/creator-held-terms.jpg). The creator sees the validation hold starts after verified service fulfilment and that each batch still needs manual approval.
