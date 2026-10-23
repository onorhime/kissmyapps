# KissMyApps project audit — 4 September 2026

## Verdict

**Not ready for the first commercial launch.** There is a substantial working foundation, but the newly added agreement workflow has a confirmed production blocker and gaps in its authorization, commercial-term binding, and tests. Fix those before building on top of them with the first paid funnel.

This was an audit, not an implementation or deployment. No application code, database records, production configuration, credentials, or infrastructure were changed. No emails, signatures, tracking clicks, checkout sessions, or payments were generated. This report is the only added workspace file; build/test tools also regenerated ignored local artifacts.

## Scope and evidence

- Checkout: `main`, HEAD `f6b4005`; clean worktree at the start.
- Reviewed React partner/admin flows, auth routing, configuration and signing UI, API mappers, database authorization/history rules, deletion routines, notification delivery, funnel helpers, checkout/webhook boundaries, deployment configuration, and release evidence.
- Read-only inspection of production Supabase `mmyruzjemjecqyivhrgr`, including deployed function bodies, trigger definitions, grants, storage policies, secret digests, migrations, and aggregate state.
- Read-only VPS inspection and public HTTP checks. The dashboard container is healthy, and the active release is `/srv/kissmyapps/releases/20260904T163307Z-product-delete-collapse-90b301b6ad0f`.
- Both dashboard domains return HTTP 200 and reference the same `dashboard-Cut7-0L0.js` bundle as the local build. This checks the served entrypoint/bundle identity, not every deployed file byte.
- **30 local and 30 remote migration versions match**, rather than the 29 in the session summary or 28 in the last release note. Eleven Edge Functions are deployed and marked active.
- Eight relevant deployed SQL function bodies were compared with the latest repository definitions and match, including signing, commission-rule mutation, agreement activation, product deletion, and email notification.

### Current production state

The old-product deletion step is already done: production has no products or agreement documents. Audit logs record three product deletions on 4 September around 16:40 UTC. There are four affiliate records, one active Owner, one active Operations admin, and 12 global sources.

There is currently **no `platform_settings` row**, so the production tracking origin/switch still needs to be saved through the approved Owner setup flow. There are no subscriptions, conversions, commission entries, or payouts. Two private storage objects have no corresponding document or payout-statement reference. Counts were queried as the database `postgres` role with RLS bypass, not inferred from a restricted partner session.

### Checks run

| Check | Result |
| --- | --- |
| `pnpm validate` | Passed: formatting, lint, funnel checks, 597 tests across 44 files, TypeScript and production build |
| Edge Function tests | 51 passed |
| Deno type checks | All 11 function entrypoints passed |
| Deno formatting | Passed |
| Deno lint | Failed: unused `emailFromQuery`, `agreement-notify/index.ts:71` |
| Production dependency audit | No reported production-dependency advisories at audit time |
| Public static safety | Preview statement URL returns 404; dashboard HTML is no-store |
| Database RLS inventory | All public base tables have RLS enabled; this alone does not prove every policy/RPC is correct |
| New database tests | Not executed as a migration/write suite against production; a read-only EXPLAIN confirmed the syntax failure described below |

Supabase's security advisor flags eight security-definer partner views and authenticated security-definer RPCs. The inspected views deny anonymous SELECT, use security barriers, and explicitly scope results by membership. These advisor flags are not, by themselves, evidence of cross-partner disclosure. The signing RPC authorization gap below is a specific issue found by reviewing the actual boundary.

## Prioritized findings

P1 means fix before further commercial onboarding. P2 means a concrete correctness/security/reliability issue to fix before launch. Findings inferred from code paths are distinguished from actions actually exercised in production.

### A01 — P1: Agreement notifications roll back the signing operation

**Confirmed in the deployed database.** The document trigger calls `extensions.http_post(text, text, text, jsonb)`. The only installed function named `http_post` is `net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer)`.

Every relevant document insert or signing-status transition runs this trigger in the same database transaction. The missing-function error is not caught, so recording a signing request, partner signature, or countersignature would roll back. This contradicts the comment that notification failures never block the database mutation. An earlier direct email-delivery test does not prove this trigger path works.

Fix the actual pg_net call and decouple durable notification work from the signature transaction. Verify request → partner signature → countersignature through the real RPCs, not just a direct call to the email endpoint. No signing mutation was attempted during this audit.

