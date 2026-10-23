import { test } from "node:test";
import assert from "node:assert/strict";
import {
  merchantRealOptions,
  merchantRealTransport,
} from "./merchant-real-policy.mjs";
const o = {
  enabled: true,
  key: "sk_test_fixture123456789",
  platformAccountId: "acct_platform",
  clientId: "ca_fixture",
};
test("merchant rehearsal refuses live secrets and implicit activation", () => {
  for (
    const patch of [{ enabled: false }, { key: "sk_live_fixture123456789" }, {
      key: "pk_test_fixture123456789",
    }, { clientId: "" }]
  ) assert.throws(() => merchantRealOptions({ ...o, ...patch }));
  assert.equal(merchantRealOptions(o).origin, "http://127.0.0.1:5194");
});
test("merchant transport permits only confirmed merchant checkout/refunds and platform fee refunds", async () => {
  let merchant = null, calls = 0;
  const transport = merchantRealTransport(o, () => merchant, async () => {
    calls++;
    return Response.json({});
  });
  const init = {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${o.key}`,
      "Stripe-Account": "acct_merchant",
    },
  };
  await assert.rejects(() =>
    transport("https://api.stripe.com/v1/checkout/sessions", init)
  );
  merchant = "acct_merchant";
  await transport("https://api.stripe.com/v1/checkout/sessions", init);
  await transport("https://api.stripe.com/v1/refunds", init);
  await transport(
    "https://api.stripe.com/v1/application_fees/fee_fixture/refunds",
    { ...init, headers: { authorization: `Bearer ${o.key}` } },
  );
  for (
    const path of [
      "/v1/accounts",
      "/v1/products",
      "/v1/prices",
      "/v1/transfers",
      "/v1/payouts",
      "/v1/webhook_endpoints",
    ]
  ) {
    await assert.rejects(() =>
      transport("https://api.stripe.com" + path, init)
    );
  }
  await assert.rejects(() =>
    transport(
      "https://api.stripe.com/v1/application_fees/fee_fixture/refunds",
      init,
    )
  );
  await assert.rejects(() =>
    transport("https://api.stripe.com/v1/refunds", {
      ...init,
      headers: {
        authorization: `Bearer ${o.key}`,
        "Stripe-Account": "acct_wrong",
      },
    })
  );
  assert.equal(calls, 3);
});
test("OAuth exchange is separate and never permits account or authorization mutations", async () => {
  const transport = merchantRealTransport(
    o,
    () => null,
    async () => Response.json({}),
  );
  const init = {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Basic ${btoa(`${o.key}:`)}` },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: "ac_fixture12345",
    }),
  };
  assert.equal(
    (await transport("https://connect.stripe.com/oauth/token", init)).status,
    200,
  );
  await assert.rejects(() =>
    transport("https://connect.stripe.com/oauth/deauthorize", init)
  );
  await assert.rejects(() =>
    transport("https://foreign.invalid/oauth/token", init)
  );
});
