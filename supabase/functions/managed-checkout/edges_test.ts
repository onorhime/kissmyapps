import { assertEquals } from "@std/assert";
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { createManagedCheckoutWebhook } from "../managed-checkout-webhook/index.ts";
import { createManagedCheckoutWorker } from "../managed-checkout-worker/index.ts";
import { ManagedProvider } from "./provider.ts";
import { type Json } from "./contract.ts";
import {
  FakeManagedStripe,
  fixtureBinding,
  fixtureOrder,
} from "./test-support.ts";
async function stripeEvent(event: Json, secret = fixtureBinding.webhookSecret) {
  const body = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
  return new Request(
    `https://fixture.invalid/webhook?binding_id=${fixtureBinding.id}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${t},v1=${
          bytesToHex(await hmacSha256(secret, `${t}.${body}`))
        }`,
      },
      body,
    },
  );
}
Deno.test("managed provider webhook rejects bad signatures, wrong account and mode before persistence", async () => {
  const fake = new FakeManagedStripe();
  let writes = 0;
  const handle = createManagedCheckoutWebhook({
    bindings: () => new Map([[fixtureBinding.id, fixtureBinding]]),
    provider: (b) => new ManagedProvider(b, fake.fetch),
    store: {
      rpc: () => {
        writes++;
        throw Error("unexpected database call");
      },
    },
  });
  const base = {
    id: "evt_fixture1",
    livemode: false,
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_fixture" } },
  };
  for (
    const request of [
      await stripeEvent(base, "wrong"),
      await stripeEvent({ ...base, livemode: true }),
      await stripeEvent({ ...base, account: "acct_other" }),
    ]
  ) assertEquals((await handle(request)).status >= 400, true);
  assertEquals(writes, 0);
  assertEquals(fake.calls.length, 0);
});
Deno.test("managed webhook verifies current provider payment rather than trusting event payload", async () => {
  const fake = new FakeManagedStripe(),
    p = new ManagedProvider(fixtureBinding, fake.fetch),
    order = fixtureOrder();
  const session = await p.create(order, new Date().toISOString());
  fake.pay(String(session.id));
  let snapshot: Json = {};
  const handle = createManagedCheckoutWebhook({
    bindings: () => new Map([[fixtureBinding.id, fixtureBinding]]),
    provider: () => p,
    store: {
      rpc: <T>(name: string, args: Json) => {
        if (name === "get_managed_checkout") {
          return Promise.resolve(
            { ...order, checkout_session_id: session.id } as T,
          );
        }
        if (name === "record_managed_checkout_snapshot") {
          snapshot = args.p_snapshot as Json;
          return Promise.resolve({ ...order, ...snapshot } as T);
        }
        throw Error(name);
      },
    },
  });
  assertEquals(
    (await handle(
      await stripeEvent({
        id: "evt_fixture2",
        livemode: false,
        type: "checkout.session.completed",
        data: {
          object: { id: session.id, payment_status: "unpaid", amount_total: 1 },
        },
      }),
    )).status,
    200,
  );
  assertEquals(snapshot.payment_status, "paid");
  assertEquals(snapshot.amount_minor, 16900);
});
Deno.test("managed worker leaves callback 400 and network failures retryable and acknowledges exact receipt", async () => {
  for (const mode of ["bad-request", "network", "success"]) {
    const calls: { name: string; args: Json }[] = [],
      id = crypto.randomUUID(),
      fake = new FakeManagedStripe();
    const handle = createManagedCheckoutWorker({
      bindings: () => new Map([[fixtureBinding.id, fixtureBinding]]),
      authenticate: () => {},
      workerEnabled: () => true,
      provider: (b) => new ManagedProvider(b, fake.fetch),
      store: {
        rpc: <T>(name: string, args: Json) => {
          calls.push({ name, args });
          return Promise.resolve(
            (name === "begin_managed_checkout_worker"
              ? {
                run_id: crypto.randomUUID(),
                lease_token: crypto.randomUUID(),
              }
              : name === "heartbeat_managed_checkout_worker" ||
                  name === "finish_managed_checkout_worker"
              ? true
              : name === "managed_checkout_reconcile_candidates"
              ? []
              : name === "claim_managed_checkout_deliveries"
              ? [{
                id,
                lease_token: crypto.randomUUID(),
                payload: { event_id: id },
              }]
              : null) as T,
          );
        },
      },
      fetcher: () => {
        if (mode === "network") throw Error("offline");
        return Promise.resolve(
          mode === "bad-request"
            ? Response.json({}, { status: 400 })
            : Response.json({ accepted: true, event_id: id }),
        );
      },
    });
    assertEquals(
      (await handle(
        new Request("https://fixture.invalid/worker", { method: "POST" }),
      )).status,
      200,
    );
    assertEquals(
      calls.find((c) => c.name === "finish_managed_checkout_delivery")?.args
        .p_accepted,
      mode === "success",
    );
  }
});
