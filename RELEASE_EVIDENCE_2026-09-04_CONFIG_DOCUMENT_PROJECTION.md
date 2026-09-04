# KissMyApps configuration document projection release evidence — 2026-09-04

Database and frontend follow-up to the agreement signing release. The
product-configuration read omitted each agreement's current signing
document, so a successfully recorded PDF disappeared from the Admin signing
timeline after reload and the flow appeared broken. The read now shares the
`admin_agreement_enriched` projection with the create/activate mutations,
and agreement records gain vertical rhythm around rule rows, the activate
action, and gate copy.

- Release commit: `3ad743042536`.
- Database migration: `20260904170000_admin_config_document_projection`
  (read-projection change only), applied remotely with a clean local/remote
  migration-history match for all 23 migrations.
- Active release: `/srv/kissmyapps/releases/20260904T122221Z-config-document-projection-3ad743042536`.
- Rollback target: `/srv/kissmyapps/releases/20260904T114423Z-agreement-signing-ux-0443f203cb04`.
- Manifest SHA-256: `8acde7f73b24d0892d572d0bce3ea85eefe45127d8ee9c3937d8de03d5c9f482`.
- `pnpm format:check`, `pnpm lint`, `pnpm test` (44 files, 597 tests), and
  `pnpm build` passed. Both hosts serve an index.html byte-identical to the
  local build; the container is healthy with its hardened configuration.
- Recorded agreements made before this fix are unaffected: their documents
  were already bound and now appear in the timeline.
