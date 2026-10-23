// deno-lint-ignore-file require-await -- Fake adapters preserve the asynchronous production boundary.
import { createCreatorConnectHandler } from "./index.ts";
import { connectBindings, ConnectProvider } from "./provider.ts";
import {
  assertEquals,
  assertRejects,
  config,
  creator,
  FakeStripe,
  NOW,
  readyAccount,
} from "./test-support.ts";
function request(body: unknown, auth = true) {
  return new Request("https://local.invalid/creator-connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: "Bearer valid-fixture" } : {}),
    },
    body: JSON.stringify(body),
  });
}
function fixture(connected = true, prefill: unknown = {}) {
  const fake = new FakeStripe();
  if (!connected) fake.accounts.clear();
  const context = {
    ...creator,
    connect_account_id: connected ? creator.connect_account_id : null,
  };
  const saved: unknown[] = [];
  const reservedActors: string[] = [];
  const handler = createCreatorConnectHandler({
    bindings: () => new Map([["fixture", config]]),
    authenticate: async () => ({
      userId: "creator-user",
      assuranceLevel: "aal1",
      methods: [{ method: "password", timestamp: NOW / 1000 }],
      hasVerifiedMfa: false,
    }),
    context: async () => context,
    reserve: async (_context, country, actorUserId) => {
      reservedActors.push(actorUserId);
      return {
        country,
        first_account_attempt_at: new Date(NOW).toISOString(),
        account_creation_prefill: prefill,
      };
    },
    persist: async (_context, snapshot) => {
      saved.push(snapshot);
    },
    provider: (c) => new ConnectProvider(c, fake.fetch, () => NOW),
    now: () => NOW,
  });
  return { handler, fake, saved, reservedActors };
}
Deno.test("disabled Connect config never reads provider credentials", () => {
  const names: string[] = [];
  const configs = connectBindings((name) => {
    names.push(name);
    return undefined;
  });
  assertEquals(configs.size, 0);
  assertEquals(names, ["CREATOR_CONNECT_ENABLED"]);
});
Deno.test("production configuration defaults to domestic provider routes and requires explicit cross-border approval", async () => {
  const raw = {
    platform_account_id: "acct_platform",
    livemode: false,
    secret_env: "FIXTURE_STRIPE",
    webhook_secret_env: "FIXTURE_HOOK",
    origin: config.origin,
    return_url: config.returnUrl,
    refresh_url: config.refreshUrl,
  };
  function parse(value: unknown) {
    const values: Record<string, string> = {
      CREATOR_CONNECT_ENABLED: "true",
      CREATOR_CONNECT_BINDINGS_JSON: JSON.stringify({ fixture: value }),
      FIXTURE_STRIPE: "sk_test_localfixture",
      FIXTURE_HOOK: "whsec_localfixture",
    };
    return connectBindings((name) => values[name]);
  }
  assertEquals(parse(raw).get("fixture")!.countryPolicy.type, "domestic");
  for (
    const invalid of [{ ...raw, allowed_countries: ["US", "NG"] }, {
      ...raw,
      country_policy: { type: "connect_cross_border" },
    }, {
      ...raw,
      country_policy: {
        type: "approved_countries",
        approval_reference: "valid-fixture-reference",
      },
    }]
  ) {
    await assertRejects(() => Promise.resolve(parse(invalid)));
  }
});
Deno.test("Connect requires authenticated own creator scope and rejects client-selected identities", async () => {
  const f = fixture();
  assertEquals(
    (await f.handler(request({ action: "status" }, false))).status,
    401,
  );
  assertEquals(
    (await f.handler(
      request({
        action: "session",
        binding_id: "fixture",
        affiliate_id: "someone-else",
      }),
    )).status,
    400,
  );
  assertEquals(
    (await f.handler(
      request({
        action: "session",
        binding_id: "fixture",
        return_url: "https://evil.invalid",
      }),
    )).status,
    400,
  );
  const denied = createCreatorConnectHandler({
    bindings: () => new Map([["fixture", config]]),
    authenticate: async () => ({
      userId: "creator-user",
      assuranceLevel: "aal1",
      methods: [{ method: "password", timestamp: NOW / 1000 }],
      hasVerifiedMfa: false,
    }),
    context: async () => null,
  });
  assertEquals(
    (await denied(
      request({ action: "session", binding_id: "fixture", country: "US" }),
    )).status,
    403,
  );
  assertEquals(f.fake.calls.length, 0);
});
Deno.test("new creator receives embedded onboarding without a hosted URL and incomplete status", async () => {
  const f = fixture(false);
  assertEquals(
    (await f.handler(request({ action: "session", binding_id: "fixture" })))
      .status,
    400,
  );
  const response = await f.handler(
    request({ action: "session", binding_id: "fixture", country: "US" }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.bindings[0].status, "needs_information");
  assertEquals(body.onboarding_url, undefined);
  assertEquals(
    body.account_session.connected_account_id,
    "acct_newcreator",
  );
  assertEquals(f.fake.calls.some((c) => c.path === "account_links"), false);
  assertEquals(
    f.fake.calls.find((c) => c.path === "accounts" && c.method === "POST")!.body
      .get("capabilities[transfers][requested]"),
    "true",
  );
  assertEquals(JSON.stringify(f.saved).includes("singleusefixture"), false);
});
Deno.test("only the reserved server snapshot prefills a new account and profile data is not returned", async () => {
  const f = fixture(false, {
    email: "trusted@example.invalid",
    business_type: "individual",
  });
  const response = await f.handler(
    request({ action: "session", binding_id: "fixture", country: "US" }),
  );
  assertEquals(response.status, 200);
  assertEquals(f.reservedActors, ["creator-user"]);
  const body = await response.json();
  assertEquals(JSON.stringify(body).includes("trusted@example.invalid"), false);
  const created = f.fake.calls.find((c) =>
    c.path === "accounts" && c.method === "POST"
  )!;
  assertEquals(created.body.get("email"), "trusted@example.invalid");
  assertEquals(created.body.get("business_type"), "individual");
  assertEquals(created.body.has("individual[first_name]"), false);
  for (
    const injected of [{ email: "other@example.invalid" }, {
      actor_user_id: "another-user",
    }, { account_creation_prefill: { email: "other@example.invalid" } }]
  ) {
    assertEquals(
      (await f.handler(
        request({ action: "session", binding_id: "fixture", ...injected }),
      )).status,
      400,
    );
  }
  assertEquals(f.reservedActors.length, 1);
});

Deno.test("existing account reopen skips profile reservation and never posts account updates", async () => {
  const f = fixture(true, { email: "changed-profile@example.invalid" });
  const response = await f.handler(
    request({ action: "session", binding_id: "fixture" }),
  );
  assertEquals(response.status, 200);
  assertEquals(f.reservedActors, []);
  assertEquals(
    f.fake.calls.filter((c) => c.method === "POST").map((c) => c.path),
    ["account_sessions"],
  );
});

Deno.test("onboarding return is not completion; status retrieves fresh account requirements", async () => {
  const f = fixture();
  assertEquals(
    (await (await f.handler(request({ action: "status" }))).json()).bindings[0]
      .status,
    "ready",
  );
  f.fake.accounts.set(creator.connect_account_id, {
    ...readyAccount(),
    payouts_enabled: false,
    requirements: {
      currently_due: ["external_account"],
      disabled_reason: "requirements.past_due",
    },
  });
  assertEquals(
    (await (await f.handler(request({ action: "status" }))).json()).bindings[0]
      .status,
    "needs_information",
  );
});
Deno.test("funding account and mode are verified before an onboarding mutation", async () => {
  for (const mismatch of ["account", "mode"]) {
    const f = fixture(false);
    if (mismatch === "account") f.fake.platformId = "acct_other";
    else f.fake.mode = true;
    assertEquals(
      (await f.handler(
        request({ action: "session", binding_id: "fixture", country: "US" }),
      )).status,
      409,
    );
    assertEquals(f.fake.calls.filter((c) => c.method === "POST").length, 0);
  }
});
Deno.test("account recovery reuses created account and refuses unknown attempts past idempotency window", async () => {
  const fake = new FakeStripe(),
    provider = new ConnectProvider(config, fake.fetch, () => NOW);
  const recovered = await provider.ensureAccount(
    creator.affiliate_id,
    creator.account_key,
    "US",
    new Date(NOW - 48 * 3600_000).toISOString(),
  );
  assertEquals(recovered.id, creator.connect_account_id);
  assertEquals(fake.calls.filter((c) => c.method === "POST").length, 0);
  fake.accounts.clear();
  await assertRejects(() =>
    provider.ensureAccount(
      creator.affiliate_id,
      creator.account_key,
      "US",
      new Date(NOW - 48 * 3600_000).toISOString(),
    )
  );
  assertEquals(fake.calls.filter((c) => c.method === "POST").length, 0);
});
Deno.test("existing creator cannot be switched to another provider account", async () => {
  const f = fixture();
  f.fake.accounts.set(creator.connect_account_id, {
    ...readyAccount(),
    metadata: {
      kma_affiliate_id: "other",
      kma_account_key: creator.account_key,
      kma_platform_account_id: config.platformAccountId,
    },
  });
  assertEquals(
    (await f.handler(request({ action: "session", binding_id: "fixture" })))
      .status,
    409,
  );
  assertEquals(f.saved.length, 0);
});

Deno.test("embedded session is creator-bound, expires and never enters stored account state", async () => {
  const f = fixture(false);
  const response = await f.handler(
    request({ action: "session", binding_id: "fixture", country: "US" }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Cache-Control"), "no-store, max-age=0");
  const body = await response.json();
  assertEquals(body.account_session.connected_account_id, "acct_newcreator");
  assertEquals(body.account_session.publishable_key, config.publishableKey);
  assertEquals(body.account_session.binding_id, "fixture");
  assertEquals(body.account_session.livemode, false);
  assertEquals(
    body.account_session.client_secret,
    "local_session_fixture_secret",
  );
  assertEquals(body.account_session.expires_at > NOW / 1000, true);
  const call = f.fake.calls.find((entry) => entry.path === "account_sessions")!;
  assertEquals(Object.fromEntries(call.body), {
    account: "acct_newcreator",
    "components[account_onboarding][enabled]": "true",
    "components[account_onboarding][features][external_account_collection]":
      "true",
    "components[account_onboarding][features][disable_stripe_user_authentication]":
      "true",
  });
  assertEquals(
    f.fake.calls.some((entry) => entry.path === "account_links"),
    false,
  );
  assertEquals(JSON.stringify(f.saved).includes("client_secret"), false);
  assertEquals(
    JSON.stringify(f.saved).includes("local_session_fixture_secret"),
    false,
  );
  const second = await f.handler(
    request({ action: "session", binding_id: "fixture" }),
  );
  assertEquals(second.status, 200);
  assertEquals(
    f.fake.calls.filter((entry) =>
      entry.path === "accounts" && entry.method === "POST"
    ).length,
    1,
  );
  assertEquals(
    f.fake.calls.filter((entry) => entry.path === "account_sessions").length,
    2,
  );
});

Deno.test("embedded session rejects unauthorized identities and mismatched origins before Stripe", async () => {
  const f = fixture();
  for (
    const key of [
      "affiliate_id",
      "connected_account_id",
      "platform_account_id",
      "publishable_key",
      "components",
    ]
  ) {
    assertEquals(
      (await f.handler(
        request({
          action: "session",
          binding_id: "fixture",
          [key]: "injected",
        }),
      )).status,
      400,
    );
  }
  assertEquals(
    (await f.handler(
      request({ action: "session", binding_id: "fixture" }, false),
    )).status,
    401,
  );
  const invalidOrigin = request({ action: "session", binding_id: "fixture" });
  invalidOrigin.headers.set("Origin", "https://other.invalid");
  assertEquals((await f.handler(invalidOrigin)).status, 403);
  const denied = createCreatorConnectHandler({
    bindings: () => new Map([["fixture", config]]),
    authenticate: async () => ({
      userId: "creator-user",
      assuranceLevel: "aal1",
      methods: [{ method: "password", timestamp: NOW / 1000 }],
      hasVerifiedMfa: false,
    }),
    context: async () => null,
    provider: () => {
      throw Error("Provider must not be called");
    },
  });
  assertEquals(
    (await denied(request({ action: "session", binding_id: "fixture" })))
      .status,
    403,
  );
  assertEquals(f.fake.calls.length, 0);
});

Deno.test("embedded setup needs a correctly scoped publishable key and does not create accounts when absent", async () => {
  const fake = new FakeStripe();
  const handler = createCreatorConnectHandler({
    bindings: () =>
      new Map([["fixture", { ...config, publishableKey: undefined }]]),
    authenticate: async () => ({
      userId: "creator-user",
      assuranceLevel: "aal1",
      methods: [{ method: "password", timestamp: NOW / 1000 }],
      hasVerifiedMfa: false,
    }),
    context: async () => ({ ...creator, connect_account_id: null }),
    provider: (c) => new ConnectProvider(c, fake.fetch),
  });
  assertEquals(
    (await handler(
      request({ action: "session", binding_id: "fixture", country: "US" }),
    )).status,
    503,
  );
  assertEquals(fake.calls.length, 0);
  for (const key of ["pk_live_wrongmode", "sk_test_secret", ""]) {
    const values: Record<string, string> = {
      CREATOR_CONNECT_ENABLED: "true",
      FIXTURE_SECRET: "sk_test_fixture",
      FIXTURE_HOOK: "whsec_fixture",
      FIXTURE_PUBLIC: key,
      CREATOR_CONNECT_BINDINGS_JSON: JSON.stringify({
        fixture: {
          platform_account_id: config.platformAccountId,
          livemode: false,
          secret_env: "FIXTURE_SECRET",
          webhook_secret_env: "FIXTURE_HOOK",
          publishable_key_env: "FIXTURE_PUBLIC",
          origin: config.origin,
          return_url: config.returnUrl,
          refresh_url: config.refreshUrl,
        },
      }),
    };
    await assertRejects(() =>
      Promise.resolve(connectBindings((name) => values[name]))
    );
  }
});

Deno.test("embedded session rejects provider account, mode, permissions and expiry mismatch", async () => {
  for (
    const change of [
      { account: "acct_other" },
      { livemode: true },
      { expires_at: 1 },
      { client_secret: "" },
      {
        components: {
          account_onboarding: { enabled: true },
          payments: { enabled: true },
        },
      },
    ]
  ) {
    const fake = new FakeStripe();
    const provider = new ConnectProvider(config, async (input, init) => {
      const response = await fake.fetch(input, init);
      if (String(input).endsWith("/account_sessions")) {
        return new Response(
          JSON.stringify({ ...await response.json(), ...change }),
        );
      }
      return response;
    }, () => NOW);
    await assertRejects(() =>
      provider.onboardingSession(
        creator.connect_account_id,
        creator.affiliate_id,
        creator.account_key,
      )
    );
  }
});
Deno.test("eligible countries come from provider catalog intersected with approved Connect routes", async () => {
  const f = fixture();
  const response = await f.handler(request({ action: "status" }));
  assertEquals(response.status, 200);
  const value = (await response.json()).bindings[0];
  assertEquals(value.allowed_countries, ["CA", "GB", "US"]);
  assertEquals(value.allowed_transfer_currencies, ["USD"]);
  assertEquals(value.eligibility.source, "stripe_country_specs");
  // A provider catalog may include Global Payouts routes. That alone never
  // authorizes a Connect cross-border account in those countries.
  assertEquals(value.allowed_countries.includes("NG"), false);
  f.fake.countrySpecs = f.fake.countrySpecs.filter((spec) => spec.id !== "GB");
  assertEquals(
    (await (await f.handler(request({ action: "status" }))).json()).bindings[0]
      .allowed_countries,
    ["CA", "US"],
  );
});
Deno.test("domestic default and bespoke platform approvals cannot expand Stripe's current catalog", async () => {
  const fake = new FakeStripe();
  const domestic = new ConnectProvider(
    { ...config, countryPolicy: { type: "domestic" } },
    fake.fetch,
    () => NOW,
  );
  assertEquals((await domestic.eligibility()).countries.map((c) => c.country), [
    "US",
  ]);
  const bespoke = new ConnectProvider(
    {
      ...config,
      countryPolicy: {
        type: "approved_countries",
        approvalReference: "fixture-provider-approved-ng-route",
        approvedCountries: ["NG", "ZZ"],
      },
    },
    fake.fetch,
    () => NOW,
  );
  assertEquals((await bespoke.eligibility()).countries.map((c) => c.country), [
    "NG",
    "US",
  ]);
  await assertRejects(() =>
    domestic.createAccount(creator.affiliate_id, creator.account_key, "GB")
  );
  assertEquals(fake.calls.filter((call) => call.method === "POST").length, 0);
});
Deno.test("unknown catalog or unverified funding country fails before onboarding mutations", async () => {
  for (
    const mutate of [(f: ReturnType<typeof fixture>) => {
      f.fake.platformCountry = "";
    }, (f: ReturnType<typeof fixture>) => {
      f.fake.countrySpecs = [];
    }]
  ) {
    const f = fixture(false);
    mutate(f);
    assertEquals(
      (await f.handler(
        request({ action: "session", binding_id: "fixture", country: "US" }),
      )).status >= 400,
      true,
    );
    assertEquals(
      f.fake.calls.filter((call) => call.method === "POST").length,
      0,
    );
  }
});

Deno.test("session requires recent KMA authentication before any provider call; status remains available", async () => {
  const fake = new FakeStripe();
  let reservations = 0;
  const handler = createCreatorConnectHandler({
    bindings: () => new Map([["fixture", config]]),
    authenticate: async () => ({
      userId: "creator-user",
      assuranceLevel: "aal1",
      methods: [{ method: "password", timestamp: NOW / 1000 - 601 }],
      hasVerifiedMfa: false,
    }),
    context: async () => ({ ...creator, connect_account_id: null }),
    reserve: async (_context, country) => {
      reservations++;
      return { country, first_account_attempt_at: new Date(NOW).toISOString() };
    },
    provider: (c) => new ConnectProvider(c, fake.fetch, () => NOW),
    now: () => NOW,
  });
  const denied = await handler(
    request({ action: "session", binding_id: "fixture", country: "US" }),
  );
  assertEquals(denied.status, 403);
  assertEquals((await denied.json()).error, "reauthentication_required");
  assertEquals(reservations, 0);
  assertEquals(fake.calls.length, 0);
  assertEquals((await handler(request({ action: "status" }))).status, 200);
});
Deno.test("hosted onboarding is rejected without provider mutations", async () => {
  const f = fixture(false);
  assertEquals(
    (await f.handler(
      request({ action: "onboard", binding_id: "fixture", country: "US" }),
    )).status,
    400,
  );
  assertEquals(f.fake.calls.length, 0);
});
