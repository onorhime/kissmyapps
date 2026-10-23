import type { SupabaseClient } from "@supabase/supabase-js";
import { assertEquals } from "@std/assert";
import {
  handleStripePriceVerifier,
  type PriceVerifierDependencies,
} from "./index.ts";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";

const offerId = "11111111-1111-4111-8111-111111111111";
const priceId = "price_LiveConfigured123";
const origin = "https://partners.kissmyapps.dev";
const authorization = `Bearer ${"a".repeat(64)}`;
const liveSecret = `sk_live_${"b".repeat(40)}`;

interface RpcResult {
  data: unknown;
  error: null | { code?: string };
}

function fakeClient(
  rpc: (name: string, args: unknown) => Promise<RpcResult>,
): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

function request(body: unknown): Request {
  return new Request(
    "https://edge.example/functions/v1/stripe-price-verifier",
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify(body),
    },
  );
}

function dependencies(overrides: Partial<PriceVerifierDependencies> = {}): {
  value: PriceVerifierDependencies;
  recorded: Array<{ name: string; args: unknown }>;
} {
  const recorded: Array<{ name: string; args: unknown }> = [];
  const candidate = {
    billing_offer_id: offerId,
    stripe_price_id: priceId,
    currency: "USD",
    unit_amount_minor: 1999,
    billing_mode: "subscription",
  };
  const value: PriceVerifierDependencies = {
    userClient: () =>
      fakeClient(() => Promise.resolve({ data: candidate, error: null })),
    serviceClient: () =>
      fakeClient((name, args) => {
        recorded.push({ name, args });
        return Promise.resolve({ data: true, error: null });
      }),
    stripeSecret: () => liveSecret,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          id: priceId,
          object: "price",
          active: true,
          livemode: true,
          billing_scheme: "per_unit",
          type: "recurring",
          currency: "usd",
          unit_amount: 1999,
          unit_amount_decimal: "1999",
          custom_unit_amount: null,
          tiers_mode: null,
          transform_quantity: null,
          recurring: {
            interval: "month",
            interval_count: 1,
            usage_type: "licensed",
          },
        }),
      ),
    ...overrides,
  };
  return { value, recorded };
}

Deno.test("admin verifier attests only exact live Stripe Price facts", async () => {
  Deno.env.set("ADMIN_ALLOWED_ORIGINS", origin);
  let stripeHeaders = new Headers();
  let stripeSignal: AbortSignal | null | undefined;
  const setup = dependencies({
    fetcher: (_input, init) => {
      stripeHeaders = new Headers(init?.headers);
      stripeSignal = init?.signal;
      return Promise.resolve(
        Response.json({
          id: priceId,
          object: "price",
          active: true,
          livemode: true,
          billing_scheme: "per_unit",
          type: "recurring",
          currency: "usd",
          unit_amount: 1999,
          unit_amount_decimal: "1999",
          custom_unit_amount: null,
          tiers_mode: null,
          transform_quantity: null,
          recurring: { usage_type: "licensed" },
        }),
      );
    },
  });
  const response = await handleStripePriceVerifier(
    request({ billing_offer_id: offerId }),
    setup.value,
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("access-control-allow-origin"), origin);
  assertEquals(response.headers.get("cache-control"), "no-store, max-age=0");
  assertEquals(stripeHeaders.get("stripe-version"), STRIPE_API_VERSION);
  assertEquals(stripeSignal instanceof AbortSignal, true);
  assertEquals(setup.recorded, [{
    name: "record_billing_offer_stripe_verification",
    args: {
      p_input: {
        billing_offer_id: offerId,
        stripe_price_id: priceId,
        livemode: true,
        active: true,
        currency: "USD",
        unit_amount_minor: 1999,
        billing_mode: "subscription",
      },
    },
  }]);
});

Deno.test("admin verifier rejects client-supplied commercial fields before Stripe", async () => {
  Deno.env.set("ADMIN_ALLOWED_ORIGINS", origin);
  let stripeCalls = 0;
  const setup = dependencies({
    fetcher: () => {
      stripeCalls += 1;
      return Promise.resolve(Response.json({}));
    },
  });
  const response = await handleStripePriceVerifier(
    request({ billing_offer_id: offerId, unit_amount_minor: 1 }),
    setup.value,
  );
  assertEquals(response.status, 400);
  assertEquals(stripeCalls, 0);
  assertEquals(setup.recorded, []);
});

Deno.test("admin verifier attests a one-time offer using its saved Price facts", async () => {
  Deno.env.set("ADMIN_ALLOWED_ORIGINS", origin);
  const setup = dependencies({
    userClient: () =>
      fakeClient(() =>
        Promise.resolve({
          data: {
            billing_offer_id: offerId,
            stripe_price_id: priceId,
            currency: "USD",
            unit_amount_minor: 16900,
            billing_mode: "payment",
          },
          error: null,
        })
      ),
    fetcher: () =>
      Promise.resolve(
        Response.json({
          id: priceId,
          object: "price",
          active: true,
          livemode: true,
          billing_scheme: "per_unit",
          type: "one_time",
          currency: "usd",
          unit_amount: 16900,
          unit_amount_decimal: "16900",
          custom_unit_amount: null,
          tiers_mode: null,
          transform_quantity: null,
          recurring: null,
        }),
      ),
  });
  const response = await handleStripePriceVerifier(
    request({ billing_offer_id: offerId }),
    setup.value,
  );
  assertEquals(response.status, 200);
  assertEquals(setup.recorded, [{
    name: "record_billing_offer_stripe_verification",
    args: {
      p_input: {
        billing_offer_id: offerId,
        stripe_price_id: priceId,
        livemode: true,
        active: true,
        currency: "USD",
        unit_amount_minor: 16900,
        billing_mode: "payment",
      },
    },
  }]);
});

