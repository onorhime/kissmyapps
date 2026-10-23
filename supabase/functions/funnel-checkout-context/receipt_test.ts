import { assertEquals, assertRejects } from "@std/assert";
import { verifyCheckoutReceipt } from "./index.ts";
const secret = `rk_live_${"a".repeat(40)}`;
const evidence = {
  session_id: "cs_live_ReceiptFixture123",
  attempt_id: "attempt",
  public_attempt_id: "public",
  offer_id: "offer",
  product_id: "product",
  acquisition_id: "acquisition",
  click_id: "click",
  currency: "USD",
  amount_minor: 100,
  mode: "subscription",
};
const session = {
  id: evidence.session_id,
  object: "checkout.session",
  mode: "subscription",
  livemode: true,
  status: "complete",
  payment_status: "paid",
  client_reference_id: "public",
  currency: "usd",
  amount_total: 0,
  amount_subtotal: 100,
  customer: "cus_ReceiptFixture123",
  subscription: "sub_ReceiptFixture123",
  total_details: { amount_discount: 100, amount_tax: 0, amount_shipping: 0 },
  metadata: {
    kma_attempt_id: "attempt",
    kma_public_attempt_id: "public",
    kma_offer_id: "offer",
    kma_product_id: "product",
    kma_acquisition_id: "acquisition",
    kma_click_id: "click",
    kma_expected_amount_minor: "100",
    kma_expected_currency: "USD",
  },
};
Deno.test("owned completed receipt confirms directly before workers, without PII", async () => {
  const output = await verifyCheckoutReceipt(
    evidence,
    secret,
    async (url, init) => {
      await Promise.resolve();
      assertEquals(
        String(url),
        `https://api.stripe.com/v1/checkout/sessions/${evidence.session_id}`,
      );
      assertEquals(init?.body, undefined);
      return Response.json({
        ...session,
        customer_email: "private@example.test",
      });
    },
  );
  assertEquals(output, "no_payment_required");
});
Deno.test("return URL, incomplete payment, altered attribution and totals are not proof", async () => {
  for (
    const change of [
      { id: "cs_live_ForeignFixture123" },
      { livemode: false },
      { client_reference_id: "foreign" },
      { currency: "eur" },
      { metadata: { ...session.metadata, kma_click_id: "foreign" } },
      { amount_total: 1 },
      { subscription: null },
      { total_details: { ...session.total_details, amount_discount: 99 } },
    ]
  ) {
    await assertRejects(() =>
      verifyCheckoutReceipt(
        evidence,
        secret,
        () => Promise.resolve(Response.json({ ...session, ...change })),
      )
    );
  }
  assertEquals(
    await verifyCheckoutReceipt(
      evidence,
      secret,
      () =>
        Promise.resolve(
          Response.json({ ...session, payment_status: "unpaid" }),
        ),
    ),
    "pending",
  );
  assertEquals(
    await verifyCheckoutReceipt(
      evidence,
      secret,
      () => Promise.resolve(Response.json({ ...session, status: "open" })),
    ),
    "pending",
  );
});
