// deno-lint-ignore-file require-await -- Fake adapters keep production async boundaries.
import { assert, assertEquals } from "@std/assert";
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";
import {
  BATCH_SIZE,
  type ClaimedReceipt,
  createProgramSalesWorker,
  FEE_ATTEMPTS,
  handleProgramSalesWorker,
  LEASE_SECONDS,
  MAX_BATCHES,
  programSalesConfig,
  type ProgramSalesLogEntry,
  type ProgramSalesStore,
  type ProgramSalesWorkerDependencies,
  SHORT_RETRY_SECONDS,
  WORK_BUDGET_MS,
} from "./index.ts";

type Json = Record<string, unknown>;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const PAID_AT = Math.floor(NOW / 1000) - 90;
const PLATFORM = "acct_KMAPlatform";
const MERCHANT = "acct_MerchantA";
// Not a key: the fake Stripe below is the only thing that ever sees it.
const KEY = "sk_live_FixtureOnlyNotAKey";
const URL_ = "https://functions.example/program-sales-worker";
const CLICK = "a1".repeat(24);
const OTHER_CLICK = "b2".repeat(24);

// Everything the worker must never log, return or hand to a finish call.
const SENSITIVE = [
  "Jane Private",
  "buyer@private.example",
  "receipt@private.example",
  "customer@private.example",
  "+15555550100",
  "1 Hidden Lane",
  "4242",
  "fp_CardFingerprint",
  "vip note about Jane",
  "Sensitive Stripe message",
  KEY,
];
const person = {
  name: "Jane Private",
  email: "buyer@private.example",
  phone: "+15555550100",
  address: { line1: "1 Hidden Lane", postal_code: "90210", country: "US" },
};

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SeenRequest {
  method: string;
  path: string;
  query: string;
  account: string | null;
  authorization: string | null;
  version: string | null;
  redirect: string | undefined;
  timed: boolean;
}

/**
 * A connected account's objects, stored the way Stripe returns them without
 * expansion: references are ids. `expand[]` replaces an id with its object.
 */
class FakeStripe {
  readonly requests: SeenRequest[] = [];
  readonly failures = new Map<string, number | "network" | "garbage">();
  private readonly byId = new Map<string, Json>();
  private readonly paths = new Map<string, string>();
  private static readonly PATHS: Record<string, string> = {
    payment_intent: "/v1/payment_intents/",
    charge: "/v1/charges/",
    "checkout.session": "/v1/checkout/sessions/",
    invoice: "/v1/invoices/",
    refund: "/v1/refunds/",
    dispute: "/v1/disputes/",
  };

  add(...objects: Json[]): this {
    for (const object of objects) {
      const id = String(object.id);
      this.byId.set(id, object);
      const prefix = FakeStripe.PATHS[String(object.object)];
      if (prefix) this.paths.set(prefix + id, id);
    }
    return this;
  }

  private expand(target: unknown, parts: string[]): void {
    if (!isObject(target) || parts.length === 0) return;
    const [head, ...rest] = parts;
    if (head === "data" && Array.isArray(target.data)) {
      for (const item of target.data) this.expand(item, rest);
      return;
    }
    if (Array.isArray(target[head])) {
      // A list of ids or objects (an invoice's discounts): ids become objects.
      const list = target[head] as unknown[];
      for (const [index, item] of list.entries()) {
        if (typeof item === "string" && this.byId.has(item)) {
          list[index] = structuredClone(this.byId.get(item));
        }
        this.expand(list[index], rest);
      }
      return;
    }
    const value = target[head];
    if (typeof value === "string" && this.byId.has(value)) {
      target[head] = structuredClone(this.byId.get(value));
    }
    this.expand(target[head], rest);
  }

  readonly fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    this.requests.push({
      method,
      path: url.pathname,
      query: decodeURIComponent(url.search),
      account: headers.get("stripe-account"),
      authorization: headers.get("authorization"),
      version: headers.get("stripe-version"),
      redirect: init?.redirect,
      timed: init?.signal instanceof AbortSignal,
    });
    if (
      method !== "GET" || init?.body != null ||
      url.origin !== "https://api.stripe.com"
    ) throw new Error("the worker may only GET from api.stripe.com");
    const failure = this.failures.get(url.pathname);
    if (failure === "network") throw new TypeError("connection reset");
    if (failure === "garbage") return new Response("<html>", { status: 200 });
    if (typeof failure === "number") {
      return Response.json({
        error: { message: "Sensitive Stripe message buyer@private.example" },
      }, { status: failure });
    }
    let body: Json | undefined;
    if (url.pathname === "/v1/invoice_payments") {
      body = {
        object: "list",
        has_more: false,
        data: [...this.byId.values()].filter((entry) =>
          entry.object === "invoice_payment" &&
          entry.invoice === url.searchParams.get("invoice") &&
          entry.status === url.searchParams.get("status")
        ),
      };
    } else {
      const id = this.paths.get(url.pathname);
      body = id ? this.byId.get(id) : undefined;
    }
    if (!body) {
      return Response.json({ error: { code: "resource_missing" } }, {
        status: 404,
      });
    }
    const answer = structuredClone(body);
    for (const path of url.searchParams.getAll("expand[]")) {
      this.expand(answer, path.split("."));
    }
    return Response.json(answer);
  };

  /** Paths requested, in order, with their expansions. */
  get reads(): string[] {
    return this.requests.map((request) => request.path + request.query);
  }
}

/** A succeeded live card payment: PaymentIntent, charge and settled fee. */
function payment(
  n: string,
  over: { intent?: Json; charge?: Json; balance?: Json | null } = {},
): Json[] {
  const settled = over.balance !== null;
  return [
    ...(settled
      ? [{
        id: `txn_${n}`,
        object: "balance_transaction",
        amount: 4900,
        fee: 172,
        net: 4728,
        currency: "usd",
        ...over.balance,
      }]
      : []),
    {
      id: `ch_${n}`,
      object: "charge",
      livemode: true,
      paid: true,
      status: "succeeded",
      amount: 4900,
      amount_captured: 4900,
      amount_refunded: 0,
      currency: "usd",
      payment_intent: `pi_${n}`,
      created: PAID_AT,
      balance_transaction: settled ? `txn_${n}` : null,
      billing_details: person,
      receipt_email: null,
      payment_method_details: {
        card: { last4: "4242", fingerprint: "fp_CardFingerprint" },
      },
      ...over.charge,
    },
    {
      id: `pi_${n}`,
      object: "payment_intent",
      livemode: true,
      status: "succeeded",
      amount: 4900,
      amount_received: 4900,
      currency: "usd",
      customer: null,
      latest_charge: `ch_${n}`,
      receipt_email: null,
      shipping: person,
      metadata: { internal: "vip note about Jane" },
      ...over.intent,
    },
  ];
}

function session(n: string, over: Json = {}): Json {
  return {
    id: `cs_live_${n}`,
    object: "checkout.session",
    livemode: true,
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: 4900,
    currency: "usd",
    payment_intent: `pi_${n}`,
    invoice: null,
    subscription: null,
    customer: null,
    client_reference_id: null,
    customer_email: null,
    customer_details: person,
    total_details: { amount_tax: 400, amount_discount: 0 },
    metadata: { internal: "vip note about Jane" },
    ...over,
  };
}

