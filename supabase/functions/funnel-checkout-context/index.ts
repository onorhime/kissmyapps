import {
  parseFunnelSignatureHeaders,
  verifyFunnelSignature,
} from "../_shared/crypto.ts";
import {
  funnelKeyBindings,
  funnelSigningSecrets,
  requiredSecret,
} from "../_shared/env.ts";
import {
  DatabaseBoundaryError,
  NotFoundError,
  RequestError,
} from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireJsonContentType,
  requireMethod,
} from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";
import { requireLiveStripeKey } from "../_shared/stripe-auth.ts";
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";

type Candidate = {
  key: string;
  version: number;
  name: string;
  currency: string;
  unit_amount_minor: number;
  billing_mode: "subscription";
  stripe_price_id: string;
};

/** Buyer-facing confirmation is independent of asynchronous reporting workers.
 * Receipt ownership is checked by SQL BEFORE this exact Stripe read. No PII,
 * client secret, or financial/entitlement mutation leaves this boundary. */
export async function verifyCheckoutReceipt(
  evidence: unknown,
  secret: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  requireLiveStripeKey(secret);
  if (
    !isPlainObject(evidence) || typeof evidence.session_id !== "string" ||
    !/^cs_live_[A-Za-z0-9_]{8,160}$/.test(evidence.session_id) ||
    !Number.isSafeInteger(evidence.amount_minor) ||
    Number(evidence.amount_minor) < 1
  ) throw new DatabaseBoundaryError();
  const response = await fetcher(
    `https://api.stripe.com/v1/checkout/sessions/${
      encodeURIComponent(evidence.session_id)
    }`,
    {
      headers: {
        Authorization: `Bearer ${secret}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
      signal: stripeRequestSignal(),
      redirect: "error",
    },
  );
  if (!response.ok) {
    throw new RequestError(
      503,
      "receipt_unavailable",
      "Confirmation is temporarily unavailable.",
    );
  }
  const value: unknown = await response.json();
  const expected = {
    kma_attempt_id: evidence.attempt_id,
    kma_public_attempt_id: evidence.public_attempt_id,
    kma_offer_id: evidence.offer_id,
    kma_product_id: evidence.product_id,
    kma_acquisition_id: evidence.acquisition_id,
    kma_click_id: evidence.click_id,
    kma_expected_amount_minor: String(evidence.amount_minor),
    kma_expected_currency: evidence.currency,
  };
  if (
    !isPlainObject(value) || value.object !== "checkout.session" ||
    value.id !== evidence.session_id ||
    value.livemode !== true || value.mode !== evidence.mode ||
    value.mode !== "subscription" ||
    value.client_reference_id !== evidence.public_attempt_id ||
    value.currency !== String(evidence.currency).toLowerCase() ||
    !isPlainObject(value.metadata) ||
    Object.entries(expected).some(([key, v]) =>
      typeof v !== "string" ||
      (value.metadata as Record<string, unknown>)[key] !== v
    )
  ) {
    throw new RequestError(
      409,
      "receipt_unavailable",
      "Checkout identity could not be verified.",
    );
  }
  if (value.status === "expired") return "expired";
  if (
    value.status === "open" ||
    (value.status === "complete" && value.payment_status === "unpaid")
  ) return "pending";
  if (
    value.status !== "complete" ||
    !["paid", "no_payment_required"].includes(String(value.payment_status)) ||
    typeof value.subscription !== "string" ||
    !/^sub_[A-Za-z0-9_]{8,160}$/.test(value.subscription) ||
    typeof value.customer !== "string" ||
    !/^cus_[A-Za-z0-9_]{8,128}$/.test(value.customer)
  ) {
    throw new RequestError(
      409,
      "receipt_unavailable",
      "Checkout is not confirmed.",
    );
  }
  if (
    value.amount_total === 0 &&
    value.amount_subtotal === evidence.amount_minor &&
    isPlainObject(value.total_details) &&
    value.total_details.amount_discount === evidence.amount_minor &&
    value.total_details.amount_tax === 0 &&
    value.total_details.amount_shipping === 0
  ) return "no_payment_required";
  if (
    value.payment_status === "paid" &&
    value.amount_total === evidence.amount_minor
  ) return "paid";
  throw new RequestError(
    409,
    "receipt_unavailable",
    "Checkout total could not be verified.",
  );
}
export async function verifyPaywallPrice(
  candidate: Candidate,
  secret: string,
  fetcher: typeof fetch = fetch,
) {
  requireLiveStripeKey(secret);
  if (!/^price_[A-Za-z0-9_]{8,128}$/.test(candidate.stripe_price_id)) {
    throw new DatabaseBoundaryError();
  }
  const response = await fetcher(
    `https://api.stripe.com/v1/prices/${
      encodeURIComponent(candidate.stripe_price_id)
    }`,
    {
      headers: {
        Authorization: `Bearer ${secret}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
      signal: stripeRequestSignal(),
      redirect: "error",
    },
  );
  if (!response.ok) {
    throw new RequestError(
      503,
      "offer_unavailable",
      "The verified offer is unavailable.",
    );
  }
  const price: unknown = await response.json();
  if (
    !isPlainObject(price) || price.object !== "price" ||
    price.id !== candidate.stripe_price_id ||
    price.livemode !== true || price.active !== true ||
    price.type !== "recurring" || price.billing_scheme !== "per_unit" ||
    price.currency !== candidate.currency.toLowerCase() ||
    price.unit_amount !== candidate.unit_amount_minor ||
    price.unit_amount_decimal !== String(candidate.unit_amount_minor) ||
    price.custom_unit_amount !== null ||
    price.tiers_mode !== null || price.transform_quantity !== null ||
    !isPlainObject(price.recurring) ||
    price.recurring.usage_type !== "licensed" ||
    !["day", "week", "month", "year"].includes(
      String(price.recurring.interval),
    ) ||
    !Number.isSafeInteger(price.recurring.interval_count) ||
    Number(price.recurring.interval_count) < 1 ||
    Number(price.recurring.interval_count) > 365
  ) {
    throw new RequestError(
      409,
      "offer_changed",
      "The offer must be reviewed again.",
    );
  }
  return {
    key: candidate.key,
    version: candidate.version,
    name: candidate.name,
    currency: candidate.currency,
    unit_amount_minor: candidate.unit_amount_minor,
    billing_mode: "subscription",
    interval: price.recurring.interval,
    interval_count: price.recurring.interval_count,
  };
}

