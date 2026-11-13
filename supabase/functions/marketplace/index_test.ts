import { assertEquals } from "@std/assert";
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import {
  createMarketplaceHandler,
  type MarketplaceLogEntry,
  type MarketplaceStore,
} from "./index.ts";

const CARD = {
  slug: "speaksix",
  name: "SpeakSix",
  category: "education",
  tagline: "Speak English with confidence in six weeks.",
  logo_path: "0b0f6a52-7a3e-4a43-9d5c-0f3f1f8f6f11/logo.png",
  brand_name: "SpeakSix Ltd",
  commission_type: "percent",
  commission_rate_bps: 3000,
  commission_fixed_minor: null,
  currency: "USD",
  commission_duration: "months",
  commission_months: 12,
  attribution_window_days: 30,
  hold_days: 30,
  minimum_payout_minor: 2000,
  approval_mode: "automatic",
  terms_version: 1,
};

const AGREEMENT = {
  title: "SpeakSix Affiliate Agreement",
  brand_name: "SpeakSix Ltd",
  program_name: "SpeakSix",
  summary: [
    { label: "Commission", value: "30% of every payment for 12 months" },
    { label: "Attribution window", value: "30 days" },
  ],
  sections: [
    { heading: "1. The program", paragraphs: ["You promote SpeakSix."] },
  ],
  extra_terms: null,
};

const DETAIL = {
  ...CARD,
  status: "live",
  landing_url: "https://speaksix.example/start",
  agreement: AGREEMENT,
  agreement_sha256: "a".repeat(64),
};

// The same card as the database sends it now that a program can pay for events.
const SALES_CARD = { ...CARD, earn_from: "sales", rewards: [] };

const SIGNUP = {
  key: "signup_completed",
  label: "Account created",
  amount_minor: 200,
};
const TRIAL = {
  key: "trial_started",
  label: "Trial started",
  amount_minor: 500,
};

// Pays for events only: no commission at all.
const EVENTS_CARD = {
  ...CARD,
  slug: "fluent",
  name: "Fluent",
  commission_type: null,
  commission_rate_bps: null,
  commission_fixed_minor: null,
  commission_duration: null,
  commission_months: null,
  earn_from: "events",
  rewards: [SIGNUP, TRIAL],
};

// Pays a commission and a reward.
const BOTH_CARD = {
  ...CARD,
  slug: "pocket-chef",
  name: "Pocket Chef",
  earn_from: "both",
  rewards: [SIGNUP],
};

const EVENTS_DETAIL = { ...DETAIL, ...EVENTS_CARD };

interface Fake {
  handler: (request: Request) => Promise<Response>;
  calls: string[];
  logs: MarketplaceLogEntry[];
}

function fake(
  store: Partial<MarketplaceStore> = {},
  enabled = true,
): Fake {
  const calls: string[] = [];
  const logs: MarketplaceLogEntry[] = [];
  const handler = createMarketplaceHandler({
    enabled: () => enabled,
    log: (entry) => logs.push(entry),
    store: () => ({
      list: () => {
        calls.push("list");
        return (store.list ?? (() => Promise.resolve({ programs: [CARD] })))();
      },
      detail: (slug) => {
        calls.push(`detail ${slug}`);
        return (store.detail ??
          ((asked: string) =>
            Promise.resolve({
              program: asked === "speaksix" ? DETAIL : null,
            })))(slug);
      },
    }),
  });
  return { handler, calls, logs };
}

function get(query = "", init: RequestInit = {}): Request {
  return new Request(
    `https://project.supabase.invalid/functions/v1/marketplace${query}`,
    init,
  );
}

function assertPublicError(response: Response, status: number): void {
  assertEquals(response.status, status);
  assertEquals(response.headers.get("cache-control"), "no-store, max-age=0");
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  assertEquals(response.headers.get("access-control-allow-credentials"), null);
  assertEquals(response.headers.get("set-cookie"), null);
}

