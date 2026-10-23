import type { SupabaseClient } from "@supabase/supabase-js";
import { constantTimeEqualStrings } from "../_shared/crypto.ts";
import { requiredSecret } from "../_shared/env.ts";
import {
  ConfigurationError,
  DatabaseBoundaryError,
  RequestError,
} from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  requestId,
  requireMethod,
} from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";
import { requireLiveStripeKey } from "../_shared/stripe-auth.ts";
import { projectStripeObject } from "../_shared/stripe.ts";
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDS = {
  event: /^evt_[A-Za-z0-9_]{8,128}$/,
  session: /^cs_live_[A-Za-z0-9_]{8,160}$/,
  customer: /^cus_[A-Za-z0-9_]{8,128}$/,
  subscription: /^sub_[A-Za-z0-9_]{8,160}$/,
  invoice: /^in_[A-Za-z0-9_]{8,160}$/,
  intent: /^pi_[A-Za-z0-9_]{8,160}$/,
  charge: /^ch_[A-Za-z0-9_]{8,160}$/,
  balance: /^txn_[A-Za-z0-9_]{8,160}$/,
  refund: /^re_[A-Za-z0-9_]{8,160}$/,
  dispute: /^dp_[A-Za-z0-9_]{8,160}$/,
};
const CURRENCY = /^[a-z]{3}$/;
const MAX_ATTEMPTS = 10;
export const STRIPE_WORKER_BATCH_LIMIT = 8;
export const STRIPE_WORKER_LEASE_SECONDS = 90;
export const STRIPE_WORKER_EXECUTION_DEADLINE_MS = 45_000;

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ClaimedStripeEvent {
  providerEventId: string;
  claimToken: string;
  externalEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attemptCount: number;
}

export type StripeNormalizationInput = Record<string, unknown> & {
  kind:
    | "checkout_subscription_paid"
    | "checkout_subscription_free"
    | "invoice_no_payment_required"
    | "subscription_changed"
    | "invoice_paid"
    | "refund_succeeded"
    | "dispute_changed";
  object_id: string;
};

export interface StripeWorkerDependencies {
  stripeSecret: () => string;
  claim: () => Promise<ClaimedStripeEvent[]>;
  normalize: (
    event: ClaimedStripeEvent,
    input: StripeNormalizationInput,
  ) => Promise<void>;
  fail: (
    event: ClaimedStripeEvent,
    code: string,
    terminal: boolean,
  ) => Promise<void>;
  fetcher: Fetcher;
  now?: () => number;
  executionDeadlineMs?: number;
  diagnostic?: (entry: Readonly<Record<string, unknown>>) => void;
}

export class StripeEventError extends Error {
  constructor(readonly code: string, readonly terminal: boolean) {
    super(code);
    this.name = "StripeEventError";
  }
}

class RpcError extends Error {
  constructor(readonly databaseCode?: string) {
    super("Stripe worker RPC failed.");
  }
}

function record(
  value: unknown,
  code = "incomplete_event",
): Record<string, unknown> {
  if (!isPlainObject(value)) throw new StripeEventError(code, true);
  return value;
}

function textValue(
  value: unknown,
  pattern?: RegExp,
  code = "incomplete_event",
): string {
  if (typeof value !== "string" || (pattern && !pattern.test(value))) {
    throw new StripeEventError(code, true);
  }
  return value;
}

function intValue(
  value: unknown,
  minimum = 0,
  code = "incomplete_event",
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new StripeEventError(code, true);
  }
  return Number(value);
}

function idValue(value: unknown, pattern: RegExp, code: string): string {
  return typeof value === "string"
    ? textValue(value, pattern, code)
    : textValue(record(value, code).id, pattern, code);
}

function liveSecret(value: string): string {
  return requireLiveStripeKey(value);
}

function signedObject(event: ClaimedStripeEvent): Record<string, unknown> {
  if (
    event.payload.id !== event.externalEventId ||
    event.payload.type !== event.eventType ||
    event.payload.livemode !== true
  ) throw new StripeEventError("inconsistent_signed_envelope", true);
  return record(
    record(event.payload.data, "incomplete_signed_envelope").object,
    "incomplete_signed_envelope",
  );
}

