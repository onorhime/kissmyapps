# KissMyApps Affiliate Platform

Shared React and Supabase application for the KissMyApps partner dashboard and
internal admin console. The Partner experience remains useful with zero data, and
the Admin Product Catalog can create the first real product before a funnel exists.
The Admin Affiliate workspace now provides a protected operational directory and
audited lifecycle controls before any product or funnel is launched.

The authoritative implementation checklist is [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).
The production activation/rollback procedure is
[PRODUCTION_ACTIVATION.md](./PRODUCTION_ACTIVATION.md), and the initial backend
deployment evidence is [RELEASE_EVIDENCE_2026-08-28.md](./RELEASE_EVIDENCE_2026-08-28.md).
The first Hostinger dashboard/gateway release is recorded in
[RELEASE_EVIDENCE_2026-08-30.md](./RELEASE_EVIDENCE_2026-08-30.md).
The current Admin Affiliate production release is recorded in
[RELEASE_EVIDENCE_2026-09-01.md](./RELEASE_EVIDENCE_2026-09-01.md).
The current UI scope, review checklist, and live-integration boundaries are in
[UI_IMPLEMENTATION.md](./UI_IMPLEMENTATION.md). The supplied four-page UX v2.0
document has been fully reviewed; [UX_SPEC_RECONCILIATION.md](./UX_SPEC_RECONCILIATION.md)
maps it to the implemented partner frontend, retained manual acceptance gates,
and deferred admin requirements.

## Run the dashboard

The default runtime uses the real KissMyApps Supabase project and shows the
authentication gate when there is no session.

```bash
pnpm install
pnpm dev --host 127.0.0.1
```

Open the exact URL printed by Vite. Navigation uses hash routes, including
`#profile/payment`, `#profile/terms`, `#profile/documents`, and `#profile/security`.
The enabled Admin routes are `#admin/overview`, `#admin/products`,
`#admin/affiliates`, and `#admin/affiliates/:affiliateId`. The live auth
routes are `#auth/sign-in`, `#auth/recover`, and `#auth/reset`; the requested
Partner or Admin destination is preserved through sign-in.

The local `.env.local` must contain the browser-safe URL and key for the connected
project:

```text
VITE_SUPABASE_URL=https://mmyruzjemjecqyivhrgr.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable-key>
```

Only the project URL and publishable key belong in the browser environment.
Never expose a secret or service-role key through a `VITE_` variable or commit
credentials to Git.

## Production hosting

The production control surfaces are live on the Hostinger VPS at:

- `https://partners.kissmyapps.dev` — Partner workspace;
- `https://admin.kissmyapps.dev` — Admin workspace; and
- `https://go.kissmyapps.dev` — redirect gateway, limited to `GET /r/*`.

Partner and Admin share one immutable frontend artifact but choose their default
workspace from the hostname. The dashboard runs in the isolated, unprivileged
`kissmyapps-dashboard` container with no host port and joins the existing
`dramapal_application` network only so the existing edge Caddy can proxy it.
`go` forwards directly to the production `tracking-redirect` Edge Function.
Tracking remains disabled, so this hosting milestone does not authorize live
acquisition traffic.

### Opt-in fixture preview

Use the explicit preview flag when reviewing the historical sample, empty,
loading, unavailable, and partial-data states without an authenticated account:

```bash
VITE_ENABLE_UI_PREVIEW=true pnpm dev --host 127.0.0.1
```

In preview mode, use the bottom Design preview controls to move between states.
The four partner areas are Performance, Payouts, Links & Sources, and Profile &
Documents. The approved visual direction also includes sign-in, password
recovery, and reset scenarios.

Preview fixtures stay in browser memory and reset on reload. All example tracking
URLs use the reserved `.invalid` domain. Sample link/profile changes, CSV exports,
five payout PDFs, document metadata, and discrepancy forms are demonstrations,
not live records, legal documents, payment evidence, or submitted cases. Do not
enter real personal, bank, wallet, password, or account credentials in preview
scenarios.

## Connected Supabase foundation

