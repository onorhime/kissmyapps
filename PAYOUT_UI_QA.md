# Payout UI phase — acceptance evidence

August 26, 2026. Working-tree preview at `http://127.0.0.1:5173/#payouts`.
Scope: **Y1–Y5** from [UX_SPEC_RECONCILIATION.md](./UX_SPEC_RECONCILIATION.md).
The approved green/lime design is retained. This is fictional presentation data,
not a deployed portal, payout engine, authenticated account, or payment operation.

## Implemented

- Four summary cards with accessible definitions: open-period earnings,
  approved/scheduled unpaid amounts, next expected payment, and paid to date.
  Commercial context includes the example model/rate, frequency, currency,
  method, agreement version, and masked destination.
- Fourteen-day UTC cycle, exact close, Monday–Thursday review, Friday expected
  payment, configurable-minimum explanation, and a below-minimum carry example.
  Expected does not mean approved, scheduled, or guaranteed.
- Full gross/fees/refunds/disputes/FX/tax-to-eligible-revenue bridge, commission,
  separate adjustments, and final period amount. Calculation notes use a native
  expandable disclosure, not hover-only content. Revenue share, CPL, CPA, and
  Hybrid guides show their inputs and count/rate calculations.
- All eight lifecycle states have an independently selectable guide. Hold,
  Failed, and Carried forward do not invent a payment date. These examples are
  excluded from dashboard balances, history, and exports.
- Detailed history with eligible basis, rate, earnings, adjustments, preliminary
  versus finalized sample amount, and all status filters. Details include pinned
  agreement/destination snapshots, payment date/reference, money-affecting
  history, change history, and five two-page sample PDF/CSV statements.
- Discrepancy form with associated errors, post-render invalid-field focus,
  10–1000-character message, and a local preview. It explicitly sends/saves
  nothing, creates no case number, and clears on dismissal or dataset removal.
- Empty/loading/unavailable/partial states. An empty account has no invented
  agreement, payment method, or next date. Partial data retains known ledger
  totals and finalized samples while unavailable current calculations show `—`.

## Fixture and calculation contract

`src/features/partner/payoutData.ts` is a presentation-only projection of the
existing fixtures; `data.ts` was not changed. All six original payout amounts,
periods, due dates, and statuses are preserved. Money remains integer USD minor
units until display/export.

- Snapshot: Aug 26, 2026 UTC. Open earnings: **$2,099.07**. Approved/scheduled:
  **$0.00**. Paid to date: **$12,564.54**. Next expected date: **Sep 4, 2026**,
  subject to review, the example agreement, and the minimum.
- Gross uses the same preview purchases/renewals; refunds use the same refund
  records. Fee/dispute/FX/tax entries are explicitly zero **in these fixtures**,
  not assertions about a real processor or tax treatment.
- The Jul 20–Aug 2 sample has $2,659.32 earnings and a separate **−$14.94**
  late-refund commission adjustment, producing $2,644.38. Its Jul 6–19 source
  statement remains $2,494.98. A later correction does not rewrite that sample.
- Paid money-history movements net to zero after the illustrative transfer;
  open-period movements retain their unpaid balance. Current refunds are not
  double-counted as commission adjustments. Negative CSV amounts stay numeric.
- The carry guide combines $75 prior balance and $60 new earnings into $135
  for review; it does not count the prior balance as new earnings or approval.
- Performance filters do not change the separately labelled all-source payout
  snapshot. A production client must receive authorized backend facts, not infer
  commercial entitlement or settlement from these fixture calculations.

## Automated evidence

`pnpm validate` and `pnpm format:check` passed: lint without warnings,
**197 tests across 10 files**, TypeScript, production build, and formatting.
No commit, deployment, or database operation was made.

The 46 added tests comprise 23 payout-model cases and 23 payout-UI cases. They
cover baseline preservation, revenue bridges, exact UTC windows, status guards,
carry semantics, commission inputs, signed CSV, PDF fingerprints, summary/detail
controls, unavailable states, statement gates, draft cleanup, and discrepancy
validation/focus. Error labels and descriptions are checked at the instant focus
is delivered; editing does not repeatedly steal focus.

Six new axe checks include portalled payout dialogs, all-state/model guides,
and invalid/preview discrepancy states. The suite now has 17 axe checks overall.
These run in jsdom with contrast disabled, not a rendered or screen-reader
conformance claim. The earlier 151 reporting/shared/auth tests remain passing.

## Browser and rendered-document evidence

