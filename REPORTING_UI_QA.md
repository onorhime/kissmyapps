# Reporting UI phase — acceptance evidence

August 26, 2026. Working-tree preview at `http://127.0.0.1:5173/`.
Scope: **G2–G4 and P1–P5** from [UX_SPEC_RECONCILIATION.md](./UX_SPEC_RECONCILIATION.md).
The approved green/lime design is retained. This is not a deployed or connected portal.

## Implemented

- Shared product, public partner, partner-type, and commercial-model context on all
  four dashboard pages. One explicitly fictional product is available; an empty
  account has no active product or agreement. Mobile retains the partner context.
- Inclusive UTC ranges: 14/30/90 days, This year, and Custom. Custom dates have
  associated errors, invalid-field focus, Apply/Cancel, Escape restoration, and
  an Edit dates action. Resetting dimensions preserves the applied dates.
- Eight primary metrics, secondary revenue/visitor metrics, and definitions
  available through hover titles and keyboard/touch-accessible dialogs.
- Traffic, Conversion, and Revenue charts with up to three series, independently
  selected calendar day/week/month buckets, distinct line styles, and a Date
  table containing the same bucket values. Weeks start on Monday; boundary
  buckets are clipped to the selected dates.
- Date/source/country/campaign/funnel/Sub ID breakdowns; complete metric coverage;
  numeric sorting; a visible active sort header even when optional columns are
  hidden; pagination; pinned row labels, headers, and full-selection totals.
- CSV content includes every filtered/sorted row, all 18 period metrics, totals,
  date bounds, UTC, product, dimension filters, and an explicit sample status.
  Current subscription stocks are not exported as additive period metrics.
- Tracker, Singular, Stripe, app-event, and payout-reconciliation freshness
  examples. Every timestamp is labelled illustrative; no sync has run.
- Preliminary/Reconciled/Finalized examples. Missing-provider data cannot appear
  reconciled, and open-period examples cannot appear finalized. The explicit
  finalized example selects Aug 3–16, before the current Aug 17 payout period.

## Calculation contract

`src/features/partner/reporting.ts` is a separate UI fixture projection. It
extends reporting coverage to Jan 1–Aug 26 (238 days) without renumbering or
changing the original 90-day payout/link count or monetary fixtures.

- Additive counts and integer USD ledger minor units are summed exactly. Money
  is converted to USD major units once for display/export; negative values stay
  numeric in CSV. No commercial calculation is delegated to a production client.
- Unique visitors are deduplicated for each requested window, including grand
  totals. Daily unique counts are not summed. Synthetic fixture identities have
  exclusive attribution cohorts; a real adapter must return safe aggregates,
  never raw visitor/customer/provider identifiers.
- Active Subscriptions is a **current snapshot as of Aug 26, 2026 UTC**. Dimension
  filters apply; historical date ranges do not change it. It is neither a sum of
  daily stocks nor an implied historical end-of-period snapshot.
- New paid / click is total new paid customers divided by total clicks, not an
  average of row rates. With no clicks, the rate is undefined.
- A known no-activity bucket is zero. Missing coverage, including a mixture of
  known and missing values, remains null: em dash in the UI and “Unavailable” in
  CSV. Chart gaps are not connected. An all-unavailable selection explains the
  missing data instead of drawing a zero-value chart.
- Source filtering never changes the separately labelled current-period,
  all-source payout summary. The existing payout/link fixtures are preserved.

## Automated evidence

`pnpm validate` and `pnpm format:check` passed: lint, **151 tests**, TypeScript,
production build, and formatting. No commit or deployment was made.

The 49 added tests comprise 35 reporting-model cases and 14 reporting UI cases.
They cover calendar/leap boundaries, strict custom dates, full year coverage,
filter intersections/reset, distinct visitors, current stock semantics, null
propagation, signed money, weighted rates, all dimension/time totals, missing
dimension keys, numeric/null-last sorting, complete CSV output, formula-safe
strings, status guards, date drafts, native date submission, definitions,
three-series controls, optional-sort retention, page-independent totals,
provider state consistency, and focus reveal beyond the pinned column.

The earlier 102 tests remain in the suite. Existing reporting assertions were
updated for the required 14-day preset, separate Date breakdown, eight KPIs,
and the additional totals row; payout/link/auth regression coverage is retained.
The existing 11 axe checks remain structural jsdom checks with contrast disabled,
not a screen-reader or WCAG-conformance claim.

## Browser evidence

