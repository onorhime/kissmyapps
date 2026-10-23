# Local release-gap acceptance — 18 October 2026

All three identified implementation gaps are resolved and locally verified. The code is ready for a controlled deployment with checkout and creator payouts still disabled, subject to release configuration and capacity checks. **Nothing was deployed or enabled. Successful hosted delivery is still unverified.**

| Gap | Change | Local evidence |
| --- | --- | --- |
| Missing managed callback schedule | Separate default-off schedule, authenticated issued runs, durable overlap protection, bounded work, just-in-time delivery leases, safe recovery, existing admin health and operational alerts | Real PostgreSQL concurrency: one owner from six connections; 50 SQL suites passed; worker/alert and health UI tests passed. Cron HTTP transport was stubbed. |
| Merchant email-code mismatch | Full eight-digit input, leading-zero/autofill/paste support, compatible templates and preserved partner links | 28 UI tests; real Supabase Auth rendered both templates and verified fresh/returning users, wrong/expired/consumed codes and resend. Email stayed in a loopback SMTP sink. |
| Callbacks blocked when checkout is closed | Independent default-off incoming callback gate; no outbound checkout credentials required | Actual Next HTTP/SDK/PostgreSQL accepted signed payment/refund evidence with payments off; invalid scopes/signatures rejected, transaction failures retried, duplicates did not create extra captures. |

Both cross-application modes passed **11 checks each**, including pay-first purchases, commission recording, refunds and lost-acknowledgement recovery. These used the real application handlers and SQL with local fake Stripe transport. Both production builds passed. SpeakSix's 33 Marathon suite commands, worker checks and 54 database tests passed; KMA's 308 Edge tests and 26 script tests passed, followed by focused checks for final monitoring changes.

The broad KMA UI run recorded 920 passes and three five-second timeouts under concurrent load. All three timed-out cases passed when rerun with a 15-second allowance. The broad invocation itself exited nonzero; no application change was made to hide those timeouts. Three historical KMA database suites remain documented skips because they depend on named production fixtures.

## Before activation

An approved release must install the pending migrations, updated applications/handlers and email templates; configure the exact owner-created product/funnel/offer, account/mode, distinct webhook secrets, callback bindings and scheduler credential/cron; and verify real hosted TEST delivery and email sign-in. Callback and reconciliation gates can be accepted while public sales and payouts stay off. Recheck VPS capacity before packaging/uploading; no files or images were deleted here. Zoom and live financial activation remain separate acceptance steps.

Details: [readiness record](readiness.json), [merchant cross-app result](crossapp-merchant.json), [platform cross-app result](crossapp-platform.json), [worker checks](../managed-worker-2026-10-18/README.md), [Auth checks](../merchant-auth-2026-10-18/README.md), [SpeakSix callback checks](../../../../Bclearn-Pilot/docs/qa/kma-callbacks-2026-10-18/README.md).
