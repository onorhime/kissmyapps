# KissMyApps production-first admin UI release evidence — 2026-09-03

This record covers the frontend-only release that makes Admin product
configuration production-first: a shared dark Select control, one linear
Launch section for activation and main-link issuance, tracking-only mode
demoted to an Owner-only disclosure, and clarified funnel/source/campaign
copy. No database, Edge Function, or edge Caddy change belongs to this
release.

## Approval and release identity

- Release commit: `f84bb6d671b2` (`feat: make admin product configuration
production-first`).
- Active immutable release:
  `/srv/kissmyapps/releases/20260903T220609Z-admin-production-first-ui-f84bb6d671b2`.
- Previous and rollback release:
  `/srv/kissmyapps/releases/20260901T173438Z-tracking-only-demo-38e8410c8e56`.
- Active release link: `/srv/kissmyapps/current`.
- Release manifest SHA-256:
  `825af5658ba789afaa7764376e024e6d222da8f024a978af0c7a57a43a0272d5`.
- All checksums passed locally, after upload, and from the active release.

## Validation before release

- `pnpm format:check`, `pnpm lint`, `pnpm funnel:check`, `pnpm test`
  (43 files, 590 tests), and `pnpm build` all passed with exit code 0.
- The production build strips the local `public/statements/SAMPLE-*.pdf`
  fixtures; the static server still rejects `/statements/*`.

## Deployment procedure

1. The immutable release directory was uploaded to `/srv/kissmyapps/.uploads`,
   checksum-verified, made root-owned and read-only, and atomically moved into
   `/srv/kissmyapps/releases/`.
2. `/srv/kissmyapps/current` was switched under `/srv/kissmyapps/.release.lock`.
   Only the Compose-managed `kissmyapps-dashboard` container was recreated; the
   edge Caddy, DramaPal hosts, and `go.kissmyapps.dev` were not modified.
3. An initial layout mistake (site files at the release root instead of the
   release `dist/` subdirectory) was corrected in place before acceptance:
   the release was rearranged to the canonical `SHA256SUMS` + `dist/` layout,
   checksums re-verified, and the container recreated. The site served 404
   only during that window.

## Post-deployment verification

- `https://partners.kissmyapps.dev/` and `https://admin.kissmyapps.dev/`
  return 200 and serve an `index.html` byte-identical to the local build;
  the hashed `dashboard-DPrl04bL.js` and CSS bundles return 200.
- `https://go.kissmyapps.dev` still answers `HEAD /r/release-probe` with 405.
- `https://partners.kissmyapps.dev/demo-funnel.html` returns 200 and
  `/statements/*` remains rejected.
- The container reports healthy with the read-only, unprivileged,
  no-host-port configuration unchanged.

## Acceptance boundary

No product, funnel, link, click, event, offer, agreement, or payout record
was created by this release. Authenticated production visual acceptance of
the restructured Product Configuration page remains a manual gate for the
platform Owner.
