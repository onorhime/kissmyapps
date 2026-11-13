import { assert, assertEquals } from "@std/assert";
import { createProgramBalanceHandler } from "../program-balance/index.ts";
import { balanceReturnUrls } from "../program-balance/config.ts";
import { BalanceStripe } from "../program-balance/stripe.ts";
import {
  CONFIG,
  type FakeAccount,
  FakeStore,
  FakeStripe,
  fakeUuid,
  LIVE_KEY,
  ORIGIN,
  PLATFORM,
  signedEventRequest,
  SIGNING,
  stripeEvent,
} from "../program-balance/testing.ts";
import type { Json } from "../program-balance/store.ts";
import {
  BALANCE_EVENTS,
  type BalanceWebhookLogEntry,
  createProgramBalanceWebhook,
  type ProgramBalanceWebhookDependencies,
} from "./index.ts";

const START = Date.UTC(2026, 10, 16, 12, 0, 0);

function world(overrides: Partial<ProgramBalanceWebhookDependencies> = {}) {
  const clock = { now: START };
  const now = () => clock.now;
  const store = new FakeStore(now);
  const stripe = new FakeStripe(now);
  const owner = fakeUuid();
  const program = store.addProgram({ owner });
  const logs: BalanceWebhookLogEntry[] = [];
  const webhook = createProgramBalanceWebhook({
    enabled: () => true,
    signing: () => SIGNING,
    config: () => CONFIG,
    store: () => store,
    fetcher: stripe.fetch,
    now,
    log: (entry) => logs.push(entry),
    ...overrides,
  });
  const console_ = createProgramBalanceHandler({
    enabled: () => true,
    origin: () => ORIGIN,
    config: () => CONFIG,
    returnUrls: () =>
      balanceReturnUrls((name) =>
        name === "CONSOLE_CONNECT_ORIGIN" ? ORIGIN : undefined
      ),
    authenticate: () => Promise.resolve({ userId: owner }),
    store: () => store,
    fetcher: stripe.fetch,
    random: () => fakeUuid(),
    now,
    log: () => {},
  });
  const merchant = async (body: Json): Promise<string> => {
    const response = await console_(
      new Request("https://functions.example/program-balance", {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          authorization: `Bearer ${"owner-session".padEnd(40, ".")}`,
        },
        body: JSON.stringify(body),
      }),
    );
    const answer = await response.json();
    assertEquals(response.status, 200, JSON.stringify(answer));
    return String(answer.checkout_url).split("/").pop() as string;
  };
  /** The merchant starts a deposit; answers the id of its Checkout Session. */
  const startDeposit = (amount: number) =>
    merchant({
      action: "deposit",
      workspace_id: program.workspaceId,
      amount_minor: amount,
    });
  const startCardChange = () =>
    merchant({ action: "card", workspace_id: program.workspaceId });
  /** Stripe delivers an event. */
  const deliver = async (event: Json, signing = SIGNING) => {
    const response = await webhook(
      await signedEventRequest(event, clock.now, signing),
    );
    return { status: response.status, body: await response.json() };
  };
  const send = (type: string, object: Json, overrides: Json = {}) =>
    deliver(stripeEvent(type, object, clock.now, overrides));
  const account = (): FakeAccount => store.accountOf(program);
  return {
    clock,
    store,
    stripe,
    program,
    logs,
    webhook,
    startDeposit,
    startCardChange,
    deliver,
    send,
    account,
  };
}

