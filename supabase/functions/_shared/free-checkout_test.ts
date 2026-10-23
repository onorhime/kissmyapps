import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ConfigurationError, RequestError } from "./errors.ts";
import {
  freePromotionForProduct,
  verifyFreePromotion,
} from "./free-checkout.ts";

const promo = "promo_Fixture123456";
const price = {
  id: "price_Fixture123456",
  livemode: true,
  active: true,
  type: "recurring",
  currency: "usd",
  unit_amount: 100,
  product: "prod_Fixture123456",
};
const coupon = {
  object: "coupon",
  valid: true,
  percent_off: 100,
  duration: "forever",
  amount_off: null,
  applies_to: null,
};
const promotion = {
  id: promo,
  active: true,
  livemode: true,
  promotion: { type: "coupon", coupon },
};
const fixture = (change: Record<string, unknown> = {}) =>
  ((url: RequestInfo | URL) => {
    if (String(url).includes("/promotion_codes/")) {
      assertEquals(
        new URL(String(url)).searchParams.get("expand[]"),
        "promotion.coupon.applies_to",
      );
    }
    return Promise.resolve(
      Response.json(
        String(url).includes("/prices/") ? price : {
          ...promotion,
          promotion: { type: "coupon", coupon: { ...coupon, ...change } },
        },
      ),
    );
  }) as typeof fetch;
Deno.test("no-charge discount requires 100 percent forever and applicable live price", async () => {
  await verifyFreePromotion(
    "test-only",
    promo,
    price.id,
    "USD",
    100,
    fixture(),
  );
  for (
    const change of [
      { percent_off: 50 },
      { applies_to: "malformed" },
      { duration: "once" },
      { duration: "repeating" },
      { valid: false },
      { applies_to: undefined },
      { applies_to: { products: ["prod_Other123456"] } },
    ]
  ) {
    await assertRejects(
      () =>
        verifyFreePromotion(
          "test-only",
          promo,
          price.id,
          "USD",
          100,
          fixture(change),
        ),
      RequestError,
    );
  }
  await assertRejects(
    () =>
      verifyFreePromotion("test-only", promo, price.id, "USD", 200, fixture()),
    RequestError,
  );
});
Deno.test("a missing no-charge product binding never falls back to paid", () => {
  const original = Deno.env.get("FREE_CHECKOUT_PROMOTION_BINDINGS");
  try {
    Deno.env.set("FREE_CHECKOUT_PROMOTION_BINDINGS", "{}");
    assertThrows(() => freePromotionForProduct("fixture"), ConfigurationError);
    Deno.env.set(
      "FREE_CHECKOUT_PROMOTION_BINDINGS",
      JSON.stringify({ fixture: promo }),
    );
    assertEquals(freePromotionForProduct("fixture"), promo);
  } finally {
    if (original === undefined) {
      Deno.env.delete("FREE_CHECKOUT_PROMOTION_BINDINGS");
    } else Deno.env.set("FREE_CHECKOUT_PROMOTION_BINDINGS", original);
  }
});
