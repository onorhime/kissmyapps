# Production tracking gateway

The current `go.kissmyapps.dev` host runs on the shared VPS Caddy proxy. Its source
snippets are in `deploy/hostinger/`. This directory is the equivalent standalone
Vercel gateway configuration; changing it does not change the active VPS.

Both gateways preserve the original `/r/<creator-slug>/<code>` addresses and
forward readable `/<product>/<creator>` and `/<product>/<creator>/<variant>`
addresses to the same production `tracking-redirect` function. Creator and
product handles are immutable aliases for an existing link. They do not create a
second attribution system or bypass link, agreement or payment-readiness checks.

Readable handles preserve supported non-Latin letters and numbers. Browsers may
percent-encode them on the wire. Caddy matches the decoded Unicode path; Vercel
forwards the two- or three-segment path. The Edge function decodes each segment
once and checks lowercase NFC letters/numbers and hyphens, a maximum of 64
characters per segment and 180 characters overall. It rejects encoded separators,
percent signs, repeated/trailing slashes and reserved product prefixes. Gateway
matching is a routing filter; the Edge function is the canonical validator.

The legacy `/r/*` matcher stays first. Caddy rejects non-GET tracking requests
with 405, and the upstream function applies the same method restriction for the
Vercel alternative. Other Caddy paths return 404. All redirect routes use
`Cache-Control: no-store`; never enable caching on affiliate redirects.

For an approved VPS route release, begin with the current complete live Caddyfile,
change only the `go.kissmyapps.dev` block, validate with the installed Caddy version,
and preserve the inode of its bind-mounted file. Retain the previous bytes and
restart only the edge Caddy container. Never replace the shared file with the
repository's dated full snapshot or restart the DramaPal Compose project.

Before switching, deploy and test the alias migration and redirect handler.
After switching, verify legacy and readable URLs, a percent-encoded non-Latin
handle, the `kma_sid` first-party cookie, existing readiness rejections, and the
final funnel destination. A synthetic unknown alias returning 404 establishes
routing only; it does not prove a successful attributed click. Financial gates
and worker queues are independent and must remain in their approved state.
