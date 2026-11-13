# Affiliate self-serve, Phase 4 (part two): program payouts deploy steps

Part one ends when a commission is approved: the creator's sum grows, and that money was
collected from the merchant weeks earlier. Part two pays the sum out. A creator connects a
payout account (their own Stripe account, set up inside the creator dashboard). A KissMyApps
admin presses Pay. A worker sends each payout as one Stripe transfer from the KissMyApps
platform account to the creator's account. Nothing is paid by itself.

This sends real money to real bank accounts. Deploy only with the owner.

Written and tested locally only: the two functions against a Stripe and a database that
live in memory. Nothing in this document has been applied to hosted Supabase or tried
against real Stripe. The database functions were written at the same time as the two
functions, to the same written contract; where this document names a database function,
schedule or column, check it against the migration before running it. The section "Only a
live transfer can confirm" lists every Stripe behaviour the code relies on and no local
test can prove.

## What ships

| Piece                                                                                  | Where                                                          |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Tables: payouts, payout items, the two settings                                        | `supabase/migrations/20261117100000_program_payouts_base.sql`  |
| Who can be paid, pay and cancel, the worker's claim / begin / finish, health, schedule | `supabase/migrations/20261117101000_program_payouts.sql`       |
| Edge function `program-payout-account`: the creator's payout account, embedded setup   | `supabase/functions/program-payout-account/`                   |
| Edge function `program-payout-worker`: sends the payouts an admin made                 | `supabase/functions/program-payout-worker/`                    |
| Function entries                                                                       | `supabase/config.toml`, the two `[functions.program-payout-*]` |
| Admin app, Program payouts on the Payouts page                                         | `src/features/admin/program-payouts/`                          |
| Creator dashboard, payout account card and payout list in Program earnings             | `src/features/partner/earnings/`                               |

Reused without a change: the legacy `creator-connect` handler and its Stripe provider
(`supabase/functions/creator-connect/`), the table `external_creator_accounts` and the
functions `reserve_creator_connect_account` and `set_creator_connect_account`, and the
legacy `creator-connect-webhook`. The legacy payout worker, its tables and its switches are
not involved.

Two switches, both off after deploy:

- `PROGRAM_PAYOUTS_ENABLED`, set on the functions, switches the two functions. Off:
  `program-payout-account` answers 503 `program_payouts_disabled`, the worker answers
  `enabled: false`. Neither reads a key, the database or Stripe.
- `platform_settings.program_payouts_enabled`, in the database, is switched by an owner in
  the admin app's Program payouts panel. It needs program money on. Off: no payout can be
  made, the worker is handed nothing, the schedule calls nobody, creators see no payout
  account card.

## Order

1. Part one must be live (`docs/affiliate-self-serve-phase4-deploy.md`).
2. Apply the two migrations, in file order. Payouts are off, so nothing changes for anyone.
3. Check the platform account in Stripe ("Stripe, before anything else" below).
4. Set the function secrets and the console binding (below). Leave
   `PROGRAM_PAYOUTS_ENABLED` unset.
5. Deploy `program-payout-account` and `program-payout-worker`.
6. Make sure the legacy `creator-connect-webhook` receives `account.updated` for the
   console platform's connected accounts (below).
7. Store the scheduler value in Vault and install the schedule (below). It stays paused.
8. Release the dashboard build. Creators see no payout account card yet.
9. Set `PROGRAM_PAYOUTS_ENABLED=true`.
10. In the admin app, Payouts, Program payouts: check the smallest payout (25.00), then
    switch payouts on. Only an admin with the owner role can.
11. Enable the schedule row.
12. Do the first live check (below) before telling any creator.

## Stripe, before anything else

Program money is on the KissMyApps platform's own live Stripe account, the one named by
`CONSOLE_CONNECT_PLATFORM_ACCOUNT`. Creators' payout accounts become connected accounts of
that same platform: a transfer only works between a platform and its own connected account.
Check on that account, in live mode:

