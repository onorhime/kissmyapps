// The two database functions of the promo code worker, read field by field.
// Every assumption about claim_program_promo_codes and
// finish_program_promo_code lives in this file: the RPC argument name, the
// claim's answer and the four finish shapes.
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";
import { STRIPE_IDS } from "../program-checkout/stripe.ts";

type Json = Record<string, unknown>;

export const CLAIM_FUNCTION = "claim_program_promo_codes";
export const FINISH_FUNCTION = "finish_program_promo_code";
export const RPC_ARGUMENT = "p_input";

/** A pending code to make on the merchant's Stripe account. */
export interface CodeToMake {
  id: string;
  code: string;
  accountId: string;
  discountBps: number;
  /** The coupon an earlier code of the program and discount already uses. */
  couponId: string | null;
  programId: string;
}

/** A retired code to switch off at Stripe. */
export interface CodeToRetire {
  id: string;
  accountId: string;
  /** null: it never reached Stripe, so there is nothing to switch off. */
  promotionCodeId: string | null;
}

export interface PromoClaim {
  codes: CodeToMake[];
  deactivate: CodeToRetire[];
}

/** How one claimed code ends, as the worker reports it. */
export type PromoFinish =
  | { id: string; kind: "made"; couponId: string; promotionCodeId: string }
  | { id: string; kind: "deactivated" }
  | { id: string; kind: "error"; error: string };

export interface PromoStore {
  claim(limit: number): Promise<PromoClaim>;
  /** True when the database gave the code up (no more attempts). */
  finish(outcome: PromoFinish): Promise<{ gaveUp: boolean }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[A-Z0-9]{3,20}$/;

/** What claim_program_promo_codes is asked. */
export function claimInput(limit: number): Json {
  return { limit };
}

/** What finish_program_promo_code is asked, for each way a code ends. */
export function finishInput(outcome: PromoFinish): Json {
  switch (outcome.kind) {
    case "made":
      return {
        id: outcome.id,
        coupon_id: outcome.couponId,
        promotion_code_id: outcome.promotionCodeId,
      };
    case "deactivated":
      return { id: outcome.id, deactivated: true };
    case "error":
      // Also sent for a retired code Stripe would not switch off: the
      // contract names no shape for that case.
      return { id: outcome.id, error: outcome.error };
  }
}

/** finish_program_promo_code's answer: only a final "failed" is read. */
export function parseFinish(value: unknown): { gaveUp: boolean } {
  if (!isPlainObject(value)) throw new DatabaseBoundaryError();
  return { gaveUp: value.status === "failed" || value.state === "failed" };
}

export function parseClaim(value: unknown): PromoClaim {
  const invalid = (): never => {
    throw new DatabaseBoundaryError();
  };
  if (!isPlainObject(value) || !Array.isArray(value.codes)) return invalid();
  const retiring = value.deactivate ?? [];
  if (!Array.isArray(retiring)) return invalid();
  const codes = value.codes.map((row: unknown): CodeToMake => {
    if (!isPlainObject(row)) return invalid();
    const coupon = row.coupon_id ?? null;
    if (
      typeof row.id !== "string" || !UUID.test(row.id) ||
      typeof row.code !== "string" || !CODE.test(row.code) ||
      typeof row.account_id !== "string" ||
      !STRIPE_IDS.account.test(row.account_id) ||
      typeof row.discount_bps !== "number" ||
      !Number.isSafeInteger(row.discount_bps) || row.discount_bps < 100 ||
      row.discount_bps > 9000 ||
      (coupon !== null &&
        (typeof coupon !== "string" || !STRIPE_IDS.coupon.test(coupon))) ||
      typeof row.program_id !== "string" || !UUID.test(row.program_id)
    ) return invalid();
    return {
      id: row.id,
      code: row.code,
      accountId: row.account_id,
      discountBps: row.discount_bps,
      couponId: coupon as string | null,
      programId: row.program_id,
    };
  });
  const deactivate = retiring.map((row: unknown): CodeToRetire => {
    if (!isPlainObject(row)) return invalid();
    const promotion = row.promotion_code_id ?? null;
    if (
      typeof row.id !== "string" || !UUID.test(row.id) ||
      typeof row.account_id !== "string" ||
      !STRIPE_IDS.account.test(row.account_id) ||
      (promotion !== null &&
        (typeof promotion !== "string" ||
          !STRIPE_IDS.promotionCode.test(promotion)))
    ) return invalid();
    return {
      id: row.id,
      accountId: row.account_id,
      promotionCodeId: promotion as string | null,
    };
  });
  return { codes, deactivate };
}

export function databasePromoStore(): PromoStore {
  const client = serviceClient(10_000);
  const call = async (name: string, input: Json): Promise<unknown> => {
    const { data, error } = await client.rpc(name, { [RPC_ARGUMENT]: input });
    if (error) throw new DatabaseBoundaryError(error.code);
    return data as unknown;
  };
  return {
    claim: async (limit) =>
      parseClaim(await call(CLAIM_FUNCTION, claimInput(limit))),
    finish: async (outcome) =>
      parseFinish(await call(FINISH_FUNCTION, finishInput(outcome))),
  };
}
