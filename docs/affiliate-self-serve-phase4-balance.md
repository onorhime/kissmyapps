# Affiliate self-serve, Phase 4 (part one): program balance deploy steps

A merchant pays into a prepaid balance for their affiliate program by card, on Stripe's own
hosted Checkout page, on the KissMyApps platform's live Stripe account. The card is saved at
Stripe and can be charged again automatically when the balance falls below a minimum the
merchant chose. Commissions are reserved from this balance (the commission piece). Part one
stops there: no money leaves KissMyApps, there are no payouts and no withdrawals.

This charges real cards. Deploy only with the owner.

Written and tested locally only: the database rules against a local Postgres, the three
functions against a Stripe that lives in memory. Nothing in this document has been applied
to hosted Supabase or tried against real Stripe. The section "Only a live payment can
confirm" lists every Stripe behaviour the code relies on and no local test can prove.

## What ships

| Piece                                                                                      | Where                                                            |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Balance page read, settings, top-up settlement, reversal, claims, event receipts, schedule | `supabase/migrations/20261116102000_program_balance.sql`         |
| Edge function `program-balance`: deposit and card change, each a Stripe Checkout page      | `supabase/functions/program-balance/`                            |
| Edge function `program-balance-webhook`: Stripe events of the platform account             | `supabase/functions/program-balance-webhook/`                    |
| Edge function `program-balance-worker`: automatic top-ups, checks, the commission tick     | `supabase/functions/program-balance-worker/`                     |
| Function entries                                                                           | `supabase/config.toml`, the three `[functions.program-balance*]` |

The migration needs `20261116100000_program_money.sql` (tables) first. The worker calls
`public.program_commissions_tick` from `20261116101000_program_commissions.sql`; if that
function is absent the worker logs `commissions_tick_failed` and still does its own work.

Two switches, both off after deploy:

- `PROGRAM_BALANCE_ENABLED` (function secret): the three functions. Off: `program-balance`
  answers 503 `program_balance_disabled`, the webhook answers 503 (Stripe retries for up to
  three days), the worker answers `enabled: false`.
- `platform_settings.program_money_enabled` (database): program money as a whole. Off: no
  balance can be opened, no deposit started, nothing is claimed for an automatic top-up,
  and the schedule calls nobody. Payments already made are still settled.

## Order

1. Apply the migrations (base, commissions, balance). Nothing runs yet.
2. Set the function secrets (below). Leave `PROGRAM_BALANCE_ENABLED` unset.
3. Deploy `program-balance`, `program-balance-webhook`, `program-balance-worker`.
4. Create the Stripe webhook endpoint (below) and set `PROGRAM_BALANCE_WEBHOOK_SIGNING`.
5. Store the scheduler value in Vault and install the schedule (below). It stays paused.
6. Set `PROGRAM_BALANCE_ENABLED=true`. Check in Stripe that the endpoint's next event is
   answered with 200.
7. Set `platform_settings.program_money_enabled = true`, then enable the schedule row.
8. Do the first live check (below) before telling any merchant.

## Function secrets

| Name                               | Value                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PROGRAM_BALANCE_ENABLED`          | `true` to switch the three functions on. Any other value: off.                                                                                                           |
| `CONSOLE_CONNECT_STRIPE_SECRET`    | already set in Phase 1: the platform's live key, `sk_live_...` (sale tracking accepts nothing else). Test keys are refused (`configuration_error`, 503) before any call. |
| `CONSOLE_CONNECT_PLATFORM_ACCOUNT` | already set in Phase 1: the platform account, `acct_...`. Every balance account stores it; another value cannot touch existing balances (`platform_mismatch`).           |
| `CONSOLE_CONNECT_ORIGIN`           | already set in Phase 1: the console origin, for example `https://merchant.kissmyapps.dev`. Stripe sends the merchant back to `<origin>/#balance?...`.                    |
| `PROGRAM_BALANCE_WEBHOOK_SIGNING`  | new. The signing value (`whsec_...`) of the webhook endpoint created below. Not the value of any other endpoint.                                                         |
| `PROGRAM_BALANCE_SCHEDULER_SECRET` | new. A random value of at least 32 characters, used only by the database schedule. Do not reuse another value.                                                           |
| `INTERNAL_WORKER_SECRET`           | already set for the other workers. Lets a person call the worker by hand (header `x-kma-worker-secret`).                                                                 |

