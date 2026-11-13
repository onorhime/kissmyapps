import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  APPLE_ADS_FIELD,
  APPLE_ADS_URL,
  type AttributionKind,
  type AttributionPayload,
  normalizeAttribution,
} from "./attribution.ts";
import { createAnalyticsIngestHandler, type IngestError } from "./index.ts";
import { sha256Hex } from "./payload.ts";

const key = "kma_pk_live_" + "A".repeat(24);
// What the geo relay and the function share to trust the visitor headers.
const RELAY = "relay-shared-value";
const now = new Date("2026-10-30T12:00:00.000Z");
// What AdServices hands the app for Apple Ads: an opaque base64 blob.
const adsValue = "b3BhcXVlLWFwcGxlLWFkcy12YWx1ZQ" + "x".repeat(40);

const install = {
  anonymous_id: "5f0c7a9e-3b1d-4c2a-9e8f-1a2b3c4d5e6f",
  session_id: "0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e",
  platform: "ios",
  installed_at: "2026-10-30T09:59:00.010Z",
  sdk: "kma-ios/1.1.0",
};
const open = {
  anonymous_id: "5f0c7a9e-3b1d-4c2a-9e8f-1a2b3c4d5e6f",
  session_id: "0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e",
  platform: "android",
  url: "https://fluent.go.kissmyapps.dev/lesson-4?dl=lesson&id=4",
  opened_at: "2026-11-02T08:00:00.000Z",
  sdk: "kma-android/1.1.0",
};
const answer = {
  matched: true,
  method: "link_open",
  source: "tiktok",
  campaign: "launch",
  channel: null,
  adset: null,
  ad: null,
  reinstall: false,
  deep_link: { value: "lesson", params: { id: "4" }, deferred: false },
};
const appleAnswer = {
  attribution: true,
  orgId: 40669820,
  campaignId: 542370539,
  conversionType: "Download",
  clickDate: "2026-10-30T09:40Z",
  adGroupId: 542317095,
  countryOrRegion: "NG",
  keywordId: 87675432,
  adId: 542317136,
};

interface Setup {
  result?: { data: unknown; error: IngestError | null };
  apple?: (call: number, init: RequestInit) => Promise<Response>;
  relayValue?: string;
}