Deno.test("a deposit paid on Stripe's page is added to the balance exactly once", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  const intentId = w.stripe.payCheckout(sessionId);
  const before = w.stripe.requests.length;

  const first = await w.send(
    "checkout.session.completed",
    w.stripe.sessionObject(sessionId),
  );
  assertEquals(first.status, 200);
  assertEquals(first.body.received, true);
  const account = w.account();
  const [topup] = w.store.topupsOf(account);
  assertEquals(account.availableMinor, 5000);
  assertEquals([topup.status, topup.intentId], ["succeeded", intentId]);
  assertEquals(w.store.entries, [{
    accountId: account.id,
    kind: "deposit",
    amountMinor: 5000,
    topupId: topup.id,
  }]);
  // The card Stripe saved on the customer is the one automatic top-ups use.
  assertEquals(account.card, {
    payment_method_id: "pm_FakePaid",
    brand: "visa",
    last4: "4242",
    exp_month: 4,
    exp_year: 2031,
  });
  // The PaymentIntent was read back from Stripe before anything was settled.
  assertEquals(
    w.stripe.requests.slice(before).map((r) => `${r.method} ${r.path}`),
    [`GET /v1/payment_intents/${intentId}`],
  );
  const settle = w.store.called("settle_program_topup")[0];
  assertEquals(settle, {
    topup_id: topup.id,
    outcome: "succeeded",
    payment_intent_id: intentId,
    livemode: true,
    amount_minor: 5000,
    currency: "usd",
    customer_id: account.customerId,
    card: account.card,
  });

  // The PaymentIntent's own event arrives as well: nothing more is added.
  const second = await w.send(
    "payment_intent.succeeded",
    w.stripe.intentObject(intentId),
  );
  assertEquals(second.status, 200);
  assertEquals(account.availableMinor, 5000);
  assertEquals(w.store.entries.length, 1);
  assertEquals(w.store.ledgerOf(account), account.availableMinor);
  assertEquals(
    w.logs.map((l) => l.outcome),
    ["credited", "already_settled"],
  );
  assertEquals(
    [...w.store.events.values()].map((e) => [e.outcome, e.topupId]),
    [["credited", topup.id], ["already_settled", topup.id]],
  );
});

Deno.test("events in the other order add the money once too", async () => {
  const w = world();
  const sessionId = await w.startDeposit(8000);
  const intentId = w.stripe.payCheckout(sessionId);
  // The PaymentIntent is not known to the database yet: it is found by the
  // top-up id KissMyApps put in its metadata.
  await w.send("payment_intent.succeeded", w.stripe.intentObject(intentId));
  assertEquals(w.account().availableMinor, 8000);
  await w.send(
    "checkout.session.completed",
    w.stripe.sessionObject(sessionId),
  );
  await w.send("payment_intent.succeeded", w.stripe.intentObject(intentId));
  assertEquals(w.account().availableMinor, 8000);
  assertEquals(w.store.entries.length, 1);
});

Deno.test("the same event delivered again does nothing", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  w.stripe.payCheckout(sessionId);
  const event = stripeEvent(
    "checkout.session.completed",
    w.stripe.sessionObject(sessionId),
    w.clock.now,
  );
  assertEquals((await w.deliver(event)).body.duplicate, false);
  const requests = w.stripe.requests.length;
  const settles = w.store.called("settle_program_topup").length;
  for (let i = 0; i < 3; i++) {
    const again = await w.deliver(event);
    assertEquals([again.status, again.body.duplicate], [200, true]);
  }
  assertEquals(w.stripe.requests.length, requests);
  assertEquals(w.store.called("settle_program_topup").length, settles);
  assertEquals(w.account().availableMinor, 5000);
  assertEquals(w.store.events.get(String(event.id))?.attempts, 4);

  // The same event id with another body is refused.
  const forged = { ...event, created: (event.created as number) + 1 };
  const conflict = await w.deliver(forged);
  assertEquals(
    [conflict.status, conflict.body.error],
    [409, "event_id_conflict"],
  );
  assertEquals(w.account().availableMinor, 5000);
});

Deno.test("many deliveries at once add the money once", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  const intentId = w.stripe.payCheckout(sessionId);
  const answers = await Promise.all([
    w.send("checkout.session.completed", w.stripe.sessionObject(sessionId)),
    w.send("payment_intent.succeeded", w.stripe.intentObject(intentId)),
    w.send("checkout.session.completed", w.stripe.sessionObject(sessionId)),
    w.send("payment_intent.succeeded", w.stripe.intentObject(intentId)),
  ]);
  assertEquals(answers.map((a) => a.status), [200, 200, 200, 200]);
  assertEquals(w.account().availableMinor, 5000);
  assertEquals(w.store.entries.length, 1);
});

