# Affiliate self-serve, Phase 2: deploy steps

Phase 2 lets a merchant set up an affiliate program from the merchant console (`#program`):
one form, a generated agreement, and a first-listing review by KissMyApps in the admin app
(Programs). Once a program is approved, payments on the merchant's connected Stripe account
become verified sales, tied to the creator click when one can be found.

Creators cannot join yet (Phase 3) and no commission or money moves (Phase 4).

Phase 1 must be live first: `docs/affiliate-self-serve-phase1-deploy.md`. Deploy only with
the owner.

## What ships

| Piece                                                        | Where                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Program tables, the visit's creator click column             | `supabase/migrations/20261114100000_affiliate_programs.sql`          |
| Program functions, agreement text, admin review, logo bucket | `supabase/migrations/20261114101000_affiliate_program_functions.sql` |
| Sales from receipts, the worker's functions, the schedule    | `supabase/migrations/20261114110000_program_sales.sql`               |
| Sessions keep the creator click the web SDK sends            | `supabase/migrations/20261114120000_analytics_creator_click.sql`     |
| Edge function `program-sales-worker` (new)                   | reads payments back from Stripe, GET only                            |
| Edge function `connect-payments-webhook` (changed)           | nudges the worker after each receipt                                 |
| Edge function `analytics-ingest` (changed)                   | lets `kma_click` through                                             |
| Web SDK `kma.js` 1.2.0                                       | captures `kma_click`, adds `getClickId()`                            |
| Merchant console                                             | Program page, `src/merchant/screens/Program.tsx`                     |
| Admin app                                                    | Programs review screen, `src/features/admin/programs/`               |

## Order

1. Apply the four migrations, in file order. They switch nothing on: no program exists
   until a merchant saves one, and the sales schedule is created disabled.
2. Deploy `analytics-ingest`, `connect-payments-webhook` and `program-sales-worker`.
3. Release the dashboard build. It carries the merchant Program page, the admin Programs
   screen and `kma.js` 1.2.0.
4. Switch sale tracking on by following `docs/affiliate-self-serve-phase2-sales.md`
   (secrets, Vault secret, the once-a-minute schedule, `PROGRAM_SALES_ENABLED=true`).

Steps 1 to 3 are safe to do before step 4: with sale tracking off, merchants can already
build and publish a program and KissMyApps can review it; receipts keep arriving as in
Phase 1 and wait in the queue.

## Things to check before the first approval

- The storage bucket `program-logos` exists and is public (the migration creates it).
  Upload a logo from the Program page and open its address signed out.
- An Owner or Operations admin signed in with a password can open Programs in the admin
  app. Approval creates an active product and a live default funnel for the program; they
  appear in the admin product list.

## First live check

1. In the merchant console, as a workspace owner with Stripe connected: fill in the Program
   page, read the agreement, press Publish program. The page says it is in review.
2. In the admin app, open Programs and approve it. The merchant page says Live.
3. On the merchant's site, add `kma.js` 1.2.0 and pass the creator tag to Stripe as the
   Program page shows (`kma_click` in the payment's metadata).
4. Open the landing page with `?kma_click=<a 48 character test value>` and make one real
   payment. Within a couple of minutes the Program page's sale tracking line shows the sale.
   It will read as a sale that is not yet matched to a creator: creators and their real
   links arrive in Phase 3.

## Known limits

- One program per workspace.
- The agreement is a plain-English template generated from the form. Have a lawyer read it
  before real creators accept it in Phase 3. The wording is in
  `kma_internal.program_agreement` in the functions migration.
- Commission is described as a share of "every payment"; whether tax is excluded is not
  stated in the agreement and is decided with the money rules in Phase 4.
- Pausing a program does not stop its product or landing page. What a pause means for
  creator links is decided in Phase 3.
- The web SDK remembers a creator click for 30 days, while a program may set an attribution
  window of up to 365 days. Email matching can only see clicks the SDK still remembered.
- See `docs/affiliate-self-serve-phase2-sales.md` for the limits of sale tracking and the
  list of Stripe behaviours that only a live payment can confirm.
