import { ConfigurationError } from "../_shared/errors.ts";
import { requireLiveStripeKey } from "../_shared/stripe-auth.ts";
import { consoleConnectOrigin } from "../workspace-stripe-connect/config.ts";

type Env = (name: string) => string | undefined;
const denoEnv: Env = (name) => Deno.env.get(name);

/** What the three balance functions need to talk to Stripe. Live only. */
export interface ProgramBalanceConfig {
  /** The KissMyApps platform's own live Stripe key. */
  secret: string;
  platformAccountId: string;
}

/** The balance functions are off unless PROGRAM_BALANCE_ENABLED is exactly "true". */
export function programBalanceEnabled(env: Env = denoEnv): boolean {
  return env("PROGRAM_BALANCE_ENABLED") === "true";
}

/**
 * Read only while the feature is on, so the Stripe key is never touched while
 * it is off. Balances are charged on the platform's own account: the key and
 * the account id are the ones the console's Stripe connection already uses.
 * Anything but a live key is a configuration error.
 */
export function programBalanceConfig(env: Env = denoEnv): ProgramBalanceConfig {
  const secret = requireLiveStripeKey(
    (env("CONSOLE_CONNECT_STRIPE_SECRET") ?? "").trim(),
  );
  const platformAccountId = (env("CONSOLE_CONNECT_PLATFORM_ACCOUNT") ?? "")
    .trim();
  if (!/^acct_[A-Za-z0-9]{3,128}$/.test(platformAccountId)) {
    throw new ConfigurationError();
  }
  return { secret, platformAccountId };
}

/** Where Stripe sends the merchant back to: the console's Balance page. */
export interface BalanceReturnUrls {
  depositDone: string;
  depositCanceled: string;
  cardDone: string;
  cardCanceled: string;
}

/**
 * Built from the configured console origin, never from the request, so a
 * forged Origin or Referer cannot choose where Stripe redirects.
 */
export function balanceReturnUrls(env: Env = denoEnv): BalanceReturnUrls {
  const page = `${consoleConnectOrigin(env)}/#balance`;
  return {
    depositDone: `${page}?deposit=done`,
    depositCanceled: `${page}?deposit=canceled`,
    cardDone: `${page}?card=done`,
    cardCanceled: `${page}?card=canceled`,
  };
}
