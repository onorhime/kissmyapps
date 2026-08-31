/**
 * Keep direct REST calls and webhook rendering on one deliberately selected
 * Stripe API contract. This is a source-controlled compatibility decision, not
 * a runtime setting that can drift independently between functions.
 */
export const STRIPE_API_VERSION = "2026-02-25.clover";

/** A single provider call must leave time for retry bookkeeping. */
export const STRIPE_API_TIMEOUT_MS = 8_000;

export function stripeRequestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(STRIPE_API_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
