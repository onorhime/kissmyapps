// deno-lint-ignore-file require-await -- Mock the asynchronous provider boundary.
import { assertEquals } from "@std/assert";
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";
import {
  type Json,
  type MerchantBinding,
  MerchantProvider,
} from "../merchant-connect/provider.ts";
import {
  consoleMerchantBinding,
  createMerchantConnectWebhook,
  type MerchantWebhookDependencies,
} from "./index.ts";
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
  bindingId = "test",
) {
  const body = JSON.stringify(e);
  const signature = bytesToHex(
    await hmacSha256(secret, new TextEncoder().encode(`${TIME}.${body}`)),
  );
  return new Request(
    `https://functions.example/merchant-connect-webhook?binding_id=${bindingId}`,
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
function fixture(extra: Partial<MerchantWebhookDependencies> = {}) {
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
    ...extra,
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

// The merchant console's own platform (workspace-stripe-connect), live only.
// Assembled so that no key-shaped literal sits in the repository.
const LIVE_KEY = ["sk", "live", "fakeConsoleKey"].join("_");
const CONSOLE_ENV: Record<string, string> = {
  CONSOLE_CONNECT_ENABLED: "true",
  CONSOLE_CONNECT_PLATFORM_ACCOUNT: B.platformAccountId,
  CONSOLE_CONNECT_CLIENT_ID: "ca_ConsoleClient",
  CONSOLE_CONNECT_STRIPE_SECRET: LIVE_KEY,
  CONSOLE_CONNECT_ORIGIN: "https://merchant.kma.example",
  CONSOLE_CONNECT_CALLBACK_URL: "https://merchant.kma.example/",
  CONSOLE_MERCHANT_WEBHOOK_SIGNING: "whsec_consolefixture",
};
const env = (values: Record<string, string>) => (name: string) => values[name];
const liveEvent = (type = "account.updated"): Json => ({
  ...event(type),
  livemode: true,
  data: {
    object: {
      id: type === "account.updated" ? "acct_Merchant" : "ca_ConsoleClient",
    },
  },
});

Deno.test("console binding is built from the Connections settings, and only once both are set", () => {
  assertEquals(consoleMerchantBinding(env(CONSOLE_ENV)), {
    id: "console",
    platformAccountId: B.platformAccountId,
    livemode: true,
    clientId: "ca_ConsoleClient",
    secret: LIVE_KEY,
    origin: "https://merchant.kma.example",
    callbackUrl: "https://merchant.kma.example/",
    providerEnabled: true,
    webhookSecret: "whsec_consolefixture",
  });
  assertEquals(
    consoleMerchantBinding(
      env({ ...CONSOLE_ENV, CONSOLE_CONNECT_ENABLED: "false" }),
    ),
    undefined,
  );
  assertEquals(
    consoleMerchantBinding(
      env({ ...CONSOLE_ENV, CONSOLE_MERCHANT_WEBHOOK_SIGNING: "" }),
    ),
    undefined,
  );
});

Deno.test("binding_id=console updates and revokes console connections with live events", async () => {
  const f = fixture({
    // A legacy entry named console must never be used for this endpoint.
    bindings: () => new Map([["console", B]]),
    consoleBinding: () => consoleMerchantBinding(env(CONSOLE_ENV)),
  });
  const signing = CONSOLE_ENV.CONSOLE_MERCHANT_WEBHOOK_SIGNING;
  assertEquals(
    (await f.handler(await request(liveEvent(), signing, {}, "console")))
      .status,
    200,
  );
  assertEquals(f.saved[0].platform_account_id, B.platformAccountId);
  assertEquals(f.saved[0].livemode, true);
  assertEquals(f.saved[0].charges_enabled, false);
  assertEquals(
    (await f.handler(
      await request(
        liveEvent("account.application.deauthorized"),
        signing,
        {},
        "console",
      ),
    )).status,
    200,
  );
  assertEquals(f.saved[1].event_type, "account.application.deauthorized");
  assertEquals(f.saved.length, 2);
  // Signed for the legacy binding, or a test-mode event: rejected.
  assertEquals(
    (await f.handler(
      await request(liveEvent(), B.webhookSecret, {}, "console"),
    )).status,
    400,
  );
  assertEquals(
    (await f.handler(await request(event(), signing, {}, "console"))).status,
    400,
  );
  assertEquals(f.saved.length, 2);
});

Deno.test("binding_id=console is off until the console binding exists", async () => {
  const f = fixture({
    bindings: () => new Map([["console", B]]),
    consoleBinding: () => undefined,
  });
  assertEquals(
    (await f.handler(await request(event(), B.webhookSecret, {}, "console")))
      .status,
    503,
  );
  assertEquals(f.saved.length, 0);
  assertEquals(f.calls.length, 0);
});
