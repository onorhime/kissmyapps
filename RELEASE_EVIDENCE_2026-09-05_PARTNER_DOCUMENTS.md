# Partner Documents production release — 5 September 2026

Status: **deployed; authenticated directory and private PDF opening verified**.
Authority: user's “proceed” after the scoped frontend/database deployment request.

## Release identity

- Hostinger: `root@72.60.125.99`.
- Current immutable release:
  `/srv/kissmyapps/releases/20260905T122944Z-documents-a2b64ae43896`.
- `SHA256SUMS` digest:
  `a2b64ae43896ae1a452fb268c6ed17ffa0e0b0b36e0777a63ea45845649388dc`.
- Dashboard container:
  `529e900ec4350641e180162d09ea230a17f87271a04b5ea24566bbc9618ef36e`, healthy.
- Rollback release:
  `/srv/kissmyapps/releases/20260905T101452Z-signature-hotfix-e3f53025155b`.
- Rollback manifest:
  `e3f53025155b3c8f3a7fac833523148f6672819479370e93f28bc31210d39a3b`.

The package reused the hash-verified previous production archive and overlaid
only `index.html`, `dashboard-BQ32B2AV.js`, `dashboard-DXf7NCE2.css`, and
`TrendChart-C9sThedu.js`. All 32 non-index previous files were preserved byte for
byte, including the deployed demo funnel. Retaining old hashed assets yields
36 files. Unreleased developer docs, the changed funnel SDK/demo bundle, and
developer-only UI fixtures were excluded. No Vercel deployment occurred.

Activation held `/srv/kissmyapps/.release.lock`, asserted the exact previous
pointer and config hashes, verified every extracted file, switched the symlink
atomically and recreated **only** the dashboard service with `--no-deps` and
`--pull never`. The activation script had an automatic previous-release fallback
for failed activation/health checks; it was not needed.

## Database scope and security checks

Project: `mmyruzjemjecqyivhrgr`.

Only migration `20260905130000_partner_document_download.sql` was applied and
recorded in migration history. File SHA-256:
`725527d75343890ac7649ae2296e3bb9f0cc1e3d05e278dbcb25b503cd19821a`.
Migration count increased from 34 to 35. Checkout migrations `20260905110000`
and `20260905120000` remain unapplied; no broad database push was run.

The new stable security-definer RPC `get_partner_document_download(uuid)`
returns a single authorized document locator on demand. It checks membership,
private Storage authorization, non-draft status, object existence and recorded
agreement object ID/version/eTag. It does not alter document/signature records.

Bounded rollback-only PL/pgSQL assertions ran before deployment, inside the
deployment transaction, and after deployment. They verified:

- Only the authenticated role has execution access; anonymous is excluded.
- Missing claims, non-member access to the existing document and null IDs fail.
- The existing active partner member resolves exactly their expected document.
- Existing Storage authorization and partner directory visibility agree.
- Security-definer and stable attributes are present.

These checks used actual `SET LOCAL ROLE authenticated` and local JWT claims,
not a service-role-only happy path. They are not presented as a full pgTAP run.
The new pgTAP file remains available but was not executed.

Before/after fingerprints of all documents, agreements, products and funnels
matched. Counts of billing offers, affiliate links and Storage objects matched.
No application data was inserted, changed or deleted by this release.

## HTTP and infrastructure proof

Public checks completed at 12:32 UTC on both domains:

| Domain                    | Static file hashes | Health   | HTML cache policy     |
| ------------------------- | ------------------ | -------- | --------------------- |
| `partners.kissmyapps.dev` | 36/36 matched      | `200 ok` | `no-store, max-age=0` |
| `admin.kissmyapps.dev`    | 36/36 matched      | `200 ok` | `no-store, max-age=0` |

Both return `X-Frame-Options: DENY`. Existing non-dashboard container IDs were
compared before and after activation and remained unchanged. No shared edge
proxy or DramaPal service was restarted.

Unchanged configuration hashes:

- Compose: `ed19d3e1b31e8c87f835236b1749135077c331aa1492ff7153bca9f1a7cf456e`.
- Dashboard Caddyfile:
  `7952ff6e2761270f4e5ecf5c489c9942a5b16a769af7ec3ae182df027d92bf86`.

## Authenticated browser acceptance

Chrome's existing Victory Onorhime partner session was used without account
changes, sign-out, re-signing or password entry.

1. Opened production Profile & Documents, independent of the reporting empty state.
2. Observed one version 1 document, “Signed by both parties”, with partner
   signature at 09:53 UTC and company countersignature at 10:28 UTC on 5 September.
3. Opened details, prepared an authenticated five-minute private link, and
   clicked Open PDF in a new tab.
4. Visually confirmed Chrome rendered the existing six-page PDF (first page
   heading “KissMyApps Affiliate Platform Specification”). This tests actual
   private Storage retrieval, not just URL generation. No stamped PDF was created.
5. Closed the detail dialog and left the Documents page available for the user.

Document: `3b68c176-41ff-4c6d-bc19-7caa8e6fb30d`.
Agreement: `5bad6208-1d10-4db1-86bf-464c886e6569`.
Product: `fdbabb87-9743-4521-bc8d-11804fe1185f` (BC Learn).

BC Learn's product and default Vercel funnel remain drafts; the agreement
remains active and its document signed. The document title is the actual
uploaded filename. Since the active product-name directory excludes the draft
product, the card's secondary label is “Partner document”. The PDF is the
already uploaded developer specification; this release did not audit its legal
suitability or replace it with partnership terms.

## Verification boundary and next work

The release reused the unchanged production build from the passing local
`pnpm validate`: 677 tests / 48 files, formatting, lint, funnel checks,
TypeScript and Vite. Local desktop/390px and keyboard checks used synthetic
fixtures. Production desktop directory/details and real PDF rendering were
verified; physical-device and screen-reader checks remain separate gates.

Billing offers, checkout, coupons, payment webhooks, payouts, product/funnel
activation and both Vercel deployments were not changed or tested here. They
remain the next explicitly scoped end-to-end integration work.

Task evidence and guarded helpers:
`/tmp/kma-documents-release.0WZUga/` (temporary, not a durable backup).
Server evidence:
`/srv/kissmyapps/release-evidence/20260905T122944Z-documents-a2b64ae43896/`.

For rollback, under the release lock first assert this release is still current,
atomically restore the recorded previous symlink, and recreate only the dashboard
service using the same Compose command. Preserve both immutable directories.
The additive read-only RPC can remain with the previous frontend; do not delete
data or edit migration history as a frontend rollback shortcut.
