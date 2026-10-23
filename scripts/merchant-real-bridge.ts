/** Disposable local adapter. Real handlers/provider; synthetic local identity only. */
import { createMerchantConnectHandler } from "../supabase/functions/merchant-connect/index.ts";
import { MerchantProvider } from "../supabase/functions/merchant-connect/provider.ts";
import { createManagedCheckoutHandler } from "../supabase/functions/managed-checkout/index.ts";
import { createManagedCheckoutWorker } from "../supabase/functions/managed-checkout-worker/index.ts";
import { createManagedCheckoutWebhook } from "../supabase/functions/managed-checkout-webhook/index.ts";
import { createManagedPriceVerifier } from "../supabase/functions/managed-price-verifier/index.ts";
import type { ManagedBinding } from "../supabase/functions/managed-checkout/contract.ts";
import { ManagedProvider } from "../supabase/functions/managed-checkout/provider.ts";
import { resolveManagedBinding } from "../supabase/functions/managed-checkout/service.ts";
import { fixtureBinding } from "../supabase/functions/managed-checkout/test-support.ts";
import { RequestError } from "../supabase/functions/_shared/errors.ts";
import {
  merchantRealOptions,
  merchantRealTransport,
} from "./merchant-real-policy.mjs";
import { manualMerchantInventory } from "./merchant-real-inventory.mjs";

const raw = await new Response(Deno.stdin.readable).text();
if (raw.length > 16000) throw Error("Invalid local configuration.");
const c = JSON.parse(raw), options = merchantRealOptions(c);
for (const token of [c.control, c.admin, c.merchant, c.inbound, c.outbound]) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Local secrets required.");
}
let permittedMerchant: string | null = null;
let merchantInventoryEvidence: Record<string, unknown> | null = null;
const providerEvidence = new Map<string, Record<string, unknown>>();
const webhookEvidence: Record<string, unknown>[] = [];
const counts = {
  providerReads: 0,
  oauthExchanges: 0,
  checkoutWrites: 0,
  refundWrites: 0,
  feeRefundWrites: 0,
  webhookAccepted: 0,
  webhookRejected: 0,
  webhookIgnored: 0,
  connectedWebhookAccepted: 0,
  platformWebhookAccepted: 0,
};
const transport = merchantRealTransport(
  options,
  () => permittedMerchant,
  async (u: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(u)).pathname, method = init?.method ?? "GET";
    if (method === "GET") counts.providerReads++;
    else if (path === "/oauth/token") counts.oauthExchanges++;
    else if (path.includes("application_fees")) counts.feeRefundWrites++;
    else if (path === "/v1/refunds") counts.refundWrites++;
    else counts.checkoutWrites++;
    const response = await fetch(u, init);
    // Keep only accounting fields; never copy OAuth tokens or customer payloads.
    if (
      response.ok && method === "GET" &&
      (/^\/v1\/application_fees\/fee_[A-Za-z0-9]+$/.test(path) ||
        /^\/v1\/balance_transactions\/txn_[A-Za-z0-9]+$/.test(path))
    ) {
      const row = await response.clone().json();
      const safe: Record<string, unknown> = {};
      for (
        const key of [
          "id",
          "object",
          "account",
          "charge",
          "amount",
          "amount_refunded",
          "currency",
          "balance_transaction",
          "type",
          "source",
          "exchange_rate",
          "net",
          "fee",
          "livemode",
        ]
      ) {
        if (
          row[key] === null ||
          ["string", "number", "boolean"].includes(typeof row[key])
        ) safe[key] = row[key];
      }
      providerEvidence.set(String(row.id), safe);
    }
    return response;
  },
);
async function rpc(name: string, args: Record<string, unknown>, admin = false) {
  const r = await fetch(options.origin + "/__local/rpc", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-local-control": c.control,
    },
    body: JSON.stringify({ name, args, admin }),
    redirect: "error",
  });
  const data = await r.json();
  if (data.error) {
    throw new RequestError(
      409,
      "local_database_rejected",
      "The disposable database rejected this operation.",
    );
  }
  return data.data;
}
const merchantBinding = {
  id: "merchant-real-test",
  platformAccountId: options.platformAccountId,
  livemode: false,
  clientId: options.clientId,
  secret: options.key,
  origin: options.origin,
  callbackUrl: options.origin + "/merchant/callback",
  providerEnabled: true,
};
const merchant = createMerchantConnectHandler({
  bindings: () => new Map([[merchantBinding.id, merchantBinding]]),
  origins: () => new Set([options.origin]),
  authenticate: (auth) => {
    if (auth === `Bearer ${c.admin}`) {
      return Promise.resolve({
        userId: "ac570000-0000-4000-8000-000000000011",
      });
    }
    if (auth === `Bearer ${c.merchant}`) {
      return Promise.resolve({
        userId: "ac570000-0000-4000-8000-000000000080",
      });
    }
    throw new RequestError(
      401,
      "unauthorized",
      "Local fixture identity required.",
    );
  },
  rpc: (name, args, auth) => {
    if (auth && auth !== `Bearer ${c.admin}`) {
      throw new RequestError(
        403,
        "forbidden",
        "Only the local admin fixture can use admin RPCs.",
      );
    }
    return rpc(name, args, Boolean(auth));
  },
  provider: (b) => new MerchantProvider(b, transport),
  // This rehearsal exercises Stripe only; invitations must never send email.
  mailConfig: () => ({
    enabled: false,
    from: "KissMyApps <mail@example.invalid>",
    activeKeyId: "local-fixture",
    tokenKeys: { "local-fixture": c.control },
  }),
  mailSend: () => {
    throw Error("Email is disabled in the Stripe rehearsal.");
  },
});
const binding = {
  ...fixtureBinding,
  id: "merchant-real-test",
  secret: c.inbound,
  accountId: options.platformAccountId,
  platformAccountId: options.platformAccountId,
  chargeMode: "merchant_direct" as const,
  livemode: false,
  stripeKey: options.key,
  webhookSecret: "whsec_disabledPlatform",
  connectedWebhookSecret: "whsec_disabledConnect",
  callbackSecret: c.outbound,
  callbackUrl: options.origin + "/kma-events",
  redirectOrigins: [options.origin],
};
const store = { rpc },
  deps = {
    bindings: () => new Map([[binding.id, binding]]),
    enabled: () => true,
    store,
    provider: (b: ManagedBinding) => new ManagedProvider(b, transport),
    now: Date.now,
  };
