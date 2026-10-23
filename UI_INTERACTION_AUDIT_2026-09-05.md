# Admin and Partner interaction audit — 5 September 2026

## Implementation follow-up

The findings below preserve the original audit evidence. The approved UI remediation is now implemented and **deployed as a frontend-only production release**. See [implementation and verification record](</Users/nobrainer/A1 Global/React/affiliate dashboard/UI_INTERACTION_FIXES_2026-09-05.md>) for changed behavior, tests, and remaining acceptance checks, and [release evidence](./RELEASE_EVIDENCE_2026-09-05_UI_INTERACTIONS.md) for deployment identity and rollback. The six original characterization cases now assert corrected behavior; their old audit results are historical.

## Outcome and verification boundary

The reported activation/scroll problem is reproduced. This is not a browser page reload: Product Configuration replaces its entire working area with a loading state after every successful mutation. The browser then loses the tall page, the focused control, expanded sections, and other sections' unsaved inputs.

**Original audit boundary: no application fixes or production deployment at that point.** Added a synthetic local fixture and characterization tests. No live records, offers, signatures, routing, emails, Stripe settings, coupons, keys, or checkout sessions were changed. The previous security/backend audit and its repair records remain separate and unchanged. Payment testing is paused, not completed by this audit.

Evidence:

- Read the current Admin route tree, mutation hooks, configuration sections, shared dialog, and live Partner components. Source review covers all currently implemented Admin areas and all four live Partner pages; it is not a claim that every action was executed in production.
- Browser-tested the actual Product Configuration component with a local, network-free gateway at desktop 1280×720 and mobile 390×844. These are browser viewport checks, not physical-device tests.
- Existing frontend suite before additions: **48 files / 677 tests passed**. Final full run with the six new characterization tests: **50 files / 683 tests passed**. The six new tests' passing assertions reproduce defects; they do **not** mean the defects are fixed. The audit fixture/tests pass focused formatting, lint, and TypeScript checks.
- No authenticated production mutation or screen-reader session was performed. Color/contrast and unrelated checkout correctness are not certified by this interaction audit. Existing axe tests disable contrast checks, and jsdom does not implement layout.

## Prioritized findings

### UI-01 — High: saving one section destroys other unsaved work

**Confirmed by source, automated reproduction, and browser.** `ProductConfigurationPage.runAction` calls `reload()` after success. `useProductConfiguration.reload` sets configuration to null/loading. The page's ready-only conditional removes Funnels, Sources, Billing, Agreements, Launch, Tracking Mode, and Danger Zone together. Their local form/disclosure state is recreated from defaults.

Reproduction: type an unsaved Funnel name, expand Billing, and confirm activation of the synthetic offer. The original input is disconnected from the DOM; focus becomes `BODY`; the page shrinks to the viewport and scrolls to 0. After the read completes, the name is empty and Billing is collapsed. This affects all mutations using that runner, including Price verification, not just activation.

Sources: [runner and section rendering](</Users/nobrainer/A1 Global/React/affiliate dashboard/src/features/admin/configuration/ProductConfigurationPage.tsx:248>), [reload hook](</Users/nobrainer/A1 Global/React/affiliate dashboard/src/features/admin/configuration/useProductConfiguration.ts:129>).

Fix: keep same-product content mounted during background reconciliation; update returned records in place where supported. Preserve other drafts, open sections, selection, and focus. Clear only the form successfully submitted. Do not simply save/restore `scrollY` around an unmount; that would still lose drafts. A different product/account, logout, or revoked access must still clear private state immediately.

### UI-02 — Medium: review and edit actions can reveal content outside the viewport

**Confirmed by source, automated reproduction, and browser.** Billing activation/pause/archive confirmation is appended after the full two-column form/list grid as a `role="group"`; focus remains on the review button. It has neither modal focus behavior nor an announcement/reveal mechanism.

Desktop measurement: Review activation was visible at y=328–372, while the confirmation began at y=776.5, below the 720px viewport. The mobile single-column confirmation was visible in this fixture, but **Edit draft** then populated an input at y=−513 to −469 while focus stayed on the edit button. An edit can therefore look unresponsive too.

Source: [Billing offer review/edit handlers and confirmation](</Users/nobrainer/A1 Global/React/affiliate dashboard/src/features/admin/configuration/BillingOffersSection.tsx:375>).

Related inventory: Launch confirmations, agreement revoke/delete groups, product deletion, and tracking-mode approvals use differing inline patterns. Some are adjacent, and Tracking Mode/Settings already attempt focus handling; they should not all be described as the same off-screen bug. They do need a consistent review contract.

Fix: reuse the existing shared `Dialog` for consequential reviews, with record name, proposed change, appropriate warning, explicit confirm/cancel, contained keyboard focus, and focus restoration. For editing, use a dialog or intentionally reveal/focus the actual edit form. Preserve server approval, Owner, signing, and deletion gates.

### UI-03 — Medium: a successful save followed by a failed refresh wipes the workspace

**Confirmed by source and automated reproduction.** The mutation succeeds, then the configuration read fails. The page displays both “offer is now active” and “Configuration could not be loaded,” with all forms gone. Failure of the affiliates or sources lookup also removes the entire configuration even if its own read succeeded.