/** A paid subscription invoice and the one payment that paid it. */
function invoice(n: string, intent: string, over: Json = {}): Json[] {
  return [{
    id: `in_${n}`,
    object: "invoice",
    livemode: true,
    status: "paid",
    amount_paid: 4900,
    currency: "usd",
    billing_reason: "subscription_create",
    customer: "cus_Buyer1",
    customer_email: person.email,
    customer_name: person.name,
    customer_address: person.address,
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: `sub_${n}`, metadata: {} },
    },
    total_taxes: [{ amount: 300 }, { amount: 100 }],
    metadata: {},
    ...over,
  }, {
    id: `inpay_${n}`,
    object: "invoice_payment",
    livemode: true,
    status: "paid",
    amount_paid: 4900,
    currency: "usd",
    invoice: `in_${n}`,
    payment: { type: "payment_intent", payment_intent: intent },
  }];
}

function receipt(
  type: string,
  object: string,
  over: Partial<ClaimedReceipt> = {},
): ClaimedReceipt {
  return {
    event_id: `evt_${type.replaceAll(".", "_")}_${object}`,
    event_type: type,
    account_id: MERCHANT,
    object_id: object,
    payment_intent_id: object.startsWith("pi_") ? object : null,
    amount_minor: 4900,
    currency: "USD",
    event_created: PAID_AT + 2,
    attempts: 1,
    lease_token: "10000000-0000-4000-8000-000000000001",
    ...over,
  };
}

interface Fixture {
  stripe: FakeStripe;
  claims: Json[];
  sales: Json[];
  events: Json[];
  finished: Json[];
  logs: ProgramSalesLogEntry[];
  run: () => Promise<{ status: number; body: Json }>;
}

function fixture(
  receipts: ClaimedReceipt[],
  options: {
    stripe?: FakeStripe;
    sale?: (input: Json) => Json;
    event?: (input: Json) => Json;
    finish?: (input: Json) => Json;
    claimed?: { skipped: number; failed: number };
    deps?: Partial<ProgramSalesWorkerDependencies>;
  } = {},
): Fixture {
  const stripe = options.stripe ?? new FakeStripe();
  const queue = [...receipts];
  const claims: Json[] = [], sales: Json[] = [], events: Json[] = [];
  const finished: Json[] = [], logs: ProgramSalesLogEntry[] = [];
  const store: ProgramSalesStore = {
    claim: async (input) => {
      claims.push(input);
      return {
        receipts: queue.splice(0, Number(input.limit)),
        skipped: claims.length === 1 ? options.claimed?.skipped ?? 0 : 0,
        failed: claims.length === 1 ? options.claimed?.failed ?? 0 : 0,
      };
    },
    recordSale: async (input) => {
      sales.push(input);
      return options.sale?.(input) ?? { recorded: true, created: true };
    },
    recordSaleEvent: async (input) => {
      events.push(input);
      return options.event?.(input) ?? { recorded: true, new_events: 1 };
    },
    finish: async (input) => {
      finished.push(input);
      return options.finish?.(input) ?? {
        state: input.action === "done"
          ? "done"
          : input.action === "release"
          ? "released"
          : "retry",
      };
    },
  };
  const handler = createProgramSalesWorker({
    enabled: () => true,
    authenticate: () => {},
    config: () => ({ secret: KEY, platformAccountId: PLATFORM }),
    store: () => store,
    fetcher: stripe.fetcher,
    now: () => NOW,
    log: (entry) => logs.push(entry),
    ...options.deps,
  });
  return {
    stripe,
    claims,
    sales,
    events,
    finished,
    logs,
    run: async () => {
      const response = await handler(new Request(URL_, { method: "POST" }));
      return { status: response.status, body: await response.json() };
    },
  };
}

/** The finish calls as "event id: action code". */
function outcomes(f: Fixture): string[] {
  return f.finished.map((call) =>
    `${call.event_id}: ${call.action} ${call.code}` +
    (call.delay_seconds ? ` in ${call.delay_seconds}s` : "")
  );
}

const reference = (r: ClaimedReceipt) => ({
  platform_account_id: PLATFORM,
  event_id: r.event_id,
  lease_token: r.lease_token,
});

function assertNothingSensitive(f: Fixture, body: Json): void {
  const quiet = JSON.stringify([f.logs, f.finished, f.claims, f.events, body]);
  // The buyer's email is handed to the sale call, in its own field, and nowhere else.
  const sales = JSON.stringify(
    f.sales.map(({ buyer_email: _email, ...rest }) => rest),
  );
  for (const secret of SENSITIVE) {
    assert(!quiet.includes(secret), `leaked: ${secret}`);
    assert(!sales.includes(secret), `stored: ${secret}`);
  }
}

Deno.test("only the exact value true turns the worker on; off, it touches nothing", async () => {
  const name = "PROGRAM_SALES_ENABLED";
  const previous = Deno.env.get(name);
  let touched = 0;
  const handler = createProgramSalesWorker({
    authenticate: () => {},
    config: () => {
      touched += 1;
      return { secret: KEY, platformAccountId: PLATFORM };
    },
    store: () => {
      touched += 1;
      throw new Error("the store must not be opened while off");
    },
    fetcher: async () => {
      touched += 1;
      return new Response("{}");
    },
    log: () => {},
  });
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "yes"]) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
      const response = await handler(new Request(URL_, { method: "POST" }));
      assertEquals(response.status, 200, String(value));
      const body = await response.json();
      assertEquals(body.enabled, false);
      assertEquals(body.claimed, 0);
    }
    assertEquals(touched, 0);
    Deno.env.set(name, "true");
    // On: the store is opened (and this fake refuses).
    assertEquals(
      (await handler(new Request(URL_, { method: "POST" }))).status,
      500,
    );
    assertEquals(touched, 2);
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
});

Deno.test("the schedule and the webhook nudge each need their own secret", async () => {
  const names = ["INTERNAL_WORKER_SECRET", "PROGRAM_SALES_SCHEDULER_SECRET"];
  const previous = names.map((name) => Deno.env.get(name));
  const worker = "worker-secret-fixture-0000000000000000000";
  const scheduler = "scheduler-secret-fixture-000000000000000";
  Deno.env.set(names[0], worker);
  Deno.env.set(names[1], scheduler);
  const store: ProgramSalesStore = {
    claim: async () => ({ receipts: [], skipped: 0, failed: 0 }),
    recordSale: async () => ({}),
    recordSaleEvent: async () => ({}),
    finish: async () => ({}),
  };
  const handler = createProgramSalesWorker({
    enabled: () => true,
    config: () => ({ secret: KEY, platformAccountId: PLATFORM }),
    store: () => store,
    log: () => {},
  });
  const call = (headers: Record<string, string>, method = "POST") =>
    handler(new Request(URL_, { method, headers }));
  try {
    assertEquals((await call({ "x-kma-worker-secret": worker })).status, 200);
    assertEquals(
      (await call({ "x-kma-scheduler-secret": scheduler })).status,
      200,
    );
    for (
      const headers of [
        {},
        { "x-kma-worker-secret": "" },
        { "x-kma-worker-secret": scheduler },
        { "x-kma-scheduler-secret": worker },
        { "x-kma-worker-secret": worker.slice(0, -1) },
        { "x-kma-worker-secret": worker, origin: "https://evil.example" },
        { authorization: `Bearer ${worker}` },
      ] as Record<string, string>[]
    ) {
      const response = await call(headers);
      assertEquals(response.status, 401, JSON.stringify(Object.keys(headers)));
      assertEquals((await response.json()).error, "unauthorized");
    }
    assertEquals(
      (await call({ "x-kma-worker-secret": worker }, "GET")).status,
      405,
    );
    // A secret that is unset or short opens nothing, even to an empty header.
    Deno.env.set(names[0], "short");
    assertEquals((await call({ "x-kma-worker-secret": "short" })).status, 401);
    Deno.env.delete(names[0]);
    assertEquals((await call({ "x-kma-worker-secret": "" })).status, 401);
    // The exported handler is closed too.
    assertEquals(
      (await handleProgramSalesWorker(new Request(URL_, { method: "POST" })))
        .status,
      401,
    );
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) Deno.env.delete(name);
      else Deno.env.set(name, previous[index]!);
    });
  }
});

