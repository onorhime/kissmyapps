# KissMyApps Admin Affiliate management release evidence — 2026-09-01

This record covers the protected Admin Affiliate directory, evidence detail,
lifecycle controls, production database migration, and immutable frontend
deployment. It does not enable tracking, create a product or funnel, change the
QA administrator's Operations role, or claim an authenticated production-browser
acceptance pass.

## Release identity

- Supabase project: `mmyruzjemjecqyivhrgr` (`KissMyApps`).
- VPS: Hostinger `72.60.125.99`.
- Source revision: `71a02f90d02b7e637883b26f02750c37199ddee9`.
- Reviewed source tag: `production-20260901-admin-affiliates-v1`.
- Database migration: `20260901100000_admin_affiliate_management.sql`.
- Active immutable release:
  `/srv/kissmyapps/releases/20260901T013259Z-admin-affiliates-71a02f90d02b`.
- Previous immutable release:
  `/srv/kissmyapps/releases/20260831T234040Z-context-contrast-805dd1ad17e5`.
- Active release link: `/srv/kissmyapps/current`.
- Frontend manifest SHA-256:
  `3381eb39af23d95cc0e3e6b1e0699e0a12f1718cdb21f7a0ca9d365318d8696e`.
- Production JavaScript: `assets/index-CUNhHi77.js`.
- Production CSS: `assets/index-D-r_yhpm.css`.

## Delivered Admin workflow

- `#admin/affiliates` provides summary totals and a searchable, status/product
  filterable, sortable, paginated Affiliate directory.
- `#admin/affiliates/:affiliateId` opens a route-backed detail dialog with
  registration, email-confirmation, activation, legal-acceptance, product,
  agreement, link, and lifecycle evidence.
- Operations and Owner administrators can pause or reactivate a Partner only
  after password verification. The server remains authoritative for roles,
  allowed transitions, and audit history.
- Termination is Owner-only, requires typing the exact affiliate slug, and is
  blocked while qualifying agreements, documents, or unsettled payouts remain.
- Permanent lifecycle actions are audited. Browser roles retain no direct
  public-base-table access.
- At widths at or below 820px, the directory changes from a wide table into
  labelled cards. Route closure restores focus to Admin main content when its
  opener is unavailable; invalid action forms focus the first invalid control.

## Database deployment and evidence

- `supabase db push --linked --skip-vault` applied the additive migration to the
  exact production project.
- A subsequent dry run reported the linked project up to date. Local and remote
  history match all 15 migration versions through `20260901100000`.
- Fresh PostgreSQL 17 replay passed 724 of 724 assertions across test files
  `00` through `15` (16 files). The Admin Affiliate file passed 97 of 97, and the
  schema contract passed 168 of 168.
- Linked database lint completed with no errors. Five existing `extra` warnings
  identify unused variables in `normalize_stripe_provider_event`; this release
  did not introduce them or weaken the lint threshold.
- An anonymous REST call to `get_admin_affiliate_summary` returned `401`,
  confirming the RPC is not publicly callable.
- No reset, seed, role change, tracking change, product/funnel creation, or QA
  Affiliate lifecycle mutation was performed.

## Source and build evidence

- `pnpm validate` passed formatting, oxlint, the funnel TypeScript/lint checks,
  35 Vitest files / 458 tests, application TypeScript, and the production Vite
  build.
- The only build advisory is the existing Vite chunk-size warning above 500 kB.
- Deno 2.8.0 passed formatting across 36 files, lint across 34 files, all ten
  Edge Function entrypoint checks, and 51 of 51 tests.
- The full 15-migration database replay passed 724 of 724 assertions.
- Secret scans found no exposed Resend key, preview statement artifact, or
  credential in the release diff/build. The production bundle contains the
  Admin Affiliate CSS marker and protected directory RPC name.
- The source worktree was clean at the reviewed deployment commit.

## Immutable deployment and runtime evidence

- All 26 files in the immutable release passed `sha256sum -c` on the VPS.
- Only `kissmyapps-dashboard` was recreated. It is healthy, read-only, publishes
  no host port, and has zero restarts.
- Dashboard container:
  `74b7c6efd34df0e49317e4a3d0f1f86ea50bf271021c613721946c459f0dcc62`.
- The dashboard image remains pinned to
  `sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d`.
- The edge container was not recreated or restarted:
  `4b9d93ac569b0e87243460d938971ce40f93e2bca71953dc00286e347dd07291`.
- The active edge Caddy configuration remained unchanged at SHA-256
  `7f8ae733df2b720b0037f64fb45e20878c895f0e4095dc9033df71deaf28fc32`.

## Public endpoint and regression evidence

- Partner root, health, and SPA fallback returned `200`.
- Admin root, health, and SPA fallback for `/admin/affiliates` returned `200`.
- Admin HTML retained `Cache-Control: no-store`, HSTS, `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, same-origin opener
  policy, and disabled camera/geolocation/microphone permissions. Versioned CSS
  retained one-year immutable caching.
- `go.kissmyapps.dev` stayed fail-closed: its root and an unissued link returned
  `404`; a disallowed `POST /r/test` returned `405`.
- DramaPal stream, mobile, and sandbox roots returned `200`; its API root retained
  the expected `404`. All seven recorded DramaPal container IDs and restart
  counts remained unchanged.
- The retained Chrome tab reports the production Admin sign-in URL and title.
  This proves the signed-out authentication boundary, not the authenticated
  Affiliate workspace.

## Retained acceptance gates

- The available production browser has no authenticated Admin session. A signed-in
  desktop/mobile pass must still inspect directory states, filters, route-backed
  detail, focus, responsive cards, and password-action dialogs.
- The retained QA Admin is Operations. Owner-only termination must remain hidden
  for that user. Source and database tests cover Owner authorization and blockers,
  but no live termination click was performed or should be inferred.
- A safe authenticated pass should not mutate the current QA Partner lifecycle.
  If a destructive lifecycle demonstration is later required, create a separately
  approved disposable account and commercial-state plan first.
- Tracking remains disabled. There is no approved live funnel, Partner link,
  Stripe Price, signed commercial document, worker schedule, payout provider,
  Singular pipeline, or Amplitude outbound pipeline.

## Rollback

1. Repoint `/srv/kissmyapps/current` to
   `/srv/kissmyapps/releases/20260831T234040Z-context-contrast-805dd1ad17e5`.
2. Recreate only `kissmyapps-dashboard` from the existing dashboard Compose
   project.
3. Recheck Partner/Admin health and SPA routes, Go fail-closed behavior, and every
   DramaPal host. Keep the edge container and configuration unchanged.
4. Keep `tracking_enabled = false` throughout rollback.

The applied database migration is forward-only. If a database correction is
needed, use another reviewed forward migration or an approved provider restore;
do not edit or reverse the applied migration in place.
