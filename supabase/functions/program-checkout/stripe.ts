// Stripe calls KissMyApps makes on a merchant's own connected account: the
// platform's live key with the Stripe-Account header, the pinned API version,
// a timeout and, on every POST, an Idempotency-Key. Used by program-checkout
// (one Checkout Session per buyer) and program-promo-worker (the coupon and
// promotion code of each creator). Stripe's bodies are never returned or
// logged: callers get normalized facts or a ConnectedStripeError with a short
// code. Nothing here logs.
import { ConfigurationError } from "../_shared/errors.ts";
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";
import { isPlainObject } from "../_shared/validation.ts";

type Json = Record<string, unknown>;
export type FormParams = readonly (readonly [string, string])[];

const API = "https://api.stripe.com/v1";
const CODE = /^[a-z][a-z0-9_]{1,59}$/;
export const STRIPE_IDS = {
  account: /^acct_[A-Za-z0-9]{3,128}$/,
  session: /^cs_[A-Za-z0-9_]{1,252}$/,
  // A coupon id Stripe makes (or one a merchant chose, which this code never does).
  coupon: /^[A-Za-z0-9_-]{1,200}$/,
  // As program_sales and program_promo_codes store it.
  promotionCode: /^promo_[A-Za-z0-9]{1,250}$/,
} as const;

/**
 * Why a Stripe call gave no answer to work with.
 *   unavailable: not reached, timed out, 409 (same Idempotency-Key still
 *     running), 429, 5xx or unreadable. For a POST the outcome is unknown, and
 *     the same request with the same key may be sent again.
 *   rejected: Stripe refused the request (4xx). `exists` is set when what was
 *     asked for already exists (a promotion code with that code).
 *   account: 403, the merchant's account no longer lets the platform in.
 *   configuration: 401, the platform key itself was refused.
 */
export class ConnectedStripeError extends Error {
  constructor(
    readonly kind: "unavailable" | "rejected" | "account" | "configuration",
    readonly code: string,
    readonly exists = false,
  ) {
    super(`Stripe call failed: ${kind}`);
    this.name = "ConnectedStripeError";
  }
}

function unreadable(): never {
  throw new ConnectedStripeError("unavailable", "stripe_unreadable");
}

function identifier(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) unreadable();
  return value as string;
}

/**
 * Stripe says a promotion code with that code is already active on the
 * account. Stripe documents no dedicated error code for it, so the parameter
 * and the wording are read here, and only here: the message is never kept.
 */
function alreadyExists(error: Json): boolean {
  if (error.code === "resource_already_exists") return true;
  return error.param === "code" && typeof error.message === "string" &&
    /already exists/i.test(error.message);
}

