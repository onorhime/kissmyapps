# Published metric environment correction

Local validation completed on 22 October 2026. No hosted migration, provider configuration, checkout or payout gate was changed by this verification.

- Migration 69 scopes published metric cards, availability and receipt timestamps to explicitly selected TEST or LIVE mode. Legacy unclassified rows are excluded from both explicit modes; omitted mode preserves the existing unfiltered reporting interface.
- V2 people counts resolve verified aliases within their environment. Current attendance states use operational revision before occurrence time; webinar context prevents a different webinar from replacing the first webinar’s state. Dimension filtering still happens after latest-state selection.
- Verified financial records remain separate by provider mode; reporting never creates financial events or commission.
- A fresh database applied all 69 migrations and passed all 59 SQL suites, with no skips.
- The same new regression against baseline 68 fails at the TEST/verified-identity assertion, confirming it detects the old defect.

The attached JSON records exact file hashes and test results. The change does not add TEST commercial creator-link readiness.

A hosted rehearsal also passed inside a transaction ending in explicit ROLLBACK. It verified all 117 existing public/internal tables and 336 unrelated functions were unchanged, then read back baseline68, the four original function definitions/ACLs and unchanged secret digests. This proves the prepared migration can execute without altering business rows; it is not a deployment receipt. An initial release-check query incorrectly included PostgreSQL aggregate definitions; that checker was corrected before the successful rehearsal.
