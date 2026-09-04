# KissMyApps agreement emails release evidence — 2026-09-04

Database, Edge Function, and frontend release that fixes draft agreement
deletion semantics and adds branded transactional agreement emails.

## Deletion semantics fix

`delete_admin_draft_agreement` now terminates pending signing requests
automatically when a draft is deleted; only a fully signed document blocks
deletion, as bilateral signature evidence is preserved. The live-document
definition matches the configuration projection. The confirm copy explains
the behaviour.

## Email notifications

- Migration `20260904191000_agreement_email_triggers` enables pg_net,
  stores the internal secret server-side (schema revoked from all browser
  and service roles), and fires on three document milestones:
  signing request -> partner; partner signed -> Owner/Operations admins;
  countersigned -> partner. Trigger failures never block the mutation.
- New `agreement-notify` Edge Function (deployed, verify_jwt off) verifies
  the internal secret, loads context server-side, renders the shared
  KissMyApps email template (`_shared/email-template.ts`), and sends via
  the Resend API. Endpoint probes return 401 without/wrong secret and 404
  for unknown documents with the correct secret.
- `AGREEMENT_NOTIFY_SECRET` set in the Edge secret store.
  `RESEND_API_KEY` remains unset: actual delivery activates when the
  Owner supplies the Resend API key, and the `from` address must match
  the verified Resend sender (default `partners@kissmyapps.dev`,
  overridable via `AGREEMENT_EMAIL_FROM`).

## Release identity

- Release commit: `ae15a2a5f340`.
- Migrations applied with a clean local/remote history match for all 26.
- Active release: `/srv/kissmyapps/releases/20260904T140036Z-agreement-emails-ae15a2a5f340`.
- Rollback target: `/srv/kissmyapps/releases/20260904T125631Z-draft-deletion-01e0d0499eb1`.
- Manifest SHA-256: `506eba594b28de7cc2efed8282847f79bf3eef06604bcbca26136dc24b2506fb`.
- `pnpm format:check`, `pnpm lint`, `pnpm test` (44 files, 597 tests),
  51/51 Edge tests, `deno fmt --check`, and `pnpm build` passed. Both hosts
  serve an index.html byte-identical to the local build; the container is
  healthy.

## Follow-up (commit d712a4fb70ee)

Root-caused the remaining deletion failure against the live database: the
foundation `agreements_protect_history` trigger rejected every DELETE
unconditionally ("agreement versions cannot be deleted"), so the deletion
RPC failed even for empty drafts. Migration
`20260904200000_allow_draft_agreement_delete` preserves the trigger's
INSERT/UPDATE logic exactly and permits the deletable subset: draft or
awaiting-signature versions without a fully signed document. Verified with
a rolled-back DELETE test against the live database.

The Owner supplied the Resend API key and the `send.kissmyapps.dev` sending
domain; `RESEND_API_KEY` and `AGREEMENT_EMAIL_FROM`
(`partners@send.kissmyapps.dev`) are set. A live signing-request email for
the real pending document was delivered successfully (HTTP 200, sent: 1)
through the branded template.
