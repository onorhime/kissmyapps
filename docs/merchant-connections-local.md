# Merchant-owned Stripe checkout: local setup and acceptance

Status: local implementation and automated testing. This document does not authorise deployment, live email, connecting a real merchant, charging a card, or paying a creator. Keep checkout and payouts disabled until their separate release checks and approvals are complete.

## What the merchant connection does

An existing KMA owner or operations admin opens a product’s configuration and expands **Merchant Stripe connections**. **Send invitation** creates a secure invitation for the merchant contact and the intended Stripe environment, then attempts its email delivery. The UI reports accepted, failed, uncertain, processing or disabled email status separately from successful invitation creation. “Sent” means the email provider accepted the request; it does not prove inbox delivery. The secure KMA URL remains available to copy.

The recipient opens `/merchant/connect#invite=…`, verifies the invited email with an email code if necessary, and selects **Connect with Stripe**. Stripe owns account login, selection and authorisation. On return to `/merchant/callback`, KMA verifies the OAuth response, displays the exact business name, country, environment and `acct_…` ID, and requires explicit merchant confirmation. Returning from Stripe alone does not activate a connection.

The admin then explicitly assigns the verified connection to a product. Its funnels inherit that account. Connecting or assigning an account does not enable checkout, commissions, transfers or bank payouts. Creator recipient onboarding remains a separate flow.

**Resend invitation** emails the same valid link without rotating it. **View invitation link** retrieves the copyable link after a refresh. The server controls resend eligibility and cooldown; the UI refreshes that eligibility when the cooldown expires. Uncertain transport responses retain the same request ID when retried, and uncertain provider delivery reuses its existing email operation. **Create new invitation** is a separate, reviewed action on an existing merchant row: it reuses the merchant identity and mode, invalidates prior unfinished links and emails the replacement. Older manual-only invitations cannot be reconstructed for copy/resend, so their row keeps this explicit replacement action. Neither action assigns a product or enables checkout/payouts. Existing payment attempts retain their original account and commercial evidence.

Reconnecting the same Stripe account is supported. A merchant cannot replace an account already assigned to products: a different receiving account requires a separate merchant connection followed by explicit admin reassignment. Historical deauthorisation events older than the new confirmation are recorded without revoking that renewed connection; same-second events still revoke conservatively.

The API supports eligible independent Stripe accounts. An account already controlled by another Connect platform may be ineligible. Real Stripe eligibility, business requirements and platform geographic support still need a provider rehearsal; local fixtures cannot establish those facts.

## Identity and security boundaries

- Admin operations require the existing owner/operations role and password-authenticated session. Finance can read merchant connections. Merchant recipients need neither admin privileges nor creator activation.
- Supabase verifies the signed-in user and confirmed email. The database matches that email to the invitation. `registration_flow: merchant_v1` only chooses email copy; it grants no permission.
- Invitations use random secrets in the URL fragment. The database stores hashes, with a maximum seven-day lifetime. The page scrubs the fragment and temporarily retains continuation data in same-tab session storage.
- OAuth state is hashed, bound to the claimed invitation and verified user, expires in at most ten minutes, and is consumed before the code exchange. Provider exchanges are not retried after uncertain outcomes; start a fresh connection attempt.
- The page removes OAuth query parameters from browser history. `index.html` sets `no-referrer` before asset requests, and Supabase URL session detection is disabled specifically on the Stripe callback path.
- The browser never selects a payment account by submitting an arbitrary `acct_…` ID or commission amount. Merchant confirmation sends the invitation ID; the server resolves and refreshes the stored Stripe candidate.
- Provider responses, keys and OAuth tokens are not exposed in errors or persisted as connection credentials. Only verified account facts are retained. Raw invitation links are not included in workspace listings; an authorized admin explicitly retrieves a current link.
- Local revocation blocks creating new checkout sessions through that connection and preserves payment reconciliation and history. It does not automatically expire already-issued Stripe checkout URLs or delete a Stripe account. Revoking authorisation at Stripe can prevent provider access until the merchant reconnects. A binding-specific signed Stripe deauthorisation event also revokes the KMA connection. Capability events refetch current provider state.

## Disabled local configuration

Use the local Supabase project and local user fixtures, not the hosted project. Do not print secrets or copy real keys into this guide. UI-only tests require no credentials and make no provider calls.

For local invitation/database work with Stripe calls disabled:

