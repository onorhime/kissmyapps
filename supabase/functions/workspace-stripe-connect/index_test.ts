// deno-lint-ignore-file require-await -- Fakes retain the production asynchronous boundary.
// Nothing here reaches Stripe or Supabase: the database is an in-memory fake that
// follows the rules of the real functions, and Stripe is a fake fetch.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  ConfigurationError,
  DatabaseBoundaryError,
  RequestError,
} from "../_shared/errors.ts";
import type { Json } from "../merchant-connect/provider.ts";
import {
  type ConsoleConnectConfig,
  consoleConnectConfig,
  consoleConnectEnabled,
  consoleConnectOrigin,
} from "./config.ts";
import {
  createWorkspaceStripeConnectHandler,
  databaseError,
  stateHash,
  verifiedIdentity,
} from "./index.ts";
import { ConsoleStripeProvider } from "./stripe.ts";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const WORKSPACE = "c9000000-0000-4000-8000-0000000000aa";
const OWNER = "c9000000-0000-4000-8000-000000000001";
const ADMIN = "c9000000-0000-4000-8000-000000000002";
const DEVELOPER = "c9000000-0000-4000-8000-000000000003";
const ANALYST = "c9000000-0000-4000-8000-000000000004";
const OUTSIDER = "c9000000-0000-4000-8000-000000000005";
const UNCONFIRMED = "c9000000-0000-4000-8000-000000000006";
const ROLES: Record<string, string> = {
  [OWNER]: "owner",
  [ADMIN]: "admin",
  [DEVELOPER]: "developer",
  [ANALYST]: "analyst",
};
const STATE = "s".repeat(43);
const CODE = "ac_FakeAuthorisationCode";
const ORIGIN = "https://merchant.kissmyapps.example";
const ENDPOINT = "https://functions.example/workspace-stripe-connect";
// Assembled so that no key-shaped literal sits in the repository.
const LIVE_KEY = ["sk", "live", "fakeConsoleKey"].join("_");
const CONFIG: ConsoleConnectConfig = {
  platformAccountId: "acct_Platform",
  clientId: "ca_ConsoleClient",
  secret: LIVE_KEY,
  origin: ORIGIN,
  callbackUrl: `${ORIGIN}/`,
};
const ENV: Record<string, string> = {
  CONSOLE_CONNECT_ENABLED: "true",
  CONSOLE_CONNECT_PLATFORM_ACCOUNT: CONFIG.platformAccountId,
  CONSOLE_CONNECT_CLIENT_ID: CONFIG.clientId,
  CONSOLE_CONNECT_STRIPE_SECRET: LIVE_KEY,
  CONSOLE_CONNECT_ORIGIN: ORIGIN,
  CONSOLE_CONNECT_CALLBACK_URL: CONFIG.callbackUrl,
};
const env = (values: Record<string, string>) => (name: string) => values[name];
const NO_PAYMENTS = {
  seen: 0,
  tagged: 0,
  last_at: null,
  last_tagged_at: null,
};
const SUMMARY = {
  seen: 3,
  tagged: 2,
  last_at: "2026-11-13T11:58:00+00:00",
  last_tagged_at: "2026-11-13T11:40:00+00:00",
};
const CONNECTED = {
  status: "active",
  account_id: "acct_Merchant",
  business_name: "SpeakSix Ltd",
  country: "GB",
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  connected_at: "2026-11-13T12:00:00+00:00",
};
const STRIPE_ACCOUNT = {
  id: "acct_Merchant",
  object: "account",
  type: "standard",
  country: "GB",
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  business_profile: { name: "SpeakSix Ltd" },
  email: "SECRET_ACCOUNT_EMAIL@example.invalid",
};
const TOKEN_URL = "https://connect.stripe.com/oauth/token";
const DEAUTHORIZE_URL = "https://connect.stripe.com/oauth/deauthorize";
const ACCOUNT_URL = "https://api.stripe.com/v1/account";

interface Options {
  enabled?: boolean;
  config?: () => ConsoleConnectConfig;
  connection?: Json | null;
  connectionPlatform?: string;
  productsAssigned?: boolean;
  accountInUse?: boolean;
  summary?: "unavailable" | "not_a_member" | Json;
  databaseDown?: boolean;
  statePlatform?: string;
  token?: "rejected" | "network" | "unreadable";
  tokenBody?: Json;
  account?: Json;
  accountRead?: "rejected";
  platform?: "other" | "rejected";
  deauthorize?: "rejected" | "network" | "other_account";
  random?: () => string;
}

