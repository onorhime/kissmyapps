// deno-lint-ignore-file require-await -- Fake adapters keep production async boundaries.
import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  ConfigurationError,
  DatabaseBoundaryError,
} from "../_shared/errors.ts";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";
import {
  checkoutIdempotencyKey,
  checkoutSessionParams,
  clickFromQuery,
  createProgramCheckout,
  handleProgramCheckout,
  isPreview,
  type ProgramCheckoutDependencies,
  type ProgramCheckoutLogEntry,
  programKeyFromPath,
} from "./index.ts";
import { MARKETPLACE_URL, priceText } from "./pages.ts";
import { type CheckoutTarget, parseTarget } from "./target.ts";

type Json = Record<string, unknown>;

const NOW = Date.parse("2026-11-21T12:00:30Z");
// Not a key: the fake Stripe below is the only thing that ever sees it.
const KEY = "sk_live_" + "K".repeat(24);
const MERCHANT = "acct_MerchantA";
const CLICK = "c1".repeat(20);
const PROMO = "promo_Anna10Fixture";
const BASE = "https://project.example.invalid/program-checkout/checkout";
const BROWSER =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const SUCCESS =
  "https://fluent.example.test/welcome?session={CHECKOUT_SESSION_ID}";
const CANCEL = "https://fluent.example.test/pricing";
const STRIPE_PAGE = "https://checkout.stripe.com/c/pay/cs_live_1#fragment";

function answer(over: Json = {}, product: Json = {}): Json {
  return {
    ok: true,
    account_id: MERCHANT,
    currency: "USD",
    product: {
      name: "Fluent Pro",
      amount_minor: 999,
      interval: "month",
      ...product,
    },
    success_url: SUCCESS,
    cancel_url: CANCEL,
    click: CLICK,
    promotion_code_id: PROMO,
    program_name: "Fluent",
    buyer_discount_bps: 1000,
    ...over,
  };
}

interface SeenPost {
  url: string;
  method: string;
  headers: Headers;
  params: [string, string][];
  redirect: string | undefined;
  timed: boolean;
}

/** A merchant's Stripe account that makes Checkout Sessions. */
class FakeStripe {
  readonly posts: SeenPost[] = [];
  /** Answers by call number: a status, "network", or a session override. */
  readonly answers: (number | "network" | Json)[] = [];

  readonly fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const params = [...new URLSearchParams(String(init?.body ?? ""))];
    this.posts.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      params,
      redirect: init?.redirect,
      timed: init?.signal instanceof AbortSignal,
    });
    const planned = this.answers[this.posts.length - 1];
    if (planned === "network") throw new TypeError("connection reset");
    if (typeof planned === "number") {
      return Response.json({
        error: {
          type: "invalid_request_error",
          code: planned === 400 ? "promotion_code_invalid" : undefined,
          message: "Sensitive Stripe message about buyer@private.example",
        },
      }, { status: planned });
    }
    const mode = params.find(([k]) => k === "mode")?.[1];
    return Response.json({
      id: "cs_live_1",
      object: "checkout.session",
      livemode: true,
      mode,
      url: STRIPE_PAGE,
      ...(planned ?? {}),
    });
  };
}

interface Fixture {
  stripe: FakeStripe;
  targets: Json[];
  logs: ProgramCheckoutLogEntry[];
  get: (
    path: string,
    init?: { agent?: string | null; method?: string; headers?: Json },
  ) => Promise<Response>;
}

function fixture(
  target: unknown | ((input: Json) => unknown) = answer(),
  deps: Partial<ProgramCheckoutDependencies> = {},
): Fixture {
  const stripe = new FakeStripe();
  const targets: Json[] = [];
  const logs: ProgramCheckoutLogEntry[] = [];
  let nonce = 0;
  const handler = createProgramCheckout({
    enabled: () => true,
    stripeKey: () => KEY,
    store: () => ({
      target: async (input) => {
        targets.push(input);
        if (target instanceof Error) throw target;
        return typeof target === "function" ? target(input) : target;
      },
    }),
    fetcher: stripe.fetcher,
    now: () => NOW,
    nonce: () => `nonce-${++nonce}`,
    log: (entry) => logs.push(entry),
    ...deps,
  });
  return {
    stripe,
    targets,
    logs,
    get: (path, init = {}) => {
      const headers = new Headers(init.headers as Record<string, string>);
      if (init.agent !== null) headers.set("user-agent", init.agent ?? BROWSER);
      return handler(
        new Request(`${BASE}${path}`, {
          method: init.method ?? "GET",
          headers,
        }),
      );
    },
  };
}

