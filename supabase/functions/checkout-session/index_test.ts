import { assert, assertEquals, assertRejects } from "@std/assert";
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { ConfigurationError, RequestError } from "../_shared/errors.ts";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";
import {
  type CheckoutFinalization,
  type CheckoutRequestInput,
  createCheckoutSessionHandler,
  createLiveStripeCheckoutSession,
  type PreparedCheckout,
} from "./index.ts";

const encoder = new TextEncoder();
const hmacSecret = "a-production-strength-funnel-secret-for-tests";
const stripeSecret = `sk_live_${"a".repeat(40)}`;
const nonce = "nonce_abcdefghijklmnop";
const funnelBinding = {
  secret: hmacSecret,
  productId: "33333333-3333-4333-8333-333333333333",
  funnelId: "77777777-7777-4777-8777-777777777777",
};
const authorizeScope = () => Promise.resolve();

const prepared: PreparedCheckout = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  publicAttemptId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  billingOfferId: "22222222-2222-4222-8222-222222222222",
  productId: "33333333-3333-4333-8333-333333333333",
  acquisitionId: "44444444-4444-4444-8444-444444444444",
  clickRecordId: "55555555-5555-4555-8555-555555555555",
  affiliateId: "66666666-6666-4666-8666-666666666666",
  billingMode: "subscription",
  stripePriceId: "price_LiveConfigured123",
  currency: "USD",
  unitAmountMinor: 1999,
  successUrl:
    "https://product.kissmyapps.dev/checkout/success?session_id={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://product.kissmyapps.dev/checkout/cancelled",
};

Deno.test("embedded Checkout prefills email and keeps return authentication without offsite success URLs", async () => {
  const result = await createLiveStripeCheckoutSession(
    stripeSecret,
    prepared,
    async (_url, init) => {
      await Promise.resolve();
      const form = new URLSearchParams(String(init?.body));
      assertEquals(form.get("ui_mode"), "embedded");
      assertEquals(form.get("customer_email"), "buyer@example.test");
      assertEquals(form.get("redirect_on_completion"), "if_required");
      assertEquals(form.get("return_url"), prepared.successUrl);
      assertEquals(form.has("success_url"), false);
      assertEquals(form.has("cancel_url"), false);
      assertEquals(form.get("metadata[customer_email]"), null);
      return Response.json({
        id: "cs_live_EmbeddedFixture123",
        livemode: true,
        ui_mode: "embedded",
        url: null,
        client_secret: "cs_live_EmbeddedFixture123_secret_fixture123",
        expires_at: 1900000000,
      });
    },
    undefined,
    { mode: "embedded", email: "buyer@example.test" },
  );
  assertEquals(result.url, null);
  assertEquals(
    result.clientSecret,
    "cs_live_EmbeddedFixture123_secret_fixture123",
  );
});

Deno.test("free checkout preapplies verified recurring discount and refuses nonzero Stripe total", async () => {
  let posts = 0;
  const provider =
    (total: number) =>
    async (url: string | URL | Request, init?: RequestInit) => {
      await Promise.resolve(); // Simulate the asynchronous fetch boundary.
      if (String(url).includes("promotion_codes/")) {
        return Response.json({
          id: "promo_Fixture123456",
          active: true,
          livemode: true,
          promotion: {
            type: "coupon",
            coupon: {
              object: "coupon",
              valid: true,
              percent_off: 100,
              duration: "forever",
              amount_off: null,
              applies_to: null,
            },
          },
        });
      }
      if (String(url).includes("prices/")) {
        return Response.json({
          id: prepared.stripePriceId,
          active: true,
          livemode: true,
          type: "recurring",
          currency: "usd",
          unit_amount: prepared.unitAmountMinor,
          product: "prod_Fixture123456",
        });
      }
      posts++;
      const form = new URLSearchParams(String(init?.body));
      assertEquals(
        form.get("discounts[0][promotion_code]"),
        "promo_Fixture123456",
      );
      assertEquals(form.get("payment_method_collection"), "if_required");
      assertEquals(form.has("allow_promotion_codes"), false);
      return Response.json({
        id: "cs_live_Fixture123456",
        livemode: true,
        url: "https://checkout.stripe.com/c/pay/fixture",
        expires_at: 1900000000,
        amount_total: total,
        currency: "usd",
        mode: "subscription",
        total_details: { amount_discount: prepared.unitAmountMinor },
      });
    };
  for (const key of [stripeSecret, `rk_live_${"r".repeat(40)}`]) {
    assertEquals(
      (await createLiveStripeCheckoutSession(
        key,
        prepared,
        provider(0),
        "promo_Fixture123456",
      )).id,
      "cs_live_Fixture123456",
    );
    await assertRejects(
      () =>
        createLiveStripeCheckoutSession(
          key,
          prepared,
          provider(1),
          "promo_Fixture123456",
        ),
      RequestError,
      "zero total",
    );
  }
  assertEquals(posts, 4);
});

