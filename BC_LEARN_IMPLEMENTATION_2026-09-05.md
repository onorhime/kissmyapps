# BC Learn integration implementation — 2026-09-05

Scope: local implementation, automated verification and hosted transaction-only
rollback checks. NOT a production release or live-payment acceptance report.

## Implemented

- Preserved the existing BC Learn theme, logo, welcome and three question pages.
- Added a fifth-screen personalized paywall with server-verified amount and
  recurrence, explicit recurring/live-test acknowledgement, price-review errors,
  cancel-return information, retry-safe per-click/offer/version attempt keys,
  focus/scroll handling and guarded progress storage.
- Added same-origin offer/checkout/status adapters using per-funnel HMAC, signed
  HttpOnly quote/receipt cookies, exact Origin checks and bounded requests.
- Added server-only funnel-checkout-context Edge source and migration
  20260905110000_funnel_checkout_context. Checkout supports quoted versions and
  durable rate limits. Neither new definition was permanently applied.
- Payment return page waits for backend-verified payment status. A URL or browser
  event cannot claim payment or app access. No entitlement integration is claimed.
- Retired the legacy unattributed Stripe endpoint (410), redirected /plan to /,
  and preserved the original waitlist separately at /speak.
- Wrote API contract v1.1, OpenAPI JSON, and a readable developer page in both
  projects. Four vendored SDK modules match the canonical package exactly.

## Verification

- Dashboard pnpm validate: 617 tests passed, formatting/lint/type checks and
  production build passed. Existing jsdom canvas notices and bundle-size warning
  remain nonfatal. Final focused SDK rerun: 20 tests passed.
- Edge: 71 tests passed, including the real HMAC/cookie adapter across both Edge
  handlers with mocked provider/persistence. Deno formatting/lint/type checks pass.
- Hosted regression: 57 combined audit/funnel SQL assertions passed in one
  BEGIN/ROLLBACK transaction. No HTTP, Auth API, email or Stripe request was
  invoked by those synthetic fixtures.
- Independent hosted readback: products=0, documents=0, checkout_attempts=0,
  new_migration_applied=0. These are readback counts, not deletion performed here.
- Funnel lint and TypeScript passed; 25 unit tests plus 7 rendered-HTML tests pass.
  Both Vinext production build and Vercel's Next.js production build pass.
  Preserved legacy source tests are included in the 25; their old price fixtures
  are not approval of the new test offer.
- SDK/Markdown/OpenAPI parity check passed:
  node scripts/check-bc-funnel-contract.mjs
- Local non-browser GET checks: / and both developer HTML/OpenAPI endpoints 200.
  Local offer API returns 503 configuration_pending, intentionally.
- Generated .next/static and dist/client JavaScript had no matches for the
  checked server-only credential identifiers/signing implementation markers.
  No secrets were printed, changed or written into client code.
- git diff --check passed. No interactive browser, device or screen-reader QA
  performed during this build-before-testing request.

## Local preview

http://localhost:3000/
http://localhost:3000/developers/funnels/index.html

The dev server was left running. Existing .env.local, Vercel project identity,
Sites project identity and unrelated dashboard changes were preserved.
The Sites skill guided preservation of the existing project and preview;
the separate Sites publication was not used as a substitute for the user's
Vercel deployment target.

## Still required before real end-to-end acceptance

1. Confirm the actual test price/currency/interval. US$1/month remains a proposal,
   not a configured or charged price.
2. Approve final buyer terms, support contact, refund/cancellation instructions.
   The on-site legal page explicitly remains prelaunch wording.
3. Create/configure the real commercial product/funnel, live Stripe Price and
   verified offer, with genuinely reviewed bilateral partner signatures.
4. Approve and apply the new migration, deploy the two affected Edge functions,
   provision the per-funnel key binding and exact origin allowlists, then verify
   the Stripe webhook and Stripe/commercial/metrics worker schedules.
5. Publish to the existing Vercel project with checkout OFF first. Only after
   setup verification and explicit charge approval enable live checkout.
6. Perform interactive/mobile/accessibility QA and the real click → payment →
   webhook → commission → metrics check. Arrange test subscription cancellation
   with the operator; do not erase financial evidence or claim automatic payouts.

No deployment, live charge, real signature, test subscription or external payout
was created in this turn. Public Vercel/Sites URLs remain unchanged by this work.

## Update: confirmed US$1/month and mandatory no-charge discount

This update supersedes the price proposal and paid-test activation wording above.
The user approved US$1/month but explicitly does not authorize a charge. All new
work remains local; no real coupon, checkout, subscription, signature, deployment
or persistent financial data was created.

- Fixed the screenshot's local image-service error: the bundled BC Learn logo
  now uses a direct unoptimized asset. Its HTTP response is 200, and the rendered
  HTML regression rejects logo optimizer URLs. No overlay suppression or global
  image-service changes.
- BC Learn's server adapter always requests require_no_payment=true. One approved
  product-scoped Stripe promotion is pre-applied by the backend. A missing,
  invalid, partial, once-only or inapplicable discount cannot fall back to paid
  checkout. Stripe must return a zero total before the URL is exposed.
