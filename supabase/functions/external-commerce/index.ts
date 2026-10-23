import {
  parseFunnelSignatureHeaders,
  verifyFunnelSignature,
} from "../_shared/crypto.ts";
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
  type CommerceBinding,
  commerceBindings,
  type CommerceEvidence,
  type CommerceInput,
  validateCommerce,
  verifyCommerceWithStripe,
} from "./contract.ts";
export interface ExternalCommerceDependencies {
  bindings: () => ReadonlyMap<string, CommerceBinding>;
  authorize: (
    key: string,
    input: CommerceInput,
    binding: CommerceBinding,
  ) => Promise<void>;
  verify: (
    input: CommerceInput,
    binding: CommerceBinding,
  ) => Promise<CommerceEvidence>;
  ingest: (
    evidence: CommerceEvidence,
  ) => Promise<{ event_id: string; duplicate: boolean }>;
  recordBasis: (input: Record<string, unknown>) => Promise<void>;
}
function dependencies(): ExternalCommerceDependencies {
  return {
    bindings: commerceBindings,
    authorize: (key, input, binding) =>
      assertFunnelRequestScope(
        serviceClient(),
        key,
        input.click_id,
        binding.productId,
        binding.funnelId,
      ),
    verify: verifyCommerceWithStripe,
    recordBasis: async (input) => {
      const { error } = await serviceClient().rpc(
        "record_external_commission_basis",
        { p_input: input },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
    },
    ingest: async (evidence) => {
      const { data, error } = await serviceClient().rpc(
        "ingest_external_commerce",
        { p_evidence: evidence },
      );
      if (error) {
        if (["22023", "23505"].includes(error.code)) {
          throw new RequestError(
            409,
            "commercial_evidence_conflict",
            "Commercial evidence conflicts with an existing record.",
          );
        }
        if (error.code === "P0002") {
          throw new RequestError(
            403,
            "merchant_scope_unavailable",
            "External merchant scope is not enabled.",
          );
        }
        throw new DatabaseBoundaryError(error.code);
      }
      return data;
    },
  };
}
export function createExternalCommerceHandler(
  overrides: Partial<ExternalCommerceDependencies> = {},
) {
  const deps = { ...dependencies(), ...overrides };
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
      const raw = await readRequestBytes(request, 16 * 1024),
        signature = parseFunnelSignatureHeaders(request.headers),
        bindings = deps.bindings();
      await verifyFunnelSignature(
        raw,
        signature,
        new Map([...bindings].map(([key, value]) => [key, value.secret])),
      );
      const binding = bindings.get(signature.keyId)!;
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
        );
      } catch {
        throw new RequestError(
          400,
          "invalid_json",
          "A JSON request body is required.",
        );
      }
      const input = validateCommerce(parsed);
      if (
        input.account_id !== binding.accountId ||
        input.livemode !== binding.livemode
      ) {
        throw new RequestError(
          403,
          "merchant_scope_rejected",
          "Merchant scope does not match the signed key.",
        );
      }
      await deps.authorize(signature.keyId, input, binding);
      const evidence = await deps.verify(input, binding);
      // Keep the pre-existing immutable receipt byte-for-byte compatible. Basis
      // is a separate append-only provider attestation, including on replay.
      const {
        basis_verified,
        basis_policy,
        eligible_basis_minor,
        cost_evidence,
        ...core
      } = evidence;
      const receipt = await deps.ingest(core);
      if (
        basis_verified === true &&
        basis_policy === "post_discount_excluding_tax_shipping" &&
        Number.isSafeInteger(eligible_basis_minor)
      ) {
        await deps.recordBasis({
          external_order_id: input.order_id,
          stripe_account_id: input.account_id,
          livemode: input.livemode,
          eligible_basis_minor,
          total_minor: input.amount_minor,
          currency: input.currency,
          basis_policy,
          ...(cost_evidence ?? {}),
          verified_at: new Date().toISOString(),
        });
      }
      if (
        !basis_verified ||
        cost_evidence?.fee_unavailable_reason === "provider_fee_pending"
      ) {
        // The merchant outbox retries the same receipt. Store the verified sale
        // first, then enrich costs once Stripe publishes the balance transaction.
        throw new RequestError(
          503,
          "provider_cost_evidence_pending",
          "The sale was recorded. Provider fees or totals are still pending; retry this same event.",
        );
      }
      return jsonResponse(200, {
        accepted: true,
        ...receipt,
        commission_status: "held",
        ...(cost_evidence?.fee_verified === false
          ? {
            commission_hold_reason: cost_evidence.fee_unavailable_reason,
            provider_evidence_retryable: false,
          }
          : {}),
        request_id: id,
      }, { "X-Request-ID": id });
    } catch (error) {
      return errorResponse(error, id, { "X-Request-ID": id });
    }
  };
}
export const handleExternalCommerce = createExternalCommerceHandler();
if (import.meta.main) Deno.serve(handleExternalCommerce);
