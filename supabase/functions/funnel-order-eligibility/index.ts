import {
  parseFunnelSignatureHeaders,
  verifyFunnelSignature,
} from "../_shared/crypto.ts";
import { funnelSigningSecrets } from "../_shared/env.ts";
import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireJsonContentType,
  requireMethod,
} from "../_shared/http.ts";
import { assertFunnelRequestScope } from "../_shared/rpc.ts";
import { serviceClient } from "../_shared/supabase.ts";
import {
  type OrderEligibilityEvent,
  validateOrderEligibility,
} from "./contract.ts";
import {
  type CommerceBinding,
  commerceBindings,
} from "../external-commerce/contract.ts";
export type EligibilityBinding = Pick<
  CommerceBinding,
  "secret" | "productId" | "funnelId" | "accountId" | "livemode"
>;
export interface OrderEligibilityDependencies {
  bindings: () => ReadonlyMap<string, EligibilityBinding>;
  authorize: (
    key: string,
    click: string,
    product: string,
    funnel: string,
  ) => Promise<void>;
  ingest: (
    product: string,
    funnel: string,
    event: OrderEligibilityEvent,
  ) => Promise<{ event_id: string; duplicate: boolean }>;
}
export function createOrderEligibilityHandler(
  overrides: Partial<OrderEligibilityDependencies> = {},
) {
  const deps: OrderEligibilityDependencies = {
    bindings: commerceBindings,
    authorize: (key, click, product, funnel) =>
      assertFunnelRequestScope(serviceClient(), key, click, product, funnel),
    ingest: async (product, funnel, event) => {
      const { data, error } = await serviceClient().rpc(
        "ingest_external_order_eligibility",
        { p_product_id: product, p_funnel_id: funnel, p_event: event },
      );
      if (error) {
        if (error.code === "P0002") {
          throw new RequestError(
            409,
            "verified_purchase_pending",
            "The verified purchase has not arrived yet. Retry this same event later.",
          );
        }
        if (["22023", "23505"].includes(error.code)) {
          throw new RequestError(
            409,
            "order_eligibility_conflict",
            "Check the verified order and immutable eligibility identity.",
          );
        }
        throw new DatabaseBoundaryError(error.code);
      }
      return data;
    },
    ...overrides,
  };
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      if (request.headers.has("origin")) {
        throw new RequestError(
          403,
          "browser_request_rejected",
          "Server authentication is required.",
        );
      }
      requireJsonContentType(request);
      const bytes = await readRequestBytes(request, 8192);
      const sig = parseFunnelSignatureHeaders(request.headers);
      const bindings = deps.bindings();
      await verifyFunnelSignature(bytes, sig, funnelSigningSecrets(bindings));
      let raw: unknown;
      try {
        raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new RequestError(
          400,
          "invalid_json",
          "A JSON order eligibility event is required.",
        );
      }
      const input = validateOrderEligibility(raw);
      const binding = bindings.get(sig.keyId)!;
      if (
        input.stripe_account_id !== binding.accountId ||
        input.livemode !== binding.livemode
      ) {
        throw new RequestError(
          403,
          "eligibility_merchant_mismatch",
          "Use the merchant and payment mode bound to this signing key.",
        );
      }
      await deps.authorize(
        sig.keyId,
        input.click_id,
        binding.productId,
        binding.funnelId,
      );
      const receipt = await deps.ingest(
        binding.productId,
        binding.funnelId,
        input,
      );
      return jsonResponse(200, { accepted: true, ...receipt, request_id: id }, {
        "X-Request-ID": id,
      });
    } catch (error) {
      return errorResponse(error, id, { "X-Request-ID": id });
    }
  };
}
export const handleOrderEligibility = createOrderEligibilityHandler();
if (import.meta.main) Deno.serve(handleOrderEligibility);
