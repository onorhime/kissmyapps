// deno-lint-ignore-file require-await -- Fake adapters preserve the asynchronous production boundary.
import { assert, assertEquals } from "@std/assert";
import type { CreatorAuthentication } from "../creator-connect/auth-policy.ts";
import {
  type AccountSnapshot,
  ConnectProvider,
} from "../creator-connect/provider.ts";
import { programPayoutBindings } from "./config.ts";
import {
  createProgramPayoutAccountHandler,
  type CreatorRpc,
  payoutContext,
  type ProgramPayoutAccountDependencies,
} from "./index.ts";
import {
  BINDING_ID,
  fakeEnv,
  fakeUuid,
  LIVE_KEY,
  LiveStripe,
  ORIGIN,
  PLATFORM,
  PUBLISHABLE,
} from "./testing.ts";

const NOW = Date.now();
const SESSION = ["Bearer", "fixture-creator-session"].join(" ");

function call(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://functions.example/program-payout-account", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Authorization: SESSION,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function world(
  options: {
    /** The creator already has a Stripe account. */
    connected?: boolean;
    /** What the database says to program_creator_payout_context. */
    gate?: "allowed" | "refused" | "broken";
    /** Seconds since the creator signed in. */
    signedInAgo?: number;
  } = {},
  overrides: Partial<ProgramPayoutAccountDependencies> = {},
) {
  const { connected = false, gate = "allowed", signedInAgo = 30 } = options;
  const stripe = new LiveStripe();
  const creator = {
    id: "acct_FakeCreator",
    affiliateId: fakeUuid(),
    accountKey: fakeUuid(),
  };
  if (connected) stripe.addAccount(creator);
  const asked: { authorization: string; name: string; args: unknown }[] = [];
  const rpc: CreatorRpc = async (authorization, name, args) => {
    asked.push({ authorization, name, args });
    if (gate === "refused") return { data: null, error: { code: "42501" } };
    if (gate === "broken") return { data: null, error: { code: "XX000" } };
    return {
      data: {
        affiliate_id: creator.affiliateId,
        account_key: creator.accountKey,
        connect_account_id: connected ? creator.id : null,
        platform_account_id: PLATFORM,
        livemode: true,
        created_at: new Date(NOW).toISOString(),
      },
      error: null,
    };
  };
  const reserved: { country: string; actor: string }[] = [];
  const stored: AccountSnapshot[] = [];
  const authentication: CreatorAuthentication = {
    userId: "creator-user",
    assuranceLevel: "aal1",
    methods: [{ method: "otp", timestamp: NOW / 1000 - signedInAgo }],
    hasVerifiedMfa: false,
  };
  const handler = createProgramPayoutAccountHandler({
    enabled: () => true,
    bindings: () => programPayoutBindings(fakeEnv()),
    authenticate: async () => authentication,
    context: payoutContext(rpc),
    reserve: async (_context, country, actor) => {
      reserved.push({ country, actor });
      return {
        country,
        first_account_attempt_at: new Date(NOW).toISOString(),
      };
    },
    persist: async (_context, snapshot) => {
      stored.push(snapshot);
    },
    provider: (config) => new ConnectProvider(config, stripe.fetch, () => NOW),
    now: () => NOW,
    ...overrides,
  });
  const ask = async (body: unknown, headers: Record<string, string> = {}) => {
    const response = await handler(call(body, headers));
    return {
      status: response.status,
      allowedOrigin: response.headers.get("Access-Control-Allow-Origin"),
      body: await response.json(),
    };
  };
  return { stripe, creator, asked, reserved, stored, handler, ask };
}

Deno.test("switched off: 503 program_payouts_disabled and nothing is read", async () => {
  const untouched = () => {
    throw new Error("must not run");
  };
  const w = world({}, {
    enabled: () => false,
    bindings: untouched,
    authenticate: untouched,
    context: untouched,
    provider: untouched,
  });
  const answer = await w.ask({ action: "status" });
  assertEquals(answer.status, 503);
  // The body shape of program-balance when it is off.
  assertEquals(Object.keys(answer.body).sort(), [
    "error",
    "message",
    "request_id",
  ]);
  assertEquals(answer.body.error, "program_payouts_disabled");
  // The dashboard can read the answer.
  assertEquals(answer.allowedOrigin, ORIGIN);
  const preflight = await w.handler(
    new Request("https://functions.example/program-payout-account", {
      method: "OPTIONS",
      headers: { Origin: ORIGIN },
    }),
  );
  assertEquals(preflight.status, 204);
  const get = await w.handler(
    new Request("https://functions.example/program-payout-account"),
  );
  assertEquals(get.status, 405);
  assertEquals(w.stripe.requests.length, 0);
  assertEquals(w.asked.length, 0);
});

Deno.test("a creator without a payout account is told so, with the countries to choose from", async () => {
  const w = world();
  const answer = await w.ask({ action: "status" });
  assertEquals(answer.status, 200);
  assertEquals(answer.allowedOrigin, ORIGIN);
  assertEquals(answer.body.enabled, true);
  assertEquals(answer.body.bindings.length, 1);
  const [binding] = answer.body.bindings;
  assertEquals(
    [
      binding.binding_id,
      binding.platform_account_id,
      binding.livemode,
      binding.status,
      binding.connected_account_id,
    ],
    [BINDING_ID, PLATFORM, true, "not_connected", null],
  );
  // A Canadian platform with the cross-border policy.
  assertEquals(binding.eligibility.platform_country, "CA");
  assertEquals(binding.allowed_countries, ["CA", "GB", "US"]);

  // The database was asked as the creator, through the program gate, for
  // the console platform in live mode.
  assertEquals(w.asked, [{
    authorization: SESSION,
    name: "program_creator_payout_context",
    args: { p_platform_account_id: PLATFORM, p_livemode: true },
  }]);
  // Reading makes nothing at Stripe and stores nothing.
  assertEquals(w.stripe.requests.filter((r) => r.method !== "GET"), []);
  assertEquals(w.stored, []);
  assert(
    w.stripe.requests.every((r) => r.authorization === `Bearer ${LIVE_KEY}`),
  );
});

