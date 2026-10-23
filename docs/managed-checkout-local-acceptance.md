# KMA-managed checkout: local acceptance

Run from the KMA repository:

```sh
pnpm test:managed:crossapp
```

The runner requires Node with TypeScript stripping, Deno with the project dependencies cached, and native PostgreSQL 17. SpeakSix must be checked out in the sibling `Bclearn-Pilot` directory. It does not read application environment files or use a running application database. The existing preview on port 3200 is not involved.

Each run creates a fresh PostgreSQL cluster with separate KMA and SpeakSix databases, applies both complete migration chains, and seeds synthetic users, a signed existing commission agreement, a scoped test-mode Price mapping, and six matched learners with accepted calendars and a reviewed lesson plan. It creates no direct enrollment or commission records in its seed.

The actual KMA managed checkout handler, provider adapter and reconciliation worker run behind a loopback Deno bridge. The actual SpeakSix payment adapter calls that endpoint and persists through the real SQL RPCs. Only the Stripe transport is replaced with synthetic fixtures. Deno is restricted to loopback networking and cached dependencies. Callback signatures are real local HMACs using fixture-only secrets.

The acceptance cases cover:

- Disabled checkout and another learner’s order are rejected before any session is created.
- A Stripe create response lost after creation recovers the same durable attempt and session.
- A request lost before reaching KMA is recovered through the saved SpeakSix attempt.
- A definitively expired session can renew inside the same reservation, preserving its agreed offer even after a newer catalog version becomes active.
- A payment callback committed by SpeakSix but whose acknowledgement is lost retries with the same event identity.
- Duplicate callbacks cannot create duplicate captures, entitlements or commission earnings.
- Invalid signatures and a correctly signed event from the wrong payment mode are rejected.
- KMA uses the existing signed commission rule and its validation hold. The synthetic agreement uses 25%; this is not a production default.
- All six verified payments confirm the matched group and produce 216 lesson entitlements (36 per learner).
- Cohort cancellation creates a refund obligation; a lost refund response recovers one refund and one commission reversal without creating payout jobs.

The runner prints the path to `result.json` in its fresh `/tmp/kma-managed-crossapp.*` evidence directory. Database SQL, errors, and bridge diagnostics remain there for inspection. It stops its own bridge, HTTP server and PostgreSQL cluster on completion or failure.

These checks demonstrate local contract, database and worker behavior. They do not demonstrate a real Stripe-hosted card checkout, a real refund, Stripe webhook delivery, embedded identity verification, a bank payout, or production configuration. Managed checkout and payout activation remain separately gated. There are no live provider calls, emails, transfers or deployments in this runner.

## Verified local run — 16 October 2026

- Cross-app acceptance: all 10 scenarios passed. Evidence: `/tmp/kma-managed-crossapp.RPcyam/result.json`.
- KMA: 60 migrations applied; 47 database suites passed with no failures. Three historical operator suites were explicitly skipped because they require named production BC Learn records. Evidence: `/tmp/kma-all-sql-db.XxQz4H/result.json`.
- SpeakSix: 67 migrations applied; all 53 database suites passed. Evidence: `/tmp/speaksix-marathon-test-db.lNGlJ1/regression.log`.
- KMA's full UI suite (876 tests), script suite (11 tests), and edge suite (231 tests) passed. Both application builds, TypeScript checks, and the SpeakSix marathon and worker checks passed.
- All disposable fixture servers and databases were stopped. Existing application previews were left unchanged.

Before live activation, complete a real Stripe test-mode browser rehearsal covering checkout, provider webhook delivery, refunds, and embedded creator onboarding. Configure and verify the managed account, Price mappings, signing keys, callback URL, and worker schedule for the intended environment. Production checkout remains disabled; product-owner payouts are outside this implementation. Creator commissions, refund rules, and manual payout approval continue to use the existing KMA settings.
