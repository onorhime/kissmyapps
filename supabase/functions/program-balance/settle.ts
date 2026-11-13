// Settlement shared by the balance webhook and the balance worker. Whatever
// brought a PaymentIntent to attention (an event, the worker's own charge, a
// periodic check), the same steps follow: read the PaymentIntent back from
// Stripe, find its top-up, and hand the database exactly what Stripe says. The
// database adds the money once and only for the exact amount, currency and
// customer; running this twice, or from two places at once, changes nothing.
import {
  type BalanceStore,
  isOpen,
  type Json,
  parseTopup,
  StoreRejection,
  type Topup,
} from "./store.ts";
import {
  type BalanceStripe,
  type IntentFacts,
  type SetupFacts,
  StripeCallError,
} from "./stripe.ts";

export interface SettleContext {
  store: BalanceStore;
  stripe: BalanceStripe;
  platformAccountId: string;
  /** Codes and top-up ids only: never names, card details or Stripe bodies. */
  note: (
    level: "info" | "warning" | "error",
    outcome: string,
    topupId?: string,
  ) => void;
}

export type Settled =
  /** The money was added to the balance now. */
  | "credited"
  /** The top-up was closed before; nothing changed. */
  | "already_settled"
  /** Closed now as failed (an automatic top-up counts it). */
  | "failed"
  /** Closed now without counting anything. */
  | "canceled"
  /** Still open: to be looked at again. */
  | "pending"
  /** Stripe's payment is not what the top-up asked for. Nothing was added. */
  | "mismatch"
  /** Not a balance top-up of this platform account. */
  | "not_topup"
  | "not_live";

export interface SettleResult {
  outcome: Settled;
  topupId: string | null;
}

function mismatch(error: unknown): boolean {
  return error instanceof StoreRejection && error.reason === "topup_mismatch";
}

/** Closes an open top-up without adding anything. */
export async function closeTopup(
  ctx: SettleContext,
  topup: Topup,
  outcome: "failed" | "canceled",
  code: string,
  intentId?: string | null,
): Promise<void> {
  await ctx.store.call("settle_program_topup", {
    topup_id: topup.topupId,
    outcome,
    failure_code: code,
    ...(intentId ? { payment_intent_id: intentId } : {}),
  });
}

/** Removes a replaced card from the customer at Stripe. Never fails the caller. */
export async function detachReplaced(
  ctx: SettleContext,
  answer: Json,
  topupId?: string,
): Promise<void> {
  const replaced = answer.replaced_payment_method_id;
  if (typeof replaced !== "string") return;
  try {
    await ctx.stripe.detachCard(replaced);
  } catch (error) {
    if (error instanceof StripeCallError && error.kind === "configuration") {
      throw error;
    }
    ctx.note("warning", "replaced_card_not_detached", topupId);
  }
}

async function credit(
  ctx: SettleContext,
  topup: Topup,
  intent: IntentFacts,
): Promise<SettleResult> {
  const result = (outcome: Settled): SettleResult => ({
    outcome,
    topupId: topup.topupId,
  });
  // The exact payment the top-up asked for, from the customer it belongs to,
  // received in full. Anything else is left for a person to look at.
  if (
    intent.amountMinor !== topup.amountMinor ||
    intent.receivedMinor !== topup.amountMinor ||
    intent.currency !== topup.currency ||
    intent.customerId === null || intent.customerId !== topup.customerId
  ) {
    ctx.note("error", "topup_mismatch", topup.topupId);
    return result("mismatch");
  }
  let answer: Json;
  try {
    answer = await ctx.store.call("settle_program_topup", {
      topup_id: topup.topupId,
      outcome: "succeeded",
      payment_intent_id: intent.id,
      livemode: intent.livemode,
      amount_minor: intent.receivedMinor,
      currency: intent.currency.toLowerCase(),
      customer_id: intent.customerId,
      ...(intent.card ? { card: intent.card } : {}),
    });
  } catch (error) {
    if (!mismatch(error)) throw error;
    ctx.note("error", "topup_mismatch", topup.topupId);
    return result("mismatch");
  }
  await detachReplaced(ctx, answer, topup.topupId);
  // Refunded before it was ever settled here: take the same amount back out.
  if (intent.refundedMinor > 0) {
    await ctx.store.call("reverse_program_topup", {
      payment_intent_id: intent.id,
      reason: "refunded",
      refunded_minor: intent.refundedMinor,
    });
  }
  return result(answer.changed === true ? "credited" : "already_settled");
}