Deno.test("starting setup makes the creator's Stripe account and opens embedded onboarding", async () => {
  const w = world();
  // A country has to be chosen first.
  const early = await w.ask({ action: "session", binding_id: BINDING_ID });
  assertEquals([early.status, early.body.error], [400, "country_required"]);

  const answer = await w.ask({
    action: "session",
    binding_id: BINDING_ID,
    country: "US",
  });
  assertEquals(answer.status, 200);
  const session = answer.body.account_session;
  assertEquals(
    [
      session.binding_id,
      session.platform_account_id,
      session.livemode,
      session.publishable_key,
      session.connected_account_id,
    ],
    [BINDING_ID, PLATFORM, true, PUBLISHABLE, "acct_newcreator"],
  );
  assertEquals(answer.body.bindings[0].status, "needs_information");
  // No hosted onboarding address is ever handed out.
  assertEquals(answer.body.onboarding_url, undefined);

  assertEquals(w.reserved, [{ country: "US", actor: "creator-user" }]);
  const [created] = w.stripe.posts(/^\/v1\/accounts$/);
  assertEquals(
    [
      created.params.country,
      created.params["metadata[kma_affiliate_id]"],
      created.params["metadata[kma_platform_account_id]"],
      created.params["metadata[kma_account_key]"],
      created.params["capabilities[transfers][requested]"],
      created.idempotencyKey,
    ],
    [
      "US",
      w.creator.affiliateId,
      PLATFORM,
      w.creator.accountKey,
      "true",
      `kma-connect-account:${w.creator.accountKey}`,
    ],
  );
  // What Stripe says about the new account is stored.
  assertEquals(w.stored.map((s) => s.account_id), ["acct_newcreator"]);
  assertEquals(w.stored[0].transfers_active, false);
});

Deno.test("opening setup needs a recent sign-in", async () => {
  const w = world({ signedInAgo: 3600 });
  const answer = await w.ask({
    action: "session",
    binding_id: BINDING_ID,
    country: "US",
  });
  assertEquals(
    [answer.status, answer.body.error],
    [403, "reauthentication_required"],
  );
  assertEquals(w.stripe.posts(/./), []);
});

Deno.test("a finished account reads as ready, and its state is stored", async () => {
  const w = world({ connected: true });
  const answer = await w.ask({ action: "status" });
  assertEquals(answer.status, 200);
  const [binding] = answer.body.bindings;
  assertEquals(
    [
      binding.status,
      binding.connected_account_id,
      binding.transfers_enabled,
      binding.payouts_enabled,
      binding.allowed_transfer_currencies,
    ],
    ["ready", w.creator.id, true, true, ["USD"]],
  );
  assertEquals(w.stored.map((s) => s.account_id), [w.creator.id]);
  assertEquals(w.stripe.posts(/./), []);
});

Deno.test("a creator the database does not allow gets no payout account", async () => {
  const w = world({ gate: "refused" });
  const status = await w.ask({ action: "status" });
  assertEquals([status.status, status.body], [200, {
    enabled: true,
    bindings: [],
  }]);
  const session = await w.ask({
    action: "session",
    binding_id: BINDING_ID,
    country: "US",
  });
  assertEquals(
    [session.status, session.body.error],
    [403, "binding_unavailable"],
  );
  assertEquals(w.stripe.requests.length, 0);
  assertEquals(w.reserved, []);
});

Deno.test("a database failure is not mistaken for a refusal", async () => {
  const w = world({ gate: "broken" });
  const answer = await w.ask({ action: "status" });
  assertEquals(
    [answer.status, answer.body.error],
    [503, "database_boundary_error"],
  );
  assertEquals(w.stripe.requests.length, 0);
});

Deno.test("signed out, another origin, another binding, extra input: refused before the database", async () => {
  const w = world();
  const signedOut = await w.ask({ action: "status" }, { Authorization: "" });
  assertEquals(signedOut.status, 401);
  const elsewhere = await w.ask({ action: "status" }, {
    Origin: "https://elsewhere.example",
  });
  assertEquals(
    [elsewhere.status, elsewhere.body.error],
    [403, "origin_rejected"],
  );
  const other = await w.ask({ action: "status", binding_id: "legacy" });
  assertEquals([other.status, other.body.error], [403, "binding_unavailable"]);
  const extra = await w.ask({ action: "status", affiliate_id: fakeUuid() });
  assertEquals([extra.status, extra.body.error], [400, "invalid_input"]);
  assertEquals(w.asked.length, 0);
  assertEquals(w.stripe.requests.length, 0);
});

Deno.test("no console binding: the answer creator-connect gives without bindings", async () => {
  const untouched = () => {
    throw new Error("must not run");
  };
  const w = world({}, {
    bindings: () => programPayoutBindings(fakeEnv({})),
    context: untouched,
    provider: untouched,
  });
  const answer = await w.ask({ action: "status" });
  assertEquals([answer.status, answer.body], [200, {
    enabled: false,
    bindings: [],
  }]);
});
