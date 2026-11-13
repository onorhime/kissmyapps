import { ConfigurationError } from "../_shared/errors.ts";

type Env = (name: string) => string | undefined;
const denoEnv: Env = (name) => Deno.env.get(name);

/** Everything needed to talk to Stripe for the console. Live only. */
export interface ConsoleConnectConfig {
  platformAccountId: string;
  clientId: string;
  secret: string;
  origin: string;
  callbackUrl: string;
}

/** The feature is off unless CONSOLE_CONNECT_ENABLED is exactly "true". */
export function consoleConnectEnabled(env: Env = denoEnv): boolean {
  return env("CONSOLE_CONNECT_ENABLED") === "true";
}

/**
 * The one browser origin that may call the function. It is read even while the
 * feature is off, so the console can be told that it is off.
 */
export function consoleConnectOrigin(env: Env = denoEnv): string {
  const raw = (env("CONSOLE_CONNECT_ORIGIN") ?? "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError();
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    url.origin !== raw || url.username || url.password ||
    (url.protocol !== "https:" &&
      !(local && url.protocol === "http:" &&
        env("CONSOLE_CONNECT_ALLOW_LOCAL") === "true"))
  ) throw new ConfigurationError();
  return url.origin;
}

/**
 * Read only while the feature is on, so the Stripe key is never touched while
 * it is off. Anything but a live secret key is a configuration error.
 */
export function consoleConnectConfig(env: Env = denoEnv): ConsoleConnectConfig {
  const origin = consoleConnectOrigin(env);
  const platformAccountId = (env("CONSOLE_CONNECT_PLATFORM_ACCOUNT") ?? "")
    .trim();
  const clientId = (env("CONSOLE_CONNECT_CLIENT_ID") ?? "").trim();
  const secret = (env("CONSOLE_CONNECT_STRIPE_SECRET") ?? "").trim();
  // Sent to Stripe exactly as configured: it must equal the registered redirect URI.
  const callbackUrl = (env("CONSOLE_CONNECT_CALLBACK_URL") ?? "").trim();
  let callback: URL;
  try {
    callback = new URL(callbackUrl);
  } catch {
    throw new ConfigurationError();
  }
  if (
    !/^acct_[A-Za-z0-9]{3,128}$/.test(platformAccountId) ||
    !/^ca_[A-Za-z0-9]{3,128}$/.test(clientId) ||
    !/^sk_live_[A-Za-z0-9]+$/.test(secret) ||
    callback.origin !== origin || callback.username || callback.password ||
    callback.hash || callbackUrl.includes("#")
  ) throw new ConfigurationError();
  return { platformAccountId, clientId, secret, origin, callbackUrl };
}
