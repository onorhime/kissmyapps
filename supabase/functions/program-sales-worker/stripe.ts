// Reads a payment, refund or dispute back from a connected merchant's live
// Stripe account, with the platform key and the Stripe-Account header. GET
// requests only. Written for the pinned STRIPE_API_VERSION: an invoice no
// longer names its PaymentIntent (its payments are listed by
// /v1/invoice_payments) and its subscription sits under `parent`.
// Only identifiers, amounts, the creator tag and, for one database call, the
// buyer's email leave this file. Nothing here logs.
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";
import { isPlainObject } from "../_shared/validation.ts";

type Json = Record<string, unknown>;

/** The receipt fields a read needs. */
export interface ReceiptToRead {
  event_type: string;
  account_id: string;
  object_id: string;
  amount_minor: number | null;
  currency: string | null;
  event_created: number;
}

/** A verified payment, as record_program_sale takes it. */
export interface SaleFacts {
  livemode: true;
  payment_intent_id: string;
  charge_id: string;
  checkout_session_id: string | null;
  invoice_id: string | null;
  subscription_id: string | null;
  customer_id: string | null;
  billing_reason: string | null;
  amount_minor: number;
  currency: string;
  tax_minor: number | null;
  fee_minor: number | null;
  fee_currency: string | null;
  refunded_minor: number;
  paid_at: number;
  kma_click: string | null;
  tag_source: "metadata" | "client_reference_id" | null;
  /** Used for one lookup in the database call, then dropped. Never logged. */
  buyer_email: string | null;
}

export interface SaleEventFact {
  kind: "refund" | "dispute";
  stripe_object_id: string;
  state: "succeeded" | "failed" | "canceled" | "open" | "won" | "lost";
  amount_minor: number;
  currency: string;
  occurred_at: number;
}

/** A verified refund or dispute, as record_program_sale_event takes it. */
export interface AdjustmentFacts {
  payment_intent_id: string;
  refunded_minor: number | null;
  events: SaleEventFact[];
}

/** `skip` is the receipt's final outcome when there is nothing to record. */
export type PaymentReading = { sale: SaleFacts } | { skip: string };
export type AdjustmentReading = { adjustment: AdjustmentFacts } | {
  skip: string;
};

/**
 * Stripe could not be read. `retry` is about this receipt and is tried again
 * later; `configuration` means the platform key itself was refused, so the
 * whole run stops.
 */
export class StripeReadError extends Error {
  constructor(
    readonly code: string,
    readonly kind: "retry" | "configuration" = "retry",
  ) {
    super(code);
    this.name = "StripeReadError";
  }
}

/** Ends a read with a final outcome. Never leaves this file. */
class Skip extends Error {
  constructor(readonly outcome: string) {
    super(outcome);
  }
}

const ACCOUNT = /^acct_[A-Za-z0-9]{3,128}$/;
const SAFE_ID = /^[A-Za-z0-9_]{3,255}$/;
const INTENT = /^pi_[A-Za-z0-9_]{1,252}$/;
const CHARGE = /^[a-z]{2,4}_[A-Za-z0-9_]{1,250}$/;
const SESSION = /^cs_[A-Za-z0-9_]{1,252}$/;
const INVOICE = /^in_[A-Za-z0-9_]{1,252}$/;
const SUBSCRIPTION = /^sub_[A-Za-z0-9_]{1,251}$/;
const CUSTOMER = /^cus_[A-Za-z0-9_]{1,251}$/;
const CURRENCY = /^[A-Za-z]{3}$/;
const BILLING_REASON = /^[a-z_]{1,60}$/;
const CLICK_ID = /^[A-Za-z0-9_-]{16,128}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const EXPAND_CHARGE_FEE = "latest_charge.balance_transaction";

/** A Stripe reference is an id, or the object itself when it was expanded. */
function refId(value: unknown, pattern: RegExp): string | null {
  const id = isPlainObject(value) ? value.id : value;
  return typeof id === "string" && pattern.test(id) ? id : null;
}

function wholeAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function currencyCode(value: unknown): string | null {
  return typeof value === "string" && CURRENCY.test(value)
    ? value.toUpperCase()
    : null;
}

function emailAddress(value: unknown): string | null {
  return typeof value === "string" && value.length <= 254 && EMAIL.test(value)
    ? value
    : null;
}