- Required operator configuration: an active live promotion backed by a 100%-off
  FOREVER coupon, applicable to the US$1/month product, mapped by internal product
  UUID in FREE_CHECKOUT_PROMOTION_BINDINGS. This is not arbitrary coupon entry.
  Restrict customer/redemption eligibility and test-funnel access. Do not remove
  the subscription discount; arrange cancellation after verification.
- Added a separate zero-total provider normalizer. Signed live session evidence,
  exact durable attribution/list price/full discount, live subscription ownership
  and the worker lease are reconciled before completing the attempt. Zero invoices
  need no fake PaymentIntent. Free facts create no cash transaction, paid
  conversion, commission or entitlement. The receipt returns no_payment_required.
- Paywall, confirmation page, HMAC adapter and API docs now agree on this behavior.
  Contract v1.2 and all vendored/published copies match byte-for-byte.
- Pending production work: migrations 20260905110000 and 20260905120000; deploy
  funnel-checkout-context, checkout-session, stripe-webhook and stripe-worker;
  configure product/offer/actual agreement, promotion, scoped keys/origins and
  worker schedules; publish to the existing Vercel project with checkout OFF first.
  Do not substitute the separate Sites publication. Existing hosting identities,
  branding and environment files remain intact.

Verification for this update:
- Dashboard format/lint/type/build and 618 tests passed. Existing canvas/chunk-size
  warnings remain non-blocking. Focused adapter suite passed again after its
  free-status assertions were expanded (10 tests).
- Edge formatting/lint/typecheck and 76 tests passed, including mandatory discount,
  nonzero-total refusal, no-charge signed adapter interoperability, zero invoice,
  invalid evidence and missing configuration checks.
- Hosted BEGIN/ROLLBACK regression: 79 assertions passed. Post-run readback:
  products=0, persisted free test provider events=0, new migrations applied=0.
- Funnel lint/typecheck, Vinext build and 32 tests passed; Next production build
  also passed. The local preview remains at http://localhost:3000/.
- No interactive browser/device/screen-reader acceptance or real Stripe callback
  delivery is claimed. A free test cannot certify paid commissions/refunds/payouts.

Stripe references used for the implementation:
https://docs.stripe.com/billing/subscriptions/coupons
https://docs.stripe.com/api/promotion_codes/object
https://docs.stripe.com/api/checkout/sessions/create

## Update: original /speak duplicate with paywall after email

The user selected /speak as the exact visual and workflow source. This update
supersedes the earlier redesigned PartnerTestFunnel and five-screen description.

- Root / now renders PartnerSignupFunnel, an isolated copy of the original
  WaitlistFunnel. Welcome/waveform, three question screens, email/plan screen,
  typography, colors, question cards, branding and consent bar are preserved.
- The sixth screen is PartnerPaywall, reached only after /api/waitlist returns
  an HTTP-success response with ok=true. Invalid or failed email saves stay on
  the email screen. Repeated choice clicks cannot skip steps.
- Existing Firestore lead capture and its configured welcome-email behavior are
  reused. Tests mock all external requests; no real email was submitted or sent.
  The local endpoint rejected an empty body with HTTP 400 before persistence.
- Email and questionnaire answers remain in React memory and the existing lead
  save payload only, not browser storage or partner event/checkout payloads.
  Stripe may separately request its billing email. Refresh restarts the form;
  retrying the same email uses the existing idempotent waitlist save behavior.
- Partner click capture and landing/funnel/payment-view events are retained.
  The verified offer, terms gate, stable checkout retry key and mandatory $0
  discount path are unchanged. No browser-generated payment truth is added.
- /speak still ends with its original waitlist confirmation and matching step.
  SHA-256 checks prove its component, route, screen data and stylesheet were
  not modified in this update. The shared legal information was corrected to
  describe the existing email capture and in-memory questionnaire accurately.
- Six isolated component-flow checks cover original welcome markup parity,
  email validation/save/retry, paywall ordering, disabled or unattributed
  checkout, terms gating, retry-key reuse, email privacy and original confirmation.
  These use the dashboard's existing Vitest dependencies; no funnel dependency
  or lockfile change was required. Run pnpm test:funnel:ui in the dashboard.
- Public contract copies and OpenAPI now document the email step and its
  distinction from financial attribution. The four canonical SDK files remain
  unchanged and byte-identical to their vendored copies.

This is local implementation, not production deployment or live payment/email
acceptance. Existing Vercel/Sites identities and environment files are preserved.
The preview remains http://localhost:3000/; original http://localhost:3000/speak.

## Update: Vercel next-phase readiness — 2026-09-05

The user confirmed Vercel as the funnel host. Read-only production inspection
verified the existing bc-learn-funnel project is accessible under Victory
Onorhime's projects, with Next.js, next build, and Node.js 24.x configured.
No new Site or Vercel project was created.

- Target: https://bc-learn-funnel.vercel.app (root becomes the approved six-screen
  email-then-paywall flow; /speak retains the original waitlist).
