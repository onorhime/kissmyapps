import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { RequestError } from "../_shared/errors.ts";
import { attributionHash } from "../external-commerce/contract.ts";
import { type Json, type ManagedBinding, validateInput } from "./contract.ts";
import { ManagedProvider } from "./provider.ts";
import {
  ManagedCheckoutService,
  resolveManagedBinding,
  scope,
} from "./service.ts";
import {
  FakeManagedStripe,
  fixtureBinding,
  fixtureInput,
  fixtureOrder,
} from "./test-support.ts";

const platformId = "acct_platformFixture";
function setup(fee = 3380) {
  const fake = new FakeManagedStripe();
  fake.platformAccountId = platformId;
  const binding: ManagedBinding = {
    ...fixtureBinding,
    chargeMode: "merchant_direct",
    platformAccountId: platformId,
  };
  const order = fixtureOrder({
    charge_mode: "merchant_direct",
    platform_account_id: platformId,
    application_fee_amount: fee,
  });
  return {
    fake,
    binding,
    order,
    provider: new ManagedProvider(binding, fake.fetch),
  };
}
async function paid(fee = 3380) {
  const x = setup(fee);
  const session = await x.provider.create(x.order, new Date().toISOString());
  x.order.checkout_session_id = String(session.id);
  x.order.payment_intent_id = x.fake.pay(String(session.id));
  return { ...x, session };
}
Deno.test("merchant routing comes from database assignment, while existing attempts resolve their original account", async () => {
  const base: ManagedBinding = {
    ...fixtureBinding,
    accountId: platformId,
    chargeMode: "merchant_direct",
    platformAccountId: platformId,
  };
  const calls: Json[] = [];
  const store = {
    rpc<T>(_name: string, args: Json) {
      calls.push(args);
      return Promise.resolve(
        {
          ...scope(base),
          account_id: args.p_attempt_id ? "acct_original" : "acct_current",
        } as T,
      );
    },
  };
  assertEquals(
    (await resolveManagedBinding(store, base, { action: "quote" })).accountId,
    "acct_current",
  );
  assertEquals(
    (await resolveManagedBinding(store, base, {
      action: "refund",
      attempt_id: fixtureOrder().attempt_id,
      order_id: fixtureOrder().external_order_id,
    })).accountId,
    "acct_original",
  );
  assertEquals(calls[1].p_action, "refund");
  await assertRejects(() =>
    resolveManagedBinding(
      {
        rpc<T>() {
          return Promise.resolve(
            {
              ...scope(base),
              account_id: "acct_current",
              platform_account_id: "acct_unrelated",
            } as T,
          );
        },
      },
      base,
      { action: "quote" },
    ), RequestError);
  for (
    const bad of [{ account_id: "acct_other" }, { application_fee_amount: 1 }, {
      commission_percent: 0,
    }, { platform_account_id: "acct_other" }]
  ) {
    assertThrows(
      () => validateInput({ ...fixtureInput(), ...bad }, base),
      RequestError,
    );
  }
});
Deno.test("merchant checkout uses only its account and frozen fee while platform fee reads omit merchant header", async () => {
  const { fake, provider, order } = await paid();
  const post = fake.calls.find((c) =>
    c.method === "POST" && c.path === "checkout/sessions"
  )!;
  assertEquals(post.account, order.account_id);
  assertEquals(
    post.form["payment_intent_data[application_fee_amount]"],
    "3380",
  );
  const snapshot = await provider.snapshot(order);
  assertEquals(snapshot?.application_fee_verified, true);
  assertEquals(snapshot?.application_fee_refunded_amount, 0);
  assert(
    fake.calls.filter((c) => c.path.startsWith("application_fees/")).every(
      (c) => c.account === null,
    ),
  );
  assert(
    fake.calls.filter((c) => c.path.startsWith("payment_intents/")).every((c) =>
      c.account === order.account_id
    ),
  );
});
Deno.test("upgrading a binding preserves only database-verified historical platform payment routes", async () => {
  const base: ManagedBinding = {
    ...fixtureBinding,
    accountId: platformId,
    chargeMode: "merchant_direct",
    platformAccountId: platformId,
  };
  const store = {
    rpc<T>() {
      return Promise.resolve({ ...scope(base), charge_mode: "platform" } as T);
    },
  };
  const legacy = await resolveManagedBinding(store, base, {
    action: "refund",
    attempt_id: fixtureOrder().attempt_id,
    order_id: fixtureOrder().external_order_id,
  });
  assertEquals(legacy.chargeMode, undefined);
  assertEquals(legacy.accountId, platformId);
  await assertRejects(
    () => resolveManagedBinding(store, base, { action: "quote" }),
    RequestError,
  );
});
Deno.test("organic Standard merchant checkout omits a fee and verifies none was collected", async () => {
  const { fake, provider, order } = await paid(0);
  assertEquals(
    fake.calls.find((c) => c.method === "POST")
      ?.form["payment_intent_data[application_fee_amount]"],
    undefined,
  );
  assertEquals(
    (await provider.snapshot(order))?.application_fee_verified,
    true,
  );
  assertEquals(fake.fees.size, 0);
});
Deno.test("wrong platform, merchant, mode, amount and unavailable merchant charges fail before sale", async () => {
  for (
    const issue of ["platform", "merchant", "mode", "fee", "charges"] as const
  ) {
    const { fake, provider, order } = setup();
    if (issue === "platform") fake.platformAccountId = "acct_other";
    if (issue === "merchant") fake.accountId = "acct_other";
    if (issue === "mode") fake.livemode = true;
    if (issue === "fee") order.application_fee_amount = 16900;
    if (issue === "charges") fake.chargesEnabled = false;
    await assertRejects(
      () => provider.create(order, new Date().toISOString()),
      RequestError,
    );
    assertEquals(fake.sessions.size, 0);
  }
});
Deno.test("fee mismatch and cross-merchant fee evidence never award a commission", async () => {
  const { fake, provider, order } = await paid();
  fake.payments.get(order.payment_intent_id!)!.application_fee_amount = 1;
  await assertRejects(() => provider.snapshot(order), RequestError);
  fake.payments.get(order.payment_intent_id!)!.application_fee_amount = 3380;
  [...fake.fees.values()][0].account = "acct_other";
  await assertRejects(() => provider.snapshot(order), RequestError);
});
Deno.test("asynchronous fee creation preserves independently verified paid truth", async () => {
  const { fake, provider, order } = await paid();
  const charge = [...fake.charges.values()][0], feeId = charge.application_fee;
  charge.application_fee = null;
  const pending = await provider.snapshot(order);
  assertEquals(pending?.payment_status, "paid");
  assertEquals(pending?.application_fee_verified, false);
  charge.application_fee = feeId;
  assertEquals(
    (await provider.snapshot(order))?.application_fee_verified,
    true,
  );
});
Deno.test("converted fee or platform settlement preserves paid truth and holds funding for currency review", async () => {
  for (const boundary of ["fee", "balance"]) {
    const { fake, provider, order } = await paid();
    const fee = [...fake.fees.values()][0];
    if (boundary === "fee") {
      fee.currency = "gbp";
      fee.amount = 2500;
    } else {
      const balance = fake.balances.get(String(fee.balance_transaction))!;
      balance.currency = "eur";
      balance.amount = 3000;
    }
    const snapshot = await provider.snapshot(order);
    assertEquals(snapshot?.payment_status, "paid");
    assertEquals(snapshot?.application_fee_verified, false);
    assertEquals(
      snapshot?.application_fee_review_reason,
      "application_fee_currency_review",
    );
  }
});
Deno.test("unsupported Brazil application-fee connection blocks checkout before a provider mutation", async () => {
  const { fake, provider, order } = setup();
  fake.merchantCountry = "BR";
  await assertRejects(
    () => provider.create(order, new Date().toISOString()),
    RequestError,
  );
  assertEquals(fake.sessions.size, 0);
  fake.platformCountry = "BR";
  await provider.create(order, new Date().toISOString());
  assertEquals(fake.sessions.size, 1);
});
Deno.test("currency review is queued without blocking the verified customer purchase", async () => {
  const { fake, provider, order } = await paid();
  [...fake.fees.values()][0].currency = "eur";
  const calls: { name: string; args: Json }[] = [];
  const store = {
    rpc<T>(name: string, args: Json) {
      calls.push({ name, args });
      return Promise.resolve(
        (name === "record_managed_checkout_snapshot"
          ? {
            ...order,
            paid_at: new Date().toISOString(),
            payment_status: "paid",
          }
          : {}) as T,
      );
    },
  };
  const result = await new ManagedCheckoutService(store, provider).reconcile(
    order,
  );
  assertEquals(result.payment_status, "paid");
  assertEquals(calls.at(-1)?.name, "managed_checkout_reconcile_failure");
  assertEquals(calls.at(-1)?.args.p_error, "application_fee_currency_review");
});
Deno.test("connected commerce verification uses merchant scope and verifies saved fee", async () => {
  const { fake, provider, order } = setup();
  order.request = fixtureInput({
    click_id: "opaque_fixture_click_123456",
    attribution: { kmaClick: "opaque_fixture_click_123456" },
  });
  order.attribution_sha256 = await attributionHash(order.request.attribution!);
  const session = await provider.create(order, new Date().toISOString());
  order.checkout_session_id = String(session.id);
  order.payment_intent_id = fake.pay(String(session.id));
  order.paid_at = new Date().toISOString();
  assertEquals((await provider.commission(order)).eligible_basis_minor, 16900);
  fake.payments.get(order.payment_intent_id)!.application_fee_amount = 100;
  await assertRejects(() => provider.commission(order), RequestError);
});
Deno.test("application fee refund lost reply recovers its exact operation once, independently of customer refund", async () => {
  const { fake, provider, order } = await paid();
  const snapshot = await provider.snapshot(order);
  order.application_fee_id = String(snapshot!.application_fee_id);
  const op = {
    id: crypto.randomUUID(),
    order_id: order.id,
    application_fee_id: order.application_fee_id,
    amount_minor: 1690,
    prior_refunded_amount: 0,
    target_refunded_amount: 1690,
    first_attempt_at: new Date().toISOString(),
  };
  fake.failAfterFeeRefund = true;
  await assertRejects(
    () => provider.refundApplicationFee(order, op),
    RequestError,
  );
  const receipt = await provider.refundApplicationFee(order, op);
  assertEquals(receipt.refunded_amount, 1690);
  assertEquals(fake.feeRefunds.size, 1);
  assertEquals(
    fake.calls.filter((c) =>
      c.method === "POST" && c.path.startsWith("application_fees/")
    ).length,
    1,
  );
  assertEquals(fake.refunds.size, 0);
});
Deno.test("external fee adjustments and stale operation identities cannot cause another fee refund", async () => {
  const { fake, provider, order } = await paid();
  order.application_fee_id = String(
    (await provider.snapshot(order))!.application_fee_id,
  );
  const op = {
    id: crypto.randomUUID(),
    order_id: order.id,
    application_fee_id: order.application_fee_id,
    amount_minor: 1690,
    prior_refunded_amount: 0,
    target_refunded_amount: 1690,
    first_attempt_at: new Date().toISOString(),
  };
  [...fake.fees.values()][0].amount_refunded = 500;
  await assertRejects(
    () => provider.refundApplicationFee(order, op),
    RequestError,
  );
  assertEquals(fake.feeRefunds.size, 0);
  [...fake.fees.values()][0].amount_refunded = 0;
  await assertRejects(
    () =>
      provider.refundApplicationFee(order, {
        ...op,
        first_attempt_at: new Date(Date.now() - 24 * 3600000).toISOString(),
      }),
    RequestError,
  );
  assertEquals(fake.feeRefunds.size, 0);
});
Deno.test("a fee refund waits for complete post-refund proof and recovers without paying twice", async () => {
  const { fake, order, binding, provider } = await paid();
  order.application_fee_id = String(
    (await provider.snapshot(order))!.application_fee_id,
  );
  const fee = fake.fees.get(order.application_fee_id)!;
  const balanceId = fee.balance_transaction;
  const op = {
    id: crypto.randomUUID(),
    order_id: order.id,
    application_fee_id: order.application_fee_id,
    amount_minor: 1690,
    prior_refunded_amount: 0,
    target_refunded_amount: 1690,
    first_attempt_at: new Date().toISOString(),
  };
  const partialProvider = new ManagedProvider(binding, async (url, init) => {
    const response = await fake.fetch(url, init);
    if (init?.method === "POST" && String(url).includes("application_fees/")) {
      fee.balance_transaction = null;
    }
    return response;
  });
  await assertRejects(
    () => partialProvider.refundApplicationFee(order, op),
    RequestError,
  );
  assertEquals(fake.feeRefunds.size, 1);
  fee.balance_transaction = balanceId;
  const receipt = await provider.refundApplicationFee(order, op);
  assertEquals(receipt.refunded_amount, 1690);
  assertEquals(fake.feeRefunds.size, 1);
});

