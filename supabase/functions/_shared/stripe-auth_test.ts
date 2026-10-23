import { assertEquals, assertThrows } from "@std/assert";
import { ConfigurationError } from "./errors.ts";
import { requireLiveStripeKey } from "./stripe-auth.ts";

Deno.test("live Stripe authentication accepts restricted and standard server keys", () => {
  for (const prefix of ["rk_live_", "sk_live_"]) {
    const key = `${prefix}${"a".repeat(40)}`;
    assertEquals(requireLiveStripeKey(key), key);
  }
});

Deno.test("live Stripe authentication rejects test, publishable, malformed and missing keys", () => {
  const suffix = "a".repeat(40);
  for (
    const key of [
      undefined,
      null,
      123,
      {},
      "",
      "INVALID",
      `rk_test_${suffix}`,
      `sk_test_${suffix}`,
      `pk_live_${suffix}`,
      `pk_test_${suffix}`,
      `whsec_${suffix}`,
      "rk_live_short",
      `rk_live_${"a".repeat(513)}`,
      `rk_live_${suffix}\n`,
      ` rk_live_${suffix}`,
      `rk_live_${suffix} `,
      `rk_live_${suffix}\r\n`,
      `rk_live_${suffix.slice(0, 20)} ${suffix.slice(20)}`,
    ]
  ) {
    const error = assertThrows(
      () => requireLiveStripeKey(key),
      ConfigurationError,
    );
    if (typeof key === "string" && key.length > 12) {
      assertEquals(error.message.includes(key), false);
    }
  }
});
