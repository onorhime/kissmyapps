# Partner and Admin dashboard UI and live foundation — 2026-09-01

## What is ready

A custom React/TypeScript UI in the existing project, not a purchased affiliate
template. The shared design now follows the canonical `kissmyapps.dev` dark
palette, Outfit typography, lips/sparkle mark, consistent cards/forms/tables,
and responsive CSS.
Radix provides modal behavior, Lucide supplies icons, and Recharts provides the
lazy-loaded trend chart. These are components, not a dashboard template.

The user approved this visual direction. The default runtime now uses real
Supabase Auth and a typed partner gateway. The historical sample/failure-state
experience remains available only through the explicit preview flag. This is a
connected Partner foundation with Admin Products and Admin Affiliates, not yet a
complete production affiliate platform: the real project deliberately has no
active product or funnel.
No local Supabase or staging environment is used.

| Area                | Implemented now                                                                                                                                                                   | Still open                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace context   | Auth-gated live workspace provider, typed partner gateway, product-independent zero-data state, plus opt-in fixture context on all four pages                                     | First product membership/effective agreement and authenticated production Affiliate responsive/accessibility acceptance                              |
| Performance         | Tenant-safe summary/trend RPC contracts and live gateway with date, timezone, product/funnel/source/currency/completeness inputs; full historical preview interactions            | First non-empty live data, provider configuration/traffic, native downloaded-file acceptance, and authenticated chart/table verification             |
| Payouts             | Authorized summary/history/detail contracts and database-enforced immutable money snapshots; full historical calculation/status/statement preview                                 | Real commission events, private statement files, discrepancy delivery, human-approved release operations, and any later provider-transfer automation |
| Links & Sources     | Authenticated create/update/status RPC contracts, configured-product/funnel gates, live zero-data behavior, and full historical link/QR preview                                   | First configured product/funnel, enabled redirect traffic, canonical acquisition continuity, and physical QR/native file acceptance                  |
| Profile & Documents | Persistent profile/settings RPC contracts, private bucket and record-scoped read authorization, plus the full historical profile/document preview                                 | Upload/download-signing UI, real signatures, payment-destination verification/holds, and authenticated end-to-end document acceptance                |
| Sign-in & recovery  | Real sign-in, completed recovery/activation and public confirmed-email registration, session handling, Partner/Admin route gating, sign-out, production URLs, and approved policy | Full session-expiry/device acceptance and broader lifecycle email                                                                                    |
| Admin Products      | Protected Overview/Product routes, complete P2 roadmap navigation, protected catalog, and Operations/Owner draft-only name+slug creation                                          | Replace/rename the placeholder draft with the first approved product, then add its real funnel                                                       |
| Admin Affiliates    | Protected summary/directory/detail routes; registration/legal/commercial evidence; responsive cards; audited pause/reactivate; Owner-only blocked termination                     | Authenticated production visual acceptance and later scoped View as Partner                                                                          |

See [UX_SPEC_RECONCILIATION.md](./UX_SPEC_RECONCILIATION.md) for the requirement
mapping and the distinction between implemented UI, live foundation, and retained
manual acceptance.

## Opt-in preview boundaries

Start the fixture experience explicitly:

```bash
VITE_ENABLE_UI_PREVIEW=true pnpm dev --host 127.0.0.1
```

- Fixtures are deterministic and end on **August 26, 2026**, using UTC. Reporting
  is explicitly a sample snapshot, not a live sync.
- Sample links use `https://go.example.invalid/...`; they cannot be used for live
  traffic. No real product or funnel was introduced. QR generation is local and
  uses the exact shared URL; no external QR service receives any data. New links
  and variants never inherit metrics from similar tracking labels. Archive is
  reversible and retains history.
- In preview mode, link/profile changes remain in React state and reset on reload.
  This does not describe the default runtime, which uses the Supabase client and
  live partner gateway.
- Preview auth forms accept only fictional `.invalid` email addresses and explicitly
  instruct users not to enter real credentials. Password fields hold made-up
  values in component memory only. Submission, retry, scenario changes, and
  auth-route changes clear those values; no auth data is written to storage,
  URLs, or a server. Browser/password-manager behavior is not controlled by the
  application, so use the example-details button rather than real secrets.
- Under the preview flag, `#auth/sign-in`, `#auth/recover`, and `#auth/reset` use
  presentation scenarios, not real sessions. Without that flag, the same routes
  use Supabase Auth and the dashboard is session-gated.
