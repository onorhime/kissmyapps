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

Deployed 2026-10-30 (release `20261030T222002Z-funnels-retention-places-ddfeeea88981`, from
fbb4c28). Funnels are calculated from the stored events when they are read, so past visits
show up straight away and nothing has to be backfilled.

1. Apply `supabase/migrations/20261030140000_merchant_funnels.sql`. It adds the
   `analytics_funnels` table and the `analytics_funnels`, `analytics_save_funnel`,
   `analytics_delete_funnel`, `analytics_funnel_options`, `analytics_funnel_report` and
   `analytics_funnel_people` functions, and changes nothing that exists.
2. Release the dashboard as in step 6. No secrets, ingest function, DNS or Caddy changes.
3. Smoke test: in the console, Analytics, Funnels, build a two-step funnel from a page and an
   event your test site sends, save it, and check the counts and the people behind a drop.

### Retention

Deployed 2026-10-30 with funnels. Like funnels, retention is worked out from the stored
events when it is read, so the cohorts fill in from past visits straight away.

1. Apply `supabase/migrations/20261030150000_merchant_retention.sql` after the funnels
   migration, which it builds on. It adds the `analytics_retention_report`,
   `analytics_retention_people` and `analytics_retention_summary` functions and their
   helpers, and changes nothing that exists.
2. Release the dashboard as in step 6. No secrets, ingest function, DNS or Caddy changes.
3. Smoke test: the Overview shows "Back on day 7" (a dash is right for a project younger
   than eight days). Open it, check Days, Weeks and Months each draw a table, choose a
   shaded cell and check the people listed, then group the rows by device.

### City location

Deployed 2026-10-30 with funnels: the relay runs with the 2026-10 database, the edge's
events block points at it, and the old block is backed up in
`/srv/kissmyapps/edge-backups/20261030-geo-relay/Caddyfile`.

A small relay on the VPS, `kissmyapps-geo`, sits between the edge Caddy and the
`analytics-ingest` function. It looks each visitor's address up in DB-IP's free
city database (IP to City Lite, CC BY 4.0) and passes the request on with the country,
region and city. It also takes over the proxy secret, so the live Caddyfile no longer
holds it. Addresses are only looked up, never stored. The Overview's countries open into
their regions and cities, and Users can be filtered by region or city.

If the relay has no database, or does not know an address, events still go through and
the country falls back to the device's time zone, as today. If the relay is down, Caddy
retries for five seconds and then the SDK's request fails and is retried by the SDK.

1. Disk. The database is about 120 MB and a new month's file is checked beside the old
   one before the swap, so the relay will not download with less than 400 MB free. On
   23 Oct the VPS disk was 97% full: run `df -h /srv` and free space first if needed.
2. Apply `supabase/migrations/20261030160000_merchant_places.sql` after the retention
   migration. It adds `analytics_places`, gives `analytics_people_page` region and city
   filters (same signature, so the live console keeps working), and replaces two internal
   ingest helpers so a session's or person's place is always stored whole.
3. Deploy the ingest function as in step 3. It reads the relay's place headers, and still
   reads today's Caddy headers the same way as before, so it can go out first.
4. Relay files and secret, on the VPS:

   ```sh
   install -d -m 755 /srv/kissmyapps/deploy/geo-relay
   cp deploy/geo-relay/mmdb.mjs deploy/geo-relay/relay.mjs deploy/geo-relay/server.mjs \
     /srv/kissmyapps/deploy/geo-relay/
   install -d -o 1000 -g 1000 -m 700 /srv/kissmyapps/geo-data
   # The same value as the function's ANALYTICS_PROXY_SECRET (it is in the live
   # Caddyfile's events block today). Root-owned, never committed.
   install -m 600 /dev/null /srv/kissmyapps/geo-relay.env
   printf 'KMA_ANALYTICS_PROXY_SECRET=%s\n' '...' > /srv/kissmyapps/geo-relay.env
   docker pull node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
   ```

5. Start only the relay from the updated `deploy/hostinger/compose.yaml` (its new `geo`
   service): `docker compose -p kissmyapps-dashboard -f <host copy>/compose.yaml up -d geo`.
   This does not touch `kissmyapps-dashboard`. Within a few seconds it downloads this
   month's file from download.db-ip.com; `docker logs kissmyapps-geo` says "Loaded the
   YYYY-MM database", and
   `docker exec kissmyapps-geo node -e "fetch('http://127.0.0.1:8787/healthz').then(r => r.text()).then(console.log)"`
   shows the database and no problem. If the VPS cannot reach DB-IP, download
   `dbip-city-lite-YYYY-MM.mmdb.gz` from https://db-ip.com/db/download/ip-to-city-lite
   elsewhere, gunzip it to `/srv/kissmyapps/geo-data/dbip-city-lite.mmdb` (owned by
   1000:1000) and restart the container.
6. Check the edge can reach it before switching:
   `docker exec dramapal-caddy-1 wget -qO- http://kissmyapps-geo:8787/healthz`.
7. Edge Caddy. Back up the live Caddyfile, then in its `events.kissmyapps.dev` block replace
   the `rewrite` line and the `reverse_proxy https://mmyruzjemjecqyivhrgr.supabase.co {...}`
   block (the one with the plain-text secret) with the repo's:

   ```caddyfile
   reverse_proxy kissmyapps-geo:8787 {
   	header_up X-Kma-Client-Ip {client_ip}
   	lb_try_duration 5s
   }
   ```

   Keep `request_header -X-Kma-*` above it. Validate the full candidate and restart only
   `dramapal-caddy-1`, as the hosting README requires. The secret is now only in
   `geo-relay.env` and the function's secrets.

