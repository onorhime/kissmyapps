// The checkout link against what the database really returns. backend.fixture.json
// holds answers of program_checkout_target captured from the database suite
// (supabase/tests/database/90_program_checkout_promo.sql, captures
// program_checkout_target.ok and program_checkout_target.not_live).
import { assertEquals } from "@std/assert";
import { parseTarget } from "./target.ts";
import captured from "./backend.fixture.json" with { type: "json" };

Deno.test("a real checkout target is read as the product to sell", () => {
  assertEquals(parseTarget(captured["program_checkout_target.ok"]), {
    ok: true,
    accountId: "acct_P8Checkout",
    currency: "usd",
    product: { name: "Fluent Pro", amountMinor: 999, interval: "month" },
    successUrl: "https://fluent-app.io/welcome",
    cancelUrl: "https://fluent-app.io/",
    click: "bd776e86167e71568e686f879a95f4736b81408144ce2fda",
    promotionCodeId: "promo_P8Anna",
    programName: "Fluent",
    codesOffered: true,
  });
});

Deno.test("a real refusal is read as the reason", () => {
  assertEquals(parseTarget(captured["program_checkout_target.not_live"]), {
    ok: false,
    reason: "not_live",
  });
});
