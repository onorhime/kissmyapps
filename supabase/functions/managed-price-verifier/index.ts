import { productionOrigins } from "../_shared/env.ts";
import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  requestId,
  requireMethod,
  securityHeaders,
} from "../_shared/http.ts";
import { authenticatedClient } from "../_shared/supabase.ts";
import { UUID } from "../external-commerce/contract.ts";
import {
  type Json,
  type ManagedBinding,
  managedBindings,
  object,
  reject,
} from "../managed-checkout/contract.ts";
import { ManagedProvider } from "../managed-checkout/provider.ts";
import {
  databaseStore,
  type ManagedStore,
  resolveManagedBinding,
} from "../managed-checkout/service.ts";
export interface ManagedVerifierDependencies {
  bindings: () => Map<string, ManagedBinding>;
  origins: () => ReadonlySet<string>;
  candidate: (auth: string, id: string) => Promise<Json>;
  store: ManagedStore;
  provider: (binding: ManagedBinding) => ManagedProvider;
}
export function createManagedPriceVerifier(
  overrides: Partial<ManagedVerifierDependencies> = {},
) {
  const deps: ManagedVerifierDependencies = {
    bindings: managedBindings,
    origins: () => productionOrigins("ADMIN_ALLOWED_ORIGINS"),
    store: databaseStore(),
    provider: (b) => new ManagedProvider(b),
    candidate: async (auth, id) => {
      const { data, error } = await authenticatedClient(auth).rpc(
        "get_admin_managed_price_verification_candidate",
        { p_billing_offer_id: id },
      );
      if (error) {
        if (["28000", "42501"].includes(error.code)) {
          throw new RequestError(
            403,
            "forbidden",
            "Verification is not allowed.",
          );
        }
        throw new DatabaseBoundaryError(error.code);
      }
      return data;
    },
    ...overrides,
  };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    let headers: Record<string, string> = {};
    try {
      requireMethod(request, ["POST", "OPTIONS"]);
      const origin = request.headers.get("origin") ?? "";
      if (!deps.origins().has(origin)) {
        reject("origin_not_allowed", "Request origin is not allowed.", 403);
      }
      headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers":
          "authorization,apikey,content-type,x-client-info",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
        Vary: "Origin",
      };
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: securityHeaders(headers),
        });
      }
      const auth = request.headers.get("authorization") ?? "";
      if (!/^Bearer [A-Za-z0-9._~-]{32,4096}$/.test(auth)) {
        reject("unauthorized", "Authentication is required.", 401);
      }
      const input = await readJsonBody(request, 4096);
      if (
        !object(input) ||
        Object.keys(input).sort().join(",") !==
          "billing_offer_id,binding_id,stripe_price_id" ||
        !UUID.test(String(input.billing_offer_id)) ||
        !/^price_[A-Za-z0-9_]{8,128}$/.test(String(input.stripe_price_id))
      ) reject();
      const c = await deps.candidate(auth, String(input.billing_offer_id)),
        b = deps.bindings().get(String(input.binding_id));
      if (
        !b || c.billing_offer_id !== input.billing_offer_id ||
        c.product_id !== b.productId || c.billing_mode !== "payment"
      ) {
        reject(
          "managed_price_scope_mismatch",
          "Select a configured integration for this one-time offer.",
          409,
        );
      }
      const effective = await resolveManagedBinding(deps.store, b, {
        action: "quote",
      });
      const p = deps.provider(effective);
      await p.verifyAccount();
      await p.verifyPrice({
        stripe_price_id: input.stripe_price_id,
        currency: c.currency,
        unit_amount_minor: c.unit_amount_minor,
      });
      await deps.store.rpc("record_managed_price_verification", {
        p_input: {
          billing_offer_id: c.billing_offer_id,
          product_id: c.product_id,
          offer_version: c.offer_version,
          configured_price_id: c.stripe_price_id,
          account_id: effective.accountId,
          livemode: b.livemode,
          stripe_price_id: input.stripe_price_id,
          currency: c.currency,
          unit_amount_minor: c.unit_amount_minor,
        },
      });
      return jsonResponse(200, {
        verified: true,
        billing_offer_id: c.billing_offer_id,
        binding_id: b.id,
        account_id: effective.accountId,
        livemode: b.livemode,
        stripe_price_id: input.stripe_price_id,
        request_id: rid,
      }, headers);
    } catch (error) {
      return errorResponse(error, rid, headers);
    }
  };
}
export const handleManagedPriceVerifier = createManagedPriceVerifier();
if (import.meta.main) Deno.serve(handleManagedPriceVerifier);
