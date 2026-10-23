import { ConfigurationError, RequestError } from "../_shared/errors.ts";
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";

export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(
      400,
      "invalid_input",
      "Check the connection details.",
    );
  }
  return value as Json;
}
export interface MerchantBinding {
  id: string;
  platformAccountId: string;
  livemode: boolean;
  clientId: string;
  secret: string;
  origin: string;
  // Absent only in legacy in-process callers; config resolves it to [origin].
  adminOrigins?: string[];
  callbackUrl: string;
  providerEnabled: boolean;
  webhookSecret?: string;
}
const ACCOUNT = /^acct_[A-Za-z0-9]{3,128}$/;
export function merchantOrigins(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Set<string> {
  return new Set(
    (env("MERCHANT_CONNECT_ALLOWED_ORIGINS") ?? "").split(",")
      .filter(Boolean).map((s) => validOrigin(s.trim(), env)),
  );
}
function validOrigin(raw: string, env: (name: string) => string | undefined) {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.origin !== raw || url.username || url.password ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:" &&
      env("MERCHANT_CONNECT_ALLOW_LOCAL") === "true"))
  ) throw new ConfigurationError();
  return url.origin;
}
// Provider keys are not read while external connection calls are disabled.
export function merchantBindings(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Map<string, MerchantBinding> {
  if (env("MERCHANT_CONNECT_ENABLED") !== "true") return new Map();
  try {
    const raw = object(JSON.parse(env("MERCHANT_CONNECT_BINDINGS_JSON") ?? ""));
    const result = new Map<string, MerchantBinding>();
    const origins = merchantOrigins(env);
    const providerEnabled = env("MERCHANT_CONNECT_PROVIDER_ENABLED") === "true";
    if (!Object.keys(raw).length || Object.keys(raw).length > 10) {
      throw new ConfigurationError();
    }
    for (const [id, value] of Object.entries(raw)) {
      const v = object(value);
      const origin = validOrigin(String(v.origin), env);
      const callbackUrl = new URL(String(v.callback_url));
      const rawAdminOrigins = v.admin_origins === undefined
        ? [origin]
        : v.admin_origins;
      if (
        !Array.isArray(rawAdminOrigins) || rawAdminOrigins.length === 0 ||
        rawAdminOrigins.length > 10 || rawAdminOrigins.some((value) =>
          typeof value !== "string"
        )
      ) {
        throw new ConfigurationError();
      }
      const adminOrigins = rawAdminOrigins.map((value) =>
        validOrigin(value, env)
      );
      if (
        new Set(adminOrigins).size !== adminOrigins.length ||
        adminOrigins.some((value) => !origins.has(value))
      ) {
        throw new ConfigurationError();
      }
      if (
        !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
        !ACCOUNT.test(String(v.platform_account_id)) ||
        typeof v.livemode !== "boolean" ||
        !/^ca_[A-Za-z0-9]{3,128}$/.test(String(v.client_id)) ||
        !/^[A-Z][A-Z0-9_]{1,100}$/.test(String(v.secret_env)) ||
        !origins.has(origin) || callbackUrl.origin !== origin ||
        callbackUrl.pathname !== "/merchant/callback" ||
        callbackUrl.search || callbackUrl.hash || callbackUrl.username ||
        callbackUrl.password ||
        (v.livemode && (env("MERCHANT_CONNECT_LIVE_ENABLED") !== "true" ||
          callbackUrl.protocol !== "https:")) ||
        [...result.values()].some((b) =>
          b.platformAccountId === v.platform_account_id &&
          b.livemode === v.livemode
        )
      ) throw new ConfigurationError();
      const secret = providerEnabled ? env(String(v.secret_env)) ?? "" : "";
      if (
        providerEnabled &&
        !new RegExp(`^sk_${v.livemode ? "live" : "test"}_[A-Za-z0-9]+$`).test(
          secret,
        )
      ) {
        throw new ConfigurationError();
      }
      result.set(id, {
        id,
        platformAccountId: String(v.platform_account_id),
        livemode: v.livemode,
        clientId: String(v.client_id),
        secret,
        origin,
        adminOrigins,
        callbackUrl: callbackUrl.href,
        providerEnabled,
        ...(typeof v.webhook_secret_env === "string" &&
            /^[A-Z][A-Z0-9_]{1,100}$/.test(v.webhook_secret_env) &&
            providerEnabled
          ? { webhookSecret: env(v.webhook_secret_env) }
          : {}),
      });
    }
    return result;
  } catch {
    throw new ConfigurationError();
  }
}
export interface AccountSnapshot {
  account_id: string;
  business_name: string;
  country: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
}
export class MerchantProvider {
  constructor(
    readonly binding: MerchantBinding,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private enabled() {
    if (!this.binding.providerEnabled) {
      throw new RequestError(
        503,
        "merchant_provider_disabled",
        "Stripe merchant connections are not enabled yet.",
      );
    }
  }
  authorizationUrl(state: string) {
    this.enabled();
    const url = new URL("https://connect.stripe.com/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.binding.clientId,
      scope: "read_write",
      redirect_uri: this.binding.callbackUrl,
      state,
    }).toString();
    return url.href;
  }
  private async request(
    path: string,
    body?: URLSearchParams,
    account?: string,
  ) {
    this.enabled();
    let response: Response;
    try {
      response = await this.fetcher(path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Basic ${btoa(`${this.binding.secret}:`)}`,
          "Stripe-Version": STRIPE_API_VERSION,
          ...(body
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
          ...(account ? { "Stripe-Account": account } : {}),
        },
        body,
        redirect: "error",
        signal: stripeRequestSignal(),
      });
    } catch {
      // OAuth codes are single-use: never retry an exchange, even after timeout.
      throw new RequestError(
        502,
        "merchant_provider_unavailable",
        "Stripe could not finish the connection. Start a new connection attempt.",
      );
    }
    let payload: Json;
    try {
      payload = object(await response.json());
    } catch {
      throw new RequestError(
        502,
        "merchant_provider_unavailable",
        "Stripe returned an invalid connection response. Start a new connection attempt.",
      );
    }
    if (!response.ok) {
      // Never expose provider bodies: they can contain auth codes and credentials.
      throw new RequestError(
        502,
        "merchant_connection_rejected",
        "Stripe could not authorise this account. Use an eligible independent Stripe account and start a new connection attempt.",
      );
    }
    return payload;
  }
  async verifyPlatform() {
    const account = await this.request("https://api.stripe.com/v1/account");
    if (account.id !== this.binding.platformAccountId) {
      throw new ConfigurationError();
    }
  }
  async exchange(code: string): Promise<string> {
    const response = await this.request(
      "https://connect.stripe.com/oauth/token",
      new URLSearchParams({
        code,
        grant_type: "authorization_code",
      }),
    );
    if (
      !ACCOUNT.test(String(response.stripe_user_id)) ||
      response.stripe_user_id === this.binding.platformAccountId ||
      response.livemode !== this.binding.livemode ||
      response.scope !== "read_write" ||
      response.token_type !== "bearer"
    ) {
      throw new RequestError(
        409,
        "merchant_scope_mismatch",
        "The selected Stripe account does not match this connection mode.",
      );
    }
    // Stripe-Account with the platform key replaces deprecated OAuth tokens.
    return String(response.stripe_user_id);
  }
  async account(accountId: string): Promise<AccountSnapshot> {
    if (
      !ACCOUNT.test(accountId) || accountId === this.binding.platformAccountId
    ) throw new ConfigurationError();
    const account = await this.request(
      "https://api.stripe.com/v1/account",
      undefined,
      accountId,
    );
    if (
      account.id !== accountId || account.type !== "standard" ||
      !/^[A-Z]{2}$/.test(String(account.country)) ||
      [
        account.charges_enabled,
        account.payouts_enabled,
        account.details_submitted,
      ].some((v) => typeof v !== "boolean")
    ) {
      throw new RequestError(
        409,
        "merchant_account_ineligible",
        "Choose an eligible independent Stripe business account.",
      );
    }
    const profile =
      account.business_profile && typeof account.business_profile === "object"
        ? account.business_profile as Json
        : {};
    const company = account.company && typeof account.company === "object"
      ? account.company as Json
      : {};
    const businessName = [
      profile.name,
      company.name,
      account.settings && typeof account.settings === "object"
        ? (account.settings as Json).dashboard
        : undefined,
    ]
      .find((v) => typeof v === "string" && v.trim());
    return {
      account_id: accountId,
      business_name: typeof businessName === "string"
        ? businessName.slice(0, 200)
        : accountId,
      country: String(account.country),
      charges_enabled: account.charges_enabled as boolean,
      payouts_enabled: account.payouts_enabled as boolean,
      details_submitted: account.details_submitted as boolean,
    };
  }
}