Deno.test("an event without a valid signature changes nothing", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  w.stripe.payCheckout(sessionId);
  const calls = w.store.calls.length;
  const requests = w.stripe.requests.length;
  const event = stripeEvent(
    "checkout.session.completed",
    w.stripe.sessionObject(sessionId),
    w.clock.now,
  );

  const wrong = await w.deliver(
    event,
    ["whsec", "AnotherEndpoint000000"].join("_"),
  );
  assertEquals([wrong.status, wrong.body.error], [400, "invalid_signature"]);

  const request = await signedEventRequest(event, w.clock.now);
  const tampered = await w.webhook(
    new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: (await request.text()).replace("5000", "9000") + " ",
    }),
  );
  assertEquals((await tampered.json()).error, "invalid_signature");

  const unsigned = await w.webhook(
    new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }),
  );
  assertEquals((await unsigned.json()).error, "invalid_signature");

  // A correctly signed event that is older than five minutes.
  const old = await w.webhook(
    await signedEventRequest(event, w.clock.now - 301_000),
  );
  assertEquals((await old.json()).error, "expired_signature");

  assertEquals(w.store.calls.length, calls);
  assertEquals(w.stripe.requests.length, requests);
  assertEquals(w.account().availableMinor, 0);
});

Deno.test("a test-mode event is refused", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  const intentId = w.stripe.payCheckout(sessionId);
  const calls = w.store.calls.length;
  const requests = w.stripe.requests.length;
  for (
    const event of [
      stripeEvent(
        "payment_intent.succeeded",
        w.stripe.intentObject(intentId),
        START,
        {
          livemode: false,
        },
      ),
      stripeEvent(
        "payment_intent.succeeded",
        { ...w.stripe.intentObject(intentId), livemode: false },
        START,
      ),
    ]
  ) {
    const answer = await w.deliver(event);
    assertEquals([answer.status, answer.body.error], [400, "event_not_live"]);
  }
  assertEquals(w.store.calls.length, calls);
  assertEquals(w.stripe.requests.length, requests);
  assertEquals(w.account().availableMinor, 0);
  assertEquals(w.store.events.size, 0);

  // Stripe itself says the PaymentIntent is not live: nothing is added.
  w.stripe.intents.get(intentId)!.livemode = false;
  const answer = await w.send(
    "payment_intent.succeeded",
    { ...w.stripe.intentObject(intentId), livemode: true },
  );
  assertEquals(answer.status, 200);
  assertEquals(w.account().availableMinor, 0);
  assertEquals(w.logs.at(-1)?.outcome, "not_live");
});

Deno.test("events of connected accounts and of other objects are not balance events", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  const intentId = w.stripe.payCheckout(sessionId);
  const calls = w.store.calls.length;
  const requests = w.stripe.requests.length;

  const connected = await w.send(
    "payment_intent.succeeded",
    w.stripe.intentObject(intentId),
    { account: "acct_SomeMerchant" },
  );
  assertEquals(
    [connected.status, connected.body.error],
    [400, "event_scope_mismatch"],
  );
  // An event type the endpoint is not meant for: acknowledged, nothing kept.
  const other = await w.send("customer.created", { id: "cus_Whoever" });
  assertEquals([other.status, other.body.ignored], [200, true]);
  assertEquals(w.store.calls.length, calls);

  // A payment on the platform account that is no top-up: acknowledged without
  // asking Stripe anything.
  const unrelated = await w.send("payment_intent.succeeded", {
    id: "pi_SomethingElse",
    object: "payment_intent",
    livemode: true,
    amount: 5000,
    metadata: {},
  });
  assertEquals([unrelated.status, unrelated.body.ignored], [200, true]);
  const refund = await w.send("charge.refunded", {
    id: "ch_SomethingElse",
    object: "charge",
    livemode: true,
    payment_intent: "pi_SomethingElse",
    amount_refunded: 5000,
  });
  assertEquals(refund.body.ignored, true);
  const session = await w.send("checkout.session.completed", {
    id: "cs_live_SomethingElse",
    object: "checkout.session",
    livemode: true,
    mode: "payment",
    payment_intent: "pi_SomethingElse",
    client_reference_id: "order-17",
    metadata: {},
  });
  assertEquals(session.body.ignored, true);
  const subscription = await w.send("checkout.session.completed", {
    id: "cs_live_Subscription",
    object: "checkout.session",
    livemode: true,
    mode: "subscription",
  });
  assertEquals(subscription.body.ignored, true);
  assertEquals(w.stripe.requests.length, requests);
  assertEquals(w.account().availableMinor, 0);
  assertEquals(BALANCE_EVENTS.length, 6);
});