function fixture(options: Options = {}) {
  const rpcCalls: Array<{ name: string; input: Json }> = [];
  const calls: Array<
    { url: string; method: string; headers: Headers; body: string }
  > = [];
  const logs: Json[] = [];
  const configReads: number[] = [];
  let connection: Json | null = options.connection ?? null;
  const states = new Map<
    string,
    {
      user: string;
      consumed: boolean;
      invalidated: boolean;
      activated: boolean;
    }
  >();
  function fail(code: string, details?: string): never {
    throw databaseError({ code, details, message: "SECRET_DATABASE_MESSAGE" });
  }
  const role = (input: Json, manage = false): string => {
    const found = input.workspace_id === WORKSPACE
      ? ROLES[String(input.user_id)]
      : undefined;
    if (!found) fail("42501", "not_a_member");
    if (manage && !["owner", "admin"].includes(found)) {
      fail("42501", "owner_or_admin_required");
    }
    return found;
  };
  const rpc = async (name: string, args: Json): Promise<Json> => {
    const input = args.p_input as Json;
    rpcCalls.push({ name, input });
    if (options.databaseDown) fail("57P03");
    switch (name) {
      case "workspace_stripe_status": {
        const found = role(input);
        return {
          role: found,
          can_manage: ["owner", "admin"].includes(found),
          connection,
        };
      }
      case "workspace_stripe_payment_summary":
        if (options.summary === "unavailable") fail("PGRST202");
        if (options.summary === "not_a_member") fail("42501");
        role(input);
        return options.summary as Json ?? SUMMARY;
      case "begin_workspace_stripe_connect":
        role(input, true);
        for (const state of states.values()) {
          if (!state.activated) state.invalidated = true;
        }
        states.set(String(input.state_sha256), {
          user: String(input.user_id),
          consumed: false,
          invalidated: false,
          activated: false,
        });
        return { workspace_id: WORKSPACE, expires_at: input.expires_at };
      case "consume_workspace_stripe_oauth": {
        const state = states.get(String(input.state_sha256));
        if (
          !state || state.user !== input.user_id || state.consumed ||
          state.invalidated
        ) return fail("42501", "state_invalid");
        state.consumed = true;
        return {
          workspace_id: WORKSPACE,
          platform_account_id: options.statePlatform ??
            CONFIG.platformAccountId,
        };
      }
      case "activate_workspace_stripe_connection": {
        const state = states.get(String(input.state_sha256));
        if (input.livemode !== true) fail("22023", "stripe_not_live");
        if (
          !state || state.user !== input.user_id || !state.consumed ||
          state.invalidated || state.activated
        ) return fail("42501", "state_invalid");
        if (!input.charges_enabled || !input.details_submitted) {
          fail("55000", "stripe_account_not_ready");
        }
        if (options.accountInUse) fail("23505", "stripe_account_in_use");
        if (
          options.productsAssigned && connection &&
          connection.account_id !== input.account_id
        ) fail("55000", "connection_in_use");
        state.activated = true;
        connection = {
          status: "active",
          account_id: input.account_id,
          business_name: input.business_name,
          country: input.country,
          charges_enabled: input.charges_enabled,
          payouts_enabled: input.payouts_enabled,
          details_submitted: input.details_submitted,
          connected_at: CONNECTED.connected_at,
          // A column the console must never be shown.
          confirmed_by: "SECRET_INTERNAL_COLUMN",
        };
        return {
          workspace_id: WORKSPACE,
          merchant_id: "c9000000-0000-4000-8000-0000000000b1",
          connection_id: "c9000000-0000-4000-8000-0000000000b2",
          can_manage: true,
          connection,
        };
      }
      case "disconnect_workspace_stripe": {
        role(input, true);
        if (!connection || connection.status !== "active") {
          return {
            account_id: null,
            platform_account_id: null,
            disconnected: false,
          };
        }
        if (options.productsAssigned) fail("55000", "connection_in_use");
        const accountId = connection.account_id;
        connection = { ...connection, status: "revoked" };
        return {
          account_id: accountId,
          platform_account_id: options.connectionPlatform ??
            CONFIG.platformAccountId,
          disconnected: true,
        };
      }
      default:
        throw new Error(`unexpected database call ${name}`);
    }
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: String(init?.body ?? ""),
    });
    const rejected = () =>
      Response.json({
        error: {
          message: "SECRET_PROVIDER_BODY",
          code: "SECRET_PROVIDER_BODY",
        },
        error_description: "SECRET_PROVIDER_BODY",
      }, { status: 400 });
    if (url === TOKEN_URL) {
      if (options.token === "network") throw new TypeError("SECRET_NETWORK");
      if (options.token === "rejected") return rejected();
      if (options.token === "unreadable") {
        return new Response("SECRET_PROVIDER_BODY", { status: 200 });
      }
      return Response.json({
        stripe_user_id: "acct_Merchant",
        token_type: "bearer",
        scope: "read_write",
        livemode: true,
        access_token: "SECRET_ACCESS_TOKEN",
        refresh_token: "SECRET_REFRESH_TOKEN",
        stripe_publishable_key: "SECRET_PUBLISHABLE_KEY",
        ...options.tokenBody,
      });
    }
    if (url === DEAUTHORIZE_URL) {
      if (options.deauthorize === "network") {
        throw new TypeError("SECRET_NETWORK");
      }
      if (options.deauthorize === "rejected") return rejected();
      return Response.json({
        stripe_user_id: options.deauthorize === "other_account"
          ? "acct_SomeoneElse"
          : new URLSearchParams(String(init?.body)).get("stripe_user_id"),
      });
    }
    if (url === ACCOUNT_URL && headers.has("Stripe-Account")) {
      if (options.accountRead === "rejected") return rejected();
      return Response.json({ ...STRIPE_ACCOUNT, ...options.account });
    }
    if (url === ACCOUNT_URL) {
      if (options.platform === "rejected") return rejected();
      return Response.json({
        id: options.platform === "other"
          ? "acct_AnotherPlatform"
          : CONFIG.platformAccountId,
      });
    }
    throw new Error(`unexpected request to ${url}`);
  };
  const handler = createWorkspaceStripeConnectHandler({
    enabled: () => options.enabled ?? true,
    origin: () => ORIGIN,
    config: () => {
      configReads.push(1);
      return (options.config ?? (() => CONFIG))();
    },
    authenticate: async (authorization) => {
      const userId = authorization.slice(7);
      if (userId === UNCONFIRMED) return verifiedIdentity({ id: userId });
      return { userId };
    },
    rpc,
    provider: (config) => new ConsoleStripeProvider(config, fetcher),
    random: options.random ?? (() => STATE),
    now: () => NOW,
    log: (entry) => logs.push(entry),
  });
  const names = () => rpcCalls.map((call) => call.name);
  const sent = (url: string) => calls.filter((call) => call.url === url);
  return { handler, rpcCalls, calls, logs, configReads, names, sent, states };
}