- **Connect is set up for accounts the platform controls.** Creator accounts are made with
  no Stripe dashboard of their own, with KissMyApps collecting what Stripe requires and
  liable for negative balances (`controller.requirement_collection=application`,
  `controller.stripe_dashboard.type=none`, `controller.fees.payer=application`,
  `controller.losses.payments=application`), asking for the `transfers` capability only.
  Stripe must allow this platform to create such accounts and to open Account Sessions for
  embedded onboarding.
- **Countries.** From a Canadian platform, creators can be paid in Canada, the United
  States, the United Kingdom, the EEA and Switzerland. That is Stripe's cross-border rule
  for Connect; it has not yet been confirmed with Stripe for this account. Until it is,
  the binding below can be left at its default, which pays creators in Canada only.
- **A balance in the payout currency.** A transfer is paid from what the platform has
  available in that currency; nothing is converted. A program in USD needs USD available on
  the platform, which for a Canadian account means a USD balance. By Stripe's
  documentation, card payments in USD stay USD only when the account can settle in USD (a
  USD bank account); otherwise Stripe converts them to CAD and there is never USD to pay
  from. Look at Balances in the Stripe dashboard after a USD deposit from part one: there
  must be a USD line.
- **The key.** The same live key as part one (`CONSOLE_CONNECT_STRIPE_SECRET`). If it is a
  restricted key it also needs to read the account and its balance, read country
  specifications, read and write connected accounts and Account Sessions, and read and
  write transfers.

## Function secrets

| Name                               | Value                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PROGRAM_PAYOUTS_ENABLED`          | `true` to switch the two functions on. Any other value: off.                                                                                                                   |
| `CONSOLE_CONNECT_PLATFORM_ACCOUNT` | already set in Phase 1: the platform account, `acct_...`. The functions use the binding with this account and nothing else.                                                    |
| `CREATOR_CONNECT_BINDINGS_JSON`    | the legacy list of Stripe platforms creators can connect to. It needs one live entry for the console platform (next section). Entries of other platforms are left as they are. |
| `CONSOLE_CONNECT_STRIPE_SECRET`    | already set in Phase 1: the platform's live key. The console entry names it. Anything but a live key and the entry is treated as absent.                                       |
| `CONSOLE_CONNECT_PUBLISHABLE_KEY`  | new. The platform's live publishable key, `pk_live_...`. The console entry names it; Stripe's embedded onboarding in the browser needs it. It is not confidential.             |
| `CONSOLE_CREATOR_WEBHOOK_SIGNING`  | new. The signing value (`whsec_...`) of the `creator-connect-webhook` endpoint for the console platform (below). The console entry names it; the legacy format requires one.   |
| `PROGRAM_PAYOUT_SCHEDULER_SECRET`  | new. A random value of at least 32 characters, used only by the database schedule. Do not reuse another value.                                                                 |
| `INTERNAL_WORKER_SECRET`           | already set for the other workers. Lets a person call the worker by hand (header `x-kma-worker-secret`).                                                                       |

The names `CONSOLE_CONNECT_PUBLISHABLE_KEY` and `CONSOLE_CREATOR_WEBHOOK_SIGNING` are a
suggestion: the entry says which names it reads, so any name of capital letters, digits and
underscores works.

The two legacy switches:

- `CREATOR_CONNECT_ENABLED`: **not read** by `program-payout-account` or
  `program-payout-worker`. They read the console entry whatever its value. The legacy
  `creator-connect-webhook` does read it: it answers 503 unless it is `true`, so the
  `account.updated` events below need it set to `true`. Setting it also switches the legacy
  `creator-connect` function on for every entry in the list. That function still answers
  only creators with approved external terms on a platform, so a program creator gets
  nothing from it.
- `CREATOR_TRANSFERS_ENABLED`: **not read** and not needed. It lets the legacy payout worker
  send legacy transfers; leave it as it is. Program payouts are sent by their own worker
  under `PROGRAM_PAYOUTS_ENABLED` and the database switch.

`SUPABASE_URL`, the anon key and the service role key are provided by the platform. The
Stripe API version is not a setting: the functions send the pinned version from
`supabase/functions/_shared/stripe-api.ts` (`2026-02-25.clover`).

## The console binding

`CREATOR_CONNECT_BINDINGS_JSON` is one JSON object. Each key is a binding id (letters,
digits, `-` and `_`; for example `console`), each value one platform. The functions pick
the entry whose `platform_account_id` is `CONSOLE_CONNECT_PLATFORM_ACCOUNT` and whose
`livemode` is `true`. There can be only one such entry. If the list already has one, check
it against this table instead of adding a second. If the list is unset today, set it to an
object with this one entry.

| Field                 | Value                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform_account_id` | the value of `CONSOLE_CONNECT_PLATFORM_ACCOUNT`                                                                                                                  |
| `livemode`            | `true`                                                                                                                                                           |
| `secret_env`          | the name `CONSOLE_CONNECT_STRIPE_SECRET` (a name, never the key itself)                                                                                          |
| `publishable_key_env` | the name `CONSOLE_CONNECT_PUBLISHABLE_KEY`                                                                                                                       |
| `webhook_secret_env`  | the name `CONSOLE_CREATOR_WEBHOOK_SIGNING`                                                                                                                       |
| `origin`              | the creator dashboard's origin, for example `https://partners.kissmyapps.dev`. Only this origin may call `program-payout-account`.                               |
| `return_url`          | an https address on that origin. Required by the legacy format and checked, but not used: onboarding is embedded, nobody is sent anywhere.                       |
| `refresh_url`         | another https address on that origin, different from `return_url`. Also unused.                                                                                  |
| `country_policy`      | leave out to pay creators in the platform's own country only. To pay abroad: `{"type": "connect_cross_border", "approval_reference": "<where Stripe said so>"}`. |

