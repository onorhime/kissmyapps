# KissMyApps tracking-only demo release evidence — 2026-09-01

This record covers the production database and frontend release that adds a
strictly non-commercial product mode for exercising redirect, source/campaign,
and approved browser-event attribution before a real funnel or Stripe product
exists. It does not claim authenticated product/link provisioning or traffic
acceptance; the available controlled browser session was signed out at that
gate.

## Approval and release identity

- Production migration and deployment were approved by the user in the active
  Codex task on 2026-09-01.
- Supabase project: `mmyruzjemjecqyivhrgr` (`KissMyApps`).
- VPS: Hostinger `72.60.125.99`.
- Source revision: `38e8410c8e563f3b52961a946fe3e0f1677fd80b`.
- Reviewed source tag: `production-20260901-tracking-only-demo-v1`.
- Database migration: `20260901190000_tracking_only_demo_mode.sql`.
- Active immutable release:
  `/srv/kissmyapps/releases/20260901T173438Z-tracking-only-demo-38e8410c8e56`.
- Previous and rollback release:
  `/srv/kissmyapps/releases/20260901T112904Z-admin-platform-settings-e4649427be8a`.
- Active release link: `/srv/kissmyapps/current`.
- Artifact files: 30; artifact bytes: 1,678,956.
- Artifact manifest SHA-256:
  `35e56aa425f4a8ae68538f03b9d9055f7db7a66cf0be19f9865e3bfbd020bb15`.
- Production JavaScript: `assets/dashboard-ztKr6LV7.js`.
- Production CSS: `assets/dashboard-CCTPkEmg.css`.
- Demo page: `https://partners.kissmyapps.dev/demo-funnel.html`.

## Delivered non-commercial contract

- An Owner can deliberately approve `tracking_only` mode against the exact live
  default funnel ID and destination snapshot. Editing that funnel invalidates
  the approval until it is reviewed again.
- Tracking-only readiness does not require a Stripe Price, billing offer,
  agreement, commission rule, or payout setup. Those commercial sections remain
  unavailable for that product instead of displaying fabricated zero values.
- Every issued tracking-only main/derived link, click, acquisition, and accepted
  funnel event carries immutable `commercial_eligible = false` provenance.
- Database guards reject agreements, offers, Checkout, subscriptions,
  conversions, commissions, payouts, refunds, disputes, and commercial metrics
  for that ancestry. Browser and funnel events cannot elevate the scope.
- After any tracking-only click or event exists, the product cannot be converted
  to commercial mode. A later real launch must use a separate commercial product.
- A Partner-derived link must name its exact current main-link parent. Source,
  campaign, funnel, and Sub-ID dimensions are validated server-side.
- Partner summary/trend RPCs report clicks, distinct visitors, funnel starts,
  payment views, and app-store clicks directly from canonical records, including
  numeric zeroes for event-only windows and source-level breakdowns.
- The owned demo page records only `landing_viewed`, `funnel_started`,
  `payment_viewed`, and `app_store_clicked`. It has no auth, checkout, payment,
  PII collection, or third-party analytics and is marked `noindex`.

## Database and Edge evidence

- The linked pre-deployment dry run identified exactly
  `20260901190000_tracking_only_demo_mode.sql`, with no seeds or role files.
- The transaction applied successfully. Remote migration history now matches all
  20 local versions through `20260901190000`; the post-deployment dry run reports
  the database up to date.
- Linked schema lint returned no errors and retained only five pre-existing
  unused-variable warnings in `normalize_stripe_provider_event`.
- `BROWSER_EVENT_ALLOWED_ORIGINS` is set to the single production Partner origin.
  A production preflight from `https://partners.kissmyapps.dev` returned `204`;
  an untrusted origin returned `403`.
- Anonymous calls to `get_admin_platform_settings`,
  `set_admin_product_tracking_mode`, and `create_partner_link` returned `401`.
- The checked-in pgTAP contract covers approval snapshots, immutable provenance,
  direct commercial-write rejection, exact-parent link derivation, immediate
  source/event reporting, and event-only zero consistency. It was reviewed but
  not executed against local Supabase/Docker because this project explicitly
  excludes a local database.

## Source and build evidence

- `pnpm validate` passed formatting, warning-free lint, the funnel integration
  contract, 43 Vitest files / 590 tests, TypeScript, and the production build.
- Deno formatting checked 36 files, lint checked 34 files, all ten Function
  entrypoints type-checked, and 51 of 51 Edge tests passed.
- The artifact was built from a clean `git archive` of the reviewed tag with
  preview mode unset and only the production Supabase URL and publishable key.
- The 30-file artifact contains no statements fixture, PDF, source map,
  environment file, symlink, private-key marker, Resend key, Stripe secret-key
  pattern, or Supabase secret-key pattern.
- All checksums passed locally, after upload, and from the active release.

## Immutable deployment evidence

- The candidate was checksum-verified outside the live path, made
  root-owned/read-only, and atomically moved into the releases directory.
- `/srv/kissmyapps/current` was switched under the release lock. Only Compose
  service `dashboard` was recreated.
- `kissmyapps-dashboard` is healthy, read-only, runs as `65532:65532`, has zero
  restarts, and publishes no host port. Container ID:
  `decd38aae0952770842a5b73a842b898148c465cad5a9da760dfea6ee119f9cf`.
- Edge Caddy was not written or restarted. Its ID remains
  `4b9d93ac569b0e87243460d938971ce40f93e2bca71953dc00286e347dd07291`,
  restart count remains zero, and its Caddyfile SHA-256 remains
  `7f8ae733df2b720b0037f64fb45e20878c895f0e4095dc9033df71deaf28fc32`.
- All nine adjacent DramaPal container records, including two stopped historical
  containers and seven running services, retained the same IDs and restart counts.

## Public endpoint evidence

- Partner/Admin roots, health checks, and representative SPA paths returned
  `200`; the production demo page returned `200`; statement fixtures returned
  `404`.
- Partner HTML retains no-store, HSTS, `nosniff`, and no-referrer headers. The
  demo HTML includes `noindex`.
- The served dashboard JavaScript, CSS, and demo HTML matched the immutable local
  artifact byte for byte.
- `go.kissmyapps.dev` remains fail closed without a valid link: root `404` and a
  safe `HEAD /r/release-probe` returned `405`.
- DramaPal stream, mobile, and sandbox roots remained `200`; its API root retained
  the expected `404`.

## Open authenticated acceptance gate

No demo product, funnel record, source, campaign, main link, derived link, click,
or event was created during this release. The controlled in-app browser was
signed out and the Chrome control connection was unavailable. A password-proven
Owner must sign in before the remaining production acceptance can create the
separate demo product, approve its exact funnel snapshot, enable tracking, issue
the test Partner main link, and exercise TikTok/Instagram derived links. Stripe,
agreements, commissions, payouts, and transfer automation remain untouched.

## Rollback

1. Under `/srv/kissmyapps/.release.lock`, atomically repoint
   `/srv/kissmyapps/current` to
   `/srv/kissmyapps/releases/20260901T112904Z-admin-platform-settings-e4649427be8a`.
2. Recreate only service `dashboard` from
   `/srv/kissmyapps/deploy/compose.yaml` and require its health gate.
3. Recheck Partner/Admin, Go fail-closed behavior, the Caddy hash, and all
   DramaPal records. Keep Caddy and adjacent services unchanged.
4. Do not reverse the database migration in place. Use a reviewed forward
   migration or an approved provider restore.