Deno.test("only a live platform secret key and account are accepted", async () => {
  const env = (values: Record<string, string>) => (name: string) =>
    values[name];
  assertEquals(
    programSalesConfig(env({
      CONSOLE_CONNECT_STRIPE_SECRET: ` ${KEY} `,
      CONSOLE_CONNECT_PLATFORM_ACCOUNT: PLATFORM,
    })),
    { secret: KEY, platformAccountId: PLATFORM },
  );
  for (
    const values of [
      {},
      { CONSOLE_CONNECT_STRIPE_SECRET: KEY },
      { CONSOLE_CONNECT_PLATFORM_ACCOUNT: PLATFORM },
      {
        CONSOLE_CONNECT_STRIPE_SECRET: "sk_test_FixtureOnlyNotAKey",
        CONSOLE_CONNECT_PLATFORM_ACCOUNT: PLATFORM,
      },
      {
        CONSOLE_CONNECT_STRIPE_SECRET: "rk_live_FixtureOnlyNotAKey",
        CONSOLE_CONNECT_PLATFORM_ACCOUNT: PLATFORM,
      },
      {
        CONSOLE_CONNECT_STRIPE_SECRET: KEY,
        CONSOLE_CONNECT_PLATFORM_ACCOUNT: "not-an-account",
      },
    ] as Record<string, string>[]
  ) {
    let refused = false;
    try {
      programSalesConfig(env(values));
    } catch {
      refused = true;
    }
    assert(refused, JSON.stringify(Object.keys(values)));
  }
  // A worker that is on without its key claims nothing and says so.
  const f = fixture([receipt("payment_intent.succeeded", "pi_1")], {
    deps: { config: () => programSalesConfig(env({})) },
  });
  const { status, body } = await f.run();
  assertEquals(status, 503);
  assertEquals(body.error, "configuration_error");
  assertEquals(f.claims.length, 0);
  assertEquals(f.stripe.requests.length, 0);
});

Deno.test("a one-off PaymentIntent tagged in its metadata becomes a sale in one read", async () => {
  const r = receipt("payment_intent.succeeded", "pi_1");
  const f = fixture([r]);
  f.stripe.add(
    ...payment("1", {
      intent: {
        customer: "cus_Buyer1",
        metadata: { kma_click: CLICK, internal: "vip note about Jane" },
        amount_details: { tax: { total_tax_amount: 350 } },
      },
    }),
    { id: "cus_Buyer1", object: "customer", email: "customer@private.example" },
  );
  const { status, body } = await f.run();
  assertEquals(status, 200);
  assertEquals(body, {
    status: "processed",
    worker: "program-sales-worker",
    enabled: true,
    claimed: 1,
    recorded: 1,
    skipped: 0,
    retried: 0,
    failed: 0,
    released: 0,
    closed_unread: 0,
    request_id: body.request_id,
  });
  assertEquals(f.claims, [{
    platform_account_id: PLATFORM,
    limit: BATCH_SIZE,
    lease_seconds: LEASE_SECONDS,
  }]);
  assertEquals(f.stripe.reads, [
    "/v1/payment_intents/pi_1?expand[]=latest_charge.balance_transaction&expand[]=customer",
  ]);
  assertEquals(f.sales, [{
    ...reference(r),
    livemode: true,
    payment_intent_id: "pi_1",
    charge_id: "ch_1",
    checkout_session_id: null,
    invoice_id: null,
    subscription_id: null,
    customer_id: "cus_Buyer1",
    billing_reason: null,
    amount_minor: 4900,
    currency: "USD",
    tax_minor: 350,
    fee_minor: 172,
    fee_currency: "USD",
    refunded_minor: 0,
    paid_at: PAID_AT,
    kma_click: CLICK,
    tag_source: "metadata",
    buyer_email: "buyer@private.example",
  }]);
  assertEquals(f.finished, [{
    ...reference(r),
    action: "done",
    code: "recorded",
  }]);
  assertEquals(f.logs.map((entry) => entry.outcome), ["processed"]);
  assertNothingSensitive(f, body);
});

Deno.test("every Stripe request is a GET for the connected account with the pinned version and a timeout", async () => {
  const f = fixture([
    receipt("payment_intent.succeeded", "pi_1"),
    receipt("checkout.session.completed", "cs_live_2"),
    receipt("invoice.paid", "in_3"),
    receipt("refund.created", "re_4", { amount_minor: 1000 }),
    receipt("charge.refunded", "ch_1"),
    receipt("charge.dispute.created", "dp_5"),
  ]);
  f.stripe.add(
    ...payment("1"),
    ...payment("2"),
    session("2"),
    ...payment("3"),
    ...invoice("3", "pi_3"),
    {
      id: "re_4",
      object: "refund",
      amount: 1000,
      currency: "usd",
      status: "succeeded",
      charge: "ch_1",
      payment_intent: "pi_1",
      created: PAID_AT + 60,
    },
    {
      id: "dp_5",
      object: "dispute",
      livemode: true,
      amount: 4900,
      currency: "usd",
      status: "needs_response",
      charge: "ch_1",
      payment_intent: "pi_1",
      created: PAID_AT + 60,
    },
  );
  const { body } = await f.run();
  assertEquals(body.recorded, 6);
  assert(f.stripe.requests.length >= 7);
  for (const request of f.stripe.requests) {
    assertEquals(request.method, "GET");
    assertEquals(request.account, MERCHANT);
    assertEquals(request.authorization, `Bearer ${KEY}`);
    assertEquals(request.version, STRIPE_API_VERSION);
    assertEquals(request.redirect, "error");
    assertEquals(request.timed, true);
  }
});

Deno.test("a Checkout Session payment tagged by client_reference_id is read in one request", async () => {
  const r = receipt("checkout.session.completed", "cs_live_1");
  const f = fixture([r]);
  f.stripe.add(
    ...payment("1", { charge: { billing_details: { email: null } } }),
    session("1", {
      client_reference_id: `kma_${CLICK}`,
      customer: "cus_Buyer1",
    }),
  );
  const { body } = await f.run();
  assertEquals(f.stripe.reads, [
    "/v1/checkout/sessions/cs_live_1?expand[]=payment_intent.latest_charge.balance_transaction",
  ]);
  assertEquals(f.sales, [{
    ...reference(r),
    livemode: true,
    payment_intent_id: "pi_1",
    charge_id: "ch_1",
    checkout_session_id: "cs_live_1",
    invoice_id: null,
    subscription_id: null,
    customer_id: "cus_Buyer1",
    billing_reason: null,
    amount_minor: 4900,
    currency: "USD",
    tax_minor: 400,
    fee_minor: 172,
    fee_currency: "USD",
    refunded_minor: 0,
    paid_at: PAID_AT,
    // Sent as Stripe holds it: the database removes the prefix.
    kma_click: `kma_${CLICK}`,
    tag_source: "client_reference_id",
    buyer_email: "buyer@private.example",
  }]);
  assertEquals(outcomes(f), [`${r.event_id}: done recorded`]);
  assertNothingSensitive(f, body);
});

