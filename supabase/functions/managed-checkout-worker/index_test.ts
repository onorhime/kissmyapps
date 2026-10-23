import { assertEquals } from "@std/assert";
import {
  createManagedCheckoutWorker,
  deliver,
  MAX_WORK_UNITS,
  WORK_BUDGET_MS,
} from "./index.ts";
import { fixtureBinding } from "../managed-checkout/test-support.ts";
import { type Json } from "../managed-checkout/contract.ts";
import { RequestError } from "../_shared/errors.ts";

const request = () =>
  new Request("https://fixture.invalid/worker", { method: "POST" });
function fixture() {
  const calls: { name: string; args: Json }[] = [];
  const lease = {
    run_id: crypto.randomUUID(),
    lease_token: crypto.randomUUID(),
  };
  const events = Array.from(
    { length: 10 },
    () => ({
      id: crypto.randomUUID(),
      lease_token: crypto.randomUUID(),
      payload: {},
    }),
  );
  let owned = false;
  const store = {
    rpc: <T>(name: string, args: Json): Promise<T> => {
      calls.push({ name, args });
      let result: unknown = null;
      if (name === "begin_managed_checkout_worker") {
        if (!owned) {
          owned = true;
          result = lease;
        }
      } else if (name === "heartbeat_managed_checkout_worker") result = owned;
      else if (name === "finish_managed_checkout_worker") {
        result = owned;
        owned = false;
      } else if (name === "managed_checkout_reconcile_candidates") result = [];
      else if (name === "claim_managed_checkout_deliveries") {
        result = events
          .splice(0, 1);
      }
      return Promise.resolve(result as T);
    },
  };
  return { calls, store, events };
}
Deno.test("disabled and unauthenticated worker do no database/provider work", async () => {
  for (const disabled of [true, false]) {
    const f = fixture();
    const handle = createManagedCheckoutWorker({
      store: f.store,
      workerEnabled: () => !disabled,
      authenticate: () => {
        if (!disabled) throw new RequestError(401, "unauthorized", "No");
      },
    });
    assertEquals((await handle(request())).status, disabled ? 200 : 401);
    assertEquals(f.calls.length, 0);
  }
});
Deno.test("concurrent worker invocations retain one durable owner and just-in-time claims", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let fetching!: () => void;
  const started = new Promise<void>((resolve) => fetching = resolve);
  let seen = 0;
  const handle = createManagedCheckoutWorker({
    store: f.store,
    authenticate: () => {},
    workerEnabled: () => true,
    bindings: () => new Map([[fixtureBinding.id, fixtureBinding]]),
    fetcher: async (_url, init) => {
      seen++;
      fetching();
      if (seen === 1) await gate;
      const claimed = f.calls.filter((c) =>
        c.name === "claim_managed_checkout_deliveries"
      ).length;
      const finished = f.calls.filter((c) =>
        c.name === "finish_managed_checkout_delivery"
      ).length;
      assertEquals(claimed - finished, 1);
      assertEquals(init?.signal instanceof AbortSignal, true);
      const body = JSON.parse(String(init?.body));
      return Response.json({ accepted: true, event_id: body.event_id });
    },
  });
  // Use payload ids as the actual callback acknowledgement identity.
  f.events.forEach((e) => e.payload = { event_id: e.id });
  const first = handle(request());
  await started;
  assertEquals((await handle(request())).status, 409);
  release();
  assertEquals((await first).status, 200);
  assertEquals(seen, MAX_WORK_UNITS);
  assertEquals(
    f.calls.filter((c) => c.name === "claim_managed_checkout_deliveries").every(
      (c) => c.args.p_limit === 1,
    ),
    true,
  );
});
Deno.test("a timeout retries the same event and work deadline prevents new claims", async () => {
  const f = fixture();
  let clock = 0;
  const handle = createManagedCheckoutWorker({
    store: f.store,
    now: () => clock,
    authenticate: () => {},
    workerEnabled: () => true,
    bindings: () => new Map([[fixtureBinding.id, fixtureBinding]]),
    fetcher: () => {
      clock = WORK_BUDGET_MS;
      throw new DOMException("timeout", "TimeoutError");
    },
  });
  const response = await handle(request());
  assertEquals(response.status, 200);
  assertEquals(
    f.calls.filter((c) => c.name === "claim_managed_checkout_deliveries")
      .length,
    1,
  );
  assertEquals(
    f.calls.find((c) => c.name === "finish_managed_checkout_delivery")?.args
      .p_accepted,
    false,
  );
  assertEquals(
    f.calls.find((c) => c.name === "finish_managed_checkout_worker")?.args
      .p_counts,
    { reconciled: 0, delivered: 0, failed: 1 },
  );
});
Deno.test("wrong acknowledgement and oversized callback body remain retryable", async () => {
  const event = {
    id: crypto.randomUUID(),
    lease_token: crypto.randomUUID(),
    payload: {},
  };
  for (
    const body of [{ accepted: true, event_id: crypto.randomUUID() }, {
      accepted: true,
      event_id: event.id,
      padding: "x".repeat(5000),
    }, { accepted: false, event_id: event.id }]
  ) {
    assertEquals(
      await deliver(
        fixtureBinding,
        event,
        () => Promise.resolve(Response.json(body)),
      ),
      false,
    );
  }
});
Deno.test("lost database completion does not produce a successful worker response", async () => {
  const f = fixture();
  const rpc = f.store.rpc;
  f.store.rpc = <T>(name: string, args: Json) => {
    if (
      name === "finish_managed_checkout_delivery" ||
      name === "finish_managed_checkout_worker"
    ) throw Error("db timeout");
    return rpc<T>(name, args);
  };
  const handle = createManagedCheckoutWorker({
    store: f.store,
    authenticate: () => {},
    workerEnabled: () => true,
    bindings: () => new Map([[fixtureBinding.id, fixtureBinding]]),
    fetcher: () => Promise.resolve(Response.json({ accepted: false })),
  });
  assertEquals((await handle(request())).status, 500);
  // Fake DB owner remains occupied, matching durable run recovery after crash.
  assertEquals((await handle(request())).status, 409);
});
Deno.test("schedule header requires exact database-issued UUID and rejects arbitrary input", async () => {
  const f = fixture();
  const handle = createManagedCheckoutWorker({
    store: f.store,
    authenticate: () => {},
    workerEnabled: () => true,
  });
  for (
    const body of [{ run_id: "bad" }, {
      run_id: crypto.randomUUID(),
      enabled: true,
    }]
  ) {
    const response = await handle(
      new Request("https://fixture.invalid/worker", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kma-scheduler-secret": "fixture",
        },
        body: JSON.stringify(body),
      }),
    );
    assertEquals(response.status, 400);
  }
  assertEquals(f.calls.length, 0);
});