```dotenv
MERCHANT_CONNECT_ENABLED=true
MERCHANT_CONNECT_PROVIDER_ENABLED=false
MERCHANT_CONNECT_LIVE_ENABLED=false
MERCHANT_CONNECT_ALLOW_LOCAL=true
MERCHANT_CONNECT_ALLOWED_ORIGINS=http://127.0.0.1:5173
MANAGED_CHECKOUT_ENABLED=false
CREATOR_TRANSFERS_ENABLED=false
```

Example `MERCHANT_CONNECT_BINDINGS_JSON` value, using placeholders only:

```json
{
  "local-test": {
    "platform_account_id": "acct_LOCALPLATFORM",
    "livemode": false,
    "client_id": "ca_LOCALAPPLICATION",
    "secret_env": "KMA_MERCHANT_TEST_SECRET",
    "webhook_secret_env": "KMA_MERCHANT_TEST_WEBHOOK_SECRET",
    "origin": "http://127.0.0.1:5173",
    "admin_origins": ["http://127.0.0.1:5173"],
    "callback_url": "http://127.0.0.1:5173/merchant/callback"
  }
}
```

The binding `origin` is the merchant-recipient portal and invitation destination; `callback_url` must remain on that exact origin at `/merchant/callback`. `admin_origins` separately lists the exact approved admin portals for that binding. Every recipient/admin origin must also be present in `MERCHANT_CONNECT_ALLOWED_ORIGINS`; adding an origin to the outer CORS allowlist alone grants no binding access. Origins cannot include paths, queries, credentials or trailing slashes. Explicit admin lists must be nonempty, unique and contain at most ten entries.

For split hosted portals, use `origin: "https://partners.kissmyapps.dev"`, `callback_url: "https://partners.kissmyapps.dev/merchant/callback"`, and `admin_origins: ["https://admin.kissmyapps.dev"]`, with both origins in `MERCHANT_CONNECT_ALLOWED_ORIGINS`. The admin can create the invitation, but the returned invitation and Stripe return URL still point to the partner site. All admin actions retain their existing database role/password checks. Recipient invitation, OAuth, status and confirmation actions remain restricted to the recipient origin; the admin origin cannot complete them.

Existing same-origin bindings that omit `admin_origins` retain `[origin]` as their admin list. Explicitly configuring a separate admin list removes that same-origin fallback. This is only an origin-routing change: preserve the selected account, callback, TEST mode, provider switch, signing secrets, checkout and payout gates when deploying it.

With the provider flag off, creating/copying local invitations is available, while starting Stripe authorisation is explicitly blocked. The key named by `secret_env` is not read for disabled provider calls. For completely disabled merchant functionality, set `MERCHANT_CONNECT_ENABLED=false`.

For an approved future Stripe test rehearsal, use the actual **test** platform account ID, its Connect application client ID, its test secret, and a registered exact callback URL. Enable only test provider access deliberately. Do not set the live flag or use a live key for this rehearsal. Stripe webhook signing secrets are independent from API secrets.

## Email verification templates

Local Supabase loads these sources through `supabase/config.toml`:

- **Confirm signup:** `supabase/templates/confirmation.html`. Its merchant branch renders the full eight-digit OTP from Auth; the existing partner signup branch is preserved.
- **Magic link:** `supabase/templates/magic_link.html`. Returning users receive a sign-in code, entered on the same merchant page. Existing partner accounts also retain the generic sign-in-link fallback.

The merchant calls `signInWithOtp` and `verifyOtp` directly for verified email sign-in. This does not create a partner agreement or administrator membership. The profile-only account creation behaviour follows the existing auth trigger.

Hosted Supabase does not automatically apply repository email templates. Before eventual deployment, review and apply both hosted templates, verify email delivery settings and preserve hosted OTP length of eight, and rehearse fresh and returning recipients. Keep provider click tracking off for authentication messages. During local acceptance, inspect the local email sink only; do not send to real inboxes.

## Payment account mapping

For the merchant-owned path:

1. The KMA managed-checkout binding identifies the KMA platform in `account_id` and `platform_account_id`, and opts into `charge_mode: merchant_direct`.
2. The database resolves the selected product merchant connection. The Stripe Price must exist in that merchant account and have verified price evidence for that exact account, mode and offer.
3. SpeakSix keeps its existing payment adapter. Its `MARATHON_KMA_CHECKOUT_ACCOUNT_ID` must pin the selected **merchant** account, not the KMA funding platform. No SpeakSix source change is required for this connection mode.
4. A payment uses the selected Standard merchant account plus the application fee calculated from the frozen existing signed agreement/rule. Unattributed payments omit the application-fee parameter, and reconciliation independently verifies that the actual fee is zero.
5. KMA verifies the charge and fee independently, records the existing creator commission ledger, and applies the existing hold, refund cutoff, payout cadence and manual approval requirements.

