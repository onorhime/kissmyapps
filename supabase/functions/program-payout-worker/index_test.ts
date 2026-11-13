import { assert, assertEquals } from "@std/assert";
import type { JsonObject } from "../creator-connect/provider.ts";
import {
  CONFIG,
  LIVE_KEY,
  LiveStripe,
  PLATFORM,
  refusal,
  type StripeRequest,
} from "../program-payout-account/testing.ts";
import {
  BALANCE_WAIT_SECONDS,
  CLAIM_BATCH,
  createProgramPayoutWorker,
  LEASE_SECONDS,
  type PayoutWorkerLogEntry,
  type ProgramPayoutWorkerDependencies,
  retryDelaySeconds,
  REVIEW_WAIT_SECONDS,
  STOPPED_WAIT_SECONDS,
} from "./index.ts";
import {
  type FakeCreator,
  type FakePayout,
  FakePayoutStore,
} from "./testing.ts";

const START = Date.UTC(2026, 10, 17, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TRANSFERS = /^\/v1\/transfers$/;

const isTransferPost = (request: StripeRequest) =>
  request.method === "POST" && request.path === "/v1/transfers";

function world(overrides: Partial<ProgramPayoutWorkerDependencies> = {}) {
  const clock = { now: START };
  const now = () => clock.now;
  const store = new FakePayoutStore(now);
  const stripe = new LiveStripe();
  const logs: PayoutWorkerLogEntry[] = [];
  const worker = createProgramPayoutWorker({
    enabled: () => true,
    authenticate: () => {},
    binding: () => CONFIG,
    store: () => store,
    fetcher: stripe.fetch,
    now,
    log: (entry) => logs.push(entry),
    ...overrides,
  });
  const run = async () => {
    const response = await worker(
      new Request("https://functions.example/program-payout-worker", {
        method: "POST",
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  /** A creator whose Stripe account can be paid in USD, unless changed. */
  const creator = (
    account: JsonObject = {},
    options: Partial<FakeCreator> = {},
  ): FakeCreator => {
    const made = store.addCreator(options);
    if (made.id !== null) {
      stripe.addAccount({
        id: made.id,
        affiliateId: made.affiliateId,
        accountKey: made.accountKey,
      }, account);
    }
    return made;
  };
  /** A payout Stripe was asked for some time ago, with no answer kept. */
  const asked = (to: FakeCreator, hoursAgo: number, attempts = 1) =>
    store.addPayout(to, {
      status: "processing",
      connectAccountId: to.id,
      firstAttemptAt: clock.now - hoursAgo * HOUR,
      attempts,
    });
  /** A transfer Stripe already holds for a payout. */
  const existingTransfer = (
    payout: FakePayout,
    changes: JsonObject = {},
  ): string => {
    const id = `tr_FakeEarlier${stripe.fake.transfers.size + 1}`;
    stripe.fake.transfers.set(id, {
      id,
      amount: payout.amountMinor,
      amount_reversed: 0,
      currency: payout.currency.toLowerCase(),
      destination: payout.connectAccountId,
      transfer_group: `program-payout:${payout.id}`,
      metadata: { kma_job_id: payout.id },
      livemode: true,
      ...changes,
    });
    return id;
  };
  const sent = () => stripe.posts(TRANSFERS);
  const finished = () => store.named("finish_program_payout");
  return {
    clock,
    store,
    stripe,
    logs,
    worker,
    run,
    creator,
    asked,
    existingTransfer,
    sent,
    finished,
  };
}

Deno.test("an approved payout is sent as one transfer to the creator's account and marked paid", async () => {
  const w = world();
  const creator = w.creator();
  const payout = w.store.addPayout(creator);
  const answer = await w.run();
  assertEquals(answer.status, 200);
  assertEquals(
    [
      answer.body.enabled,
      answer.body.claimed,
      answer.body.paid,
      answer.body.retried,
      answer.body.failed,
      answer.body.errors,
    ],
    [true, 1, 1, 0, 0, 0],
  );

  // One POST: the whole amount, to the creator's own account, on the
  // platform's own account, named after the payout three times over.
  const [transfer] = w.sent();
  assertEquals(w.sent().length, 1);
  assertEquals(transfer.params, {
    amount: "4410",
    currency: "usd",
    destination: creator.id!,
    transfer_group: `program-payout:${payout.id}`,
    "metadata[kma_job_id]": payout.id,
  });
  assertEquals(transfer.idempotencyKey, `program-payout:${payout.id}`);
  assertEquals(transfer.authorization, `Bearer ${LIVE_KEY}`);

  // The database was asked for the platform's payouts, with a lease.
  assertEquals(w.store.named("claim_program_payouts")[0], {
    platform_account_id: PLATFORM,
    limit: CLAIM_BATCH,
    lease_seconds: LEASE_SECONDS,
  });
  // Before Stripe was asked: the creator's account was read from Stripe and
  // stored, and the database was told Stripe is about to be asked.
  const order = [
    ...w.store.calls.map((call) => call.name),
  ];
  assertEquals(order, [
    "claim_program_payouts",
    "set_creator_connect_account",
    "begin_program_payout",
    "finish_program_payout",
    "claim_program_payouts",
  ]);
  const [stored] = w.store.named("set_creator_connect_account");
  assertEquals(
    [
      stored.affiliate_id,
      stored.account_key,
      stored.connect_account_id,
      stored.platform_account_id,
      stored.livemode,
      stored.transfers_enabled,
      stored.payouts_enabled,
      stored.details_submitted,
      stored.disabled_reason,
      stored.requirements_due,
      stored.verified_at,
    ],
    [
      creator.affiliateId,
      creator.accountKey,
      creator.id,
      PLATFORM,
      true,
      true,
      true,
      true,
      null,
      [],
      new Date(START).toISOString(),
    ],
  );
  const [begun] = w.store.named("begin_program_payout");
  assertEquals(
    [begun.payout_id, begun.connect_account_id],
    [payout.id, creator.id],
  );
  const [done] = w.finished();
  assertEquals(
    [done.payout_id, done.outcome, done.transfer_id, done.failure_code],
    [payout.id, "paid", "tr_fixture1", undefined],
  );
  assertEquals(
    [payout.status, payout.transferId, payout.attempts],
    ["paid", "tr_fixture1", 1],
  );
  assertEquals(w.store.returned, []);

  // Later runs find nothing to do and do not talk to Stripe at all.
  const before = w.stripe.requests.length;
  for (let i = 0; i < 3; i++) {
    w.clock.now += MINUTE;
    const again = await w.run();
    assertEquals([again.body.claimed, again.body.paid], [0, 0]);
  }
  assertEquals(w.stripe.requests.length, before);
  assertEquals(w.sent().length, 1);
});

Deno.test("every due payout is sent in one run, a few at a time", async () => {
  const w = world();
  const payouts = Array.from(
    { length: 12 },
    () => w.store.addPayout(w.creator()),
  );
  const answer = await w.run();
  assertEquals([answer.body.claimed, answer.body.paid], [12, 12]);
  assertEquals(w.store.named("claim_program_payouts").length, 4);
  assertEquals(new Set(w.sent().map((t) => t.idempotencyKey)).size, 12);
  assert(payouts.every((payout) => payout.status === "paid"));
  // The platform is checked once per run, not once per payout.
  assertEquals(
    w.stripe.requests.filter((r) => r.path === "/v1/balance").length,
    1,
  );
});

Deno.test("an account that cannot receive money is not paid: the payout fails and the money goes back", async () => {
  const changes: [JsonObject, FakeCreator["status"]][] = [
    [{ payouts_enabled: false }, "pending"],
    [{ capabilities: { transfers: "inactive" } }, "pending"],
    [{ details_submitted: false }, "pending"],
    [{
      requirements: {
        currently_due: [],
        past_due: [],
        disabled_reason: "rejected.other",
      },
    }, "restricted"],
  ];
  for (const [change, status] of changes) {
    const w = world();
    const creator = w.creator(change);
    const payout = w.store.addPayout(creator);
    const answer = await w.run();
    assertEquals([answer.body.failed, answer.body.paid], [1, 0]);
    assertEquals(
      [payout.status, payout.failureCode],
      ["failed", "account_not_ready"],
    );
    assertEquals(w.store.returned, [payout.id]);
    // Stripe was not asked for a transfer, and the database was not told one
    // was coming.
    assertEquals(w.sent(), []);
    assertEquals(w.store.named("begin_program_payout"), []);
    assertEquals(payout.firstAttemptAt, null);
    // What Stripe says about the account is stored, so the admin page shows
    // why this creator cannot be paid.
    assertEquals([creator.status, creator.stored], [status, 1]);
  }
});

Deno.test("no payout account, an account Stripe no longer shows, or somebody else's account: failed, nothing sent", async () => {
  // No Stripe account at all.
  const none = world();
  const without = none.creator({}, { id: null, status: "not_connected" });
  const first = none.store.addPayout(without);
  await none.run();
  assertEquals(
    [first.status, first.failureCode],
    ["failed", "account_not_ready"],
  );
  assertEquals(
    none.stripe.requests.filter((r) => r.path.startsWith("/v1/accounts/")),
    [],
  );

  // Stripe says the platform has no access to the account (any more).
  const gone = world();
  const revoked = gone.creator();
  const second = gone.store.addPayout(revoked);
  gone.stripe.intercept = (request) =>
    request.path === `/v1/accounts/${revoked.id}`
      ? refusal(403, "account_invalid")
      : undefined;
  await gone.run();
  assertEquals(
    [second.status, second.failureCode],
    ["failed", "account_not_ready"],
  );

  // The Stripe account carries another creator's marks.
  const other = world();
  const mixed = other.creator({
    metadata: {
      kma_affiliate_id: "00000000-0000-4000-8000-00000000ffff",
      kma_platform_account_id: PLATFORM,
      kma_account_key: "00000000-0000-4000-8000-00000000fffe",
    },
  });
  const third = other.store.addPayout(mixed);
  await other.run();
  assertEquals(
    [third.status, third.failureCode],
    ["failed", "account_not_ready"],
  );
  assertEquals(mixed.stored, 0);
  assert(other.logs.some((entry) => entry.outcome === "account_mismatch"));

  for (const w of [none, gone, other]) {
    assertEquals(w.sent(), []);
    assertEquals(w.store.named("begin_program_payout"), []);
    assertEquals(w.store.returned.length, 1);
  }
});

Deno.test("an account that cannot be paid in the payout's currency: failed, nothing sent", async () => {
  const accounts: JsonObject[] = [
    // A Canadian account with a CAD bank account only; the payout is in USD.
    {
      country: "CA",
      default_currency: "cad",
      external_accounts: {
        data: [{
          id: "ba_FakeCad",
          object: "bank_account",
          currency: "cad",
          status: "verified",
        }],
        has_more: false,
      },
    },
    // A country the platform cannot send to.
    { country: "NG" },
  ];
  for (const account of accounts) {
    const w = world();
    const creator = w.creator(account);
    const payout = w.store.addPayout(creator);
    const answer = await w.run();
    assertEquals(answer.body.failed, 1);
    assertEquals(
      [payout.status, payout.failureCode],
      ["failed", "currency_unavailable"],
    );
    assertEquals(w.store.returned, [payout.id]);
    assertEquals(w.sent(), []);
    assertEquals(w.store.named("begin_program_payout"), []);
    // The account itself is fine and stays "ready".
    assertEquals(creator.status, "ready");
  }
});

Deno.test("too little available on the platform: the payout waits, unasked, and is sent once the money is there", async () => {
  const w = world();
  const payout = w.store.addPayout(w.creator());
  // 44.10 is to be paid; the platform has 44.09 in USD, and plenty of CAD.
  w.stripe.available = { CAD: 10_000_000, USD: 4409 };
  const first = await w.run();
  assertEquals([first.body.retried, first.body.paid, first.body.failed], [
    1,
    0,
    0,
  ]);
  const [waiting] = w.finished();
  assertEquals(
    [waiting.outcome, waiting.failure_code, waiting.delay_seconds],
    ["retry", "platform_balance_low", BALANCE_WAIT_SECONDS],
  );
  // Stripe was never asked, so the payout is still one an admin can cancel.
  assertEquals(w.sent(), []);
  assertEquals(w.store.named("begin_program_payout"), []);
  assertEquals(
    [payout.status, payout.firstAttemptAt, payout.attempts],
    ["approved", null, 0],
  );
  assertEquals(w.store.returned, []);

  // Not looked at again before the wait is over.
  w.clock.now += 5 * MINUTE;
  assertEquals((await w.run()).body.claimed, 0);

  // No USD at all is the same thing.
  w.stripe.available = { CAD: 10_000_000 };
  w.clock.now += BALANCE_WAIT_SECONDS * 1000;
  assertEquals((await w.run()).body.retried, 1);
  assertEquals(w.sent(), []);

  w.stripe.available = { CAD: 10_000_000, USD: 4410 };
  w.clock.now += BALANCE_WAIT_SECONDS * 1000;
  const last = await w.run();
  assertEquals([last.body.paid, payout.status], [1, "paid"]);
  assertEquals(w.sent().length, 1);
});

Deno.test("what the platform has available is counted down within a run", async () => {
  const w = world();
  const [one, two, three] = [0, 1, 2].map(() => w.store.addPayout(w.creator()));
  // Enough for two payouts of 44.10, not for three.
  w.stripe.available = { USD: 9000 };
  const answer = await w.run();
  assertEquals([answer.body.paid, answer.body.retried], [2, 1]);
  assertEquals(
    [one.status, two.status, three.status],
    ["paid", "paid", "approved"],
  );
  assertEquals(three.failureCode, "platform_balance_low");
  assertEquals(w.sent().length, 2);
});

Deno.test("Stripe refuses for too little balance after all: wait; if it then only repeats itself, give the money back", async () => {
  const insufficient = (replayed: boolean) => (request: StripeRequest) =>
    isTransferPost(request)
      ? refusal(
        400,
        "balance_insufficient",
        replayed ? { "Idempotent-Replayed": "true" } : {},
      )
      : undefined;

  // Stripe repeats its first refusal to the same key: the payout is over.
  const w = world();
  const payout = w.store.addPayout(w.creator());
  w.stripe.intercept = insufficient(false);
  const first = await w.run();
  assertEquals([first.body.retried, first.body.failed], [1, 0]);
  assertEquals(
    [payout.status, payout.failureCode, payout.attempts],
    ["processing", "platform_balance_low", 1],
  );
  assertEquals(w.store.returned, []);
  w.clock.now += BALANCE_WAIT_SECONDS * 1000;
  w.stripe.intercept = insufficient(true);
  const second = await w.run();
  assertEquals(second.body.failed, 1);
  assertEquals(
    [payout.status, payout.failureCode],
    ["failed", "platform_balance_low"],
  );
  assertEquals(w.store.returned, [payout.id]);
  assertEquals(w.sent().length, 2);
  assertEquals(new Set(w.sent().map((t) => t.idempotencyKey)).size, 1);

  // Stripe runs the request again and accepts it: paid, under the same key.
  const v = world();
  const other = v.store.addPayout(v.creator());
  v.stripe.intercept = insufficient(false);
  await v.run();
  v.clock.now += BALANCE_WAIT_SECONDS * 1000;
  v.stripe.intercept = null;
  const paid = await v.run();
  assertEquals([paid.body.paid, other.status, other.attempts], [1, "paid", 2]);
  assertEquals(v.store.returned, []);
  assertEquals(v.stripe.fake.transfers.size, 1);
});

Deno.test("an answer that never came: the transfer is looked up, found and never sent again", async () => {
  const w = world();
  const creator = w.creator();
  const payout = w.store.addPayout(creator);
  // Stripe makes the transfer; the connection breaks before the answer.
  w.stripe.fake.ambiguousNextTransfer = true;
  const first = await w.run();
  assertEquals([first.body.retried, first.body.paid, first.body.failed], [
    1,
    0,
    0,
  ]);
  const [unknown] = w.finished();
  assertEquals(
    [unknown.outcome, unknown.failure_code, unknown.delay_seconds],
    ["retry", "stripe_unavailable", retryDelaySeconds(1)],
  );
  assertEquals(
    [payout.status, payout.attempts, payout.firstAttemptAt],
    ["processing", 1, START],
  );
  assertEquals(w.store.returned, []);
  assertEquals(w.stripe.fake.transfers.size, 1);

  // Too early: nothing is claimed.
  w.clock.now += 5 * MINUTE;
  assertEquals((await w.run()).body.claimed, 0);

  w.clock.now += 5 * MINUTE;
  const second = await w.run();
  assertEquals(second.body.paid, 1);
  assertEquals(
    [payout.status, payout.transferId, payout.attempts],
    ["paid", "tr_fixture1", 1],
  );
  // Found by looking: one POST ever, and the database was told once that
  // Stripe would be asked.
  assertEquals(w.sent().length, 1);
  assertEquals(w.store.named("begin_program_payout").length, 1);
  const lookups = w.stripe.requests.filter((r) =>
    r.method === "GET" && r.path === "/v1/transfers"
  );
  assert(lookups.length >= 2);
  assert(
    lookups.every((r) =>
      r.query.get("transfer_group") === `program-payout:${payout.id}` &&
      r.query.get("destination") === creator.id
    ),
  );
});

Deno.test("an answer that never came and a transfer Stripe never made: asked again under the same key", async () => {
  const w = world();
  const payout = w.store.addPayout(w.creator());
  w.stripe.intercept = (request) => {
    if (isTransferPost(request)) throw new TypeError("connection lost");
    return undefined;
  };
  await w.run();
  assertEquals([payout.status, payout.attempts], ["processing", 1]);
  assertEquals(w.stripe.fake.transfers.size, 0);

  w.stripe.intercept = null;
  w.clock.now += retryDelaySeconds(1) * 1000;
  const second = await w.run();
  assertEquals([second.body.paid, payout.status], [1, "paid"]);
  assertEquals(payout.attempts, 2);
  // The first time Stripe was asked is kept.
  assertEquals(payout.firstAttemptAt, START);
  assertEquals(w.sent().length, 2);
  assertEquals(new Set(w.sent().map((t) => t.idempotencyKey)).size, 1);
  assertEquals(w.stripe.fake.transfers.size, 1);
});

Deno.test("the wait after no clear answer grows to an hour and no further", () => {
  assertEquals(
    [0, 1, 2, 3, 4, 5, 50].map(retryDelaySeconds),
    [300, 600, 1200, 2400, 3600, 3600, 3600],
  );
});

Deno.test("Stripe out of reach before anything was asked: wait, nothing sent, nothing failed", async () => {
  const w = world();
  const creator = w.creator();
  const payout = w.store.addPayout(creator);
  w.stripe.intercept = (request) =>
    request.path === `/v1/accounts/${creator.id}` ? refusal(503) : undefined;
  const answer = await w.run();
  assertEquals([answer.status, answer.body.retried], [200, 1]);
  const [waiting] = w.finished();
  assertEquals(
    [waiting.outcome, waiting.failure_code, waiting.delay_seconds],
    ["retry", "stripe_unavailable", retryDelaySeconds(0)],
  );
  assertEquals([payout.status, payout.firstAttemptAt], ["approved", null]);
  assertEquals(w.sent(), []);
});

Deno.test("after 23 hours a payout is only looked up: found means paid", async () => {
  const w = world();
  const creator = w.creator();
  const payout = w.asked(creator, 24, 3);
  const transferId = w.existingTransfer(payout);
  const answer = await w.run();
  assertEquals(answer.body.paid, 1);
  assertEquals([payout.status, payout.transferId], ["paid", transferId]);
  assertEquals(w.sent(), []);
  assertEquals(w.store.named("begin_program_payout"), []);
  assertEquals(w.store.returned, []);
});

Deno.test("after 23 hours a payout is only looked up: not found means failed, and it is never asked for again", async () => {
  const w = world();
  const creator = w.creator();
  const payout = w.asked(creator, 23.1, 3);
  // A transfer of the same creator for another payout is not this one.
  w.existingTransfer(payout, {
    transfer_group: "program-payout:another",
    metadata: { kma_job_id: "another" },
  });
  const answer = await w.run();
  assertEquals([answer.body.failed, answer.body.paid], [1, 0]);
  assertEquals(
    [payout.status, payout.failureCode],
    ["failed", "transfer_not_found"],
  );
  assertEquals(w.store.returned, [payout.id]);
  assertEquals(w.sent(), []);
  assertEquals(w.store.named("begin_program_payout"), []);
  // The account was not even read: the lookup alone decided.
  assertEquals(creator.stored, 0);
});

Deno.test("inside 23 hours a payout whose transfer is not at Stripe is asked for again", async () => {
  const w = world();
  const payout = w.asked(w.creator(), 22, 2);
  const answer = await w.run();
  assertEquals([answer.body.paid, payout.status], [1, "paid"]);
  assertEquals(w.sent().length, 1);
  assertEquals(payout.attempts, 3);
  assertEquals(payout.firstAttemptAt, START - 22 * HOUR);
});

Deno.test("the worker's own clock also refuses to ask again at 23 hours, whatever the database says", async () => {
  const w = world();
  // Exactly 23 hours: the fake database does not yet say "look up only".
  const payout = w.asked(w.creator(), 23, 2);
  const answer = await w.run();
  assertEquals([answer.body.failed, answer.body.paid], [1, 0]);
  assertEquals(
    [payout.status, payout.failureCode],
    ["failed", "transfer_not_found"],
  );
  assertEquals(w.sent(), []);
  assertEquals(w.store.named("begin_program_payout"), []);
  assertEquals(w.store.returned, [payout.id]);
});

Deno.test("a database that cannot hand out payouts ends the run before Stripe is called", async () => {
  const w = world();
  w.store.addPayout(w.creator());
  w.store.down.add("claim_program_payouts");
  const answer = await w.run();
  assertEquals(
    [answer.status, answer.body.error],
    [503, "database_boundary_error"],
  );
  assertEquals(w.stripe.requests.length, 0);
});

Deno.test("a payout that was asked for is never failed for its account while Stripe may hold its transfer", async () => {
  const w = world();
  // The account stopped being payable after Stripe made the transfer.
  const creator = w.creator({ payouts_enabled: false });
  const payout = w.asked(creator, 1);
  const transferId = w.existingTransfer(payout);
  const answer = await w.run();
  assertEquals([answer.body.paid, answer.body.failed], [1, 0]);
  assertEquals([payout.status, payout.transferId], ["paid", transferId]);
  assertEquals(w.store.returned, []);
});

Deno.test("a transfer at Stripe that is not what the payout asked for is left for a person", async () => {
  const w = world();
  const payout = w.asked(w.creator(), 2);
  w.existingTransfer(payout, { amount: payout.amountMinor + 1 });
  const answer = await w.run();
  assertEquals(
    [answer.body.retried, answer.body.paid, answer.body.failed],
    [1, 0, 0],
  );
  const [left] = w.finished();
  assertEquals(
    [left.outcome, left.failure_code, left.delay_seconds],
    ["retry", "transfer_evidence_mismatch", REVIEW_WAIT_SECONDS],
  );
  assertEquals(payout.status, "processing");
  assertEquals(w.store.returned, []);
  assertEquals(w.sent(), []);
  assert(
    w.logs.some((entry) =>
      entry.level === "error" && entry.payout_id === payout.id
    ),
  );
});

Deno.test("a transfer Stripe refuses for good fails the payout with Stripe's code in the log", async () => {
  const w = world();
  const payout = w.store.addPayout(w.creator());
  w.stripe.intercept = (request) =>
    isTransferPost(request) ? refusal(400, "transfers_not_allowed") : undefined;
  const answer = await w.run();
  assertEquals(answer.body.failed, 1);
  assertEquals(
    [payout.status, payout.failureCode, payout.attempts],
    ["failed", "transfer_rejected", 1],
  );
  assertEquals(w.store.returned, [payout.id]);
  assert(
    w.logs.some((entry) =>
      entry.payout_id === payout.id &&
      entry.provider_code === "transfers_not_allowed"
    ),
  );
  // Closed: later runs leave it alone.
  w.clock.now += HOUR;
  assertEquals((await w.run()).body.claimed, 0);
  assertEquals(w.sent().length, 1);
  assertEquals(w.store.returned.length, 1);
});

Deno.test("a lease lost before Stripe is asked: nothing is sent and nothing more is written", async () => {
  const w = world();
  const payout = w.store.addPayout(w.creator());
  w.store.before.begin_program_payout = () => w.store.takeLease(payout);
  const answer = await w.run();
  assertEquals(answer.status, 200);
  assertEquals(
    [answer.body.lease_lost, answer.body.paid, answer.body.errors],
    [1, 0, 0],
  );
  assertEquals(w.sent(), []);
  assertEquals(w.finished(), []);
  assertEquals([payout.status, payout.attempts], ["approved", 0]);
});

Deno.test("a lease lost after the transfer was made: the next holder finds the transfer, nothing is sent twice", async () => {
  const w = world();
  const payout = w.store.addPayout(w.creator());
  w.store.before.finish_program_payout = () => {
    w.store.before = {};
    w.store.takeLease(payout);
  };
  const first = await w.run();
  assertEquals([first.body.lease_lost, first.body.paid], [1, 0]);
  assertEquals(payout.status, "processing");
  assertEquals(w.sent().length, 1);

  // The other holder's lease runs out; the payout is claimed again.
  w.clock.now += 6 * MINUTE;
  const second = await w.run();
  assertEquals(second.body.paid, 1);
  assertEquals([payout.status, payout.transferId], ["paid", "tr_fixture1"]);
  assertEquals(w.sent().length, 1);
  assertEquals(w.store.returned, []);
});

Deno.test("the database fails after the transfer was made: the payout is found paid on a later run", async () => {
  const w = world();
  const [one, two] = [w.creator(), w.creator()].map((c) =>
    w.store.addPayout(c)
  );
  w.store.down.add("finish_program_payout");
  const first = await w.run();
  assertEquals(first.status, 200);
  assertEquals([first.body.errors, first.body.paid], [2, 0]);
  assertEquals(w.sent().length, 2);

  w.store.down.clear();
  w.clock.now += 6 * MINUTE;
  const second = await w.run();
  assertEquals(second.body.paid, 2);
  assertEquals([one.status, two.status], ["paid", "paid"]);
  assertEquals(w.sent().length, 2);
});

Deno.test("a creator whose Stripe account changed under a payout is left for a person", async () => {
  const w = world();
  const creator = w.creator();
  const payout = w.store.addPayout(creator, {
    status: "processing",
    connectAccountId: "acct_FakeEarlierAccount",
    firstAttemptAt: START - HOUR,
    attempts: 1,
  });
  const answer = await w.run();
  assertEquals([answer.body.retried, answer.body.failed], [1, 0]);
  const [left] = w.finished();
  assertEquals(
    [left.outcome, left.failure_code, left.delay_seconds],
    ["retry", "destination_changed", REVIEW_WAIT_SECONDS],
  );
  assertEquals(w.sent(), []);
  assertEquals(payout.status, "processing");
});

Deno.test("a refused key, a key of another account or Stripe out of reach stops the run and fails no payout", async () => {
  const cases: {
    arrange: (stripe: LiveStripe) => void;
    status: number;
    error: string;
    code: string;
  }[] = [
    {
      arrange: (stripe) => {
        stripe.intercept = () => refusal(401);
      },
      status: 503,
      error: "configuration_error",
      code: "stripe_key_refused",
    },
    {
      arrange: (stripe) => {
        stripe.fake.platformId = "acct_FakeSomebodyElse";
      },
      status: 503,
      error: "configuration_error",
      code: "funding_platform_mismatch",
    },
    {
      arrange: (stripe) => {
        stripe.intercept = () => refusal(500);
      },
      status: 502,
      error: "stripe_unavailable",
      code: "stripe_unavailable",
    },
  ];
  for (const { arrange, status, error, code } of cases) {
    const w = world();
    const payouts = [w.creator(), w.creator()].map((c) => w.store.addPayout(c));
    arrange(w.stripe);
    const answer = await w.run();
    assertEquals([answer.status, answer.body.error], [status, error]);
    // Both payouts are handed back as they were, to be tried again soon.
    assertEquals(
      w.finished().map((f) => [f.outcome, f.failure_code, f.delay_seconds]),
      payouts.map(() => ["retry", code, STOPPED_WAIT_SECONDS]),
    );
    for (const payout of payouts) {
      assertEquals([payout.status, payout.lease], ["approved", null]);
    }
    assertEquals(w.store.returned, []);
    assertEquals(w.sent(), []);
    assert(w.logs.some((entry) => entry.code === code));
  }
});

Deno.test("a key that may not make transfers stops the run at the first payout", async () => {
  const w = world();
  const [one, two] = [w.creator(), w.creator()].map((c) =>
    w.store.addPayout(c)
  );
  w.stripe.intercept = (request) =>
    isTransferPost(request) ? refusal(403) : undefined;
  const answer = await w.run();
  assertEquals(
    [answer.status, answer.body.error],
    [503, "configuration_error"],
  );
  assertEquals(w.sent().length, 1);
  assertEquals(
    [one.status, one.failureCode, two.status, two.failureCode],
    ["processing", "stripe_key_refused", "approved", "stripe_key_refused"],
  );
  assertEquals(w.store.returned, []);
});

Deno.test("no payout is started after the run's time is up", async () => {
  const w = world();
  const [one, two] = [w.creator(), w.creator()].map((c) =>
    w.store.addPayout(c)
  );
  w.stripe.intercept = (request) => {
    // Stripe is slow.
    if (isTransferPost(request)) w.clock.now += 41_000;
    return undefined;
  };
  const answer = await w.run();
  assertEquals([answer.body.claimed, answer.body.paid], [2, 1]);
  assertEquals([one.status, two.status], ["paid", "approved"]);
  // The second keeps its lease until it runs out, then goes to a later run.
  w.stripe.intercept = null;
  assertEquals((await w.run()).body.claimed, 0);
  w.clock.now += LEASE_SECONDS * 1000;
  assertEquals((await w.run()).body.paid, 1);
});

Deno.test("payouts switched off in the database: nothing is handed out and Stripe is not called", async () => {
  const w = world();
  const payout = w.store.addPayout(w.creator());
  w.store.payoutsEnabled = false;
  const answer = await w.run();
  assertEquals(answer.status, 200);
  assertEquals([answer.body.enabled, answer.body.claimed], [true, 0]);
  assertEquals(w.stripe.requests.length, 0);
  assertEquals(payout.status, "approved");
});

Deno.test("switched off: the worker answers that it is off and touches nothing", async () => {
  const untouched = () => {
    throw new Error("must not run");
  };
  const w = world({
    enabled: () => false,
    binding: untouched,
    store: untouched,
  });
  const answer = await w.run();
  assertEquals(answer.status, 200);
  assertEquals(
    [answer.body.enabled, answer.body.claimed, answer.body.paid],
    [false, 0, 0],
  );
  assertEquals(w.stripe.requests.length, 0);
  assertEquals(w.logs, []);
});

Deno.test("switched on without a console binding: a configuration error, and no payout is claimed", async () => {
  const w = world({ binding: () => null });
  w.store.addPayout(w.creator());
  const answer = await w.run();
  assertEquals(
    [answer.status, answer.body.error],
    [503, "configuration_error"],
  );
  assertEquals(w.store.calls, []);
  assertEquals(w.stripe.requests.length, 0);
  assert(w.logs.some((entry) => entry.outcome === "binding_missing"));
});

Deno.test("the schedule and other callers each need their own credential", async () => {
  const names = ["PROGRAM_PAYOUT_SCHEDULER_SECRET", "INTERNAL_WORKER_SECRET"];
  const scheduleHeader = ["x-kma-scheduler", "secret"].join("-");
  const personHeader = ["x-kma-worker", "secret"].join("-");
  const saved = names.map((name) => Deno.env.get(name));
  const scheduler = "payout-scheduler-fixture-000000000000000";
  const internal = "payout-internal-fixture-0000000000000000";
  Deno.env.set(names[0], scheduler);
  Deno.env.set(names[1], internal);
  try {
    const w = world();
    // The real check of the caller, with everything behind it faked.
    const worker = createProgramPayoutWorker({
      enabled: () => true,
      binding: () => CONFIG,
      store: () => w.store,
      fetcher: w.stripe.fetch,
      log: () => {},
    });
    const call = async (headers: Record<string, string>, method = "POST") =>
      (await worker(
        new Request("https://functions.example/program-payout-worker", {
          method,
          headers,
        }),
      )).status;
    assertEquals(await call({ [scheduleHeader]: scheduler }), 200);
    assertEquals(await call({ [personHeader]: internal }), 200);
    assertEquals(await call({ [scheduleHeader]: internal }), 401);
    assertEquals(await call({ [personHeader]: scheduler }), 401);
    assertEquals(await call({ [personHeader]: "" }), 401);
    assertEquals(await call({}), 401);
    // Never from a browser.
    assertEquals(
      await call({
        [scheduleHeader]: scheduler,
        origin: "https://creators.kissmyapps.example",
      }),
      401,
    );
    assertEquals(await call({ [scheduleHeader]: scheduler }, "GET"), 405);
    // A credential too short to be one is refused even when it matches.
    Deno.env.set(names[0], "short");
    assertEquals(await call({ [scheduleHeader]: "short" }), 401);
    // A refused caller reaches neither the database nor Stripe.
    Deno.env.delete(names[1]);
    w.store.addPayout(w.creator());
    const before = w.store.calls.length;
    assertEquals(await call({ [personHeader]: internal }), 401);
    assertEquals(w.store.calls.length, before);
  } finally {
    names.forEach((name, i) =>
      saved[i] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, saved[i]!)
    );
  }
});

Deno.test("logs carry outcome codes and payout ids only", async () => {
  const w = world();
  const creator = w.creator();
  const paid = w.store.addPayout(creator);
  const failed = w.store.addPayout(w.creator({ payouts_enabled: false }));
  const answer = await w.run();
  assertEquals([answer.body.paid, answer.body.failed], [1, 1]);
  const allowed = new Set([
    "level",
    "worker",
    "outcome",
    "request_id",
    "payout_id",
    "code",
    "provider_code",
    "counts",
  ]);
  for (const entry of w.logs) {
    assert(Object.keys(entry).every((key) => allowed.has(key)));
    assertEquals(entry.worker, "program-payout-worker");
  }
  assertEquals(
    w.logs.filter((entry) => entry.payout_id).map((entry) => [
      entry.payout_id,
      entry.outcome,
      entry.code,
    ]),
    [[paid.id, "paid", undefined], [failed.id, "failed", "account_not_ready"]],
  );
  const text = JSON.stringify(w.logs);
  for (
    const absent of [
      LIVE_KEY,
      creator.id!,
      creator.affiliateId,
      "tr_fixture1",
      "4410",
      PLATFORM,
    ]
  ) assert(!text.includes(absent));
  // The answer to the caller is counts only.
  assertEquals(Object.keys(answer.body).sort(), [
    "claimed",
    "enabled",
    "errors",
    "failed",
    "lease_lost",
    "paid",
    "request_id",
    "retried",
    "status",
    "worker",
  ]);
});
