# KissMyApps Affiliate Platform Implementation Plan

This checklist is the implementation and acceptance-test source of truth for the platform. Jira remains the product source; this file reconciles the current technical decisions into build order.

## Locked foundation decisions

- [x] Use the Affiliate Platform Senior Developer Specification v3.2 when it conflicts with older P1/P2 notes.
- [x] Use **Partner** in partner-facing copy and **Affiliate** for internal entities and database names.
- [x] Partner portal navigation: Performance, Payouts, Links & Sources, Profile & Documents.
- [x] Admin navigation: Overview, Affiliates, Funnels & Links, Attribution, Subscriptions, Payouts, Documents, Data Health, Settings.
- [x] Persist payout status as `review`; display “Pending review” where clearer in the UI.
- [x] Use React, TypeScript, Vite, and Supabase.
- [x] No product or funnel is assumed; the partner dashboard must have complete zero-data states.
- [x] Use the designated real Supabase project directly; there is no local or staging Supabase runtime.
- [x] Identify and inspect the exact real project before linking or migrating: `mmyruzjemjecqyivhrgr` (`KissMyApps`) was empty before the foundation deployment.
- [x] Build a custom Partner UI in the existing React project during the initial Supabase-access wait; no purchased dashboard template is required.
- [x] Keep UI fixtures clearly labelled, local to browser memory, and separate from real product/account state.
- [x] User approved the custom visual direction; retain the fixture experience behind an explicit preview flag while live Supabase Auth is the default runtime.
- [x] Match the shared Partner/Auth/Admin presentation to the canonical `kissmyapps.dev` dark palette, Outfit typography, and lips/sparkle logo; use the live SVG/PNG assets for crisp transparent favicons.
- [x] Read the user-supplied `KissMyApps_Affiliate_Portal_UX_Spec_v2.0.docx` completely on 2026-08-26: all eight tables and four rendered pages. Reconcile its requirements in [UX_SPEC_RECONCILIATION.md](./UX_SPEC_RECONCILIATION.md), retaining v3.2 precedence and the user's no-product/no-local-Supabase direction.

## M0 - Core schema, authentication, and RLS

- [x] Initialize Git and the React/TypeScript application.
- [x] Initialize versioned Supabase migration configuration.
- [x] Add product, profile, administrator, affiliate, and customer-account records.
- [x] Add versioned agreements and commission rules for CPL, CPA, Revenue Share, and Hybrid models.
- [x] Add funnels, sources, campaigns, affiliate links, clicks, and canonical acquisitions.
- [x] Add persisted provider callbacks and normalized canonical events.
- [x] Add Stripe subscriptions, transactions, refunds, and disputes.
- [x] Add customer entitlements and qualified conversions.
- [x] Add payout periods, append-only commission entries, payouts, and documents.
- [x] Add immutable audit history and reconciliation runs.
- [x] Add default-deny RLS with affiliate and customer tenant isolation.
- [x] Keep commercial and entitlement writes server/RPC controlled.
- [x] Historical foundation validation: clean migration replay, database lint, and 49 database contract tests passed on 2026-08-25 before the no-local-Supabase direction. This is retained as historical evidence, not the current remote acceptance result.
- [x] Historical foundation web validation: lint, 2 shell tests, and build passed on 2026-08-25. The shell tests have now been replaced by the UI regression suite.
- [x] Inspect the real `KissMyApps` project before deployment: zero public relations/routines, Auth users, storage buckets/objects, or migration-history rows were present.
- [x] Apply `20260825215958_platform_foundation` to `mmyruzjemjecqyivhrgr` without roles, seeds, products, funnels, partners, or users.
- [x] Verify all 36 public tables have RLS, browser roles have zero base-table grants, and the partner browser surface is limited to eight views and 15 authenticated helper/RPC functions.
- [x] Create the private `affiliate-private-documents` bucket and its record-scoped read policies; no storage objects are seeded.
- [x] Pass 251 of 251 pgTAP checks and remote database lint against the deployed project.
- [x] Apply `20260827223000_partner_invitation_activation` remotely so invite-created memberships remain pending and outside partner-facing RLS until a password-authenticated session completes activation.
- [x] Require both a confirmed password credential and a password method in the JWT before `complete_partner_activation` can make a pending membership active; an invite session, stored password change alone, or unrelated Auth user must fail closed.
- [x] Apply `20260828110000_admin_product_foundation` remotely with protected Admin context/product-list/draft-create RPCs, an exact browser-function allowlist, no direct product-table grants, and product audit history.
- [x] Apply all 12 additive migrations through
      `20260828220000_stripe_webhook_payload_minimization` to the linked production
      project; preserve the QA identities and existing draft `test` product.
