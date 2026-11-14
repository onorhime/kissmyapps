# Affiliate self-serve, Phase 4 (part one): deploy steps

Part one is the money a program runs on. A merchant pays into a prepaid balance by card.
Every sale a creator sent takes the creator's commission and the KissMyApps fee out of that
balance at once and holds them. A refund inside the hold gives both back. When the hold has
passed, the commission is the creator's. A balance that cannot cover a commission pauses
the program, so KissMyApps never owes a creator money it has not collected.

Part one does not pay anyone. Paying creators is part two, with its own steps in
`docs/affiliate-self-serve-phase4-payouts.md`; deploy it after this document's live checks
pass. Until payouts are switched on an approved commission is a number the creator sees,
backed by money KissMyApps already holds. Returning a closing merchant's balance is not
built yet.

Phases 1 to 3 must be live first: `docs/affiliate-self-serve-phase1-deploy.md`,
`-phase2-deploy.md`, `-phase3-deploy.md`. This phase charges real cards. Deploy only with
the owner.

## What ships

| Piece                                                              | Where                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Tables: balance accounts, top-ups, commissions, the two ledgers    | `supabase/migrations/20261116100000_program_money.sql`       |
| What a sale earns, the hold, approval, the admin switch            | `supabase/migrations/20261116101000_program_commissions.sql` |
| Deposits, the saved card, automatic top-ups, the Balance page read | `supabase/migrations/20261116102000_program_balance.sql`     |
| Edge functions `program-balance`, `-webhook`, `-worker` (all new)  | `supabase/functions/program-balance*/`                       |
| Merchant console, Balance page                                     | `src/merchant/screens/Balance.tsx`, `#balance`               |
| Creator dashboard, program earnings on Payouts and Marketplace     | `src/features/partner/earnings/`                             |
| Admin app, Program money in platform settings                      | `src/features/admin/settings/ProgramMoneySection.tsx`        |

## Order

1. Apply the three migrations, in file order. Program money is off, so nothing changes for
   anyone: no balance can be opened and no sale earns commission.
2. Follow `docs/affiliate-self-serve-phase4-balance.md` from "Function secrets" to the end of
   "Schedule": secrets, the three functions, the Stripe webhook endpoint on the platform
   account, the Vault value and the schedule. Leave the switches off.
3. Release the dashboard build. The Balance page says payments into the balance are not
   available yet; creators see no earnings panel.
4. Set `PROGRAM_BALANCE_ENABLED=true`.
5. In the admin app, Settings, Program money: check the fee (10%) and the smallest first
   deposit (50.00), then switch program money on. Only an admin with the owner role can.
6. Enable the schedule row (the balance document, "Schedule", step 4).
7. Do the first live check in the balance document, then the one below.

## The rules, in one place

- **Commission.** Worked out on the payment without tax. Percent: the rate of the terms,
  rounded down to the cent. Fixed: the fixed amount, or the whole payment when that is
  smaller. The terms that count are the version the creator had accepted when the sale was
  paid.
- **Fee.** A percentage of the commission, on top, paid by the merchant. 10% unless changed
  in the admin app. A 49.00 sale at 30% takes 14.70 for the creator and 1.47 for
  KissMyApps out of the balance.
- **Hold.** The days in the program's terms (30 unless the merchant chose otherwise),
  counted from the payment. The worker approves what has passed its hold, about once a
  minute.
- **Refunds.** Inside the hold a refund returns commission and fee to the balance in
  proportion. A lost dispute counts as a full refund. After approval the refunded share is
  taken back in full and its fee returns to the balance at once; what the creator has not
  been paid yet covers it first, and anything left (because it was already paid out) is
  taken from the creator's later earnings in the same program and paid back to the balance
  as they arrive ("Refund recovered from the creator's later earnings"). Since
  `20261122104000_program_refund_recovery.sql`.
- **Empty balance.** A sale whose commission and fee the balance cannot cover earns
  nothing, and the program pauses with the reason "balance". Its links keep opening the
  landing page without credit. A deposit or a successful automatic top-up makes it live
  again by itself. Sales made while it was paused are not paid afterwards.
- **Publishing.** With program money on, a program cannot be sent for review or go live
  while its balance is empty. The Program page says to add funds.
- **Deposits.** Card only, on Stripe's hosted page, on the KissMyApps platform account.
  The card is saved for automatic top-ups. Defaults: keep 50.00, add 100.00.
- **Automatic top-up.** Charges the saved card when the balance is under the minimum. A
  failed charge is tried again after 1, 3 and 7 days and then stops. At most five charges
  go through in any 24 hours; the Balance page says when the next one may run.
- **Before the switch.** A sale recorded before program money was switched on is never
  judged. A program that was already live without a balance stays live until its first
  sale, which pauses it; tell those merchants to add funds first.

## Second live check (after the one in the balance document)

Use your own workspace, program and creator account from the Phase 3 live check.

1. With an empty balance, try to publish a second, new program in another workspace of
   your own. Expect "Add funds before you publish."
2. With 50.00 in the first program's balance, make one real payment through the creator's
   link, tagged as the Program page shows. Within a couple of minutes expect: on Balance,
   "Reserved" grew by commission plus fee and two lines in Activity name the creator; on
   the creator's Payouts page, the commission as pending with the day it leaves the hold.
3. Refund that payment in the merchant's Stripe. Expect both amounts back in the balance
   and the creator's line marked returned.
4. Make a second payment and leave it. After the hold it shows as approved on both sides.
   (To see it sooner, publish terms with a hold of 0 days before joining as the creator.)
5. In the admin app, Program money shows what merchants hold and what is owed to creators.
6. Read the health view. `ledger_mismatches` must be 0:

   ```sql
   select public.program_balance_health();
   ```

## Known limits

- Nothing is paid out until part two is deployed and payouts are switched on. A payout is
  made by an admin, so do not tell creators a payout date.
- The agreement text says commission is a share "of every payment"; the code works it out
  on the payment without tax. The agreement template should say so before the first
  merchant goes live (open with the owner's lawyer).
- With program money off, a creator who already has program earnings is shown none.
- A sale that earned nothing because the balance was empty is not paid when funds arrive.
- A refund after approval that is larger than what the creator still has is collected
  only from that creator's later earnings in the same program; if they never earn there
  again, the merchant carries it.
- No emails: a merchant is not told by email that a top-up failed or the program paused,
  and a creator is not told that commission was approved. Both see it on their pages.
- Stripe's processing fee on a deposit is paid by KissMyApps.
- Fourteen Stripe behaviours can only be confirmed by a live payment; they are listed in
  the balance document.
- Nothing here has run against hosted Supabase or real Stripe yet.
