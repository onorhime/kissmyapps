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

What it serves:

| Path                                      | Answer                                                               |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `/.well-known/apple-app-site-association` | The iOS app (Team ID and bundle ID) may open every path but `/`      |
| `/.well-known/assetlinks.json`            | The Android package and its signing certificates may open every link |
| `/`                                       | A redirect to the project's website                                  |
| `/<link>`                                 | The link: a redirect for the visitor's device, counted as a click    |
| anything else                             | A small "Link not found" page with a button to the website           |
| `/healthz`                                | `{"ok":true}` on any host                                            |

A link sends an iPhone to the App Store (or the link's own iPhone address), an Android
phone to Google Play with the click in the install referrer, and a computer to the
website with `kma_lc` (the click) and the link's `utm_` tags on the address. In an app's
own browser, such as Instagram's, it shows a page to choose the app or the website.
Robots and link previews are never counted: they get a page with the link's own title
and image when it has one, and otherwise go to the website so its own preview shows.
`HEAD` requests are treated the same way, and paused links go to the website uncounted. Each counted click gets a random
ID and goes into a queue sent to the database every two seconds, in batches of up to
200; a failed send is kept and tried again, and the queue keeps at most 5,000. The
visitor's address comes only from `X-Kma-Client-Ip`, which the edge Caddy sets; the
function hashes it before it is stored.

Addresses can carry settings for one use, which replace the link's own on that click:
`src`, `cmp`, `chn`, `adset`, `ad`, `sub1` to `sub5`, `dl` (the in-app screen), and
`kma_aid` and `kma_from`, which the web SDK's `appLink()` adds.

A creator's affiliate link for an app program lands on the merchant's link with
`kma_click` (the creator's click, 48 lowercase hex characters). It is kept on the click as
`params.creator_click`, so an install matched to the click names the creator, and it is
added to the website address (also the website button of the in-app browser page), never
to a store address. Any other `kma_click` value is ignored.

Clipboard handoff for iPhone: when the project turned it on (`ios_clipboard_handoff` in
the host's answer), an iPhone on its way to the App Store gets a small page instead of the
redirect: the app's name and a "Get the app" button. The button copies `kma:<click ID>`
and then opens the App Store, so an app with clipboard handoff on in its SDK can read the
click on first launch. The page loads nothing else and sends nothing (its only script is
allowed by hash in its Content-Security-Policy); without JavaScript the button is a plain
link to the App Store. Robots, in-app browsers, Android and computers are not affected.

A request for a host marks it seen in the database, at most hourly. That is how a
merchant's own domain goes live in the console: the request could only have reached us
over HTTPS if its DNS points here and Caddy got a certificate for it.

Environment: `KMA_LINKS_URL` (the `attribution-links` function's URL) and
`KMA_ATTRIBUTION_LINK_SECRET` (the same value as the function's `ATTRIBUTION_LINK_SECRET`,
at least 32 characters). It runs as the `links` service in `deploy/hostinger/compose.yaml`;
the steps are under "Attribution" in `docs/merchant-analytics-deploy.md`. Tests:
`node --test scripts/link-service.test.mjs`.
