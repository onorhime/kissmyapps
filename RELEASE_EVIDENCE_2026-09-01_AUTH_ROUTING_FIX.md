# KissMyApps authentication and workspace-routing fix release evidence — 2026-09-01

This record covers the production frontend fix for password-recovery completion,
Partner/Admin hostname isolation, and Admin active-navigation contrast. It does
not change the database, hosted Auth configuration, Resend, Edge Functions,
tracking configuration, the shared edge proxy, or any DramaPal service.

## Approval and release identity

- Production deployment was approved by the user in the active Codex task on
  2026-09-01.
- Supabase project target: `mmyruzjemjecqyivhrgr` (`KissMyApps`).
- VPS: Hostinger `72.60.125.99`.
- Source revision: `04be464a494fd5a5d5655fcb4411bc408c10f792`.
- Reviewed source tag: `production-20260901-auth-routing-fix-v1`.
- Active immutable release:
  `/srv/kissmyapps/releases/20260901T060405Z-auth-routing-fix-04be464a494f`.
- Previous and rollback release:
  `/srv/kissmyapps/releases/20260901T013259Z-admin-affiliates-71a02f90d02b`.
- Active release link: `/srv/kissmyapps/current`.
- Artifact files: 26.
- Artifact manifest SHA-256:
  `ac9841d472d93a4cb14a7712c558449d21bc26f3657a99285926038d130d29e9`.
- Production JavaScript: `assets/index-CcF3gXrC.js`.
- Production CSS: `assets/index-CA1gLmBd.css`.

## Delivered fixes

- Password recovery now has an explicit completion state, so a successful
  password update can open the requested workspace without a refresh even while
  Supabase finishes rotating the recovery session.
- Recovery-mode handling distinguishes the password-recovery event, same-token
  user updates, and the rotated signed-in session. Pending and post-rotation
  failure states remain actionable.
- `admin.kissmyapps.dev` and `partners.kissmyapps.dev` are authoritative workspace
  boundaries. A stale or conflicting fragment cannot render the other shell,
  and cross-workspace navigation uses the canonical production origin.
- Sign-up confirmation callbacks opened on the Admin origin transfer to the
  Partner origin before the token is consumed.
- The active Admin navigation item uses the dark plum foreground on the pink
  background. Regression checks calculate 8.175:1 desktop contrast and 7.868:1
  mobile contrast.

## Source, backend, and build evidence

- The reviewed source tree was clean at the source revision and contained no
  credential-pattern match in the release diff. `.env.local` remained ignored.
- The production artifact was rebuilt from `git archive` of the reviewed tag,
  with preview mode unset and only the production Supabase URL and publishable
  browser key supplied to Vite.
- `pnpm install --frozen-lockfile` passed.
- `pnpm validate` passed formatting, oxlint, funnel TypeScript/lint, 35 Vitest
  files / 483 tests, application TypeScript, and the production Vite build.
- The only build advisory was the existing Vite chunk-size warning above 500 kB.
- Deno formatting passed across 36 files, lint across 34 files, all ten Edge
  Function entrypoint checks, and 51 of 51 tests.
- Local and remote histories matched all 15 migrations through
  `20260901100000_admin_affiliate_management`. The production database push dry
  run reported that the project was already up to date with no migrations,
  seeds, or role changes pending.
- Production artifacts contained no preview statement directory, PDF fixture,
  source map, or symlink. All 26 checksums passed locally, on the staged VPS
  release, and again through the active release link.

## Immutable deployment evidence

- The candidate was uploaded below a non-live incoming name, checksum-verified,
  made read-only, and renamed into the immutable release directory before
  activation.
- `/srv/kissmyapps/current` was replaced atomically under the release lock.
- Only `kissmyapps-dashboard` was recreated. It became healthy within the
  Compose wait gate, is read-only, has zero restarts, and publishes no host port.
- Dashboard container:
  `6475a4c5e28b7017ba115667f824ce1659d70323f4806167eabb7ebd7d2c75b0`.
- Dashboard image remained pinned to
  `sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d`.
- The edge container was not recreated or restarted:
  `4b9d93ac569b0e87243460d938971ce40f93e2bca71953dc00286e347dd07291`.
- All six non-edge DramaPal container IDs and all seven adjacent restart counts
  remained unchanged.

## Public endpoint and browser evidence

- Partner and Admin roots, health routes, and representative SPA fallback paths
  returned `200` with valid TLS.
- Admin HTML retained `Cache-Control: no-store`, HSTS, `nosniff`, frame denial,
  no-referrer policy, same-origin opener policy, and disabled camera,
  geolocation, and microphone permissions.
- The served JavaScript and CSS SHA-256 values matched the immutable release
  manifest. Versioned JavaScript retained one-year immutable caching.
- Production statement fixtures returned `404`.
- The Go root remained `404`; a safe `HEAD /r/release-probe` returned `405`
  without invoking a redirect.
- DramaPal stream, mobile, and sandbox roots returned `200`; its API root
  retained the expected `404`.
- In Chrome, `admin.kissmyapps.dev/#performance` resolved to the protected Admin
  sign-in experience and title, while
  `partners.kissmyapps.dev/#admin/affiliates` resolved to the protected Partner
  sign-in experience and title. Neither navigation produced a browser warning
  or error.

## Retained acceptance boundary

- The available production browser was signed out. The cross-host boundary was
  proven live, but an authenticated Admin navigation pass and a fresh real
  password-recovery email lifecycle were not performed in this release turn.
- Source tests cover the successful recovery CTA with sticky recovery state,
  session rotation, pending updates, post-rotation errors, cross-host hard loads,
  runtime hash changes, callback transfer, and Partner switching.
- A recipient should still repeat one fresh password-recovery email flow and
  confirm that the success CTA opens the dashboard immediately. That recipient
  evidence is required before describing the recovery lifecycle as fully
  accepted in production.
- No database, Auth setting, email setting, Edge Function, tracking switch,
  product, funnel, agreement, payout, or adjacent service was changed.

## Rollback

1. Atomically repoint `/srv/kissmyapps/current` to
   `/srv/kissmyapps/releases/20260901T013259Z-admin-affiliates-71a02f90d02b`.
2. Recreate only `kissmyapps-dashboard` with the existing dashboard Compose
   project and require its health gate.
3. Recheck Partner/Admin health and SPA routes, Go fail-closed behavior, and all
   DramaPal hosts.
4. Keep the shared edge, DramaPal services, database, hosted Auth, Resend, Edge
   Functions, and tracking configuration unchanged.
