# Affiliate self-serve, Phase 8: deploy steps

Phase 8 adds four things to the affiliate programs of Phases 1 to 7:

- **A checkout link**: a program can sell one product (name, price, one-time, monthly or
  yearly) through a Stripe Checkout that KissMyApps opens on the merchant's own Stripe
  account. A creator's link opens it with the creator's click on it.
- **Creator promo codes**: a program can give buyers 1% to 90% off. Each active creator then
  gets a code such as `ANNA10`, made on the merchant's Stripe account. A sale that used a
  creator's code goes to that creator, even when another creator's link was clicked first.
- **In-app subscriptions** bought through the App Store or Google Play, reported by
  RevenueCat or Adapty. Commission is paid on the store's proceeds (after the store's cut and
  tax).
- **Amplitude**: matched app installs of identified people are sent to the merchant's own
  Amplitude project as user properties and an event.

Nothing here is live until it is deployed, and every new function is closed by a flag until
it is switched on. Deploy Phase 8 only after Phases 0 to 7, in this order:

1. Apply the four migrations in order: `20261121100000_program_phase8_base.sql`,
   `20261121101000_program_checkout_promo.sql`, `20261121102000_program_store_sales.sql`,
   `20261121103000_analytics_destinations.sql`.
2. Set the new function secrets of sections B, C and D with every flag unset.
3. Deploy `program-checkout`, `program-promo-worker`, `program-store-webhook` and
   `analytics-destinations-worker`, and redeploy `program-sales-worker`.
4. Store the two scheduler values in Vault and install the two schedules (sections C and D).
5. Release the dashboard build (merchant console and creator pages).
6. Merge the `kissmyapps.dev/checkout/*` route into the edge Caddy (section C).
7. Switch the flags on one at a time, each followed by its first live check:
   `PROGRAM_PROMO_CODES_ENABLED`, `PROGRAM_CHECKOUT_ENABLED`, `PROGRAM_STORE_WEBHOOK_ENABLED`,
   `ANALYTICS_DESTINATIONS_ENABLED`.

| Flag                             | Closes                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| `PROGRAM_PROMO_CODES_ENABLED`    | making and retiring promo codes on Stripe (codes wait)     |
| `PROGRAM_CHECKOUT_ENABLED`       | checkout links (the page says checkout is not available)   |
| `PROGRAM_STORE_WEBHOOK_ENABLED`  | RevenueCat and Adapty events (503, nothing stored)         |
| `ANALYTICS_DESTINATIONS_ENABLED` | sending installs to Amplitude (installs wait in the queue) |

## A. Program rules and promo codes

Migration `20261121101000_program_checkout_promo.sql`. No edge function and no secret of its
own: the workers of section C act on what it stores.

What it adds:

- Program fields, saved from the program form, kept in the terms creators accept, written into
  the agreement, shown on the marketplace and in the admin review: `payment_mode`
  (`own_checkout`, the default, or `kma_checkout`), the product of a checkout link
  (`checkout_name`, `checkout_amount_minor`, `checkout_interval`, `checkout_success_url`) and
  `buyer_discount_bps`.
- A checkout-link program's landing page is set by the database to
  `https://kissmyapps.dev/checkout/<program slug>` and cannot be edited. Submitting it for
  review and approving it both need a Stripe connection that can take charges
  (`stripe_charges_disabled` otherwise). A program that pays only for app events cannot have
  a checkout link or a discount.
- Promo codes (`program_promo_codes`): when a program with a discount is published, each
  active creator gets a pending code made from their public name and the percent; a creator
  who leaves has their code retired; a new discount retires every code and makes new ones on
  publish, and creators accept the new terms again. `claim_program_promo_codes` and
  `finish_program_promo_code` hand codes to the promo worker with a 10-minute lease; a code
  Stripe refuses is retried with backoff and marked failed after the fifth try (a code name
  already taken on the merchant's account is renamed, `ANNA10` to `ANNA102`, and tried at
  once). The merchant's program page shows how many codes are ready, being made and failed.
