# KissMyApps public partner registration release evidence — 2026-08-31

This record covers the public partner-registration implementation, its
production database contract, the frontend release that exposes the signup
screen, and the later hosted Auth activation. It does not prove a real inbox
delivery, enable tracking, or activate a funnel.

## Release identity

- Supabase project: `mmyruzjemjecqyivhrgr` (`KissMyApps`).
- VPS: Hostinger `72.60.125.99`.
- Release:
  `/srv/kissmyapps/releases/20260831T101719Z-public-signup-mobile-contrast-v2`.
- Active release link: `/srv/kissmyapps/current`.
- Frontend manifest SHA-256:
  `98c810bb2f50b96f9b70be4c7a2feb957e39e78c828dfebc7d2dd53f60684932`.
- Database migrations:
  `20260831100000_public_partner_registration.sql` and
  `20260831170000_public_partner_confirmation_otp.sql`.
- Corrective migration SHA-256:
  `d0dae5e662bec2c718b2689ecfe29bad7520a9df09718231e783bf04616b9a23`.

The repository still has no reviewed Git `HEAD`; the immutable release path and
hashes identify this release but do not replace the outstanding commit/tag
gate for later releases.

## Registration contract

- Only the Partner host exposes `#auth/sign-up`; the Admin host coerces that
  route to provisioned-admin sign-in.
- Registration collects full name, email, password, password confirmation, and
  one required acknowledgement covering age 18+, Terms, and Privacy.
- The browser sends a fixed `public_partner_v1` metadata contract with the
  versioned Terms and Privacy URLs dated `2026-07-13`.
- A valid signup creates an invited partner workspace, pending owner membership,
  notification defaults, and immutable legal-acceptance evidence. It does not
  grant dashboard access before email confirmation.
- The confirmation callback verifies the token hash, activates the matching
  accepted partner membership, removes the token from the browser URL, and
  opens Partner Performance.
- Malformed public-registration metadata rolls back atomically. Invited-user
  password setup remains a separate supported flow.

## Database evidence

- The linked production migration list reports local and remote
  `20260831100000` in sync.
- The migration was applied with `supabase db push --linked --skip-vault`; no
  Vault, seed, role, Auth configuration, or tracking setting was changed.
- The remote transactional pgTAP contract completed all 25 assertions.
- The contract covers exact metadata validation, rollback on malformed input,
  pending provisioning, default settings, legal evidence, update immutability,
  browser read/delete denial, invitation preservation, and confirmed-email
  activation.
- A pre-existing account-deletion limitation remains outside this release:
  deleting an Auth user with audit events conflicts with the append-only
  `audit_logs` trigger. This release does not weaken audit retention.

## Source and build checks

- Prettier, oxlint, funnel TypeScript/lint, and the production TypeScript build
  passed.
- All 33 test files and 426 tests passed with one worker.
- The production Vite build passed. Its only advisory is the existing main
  bundle size warning above 500 kB.
- The deployed bundle contains `public_partner_v1` and the Partner signup copy.
- All 26 files in the immutable release passed `sha256sum -c` from the release
  `dist/` directory.
- No Resend API key was written to the repository or deployment artifact.
- Production browser QA found a white-on-white mobile authentication card in
  the first `public-signup-v1` artifact. The dark branded mobile-card override
  and a regression test were added before this v2 release; the v1 artifact is
  retained but is no longer active.

## Email source and DNS evidence

- `supabase/templates/confirmation.html` is the reviewed source for one combined
  welcome and confirm-signup email. It uses the public KissMyApps icon, current
  brand palette, a founder-led introduction, a token-hash confirmation CTA, and
  exact Terms and Privacy links.
- The hosted Confirm signup template was saved and read back with subject
  `Welcome to KissMyApps Partners — confirm your email`, the branded XHTML
  source starting at its doctype, and no legacy default-template prefix.
- Resend DKIM and SPF/MX DNS records for `send.kissmyapps.dev` are publicly
  resolvable. DMARC is not yet published for that subdomain.
- The API key pasted in chat is treated as exposed and was not used. It must be
  revoked and replaced before production SMTP is configured.

## Runtime and public checks

- `kissmyapps-dashboard` is running, healthy, and has zero restarts after the
  release. Only that service was recreated.
- The existing edge Caddy container and configuration were not changed or
  restarted. The active Caddy configuration still validates.
- Partner root, Partner SPA fallback, Partner health, Admin root, and Admin
  health return `200` with valid TLS and security headers.
