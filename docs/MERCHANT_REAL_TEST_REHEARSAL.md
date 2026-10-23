# Merchant connection and checkout: local real-Stripe rehearsal

This guide describes the local TEST harness and the real provider rehearsal performed on 17 October 2026. The detailed evidence and limitations are in [the QA report](qa/merchant-real-2026-10-17/README.md).

## Current checkpoint — 17 October 2026

- TEST OAuth and the exact callback `http://127.0.0.1:5194/merchant/callback` are configured. The existing **SpeakSix sandbox** was connected and explicitly confirmed. Live OAuth settings were not changed.
- Both referred and organic USD 169.00 purchases passed real TEST checkout. The referred purchase collected USD 42.25 using the existing synthetic 25% agreement; organic collected no fee. SpeakSix recorded both purchases before assessment or matching.
- Both customer refunds succeeded. A real cross-currency fee-refund reconciliation bug was fixed and regression tested. The exact existing operation was recovered through the normal service with 26 provider GETs and zero provider writes. The refunded-stage assertions passed.
- Local checkout, merchant, pay-first, worker and webhook regression suites passed all 47 tests; rehearsal isolation/signature guards passed eight tests. Mobile checks were completed by the parent task.
- Duplicate-refund assertions passed: customer refund writes stayed 2 → 2 and fee refund writes stayed 1 → 1. The exact FunnelFox TEST endpoint was restored with its configuration preserved, and all owned rehearsal processes were stopped cleanly. Evidence and TEST records were retained. No creator payout or deployment occurred.
- Hosted destination signing secrets and real email sign-in remain separate acceptance boundaries. The merchant webhook inventory was manually verified only because Stripe's exact OAuth API restriction prevented listing it; platform inventory stayed API verified.

## Boundaries

- Real provider access uses only the private KMA **TEST** secret. Live and publishable keys are refused.
- KMA and SpeakSix schemas run in two new disposable local PostgreSQL databases. Nothing connects to hosted Supabase or deploys a service.
- The operator page uses an explicitly synthetic, verified local merchant identity and synthetic local admin. The actual merchant handler and SQL enforce recipient/admin separation. This is not acceptance of real email sign-in.
- OAuth, merchant confirmation, account resolution, managed Price verification, checkout, worker reconciliation and refunds use actual handlers. The runner cannot create Stripe accounts, products, prices, transfers, payouts, webhooks or change account settings.
- The signed synthetic agreement already present in the canonical fixture supplies the 25% commission. This is a test agreement, not a production commission change.
- No creator payout jobs or transfers are enabled.

## Preparation requiring a human decision

Before provider writes, enable only the intended platform's TEST OAuth settings and register the exact callback `http://127.0.0.1:5194/merchant/callback`, under the current user approval. Do not change live OAuth settings. The test client ID is a public identifier; the key stays in `.env.stripe-test.local`.

Refresh the platform's TEST webhook inventory. The previously approved named FunnelFox listener must be paused only after verifying its identity/configuration, and restored afterward with that configuration intact. Do not pause unrelated endpoints. The runner refuses connection startup while enabled platform endpoints remain; it also checks merchant endpoints before enabling payment.

The platform test Price cannot be reused on a different merchant. After real OAuth and explicit confirmation, use an approved one-time **USD 169.00 TEST Price on that exact merchant account**. Product/Price creation, if necessary, is a separate narrow operator action; the runner deliberately cannot do it.

Stripe returns `403 oauth_not_supported` when this OAuth platform key attempts to list merchant webhook endpoints. For that exact response only, the TEST harness can use an explicitly supplied manual dashboard inventory via `KMA_MERCHANT_WEBHOOK_INVENTORY=/absolute/path/to/evidence.json`. The evidence must identify the exact confirmed account, TEST mode, zero total/enabled destinations, an observation time and expiry within 30 minutes, an absolute local screenshot path and the operator's observation. Startup hashes the actual screenshot; preparation revalidates account and expiry. Platform webhook checks remain API verified. Other API errors, a different account, stale evidence or nonempty inventory still fail closed. State records that this merchant inventory was manually observed, **not API verified**. This fallback exists only in rehearsal scripts.

## Start and operate

From the KMA checkout:

```sh
KMA_MERCHANT_TEST_CLIENT_ID=ca_VDmJ9DvxxQN8EpxXsJrVn8o5UWsfwIZy \
  node --conditions=react-server scripts/merchant-real-local.mjs --run
```

This reads the existing private TEST key file. Startup makes **no provider call**. It prints the loopback URL, dynamic payment webhook URL, evidence path and a private controller-file path. Open `http://127.0.0.1:5194`.

