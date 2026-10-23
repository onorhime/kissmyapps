import { ConfigurationError, RequestError } from "./errors.ts";
import { isPlainObject } from "./validation.ts";
import { STRIPE_API_VERSION, stripeRequestSignal } from "./stripe-api.ts";

/** Explicit product-scoped opt-in. No missing/invalid binding falls back to paid. */
export function freePromotionForProduct(productId: string): string {
  let bindings: unknown;
  try {
    bindings = JSON.parse(
      Deno.env.get("FREE_CHECKOUT_PROMOTION_BINDINGS") ?? "{}",
    );
  } catch {
    throw new ConfigurationError();
  }
  if (
    !isPlainObject(bindings) || typeof bindings[productId] !== "string" ||
    !/^promo_[A-Za-z0-9_]{8,160}$/.test(bindings[productId])
  ) throw new ConfigurationError();
  return bindings[productId];
}

/** Only a live, applicable 100%-off FOREVER coupon can satisfy this test path. */
export async function verifyFreePromotion(
  secret: string,
  promotionId: string,
  priceId: string,
  currency: string,
  amount: number,
  fetcher: typeof fetch = fetch,
) {
  if (!/^promo_[A-Za-z0-9_]{8,160}$/.test(promotionId)) {
    throw new ConfigurationError();
  }
  const get = async (path: string) => {
    const response = await fetcher(`https://api.stripe.com/v1/${path}`, {
      headers: {
        Authorization: `Bearer ${secret}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
      signal: stripeRequestSignal(),
      redirect: "error",
    });
    if (!response.ok) {
      throw new RequestError(
        503,
        "free_discount_unavailable",
        "The no-charge test discount is unavailable.",
      );
    }
    return await response.json() as unknown;
  };
  const [promotion, price] = await Promise.all([
    get(
      `promotion_codes/${
        encodeURIComponent(promotionId)
      }?expand%5B%5D=promotion.coupon.applies_to`,
    ),
    get(`prices/${encodeURIComponent(priceId)}`),
  ]);
  const descriptor =
    isPlainObject(promotion) && isPlainObject(promotion.promotion)
      ? promotion.promotion
      : null;
  const coupon = descriptor && isPlainObject(descriptor.coupon)
    ? descriptor.coupon
    : null;
  const applies = coupon?.applies_to == null
    ? null
    : isPlainObject(coupon.applies_to)
    ? coupon.applies_to.products
    : false;
  if (
    !isPlainObject(promotion) || promotion.id !== promotionId ||
    promotion.active !== true || promotion.livemode !== true ||
    descriptor?.type !== "coupon" || !coupon || coupon.object !== "coupon" ||
    // Missing means unexpanded/unknown, not an unrestricted coupon. Only an
    // explicit null may be treated as unrestricted after requesting expansion.
    !Object.hasOwn(coupon, "applies_to") ||
    coupon.valid !== true ||
    coupon.percent_off !== 100 || coupon.duration !== "forever" ||
    coupon.amount_off !== null ||
    !isPlainObject(price) || price.id !== priceId || price.livemode !== true ||
    price.active !== true ||
    price.type !== "recurring" || price.currency !== currency.toLowerCase() ||
    price.unit_amount !== amount ||
    typeof price.product !== "string" ||
    (applies !== null &&
      (!Array.isArray(applies) || !applies.includes(price.product)))
  ) {
    throw new RequestError(
      409,
      "free_discount_unavailable",
      "A valid 100%-off recurring test discount is required.",
    );
  }
}