function assertQuiet(f: Fixture): void {
  const logged = JSON.stringify(f.logs);
  for (const value of [KEY, CLICK, PROMO, MERCHANT, "buyer@private.example"]) {
    assert(!logged.includes(value), `logged: ${value}`);
  }
}

function assertPageHeaders(response: Response): void {
  assertEquals(response.headers.get("cache-control"), "no-store, max-age=0");
  assertEquals(
    response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive",
  );
  assertEquals(response.headers.get("referrer-policy"), "no-referrer");
  assertMatch(
    response.headers.get("content-security-policy") ?? "",
    /default-src 'none'/,
  );
}

Deno.test("off unless the flag is exactly true: a page, no database call, no Stripe call", async () => {
  for (const value of [undefined, "", "TRUE", "1", "yes"]) {
    const f = fixture(answer(), {
      enabled: () => value === "true",
    });
    const response = await f.get(`/fluent-pro?kma_click=${CLICK}`);
    assertEquals(response.status, 503);
    assertMatch(await response.text(), /Checkout is not available right now/);
    assertEquals(f.targets, []);
    assertEquals(f.stripe.posts, []);
  }
  const previous = Deno.env.get("PROGRAM_CHECKOUT_ENABLED");
  Deno.env.delete("PROGRAM_CHECKOUT_ENABLED");
  try {
    const response = await handleProgramCheckout(
      new Request(`${BASE}/fluent-pro`, { headers: { "user-agent": BROWSER } }),
    );
    assertEquals(response.status, 503);
    await response.body?.cancel();
  } finally {
    if (previous !== undefined) {
      Deno.env.set("PROGRAM_CHECKOUT_ENABLED", previous);
    }
  }
});

Deno.test("a person's click opens a subscription checkout on the merchant's account with the creator's code", async () => {
  const f = fixture();
  const response = await f.get(`/fluent-pro?kma_click=${CLICK}`);
  assertEquals(response.status, 303);
  assertEquals(response.headers.get("location"), STRIPE_PAGE);
  assertPageHeaders(response);
  assertEquals(f.targets, [{ program: "fluent-pro", click: CLICK }]);
  assertEquals(f.stripe.posts.length, 1);
  const post = f.stripe.posts[0];
  assertEquals(post.url, "https://api.stripe.com/v1/checkout/sessions");
  assertEquals(post.method, "POST");
  assertEquals(post.headers.get("authorization"), `Bearer ${KEY}`);
  assertEquals(post.headers.get("stripe-account"), MERCHANT);
  assertEquals(post.headers.get("stripe-version"), STRIPE_API_VERSION);
  assertEquals(
    post.headers.get("content-type"),
    "application/x-www-form-urlencoded",
  );
  assertMatch(
    post.headers.get("idempotency-key") ?? "",
    /^kma-checkout-[0-9a-f]{64}$/,
  );
  assertEquals(post.redirect, "error");
  assertEquals(post.timed, true);
  assertEquals(post.params, [
    ["mode", "subscription"],
    ["line_items[0][quantity]", "1"],
    ["line_items[0][price_data][currency]", "usd"],
    ["line_items[0][price_data][unit_amount]", "999"],
    ["line_items[0][price_data][product_data][name]", "Fluent Pro"],
    ["line_items[0][price_data][recurring][interval]", "month"],
    ["client_reference_id", `kma_${CLICK}`],
    ["metadata[kma_click]", CLICK],
    ["subscription_data[metadata][kma_click]", CLICK],
    ["discounts[0][promotion_code]", PROMO],
    ["success_url", SUCCESS],
    ["cancel_url", CANCEL],
  ]);
  assertEquals(f.logs.map((entry) => entry.outcome), ["session_created"]);
  assertQuiet(f);
});

Deno.test("a one-time product is a payment checkout, tagged on the PaymentIntent too", async () => {
  const f = fixture(answer({}, { interval: null, amount_minor: 4900 }));
  const response = await f.get(`/fluent-pro?kma_click=${CLICK}`);
  assertEquals(response.status, 303);
  const params = f.stripe.posts[0].params;
  assertEquals(params[0], ["mode", "payment"]);
  assert(!params.some(([k]) => k.includes("recurring")));
  assert(!params.some(([k]) => k.startsWith("subscription_data")));
  assert(
    params.some(([k, v]) =>
      k === "payment_intent_data[metadata][kma_click]" && v === CLICK
    ),
  );
  assert(
    params.some(([k, v]) =>
      k === "line_items[0][price_data][unit_amount]" &&
      v === "4900"
    ),
  );
});

