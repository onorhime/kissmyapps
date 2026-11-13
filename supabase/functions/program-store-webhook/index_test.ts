// deno-lint-ignore-file require-await -- Fake adapters keep production async boundaries.
import { assert, assertEquals } from "@std/assert";
import { bytesToHex } from "../_shared/crypto.ts";
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import {
  createProgramStoreWebhook,
  epochSeconds,
  handleProgramStoreWebhook,
  normalizeAdapty,
  normalizeRevenueCat,
  type ProgramStoreLogEntry,
  type ProgramStoreWebhookDependencies,
  type StoreEventCall,
  toMinor,
} from "./index.ts";

type Json = Record<string, unknown>;
const BASE = "https://functions.example/functions/v1/program-store-webhook";
// What the console shows once; a fixed placeholder, never a real value.
const HEADER_VALUE = "Bearer " + "K".repeat(43);
const PURCHASED_MS = Date.parse("2026-11-13T11:30:00.123Z");

// Person data the tools send that must never leave the function or be logged.
const PRIVATE = [
  "ann@example.test",
  "Ann Private",
  "+15555550100",
  "10.10.1.1",
  "idfa-private-ann",
];

/** A RevenueCat body shaped like the documented samples. */
function revenueCat(event: Json = {}): Json {
  return {
    api_version: "1.0",
    event: {
      id: "rc-event-0001",
      type: "INITIAL_PURCHASE",
      app_id: "app-fluent",
      app_user_id: "u-ann",
      original_app_user_id: "$RCAnonymousID:anon-ann",
      aliases: ["$RCAnonymousID:anon-ann", "u-ann"],
      environment: "PRODUCTION",
      store: "APP_STORE",
      product_id: "fluent_monthly",
      entitlement_ids: ["pro"],
      period_type: "NORMAL",
      transaction_id: "rc-tx-0001",
      original_transaction_id: "rc-orig-0001",
      purchased_at_ms: PURCHASED_MS,
      expiration_at_ms: PURCHASED_MS + 30 * 86_400_000,
      event_timestamp_ms: PURCHASED_MS + 1000,
      currency: "USD",
      price: 9.99,
      price_in_purchased_currency: 9.99,
      tax_percentage: 0.1,
      commission_percentage: 0.15,
      takehome_percentage: 0.85,
      country_code: "US",
      offer_code: null,
      subscriber_attributes: {
        "$email": { value: "ann@example.test", updated_at_ms: PURCHASED_MS },
        "$displayName": { value: "Ann Private", updated_at_ms: PURCHASED_MS },
        "$phoneNumber": { value: "+15555550100", updated_at_ms: PURCHASED_MS },
        "$idfa": { value: "idfa-private-ann", updated_at_ms: PURCHASED_MS },
      },
      ...event,
    },
  };
}

/** An Adapty body shaped like the documented subscription_started sample. */
function adapty(properties: Json = {}, top: Json = {}): Json {
  return {
    profile_id: "adapty-profile-ann",
    customer_user_id: "u-ann",
    email: "ann@example.test",
    idfa: "idfa-private-ann",
    event_type: "subscription_started",
    event_datetime: "2024-11-15T10:45:40.000000+0000",
    event_api_version: 1,
    event_properties: {
      profile_event_id: "adapty-event-0001",
      environment: "Production",
      store: "play_store",
      vendor_product_id: "fluent_monthly",
      transaction_id: "GPA.0001",
      original_transaction_id: "GPA.0001",
      purchase_date: "2024-11-15T10:45:36.181000+0000",
      original_purchase_date: "2024-11-15T10:45:36.181000+0000",
      currency: "USD",
      price_local: 4.99,
      price_usd: 4.99,
      proceeds_local: 4.2315,
      proceeds_usd: 4.2315,
      net_revenue_local: 4.2315,
      net_revenue_usd: 4.2315,
      tax_amount_local: 0,
      tax_amount_usd: 0,
      consecutive_payments: 1,
      store_country: "AR",
      profile_ip_address: "10.10.1.1",
      ...properties,
    },
    ...top,
  };
}