- [x] Pass 592 of 592 PostgreSQL 17 assertions on a fresh full replay, match all
      12 local/remote migration versions exactly, and pass remote database lint.
- [x] Apply public Partner registration, confirmation-OTP correction, and
      protected Admin Affiliate management through
      `20260901100000_admin_affiliate_management`; match all 15 local/remote
      migrations and pass 724 of 724 assertions across the complete 16-file
      PostgreSQL 17 suite.

## M1 - Partner dashboard

### M1a - Opt-in fixture preview and historical UI acceptance

- [x] Build the responsive Partner shell: Performance, Payouts, Links & Sources, Profile & Documents.
- [x] Build explicit sample, zero-data, loading, and unavailable states, plus partial attribution on Performance.
- [x] Build performance cards, metric selection, date/source/advanced filters, source/day/week/month breakdowns, pagination, and sample CSV export.
- [x] Build payout history, status filtering, details, and clearly labelled sample statements.
- [x] Build tracked-link listing, search, copying, preview creation/pause, and no-product empty state.
- [x] Build session-only partner-profile editing, read-only payment preferences, document previews, and gated security surfaces.
- [x] Add accessible names, table semantics, reduced motion, modal focus restoration, and skip-link navigation.
- [x] Build sign-in, recovery, and reset-link UI previews with fictional inputs, validation, visibility toggles, result/error states, and no authentication or email operations.
- [x] Pass 102 interaction, calculation, structural-accessibility, and color-token tests on 2026-08-26.
- [x] Pass lint, formatting, TypeScript checks, 102 tests, and production build for this UI revision on 2026-08-26.
- [x] Run targeted 320px/390px layout and native Chrome keyboard checks; repair toolbar/form/table overflow, field-error focus, and focus scroll reveal.
- [x] Complete the available extended browser matrix: 44 responsive route/state cases, native Chrome keyboard traversal, dialog resize/history/focus trapping, long content, and 17 targeted rendered color pairs. Fix observed clipping, modal focus, feedback, and contrast defects; see [BROWSER_QA.md](./BROWSER_QA.md).
- [ ] Complete the manual accessibility/device gates: actual browser zoom, real reduced-motion preference, screen-reader announcements, Safari, and physical mobile keyboards. Do not equate viewport emulation or jsdom with this proof.

See [UI_IMPLEMENTATION.md](./UI_IMPLEMENTATION.md) for evidence and live-data boundaries.

### M1a2 - Complete UX v2.0 fixture requirements, independent of live Supabase data

The UI QA pass is not full specification completion. Use the IDs in
[UX_SPEC_RECONCILIATION.md](./UX_SPEC_RECONCILIATION.md) as acceptance criteria.

- [x] Add product/no-product selection, contextual commercial information, 14/30/90/year/custom dates, and independent calendar time grouping (G2–G4). Preview fixtures only.
- [x] Complete KPI names/definitions, current Active Subscriptions, three chart groups/up to three series, full table/CSV content, sorting, sticky totals, and all breakdowns (P1–P4). Native downloaded-file acceptance remains a manual gate.
- [x] Add five-provider freshness and reconciliation-state previews while preserving unknown values across KPIs/charts/tables/CSV (P5).
- [x] Validate the reporting phase with 151 tests, lint, formatting, TypeScript/build, 24 responsive route/size checks, five Performance states, custom-date interactions, and 19 mobile sort-header focus checks. See [REPORTING_UI_QA.md](./REPORTING_UI_QA.md) for exact evidence and native-browser limitations.
- [x] Complete payout commercial context, next payment date, gross-to-net/count-times-rate transparency, all status scenarios, PDF/CSV statement presentation, and money-history/discrepancy previews (Y1–Y5). Preview only; no payment or report submission.
- [x] Validate the payout phase with 197 tests, warning-free lint, formatting, TypeScript/build, 54 responsive route/state/dialog cases, focus/contrast checks, and all ten sample PDF pages. A sample PDF download event succeeded; native CSV/file-open and full native Tab traversal remain gates. See [PAYOUT_UI_QA.md](./PAYOUT_UI_QA.md).
- [x] Add main/QR links, all tracking dimensions in the shared sample URL, complete performance columns, zero-history variants, reversible archive, and exact link-scoped Performance (L1–L3).
- [x] Complete legal/contact/audience profile fields, read-only commercial terms/versions, seven document types/eight lifecycle states with independent signatures, and the six permitted notification categories (R1–R3, S1).
- [x] Validate the management phase with 276 tests, warning-free lint, formatting, TypeScript/build, 48 responsive route checks, 40 data-state checks, 36 dialog checks, focus/long-content checks, 13 rendered color samples, and independent decoding of the actual browser QR. See [PARTNER_MANAGEMENT_UI_QA.md](./PARTNER_MANAGEMENT_UI_QA.md).
- [x] Preserve these sample and failure-state fixtures behind `VITE_ENABLE_UI_PREVIEW=true`; they are not the default live runtime or proof of authenticated production data.
- [ ] Finish full native keyboard traversal, native downloaded-file/physical QR checks, screen-reader/device/zoom acceptance, and the retained reporting/payout manual gates. Automated checks and in-app dialog wrapping do not replace these.