async function stripeGet(
  secret: string,
  path: string,
  fetcher: Fetcher,
  query?: URLSearchParams,
  executionSignal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://api.stripe.com${path}`);
  if (query) url.search = query.toString();
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
      signal: stripeRequestSignal(executionSignal),
    });
  } catch {
    throw new StripeEventError("stripe_api_unavailable", false);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ConfigurationError();
  }
  if (response.status === 429 || response.status >= 500) {
    throw new StripeEventError("stripe_api_unavailable", false);
  }
  if (!response.ok) {
    throw new StripeEventError("stripe_object_unavailable", true);
  }
  try {
    return record(await response.json(), "stripe_invalid_response");
  } catch (error) {
    if (error instanceof StripeEventError) throw error;
    throw new StripeEventError("stripe_invalid_response", true);
  }
}

interface SubscriptionEvidence {
  id: string;
  customer: string;
  attempt: string;
  status: string;
  currency: string;
  start: number;
  end: number;
  cancelled: number | null;
}

function periods(value: Record<string, unknown>): [number, number] {
  if (isPlainObject(value.items) && value.items.has_more === true) {
    throw new StripeEventError("unsupported_subscription_periods", true);
  }
  if (
    Number.isSafeInteger(value.current_period_start) &&
    Number.isSafeInteger(value.current_period_end)
  ) {
    const start = intValue(
      value.current_period_start,
      946684800,
      "invalid_subscription_state",
    );
    const end = intValue(
      value.current_period_end,
      start + 1,
      "invalid_subscription_state",
    );
    return [start, end];
  }
  const items = record(value.items, "invalid_subscription_state").data;
  if (!Array.isArray(items) || items.length === 0) {
    throw new StripeEventError("invalid_subscription_state", true);
  }
  const found = items.map((item) => {
    const row = record(item, "invalid_subscription_state");
    return [
      intValue(
        row.current_period_start,
        946684800,
        "invalid_subscription_state",
      ),
      intValue(row.current_period_end, 946684801, "invalid_subscription_state"),
    ] as const;
  });
  const [start, end] = found[0];
  if (end <= start || found.some(([a, b]) => a !== start || b !== end)) {
    throw new StripeEventError("unsupported_subscription_periods", true);
  }
  return [start, end];
}

function subscriptionEvidence(
  value: Record<string, unknown>,
  expectedId?: string,
): SubscriptionEvidence {
  const id = textValue(
    value.id,
    IDS.subscription,
    "invalid_subscription_state",
  );
  if (expectedId && id !== expectedId) {
    throw new StripeEventError("stripe_object_mismatch", true);
  }
  if (value.livemode !== true) {
    throw new StripeEventError("non_production_object", true);
  }
  const customer = idValue(
    value.customer,
    IDS.customer,
    "invalid_subscription_state",
  );
  const attempt = textValue(
    record(value.metadata, "invalid_attribution_metadata").kma_attempt_id,
    UUID,
    "invalid_attribution_metadata",
  );
  const status = textValue(
    value.status,
    undefined,
    "invalid_subscription_state",
  );
  if (
    !["incomplete", "trialing", "active", "past_due", "canceled", "unpaid"]
      .includes(status)
  ) {
    throw new StripeEventError("unsupported_subscription_status", true);
  }
  const currency = textValue(
    value.currency,
    CURRENCY,
    "invalid_subscription_state",
  ).toUpperCase();
  const [start, end] = periods(value);
  const cancelled =
    value.canceled_at === null || value.canceled_at === undefined
      ? null
      : intValue(value.canceled_at, 946684800, "invalid_subscription_state");
  return { id, customer, attempt, status, currency, start, end, cancelled };
}

