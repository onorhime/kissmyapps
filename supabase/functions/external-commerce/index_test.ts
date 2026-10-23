// deno-lint-ignore-file require-await -- Injected fixtures preserve asynchronous boundaries.
function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
async function assertRejects(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("Expected operation to reject.");
}
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import {
  attributionHash,
  type CommerceBinding,
  type CommerceInput,
  validateCommerce,
  verifiedCommissionBasis,
  verifyCommerceWithStripe,
} from "./contract.ts";
import { createExternalCommerceHandler } from "./index.ts";
const binding: CommerceBinding = {
  secret: "private-local-fixture-never-production-key",
  productId: "11111111-1111-4111-8111-111111111111",
  funnelId: "22222222-2222-4222-8222-222222222222",
  accountId: "acct_fixture",
  livemode: false,
  stripeReadKey: "rk_test_fixture",
};
const input: CommerceInput = {
  event_id: "33333333-3333-4333-8333-333333333333",
  kind: "purchase",
  click_id: "opaque_fixture_click_123456",
  occurred_at: "2026-10-13T11:00:00Z",
  order_id: "44444444-4444-4444-8444-444444444444",
  checkout_session_id: "cs_test_fixture",
  payment_intent_id: "pi_fixture",
  account_id: "acct_fixture",
  livemode: false,
  amount_minor: 17900,
  currency: "USD",
  attribution: {
    kmaClick: "opaque_fixture_click_123456",
    status: "unverified",
  },
};
async function fixture() {
  const digest = await attributionHash(input.attribution);
  const metadata = {
    purpose: "speaksix_marathon",
    order_id: input.order_id,
    stripe_account_id: binding.accountId,
    attribution_sha256: digest,
  };
  const objects: Record<string, Record<string, unknown>> = {
    account: { id: binding.accountId },
    "checkout/sessions/cs_test_fixture": {
      id: input.checkout_session_id,
      livemode: false,
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      client_reference_id: input.order_id,
      payment_intent: input.payment_intent_id,
      amount_total: 17900,
      total_details: {
        amount_discount: 2100,
        amount_tax: 900,
        amount_shipping: 0,
      },
      shipping_cost: null,
      currency: "usd",
      metadata,
    },
    "payment_intents/pi_fixture": {
      id: input.payment_intent_id,
      livemode: false,
      status: "succeeded",
      amount_received: 17900,
      amount: 17900,
      currency: "usd",
      metadata,
      created: 1789999999,
      latest_charge: "ch_fixture",
    },
    "charges/ch_fixture": {
      id: "ch_fixture",
      livemode: false,
      payment_intent: input.payment_intent_id,
      amount: 17900,
      currency: "usd",
      paid: true,
      balance_transaction: "txn_fixture",
    },
    "balance_transactions/txn_fixture": {
      id: "txn_fixture",
      source: "ch_fixture",
      type: "charge",
      amount: 17900,
      fee: 550,
      net: 17350,
      currency: "usd",
      exchange_rate: null,
    },
    "refunds/re_fixture": {
      id: "re_fixture",
      status: "succeeded",
      payment_intent: input.payment_intent_id,
      amount: 17900,
      currency: "usd",
      created: 1790000001,
      metadata: { order_id: input.order_id, purpose: "speaksix_marathon" },
    },
  };
  const paths: string[] = [];
  const fetcher: typeof fetch = (url, init) => {
    assertEquals(init?.method, "GET");
    assertEquals(init?.redirect, "error");
    assertEquals(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
      "Bearer rk_test_fixture",
    );
    const parsed = new URL(String(url));
    assertEquals(parsed.origin, "https://api.stripe.com");
    const path = parsed.pathname.slice(4);
    paths.push(path);
    return Promise.resolve(Response.json(objects[path]));
  };
  return { objects, fetcher, paths };
}
async function signed(body: unknown, origin = false) {
  const raw = JSON.stringify(body),
    timestamp = Math.floor(Date.now() / 1000),
    nonce = "local_nonce_abcdefghijklmnop";
  return new Request("https://kma.example/functions/v1/external-commerce", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kma-key-id": "speaksix",
      "x-kma-timestamp": String(timestamp),
      "x-kma-nonce": nonce,
      "x-kma-signature": bytesToHex(
        await hmacSha256(binding.secret, `${timestamp}.${nonce}.${raw}`),
      ),
      ...(origin ? { origin: "https://marathon.example" } : {}),
    },
    body: raw,
  });
}
Deno.test("external commerce verifies exact account and paid single payment with immutable attribution digest", async () => {
  const f = await fixture();
  const evidence = await verifyCommerceWithStripe(input, binding, f.fetcher);
  assertEquals(evidence.input.amount_minor, 17900);
  assertEquals(evidence.eligible_basis_minor, 17000);
  assertEquals(evidence.basis_verified, true);
  assertEquals(f.paths, [
    "account",
    "checkout/sessions/cs_test_fixture",
    "payment_intents/pi_fixture",
    "charges/ch_fixture",
    "balance_transactions/txn_fixture",
  ]);
  assertEquals(evidence.product_id, binding.productId);
});
Deno.test("net commission costs require verified merchant balance transaction fees and tax evidence", async () => {
  const f = await fixture();
  const evidence = await verifyCommerceWithStripe(input, binding, f.fetcher);
  assertEquals(evidence.cost_evidence, {
    tax_minor: 900,
    shipping_minor: 0,
    fee_verified: true,
    fee_minor: 550,
    fee_currency: "USD",
    balance_transaction_id: "txn_fixture",
    provider_charge_id: "ch_fixture",
  });
  for (
    const patch of [
      { fee: undefined },
      { currency: "eur", amount: 15000, net: 14450 },
      { net: 9999 },
      { fee: -1 },
    ]
  ) {
    const unknown = await fixture();
    Object.assign(unknown.objects["balance_transactions/txn_fixture"], patch);
    const value = await verifyCommerceWithStripe(
      input,
      binding,
      unknown.fetcher,
    );
    assertEquals(value.cost_evidence?.fee_verified, false);
    assertEquals(value.cost_evidence?.fee_minor, undefined);
  }
  const foreign = await fixture();
  foreign.objects["balance_transactions/txn_fixture"].source = "ch_other";
  await assertRejects(() =>
    verifyCommerceWithStripe(input, binding, foreign.fetcher)
  );
});
Deno.test("commission basis excludes tax and discounted shipping without double subtracting shipping tax", () => {
  assertEquals(
    verifiedCommissionBasis({
      amount_total: 17900,
      total_details: {
        amount_tax: 900,
        amount_shipping: 1100,
        amount_discount: 2000,
      },
      shipping_cost: { amount_total: 1100, amount_tax: 100 },
    }),
    {
      basis_verified: true,
      basis_policy: "post_discount_excluding_tax_shipping",
      eligible_basis_minor: 16000,
    },
  );
});
Deno.test("incomplete or impossible provider totals keep commission basis unknown", () => {
  for (
    const value of [
      { amount_total: 17900 },
      { amount_total: 17900, total_details: { amount_shipping: 0 } },
      {
        amount_total: 17900,
        total_details: { amount_tax: -1, amount_shipping: 0 },
      },
      {
        amount_total: 17900,
        total_details: { amount_tax: 18000, amount_shipping: 0 },
      },
      {
        amount_total: 17900,
        total_details: { amount_tax: 0, amount_shipping: 1100 },
      },
      {
        amount_total: 17900,
        total_details: { amount_tax: 900, amount_shipping: 1100 },
        shipping_cost: { amount_total: 1100 },
      },
    ]
  ) assertEquals(verifiedCommissionBasis(value), {});
});
Deno.test("external commerce uses a server-configured generic product purpose", async () => {
  const f = await fixture();
  for (
    const key of [
      "checkout/sessions/cs_test_fixture",
      "payment_intents/pi_fixture",
    ]
  ) {
    (f.objects[key].metadata as Record<string, unknown>).purpose =
      "course_purchase";
  }
  const evidence = await verifyCommerceWithStripe(input, {
    ...binding,
    metadataPurpose: "course_purchase",
  }, f.fetcher);
  assertEquals(evidence.eligible_basis_minor, 17000);
  await assertRejects(() =>
    verifyCommerceWithStripe(input, binding, f.fetcher)
  );
});
Deno.test("external commerce rejects cross-account, cross-mode, mismatched amount, unpaid and changed attribution", async () => {
  for (
    const mutate of [(f: Awaited<ReturnType<typeof fixture>>) => {
      f.objects.account.id = "acct_foreign";
    }, (f: Awaited<ReturnType<typeof fixture>>) => {
      f.objects["payment_intents/pi_fixture"].livemode = true;
    }, (f: Awaited<ReturnType<typeof fixture>>) => {
      f.objects["checkout/sessions/cs_test_fixture"].amount_total = 1;
    }, (f: Awaited<ReturnType<typeof fixture>>) => {
      f.objects["checkout/sessions/cs_test_fixture"].payment_status = "unpaid";
    }, (f: Awaited<ReturnType<typeof fixture>>) => {
      f.objects["payment_intents/pi_fixture"].metadata = {};
    }, (f: Awaited<ReturnType<typeof fixture>>) => {
      f.objects["payment_intents/pi_fixture"].transfer_data = {
        destination: "acct_foreign",
      };
    }]
  ) {
    const f = await fixture();
    mutate(f);
    await assertRejects(() =>
      verifyCommerceWithStripe(input, binding, f.fetcher)
    );
  }
  const f = await fixture();
  await assertRejects(() =>
    verifyCommerceWithStripe(
      {
        ...input,
        click_id: "different_opaque_click",
        attribution: { kmaClick: "different_opaque_click" },
      },
      binding,
      f.fetcher,
    )
  );
});
Deno.test("only full succeeded refund belonging to exact payment is accepted", async () => {
  const refund = { ...input, kind: "refund" as const, refund_id: "re_fixture" };
  const f = await fixture();
  assertEquals(
    (await verifyCommerceWithStripe(refund, binding, f.fetcher)).input
      .refund_id,
    "re_fixture",
  );
  for (
    const patch of [{ status: "pending" }, { amount: 100 }, {
      payment_intent: "pi_other",
    }, { metadata: { order_id: input.order_id } }]
  ) {
    const bad = await fixture();
    Object.assign(bad.objects["refunds/re_fixture"], patch);
    await assertRejects(() =>
      verifyCommerceWithStripe(refund, binding, bad.fetcher)
    );
  }
});
Deno.test("HMAC handler persists verified evidence and returns internal receipt while commission remains held", async () => {
  let authorized = 0, ingested = 0, attested = 0;
  const f = await fixture();
  const handler = createExternalCommerceHandler({
    bindings: () => new Map([["speaksix", binding]]),
    authorize: (key, event, b) => {
      assertEquals(key, "speaksix");
      assertEquals(event.click_id, input.click_id);
      assertEquals(b.productId, binding.productId);
      authorized++;
      return Promise.resolve();
    },
    verify: (i, b) => verifyCommerceWithStripe(i, b, f.fetcher),
    recordBasis: (evidence) => {
      assertEquals(ingested, 1);
      assertEquals(evidence.eligible_basis_minor, 17000);
      assertEquals(evidence.external_order_id, input.order_id);
      attested++;
      return Promise.resolve();
    },
    ingest: async (evidence) => {
      assertEquals(evidence.eligible_basis_minor, undefined);
      assertEquals(
        evidence.attribution_sha256,
        await attributionHash(input.attribution),
      );
      ingested++;
      return {
        event_id: "55555555-5555-4555-8555-555555555555",
        duplicate: false,
      };
    },
  });
  const response = await handler(await signed(input));
  assertEquals(response.status, 200);
  assertEquals(authorized, 1);
  assertEquals(ingested, 1);
  assertEquals(attested, 1);
  const body = await response.json();
  assertEquals(body.event_id, "55555555-5555-4555-8555-555555555555");
  assertEquals(body.commission_status, "held");
});
Deno.test("pending merchant fees retry the same recorded sale and later enrich verified costs without a duplicate purchase", async () => {
  const f = await fixture();
  delete f.objects["charges/ch_fixture"].balance_transaction;
  const ingested = new Set<string>(), costs: Record<string, unknown>[] = [];
  const handler = createExternalCommerceHandler({
    bindings: () => new Map([["speaksix", binding]]),
    authorize: async () => {},
    verify: (i, b) => verifyCommerceWithStripe(i, b, f.fetcher),
    ingest: async (evidence) => {
      const duplicate = ingested.has(evidence.input.order_id);
      ingested.add(evidence.input.order_id);
      return { event_id: "55555555-5555-4555-8555-555555555555", duplicate };
    },
    recordBasis: async (evidence) => {
      costs.push(evidence);
    },
  });
  const pending = await handler(await signed(input));
  assertEquals(pending.status, 503);
  assertEquals(ingested.size, 1);
  assertEquals(costs[0].fee_verified, false);
  assertEquals(costs[0].fee_minor, undefined);
  f.objects["charges/ch_fixture"].balance_transaction = "txn_fixture";
  const recovered = await handler(await signed(input));
  assertEquals(recovered.status, 200);
  assertEquals((await recovered.json()).duplicate, true);
  assertEquals(ingested.size, 1);
  assertEquals(costs[1].fee_verified, true);
  assertEquals(costs[1].fee_minor, 550);
});
Deno.test("FX settlement fees remain explicitly held without infinite ambiguous retries or assuming zero", async () => {
  const f = await fixture();
  f.objects["balance_transactions/txn_fixture"].currency = "eur";
  const costs: Record<string, unknown>[] = [];
  const handler = createExternalCommerceHandler({
    bindings: () => new Map([["speaksix", binding]]),
    authorize: async () => {},
    verify: (i, b) => verifyCommerceWithStripe(i, b, f.fetcher),
    ingest: async () => ({
      event_id: "55555555-5555-4555-8555-555555555555",
      duplicate: false,
    }),
    recordBasis: async (evidence) => {
      costs.push(evidence);
    },
  });
  const response = await handler(await signed(input));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.commission_hold_reason, "settlement_currency_mismatch");
  assertEquals(body.provider_evidence_retryable, false);
  assertEquals(costs[0].fee_minor, undefined);
});
Deno.test("browser, unsigned, extra commission, wrong merchant and foreign click cannot ingest", async () => {
  let verified = 0;
  const handler = createExternalCommerceHandler({
    bindings: () => new Map([["speaksix", binding]]),
    authorize: async () => {},
    verify: () => {
      verified++;
      throw new Error("must not reach verification");
    },
    ingest: () => {
      throw new Error("must not ingest");
    },
  });
  assertEquals((await handler(await signed(input, true))).status, 403);
  const unsigned = await signed(input);
  unsigned.headers.delete("x-kma-signature");
  assertEquals((await handler(unsigned)).status, 401);
  assertEquals(
    (await handler(await signed({ ...input, commission_rate: 30 }))).status,
    400,
  );
  assertEquals(
    (await handler(await signed({ ...input, account_id: "acct_other" })))
      .status,
    403,
  );
  assertEquals(verified, 0);
  const denied = createExternalCommerceHandler({
    bindings: () => new Map([["speaksix", binding]]),
    authorize: () => {
      throw new Error("foreign scope");
    },
    verify: () => {
      verified++;
      throw new Error("must not verify");
    },
  });
  await denied(await signed(input));
  assertEquals(verified, 0);
});
Deno.test("strict input rejects personal data and malformed provider identity", () => {
  for (
    const patch of [
      { affiliate_id: "client-selected" },
      {
        attribution: { ...input.attribution, email: "private@example.invalid" },
      },
      { amount_minor: -1 },
      { kind: "purchase", refund_id: "re_fixture" },
      { kind: "refund" },
      { payment_intent_id: "../../account" },
    ]
  ) {
    let rejected = false;
    try {
      validateCommerce({ ...input, ...patch });
    } catch {
      rejected = true;
    }
    assertEquals(rejected, true);
  }
});