async function lostFeeRefund() {
  const x = await paid();
  x.order.application_fee_id = String(
    (await x.provider.snapshot(x.order))!.application_fee_id,
  );
  const operation = {
    id: crypto.randomUUID(),
    order_id: x.order.id,
    application_fee_id: x.order.application_fee_id,
    amount_minor: 1690,
    prior_refunded_amount: 0,
    target_refunded_amount: 1690,
    first_attempt_at: new Date().toISOString(),
  };
  x.fake.failAfterFeeRefund = true;
  await assertRejects(
    () => x.provider.refundApplicationFee(x.order, operation),
    RequestError,
  );
  const refund = [...x.fake.feeRefunds.values()][0];
  const balance = x.fake.balances.get(String(refund.balance_transaction))!;
  return { ...x, operation, refund, balance };
}

Deno.test("converted fee refund recovers its canonical platform debit without another provider write", async () => {
  const { fake, binding, order, operation, refund, balance } =
    await lostFeeRefund();
  refund.amount = 2390;
  refund.currency = "cad";
  balance.exchange_rate = 1.41443;
  const provider = new ManagedProvider(binding, (url, init) => {
    assertEquals(init?.method, "GET");
    return fake.fetch(url, init);
  });
  const receipt = await provider.refundApplicationFee(order, operation);
  assertEquals(receipt.amount_minor, 1690);
  assertEquals(receipt.currency, "USD");
  assertEquals(receipt.refunded_amount, 1690);
  assertEquals(receipt.refund_amount, 2390);
  assertEquals(receipt.refund_currency, "CAD");
  assertEquals(receipt.platform_balance_transaction_id, balance.id);
  assertEquals(fake.feeRefunds.size, 1);
  assertEquals(
    fake.calls.filter((c) =>
      c.method === "POST" && c.path.startsWith("application_fees/")
    ).length,
    1,
  );
  assert(
    fake.calls.filter((c) => c.path === `balance_transactions/${balance.id}`)
      .every((c) => c.account === null),
  );
});

