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
  parseStripeEvent,
  persistStripeEvent,
  stripeSignedBodySha256,
  verifyStripeSignature,
} from "../_shared/stripe.ts";

export async function handleStripeWebhook(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    requireMethod(request, ["POST"]);
    requireJsonContentType(request);
    const webhookSecret = requiredSecret("STRIPE_WEBHOOK_SECRET");
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
    const persisted = await persistStripeEvent(
      serviceClient(),
      event,
      signedBodySha256,
    );
    return jsonResponse(
      200,
      { received: true, duplicate: persisted.duplicate, request_id: id },
      { "X-Request-ID": id },
    );
  } catch (error) {
    return errorResponse(error, id, { "X-Request-ID": id });
  }
}

if (import.meta.main) Deno.serve(handleStripeWebhook);
