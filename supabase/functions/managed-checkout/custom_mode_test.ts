import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { RequestError } from "../_shared/errors.ts";
import {
  type Json,
  type ManagedOrder,
  publicOrder,
  validateInput,
} from "./contract.ts";
import { ManagedProvider } from "./provider.ts";
import { ManagedCheckoutService, type ManagedStore } from "./service.ts";
import {
  FakeManagedStripe,
  fixtureBinding,
  fixtureInput,
  fixtureOrder,
} from "./test-support.ts";

const customInput = (overrides: Json = {}) => {
  const { success_url: _s, cancel_url: _c, ...base } = fixtureInput();
  return {
    ...base,
    ui_mode: "custom" as const,
    return_url: "https://marathon.example.invalid/pay/return",
    ...overrides,
  };
};
const customOrder = (overrides: Partial<ManagedOrder> = {}) =>
  fixtureOrder({ request: customInput(), ...overrides });

/** Just enough persistence to drive the service's create/status paths. */
function memoryStore(initial: ManagedOrder) {
  let order = { ...initial };
  const calls: string[] = [];
  const store: ManagedStore = {
    rpc<T>(name: string, args: Json): Promise<T> {
      calls.push(name);
      if (
        name === "prepare_managed_checkout" || name === "get_managed_checkout"
      ) {
        return Promise.resolve(order as T);
      }
      if (name === "begin_managed_checkout_operation") {
        order.first_attempt_at ??= new Date().toISOString();
        return Promise.resolve(
          {
            id: crypto.randomUUID(),
            first_attempt_at: order.first_attempt_at,
          } as T,
        );
      }
      if (name === "record_managed_checkout_snapshot") {
        const s = args.p_snapshot as Json;
        order = {
          ...order,
          checkout_session_id: String(s.checkout_session_id),
          checkout_url: s.session_status === "open"
            ? s.checkout_url as string | null
            : null,
          session_status: String(s.session_status),
          payment_status: String(s.payment_status),
          payment_intent_id: s.payment_intent_id as string | null,
          paid_at: s.paid_at as string | null,
          status: s.paid_at ? "paid" : "open",
        };
        return Promise.resolve(order as T);
      }
      return Promise.resolve(null as T);
    },
  };
  return { store, calls, current: () => order };
}

Deno.test("custom mode requires return_url and forbids hosted redirects", () => {
  assertEquals(validateInput(customInput(), fixtureBinding).ui_mode, "custom");
  for (
    const patch of [
      { return_url: undefined },
      { return_url: "https://foreign.example/return" },
      { success_url: "https://marathon.example.invalid/complete" },
      { cancel_url: "https://marathon.example.invalid/offer" },
      { ui_mode: "embedded" },
    ]
  ) {
    assertThrows(
      () => validateInput(customInput(patch), fixtureBinding),
      RequestError,
    );
  }
  // Hosted requests cannot carry a custom return address.
  assertThrows(
    () =>
      validateInput(
        { ...fixtureInput(), return_url: "https://marathon.example.invalid/r" },
        fixtureBinding,
      ),
    RequestError,
  );
});

Deno.test("custom session has no hosted URL and returns its client secret once open", async () => {
  const fake = new FakeManagedStripe(),
    p = new ManagedProvider(fixtureBinding, fake.fetch),
    order = customOrder(),
    session = await p.create(order, new Date().toISOString());
  const post = fake.calls.find((c) =>
    c.method === "POST" && c.path === "checkout/sessions"
  )!;
  assertEquals(post.form.ui_mode, "custom");
  assertEquals(
    post.form.return_url,
    "https://marathon.example.invalid/pay/return",
  );
  assertEquals(post.form.success_url, undefined);
  assertEquals(post.form.cancel_url, undefined);
  assertEquals(post.form["payment_method_types[0]"], "card");
  const snapshot = await p.snapshot(order, session);
  assertEquals(snapshot?.checkout_url, null);
  assertEquals(snapshot?.session_status, "open");
  const opened = { ...order, checkout_session_id: String(session.id) };
  assertEquals(
    p.clientSecret(session, opened),
    `${session.id}_secret_fixtureOnly`,
  );
  // A hosted order never exposes a browser secret, even for a custom session.
  assertThrows(
    () =>
      p.clientSecret(session, {
        ...fixtureOrder(),
        checkout_session_id: String(session.id),
      }),
    RequestError,
  );
});

Deno.test("custom and hosted sessions cannot be swapped during reconciliation", async () => {
  const fake = new FakeManagedStripe(),
    p = new ManagedProvider(fixtureBinding, fake.fetch),
    hosted = await p.create(fixtureOrder(), new Date().toISOString());
  await assertRejects(() => p.snapshot(customOrder(), hosted), RequestError);
  const fake2 = new FakeManagedStripe(),
    p2 = new ManagedProvider(fixtureBinding, fake2.fetch),
    custom = await p2.create(customOrder(), new Date().toISOString());
  await assertRejects(() => p2.snapshot(fixtureOrder(), custom), RequestError);
});

Deno.test("service returns the client secret on create, replay and status, never in the public order", async () => {
  const fake = new FakeManagedStripe(),
    provider = new ManagedProvider(fixtureBinding, fake.fetch),
    mem = memoryStore(customOrder()),
    service = new ManagedCheckoutService(mem.store, provider, true);
  const created = await service.execute(customInput());
  const secret = String(created.client_secret);
  assert(secret.endsWith("_secret_fixtureOnly"));
  assertEquals((created.order as Json).checkout_url, null);
  assert(!JSON.stringify(created.order).includes("secret"));
  assert(!JSON.stringify(publicOrder(mem.current())).includes("_secret_"));
  // A byte-identical replay reuses the session and its secret.
  const replay = await service.execute(customInput());
  assertEquals(replay.client_secret, secret);
  assertEquals(
    fake.calls.filter((c) =>
      c.method === "POST" && c.path === "checkout/sessions"
    )
      .length,
    1,
  );
  const status = await service.execute({
    action: "status",
    order_id: fixtureInput().order_id,
    attempt_id: fixtureInput().attempt_id,
  });
  assertEquals(status.client_secret, secret);
  // Once paid the secret is withheld; the order carries the verified state.
  fake.pay(String(mem.current().checkout_session_id));
  const paid = await service.execute({
    action: "status",
    order_id: fixtureInput().order_id,
    attempt_id: fixtureInput().attempt_id,
  });
  assertEquals(paid.client_secret, undefined);
  assertEquals((paid.order as Json).payment_status, "paid");
});
