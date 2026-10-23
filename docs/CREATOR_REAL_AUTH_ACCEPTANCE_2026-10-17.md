# Creator payout setup: real local password and MFA acceptance

This rehearsal uses **real Supabase Auth v2.197.0**, the actual frontend `createConnectGateway` and the unmodified `creator-connect` authentication path. It replaces the earlier browser fixture's synthetic password AMR with genuine Auth-issued JWTs and an enrolled TOTP factor. It performs no hosted database change, deployment, email delivery or Stripe request.

Run from the KMA repository:

```sh
node scripts/test-creator-real-auth.mjs
```

The runner requires macOS arm64, Node, Deno and PostgreSQL17 at `/opt/homebrew/opt/postgresql@17/bin`. It downloads the official [Supabase Auth v2.197.0 release](https://github.com/supabase/auth/releases/tag/v2.197.0), verifies the published SHA256 for the macOS archive, and caches it under `/tmp/kma-gotrue-v2.197.0`. Docker and a Go compiler are unnecessary. Each run creates a separate socket-only PostgreSQL database, random loopback Auth/handler ports, synthetic users and a separate Vite module cache. It does not read project `.env` files or contact configured hosted services.

The production gateway is loaded directly from source with Vite's server module loader. Its Supabase client uses real `signInWithPassword`, `getUser`, `refreshSession`, `mfa.enroll`, `mfa.challengeAndVerify`, `mfa.listFactors` and `signOut` calls. The handler's default `getUser(token)` and `verifiedCreatorAuthentication` run unchanged. A native PostgreSQL RPC adapter replaces PostgREST and propagates claims only after real Auth verification; Stripe transport is explicitly fake.

## Passed scenarios

- A genuine password JWT opens the authenticated creator's embedded payout session.
- Advancing only the handler clock by 601 seconds rejects stale password AMR. A real token refresh does not make that AMR fresh. JWTs and AMR claims are never fabricated or edited for this test.
- The actual frontend password-confirmation method rejects an incorrect password and obtains a genuinely newer password AMR after the correct password. At the same simulated handler time, the original JWT remains stale while the reauthenticated JWT succeeds. Only the authentication clock advances; provider/database verification timestamps keep real wall time.
- After real TOTP enrollment, password sign-in alone is insufficient. The gateway requests MFA, an incorrect code remains blocked, and a correct fresh code produces AAL2 with real `totp` AMR and reopens the same account.
- A bearer token with an altered subject and unchanged signature is rejected by real GoTrue before any provider access.
- Another real local Auth user cannot access the first creator's funding scope.
- Actual client sign-out prevents new payout sessions.

The resulting fake-provider counts must be exactly **one account creation and three Account Sessions**; rejected authentication paths must create none. Safe evidence contains check names and counts, never passwords, TOTP secrets/codes, JWTs or Account Session secrets. The disposable Auth database necessarily retains synthetic authentication records, including password hashes and its enrolled test factor. The runner stops Auth, the bridge, Vite and PostgreSQL on completion; the stopped fixture directory is retained for inspection.

## What this proves, and what remains separate

This establishes the real local password/MFA contract across the production gateway and handler, with all local KMA migrations and database permission checks. It does not exercise password entry in a browser, hosted Supabase configuration, production sign-in redirects, phone/WebAuthn MFA, or a real Stripe component in the same session. The separate Stripe browser rehearsal covers the actual embedded form. Live eligibility, real transfers, bank payouts and release approval remain separate.

The authentication service is pinned for repeatability. Recheck its version and security updates before adopting it as any deployed service; this binary is only a disposable local test dependency.

## Recorded result

All seven scenarios passed on 17 October 2026, after applying **60 KMA migrations** to a fresh native database. The final fake-provider totals were **one account and three Account Sessions**. Node syntax, TypeScript/Deno checking, targeted lint and formatting checks passed.

- Final disposable evidence: `/tmp/kma-real-auth.SRXj2n/acceptance.json`.
- Repository copy: `qa/creator-real-auth-2026-10-17/acceptance.json`.
- Auth, bridge, Vite and the fixture PostgreSQL server stopped after completion.
- The official native runtime occupies approximately 75 MB; a completed test database and evidence occupy approximately 49 MB. Earlier stopped startup/debug fixtures were retained, not deleted.
