// The payout worker against what the database functions really return.
// backend.fixture.json holds answers captured from the database test suite
// (supabase/tests/database/82_program_payouts.sql); only the lease value was
// left out of the file, and is put back here.
import { assertEquals, assertThrows } from "@std/assert";
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import {
  CONFIG,
  LiveStripe,
  PLATFORM,
} from "../program-payout-account/testing.ts";
import { payoutContext } from "../program-payout-account/index.ts";
import { createProgramPayoutWorker } from "./index.ts";
import {
  type Json,
  parseBegun,
  parseClaim,
  parsePayout,
  type PayoutFunction,
  type PayoutStore,
} from "./store.ts";
import captured from "./backend.fixture.json" with { type: "json" };

const LEASE_FIELD = ["lease", "token"].join("_");
const LEASE = "00000000-0000-4000-8000-0000000000aa";

/** A captured answer, on this test's platform and holding a lease. */
function answer(name: keyof typeof captured): Json {
  const text = JSON.stringify(captured[name]).replaceAll(
    "acct_KMAPlatform",
    PLATFORM,
  );
  return JSON.parse(text);
}
const held = (row: Json): Json => ({ ...row, [LEASE_FIELD]: LEASE });
const claimed = (): Json => ({
  payouts: (answer("claim_program_payouts").payouts as Json[]).map(held),
});

Deno.test("a real claim answer is read as one payout to send", () => {
  assertEquals(parseClaim(claimed()), [{
    payoutId: "829ef2a3-4b78-45ab-8ed1-74a451db002a",
    lease: LEASE,
    affiliateId: "a3000000-0000-4000-8000-000000000001",
    amountMinor: 7410,
    currency: "USD",
    platformAccountId: PLATFORM,
    status: "approved",
    attempts: 0,
    firstAttemptAt: null,
    connectAccountId: "acct_AdaPay",
    accountKey: "52163001-3c30-4cf7-8b3e-a933aa281e88",
    lookupOnly: false,
  }]);
  // Without its lease a payout is not the worker's to act on.
  assertThrows(
    () => parseClaim(answer("claim_program_payouts")),
    DatabaseBoundaryError,
  );
});

Deno.test("a real begin answer names what the transfer is made of", () => {
  const begun = parseBegun(
    held(answer("begin_program_payout")),
    "829ef2a3-4b78-45ab-8ed1-74a451db002a",
  );
  assertEquals(begun, {
    amountMinor: 7410,
    currency: "USD",
    platformAccountId: PLATFORM,
    connectAccountId: "acct_AdaPay",
    firstAttemptAt: "2026-11-13T16:35:24.586Z",
  });
  assertThrows(
    () =>
      parseBegun(
        held(answer("begin_program_payout")),
        "bd58a170-fca6-485a-a031-b32ac13fc8e8",
      ),
    DatabaseBoundaryError,
  );
});

Deno.test("a payout handed back for another try reads as open, with its attempts", () => {
  const again = parsePayout(held(answer("finish_program_payout_retry")));
  assertEquals(
    [again.status, again.attempts, again.lookupOnly],
    ["processing", 2, false],
  );
});

// The names each database function accepts, from
// supabase/migrations/20261117101000_program_payouts.sql. A name outside the
// list is refused there as invalid_input.
const ACCEPTED: Record<string, string[]> = {
  claim_program_payouts: ["platform_account_id", "limit", "lease_seconds"],
  begin_program_payout: ["payout_id", LEASE_FIELD, "connect_account_id"],
  finish_program_payout: [
    "payout_id",
    LEASE_FIELD,
    "outcome",
    "transfer_id",
    "failure_code",
    "delay_seconds",
  ],
};

Deno.test("fed the real answers, the worker sends the transfer and reports it with names the database accepts", async () => {
  const calls: { name: PayoutFunction; input: Json }[] = [];
  let claims = 0;
  const store: PayoutStore = {
    call: (name, input) => {
      calls.push({ name, input });
      if (name === "claim_program_payouts") {
        claims += 1;
        return Promise.resolve(claims === 1 ? claimed() : { payouts: [] });
      }
      if (name === "set_creator_connect_account") {
        return Promise.resolve({ status: "ready" });
      }
      if (name === "begin_program_payout") {
        return Promise.resolve(held(answer("begin_program_payout")));
      }
      return Promise.resolve(answer("finish_program_payout_paid"));
    },
  };
  const stripe = new LiveStripe();
  stripe.addAccount({
    id: "acct_AdaPay",
    affiliateId: "a3000000-0000-4000-8000-000000000001",
    accountKey: "52163001-3c30-4cf7-8b3e-a933aa281e88",
  });
  const worker = createProgramPayoutWorker({
    enabled: () => true,
    authenticate: () => {},
    binding: () => CONFIG,
    store: () => store,
    fetcher: stripe.fetch,
    now: () => Date.parse("2026-11-13T16:36:00Z"),
    log: () => {},
  });
  const response = await worker(
    new Request("https://functions.example/program-payout-worker", {
      method: "POST",
    }),
  );
  const body = await response.json();
  assertEquals([response.status, body.claimed, body.paid, body.errors], [
    200,
    1,
    1,
    0,
  ]);

  const [transfer] = stripe.posts(/^\/v1\/transfers$/);
  assertEquals(
    [
      transfer.params.amount,
      transfer.params.currency,
      transfer.params.destination,
      transfer.params.transfer_group,
      transfer.idempotencyKey,
    ],
    [
      "7410",
      "usd",
      "acct_AdaPay",
      "program-payout:829ef2a3-4b78-45ab-8ed1-74a451db002a",
      "program-payout:829ef2a3-4b78-45ab-8ed1-74a451db002a",
    ],
  );

  for (const { name, input } of calls) {
    if (!(name in ACCEPTED)) continue;
    for (const key of Object.keys(input)) {
      assertEquals(
        ACCEPTED[name].includes(key),
        true,
        `${name} is sent ${key}`,
      );
    }
  }
  const finish = calls.find((call) => call.name === "finish_program_payout")!;
  assertEquals(
    [finish.input.payout_id, finish.input.outcome, finish.input[LEASE_FIELD]],
    ["829ef2a3-4b78-45ab-8ed1-74a451db002a", "paid", LEASE],
  );
  assertEquals(
    /^tr_[A-Za-z0-9]{1,250}$/.test(String(finish.input.transfer_id)),
    true,
  );
});

Deno.test("the real payout account answer has what the account function reads", async () => {
  const row = answer("program_creator_payout_context");
  const context = await payoutContext(() =>
    Promise.resolve({ data: row, error: null })
  )("Bearer fake", CONFIG);
  assertEquals(
    [
      context?.affiliate_id,
      context?.account_key,
      context?.platform_account_id,
      context?.livemode,
      context?.connect_account_id,
      typeof context?.created_at,
    ],
    [
      "a3000000-0000-4000-8000-000000000001",
      "52163001-3c30-4cf7-8b3e-a933aa281e88",
      PLATFORM,
      true,
      null,
      "string",
    ],
  );
});
