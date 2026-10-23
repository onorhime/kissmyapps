# KissMyApps project handoff — 9 September 2026

## Resume here

Work is paused at the user's request. **The next dependency is the Stripe account owner's completion of Connect onboarding and confirmation of the correct funds flow.** Do not restart the funnel build or replace the existing Vercel apps.

The user wants **Stripe Connect only**, not Wise or another payout provider. Futura Funds Inc.'s Stripe account is **Canadian**, despite an earlier assumption that it was US-based. The user reports saving **Marketplace**. Last recorded Stripe inspection still showed incomplete onboarding and a direct-charge configuration inconsistent with the intended flow; this needs fresh verification, not an assumption that the selection failed.

Next session:

1. Ask whether the account owner completed onboarding or received a Stripe Support response.
2. Read this handoff, `ADMIN_PAYOUTS_2026-09-07.md`, and `IMPLEMENTATION_PLAN.md`; inspect the dirty worktree before editing.
3. Recheck live Stripe platform profile, integration choices, and country eligibility. Do not accept legal acknowledgements or submit identity information for the owner.
4. Resolve the funds-flow mismatch and confirm Stripe supports this affiliate-commission model for this Canadian account.
5. Then implement the scoped Connect onboarding, verified destinations, transfer/event reconciliation, and release controls. Keep money movement disabled until its separate acceptance and approval gates pass.

## State boundaries

| Area | Last established state |
| --- | --- |
| Partner/admin platform, tracking, agreements, checkout integration | Existing production functionality; detailed release evidence is in the repository. Not revalidated live on 9 September. |
| Admin Subscriptions | Last documented production release: 7 September. Signed-in Admin visual acceptance remained pending in its release report. |
| Admin Payouts internal workflow | Implemented and validated locally; **not deployed**. |
| Stripe Connect | Planning and account setup investigation; destination onboarding and transfer pipeline are **not implemented/accepted**. |
| Real money payout lifecycle | **Not proven.** Zero-total subscription tests do not prove paid invoices, commissions, renewals, refunds, or payouts. |

Saving this handoff does not authorize a deployment, a transfer, a subscription, a charge, or any legal acknowledgement.

## Stripe Connect: exact stopping point

Account: `acct_1SaSp9E47mNwFlz1` — Futura Funds Inc., Canada.

Intended flow:

**Customer pays Futura for an app subscription → platform attributes and calculates commission → eligible commission is approved → transfer to partner's connected account → Stripe payout to partner's bank.**

Transfer and bank payout are separate states. Internal approval must never be presented as payment, and provider-confirmed evidence is required before marking a payment complete.

Last recorded browser findings (8 September; refresh before acting):

- Connect overview was accessible, with no connected-account activity shown.
- Platform profile said **Onboarding incomplete**.
- Refunds/chargebacks liability and ongoing seller-compliance acknowledgements were outstanding.
- Setup summary said accounts collect payments directly from buyers using **direct charges**; it showed losses collector `stripe`, fees collector `account`, and dashboard `none`.
- That summary conflicts with the intended collect-first, transfer-later flow. Whether this is incomplete/default/stale configuration was not established.
- Country settings required completing the platform profile, showed Canada checked, and had disabled controls. This is **not proof of cross-border availability**.
- Setup guide showed business model complete, identity verification not started, and integration-choice confirmation disabled.
- The profile-completion links looped back to the incomplete profile/overview.
- No legal acknowledgement, connected account, new credential, transfer, or payout was created during that investigation.

Owner handoff page:
https://dashboard.stripe.com/acct_1SaSp9E47mNwFlz1/connect/settings/profile

### Message prepared for the account owner

> Please complete Stripe Connect onboarding for Futura Funds Inc. under Settings → Connect → Platform profile, including identity verification and your personal review of the refunds/chargebacks liability and seller-compliance acknowledgements.
>
> We sell our own app subscriptions and pay referral commissions to affiliates. Customers pay Futura first; affiliates should not collect payments directly. Marketplace was selected, but the setup summary still describes direct charges and the profile remains incomplete.
>
> If you cannot complete or correct this, please ask Stripe Support to confirm that Connect supports our affiliate-commission model, the collect-first/transfer-later configuration, and which countries our Canadian account can pay. Please return a screenshot of the completed setup or Stripe's response. Do not send funds or create transfers yet.

This message was prepared for the user to send; delivery and an owner response are not established.

Official references previously checked; recheck current rules and account-specific eligibility before building:

- https://docs.stripe.com/connect/cross-border-payouts
- https://docs.stripe.com/connect/how-connect-works
- https://docs.stripe.com/global-payouts

Earlier research identified regional restrictions and distinguished Connect from Global Payouts. Do not claim worldwide partner support based on a general country list.

## Local Admin Payouts work to preserve

Primary report: `ADMIN_PAYOUTS_2026-09-07.md`.

- Candidate migration: `supabase/migrations/20260907190000_admin_payout_workflow.sql`
- Database tests: `supabase/tests/database/37_admin_payout_workflow.sql`
- Rollback validator: `scripts/check-admin-payouts.mjs`
- API and tests: `src/features/admin/api/payouts.ts`, `payouts.test.ts`
- UI, styles, fixtures, tests: `src/features/admin/payouts/`
- Synthetic browser QA fixture: `integrations/admin-payouts-ui-check/`
- Route: `#admin/payouts`