function validateCheckoutMetadata(value: unknown): string {
  const metadata = record(value, "invalid_attribution_metadata");
  const attempt = textValue(
    metadata.kma_attempt_id,
    UUID,
    "invalid_attribution_metadata",
  );
  textValue(
    metadata.kma_public_attempt_id,
    /^[A-Za-z0-9_-]{32,128}$/,
    "invalid_attribution_metadata",
  );
  for (
    const key of [
      "kma_offer_id",
      "kma_product_id",
      "kma_acquisition_id",
      "kma_click_id",
    ]
  ) {
    textValue(metadata[key], UUID, "invalid_attribution_metadata");
  }
  textValue(
    metadata.kma_expected_amount_minor,
    /^[1-9][0-9]{0,7}$/,
    "invalid_attribution_metadata",
  );
  textValue(
    metadata.kma_expected_currency,
    /^[A-Z]{3}$/,
    "invalid_attribution_metadata",
  );
  return attempt;
}

async function checkoutInput(
  session: Record<string, unknown>,
  secret: string,
  fetcher: Fetcher,
  executionSignal?: AbortSignal,
): Promise<StripeNormalizationInput> {
  const id = textValue(session.id, IDS.session);
  if (session.object !== "checkout.session") {
    throw new StripeEventError("unsupported_event_shape", true);
  }
  if (session.mode === "payment") {
    throw new StripeEventError("unsupported_payment_mode", true);
  }
  if (
    session.mode !== "subscription" || session.status !== "complete" ||
    !["paid", "no_payment_required"].includes(String(session.payment_status))
  ) {
    throw new StripeEventError("checkout_not_paid", true);
  }
  const attempt = validateCheckoutMetadata(session.metadata);
  const free = session.amount_total === 0;
  if (free) {
    const details = record(session.total_details, "invalid_free_checkout");
    const subtotal = intValue(
      session.amount_subtotal,
      1,
      "invalid_free_checkout",
    );
    if (
      details.amount_discount !== subtotal || details.amount_tax !== 0 ||
      details.amount_shipping !== 0
    ) {
      throw new StripeEventError("invalid_free_checkout", true);
    }
  } else {
    intValue(session.amount_total, 1, "invalid_checkout_amount");
    if (session.payment_status !== "paid") {
      throw new StripeEventError("checkout_not_paid", true);
    }
  }
  textValue(session.currency, CURRENCY, "invalid_checkout_currency");
  const customer = idValue(
    session.customer,
    IDS.customer,
    "invalid_checkout_customer",
  );
  const subscriptionId = idValue(
    session.subscription,
    IDS.subscription,
    "invalid_checkout_subscription",
  );
  const sub = subscriptionEvidence(
    await stripeGet(
      secret,
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      fetcher,
      undefined,
      executionSignal,
    ),
    subscriptionId,
  );
  if (sub.customer !== customer || sub.attempt !== attempt) {
    throw new StripeEventError("stripe_object_mismatch", true);
  }
  return {
    kind: free ? "checkout_subscription_free" : "checkout_subscription_paid",
    object_id: id,
    subscription_id: sub.id,
    subscription_customer_id: sub.customer,
    subscription_attempt_id: sub.attempt,
    subscription_status: sub.status,
    subscription_currency: sub.currency,
    period_start: sub.start,
    period_end: sub.end,
    cancelled_at: sub.cancelled,
    subscription_livemode: true,
  };
}

