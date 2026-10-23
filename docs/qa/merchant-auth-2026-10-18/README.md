# Merchant email verification — local acceptance, 18 October 2026

The hosted eight-digit policy stays in place. The merchant form now accepts the complete code, including leading zeroes and pasted whitespace, without silently dropping extra digits or letters. It supports older six-digit local codes at the input boundary; Supabase remains authoritative. A real eight-digit Auth service rejected a six-digit prefix in this acceptance run.

The confirmation template retains the existing partner signup link. Both merchant email types render `{{ .Token }}`. Magic-link emails for existing partner accounts also retain a generic sign-in-link fallback because Supabase preserves their original account metadata.

## Verified locally

- 28 focused merchant UI tests passed: eight-digit paste/autocomplete attributes, existing six-digit compatibility, malformed/overlong/non-numeric input, pre-auth invitation isolation, invalid/expired/missing-session responses, resend and failed-send paths, plus existing connection/admin regressions.
- Actual Supabase Auth v2.197.0 rendered both repository Go templates and delivered six synthetic messages into an in-memory loopback SMTP sink.
- Fresh merchant confirmation, returning merchant magic-link dispatch, full eight-digit verification, rejected wrong/truncated/consumed codes, expiration, resend recovery, partner confirmation verification and preserved partner metadata passed.
- Auth, SMTP, HTTP bridge and disposable PostgreSQL processes shut down after the run. No hosted configuration, real email, Stripe call, deployment, checkout gate or payout gate changed.

The machine-readable proof is [native-auth.json](./native-auth.json), including exact template source hashes. It contains no OTPs, JWTs, inbox bodies or provider secrets.

## Reproduce

Use Node24 and native PostgreSQL17 on macOS arm64:

```sh
pnpm exec vitest run src/features/merchant-connections/merchant-connections.test.tsx --maxWorkers=1
node scripts/test-merchant-real-auth.mjs
```

The native runner reuses the official Auth archive already cached by `scripts/test-creator-real-auth.mjs`, verifies its pinned SHA256 and extracts a fresh executable for each test. It never loads application `.env` files. It enables confirmation in its disposable Auth process to match hosted verification behavior; the general local developer autoconfirm preference remains unchanged.

## Release boundary

Both hosted Auth templates still need installation during an approved release, with `mailer_otp_length=8` preserved. External delivery and actual hosted fresh/returning email sign-in require post-release acceptance. This native test establishes template rendering and Auth behavior locally; it does not claim hosted email delivery, physical-phone autofill, or a newly completed hosted merchant connection. Separate existing database/merchant tests cover invitation authorization. Checkout and payouts remain disabled.