Deno.test("the list answers the live programs, cacheable for a minute and readable from any site", async () => {
  const { handler, calls, logs } = fake();
  const response = await handler(get());
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "public, max-age=60");
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  assertEquals(response.headers.get("access-control-allow-credentials"), null);
  assertEquals(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(response.headers.get("set-cookie"), null);
  assertEquals(await response.json(), { programs: [CARD] });
  assertEquals(calls, ["list"]);
  assertEquals(logs, []);
});

Deno.test("an empty marketplace is an empty list, not an error", async () => {
  const { handler } = fake({ list: () => Promise.resolve({ programs: [] }) });
  const response = await handler(get());
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { programs: [] });
});

Deno.test("a program is answered by its slug with its agreement", async () => {
  const { handler, calls } = fake();
  const response = await handler(get("?slug=speaksix"));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "public, max-age=60");
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  assertEquals(await response.json(), { program: DETAIL });
  assertEquals(calls, ["detail speaksix"]);
});

Deno.test("a paused program is still answered, marked paused", async () => {
  const { handler } = fake({
    detail: () => Promise.resolve({ program: { ...DETAIL, status: "paused" } }),
  });
  const response = await handler(get("?slug=speaksix"));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).program.status, "paused");
});

Deno.test("only the public fields leave the function", async () => {
  const leaky = {
    ...DETAIL,
    id: "5d0c7f0e-27e5-4f4e-9d2f-0f7f1d9e1c11",
    workspace_id: "0b0f6a52-7a3e-4a43-9d5c-0f3f1f8f6f11",
    owner_email: "owner@speaksix.example",
    stripe_account_id: "acct_Private",
    agreement: {
      ...AGREEMENT,
      internal_note: "do not show",
      summary: [{ label: "Commission", value: "30%", private: true }],
      sections: [{ heading: "1", paragraphs: ["Text"], author: "someone" }],
    },
  };
  const { handler } = fake({
    list: () =>
      Promise.resolve({ programs: [leaky], total: 1, workspace_ids: ["x"] }),
    detail: () => Promise.resolve({ program: leaky, viewer: "nobody" }),
  });
  assertEquals(await (await handler(get())).json(), { programs: [CARD] });
  assertEquals(await (await handler(get("?slug=speaksix"))).json(), {
    program: {
      ...DETAIL,
      agreement: {
        ...AGREEMENT,
        summary: [{ label: "Commission", value: "30%" }],
        sections: [{ heading: "1", paragraphs: ["Text"] }],
      },
    },
  });
});

Deno.test("an unknown slug is not found, whether the database answers null or raises it", async () => {
  const answeredNull = fake();
  const first = await answeredNull.handler(get("?slug=nobody-here"));
  assertPublicError(first, 404);
  assertEquals((await first.json()).error, "not_found");
  assertEquals(answeredNull.calls, ["detail nobody-here"]);
  assertEquals(answeredNull.logs, []);

  const raised = fake({
    detail: () => Promise.reject(new DatabaseBoundaryError("P0002")),
  });
  const second = await raised.handler(get("?slug=nobody-here"));
  assertPublicError(second, 404);
  assertEquals((await second.json()).error, "not_found");
});

Deno.test("a slug that cannot be a program address is not found without asking the database", async () => {
  const { handler, calls } = fake();
  for (
    const query of [
      "?slug=",
      "?slug=Speaksix",
      "?slug=speak_six",
      "?slug=-speaksix",
      "?slug=speaksix-",
      "?slug=speak--six",
      "?slug=speak%20six",
      "?slug=speaksix%2Fadmin",
      "?slug=..%2F..%2Fetc",
      "?slug=%E7%8E%8B",
      "?slug=speaksix%00",
      `?slug=${"a".repeat(81)}`,
      "?slug=speaksix&slug=other",
    ]
  ) {
    const response = await handler(get(query));
    assertPublicError(response, 404);
    assertEquals((await response.json()).error, "not_found");
  }
  assertEquals(calls, []);
  // Exactly 80 characters is still a valid address.
  assertEquals(
    (await handler(get(`?slug=${"a".repeat(80)}`))).status,
    404,
  );
  assertEquals(calls, [`detail ${"a".repeat(80)}`]);
});