function request(
  body: unknown,
  options: {
    user?: string | null;
    origin?: string | null;
    method?: string;
    authorization?: string;
    contentType?: string;
    raw?: string;
  } = {},
) {
  const user = options.user === undefined ? OWNER : options.user;
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const method = options.method ?? "POST";
  const authorization = options.authorization ??
    (user ? `Bearer ${user}` : undefined);
  return new Request(ENDPOINT, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      "Content-Type": options.contentType ?? "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: method === "POST" ? options.raw ?? JSON.stringify(body) : undefined,
  });
}
// The response as the browser reads it, with a check that nothing private is in it.
async function read(response: Response) {
  const text = await response.text();
  for (
    const secret of ["SECRET", LIVE_KEY, CODE, STATE, "access_token", "sk_"]
  ) {
    assert(!text.includes(secret), `response leaks ${secret}: ${text}`);
  }
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function failure(response: Response, status: number, code: string) {
  const result = await read(response);
  assertEquals([result.status, result.body.error], [status, code]);
  assertEquals(Object.keys(result.body).sort(), [
    "error",
    "message",
    "request_id",
  ]);
  return result.body;
}
const status = { action: "status", workspace_id: WORKSPACE };
const start = { action: "start", workspace_id: WORKSPACE };
const complete = { action: "complete", state: STATE, code: CODE };
const disconnect = { action: "disconnect", workspace_id: WORKSPACE };

// Configuration ---------------------------------------------------------------

Deno.test("the feature is off unless switched on, and reads no key while off", () => {
  const read: string[] = [];
  for (const value of [undefined, "", "false", "TRUE", "1", " true"]) {
    assertEquals(
      consoleConnectEnabled((name) => {
        read.push(name);
        return value;
      }),
      false,
    );
  }
  assertEquals(new Set(read), new Set(["CONSOLE_CONNECT_ENABLED"]));
  assertEquals(consoleConnectEnabled(env(ENV)), true);
});

Deno.test("configuration accepts a live key and the console's own callback", () => {
  assertEquals(consoleConnectConfig(env(ENV)), CONFIG);
  assertEquals(consoleConnectOrigin(env(ENV)), ORIGIN);
  // The callback is sent to Stripe exactly as configured.
  assertEquals(
    consoleConnectConfig(
      env({ ...ENV, CONSOLE_CONNECT_CALLBACK_URL: `${ORIGIN}/?app=merchant` }),
    ).callbackUrl,
    `${ORIGIN}/?app=merchant`,
  );
});

Deno.test("configuration rejects anything that is not a live secret key", () => {
  for (
    const secret of [
      "",
      ["sk", "test", "fakeConsoleKey"].join("_"),
      ["rk", "live", "fakeConsoleKey"].join("_"),
      ["pk", "live", "fakeConsoleKey"].join("_"),
      "sk_live_",
      `${LIVE_KEY} extra`,
      "live",
    ]
  ) {
    assertThrows(
      () =>
        consoleConnectConfig(
          env({ ...ENV, CONSOLE_CONNECT_STRIPE_SECRET: secret }),
        ),
      ConfigurationError,
    );
  }
});

Deno.test("configuration rejects a wrong platform, client, origin or callback", () => {
  const bad: Array<Record<string, string>> = [
    { CONSOLE_CONNECT_PLATFORM_ACCOUNT: "" },
    { CONSOLE_CONNECT_PLATFORM_ACCOUNT: "platform" },
    { CONSOLE_CONNECT_CLIENT_ID: "" },
    { CONSOLE_CONNECT_CLIENT_ID: "acct_Platform" },
    { CONSOLE_CONNECT_CALLBACK_URL: "" },
    { CONSOLE_CONNECT_CALLBACK_URL: "https://elsewhere.example/" },
    { CONSOLE_CONNECT_CALLBACK_URL: `http://${new URL(ORIGIN).host}/` },
    { CONSOLE_CONNECT_CALLBACK_URL: `${ORIGIN}/#connections` },
    {
      CONSOLE_CONNECT_CALLBACK_URL: `https://user:pw@${new URL(ORIGIN).host}/`,
    },
    { CONSOLE_CONNECT_ORIGIN: "" },
    { CONSOLE_CONNECT_ORIGIN: "*" },
    { CONSOLE_CONNECT_ORIGIN: `${ORIGIN}/` },
    { CONSOLE_CONNECT_ORIGIN: `${ORIGIN}/console` },
    { CONSOLE_CONNECT_ORIGIN: "http://merchant.kissmyapps.example" },
    { CONSOLE_CONNECT_ORIGIN: "http://localhost:5173" },
  ];
  for (const change of bad) {
    assertThrows(
      () => consoleConnectConfig(env({ ...ENV, ...change })),
      ConfigurationError,
      undefined,
      JSON.stringify(change),
    );
  }
});

Deno.test("a local http origin needs the explicit local switch", () => {
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
    const local = {
      ...ENV,
      CONSOLE_CONNECT_ORIGIN: origin,
      CONSOLE_CONNECT_CALLBACK_URL: `${origin}/?app=merchant`,
    };
    assertThrows(() => consoleConnectOrigin(env(local)), ConfigurationError);
    const allowed = env({ ...local, CONSOLE_CONNECT_ALLOW_LOCAL: "true" });
    assertEquals(consoleConnectOrigin(allowed), origin);
    assertEquals(consoleConnectConfig(allowed).origin, origin);
  }
  // The switch does not open plain http anywhere else.
  assertThrows(
    () =>
      consoleConnectOrigin(env({
        ...ENV,
        CONSOLE_CONNECT_ORIGIN: "http://merchant.kissmyapps.example",
        CONSOLE_CONNECT_ALLOW_LOCAL: "true",
      })),
    ConfigurationError,
  );
});

// The boundary: origin, method, body, sign-in ------------------------------------

Deno.test("feature disabled: status says so, every other action is 503", async () => {
  const f = fixture({ enabled: false, connection: CONNECTED });
  assertEquals(await read(await f.handler(request(status))), {
    status: 200,
    body: {
      enabled: false,
      workspace_id: WORKSPACE,
      can_manage: false,
      connection: null,
      payments: NO_PAYMENTS,
    },
  });
  for (const body of [start, complete, disconnect]) {
    await failure(
      await f.handler(request(body)),
      503,
      "console_connect_disabled",
    );
  }
  // Off means off: no database call, no Stripe call, and the key is never read.
  assertEquals([f.rpcCalls, f.calls, f.configReads], [[], [], []]);
});

Deno.test("feature disabled still requires the console origin and a signed-in user", async () => {
  const f = fixture({ enabled: false });
  await failure(
    await f.handler(request(status, { origin: "https://evil.example" })),
    403,
    "origin_rejected",
  );
  await failure(
    await f.handler(request(status, { user: null })),
    401,
    "unauthorized",
  );
});

Deno.test("wrong Origin is rejected before anything else happens", async () => {
  const f = fixture({ connection: CONNECTED });
  for (
    const origin of [
      "https://evil.example",
      "https://kissmyapps.example",
      `${ORIGIN}.evil.example`,
      "http://merchant.kissmyapps.example",
      "null",
      null,
    ]
  ) {
    for (const body of [status, start, complete, disconnect]) {
      const response = await f.handler(request(body, { origin }));
      assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
      await failure(response, 403, "origin_rejected");
    }
    const preflight = await f.handler(
      request(null, { origin, method: "OPTIONS", user: null }),
    );
    assertEquals(preflight.status, 403);
    assertEquals(preflight.headers.get("Access-Control-Allow-Origin"), null);
    await preflight.body?.cancel();
  }
  assertEquals([f.rpcCalls, f.calls, f.configReads], [[], [], []]);
});

