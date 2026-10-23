# Audit repairs — 5 September 2026

## Status and boundary

**Approved production deployment completed on 5 September.** See
[the production release evidence](RELEASE_EVIDENCE_2026-09-05_AUDIT_REPAIRS.md)
for the deployed identities, credential rotation, maintenance execution and
remaining acceptance gates. This is the repair of the 4 September audit, not
commercial launch approval and not the B2 checkout proxy.

Target remains hosted Supabase `mmyruzjemjecqyivhrgr` and the existing KissMyApps
Hostinger dashboard. No local or staging Supabase was created. The implementation
turn used rollback-only hosted regression checks. The subsequent approved rollout
applied four migrations, rotated the notification credential, deployed the worker
and dashboard, and enabled agreement maintenance. It created no real signatures,
emails or payments, and deleted no objects. The original audit report is preserved.

## Repairs and remaining acceptance

| Finding | Implemented change | Production boundary still open |
| --- | --- | --- |
| A01: notification trigger aborts signing | Signature transactions enqueue durable jobs only. HTTP is moved to a separate dispatcher using `net.http_post`. | Schema, worker and schedule deployed. Real signed-in milestone acceptance remains. |
| A02: source-committed live credential | Removed literal provisioning; worker accepts only an empty authenticated request and leases actual stored milestones. | Database/Edge credential rotated; digests match and retired value returns 401. Historical source still contains the now-invalid old value. |
| A03: signed rule can change | Freeze agreement/rule commercial fields when a request is created; capture immutable terms snapshot/digest, PDF content digest and Storage identity. Changes require revocation before countersignature, or a new agreement after bilateral signing. | Migration deliberately aborts if legacy agreement documents exist, requiring an explicit evidence-preserving migration plan. |
| A04: broad signing authority | Server requires active partner Owner, password AMR, legal name and explicit acknowledgement. Queue excludes other partner roles. | Authenticated multi-account UI acceptance remains. |
| A05: populated product deletion | Private transaction/backend/product-scoped exception for noncommercial click/event deletion; clear approved-funnel FK before deleting funnel; narrowly allow draft billing-offer deletion within the same safe RPC. | Real commercial records and bilateral signatures still block deletion. No live product was deleted. |
| A06: orphaned PDF cleanup | Server-authorized queue, exact object identity check, attachment tombstones, retry/error state; upload errors show whether cleanup was queued. | Maintenance is scheduled. The two previously observed orphan objects were not automatically queued or deleted; live deletion was not tested. |
| A07: unavailable/stale PDF signing | Loading error/retry, 15-second request timeout, conservative signed-link expiry, request cancellation guard, explicit acknowledgement, disabled signing until ready. | A retrieved URL/acknowledgement is not proof the person read the PDF. |
| A08: inadequate tests | Fixed SQL catalog call and TAP completion in tests 21–23; added a behavioral rollback suite, notification/cleanup/upload/preview tests and `validate:all`. | This does not represent a run of all historical database tests. |
| A09: no mail recovery | Unique milestone/recipient jobs, leases, frozen provider envelopes, per-job idempotency, bounded retries, receipts, stale/unauthorized recipient cancellation and Admin Data Health visibility. | Three scheduled no-op runs and a pg_net HTTP 200 probe passed. Real trigger-originated recipient delivery and retry timing remain unproven. |

The PDF SHA-256 is computed from file bytes by the authenticated uploading
browser. It is an uploader-provided fingerprint, **not server attestation of the
PDF contents** or an automated check that PDF prose matches the commercial fields.
The database independently pins Storage object ID/version/eTag and the exact
commercial revision. Administrators still need to review their actual terms.

### Additional blocker found by behavioral testing

The older `affiliate_links_validate_billing_readiness` trigger still required a
Stripe offer for Owner-approved tracking-only products. This prevented the actual
main-link issuance RPC from completing. A fourth migration corrects that
independent gate: commercial links still require verified billing; noncommercial
links require the exact approved tracking-only product. No commercial eligibility
is granted to tracking-only ancestry.

The fixture now exercises mode approval → activation → main link → click →
browser event → scoped deletion, rather than inserting empty placeholder links.
Email stored text is HTML-escaped, recipients are explicit verified Owners or
Owner/Operations admins, and frozen agreements are removed from editable rule
choices. The dashboard now shows waiting/processing/accepted/failed email counts
and cleanup counts, without exposing recipient addresses or file paths.

## Verification

- Final **`pnpm validate:all` passed** end to end on the release candidate.
- Frontend: **608 tests across 46 files passed**; focused PDF suite rerun after
  the loading-state lint adjustment: **8 passed**.
- Edge: **63 tests passed**, formatting and lint passed, all **11 entrypoints**
  type-checked, including unchanged payment/tracking functions.
- Production build and TypeScript passed. Existing large-chunk build warning
  remains; jsdom tests still print their pre-existing canvas-not-implemented
  warnings.
