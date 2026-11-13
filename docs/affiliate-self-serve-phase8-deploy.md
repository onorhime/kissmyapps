# Affiliate self-serve, Phase 8: deploy steps

## C. Checkout link and promo worker

Three edge functions carry the Stripe side of Phase 8:

- `program-checkout`: a creator's link of a `kma_checkout` program opens
  `https://kissmyapps.dev/checkout/<program>?kma_click=<click>`. The function asks the
  database for the program's product (`program_checkout_target`), starts a Stripe Checkout
  Session on the merchant's own Stripe account (a direct charge: the platform key with the
  `Stripe-Account` header) and answers 303 to Stripe's page.
- `program-promo-worker`: makes each creator's promo code on the merchant's Stripe account
  (a percent-off coupon, one per program and discount, and a promotion code with the
  creator's code) and switches retired codes off.
- `program-sales-worker` (changed): when it reads a payment back, it also reads the promotion
  code the buyer used and passes `promotion_code_id` to `record_program_sale`.

Written and tested locally only, with Stripe and the database stubbed. Nothing here has been
applied to hosted Supabase, the edge Caddy, or tried against real Stripe.

### What ships

| Piece                                                                   | Where                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| Edge function `program-checkout` (new): the checkout link               | `supabase/functions/program-checkout/`                          |
| Edge function `program-promo-worker` (new): coupons and promotion codes | `supabase/functions/program-promo-worker/`                      |
| Promotion code read on sales                                            | `supabase/functions/program-sales-worker/stripe.ts`             |
| Function entries, both `verify_jwt = false`                             | `supabase/config.toml`                                          |
| `kissmyapps.dev/checkout/*` (and `/marketplace`) on the edge Caddy      | `deploy/hostinger/Caddyfile.production`, `Caddyfile.kissmyapps` |
| Route check                                                             | `scripts/tracking-gateway.test.mjs`                             |

It needs Piece A's migration (`program_checkout_target`, `claim_program_promo_codes`,
`finish_program_promo_code`, `record_program_sale` with `promotion_code_id`) applied first.

### Order

1. Apply the Phase 8 migrations (base, A, then the others).
2. Set the function secrets below. Leave both new flags unset.
3. Deploy `program-checkout` and `program-promo-worker`, and redeploy `program-sales-worker`.
4. Store the promo scheduler value in Vault and install the schedule (below).
5. Merge the `kissmyapps.dev` block into the edge Caddy (below).
6. Set `PROGRAM_PROMO_CODES_ENABLED=true`, then `PROGRAM_CHECKOUT_ENABLED=true`.
7. Do the first live check (below).

### Function secrets

