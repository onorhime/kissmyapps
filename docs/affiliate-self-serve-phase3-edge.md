# Affiliate self-serve, Phase 3: Edge Functions and routing

Phase 3 lets creators browse programs, join one and get a working link. This document covers
the two Edge Functions of that phase and the one routing change the public marketplace
needs. Deploy only with the owner.

Written and tested locally only. Nothing in this document has been applied to hosted
Supabase or to the production edge.

## What ships

| Piece                                               | Where                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| Edge function `marketplace` (new)                   | `supabase/functions/marketplace/`, public read of live programs         |
| Edge function `tracking-redirect` (changed)         | redirects without a click when a program link cannot be credited        |
| Function entry                                      | `supabase/config.toml`, `[functions.marketplace]`, `verify_jwt = false` |
| Database test of the link and click rules           | `supabase/tests/database/77_program_link_tracking.sql`                  |
| Route `kissmyapps.dev/marketplace` to the dashboard | edge Caddy, by hand (below)                                             |

No new migration belongs to these two functions. They need the Phase 3 migrations that ship
with them:

- `20261115100000_program_membership.sql`: the click function's "redirect only" answer.
- `20261115101000_program_join.sql`: `public.marketplace_programs()` and
  `public.marketplace_program(text)`, which `marketplace` calls as the service role.

## Order

1. Apply the Phase 3 migrations, in file order.
2. Deploy `tracking-redirect` and `marketplace`. The release tool deploys every function
   with the `verify_jwt` written in `supabase/config.toml`.
3. Release the dashboard build (it carries the marketplace pages).
4. Route `kissmyapps.dev/marketplace` to the dashboard (below).
5. Set `MARKETPLACE_ENABLED=true`.
6. Do the checks at the end of this document.

Steps 1 and 2 are safe in either order. Between them, a program link that cannot be credited
answers 404, which is what every such link answered before Phase 3.

## Function secrets

| Secret                 | Value                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `MARKETPLACE_ENABLED`  | new. `true` switches the public marketplace on. Any other value, or unset: every request answers 503 `marketplace_disabled`. |
| `TRACKING_HASH_SECRET` | already set. `tracking-redirect` uses it as before.                                                                          |

`SUPABASE_URL` and the service role key are provided by the platform. `marketplace` has no
secret of its own and reads no credential from the request.

```sh
supabase secrets set --project-ref mmyruzjemjecqyivhrgr MARKETPLACE_ENABLED=true
```

To switch the marketplace off again, set the value to `false`. The public page then shows
its "could not load" state; joined creators and their links are not affected.

## `marketplace`

Public, GET only, no session, no cookies, no request body.

| Request                                                                                                | Answer                                                                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `GET /functions/v1/marketplace`                                                                        | `200 {"programs": [...]}`: every live, listed program, newest first       |
| `GET /functions/v1/marketplace?slug=<slug>`                                                            | `200 {"program": {...}}` with the agreement, for a live or paused program |
| unknown slug, or a slug that is not lower-case letters, digits and single hyphens, up to 80 characters | `404`, `error: "not_found"`                                               |
| any other method                                                                                       | `405`, `error: "method_not_allowed"`                                      |
| flag off                                                                                               | `503`, `error: "marketplace_disabled"`                                    |
| database unreachable, or an answer that is not the agreed shape                                        | `503`, `error: "database_boundary_error"`                                 |

- A paused program is answered by its slug with `"status": "paused"`, so the page can say it
  is not taking new creators. An unlisted program is not in the list but is answered by its
  slug: that address is the merchant's invite link.
- Only the fields of the program card and program page leave the function. Each one is
  copied by name from the database answer, so workspace ids, emails or Stripe ids can never
  be passed on by accident.
- Successful answers carry `Cache-Control: public, max-age=60`. A program that goes live, is
  paused or changes its terms can take up to a minute to show. Errors are never cached.
- Every answer carries `Access-Control-Allow-Origin: *`, with no credentials allowed, so the
  page works from any host that serves the dashboard build.
- Errors use the same body as the other functions: `error`, a fixed `message` and
  `request_id`. Failures with status 500 or above write one log line with the outcome and,
  for a database error, its five-character code. Nothing from the request is logged.

## `tracking-redirect`

A click on a creator's program link is counted like any other click: the visitor is sent to
the program's landing page with `kma_click`, and Phase 2 ties a sale to it.

New in Phase 3: when the link belongs to a program but cannot be credited, the database
answers "redirect only" and the function sends the visitor to the landing page with:

- no `kma_click`,
- no `kma_sid` cookie,
- nothing recorded: no click, no acquisition.

That happens when the program is paused, the creator left or was removed, the link is
switched off or archived, the creator's account is not active, or tracking is switched off
for the whole platform. The link starts crediting again as soon as the cause is gone; nobody
needs a new link.

Still 404, as before: an unknown address, a link of an archived program, a test-environment
link, and any link that cannot be credited on a product that has no program (the admin-issued
agreement links and tracking-only links).