async function invoicePayment(
  invoice: Record<string, unknown>,
  secret: string,
  fetcher: Fetcher,
  executionSignal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const invoiceId = textValue(invoice.id, IDS.invoice);
  const amount = intValue(invoice.amount_paid, 1, "invalid_invoice_amount");
  const currency = textValue(
    invoice.currency,
    CURRENCY,
    "invalid_invoice_currency",
  );
  const list = await stripeGet(
    secret,
    "/v1/invoice_payments",
    fetcher,
    new URLSearchParams({ invoice: invoiceId, status: "paid", limit: "100" }),
    executionSignal,
  );
  if (
    list.has_more !== false || !Array.isArray(list.data) ||
    list.data.length !== 1
  ) {
    throw new StripeEventError("unsupported_invoice_payment_count", true);
  }
  const paid = record(list.data[0], "invalid_invoice_payment");
  if (
    paid.status !== "paid" || paid.livemode !== true ||
    idValue(paid.invoice, IDS.invoice, "invalid_invoice_payment") !==
      invoiceId ||
    intValue(paid.amount_paid, 1, "invalid_invoice_payment") !== amount ||
    textValue(paid.currency, CURRENCY, "invalid_invoice_payment") !== currency
  ) throw new StripeEventError("invoice_payment_mismatch", true);
  const payment = record(paid.payment, "invalid_invoice_payment");
  if (payment.type !== "payment_intent") {
    throw new StripeEventError("unsupported_invoice_payment_type", true);
  }
  const intentId = idValue(
    payment.payment_intent,
    IDS.intent,
    "invalid_invoice_payment",
  );
  const intent = await stripeGet(
    secret,
    `/v1/payment_intents/${encodeURIComponent(intentId)}`,
    fetcher,
    new URLSearchParams({ "expand[]": "latest_charge.balance_transaction" }),
    executionSignal,
  );
  if (
    intent.id !== intentId || intent.livemode !== true ||
    intent.status !== "succeeded" ||
    intValue(intent.amount_received, 1, "invalid_payment_intent") !== amount ||
    textValue(intent.currency, CURRENCY, "invalid_payment_intent") !== currency
  ) throw new StripeEventError("payment_intent_mismatch", true);
  const charge = typeof intent.latest_charge === "string"
    ? await stripeGet(
      secret,
      `/v1/charges/${encodeURIComponent(intent.latest_charge)}`,
      fetcher,
      new URLSearchParams({ "expand[]": "balance_transaction" }),
      executionSignal,
    )
    : record(intent.latest_charge, "invalid_charge");
  const chargeId = textValue(charge.id, IDS.charge, "invalid_charge");
  if (
    charge.livemode !== true || charge.paid !== true ||
    charge.status !== "succeeded" ||
    intValue(charge.amount, 1, "invalid_charge") !== amount ||
    textValue(charge.currency, CURRENCY, "invalid_charge") !== currency ||
    idValue(charge.payment_intent, IDS.intent, "invalid_charge") !== intentId
  ) throw new StripeEventError("charge_mismatch", true);
  const balance = typeof charge.balance_transaction === "string"
    ? await stripeGet(
      secret,
      `/v1/balance_transactions/${
        encodeURIComponent(charge.balance_transaction)
      }`,
      fetcher,
      undefined,
      executionSignal,
    )
    : record(charge.balance_transaction, "invalid_balance_transaction");
  const balanceId = textValue(
    balance.id,
    IDS.balance,
    "invalid_balance_transaction",
  );
  const balanceAmount = intValue(
    balance.amount,
    1,
    "invalid_balance_transaction",
  );
  const fee = intValue(balance.fee, 0, "invalid_balance_transaction");
  const net = intValue(balance.net, 0, "invalid_balance_transaction");
  const settledCurrency = textValue(
    balance.currency,
    CURRENCY,
    "invalid_balance_transaction",
  );
  if (
    idValue(balance.source, IDS.charge, "invalid_balance_transaction") !==
      chargeId ||
    !["charge", "payment"].includes(String(balance.reporting_category)) ||
    balanceAmount !== amount || net !== balanceAmount - fee ||
    settledCurrency !== currency
  ) throw new StripeEventError("balance_transaction_mismatch", true);
  return {
    payment_intent_id: intentId,
    charge_id: chargeId,
    balance_transaction_id: balanceId,
    charge_amount_minor: amount,
    charge_currency: currency.toUpperCase(),
    charge_paid: true,
    charge_livemode: true,
    payment_intent_status: "succeeded",
    payment_intent_livemode: true,
    balance_amount_minor: balanceAmount,
    balance_fee_minor: fee,
    balance_net_minor: net,
    balance_currency: settledCurrency.toUpperCase(),
  };
}

