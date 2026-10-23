// deno-lint-ignore-file require-await -- Fakes retain the production asynchronous boundary.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createMerchantConnectHandler, tokenHash } from "./index.ts";
import {
  type Json,
  type MerchantBinding,
  merchantBindings,
  MerchantProvider,
} from "./provider.ts";
import { deriveInvitationToken } from "./invitation-email.ts";
import { RequestError } from "../_shared/errors.ts";
const NOW = Date.parse("2026-10-17T12:00:00Z");
const ID = "b7fba530-4513-4f65-815e-b53292a9fe01";
const USER = "b7fba530-4513-4f65-815e-b53292a9fe02";
const TOKEN = "a".repeat(43);
const STATE = "b".repeat(43);
const MAIL_CONFIG = {
  enabled: false,
  from: "KMA <partners@example.invalid>",
  activeKeyId: "v1",
  tokenKeys: { v1: "ab".repeat(32) },
};
const B: MerchantBinding = {
  id: "test",
  platformAccountId: "acct_KMA",
  livemode: false,
  clientId: "ca_TestClient",
  secret: "sk_test_fakeSecret",
  origin: "https://kma.example",
  callbackUrl: "https://kma.example/merchant/callback",
  providerEnabled: true,
};
const account = {
  id: "acct_Merchant",
  object: "account",
  type: "standard",
  country: "US",
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  business_profile: { name: "Merchant Limited" },
};
function request(body: unknown, origin = B.origin, auth = true) {
  return new Request("https://functions.example/merchant-connect", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${"x".repeat(40)}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
function fixture(
  options: {
    binding?: MerchantBinding;
    role?: "admin" | "merchant";
    userId?: string;
    denied?: boolean;
    tokenMode?: boolean;
    wrongAccount?: boolean;
    providerError?: boolean;
    incomplete?: boolean;
    origins?: string[];
    contextPlatformAccountId?: string;
    disabled?: boolean;
  } = {},
) {
  const binding = options.binding ?? B;
  const rpcCalls: Array<{ name: string; args: Json; auth?: string }> = [];
  const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  let consumed = false, candidate: Json | null = null, status = "claimed";
  const context = () => ({
    invitation_id: ID,
    merchant_id: ID,
    email: "merchant@example.com",
    business_name: "Merchant Limited",
    platform_account_id: options.contextPlatformAccountId ??
      binding.platformAccountId,
    livemode: binding.livemode,
    status,
    candidate,
  });
  const fetcher: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), headers, body: String(init?.body ?? "") });
    if (String(url).endsWith("/oauth/token")) {
      return Response.json(
        options.providerError
          ? { error: "invalid_grant", error_description: "SECRET_CODE_OR_KEY" }
          : {
            stripe_user_id: "acct_Merchant",
            token_type: "bearer",
            scope: "read_write",
            livemode: options.tokenMode ?? false,
            access_token: "SECRET_ACCESS",
            refresh_token: "SECRET_REFRESH",
          },
        { status: options.providerError ? 400 : 200 },
      );
    }
    if (headers.has("Stripe-Account")) {
      return Response.json({
        ...account,
        ...(options.wrongAccount ? { id: "acct_Different" } : {}),
        ...(options.incomplete ? { charges_enabled: false } : {}),
      });
    }
    return Response.json({ id: binding.platformAccountId });
  };
  const handler = createMerchantConnectHandler({
    bindings: () => options.disabled ? new Map() : new Map([["test", binding]]),
    origins: () =>
      new Set(
        options.origins ?? [binding.origin, ...(binding.adminOrigins ?? [])],
      ),
    authenticate: async () => ({ userId: options.userId ?? USER }),
    rpc: async (name, args, auth) => {
      rpcCalls.push({ name, args, auth });
      if (name.includes("admin") && options.role === "merchant") {
        throw new RequestError(403, "forbidden", "Admin required.");
      }
      if (options.denied) {
        throw new RequestError(403, "unavailable", "Unavailable.");
      }
      const input = args.p_input as Json | undefined;
      switch (name) {
        case "get_admin_merchant_connections":
          return { merchants: [], products: [] };
        case "create_admin_merchant_invitation_v2":
          return {
            ...context(),
            expires_at: input?.expires_at,
            token_request_id: input?.request_id,
            token_key_id: input?.key_id,
            token_sha256: input?.token_sha256,
            delivery: {
              status: "not_sent",
              recipient: "merchant@example.com",
              retry_at: null,
              can_retry: true,
            },
          };
        case "claim_merchant_invitation":
          if (input?.token_sha256 !== await tokenHash(TOKEN)) {
            throw new RequestError(403, "invalid_invite", "Unavailable");
          }
          return context();
        case "begin_merchant_oauth":
          return {};
        case "consume_merchant_oauth":
          if (
            consumed || input?.user_id !== USER ||
            input?.state_sha256 !== await tokenHash(STATE)
          ) throw new RequestError(403, "invalid_state", "Unavailable");
          consumed = true;
          return context();
        case "record_merchant_connection_candidate":
          candidate = input ?? {};
          return context();
        case "refresh_merchant_connection_candidate":
          candidate = { ...candidate, ...input };
          return context();
        case "merchant_connection_status":
          return context();
        case "confirm_merchant_connection":
          status = "connected";
          return context();
        default:
          return {};
      }
    },
    provider: (b) => new MerchantProvider(b, fetcher),
    random: () => STATE,
    now: () => NOW,
    mailConfig: () => MAIL_CONFIG,
  });
  return { handler, calls, rpcCalls, fetcher };
}
Deno.test("merchant config disabled never reads provider keys; provider separately disabled", () => {
  const read: string[] = [];
  assertEquals(
    merchantBindings((name) => {
      read.push(name);
      return undefined;
    }).size,
    0,
  );
  assertEquals(read, ["MERCHANT_CONNECT_ENABLED"]);
  const values: Record<string, string> = {
    MERCHANT_CONNECT_ENABLED: "true",
    MERCHANT_CONNECT_ALLOWED_ORIGINS: B.origin,
    MERCHANT_CONNECT_BINDINGS_JSON: JSON.stringify({
      test: {
        platform_account_id: B.platformAccountId,
        livemode: false,
        client_id: B.clientId,
        origin: B.origin,
        callback_url: B.callbackUrl,
        secret_env: "STRIPE_TEST",
      },
    }),
  };
  const accessed: string[] = [];
  const config = merchantBindings((name) => {
    accessed.push(name);
    return values[name];
  }).get("test")!;
  assertEquals(config.providerEnabled, false);
  assertEquals(accessed.includes("STRIPE_TEST"), false);
});
Deno.test("config rejects wrong-origin callbacks and live without separate opt-in", async () => {
  for (
    const changes of [
      { callback_url: "https://evil.example/merchant/callback" },
      { livemode: true },
      { callback_url: `${B.callbackUrl}?redirect=evil` },
      { callback_url: `${B.origin}/other` },
    ]
  ) {
    const env: Record<string, string> = {
      MERCHANT_CONNECT_ENABLED: "true",
      MERCHANT_CONNECT_ALLOWED_ORIGINS: B.origin,
      MERCHANT_CONNECT_BINDINGS_JSON: JSON.stringify({
        test: {
          platform_account_id: B.platformAccountId,
          livemode: false,
          client_id: B.clientId,
          origin: B.origin,
          callback_url: B.callbackUrl,
          secret_env: "STRIPE_TEST",
          ...changes,
        },
      }),
    };
    await assertRejects(async () => merchantBindings((name) => env[name]));
  }
});
Deno.test("cross-origin, missing-auth and client account/redirect injection never reach provider", async () => {
  const f = fixture();
  assertEquals(
    (await f.handler(request({ action: "status" }, "https://evil.example")))
      .status,
    403,
  );
  assertEquals(
    (await f.handler(request({ action: "status" }, B.origin, false))).status,
    401,
  );
  for (
    const extra of [{ account_id: "acct_Attack" }, {
      return_url: "https://evil.example",
    }, { commission: 20 }]
  ) {
    assertEquals(
      (await f.handler(
        request({ action: "start_connection", invite_token: TOKEN, ...extra }),
      )).status,
      400,
    );
  }
  assertEquals(f.calls.length, 0);
});
Deno.test("admin invitation stores only token hash and returns KMA fragment invitation", async () => {
  const f = fixture();
  const response = await f.handler(
    request({
      action: "create_invitation",
      request_id: ID,
      binding_id: "test",
      business_name: "Merchant Limited",
      email: "MERCHANT@example.com",
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(
    body.invitation_url,
    `${B.origin}/merchant/connect#invite=${await deriveInvitationToken(
      MAIL_CONFIG,
      "v1",
      ID,
    )}`,
  );
  const input = f.rpcCalls[0].args.p_input as Json;
  assertEquals(
    input.token_sha256,
    await tokenHash(await deriveInvitationToken(MAIL_CONFIG, "v1", ID)),
  );
  assertEquals(JSON.stringify(input).includes(STATE), false);
  assertEquals(f.calls.length, 0);
  assertEquals(f.rpcCalls[0].auth?.startsWith("Bearer "), true);
});
Deno.test("recipient cannot invoke admin operations", async () => {
  const f = fixture({ role: "merchant" });
  for (
    const body of [{ action: "status" }, {
      action: "create_invitation",
      request_id: ID,
      binding_id: "test",
      business_name: "Merchant",
      email: "m@example.com",
    }, {
      action: "assign_product",
      product_id: ID,
      merchant_id: ID,
      livemode: false,
    }, { action: "revoke", merchant_id: ID, livemode: false }]
  ) assertEquals((await f.handler(request(body))).status, 403);
  assertEquals(f.calls.length, 0);
});
Deno.test("claimed verified recipient gets exact Stripe authorization destination and hashed state", async () => {
  const f = fixture();
  const response = await f.handler(
    request({ action: "start_connection", invite_token: TOKEN }),
  );
  assertEquals(response.status, 200);
  const url = new URL((await response.json()).authorization_url);
  assertEquals(url.origin, "https://connect.stripe.com");
  assertEquals(url.searchParams.get("scope"), "read_write");
  assertEquals(url.searchParams.get("redirect_uri"), B.callbackUrl);
  assertEquals(url.searchParams.get("state"), STATE);
  const saved = f.rpcCalls.find((c) => c.name === "begin_merchant_oauth")!.args
    .p_input as Json;
  assertEquals(saved.state_sha256, await tokenHash(STATE));
  assertEquals(saved.user_id, USER);
  assertEquals(f.calls.length, 1);
});
Deno.test("expired/revoked/wrong-email invitations fail before Stripe and disabled provider never starts", async () => {
  for (
    const f of [
      fixture({ denied: true }),
      fixture({ binding: { ...B, providerEnabled: false } }),
    ]
  ) {
    const response = await f.handler(
      request({ action: "start_connection", invite_token: TOKEN }),
    );
    assertEquals(response.status === 403 || response.status === 503, true);
    assertEquals(f.calls.length, 0);
    assertEquals(
      f.rpcCalls.some((c) => c.name === "begin_merchant_oauth"),
      false,
    );
  }
});
Deno.test("callback exchanges once, verifies selected account using platform key, drops all OAuth tokens", async () => {
  const f = fixture();
  const req = {
    action: "complete_connection",
    state: STATE,
    code: "ac_oneusecode123",
  };
  const response = await f.handler(request(req));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.connection.candidate.account_id, "acct_Merchant");
  assertEquals(JSON.stringify(body).includes("SECRET_"), false);
  assertEquals(JSON.stringify(f.rpcCalls).includes("SECRET_"), false);
  const merchantRead = f.calls.find((c) => c.headers.has("Stripe-Account"))!;
  assertEquals(merchantRead.headers.get("Stripe-Account"), "acct_Merchant");
  assertEquals(
    merchantRead.headers.get("Authorization"),
    `Basic ${btoa(`${B.secret}:`)}`,
  );
  assertEquals((await f.handler(request(req))).status, 403);
  assertEquals(f.calls.filter((c) => c.url.endsWith("/oauth/token")).length, 1);
  assertEquals(
    (await f.handler(
      request({ action: "confirm_connection", invitation_id: ID }),
    )).status,
    200,
  );
  assertEquals(
    f.rpcCalls.find((c) => c.name === "confirm_merchant_connection")!.args
      .p_input,
    { invitation_id: ID, user_id: USER, account_id: "acct_Merchant" },
  );
});
Deno.test("wrong-user OAuth callback cannot consume state or exchange", async () => {
  const f = fixture({ userId: "someone-else" });
  assertEquals(
    (await f.handler(
      request({
        action: "complete_connection",
        state: STATE,
        code: "ac_oneusecode123",
      }),
    )).status,
    403,
  );
  assertEquals(f.calls.length, 0);
});
Deno.test("mode mismatch or returned different account cannot save candidate", async () => {
  for (const options of [{ tokenMode: true }, { wrongAccount: true }]) {
    const f = fixture(options);
    assertEquals(
      (await f.handler(
        request({
          action: "complete_connection",
          state: STATE,
          code: "ac_oneusecode123",
        }),
      )).status,
      409,
    );
    assertEquals(
      f.rpcCalls.some((c) => c.name === "record_merchant_connection_candidate"),
      false,
    );
  }
});
Deno.test("provider failures are redacted and cannot replay consumed OAuth code", async () => {
  const f = fixture({ providerError: true });
  const req = {
    action: "complete_connection",
    state: STATE,
    code: "ac_oneusecode123",
  };
  const response = await f.handler(request(req));
  assertEquals(response.status, 502);
  assertEquals((await response.text()).includes("SECRET"), false);
  assertEquals((await f.handler(request(req))).status, 403);
  assertEquals(f.calls.filter((c) => c.url.endsWith("/oauth/token")).length, 1);
});
Deno.test("merchant must confirm actual verified account and finish Stripe requirements", async () => {
  const f = fixture({ incomplete: true });
  assertEquals(
    (await f.handler(
      request({
        action: "complete_connection",
        state: STATE,
        code: "ac_oneusecode123",
      }),
    )).status,
    200,
  );
  const response = await f.handler(
    request({ action: "confirm_connection", invitation_id: ID }),
  );
  assertEquals(response.status, 409);
  assertStringIncludes(await response.text(), "merchant_account_incomplete");
  assertEquals(
    f.rpcCalls.some((c) => c.name === "confirm_merchant_connection"),
    false,
  );
});

Deno.test("refresh uses the saved candidate account and cannot change it from client input", async () => {
  const f = fixture();
  await f.handler(
    request({
      action: "complete_connection",
      state: STATE,
      code: "ac_oneusecode123",
    }),
  );
  assertEquals(
    (await f.handler(
      request({
        action: "refresh_connection",
        invitation_id: ID,
        account_id: "acct_Attack",
      }),
    )).status,
    400,
  );
  assertEquals(
    (await f.handler(
      request({ action: "refresh_connection", invitation_id: ID }),
    )).status,
    200,
  );
  const write = f.rpcCalls.find((c) =>
    c.name === "refresh_merchant_connection_candidate"
  )!;
  assertEquals((write.args.p_input as Json).account_id, "acct_Merchant");
  assertEquals((write.args.p_input as Json).user_id, USER);
});

const ADMIN_ORIGIN = "https://admin.kissmyapps.dev";
const SPLIT: MerchantBinding = {
  ...B,
  origin: "https://partners.kissmyapps.dev",
  callbackUrl: "https://partners.kissmyapps.dev/merchant/callback",
  adminOrigins: [ADMIN_ORIGIN],
};
const invitation = {
  action: "create_invitation",
  request_id: ID,
  binding_id: "test",
  business_name: "Merchant Limited",
  email: "merchant@example.com",
};
function splitConfig(adminOrigins: unknown = [ADMIN_ORIGIN]) {
  return {
    MERCHANT_CONNECT_ENABLED: "true",
    MERCHANT_CONNECT_ALLOWED_ORIGINS: `${SPLIT.origin},${ADMIN_ORIGIN}`,
    MERCHANT_CONNECT_BINDINGS_JSON: JSON.stringify({
      test: {
        platform_account_id: B.platformAccountId,
        livemode: false,
        client_id: B.clientId,
        origin: SPLIT.origin,
        admin_origins: adminOrigins,
        callback_url: SPLIT.callbackUrl,
        secret_env: "STRIPE_TEST",
      },
    }),
  } as Record<string, string>;
}
Deno.test("binding config separates approved admin origins from recipient callback and retains legacy fallback", () => {
  const env = splitConfig();
  const configured = merchantBindings((name) => env[name]).get("test")!;
  assertEquals(configured.adminOrigins, [ADMIN_ORIGIN]);
  assertEquals(configured.origin, SPLIT.origin);
  assertEquals(configured.callbackUrl, SPLIT.callbackUrl);
  const old = splitConfig(undefined);
  const parsed = JSON.parse(old.MERCHANT_CONNECT_BINDINGS_JSON);
  delete parsed.test.admin_origins;
  old.MERCHANT_CONNECT_BINDINGS_JSON = JSON.stringify(parsed);
  assertEquals(
    merchantBindings((name) => old[name]).get("test")!.adminOrigins,
    [SPLIT.origin],
  );
});
Deno.test("admin origin config fails closed on malformed, duplicate, unallowlisted and unsafe origins", async () => {
  for (
    const invalidOrigins of [
      null,
      ADMIN_ORIGIN,
      [],
      [ADMIN_ORIGIN, ADMIN_ORIGIN],
      ["https://unconfigured.example"],
      ["https://admin.kissmyapps.dev/path"],
      ["https://admin.kissmyapps.dev/"],
      ["http://admin.kissmyapps.dev"],
      [12],
      Array(11).fill(ADMIN_ORIGIN),
    ]
  ) {
    const env = splitConfig(invalidOrigins);
    await assertRejects(async () => merchantBindings((name) => env[name]));
  }
});
Deno.test("split admin preflight, workspace and invitation work while invitation stays on recipient portal", async () => {
  const f = fixture({ binding: SPLIT });
  const preflight = await f.handler(
    new Request("https://functions.example/merchant-connect", {
      method: "OPTIONS",
      headers: { Origin: ADMIN_ORIGIN },
    }),
  );
  assertEquals(preflight.status, 204);
  assertEquals(
    preflight.headers.get("Access-Control-Allow-Origin"),
    ADMIN_ORIGIN,
  );
  assertEquals(f.rpcCalls.length, 0);
  const status = await f.handler(request({ action: "status" }, ADMIN_ORIGIN));
  const workspace = await status.json();
  assertEquals(status.status, 200);
  assertEquals(workspace.bindings, [{
    id: B.id,
    platform_account_id: B.platformAccountId,
    livemode: false,
    provider_enabled: true,
  }]);
  assertEquals(f.rpcCalls[0].name, "get_admin_merchant_connections");
  const response = await f.handler(request(invitation, ADMIN_ORIGIN));
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    ADMIN_ORIGIN,
  );
  assertEquals(
    body.invitation_url,
    `${SPLIT.origin}/merchant/connect#invite=${await deriveInvitationToken(
      MAIL_CONFIG,
      "v1",
      ID,
    )}`,
  );
  assertEquals(f.rpcCalls[1].auth?.startsWith("Bearer "), true);
  for (
    const forbidden of [
      B.secret,
      "secret_env",
      "client_id",
      "callback_url",
      "admin_origins",
    ]
  ) {
    assertEquals(
      JSON.stringify({ workspace, body }).includes(forbidden),
      false,
    );
  }
  assertEquals(f.calls.length, 0);
});
Deno.test("global CORS approval never grants an unconfigured admin binding or bypasses admin role", async () => {
  const other = "https://other.kissmyapps.dev";
  const f = fixture({
    binding: SPLIT,
    origins: [ADMIN_ORIGIN, SPLIT.origin, other],
  });
  for (const origin of [SPLIT.origin, other]) {
    for (
      const action of [invitation, { action: "status" }, {
        action: "assign_product",
        product_id: ID,
        merchant_id: ID,
        livemode: false,
      }, { action: "revoke", merchant_id: ID, livemode: false }]
    ) {
      assertEquals((await f.handler(request(action, origin))).status, 403);
    }
  }
  assertEquals(f.rpcCalls.length, 0);
  const denied = fixture({ binding: SPLIT, role: "merchant" });
  for (
    const action of [invitation, { action: "status" }, {
      action: "assign_product",
      product_id: ID,
      merchant_id: ID,
      livemode: false,
    }, { action: "revoke", merchant_id: ID, livemode: false }]
  ) {
    assertEquals(
      (await denied.handler(request(action, ADMIN_ORIGIN))).status,
      403,
    );
  }
  assertEquals(denied.rpcCalls.length, 4);
  assertEquals(
    denied.rpcCalls.every((call) => call.auth?.startsWith("Bearer ")),
    true,
  );
  assertEquals(denied.calls.length, 0);
  assertEquals(
    (await f.handler(
      request({
        action: "assign_product",
        product_id: ID,
        merchant_id: ID,
        livemode: true,
      }, ADMIN_ORIGIN),
    )).status,
    503,
  );
  assertEquals(f.rpcCalls.length, 0);
});
Deno.test("recipient actions reject admin origin before consuming invitation or OAuth state", async () => {
  const f = fixture({ binding: SPLIT });
  const actions = [
    { action: "inspect_invitation", invite_token: TOKEN },
    { action: "start_connection", invite_token: TOKEN },
    { action: "complete_connection", state: STATE, code: "ac_oneusecode123" },
    ...["connection_status", "refresh_connection", "confirm_connection"].map(
      (action) => ({ action, invitation_id: ID }),
    ),
  ];
  for (const action of actions) {
    assertEquals((await f.handler(request(action, ADMIN_ORIGIN))).status, 403);
  }
  assertEquals(f.rpcCalls.length, 0);
  assertEquals(f.calls.length, 0);
  const start = await f.handler(request(actions[1], SPLIT.origin));
  assertEquals(start.status, 200);
  const authorization = new URL((await start.json()).authorization_url);
  assertEquals(
    authorization.searchParams.get("redirect_uri"),
    SPLIT.callbackUrl,
  );
  assertEquals(
    (await f.handler(request(actions[2], SPLIT.origin))).status,
    200,
  );
  assertEquals(
    (await f.handler(request(actions[5], SPLIT.origin))).status,
    200,
  );
});
Deno.test("recipient inspection and status cannot expose a different account binding", async () => {
  for (
    const action of [{ action: "inspect_invitation", invite_token: TOKEN }, {
      action: "connection_status",
      invitation_id: ID,
    }]
  ) {
    const f = fixture({
      binding: SPLIT,
      contextPlatformAccountId: "acct_OtherPlatform",
    });
    const response = await f.handler(request(action, SPLIT.origin));
    assertEquals(response.status, 503);
    const body = await response.text();
    assertEquals(body.includes("merchant@example.com"), false);
    assertEquals(body.includes("acct_OtherPlatform"), false);
    assertEquals(f.calls.length, 0);
  }
});

Deno.test("disabled merchant feature retains authenticated disabled-status response without opening mutations", async () => {
  const f = fixture({ binding: SPLIT, disabled: true });
  const response = await f.handler(request({ action: "status" }, ADMIN_ORIGIN));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.enabled, false);
  assertEquals(body.bindings, []);
  assertEquals(f.rpcCalls[0].name, "get_admin_merchant_connections");
  assertEquals(f.rpcCalls[0].auth?.startsWith("Bearer "), true);
  assertEquals(
    (await f.handler(request(invitation, ADMIN_ORIGIN))).status,
    403,
  );
  assertEquals(f.rpcCalls.length, 1);
  assertEquals(f.calls.length, 0);
  const recipient = fixture({
    binding: SPLIT,
    disabled: true,
    role: "merchant",
  });
  assertEquals(
    (await recipient.handler(request({ action: "status" }, ADMIN_ORIGIN)))
      .status,
    403,
  );
});
