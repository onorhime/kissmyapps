# Merchant analytics: deploy checklist

The merchant console (merchant.kissmyapps.dev), the web SDK and the events endpoint
(events.kissmyapps.dev) ship together. Nothing below has been applied to production yet.
Do the steps in order; each one is safe to repeat.

## 1. Database

Apply `supabase/migrations/20261030100000_merchant_analytics.sql` to project
`mmyruzjemjecqyivhrgr` the same way as the other migrations. It only adds `analytics_*`
tables and functions and touches nothing that already exists.

## 2. Secrets for the ingest function

Generate two random values, for example with `openssl rand -hex 32`, and set them as
Edge Function secrets:

| Secret                   | What it does                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ANALYTICS_IP_SALT`      | Salts the hash of each visitor's address, which network blocks match on. Set it once and keep it: a new salt makes existing network blocks miss. |
| `ANALYTICS_PROXY_SECRET` | Lets the events.kissmyapps.dev proxy name the visitor's address and place. The edge Caddy sends the same value as `KMA_ANALYTICS_PROXY_SECRET`.  |

```sh
supabase secrets set --project-ref mmyruzjemjecqyivhrgr \
  ANALYTICS_IP_SALT=... ANALYTICS_PROXY_SECRET=...
```

## 3. Ingest function

```sh
supabase functions deploy analytics-ingest --project-ref mmyruzjemjecqyivhrgr --no-verify-jwt
```

`supabase/config.toml` already sets `verify_jwt = false` for it: the SDK authenticates
with the project's API key, not a user session.

## 4. Auth redirects

In Supabase Auth URL configuration, add `https://merchant.kissmyapps.dev/**` to the
redirect URLs. Sign-up confirmation and password reset links return to the page the
merchant started from, so without it those links fall back to the Site URL.

## 5. DNS

Point `merchant.kissmyapps.dev` and `events.kissmyapps.dev` at the Hostinger VPS, like
`partners` and `admin`.

## 6. Dashboard release

`pnpm build` writes the console and the SDK (`dist/sdk/kma.js`, `dist/sdk/kma-replay.js`)
into the same `dist`, so the usual dashboard release ships both. The build defaults to
`https://events.kissmyapps.dev` for events and `https://merchant.kissmyapps.dev/sdk/kma.js`
for the snippet; `VITE_ANALYTICS_ENDPOINT` and `VITE_ANALYTICS_SDK_URL` override them.

`deploy/hostinger/dashboard.Caddyfile` changed: `/sdk/*` is now cached for five minutes
instead of `no-store`, because customer sites load it on every page. Copy it to
`/srv/kissmyapps/deploy/dashboard.Caddyfile` and recreate only `kissmyapps-dashboard`
as the hosting README describes.

## 7. Edge Caddy

`deploy/hostinger/Caddyfile.production` (and the standalone `Caddyfile.kissmyapps`) adds:

- `merchant.kissmyapps.dev`, served by the dashboard container like `partners` and `admin`.
- `events.kissmyapps.dev`, which forwards only `POST /v1/events` and `/v1/replay` (and their
  CORS preflights) to the `analytics-ingest` function and answers 404 to everything else.
  It strips any `X-Kma-*` header the browser sent, then adds the visitor's address and
  `X-Kma-Proxy: {env.KMA_ANALYTICS_PROXY_SECRET}`.

The edge container `dramapal-caddy-1` needs `KMA_ANALYTICS_PROXY_SECRET` in its
environment with the same value as `ANALYTICS_PROXY_SECRET`. If that container cannot be
recreated with a new variable, write the value in place of the placeholder in the host's
copy of the Caddyfile only, and never commit it. Then validate the full candidate and
restart only `dramapal-caddy-1`, as the hosting README requires.

If the secret is missing or wrong, events still arrive, but the function ignores the
proxy's headers: visitors get no address (so network blocks cannot match them) and their
country comes from their browser's time zone.

If Cloudflare is ever put in front of these hosts, configure Caddy's `trusted_proxies`
with Cloudflare's ranges and `client_ip_headers Cf-Connecting-Ip`, otherwise
`{client_ip}` is Cloudflare's address. With Cloudflare's "Add visitor location headers"
managed transform on, uncomment the three `X-Kma-Country/Region/City` lines in the
events block to get regions and cities.

## 8. Replay retention

The console tells merchants that replays are kept for 30 days. Apply
`deploy/hostinger/analytics-maintenance.sql` once: it schedules
`public.analytics_purge_replays()` daily at 03:17 UTC with pg_cron, refuses to add a
duplicate, and holds no credential.

## 9. Smoke test after deploy

1. Sign up at https://merchant.kissmyapps.dev, confirm the email, create a project.
2. Settings, Install SDK: copy the snippet into any test page on a site listed under
   allowed websites (or leave the list empty), and open it from a phone and a laptop.
3. Overview and Users show you online with the right country and device within a few
   seconds. Open your session: the events are listed and the replay plays.
4. `curl -i https://events.kissmyapps.dev/` answers 404, and
   `curl -i -X POST -H 'content-type: application/json' -d '{}' https://events.kissmyapps.dev/v1/events`
   answers 401 `invalid_key`.

## Not in this release

- No native mobile SDKs: apps send events over the HTTP API (Install SDK shows how), and
  there are no replays for apps.
- Cities and regions need visitor location headers from a CDN in front of the events host
  (step 7). Without them the console shows countries only.
- A replay ends at the last recorded change, so idle time at the end of a page is not shown.
