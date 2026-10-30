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
  forwards legacy `GET /r/*` and readable two- or three-segment creator URLs
  on `go.kissmyapps.dev` to the same production Supabase redirect function.
  Readable paths preserve Unicode letters/numbers; the Edge function owns
  canonical path validation and existing attribution/readiness checks.
  It also serves the merchant analytics console on `merchant.kissmyapps.dev`
  and forwards only the SDK's `/v1/events` and `/v1/replay` on
  `events.kissmyapps.dev` to the `analytics-ingest` function. That release has
  its own steps, secrets and smoke test in
  [the merchant analytics deploy checklist](../../docs/merchant-analytics-deploy.md).
- `analytics-maintenance.sql` schedules the daily 30-day replay purge.

The dashboard container is read-only, runs as an unprivileged UID with
`no-new-privileges`, has no host port, and stores no secrets. The frontend build
contains only the production Supabase URL and publishable browser key.

Production builds remove the local `public/statements/SAMPLE-*.pdf` design
fixtures, and the static server rejects `/statements/*`. Those files remain
available only to the explicitly enabled local UI preview.

Commercial activation on the production host remains fail-closed. A distinct
Owner-approved tracking-only product may enable redirect/browser-event testing
without Stripe or agreements, but its complete ancestry is permanently
non-commercial. Do not enable Stripe, workers, signed funnel ingestion, or real
acquisition traffic until the commercial activation runbook passes.

The first deployed release was
`/srv/kissmyapps/releases/20260830T063458Z-host-routing-v1`. The approved
2026-09-05 audit repair rollout observed the active pointer at
`/srv/kissmyapps/releases/20260905T002939Z-audit-repairs-6de1142a4638`, with manifest
SHA-256 `6de1142a4638e822d6c2df8e5f10015c0b6cfddd08d37cae0bfb53d28d1e6681`.
The prior `20260904T163307Z-product-delete-collapse-90b301b6ad0f` release is retained.
These are dated observations: resolve `readlink -f /srv/kissmyapps/current` and
record its manifest immediately before every release. See
[release evidence](../../RELEASE_EVIDENCE_2026-09-05_AUDIT_REPAIRS.md).

`agreement-maintenance.sql` is the separately approved, duplicate-guarded
Supabase Cron setup for agreement email/explicit file cleanup. It is active as
job 1, `kma-agreement-maintenance`, once per minute. It contains no credential and
does not schedule commercial processing. Inspect existing jobs before reapplying;
the script refuses a conflicting existing dispatcher job.

The existing DramaPal Caddyfile
backup made immediately before activation is:

`/srv/dramapal/releases/20260812-dual-web-runtime-order-v16/deploy/Caddyfile.pre-kissmyapps-20260830T063458Z.bak`

The 2026-08-30 release used Caddy 2.10.2 with `admin off`. A dashboard-only
release must not write or restart edge Caddy. If a separately reviewed edge
configuration changes, verify the active edge version, validate the full
candidate, write it into the existing bind-mounted Caddyfile inode, and restart
only `dramapal-caddy-1`. Do not run the historical DramaPal Compose project or
prune its containers. A later dashboard release must switch `current` and recreate only
`kissmyapps-dashboard`, because Docker resolves the symlink when the bind mount
is created.
