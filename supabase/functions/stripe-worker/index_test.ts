import { assertEquals, assertRejects } from "@std/assert";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";
import {
  buildStripeNormalization,
  type ClaimedStripeEvent,
  createStripeWorkerHandler,
  StripeEventError,
  type StripeNormalizationInput,
} from "./index.ts";

const secret = `sk_live_${"a".repeat(40)}`;
const workerSecret = "worker-secret-long-enough-for-tests";
const attemptId = "11111111-1111-4111-8111-111111111111";

function claim(
  type: string,
  object: Record<string, unknown>,
  attemptCount = 1,
): ClaimedStripeEvent {
  return {
    providerEventId: "22222222-2222-4222-8222-222222222222",
    claimToken: "33333333-3333-4333-8333-333333333333",
    externalEventId: "evt_liveEvidence123",
    eventType: type,
    attemptCount,
    payload: {
      id: "evt_liveEvidence123",
      type,
      livemode: true,
      created: 1787904000,
      data: { object },
    },
  };
}

const metadata = {
  kma_attempt_id: attemptId,
  kma_public_attempt_id: "a".repeat(48),
  kma_offer_id: "44444444-4444-4444-8444-444444444444",
  kma_product_id: "55555555-5555-4555-8555-555555555555",
  kma_acquisition_id: "66666666-6666-4666-8666-666666666666",
  kma_click_id: "77777777-7777-4777-8777-777777777777",
  kma_expected_amount_minor: "1999",
  kma_expected_currency: "USD",
};

Deno.test("paid subscription Checkout retrieves exact live subscription state", async () => {
  const event = claim("checkout.session.completed", {
    id: "cs_live_abcdefgh123",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    amount_total: 1999,
    currency: "usd",
    customer: "cus_abcdefgh123",
    subscription: "sub_abcdefgh123",
    metadata,
  });
  const input = await buildStripeNormalization(
    event,
    secret,
    (request, init) => {
      assertEquals(
        new URL(request.toString()).pathname,
        "/v1/subscriptions/sub_abcdefgh123",
      );
      assertEquals(
        new Headers(init?.headers).get("stripe-version"),
        STRIPE_API_VERSION,
      );
      assertEquals(init?.signal instanceof AbortSignal, true);
      return Promise.resolve(Response.json({
        id: "sub_abcdefgh123",
        customer: "cus_abcdefgh123",
        livemode: true,
        metadata: { kma_attempt_id: attemptId },
        status: "active",
        currency: "usd",
        current_period_start: 1787904000,
        current_period_end: 1790582400,
        canceled_at: null,
      }));
    },
  );
  assertEquals(input, {
    kind: "checkout_subscription_paid",
    object_id: "cs_live_abcdefgh123",
    subscription_id: "sub_abcdefgh123",
    subscription_customer_id: "cus_abcdefgh123",
    subscription_attempt_id: attemptId,
    subscription_status: "active",
    subscription_currency: "USD",
    period_start: 1787904000,
    period_end: 1790582400,
    cancelled_at: null,
    subscription_livemode: true,
  });
});

Deno.test("one-time Checkout is explicit and terminal instead of becoming a subscription", async () => {
  const event = claim("checkout.session.completed", {
    id: "cs_live_abcdefgh123",
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
  });
  const error = await assertRejects(
    () =>
      buildStripeNormalization(
        event,
        secret,
        () => Promise.reject(new Error("must not fetch")),
      ),
    StripeEventError,
  );
  assertEquals(error.code, "unsupported_payment_mode");
  assertEquals(error.terminal, true);
});

Deno.test("invoice normalization requires one paid PaymentIntent and exact charge settlement", async () => {
  const event = claim("invoice.paid", {
    id: "in_abcdefgh123",
    object: "invoice",
    status: "paid",
    paid: true,
    amount_paid: 1999,
    total: 1999,
    total_excluding_tax: 1799,
    currency: "usd",
    customer: "cus_abcdefgh123",
    billing_reason: "subscription_create",
    subscription: "sub_abcdefgh123",
    status_transitions: { paid_at: 1787904000 },
  });
  const calls: string[] = [];
  const input = await buildStripeNormalization(
    event,
    secret,
    (request) => {
      const url = new URL(request.toString());
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/v1/invoice_payments") {
        return Promise.resolve(Response.json({
          has_more: false,
          data: [{
            id: "inpay_abcdefgh123",
            invoice: "in_abcdefgh123",
            status: "paid",
            livemode: true,
            amount_paid: 1999,
            currency: "usd",
            payment: {
              type: "payment_intent",
              payment_intent: "pi_abcdefgh123",
            },
          }],
        }));
      }
      return Promise.resolve(Response.json({
        id: "pi_abcdefgh123",
        livemode: true,
        status: "succeeded",
        amount_received: 1999,
        currency: "usd",
        latest_charge: {
          id: "ch_abcdefgh123",
          livemode: true,
          paid: true,
          status: "succeeded",
          amount: 1999,
          currency: "usd",
          payment_intent: "pi_abcdefgh123",
          balance_transaction: {
            id: "txn_abcdefgh123",
            source: "ch_abcdefgh123",
            reporting_category: "charge",
            amount: 1999,
            fee: 100,
            net: 1899,
            currency: "usd",
          },
        },
      }));
    },
  );
  assertEquals(calls.length, 2);
  assertEquals(input.kind, "invoice_paid");
  assertEquals(input.charge_id, "ch_abcdefgh123");
  assertEquals(input.balance_fee_minor, 100);
  assertEquals(input.balance_net_minor, 1899);
  assertEquals(input.balance_currency, "USD");
});