### M1b - Live partner foundation on the real project

- [x] Connect and locally configure the designated project `mmyruzjemjecqyivhrgr` (`KissMyApps`).
- [x] Implement real Supabase sign-in, password recovery/reset, session refresh/handling, route gating, and sign-out.
- [x] Replace base-table browser access with tenant/role-checked partner views and RPCs, including explicit output contracts for reporting, payouts, links, profile, and settings.
- [x] Wire the typed partner gateway and live workspace provider to the safe remote contracts, including the authenticated zero-product/zero-funnel state.
- [x] Connect tenant-safe performance summary/trend contracts with date, timezone, source, product, funnel, currency, completeness, and freshness inputs.
- [x] Connect authorized payout summary/history/detail contracts and preserve immutable payout/commission snapshots at the database layer.
- [x] Connect tracked-link create/update/status contracts and prevent live link creation without valid configured product/funnel membership.
- [x] Connect persistent partner profile/settings contracts and the private document authorization/storage foundation.
- [x] Implement a custom token-hash invite callback: accept only the explicit invite query contract, exchange the one-time hash with `verifyOtp`, scrub callback parameters, and present create-password UI without using the incompatible implicit-token invitation redirect.
- [x] Save and reload the hosted invite template using the token-hash callback. Keep its exact source in [supabase/templates/invite.html](./supabase/templates/invite.html); hosted deployment remains a manual Supabase Dashboard operation.
- [x] Confirm and apply hosted Auth site/redirect URLs, public Partner signup,
      confirmed email, and a 12-character minimum password with the user's
      action-time approval. Keep Admin signup unavailable.
- [x] Keep secure password change enabled but disable “Require current password” so an invitee can replace Supabase's unknown temporary invitation password; rely on the password-sign-in activation gate for workspace authorization.
- [x] Pass the partner-activation revision's local web suite of 32 files and 386 tests, including single-use invite handling under React Strict Mode, activation/RLS gating, Auth, Partner/Admin gateways, authenticated zero-data coverage, product configuration controls, UI interactions, and structural accessibility.
- [x] Send exactly one recovery link for the already-consumed first QA invitation. Do not create a duplicate partner or resend the consumed invitation.
- [x] Complete password recovery and activation for the first QA partner. Remote read-back confirms a verified, signed-in Auth user and `active = true`, `activation_pending = false`, with an activation timestamp.
- [x] Recheck the live partner allowlists as that authenticated user: exactly one profile is visible and products, links, payouts, documents, and agreements are all correctly empty.
- [ ] Complete the remaining authenticated visual/responsive and live sign-out checks in a browser tab shared with QA.
- [ ] Build the first product/funnel and verify non-empty reporting, links, payouts, paused-product history, currency, and freshness behavior end to end.
- [ ] Implement document upload/download-signing UI, signatures, payment-destination verification/holds, and their authenticated end-to-end checks.
- [ ] Complete authenticated desktop, tablet, mobile, keyboard, screen-reader, zoom, Safari, and physical-device QA.

### M1c - Admin P2 product foundation, moved ahead of the first funnel by user direction