`SUPABASE_URL`, the anon key and the service role key are provided by the platform. The
Stripe API version is not a setting: the functions send the pinned version from
`supabase/functions/_shared/stripe-api.ts` (`2026-02-25.clover`).

## Stripe webhook endpoint

In the live Stripe dashboard of the KissMyApps platform account, add a new endpoint:

- URL: `https://<project ref>.supabase.co/functions/v1/program-balance-webhook`
- Events from: **your account** (not connected accounts). The function refuses events that
  carry a connected account (400 `event_scope_mismatch`).
- API version: `2026-02-25.clover`, the version the functions send.
- Events, exactly these six:
  - `checkout.session.completed`
  - `checkout.session.expired`
  - `payment_intent.succeeded`
  - `payment_intent.payment_failed`
  - `charge.refunded`
  - `charge.dispute.closed`

Copy the endpoint's signing value into `PROGRAM_BALANCE_WEBHOOK_SIGNING`. This is a
different endpoint from the Phase 1 Connect endpoint (`connect-payments-webhook`), which
stays as it is.

The platform account takes other payments too. Events about anything that is not a balance
top-up are answered 200 and ignored without a call to Stripe. A test-mode event is refused
(400 `event_not_live`): it can only arrive if a test-mode endpoint or its signing value was
configured by mistake.

Two Stripe settings to check on the platform account before going live:

- Checkout must not use a custom domain. The function only ever answers addresses on
  `checkout.stripe.com`; with a custom Checkout domain every deposit would end in 502.
- Card payments must be enabled. Checkout is limited to cards.

## Schedule

The worker does three things each run: the commission tick, automatic top-ups, and a check
of open top-ups against Stripe (a deposit whose event never came, an expired page, a charge
whose worker stopped half way). The database decides once a minute whether to call it.

1. Put the same value as `PROGRAM_BALANCE_SCHEDULER_SECRET` in Vault under the name
   `kma_program_balance_scheduler`:

   ```sql
   select vault.create_secret('<the value>', 'kma_program_balance_scheduler');
   ```

2. Check the project URL written in `kma_internal.tick_program_balance_schedule()`. It names
   the production project, like the sale tracking schedule does. For any other project the
   function must be changed first.
3. Look in `cron.job` for the name `kma-program-balance`. If it is absent, install it:

   ```sql
   select cron.schedule(
     'kma-program-balance', '* * * * *',
     'select kma_internal.tick_program_balance_schedule();'
   );
   ```

   While the schedule row is disabled the tick only records its own heartbeat and returns
   `paused`.

4. When the functions are deployed, `PROGRAM_BALANCE_ENABLED` is `true` and program money is
   on:

   ```sql
   update kma_internal.program_balance_schedule set enabled = true where singleton;
   ```

The tick returns one of `locked`, `paused`, `money_disabled`, `idle`, `credential_missing`
(the Vault value is absent or shorter than 32 characters) or `dispatched`. It dispatches at
once when an account is due for a top-up, an open top-up is due for a check or a
commission's hold has passed, and otherwise every five minutes.

To pause charging without stranding payments already made: set `enabled = false` on the
schedule row and, if deposits should stop too, `program_money_enabled = false`. Leave
`PROGRAM_BALANCE_ENABLED` on so that events of payments in flight are still settled.
Unsetting `PROGRAM_BALANCE_ENABLED` makes the webhook answer 503; Stripe retries for up to
three days, after which a payment is only settled by the worker's check once it runs again.

## First live check

Use a workspace of your own with a connected live Stripe account and a program, and a real
card of your own. Every step moves real money; the amounts below are the smallest allowed.

