/** Real Stripe TEST transport; application handlers and data remain local. */
import { createManagedCheckoutHandler } from "../supabase/functions/managed-checkout/index.ts";
import { createManagedCheckoutWorker } from "../supabase/functions/managed-checkout-worker/index.ts";
import { createManagedCheckoutWebhook } from "../supabase/functions/managed-checkout-webhook/index.ts";
import { createManagedPriceVerifier } from "../supabase/functions/managed-price-verifier/index.ts";
import { ManagedProvider } from "../supabase/functions/managed-checkout/provider.ts";
import { fixtureBinding } from "../supabase/functions/managed-checkout/test-support.ts";
import { RequestError } from "../supabase/functions/_shared/errors.ts";
import {
  localOrigin,
  realStripeTestTransport,
  realTestOptions,
} from "./managed-checkout-real-test-guards.mjs";
const env = Object.fromEntries(
  [
    "KMA_REAL_TEST_ENABLED",
    "KMA_REAL_TEST_STRIPE_SECRET_KEY",
    "KMA_REAL_TEST_STRIPE_ACCOUNT_ID",
    "KMA_REAL_TEST_STRIPE_PRICE_ID",
    "KMA_REAL_TEST_WEBHOOK_SECRET",
  ].map((k) => [k, Deno.env.get(k)]),
);
const options = realTestOptions(env),
  origin = localOrigin(Deno.env.get("CROSSAPP_CONTROL_ORIGIN") ?? "");
const control = Deno.env.get("CROSSAPP_CONTROL_SECRET") ?? "",
  inbound = Deno.env.get("CROSSAPP_INBOUND_SECRET") ?? "",
  outbound = Deno.env.get("CROSSAPP_OUTBOUND_SECRET") ?? "";
if ([control, inbound, outbound].some((v) => v.length < 32)) {
  throw Error("Local authentication secrets required.");
}
const binding = {
  ...fixtureBinding,
  id: "real-stripe-test",
  secret: inbound,
  accountId: options.accountId,
  livemode: false,
  stripeKey: options.key,
  webhookSecret: options.webhookSecret || "whsec_disabled",
  callbackSecret: outbound,
  callbackUrl: origin + "/kma-events",
  redirectOrigins: [origin],
};
let webhookReady = Boolean(options.webhookSecret),
  webhookProcessed = 0,
  webhookRejected = 0;
const provider = new ManagedProvider(
  binding,
  realStripeTestTransport(options.key),
);
const store = {
  async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const response = await fetch(origin + "/rpc/kma", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-control": control,
      },
      body: JSON.stringify({ name, args }),
    });
    const result = await response.json();
    if (result.error) {
      throw new RequestError(
        result.error.code === "P0002" ? 404 : 409,
        "local_database_rejected",
        "The local database could not accept this request.",
      );
    }
    return result.data as T;
  },
};
async function adminRpc(name: string, args: Record<string, unknown>) {
  const response = await fetch(origin + "/rpc/kma-admin", {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-control": control },
    body: JSON.stringify({ name, args }),
  });
  const result = await response.json();
  if (result.error) {
    throw new RequestError(
      409,
      "local_admin_rejected",
      "Local fixture admin RPC failed.",
    );
  }
  return result.data;
}
const verifier = createManagedPriceVerifier({
  bindings: () => new Map([[binding.id, binding]]),
  origins: () => new Set([origin]),
  store,
  provider: () => provider,
  candidate: async (auth, id) => {
    if (auth !== `Bearer ${control}`) {
      throw new RequestError(403, "forbidden", "Local fixture admin required.");
    }
    return adminRpc("get_admin_managed_price_verification_candidate", {
      p_billing_offer_id: id,
    });
  },
});
const deps = {
  bindings: () => new Map([[binding.id, binding]]),
  enabled: () => true,
  store,
  provider: () => provider,
  now: Date.now,
};
const checkout = createManagedCheckoutHandler(deps),
  webhook = createManagedCheckoutWebhook(deps),
  worker = createManagedCheckoutWorker({
    ...deps,
    workerEnabled: () => true,
    authenticate: (request) => {
      if (request.headers.get("x-local-control") !== control) {
        throw new RequestError(
          401,
          "unauthorized",
          "Local authorization required.",
        );
      }
    },
    fetcher: (url, init) => {
      if (String(url) !== binding.callbackUrl) {
        throw Error("Only local callbacks are allowed.");
      }
      return fetch(url, init);
    },
  });
Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => console.log(JSON.stringify({ port })),
}, async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/functions/v1/managed-checkout") {
    return checkout(request);
  }
  if (url.pathname === "/functions/v1/managed-checkout-webhook") {
    if (!webhookReady) {
      return Response.json({
        error: "Local webhook forwarding is not configured.",
      }, { status: 503 });
    }
    const response = await webhook(request),
      result = await response.clone().json();
    if (response.ok && !result.ignored) webhookProcessed++;
    else if (!response.ok) webhookRejected++;
    return response;
  }
  if (request.headers.get("x-local-control") !== control) {
    return Response.json({ error: "Local authorization required." }, {
      status: 401,
    });
  }
  if (url.pathname === "/__local/webhook-secret") {
    const input = await request.json();
    if (!/^whsec_[A-Za-z0-9]+$/.test(String(input.secret))) {
      return Response.json({ ok: false }, { status: 400 });
    }
    binding.webhookSecret = input.secret;
    webhookReady = true;
    return Response.json({ ok: true });
  }
  if (url.pathname === "/__local/state") {
    return Response.json({ webhookReady, webhookProcessed, webhookRejected });
  }
  if (url.pathname === "/__local/preflight") {
    try {
      await provider.verifyAccount();
      const endpoints = await provider.pages("webhook_endpoints?limit=100");
      const relevant = [
        "checkout.session.completed",
        "checkout.session.expired",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "refund.created",
        "refund.updated",
        "charge.refunded",
        "charge.dispute.created",
        "charge.dispute.updated",
        "charge.dispute.closed",
      ];
      const conflicts = endpoints.filter((endpoint) =>
        endpoint.status === "enabled" &&
        Array.isArray(endpoint.enabled_events) &&
        endpoint.enabled_events.some((event) =>
          event === "*" || relevant.includes(String(event))
        )
      ).map((endpoint) => ({
        id: String(endpoint.id),
        host: new URL(String(endpoint.url)).hostname,
      }));
      if (conflicts.length) {
        return Response.json({
          verified: false,
          code: "existing_test_webhooks",
          endpoints: conflicts,
        }, { status: 409 });
      }
      const input = await request.json(),
        offerId = String(input.billing_offer_id);
      const verification = await verifier(
        new Request(origin + "/managed-price-verifier", {
          method: "POST",
          headers: {
            origin,
            authorization: `Bearer ${control}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            billing_offer_id: offerId,
            binding_id: binding.id,
            stripe_price_id: options.priceId,
          }),
        }),
      );
      if (!verification.ok) {
        return Response.json({
          verified: false,
          code: "managed_price_verification_failed",
        }, { status: 409 });
      }
      await adminRpc("set_admin_billing_offer_status", {
        p_input: { billing_offer_id: offerId, status: "active" },
      });
      return Response.json({
        verified: true,
        accountId: binding.accountId,
        livemode: false,
        priceId: options.priceId,
      });
    } catch {
      return Response.json({
        verified: false,
        error: "Stripe test account or Price verification failed.",
      }, { status: 409 });
    }
  }
  if (url.pathname === "/__local/worker") return worker(request);
  return Response.json({ error: "Unknown local route." }, { status: 404 });
});
