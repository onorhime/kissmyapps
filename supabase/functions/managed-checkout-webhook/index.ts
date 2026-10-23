import { verifyStripeSignature } from "../_shared/stripe.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireJsonContentType,
  requireMethod,
} from "../_shared/http.ts";
import { type Json, object, reject } from "../managed-checkout/contract.ts";
import {
  type ManagedCheckoutDependencies,
  managedDefaults,
} from "../managed-checkout/index.ts";
import {
  ManagedCheckoutService,
  resolveManagedBinding,
} from "../managed-checkout/service.ts";
export function createManagedCheckoutWebhook(
  overrides: Partial<ManagedCheckoutDependencies> = {},
) {
  const deps = { ...managedDefaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      requireJsonContentType(request);
      if (request.headers.has("origin")) {
        reject(
          "browser_request_rejected",
          "Provider authentication is required.",
          403,
        );
      }
      const b = deps.bindings().get(
        new URL(request.url).searchParams.get("binding_id") ?? "",
      );
      if (!b) {
        reject(
          "binding_unavailable",
          "This payment integration is unavailable.",
          503,
        );
      }
      const bytes = await readRequestBytes(request, 512 * 1024);
      const event: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      // Use the untrusted envelope only to select its required signing secret.
      // No event data is acted on until that exact destination authenticates it.
      const connectedEnvelope = object(event) && event.account != null;
      const webhookSecret =
        b.chargeMode === "merchant_direct" && connectedEnvelope
          ? b.connectedWebhookSecret
          : b.webhookSecret;
      if (!webhookSecret) {
        reject("binding_unavailable", "Webhook scope is not configured.", 503);
      }
      await verifyStripeSignature(
        bytes,
        request.headers.get("stripe-signature"),
        webhookSecret,
        Math.floor(deps.now() / 1000),
      );
      if (
        !object(event) || event.livemode !== b.livemode ||
        (b.chargeMode !== "merchant_direct" && event.account != null) ||
        !/^evt_[A-Za-z0-9_]+$/.test(String(event.id)) || !object(event.data) ||
        !object(event.data.object)
      ) {
        reject(
          "provider_event_invalid",
          "Provider event scope is invalid.",
          409,
        );
      }
      const type = String(event.type), p = event.data.object;
      const feeEvent = [
        "application_fee.created",
        "application_fee.refunded",
        "application_fee.refund.updated",
      ].includes(type);
      let effective = b, feeCharge: unknown;
      if (b.chargeMode === "merchant_direct") {
        let account = event.account;
        if (feeEvent) {
          if (event.account != null) {
            reject(
              "provider_event_invalid",
              "Fee events must belong to the platform.",
              409,
            );
          }
          const platform = deps.provider(b);
          if (
            (await platform.request("account", undefined, undefined, true))
              .id !== b.platformAccountId
          ) {
            reject("provider_event_invalid", "Platform identity differs.", 409);
          }
          const feeId = type === "application_fee.refund.updated"
            ? p.fee
            : p.id;
          if (typeof feeId !== "string" || !/^fee_[A-Za-z0-9]+$/.test(feeId)) {
            reject();
          }
          const fee = await platform.request(
            `application_fees/${feeId}`,
            undefined,
            undefined,
            true,
          );
          if (fee.id !== feeId || fee.livemode !== b.livemode) reject();
          account = object(fee.account) ? fee.account.id : fee.account;
          feeCharge = object(fee.charge) ? fee.charge.id : fee.charge;
        }
        if (!feeEvent && account == null) {
          // Existing platform charges keep their original account even after
          // this integration switches new orders to merchant direct charges.
          // The order's frozen database scope must confirm this path below.
          effective = {
            ...b,
            accountId: b.platformAccountId!,
            chargeMode: undefined,
          };
        } else if (
          typeof account !== "string" || !/^acct_[A-Za-z0-9]+$/.test(account) ||
          account === b.platformAccountId
        ) {
          reject(
            "provider_event_invalid",
            "A connected merchant account is required.",
            409,
          );
        } else {
          effective = { ...b, accountId: account };
        }
      }
      const provider = deps.provider(effective);
      let entity: Json;
      await provider.verifyAccount();
      if (
        [
          "checkout.session.completed",
          "checkout.session.expired",
          "checkout.session.async_payment_succeeded",
          "checkout.session.async_payment_failed",
        ].includes(type)
      ) entity = await provider.request(`checkout/sessions/${String(p.id)}`);
      else if (feeEvent && b.chargeMode === "merchant_direct") {
        if (
          typeof feeCharge !== "string" || !/^ch_[A-Za-z0-9]+$/.test(feeCharge)
        ) reject();
        const charge = await provider.request(`charges/${feeCharge}`);
        const payment = object(charge.payment_intent)
          ? charge.payment_intent.id
          : charge.payment_intent;
        if (typeof payment !== "string" || !/^pi_[A-Za-z0-9]+$/.test(payment)) {
          reject();
        }
        entity = await provider.request(`payment_intents/${payment}`);
      } else if (
        [
          "refund.created",
          "refund.updated",
          "charge.refunded",
          "charge.dispute.created",
          "charge.dispute.updated",
          "charge.dispute.closed",
        ].includes(type)
      ) {
        let payment: unknown = p.payment_intent;
        if (type.startsWith("charge.dispute.")) {
          const dispute = await provider.request(`disputes/${String(p.id)}`);
          const charge = await provider.request(
            `charges/${
              String(
                object(dispute.charge) ? dispute.charge.id : dispute.charge,
              )
            }`,
          );
          payment = charge.payment_intent;
        } else if (type.startsWith("refund.")) {
          const refund = await provider.request(`refunds/${String(p.id)}`);
          payment = refund.payment_intent;
        } else {
          const charge = await provider.request(`charges/${String(p.id)}`);
          payment = charge.payment_intent;
        }
        entity = await provider.request(
          `payment_intents/${String(object(payment) ? payment.id : payment)}`,
        );
      } else return jsonResponse(200, { received: true, ignored: true });
      if (
        !object(entity.metadata) ||
        entity.metadata.purpose !== "kma_managed_payment"
      ) return jsonResponse(200, { received: true, ignored: true });
      if (b.chargeMode === "merchant_direct") {
        if (
          entity.metadata.kma_product_id !== b.productId ||
          entity.metadata.kma_funnel_id !== b.funnelId
        ) {
          return jsonResponse(200, { received: true, ignored: true });
        }
        const frozen = await resolveManagedBinding(deps.store, b, {
          action: "status",
          attempt_id: String(entity.metadata.kma_managed_attempt_id),
          order_id: String(entity.metadata.order_id),
        });
        if (
          frozen.accountId !== effective.accountId ||
          frozen.chargeMode !== effective.chargeMode
        ) {
          reject(
            "provider_event_invalid",
            "The event belongs to another merchant.",
            409,
          );
        }
      }
      const service = new ManagedCheckoutService(deps.store, provider, false),
        order = await service.order(
          String(entity.metadata.kma_managed_attempt_id),
          String(entity.metadata.order_id),
        );
      await service.reconcile(
        order,
        type.startsWith("checkout.session.") ? entity : undefined,
      );
      return jsonResponse(200, { received: true, request_id: rid });
    } catch (error) {
      return errorResponse(error, rid);
    }
  };
}
export const handleManagedCheckoutWebhook = createManagedCheckoutWebhook();
if (import.meta.main) Deno.serve(handleManagedCheckoutWebhook);