`approval_reference` is the owner's word that Stripe allows this platform to pay across
borders: a note of eight characters or more saying where that was confirmed (a Stripe
support ticket, a date and a name). Without it the entry is a configuration error. With
`connect_cross_border`, the countries offered to a creator are Stripe's own list of where a
Canadian platform can send transfers, limited to Canada, the US, the UK, the EEA and
Switzerland.

A wrong entry does not fail silently. The worker answers 503 `configuration_error` and logs
`binding_missing` when there is no usable console entry; `program-payout-account` answers
`{"enabled": false, "bindings": []}` when there is none (or its key is not a live key) and
503 `configuration_error` when the entry is there but malformed.

## Account updates from Stripe

A creator's account can stop being payable long after it was set up (Stripe asks for a new
document, a bank account is closed). The database learns that from `account.updated`
events, which the legacy `creator-connect-webhook` already handles. It must receive them
for the console platform's connected accounts:

- In the live Stripe dashboard of the platform account, add an endpoint (or check the one
  that exists): URL
  `https://<project ref>.supabase.co/functions/v1/creator-connect-webhook?binding_id=<binding id>`,
  events from **connected accounts**, event `account.updated`.
- Put the endpoint's signing value in the function secret the entry's `webhook_secret_env`
  names.
- `CREATOR_CONNECT_ENABLED` must be `true` for that function (see above).

The function also understands `transfer.*` and `payout.*` events, for the legacy system.
They are not needed here. A transfer made for a program payout is not a legacy job; its
events are answered 200 and ignored.

Without this endpoint payouts still work, but the account status in the database is only
refreshed when the creator opens the payout account card and when the worker sends a payout.
The admin page would then show a creator as ready whose account has since been restricted;
pressing Pay would produce a payout that fails with `account_not_ready` a minute later, and
the money would go back to the creator's sum.