Deno.test("the marketplace answers nothing while it is switched off", async () => {
  const { handler, calls, logs } = fake({}, false);
  for (const query of ["", "?slug=speaksix"]) {
    const response = await handler(get(query));
    assertPublicError(response, 503);
    assertEquals((await response.json()).error, "marketplace_disabled");
  }
  assertEquals(calls, []);
  assertEquals(logs.map((entry) => entry.outcome), [
    "marketplace_disabled",
    "marketplace_disabled",
  ]);
});

Deno.test("the flag is on only when MARKETPLACE_ENABLED is exactly true", async () => {
  const previous = Deno.env.get("MARKETPLACE_ENABLED");
  const store = () => ({
    list: () => Promise.resolve({ programs: [] }),
    detail: () => Promise.resolve({ program: null }),
  });
  try {
    for (
      const [value, status] of [
        [undefined, 503],
        ["", 503],
        ["false", 503],
        ["TRUE", 503],
        ["1", 503],
        [" true", 503],
        ["true", 200],
      ] as const
    ) {
      if (value === undefined) Deno.env.delete("MARKETPLACE_ENABLED");
      else Deno.env.set("MARKETPLACE_ENABLED", value);
      const response = await createMarketplaceHandler({
        store,
        log: () => {},
      })(get());
      assertEquals(response.status, status);
      await response.body?.cancel();
    }
  } finally {
    if (previous === undefined) Deno.env.delete("MARKETPLACE_ENABLED");
    else Deno.env.set("MARKETPLACE_ENABLED", previous);
  }
});

Deno.test("only GET is served; a preflight is answered without touching the database", async () => {
  const { handler, calls } = fake();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
    const response = await handler(
      get("", {
        method,
        ...(method === "POST" || method === "PUT" || method === "PATCH"
          ? { body: "{}", headers: { "content-type": "application/json" } }
          : {}),
      }),
    );
    assertPublicError(response, 405);
    if (method !== "HEAD") {
      assertEquals((await response.json()).error, "method_not_allowed");
    }
  }
  const preflight = await handler(
    get("?slug=speaksix", {
      method: "OPTIONS",
      headers: {
        origin: "https://kissmyapps.dev",
        "access-control-request-method": "GET",
      },
    }),
  );
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get("access-control-allow-origin"), "*");
  assertEquals(
    preflight.headers.get("access-control-allow-methods"),
    "GET, OPTIONS",
  );
  assertEquals(preflight.headers.get("access-control-allow-credentials"), null);
  assertEquals(await preflight.text(), "");
  assertEquals(calls, []);
});

Deno.test("a preflight is answered even while the marketplace is off, so the browser can read the 503", async () => {
  const { handler } = fake({}, false);
  const preflight = await handler(get("", { method: "OPTIONS" }));
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get("access-control-allow-origin"), "*");
});

Deno.test("a database failure is a 503 that says nothing about the database", async () => {
  const { handler, logs } = fake({
    list: () => Promise.reject(new DatabaseBoundaryError("57014")),
    detail: () => Promise.reject(new DatabaseBoundaryError("42883")),
  });
  for (const query of ["", "?slug=speaksix"]) {
    const response = await handler(get(query));
    assertPublicError(response, 503);
    const body = await response.json();
    assertEquals(body.error, "database_boundary_error");
    assertEquals(Object.keys(body).sort(), ["error", "message", "request_id"]);
    assertEquals(JSON.stringify(body).includes("57014"), false);
    assertEquals(JSON.stringify(body).includes("42883"), false);
  }
  assertEquals(logs, [
    {
      level: "error",
      worker: "marketplace",
      outcome: "database_boundary_error",
      request_id: logs[0].request_id,
      database_code: "57014",
    },
    {
      level: "error",
      worker: "marketplace",
      outcome: "database_boundary_error",
      request_id: logs[1].request_id,
      database_code: "42883",
    },
  ]);
});