Deno.test("a payment that is not exactly what the top-up asked for is not added", async () => {
  const tamper: [string, (intent: Json) => void][] = [
    ["a lower amount", (i) => {
      i.amount = 4999;
      i.amount_received = 4999;
    }],
    ["a higher amount", (i) => {
      i.amount = 500_000;
      i.amount_received = 500_000;
    }],
    ["not received in full", (i) => {
      i.amount_received = 100;
    }],
    ["another currency", (i) => {
      i.currency = "eur";
    }],
    ["another customer", (i) => {
      i.customer = "cus_SomeoneElse";
    }],
    ["no customer", (i) => {
      i.customer = null;
    }],
  ];
  for (const [what, change] of tamper) {
    const w = world();
    const sessionId = await w.startDeposit(5000);
    const intentId = w.stripe.payCheckout(sessionId);
    change(w.stripe.intents.get(intentId) as unknown as Json);
    // The event itself claims the expected payment.
    const answer = await w.send("payment_intent.succeeded", {
      ...w.stripe.intentObject(intentId),
      amount: 5000,
      amount_received: 5000,
      currency: "usd",
    });
    assertEquals(answer.status, 200, what);
    const account = w.account();
    const [topup] = w.store.topupsOf(account);
    assertEquals(account.availableMinor, 0, what);
    assertEquals(w.store.entries, [], what);
    assertEquals(topup.status, "processing", what);
    assertEquals(account.card, null, what);
    assert(
      w.logs.some((l) => l.level === "error" && l.outcome === "topup_mismatch"),
      what,
    );
    assertEquals(
      [...w.store.events.values()].at(-1)?.outcome,
      "mismatch",
      what,
    );
  }
});

Deno.test("an event that claims success is not believed when Stripe says otherwise", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  const intentId = w.stripe.payCheckout(sessionId);
  const intent = w.stripe.intents.get(intentId)!;
  intent.status = "requires_payment_method";
  intent.amount_received = 0;
  const answer = await w.send("payment_intent.succeeded", {
    ...w.stripe.intentObject(intentId),
    status: "succeeded",
    amount_received: 5000,
  });
  assertEquals(answer.status, 200);
  assertEquals(w.account().availableMinor, 0);
  assertEquals(w.store.topupsOf(w.account())[0].status, "processing");
  assertEquals(w.logs.at(-1)?.outcome, "pending");
});

Deno.test("a PaymentIntent that names one top-up and belongs to another is not added", async () => {
  const w = world();
  const first = await w.startDeposit(5000);
  const firstIntent = w.stripe.payCheckout(first);
  await w.send("payment_intent.succeeded", w.stripe.intentObject(firstIntent));
  const second = await w.startDeposit(5000);
  const secondTopup = w.store.topupsOf(w.account())[1];
  // A second PaymentIntent claims the first top-up.
  const stray = w.stripe.payCheckout(second);
  w.stripe.intents.get(stray)!.metadata = {
    kma_topup_id: w.store.topupsOf(w.account())[0].id,
  };
  const answer = await w.send(
    "payment_intent.succeeded",
    w.stripe.intentObject(stray),
  );
  assertEquals(answer.status, 200);
  assertEquals(w.account().availableMinor, 5000);
  assertEquals(w.store.entries.length, 1);
  assertEquals(secondTopup.status, "processing");
  assertEquals(w.logs.at(-1)?.outcome, "mismatch");
});