Deno.test("a tag in metadata wins over client_reference_id; a reference that is not a creator tag is ignored", async () => {
  const f = fixture([
    receipt("checkout.session.completed", "cs_live_1"),
    receipt("checkout.session.async_payment_succeeded", "cs_live_2"),
    receipt("checkout.session.completed", "cs_live_3"),
  ]);
  f.stripe.add(
    ...payment("1"),
    session("1", {
      client_reference_id: `kma_${CLICK}`,
      metadata: { kma_click: OTHER_CLICK },
    }),
    ...payment("2", { intent: { metadata: { kma_click: CLICK } } }),
    session("2", { metadata: { kma_click: OTHER_CLICK } }),
    ...payment("3", { intent: { metadata: { kma_click: "short" } } }),
    session("3", { client_reference_id: "order-2291-for-jane" }),
  );
  await f.run();
  assertEquals(
    f.sales.map((sale) => [sale.kma_click, sale.tag_source]),
    [[OTHER_CLICK, "metadata"], [CLICK, "metadata"], [null, null]],
  );
});

Deno.test("the three receipts of a subscription checkout resolve to one PaymentIntent", async () => {
  const receipts = [
    receipt("payment_intent.succeeded", "pi_1"),
    receipt("invoice.paid", "in_1", { payment_intent_id: null }),
    receipt("checkout.session.completed", "cs_live_1", {
      payment_intent_id: null,
    }),
  ];
  const f = fixture(receipts);
  f.stripe.add(
    ...payment("1", { intent: { customer: "cus_Buyer1" } }),
    ...invoice("1", "pi_1"),
    session("1", {
      mode: "subscription",
      payment_intent: null,
      invoice: "in_1",
      subscription: "sub_1",
      customer: "cus_Buyer1",
      client_reference_id: `kma_${CLICK}`,
    }),
  );
  const { body } = await f.run();
  assertEquals(body.recorded, 3);
  // Three reads for three receipts: the PaymentIntent and the invoice are read once.
  assertEquals(f.stripe.reads, [
    "/v1/payment_intents/pi_1?expand[]=latest_charge.balance_transaction&expand[]=customer",
    "/v1/invoice_payments?invoice=in_1&status=paid&limit=10&expand[]=data.invoice",
    "/v1/checkout/sessions/cs_live_1?expand[]=payment_intent.latest_charge.balance_transaction",
  ]);
  assertEquals(f.sales.map((sale) => sale.payment_intent_id), [
    "pi_1",
    "pi_1",
    "pi_1",
  ]);
  const shared = {
    livemode: true,
    payment_intent_id: "pi_1",
    charge_id: "ch_1",
    customer_id: "cus_Buyer1",
    amount_minor: 4900,
    currency: "USD",
    fee_minor: 172,
    fee_currency: "USD",
    refunded_minor: 0,
    paid_at: PAID_AT,
    buyer_email: "buyer@private.example",
  };
  assertEquals(f.sales, [
    {
      ...reference(receipts[0]),
      ...shared,
      checkout_session_id: null,
      invoice_id: null,
      subscription_id: null,
      billing_reason: null,
      tax_minor: null,
      kma_click: null,
      tag_source: null,
    },
    {
      ...reference(receipts[1]),
      ...shared,
      checkout_session_id: null,
      invoice_id: "in_1",
      subscription_id: "sub_1",
      billing_reason: "subscription_create",
      tax_minor: 400,
      kma_click: null,
      tag_source: null,
    },
    {
      ...reference(receipts[2]),
      ...shared,
      checkout_session_id: "cs_live_1",
      invoice_id: "in_1",
      subscription_id: "sub_1",
      billing_reason: "subscription_create",
      tax_minor: 400,
      kma_click: `kma_${CLICK}`,
      tag_source: "client_reference_id",
    },
  ]);
  assertEquals(
    outcomes(f),
    receipts.map((r) => `${r.event_id}: done recorded`),
  );
  assertNothingSensitive(f, body);
});

Deno.test("a subscription's first invoice carries the tag from the subscription's metadata", async () => {
  const f = fixture([receipt("invoice.paid", "in_1")]);
  f.stripe.add(
    ...payment("1"),
    ...invoice("1", "pi_1", {
      parent: {
        type: "subscription_details",
        subscription_details: {
          subscription: "sub_1",
          metadata: { kma_click: CLICK },
        },
      },
    }),
  );
  await f.run();
  assertEquals(f.stripe.reads, [
    "/v1/invoice_payments?invoice=in_1&status=paid&limit=10&expand[]=data.invoice",
    "/v1/payment_intents/pi_1?expand[]=latest_charge.balance_transaction&expand[]=customer",
  ]);
  assertEquals(f.sales.length, 1);
  assertEquals(
    [
      f.sales[0].invoice_id,
      f.sales[0].subscription_id,
      f.sales[0].billing_reason,
      f.sales[0].customer_id,
      f.sales[0].kma_click,
      f.sales[0].tag_source,
    ],
    ["in_1", "sub_1", "subscription_create", "cus_Buyer1", CLICK, "metadata"],
  );
});

Deno.test("a renewal invoice is recorded as a renewal of its subscription, with no tag of its own", async () => {
  const r = receipt("invoice.paid", "in_2", { amount_minor: 2900 });
  const f = fixture([r]);
  f.stripe.add(
    ...payment("2", {
      intent: { amount: 2900, amount_received: 2900, customer: "cus_Buyer1" },
      charge: {
        amount: 2900,
        amount_captured: 2900,
        billing_details: { email: null },
      },
      balance: { amount: 2900, fee: 114, net: 2786 },
    }),
    ...invoice("2", "pi_2", {
      amount_paid: 2900,
      billing_reason: "subscription_cycle",
      total_taxes: [],
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: "sub_1", metadata: {} },
      },
    }),
  );
  const { body } = await f.run();
  assertEquals(f.sales, [{
    ...reference(r),
    livemode: true,
    payment_intent_id: "pi_2",
    charge_id: "ch_2",
    checkout_session_id: null,
    invoice_id: "in_2",
    subscription_id: "sub_1",
    customer_id: "cus_Buyer1",
    billing_reason: "subscription_cycle",
    amount_minor: 2900,
    currency: "USD",
    tax_minor: 0,
    fee_minor: 114,
    fee_currency: "USD",
    refunded_minor: 0,
    paid_at: PAID_AT,
    kma_click: null,
    tag_source: null,
    // The database never matches a renewal by email; the worker just passes it on.
    buyer_email: "buyer@private.example",
  }]);
  assertEquals(outcomes(f), [`${r.event_id}: done recorded`]);
  assertNothingSensitive(f, body);
});

