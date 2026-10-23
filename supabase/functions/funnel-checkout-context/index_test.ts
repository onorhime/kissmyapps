import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { RequestError } from "../_shared/errors.ts";
import { createFunnelCheckoutProxy } from "../../../integrations/funnel/checkout-proxy.ts";
import { createCheckoutSessionHandler } from "../checkout-session/index.ts";
import {
  createFunnelContextHandler,
  parseContextInput,
  verifyPaywallPrice,
} from "./index.ts";
const secret = "unit-test-only-not-a-production-key-12345";
const binding = {
  secret,
  productId: "33333333-3333-4333-8333-333333333333",
  funnelId: "77777777-7777-4777-8777-777777777777",
};
const candidate = {
  key: "monthly",
  version: 1,
  name: "Test monthly",
  currency: "USD",
  unit_amount_minor: 100,
  billing_mode: "subscription" as const,
  stripe_price_id: "price_fixture123456",
};
const offerInput = {
  action: "offer",
  click_id: "c".repeat(48),
  offer_key: "monthly",
};
const statusInput = {
  action: "status",
  click_id: "c".repeat(48),
  attempt_id: "a".repeat(48),
  session_id: "cs_live_fixture12345",
};
async function signed(value: unknown, overrides: Record<string, string> = {}) {
  const body = JSON.stringify(value),
    timestamp = String(Math.floor(Date.now() / 1000)),
    nonce = "context_fixture_0001";
  const signature = bytesToHex(
    await hmacSha256(
      secret,
      new TextEncoder().encode(`${timestamp}.${nonce}.${body}`),
    ),
  );
  return new Request(
    "https://backend.example/functions/v1/funnel-checkout-context",
    {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-kma-key-id": "fixture",
        "x-kma-timestamp": timestamp,
        "x-kma-nonce": nonce,
        "x-kma-signature": signature,
        ...overrides,
      },
    },
  );
}
const bindings = () => new Map([["fixture", binding]]);
Deno.test("context authenticates HMAC and rejects browser and unsigned access before read", async () => {
  let reads = 0;
  const handler = createFunnelContextHandler({
    bindings,
    read: () => {
      reads++;
      return Promise.resolve(candidate);
    },
  });
  const headerCases: Record<string, string>[] = [{
    origin: "https://funnel.example",
  }, {
    "x-kma-signature": "0".repeat(64),
  }, { "x-kma-key-id": "unknown" }];
  for (const headers of headerCases) {
    const result = await handler(
      await signed(offerInput, headers),
    );
    assertEquals([401, 403].includes(result.status), true);
    await result.text();
  }
  assertEquals(reads, 0);
});
Deno.test("context validates exact action payload and refuses caller-owned pricing", () => {
  assertEquals(parseContextInput(offerInput), offerInput);
  assertEquals(parseContextInput(statusInput), statusInput);
  for (
    const value of [
      null,
      { ...offerInput, amount: 1 },
      { ...offerInput, click_id: "bad" },
      { ...statusInput, session_id: "cs_test_123456789" },
      { ...statusInput, attempt_id: "bad" },
      { ...offerInput, action: "purchase.completed" },
    ]
  ) assertThrows(() => parseContextInput(value), RequestError);
});
Deno.test("context binds every read to the authenticated product and funnel", async () => {
  const calls: unknown[] = [];
  const handler = createFunnelContextHandler({
    bindings,
    secret: () => "fixture",
    read: (input, product, funnel) => {
      calls.push([input, product, funnel]);
      return Promise.resolve(candidate);
    },
    price: () =>
      Promise.resolve({
        key: "monthly",
        version: 1,
        name: "Test",
        currency: "USD",
        unit_amount_minor: 100,
        billing_mode: "subscription",
        interval: "month",
        interval_count: 1,
      }),
  });
  const response = await handler(await signed(offerInput));
  assertEquals(response.status, 200);
  assertEquals(calls, [[offerInput, binding.productId, binding.funnelId]]);
  assertEquals(
    JSON.stringify(await response.json()).includes("stripe_price_id"),
    false,
  );
});
Deno.test("status returns verified state without exposing PII or looking up a price", async () => {
  let prices = 0;
  for (
    const status of [
      "pending",
      "paid",
      "no_payment_required",
      "expired",
      "failed",
    ]
  ) {
    const handler = createFunnelContextHandler({
      bindings,
      read: () => Promise.resolve({ status, email: "private@example.invalid" }),
      receipt: () => Promise.resolve("pending"),
      secret: () => "mock-only",
      price: () => {
        prices++;
        throw new Error();
      },
    });
    const response = await handler(await signed(statusInput));
    const body = await response.json();
    assertEquals(response.status, 200);
    assertEquals(body.status, status);
    assertEquals(Object.keys(body).sort(), ["request_id", "status"]);
  }
  assertEquals(prices, 0);
});
Deno.test("unknown status and rate exhaustion fail closed with safe errors", async () => {
  const invalid = createFunnelContextHandler({
    bindings,
    read: () => Promise.resolve({ status: "success_from_url" }),
  });
  const bad = await invalid(await signed(statusInput));
  assertEquals(bad.status, 503);
  await bad.text();
  const limited = createFunnelContextHandler({
    bindings,
    read: () => {
      throw new RequestError(429, "rate_limited", "Try later.");
    },
  });
  const result = await limited(await signed(offerInput));
  assertEquals(result.status, 429);
  await result.text();
});
const livePrice = {
  object: "price",
  id: candidate.stripe_price_id,
  livemode: true,
  active: true,
  type: "recurring",
  billing_scheme: "per_unit",
  currency: "usd",
  unit_amount: 100,
  unit_amount_decimal: "100",
  custom_unit_amount: null,
  tiers_mode: null,
  transform_quantity: null,
  recurring: { usage_type: "licensed", interval: "month", interval_count: 1 },
};