- [x] Build protected `#admin/overview` and `#admin/products` routes without weakening the existing Partner route gate.
- [x] Build the action-first Admin shell and full P2 navigation map; enable Overview and Products now and label the remaining modules as upcoming.
- [x] List the real product catalog and create only `{ name, slug }` draft records through protected RPCs.
- [x] Keep product activation, editing, deletion, funnel fields, commercial rules, attribution, and payout operations outside this first slice.
- [x] Provision the existing QA user as an active least-privilege `operations` administrator; do not grant owner authority or create another Auth user.
- [x] Verify the authenticated Admin empty state in the local Vite runtime connected to the real project on desktop and 390px mobile, including no horizontal page overflow, mobile navigation, workspace switching, slug generation, route focus, and a clean browser console.
- [x] Preserve the existing draft product named `test`; no funnel, active product,
      or fabricated commercial record was created.
- [ ] Replace or rename the placeholder draft with the first approved product name
      and slug.
- [ ] Add the first funnel only after its real destination and launch inputs exist, then enforce readiness before product activation.

### M1d - Production product-configuration backend

- [x] Add protected product configuration for funnels, sources, campaigns,
      agreements, commission rules, billing offers, product activation, and main-link
      issuance without direct browser table access.
- [x] Require an effective active agreement, exactly one supported purchase rule,
      a current bilaterally signed document, a live funnel, and an exact live-verified
      Stripe subscription offer before a usable link can exist.
- [x] Add the Admin product-configuration UI with truthful per-section and overall
      readiness blockers.
- [x] Keep one-time payments, CPL, unsigned agreements, unverified Prices, and
      incomplete funnels fail-closed.
- [x] Add a separate Owner-approved tracking-only mode bound to an exact live
      funnel snapshot, with immutable non-commercial provenance and direct
      rejection of every commercial write path.
- [x] Add live Partner link derivation, source/event reporting, truthful
      non-commercial metric states, and the owned no-checkout demo funnel page.
- [x] Apply migration `20260901190000_tracking_only_demo_mode` and deploy source
      `38e8410` to the immutable Hostinger release recorded in
      `RELEASE_EVIDENCE_2026-09-01_TRACKING_ONLY_DEMO.md`.
- [ ] Complete password-proven production provisioning and exercise the TikTok
      and Instagram demo links. The controlled browser session is currently
      signed out; no demo product, link, click, or event has been created yet.

### M1e - Admin Affiliate management

- [x] Add protected `#admin/affiliates` and route-backed
      `#admin/affiliates/:affiliateId` detail views without exposing base tables.
- [x] Add a searchable, filterable, sortable, paginated directory with summary
      counts and registration, confirmation, activation, legal, agreement,
      product, link, and lifecycle evidence.
- [x] Add password-proven pause/reactivate for Operations and Owner, with
      immutable audit history and idempotent lifecycle enforcement.
- [x] Restrict permanent termination to Owner, require the exact affiliate slug,
      and block it while qualifying agreements, documents, or unsettled payouts
      exist.
- [x] Add responsive labelled cards, route-close focus recovery, invalid-field
      focus, and 44px lifecycle actions.
- [x] Validate the release with 35 web files / 458 tests, 724 of 724 database
      assertions, 51 of 51 Edge tests, remote migration parity, and remote lint
      with no errors.
- [ ] Complete authenticated production desktop/mobile visual acceptance. The
      available production browser session is signed out; source, database, and
      public-host checks do not substitute for this gate.

## M2 - First product, funnel, click tracker, and Web2App events

- [x] Implement and deploy `GET /r/:affiliate/:public_code` behind the production
      tracking kill switch; attach `go.kissmyapps.dev` through the existing
      Hostinger edge Caddy while keeping tracking disabled.
- [x] Create an opaque `click_id` and initial canonical acquisition atomically.
- [x] Resolve country/session context while persisting only keyed SHA-256 hashes,
      never raw IP or user-agent values.
- [x] Validate allowlisted browser and signed funnel-server events.
- [x] Bind every funnel signing key to one exact product/funnel and independently
      verify that scope against the canonical click.
- [x] Add durable per-route/per-click public rate limits and atomic exact-retry
      idempotency.
- [ ] Preserve `click_id -> acquisition_id -> account_id` across browser/app environments without shared-cookie assumptions.
- [ ] Reject self-referrals, bots, and duplicate qualifying leads.

## M3 - Stripe and entitlements

- [x] Create live subscription Checkout from trusted acquisition and server-owned
      offer state with Stripe idempotency, bounded timeouts, and no browser-supplied
      price or redirect values.
- [x] Signature-verify only allowlisted live Stripe events, minimize persisted
      fields, and retain an exact raw-body digest without customer PII/payment data.
- [x] Deduplicate exact retries, reject conflicting event IDs, and retry supported
      out-of-order dependencies.
