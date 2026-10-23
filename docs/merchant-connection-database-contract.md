# Merchant-owned checkout database contract

Local additive migration: `20261017100000_merchant_connections.sql`. It enables no Stripe credentials, managed checkout product, transfer worker, or payout platform. Existing platform-owned orders and signed commission policies retain their existing behavior.

## Connection authority

`merchant_businesses` is the reusable business identity. `merchant_connections` holds one exact Stripe platform/account/mode relationship per business and mode. `product_merchant_connections` is the explicit admin assignment; funnels inherit their product's connection. A merchant cannot replace an assigned receiving account: a different account requires a separate merchant connection and explicit admin reassignment. Existing order account IDs stay frozen.

Only password-authenticated owner/operations admins may create invitations, assign products, and revoke connections. Owner/operations/finance may read the admin workspace. Merchant recipients have no admin role. Invitation and OAuth secrets are stored only as SHA-256 hashes. The service boundary must authenticate the Supabase user before passing `user_id`; SQL independently checks the verified `auth.users.email` against the invitation.

Service RPC sequence:

1. `merchant_invitation_context(token_sha256)` inspects a live invitation.
2. `claim_merchant_invitation({token_sha256,user_id})` binds the intended verified user.
3. `begin_merchant_oauth({invitation_id,user_id,state_sha256,expires_at})` invalidates prior states; expiry is at most ten minutes and inside the invitation expiry.
4. `consume_merchant_oauth({state_sha256,user_id})` checks the same user and consumes once before code exchange.
5. `record_merchant_connection_candidate({...provider facts,state_sha256,platform_account_id,livemode,provider_verified_at})` records the verified account, never credentials.
6. `refresh_merchant_connection_candidate({...provider facts,invitation_id,user_id})` refreshes only the same candidate account.
7. `confirm_merchant_connection({invitation_id,user_id,account_id})` requires the candidate account, completed details, and charges enabled. Repeating the same confirmation is safe.

`merchant_connection_event_context` scopes signed events before a provider read. `apply_merchant_connection_event` accepts the exact platform/account/mode, Stripe event ID, integer epoch `event_created`, `payload_sha256`, and current provider facts for updates. Deauthorization revokes; later capability updates cannot reactivate a revoked connection. Explicit reconnection is required. A delayed deauthorization created before the latest confirmation is recorded without revoking that later connection; events in the same second or later remain fail-closed.

## Checkout and frozen commissions

`resolve_managed_merchant_scope(p_scope,p_attempt_id default null,p_order_id default null,p_action default 'quote')` resolves a current product assignment for new direct checkout. Historical attempts resolve their frozen account, including old platform-owned orders after a binding adopts direct charges. The baseline service scope is the integration identity plus product/funnel/mode, `charge_mode='merchant_direct'`, and KMA's `platform_account_id`.

Quote and prepare use the resolved merchant's verified Stripe Price. The initial checkout freezes the canonical signed terms, funding platform, merchant, and exact application fee. Retries cannot change identity, attribution, price, or fee. Renewal cannot extend beyond the frozen attribution/contract boundaries. A prepared attempt without a known provider session cannot create one after the connection is revoked or reassigned, while status reconciliation can still recover an earlier provider success. New direct orders cannot choose their account or percentage from browser input.

Application-fee funding reuses `configure_admin_external_commission_terms` and the existing review/approval process with `funding_model='application_fee'`. It requires the confirmed product merchant and the existing signed rule. The supported upfront basis is `subtotal_ex_tax_shipping`, for the current exact-price checkout without provider-added discounts, taxes, or shipping. Admin configuration rejects `net_after_fees` and `first_purchase_only` because the necessary exact provider fee or purchase eligibility is not available before payment; their policies are never silently changed. Runtime validation preserves the same guard. A fee must be less than the charge.

The payment snapshot preserves buyer paid truth while application fees settle asynchronously. Positive creator earnings require `application_fee_verified=true`, the exact platform/amount/account-scoped fee object, and the provider boundary's balance-transaction verification. Canonical awards are seeded with the frozen terms and fee, then use the unchanged validation, fulfilment, cutoff, payout-cadence and manual approval rules. Organic sales collect zero fee; expired referrals retain purchase tracking without creating an unfunded commission.

## Fee refunds and funding holds

`managed_checkout_fee_refund_plan(p_scope,p_attempt_id)` returns one pending durable operation with `id`, `order_id`, `application_fee_id`, `amount_minor`, `prior_refunded_amount`, `target_refunded_amount`, and `first_attempt_at`. Its target is the same canonical reversed commission; duplicate captures return the full fee. The existing refund cutoff applies to ordinary refunds; lost disputes remain recoverable outside that cutoff.

`complete_managed_checkout_fee_refund(p_scope,p_attempt_id,p_operation_id,p_receipt)` requires the verified fee/refund identity, exact operation amount, cumulative amount, platform, mode, and currency. The provider boundary must recover by operation metadata/idempotency before any retry. A manually refunded fee that leaves less collected funding than the creator award blocks payout and requires review.

## Verification

`supabase/tests/database/52_merchant_connections.sql` uses only rollback-isolated synthetic identities and actual signed-policy fixtures. It covers recipient auth, state replay, account/mode isolation, explicit assignment, capability refresh, account replacement protection, canonical fee snapshots, async fee proof, organic purchases, expired-referral analytics, unsupported policies, exact refund cutoff, lost disputes, excess manual fee refunds, and deauthorization. `node scripts/test-database-native.mjs` runs it alongside the existing locally reproducible suites. Named-production-data suites remain skipped by that existing runner.
