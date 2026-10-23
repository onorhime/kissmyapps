import { RequestError } from "../_shared/errors.ts";
import { ConnectProvider, type JsonObject } from "./provider.ts";
import {
  assertEquals,
  assertRejects,
  config,
  creator,
  FakeStripe,
  NOW,
  readyAccount,
} from "./test-support.ts";

const session = (provider: ConnectProvider) =>
  provider.onboardingSession(
    creator.connect_account_id,
    creator.affiliate_id,
    creator.account_key,
  );
async function rejectedCode(action: () => Promise<unknown>, expected: string) {
  try {
    await action();
  } catch (error) {
    if (error instanceof RequestError) {
      assertEquals(error.code, expected);
      return;
    }
    throw error;
  }
  throw Error("Expected a scoped provider rejection.");
}

Deno.test("embedded creator account explicitly owns requirements and has no Stripe dashboard", async () => {
  const fake = new FakeStripe();
  fake.accounts.clear();
  const provider = new ConnectProvider(config, fake.fetch, () => NOW);
  const account = await provider.ensureAccount(
    creator.affiliate_id,
    creator.account_key,
    "US",
    new Date(NOW).toISOString(),
  );
  const mutation = fake.calls.find((call) =>
    call.path === "accounts" && call.method === "POST"
  )!;
  assertEquals(Object.fromEntries(mutation.body), {
    "controller[requirement_collection]": "application",
    "controller[stripe_dashboard][type]": "none",
    "controller[fees][payer]": "application",
    "controller[losses][payments]": "application",
    country: "US",
    "capabilities[transfers][requested]": "true",
    "metadata[kma_affiliate_id]": creator.affiliate_id,
    "metadata[kma_platform_account_id]": config.platformAccountId,
    "metadata[kma_account_key]": creator.account_key,
    "business_profile[product_description]": "Creator referral commissions",
  });
  assertEquals(
    mutation.headers.get("Idempotency-Key"),
    `kma-connect-account:${creator.account_key}`,
  );
  const recovered = await provider.ensureAccount(
    creator.affiliate_id,
    creator.account_key,
    "US",
    new Date(NOW - 48 * 3600_000).toISOString(),
  );
  assertEquals(recovered.id, account.id);
  assertEquals(fake.calls.filter((call) => call.method === "POST").length, 1);
});

Deno.test("new account prefill is allowlisted and recovered accounts are never overwritten", async () => {
  const fake = new FakeStripe();
  fake.accounts.clear();
  const provider = new ConnectProvider(config, fake.fetch, () => NOW);
  const original = {
    email: "creator@example.invalid",
    business_type: "company" as const,
    company_name: "Original Creator Ltd",
    website_url: "https://creator.example.invalid",
  };
  const account = await provider.ensureAccount(
    creator.affiliate_id,
    creator.account_key,
    "US",
    new Date(NOW).toISOString(),
    original,
  );
  const creation = fake.calls.find((call) =>
    call.path === "accounts" && call.method === "POST"
  )!;
  assertEquals(creation.body.get("email"), original.email);
  assertEquals(creation.body.get("company[name]"), original.company_name);
  assertEquals(creation.body.get("business_type"), "company");
  assertEquals(
    creation.body.get("business_profile[url]"),
    original.website_url,
  );
  assertEquals(
    [...creation.body.keys()].filter((key) => key.startsWith("capabilities[")),
    ["capabilities[transfers][requested]"],
  );
  Object.assign(account, {
    email: "stripe-confirmed@example.invalid",
    details_submitted: true,
  });
  fake.accounts.set(String(account.id), account);
  const recovered = await provider.ensureAccount(
    creator.affiliate_id,
    creator.account_key,
    "US",
    new Date(NOW).toISOString(),
    {
      ...original,
      email: "changed-profile@example.invalid",
      company_name: "New Profile Name",
    },
  );
  assertEquals(recovered.email, "stripe-confirmed@example.invalid");
  assertEquals(fake.calls.filter((call) => call.method === "POST").length, 1);
});

Deno.test("embedded session rechecks account ownership and explicitly disables separate Stripe login", async () => {
  const fake = new FakeStripe(),
    provider = new ConnectProvider(config, fake.fetch, () => NOW);
  assertEquals(
    (await session(provider)).client_secret,
    "local_session_fixture_secret",
  );
  const request = fake.calls.find((call) => call.path === "account_sessions")!;
  assertEquals(Object.fromEntries(request.body), {
    account: creator.connect_account_id,
    "components[account_onboarding][enabled]": "true",
    "components[account_onboarding][features][external_account_collection]":
      "true",
    "components[account_onboarding][features][disable_stripe_user_authentication]":
      "true",
  });
  assertEquals(fake.calls[0].path, `accounts/${creator.connect_account_id}`);
  assertEquals(fake.calls.some((call) => call.path === "account_links"), false);
});

