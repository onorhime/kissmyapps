# Hostinger production deployment

These files deploy the KissMyApps Partner/Admin dashboard beside the existing
DramaPal Docker stack without publishing another host port.

- `dashboard.Caddyfile` serves the immutable Vite build inside the isolated
  `kissmyapps-dashboard` container on Docker port 8080.
- `compose.yaml` attaches that container to the existing external
  `dramapal_application` network so the current edge Caddy container can reach
  it by name.
- `Caddyfile.kissmyapps` is the standalone additive snippet.
- `Caddyfile.production` is the validated full edge configuration for this
  release. It preserves all existing DramaPal hosts, serves the same hardened
  dashboard build on `partners.kissmyapps.dev` and `admin.kissmyapps.dev`, and
  forwards only `GET /r/*` on `go.kissmyapps.dev` to the production Supabase
  redirect function.

The dashboard container is read-only, runs as an unprivileged UID with
`no-new-privileges`, has no host port, and stores no secrets. The frontend build
contains only the production Supabase URL and publishable browser key.

Production builds remove the local `public/statements/SAMPLE-*.pdf` design
fixtures, and the static server rejects `/statements/*`. Those files remain
available only to the explicitly enabled local UI preview.

Feature activation on the production host remains fail-closed: do not enable
tracking, Stripe, workers, or funnel ingestion until the real funnel, signed
agreement, and live Stripe configuration pass the activation runbook.

The first deployed release is
`/srv/kissmyapps/releases/20260830T063458Z-host-routing-v1`; the active symlink is
`/srv/kissmyapps/current`. The existing DramaPal Caddyfile backup made immediately
before activation is:

`/srv/dramapal/releases/20260812-dual-web-runtime-order-v16/deploy/Caddyfile.pre-kissmyapps-20260830T063458Z.bak`

The 2026-08-30 release used Caddy 2.10.2 with `admin off`. Before a later release,
verify the active edge version, validate the full candidate, write it into the
existing bind-mounted Caddyfile inode, and restart only `dramapal-caddy-1`. Do not
run the historical DramaPal Compose project or prune its containers. A later
dashboard release must switch `current` and recreate only
`kissmyapps-dashboard`, because Docker resolves the symlink when the bind mount
is created.
