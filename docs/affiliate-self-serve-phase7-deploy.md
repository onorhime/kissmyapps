# Affiliate self-serve, Phase 7: programs that pay for app installs

Phase 7 lets a program pay creators when someone installs the merchant's app from their link,
and for what that person later does in the app. It rests on attribution Phase 2 (app
installs and deep links), which ships in the same release: on an app's first launch the
KissMyApps SDK 1.1 asks which smart link brought the install, and the database answers.

How a creator gets credit:

1. The merchant chooses "Your app" as the program's landing page and picks one of their smart
   links. The landing URL is that smart link.
2. A creator's link (unchanged) redirects to it with `kma_click=<creator click>` added. The
   link service keeps that on the smart-link click as `params.creator_click`, then sends the
   phone to the App Store or Google Play as usual.
3. On the app's first launch the install is matched to the smart-link click (Google Play's
   install referrer, a link that opened the app, clipboard handoff on iPhone, or a later
   sign-in after a web visit). A matched install carries the creator click.
4. The rewards engine of Phase 6 pays `app_installed` and later app events by its usual rules,
   finding the creator through the install as well as through sessions.

Deploy only with the owner, after Phases 1 to 6 and after attribution Phases 0 and 1. Events
programs need program money (`platform_settings.program_money_enabled`).

Written and tested locally only. Every database suite runs on a local Postgres, including
`88_attribution_installs.sql` (install matching, open, the sign-in check, the console readers,
a person's install kept when they sign in) and `89_program_app_installs.sql` (the whole path:
a creator's click, the smart-link click with the creator click, `app_installed` ingested, the
real install call matched by the install referrer, the minute job paying $1.50, a later sign-up
paying $2.00, the install call arriving before or after the events, a reinstall and a rejected
install earning nothing). The front-end readers are tested against answers captured from those
functions. Nothing in this document has been applied to hosted Supabase. The SDK native code
(iOS, Android, the React Native native module and the Flutter plugin) has only been compiled
in part here; their CI and real phones must confirm it before 1.1.0 is published.

## What ships

| Piece                                                                                                                        | Where                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Install and re-engagement tables, acquisition on people                                                                      | `supabase/migrations/20261120100000_attribution_installs_base.sql`       |
| Install and link-open matching, sign-in check, console readers                                                               | `supabase/migrations/20261120101000_attribution_install_match.sql`       |
| Creator click on smart-link clicks, install rewards, app links for the form                                                  | `supabase/migrations/20261120102000_program_app_installs.sql`            |
| `POST /v1/attribution/install` and `/open`, Apple Ads exchange                                                               | `supabase/functions/analytics-ingest/`                                   |
| The two paths through the geo relay and Caddy                                                                                | `deploy/geo-relay/`, `deploy/hostinger/Caddyfile.*`                      |
| `kma_click` kept on smart-link clicks, iPhone "Get the app" page                                                             | `deploy/link-service/`                                                   |
| SDKs 1.1.0: iOS, Android, React Native, Flutter                                                                              | `integrations/analytics-mobile/`, `integrations/analytics-react-native/` |
| Console: Attribution setup (SDK, clipboard handoff, Test on your phone), installs in Links and Sources, acquisition on Users | `src/merchant/screens/Attribution*.tsx`, `src/merchant/`                 |
| Console: program form "Your app" landing page, install reward wording                                                        | `src/merchant/screens/Program.tsx`, `ProgramRewards.tsx`, `rewards.ts`   |

Not changed: the tracking redirect, the click rule, sales, payouts, the legacy money engine,
the creator dashboard and the marketplace. An install reward reads like any other reward
("$1.50 per App installed").

## Order

Follow "Attribution, app installs" in `docs/merchant-analytics-deploy.md`, which covers the
three migrations, the `kma-attribution` minute job, the ingest function, the relay, Caddy and
the link service, in that order. Then release the dashboard build (merchant console). Publish
the 1.1.0 SDKs last, with the owner, once their CI is green and a real phone has passed the
checks below.

Under an old build the database changes nothing a person can see. A new build on an old
database reads every program as a web program and every attribution answer without installs.

## What the migrations do to existing data

- `program_reward_awards` may now have the reason `install_rejected`.
- `attribution_record_clicks` keeps `params.creator_click` when it is 48 lowercase hex
  characters; it drops anything else there.
- `kma_internal.analytics_resolve_person` is replaced with the same body plus one call that
  moves a person's install and re-engagements to the signed-in person before the anonymous
  person is merged away.
- No existing program changes: a program is an app program only when its landing URL is one
  of the workspace's active smart links of a project with attribution on and an app.

## Check after deploy

1. As a merchant with attribution on and an Android or iOS app set up, open Program: the
   landing page offers "A web page" and "Your app", and "Your app" lists the smart links.
2. Pick a link, add the reward "App installed (install)" at $1.50, publish, and approve it in
   the admin app.
3. In Attribution → Setup, "Test on your phone": scan the link's QR with a phone that has a
   1.1.0 build of the app, install, open. The three checks turn done: click received, install
   matched, deep link delivered.
4. Join as a creator, open the creator's link on an Android phone without the app, install from
   Google Play and open the app. Within a minute the merchant's Rewards page lists the install
   as pending and the creator's Earnings count it.
5. `select public.program_reward_health();` as the service role reports no mismatches.

## The rules

- Every Phase 6 rule holds: once per person, own action, monthly budget, daily share, balance
  pause, hold, reject.
- An install KissMyApps rejected (the click came after the install began) earns nothing
  (`install_rejected`). A reinstall of the same phone inside the reattribution window earns
  nothing (`already_rewarded`).
- The creator is found through the person's sessions and through their install, by the time
  of the creator's click, so it does not matter whether the install call or the first events
  arrive first.
- When an install is matched after its events were judged (a sign-in an hour later, say), those
  events are judged again.
- iPhone installs are never matched by IP address or device details. Without a link that opened
  the app, Apple Ads, clipboard handoff or a later sign-in, an iPhone install is organic and
  earns no creator anything.

## Roll back

The build can be rolled back by itself. To stop paying for installs, the merchant edits the
program; to stop all matching, unschedule `kma-attribution` and put the previous `@ingest` line
back in Caddy (the SDKs try again on later launches, at most three times). To take the database
back, restore `attribution_record_clicks`, `program_reward_judge`, `program_json`,
`program_state`, `workspace_program_reward_events` and `analytics_resolve_person` from their
earlier migrations and drop the Phase 7 functions. Installs, awards and reward commissions are
records and should be kept.

## Known limits

- iPhone installs from a creator's link are credited only when a link opened the app, the
  person signs in after visiting the website from the link, or the merchant turned on
  clipboard handoff (iOS shows a paste notice). Apple Ads installs name no creator.
- If `app_installed` earns through an earlier web click and the install is later rejected, the
  reward is not taken back automatically; the merchant can reject it during the hold.
- A person's install row is deleted with the person, like every analytics row.
- The React Native native module has no CI build yet; an example-app job would cover it.
- iOS reinstall detection uses `identifierForVendor`, which iOS resets when the last app of the
  developer is deleted; such a reinstall counts as a new install.
