# Local Stripe test rehearsal

This runner uses the real managed-checkout, price-verification and webhook handlers, the reconciliation/outbox worker, and the SpeakSix payment adapter. Both databases and all learner records are disposable local fixtures. It does not deploy either application, use a hosted database, enable live checkout, create products/prices, or initiate creator payouts.

Preparation is complete. A real Stripe checkout has **not** been run. The next dependency is the KMA test secret key; the separate embedded onboarding rehearsal also needs its test publishable key. The operator must verify both belong to the intended account before choosing or creating the test Price.

## Required configuration

Use the Git-ignored `.env.stripe-test.local`, never source control or chat:

- `KMA_REAL_TEST_STRIPE_SECRET_KEY`: test secret or suitably scoped restricted test key.
- `KMA_REAL_TEST_STRIPE_ACCOUNT_ID=acct_1SaSp9E47mNwFlz1`: the verified KMA Futura Funds account. The runner is pinned to this account.
- `KMA_REAL_TEST_STRIPE_PRICE_ID`: an active one-time USD 169.00 Price on that test account, selected or created separately with authorization.
- `KMA_REAL_TEST_STRIPE_PUBLISHABLE_KEY`: needed by the separate embedded onboarding rehearsal, not hosted Checkout.

Do not reuse the existing SpeakSix test key: it belongs to a different Stripe account.

Check local prerequisites without keys, provider calls or databases:

```sh
STRIPE_CLI_BIN=/tmp/kma-stripe-cli-20261016/node_modules/.bin/stripe \
node scripts/test-managed-checkout-stripe-local.mjs --prerequisites
```

After account/key/Price verification, run from the KMA repository:

```sh
KMA_REAL_TEST_ENABLED=true \
STRIPE_CLI_BIN=/tmp/kma-stripe-cli-20261016/node_modules/.bin/stripe \
node --env-file=.env.stripe-test.local --conditions=react-server \
scripts/test-managed-checkout-stripe-local.mjs --run --with-stripe-cli
```

The CLI path is an operator-installed temporary dependency; update it if the temporary installation is no longer present. The runner passes the test key via environment, captures the forwarding signing secret privately, and does not register or change dashboard webhook endpoints.

## What happens

1. Create fresh local KMA and SpeakSix databases. Seed a draft, unverified one-time billing offer.
2. Verify the account and inspect existing test webhook listeners. Stop if an enabled listener could receive rehearsal payment/refund/dispute events; report only its ID and host, and leave it unchanged.
3. Invoke the actual managed-price-verifier handler with a local authenticated admin fixture. Check the saved terms against the real test Price, persist scoped proof locally and activate only that local offer. This tests backend verification, not the real admin browser/login interface.
4. Start the actual raw-signature Stripe webhook handler and local CLI forwarding. Display a loopback URL only after setup succeeds. No Checkout is created until the operator clicks the local test button.
5. Create a real Stripe test Checkout from a locally matched learner reservation. Use a Stripe test card. The redirect alone grants nothing; verified provider evidence and cohort confirmation control access.
6. Run the KMA worker and SpeakSix reconciliation every 15 seconds. Signed durable callbacks update the local payment ledger. Six paid fixture learners can complete their matched cohort and receive 216 local lesson entitlements.

The protected local cancellation button invokes the actual administrator cohort cancellation RPC, then the actual SpeakSix refund adapter for each captured payment. It submits Stripe test refunds only when clicked. Repeat the button after completion to verify stable refund identities, refund-operation counts and commission reversals; already refunded captures must not submit another refund. The local commission processor uses the existing signed fixture agreement and never sends a payout.

The status panel separates `webhookProcessed` (a real forwarded event accepted by the webhook handler), `webhookRejected`, signed callback acknowledgements and local captures/entitlements. Polling success alone is not proof of webhook acceptance. The evidence JSON excludes keys, signing secrets, email addresses and Checkout URLs.

Use Ctrl-C to stop owned processes and the disposable databases. Stripe test objects remain in the test account for inspection; cleanup does not delete provider resources. No live payment or bank payout is exercised by this runner.

## Local preparation checks

```sh
node --test scripts/managed-checkout-real-test-guards.test.mjs scripts/managed-checkout-real-test-bridge.test.mjs
deno check --config supabase/functions/deno.json scripts/managed-checkout-real-test-bridge.ts
```

These guard and raw-webhook tests have no Stripe access. Full real-provider acceptance remains pending until credentials are supplied and the browser test is completed.
