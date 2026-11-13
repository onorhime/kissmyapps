// What program_checkout_target answers, read field by field. Every assumption
// about the database function's shape lives in this file: the RPC argument
// name, the answer's keys and the refusal reasons.
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import { isPlainObject } from "../_shared/validation.ts";
import { STRIPE_IDS } from "./stripe.ts";

/** The database function and the name of its one jsonb argument. */
export const TARGET_FUNCTION = "program_checkout_target";
export const RPC_ARGUMENT = "p_input";

/** A creator click id, as the tracking redirect makes it and the sales worker reads it. */
export const CLICK_ID = /^[A-Za-z0-9_-]{16,128}$/;
/** A program's public key: its marketplace slug, or its id. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isProgramKey(value: string): boolean {
  return (value.length >= 2 && value.length <= 80 && SLUG.test(value)) ||
    UUID.test(value);
}

/** What the function is asked: the program's public key and the click, if any. */
export function targetInput(
  program: string,
  click: string | null,
): Record<string, unknown> {
  return { program, click };
}

export interface CheckoutProduct {
  name: string;
  amountMinor: number;
  /** null: a one-time payment. */
  interval: "month" | "year" | null;
}

export interface CheckoutTarget {
  ok: true;
  accountId: string;
  /** Lower case, as Stripe takes it. */
  currency: string;
  product: CheckoutProduct;
  successUrl: string;
  cancelUrl: string;
  /** The click, once the database has checked it belongs to this program. */
  click: string | null;
  /** The click's creator's active code, applied for the buyer. */
  promotionCodeId: string | null;
  programName: string;
  /**
   * Whether the program gives buyers a discount with creator codes. The
   * contract's answer does not name it; read from `buyer_discount_bps` when
   * the function adds it, otherwise a checkout without a creator code does
   * not offer a code field.
   */
  codesOffered: boolean;
}

export type RefusalReason =
  | "not_found"
  | "not_live"
  | "paused"
  | "no_connection";
export type TargetAnswer = CheckoutTarget | {
  ok: false;
  reason: RefusalReason;
};

const REASONS: readonly RefusalReason[] = [
  "not_found",
  "not_live",
  "paused",
  "no_connection",
];

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}

/**
 * An https address, passed on as written: normalizing it could encode the
 * braces of Stripe's {CHECKOUT_SESSION_ID} placeholder.
 */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    // No spaces or control characters: the address goes to Stripe as is.
    if (unit <= 0x20 || unit === 0x7f) return null;
  }
  try {
    const url = new URL(value);
    // https, and nothing before the host (no user info).
    return url.protocol === "https:" && url.href.startsWith(`${url.origin}/`)
      ? value
      : null;
  } catch {
    return null;
  }
}

/** An answer that is not the agreed shape is never acted on. */
export function parseTarget(value: unknown): TargetAnswer {
  const invalid = (): never => {
    throw new DatabaseBoundaryError();
  };
  if (!isPlainObject(value)) return invalid();
  if (value.ok === false) {
    const reason = REASONS.find((known) => known === value.reason);
    return reason ? { ok: false, reason } : invalid();
  }
  if (value.ok !== true) return invalid();
  const product = isPlainObject(value.product) ? value.product : null;
  const name = text(product?.name, 250);
  const amount = product?.amount_minor;
  const interval = product?.interval ?? null;
  const currency = typeof value.currency === "string" &&
      /^[A-Za-z]{3}$/.test(value.currency)
    ? value.currency.toLowerCase()
    : null;
  const successUrl = httpsUrl(value.success_url);
  const cancelUrl = httpsUrl(value.cancel_url);
  const click = value.click ?? null;
  const promotionCodeId = value.promotion_code_id ?? null;
  const discount = value.buyer_discount_bps ?? null;
  if (
    typeof value.account_id !== "string" ||
    !STRIPE_IDS.account.test(value.account_id) ||
    currency === null || name === null ||
    typeof amount !== "number" || !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    (interval !== null && interval !== "month" && interval !== "year") ||
    successUrl === null || cancelUrl === null ||
    (click !== null && (typeof click !== "string" || !CLICK_ID.test(click))) ||
    (promotionCodeId !== null &&
      (typeof promotionCodeId !== "string" ||
        !STRIPE_IDS.promotionCode.test(promotionCodeId))) ||
    (discount !== null &&
      (typeof discount !== "number" || !Number.isSafeInteger(discount) ||
        discount < 100 || discount > 9000))
  ) return invalid();
  return {
    ok: true,
    accountId: value.account_id,
    currency,
    product: {
      name,
      amountMinor: amount,
      interval: interval as CheckoutProduct["interval"],
    },
    successUrl,
    cancelUrl,
    click: click as string | null,
    promotionCodeId: promotionCodeId as string | null,
    programName: text(value.program_name, 200) ?? name,
    codesOffered: discount !== null,
  };
}