Deno.test("one-time offer verification rejects a recurring Price without attestation", async () => {
  Deno.env.set("ADMIN_ALLOWED_ORIGINS", origin);
  const setup = dependencies({
    userClient: () =>
      fakeClient(() =>
        Promise.resolve({
          data: {
            billing_offer_id: offerId,
            stripe_price_id: priceId,
            currency: "USD",
            unit_amount_minor: 1999,
            billing_mode: "payment",
          },
          error: null,
        })
      ),
  });
  const response = await handleStripePriceVerifier(
    request({ billing_offer_id: offerId }),
    setup.value,
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "stripe_price_mismatch");
  assertEquals(setup.recorded, []);
});

Deno.test("admin verifier accepts restricted live keys without exposing them", async () => {
  Deno.env.set("ADMIN_ALLOWED_ORIGINS", origin);
  const key = `rk_live_${"r".repeat(40)}`;
  const setup = dependencies({ stripeSecret: () => key });
  const provider = setup.value.fetcher;
  setup.value.fetcher = (input, init) => {
    assertEquals(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${key}`,
    );
    return provider(input, init);
  };
  const response = await handleStripePriceVerifier(
    request({ billing_offer_id: offerId }),
    setup.value,
  );
  assertEquals(response.status, 200);
  assertEquals(setup.recorded.length, 1);
  assertEquals((await response.text()).includes(key), false);
  assertEquals(JSON.stringify(setup.recorded).includes(key), false);
});

Deno.test("admin verifier rejects test and publishable keys before any Stripe request", async () => {
  Deno.env.set("ADMIN_ALLOWED_ORIGINS", origin);
  for (const prefix of ["rk_test_", "sk_test_", "pk_live_"]) {
    let calls = 0;
    const key = `${prefix}${"x".repeat(40)}`;
    const setup = dependencies({
      stripeSecret: () => key,
      fetcher: () => {
        calls++;
        return Promise.resolve(Response.json({}));
      },
    });
    const response = await handleStripePriceVerifier(
      request({ billing_offer_id: offerId }),
      setup.value,
    );
    assertEquals(response.status, 503);
    assertEquals((await response.text()).includes(key), false);
    assertEquals(calls, 0);
    assertEquals(setup.recorded, []);
  }
});

Deno.test("restricted key denied by Stripe never records verification or leaks provider details", async () => {
  Deno.env.set("ADMIN_ALLOWED_ORIGINS", origin);
  for (const status of [401, 403]) {
    const key = `rk_live_${"r".repeat(40)}`;
    const setup = dependencies({
      stripeSecret: () => key,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            error: { message: `private provider detail ${key}` },
          }, { status }),
        ),
    });
    const response = await handleStripePriceVerifier(
      request({ billing_offer_id: offerId }),
      setup.value,
    );
    assertEquals(response.status, 503);
    const body = await response.text();
    assertEquals(body.includes(key), false);
    assertEquals(body.includes("private provider detail"), false);
    assertEquals(setup.recorded, []);
  }
});

Deno.test("admin verifier rejects mismatched or test-mode Stripe Prices", async () => {
  Deno.env.set("ADMIN_ALLOWED_ORIGINS", origin);
  const setup = dependencies({
    fetcher: () =>
      Promise.resolve(
        Response.json({
          id: priceId,
          object: "price",
          active: true,
          livemode: false,
          billing_scheme: "per_unit",
          type: "recurring",
          currency: "usd",
          unit_amount: 1,
          unit_amount_decimal: "1",
          custom_unit_amount: null,
          tiers_mode: null,
          transform_quantity: null,
          recurring: { usage_type: "licensed" },
        }),
      ),
  });
  const response = await handleStripePriceVerifier(
    request({ billing_offer_id: offerId }),
    setup.value,
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "stripe_price_mismatch");
  assertEquals(setup.recorded, []);
});

Deno.test("admin verifier requires an allowlisted production origin and bearer session", async () => {
  Deno.env.set("ADMIN_ALLOWED_ORIGINS", origin);
  const setup = dependencies();
  const badOrigin = new Request(
    "https://edge.example/functions/v1/stripe-price-verifier",
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ billing_offer_id: offerId }),
    },
  );
  assertEquals(
    (await handleStripePriceVerifier(badOrigin, setup.value)).status,
    403,
  );

  const noAuth = new Request(
    "https://edge.example/functions/v1/stripe-price-verifier",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ billing_offer_id: offerId }),
    },
  );
  assertEquals(
    (await handleStripePriceVerifier(noAuth, setup.value)).status,
    401,
  );
});
