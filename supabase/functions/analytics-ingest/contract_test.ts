// The app SDKs (React Native, Android, iOS) are each tested against the same contract
// file; this checks the function keeps everything that contract lets them send.
import { assert, assertEquals, assertMatch } from "@std/assert";
import contract from "../../../integrations/analytics-mobile/contract/app-events.json" with {
  type: "json",
};
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