Admin Payouts exposes **Collected from merchant checkout** as the funding model. This reuses existing agreement and commission settings; it adds no second commission percentage, attribution window or payout policy. Saving the funding draft still requires separate approval.

Upfront fee collection currently requires a signed subtotal-after-discounts basis excluding tax/shipping and a rule without first-purchase-only eligibility. Admin funding configuration rejects unsupported policies, and checkout checks them again. These policies require an explicit reviewed change; they are never silently rewritten. Currency/FX mismatches can leave a verified buyer payment recorded while holding the creator award for currency review. A paid customer and a payable creator award are separate states.

## Separate payment webhook destinations

Merchant-direct checkout receives two Stripe event scopes. Keep the existing `webhook_secret_env` in `MANAGED_CHECKOUT_BINDINGS_JSON` for the **Your account** destination (platform application-fee events and historical platform payments). Add `connect_webhook_secret_env` naming a **different** signing secret for the **Connected accounts** destination (merchant payments, refunds and disputes). Both destinations can use the same KMA handler URL and binding ID; their Stripe signing secrets must remain distinct. Existing platform-only bindings keep their original configuration.

The handler selects the required secret from the event envelope and verifies that exact signature before any provider or database read. A connected-account event signed with the platform destination secret is rejected, and vice versa. Missing connected scope configuration fails closed. The separate `merchant-connect-webhook` handles account capability and deauthorisation events using its own configured Connect destination secret.

For a future provider rehearsal, verify the destinations' test/live scope and pinned API version, register their secrets without exposing them, and send one verified event from each scope. Local fixtures exercise both signatures; no Stripe webhook endpoint was created or changed during implementation.

## Repeatable automated checks

From this repository:

```sh
npx vitest run src/features/merchant-connections/merchant-connections.test.tsx src/features/admin/configuration/ProductConfigurationPage.test.tsx src/App.test.tsx src/features/creator-settlements/settlements.test.tsx --maxWorkers=1
npx tsc -b --pretty false
deno test --config supabase/functions/deno.json --allow-env supabase/functions/merchant-connect supabase/functions/merchant-connect-webhook
node --conditions=react-server scripts/test-managed-checkout-crossapp.mjs --merchant-direct
```

The cross-app runner applies the actual KMA and SpeakSix schemas to disposable databases and uses the real handlers, adapters and reconciliation logic. Stripe transport is synthetic and loopback-only. It does not use application environment files, send email, or move money. Native PostgreSQL and the existing runner dependencies must be installed.

Evidence at this checkpoint:

- Merchant UI suite: 16 tests passed, including isolated routing, sign-in requirement, wrong email, expired invitation, callback identity confirmation, provider requirement refresh, different-user callback recovery, explicit account assignment, link copying and existing-merchant renewal/error handling.
- Existing App, product configuration and settlement suites passed alongside the original merchant tests. The added funding regression verifies that the application-fee option uses the bound KMA platform and existing signed rule without a second percentage field.
- TypeScript checks passed.
- Full UI baseline: 911 tests plus 18 script checks passed before the small renewal additions. The final four affected suites passed all 124 tests.
- Full edge baseline: 297 tests passed. After the final refund-receipt guard, all 14 merchant payment tests passed, including incomplete post-refund proof followed by safe recovery without a second refund. Focused lint and diff checks passed.
- Database runner: 49 passed, zero failed and three production-data-only skips; 62 migrations applied to disposable databases. Regression coverage includes assigned-account replacement rejection and safe handling of historical deauthorisation events after reconnection.
- Merchant-direct cross-app rehearsal: 11 scenarios passed; evidence at `/tmp/kma-managed-crossapp.GwT9Fl`. The legacy platform path also passed 11 scenarios at `/tmp/kma-managed-crossapp.WTMZEy`. These are local synthetic-provider checks, not real Stripe transactions.
- Production build passed locally. No release was deployed.
- Safari previously verified the isolated recipient confirmation and admin renewal flow through native accessibility checks. Subsequent in-app-browser responsive acceptance verified recipient confirmation, email-to-code layout, admin renewal and new invitations at narrow widths, with no horizontal overflow at 320, 375, 390, 620 or 768px. See [responsive acceptance evidence and screenshots](qa/merchant-mobile-2026-10-17/README.md). These fixtures used synthetic identity and gateway responses, made no provider or email calls, and were removed after testing. Physical-phone/mobile Safari and full-desktop visual acceptance remain unverified.

