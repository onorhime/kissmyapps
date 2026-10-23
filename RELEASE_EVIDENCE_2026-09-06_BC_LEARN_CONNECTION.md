# BC Learn connection — 2026-09-06

Scope: approved continuation of the unavailable-price investigation. Connect the
new Vercel funnel and deploy the pending checkout backend, keeping checkout OFF.
This is not a completed payment, webhook, subscription or payout acceptance.

## Outcome

The production same-origin offer endpoint now returns HTTP 200, `BC Learn Monthly`,
USD 100 minor units, interval `month`, interval count 1, version 1, and
`checkout_enabled: false`. Verification reused the user's one existing BC Learn
click; no new tracking redirect was opened. Quote lookup only incremented its
bounded request counter and minted a response cookie (not recorded in evidence).

Before/after application counts: clicks 1; events, checkout attempts, provider
events, subscriptions, transactions and commissions all 0. Protected endpoints
reject unsigned calls. Missing attribution returns 400; a foreign origin returns
403. The disabled checkout boundary returns 503 `checkout_not_enabled`.

## Release identity

- Supabase: `mmyruzjemjecqyivhrgr`.
- Product: `fdbabb87-9743-4521-bc8d-11804fe1185f`.
- Funnel: `0b80cd9d-17b6-4262-9172-0637dcd7dcf6` / `bclearn`.
- Vercel project: `prj_FttYGokNkTc0yfHKiajJLueErWSf`.
- Team: `team_gylBU6BaCCJ9HorjCBjS0d5d`.
- Final deployment: `dpl_3xTHuaCvFicLkQGPpPtrSJU4fBwa`.
- Deployment URL:
  https://bc-learn-partner-funnel-g6b09o78u-victory-onorhimes-projects.vercel.app
- Production alias: https://bc-learn-partner-funnel.vercel.app
- Pre-turn rollback: `dpl_8KvG2xRAuvkSLRjmsPEgtdQewPWs` /
  https://bc-learn-partner-funnel-a1ym7bab3-victory-onorhimes-projects.vercel.app
- Intermediate configuration/diagnostic deployments:
  `dpl_CXnxzdrQhfswjsjoBBzsY75zb1dq`,
  `dpl_D2XYeMApYYDsAZ62cKxYbhUGFhKD` (not the final working release).

The original bc-learn-funnel Vercel project, separate Sites publication, and
Hostinger dashboard release were not changed. The Sites skills governed
preservation only; the user's explicit Vercel deployment target remained in use.
The unrelated local dashboard Sub-ID wording changes were not deployed.

## Changes and investigation

1. The original deployment lacked the funnel key ID, HMAC secret and offer key.
   Configured these as server-only production variables in the new project.
   Kept `KMA_CHECKOUT_ENABLED=false` and existing Firebase/Resend settings.
2. Created one HMAC binding, `bclearn_20260906`, scoped to exactly the product
   and funnel IDs above. No Stripe key was copied into Vercel or the browser.
3. Set the exact checkout return origin. Extended the browser event allowlist
   from the existing `https://partners.kissmyapps.dev` to also include the new
   Vercel origin. The old value was verified by digest before changing it.
   Both allowed preflights return 204; an untrusted origin returns 403.
4. Applied only the two migrations below, together with migration-history rows
   in one transaction, after a rollback-only regression. No broad db push/reset.
5. Deployed the four functions below. Stripe webhook source is deployed but
   its Stripe destination/signing secret is still unconfigured.
6. The first connected Vercel Edge deployment returned `backend_unavailable`.
   Bounded diagnostics located failure at `fetch_backend / transport_failure`;
   no context counter existed, so the request had not reached the context RPC.
   Switched only the three partner API routes to Node.js (30-second limit).
   The identical configured offer lookup then passed. The exact low-level Edge
   transport cause was not exposed; do not invent a TLS, DNS or library diagnosis.
7. SDK diagnostics emit fixed stage/category codes only, never request bodies,
   headers, error messages, click tokens, provider responses or secrets. The
   canonical SDK and vendored funnel copy match.

The configuration helper encountered a response-parsing error after Supabase's
successful empty-body secrets response. It was not rerun or blindly rotated.
Readback confirmed the settings; the successful live signed offer request proves
the Vercel and Supabase HMAC configuration agrees. The helper parser was corrected
for empty success responses. No plaintext secrets were logged or persisted.

## Database and Edge artifacts

| Migration | SHA-256 |
| --- | --- |
| 20260905110000_funnel_checkout_context.sql | e80abf5fddfa0c354f0f29255ff0b016cc99b6550a4818654543a319003d9a1b |
| 20260905120000_zero_total_checkout.sql | ed0f6867522ca62512c2f10a0f7abee07730f5b281d54b0ba90e7cc6e7b2ef11 |

There are now 38 applied migrations. Fingerprints of products, agreements,
documents and offers, plus all checked application counts, were unchanged by
the migration release. Namespace-scoped synthetic fixtures were rolled back.
The existing empty-catalog audit runner was not bypassed; the selected fixture
prefix excluded global email/cleanup claims and destructive audit operations.