Deno.test("fee refund rejects wrong platform debit, linkage and canonical amount without another write", async () => {
  for (
    const change of [
      { id: "txn_unrelated" },
      { source: "fee_unrelated" },
      { type: "refund" },
      { currency: "cad" },
      { amount: 1690 },
      { amount: -1689 },
    ]
  ) {
    const { fake, provider, order, operation, refund, balance } =
      await lostFeeRefund();
    refund.amount = 2390;
    refund.currency = "cad";
    Object.assign(balance, change);
    await assertRejects(
      () => provider.refundApplicationFee(order, operation),
      RequestError,
    );
    assertEquals(fake.feeRefunds.size, 1);
    assertEquals(
      fake.calls.filter((c) =>
        c.method === "POST" && c.path.startsWith("application_fees/")
      ).length,
      1,
    );
  }
});

Deno.test("fee refund waits for linked debit and parent aggregate, then recovers existing refund", async () => {
  const { fake, provider, order, operation, refund, balance } =
    await lostFeeRefund();
  refund.balance_transaction = null;
  const pending = await assertRejects(
    () => provider.refundApplicationFee(order, operation),
    RequestError,
  );
  assertEquals(pending.code, "fee_refund_pending");
  refund.balance_transaction = balance.id;
  const fee = fake.fees.get(String(order.application_fee_id))!;
  fee.amount_refunded = 0;
  const aggregatePending = await assertRejects(
    () => provider.refundApplicationFee(order, operation),
    RequestError,
  );
  assertEquals(aggregatePending.code, "fee_refund_pending");
  fee.amount_refunded = 1690;
  assertEquals(
    (await provider.refundApplicationFee(order, operation)).amount_minor,
    1690,
  );
  assertEquals(fake.feeRefunds.size, 1);
});
