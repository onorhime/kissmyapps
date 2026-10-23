import { assertEquals, assertRejects } from "@std/assert";
import { parseStripeEvent } from "../_shared/stripe.ts";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";
import {
  buildStripeNormalization,
  type ClaimedStripeEvent,
  StripeEventError,
} from "./index.ts";
const secret = `sk_live_${"a".repeat(40)}`;
const sub = {
  id: "sub_CloverFixture123",
  object: "subscription",
  livemode: true,
  status: "active",
  currency: "usd",
  customer: "cus_CloverFixture123",
  metadata: { kma_attempt_id: "11111111-1111-4111-8111-111111111111" },
  items: {
    has_more: false,
    data: [{
      current_period_start: 1788710400,
      current_period_end: 1791302400,
      price: { secret: "discard" },
    }],
  },
};
function claim(
  object: Record<string, unknown>,
  type = "customer.subscription.created",
): ClaimedStripeEvent {
  return {
    providerEventId: "22222222-2222-4222-8222-222222222222",
    claimToken: "33333333-3333-4333-8333-333333333333",
    externalEventId: "evt_CloverFixture123",
    eventType: type,
    attemptCount: 1,
    payload: parseStripeEvent(
      new TextEncoder().encode(
        JSON.stringify({
          id: "evt_CloverFixture123",
          type,
          livemode: true,
          api_version: STRIPE_API_VERSION,
          created: 1788710400,
          data: { object },
        }),
      ),
    ).payload,
  };
}
Deno.test("Clover item periods survive minimization without price data", async () => {
  const event = claim(sub);
  assertEquals(JSON.stringify(event.payload).includes("secret"), false);
  assertEquals(await buildStripeNormalization(event, secret), {
    kind: "subscription_changed",
    object_id: sub.id,
  });
  for (
    const items of [{ has_more: true, data: sub.items.data }, {
      has_more: false,
      data: [...sub.items.data, {
        current_period_start: 1788710401,
        current_period_end: 1791302400,
      }],
    }]
  ) {
    await assertRejects(
      () => buildStripeNormalization(claim({ ...sub, items }), secret),
      StripeEventError,
    );
  }
});
Deno.test("Recovery retrieves original Event and rejects changed identity", async () => {
  const { items: _items, ...old } = sub;
  const event = claim(old);
  const original = {
    ...event.payload,
    api_version: STRIPE_API_VERSION,
    data: { object: sub },
  };
  const result = await buildStripeNormalization(
    event,
    secret,
    async (input) => {
      await Promise.resolve();
      assertEquals(
        new URL(String(input)).pathname,
        "/v1/events/evt_CloverFixture123",
      );
      return Response.json(original);
    },
  );
  assertEquals(result.recovered_event, claim(sub).payload);
  await assertRejects(
    () =>
      buildStripeNormalization(event, secret, () =>
        Promise.resolve(
          Response.json({
            ...original,
            data: { object: { ...sub, status: "canceled" } },
          }),
        )),
    StripeEventError,
  );
});
Deno.test("Clover paid invoices omit legacy paid but contradictory values fail", async () => {
  const invoice = {
    id: "in_CloverFixture123",
    object: "invoice",
    status: "paid",
    amount_paid: 0,
    total: 0,
    total_excluding_tax: 0,
    amount_due: 0,
    amount_remaining: 0,
    currency: "usd",
    customer: sub.customer,
    subscription: sub.id,
  };
  assertEquals(
    (await buildStripeNormalization(claim(invoice, "invoice.paid"), secret))
      .kind,
    "invoice_no_payment_required",
  );
  for (const paid of [false, null, "true"]) {
    await assertRejects(
      () =>
        buildStripeNormalization(
          claim({ ...invoice, paid }, "invoice.paid"),
          secret,
        ),
      StripeEventError,
    );
  }
});
