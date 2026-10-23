import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ConfigurationError,
  DatabaseBoundaryError,
  RequestError,
} from "./errors.ts";
import { requireLiveStripeKey } from "./stripe-auth.ts";
import { STRIPE_API_VERSION } from "./stripe-api.ts";
import type { StripeEventEnvelope } from "./stripe.ts";
import { isPlainObject } from "./validation.ts";

type Kind = "checkout" | "subscription" | "charge";
type ObjectValue = Record<string, unknown>;
export interface StripeOwnershipDependencies {
  owns: (
    kind: Kind,
    reference: string,
    metadata: ObjectValue,
  ) => Promise<boolean>;
  stripeSecret: () => string;
  fetcher: typeof fetch;
}

const ids = {
  checkout: /^cs_live_[A-Za-z0-9_]{8,160}$/,
  subscription: /^sub_[A-Za-z0-9_]{8,160}$/,
  charge: /^ch_[A-Za-z0-9_]{8,160}$/,
  invoice: /^in_[A-Za-z0-9_]{8,160}$/,
  intent: /^pi_[A-Za-z0-9_]{8,160}$/,
};

function retry(): never {
  // Never turn an inconclusive provider/DB lookup into a successful discard.
  throw new RequestError(
    503,
    "ownership_unavailable",
    "Event ownership could not be verified. Retry delivery.",
  );
}

function object(value: unknown): ObjectValue {
  return isPlainObject(value) ? value : {};
}

function reference(value: unknown, pattern: RegExp): string | null {
  const candidate = isPlainObject(value) ? value.id : value;
  return typeof candidate === "string" && pattern.test(candidate)
    ? candidate
    : null;
}

function subscriptionReference(invoice: ObjectValue): string | null {
  const nested =
    object(object(invoice.parent).subscription_details).subscription;
  const found = reference(invoice.subscription, ids.subscription) ??
    reference(nested, ids.subscription);
  if (!found && (invoice.subscription != null || nested != null)) {
    return retry();
  }
  return found;
}

export async function ownsStripeReference(
  client: SupabaseClient,
  kind: Kind,
  id: string,
  metadata: ObjectValue,
): Promise<boolean> {
  const { data, error } = await client.rpc("stripe_webhook_owns_reference", {
    p_kind: kind,
    p_reference: id,
    p_metadata: metadata,
  });
  if (error || typeof data !== "boolean") {
    throw new DatabaseBoundaryError(error?.code);
  }
  return data;
}

/** Called only AFTER raw signature, live mode, event type and API-version checks.
 * Unrelated bodies are never persisted. Lookups are bounded GETs, scoped to the
 * signed resource IDs; provider errors retry instead of silently dropping money.
 * Financial normalization remains responsible for canonical attribution/amounts.
 */
export async function isKissMyAppsStripeEvent(
  event: StripeEventEnvelope,
  deps: StripeOwnershipDependencies,
): Promise<boolean> {
  const row = object(object(event.payload.data).object);
  // A single budget for the whole lookup chain, not seven seconds per request.
  const signal = AbortSignal.timeout(7_000);
  const get = async (
    path: string,
    params?: URLSearchParams,
  ): Promise<ObjectValue> => {
    const url = new URL(`https://api.stripe.com/v1/${path}`);
    if (params) url.search = params.toString();
    const secret = requireLiveStripeKey(deps.stripeSecret());
    let response: Response;
    try {
      response = await deps.fetcher(url, {
        method: "GET",
        signal,
        headers: {
          Authorization: `Bearer ${secret}`,
          "Stripe-Version": STRIPE_API_VERSION,
        },
      });
    } catch {
      return retry();
    }
    if (response.status === 401 || response.status === 403) {
      throw new ConfigurationError();
    }
    if (!response.ok) return retry();
    try {
      const result: unknown = await response.json();
      if (!isPlainObject(result)) return retry();
      return result;
    } catch {
      return retry();
    }
  };
  const liveResource = async (
    kind: string,
    id: string,
  ): Promise<ObjectValue> => {
    const result = await get(`${kind}s/${encodeURIComponent(id)}`);
    if (
      result.id !== id || result.object !== kind || result.livemode !== true
    ) return retry();
    return result;
  };
  const ownsSubscription = async (
    id: string,
    metadata?: ObjectValue,
  ): Promise<boolean> => {
    if (await deps.owns("subscription", id, metadata ?? {})) return true;
    // Signed subscription snapshots already carry the relevant metadata. Other
    // event types retrieve it for out-of-order delivery, without retaining PII.
    if (metadata) return false;
    const subscription = await liveResource("subscription", id);
    const attempt = object(subscription.metadata).kma_attempt_id;
    return await deps.owns(
      "subscription",
      id,
      typeof attempt === "string" ? { kma_attempt_id: attempt } : {},
    );
  };

  if (event.type.startsWith("checkout.session.")) {
    const id = reference(row.id, ids.checkout);
    if (!id) return retry();
    return await deps.owns("checkout", id, object(row.metadata));
  }
  if (event.type.startsWith("customer.subscription.")) {
    const id = reference(row.id, ids.subscription);
    if (!id) return retry();
    return await ownsSubscription(id, object(row.metadata));
  }
  if (event.type === "invoice.paid") {
    const id = subscriptionReference(row);
    // Standalone (non-subscription) invoices are not part of our contract.
    if (!id) return false;
    return await ownsSubscription(id);
  }
  if (
    event.type.startsWith("refund.") || event.type.startsWith("charge.dispute.")
  ) {
    const chargeId = reference(row.charge, ids.charge);
    if (!chargeId) return retry();
    if (await deps.owns("charge", chargeId, {})) return true;
    // Refund/dispute may arrive before the invoice has been normalized. Resolve
    // charge -> invoice payment -> subscription, not a broad customer lookup.
    const charge = await liveResource("charge", chargeId);
    let invoiceId = reference(charge.invoice, ids.invoice);
    if (!invoiceId) {
      const intent = reference(charge.payment_intent, ids.intent);
      if (!intent) return false;
      const payments = await get(
        "invoice_payments",
        new URLSearchParams({
          "payment[type]": "payment_intent",
          "payment[payment_intent]": intent,
          status: "paid",
          limit: "2",
        }),
      );
      if (
        payments.object !== "list" || !Array.isArray(payments.data) ||
        payments.has_more !== false
      ) return retry();
      if (payments.data.length === 0) return false;
      if (payments.data.length !== 1) return retry();
      const payment = object(payments.data[0]);
      if (
        payment.livemode !== true || payment.status !== "paid" ||
        object(payment.payment).type !== "payment_intent" ||
        reference(object(payment.payment).payment_intent, ids.intent) !== intent
      ) return retry();
      invoiceId = reference(payment.invoice, ids.invoice);
      if (!invoiceId) return retry();
    }
    const invoice = await liveResource("invoice", invoiceId);
    const subscription = subscriptionReference(invoice);
    if (!subscription) return false;
    return await ownsSubscription(subscription);
  }
  return retry();
}