- Current production / rollback reference: dpl_Cwjmx2EjoeKYEDLVaLLdgwMahkf8,
  https://bc-learn-funnel-gy46mgq26-victory-onorhimes-projects.vercel.app,
  created 2026-08-27. Re-inspect immediately before replacing it.
- Vercel production lists the existing Firebase, Resend, and Amplitude variable
  names; their values were not retrieved. No KMA variables are configured.
  Presence is not evidence of successful real email delivery.
- The hosted Supabase products query returned zero rows. No product, funnel,
  offer, signature, or test data was created by this readiness check.
- Migration history is current through 20260905093000. Migrations
  20260905110000 and 20260905120000 remain pending. Eleven Edge functions are
  active; funnel-checkout-context is not yet deployed.
- Supabase secret-name inspection shows no STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET, FUNNEL_HMAC_BINDINGS,
  CHECKOUT_ALLOWED_REDIRECT_ORIGINS, or FREE_CHECKOUT_PROMOTION_BINDINGS.
  Existing BROWSER_EVENT_ALLOWED_ORIGINS and INTERNAL_WORKER_SECRET are present;
  their contents were not read or replaced.
- The database cron inventory contains only kma-agreement-maintenance.
  Stripe/commercial/metrics schedules are not configured in pg_cron. External
  schedulers were not inspected, so do not conclude none exist elsewhere.
- SDK/document parity and all six original-flow component checks passed again.

Next release gate: obtain confirmation before replacing the existing public
Vercel homepage. Publish with KMA_CHECKOUT_ENABLED=false and the exact production
origin, preserving all existing environment variables and /speak. An early UI
release may precede backend configuration only while checkout remains disabled;
it is not an end-to-end-ready release.

Activation still requires the operator's actual BC Learn product/funnel,
US$1/month live Price, verified offer and genuinely signed partner agreement;
the approved restricted 100%-off forever promotion; backend migrations/functions,
scoped keys/origins, Stripe webhook and verified worker schedules. Do not fabricate
signatures, offer IDs, credentials, or a free subscription.

After activation, verify source-specific links and one approved zero-total
checkout separately from positive-payment/commission/payout acceptance.
No public deployment, secret change, migration application, email, charge, or
subscription was performed in this readiness phase.

## Update: separate Vercel project published — 2026-09-05

The user's clarification overrides the earlier replacement proposal: do NOT
replace or deploy to the old bc-learn-funnel project.

- New project: bc-learn-partner-funnel / prj_FttYGokNkTc0yfHKiajJLueErWSf,
  team_gylBU6BaCCJ9HorjCBjS0d5d.
- New production URL: https://bc-learn-partner-funnel.vercel.app.
- First production deployment: dpl_8KvG2xRAuvkSLRjmsPEgtdQewPWs,
  https://bc-learn-partner-funnel-a1ym7bab3-victory-onorhimes-projects.vercel.app.
  Vercel reported Ready after its Next.js build and TypeScript checks passed.
- Old https://bc-learn-funnel.vercel.app still resolves in Vercel to
  dpl_Cwjmx2EjoeKYEDLVaLLdgwMahkf8. Its project, aliases and production deployment
  were not modified. No Sites deployment was created.
- The local .vercel/project.json now targets ONLY the new project, preventing
  accidental default deployment to the old app. Its former link is preserved in
  .vercel/original-project.json for reference, not as a release target.
- Canonical API docs, both public doc sets, OpenAPI, metadata fallback and example
  environment now use the new origin. SDK parity and all six flow checks pass.
- The new project's production environment uses the already available local
  Firebase/Resend settings, with private credentials marked sensitive. Test lead
  storage is isolated with FIREBASE_WAITLIST_COLLECTION=partner_funnel_test.
  Original provider data was not changed or copied. Optional Amplitude is left
  unconfigured on the new project to avoid mixing test events with the old app.
- KMA_FUNNEL_ORIGIN is the new exact HTTPS origin and KMA_CHECKOUT_ENABLED=false.
  No fake offer/HMAC key, Stripe key or product was inserted. The backend remains
  unconfigured as recorded in the preceding readiness snapshot.
- .vercelignore explicitly excludes local environment/secret files, previous
  build outputs and operational notes from uploaded deployment source.
- Public non-mutating checks: eight GETs returned 200, including root, /speak,
  legal, receipt, logo and all three developer docs. Deployed Markdown/OpenAPI
  exactly match local canonical copies. Empty offer/checkout POSTs return 503
  configuration_pending; empty waitlist POST returns 400 and retired standalone
  checkout returns 410. No real email or checkout was submitted.

This is a live UI/documentation release with checkout OFF, not end-to-end payment
or recipient-delivery acceptance. Real signup saving/welcome delivery still need
operator testing. Product/offer/agreement, restricted forever discount, backend
release, scoped origins/keys, webhook and worker setup remain activation gates.
This is the first release of the new project; there is no previous new-project
deployment to roll back to. Do not use the unrelated old app as a rollback target.
