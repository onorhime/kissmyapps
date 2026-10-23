# Admin Subscriptions — production release

Released September 7, 2026, following the user's explicit request to deploy.
The change is a read-only Admin directory and one additive, role-checked RPC.
No financial action, provider configuration, funnel deployment or email send
was performed.

## Database

- Project: `mmyruzjemjecqyivhrgr`.
- Applied at **17:02:21 UTC**: migration `20260907180000_admin_subscriptions`.
- Migration inventory: **46 → 47**, recorded atomically with the new function.
- Migration SHA-256:
  `0f19a97e9f11948a382020b1c13c2af103274e4b36eedc0d1e11c65e933d022d`.
- Fresh rollback validation: **50 assertions passed**, with all changes rolled
  back, at 17:00:45 UTC. Allowed/denied roles and session types, sensitive-field
  exclusions, filter bounds and canonical billing/attribution mappings passed.
- Post-release read-only acceptance at **17:03:54 UTC** used `SET LOCAL ROLE
authenticated` and password claims for an existing Owner. It returned two
  active subscriptions, both attributed to TikTok with zero-total initial
  checkout evidence, zero recorded paid invoices and no unprocessed Stripe
  receipts. This did not perform a browser login or fresh Stripe lookup.
- Before/after hashes matched for products, agreements, links, offers, clicks,
  events, provider receipts, checkout attempts, subscriptions, transactions,
  commissions, payouts, daily metrics and admin roles. Existing public/internal
  function definitions, table/view ACL/RLS settings, policies and cron
  definitions also matched.

Key unchanged record fingerprints:

| Evidence                   | MD5 fingerprint                    |
| -------------------------- | ---------------------------------- |
| Subscriptions              | `05c23091be9c11c4da810bcda01b9a1b` |
| Provider events            | `ba13b95436d518fc93f30123011a3950` |
| Checkout attempts          | `14c730b2945bc901ae17f6b770188ee9` |
| Transactions / commissions | `d41d8cd98f00b204e9800998ecf8427e` |
| Admin roles                | `d06e90918d9ecfc971f0126194d216ec` |

## Frontend and host isolation

- Active release:
  `/srv/kissmyapps/releases/20260907T170053Z-admin-subscriptions-12ffc5170853`.
- Retained rollback release:
  `/srv/kissmyapps/releases/20260907T153008Z-processing-alerts-5cccaca551ee`.
- New manifest SHA-256:
  `12ffc51708534c8b246fe6290321e47d5a2993c67072e85052d70e599eca483e`.
- New `dist/index.html` SHA-256:
  `be04c9777d2c93d251db109296986ec0c8c180d99c9f751e811851e253309a9c`.
- Archive SHA-256:
  `90f7ad95bbced643fd5de0b8db2d4e6a35fa17400306107df7b29dfb31e13071`.
- Changed files: entrypoint plus `dashboard-hYdR-WzR.js`,
  `dashboard-DaVNqsJU.css`, and `TrendChart-fG5LLreF.js`.
- All 50 previous non-entrypoint manifest files were preserved byte-for-byte,
  including the deployed public developer docs and existing static demo. Local
  unrelated docs/demo changes and the synthetic QA preview were not published.
  macOS AppleDouble metadata was excluded from the new package; the prior
  release, including its metadata, remains retained.
- Only `kissmyapps-dashboard` was recreated. Container
  `a8802c496fcf8f68bd6359e96db5a3459c561ddb6338349cd5a146158d21c76c`
  is healthy. All seven unrelated container IDs were unchanged.
- Compose SHA-256 stayed
  `ed19d3e1b31e8c87f835236b1749135077c331aa1492ff7153bca9f1a7cf456e`;
  dashboard Caddy configuration stayed
  `4d64e966ff887e661055962b26178b4e6af0c29dbc5682383cde4601d4a9464a`.
- At **17:04:10 UTC**, all **108 public asset checks passed**: 54 exact hashes
  each on Admin and Partner hosts. Both `/healthz` endpoints returned `200 ok`.
- Fresh TypeScript build, production Vite build and **113 focused tests** passed.
  Prior full-suite evidence remains 757 Vitest tests plus nine Node tests.
  The existing large-bundle warning remains.

## Live checks and explicit remaining gates

- A real signed-in Partner browser session redirected
  `partners.kissmyapps.dev/#admin/subscriptions` to `#performance`, never showing
  the Admin directory. It displayed five verified TikTok clicks, five funnel
  starts, five payment views, two active/trial subscriptions, zero paid
  purchases and `$0.00` recorded earnings.
- The refreshed Admin route requires sign-in. **Authenticated Admin visual
  acceptance remains pending** because the Admin session is signed out. After
  login, inspect both rows, details, filters and refresh. No password was reset
  and no account role was modified to bypass this gate.
- At **17:04:59 UTC**, processing health reported enabled, no attention required,
  and zero pending/processing/failed/expired items in all three work queues.
  External transfers remained disabled. A normal processing cycle was running;
  this check does not claim a new payment, email delivery or payout occurred.
- These two zero-total tests do not establish real paid-purchase, commission,
  renewal, refund or payout acceptance. App entitlement remains a separate
  product integration, as previously agreed.

Next build: Admin Payouts for reviewing earnings, preparing payout periods and
statements, and explicit human approval before any transfer. Do not enable
automatic provider transfers as part of this release.

## Evidence locations

Local release artifacts and JSON reports:
`/tmp/kma-subscriptions-release.ZcOVpp/`.

Server activation records and copied release reports:
`/srv/kissmyapps/release-evidence/20260907T170053Z-admin-subscriptions-12ffc5170853/`.

The guarded activation preserved the previous release and included automatic
rollback on container/hash/isolation failure. No rollback was needed. If a
future UI regression requires rollback, restore that retained dashboard
release and recreate only its container; the unused additive RPC can remain.
