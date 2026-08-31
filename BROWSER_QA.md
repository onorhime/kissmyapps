# KissMyApps Dashboard — browser QA

## Public production host pass — August 30, 2026

The deployed Hostinger release was checked over public HTTPS in the in-app
browser without an authenticated session. This verifies the public shell and
hostname routing only; it does not replace the retained authenticated role and
sign-out gate.

| Coverage                   | Directly observed result                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partner host               | `https://partners.kissmyapps.dev` settled on `#auth/sign-in`, used the title `Sign in · KissMyApps Partners`, and rendered the Partner-specific sign-in copy.                          |
| Admin host                 | `https://admin.kissmyapps.dev` settled on `#auth/sign-in`, used the title `Sign in · KissMyApps Admin`, and rendered the Admin-specific branding and sign-in copy.                     |
| Desktop visual check       | Both public hosts rendered the production lips/sparkle brand, dark palette, complete sign-in form, recovery route, and responsive card without visible layout errors.                  |
| 390 × 844 responsive check | On both hosts, body client width and scroll width were 390px. The sign-in card measured 342px wide from x=24 to x=366, with no horizontal document overflow.                           |
| Retained gate              | The available browser had no production session, and the user's Chrome control extension was unavailable. Authenticated Partner/Admin authorization and sign-out remain manual checks. |

The associated HTTPS, security-header, fail-closed redirect-gateway, container,
and DramaPal regression evidence is recorded in
[RELEASE_EVIDENCE_2026-08-30.md](./RELEASE_EVIDENCE_2026-08-30.md).

## Admin P2 and shared-brand pass — August 28, 2026

The local Vite runtime was checked in an authenticated Chrome session connected
to the real Supabase project after the Admin Product migration and
least-privilege Operations role were applied.

| Coverage               | Directly observed result                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop Admin Products | Canonical lips/sparkle mark, dark `kissmyapps.dev` palette, Outfit typography, protected Products heading/form, and truthful zero-product catalog rendered at 1212px with no console warnings/errors.     |
| Live contracts         | The QA account resolved as Operations; `get_admin_context()` and `get_admin_products()` loaded successfully and the live catalog remained empty. No form was submitted and no product/funnel was created. |
| 390 × 844 mobile       | Page width and document scroll width both measured 390px. Form controls/cards stayed inside the viewport, 44px controls remained reachable, and the catalog empty state stacked correctly.                |
| Mobile navigation      | Overview, Products, all upcoming P2 destinations, and the repaired Switch to Partner action were reachable from the mobile navigation.                                                                    |
| Routes and focus       | Products → Overview moved focus to the destination main content. Switching to Partner reached the authenticated Performance route and its real zero-product state.                                        |
| Draft form             | A fictional unsent name generated the canonical `test-product-preview` slug. The inputs were cleared without clicking Create, preserving the remote zero-product state.                                   |
| Automated companion    | At that August 28 revision, 24 files / 342 web tests passed, including 22 focused Admin tests and structural axe checks. Remote pgTAP passed 311/311, and remote database lint reported no schema errors. |

This is authenticated local-runtime browser evidence for the first Admin slice.
It is not authenticated production-host evidence, a full
Safari/device/screen-reader certification, or proof of future modules labelled
Upcoming.

## Historical Partner UX v2.0 pass — August 26, 2026

Date: August 26, 2026. Target: the local Vite preview at
`http://127.0.0.1:5173/`. This is a working-tree check of fictional data, not a
deployment, authenticated session, or live partner acceptance test.

The supplied UX v2.0 document has now been read completely and all four rendered
pages inspected. Available browser checks are complete for this pass, with the
manual gates below still open. The frontend phases are implemented; remaining
manual, live-integration, and deferred admin requirements are tracked in
[UX_SPEC_RECONCILIATION.md](./UX_SPEC_RECONCILIATION.md). A passing preview check
does not establish production functionality or full accessibility conformance.

### Links, Profile & Documents phase (276-test revision)

L1–L3, R1–R3, and S1 were implemented in that preview revision. It passed 276
tests across 13 files, warning-free lint, formatting, TypeScript, and build.
Its 48 route/size checks, 40 data-state checks, 36 dialog checks, focus/long-content
checks, 13 rendered text-color samples, and independently decoded browser QR are
recorded in [PARTNER_MANAGEMENT_UI_QA.md](./PARTNER_MANAGEMENT_UI_QA.md).