Deno.test("a failed card on Stripe's page leaves the deposit open for another try", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  const intentId = w.stripe.payCheckout(sessionId);
  const intent = w.stripe.intents.get(intentId)!;
  intent.status = "requires_payment_method";
  intent.amount_received = 0;
  intent.last_payment_error = {
    code: "card_declined",
    decline_code: "do_not_honor",
  };
  const answer = await w.send(
    "payment_intent.payment_failed",
    w.stripe.intentObject(intentId),
  );
  assertEquals(answer.status, 200);
  const account = w.account();
  const [topup] = w.store.topupsOf(account);
  assertEquals([topup.status, topup.intentId], ["processing", intentId]);
  assertEquals(account.topupFailures, 0);
  assertEquals(w.stripe.posts(/cancel$/).length, 0);
  // The merchant tries another card on the same page and it works.
  intent.status = "succeeded";
  intent.amount_received = 5000;
  await w.send("payment_intent.succeeded", w.stripe.intentObject(intentId));
  assertEquals(account.availableMinor, 5000);
});

Deno.test("an expired Checkout page closes its deposit", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  w.stripe.sessions.get(sessionId)!.status = "expired";
  const answer = await w.send(
    "checkout.session.expired",
    w.stripe.sessionObject(sessionId),
  );
  assertEquals(answer.status, 200);
  const account = w.account();
  const [topup] = w.store.topupsOf(account);
  assertEquals(
    [topup.status, topup.failureCode],
    ["canceled", "checkout_expired"],
  );
  assertEquals(account.availableMinor, 0);
  assertEquals(account.topupFailures, 0);
  // Delivered again as a new event: already closed.
  await w.send("checkout.session.expired", w.stripe.sessionObject(sessionId));
  assertEquals(w.logs.at(-1)?.outcome, "already_settled");
  // A setup page that expired is nothing to act on.
  const setup = await w.startCardChange();
  const ignored = await w.send(
    "checkout.session.expired",
    w.stripe.sessionObject(setup),
  );
  assertEquals(ignored.body.ignored, true);
});

Deno.test("an expiry that arrives for a page that was paid adds the money instead", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  w.stripe.payCheckout(sessionId);
  // The payment's own events never arrived; only the (wrong) expiry does.
  const answer = await w.send(
    "checkout.session.expired",
    w.stripe.sessionObject(sessionId),
  );
  assertEquals(answer.status, 200);
  assertEquals(w.account().availableMinor, 5000);
  assertEquals(w.store.topupsOf(w.account())[0].status, "succeeded");
});

Deno.test("a deposit that was superseded is still added when its page was paid", async () => {
  const w = world();
  const first = await w.startDeposit(5000);
  await w.startDeposit(6000);
  // The old page was still open in another tab and is paid.
  w.stripe.sessions.get(first)!.status = "open";
  const intentId = w.stripe.payCheckout(first);
  await w.send("payment_intent.succeeded", w.stripe.intentObject(intentId));
  const account = w.account();
  const [old, current] = w.store.topupsOf(account);
  assertEquals(account.availableMinor, 5000);
  assertEquals([old.status, current.status], ["succeeded", "processing"]);
  assertEquals(w.store.ledgerOf(account), 5000);
});