Delivered locally: protected role-based access; 14-day UTC periods; ledger-backed statement preparation; review/hold/resume/approval/carry-forward; mandatory audit reasons; expected-version checks and durable retries; confirmation dialogs and toasts without scroll-resetting refreshes.

There is deliberately **no send-money, release-transfer, schedule, or mark-paid action**. Approval requires healthy processing, reconciliation, eligible verified destination/security hold, sufficient balance, and matching frozen evidence.

Historical validation, not rerun for this handoff:

- 786 Vitest tests across 58 files; 73 rollback-only database assertions; 9 operational Node tests.
- Final focused hardening run: 125 tests.
- TypeScript, lint, whitespace checks, and build passed; known jsdom canvas/large-chunk warnings remained.
- Desktop and 390px mobile synthetic browser checks passed for the exercised flows.
- Database candidate tests rolled back; migration remained absent from production.

Open limitations include non-14-day cadence policy, mixed-agreement carry-forward, real destination onboarding and security-hold integration, statement PDFs/delivery, transfer/payout events and reconciliation, and late-evidence reconciliation policy. See the report rather than weakening gates to make the UI pass.

**Deployment approval remains pending.** Do not bulk-apply the dirty migration directory. Any future deployment needs a fresh inventory, approval, the intended migration only, an immutable release, asset/role/host checks, and transfers kept disabled.

## Last documented production release

Source: `RELEASE_EVIDENCE_2026-09-07_ADMIN_SUBSCRIPTIONS.md`.

- 7 September 2026, approximately 17:02 UTC; Admin Subscriptions release.
- 47 recorded migrations; latest `20260907180000_admin_subscriptions`.
- Release: `/srv/kissmyapps/releases/20260907T170053Z-admin-subscriptions-12ffc5170853`
- Retained rollback: `/srv/kissmyapps/releases/20260907T153008Z-processing-alerts-5cccaca551ee`
- 108 public asset checks and health checks passed; prior documentation/demo assets and unrelated containers were preserved.
- Partner isolation was checked; authenticated Admin visual acceptance was still pending.
- Snapshot: two active zero-total subscriptions attributed to TikTok; no recorded paid transactions or commissions. Partner browser showed five clicks/funnel starts/payment views, two active/trial subscriptions, zero paid purchases, and zero earnings.
- Processing was healthy at that check; external transfers were disabled.

These are dated observations, **not fresh production assertions on 9 September**.

## Infrastructure and funnel contract

- Repository: `/Users/nobrainer/A1 Global/React/affiliate dashboard`
- Partner dashboard: https://partners.kissmyapps.dev
- Admin dashboard: https://admin.kissmyapps.dev
- Tracking redirect origin: https://go.kissmyapps.dev
- Funnel integration documentation: https://partners.kissmyapps.dev/developers/funnels/
- Supabase project: `mmyruzjemjecqyivhrgr`
- Hostinger VPS: `72.60.125.99`; existing authorized Mac SSH key. Never reinstall/reset this server as a shortcut; unrelated sites/services share it.
- New test funnel: https://bc-learn-partner-funnel.vercel.app
- Original funnel, **preserve unchanged**: https://bc-learn-funnel.vercel.app
- Funnel source: `/Users/nobrainer/A1 Global/React/test bclearn funnel/funnel-web`
- Success URL template: `https://bc-learn-partner-funnel.vercel.app/checkout/complete?session_id={CHECKOUT_SESSION_ID}`
- Cancel URL: `https://bc-learn-partner-funnel.vercel.app/?checkout=cancelled`

The duplicated speaking funnel includes the paywall after email entry. The test subscription is $1/month with a **100%-off recurring discount**; the user does not want an actual charge. Embedded checkout, email handoff, automatic status confirmation, and attributed event processing were previous implementation work. A return URL alone is not proof of payment.

Existing dedicated checkout webhook:
`https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/stripe-webhook`

Stripe endpoint reference: `we_1UCdLVE47mNwFlz1W1ulOlBy`. This existing payment webhook is **not proof that Connect connected-account events are integrated**. Preserve its existing destinations and secrets.

The user stored the restricted live Stripe key in Supabase. Retrieve secrets only through authorized secret handling when needed; never place values in source, handoffs, logs, or chat. No secret values are saved here.

## Remaining acceptance and backlog

1. Owner completes Connect profile and resolves funds-flow/country eligibility.
2. Implement and validate Stripe-only partner destination onboarding and provider event handling.
3. Review/deploy local Admin Payouts with explicit approval and retain money-movement gates.
4. Prove a real paid purchase → attributed invoice → commission → eligible period → transfer → bank payout lifecycle when separately authorized. Also cover retries, renewals, refunds, disputes, failures, and reconciliation.
5. Keep the funnel integration documentation aligned with the implemented contract.
6. Product-app entitlement integration remains future work; no app access should be inferred from the test subscription. Documentation should retain this integration requirement.
7. Preserve existing backlog: Admin Documents/View as Partner, payout statement delivery/notifications, analytics integrations, operational monitoring gaps, physical-device and screen-reader QA.

Do not discard older audit findings just because Connect is the current focus.

## Workspace preservation

At handoff: branch `main`, HEAD `f6b4005be6c87054f1998eb40e52d0642bb59318`, with extensive existing modified and untracked files (approximately 209 status entries before adding this note). This is not a clean committed snapshot.

This handoff saves context, **not a backup of all source changes**. Existing files remain in place. No commit, stash, cleanup, deployment, or production mutation was performed to save this state. On resume, inspect current files and diffs rather than resetting or overwriting them.
