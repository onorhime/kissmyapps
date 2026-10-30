import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "@std/assert";
import {
  createAnalyticsIngestHandler,
  type IngestError,
  type IngestResult,
} from "./index.ts";
import type { IngestPayload } from "./payload.ts";
import { geoFromRequest, sha256Hex } from "./payload.ts";

const key = "kma_pk_live_" + "A".repeat(24);
const now = new Date("2026-10-30T12:00:00.000Z");

function setup(
  result: { data: IngestResult | null; error: IngestError | null } = {
    data: { stored: 1, duplicates: 0, rejected: [] },
    error: null,
  },
) {
  const calls: IngestPayload[] = [];
  const handler = createAnalyticsIngestHandler({
    ingest: (payload) => {
      calls.push(payload);
      return Promise.resolve(result);
    },
    ipSalt: () => "salt",
    now: () => now,
  });
  return { calls, handler };
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(
    `https://edge.example/functions/v1/analytics-ingest${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

Deno.test("preflight echoes the calling website", async () => {
  const { handler } = setup();
  const response = await handler(
    new Request(
      "https://edge.example/functions/v1/analytics-ingest/v1/events",
      {
        method: "OPTIONS",
        headers: { origin: "https://shop.example" },
      },
    ),
  );
  assertEquals(response.status, 204);
  assertEquals(
    response.headers.get("access-control-allow-origin"),
    "https://shop.example",
  );
  assertMatch(
    response.headers.get("access-control-allow-headers") ?? "",
    /authorization/,
  );
});

Deno.test("only POST stores events", async () => {
  const { handler } = setup();
  const response = await handler(
    new Request("https://edge.example/functions/v1/analytics-ingest"),
  );
  assertEquals(response.status, 405);
});

Deno.test("a missing or malformed key is refused before the database", async () => {
  const { calls, handler } = setup();
  for (
    const auth of [
      undefined,
      "Bearer nope",
      "Bearer kma_xx_live_" + "A".repeat(24),
    ]
  ) {
    const response = await handler(
      post("/v1/events", { events: [] }, auth ? { authorization: auth } : {}),
    );
    assertEquals(response.status, 401);
    assertEquals((await response.json()).error, "invalid_key");
  }
  assertEquals(calls.length, 0);
});

Deno.test("events are normalised, hashed and placed before ingest", async () => {
  const { calls, handler } = setup();
  const response = await handler(post("/v1/events", {
    anonymous_id: "anon-1",
    user_id: 42,
    traits: { email: "amaka@example.com" },
    session: { id: "s-1", started_at: Date.parse("2026-10-30T09:59:00Z") },
    sent_at: "2026-10-30T10:00:00.000Z",
    context: {
      timezone: "Africa/Lagos",
      device_type: "Desktop",
      screen_width: 1440.4,
      interactions: -3,
      webdriver: false,
      utm: { source: "newsletter", junk: "x" },
      secret: "dropped",
    },
    events: [
      {
        name: "page_viewed",
        time: Date.parse("2026-10-30T10:00:00Z"),
        screen: "/pricing",
      },
      {
        name: "plan_selected",
        insert_id: "e-2",
        time: "2026-10-30T10:00:01Z",
        properties: { plan: "annual" },
      },
      { name: "ordered", user_id: null },
    ],
  }, {
    authorization: `Bearer ${key}`,
    origin: "https://shop.example",
    "user-agent": "Mozilla/5.0 Chrome/129",
    "cf-ipcountry": "ng",
    "cf-ipcity": "Lagos",
    "cf-region": "Lagos",
    "x-forwarded-for": "102.89.1.2, 10.0.0.1",
  }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.stored, 1);
  assertEquals(
    response.headers.get("access-control-allow-origin"),
    "https://shop.example",
  );

  const [payload] = calls;
  assertEquals(payload.key_hash, await sha256Hex(key));
  assertEquals(payload.kind, "events");
  assertEquals(payload.origin, "https://shop.example");
  assertEquals(payload.ip_sha, await sha256Hex("salt:102.89.1.2"));
  assertEquals(payload.geo, {
    country: "NG",
    region: "Lagos",
    city: "Lagos",
    source: "edge",
  });
  // The device clock is two hours slow, so its times are moved forward.
  assertEquals(payload.clock_skew_ms, 2 * 60 * 60 * 1000);
  assertEquals(payload.body.user_id, "42");
  assertEquals(payload.body.session, {
    id: "s-1",
    started_at: "2026-10-30T09:59:00.000Z",
  });
  assertEquals(payload.body.context, {
    platform: "web",
    timezone: "Africa/Lagos",
    device_type: "desktop",
    screen_width: 1440,
    webdriver: false,
    utm: { source: "newsletter" },
  });
  const events = payload.body.events as Record<string, unknown>[];
  assertEquals(events[0].time, "2026-10-30T10:00:00.000Z");
  assertMatch(events[0].insert_id as string, /^[0-9a-f-]{36}$/);
  assertEquals(events[1].insert_id, "e-2");
  assertEquals(events[1].time, "2026-10-30T10:00:01.000Z");
  assertEquals(events[1].properties, { plan: "annual" });
  assertEquals(events[2].time, now.toISOString());
  assertEquals(events[2].user_id, null);
  assert(!("key" in payload.body));
});

Deno.test("beacons carry the key in a text/plain body", async () => {
  const { calls, handler } = setup();
  const response = await handler(
    new Request(
      "https://edge.example/functions/v1/analytics-ingest/v1/events",
      {
        method: "POST",
        headers: {
          "content-type": "text/plain;charset=UTF-8",
          origin: "https://shop.example",
        },
        body: JSON.stringify({
          api_key: key,
          anonymous_id: "a",
          events: [{ name: "page_left" }],
        }),
      },
    ),
  );
  assertEquals(response.status, 200);
  assertEquals(calls[0].key_hash, await sha256Hex(key));
  assertEquals(calls[0].clock_skew_ms, 0);
});

Deno.test("small clock differences are left alone", async () => {
  const { calls, handler } = setup();
  await handler(
    post("/", {
      anonymous_id: "a",
      sent_at: "2026-10-30T11:59:55Z",
      events: [],
    }, {
      authorization: `Bearer ${key}`,
    }),
  );
  assertEquals(calls[0].clock_skew_ms, 0);
  assertEquals(
    (calls[0].body.context as Record<string, unknown>).platform,
    "server",
  );
});

Deno.test("replays go to the replay path and are validated", async () => {
  const { calls, handler } = setup();
  const ok = await handler(post("/v1/replay", {
    anonymous_id: "a",
    session: { id: "s" },
    replay: { seq: 0, first_ts: 1, last_ts: 2, events: [{ type: 4 }] },
  }, { authorization: `Bearer ${key}` }));
  assertEquals(ok.status, 200);
  assertEquals(calls[0].kind, "replay");
  for (
    const bad of [
      {
        anonymous_id: "a",
        replay: { seq: 0, first_ts: 1, last_ts: 2, events: [] },
      },
      {
        anonymous_id: "a",
        session: { id: "s" },
        replay: { seq: -1, first_ts: 1, last_ts: 2, events: [] },
      },
      {
        session: { id: "s" },
        replay: { seq: 0, first_ts: 1, last_ts: 2, events: [] },
      },
    ]
  ) {
    const response = await handler(
      post("/v1/replay", bad, { authorization: `Bearer ${key}` }),
    );
    assertEquals(response.status, 400);
  }
  assertEquals(calls.length, 1);
});

Deno.test("database refusals become clear HTTP errors", async () => {
  for (
    const [code, status, error] of [
      ["28000", 401, "invalid_key"],
      ["42501", 403, "origin_not_allowed"],
      ["55000", 409, "replay_disabled"],
      ["54000", 413, "replay_too_large"],
      ["22023", 400, "invalid_request"],
      ["XX000", 503, "unavailable"],
    ] as const
  ) {
    const { handler } = setup({ data: null, error: { code, message: "boom" } });
    const response = await handler(
      post("/v1/events", { anonymous_id: "a", events: [] }, {
        authorization: `Bearer ${key}`,
      }),
    );
    assertEquals(response.status, status);
    assertEquals((await response.json()).error, error);
  }
});

Deno.test("bodies are bounded and must be JSON", async () => {
  const { handler } = setup();
  const big = await handler(
    post("/v1/events", "x".repeat(600 * 1024), {
      authorization: `Bearer ${key}`,
    }),
  );
  assertEquals(big.status, 413);
  const form = await handler(
    new Request("https://edge.example/functions/v1/analytics-ingest", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${key}`,
      },
      body: "a=1",
    }),
  );
  assertEquals(form.status, 415);
  const tooMany = await handler(post("/v1/events", {
    anonymous_id: "a",
    events: Array.from({ length: 501 }, () => ({ name: "x" })),
  }, { authorization: `Bearer ${key}` }));
  assertEquals(tooMany.status, 400);
});

Deno.test("without CDN headers the time zone gives the country", () => {
  assertEquals(geoFromRequest(new Headers(), "Africa/Lagos"), {
    country: "NG",
    source: "timezone",
  });
  assertEquals(geoFromRequest(new Headers(), "Asia/Calcutta"), {
    country: "IN",
    source: "timezone",
  });
  assertEquals(
    geoFromRequest(new Headers({ "cf-ipcountry": "XX" }), "Europe/London"),
    {
      country: "GB",
      source: "timezone",
    },
  );
  assertEquals(geoFromRequest(new Headers(), "Mars/Base"), {});
  assertEquals(
    geoFromRequest(
      new Headers({
        "x-vercel-ip-country": "GH",
        "x-vercel-ip-city": "S%C3%A3o%20Tom%C3%A9",
      }),
      null,
    ),
    { country: "GH", city: "São Tomé", source: "edge" },
  );
  assertNotEquals(
    geoFromRequest(new Headers({ "cf-ipcountry": "T1" }), null).source,
    "edge",
  );
});
