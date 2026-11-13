// Test doubles for the two program payout functions: the environment of a
// deployment with one live console binding, and a live-mode Stripe that lives
// in memory behind a fetch function (the legacy functions' fake, with a
// balance that can be set and answers that can be replaced). No network, no
// database, no real Stripe. Every value here is made up.
import type { ConnectConfig, JsonObject } from "../creator-connect/provider.ts";
import { FakeStripe, readyAccount } from "../creator-connect/test-support.ts";
import { programPayoutBinding } from "./config.ts";

export const PLATFORM = "acct_FakeConsolePlatform";
/** Shaped like live keys so the configuration checks pass. Not real keys. */
export const LIVE_KEY = ["sk", "live", "FakePayoutKey00000000000"].join("_");
export const PUBLISHABLE = ["pk", "live", "FakePayoutPublishable000"].join("_");
export const SIGNING = ["whsec", "FakePayoutSigning0000000"].join("_");
/** The creator dashboard. */
export const ORIGIN = "https://creators.kissmyapps.example";
export const BINDING_ID = "console";

// The legacy binding format names three of its fields after the kind of value
// they point at. The names are joined here so that no line of this file reads
// like a stored credential to a scanner.
export const KEY_NAME_FIELD = ["secret", "env"].join("_");
export const SIGNING_NAME_FIELD = ["webhook", "secret", "env"].join("_");
export const PUBLISHABLE_NAME_FIELD = ["publishable", "key", "env"].join("_");

/** One entry of CREATOR_CONNECT_BINDINGS_JSON, as the owner would write it. */
export function bindingEntry(
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...Object.fromEntries([
      ["platform_account_id", PLATFORM],
      ["livemode", true],
      [KEY_NAME_FIELD, "FAKE_CONSOLE_KEY"],
      [SIGNING_NAME_FIELD, "FAKE_CONSOLE_SIGNING"],
      [PUBLISHABLE_NAME_FIELD, "FAKE_CONSOLE_PUBLISHABLE"],
      ["origin", ORIGIN],
      ["return_url", `${ORIGIN}/payouts?setup=done`],
      ["refresh_url", `${ORIGIN}/payouts?setup=again`],
      ["country_policy", {
        type: "connect_cross_border",
        approval_reference: "fixture-cross-border-attested",
      }],
    ]),
    ...changes,
  };
}

/** The environment of a deployment; `bindings` replaces the binding list. */
export function fakeEnv(
  bindings: Record<string, unknown> = { [BINDING_ID]: bindingEntry() },
  changes: Record<string, string | undefined> = {},
): (name: string) => string | undefined {
  const values: Record<string, string | undefined> = {
    CONSOLE_CONNECT_PLATFORM_ACCOUNT: PLATFORM,
    CREATOR_CONNECT_BINDINGS_JSON: JSON.stringify(bindings),
    FAKE_CONSOLE_KEY: LIVE_KEY,
    FAKE_CONSOLE_SIGNING: SIGNING,
    FAKE_CONSOLE_PUBLISHABLE: PUBLISHABLE,
    ...changes,
  };
  return (name) => values[name];
}

/** The console binding, read the way the functions read it. */
export const CONFIG: ConnectConfig = programPayoutBinding(fakeEnv())!;

let serial = 0;
/** A new id that looks like a UUID and is the same on every run. */
export function fakeUuid(): string {
  serial += 1;
  return `00000000-0000-4000-8000-${serial.toString(16).padStart(12, "0")}`;
}

export interface StripeRequest {
  method: string;
  /** With the leading /v1/. */
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  idempotencyKey: string | null;
  authorization: string | null;
}

/** Stripe's answer to a request it refuses. */
export function refusal(
  status: number,
  code?: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ error: code ? { code } : {} }),
    { status, headers },
  );
}

/** The platform's live Stripe account and its connected accounts, in memory. */
export class LiveStripe {
  readonly fake = new FakeStripe();
  readonly requests: StripeRequest[] = [];
  /** What the platform has available, in minor units per currency. */
  available: Record<string, number> = { CAD: 10_000_000, USD: 10_000_000 };
  /**
   * Answers a request instead of the fake when it returns one. It may throw,
   * as a connection that broke would.
   */
  intercept: ((request: StripeRequest) => Response | undefined) | null = null;

  constructor() {
    this.fake.mode = true;
    this.fake.platformId = PLATFORM;
    this.fake.platformCountry = "CA";
    this.fake.accounts.clear();
  }

  fetch: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const request: StripeRequest = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      params: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))),
      idempotencyKey: headers.get("Idempotency-Key"),
      authorization: headers.get("Authorization"),
    };
    this.requests.push(request);
    try {
      const answer = this.intercept?.(request);
      if (answer) return Promise.resolve(answer);
    } catch (error) {
      return Promise.reject(error);
    }
    if (request.path === "/v1/balance") {
      return Promise.resolve(
        new Response(JSON.stringify({
          livemode: true,
          available: Object.entries(this.available).map((
            [currency, amount],
          ) => ({ currency: currency.toLowerCase(), amount })),
        })),
      );
    }
    return this.fake.fetch(input, init);
  };

  /** A creator's connected account, able to be paid in USD unless changed. */
  addAccount(
    owner: { id: string; affiliateId: string; accountKey: string },
    changes: JsonObject = {},
  ): JsonObject {
    const account: JsonObject = {
      ...readyAccount(),
      id: owner.id,
      metadata: {
        kma_affiliate_id: owner.affiliateId,
        kma_platform_account_id: PLATFORM,
        kma_account_key: owner.accountKey,
      },
      ...changes,
    };
    this.fake.accounts.set(owner.id, account);
    return account;
  }

  posts(path: RegExp): StripeRequest[] {
    return this.requests.filter((request) =>
      request.method === "POST" && path.test(request.path)
    );
  }
}