function request(
  provider: string,
  payload: Json | string,
  options: { headers?: Record<string, string>; method?: string } = {},
): Request {
  return new Request(`${BASE}/${provider}`, {
    method: options.method ?? "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: HEADER_VALUE,
      ...options.headers,
    },
    body: options.method === "GET"
      ? undefined
      : typeof payload === "string"
      ? payload
      : JSON.stringify(payload),
  });
}

function fixture(
  overrides: Partial<ProgramStoreWebhookDependencies> = {},
  result: unknown = {
    received: true,
    duplicate: false,
    outcome: "sale",
    sale_id: "sale-1",
    subscription_sequence: 1,
  },
) {
  const calls: StoreEventCall[] = [], logs: ProgramStoreLogEntry[] = [];
  const handler = createProgramStoreWebhook({
    enabled: () => true,
    log: (entry) => logs.push(entry),
    record: async (call) => {
      calls.push(call);
      return result;
    },
    ...overrides,
  });
  return { handler, calls, logs };
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

function assertNothingPrivate(value: unknown) {
  const written = JSON.stringify(value);
  for (const item of PRIVATE) assert(!written.includes(item), item);
}

function assertQuietLogs(logs: ProgramStoreLogEntry[]) {
  const written = JSON.stringify(logs);
  for (
    const item of [
      ...PRIVATE,
      HEADER_VALUE,
      "K".repeat(43),
      "u-ann",
      "anon-ann",
    ]
  ) assert(!written.includes(item), item);
}

Deno.test("a disabled webhook answers 503 and records nothing, for both tools", async () => {
  const f = fixture({ enabled: () => false });
  for (
    const [provider, body] of [["revenuecat", revenueCat()], [
      "adapty",
      adapty(),
    ], [
      "adapty",
      {},
    ]] as const
  ) {
    const response = await f.handler(request(provider, body));
    assertEquals(response.status, 503);
    assertEquals(
      (await response.json()).error,
      "program_store_webhook_disabled",
    );
  }
  assertEquals(f.calls.length, 0);
});

Deno.test("only the exact value true in the environment turns the webhook on", async () => {
  const name = "PROGRAM_STORE_WEBHOOK_ENABLED";
  const previous = Deno.env.get(name);
  const calls: StoreEventCall[] = [];
  // The shipped switch, with the database call faked.
  const handler = createProgramStoreWebhook({
    log: () => {},
    record: async (call) => {
      calls.push(call);
      return { received: true, duplicate: false, outcome: "sale" };
    },
  });
  const consoleLog = console.log;
  console.log = () => {};
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "yes"]) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
      const response = await handler(request("revenuecat", revenueCat()));
      assertEquals(response.status, 503, String(value));
      await response.body?.cancel();
      // So does the exported handler that Deno.serve runs.
      const exported = await handleProgramStoreWebhook(
        request("adapty", adapty()),
      );
      assertEquals(exported.status, 503, String(value));
      await exported.body?.cancel();
    }
    assertEquals(calls.length, 0);
    Deno.env.set(name, "true");
    assertEquals(
      (await handler(request("revenuecat", revenueCat()))).status,
      200,
    );
    assertEquals(calls.length, 1);
  } finally {
    console.log = consoleLog;
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
});

Deno.test("browsers, other methods, other content types, unknown tools and oversized bodies are refused", async () => {
  const f = fixture();
  const cases: [Request, number, string][] = [
    [request("revenuecat", "", { method: "GET" }), 405, "method_not_allowed"],
    [
      request("revenuecat", revenueCat(), {
        headers: { "Content-Type": "text/plain" },
      }),
      415,
      "unsupported_media_type",
    ],
    [
      request("revenuecat", revenueCat(), {
        headers: { Origin: "https://console.example" },
      }),
      403,
      "browser_request_rejected",
    ],
    [request("stripe", revenueCat()), 404, "unknown_provider"],
    [request("", revenueCat()), 404, "unknown_provider"],
    [
      request("revenuecat", JSON.stringify({ pad: "x".repeat(256 * 1024) })),
      413,
      "payload_too_large",
    ],
  ];
  for (const [req, status, error] of cases) {
    const response = await f.handler(req);
    assertEquals(response.status, status, error);
    assertEquals((await response.json()).error, error);
  }
  assertEquals(f.calls.length, 0);
});