function setup(options: Setup = {}) {
  const calls: { kind: AttributionKind; payload: AttributionPayload }[] = [];
  const appleCalls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const handler = createAnalyticsIngestHandler({
    ingest: () => Promise.reject(new Error("events are not expected here")),
    attribute: (kind, payload) => {
      calls.push({ kind, payload });
      return Promise.resolve(options.result ?? { data: answer, error: null });
    },
    appleFetch: (url, init) => {
      appleCalls.push({ url, init });
      return options.apple
        ? options.apple(appleCalls.length, init)
        : Promise.reject(new Error("Apple is not expected here"));
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    appleTimeoutMs: 20,
    ipSalt: () => "salt",
    proxySecret: () => options.relayValue ?? null,
    now: () => now,
  });
  return { calls, appleCalls, sleeps, handler };
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${key}` },
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

const refusal = (kind: AttributionKind, body: unknown) => {
  try {
    normalizeAttribution(body, kind);
  } catch (error) {
    const { status, code, extra } = error as {
      status: number;
      code: string;
      extra?: Record<string, string>;
    };
    return [status, code, extra?.field];
  }
  return null;
};

Deno.test("an install body keeps every field it may send and drops the rest", () => {
  const full = {
    ...install,
    platform: "android",
    user_id: "user-42",
    app_version: "2.4.0",
    device_key:
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    link_url: "https://fluent.go.kissmyapps.dev/lesson-4?kma_click=" +
      "a".repeat(48),
    referrer: "kma_lc=Q2xpY2tJZDAwMDAwMDAwMQ&utm_source=tiktok",
    referrer_click_ts: 1761818300,
    install_begin_ts: 1761818320,
    clipboard_click: "Q2xpY2tJZDAwMDAwMDAwMQ",
  };
  assertEquals(
    normalizeAttribution(
      { ...full, api_key: key, events: [], traits: { a: 1 } },
      "install",
    ),
    full,
  );
  // The other platform's fields are left out, not refused: Apple Ads is iOS only, the Play
  // install referrer Android only.
  assertEquals(
    normalizeAttribution({ ...full, [APPLE_ADS_FIELD]: adsValue }, "install"),
    full,
  );
  const {
    referrer: _r,
    referrer_click_ts: _c,
    install_begin_ts: _b,
    ...iosFull
  } = full;
  assertEquals(
    normalizeAttribution(
      { ...full, platform: "ios", [APPLE_ADS_FIELD]: adsValue },
      "install",
    ),
    { ...iosFull, platform: "ios", [APPLE_ADS_FIELD]: adsValue },
  );
  // Numbers are user IDs too, as in events; empty or null optional fields are not sent.
  assertEquals(
    normalizeAttribution(
      {
        ...install,
        user_id: 42,
        app_version: "",
        device_key: null,
        referrer_click_ts: 0,
        install_begin_ts: 0,
        url: "https://a.example/",
      },
      "install",
    ),
    { ...install, user_id: "42" },
  );
});

Deno.test("an install body is refused for a missing or malformed field", () => {
  for (const field of Object.keys(install)) {
    for (const value of [undefined, null, "  "]) {
      assertEquals(
        refusal("install", { ...install, [field]: value }),
        [400, "missing_field", field],
        `${field}=${value}`,
      );
    }
  }
  const bad: [string, unknown][] = [
    ["platform", "web"],
    ["platform", "iOS"],
    ["installed_at", "2026-10-30T09:59:00Z"],
    ["installed_at", "2026-10-30T09:59:00.010+01:00"],
    ["installed_at", "2026-02-30T09:59:00.000Z"],
    ["installed_at", 1761818300000],
    ["anonymous_id", "a".repeat(201)],
    ["session_id", "s".repeat(101)],
    ["sdk", { name: "kma-ios" }],
    ["app_version", "v".repeat(41)],
    ["user_id", "u".repeat(201)],
    [
      "device_key",
      "9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08",
    ],
    ["device_key", "abc"],
    ["link_url", "http://fluent.go.kissmyapps.dev/x"],
    ["link_url", "fluent.go.kissmyapps.dev/x"],
    ["link_url", "https://fluent.go.kissmyapps.dev/" + "x".repeat(2020)],
    ["referrer", "r".repeat(1025)],
    ["referrer_click_ts", 1761818300.5],
    ["referrer_click_ts", "1761818300"],
    ["install_begin_ts", -1],
    ["install_begin_ts", 1761818320000],
    [APPLE_ADS_FIELD, "t".repeat(4097)],
    ["clipboard_click", "kma:Q2xpY2tJZDAwMDAwMDAwMQ"],
    ["clipboard_click", "short"],
  ];
  for (const [field, value] of bad) {
    assertEquals(
      refusal("install", { ...install, [field]: value }),
      [400, "invalid_field", field],
      field,
    );
  }
  assertEquals(refusal("install", [install]), [400, "invalid_body", undefined]);
  assertEquals(refusal("install", "x"), [400, "invalid_body", undefined]);
});

Deno.test("an open body needs its link and time, and keeps nothing of an install", () => {
  assertEquals(
    normalizeAttribution(
      {
        ...open,
        user_id: "user-42",
        device_key: "a".repeat(64),
        link_url: "https://a.example/",
        referrer: "kma_lc=x",
        clipboard_click: "Q2xpY2tJZDAwMDAwMDAwMQ",
        [APPLE_ADS_FIELD]: adsValue,
      },
      "open",
    ),
    { ...open, user_id: "user-42", device_key: "a".repeat(64) },
  );
  for (const field of Object.keys(open)) {
    assertEquals(
      refusal("open", { ...open, [field]: undefined }),
      [400, "missing_field", field],
    );
  }
  for (
    const [field, value] of [
      ["url", "http://fluent.go.kissmyapps.dev/x"],
      ["url", "kissmyapps://lesson"],
      ["opened_at", "2026-11-02 08:00:00"],
      ["platform", "web"],
    ]
  ) {
    assertEquals(
      refusal("open", { ...open, [field]: value }),
      [400, "invalid_field", field],
    );
  }
});

Deno.test("an install is passed to attribution_install in the ingest's envelope", async () => {
  const { calls, handler } = setup({ relayValue: RELAY });
  const response = await handler(
    post("/v1/attribution/install", { ...install, api_key: "ignored" }, {
      authorization: `Bearer ${key}`,
      "user-agent": "Fluent/120 CFNetwork/1568 Darwin/24.1.0",
      "x-kma-via": "geo-relay",
      "x-kma-proxy": RELAY,
      "x-kma-client-ip": "102.89.1.2",
      "x-kma-country": "NG",
      "x-kma-city": "Lagos",
      "x-kma-place-source": "ip",
    }),
  );
  assertEquals(response.status, 200);
  assertMatch(response.headers.get("x-request-id") ?? "", /.+/);
  assertEquals(await response.json(), answer);
  assertEquals(calls.length, 1);
  const [{ kind, payload }] = calls;
  assertEquals(kind, "install");
  assertEquals(payload, {
    key_hash: await sha256Hex(key),
    origin: null,
    ip_sha: await sha256Hex("salt:102.89.1.2"),
    user_agent: "Fluent/120 CFNetwork/1568 Darwin/24.1.0",
    geo: { country: "NG", city: "Lagos", source: "ip" },
    clock_skew_ms: 0,
    body: install,
  });
});

Deno.test("an open goes to attribution_open, on any path that ends with it", async () => {
  const { calls, handler } = setup({
    result: { data: { ...answer, deferred: false }, error: null },
  });
  for (
    const path of [
      "/v1/attribution/open",
      "/v1/attribution/open/",
      "/attribution/open",
    ]
  ) {
    const response = await handler(post(path, open));
    assertEquals(response.status, 200, path);
    await response.body?.cancel();
  }
  assertEquals(calls.map((call) => call.kind), ["open", "open", "open"]);
  assertEquals(calls[0].payload.body, open);
  assertEquals(calls[0].payload.geo, {});
  assertEquals(calls[0].payload.ip_sha, null);
});

Deno.test("attribution calls get the same CORS, method and key checks as events", async () => {
  const { calls, appleCalls, handler } = setup();
  const preflight = await handler(
    new Request(
      "https://edge.example/functions/v1/analytics-ingest/v1/attribution/install",
      { method: "OPTIONS", headers: { origin: "https://shop.example" } },
    ),
  );
  assertEquals(preflight.status, 204);
  assertEquals(
    preflight.headers.get("access-control-allow-origin"),
    "https://shop.example",
  );
  assertMatch(
    preflight.headers.get("access-control-allow-headers") ?? "",
    /authorization/,
  );
  const fromSite = await handler(
    post("/v1/attribution/open", open, {
      authorization: `Bearer ${key}`,
      origin: "https://shop.example",
    }),
  );
  assertEquals(fromSite.status, 200);
  await fromSite.body?.cancel();
  assertEquals(
    fromSite.headers.get("access-control-allow-origin"),
    "https://shop.example",
  );
  assertEquals(calls[0].payload.origin, "https://shop.example");

  const get = await handler(
    new Request(
      "https://edge.example/functions/v1/analytics-ingest/v1/attribution/open",
    ),
  );
  assertEquals(get.status, 405);
  await get.body?.cancel();
  const keyless: Record<string, string>[] = [{}, {
    authorization: "Bearer nope",
  }];
  for (const headers of keyless) {
    const response = await handler(
      post("/v1/attribution/install", {
        ...install,
        [APPLE_ADS_FIELD]: adsValue,
      }, headers),
    );
    assertEquals(response.status, 401);
    assertEquals((await response.json()).error, "invalid_key");
  }
  // A key in a text/plain body, as for beacons, works too.
  const beacon = await handler(
    new Request(
      "https://edge.example/functions/v1/analytics-ingest/v1/attribution/open",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ ...open, api_key: key }),
      },
    ),
  );
  assertEquals(beacon.status, 200);
  await beacon.body?.cancel();
  assertEquals(calls.length, 2);
  assert(!("api_key" in calls[1].payload.body));
  assertEquals(appleCalls.length, 0);
});

Deno.test("attribution bodies are bounded, must be JSON, and are refused with the field", async () => {
  const { calls, handler } = setup();
  const big = await handler(
    post("/v1/attribution/install", "x".repeat(600 * 1024)),
  );
  assertEquals(big.status, 413);
  await big.body?.cancel();
  const notJson = await handler(post("/v1/attribution/install", "{"));
  assertEquals(notJson.status, 400);
  assertEquals((await notJson.json()).error, "invalid_json");
  const form = await handler(
    new Request(
      "https://edge.example/functions/v1/analytics-ingest/v1/attribution/open",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${key}`,
        },
        body: "a=1",
      },
    ),
  );
  assertEquals(form.status, 415);
  await form.body?.cancel();
  const missing = await handler(
    post("/v1/attribution/install", { ...install, session_id: undefined }),
  );
  assertEquals(missing.status, 400);
  const missingBody = await missing.json();
  assertEquals(missingBody.error, "missing_field");
  assertEquals(missingBody.field, "session_id");
  assertEquals(missingBody.message, "session_id is required.");
  assertMatch(missingBody.request_id, /.+/);
  const malformed = await handler(
    post("/v1/attribution/open", { ...open, url: "http://x.example/" }),
  );
  assertEquals(malformed.status, 400);
  const malformedBody = await malformed.json();
  assertEquals(
    [malformedBody.error, malformedBody.field, malformedBody.message],
    [
      "invalid_field",
      "url",
      "url must be an https URL of at most 2048 characters.",
    ],
  );
  assertEquals(calls.length, 0);
});

