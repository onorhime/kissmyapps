# Affiliate self-serve, Phase 6: programs that pay per event

Phase 6 lets a program pay creators for events as well as, or instead of, sales. An event is
something a person does on the merchant's site or app that the merchant's KissMyApps analytics
already receives, such as `signup_completed` or `trial_started`. The merchant picks up to five
of them, gives each a name creators read and an amount, and sets a monthly budget. Each reward
is earned once per person, by the creator whose link that person opened last inside the
counting window, and is paid from the merchant's prepaid balance exactly like a sale's
commission: set aside the moment it earns, the creator's after the hold, paid out like any
commission.

Deploy only with the owner, after Phases 1 to 5. Events programs need program money
(`platform_settings.program_money_enabled`); while it is off the form does not offer them,
events are not queued, and nothing is rewarded.

Written and tested locally only. Every database suite runs on a local Postgres, including the
three Phase 6 suites (`84_program_reward_terms.sql`, `85_program_reward_engine.sql`,
`86_program_reward_numbers.sql`) and the whole path from a creator's link to an approved reward
(`87_program_rewards_end_to_end.sql`): a visitor opens the link, the analytics intake stores the
visit and the events as the web SDK sends them, the minute job judges them, the reward and the
KissMyApps fee are set aside, the once-per-person, own-action, daily and monthly rules hold, the
merchant rejects one reward, and after the hold the rest are owed to the creator. Every
front-end reader is tested against answers captured from those real functions. Nothing in this
document has been applied to hosted Supabase.

## What ships

| Piece                                                                            | Where                                                                |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Tables: rewards on programs, awards, the event list, the queue                   | `supabase/migrations/20261119100000_program_rewards_base.sql`        |
| The form, terms, agreement and marketplace card for events and both              | `supabase/migrations/20261119101000_program_reward_terms.sql`        |
| The engine: intake trigger, minute job, reject, the merchant's Rewards page data | `supabase/migrations/20261119102000_program_reward_engine.sql`       |
| Events in every number creators and merchants read                               | `supabase/migrations/20261119103000_program_reward_numbers.sql`      |
| Public marketplace function passes on what a program pays for                    | `supabase/functions/marketplace/`                                    |
| Merchant console: program form, new Rewards page, Creators, Balance, Sales       | `src/merchant/`                                                      |
| Creator dashboard: marketplace, Earnings, Links, Performance                     | `src/features/partner/`                                              |
| Public marketplace pages                                                         | `src/features/marketplace/`                                          |
| Admin app: program review shows rewards and budget                               | `src/features/admin/programs/`, `src/features/admin/api/programs.ts` |

Not changed: the redirect function, the click rule, the sale path for sales programs, payouts,
the legacy money engine and every other edge function. A sales program's agreement and card
read exactly as before.

## Order

1. Phases 1 to 5 must be applied.
2. Apply the four migrations in name order.
3. Install the minute job (below).
4. Deploy the `marketplace` function.
5. Release the builds (dashboard with the creator pages and the public marketplace, merchant
   console, admin app) in any order.

Migrations first. Under an old build the database changes nothing a person can see: every
existing answer keeps its keys and only gains new ones. A new build on an old database: the
program form does not show the Earnings question, the new Rewards page reads "Rewards are not
available yet.", and the creator pages, marketplace and admin review read every program as a
sales program.

## The minute job

The migrations do not schedule it. Check `cron.job` for the name `kma-program-rewards` first; if
it is absent:

```sql
select cron.schedule(
  'kma-program-rewards', '* * * * *',
  'select public.program_rewards_tick(''{}''::jsonb);'
);
```

It judges waiting events (up to its limit per run) and approves reward commissions whose hold
has passed. It does nothing while program money is off. Install it together with the
migrations: the balance worker counts held reward commissions past their hold, so without the
job that worker would be woken every minute.

## What the first migrations do to existing data

- Every program gets `earn_from = 'sales'`, no rewards and no budget. Published programs stay
  valid and their terms are untouched.
- `program_commissions.sale_id` may now be empty, for a reward's commission. Every existing row
  has a sale.
- A trigger is added on `analytics_events`, after insert, for production events only. It looks
  up one key and leaves almost every event alone; it can never stop an event from being stored
  (an error in it is caught).
- Triggers on `affiliate_programs` and `analytics_projects` keep the list of rewarded events in
  step. With no events programs the list is empty.

## Check after deploy

1. As KissMyApps, check program money is on. As a merchant, open Program: the Earnings question
   offers Sales, Events and Both, and Events lists the event names the site already sends.
2. Save an events program with two rewards and a budget, read the agreement (it has a Rewards
   section), publish, and approve it in the admin app, where the review shows the rewards and
   the budget.
3. As a creator, the marketplace card reads "$2.00 per Account created, $5.00 per Trial started"
   and never the budget. Join.
4. Open the creator's link in a private window and sign up on the merchant's site. Within a
   minute the merchant's Rewards page lists it as pending, Balance shows the reward and the fee
   set aside, and the creator's Earnings, Links and Performance count one event.
5. `select public.program_reward_health();` as the service role reports no mismatches, nothing
   failing in the queue and no events out of step.

## The rules

- Once per person: a person earns each reward of a program once. A rejected reward counts as
  used.
- The creator is the one whose link the person opened last, inside the counting window, and who
  was an active member when the event happened. The reward is what that creator's accepted
  terms say.
- Own action: a person with the email of anyone on the creator's account earns nothing.
- Monthly budget, per calendar month (UTC) of the event, with the fee on top. The merchant can
  change it at any time; it is not part of the terms and creators never see it, only that the
  program has used its budget for the month.
- Daily share: one creator can earn at most `platform_settings.program_reward_daily_share_bps`
  of the monthly budget in a UTC day (10% to start), never less than the largest reward.
- Balance: a reward the balance cannot cover earns nothing and pauses the program, as a sale
  does. The next deposit brings it back.
- Hold: a reward waits out the hold of the terms. An event sent late still waits a full hold,
  counted from no earlier than a day before it was judged, so the merchant can always reject it.
- Reject: during the hold the merchant can reject a reward (fake, duplicate, own action, low
  quality, other, with a note). The reward and the fee go back to the balance and the creator
  sees it was taken back.
- A sale of a program that pays for events only earns nothing (`sales_not_rewarded`).

## Roll back

The builds can be rolled back by themselves at any time. To stop rewarding without a rollback,
unschedule the minute job; events keep queuing and wait. To take the database back, unschedule
the job, drop the trigger on `analytics_events` first, then the Phase 6 functions and triggers,
and restore the replaced functions from their Phase 2 to 5 migrations. Awards and reward
commissions are records of money and should be kept.

## Known limits

- Events come only from KissMyApps analytics (the web SDK, the mobile SDKs and server keys).
  Mobile installs (Phase 7), Adapty and RevenueCat (Phase 8) are not rewarded yet.
- The budget is counted by the month the event happened in, so an event sent late counts
  against an earlier month.
- The "a tenth per day" hint on the program form is written for the starting share of 10%.
- The merchant's Rewards page lists the latest awards a page at a time and its creator table
  covers the last 30 days.
- A batch of more than 64 rewarded events in one request passes Postgres's cache of
  savepoints for that transaction; it still works, more slowly.
- Two events racing for the last of a budget are serialised by a lock per program; this is not
  exercised by the suites, which run in one transaction.