- The preview reset's 12-character minimum is a UI example. The hosted Supabase
  12-character minimum is separately confirmed and active.
- Payment details are read-only placeholders. Verification is explanatory only;
  no bank, wallet, email, test transfer, hold, or payment operation occurs.
- In preview mode, profile timezone/currency selections are preferences only: reports and payout
  cycles remain UTC/USD. Commercial draft review does not activate terms or
  rewrite paid snapshots; the current agreement is shared with Payouts.
- Profile documents are metadata demonstrations, not actual agreements or
  signatures. Their two-party signature timestamps and lifecycle are separate;
  all private file paths are absent, actual upload/sign actions are disabled,
  and the available document export is explicitly sample metadata only. Payouts also have five visibly fictional two-page PDF statements
  and matching CSV content from the same snapshot. They are not payment evidence
  or real invoices. Any real file must use the deployed private bucket and an
  authorized download flow.
- Empty-account mode has no active product/funnel, links, payout period, or
  documents. Zero activity is distinct from failed/unavailable data.
- Loading and unavailable previews work across all four pages. Partial-data
  mode shows unavailable confirmed installs/activations as `—` on Performance,
  unavailable link installs as `—`, and unavailable current payout-calculation
  values as `—`. Known payout ledger
  totals/finalized samples and other sections retain their available records.
- Filtered-out results are distinct from an unconfigured account. Filtered
  charts keep all selected calendar dates; zero filling is valid only because
  the fixtures are complete. A real reporting adapter must retain unknown/null
  values when completeness is not established.
- All fixture money is integer USD minor units. Performance earnings are before
  payout-level adjustments; payout details show adjustments separately. A live
  adapter must not aggregate different currencies into a single figure.
- The payout overview is labelled current period/all sources and does not
  silently follow the Performance report filters.
- Independent payout-state/model guides never change balances or exports.
  Expected payment is not approval; carry does not create new earnings. A
  discrepancy is an in-memory report preview only: no case, storage, or delivery.

## Live Supabase state

- Project: `mmyruzjemjecqyivhrgr` (`KissMyApps`), used directly with no local or
  staging Supabase runtime.
- Applied migrations: all 19 versions from
  `20260825215958_platform_foundation` through
  `20260901180000_admin_platform_settings`.
- Remote security surface: public base tables remain RLS-protected with zero
  browser-role grants; authenticated access stays behind explicit Partner/Admin
  views and RPC allowlists, including the Admin Affiliate contracts.
- Storage: private `affiliate-private-documents` bucket with record-scoped read
  policies; zero objects are seeded.
- Remote acceptance: 724 of 724 PostgreSQL 17 assertions passed across the full
  16-file migration suite; remote database lint reported no errors.
- Application integration: real Auth/session/recovery/reset/sign-out plus a typed
  partner gateway and live authenticated zero-data workspace provider.
- Live state: no active product, funnel, link, payout, or storage object; retained
  QA registration data and a least-privilege Operations Admin remain intact.

This proves the deployed foundation and its catalog/security contracts. It does
not prove a non-empty authenticated user journey, document upload/signing,
provider ingestion, scheduled calculation, payout transfer, or the remaining P2
Admin modules.

## Source reconciliation

Reviewed the current SUBAPPS-161 and SUBAPPS-186 Jira descriptions/metadata and
all six pages of the locally available
`KissMyApps_Affiliate_Platform_Senior_Developer_Spec_v3.2_Concise.pdf`.

The user has now supplied `KissMyApps_Affiliate_Portal_UX_Spec_v2.0.docx`, whose
filename matches the newer SUBAPPS-161 attachment metadata discovered earlier.
The complete supplied document, all eight tables, and all four rendered pages
were reviewed on 2026-08-26. The original was not changed. Its source fingerprint,
page map, precedence, and full requirement reconciliation are recorded in
[UX_SPEC_RECONCILIATION.md](./UX_SPEC_RECONCILIATION.md).

Reporting/global context (G2–G4, P1–P5), payout transparency (Y1–Y5), and
Links/Profile/Documents (L1–L3, R1–R3, S1) are implemented in the preview, with
separate evidence in [REPORTING_UI_QA.md](./REPORTING_UI_QA.md),
[PAYOUT_UI_QA.md](./PAYOUT_UI_QA.md), and
[PARTNER_MANAGEMENT_UI_QA.md](./PARTNER_MANAGEMENT_UI_QA.md). That evidence is
scoped to the opt-in fixture preview; the connected live foundation is recorded
separately above. Manual/device acceptance and non-empty authenticated behavior
are not implied. The user's no-product/no-funnel and real-project-only direction
is preserved.