Deno.test("database refusals become the ingest's HTTP errors, with the reason", async () => {
  for (
    const [error, status, body] of [
      [{ code: "28000", message: "invalid_key" }, 401, {
        error: "invalid_key",
        message: "This API key is unknown or revoked.",
      }],
      [{ code: "42501", message: "origin_not_allowed" }, 403, {
        error: "origin_not_allowed",
        message:
          "This website is not allowed to use this key. Add it under the project's allowed websites.",
      }],
      [
        {
          code: "22023",
          message: "The link_url is malformed",
          details: "invalid_link_url",
        },
        400,
        {
          error: "invalid_request",
          message: "The link_url is malformed",
          reason: "invalid_link_url",
        },
      ],
      [
        { code: "22023", message: "Bad", details: "Not a code, a sentence." },
        400,
        { error: "invalid_request", message: "Bad" },
      ],
      [{ code: "XX000", message: "boom" }, 503, {
        error: "unavailable",
        message: "Attribution is unavailable. Retry later.",
      }],
    ] as const
  ) {
    const { handler } = setup({ result: { data: null, error } });
    const response = await handler(post("/v1/attribution/install", install));
    assertEquals(response.status, status);
    const { request_id, ...rest } = await response.json();
    assertMatch(request_id, /.+/);
    assertEquals(rest, body);
  }
  // An answer that is not the contract's is the database's fault, not the app's.
  for (const data of [null, [], { matched: "yes" }, { matched: true }]) {
    const { handler } = setup({ result: { data, error: null } });
    const response = await handler(post("/v1/attribution/open", open));
    assertEquals(response.status, 503);
    assertEquals((await response.json()).error, "unavailable");
  }
});

