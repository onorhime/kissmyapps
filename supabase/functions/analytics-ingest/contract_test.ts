// The app SDKs (React Native, Android, iOS) are each tested against the same contract
// file; this checks the function keeps everything that contract lets them send, to
// /v1/events and to the two attribution calls.
import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import contract from "../../../integrations/analytics-mobile/contract/app-events.json" with {
  type: "json",
};
import {
  CLICK_ID,
  DEVICE_KEY,
  FIELDS,
  isAttributionAnswer,
  normalizeAttribution,
  PLATFORMS,
  TIME,
} from "./attribution.ts";
import { normalizeBody } from "./payload.ts";

const now = new Date("2026-10-30T10:00:05.000Z");

Deno.test("an app SDK's request keeps every field the contract allows", () => {
  const { body } = normalizeBody(contract.example, "events", false, now);
  const context = body.context as Record<string, unknown>;
  for (
    const key of [...contract.context.required, ...contract.context.optional]
  ) {
    assertEquals(
      context[key],
      (contract.example.context as Record<string, unknown>)[key],
      `context.${key}`,
    );
  }
  assertEquals(body.anonymous_id, contract.example.anonymous_id);
  assertEquals(body.user_id, contract.example.user_id);
  assertEquals(body.traits, contract.example.traits);
  assertEquals(body.session, contract.example.session);
  const events = body.events as Record<string, unknown>[];
  assertEquals(events.length, contract.example.events.length);
  contract.example.events.forEach((sent, index) => {
    for (const [key, value] of Object.entries(sent)) {
      assertEquals(events[index][key], value, `events[${index}].${key}`);
    }
  });
});

Deno.test("the contract's automatic events and platforms are ones reports know", () => {
  for (const name of contract.automatic_events) {
    assertMatch(name, new RegExp(contract.event_name));
  }
  for (const platform of contract.platforms) {
    const { body } = normalizeBody(
      { ...contract.example, context: { platform } },
      "events",
      false,
      now,
    );
    assertEquals((body.context as Record<string, unknown>).platform, platform);
  }
  assert(contract.example.events.every((event) => event.time.endsWith("Z")));
});

Deno.test("the contract's attribution examples pass the function's checks unchanged", () => {
  const { attribution } = contract;
  assertEquals(
    normalizeAttribution(attribution.examples.install, "install"),
    attribution.examples.install,
  );
  assertEquals(
    normalizeAttribution(attribution.examples.open, "open"),
    attribution.examples.open,
  );
  assert(isAttributionAnswer(attribution.examples.response));
  assert(
    attribution.response.methods.includes(attribution.examples.response.method),
  );
  for (const key of attribution.response.required) {
    assert(key in attribution.examples.response, key);
  }
});

Deno.test("the function checks exactly the attribution fields the contract lists", () => {
  const { attribution } = contract;
  for (const kind of ["install", "open"] as const) {
    assertEquals(FIELDS[kind].required, attribution[kind].required, kind);
    assertEquals(FIELDS[kind].optional, attribution[kind].optional, kind);
    assertEquals(
      new URL(attribution[kind].path, "https://events.kissmyapps.dev").pathname,
      `/v1/attribution/${kind}`,
    );
  }
  assertEquals([...PLATFORMS], attribution.fields.platform);
  assertEquals(TIME.source, attribution.fields.installed_at);
  assertEquals(TIME.source, attribution.fields.opened_at);
  assertEquals(DEVICE_KEY.source, attribution.fields.device_key);
  assertEquals(CLICK_ID.source, attribution.fields.clipboard_click);
  // Every required field missing, one at a time, is refused.
  for (const kind of ["install", "open"] as const) {
    for (const field of attribution[kind].required) {
      const body: Record<string, unknown> = { ...attribution.examples[kind] };
      delete body[field];
      assertThrows(() => normalizeAttribution(body, kind), Error, field);
    }
  }
});
