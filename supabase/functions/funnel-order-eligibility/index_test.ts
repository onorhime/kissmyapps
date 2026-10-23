import { assertEquals, assertThrows } from "@std/assert";
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { createOrderEligibilityHandler } from "./index.ts";
import { validateOrderEligibility } from "./contract.ts";
const secret = "local-only-eligibility-test-signing-key";
const productId = "11111111-1111-4111-8111-111111111111",
  funnelId = "22222222-2222-4222-8222-222222222222";
const packet = () => ({
  event_id: "33333333-3333-4333-8333-333333333333",
  external_order_id: "44444444-4444-4444-8444-444444444444",
  click_id: "opaque_test_click_123456",
  stripe_account_id: "acct_fixture",
  livemode: false,
  subject_id: "opaque_product_subject_123456",
  purchase_sequence: 1,
  context_id: "service_group_one",
  status: "fulfilled",
  occurred_at: new Date().toISOString(),
  channel: "creator",
  entry_variant: "book",
  webinar_id: "event1",
  intake_id: "intake1",
});
async function signed(body: unknown, overrides: Record<string, string> = {}) {
  const text = JSON.stringify(body),
    timestamp = String(Math.floor(Date.now() / 1000)),
    nonce = "local_eligibility_nonce_12345";
  const signature = bytesToHex(
    await hmacSha256(
      secret,
      new TextEncoder().encode(`${timestamp}.${nonce}.${text}`),
    ),
  );
  return new Request(
    "https://edge.example/functions/v1/funnel-order-eligibility",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kma-key-id": "fixture",
        "x-kma-nonce": nonce,
        "x-kma-timestamp": timestamp,
        "x-kma-signature": signature,
        ...overrides,
      },
      body: text,
    },
  );
}
Deno.test("eligibility uses existing binding and passes only exact scoped evidence", async () => {
  const calls: unknown[] = [];
  const h = createOrderEligibilityHandler({
    bindings: () =>
      new Map([["fixture", {
        secret,
        productId,
        funnelId,
        accountId: "acct_fixture",
        livemode: false,
      }]]),
    authorize: (...x) => {
      calls.push(x);
      return Promise.resolve();
    },
    ingest: (...x) => {
      calls.push(x);
      return Promise.resolve({ event_id: "receipt", duplicate: false });
    },
  });
  const event = packet();
  assertEquals((await h(await signed(event))).status, 200);
  assertEquals(calls, [["fixture", event.click_id, productId, funnelId], [
    productId,
    funnelId,
    event,
  ]]);
});
Deno.test("browser, invalid signature and financial/creator overrides cannot attest fulfilment", async () => {
  let calls = 0;
  const h = createOrderEligibilityHandler({
    bindings: () =>
      new Map([["fixture", {
        secret,
        productId,
        funnelId,
        accountId: "acct_fixture",
        livemode: false,
      }]]),
    authorize: () => {
      calls++;
      return Promise.resolve();
    },
    ingest: () => Promise.resolve({ event_id: "r", duplicate: false }),
  });
  assertEquals(
    (await h(await signed(packet(), { origin: "https://browser.example" })))
      .status,
    403,
  );
  assertEquals(
    (await h(await signed(packet(), { "x-kma-signature": "0".repeat(64) })))
      .status,
    401,
  );
  for (
    const key of [
      "affiliate_id",
      "commission_minor",
      "rate",
      "product_id",
      "properties",
    ]
  ) {
    assertEquals(
      (await h(await signed({ ...packet(), [key]: "forged" }))).status,
      400,
    );
  }
  assertEquals(
    (await h(await signed({ ...packet(), stripe_account_id: "acct_other" })))
      .status,
    403,
  );
  assertEquals(
    (await h(await signed({ ...packet(), livemode: true }))).status,
    403,
  );
  assertEquals(calls, 0);
});
Deno.test("eligibility rejects unsafe identity, sequence, dates and states", () => {
  for (
    const change of [
      { purchase_sequence: 0 },
      { purchase_sequence: 1.5 },
      { purchase_sequence: 1_000_001 },
      { subject_id: "a@example.com" },
      { livemode: "false" },
      { status: "approved" },
      { channel: "personal@example.com" },
      { occurred_at: "infinity" },
      { occurred_at: new Date(Date.now() + 301000).toISOString() },
    ]
  ) assertThrows(() => validateOrderEligibility({ ...packet(), ...change }));
  assertEquals(validateOrderEligibility(packet()).purchase_sequence, 1);
});