async function signedRequest(
  body: string,
  overrides: Record<string, string> = {},
): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000);
  const bytes = encoder.encode(body);
  const prefix = encoder.encode(`${timestamp}.${nonce}.`);
  const canonical = new Uint8Array(prefix.length + bytes.length);
  canonical.set(prefix);
  canonical.set(bytes, prefix.length);
  const signature = bytesToHex(await hmacSha256(hmacSecret, canonical));
  return new Request("https://edge.example/functions/v1/checkout-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kma-key-id": "primary",
      "x-kma-nonce": nonce,
      "x-kma-signature": signature,
      "x-kma-timestamp": String(timestamp),
      ...overrides,
    },
    body,
  });
}

Deno.test("checkout endpoint fails closed before persistence when live Stripe is unconfigured", async () => {
  let preparedCount = 0;
  const handler = createCheckoutSessionHandler({
    stripeSecret: () => {
      throw new ConfigurationError();
    },
    prepare: () => {
      preparedCount += 1;
      return Promise.resolve(prepared);
    },
  });
  const response = await handler(
    new Request("https://edge.example/functions/v1/checkout-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ click_id: "a".repeat(48), offer_key: "monthly" }),
    }),
  );
  assertEquals(response.status, 503);
  assertEquals(preparedCount, 0);
  assertEquals(response.headers.get("cache-control"), "no-store, max-age=0");
});

Deno.test("checkout endpoint authenticates the funnel and persists only server-owned terms", async () => {
  const preparedInputs: Array<{
    input: CheckoutRequestInput;
    idempotencyKey: string;
  }> = [];
  const finalizations: CheckoutFinalization[] = [];
  const authorizedScopes: string[][] = [];
  const handler = createCheckoutSessionHandler({
    funnelBindings: () => new Map([["primary", funnelBinding]]),
    authorizeScope: (keyId, clickId, productId, funnelId) => {
      authorizedScopes.push([keyId, clickId, productId, funnelId]);
      return Promise.resolve();
    },
    redirectOrigins: () => new Set(["https://product.kissmyapps.dev"]),
    stripeSecret: () => stripeSecret,
    prepare: (input, idempotencyKey) => {
      preparedInputs.push({ input, idempotencyKey });
      return Promise.resolve(prepared);
    },
    finalize: (input) => {
      finalizations.push(input);
      return Promise.resolve();
    },
    createStripeSession: (_secret, checkout) => {
      assertEquals(checkout, prepared);
      return Promise.resolve({
        id: "cs_live_1234567890",
        url: "https://checkout.stripe.com/c/pay/live_session",
        expiresAt: "2026-08-29T08:00:00.000Z",
      });
    },
  });
  const response = await handler(
    await signedRequest(
      JSON.stringify({ click_id: "b".repeat(48), offer_key: "monthly" }),
    ),
  );
  assertEquals(response.status, 201);
  assertEquals(preparedInputs, [{
    input: { click_id: "b".repeat(48), offer_key: "monthly" },
    idempotencyKey: nonce,
  }]);
  assertEquals(authorizedScopes, [[
    "primary",
    "b".repeat(48),
    funnelBinding.productId,
    funnelBinding.funnelId,
  ]]);
  assertEquals(finalizations, [{
    attempt_id: prepared.attemptId,
    status: "open",
    stripe_session_id: "cs_live_1234567890",
    checkout_url: "https://checkout.stripe.com/c/pay/live_session",
    expires_at: "2026-08-29T08:00:00.000Z",
  }]);
  const payload = await response.json();
  assertEquals(
    payload.checkout_url,
    "https://checkout.stripe.com/c/pay/live_session",
  );
  assertEquals(payload.attempt_id, prepared.publicAttemptId);
});

Deno.test("checkout endpoint rejects browser calls and client-supplied commercial fields", async () => {
  let preparedCount = 0;
  const handler = createCheckoutSessionHandler({
    funnelBindings: () => new Map([["primary", funnelBinding]]),
    authorizeScope,
    redirectOrigins: () => new Set(["https://product.kissmyapps.dev"]),
    stripeSecret: () => stripeSecret,
    prepare: () => {
      preparedCount += 1;
      return Promise.resolve(prepared);
    },
  });
  const browserResponse = await handler(
    await signedRequest(
      JSON.stringify({ click_id: "b".repeat(48), offer_key: "monthly" }),
      { origin: "https://product.kissmyapps.dev" },
    ),
  );
  assertEquals(browserResponse.status, 403);

  const injectedResponse = await handler(
    await signedRequest(JSON.stringify({
      click_id: "b".repeat(48),
      offer_key: "monthly",
      amount_minor: 1,
      success_url: "https://attacker.example/success",
    })),
  );
  assertEquals(injectedResponse.status, 400);
  assertEquals(preparedCount, 0);
});

