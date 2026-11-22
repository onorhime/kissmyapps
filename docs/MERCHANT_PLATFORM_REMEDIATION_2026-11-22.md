# Merchant platform remediation and release checks

November 22, 2026. The dashboard and landing changes are local. The Swift, Android and Flutter 1.1.0 distributions are public. The production merchant console still serves dashboard commit `1dd6137` and web SDK 1.2.0. The public npm registry still lists React Native 1.0.0.

## Merchant-to-creator rehearsal

| Step | Evidence |
| --- | --- |
| Create, fund and publish the program | The disposable PostgreSQL fixture created a merchant program, submitted its agreement, recorded a deposit and approved publication using the application’s permission-checked functions. The deposit and provider account were fixtures. |
| Invite and join | In Chrome, a merchant copied the program invitation. A separate creator session opened the intended program, read its agreement, accepted and copied the personal tracking link. The local backend recorded the active membership. |
| Track a sale and refund | A $20 sale from the creator’s TikTok link credited $6 pending. A fully refunded $49 sale displayed $0 commission. The merchant and creator reports agreed with the ledger. Separate suites covered partial refunds, reversed arrival order, duplicate receipts and late attribution. |
| Settle creator earnings | The payout fixture exercised an unsuccessful transfer returning to approved earnings and a successful $14.70 transfer. The partner’s browser showed the corresponding Stripe transfer receipt. No money moved. |
| Resolve a missing commission | The creator submitted an order reference. The merchant answered it on Sales. The creator saw the response under Earnings. The response and duplicate submissions left the ledger intact. |

The browser used the production frontend bundle with isolated authentication and real local SQL functions. Provider confirmation, bank settlement, live emails and an external ad-account connection were outside this rehearsal. [Money-flow assertions](../supabase/tests/database/81_program_money_end_to_end.sql) · [Payout assertions](../supabase/tests/database/82_program_payouts.sql)

## Changes ready for release

| Area | Implemented behavior |
| --- | --- |
| Public routes and applications | Merchant invitations and hosted checkout target the partner host. Legacy apex invite and checkout links preserve query parameters. Release checks exercise the actual routes and surface failures. The pending program survives email confirmation on a different browser. |
| Agreements and payouts | The merchant form, new agreements and creator eligibility use the platform’s pooled minimum per currency. Historical signed terms retain their original hash. Funding status, low-balance notices, excluded commissions and Stripe transfer wording distinguish the stages of payment. |
| Reconciliation | Store purchase and refund retries converge on the same sale, including refund-first delivery. Delayed identity can be retried. A late promo cannot silently reassign approved money. Operations and merchant admins can inspect exceptions. Support replies leave the ledger intact. Older unmatched refunds that lack an amount need provider redelivery or operator review. |
| Analytics and funnels | People and sessions use sort-value cursors with ID tie-breakers. A regression fixture pages through 1,001 tied records. Custom dates use the project time zone and can be shared by URL. CSV exports preserve numeric negatives, report the export cap and restore previous spend rows on undo. Shared funnel edits check the version opened by the editor. A merchant can request a creator-facing journey and an operator can link the decision to a published version. |
| Consent and replay | The web SDK clears queued events, replay retries and attribution on withdrawal. The native candidates clear identity and pending attribution. The web recorder retries transient failures within bounds. The console identifies partial recordings and offers a local masking preview. |
| Creator, partner and operations screens | Searchable creator directory, paged downloadable statements, program notifications, searchable review history, missing-commission inquiries and a program-readiness view. Readiness reports the latest actual click, sale, reward event and qualifying award. |
| Advertising | Meta and TikTok campaign-spend imports support account configuration, credentials, lease/retry handling and currency checks. A merchant backend with permitted network data can associate a report with the exact SDK first-launch identifiers. Apple-signed SKAdNetwork reports remain aggregate. Tests cover duplicate, losing and later-window postbacks. Live advertiser credentials were not used. |
| Public site | Marketplace leads the landing navigation. Merchants and Partners have separate explanations. Integrations has guides for web, React, React Native/Expo, Flutter, Swift, Android, server events, store sales, checkout, consent, ad reporting, server funnels and verification. Listed programs have a share page. Unlisted programs stay out of discovery. |

The landing pages retain the site’s typography, color palette, navigation and mobile menu. Their desktop and phone checks covered all four destinations, the 13 guide anchors and marketplace loading, empty, listing and retry behavior.

## SDK distributions

| Distribution | Status and verification |
| --- | --- |
| Flutter 1.1.0 | Published on pub.dev. The downloaded package passed 45 tests, including delivery to the local ingest service. [Published package](https://pub.dev/packages/kissmyapps/versions/1.1.0) |
| Swift 1.1.0 | Published for Swift Package Manager. A fresh tag checkout passed all 32 tests with the local ingest service. The iOS simulator also passed its suite, with the separately configured delivery test skipped there. [Native release](https://github.com/onorhime/kissmyapps-mobile/releases/tag/1.1.0) |
| Android 1.1.0 | Published through JitPack. The Gradle unit tests and release build passed. The registry POM and AAR were retrieved and the archive was verified. [Published Android artifact](https://jitpack.io/com/github/onorhime/kissmyapps-mobile/1.1.0/kissmyapps-mobile-1.1.0.pom) |
| React Native / Expo 1.1.0 | Type checks, 35 tests and packaging passed. The verified tarball is in the local dashboard release directory. npm requires account authentication before publishing. [Package registry](https://www.npmjs.com/package/@kissmyappss/react-native) |
| Web and React web 1.2.1 | Both use the same script distribution. The compiled SDK passed Chrome checks for withdrawal with queued data, reload, renewed consent and masking. It ships through the dashboard release. [Dashboard release process](RELEASING.md) |

## Release and acceptance

All 3,132 dashboard and integration tests passed. The database harness applied 118 migrations and passed all 96 suites, including 58 merchant-to-creator money-flow assertions and 247 payout assertions. The Edge suite passed 744 runtime tests, formatting, lint and type checks. All 127 operational tests and seven cross-project funnel UI checks passed. The production build and SDK type checks passed. The dashboard build still reports large JavaScript chunks and repository lint has warnings.

Production acceptance still requires the dashboard and landing releases, npm authentication and a designated real-device attribution rehearsal. The financial switch remains under platform-owner control. Actual advertiser billing, a live transfer and receipt in a creator’s bank require separate provider evidence. Apple’s postback signatures and report semantics were checked against its published test vectors. [Apple postback verification](https://developer.apple.com/documentation/storekit/verifying-an-install-validation-postback)