Deno.test("the console origin gets a preflight answer and CORS on every response", async () => {
  const f = fixture();
  const preflight = await f.handler(
    request(null, { method: "OPTIONS", user: null }),
  );
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assertEquals(preflight.headers.get("Vary"), "Origin");
  assert(
    preflight.headers.get("Access-Control-Allow-Headers")?.includes(
      "authorization",
    ),
  );
  const ok = await f.handler(request(status));
  assertEquals(ok.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assertEquals(ok.headers.get("Cache-Control"), "no-store, max-age=0");
  await ok.body?.cancel();
  const refused = await f.handler(request(status, { user: OUTSIDER }));
  assertEquals(refused.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  await refused.body?.cancel();
  await failure(
    await f.handler(request(null, { method: "GET" })),
    405,
    "method_not_allowed",
  );
});

Deno.test("an unset or invalid console origin fails closed", async () => {
  const handler = createWorkspaceStripeConnectHandler({
    origin: () => consoleConnectOrigin(env({})),
    authenticate: async () => ({ userId: OWNER }),
    rpc: async () => {
      throw new Error("must not be called");
    },
  });
  const response = await handler(request(status));
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
  await failure(response, 503, "configuration_error");
});

Deno.test("missing or malformed sign-in is 401", async () => {
  const f = fixture({ connection: CONNECTED });
  for (
    const authorization of [
      "",
      "Bearer",
      "Bearer short",
      `Basic ${OWNER}`,
      `Bearer ${OWNER} extra`,
      `bearer ${OWNER}`,
    ]
  ) {
    for (const body of [status, start, complete, disconnect]) {
      await failure(
        await f.handler(request(body, { user: null, authorization })),
        401,
        "unauthorized",
      );
    }
  }
  assertEquals([f.rpcCalls, f.calls], [[], []]);
});

Deno.test("an unconfirmed, anonymous or missing user is 401", async () => {
  const f = fixture({ connection: CONNECTED });
  for (const body of [status, start, complete, disconnect]) {
    await failure(
      await f.handler(request(body, { user: UNCONFIRMED })),
      401,
      "verified_email_required",
    );
  }
  assertEquals([f.rpcCalls, f.calls], [[], []]);
  const confirmed = {
    id: OWNER,
    email: "owner@acme.example",
    email_confirmed_at: "2026-11-01T00:00:00Z",
  };
  assertEquals(verifiedIdentity(confirmed), { userId: OWNER });
  assertEquals(verifiedIdentity({ ...confirmed, id: OWNER.toUpperCase() }), {
    userId: OWNER,
  });
  for (
    const user of [
      null,
      undefined,
      {},
      { ...confirmed, email_confirmed_at: null },
      { ...confirmed, email_confirmed_at: undefined },
      { ...confirmed, email: "" },
      { ...confirmed, email: undefined },
      { ...confirmed, is_anonymous: true },
      { ...confirmed, id: "not-a-user" },
      { ...confirmed, id: undefined },
    ]
  ) {
    const error = assertThrows(() => verifiedIdentity(user), RequestError);
    assertEquals([error.status, error.code], [401, "verified_email_required"]);
  }
});

Deno.test("unknown actions, extra, missing or malformed fields are rejected", async () => {
  const f = fixture({ connection: CONNECTED });
  const bad: unknown[] = [
    {},
    { workspace_id: WORKSPACE },
    { action: "revoke", workspace_id: WORKSPACE },
    { action: "create_invitation", workspace_id: WORKSPACE },
    { action: "__proto__", workspace_id: WORKSPACE },
    { action: "constructor", workspace_id: WORKSPACE },
    { action: ["status"], workspace_id: WORKSPACE },
    { action: "status" },
    { action: "status", workspace_id: WORKSPACE, user_id: OWNER },
    { action: "status", workspace_id: WORKSPACE, livemode: false },
    { action: "status", workspace_id: "not-a-workspace" },
    { action: "status", workspace_id: null },
    { action: "status", workspace_id: [WORKSPACE] },
    { action: "start", workspace_id: WORKSPACE, livemode: false },
    { action: "start", workspace_id: WORKSPACE, mode: "test" },
    {
      action: "start",
      workspace_id: WORKSPACE,
      redirect_uri: "https://evil.example",
    },
    { action: "start" },
    { action: "complete", state: STATE },
    { action: "complete", code: CODE },
    { action: "complete", state: STATE, code: CODE, workspace_id: WORKSPACE },
    {
      action: "complete",
      state: STATE,
      code: CODE,
      account_id: "acct_Merchant",
    },
    { action: "complete", state: "short", code: CODE },
    { action: "complete", state: `${STATE}x`, code: CODE },
    { action: "complete", state: STATE, code: "not-a-code" },
    { action: "complete", state: STATE, code: "ac_bad code" },
    { action: "complete", state: 1, code: CODE },
    {
      action: "disconnect",
      workspace_id: WORKSPACE,
      account_id: "acct_Merchant",
    },
    { action: "disconnect" },
    [status],
    "status",
    null,
  ];
  for (const body of bad) {
    const response = await f.handler(request(body));
    await failure(response, 400, "invalid_input");
  }
  await failure(
    await f.handler(request(null, { raw: "{not json" })),
    400,
    "invalid_json",
  );
  await failure(await f.handler(request(null, { raw: "" })), 400, "empty_body");
  await failure(
    await f.handler(request(status, { contentType: "text/plain" })),
    415,
    "unsupported_media_type",
  );
  await failure(
    await f.handler(
      request({ ...status, padding: "x".repeat(5000) }),
    ),
    413,
    "payload_too_large",
  );
  assertEquals([f.rpcCalls, f.calls], [[], []]);
});

Deno.test("non-live key in configuration: enabled actions are 503 and never reach Stripe", async () => {
  const f = fixture({
    connection: CONNECTED,
    config: () =>
      consoleConnectConfig(env({
        ...ENV,
        CONSOLE_CONNECT_STRIPE_SECRET: ["sk", "test", "fakeConsoleKey"].join(
          "_",
        ),
      })),
  });
  for (const body of [status, start, complete, disconnect]) {
    await failure(await f.handler(request(body)), 503, "configuration_error");
  }
  assertEquals([f.rpcCalls, f.calls], [[], []]);
});

// status ------------------------------------------------------------------------

Deno.test("status: a member with no connection sees zeros, and payments are not asked for", async () => {
  const f = fixture();
  assertEquals(await read(await f.handler(request(status))), {
    status: 200,
    body: {
      enabled: true,
      workspace_id: WORKSPACE,
      can_manage: true,
      connection: null,
      payments: NO_PAYMENTS,
    },
  });
  assertEquals(f.rpcCalls, [{
    name: "workspace_stripe_status",
    input: { workspace_id: WORKSPACE, user_id: OWNER },
  }]);
  assertEquals(f.calls, []);
});

Deno.test("status: an active connection comes with its payment summary", async () => {
  const f = fixture({ connection: CONNECTED });
  assertEquals(await read(await f.handler(request(status))), {
    status: 200,
    body: {
      enabled: true,
      workspace_id: WORKSPACE,
      can_manage: true,
      connection: CONNECTED,
      payments: SUMMARY,
    },
  });
  assertEquals(f.rpcCalls, [
    {
      name: "workspace_stripe_status",
      input: { workspace_id: WORKSPACE, user_id: OWNER },
    },
    {
      name: "workspace_stripe_payment_summary",
      input: { workspace_id: WORKSPACE, user_id: OWNER },
    },
  ]);
  // Status never calls Stripe.
  assertEquals(f.calls, []);
});

Deno.test("status: owner and admin can manage; developer and analyst can only look", async () => {
  const f = fixture({ connection: CONNECTED });
  for (
    const [user, canManage] of [
      [OWNER, true],
      [ADMIN, true],
      [DEVELOPER, false],
      [ANALYST, false],
    ] as const
  ) {
    const { body } = await read(await f.handler(request(status, { user })));
    assertEquals([body.can_manage, body.connection], [canManage, CONNECTED]);
  }
});

Deno.test("status: someone outside the workspace is 403 not_a_member", async () => {
  const f = fixture({ connection: CONNECTED });
  await failure(
    await f.handler(request(status, { user: OUTSIDER })),
    403,
    "not_a_member",
  );
  await failure(
    await f.handler(
      request({
        action: "status",
        workspace_id: "c9000000-0000-4000-8000-0000000000ff",
      }),
    ),
    403,
    "not_a_member",
  );
  assertEquals(f.names(), [
    "workspace_stripe_status",
    "workspace_stripe_status",
  ]);
});

Deno.test("status: a revoked or pending connection reads as not connected", async () => {
  for (const state of ["revoked", "pending"]) {
    const f = fixture({ connection: { ...CONNECTED, status: state } });
    const { body } = await read(await f.handler(request(status)));
    assertEquals([body.connection, body.payments], [null, NO_PAYMENTS]);
    assertEquals(f.names(), ["workspace_stripe_status"]);
  }
});

Deno.test("status: only the agreed fields leave, whatever the database returns", async () => {
  const f = fixture({
    connection: {
      ...CONNECTED,
      platform_account_id: "acct_Platform",
      confirmed_by: OWNER,
      merchant_id: "SECRET_INTERNAL_COLUMN",
    },
    summary: { ...SUMMARY, seen: "many", tagged: -1, connection_id: "SECRET" },
  });
  const { body } = await read(await f.handler(request(status)));
  assertEquals(Object.keys(body), [
    "enabled",
    "workspace_id",
    "can_manage",
    "connection",
    "payments",
  ]);
  assertEquals(body.connection, CONNECTED);
  assertEquals(body.payments, { ...SUMMARY, seen: 0, tagged: 0 });
});

Deno.test("status: a payment summary that cannot be read is an error, not zeros", async () => {
  const unavailable = fixture({
    connection: CONNECTED,
    summary: "unavailable",
  });
  await failure(
    await unavailable.handler(request(status)),
    503,
    "database_boundary_error",
  );
  // Removed from the workspace between the two reads.
  const removed = fixture({ connection: CONNECTED, summary: "not_a_member" });
  await failure(await removed.handler(request(status)), 403, "not_a_member");
});

Deno.test("a database that is down is 503 and says nothing about why", async () => {
  const f = fixture({ databaseDown: true });
  for (const body of [status, start, complete, disconnect]) {
    await failure(
      await f.handler(request(body)),
      503,
      "database_boundary_error",
    );
  }
  assertEquals(f.calls, []);
});

// start ---------------------------------------------------------------------------

Deno.test("start: an owner gets the Stripe authorisation link for the live client", async () => {
  const f = fixture();
  // Read directly: this one response is meant to carry the state, inside the link.
  const response = await f.handler(request(start));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(Object.keys(body), ["authorization_url"]);
  const url = new URL(body.authorization_url);
  assertEquals(
    url.origin + url.pathname,
    "https://connect.stripe.com/oauth/authorize",
  );
  assertEquals(Object.fromEntries(url.searchParams), {
    response_type: "code",
    client_id: CONFIG.clientId,
    scope: "read_write",
    redirect_uri: CONFIG.callbackUrl,
    state: STATE,
  });
  assert(!body.authorization_url.includes(LIVE_KEY));
  // Only the hash of the state is stored, for ten minutes, bound to the platform.
  assertEquals(f.rpcCalls, [{
    name: "begin_workspace_stripe_connect",
    input: {
      workspace_id: WORKSPACE,
      user_id: OWNER,
      state_sha256: await stateHash(STATE),
      expires_at: "2026-11-13T12:10:00.000Z",
      platform_account_id: CONFIG.platformAccountId,
    },
  }]);
  assert(!JSON.stringify(f.rpcCalls).includes(STATE));
  // The key is checked against the configured platform, with Basic auth, once.
  assertEquals(f.calls.map((call) => [call.method, call.url]), [[
    "GET",
    ACCOUNT_URL,
  ]]);
  assertEquals(
    f.calls[0].headers.get("Authorization"),
    `Basic ${btoa(`${LIVE_KEY}:`)}`,
  );
});

Deno.test("start: an admin may start too", async () => {
  const f = fixture();
  const response = await f.handler(request(start, { user: ADMIN }));
  assertEquals(response.status, 200);
  await response.body?.cancel();
  assertEquals(f.rpcCalls[0].input.user_id, ADMIN);
});

Deno.test("start: developers, analysts and outsiders are refused before Stripe is called", async () => {
  const f = fixture();
  for (const user of [DEVELOPER, ANALYST]) {
    await failure(
      await f.handler(request(start, { user })),
      403,
      "owner_or_admin_required",
    );
  }
  await failure(
    await f.handler(request(start, { user: OUTSIDER })),
    403,
    "not_a_member",
  );
  assertEquals(f.calls, []);
  assertEquals(f.states.size, 0);
});

Deno.test("start: a key that belongs to another platform returns no link", async () => {
  const other = fixture({ platform: "other" });
  await failure(
    await other.handler(request(start)),
    503,
    "configuration_error",
  );
  const rejected = fixture({ platform: "rejected" });
  await failure(
    await rejected.handler(request(start)),
    502,
    "merchant_connection_rejected",
  );
});

// complete ------------------------------------------------------------------------

async function started(options: Options = {}, user = OWNER) {
  const f = fixture(options);
  const response = await f.handler(request(start, { user }));
  assertEquals(response.status, 200);
  await response.body?.cancel();
  f.rpcCalls.length = 0;
  f.calls.length = 0;
  return f;
}

Deno.test("complete: the user who started lands connected", async () => {
  const f = await started();
  assertEquals(await read(await f.handler(request(complete))), {
    status: 200,
    body: {
      enabled: true,
      workspace_id: WORKSPACE,
      can_manage: true,
      connection: CONNECTED,
      payments: SUMMARY,
    },
  });
  // The state is used up before Stripe is called, and the code is exchanged once.
  assertEquals(f.names(), [
    "consume_workspace_stripe_oauth",
    "activate_workspace_stripe_connection",
    "workspace_stripe_payment_summary",
  ]);
  assertEquals(f.rpcCalls[0].input, {
    state_sha256: await stateHash(STATE),
    user_id: OWNER,
  });
  assertEquals(f.rpcCalls[1].input, {
    state_sha256: await stateHash(STATE),
    user_id: OWNER,
    platform_account_id: CONFIG.platformAccountId,
    livemode: true,
    account_id: "acct_Merchant",
    business_name: "SpeakSix Ltd",
    country: "GB",
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
  });
  assertEquals(f.calls.map((call) => [call.method, call.url]), [
    ["GET", ACCOUNT_URL],
    ["POST", TOKEN_URL],
    ["GET", ACCOUNT_URL],
  ]);
  assertEquals(
    Object.fromEntries(new URLSearchParams(f.calls[1].body)),
    { code: CODE, grant_type: "authorization_code" },
  );
  assertEquals(f.calls[2].headers.get("Stripe-Account"), "acct_Merchant");
  // Tokens, the code and the raw state are never stored.
  const stored = JSON.stringify(f.rpcCalls);
  for (const secret of ["SECRET", CODE, STATE, LIVE_KEY]) {
    assert(!stored.includes(secret), `database input holds ${secret}`);
  }
});

Deno.test("complete: a state works once, and the code is not exchanged again", async () => {
  const f = await started();
  assertEquals((await f.handler(request(complete))).status, 200);
  await failure(await f.handler(request(complete)), 403, "state_invalid");
  assertEquals(f.sent(TOKEN_URL).length, 1);
  assertEquals(
    f.names().filter((n) => n === "activate_workspace_stripe_connection")
      .length,
    1,
  );
});

Deno.test("complete: an unknown state or a different user is refused before Stripe is called", async () => {
  const unknown = fixture();
  await failure(await unknown.handler(request(complete)), 403, "state_invalid");
  assertEquals(unknown.calls, []);
  const f = await started();
  for (const user of [ADMIN, DEVELOPER, OUTSIDER]) {
    await failure(
      await f.handler(request(complete, { user })),
      403,
      "state_invalid",
    );
  }
  assertEquals(f.calls, []);
  // The owner's state is untouched by those attempts.
  assertEquals((await f.handler(request(complete))).status, 200);
});

Deno.test("complete: starting again invalidates the earlier state", async () => {
  let next = STATE;
  const f = fixture({ random: () => next });
  assertEquals((await f.handler(request(start))).status, 200);
  next = "t".repeat(43);
  assertEquals((await f.handler(request(start, { user: ADMIN }))).status, 200);
  await failure(await f.handler(request(complete)), 403, "state_invalid");
  assertEquals(f.sent(TOKEN_URL).length, 0);
  const second = await read(
    await f.handler(request({ ...complete, state: next }, { user: ADMIN })),
  );
  assertEquals([second.status, second.body.connection], [200, CONNECTED]);
});

Deno.test("complete: a failed code exchange is never retried", async () => {
  for (const token of ["network", "rejected", "unreadable"] as const) {
    const f = await started({ token });
    const first = await failure(
      await f.handler(request(complete)),
      502,
      token === "rejected"
        ? "merchant_connection_rejected"
        : "merchant_provider_unavailable",
    );
    assert(!JSON.stringify(first).includes("invalid_grant"));
    assertEquals(f.sent(TOKEN_URL).length, 1, token);
    // Nothing was connected, and the same return cannot be replayed.
    assertEquals(f.names(), ["consume_workspace_stripe_oauth"]);
    await failure(await f.handler(request(complete)), 403, "state_invalid");
    assertEquals(f.sent(TOKEN_URL).length, 1, token);
  }
});

Deno.test("complete: anything but a live authorisation is 409 stripe_not_live", async () => {
  for (const livemode of [false, "true", null, 0]) {
    const f = await started({ tokenBody: { livemode } });
    await failure(await f.handler(request(complete)), 409, "stripe_not_live");
    assertEquals(f.names(), ["consume_workspace_stripe_oauth"]);
    // The account is not even read.
    assertEquals(f.calls.length, 2);
  }
});

Deno.test("complete: other exchange mismatches keep the provider's code", async () => {
  for (
    const tokenBody of [
      { scope: "read_only" },
      { token_type: "mac" },
      { stripe_user_id: CONFIG.platformAccountId },
      { stripe_user_id: "not-an-account" },
      { livemode: undefined },
    ]
  ) {
    const f = await started({ tokenBody });
    await failure(
      await f.handler(request(complete)),
      409,
      "merchant_scope_mismatch",
    );
    assertEquals(f.names(), ["consume_workspace_stripe_oauth"]);
  }
});

Deno.test("complete: only a ready Standard account is activated", async () => {
  for (
    const account of [{ charges_enabled: false }, { details_submitted: false }]
  ) {
    const f = await started({ account });
    await failure(
      await f.handler(request(complete)),
      409,
      "stripe_account_not_ready",
    );
    assertEquals(f.names(), ["consume_workspace_stripe_oauth"]);
  }
  for (
    const account of [
      { type: "express" },
      { type: "custom" },
      { type: undefined },
      { id: "acct_Different" },
      { country: "Great Britain" },
      { charges_enabled: "yes" },
    ]
  ) {
    const f = await started({ account });
    await failure(
      await f.handler(request(complete)),
      409,
      "merchant_account_ineligible",
    );
    assertEquals(f.names(), ["consume_workspace_stripe_oauth"]);
  }
  // Payouts not yet enabled does not block watching for sales.
  const f = await started({ account: { payouts_enabled: false } });
  const { body } = await read(await f.handler(request(complete)));
  assertEquals(body.connection, { ...CONNECTED, payouts_enabled: false });
});

Deno.test("complete: the database's refusals reach the console by code", async () => {
  const inUse = await started({ accountInUse: true });
  await failure(
    await inUse.handler(request(complete)),
    409,
    "stripe_account_in_use",
  );
  const assigned = await started({
    productsAssigned: true,
    connection: { ...CONNECTED, account_id: "acct_Earlier" },
  });
  await failure(
    await assigned.handler(request(complete)),
    409,
    "connection_in_use",
  );
  const moved = await started({ statePlatform: "acct_EarlierPlatform" });
  await failure(await moved.handler(request(complete)), 403, "state_invalid");
  assertEquals(moved.calls, []);
});

Deno.test("complete: provider failures after the state is used say nothing of Stripe's answer", async () => {
  // Starting would fail the same way, so the pending state is put in place directly.
  const rejectedPlatform = fixture({ platform: "rejected" });
  rejectedPlatform.states.set(await stateHash(STATE), {
    user: OWNER,
    consumed: false,
    invalidated: false,
    activated: false,
  });
  await failure(
    await rejectedPlatform.handler(request(complete)),
    502,
    "merchant_connection_rejected",
  );
  assertEquals(rejectedPlatform.sent(TOKEN_URL).length, 0);
  const account = await started({ accountRead: "rejected" });
  await failure(
    await account.handler(request(complete)),
    502,
    "merchant_connection_rejected",
  );
  assertEquals(account.names(), ["consume_workspace_stripe_oauth"]);
});

Deno.test("complete: connected stays connected when payments cannot be counted", async () => {
  const f = await started({ summary: "unavailable" });
  assertEquals(await read(await f.handler(request(complete))), {
    status: 200,
    body: {
      enabled: true,
      workspace_id: WORKSPACE,
      can_manage: true,
      connection: CONNECTED,
      payments: NO_PAYMENTS,
    },
  });
  assertEquals(f.logs.map((entry) => entry.event), [
    "workspace_stripe_payment_summary_unavailable",
  ]);
});

// disconnect ------------------------------------------------------------------------

Deno.test("disconnect: revokes locally, then removes access at Stripe", async () => {
  const f = fixture({ connection: CONNECTED });
  assertEquals(await read(await f.handler(request(disconnect))), {
    status: 200,
    body: {
      enabled: true,
      workspace_id: WORKSPACE,
      can_manage: true,
      connection: null,
      payments: NO_PAYMENTS,
      stripe_deauthorized: true,
    },
  });
  assertEquals(f.rpcCalls, [{
    name: "disconnect_workspace_stripe",
    input: { workspace_id: WORKSPACE, user_id: OWNER },
  }]);
  assertEquals(f.calls.map((call) => [call.method, call.url]), [[
    "POST",
    DEAUTHORIZE_URL,
  ]]);
  assertEquals(Object.fromEntries(new URLSearchParams(f.calls[0].body)), {
    client_id: CONFIG.clientId,
    stripe_user_id: "acct_Merchant",
  });
  assertEquals(
    f.calls[0].headers.get("Authorization"),
    `Basic ${btoa(`${LIVE_KEY}:`)}`,
  );
  assertEquals(f.logs, []);
  // The console now reads "not connected".
  const { body } = await read(await f.handler(request(status)));
  assertEquals(body.connection, null);
});

Deno.test("disconnect: a Stripe failure does not undo the local disconnect", async () => {
  for (const deauthorize of ["rejected", "network", "other_account"] as const) {
    const f = fixture({ connection: CONNECTED, deauthorize });
    assertEquals(await read(await f.handler(request(disconnect))), {
      status: 200,
      body: {
        enabled: true,
        workspace_id: WORKSPACE,
        can_manage: true,
        connection: null,
        payments: NO_PAYMENTS,
        stripe_deauthorized: false,
      },
    });
    // One database call, one Stripe attempt, and nothing puts the connection back.
    assertEquals(f.names(), ["disconnect_workspace_stripe"]);
    assertEquals(f.sent(DEAUTHORIZE_URL).length, 1);
    const after = await read(await f.handler(request(status)));
    assertEquals(after.body.connection, null);
    // The failure is logged by code only.
    assertEquals(f.logs, [{
      event: "workspace_stripe_deauthorize_failed",
      request_id: f.logs[0].request_id,
      workspace_id: WORKSPACE,
      reason: deauthorize === "network"
        ? "merchant_provider_unavailable"
        : "stripe_deauthorize_rejected",
    }]);
    assert(!JSON.stringify(f.logs).includes("SECRET"));
  }
});

Deno.test("disconnect: owner or admin only", async () => {
  const f = fixture({ connection: CONNECTED });
  for (const user of [DEVELOPER, ANALYST]) {
    await failure(
      await f.handler(request(disconnect, { user })),
      403,
      "owner_or_admin_required",
    );
  }
  await failure(
    await f.handler(request(disconnect, { user: OUTSIDER })),
    403,
    "not_a_member",
  );
  assertEquals(f.calls, []);
  const admin = await read(
    await f.handler(request(disconnect, { user: ADMIN })),
  );
  assertEquals([admin.status, admin.body.stripe_deauthorized], [200, true]);
});

Deno.test("disconnect: refused while products are assigned, and Stripe is not called", async () => {
  const f = fixture({ connection: CONNECTED, productsAssigned: true });
  await failure(await f.handler(request(disconnect)), 409, "connection_in_use");
  assertEquals(f.calls, []);
  const { body } = await read(await f.handler(request(status)));
  assertEquals(body.connection, CONNECTED);
});

Deno.test("disconnect: with nothing connected it succeeds and Stripe is not called", async () => {
  for (const connection of [null, { ...CONNECTED, status: "revoked" }]) {
    const f = fixture({ connection });
    assertEquals(await read(await f.handler(request(disconnect))), {
      status: 200,
      body: {
        enabled: true,
        workspace_id: WORKSPACE,
        can_manage: true,
        connection: null,
        payments: NO_PAYMENTS,
      },
    });
    assertEquals([f.calls, f.logs], [[], []]);
  }
});

Deno.test("disconnect: a connection made on another platform is never deauthorised with this key", async () => {
  const f = fixture({
    connection: CONNECTED,
    connectionPlatform: "acct_AdminPlatform",
  });
  const { body } = await read(await f.handler(request(disconnect)));
  assertEquals([body.connection, body.stripe_deauthorized], [null, false]);
  assertEquals(f.calls, []);
  assertEquals(f.logs.map((entry) => entry.reason), ["other_platform"]);
});

// Stripe ------------------------------------------------------------------------------

Deno.test("provider error bodies never reach a response", async () => {
  // Each response is read through read(), which fails on any provider text.
  const cases: Array<[Options, unknown, number]> = [
    [{ platform: "rejected" }, start, 502],
    [{ token: "rejected" }, complete, 502],
    [{ token: "network" }, complete, 502],
    [{ token: "unreadable" }, complete, 502],
    [{ accountRead: "rejected" }, complete, 502],
    [{ tokenBody: { livemode: false } }, complete, 409],
    [{ account: { type: "express" } }, complete, 409],
    [{ connection: CONNECTED, deauthorize: "rejected" }, disconnect, 200],
    [{ connection: CONNECTED, deauthorize: "network" }, disconnect, 200],
  ];
  for (const [options, body, expected] of cases) {
    const f = body === complete ? await started(options) : fixture(options);
    const result = await read(await f.handler(request(body)));
    assertEquals(result.status, expected, JSON.stringify(options));
    assert(!JSON.stringify(f.logs).includes("SECRET"));
    assert(!JSON.stringify(f.rpcCalls).includes("SECRET"));
  }
});

Deno.test("the Stripe provider makes one deauthorise attempt and hides the answer", async () => {
  const seen: string[] = [];
  const provider = (answer: () => Response | Promise<Response>) =>
    new ConsoleStripeProvider(CONFIG, async (input) => {
      seen.push(String(input));
      return await answer();
    });
  await provider(() => Response.json({ stripe_user_id: "acct_Merchant" }))
    .deauthorize("acct_Merchant");
  for (
    const answer of [
      () => Response.json({ stripe_user_id: "acct_Other" }),
      () => Response.json({}),
      () => Response.json({ error: "SECRET_PROVIDER_BODY" }, { status: 401 }),
      () => new Response("SECRET_PROVIDER_BODY", { status: 200 }),
      () => Response.json({ stripe_user_id: "acct_Merchant" }, { status: 500 }),
      () => {
        throw new TypeError("SECRET_NETWORK");
      },
    ]
  ) {
    seen.length = 0;
    try {
      await provider(answer).deauthorize("acct_Merchant");
      throw new Error("deauthorise should have failed");
    } catch (error) {
      assert(error instanceof RequestError, String(error));
      assertEquals(error.status, 502);
      assert(!error.message.includes("SECRET"));
    }
    assertEquals(seen, [DEAUTHORIZE_URL]);
  }
  // Never the platform itself, never something that is not an account.
  for (const accountId of [CONFIG.platformAccountId, "", "acct_", "merchant"]) {
    seen.length = 0;
    try {
      await provider(() => Response.json({})).deauthorize(accountId);
      throw new Error("deauthorise should have failed");
    } catch (error) {
      assert(error instanceof ConfigurationError, String(error));
    }
    assertEquals(seen, []);
  }
});

// Database errors ---------------------------------------------------------------------

Deno.test("database refusals map to the contract's codes", () => {
  const mapped = (error: Parameters<typeof databaseError>[0]) => {
    const result = databaseError(error);
    return result instanceof RequestError
      ? [result.status, result.code]
      : result instanceof DatabaseBoundaryError
      ? [503, "database_boundary_error"]
      : [500, "unexpected"];
  };
  const expected: Array<[string, string, number, string]> = [
    ["42501", "not_a_member", 403, "not_a_member"],
    ["42501", "owner_or_admin_required", 403, "owner_or_admin_required"],
    ["42501", "state_invalid", 403, "state_invalid"],
    ["42501", "verified_email_required", 401, "verified_email_required"],
    ["22023", "stripe_not_live", 409, "stripe_not_live"],
    ["55000", "stripe_account_not_ready", 409, "stripe_account_not_ready"],
    ["23505", "stripe_account_in_use", 409, "stripe_account_in_use"],
    ["55000", "connection_in_use", 409, "connection_in_use"],
    ["22023", "invalid_input", 400, "invalid_input"],
  ];
  for (const [code, details, status, name] of expected) {
    assertEquals(mapped({ code, details, message: "x" }), [status, name]);
  }
  // The payment summary's bare "not a member".
  assertEquals(
    mapped({ code: "42501", details: null, message: "Not a member" }),
    [
      403,
      "not_a_member",
    ],
  );
  // A missing grant is a deployment fault, not a fact about the user.
  assertEquals(
    mapped({
      code: "42501",
      details: null,
      message: "permission denied for function workspace_stripe_status",
    }),
    [503, "database_boundary_error"],
  );
  for (const code of ["22023", "23505", "23514", "P0001", "55000"]) {
    assertEquals(mapped({ code, details: "something else" }), [
      409,
      "merchant_connection_conflict",
    ]);
  }
  for (const code of ["PGRST202", "57P03", "40P01", undefined, 42]) {
    assertEquals(mapped({ code }), [503, "database_boundary_error"]);
  }
  // Database text never becomes the message shown to the merchant.
  const shown = databaseError({
    code: "23505",
    details: "stripe_account_in_use",
    message: "SECRET_DATABASE_MESSAGE",
  });
  assert(!shown.message.includes("SECRET"));
});