Deno.test("checkout endpoint never prepares an attempt when the key scope is rejected", async () => {
  let preparedCount = 0;
  const handler = createCheckoutSessionHandler({
    funnelBindings: () => new Map([["primary", funnelBinding]]),
    redirectOrigins: () => new Set(["https://product.kissmyapps.dev"]),
    stripeSecret: () => stripeSecret,
    authorizeScope: () =>
      Promise.reject(
        new RequestError(
          404,
          "click_unavailable",
          "The affiliate click is unavailable.",
        ),
      ),
    prepare: () => {
      preparedCount += 1;
      return Promise.resolve(prepared);
    },
  });

  const response = await handler(
    await signedRequest(
      JSON.stringify({ click_id: "b".repeat(48), offer_key: "monthly" }),
    ),
  );

  assertEquals(response.status, 404);
  assertEquals(preparedCount, 0);
});

Deno.test("checkout endpoint records a non-sensitive terminal attempt result when Stripe rejects creation", async () => {
  const finalizations: CheckoutFinalization[] = [];
  const handler = createCheckoutSessionHandler({
    funnelBindings: () => new Map([["primary", funnelBinding]]),
    authorizeScope,
    redirectOrigins: () => new Set(["https://product.kissmyapps.dev"]),
    stripeSecret: () => stripeSecret,
    prepare: () => Promise.resolve(prepared),
    finalize: (input) => {
      finalizations.push(input);
      return Promise.resolve();
    },
    createStripeSession: () =>
      Promise.reject(
        new RequestError(
          502,
          "provider_rejected",
          "Checkout could not be created.",
        ),
      ),
  });
  const response = await handler(
    await signedRequest(
      JSON.stringify({ click_id: "b".repeat(48), offer_key: "monthly" }),
    ),
  );
  assertEquals(response.status, 502);
  assertEquals(finalizations, [{
    attempt_id: prepared.attemptId,
    status: "failed",
    failure_code: "provider_rejected",
  }]);
});

Deno.test("checkout endpoint leaves transient Stripe failures prepared for same-nonce retries", async () => {
  const finalizations: CheckoutFinalization[] = [];
  let stripeRequests = 0;
  const handler = createCheckoutSessionHandler({
    funnelBindings: () => new Map([["primary", funnelBinding]]),
    authorizeScope,
    redirectOrigins: () => new Set(["https://product.kissmyapps.dev"]),
    stripeSecret: () => stripeSecret,
    prepare: () => Promise.resolve(prepared),
    finalize: (input) => {
      finalizations.push(input);
      return Promise.resolve();
    },
    createStripeSession: () => {
      stripeRequests += 1;
      return Promise.reject(
        new RequestError(
          502,
          "provider_unavailable",
          "Checkout could not be created.",
        ),
      );
    },
  });
  const body = JSON.stringify({
    click_id: "b".repeat(48),
    offer_key: "monthly",
  });

  const first = await handler(await signedRequest(body));
  const retry = await handler(await signedRequest(body));

  assertEquals(first.status, 502);
  assertEquals(retry.status, 502);
  assertEquals(stripeRequests, 2);
  assertEquals(finalizations, []);
});

Deno.test("Stripe request uses the configured price, redirects, attribution, and idempotency only", async () => {
  const captured: { request?: Request; signal?: AbortSignal | null } = {};
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const session = await createLiveStripeCheckoutSession(
    stripeSecret,
    prepared,
    (input, init) => {
      captured.request = new Request(input, init);
      captured.signal = init?.signal;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "cs_live_abcdefgh12345678",
            url: "https://checkout.stripe.com/c/pay/abcdefgh12345678",
            expires_at: expiresAt,
            livemode: true,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    },
  );
  assertEquals(session.id, "cs_live_abcdefgh12345678");
  const request = captured.request;
  assert(request instanceof Request);
  assertEquals(request.method, "POST");
  assertEquals(request.headers.get("authorization"), `Bearer ${stripeSecret}`);
  assertEquals(request.headers.get("stripe-version"), STRIPE_API_VERSION);
  assert(captured.signal instanceof AbortSignal);
  assertEquals(
    request.headers.get("idempotency-key"),
    `kma-checkout-${prepared.attemptId}`,
  );
  const form = new URLSearchParams(await request.text());
  assertEquals(form.get("mode"), "subscription");
  assertEquals(form.get("line_items[0][price]"), prepared.stripePriceId);
  assertEquals(form.get("line_items[0][quantity]"), "1");
  assertEquals(form.get("success_url"), prepared.successUrl);
  assertEquals(form.get("cancel_url"), prepared.cancelUrl);
  assertEquals(form.get("metadata[kma_click_id]"), prepared.clickRecordId);
  assertEquals(
    form.get("metadata[kma_acquisition_id]"),
    prepared.acquisitionId,
  );
  assertEquals(form.get("metadata[kma_product_id]"), prepared.productId);
  assertEquals(form.get("metadata[kma_attempt_id]"), prepared.attemptId);
  assertEquals(
    form.get("subscription_data[metadata][kma_attempt_id]"),
    prepared.attemptId,
  );
  assertEquals(form.has("price_data[unit_amount]"), false);
  assertEquals(form.toString().includes(stripeSecret), false);
});