QR and metadata export handlers produced local preview feedback, not evidence
of native saved/opened files. In-app normal Tab still did not advance focus;
observed dialog wrapping/Escape and explicit focus recovery are narrower proof.
The manual/live gates below remain open.

### Payout phase (197-test revision)

Y1–Y5 payout transparency is implemented in the preview. That revision
passed 197 tests, warning-free lint, formatting, TypeScript, and production build.
Its 54 responsive route/state/dialog cases, focus/contrast checks, ten rendered
sample PDF pages, and observed PDF download are detailed in
[PAYOUT_UI_QA.md](./PAYOUT_UI_QA.md). Native CSV/file-open and full native Tab
traversal remain gates; no real payment, report delivery, or backend was used.

### Reporting phase (151-test revision)

G2–G4 and P1–P5 are implemented in the preview. That revision passed
151 tests, lint, formatting, TypeScript, and production build. Its 24 core
route/size checks, five Performance-state checks, new chart/date/filter
interactions, 19 mobile sort-header focus checks, and six rendered contrast
samples are detailed in [REPORTING_UI_QA.md](./REPORTING_UI_QA.md).

Full native Tab traversal of the new controls and an actual CSV downloaded-file
check remain open: Chrome was unavailable, the in-app Tab command did not
advance native focus, and its download event timed out. Do not extend the earlier
native Chrome evidence below to the new reporting controls.

### Earlier UX review — directly observed (102-test revision)

| Coverage                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four core pages, sample data               | Measured at 320 × 700, 768 × 1024, 844 × 390, 1100 × 500, and 1280 × 720. All 20 route/viewport cases had page width equal to viewport width. Wide data tables remained inside their scroll regions.                                                                                                                                                                                                  |
| Four core pages, empty/loading/unavailable | All 12 cases checked at 320 × 700 without page overflow. No metric cards masqueraded as zero when loading/unavailable. Empty Links disables creation because no product/funnel exists; empty Payouts has no active cycle. Retry restored the profile preview.                                                                                                                                         |
| Profile subsections                        | Payment, Documents, and Security checked at 320 × 700. All fit the page.                                                                                                                                                                                                                                                                                                                              |
| Auth routes                                | Sign-in, recovery, and missing-reset layouts checked at 320 × 700, 768 × 1024, and 844 × 390. All nine cases fit the page. At 390 × 844, a fresh sign-in load left the body active and scroll position zero.                                                                                                                                                                                          |
| Native keyboard                            | Chrome traversed the enabled main/toolbar controls on all four core pages at 320 × 700. Table action buttons scrolled horizontally into view. The Profile tab issue described below was fixed and retested. All ten sign-in tab stops were individually visible at 390 × 844 with 3px focus outlines. Enter submitted fictional example details and focused the explicit preview-only result heading. |
| Short landscape                            | Performance controls and the seven filter-dialog controls traversed at 844 × 390. The dialog trapped/wrapped focus and Escape restored Filters. Large table regions may exceed the available vertical space; their individual action controls remained reachable.                                                                                                                                     |
| Mobile navigation                          | At 390 × 600, the five dialog controls trapped/wrapped focus. Enter on Payouts closed navigation and focused the destination main content.                                                                                                                                                                                                                                                            |
| Dialog resize/history                      | Opened the desktop Partner guide at 1100 × 500, resized to 390 × 600, then pressed Escape: focus fell back to main content because the desktop opener was hidden. Browser Back closed a document modal and focused main content.                                                                                                                                                                      |
| Link dialog/form                           | At 390 × 600, reverse/forward wrap revealed the last action and Close inside the scrolling dialog. Empty-name/Sub ID submissions focused their associated custom errors. Copy/pause feedback remained inside the open modal; closing restored the row action.                                                                                                                                         |
| Partial attribution                        | Expanded metrics showed Confirmed installs and App activations as “—”, alongside available metrics. Missing attribution was not replaced with zero.                                                                                                                                                                                                                                                   |
| Rendered sizes/colors                      | No rendered button, text input, or select below 24px in either dimension was found in the 44 route/viewport checks. Seventeen targeted rendered color pairs passed their text/control thresholds; this is not exhaustive conformance testing.                                                                                                                                                         |
| Visual/console                             | Inspected final desktop Performance/Payouts/Links/Profile and mobile sign-in screenshots. Read the Chrome warning/error log after the interaction pass: no entries.                                                                                                                                                                                                                                   |