- Production browser QA at `375x812` confirmed the corrected dark Partner card,
  13.58:1 heading contrast, at least 4.67:1 for the remaining tested text,
  exact Terms/Privacy controls, zero off-screen elements, no horizontal
  overflow, and no console warnings/errors. The Admin `#auth/sign-up` route
  still rewrites to Admin sign-in and exposes no registration controls.
- HTML uses `Cache-Control: no-store`; versioned assets use one-year immutable
  caching.
- `go.kissmyapps.dev` remains fail-closed: root and unissued non-tracking routes
  return `404`, and `POST /r/test` returns `405`. No redirect GET was issued
  during this release check.
- DramaPal stream, mobile, and sandbox hosts return `200`; the API root retains
  its expected `404`; all health-enabled DramaPal containers remain healthy.

## Hosted Auth activation and retained gates

- Hosted public signup is enabled and a public Auth settings readback reports
  `disable_signup: false`.
- Email confirmation remains required (`mailer_autoconfirm: false`); anonymous
  sign-in and manual account linking remain disabled.
- Custom SMTP is enabled and the dashboard shows the intended sender name and
  Resend hostname. The operator corrected the saved port from `448` to Resend's
  TLS port `465`. The available dashboard browser session is signed out, so an
  independent control-plane readback and a real delivery remain open proof.
- The exposed credential was not reused or pasted into a shell command,
  environment file, or the repository.
- A real production registration, inbox delivery, confirmation callback,
  automatic dashboard entry, sign-out, and subsequent sign-in still require a
  fresh controlled email address.
- CAPTCHA is not configured. Add it before scaled or paid public acquisition if
  registration abuse becomes a risk.
- Tracking remains disabled. No product, funnel, partner link, live Stripe Price,
  payout release provider, worker schedule, or outbound analytics pipeline is
  activated by this release.

## Confirmation-callback corrective release

- A real hosted registration exposed that direct `verifyOtp` confirmation
  sessions identify their authentication method as `otp`. The original
  activation function accepted `password` and PKCE-style `email/signup`, so the
  email was confirmed and the browser became signed in before partner activation
  was rejected.
- The forward-only `20260831170000_public_partner_confirmation_otp.sql`
  migration now permits `otp` only for an exact `public_partner_v1`
  registration. Confirmed email, a stored password credential, the pending
  membership, and the immutable accepted Terms/Privacy evidence remain required.
  An ordinary invited account still cannot activate with OTP alone.
- The corrective migration was applied to project
  `mmyruzjemjecqyivhrgr`. The linked migration list reports local and remote
  `20260831170000` in sync, and linked public/extension schema lint reports no
  errors.
- Production data readback found both reported public-registration workspaces
  fully provisioned and active after the password workaround. No data backfill
  was required.
- The updated frontend keys activation state by stable user ID, propagates the
  post-authentication partner status, uses the newly returned session after
  password setup, and clears any half-finished local session if activation
  fails after confirmation, sign-in, or password setup. This prevents the
  invitation-password misclassification and the refresh-only dashboard button.
- Prettier, oxlint, funnel TypeScript/lint, all 33 test files and 429 tests, the
  application TypeScript build, and the production Vite build pass. The only
  build advisory is the pre-existing bundle-size warning.
- The updated database contract includes direct OTP, invitation-denial,
  unconfirmed-email, missing-password, and idempotency cases. The linked pgTAP
  command reached the remote database but the local Docker-based `pg_prove`
  harness stalled while inspecting its image, so that updated transactional
  contract is not recorded as passed. No database credential was requested or
  reset to work around the local harness.
- The frontend artifact is built but is not deployed. The active VPS release
  remains
  `/srv/kissmyapps/releases/20260831T101719Z-public-signup-mobile-contrast-v2`.
  The runbook requires a clean reviewed Git commit/tag before another frontend
  release, while this checkout still has no Git `HEAD` and every source file is
  untracked.
- One fresh retained QA registration is still required to prove the corrected
  inbox-confirmation-to-dashboard flow in production. An already consumed
  confirmation link cannot prove the fix.

## Rollback

1. Repoint `/srv/kissmyapps/current` to
   `/srv/kissmyapps/releases/20260830T063458Z-host-routing-v1`.
2. Recreate only `kissmyapps-dashboard` with the existing dashboard Compose
   project.
3. Recheck Partner, Admin, Go fail-closed behavior, and every DramaPal host.
4. Keep hosted public signup and tracking disabled throughout rollback.

The applied activation correction must be changed, if necessary, by another
reviewed forward migration or an approved restore. Do not edit or reverse an
already-applied migration in place.
