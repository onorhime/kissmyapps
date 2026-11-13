import { assert, assertEquals } from "@std/assert";
import { createProgramBalanceHandler } from "../program-balance/index.ts";
import { balanceReturnUrls } from "../program-balance/config.ts";
import {
  CONFIG,
  type FakeAccount,
  FakeStore,
  FakeStripe,
  fakeUuid,
  LIVE_KEY,
  ORIGIN,
  PLATFORM,
} from "../program-balance/testing.ts";
import type { BalanceFunction, Json } from "../program-balance/store.ts";
import {
  type BalanceWorkerLogEntry,
  CHARGE_LEASE_SECONDS,
  createProgramBalanceWorker,
  type ProgramBalanceWorkerDependencies,
  TICK_LIMIT,
} from "./index.ts";

const START = Date.UTC(2026, 10, 16, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 86_400_000;
const CHARGES = /^\/v1\/payment_intents$/;

function world(overrides: Partial<ProgramBalanceWorkerDependencies> = {}) {
  const clock = { now: START };
  const now = () => clock.now;
  const store = new FakeStore(now);
  const stripe = new FakeStripe(now);
  const owner = fakeUuid();
  const program = store.addProgram({ owner });
  const logs: BalanceWorkerLogEntry[] = [];
  const worker = createProgramBalanceWorker({
    enabled: () => true,
    authenticate: () => {},
    config: () => CONFIG,
    store: () => store,
    fetcher: stripe.fetch,
    now,
    log: (entry) => logs.push(entry),
    ...overrides,
  });
  const run = async () => {
    const response = await worker(
      new Request("https://functions.example/program-balance-worker", {
        method: "POST",
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  /** A balance below its minimum with a saved card: due for a top-up. */
  const dueAccount = (options: Partial<FakeAccount> = {}) =>
    store.addFundedAccount(program, {
      availableMinor: 1200,
      minBalanceMinor: 5000,
      topupAmountMinor: 10000,
      ...options,
    });
  const charges = () => stripe.posts(CHARGES);
  return {
    clock,
    store,
    stripe,
    owner,
    program,
    logs,
    worker,
    run,
    dueAccount,
    charges,
  };
}

Deno.test("a balance below its minimum is topped up from the saved card", async () => {
  const w = world();
  const account = w.dueAccount();
  const first = await w.run();
  assertEquals(first.status, 200);
  assertEquals(
    [
      first.body.enabled,
      first.body.claimed,
      first.body.credited,
      first.body.errors,
    ],
    [true, 1, 1, 0],
  );
  const [topup] = w.store.topupsOf(account);
  const [charge] = w.charges();
  assertEquals(w.charges().length, 1);
  // One off-session PaymentIntent on the platform's own account, confirmed at
  // once, for exactly the amount the merchant chose, keyed on the top-up.
  assertEquals(charge.idempotencyKey, `kma-topup-${topup.id}-charge`);
  assertEquals(charge.account, null);
  assertEquals(charge.authorization, `Bearer ${LIVE_KEY}`);
  assertEquals(charge.params.amount, "10000");
  assertEquals(charge.params.currency, "usd");
  assertEquals(charge.params.customer, "cus_FakeFunded");
  assertEquals(charge.params.payment_method, "pm_FakeSaved");
  assertEquals(charge.params.off_session, "true");
  assertEquals(charge.params.confirm, "true");
  assertEquals(
    charge.params["automatic_payment_methods[allow_redirects]"],
    "never",
  );
  assertEquals(charge.params["metadata[kma_topup_id]"], topup.id);
  assertEquals(charge.params["metadata[kma_kind]"], "auto");
  assertEquals(charge.params.return_url, undefined);

  // Read back from Stripe, then added once.
  const intentId = topup.intentId as string;
  assert(
    w.stripe.requests.some((r) =>
      r.method === "GET" && r.path === `/v1/payment_intents/${intentId}`
    ),
  );
  assertEquals([topup.kind, topup.status], ["auto", "succeeded"]);
  assertEquals(account.availableMinor, 11200);
  assertEquals(w.store.ledgerOf(account), 10000);
  assertEquals(account.topupFailures, 0);
  assertEquals(account.card?.payment_method_id, "pm_FakeSaved");
  assertEquals(w.stripe.detached, []);

  // The balance is above its minimum now: later runs charge nothing.
  for (let i = 0; i < 3; i++) {
    w.clock.now += MINUTE;
    const again = await w.run();
    assertEquals([again.body.claimed, again.body.credited], [0, 0]);
  }
  assertEquals(w.charges().length, 1);
  assertEquals(w.store.entries.length, 1);
});

Deno.test("a top-up that leaves the balance below the minimum is followed by one more per run, never two", async () => {
  const w = world();
  const account = w.dueAccount({ availableMinor: 0, minBalanceMinor: 25000 });
  for (const expected of [10000, 20000, 30000, 30000]) {
    await w.run();
    assertEquals(account.availableMinor, expected);
    w.clock.now += MINUTE;
  }
  assertEquals(w.charges().length, 3);
});

Deno.test("each due account is charged once per run", async () => {
  const w = world();
  const accounts = [w.dueAccount()];
  for (let i = 0; i < 3; i++) {
    const program = w.store.addProgram({
      owner: w.owner,
      name: `Program ${i}`,
    });
    w.stripe.addCard(`pm_Other${i}`, `cus_Other${i}`);
    accounts.push(
      w.store.addFundedAccount(program, {
        customerId: `cus_Other${i}`,
        card: {
          payment_method_id: `pm_Other${i}`,
          brand: "visa",
          last4: "1111",
          exp_month: 1,
          exp_year: 2030,
        },
      }),
    );
  }
  const answer = await w.run();
  assertEquals([answer.body.claimed, answer.body.credited], [4, 4]);
  assertEquals(
    w.charges().map((c) => c.params.customer).sort(),
    ["cus_FakeFunded", "cus_Other0", "cus_Other1", "cus_Other2"],
  );
  assertEquals(new Set(w.charges().map((c) => c.idempotencyKey)).size, 4);
  for (const account of accounts) {
    assertEquals(w.store.topupsOf(account).length, 1);
  }
});

Deno.test("a declined card adds nothing and follows the retry schedule: 1, 3 and 7 days, then stop", async () => {
  const w = world();
  const account = w.dueAccount();
  w.stripe.cards.set("pm_FakeSaved", {
    code: "card_declined",
    decline: "insufficient_funds",
  });

  const first = await w.run();
  assertEquals([first.body.claimed, first.body.failed, first.body.credited], [
    1,
    1,
    0,
  ]);
  const [topup] = w.store.topupsOf(account);
  // Stripe's decline code is kept; the PaymentIntent was ended at Stripe.
  assertEquals(
    [topup.status, topup.failureCode],
    ["failed", "insufficient_funds"],
  );
  assertEquals(w.stripe.intents.get(topup.intentId!)?.status, "canceled");
  assertEquals(account.availableMinor, 1200);
  assertEquals(w.store.entries, []);
  assertEquals(
    [account.topupFailures, account.topupFailureCode, account.topupRetryAt],
    [1, "insufficient_funds", START + DAY],
  );

  // Nothing is tried again before the day is over.
  for (
    const wait of [MINUTE, 12 * 60 * MINUTE, DAY - 13 * 60 * MINUTE - 1000]
  ) {
    w.clock.now += wait;
    assertEquals((await w.run()).body.claimed, 0);
  }
  assertEquals(w.charges().length, 1);

  // Second, third and fourth try.
  const expected: [number, number | null][] = [[2, 3 * DAY], [3, 7 * DAY], [
    4,
    null,
  ]];
  for (const [failures, wait] of expected) {
    w.clock.now = (account.topupRetryAt as number) + 1000;
    const answer = await w.run();
    assertEquals([answer.body.claimed, answer.body.failed], [1, 1]);
    assertEquals(account.topupFailures, failures);
    assertEquals(
      account.topupRetryAt,
      wait === null ? null : w.clock.now + wait,
    );
  }
  assertEquals(w.charges().length, 4);

  // After the fourth failure nothing is charged until the merchant acts.
  for (const wait of [DAY, 7 * DAY, 60 * DAY]) {
    w.clock.now += wait;
    assertEquals((await w.run()).body.claimed, 0);
  }
  assertEquals(w.charges().length, 4);
  assertEquals(account.availableMinor, 1200);
  assertEquals(w.store.topupsOf(account).map((t) => t.status), [
    "failed",
    "failed",
    "failed",
    "failed",
  ]);
  // Four charges, four top-ups, four different keys.
  assertEquals(new Set(w.charges().map((c) => c.idempotencyKey)).size, 4);

  // The merchant saves a working card: the next run charges it.
  w.stripe.addCard("pm_FakeWorking", "cus_FakeFunded");
  await w.store.call("save_program_balance_card", {
    account_id: account.id,
    customer_id: "cus_FakeFunded",
    card: {
      payment_method_id: "pm_FakeWorking",
      brand: "visa",
      last4: "0077",
      exp_month: 2,
      exp_year: 2033,
    },
  });
  const after = await w.run();
  assertEquals([after.body.claimed, after.body.credited], [1, 1]);
  assertEquals(w.charges().at(-1)?.params.payment_method, "pm_FakeWorking");
  assertEquals(account.availableMinor, 11200);
});

Deno.test("a charge that needs the cardholder is ended and recorded as a failure", async () => {
  // Stripe answers an off-session charge that needs authentication with an
  // error; a PaymentIntent left waiting for action is handled the same way.
  for (
    const behaviour of [
      { code: "authentication_required", decline: "authentication_required" },
      "requires_action",
    ] as const
  ) {
    const w = world();
    const account = w.dueAccount();
    w.stripe.cards.set("pm_FakeSaved", behaviour);
    const answer = await w.run();
    assertEquals([answer.body.failed, answer.body.credited], [1, 0]);
    const [topup] = w.store.topupsOf(account);
    assertEquals(
      [topup.status, topup.failureCode],
      ["failed", "authentication_required"],
    );
    assertEquals(w.stripe.intents.get(topup.intentId!)?.status, "canceled");
    const [cancel] = w.stripe.posts(/cancel$/);
    assertEquals(cancel.idempotencyKey, `kma-topup-${topup.id}-cancel`);
    assertEquals(account.availableMinor, 1200);
    assertEquals(account.topupFailures, 1);
    assertEquals(account.topupRetryAt, START + DAY);
    // The canceled PaymentIntent can never add money later.
    w.clock.now += MINUTE;
    await w.run();
    assertEquals(w.charges().length, 1);
  }
});

Deno.test("decline reasons Stripe asks to hide are kept as a plain decline", async () => {
  const w = world();
  const account = w.dueAccount();
  w.stripe.cards.set("pm_FakeSaved", {
    code: "card_declined",
    decline: "stolen_card",
  });
  await w.run();
  assertEquals(account.topupFailureCode, "card_declined");
});

Deno.test("two runs at once charge an account once", async () => {
  const w = world();
  const account = w.dueAccount();
  const answers = await Promise.all([w.run(), w.run(), w.run()]);
  assertEquals(answers.map((a) => a.status), [200, 200, 200]);
  assertEquals(answers.map((a) => a.body.claimed).sort(), [0, 0, 1]);
  assertEquals(w.charges().length, 1);
  assertEquals(w.store.topupsOf(account).length, 1);
  assertEquals(account.availableMinor, 11200);
  assertEquals(w.store.entries.length, 1);
});

Deno.test("a charge whose answer was lost is looked up at Stripe, never sent again", async () => {
  const w = world();
  const account = w.dueAccount();
  // Stripe takes the payment, and the connection drops before the answer.
  w.stripe.intercept = (r) =>
    r.method === "POST" && CHARGES.test(r.path) ? "lost" : undefined;
  const first = await w.run();
  assertEquals([first.body.claimed, first.body.pending, first.body.credited], [
    1,
    1,
    0,
  ]);
  w.stripe.intercept = () => {};
  const [topup] = w.store.topupsOf(account);
  assertEquals([topup.status, topup.intentId], ["pending", null]);
  assertEquals(w.stripe.intents.size, 1);
  // Not a failure, and nothing was added yet.
  assertEquals([account.topupFailures, account.availableMinor], [0, 1200]);

  // While the top-up is open, no run charges the account again.
  for (let i = 0; i < 4; i++) {
    w.clock.now += MINUTE;
    const answer = await w.run();
    assertEquals([answer.body.claimed, answer.body.checked], [0, 0]);
  }
  assertEquals(w.charges().length, 1);

  // Once the lease has run out the charge is found at Stripe and added, once.
  w.clock.now = START + CHARGE_LEASE_SECONDS * 1000 + 1000;
  const later = await w.run();
  assertEquals([later.body.checked, later.body.credited, later.body.claimed], [
    1,
    1,
    0,
  ]);
  const [lookup] = w.stripe.requests.filter((r) =>
    r.method === "GET" && r.path === "/v1/payment_intents"
  );
  assertEquals(lookup.params.customer, "cus_FakeFunded");
  assertEquals([topup.status, account.availableMinor], ["succeeded", 11200]);
  w.clock.now += MINUTE;
  await w.run();
  assertEquals(w.charges().length, 1);
  assertEquals(w.stripe.intents.size, 1);
  assertEquals(w.store.entries.length, 1);
});

Deno.test("a charge that never reached Stripe is closed without a failure, and the next run starts afresh", async () => {
  const w = world();
  const account = w.dueAccount();
  w.stripe.intercept = (r) =>
    r.method === "POST" && CHARGES.test(r.path) ? "network" : undefined;
  await w.run();
  w.stripe.intercept = () => {};
  assertEquals(w.stripe.intents.size, 0);

  w.clock.now = START + CHARGE_LEASE_SECONDS * 1000 + 1000;
  const checked = await w.run();
  assertEquals([
    checked.body.checked,
    checked.body.canceled,
    checked.body.claimed,
  ], [1, 1, 0]);
  const [first] = w.store.topupsOf(account);
  assertEquals([first.status, first.failureCode], [
    "canceled",
    "never_charged",
  ]);
  assertEquals(account.topupFailures, 0);

  w.clock.now += MINUTE;
  const next = await w.run();
  assertEquals([next.body.claimed, next.body.credited], [1, 1]);
  // Two requests, two different top-ups, one payment at Stripe.
  assertEquals(w.charges().length, 2);
  assertEquals(new Set(w.charges().map((c) => c.idempotencyKey)).size, 2);
  assertEquals(w.stripe.intents.size, 1);
  assertEquals(account.availableMinor, 11200);
});

Deno.test("a run that stops between the charge and the database does not charge twice", async () => {
  const w = world();
  const account = w.dueAccount();
  w.store.down.add("attach_program_topup");
  w.store.down.add("settle_program_topup");
  const first = await w.run();
  assertEquals([first.status, first.body.errors, first.body.credited], [
    200,
    1,
    0,
  ]);
  assertEquals(account.availableMinor, 1200);
  w.store.down.clear();

  w.clock.now += MINUTE;
  assertEquals((await w.run()).body.claimed, 0);
  w.clock.now = START + CHARGE_LEASE_SECONDS * 1000 + 1000;
  const later = await w.run();
  assertEquals(later.body.credited, 1);
  assertEquals(w.charges().length, 1);
  assertEquals(account.availableMinor, 11200);
  assertEquals(w.store.entries.length, 1);
});

Deno.test("the worker and the webhook's settlement of the same charge add the money once", async () => {
  const w = world();
  const account = w.dueAccount();
  // The settlement fails in the worker after Stripe took the payment; the
  // top-up keeps its PaymentIntent and is settled again later.
  w.store.down.add("settle_program_topup");
  await w.run();
  w.store.down.clear();
  const [topup] = w.store.topupsOf(account);
  assertEquals(topup.status, "processing");
  const settle = {
    topup_id: topup.id,
    outcome: "succeeded",
    payment_intent_id: topup.intentId,
    livemode: true,
    amount_minor: 10000,
    currency: "usd",
    customer_id: "cus_FakeFunded",
  };
  // The webhook gets there first.
  assertEquals(
    (await w.store.call("settle_program_topup", settle)).changed,
    true,
  );
  w.clock.now = START + CHARGE_LEASE_SECONDS * 1000 + 1000;
  const later = await w.run();
  assertEquals([later.body.claimed, later.body.credited], [0, 0]);
  assertEquals(account.availableMinor, 11200);
  assertEquals(w.store.entries.length, 1);
  assertEquals(w.charges().length, 1);
});

Deno.test("a payment Stripe is still processing is added when it succeeds", async () => {
  const w = world();
  const account = w.dueAccount();
  w.stripe.cards.set("pm_FakeSaved", "processing");
  const first = await w.run();
  assertEquals([first.body.pending, first.body.credited, first.body.failed], [
    1,
    0,
    0,
  ]);
  const [topup] = w.store.topupsOf(account);
  assertEquals(topup.status, "processing");
  assertEquals(w.stripe.posts(/cancel$/).length, 0);
  const intent = w.stripe.intents.get(topup.intentId!)!;

  w.clock.now += 2 * MINUTE;
  const waiting = await w.run();
  assertEquals([
    waiting.body.checked,
    waiting.body.pending,
    waiting.body.claimed,
  ], [1, 1, 0]);

  intent.status = "succeeded";
  intent.amount_received = intent.amount;
  w.clock.now += 6 * MINUTE;
  const done = await w.run();
  assertEquals([done.body.checked, done.body.credited], [1, 1]);
  assertEquals(account.availableMinor, 11200);
  assertEquals(w.charges().length, 1);
});

Deno.test("a payment that is not what the top-up asked for is not added, and the account is not charged again", async () => {
  const w = world();
  const account = w.dueAccount();
  w.stripe.intercept = (r) => {
    if (r.method !== "GET") return;
    for (const intent of w.stripe.intents.values()) {
      intent.amount_received = 9000;
    }
  };
  const first = await w.run();
  assertEquals([first.body.mismatched, first.body.credited], [1, 0]);
  const [topup] = w.store.topupsOf(account);
  assertEquals(topup.status, "processing");
  assertEquals(account.availableMinor, 1200);
  assertEquals(w.store.entries, []);
  assert(
    w.logs.some((l) => l.level === "error" && l.outcome === "topup_mismatch"),
  );

  // Left open for a person: no run charges this account while it is.
  w.clock.now = START + CHARGE_LEASE_SECONDS * 1000 + 1000;
  const later = await w.run();
  assertEquals(
    [later.body.checked, later.body.mismatched, later.body.claimed],
    [1, 1, 0],
  );
  for (const wait of [MINUTE, 60 * MINUTE]) {
    w.clock.now += wait;
    const answer = await w.run();
    assertEquals([answer.body.claimed, answer.body.checked], [0, 0]);
  }
  assertEquals(w.charges().length, 1);
});

Deno.test("a request Stripe refuses is recorded as a failure with Stripe's code", async () => {
  const w = world();
  const account = w.dueAccount();
  w.stripe.intercept = (r) =>
    r.method === "POST" && CHARGES.test(r.path)
      ? new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "payment_method_unactivated",
            message: "not for logs",
          },
        }),
        { status: 400 },
      )
      : undefined;
  const answer = await w.run();
  assertEquals([answer.body.failed, answer.body.credited], [1, 0]);
  const [topup] = w.store.topupsOf(account);
  assertEquals(
    [topup.status, topup.failureCode, topup.intentId],
    ["failed", "payment_method_unactivated", null],
  );
  assertEquals(account.topupFailures, 1);
  assert(!JSON.stringify(w.logs).includes("not for logs"));
});

Deno.test("a refused platform key stops the run and counts no failure", async () => {
  const w = world();
  const account = w.dueAccount();
  w.stripe.intercept = () => new Response("{}", { status: 401 });
  const answer = await w.run();
  assertEquals([answer.status, answer.body.error], [
    503,
    "configuration_error",
  ]);
  const [topup] = w.store.topupsOf(account);
  assertEquals([topup.status, topup.failureCode], [
    "canceled",
    "never_charged",
  ]);
  assertEquals([account.topupFailures, account.availableMinor], [0, 1200]);
  assertEquals(w.logs.at(-1)?.level, "error");
  assert(!JSON.stringify(w.logs).includes(LIVE_KEY));
});

Deno.test("a top-up that could not be charged in time is closed unsent", async () => {
  const w = world();
  const account = w.dueAccount();
  // The claim answers late: the charge window has passed.
  const slow = new Proxy(w.store, {
    get: (target, key) =>
      key === "call"
        ? (name: BalanceFunction, input: Json) => {
          const answer = target.call(name, input);
          if (name === "claim_program_auto_topups") w.clock.now += 61_000;
          return answer;
        }
        : Reflect.get(target, key),
  });
  const worker = createProgramBalanceWorker({
    enabled: () => true,
    authenticate: () => {},
    config: () => CONFIG,
    store: () => slow,
    fetcher: w.stripe.fetch,
    now: () => w.clock.now,
    log: () => {},
  });
  const response = await worker(
    new Request("https://functions.example/program-balance-worker", {
      method: "POST",
    }),
  );
  assertEquals((await response.json()).canceled, 1);
  assertEquals(w.charges().length, 0);
  const [topup] = w.store.topupsOf(account);
  assertEquals([topup.status, topup.failureCode], [
    "canceled",
    "never_charged",
  ]);
  assertEquals(account.topupFailures, 0);
});

Deno.test("accounts that are not due are left alone", async () => {
  const cases: [string, (w: ReturnType<typeof world>) => FakeAccount][] = [
    ["automatic top-up is off", (w) => w.dueAccount({ autoTopup: false })],
    ["no saved card", (w) => w.dueAccount({ card: null })],
    ["at its minimum", (w) => w.dueAccount({ availableMinor: 5000 })],
    [
      "another platform account",
      (w) => w.dueAccount({ platformAccountId: "acct_Another" }),
    ],
    ["program money is off", (w) => {
      w.store.moneyEnabled = false;
      return w.dueAccount();
    }],
    ["the merchant paused the program", (w) => {
      w.program.status = "paused";
      w.program.pauseReason = "merchant";
      return w.dueAccount();
    }],
    [
      "the balance is in another currency than the program",
      (w) => w.dueAccount({ currency: "EUR" }),
    ],
  ];
  for (const [what, make] of cases) {
    const w = world();
    const account = make(w);
    const answer = await w.run();
    assertEquals([answer.status, answer.body.claimed], [200, 0], what);
    assertEquals(w.stripe.requests, [], what);
    assertEquals(w.store.ledgerOf(account), 0, what);
    assertEquals(w.store.topups.size, 0, what);
  }
});

Deno.test("a program paused for an empty balance is topped up and comes back", async () => {
  const w = world();
  w.program.status = "paused";
  w.program.pauseReason = "balance_empty";
  const account = w.dueAccount({ availableMinor: -300 });
  const answer = await w.run();
  assertEquals(answer.body.credited, 1);
  assertEquals(account.availableMinor, 9700);
  assertEquals([w.program.status, w.program.pauseReason], ["live", null]);
});

Deno.test("open deposits are checked against Stripe", async () => {
  const w = world();
  const console_ = createProgramBalanceHandler({
    enabled: () => true,
    origin: () => ORIGIN,
    config: () => CONFIG,
    returnUrls: () =>
      balanceReturnUrls((name) =>
        name === "CONSOLE_CONNECT_ORIGIN" ? ORIGIN : undefined
      ),
    authenticate: () => Promise.resolve({ userId: w.owner }),
    store: () => w.store,
    fetcher: w.stripe.fetch,
    random: () => fakeUuid(),
    now: () => w.clock.now,
    log: () => {},
  });
  const deposit = async (workspaceId: string, amount: number) => {
    const response = await console_(
      new Request("https://functions.example/program-balance", {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          authorization: `Bearer ${"owner-session".padEnd(40, ".")}`,
        },
        body: JSON.stringify({
          action: "deposit",
          workspace_id: workspaceId,
          amount_minor: amount,
        }),
      }),
    );
    return String((await response.json()).checkout_url).split("/").pop()!;
  };
  // Four programs, four deposits: paid without any event arriving, expired
  // at Stripe, still open, and one whose Checkout page was never made.
  const programs = [0, 1, 2, 3].map((i) =>
    w.store.addProgram({ owner: w.owner, name: `Program ${i}` })
  );
  const paid = await deposit(programs[0].workspaceId, 5000);
  const expired = await deposit(programs[1].workspaceId, 5000);
  await deposit(programs[2].workspaceId, 5000);
  w.stripe.intercept = (r) =>
    r.path === "/v1/checkout/sessions" ? "network" : undefined;
  await deposit(programs[3].workspaceId, 5000);
  w.stripe.intercept = () => {};
  const unstarted = w.store.topupsOf(w.store.accountOf(programs[3]))[0];
  // The function closed the last one itself; put it back as if it had stopped.
  assertEquals(unstarted.failureCode, "checkout_not_created");
  unstarted.status = "pending";
  unstarted.failureCode = null;
  unstarted.leaseUntil = w.clock.now + 10 * MINUTE;
  w.stripe.payCheckout(paid);
  w.stripe.sessions.get(expired)!.status = "expired";

  // A deposit is first looked at ten minutes after it was started.
  w.clock.now += 9 * MINUTE;
  assertEquals((await w.run()).body.checked, 0);
  w.clock.now += 2 * MINUTE;
  const answer = await w.run();
  assertEquals(
    [
      answer.body.checked,
      answer.body.credited,
      answer.body.canceled,
      answer.body.pending,
    ],
    [4, 1, 2, 1],
  );
  const status = (i: number) => {
    const [t] = w.store.topupsOf(w.store.accountOf(programs[i]));
    return [t.status, t.failureCode];
  };
  assertEquals(status(0), ["succeeded", null]);
  assertEquals(w.store.accountOf(programs[0]).availableMinor, 5000);
  assertEquals(status(1), ["canceled", "checkout_expired"]);
  assertEquals(status(2), ["processing", null]);
  assertEquals(status(3), ["canceled", "never_started"]);
  // The open one is looked at again five minutes later, not before.
  w.clock.now += 4 * MINUTE;
  assertEquals((await w.run()).body.checked, 0);
  w.clock.now += 2 * MINUTE;
  assertEquals((await w.run()).body.checked, 1);
  // Checks only read: nothing was charged by the worker.
  assertEquals(w.charges().length, 0);
});