Source: [email trigger](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/migrations/20260904191000_agreement_email_triggers.sql:59>).

### A02 — P1: A committed credential is still the live notification credential

**Confirmed by digest comparison, without sending a notification.** The literal secret in the email migration matches both the private database secret and the deployed `AGREEMENT_NOTIFY_SECRET` digest. The endpoint uses this shared secret as its authorization boundary.

Anyone who obtains the repository/history and a valid document ID could request repeated or misleading milestone emails: the handler trusts the supplied milestone and does not compare it with the document's status. This is notification-service authority, not evidence of unrestricted database access or an observed breach. No current documents exist, and no misuse was demonstrated.

Rotate the database and Edge Function values together, remove literal credential provisioning from source, and use deployment-time secret injection. Removing the line alone does not invalidate the credential in Git history. Add event/state validation and replay protection. Rotation was **not** performed in this audit.

Sources: [credential provisioning](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/migrations/20260904191000_agreement_email_triggers.sql:23>), [endpoint authorization](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/functions/agreement-notify/index.ts:292>).

### A03 — P1: Signed terms do not freeze the commission rule that will be used

**Confirmed from matching repository and deployed SQL definitions.** Rules are protected only after the agreement becomes active or historical. A bilaterally signed document can exist while the agreement remains draft/awaiting-signature. During that interval, an admin can supersede the active rule, create and activate a replacement with different amounts, and then activate the agreement using the same signed document.

Activation checks for one supported active rule and a signed document independently; it does not verify that the rule is the one approved with that document. For example, a PDF signed for one commission amount could be paired with a different configured amount without requesting new signatures. This is a technical contract-to-calculation mismatch, not a legal opinion. The email-trigger failure currently blocks normal completion of the signing path; this gap becomes reachable once A01 is fixed.

Freeze the commercial revision when requesting signatures. Bind the document/signatures to the exact agreement and rule revision, and require a new document/signatures when those terms change. Include a stable document-content digest in the evidence model.

Sources: [rule history protection](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/migrations/20260825215958_platform_foundation.sql:1109>), [rule mutation](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/migrations/20260828150000_admin_commercial_configuration.sql:973>), [activation checks](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/migrations/20260904160000_admin_agreement_enriched_response.sql:192>).

### A04 — P2: Partner signing skips password and signing-role checks

**Confirmed from matching deployed SQL.** `partner_sign_agreement_document` checks an authenticated user and active affiliate membership. The membership helper does not check the membership role or password authentication method. Consequently, Finance, Analyst, and Member accounts are treated like Owners for signing, and a non-password authenticated session is not rejected by this RPC.

That differs from the stated password-authenticated signing contract and from the explicit role/password controls on other sensitive actions. Hiding the UI does not enforce this boundary. Again, the broken email trigger currently masks successful completion.

Define who may legally represent the partner, enforce that exact role/authorization on the server, and enforce the intended authentication proof. Test Owner, Operations, partner Owner, Finance, Analyst, Member, recovery-only sessions, paused affiliates, and foreign documents. Do not assume every team member may sign.

Sources: [signing authorization](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/migrations/20260904120000_agreement_signing.sql:141>), [membership helper](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/migrations/20260825215958_platform_foundation.sql:912>).

### A05 — P2: Whole-product deletion fails for important tracking-only cases

**Confirmed from live triggers, foreign keys, and matching deletion function.** The routine attempts to delete events and clicks, but both tables still have unconditional append-only DELETE triggers. A tracking-only product that has collected those records therefore cannot be deleted by this routine.

There is also an independent ordering problem: `products.tracking_only_funnel_id` has an immediate `ON DELETE RESTRICT` reference to its approved funnel, but the routine deletes funnels before clearing that reference or deleting the product. An approved tracking-only product can therefore fail deletion even without traffic.

Successful deletion of empty products is not proof of these cases. The transaction rollback preserves the data; this is an availability/workflow bug, not demonstrated partial data loss. No destructive reproduction was performed.

Choose an explicit policy for retaining/archiving tracking history, or implement a narrowly authorized and audited cleanup path that respects commercial evidence and handles the reference cycle. Do not globally remove append-only protections.

Sources: [deletion order](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/migrations/20260904230000_product_deletion_and_sources.sql:108>), [approved-funnel foreign key](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/migrations/20260901190000_tracking_only_demo_mode.sql:8>).