- Hosted rollback suite: **42 assertions passed** against the exact linked
  production project. The script requires an empty product/document catalog,
  uses short lock/statement deadlines, never invokes HTTP or Storage APIs, and
  rolls back every schema definition and synthetic fixture.
- Before rollout, migration readback was **30 applied / four pending**. The
  approved production rollout now has **34 applied**, and both public hosts
  serve the verified `dashboard-_BoSoXrQ.js` release. The hosted rollback suite
  also passed all 42 assertions after the permanent migrations.
- Covered: request/sign/countersign, signature/terms immutability, rule freeze,
  active/inactive/foreign/member/Finance/Analyst/paused and recovery-only signer
  rejections, changed PDF identity, missing acknowledgement, recipient scoping,
  lease exclusivity, immutable retry body, bounded retry age, tombstone attachment
  rejection, safe product deletion with traffic/funnel/billing/pending documents,
  surviving signed evidence and retained deletion audit history.

Commands:

```sh
pnpm validate:all
pnpm test:db:audit
git diff --check
```

Do not substitute `supabase test db` against production: older tests contain
extension setup/commits. The new explicit audit runner is a prelaunch rollback
check, not a general live-traffic test harness.

## Coordinated rollout procedure — deployment complete, real acceptance pending

1. Confirm deployment approval, the exact project, current migration versions,
   existing agreement-document count, and current VPS symlink/manifest. Verify
   recoverable backups and preserve all unrelated DramaPal services. Stop if
   legacy documents require an evidence migration; never delete them to satisfy
   the precondition.
2. Apply only these pending migrations in order after reviewing the CLI dry run:
   `20260905090000`, `20260905091000`, `20260905092000`, `20260905093000`.
   They create no products, offers, signatures or emails, and no schedules.
3. Generate a fresh random notification credential in a protected process and
   inject it into both `AGREEMENT_NOTIFY_SECRET` and private
   `kma_internal.function_secrets` entry `agreement_notify`. Use stdin/secret
   tooling, never shell history, source SQL literals, frontend variables or
   logs. Verify matching SHA-256 digests without printing values. Removing the
   old source line alone is not rotation; do not restore the old leaked value.
4. Deploy `agreement-notify` from this source and the rebuilt dashboard as one
   coordinated release. The new worker needs the new RPCs; the old dashboard
   does not supply the new digest/acknowledgement fields. This transition may
   briefly reject old-client signing/upload actions; refresh the client. Do not
   weaken server evidence validation for old clients.
5. Confirm the worker fails closed on bad auth/arbitrary bodies. After confirming
   there are no real pending jobs, an authenticated empty invocation should
   report zero claims. Do not treat zero claims as delivery proof.
6. Inspect existing scheduler jobs before adding one. Enable only the agreement
   maintenance dispatcher once per minute using Supabase Cron, calling
   `select kma_internal.dispatch_agreement_email_jobs();`. Do not put the
   credential into the cron SQL. This schedules agreement email/explicit cleanup
   only, not Stripe/commercial/metrics/payout processing. Verify cron execution
   and HTTP response evidence; no schedule is enabled by the migration itself.
7. Check Admin Data Health on the deployed build. Perform a separately agreed
   real UI acceptance with the actual reviewed PDF and intended signers:
   upload → request email → Owner signature → admin email → countersignature →
   partner email. Confirm actual recipient receipt and immutable evidence.
   We must not fabricate a legal signature just to test deployment.

Use a forward repair if schema/worker compatibility fails. A dashboard-only
rollback to the old upload/signing contract is not a complete rollback. Disable
the new maintenance schedule if delivery is faulty while retaining committed
jobs/signatures; never restore the compromised credential or delete evidence.

## Recovery policy

Email claims use a two-minute lease, at most three per invocation, at most eight
attempts, and an automatic retry cutoff of 20 hours from first attempt. Each
logical recipient job retains its original provider payload and idempotency key.
Resend documents a 24-hour key window; the shorter cutoff avoids an automatic
ambiguous resend after provider deduplication expires. See
[Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).

For failed jobs, an operator must inspect the private job ID/error/receipt and
provider records before authorizing a resend. Do not manually create another
signing request or clear a sent receipt as a retry workaround. SMTP/Resend
configuration readback, provider acceptance, and inbox delivery are different
proofs. For cleanup failures, confirm there is still no document/payout reference
and that the object identity matches before intervening; never grant browser
DELETE permission over the entire private bucket.

Dispatcher implementation follows the documented
[Supabase pg_net API](https://supabase.com/docs/guides/database/extensions/pg_net).
Schedule activation uses [Supabase Cron](https://supabase.com/docs/guides/cron)
only after the release/credential gates above.

## Still separate from these repairs

B2 funnel-facing checkout proxy, approved Stripe live configuration, payment/
refund/renewal acceptance, entitlement API, payout operations, third-party
analytics, CSP/bundle splitting, real-browser multi-account walkthrough,
screen-reader/device QA and legal review remain separate work. No first real
product is required to deploy the repair definitions; it is required for the
real commercial integration acceptance.
