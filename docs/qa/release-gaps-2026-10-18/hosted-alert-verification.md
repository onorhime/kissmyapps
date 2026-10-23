# Hosted operational-alert checks — 18 October 2026

The existing processing-alert monitor is enabled, scheduled every minute, and addressed only to the approved owner inbox. Its observation timestamp is current. There are no pending alert-delivery jobs. Its sender, recipient, settings, queues and existing incident were preserved.

## New managed-checkout reason

A read-only projection through the deployed `processing_health_reasons` function includes `managed_checkout_issue` when managed delivery needs attention. A rollback-only call to the actual hosted observer passed: it recognized the projected health condition while preserving the existing open incident and every existing alert job. No email was queued or sent by this check.

The observer intentionally permits one open incident globally. Because an unrelated legacy incident is already open, it cannot issue a separate managed-checkout failure/recovery pair until that genuine incident is resolved. We did not close, rewrite or recover it for testing. Local tests cover the new reason's fresh failure/recovery path; a new hosted alert-email delivery for that reason remains unverified.

## Existing legacy issue to inspect before financial activation

Current database facts:

- The legacy Stripe → commercial → metrics schedule is disabled with `paused_reason=worker_http_failure` and retains failed run `5d81b1c5-a819-4ab1-b6cf-81673acf81ab`.
- The September 9 run recorded an upstream HTTP 520 after 40,362 ms; its dispatcher recorded HTTP 503 and marked the run failed. These receipts do not establish the underlying provider/network cause or a human decision to pause it.
- The last completed legacy cycle is September 9. Four Stripe processing jobs remain pending; the oldest is October 6.
- Current reasons are `scheduler_paused`, `cycle_stale` and `jobs_stalled`.
- The only recorded operator recovery found was September 7 for a different run. No recovery was performed here.

This is a remaining **pre-activation investigation**, not a reason to undo the gated deployment. Do not restart the legacy queue without inspecting its original account/mode, event scope, leases and processing effects.

## Email evidence boundaries

The database records that the September 9 failure notification was accepted by Resend. A fresh lookup of that exact provider message ID returned HTTP 404, so its current delivery status could not be confirmed. We do not infer the reason for the missing provider record.

The separate [hosted merchant email acceptance](hosted-email-verification.md) did verify two newly delivered messages and both hosted sign-ins today. That establishes the current Auth email journey; it does not substitute for a new operational-alert failure/recovery delivery test.

Private receipts and rollback SQL: `.cache/release-backups/20261018-kma-backend/alert-readonly-inventory.json`, `prior-alert-provider-delivery.json`, `managed-alert-readonly-reason-proof.json`, `managed-alert-observer-rollback.json`, and `legacy-paused-schedule-current-facts.json`.
