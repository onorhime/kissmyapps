# Hosted merchant email acceptance — 18 October 2026

**Passed:** the real hosted fresh-signup and returning-signin email journeys.

Only the confirmation and magic-link template content fields were patched from the repository templates. Exact template hashes were verified on readback. Supabase also updated its derived flag indicating that a custom magic-link template exists. The eight-digit OTP security setting and all other Auth configuration were preserved.

Two messages were sent to the owner's specifically approved release-test email alias. Both were reported `delivered` by Resend and each rendered the expected template with an eight-digit code. Each code was kept in memory and verified using the real hosted Auth endpoint. Both sessions were signed out afterward; an independent database check found zero remaining sessions, zero admin memberships and zero partner memberships for the test identity.

The retained identity is labeled by its release-test email alias and carries only the `merchant_v1` registration metadata. No merchant invitation, Stripe account connection, checkout, commission, transfer or payout was created by this email acceptance.

Delivery status proves recipient mail-server acceptance; human inbox placement was not inspected. Existing partner-template compatibility was verified locally in the prior acceptance and the confirmation template's partner branch was preserved; this run did not email an unrelated partner.

Sanitized evidence: [hosted-email-verification.json](hosted-email-verification.json). Private Auth configuration backups and operation scripts are under `.cache/release-backups/20261018-kma-speaksix/auth/`. OTPs, tokens and raw email contents were never stored in the evidence.
