# Links, Profile & Documents — UI verification

Date: August 26, 2026. Local preview: `http://127.0.0.1:5173/`.
Scope: UX v2.0 **L1–L3, R1–R3, S1**, following the reporting and payout phases.
This verifies fictional frontend behavior, not a deployed or authenticated portal.

## Implemented preview

- Main partner link, copy/fallback, source-link creation, and locally generated
  QR PNGs. Every destination stays under the reserved `.invalid` sample origin.
- Source, campaign, funnel, sub1, sub2, and sub3 appear in one shared URL builder.
  Campaign/funnel changes affect that URL. Identity and destination are fixed
  sample configuration, not editable partner/product IDs or arbitrary URLs.
- Clicks, leads, confirmed installs, New Paid, earnings, and lifecycle status;
  search and source/status filters; copy, QR, variants, pause, archive, restore,
  and link-scoped Performance. Archived records retain historical metrics and
  restore as paused. New links/variants start at zero and never inherit traffic
  just because their tracking tags resemble another link.
- Separate public/legal/contact identity, individual/company type, country,
  timezone/currency preferences, website/category, audience description/countries,
  and professional channels. Save/discard remain session-only; drafts survive
  section changes. Email stays read-only; fictional websites are never fetched.
- Read-only current/draft commercial versions, model/rate/rules, dates,
  illustrative attribution window, frequency/currency/minimum, and payment method.
  The current agreement is the same fixture used by Payouts. Reviewing a draft
  or changing a display preference does not alter historical USD/UTC statements.
- Nine document records cover all seven required types and eight lifecycle
  states. Two-party signature status/timestamps are separate from activation,
  expiration, supersession, and termination. Version relationships and private
  file availability are explicit. No file is uploaded or signed; only a labelled
  sample metadata CSV is offered. Actual signing and signed-PDF actions are gated.
- Exactly six notification categories: statements, payouts, verification,
  signatures, refund/dispute adjustments, and inactive links. No message is sent.

## Automated checks

`pnpm validate` passed: warning-free lint, **276 tests across 13 files**,
TypeScript, and production build. `pnpm format:check` also passed.
The worktree remains uncommitted; no deployment or database operation occurred.

This phase added **79 tests**:

- 24 link/QR model checks: preserved baseline totals, all URL dimensions,
  allowed sample configuration, normalization/duplicates/limits, zero-history
  variants, reversible archive, exact link attribution, locked drilldown scope,
  and decoding real generated PNG pixels back to their exact destinations.
- 18 profile/document checks: identity normalization/validation, the six
  categories, immutable shared agreement context, all document types/states,
  independent signatures, version links, UTC dates, and safe metadata CSV content.
- 37 UI/accessibility checks: copy/QR failure and retry, stale async completion,
  validation associations at focus time, new-link attribution/export boundaries,
  archive/restore, unavailable/partial states, profile save/discard/draft retention,
  current-vs-draft terms, document filters/signatures/private-file gates, section
  cleanup, unique names, and focus after section/filter changes.

Nine additional axe checks include portalled dialogs and invalid forms; the
total is now **26 structural axe checks**. Color contrast is disabled in jsdom.
These are not rendered contrast, native traversal, screen-reader, or WCAG
conformance proof. UI QR tests mock the asynchronous image for interaction
coverage; separate model tests generate and decode actual QR PNGs.

## Browser evidence

The in-app browser exercised the actual Vite app. Only fictional inputs were used.

| Coverage                                        | Observed result                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Eight routes at six sizes                       | 48 checks: Links, Performance, Payouts, and Profile details/payment/terms/documents/security at 320×740, 390×844, 768×1024, 844×390, 1100×500, 1440×900. No page-level horizontal overflow. Tables remained in their scroll regions. No visible button, text input, or select below 24px in either dimension was found.                    |
| Four management views × five states × two sizes | 40 checks at 320×740 and 1440×900: sample, empty, loading, unavailable, partial. No page overflow. Empty Links has no sample URL and disables creation/copy/QR; empty terms/documents invent no agreement or records. Loading/unavailable content does not expose management actions; partial link installs stay unknown rather than zero. |
| Six dialogs at six sizes                        | 36 checks: creation, link detail, archive confirmation, source QR, awaiting-countersignature document, superseded document. Dialog content width equalled client width; dialog and initially focused target stayed within viewport bounds.                                                                                                 |
| Long content                                    | Created an 80-character name with three 64-character Sub IDs. Page remained 320px; QR dialog client/scroll width was 288px. Two 1,000-character profile textareas stayed within 244px fields and retained their values across sections.                                                                                                    |
| Validation and reveal                           | Empty new-link submission focused Link name; invalid lower Sub 3 focused its associated hint/error within the scrolling dialog. Whitespace legal name and invalid website focused their visible associated errors above the preview toolbar.                                                                                               |
| QR focus                                        | Direct row QR opens on Close. At 320×740, reverse wrap revealed Download at y655.78–699.78; forward wrap revealed Close at y40–84. Escape restored the originating row QR action.                                                                                                                                                          |
| Link lifecycle/reporting                        | New variant displayed four zero counts and $0.00, with its distinct sub1. Its Performance view had no inherited history and disabled export. Show all performance focused persistent main content. Archive retained Social bio's 8,878 clicks / $1,359.54; restore returned it paused.                                                     |
| Cross-section/filter recovery                   | Terms → Review partnership documents focused the persistent Documents control, fully inside the 320px horizontal nav. Clearing no-match document filters focused Document status and restored all nine records; clearing link filters focused Search.                                                                                      |
| Document/export boundaries                      | A pending countersignature retained the partner's timestamp and no company timestamp. At 390×844, reverse wrap revealed the sample-record action at y760.05–804.05. Signing/signed-PDF actions stayed disabled. Metadata/QR clicks produced their local preview-only notices, not delivery claims.                                         |
| Visual/console                                  | Inspected desktop Links/Terms, narrow QR, legal validation, and document/action screenshots. Final browser warning/error log was empty.                                                                                                                                                                                                    |