Deno.test("without the creator's own code, a program with a discount offers the code field; one without offers none", async () => {
  const withField = fixture(answer({ promotion_code_id: null }));
  await withField.get(`/fluent-pro?kma_click=${CLICK}`);
  const fieldParams = withField.stripe.posts[0].params;
  assert(
    fieldParams.some(([k, v]) => k === "allow_promotion_codes" && v === "true"),
  );
  assert(!fieldParams.some(([k]) => k.startsWith("discounts")));

  for (const over of [{ buyer_discount_bps: null }, {}]) {
    const plain = answer({ promotion_code_id: null, ...over });
    if (!("buyer_discount_bps" in over)) delete plain.buyer_discount_bps;
    const f = fixture(plain);
    await f.get(`/fluent-pro?kma_click=${CLICK}`);
    const params = f.stripe.posts[0].params;
    assert(!params.some(([k]) => k === "allow_promotion_codes"));
    assert(!params.some(([k]) => k.startsWith("discounts")));
  }
});

Deno.test("no click: no tag, and every buyer gets a session of their own", async () => {
  const f = fixture(answer({ click: null, promotion_code_id: null }));
  await f.get("/fluent-pro");
  await f.get("/fluent-pro");
  assertEquals(f.targets, [
    { program: "fluent-pro", click: null },
    { program: "fluent-pro", click: null },
  ]);
  for (const post of f.stripe.posts) {
    assert(
      !post.params.some(([k]) =>
        k === "client_reference_id" || k.includes("kma_click")
      ),
    );
  }
  assert(
    f.stripe.posts[0].headers.get("idempotency-key") !==
      f.stripe.posts[1].headers.get("idempotency-key"),
  );
});

Deno.test("the same click within a minute opens the same session; a minute later a new one", async () => {
  const target = parseTarget(answer()) as CheckoutTarget;
  const first = await checkoutIdempotencyKey(target, "fluent-pro", NOW, "a");
  assertEquals(
    await checkoutIdempotencyKey(target, "fluent-pro", NOW + 20_000, "b"),
    first,
  );
  assert(
    await checkoutIdempotencyKey(target, "fluent-pro", NOW + 60_000, "a") !==
      first,
  );
  assert(
    await checkoutIdempotencyKey(target, "other-program", NOW, "a") !== first,
  );
  // The key never shows the click or the account.
  assert(!first.includes(CLICK) && !first.includes(MERCHANT));
});