| Function | Observed final version | Bundle SHA-256 |
| --- | --- | --- |
| funnel-checkout-context | 2 | 8b2b834b3166c41960768700a44be9ad941b0aca353c53e444513b3e2b5f4f25 |
| checkout-session | 11 | 490ec517d6fc34643879656ba9bb73a86baeb5e7ffff0731d5ba529d21eaf62b |
| stripe-webhook | 11 | f25086c8735c17950b4415583bf24937c74e46ba90629021c52331a70df872f2 |
| stripe-worker | 11 | 491f6f7bd6bdedf839f73d223154616ed20691d64787fb1010924bb8aed1a290 |

## Discount configured — no redemption

- Stripe account: `acct_1SaSp9E47mNwFlz1`, Futura Funds Inc.
- Existing Price: `price_1UCJHDE47mNwFlz1NEFOTxtB` ($1/month).
- Only applicable Stripe product: `prod_VCii4guzoryBtZ` (BC Learn Test).
- Coupon: `eHVv5Ucg`, BC Learn no-charge acceptance test.
- Terms: 100% off forever; maximum one redemption; UI confirmed 0/1 and valid.
- Promotion: `promo_1UCbsJE47mNwFlz1xm9WkRWY`, code `BCLEARN-QA-SEP06`.
- Promotion also limited to one redemption; not customer-bound because no test
  Stripe customer was created or selected. Checkout remains OFF.
- `FREE_CHECKOUT_PROMOTION_BINDINGS` maps the internal BC Learn product to this
  exact promotion. Binding digest was verified.
- UI/configuration verification only: the restricted key's promotion/coupon-read
  permission has NOT yet been exercised through a live checkout preflight.

The funnel still unconditionally requests `require_no_payment=true`. A missing,
partial, once-only or inapplicable discount fails closed; a zero Stripe total is
required before returning a Checkout URL. A free subscription does not constitute
a paid conversion or earned commission. These are tested code guarantees, not
proof that a live subscription/webhook has completed.

## Verification

- Hosted rollback-only scoped regression: 59 assertions; application fingerprints
  unchanged after rollback and after the approved migration release.
- `pnpm test:edge`: formatting, lint, type checks; 82 tests passed.
- Shared adapter: 11 Vitest tests passed, including redacted diagnostic coverage.
- Mocked six-screen flow: 6 tests passed; no actual email/provider requests.
- Funnel lint and TypeScript passed.
- Funnel `npm test`: Vinext build, 26 unit tests and 7 rendered-HTML tests passed.
- Next.js production build passed locally and Vercel final deployment is Ready.
- Canonical SDK/Markdown/OpenAPI parity passed (contract v1.2).
- Live API probes and application-count readbacks passed as described above.
- No authenticated end-user browser checkout, device, screen-reader, real email,
  webhook delivery or payment acceptance is claimed by these checks.

## Remaining gates — do not enable checkout yet

1. Confirm the shared Stripe account's event-routing/data scope before creating
   the KissMyApps webhook destination. The account has other products and four
   existing destinations (all left untouched). Account-level event delivery can
   include their matching payment/subscription events. Review ownership filtering
   before ingestion so unrelated facts are not mistaken for BC Learn activity.
2. Create the exact Supabase webhook destination, pin `2026-02-25.clover`, select
   only the event types in `PRODUCTION_ACTIVATION.md`, securely save its signing
   secret, and verify signature rejection plus real delivery. Source deployment
   is not destination configuration. Current webhook calls return 503 configuration
   error because `STRIPE_WEBHOOK_SECRET` is absent.
3. Configure/authenticate/schedule Stripe → commercial → metrics processing with
   bounded retries and observable failures. Existing internal worker credential
   was preserved, not recovered or rotated. Only `agreement_notify` is stored in
   the private DB secret table and only `kma-agreement-maintenance` is in pg_cron.
   Do not imply an unverified external scheduler is running.
4. Verify restricted-key discount access and all no-charge safeguards before
   enabling checkout. Get separate approval for the actual $0 subscription test
   and its lifecycle/cancellation; do not complete any paid or recurring action
   merely because the setup has been approved.
5. Check click → funnel events → $0 checkout → webhook → no-payment subscription
   receipt. Paid commissions, refunds, entitlements and payout transfer acceptance
   remain distinct later tests.

## Rollback and durable local evidence

Readbacks and separately downloaded prior Edge source bundles are preserved in
`.cache/release-backups/20260906-bc-learn-connection/` (git-ignored). The directories
`rollback-checkout`, `rollback-webhook`, `rollback-worker` each contain that
function's own prior dependency bundle. Do not mix shared files between versions.

For frontend rollback, restore the pre-turn Vercel deployment above while keeping
checkout OFF. Do not deploy/re-alias the old waitlist project. Prefer a forward
database repair; never drop evidence or reverse normalization definitions once
real financial records exist. Do not restore pre-no-charge checkout handlers
while checkout is enabled. No rollback was performed during this release.