## Schedule

The database decides once a minute whether a payout is due and calls the worker only then.

1. Put the same value as `PROGRAM_PAYOUT_SCHEDULER_SECRET` in Vault under the name
   `kma_program_payout_scheduler`:

   ```sql
   select vault.create_secret(
     '<the value>',
     'kma_program_payout_scheduler'
   );
   ```

2. Check the project URL written in `kma_internal.tick_program_payout_schedule()`. Like the
   balance schedule it names the production project and the path
   `/functions/v1/program-payout-worker`.
3. Look in `cron.job` for the name `kma-program-payouts`. If it is absent, install it:

   ```sql
   select cron.schedule(
     'kma-program-payouts', '* * * * *',
     'select kma_internal.tick_program_payout_schedule();'
   );
   ```

4. When the functions are deployed, `PROGRAM_PAYOUTS_ENABLED` is `true` and payouts are
   switched on in the admin app:

   ```sql
   update kma_internal.program_payout_schedule set enabled = true where singleton;
   ```

To call the worker by hand, POST to
`https://<project ref>.supabase.co/functions/v1/program-payout-worker` with the header
`x-kma-worker-secret` carrying the value of `INTERNAL_WORKER_SECRET`, as for the other
workers. It answers counts only: `claimed`, `paid`, `retried`, `failed`, `lease_lost`,
`errors`.

To stop sending without losing anything: disable the schedule row. Payouts already made
stay `approved` (an admin can cancel those) or `processing` and are picked up when the
schedule is enabled again. A payout Stripe was first asked for more than 23 hours ago is
then only looked up, never asked for again.

## First live check

Use people and money of your own: a workspace with a live program and a funded balance, and
a creator account of your own (another sign-in) that joined the program and has approved
earnings in it. The part one live check produces a commission; it is approved when its hold
has passed. Every step moves real money. Choose the smallest amounts that are allowed.

1. Read the operator view. It should show no payouts and `ledger_mismatches: 0`:

   ```sql
   select public.program_payout_health();
   ```

2. As the creator, open Payouts in the creator dashboard. Expect a payout account card in
   the Program earnings panel. Start setup, choose your country, confirm your sign-in when
   asked, and complete Stripe's form inside the page (identity, bank account). Nothing
   leaves the dashboard for a Stripe page. Expect the card to say the account is ready,
   possibly after Stripe has taken a few minutes to verify.
3. Check the row and the Stripe account:

   ```sql
   select status, country, livemode, platform_account_id, connect_account_id is not null as connected,
          transfers_enabled, payouts_enabled, details_submitted, disabled_reason, verified_at
   from public.external_creator_accounts order by created_at desc limit 3;
   ```

   Expect `ready`, `livemode` true and the console platform. In Stripe, Connect, the new
   account has no dashboard of its own and carries `kma_affiliate_id`,
   `kma_platform_account_id` and `kma_account_key` in its metadata.

4. In the admin app, Payouts, Program payouts, as an owner: if the creator's approved sum is
   below the smallest payout, lower the smallest payout for this check (the lowest allowed
   is 1.00) and put it back afterwards. The creator appears under Ready to pay with the
   sum. Check in Stripe that the platform has at least that much available in that
   currency.
5. Cancel first. Disable the schedule row, press Pay and confirm: the payout shows as on
   its way and the creator's sum is zero. Cancel it there. Expect the payout `canceled`,
   one `payout` and one `payout_reversed` entry for it, and the creator under Ready to pay
   again with the same sum. Enable the schedule row.
6. Press Pay again and confirm. Within about a minute the payout is paid. Check:

   ```sql
   select status, amount_minor, currency, attempts, failure_code, first_attempt_at,
          transfer_id, connect_account_id, paid_at
   from public.program_payouts order by created_at desc limit 5;
   select kind, amount_minor, payout_id is not null as of_payout, created_at
   from public.program_creator_entries order by created_at desc limit 5;
   ```

   Expect the newest payout `paid` with `attempts` 1 and a `transfer_id`, and one `payout`
   entry of minus the amount per program.

