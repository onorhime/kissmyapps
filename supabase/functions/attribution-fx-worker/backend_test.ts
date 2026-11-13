// The worker against what the database really returns. backend.fixture.json
// holds the answer of attribution_fx_store captured from the database suite
// (supabase/tests/database/93_attribution_revenue.sql, capture
// attribution_fx_store).
import { assertEquals } from "@std/assert";
import { parseStored } from "./store.ts";
import captured from "./backend.fixture.json" with { type: "json" };

Deno.test("a real store answer is read as the rates written and the newest day", () => {
  assertEquals(parseStored(captured["attribution_fx_store"]), {
    stored: 3,
    latestDay: "2026-11-03",
  });
});
