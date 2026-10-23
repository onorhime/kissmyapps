// deno-lint-ignore-file require-await -- Fake adapters preserve the asynchronous production boundary.
import type { ConnectConfig, JsonObject, TransferJob } from "./provider.ts";
export const NOW = Date.now();
export const config: ConnectConfig = {
  platformAccountId: "acct_platform",
  livemode: false,
  secret: "sk_test_localfixture",
  publishableKey: "pk_test_localfixture",
  webhookSecret: "whsec_localfixture",
  origin: "http://127.0.0.1:5300",
  returnUrl: "http://127.0.0.1:5300/connect/return",
  refreshUrl: "http://127.0.0.1:5300/connect/refresh",
  countryPolicy: {
    type: "connect_cross_border",
    approvalReference: "fixture-approved-regional-routes",
  },
  transfersEnabled: true,
};
export const creator = {
  affiliate_id: "11111111-1111-4111-8111-111111111111",
  account_key: "22222222-2222-4222-8222-222222222222",
  connect_account_id: "acct_creator",
  platform_account_id: config.platformAccountId,
  livemode: false,
  created_at: new Date(NOW).toISOString(),
};
export const job: TransferJob = {
  id: "33333333-3333-4333-8333-333333333333",
  lease_token: "44444444-4444-4444-8444-444444444444",
  kind: "transfer",
  amount_minor: 2000,
  currency: "USD",
  destination: "acct_creator",
  platform_account_id: config.platformAccountId,
  livemode: false,
  idempotency_key: "kma-fixture-job",
  first_attempt_at: new Date(NOW).toISOString(),
  transfer_id: null,
  transfer_group: "kma-fixture-group",
};
export function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
export async function assertRejects(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("Expected rejection");
}
export function readyAccount(): JsonObject {
  return {
    id: creator.connect_account_id,
    controller: {
      type: "application",
      is_controller: true,
      requirement_collection: "application",
      stripe_dashboard: { type: "none" },
      fees: { payer: "application" },
      losses: { payments: "application" },
    },
    metadata: {
      kma_affiliate_id: creator.affiliate_id,
      kma_platform_account_id: config.platformAccountId,
      kma_account_key: creator.account_key,
    },
    country: "US",
    default_currency: "usd",
    external_accounts: {
      data: [{
        id: "ba_fixture",
        object: "bank_account",
        currency: "usd",
        status: "verified",
      }],
      has_more: false,
    },
    capabilities: { transfers: "active" },
    requirements: { currently_due: [], past_due: [], disabled_reason: null },
    details_submitted: true,
    charges_enabled: false,
    payouts_enabled: true,
  };
}
export class FakeStripe {
  accounts = new Map<string, JsonObject>([[
    creator.connect_account_id,
    readyAccount(),
  ]]);
  transfers = new Map<string, JsonObject>();
  reversals = new Map<string, JsonObject>();
  payouts = new Map<string, JsonObject>();
  charges = new Map<string, JsonObject>();
  disputes = new Map<string, JsonObject>();
  payments = new Map<string, JsonObject>();
  refunds = new Map<string, JsonObject>();
  mutations = new Map<string, JsonObject>();
  calls: Array<
    { path: string; method: string; body: URLSearchParams; headers: Headers }
  > = [];
  ambiguousNextTransfer = false;
  platformId = config.platformAccountId;
  platformCountry = "US";
  balanceCurrencies = ["USD", "GBP"];
  countrySpecs: JsonObject[] = [
    {
      id: "US",
      supported_transfer_countries: ["US", "GB", "CA", "NG"],
      supported_bank_account_currencies: { usd: ["US"] },
    },
    {
      id: "GB",
      supported_transfer_countries: ["US", "GB"],
      supported_bank_account_currencies: { gbp: ["GB"], usd: ["US"] },
    },
    {
      id: "CA",
      supported_transfer_countries: ["US", "GB", "CA"],
      supported_bank_account_currencies: { cad: ["CA"], usd: ["US"] },
    },
    {
      id: "NG",
      supported_transfer_countries: ["NG"],
      supported_bank_account_currencies: { ngn: ["NG"] },
    },
  ];
  mode = false;
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      path = url.pathname.replace("/v1/", ""),
      headers = new Headers(init?.headers),
      method = init?.method ?? "GET",
      body = new URLSearchParams(String(init?.body ?? ""));
    if (url.origin !== "https://api.stripe.com") {
      throw new Error("Unexpected network destination");
    }
    this.calls.push({ path, method, body, headers });
    const reply = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200 });
    if (path === "account") {
      return reply({ id: this.platformId, country: this.platformCountry });
    }
    if (path === "balance") {
      return reply({
        livemode: this.mode,
        available: this.balanceCurrencies.map((currency) => ({
          currency: currency.toLowerCase(),
          amount: 10000000,
        })),
      });
    }
    if (path === "country_specs") {
      return reply({ data: this.countrySpecs, has_more: false });
    }
    if (path === "accounts" && method === "GET") {
      return reply({ data: [...this.accounts.values()], has_more: false });
    }
    if (path.startsWith("accounts/")) {
      return reply(this.accounts.get(path.slice(9)));
    }
    if (path === "accounts") {
      const key = headers.get("Idempotency-Key")!;
      if (this.mutations.has(key)) return reply(this.mutations.get(key));
      const account = {
        ...readyAccount(),
        id: "acct_newcreator",
        controller: {
          type: "application",
          is_controller: true,
          requirement_collection: body.get(
            "controller[requirement_collection]",
          ),
          stripe_dashboard: {
            type: body.get("controller[stripe_dashboard][type]"),
          },
          fees: { payer: body.get("controller[fees][payer]") },
          losses: { payments: body.get("controller[losses][payments]") },
        },
        country: body.get("country"),
        capabilities: { transfers: "pending" },
        details_submitted: false,
        payouts_enabled: false,
        requirements: {
          currently_due: ["individual.verification.document"],
          past_due: [],
        },
        metadata: {
          kma_affiliate_id: body.get("metadata[kma_affiliate_id]"),
          kma_platform_account_id: body.get(
            "metadata[kma_platform_account_id]",
          ),
          kma_account_key: body.get("metadata[kma_account_key]"),
        },
      };
      this.accounts.set(String(account.id), account);
      this.mutations.set(key, account);
      return reply(account);
    }
    if (path === "account_links") {
      return reply({
        url: "https://connect.stripe.com/setup/singleusefixture",
      });
    }
    if (path === "account_sessions") {
      return reply({
        object: "account_session",
        account: body.get("account"),
        livemode: this.mode,
        client_secret: "local_session_fixture_secret",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        components: {
          account_onboarding: {
            enabled:
              body.get("components[account_onboarding][enabled]") === "true",
            features: {
              external_account_collection: body.get(
                "components[account_onboarding][features][external_account_collection]",
              ) === "true",
              disable_stripe_user_authentication: body.get(
                "components[account_onboarding][features][disable_stripe_user_authentication]",
              ) === "true",
            },
          },
        },
      });
    }
    if (path === "transfers" && method === "GET") {
      return reply({
        data: [...this.transfers.values()].filter((t) =>
          t.destination === url.searchParams.get("destination") &&
          t.transfer_group === url.searchParams.get("transfer_group")
        ),
        has_more: false,
      });
    }
    if (path === "transfers") {
      const key = headers.get("Idempotency-Key")!;
      if (this.mutations.has(key)) return reply(this.mutations.get(key));
      const value = {
        id: `tr_fixture${this.transfers.size + 1}`,
        amount: Number(body.get("amount")),
        amount_reversed: 0,
        currency: body.get("currency"),
        destination: body.get("destination"),
        transfer_group: body.get("transfer_group"),
        metadata: { kma_job_id: body.get("metadata[kma_job_id]") },
        livemode: this.mode,
      };
      this.transfers.set(value.id, value);
      this.mutations.set(key, value);
      if (this.ambiguousNextTransfer) {
        this.ambiguousNextTransfer = false;
        throw new TypeError("fixture connection lost after commit");
      }
      return reply(value);
    }
    if (/^transfers\/[^/]+\/reversals$/.test(path)) {
      const id = path.split("/")[1];
      if (method === "GET") {
        return reply({
          data: [...this.reversals.values()].filter((r) => r.transfer === id),
          has_more: false,
        });
      }
      const key = headers.get("Idempotency-Key")!;
      if (this.mutations.has(key)) return reply(this.mutations.get(key));
      const transfer = this.transfers.get(id)!;
      const value = {
        id: `trr_fixture${this.reversals.size + 1}`,
        transfer: id,
        amount: Number(body.get("amount")),
        currency: transfer.currency,
        metadata: { kma_job_id: body.get("metadata[kma_job_id]") },
      };
      transfer.amount_reversed = Number(transfer.amount_reversed) +
        value.amount;
      this.reversals.set(value.id, value);
      this.mutations.set(key, value);
      return reply(value);
    }
    if (path.startsWith("transfers/")) {
      return reply(this.transfers.get(path.slice(10)));
    }
    if (path.startsWith("payouts/")) {
      return reply(
        this.payouts.get(`${headers.get("Stripe-Account")}:${path.slice(8)}`),
      );
    }
    if (path.startsWith("charges/")) {
      return reply(this.charges.get(path.slice(8)));
    }
    if (path.startsWith("payment_intents/")) {
      return reply(this.payments.get(path.slice(16)));
    }
    if (path === "refunds") {
      return reply({
        data: [...this.refunds.values()].filter((refund) =>
          refund.charge === url.searchParams.get("charge")
        ),
        has_more: false,
      });
    }
    if (path.startsWith("refunds/")) {
      return reply(this.refunds.get(path.slice(8)));
    }
    if (path.startsWith("disputes/")) {
      return reply(this.disputes.get(path.slice(9)));
    }
    throw new Error(`Unexpected fake Stripe route ${method} ${path}`);
  };
}