Deno.test("link previews, bots, prefetches and HEAD get a page and never a session", async () => {
  const agents = [
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Twitterbot/1.0",
    "WhatsApp/2.23.20.0",
    "TelegramBot (like TwitterBot)",
    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    "curl/8.4.0",
    "python-requests/2.31",
  ];
  for (const agent of agents) {
    const f = fixture();
    const response = await f.get(`/fluent-pro?kma_click=${CLICK}`, { agent });
    assertEquals(response.status, 200, agent);
    const page = await response.text();
    assertMatch(page, /<h1>Fluent<\/h1>/);
    assertMatch(page, /Fluent Pro, \$9\.99 a month/);
    assertMatch(
      page,
      new RegExp(`href="\\?kma_click=${CLICK}&amp;go=1" rel="nofollow"`),
    );
    assertMatch(page, /Continue to checkout/);
    assertEquals(f.stripe.posts, [], agent);
  }
  const quiet = fixture();
  for (
    const init of [
      { agent: null },
      { headers: { "sec-purpose": "prefetch;prerender" } },
      { headers: { purpose: "prefetch" } },
    ]
  ) {
    const response = await quiet.get(`/fluent-pro?kma_click=${CLICK}`, init);
    assertEquals(response.status, 200);
    await response.body?.cancel();
  }
  const head = await quiet.get(`/fluent-pro?kma_click=${CLICK}&go=1`, {
    method: "HEAD",
  });
  assertEquals(head.status, 200);
  assertEquals(head.body, null);
  assertEquals(head.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(quiet.stripe.posts, []);
});

Deno.test("go=1 from the page opens the checkout even for an in-app browser that looks like a preview", async () => {
  const f = fixture();
  const response = await f.get(`/fluent-pro?kma_click=${CLICK}&go=1`, {
    agent: "Mozilla/5.0 (iPhone) AppleWebKit Mobile LinkedInApp",
  });
  assertEquals(response.status, 303);
  assertEquals(f.stripe.posts.length, 1);
});

Deno.test("a program that cannot sell says so plainly and links to the marketplace", async () => {
  const cases: [string, number, RegExp][] = [
    ["not_found", 404, /This checkout link does not work/],
    ["not_live", 404, /This checkout is not open/],
    ["paused", 503, /This checkout is paused/],
    ["no_connection", 503, /This checkout is paused/],
  ];
  for (const [reason, status, heading] of cases) {
    const f = fixture({ ok: false, reason });
    const response = await f.get(`/fluent-pro?kma_click=${CLICK}`);
    assertEquals(response.status, status, reason);
    assertPageHeaders(response);
    const page = await response.text();
    assertMatch(page, heading);
    assert(page.includes(`href="${MARKETPLACE_URL}"`));
    assert(!/test mode/i.test(page));
    assertEquals(f.stripe.posts, []);
  }
});

Deno.test("a path that is not a program key is not found without asking the database", async () => {
  for (
    const path of [
      "",
      "/",
      "/Fluent-Pro",
      "/a",
      "/fluent-pro/extra",
      "/fluent_pro",
      "/%E2%82%AC",
    ]
  ) {
    const f = fixture();
    const response = await f.get(path);
    assertEquals(response.status, 404, path);
    await response.body?.cancel();
    assertEquals(f.targets, [], path);
  }
  assertEquals(
    programKeyFromPath("/program-checkout/checkout/fluent-pro"),
    "fluent-pro",
  );
  assertEquals(
    programKeyFromPath("/program-checkout/fluent-pro"),
    "fluent-pro",
  );
  assertEquals(
    programKeyFromPath("/functions/v1/program-checkout/checkout/fluent-pro/"),
    "fluent-pro",
  );
  assertEquals(
    programKeyFromPath(
      "/program-checkout/checkout/0b0e0f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
    ),
    "0b0e0f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
  );
  assertEquals(programKeyFromPath("/program-checkout/checkout/a-"), null);
});

Deno.test("only one well formed click is passed on; anything else is no click", () => {
  const at = (query: string) =>
    clickFromQuery(new URL(`https://x.example.invalid/c/p${query}`));
  assertEquals(at(`?kma_click=${CLICK}`), CLICK);
  assertEquals(at(""), null);
  assertEquals(at("?kma_click=short"), null);
  assertEquals(at(`?kma_click=${CLICK}&kma_click=${CLICK}`), null);
  assertEquals(at("?kma_click=" + "a".repeat(129)), null);
  assertEquals(at("?kma_click=%3Cscript%3E" + "a".repeat(20)), null);
});

Deno.test("an answer that is not the agreed shape, or a database error, opens nothing", async () => {
  const broken: unknown[] = [
    null,
    [],
    { ok: false, reason: "who_knows" },
    answer({ account_id: "acct_" }),
    answer({ currency: "dollars" }),
    answer({ success_url: "http://fluent.example.test/" }),
    answer({ cancel_url: "https://user:pw@fluent.example.test/" }),
    answer({ success_url: "https://fluent.example.test/a b" }),
    answer({ click: "short" }),
    answer({ promotion_code_id: "coupon_1" }),
    answer({ buyer_discount_bps: 9500 }),
    answer({}, { amount_minor: 0 }),
    answer({}, { amount_minor: 9.5 }),
    answer({}, { interval: "week" }),
    answer({}, { name: "" }),
    new DatabaseBoundaryError("57014"),
  ];
  for (const target of broken) {
    const f = fixture(target);
    const response = await f.get(`/fluent-pro?kma_click=${CLICK}`);
    assertEquals(response.status, 503, JSON.stringify(target));
    assertMatch(await response.text(), /The checkout could not open/);
    assertEquals(f.stripe.posts, []);
    assertEquals(f.logs[0].outcome, "database_unavailable");
  }
});

Deno.test("Stripe failures show a page to try again and log only a code", async () => {
  const cases: [number | "network" | Json, string, string][] = [
    [401, "stripe_key_rejected", "error"],
    [403, "stripe_account_denied", "warning"],
    [500, "stripe_unavailable", "warning"],
    [429, "stripe_unavailable", "warning"],
    ["network", "stripe_unreachable", "warning"],
    [{ livemode: false }, "stripe_unreadable", "warning"],
    [
      { url: "http://checkout.stripe.com/c/pay/cs_live_1" },
      "stripe_unreadable",
      "warning",
    ],
    [
      { url: "https://user@checkout.stripe.com/x" },
      "stripe_unreadable",
      "warning",
    ],
    [{ id: "pi_1" }, "stripe_unreadable", "warning"],
    [{ mode: "payment" }, "stripe_unreadable", "warning"],
  ];
  for (const [planned, outcome, level] of cases) {
    const f = fixture(answer({ promotion_code_id: null }));
    f.stripe.answers.push(planned);
    const response = await f.get(`/fluent-pro?kma_click=${CLICK}`);
    assertEquals(response.status, 503, outcome);
    const page = await response.text();
    assertMatch(page, /Try again/);
    assert(page.includes(`href="?kma_click=${CLICK}&amp;go=1"`));
    assertEquals(
      f.logs.map((entry) => [entry.outcome, entry.level]),
      [[outcome, level]],
    );
    assertQuiet(f);
  }
  const misconfigured = fixture(answer(), {
    stripeKey: () => {
      throw new ConfigurationError();
    },
  });
  const response = await misconfigured.get(`/fluent-pro?kma_click=${CLICK}`);
  assertEquals(response.status, 503);
  await response.body?.cancel();
  assertEquals(misconfigured.logs[0].outcome, "configuration_error");
  assertEquals(misconfigured.stripe.posts, []);
});

Deno.test("a code Stripe refuses does not stop the sale: the checkout opens with a code field instead", async () => {
  const f = fixture();
  f.stripe.answers.push(400);
  const response = await f.get(`/fluent-pro?kma_click=${CLICK}`);
  assertEquals(response.status, 303);
  assertEquals(f.stripe.posts.length, 2);
  const [first, second] = f.stripe.posts;
  assert(first.params.some(([k]) => k === "discounts[0][promotion_code]"));
  assert(!second.params.some(([k]) => k.startsWith("discounts")));
  assert(second.params.some(([k]) => k === "allow_promotion_codes"));
  assertEquals(
    second.headers.get("idempotency-key"),
    `${first.headers.get("idempotency-key")}-plain`,
  );
  assertEquals(f.logs.map((entry) => entry.outcome), [
    "promotion_code_refused",
    "session_created",
  ]);
});

Deno.test("only GET and HEAD are answered", async () => {
  const f = fixture();
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await f.get(`/fluent-pro?kma_click=${CLICK}`, { method });
    assertEquals(response.status, 405, method);
    assertEquals(response.headers.get("allow"), "GET, HEAD");
    await response.body?.cancel();
  }
  assertEquals(f.targets, []);
});

