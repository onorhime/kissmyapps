// deno-lint-ignore-file require-await -- Injected boundaries preserve production signatures.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createMerchantConnectHandler, tokenHash } from "./index.ts";
import { sendInvitationOtp } from "./invitation-otp.ts";
import { RequestError } from "../_shared/errors.ts";
import { type Json, type MerchantBinding } from "./provider.ts";
const ID = "aa190000-0000-4000-8000-000000000001", TOKEN = "a".repeat(43);
const B: MerchantBinding = {
  id: "test",
  platformAccountId: "acct_fixture",
  livemode: false,
  clientId: "ca_fixture",
  secret: "sk_test_synthetic",
  origin: "https://partners.example.invalid",
  adminOrigins: ["https://admin.example.invalid"],
  callbackUrl: "https://partners.example.invalid/merchant/callback",
  providerEnabled: false,
};
const body = {
  action: "request_invitation_code",
  invite_token: TOKEN,
  request_id: ID,
};
const request = (
  input: Json = body,
  origin = B.origin,
  authorization?: string,
) =>
  new Request("https://functions.example.invalid/merchant-connect", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(input),
  });
function fixture(
  options: {
    unavailable?: boolean;
    status?: string;
    wrongBinding?: boolean;
    send?: boolean;
    outcome?: "sent" | "unknown" | "failed";
    finishFails?: boolean;
    prepareUnavailable?: boolean;
  } = {},
) {
  const calls: Array<{ name: string; args: Json; auth?: string }> = [],
    sent: Array<{ email: string; origin: string }> = [];
  let authenticated = 0;
  const reply = {
    email: "stored@example.invalid",
    expires_at: "2026-10-25T10:00:00Z",
    retry_at: "2026-10-19T10:01:00Z",
    status: "cooldown",
  };
  const handler = createMerchantConnectHandler({
    origins: () => new Set([B.origin, ...B.adminOrigins!]),
    bindings: () => new Map([["test", B]]),
    authenticate: async () => {
      authenticated++;
      throw new RequestError(401, "unauthorized", "Sign in");
    },
    otpSend: async (email, origin) => {
      sent.push({ email, origin });
      return { status: options.outcome ?? "sent" };
    },
    rpc: async (name, args, auth) => {
      calls.push({ name, args, auth });
      if (name === "merchant_invitation_context") {
        if (options.unavailable) {
          throw new RequestError(403, "merchant_access_denied", "Unavailable");
        }
        return {
          email: reply.email,
          platform_account_id: options.wrongBinding
            ? "acct_wrong"
            : B.platformAccountId,
          livemode: false,
          status: options.status ?? "invited",
          candidate: { secret: "not_public" },
        };
      }
      if (name === "prepare_merchant_invitation_code") {
        if (options.prepareUnavailable) {
          throw new RequestError(
            403,
            "merchant_access_denied",
            "Revoked in race",
          );
        }
        return {
          ...reply,
          send: options.send ?? true,
          lease_id: ID,
          request_id: ID,
        };
      }
      if (name === "finish_merchant_invitation_code") {
        if (options.finishFails) throw new Error("database unavailable");
        return { ...reply, status: args.p_status };
      }
      throw new Error("unexpected RPC");
    },
  });
  return { handler, calls, sent, authenticated: () => authenticated };
}
Deno.test("anonymous valid invitation sends code only to stored recipient using recipient portal", async () => {
  const f = fixture();
  const response = await f.handler(request());
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.email, "stored@example.invalid");
  assertEquals(result.status, "sent");
  assertEquals(f.sent, [{ email: "stored@example.invalid", origin: B.origin }]);
  assertEquals(f.authenticated(), 0);
  assertEquals(f.calls[0].args.p_token_sha256, await tokenHash(TOKEN));
  assertEquals(f.calls[1].args.p_recipient_origin, B.origin);
  assertEquals(f.calls.every((c) => c.auth === undefined), true);
  for (
    const key of [
      "candidate",
      "lease_id",
      "platform_account_id",
      "token_sha256",
      "invite_token",
    ]
  ) assertEquals(result[key], undefined);
});
Deno.test("public OTP action does not make existing actions anonymous", async () => {
  const f = fixture();
  for (
    const action of [
      "status",
      "inspect_invitation",
      "start_connection",
      "get_invitation_link",
    ]
  ) {
    assertEquals(
      (await f.handler(request({
        action,
        ...(action === "status"
          ? {}
          : action === "get_invitation_link"
          ? { invitation_id: ID }
          : { invite_token: TOKEN }),
      }))).status,
      401,
    );
  }
  assertEquals(f.calls.length, 0);
  assertEquals(f.sent.length, 0);
});
Deno.test("invalid token and request, recipient or redirect injection never send", async () => {
  for (
    const extra of [
      { email: "arbitrary@example.invalid" },
      { redirect: "https://evil.invalid" },
      { metadata: { admin: true } },
      { request_id: undefined },
      { invite_token: "short" },
    ]
  ) {
    const f = fixture();
    assertEquals((await f.handler(request({ ...body, ...extra }))).status, 400);
    assertEquals(f.sent.length, 0);
    assertEquals(f.calls.length, 0);
  }
});
Deno.test("GET, admin origin and unconfigured origin cannot trigger code mail", async () => {
  const f = fixture();
  assertEquals(
    (await f.handler(
      new Request("https://functions.example.invalid/merchant-connect", {
        headers: { origin: B.origin },
      }),
    )).status,
    405,
  );
  for (const origin of [B.adminOrigins![0], "https://evil.invalid"]) {
    assertEquals((await f.handler(request(body, origin))).status, 403);
  }
  assertEquals(f.calls.length, 0);
});
Deno.test("invalid, expired, revoked, connected or mismatched binding reveals no recipient", async () => {
  for (
    const opts of [
      { unavailable: true },
      { status: "expired" },
      { status: "revoked" },
      { status: "connected" },
      { wrongBinding: true },
      { prepareUnavailable: true },
    ]
  ) {
    const f = fixture(opts);
    const response = await f.handler(request());
    assertEquals(response.status === 403 || response.status === 503, true);
    const result = await response.json();
    assertEquals(result.email, undefined);
    assertEquals(f.sent.length, 0);
  }
});
Deno.test("duplicate or cooldown result does not call Auth OTP again", async () => {
  const f = fixture({ send: false });
  const result = await (await f.handler(request())).json();
  assertEquals(result.status, "cooldown");
  assertEquals(f.sent.length, 0);
  assertEquals(f.calls.length, 2);
  assertStringIncludes(result.retry_at, "2026-");
});
Deno.test("ambiguous Auth response or lost finish stays unknown and does not retry transport", async () => {
  for (
    const options of [{ outcome: "unknown" as const }, { finishFails: true }]
  ) {
    const f = fixture(options);
    const result = await (await f.handler(request())).json();
    assertEquals(result.status, "unknown");
    assertEquals(result.email, "stored@example.invalid");
    assertEquals(f.sent.length, 1);
  }
});
Deno.test("known Auth rejection is a failed send with retry guidance, never a fake success", async () => {
  const f = fixture({ outcome: "failed" });
  const result = await (await f.handler(request())).json();
  assertEquals(result.status, "failed");
  assertStringIncludes(result.retry_at, "2026-");
});
Deno.test("normal Auth OTP transport uses public key, fixed merchant metadata and bounded single POST", async () => {
  const read = (
    name: string,
  ) => ({
    SUPABASE_URL: "https://project.example.invalid",
    SUPABASE_ANON_KEY: "public_anon_synthetic",
  }[name]!);
  let calls = 0;
  const result = await sendInvitationOtp(
    "stored@example.invalid",
    B.origin,
    async (url, init) => {
      calls++;
      const target = new URL(String(url));
      assertEquals(target.origin, "https://project.example.invalid");
      assertEquals(target.pathname, "/auth/v1/otp");
      assertEquals(
        target.searchParams.get("redirect_to"),
        `${B.origin}/merchant/connect`,
      );
      assertEquals(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assertEquals(headers.get("apikey"), "public_anon_synthetic");
      assertEquals(JSON.parse(String(init?.body)), {
        email: "stored@example.invalid",
        create_user: true,
        data: { registration_flow: "merchant_v1" },
        gotrue_meta_security: {},
      });
      assertEquals(init?.signal instanceof AbortSignal, true);
      return Response.json({});
    },
    read,
  );
  assertEquals(result, { status: "sent" });
  assertEquals(calls, 1);
  assertEquals(
    await sendInvitationOtp("stored@example.invalid", B.origin, async () => {
      throw new Error("timeout");
    }, read),
    { status: "unknown" },
  );
  assertEquals(
    await sendInvitationOtp(
      "stored@example.invalid",
      B.origin,
      async () =>
        Response.json({ error: "private provider detail" }, { status: 429 }),
      read,
    ),
    { status: "failed" },
  );
  assertEquals(
    await sendInvitationOtp(
      "stored@example.invalid",
      B.origin,
      async () => Response.json({}, { status: 503 }),
      read,
    ),
    { status: "unknown" },
  );
});