Deno.test("worker terminally records unsupported events without normalizing", async () => {
  Deno.env.set("INTERNAL_WORKER_SECRET", workerSecret);
  const event = claim("payment_intent.created", {
    id: "pi_abcdefgh123",
    object: "payment_intent",
  });
  const failures: Array<{ code: string; terminal: boolean }> = [];
  const diagnostics: Array<Readonly<Record<string, unknown>>> = [];
  const normalized: StripeNormalizationInput[] = [];
  const handler = createStripeWorkerHandler({
    stripeSecret: () => secret,
    fetcher: fetch,
    claim: () => Promise.resolve([event]),
    normalize: (_claim, input) => {
      normalized.push(input);
      return Promise.resolve();
    },
    fail: (_claim, code, terminal) => {
      failures.push({ code, terminal });
      return Promise.resolve();
    },
    diagnostic: (entry) => diagnostics.push(entry),
  });
  const response = await handler(
    new Request("https://edge.example/stripe-worker", {
      method: "POST",
      headers: { "x-kma-worker-secret": workerSecret },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(normalized, []);
  assertEquals(failures, [{ code: "unsupported_event_type", terminal: true }]);
  const body = await response.json();
  assertEquals(typeof body.request_id, "string");
  delete body.request_id;
  assertEquals(body, {
    status: "processed",
    worker: "stripe-worker",
    claimed: 1,
    processed: 0,
    retried: 0,
    failed: 1,
    deferred: 0,
    mutation_enabled: true,
  });
  assertEquals(diagnostics, [{
    level: "error",
    worker: "stripe-worker",
    outcome: "terminal_item_failure",
    failure_code: "unsupported_event_type",
    provider_event_id: event.providerEventId,
    event_type: event.eventType,
    attempt_count: event.attemptCount,
    request_id: diagnostics[0].request_id,
  }]);
  assertEquals(typeof diagnostics[0].request_id, "string");
  assertEquals(JSON.stringify(diagnostics).includes("payload"), false);
  assertEquals(JSON.stringify(diagnostics).includes(secret), false);
});

Deno.test("worker defers a claimed remainder after its bounded execution deadline", async () => {
  Deno.env.set("INTERNAL_WORKER_SECRET", workerSecret);
  const event = claim("payment_intent.created", {
    id: "pi_abcdefgh123",
    object: "payment_intent",
  });
  let nowCalls = 0;
  let normalized = 0;
  let failures = 0;
  const handler = createStripeWorkerHandler({
    stripeSecret: () => secret,
    fetcher: fetch,
    claim: () => Promise.resolve([event]),
    normalize: () => {
      normalized += 1;
      return Promise.resolve();
    },
    fail: () => {
      failures += 1;
      return Promise.resolve();
    },
    now: () => nowCalls++ === 0 ? 1_000 : 2_000,
    executionDeadlineMs: 500,
  });
  const response = await handler(
    new Request("https://edge.example/stripe-worker", {
      method: "POST",
      headers: { "x-kma-worker-secret": workerSecret },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(normalized, 0);
  assertEquals(failures, 0);
  const body = await response.json();
  assertEquals(body.claimed, 1);
  assertEquals(body.deferred, 1);
});

Deno.test("Stripe API outages retry with a bounded non-sensitive error code", async () => {
  Deno.env.set("INTERNAL_WORKER_SECRET", workerSecret);
  const event = claim("checkout.session.completed", {
    id: "cs_live_abcdefgh123",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    amount_total: 1999,
    currency: "usd",
    customer: "cus_abcdefgh123",
    subscription: "sub_abcdefgh123",
    metadata,
  });
  const failures: Array<{ code: string; terminal: boolean }> = [];
  const handler = createStripeWorkerHandler({
    stripeSecret: () => secret,
    fetcher: () =>
      Promise.resolve(new Response("unavailable", { status: 503 })),
    claim: () => Promise.resolve([event]),
    normalize: () => Promise.reject(new Error("must not normalize")),
    fail: (_claim, code, terminal) => {
      failures.push({ code, terminal });
      return Promise.resolve();
    },
  });
  const response = await handler(
    new Request("https://edge.example/stripe-worker", {
      method: "POST",
      headers: { "x-kma-worker-secret": workerSecret },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(failures, [{ code: "stripe_api_unavailable", terminal: false }]);
});

Deno.test("worker rejects unauthenticated scheduler calls before claiming", async () => {
  Deno.env.set("INTERNAL_WORKER_SECRET", workerSecret);
  let claims = 0;
  const handler = createStripeWorkerHandler({
    stripeSecret: () => secret,
    fetcher: fetch,
    claim: () => {
      claims += 1;
      return Promise.resolve([]);
    },
    normalize: () => Promise.resolve(),
    fail: () => Promise.resolve(),
  });
  const response = await handler(
    new Request("https://edge.example/stripe-worker", { method: "POST" }),
  );
  assertEquals(response.status, 401);
  assertEquals(claims, 0);
});
