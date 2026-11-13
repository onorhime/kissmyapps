# Affiliate self-serve, Phase 3: deploy steps

Phase 3 lets creators in. Anyone can browse live programs on the public marketplace, a
signed-in creator reads a program's agreement and accepts it with one click, and gets a
working link at once (or after the merchant approves, when the merchant chose that). The
merchant sees and manages their creators on a new Creators page in the merchant console.

No commission or money moves yet (Phase 4). Channel links and the creator's Links and
Performance pages for programs come in Phase 5.

Phase 1 and Phase 2 must be live first: `docs/affiliate-self-serve-phase1-deploy.md`,
`docs/affiliate-self-serve-phase2-deploy.md`. Deploy only with the owner.

## What ships

| Piece                                                         | Where                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Membership tables, program links in the link and click rules  | `supabase/migrations/20261115100000_program_membership.sql`       |
| Joining, accepting, leaving, the merchant's creator decisions | `supabase/migrations/20261115101000_program_join.sql`             |
| Edge function `marketplace` (new), public list of programs    | `supabase/functions/marketplace/`                                 |
| Edge function `tracking-redirect` (changed)                   | redirects without credit when a program link cannot be credited   |
| Public marketplace page                                       | `src/features/marketplace/`, served at `/marketplace` on any host |
| Creator dashboard, Marketplace page                           | `src/features/partner/marketplace/`, `#marketplace`               |
| Merchant console, Creators page                               | `src/merchant/screens/Creators.tsx`, `#creators`                  |

## Order

1. Apply the two migrations, in file order. They change nothing for existing links: the old
   admin-issued links keep their rules.
2. Deploy `tracking-redirect` and `marketplace`.
3. Release the dashboard build.
4. Route `kissmyapps.dev/marketplace` to the dashboard and set `MARKETPLACE_ENABLED=true`.
   Both are described, with the checks to run, in `docs/affiliate-self-serve-phase3-edge.md`.

## What must be true before a creator can join

- Platform tracking is switched on with the address `https://go.kissmyapps.dev` (admin app,
  platform settings). Until then joining answers "Links are not available yet" and the
  creator's Marketplace page says so.
- The program is live. A paused program is shown as not taking new creators.
- The creator's account is active and has a name. The account owner accepts; a helper on
  the account can look but not accept.

## How it behaves

- **Accepting is the signature.** The creator ticks one box and presses the button. The
  exact agreement version, its hash, who accepted and the name they accepted under are
  stored in `affiliate_program_acceptances`, which can never be changed or deleted.
- **Approval.** With automatic approval the creator is active immediately and their main
  link is issued. With "I approve each creator" the request waits under "Waiting for you"
  on the merchant's Creators page; Approve issues the link, Decline closes the request.
- **The link.** One main link per creator per program, in the usual form
  `https://go.kissmyapps.dev/<product>/<creator>`. A click sends the visitor to the
  program's landing page with `kma_click`, which Phase 2 ties to the sale.
- **Paused program, creator removed or left.** The link keeps opening the landing page, but
  no click is recorded and nothing is credited. When the cause is gone (program resumed,
  creator approved again or rejoined) the same link credits again.
- **New terms.** When a merchant publishes changed terms, existing creators keep the
  version they accepted and are asked to accept the new one. Their link keeps working
  meanwhile. Which version pays a given sale is decided with the money rules in Phase 4.
- **Invite link.** `https://kissmyapps.dev/marketplace/<slug>` opens the program even when
  it is not listed in the marketplace.
- **Privacy.** A merchant sees a creator's public name, handle, country, channels and
  website. Never an email address or legal name.

## First live check

1. With a live program (Phase 2 first live check), open `https://kissmyapps.dev/marketplace`
   signed out. The program is listed; its page shows the agreement.
2. Press Join program, sign in as a creator, tick the box and accept. The link appears.
3. Open the link in a private window. The landing page opens with `kma_click` in its
   address.
4. In the merchant console open Creators. The creator is listed with one click.
5. Make one real payment from that visit with the tag passed to Stripe as the Program page
   shows. Within a couple of minutes Creators shows one sale for that creator.
6. Pause the program and open the link again: the page opens without `kma_click`.

## Known limits

- No emails yet: a merchant is not told when a creator asks to join, and a creator is not
  told when they are approved. Both see it on their pages.
- The public marketplace is not indexed by search engines (the dashboard's `index.html`
  asks them not to), and a public visitor downloads the same bundle as the dashboard.
- After signing up from a program page, the creator lands back on that program only in the
  same browser.
- A creator can hold one membership per program; a declined or removed creator cannot ask
  again until the merchant approves them from the Ended list.
- If KissMyApps also issued a link by hand for the same creator and product, the program
  reuses that link, and ending the membership switches it off.
- Visitors who arrive through a link that is not being credited are not counted anywhere.
- Nothing here has run against hosted Supabase or the production edge yet.
