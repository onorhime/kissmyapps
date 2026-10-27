import { assert, assertEquals, assertThrows } from "@std/assert";
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";
import { createManagedCheckoutWebhook } from "../managed-checkout-webhook/index.ts";
import { type Json, type ManagedBinding, managedBindings } from "./contract.ts";
import { ManagedProvider } from "./provider.ts";
import { scope } from "./service.ts";
import {
  FakeManagedStripe,
  fixtureBinding,
  fixtureOrder,
} from "./test-support.ts";
const PLATFORM = "acct_platformFixture";
const CONNECT_SECRET = "whsec_direct_connect_fixture_only";
async function signed(
  event: Json,
  secret = event.account != null
    ? CONNECT_SECRET
    : fixtureBinding.webhookSecret,
) {
  const t = Math.floor(Date.now() / 1000), body = JSON.stringify(event);
  return new Request(
    `https://fixture.invalid/managed-checkout-webhook?binding_id=${fixtureBinding.id}`,
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
async function fixture(historicalPlatform = false) {
  const fake = new FakeManagedStripe();
  fake.platformAccountId = historicalPlatform ? null : PLATFORM;
  if (historicalPlatform) fake.accountId = PLATFORM;
  const b: ManagedBinding = {
    ...fixtureBinding,
    accountId: PLATFORM,
    chargeMode: "merchant_direct",
    platformAccountId: PLATFORM,
    connectedWebhookSecret: CONNECT_SECRET,
  };
  const effective: ManagedBinding = {
    ...b,
    accountId: historicalPlatform ? PLATFORM : fixtureBinding.accountId,
    chargeMode: historicalPlatform ? undefined : "merchant_direct",
  };
  const order = fixtureOrder({
    account_id: effective.accountId,
    charge_mode: historicalPlatform ? "platform" : "merchant_direct",
    platform_account_id: PLATFORM,
    application_fee_amount: historicalPlatform ? 0 : 3380,
  });
  const p = new ManagedProvider(effective, fake.fetch);
  const session = await p.create(order, new Date().toISOString());
  order.checkout_session_id = String(session.id);
  order.payment_intent_id = fake.pay(String(session.id));
  const calls: Array<{ name: string; args: Json }> = [], snapshots: Json[] = [];
  let frozenAccount = order.account_id;
  const handle = createManagedCheckoutWebhook({
    bindings: () => new Map([[b.id, b]]),
    provider: (binding) => new ManagedProvider(binding, fake.fetch),
    store: {
      rpc: <T>(name: string, args: Json) => {
        calls.push({ name, args });
        switch (name) {
          case "resolve_managed_merchant_scope":
            return Promise.resolve(
              {
                ...scope(effective),
                account_id: frozenAccount,
                charge_mode: order.charge_mode,
                platform_account_id: PLATFORM,
              } as T,
            );
          case "get_managed_checkout":
            return Promise.resolve(order as T);
          case "record_managed_checkout_snapshot":
            snapshots.push(args.p_snapshot as Json);
            return Promise.resolve(
              { ...order, ...args.p_snapshot as Json } as T,
            );
          case "managed_checkout_fee_refund_plan":
            return Promise.resolve(null as T);
          default:
            throw Error(`Unexpected fixture RPC ${name}`);
        }
      },
    },
  });
  const event = (
    type = "checkout.session.completed",
    object: Json = { id: session.id },
    connected = !historicalPlatform,
  ) => ({
    id: "evt_directfixture",
    type,
    api_version: STRIPE_API_VERSION,
    livemode: false,
    ...(connected ? { account: order.account_id } : {}),
    data: { object },
  });
  return {
    fake,
    b,
    order,
    session,
    calls,
    snapshots,
    handle,
    event,
    setFrozenAccount: (account: string) => {
      frozenAccount = account;
    },
  };
}
Deno.test("direct webhook verifies actual merchant payment and freezes exact account/order before persisting", async () => {
  const f = await fixture();
  f.fake.calls.length = 0;
  const response = await f.handle(
    await signed(
      f.event("checkout.session.completed", {
        id: f.session.id,
        amount_total: 1,
        payment_status: "unpaid",
      }),
    ),
  );
  assertEquals(response.status, 200);
  assertEquals(f.snapshots.length, 1);
  assertEquals(f.snapshots[0].payment_status, "paid");
  assertEquals(f.snapshots[0].account_id, f.order.account_id);
  assertEquals(f.snapshots[0].application_fee_verified, true);
  const resolve = f.calls.find((c) =>
    c.name === "resolve_managed_merchant_scope"
  )!;
  assertEquals(resolve.args.p_attempt_id, f.order.attempt_id);
  assertEquals(resolve.args.p_order_id, f.order.external_order_id);
  assert(
    f.fake.calls.filter((c) =>
      c.path.startsWith("checkout/") || c.path.startsWith("payment_intents/")
    ).every((c) => c.account === f.order.account_id),
  );
});
Deno.test("direct webhook wrong mode, signature and invalid connected-account scope fail before reading payment", async () => {
  const f = await fixture();
  f.fake.calls.length = 0;
  for (
    const req of [
      await signed({ ...f.event(), livemode: true }),
      await signed(f.event(), "wrong-secret"),
      await signed({ ...f.event(), account: PLATFORM }),
    ]
  ) assertEquals((await f.handle(req)).status >= 400, true);
  assertEquals(f.fake.calls.length, 0);
  assertEquals(f.calls.length, 0);
  assertEquals(f.snapshots.length, 0);
});
Deno.test("direct webhook refuses event merchant different from frozen order merchant", async () => {
  const f = await fixture();
  f.setFrozenAccount("acct_differentMerchant");
  assertEquals((await f.handle(await signed(f.event()))).status, 409);
  assertEquals(f.calls.some((c) => c.name === "get_managed_checkout"), false);
  assertEquals(f.snapshots.length, 0);
});
Deno.test("direct webhook ignores unrelated product and unrelated payment purpose on same merchant", async () => {
  for (
    const metadata of [{ purpose: "different_product" }, {
      purpose: "kma_managed_payment",
      kma_product_id: "another-product",
      kma_funnel_id: fixtureBinding.funnelId,
    }]
  ) {
    const f = await fixture();
    f.fake.sessions.get(String(f.session.id))!.metadata = metadata;
    const response = await f.handle(await signed(f.event()));
    assertEquals(response.status, 200);
    assertEquals((await response.json()).ignored, true);
    assertEquals(f.calls.length, 0);
    assertEquals(f.snapshots.length, 0);
  }
});
Deno.test("platform application-fee event resolves its actual charge merchant and original order", async () => {
  const f = await fixture();
  f.fake.calls.length = 0;
  const fee = [...f.fake.fees.values()][0];
  const response = await f.handle(
    await signed(
      f.event("application_fee.created", {
        id: fee.id,
        account: "acct_fakePayload",
        charge: "ch_fakePayload",
      }, false),
    ),
  );
  assertEquals(response.status, 200);
  assertEquals(f.snapshots.length, 1);
  assertEquals(f.snapshots[0].application_fee_id, fee.id);
  assert(
    f.fake.calls.filter((c) => c.path.startsWith("application_fees/")).every(
      (c) => c.account === null,
    ),
  );
  assert(
    f.fake.calls.filter((c) =>
      c.path.startsWith("charges/") || c.path.startsWith("payment_intents/")
    ).every((c) => c.account === f.order.account_id),
  );
  assertEquals(
    (f.calls.find((c) => c.name === "get_managed_checkout")!.args
      .p_scope as Json).account_id,
    f.order.account_id,
  );
});
Deno.test("fee event with connected scope or wrong-mode fee cannot persist", async () => {
  const f = await fixture(), fee = [...f.fake.fees.values()][0];
  assertEquals(
    (await f.handle(
      await signed(f.event("application_fee.created", { id: fee.id }, true)),
    )).status,
    409,
  );
  fee.livemode = true;
  assertEquals(
    (await f.handle(
      await signed(f.event("application_fee.created", { id: fee.id }, false)),
    )).status >= 400,
    true,
  );
  assertEquals(f.snapshots.length, 0);
});
Deno.test("platform fee refund event uses the parent fee and never trusts claimed merchant", async () => {
  const f = await fixture(), fee = [...f.fake.fees.values()][0];
  fee.amount_refunded = 100;
  const response = await f.handle(
    await signed(
      f.event("application_fee.refund.updated", {
        id: "fr_fixture",
        fee: fee.id,
        account: "acct_forged",
      }, false),
    ),
  );
  assertEquals(response.status, 200);
  assertEquals(f.snapshots[0].application_fee_refunded_amount, 100);
  assertEquals(f.snapshots[0].account_id, f.order.account_id);
});

Deno.test("upgraded direct binding reconciles historical platform payment without a merchant header", async () => {
  const f = await fixture(true);
  f.fake.calls.length = 0;
  const response = await f.handle(await signed(f.event()));
  assertEquals(response.status, 200);
  assertEquals(f.snapshots.length, 1);
  assertEquals(f.snapshots[0].payment_status, "paid");
  assertEquals(f.snapshots[0].account_id, PLATFORM);
  assert(f.fake.calls.every((c) => c.account === null));
  assertEquals(
    (f.calls.find((c) => c.name === "get_managed_checkout")!.args
      .p_scope as Json).account_id,
    PLATFORM,
  );
  assertEquals(
    (f.calls.find((c) => c.name === "get_managed_checkout")!.args
      .p_scope as Json).charge_mode,
    undefined,
  );
});
Deno.test("upgraded direct binding reconciles historical platform refunds without a merchant header", async () => {
  const f = await fixture(true),
    payment = f.fake.payments.get(f.order.payment_intent_id!)!;
  const charge = f.fake.charges.get(String(payment.latest_charge))!;
  charge.amount_refunded = 5000;
  f.fake.refunds.set("re_platformHistory", {
    id: "re_platformHistory",
    object: "refund",
    payment_intent: payment.id,
    charge: charge.id,
    livemode: false,
    amount: 5000,
    currency: "usd",
    status: "succeeded",
    created: Math.floor(Date.now() / 1000),
  });
  f.fake.calls.length = 0;
  const response = await f.handle(
    await signed(f.event("refund.updated", { id: "re_platformHistory" })),
  );
  assertEquals(response.status, 200);
  assertEquals(f.snapshots.length, 1);
  assertEquals(f.snapshots[0].refund_id, "re_platformHistory");
  assertEquals(f.snapshots[0].refund_status, "succeeded");
  assertEquals((f.snapshots[0].facts as Json[])[0].evidence, {
    refund_id: "re_platformHistory",
    amount_minor: 5000,
    occurred_at: new Date(
      Number(f.fake.refunds.get("re_platformHistory")!.created) * 1000,
    ).toISOString(),
  });
  assertEquals(f.snapshots[0].account_id, PLATFORM);
  assert(f.fake.calls.every((c) => c.account === null));
});
Deno.test("upgraded direct binding ignores unrelated platform transactions", async () => {
  const f = await fixture(true);
  f.fake.sessions.get(String(f.session.id))!.metadata = {
    purpose: "organic_unrelated_sale",
  };
  const response = await f.handle(await signed(f.event()));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).ignored, true);
  assertEquals(f.calls.length, 0);
});
Deno.test("platform event cannot be reconciled as a connected merchant order", async () => {
  const f = await fixture(true);
  f.order.charge_mode = "merchant_direct";
  f.setFrozenAccount(fixtureBinding.accountId);
  assertEquals((await f.handle(await signed(f.event()))).status, 409);
  assertEquals(f.snapshots.length, 0);
  assertEquals(f.calls.some((c) => c.name === "get_managed_checkout"), false);
});
Deno.test("direct webhook ignores unrelated connected account transactions", async () => {
  const f = await fixture();
  f.fake.accountId = "acct_unrelatedMerchant";
  f.fake.sessions.get(String(f.session.id))!.metadata = {
    purpose: "another_integration",
  };
  const response = await f.handle(
    await signed({ ...f.event(), account: f.fake.accountId }),
  );
  assertEquals(response.status, 200);
  assertEquals((await response.json()).ignored, true);
  assertEquals(f.calls.length, 0);
  assertEquals(f.snapshots.length, 0);
});

