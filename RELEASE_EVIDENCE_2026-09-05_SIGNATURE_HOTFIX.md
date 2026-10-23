# Agreement signature hotfix — production release, 5 September 2026

## Outcome

The user-approved dashboard-only fix is live on
<https://partners.kissmyapps.dev> and <https://admin.kissmyapps.dev>.
It corrects raw signature-receipt parsing, checks committed document status
before offering a retry after an uncertain response, and improves agreement
modal contrast. No legal signature was performed during deployment.

## Release identity and rollback

- Active: `/srv/kissmyapps/releases/20260905T101452Z-signature-hotfix-e3f53025155b`.
- Manifest SHA-256: `e3f53025155b3c8f3a7fac833523148f6672819479370e93f28bc31210d39a3b`.
- Entry script: `dashboard-Dxkw__V6.js`; stylesheet: `dashboard-DfebVzPo.css`.
- Container: `f101be576486acefed6198e8eddb5c2772076149743a2386aff8bcdb2a075296`, healthy.
- Retained previous/rollback release:
  `/srv/kissmyapps/releases/20260905T002939Z-audit-repairs-6de1142a4638`.
- Previous manifest SHA-256:
  `6de1142a4638e822d6c2df8e5f10015c0b6cfddd08d37cae0bfb53d28d1e6681`.

Activation took `/srv/kissmyapps/.release.lock`, checked the exact previous
pointer and both configuration digests, verified all candidate hashes, then
switched `current` atomically and recreated only `kissmyapps-dashboard`.
The activation script included rollback on failed health/homepage/isolation
checks; rollback was not needed. Any later rollback must first re-resolve and
guard the then-current pointer under the same lock, switch to the retained
previous release, and recreate only this dashboard container. Do not roll back
the database or delete signature evidence to revert this frontend release.

## Scope and preservation

The package starts from the verified previous release and changes only the
dashboard index and its new script, stylesheet, and chart chunk. All 29 other
previous files are byte-identical; old hashed assets remain available for
already-open tabs. The package contains 33 files.

- Existing demo-funnel HTML/JS and other public files were preserved exactly.
- Unreleased local developer docs/SDK and checkout assets were excluded.
- Neither Vercel funnel was changed or redeployed.
- No database migration, Edge Function, auth setting, email, PDF, commercial
  configuration, Stripe object, signature, payment, or payout was changed.
- All seven other container IDs, including shared edge Caddy, are unchanged.
- Remote Compose SHA-256 remained
  `ed19d3e1b31e8c87f835236b1749135077c331aa1492ff7153bca9f1a7cf456e`.
- Dashboard Caddyfile SHA-256 remained
  `7952ff6e2761270f4e5ecf5c489c9942a5b16a769af7ec3ae182df027d92bf86`.

## Verification boundary

- Full frontend suite rerun: **643 tests in 47 files passed**.
- Previously validated TypeScript/build, lint, formatting and 63 focused
  gateway/modal/contrast tests passed; runtime source was unchanged since that
  build. Release-turn `git diff --check` passed.
- Both domains: **33/33 static files and root HTML matched SHA-256**; `/healthz`
  returned 200 `ok`. Checks completed 10:17:17 and 10:17:22 UTC respectively.
- Root HTML retains `Cache-Control: no-store, max-age=0` and `X-Frame-Options: DENY`.
- Chrome reached the authenticated partner Performance/Profile workspace and
  the separate Admin sign-in page. The partner had no active product; therefore
  no fresh agreement modal, countersignature, or signature transaction was
  exercised. The legal-signature success/error cases remain locally tested,
  not newly signed in production.
- Modal color verification is from scoped CSS/contrast tests and deployed asset
  hashes, not a new production screenshot, device, or screen-reader audit.
- macOS provenance metadata warnings during archive extraction did not affect
  any file hash. Existing jsdom canvas and bundle-size warnings remain separate.

Remote isolation snapshots are retained under
`/srv/kissmyapps/release-evidence/20260905T101452Z-signature-hotfix-e3f53025155b`.

## User acceptance / next action

1. Refresh the Partner and Admin tabs to load the new build.
2. Do not repeat Victory Onorhime's existing partner signature. It was already
   recorded before this fix and was not altered by this deployment.
3. In Admin → BC Learn → Agreements, review and countersign as the authorized
   company signer, then activate the agreement when its requirements pass.

Verified Stripe US$1/month billing, the restricted 100%-off forever promotion,
checkout/webhook/worker integration and approved $0 acceptance remain later work.
