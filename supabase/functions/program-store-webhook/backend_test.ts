// deno-lint-ignore-file require-await -- Fake adapters keep production async boundaries.
// The revenue call against what the database really returns.
// backend.fixture.json holds the answer of attribution_store_revenue captured
// from the database suite (supabase/tests/database/93_attribution_revenue.sql,
// capture attribution_store_revenue.recorded).
import { assertEquals } from "@std/assert";
import {
  createProgramStoreWebhook,
  type ProgramStoreLogEntry,
} from "./index.ts";
import captured from "./backend.fixture.json" with { type: "json" };

Deno.test("a real revenue answer is logged as recorded", async () => {
  const logs: ProgramStoreLogEntry[] = [];
  const handler = createProgramStoreWebhook({
    enabled: () => true,
    log: (entry) => logs.push(entry),
    record: async () => ({ received: true, duplicate: false, outcome: "sale" }),
    revenue: async () => captured["attribution_store_revenue.recorded"],
  });
  const response = await handler(
    new Request("https://functions.example/program-store-webhook/adapty", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + "K".repeat(43),
      },
      body: JSON.stringify({
        event_type: "subscription_started",
        event_properties: {
          profile_event_id: "adapty-event-backend",
          environment: "Production",
        },
      }),
    }),
  );
  assertEquals(response.status, 200);
  await response.body?.cancel();
  assertEquals(logs.map((entry) => entry.revenue), ["recorded"]);
});
