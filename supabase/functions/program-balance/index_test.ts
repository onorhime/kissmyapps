import { assert, assertEquals, assertThrows } from "@std/assert";
import { ConfigurationError } from "../_shared/errors.ts";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";
import {
  balanceReturnUrls,
  programBalanceConfig,
  programBalanceEnabled,
} from "./config.ts";
import {
  CHECKOUT_LIFETIME_SECONDS,
  createProgramBalanceHandler,
  type ProgramBalanceDependencies,
  type ProgramBalanceLogEntry,
  verifiedIdentity,
} from "./index.ts";
import {
  BalanceStripe,
  cardOnlyParameter,
  failureCode,
  parseIntent,
  StripeCallError,
} from "./stripe.ts";
import {
  CONFIG,
  FakeStore,
  FakeStripe,
  fakeUuid,
  LIVE_KEY,
  ORIGIN,
  PLATFORM,
} from "./testing.ts";

const START = Date.UTC(2026, 10, 16, 12, 0, 0);
const URLS = balanceReturnUrls((name) =>
  name === "CONSOLE_CONNECT_ORIGIN" ? ORIGIN : undefined
);

function world(overrides: Partial<ProgramBalanceDependencies> = {}) {
  const clock = { now: START };
  const now = () => clock.now;
  const store = new FakeStore(now);
  const stripe = new FakeStripe(now);
  const people = {
    owner: fakeUuid(),
    admin: fakeUuid(),
    analyst: fakeUuid(),
    stranger: fakeUuid(),
  };
  const program = store.addProgram({ owner: people.owner });
  program.members.set(people.admin, "admin");
  program.members.set(people.analyst, "analyst");
  const logs: ProgramBalanceLogEntry[] = [];
  // Each person signs in with a session value of their own.
  const session = (who: keyof typeof people) => `Bearer ${who.padEnd(40, ".")}`;
  const handler = createProgramBalanceHandler({
    enabled: () => true,
    origin: () => ORIGIN,
    config: () => CONFIG,
    returnUrls: () => URLS,
    authenticate: (authorization) => {
      const who = (Object.keys(people) as (keyof typeof people)[]).find((k) =>
        session(k) === authorization
      );
      return who
        ? Promise.resolve({ userId: people[who] })
        : Promise.reject(new Error("unknown session"));
    },
    store: () => store,
    fetcher: stripe.fetch,
    random: () => "nonce-1",
    now,
    log: (entry) => logs.push(entry),
    ...overrides,
  });
  const post = async (
    who: keyof typeof people | null,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await handler(
      new Request("https://functions.example/program-balance", {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          ...(who ? { authorization: session(who) } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: await response.json(), response };
  };
  const deposit = (who: keyof typeof people, amount: unknown) =>
    post(who, {
      action: "deposit",
      workspace_id: program.workspaceId,
      amount_minor: amount,
    });
  const card = (who: keyof typeof people) =>
    post(who, { action: "card", workspace_id: program.workspaceId });
  return {
    clock,
    store,
    stripe,
    people,
    program,
    logs,
    handler,
    post,
    deposit,
    card,
  };
}

Deno.test("a first deposit opens the balance, makes the Stripe customer and answers with Stripe's hosted page", async () => {
  const w = world();
  const answer = await w.deposit("owner", 5000);
  assertEquals(answer.status, 200);
  assertEquals(Object.keys(answer.body), ["checkout_url"]);
  assert(answer.body.checkout_url.startsWith("https://checkout.stripe.com/"));
  assertEquals(
    answer.response.headers.get("access-control-allow-origin"),
    ORIGIN,
  );

  const account = w.store.accountOf(w.program);
  const [topup] = w.store.topupsOf(account);
  assertEquals(w.stripe.requests.map((r) => `${r.method} ${r.path}`), [
    "POST /v1/customers",
    "POST /v1/checkout/sessions",
  ]);
  for (const request of w.stripe.requests) {
    // The platform's own account, the pinned API version, the live key.
    assertEquals(request.account, null);
    assertEquals(request.version, STRIPE_API_VERSION);
    assertEquals(request.authorization, `Bearer ${LIVE_KEY}`);
  }

  // The customer is the business. No person's name or email is sent.
  const [customer, session] = w.stripe.requests;
  assertEquals(customer.params, {
    name: "SpeakSix Ltd",
    "metadata[kma_account_id]": account.id,
    "metadata[kma_program_id]": w.program.id,
    "metadata[kma_workspace_id]": w.program.workspaceId,
  });
  assertEquals(customer.idempotencyKey, `kma-balance-customer-${account.id}`);
  assertEquals(account.customerId, "cus_Fake1");

  const p = session.params;
  assertEquals(session.idempotencyKey, `kma-topup-${topup.id}-checkout`);
  assertEquals(p.mode, "payment");
  assertEquals(p.customer, "cus_Fake1");
  assertEquals(p.client_reference_id, topup.id);
  assertEquals(p["payment_method_types[0]"], "card");
  assertEquals(p["line_items[0][quantity]"], "1");
  assertEquals(p["line_items[0][price_data][unit_amount]"], "5000");
  assertEquals(p["line_items[0][price_data][currency]"], "usd");
  // The card is saved for automatic top-ups.
  assertEquals(p["payment_intent_data[setup_future_usage]"], "off_session");
  assertEquals(p["payment_intent_data[metadata][kma_topup_id]"], topup.id);
  assertEquals(p["metadata[kma_topup_id]"], topup.id);
  assertEquals(p["metadata[kma_kind]"], "deposit");
  assertEquals(p["metadata[kma_program_id]"], w.program.id);
  assertEquals(p["metadata[kma_workspace_id]"], w.program.workspaceId);
  // Back to the console's Balance page, from configuration.
  assertEquals(p.success_url, `${ORIGIN}/#balance?deposit=done`);
  assertEquals(p.cancel_url, `${ORIGIN}/#balance?deposit=canceled`);
  assertEquals(
    p.expires_at,
    String(START / 1000 + CHECKOUT_LIFETIME_SECONDS),
  );
  // No card data and no personal data is ever sent from here.
  for (const key of Object.keys({ ...customer.params, ...p })) {
    assert(!/email|phone|number|cvc|exp_/.test(key), key);
  }

  // The top-up waits for Stripe. Nothing was added to the balance here.
  assertEquals(topup.status, "processing");
  assertEquals(topup.sessionId, "cs_live_Fake2");
  assertEquals(topup.amountMinor, 5000);
  assertEquals(account.availableMinor, 0);
  assertEquals(w.store.entries, []);
  assertEquals(w.logs.map((l) => l.outcome), ["deposit_started"]);
});

Deno.test("a second deposit reuses the customer and ends the unpaid page of the first", async () => {
  const w = world();
  await w.deposit("owner", 5000);
  const answer = await w.deposit("admin", 7500);
  assertEquals(answer.status, 200);
  const account = w.store.accountOf(w.program);
  const [first, second] = w.store.topupsOf(account);
  assertEquals([first.status, first.failureCode], ["canceled", "superseded"]);
  assertEquals([second.status, second.amountMinor], ["processing", 7500]);
  assertEquals(w.stripe.posts(/customers$/).length, 1);
  const [expire] = w.stripe.posts(/expire$/);
  assertEquals(expire.path, `/v1/checkout/sessions/${first.sessionId}/expire`);
  assertEquals(expire.idempotencyKey, `kma-topup-${first.id}-expire`);
  assertEquals(w.stripe.sessions.get(first.sessionId!)?.status, "expired");
  assert(answer.body.checkout_url.endsWith(second.sessionId!));
});

Deno.test("an old page that cannot be ended does not stop the new deposit", async () => {
  const w = world();
  await w.deposit("owner", 5000);
  w.stripe.intercept = (r) =>
    r.path.endsWith("/expire") ? "network" : undefined;
  const answer = await w.deposit("owner", 6000);
  assertEquals(answer.status, 200);
  assert(w.logs.some((l) => l.outcome === "old_checkout_not_expired"));
});

Deno.test("a card change makes a setup page that charges nothing", async () => {
  const w = world();
  const account = w.store.addFundedAccount(w.program);
  const answer = await w.card("admin");
  assertEquals(answer.status, 200);
  assertEquals(Object.keys(answer.body), ["checkout_url"]);
  assert(answer.body.checkout_url.startsWith("https://checkout.stripe.com/"));
  assertEquals(w.stripe.requests.length, 1);
  const [request] = w.stripe.requests;
  assertEquals(request.path, "/v1/checkout/sessions");
  assertEquals(
    request.idempotencyKey,
    `kma-balance-card-${account.id}-nonce-1`,
  );
  const p = request.params;
  assertEquals(p.mode, "setup");
  assertEquals(p.customer, "cus_FakeFunded");
  assertEquals(p.currency, "usd");
  assertEquals(p["payment_method_types[0]"], "card");
  assertEquals(p["metadata[kma_kind]"], "card");
  assertEquals(p["metadata[kma_account_id]"], account.id);
  assertEquals(p["setup_intent_data[metadata][kma_account_id]"], account.id);
  assertEquals(p.success_url, `${ORIGIN}/#balance?card=done`);
  assertEquals(p.cancel_url, `${ORIGIN}/#balance?card=canceled`);
  assert(!Object.keys(p).some((k) => k.startsWith("line_items")));
  // No top-up is made and the saved card is untouched until Stripe confirms.
  assertEquals(w.store.topups.size, 0);
  assertEquals(account.card?.payment_method_id, "pm_FakeSaved");
});

Deno.test("a card change before any deposit is refused without calling Stripe", async () => {
  const w = world();
  const answer = await w.card("owner");
  assertEquals([answer.status, answer.body.error], [
    409,
    "balance_not_started",
  ]);
  assertEquals(w.stripe.requests, []);
  assertEquals(w.store.accounts.size, 0);
});

Deno.test("only an owner or admin of the workspace may add funds or change the card", async () => {
  const w = world();
  w.store.addFundedAccount(w.program);
  for (
    const [who, status, code] of [
      ["analyst", 403, "owner_or_admin_required"],
      ["stranger", 403, "not_a_member"],
    ] as const
  ) {
    for (const answer of [await w.deposit(who, 5000), await w.card(who)]) {
      assertEquals([answer.status, answer.body.error], [status, code]);
      assertEquals(typeof answer.body.request_id, "string");
      assertEquals(answer.body.checkout_url, undefined);
    }
  }
  assertEquals(w.stripe.requests, []);
  assertEquals(w.store.topups.size, 0);
});

Deno.test("switched off: no database call, no Stripe call, and the key is not read", async () => {
  const w = world({
    enabled: () => false,
    config: () => {
      throw new Error("the configuration was read");
    },
  });
  for (
    const answer of [await w.deposit("owner", 5000), await w.card("owner")]
  ) {
    assertEquals(
      [answer.status, answer.body.error],
      [503, "program_balance_disabled"],
    );
  }
  assertEquals(w.store.calls, []);
  assertEquals(w.stripe.requests, []);
  assertEquals(programBalanceEnabled(() => "TRUE"), false);
  assertEquals(programBalanceEnabled(() => "true"), true);
  assertEquals(programBalanceEnabled(() => undefined), false);
});

Deno.test("an amount out of bounds is refused before anything is made at Stripe", async () => {
  const w = world();
  for (
    const amount of [4999, 0, -5000, 50.5, "5000", null, 100_000_001, 1e21]
  ) {
    const answer = await w.deposit("owner", amount);
    assertEquals(
      [answer.status, answer.body.error],
      [400, "invalid_amount_minor"],
      String(amount),
    );
  }
  assertEquals(w.stripe.requests, []);
  assertEquals(w.store.topups.size, 0);

  // After a deposit has landed, later deposits may be as small as 10.00.
  const account = w.store.addFundedAccount(
    w.store.addProgram({ owner: w.people.owner }),
  );
  w.store.entries.push({
    accountId: account.id,
    kind: "deposit",
    amountMinor: 5000,
    topupId: fakeUuid(),
  });
  const later = (amount: number) =>
    w.post("owner", {
      action: "deposit",
      workspace_id: account.workspaceId,
      amount_minor: amount,
    });
  assertEquals((await later(999)).body.error, "invalid_amount_minor");
  assertEquals((await later(1000)).status, 200);
  assertEquals((await later(100_000_000)).status, 200);
});

Deno.test("when Stripe fails, no page is answered and the top-up is closed", async () => {
  const cases: [
    (path: string) => Response | "network" | "lost" | void,
    number,
    string,
  ][] = [
    [() => "network", 502, "stripe_unavailable"],
    [() => "lost", 502, "stripe_unavailable"],
    [() => new Response("{}", { status: 500 }), 502, "stripe_unavailable"],
    [
      () => new Response("not json", { status: 200 }),
      502,
      "stripe_unavailable",
    ],
    [
      () =>
        new Response(
          JSON.stringify({
            error: { code: "parameter_unknown", message: "x" },
          }),
          { status: 400 },
        ),
      502,
      "stripe_rejected",
    ],
    [() => new Response("{}", { status: 401 }), 503, "configuration_error"],
    // Anything but Stripe's own hosted page is never handed to a browser.
    [
      () =>
        Response.json({
          id: "cs_live_Elsewhere",
          livemode: true,
          mode: "payment",
          customer: "cus_FakeFunded",
          url: "https://checkout.stripe.com.evil.example/c/pay/cs_live_x",
        }),
      502,
      "stripe_unavailable",
    ],
    [
      () =>
        Response.json({
          id: "cs_live_Elsewhere",
          livemode: true,
          mode: "payment",
          customer: "cus_FakeFunded",
          url: "http://checkout.stripe.com/c/pay/cs_live_x",
        }),
      502,
      "stripe_unavailable",
    ],
    // Nor is an address with somebody's name in front of the host, or a port after it.
    ...[
      "https://someone@checkout.stripe.com/c/pay/cs_live_x",
      "https://checkout.stripe.com:8443/c/pay/cs_live_x",
    ].map((url): [(path: string) => Response, number, string] => [
      () =>
        Response.json({
          id: "cs_live_Elsewhere",
          livemode: true,
          mode: "payment",
          customer: "cus_FakeFunded",
          url,
        }),
      502,
      "stripe_unavailable",
    ]),
    // A page that is not live means the key is not what it claims to be.
    [
      () =>
        Response.json({
          id: "cs_test_Elsewhere",
          livemode: false,
          mode: "payment",
          customer: "cus_FakeFunded",
          url: "https://checkout.stripe.com/c/pay/cs_test_x",
        }),
      503,
      "configuration_error",
    ],
  ];
  for (const [reply, status, code] of cases) {
    const w = world();
    const account = w.store.addFundedAccount(w.program);
    w.stripe.intercept = (r) =>
      r.path === "/v1/checkout/sessions" ? reply(r.path) : undefined;
    const answer = await w.deposit("owner", 5000);
    assertEquals([answer.status, answer.body.error], [status, code]);
    assertEquals(answer.body.checkout_url, undefined);
    assert(!JSON.stringify(answer.body).includes("evil"));
    const [topup] = w.store.topupsOf(account);
    assertEquals(
      [topup.status, topup.failureCode],
      ["canceled", "checkout_not_created"],
    );
    assertEquals(account.availableMinor, 0);
  }
});

Deno.test("when the customer cannot be made, nothing else is started", async () => {
  const w = world();
  w.stripe.intercept = () => new Response("{}", { status: 503 });
  const answer = await w.deposit("owner", 5000);
  assertEquals([answer.status, answer.body.error], [502, "stripe_unavailable"]);
  assertEquals(w.store.topups.size, 0);
  assertEquals(w.store.accountOf(w.program).customerId, null);
  // The same account asks again with the same key: Stripe makes one customer.
  w.stripe.intercept = () => {};
  assertEquals((await w.deposit("owner", 5000)).status, 200);
  assertEquals(
    new Set(w.stripe.posts(/customers$/).map((r) => r.idempotencyKey)).size,
    1,
  );
});

Deno.test("what the database refuses is passed on as its own code", async () => {
  const w = world();
  w.store.moneyEnabled = false;
  let answer = await w.deposit("owner", 5000);
  assertEquals(
    [answer.status, answer.body.error],
    [409, "program_money_disabled"],
  );
  w.store.moneyEnabled = true;

  const nobody = fakeUuid();
  answer = await w.post("owner", {
    action: "deposit",
    workspace_id: nobody,
    amount_minor: 5000,
  });
  assertEquals([answer.status, answer.body.error], [403, "not_a_member"]);

  const account = w.store.addFundedAccount(w.program, { currency: "EUR" });
  answer = await w.deposit("owner", 5000);
  assertEquals([answer.status, answer.body.error], [409, "currency_mismatch"]);
  account.currency = "USD";
  account.platformAccountId = "acct_Another";
  answer = await w.deposit("owner", 5000);
  assertEquals([answer.status, answer.body.error], [409, "platform_mismatch"]);
  account.platformAccountId = PLATFORM;

  w.store.down.add("begin_program_deposit");
  answer = await w.deposit("owner", 5000);
  assertEquals(
    [answer.status, answer.body.error],
    [503, "database_boundary_error"],
  );
  assertEquals(w.stripe.requests, []);
});

Deno.test("requests that are not the console's are refused", async () => {
  const w = world();
  const good = {
    action: "deposit",
    workspace_id: w.program.workspaceId,
    amount_minor: 5000,
  };
  const refused: [
    string | null,
    unknown,
    Record<string, string>,
    number,
    string,
  ][] = [
    [
      "owner",
      good,
      { origin: "https://elsewhere.example" },
      403,
      "origin_rejected",
    ],
    [null, good, {}, 401, "unauthorized"],
    ["owner", { ...good, extra: 1 }, {}, 400, "invalid_input"],
    [
      "owner",
      { action: "deposit", workspace_id: good.workspace_id },
      {},
      400,
      "invalid_input",
    ],
    ["owner", { ...good, action: "withdraw" }, {}, 400, "invalid_input"],
    [
      "owner",
      { ...good, workspace_id: "not-a-workspace" },
      {},
      400,
      "invalid_input",
    ],
    [
      "owner",
      { action: "card", workspace_id: good.workspace_id, amount_minor: 1 },
      {},
      400,
      "invalid_input",
    ],
    ["owner", [good], {}, 400, "invalid_input"],
    [
      "owner",
      good,
      { "content-type": "text/plain" },
      415,
      "unsupported_media_type",
    ],
  ];
  for (const [who, body, headers, status, code] of refused) {
    const answer = await w.post(who as "owner" | null, body, headers);
    assertEquals([answer.status, answer.body.error], [status, code]);
  }
  const preflight = await w.handler(
    new Request("https://functions.example/program-balance", {
      method: "OPTIONS",
      headers: { origin: ORIGIN },
    }),
  );
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get("access-control-allow-origin"), ORIGIN);
  const get = await w.handler(
    new Request("https://functions.example/program-balance", {
      headers: { origin: ORIGIN },
    }),
  );
  assertEquals(get.status, 405);
  assertEquals(w.store.calls, []);
  assertEquals(w.stripe.requests, []);
});

Deno.test("only a signed-in person with a confirmed email is let in", () => {
  const user = {
    id: "0B000000-0000-4000-8000-000000000001",
    email: "owner@speaksix.example",
    email_confirmed_at: "2026-01-01T00:00:00Z",
  };
  assertEquals(verifiedIdentity(user), {
    userId: "0b000000-0000-4000-8000-000000000001",
  });
  for (
    const bad of [
      null,
      { ...user, email_confirmed_at: null },
      { ...user, is_anonymous: true },
      { ...user, id: "nobody" },
      { ...user, email: "" },
    ]
  ) assertThrows(() => verifiedIdentity(bad));
});

Deno.test("live keys only", async () => {
  const env = (key: string) => (name: string) =>
    ({
      CONSOLE_CONNECT_STRIPE_SECRET: key,
      CONSOLE_CONNECT_PLATFORM_ACCOUNT: PLATFORM,
    })[name];
  assertEquals(programBalanceConfig(env(` ${LIVE_KEY} `)), CONFIG);
  const restricted = ["rk", "live", "FakeRestricted0000000"].join("_");
  assertEquals(programBalanceConfig(env(restricted)).secret, restricted);
  for (
    const key of [
      ["sk", "test", "FakeBalanceKey0000000000"].join("_"),
      ["rk", "test", "FakeBalanceKey0000000000"].join("_"),
      ["pk", "live", "FakeBalanceKey0000000000"].join("_"),
      "",
      "live",
    ]
  ) assertThrows(() => programBalanceConfig(env(key)), ConfigurationError);
  assertThrows(
    () =>
      programBalanceConfig((name) =>
        name === "CONSOLE_CONNECT_STRIPE_SECRET" ? LIVE_KEY : "not-an-account"
      ),
    ConfigurationError,
  );

  // A key that is not live stops the request before the database or Stripe.
  const w = world({
    config: () =>
      programBalanceConfig(
        env(["sk", "test", "FakeBalanceKey00000000"].join("_")),
      ),
  });
  const answer = await w.deposit("owner", 5000);
  assertEquals([answer.status, answer.body.error], [
    503,
    "configuration_error",
  ]);
  assertEquals(w.store.calls, []);
  assertEquals(w.stripe.requests, []);
});

Deno.test("return addresses come from the configured console origin only", () => {
  assertEquals(URLS, {
    depositDone: `${ORIGIN}/#balance?deposit=done`,
    depositCanceled: `${ORIGIN}/#balance?deposit=canceled`,
    cardDone: `${ORIGIN}/#balance?card=done`,
    cardCanceled: `${ORIGIN}/#balance?card=canceled`,
  });
  assertThrows(() => balanceReturnUrls(() => undefined), ConfigurationError);
  assertThrows(
    () => balanceReturnUrls(() => "http://merchant.kissmyapps.example"),
    ConfigurationError,
  );
});

Deno.test("the parameter that limits Checkout to cards follows the pinned API version", async () => {
  assertEquals(cardOnlyParameter(), "payment_method_types[0]");
  assertEquals(
    cardOnlyParameter("2026-02-25.clover"),
    "payment_method_types[0]",
  );
  assertEquals(
    cardOnlyParameter("2026-09-30.endive"),
    "allowed_payment_method_types[0]",
  );
  assertEquals(
    cardOnlyParameter("2026-10-28.endive"),
    "allowed_payment_method_types[0]",
  );
  const stripe = new FakeStripe(() => START);
  const later = new BalanceStripe(LIVE_KEY, {
    fetcher: stripe.fetch,
    version: "2026-10-28.endive",
  });
  const topup = {
    topupId: fakeUuid(),
    accountId: fakeUuid(),
    programId: fakeUuid(),
    workspaceId: fakeUuid(),
    customerId: "cus_FakeFunded",
    amountMinor: 5000,
    currency: "USD",
  };
  await later.createDepositSession(topup, {
    programName: "SpeakSix",
    successUrl: URLS.depositDone,
    cancelUrl: URLS.depositCanceled,
    expiresAt: 1,
  });
  await later.chargeSavedCard(topup, "pm_FakeSaved");
  const [session, charge] = stripe.requests;
  assertEquals(session.version, "2026-10-28.endive");
  assertEquals(session.params["allowed_payment_method_types[0]"], "card");
  assertEquals(session.params["payment_method_types[0]"], undefined);
  assertEquals(charge.params["automatic_payment_methods[enabled]"], undefined);
});

Deno.test("every POST to Stripe carries an Idempotency-Key", async () => {
  const w = world();
  await w.deposit("owner", 5000);
  await w.deposit("owner", 5000);
  await w.card("owner");
  const posts = w.stripe.requests.filter((r) => r.method === "POST");
  assertEquals(posts.length, 5);
  for (const request of posts) {
    assert(request.idempotencyKey?.startsWith("kma-"), request.path);
  }
  assertEquals(new Set(posts.map((r) => r.idempotencyKey)).size, 5);
});

Deno.test("a failed charge keeps Stripe's decline code, except the ones Stripe asks to hide", () => {
  assertEquals(
    failureCode("card_declined", "insufficient_funds"),
    "insufficient_funds",
  );
  assertEquals(failureCode("card_declined", "do_not_honor"), "do_not_honor");
  assertEquals(failureCode("card_declined", undefined), "card_declined");
  assertEquals(failureCode("expired_card", undefined), "expired_card");
  assertEquals(
    failureCode("authentication_required", "authentication_required"),
    "authentication_required",
  );
  assertEquals(failureCode("expired_card", "expired_card"), "expired_card");
  for (
    const hidden of ["fraudulent", "lost_card", "stolen_card", "pickup_card"]
  ) {
    assertEquals(failureCode("card_declined", hidden), "card_declined");
  }
  assertEquals(failureCode(undefined, undefined), "card_declined");
  assertEquals(failureCode("Not A Code", { a: 1 }), "card_declined");
});

Deno.test("a PaymentIntent is read strictly, and a card counts only when saved on the paying customer", () => {
  const body = {
    id: "pi_FakeRead",
    object: "payment_intent",
    livemode: true,
    status: "succeeded",
    amount: 5000,
    amount_received: 5000,
    currency: "usd",
    customer: { id: "cus_FakeFunded" },
    metadata: { kma_topup_id: "00000000-0000-4000-8000-0000000000aa" },
    payment_method: {
      id: "pm_FakeRead",
      type: "card",
      customer: "cus_FakeFunded",
      card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2031 },
    },
    latest_charge: { id: "ch_FakeRead", amount_refunded: 1200 },
    last_payment_error: null,
  };
  assertEquals(parseIntent(body), {
    id: "pi_FakeRead",
    livemode: true,
    status: "succeeded",
    amountMinor: 5000,
    receivedMinor: 5000,
    currency: "USD",
    customerId: "cus_FakeFunded",
    topupId: "00000000-0000-4000-8000-0000000000aa",
    card: {
      payment_method_id: "pm_FakeRead",
      brand: "visa",
      last4: "4242",
      exp_month: 4,
      exp_year: 2031,
    },
    refundedMinor: 1200,
    failureCode: null,
  });
  // A card of another customer, or one that is not saved, is not taken.
  for (const customer of ["cus_Another", null]) {
    assertEquals(
      parseIntent({
        ...body,
        payment_method: { ...body.payment_method, customer },
      }).card,
      null,
    );
  }
  assertEquals(
    parseIntent({ ...body, payment_method: "pm_FakeRead" }).card,
    null,
  );
  assertEquals(
    parseIntent({ ...body, metadata: { kma_topup_id: "x" } }).topupId,
    null,
  );
  for (
    const broken of [
      null,
      { ...body, object: "charge" },
      { ...body, amount: "5000" },
      { ...body, amount: -1 },
      { ...body, livemode: "true" },
      { ...body, id: "ch_NotAnIntent" },
      { ...body, latest_charge: { amount_refunded: 1.5 } },
    ]
  ) assertThrows(() => parseIntent(broken), StripeCallError);
});