const iosInstall = { ...install, [APPLE_ADS_FIELD]: adsValue };
const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

Deno.test("Apple's answer replaces the Apple Ads value before the database", async () => {
  const { calls, appleCalls, sleeps, handler } = setup({
    apple: () => json({ ...appleAnswer, nested: { no: 1 }, "bad key": 1 }),
  });
  const response = await handler(post("/v1/attribution/install", iosInstall));
  assertEquals(response.status, 200);
  await response.body?.cancel();
  assertEquals(appleCalls.length, 1);
  assertEquals(appleCalls[0].url, APPLE_ADS_URL);
  assertEquals(appleCalls[0].url, "https://api-adservices.apple.com/api/v1/");
  assertEquals(appleCalls[0].init.method, "POST");
  assertEquals(
    new Headers(appleCalls[0].init.headers).get("content-type"),
    "text/plain",
  );
  assertEquals(appleCalls[0].init.body, adsValue);
  assert(appleCalls[0].init.signal instanceof AbortSignal);
  assertEquals(sleeps, []);
  assertEquals(calls[0].payload.body, { ...install, apple_ads: appleAnswer });
  assert(!JSON.stringify(calls[0].payload).includes(adsValue));
});

Deno.test("Apple's 404 is asked again once, after a second", async () => {
  const { calls, appleCalls, sleeps, handler } = setup({
    apple: (call) => call === 1 ? json({}, 404) : json(appleAnswer),
  });
  const response = await handler(post("/v1/attribution/install", iosInstall));
  assertEquals(response.status, 200);
  await response.body?.cancel();
  assertEquals(appleCalls.length, 2);
  assertEquals(appleCalls[1].init.body, adsValue);
  assertEquals(sleeps, [1_000]);
  assertEquals(calls[0].payload.body.apple_ads, appleAnswer);

  const twice = setup({ apple: () => json({}, 404) });
  await (await twice.handler(post("/v1/attribution/install", iosInstall))).body
    ?.cancel();
  assertEquals(twice.appleCalls.length, 2);
  assertEquals(twice.calls[0].payload.body, install);
});

Deno.test("without Apple's answer the install still goes on, without the value", async () => {
  const failures: Record<string, Setup["apple"]> = {
    "500": () => json({ error: "x" }, 500),
    "400": () => json({ error: "x" }, 400),
    "not JSON": () => Promise.resolve(new Response("<html>", { status: 200 })),
    "not an object": () => json([appleAnswer]),
    "unreachable": () => Promise.reject(new TypeError("network down")),
    // Answers only when the request is given up on, as a stalled connection would.
    "timeout": (_call, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
        );
      }),
  };
  const logged: unknown[] = [];
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  console.log = console.error = console.warn = (...args: unknown[]) =>
    logged.push(...args);
  try {
    for (const [name, apple] of Object.entries(failures)) {
      const { calls, appleCalls, sleeps, handler } = setup({ apple });
      const response = await handler(
        post("/v1/attribution/install", iosInstall),
      );
      assertEquals(response.status, 200, name);
      await response.body?.cancel();
      assertEquals(appleCalls.length, 1, name);
      assertEquals(sleeps, [], name);
      assertEquals(calls[0].payload.body, install, name);
    }
  } finally {
    Object.assign(console, original);
  }
  assert(!logged.some((line) => String(line).includes(adsValue)));
});
