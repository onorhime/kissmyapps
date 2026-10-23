# Partner agreement signing hotfix — 2026-09-05

Status: **deployed with user approval** to the existing Hostinger dashboard on
2026-09-05. Release `20260905T101452Z-signature-hotfix-e3f53025155b` is healthy.
See [production release evidence](RELEASE_EVIDENCE_2026-09-05_SIGNATURE_HOTFIX.md).
No pending checkout migration or Vercel funnel deployment was included.

## Production diagnosis (read-only)

- BC Learn product: `fdbabb87-9743-4521-bc8d-11804fe1185f`.
- Agreement: `5bad6208-1d10-4db1-86bf-464c886e6569`, version 1.
- Document: `3b68c176-41ff-4c6d-bc19-7caa8e6fb30d`.
- Partner signature was already committed as Victory Onorhime at
  `2026-09-05T09:53:18.968681Z`. Status is `awaiting_kissmyapps_signature`;
  company signature is null. Final readback confirmed the same timestamps/state.
- The live signing RPC returns `to_jsonb(stored)` from `public.documents`.
  The frontend incorrectly used the document-directory mapper, which requires
  the view-only `download_available` boolean (absent from the RPC response).
  The view also aliases `signed_by_partner_at` to `partner_signed_at` and
  `signed_by_kissmyapps_at` to `company_signed_at`. This caused a committed
  successful write to show an invalid-response error. Retrying correctly hit
  the database's already-signed guard.

## Repair

- Separate typed signature-receipt mapper validates the raw RPC evidence,
  timestamp/status, requested document ID and legal name. Empty/malformed or
  mismatched receipts cannot be treated as success. The normal directory mapper
  remains strict and unchanged.
- UI verifies the returned agreement/version, uses the recorded signer name,
  closes review on success and removes the completed item from its queue.
- On rejected/lost/invalid responses, read the partner-safe document directory
  before another signature attempt. Confirmed signatures resolve the stale
  modal; both-party signatures have distinct copy. Recovery never attributes a
  directory-only signature to the currently entered person's name.
- Uncertain/missing/changed evidence offers a read-only Check signature status
  action instead of blindly re-signing. Status reads time out after 15 seconds.
  Repeated-click guard and busy-state input locking prevent duplicate requests.
- Scoped dark-brand overrides: white document values, blue PDF/retry links,
  pink action with dark text, dark input, larger helper labels and aligned checkbox.
  Color-token contrast checks enforce at least 4.5:1 for the relevant text pairs.

## Verification boundary

- Full frontend suite: 642 tests / 47 files passed before the final read-timeout
  test and test-fixture typing corrections. Initial build caught those test-only
  typing errors; corrected before the final validation below.
- Final focused gateway/modal/style suite: 63 tests passed, including raw-row
  responses, missing evidence, lost response after commit, stale second attempt,
  countersigned recovery, uncertain-read retry, double click and status timeout.
- Final TypeScript and Vite production build passed; lint and diff checks passed.
  Existing jsdom canvas notices / large bundle warning remain non-blocking.
- No signed-in browser, mobile or screen-reader verification is claimed.
- No signature RPC was invoked, no PDF was modified or re-uploaded, and no
  database/Storage/auth/email/financial state was written during this fix.
- Existing unrelated dirty work and the separate Vercel projects were preserved.
- Release-turn full frontend rerun: **643 tests / 47 files passed**. The runtime
  sources were unchanged since the validated production build. Both live domains
  served all 33 packaged files with exact SHA-256 matches after activation.
- Production browser check reached the authenticated partner workspace and the
  separate Admin sign-in page. The partner had no active product, so no new
  signing modal or signature submission was exercised in production.

## Release and next workflow

The approved dashboard-only release was activated with the previous pointer
verified under the release lock. Only `kissmyapps-dashboard` was recreated;
the shared edge proxy and other containers were unchanged. Both domains now
serve the corrected build. Existing tabs need a refresh.

The existing partner signature does not need repeating. The user's next action
is Admin → BC Learn → Agreements → countersign, then activate the agreement.
Stripe's verified US$1/month offer, restricted 100%-off forever promotion,
backend webhook/worker configuration and approved $0 acceptance remain later work.