Deno.test("an unexpected failure is a 500 with no detail, and a throwing log sink changes nothing", async () => {
  const handler = createMarketplaceHandler({
    enabled: () => true,
    log: () => {
      throw new Error("log sink down");
    },
    store: () => ({
      list: () => Promise.reject(new Error("connection string leaked here")),
      detail: () => Promise.resolve({ program: null }),
    }),
  });
  const response = await handler(get());
  assertPublicError(response, 500);
  const body = await response.json();
  assertEquals(body.error, "internal_error");
  assertEquals(JSON.stringify(body).includes("leaked"), false);
});

Deno.test("an answer that is not the agreed shape is refused, never passed on", async () => {
  const wrongLists: unknown[] = [
    null,
    [],
    {},
    { programs: null },
    { programs: [CARD, { ...CARD, slug: "Not A Slug" }] },
    { programs: [{ ...CARD, commission_rate_bps: "3000" }] },
    { programs: [{ ...CARD, commission_type: "tiered" }] },
    { programs: [{ ...CARD, terms_version: 0 }] },
    { programs: [{ ...CARD, name: "" }] },
    { programs: ["speaksix"] },
  ];
  for (const answer of wrongLists) {
    const { handler, logs } = fake({ list: () => Promise.resolve(answer) });
    const response = await handler(get());
    assertPublicError(response, 503);
    assertEquals((await response.json()).error, "database_boundary_error");
    assertEquals(logs.length, 1);
    assertEquals(logs[0].database_code, undefined);
  }
  const wrongDetails: unknown[] = [
    null,
    {},
    { program: "speaksix" },
    { program: CARD },
    { program: { ...DETAIL, status: "archived" } },
    { program: { ...DETAIL, status: "draft" } },
    { program: { ...DETAIL, landing_url: "http://speaksix.example/start" } },
    { program: { ...DETAIL, landing_url: "javascript:alert(1)" } },
    { program: { ...DETAIL, agreement_sha256: "abc" } },
    { program: { ...DETAIL, agreement: null } },
    { program: { ...DETAIL, agreement: { ...AGREEMENT, sections: "none" } } },
    {
      program: {
        ...DETAIL,
        agreement: {
          ...AGREEMENT,
          sections: [{ heading: "1", paragraphs: [1] }],
        },
      },
    },
  ];
  for (const answer of wrongDetails) {
    const { handler } = fake({ detail: () => Promise.resolve(answer) });
    const response = await handler(get("?slug=speaksix"));
    assertPublicError(response, 503);
    assertEquals((await response.json()).error, "database_boundary_error");
  }
});

Deno.test("the list answers sales, events and both programs with what each pays", async () => {
  const cards = [SALES_CARD, EVENTS_CARD, BOTH_CARD];
  const { handler, logs } = fake({
    list: () => Promise.resolve({ programs: cards }),
  });
  const response = await handler(get());
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(await response.json(), { programs: cards });
  assertEquals(logs, []);
});

Deno.test("an events program is answered by its slug with no commission and its rewards", async () => {
  const { handler } = fake({
    detail: () => Promise.resolve({ program: EVENTS_DETAIL }),
  });
  const response = await handler(get("?slug=fluent"));
  assertEquals(response.status, 200);
  const { program } = await response.json();
  assertEquals(program, EVENTS_DETAIL);
  assertEquals(program.commission_type, null);
  assertEquals(program.rewards, [SIGNUP, TRIAL]);
});

Deno.test("an answer without earn_from and rewards, or with both null, is passed on as it always was", async () => {
  for (const card of [CARD, { ...CARD, earn_from: null, rewards: null }]) {
    const { handler } = fake({
      list: () => Promise.resolve({ programs: [card] }),
      detail: () => Promise.resolve({ program: { ...DETAIL, ...card } }),
    });
    assertEquals(await (await handler(get())).json(), { programs: [CARD] });
    assertEquals(await (await handler(get("?slug=speaksix"))).json(), {
      program: DETAIL,
    });
  }
});