Deno.test("with no tag the buyer's email is handed to the sale call and to nothing else", async () => {
  const f = fixture([
    receipt("payment_intent.succeeded", "pi_1"),
    receipt("payment_intent.succeeded", "pi_2"),
    receipt("payment_intent.succeeded", "pi_3"),
    receipt("payment_intent.succeeded", "pi_4"),
  ]);
  const none = { billing_details: { name: "Jane Private", email: null } };
  f.stripe.add(
    // Billing details first, then the receipt address, then the customer.
    ...payment("1", { intent: { receipt_email: "receipt@private.example" } }),
    ...payment("2", {
      charge: none,
      intent: { receipt_email: "receipt@private.example", customer: "cus_B" },
    }),
    ...payment("3", { charge: none, intent: { customer: "cus_B" } }),
    ...payment("4", {
      charge: { billing_details: { email: "not an address" } },
    }),
    { id: "cus_B", object: "customer", email: "customer@private.example" },
  );
  const { body } = await f.run();
  assertEquals(
    f.sales.map((sale) => [sale.buyer_email, sale.kma_click, sale.tag_source]),
    [
      ["buyer@private.example", null, null],
      ["receipt@private.example", null, null],
      ["customer@private.example", null, null],
      // No tag and no email: the sale is still recorded, unmatched.
      [null, null, null],
    ],
  );
  assertEquals(body.recorded, 4);
  assertNothingSensitive(f, body);
});

Deno.test("a test mode object is refused and no sale is recorded", async () => {
  const f = fixture([
    receipt("payment_intent.succeeded", "pi_1"),
    receipt("payment_intent.succeeded", "pi_2"),
    receipt("checkout.session.completed", "cs_live_3"),
    receipt("invoice.paid", "in_4"),
    receipt("refund.created", "re_5", { amount_minor: 1000 }),
    receipt("charge.refunded", "ch_2"),
    receipt("charge.dispute.created", "dp_6"),
  ]);
  f.stripe.add(
    ...payment("1", { intent: { livemode: false } }),
    ...payment("2", { charge: { livemode: false } }),
    ...payment("3"),
    session("3", { livemode: false }),
    ...payment("4"),
    ...invoice("4", "pi_4", { livemode: false }),
    {
      id: "re_5",
      object: "refund",
      amount: 1000,
      currency: "usd",
      status: "succeeded",
      charge: "ch_2",
      payment_intent: "pi_2",
      created: PAID_AT,
    },
    {
      id: "dp_6",
      object: "dispute",
      livemode: false,
      amount: 4900,
      currency: "usd",
      status: "lost",
      charge: "ch_1",
      payment_intent: "pi_1",
      created: PAID_AT,
    },
  );
  const { body } = await f.run();
  assertEquals(f.sales.length, 0);
  assertEquals(f.events.length, 0);
  assertEquals(f.finished.map((call) => [call.action, call.code]), [
    ["done", "not_live"],
    ["done", "not_live"],
    ["done", "not_live"],
    ["done", "not_live"],
    ["done", "not_live"],
    ["done", "not_live"],
    ["done", "not_live"],
  ]);
  assertEquals([body.claimed, body.skipped, body.recorded], [7, 7, 0]);
});

Deno.test("an amount or currency that differs from the signed event is refused", async () => {
  const f = fixture([
    receipt("payment_intent.succeeded", "pi_1", { amount_minor: 100 }),
    receipt("payment_intent.succeeded", "pi_2", { currency: "EUR" }),
    receipt("checkout.session.completed", "cs_live_3", { amount_minor: 100 }),
    receipt("invoice.paid", "in_4", { amount_minor: 100 }),
    receipt("refund.created", "re_5", { amount_minor: 100 }),
    receipt("charge.dispute.created", "dp_6", { amount_minor: 100 }),
    // An event that carried no amount has nothing to compare: Stripe's value is used.
    receipt("payment_intent.succeeded", "pi_7", {
      amount_minor: null,
      currency: null,
    }),
  ]);
  f.stripe.add(
    ...payment("1"),
    ...payment("2"),
    ...payment("3"),
    session("3"),
    ...payment("4"),
    ...invoice("4", "pi_4"),
    {
      id: "re_5",
      object: "refund",
      amount: 1000,
      currency: "usd",
      status: "succeeded",
      charge: "ch_1",
      payment_intent: "pi_1",
      created: PAID_AT,
    },
    {
      id: "dp_6",
      object: "dispute",
      livemode: true,
      amount: 4900,
      currency: "usd",
      status: "needs_response",
      charge: "ch_1",
      payment_intent: "pi_1",
      created: PAID_AT,
    },
    ...payment("7"),
  );
  await f.run();
  assertEquals(f.finished.map((call) => call.code), [
    "amount_mismatch",
    "amount_mismatch",
    "amount_mismatch",
    "amount_mismatch",
    "amount_mismatch",
    "amount_mismatch",
    "recorded",
  ]);
  assertEquals(f.sales.map((sale) => sale.payment_intent_id), ["pi_7"]);
  assertEquals(f.events.length, 0);
});

Deno.test("a payment that did not succeed, or a charge that is not the PaymentIntent's, is not a sale", async () => {
  const f = fixture([
    receipt("payment_intent.succeeded", "pi_1"),
    receipt("payment_intent.succeeded", "pi_2"),
    receipt("payment_intent.succeeded", "pi_3"),
    receipt("payment_intent.succeeded", "pi_4"),
    receipt("checkout.session.completed", "cs_live_5"),
    receipt("checkout.session.completed", "cs_live_6", { amount_minor: 0 }),
    receipt("checkout.session.completed", "cs_live_7"),
    receipt("payment_intent.succeeded", "seti_8"),
  ]);
  f.stripe.add(
    ...payment("1", { intent: { status: "requires_capture" } }),
    ...payment("2", { charge: { paid: false, status: "failed" } }),
    ...payment("3", { charge: { payment_intent: "pi_other" } }),
    ...payment("4", { charge: { amount_captured: 100 } }),
    ...payment("5"),
    session("5", { payment_status: "unpaid" }),
    session("6", {
      payment_status: "no_payment_required",
      amount_total: 0,
      payment_intent: null,
    }),
    session("7", { mode: "setup", payment_intent: null }),
  );
  await f.run();
  assertEquals(f.finished.map((call) => call.code), [
    "not_paid",
    "not_paid",
    "charge_mismatch",
    "charge_mismatch",
    "not_paid",
    "no_payment_intent",
    "no_payment_intent",
    "object_mismatch",
  ]);
  assertEquals(f.sales.length, 0);
});

Deno.test("a paid invoice without exactly one PaymentIntent is skipped with an outcome", async () => {
  const f = fixture([
    receipt("invoice.paid", "in_1", { amount_minor: 0 }),
    receipt("invoice.paid", "in_2"),
    receipt("invoice.paid", "in_3"),
  ]);
  const [paidInvoice, paidBy] = invoice("3", "pi_3");
  f.stripe.add(
    // in_1: a trial or fully discounted invoice has no payment at all.
    { ...invoice("1", "pi_1")[0], amount_paid: 0 },
    // in_2: paid outside Stripe.
    invoice("2", "pi_2")[0],
    { ...invoice("2", "pi_2")[1], payment: { type: "out_of_band" } },
    // in_3: two partial payments.
    paidInvoice,
    paidBy,
    {
      ...paidBy,
      id: "inpay_3b",
      payment: { type: "payment_intent", payment_intent: "pi_3b" },
    },
  );
  await f.run();
  assertEquals(f.finished.map((call) => [call.action, call.code]), [
    ["done", "no_payment_intent"],
    ["done", "no_payment_intent"],
    ["done", "invoice_payments_unsupported"],
  ]);
  assertEquals(f.sales.length, 0);
});