Deno.test("default authentication separates scheduler and manual secrets and rejects browser origins", async () => {
  const keys = ["INTERNAL_WORKER_SECRET", "MANAGED_CHECKOUT_SCHEDULER_SECRET"];
  const prior = keys.map((key) => Deno.env.get(key));
  const manual = "manual-fixture-secret-".repeat(3),
    scheduled = "schedule-fixture-secret-".repeat(3);
  Deno.env.set(keys[0], manual);
  Deno.env.set(keys[1], scheduled);
  try {
    const f = fixture();
    const handle = createManagedCheckoutWorker({
      store: f.store,
      workerEnabled: () => true,
      bindings: () => new Map(),
    });
    const invoke = (
      headers: Record<string, string>,
      body = { run_id: crypto.randomUUID() },
    ) =>
      handle(
        new Request("https://fixture.invalid/worker", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      );
    assertEquals(
      (await invoke({ "x-kma-scheduler-secret": manual })).status,
      401,
    );
    assertEquals(
      (await invoke({ "x-kma-worker-secret": scheduled })).status,
      401,
    );
    assertEquals(
      (await invoke({
        "x-kma-scheduler-secret": scheduled,
        origin: "https://admin.example.invalid",
      })).status,
      401,
    );
    assertEquals(f.calls.length, 0);
    const run = crypto.randomUUID();
    assertEquals(
      (await invoke({ "x-kma-scheduler-secret": scheduled }, { run_id: run }))
        .status,
      200,
    );
    assertEquals(
      f.calls.find((c) => c.name === "begin_managed_checkout_worker")?.args
        .p_run_id,
      run,
    );
  } finally {
    keys.forEach((key, index) => {
      if (prior[index] === undefined) Deno.env.delete(key);
      else Deno.env.set(key, prior[index]!);
    });
  }
});