## Automated verification

- The current local web suite passed formatting, warning-free lint, 573 tests
  across 41 files, TypeScript, and the Vite production build. It
  includes live Auth/session, partner-gateway, and authenticated zero-data
  coverage in addition to the fixture UI regressions. Source commit `e464942`
  is deployed at
  `/srv/kissmyapps/releases/20260901T112904Z-admin-platform-settings-e4649427be8a`;
  authenticated production-browser acceptance remains open.
- The historical 276-test preview milestone covers navigation, preview states, filter/no-match behavior,
  report grouping and pagination, UTC date windows, calendar gaps, currency
  minor units, payout totals/periods, CSV escaping/formula protection, reserved
  URLs, clipboard failure, sample-link creation/pause, profile normalization,
  document/security gates, skip link, modal focus restoration, auth validation,
  Enter submission, password visibility, retry/result focus, reset-link gates,
  input clearing, no-network/no-storage auth behavior, and history navigation.
  The earlier document/QA pass added 11 interaction regressions and 16 source
  color guards, covering modal/profile-tab focus reveal, required-field errors,
  modal-local feedback, stale clipboard results, section cleanup/draft retention,
  and unique document action names.
- The reporting phase adds 35 model tests and 14 UI tests: strict/inclusive
  dates, full-year coverage, distinct visitors, current stock semantics, null
  propagation, weighted rates, signed ledger values, all dimensions and time
  buckets, complete sorted CSV, sample status guards, native date submission,
  chart limits, visible sort retention, full totals, and pinned-column focus.
- The payout phase adds 23 model tests and 23 UI tests: preserved baseline
  totals, full bridges, UTC scheduling, all lifecycle/model examples, carry,
  signed CSV, PDF snapshot fingerprints, unknown states, statement gates, and
  local discrepancy validation/focus/draft cleanup.
- The management phase adds 24 link/QR model tests, 18 profile/document tests,
  and 37 UI/accessibility tests. These cover full URL/real QR equivalence,
  distinct zero-history links, reversible archive, scoped exports, required
  identity and all notification categories, current/draft commercial boundaries,
  document lifecycle/signature independence, private-file gates, stale dialogs,
  full-document structural checks and explicit navigation/filter focus recovery.
- Twenty-six axe-core checks cover the earlier 17 page/auth/payout surfaces and
  nine new management states, including portalled dialogs and invalid forms.
  They run in jsdom with the color-contrast rule disabled because jsdom has no
  layout engine. They are structural checks, not a WCAG conformance claim.
- Earlier browser checks covered 44 route/viewport cases including tablet, landscape,
  short desktop, all four data states, auth routes, and profile subsections.
  Native Chrome keyboard traversal, live modal resize/history restoration,
  long-content stress cases, and 17 targeted rendered color pairs were checked.
  Confirmed issues were repaired and retested. See
  [BROWSER_QA.md](./BROWSER_QA.md) for the retained evidence and remaining gaps.
- The current reporting pass checked all four pages at six viewport sizes,
  five Performance states, date/filter/chart interactions, 19 mobile sort-header
  focus targets, and six additional rendered color pairs. Full native Tab
  traversal of the new controls and actual CSV download/file-open remain manual
  gates; see [REPORTING_UI_QA.md](./REPORTING_UI_QA.md).
- The payout pass checked 54 responsive route/state/dialog cases, error/preview
  focus and scroll reveal, long-message wrapping, and eleven rendered text-color
  pairs. All ten sample PDF pages were inspected and a browser PDF download event
  succeeded. Native CSV/file-open and full native Tab traversal remain open;
  see [PAYOUT_UI_QA.md](./PAYOUT_UI_QA.md).
- The management pass checked 48 route/size cases, 40 data-state cases and 36
  dialog cases, long content and first-invalid focus reveal, cross-section/filter
  recovery, modal wrap/Escape, 13 text-color samples, and exact decoding of the
  actual browser-rendered QR PNG. Its warning/error log was empty. Normal in-app
  Tab did not advance focus; native file-open/physical QR scanning remain gates.
  See [PARTNER_MANAGEMENT_UI_QA.md](./PARTNER_MANAGEMENT_UI_QA.md).
