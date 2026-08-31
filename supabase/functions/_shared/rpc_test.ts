import type { SupabaseClient } from "@supabase/supabase-js";
import { assertEquals, assertRejects } from "@std/assert";
import { RequestError } from "./errors.ts";
import {
  assertFunnelRequestScope,
  ingestBrowserEvent,
  registerTrackingClick,
} from "./rpc.ts";

function rejectingClient(code: string): SupabaseClient {
  return {
    rpc: () => Promise.resolve({ data: null, error: { code } }),
  } as unknown as SupabaseClient;
}

Deno.test("public tracking and browser-event database limits surface as HTTP 429", async () => {
  const trackingError = await assertRejects(
    () =>
      registerTrackingClick(
        rejectingClient("KMA29"),
        "partner",
        "a".repeat(24),
        {
          country_code: null,
          session_id_hash: null,
          user_agent_hash: null,
          ip_hash: null,
          is_bot: false,
        },
      ),
    RequestError,
  );
  assertEquals(trackingError.status, 429);
  assertEquals(trackingError.code, "rate_limited");

  const eventError = await assertRejects(
    () =>
      ingestBrowserEvent(rejectingClient("KMA29"), {
        event_id: "11111111-1111-4111-8111-111111111111",
        event_name: "landing_viewed",
        click_id: "b".repeat(48),
        occurred_at: new Date().toISOString(),
        properties: {},
      }),
    RequestError,
  );
  assertEquals(eventError.status, 429);
  assertEquals(eventError.code, "rate_limited");
});

Deno.test("funnel scope passes only the configured key, click, product, and funnel", async () => {
  const calls: unknown[][] = [];
  const client = {
    rpc: (name: string, input: unknown) => {
      calls.push([name, input]);
      return Promise.resolve({ data: true, error: null });
    },
  } as unknown as SupabaseClient;

  await assertFunnelRequestScope(
    client,
    "primary",
    "c".repeat(48),
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  );

  assertEquals(calls, [["assert_funnel_request_scope", {
    p_key_id: "primary",
    p_click_id: "c".repeat(48),
    p_product_id: "11111111-1111-4111-8111-111111111111",
    p_funnel_id: "22222222-2222-4222-8222-222222222222",
  }]]);
});
