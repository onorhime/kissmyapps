// Stripe events of the KissMyApps platform's own live account, for the prepaid
// balances of affiliate programs: a deposit paid on Stripe's Checkout page, a
// new card saved there, an automatic top-up that succeeded or failed, a
// Checkout page that expired, a refund, a lost dispute.
//
// An event is only a prompt. Its signature is checked with this endpoint's own
// signing value, test-mode events are refused, and then the object is read
// back from Stripe before anything is settled: the database adds money to a
// balance only for the exact amount, currency and customer of the top-up, and
// only once, however often or in whatever order events arrive. Events about
// anything that is not a balance top-up are acknowledged and ignored.
// Off unless PROGRAM_BALANCE_ENABLED is exactly "true". Logs carry outcome
// codes, event ids and top-up ids only.
import {
  ConfigurationError,
  DatabaseBoundaryError,
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
import {
  stripeSignedBodySha256,
  verifyStripeSignature,
} from "../_shared/stripe.ts";
import { isPlainObject } from "../_shared/validation.ts";
import {
  type ProgramBalanceConfig,
  programBalanceConfig,
  programBalanceEnabled,
} from "../program-balance/config.ts";
import {
  closeTopup,
  reconcileIntent,
  reverseRefund,
  saveCard,
  type SettleContext,
} from "../program-balance/settle.ts";
import {
  type BalanceStore,
  databaseBalanceStore,
  isOpen,
  type Json,
  parseTopup,
  StoreRejection,
} from "../program-balance/store.ts";
import {
  BalanceStripe,
  STRIPE_ID,
  StripeCallError,
} from "../program-balance/stripe.ts";

const WORKER = "program-balance-webhook";
const MAXIMUM_BODY_BYTES = 1024 * 1024;
const FUTURE_TOLERANCE_SECONDS = 300;
const EVENT_ID = /^evt_[A-Za-z0-9_]{3,251}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.]{1,120}$/;
const OBJECT_ID = /^[A-Za-z0-9_]{3,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Exactly the events to subscribe the endpoint to. */
export const BALANCE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.closed",
] as const;

export interface BalanceWebhookLogEntry {
  level: "info" | "warning" | "error";
  worker: typeof WORKER;
  outcome: string;
  request_id: string;
  event_id?: string;
  event_type?: string;
  topup_id?: string;
  database_code?: string;
}

export interface ProgramBalanceWebhookDependencies {
  enabled: () => boolean;
  /** This endpoint's signing value, from PROGRAM_BALANCE_WEBHOOK_SIGNING. */
  signing: () => string | undefined;
  config: () => ProgramBalanceConfig;
  store: () => BalanceStore;
  fetcher: typeof fetch;
  now: () => number;
  log: (entry: BalanceWebhookLogEntry) => void;
}

