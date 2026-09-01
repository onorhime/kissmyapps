# KissMyApps Admin Platform Settings release evidence — 2026-09-01

This record covers the protected Admin Platform Settings read/mutation contract,
its production Supabase migration, and the immutable Hostinger frontend release.
It does not create a product, funnel, offer, agreement, link, traffic, payment,
commission, subscription, or payout. It does not enable tracking.

## Approval and release identity

- Production migration and deployment were approved by the user in the active
  Codex task on 2026-09-01.
- Supabase project: `mmyruzjemjecqyivhrgr` (`KissMyApps`).
- VPS: Hostinger `72.60.125.99`.
- Source revision: `e4649427be8a665a71f9f56051d18ba3a1e51676`.
- Reviewed source tag: `production-20260901-admin-platform-settings-v1`.
- Database migration: `20260901180000_admin_platform_settings.sql`.
- Active immutable release:
  `/srv/kissmyapps/releases/20260901T112904Z-admin-platform-settings-e4649427be8a`.
- Previous and rollback release:
  `/srv/kissmyapps/releases/20260901T102651Z-admin-observability-bd960600703c`.
- Active release link: `/srv/kissmyapps/current`.
- Artifact files: 26; artifact bytes: 1,625,298.
- Artifact manifest SHA-256:
  `986dd5b89befdbf58bc0f03193ab2cb58ba29d50a8fd84d005b9c89cf1248b40`.
- Production JavaScript: `assets/index-BmMd-KmU.js`.
- Production CSS: `assets/index-BndUN-Wb.css`.

## Delivered workflow and safety contract

- `#admin/settings` reads the actual tracking origin, kill-switch state, expected
  production hosts, and aggregate launch-readiness counts. It does not expose raw
  record IDs, destinations, payment/provider identifiers, secrets, or event data.
- Owner, Operations, Finance, and Analyst can read. Only a password-authenticated
  Owner can mutate. Support, ordinary users, inactive admins, and anonymous callers
  are denied server-side.
- The only accepted tracking origin is `https://go.kissmyapps.dev`. When no value
  exists, the UI presents it explicitly as an unsaved suggestion.
- Every mutation carries the last `updated_at` token. A stale tab receives a
  sanitized conflict and reloads instead of overwriting a newer kill-switch or
  origin state.
- Enable and disable both require deliberate inline confirmation, preserve focus,
  and retain readable settings when a mutation needs reauthentication.
- Tracking cannot be enabled unless one correlated active product has a live
  default production funnel, active Partner with launch-ready signed agreement,
  active live-verified subscription offer, and no non-archived main link outside
  the canonical `/r/` prefix.
- Product activation now requires the canonical origin and live default funnel,
  but not an already-enabled tracking switch. This removes the prior launch-order
  deadlock while keeping collection disabled until the full commercial chain is
  ready.
- The migration replaces the transaction-scoped generic Settings timestamp
  trigger with a monotonic token and normalizes any unsafe legacy origin/state
  fail closed. It cannot turn tracking on.

## Database deployment and evidence

- The linked project ref was verified before mutation.
- The pre-deployment dry run identified exactly the Settings migration, with no
  seed or role-file changes.
- The migration applied successfully. A serial migration-list readback matched
  all 19 local/remote versions through `20260901180000`; the post-deployment dry
  run reported the remote database up to date.
- Linked `public` schema lint returned no errors. It retained five pre-existing
  extra-variable warnings in `normalize_stripe_provider_event`; none were created
  by this release.
- Anonymous REST probes returned `401` for both the Settings read and mutation
  RPCs.
- The checked-in pgTAP contract received independent syntax/privilege review but
  was not executed against local Supabase/Docker because this project explicitly
  excludes a local database. It is not claimed as runtime proof.

## Source, visual, and build evidence

- `pnpm validate` passed formatting, oxlint, funnel TypeScript/lint, 41 Vitest
  files / 573 tests, application TypeScript, and the production Vite build.
- Desktop and 390px browser checks of the Settings page found no horizontal
  overflow, usable controls, one DOM copy of every section, and no console errors.
  A duplicated full-page mobile capture was verified as a stitching artifact;
  normal viewport capture and DOM counts were correct.
- The release artifact was built from a clean `git archive` of the exact source
  revision with preview mode unset and only the production Supabase URL/publishable
  anon key supplied.
- The artifact contained no statement directory, PDF, source map, environment
  file, symlink, Resend key, Stripe secret-key pattern, Supabase secret-key pattern,
  private-key marker, or service-role pattern. Compiled preview copy may remain in
  the shared bundle; preview mode is disabled and no preview statement artifact is
  deployed.
- All 26 checksums passed locally, after upload, and from the active release.

## Immutable deployment evidence

- The candidate was uploaded under a non-live incoming directory, checksum-
  verified, made root-owned/read-only, and atomically renamed.
- `/srv/kissmyapps/current` was replaced under the release lock.
- Only `kissmyapps-dashboard` was recreated. It is healthy, read-only, has zero
  restarts, publishes no host port, and runs as container
  `6c75c8248b4968fa7f90e35c1df22b18e3072cb30790085980f48d3caab31294`.
- Edge Caddy was not written or restarted. Its ID remained
  `4b9d93ac569b0e87243460d938971ce40f93e2bca71953dc00286e347dd07291`,
  restart count remained zero, and active configuration SHA-256 remained
  `7f8ae733df2b720b0037f64fb45e20878c895f0e4095dc9033df71deaf28fc32`.
- All six non-edge DramaPal container IDs and all seven adjacent restart counts
  remained unchanged.

## Public endpoint and browser evidence

- Partner/Admin roots, health checks, and representative SPA fallback paths
  returned `200`. Production statement fixtures returned `404`.
- Admin HTML retained no-store caching, HSTS, `nosniff`, and no-referrer headers;
  hashed JavaScript retained one-year immutable caching.
- `go.kissmyapps.dev` remained fail closed: root `404`, safe HEAD probe `405`, and
  safe POST probe `405`. No release probe invoked a `GET /r/*` redirect.
- DramaPal stream, mobile, and sandbox roots stayed `200`; its API root kept the
  expected `404`.
- All three KissMyApps hosts resolved to `72.60.125.99` and presented matching SAN
  certificates valid from 2026-08-30 through 2026-11-28.
- A signed-out in-app browser routed the Admin hostname to protected Admin sign-in
  and the Partner hostname to Partner sign-in, with clean consoles. Positive
  authenticated Settings acceptance remains a user-session check; it must be
  read-only until a real product/funnel launch chain is approved.

## Rollback

1. Under `/srv/kissmyapps/.release.lock`, atomically repoint
   `/srv/kissmyapps/current` to
   `/srv/kissmyapps/releases/20260901T102651Z-admin-observability-bd960600703c`.
2. Recreate only the `dashboard` service from
   `/srv/kissmyapps/deploy/compose.yaml` and require its health gate.
3. Recheck Partner/Admin health and SPA routes, Go fail-closed behavior, and all
   DramaPal hosts. Keep Caddy and adjacent services unchanged.
4. Do not reverse the database migration in place. Any correction is a reviewed
   forward migration or an approved provider restore.

Tracking remains disabled until a password-proven Owner deliberately enables it
after the real product, funnel, signed agreement, and verified offer satisfy the
server gate.