- Sales: `record_program_sale` stores the promotion code a Stripe payment used. A creator code
  of the program that was live at the payment overrides a link tag or an email match, also
  when the code arrives on a later receipt of the same payment. The sale is tied to a click
  on that creator's main link, made once per sale (`program_promo_code_uses`), so commissions
  work unchanged. These clicks count in click numbers.
- `program_checkout_target` gives the checkout function the product, the merchant's account,
  the click and that creator's code.

Known limit: when a payment's code arrives after its commission was already approved (after
the hold), the sale moves to the code's creator but the approved commission stays with the
first one. In practice the receipts of one payment arrive seconds apart and the hold is days.

Existing programs are unchanged: they read as `own_checkout` with no discount and no codes.

## B. Store subscriptions (RevenueCat and Adapty)

A merchant whose app sells subscriptions through the App Store or Google Play connects
RevenueCat or Adapty to one KissMyApps analytics project. The tool then sends its webhook
events to `program-store-webhook`, and a live purchase or renewal of a person a creator brought
becomes a program sale with a commission, the same way a Stripe sale does.

- The console (piece E) calls `workspace_store_connection_create`. KissMyApps answers the
  webhook address and an `Authorization` header value, shown once, and keeps only the SHA-256
  hash of that value. Rotating shows a new value once; removing stops the address answering
  for that connection.
- Each call is hashed by the function and stored once per tool event ID
  (`record_program_store_event`). The person is found in the connection's project by the
  app user ID and aliases the tool sends (user ID, distinct ID, anonymous IDs). The creator is
  found the way the Phase 7 install judge does: the latest creator click of that person's
  sessions or counted/flagged app installs, at or before the purchase, inside the published
  terms' counting window. Renewals follow the creator of the subscription's first payment.
- The commission basis of a store sale is price minus tax minus the store's cut
  (`kma_internal.program_sale_basis`, also used for Stripe sales, where the cut is empty).
- A store refund reverses the commission like a Stripe refund. A cancellation (auto-renew
  turned off) changes nothing.

Written and tested locally only (`91_program_store_sales.sql`, the function's Deno tests with
the database call stubbed). Nothing here has been applied to hosted Supabase or called by real
RevenueCat or Adapty.

### What ships

| Piece                                                                                | Where                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Store connection and receipt tables, `record_program_store_event`, console functions | `supabase/migrations/20261121102000_program_store_sales.sql` |
| Store fee in the commission basis, store renewals' sequence, Sales page keys, health | same migration                                               |
| Edge function (`/revenuecat`, `/adapty`)                                             | `supabase/functions/program-store-webhook/`                  |
| Its `verify_jwt = false` entry                                                       | `supabase/config.toml`                                       |

Console functions (authenticated; reading needs workspace membership, changing needs the
admin role, as for Stripe Connections): `workspace_store_connections(p_workspace_id)`,
`workspace_store_connection_create(p_workspace_id, p_project_id, p_provider)`,
`workspace_store_connection_rotate(p_connection_id)`,
`workspace_store_connection_remove(p_connection_id)`. Each change writes an audit entry
(`program_store_connection_created`, `_rotated`, `_removed`).

### Order

1. Apply the Phase 8 migrations in order (base, A, B, the others). B changes
   `program_sales` (Stripe ids nullable for store sales, `store_fee_minor`) and replaces
   `program_commission_decide`, `program_commission_apply`, `workspace_program_sales` and
   `program_sales_health`.
2. Deploy `program-store-webhook` (the `config.toml` entry turns JWT checks off: the tools send
   no Supabase session). Leave the flag unset.
3. Check that it is closed: a POST to the address answers 503 `program_store_webhook_disabled`.
4. Set `PROGRAM_STORE_WEBHOOK_ENABLED=true`.
5. A merchant connects a tool (below) and makes the first live check.