1. Read the operator view. It should show no accounts and `ledger_mismatches: 0`:

   ```sql
   select public.program_balance_health();
   ```

2. On the console's Balance page, as the workspace owner, deposit the minimum (50.00).
   Expect: the browser goes to `https://checkout.stripe.com/...`, the page shows one line
   "Affiliate program balance: <program name>" for 50.00, cards only, and a note about
   automatic top-up above the pay button. Pay. Stripe returns to `#balance?deposit=done`
   and within a few seconds the page shows 50.00 available and the card's brand and last
   four digits.
3. Check the rows:

   ```sql
   select kind, status, amount_minor, currency, checkout_session_id is not null as has_session,
          payment_intent_id is not null as has_payment, failure_code, settled_at
   from public.program_topups order by created_at desc limit 5;
   select kind, amount_minor, available_after_minor, created_at
   from public.program_balance_entries order by seq desc limit 5;
   select event_type, outcome, attempts, processed_at
   from public.program_balance_events order by received_at desc limit 10;
   ```

   Expect one `deposit` top-up `succeeded`, one `deposit` entry of 5000, and two or three
   events: one `credited`, the others `already_settled`.

4. In Stripe: the customer is named after the business and has no email from KissMyApps;
   the PaymentIntent carries `kma_topup_id` in its metadata; the card is saved on the
   customer.
5. Automatic top-up. On the Balance page set the minimum balance to 60.00 and the top-up
   amount to 10.00. Within about a minute expect exactly one new off-session payment of
   10.00 in Stripe, a top-up of kind `auto` with status `succeeded`, and 60.00 available.
   Wait three more minutes and confirm there is no second charge. (A minimum far above the
   balance means one charge per minute until it is reached: choose these two numbers with
   care.)
6. Card change. On the Balance page choose to change the card, enter another card on
   Stripe's page (nothing is charged), return to `#balance?card=done`. Expect the new brand
   and last four digits on the page, and in Stripe the old card removed from the customer.
7. Refund. In Stripe, refund the 10.00 payment. Expect a `deposit_reversed` entry of -1000
   with the note "Card payment refunded", 50.00 available, and the top-up `reversed`.
8. Abandoned page. Start a deposit and close Stripe's page without paying. The Balance page
   shows the deposit as on its way until it is closed: 35 minutes later Stripe expires the
   page, and the top-up becomes `canceled` with `checkout_expired`. Starting another
   deposit in the meantime closes it at once (`superseded`).
9. Read `select public.program_balance_health();` again: `ledger_mismatches` 0,
   `open_topups.due_for_check` 0, `events.unfinished` 0.

A declined card cannot be produced on demand in live mode. When the first real decline
happens, check that the top-up is `failed` with Stripe's decline code, that its
PaymentIntent is `canceled` in Stripe, and that `topup_retry_at` is one day later.

If a deposit does not land: look at the endpoint's deliveries in Stripe (a 400
`invalid_signature` means the wrong signing value), then at `program_balance_events`, then
at the function logs. The worker's check settles a paid deposit about ten minutes after it
was started even if no event ever arrives.

## How a top-up ends

`program_topups.status` and `failure_code`:

| Status       | Code                                    | Meaning                                                                                                   |
| ------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pending`    |                                         | made here; Stripe does not have it yet                                                                    |
| `processing` |                                         | Stripe has a Checkout page or a PaymentIntent for it                                                      |
| `succeeded`  |                                         | Stripe confirmed the exact amount, currency and customer; one `deposit` entry was written                 |
| `reversed`   |                                         | the whole payment was refunded or lost a dispute; `reversed_minor` equals the amount                      |
| `failed`     | Stripe's decline or error code          | an automatic top-up whose card failed; counts towards the retry schedule                                  |
| `failed`     | `authentication_required`               | the card needs its holder; nobody is present for an automatic top-up                                      |
| `canceled`   | `checkout_expired`                      | nobody paid on Stripe's page in time                                                                      |
| `canceled`   | `superseded`                            | the merchant started another deposit                                                                      |
| `canceled`   | `checkout_not_created`, `never_started` | Stripe's page could not be made                                                                           |
| `canceled`   | `never_charged`                         | an automatic top-up for which Stripe has no payment; no failure is counted and the next run starts afresh |
| `canceled`   | `payment_canceled`                      | the PaymentIntent was canceled at Stripe                                                                  |

Decline reasons Stripe asks not to pass on to the payer (`fraudulent`, `lost_card`,
`stolen_card`, `merchant_blacklist`, `pickup_card`, `restricted_card`, `security_violation`)
are stored as `card_declined`.

A failed automatic top-up is retried after 1 day, then 3 days, then 7 days. After the
fourth failure nothing is charged until the merchant makes a deposit or saves a card; both
clear the count.

A top-up that was closed as `failed` or `canceled` is still credited if Stripe later turns
out to have taken its payment. A payment is never credited twice.

A top-up left `processing` with `topup_mismatch` in the logs means Stripe holds a succeeded
payment that is not the amount, currency or customer the top-up asked for. Nothing was
added, the account gets no further automatic top-ups while it is open, and a person has to
look at the payment in Stripe (refund it there if it should not exist). To close the
top-up afterwards, as the service role:

```sql
select public.settle_program_topup(
  '{"topup_id":"<id>","outcome":"canceled","failure_code":"operator_closed"}');
```

## What the console is told

`program-balance` answers `{"checkout_url": "https://checkout.stripe.com/..."}` or the usual
error body (`error`, `message`, `request_id`):

| Status | `error`                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_input`, `invalid_amount_minor`, `empty_body`, `invalid_json`                                                       |
| 401    | `unauthorized`, `verified_email_required`                                                                                   |
| 403    | `origin_rejected`, `not_a_member`, `owner_or_admin_required`                                                                |
| 405    | `method_not_allowed`                                                                                                        |
| 409    | `program_money_disabled`, `no_program`, `balance_not_started`, `currency_mismatch`, `platform_mismatch`, `balance_conflict` |
| 413    | `payload_too_large`                                                                                                         |
| 415    | `unsupported_media_type`                                                                                                    |
| 502    | `stripe_unavailable`, `stripe_rejected`                                                                                     |
| 503    | `program_balance_disabled`, `configuration_error`, `database_boundary_error`                                                |

## Privacy

- No card number, expiry entry or security code ever reaches KissMyApps. Cards are entered
  on Stripe's page. Only the card's brand, last four digits and expiry month and year are
  read back from Stripe and stored.
- The Stripe customer carries the business name of the workspace and three ids in its
  metadata. KissMyApps sends no person's name, email or address. Whatever Stripe's page
  asks the payer for itself stays at Stripe.
- No Stripe payload is stored: an event leaves its id, type, object id and a hash. Logs
  carry outcome codes, event ids and top-up ids only.

## Only a live payment can confirm

The local tests use a Stripe that lives in memory. These behaviours of the real one are
relied on and were confirmed only against Stripe's documentation, not against Stripe:

1. Checkout Session create, API version `2026-02-25.clover`, accepts this set together:
   `mode=payment`, `customer`, `client_reference_id`, `payment_method_types[0]=card`,
   one `line_items[0][price_data]` line, `payment_intent_data[setup_future_usage]=off_session`,
   `payment_intent_data[metadata]`, `payment_intent_data[description]`, `metadata`,
   `custom_text[submit][message]`, `success_url`, `cancel_url`, `expires_at` 35 minutes
   ahead. (`payment_method_types` was removed in `2026-09-30.endive` in favour of
   `allowed_payment_method_types`; the code switches by the pinned version, and the newer
   branch has never met Stripe.)
2. The session's `url` is on `checkout.stripe.com`.
3. Stripe keeps the fragment of `success_url` and `cancel_url`
   (`/#balance?deposit=done`) when it sends the browser back.