Deno.test("a Stripe failure schedules a retry with a stable code and nothing else", async () => {
  const cases: [number | "network" | "garbage", string][] = [
    [500, "stripe_unavailable"],
    [429, "stripe_unavailable"],
    ["network", "stripe_unavailable"],
    [404, "stripe_object_missing"],
    [403, "stripe_account_denied"],
    [400, "stripe_request_rejected"],
    ["garbage", "stripe_invalid_response"],
  ];
  const f = fixture(
    cases.map((_case, index) =>
      receipt("payment_intent.succeeded", `pi_${index}`)
    ),
    { deps: { now: () => NOW } },
  );
  cases.forEach(([failure], index) => {
    f.stripe.add(...payment(String(index)));
    f.stripe.failures.set(`/v1/payment_intents/pi_${index}`, failure);
  });
  const { status, body } = await f.run();
  assertEquals(status, 200);
  assertEquals(
    f.finished.map((call) => [call.action, call.code, call.delay_seconds]),
    cases.map(([, code]) => ["retry", code, undefined]),
  );
  assertEquals(f.sales.length, 0);
  assertEquals([body.claimed, body.retried, body.failed], [7, 7, 0]);
  assertEquals(
    f.logs.filter((entry) => entry.level === "warning").map((entry) =>
      entry.outcome
    ),
    cases.map(([, code]) => code),
  );
  assertNothingSensitive(f, body);
});

Deno.test("the last failed attempt is counted as failed", async () => {
  const r = receipt("payment_intent.succeeded", "pi_1", { attempts: 8 });
  const f = fixture([r], {
    finish: () => ({ state: "failed", outcome: "failed" }),
  });
  f.stripe.failures.set("/v1/payment_intents/pi_1", 503);
  const { body } = await f.run();
  assertEquals(outcomes(f), [`${r.event_id}: retry stripe_unavailable`]);
  assertEquals([body.retried, body.failed], [0, 1]);
  assertEquals(f.logs.map((entry) => entry.outcome), [
    "stripe_unavailable",
    "gave_up",
    "processed",
  ]);
});

Deno.test("a refused platform key stops the run and hands every claimed receipt back", async () => {
  const receipts = ["1", "2", "3"].map((n) =>
    receipt("payment_intent.succeeded", `pi_${n}`)
  );
  const f = fixture(receipts);
  f.stripe.add(...payment("1"), ...payment("2"), ...payment("3"));
  f.stripe.failures.set("/v1/payment_intents/pi_2", 401);
  const { status, body } = await f.run();
  assertEquals(status, 503);
  assertEquals(body.error, "configuration_error");
  assertEquals(outcomes(f), [
    `${receipts[0].event_id}: done recorded`,
    `${receipts[1].event_id}: release stripe_key_rejected`,
    `${receipts[2].event_id}: release stripe_key_rejected`,
  ]);
  // pi_3 was never asked for.
  assertEquals(f.stripe.requests.length, 2);
  assertEquals(f.logs.at(-1)?.outcome, "configuration_error");
  assertEquals(f.logs.at(-1)?.level, "error");
  assertNothingSensitive(f, body);
});

Deno.test("a partial refund and a full refund reach the sale with the charge's refunded total", async () => {
  const partial = receipt("refund.created", "re_1", {
    amount_minor: 1000,
    payment_intent_id: "pi_1",
  });
  const full = receipt("charge.refunded", "ch_2", {
    payment_intent_id: "pi_2",
  });
  const failed = receipt("refund.updated", "re_3", {
    amount_minor: 4900,
    payment_intent_id: "pi_3",
  });
  const f = fixture([partial, full, failed]);
  f.stripe.add(
    ...payment("1", { charge: { amount_refunded: 1000 } }),
    {
      id: "re_1",
      object: "refund",
      amount: 1000,
      currency: "usd",
      status: "succeeded",
      charge: "ch_1",
      payment_intent: "pi_1",
      created: PAID_AT + 600,
      destination_details: { card: { reference: "4242" } },
    },
    ...payment("2", { charge: { amount_refunded: 4900, refunded: true } }),
    ...payment("3", { charge: { amount_refunded: 0 } }),
    {
      id: "re_3",
      object: "refund",
      amount: 4900,
      currency: "usd",
      status: "failed",
      charge: "ch_3",
      // Older refunds may not name the PaymentIntent: the charge does.
      payment_intent: null,
      created: PAID_AT + 700,
    },
  );
  const { body } = await f.run();
  assertEquals(f.stripe.reads, [
    "/v1/refunds/re_1?expand[]=charge",
    "/v1/charges/ch_2",
    "/v1/refunds/re_3?expand[]=charge",
  ]);
  assertEquals(f.events, [
    {
      ...reference(partial),
      payment_intent_id: "pi_1",
      refunded_minor: 1000,
      events: [{
        kind: "refund",
        stripe_object_id: "re_1",
        state: "succeeded",
        amount_minor: 1000,
        currency: "USD",
        occurred_at: PAID_AT + 600,
      }],
    },
    {
      ...reference(full),
      payment_intent_id: "pi_2",
      refunded_minor: 4900,
      events: [],
    },
    {
      ...reference(failed),
      payment_intent_id: "pi_3",
      refunded_minor: 0,
      events: [{
        kind: "refund",
        stripe_object_id: "re_3",
        state: "failed",
        amount_minor: 4900,
        currency: "USD",
        occurred_at: PAID_AT + 700,
      }],
    },
  ]);
  assertEquals(f.sales.length, 0);
  assertEquals(f.finished.map((call) => call.code), [
    "recorded",
    "recorded",
    "recorded",
  ]);
  assertEquals(body.recorded, 3);
  assertNothingSensitive(f, body);
});

Deno.test("a refund that is pending, has no sale yet, or never had one ends accordingly", async () => {
  const f = fixture([
    receipt("refund.created", "re_1", { amount_minor: 1000 }),
    receipt("refund.created", "re_2", { amount_minor: 1000 }),
    receipt("refund.created", "re_3", { amount_minor: 1000 }),
    receipt("charge.refunded", "ch_4"),
  ], {
    event: (input) =>
      input.payment_intent_id === "pi_2"
        ? { recorded: false, reason: "sale_pending" }
        : { recorded: false, reason: "no_sale" },
  });
  const refund = (n: string, status: string) => ({
    id: `re_${n}`,
    object: "refund",
    amount: 1000,
    currency: "usd",
    status,
    charge: `ch_${n}`,
    payment_intent: `pi_${n}`,
    created: PAID_AT,
  });
  f.stripe.add(
    ...payment("1"),
    refund("1", "pending"),
    ...payment("2"),
    refund("2", "succeeded"),
    ...payment("3"),
    refund("3", "succeeded"),
    // A charge made without a PaymentIntent can never have been a sale.
    ...payment("4", { charge: { payment_intent: null } }),
  );
  const { body } = await f.run();
  assertEquals(
    f.finished.map((call) => [call.action, call.code, call.delay_seconds]),
    [
      ["done", "refund_pending", undefined],
      ["retry", "sale_pending", SHORT_RETRY_SECONDS],
      ["done", "no_sale", undefined],
      ["done", "no_sale", undefined],
    ],
  );
  assertEquals(f.events.length, 2);
  assertEquals([body.skipped, body.retried], [3, 1]);
});

