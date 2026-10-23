# UI interaction release — 5 September 2026

## Outcome and scope

The approved frontend is deployed on `partners.kissmyapps.dev` and `admin.kissmyapps.dev`. Only the dashboard entry page and three app assets changed. All 35 other files from the previous production package remain byte-identical, including its public files, demo funnel, and older hashed assets used by already-open tabs. This was not a deployment of the entire dirty local `dist` directory.

No database migration/data, Supabase settings, Edge Function, Stripe object/setting, billing activation, payment, payout, agreement signature, email, Vercel funnel, or shared proxy configuration was changed by this release. Unrelated local work is preserved.

## Deployment identity

| Item | Verified value |
| --- | --- |
| Host | `72.60.125.99` |
| Current release | `/srv/kissmyapps/releases/20260905T213049Z-ui-interactions-8009b8a54f85` |
| Rollback release | `/srv/kissmyapps/releases/20260905T122944Z-documents-a2b64ae43896` |
| Manifest SHA-256 | `8009b8a54f853e93fad5044061df4a8d4bb8c95dc8fe9a83d9ed32bac594a80d` |
| Archive SHA-256 | `3cce34272beb5cdd356923b4fcac64e303c97f4ff2887eeb6497505bd30869b8` |
| Served index SHA-256 | `5496c892857a9ad21129eec97c193d96666564ba60077403fbc6b0dbec19f7be` |
| Dashboard container | `9e27405f73930dffee2150e715138a73b8a7a64848d5954108c27b61ae254e33`, healthy |
| Server evidence directory | `/srv/kissmyapps/release-evidence/20260905T213049Z-ui-interactions-8009b8a54f85/` |

Changed/new files: `dist/index.html`, `dist/assets/dashboard-je5giXub.js`, `dist/assets/dashboard-Dtnd8s4W.css`, `dist/assets/TrendChart-Cq3g0HUH.js`.

Activation held `/srv/kissmyapps/.release.lock`, asserted the exact prior release and configuration hashes, verified the package, then atomically changed `/srv/kissmyapps/current`. Only `kissmyapps-dashboard` was recreated. Health, mounted-index hash, and `/healthz` passed. The script included rollback on failed startup/verification; rollback was not needed. All seven other running container identities, including the shared Caddy proxy, were unchanged.

## Verification evidence

- Local implementation validation: **52 test files / 693 tests passed**. The deployment turn rechecked the saved final report, reran `pnpm build` and `pnpm lint` successfully, and did not rerun the entire test suite. The existing large dashboard chunk warning remains.
- Package integrity: 39 files; 35 prior non-entry files unchanged. Only the rebuilt dashboard dependency closure was selected. No unreleased developer documentation, UI fixture, demo/SDK/checkout asset changes were included.
- Bundle safety scan: expected current Supabase project host present, obsolete project host absent; no detected secret/service-role credential patterns. No credentials are recorded in this evidence.
- Public verification started at `2026-09-05T21:34:06.562Z`: both domains served **39/39 expected file hashes**, `/healthz` returned HTTP 200 `ok`, root HTML was `no-store, max-age=0`, hashed assets had immutable caching, and frame denial remained present.
- Authenticated production Admin in a new Chrome tab: BC Learn configuration loaded; its verified $1 subscription offer remained Draft. **Review activation** opened the focused confirmation modal; Cancel returned focus to the invoking Review activation button. **Edit draft** populated/focused the Offer name field; Cancel edit restored the create form and focus to Edit draft. No save, verification, or activation was submitted.
- Authenticated production Partner in a new Chrome tab: Profile & Documents loaded the existing signed document and both recorded signature timestamps. Read-only document refresh kept the existing document card mounted while showing `Refreshing documents…`, then returned to its ready state without error or card replacement.

The Chrome browser-extension automation connection was intermittent, so authenticated checks used Chrome's native accessibility surface. This proves the observed controls/state/focus, not a new pixel-level production contrast or mobile-device audit. Existing user tabs were not refreshed; the new acceptance tabs used the deployed release.

## Remaining acceptance and next boundary

- Existing tabs need a refresh to load the new entry bundle. Avoid refreshing while holding unsaved drafts.
- Actual production save/toast/scroll behavior was not exercised through a live write in this deployment turn. Those flows passed the local synthetic browser checks and mocked regression tests documented in [the implementation record](./UI_INTERACTION_FIXES_2026-09-05.md). A user-initiated safe draft save is the next acceptance check.
- Physical devices, browser zoom, real screen readers, and browser-history Back/Forward unsaved-change protection remain follow-ups; this release does not claim full accessibility conformance or durable draft autosave.
- Billing activation, discounts, backend funnel bindings, and end-to-end checkout/payment testing remain separate actions. The UI release did not activate the billing offer.

## Rollback

The previous immutable release is retained. If rollback is required, first take the release lock and assert that current still points to this release; atomically point current to the rollback directory above, then recreate only the dashboard using `/srv/kissmyapps/deploy/compose.yaml` with project name `kissmyapps-dashboard`, `--no-deps --force-recreate --pull never`. Verify container health, prior index hash and both public domains. Do not roll back database or signed evidence, restart the shared proxy, prune Docker, or overwrite a newer release without checking.

Server evidence includes before/after container and configuration hashes, the previous release pointer, activation result, package report, and public verification report.
