# KissMyApps agreement signing release evidence — 2026-09-04

This record covers the production database and frontend release that adds
bilateral agreement signing: an Owner/Operations administrator records the
versioned agreement terms PDF in the private bucket, the password-
authenticated active partner signs it in their dashboard, and the
administrator countersigns. Signature evidence is immutable and audited;
only not-yet-fully-signed documents can be revoked with an audited reason.

## Approval and release identity

- Release commit: `979dc4debf7e` (`feat: add bilateral agreement signing`).
- Database migration: `20260904120000_agreement_signing` (additive).
- Active immutable release:
  `/srv/kissmyapps/releases/20260904T094214Z-agreement-signing-979dc4debf7e`.
- Previous and rollback release:
  `/srv/kissmyapps/releases/20260903T220609Z-admin-production-first-ui-f84bb6d671b2`.
- Active release link: `/srv/kissmyapps/current`.
- Release manifest SHA-256:
  `bf2993f56a079af22ffa98748c00f3fcb590f5aa1834d860146aa9f7a3db4516`.
- All checksums passed locally, after upload, and from the active release.

## Backend change

- Migration `20260904120000_agreement_signing` applied remotely with a
  clean local/remote migration-history match for all 21 migrations.
- New password-proven RPCs: `create_admin_agreement_document`,
  `partner_sign_agreement_document`, `admin_countersign_agreement_document`,
  `revoke_admin_agreement_document`, and the partner-visible
  `get_partner_agreement_signature_queue`; all revoked from
  public/anon/service_role and granted to authenticated only.
- Additive `documents` columns record the partner signer user, the typed
  legal name, and the KissMyApps countersigner.
- One admin-scoped storage INSERT policy was added for the existing private
  bucket. Anonymous REST probes return exactly the same hidden-function
  response as the established protected RPCs.

## Deployment procedure and incident note

The first promotion attempt used a shell script whose variable expansion
collapsed, which briefly (about two minutes) pointed `/srv/kissmyapps/current`
at the releases parent directory and made the dashboard serve 404s. The
symlink was repointed to the previous verified release, the container was
recreated, and both hosts returned 200 immediately. The new release was then
re-uploaded and promoted with per-step checksum verification. No database
record, storage object, or edge configuration was touched during that window,
and `go.kissmyapps.dev` never changed.

## Post-deployment verification

- `https://partners.kissmyapps.dev/` and `https://admin.kissmyapps.dev/`
  return 200 and serve an `index.html` byte-identical to the local build;
  the hashed `dashboard-BZfWJOfZ.js` bundle returns 200.
- `https://go.kissmyapps.dev` still answers `HEAD /r/release-probe` with 405,
  and `/statements/*` remains rejected.
- The container reports healthy with the read-only, unprivileged,
  no-host-port configuration unchanged.

## Validation before release

- `pnpm format:check`, `pnpm lint`, `pnpm funnel:check`, `pnpm test`
  (44 files, 597 tests), and `pnpm build` all passed with exit code 0.
- The checked-in `21_agreement_signing.sql` pgTAP contract file follows the
  established harness but was not executed locally; this workflow does not
  run a local Supabase/Docker runtime.

## Acceptance boundary

No agreement, document, storage object, or link was created by this release.
The end-to-end signing journey (upload → partner signature → countersignature
→ launch-ready agreement) remains an authenticated production acceptance gate
for the platform Owner and the QA partner.
