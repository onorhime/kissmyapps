# Embedded checkout and original $0 receipt recovery — 2026-09-07

## Scope and guardrails

User approved repairing the completed test's processing, forwarding billing email,
embedding Checkout in BC Learn, automatic confirmation and updating the integration
contract. No new Stripe Checkout Session, subscription, charge, cancellation or
coupon expansion was performed. The original single-redemption code is consumed;
a new manual test requires separately approved no-charge discount capacity.

The original bc-learn-funnel Vercel project and /speak flow were preserved. Sites
skill guidance was applied to the existing hosting marker without migrating or
publishing over the user's explicitly selected Vercel/Supabase infrastructure.

## Deployed

- Supabase project: `mmyruzjemjecqyivhrgr` (43 migrations).
- `20260907090000_stripe_clover_event_compatibility.sql` applied.
- `20260907093000_embedded_checkout_presentation.sql` applied.
- Functions: stripe-webhook, stripe-worker, checkout-session,
  funnel-checkout-context. Webhook signature verification/API pin unchanged.
- BC Learn: `prj_FttYGokNkTc0yfHKiajJLueErWSf`, final deployment
  `dpl_4mH1tB4Xm2jwPeKo8xjZH4i5zuUm`, READY and aliased to
  https://bc-learn-partner-funnel.vercel.app.
- Previous pre-change funnel deployment: `dpl_9jtZDFXHbkArTx8ffpiaAh5hgba3`.
- Original app remains `dpl_Cwjmx2EjoeKYEDLVaLLdgwMahkf8` in
  `prj_sV9TU6oIpsQxZ5cMz39HyKDsTEhG` (read-only API verified).
- Production publishable-key env added for the same live Stripe account; no
  private Stripe key copied to Vercel/browser. Checkout switch and $0 guard unchanged.
- Partner docs-only release:
  `/srv/kissmyapps/releases/20260907T091300Z-funnel-docs-v13`.
  It copies all existing production frontend bytes from
  `20260906T192427Z-partner-traffic-6afc1b5cbbbb`; original SHA256SUMS verified.
  Only docs added. The Caddy route explicitly serves `/developers/funnels[/]`;
  candidate validated before replacing dashboard config. Previous config is
  saved as `dashboard.Caddyfile.previous` in the docs release.
- Recreated only kissmyapps-dashboard. All DramaPal container IDs remained unchanged.
  Health passed. Rollback requires restoring the prior current symlink and prior
  dashboard Caddyfile, then recreating only this dashboard service.

## Original Stripe event recovery — live database evidence

All three original verified events are now processed, with null processing errors:

| Event | Stripe event ID | Attempts |
| --- | --- | --- |
| checkout.session.completed | evt_1UCmHdE47mNwFlz1Wp7TRWaF | 1 |
| customer.subscription.created | evt_1UCmHdE47mNwFlz1kotthZsA | 4 |
| invoice.paid | evt_1UCmHeE47mNwFlz1tAbINOqF | 2 |

One active BC Learn subscription, period 2026-09-06T20:03:20Z to
2026-10-06T20:03:20Z; zero cash transactions and zero partner commission entries.
Existing receipt RPC returns `no_payment_required`, checked under service-role
claims in a rolled-back transaction. No user receipt cookie was fabricated.

Clover subscription period fields are now retained from subscription items.
Missing old fields were recovered from the exact original Stripe Event, after
matching its minimized core to the signed stored receipt. One immutable private
supplement was appended; the original provider event was not overwritten.
Invoice normalization accepts Clover's absent legacy `paid` property while
rejecting an explicit false value and retaining the paid-status checks.

Stripe/commercial/metrics queues were empty with zero failed or expired leases;
latest completed worker stages HTTP 200. Scheduler attention remained true due
to its one-hour historical failure window during the repair, not unfinished work.

## Checkout behavior

- Captured email forwarded only for Stripe billing prefill, not attribution.
- Embedded client secret held in component memory, never browser storage or DB.
- Immutable mode/email/no-charge fingerprint protects retries; an open attempt
  retrieves the same existing Stripe session rather than posting another.
- Ordinary completion remains inline; receipt-owned server verification reads
  the exact Stripe session and is independent of reporting workers. Pending and
  transient errors are retried automatically; manual retry is a bounded fallback.
- Missing receipt cookie on the deployed `/api/partner/status` returns 403
  `receipt_unavailable`, not a guessed success.
- The current $0 safeguard, price verification, HMAC binding, signed quote,
  idempotency and cross-funnel checks remain enforced.

## Validation

- Edge lint/format/type checks and 132 tests passed.
- Shared SDK checks and 19 tests passed; 7 funnel UI tests passed.
- Hosted rollback SQL: 68 Clover compatibility assertions; 59 hosted checkout
  regression assertions; 61 embedded-presentation assertions passed before apply.
- Funnel TypeScript, local Next build, final Vercel Next build and Vinext build passed.
- SDK parity: four vendored files and two public contract copies match canonical v1.3.
- Scanned 29 generated client files: no live private-key/private-PEM patterns found.
- Both hosts serve byte-identical HTML, Markdown and OpenAPI copies (HTTP 200).
- Published guide visually inspected in the browser; absolute download links
  prevent Vercel's trailing-slash normalization from breaking downloads.

Canonical guide: https://partners.kissmyapps.dev/developers/funnels/

## Explicit remaining acceptance gaps

No fresh embedded live checkout was created: email prefill, embedding and
automatic completion have automated mock/provider-boundary proof, not a new
live Stripe user acceptance result. Next step is one user-completed checkout
with newly authorized single-use 100%-off-forever capacity.

Apple Pay/Google Pay depend on eligible devices, account configuration and exact
payment-method domain registration. Domain/wallet acceptance was not verified.
A $0 subscription may not display a payment method at all. Positive payment,
commission, refund, payout, app entitlement and real-device wallet acceptance
remain separate gates. No entitlement destination or actual payout was invented.