1. Check TEST isolation. Create the local invitation.
2. Connect with Stripe. Use the intended TEST OAuth path and select the correct account. Do not substitute the KMA platform account as the merchant.
3. On return, review the exact business/account/country and confirm it explicitly. Query parameters are removed before asynchronous calls, and OAuth tokens/codes are never recorded in evidence.
4. Supply the merchant TEST Price. The prepare action assigns the confirmed account, reuses the existing signed commission rule, approves only the disposable funding binding and verifies the real Price through the actual verifier.
5. Configure signed TEST webhook forwarding for **both** scopes. Two distinct signing secrets are required before checkout. Private controller `origin`, `bridgeOrigin` and `control` values are in the printed `controller-private.json`; do not paste its token into user-visible output.
6. Complete the referred and organic purchases using Stripe test-card details only. Neither purchase requires assessment, registration or matching first; both are pay-first fixture orders.
7. Reconcile and assert the paid stage before refunding. Then refund both purchases, reconcile, and assert the refunded stage. Repeat refunds using the same saved request identities and verify no additional refund write or ledger entry occurs.
8. Restore the exact paused TEST webhook, verify its original configuration, and stop the runner with Ctrl-C. This retains provider TEST objects and local evidence, and stops the owned database/bridge/server.

The real CLI probe returned the same signing secret for separate `--events-from @self` and `--events-from @accounts` listeners, even with separate configs/device names. The approved loopback relay therefore verifies each real raw Stripe CLI signature **before** forwarding anything, checks its signed test/account scope, and forwards the unchanged payload under two separate local test secrets to the unchanged application handler. This establishes actual Stripe event delivery and CLI-signature verification. It does **not** test two real hosted destination signing secrets; that remains a release check. A successful reconciliation read alone is not proof of webhook delivery.

Start the private listeners/relay after the runner, using its printed controller path:

```sh
node scripts/merchant-real-listeners.mjs /tmp/kma-managed-crossapp.ID/controller-private.json
```

The listener manager reads the existing private TEST key, binds its relay only to loopback, and configures only the local handler. It records sanitized receipts and this signing boundary in `merchant-listeners.json`. Its startup output contains process IDs for cleanup, not secrets. Ctrl-C stops both CLI children and the relay. It never creates, edits or deletes a Stripe webhook endpoint.

## Local control endpoints

All are POST requests to the loopback origin, with JSON content and the private controller's `x-local-control` header. Foreign origins/hosts and missing controls are rejected.

| Endpoint                    | Body / meaning                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/api/state`                | `{}` — sanitized application/provider evidence                                                        |
| `/api/webhook-secrets`      | `{ "platform": "<private secret>", "connected": "<different private secret>" }`                       |
| `/api/reconcile`            | `{}` — run actual worker, callback and commission reconciliation                                      |
| `/api/assert`               | `{ "stage": "paid" }` or `{ "stage": "refunded" }`                                                    |
| `/api/assert-repeat-refund` | `{}` — repeat both completed refunds and assert no further provider refund write or fee-ledger change |
| `/api/refund`               | `{ "index": 0 }` for referred, `1` for organic; request IDs remain fixed on repetition                |

Paid-stage assertions require the correct merchant account, USD 169.00 on both orders, a verified USD 42.25 application fee and earned commission for the referred order, zero fee for organic, no registration/cohort requirement, no payout jobs, no pending callbacks, and actual relevant connected-payment plus platform-fee webhook receipts. Refund assertions require both full refunds, one USD 42.25 commission reversal and completed fee refund. Evidence excludes keys, signing secrets, email addresses and Checkout URLs.

KMA's platform country is Canada. A USD sale can settle its application fee in another currency. The runner records the actual fee and balance-transaction currencies. A currency-review hold is a separate outcome, not a passed commission-funding test. Do not change real account payout/currency settings to force a passing result.

## Safe continuation

While the runner remains active, refresh the same operator URL; its in-memory invitation and fixed refund identities remain. A lost OAuth exchange must start a new connection attempt, never replay the old code. A failed preparation remains pinned to the same merchant/Price. If the process was stopped, the exact disposable fixture and sanitized evidence remain at the printed directory, but this runner currently starts a **fresh** fixture; it does not reattach an old payment session or silently duplicate old payments. Inspect the previous evidence before starting another transaction rehearsal.

Offline checks:

```sh
deno check --config supabase/functions/deno.json scripts/merchant-real-bridge.ts
node --test scripts/merchant-real-policy.test.mjs scripts/merchant-real-bridge.test.mjs scripts/merchant-real-relay.test.mjs scripts/merchant-real-inventory.test.mjs
node --conditions=react-server scripts/merchant-real-local.mjs --smoke
```

The smoke process excludes Stripe network hosts, creates only a local invitation, records safe startup evidence, and shuts down its owned services.
