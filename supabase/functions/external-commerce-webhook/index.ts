import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
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
  stripeSignedBodySha256,
  verifyStripeSignature,
} from "../_shared/stripe.ts";
import {
  type CommerceBinding,
  commerceBindings,
  UUID,
} from "../external-commerce/contract.ts";
import { MerchantProvider } from "../external-commerce/provider.ts";
import {
  identifier,
  type JsonObject,
  object,
} from "../creator-connect/provider.ts";

export interface MerchantWebhookDependencies {
  enabled: () => boolean;
  bindings: () => ReadonlyMap<string, CommerceBinding>;
  provider: (binding: CommerceBinding) => MerchantProvider;
  persist: (input: JsonObject) => Promise<{ duplicate: boolean }>;
  now: () => number;
}
const supported = new Set([
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
]);
const objectId = (value: unknown) =>
  typeof value === "string" ? value : object(value).id;
const amount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const timestamp = (value: unknown, now: number): string => {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 ||
    value * 1000 > now + 300000
  ) {
    throw new RequestError(
      409,
      "provider_time_invalid",
      "Provider evidence time is invalid.",
    );
  }
  return new Date(value * 1000).toISOString();
};
function mismatch(): never {
  throw new RequestError(
    409,
    "merchant_evidence_mismatch",
    "Provider evidence does not match the receiving merchant and order.",
  );
}
export function createExternalCommerceWebhook(
  overrides: Partial<MerchantWebhookDependencies> = {},
) {
  const deps: MerchantWebhookDependencies = {
    enabled: () => Deno.env.get("EXTERNAL_COMMERCE_WEBHOOK_ENABLED") === "true",
    bindings: commerceBindings,
    provider: (binding) => new MerchantProvider(binding),
    now: Date.now,
    persist: async (input) => {
      const { data, error } = await serviceClient().rpc(
        "ingest_external_merchant_adjustment",
        { p_input: input },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return data;
    },
    ...overrides,
  };
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      requireJsonContentType(request);
      if (request.headers.has("origin")) {
        throw new RequestError(
          403,
          "browser_request_rejected",
          "Provider authentication is required.",
        );
      }
      if (!deps.enabled()) {
        throw new RequestError(
          503,
          "merchant_webhook_unavailable",
          "The receiving merchant webhook is not enabled.",
        );
      }
      const binding = deps.bindings().get(
        new URL(request.url).searchParams.get("binding_id") ?? "",
      );
      if (!binding?.webhookSecret) {
        throw new RequestError(
          503,
          "merchant_webhook_unavailable",
          "The receiving merchant webhook is not configured.",
        );
      }
      const bytes = await readRequestBytes(request, 512 * 1024);
      await verifyStripeSignature(
        bytes,
        request.headers.get("stripe-signature"),
        binding.webhookSecret,
        Math.floor(deps.now() / 1000),
      );
      let event: JsonObject;
      try {
        event = object(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      } catch {
        throw new RequestError(400, "invalid_event", "Invalid provider event.");
      }
      identifier(event.id, "evt_");
      if (event.livemode !== binding.livemode || event.account != null) {
        mismatch();
      }
      const type = String(event.type);
      if (!supported.has(type)) {
        return jsonResponse(200, { received: true, ignored: true });
      }
      const payload = object(object(event.data).object),
        provider = deps.provider(binding);
      await provider.verify();
      let dispute: JsonObject | null = null;
      let chargeId: unknown = payload.id;
      if (type.startsWith("charge.dispute.")) {
        dispute = await provider.dispute(identifier(payload.id, "dp_"));
        if (
          dispute.id !== payload.id || dispute.livemode !== binding.livemode
        ) mismatch();
        chargeId = objectId(dispute.charge);
      } else if (type.startsWith("refund.")) {
        const refund = await provider.read(
          `refunds/${identifier(payload.id, "re_")}`,
        );
        if (refund.id !== payload.id) mismatch();
        if (refund.status !== "succeeded") {
          return jsonResponse(200, { received: true, pending: true });
        }
        chargeId = objectId(refund.charge);
      }
      const charge = await provider.charge(identifier(chargeId, "ch_"));
      const paymentId = identifier(objectId(charge.payment_intent), "pi_");
      const payment = await provider.payment(paymentId);
      const metadata = object(payment.metadata ?? {});
      // Ignore unrelated merchant purchases; do not create attribution or guess
      // ownership for charges belonging to another product on the same account.
      if (
        metadata.purpose !== (binding.metadataPurpose ?? "speaksix_marathon")
      ) return jsonResponse(200, { received: true, ignored: true });
      if (
        !UUID.test(String(metadata.order_id)) ||
        metadata.stripe_account_id !== binding.accountId ||
        payment.id !== paymentId || payment.livemode !== binding.livemode ||
        payment.status !== "succeeded" ||
        charge.id !== chargeId || charge.livemode !== binding.livemode ||
        charge.paid !== true || !amount(charge.amount) ||
        payment.amount_received !== charge.amount ||
        payment.amount !== charge.amount ||
        String(payment.currency).toUpperCase() !==
          String(charge.currency).toUpperCase() ||
        !/^[a-z]{3}$/i.test(String(charge.currency)) ||
        payment.transfer_data != null || payment.on_behalf_of != null ||
        payment.application_fee_amount != null
      ) mismatch();
      const now = deps.now();
      const base = {
        provider_event_id: event.id,
        stripe_account_id: binding.accountId,
        livemode: binding.livemode,
        product_id: binding.productId,
        funnel_id: binding.funnelId,
        payment_intent_id: paymentId,
        external_order_id: metadata.order_id,
        order_amount_minor: charge.amount,
        currency: String(charge.currency).toUpperCase(),
        observed_at: new Date(now).toISOString(),
        payload_sha256: await stripeSignedBodySha256(bytes),
      };
      const observations: JsonObject[] = [];
      if (dispute) {
        if (
          objectId(dispute.charge) !== chargeId || !amount(dispute.amount) ||
          Number(dispute.amount) > Number(charge.amount) ||
          String(dispute.currency).toUpperCase() !== base.currency
        ) mismatch();
        const status = String(dispute.status);
        const kind = status === "won" || status === "warning_closed"
          ? "dispute_won"
          : status === "lost"
          ? "dispute_lost"
          : [
              "needs_response",
              "under_review",
              "warning_needs_response",
              "warning_under_review",
            ].includes(status)
          ? "dispute_open"
          : null;
        if (!kind) {
          throw new RequestError(
            503,
            "dispute_status_unavailable",
            "The dispute status requires reconciliation.",
          );
        }
        observations.push({
          ...base,
          kind,
          amount_minor: dispute.amount,
          dispute_id: dispute.id,
          occurred_at: timestamp(dispute.created, now),
        });
      } else {
        const refunds = await provider.refunds(String(charge.id));
        let successfulAmount = 0;
        const seen = new Set<string>();
        for (const refund of refunds) {
          identifier(refund.id, "re_");
          if (seen.has(String(refund.id))) mismatch();
          seen.add(String(refund.id));
          if (refund.status !== "succeeded") continue;
          if (
            objectId(refund.charge) !== charge.id ||
            objectId(refund.payment_intent) !== paymentId ||
            !amount(refund.amount) ||
            String(refund.currency).toUpperCase() !== base.currency ||
            (refund.livemode !== undefined &&
              refund.livemode !== binding.livemode)
          ) mismatch();
          successfulAmount += Number(refund.amount);
          observations.push({
            ...base,
            kind: "refund",
            amount_minor: refund.amount,
            refund_id: refund.id,
            occurred_at: timestamp(refund.created, now),
          });
        }
        if (
          !Number.isSafeInteger(successfulAmount) ||
          successfulAmount > Number(charge.amount) ||
          successfulAmount !== charge.amount_refunded
        ) {
          throw new RequestError(
            503,
            "refund_evidence_incomplete",
            "Complete successful refund evidence is not available yet.",
          );
        }
      }
      let duplicates = 0;
      for (const observation of observations) {
        if ((await deps.persist(observation)).duplicate) duplicates++;
      }
      return jsonResponse(200, {
        received: true,
        observations: observations.length,
        duplicate: observations.length > 0 &&
          duplicates === observations.length,
      });
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}
export const handleExternalCommerceWebhook = createExternalCommerceWebhook();
if (import.meta.main) Deno.serve(handleExternalCommerceWebhook);
