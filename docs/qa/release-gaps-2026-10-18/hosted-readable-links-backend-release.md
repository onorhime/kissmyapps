# Readable creator links — hosted backend release, 18 October 2026

Deployed only migration `20261018120000_readable_creator_links.sql` and `tracking-redirect` version 17. Migration readback completed at 11:36:29 UTC and function readback at 11:37:35 UTC. Hosted migration count is now 65. Gateway and frontend cutovers are recorded separately by the acceptance owner.

## Behavior

Existing links receive an additional readable address, derived from the product and creator's public identity. Existing custom creator handles are preserved; generated `partner-…` identities use the public name. Latin, Cyrillic, Chinese and Arabic names are supported, with code-point length checks aligned across PostgreSQL and JavaScript. Collisions receive numeric suffixes. Punctuation-only names use a bounded `creator` fallback.

Each address retains its original link ownership. Handles and paths survive permitted target deletion as unresolvable reservations, so a later product cannot take over an old address. Existing random-code URLs, canonical link records and attribution dimensions remain unchanged. The readable resolver delegates to the existing status, agreement, product, offer, bot and rate-limit checks.

## Checks completed

- 52 isolated SQL suites passed; the three pre-existing suites requiring named production fixtures remained skipped. The new alias suite passed 33 assertions, including actual partner create/edit/status RPCs, tenant isolation, archived/reissued links, Unicode, exact attribution, and deletion/recreation reservations.
- 13 Edge tests and three gateway tests passed locally. A separate two-session real-RPC test observed advisory-lock contention and correctly allocated distinct minimal creator names without altering canonical link identities.
- Exact migration SQL was rehearsed and rolled back before commit. Both passes preserved every row across 107 original application tables. Four aliases were added for the four existing links, with two creator handles and two product handles.
- Existing views and their composite-type OIDs, old column definitions and grants were preserved. Only the two intended existing SQL functions changed; nine helpers/wrappers were added and 315 other functions were unchanged.
- `tracking-redirect` alone changed from version 16 to 17. Its existing `verify_jwt=false` setting was preserved; all 28 other Edge functions were unchanged. Source maps read from the deployed ESZIP confirm all eight application modules match the frozen source byte-for-byte.
- Every secret digest remained unchanged. Supabase refreshed metadata timestamps for seven built-in secrets during function deployment; their values were unchanged.
- Checkout, creator transfers, creator Connect and external-commerce activation gates remain false. The exact four paused jobs, zero-attempt processing state, legacy scheduler pause and cron definitions remain unchanged.

## Audit and recovery material

Migration SHA256: `bd922f11a06c17e6dc813479da45eeaa261a00230116259b332689c1df1ad13d`.

Deployed function bundle SHA256: `b59c08fc5c8f1413cb7a1e21f8904a2588a7cd60501537635530da62921159ad`.

Private ignored directory: `.cache/release-backups/20261018-kma-readable-links/`. It contains before/after schema and view catalogs, immutable migration SQL, rehearsal/commit receipts, protected-boundary fingerprints, frozen source, the complete previous Edge bundle and its extracted application sources, and source-parity verification. No reverse migration or queue recovery was attempted.

No new production affiliate, product, agreement, payment, refund, payout or email was created by this backend rollout. A ready existing BC Learn main link was identified for coordinated bot-marked, no-follow HTTP acceptance; no such redirect request was performed by this backend agent.