Deno.test("a new card saved on Stripe's page replaces the saved card", async () => {
  const w = world();
  const account = w.store.addFundedAccount(w.program, {
    topupFailures: 4,
    topupFailureCode: "expired_card",
  });
  const sessionId = await w.startCardChange();
  const setupId = w.stripe.completeSetup(sessionId);
  const before = w.stripe.requests.length;
  const answer = await w.send(
    "checkout.session.completed",
    w.stripe.sessionObject(sessionId),
  );
  assertEquals(answer.status, 200);
  assertEquals(account.card, {
    payment_method_id: "pm_FakeNew",
    brand: "mastercard",
    last4: "4444",
    exp_month: 9,
    exp_year: 2032,
  });
  // The merchant acted: automatic top-up may try again.
  assertEquals([account.topupFailures, account.topupFailureCode], [0, null]);
  // The card came from the SetupIntent as Stripe reports it, and the old card
  // was removed from the customer at Stripe.
  assertEquals(
    w.stripe.requests.slice(before).map((r) => `${r.method} ${r.path}`),
    [
      `GET /v1/setup_intents/${setupId}`,
      "POST /v1/payment_methods/pm_FakeSaved/detach",
    ],
  );
  assertEquals(w.stripe.detached, ["pm_FakeSaved"]);
  assertEquals(w.logs.at(-1)?.outcome, "card_saved");
  assertEquals(account.availableMinor, 0);

  // The event again, as a new delivery: nothing changes, nothing is detached.
  await w.send("checkout.session.completed", w.stripe.sessionObject(sessionId));
  assertEquals(w.logs.at(-1)?.outcome, "card_unchanged");
  assertEquals(w.stripe.detached, ["pm_FakeSaved"]);
});

Deno.test("a card is not saved from a setup that is not this account's", async () => {
  const w = world();
  const account = w.store.addFundedAccount(w.program);
  const sessionId = await w.startCardChange();
  const setupId = w.stripe.completeSetup(sessionId);
  const session = w.stripe.sessionObject(sessionId);

  // The SetupIntent belongs to another Stripe customer.
  const setup = w.stripe.setups.get(setupId)!;
  setup.customer = "cus_SomeoneElse";
  (w.stripe.methods.get("pm_FakeNew") as Json).customer = "cus_SomeoneElse";
  await w.send("checkout.session.completed", session);
  assertEquals(w.logs.at(-1)?.outcome, "card_not_saved");
  assertEquals(account.card?.payment_method_id, "pm_FakeSaved");

  // The card is not saved on the customer the setup names.
  setup.customer = "cus_FakeFunded";
  await w.send("checkout.session.completed", session);
  assertEquals(w.logs.at(-1)?.outcome, "card_not_saved");

  // The setup did not succeed.
  (w.stripe.methods.get("pm_FakeNew") as Json).customer = "cus_FakeFunded";
  setup.status = "requires_payment_method";
  await w.send("checkout.session.completed", session);
  assertEquals(w.logs.at(-1)?.outcome, "card_not_saved");

  // The SetupIntent names another balance account than the session.
  setup.status = "succeeded";
  setup.metadata = { kma_account_id: fakeUuid() };
  await w.send("checkout.session.completed", session);
  assertEquals(w.logs.at(-1)?.outcome, "ignored_not_balance");

  // A setup session that is not a card change of a balance.
  await w.send("checkout.session.completed", { ...session, metadata: {} });
  assertEquals(w.logs.at(-1)?.outcome, "ignored_not_balance");
  assertEquals(account.card?.payment_method_id, "pm_FakeSaved");
  assertEquals(w.stripe.detached, []);
});

Deno.test("a refund takes the refunded part back out of the balance, once", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  const intentId = w.stripe.payCheckout(sessionId);
  await w.send("payment_intent.succeeded", w.stripe.intentObject(intentId));
  const account = w.account();
  const [topup] = w.store.topupsOf(account);

  const partial = w.stripe.refund(intentId, 2000);
  // The event's own figure is not used: the charge is read back.
  await w.send("charge.refunded", { ...partial, amount_refunded: 5000 });
  assertEquals(account.availableMinor, 3000);
  assertEquals([topup.status, topup.reversedMinor], ["succeeded", 2000]);
  await w.send("charge.refunded", { ...partial });
  assertEquals(account.availableMinor, 3000);
  assertEquals(w.logs.at(-1)?.outcome, "nothing_to_reverse");
  assertEquals(w.program.status, "live");

  // The rest is refunded: the balance is empty and the program pauses.
  await w.send("charge.refunded", { ...w.stripe.refund(intentId, 5000) });
  assertEquals(account.availableMinor, 0);
  assertEquals([topup.status, topup.reversedMinor], ["reversed", 5000]);
  assertEquals(
    [w.program.status, w.program.pauseReason],
    ["paused", "balance_empty"],
  );
  assertEquals(w.store.ledgerOf(account), 0);
  assertEquals(
    w.store.entries.map((e) => [e.kind, e.amountMinor]),
    [["deposit", 5000], ["deposit_reversed", -2000], [
      "deposit_reversed",
      -3000,
    ]],
  );
});

