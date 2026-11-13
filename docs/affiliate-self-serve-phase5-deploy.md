# Affiliate self-serve, Phase 5: links and results deploy steps

Phase 5 gives every creator in a program one link per channel beside the main link, lets
them add links of their own, and shows the results: the creator's Links and Performance
pages, and the merchant's Creators and Sales pages. The admin setup wizard steps aside for
products that belong to a program.

It moves no money, adds no edge function, no secret and no switch. Deploy only with the
owner, after Phases 1 to 4.

Written and tested locally only. The database side runs on a local Postgres: its own suite
(`83_program_links.sql`) and the whole path from a deposit to a sale through a TikTok link
read on every page (`81_program_money_end_to_end.sql`). Every front-end reader is tested
against answers captured from those real functions (`src/merchant/links-backend.fixture.ts`,
the `*.backend.test.ts` files). Nothing in this document has been applied to hosted Supabase.

## What ships

| Piece                                                                            | Where                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Channel and custom links, the creator's and the merchant's numbers               | `supabase/migrations/20261118100000_program_links.sql`                      |
| Which products belong to a program, for the admin app                            | `supabase/migrations/20261118101000_admin_program_products.sql`             |
| Creator dashboard, Links page                                                    | `src/features/partner/links/`                                               |
| Creator dashboard, Performance page                                              | `src/features/partner/performance/`                                         |
| Merchant console, Creators page (sales, sales amount, commission) and Sales page | `src/merchant/screens/Creators.tsx`, `src/merchant/screens/Sales.tsx`       |
| Admin app: program products marked, their setup sent to Programs                 | `src/features/admin/products/`, `src/features/admin/api/programProducts.ts` |

Not changed: the redirect function, the click rule, commission and payout rules, the legacy
money engine and every edge function.

## What the first migration does to existing data

- Makes two indexes. `clicks_link_occurred` on `public.clicks` is built inside the
  migration's transaction, so writes to `clicks` wait while it builds. Reads carry on. With
  today's click count this is short; apply it at a quiet moment anyway, because a visitor
  who opens a link in those seconds waits for their redirect.
- Gives every member who is active today the six channel links (TikTok, Instagram, YouTube,
  Facebook, X, Newsletter). A link made while its program is paused is stored switched off
  and is switched on by itself when the program goes live again.
- Adds the six channels to `public.sources` where one is missing. Existing rows are left
  alone.
- Replaces `workspace_program_creators`. Every key it had is still there. `clicks` and
  `last_click_at` now count all of a creator's links, and `sales` counts sales that earn
  (see "What the numbers mean").

## Order

1. Phases 1 to 4 must be applied (`docs/affiliate-self-serve-phase4-deploy.md`,
   `docs/affiliate-self-serve-phase4-payouts.md`).
2. Apply `20261118100000_program_links.sql`, then `20261118101000_admin_program_products.sql`.
3. Release the three builds (creator dashboard, merchant console, admin app) in any order.

Migrations first. A database with the functions under an old build changes nothing a person
can see, except that members already have their channel links. A new build on a database
without the functions is mostly quiet (the creator's program Performance page is left out,
the merchant Creators page shows its Phase 3 columns, the admin app treats every product as
it used to), but two places would read as broken: the merchant's new Sales page says the
sales could not be loaded, and a creator with programs only reads "Links are not available
yet."

If a program's links cannot be made during the migration, the migration still finishes and
names the program in a warning. Running `select kma_internal.program_links_sync();` makes
them afterwards.

## Check after deploy

1. Sign in as a creator who is in a live program. Links shows the main link and six channel
   links, all with the address `go.kissmyapps.dev/<program>/<creator>/<channel>`.
2. Open the TikTok address in a private window. It lands on the merchant's page, and after
   a reload Links shows one click on TikTok and none on the main link.
3. Add a custom link, open it once, and see that it can no longer be removed. Add another
   and remove it unopened.
4. Performance shows the same clicks under "By channel" and in the chart for today.
5. As the merchant, Creators shows that creator's clicks, and Sales lists nothing new until
   a real payment comes through the link.
6. In the admin app, Products marks the program's product with "Program" and its Setup
   action reads "Programs".

A sale cannot be checked without a real payment. When the first one arrives through a
channel link, it should be on the creator's Performance page under that channel, on the
merchant's Sales page with the channel named, and in the Creators totals, with the same
commission as the Balance page set aside.

## What the numbers mean

- A click is a visit that is not a bot on any of the creator's live links for the program.
- A sale is a payment credited to the creator whose commission is held or approved. A
  refunded sale and a sale that earned nothing (the balance was empty, the program was
  paused, the payment was in another currency) are listed on the merchant's Sales page with
  the reason and are not counted in any total.
- Earnings are what those commissions are worth now.
- Conversion and earnings per click are worked out from those numbers on the page. With no
  clicks they show a dash.
- Days are calendar days in the creator's time zone (`affiliates.reporting_timezone`, UTC
  when it is not set). The merchant's 30 days are UTC days.
- A sale belongs to the link of the click it came from. A sale matched another way (for
  example by the buyer's email) reads "No link".

## Roll back

The builds can be rolled back by themselves at any time. The migrations are safe to leave in
place under an old build. To take the database back as well, drop the new functions and the
three triggers named in the first migration and restore `workspace_program_creators` from
`20261115101000_program_join.sql`; the channel and custom links are ordinary rows of
`affiliate_links` and can stay, because the click rule credits them exactly as it credits a
main link.

## Known limits

- Leads are not counted. Nothing records a lead for a program yet; they arrive with event
  programs in Phase 6.
- Visits are sorted by the link that was opened, not by the site the visitor came from, and
  query-string tags on a link are not read.
- A creator who also has a product from before programs sees their program links again on
  the older "Links & Sources" section below the new page, and can pause them there.
- The admin Programs page lists the 20 most recently reviewed programs, so the "Programs"
  action on an older program's product opens the list, not that program.
- The admin setup wizard is kept for products that are not a program's (custom deals).
- The creator dashboard has no light theme, so the new creator pages are dark only.
