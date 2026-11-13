import { ConfigurationError, RequestError } from "../_shared/errors.ts";
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";
import {
  type AccountSnapshot,
  type MerchantBinding,
  MerchantProvider,
} from "../merchant-connect/provider.ts";
import type { ConsoleConnectConfig } from "./config.ts";

const TOKEN_URL = "https://connect.stripe.com/oauth/token";
const DEAUTHORIZE_URL = "https://connect.stripe.com/oauth/deauthorize";
const ACCOUNT = /^acct_[A-Za-z0-9]{3,128}$/;

/** What the handler needs from Stripe. Tests replace it or its fetch. */
export interface ConsoleStripe {
  authorizationUrl(state: string): string;
  verifyPlatform(): Promise<void>;
  exchange(code: string): Promise<string>;
  account(accountId: string): Promise<AccountSnapshot>;
  deauthorize(accountId: string): Promise<void>;
}

/**
 * The console's Stripe calls. The OAuth URL, the code exchange and the account
 * read are the existing MerchantProvider with a live binding built from the
 * console's configuration; deauthorization is added here. Create one per
 * request.
 */
export class ConsoleStripeProvider implements ConsoleStripe {
  private readonly merchant: MerchantProvider;
  // The mode Stripe reported for the last code exchange. Nothing else is kept.
  private exchangedLivemode: unknown;

  constructor(
    private readonly config: ConsoleConnectConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const binding: MerchantBinding = {
      id: "console",
      platformAccountId: config.platformAccountId,
      livemode: true,
      clientId: config.clientId,
      secret: config.secret,
      origin: config.origin,
      callbackUrl: config.callbackUrl,
      providerEnabled: true,
    };
    this.merchant = new MerchantProvider(binding, async (input, init) => {
      const response = await fetcher(input, init);
      if (String(input) === TOKEN_URL && response.ok) {
        try {
          const payload: unknown = await response.clone().json();
          this.exchangedLivemode = payload && typeof payload === "object"
            ? (payload as Record<string, unknown>).livemode
            : undefined;
        } catch {
          // MerchantProvider reports an unreadable response itself.
        }
      }
      return response;
    });
  }

  authorizationUrl(state: string): string {
    return this.merchant.authorizationUrl(state);
  }

  verifyPlatform(): Promise<void> {
    return this.merchant.verifyPlatform();
  }

  /** One attempt only: a Stripe code is single-use, so this is never retried. */
  async exchange(code: string): Promise<string> {
    this.exchangedLivemode = undefined;
    try {
      return await this.merchant.exchange(code);
    } catch (error) {
      if (
        error instanceof RequestError &&
        error.code === "merchant_scope_mismatch" &&
        this.exchangedLivemode !== true && this.exchangedLivemode !== undefined
      ) {
        throw new RequestError(
          409,
          "stripe_not_live",
          "Only a live Stripe account can be connected.",
        );
      }
      throw error;
    }
  }

  account(accountId: string): Promise<AccountSnapshot> {
    return this.merchant.account(accountId);
  }

  /** Ends KissMyApps' access to the account at Stripe. One attempt. */
  async deauthorize(accountId: string): Promise<void> {
    if (
      !ACCOUNT.test(accountId) || accountId === this.config.platformAccountId
    ) throw new ConfigurationError();
    let response: Response;
    try {
      response = await this.fetcher(DEAUTHORIZE_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${this.config.secret}:`)}`,
          "Stripe-Version": STRIPE_API_VERSION,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          stripe_user_id: accountId,
        }),
        redirect: "error",
        signal: stripeRequestSignal(),
      });
    } catch {
      throw new RequestError(
        502,
        "merchant_provider_unavailable",
        "Stripe could not be reached to remove access.",
      );
    }
    let confirmed: unknown;
    try {
      const payload: unknown = await response.json();
      confirmed = payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).stripe_user_id
        : undefined;
    } catch {
      confirmed = undefined;
    }
    // Never expose provider bodies: only whether Stripe confirmed this account.
    if (!response.ok || confirmed !== accountId) {
      throw new RequestError(
        502,
        "stripe_deauthorize_rejected",
        "Stripe did not confirm that access was removed.",
      );
    }
  }
}