/** The Stripe calls on one platform key. Create one per request or run. */
export class ConnectedStripe {
  constructor(
    private readonly platformKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** One POST on the connected account. Every POST carries an Idempotency-Key. */
  async post(
    account: string,
    path: string,
    params: FormParams,
    idempotencyKey: string,
  ): Promise<Json> {
    if (!STRIPE_IDS.account.test(account)) throw new ConfigurationError();
    if (!/^[A-Za-z0-9_:.-]{8,255}$/.test(idempotencyKey)) {
      throw new ConfigurationError();
    }
    let response: Response;
    try {
      response = await this.fetcher(`${API}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.platformKey}`,
          "Stripe-Version": STRIPE_API_VERSION,
          "Stripe-Account": account,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": idempotencyKey,
        },
        body: new URLSearchParams(params.map(([k, v]) => [k, v])),
        redirect: "error",
        signal: stripeRequestSignal(),
      });
    } catch {
      throw new ConnectedStripeError("unavailable", "stripe_unreachable");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.ok) {
      if (!isPlainObject(body)) unreadable();
      return body as Json;
    }
    const error = isPlainObject(body) && isPlainObject(body.error)
      ? body.error
      : {};
    if (response.status === 401) {
      throw new ConnectedStripeError("configuration", "stripe_key_rejected");
    }
    if (response.status === 403) {
      throw new ConnectedStripeError("account", "stripe_account_denied");
    }
    if (
      response.status === 409 || response.status === 429 ||
      response.status >= 500 || response.status < 400
    ) {
      throw new ConnectedStripeError("unavailable", "stripe_unavailable");
    }
    const code = typeof error.code === "string" && CODE.test(error.code)
      ? error.code
      : "stripe_rejected";
    throw new ConnectedStripeError("rejected", code, alreadyExists(error));
  }

  /**
   * A hosted Checkout page on the merchant's account. The URL handed to a
   * browser must be https on the default port with no user info. Its host is
   * not pinned: a merchant may serve Stripe Checkout on their own domain.
   */
  async createCheckoutSession(
    account: string,
    params: FormParams,
    idempotencyKey: string,
    mode: "payment" | "subscription",
  ): Promise<{ id: string; url: string }> {
    const body = await this.post(
      account,
      "/checkout/sessions",
      params,
      idempotencyKey,
    );
    if (body.livemode !== true || body.mode !== mode) unreadable();
    const id = identifier(body.id, STRIPE_IDS.session);
    if (typeof body.url !== "string") unreadable();
    let url: URL;
    try {
      url = new URL(body.url as string);
    } catch {
      unreadable();
    }
    // https, the default port, and nothing before the host (no user info).
    if (
      url!.protocol !== "https:" || url!.port !== "" ||
      !url!.href.startsWith(`${url!.origin}/`)
    ) unreadable();
    return { id, url: url!.href };
  }

  /**
   * A percent-off coupon. `duration: once` discounts the first payment only:
   * the whole price of a one-time product, the first invoice of a
   * subscription.
   */
  async createCoupon(
    account: string,
    input: { discountBps: number; programId: string },
    idempotencyKey: string,
  ): Promise<string> {
    const percent = percentOff(input.discountBps);
    const body = await this.post(account, "/coupons", [
      ["percent_off", percent],
      ["duration", "once"],
      ["name", `${percent}% off`],
      ["metadata[kma_program_id]", input.programId],
    ], idempotencyKey);
    if (
      body.object !== "coupon" || body.livemode !== true ||
      Number(body.percent_off) !== Number(percent)
    ) unreadable();
    return identifier(body.id, STRIPE_IDS.coupon);
  }

  /** The creator's promotion code, pointing at the coupon. */
  async createPromotionCode(
    account: string,
    input: {
      couponId: string;
      code: string;
      codeId: string;
      programId: string;
    },
    idempotencyKey: string,
  ): Promise<string> {
    const body = await this.post(account, "/promotion_codes", [
      // Since API version 2025-09-30 a promotion code names its coupon
      // through `promotion`, not a top-level `coupon`.
      ["promotion[type]", "coupon"],
      ["promotion[coupon]", input.couponId],
      ["code", input.code],
      ["metadata[kma_promo_code_id]", input.codeId],
      ["metadata[kma_program_id]", input.programId],
    ], idempotencyKey);
    if (
      body.object !== "promotion_code" || body.livemode !== true ||
      body.active !== true || typeof body.code !== "string" ||
      body.code.toUpperCase() !== input.code.toUpperCase()
    ) unreadable();
    return identifier(body.id, STRIPE_IDS.promotionCode);
  }

  /** Switches a promotion code off. Buyers can no longer use it. */
  async deactivatePromotionCode(
    account: string,
    promotionCodeId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const body = await this.post(
      account,
      `/promotion_codes/${
        identifier(promotionCodeId, STRIPE_IDS.promotionCode)
      }`,
      [["active", "false"]],
      idempotencyKey,
    );
    if (
      body.object !== "promotion_code" || body.id !== promotionCodeId ||
      body.active !== false
    ) unreadable();
  }
}

/** 1000 basis points is "10"; 1250 is "12.5". */
export function percentOff(discountBps: number): string {
  if (
    !Number.isSafeInteger(discountBps) || discountBps < 100 ||
    discountBps > 9000
  ) throw new ConfigurationError();
  return String(discountBps / 100);
}
