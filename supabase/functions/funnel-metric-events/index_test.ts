import { assertEquals, assertThrows } from "@std/assert";
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { RequestError } from "../_shared/errors.ts";
import { createFunnelMetricEventHandler } from "./index.ts";
import { validateMetricEvent } from "./contract.ts";
const secret = "local-only-metric-test-signing-key-not-a-real-key";
const productId = "11111111-1111-4111-8111-111111111111",
  funnelId = "22222222-2222-4222-8222-222222222222";
const base = () => ({
  event_id: "33333333-3333-4333-8333-333333333333",
  event_name: "webinar_registered",
  click_id: "opaque_test_click_123456",
  subject_id: "opaque_product_subject_123456",
  context_id: "webinar_one",
  occurred_at: new Date().toISOString(),
});
async function signed(body: unknown, override: Record<string, string> = {}) {
  const text = JSON.stringify(body),
    timestamp = String(Math.floor(Date.now() / 1000)),
    nonce = "metric_fixture_nonce_12345";
  const bytes = new TextEncoder().encode(`${timestamp}.${nonce}.${text}`);
  const signature = bytesToHex(await hmacSha256(secret, bytes));
  return new Request("https://edge.example/functions/v1/funnel-metric-events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kma-key-id": "fixture",
      "x-kma-nonce": nonce,
      "x-kma-signature": signature,
      "x-kma-timestamp": timestamp,
      ...override,
    },
    body: text,
  });
}
Deno.test("signed metric packet derives exact product/funnel from binding", async () => {
  const calls: unknown[] = [];
  const handler = createFunnelMetricEventHandler({
    bindings: () => new Map([["fixture", { secret, productId, funnelId }]]),
    authorize: (...args) => {
      calls.push(args);
      return Promise.resolve();
    },
    ingest: (...args) => {
      calls.push(args);
      return Promise.resolve({
        event_id: "44444444-4444-4444-8444-444444444444",
        duplicate: false,
      });
    },
  });
  const event = base();
  const response = await handler(await signed(event));
  assertEquals(response.status, 200);
  assertEquals(calls[0], ["fixture", event.click_id, productId, funnelId]);
  assertEquals(calls[1], [productId, funnelId, event]);
});
Deno.test("forged revenue/affiliate or browser requests never reach SQL", async () => {
  let calls = 0;
  const handler = createFunnelMetricEventHandler({
    bindings: () => new Map([["fixture", { secret, productId, funnelId }]]),
    authorize: () => {
      calls++;
      return Promise.resolve();
    },
    ingest: () => Promise.resolve({ event_id: "x", duplicate: false }),
  });
  for (
    const field of [
      "affiliate_id",
      "revenue",
      "earnings",
      "product_id",
      "properties",
    ]
  ) {
    assertEquals(
      (await handler(await signed({ ...base(), [field]: "forged" }))).status,
      400,
    );
  }
  assertEquals(
    (await handler(await signed(base(), { origin: "https://evil.example" })))
      .status,
    403,
  );
  assertEquals(
    (await handler(await signed(base(), { "x-kma-signature": "0".repeat(64) })))
      .status,
    401,
  );
  assertEquals(calls, 0);
});
Deno.test("scoped click rejection prevents ingestion", async () => {
  let count = 0;
  const handler = createFunnelMetricEventHandler({
    bindings: () => new Map([["fixture", { secret, productId, funnelId }]]),
    authorize: () =>
      Promise.reject(new RequestError(404, "missing", "Unavailable")),
    ingest: () => {
      count++;
      return Promise.resolve({ event_id: "x", duplicate: false });
    },
  });
  assertEquals((await handler(await signed(base()))).status, 404);
  assertEquals(count, 0);
});
Deno.test("opaque identity, finite times and bounded presence", () => {
  const now = Date.now(), e = base();
  validateMetricEvent(e, now);
  assertThrows(() =>
    validateMetricEvent({ ...e, subject_id: "person@example.com" })
  );
  assertThrows(() => validateMetricEvent({ ...e, occurred_at: "infinity" }));
  assertThrows(() =>
    validateMetricEvent({
      ...e,
      occurred_at: new Date(now + 301_000).toISOString(),
    }, now)
  );
  const presence = {
    ...e,
    session_id: "session_one",
    state_value: "active",
    presence_expires_at: new Date(Date.parse(e.occurred_at) + 300_000)
      .toISOString(),
  };
  validateMetricEvent(presence, now);
  assertThrows(() =>
    validateMetricEvent({
      ...presence,
      presence_expires_at: new Date(Date.parse(e.occurred_at) + 301_000)
        .toISOString(),
    }, now)
  );
  assertThrows(() =>
    validateMetricEvent({ ...presence, session_id: undefined }, now)
  );
});
Deno.test("generic reporting dimensions are optional opaque immutable packet fields", () => {
  const event = {
    ...base(),
    channel: "creator",
    entry_variant: "book",
    webinar_id: "webinar_1",
    intake_id: "intake_1",
  };
  assertEquals(validateMetricEvent(event), event);
  for (const key of ["channel", "entry_variant", "webinar_id", "intake_id"]) {
    assertThrows(() =>
      validateMetricEvent({ ...event, [key]: "person@example.com" })
    );
  }
});
Deno.test("journey v2 validates typed identity and business idempotency without accepting commerce facts", () => {
  const event = {
    ...base(),
    schema_version: "2" as const,
    environment: "test" as const,
    dedupe_key: "registration:webinar_one:learner_123",
    order_id: "order_123",
    request_source: "checkout_cancelled",
  };
  assertEquals(validateMetricEvent(event), event);
  const link = {
    ...event,
    event_name: "identity_linked",
    state_value: "verified",
    aliased_subject_id: "opaque_guest_subject_123456",
  };
  assertEquals(validateMetricEvent(link), link);
  for (
    const altered of [
      { ...event, schema_version: 2 },
      { ...event, schema_version: "3" },
      { ...event, environment: "production" },
      { ...event, dedupe_key: "" },
      { ...event, state_revision: "0" },
      { ...event, state_revision: "-1" },
      { ...event, state_revision: "1.5" },
      { ...event, state_revision: "1000000000" },
      { ...event, order_id: "person@example.com" },
      { ...event, event_name: "purchase_completed" },
      { ...event, event_name: "refund_status_updated" },
      { ...event, event_name: "commission_status_updated" },
      { ...link, state_value: "unverified" },
      { ...link, aliased_subject_id: event.subject_id },
      { ...base(), environment: "test" },
    ]
  ) assertThrows(() => validateMetricEvent(altered));
});
Deno.test("signed v2 preserves identity evidence to the scoped database boundary", async () => {
  const event = {
    ...base(),
    schema_version: "2" as const,
    environment: "test" as const,
    dedupe_key: "registration:one",
  };
  const calls: unknown[] = [];
  const handler = createFunnelMetricEventHandler({
    bindings: () => new Map([["fixture", { secret, productId, funnelId }]]),
    authorize: () => Promise.resolve(),
    ingest: (...args) => {
      calls.push(args);
      return Promise.resolve({ event_id: event.event_id, duplicate: true });
    },
  });
  const response = await handler(await signed(event));
  assertEquals(response.status, 200);
  assertEquals(calls, [[productId, funnelId, event]]);
});

