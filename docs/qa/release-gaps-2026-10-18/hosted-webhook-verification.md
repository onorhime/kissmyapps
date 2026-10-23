# Hosted webhook acceptance — 18 October 2026

The hosted **Stripe TEST → KMA → SpeakSix** callback path passed with customer checkout and creator payouts disabled. No new checkout, charge, refund, transfer or payout was created.

## What passed

1. A genuine retained Stripe TEST checkout event was resent to a dedicated connected-account destination. Stripe's actual HTTP delivery returned HTTP 200. KMA fetched the existing provider payment, which was already fully refunded, and recorded one USD 169 refund fact and one durable callback.
2. The actual minute cron dispatched through `pg_net` to the hosted worker at 08:36 and 08:37 UTC. Both runs succeeded with zero failed units. The first delivered one callback; the second confirmed an empty queue.
3. SpeakSix accepted that callback and persisted exactly one refunded capture and one event receipt. No learner email job was created. A duplicate of the exact callback returned `accepted: true` with the same event ID; financial state and row counts did not change.
4. Bad signatures, expired signatures and an incorrect account were rejected with HTTP 400. Browser-origin requests and the wrong host were rejected with HTTP 404. Anonymous scheduler health/control probes were denied.
5. Authenticated quote/create calls returned HTTP 503 `checkout_not_enabled`. The payout worker rejected unauthenticated invocation. The four financial-gate secret digests remained false, and no settlement jobs or transfer receipts exist. A valid payout-worker call was deliberately not run because it could process the unrelated commission queue.
6. The three dedicated Stripe TEST destinations use independent secrets. Cross-signing platform and connected events was rejected. Existing FunnelFox and legacy destinations were preserved.
7. A fresh `account.updated` event was generated through the existing authenticated owner’s exact SpeakSix sandbox Workbench using one temporary TEST metadata marker. Its genuine delivery returned HTTP 200. The marker was removed immediately and the original metadata/capabilities were verified unchanged. No credentials were extracted.

## Boundaries and remaining checks

The merchant event concerned an unknown hosted TEST connection. Its HTTP 200 response proves genuine provider delivery and safe handling, **not** persistence of a registered merchant's capability changes.

The platform application-fee event belongs to a different historical referred order. It reached the hosted handler with a valid signature and rejected with HTTP 404 because that order was intentionally absent. **Positive hosted application-fee/commission reconciliation remains unverified.** Importing a synthetic creator and signed-agreement graph would not be valid production proof.

The original organic fixture needed its historical refund-request identity as well as its order. That one original request was restored with provider result fields cleared; the genuine provider snapshot supplied its completion. No financial receipt was seeded.

Historical merchant replay initially failed the strict envelope-version guard. A fresh provider-generated event passed without changing the handler. The original failed merchant and platform probes still had pending-delivery counters at the last provider read. At 08:39 UTC, only those two dedicated TEST destinations were paused, preserving their configuration and secrets. The successful connected-payment destination and healthy reconciliation schedule remain enabled. Original FunnelFox and legacy destinations were unchanged. This prevents further retries when Stripe next attempts them; it does not erase historical failures or immediately clear their counters. See [destination cleanup evidence](hosted-test-destination-cleanup.json) and [Stripe's retry behavior](https://docs.stripe.com/webhooks#automatic-retries).

The unrelated legacy processing scheduler and incident were untouched.

Hosted authentication email acceptance is documented separately in [hosted-email-verification.md](hosted-email-verification.md): fresh signup and returning signin each produced one Resend-delivered message and successfully verified the real eight-digit code. That proves recipient mail-server acceptance, not human inbox placement.

Sanitized payment evidence: [hosted-webhook-verification.json](hosted-webhook-verification.json). Private credentials and raw recovery materials remain under the ignored release-backup directory.
