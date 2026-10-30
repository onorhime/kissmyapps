# Geo relay

The events relay for `events.kissmyapps.dev`. The edge Caddy sends each SDK request here
with the visitor's address in `X-Kma-Client-Ip`; the relay looks the address up in
DB-IP's free city database and passes the request on to the `analytics-ingest` function
with the place (`X-Kma-Country`, and percent-encoded `X-Kma-Region` and `X-Kma-City`) and
the proxy secret. For a server key it also looks up the address the merchant's server
names in `context.ip`. Addresses are only looked up, never written down.

- `mmdb.mjs` reads MaxMind DB files (the format DB-IP publishes), with nothing but Node.
- `relay.mjs` is the request handler.
- `server.mjs` runs it, loads the database, and once a day checks for the month's new file,
  downloads it beside the old one, checks it, and swaps it in without a restart.
- `mmdb-writer.mjs` writes small databases for tests only.

It runs as the `geo` service in `deploy/hostinger/compose.yaml`; the steps are under
"City location" in `docs/merchant-analytics-deploy.md`. Tests:
`node --test scripts/geo-relay.test.mjs`.

IP geolocation by DB-IP (https://db-ip.com), licensed under CC BY 4.0. The console's
footer carries the credit the licence asks for.