Deno.test("incompatible Express or controller accounts cannot receive sessions or replacement accounts", async () => {
  const baseline = readyAccount().controller as JsonObject;
  const incompatible = [
    undefined,
    {},
    {
      ...baseline,
      requirement_collection: "stripe",
      stripe_dashboard: { type: "express" },
    },
    { ...baseline, stripe_dashboard: { type: "full" } },
    { ...baseline, fees: { payer: "account" } },
    { ...baseline, losses: { payments: "stripe" } },
    { ...baseline, is_controller: false },
    { ...baseline, type: "account" },
  ];
  for (const controller of incompatible) {
    const fake = new FakeStripe(),
      provider = new ConnectProvider(config, fake.fetch, () => NOW);
    fake.accounts.set(creator.connect_account_id, {
      ...readyAccount(),
      controller,
    });
    await rejectedCode(
      () => session(provider),
      "embedded_account_incompatible",
    );
    await rejectedCode(
      () =>
        provider.ensureAccount(
          creator.affiliate_id,
          creator.account_key,
          "US",
          new Date(NOW).toISOString(),
        ),
      "embedded_account_incompatible",
    );
    assertEquals(fake.calls.filter((call) => call.method === "POST").length, 0);
    assertEquals(fake.accounts.size, 1);
  }
});

Deno.test("session ownership cannot change between handler snapshot and provider session request", async () => {
  for (
    const key of [
      "kma_affiliate_id",
      "kma_platform_account_id",
      "kma_account_key",
    ]
  ) {
    const fake = new FakeStripe(),
      provider = new ConnectProvider(config, fake.fetch, () => NOW);
    const account = readyAccount();
    (account.metadata as JsonObject)[key] = "unrelated";
    fake.accounts.set(creator.connect_account_id, account);
    await rejectedCode(() => session(provider), "connected_account_mismatch");
    assertEquals(fake.calls.filter((call) => call.method === "POST").length, 0);
  }
  const fake = new FakeStripe(),
    provider = new ConnectProvider(config, fake.fetch, () => NOW);
  await rejectedCode(
    () =>
      provider.onboardingSession(
        creator.connect_account_id,
        creator.affiliate_id,
        "",
      ),
    "connected_account_mismatch",
  );
  await rejectedCode(
    () =>
      provider.onboardingSession(
        creator.connect_account_id,
        "",
        creator.account_key,
      ),
    "connected_account_mismatch",
  );
  assertEquals(fake.calls.length, 0);
});

Deno.test("created account controller response must match before returning it to persistence", async () => {
  const fake = new FakeStripe();
  fake.accounts.clear();
  const provider = new ConnectProvider(config, async (address, init) => {
    const response = await fake.fetch(address, init);
    if (
      new URL(String(address)).pathname === "/v1/accounts" &&
      init?.method === "POST"
    ) {
      const account = await response.json();
      account.controller.requirement_collection = "stripe";
      return new Response(JSON.stringify(account));
    }
    return response;
  }, () => NOW);
  await rejectedCode(
    () =>
      provider.createAccount(creator.affiliate_id, creator.account_key, "US"),
    "embedded_account_incompatible",
  );
  assertEquals(
    fake.calls.some((call) => call.path === "account_sessions"),
    false,
  );
});

Deno.test("returned session requires both onboarding features and denies broader permissions", async () => {
  const valid = {
    external_account_collection: true,
    disable_stripe_user_authentication: true,
  };
  const changes = [
    { features: undefined },
    { features: {} },
    { features: { ...valid, external_account_collection: false } },
    { features: { ...valid, disable_stripe_user_authentication: false } },
    { features: { ...valid, disable_stripe_user_authentication: "true" } },
    { features: { ...valid, money_movement: true } },
    { enabled: false, features: valid },
  ];
  for (const change of changes) {
    const fake = new FakeStripe();
    const provider = new ConnectProvider(config, async (address, init) => {
      const response = await fake.fetch(address, init);
      if (String(address).endsWith("/account_sessions")) {
        const result = await response.json();
        result.components.account_onboarding = { enabled: true, ...change };
        return new Response(JSON.stringify(result));
      }
      return response;
    }, () => NOW);
    await assertRejects(() => session(provider));
  }
  const fake = new FakeStripe();
  const provider = new ConnectProvider(config, async (address, init) => {
    const response = await fake.fetch(address, init);
    if (String(address).endsWith("/account_sessions")) {
      const result = await response.json();
      result.components.payouts = { enabled: true };
      return new Response(JSON.stringify(result));
    }
    return response;
  }, () => NOW);
  await assertRejects(() => session(provider));
});

Deno.test("hosted onboarding provider fallback is disabled without making a network request", async () => {
  const fake = new FakeStripe(),
    provider = new ConnectProvider(config, fake.fetch);
  await rejectedCode(
    () => provider.onboardingLink(creator.connect_account_id),
    "hosted_onboarding_disabled",
  );
  assertEquals(fake.calls.length, 0);
});
