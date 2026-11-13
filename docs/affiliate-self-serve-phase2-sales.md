# Affiliate self-serve, Phase 2: sale tracking deploy steps

Sale tracking turns the payment receipts of Phase 1 into verified sales. For every
successful payment on a connected merchant's live Stripe account, a worker reads the payment
back from Stripe and writes one row in `program_sales`, tied to the creator's click when it
can be. Refunds and disputes update that row. Nothing here calculates a commission or moves
money, and nothing runs until the flag and the schedule below are switched on. Deploy only
with the owner.

Written and tested locally only. Nothing in this document has been applied to hosted
Supabase or tried against real Stripe.

## What ships

| Piece                                                                                                          | Where                                                      |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Queue columns on receipts, `program_sales`, `program_sale_events`, worker functions, tracking status, schedule | `supabase/migrations/20261114110000_program_sales.sql`     |
| Edge function `program-sales-worker`                                                                           | claims receipts, reads Stripe (GET only), records sales    |
| Nudge in `connect-payments-webhook`                                                                            | calls the worker after storing a new receipt               |
| Function entry                                                                                                 | `supabase/config.toml`, `[functions.program-sales-worker]` |

The migration needs `20261114100000_affiliate_programs.sql` (programs) and the Phase 1
migrations to be applied first.

## Order

1. Apply the migration. It adds the queue columns to `merchant_payment_events`; every
   receipt already stored becomes "waiting", but nothing reads the queue yet.
2. Set the function secrets (below). Leave `PROGRAM_SALES_ENABLED` unset.
3. Deploy `program-sales-worker` and redeploy `connect-payments-webhook`.
4. Store the scheduler secret in Vault and install the schedule (below). It stays paused.
5. Set `PROGRAM_SALES_ENABLED=true`, then enable the schedule row.
6. Do the first live check (below).

## Function secrets

| Secret                             | Value                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROGRAM_SALES_ENABLED`            | `true` to switch sale tracking on. Any other value: the worker answers `enabled: false` and reads nothing, and the webhook does not nudge.      |
| `CONSOLE_CONNECT_STRIPE_SECRET`    | already set in Phase 1: the live platform secret key, `sk_live_...`. The worker refuses anything else, including test keys and restricted keys. |
| `CONSOLE_CONNECT_PLATFORM_ACCOUNT` | already set in Phase 1: the platform account, `acct_...`.                                                                                       |
| `INTERNAL_WORKER_SECRET`           | already set for the other workers. The webhook uses it to call the sale worker.                                                                 |
| `PROGRAM_SALES_SCHEDULER_SECRET`   | new. A random value of at least 32 characters, used only by the database schedule. Do not reuse another secret.                                 |
| `STRIPE_API_VERSION`               | unchanged. The worker sends the pinned version from `_shared/stripe-api.ts`.                                                                    |

`SUPABASE_URL` and the service role key are provided by the platform.

## Schedule

The webhook nudges the worker as each receipt arrives. The schedule is the safety net: it
picks up retries, receipts whose nudge was lost, and receipts that waited while the flag was
off. It calls the worker only when a receipt is due.

1. Put the same value as `PROGRAM_SALES_SCHEDULER_SECRET` in Vault under the name
   `kma_program_sales_scheduler`:

   ```sql
   select vault.create_secret('<the value>', 'kma_program_sales_scheduler');
   ```

2. Check the project URL written in `kma_internal.tick_program_sales_schedule()`. It names
   the production project, like the managed checkout schedule does. For any other project
   the function must be changed first.
3. Look in `cron.job` for the name `kma-program-sales`. If it is absent, install it:

   ```sql
   select cron.schedule(
     'kma-program-sales', '* * * * *',
     'select kma_internal.tick_program_sales_schedule();'
   );
   ```

   While the schedule row is disabled the tick only records its own heartbeat and returns
   `paused`.

4. When the worker is deployed and `PROGRAM_SALES_ENABLED` is `true`:

   ```sql
   update kma_internal.program_sales_schedule set enabled = true where singleton;
   ```

To pause: set `enabled = false` on the same row. To stop everything, also unset
`PROGRAM_SALES_ENABLED`. Receipts keep arriving and wait in the queue.

The tick returns one of `locked`, `paused`, `idle` (nothing due), `credential_missing`
(the Vault secret is absent or shorter than 32 characters) or `dispatched`.

## First live check

Do this with a workspace that has a connected live Stripe account and an approved program
(status `live`), on a real payment.

1. Before switching on, read the queue:

   ```sql
   select public.program_sales_health();
   ```

   `queue.due` is the number of receipts waiting. Receipts older than the program's first
   approval are closed as `before_program` and never become sales.

2. Open a creator link of the program, go through to the merchant's checkout and pay for
   real. The checkout must carry the creator tag: `client_reference_id` (`kma_` followed
   by the click id) or `metadata.kma_click`.
3. Within a minute or two:

   ```sql
   select payment_intent_id, amount_minor, currency, fee_minor, fee_currency, status,
          match_source, click_record_id is not null as matched, paid_at
   from public.program_sales order by created_at desc limit 5;
   ```

   Expect one row for the payment, `match_source` of `client_reference_id` or `metadata`,
   and `matched = true`. `fee_minor` can be empty for the first minute; the worker looks
   again up to four times.

4. As the workspace owner, the console's status call should now report the sale:

   ```sql
   select public.workspace_program_tracking('<workspace id>');
   ```

5. Refund part of the payment in Stripe. The sale should turn `partially_refunded` with
   `refunded_minor` set, and one row should appear in `program_sale_events`.
6. Read `select public.program_sales_health();` again. `failed` should be empty and
   `retrying` should drain.

Also worth one try each before relying on them: a subscription checkout (three receipts,
one sale), its first renewal (a second sale with `match_source = 'subscription'`), and a
payment with no tag by a buyer whose email the merchant's app identified through the SDK
(`match_source = 'email'`).

If nothing appears: check that the receipt exists in `merchant_payment_events`, then its
`process_outcome` and `process_error`, then the worker's logs. If every read ends in
`stripe_account_denied`, the platform key cannot read this account's objects and the
connection needs to be made again.

## What a receipt ends as

`merchant_payment_events.process_outcome`, set once per receipt:

| Outcome                                                             | Meaning                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `recorded`                                                          | the sale, refund or dispute was written                                                       |
| `no_program`                                                        | the workspace has no approved program                                                         |
| `before_program`                                                    | the event is older than the program's first approval                                          |
| `connection_inactive`                                               | the Stripe account is no longer connected                                                     |
| `not_paid`, `refund_pending`                                        | Stripe says the payment or refund has not succeeded; a later event covers it                  |
| `no_payment_intent`                                                 | nothing was charged (free order, trial, or a legacy charge without a PaymentIntent)           |
| `no_sale`                                                           | a refund or dispute for a payment that was never recorded as a sale                           |
| `not_live`, `object_mismatch`, `amount_mismatch`, `charge_mismatch` | what Stripe returned did not agree with the signed event; nothing was written                 |
| `invoice_payments_unsupported`                                      | an invoice paid by more than one payment; each payment is still recorded from its own receipt |
| `sale_conflict`, `not_recorded`                                     | the database declined the sale; look at the receipt                                           |
| `failed`                                                            | gave up after 8 attempts; `process_error` holds the last reason                               |

`process_error` while a receipt is being retried: `stripe_unavailable`,
`stripe_account_denied`, `stripe_object_missing`, `stripe_request_rejected`,
`stripe_invalid_response`, `fee_pending`, `sale_pending` (a refund waiting for its payment),
`database_rejected`, `database_unavailable`, `worker_error`. Retries back off from about a
minute to six hours. A failed receipt can also show `lease_expired`: the worker that took
its last attempt never reported back.

`stripe_key_rejected` and `worker_out_of_time` hand receipts back without counting an
attempt. `stripe_key_rejected` means Stripe refused the platform key: the worker stops the
run and answers 503 until the secret is fixed.

To give failed receipts another eight attempts after the cause is fixed:

```sql
update public.merchant_payment_events
set processed_at = null, process_outcome = null, process_attempts = 0,
    process_error = null, next_attempt_at = now()