Deno.test("a dispute is recorded as open, won or lost", async () => {
  const statuses: [string, string][] = [
    ["needs_response", "open"],
    ["warning_needs_response", "open"],
    ["under_review", "open"],
    ["won", "won"],
    ["warning_closed", "won"],
    ["lost", "lost"],
  ];
  const receipts = statuses.map(([status], index) =>
    receipt(
      status === "needs_response" || status === "warning_needs_response"
        ? "charge.dispute.created"
        : "charge.dispute.closed",
      `dp_${index}`,
      { payment_intent_id: "pi_1" },
    )
  );
  const f = fixture(receipts);
  f.stripe.add(...payment("1"));
  statuses.forEach(([status], index) =>
    f.stripe.add({
      id: `dp_${index}`,
      object: "dispute",
      livemode: true,
      amount: 4900,
      currency: "usd",
      status,
      charge: "ch_1",
      payment_intent: "pi_1",
      created: PAID_AT + 3600,
      evidence: {
        customer_name: person.name,
        customer_email_address: person.email,
      },
    })
  );
  const { body } = await f.run();
  assertEquals(
    f.stripe.reads,
    statuses.map((_s, index) => `/v1/disputes/dp_${index}`),
  );
  assertEquals(f.events[0], {
    ...reference(receipts[0]),
    payment_intent_id: "pi_1",
    refunded_minor: null,
    events: [{
      kind: "dispute",
      stripe_object_id: "dp_0",
      state: "open",
      amount_minor: 4900,
      currency: "USD",
      occurred_at: PAID_AT + 3600,
    }],
  });
  assertEquals(
    f.events.map((event) => (event.events as Json[])[0].state),
    statuses.map(([, state]) => state),
  );
  assertEquals(body.recorded, 6);
  assertNothingSensitive(f, body);
});

Deno.test("a sale whose fee is not settled yet is recorded and looked at again a few times", async () => {
  const early = receipt("payment_intent.succeeded", "pi_1", { attempts: 1 });
  const late = receipt("payment_intent.succeeded", "pi_2", {
    attempts: FEE_ATTEMPTS,
  });
  const foreign = receipt("payment_intent.succeeded", "pi_3");
  const f = fixture([early, late, foreign]);
  f.stripe.add(
    ...payment("1", { balance: null }),
    ...payment("2", { balance: null }),
    // Settled in another currency than the payment's.
    ...payment("3", { balance: { amount: 4500, fee: 160, currency: "eur" } }),
  );
  const { body } = await f.run();
  assertEquals(
    f.sales.map((sale) => [sale.fee_minor, sale.fee_currency]),
    [[null, null], [null, null], [160, "EUR"]],
  );
  assertEquals(outcomes(f), [
    `${early.event_id}: retry fee_pending in ${SHORT_RETRY_SECONDS}s`,
    `${late.event_id}: done recorded`,
    `${foreign.event_id}: done recorded`,
  ]);
  assertEquals([body.recorded, body.retried], [2, 1]);
});

Deno.test("what the database answers decides how a receipt ends", async () => {
  const receipts = ["1", "2", "3", "4", "5", "6"].map((n) =>
    receipt("payment_intent.succeeded", `pi_${n}`)
  );
  const f = fixture(receipts, {
    sale: (input) => {
      switch (input.payment_intent_id) {
        case "pi_1":
          return { recorded: false, reason: "no_program" };
        case "pi_2":
          return { recorded: false, reason: "sale_conflict" };
        case "pi_3":
          return { recorded: false, reason: "Something went wrong for Jane" };
        case "pi_4":
          throw new DatabaseBoundaryError("55000");
        case "pi_5":
          throw new DatabaseBoundaryError("22023");
        default:
          throw new DatabaseBoundaryError("57014");
      }
    },
  });
  for (const n of ["1", "2", "3", "4", "5", "6"]) f.stripe.add(...payment(n));
  const { status, body } = await f.run();
  assertEquals(status, 200);
  assertEquals(outcomes(f), [
    `${receipts[0].event_id}: done no_program`,
    `${receipts[1].event_id}: done sale_conflict`,
    // Only a code is ever stored as an outcome.
    `${receipts[2].event_id}: done not_recorded`,
    // pi_4: another run holds the receipt now, so this one leaves it alone.
    `${receipts[4].event_id}: retry database_rejected`,
    `${receipts[5].event_id}: retry database_unavailable`,
  ]);
  assertEquals(
    [body.skipped, body.released, body.retried, body.recorded],
    [3, 1, 2, 0],
  );
  assertNothingSensitive(f, body);
});

Deno.test("a run works through batches, stops at its time budget and releases what it did not start", async () => {
  const receipts = Array.from(
    { length: BATCH_SIZE + 2 },
    (_unused, index) => receipt("payment_intent.succeeded", `pi_${index}`),
  );
  const all = fixture(receipts, { claimed: { skipped: 4, failed: 1 } });
  receipts.forEach((_r, index) => all.stripe.add(...payment(String(index))));
  const first = await all.run();
  assertEquals(all.claims.length, 2);
  assertEquals(
    [first.body.claimed, first.body.recorded, first.body.closed_unread],
    [BATCH_SIZE + 2, BATCH_SIZE + 2, 5],
  );

  // A full queue is not drained in one run.
  const endless = fixture(
    Array.from(
      { length: BATCH_SIZE * (MAX_BATCHES + 2) },
      (_unused, index) => receipt("payment_intent.succeeded", `pi_${index}`),
    ),
  );
  for (let index = 0; index < BATCH_SIZE * (MAX_BATCHES + 2); index++) {
    endless.stripe.add(...payment(String(index)));
  }
  assertEquals((await endless.run()).body.claimed, BATCH_SIZE * MAX_BATCHES);
  assertEquals(endless.claims.length, MAX_BATCHES);

  // Each Stripe read takes most of the budget: the second receipt runs past
  // it, and the rest of the batch is handed back unread.
  let clock = NOW;
  const slow = fixture(receipts, { deps: { now: () => clock } });
  receipts.forEach((_r, index) => slow.stripe.add(...payment(String(index))));
  const fetcher = slow.stripe.fetcher;
  const timed = createProgramSalesWorker({
    enabled: () => true,
    authenticate: () => {},
    config: () => ({ secret: KEY, platformAccountId: PLATFORM }),
    store: () => ({
      claim: async (input) => {
        slow.claims.push(input);
        return {
          receipts: slow.claims.length === 1
            ? receipts.slice(0, BATCH_SIZE)
            : [],
          skipped: 0,
          failed: 0,
        };
      },
      recordSale: async () => ({ recorded: true }),
      recordSaleEvent: async () => ({ recorded: true }),
      finish: async (input) => {
        slow.finished.push(input);
        return { state: "done" };
      },
    }),
    fetcher: (input, init) => {
      clock += WORK_BUDGET_MS * 0.6;
      return fetcher(input, init);
    },
    now: () => clock,
    log: () => {},
  });
  const response = await timed(new Request(URL_, { method: "POST" }));
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(
    slow.finished.map((call) => [call.action, call.code]),
    [
      ["done", "recorded"],
      ["done", "recorded"],
      ...Array.from(
        { length: BATCH_SIZE - 2 },
        () => ["release", "worker_out_of_time"],
      ),
    ],
  );
  assertEquals(
    [body.claimed, body.recorded, body.released],
    [BATCH_SIZE, 2, BATCH_SIZE - 2],
  );
  assertEquals(slow.claims.length, 1);
});