async function invoiceInput(
  invoice: Record<string, unknown>,
  secret: string,
  fetcher: Fetcher,
  executionSignal?: AbortSignal,
): Promise<StripeNormalizationInput> {
  const id = textValue(invoice.id, IDS.invoice);
  if (
    invoice.object !== "invoice" || invoice.status !== "paid" ||
    (Object.hasOwn(invoice, "paid") && invoice.paid !== true)
  ) {
    throw new StripeEventError("invoice_not_paid", true);
  }
  const free = invoice.amount_paid === 0;
  if (free) {
    if (
      invoice.total !== 0 || invoice.total_excluding_tax !== 0 ||
      invoice.amount_due !== 0 || invoice.amount_remaining !== 0
    ) {
      throw new StripeEventError("invalid_free_invoice", true);
    }
  } else {
    intValue(invoice.amount_paid, 1, "invalid_invoice_amount");
    intValue(invoice.total, 1, "invalid_invoice_amount");
  }
  intValue(invoice.total_excluding_tax, 0, "incomplete_invoice_tax");
  textValue(invoice.currency, CURRENCY, "invalid_invoice_currency");
  const customer = idValue(
    invoice.customer,
    IDS.customer,
    "invalid_invoice_customer",
  );
  const parent = isPlainObject(invoice.parent) ? invoice.parent : null;
  const details = parent && isPlainObject(parent.subscription_details)
    ? parent.subscription_details
    : null;
  const subscription = idValue(
    invoice.subscription ?? details?.subscription,
    IDS.subscription,
    "invalid_invoice_subscription",
  );
  if (free) {
    return {
      kind: "invoice_no_payment_required",
      object_id: id,
      subscription_id: subscription,
      customer_id: customer,
    };
  }
  return {
    kind: "invoice_paid",
    object_id: id,
    subscription_id: subscription,
    customer_id: customer,
    ...await invoicePayment(invoice, secret, fetcher, executionSignal),
  };
}

function refundInput(value: Record<string, unknown>): StripeNormalizationInput {
  const id = textValue(value.id, IDS.refund);
  if (value.object !== "refund" || value.status !== "succeeded") {
    throw new StripeEventError("refund_not_succeeded", true);
  }
  idValue(value.charge, IDS.charge, "invalid_refund_charge");
  intValue(value.amount, 1, "invalid_refund_amount");
  textValue(value.currency, CURRENCY, "invalid_refund_currency");
  intValue(value.created, 946684800, "invalid_refund_timestamp");
  return { kind: "refund_succeeded", object_id: id };
}

function disputeInput(
  value: Record<string, unknown>,
): StripeNormalizationInput {
  const id = textValue(value.id, IDS.dispute);
  if (value.object !== "dispute") {
    throw new StripeEventError("invalid_dispute", true);
  }
  idValue(value.charge, IDS.charge, "invalid_dispute_charge");
  intValue(value.amount, 1, "invalid_dispute_amount");
  textValue(value.currency, CURRENCY, "invalid_dispute_currency");
  intValue(value.created, 946684800, "invalid_dispute_timestamp");
  textValue(value.status, undefined, "invalid_dispute_status");
  if (!Array.isArray(value.balance_transactions)) {
    throw new StripeEventError("incomplete_dispute_balance", true);
  }
  for (const item of value.balance_transactions) {
    const balance = record(item, "incomplete_dispute_balance");
    textValue(balance.id, IDS.balance, "incomplete_dispute_balance");
    if (
      !Number.isSafeInteger(balance.amount) ||
      !Number.isSafeInteger(balance.net)
    ) {
      throw new StripeEventError("incomplete_dispute_balance", true);
    }
    intValue(balance.fee, 0, "incomplete_dispute_balance");
    textValue(balance.currency, CURRENCY, "incomplete_dispute_balance");
  }
  return { kind: "dispute_changed", object_id: id };
}

