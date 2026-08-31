# Production backend release evidence — 2026-08-28

Target: Supabase project `mmyruzjemjecqyivhrgr` (`KissMyApps`). This release did
not deploy the dashboard or tracking gateway, edit DNS/Auth URLs, configure a
funnel or Stripe, schedule workers, enable tracking, seed commercial records, or
execute a payout.

## Source identity

The checkout did not yet have a Git `HEAD`. The aggregate SHA-256 over the
deployed migrations, Edge sources/config, web sources, funnel/gateway sources,
package manifests, and TypeScript/Vite configuration was:

`698c58044508e0ea5e6d10461477eec79038f3d5ba6e6660711d27463f30f2c6`

Establish a reviewed commit/tag before the next production release.

## Validation before deployment

- Fresh PostgreSQL 17 replay: all 12 migrations compiled; tests 00–13 passed
  **592/592**.
- Edge Functions: format, lint, ten entrypoint type checks, and **51/51** tests
  passed.
- Web: all **386/386** tests passed. The first two-worker run produced timeout
  noise under unrelated machine load (340 passed); all eight affected files then
  passed **157/157** serially with a 30-second harness timeout.
- Web formatting, lint, funnel-package type/lint checks, TypeScript build, and
  Vite production build passed. Vite retained its non-blocking large-chunk
  warning.
- Linked database dry run listed only migrations `20260828140000` through
  `20260828220000`; seeds and roles were empty.

## Database deployment

The nine reviewed additive migrations were applied with `--skip-vault`. Remote
read-back now matches all 12 local versions exactly:

- `20260825215958_platform_foundation`
- `20260827223000_partner_invitation_activation`
- `20260828110000_admin_product_foundation`
- `20260828140000_tracking_identity_and_main_links`
- `20260828150000_admin_commercial_configuration`
- `20260828160000_billing_and_worker_contract`
- `20260828170000_stripe_normalization_worker`
- `20260828180000_admin_billing_offers`
- `20260828190000_commercial_metrics_reconciliation`
- `20260828200000_stripe_price_verifier_contract`
- `20260828210000_production_abuse_and_funnel_scope`
- `20260828220000_stripe_webhook_payload_minimization`

Linked remote database lint returned no findings. The existing draft `test`
product and QA Partner/Operations identities were preserved; no seed or role file
was applied.

## Edge deployment

The first server-side bundle attempt omitted the explicit import map and failed
before publishing; remote read-back confirmed zero Functions. The corrected
deployment supplied `supabase/functions/deno.json`. These ten Functions are now
`ACTIVE`, version 1, import-map enabled, and `verify_jwt = false` because each has
its own application boundary:

- `tracking-redirect`
- `browser-events`
- `funnel-events`
- `checkout-session`
- `stripe-price-verifier`
- `stripe-webhook`
- `stripe-worker`
- `commercial-worker`
- `metrics-worker`
- `reconciliation-worker`

Unauthenticated/configuration smoke results were intentionally fail-closed:

| Function                                            | Expected result |
| --------------------------------------------------- | --------------- |
| tracking redirect with a nonexistent route          | 404             |
| browser event without configured production origins | 503             |
| funnel event without a valid HMAC                   | 401             |
| Checkout without live Stripe configuration          | 503             |
| Stripe Price verifier with the wrong method         | 405             |
| Stripe webhook without configured signing secret    | 503             |
| each worker without its internal secret header      | 401             |

## Remaining activation gates

- Confirm whether the apex is `kissmyapps.dev` or `kismahub.dev`; then deploy the
  dashboard/gateway and configure exact DNS, hosted Auth, and origin values.
- Supply the real funnel URL/origin and configure one independently generated
  product/funnel-bound HMAC key.
- Supply a live Stripe server key, webhook signing secret, and exact live
  subscription Price; create the allowlisted webhook endpoint at the deployed
  Function URL.
- Approve exact partner commission/payout terms and complete both signatures.
- Approve worker cadence, monitoring/on-call, privacy/retention, and payout
  operating procedure. No worker schedule or transfer rail currently exists.
- Run the full real production journey and keep `tracking_enabled = false` until
  the final controlled activation decision.

See [PRODUCTION_ACTIVATION.md](./PRODUCTION_ACTIVATION.md) for the operating and
rollback sequence.
