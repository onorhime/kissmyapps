// The promo worker against what the database really returns. backend.fixture.json
// holds the answer of claim_program_promo_codes captured from the database suite
// (supabase/tests/database/90_program_checkout_promo.sql, capture
// claim_program_promo_codes.pending).
import { assertEquals } from "@std/assert";
import { parseClaim } from "./store.ts";
import captured from "./backend.fixture.json" with { type: "json" };

Deno.test("a real claim answer is read as one code to make", () => {
  assertEquals(parseClaim(captured["claim_program_promo_codes.pending"]), {
    codes: [{
      id: "f5e53614-5317-49b0-9b7b-8e92f104b34c",
      code: "ANNA10",
      accountId: "acct_P8Checkout",
      discountBps: 1000,
      couponId: null,
      programId: "d582a05c-c1d1-40bf-a056-b880d6dbf1a2",
    }],
    deactivate: [],
  });
});
