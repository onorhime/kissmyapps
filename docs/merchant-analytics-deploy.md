# Merchant analytics: deploy checklist

The merchant console (merchant.kissmyapps.dev), the web SDK and the events endpoint
(events.kissmyapps.dev) ship together. Steps 1 to 9 went to production on 2026-10-30; later
releases are listed under [Later releases](#later-releases), each with only what it adds.
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

## 4. Auth redirects and the confirmation email

In Supabase Auth URL configuration, add `https://merchant.kissmyapps.dev/**` to the
redirect URLs. Sign-up confirmation and password reset links return to the page the
merchant started from, so without it those links fall back to the Site URL (the partner
dashboard) and land on a page that cannot use them.

The hosted Confirm signup email is the partner welcome email, and its link opens the
partner dashboard. `supabase/templates/confirmation.html` now has a merchant branch:
the console signs people up with `registration_flow: 'analytics_v1'`, and that branch
sends a merchant email whose button opens
`https://merchant.kissmyapps.dev/#confirm-email?token=...`. The partner and
`merchant_v1` branches are unchanged. In the Supabase dashboard, Authentication, Email
Templates, Confirm signup:

1. Replace the message body with the whole of `supabase/templates/confirmation.html`.
2. Set the subject to this single line, which keeps the partner subject for everyone
   else:

   ```text
   {{ if eq .Data.registration_flow "analytics_v1" }}Confirm your KissMyApps Merchant email{{ else }}Welcome to KissMyApps Partners — confirm your email{{ end }}
   ```

3. Save, reload the page and check both fields read back as pasted.

Until this is done, merchant sign-ups get the partner email and its link signs them in
to the partner dashboard instead of the console. The link works once, on any device, for
one hour; the console can send a new one from the sign-in page and from an expired link.

Password reset needs no template change. Its link only works in the browser that asked
for it (Supabase's PKCE flow); opened anywhere else, the console says the link expired
and offers to send a new one.

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

1. Sign up at https://merchant.kissmyapps.dev. The email's subject is "Confirm your
   KissMyApps Merchant email" and its button opens the console signed in; open it on your
   phone to check it works away from the sign-up browser. Create a project.
2. Settings, Install SDK: copy the snippet into any test page on a site listed under
   allowed websites (or leave the list empty), and open it from a phone and a laptop.
3. Overview and Users show you online with the right country and device within a few
   seconds. Open your session: the events are listed and the replay plays.
4. Settings, Members: invite a second address, copy its invite link, open it in a
   private window and sign up. The new member joins as an analyst.
5. Sign up once on https://partners.kissmyapps.dev too and check the partner welcome
   email is unchanged.
6. `curl -i https://events.kissmyapps.dev/` answers 404, and
   `curl -i -X POST -H 'content-type: application/json' -d '{}' https://events.kissmyapps.dev/v1/events`
   answers 401 `invalid_key`.

## Later releases

### Funnels

Not deployed yet. Funnels are calculated from the stored events when they are read, so
past visits show up straight away and nothing has to be backfilled.

1. Apply `supabase/migrations/20261030140000_merchant_funnels.sql`. It adds the
   `analytics_funnels` table and the `analytics_funnels`, `analytics_save_funnel`,
   `analytics_delete_funnel`, `analytics_funnel_options`, `analytics_funnel_report` and
   `analytics_funnel_people` functions, and changes nothing that exists.
2. Release the dashboard as in step 6. No secrets, ingest function, DNS or Caddy changes.
3. Smoke test: in the console, Analytics, Funnels, build a two-step funnel from a page and an
   event your test site sends, save it, and check the counts and the people behind a drop.

### Retention

Not deployed yet. Like funnels, retention is worked out from the stored events when it is
read, so the cohorts fill in from past visits straight away.

1. Apply `supabase/migrations/20261030150000_merchant_retention.sql` after the funnels
   migration, which it builds on. It adds the `analytics_retention_report`,
   `analytics_retention_people` and `analytics_retention_summary` functions and their
   helpers, and changes nothing that exists.
2. Release the dashboard as in step 6. No secrets, ingest function, DNS or Caddy changes.
3. Smoke test: the Overview shows "Back on day 7" (a dash is right for a project younger
   than eight days). Open it, check Days, Weeks and Months each draw a table, choose a
   shaded cell and check the people listed, then group the rows by device.

## Not in this release

- No native mobile SDKs: apps send events over the HTTP API (Install SDK shows how), and
  there are no replays for apps.
- Location: as deployed on the VPS, nothing in front of the events host tells the
  function where an address is, so a visitor's country comes from their device's time
  zone (a VPN or a traveller shows their home zone's country) and there are no regions or
  cities. Exact countries and cities need either a CDN that adds visitor location
  headers (step 7) or an IP geolocation lookup in the function, which is not built.
- Invitations send no email: after inviting someone, a member copies their invite link
  from Settings, Members and sends it to them.
- A replay ends at the last recorded change, so idle time at the end of a page is not shown.
