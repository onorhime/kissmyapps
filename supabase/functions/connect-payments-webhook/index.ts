// Stripe Connect webhook: one small receipt per payment, refund and dispute
// event on a connected merchant's live Stripe account. Receipts only: no
// commission, no ledger and no call back to Stripe. Only identifiers, the
// amount, the currency and the creator tag leave this function; names, emails,
// card data and the raw payload are never stored or logged.
//
// After a new receipt of a connected account is stored, the sale worker is
// told there is work (program-sales-worker). That call is never waited for
// and can never change the answer Stripe gets: the receipt is already stored
// and the worker's schedule picks up whatever a lost call left behind.
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
import { requiredEnv, requiredSecret } from "../_shared/env.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";

const WORKER = "connect-payments-webhook";
const SALES_WORKER = "program-sales-worker";
const MAXIMUM_BODY_BYTES = 512 * 1024;
const FUTURE_TOLERANCE_SECONDS = 300;
/** Longer than one run of the sale worker, so the call is not cut short. */
const SALES_WORKER_NUDGE_TIMEOUT_MS = 80_000;

type Json = Record<string, unknown>;
type TagSource = "metadata" | "client_reference_id";

/** What each handled event carries: the Stripe object and its amount field. */
const HANDLED_EVENTS: Readonly<
  Record<string, { object: string; amount: string }>
> = {
  "checkout.session.completed": {
    object: "checkout.session",
    amount: "amount_total",
  },
  "checkout.session.async_payment_succeeded": {
    object: "checkout.session",
    amount: "amount_total",
  },
  "payment_intent.succeeded": {
    object: "payment_intent",
    amount: "amount_received",
  },
  "invoice.paid": { object: "invoice", amount: "amount_paid" },
  "charge.refunded": { object: "charge", amount: "amount_refunded" },
  "refund.created": { object: "refund", amount: "amount" },
  "refund.updated": { object: "refund", amount: "amount" },
  "charge.dispute.created": { object: "dispute", amount: "amount" },
  "charge.dispute.closed": { object: "dispute", amount: "amount" },
};

export const CONNECT_PAYMENT_EVENT_TYPES: readonly string[] = Object.keys(
  HANDLED_EVENTS,
);

const EVENT_ID = /^evt_[A-Za-z0-9_]{3,251}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.]{1,120}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{3,128}$/;
const OBJECT_ID = /^[A-Za-z0-9_]{3,255}$/;
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{1,252}$/;
const CURRENCY = /^[A-Za-z]{3}$/;
const CREATOR_TAG = /^[A-Za-z0-9_-]{8,200}$/;

/** The row handed to record_merchant_payment_event. Nothing else is kept. */
export interface PaymentReceipt {
  platform_account_id: string;
  livemode: true;
  account_id: string;
  event_id: string;
  event_type: string;
  event_created: number;
  object_id: string;
  payment_intent_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  kma_click: string | null;
  tag_source: TagSource | null;
  payload_sha256: string;
}

export interface ReceiptOutcome {
  matched: boolean;
  duplicate: boolean;
}

export interface ConnectPaymentsLogEntry {
  level: "info" | "warning" | "error";
  worker: typeof WORKER;
  outcome: string;
  request_id: string;
  event_id?: string;
  event_type?: string;
  database_code?: string;
}

export interface ConnectPaymentsWebhookDependencies {
  enabled: () => boolean;
  webhookSecret: () => string | undefined;
  platformAccountId: () => string | undefined;
  persist: (receipt: PaymentReceipt) => Promise<ReceiptOutcome>;
  /**
   * Tells the sale worker that a new receipt is waiting. Called once per new
   * receipt of a connected account, never awaited by the webhook; a throw or
   * a rejection is logged and changes nothing else.
   */
  nudgeSalesWorker: (requestId: string) => void | Promise<void>;
  now: () => number;
  log: (entry: ConnectPaymentsLogEntry) => void;
}

function invalidEvent(): never {
  throw new RequestError(400, "invalid_event", "Invalid provider event.");
}

/** A Stripe reference is an id, or the object itself when it was expanded. */
function referenceId(value: unknown): unknown {
  return isPlainObject(value) ? value.id : value;
}

