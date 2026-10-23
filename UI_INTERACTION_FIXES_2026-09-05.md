# UI interaction fixes — 5 September 2026

## Delivery boundary

Implemented and subsequently deployed with approval as a **frontend-only production release**. See [deployment evidence and rollback reference](./RELEASE_EVIDENCE_2026-09-05_UI_INTERACTIONS.md). **No production database, Stripe, Supabase configuration, email, legal signature, or checkout mutation was performed.** Existing unrelated/backend work is preserved. This record supplements the original UI audit; it does not replace the broader backend/payment audit or claim the payment funnel is complete.

## Changes against the audit

| Finding | Implemented behavior |
| --- | --- |
| UI-01 | Product Configuration keeps the same authorized product's working area mounted during reconciliation. Unrelated drafts and disclosure state survive, with a stable refresh-status slot. Identity/product changes and revoked authorization clear private state. |
| UI-02 | Billing lifecycle, product activation, main-link issuance, tracking mode, agreement/rule revoke/delete/supersede, and product deletion reviews use the shared focused modal. Record identity, approval warnings, explicit confirmation, pending locks, and server gates remain. Billing Edit intentionally focuses/reveals its form and preserves the separate create draft on cancel/save. |
| UI-03 | A transient post-save read failure preserves drafts and labels the displayed snapshot stale. Retry refresh performs a read only. Actions requiring current configuration are disabled; authorization/not-found failures still fail closed. |
| UI-04 | Configuration controls share the actual pending lock, with synchronous duplicate-write protection. Reviews cannot be dismissed during writes. Product creation and Partner link creation also have synchronous submission guards. |
| UI-05 | Invalid submits reveal/focus the first field with its associated inline error. Successful saves do not scroll to unrelated errors or steal focus. |
| UI-06 | Affiliate directory/detail same-query refresh keeps rows mounted. Filters/pagination survive; opening/closing the detail overlay no longer intentionally scrolls the whole route to the top. Focus returns to the triggering row or a logical fallback. |
| UI-07 | Partner link creation freezes its submitted fields and Cancel while pending. Failures keep the draft and show an error; success merges through the existing provider. |
| UI-08 | Shared top-right floating notifications cover current Admin mutation surfaces and live Partner link/signature outcomes. Success auto-dismisses after six seconds with hover/focus pause; errors stay until dismissed. Regions announce without stealing focus; notices do not cover open modals, whose errors remain inside the review. Pink Admin action buttons use dark, readable text. Data Health's agreement-operations metrics also stay mounted during refresh. |
| UI-09 | A confirmed or safely reconciled partner signature refreshes the live workspace/Documents snapshot. The existing uncertain-outcome reconciliation remains intact; lost responses do not trigger another signature automatically. |

Dashboard navigation buttons, workspace switches, sign-out, and Partner product selection now ask before discarding tracked form changes. Full reload/close uses the browser's unsaved-change warning. Pending writes block these in-app departures with an explanation. Draft values are held only in memory, not browser storage. Browser history Back/Forward hash transitions are not intercepted by this lightweight guard and remain a follow-up; do not treat it as durable draft autosave.

## Verification

- Final full frontend suite: **52 files / 693 tests passed**, including audit, notification, navigation, and signature regressions against mocked gateways. One pre-existing password-recovery test now waits for its passive focus effect instead of assuming DOM insertion implies focus; authentication implementation was not changed.
- Application TypeScript build, focused fixture TypeScript, repository lint, and formatting of changed UI files checked.
- Production bundle builds locally. Vite still reports the existing large dashboard-chunk warning; this change does not claim bundle-splitting work.
- Desktop browser, 1280×720: review modal fully within viewport; focus enters its body. Pink confirmation background `rgb(255,128,191)` with `rgb(17,17,17)` text. A synthetic save retained `scrollY=887.5`, document height `3181`, the unrelated funnel input, and expanded Billing. Post-save focus moved to the offer heading when the opener became disabled. Success toast appeared at top `20px`, right `1260px`, within the viewport.
- Mobile viewport, 390×844: activation review bounds left `16`, right `374`, top `292.4`, bottom `551.6`; focus contained, no horizontal overflow. Cancel worked. Desktop Edit revealed the actual field at y `269.5–313.5`; Cancel restored the separate create draft and opener focus.
- Mobile save notification: bounds left `16`, right `374`, top `82`, bottom `158`, below the mobile header; no horizontal overflow. Notifications are hidden while the Admin mobile menu or any modal is open.
- No physical-device, browser-zoom, real screen-reader, or authenticated production mutation acceptance was performed. Existing jsdom canvas notices are test-environment limitations; the passing suite is not a full accessibility conformance certification.

## Next gate

Production frontend deployment is complete. Authenticated read-only Admin review/cancel and edit/cancel checks passed; Partner Documents loaded and retained its card during refresh. A user-initiated safe draft save, live notification/scroll behavior, failed validation, and post-signature Documents refresh remain acceptance checks; no commercial/legal writes were submitted to test them during deployment. Commercial activation, discounts, backend bindings, and end-to-end Stripe testing remain separate explicit actions.