function defaults(): ProgramBalanceWebhookDependencies {
  return {
    enabled: programBalanceEnabled,
    signing: () => Deno.env.get("PROGRAM_BALANCE_WEBHOOK_SIGNING")?.trim(),
    config: programBalanceConfig,
    store: databaseBalanceStore,
    fetcher: fetch,
    now: Date.now,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

function invalidEvent(): never {
  throw new RequestError(400, "invalid_event", "Webhook payload is invalid.");
}

/** How one event ended: a code for the receipt, and the top-up it touched. */
interface Handled {
  outcome: string;
  topupId?: string | null;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}
function stripeId(value: unknown, pattern: RegExp): string | null {
  const id = isPlainObject(value) ? value.id : value;
  return typeof id === "string" && pattern.test(id) ? id : null;
}

/** A Checkout Session that finished: a paid deposit, or a newly saved card. */
async function sessionCompleted(
  ctx: SettleContext,
  session: Json,
): Promise<Handled> {
  const sessionId = stripeId(session.id, STRIPE_ID.session);
  if (!sessionId) invalidEvent();
  const metadata = isPlainObject(session.metadata) ? session.metadata : {};

  if (session.mode === "setup") {
    const setupIntentId = stripeId(session.setup_intent, STRIPE_ID.setupIntent);
    if (metadata.kma_kind !== "card" || !setupIntentId) {
      return { outcome: "ignored_not_balance" };
    }
    // The card is taken from the SetupIntent as Stripe reports it now.
    const setup = await ctx.stripe.setupIntent(setupIntentId);
    if (!setup.livemode) return { outcome: "ignored_not_live" };
    if (
      setup.accountId === null ||
      setup.accountId !== uuid(metadata.kma_account_id)
    ) return { outcome: "ignored_not_balance" };
    const saved = await saveCard(ctx, setup);
    return { outcome: `card_${saved}` };
  }
  if (session.mode !== "payment") return { outcome: "ignored_not_balance" };

  const intentId = stripeId(session.payment_intent, STRIPE_ID.intent);
  const found = await ctx.store.call("find_program_topup", {
    checkout_session_id: sessionId,
    ...(uuid(session.client_reference_id)
      ? { topup_id: session.client_reference_id }
      : {}),
  });
  if (found.found !== true) {
    if (found.conflict !== true) return { outcome: "ignored_not_balance" };
    ctx.note("error", "topup_conflict");
    return { outcome: "mismatch" };
  }
  const topup = parseTopup(found);
  if (topup.platformAccountId !== ctx.platformAccountId) {
    return { outcome: "ignored_not_balance" };
  }
  if (!intentId) return { outcome: "pending", topupId: topup.topupId };
  try {
    await ctx.store.call("attach_program_topup", {
      topup_id: topup.topupId,
      checkout_session_id: sessionId,
      payment_intent_id: intentId,
    });
  } catch (error) {
    if (
      !(error instanceof StoreRejection && error.reason === "topup_mismatch")
    ) throw error;
    ctx.note("error", "topup_conflict", topup.topupId);
    return { outcome: "mismatch", topupId: topup.topupId };
  }
  return await reconcileIntent(ctx, intentId);
}

/** A Checkout page nobody paid on in time: its deposit is closed. */
async function sessionExpired(
  ctx: SettleContext,
  session: Json,
): Promise<Handled> {
  const sessionId = stripeId(session.id, STRIPE_ID.session);
  if (!sessionId) invalidEvent();
  if (session.mode !== "payment") return { outcome: "ignored_not_balance" };
  const found = await ctx.store.call("find_program_topup", {
    checkout_session_id: sessionId,
    ...(uuid(session.client_reference_id)
      ? { topup_id: session.client_reference_id }
      : {}),
  });
  if (found.found !== true) {
    return {
      outcome: found.conflict === true ? "mismatch" : "ignored_not_balance",
    };
  }
  let topup = parseTopup(found);
  if (topup.platformAccountId !== ctx.platformAccountId) {
    return { outcome: "ignored_not_balance" };
  }
  const handled = (outcome: string): Handled => ({
    outcome,
    topupId: topup.topupId,
  });
  if (!isOpen(topup)) return handled("already_settled");
  // A payment was started on the page: what became of it decides first.
  const intentId = topup.paymentIntentId ??
    stripeId(session.payment_intent, STRIPE_ID.intent);
  if (intentId) {
    const settled = await reconcileIntent(ctx, intentId);
    if (settled.outcome !== "pending") return settled;
    topup = parseTopup(
      await ctx.store.call("find_program_topup", { topup_id: topup.topupId }),
    );
    if (!isOpen(topup)) return handled("already_settled");
  }
  await closeTopup(ctx, topup, "canceled", "checkout_expired");
  return handled("canceled");
}

/** A PaymentIntent succeeded or failed. Only top-up payments go any further. */
async function intentChanged(
  ctx: SettleContext,
  intent: Json,
): Promise<Handled> {
  const intentId = stripeId(intent.id, STRIPE_ID.intent);
  if (!intentId) invalidEvent();
  // The platform account takes other payments too. Without a top-up there is
  // nothing to read back from Stripe.
  const topupId = isPlainObject(intent.metadata)
    ? uuid(intent.metadata.kma_topup_id)
    : null;
  const found = await ctx.store.call("find_program_topup", {
    payment_intent_id: intentId,
    ...(topupId ? { topup_id: topupId } : {}),
  });
  if (found.found !== true && found.conflict !== true) {
    return { outcome: "ignored_not_balance" };
  }
  return await reconcileIntent(ctx, intentId);
}

/** Money of a card payment went back to the card: the balance follows. */
async function chargeRefunded(
  ctx: SettleContext,
  charge: Json,
): Promise<Handled> {
  const chargeId = stripeId(charge.id, STRIPE_ID.charge);
  const intentId = stripeId(charge.payment_intent, STRIPE_ID.intent);
  if (!chargeId) invalidEvent();
  if (!intentId) return { outcome: "ignored_not_balance" };
  const found = await ctx.store.call("find_program_topup", {
    payment_intent_id: intentId,
  });
  if (found.found !== true) return { outcome: "ignored_not_balance" };
  const topup = parseTopup(found);
  if (topup.platformAccountId !== ctx.platformAccountId) {
    return { outcome: "ignored_not_balance" };
  }
  // The refunded total is taken from the charge as Stripe reports it now.
  const fresh = await ctx.stripe.charge(chargeId);
  if (!fresh.livemode) return { outcome: "ignored_not_live" };
  if (fresh.paymentIntentId !== intentId) {
    ctx.note("error", "charge_mismatch", topup.topupId);
    return { outcome: "mismatch", topupId: topup.topupId };
  }
  // A refund that overtook the payment's own event: settle the payment first.
  if (isOpen(topup)) {
    const settled = await reconcileIntent(ctx, intentId);
    if (settled.outcome === "mismatch") return settled;
  }
  const answer = await reverseRefund(ctx, intentId, fresh.refundedMinor);
  return {
    outcome: answer.changed === true ? "reversed" : "nothing_to_reverse",
    topupId: topup.topupId,
  };
}

/** A dispute over a card payment ended. Only a lost one moves the balance. */
async function disputeClosed(
  ctx: SettleContext,
  dispute: Json,
): Promise<Handled> {
  const disputeId = stripeId(dispute.id, STRIPE_ID.dispute);
  const intentId = stripeId(dispute.payment_intent, STRIPE_ID.intent);
  if (!disputeId) invalidEvent();
  if (dispute.status !== "lost" || !intentId) {
    return { outcome: "ignored_dispute_not_lost" };
  }
  const found = await ctx.store.call("find_program_topup", {
    payment_intent_id: intentId,
  });
  if (found.found !== true) return { outcome: "ignored_not_balance" };
  const topup = parseTopup(found);
  if (topup.platformAccountId !== ctx.platformAccountId) {
    return { outcome: "ignored_not_balance" };
  }
  const fresh = await ctx.stripe.dispute(disputeId);
  if (!fresh.livemode) return { outcome: "ignored_not_live" };
  if (fresh.status !== "lost") return { outcome: "ignored_dispute_not_lost" };
  if (fresh.paymentIntentId !== intentId) {
    ctx.note("error", "dispute_mismatch", topup.topupId);
    return { outcome: "mismatch", topupId: topup.topupId };
  }
  if (isOpen(topup)) {
    const settled = await reconcileIntent(ctx, intentId);
    if (settled.outcome === "mismatch") return settled;
  }
  const answer = await ctx.store.call("reverse_program_topup", {
    payment_intent_id: intentId,
    reason: "dispute_lost",
  });
  return {
    outcome: answer.changed === true ? "reversed" : "nothing_to_reverse",
    topupId: topup.topupId,
  };
}

const HANDLERS: Record<
  (typeof BALANCE_EVENTS)[number],
  (ctx: SettleContext, object: Json) => Promise<Handled>
> = {
  "checkout.session.completed": sessionCompleted,
  "checkout.session.expired": sessionExpired,
  "payment_intent.succeeded": intentChanged,
  "payment_intent.payment_failed": intentChanged,
  "charge.refunded": chargeRefunded,
  "charge.dispute.closed": disputeClosed,
};

export function createProgramBalanceWebhook(
  overrides: Partial<ProgramBalanceWebhookDependencies> = {},
) {
  const deps: ProgramBalanceWebhookDependencies = {
    ...defaults(),
    ...overrides,
  };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    // Only values that passed their format check are ever logged.
    const seen: { event_id?: string; event_type?: string } = {};
    const answer = (
      outcome: string,
      body: Json,
      topupId?: string | null,
    ): Response => {
      deps.log({
        level: outcome === "mismatch" ? "error" : "info",
        worker: WORKER,
        outcome,
        request_id: rid,
        ...seen,
        ...(topupId ? { topup_id: topupId } : {}),
      });
      return jsonResponse(200, { received: true, ...body, request_id: rid }, {
        "X-Request-ID": rid,
      });
    };
    try {
      requireMethod(request, ["POST"]);
      requireJsonContentType(request);
      if (request.headers.has("origin")) {
        throw new RequestError(
          403,
          "browser_request_rejected",
          "Provider authentication is required.",
        );
      }
      if (!deps.enabled()) {
        throw new RequestError(
          503,
          "program_balance_disabled",
          "This provider endpoint is not enabled.",
        );
      }
      const signing = deps.signing() ?? "";
      if (!/^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(signing)) {
        throw new ConfigurationError();
      }
      const config = deps.config();

      const raw = await readRequestBytes(request, MAXIMUM_BODY_BYTES);
      const nowSeconds = Math.floor(deps.now() / 1000);
      await verifyStripeSignature(
        raw,
        request.headers.get("stripe-signature"),
        signing,
        nowSeconds,
      );

      let event: Json;
      try {
        const parsed: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
        );
        if (!isPlainObject(parsed)) throw new Error("not an object");
        event = parsed;
      } catch {
        invalidEvent();
      }
      if (
        typeof event.id !== "string" || !EVENT_ID.test(event.id) ||
        typeof event.type !== "string" || !EVENT_TYPE.test(event.type) ||
        typeof event.livemode !== "boolean"
      ) invalidEvent();
      seen.event_id = event.id;
      seen.event_type = event.type;

      // Balances are live only. A test-mode event means the endpoint or its
      // signing value belongs to test mode: refuse it loudly.
      if (event.livemode !== true) {
        throw new RequestError(
          400,
          "event_not_live",
          "This endpoint accepts live events only.",
        );
      }
      // Balances are charged on the platform's own account. An event of a
      // connected account means the endpoint was registered for the wrong scope.
      if (event.account !== undefined && event.account !== null) {
        throw new RequestError(
          400,
          "event_scope_mismatch",
          "This endpoint accepts events of the platform account only.",
        );
      }
      if (!Object.hasOwn(HANDLERS, event.type)) {
        return answer("ignored_event_type", { ignored: true });
      }
      if (
        typeof event.created !== "number" ||
        !Number.isSafeInteger(event.created) || event.created <= 0 ||
        event.created > nowSeconds + FUTURE_TOLERANCE_SECONDS ||
        !isPlainObject(event.data) || !isPlainObject(event.data.object) ||
        typeof event.data.object.id !== "string" ||
        !OBJECT_ID.test(event.data.object.id)
      ) invalidEvent();
      const object = (event.data as Json).object as Json;
      // The object itself says which mode it belongs to as well.
      if (object.livemode === false) {
        throw new RequestError(
          400,
          "event_not_live",
          "This endpoint accepts live events only.",
        );
      }

      const store = deps.store();
      const receipt = await store.call("record_program_balance_event", {
        event_id: event.id,
        event_type: event.type,
        object_id: object.id,
        payload_sha256: await stripeSignedBodySha256(raw),
        event_created: event.created,
      });
      if (
        typeof receipt.duplicate !== "boolean" ||
        typeof receipt.processed !== "boolean"
      ) throw new DatabaseBoundaryError();
      // Handled to the end before: nothing more to do. An event that was
      // received but not finished is worked again; every step is repeatable.
      if (receipt.processed) return answer("duplicate", { duplicate: true });

      const ctx: SettleContext = {
        store,
        stripe: new BalanceStripe(config.secret, { fetcher: deps.fetcher }),
        platformAccountId: config.platformAccountId,
        note: (level, outcome, topupId) =>
          deps.log({
            level,
            worker: WORKER,
            outcome,
            request_id: rid,
            ...seen,
            ...(topupId ? { topup_id: topupId } : {}),
          }),
      };
      const handled = await HANDLERS[
        event.type as (typeof BALANCE_EVENTS)[number]
      ](ctx, object);
      await store.call("finish_program_balance_event", {
        event_id: event.id,
        outcome: handled.outcome,
        ...(handled.topupId ? { topup_id: handled.topupId } : {}),
      });
      return answer(
        handled.outcome,
        handled.outcome.startsWith("ignored_")
          ? { ignored: true }
          : { duplicate: receipt.duplicate },
        handled.topupId,
      );
    } catch (caught) {
      // Stripe could not be asked: answer with an error so the event is sent
      // again later. The same event id with another signed body is not
      // retryable work.
      const error = caught instanceof StripeCallError
        ? caught.kind === "configuration"
          ? new ConfigurationError()
          : new RequestError(
            502,
            caught.kind === "unavailable"
              ? "stripe_unavailable"
              : "stripe_rejected",
            "Stripe could not be asked about this event.",
          )
        : caught instanceof StoreRejection
        ? new DatabaseBoundaryError(caught.sqlstate)
        : caught instanceof DatabaseBoundaryError &&
            caught.databaseCode === "23505"
        ? new RequestError(
          409,
          "event_id_conflict",
          "Webhook event identity conflicts with prior evidence.",
        )
        : caught;
      const response = errorResponse(error, rid, { "X-Request-ID": rid });
      deps.log({
        level: response.status >= 500 ? "error" : "warning",
        worker: WORKER,
        outcome: error instanceof RequestError ||
            error instanceof DatabaseBoundaryError ||
            error instanceof ConfigurationError
          ? error.code
          : "internal_error",
        request_id: rid,
        ...seen,
        ...(error instanceof DatabaseBoundaryError &&
            /^[0-9A-Z]{5}$/.test(error.databaseCode ?? "")
          ? { database_code: error.databaseCode }
          : {}),
      });
      return response;
    }
  };
}

export const handleProgramBalanceWebhook = createProgramBalanceWebhook();
if (import.meta.main) Deno.serve(handleProgramBalanceWebhook);