Deno.test("a call without the Authorization header, or with an overlong one, is refused before the body is read", async () => {
  const f = fixture();
  const missing = new Request(`${BASE}/revenuecat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(revenueCat()),
  });
  let response = await f.handler(missing);
  assertEquals(response.status, 401);
  assertEquals((await response.json()).error, "missing_authorization");
  response = await f.handler(
    request("adapty", adapty(), {
      headers: { Authorization: "Bearer " + "K".repeat(1100) },
    }),
  );
  assertEquals(response.status, 401);
  assertEquals((await response.json()).error, "unknown_connection");
  assertEquals(f.calls.length, 0);
});

Deno.test("bodies that are not a tool event answer 400", async () => {
  const f = fixture();
  for (
    const [provider, body] of [
      ["revenuecat", "{not json"],
      ["revenuecat", "[]"],
      ["revenuecat", "{}"],
      ["revenuecat", JSON.stringify({ api_version: "1.0", event: [] })],
      ["revenuecat", JSON.stringify(revenueCat({ id: "" }))],
      ["revenuecat", JSON.stringify(revenueCat({ id: "x".repeat(201) }))],
      ["adapty", "null"],
      ["adapty", JSON.stringify({ event_type: "subscription_started" })],
      ["adapty", JSON.stringify(adapty({ profile_event_id: 7 }))],
    ] as const
  ) {
    const response = await f.handler(request(provider, body));
    assertEquals(response.status, 400, body.slice(0, 40));
    assertEquals((await response.json()).error, "invalid_event");
  }
  assertEquals(f.calls.length, 0);
});

Deno.test("a RevenueCat purchase becomes one plain call, keyed by the header hash", async () => {
  const f = fixture();
  const response = await f.handler(
    request("revenuecat", revenueCat(), {
      headers: { "X-Request-ID": "req-store-0001" },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("X-Request-ID"), "req-store-0001");
  assertEquals(await response.json(), {
    received: true,
    outcome: "sale",
    duplicate: false,
    request_id: "req-store-0001",
  });
  assertEquals(f.calls, [{
    event_id: "rc-event-0001",
    type: "initial_purchase",
    environment: "production",
    app_user_id: "u-ann",
    aliases: ["$RCAnonymousID:anon-ann"],
    store: "app_store",
    product_id: "fluent_monthly",
    transaction_id: "rc-tx-0001",
    original_transaction_id: "rc-orig-0001",
    purchased_at: Math.floor(PURCHASED_MS / 1000),
    currency: "USD",
    amount_minor: 999,
    tax_minor: 100,
    store_fee_minor: 150,
    usd: { amount_minor: 999, proceeds_minor: 749 },
    refunded_minor: null,
    header_sha256: await sha256(HEADER_VALUE),
    provider: "revenuecat",
  }]);
  assert(/^[a-f0-9]{64}$/.test(f.calls[0].header_sha256));
  assertNothingPrivate(f.calls);
  assertEquals(f.logs, [{
    level: "info",
    worker: "program-store-webhook",
    outcome: "sale",
    request_id: "req-store-0001",
    provider: "revenuecat",
    event_type: "initial_purchase",
  }]);
  assertQuietLogs(f.logs);
});

Deno.test("RevenueCat renewals, refunds, cancellations and other types map as documented", () => {
  // A renewal paid in euros keeps RevenueCat's USD figures beside it.
  assertEquals(
    normalizeRevenueCat(revenueCat({
      id: "rc-event-0002",
      type: "RENEWAL",
      currency: "EUR",
      price: 10.81,
      price_in_purchased_currency: 9.99,
      tax_percentage: 0.16,
      commission_percentage: 0.15,
      store: "PLAY_STORE",
    })),
    {
      event_id: "rc-event-0002",
      type: "renewal",
      environment: "production",
      app_user_id: "u-ann",
      aliases: ["$RCAnonymousID:anon-ann"],
      store: "play_store",
      product_id: "fluent_monthly",
      transaction_id: "rc-tx-0001",
      original_transaction_id: "rc-orig-0001",
      purchased_at: Math.floor(PURCHASED_MS / 1000),
      currency: "EUR",
      amount_minor: 999,
      tax_minor: 160,
      store_fee_minor: 150,
      usd: { amount_minor: 1081, proceeds_minor: 746 },
      refunded_minor: null,
    },
  );
  // A refund is a CANCELLATION for CUSTOMER_SUPPORT with a negative price.
  const refund = normalizeRevenueCat(revenueCat({
    type: "CANCELLATION",
    cancel_reason: "CUSTOMER_SUPPORT",
    price: -9.99,
    price_in_purchased_currency: -9.99,
  }));
  assertEquals(
    [
      refund.type,
      refund.refunded_minor,
      refund.usd,
      refund.amount_minor,
      refund.tax_minor,
    ],
    ["refund", 999, { amount_minor: 999, proceeds_minor: null }, null, null],
  );
  const negative = normalizeRevenueCat(revenueCat({
    type: "CANCELLATION",
    cancel_reason: "UNKNOWN",
    price: -9.99,
    price_in_purchased_currency: -9.99,
  }));
  assertEquals(negative.type, "refund");
  const cancelled = normalizeRevenueCat(revenueCat({
    type: "CANCELLATION",
    cancel_reason: "UNSUBSCRIBE",
    price: 0,
    price_in_purchased_currency: 0,
  }));
  assertEquals(
    [
      cancelled.type,
      cancelled.amount_minor,
      cancelled.refunded_minor,
      cancelled.usd,
    ],
    ["cancellation", null, null, null],
  );
  for (
    const type of [
      "TEST",
      "EXPIRATION",
      "BILLING_ISSUE",
      "TRANSFER",
      "PRODUCT_CHANGE",
    ]
  ) {
    const other = normalizeRevenueCat(revenueCat({ type }));
    assertEquals([other.type, other.amount_minor], ["other", null], type);
  }
  assertEquals(
    normalizeRevenueCat(revenueCat({ type: "NON_RENEWING_PURCHASE" })).type,
    "initial_purchase",
  );
});

Deno.test("RevenueCat sandbox and the test store are never production", () => {
  assertEquals(
    normalizeRevenueCat(revenueCat({ environment: "SANDBOX" })).environment,
    "sandbox",
  );
  const testStore = normalizeRevenueCat(revenueCat({ store: "TEST_STORE" }));
  assertEquals([testStore.environment, testStore.store], ["sandbox", "other"]);
  assertEquals(
    normalizeRevenueCat(revenueCat({ environment: undefined })).environment,
    "sandbox",
  );
  const stores = [
    "APP_STORE",
    "MAC_APP_STORE",
    "PLAY_STORE",
    "AMAZON",
    "STRIPE",
    "PROMOTIONAL",
  ]
    .map((store) => normalizeRevenueCat(revenueCat({ store })).store);
  assertEquals(stores, [
    "app_store",
    "app_store",
    "play_store",
    "amazon",
    "stripe",
    "other",
  ]);
});

Deno.test("RevenueCat amounts follow the currency's minor unit and unknown shares stay unknown", () => {
  const yen = normalizeRevenueCat(revenueCat({
    currency: "JPY",
    price: 8,
    price_in_purchased_currency: 1200,
  }));
  assertEquals([yen.amount_minor, yen.tax_minor, yen.store_fee_minor], [
    1200,
    120,
    180,
  ]);
  assertEquals(yen.usd, { amount_minor: 800, proceeds_minor: 600 });
  const unknown = normalizeRevenueCat(revenueCat({
    tax_percentage: null,
    commission_percentage: 2,
  }));
  assertEquals(
    [
      unknown.amount_minor,
      unknown.tax_minor,
      unknown.store_fee_minor,
      unknown.usd,
    ],
    [999, null, null, { amount_minor: 999, proceeds_minor: null }],
  );
  // Never more taken off than the price.
  const all = normalizeRevenueCat(
    revenueCat({ tax_percentage: 0.6, commission_percentage: 0.6 }),
  );
  assertEquals([all.tax_minor, all.store_fee_minor, all.usd?.proceeds_minor], [
    599,
    400,
    0,
  ]);
  assertEquals(toMinor(3.5, "KWD"), 3500);
  assertEquals(toMinor(-12.34, "USD"), 1234);
  assertEquals(toMinor("9.99", "USD"), null);
  assertEquals(toMinor(9.99, null), null);
  assertEquals(
    normalizeRevenueCat(revenueCat({ currency: "dollars" })).amount_minor,
    null,
  );
});

Deno.test("RevenueCat user ids keep at most 20 distinct aliases and drop control characters", () => {
  const many = normalizeRevenueCat(revenueCat({
    original_app_user_id: "u-ann",
    aliases: [
      "u-ann",
      ...Array.from({ length: 30 }, (_, i) => `alias-${i}`),
      "alias-1",
    ],
  }));
  assertEquals(many.aliases.length, 20);
  assertEquals(many.aliases[0], "alias-0");
  assert(!many.aliases.includes("u-ann"));
  const broken = normalizeRevenueCat(revenueCat({
    app_user_id: "u-ann\nforged",
    original_app_user_id: 42,
    aliases: "not-a-list",
    transaction_id: "\u007f",
  }));
  assertEquals([broken.app_user_id, broken.aliases, broken.transaction_id], [
    null,
    [],
    null,
  ]);
});

Deno.test("an Adapty purchase from the documented sample becomes one plain call", async () => {
  const f = fixture();
  const response = await f.handler(request("adapty", adapty()));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).outcome, "sale");
  assertEquals(f.calls, [{
    event_id: "adapty-event-0001",
    type: "initial_purchase",
    environment: "production",
    app_user_id: "u-ann",
    aliases: ["adapty-profile-ann"],
    store: "play_store",
    product_id: "fluent_monthly",
    transaction_id: "GPA.0001",
    original_transaction_id: "GPA.0001",
    purchased_at: Date.parse("2024-11-15T10:45:36Z") / 1000,
    currency: "USD",
    amount_minor: 499,
    tax_minor: 0,
    store_fee_minor: 76,
    usd: { amount_minor: 499, proceeds_minor: 423 },
    refunded_minor: null,
    header_sha256: await sha256(HEADER_VALUE),
    provider: "adapty",
  }]);
  assertNothingPrivate(f.calls);
  assertQuietLogs(f.logs);
});

Deno.test("Adapty tax and the store's cut come out of the price the way Adapty computes net revenue", () => {
  // Adapty's own example: price 12, a 30% cut and 20% tax give tax 2 and net 7.
  const euro = {
    currency: "EUR",
    price_local: 12,
    tax_amount_local: 2,
    proceeds_local: 8.4,
    net_revenue_local: 7,
    price_usd: 13,
    proceeds_usd: 9.1,
    net_revenue_usd: 7.58,
  };
  const withNet = normalizeAdapty(adapty(euro));
  assertEquals(
    [
      withNet.amount_minor,
      withNet.tax_minor,
      withNet.store_fee_minor,
      withNet.usd,
    ],
    [1200, 200, 300, { amount_minor: 1300, proceeds_minor: 758 }],
  );
  // Without net revenue, proceeds lose the tax share.
  const proceedsOnly = normalizeAdapty(adapty({
    ...euro,
    net_revenue_local: null,
    net_revenue_usd: undefined,
  }));
  assertEquals(
    [proceedsOnly.store_fee_minor, proceedsOnly.usd?.proceeds_minor],
    [300, 758],
  );
  const noFigures = normalizeAdapty(adapty({
    ...euro,
    tax_amount_local: null,
    net_revenue_local: null,
    proceeds_local: null,
    price_usd: null,
  }));
  assertEquals(
    [
      noFigures.amount_minor,
      noFigures.tax_minor,
      noFigures.store_fee_minor,
      noFigures.usd,
    ],
    [1200, null, null, null],
  );
});

Deno.test("Adapty event types, environments and dates map as documented", () => {
  const typeOf = (eventType: string) =>
    normalizeAdapty(adapty({}, { event_type: eventType })).type;
  assertEquals(
    [
      "subscription_started",
      "trial_converted",
      "non_subscription_purchase",
      "subscription_renewed",
      "subscription_refunded",
      "non_subscription_purchase_refunded",
      "subscription_renewal_cancelled",
      "trial_renewal_cancelled",
      "trial_started",
      "access_level_updated",
      "constructor",
    ].map(typeOf),
    [
      "initial_purchase",
      "initial_purchase",
      "initial_purchase",
      "renewal",
      "refund",
      "refund",
      "cancellation",
      "cancellation",
      "other",
      "other",
      "other",
    ],
  );
  const refund = normalizeAdapty(
    adapty({}, { event_type: "subscription_refunded" }),
  );
  assertEquals(
    [refund.refunded_minor, refund.amount_minor, refund.usd],
    [499, null, { amount_minor: 499, proceeds_minor: null }],
  );
  assertEquals(
    normalizeAdapty(adapty({ environment: "Sandbox" })).environment,
    "sandbox",
  );
  assertEquals(
    normalizeAdapty(adapty({ environment: "production" })).environment,
    "sandbox",
  );
  assertEquals(
    normalizeAdapty(adapty({ store: "app_store" })).store,
    "app_store",
  );
  assertEquals(normalizeAdapty(adapty({ store: "paddle" })).store, "other");
  assertEquals(
    normalizeAdapty(adapty({ purchase_date: undefined })).purchased_at,
    Date.parse("2024-11-15T10:45:40Z") / 1000,
  );
  assertEquals(
    normalizeAdapty(adapty({}, { customer_user_id: null })).app_user_id,
    null,
  );
});

Deno.test("dates parse with any documented offset and nothing else", () => {
  const at = Date.parse("2024-11-15T10:45:36Z") / 1000;
  assertEquals(epochSeconds("2024-11-15T10:45:36.181000+0000"), at);
  assertEquals(epochSeconds("2024-11-15T10:45:36Z"), at);
  assertEquals(epochSeconds("2024-11-15T12:45:36+02:00"), at);
  assertEquals(epochSeconds("2024-11-15T05:45:36.5-0500"), at);
  assertEquals(epochSeconds("2024-11-15 10:45:36"), at);
  for (const value of ["", "yesterday", "2024-11-15", 1731667536, null]) {
    assertEquals(epochSeconds(value), null, String(value));
  }
});

Deno.test("Adapty's check of a new address answers 200 without touching the database", async () => {
  const f = fixture();
  const response = await f.handler(request("adapty", {}));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals([body.received, body.verified], [true, true]);
  assertEquals(f.calls.length, 0);
  assertEquals(f.logs[0].outcome, "verification");
  // Not for RevenueCat, which never sends an empty body.
  const rc = await f.handler(request("revenuecat", {}));
  assertEquals(rc.status, 400);
  await rc.body?.cancel();
  assertEquals(f.calls.length, 0);
});

Deno.test("a repeated event answers 200 with the stored outcome", async () => {
  const f = fixture({}, {
    received: true,
    duplicate: true,
    outcome: "ignored_sandbox",
  });
  const response = await f.handler(
    request("revenuecat", revenueCat({ environment: "SANDBOX" })),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals([body.outcome, body.duplicate], ["ignored_sandbox", true]);
  assertEquals(f.logs[0].outcome, "duplicate");
  assertEquals(f.calls[0].environment, "sandbox");
});

Deno.test("database refusals map to 401, 400 and 503 and are logged without person data", async () => {
  const cases: [unknown, number, string, string | undefined][] = [
    [new DatabaseBoundaryError("28000"), 401, "unknown_connection", "28000"],
    [new DatabaseBoundaryError("22023"), 400, "invalid_event", "22023"],
    [
      new DatabaseBoundaryError("40P01"),
      503,
      "database_boundary_error",
      "40P01",
    ],
    [new DatabaseBoundaryError(), 503, "database_boundary_error", undefined],
    [new Error("boom with u-ann"), 500, "internal_error", undefined],
  ];
  for (const [thrown, status, error, code] of cases) {
    const f = fixture({
      record: async () => {
        throw thrown;
      },
    });
    const response = await f.handler(request("revenuecat", revenueCat()));
    assertEquals(response.status, status, error);
    assertEquals((await response.json()).error, error);
    assertEquals(f.logs.length, 1);
    assertEquals(f.logs[0].level, status >= 500 ? "error" : "warning");
    assertEquals(f.logs[0].outcome, error);
    assertEquals(f.logs[0].database_code, code);
    assertEquals(f.logs[0].provider, "revenuecat");
    assertQuietLogs(f.logs);
  }
});

Deno.test("an answer from the database that is not the expected shape fails closed", async () => {
  for (
    const result of [null, [], { outcome: "sale" }, {
      outcome: 1,
      duplicate: false,
    }]
  ) {
    const f = fixture({}, result);
    const response = await f.handler(request("adapty", adapty()));
    assertEquals(response.status, 503, JSON.stringify(result));
    await response.body?.cancel();
  }
});