function metadataTag(holder: unknown): string | null {
  const metadata = isPlainObject(holder) && isPlainObject(holder.metadata)
    ? holder.metadata
    : null;
  const tag = metadata && Object.hasOwn(metadata, "kma_click")
    ? metadata.kma_click
    : null;
  return typeof tag === "string" && CLICK_ID.test(tag) ? tag : null;
}

/** The object must be the live one that was asked for. */
function requireObject(value: Json, type: string, id: string): void {
  if (value.object !== type || value.id !== id) {
    throw new Skip("object_mismatch");
  }
  if (value.livemode !== true) throw new Skip("not_live");
}

/** What the signed event said must still be what Stripe says. */
function requireSameMoney(
  receipt: ReceiptToRead,
  amount: unknown,
  currency: unknown,
): void {
  if (
    (receipt.amount_minor !== null && receipt.amount_minor !== amount) ||
    (receipt.currency !== null && receipt.currency !== currencyCode(currency))
  ) throw new Skip("amount_mismatch");
}

/** What a Checkout Session or an invoice adds to the payment it resolved to. */
interface PaymentContext {
  checkout_session_id?: string | null;
  invoice_id?: string | null;
  subscription_id?: string | null;
  customer_id?: string | null;
  billing_reason?: string | null;
  tax_minor?: number | null;
  metadata_tag?: string | null;
  reference_tag?: string | null;
  email?: string | null;
}

function invoiceTax(invoice: Json): number | null {
  if (Array.isArray(invoice.total_taxes)) {
    let total = 0;
    for (const entry of invoice.total_taxes) {
      const amount = isPlainObject(entry) ? wholeAmount(entry.amount) : null;
      if (amount === null) return null;
      total += amount;
    }
    return Number.isSafeInteger(total) ? total : null;
  }
  return wholeAmount(invoice.tax);
}

function invoiceContext(invoice: Json): PaymentContext {
  const parent = isPlainObject(invoice.parent) ? invoice.parent : null;
  const details = parent && isPlainObject(parent.subscription_details)
    ? parent.subscription_details
    : isPlainObject(invoice.subscription_details)
    ? invoice.subscription_details
    : null;
  return {
    invoice_id: refId(invoice, INVOICE),
    subscription_id: refId(
      details?.subscription ?? invoice.subscription,
      SUBSCRIPTION,
    ),
    customer_id: refId(invoice.customer, CUSTOMER),
    billing_reason: typeof invoice.billing_reason === "string" &&
        BILLING_REASON.test(invoice.billing_reason)
      ? invoice.billing_reason
      : null,
    tax_minor: invoiceTax(invoice),
    // The invoice's own tag, else the subscription's as copied onto the invoice.
    metadata_tag: metadataTag(invoice) ?? metadataTag(details),
    email: emailAddress(invoice.customer_email),
  };
}

/** One reader per worker run. Reads of the same object are made once. */
export class StripeReader {
  private readonly seen = new Map<string, Json>();

  constructor(
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly runSignal?: AbortSignal,
  ) {}