function creatorTag(
  data: Json,
  isCheckoutSession: boolean,
): Pick<PaymentReceipt, "kma_click" | "tag_source"> {
  const metadata = isPlainObject(data.metadata) ? data.metadata : {};
  const tagged = Object.hasOwn(metadata, "kma_click")
    ? metadata.kma_click
    : null;
  if (typeof tagged === "string" && CREATOR_TAG.test(tagged)) {
    return { kma_click: tagged, tag_source: "metadata" };
  }
  const reference = isCheckoutSession ? data.client_reference_id : null;
  if (
    typeof reference === "string" && reference.startsWith("kma_") &&
    CREATOR_TAG.test(reference)
  ) {
    return { kma_click: reference, tag_source: "client_reference_id" };
  }
  return { kma_click: null, tag_source: null };
}

/**
 * Reads the few fields a receipt keeps from the event's object. Everything
 * else in the object, including any customer detail, is left behind.
 */
export function receiptFields(
  eventType: string,
  data: Json,
): Pick<
  PaymentReceipt,
  | "object_id"
  | "payment_intent_id"
  | "amount_minor"
  | "currency"
  | "kma_click"
  | "tag_source"
> {
  const shape = HANDLED_EVENTS[eventType];
  if (
    !shape || data.object !== shape.object || typeof data.id !== "string" ||
    !OBJECT_ID.test(data.id)
  ) invalidEvent();
  const intent = shape.object === "payment_intent"
    ? data.id
    : referenceId(data.payment_intent);
  const amount = data[shape.amount];
  return {
    object_id: data.id,
    payment_intent_id:
      typeof intent === "string" && PAYMENT_INTENT_ID.test(intent)
        ? intent
        : null,
    amount_minor:
      typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0
        ? amount
        : null,
    currency: typeof data.currency === "string" && CURRENCY.test(data.currency)
      ? data.currency.toUpperCase()
      : null,
    ...creatorTag(data, shape.object === "checkout.session"),
  };
}

/**
 * Lets work started by a request outlive its response on Supabase Edge
 * Functions. Elsewhere (tests, local runs) the promise simply runs on.
 */