- [x] Normalize paid subscription Checkout, renewals, cancellations, refunds, and
      disputes into canonical immutable facts.
- [ ] Load premium entitlement after app login.
      Deferred by the owner on September 7, 2026: BC Learn has no app/backend yet.
      Future developer requirements are documented in funnel API section 7.1
      and `APP_ACCESS_INTEGRATION_2026-09-07.md`; this is not a live access API.

## M4-M6 - Attribution, behavior, and money

- [ ] Merge Singular install/re-engagement attribution without duplicate commercial records.
- [ ] Mirror a sanitized behavioral subset to Amplitude server-side.
- [x] Calculate deterministic CPA/revenue-share/hybrid purchase commissions from
      signed versioned agreements and verified Stripe settlement values, including
      append-only refund/dispute reversals.
- [x] Add protected 14-day UTC payout-period and statement preparation contracts;
      scheduling, carry-forward execution, approval, and transfer remain operational
      work.
- [ ] Add a controlled, human-approved payout release process before considering automated provider transfers.

## M7 - Admin console and hardening

- [x] Start the action-first Admin console with Overview, Products, and a safe switch back to the authenticated Partner workspace.
- [x] Add the protected Affiliates directory, evidence detail, and audited
      lifecycle workflows.
- [x] Add protected Funnels & Links, Attribution, Data Health, and Platform
      Settings workflows without placeholder commercial data. Keep the canonical
      tracking switch disabled until one correlated launch chain is ready.
- [x] Implement and locally validate the read-only Admin Subscriptions directory,
      filters and billing/attribution details (September 7). See
      `ADMIN_SUBSCRIPTIONS_2026-09-07.md`; the candidate database checks rolled back.
- [x] Deploy Admin Subscriptions (September 7): additive read-only RPC, 108 public
      asset checks and unchanged billing/role/security fingerprints. See
      `RELEASE_EVIDENCE_2026-09-07_ADMIN_SUBSCRIPTIONS.md`.
- [ ] Verify the password-authenticated Admin Subscriptions production view;
      the Admin browser is signed out. Database role-context acceptance and
      authenticated Partner-host separation passed, separately from this gate.
- [x] Implement and locally validate the internal Admin Payouts period/statement,
      review, approval, hold/resume and single-agreement carry-forward workflow
      (September 7). See `ADMIN_PAYOUTS_2026-09-07.md`. No transfers or paid-state API;
      candidate migration tests roll back and synthetic fixtures are not live money proof.
- [ ] Deploy the Admin Payouts candidate with approval, then verify authenticated
      production Admin behavior. Real period creation is a separate operator decision.
- [ ] Complete payment-destination onboarding/provider verification, statement
      PDF/delivery, non-14-day cadence and mixed-agreement carry policy, controlled
      payout release and real financial acceptance. Never bypass verification gates.
- [ ] Add the remaining Documents and scoped “View as Partner” workflows.
- [x] Add durable webhook, commercial-fact, metric-refresh, and reconciliation
      queues with bounded leases/retries and redacted diagnostics.
- [x] Deploy current-run failure diagnostics and password-proven Owner/Operations
      processing health in Admin Data Health (September 7). Authenticated live UI
      acceptance remains open; see the processing-alerts release evidence.
- [x] Enable an independent operational failure/recovery email monitor to the
      approved recipient (September 7). Resend accepted the setup test; inbox
      receipt and outside-Supabase outage monitoring remain separate gates.
- [x] Add evidence-backed reconciliation processing; scheduling and a real
      unexplained Stripe difference of `$0.00` remain an activation test.
- [ ] Complete authenticated desktop, tablet, mobile, and accessibility QA.

## Deferred integration boundaries

- Resend SMTP is configured for hosted Supabase Auth confirmation. Broader
  lifecycle/transactional email remains deferred and is not required for the
  Admin Affiliate slice.
- The redirect, browser/funnel event, Stripe, commercial, metrics, and
  reconciliation Functions are deployed but fail closed until real production
  origins, per-funnel key bindings, Stripe values, and schedules are configured.
  Tracking remains disabled. Singular, Amplitude outbound, email, and
  payout-transfer automation are not deployed.
- Amplitude will receive only a sanitized behavioral subset; it will not become the attribution, commission, or payout source of truth.
- Admin remains P2, but the user explicitly moved its secure shell and Product Catalog ahead of the first product/funnel journey so products can be created from the Admin workspace.