Deno.test("only the three fields of a reward leave the function, and a label stays text", async () => {
  const label = "<img src=x onerror=alert(1)>";
  const leaky = {
    ...EVENTS_CARD,
    reward_budget_minor: 50000,
    rewards: [
      {
        ...SIGNUP,
        label: `  ${label} `,
        count: 41,
        person_id: "5d0c7f0e-27e5-4f4e-9d2f-0f7f1d9e1c11",
        event_id: "0b0f6a52-7a3e-4a43-9d5c-0f3f1f8f6f11",
      },
    ],
  };
  const { handler } = fake({
    list: () => Promise.resolve({ programs: [leaky] }),
  });
  const response = await handler(get());
  // JSON that a browser will not sniff as a page: the label is data.
  assertEquals(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(await response.json(), {
    programs: [{ ...EVENTS_CARD, rewards: [{ ...SIGNUP, label }] }],
  });
});

Deno.test("a reward at the limits is accepted: five rewards, a 40-character label, the largest amount", async () => {
  const rewards = Array.from({ length: 5 }, (_, index) => ({
    key: `step.${index}:done-ok_`,
    label: "é".repeat(40),
    amount_minor: index === 0 ? 1 : 100_000_000,
  }));
  const card = { ...EVENTS_CARD, rewards };
  const { handler } = fake({
    list: () => Promise.resolve({ programs: [card] }),
  });
  const response = await handler(get());
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { programs: [card] });
});

Deno.test("a card that does not say whole what it pays is refused, never passed on", async () => {
  const six = Array.from({ length: 6 }, (_, index) => ({
    ...SIGNUP,
    key: `event_${index}`,
  }));
  const wrongCards: Record<string, unknown>[] = [
    // Neither a commission nor a reward, in every shape.
    { ...CARD, commission_type: null },
    { ...CARD, commission_duration: null },
    { ...SALES_CARD, commission_type: null },
    { ...EVENTS_CARD, rewards: [] },
    { ...EVENTS_CARD, earn_from: "sales", rewards: [] },
    // A commission is null only for events, and events has none.
    { ...BOTH_CARD, commission_type: null },
    { ...BOTH_CARD, commission_duration: null },
    { ...EVENTS_CARD, commission_type: "percent" },
    { ...EVENTS_CARD, commission_rate_bps: 3000 },
    { ...EVENTS_CARD, commission_fixed_minor: 500 },
    { ...EVENTS_CARD, commission_duration: "lifetime" },
    { ...EVENTS_CARD, commission_months: 12 },
    { ...EVENTS_CARD, earn_from: null },
    { ...EVENTS_CARD, earn_from: undefined },
    // Rewards belong to events and both, and both needs one.
    { ...BOTH_CARD, rewards: [] },
    { ...SALES_CARD, rewards: [SIGNUP] },
    { ...SALES_CARD, rewards: null },
    { ...CARD, earn_from: "sales" },
    { ...CARD, rewards: [] },
    { ...EVENTS_CARD, earn_from: "installs" },
    { ...EVENTS_CARD, earn_from: ["events"] },
    // The list itself.
    { ...EVENTS_CARD, rewards: null },
    { ...EVENTS_CARD, rewards: "signup_completed" },
    { ...EVENTS_CARD, rewards: { 0: SIGNUP } },
    { ...EVENTS_CARD, rewards: six },
    // One reward.
    { ...EVENTS_CARD, rewards: [null] },
    { ...EVENTS_CARD, rewards: ["signup_completed"] },
    { ...EVENTS_CARD, rewards: [[SIGNUP]] },
    { ...EVENTS_CARD, rewards: [SIGNUP, { ...TRIAL, key: SIGNUP.key }] },
    ...[
      { key: undefined },
      { key: "" },
      { key: 7 },
      { key: "9lives" },
      { key: "sign up" },
      { key: "signup<script>" },
      { key: `a${"b".repeat(80)}` },
      { label: undefined },
      { label: "" },
      { label: "   " },
      { label: 200 },
      { label: "a".repeat(41) },
      { amount_minor: undefined },
      { amount_minor: null },
      { amount_minor: 0 },
      { amount_minor: -200 },
      { amount_minor: 199.5 },
      { amount_minor: "200" },
      { amount_minor: 100_000_001 },
    ].map((change) => ({
      ...EVENTS_CARD,
      rewards: [{ ...SIGNUP, ...change }],
    })),
  ];
  for (const card of wrongCards) {
    const { handler, logs } = fake({
      list: () => Promise.resolve({ programs: [SALES_CARD, card] }),
      detail: () => Promise.resolve({ program: { ...DETAIL, ...card } }),
    });
    for (const query of ["", "?slug=speaksix"]) {
      const response = await handler(get(query));
      assertPublicError(response, 503);
      const body = await response.json();
      assertEquals(body.error, "database_boundary_error", JSON.stringify(card));
      assertEquals(JSON.stringify(body).includes("signup"), false);
    }
    assertEquals(logs.length, 2);
  }
});

