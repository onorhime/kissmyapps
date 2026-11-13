// deno-lint-ignore-file require-await -- Fake adapters keep production async boundaries.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";
import { percentOff } from "../program-checkout/stripe.ts";
import {
  BATCH_SIZE,
  createProgramPromoWorker,
  handleProgramPromoWorker,
  type PromoWorkerDependencies,
  type PromoWorkerLogEntry,
} from "./index.ts";
import {
  claimInput,
  finishInput,
  parseClaim,
  type PromoFinish,
  type PromoStore,
} from "./store.ts";

type Json = Record<string, unknown>;

const NOW = Date.parse("2026-11-21T12:00:00Z");
// Not a key: the fake Stripe below is the only thing that ever sees it.
const KEY = "sk_live_" + "K".repeat(24);
const MERCHANT = "acct_MerchantA";
const OTHER_MERCHANT = "acct_MerchantB";
const PROGRAM = "20000000-0000-4000-8000-000000000001";
const OTHER_PROGRAM = "20000000-0000-4000-8000-000000000002";
const URL_ = "https://project.example.invalid/program-promo-worker";

function uuid(n: number): string {
  return `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function code(n: number, over: Json = {}): Json {
  return {
    id: uuid(n),
    code: `ANNA${n}`,
    account_id: MERCHANT,
    discount_bps: 1000,
    coupon_id: null,
    program_id: PROGRAM,
    ...over,
  };
}

interface SeenPost {
  path: string;
  account: string | null;
  authorization: string | null;
  version: string | null;
  idempotency: string | null;
  params: Record<string, string>;
}

/** Merchants' Stripe accounts: coupons and promotion codes. */
class FakeStripe {
  readonly posts: SeenPost[] = [];
  /** Failures by path, or by path and code text, used once each. */
  readonly failures = new Map<string, (number | "network" | Json)[]>();
  private coupons = 0;
  private readonly active = new Map<string, string>();

  fail(key: string, ...answers: (number | "network" | Json)[]): this {
    this.failures.set(key, [...(this.failures.get(key) ?? []), ...answers]);
    return this;
  }

  readonly fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const params = Object.fromEntries(
      new URLSearchParams(String(init?.body ?? "")),
    );
    if (init?.method !== "POST" || url.origin !== "https://api.stripe.com") {
      throw new Error("the worker only POSTs to api.stripe.com");
    }
    this.posts.push({
      path: url.pathname,
      account: headers.get("stripe-account"),
      authorization: headers.get("authorization"),
      version: headers.get("stripe-version"),
      idempotency: headers.get("idempotency-key"),
      params,
    });
    const planned = this.failures.get(`${url.pathname} ${params.code ?? ""}`)
      ?.shift() ?? this.failures.get(url.pathname)?.shift();
    if (planned === "network") throw new TypeError("connection reset");
    if (typeof planned === "number") {
      return Response.json({
        error: {
          type: "invalid_request_error",
          message: "Sensitive Stripe message",
        },
      }, { status: planned });
    }
    if (planned) {
      return Response.json({ error: planned }, { status: 400 });
    }
    if (url.pathname === "/v1/coupons") {
      this.coupons += 1;
      return Response.json({
        id: `cpn${this.coupons}`,
        object: "coupon",
        livemode: true,
        percent_off: Number(params.percent_off),
        duration: params.duration,
        valid: true,
      });
    }
    if (url.pathname === "/v1/promotion_codes") {
      const id = `promo_${params.code}x${this.posts.length}`;
      this.active.set(id, params.code);
      return Response.json({
        id,
        object: "promotion_code",
        livemode: true,
        active: true,
        code: params.code,
        promotion: { type: "coupon", coupon: params["promotion[coupon]"] },
      });
    }
    const id = url.pathname.slice("/v1/promotion_codes/".length);
    return Response.json({
      id,
      object: "promotion_code",
      livemode: true,
      active: params.active !== "false",
      code: this.active.get(id) ?? "ANNA10",
    });
  };
}

interface Fixture {
  stripe: FakeStripe;
  claims: number[];
  finished: Json[];
  logs: PromoWorkerLogEntry[];
  run: () => Promise<{ status: number; body: Json }>;
}

function fixture(
  claims: (Json | Error)[],
  options: {
    finish?: (input: Json) => Json;
    deps?: Partial<PromoWorkerDependencies>;
  } = {},
): Fixture {
  const stripe = new FakeStripe();
  const queue = [...claims];
  const asked: number[] = [];
  const finished: Json[] = [];
  const logs: PromoWorkerLogEntry[] = [];
  // The real adapters' parsing and shapes, around a fake database.
  const store: PromoStore = {
    claim: async (limit) => {
      asked.push(claimInput(limit).limit as number);
      const next = queue.shift() ?? { codes: [], deactivate: [] };
      if (next instanceof Error) throw next;
      return parseClaim(next);
    },
    finish: async (outcome: PromoFinish) => {
      const input = finishInput(outcome);
      finished.push(input);
      const answer = options.finish?.(input) ?? { status: "active" };
      return { gaveUp: answer.status === "failed" };
    },
  };
  const handler = createProgramPromoWorker({
    enabled: () => true,
    authenticate: () => {},
    stripeKey: () => KEY,
    store: () => store,
    fetcher: stripe.fetcher,
    now: () => NOW,
    log: (entry) => logs.push(entry),
    ...options.deps,
  });
  return {
    stripe,
    claims: asked,
    finished,
    logs,
    run: async () => {
      const response = await handler(new Request(URL_, { method: "POST" }));
      return { status: response.status, body: await response.json() };
    },
  };
}

function assertQuiet(f: Fixture, body: Json): void {
  const text = JSON.stringify([f.logs, f.finished, body]);
  for (const value of [KEY, "Sensitive Stripe message"]) {
    assert(!text.includes(value), `leaked: ${value}`);
  }
}

Deno.test("only the exact value true turns the worker on; off, it touches nothing", async () => {
  for (const value of [undefined, "", "TRUE", "1"]) {
    const f = fixture([{ codes: [code(10)] }], {
      deps: { enabled: () => value === "true" },
    });
    const { status, body } = await f.run();
    assertEquals(status, 200);
    assertEquals(body.enabled, false);
    assertEquals(f.claims, []);
    assertEquals(f.stripe.posts, []);
  }
});

Deno.test("the schedule and a person each need their own credential", async () => {
  const names = ["PROGRAM_PROMO_SCHEDULER_SECRET", "INTERNAL_WORKER_SECRET"];
  const previous = names.map((name) => Deno.env.get(name));
  const scheduler = "scheduler-fixture-00000000000000000000000";
  const internal = "internal-fixture-000000000000000000000000";
  Deno.env.set(names[0], scheduler);
  Deno.env.set(names[1], internal);
  const handler = createProgramPromoWorker({
    enabled: () => false,
    log: () => {},
  });
  const call = async (headers: Record<string, string>, method = "POST") => {
    const response = await handler(new Request(URL_, { method, headers }));
    await response.body?.cancel();
    return response.status;
  };
  try {
    assertEquals(await call({ "x-kma-scheduler-secret": scheduler }), 200);
    assertEquals(await call({ "x-kma-worker-secret": internal }), 200);
    assertEquals(await call({ "x-kma-scheduler-secret": internal }), 401);
    assertEquals(await call({ "x-kma-worker-secret": scheduler }), 401);
    assertEquals(await call({}), 401);
    assertEquals(
      await call({
        "x-kma-scheduler-secret": scheduler,
        origin: "https://evil.example",
      }),
      401,
    );
    assertEquals(
      await call({ "x-kma-scheduler-secret": scheduler }, "GET"),
      405,
    );
    Deno.env.set(names[0], "short");
    assertEquals(await call({ "x-kma-scheduler-secret": "short" }), 401);
    const closed = await handleProgramPromoWorker(
      new Request(URL_, { method: "POST" }),
    );
    assertEquals(closed.status, 401);
    await closed.body?.cancel();
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) Deno.env.delete(name);
      else Deno.env.set(name, previous[index]!);
    });
  }
});

Deno.test("a pending code becomes a coupon and a promotion code on the merchant's account", async () => {
  const f = fixture([{ codes: [code(10)], deactivate: [] }]);
  const { status, body } = await f.run();
  assertEquals(status, 200);
  assertEquals(body, {
    status: "processed",
    worker: "program-promo-worker",
    enabled: true,
    claimed: 1,
    made: 1,
    deactivated: 0,
    errors: 0,
    gave_up: 0,
    request_id: body.request_id,
  });
  assertEquals(f.claims, [BATCH_SIZE]);
  assertEquals(f.stripe.posts.map((post) => post.path), [
    "/v1/coupons",
    "/v1/promotion_codes",
  ]);
  for (const post of f.stripe.posts) {
    assertEquals(post.account, MERCHANT);
    assertEquals(post.authorization, `Bearer ${KEY}`);
    assertEquals(post.version, STRIPE_API_VERSION);
  }
  const [coupon, promotion] = f.stripe.posts;
  assertEquals(coupon.params, {
    percent_off: "10",
    duration: "once",
    name: "10% off",
    "metadata[kma_program_id]": PROGRAM,
  });
  assertEquals(coupon.idempotency, `kma-promo-coupon-${PROGRAM}-1000`);
  assertEquals(promotion.params, {
    "promotion[type]": "coupon",
    "promotion[coupon]": "cpn1",
    code: "ANNA10",
    "metadata[kma_promo_code_id]": uuid(10),
    "metadata[kma_program_id]": PROGRAM,
  });
  assertEquals(promotion.idempotency, `kma-promo-code-${uuid(10)}-ANNA10`);
  assertEquals(f.finished, [{
    id: uuid(10),
    coupon_id: "cpn1",
    promotion_code_id: "promo_ANNA10x2",
  }]);
  assertEquals(f.logs.map((entry) => entry.outcome), ["processed"]);
  assertQuiet(f, body);
});

Deno.test("one coupon per account, program and discount; a coupon the database names is reused", async () => {
  const f = fixture([{
    codes: [
      code(11),
      code(12),
      code(13, { discount_bps: 1250 }),
      code(14, { program_id: OTHER_PROGRAM, coupon_id: "keptCoupon" }),
      code(15, { account_id: OTHER_MERCHANT }),
    ],
  }]);
  const { body } = await f.run();
  assertEquals(body.made, 5);
  const coupons = f.stripe.posts.filter((post) => post.path === "/v1/coupons");
  assertEquals(
    coupons.map((post) => [post.account, post.params.percent_off]),
    [[MERCHANT, "10"], [MERCHANT, "12.5"], [OTHER_MERCHANT, "10"]],
  );
  assertEquals(
    f.finished.map((call) => call.coupon_id),
    ["cpn1", "cpn1", "cpn2", "keptCoupon", "cpn3"],
  );
});

Deno.test("percent off is the discount in basis points over one hundred", () => {
  assertEquals(percentOff(100), "1");
  assertEquals(percentOff(1000), "10");
  assertEquals(percentOff(1250), "12.5");
  assertEquals(percentOff(9000), "90");
});

Deno.test("Stripe errors end the code with a short code, and the run goes on", async () => {
  const f = fixture([{
    codes: [code(20), code(21), code(22), code(23), code(24), code(25)],
  }]);
  f.stripe
    // A code the account already has.
    .fail("/v1/promotion_codes ANNA20", {
      type: "invalid_request_error",
      param: "code",
      message: "An active promotion code with `code: ANNA20` already exists.",
    })
    .fail("/v1/promotion_codes ANNA21", {
      type: "invalid_request_error",
      code: "resource_already_exists",
    })
    .fail("/v1/promotion_codes ANNA22", {
      type: "invalid_request_error",
      code: "parameter_invalid_string_blank",
      message: "Sensitive Stripe message",
    })
    .fail("/v1/promotion_codes ANNA23", 403)
    .fail("/v1/promotion_codes ANNA24", 500)
    .fail("/v1/promotion_codes ANNA25", "network");
  const { status, body } = await f.run();
  assertEquals(status, 200);
  assertEquals(f.finished, [
    // The coupon made before the promotion code failed is kept for the next try.
    { id: uuid(20), error: "code_taken", coupon_id: "cpn1" },
    { id: uuid(21), error: "code_taken", coupon_id: "cpn1" },
    {
      id: uuid(22),
      error: "parameter_invalid_string_blank",
      coupon_id: "cpn1",
    },
    { id: uuid(23), error: "stripe_account_denied", coupon_id: "cpn1" },
    { id: uuid(24), error: "stripe_unavailable", coupon_id: "cpn1" },
    { id: uuid(25), error: "stripe_unreachable", coupon_id: "cpn1" },
  ]);
  assertEquals(body.errors, 6);
  assertEquals(body.made, 0);
  assertQuiet(f, body);
});

Deno.test("a coupon deleted in the merchant's dashboard is replaced once", async () => {
  const f = fixture([{ codes: [code(30, { coupon_id: "deletedCoupon" })] }]);
  f.stripe.fail("/v1/promotion_codes", {
    type: "invalid_request_error",
    code: "resource_missing",
    param: "promotion[coupon]",
  });
  const { body } = await f.run();
  assertEquals(body.made, 1);
  assertEquals(f.stripe.posts.map((post) => post.path), [
    "/v1/promotion_codes",
    "/v1/coupons",
    "/v1/promotion_codes",
  ]);
  assertEquals(
    f.stripe.posts[1].idempotency,
    `kma-promo-coupon-${PROGRAM}-1000-${uuid(30)}`,
  );
  assertEquals(f.finished, [{
    id: uuid(30),
    coupon_id: "cpn1",
    promotion_code_id: "promo_ANNA30x3",
  }]);
});

Deno.test("retired codes are switched off at Stripe, or were never there", async () => {
  const f = fixture([{
    codes: [],
    deactivate: [
      { id: uuid(40), account_id: MERCHANT, promotion_code_id: "promo_Old40" },
      { id: uuid(41), account_id: MERCHANT, promotion_code_id: "promo_Gone41" },
      { id: uuid(42), account_id: MERCHANT, promotion_code_id: null },
      { id: uuid(43), account_id: MERCHANT, promotion_code_id: "promo_Busy43" },
    ],
  }]);
  f.stripe
    .fail("/v1/promotion_codes/promo_Gone41", {
      type: "invalid_request_error",
      code: "resource_missing",
    })
    .fail("/v1/promotion_codes/promo_Busy43", 503);
  const { body } = await f.run();
  assertEquals(f.stripe.posts.map((post) => [post.path, post.params]), [
    ["/v1/promotion_codes/promo_Old40", { active: "false" }],
    ["/v1/promotion_codes/promo_Gone41", { active: "false" }],
    ["/v1/promotion_codes/promo_Busy43", { active: "false" }],
  ]);
  assertEquals(f.stripe.posts[0].idempotency, `kma-promo-retire-${uuid(40)}`);
  assertEquals(f.finished, [
    { id: uuid(40), deactivated: true },
    { id: uuid(41), deactivated: true },
    { id: uuid(42), deactivated: true },
    { id: uuid(43), error: "stripe_unavailable" },
  ]);
  assertEquals([body.deactivated, body.errors], [3, 1]);
});

Deno.test("a refused platform key stops the run and leaves the claimed codes to the next claim", async () => {
  const f = fixture([{ codes: [code(50), code(51)] }]);
  f.stripe.fail("/v1/coupons", 401);
  const { status, body } = await f.run();
  assertEquals(status, 503);
  assertEquals(body.error, "configuration_error");
  assertEquals(f.finished, []);
  assertEquals(f.stripe.posts.length, 1);
  assertEquals(f.logs.at(-1)?.outcome, "stripe_key_rejected");
  assertEquals(f.logs.at(-1)?.level, "error");
  assertQuiet(f, body);
});

Deno.test("a code the database gives up on is counted and logged as given up", async () => {
  const f = fixture([{ codes: [code(60)] }], {
    finish: () => ({ status: "failed" }),
  });
  f.stripe.fail("/v1/promotion_codes", 500);
  const { body } = await f.run();
  assertEquals([body.errors, body.gave_up], [1, 1]);
  assertEquals(
    f.logs.map((entry) => entry.outcome),
    ["gave_up", "processed"],
  );
});

Deno.test("a run takes batches until a short one, and works on a code once", async () => {
  const full = Array.from({ length: BATCH_SIZE }, (_, i) => code(100 + i));
  const f = fixture([
    { codes: full },
    { codes: [code(200)] },
  ]);
  const { body } = await f.run();
  assertEquals(f.claims, [BATCH_SIZE, BATCH_SIZE]);
  assertEquals(body.made, BATCH_SIZE + 1);

  // A claim that hands out the same codes again ends the run.
  const again = fixture([{ codes: full }, { codes: full }, { codes: full }]);
  const second = await again.run();
  assertEquals(again.claims.length, 2);
  assertEquals(second.body.made, BATCH_SIZE);
});

Deno.test("an answer that is not the agreed shape stops the run before Stripe", async () => {
  const broken: (Json | Error)[] = [
    {},
    { codes: "none" },
    { codes: [code(70, { code: "anna10" })] },
    { codes: [code(70, { code: "AN" })] },
    { codes: [code(70, { account_id: "acct_" })] },
    { codes: [code(70, { discount_bps: 50 })] },
    { codes: [code(70, { discount_bps: 9500 })] },
    { codes: [code(70, { program_id: "p1" })] },
    { codes: [code(70, { coupon_id: "bad coupon" })] },
    { codes: [], deactivate: [{ id: "x", account_id: MERCHANT }] },
    {
      codes: [],
      deactivate: [{
        id: uuid(71),
        account_id: MERCHANT,
        promotion_code_id: "coupon_1",
      }],
    },
    new DatabaseBoundaryError("57014"),
  ];
  for (const claim of broken) {
    const f = fixture([claim]);
    const { status, body } = await f.run();
    assertEquals(status, 503, JSON.stringify(claim));
    assertEquals(body.error, "database_boundary_error");
    assertEquals(f.stripe.posts, []);
  }
});

Deno.test("finish inputs have exactly the contract's shapes", () => {
  assertEquals(
    finishInput({
      id: uuid(1),
      kind: "made",
      couponId: "cpn1",
      promotionCodeId: "promo_A",
    }),
    { id: uuid(1), coupon_id: "cpn1", promotion_code_id: "promo_A" },
  );
  assertEquals(finishInput({ id: uuid(1), kind: "deactivated" }), {
    id: uuid(1),
    deactivated: true,
  });
  assertEquals(
    finishInput({ id: uuid(1), kind: "error", error: "code_taken" }),
    {
      id: uuid(1),
      error: "code_taken",
    },
  );
  assertEquals(
    finishInput({
      id: uuid(1),
      kind: "error",
      error: "code_taken",
      couponId: "cpn1",
    }),
    { id: uuid(1), error: "code_taken", coupon_id: "cpn1" },
  );
  assertEquals(claimInput(10), { limit: 10 });
  assertMatch(JSON.stringify(parseClaim({ codes: [] })), /"deactivate":\[\]/);
});
