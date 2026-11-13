import { assert, assertEquals } from "@std/assert";
import {
  AMPLITUDE_ENDPOINTS,
  INSTALL_EVENT,
  KEY_FIELD,
  SILENCED_DELAY_SECONDS,
  THROTTLE_DELAY_SECONDS,
} from "./amplitude.ts";
import {
  CLAIM_LIMIT,
  createAnalyticsDestinationsWorker,
  type DestinationWorkerDependencies,
  type DestinationWorkerLogEntry,
  LEASE_SECONDS,
  WORK_BUDGET_MS,
} from "./index.ts";
import {
  type DestinationFunction,
  type DestinationStore,
  type Json,
  LEASE_FIELD,
  StoreRejection,
} from "./store.ts";

const START = Date.UTC(2026, 10, 21, 12, 0, 0);
const INSTALLED = Date.UTC(2026, 10, 21, 11, 58, 0, 320);
/** Plain placeholder keys: 32 hex characters each. */
const KEY_A = "a".repeat(28) + "beef";
const KEY_B = "c".repeat(28) + "cafe";

let counter = 0;
function fakeUuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

interface FakeJob {
  id: string;
  lease: string | null;
  status: "pending" | "sent" | "failed";
  region: "us" | "eu";
  key: string;
  userId: string;
  creator: string | null;
  campaign: string | null;
  platform: "ios" | "android";
  outcomes: Json[];
}

/** The two database functions, in memory, with the rules the migration has. */
class FakeStore implements DestinationStore {
  jobs: FakeJob[] = [];
  calls: { name: DestinationFunction; input: Json }[] = [];
  failFinishFor = new Set<string>();
  failClaim = false;

  add(options: Partial<FakeJob> = {}): FakeJob {
    const job: FakeJob = {
      id: fakeUuid(),
      lease: null,
      status: "pending",
      region: "us",
      key: KEY_A,
      userId: `user-${this.jobs.length + 1}`,
      creator: "Mira Maker",
      campaign: "launch",
      platform: "android",
      outcomes: [],
      ...options,
    };
    this.jobs.push(job);
    return job;
  }

  json(job: FakeJob): Json {
    return {
      id: job.id,
      [LEASE_FIELD]: job.lease,
      provider: "amplitude",
      region: job.region,
      [KEY_FIELD]: job.key,
      user_id: job.userId,
      insert_id: `kma-${job.id}`,
      time: INSTALLED,
      event_properties: {
        source: "creators",
        campaign: job.campaign,
        method: "install_referrer",
        exact: true,
        platform: job.platform,
        creator: job.creator,
      },
      user_properties: {
        kma_source: "creators",
        kma_campaign: job.campaign,
        kma_method: "install_referrer",
        kma_creator: job.creator,
      },
    };
  }

  call(name: DestinationFunction, input: Json): Promise<Json> {
    this.calls.push({ name, input: structuredClone(input) });
    if (name === "claim_analytics_destination_jobs") {
      if (this.failClaim) {
        return Promise.reject(new StoreRejection("22023", "invalid_input"));
      }
      const due = this.jobs.filter((j) => j.status === "pending" && !j.lease)
        .slice(0, input.limit as number);
      for (const job of due) job.lease = fakeUuid();
      return Promise.resolve({ jobs: due.map((j) => this.json(j)) });
    }
    const job = this.jobs.find((j) => j.id === input.id);
    if (!job) {
      return Promise.reject(new StoreRejection("P0002", "job_not_found"));
    }
    if (job.lease !== input[LEASE_FIELD] || this.failFinishFor.has(job.id)) {
      return Promise.reject(new StoreRejection("22023", "lease_lost"));
    }
    job.outcomes.push(structuredClone(input));
    job.lease = null;
    if (input.ok === true) job.status = "sent";
    else if (input.retry === false) job.status = "failed";
    return Promise.resolve({ id: job.id, status: job.status });
  }

  finishes(): Json[] {
    return this.calls.filter((c) =>
      c.name === "finish_analytics_destination_job"
    )
      .map((c) => c.input);
  }
}