Deno.test("real adapter HMAC and cookies interoperate with both Edge handlers using mocked provider and persistence", async () => {
  const origin = "https://funnel.example";
  const candidateOffer = {
    key: candidate.key,
    version: candidate.version,
    name: candidate.name,
    currency: candidate.currency,
    unit_amount_minor: candidate.unit_amount_minor,
    billing_mode: candidate.billing_mode,
    interval: "month",
    interval_count: 1,
  };
  const context = createFunnelContextHandler({
    bindings,
    secret: () => "fixture",
    receipt: () => Promise.resolve("pending"),
    read: (input, product, funnel) => {
      assertEquals(product, binding.productId);
      assertEquals(funnel, binding.funnelId);
      return Promise.resolve(
        input.action === "offer" ? candidate : { status: "pending" },
      );
    },
    price: () => Promise.resolve(candidateOffer),
  });
  let prepares = 0;
  const checkout = createCheckoutSessionHandler({
    funnelBindings: bindings,
    authorizeScope: () => Promise.resolve(),
    stripeSecret: () => `sk_live_${"x".repeat(32)}`,
    redirectOrigins: () => new Set([origin]),
    prepare: (input, nonce) => {
      prepares++;
      assertEquals(input.offer_version, 1);
      assertEquals(input.require_no_payment, true);
      assertEquals(nonce, "logical_attempt_fixture_01");
      return Promise.resolve({
        attemptId: "11111111-1111-4111-8111-111111111111",
        publicAttemptId: "a".repeat(48),
        billingOfferId: "22222222-2222-4222-8222-222222222222",
        productId: binding.productId,
        acquisitionId: "44444444-4444-4444-8444-444444444444",
        clickRecordId: "55555555-5555-4555-8555-555555555555",
        affiliateId: "66666666-6666-4666-8666-666666666666",
        billingMode: "subscription",
        stripePriceId: candidate.stripe_price_id,
        currency: "USD",
        unitAmountMinor: 100,
        successUrl:
          `${origin}/checkout/complete?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: origin,
      });
    },
    finalize: () => Promise.resolve(),
    createStripeSession: (_secret, _prepared, requireNoPayment) => {
      assertEquals(requireNoPayment, true);
      return Promise.resolve({
        id: "cs_live_fixture12345678",
        url: "https://checkout.stripe.com/c/pay/fixture",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
    },
  });
  const proxy = createFunnelCheckoutProxy({
    origin,
    offerKey: "monthly",
    checkoutEnabled: true,
    requireNoPayment: true,
    backendBaseUrl: "https://backend.example/functions/v1",
    signing: { keyId: "fixture", secret },
    fetcher: ((url: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(url, init);
      return String(url).endsWith("checkout-session")
        ? checkout(req)
        : context(req);
    }) as typeof fetch,
  });
  const browser = (action: string, payload: unknown, cookie = "") =>
    new Request(`${origin}/api/partner/${action}`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        cookie,
        "idempotency-key": "logical_attempt_fixture_01",
      },
      body: JSON.stringify(payload),
    });
  const quote = await proxy.offer(
    browser("offer", { click_id: offerInput.click_id }),
  );
  assertEquals(quote.status, 200);
  const paid = await proxy.checkout(
    browser(
      "checkout",
      { click_id: offerInput.click_id, offer_key: "monthly" },
      quote.headers.get("set-cookie")!.split(";")[0],
    ),
  );
  assertEquals(paid.status, 200);
  assertEquals(prepares, 1);
  const response = await proxy.status(
    browser(
      "status",
      { session_id: "cs_live_fixture12345678" },
      paid.headers.get("set-cookie")!.split(";")[0],
    ),
  );
  assertEquals(response.status, 200);
  assertEquals((await response.json()).status, "pending");
  await quote.text();
  await paid.text();
});
Deno.test("paywall uses current live Stripe price recurrence, without exposing its identity", async () => {
  for (const prefix of ["sk_live_", "rk_live_"]) {
    const result = await verifyPaywallPrice(
      candidate,
      `${prefix}${"x".repeat(32)}`,
      (() => Promise.resolve(Response.json(livePrice))) as typeof fetch,
    );
    assertEquals(result, {
      key: "monthly",
      version: 1,
      name: "Test monthly",
      currency: "USD",
      unit_amount_minor: 100,
      billing_mode: "subscription",
      interval: "month",
      interval_count: 1,
    });
  }
});
Deno.test("paywall rejects changed, test, inactive, custom, metered or unpriced Stripe offers", async () => {
  for (
    const change of [
      { livemode: false },
      { active: false },
      { unit_amount: 200 },
      { currency: "eur" },
      { id: "price_other" },
      { custom_unit_amount: {} },
      { unit_amount_decimal: "100.1" },
      {
        recurring: {
          usage_type: "metered",
          interval: "month",
          interval_count: 1,
        },
      },
      {
        recurring: {
          usage_type: "licensed",
          interval: "day",
          interval_count: 0,
        },
      },
    ]
  ) {
    await assertRejects(
      () =>
        verifyPaywallPrice(
          candidate,
          `sk_live_${"x".repeat(32)}`,
          (() =>
            Promise.resolve(
              Response.json({ ...livePrice, ...change }),
            )) as typeof fetch,
        ),
      RequestError,
    );
  }
});