### Function secrets

| Name                            | Value                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROGRAM_STORE_WEBHOOK_ENABLED` | `true` to accept events. Any other value: every call answers 503 and nothing reaches the database. Adapty's address check on Save then fails as well. |

Nothing else is new: the function uses the service-role client every function already has.
It holds no value of its own; the header values live only as hashes in
`program_store_connections`.

### Webhook address

The console answer carries `webhook_url`, built in one place,
`kma_internal.program_store_webhook_url(provider)`:
`https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-store-webhook/<revenuecat|adapty>`,
the hosted project address the database's schedules already call. If the project moves,
replace that one function. `events.kissmyapps.dev` does not route it.

### How the merchant sets up each tool

Both tools must be told the app's own user ID: the ID the app passes to RevenueCat
(`Purchases.logIn`) or Adapty (`Adapty.identify`, `customer_user_id`) must be the user ID the
app sends to KissMyApps when it identifies the person. A purchase of a person KissMyApps does
not know is stored as `unmatched_person` and never paid.

RevenueCat (https://www.revenuecat.com/docs/integrations/webhooks):

1. KissMyApps console: Connections, in-app subscriptions, pick the app's analytics project,
   RevenueCat. Copy the address and the header value (shown once).
2. RevenueCat dashboard: Project, Integrations, Webhooks, "Add new configuration". Webhook URL:
   the address. Authorization header value: the value exactly as shown, `Bearer ` included.
   Environment: Production (sandbox events are stored as ignored anyway). App: the apps of that
   analytics project. Events: all, or at least initial purchases, renewals, non-renewing
   purchases and cancellations.
3. Save. RevenueCat retries a call that does not get 200 five times over about 80 minutes.

Adapty (https://adapty.io/docs/set-up-webhook-integration):

1. KissMyApps console: the same, picking Adapty.
2. Adapty dashboard: Integrations, Webhook, turn it on. Production endpoint URL: the address.
   Authorization header value for production endpoint: the value exactly as shown (Adapty sends
   it as entered). Leave the sandbox fields empty.
3. Save. Adapty sends `{}` to check the address; the function answers 200 without reading the
   database, so the flag must be on first.

### What counts

| Outcome (`program_store_events.outcome`) | When                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `sale`                                   | Live purchase or renewal with a price, of a known person a creator brought: a program sale. |
| `sale_exists`                            | The same store transaction already made a sale (another event ID).                          |
| `refund` / `ignored_no_sale`             | A refund of a store sale (commission reversed) / of a transaction that made no sale.        |
| `cancellation`                           | Auto-renew turned off. Nothing changes.                                                     |
| `ignored_sandbox`, `ignored_type`        | Sandbox or test store; any other event type (trials, expirations, billing issues, …).       |
| `ignored_free`, `ignored_store`          | No price (a trial start); a Stripe purchase made through the tool (Stripe Connect sees it). |
| `unmatched_program`                      | The workspace has no live or paused program, or the purchase is older than its publishing.  |
| `unmatched_person`, `unmatched_creator`  | No person with that ID in the project; the person has no creator click inside the window.   |

Currency: a sale is stored in the purchase currency, except that when it differs from the
program currency, the program is in USD and the tool sent USD figures, the USD price and
proceeds are used. Any other mismatch records the sale with commission reason
`currency_mismatch`.

Fields read: RevenueCat `event.id, type, app_user_id, original_app_user_id, aliases,
environment, store, product_id, transaction_id, original_transaction_id, purchased_at_ms,
currency, price, price_in_purchased_currency, tax_percentage, commission_percentage,
cancel_reason`; Adapty `event_type, customer_user_id, profile_id, event_datetime` and
`event_properties.profile_event_id, environment, store, vendor_product_id, transaction_id,
original_transaction_id, purchase_date, currency, price_local, price_usd, tax_amount_local,
net_revenue_local, net_revenue_usd, proceeds_local, proceeds_usd`. Nothing else of the body is
kept or logged; logs carry outcome codes, the tool and the event type only.

### First live check

With a live program, one active creator and a connected tool:

1. The creator's link, then install the app from it and sign in (the person is identified with
   the same user ID as in the tool).
2. Buy the subscription for real.
3. Within a minute:

   ```sql
   select e.type, e.outcome, e.environment, e.amount_minor, e.currency
   from public.program_store_events e order by e.received_at desc limit 5;

   select source, store, match_source, amount_minor, tax_minor, store_fee_minor, subscription_sequence
   from public.program_sales where source in ('revenuecat', 'adapty')
   order by created_at desc limit 3;
   ```

   Expect `outcome = 'sale'`, a sale with `match_source = 'app_user'` and sequence 1, and the
   commission in the console. `program_sales_health()` shows the connection under `store`.

4. A sandbox purchase from a test device shows `ignored_sandbox` and no sale.

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

## D. Amplitude

A merchant pastes the API key of an Amplitude project on one KissMyApps analytics project
(console: Connections, Amplitude card, piece E). From then on every matched app install of an
identified person of that project is sent to that Amplitude project once, as two events in one
request:

- an `$identify` that sets the user properties `kma_source`, `kma_campaign`, `kma_method` and
  `kma_creator` (`$set`; `$unset` for those with no value: Amplitude applies user property
  operations only on `$identify`);
- the event `[KissMyApps] Install attributed` at the install's time, with the event properties
  `source`, `campaign`, `method`, `exact`, `platform` and `creator` (the creator's public name
  when a creator's link brought the install, otherwise null).

Sent: production installs that are matched (not organic, not rejected, with a source) of a
person with a user ID. An anonymous person's install is sent when the app identifies them; an
organic install that the minute tick matches at sign-in is sent then. Not sent: development
keys, organic and rejected installs, installs made before the key was saved, anything of a
project without a key. Amplitude receives the app's own user ID and nothing else about the
person.

Written and tested locally only (`92_analytics_destinations.sql`: saving with roles, the queue
fed by the real install, identify and tick functions, claim and finish, retry, failure, pause
on a refused key, removing; the worker's Deno tests with Amplitude stubbed). Nothing here has
called Amplitude or hosted Supabase.

### What ships

| Piece                                                                           | Where                                                           |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Destinations table, job queue, triggers, console and worker functions, schedule | `supabase/migrations/20261121103000_analytics_destinations.sql` |
| The worker that calls Amplitude's HTTP V2 API                                   | `supabase/functions/analytics-destinations-worker/`             |
| Its `verify_jwt = false` entry                                                  | `supabase/config.toml`                                          |

Amplitude: `POST https://api2.amplitude.com/2/httpapi` (US) or
`https://api.eu.amplitude.com/2/httpapi` (EU), a JSON body with the merchant's project key,
the events and `options.min_id_length = 1`, at most 10 events (5 installs) per request, the Free plan's limit
(https://amplitude.com/docs/apis/analytics/http-v2).

### What the migration does to existing data

- Two new tables, both closed to every API role (`analytics_destinations` holds the key;
  `analytics_destination_jobs` is the queue). No existing row changes.
- Triggers on `attribution_installs` (after insert; after an update of the match, verdict or
  person) and on `analytics_people` (after `user_id` goes from empty to set). Each is one
  lookup of the project's destination and does nothing for a project without one; an error in
  it is caught and reported as a warning, so it can never stop an install or an event.

### Order

1. Apply the migration (after the Phase 7 migrations and the Phase 8 base). Nothing is sent:
   no project has a key.
2. Set the function secrets (below). Leave `ANALYTICS_DESTINATIONS_ENABLED` unset.
3. Deploy the worker:

   ```sh
   supabase functions deploy analytics-destinations-worker --project-ref mmyruzjemjecqyivhrgr --no-verify-jwt
   ```

4. Store the scheduler value in Vault and install the schedule (below). It stays paused.
5. Set `ANALYTICS_DESTINATIONS_ENABLED=true`, then enable the schedule row.
6. Release the merchant console with the Amplitude card (piece E). Do the first live check.

### Function secrets

| Name                                      | Value                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ANALYTICS_DESTINATIONS_ENABLED`          | `true` to switch the worker on. Any other value: it answers `{"enabled": false}` and touches nothing.        |
| `ANALYTICS_DESTINATIONS_SCHEDULER_SECRET` | new. A random value of at least 32 characters, used only by the database schedule. Do not reuse another one. |
| `INTERNAL_WORKER_SECRET`                  | already set for the other workers. Lets a person call the worker by hand (header `x-kma-worker-secret`).     |

The worker needs no Amplitude credential of its own: each merchant's key is in the database
and is read only by the worker's claim. It is never logged, and never returned to the console
(which shows its last 4 characters).

### Schedule

1. Put the same value as `ANALYTICS_DESTINATIONS_SCHEDULER_SECRET` in Vault under the name
   `kma_analytics_destinations_scheduler`:

   ```sql
   select vault.create_secret('<the value>', 'kma_analytics_destinations_scheduler');
   ```

2. Check the project URL written in `kma_internal.tick_analytics_destination_schedule()`. It
   names the production project, like the other schedules. For any other project the function
   must be changed first.
3. Look in `cron.job` for the name `kma-analytics-destinations`. If it is absent, install it:

   ```sql
   select cron.schedule(
     'kma-analytics-destinations', '* * * * *',
     'select kma_internal.tick_analytics_destination_schedule();'
   );
   ```

4. When the worker is deployed and `ANALYTICS_DESTINATIONS_ENABLED` is `true`:

   ```sql
   update kma_internal.analytics_destination_schedule set enabled = true where singleton;
   ```

The tick returns `locked`, `paused`, `idle` (no job due, or only jobs of paused destinations),
`scheduler_value_missing` or `dispatched`. It calls the worker only when a job is due.

A job is retried after 1, 2, 4 ... minutes (at most 6 hours; 60 seconds when Amplitude
throttles, an hour for silenced devices) and fails after its 10th attempt. When Amplitude
answers that the key is invalid, the destination is paused (console status `paused`, last error
`invalid_key`) and its jobs wait without using attempts; saving a key again makes it active and
sends them. Events Amplitude refuses are sent one by one and the one at fault fails
(`invalid_event`).

To stop sending: set `enabled = false` on the schedule row (jobs keep waiting) or unset
`ANALYTICS_DESTINATIONS_ENABLED`. A merchant stops their own by removing the key, which drops
what waits for it.

### First live check

Use a project of your own with attribution on, a smart link and an Amplitude project of your
own (its API key: Amplitude, Settings, Projects, the project, General).

1. In the console's Amplitude card, paste the key and choose the region. Expect status
   "active", the key's last 4 characters and nothing sent.
2. On a real phone, open the smart link, install the app (SDK 1.1), and sign in so the app
   sends a user ID. Within two minutes expect in Amplitude, under that user ID, the event
   `[KissMyApps] Install attributed` with the source and method, and the user properties
   `kma_source`, `kma_method` (and `kma_campaign`, `kma_creator` when set).
3. Check the rows:

   ```sql
   select d.status, d.last_sent_at, d.last_error, d.sent_total, d.failed_total
   from public.analytics_destinations d;
   select status, attempts, last_error, finished_at
   from public.analytics_destination_jobs order by created_at desc limit 5;
   ```

   Expect `active`, one job `sent` with 1 attempt.

4. Change one character of the key in the card and install on a second phone: expect status
   "paused" with the last error `invalid_key`, and the job waiting. Paste the right key: the
   job is sent within a minute.
5. Remove the key: the card shows nothing set and the queue is empty for that project.
