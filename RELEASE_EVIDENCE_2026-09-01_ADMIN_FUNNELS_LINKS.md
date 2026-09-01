# KissMyApps Admin Funnels & Links release evidence — 2026-09-01

This record covers the protected Admin Funnels & Links operations view, the
destination-redaction database migration, and the immutable production frontend
deployment. It does not create a product or funnel, issue a Partner link, enable
tracking, configure Stripe, or activate acquisition traffic.

## Approval and release identity

- Production deployment was explicitly approved by the user in the active Codex
  task on 2026-09-01.
- Supabase project: `mmyruzjemjecqyivhrgr` (`KissMyApps`).
- VPS: Hostinger `72.60.125.99`.
- Source revision: `dd8b61f17466ea830b36d1f29e379be5261c4bb2`.
- Reviewed source tag: `production-20260901-admin-funnels-links-v1`.
- Database migration:
  `20260901130000_admin_product_configuration_destination_redaction.sql`.
- Active immutable release:
  `/srv/kissmyapps/releases/20260901T084834Z-admin-funnels-links-dd8b61f17466`.
- Previous and rollback release:
  `/srv/kissmyapps/releases/20260901T060405Z-auth-routing-fix-04be464a494f`.
- Active release link: `/srv/kissmyapps/current`.
- Artifact files: 26.
- Artifact manifest SHA-256:
  `9fdf1d0660f09e6d510d4abafa340250dbd6fcbb8993135deebf695e7593697e`.
- Production JavaScript: `assets/index-DHjNoyVU.js`.
- Production CSS: `assets/index-B86fev98.css`.

## Delivered workflow

- `#admin/funnels-links` provides a protected global operations view of product
  routing, funnels, live defaults, and issued main links without creating
  placeholder records.
- Owners and Operations administrators can receive configured destination URLs.
  Finance and Analyst administrators receive the truthful
  `destination_configured` state without the protected URL. Support is denied.
- Exact product-configuration actions remain available to authorized roles.
  Main links are copy-only on this page; copying does not open the URL or create
  traffic.
- Loading, empty, unconfigured, restricted, total-failure, and partial-failure
  states are explicit. Raw backend errors are not rendered.
- Desktop and mobile navigation, responsive routing cards, URL wrapping, and
  44-pixel controls are covered. Admin routes cannot render on the Partner host.

## Database deployment and evidence

- The linked production target was confirmed as
  `mmyruzjemjecqyivhrgr`, with project status `ACTIVE_HEALTHY`.
- A dry run identified only migration `20260901130000`; it contained no seeds or
  role file deployment.
- The migration was applied with the pinned Supabase CLI. A subsequent serial
  migration-list readback matched local and remote history through
  `20260901130000`, and a follow-up dry run reported the remote database up to
  date.
- Linked `public` schema lint at error level returned no findings.
- The migration replaces one SECURITY DEFINER getter, preserves an empty
  `search_path`, revokes broad execution, grants only `authenticated`, and keeps
  the old frontend response compatible while adding role-aware URL redaction.
- No product, funnel, link, agreement, Auth user, storage object, tracking flag,
  seed, role, Function, or secret was changed by this database release.
- The checked-in pgTAP contract test was not executed against a local Supabase or
  Docker runtime because this project intentionally uses production Supabase
  only and Docker was unavailable. It is retained as a future isolated-replay
  gate and is not counted as passed production evidence.

## Source and build evidence

- Two full `pnpm validate` runs passed: one in the reviewed checkout and one from
  a clean `git archive` of the production tag.
- Each run passed formatting, oxlint, funnel TypeScript/lint, 36 Vitest files / 504
  tests, application TypeScript, and the Vite production build.
- The only build advisory was the existing chunk-size warning above 500 kB.
- Independent routing/security reviews found no remaining actionable issues.
- The production build used only the exact production Supabase URL and
  publishable browser key. Preview mode was unset.
- The artifact contained no preview statement directory, PDF fixture, source
  map, symlink, Resend key, service-role pattern, or Stripe secret-key pattern.
  All 26 checksums passed locally and on the VPS.

## Immutable deployment evidence

- The candidate was uploaded below a non-live incoming name, checksum-verified,
  made read-only, and renamed into the immutable release directory before
  activation.
- `/srv/kissmyapps/current` was replaced atomically under the release lock.
- Only `kissmyapps-dashboard` was recreated. It is healthy, read-only, has zero
  restarts, and publishes no host port.
- Dashboard container:
  `acba4f8e951d3c8e510ad27221bae832d1052d0de8a826ffbe14a6917d6beafc`.
- The edge Caddy container was not recreated or restarted:
  `4b9d93ac569b0e87243460d938971ce40f93e2bca71953dc00286e347dd07291`.
- All six non-edge DramaPal container IDs and all seven adjacent restart counts
  remained unchanged.

## Public endpoint and browser evidence

- Partner and Admin roots, health routes, and representative SPA fallback paths
  returned `200` with valid TLS.
- Admin HTML retained no-store caching, HSTS, `nosniff`, frame denial,
  no-referrer policy, same-origin opener policy, and disabled camera,
  geolocation, and microphone permissions. Versioned assets retained one-year
  immutable caching.
- Served JavaScript and CSS hashes matched the immutable release manifest.
- Production statement fixtures returned `404`. The Go root remained `404`, and
  a safe `HEAD /r/release-probe` returned `405` without invoking a redirect.
- DramaPal stream, mobile, and sandbox roots returned `200`; its API root kept
  the expected `404`.
- The available Chrome session was signed out. The Admin route resolved to the
  protected Admin sign-in page, while the same Admin fragment on the Partner host
  resolved to the protected Partner sign-in page with no console errors. This
  proves the live authentication and hostname boundary, not the signed-in module.
- Authenticated desktop/mobile module acceptance remains a retained user-session
  check. Local rendered QA already covered the operations data state, copy
  feedback without navigation, and responsive layout, but it is not production
  authentication evidence.

## Rollback

1. Atomically repoint `/srv/kissmyapps/current` to
   `/srv/kissmyapps/releases/20260901T060405Z-auth-routing-fix-04be464a494f`.
2. Recreate only `kissmyapps-dashboard` from
   `/srv/kissmyapps/deploy/compose.yaml` and require its health gate.
3. Recheck Partner/Admin health and SPA routes, Go fail-closed behavior, and all
   DramaPal hosts. Keep Caddy and adjacent services unchanged.
4. Keep `tracking_enabled = false`.

The database migration is forward-only and compatible with the previous
frontend. Any database correction must be a reviewed forward migration or an
approved provider restore; do not edit or reverse the applied migration.