Full release checks and latest SQL/edge suite totals belong in the final release evidence, rather than being inferred from these focused checks.

## Acceptance still required before activation

- [ ] Review the new schema and apply only to the intended environment under release approval.
- [ ] Configure and test hosted email templates with a fresh merchant and returning merchant; verify wrong-email and expired/reissued invitation behaviour.
- [x] Complete [responsive-browser checks for the admin invitation and limited merchant pages](qa/merchant-mobile-2026-10-17/README.md). This covers narrow browser viewports; physical-phone/mobile Safari and full-desktop visual checks remain pending.
- [ ] Complete a real Stripe test-account connection, selecting among multiple accounts and confirming the exact returned business/account/mode.
- [ ] Verify recovery from cancelled authorisation, missing account requirements, expired state, provider interruption and a deliberately reissued invitation.
- [ ] Verify account replacement requires the intended admin review boundary and cannot silently retarget assigned products.
- [ ] Verify signed capability/deauthorisation webhooks, duplicates, delayed events and the connection’s recovery path.
- [ ] Verify the merchant Price and both KMA/SpeakSix account bindings using a real Stripe test checkout.
- [ ] Observe the real test payment on the merchant account, the exact application fee on the KMA platform, and the creator award held under the existing signed settings.
- [ ] Test a refund and fee reconciliation, attribution expiry, unsupported-rule rejection and currency-review holds.
- [ ] Recheck checkout and creator transfer flags separately. A successful merchant connection never authorises either gate automatically.

Creator bank-payout acceptance, product-owner payouts and production traffic are not established by the merchant connection tests.


### Merchant email OTP acceptance

The merchant input keeps all eight digits, preserves leading zeroes, supports email-code autofill and whitespace-separated paste, and rejects letters or overlong codes instead of silently truncating them. Six-digit codes remain accepted at the UI boundary for older local Auth instances; an eight-digit Auth service still rejects a six-digit prefix. A code cannot advance the connection flow until Auth establishes a verified session. Invalid and expired responses retain the email step, and resend clears stale code and status messages.

`node scripts/test-merchant-real-auth.mjs` exercises the actual pinned Supabase Auth binary and both Go templates against disposable native PostgreSQL and a loopback SMTP sink. The frontend tests cover input/autofill and failed-provider responses; the native acceptance covers real signup/magic-link dispatch, verification and expiry. The native test enforces confirmations in its own Auth process; it neither changes hosted Auth nor alters the existing general local autoconfirm preference. Hosted external-email acceptance remains a gated release check.

## Merchant invitation email delivery

Merchant invitation email uses the existing Resend account and verified `AGREEMENT_EMAIL_FROM` sender, independently of agreement notifications. Deploy migration `20261019090000_merchant_invitation_email.sql` before the updated `merchant-connect` function and admin UI. This migration creates no scheduled job, sends no email, and changes no checkout, payout, Stripe mode or connection assignment.

Set `MERCHANT_INVITATION_EMAIL_ENABLED=true`, `MERCHANT_INVITATION_TOKEN_KEY_ID=v1`, and `MERCHANT_INVITATION_TOKEN_KEYS_JSON={"v1":"<64 lowercase hexadecimal characters from 32 random bytes>"}` as server secrets. Keep `RESEND_API_KEY` and the existing verified sender unchanged. The dedicated HMAC key is not a Stripe, Supabase or Resend credential. Retain old key IDs until every invitation using them has expired; removing a key makes those links unrecoverable in the admin UI and requires explicit renewal. Email link/open tracking must remain disabled for the verified sending domain, so the fragment bearer link is not rewritten through a tracking service.

`create_invitation` and `resend_invitation` require a UUID `request_id`. The browser retains it across an uncertain transport response. Creation is idempotent for the same admin and normalized payload; a different payload with the same ID is rejected. An intentional new invitation uses a new ID and revokes the previous unfinished link. `resend_invitation` accepts only the invitation ID and request ID, keeps the existing active link, and obtains the recipient from the saved invitation. `get_invitation_link` lets an authenticated Owner/Operations admin recover a valid copy link after reload. Legacy hash-only invitations remain usable by their recipients, but need explicit renewal for email/resend or admin link recovery.

The database retains only the original token hash, derivation request ID and HMAC key ID. Raw invitation tokens, rendered email bodies and URLs are not persisted in database rows or audit logs. The server reconstructs the token and verifies its hash before returning the copy link or sending. Delivery records retain the nonsecret template inputs and an envelope digest. Version 1 of the email is immutable; changed sender/business settings use the original frozen inputs on a retry. A changed rendering digest fails closed and requires explicit renewal, rather than reusing a provider idempotency key with different content.

