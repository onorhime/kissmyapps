# KissMyApps draft deletion release evidence — 2026-09-04

Database and frontend release that lets an Owner/Operations administrator
delete draft commercial records while no commercial history exists:
`delete_admin_draft_commission_rule` removes any rule whose agreement is
not active, and `delete_admin_draft_agreement` removes a draft or
awaiting-signature agreement without a live document together with its
rules. Both are password-proven, audit-logged, and fail closed once an
agreement is active (immutable history; supersede instead). The waiting
timeline states use a clock icon, supersede requires confirmation, older
working drafts of the same partner agreement are de-emphasised, and
agreement card actions are grouped.

- Release commit: `01e0d0499eb1`.
- Database migration: `20260904180000_admin_draft_deletion`, applied
  remotely with a clean local/remote migration-history match for all 24
  migrations.
- Active release: `/srv/kissmyapps/releases/20260904T125631Z-draft-deletion-01e0d0499eb1`.
- Rollback target: `/srv/kissmyapps/releases/20260904T122221Z-config-document-projection-3ad743042536`.
- Manifest SHA-256: `d7799d91e051a129d107a99aa1ce5edb72189a657d5cd21655fcd0470870bc10`.
- `pnpm format:check`, `pnpm lint`, `pnpm test` (44 files, 597 tests), and
  `pnpm build` passed. Both hosts serve an index.html byte-identical to the
  local build; the container is healthy.