function keepAlive(work: Promise<unknown>): void {
  const runtime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (work: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (typeof runtime?.waitUntil === "function") runtime.waitUntil(work);
}

/**
 * One POST to the sale worker with the internal worker secret. It does
 * nothing unless sale tracking is switched on, and it carries no receipt
 * data: the worker reads its own queue.
 */
function nudgeSalesWorker(requestId: string): void | Promise<void> {
  if (Deno.env.get("PROGRAM_SALES_ENABLED") !== "true") return;
  const call = fetch(
    `${requiredEnv("SUPABASE_URL")}/functions/v1/${SALES_WORKER}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kma-worker-secret": requiredSecret("INTERNAL_WORKER_SECRET"),
        "x-request-id": requestId,
      },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(SALES_WORKER_NUDGE_TIMEOUT_MS),
    },
  ).then(async (response) => {
    await response.body?.cancel();
    if (!response.ok) throw new Error("sale worker refused the nudge");
  });
  keepAlive(call.catch(() => {}));
  return call;
}

function defaults(): ConnectPaymentsWebhookDependencies {
  return {
    nudgeSalesWorker,
    enabled: () => Deno.env.get("CONNECT_PAYMENTS_WEBHOOK_ENABLED") === "true",
    webhookSecret: () =>
      Deno.env.get("CONNECT_PAYMENTS_WEBHOOK_SECRET")?.trim(),
    platformAccountId: () =>
      Deno.env.get("CONSOLE_CONNECT_PLATFORM_ACCOUNT")?.trim(),
    now: Date.now,
    log: (entry) => console.log(JSON.stringify(entry)),
    persist: async (receipt) => {
      const { data, error } = await serviceClient().rpc(
        "record_merchant_payment_event",
        { p_input: receipt },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return data;
    },
  };
}

export function createConnectPaymentsWebhook(
  overrides: Partial<ConnectPaymentsWebhookDependencies> = {},
) {
  const deps: ConnectPaymentsWebhookDependencies = {
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
    ): Response => {
      deps.log({
        level: "info",
        worker: WORKER,
        outcome,
        request_id: rid,
        ...seen,
      });
      return jsonResponse(200, { received: true, ...body, request_id: rid }, {
        "X-Request-ID": rid,
      });
    };
    // Fire and forget. Whatever the nudge does, the webhook's answer stands.
    const nudge = (): void => {
      const failed = (): void => {
        try {
          deps.log({
            level: "warning",
            worker: WORKER,
            outcome: "sales_worker_nudge_failed",
            request_id: rid,
            ...seen,
          });
        } catch {
          // A log sink that throws must not surface either.
        }
      };
      try {
        Promise.resolve(deps.nudgeSalesWorker(rid)).catch(failed);
      } catch {
        failed();
      }
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
          "connect_payments_webhook_disabled",
          "This provider endpoint is not enabled.",
        );
      }
      const secret = deps.webhookSecret() ?? "";
      const platformAccountId = deps.platformAccountId() ?? "";
      if (
        !/^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(secret) ||
        !ACCOUNT_ID.test(platformAccountId)
      ) throw new ConfigurationError();

      const raw = await readRequestBytes(request, MAXIMUM_BODY_BYTES);
      const nowSeconds = Math.floor(deps.now() / 1000);
      await verifyStripeSignature(
        raw,
        request.headers.get("stripe-signature"),
        secret,
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

      // A live Connect endpoint is also sent the test mode events of connected
      // accounts. Acknowledge them so Stripe does not retry; store nothing.
      if (event.livemode !== true) {
        return answer("ignored_not_live", { ignored: true });
      }
      if (!Object.hasOwn(HANDLED_EVENTS, event.type)) {
        return answer("ignored_event_type", { ignored: true });
      }
      // Receipts belong to connected accounts. An event of the platform's own
      // account means the endpoint was not registered for connected accounts.
      if (
        typeof event.account !== "string" || !ACCOUNT_ID.test(event.account) ||
        event.account === platformAccountId
      ) {
        throw new RequestError(
          400,
          "event_scope_mismatch",
          "This endpoint accepts events of connected accounts only.",
        );
      }
      if (
        typeof event.created !== "number" ||
        !Number.isSafeInteger(event.created) || event.created <= 0 ||
        event.created > nowSeconds + FUTURE_TOLERANCE_SECONDS ||
        !isPlainObject(event.data) || !isPlainObject(event.data.object)
      ) invalidEvent();

      const receipt: PaymentReceipt = {
        platform_account_id: platformAccountId,
        livemode: true,
        account_id: event.account,
        event_id: event.id,
        event_type: event.type,
        event_created: event.created,
        ...receiptFields(event.type, event.data.object),
        payload_sha256: await stripeSignedBodySha256(raw),
      };
      const outcome: unknown = await deps.persist(receipt);
      if (
        !isPlainObject(outcome) || typeof outcome.matched !== "boolean" ||
        typeof outcome.duplicate !== "boolean"
      ) throw new DatabaseBoundaryError();
      // An account nobody connected (or one that disconnected) is not an error.
      if (!outcome.matched) {
        return answer("ignored_unmatched_account", { ignored: true });
      }
      if (outcome.duplicate) return answer("duplicate", { duplicate: true });
      nudge();
      return answer("recorded", { duplicate: false });
    } catch (caught) {
      // The same event id with a different signed body is not retryable work.
      const error = caught instanceof DatabaseBoundaryError &&
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
        outcome: error instanceof RequestError
          ? error.code
          : error instanceof DatabaseBoundaryError ||
              error instanceof ConfigurationError
          ? error.code
          : "internal_error",
        request_id: rid,
        ...seen,
        ...(caught instanceof DatabaseBoundaryError &&
            /^[0-9A-Z]{5}$/.test(caught.databaseCode ?? "")
          ? { database_code: caught.databaseCode }
          : {}),
      });
      return response;
    }
  };
}

export const handleConnectPaymentsWebhook = createConnectPaymentsWebhook();
if (import.meta.main) Deno.serve(handleConnectPaymentsWebhook);
