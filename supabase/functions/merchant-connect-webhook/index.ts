import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireJsonContentType,
  requireMethod,
} from "../_shared/http.ts";
import { STRIPE_API_VERSION } from "../_shared/stripe-api.ts";
import {
  stripeSignedBodySha256,
  verifyStripeSignature,
} from "../_shared/stripe.ts";
import { serviceClient } from "../_shared/supabase.ts";
import {
  type Json,
  type MerchantBinding,
  merchantBindings,
  MerchantProvider,
  object,
} from "../merchant-connect/provider.ts";
export interface MerchantWebhookDependencies {
  bindings: () => Map<string, MerchantBinding>;
  persist: (input: Json) => Promise<Json>;
  connectionExists: (input: Json) => Promise<boolean>;
  provider: (binding: MerchantBinding) => MerchantProvider;
  now: () => number;
}
export function createMerchantConnectWebhook(
  overrides: Partial<MerchantWebhookDependencies> = {},
) {
  const deps: MerchantWebhookDependencies = {
    bindings: merchantBindings,
    now: Date.now,
    provider: (b) => new MerchantProvider(b),
    connectionExists: async (input) => {
      const { data, error } = await serviceClient().rpc(
        "merchant_connection_event_context",
        { p_input: input },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return object(data).matched === true;
    },
    persist: async (input) => {
      const { data, error } = await serviceClient().rpc(
        "apply_merchant_connection_event",
        { p_input: input },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return object(data);
    },
    ...overrides,
  };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
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
      const b = deps.bindings().get(
        new URL(request.url).searchParams.get("binding_id") ?? "",
      );
      if (!b?.providerEnabled || !b.webhookSecret?.startsWith("whsec_")) {
        throw new RequestError(
          503,
          "merchant_webhook_disabled",
          "This provider endpoint is not enabled.",
        );
      }
      const raw = await readRequestBytes(request, 256 * 1024);
      await verifyStripeSignature(
        raw,
        request.headers.get("stripe-signature"),
        b.webhookSecret,
        Math.floor(deps.now() / 1000),
      );
      let event: Json;
      try {
        event = object(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
        );
      } catch {
        throw new RequestError(400, "invalid_event", "Invalid provider event.");
      }
      if (
        event.livemode !== b.livemode ||
        event.api_version !== STRIPE_API_VERSION
      ) {
        throw new RequestError(
          400,
          "event_scope_mismatch",
          "Provider event mode or version does not match this endpoint.",
        );
      }
      if (
        !["account.updated", "account.application.deauthorized"].includes(
          String(event.type),
        )
      ) return jsonResponse(200, { received: true, ignored: true });
      if (
        !/^evt_[A-Za-z0-9_]{3,128}$/.test(String(event.id)) ||
        !/^acct_[A-Za-z0-9]{3,128}$/.test(String(event.account)) ||
        event.account === b.platformAccountId ||
        !Number.isSafeInteger(event.created) || Number(event.created) <= 0 ||
        Number(event.created) > Math.floor(deps.now() / 1000) + 60
      ) throw new RequestError(400, "invalid_event", "Invalid provider event.");
      const data = object(object(event.data).object);
      if (
        (event.type === "account.updated" && data.id !== event.account) ||
        (event.type === "account.application.deauthorized" &&
          data.id !== b.clientId)
      ) {
        throw new RequestError(
          400,
          "event_scope_mismatch",
          "Provider event account or application does not match this connection.",
        );
      }
      const input: Json = {
        platform_account_id: b.platformAccountId,
        livemode: b.livemode,
        account_id: event.account,
        event_id: event.id,
        event_type: event.type,
        event_created: event.created,
        payload_sha256: await stripeSignedBodySha256(raw),
      };
      if (
        !await deps.connectionExists({
          platform_account_id: b.platformAccountId,
          livemode: b.livemode,
          account_id: event.account,
        })
      ) {
        return jsonResponse(200, { received: true, ignored: true });
      }
      if (event.type === "account.updated") {
        const provider = deps.provider(b);
        await provider.verifyPlatform();
        // Refetch current account capability flags; an old event cannot restore old flags.
        const snapshot = await provider.account(String(event.account));
        Object.assign(input, {
          charges_enabled: snapshot.charges_enabled,
          payouts_enabled: snapshot.payouts_enabled,
          details_submitted: snapshot.details_submitted,
          provider_verified_at: new Date(deps.now()).toISOString(),
        });
      }
      // Deauthorization already removed read access. Trust the binding-specific signed event;
      // persistence only revokes an existing exact account/mode and never reactivates it.
      const outcome = await deps.persist(input);
      return jsonResponse(200, { received: true, ...outcome });
    } catch (error) {
      return errorResponse(error, rid);
    }
  };
}
export const handleMerchantConnectWebhook = createMerchantConnectWebhook();
if (import.meta.main) Deno.serve(handleMerchantConnectWebhook);
