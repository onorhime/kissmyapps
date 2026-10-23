import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  bytesToHex,
  hmacSha256,
  parseFunnelSignatureHeaders,
  verifyFunnelSignature,
} from "../_shared/crypto.ts";
import { RequestError } from "../_shared/errors.ts";
import { createManagedCheckoutHandler } from "./index.ts";
import { ManagedProvider } from "./provider.ts";
import {
  FakeManagedStripe,
  fixtureBinding,
  fixtureInput,
  fixtureOrder,
} from "./test-support.ts";
import { type Json, publicOrder, validateInput } from "./contract.ts";
import { deliver } from "../managed-checkout-worker/index.ts";

async function signed(value: unknown, secret = fixtureBinding.secret) {
  const body = JSON.stringify(value),
    t = String(Math.floor(Date.now() / 1000)),
    nonce = crypto.randomUUID();
  return new Request("https://fixture.invalid/managed-checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-kma-key-id": fixtureBinding.id,
      "x-kma-timestamp": t,
      "x-kma-nonce": nonce,
      "x-kma-signature": bytesToHex(
        await hmacSha256(secret, `${t}.${nonce}.${body}`),
      ),
    },
    body,
  });
}
Deno.test("managed request requires exact account-bound action, reservation and safe returns", () => {
  assertEquals(validateInput(fixtureInput(), fixtureBinding).action, "create");
  for (
    const patch of [
      { customer_email: "bad" },
      { attempt_id: crypto.randomUUID() },
      { amount_minor: 1.5 },
      { success_url: "https://foreign.example/return" },
      { callback_url: "https://attacker.example" },
      {
        context: {
          calendar_hash: "a".repeat(64),
          registration_id: crypto.randomUUID(),
          cohort_id: crypto.randomUUID(),
          extra: true,
        },
      },
      { click_id: "opaque_fixture_click_123456" },
    ]
  ) {
    assertThrows(
      () => validateInput({ ...fixtureInput(), ...patch }, fixtureBinding),
      RequestError,
    );
  }
});
Deno.test("managed endpoint rejects missing/wrong signature, browser origin and disabled checkout before persistence", async () => {
  let calls = 0;
  const fake = new FakeManagedStripe();
  const handler = createManagedCheckoutHandler({
    bindings: () => new Map([[fixtureBinding.id, fixtureBinding]]),
    enabled: () => false,
    store: {
      rpc: () => {
        calls++;
        throw Error("unexpected persistence");
      },
    },
    provider: (b) => new ManagedProvider(b, fake.fetch),
  });
  assertEquals(
    (await handler(
      new Request("https://fixture.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    )).status,
    401,
  );
  assertEquals(
    (await handler(await signed(fixtureInput(), "wrongsecret"))).status,
    401,
  );
  const req = await signed(fixtureInput());
  req.headers.set("Origin", "https://browser.invalid");
  assertEquals((await handler(req)).status, 403);
  assertEquals((await handler(await signed(fixtureInput()))).status, 503);
  assertEquals(calls, 0);
  assertEquals(fake.calls.length, 0);
});
Deno.test("saved server price and merchant account cannot be overridden", async () => {
  const fake = new FakeManagedStripe(),
    p = new ManagedProvider(fixtureBinding, fake.fetch),
    offer = {
      stripe_price_id: fake.priceId,
      unit_amount_minor: 16900,
      currency: "USD",
    };
  await p.verifyAccount();
  await p.verifyPrice(offer);
  fake.priceAmount = 100;
  await assertRejects(() => p.verifyPrice(offer), RequestError);
  fake.priceAmount = 16900;
  fake.priceType = "recurring";
  await assertRejects(() => p.verifyPrice(offer), RequestError);
  fake.priceType = "one_time";
  fake.livemode = true;
  await assertRejects(() => p.verifyPrice(offer), RequestError);
  fake.accountId = "acct_foreign";
  await assertRejects(() => p.verifyAccount(), RequestError);
});
Deno.test("lost creation reply recovers one session without a second provider POST", async () => {
  const fake = new FakeManagedStripe(),
    p = new ManagedProvider(fixtureBinding, fake.fetch),
    order = fixtureOrder(),
    first = new Date().toISOString();
  fake.failAfterCreate = true;
  await assertRejects(() => p.create(order, first), RequestError);
  const session = await p.create(order, first);
  assertEquals(fake.sessions.size, 1);
  assertEquals(
    fake.calls.filter((c) =>
      c.method === "POST" && c.path === "checkout/sessions"
    ).length,
    1,
  );
  assertEquals(session.client_reference_id, order.external_order_id);
  const snapshot = await p.snapshot(order, session);
  assertEquals(snapshot?.payment_status, "unpaid");
  assertEquals(snapshot?.session_status, "open");
});
Deno.test("old unresolved operations do not create another provider payment", async () => {
  const fake = new FakeManagedStripe(),
    p = new ManagedProvider(fixtureBinding, fake.fetch),
    order = fixtureOrder();
  await assertRejects(
    () => p.create(order, new Date(Date.now() - 24 * 3600000).toISOString()),
    RequestError,
  );
  assertEquals(fake.sessions.size, 0);
});
Deno.test("paid verification checks exact identity, amount, mode and immutable metadata", async () => {
  const fake = new FakeManagedStripe(),
    p = new ManagedProvider(fixtureBinding, fake.fetch),
    order = fixtureOrder();
  const s = await p.create(order, new Date().toISOString());
  const pid = fake.pay(String(s.id));
  const snapshot = await p.snapshot(order);
  assertEquals(snapshot, null);
  const open = { ...order, checkout_session_id: String(s.id) },
    paid = await p.snapshot(open);
  assertEquals(paid?.payment_intent_id, pid);
  assertEquals(paid?.payment_status, "paid");
  assert(paid?.paid_at);
  fake.payments.get(pid)!.amount_received = 16899;
  await assertRejects(() => p.snapshot(open), RequestError);
  fake.payments.get(pid)!.amount_received = 16900;
  fake.payments.get(pid)!.livemode = true;
  await assertRejects(() => p.snapshot(open), RequestError);
});
Deno.test("full refund lost reply reuses provider identity and verifies cumulative successful amount", async () => {
  const fake = new FakeManagedStripe(),
    p = new ManagedProvider(fixtureBinding, fake.fetch),
    base = fixtureOrder(),
    s = await p.create(base, new Date().toISOString()),
    pid = fake.pay(String(s.id));
  const order = {
    ...base,
    checkout_session_id: String(s.id),
    payment_intent_id: pid,
  };
  const op = {
    id: crypto.randomUUID(),
    first_attempt_at: new Date().toISOString(),
    request: { amount_minor: 16900 },
  };
  fake.failAfterRefund = true;
  await assertRejects(() => p.refund(order, op), RequestError);
  const refund = await p.refund(order, op);
  assertEquals(fake.refunds.size, 1);
  assertEquals(
    fake.calls.filter((c) => c.method === "POST" && c.path === "refunds")
      .length,
    1,
  );
  assertEquals(refund.status, "succeeded");
  const snapshot = await p.snapshot(order);
  assert(snapshot);
  assertEquals((snapshot.facts as Json[]).length, 1);
  assertEquals(snapshot?.refund_id, refund.id);
});
Deno.test("partial refunds and dispute outcomes produce stable distinct verified facts", async () => {
  const fake = new FakeManagedStripe(),
    p = new ManagedProvider(fixtureBinding, fake.fetch),
    base = fixtureOrder(),
    s = await p.create(base, new Date().toISOString()),
    pid = fake.pay(String(s.id)),
    order = {
      ...base,
      checkout_session_id: String(s.id),
      payment_intent_id: pid,
    };
  await p.refund(order, {
    id: crypto.randomUUID(),
    first_attempt_at: new Date().toISOString(),
    request: { amount_minor: 5000 },
  });
  fake.dispute(pid);
  let snapshot = await p.snapshot(order);
  assertEquals(snapshot?.dispute_status, "open");
  assert(snapshot);
  assertEquals((snapshot.facts as Json[]).length, 2);
  fake.dispute(pid, "won");
  snapshot = await p.snapshot(order);
  assert(snapshot);
  assertEquals(snapshot.dispute_status, "won");
  assert(
    (snapshot.facts as Json[]).some((x) =>
      String(x.provider_key).endsWith("dispute_won")
    ),
  );
});
Deno.test("outbound payment event requires signed exact body and exact event acknowledgement", async () => {
  const event = {
    id: crypto.randomUUID(),
    lease_token: crypto.randomUUID(),
    payload: { event_id: "", version: 1, type: "order.paid" },
  };
  event.payload.event_id = event.id;
  const transport: typeof fetch = async (_url, init) => {
    const bytes = new TextEncoder().encode(String(init?.body));
    await verifyFunnelSignature(
      bytes,
      parseFunnelSignatureHeaders(new Headers(init?.headers)),
      new Map([[fixtureBinding.callbackKeyId, fixtureBinding.callbackSecret]]),
    );
    assertEquals(init?.redirect, "error");
    return Response.json({ accepted: true, event_id: event.id });
  };
  assertEquals(await deliver(fixtureBinding, event, transport), true);
  assertEquals(
    await deliver(
      fixtureBinding,
      event,
      () =>
        Promise.resolve(Response.json({ accepted: true, event_id: "wrong" })),
    ),
    false,
  );
  assertEquals(
    await deliver(
      fixtureBinding,
      event,
      () => Promise.resolve(Response.json({}, { status: 503 })),
    ),
    false,
  );
});
Deno.test("public order excludes customer email, provider key and internal request", () => {
  const order = fixtureOrder({
    request: fixtureInput({ customer_email: "private@example.invalid" }),
  });
  const output = publicOrder(order);
  assertEquals(output.request, undefined);
  assertEquals(output.binding_id, undefined);
  assertEquals(output.stripe_price_id, undefined);
  assert(!JSON.stringify(output).includes("private@example.invalid"));
});
Deno.test("pending refund evidence persists without claiming a successful refund and later becomes succeeded", async () => {
  const fake = new FakeManagedStripe(),
    p = new ManagedProvider(fixtureBinding, fake.fetch),
    order = fixtureOrder();
  const session = await p.create(order, new Date().toISOString()),
    payment = fake.pay(String(session.id));
  const paid = fixtureOrder({
    ...order,
    checkout_session_id: String(session.id),
    payment_intent_id: payment,
  });
  const operation = {
    id: crypto.randomUUID(),
    first_attempt_at: new Date().toISOString(),
    request: { amount_minor: 16900 },
  };
  fake.refundStatus = "pending";
  fake.failAfterRefund = true;
  await assertRejects(() => p.refund(paid, operation));
  const pending = await p.refund(paid, operation),
    before = await p.snapshot(paid, undefined, pending);
  assertEquals(before?.refund_id, pending.id);
  assertEquals(before?.refund_status, "pending");
  assertEquals(before?.facts, []);
  assertEquals(
    fake.calls.filter((c) => c.method === "POST" && c.path === "refunds")
      .length,
    1,
  );
  const record = fake.refunds.get(String(pending.id))!;
  record.status = "succeeded";
  fake.charges.get(String(record.charge))!.amount_refunded = 16900;
  const after = await p.snapshot({
    ...paid,
    refund_id: String(pending.id),
    refund_status: "pending",
  });
  assert(after);
  assertEquals(after.refund_status, "succeeded");
  assertEquals((after.facts as Json[]).length, 1);
  const adjustment = await p.adjustment(paid, (after.facts as Json[])[0]);
  assert(/^evt_[A-Za-z0-9]+$/.test(String(adjustment.provider_event_id)));
  assertEquals(
    (await p.adjustment(paid, (after.facts as Json[])[0])).provider_event_id,
    adjustment.provider_event_id,
  );
});
