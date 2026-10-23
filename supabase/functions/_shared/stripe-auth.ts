import { ConfigurationError } from "./errors.ts";

/** Validate server-key type only. Stripe still enforces its resource permissions. */
export function requireLiveStripeKey(value: unknown): string {
  if (
    typeof value !== "string" || value.length > 512 ||
    value.trim() !== value ||
    !/^(?:rk|sk)_live_[A-Za-z0-9_]{16,}$/.test(value)
  ) {
    // Never include the supplied credential in errors or diagnostics.
    throw new ConfigurationError();
  }
  return value;
}
