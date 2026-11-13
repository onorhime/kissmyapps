# Releasing KissMyApps

One command releases one commit of `main` to every part of production, so the dashboard,
the merchant console, the database, the Edge Functions and the VPS services never run
different versions again.

```sh
node scripts/kma-release.mjs status     # read-only: what is live, what a release would change
node scripts/kma-release.mjs apply      # release this commit everywhere
node scripts/kma-release.mjs rollback   # back to the previous dashboard and VPS files
```

(`pnpm release:status`, `pnpm release:apply` and `pnpm release:rollback` run the same.)

Run it from a clean checkout of `main` that has `node_modules` (`corepack pnpm@10 install
--frozen-lockfile`), the linked Supabase project (`supabase/.temp`, made by `supabase link
--project-ref mmyruzjemjecqyivhrgr`) and SSH access to the VPS. Today that is the owner's
Mac, in `~/A1 Global/React/affiliate dashboard`, usually through a Remote Control session.
That session's permission mode must not be Auto: Auto refuses production writes. Switch it
to "Ask permissions" in the desktop app's Code tab first.

## What `apply` does, in order

1. **Checks** everything `status` lists under "Before a release can run". It refuses to
   start while any is left: uncommitted changes, a commit that is not `origin/main`, a live
   commit this one does not contain (it would drop live work), migrations in the database
   that this commit lacks, an Edge Function with no `verify_jwt` in `supabase/config.toml`,
   missing secrets, a missing env file or Docker image on the VPS, less than 1 GB free, or
   an edge Caddyfile that lacks a block this release needs.
2. **Builds** the dashboard (`npm run build`: partner, admin and merchant console, plus the
   web SDK in `dist/sdk`) and checks the build talks to the production Supabase project.
   `.env.production` holds the two public browser values the build needs. It writes
   `dist/release.json` with the commit, and packs `dist` and the VPS files from
   [deploy/release.config.json](../deploy/release.config.json) into one archive with a
   `SHA256SUMS`.
3. **Uploads** the archive to `/srv/kissmyapps/releases/<id>/` and checks every file.
   Nothing switches yet.
4. **Database**: `supabase db push --linked --skip-vault` when migrations are pending, then
   checks none are left.
5. **Edge Functions**: deploys all of them from this commit with `--use-api`, with the
   `verify_jwt` each one has in `supabase/config.toml`. It never deletes a function.
6. **VPS services**: copies the compose file, `dashboard.Caddyfile`, the events relay and the
   link service into `/srv/kissmyapps/deploy/` (keeping the old copies in the release's
   `rollback/` folder), then recreates `geo` and `links` when their files changed, or starts
   them if they are not running, and waits for each to be healthy.
7. **Dashboard**: points `/srv/kissmyapps/current` at the new release, recreates only
   `kissmyapps-dashboard`, and checks it is healthy and serves this commit. If not, it
   switches straight back to the previous release.
8. **Records** the release in `kma-release.json` inside the release folder and appends it to
   `/srv/kissmyapps/releases.log.jsonl`. `status` reads this to know what is live.
9. **Smoke test** from your machine: every dashboard host serves this commit's
   `/release.json`, `events.kissmyapps.dev/` answers 404 and an empty event without a key
   answers 401.

Every step is safe to repeat. If one fails, `apply` says which steps finished; fix the cause
and run `apply` again.

## What stays a hand step

These touch things other projects share, or settings that live outside this repo, so the
release checks them but never changes them:

- **Edge Caddy.** `dramapal-caddy-1` also serves DramaPal and BC Learn. `status` reads the
  live Caddyfile and lists any block the release needs that is missing. Merge it by hand as
  [deploy/hostinger/README.md](../deploy/hostinger/README.md) describes (back up, merge,
  validate with the installed Caddy, restart only that container), or pass `--edge-later`
  to release without it.
- **New secrets.** When a feature adds a secret, set it once (Edge Function secret and/or the
  root-only env file on the VPS) before its first release. `status` names the ones missing.
  The required list is `supabase.requiredSecrets` in the release config.
- **Supabase Auth settings and email templates** (`supabase/templates/`): pasted into the
  Supabase dashboard when they change.
- **DNS** at Fozzy.
- **Mobile and React Native SDKs**: published separately to the public mirror, JitPack,
  pub.dev and npm, as "Mobile SDKs" in
  [merchant-analytics-deploy.md](merchant-analytics-deploy.md) describes. The web SDK ships
  with the dashboard.

## The first release with this tool

Releases before November 2026 have no record, so tell the tool which commit is live. On
2026-11-01 the dashboard went out from `b5f889c` (release
`20261101T110342Z-sdk-installs-a933a7cf6518`); confirm `status` shows that folder as live,
then add `--assume-live b5f889c`. After that first release, the record answers it.

That first release also carries attribution phases 0 and 1 and the Apple Pay managed
checkout, so before it:

1. DNS: an A record `*.go` to `72.60.125.99` (`dig +short x.go.kissmyapps.dev`).
2. Generate `ATTRIBUTION_LINK_SECRET` once, set it as an Edge Function secret, and write the
   same value to `/srv/kissmyapps/link-service.env` as `KMA_ATTRIBUTION_LINK_SECRET`
   (mode 600).
3. Merge the edge Caddy changes for attribution (the `on_demand_tls` option and the
   `https://` block), or release with `--edge-later` and merge right after.
4. Run `status`, read what it will change, then `apply --assume-live b5f889c`.
5. Do the feature smoke tests in [merchant-analytics-deploy.md](merchant-analytics-deploy.md)
   ("Attribution, foundation" step 8 and "smart links" step 6).

## Rolling back

`rollback` points `current` at the release before the live one, puts back the VPS files it
ran with, and recreates the dashboard, `geo` and `links`. It does not touch the database
(migrations only add) or the functions. To put older function code back, check out that
commit and run `apply --allow-older`.