  private async get(
    account: string,
    path: string,
    query: ReadonlyArray<readonly [string, string]> = [],
  ): Promise<Json> {
    if (!ACCOUNT.test(account)) throw new Skip("object_mismatch");
    const url = new URL(`https://api.stripe.com${path}`);
    for (const [key, value] of query) url.searchParams.append(key, value);
    const key = `${account} ${url.pathname}${url.search}`;
    const known = this.seen.get(key);
    if (known) return known;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.secret}`,
          "Stripe-Version": STRIPE_API_VERSION,
          "Stripe-Account": account,
        },
        redirect: "error",
        signal: stripeRequestSignal(this.runSignal),
      });
    } catch {
      throw new StripeReadError("stripe_unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel();
      // 401: the platform key is wrong or revoked. 403: this account no longer
      // lets the platform in. Stripe's error body is never read.
      if (response.status === 401) {
        throw new StripeReadError("stripe_key_rejected", "configuration");
      }
      throw new StripeReadError(
        response.status === 403
          ? "stripe_account_denied"
          : response.status === 404
          ? "stripe_object_missing"
          : response.status === 429 || response.status >= 500
          ? "stripe_unavailable"
          : "stripe_request_rejected",
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new StripeReadError("stripe_invalid_response");
    }
    if (!isPlainObject(body)) {
      throw new StripeReadError("stripe_invalid_response");
    }
    this.seen.set(key, body);
    return body;
  }

  /** Turns a payment receipt into a verified sale, or says why there is none. */
  async payment(receipt: ReceiptToRead): Promise<PaymentReading> {
    try {
      switch (receipt.event_type) {
        case "payment_intent.succeeded":
          if (!INTENT.test(receipt.object_id)) {
            throw new Skip("object_mismatch");
          }
          return {
            sale: await this.sale(receipt, receipt.object_id, {}, true),
          };
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          return { sale: await this.sessionSale(receipt) };
        case "invoice.paid": {
          if (!INVOICE.test(receipt.object_id)) {
            throw new Skip("object_mismatch");
          }
          const { intent, context } = await this.invoice(
            receipt.account_id,
            receipt.object_id,
            receipt,
          );
          return { sale: await this.sale(receipt, intent, context, false) };
        }
        default:
          throw new Skip("object_mismatch");
      }
    } catch (error) {
      if (error instanceof Skip) return { skip: error.outcome };
      throw error;
    }
  }

  /** Turns a refund or dispute receipt into what it says about its sale. */
  async adjustment(receipt: ReceiptToRead): Promise<AdjustmentReading> {
    try {
      if (!SAFE_ID.test(receipt.object_id)) throw new Skip("object_mismatch");
      switch (receipt.event_type) {
        case "refund.created":
        case "refund.updated":
          return { adjustment: await this.refund(receipt) };
        case "charge.refunded":
          return { adjustment: await this.refundedCharge(receipt) };
        case "charge.dispute.created":
        case "charge.dispute.closed":
          return { adjustment: await this.dispute(receipt) };
        default:
          throw new Skip("object_mismatch");
      }
    } catch (error) {
      if (error instanceof Skip) return { skip: error.outcome };
      throw error;
    }
  }

  private async sessionSale(receipt: ReceiptToRead): Promise<SaleFacts> {
    if (!SESSION.test(receipt.object_id)) throw new Skip("object_mismatch");
    const session = await this.get(
      receipt.account_id,
      `/v1/checkout/sessions/${encodeURIComponent(receipt.object_id)}`,
      [["expand[]", `payment_intent.${EXPAND_CHARGE_FEE}`]],
    );
    requireObject(session, "checkout.session", receipt.object_id);
    requireSameMoney(receipt, session.amount_total, session.currency);
    if (session.payment_status === "no_payment_required") {
      throw new Skip("no_payment_intent");
    }
    if (session.status !== "complete" || session.payment_status !== "paid") {
      throw new Skip("not_paid");
    }
    const details = isPlainObject(session.customer_details)
      ? session.customer_details
      : null;
    const totals = isPlainObject(session.total_details)
      ? session.total_details
      : null;
    const reference = session.client_reference_id;
    let context: PaymentContext = {
      checkout_session_id: receipt.object_id,
      subscription_id: refId(session.subscription, SUBSCRIPTION),
      customer_id: refId(session.customer, CUSTOMER),
      tax_minor: wholeAmount(totals?.amount_tax),
      metadata_tag: metadataTag(session),
      reference_tag: typeof reference === "string" &&
          reference.startsWith("kma_") && CLICK_ID.test(reference.slice(4))
        ? reference
        : null,
      email: emailAddress(details?.email) ??
        emailAddress(session.customer_email),
    };
    // A one-off payment names its PaymentIntent; a subscription names its invoice.
    let intent: unknown = session.payment_intent;
    if (refId(intent, INTENT) === null) {
      const invoiceId = refId(session.invoice, INVOICE);
      if (invoiceId === null) throw new Skip("no_payment_intent");
      const found = await this.invoice(receipt.account_id, invoiceId);
      intent = found.intent;
      context = {
        ...found.context,
        ...context,
        subscription_id: context.subscription_id ??
          found.context.subscription_id,
        customer_id: context.customer_id ?? found.context.customer_id,
        tax_minor: found.context.tax_minor ?? context.tax_minor,
        metadata_tag: context.metadata_tag ?? found.context.metadata_tag,
        email: context.email ?? found.context.email,
      };
    }
    return await this.sale(receipt, intent, context, false);
  }

  /**
   * The one PaymentIntent that paid an invoice, and what the invoice knows. A
   * paid invoice without one (nothing to pay, or paid outside Stripe) is skipped.
   */
  private async invoice(
    account: string,
    invoiceId: string,
    receipt?: ReceiptToRead,
  ): Promise<{ intent: string; context: PaymentContext }> {
    const list = await this.get(account, "/v1/invoice_payments", [
      ["invoice", invoiceId],
      ["status", "paid"],
      ["limit", "10"],
      ["expand[]", "data.invoice"],
    ]);
    if (!Array.isArray(list.data)) {
      throw new StripeReadError("stripe_invalid_response");
    }
    const paid = list.data.filter((entry): entry is Json =>
      isPlainObject(entry) && entry.status === "paid" &&
      isPlainObject(entry.payment) &&
      entry.payment.type === "payment_intent" &&
      refId(entry.payment.payment_intent, INTENT) !== null &&
      refId(entry.invoice, INVOICE) === invoiceId
    );
    if (paid.length === 0) throw new Skip("no_payment_intent");
    if (paid.length > 1 || list.has_more === true) {
      throw new Skip("invoice_payments_unsupported");
    }
    if (paid[0].livemode !== true) throw new Skip("not_live");
    const invoice = isPlainObject(paid[0].invoice)
      ? paid[0].invoice
      : await this.get(
        account,
        `/v1/invoices/${encodeURIComponent(invoiceId)}`,
      );
    requireObject(invoice, "invoice", invoiceId);
    if (invoice.status !== "paid") throw new Skip("not_paid");
    if (receipt) {
      requireSameMoney(receipt, invoice.amount_paid, invoice.currency);
    }
    return {
      intent: refId((paid[0].payment as Json).payment_intent, INTENT)!,
      context: invoiceContext(invoice),
    };
  }

  /**
   * The sale itself: the PaymentIntent succeeded on this account in live mode,
   * and its charge was paid for the same amount in the same currency. The
   * amount and currency of the sale are the PaymentIntent's.
   */
  private async sale(
    receipt: ReceiptToRead,
    reference: unknown,
    context: PaymentContext,
    compareWithReceipt: boolean,
  ): Promise<SaleFacts> {
    const intentId = refId(reference, INTENT);
    if (intentId === null) throw new Skip("no_payment_intent");
    const intent = isPlainObject(reference) &&
        isPlainObject(reference.latest_charge)
      ? reference
      : await this.get(
        receipt.account_id,
        `/v1/payment_intents/${encodeURIComponent(intentId)}`,
        [["expand[]", EXPAND_CHARGE_FEE], ["expand[]", "customer"]],
      );
    requireObject(intent, "payment_intent", intentId);
    const amount = wholeAmount(intent.amount_received);
    const currency = currencyCode(intent.currency);
    if (compareWithReceipt) {
      requireSameMoney(receipt, intent.amount_received, intent.currency);
    }
    if (intent.status !== "succeeded" || !amount || currency === null) {
      throw new Skip("not_paid");
    }
    const charge = intent.latest_charge;
    if (!isPlainObject(charge)) {
      throw new StripeReadError("stripe_invalid_response");
    }
    const chargeId = refId(charge, CHARGE);
    if (charge.livemode !== true) throw new Skip("not_live");
    if (charge.paid !== true || charge.status !== "succeeded") {
      throw new Skip("not_paid");
    }
    if (
      charge.object !== "charge" || chargeId === null ||
      refId(charge.payment_intent, INTENT) !== intentId ||
      currencyCode(charge.currency) !== currency ||
      wholeAmount(charge.amount_captured ?? charge.amount) !== amount
    ) throw new Skip("charge_mismatch");

    // Null until Stripe has settled the charge; a later read fills it.
    const balance = isPlainObject(charge.balance_transaction)
      ? charge.balance_transaction
      : null;
    const fee = balance ? wholeAmount(balance.fee) : null;
    const feeCurrency = balance ? currencyCode(balance.currency) : null;
    const billing = isPlainObject(charge.billing_details)
      ? charge.billing_details
      : null;
    const customer = isPlainObject(intent.customer) ? intent.customer : null;
    const amountDetails = isPlainObject(intent.amount_details)
      ? intent.amount_details
      : null;
    const taxDetails = amountDetails && isPlainObject(amountDetails.tax)
      ? amountDetails.tax
      : null;
    const metadataTagFound = metadataTag(intent) ?? context.metadata_tag ??
      null;
    const tag = metadataTagFound ?? context.reference_tag ?? null;
    return {
      livemode: true,
      payment_intent_id: intentId,
      charge_id: chargeId,
      checkout_session_id: context.checkout_session_id ?? null,
      invoice_id: context.invoice_id ?? null,
      subscription_id: context.subscription_id ?? null,
      customer_id: refId(intent.customer, CUSTOMER) ?? context.customer_id ??
        null,
      billing_reason: context.billing_reason ?? null,
      amount_minor: amount,
      currency,
      tax_minor: context.tax_minor ?? wholeAmount(taxDetails?.total_tax_amount),
      fee_minor: fee !== null && feeCurrency !== null ? fee : null,
      fee_currency: fee !== null && feeCurrency !== null ? feeCurrency : null,
      refunded_minor: wholeAmount(charge.amount_refunded) ?? 0,
      paid_at: wholeAmount(charge.created) || receipt.event_created,
      kma_click: tag,
      tag_source: tag === null
        ? null
        : metadataTagFound !== null
        ? "metadata"
        : "client_reference_id",
      buyer_email: emailAddress(billing?.email) ??
        emailAddress(intent.receipt_email) ??
        emailAddress(charge.receipt_email) ?? context.email ??
        emailAddress(customer?.email),
    };
  }

  private async refund(receipt: ReceiptToRead): Promise<AdjustmentFacts> {
    const refund = await this.get(
      receipt.account_id,
      `/v1/refunds/${encodeURIComponent(receipt.object_id)}`,
      [["expand[]", "charge"]],
    );
    if (refund.object !== "refund" || refund.id !== receipt.object_id) {
      throw new Skip("object_mismatch");
    }
    // A refund has no mode of its own: its charge says whether it is live.
    const chargeId = refId(refund.charge, CHARGE);
    if (chargeId === null) throw new Skip("no_sale");
    const charge = isPlainObject(refund.charge)
      ? refund.charge
      : await this.get(
        receipt.account_id,
        `/v1/charges/${encodeURIComponent(chargeId)}`,
      );
    requireObject(charge, "charge", chargeId);
    requireSameMoney(receipt, refund.amount, refund.currency);
    const intent = refId(refund.payment_intent, INTENT) ??
      refId(charge.payment_intent, INTENT);
    if (intent === null) throw new Skip("no_sale");
    const amount = wholeAmount(refund.amount);
    const currency = currencyCode(refund.currency);
    const created = wholeAmount(refund.created);
    if (
      refund.status !== "succeeded" && refund.status !== "failed" &&
      refund.status !== "canceled"
    ) throw new Skip("refund_pending");
    if (amount === null || currency === null || !created) {
      throw new StripeReadError("stripe_invalid_response");
    }
    return {
      payment_intent_id: intent,
      refunded_minor: wholeAmount(charge.amount_refunded),
      events: [{
        kind: "refund",
        stripe_object_id: receipt.object_id,
        state: refund.status,
        amount_minor: amount,
        currency,
        occurred_at: created,
      }],
    };
  }

  /** charge.refunded: only the charge's refunded total; refunds have their own events. */
  private async refundedCharge(
    receipt: ReceiptToRead,
  ): Promise<AdjustmentFacts> {
    const charge = await this.get(
      receipt.account_id,
      `/v1/charges/${encodeURIComponent(receipt.object_id)}`,
    );
    requireObject(charge, "charge", receipt.object_id);
    const intent = refId(charge.payment_intent, INTENT);
    if (intent === null) throw new Skip("no_sale");
    const refunded = wholeAmount(charge.amount_refunded);
    if (refunded === null) throw new StripeReadError("stripe_invalid_response");
    return { payment_intent_id: intent, refunded_minor: refunded, events: [] };
  }

  private async dispute(receipt: ReceiptToRead): Promise<AdjustmentFacts> {
    const dispute = await this.get(
      receipt.account_id,
      `/v1/disputes/${encodeURIComponent(receipt.object_id)}`,
    );
    requireObject(dispute, "dispute", receipt.object_id);
    requireSameMoney(receipt, dispute.amount, dispute.currency);
    const intent = refId(dispute.payment_intent, INTENT);
    if (intent === null) throw new Skip("no_sale");
    const amount = wholeAmount(dispute.amount);
    const currency = currencyCode(dispute.currency);
    const created = wholeAmount(dispute.created);
    if (
      amount === null || currency === null || !created ||
      typeof dispute.status !== "string"
    ) throw new StripeReadError("stripe_invalid_response");
    return {
      payment_intent_id: intent,
      refunded_minor: null,
      events: [{
        kind: "dispute",
        stripe_object_id: receipt.object_id,
        // Won, or an inquiry closed without a chargeback: no longer disputed.
        // Lost stays disputed. Every other status is still open.
        state: dispute.status === "won" || dispute.status === "warning_closed"
          ? "won"
          : dispute.status === "lost"
          ? "lost"
          : "open",
        amount_minor: amount,
        currency,
        occurred_at: created,
      }],
    };
  }
}
