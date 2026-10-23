# Dedicated Stripe webhook — 2026-09-06

Scope: user's approval to connect a dedicated KissMyApps webhook, preserving the
shared Stripe account's existing destinations and keeping funnel checkout OFF.

## Completed

- Added and deployed ownership filtering **before** provider-event persistence.
  Signature, live-mode and API-version checks still happen first. Unrelated
  events return HTTP 200 `ignored: true` with no event/processing record.
- Checkout ownership uses the committed session, or the complete canonical
  attempt metadata if finalization has not happened yet. Subscription ownership
  uses canonical evidence or a known attempt without a conflicting subscription.
  Product ID alone is not enough. No customer-wide ownership inference.
- Invoices and early refunds/disputes can resolve their exact subscription via
  bounded read-only Stripe GETs. All GETs share a seven-second budget. Unavailable,
  unauthorized, malformed or ambiguous lookup evidence fails closed; operational
  failures return 503 for Stripe to retry instead of acknowledging a discard.
- The new RPC returns only a boolean. No direct table privileges were added.
  Downstream financial normalization retains all canonical identity, attribution,
  currency, amount, settlement and no-charge checks.

## Release identity and validation

- Project: `mmyruzjemjecqyivhrgr`.
- Migration: `20260906110000_stripe_webhook_ownership.sql`.
- Migration SHA-256:
  `eab704d68169ccf31ac80dd753fa78acee802d23754abdbf37a5599bfcff054e`.
- 39 applied migrations after this one narrow release.
- Function: `stripe-webhook`, version **12**, ACTIVE.
- Bundle SHA-256:
  `f735bc20e435a82f3b47455acf605c1795cb85fc9ada1d36ce6f564bbb28575b`.
- `pnpm test:edge`: formatting, lint, type checking; **114 tests passed**.
- Scoped hosted SQL regression: **81 assertions passed**, including prepared
  checkout, out-of-order subscription, conflicting canonical identity, paused
  product, charge evidence and browser-role denial. Every synthetic fixture was
  rolled back. The existing broad empty-catalog runner was not bypassed.
- Before/after application fingerprints matched: products, offers, agreements,
  documents unchanged. Counts: clicks 1, events 1, links 2, checkout attempts 0,
  provider events 0, subscriptions 0, transactions 0, commissions 0.
- Registration helper: **6 mocked tests passed**, including exact destination
  selection, secret handling, duplicate guard, 403, invalid JSON redaction,
  non-live key denial and read-only mode. No provider/control-plane calls happen
  in these tests. Real registration has NOT been executed.
- `git diff --check` passed. No Hostinger, Vercel, original waitlist or Sites
  deployment was performed. Other Supabase functions were not deployed.
- Downloaded the deployed bundle and byte-compared the handler and ownership
  helper against local source: both matched. A final offer-only lookup reused
  the existing user click and returned HTTP 200, USD 100/month and
  `checkout_enabled: false`. No checkout endpoint was called. This lookup only
  consumes the bounded offer-request counter and returns a quote cookie.

## Registration blocker — not complete

The dedicated Stripe destination and `STRIPE_WEBHOOK_SECRET` are still absent.
The public endpoint therefore still returns HTTP 503 `configuration_error`.
This is a configuration gate, **not** live signature/delivery acceptance.

Chrome's Stripe Workbench wizard offered only `2025-11-17.clover` (account
current), `2026-08-26.dahlia`, a preview version, and `2024-04-10`. It did NOT
offer our source-pinned `2026-02-25.clover`. The wizard was cancelled; the four
original destinations remain unchanged. Do not relax the parser or change the
shared account's default API version merely to get past the wizard.

Stripe documents using its API to create an endpoint on a specific non-latest
version: [Webhook versioning](https://docs.stripe.com/webhooks/versioning).
Workbench Shell is read-only in live mode:
[Shell documentation](https://docs.stripe.com/workbench/shell).
No Stripe CLI or Stripe key was available in the local environment. The local
`.env.local` contains only the public Supabase URL/anon key. The existing Stripe
key in Supabase was not read, exported, replaced or printed.

## Secure next step

Prepared `scripts/register-stripe-webhook.mjs`. The user can run this from their
own Terminal and paste their existing live server key into its **hidden prompt**:

```sh
node "/Users/nobrainer/A1 Global/React/affiliate dashboard/scripts/register-stripe-webhook.mjs" --create-approved
```

The script does not echo the key, take it in command arguments, or write it to a
file. It uses the existing specifically scoped Supabase CLI Keychain credential
only to configure this project. It checks the known BC Learn Price/product,
inspects existing endpoints, requires the exact released handler hash and the
ownership migration, and refuses to create a duplicate or replace an existing
webhook secret. The key needs Price read and Webhook Endpoints read/write access.
If Stripe denies permission, ask the account owner; do not create broader keys
or alter permissions without direction.

It creates only the dedicated endpoint at
`https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/stripe-webhook`, pinned to
`2026-02-25.clover`, Your account (not Connect), for the 11 allowlisted events in
`PRODUCTION_ACTIVATION.md`. It then saves ONLY the returned signing secret into
Supabase and verifies its digest and preservation of existing configuration.

After setup, it sends a locally signed, impossible foreign-session **security
probe** and requires `200 ignored` plus no persisted event; an unsigned probe
must return 400. This is NOT a real Stripe-delivered event or payment test. Its
credential-free report is saved in the backup directory as `registration.json`.
The helper has not yet been run against Stripe. Run with `--check` for a read-only
preflight; this cannot prove write permission. If creation succeeds but a later
step fails, its error reports the exact endpoint ID: recover that endpoint's
signing secret via Stripe rather than creating another destination.

## Remaining gates

1. Complete registration and signing-secret installation using appropriate key
   access; verify actual Stripe delivery separately.
2. Verify the restricted key's Subscriptions, Charges, Invoices and Invoice
   Payments read permissions needed by ownership fallback and normalization.
3. Configure and verify authenticated Stripe/commercial/metrics worker schedules.
   No scheduler credential or schedule was changed in this release.
4. Verify discount-read permissions and all no-charge checkout safeguards.
5. Obtain approval/handoff for the actual zero-total recurring subscription and
   lifecycle test. Checkout remains OFF; no charge or subscription was created.

## Rollback

Saved exact prior and deployed webhook source bundles and database evidence in
`.cache/release-backups/20260906-stripe-webhook-ownership/` (git-ignored).
The `rollback/` directory contains the prior handler and its own dependencies.
Do not roll back to unfiltered ingestion while the shared-account destination is
enabled. Prefer a forward fix; the new read-only RPC may remain installed. Never
delete signed financial evidence as part of a rollback.