Each delivery uses one eight-second Resend request with redirects refused. `sent` means Resend accepted the message and returned a valid receipt; it is not a claim of inbox delivery. `failed` means a known provider rejection. A timeout, ambiguous response, concurrent provider request or lost database finish is `unknown`. A pending send holds a 30-second lease and a 60-second cooldown. Expired leases are reported as unknown. Retrying an uncertain delivery reuses its original provider key and exact envelope for at most five attempts within 23 hours, leaving a margin inside Resend's 24-hour idempotency window. A provider payload conflict is terminal. Outside that window, explicitly create a new invitation rather than silently sending under a new key.

Recipient and admin locks enforce the delivery limits across concurrent requests: at most five new email operations per recipient and twenty per admin per hour. Explicit renewal is blocked during the recipient's current email cooldown before any old link is invalidated. The same accepted operation cannot send twice when its browser request is replayed; a deliberate resend after cooldown receives a separate email operation while retaining the same invitation link. `delivery.retry_at` and `delivery.can_retry` drive the UI. Copy-link fallback remains available when delivery is disabled, rejected or uncertain, provided the invitation itself remains active.

Validation is local and provider-free by default:

```sh
deno test --config supabase/functions/deno.json --allow-env supabase/functions/merchant-connect/index_test.ts supabase/functions/merchant-connect/invitation-email_test.ts supabase/functions/merchant-connect-webhook/index_test.ts
node scripts/test-database-native.mjs
node scripts/test-merchant-invitation-email.mjs
```

The integration acceptance executes the actual Edge handler and PostgreSQL RPCs with an injected Resend transport. It does not send mail, use real identities, enable checkout/payouts, or unpause existing jobs. A hosted delivery test must use the separately approved recipient and report provider acceptance separately from the recipient's inbox confirmation.

### Automatic invited-email code entry

The signed-out invitation route uses one public, token-authorized POST action: `request_invitation_code`, with only `invite_token` and a UUID `request_id`. The Edge function validates the existing 43-character bearer token, resolves its saved invitation, and checks the exact configured recipient origin before reserving a code send. An admin origin or merely globally allowed origin is insufficient. All existing admin, claim, OAuth and confirmation actions still require their existing verified-user authentication.

The response contains only `email`, `expires_at`, `status` (`sent`, `cooldown`, `failed` or `unknown`) and `retry_at`, plus the normal request correlation ID. The email cannot be supplied or changed by the browser. Invalid, expired, revoked, confirmed or unusable invitations return generic recovery guidance without recipient information. A claimed invitation whose account no longer has the same verified email is also rejected. No invitation is claimed and no Stripe state changes during this pre-authentication operation.

The browser automatically requests the code only after sign-in resolution reports an anonymous user and the invitation page is visible. The invitation remains in the URL fragment/session state, not the request URL. Ordinary GET requests, prefetches and CORS preflights do not send mail. A scanner that executes the entire visible application can still trigger the same bounded first send; server-side deduplication and recipient limits prevent repeated application loads from sending unlimited codes.

The browser preserves a request ID per invitation across React rerenders and refreshes. That ID never dispatches a second Auth request, including after a timeout or an expired in-flight lease. Supabase Auth does not expose email-send idempotency keys, so an uncertain response is not retried automatically. An explicit resend uses a new ID after the 60-second recipient cooldown. A maximum of five actual dispatch attempts per saved recipient per hour applies across invitations. The private tracking table contains no raw invitation token, OTP, session or provider response body.

Delivery uses the normal Supabase Auth `/auth/v1/otp` endpoint and public project key, with the existing `merchant_v1` signup metadata and a server-configured recipient callback. The request is bounded to eight seconds and refuses redirects. It cannot create admin/affiliate membership, bypass email verification, change payment gates, or return a signed-in session. Existing numeric OTP templates and the browser's standard `verifyOtp` complete sign-in; the existing invitation claim then verifies that the authenticated email matches the invitation before Stripe setup proceeds.

Apply migration `20261019100000_merchant_invitation_otp.sql` and deploy the updated Edge function before the corresponding frontend. No new provider credentials, scheduled jobs, email templates, checkout settings or payout settings are needed. Local validation includes `invitation-otp_test.ts`, SQL suite 57, the real local GoTrue/SMTP code-entry rehearsal, and the actual handler/database acceptance with injected transport. These checks send no production email and do not deploy anything.