### A06 — P2: PDF cleanup cannot complete through the current browser permissions

**Confirmed live:** storage has authenticated SELECT/INSERT policies but no DELETE policy. On document-recording failure, the browser calls Storage `.remove()` and ignores the outcome. The attempted cleanup therefore cannot remove the uploaded file through those permissions. Agreement/product deletion also removes document rows without scheduling removal of their Storage objects.

Two orphan objects currently exist. Their exact origin was not established; they are evidence of residue, not proof of which failure created them.

Use a server-authorized cleanup queue that removes only unreferenced, unsigned objects after commit and records failures. Avoid granting broad deletion over signed documents. Handle and expose upload-recording/cleanup failures distinctly.

Sources: [ignored cleanup result](</Users/nobrainer/A1 Global/React/affiliate dashboard/src/features/admin/api/gateway.ts:801>), [document-row deletion](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/migrations/20260904220000_delete_agreement_documents.sql:62>).

### A07 — P2: A partner can sign while the document preview is unavailable

**Source-confirmed UI path; not exercised with a live signature.** A failed signed-URL request leaves “Preparing the document preview…” indefinitely. Signing is disabled only during a signing request, not while the PDF is loading or unavailable. The submit handler checks the typed name but not successful document retrieval. An unresolved download request also has no cancellation/request-identity guard when switching or closing the review.

Show a real loading/error/retry state, prevent accidental signing while the document cannot be retrieved, and bind the displayed PDF response to the active document. Require an explicit acknowledgement of the terms and signing authority. Test failed/expired URLs, slow responses, close/reopen, multiple documents, and keyboard focus restoration. A successful URL fetch is not proof the user read the document; the acknowledgement should be explicit.

Source: [review loading and signing](</Users/nobrainer/A1 Global/React/affiliate dashboard/src/features/partner/live/AgreementSignBanner.tsx:78>).

### A08 — P2: The new database test suite does not prove the new workflows

**Confirmed:** `21_agreement_signing.sql:82` uses `constraint_record.pg_get_constraintdef()`. PostgreSQL interprets that as a function in schema `constraint_record`; a read-only EXPLAIN against production returns `3F000: schema "constraint_record" does not exist`. It should reference the catalog function with the constraint OID.

Tests 21–23 largely check function/column/grant existence, not request/sign/countersign or populated deletion behavior. They use `no_plan()` without a final `finish()`. There is no agreement-notify test file. `pnpm validate` does not run the database or Deno suites, so its green result does not cover the main findings above.

Repair the test SQL and add behavioral, authorization, trigger, failure, and deletion-matrix tests. Keep pure automated tests network-isolated. Do not run the existing database test files blindly against production: they include transaction commits/extension setup. Any production acceptance test needs bounded fixtures, explicit approval for side effects, and safe cleanup.

Sources: [broken assertion](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/tests/database/21_agreement_signing.sql:75>), [validation command](</Users/nobrainer/A1 Global/React/affiliate dashboard/package.json:18>).

### A09 — P2: Agreement email delivery has no application-level recovery or deduplication

**Source-confirmed reliability gap, separate from A01.** The trigger discards the HTTP request identifier. The Edge Function sends to Resend once and returns an error on failure; no application outbox, retry worker, delivery record, idempotency key, or operator resend flow is present. Fixing the function name alone will not provide reliable recovery from timeouts, throttling, or provider outages. Replaying a request can send another email.

Store a unique milestone/recipient job atomically with the document transition, deliver with bounded retries and an idempotency key, and surface exhausted failures. Validate the event against durable evidence rather than trusting the caller's event label. Delayed legitimate milestones need a defined policy when the document has already advanced or been revoked.

Sources: [discarded notification request](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/migrations/20260904191000_agreement_email_triggers.sql:59>), [single send](</Users/nobrainer/A1 Global/React/affiliate dashboard/supabase/functions/agreement-notify/index.ts:255>).

## Additional improvements

