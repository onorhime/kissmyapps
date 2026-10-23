import type { SupabaseClient } from "@supabase/supabase-js";
import { productionOrigins, requiredSecret } from "../_shared/env.ts";
import {
  ConfigurationError,
  DatabaseBoundaryError,
  RequestError,
} from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  requestId,
  requireMethod,
  securityHeaders,
} from "../_shared/http.ts";
import { authenticatedClient, serviceClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";
import { requireLiveStripeKey } from "../_shared/stripe-auth.ts";
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRICE_ID = /^price_[A-Za-z0-9_]{8,128}$/;

interface OfferCandidate {
  billingOfferId: string;
  stripePriceId: string;
  currency: string;
  unitAmountMinor: number;
  billingMode: "payment" | "subscription";
}

interface VerifiedPrice {
  stripe_price_id: string;
  livemode: true;
  active: true;
  currency: string;
  unit_amount_minor: number;
  billing_mode: "payment" | "subscription";
}

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PriceVerifierDependencies {
  userClient: (authorization: string) => SupabaseClient;
  serviceClient: () => SupabaseClient;
  stripeSecret: () => string;
  fetcher: Fetcher;
}

const productionDependencies: PriceVerifierDependencies = {
  userClient: authenticatedClient,
  serviceClient,
  stripeSecret: () => requiredSecret("STRIPE_SECRET_KEY"),
  fetcher: fetch,
};

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function acceptedOrigin(request: Request): string {
  const origin = request.headers.get("origin")?.trim();
  if (!origin || !productionOrigins("ADMIN_ALLOWED_ORIGINS").has(origin)) {
    throw new RequestError(
      403,
      "origin_not_allowed",
      "Request origin is not allowed.",
    );
  }
  return origin;
}

function authorizationHeader(request: Request): string {
  const value = request.headers.get("authorization")?.trim();
  if (!value || !/^Bearer [A-Za-z0-9._~-]{32,4096}$/.test(value)) {
    throw new RequestError(401, "unauthorized", "Authentication is required.");
  }
  return value;
}

function parseInput(value: unknown): string {
  if (
    !isPlainObject(value) || Object.keys(value).length !== 1 ||
    typeof value.billing_offer_id !== "string" ||
    !UUID.test(value.billing_offer_id)
  ) {
    throw new RequestError(
      400,
      "invalid_payload",
      "A valid billing offer ID is required.",
    );
  }
  return value.billing_offer_id.toLowerCase();
}

function parseCandidate(value: unknown): OfferCandidate {
  if (
    !isPlainObject(value) ||
    typeof value.billing_offer_id !== "string" ||
    !UUID.test(value.billing_offer_id) ||
    typeof value.stripe_price_id !== "string" ||
    !PRICE_ID.test(value.stripe_price_id) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !Number.isSafeInteger(value.unit_amount_minor) ||
    Number(value.unit_amount_minor) < 1 ||
    Number(value.unit_amount_minor) > 99_999_999 ||
    (value.billing_mode !== "payment" &&
      value.billing_mode !== "subscription")
  ) {
    throw new DatabaseBoundaryError();
  }
  return {
    billingOfferId: value.billing_offer_id,
    stripePriceId: value.stripe_price_id,
    currency: value.currency,
    unitAmountMinor: Number(value.unit_amount_minor),
    billingMode: value.billing_mode,
  };
}

function liveStripeSecret(value: string): string {
  return requireLiveStripeKey(value);
}

async function fetchVerifiedPrice(
  candidate: OfferCandidate,
  secret: string,
  fetcher: Fetcher,
): Promise<VerifiedPrice> {
  let response: Response;
  try {
    response = await fetcher(
      `https://api.stripe.com/v1/prices/${
        encodeURIComponent(candidate.stripePriceId)
      }`,
      {
        headers: {
          Authorization: `Bearer ${secret}`,
          "Stripe-Version": STRIPE_API_VERSION,
        },
        signal: stripeRequestSignal(),
      },
    );
  } catch {
    throw new RequestError(
      503,
      "stripe_unavailable",
      "Stripe Price verification is temporarily unavailable.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ConfigurationError();
  }
  if (!response.ok) {
    throw new RequestError(
      response.status === 404 ? 400 : 503,
      response.status === 404 ? "stripe_price_not_found" : "stripe_unavailable",
      response.status === 404
        ? "The configured Stripe Price was not found in the live account."
        : "Stripe Price verification is temporarily unavailable.",
    );
  }

  let price: unknown;
  try {
    price = await response.json();
  } catch {
    throw new RequestError(
      503,
      "stripe_unavailable",
      "Stripe Price verification is temporarily unavailable.",
    );
  }
  if (!isPlainObject(price)) {
    throw new RequestError(
      400,
      "stripe_price_mismatch",
      "Stripe Price does not match the offer.",
    );
  }
  const expectedType = candidate.billingMode === "subscription"
    ? "recurring"
    : "one_time";
  const recurringIsLicensed = candidate.billingMode !== "subscription" ||
    (isPlainObject(price.recurring) &&
      price.recurring.usage_type === "licensed");
  if (
    price.object !== "price" || price.id !== candidate.stripePriceId ||
    price.livemode !== true || price.active !== true ||
    price.billing_scheme !== "per_unit" || price.type !== expectedType ||
    price.currency !== candidate.currency.toLowerCase() ||
    price.unit_amount !== candidate.unitAmountMinor ||
    price.unit_amount_decimal !== String(candidate.unitAmountMinor) ||
    price.custom_unit_amount !== null || price.tiers_mode !== null ||
    price.transform_quantity !== null || !recurringIsLicensed
  ) {
    throw new RequestError(
      400,
      "stripe_price_mismatch",
      "The live Stripe Price does not exactly match the configured offer.",
    );
  }
  return {
    stripe_price_id: candidate.stripePriceId,
    livemode: true,
    active: true,
    currency: candidate.currency,
    unit_amount_minor: candidate.unitAmountMinor,
    billing_mode: candidate.billingMode,
  };
}

export async function handleStripePriceVerifier(
  request: Request,
  dependencies: PriceVerifierDependencies = productionDependencies,
): Promise<Response> {
  const id = requestId(request);
  let cors: HeadersInit = {};
  try {
    requireMethod(request, ["POST", "OPTIONS"]);
    const origin = acceptedOrigin(request);
    cors = corsHeaders(origin);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: securityHeaders(cors),
      });
    }
    const authorization = authorizationHeader(request);
    const billingOfferId = parseInput(await readJsonBody(request, 4 * 1024));
    const candidateResult = await dependencies.userClient(authorization).rpc(
      "get_admin_billing_offer_verification_candidate",
      { p_billing_offer_id: billingOfferId },
    );
    if (candidateResult.error) {
      const code = candidateResult.error.code;
      if (code === "28000" || code === "42501") {
        throw new RequestError(
          403,
          "forbidden",
          "Verification is not allowed.",
        );
      }
      if (code === "P0002" || code === "P0001" || code === "22023") {
        throw new RequestError(
          400,
          "offer_not_verifiable",
          "The offer cannot be verified.",
        );
      }
      throw new DatabaseBoundaryError(code);
    }
    const candidate = parseCandidate(candidateResult.data);
    if (candidate.billingOfferId.toLowerCase() !== billingOfferId) {
      throw new DatabaseBoundaryError();
    }
    const verified = await fetchVerifiedPrice(
      candidate,
      liveStripeSecret(dependencies.stripeSecret()),
      dependencies.fetcher,
    );
    const recorded = await dependencies.serviceClient().rpc(
      "record_billing_offer_stripe_verification",
      {
        p_input: {
          billing_offer_id: candidate.billingOfferId,
          ...verified,
        },
      },
    );
    if (recorded.error || recorded.data !== true) {
      throw new DatabaseBoundaryError(recorded.error?.code);
    }
    return jsonResponse(
      200,
      {
        verified: true,
        billing_offer_id: candidate.billingOfferId,
        request_id: id,
      },
      { ...cors, "X-Request-ID": id },
    );
  } catch (error) {
    return errorResponse(error, id, { ...cors, "X-Request-ID": id });
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleStripePriceVerifier(request));
}
