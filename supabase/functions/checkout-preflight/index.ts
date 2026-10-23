import { constantTimeEqualStrings } from "../_shared/crypto.ts";
import { requiredEnv, requiredSecret } from "../_shared/env.ts";
import { ConfigurationError, RequestError } from "../_shared/errors.ts";
import {
  freePromotionForProduct,
  verifyFreePromotion,
} from "../_shared/free-checkout.ts";
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  requestId,
  requireMethod,
} from "../_shared/http.ts";
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";
import { requireLiveStripeKey } from "../_shared/stripe-auth.ts";
import { isPlainObject } from "../_shared/validation.ts";

// Deliberately narrow acceptance diagnostic, not a generic Stripe proxy.
// No user-provided URLs, IDs, payloads or Stripe writes are accepted.
export const BC = {
  project: "mmyruzjemjecqyivhrgr",
  product: "fdbabb87-9743-4521-bc8d-11804fe1185f",
  price: "price_1UCJHDE47mNwFlz1NEFOTxtB",
  stripeProduct: "prod_VCii4guzoryBtZ",
  promotion: "promo_1UCzV4E47mNwFlz1P3dsXuUT",
  coupon: "Kc9faGnA",
};

export interface PreflightDependencies {
  stripeSecret(): string;
  promotion(): string;
  fetcher: typeof fetch;
  now(): number;
}

