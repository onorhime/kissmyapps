import type { SupabaseClient } from "@supabase/supabase-js";
import { assertEquals, assertRejects } from "@std/assert";
import {
  ConfigurationError,
  DatabaseBoundaryError,
  RequestError,
} from "./errors.ts";
import {
  isKissMyAppsStripeEvent,
  ownsStripeReference,
  type StripeOwnershipDependencies,
} from "./stripe-ownership.ts";
import { parseStripeEvent } from "./stripe.ts";
import { STRIPE_API_VERSION } from "./stripe-api.ts";

const attempt = "10000000-0000-4000-8000-000000009601";
const sub = "sub_owned123456";
const charge = "ch_owned123456";
const invoice = "in_owned123456";
const intent = "pi_owned123456";
const metadata = { kma_attempt_id: attempt };
function event(type: string, row: Record<string, unknown>) {
  return parseStripeEvent(new TextEncoder().encode(JSON.stringify({
    id: "evt_ownership1234",
    type,
    api_version: STRIPE_API_VERSION,
    livemode: true,
    data: { object: row },
  })));
}
function harness(options: {
  known?: boolean;
  attemptKnown?: boolean;
  resources?: Record<string, Record<string, unknown>>;
  status?: number;
  transportError?: boolean;
} = {}) {
  const lookups: unknown[] = [];
  const requests: { url: URL; init?: RequestInit }[] = [];
  const deps: StripeOwnershipDependencies = {
    owns: (kind, id, meta) => {
      lookups.push({ kind, id, meta });
      return Promise.resolve(
        options.known === true ||
          (options.attemptKnown === true && meta.kma_attempt_id === attempt),
      );
    },
    stripeSecret: () => "rk_live_ownership_test_not_a_real_key",
    fetcher: (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (options.transportError) {
        return Promise.reject(new Error("private provider error"));
      }
      const row = options.resources?.[url.pathname];
      return Promise.resolve(
        Response.json(row ?? {}, {
          status: options.status ?? (row ? 200 : 404),
        }),
      );
    },
  };
  return { deps, requests, lookups };
}

