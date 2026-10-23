// deno-lint-ignore-file require-await -- Mock the asynchronous provider boundary.
import { assertEquals } from "@std/assert";
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";
import {
  type Json,
  type MerchantBinding,
  MerchantProvider,
} from "../merchant-connect/provider.ts";
import { createMerchantConnectWebhook } from "./index.ts";
const NOW = Date.parse("2026-10-17T12:00:00Z"), TIME = Math.floor(NOW / 1000);
const B: MerchantBinding = {
  id: "test",
  platformAccountId: "acct_KMA",
  livemode: false,
  clientId: "ca_TestClient",
  secret: "sk_test_fake",
  origin: "https://kma.example",
  callbackUrl: "https://kma.example/merchant/callback",
  providerEnabled: true,
  webhookSecret: "whsec_fakefixture",
};
const event = (type = "account.updated"): Json => ({
  id: "evt_connection1",
  type,
  created: TIME,
  livemode: false,
  api_version: STRIPE_API_VERSION,
  account: "acct_Merchant",
  data: {
    object: {
      id: type === "account.updated" ? "acct_Merchant" : B.clientId,
      charges_enabled: true,
    },
  },
});
async function request(
  e: Json,
  secret = B.webhookSecret!,
  headers: Record<string, string> = {},
) {
  const body = JSON.stringify(e);
  const signature = bytesToHex(
    await hmacSha256(secret, new TextEncoder().encode(`${TIME}.${body}`)),
  );
  return new Request(
    "https://functions.example/merchant-connect-webhook?binding_id=test",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": `t=${TIME},v1=${signature}`,
        ...headers,
      },
      body,
    },
  );
}
function fixture() {
  const saved: Json[] = [], calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const account = new Headers(init?.headers).get("Stripe-Account");
    calls.push(String(url));
    return Response.json(
      account
        ? {
          id: account,
          type: "standard",
          country: "US",
          business_profile: { name: "Merchant" },
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: true,
        }
        : { id: B.platformAccountId },
    );
  };
  const handler = createMerchantConnectWebhook({
    bindings: () => new Map([[B.id, B]]),
    now: () => NOW,
    connectionExists: async () => true,
    provider: (b) => new MerchantProvider(b, fetcher),
    persist: async (input) => {
      saved.push(input);
      return { duplicate: false };
    },
  });
  return { handler, saved, calls };
}
Deno.test("merchant webhook rejects browser, bad signature and wrong mode before persistence/provider", async () => {
  const f = fixture();
  assertEquals(
    (await f.handler(
      await request(event(), B.webhookSecret, { Origin: B.origin }),
    )).status,
    403,
  );
  assertEquals(
    (await f.handler(await request(event(), "whsec_wrong"))).status,
    400,
  );
  assertEquals(
    (await f.handler(await request({ ...event(), livemode: true }))).status,
    400,
  );
  assertEquals(f.saved.length, 0);
  assertEquals(f.calls.length, 0);
});
Deno.test("merchant webhook verifies actual account status rather than trusting event capability flags", async () => {
  const f = fixture();
  assertEquals((await f.handler(await request(event()))).status, 200);
  assertEquals(f.saved.length, 1);
  assertEquals(f.saved[0].charges_enabled, false);
  assertEquals(f.saved[0].payouts_enabled, false);
  assertEquals(f.saved[0].platform_account_id, B.platformAccountId);
  assertEquals(f.saved[0].account_id, "acct_Merchant");
  assertEquals(f.calls.length, 2);
  assertEquals(typeof f.saved[0].payload_sha256, "string");
});
Deno.test("deauthorized account revokes without trying to read revoked account access", async () => {
  const f = fixture();
  assertEquals(
    (await f.handler(await request(event("account.application.deauthorized"))))
      .status,
    200,
  );
  assertEquals(f.saved[0].event_type, "account.application.deauthorized");
  assertEquals(f.saved[0].event_created, TIME);
  assertEquals(f.calls.length, 0);
});
Deno.test("wrong OAuth application or account object cannot revoke/update connection", async () => {
  const f = fixture();
  for (
    const e of [
      {
        ...event("account.application.deauthorized"),
        data: { object: { id: "ca_OtherPlatform" } },
      },
      { ...event(), data: { object: { id: "acct_Different" } } },
      { ...event(), account: B.platformAccountId },
    ]
  ) assertEquals((await f.handler(await request(e))).status, 400);
  assertEquals(f.saved.length, 0);
  assertEquals(f.calls.length, 0);
});
Deno.test("irrelevant event ignored and missing explicit provider config fails closed", async () => {
  const f = fixture();
  assertEquals(
    (await f.handler(await request({ ...event(), type: "charge.succeeded" })))
      .status,
    200,
  );
  assertEquals(f.saved.length, 0);
  const disabled = createMerchantConnectWebhook({
    bindings: () => new Map([[B.id, { ...B, providerEnabled: false }]]),
    now: () => NOW,
  });
  assertEquals((await disabled(await request(event()))).status, 503);
});

Deno.test("unrelated creator account events are ignored before merchant provider reads", async () => {
  let fetched = false, persisted = false;
  const h = createMerchantConnectWebhook({
    bindings: () => new Map([[B.id, B]]),
    now: () => NOW,
    connectionExists: async () => false,
    persist: async () => {
      persisted = true;
      return {};
    },
    provider: (b) =>
      new MerchantProvider(b, async () => {
        fetched = true;
        return Response.json({});
      }),
  });
  assertEquals((await h(await request(event()))).status, 200);
  assertEquals(fetched, false);
  assertEquals(persisted, false);
});
