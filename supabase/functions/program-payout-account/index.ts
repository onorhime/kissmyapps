// A creator's payout account for affiliate programs: their own Stripe account,
// set up inside the creator dashboard with Stripe's embedded onboarding, as a
// connected account of the KissMyApps platform that holds program money.
//
// This is the legacy creator-connect handler, unchanged, with two of its
// dependencies replaced: the bindings (only the console platform's live
// entry) and the gate that decides whether a creator may connect (the
// database function program_creator_payout_context instead of the legacy one,
// which asks for approved external terms). Requests and answers are those of
// creator-connect, so the same front-end code talks to both.
// Off unless PROGRAM_PAYOUTS_ENABLED is exactly "true". Live only.
import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import { errorResponse, requestId, requireMethod } from "../_shared/http.ts";
import { authenticatedClient } from "../_shared/supabase.ts";
import {
  type ConnectDependencies,
  createCreatorConnectHandler,
  type CreatorContext,
} from "../creator-connect/index.ts";
import { programPayoutBindings, programPayoutsEnabled } from "./config.ts";

/** A database function called as the signed-in creator. */
export type CreatorRpc = (
  authorization: string,
  name: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;

const creatorRpc: CreatorRpc = (authorization, name, args) =>
  authenticatedClient(authorization).rpc(name, args);

/**
 * Whether this creator may have a payout account on the platform, and their
 * account row if so. The database decides; "not allowed" is null, which the
 * handler turns into "no payout account available".
 */
export function payoutContext(
  rpc: CreatorRpc = creatorRpc,
): ConnectDependencies["context"] {
  return async (authorization, config) => {
    const { data, error } = await rpc(
      authorization,
      "program_creator_payout_context",
      {
        p_platform_account_id: config.platformAccountId,
        p_livemode: config.livemode,
      },
    );
    if (error?.code === "42501" || error?.code === "P0002") return null;
    if (error) throw new DatabaseBoundaryError(error.code);
    return data as CreatorContext;
  };
}

export interface ProgramPayoutAccountDependencies extends ConnectDependencies {
  enabled: () => boolean;
}

export function createProgramPayoutAccountHandler(
  overrides: Partial<ProgramPayoutAccountDependencies> = {},
) {
  const { enabled = programPayoutsEnabled, ...connect } = overrides;
  // Everything not named here (sign-in check, account reservation, storing
  // the account's state, the Stripe calls) is the legacy handler's own.
  const handler = createCreatorConnectHandler({
    bindings: programPayoutBindings,
    context: payoutContext(),
    ...connect,
  });
  return async (request: Request): Promise<Response> => {
    if (enabled()) return await handler(request);
    // Switched off: no database call, no Stripe call, no key is read. The
    // answer can be read from any origin, as the legacy handler's is when it
    // has no binding; it says nothing but "off".
    const origin = request.headers.get("origin");
    const cors: Record<string, string> = origin
      ? {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        "Access-Control-Allow-Headers":
          "authorization, apikey, content-type, x-client-info",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      }
      : {};
    try {
      requireMethod(request, ["POST", "OPTIONS"]);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }
      throw new RequestError(
        503,
        "program_payouts_disabled",
        "Payout accounts are not available yet.",
      );
    } catch (error) {
      return errorResponse(error, requestId(request), cors);
    }
  };
}

export const handleProgramPayoutAccount = createProgramPayoutAccountHandler();
if (import.meta.main) Deno.serve(handleProgramPayoutAccount);
