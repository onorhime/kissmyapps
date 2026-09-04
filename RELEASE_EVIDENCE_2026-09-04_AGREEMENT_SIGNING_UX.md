# KissMyApps agreement signing UX release evidence — 2026-09-04

Frontend-only follow-up to the agreement signing release. It fixes the
agreement PDF upload path (partner-scoped prefix required by the recording
RPC, with best-effort cleanup of unrecorded uploads), vertically centers the
shared Select chevron, styles the document signing block, locks the trigger
event to the launch-supported value, defaults renewal duration to 7 days
with a plain-language hint, resets the agreement form after creation, and
replaces the raw file input with a labelled picker.

- Release commit: `0443f203cb04`.
- Active release: `/srv/kissmyapps/releases/20260904T114423Z-agreement-signing-ux-0443f203cb04`.
- Rollback target: `/srv/kissmyapps/releases/20260904T094214Z-agreement-signing-979dc4debf7e`.
- Manifest SHA-256: `ca7b4bb9ba18deec8066aaa108a8fc013df90a941fbfb44b2a6da5624c2fa543`.
- No database, Edge Function, or edge Caddy change belongs to this release.
- `pnpm format:check`, `pnpm lint`, `pnpm test` (44 files, 597 tests), and
  `pnpm build` passed. Both hosts serve an index.html byte-identical to the
  local build; the container is healthy with its hardened configuration.
