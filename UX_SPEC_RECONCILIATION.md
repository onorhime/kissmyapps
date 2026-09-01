# Partner portal — UX v2.0 reconciliation

Partner requirements reviewed August 26, 2026; Admin Affiliate implementation
status refreshed September 1, 2026.

## Source and scope

The user-supplied `KissMyApps_Affiliate_Portal_UX_Spec_v2.0.docx` was read in
full, including all eight tables, and all four rendered pages were visually
inspected. No comments or tracked changes were present. The source was not
modified. SHA-256:
`03d621530970ca639046b53db539136fdb431fab6885f476ccec55a1b95f2dcb`.

- Page 1: precedence, canonical journey, data ownership, global controls.
- Page 2: filters, Performance requirements, payout summary and revenue bridge.
- Page 3: commission models/cycles/statements, links, profile, document types.
- Page 4: document lifecycle/metadata, shared UX/security, final navigation.

The document is a requirements source, not authorization to create accounts,
send messages, deploy, operate payouts, or connect a backend. Its own precedence
rule retains Senior Developer Specification v3.2 for architecture/business
logic. The user's newer direction also remains explicit: partner dashboard
first; no actual product/funnel yet; no assumed Coin Flip URL; no local or staging
Supabase; inspect the designated real project after access is granted.

**The partner-facing frontend requirement phases are implemented in preview.**
This does not close native/manual acceptance, live integration/security, or the
remaining admin scope beyond the implemented Overview, Products, and Affiliates
foundation.
Evidence is in [BROWSER_QA.md](./BROWSER_QA.md) and the
phase-specific QA records.

## Requirements matrix

“Preview complete” means the specified frontend presentation and local example
interactions are implemented. It does not mean deployed, connected, signed,
paid, or fully accepted on native browsers and assistive technology.

