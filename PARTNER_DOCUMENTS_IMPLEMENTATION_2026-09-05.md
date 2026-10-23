# Live partner documents — 5 September 2026

Status: **deployed and verified in production** after the user's “proceed”.
Production release: `20260905T122944Z-documents-a2b64ae43896`.
Only the dashboard assets and download-resolver migration below were published.
See `RELEASE_EVIDENCE_2026-09-05_PARTNER_DOCUMENTS.md` for deployment and rollback.

## Outcome

- Profile & Documents has its own document-specific loading, unavailable,
  empty, and ready states. It is not gated by product launch, a live funnel,
  verified traffic, billing, payouts, or reporting availability.
- The loader reads all authorized account documents rather than filtering
  them to the product selected for reporting. Historical/unlaunched product
  documents therefore remain discoverable.
- The account page no longer shows a misleading product-scoped “No agreement
  configured” strip. It shows the available real profile identity instead.
- Document cards show version, lifecycle status, product name when available,
  and both recorded signature dates. Status filtering and historical-version
  links are supported. Missing dates are not invented.
- The detail dialog shows creation/effective/expiry/termination metadata,
  linked revisions and signature dates in the partner timezone (UTC fallback).
  Copy distinguishes the uploaded terms PDF from the separately recorded
  signature evidence; it does not promise a digitally stamped PDF.
- Scoped dark styles use readable white/muted text, pink status/actions, blue
  signature icons and 44px-or-larger controls, with a single-column mobile view.

## Private PDF access

`20260905130000_partner_document_download.sql` adds only the stable, read-only
`get_partner_document_download(uuid)` RPC. It authorizes the requested document
against `auth.uid()`, current affiliate membership and existing private Storage
policy, rejects drafts and missing objects, and verifies the recorded agreement
Storage object ID/version/eTag. There is no public-bucket change or launch gate.
Only `authenticated` receives EXECUTE; anonymous/public execution is revoked.

The browser requests an on-demand locator by document ID, then uses that same
client's authenticated Storage API to obtain a five-minute signed URL. It
validates receipt identity, bucket, path and returned URL. Object paths are not
added to the general document directory or displayed in the UI. No client
service key or newly deployed Edge Function is needed.

The user explicitly prepares a PDF link and then opens it in a new tab to read
or save. This avoids asynchronous popup blocking. UI links expire after four
minutes; requests time out after 15 seconds. Double clicks are guarded, failures
never expose raw backend details, and closed dialogs/sign-out discard late or
previously prepared URLs. Existing backend Storage rules still authorize the
actual signing request. Like other signed URLs, an already copied URL remains
a bearer capability until its backend expiry.

## Validation

- `pnpm validate` passed: formatting, lint, funnel TypeScript/lint, **677 tests /
  48 files**, TypeScript and Vite production build.
- Focused gateway/portal/signing/loader run: **82 tests passed** before the
  additional SQL-source and styling guards included in the full run.
- Tests cover no-product/no-funnel/no-activity visibility, failed reporting,
  failed versus empty document reads, retries, historical filters, private
  URL preparation, forbidden/wrong/malformed locators, unavailable files,
  unsafe URLs, expiration, stalled requests, duplicate clicks, late responses
  and sign-out. Existing signing regressions remain passing.
- Local Chrome visual checks used **synthetic fixtures with Supabase disabled**:
  desktop list/detail, 390px narrow dialog, private-link feedback, keyboard
  focus on the PDF action. At 390px, page width was 390px and dialog width 358px;
  no horizontal overflow. These are not real device/screen-reader tests.
- Read-only production check: BC Learn document
  `3b68c176-41ff-4c6d-bc19-7caa8e6fb30d` remains `signed`; its stored object
  ID/version/eTag still match the recorded PDF. No actual PDF was downloaded.
- `27_partner_document_download.sql` contains rollback-only pgTAP metadata and
  denial checks (including a non-member versus an existing document, when
  available). **Not executed against hosted Supabase yet.** SQL-source guards
  are not claimed as runtime RLS or successful authenticated download proof.
- Existing jsdom canvas and large-bundle warnings remain non-blocking.

### Production verification after approval

- The exact migration passed rollback-only runtime checks before application,
  then the same checks passed after application. They exercised real
  `authenticated` role/JWT contexts: existing member succeeds; absent claims,
  a non-member, and a null document ID are denied. Grants, stable/security-definer
  properties, Storage authorization and directory visibility were checked.
  These were bounded PL/pgSQL assertions, not a pgTAP suite run.
- Supabase now has 35 migrations, with only `20260905130000` added. Pending
  checkout migrations `20260905110000` and `20260905120000` remain unapplied.
- Both production dashboard domains served all 36 packaged files with matching
  SHA-256 hashes, healthy responses and non-cached HTML. Other containers and
  deployment configs were preserved.
- Authenticated Chrome: Victory Onorhime's account displayed the existing
  version 1 document and both recorded signatures, despite the product/funnel
  remaining drafts. Its actual uploaded filename is displayed; the draft
  product is not in the active product-name directory, so the fallback label
  is “Partner document”.
- View document → Prepare PDF link → Open PDF succeeded against real private
  Storage. Chrome rendered the six-page uploaded PDF, with its first page
  visible. It is the existing Affiliate Platform Specification PDF, not a
  newly generated/stamped agreement. No save-to-disk or legal-content audit
  was performed. The Documents tab was left available for the user.
- Before/after database fingerprints confirmed documents, agreements, products
  and funnels unchanged; billing-offer, link and Storage-object counts matched.

## Release scope and repeatable acceptance

The approved release deployed **only** the new `20260905130000` migration and
the reviewed dashboard files. Do not run an unfiltered `supabase db push`: pending
`20260905110000` and `20260905120000` belong to checkout and are out of scope.
Do not run `check-audit-migrations.mjs`; it requires an empty product catalog.
Use bounded, rollback-only verification of the exact new function and its
grants first, then the normal guarded Hostinger immutable-release workflow.
Preserve the existing demo-funnel/public assets as in the previous hotfix;
unreleased developer docs/SDK files are not part of this delivery.

Acceptance after release:

1. Sign in as the intended partner and open Profile & Documents.
2. Confirm BC Learn version 1 and both signatures are visible while the product
   and funnel remain drafts, with no traffic or billing.
3. View details, prepare the private link, open the original PDF and verify it
   matches the reviewed document. Do not sign again or fabricate legal evidence.
4. Verify another partner/anonymous user cannot resolve that document and that
   failed downloads show no stale link. Recheck backend grants and Storage RLS.

No account, agreement, signature, PDF, product/funnel status, Stripe, email,
webhook, payout or Vercel deployment was changed during implementation or release.

Developer-only fixture: `integrations/partner-documents-ui-check/`. It is not a
Vite production entrypoint or a `public/` asset. Run the dev server with
`VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY=` before using this fixture.
