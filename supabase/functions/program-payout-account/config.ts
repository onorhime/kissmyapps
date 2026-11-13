// What the two program payout functions read from the environment. Program
// money lives on the KissMyApps platform's own live Stripe account (the
// console platform), so a creator's payout account for programs is a connected
// account of that platform. The Stripe key, the origin and the country policy
// are the ones of that platform's entry in CREATOR_CONNECT_BINDINGS_JSON, read
// with the legacy parser so both systems agree on what a valid entry is.
// Live only.
import { ConfigurationError } from "../_shared/errors.ts";
import { requireLiveStripeKey } from "../_shared/stripe-auth.ts";
import { isPlainObject } from "../_shared/validation.ts";
import {
  connectBindings,
  type ConnectConfig,
} from "../creator-connect/provider.ts";

type Env = (name: string) => string | undefined;
const denoEnv: Env = (name) => Deno.env.get(name);

/** Both functions are off unless PROGRAM_PAYOUTS_ENABLED is exactly "true". */
export function programPayoutsEnabled(env: Env = denoEnv): boolean {
  return env("PROGRAM_PAYOUTS_ENABLED") === "true";
}

/**
 * The one entry of CREATOR_CONNECT_BINDINGS_JSON that program payouts use:
 * platform account CONSOLE_CONNECT_PLATFORM_ACCOUNT, live mode, a live key.
 * An empty map when there is no such entry. Read only while the feature is
 * on, so no key is touched while it is off.
 *
 * Neither CREATOR_CONNECT_ENABLED nor CREATOR_TRANSFERS_ENABLED is consulted:
 * those switch the legacy functions, and program payouts have their own
 * switch. Entries of other platforms are not parsed at all, so a mistake in
 * one of them cannot stop program payouts.
 */
export function programPayoutBindings(
  env: Env = denoEnv,
): Map<string, ConnectConfig> {
  const platform = (env("CONSOLE_CONNECT_PLATFORM_ACCOUNT") ?? "").trim();
  if (!/^acct_[A-Za-z0-9]{3,128}$/.test(platform)) {
    throw new ConfigurationError();
  }
  const raw = (env("CREATOR_CONNECT_BINDINGS_JSON") ?? "").trim();
  if (!raw) return new Map();
  let all: unknown;
  try {
    all = JSON.parse(raw);
  } catch {
    throw new ConfigurationError();
  }
  if (!isPlainObject(all)) throw new ConfigurationError();
  const mine = Object.entries(all).filter(([, entry]) =>
    isPlainObject(entry) && entry.platform_account_id === platform &&
    entry.livemode === true
  );
  if (mine.length === 0) return new Map();
  if (mine.length > 1) throw new ConfigurationError();
  const [id, entry] = mine[0] as [string, Record<string, unknown>];
  const keyName = entry.secret_env;
  try {
    requireLiveStripeKey(typeof keyName === "string" ? env(keyName) : "");
  } catch {
    // Not a live key: for program payouts this entry does not exist.
    return new Map();
  }
  // The legacy parser checks everything else: the names, the publishable key,
  // the origin and return addresses, the country policy.
  return connectBindings((name) =>
    name === "CREATOR_CONNECT_ENABLED"
      ? "true"
      : name === "CREATOR_TRANSFERS_ENABLED"
      ? undefined
      : name === "CREATOR_CONNECT_BINDINGS_JSON"
      ? JSON.stringify({ [id]: entry })
      : env(name)
  );
}

/** The same entry for the worker; null when there is none. */
export function programPayoutBinding(env: Env = denoEnv): ConnectConfig | null {
  const [config] = programPayoutBindings(env).values();
  return config ?? null;
}