Deno.test("a refund that overtakes the payment's own event leaves nothing behind", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  const intentId = w.stripe.payCheckout(sessionId);
  const charge = w.stripe.refund(intentId, 5000);
  // The refund event finds the top-up through its Checkout Session only after
  // the completed event; here the PaymentIntent is known first.
  await w.send("checkout.session.completed", w.stripe.sessionObject(sessionId));
  const account = w.account();
  // Settled and taken back in one go: the refunded total was on the charge.
  assertEquals(account.availableMinor, 0);
  await w.send("charge.refunded", { ...charge });
  assertEquals(account.availableMinor, 0);
  assertEquals(w.store.topupsOf(account)[0].status, "reversed");
  assertEquals(w.store.ledgerOf(account), 0);
});

Deno.test("a lost dispute takes the payment back; any other ending does not", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  const intentId = w.stripe.payCheckout(sessionId);
  await w.send("payment_intent.succeeded", w.stripe.intentObject(intentId));
  const account = w.account();
  const requests = w.stripe.requests.length;

  const won = w.stripe.dispute(intentId, "won");
  const ignored = await w.send("charge.dispute.closed", won);
  assertEquals(ignored.body.ignored, true);
  assertEquals(w.stripe.requests.length, requests);
  assertEquals(account.availableMinor, 5000);

  // The event says lost, Stripe says won: nothing moves.
  await w.send("charge.dispute.closed", { ...won, status: "lost" });
  assertEquals(account.availableMinor, 5000);
  assertEquals(w.logs.at(-1)?.outcome, "ignored_dispute_not_lost");

  const lost = w.stripe.dispute(intentId, "lost");
  await w.send("charge.dispute.closed", lost);
  assertEquals(account.availableMinor, 0);
  assertEquals(w.store.topupsOf(account)[0].status, "reversed");
  assertEquals(w.program.status, "paused");
  await w.send("charge.dispute.closed", lost);
  assertEquals(account.availableMinor, 0);
  assertEquals(w.store.entries.length, 2);
});

Deno.test("when Stripe cannot be asked the event is refused, and its next delivery is worked", async () => {
  const w = world();
  const sessionId = await w.startDeposit(5000);
  const intentId = w.stripe.payCheckout(sessionId);
  const event = stripeEvent(
    "payment_intent.succeeded",
    w.stripe.intentObject(intentId),
    w.clock.now,
  );
  w.stripe.intercept = () => "network";
  const down = await w.deliver(event);
  assertEquals([down.status, down.body.error], [502, "stripe_unavailable"]);
  assertEquals(w.account().availableMinor, 0);
  assertEquals(w.store.events.get(String(event.id))?.outcome, null);

  w.stripe.intercept = () => new Response("{}", { status: 401 });
  const refused = await w.deliver(event);
  assertEquals(
    [refused.status, refused.body.error],
    [503, "configuration_error"],
  );

  w.stripe.intercept = () => {};
  w.store.down.add("settle_program_topup");
  const database = await w.deliver(event);
  assertEquals(
    [database.status, database.body.error],
    [503, "database_boundary_error"],
  );
  w.store.down.clear();

  const again = await w.deliver(event);
  assertEquals([again.status, again.body.duplicate], [200, true]);
  assertEquals(w.account().availableMinor, 5000);
  assertEquals(w.store.events.get(String(event.id))?.outcome, "credited");
});