| Check                        | Directly observed result                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared context / core routes | All four pages at 320×740, 390×844, 768×1024, 844×390, 1100×500, and 1440×900: 24 route/size checks. Page width equalled viewport width; wide tables stayed inside their scroll regions; partner context remained visible.                                                                  |
| Performance states           | Sample, empty, loading, unavailable, and partial at 320×740, without horizontal page overflow. Loading/error expose no KPI cards; empty export is disabled; partial renders 12 unavailable table/total cells for installs and activations.                                                  |
| Chart controls               | Three selected metrics disable only additional choices. Selected metrics remain removable. Three revenue series use solid/dashed/dotted styles. An all-missing selection shows an explicit unavailable state.                                                                               |
| Filters / full year          | Country + campaign + funnel + Sub ID narrowed the report to Social media. Reset restored the dimension scope. This year covered Jan–Aug; the monthly table displayed Jan–Jul, then Aug on page 2 with full totals retained.                                                                 |
| Custom dates                 | Reversed dates focused End date with its associated error. At 320×740, the field fit inside the 288px dialog. Aug 10–16 applied correctly; Cancel discarded an Aug 25 draft; reopening retained Aug 10–16.                                                                                  |
| Dialog focus                 | Shift+Tab wrapped from Close to Apply dates; Escape restored Edit dates. At 844×390, the focused Apply action remained inside the dialog at y275.34–314.34. These are observed dialog events, not full native browser Tab traversal.                                                        |
| Table focus                  | All 19 sort headers were focused and measured at 320px; each label and its focus-ring clearance fit outside the pinned first column. The far-right Gross collected definition opened correctly and Escape restored its action. This pass used click-driven focus, not native Tab traversal. |
| Reconciliation               | A closed custom period could display the Finalized sample; selecting a current 14-day range returned it to Preliminary. Payout figures stayed unchanged.                                                                                                                                    |
| Console                      | No new warnings/errors after a clean reload and subsequent checked interactions. A development-only controlled-to-uncontrolled warning occurred while hot-reloading the open date form during its implementation; it did not recur after reload.                                            |

Additional table/value checks at 320×740:

- The eight year-to-date KPI values, including `$31,627.98`, fit their 111px
  value areas with no overflow.
- Scrolling the Date table from 0 to 72.5px left its header at y40.09 and its
  total-row bottom at y465.09. Both remained pinned inside the 425px region,
  above the preview toolbar.
- Partial Traffic plotted the two available series but produced no drawable
  path for unavailable installs; it did not substitute a zero line.

Six additional rendered text/background pairs were measured from computed styles:
context label 5.08:1, partner identity 11.38:1, selected series 9.00:1, sort header
6.70:1, provider label 5.69:1, and total values 11.20:1. These are targeted checks,
not exhaustive accessibility certification.

Confirmed defects repaired during this phase:

1. A hidden optional column could retain an invisible sort. The active sort
   column now remains visible, including after changing chart groups.
2. Mobile context initially hid the public partner/type. It now wraps visibly.
3. A long mobile sort label clipped its focus ring behind the pinned column.
   Mobile headers now wrap within the available width; all 19 were retested.
4. Native date field values could differ from a controlled draft during the
   browser check. Submission now validates the actual native form values; the
   precise stale-draft case has an automated regression test.

Screenshots from the check are in `/tmp/kissmyapps-reporting-qa.KQXIDa/`:
`desktop-reporting.jpg`, `mobile-date-validation.jpg`,
`mobile-table-last-column.jpg`, and `mobile-sticky-totals.jpg`.
Temporary screenshots are evidence, not app assets.

## Remaining acceptance gates

- Full native Tab traversal of the **new** report controls still needs a connected
  Chrome session. The Chrome connection was unavailable during this phase; the
  in-app Tab command did not advance native focus. Earlier Chrome evidence in
  [BROWSER_QA.md](./BROWSER_QA.md) is not proof of the newly added controls.
- Actual browser CSV download/file-open remains unconfirmed. The in-app download
  event timed out. CSV content, completeness, ordering, and the export click handler
  passed automated tests; do not equate them with an observed downloaded file.
- Actual 200%/400% zoom, real reduced-motion settings, screen-reader announcements,
  Safari, physical mobile keyboards, and authenticated end-to-end acceptance.
- Real tenant-safe aggregates, completeness/freshness contracts, authorization,
  immutable ledger/statement facts, and live commercial terms after real-project
  access. No Supabase credentials, connection, runtime, migration, or backend write
  was used for this phase.

The subsequent **Y1–Y5 payout transparency** phase is implemented; see
[PAYOUT_UI_QA.md](./PAYOUT_UI_QA.md) for its separate evidence and gates. The
Links/Profile/Documents phase (L1–L3, R1–R3, S1) is also implemented; see
[PARTNER_MANAGEMENT_UI_QA.md](./PARTNER_MANAGEMENT_UI_QA.md). Manual acceptance
and live integration remain open; the historical reporting evidence above is
not a claim of native-browser coverage for the later controls.