Deno.test("credentials, cookies and a request body are ignored and other query fields change nothing", async () => {
  const { handler, calls } = fake();
  const response = await handler(
    get("?utm_source=x&slug=speaksix&page=2", {
      headers: {
        authorization: "Bearer not-read",
        cookie: "kma_sid=not-read",
        apikey: "not-read",
      },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { program: DETAIL });
  assertEquals(response.headers.get("set-cookie"), null);
  assertEquals(response.headers.get("vary"), null);
  assertEquals(calls, ["detail speaksix"]);
});

Deno.test("the default store calls the two service-only database functions and nothing else", async () => {
  const names = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const previous = names.map((name) => Deno.env.get(name));
  const oldFetch = globalThis.fetch;
  const requests: { url: string; method: string; body: unknown }[] = [];
  let failNext = false;
  try {
    Deno.env.set("SUPABASE_URL", "https://marketplace-test.supabase.invalid");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-role-key");
    globalThis.fetch = (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (failNext) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ code: "42883", message: "no such function" }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith("/rpc/marketplace_programs")
              ? { programs: [CARD] }
              : { program: DETAIL },
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    };
    const logs: MarketplaceLogEntry[] = [];
    const handler = createMarketplaceHandler({
      enabled: () => true,
      log: (entry) => logs.push(entry),
    });
    assertEquals(await (await handler(get())).json(), { programs: [CARD] });
    assertEquals(await (await handler(get("?slug=speaksix"))).json(), {
      program: DETAIL,
    });
    assertEquals(requests.map((request) => request.url), [
      "https://marketplace-test.supabase.invalid/rest/v1/rpc/marketplace_programs",
      "https://marketplace-test.supabase.invalid/rest/v1/rpc/marketplace_program",
    ]);
    assertEquals(requests[1].body, { p_slug: "speaksix" });
    failNext = true;
    const failed = await handler(get());
    assertPublicError(failed, 503);
    assertEquals((await failed.json()).error, "database_boundary_error");
    assertEquals(logs.map((entry) => entry.database_code), ["42883"]);
  } finally {
    globalThis.fetch = oldFetch;
    names.forEach((name, index) =>
      previous[index] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, previous[index]!)
    );
  }
});

Deno.test("without database settings the function says it is not configured", async () => {
  const names = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEYS",
  ];
  const previous = names.map((name) => Deno.env.get(name));
  try {
    names.forEach((name) => Deno.env.delete(name));
    const logs: MarketplaceLogEntry[] = [];
    const response = await createMarketplaceHandler({
      enabled: () => true,
      log: (entry) => logs.push(entry),
    })(get());
    assertPublicError(response, 503);
    assertEquals((await response.json()).error, "configuration_error");
    assertEquals(logs.map((entry) => entry.outcome), ["configuration_error"]);
  } finally {
    names.forEach((name, index) =>
      previous[index] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, previous[index]!)
    );
  }
});