export async function runPreflight(deps: PreflightDependencies) {
  const secret = requireLiveStripeKey(deps.stripeSecret());
  if (deps.promotion() !== BC.promotion) throw new ConfigurationError();
  const paths = {
    price: `prices/${BC.price}`,
    promotion:
      `promotion_codes/${BC.promotion}?expand%5B%5D=promotion.coupon.applies_to`,
    coupon: `coupons/${BC.coupon}?expand%5B%5D=applies_to`,
    subscriptionRead: "subscriptions/sub_KmaReadOnlyPermissionProbe20260906",
    invoiceRead: "invoices/in_KmaReadOnlyPermissionProbe20260906",
    chargeRead: "charges/ch_KmaReadOnlyPermissionProbe20260906",
    paymentIntentRead: "payment_intents/pi_KmaReadOnlyPermissionProbe20260906",
    balanceTransactionRead:
      "balance_transactions/txn_KmaReadOnlyPermissionProbe20260906",
    // Only future-dated rows (which cannot exist yet), never existing shared
    // account payments. A nonexistent invoice filter is rejected before lookup.
    invoicePaymentsRead: `invoice_payments?created%5Bgte%5D=${
      Math.floor(deps.now() / 1000) + 86400
    }&limit=1`,
  };
  const responses = new Map<string, Response>();
  const bodies = new Map<string, Record<string, unknown>>();
  const checks: Record<string, { httpStatus: number | null; result: string }> =
    {};
  await Promise.all(
    Object.entries(paths).map(async ([name, path]) => {
      const url = `https://api.stripe.com/v1/${path}`;
      try {
        const response = await deps.fetcher(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Stripe-Version": STRIPE_API_VERSION,
          },
          redirect: "error",
          signal: stripeRequestSignal(),
        });
        const text = await response.text();
        if (text.length > 100_000) throw new Error("oversized");
        const parsed: unknown = JSON.parse(text);
        const value = isPlainObject(parsed) ? parsed : {};
        const error = isPlainObject(value.error) ? value.error : {};
        responses.set(url, new Response(text, { status: response.status }));
        bodies.set(name, value);
        const expectedCatalogObject = ["price", "promotion", "coupon"].includes(
          name,
        );
        const missingObject = response.status === 404 &&
          error.code === "resource_missing";
        checks[name] = {
          httpStatus: response.status,
          result: response.status === 401 || response.status === 403
            ? "access_denied"
            : expectedCatalogObject && response.status === 200
            ? "retrieved"
            : !expectedCatalogObject && missingObject
            ? "missing_resource_not_permission_denied"
            : name === "invoicePaymentsRead" && response.status === 200 &&
                value.object === "list" && Array.isArray(value.data) &&
                value.data.length === 0
            ? "empty_scoped_list"
            : "inconclusive",
        };
      } catch {
        checks[name] = { httpStatus: null, result: "request_unavailable" };
      }
    }),
  );

  let existingCheckoutValidatorPassed = false;
  try {
    // Exercise the exact deployed checkout validator against these live GET
    // responses without any second provider request or Checkout creation.
    const replay = ((url: RequestInfo | URL) => {
      const response = responses.get(String(url));
      if (!response) throw new Error("unavailable");
      return Promise.resolve(response.clone());
    }) as typeof fetch;
    await verifyFreePromotion(
      secret,
      BC.promotion,
      BC.price,
      "USD",
      100,
      replay,
    );
    existingCheckoutValidatorPassed = true;
  } catch {
    /* Return bounded check results, never provider errors or key data. */
  }

  const promotion = bodies.get("promotion") ?? {};
  const coupon = bodies.get("coupon") ?? {};
  const price = bodies.get("price") ?? {};
  const descriptor = isPlainObject(promotion.promotion)
    ? promotion.promotion
    : {};
  const embeddedCoupon = isPlainObject(descriptor.coupon)
    ? descriptor.coupon
    : {};
  const applies = isPlainObject(coupon.applies_to)
    ? coupon.applies_to.products
    : null;
  const restrictions = isPlainObject(promotion.restrictions)
    ? promotion.restrictions
    : {};
  const recurring = isPlainObject(price.recurring) ? price.recurring : {};
  const now = Math.floor(deps.now() / 1000);
  const futureOrUnset = (value: unknown) =>
    value === null ||
    (Number.isSafeInteger(value) && Number(value) > now);
  const terms = {
    exactPriceAndProduct: price.id === BC.price &&
      price.product === BC.stripeProduct &&
      price.livemode === true && price.active === true &&
      price.currency === "usd" &&
      price.unit_amount === 100 && recurring.interval === "month" &&
      recurring.interval_count === 1,
    exactCoupon: embeddedCoupon.id === BC.coupon && coupon.id === BC.coupon &&
      coupon.valid === true &&
      coupon.object === "coupon" && coupon.percent_off === 100 &&
      coupon.duration === "forever" && coupon.amount_off === null,
    restrictedToBcLearn: Array.isArray(applies) && applies.length === 1 &&
      applies[0] === BC.stripeProduct,
    oneUnusedRedemption: promotion.max_redemptions === 1 &&
      promotion.times_redeemed === 0 &&
      coupon.max_redemptions === 1 && coupon.times_redeemed === 0,
    notExpired: futureOrUnset(promotion.expires_at) &&
      futureOrUnset(coupon.redeem_by),
    noCustomerOrMinimumRestriction: promotion.customer === null &&
      restrictions.first_time_transaction === false &&
      restrictions.minimum_amount === null,
  };
  return {
    project: BC.project,
    productId: BC.product,
    priceId: BC.price,
    promotionId: BC.promotion,
    apiVersion: STRIPE_API_VERSION,
    liveKeyFormat: true,
    checks,
    terms,
    existingCheckoutValidatorPassed,
    discountReady: existingCheckoutValidatorPassed &&
      Object.values(terms).every(Boolean),
    checkoutWritePermission: "not_exercised",
    readProbeLimit:
      "Missing-resource probes are not proof of processing a real object or of write permission.",
    stripeWrites: 0,
    checkoutEnabledChanged: false,
  };
}

export function createPreflightHandler(supplied?: PreflightDependencies) {
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      const expected = requiredSecret("PROCESSING_SCHEDULER_SECRET");
      const provided = request.headers.get("x-kma-scheduler-secret") ?? "";
      if (!provided || !constantTimeEqualStrings(expected, provided)) {
        throw new RequestError(
          401,
          "unauthorized",
          "Operator authentication required.",
        );
      }
      const body = await readJsonBody(request, 512);
      if (!isPlainObject(body) || Object.keys(body).length !== 0) {
        throw new RequestError(
          400,
          "invalid_request",
          "This preflight accepts no parameters.",
        );
      }
      if (
        !supplied &&
        requiredEnv("SUPABASE_URL") !== `https://${BC.project}.supabase.co`
      ) {
        throw new ConfigurationError();
      }
      return jsonResponse(200, {
        ...await runPreflight(
          supplied ?? {
            stripeSecret: () => requiredSecret("STRIPE_SECRET_KEY"),
            promotion: () => freePromotionForProduct(BC.product),
            fetcher: fetch,
            now: Date.now,
          },
        ),
        request_id: id,
      });
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}
export const handleCheckoutPreflight = createPreflightHandler();
if (import.meta.main) Deno.serve(handleCheckoutPreflight);
