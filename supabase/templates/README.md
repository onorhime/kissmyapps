# Supabase Auth email template sources

`confirmation.html` is the source for the hosted Supabase **Confirm signup** email. It combines the required email-confirmation action with the welcome message; it is not a separate marketing email.

The template expects signup metadata to provide `full_name`, with a generic greeting fallback. Its confirmation link intentionally uses Supabase's `SiteURL` and `TokenHash` variables. Hosted Supabase projects do not read this source file automatically, so applying it requires an explicit, reviewed dashboard or Management API update. Keep external-provider click tracking disabled because rewriting an authentication link can prevent confirmation.

## Merchant connection verification

New merchant-only sign-ins use `registration_flow: merchant_v1` solely to choose the email copy. The confirmation template sends the full `{{ .Token }}`; returning users receive `magic_link.html`, also with the full code. Hosted Auth already uses eight digits, and local `auth.email.otp_length` now matches it. The merchant form accepts complete six- or eight-digit codes for older local environments without truncation; Supabase verifies the actual code and expiry. This does not reduce the hosted eight-digit policy. They enter it on `/merchant/connect`, so a separate email redirect cannot send them into the partner dashboard. Both are configured for local Supabase in `config.toml`.

The authenticated server and database verify the confirmed email against the invitation. User metadata grants no role or invitation access. The account trigger creates only a profile for merchant metadata, not a creator or administrator.

Before production release, apply these **Confirm signup** and **Magic link** template sources to the hosted project. Repository edits do not update hosted Supabase. Test with local Inbucket first; this implementation does not send any live invitation email. The admin copies a KMA invitation URL, and Stripe authorisation remains a separate step.


The magic-link template always includes the code, including when an existing partner requests merchant sign-in. Supabase retains that existing account's metadata, so the generic branch also preserves a `{{ .ConfirmationURL }}` sign-in-link fallback. Merchant-only accounts receive code-only content. The existing partner **Confirm signup** branch and its `SiteURL`/`TokenHash` link are unchanged.

## Local acceptance and release preparation

Run `node scripts/test-merchant-real-auth.mjs` on macOS arm64 with native PostgreSQL17. It reuses the pinned Auth binary cached by `scripts/test-creator-real-auth.mjs`; it never loads application `.env` files. Actual Supabase Auth renders both repository Go templates, sends only to an in-memory SMTP sink on `127.0.0.1`, and verifies eight-digit codes using synthetic `.invalid` recipients. It covers fresh and returning merchants, invalid/truncated/consumed/expired codes, resend recovery, and the existing partner confirmation link. For production-equivalent verification it enables email confirmation in its disposable Auth process; the general local developer autoconfirm preference is unchanged. No inbox message or token is persisted in its public evidence.

Release preparation must retain hosted `mailer_otp_length = 8`, install **both** exact template sources, and keep the other Auth settings and partner callback routes intact. Repository sources and a successful local SMTP test are not proof of hosted template installation or external email delivery. After the separately approved release, verify one fresh merchant and one returning recipient using the real email provider, plus the partner confirmation link. Do not lower OTP length to compensate for an old frontend.
