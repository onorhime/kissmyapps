# KissMyApps Hostinger release evidence — 2026-08-30

This record covers the first production hosting release for the Partner/Admin
dashboard and redirect gateway. It does not activate tracking, Stripe, funnels,
workers, payouts, email, or public partner signup.

## Release identity

- Supabase project: `mmyruzjemjecqyivhrgr` (`KissMyApps`).
- VPS: Hostinger `72.60.125.99`.
- Release: `/srv/kissmyapps/releases/20260830T063458Z-host-routing-v1`.
- Active release link: `/srv/kissmyapps/current`.
- Frontend manifest SHA-256: `9e36643d4151d1a2b8515a9e52d771a61a8b3a41c4738795a5fdb9a1e0853976`.
- Edge Caddyfile SHA-256: `7f8ae733df2b720b0037f64fb45e20878c895f0e4095dc9033df71deaf28fc32`.
- Dashboard Caddyfile SHA-256: `7952ff6e2761270f4e5ecf5c489c9942a5b16a769af7ec3ae182df027d92bf86`.
- Dashboard Compose SHA-256: `ed19d3e1b31e8c87f835236b1749135077c331aa1492ff7153bca9f1a7cf456e`.

The repository still has no reviewed Git `HEAD`; these hashes identify this
release but do not replace the outstanding commit/tag gate for later releases.

## Source and artifact checks

- Formatting, oxlint, funnel TypeScript/lint, and the production TypeScript build passed.
- All 33 test files and 409 tests passed with one worker. The earlier two-worker
  run produced three timing-only 5-second failures; all affected suites passed
  independently before the stable full run.
- Production build completed with `VITE_ENABLE_UI_PREVIEW` absent.
- `dist/` contains no PDF or `statements/` artifact.
- The deployed artifact matches the local release by checksum-aware `rsync` dry run.
- The deployed bundle contains the expected Supabase project URL and publishable
  browser key only. No service-role, Stripe, HMAC, worker, or Management API
  credential was deployed.
- Caddy 2.10.2 validated the dashboard and full edge configurations before activation.

## Runtime topology and hardening

- `kissmyapps-dashboard` is healthy, read-only, runs as UID/GID `65532`, has
  `no-new-privileges`, a 128 MiB memory limit, a 64 PID limit, bounded logs, and
  no published host port.
- Its Linux capability bounding/effective sets contain only
  `CAP_NET_BIND_SERVICE`, required by the file capability on the pinned official
  Caddy image; the service itself listens on unprivileged Docker port 8080.
- The image is pinned to
  `caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d`.
- `/healthz` returns a two-byte `200` response. `/statements/*` returns `404`.
  SPA deep links return the application shell with `Cache-Control: no-store`;
  hashed `/assets/*` use one-year immutable caching.
- The existing `dramapal-caddy-1` remains the only public 80/443 listener. Only
  this container was restarted; no DramaPal application/database container or
  historical Compose project was changed.

## Public checks

- `https://partners.kissmyapps.dev` returns `200`, valid TLS, HSTS, security
  headers, `no-store`, and the Partner sign-in workspace by hostname.
- `https://admin.kissmyapps.dev` returns `200`, valid TLS, HSTS, security headers,
  `no-store`, and the Admin sign-in workspace by hostname.
- Desktop and 390x844 in-app-browser checks confirmed the correct Partner/Admin
  titles, copy, form semantics, 342 px cards within a 390 px viewport, and no
  horizontal document overflow. Detailed observations are recorded in
  [BROWSER_QA.md](./BROWSER_QA.md).
- `https://go.kissmyapps.dev/` returns `404`; `POST /r/*` returns `405`; an
  unissued `GET /r/*` reaches the production Edge Function and fails closed with
  `404` and no redirect.
- The go surface sends `no-store`, HSTS, and `noindex` headers. Tracking remains
  disabled, with no live link/funnel available.

## Existing-service regression

After the edge activation:

- `stream.dramapal.pro` returned `200`;
- `mobile.dramapal.pro` returned `200`;
- `sandbox.dramapal.pro` returned `200`;
- `api.dramapal.pro` retained its expected root `404`; and
- all DramaPal application/database containers retained their prior healthy/running state.

The recoverable pre-change Caddyfile is:

`/srv/dramapal/releases/20260812-dual-web-runtime-order-v16/deploy/Caddyfile.pre-kissmyapps-20260830T063458Z.bak`

## Hosted Auth configuration

The Management API update was guarded by an exact old-value assertion and sent
only `site_url` and `uri_allow_list`. The existing CLI credential stayed in
process memory and was never printed, stored in the repository, or passed as a
command argument.

- Site URL: `https://partners.kissmyapps.dev`.
- Redirect allowlist:
  `https://partners.kissmyapps.dev/#auth/reset,https://admin.kissmyapps.dev/#auth/reset`.
- Public signup remains disabled.
- Minimum password length remains 12.
- `go.kissmyapps.dev` is not an Auth callback origin.

## Retained gates

- The authenticated production Partner/Admin session, role boundary, and live
  sign-out still need a browser-session check; the available in-app browser was
  intentionally unauthenticated and the user's Chrome extension was not connected.
- Tracking remains disabled. There is no real funnel/link, live Stripe Price or
  secret, signed agreement, worker schedule, payout release provider, approved
  retention operation, Resend integration, Singular integration, or Amplitude
  outbound pipeline.
- The existing draft `test` product is not live and is not partner-visible.
- Do not run a database reset/replay without its separate destructive-maintenance
  approval and verified restore point.

## Rollback

1. Restore the backup above into the existing bind-mounted Caddyfile inode.
2. Validate it with the pinned Caddy image, then restart only `dramapal-caddy-1`.
3. Recheck every DramaPal host.
4. Stop/remove only the `kissmyapps-dashboard` Compose project if the dashboard
   must be withdrawn; retain the immutable release for evidence.
5. For a frontend-only rollback, repoint `/srv/kissmyapps/current` to the prior
   immutable release and recreate only `kissmyapps-dashboard`.
6. Keep tracking disabled throughout rollback.