Deno.test("signed click resolution returns database scope without recording an event", async () => {
  const calls: unknown[] = [];
  const click = base().click_id;
  const context = {
    click_id: click,
    link_id: "44444444-4444-4444-8444-444444444444",
    product_id: productId,
    funnel_id: funnelId,
    environment: "test" as const,
  };
  const handler = createFunnelMetricEventHandler({
    bindings: () => new Map([["fixture", { secret, productId, funnelId }]]),
    authorize: (...args) => {
      calls.push(args);
      return Promise.resolve();
    },
    resolve: (...args) => {
      calls.push(args);
      return Promise.resolve(context);
    },
    ingest: () => {
      throw Error("Resolution must not write event");
    },
  });
  const response = await handler(
    await signed({ operation: "resolve_click", click_id: click }),
  );
  assertEquals(response.status, 200);
  assertEquals((await response.json()).context, context);
  assertEquals(calls, [["fixture", click, productId, funnelId], [
    productId,
    funnelId,
    click,
  ]]);
});

Deno.test("click resolution rejects browser, forged scope, mode and invalid operations before database", async () => {
  let calls = 0;
  const handler = createFunnelMetricEventHandler({
    bindings: () => new Map([["fixture", { secret, productId, funnelId }]]),
    authorize: () => {
      calls++;
      return Promise.resolve();
    },
  });
  const body = { operation: "resolve_click", click_id: base().click_id };
  for (
    const extra of [
      { environment: "live" },
      { product_id: productId },
      { funnel_id: funnelId },
      { link_id: "forged" },
      { operation: "change_environment" },
      { click_id: "short" },
    ]
  ) {
    assertEquals(
      (await handler(await signed({ ...body, ...extra }))).status,
      400,
    );
  }
  assertEquals(
    (await handler(
      await signed(body, { origin: "https://marathon.speaksix.com" }),
    )).status,
    403,
  );
  assertEquals(
    (await handler(await signed(body, { "x-kma-signature": "a".repeat(64) })))
      .status,
    401,
  );
  assertEquals(calls, 0);
});

Deno.test("verified same-link revisit preserves both opaque click references", async () => {
  const event = {
    ...base(),
    schema_version: "2" as const,
    environment: "test" as const,
    dedupe_key: "visitor_link:revisit",
    event_name: "identity_linked",
    state_value: "verified",
    aliased_subject_id: "anonymous_visitor_123456789",
    aliased_click_id: "earlier_valid_click_123456789",
  };
  assertEquals(validateMetricEvent(event), event);
  for (
    const altered of [
      { ...event, event_name: "resource_opened" },
      { ...event, aliased_click_id: "person@example.com" },
      { ...event, aliased_click_id: "short" },
      { ...event, state_value: "unverified" },
      { ...base(), aliased_click_id: event.aliased_click_id },
    ]
  ) assertThrows(() => validateMetricEvent(altered));
  const received: unknown[] = [];
  const handler = createFunnelMetricEventHandler({
    bindings: () => new Map([["fixture", { secret, productId, funnelId }]]),
    authorize: () => Promise.resolve(),
    ingest: (_product, _funnel, packet) => {
      received.push(packet);
      return Promise.resolve({ event_id: event.event_id, duplicate: false });
    },
  });
  assertEquals((await handler(await signed(event))).status, 200);
  assertEquals(received, [event]);
});