interface SentRequest {
  url: string;
  headers: Headers;
  body: Json;
}

/** Amplitude's HTTP V2 endpoint, stubbed: nothing leaves the test. */
class FakeAmplitude {
  requests: SentRequest[] = [];
  answer: (request: SentRequest) => Response = () =>
    Response.json({ code: 200, events_ingested: 2 }, { status: 200 });

  fetch: typeof fetch = (input, init) => {
    const request: SentRequest = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    };
    this.requests.push(request);
    try {
      return Promise.resolve(this.answer(request));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  userIds(request: SentRequest): string[] {
    return [
      ...new Set(
        (request.body.events as Json[]).map((e) => e.user_id as string),
      ),
    ];
  }
}

function world(overrides: Partial<DestinationWorkerDependencies> = {}) {
  const clock = { now: START };
  const store = new FakeStore();
  const amplitude = new FakeAmplitude();
  const logs: DestinationWorkerLogEntry[] = [];
  const worker = createAnalyticsDestinationsWorker({
    enabled: () => true,
    authenticate: () => {},
    store: () => store,
    fetcher: amplitude.fetch,
    now: () => clock.now,
    log: (entry) => logs.push(entry),
    ...overrides,
  });
  const run = async () => {
    const response = await worker(
      new Request("https://functions.example/analytics-destinations-worker", {
        method: "POST",
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  return { clock, store, amplitude, logs, worker, run };
}

Deno.test("an install is sent to Amplitude as an Identify and the install event, then finished", async () => {
  const w = world();
  const job = w.store.add({ userId: "42", creator: "Mira Maker" });
  const answer = await w.run();
  assertEquals(answer.status, 200);
  assertEquals(
    [answer.body.claimed, answer.body.requests, answer.body.sent],
    [1, 1, 1],
  );
  assertEquals(w.store.calls[0], {
    name: "claim_analytics_destination_jobs",
    input: { limit: CLAIM_LIMIT, lease_seconds: LEASE_SECONDS },
  });

  const [request] = w.amplitude.requests;
  assertEquals(request.url, "https://api2.amplitude.com/2/httpapi");
  assertEquals(request.headers.get("content-type"), "application/json");
  assertEquals(request.body, {
    [KEY_FIELD]: KEY_A,
    events: [
      {
        user_id: "42",
        event_type: "$identify",
        insert_id: `kma-${job.id}-identify`,
        platform: "Android",
        user_properties: {
          $set: {
            kma_source: "creators",
            kma_campaign: "launch",
            kma_method: "install_referrer",
            kma_creator: "Mira Maker",
          },
        },
      },
      {
        user_id: "42",
        event_type: INSTALL_EVENT,
        time: INSTALLED,
        insert_id: `kma-${job.id}`,
        platform: "Android",
        event_properties: {
          source: "creators",
          campaign: "launch",
          method: "install_referrer",
          exact: true,
          platform: "android",
          creator: "Mira Maker",
        },
      },
    ],
    // A two-character user ID is still a user ID.
    options: { min_id_length: 1 },
  });
  assertEquals(INSTALL_EVENT, "[KissMyApps] Install attributed");
  assertEquals(w.store.finishes(), [{
    id: job.id,
    [LEASE_FIELD]: w.store.calls[1].input[LEASE_FIELD],
    ok: true,
  }]);
  assertEquals(job.status, "sent");

  // Nothing waits: the next run sends nothing.
  const again = await w.run();
  assertEquals([again.body.claimed, again.body.requests], [0, 0]);
});

Deno.test("an install without a creator or campaign unsets those user properties", async () => {
  const w = world();
  w.store.add({ creator: null, campaign: null, platform: "ios" });
  await w.run();
  const [identify, event] = w.amplitude.requests[0].body.events as Json[];
  assertEquals(identify.user_properties, {
    $set: { kma_source: "creators", kma_method: "install_referrer" },
    $unset: { kma_campaign: "-", kma_creator: "-" },
  });
  assertEquals(identify.platform, "iOS");
  assertEquals(
    (event.event_properties as Json).creator,
    null,
  );
});

Deno.test("projects kept in the EU are sent to the EU endpoint", async () => {
  const w = world();
  w.store.add({ region: "eu" });
  await w.run();
  assertEquals(w.amplitude.requests[0].url, AMPLITUDE_ENDPOINTS.eu);
  assertEquals(
    AMPLITUDE_ENDPOINTS.eu,
    "https://api.eu.amplitude.com/2/httpapi",
  );
});

Deno.test("installs go in requests of at most five (ten events), one project key per request", async () => {
  const w = world();
  for (let i = 0; i < 12; i++) w.store.add({ key: KEY_A });
  for (let i = 0; i < 2; i++) w.store.add({ key: KEY_B });
  const answer = await w.run();
  assertEquals([answer.body.requests, answer.body.sent], [4, 14]);
  assertEquals(
    w.amplitude.requests.map((r) => [
      r.body[KEY_FIELD],
      (r.body.events as Json[]).length,
    ]),
    [[KEY_A, 10], [KEY_A, 10], [KEY_A, 4], [KEY_B, 4]],
  );
});

Deno.test("a refused key: its jobs wait (the destination is paused) and other projects are still sent", async () => {
  const w = world();
  for (let i = 0; i < 7; i++) w.store.add({ key: KEY_A });
  const other = w.store.add({ key: KEY_B });
  // Amplitude repeats the key in its answer.
  w.amplitude.answer = (request) =>
    request.body[KEY_FIELD] === KEY_A
      ? Response.json({ code: 400, error: `Invalid API key: ${KEY_A}` }, {
        status: 400,
      })
      : Response.json({ code: 200 }, { status: 200 });
  const answer = await w.run();
  assertEquals(
    [answer.body.requests, answer.body.paused, answer.body.sent],
    [2, 7, 1],
  );
  // The second request for the refused key is never sent.
  assertEquals(
    w.amplitude.requests.map((r) => r.body[KEY_FIELD]),
    [KEY_A, KEY_B],
  );
  for (const job of w.store.jobs.filter((j) => j.key === KEY_A)) {
    assertEquals(job.outcomes.map((o) => o.error), ["invalid_key"]);
    assertEquals(job.outcomes[0].retry, undefined);
  }
  assertEquals(other.status, "sent");
  const text = JSON.stringify(w.logs) + JSON.stringify(w.store.calls) +
    JSON.stringify(answer.body);
  assert(
    !text.includes(KEY_A.slice(0, 20)),
    "a key reached a log or the database",
  );
});

Deno.test("refused events: the installs are sent one by one and only the one at fault fails", async () => {
  const w = world();
  w.store.add({ userId: "user-good-1" });
  const bad = w.store.add({ userId: "user-bad" });
  w.store.add({ userId: "user-good-2" });
  w.amplitude.answer = (request) =>
    w.amplitude.userIds(request).includes("user-bad")
      ? Response.json({
        code: 400,
        error: "Invalid field values on some events",
        events_with_invalid_fields: { time: [1] },
      }, { status: 400 })
      : Response.json({ code: 200 }, { status: 200 });
  const answer = await w.run();
  assertEquals(
    [answer.body.requests, answer.body.sent, answer.body.failed],
    [4, 2, 1],
  );
  assertEquals(bad.outcomes, [{
    id: bad.id,
    [LEASE_FIELD]: bad.outcomes[0][LEASE_FIELD],
    error: "invalid_event",
    retry: false,
  }]);
  assertEquals(bad.status, "failed");
});

Deno.test("a request that is too large is split", async () => {
  const w = world();
  w.store.add();
  w.store.add();
  w.amplitude.answer = (request) =>
    (request.body.events as Json[]).length > 2
      ? Response.json({ code: 413, error: "Payload too large" }, {
        status: 413,
      })
      : Response.json({ code: 200 }, { status: 200 });
  const answer = await w.run();
  assertEquals([answer.body.requests, answer.body.sent], [3, 2]);
});

Deno.test("throttling, silenced devices, outages and no answer are tried again later", async () => {
  const cases: (() => Response)[] = [
    () =>
      Response.json({
        code: 429,
        error: "Too many requests for some devices and users",
        eps_threshold: 30,
        throttled_users: { "user-1": 31 },
      }, { status: 429 }),
    () =>
      Response.json({
        code: 400,
        error: "Invalid field values on some events",
        silenced_devices: ["d1"],
        exceeded_daily_quota_devices: { d1: 500001 },
      }, { status: 400 }),
    () => new Response("upstream", { status: 503 }),
    () => new Response(null, { status: 502 }),
    () => Response.json({ code: 403, error: "Forbidden" }, { status: 403 }),
    () => {
      throw new TypeError("connection reset");
    },
  ];
  const expected: [string, number | undefined][] = [
    ["throttled", THROTTLE_DELAY_SECONDS],
    ["silenced", SILENCED_DELAY_SECONDS],
    ["server_error", undefined],
    ["server_error", undefined],
    ["forbidden", undefined],
    ["network_error", undefined],
  ];
  for (const [i, respond] of cases.entries()) {
    const w = world();
    const job = w.store.add();
    w.amplitude.answer = respond;
    const answer = await w.run();
    assertEquals([answer.status, answer.body.retried], [200, 1]);
    const [code, delay] = expected[i];
    assertEquals(job.outcomes, [{
      id: job.id,
      [LEASE_FIELD]: job.outcomes[0][LEASE_FIELD],
      error: code,
      retry: true,
      ...(delay ? { delay_seconds: delay } : {}),
    }]);
    assertEquals(job.status, "pending");
  }
  assertEquals(THROTTLE_DELAY_SECONDS, 60);
});

Deno.test("jobs this run has no time left for are handed back unsent", async () => {
  const w = world();
  for (let i = 0; i < 10; i++) w.store.add();
  w.amplitude.answer = () => {
    // The first request takes the whole budget.
    w.clock.now += WORK_BUDGET_MS;
    return Response.json({ code: 200 }, { status: 200 });
  };
  const answer = await w.run();
  assertEquals(
    [answer.body.requests, answer.body.sent, answer.body.released],
    [1, 5, 5],
  );
  assertEquals(
    w.store.jobs.slice(5).map((j) => j.outcomes.map((o) => o.release)),
    Array(5).fill([true]),
  );
});

Deno.test("each run claims again while a full claim came back", async () => {
  const w = world();
  for (let i = 0; i < CLAIM_LIMIT + 3; i++) w.store.add();
  const answer = await w.run();
  assertEquals([answer.body.claimed, answer.body.sent], [
    CLAIM_LIMIT + 3,
    CLAIM_LIMIT + 3,
  ]);
  assertEquals(
    w.store.calls.filter((c) => c.name === "claim_analytics_destination_jobs")
      .length,
    2,
  );
});

Deno.test("a finish the database refuses is counted and the run goes on", async () => {
  const w = world();
  const lost = w.store.add();
  const kept = w.store.add();
  w.store.failFinishFor.add(lost.id);
  const answer = await w.run();
  assertEquals([answer.status, answer.body.sent, answer.body.errors], [
    200,
    1,
    1,
  ]);
  assertEquals(kept.status, "sent");
  assert(
    w.logs.some((l) => l.outcome === "lease_lost" && l.job_id === lost.id),
  );
});

Deno.test("a claim the database refuses ends the run with 503", async () => {
  const w = world();
  w.store.failClaim = true;
  const answer = await w.run();
  assertEquals(answer.status, 503);
  assertEquals(w.amplitude.requests, []);
});

Deno.test("a claim answer that is not what the database promises is refused before anything is sent", async () => {
  const w = world();
  const job = w.store.add();
  const json = w.store.json.bind(w.store);
  w.store.json = (j) => ({ ...json(j), [KEY_FIELD]: "not-a-key" });
  const answer = await w.run();
  assertEquals(answer.status, 503);
  assertEquals(w.amplitude.requests, []);
  assertEquals(job.status, "pending");
});

Deno.test("switched off: the worker answers that it is off and touches nothing", async () => {
  const w = world({
    enabled: () => false,
    store: () => {
      throw new Error("the store was opened");
    },
  });
  const answer = await w.run();
  assertEquals([answer.status, answer.body.enabled, answer.body.claimed], [
    200,
    false,
    0,
  ]);
  assertEquals(w.amplitude.requests, []);
});

Deno.test("the flag is on only when it is exactly true", async () => {
  const { analyticsDestinationsEnabled } = await import("./index.ts");
  assertEquals(analyticsDestinationsEnabled(() => "true"), true);
  assertEquals(analyticsDestinationsEnabled(() => "TRUE"), false);
  assertEquals(analyticsDestinationsEnabled(() => "1"), false);
  assertEquals(analyticsDestinationsEnabled(() => undefined), false);
});

Deno.test("the schedule and other callers each need their own credential", async () => {
  const names = [
    "ANALYTICS_DESTINATIONS_SCHEDULER_SECRET",
    "INTERNAL_WORKER_SECRET",
  ];
  const saved = names.map((name) => Deno.env.get(name));
  const scheduler = "scheduler-fixture-00000000000000000000000";
  const internal = "internal-fixture-000000000000000000000000";
  Deno.env.set(names[0], scheduler);
  Deno.env.set(names[1], internal);
  try {
    const store = new FakeStore();
    const amplitude = new FakeAmplitude();
    const worker = createAnalyticsDestinationsWorker({
      enabled: () => true,
      store: () => store,
      fetcher: amplitude.fetch,
      now: () => START,
      log: () => {},
    });
    const call = async (headers: Record<string, string>, method = "POST") =>
      (await worker(
        new Request("https://functions.example/analytics-destinations-worker", {
          method,
          headers,
        }),
      )).status;
    assertEquals(await call({ "x-kma-scheduler-secret": scheduler }), 200);
    assertEquals(await call({ "x-kma-worker-secret": internal }), 200);
    assertEquals(await call({ "x-kma-scheduler-secret": internal }), 401);
    assertEquals(await call({ "x-kma-worker-secret": scheduler }), 401);
    assertEquals(await call({ "x-kma-worker-secret": "" }), 401);
    assertEquals(await call({}), 401);
    assertEquals(
      await call({
        "x-kma-scheduler-secret": scheduler,
        origin: "https://merchant.kissmyapps.dev",
      }),
      401,
    );
    assertEquals(
      await call({ "x-kma-scheduler-secret": scheduler }, "GET"),
      405,
    );
    Deno.env.set(names[0], "short");
    assertEquals(await call({ "x-kma-scheduler-secret": "short" }), 401);
    assertEquals(
      store.calls.filter((c) => c.name === "claim_analytics_destination_jobs")
        .length,
      2,
    );
  } finally {
    names.forEach((name, i) =>
      saved[i] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, saved[i]!)
    );
  }
});

Deno.test("logs carry codes, counts and job ids only: never a key or a user ID", async () => {
  const w = world();
  w.store.add({ userId: "user-private-77", key: KEY_A });
  w.store.add({ userId: "user-private-78", key: KEY_B });
  w.amplitude.answer = (request) =>
    request.body[KEY_FIELD] === KEY_B
      ? Response.json({ code: 400, error: `Invalid API key: ${KEY_B}` }, {
        status: 400,
      })
      : Response.json({ code: 500, error: `boom ${KEY_A}` }, { status: 500 });
  await w.run();
  const text = JSON.stringify(w.logs);
  for (
    const hidden of [KEY_A, KEY_B, "user-private-77", "user-private-78", "boom"]
  ) {
    assert(!text.includes(hidden), hidden);
  }
  assertEquals(w.logs.at(-1)?.outcome, "processed");
  assertEquals(w.logs.at(-1)?.counts?.paused, 1);
  assertEquals(w.logs.at(-1)?.counts?.retried, 1);
});