Deno.test("direct webhook secrets are bound to connected versus platform envelopes", async () => {
  const f = await fixture();
  f.fake.calls.length = 0;
  for (
    const req of [
      await signed(f.event(), fixtureBinding.webhookSecret),
      await signed(
        f.event("application_fee.created", {
          id: [...f.fake.fees.values()][0].id,
        }, false),
        CONNECT_SECRET,
      ),
      await signed(
        f.event("checkout.session.completed", { id: f.session.id }, false),
        CONNECT_SECRET,
      ),
    ]
  ) assertEquals((await f.handle(req)).status, 400);
  assertEquals(f.fake.calls.length, 0);
  assertEquals(f.calls.length, 0);
  delete f.b.connectedWebhookSecret;
  assertEquals((await f.handle(await signed(f.event()))).status, 503);
  assertEquals(f.fake.calls.length, 0);
});
Deno.test("parsed merchant bindings require separate connected webhook secret while legacy bindings remain valid", () => {
  const names = [
    "MANAGED_CHECKOUT_BINDINGS_JSON",
    "MANAGED_CHECKOUT_BINDINGS_EXTRA_JSON",
    "MANAGED_FIXTURE_KEY",
    "MANAGED_FIXTURE_WEBHOOK",
    "MANAGED_FIXTURE_CONNECT_WEBHOOK",
  ];
  const before = new Map(names.map((name) => [name, Deno.env.get(name)]));
  try {
    Deno.env.set("MANAGED_FIXTURE_KEY", "sk_test_fixtureOnly");
    Deno.env.set("MANAGED_FIXTURE_WEBHOOK", fixtureBinding.webhookSecret);
    Deno.env.set("MANAGED_FIXTURE_CONNECT_WEBHOOK", CONNECT_SECRET);
    const raw = {
      product_id: fixtureBinding.productId,
      funnel_id: fixtureBinding.funnelId,
      account_id: PLATFORM,
      livemode: false,
      secret: "s".repeat(32),
      stripe_key_env: "MANAGED_FIXTURE_KEY",
      webhook_secret_env: "MANAGED_FIXTURE_WEBHOOK",
      callback_url: fixtureBinding.callbackUrl,
      callback_key_id: fixtureBinding.callbackKeyId,
      callback_secret: "c".repeat(32),
      redirect_origins: fixtureBinding.redirectOrigins,
    };
    const set = (extra: Json) =>
      Deno.env.set(
        "MANAGED_CHECKOUT_BINDINGS_JSON",
        JSON.stringify({ fixture: { ...raw, ...extra } }),
      );
    set({});
    assertEquals(
      managedBindings().get("fixture")!.connectedWebhookSecret,
      undefined,
    );
    set({ charge_mode: "merchant_direct", platform_account_id: PLATFORM });
    assertThrows(() => managedBindings());
    set({
      charge_mode: "merchant_direct",
      platform_account_id: PLATFORM,
      connect_webhook_secret_env: "MANAGED_FIXTURE_WEBHOOK",
    });
    assertThrows(() => managedBindings());
    set({
      charge_mode: "merchant_direct",
      platform_account_id: PLATFORM,
      connect_webhook_secret_env: "MANAGED_FIXTURE_CONNECT_WEBHOOK",
    });
    const b = managedBindings().get("fixture")!;
    assertEquals(b.webhookSecret, fixtureBinding.webhookSecret);
    assertEquals(b.connectedWebhookSecret, CONNECT_SECRET);
    // The extra secret adds bindings but never redefines an existing id.
    set({});
    Deno.env.set(
      "MANAGED_CHECKOUT_BINDINGS_EXTRA_JSON",
      JSON.stringify({ added: raw }),
    );
    assertEquals([...managedBindings().keys()], ["fixture", "added"]);
    Deno.env.set(
      "MANAGED_CHECKOUT_BINDINGS_EXTRA_JSON",
      JSON.stringify({ fixture: raw }),
    );
    assertThrows(() => managedBindings());
    Deno.env.set(
      "MANAGED_CHECKOUT_BINDINGS_EXTRA_JSON",
      JSON.stringify({ added: { ...raw, livemode: "no" } }),
    );
    assertThrows(() => managedBindings());
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});