4. The PaymentIntent a Checkout page makes carries the `payment_intent_data[metadata]`
   and the `customer`, and after payment its `payment_method`, expanded, names that same
   customer (the card was saved). Without this the page shows no card and automatic top-up
   never runs.
5. Setup mode: `mode=setup` with `customer`, `currency`, `payment_method_types[0]=card` and
   `setup_intent_data[metadata]` is accepted; `checkout.session.completed` carries
   `setup_intent`; the SetupIntent is `succeeded`, carries the metadata, and its payment
   method is attached to the customer.
6. The off-session charge: `POST /v1/payment_intents` with `amount`, `currency`,
   `customer`, `payment_method`, `off_session=true`, `confirm=true`,
   `automatic_payment_methods[enabled]=true`, `automatic_payment_methods[allow_redirects]=never`
   and no `return_url` is accepted and answers `succeeded` at once for a card.
7. A declined off-session charge answers HTTP 402 with `error.code`,
   `error.decline_code` and `error.payment_intent.id`; a card that needs authentication
   answers the same way with `authentication_required`.
8. A PaymentIntent left in `requires_payment_method` after a decline can be canceled, and
   its `last_payment_error` stays readable afterwards.
9. `GET /v1/payment_intents?customer=...&created[gte]=...&limit=100` shows a PaymentIntent
   made five minutes earlier. The worker uses it to find a charge whose answer was lost; if
   Stripe did not show it, the top-up would be closed as `never_charged`, the payment would
   still be credited when its event arrives, and the next run could charge again.
10. A repeated POST with the same `Idempotency-Key` returns the first answer (24 hours) and
    answers 409 while the first is still running.
11. When a Checkout page expires, or is expired through the API, its PaymentIntent can no
    longer be paid.
12. All six event types arrive on an endpoint for "your account" with `livemode: true` and
    without an `account` field, signed with the endpoint's own value, and carry the fields
    read from them: `mode`, `payment_intent`, `setup_intent`, `client_reference_id`,
    `metadata` on a session; `payment_intent` on a charge; `status` and `payment_intent` on
    a dispute.
13. Detaching a replaced card (`POST /v1/payment_methods/{id}/detach`) removes it from the
    customer and nothing else.
14. The live key is allowed to do all of the above on the platform's own account while it
    is also a Connect platform.

## Known limits

- No money leaves KissMyApps in part one: a balance cannot be withdrawn, and a deposit is
  only returned by refunding its card payment in Stripe, which the balance then follows.
- Stripe's processing fee on a deposit is paid by KissMyApps: the balance is credited with
  the full amount charged.
- Automatic top-up has no daily cap. Each run charges an account at most once, for the
  amount the merchant chose; while the balance stays below the minimum the next run charges
  again. The retry schedule only limits failed charges.
- A dispute moves the balance only when it is lost. Stripe withdraws a disputed amount when
  the dispute opens; until it closes the balance is ahead of what KissMyApps holds.
- A refund that later fails or is canceled at Stripe is not put back into the balance.
- Refunds and disputes are handled from their events only. If Stripe gives up delivering
  one (after about three days of failures), nothing notices. Open top-ups, in contrast, are
  checked against Stripe by the worker.
- A balance keeps the currency it had when money was first asked for. If the merchant
  later publishes the program in another currency, deposits are refused
  (`currency_mismatch`) and automatic top-up stops. There is no conversion.
- Amount bounds are the same numbers in every currency: 1000 to 100,000,000 minor units for
  a deposit or top-up amount, with the platform's first-deposit minimum
  (`program_min_deposit_minor`) until the first deposit has landed.
- An unpaid deposit shows as on its way (`pending_topup`) until its page expires after 35
  minutes or another deposit replaces it.
- When a deposit that was started earlier is credited after the merchant saved a different
  card, the earlier deposit's card becomes the saved card again.
- A card replaced while an automatic top-up is under way is not removed from the customer
  at Stripe; it is simply no longer used.
- `program_balance_events` keeps one small row per event of the six types on the platform
  account, including events about other payments. Nothing prunes it.
- The schedule function names the production project URL.
