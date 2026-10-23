import { requiredSecret } from "../_shared/env.ts";
import { RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireJsonContentType,
  requireMethod,
} from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import {
  isKissMyAppsStripeEvent,
  ownsStripeReference,
} from "../_shared/stripe-ownership.ts";
import type { StripeEventEnvelope } from "../_shared/stripe.ts";
import {
  parseStripeEvent,
  persistStripeEvent,
  stripeSignedBodySha256,
  verifyStripeSignature,
} from "../_shared/stripe.ts";

export interface StripeWebhookDependencies {
  webhookSecret: () => string;
  owns: (event: StripeEventEnvelope) => Promise<boolean>;
  persist: (
    event: StripeEventEnvelope,
    digest: string,
  ) => Promise<{ duplicate: boolean }>;
}

const defaults: StripeWebhookDependencies = {
  webhookSecret: () => requiredSecret("STRIPE_WEBHOOK_SECRET"),
  owns: (event) =>
    isKissMyAppsStripeEvent(event, {
      owns: (kind, reference, metadata) =>
        ownsStripeReference(serviceClient(), kind, reference, metadata),
      stripeSecret: () => requiredSecret("STRIPE_SECRET_KEY"),
      fetcher: fetch,
    }),
  persist: (event, digest) =>
    persistStripeEvent(serviceClient(), event, digest),
};

export async function handleStripeWebhook(
  request: Request,
  deps = defaults,
): Promise<Response> {
  const id = requestId(request);
  try {
    requireMethod(request, ["POST"]);
    requireJsonContentType(request);
    const webhookSecret = deps.webhookSecret();
    const bytes = await readRequestBytes(request, 1024 * 1024);
    await verifyStripeSignature(
      bytes,
      request.headers.get("stripe-signature"),
      webhookSecret,
    );
    const event = parseStripeEvent(bytes);
    const signedBodySha256 = await stripeSignedBodySha256(bytes);
    if (!event.livemode) {
      throw new RequestError(
        400,
        "non_production_event",
        "Only production Stripe events are accepted.",
      );
    }
    if (event.apiVersion === null) {
      console.warn(JSON.stringify({
        level: "warning",
        worker: "stripe-webhook",
        outcome: "api_version_unavailable",
        request_id: id,
      }));
    }
    if (!await deps.owns(event)) {
      return jsonResponse(200, {
        received: true,
        ignored: true,
        request_id: id,
      }, { "X-Request-ID": id });
    }
    const persisted = await deps.persist(event, signedBodySha256);
    return jsonResponse(
      200,
      { received: true, duplicate: persisted.duplicate, request_id: id },
      { "X-Request-ID": id },
    );
  } catch (error) {
    return errorResponse(error, id, { "X-Request-ID": id });
  }
}

if (import.meta.main) Deno.serve((request) => handleStripeWebhook(request));