The in-app browser reliably supported layout measurements and the observed
modal focus-loop/Escape checks, but its Tab command did not advance native
focus outside dialogs. Repeated identical focus results were explicitly
discarded. Native traversal assertions above come from Chrome, not from those
in-app commands or jsdom.

#### Defects repaired in this pass

- **Scrollable modal focus:** Radix's wrap behavior could focus an offscreen
  action without scrolling the dialog. The dialog now reveals focused controls
  inside its own scroll area without moving the background page. At 390 × 600,
  the final action was visible at y517.78–559.78 and Close at y40–84, inside the
  y24–576 dialog.
- **Long content:** An 80-character link name and 64-character Sub ID previously
  expanded the dialog to 1466px and pushed Close offscreen. At 320px, the repaired
  dialog's client/scroll widths both measured 288px. A saved 100-character public
  partner name now wraps inside a 240px identity area; page width remains 320px.
- **Profile tab focus:** Native Tab could leave Payout preferences partially
  clipped in the horizontal navigation. Focus now reveals the whole tab and
  its ring. All four tab targets fit after the 320px retest.
- **Form errors:** Empty required link/profile values now use the same associated,
  focused custom errors as invalid nonempty values; native validation no longer
  bypasses the UI's error handling.
- **Toast/modal feedback:** Tablet notifications no longer overlap the preview
  bar (16px gap measured at 820 × 600). Link-modal feedback is inline. Global
  toast visuals/dismiss controls are hidden while a modal is open, while their
  live region remains available. Clipboard fallback is part of the new dialog's
  accessible description; stale clipboard completions cannot update a different
  link dialog or reopen one after it was dismissed.
- **Document/history semantics:** Document actions have distinct accessible
  names. Changing Profile sections closes transient document/verification panels
  without discarding an unsaved profile draft.
- **Contrast and security copy:** Darkened muted text, auth footer/placeholders,
  input boundaries, light-surface focus indicators, and the unchecked switch
  thumb boundary. Verification text explicitly requires password **and** 2FA.

#### Rendered contrast samples

Computed foreground/background colors were read from the actual rendered DOM;
ratios were calculated using relative luminance, not sampled antialiased pixels.
Threshold comparisons used unrounded values; the table displays rounded ratios.

| Actual surface                       | Foreground / background | Ratio  |
| ------------------------------------ | ----------------------- | ------ |
| Canvas eyebrow / auth footer         | `#5c6b55` / `#f6f7f4`   | 5.29:1 |
| Featured metric footnote             | `#5c6b55` / `#edf4df`   | 5.04:1 |
| White-card helper / auth placeholder | `#5c6b55` / `#ffffff`   | 5.69:1 |
| Preliminary badge                    | `#5c6b55` / `#f2f2e9`   | 5.06:1 |
| Awaiting-signature badge             | `#5c6b55` / `#faf2dd`   | 5.10:1 |
| Signed badge                         | `#37734b` / `#e9f4e8`   | 5.00:1 |
| Auth email hint                      | `#65725d` / `#f6f7f4`   | 4.74:1 |
| Input boundary                       | `#7a896f` / `#ffffff`   | 3.73:1 |
| Focused input ring                   | `#628b33` / `#ffffff`   | 3.99:1 |
| Unchecked thumb boundary / track     | `#5c6b55` / `#dce4d1`   | 4.35:1 |
| Checked thumb / track                | `#ffffff` / `#76974f`   | 3.33:1 |

