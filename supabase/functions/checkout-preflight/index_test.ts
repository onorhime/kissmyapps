import { assertEquals, assertFalse, assertRejects } from "@std/assert";
import {
  BC,
  createPreflightHandler,
  type PreflightDependencies,
  runPreflight,
} from "./index.ts";
import { ConfigurationError } from "../_shared/errors.ts";

const credential = "operator-fixture-secret-not-live-12345678";
const price = {
  id: BC.price,
  product: BC.stripeProduct,
  type: "recurring",
  active: true,
  livemode: true,
  currency: "usd",
  unit_amount: 100,
  recurring: { interval: "month", interval_count: 1 },
};
const coupon = {
  id: BC.coupon,
  object: "coupon",
  valid: true,
  percent_off: 100,
  duration: "forever",
  amount_off: null,
  applies_to: { products: [BC.stripeProduct] },
  max_redemptions: 1,
  times_redeemed: 0,
  redeem_by: null,
};
const promotion = {
  id: BC.promotion,
  active: true,
  livemode: true,
  customer: null,
  expires_at: null,
  max_redemptions: 1,
  times_redeemed: 0,
  promotion: { type: "coupon", coupon },
  restrictions: { first_time_transaction: false, minimum_amount: null },
};
function deps(
  overrides: {
    coupon?: Record<string, unknown>;
    promotion?: Record<string, unknown>;
    deny?: string;
  } = {},
) {
  const requests: string[] = [];
  const dependencies: PreflightDependencies = {
    stripeSecret: () => "rk_live_fixture_nonsecret_123456789",
    promotion: () => BC.promotion,
    now: () => 1788696000000,
    fetcher: ((input: RequestInfo | URL, init?: RequestInit) => {
      assertEquals(init?.method, "GET");
      assertEquals(init?.body, undefined);
      assertEquals(init?.redirect, "error");
      const url = String(input);
      assertEquals(new URL(url).origin, "https://api.stripe.com");
      requests.push(url);
      if (url.includes("/invoice_payments?")) {
        assertEquals(
          new URL(url).searchParams.get("created[gte]"),
          "1788782400",
        );
        assertEquals(new URL(url).searchParams.get("limit"), "1");
        return Promise.resolve(
          Response.json({ object: "list", data: [], has_more: false }),
        );
      }
      if (overrides.deny && url.includes(overrides.deny)) {
        return Promise.resolve(
          Response.json(
            { error: { message: "private key/customer details" } },
            { status: 403 },
          ),
        );
      }
      const value = url.includes("/prices/")
        ? price
        : url.includes("/coupons/")
        ? { ...coupon, ...overrides.coupon }
        : url.includes("/promotion_codes/")
        ? {
          ...promotion,
          promotion: {
            type: "coupon",
            coupon: { ...coupon, ...overrides.coupon },
          },
          ...overrides.promotion,
        }
        : { error: { code: "resource_missing", message: "private details" } };
      const status = url.includes("/prices/") || url.includes("/coupons/") ||
          url.includes("/promotion_codes/")
        ? 200
        : 404;
      return Promise.resolve(Response.json(value, { status }));
    }) as typeof fetch,
  };
  return { requests, dependencies };
}

Deno.test("preflight uses nine scoped GETs, exact checkout validator and no writes", async () => {
  const fixture = deps();
  const result = await runPreflight(fixture.dependencies);
  assertEquals(result.discountReady, true);
  assertEquals(result.existingCheckoutValidatorPassed, true);
  assertEquals(fixture.requests.length, 9);
  assertEquals(result.checkoutWritePermission, "not_exercised");
  assertEquals(result.stripeWrites, 0);
  assertEquals(result.checks.invoicePaymentsRead.result, "empty_scoped_list");
  assertEquals(
    result.checks.subscriptionRead.result,
    "missing_resource_not_permission_denied",
  );
  assertFalse(JSON.stringify(result).includes("private"));
  assertFalse(JSON.stringify(result).includes("rk_live_"));
});
Deno.test("preflight refuses wrong binding and non-live keys before Stripe access", async () => {
  const fixture = deps();
  await assertRejects(
    () =>
      runPreflight({ ...fixture.dependencies, promotion: () => "promo_other" }),
    ConfigurationError,
  );
  await assertRejects(
    () =>
      runPreflight({
        ...fixture.dependencies,
        stripeSecret: () => "sk_test_invalid",
      }),
    ConfigurationError,
  );
  assertEquals(fixture.requests.length, 0);
});
Deno.test("discount restrictions, use, expiry, partial and one-time coupons block readiness", async () => {
  for (
    const changes of [
      { coupon: { percent_off: 50 } },
      { coupon: { duration: "once" } },
      { coupon: { valid: false } },
      { coupon: { applies_to: { products: ["prod_unrelated"] } } },
      { coupon: { times_redeemed: 1 } },
      { coupon: { redeem_by: 1 } },
      { promotion: { times_redeemed: 1 } },
      { promotion: { expires_at: 1 } },
      { promotion: { customer: "cus_someone" } },
      {
        promotion: {
          restrictions: { minimum_amount: 1000, first_time_transaction: false },
        },
      },
    ]
  ) {
    assertEquals(
      (await runPreflight(deps(changes).dependencies)).discountReady,
      false,
    );
  }
});
Deno.test("denied resource permissions remain explicit and provider details stay private", async () => {
  for (
    const deny of [
      "/prices/",
      "/promotion_codes/",
      "/coupons/",
      "/subscriptions/",
    ]
  ) {
    const result = await runPreflight(deps({ deny }).dependencies);
    assertEquals(
      Object.values(result.checks).some((c) => c.result === "access_denied"),
      true,
    );
    if (deny !== "/subscriptions/") assertEquals(result.discountReady, false);
    assertFalse(JSON.stringify(result).includes("private"));
  }
});
Deno.test("preflight never treats transient failures as permission success", async () => {
  const fixture = deps();
  const result = await runPreflight({
    ...fixture.dependencies,
    fetcher: (() => Promise.reject(new Error("private"))) as typeof fetch,
  });
  assertEquals(result.discountReady, false);
  assertEquals(
    Object.values(result.checks).every((c) =>
      c.result === "request_unavailable"
    ),
    true,
  );
});
Deno.test("operator endpoint rejects unauthorized and parameterized calls before reads", async () => {
  Deno.env.set("PROCESSING_SCHEDULER_SECRET", credential);
  const fixture = deps();
  const handler = createPreflightHandler(fixture.dependencies);
  const request = (body: unknown, key = credential) =>
    new Request("https://example.invalid", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kma-scheduler-secret": key,
      },
      body: JSON.stringify(body),
    });
  assertEquals((await handler(request({}, "wrong"))).status, 401);
  for (
    const input of [null, [], { price: BC.price }, {
      url: "https://evil.invalid",
    }]
  ) {
    assertEquals((await handler(request(input))).status, 400);
  }
  assertEquals(fixture.requests.length, 0);
  assertEquals((await handler(request({}))).status, 200);
});
