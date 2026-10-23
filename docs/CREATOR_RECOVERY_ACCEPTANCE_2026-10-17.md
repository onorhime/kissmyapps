# Embedded creator payout recovery — local acceptance, 17 October 2026

## Outcome

The confirmed KMA loading-recovery bug is fixed locally. Actual Stripe TEST onboarding loaded on its first attempt in native Safari and a clean Chrome guest session. Safari save/close and reopen preserved the same verified creator; sign-out removed the open component in both browsers. No Retry or page reload was needed in these browser checks. The test reused `acct_1URJIdE2asTL6F4V` and created zero new Stripe accounts.

KMA uses Stripe's purpose-built account-onboarding component inside the KMA page. Sensitive identity and bank values go directly to Stripe. KMA retains its account/status records, existing commission settings and manual payout approval. The earlier completed TEST submission remains valid; no agreement was submitted again in this rehearsal.

## Fix and evidence

The old 30-second timeout hid the component. A later Stripe loader callback cleared loading but left the error state active, so a successful late iframe remained hidden. KMA now keeps the component visible during slow/error recovery, distinguishes slow loading from failure, clears a stale banner when the loader starts, and requests a fresh session on an explicit retry even if the first prefetched session was never consumed. Previous attempts cannot modify the current React state. No private SDK reset or logout-on-retry workaround was added.

Four regression cases cover late loading, an early error followed by successful retry loading, provider error visibility after rendering, and retry discarding the earlier prefetched token. Existing ownership, expiry refresh and reauthentication checks remain intact.

The earlier underlying cold-load delay or expired Stripe claim is not conclusively attributed to one cause. The verified application defect that made recovery stay hidden is repaired; current native browser checks passed. This does not claim that networks or provider loading can never fail.

## Verification

- 50 focused frontend tests passed, including four new recovery regressions.
- TypeScript, focused lint and formatting checks passed.
- Production build passed; the existing large-bundle warning remains.
- Seven real local Supabase Auth scenarios passed through the actual frontend gateway and handler: password reauthentication, TOTP/AAL2, stale token refresh rejection, wrong credentials/codes, tampered JWT rejection, unrelated-user isolation, same-account reuse and sign-out. See `CREATOR_REAL_AUTH_ACCEPTANCE_2026-10-17.md` for the exact boundaries.
- Three local browser-provider policy tests and fake smoke/resume guards passed.
- Actual Stripe browser run: three successful Account Sessions, zero new accounts, zero provider HTTP failures, same account ready with no outstanding requirements. No purchase, transfer, payout or account edit was issued by the test runner.

## Scope and cleanup

The real Stripe browser tests use a synthetic signed-in fixture. Real password/MFA acceptance separately uses a genuine local Supabase Auth service and production gateway/handler, with native PostgreSQL transport replacing PostgREST and Stripe mocked. Together these test both contracts; they are not a single hosted browser-to-Supabase-to-Stripe rehearsal. Hosted authentication configuration, production rollout, live country/currency eligibility and actual money movement remain separate release checks.

Only the already approved FunnelFox TEST webhook was temporarily paused, then freshly read back and verified restored with its original configuration. The resumed browser runner, local Auth services, bridge servers and temporary databases were stopped. Existing test accounts, database fixtures and evidence were retained. No deployment or hosted migration was performed.

Evidence:

- `qa/creator-recovery-2026-10-17/stripe-browser.json`
- `qa/creator-recovery-2026-10-17/webhook-restored.json`
- `qa/stripe-test-2026-10-16/embedded-recovery-chrome.png`
- `qa/creator-real-auth-2026-10-17/acceptance.json`