The review uses 4.5:1 for normal text and 3:1 for relevant non-text indicators,
following [W3C text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
and [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).
The responsive/focus checks were informed by
[Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html),
[Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html),
and [Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
Decorative separators are not treated as required control boundaries, and
disabled controls are not reported as active-control contrast failures.

This is a targeted review, **not a WCAG certification**. The blue status badge,
for example, has a source-level color guard but no currently reachable fixture
state in this browser pass.

#### Earlier pass — retained evidence

| Surface                                    | Check and result                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop preview                            | Inspected Performance and the new auth layout at 1280 × 720 in the in-app browser. The approved green/lime visual system is retained.                                                                                                                            |
| 320 × 700 routes                           | Root width matched the viewport on Performance, Links, Profile, Payment, Documents, sign-in, recovery, and missing-reset states. Payouts initially overflowed; after the fix its page width was 320px and its 724px table remained inside a 282px scroll region. |
| Narrow preview toolbar and profile actions | The toolbar controls initially overflowed; Save/Discard extended beyond the viewport. After wrapping fixes the controls and buttons fit inside the 320px page.                                                                                                   |
| Auth at 390 × 844                          | Inspected the sign-in screenshot after removing unintended initial focus/scroll. Header remained visible at scroll position zero; no input was automatically focused.                                                                                            |
| Native Chrome keyboard                     | Tab moved from email to password and then to the visibility button. Space toggled visibility; the button had a visible 3px focus outline. Enter activated recovery navigation and submitted the preview forms.                                                   |
| Recovery result focus                      | Enter on a valid fictional email showed the explicit no-email-sent result and focused its heading.                                                                                                                                                               |
| Reset validation                           | Expired reset state exposed no submit button. A usable-example password mismatch focused the confirmation field, with `aria-invalid` and its error description connected. The field was within the viewport.                                                     |
| Profile keyboard scroll reveal             | Eight consecutive Tab stops through profile fields/preferences and Discard/Save remained above the fixed toolbar in the mobile check.                                                                                                                            |

The earlier native-keyboard assertions were also performed in Chrome.

#### Corrections made

- Wrapped the preview toolbar and Save/Discard actions on narrow screens.
- Contained the payout table's offscreen accessible label inside its horizontal
  scroll region, removing page-level horizontal overflow.
- Used the measured toolbar height for content spacing and focus scroll
  padding, including wrapped toolbar layouts.
- Kept header controls at usable mobile sizes and shortened the narrow
  breadcrumb without removing page context.
- Associated profile/link validation messages with fields and focused the
  first invalid field; added corresponding regression assertions.
- Removed unintended initial route autofocus/scroll while preserving deliberate
  focus on route changes, form errors, and result headings.
- Fixed shared-style precedence that made the auth wordmark white on the light
  canvas. A final desktop screenshot confirmed its dark foreground and a
  1280px page width matching the viewport.
- Restored focus on auth retry and closed stale global dialogs during auth
  history navigation.
- Added a tested fallback to main content when a dialog's opener has become
  hidden or disconnected. The actual desktop-to-mobile scenario was verified
  in the August 26 pass above.

#### Earlier automated companion checks (102-test revision)

`pnpm format:check` and `pnpm validate`: formatting, lint, 102 Vitest tests,
TypeScript, and production build. Eleven axe checks run in jsdom with color
contrast disabled; they cover semantic structure, not rendered accessibility
conformance. Auth tests assert no fetch/storage writes, no simulated session,
fictional email validation, input clearing, reset-state gating, and keyboard
and focus behavior.

During the earlier 75-test pass, one full-suite run hit the default 5-second
timeout in two pre-existing multi-step dashboard tests (filter reset and
sample-link creation/pause). Both passed in a focused rerun. That full 102-test
suite passed, including 11 new interaction regressions and 16 source-color
guards. That result is recorded in
[UI_IMPLEMENTATION.md](./UI_IMPLEMENTATION.md).

## Remaining manual / live gates

- Actual 200%/400% browser zoom. The supported native shortcut did not change
  the CSS viewport/device-pixel ratio, so it was not counted as zoom evidence.
  The 320px reflow check is separate, verified evidence.
- Reduced-motion behavior under a real user preference and actual screen-reader
  announcements. Source disables animation/transitions/smooth scrolling for
  reduced motion and disables chart animation, but OS settings and VoiceOver
  were not changed. ARIA/axe results do not establish spoken announcement quality.
- Safari/iOS/Android, physical-device soft keyboards, password-manager behavior,
  and the complete authenticated non-empty Partner journey.
- Full logout/session-expiry persistence and recipient-delivery QA beyond the
  completed first-user recovery/activation path.
- Full native traversal of newly implemented reporting/payout/management controls,
  actual CSV/QR downloaded-file opening, and physical QR scanning. Refer to each
  phase's QA record rather than extending earlier Chrome/PDF evidence to new UI.

The historical August 26 preview pass started no Supabase runtime and made no
external writes. The August 28 Admin pass used the real project, applied the
versioned Admin migration, and provisioned the existing QA user as Operations;
it deliberately created no product or funnel.