/**
 * Brings the top-up of one PaymentIntent in line with what Stripe says now.
 * The PaymentIntent is always read back from Stripe: no event body and no
 * earlier answer is trusted for the amount, currency, customer or status.
 */
export async function reconcileIntent(
  ctx: SettleContext,
  intentId: string,
): Promise<SettleResult> {
  const intent = await ctx.stripe.intent(intentId);
  if (!intent.livemode) return { outcome: "not_live", topupId: null };
  const found = await ctx.store.call("find_program_topup", {
    payment_intent_id: intent.id,
    ...(intent.topupId ? { topup_id: intent.topupId } : {}),
  });
  if (found.found !== true) {
    if (found.conflict === true) {
      ctx.note("error", "topup_conflict", intent.topupId ?? undefined);
      return { outcome: "mismatch", topupId: null };
    }
    return { outcome: "not_topup", topupId: null };
  }
  const topup = parseTopup(found);
  if (topup.platformAccountId !== ctx.platformAccountId) {
    return { outcome: "not_topup", topupId: null };
  }
  const result = (outcome: Settled): SettleResult => ({
    outcome,
    topupId: topup.topupId,
  });
  if (intent.status === "succeeded") return await credit(ctx, topup, intent);
  if (!isOpen(topup)) return result("already_settled");

  if (topup.paymentIntentId === null) {
    try {
      await ctx.store.call("attach_program_topup", {
        topup_id: topup.topupId,
        payment_intent_id: intent.id,
      });
    } catch (error) {
      if (!mismatch(error)) throw error;
      ctx.note("error", "topup_conflict", topup.topupId);
      return result("mismatch");
    }
  }

  if (intent.status === "canceled") {
    // A canceled PaymentIntent can never succeed.
    if (topup.kind === "auto") {
      await closeTopup(
        ctx,
        topup,
        "failed",
        intent.failureCode ?? "payment_canceled",
        intent.id,
      );
      return result("failed");
    }
    await closeTopup(ctx, topup, "canceled", "payment_canceled", intent.id);
    return result("canceled");
  }

  if (
    intent.status === "requires_payment_method" ||
    intent.status === "requires_action" ||
    intent.status === "requires_confirmation"
  ) {
    // On Stripe's page the merchant can still try another card.
    if (topup.kind === "deposit") return result("pending");
    // An automatic top-up has nobody present to act. The PaymentIntent is
    // ended first, so it can never succeed later; only then is the failure
    // counted.
    let canceled: boolean;
    try {
      canceled = await ctx.stripe.cancelIntent(intent.id, topup.topupId);
    } catch (error) {
      if (error instanceof StripeCallError && error.kind === "configuration") {
        throw error;
      }
      ctx.note("warning", "payment_not_canceled", topup.topupId);
      return result("pending");
    }
    if (!canceled) return result("pending");
    await closeTopup(
      ctx,
      topup,
      "failed",
      intent.status === "requires_action"
        ? "authentication_required"
        : intent.failureCode ?? "payment_failed",
      intent.id,
    );
    return result("failed");
  }
  // processing, or a status this code does not know: wait.
  return result("pending");
}

/**
 * Takes a refunded card payment back out of the balance. refundedMinor is the
 * total Stripe says has been refunded so far; the database moves the balance
 * by what is new in it.
 */
export async function reverseRefund(
  ctx: SettleContext,
  intentId: string,
  refundedMinor: number,
): Promise<Json> {
  return await ctx.store.call("reverse_program_topup", {
    payment_intent_id: intentId,
    reason: "refunded",
    refunded_minor: refundedMinor,
  });
}

/** Saves the card of a finished card change. False: there was nothing to save. */
export async function saveCard(
  ctx: SettleContext,
  setup: SetupFacts,
): Promise<"saved" | "unchanged" | "not_saved"> {
  if (
    !setup.livemode || setup.status !== "succeeded" || !setup.card ||
    !setup.customerId || !setup.accountId
  ) return "not_saved";
  let answer: Json;
  try {
    answer = await ctx.store.call("save_program_balance_card", {
      account_id: setup.accountId,
      customer_id: setup.customerId,
      card: setup.card,
    });
  } catch (error) {
    // Another customer's card, or an account that is gone: nothing is saved.
    if (error instanceof StoreRejection) {
      ctx.note("error", error.reason);
      return "not_saved";
    }
    throw error;
  }
  await detachReplaced(ctx, answer);
  return answer.changed === true ? "saved" : "unchanged";
}
