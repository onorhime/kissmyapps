# KMA journey dashboard frontend release

Deployed on 22 October 2026 after the journey migration and receiver verification.
The sanitized machine-readable evidence is in `frontend-release.json`.

- Release: `20261022T110032Z-journey-reporting-32527210e553`.
- Archive SHA256: `1ad74f128a85b316dbe4df8840bf298a81d8742bfbf81245239e767951b03431`.
- Archive: 680,445 bytes, containing 34 verified assets and `SHA256SUMS`.
- The frontend source and assets matched the previously tested immutable manifest.
  No source rebuild or dirty-worktree commit was needed for the cutover.
- Current: `/srv/kissmyapps/releases/20261022T110032Z-journey-reporting-32527210e553`.
- Rollback: `/srv/kissmyapps/releases/20261019T150414Z-merchant-invitation-auto-otp-5f7ad1a1bddf`.

## Hosted verification

All 78 checks passed across `admin.kissmyapps.dev` and `partners.kissmyapps.dev`:

- Every asset matches the candidate SHA256.
- Root and merchant connection/callback routes return the expected application.
- Health endpoints return `ok`; the sample statement probe returns 404.
- Application responses use `no-store`; hashed assets use immutable caching.
- Application headers retain `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, and the existing Stripe-compatible
  `Cross-Origin-Opener-Policy: unsafe-none`.

The dashboard container is healthy with zero restarts. Its existing Caddy image,
Compose file, and Caddy configuration were preserved. All 15 other containers
retained their exact image IDs and start timestamps, verified during cutover and
again in the postflight snapshot. Approximately 3.79 GiB remained free afterward.

Only the dashboard release pointer and its container were changed. Checkout and
payout flags were not changed, no images or archives were deleted, and no provider
jobs were triggered. Backend and financial-gate evidence is recorded separately
in `backend-release.json`.

These checks prove deployed frontend bytes, routing, headers, and container health.
They do not substitute for authenticated reporting checks with attributed traffic.