export async function buildStripeNormalization(
  event: ClaimedStripeEvent,
  secret: string,
  fetcher: Fetcher = fetch,
  executionSignal?: AbortSignal,
): Promise<StripeNormalizationInput> {
  const object = signedObject(event);
  switch (event.eventType) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return await checkoutInput(object, secret, fetcher, executionSignal);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      let recovered: Record<string, unknown> | undefined;
      // Old minimized receipts dropped item periods. Retrieve the original
      // immutable Event, never today's subscription as historical evidence.
      if (
        !Object.hasOwn(object, "items") &&
        !Number.isSafeInteger(object.current_period_start)
      ) {
        const original = await stripeGet(
          secret,
          `/v1/events/${
            encodeURIComponent(textValue(event.externalEventId, IDS.event))
          }`,
          fetcher,
          undefined,
          executionSignal,
        );
        // Event retrieval retains the Event's original rendering version, not
        // the webhook destination's version. Project only our known fields,
        // then require exact equality with the signed receipt except items.
        // This does NOT relax the webhook's pinned-version check.
        recovered = {
          id: original.id,
          type: original.type,
          livemode: original.livemode,
          ...(Object.hasOwn(original, "created")
            ? { created: original.created }
            : {}),
          data: {
            object: projectStripeObject(
              event.eventType,
              record(record(original.data).object),
            ),
          },
        };
        const recoveredObject = record(record(recovered.data).object);
        const { items: _items, ...oldShape } = recoveredObject;
        const equal = (a: unknown, b: unknown): boolean => {
          if (isPlainObject(a) && isPlainObject(b)) {
            return Object.keys(a).length === Object.keys(b).length &&
              Object.keys(a).every((key) =>
                Object.hasOwn(b, key) && equal(a[key], b[key])
              );
          }
          return a === b;
        };
        if (
          !equal({ ...recovered, data: { object: oldShape } }, event.payload)
        ) {
          throw new StripeEventError("stripe_object_mismatch", true);
        }
        subscriptionEvidence(recoveredObject);
      } else subscriptionEvidence(object);
      return {
        kind: "subscription_changed",
        object_id: textValue(object.id, IDS.subscription),
        ...(recovered ? { recovered_event: recovered } : {}),
      };
    }
    case "invoice.paid":
      return await invoiceInput(object, secret, fetcher, executionSignal);
    case "refund.created":
    case "refund.updated":
      return refundInput(object);
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      return disputeInput(object);
    case "charge.refunded":
      throw new StripeEventError("aggregate_refund_event_unsupported", true);
    default:
      throw new StripeEventError("unsupported_event_type", true);
  }
}

function parseClaim(value: unknown): ClaimedStripeEvent {
  const row = record(value, "invalid_claim_boundary");
  if (row.provider !== "stripe") throw new DatabaseBoundaryError();
  return {
    providerEventId: textValue(
      row.provider_event_id,
      UUID,
      "invalid_claim_boundary",
    ),
    claimToken: textValue(row.claim_token, UUID, "invalid_claim_boundary"),
    externalEventId: textValue(
      row.external_event_id,
      IDS.event,
      "invalid_claim_boundary",
    ),
    eventType: textValue(
      row.event_type,
      /^[a-z][a-z0-9_.]{1,120}$/,
      "invalid_claim_boundary",
    ),
    payload: record(row.payload, "invalid_claim_boundary"),
    attemptCount: intValue(row.attempt_count, 1, "invalid_claim_boundary"),
  };
}

function defaultDependencies(client: SupabaseClient): StripeWorkerDependencies {
  return {
    stripeSecret: () => requiredSecret("STRIPE_SECRET_KEY"),
    fetcher: fetch,
    claim: async () => {
      const { data, error } = await client.rpc("claim_provider_events", {
        p_worker: "stripe-worker",
        p_limit: STRIPE_WORKER_BATCH_LIMIT,
        p_lease_seconds: STRIPE_WORKER_LEASE_SECONDS,
      });
      if (error || !Array.isArray(data)) {
        throw new DatabaseBoundaryError(error?.code);
      }
      try {
        return data.map(parseClaim);
      } catch (error) {
        if (error instanceof DatabaseBoundaryError) throw error;
        throw new DatabaseBoundaryError();
      }
    },
    normalize: async (event, input) => {
      const { recovered_event, ...normalization } = input;
      if (recovered_event) {
        const { error } = await client.rpc(
          "supplement_stripe_subscription_event",
          {
            p_provider_event_id: event.providerEventId,
            p_claim_token: event.claimToken,
            p_payload: recovered_event,
          },
        );
        if (error) throw new RpcError(error.code);
      }
      const { data, error } = await client.rpc(
        ["checkout_subscription_free", "invoice_no_payment_required"].includes(
            input.kind,
          )
          ? "normalize_stripe_zero_total_event"
          : "normalize_stripe_provider_event",
        {
          p_provider_event_id: event.providerEventId,
          p_claim_token: event.claimToken,
          p_input: normalization,
        },
      );
      if (error) throw new RpcError(error.code);
      if (!isPlainObject(data) || data.status !== "processed") {
        throw new DatabaseBoundaryError();
      }
    },
    fail: async (event, code, terminal) => {
      const { data, error } = await client.rpc("fail_provider_event", {
        p_provider_event_id: event.providerEventId,
        p_claim_token: event.claimToken,
        p_error_code: code,
        p_retry_delay_seconds: terminal
          ? 0
          : Math.min(3600, 30 * 2 ** Math.min(event.attemptCount, 6)),
        p_terminal: terminal,
      });
      if (error || (data !== "pending" && data !== "failed")) {
        throw new DatabaseBoundaryError(error?.code);
      }
    },
  };
}