Deno.test("each run first lets commissions be approved, and goes on when that fails", async () => {
  const w = world();
  const account = w.dueAccount();
  let rounds = 0;
  w.store.tick = () => {
    rounds += 1;
    return { approved: 2, retried: 1, remaining: rounds < 2 ? 40 : 0 };
  };
  const first = await w.run();
  assertEquals(w.store.calls[0], {
    name: "program_commissions_tick",
    input: { limit: TICK_LIMIT },
  });
  assertEquals(
    [
      first.body.commissions_approved,
      first.body.commissions_retried,
      first.body.commissions_remaining,
    ],
    [4, 2, 0],
  );
  assertEquals(first.body.credited, 1);

  // The commission piece is not deployed, or its tick fails: top-ups go on.
  const missing = world();
  const due = missing.dueAccount();
  missing.store.tick = null;
  const answer = await missing.run();
  assertEquals([answer.status, answer.body.errors, answer.body.credited], [
    200,
    1,
    1,
  ]);
  assertEquals(due.availableMinor, 11200);
  assert(missing.logs.some((l) => l.outcome === "commissions_tick_failed"));
  assertEquals(account.availableMinor, 11200);

  // A tick that never finishes its backlog is asked three times at most.
  const busy = world();
  busy.store.tick = () => ({ approved: 500, retried: 0, remaining: 9000 });
  const backlog = await busy.run();
  assertEquals(busy.store.called("program_commissions_tick").length, 3);
  assertEquals(
    [backlog.body.commissions_approved, backlog.body.commissions_remaining],
    [1500, 9000],
  );
});

