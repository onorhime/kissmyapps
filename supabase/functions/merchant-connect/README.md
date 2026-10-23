# Merchant Stripe connection boundary

This connects an existing eligible independent Stripe account to the configured
KMA platform. Creator recipient onboarding remains separate. Nothing in this
handler creates a Stripe account, sends invitation emails, starts checkout, or
transfers funds. Admin `revoke` disables KMA routing locally; it is not a Stripe
OAuth deauthorization request.

Required server configuration (defaults remain disabled):

- `MERCHANT_CONNECT_ENABLED=true` enables the configured connection registry
  API.
- `MERCHANT_CONNECT_ALLOWED_ORIGINS` lists exact KMA browser origins.
- `MERCHANT_CONNECT_BINDINGS_JSON` maps a stable binding ID to
  `{platform_account_id, livemode, client_id, secret_env, origin, callback_url, webhook_secret_env?}`.
- `callback_url` must be exactly `<origin>/merchant/callback`, and must also be
  registered in that Stripe platform's OAuth settings. Use the matching
  test/live OAuth client ID. No arbitrary browser return URL is accepted.
- `MERCHANT_CONNECT_PROVIDER_ENABLED=true` is separately required for external
  Stripe calls. While false, provider credentials are never read.
- `MERCHANT_CONNECT_LIVE_ENABLED=true` is additionally required for live
  bindings.
- Local HTTP origins require `MERCHANT_CONNECT_ALLOW_LOCAL=true` and a loopback
  hostname. Live callbacks must use HTTPS.
- `secret_env` names the environment variable holding the platform secret key.
  Do not put secrets directly in the JSON. Test and live prefixes must match.
- `webhook_secret_env` names the Connect endpoint signing secret. Configure only
  `account.updated` and `account.application.deauthorized` at the pinned API
  version for `merchant-connect-webhook?binding_id=<id>`. Each endpoint must use
  its own signing secret. Missing webhook configuration fails closed.

The invitation URL is a KMA URL with a 256-bit token in its fragment. The UI
must remove it from the address bar and keep it only for the intended session.
Only its SHA-256 digest is persisted. The recipient signs in with the exact
invited, confirmed email; being a merchant confers no creator/admin role. A
ten-minute state is bound to that user, invitation, platform and mode. An
exchange consumes that state atomically before the external OAuth call. Stripe
codes are single-use and are never retried automatically, even on timeout. A new
connection attempt is required after an uncertain exchange. Deprecated OAuth
tokens are discarded; only the verified `acct_` identifier and safe account
summary are persisted.

The callback UI removes code/state from the URL before rendering analytics or
performing asynchronous work. It posts them to `complete_connection`. A verified
candidate is displayed for explicit merchant confirmation. Admin product
assignment is separate and must not enable checkout. A refresh can only refresh
the existing verified candidate account, never accept an account ID from a user.

Webhook requests have no browser origin, require the raw Stripe signature, exact
API version and mode, and retain only event ID/hash/account status evidence.
Updates refetch current account capabilities. Deauthorization uses its signed
application/account scope because Stripe has already removed API access.
Database receipts reject replay mutation and never reactivate a revoked account.

Focused tests, with no external requests:

```
deno test --config supabase/functions/deno.json --allow-env supabase/functions/merchant-connect supabase/functions/merchant-connect-webhook
```