Deno.test("names from the database are escaped on the page", async () => {
  const f = fixture(
    answer({ program_name: '<script>alert("x")</script>' }, {
      name: "Pro & <b>more</b>",
    }),
  );
  const page = await (await f.get(`/fluent-pro?kma_click=${CLICK}`, {
    agent: "Twitterbot/1.0",
  })).text();
  assert(!page.includes("<script>"));
  assert(!page.includes("<b>"));
  assertMatch(page, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assertMatch(page, /Pro &amp; &lt;b&gt;more&lt;\/b&gt;/);
});

Deno.test("prices read as major units with the currency symbol", () => {
  const product = (amountMinor: number, interval: "month" | "year" | null) => ({
    name: "Fluent Pro",
    amountMinor,
    interval,
  });
  assertEquals(priceText(product(999, "month"), "usd"), "$9.99 a month");
  assertEquals(priceText(product(4900, "year"), "eur"), "€49.00 a year");
  assertEquals(priceText(product(1200, null), "jpy"), "¥1,200");
});

Deno.test("previews are told apart from people by their user agent and purpose", () => {
  const request = (headers: Record<string, string>) =>
    new Request("https://x.example.invalid/", { headers });
  assertEquals(isPreview(request({ "user-agent": BROWSER })), false);
  assertEquals(
    isPreview(request({
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    })),
    false,
  );
  assertEquals(isPreview(request({})), true);
  assertEquals(isPreview(request({ "user-agent": "x" })), true);
  assertEquals(
    isPreview(request({ "user-agent": BROWSER, "sec-purpose": "prefetch" })),
    true,
  );
});

Deno.test("the session fields follow the target exactly", () => {
  const target = parseTarget(
    answer({}, { interval: "year" }),
  ) as CheckoutTarget;
  const params = checkoutSessionParams(target);
  assert(
    params.some(([k, v]) =>
      k === "line_items[0][price_data][recurring][interval]" && v === "year"
    ),
  );
  // The success address keeps Stripe's placeholder as written.
  assert(params.some(([k, v]) => k === "success_url" && v === SUCCESS));
});