Deno.test("an automatic top-up is settled by its event alone", async () => {
  const w = world();
  const account = w.store.addFundedAccount(w.program, { availableMinor: 0 });
  // The worker charged the card and stopped before it stored anything.
  const claim = await w.store.call("claim_program_auto_topups", {
    platform_account_id: PLATFORM,
  });
  const claimed = (claim.topups as Json[])[0];
  const intentId = await new BalanceStripe(LIVE_KEY, {
    fetcher: w.stripe.fetch,
  })
    .chargeSavedCard({
      topupId: String(claimed.topup_id),
      accountId: account.id,
      programId: w.program.id,
      workspaceId: w.program.workspaceId,
      customerId: "cus_FakeFunded",
      amountMinor: 10000,
      currency: "USD",
    }, "pm_FakeSaved");
  const [topup] = w.store.topupsOf(account);
  assertEquals([topup.status, topup.intentId], ["pending", null]);
  await w.send("payment_intent.succeeded", w.stripe.intentObject(intentId));
  assertEquals(account.availableMinor, 10000);
  assertEquals([topup.status, topup.intentId], ["succeeded", intentId]);
});

Deno.test("a failed automatic top-up is ended at Stripe and counted once", async () => {
  const w = world();
  const account = w.store.addFundedAccount(w.program);
  w.stripe.cards.set("pm_FakeSaved", {
    code: "card_declined",
    decline: "insufficient_funds",
  });
  const claim = await w.store.call("claim_program_auto_topups", {
    platform_account_id: PLATFORM,
  });
  const claimed = (claim.topups as Json[])[0];
  await new BalanceStripe(LIVE_KEY, { fetcher: w.stripe.fetch })
    .chargeSavedCard({
      topupId: String(claimed.topup_id),
      accountId: account.id,
      programId: w.program.id,
      workspaceId: w.program.workspaceId,
      customerId: "cus_FakeFunded",
      amountMinor: 10000,
      currency: "USD",
    }, "pm_FakeSaved").catch(() => {});
  const [intentId] = [...w.stripe.intents.keys()];
  const event = w.stripe.intentObject(intentId);
  await w.send("payment_intent.payment_failed", event);
  await w.send("payment_intent.payment_failed", event);
  const [topup] = w.store.topupsOf(account);
  assertEquals(
    [topup.status, topup.failureCode],
    ["failed", "insufficient_funds"],
  );
  assertEquals(w.stripe.intents.get(intentId)?.status, "canceled");
  assertEquals(account.topupFailures, 1);
  assertEquals(account.topupRetryAt, START + 86_400_000);
  assertEquals(account.availableMinor, 0);
});

Deno.test("the endpoint is closed unless it is switched on and configured", async () => {
  const event = stripeEvent(
    "payment_intent.succeeded",
    { id: "pi_Any" },
    START,
  );
  const off = world({ enabled: () => false });
  const disabled = await off.deliver(event);
  assertEquals(
    [disabled.status, disabled.body.error],
    [503, "program_balance_disabled"],
  );
  for (const signing of [undefined, "", "not-a-signing-value"]) {
    const w = world({ signing: () => signing });
    const answer = await w.deliver(event);
    assertEquals(
      [answer.status, answer.body.error],
      [503, "configuration_error"],
    );
    assertEquals(w.store.calls, []);
  }
  const w = world();
  const request = await signedEventRequest(event, START);
  const browser = await w.webhook(
    new Request(request.url, {
      method: "POST",
      headers: { ...Object.fromEntries(request.headers), origin: ORIGIN },
      body: await request.text(),
    }),
  );
  assertEquals((await browser.json()).error, "browser_request_rejected");
  assertEquals(
    (await w.webhook(new Request(request.url))).status,
    405,
  );
  for (
    const broken of [
      { ...event, id: "not an event id" },
      { ...event, created: START / 1000 + 100_000 },
      { ...event, data: {} },
      { ...event, data: { object: { id: "x" } } },
    ]
  ) {
    const answer = await w.deliver(broken);
    assertEquals([answer.status, answer.body.error], [400, "invalid_event"]);
  }
  assertEquals(w.store.calls, []);
  assertEquals(w.stripe.requests, []);
  // Logs carry codes and ids only.
  for (const entry of [...w.logs, ...off.logs]) {
    assert(!JSON.stringify(entry).includes(LIVE_KEY));
    assert(!JSON.stringify(entry).includes(SIGNING));
  }
});
