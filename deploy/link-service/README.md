# Link service

Answers every merchant link domain for attribution: each project's subdomain of the link
root (today `<name>.go.kissmyapps.dev`) and any domain of the merchant's own. The edge
Caddy sends it every request for a host that has no block of its own, and asks it before
getting a certificate for a host, so certificates are only issued for link domains.

- `links.mjs` is the request handler, the certificate check and the client for the
  `attribution-links` function. It keeps each host's answer for a minute (15 seconds for
  an unknown host) and, while the database cannot be reached, answers from the last one.
- `server.mjs` runs public traffic on `PORT` (8788) and the certificate check on
  `ASK_PORT` (8789). Only the edge Caddy reaches either.

What it serves today (Phase 0):

| Path                                      | Answer                                                               |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `/.well-known/apple-app-site-association` | The iOS app (Team ID and bundle ID) may open every path but `/`      |
| `/.well-known/assetlinks.json`            | The Android package and its signing certificates may open every link |
| `/`                                       | A redirect to the project's website                                  |
| anything else                             | A small "Link not found" page with a button to the website           |
| `/healthz`                                | `{"ok":true}` on any host                                            |

A request for a host marks it seen in the database, at most hourly. That is how a
merchant's own domain goes live in the console: the request could only have reached us
over HTTPS if its DNS points here and Caddy got a certificate for it.

Environment: `KMA_LINKS_URL` (the `attribution-links` function's URL) and
`KMA_ATTRIBUTION_LINK_SECRET` (the same value as the function's `ATTRIBUTION_LINK_SECRET`,
at least 32 characters). It runs as the `links` service in `deploy/hostinger/compose.yaml`;
the steps are under "Attribution" in `docs/merchant-analytics-deploy.md`. Tests:
`node --test scripts/link-service.test.mjs`.