The browser's empty-string `fill` did not clear an already populated profile
field, so that attempted action was not counted as required-field browser proof.
Whitespace validation was directly observed; empty-value validation is also
covered by component/model tests. Normal in-app Tab again did not advance focus;
the observed Radix boundary-wrap/Escape checks are narrower evidence, not full
native keyboard traversal.

### QR pixel proof

The long source QR rendered by the browser was read from its visible image's
data URL and decoded independently: **616×616 PNG, exact 315-character URL**,
including campaign, funnel, and all three Sub IDs. The image source and download
anchor contained the identical PNG data URL. This is stronger than checking the
label or link alone, but does not claim a native saved file was opened or a
physical phone scanned the code.

QR generation uses the local browser API of
[node-qrcode](https://github.com/soldair/node-qrcode); pixel verification uses
[jsQR](https://github.com/cozmo/jsQR). No external QR provider or live destination
was contacted.

### Rendered text colors

Thirteen targeted text surfaces were measured from actual computed DOM colors;
all were at least 4.5:1 using unrounded relative-luminance ratios. Repeated pairs
are grouped below. Disabled actions and decorative marks are not active text.

| Surface                                                                             | Foreground / background | Ratio   |
| ----------------------------------------------------------------------------------- | ----------------------- | ------- |
| Field hints, audience options, notification descriptions, lifecycle/signature notes | `#5c6b55` / `#ffffff`   | 5.69:1  |
| Profile error                                                                       | `#9e503c` / `#ffffff`   | 5.73:1  |
| Main-link explanation / current-commercial note                                     | `#5c6b55` / `#edf4df`   | 5.04:1  |
| Main-link guide action                                                              | `#366349` / `#edf4df`   | 6.13:1  |
| Commercial labels                                                                   | `#536849` / `#ffffff`   | 6.10:1  |
| Commercial values                                                                   | `#2a412d` / `#ffffff`   | 11.10:1 |
| Active document badge                                                               | `#37734b` / `#e9f4e8`   | 5.00:1  |
| Awaiting-signature badge                                                            | `#5c6b55` / `#faf2dd`   | 5.10:1  |

This is targeted visual QA, not exhaustive accessibility certification. Earlier
control-boundary/focus-indicator evidence remains in [BROWSER_QA.md](./BROWSER_QA.md).

### Findings repaired

- Draft normalization now explicitly selects editable string fields, avoiding
  accidental trimming of numeric metrics when given a full link object.
- QR heading focus is applied only when transitioning inside an existing dialog;
  direct opens let the dialog capture the opener before autofocus, preserving
  Escape restoration. Archive Cancel and return-to-details focus are explicit.
- Sub ID hints and errors are both associated with the relevant inputs.
- Clearing link-scoped Performance or empty-result filters and navigating from
  terms to documents retain focus on persistent, visible controls.
- The preview toolbar is an explicitly named region; full-document axe checks
  include the toolbar and portalled dialogs.

Temporary, reproducible evidence is in
`/tmp/kissmyapps-management-qa.t09BRp/`: JSON measurements, browser-derived QR PNG
and destination, and selected screenshots. These are QA artifacts, not app assets.

## Remaining acceptance gates

- Full native Tab traversal and spoken screen-reader behavior for the new
  controls. Do not extend earlier Chrome evidence to newly added UI.
- Native download/file-open for CSV and QR PNG, physical QR scan, and the earlier
  PDF/CSV file-open gates. Handler notices and pixel decoding do not establish
  operating-system download behavior.
- Actual 200%/400% browser zoom, real reduced-motion preference, Safari,
  physical iOS/Android keyboards, and assistive technology.
- After access: inspect the exact real Supabase project, then implement Auth,
  safe reporting, trusted link issuance, persistence, private documents/signatures,
  payment security, and authenticated tenant-isolation tests. No local/staging
  Supabase is needed or authorized. Build the first product/funnel afterward.

The partner frontend requirement phases are implemented in preview. Manual
acceptance and live functionality remain separate; no account, product, funnel,
tracking service, signature, email, payment, or backend was created by this pass.
