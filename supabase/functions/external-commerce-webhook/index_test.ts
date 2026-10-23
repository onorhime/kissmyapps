// deno-lint-ignore-file require-await -- Fake adapters keep production async boundaries.
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { type CommerceBinding } from "../external-commerce/contract.ts";
import { MerchantProvider } from "../external-commerce/provider.ts";
import { type JsonObject } from "../creator-connect/provider.ts";
import { assertEquals } from "../creator-connect/test-support.ts";
import { createExternalCommerceWebhook } from "./index.ts";
const now = Date.now(), created = Math.floor(now / 1000) - 100;
const binding: CommerceBinding = {
  secret: "fixture-hmac-not-used-here",
  productId: "11111111-1111-4111-8111-111111111111",
  funnelId: "22222222-2222-4222-8222-222222222222",
  accountId: "acct_merchant",
  livemode: false,
  stripeReadKey: "rk_test_merchantfixture",
  webhookSecret: "whsec_merchantfixture",
  metadataPurpose: "course_purchase",
};
const externalOrderId = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const objects: Record<string, JsonObject> = {
    account: { id: binding.accountId },
    "charges/ch_fixture": {
      id: "ch_fixture",
      livemode: false,
      payment_intent: "pi_fixture",
      amount: 10000,
      amount_refunded: 3000,
      currency: "usd",
      paid: true,
    },
    "payment_intents/pi_fixture": {
      id: "pi_fixture",
      livemode: false,
      status: "succeeded",
      amount: 10000,
      amount_received: 10000,
      currency: "usd",
      metadata: {
        purpose: "course_purchase",
        order_id: externalOrderId,
        stripe_account_id: binding.accountId,
      },
    },
    "refunds/re_one": {
      id: "re_one",
      payment_intent: "pi_fixture",
      charge: "ch_fixture",
      amount: 1000,
      currency: "usd",
      status: "succeeded",
      created,
    },
    "refunds/re_two": {
      id: "re_two",
      payment_intent: "pi_fixture",
      charge: "ch_fixture",
      amount: 2000,
      currency: "usd",
      status: "succeeded",
      created: created + 1,
    },
    "disputes/dp_fixture": {
      id: "dp_fixture",
      charge: "ch_fixture",
      livemode: false,
      amount: 5000,
      currency: "usd",
      status: "needs_response",
      created,
    },
  };
  const observations: JsonObject[] = [], calls: string[] = [];
  const seen = new Set<string>();
  const fetcher: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    assertEquals(parsed.origin, "https://api.stripe.com");
    assertEquals(init?.method, "GET");
    assertEquals(init?.redirect, "error");
    assertEquals(
      new Headers(init?.headers).get("Authorization"),
      "Bearer rk_test_merchantfixture",
    );
    assertEquals(new Headers(init?.headers).has("Stripe-Account"), false);
    const path = parsed.pathname.slice(4);
    calls.push(path);
    return Response.json(
      path === "refunds"
        ? {
          data: [objects["refunds/re_one"], objects["refunds/re_two"]],
          has_more: false,
        }
        : objects[path],
    );
  };
  const handler = createExternalCommerceWebhook({
    enabled: () => true,
    bindings: () => new Map([["merchant", binding]]),
    provider: (b) => new MerchantProvider(b, fetcher),
    now: () => now,
    persist: async (input) => {
      const key = [
        input.provider_event_id,
        input.refund_id ?? input.dispute_id,
        input.kind,
      ].join(":");
      const duplicate = seen.has(key);
      if (!duplicate) {
        seen.add(key);
        observations.push(input);
      }
      return { duplicate };
    },
  });
  return { handler, objects, observations, calls };
}
async function signed(
  event: JsonObject,
  secret = binding.webhookSecret!,
  time = Math.floor(now / 1000),
) {
  const body = JSON.stringify(event);
  const signature = bytesToHex(await hmacSha256(secret, `${time}.${body}`));
  return new Request(
    "https://local.invalid/external-commerce-webhook?binding_id=merchant",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": `t=${time},v1=${signature}`,
      },
      body,
    },
  );
}
const event = (
  type = "charge.refunded",
  id = "evt_fixture",
  objectId = "ch_fixture",
) => ({ id, type, livemode: false, data: { object: { id: objectId } } });
Deno.test("merchant webhook defaults disabled without reading provider configuration", async () => {
  let reads = 0;
  const handler = createExternalCommerceWebhook({
    enabled: () => false,
    bindings: () => {
      reads++;
      throw Error("must not read");
    },
  });
  assertEquals((await handler(await signed(event()))).status, 503);
  assertEquals(reads, 0);
});
Deno.test("merchant webhook requires own signature, mode and platform-scoped event", async () => {
  for (
    const data of [{ ...event(), livemode: true }, {
      ...event(),
      account: "acct_connected",
    }]
  ) {
    const f = fixture();
    assertEquals((await f.handler(await signed(data))).status, 409);
    assertEquals(f.calls.length, 0);
  }
  const f = fixture();
  assertEquals(
    (await f.handler(await signed(event(), "whsec_fundingdifferent"))).status,
    400,
  );
  assertEquals(
    (await f.handler(
      await signed(
        event(),
        binding.webhookSecret,
        Math.floor(now / 1000) - 400,
      ),
    )).status,
    400,
  );
  assertEquals(f.calls.length, 0);
});
Deno.test("merchant partial refund records each successful refund ID and its actual occurrence; replays deduplicate", async () => {
  const f = fixture();
  const response = await f.handler(await signed(event()));
  assertEquals(response.status, 200);
  assertEquals(f.observations.length, 2);
  assertEquals(
    f.observations.map((o) => [o.refund_id, o.amount_minor, o.occurred_at]),
    [["re_one", 1000, new Date(created * 1000).toISOString()], [
      "re_two",
      2000,
      new Date((created + 1) * 1000).toISOString(),
    ]],
  );
  assertEquals(
    (await (await f.handler(await signed(event()))).json()).duplicate,
    true,
  );
  assertEquals(f.observations.length, 2);
  assertEquals(f.observations[0].stripe_account_id, "acct_merchant");
  assertEquals(f.observations[0].external_order_id, externalOrderId);
  assertEquals("affiliate_id" in f.observations[0], false);
  assertEquals("platform_account_id" in f.observations[0], false);
});
Deno.test("early verified refunds persist exact merchant scope without needing an attributed order", async () => {
  const f = fixture();
  assertEquals((await f.handler(await signed(event()))).status, 200);
  assertEquals(f.observations[0].payment_intent_id, "pi_fixture");
  assertEquals(f.observations[0].product_id, binding.productId);
  assertEquals(f.observations[0].order_amount_minor, 10000);
  assertEquals("order_id" in f.observations[0], false);
});
Deno.test("missing, pending or conflicting refund evidence never becomes a guessed monetary adjustment", async () => {
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.objects["refunds/re_one"].status = "pending";
      },
      (f: ReturnType<typeof fixture>) => {
        f.objects["refunds/re_one"].payment_intent = "pi_other";
      },
      (f: ReturnType<typeof fixture>) => {
        f.objects["refunds/re_one"].currency = "eur";
      },
      (f: ReturnType<typeof fixture>) => {
        f.objects["refunds/re_one"].created = Math.floor(now / 1000) + 999;
      },
      (f: ReturnType<typeof fixture>) => {
        f.objects["charges/ch_fixture"].amount_refunded = 9000;
      },
    ]
  ) {
    const f = fixture();
    mutate(f);
    const response = await f.handler(await signed(event()));
    assertEquals(response.status >= 400, true);
    assertEquals(f.observations.length, 0);
  }
});
Deno.test("merchant credential mismatch and unrelated products cannot attribute adjustments", async () => {
  const f = fixture();
  f.objects.account.id = "acct_funding";
  assertEquals((await f.handler(await signed(event()))).status, 409);
  assertEquals(f.observations.length, 0);
  const other = fixture();
  (other.objects["payment_intents/pi_fixture"].metadata as JsonObject).purpose =
    "other_product";
  assertEquals(
    (await (await other.handler(await signed(event()))).json()).ignored,
    true,
  );
  assertEquals(other.observations.length, 0);
});
Deno.test("dispute observations use fresh current status and verified amount for open, won and lost", async () => {
  const f = fixture();
  const oldEvent = event("charge.dispute.created", "evt_dispute", "dp_fixture");
  assertEquals((await f.handler(await signed(oldEvent))).status, 200);
  assertEquals(f.observations[0].kind, "dispute_open");
  assertEquals(f.observations[0].amount_minor, 5000);
  f.objects["disputes/dp_fixture"].status = "won";
  assertEquals((await f.handler(await signed(oldEvent))).status, 200);
  assertEquals(f.observations[1].kind, "dispute_won");
  f.objects["disputes/dp_fixture"].status = "lost";
  assertEquals(
    (await f.handler(
      await signed(event("charge.dispute.closed", "evt_lost", "dp_fixture")),
    )).status,
    200,
  );
  assertEquals(f.observations[2].kind, "dispute_lost");
});
Deno.test("refund.updated reconciles the full successful refund list while pending updates stay pending", async () => {
  const f = fixture();
  assertEquals(
    (await f.handler(
      await signed(event("refund.updated", "evt_refund", "re_one")),
    )).status,
    200,
  );
  assertEquals(f.observations.length, 2);
  const pending = fixture();
  pending.objects["refunds/re_one"].status = "pending";
  assertEquals(
    (await (await pending.handler(
      await signed(event("refund.updated", "evt_pending", "re_one")),
    )).json()).pending,
    true,
  );
  assertEquals(pending.observations.length, 0);
});
