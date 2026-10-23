import { assertEquals, assertThrows } from "@std/assert";
import { RequestError } from "./errors.ts";
import {
  parseTrackingRoute,
  validateBrowserEvent,
  validatedRedirectUrl,
  validateFunnelEvent,
} from "./validation.ts";

const now = Date.parse("2026-08-28T12:00:00.000Z");
const baseEvent = {
  event_id: "11111111-1111-4111-8111-111111111111",
  event_name: "landing_viewed",
  click_id: "click_public_00000001",
  occurred_at: "2026-08-28T11:59:00.000Z",
  properties: { page_path: "/offer", locale: "en-NG" },
};

Deno.test("tracking route accepts both proxied and Supabase function paths", () => {
  assertEquals(parseTrackingRoute("/r/partner-one/abcdefghijklmnop"), {
    affiliateSlug: "partner-one",
    publicCode: "abcdefghijklmnop",
  });
  assertEquals(
    parseTrackingRoute("/tracking-redirect/r/partner-one/abcdefghijklmnop"),
    {
      affiliateSlug: "partner-one",
      publicCode: "abcdefghijklmnop",
    },
  );
});

Deno.test("tracking route rejects ambiguous or unsafe paths", () => {
  assertThrows(
    () => parseTrackingRoute("/r/Partner-One/abcdefghijklmnop"),
    RequestError,
  );
  assertThrows(
    () => parseTrackingRoute("/r/partner-one/short"),
    RequestError,
  );
  assertThrows(
    () => parseTrackingRoute("/r/partner-one/abcdefghijklmnop/extra"),
    RequestError,
  );
});

Deno.test("redirect URL preserves approved destination state and replaces click token", () => {
  assertEquals(
    validatedRedirectUrl(
      "https://funnel.example/offer?utm_campaign=launch&kma_click=old#pricing",
      "click_public_00000001",
    ),
    "https://funnel.example/offer?utm_campaign=launch&kma_click=click_public_00000001#pricing",
  );
  assertThrows(
    () =>
      validatedRedirectUrl(
        "http://funnel.example/offer",
        "click_public_00000001",
      ),
    RequestError,
  );
  assertThrows(
    () =>
      validatedRedirectUrl(
        "https://user:pass@funnel.example",
        "click_public_00000001",
      ),
    RequestError,
  );
});

Deno.test("browser event contract accepts only allowlisted behavior and properties", () => {
  assertEquals(validateBrowserEvent(baseEvent, now), baseEvent);
  assertThrows(
    () =>
      validateBrowserEvent(
        { ...baseEvent, event_name: "purchase_completed" },
        now,
      ),
    RequestError,
  );
  assertThrows(
    () =>
      validateBrowserEvent({
        ...baseEvent,
        properties: { email: "person@example.com" },
      }, now),
    RequestError,
  );
  assertThrows(
    () => validateBrowserEvent({ ...baseEvent, partner_id: "forged" }, now),
    RequestError,
  );
});

Deno.test("browser event contract rejects stale events and query-bearing page paths", () => {
  assertThrows(
    () =>
      validateBrowserEvent(
        { ...baseEvent, occurred_at: "2026-08-20T12:00:00.000Z" },
        now,
      ),
    RequestError,
  );
  assertThrows(
    () =>
      validateBrowserEvent(
        {
          ...baseEvent,
          properties: { page_path: "/offer?email=person@example.com" },
        },
        now,
      ),
    RequestError,
  );
});

Deno.test("funnel event contract is explicit and production configured", () => {
  const input = {
    ...baseEvent,
    event_name: "lead_created",
    properties: { plan: "annual" },
  };
  assertEquals(
    validateFunnelEvent(
      input,
      new Set(["lead_created"]),
      new Set(["plan"]),
      now,
    ),
    input,
  );
  assertThrows(
    () => validateFunnelEvent(input, new Set(), new Set(["plan"]), now),
    RequestError,
  );
  assertThrows(
    () => validateFunnelEvent(input, new Set(["lead_created"]), new Set(), now),
    RequestError,
  );
});

Deno.test("readable tracking routes preserve unique handles and decode Unicode once", () => {
  for (
    const path of [
      "/speaksix/victory",
      "/speaksix/victory/instagram-bio-2",
      "/speaksix/victory/2",
      "/speaksix/josé-núñez",
      "/speaksix/анна-иванова",
      "/speaksix/王小明",
      "/speaksix/محمد",
      `/speaksix/${"𠮷".repeat(48)}`,
    ]
  ) {
    assertEquals(parseTrackingRoute(path), { shortPath: path });
    assertEquals(parseTrackingRoute(`/tracking-redirect${encodeURI(path)}`), {
      shortPath: path,
    });
  }
});

Deno.test("readable routes reject path confusion, mixed case, noncanonical Unicode and unsafe escapes", () => {
  for (
    const path of [
      "/speaksix//victory",
      "/speaksix/victory/",
      "/speaksix/victory/a/b",
      "/speaksix/Victory",
      "/speaksix/JOSE",
      "/speaksix/jose\u0301",
      "/speaksix/victory%2fbio",
      "/speaksix/victory%252fbio",
      "/speaksix/%00",
      "/speaksix/%FF",
      "/speaksix/%",
      "/tracking-redirect/tracking-redirect/creator",
      `/speaksix/${"a".repeat(65)}`,
      `/speaksix/${"𠮷".repeat(65)}`,
      "/speaksix/../victory",
      "/speaksix/👍",
    ]
  ) assertThrows(() => parseTrackingRoute(path), RequestError, undefined, path);
});