const checkout = createManagedCheckoutHandler(deps),
  webhook = createManagedCheckoutWebhook(deps);
const worker = createManagedCheckoutWorker({
  ...deps,
  workerEnabled: () => true,
  authenticate: (r) => {
    if (r.headers.get("x-local-control") !== c.control) {
      throw new RequestError(403, "forbidden", "Local control required.");
    }
  },
  fetcher: (url, init) => {
    if (String(url) !== binding.callbackUrl) {
      throw Error("Only local callback allowed.");
    }
    return fetch(url, init);
  },
});
const verifier = createManagedPriceVerifier({
  bindings: deps.bindings,
  origins: () => new Set([options.origin]),
  store,
  provider: deps.provider,
  candidate: (auth, id) => {
    if (auth !== `Bearer ${c.admin}`) throw Error("Local admin required.");
    return rpc("get_admin_managed_price_verification_candidate", {
      p_billing_offer_id: id,
    }, true);
  },
});
let webhooksReady = false;
async function conflicts(account?: string) {
  const h: Record<string, string> = {
    Authorization: `Bearer ${options.key}`,
    "Stripe-Version": "2026-02-25.clover",
  };
  if (account) h["Stripe-Account"] = account;
  const r = await transport(
    "https://api.stripe.com/v1/webhook_endpoints?limit=100",
    { headers: h, redirect: "error" },
  );
  if (!r.ok) {
    const failure = await r.json().catch(() => ({}));
    // OAuth cannot list a merchant's endpoints. Only this exact API restriction
    // may use fresh, account-bound, explicitly manual operator evidence.
    if (
      account && r.status === 403 &&
      failure.error?.code === "oauth_not_supported"
    ) {
      merchantInventoryEvidence = manualMerchantInventory(
        c.merchantWebhookInventory,
        account,
        r.status,
        failure.error.code,
      );
      return [];
    }
    throw Error("Could not verify TEST webhook isolation.");
  }
  const data = await r.json();
  if (data.has_more) throw Error("Webhook isolation requires full inventory.");
  return (data.data ?? []).filter((e: Record<string, unknown>) =>
    e.status === "enabled"
  ).map((e: Record<string, unknown>) => ({
    id: e.id,
    host: new URL(String(e.url)).hostname,
    account: account ?? options.platformAccountId,
    events: e.enabled_events,
  }));
}
Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => console.log(JSON.stringify({ port })),
}, async (request) => {
  const u = new URL(request.url);
  if (u.pathname === "/functions/v1/managed-checkout-webhook") {
    if (!webhooksReady) {
      return Response.json({ error: "TEST webhook secrets not configured." }, {
        status: 503,
      });
    }
    const eventCopy = request.clone();
    const r = await webhook(request);
    const result = await r.clone().json();
    if (r.ok) {
      const event = await eventCopy.json();
      if (result.ignored) counts.webhookIgnored++;
      else {
        counts.webhookAccepted++;
        event.account
          ? counts.connectedWebhookAccepted++
          : counts.platformWebhookAccepted++;
      }
      webhookEvidence.push({
        id: event.id,
        type: event.type,
        account: event.account ?? null,
        received: result.received === true,
        ignored: result.ignored === true,
      });
      if (webhookEvidence.length > 100) webhookEvidence.shift();
    } else counts.webhookRejected++;
    return r;
  }
  if (request.headers.get("x-local-control") !== c.control) {
    return Response.json({ error: "Local control required." }, { status: 403 });
  }
  try {
    if (u.pathname === "/merchant") return merchant(request);
    if (u.pathname === "/functions/v1/managed-checkout") {
      return checkout(request);
    }
    if (u.pathname === "/worker") return worker(request);
    if (u.pathname === "/state") {
      return Response.json({
        permittedMerchant,
        webhooksReady,
        merchantInventoryEvidence,
        ...counts,
        accountingEvidence: [...providerEvidence.values()],
        webhookEvidence,
      });
    }
    if (u.pathname === "/preflight") {
      await new MerchantProvider(merchantBinding, transport).verifyPlatform();
      const r = await transport("https://api.stripe.com/v1/balance", {
        headers: { authorization: `Bearer ${options.key}` },
        redirect: "error",
      });
      if (!r.ok || (await r.json()).livemode !== false) {
        throw Error("TEST identity required.");
      }
      return Response.json({
        testVerified: true,
        conflicts: await conflicts(),
      });
    }
    if (u.pathname === "/prepare-price") {
      const input = await request.json();
      const effective = await resolveManagedBinding(store, binding, {
        action: "quote",
      });
      const p = new ManagedProvider(effective, transport);
      await p.verifyAccount(true);
      const listeners = [
        ...await conflicts(),
        ...await conflicts(effective.accountId),
      ];
      if (listeners.length) {
        return Response.json({
          error: "existing_test_webhooks",
          conflicts: listeners,
        }, { status: 409 });
      }
      const check = await verifier(
        new Request(options.origin + "/managed-price-verifier", {
          method: "POST",
          headers: {
            origin: options.origin,
            authorization: `Bearer ${c.admin}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            billing_offer_id: input.offerId,
            stripe_price_id: input.priceId,
            binding_id: binding.id,
          }),
        }),
      );
      if (!check.ok) return check;
      await rpc("set_admin_billing_offer_status", {
        p_input: { billing_offer_id: input.offerId, status: "active" },
      }, true);
      permittedMerchant = effective.accountId;
      return Response.json({
        ready: true,
        merchantAccountId: permittedMerchant,
        livemode: false,
      });
    }
    if (u.pathname === "/webhook-secrets") {
      const input = await request.json();
      if (
        ![input.platform, input.connected].every((v) =>
          /^whsec_[A-Za-z0-9]+$/.test(v ?? "")
        ) || input.platform === input.connected
      ) throw Error("Distinct TEST webhook secrets required.");
      binding.webhookSecret = input.platform;
      binding.connectedWebhookSecret = input.connected;
      webhooksReady = true;
      return Response.json({ configured: true });
    }
    return Response.json({ error: "Unknown local route." }, { status: 404 });
  } catch (error) {
    return Response.json({
      error: error instanceof RequestError ? error.code : "local_step_failed",
      message:
        "This local TEST operation could not be verified. No success was assumed.",
    }, { status: 409 });
  }
});