The application is linked directly to the real Supabase project
`mmyruzjemjecqyivhrgr` (**KissMyApps**). No local or staging Supabase runtime is
part of this workflow.

All 15 migrations from `20260825215958_platform_foundation` through
`20260901100000_admin_affiliate_management` are applied remotely. The
deployed foundation now includes:

- default-deny RLS and zero browser-role grants on public base tables;
- tenant-safe Partner views plus password-proven Admin RPCs;
- the private `affiliate-private-documents` storage bucket;
- real Supabase invitation acceptance, sign-in, session refresh, password
  recovery/reset, activation, and sign-out;
- product/funnel/source/campaign/agreement/rule/main-link configuration;
- live Stripe subscription-offer verification and trusted Checkout preparation;
- click/acquisition capture, browser and signed funnel-event ingestion, immutable
  Stripe evidence, commercial ledger processing, metrics, and reconciliation;
- per-funnel signing-key scope, public database rate limits, atomic retry
  handling, and privacy-minimized Stripe webhook storage;
- ten active production Edge Functions with application-level authentication,
  while tracking remains disabled and external integration secrets are absent;
- public Partner registration with immutable Terms/Privacy evidence and
  confirmed-email activation; and
- protected Admin Affiliate summary, directory, detail, and audited lifecycle
  RPCs with Owner-only termination and commercial-record blockers.

No funnel, link, click, conversion, transaction, payout, or storage object has
been seeded. One existing draft product named `test` was preserved. Public
registration records are retained, and the QA administrator remains
least-privilege `operations`; no Owner authority was granted for this release.

### Admin product configuration

The protected `#admin/overview`, `#admin/products`, and
`#admin/products/:id/configuration` routes are live in the application. Product
creation still accepts only a name and canonical slug and always begins in
`draft`. The configuration route can add the future funnel URL, sources,
campaigns, partner agreement/rule, verified subscription offer, and issued main
link through password-proven RPCs; the browser has no direct base-table access.

Activation is fail-closed. A usable link requires a live funnel, one exact active
subscription offer verified against Stripe live mode, one supported active
purchase rule, and a current agreement document signed by both parties. The
other remaining top-level Admin modules stay visible as a roadmap but are not
yet enabled.

### Admin affiliate management

The protected `#admin/affiliates` directory is live with search, status/product
filters, sorting, pagination, and registration, email-confirmation, activation,
legal-acceptance, agreement, product, and link evidence. Selecting a row opens a
route-backed detail dialog. Operations and Owner administrators can pause or
reactivate a Partner after password verification; termination is Owner-only,
requires the exact affiliate slug, and fails closed while blocking agreements,
documents, or unsettled payouts exist. Every lifecycle mutation writes immutable
audit history. The browser never receives direct base-table access.

Partner, Admin, and Auth surfaces now use the canonical `kissmyapps.dev` dark
palette, Outfit typeface, and lips/sparkle mark. Favicons use the transparent live
SVG/PNG assets rather than the supplied opaque-corner raster.

Hosted Auth uses `https://partners.kissmyapps.dev` as the Site URL and allows only
the exact Partner/Admin `/#auth/reset` callbacks. Public Partner signup is
enabled, confirmed-email sign-in and the 12-character minimum remain enforced,
and secure password change is enabled. “Require current password” is disabled
because a newly invited user does not know Supabase's temporary invitation
password; the activation gate below supplies the required proof before workspace
access is granted. Resend SMTP is configured for hosted Auth mail; broader
transactional lifecycle email remains deferred.

The hosted invite email uses a custom token-hash callback instead of Supabase's
default implicit-token redirect:

```text
{{ .SiteURL }}/?auth_action=invite&token_hash={{ .TokenHash }}&type=invite
```

The browser exchanges that one-time hash with `verifyOtp`, removes all callback
parameters from the visible URL, and presents the create-password screen. The
exact hosted HTML is tracked in [supabase/templates/invite.html](./supabase/templates/invite.html),
but deploying or changing the template remains a manual Supabase Dashboard step.