| ID  | Requirement / source                                                                | Current state                   | Remaining acceptance work                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Four partner navigation areas, pp. 1/4                                              | Preview                         | Retain Performance, Payouts, Links & Sources, Profile & Documents.                                                                                                                                                                                                                                                   |
| G2  | Product selector and partner/commercial context, p. 1                               | Preview complete                | Shared context on all four pages, retained on mobile; one fictional product, explicit sample terms, and no-active-product/no-agreement state. Real product access and agreements remain backend-gated.                                                                                                               |
| G3  | 14/30/90 days, This year, Custom; UTC; day/week/month, pp. 1–2                      | Preview complete                | Inclusive ranges and validated custom dates; independent calendar chart/Date-table buckets, Monday weeks, clipped boundaries. Fixture coverage is Jan 1–Aug 26, 2026.                                                                                                                                                |
| G4  | Country/source/campaign/funnel/Sub ID filters, p. 2                                 | Preview complete                | Combined filtering feeds the same KPIs, chart, table, totals, and CSV. Reset preserves dates; no matches stay distinct from an unconfigured account.                                                                                                                                                                 |
| P1  | Metric coverage and definitions, p. 2                                               | Preview complete                | Eight primary KPIs, New Paid Customers wording, secondary visitor/revenue metrics, hover/click definitions, and a clearly dated current subscription snapshot independent of historical ranges.                                                                                                                      |
| P2  | Traffic / Conversion / Revenue chart groups, p. 2                                   | Preview complete                | Required groups and up to three compatible series; solid/dashed/dotted lines; aligned time buckets and equivalent Date table; explicit missing-only selection state.                                                                                                                                                 |
| P3  | Full metric table, sorting, sticky totals, CSV, p. 2                                | Preview complete; download gate | All 18 period metrics, numeric/null-last sorting, pinned totals/labels, full-selection aggregation, and complete sorted CSV content. Actual browser download/file-open still needs manual acceptance.                                                                                                                |
| P4  | Source/campaign/funnel/Sub ID/country breakdowns, pp. 2/4                           | Preview complete                | All dimensions plus Date; Direct / untagged is retained; missing dimensions have distinct keys/appropriate labels; totals are recomputed from the full selection.                                                                                                                                                    |
| P5  | Unknown values, reconciliation states, provider freshness, pp. 2/4                  | Preview complete                | Missing metrics propagate through all reporting surfaces and CSV. Five provider freshness examples and guarded Preliminary/Reconciled/Finalized sample states; no live sync is implied.                                                                                                                              |
| Y1  | Open earnings, approved/scheduled, next expected payment, total paid, pp. 2–3       | Preview complete                | Four summary cards with definitions and expected-date caveat; model/rate/frequency/currency/method and example agreement context. Empty/unavailable states do not invent terms or dates. Real facts remain backend-gated.                                                                                            |
| Y2  | Gross-to-eligible-to-earnings bridge; CPL/CPA calculation, pp. 2–3                  | Preview complete                | Full gross/fees/refunds/disputes/FX/tax bridge, separate late adjustment, and visible Revenue share/CPL/CPA/Hybrid inputs. Notes are available without hover. Original fixture amounts are preserved; this is not a production payout engine.                                                                        |
| Y3  | 14-day UTC cycle, review/payment windows, configurable minimum/carry, p. 3          | Preview complete                | Exact UTC close, Monday–Thursday review, Friday expected date, example minimum, and carry scenario. Prior balance is not new earnings; crossing the minimum does not approve a payment.                                                                                                                              |
| Y4  | Eight payout statuses and immutable paid history, p. 3                              | Preview complete                | All eight independent state guides, with no invented payment date for hold/failure/carry; guides are excluded from balances/exports. Paid sample snapshots stay fixed; late corrections appear in a later period. Live immutability requires backend enforcement.                                                    |
| Y5  | PDF/CSV statements, payment date/reference, money history, discrepancy action, p. 3 | Preview complete; download gate | Five two-page sample PDFs and matching CSVs, payment facts, money/change history, and local-only discrepancy validation/preview. All PDF pages inspected and one browser PDF download observed. Native CSV/file-open remains a manual gate; private statements and real report delivery require backend integration. |
| Y6  | Bank/crypto security and operational gates, p. 3                                    | Explanatory preview             | UI explains password **and** 2FA, email confirmation, 48-hour hold, scheduled-payment lock, and first-crypto test transfer. Enforcement and transfers require the real backend.                                                                                                                                      |
| L1  | Main partner link, copy, QR, Create Source Link, p. 3                               | Preview complete; file gate     | Main/source copy, QR PNG, creation and fallback surfaces use reserved non-live URLs. Real generated pixels decode to the exact displayed destination. Native file-open/physical scan and real URL issuance remain gates.                                                                                             |
| L2  | Source/campaign/funnel/sub1/sub2/sub3 and trusted identity, p. 3                    | Preview complete                | One builder encodes source/campaign/funnel/sub1/sub2/sub3; validated allowlisted choices and duplicate checks. Fixed sample identity cannot be overridden. Real identity, commercial terms and destinations must be server-resolved.                                                                                 |
| L3  | Link performance columns and lifecycle actions, p. 3                                | Preview complete                | All required metrics/actions, zero-history variants, reversible archive, exact link-scoped reporting and export context. Paused/archived records retain history; partial installs stay unknown. Real lifecycle enforcement and persistence remain backend-gated.                                                     |
| R1  | Full partner identity/audience fields, p. 3                                         | Preview complete                | Public/legal/contact identity, entity type, country/timezone/currency preferences, fictional website/category, audience/countries/channels, session-only save/discard and draft retention. Email stays read-only; preferences do not convert USD reports or change UTC cycles.                                       |
| R2  | Read-only commercial terms and versions, p. 3                                       | Preview complete                | Read-only current/draft versions, model/rate/rules, dates, illustrative window, frequency/currency/minimum and status. Uses the same current sample agreement as Payouts; draft review never changes paid snapshots. Real terms/version activation remain backend-gated.                                             |
| R3  | Document types, lifecycle, and metadata, pp. 3–4                                    | Preview complete; file gate     | Nine examples cover seven types/eight lifecycle states, separate two-party signature timestamps, created/effective/expiry/termination dates and supersession. No private file exists; upload/sign/signed-PDF actions stay gated. Sample metadata CSV is not an agreement.                                            |
| S1  | Restricted notification categories, p. 4                                            | Preview complete                | Exactly statements, payouts, verification, signatures, refund/dispute adjustments and inactive links. Preferences save/discard in browser memory only; live delivery and persistence remain backend-gated.                                                                                                           |
| S2  | Partner-safe history, private files, RLS/2FA/encryption, p. 4                       | Partial backend gate            | Base tables remain browser-inaccessible and Admin Affiliate reads return explicit aggregates/evidence through protected RPCs. Private signed downloads, full 2FA enforcement, and authenticated cross-tenant browser acceptance remain open. Do not expose raw provider/customer data.                               |
| S3  | Admin View as Partner, p. 4                                                         | Deferred admin subfeature       | The protected Admin shell, Product Catalog, and Affiliate directory/lifecycle controls now exist. Build scoped View as Partner later as read-only, without partner credentials, with full admin audit history.                                                                                                       |

