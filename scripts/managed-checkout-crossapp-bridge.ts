/** Local acceptance bridge. Production code never imports this file. */
import { createManagedCheckoutHandler } from "../supabase/functions/managed-checkout/index.ts";
import { createManagedCheckoutWorker } from "../supabase/functions/managed-checkout-worker/index.ts";
import { ManagedProvider } from "../supabase/functions/managed-checkout/provider.ts";
import {
  FakeManagedStripe,
  fixtureBinding,
} from "../supabase/functions/managed-checkout/test-support.ts";
import { RequestError } from "../supabase/functions/_shared/errors.ts";
const origin = Deno.env.get("CROSSAPP_CONTROL_ORIGIN") ?? "";
const u = new URL(origin);
if (u.protocol !== "http:" || u.hostname !== "127.0.0.1") {
  throw Error("Loopback fixture required");
}
const secret = "crossapp-control-secret-fixture-only";
const fake = new FakeManagedStripe();
fake.accountId = "acct_fixture";
const merchantDirect = Deno.env.get("CROSSAPP_MERCHANT_DIRECT") === "1";
if (merchantDirect) fake.platformAccountId = "acct_platformFixture";
fake.priceId = "price_ManagedCrossappFixture";
const binding = {
  ...fixtureBinding,
  accountId: merchantDirect ? fake.platformAccountId! : fake.accountId,
  ...(merchantDirect
    ? {
      chargeMode: "merchant_direct" as const,
      platformAccountId: fake.platformAccountId!,
    }
    : {}),
  callbackUrl: origin + "/kma-events",
  redirectOrigins: [origin],
};
const store = {
  async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const response = await fetch(origin + "/rpc/kma", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fixture-control": secret,
      },
      body: JSON.stringify({ name, args }),
    });
    const result = await response.json();
    if (result.error) {
      console.error("RPC failure", name, result.error);
      throw new RequestError(
        result.error.code === "P0002" ? 404 : 409,
        "fixture_database_rejected",
        result.error.message,
      );
    }
    return result.data as T;
  },
};
const deps = {
  bindings: () => new Map([[binding.id, binding]]),
  enabled: () => true,
  store,
  provider: (effective: typeof binding) =>
    new ManagedProvider(effective, fake.fetch),
  now: Date.now,
};
const checkout = createManagedCheckoutHandler(deps);
const worker = createManagedCheckoutWorker({
  ...deps,
  workerEnabled: () => true,
  authenticate: () => {},
  fetcher: async (url, options) => {
    if (String(url) !== binding.callbackUrl) {
      throw Error("External callback blocked");
    }
    return fetch(url, options);
  },
});
Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) =>
    console.log(
      JSON.stringify({
        port,
        binding: {
          id: binding.id,
          secret: binding.secret,
          callbackKeyId: binding.callbackKeyId,
          callbackSecret: binding.callbackSecret,
        },
      }),
    ),
}, async (request) => {
  const path = new URL(request.url).pathname;
  if (path === "/functions/v1/managed-checkout") return checkout(request);
  if (request.headers.get("x-fixture-control") !== secret) {
    return Response.json({ error: "fixture authorization required" }, {
      status: 401,
    });
  }
  if (path === "/__fixture/worker") return worker(request);
  if (path === "/__fixture/state") {
    return Response.json({
      sessions: [...fake.sessions.values()],
      payments: [...fake.payments.values()],
      refunds: [...fake.refunds.values()],
      fees: [...fake.fees.values()],
      feeRefunds: [...fake.feeRefunds.values()],
      calls: fake.calls,
    });
  }
  if (path === "/__fixture/control") {
    const input = await request.json();
    if (input.action === "pay") fake.pay(input.sessionId);
    else if (input.action === "lose-create") fake.failAfterCreate = true;
    else if (input.action === "lose-refund") fake.failAfterRefund = true;
    else if (input.action === "wrong-mode") fake.livemode = input.value;
    else if (input.action === "expire") {
      const session = fake.sessions.get(input.sessionId);
      if (!session) throw Error("Unknown session");
      session.status = "expired";
    } else {return Response.json({ error: "Unknown fixture action" }, {
        status: 400,
      });}
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Unknown fixture route" }, { status: 404 });
});
