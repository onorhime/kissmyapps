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

Deno.test("short click RPC passes only the stored alias path and ordinary tracking context", async () => {
  const calls: unknown[][] = [];
  const client = {
    rpc: (name: string, input: unknown) => {
      calls.push([name, input]);
      return Promise.resolve({
        data: [{
          click_id: "c".repeat(48),
          destination_url: "https://marathon.speaksix.com/",
          is_bot: false,
        }],
        error: null,
      });
    },
  } as unknown as SupabaseClient;
  const { registerShortTrackingClick } = await import("./rpc.ts");
  const context = {
    country_code: null,
    session_id_hash: null,
    user_agent_hash: null,
    ip_hash: null,
    is_bot: false,
  };
  const result = await registerShortTrackingClick(
    client,
    "/speaksix/王小明",
    context,
  );
  assertEquals(calls, [["register_short_tracking_click", {
    p_path: "/speaksix/王小明",
    p_context: context,
  }]]);
  assertEquals(result.clickId, "c".repeat(48));
  const error = await assertRejects(
    () =>
      registerShortTrackingClick(
        rejectingClient("KMA29"),
        "/speaksix/victory",
        context,
      ),
    RequestError,
  );
  assertEquals(error.status, 429);
});