// Phase 8: the promotion code the buyer used goes to the sale call --------------

const PROMO = "promo_Anna10Fixture";
const OTHER_PROMO = "promo_Ben10Fixture";

Deno.test("a Checkout Session paid with a promotion code hands the code to the sale call in one read", async () => {
  const r = receipt("checkout.session.completed", "cs_live_1", {
    amount_minor: 4410,
  });
  const f = fixture([r]);
  f.stripe.add(
    ...payment("1", {
      intent: { amount: 4410, amount_received: 4410 },
      charge: { amount: 4410, amount_captured: 4410 },
      balance: { amount: 4410 },
    }),
    session("1", {
      amount_total: 4410,
      // The creator's link of one creator, the code of another: the database
      // decides (a code beats a link); the worker passes both on.
      metadata: { kma_click: CLICK },
      client_reference_id: `kma_${CLICK}`,
      discounts: [{ coupon: null, promotion_code: PROMO }],
      total_details: { amount_tax: 0, amount_discount: 490 },
    }),
  );
  const { body } = await f.run();
  assertEquals(f.stripe.reads, [
    "/v1/checkout/sessions/cs_live_1?expand[]=payment_intent.latest_charge.balance_transaction",
  ]);
  assertEquals(f.sales.length, 1);
  assertEquals(f.sales[0].promotion_code_id, PROMO);
  assertEquals(f.sales[0].kma_click, CLICK);
  assertEquals(f.sales[0].tag_source, "metadata");
  assertEquals(f.sales[0].amount_minor, 4410);
  assertEquals(outcomes(f), [`${r.event_id}: done recorded`]);
  assertNothingSensitive(f, body);
});

Deno.test("a session discount whose code the session does not name is read from its breakdown, once", async () => {
  const f = fixture([
    receipt("checkout.session.completed", "cs_live_1", { amount_minor: 4410 }),
    receipt("checkout.session.completed", "cs_live_2"),
  ]);
  f.stripe.add(
    ...payment("1", {
      intent: { amount: 4410, amount_received: 4410 },
      charge: { amount: 4410, amount_captured: 4410 },
    }),
    session("1", {
      amount_total: 4410,
      discounts: [],
      // Stripe leaves the breakdown out unless it is asked for; the fake
      // stands it in with an id that only an expansion turns into the object.
      total_details: {
        amount_tax: 0,
        amount_discount: 490,
        breakdown: "breakdown_1",
      },
    }),
    {
      id: "breakdown_1",
      object: "breakdown",
      taxes: [],
      discounts: [{
        amount: 490,
        discount: {
          id: "di_1",
          object: "discount",
          promotion_code: PROMO,
          source: { type: "coupon", coupon: "cpn1" },
        },
      }],
    },
    // A session without any discount costs no extra read.
    ...payment("2"),
    session("2"),
  );
  await f.run();
  assertEquals(f.stripe.reads, [
    "/v1/checkout/sessions/cs_live_1?expand[]=payment_intent.latest_charge.balance_transaction",
    "/v1/checkout/sessions/cs_live_1?expand[]=total_details.breakdown",
    "/v1/checkout/sessions/cs_live_2?expand[]=payment_intent.latest_charge.balance_transaction",
  ]);
  assertEquals(f.sales[0].promotion_code_id, PROMO);
  assert(!("promotion_code_id" in f.sales[1]));
});

Deno.test("a discounted subscription checkout: the invoice and the session name the code, the PaymentIntent cannot", async () => {
  const receipts = [
    receipt("payment_intent.succeeded", "pi_1", { amount_minor: 4410 }),
    receipt("invoice.paid", "in_1", {
      payment_intent_id: null,
      amount_minor: 4410,
    }),
    receipt("checkout.session.completed", "cs_live_1", {
      payment_intent_id: null,
      amount_minor: 4410,
    }),
  ];
  const f = fixture(receipts);
  f.stripe.add(
    ...payment("1", {
      intent: {
        amount: 4410,
        amount_received: 4410,
        customer: "cus_Buyer1",
        metadata: {},
      },
      charge: { amount: 4410, amount_captured: 4410 },
    }),
    ...invoice("1", "pi_1", {
      amount_paid: 4410,
      // Ids unless expanded.
      discounts: ["di_1"],
      total_discount_amounts: [{ amount: 490, discount: "di_1" }],
      parent: {
        type: "subscription_details",
        subscription_details: {
          subscription: "sub_1",
          metadata: { kma_click: CLICK },
        },
      },
    }),
    {
      id: "di_1",
      object: "discount",
      promotion_code: PROMO,
      source: { type: "coupon", coupon: "cpn1" },
      subscription: "sub_1",
    },
    session("1", {
      mode: "subscription",
      amount_total: 4410,
      payment_intent: null,
      invoice: "in_1",
      subscription: "sub_1",
      customer: "cus_Buyer1",
      metadata: { kma_click: CLICK },
      discounts: [{ coupon: null, promotion_code: PROMO }],
      total_details: { amount_tax: 0, amount_discount: 490 },
    }),
  );
  const { body } = await f.run();
  assertEquals(body.recorded, 3);
  assertEquals(
    f.sales.map((sale) => [sale.payment_intent_id, sale.promotion_code_id]),
    [["pi_1", undefined], ["pi_1", PROMO], ["pi_1", PROMO]],
  );
  // The invoice is read again once, with its discounts expanded.
  assertEquals(
    f.stripe.reads.filter((read) => read.startsWith("/v1/invoices/")),
    [
      "/v1/invoices/in_1?expand[]=discounts&expand[]=total_discount_amounts.discount",
    ],
  );
  assertNothingSensitive(f, body);
});

Deno.test("a renewal paid without a discount names no code; one paid with a lasting code names it", async () => {
  const f = fixture([
    receipt("invoice.paid", "in_2", { payment_intent_id: null }),
    receipt("invoice.paid", "in_3", { payment_intent_id: null }),
  ]);
  f.stripe.add(
    ...payment("2"),
    ...invoice("2", "pi_2", { billing_reason: "subscription_cycle" }),
    ...payment("3"),
    ...invoice("3", "pi_3", {
      billing_reason: "subscription_cycle",
      // Already expanded: no second read.
      discounts: [{
        id: "di_3",
        object: "discount",
        promotion_code: { id: OTHER_PROMO, object: "promotion_code" },
      }],
    }),
  );
  await f.run();
  assert(!("promotion_code_id" in f.sales[0]));
  assertEquals(f.sales[1].promotion_code_id, OTHER_PROMO);
  assertEquals(
    f.stripe.reads.filter((read) => read.startsWith("/v1/invoices/")),
    [],
  );
});

Deno.test("a promotion code that is not a promotion code id is never passed on", async () => {
  const f = fixture([
    receipt("checkout.session.completed", "cs_live_1"),
    receipt("checkout.session.completed", "cs_live_2"),
  ]);
  f.stripe.add(
    ...payment("1"),
    session("1", {
      discounts: [{ coupon: "cpn1", promotion_code: null }],
      total_details: { amount_tax: 0, amount_discount: 0 },
    }),
    ...payment("2"),
    session("2", {
      discounts: [{ promotion_code: "promo_has spaces" }, {
        promotion_code: "coupon_Anna10",
      }],
    }),
  );
  await f.run();
  assertEquals(f.sales.length, 2);
  for (const sale of f.sales) assert(!("promotion_code_id" in sale));
});