One behaviour to know: the "redirect only" answer looks at the product, not at how the link
was issued. If KissMyApps also issued a link by hand for a creator on a program's product,
that link too redirects without credit, to the program's landing page, when it is switched
off.

The gateways need no change. `go.kissmyapps.dev` in the edge Caddy and
`deploy/tracking-gateway/vercel.json` already pass both link shapes to this function.

## Routing `kissmyapps.dev/marketplace`

The public marketplace is part of the dashboard build. The build shows it whenever the path
is `/marketplace` or `/marketplace/<slug>`, on any host, and the dashboard container already
answers unknown paths with the application shell. So right after the dashboard release the
page works at `https://partners.kissmyapps.dev/marketplace`.

The addresses the product hands out are on the main domain: merchants copy
`https://kissmyapps.dev/marketplace/<slug>` as their invite link. The edge Caddy in this
repository has blocks for `partners.`, `admin.`, `merchant.`, `go.` and `events.` only; it
has no block for `kissmyapps.dev` itself. Until one is added, invite links do not open.

Find out first what answers `https://kissmyapps.dev` today (`/terms` and `/privacy` are
linked from sign-up and from emails, and must keep working):

```sh
dig +short kissmyapps.dev
curl -sI https://kissmyapps.dev/terms | head -5
```

If the main domain is served by the same edge Caddy (`dramapal-caddy-1`), add the paths below
to its existing block, or add this block if there is none, and keep whatever serves the rest
of the site in the last `handle`:

```caddyfile
kissmyapps.dev {
	import compressed

	# The marketplace pages and the files the dashboard build loads from the site root.
	@marketplace path /marketplace /marketplace/* /assets/* /favicon.svg /favicon-32.png /apple-touch-icon.png /kissmyapps-mark.svg
	handle @marketplace {
		reverse_proxy kissmyapps-dashboard:8080
	}

	handle {
		# What serves the rest of kissmyapps.dev today stays here.
	}
}
```

- `/assets/*` is required: the page's scripts and styles are loaded from there. Check that
  the rest of the main site does not use the same path; if it does, the two builds collide
  and the marketplace must be given its own host instead.
- Do not `import kissmyapps_dashboard` here. That snippet adds
  `Strict-Transport-Security` with `includeSubDomains`, which on the main domain would apply
  to every subdomain.
- Merge by hand as `deploy/hostinger/README.md` describes: back up, merge, validate with the
  installed Caddy, restart only that container. The release tool reads the edge Caddyfile
  but never changes it. To make `kma-release status` name a missing block, add
  `{ "site": "kissmyapps.dev", "contains": ["kissmyapps-dashboard:8080"] }` to
  `edge.requires` in `deploy/release.config.json`.

If the main domain is served somewhere else, add the same rule there: proxy or rewrite
`/marketplace`, `/marketplace/*` and the files above to the dashboard, for example to
`https://partners.kissmyapps.dev`. A plain redirect to `partners.kissmyapps.dev/marketplace/<slug>`
also works and needs no shared paths, at the cost of the address changing in the browser.

## Checks

Before the flag is on:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/marketplace
# 503
```

After `MARKETPLACE_ENABLED=true`:

```sh
curl -si https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/marketplace | head -20
# 200, cache-control: public, max-age=60, access-control-allow-origin: *, {"programs":[...]}
curl -s 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/marketplace?slug=<a live slug>'
# {"program":{...,"status":"live","agreement":{...}}}
curl -s -o /dev/null -w '%{http_code}\n' 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/marketplace?slug=no-such-program'
# 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/marketplace
# 405
```

Read the first answer once and confirm it holds nothing but program card fields.

After the routing change:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://kissmyapps.dev/marketplace
curl -s -o /dev/null -w '%{http_code}\n' https://kissmyapps.dev/marketplace/<a live slug>
# 200 and 200, and both pages render in a browser, signed out
curl -sI https://kissmyapps.dev/terms | head -1
# unchanged
```

A creator link, with a real creator joined to a live program:

1. Open the creator's link. The landing page opens with `kma_click=<48 characters>` in its
   address.
2. Pause the program in the merchant console and open the link again. The landing page opens
   with no `kma_click`, and the response sets no `kma_sid` cookie
   (`curl -sI <the link> | grep -i -e location -e set-cookie`).
3. Make the program live again. The link carries `kma_click` again.

## Known limits

- `marketplace` answers 503 if one program in the database does not fit the agreed shape.
  The log line says `database_boundary_error` with no database code. That is deliberate: a
  malformed program is a bug to fix, not something to show or to hide silently.
- No rate limit of its own. The list is one indexed read capped at 200 programs and is
  cached for a minute by browsers; Supabase's platform limits apply.
- The dashboard's `index.html` asks search engines not to index it, so the public marketplace
  is not indexed either. Changing that is a decision for the page, not for these functions.
- An untracked redirect is not counted anywhere. A merchant cannot see how many visitors
  arrived through links of creators who left or while the program was paused.