8. Release the dashboard as in step 6 (the drill-down, the Users filter, full places, and
   the "IP geolocation by DB-IP" credit in the console's footer, which the licence needs).
9. Smoke test: `curl -i -X POST -H 'content-type: application/json' -d '{}' https://events.kissmyapps.dev/v1/events`
   still answers 401 `invalid_key`. Open a test page on your phone (on mobile data) and
   laptop: in the Overview, Where they are, choose your country and find your city; your
   session's Location reads "City, Region, Country" and "From their internet address".

Rollback: put the previous events block back from the backup and restart only
`dramapal-caddy-1`. The relay can keep running or be stopped with
`docker compose -p kissmyapps-dashboard stop geo`; events flow either way.

Monthly update: the relay checks once a day and swaps in the new month's file without a
restart, once DB-IP publishes it (usually on the 1st or 2nd). In the first days of each
month, check `healthz` shows the month's `built` date and no `problem` (a full disk or a
failed download shows there and in the logs, and the old file keeps working).

### Mobile SDKs

iOS and Android released 2026-10-30 as 1.0.0 at https://github.com/onorhime/kissmyapps-mobile,
built by JitPack. React Native published to npm as `@kissmyappss/react-native` 1.0.0 the
same day. Flutter (`kissmyapps` on pub.dev) is in the repository but not published yet: see
step 3.

SDKs for iOS (Swift package), Android (Kotlin, built by JitPack), React Native (npm) and
Flutter (pub.dev) record installs, updates, opens, time in the app, sessions and screens on their own, and keep events on the phone while it is offline. They send the same
`/v1/events` requests as the HTTP API, so the live ingest function and database already
accept them: there is nothing to migrate or redeploy for them. The ingest function's
`contract_test.ts` and each SDK's tests check the same file,
`integrations/analytics-mobile/contract/app-events.json`. There are no replays for apps.

1. The public repository for iOS and Android. Swift Package Manager and JitPack need
   `Package.swift` and `jitpack.yml` at a repository's root, so
   `integrations/analytics-mobile` is published as its own public repository. The console
   assumes `https://github.com/onorhime/kissmyapps-mobile`; for another name, change
   `MOBILE_SDK.repository` in `src/merchant/config.ts` (or set
   `VITE_MOBILE_SDK_REPOSITORY` for the dashboard build). The public repository gets the
   folder as one clean commit per release, not the monorepo's history:

   ```sh
   git fetch https://github.com/onorhime/kissmyapps.git main
   # First release; for later ones add -p <the public repository's current main>.
   C=$(git commit-tree FETCH_HEAD:integrations/analytics-mobile -m "KissMyApps mobile SDK 1.0.0")
   git push https://github.com/onorhime/kissmyapps-mobile.git "$C:refs/heads/main"
   ```

   Tag `1.0.0` in that repository (add the release to `CHANGELOG.md` first) and open
   https://jitpack.io/#onorhime/kissmyapps-mobile/1.0.0 once, so JitPack builds it before
   the first app asks for it. The folder's `.github/workflows/ci.yml` only runs there, where
   it tests both SDKs on every push and tag and feeds the README's CI badge.
2. npm. The scope belongs to the `kissmyappss` organization on npmjs.com (`kissmyapps` was
   taken). From a machine logged in to an account in that organization, run
   `cd integrations/analytics-react-native && npm publish` (it builds `lib/` first and
   publishes `@kissmyappss/react-native` publicly).
3. pub.dev. The Flutter package is `integrations/analytics-mobile/flutter`, so it is also
   `flutter/` in the public repository, which its `repository` link in `pubspec.yaml`
   points at. Publish from that folder in either repository with a Google account:
   `cd flutter && flutter pub publish`. The first publish asks to sign in in the browser
   and makes that account the package's uploader; afterwards, move the package to a
   verified publisher (for example kissmyapps.dev, verified with a DNS record) under the
   package's Admin tab on pub.dev if you want one. A later version needs `version` in
   `pubspec.yaml`, `sdkVersion` in `lib/src/client.dart` and `s.version` in the podspec
   raised together, and an entry in its `CHANGELOG.md`.
4. Licence. Every SDK folder says MIT; change their `LICENSE` files and the React Native
   `package.json` first if you want another licence.
5. Release the dashboard as in step 6: Install SDK gains iOS, Android, React Native,
   Flutter and HTTP tabs with the project's key filled in.
6. Smoke test: in a test app, start the SDK with a development client key and open the app.
   Within a minute Install SDK's "Check your setup" lists "iOS app (development)" or
   "Android app (development)". With a live key, Sessions shows the session with its
   device model, OS, app version and first screen.

`.github/workflows/mobile-sdks.yml` tests every SDK and builds the Android library, the iOS
package and the Flutter example app (for Android, and for iOS with both CocoaPods and Swift
Package Manager) whenever they change. The Flutter tests also run on Flutter 3.24, the
oldest version the package supports.

## Not in this release

- Replays for apps: the mobile SDKs record events, sessions and screens, not replays.
- Location: when the relay has no database or does not know an address, a visitor's
  country comes from their device's time zone (a VPN or a traveller shows their home
  zone's country) and there is no region or city.
- Invitations send no email: after inviting someone, a member copies their invite link
  from Settings, Members and sends it to them.
- A replay ends at the last recorded change, so idle time at the end of a page is not shown.
