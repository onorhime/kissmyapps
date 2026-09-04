# KissMyApps product deletion, sources, and collapse release evidence — 2026-09-04

Database and frontend release covering four fixes requested after the
signing walkthrough.

## Agreement deletion (root cause found via live DB)

The first failure was a foreign-key violation: a revoked document row kept
referencing the agreement (`documents_agreement_id_fkey`, no cascade), which
PostgREST surfaced as HTTP 409 ("record already exists"). Migration
`20260904220000_delete_agreement_documents` removes never-fully-signed
document rows with the agreement. Verified by a rolled-back RPC execution
impersonating the password-authenticated Owner session against the live
database.

## Product deletion

Migration `20260904230000_product_deletion_and_sources` adds
`delete_admin_product` (Owner/Operations, password-proven): requires the
exact product slug as confirmation and deletes the product with funnels,
campaigns, agreements, rules, offers, links, clicks, acquisitions, events,
metrics, and unsigned documents — blocked once any commercial fact exists
(checkout attempts, subscriptions, entitlements, conversions, commissions,
payouts, commercial-eligible events, or nonzero commercial metrics) or a
fully signed agreement document exists. The configuration page gains a
Danger Zone with a slug-typed confirmation.

## Seeded global sources

The migration seeds the curated channel catalog (TikTok, Instagram,
YouTube, X, Facebook, Reddit, Newsletter, Email, Blog, Discord, Telegram,
Threads) idempotently by key, so standard channels no longer require manual
entry.

## Collapsible configuration sections

Funnels, Sources, Billing, Agreements, and Launch now collapse to their
headers via an accessible chevron toggle; Funnels and Launch default open.
The header always remains visible.

## Release identity

- Release commit: `90b301b6ad0f`.
- Active release: `/srv/kissmyapps/releases/20260904T163307Z-product-delete-collapse-90b301b6ad0f`.
- Rollback target: `/srv/kissmyapps/releases/20260904T140036Z-agreement-emails-ae15a2a5f340`.
- Manifest SHA-256: `8f1919036625f424a373a2fa7860cfe3c9a9983896c48d31fb564492b97589d2`.
- Migrations applied with a clean local/remote history match for all 28.
- `pnpm format:check`, `pnpm lint`, `pnpm test` (44 files, 597 tests), and
  `pnpm build` passed. Both hosts serve an index.html byte-identical to the
  local build; the container is healthy.
