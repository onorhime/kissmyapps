# Creator links release — 18 October 2026

## Outcome

The one-time-offer creator-link readiness correction and readable creator links are deployed. Checkout and creator payouts remain disabled. The four paused legacy jobs were not replayed or changed.

Creator links now use `https://go.kissmyapps.dev/<product>/<creator-name>`. Campaign links add a readable campaign segment. A numeric suffix resolves a name collision. Unicode public names are retained; internal generated IDs and private identity fields are not used as public creator names. Issued paths remain stable across renames and reserved after deletion.

All four existing links received additional readable aliases. Original URLs, canonical link identities, campaign dimensions and attribution remain intact. The creator and admin dashboards display and copy the readable URLs.

## Deployed components

- Readiness migration: `20261018110000_admin_managed_link_readiness.sql`.
- Readable-link migration: `20261018120000_readable_creator_links.sql`; hosted history contains 65 migrations.
- Redirect service: `tracking-redirect` v17, with all eight deployed application modules matching the frozen source.
- Gateway: only the tracking host routes changed; the full live edge configuration was preserved outside that host.
- Dashboard: `20261018T112612Z-readable-creator-links-9fc450c7964a`.
- Dashboard manifest SHA-256: `9fc450c7964ab4b18050d963d9373a07b48c136bd432280ce29e4cd98294c3e3`.

## Verification

- 105 relevant frontend tests, TypeScript check, production build and focused lint passed.
- All 65 migrations applied to a fresh local database; 52 SQL suites passed. Three existing operator suites require production fixtures and remain skipped.
- 33 new alias assertions, 13 Edge tests and three gateway tests passed.
- Two simultaneous real link-issuance calls allocated distinct readable handles safely.
- All 21 hosted routing checks passed, including Unicode names, malformed paths, legacy routing and method restrictions.
- Existing readable and legacy URLs returned 302 to the same configured destination, with separate click IDs and the same tracking session. Both probes were verified as bots.
- All 78 deployed dashboard asset and route checks passed. The initial check's incorrect expectation of a cache header on health/early-404 responses was corrected to the established server contract before the passing rerun.
- All 107 original database tables retained their rows during migration; existing protected view identities and return types were preserved.
- Financial secret digests, cron configuration, the four paused jobs and their pause controls remained unchanged. No payment, payout, email or queue recovery was performed.
- The dashboard is healthy with zero restarts. Fifteen unrelated containers were preserved, and approximately 4.10 GB of VPS space remained. No images or archives were deleted.

## Evidence and rollback

Backend evidence is in `hosted-creator-link-readiness-release.md` and `hosted-readable-links-backend-release.md` in this directory. Frozen local test evidence is under `.cache/readable-creator-links-20261018/` and `.cache/friendly-creator-links-20261018/`.

Hosted route and dashboard receipts are under `.cache/release-backups/20261018-creator-links/edge-readable/` and `frontend-readable/`. The previous dashboard release, full prior edge configuration and prior redirect bundle are retained for rollback. No destructive rollback of issued aliases is planned because shared addresses must remain reserved.

The Marathon product/funnel remains user-managed; the sample product/name format does not represent a newly created production Marathon offer.
