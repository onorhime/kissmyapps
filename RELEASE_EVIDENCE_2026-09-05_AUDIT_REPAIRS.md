# Audit repairs — production release evidence, 5 September 2026

## Outcome and scope

The approved audit repair release is deployed to Supabase
`mmyruzjemjecqyivhrgr` and the existing Hostinger dashboard. This is **not** a
commercial launch or completion of the B2 checkout/payment integration.

- Four migrations applied; **34 total** now recorded remotely:
  `20260905090000`, `20260905091000`, `20260905092000`, `20260905093000`.
- Updated agreement evidence, signing permissions, immutable commercial
  revisions, durable notification jobs, scoped cleanup, and tracking-only
  billing gate are live. The dashboard supplies the new evidence fields and
  exposes agreement job counts in Admin → Data Health.
- `agreement-notify` is **ACTIVE, version 6**; 11 Edge Functions remain deployed.
  Only this function was redeployed. Gateway JWT verification is disabled for
  this internal endpoint; its own shared-secret authentication remains enforced.
- Internal notification credential rotated at **00:46:09 UTC**. Database and
  Edge SHA-256 digests match; the retired credential returned **401**. The old
  value remains in historical source but no longer authorizes the endpoint.
- Existing Resend configuration remains present. No new email was sent, no
  signature was performed, and no file was deleted during this deployment.

## Dashboard identity and isolation

Active release:

`/srv/kissmyapps/releases/20260905T002939Z-audit-repairs-6de1142a4638`

Manifest SHA-256:

`6de1142a4638e822d6c2df8e5f10015c0b6cfddd08d37cae0bfb53d28d1e6681`

The release manifest uses `dist/...` paths and is verified from the release
root. Its 30 static files and homepage were fetched from **each** of
`admin.kissmyapps.dev` and `partners.kissmyapps.dev` and matched local SHA-256
digests. Entry bundle: `dashboard-_BoSoXrQ.js`.

Activation held the VPS release lock, verified the prior symlink, and switched
`current` atomically. Only `kissmyapps-dashboard` was recreated; container
`155578bd371b` is healthy. All seven existing DramaPal container IDs, including
edge Caddy and the pre-existing sandbox services, remained unchanged. No new
staging environment was created. Remote Compose and dashboard Caddyfile hashes
are unchanged; no edge config or DNS was edited.

Previous release retained:

`/srv/kissmyapps/releases/20260904T163307Z-product-delete-collapse-90b301b6ad0f`

Its manifest digest is
`8f1919036625f424a373a2fa7860cfe3c9a9983896c48d31fb564492b97589d2`.
That older manifest uses `./...` paths relative to its `dist` directory and
passed validation before activation.

## Maintenance execution evidence

Enabled `pg_cron` **1.6.4**, after confirming no existing cron jobs. Job **1**,
`kma-agreement-maintenance`, runs once per minute as `postgres` and executes only:

```sql
select kma_internal.dispatch_agreement_email_jobs();
```

No credential is stored in the cron command. The checked-in, duplicate-guarded
setup is `deploy/hostinger/agreement-maintenance.sql`. The dispatcher handles
agreement emails and explicitly queued, unreferenced file cleanup only; it
does not enable Stripe, payouts, analytics, or other commercial workers.

Three consecutive scheduled runs succeeded at **00:48, 00:49 and 00:50 UTC**
(run IDs 1–3). The catalog had no jobs, so the dispatcher correctly did no work.
A separate empty maintenance
probe through **pg_net 0.20.4** produced HTTP request **1**, **200**, no timeout,
at **00:47:56 UTC**, with every claimed/cleaned/sent/retry/failed count zero.

Direct worker boundary checks also passed: retired credential → **401**,
authenticated fabricated milestone body → **400**, authenticated empty body →
**200**, zero jobs. These prove scheduler execution and the protected HTTP path,
**not** real milestone delivery, retry timing, or recipient inbox receipt.

## Verification and preserved data

- Candidate `pnpm validate:all` passed: **608 frontend tests / 46 files**, **63
  Edge tests**, formatting/lint, 11 Edge entrypoint checks, TypeScript and build.
- Hosted rollback regression suite passed **42 assertions** before migration
  and again **after the permanent migrations**. Synthetic fixtures rolled back;
  the suite did not invoke HTTP, email, or Storage APIs.
- Post-release readback: zero products, agreements, documents, clicks, events,
  subscriptions, commission entries, payouts, email jobs, and cleanup jobs.
  Both pre-existing private Storage objects remain: **2 before, 2 after**.
- Live browser checks reached the correct separate Admin and Partner sign-in
  pages. No signed-in session was available in the verification browser;
  authenticated Data Health and multi-account signing acceptance remain pending.
- Existing large-bundle and jsdom canvas warnings remain separate work.

## Recovery and limitations

Supabase reported seven completed daily physical backups (29 August–4
September); latest backup **1574624169**, **4 September 09:37:42 UTC**, completed.
PITR is disabled. An optional fresh native database export could not complete
from this connection. No fresh export or successful restore test is claimed.

If delivery misbehaves, an operator should pause only the agreement maintenance
job while preserving committed jobs, receipts, signatures, and files. Use a
forward schema/worker repair: restoring the old frontend alone is not a complete
rollback because it does not supply the new signing/upload evidence. Never
restore the retired credential or erase signed evidence to work around failures.

The release helper reads only the existing Supabase CLI `supabase` Keychain
profile into memory and updates credentials through the authenticated Management
API. This resolved the CLI's streamed dotenv input failure; no plaintext secret
file or secret-bearing command argument was used.

## Next acceptance gate

Refresh Admin and Partners. Using the real product, reviewed PDF and intended
signers, walk through upload → signing-request email → partner Owner signature
→ admin email → countersignature → partner email. Verify recipient receipt and
Admin Data Health. Do not fabricate legal signatures as test fixtures.

The PDF digest is an authenticated uploader-provided fingerprint, not a server
attestation that PDF prose matches configured commercial terms. Legal review,
real-browser/device accessibility checks, the checkout proxy, Stripe live
payment/refund/renewal acceptance, entitlement API and payout operations remain
separate from this release.

Operational references: [Supabase Cron](https://supabase.com/docs/guides/cron/quickstart)
and [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net).
