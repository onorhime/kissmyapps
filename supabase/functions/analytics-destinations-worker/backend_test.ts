// The worker against what the database really returns. backend.fixture.json is
// the answer of claim_analytics_destination_jobs captured from the database
// suite (supabase/tests/database/92_analytics_destinations.sql, capture
// claim_analytics_destination_jobs.one); only the key and the lease were left
// out of the file, and are put back here.
import { assertEquals, assertThrows } from "@std/assert";
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import { installEvents, KEY_FIELD, requestBody } from "./amplitude.ts";
import { type Json, LEASE_FIELD, parseClaim } from "./store.ts";
import captured from "./backend.fixture.json" with { type: "json" };

/** The suite's placeholder key and a lease. */
const KEY = "a".repeat(28) + "beef";
const LEASE = "00000000-0000-4000-8000-0000000000aa";

function claimed(): Json {
  const answer = structuredClone(
    captured.claim_analytics_destination_jobs,
  ) as Json;
  for (const job of answer.jobs as Json[]) {
    job[KEY_FIELD] = KEY;
    job[LEASE_FIELD] = LEASE;
  }
  return answer;
}

Deno.test("a real claim answer is read as one install to send", () => {
  const [job] = parseClaim(claimed());
  assertEquals(job, {
    id: "08b3b3e1-e147-4716-9d4d-e9d4d7dd70da",
    lease: LEASE,
    provider: "amplitude",
    region: "eu",
    projectKey: KEY,
    userId: "user-ann-01",
    insertId: "kma-08b3b3e1-e147-4716-9d4d-e9d4d7dd70da",
    time: 1794606831006,
    eventProperties: {
      source: "creators",
      campaign: "launch",
      method: "install_referrer",
      exact: true,
      platform: "android",
      creator: "Mira Maker",
    },
    userProperties: {
      kma_source: "creators",
      kma_campaign: "launch",
      kma_method: "install_referrer",
      kma_creator: "Mira Maker",
    },
  });
  // Without its lease or its key a job is not the worker's to send.
  assertThrows(
    () => parseClaim(captured.claim_analytics_destination_jobs),
    DatabaseBoundaryError,
  );
});

Deno.test("the real answer becomes the Amplitude request the docs describe", () => {
  const [job] = parseClaim(claimed());
  const body = requestBody(job.projectKey, [job]);
  assertEquals(body[KEY_FIELD], KEY);
  assertEquals(body.options, { min_id_length: 1 });
  assertEquals(body.events, installEvents(job));
  const [identify, event] = installEvents(job);
  assertEquals(identify.event_type, "$identify");
  assertEquals(event.event_type, "[KissMyApps] Install attributed");
  assertEquals(event.time, 1794606831006);
  assertEquals(event.event_properties, {
    source: "creators",
    campaign: "launch",
    method: "install_referrer",
    exact: true,
    platform: "android",
    creator: "Mira Maker",
  });
});

Deno.test("an empty claim is read as nothing to send", () => {
  assertEquals(parseClaim({ jobs: [] }), []);
  assertThrows(() => parseClaim({}), DatabaseBoundaryError);
  assertThrows(() => parseClaim({ jobs: [{}] }), DatabaseBoundaryError);
});
