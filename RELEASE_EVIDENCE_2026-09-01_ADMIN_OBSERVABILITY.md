# KissMyApps Admin Attribution and Data Health release evidence — 2026-09-01

This record covers the protected Admin Attribution and Data Health read models,
their production Supabase migrations, and the immutable Hostinger frontend
release. It does not create products, funnels, agreements, links, traffic,
payments, or payouts, and it does not enable tracking, Stripe, workers, or
funnel ingestion.

## Approval and release identity

- Production migration and deployment were explicitly approved by the user in
  the active Codex task on 2026-09-01.
- Supabase project: `mmyruzjemjecqyivhrgr` (`KissMyApps`).
- VPS: Hostinger `72.60.125.99`.
- Source revision: `bd960600703c5f30e10e369ceebacd2b0d338deb`.
- Reviewed source tag: `production-20260901-admin-observability-v1`.
- Database migrations:
  - `20260901160000_admin_attribution_overview.sql`;
  - `20260901170000_admin_data_health.sql`.
- Active immutable release:
  `/srv/kissmyapps/releases/20260901T102651Z-admin-observability-bd960600703c`.
- Previous and rollback release:
  `/srv/kissmyapps/releases/20260901T084834Z-admin-funnels-links-dd8b61f17466`.
- Active release link: `/srv/kissmyapps/current`.
- Artifact files: 26.
- Artifact manifest SHA-256:
  `accb830e43d2f9b3bd37ed3937016005604057064229b35c4e901fd197f47927`.
- Production JavaScript: `assets/index-ClurdPmS.js`.
- Production CSS: `assets/index-CRRHF4DW.css`.

## Delivered workflow

- `#admin/attribution` exposes bounded, aggregate-only accepted click,
  acquisition, event, and qualified-conversion evidence for a selected UTC
  window, product, and source.
- Bot-marked clicks remain separate from accepted click totals. Empty systems
  render explicit zero-data states rather than sample traffic.
- `#admin/data-health` exposes aggregate catalog readiness, provider evidence,
  durable queue state, reporting freshness, and reconciliation state.
- Data Health labels database evidence as observed, attention, unobserved, or
  disabled. It does not claim Edge Function deployment, secret presence,
  scheduler execution, or worker liveness.
- Owners, Operations, Finance, and Analyst administrators can read these
  aggregates. Support, ordinary authenticated users, inactive administrators,
  and anonymous callers are denied.
- Raw click IDs, hashes, destination snapshots, account/provider/payment IDs,
  event properties, provider payloads, worker errors, claim tokens, and money
  do not cross either RPC response boundary.

## Database deployment and evidence

- The linked production target was confirmed as `mmyruzjemjecqyivhrgr`.
- The pre-deployment dry run identified exactly the two migrations above, with
  no seed or role-file changes.
- Both migrations were applied successfully. A serial migration-list readback
  matched local and remote history through `20260901170000`.
- Linked `public` schema lint at error level returned no findings.
- Both RPCs use `SECURITY DEFINER` with an empty `search_path`, revoke broad
  execution, grant only `authenticated`, and enforce the active Admin role
  matrix inside the function.
- Anonymous production REST probes returned `401` for both RPCs, proving that
  the deployed contracts exist and fail closed without a session.
- The checked-in pgTAP contracts were not executed against local Supabase or
  Docker because this project intentionally uses production Supabase only.
  They remain future isolated-replay gates and are not counted as passed
  production evidence.

## Source and build evidence

- `pnpm validate` passed in the reviewed checkout and again from a clean
  `git archive` of the production tag.
- Each run passed formatting, oxlint, funnel TypeScript/lint, 38 Vitest files /
  532 tests, application TypeScript, and the Vite production build.
- The only build advisory was the existing chunk-size warning above 500 kB.
- Preview mode was unset. The production artifact contained no statement
  directory, PDF fixture, source map, symlink, Resend key, service-role pattern,
  or Stripe secret-key pattern.
- All 26 checksums passed locally, after upload, and from the active release.

## Immutable deployment evidence

- The candidate was uploaded under a non-live incoming name, checksum-verified,
  made read-only, and renamed into the immutable release directory.
- `/srv/kissmyapps/current` was replaced atomically under the release lock.
- Only `kissmyapps-dashboard` was recreated. It is healthy, read-only, has zero
  restarts, and publishes no host port.
- Dashboard container:
  `beb601a5e1a0e997cca2a08cf75fa4d54ef98780e2663ac10ede7b7560dfd72d`.
- The edge Caddy container was not recreated or restarted:
  `4b9d93ac569b0e87243460d938971ce40f93e2bca71953dc00286e347dd07291`.
- All six non-edge DramaPal container IDs and all seven adjacent restart counts
  remained unchanged.

## Public endpoint and browser evidence

- Partner and Admin roots, health, and representative Attribution/Data Health
  SPA fallback paths returned `200` with valid TLS.
- Admin HTML retained no-store caching, HSTS, `nosniff`, frame denial,
  no-referrer policy, same-origin opener policy, and disabled camera,
  geolocation, and microphone permissions.
- Served JavaScript SHA-256 matched the immutable release manifest.
- Production statement fixtures returned `404`. The Go root remained `404`,
  and a safe `HEAD /r/release-probe` returned `405` without invoking a redirect.
- DramaPal stream, mobile, and sandbox roots returned `200`; its API root kept
  the expected `404`.
- The available in-app browser had no authenticated Admin session and correctly
  redirected `#admin/attribution` to the protected Admin sign-in page. The
  Chrome browser connection was unavailable to this task, so positive
  authenticated module acceptance remains a user-session check.

## Rollback

1. Atomically repoint `/srv/kissmyapps/current` to
   `/srv/kissmyapps/releases/20260901T084834Z-admin-funnels-links-dd8b61f17466`.
2. Recreate only `kissmyapps-dashboard` from
   `/srv/kissmyapps/deploy/compose.yaml` and require its health gate.
3. Recheck Partner/Admin health and SPA routes, Go fail-closed behavior, and all
   DramaPal hosts. Keep Caddy and adjacent services unchanged.
4. Keep `tracking_enabled = false`.

The database migrations are forward-only and compatible with the previous
frontend. Any database correction must be a reviewed forward migration or an
approved provider restore; do not edit or reverse an applied migration.