Fix: separate mutation outcome from refresh outcome. Keep authorized same-scope content and drafts on transient read failure, mark stale server data, and offer **Retry refresh**, not a repeated write. Authorization/not-found failures still fail closed. Disable actions that require fresh evidence while the relevant data is stale; do not display stale readiness as newly verified.

### UI-04 — Medium: enabled buttons can silently ignore clicks during another save

**Confirmed by source and automated reproduction.** The runner rejects any action when *any* `pendingKey` is present, but sections usually derive `busy` from their own prefix. During a pending Billing action, “Create draft funnel” is enabled. A valid click never reaches the gateway and shows no error or explanation.

Sources: runner at `ProductConfigurationPage.tsx:253`; section busy state at `BillingOffersSection.tsx:94`, `FunnelSection.tsx:30`, `CampaignSourcesSection.tsx:39`, `AgreementSection.tsx:115`, and `LaunchSection.tsx:63`.

Fix: make the locking policy match the UI. Either block conflicting actions consistently with a visible pending explanation or deliberately implement safe per-resource operations. Preserve idempotency and server conflict checks. Guard in-flight submissions synchronously; do not enable destructive concurrency just to avoid a disabled button.

### UI-05 — Medium: validation in long forms does not reliably lead users to the error

**Confirmed by source and automated reproduction.** An empty Billing submit marks inputs invalid but leaves focus on the bottom submit button. There is no error summary/live alert. Errors near the top can be out of view. Funnel and source/campaign validation use similar set-errors-and-return patterns.

Source: `BillingOffersSection.tsx:106–113`. By contrast, product creation and live Partner link creation already attempt first-invalid-field focus.

Fix: shared validation behavior: preserve values, associate messages with inputs, focus/reveal the first invalid field, and announce a concise error summary when needed. A toast alone is not sufficient for field errors. Do not announce success until the server confirms it.

### UI-06 — Medium: Affiliate actions reload the directory and reset the surrounding context

**Source-confirmed; not exercised against real affiliates.** Successful status changes increment directory/detail refresh scopes. Scope mismatches return loading states with null data. The page closes the affiliate detail after success. Opening/closing a detail changes Admin routes, and the shared route effect explicitly scrolls to top for any changed route.

Sources: `affiliates/useAffiliateDirectory.ts:196–216,253–274`; `AffiliatesPage.tsx:540–563`; `AdminPortalApp.tsx:203–209`.

Fix: preserve same-query rows while reconciling, keep filters/pagination, and restore the user's place when closing an overlay detail. Define whether an updated detail remains open or closes intentionally. New filters/product scopes must not be mistaken for refreshes of the same data. Affiliate mutation dialogs already use the shared dialog and should retain their reason/confirmation checks.

### UI-07 — Medium: Partner link “Cancel” hides a write that is still running

**Confirmed by source and automated reproduction.** During `create-link`, only the submit button is disabled. Inputs and Cancel remain enabled. Cancel hides the form but does not cancel the gateway request. A subsequent failure is rendered only inside the now-hidden form, so the user sees no failure. Edits made during the request can also be discarded when success resets the draft.

Source: [live link form](</Users/nobrainer/A1 Global/React/affiliate dashboard/src/features/partner/live/LiveLinksPage.tsx:283>).

Fix: freeze submitted fields and prevent a misleading Cancel during the write, or explicitly label safe dismissal and keep the pending outcome visible outside the form. Do not claim the server write was cancelled without a cancellation protocol. Preserve the draft on failure and use the shared success/error feedback layer.

### UI-08 — Medium: feedback is scattered through page flow instead of reliably visible

**Source-confirmed; desktop off-screen confirmation context browser-verified.** Product Configuration and Affiliate success messages are above their long content; Settings feedback is below its controls; Partner link copy/create notices are above link history. No shared floating toast host exists. Repeating the same message can also fail to create a new announcement if only the same state string is assigned.

Sources: `ProductConfigurationPage.tsx:316`; `AffiliatesPage.tsx:619`; `PlatformSettingsPage.tsx:632`; `LiveLinksPage.tsx:472`; `AdminPortal.css:1110`.

Fix: a common top-right desktop notification host, safe-area-aware mobile layout, unique message IDs, and scoped outcomes. Success may dismiss after about six seconds with pause-on-hover/focus; actionable errors remain until dismissed/resolved and also remain near invalid fields. Use non-focus-stealing status announcements, avoid duplicate nested live regions, and do not cover modal controls or the mobile navigation.

### UI-09 — Medium: a Partner signature does not invalidate the Documents snapshot

**Source-confirmed; no new live agreement was signed.** `AgreementSignBanner.finishReview` updates its local queue and success message only. The banner receives a gateway, not a completion callback. `LiveDocumentsPage` reads the separate workspace snapshot. A newly recorded signature can therefore leave document status stale until workspace refresh/remount.

Sources: `AgreementSignBanner.tsx:139–148`; `LivePartnerPortal.tsx:243–246`; `LiveDocumentsPage.tsx:241–252`.