Migration `20260827223000_partner_invitation_activation` keeps an invited
membership pending and outside all partner-facing RLS data until the user creates
a password, signs in with that password, and completes the guarded activation
RPC. An invite-token session or merely changing the stored password cannot grant
workspace access.

The first QA invitation was consumed by the earlier callback flow, then recovered
and activated successfully. The same account is now used for the Partner and
least-privilege Operations Admin acceptance paths; it does not need another
partner record, invitation, or Auth user.

Private document authorization exists at the database/storage layer, but the
upload, download-signing, and legal-signature UI/end-to-end flow is not complete.
The Stripe/redirect/commercial backend is deployed but deliberately unconfigured:
there is no real funnel origin, Stripe secret/Price, webhook secret, signed
agreement, worker schedule, or live traffic. Singular, Amplitude outbound
processing, email, and payout-transfer automation are not deployed. Payout
release remains a human-approved operational step.

## Validation

```bash
pnpm format:check
pnpm validate
```

The current web suite covers 35 files and 458 tests, together with formatting,
lint, the funnel integration contract, TypeScript, and a production build. It covers fixture
calculations, token-hash invitation acceptance (including React Strict Mode's
development effect replay), activation gating, auth/session behavior, tenant-safe
Partner/Admin gateway behavior, live authenticated zero-data handling, draft-only
product controls, UI interactions, and automated accessibility structure. jsdom
tests do not prove
rendered contrast, responsive layout, native downloads, physical QR scanning, or
real screen-reader behavior.

The first QA partner completed password recovery on the real project. Remote
read-back confirms an active, non-pending membership, and an authenticated
allowlist check returns one partner profile with zero partner-available products,
links, payouts, documents, or agreements. The same account resolves as an active
Operations Admin and can see the preserved draft product named `test`; it remains
unavailable to Partners. Authenticated desktop and 390px checks of the local Vite
runtime connected to the real project confirmed the Admin routes, no page-level
horizontal overflow, mobile navigation/workspace switching, focus movement, slug
generation, and a clean console without creating additional product data.
That evidence predates the deployed Admin Affiliate workspace and does not count
as its authenticated production visual acceptance.

The production backend validation additionally passes 724 of 724 PostgreSQL 17
assertions across a fresh 15-migration replay and 16 pgTAP files, 51 of 51 Edge tests, all ten
Function entrypoint checks, an exact remote migration-history read-back, and a
clean remote database lint. The deployed Function smoke checks fail closed as
expected while integration configuration is absent.

Historical opt-in preview evidence and remaining manual browser/device gates are
recorded in [REPORTING_UI_QA.md](./REPORTING_UI_QA.md),
[PAYOUT_UI_QA.md](./PAYOUT_UI_QA.md),
[PARTNER_MANAGEMENT_UI_QA.md](./PARTNER_MANAGEMENT_UI_QA.md), and
[BROWSER_QA.md](./BROWSER_QA.md).

## Remaining build order

1. Complete the signed-in production Admin Affiliate desktop/mobile acceptance
   pass without mutating the current QA Partner lifecycle.
2. Create or rename the first real draft product, then build and connect its real
   production funnel.
3. Add the live Stripe subscription Price and secrets, configure the signed
   webhook endpoint, and verify the offer from Admin.
4. Create the real partner commission terms and complete both signatures before
   issuing an active main link.
5. Configure monitoring and worker schedules, then validate the full production
   redirect-to-reconciliation journey before enabling tracking.
6. Add document upload/signing, a controlled payout release procedure, Singular,
   the approved Amplitude subset, and the remaining Admin P2 modules after
   Affiliates.

## Source-of-truth boundaries

- Click tracker: click and session attribution.
- Singular: mobile install and re-engagement attribution.
- Stripe: billing and settlement facts.
- Supabase: canonical acquisition, entitlement, commission, payout, documents, and reconciliation.
- Amplitude: behavioral analytics only, not commercial attribution or payout truth.

Canonical identity continuity:

```text
click_id -> acquisition_id -> account_id
```
