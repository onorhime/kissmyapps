# SpeakSix Marathon TEST setup — 22 October 2026

Completed by the existing admin UI unless noted otherwise:

- Product `SpeakSix Marathon Test` is active; `Marathon Funnel` routing is live.
- Existing offer `marathon-36-lessons` version1 is active at USD169 once. Both SpeakSix enrollment return URLs are saved. The success template includes the literal Stripe session placeholder; SpeakSix does not treat that query value as payment proof.
- Price `price_1USJVhCYo7AEhAYn4qaXLWL4` was verified by the authenticated managed-price-verifier against connected TEST merchant `acct_1UMD6aCYo7AEhAYn`.
- Added only the dedicated `speaksix-marathon-test` managed checkout binding, preserving the earlier fixture binding. Provisioned this product's managed integration configuration. Global checkout, transfers, creator onboarding, external-commerce ingestion and LIVE merchant connection gates remain disabled.
- Journey settings remain TEST /30days. Published reporting version1 has registrations, confirmed attendees (attendance state=`attended`) and completed assessments.
- Removed the unsupported default live-viewer card and the misleading default period/snapshot attendance ratio. Ordered conversion rates belong to the built-in Journey report.
- Deployed the scoped reporting UI and migration69. Explicit Test/Live filters now apply to custom cards; verified aliases and attendance revisions avoid double-counting or stale attendance state.

## Verification

-50 focused UI/report tests, typecheck/build, scoped lint and formatting passed.
-All69 migrations and59 SQL suites passed; the new regression fails on baseline68.
-Hosted rollback-only migration rehearsal passed before application. The apply transaction preserved117 existing tables and336 unrelated functions; edge functions, secrets and financial gates stayed unchanged.
-Frontend release `20261022T150000Z-marathon-test-reporting-550d501eac2a`:78/78 hosted checks passed across admin and partners. Dashboard healthy;15 unrelated containers preserved. Previous release retained. No VPS deletion required.
-Authenticated Safari verified published version1 and loaded Recorded performance in TEST. No classified clicks or recorded events exist yet; sample controls were not used to fabricate results.

## Remaining before a complete attributed TEST journey

1. Add explicit TEST commercial-link issuance without relaxing LIVE verification requirements. Current main-link readiness is LIVE-only; no creator link was issued.
2. Add a dedicated `FUNNEL_HMAC_BINDINGS` entry for this product/funnel and configure the matching SpeakSix metric sender. The managed checkout binding does not configure telemetry. Preserve existing bindings and historical event classifications.
3. Wire SpeakSix checkout and callback credentials to the new binding, still gated off until the controlled test is ready.
4. Create the intended future intake with user-confirmed dates/timezone/deadline and this product/funnel/offer. Do not repurpose the old hosted-acceptance intake.
5. Configure commission funding from the existing signed agreement, then separately approve the controlled TEST checkout. Creator payouts remain disabled. Zoom/provider attendance activation is separate.

## User-facing meanings

Recorded performance reads accepted actual events and verified ledger outcomes. Starter cards are optional views, not the entire event allowlist. Canonical V2 journey milestones require no custom card; legacy/custom events require published definitions. Missing definitions produce a409 and retain SpeakSix outbox work for reconciliation; publishing does not automatically replay it. Sample buttons fill fictional JSON, validate its shape or calculate a preview; they save no events and create no registrations, orders or commissions.
