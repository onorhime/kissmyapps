# BC Learn app-access integration preparation

Status: inspected and prepared, not implemented or deployed. The checkout and
partner-reporting release is separate from granting access inside the product app.

Owner decision on September 7, 2026: BC Learn has no product app/backend yet.
Keep app access as documented future integration work; do not build or enable
it now. The developer-facing requirements are in
[funnel contract section 7.1](integrations/funnel/API_CONTRACT.md#71-future-app-access--not-implemented),
with matching Markdown, HTML and OpenAPI documentation copies.

## Verified starting point

Read-only production inspection at `2026-09-07T14:19:56Z`, project
`mmyruzjemjecqyivhrgr`, product `fdbabb87-9743-4521-bc8d-11804fe1185f`:

- BC Learn is active, with two active subscriptions from the no-charge tests.
- Neither subscription's account is bound to a Supabase Auth user.
- BC Learn has zero entitlement rows.
- The only public/private app-access-related function found by name is the
  existing `validate_entitlement_identity` trigger function, not an access API.
- The database has 44 migrations. This inspection made no database changes.

Source tracing confirms that `ensure_stripe_customer_account` creates an internal
account identified by the verified Stripe customer. It does not sign a buyer into
BC Learn or bind that account to an external app identity. The existing
`entitlements_read_self` policy needs an established `accounts.auth_user_id`;
creating a subscription alone cannot satisfy it.

The v1.3 funnel contract deliberately keeps receipt confirmation read-only and
does not grant app access. Billing email is for Stripe prefill, not ownership
proof. Partner identities and buyer/app identities must remain separate.

## Information needed before implementing the app boundary

1. BC Learn app/backend repository or the developer responsible for it.
2. Its actual sign-in provider/project and stable user-ID format. A waitlist
   Firestore entry is not evidence of a signed-in product account.
3. Whether buyers sign in before checkout or claim their purchase after checkout,
   including the verified app/deep-link destinations if applicable.
4. The premium feature/access policy, including trial, cancellation-at-period-end,
   failed renewal, refund, dispute and multiple-subscription behavior.

Do not request private keys in chat. Decide the integration boundary first, then
store any required credentials in the appropriate server secret manager.

## Proposed implementation sequence

### 1. Bind an authenticated app user to a verified purchase

Use the app's real authentication system, validated by a trusted backend. Scope
every binding to the product and authenticated subject; never accept an arbitrary
email, Stripe customer ID, checkout session ID or partner click as identity proof.

If login happens before checkout, bind the authenticated subject server-side to
the immutable checkout attempt. If login happens afterward, design a separate
short-lived, single-use purchase-claim flow with proof of both purchase possession
and the signed-in account. A successful return URL alone cannot authorize it.
The exact route/token exchange depends on the app's authentication architecture.

Keep bindings auditable and protected against replay, account takeover and
cross-product access. Support multiple legitimate purchases without rewriting
immutable Stripe subscription/account identities. Do not merge accounts merely
because their billing emails match.

### 2. Resolve access from authoritative subscription evidence

Separate access eligibility from affiliate commissions: a permitted discounted
subscription can have access without paid revenue, but the existing BC Learn
no-charge test remains explicitly non-unlocking unless separately approved.

Implement the agreed lifecycle policy with idempotent handling of renewals,
cancellations and delayed/out-of-order provider events. Define evidence freshness,
expiration and outage behavior; never turn missing data into a confirmed grant.
Do not introduce a new payout, revenue or browser-event side effect.

### 3. Expose a minimal authenticated access response

Return only the signed-in user's product access state and relevant expiry/recheck
information. Keep account binding and writes server-only. The app/backend must
enforce access to protected features/content; a hidden UI button is insufficient.

Use a separate product-app credential scope if server-to-server authentication is
needed. Funnel analytics/checkout credentials must not gain authority to grant
app access. Do not add a supposedly live endpoint to the published funnel API
until it exists, has been tested, and is deployed.

### 4. Verify and release separately

Required checks: anonymous/foreign-user denial, product scoping, replay and
concurrent-claim safety, expired/forged claims, identity conflicts, multiple
subscriptions, renewal/cancellation/refund policy, stale evidence and logout/login
refresh. Verify actual protected app behavior with its real authentication.

Keep synthetic fixtures local or rollback-only. Do not create charges, redeem
another promotion, alter the two test subscriptions, backfill entitlements or
grant test users premium access as an incidental test step.

## Handoff boundary

Implementation is deferred until the app exists and its authentication/access
policy is defined. No entitlement migration,
API deployment, subscription mutation, app code change or access grant has been
made. The earlier reporting release remains unchanged.
