# Stripe restricted-key compatibility — 5 September 2026

Status: **price-verifier compatibility deployed; authenticated verification blocked by `stripe_price_not_found`**.
Authority: the user approved the Stripe connection work and confirmed saving an
owner-provided `rk_live_` credential as `STRIPE_SECRET_KEY` in the existing
production Supabase project. No key was created, rotated, displayed or exported.

## Scope and release identity

- Project: `mmyruzjemjecqyivhrgr`.
- Function: `stripe-price-verifier`.
- Function ID: `c2b511c7-b47d-44cc-a387-3d5aede4175e`.
- Final hosted revision: **8**, ACTIVE, `verify_jwt=false` (unchanged; the
  function enforces its own origin, Bearer session and database authorization).
- Deployed bundle SHA-256:
  `851a87bc0535554dacc3ffbccc3bf121d5263a84da8c4a7dce683c220c1ac087`.
- Prior source: revision 6, bundle SHA-256
  `0cafed23d6c63de5ce2a1e5380d84876a103d95a63cf238e678d406bfb88d6bf`.

The release candidate was built from downloaded production source, overlaying
only the verifier entrypoint and the new `_shared/stripe-auth.ts` helper. The
seven other runtime files were retained byte for byte, including the production
Supabase client helper rather than its unrelated pending local timeout changes.
All nine runtime files matched a post-deployment source download.

The code deployment created revision 7. The first public preflight returned
`503 configuration_error` because `ADMIN_ALLOWED_ORIGINS` was absent. This path
runs before reading any Stripe credential or making a Stripe request. Added
only `ADMIN_ALLOWED_ORIGINS=https://admin.kissmyapps.dev`, matching the repository
configuration contract, then verified its digest against that exact origin.
The subsequent public access checks passed.

Saving the project Edge configuration incremented all eleven function revisions
once. The verifier is therefore revision 8. All ten other function bundle hashes,
JWT settings and ACTIVE statuses remained unchanged; their code was not deployed.
No checkout, worker, webhook, database, frontend, Hostinger or Vercel code was
deployed as part of this release.

## Local implementation and checks

The shared validator accepts restricted `rk_live_` and standard `sk_live_`
server keys. It rejects missing, test-mode, publishable, malformed and oversized
credentials without echoing them. Stripe still enforces permissions; there is
no credential fallback or permission expansion.

Source compatibility is wired into the verifier, checkout-session,
funnel-checkout-context and stripe-worker. **Only the verifier is deployed**;
the checkout/context/worker changes remain local alongside the previously
pending checkout work.

Passed:

- Full Edge test suite: **82 tests, 0 failures**; provider calls mocked, no
  live Stripe requests, payments or subscriptions from these tests.
- Deno lint: 47 files; formatting checks for the affected files.
- Exact release-candidate tests: 9 passed; candidate lint: 10 files.
- README formatting and `git diff --check`.

Regression tests cover both server-key types, rejection before provider calls,
Stripe permission failures without stored verification or leaked provider
details, worker validation before claiming jobs, and the existing zero-total
checkout safeguards with both supported key types.

## Production proof and verification boundary

| Request                             | Result |
| ----------------------------------- | ------ |
| Admin-origin OPTIONS preflight      | 204    |
| Admin-origin POST without a session | 401    |
| Foreign-origin POST                 | 403    |

All three responses use `Cache-Control: no-store, max-age=0`.
These checks establish the public access boundary, **not** live Stripe access.
At the initial release boundary the Chrome admin tab remained signed out; an
authenticated Verify Price request had not been made. The signed-in follow-up
below supersedes that pending-login status. No fabricated session was used.

Before/after database snapshots matched for products, funnels, documents,
agreements, billing-offer configuration, link/checkout counts and migration
history. There are still 35 migrations, zero checkout attempts and zero issued
affiliate links. No product, funnel, offer or tracking gate was activated.

BC Learn's offer remains draft and unverified:

- Offer: `b7271cde-f85f-42e0-a653-b05fc3b7ee4c`, key `monthly`.
- Stripe Price: `price_1UCJHDE47mNwFlz1NEFOTxtB`.
- Expected amount: USD 100 minor units ($1), subscription.
- `stripe_livemode_verified_at`: null.

`STRIPE_SECRET_KEY` presence was checked via secret metadata only. Its value
was never read. The webhook signing secret is still absent. Checkout remains
off; no charge, subscription, discount, webhook destination or payout was created.

## Next acceptance and rollback

1. Have the Stripe account owner confirm the saved key belongs to Futura Funds
   Inc. (`acct_1SaSp9E47mNwFlz1`) and has Prices read access. If the supplied key
   belongs elsewhere, the user should save the correct account's restricted live
   key into the same Supabase `STRIPE_SECRET_KEY` entry, not into chat or the funnel.
2. Retry Verify live Price on the existing monthly offer after account/key scope
   is resolved, then confirm both the UI and the database verification timestamp.
3. Leave activation and checkout off until the separately scoped webhook,
   discount and checkout integration work is ready.

Rollback source and raw evidence are in `/tmp/kma-restricted-key.fGOqC0/`:
`rollback/`, `rollback-sha256.json`, `candidate/`, `readback/`,
`functions-before.json`, `functions-after.json`, `public-checks.json`, and the
before/after database snapshots. This is temporary task storage, not a durable
backup. Before rollback, verify the recorded manifest and current hosted bundle,
then redeploy only the prior verifier source with the same import map and JWT
setting. Retain the correct admin-origin configuration; reverting to its absent
state restores the preflight failure. The prior verifier rejects restricted
keys, so rollback intentionally blocks verification rather than broadening access.
Do not deploy the entire dirty functions directory or alter migration history.

## Authenticated follow-up — 5 September 2026

The user signed in to the BC Learn configuration page. Three normal UI
verification requests were made: an initial attempt, a diagnostic attempt using
browser network observation, and a final native DevTools capture after the
browser API could not retrieve the response body. All failed; no verification
was recorded. The last request returned HTTP 400 with:

```json
{
  "error": "stripe_price_not_found",
  "message": "The configured Stripe Price was not found in the live account.",
  "request_id": "f0830018-ffd8-4cf1-8a11-d518849ac008"
}
```

The deployed verifier maps Stripe's GET Price HTTP 404 to this specific error;
this is not a guessed explanation based on the dashboard's generic message.
The browser received only the generic error and internal request ID, never the
Stripe key. No credentials or request authorization headers were copied.

Stripe's authenticated Price page and read-only Workbench inspector independently
confirmed the exact Price exists in **Futura Funds Inc.**, account
`acct_1SaSp9E47mNwFlz1`, under product `prod_VCii4guzoryBtZ` (BC Learn Test).
The inspector showed active/live, USD 100, monthly interval/count 1, recurring
licensed usage, per-unit billing, decimal amount `100`, and null custom amount,
tier mode and quantity transform. These facts match the saved offer and verifier
checks. The Price page showed zero active subscriptions.

Inference: the supplied key likely belongs to a different Stripe account, since
it cannot resolve a Price visibly present in the intended account. The key's
actual owning account has **not** been inspected, so this is not a confirmed
ownership mismatch. The owner must confirm account scope and required read
access. Restricted keys control access to Stripe resources; see Stripe's
[API key documentation](https://docs.stripe.com/keys).

Final database readback: product draft, offer draft, verification timestamp null,
zero checkout attempts and zero affiliate links. No source code, server config,
database rows, Stripe objects, keys or permissions were changed in this follow-up.
DevTools was closed after the response was inspected; the admin page was left on
the existing draft offer.

The initial `/tmp/kma-restricted-key.fGOqC0/` directory was no longer present on
this follow-up. Its rollback files must not be assumed available: obtain and
verify the prior release source before any later rollback attempt.