for (
  const type of [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
  ]
) {
  Deno.test(`ownership: ${type} checks persisted session/metadata without Stripe GET`, async () => {
    const h = harness({ attemptKnown: true });
    assertEquals(
      await isKissMyAppsStripeEvent(
        event(type, { id: "cs_live_owned123456", metadata }),
        h.deps,
      ),
      true,
    );
    assertEquals(h.requests.length, 0);
    assertEquals(h.lookups, [{
      kind: "checkout",
      id: "cs_live_owned123456",
      meta: metadata,
    }]);
    assertEquals(
      await isKissMyAppsStripeEvent(
        event(type, {
          id: "cs_live_other123456",
          metadata: { kma_product_id: "not-proof" },
        }),
        harness().deps,
      ),
      false,
    );
  });
}
for (
  const type of [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ]
) {
  Deno.test(`ownership: ${type} before checkout normalization retains only known attempt`, async () => {
    const h = harness({ attemptKnown: true });
    assertEquals(
      await isKissMyAppsStripeEvent(event(type, { id: sub, metadata }), h.deps),
      true,
    );
    assertEquals(h.requests.length, 0);
    assertEquals(
      await isKissMyAppsStripeEvent(event(type, { id: sub }), harness().deps),
      false,
    );
    assertEquals(
      await isKissMyAppsStripeEvent(
        event(type, { id: sub }),
        harness({ known: true }).deps,
      ),
      true,
    );
  });
}
Deno.test("ownership: out-of-order invoice retrieves subscription and sends only attempt metadata to DB", async () => {
  const h = harness({
    attemptKnown: true,
    resources: {
      [`/v1/subscriptions/${sub}`]: {
        id: sub,
        object: "subscription",
        livemode: true,
        metadata: { ...metadata, email: "private@example.invalid" },
      },
    },
  });
  assertEquals(
    await isKissMyAppsStripeEvent(
      event("invoice.paid", {
        id: invoice,
        parent: { subscription_details: { subscription: sub } },
      }),
      h.deps,
    ),
    true,
  );
  assertEquals(h.lookups, [
    { kind: "subscription", id: sub, meta: {} },
    { kind: "subscription", id: sub, meta: metadata },
  ]);
  assertEquals(h.requests[0].init?.method, "GET");
  assertEquals(
    new Headers(h.requests[0].init?.headers).get("Stripe-Version"),
    STRIPE_API_VERSION,
  );
  assertEquals(Boolean(h.requests[0].init?.signal), true);
});
Deno.test("ownership: unrelated invoice and standalone invoice are ignored", async () => {
  const h = harness({
    resources: {
      [`/v1/subscriptions/${sub}`]: {
        id: sub,
        object: "subscription",
        livemode: true,
        metadata: {},
      },
    },
  });
  assertEquals(
    await isKissMyAppsStripeEvent(
      event("invoice.paid", { subscription: sub }),
      h.deps,
    ),
    false,
  );
  assertEquals(
    await isKissMyAppsStripeEvent(
      event("invoice.paid", { parent: null }),
      h.deps,
    ),
    false,
  );
  assertEquals(h.requests.length, 1);
});
for (
  const type of [
    "refund.created",
    "refund.updated",
    "charge.dispute.created",
    "charge.dispute.updated",
    "charge.dispute.closed",
  ]
) {
  Deno.test(`ownership: ${type} accepts known charge without provider lookup`, async () => {
    const h = harness({ known: true });
    assertEquals(
      await isKissMyAppsStripeEvent(event(type, { charge }), h.deps),
      true,
    );
    assertEquals(h.requests.length, 0);
  });
}
const refundResources = {
  [`/v1/charges/${charge}`]: {
    id: charge,
    object: "charge",
    livemode: true,
    payment_intent: intent,
  },
  "/v1/invoice_payments": {
    object: "list",
    has_more: false,
    data: [{
      livemode: true,
      status: "paid",
      invoice,
      payment: { type: "payment_intent", payment_intent: intent },
    }],
  },
  [`/v1/invoices/${invoice}`]: {
    id: invoice,
    object: "invoice",
    livemode: true,
    parent: { subscription_details: { subscription: sub } },
  },
  [`/v1/subscriptions/${sub}`]: {
    id: sub,
    object: "subscription",
    livemode: true,
    metadata,
  },
};
Deno.test("ownership: refund before normalization resolves bounded charge/payment/invoice/subscription chain", async () => {
  const h = harness({ attemptKnown: true, resources: refundResources });
  assertEquals(
    await isKissMyAppsStripeEvent(event("refund.created", { charge }), h.deps),
    true,
  );
  assertEquals(h.requests.length, 4);
  assertEquals(
    h.requests[1].url.searchParams.get("payment[payment_intent]"),
    intent,
  );
  assertEquals(
    h.requests[1].url.searchParams.get("payment[type]"),
    "payment_intent",
  );
  assertEquals(
    h.requests.every((r) => r.init?.signal === h.requests[0].init?.signal),
    true,
  );
});
Deno.test("ownership: unrelated refund is ignored and no customer-wide query is made", async () => {
  const h = harness({
    resources: {
      ...refundResources,
      [`/v1/subscriptions/${sub}`]: {
        id: sub,
        object: "subscription",
        livemode: true,
        metadata: {},
      },
    },
  });
  assertEquals(
    await isKissMyAppsStripeEvent(
      event("charge.dispute.created", { charge }),
      h.deps,
    ),
    false,
  );
  assertEquals(
    h.requests.some((r) => r.url.pathname.includes("customers")),
    false,
  );
});
Deno.test("ownership: legacy charge invoice reference and non-invoice charge", async () => {
  const h = harness({
    attemptKnown: true,
    resources: {
      ...refundResources,
      [`/v1/charges/${charge}`]: {
        id: charge,
        object: "charge",
        livemode: true,
        invoice,
      },
    },
  });
  assertEquals(
    await isKissMyAppsStripeEvent(event("refund.created", { charge }), h.deps),
    true,
  );
  assertEquals(h.requests.length, 3);
  const other = harness({
    resources: {
      ...refundResources,
      "/v1/invoice_payments": { object: "list", has_more: false, data: [] },
    },
  });
  assertEquals(
    await isKissMyAppsStripeEvent(
      event("refund.created", { charge }),
      other.deps,
    ),
    false,
  );
});
for (const status of [404, 429, 500]) {
  Deno.test(`ownership: HTTP ${status} retries rather than ignoring`, async () => {
    await assertRejects(
      () =>
        isKissMyAppsStripeEvent(
          event("invoice.paid", { subscription: sub }),
          harness({ status }).deps,
        ),
      RequestError,
      "Retry delivery",
    );
  });
}
for (const status of [401, 403]) {
  Deno.test(`ownership: restricted-key HTTP ${status} fails closed`, async () => {
    await assertRejects(
      () =>
        isKissMyAppsStripeEvent(
          event("invoice.paid", { subscription: sub }),
          harness({ status }).deps,
        ),
      ConfigurationError,
    );
  });
}
Deno.test("ownership: transport failure retries without exposing provider error", async () => {
  await assertRejects(
    () =>
      isKissMyAppsStripeEvent(
        event("invoice.paid", { subscription: sub }),
        harness({ transportError: true }).deps,
      ),
    RequestError,
    "Event ownership could not be verified",
  );
});
Deno.test("ownership: mismatched/test resource and ambiguous payment chain fail closed", async () => {
  for (
    const invalid of [{ id: "sub_wrong123456", livemode: true }, {
      id: sub,
      livemode: false,
    }]
  ) {
    await assertRejects(
      () =>
        isKissMyAppsStripeEvent(
          event("invoice.paid", { subscription: sub }),
          harness({
            resources: {
              [`/v1/subscriptions/${sub}`]: {
                object: "subscription",
                ...invalid,
              },
            },
          }).deps,
        ),
      RequestError,
    );
  }
  for (
    const data of [{ object: "list", has_more: true, data: [] }, {
      object: "list",
      has_more: false,
      data: [{}, {}],
    }]
  ) {
    await assertRejects(
      () =>
        isKissMyAppsStripeEvent(
          event("refund.created", { charge }),
          harness({
            resources: {
              ...refundResources,
              "/v1/invoice_payments": data,
            },
          }).deps,
        ),
      RequestError,
    );
  }
});
Deno.test("ownership: DB failure or malformed result cannot become unrelated", async () => {
  for (
    const result of [{ data: null, error: { code: "42501" } }, {
      data: "false",
      error: null,
    }]
  ) {
    const client = {
      rpc: () => Promise.resolve(result),
    } as unknown as SupabaseClient;
    await assertRejects(
      () => ownsStripeReference(client, "charge", charge, {}),
      DatabaseBoundaryError,
    );
  }
});

Deno.test("ownership: malformed invoice subscription is inconclusive, not unrelated", async () => {
  for (
    const row of [{ subscription: "bad-id" }, {
      parent: { subscription_details: { subscription: "bad-id" } },
    }]
  ) {
    await assertRejects(
      () => isKissMyAppsStripeEvent(event("invoice.paid", row), harness().deps),
      RequestError,
    );
  }
});
