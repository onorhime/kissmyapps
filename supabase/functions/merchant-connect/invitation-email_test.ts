// deno-lint-ignore-file require-await -- Mocked external boundaries remain async.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createMerchantConnectHandler, tokenHash } from "./index.ts";
import {
  deriveInvitationToken,
  type InvitationMailOutcome,
  renderInvitationEmail,
  sendInvitationEmail,
} from "./invitation-email.ts";
import { type Json, type MerchantBinding } from "./provider.ts";
import { RequestError } from "../_shared/errors.ts";
const ID = "ee190000-0000-4000-8000-000000000010",
  OTHER = "ee190000-0000-4000-8000-000000000020";
const CFG = {
  enabled: true,
  from: "KMA <partners@example.invalid>",
  activeKeyId: "v1",
  tokenKeys: { v1: "ab".repeat(32) },
};
const B: MerchantBinding = {
  id: "test",
  platformAccountId: "acct_fixture",
  livemode: false,
  clientId: "ca_test",
  secret: "sk_test_fake",
  origin: "https://partners.example.invalid",
  adminOrigins: ["https://admin.example.invalid"],
  callbackUrl: "https://partners.example.invalid/merchant/callback",
  providerEnabled: false,
};
const fields = {
  template_version: 1,
  from: CFG.from,
  to: "recipient@example.invalid",
  business_name: "Business <script>&",
  expires_at: "2026-10-25T10:00:00.000Z",
  origin: B.origin,
};
const req = (body: Json, origin = B.adminOrigins![0]) =>
  new Request("https://functions.example.invalid/merchant-connect", {
    method: "POST",
    headers: {
      origin,
      authorization: "Bearer " + "x".repeat(40),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
function fixture(
  opts: {
    outcome?: InvitationMailOutcome;
    finishFails?: boolean;
    status?: string;
    denied?: boolean;
    frozen?: boolean;
    digestMismatch?: boolean;
    enabled?: boolean;
    noSend?: boolean;
  } = {},
) {
  const calls: Array<{ name: string; args: Json; auth?: string }> = [],
    sends: Array<{ envelope: unknown; key: string }> = [];
  let preparing = 0;
  const delivery = {
    status: "not_sent",
    recipient: fields.to,
    retry_at: null,
    can_retry: true,
  };
  const handler = createMerchantConnectHandler({
    bindings: () => new Map([["test", B]]),
    origins: () => new Set([B.origin, ...B.adminOrigins!]),
    authenticate: async () => ({ userId: OTHER }),
    mailConfig: () => ({ ...CFG, enabled: opts.enabled ?? true }),
    mailSend: async (envelope, key) => {
      sends.push({ envelope, key });
      return opts.outcome ?? { status: "sent", provider_id: "email_accepted" };
    },
    rpc: async (name, args, auth) => {
      calls.push({ name, args, auth });
      if (opts.denied && auth) {
        throw new RequestError(403, "forbidden", "Admin required.");
      }
      if (
        name === "get_admin_merchant_invitation_delivery" ||
        name === "create_admin_merchant_invitation_v2"
      ) {
        return {
          invitation_id: ID,
          merchant_id: OTHER,
          platform_account_id: B.platformAccountId,
          livemode: false,
          email: fields.to,
          business_name: fields.business_name,
          expires_at: fields.expires_at,
          status: opts.status ?? "invited",
          token_request_id: ID,
          token_key_id: "v1",
          token_sha256: await tokenHash(
            await deriveInvitationToken(CFG, "v1", ID),
          ),
          delivery,
        };
      }
      if (name === "prepare_admin_merchant_invitation_email") {
        preparing++;
        if (opts.noSend) {
          return {
            send: false,
            delivery: { ...delivery, status: "sending", can_retry: false },
          };
        }
        if (opts.frozen && preparing === 1) {
          const frozen = {
            ...fields,
            from: "Original <original@example.invalid>",
          };
          const env = renderInvitationEmail(
            frozen,
            `${B.origin}/merchant/connect#invite=${await deriveInvitationToken(
              CFG,
              "v1",
              ID,
            )}`,
          );
          return {
            send: false,
            needs_frozen_envelope: true,
            envelope_fields: frozen,
            envelope_sha256: opts.digestMismatch
              ? "a".repeat(64)
              : await tokenHash(JSON.stringify(env)),
            delivery,
          };
        }
        return {
          send: true,
          delivery_id: OTHER,
          lease_id: OTHER,
          idempotency_key: "merchant-invitation/" + OTHER,
          delivery: {
            ...delivery,
            status: "sending",
            retry_at: "2026-10-19T10:01:00Z",
            can_retry: false,
          },
        };
      }
      if (name === "finish_merchant_invitation_email") {
        if (opts.finishFails) throw new Error("database unavailable");
        return {
          ...delivery,
          ...(args.p_input as Json),
          retry_at: "2026-10-19T10:01:00Z",
          can_retry: false,
        };
      }
      return {};
    },
  });
  return { handler, calls, sends };
}
Deno.test("HMAC token is stable, case-normalized and isolated by key/request", async () => {
  const raw = await deriveInvitationToken(CFG, "v1", ID);
  assertEquals(raw.length, 43);
  assertEquals(await deriveInvitationToken(CFG, "v1", ID.toUpperCase()), raw);
  assertEquals(await deriveInvitationToken(CFG, "v1", OTHER) === raw, false);
  await assertRejects(() => deriveInvitationToken(CFG, "missing", ID));
});
Deno.test("invitation template escapes public text, keeps fragment and explains correct login identity", () => {
  const e = renderInvitationEmail(
    fields,
    "https://partners.example.invalid/merchant/connect#invite=opaque",
  );
  assertStringIncludes(e.html, "Business &lt;script&gt;&amp;");
  assertStringIncludes(e.html, "#invite=opaque");
  assertStringIncludes(
    e.html,
    "Stripe account login can use a different email",
  );
  assertStringIncludes(e.text, fields.to);
  assertEquals(e.to, fields.to);
});
Deno.test("create sends stored recipient and returns accepted status without token metadata", async () => {
  const f = fixture();
  const r = await f.handler(
    req({
      action: "create_invitation",
      request_id: ID,
      binding_id: "test",
      business_name: "Business <script>&",
      email: fields.to,
    }),
  );
  assertEquals(r.status, 200);
  const j = await r.json();
  assertEquals(j.delivery.status, "sent");
  assertEquals(f.sends.length, 1);
  assertEquals((f.sends[0].envelope as Json).to, fields.to);
  assertStringIncludes(j.invitation_url, B.origin);
  assertEquals(j.token_sha256, undefined);
  assertEquals(j.token_request_id, undefined);
  assertEquals(
    f.calls.find((x) => x.name === "finish_merchant_invitation_email")?.auth,
    undefined,
  );
});
Deno.test("UUID input is normalized before idempotent create RPC", async () => {
  const f = fixture();
  const response = await f.handler(
    req({
      action: "create_invitation",
      request_id: ID.toUpperCase(),
      binding_id: "test",
      business_name: "Business <script>&",
      email: fields.to,
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(
    (f.calls.find((x) => x.name === "create_admin_merchant_invitation_v2")?.args
      .p_input as Json).request_id,
    ID,
  );
});
Deno.test("resend keeps invitation token, copy after reload never sends", async () => {
  const f = fixture();
  const first = await (await f.handler(
    req({
      action: "resend_invitation",
      invitation_id: ID,
      request_id: OTHER,
    }),
  )).json();
  const second = await (await f.handler(
    req({ action: "get_invitation_link", invitation_id: ID }),
  )).json();
  assertEquals(first.invitation_url, second.invitation_url);
  assertEquals(f.sends.length, 1);
  assertEquals(
    f.calls.some((x) => x.name === "create_admin_merchant_invitation_v2"),
    false,
  );
});
Deno.test("recipient origin and missing request IDs cannot start delivery", async () => {
  for (
    const body of [{
      action: "create_invitation",
      binding_id: "test",
      business_name: "Merchant",
      email: fields.to,
    }, { action: "resend_invitation", invitation_id: ID }]
  ) {
    const f = fixture();
    assertEquals((await f.handler(req(body))).status, 400);
    assertEquals(f.sends.length, 0);
  }
  const f = fixture();
  assertEquals(
    (await f.handler(
      req(
        { action: "resend_invitation", invitation_id: ID, request_id: OTHER },
        B.origin,
      ),
    )).status,
    403,
  );
  assertEquals(f.calls.length, 0);
});
Deno.test("recipient injection and non-admin cannot email or retrieve copy", async () => {
  const f = fixture();
  assertEquals(
    (await f.handler(
      req({
        action: "resend_invitation",
        invitation_id: ID,
        request_id: OTHER,
        email: "other@example.invalid",
      }),
    )).status,
    400,
  );
  const denied = fixture({ denied: true });
  for (const action of ["get_invitation_link", "resend_invitation"]) {
    assertEquals(
      (await denied.handler(
        req({
          action,
          invitation_id: ID,
          ...(action === "resend_invitation" ? { request_id: OTHER } : {}),
        }),
      )).status,
      403,
    );
  }
  assertEquals(denied.sends.length, 0);
});
Deno.test("expired, revoked and connected invitations cannot reconstruct or send", async () => {
  for (const status of ["expired", "revoked", "connected"]) {
    const f = fixture({ status });
    assertEquals(
      (await f.handler(
        req({
          action: "resend_invitation",
          invitation_id: ID,
          request_id: OTHER,
        }),
      )).status,
      409,
    );
    assertEquals(f.sends.length, 0);
  }
});
Deno.test("failed and uncertain provider results preserve copy link and honest status", async () => {
  for (
    const outcome of [{ status: "failed", error_code: "provider_http_422" }, {
      status: "unknown",
      error_code: "provider_response_unknown",
    }] as InvitationMailOutcome[]
  ) {
    const f = fixture({ outcome });
    const r = await f.handler(
      req({
        action: "resend_invitation",
        invitation_id: ID,
        request_id: OTHER,
      }),
    );
    assertEquals(r.status, 200);
    const j = await r.json();
    assertEquals(j.delivery.status, outcome.status);
    assertStringIncludes(j.invitation_url, "#invite=");
  }
});
Deno.test("provider acceptance followed by lost database finish remains unknown, not falsely failed", async () => {
  const f = fixture({ finishFails: true });
  const r = await f.handler(
    req({ action: "resend_invitation", invitation_id: ID, request_id: OTHER }),
  );
  const j = await r.json();
  assertEquals(j.delivery.status, "unknown");
  assertEquals(j.delivery.can_retry, false);
  assertEquals(f.sends.length, 1);
});
Deno.test("frozen envelope retry ignores changed sender and fails closed on template digest drift", async () => {
  const f = fixture({ frozen: true });
  assertEquals(
    (await f.handler(
      req({
        action: "resend_invitation",
        invitation_id: ID,
        request_id: OTHER,
      }),
    )).status,
    200,
  );
  assertEquals(
    (f.sends[0].envelope as Json).from,
    "Original <original@example.invalid>",
  );
  const bad = fixture({ frozen: true, digestMismatch: true });
  assertEquals(
    (await bad.handler(
      req({
        action: "resend_invitation",
        invitation_id: ID,
        request_id: OTHER,
      }),
    )).status,
    409,
  );
  assertEquals(bad.sends.length, 0);
});
Deno.test("cooldown and disabled email preserve copy without sending", async () => {
  for (const opts of [{ noSend: true }, { enabled: false }]) {
    const f = fixture(opts);
    const j = await (await f.handler(
      req({
        action: "resend_invitation",
        invitation_id: ID,
        request_id: OTHER,
      }),
    )).json();
    assertStringIncludes(j.invitation_url, "#invite=");
    assertEquals(f.sends.length, 0);
    assertEquals(j.delivery.can_retry, false);
  }
});
Deno.test("Resend uses one bounded exact-origin request and distinguishes receipts, timeout and conflict", async () => {
  const prior = Deno.env.get("RESEND_API_KEY");
  Deno.env.set("RESEND_API_KEY", "re_synthetic_only");
  try {
    const e = renderInvitationEmail(
      fields,
      "https://partners.example.invalid/merchant/connect#invite=opaque",
    );
    let count = 0;
    const success = await sendInvitationEmail(
      e,
      "merchant-invitation/test",
      async (url, init) => {
        count++;
        assertEquals(url, "https://api.resend.com/emails");
        assertEquals(init?.redirect, "error");
        assertEquals(
          new Headers(init?.headers).get("Idempotency-Key"),
          "merchant-invitation/test",
        );
        assertEquals(JSON.parse(String(init?.body)), e);
        return Response.json({ id: "email_123" });
      },
    );
    assertEquals(success, { status: "sent", provider_id: "email_123" });
    assertEquals(count, 1);
    assertEquals(
      (await sendInvitationEmail(e, "same", async () => {
        throw new Error("timeout secret");
      })).status,
      "unknown",
    );
    assertEquals(
      (await sendInvitationEmail(
        e,
        "same",
        async () =>
          Response.json({ name: "invalid_idempotent_request" }, {
            status: 409,
          }),
      ))
        .error_code,
      "provider_payload_conflict",
    );
    assertEquals(
      (await sendInvitationEmail(
        e,
        "same",
        async () =>
          Response.json({ name: "concurrent_idempotent_requests" }, {
            status: 409,
          }),
      )).error_code,
      "provider_concurrent_unknown",
    );
    assertEquals(
      await sendInvitationEmail(
        e,
        "same",
        async () => Response.json({ error: "re_secret" }, { status: 422 }),
      ),
      { status: "failed", error_code: "provider_http_422" },
    );
    assertEquals(
      (await sendInvitationEmail(e, "same", async () => Response.json({})))
        .status,
      "unknown",
    );
  } finally {
    if (prior === undefined) Deno.env.delete("RESEND_API_KEY");
    else Deno.env.set("RESEND_API_KEY", prior);
  }
});