| Secret                           | Value                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROGRAM_CHECKOUT_ENABLED`       | `true` to open checkout links. Any other value: every link shows "Checkout is not available right now" and nothing reaches the database or Stripe.               |
| `PROGRAM_PROMO_CODES_ENABLED`    | `true` to make and retire promo codes. Any other value: the worker answers `enabled: false` and touches nothing. Codes wait as `pending`.                        |
| `PROGRAM_PROMO_SCHEDULER_SECRET` | new. A random value of at least 32 characters, used only by the database schedule. Do not reuse another value.                                                   |
| `CONSOLE_CONNECT_STRIPE_SECRET`  | already set in Phase 1: the live platform key. Both functions refuse anything but a live key. It is read only when a session or a code is made and never logged. |
| `INTERNAL_WORKER_SECRET`         | already set. Lets a person run the promo worker by hand (`x-kma-worker-secret`).                                                                                 |
| `PROGRAM_SALES_ENABLED`          | unchanged.                                                                                                                                                       |

The platform reaches each merchant's account through the Standard OAuth connection of Phase 1
(scope `read_write`), which allows Checkout Sessions, coupons and promotion codes. No new
Stripe setting is needed. The Connect payments webhook already sends
`checkout.session.completed`, `payment_intent.succeeded` and `invoice.paid`, so checkout-link
sales reach the sales worker unchanged.

### How the checkout link works

- A person's GET: one Checkout Session, mode `payment` (one-time product) or `subscription`
  (monthly or yearly), with an inline price (`line_items[0][price_data]`: product name,
  amount, currency, `recurring[interval]`). The creator's click goes where the merchant's own
  checkout snippet puts it: `metadata[kma_click]`, `client_reference_id=kma_<click>`, and
  `payment_intent_data[metadata][kma_click]` or `subscription_data[metadata][kma_click]`.
- The creator's active code is applied for the buyer (`discounts[0][promotion_code]`). With
  no code for that click and a program discount, the page offers a code field
  (`allow_promotion_codes`). If Stripe refuses the code (switched off a moment ago), the
  session is made again without it, with the code field.
- The same click within the same minute reopens the same session (Idempotency-Key). A link
  without a click always gets a new session.
- Link previews (Slack, WhatsApp, iMessage and the like), crawlers, prefetches and HEAD get a
  small page with the program name, the product and price, and a "Continue to checkout" link
  (the same address with `go=1`). They never create a session.
- A program that is not live, paused, without a Stripe connection or unknown gets a plain page
  with a link to the marketplace.
- Supabase answers `text/html` from its own domain as `text/plain`, so the function's pages
  read as text at `…supabase.co/functions/v1/program-checkout/…`. The edge Caddy rewrites the
  content type back for `kissmyapps.dev/checkout/*`. The 303 to Stripe works either way.

### Promo codes on Stripe

- Coupon: `percent_off` = the program's discount (10% → `10`, 12.5% → `12.5`),
  `duration=once`, named "10% off". `once` means the discount applies to the first payment
  only: the whole price of a one-time product, and the first invoice of a subscription.
  Renewals are full price.
- Promotion code: `promotion[type]=coupon`, `promotion[coupon]=<coupon>`, `code=<ANNA10>`.
  A code Stripe already has active on that account ends as `code_taken`; other refusals end
  with Stripe's error code, and the database retries up to its attempt limit.
- Retired codes: `active=false`. A code Stripe no longer has counts as switched off.
- A coupon deleted in the merchant's Stripe dashboard is replaced once, automatically.
- A refused platform key (401) stops the run; claimed codes are left for the next claim.

### Schedule

The promo worker has no nudge. It runs once a minute from the database schedule, like the
sales and balance workers, but with no tick function in a migration: the cron job calls the
function directly.

1. Put the same value as `PROGRAM_PROMO_SCHEDULER_SECRET` in Vault under the name
   `kma_program_promo_scheduler`:

   ```sql
   select vault.create_secret('<the value>', 'kma_program_promo_scheduler');
   ```

2. Look in `cron.job` for the name `kma-program-promo-codes`. If it is absent, install it
   (the URL names the production project, like the other schedules):

   ```sql
   select cron.schedule(
     'kma-program-promo-codes', '* * * * *',
     $job$
     select net.http_post(
       url := 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-promo-worker',
       body := '{}'::jsonb,
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-kma-scheduler-secret', s.decrypted_secret),
       timeout_milliseconds := 80000)
     from vault.decrypted_secrets s
     where s.name = 'kma_program_promo_scheduler' and length(s.decrypted_secret) >= 32
     $job$
   );
   ```

   While `PROGRAM_PROMO_CODES_ENABLED` is not `true` each call answers `enabled: false` at
   once. An idle run is one claim call.

To pause: `select cron.unschedule('kma-program-promo-codes');` or unset the flag. Codes wait.

To run once by hand:

```sh
curl -s -X POST -H "x-kma-worker-secret: $INTERNAL_WORKER_SECRET" \
  https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-promo-worker
# {"status":"processed","worker":"program-promo-worker","enabled":true,"claimed":…,"made":…,"deactivated":…,"errors":…,"gave_up":…}
```

### Edge Caddy: `kissmyapps.dev/checkout/*`

The checkout address is on the main domain, like the marketplace's invite links. The edge
Caddy files now carry a `kissmyapps.dev` block with both: `/checkout/*` (GET and HEAD) is
rewritten to `/functions/v1/program-checkout{uri}` on the production Supabase project, and
`/marketplace`, `/marketplace/*` and the dashboard's root files go to the dashboard container,
as `docs/affiliate-self-serve-phase3-edge.md` describes. Its last answer is a 404 placeholder.

Merge by hand as `deploy/hostinger/README.md` describes (back up, merge, validate with the
installed Caddy, restart only the edge container), and first find out what serves
`https://kissmyapps.dev` today (`/terms` and `/privacy` must keep working):

- If this edge Caddy serves it, add the `@checkout` route (and the marketplace route, if Phase
  3's step was not done) to that block and keep what serves the rest of the site last.
- If it is served elsewhere, add the same rule there: proxy `/checkout/*` to
  `https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-checkout/checkout/*` with the
  upstream host, and rewrite a `text/plain` content type to `text/html`. A redirect would
  also work but shows the Supabase address to buyers.

To make `kma-release status` name a missing block, add
`{ "site": "kissmyapps.dev", "contains": ["program-checkout"] }` to `edge.requires` in
`deploy/release.config.json`.

### First live check

With a live `kma_checkout` program on a merchant with a live Stripe connection, a 10% buyer
discount and one active creator:

1. Codes: within a minute of the discount being set, the creator's code is active:

   ```sql
   select code, status, attempts, last_error, stripe_promotion_code_id is not null as on_stripe
   from public.program_promo_codes order by created_at desc limit 5;
   ```

   The merchant's Stripe dashboard shows a "10% off" coupon and the code under Products →
   Coupons.

2. Link preview: `curl -s -A 'Slackbot-LinkExpanding 1.0' 'https://kissmyapps.dev/checkout/<program>'`
   returns the small page (`content-type: text/html`), and the merchant's dashboard shows no
   new Checkout Session.
3. Open the creator's link in a browser: it ends on Stripe's checkout with the product, the
   price and the creator's code already applied. Pay for real.
4. Within a minute or two:

   ```sql
   select match_source, promotion_code_id is not null as with_code,
          click_record_id is not null as matched, amount_minor, currency
   from public.program_sales order by created_at desc limit 3;
   ```

   Expect `match_source = 'promotion_code'`, `with_code = true`, `matched = true`, and the
   commission in the console.

5. Retire: remove the creator from the program. Within a minute the code shows `retired` and
   is inactive in the merchant's Stripe dashboard.

Logs carry outcome codes only (`session_created`, `promotion_code_refused`,
`stripe_unavailable`, `code_taken`, …), never click ids, codes' Stripe ids or the key.