7. In Stripe, on the platform account: one transfer of exactly that amount and currency to
   the creator's account, with transfer group `program-payout:<payout id>` and
   `kma_job_id` = the payout id in its metadata. On the creator's account: the same amount
   in its balance, then a bank payout on Stripe's own schedule.
8. As the creator: the payout shows as paid, and the paid figure of the program grew by it.
9. Wait three minutes. There is no second transfer, and the worker's log shows no further
   line for this payout.
10. Read `select public.program_payout_health();` again: `ledger_mismatches` 0, nothing
    open.

A refusal cannot be produced on demand in live mode. When the first payout fails or waits,
read its `failure_code` against the tables below and the worker's log for the same payout
id.

If a payout stays `approved`: is the schedule row enabled, does `cron.job` have
`kma-program-payouts`, is `PROGRAM_PAYOUTS_ENABLED` exactly `true`, and what does a call by
hand answer?

## How a payout ends

`program_payouts.status` and `failure_code`. A failed or canceled payout gives the money
back to the creator's sum, once, and an admin can pay again later as a new payout. The
worker says `failed` only when Stripe has no transfer for the payout.

| Status     | Code                   | Meaning                                                                                                                                                         |
| ---------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paid`     |                        | Stripe made the transfer; `transfer_id` is set                                                                                                                  |
| `canceled` |                        | an admin took it back before Stripe was asked                                                                                                                   |
| `failed`   | `account_not_ready`    | the creator has no Stripe account, Stripe no longer shows it to the platform, it is not the creator's own, or it cannot receive money now. Stripe was not asked |
| `failed`   | `currency_unavailable` | the account's country is not one the platform can pay, or the account has neither this default currency nor a bank account in it. Stripe was not asked          |
| `failed`   | `transfer_rejected`    | Stripe refused the transfer for good; Stripe's own code is in the worker's log as `provider_code`                                                               |
| `failed`   | `platform_balance_low` | Stripe refused for too little available and then repeated that stored answer to the next try, which it would do for a day                                       |
| `failed`   | `transfer_not_found`   | Stripe was first asked more than 23 hours ago, so it may not be asked again, and it has no transfer for the payout                                              |

While a payout is open (`approved` or `processing`), `failure_code` says why it is waiting:

| Code                                                          | Waits           | Meaning                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform_balance_low`                                        | 15 minutes      | the platform has less available in that currency than the payout. Stripe is not asked, so the payout stays `approved` and can be canceled. Add funds in that currency; it goes by itself                                         |
| `stripe_unavailable`                                          | 5 to 60 minutes | Stripe gave no clear answer. If it was the transfer itself, the next run looks it up before anything else                                                                                                                        |
| `stripe_key_refused`, `funding_platform_mismatch`, and others | 5 minutes       | the run stopped (below); the payout was handed back untouched                                                                                                                                                                    |
| `transfer_evidence_mismatch`, `multiple_provider_objects`     | a day           | Stripe holds a transfer for this payout that is not the amount, currency or account it asked for, or more than one. Never paid and never failed by itself: a person has to look in Stripe                                        |
| `destination_changed`, `destination_missing`                  | a day           | the creator's Stripe account is not the one this payout was first sent to. A person has to look                                                                                                                                  |
| any other code                                                | a day           | the worker met something it has no rule for (the code is the legacy provider's own, for example `provider_request_rejected` for a lookup Stripe refused). A person has to look; each later run starts by looking the transfer up |

A run stops, fails no payout and answers an error when something is wrong that no single
payout is to blame for: the key is refused (`stripe_key_refused`, 503), the key belongs to
another account or mode (`funding_platform_mismatch`, `funding_mode_mismatch`, 503),
Stripe's list of payable countries cannot be read (503), or Stripe is out of reach before
any payout was started (502 `stripe_unavailable`).

What the worker does for each payout it is handed:

1. If Stripe was ever asked for it, look the transfer up first (by transfer group and
   destination, matching `kma_job_id`). Found: `paid`. Not found and more than 23 hours
   since the first ask: `failed`, `transfer_not_found`.
2. Read the creator's account from Stripe and store what it says
   (`set_creator_connect_account`). Not `ready`: `failed`, `account_not_ready`.
3. Compare the amount with what the platform has available in that currency. Too little:
   wait.
4. Check the account can be paid in that currency. If not: `failed`,
   `currency_unavailable`.
5. Tell the database Stripe is about to be asked (`begin_program_payout`: `processing`,
   `first_attempt_at`, the destination, one more attempt), then send one POST with
   `Idempotency-Key: program-payout:<payout id>`.

## What the dashboard is told

`program-payout-account` takes and answers exactly what `creator-connect` does: actions
`status` and `session`, an answer of `enabled`, `bindings` and, for `session`,
`account_session`. Errors use the usual body (`error`, `message`, `request_id`):

| Status | `error`                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_input`, `binding_required`, `country_required`, `country_unavailable`, `empty_body`, `invalid_json`                |
| 401    | `unauthorized`                                                                                                              |
| 403    | `origin_rejected`, `binding_unavailable`, `reauthentication_required`, `mfa_required`                                       |
| 405    | `method_not_allowed`                                                                                                        |
| 409    | `funding_platform_mismatch`, `funding_mode_mismatch`, `connected_account_mismatch`, `embedded_account_incompatible`, others |
| 500    | `internal_error`: also what the legacy handler answers when Stripe cannot be reached or refuses a request                   |
| 503    | `program_payouts_disabled`, `embedded_setup_unavailable`, `configuration_error`, `database_boundary_error`                  |

A creator the database does not allow (not an owner or finance member of their creator
account, no program on the platform, payouts off) gets `{"enabled": true, "bindings": []}`
for `status` and 403 `binding_unavailable` for `session`.

## Privacy

- Identity documents and bank details are entered into Stripe's form and stay at Stripe.
  KissMyApps stores the account id, its country, what Stripe says it can do and the names
  of the requirements that are due.
- When a new account is made, the legacy reservation may pass the creator's confirmed
  email, business type, company name and website to Stripe as a starting point for the
  form, as it does for the legacy system.
- A transfer carries the payout id and nothing about a person.
- Logs carry outcome codes, Stripe's error code for a refusal and payout ids. No account
  id, no amount, no name.

## Only a live transfer can confirm

The local tests use a Stripe that lives in memory. These behaviours of the real one are
relied on and were not confirmed against Stripe:

1. The platform account may create connected accounts with the controller settings above
   and open Account Sessions for them with `account_onboarding`, external account
   collection, and Stripe's own user authentication disabled.
2. Listing the platform's connected accounts (`GET /v1/accounts`, 100 a page) shows an
   account made a moment ago with its metadata. Setup finds an account by its
   `kma_account_key` before it makes one.
3. `GET /v1/country_specs` lists, for Canada, `supported_transfer_countries` that include
   the countries creators are in, and Stripe in fact accepts a transfer from this platform
   to an account in each of them. The cross-border rule (Canada, US, UK, EEA, Switzerland)
   has not been confirmed with Stripe for this account.
4. `POST /v1/transfers` with `amount`, `currency`, `destination`, `transfer_group` and
   `metadata[kma_job_id]` and no `source_transaction` is accepted for a connected account
   whose `transfers` capability is active, and is paid from the platform's available
   balance in that currency.
5. The platform has an available balance in USD at all (see "Stripe, before anything
   else"), and `GET /v1/balance` reports it in `available` with `currency` and `amount`.
   The worker waits when that amount is smaller than the payout. If Stripe pays transfers
   from a part of the balance only (its `source_types`), the worker may ask although the
   usable part is too small; Stripe then refuses and the next point applies.
6. A transfer refused for too little balance answers `error.code` `balance_insufficient`.
   Whether a later POST with the same `Idempotency-Key` is run again or answered with the
   stored refusal (header `Idempotent-Replayed: true`) is not known. Both are handled: run
   again, the payout is paid; replayed, the payout fails with `platform_balance_low` and
   can be paid again as a new payout.
7. A repeated POST with the same `Idempotency-Key` returns the first transfer (24 hours) and
   answers 409 while the first is still running.
8. `GET /v1/transfers?transfer_group=...&destination=...&limit=100` shows a transfer made
   five minutes earlier, with its metadata. The worker uses it to find a transfer whose
   answer was lost; if Stripe did not show it inside the first 23 hours, the worker would
   ask again under the same key (safe, point 7); after 23 hours it would fail the payout
   although the creator was paid.
9. A request with a key Stripe refuses answers 401, a key without permission 403, and an
   account the platform has no access to answers 403 with `error.code` `account_invalid`
   or 404. The worker stops the run for the first two and fails the one payout for the
   third.
10. A connected account in the US with a USD bank account reports `default_currency` or a
    bank account in `usd`, so a USD payout passes the currency check.
11. `account.updated` arrives on an endpoint for connected accounts with the connected
    account in `account`, signed with the endpoint's own value.
12. Money in a creator's Stripe balance is paid to their bank on Stripe's schedule without
    anything further from KissMyApps.

## Known limits

- No currency is converted. A creator is paid only if their Stripe account has the
  program's currency as its default or has a bank account in it. For a USD program that is
  a US creator, or a creator elsewhere with a USD bank account. Others fail with
  `currency_unavailable` and their sum stays with KissMyApps. The admin page does not know
  this before Pay is pressed; `program-payout-account` lists the currencies an account can
  be paid in (`allowed_transfer_currencies`).
- The platform must hold the payout currency. A payout that waits for funds retries every
  15 minutes for as long as it takes; nobody is told except through the admin page.
- A payout is the creator's whole payable sum in one currency. There are no partial
  payouts and no schedule: an admin presses Pay.
- A refund after a payout was made is not taken back from the creator (part one caps a
  clawback at the creator's current sum).
- Stripe's fees for Connect (per active account, per bank payout, cross-border) are paid by
  KissMyApps and are not taken from the creator's sum.
- KissMyApps is liable for a negative balance on a creator's account. Only transfers go
  into these accounts, so a negative balance needs a transfer reversal, which nothing here
  makes.
- A payout that ended `failed` with `transfer_not_found` was judged by one lookup. If Stripe
  did make the transfer and did not list it, the creator was paid and has the money back in
  their sum too. Before paying such a creator again, search Stripe for the transfer group
  `program-payout:<payout id>`.
- A payout left open with `transfer_evidence_mismatch` or `destination_changed` is retried
  once a day and never closes by itself. There is no button for it. After looking in
  Stripe, closing one by hand is a service-role job: `claim_program_payouts` once it is due
  again, then `finish_program_payout` with the lease that hands out.
- Setting up a payout account lists the platform's connected accounts to find an earlier
  one, at most 2,000. Beyond that, setup for a creator without a stored account id fails
  until the legacy lookup is changed. Merchants' connected accounts of the same platform
  count towards the 2,000.
- The account row is shared with the legacy system: a creator who already has a payout
  account on the console platform for legacy settlements uses the same one for programs.
- Switching payouts off, in either place, leaves open payouts as they are. Those in
  `processing` are picked up when it is switched on again; after 23 hours they are only
  looked up.
- One run sends at most 50 payouts and starts none after 40 seconds; the schedule calls
  again a minute later while any is due.
- The schedule function names the production project URL.