Fix: after a confirmed or safely reconciled signature, invalidate/update the partner-safe document resource in place. Preserve the banner's uncertain-outcome reconciliation, signed evidence, and legal confirmation. Avoid treating a lost response as permission to repeat a signature.

## Coverage by currently available surface

| Surface | Audit result / change needed |
| --- | --- |
| Admin Overview | Read-only summaries/navigation. No save flow to execute. Keep route navigation distinct from background refresh. |
| Admin Products | Creation already merges the returned product without replacing the page. Reuse this approach; unify feedback and invalid-field visibility. |
| Product Configuration: Funnels | Create/edit/live/pause/archive inherit UI-01/03/04; validation needs UI-05. |
| Sources & Campaigns | Create sources/campaigns and lifecycle controls inherit the same runner issues; preserve both forms' drafts. |
| Billing Offers | Create/edit/verify/activate/pause/archive: highest-priority desktop/mobile reproduction, UI-01–05/08. |
| Agreements & Rules | Creation, rule lifecycle, upload/signing request, countersign, revoke, activation, and draft deletion inherit runner refresh. Standardize reviews without weakening evidence controls. |
| Launch / Tracking Mode / Danger Zone | Product activation, link issuance, Owner mode changes, and slug-confirmed deletion must retain explicit approval, pending guards, and logical focus after any removed trigger. |
| Admin Affiliates | UI-06/08; retain existing lifecycle dialogs, reason checks, and terminated-access rules. |
| Admin Funnels & Links | Read-only aggregate. Same-scope refresh already preserves rows while pending; retain partial/error labeling. No missing editing workflow was invented. |
| Admin Attribution | Read-only reports/filters. Same-scope refresh preserves content while pending; transient refresh failure handling should distinguish stale data from first-load failure. |
| Admin Data Health | Main data hook preserves content during refresh; Agreement emails & file cleanup subpanel swaps its metrics for a loading message. Keep the subpanel geometry stable too. No repair jobs were run. |
| Admin Settings | Save already replaces the returned settings in place and has request-version safeguards. Unify visible feedback/reviews; preserve conflict and Owner gates. |
| Admin Subscriptions / Payouts / Documents | Still marked Upcoming in the inspected route tree. Not falsely counted as audited working modules. |
| Partner Performance / Payouts | Current live pages are reports, not editable preview screens. Workspace refresh retains the current snapshot during reads; no payout release action was executed. |
| Partner Links & Sources | Creates/updates merge resources in the provider; no generic full reload on save. UI-07/08 remain. Actual live link editing/status controls are not exposed by this page. |
| Partner Profile & Documents / signing | Live profile is read-only here; documents have filters, detail dialogs, private PDF preparation, and refresh. Keep existing safe dialog/private-link behavior; address UI-09 and feedback consistency. |

The preview-only Profile/Link editing screens are not evidence of what ships to authenticated partners. Account switching, auth recovery, payment authorization, payout execution, and physical-device/screen-reader acceptance remain outside this audit's executed flows.

## Proposed fix order and acceptance gate

1. Shared notification host and action-feedback contract; reuse the shared Radix `Dialog`, which already supports focus return and keeping focused controls visible.
2. Product Configuration same-scope reconciliation, draft preservation, honest pending locks, refresh-error separation. Then billing review/edit dialogs and validation visibility.
3. Apply the interaction contract to remaining Admin forms/actions, including Affiliate overlays and the Data Health subpanel. Add unsaved-navigation protection; do not persist sensitive legal data to browser storage by default.
4. Partner pending/cancel behavior, copy/create feedback, and post-signature document invalidation.
5. Run the acceptance matrix below locally; review the fix, then separately approve/deploy and verify the real account without triggering unapproved commercial or legal actions.

Acceptance checks for each implemented action family:

- Save near the bottom: same section stays open and visible; unrelated draft DOM nodes and values survive; only submitted fields reset.
- Slow response, rapid double click, conflicting second action, server rejection, and successful write + failed read: no silent ignored controls, misleading cancellation, duplicate write, hidden failure, or false success.
- Initial loading may use a skeleton. Same-scope background refresh does not remove usable content. Changed identity/product or lost authorization never retains the wrong private data.
- Review opens visibly on desktop/mobile and at zoom; keyboard focus enters the dialog, stays contained, and returns logically. Escape/cancel and pending dismissal policies are explicit. No accidental submit when cancelling.
- Edit reveals the actual fields. Invalid submit reveals/announces the first error, preserves values, and never requires searching the whole page.
- Success toast is visible without stealing focus; errors remain actionable; repeated identical outcomes announce separately. Reduced motion, narrow safe areas, long messages, and dialog stacking are checked.
- Affiliate close preserves list context; Partner signature refreshes Documents without a page reload; returning after intentional navigation has a deliberate draft policy.

These recommendations align with [W3C modal dialog guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [form notification guidance](https://www.w3.org/WAI/tutorials/forms/notifications/), and [status-message guidance](https://www.w3.org/WAI/WCAG21/Understanding/status-messages). This audit is not a WCAG conformance certification.
