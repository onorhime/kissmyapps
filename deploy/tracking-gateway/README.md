# Production tracking gateway

This directory is the standalone Vercel project for the public `go` host. It
contains no preview/staging behavior and no credentials. Vercel forwards only
`/r/*` requests to the linked production Supabase `tracking-redirect` function;
the upstream function still validates the exact route, resolves the server-owned
destination, records the click/acquisition, and returns the redirect.

Do not deploy or attach a custom domain until the exact registered apex domain
is confirmed. The current DNS check finds `kissmyapps.dev`, while the separately
mentioned `kismahub.dev` has no DNS zone. After confirmation:

1. Deploy this directory as its own Vercel project using a production deployment.
2. Attach the confirmed `go.<apex>` hostname to that project.
3. Add the CNAME Vercel reports at the existing DNS provider; do not move the
   apex nameservers or overwrite unrelated records.
4. Confirm HTTPS, `Cache-Control: no-store`, the `kma_sid` first-party cookie,
   one real click row, and the final funnel redirect before enabling tracking.

External rewrites are intentionally not cached. Never enable rewrite caching on
affiliate redirects.