Deno.test("switched off: the worker answers that it is off and touches nothing", async () => {
  const w = world({
    enabled: () => false,
    config: () => {
      throw new Error("the configuration was read");
    },
  });
  w.dueAccount();
  const answer = await w.run();
  assertEquals([answer.status, answer.body.enabled, answer.body.claimed], [
    200,
    false,
    0,
  ]);
  assertEquals(w.store.calls, []);
  assertEquals(w.stripe.requests, []);
});

Deno.test("the schedule and other callers each need their own credential", async () => {
  const names = ["PROGRAM_BALANCE_SCHEDULER_SECRET", "INTERNAL_WORKER_SECRET"];
  const saved = names.map((name) => Deno.env.get(name));
  const scheduler = "scheduler-fixture-00000000000000000000000";
  const internal = "internal-fixture-000000000000000000000000";
  Deno.env.set(names[0], scheduler);
  Deno.env.set(names[1], internal);
  try {
    const store = new FakeStore(() => START);
    const stripe = new FakeStripe(() => START);
    const worker = createProgramBalanceWorker({
      enabled: () => true,
      config: () => CONFIG,
      store: () => store,
      fetcher: stripe.fetch,
      now: () => START,
      log: () => {},
    });
    const call = async (headers: Record<string, string>, method = "POST") =>
      (await worker(
        new Request("https://functions.example/program-balance-worker", {
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
      await call({ "x-kma-scheduler-secret": scheduler, origin: ORIGIN }),
      401,
    );
    assertEquals(
      await call({ "x-kma-scheduler-secret": scheduler }, "GET"),
      405,
    );
    // A credential that is too short is no credential.
    Deno.env.set(names[0], "short");
    assertEquals(await call({ "x-kma-scheduler-secret": "short" }), 401);
    assertEquals(store.called("claim_program_auto_topups").length, 2);
    assertEquals(
      store.called("claim_program_auto_topups")[0].platform_account_id,
      PLATFORM,
    );
  } finally {
    names.forEach((name, i) =>
      saved[i] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, saved[i]!)
    );
  }
});

Deno.test("logs carry codes and top-up ids only", async () => {
  const w = world();
  const account = w.dueAccount();
  w.stripe.cards.set("pm_FakeSaved", {
    code: "card_declined",
    decline: "do_not_honor",
  });
  await w.run();
  const text = JSON.stringify(w.logs);
  for (
    const hidden of [
      LIVE_KEY,
      "cus_FakeFunded",
      "pm_FakeSaved",
      "4242",
      "SpeakSix",
      account.id,
    ]
  ) assert(!text.includes(hidden), hidden);
  assertEquals(w.logs.at(-1)?.outcome, "processed");
  assertEquals(w.logs.at(-1)?.counts?.failed, 1);
});