## Implementation status and next steps

Reporting, payouts, and management are implemented in preview. Evidence and
manual gates are in [REPORTING_UI_QA.md](./REPORTING_UI_QA.md),
[PAYOUT_UI_QA.md](./PAYOUT_UI_QA.md), and
[PARTNER_MANAGEMENT_UI_QA.md](./PARTNER_MANAGEMENT_UI_QA.md).

1. **Reporting and global context — implemented in preview:** G2–G4, P1–P5.
   Complete native-browser/manual acceptance without implying live integration.
2. **Payout transparency — implemented in preview:** Y1–Y5. Commercial context,
   expected date, calculation bridge, status guides, statements, and local-only
   history/discrepancy previews. Native-browser and live-integration gates remain.
3. **Links and profile — implemented in preview:** L1–L3, R1–R3, S1. Main/QR
   links, full tracking dimensions/actions, commercial terms and document states.
   The current revision passes 276 tests and the available browser matrix.
4. Complete the retained native keyboard, downloaded-file, assistive-technology,
   zoom and physical-device gates; they do not need Supabase credentials.
5. The real Supabase project, Partner M1b, and Admin Overview/Product/Affiliate
   foundation are complete. Create the first actual draft product only after its
   exact name and slug are approved; add its funnel later when a real destination
   exists. Authenticated production visual acceptance for Affiliates remains a
   separate gate.

## Acceptance status

- [x] Read the supplied document completely and inspect every rendered page.
- [x] Reconcile the specification with current source and available UI states.
- [x] Fix confirmed overflow, focus, validation, feedback, and contrast defects.
- [x] Pass the earlier 102-test review, then 151 reporting tests and 197 tests
      for the payout implementation, with lint, formatting, TypeScript/build.
- [x] Retain earlier native-keyboard evidence and record current reporting
      responsive/dialog/focus/color checks with their explicit limitations.
- [x] Implement the reporting/global-context preview phase (G2–G4, P1–P5).
- [x] Implement payout transparency (Y1–Y5); check 54 responsive cases, focus,
      eleven rendered text-color pairs, and all ten sample PDF pages.
- [x] Implement L1–L3, R1–R3 and S1; pass 276 tests, lint, formatting,
      TypeScript/build, 48 route/40 state/36 dialog checks, focus/long-content
      checks, 13 rendered text-color samples, and real browser QR pixel decoding.
- [x] Add protected Admin Affiliate summary/directory/detail and audited
      lifecycle controls without implementing credential-sharing View as Partner.
- [ ] Verify full native Tab traversal of the new report/payout/management controls,
      actual CSV/QR download/file-open, and physical QR scan; current in-app
      checks do not establish this proof.
- [ ] Verify actual browser zoom, real reduced-motion preference, screen-reader
      announcements, Safari, and physical iOS/Android keyboards.
- [ ] Complete authenticated, tenant-safe real-project acceptance tests.

The manual and live gates cannot be inferred from jsdom, source inspection, or desktop
viewport emulation. Detailed evidence is in [BROWSER_QA.md](./BROWSER_QA.md), and
the implementation sequence is in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).