export function parseContextInput(value: unknown): Record<string, unknown> {
  if (
    !isPlainObject(value) || typeof value.click_id !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.click_id)
  ) throw new RequestError(400, "invalid_request", "Invalid context.");
  const keys = value.action === "offer"
    ? ["action", "click_id", "offer_key"]
    : value.action === "status"
    ? ["action", "click_id", "attempt_id", "session_id"]
    : [];
  if (
    !keys.length || Object.keys(value).length !== keys.length ||
    keys.some((k) => !(k in value)) ||
    (value.action === "offer" &&
      (typeof value.offer_key !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.offer_key))) ||
    (value.action === "status" &&
      (typeof value.attempt_id !== "string" ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(value.attempt_id) ||
        typeof value.session_id !== "string" ||
        !/^cs_live_[A-Za-z0-9_]{8,160}$/.test(value.session_id)))
  ) throw new RequestError(400, "invalid_request", "Invalid context.");
  return value;
}

export interface ContextDependencies {
  bindings: typeof funnelKeyBindings;
  read: (
    input: Record<string, unknown>,
    productId: string,
    funnelId: string,
  ) => Promise<unknown>;
  price: typeof verifyPaywallPrice;
  receipt: typeof verifyCheckoutReceipt;
  secret: () => string;
}
export function createFunnelContextHandler(
  overrides: Partial<ContextDependencies> = {},
) {
  const deps: ContextDependencies = {
    bindings: funnelKeyBindings,
    price: verifyPaywallPrice,
    receipt: verifyCheckoutReceipt,
    secret: () => requiredSecret("STRIPE_SECRET_KEY"),
    read: async (input, productId, funnelId) => {
      const { data, error } = await serviceClient(8000).rpc(
        "get_funnel_checkout_context",
        {
          p_input: input,
          p_product_id: productId,
          p_funnel_id: funnelId,
        },
      );
      if (error) {
        if (error.code === "P0002") throw new NotFoundError();
        if (error.code === "KMA29") {
          throw new RequestError(
            429,
            "rate_limited",
            "Try again later.",
          );
        }
        if (error.code === "22023") {
          throw new RequestError(
            400,
            "invalid_request",
            "Invalid context.",
          );
        }
        throw new DatabaseBoundaryError(error.code);
      }
      return data;
    },
    ...overrides,
  };
  return async (request: Request) => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      if (request.headers.has("origin")) {
        throw new RequestError(
          403,
          "browser_request_rejected",
          "Server authentication required.",
        );
      }
      requireJsonContentType(request);
      const bytes = await readRequestBytes(request, 4096);
      const signature = parseFunnelSignatureHeaders(request.headers);
      const bindings = deps.bindings();
      await verifyFunnelSignature(
        bytes,
        signature,
        funnelSigningSecrets(bindings),
      );
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new RequestError(400, "invalid_json", "Invalid JSON.");
      }
      const input = parseContextInput(value);
      const binding = bindings.get(signature.keyId);
      if (!binding) {
        throw new RequestError(
          401,
          "invalid_signature",
          "Authentication failed.",
        );
      }
      const data = await deps.read(input, binding.productId, binding.funnelId);
      if (!isPlainObject(data)) throw new DatabaseBoundaryError();
      if (input.action === "status") {
        if (
          !["pending", "paid", "no_payment_required", "expired", "failed"]
            .includes(
              String(data.status),
            )
        ) throw new DatabaseBoundaryError();
        const status = data.status === "pending"
          ? await deps.receipt(data.verification, deps.secret())
          : data.status;
        return jsonResponse(200, { status, request_id: id });
      }
      if (
        data.key !== input.offer_key || typeof data.name !== "string" ||
        !data.name || data.name.length > 120 ||
        typeof data.currency !== "string" ||
        !/^[A-Z]{3}$/.test(data.currency) ||
        !Number.isSafeInteger(data.unit_amount_minor) ||
        Number(data.unit_amount_minor) < 1 ||
        Number(data.unit_amount_minor) > 99999999 ||
        data.billing_mode !== "subscription" ||
        !Number.isSafeInteger(data.version) || Number(data.version) < 1 ||
        typeof data.stripe_price_id !== "string"
      ) throw new DatabaseBoundaryError();
      const offer = await deps.price(data as Candidate, deps.secret());
      return jsonResponse(200, { offer, request_id: id });
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}
if (import.meta.main) Deno.serve(createFunnelContextHandler());