function authenticate(request: Request): void {
  const expected = requiredSecret("INTERNAL_WORKER_SECRET");
  const supplied = request.headers.get("x-kma-worker-secret") ?? "";
  if (!supplied || !constantTimeEqualStrings(expected, supplied)) {
    throw new RequestError(
      401,
      "unauthorized",
      "Worker authentication failed.",
    );
  }
}

function classify(error: unknown, attempts: number): StripeEventError {
  if (error instanceof StripeEventError) {
    return new StripeEventError(
      error.code,
      error.terminal || attempts >= MAX_ATTEMPTS,
    );
  }
  if (error instanceof RpcError) {
    const terminal = ["0A000", "22023", "23505", "23514"].includes(
      error.databaseCode ?? "",
    );
    return new StripeEventError(
      terminal
        ? "normalization_rejected"
        : "normalization_dependency_unavailable",
      terminal || attempts >= MAX_ATTEMPTS,
    );
  }
  if (error instanceof ConfigurationError) throw error;
  if (error instanceof DatabaseBoundaryError) throw error;
  return new StripeEventError(
    "worker_processing_error",
    attempts >= MAX_ATTEMPTS,
  );
}

export function createStripeWorkerHandler(
  supplied?: StripeWorkerDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      authenticate(request);
      const dependencies = supplied ?? defaultDependencies(serviceClient());
      const secret = liveSecret(dependencies.stripeSecret());
      const claims = await dependencies.claim();
      const now = dependencies.now ?? Date.now;
      const executionDeadlineMs = dependencies.executionDeadlineMs ??
        STRIPE_WORKER_EXECUTION_DEADLINE_MS;
      const deadlineAt = now() + executionDeadlineMs;
      const executionSignal = AbortSignal.timeout(executionDeadlineMs);
      const diagnostic = dependencies.diagnostic ?? ((entry) => {
        console.error(JSON.stringify(entry));
      });
      let processed = 0;
      let retried = 0;
      let failed = 0;
      let deferred = 0;
      for (let index = 0; index < claims.length; index += 1) {
        if (now() >= deadlineAt || executionSignal.aborted) {
          deferred = claims.length - index;
          break;
        }
        const event = claims[index];
        try {
          const input = await buildStripeNormalization(
            event,
            secret,
            dependencies.fetcher,
            executionSignal,
          );
          await dependencies.normalize(event, input);
          processed += 1;
        } catch (error) {
          const result = classify(error, event.attemptCount);
          await dependencies.fail(event, result.code, result.terminal);
          if (result.terminal) {
            failed += 1;
            diagnostic({
              level: "error",
              worker: "stripe-worker",
              outcome: "terminal_item_failure",
              failure_code: result.code,
              provider_event_id: event.providerEventId,
              event_type: event.eventType,
              attempt_count: event.attemptCount,
              request_id: id,
            });
          } else retried += 1;
        }
      }
      return jsonResponse(200, {
        status: "processed",
        worker: "stripe-worker",
        claimed: claims.length,
        processed,
        retried,
        failed,
        deferred,
        mutation_enabled: true,
        request_id: id,
      });
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}

export const handleStripeWorker = createStripeWorkerHandler();

if (import.meta.main) Deno.serve(handleStripeWorker);