where process_outcome = 'failed' and received_at > now() - interval '30 days';
```

Recording a sale twice is not possible: a sale is keyed by its Stripe account and
PaymentIntent, and refund and dispute events by their Stripe object and state.

## Privacy

- No name, email, card detail or Stripe payload is stored or logged. Worker logs carry an
  event id, an event type, a code and counts.
- The buyer's email is read from Stripe only to find a creator click when the payment has
  no tag. It is passed to `record_program_sale` as an input and dropped there. Because it
  is a function argument, statement or parameter logging in Postgres (`log_statement`,
  `pgaudit` with parameters) would write it to the database log. Keep those off for the
  service role, or accept that risk knowingly.
- The worker only ever sends GET requests to Stripe, with the connected account in the
  `Stripe-Account` header.

## Known limits

- A sale can change in its first seconds. The three receipts of a subscription checkout
  are processed one by one, so a sale can briefly show no match, or an email match, before
  the receipt that carries the tag is read. Commission should be calculated after the hold
  period, not on first sight.
- A tagged payment is matched to its click whatever the click's age. The attribution
  window is applied only to email matches. Phase 4 decides what a late tagged sale earns.
- Clicks on test-environment links are never matched.
- A tag that does not belong to the program's product is kept on the sale (`click_id`)
  but the sale counts as unmatched (`click_record_id` empty).
- Renewals inherit the creator of the first recorded payment of their subscription. A
  subscription that started before the program was approved has no first sale here, so its
  renewals are recorded unmatched.
- `charge.refunded` updates the refunded total only. The individual refund rows come from
  `refund.created` and `refund.updated`, which Stripe must be sending (they are in the
  Phase 1 event list).
- "Payments seen" on the Connections page still counts receipts, as in Phase 1.
  `workspace_program_tracking` reports the same number as `payments_seen` and the real
  number of sales as `sales`.
- Fees are in the account's settlement currency (`fee_currency`), which can differ from the
  sale's currency.
