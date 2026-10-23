/** Actual merchant handler and database acceptance. Only the mail transport is synthetic. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createMerchantConnectHandler,
  tokenHash,
} from "../supabase/functions/merchant-connect/index.ts";
import { RequestError } from "../supabase/functions/_shared/errors.ts";
import type {
  InvitationEnvelope,
  InvitationMailOutcome,
} from "../supabase/functions/merchant-connect/invitation-email.ts";

const controlOrigin = Deno.env.get("MERCHANT_MAIL_ACCEPTANCE_ORIGIN") ?? "";
const controlSecret = Deno.env.get("MERCHANT_MAIL_ACCEPTANCE_SECRET") ?? "";
if (
  new URL(controlOrigin).hostname !== "127.0.0.1" ||
  !/^[a-f0-9]{64}$/.test(controlSecret)
) {
  throw Error("Isolated loopback fixture required.");
}
async function control(path: string, body: Record<string, unknown>) {
  const response = await fetch(controlOrigin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fixture-control": controlSecret,
    },
    body: JSON.stringify(body),
    redirect: "error",
  });
  if (!response.ok) throw Error("Local database bridge failed.");
  return await response.json();
}
const sql = async (statement: string) =>
  (await control("/sql", { sql: statement })).result;
const adminOrigin = "https://admin.fixture.invalid";
const merchantOrigin = "https://merchant.fixture.invalid";
const bearer = "Bearer " + "a".repeat(64);
const userId = "ac570000-0000-4000-8000-000000000011";
const binding = {
  id: "mail-acceptance",
  platformAccountId: "acct_MailAcceptance",
  livemode: false,
  clientId: "ca_MailAcceptance",
  secret: "",
  providerEnabled: false,
  origin: merchantOrigin,
  adminOrigins: [adminOrigin],
  callbackUrl: merchantOrigin + "/merchant/callback",
};
const messages: { envelope: InvitationEnvelope; key: string }[] = [];
const codes: { email: string; origin: string }[] = [];
let nextOutcome: InvitationMailOutcome = {
  status: "sent",
  provider_id: "mail_fixture_1",
};
const handler = createMerchantConnectHandler({
  bindings: () => new Map([[binding.id, binding]]),
  origins: () => new Set([adminOrigin, merchantOrigin]),
  authenticate: async (authorization) => {
    if (authorization !== bearer) {
      throw new RequestError(401, "unauthorized", "Fixture sign-in required.");
    }
    return { userId };
  },
  rpc: async (name, args, authorization) => {
    const response = await control("/rpc", {
      name,
      args,
      admin: authorization === bearer,
    });
    if (response.error) {
      throw new RequestError(
        response.error.code === "42501" ? 403 : 409,
        "fixture_database_rejected",
        "Database guard rejected the operation.",
      );
    }
    return response.data;
  },
  mailConfig: () => ({
    enabled: true,
    from: "KissMyApps <mail@example.invalid>",
    activeKeyId: "fixture-v1",
    tokenKeys: { "fixture-v1": "b".repeat(64) },
  }),
  mailSend: async (envelope, key) => {
    messages.push({ envelope, key });
    return nextOutcome;
  },
  otpSend: async (email, origin) => {
    codes.push({ email, origin });
    return { status: "sent" };
  },
});
async function action(
  body: Record<string, unknown>,
  origin = adminOrigin,
  authorization = bearer,
) {
  const response = await handler(
    new Request(controlOrigin, {
      method: "POST",
      headers: { origin, authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { code: response.status, body: await response.json() };
}
const cases: string[] = [];
const creation = {
  action: "create_invitation",
  binding_id: binding.id,
  request_id: crypto.randomUUID(),
  business_name: "Local email acceptance",
  email: "MAIL-ACCEPTANCE@EXAMPLE.INVALID",
};
const created = await action(creation);
assertEquals(created.code, 200);
assertEquals(created.body.delivery.status, "sent");
assertEquals(
  created.body.delivery.recipient,
  "mail-acceptance@example.invalid",
);
assertEquals(messages.length, 1);
assertEquals(messages[0].envelope.to, "mail-acceptance@example.invalid");
assertStringIncludes(messages[0].envelope.html, created.body.invitation_url);
cases.push("create sends one invitation with server-owned recipient and link");

const replay = await action(creation);
assertEquals(replay.code, 200);
assertEquals(replay.body.invitation_url, created.body.invitation_url);
assertEquals(messages.length, 1);
cases.push(
  "same request replay returns existing invitation without a duplicate email",
);

const conflict = await action({
  ...creation,
  business_name: "Different payload",
});
assertEquals(conflict.code, 409);
assertEquals(messages.length, 1);
cases.push("request identity cannot be reused with different merchant details");

const copied = await action({
  action: "get_invitation_link",
  invitation_id: created.body.invitation_id,
});
assertEquals(copied.code, 200);
assertEquals(copied.body.invitation_url, created.body.invitation_url);
assertEquals(messages.length, 1);
cases.push(
  "admin retrieves the same secure link without sending another email",
);

const workspace = await action({ action: "status" });
assertEquals(workspace.code, 200);
const token = new URL(created.body.invitation_url).hash.slice(
  "#invite=".length,
);
assert(!JSON.stringify(workspace.body).includes(token));
const stored = JSON.parse(
  await sql(
    `select to_jsonb(i) from public.merchant_invitations i where id='${created.body.invitation_id}'::uuid`,
  ),
);
assertEquals(stored.token_sha256, await tokenHash(token));
assert(!JSON.stringify(stored).includes(token));
cases.push(
  "workspace and stored invitation never contain the raw bearer link token",
);

const codeRequest = {
  action: "request_invitation_code",
  invite_token: token,
  request_id: crypto.randomUUID(),
};
const requested = await action(codeRequest, merchantOrigin, "");
assertEquals(requested.code, 200);
assertEquals(requested.body.status, "sent");
assertEquals(requested.body.email, "mail-acceptance@example.invalid");
assertEquals(codes, [{
  email: "mail-acceptance@example.invalid",
  origin: merchantOrigin,
}]);
assertEquals(Object.keys(requested.body).sort(), [
  "email",
  "expires_at",
  "request_id",
  "retry_at",
  "status",
]);
assertEquals(
  await sql(
    `select claimed_by is null from public.merchant_invitations where id='${created.body.invitation_id}'::uuid`,
  ),
  "t",
);
cases.push(
  "anonymous invite starts one saved-recipient OTP without claiming invitation or exposing merchant metadata",
);

const repeated = await Promise.all(
  Array.from({ length: 6 }, () => action(codeRequest, merchantOrigin, "")),
);
assert(repeated.every((r) => r.code === 200 && r.body.status === "sent"));
assertEquals(codes.length, 1);
assertEquals(
  (await action(
    { ...codeRequest, request_id: crypto.randomUUID() },
    merchantOrigin,
    "",
  )).body.status,
  "cooldown",
);
assertEquals(codes.length, 1);
cases.push(
  "anonymous refresh replay and parallel requests send no duplicate OTP; a fresh request respects recipient cooldown",
);

assertEquals((await action(codeRequest, adminOrigin, "")).code, 403);
assertEquals(
  (await action(codeRequest, "https://unapproved.invalid", "")).code,
  403,
);
assertEquals(
  (await action(
    { ...codeRequest, email: "other@example.invalid" },
    merchantOrigin,
    "",
  )).code,
  400,
);
assertEquals(
  (await action(
    { action: "inspect_invitation", invite_token: token },
    merchantOrigin,
    "",
  )).code,
  401,
);
assertEquals(codes.length, 1);
cases.push(
  "anonymous OTP route preserves recipient origin, fixed email and authentication requirements for every claim action",
);

const resend = await action({
  action: "resend_invitation",
  invitation_id: created.body.invitation_id,
  request_id: crypto.randomUUID(),
});
assert(
  resend.code === 409 || resend.code === 429 ||
    (resend.code === 200 && resend.body.delivery.can_retry === false),
);
assertEquals(messages.length, 1);
cases.push("immediate resend is throttled before a provider call");

assertEquals(
  (await action({
    action: "get_invitation_link",
    invitation_id: created.body.invitation_id,
  }, merchantOrigin)).code,
  403,
);
assertEquals((await action(creation, "https://unapproved.invalid")).code, 403);
assertEquals(
  (await action(creation, adminOrigin, "Bearer " + "z".repeat(64))).code,
  401,
);
assertEquals(messages.length, 1);
cases.push(
  "recipient portal, unapproved origin and invalid session cannot send or recover admin invitations",
);

nextOutcome = { status: "failed", error_code: "provider_http_422" };
const failed = await action({
  ...creation,
  request_id: crypto.randomUUID(),
  business_name: "Local failed email",
  email: "mail-failed@example.invalid",
});
assertEquals(failed.code, 200);
assertEquals(failed.body.delivery.status, "failed");
assertStringIncludes(failed.body.invitation_url, merchantOrigin);
cases.push("known provider rejection preserves invitation and reports failure");

nextOutcome = { status: "unknown", error_code: "provider_response_unknown" };
const unknown = await action({
  ...creation,
  request_id: crypto.randomUUID(),
  business_name: "Local uncertain email",
  email: "mail-unknown@example.invalid",
});
assertEquals(unknown.code, 200);
assertEquals(unknown.body.delivery.status, "unknown");
cases.push("ambiguous provider response does not claim sent or failed");

const expireCooldown = async (id: string) => {
  assert(/^[a-f0-9-]{36}$/.test(id));
  await sql(
    `update kma_internal.merchant_invitation_deliveries set retry_at=clock_timestamp()-interval '1 second',leased_until=clock_timestamp()-interval '1 second' where invitation_id='${id}'::uuid`,
  );
};
await expireCooldown(created.body.invitation_id);
nextOutcome = { status: "sent", provider_id: "mail_fixture_resend" };
const resendRequest = {
  action: "resend_invitation",
  invitation_id: created.body.invitation_id,
  request_id: crypto.randomUUID(),
};
const resent = await action(resendRequest);
assertEquals(resent.code, 200);
assertEquals(resent.body.invitation_url, created.body.invitation_url);
assertEquals(resent.body.delivery.status, "sent");
assertEquals(messages.length, 4);
assert(messages[3].key !== messages[0].key);
assertEquals(messages[3].envelope, messages[0].envelope);
await action(resendRequest);
assertEquals(messages.length, 4);
cases.push(
  "explicit resend after cooldown uses the same link and replays once",
);

await expireCooldown(unknown.body.invitation_id);
const recovered = await action({
  action: "resend_invitation",
  invitation_id: unknown.body.invitation_id,
  request_id: crypto.randomUUID(),
});
assertEquals(recovered.code, 200);
assertEquals(recovered.body.delivery.status, "sent");
assertEquals(messages.length, 5);
assertEquals(messages[4].key, messages[2].key);
assertEquals(messages[4].envelope, messages[2].envelope);
cases.push(
  "uncertain delivery recovery reuses the exact provider idempotency key and payload",
);

await sql(
  `update public.merchant_invitations set revoked_at=clock_timestamp() where id='${created.body.invitation_id}'::uuid`,
);
assert(
  (await action({
    action: "get_invitation_link",
    invitation_id: created.body.invitation_id,
  })).code >= 400,
);
assert(
  (await action({
    action: "resend_invitation",
    invitation_id: created.body.invitation_id,
    request_id: crypto.randomUUID(),
  })).code >= 400,
);
assertEquals(messages.length, 5);
cases.push("revoked invitation cannot be copied or resent");
assert(
  (await action(
    { ...codeRequest, request_id: crypto.randomUUID() },
    merchantOrigin,
    "",
  )).code >= 400,
);
assertEquals(codes.length, 1);
cases.push("revoked invitation cannot trigger another verification code");

console.log(JSON.stringify({ passed: cases.length, cases }));