- **Email HTML escaping:** `productName` and `partnerName` are interpolated into raw HTML at `agreement-notify/index.ts:170,183,237`, although an `escapeHtml` helper already exists. Public registration names are not restricted to plain text characters. Escape every stored text value before inserting it into HTML. This is markup-injection risk, not a demonstrated browser-script exploit or admin-account compromise.
- **Email audience:** recipients are an unordered first five active members/admins. Explicitly target the authorized signer and intended administrators; handle larger teams and notification preferences deliberately.
- **UI/backend mismatch:** the Add Commission Rule selector includes active agreements (`AgreementSection.tsx:431`), but the database rejects changes to active agreements. Remove that choice or explain the new-version workflow before submit.
- **Web hardening/performance:** public dashboard responses have no Content-Security-Policy header. Existing frame-denial and other headers help, but a tested CSP would add protection. The main bundle is about 925 kB minified / 245 kB gzip; consider separate lazy-loaded admin/partner feature chunks after correctness fixes. Neither observation is proof of a current exploit or unacceptable real-device performance.
- **Documentation drift:** the Hostinger README still names an older active release, the functions README says ten functions, and the latest release evidence says 28 migrations. Update these from verified state and stop treating historical test results as current acceptance evidence.

## Product and payment architecture: what is actually in place

| Stage | Current implementation / remaining boundary |
| --- | --- |
| Product setup | Admin product, HTTPS funnel, sources/campaigns, billing offer, agreement/rules and launch gates exist. No product is configured now. |
| Partner link | Product/partner main link, then source/campaign-specific links. Source identity is saved with the issued link. |
| Redirect | `go` forwards the tracking route; the Edge Function registers an opaque click and appends `kma_click` to the configured funnel URL. Tracking-only ancestry stays non-commercial. |
| Platform attribution | TikTok/Instagram/etc. are configured source labels, not verified social-platform identities. The redirect currently does not parse incoming UTM parameters, `ttclid`, or `fbclid`. Automatic ad-platform attribution must not be claimed from this implementation. |
| Funnel events | A browser helper captures the click and sends allowlisted non-commercial events. Server events require funnel-scoped HMAC configuration. An arbitrary destination can demonstrate a redirect/click, but cannot send landing/session events without integration. |
| Checkout | `checkout-session` already exists and owns Stripe session creation from `{click_id, offer_key}` behind a server-authenticated boundary. The funnel-facing proxy is not yet built/deployed. Do not duplicate the existing checkout/pricing/attribution logic inside the proxy. |
| Payment accounting | Stripe webhook ingestion and normalization/commercial/reconciliation workers exist. Deployment alone does not activate their schedule or prove live accounting. |
| Payouts and product access | Ledger/payout foundations exist; money-transfer operations and the product entitlement API are not proven end to end. A paid Stripe subscription must not be treated as proof that the product app grants access correctly. |

The production secret inventory does not yet contain Stripe live/webhook secrets, funnel HMAC bindings, checkout redirect origins, or the verifier's Admin origin setting. No Supabase cron schema or KissMyApps systemd worker timer was found; an external scheduler was not investigated or verified. These are expected B2/activation tasks, not completed capabilities.

## Recommended next sequence

1. **Repair and secure the agreement boundary:** rotate the notification credential, repair the trigger, bind signed terms to frozen rule/document revisions, enforce signing authorization, and add delivery recovery.
2. **Make the workflow dependable:** fix preview/error handling, scoped storage cleanup, and populated tracking-only deletion behavior. Add regression tests for every finding.
3. **Accept one product through the real UI:** configure origin and product/funnel, create the commercial revision, upload/review/sign/countersign, and confirm immutable evidence plus actual trigger-originated emails. Do not reuse the earlier direct-send proof as acceptance.
4. **Finish B2:** implement the thin funnel-facing checkout boundary, configure approved live Stripe and funnel secrets/origins, verify the billing offer, and enable worker scheduling/alerts.
5. **Perform separately approved commercial acceptance:** click → funnel → checkout → verified webhook → commission, including duplicate delivery, refund/dispute, delayed events and renewal. Verify payout period/reconciliation and entitlement behavior separately before public traffic.

The priority is **correctness before more modules**. A first real product is useful for final integration acceptance, but the urgent fixes above do not require one.

## Verification limits

This audit is not a legal review, penetration-test certification, or full launch sign-off. No authenticated multi-user signing walkthrough, recipient delivery test, refund/payment, complete database regression suite, accessibility screen-reader pass, physical-device pass, disaster-recovery restore, or third-party analytics integration test was run in this turn. Production mutations and credential rotation remain unperformed pending a change request.
