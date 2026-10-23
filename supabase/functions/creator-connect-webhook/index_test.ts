// deno-lint-ignore-file require-await -- Fake adapters preserve the asynchronous production boundary.
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { createCreatorConnectWebhook } from "./index.ts";
import {
  ConnectProvider,
  type JsonObject,
} from "../creator-connect/provider.ts";
import {
  assertEquals,
  config,
  creator,
  FakeStripe,
  job,
  NOW,
} from "../creator-connect/test-support.ts";
async function signed(event: JsonObject, timestamp = Math.floor(NOW / 1000)) {
  const body = JSON.stringify(event),
    signature = bytesToHex(
      await hmacSha256(config.webhookSecret, `${timestamp}.${body}`),
    );
  return new Request(
    "https://local.invalid/creator-connect-webhook?binding_id=fixture",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": `t=${timestamp},v1=${signature}`,
      },
      body,
    },
  );
}
function fixture() {
  const fake = new FakeStripe(),
    observations: JsonObject[] = [],
    seen = new Set<string>();
  const handler = createCreatorConnectWebhook({
    bindings: () => new Map([["fixture", config]]),
    account: async (_config, id) =>
      id === creator.connect_account_id
        ? {
          id: creator.account_key,
          affiliate_id: creator.affiliate_id,
          connect_account_id: id,
        }
        : null,
    job: async (_config, id) => id === job.id ? job : null,
    persist: async (input) => {
      const duplicate = seen.has(String(input.event_id));
      if (!duplicate) {
        seen.add(String(input.event_id));
        observations.push(input);
      }
      return { duplicate };
    },
    provider: (c) => new ConnectProvider(c, fake.fetch, () => NOW),
    now: () => NOW,
  });
  return { fake, observations, handler };
}
const event = (type: string, object: JsonObject, id = "evt_fixture") => ({
  id,
  type,
  livemode: false,
  account: creator.connect_account_id,
  data: { object },
});
Deno.test("Connect webhook requires valid recent signature and correct mode", async () => {
  const f = fixture(), data = event("payout.failed", { id: "po_fixture" });
  assertEquals(
    (await f.handler(await signed(data, Math.floor(NOW / 1000) - 400))).status,
    400,
  );
  assertEquals(
    (await f.handler(await signed({ ...data, livemode: true }))).status,
    400,
  );
  const req = await signed(data);
  req.headers.set("Stripe-Signature", "t=1,v1=bad");
  assertEquals((await f.handler(req)).status, 400);
  assertEquals(f.fake.calls.length, 0);
});
Deno.test("payout failure is retrieved in connected-account scope and never marks a transfer paid", async () => {
  const f = fixture();
  f.fake.payouts.set(`${creator.connect_account_id}:po_fixture`, {
    id: "po_fixture",
    livemode: false,
    status: "failed",
    amount: 1500,
    currency: "usd",
    arrival_date: Math.floor(NOW / 1000),
    failure_code: "account_closed",
    bank_account: { secret: "must not persist" },
  });
  const response = await f.handler(
    await signed(event("payout.failed", { id: "po_fixture", status: "paid" })),
  );
  assertEquals(response.status, 200);
  const observed = f.observations[0];
  assertEquals((observed.bank_payout as JsonObject).status, "failed");
  assertEquals("transfer" in observed, false);
  assertEquals(JSON.stringify(observed).includes("secret"), false);
  assertEquals(
    f.fake.calls.find((c) => c.path === "payouts/po_fixture")!.headers.get(
      "Stripe-Account",
    ),
    creator.connect_account_id,
  );
});
Deno.test("duplicate and out-of-order payout webhooks use current status instead of old event payload", async () => {
  const f = fixture();
  f.fake.payouts.set(`${creator.connect_account_id}:po_fixture`, {
    id: "po_fixture",
    livemode: false,
    status: "failed",
    amount: 1500,
    currency: "usd",
  });
  const current = event("payout.failed", { id: "po_fixture" }, "evt_failed");
  await f.handler(await signed(current));
  assertEquals(
    (await (await f.handler(await signed(current))).json()).duplicate,
    true,
  );
  await f.handler(
    await signed(
      event("payout.paid", { id: "po_fixture", status: "paid" }, "evt_oldpaid"),
    ),
  );
  assertEquals(f.observations.length, 2);
  assertEquals((f.observations[1].bank_payout as JsonObject).status, "failed");
});
Deno.test("unowned or tampered account webhooks cannot write creator status", async () => {
  const f = fixture();
  assertEquals(
    (await (await f.handler(
      await signed({
        ...event("account.updated", { id: "acct_other" }),
        account: "acct_other",
      }),
    )).json()).ignored,
    true,
  );
  assertEquals(
    (await f.handler(
      await signed(event("account.updated", { id: "acct_other" })),
    )).status,
    400,
  );
  assertEquals(f.observations.length, 0);
});
Deno.test("transfer webhooks require funding-platform scope and exact approved job evidence", async () => {
  const f = fixture(),
    provider = new ConnectProvider(config, f.fake.fetch, () => NOW),
    created = await provider.execute(job);
  const data = {
    id: "evt_transfer",
    type: "transfer.created",
    livemode: false,
    data: { object: { id: created.provider_id } },
  };
  assertEquals(
    (await f.handler(
      await signed({ ...data, account: creator.connect_account_id }),
    )).status,
    400,
  );
  assertEquals((await f.handler(await signed(data))).status, 200);
  assertEquals((f.observations[0].transfer as JsonObject).job_id, job.id);
  f.fake.transfers.get(created.provider_id)!.amount = 9999;
  assertEquals(
    (await f.handler(await signed({ ...data, id: "evt_badamount" }))).status,
    409,
  );
  assertEquals(f.observations.length, 1);
});
Deno.test("merchant refunds do not bypass canonical policy through the funding webhook", async () => {
  const f = fixture();
  const response = await f.handler(
    await signed({
      id: "evt_refund",
      type: "charge.refunded",
      livemode: false,
      data: { object: { id: "ch_fixture" } },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals((await response.json()).ignored, true);
  assertEquals(f.observations.length, 0);
  assertEquals(f.fake.calls.length, 0);
});