- Actual browser zoom, a real reduced-motion preference, Safari/physical-device
  behavior, and spoken screen-reader announcements remain unverified. A zoom
  shortcut that did not change viewport/DPR was not counted as proof. Automated
  accessibility checks and viewport emulation are not a substitute for these
  manual gates, nor is this a full WCAG conformance claim.
- Remote project verification passed all 724 PostgreSQL 17 assertions across
  tests `00` through `15`, plus remote database lint without errors.
  Catalog checks confirmed 36/36 RLS tables, zero browser-role base-table grants,
  eight partner views, 49 approved authenticated functions, no public/anonymous
  executable public functions, and the private document bucket/policies.

Commands: `pnpm format:check` and `pnpm validate`.

## UI acceptance checklist

- [x] Approve the visual direction (user approval received).
- [x] Add matching sign-in and password-recovery/reset previews.
- [x] Earlier review: run targeted narrow-screen and native Chrome keyboard checks; fix observed issues.
- [x] Verify all four pages in Sample data and Empty account modes.
- [x] Earlier review: complete tablet, short-desktop, landscape, dialog-resize,
      native Chrome keyboard, and targeted rendered-contrast checks.
- [x] Read and reconcile all four pages of the supplied UX v2.0 document.
- [x] Implement reporting/global context (G2–G4, P1–P5) and finish its available
      automated/responsive/dialog/focus/contrast checks; see REPORTING_UI_QA.md.
- [x] Implement payout transparency (Y1–Y5) and finish available automated,
      responsive, focus, color, and PDF-render checks; see PAYOUT_UI_QA.md.
- [x] Implement Links/Profile/Documents (L1–L3, R1–R3, S1) and finish available
      automated/responsive/focus/contrast/QR checks; see PARTNER_MANAGEMENT_UI_QA.md.
- [x] Connect the real `KissMyApps` project, deploy the reviewed foundation, and
      verify its remote RLS/grant/view/RPC/storage contracts.
- [x] Implement the default live Auth/session/recovery/reset/sign-out flow and
      typed authenticated zero-data partner gateway.
- [x] Confirm and apply the hosted Auth URLs, public Partner signup with required
      email confirmation, Admin signup denial, and password policy.
- [x] Recover, activate, and verify the first QA Partner on the real project.
- [x] Add the protected Admin Overview/Product foundation, provision the same QA
      user as Operations, and verify authenticated desktop/390px zero-product UI.
- [x] Add the protected Admin Affiliate summary/directory/detail and audited
      lifecycle workflows, with Operations/Owner pause/reactivate and Owner-only
      termination blockers.
- [ ] Verify the Admin Affiliate directory, route-backed detail, and lifecycle
      dialogs in an authenticated production desktop/mobile session.
- [ ] Build the first product/funnel and verify every non-empty partner screen
      against real authorized data.
- [ ] Implement and verify private document upload/download-signing, signatures,
      and payment-destination security workflows.
- [ ] Verify full native Tab traversal of new reporting/payout/management controls,
      native CSV/QR file-open and physical QR scanning in supported browsers.
- [ ] Test actual browser zoom, real reduced-motion preference, physical mobile
      keyboards, Safari, and screen-reader announcements.

## Remaining live integration work

1. **First product:** create the first approved draft in Admin only after its
   exact name and slug are supplied.
2. **First funnel:** connect that product's approved destination, partner
   membership, agreement, and commission rules. Then test the non-empty live
   performance, link, payout, profile, paused-history, timezone, completeness,
   and currency behavior.
3. **Attribution/provider activation:** configure the deployed fail-closed
   redirect/click, Stripe, commercial, metrics, and reconciliation Functions;
   add Singular ingestion and only the approved sanitized behavioral subset for
   Amplitude. No traffic or schedule is active yet.
4. **Documents and payment security:** add authenticated upload/download-signing
   UI, signatures, versioning, reauthentication, email confirmation,
   payout-destination holds, scheduled-payment locks, and first-crypto
   test-transfer checks on top of the private storage foundation.
5. **Payout operations:** keep release human-approved initially. Provider transfer
   automation, live statements, exception handling, and operational reconciliation
   require separate implementation and end-to-end acceptance.
6. **Remaining Admin P2:** add Subscriptions, Payouts, Documents, and scoped View
   as Partner after their real workflows are ready and auditable. Affiliates,
   Funnels & Links, Attribution, Data Health, and Settings are implemented.