| Check                   | Directly observed result                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payout page             | Six sizes: 320×740, 390×844, 768×1024, 844×390, 1100×500, 1440×900. Page width equals viewport width; all summary values fit. The wide history remains inside its horizontal scroll region.                                                  |
| Statement dialog        | Same six sizes. Dialog/content widths match: 288px, 358px, then 720px. Top/bottom stay 24px inside the viewport; no monetary value overflow.                                                                                                 |
| Lifecycle guides        | Eight states at 320×740 and 844×390: 16 cases without dialog overflow. Hold/Failed/Carried have no set payment date; illustrative transferred amount is zero except Paid.                                                                    |
| Commission guides       | Four models at both phone/landscape sizes: eight cases. Inputs remain visible; totals are $300 Revenue share, $200 CPL, $216 CPA, and $716 Hybrid.                                                                                           |
| Data states             | Sample/empty/loading/unavailable/partial at 320×740 and 1440×900: ten cases without page overflow. Loading/error expose no summary values; empty/loading/error exports are disabled.                                                         |
| Shared-route regression | Performance, Payouts, Links, and Profile at 320×740 and 1440×900: eight further cases with correct headings and page width equal to viewport width.                                                                                          |
| Discrepancy focus       | Opening focuses the reason; invalid submission focuses its associated visible error field. At 320px the focused field fits inside the dialog. Preview focuses its heading; Edit returns to the reason; Back returns to Report a discrepancy. |
| Long content            | A 1000-character message including a long unbroken token wraps inside a 242px message area and 288px dialog. Preview explicitly says it has not been sent or saved.                                                                          |
| Dialog wrap / Escape    | Shift+Tab wraps Close to the final CSV action and reveals it at y656.22–700.22 inside a dialog ending at y716. Tab wraps back to Close at y40–84. Escape restores the corresponding history action. This is not full native Tab traversal.   |
| Target sizes            | Summary help targets are 44×44px at 320/390px and 36×36px at larger sizes. Mobile dialog actions are 44px high.                                                                                                                              |
| PDF download            | A browser download event succeeded for SAMPLE-2026-0006. Its served URL returned HTTP 200, `application/pdf`, and 5013 bytes matching the checked-in asset SHA-256. Opening the downloaded file in a native PDF app was not checked.         |
| PDF rendering           | All five files reopen as two-page PDFs. All ten rendered pages were visually inspected: no clipped values, missing history, overlapping text, or stray blank pages. Every page is visibly labelled as a sample.                              |
| Console                 | No warning/error entries after the checked interactions and final cross-route pass.                                                                                                                                                          |

This phase includes **54 responsive route/state/dialog cases** (46 payout cases
plus eight shared-route regressions), not 54 physical-device or native-browser
configurations. The temporary viewport override was reset after checking.

Eleven text/background pairs were measured from rendered computed styles:

| Surface                  | Ratio       |
| ------------------------ | ----------- |
| Featured summary value   | 9.83:1      |
| Snapshot note            | 5.29:1      |
| Current lifecycle step   | 6.91:1      |
| Open / Carried forward   | 5.06:1 each |
| Pending review / On hold | 5.10:1 each |
| Approved / Paid          | 5.00:1 each |
| Scheduled                | 5.45:1      |
| Failed                   | 4.75:1      |

All exceed 4.5:1; statuses also have text labels. These targeted measurements
are not exhaustive WCAG certification. Screenshots, served-file evidence, and
rendered pages are in `/tmp/kissmyapps-payout-qa.FzRUbL/`; they are temporary QA
artifacts, not additional app assets.

## Sample PDF maintenance

The UI, CSV, and PDF generator consume the same payout snapshot. Each PDF has
a SHA-256 snapshot fingerprint in its metadata; tests detect stale assets.
Regenerate after an intentional fixture change:

```bash
pnpm statements:generate /path/to/python3
```

The Python path is optional and defaults to `python3`; it needs ReportLab. Node
must support TypeScript stripping. Re-render and inspect every page after any
generator/layout change. The five files under `public/statements/` are public
**only because they are fictional fixtures**. Real statements must use private,
authorized downloads with immutable backend-issued snapshots and identifiers.

## Remaining acceptance gates

- Full native Tab traversal of the new controls. Chrome was unavailable; the
  in-app normal Tab command did not advance focus. The specific Radix wrap and
  Escape results above do not replace native traversal or screen-reader proof.
- Native CSV download/file-open. The in-app CSV download event timed out;
  content and export handlers pass tests, but a saved/opened CSV was not observed.
  The successful PDF download does not close this CSV gate.
- Actual 200%/400% zoom, a real reduced-motion preference, spoken announcements,
  Safari, physical mobile keyboards, and native opening of the downloaded PDF.
- Real agreements, ledger/settlement facts, review/hold/payment enforcement,
  private statements, and discrepancy delivery after the exact Supabase project
  is identified and inspected. No credentials, backend connection, local/staging
  Supabase, email, payment, Jira update, or remote migration was used here.

Y1–Y5 frontend presentation is implemented. The subsequent **L1–L3, R1–R3, S1**
phase is also implemented; see [PARTNER_MANAGEMENT_UI_QA.md](./PARTNER_MANAGEMENT_UI_QA.md).
Manual acceptance and live integration remain open; this document retains the
payout phase's original 197-test evidence.
