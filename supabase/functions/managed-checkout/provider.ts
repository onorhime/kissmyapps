import { RequestError } from "../_shared/errors.ts";
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";
import {
  attributionHash,
  type CommerceBinding,
  type CommerceEvidence,
  UUID,
  verifyCommerceWithStripe,
} from "../external-commerce/contract.ts";
import {
  type Json,
  type ManagedBinding,
  type ManagedOrder,
  object,
  reject,
} from "./contract.ts";

const id = (v: unknown, prefix: string) => {
  if (
    typeof v !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(v)
  ) {
    reject(
      "provider_identity_invalid",
      "The payment provider identity is invalid.",
      409,
    );
  }
  return v;
};
const oid = (v: unknown) => object(v) ? v.id : v;
const timestamp = (v: unknown) => {
  if (
    !Number.isSafeInteger(v) || Number(v) <= 0 ||
    Number(v) * 1000 > Date.now() + 300000
  ) {
    reject(
      "provider_evidence_invalid",
      "Provider evidence requires review.",
      409,
    );
  }
  return new Date(Number(v) * 1000).toISOString();
};
function mismatch(): never {
  return reject(
    "provider_evidence_mismatch",
    "Provider evidence does not match this order.",
    409,
  );
}

/** The only money-writing transport. Fixed Stripe origin, no redirects and a
 * server-bound account/mode. Mutations require a persisted operation identity. */
export class ManagedProvider {
  constructor(
    readonly binding: ManagedBinding,
    readonly fetcher: typeof fetch = fetch,
    readonly now = Date.now,
  ) {}
  async request(
    path: string,
    form?: Record<string, string>,
    key?: string,
    platform = false,
  ): Promise<Json> {
    if (!/^[A-Za-z0-9_/?=&%.-]+$/.test(path) || path.includes("..")) mismatch();
    if (form && !key) mismatch();
    let response: Response;
    try {
      response = await this.fetcher(`https://api.stripe.com/v1/${path}`, {
        method: form ? "POST" : "GET",
        redirect: "error",
        signal: stripeRequestSignal(),
        headers: {
          Authorization: `Bearer ${this.binding.stripeKey}`,
          "Stripe-Version": STRIPE_API_VERSION,
          ...(this.binding.chargeMode === "merchant_direct" && !platform
            ? { "Stripe-Account": this.binding.accountId }
            : {}),
          ...(form
            ? {
              "Content-Type": "application/x-www-form-urlencoded",
              "Idempotency-Key": key!,
            }
            : {}),
        },
        ...(form ? { body: new URLSearchParams(form) } : {}),
      });
    } catch {
      throw new RequestError(
        503,
        "provider_unavailable",
        "Payment verification is temporarily unavailable. Retry the same request.",
      );
    }
    if (!response.ok) {
      throw new RequestError(
        response.status === 404 || response.status === 400 ? 409 : 503,
        "provider_request_rejected",
        "The payment provider could not complete this request. Retry the same operation after checking its status.",
      );
    }
    const value: unknown = await response.json();
    if (!object(value)) mismatch();
    return value;
  }
  async verifyAccount(requireCharges = false) {
    let platformCountry: unknown;
    if (this.binding.chargeMode === "merchant_direct") {
      const platform = await this.request(
        "account",
        undefined,
        undefined,
        true,
      );
      platformCountry = platform.country;
      if (
        !this.binding.platformAccountId ||
        this.binding.accountId === this.binding.platformAccountId ||
        platform.id !== this.binding.platformAccountId ||
        (await this.request("balance", undefined, undefined, true)).livemode !==
          this.binding.livemode
      ) mismatch();
    }
    const account = await this.request("account");
    if (account.id !== this.binding.accountId) {
      mismatch();
    }
    if (
      requireCharges && this.binding.chargeMode === "merchant_direct" &&
      (account.type !== "standard" || account.charges_enabled !== true ||
        account.details_submitted !== true)
    ) {
      reject(
        "merchant_payments_unavailable",
        "The merchant must finish Stripe payment setup.",
        409,
      );
    }
    if (
      requireCharges && this.binding.chargeMode === "merchant_direct" &&
      account.country === "BR" && platformCountry !== "BR"
    ) {
      reject(
        "merchant_fee_country_unsupported",
        "Stripe does not support collecting this merchant's commission through the connected platform. Choose a supported merchant connection before enabling checkout.",
        409,
      );
    }
  }
  expectedFee(order: ManagedOrder): number {
    if (
      order.account_id !== this.binding.accountId ||
      order.livemode !== this.binding.livemode ||
      order.product_id !== this.binding.productId ||
      order.funnel_id !== this.binding.funnelId ||
      order.binding_id !== this.binding.id
    ) mismatch();
    if (this.binding.chargeMode !== "merchant_direct") {
      if (
        order.charge_mode === "merchant_direct" ||
        Number(order.application_fee_amount ?? 0) !== 0
      ) mismatch();
      return 0;
    }
    if (
      order.charge_mode !== "merchant_direct" ||
      order.platform_account_id !== this.binding.platformAccountId ||
      !Number.isSafeInteger(order.application_fee_amount) ||
      Number(order.application_fee_amount) < 0 ||
      Number(order.application_fee_amount) >= order.amount_minor
    ) mismatch();
    return Number(order.application_fee_amount);
  }
  async verifyPrice(offer: Json) {
    const p = await this.request(
      `prices/${id(offer.stripe_price_id, "price")}`,
    );
    if (
      p.id !== offer.stripe_price_id || p.livemode !== this.binding.livemode ||
      p.active !== true || p.type !== "one_time" || p.recurring != null ||
      p.unit_amount !== offer.unit_amount_minor ||
      String(p.currency).toUpperCase() !== offer.currency ||
      p.billing_scheme !== "per_unit" || p.transform_quantity != null
    ) mismatch();
  }
  metadata(order: ManagedOrder): Record<string, string> {
    const fee = this.expectedFee(order);
    return {
      purpose: "kma_managed_payment",
      order_id: order.external_order_id,
      kma_managed_attempt_id: order.attempt_id,
      kma_product_id: order.product_id,
      kma_funnel_id: order.funnel_id,
      kma_offer_key: order.offer_key,
      kma_offer_version: String(order.offer_version),
      stripe_account_id: this.binding.accountId,
      attribution_sha256: order.attribution_sha256,
      ...(this.binding.chargeMode === "merchant_direct"
        ? {
          charge_mode: "merchant_direct",
          platform_account_id: this.binding.platformAccountId!,
          application_fee_amount: String(fee),
        }
        : {}),
    };
  }
  checkMetadata(value: Json, order: ManagedOrder) {
    if (!object(value.metadata) || value.livemode !== this.binding.livemode) {
      mismatch();
    }
    for (const [key, expected] of Object.entries(this.metadata(order))) {
      if (value.metadata[key] !== expected) mismatch();
    }
  }
  canMutate(first: unknown) {
    const at = Date.parse(String(first));
    if (
      !Number.isFinite(at) || this.now() - at >= 23 * 60 * 60 * 1000 ||
      at > this.now() + 300000
    ) {
      reject(
        "manual_reconciliation_required",
        "The provider retry window has expired. Reconcile this operation before creating another payment.",
        409,
      );
    }
  }
  async pages(path: string, platform = false): Promise<Json[]> {
    const rows: Json[] = [];
    let cursor = "";
    for (let n = 0; n < 20; n++) {
      const list = await this.request(
        path + (cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""),
        undefined,
        undefined,
        platform,
      );
      if (!Array.isArray(list.data) || list.data.some((v) => !object(v))) {
        mismatch();
      }
      rows.push(...list.data as Json[]);
      if (list.has_more !== true) return rows;
      if (!list.data.length) break;
      cursor = String((list.data.at(-1) as Json).id);
    }
    throw new RequestError(
      503,
      "provider_history_incomplete",
      "Provider history needs further reconciliation.",
    );
  }
  async recover(order: ManagedOrder): Promise<Json | null> {
    if (order.checkout_session_id) {
      return await this.request(
        `checkout/sessions/${id(order.checkout_session_id, "cs")}`,
      );
    }
    if (!order.first_attempt_at) return null;
    const from = Math.floor(Date.parse(order.first_attempt_at) / 1000) - 60;
    const list = await this.pages(
      `checkout/sessions?limit=100&created%5Bgte%5D=${from}`,
    );
    const matches = list.filter((s) =>
      object(s.metadata) &&
      s.metadata.kma_managed_attempt_id === order.attempt_id
    );
    if (matches.length > 1) {
      reject(
        "multiple_checkout_sessions",
        "Multiple provider sessions require reconciliation.",
        409,
      );
    }
    return matches[0] ?? null;
  }
  async create(order: ManagedOrder, firstAttemptAt: string): Promise<Json> {
    const fee = this.expectedFee(order);
    await this.verifyAccount(true);
    const recovered = await this.recover({
      ...order,
      first_attempt_at: firstAttemptAt,
    });
    if (recovered) return recovered;
    this.canMutate(firstAttemptAt);
    await this.verifyPrice({
      stripe_price_id: order.stripe_price_id,
      unit_amount_minor: order.amount_minor,
      currency: order.currency,
    });
    if (Date.parse(order.expires_at) < this.now() + 30 * 60 * 1000) {
      reject(
        "reservation_expired",
        "The reservation no longer has enough time for a new checkout.",
        409,
      );
    }
    const form: Record<string, string> = {
      mode: "payment",
      "line_items[0][price]": order.stripe_price_id,
      "line_items[0][quantity]": "1",
      success_url: order.request.success_url!,
      cancel_url: order.request.cancel_url!,
      client_reference_id: order.external_order_id,
      expires_at: String(Math.floor(Date.parse(order.expires_at) / 1000)),
      "payment_method_types[0]": "card",
    };
    if (order.request.customer_email) {
      form.customer_email = order.request.customer_email;
    }
    if (this.binding.chargeMode === "merchant_direct" && fee > 0) {
      // Standard-account direct charges do not inherit platform pricing rules.
      // Omit a zero fee; Stripe requires a positive application fee when set.
      form["payment_intent_data[application_fee_amount]"] = String(fee);
    }
    for (const [k, v] of Object.entries(this.metadata(order))) {
      form[`metadata[${k}]`] = v;
      form[`payment_intent_data[metadata][${k}]`] = v;
    }
    return await this.request(
      "checkout/sessions",
      form,
      `kma-managed-create:${order.id}`,
    );
  }
  async expire(order: ManagedOrder, operation: Json): Promise<Json> {
    await this.verifyAccount();
    const s = await this.recover(order);
    if (!s) {
      reject(
        "checkout_pending",
        "The original checkout must be reconciled first.",
        409,
      );
    }
    this.checkMetadata(s, order);
    if (s.status !== "open") return s;
    this.canMutate(operation.first_attempt_at);
    return await this.request(
      `checkout/sessions/${id(s.id, "cs")}/expire`,
      {},
      `kma-managed-expire:${operation.id}`,
    );
  }
  async refund(order: ManagedOrder, operation: Json): Promise<Json> {
    await this.verifyAccount();
    const payment = await this.request(
      `payment_intents/${id(order.payment_intent_id, "pi")}`,
    );
    this.checkPayment(payment, order);
    const refunds = await this.pages(
      `refunds?payment_intent=${id(order.payment_intent_id, "pi")}&limit=100`,
    );
    const matches = refunds.filter((r) =>
      object(r.metadata) && r.metadata.kma_operation_id === operation.id
    );
    if (matches.length > 1) mismatch();
    const amount = Number(
      operation.amount_minor ?? (operation.request as Json).amount_minor,
    );
    let refund = matches[0];
    if (!refund) {
      this.canMutate(operation.first_attempt_at);
      refund = await this.request("refunds", {
        payment_intent: order.payment_intent_id!,
        amount: String(amount),
        "metadata[purpose]": "kma_managed_payment",
        "metadata[order_id]": order.external_order_id,
        "metadata[kma_managed_attempt_id]": order.attempt_id,
        "metadata[kma_operation_id]": String(operation.id),
      }, `kma-managed-refund:${operation.id}`);
    }
    id(refund.id, "re");
    if (
      refund.amount !== amount ||
      oid(refund.payment_intent) !== order.payment_intent_id ||
      String(refund.currency).toUpperCase() !== order.currency ||
      (refund.livemode !== undefined && refund.livemode !== order.livemode) ||
      !object(refund.metadata) ||
      refund.metadata.purpose !== "kma_managed_payment" ||
      refund.metadata.order_id !== order.external_order_id ||
      refund.metadata.kma_managed_attempt_id !== order.attempt_id ||
      refund.metadata.kma_operation_id !== operation.id
    ) mismatch();
    return refund;
  }

  checkPayment(p: Json, order: ManagedOrder) {
    this.checkMetadata(p, order);
    const fee = this.expectedFee(order);
    if (
      p.id !== order.payment_intent_id || p.status !== "succeeded" ||
      p.amount !== order.amount_minor ||
      p.amount_received !== order.amount_minor ||
      String(p.currency).toUpperCase() !== order.currency ||
      p.transfer_data != null ||
      (this.binding.chargeMode === "merchant_direct"
        ? Number(p.application_fee_amount ?? 0) !== fee
        : p.application_fee_amount != null) ||
      p.on_behalf_of != null
    ) mismatch();
  }
  async snapshot(
    order: ManagedOrder,
    session?: Json,
    verifiedRefund?: Json,
  ): Promise<Json | null> {
    await this.verifyAccount();
    const s = session ?? await this.recover(order);
    if (!s) return null;
    this.checkMetadata(s, order);
    if (
      s.mode !== "payment" ||
      s.client_reference_id !== order.external_order_id ||
      s.amount_total !== order.amount_minor ||
      String(s.currency).toUpperCase() !== order.currency ||
      !["open", "complete", "expired"].includes(String(s.status)) ||
      !["unpaid", "paid"].includes(String(s.payment_status)) ||
      !Number.isSafeInteger(s.expires_at)
    ) mismatch();
    const expires = new Date(Number(s.expires_at) * 1000).toISOString();
    if (Date.parse(expires) > Date.parse(order.reservation_expires_at)) {
      mismatch();
    }
    let url: string | null = null;
    if (s.status === "open") {
      try {
        const u = new URL(String(s.url));
        if (
          u.origin !== "https://checkout.stripe.com" || u.username || u.password
        ) mismatch();
        url = u.href;
      } catch {
        mismatch();
      }
    }
    const paymentId = oid(s.payment_intent);
    if (paymentId != null) id(paymentId, "pi");
    const result: Json = {
      account_id: this.binding.accountId,
      livemode: this.binding.livemode,
      amount_minor: order.amount_minor,
      currency: order.currency,
      checkout_session_id: id(s.id, "cs"),
      checkout_url: url,
      expires_at: expires,
      session_status: s.status,
      payment_status: s.payment_status,
      payment_intent_id: paymentId ?? null,
      paid_at: null,
      facts: [],
      ...(this.binding.chargeMode === "merchant_direct"
        ? {
          charge_mode: "merchant_direct",
          platform_account_id: this.binding.platformAccountId,
          application_fee_amount: this.expectedFee(order),
          application_fee_id: null,
          application_fee_verified: false,
          application_fee_refunded_amount: 0,
        }
        : {}),
    };
    if (s.status !== "complete" || s.payment_status !== "paid") return result;
    const paidOrder = { ...order, payment_intent_id: String(paymentId) },
      p = await this.request(`payment_intents/${id(paymentId, "pi")}`);
    this.checkPayment(p, paidOrder);
    result.paid_at = timestamp(p.created);
    const chargeId = id(oid(p.latest_charge), "ch"),
      charge = await this.request(`charges/${chargeId}`);
    if (
      charge.id !== chargeId || charge.livemode !== this.binding.livemode ||
      oid(charge.payment_intent) !== paymentId ||
      charge.amount !== order.amount_minor || charge.paid !== true ||
      String(charge.currency).toUpperCase() !== order.currency
    ) mismatch();
    if (this.binding.chargeMode === "merchant_direct") {
      try {
        Object.assign(result, await this.feeSnapshot(order, charge));
      } catch (e) {
        // Fee creation is asynchronous. Persist independently verified buyer
        // payment truth while the commission remains unfunded and held.
        if (
          !(e instanceof RequestError) ||
          !["provider_unavailable", "provider_request_rejected"].includes(
            e.code,
          )
        ) throw e;
        result.application_fee_verified = false;
      }
    }
    const facts: Json[] = [];
    const refunds = await this.pages(
      `refunds?payment_intent=${id(paymentId, "pi")}&limit=100`,
    );
    if (verifiedRefund && !refunds.some((r) => r.id === verifiedRefund.id)) {
      refunds.push(verifiedRefund);
    }
    refunds.sort((a, b) =>
      Number(b.created) - Number(a.created) || (a.id === verifiedRefund?.id
        ? -1
        : b.id === verifiedRefund?.id
        ? 1
        : 0) ||
      (a.id === order.refund_id ? -1 : b.id === order.refund_id ? 1 : 0)
    );
    const refundOperations: Json[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const r of refunds) {
      const rid = id(r.id, "re");
      if (seen.has(rid)) mismatch();
      seen.add(rid);
      if (
        oid(r.payment_intent) !== paymentId || oid(r.charge) !== chargeId ||
        String(r.currency).toUpperCase() !== order.currency ||
        r.livemode !== undefined && r.livemode !== this.binding.livemode
      ) mismatch();
      if (
        !["succeeded", "pending", "requires_action", "failed", "canceled"]
          .includes(String(r.status))
      ) mismatch();
      const metadata = object(r.metadata) ? r.metadata : {};
      const operationId = metadata.purpose === "kma_managed_payment" &&
          metadata.order_id === order.external_order_id &&
          metadata.kma_managed_attempt_id === order.attempt_id &&
          UUID.test(String(metadata.kma_operation_id))
        ? metadata.kma_operation_id
        : null;
      if (operationId) {
        refundOperations.push({
          operation_id: operationId,
          refund_id: rid,
          status: r.status,
          amount_minor: r.amount,
        });
      }
      if (!result.refund_id) {
        result.refund_operation_id = operationId;
        result.refund_id = rid;
        result.refund_status = r.status;
        result.refund_created_at = timestamp(r.created);
      }
      if (r.status !== "succeeded") continue;
      if (!Number.isSafeInteger(r.amount) || Number(r.amount) <= 0) mismatch();
      total += Number(r.amount);
      facts.push({
        kind: "refund",
        provider_key: rid,
        evidence: {
          refund_id: rid,
          amount_minor: r.amount,
          occurred_at: timestamp(r.created),
        },
      });
    }
    if (total !== charge.amount_refunded || total > order.amount_minor) {
      mismatch();
    }
    const disputes = await this.pages(
      `disputes?payment_intent=${id(paymentId, "pi")}&limit=100`,
    );
    if (disputes.length > 1) {
      reject(
        "dispute_requires_review",
        "Multiple disputes require manual review.",
        409,
      );
    }
    for (const d of disputes) {
      const did = id(d.id, "dp");
      if (
        oid(d.charge) !== chargeId || d.livemode !== this.binding.livemode ||
        !Number.isSafeInteger(d.amount) || Number(d.amount) <= 0 ||
        Number(d.amount) > order.amount_minor ||
        String(d.currency).toUpperCase() !== order.currency
      ) mismatch();
      const st = String(d.status),
        kind = st === "won" || st === "warning_closed"
          ? "dispute_won"
          : st === "lost"
          ? "dispute_lost"
          : [
              "needs_response",
              "under_review",
              "warning_needs_response",
              "warning_under_review",
            ].includes(st)
          ? "dispute_open"
          : null;
      if (!kind) mismatch();
      result.dispute_status = kind === "dispute_won"
        ? "won"
        : kind === "dispute_lost"
        ? "lost"
        : "open";
      facts.push({
        kind: "dispute",
        provider_key: `${did}:${kind}`,
        evidence: {
          dispute_id: did,
          kind,
          amount_minor: d.amount,
          occurred_at: timestamp(d.created),
        },
      });
    }
    result.facts = facts;
    result.refund_operations = refundOperations;
    return result;
  }
  async feeSnapshot(order: ManagedOrder, charge: Json): Promise<Json> {
    const amount = this.expectedFee(order), feeId = oid(charge.application_fee);
    if (amount === 0) {
      if (feeId != null || Number(charge.application_fee_amount ?? 0) !== 0) {
        mismatch();
      }
      return {
        application_fee_verified: true,
        application_fee_id: null,
        application_fee_refunded_amount: 0,
      };
    }
    if (feeId == null) return { application_fee_verified: false };
    const fee = await this.request(
      `application_fees/${id(feeId, "fee")}`,
      undefined,
      undefined,
      true,
    );
    if (
      fee.id !== feeId || oid(fee.account) !== order.account_id ||
      oid(fee.charge) !== charge.id ||
      fee.livemode !== order.livemode ||
      !Number.isSafeInteger(fee.amount) || Number(fee.amount) <= 0 ||
      !Number.isSafeInteger(fee.amount_refunded) ||
      Number(fee.amount_refunded) < 0 ||
      Number(fee.amount_refunded) > Number(fee.amount)
    ) mismatch();
    // A connected merchant can settle in a different currency. The customer
    // has still paid, but currency conversion needs separate funding review
    // before a creator award or an application-fee refund can be released.
    if (String(fee.currency).toUpperCase() !== order.currency) {
      return {
        application_fee_id: feeId,
        application_fee_verified: false,
        application_fee_review_reason: "application_fee_currency_review",
      };
    }
    if (fee.amount !== amount) mismatch();
    const balanceId = oid(fee.balance_transaction);
    if (balanceId == null) {
      return { application_fee_id: feeId, application_fee_verified: false };
    }
    const balance = await this.request(
      `balance_transactions/${id(balanceId, "txn")}`,
      undefined,
      undefined,
      true,
    );
    if (
      balance.id !== balanceId || oid(balance.source) !== feeId ||
      balance.type !== "application_fee" ||
      !Number.isSafeInteger(balance.amount) || Number(balance.amount) <= 0
    ) mismatch();
    if (String(balance.currency).toUpperCase() !== order.currency) {
      return {
        application_fee_id: feeId,
        application_fee_verified: false,
        application_fee_review_reason: "application_fee_currency_review",
      };
    }
    if (balance.amount !== amount) mismatch();
    return {
      application_fee_id: feeId,
      application_fee_verified: true,
      application_fee_refunded_amount: fee.amount_refunded,
    };
  }
  /** Fee refunds are separate from buyer refunds so the saved refund cutoff,
   * partial adjustments and lost disputes determine the exact returned fee. */
  async refundApplicationFee(
    order: ManagedOrder,
    operation: Json,
  ): Promise<Json> {
    if (
      this.binding.chargeMode !== "merchant_direct" ||
      !UUID.test(String(operation.id)) || operation.order_id !== order.id ||
      operation.application_fee_id !== order.application_fee_id ||
      !Number.isSafeInteger(operation.amount_minor) ||
      Number(operation.amount_minor) <= 0 ||
      !Number.isSafeInteger(operation.prior_refunded_amount) ||
      Number(operation.prior_refunded_amount) < 0 ||
      operation.target_refunded_amount !==
        Number(operation.prior_refunded_amount) +
          Number(operation.amount_minor) ||
      Number(operation.target_refunded_amount) > this.expectedFee(order)
    ) mismatch();
    await this.verifyAccount();
    const payment = await this.request(
      `payment_intents/${id(order.payment_intent_id, "pi")}`,
    );
    this.checkPayment(payment, order);
    const charge = await this.request(
      `charges/${id(oid(payment.latest_charge), "ch")}`,
    );
    if (
      oid(charge.payment_intent) !== order.payment_intent_id ||
      charge.amount !== order.amount_minor ||
      charge.livemode !== order.livemode || charge.paid !== true ||
      String(charge.currency).toUpperCase() !== order.currency
    ) mismatch();
    const before = await this.feeSnapshot(order, charge);
    if (
      !before.application_fee_verified ||
      before.application_fee_id !== operation.application_fee_id
    ) mismatch();
    const path = `application_fees/${
      id(operation.application_fee_id, "fee")
    }/refunds`;
    const matches = (await this.pages(`${path}?limit=100`, true)).filter((r) =>
      object(r.metadata) && r.metadata.kma_fee_operation_id === operation.id
    );
    if (matches.length > 1) mismatch();
    let refund = matches[0];
    if (!refund) {
      if (
        before.application_fee_refunded_amount !==
          operation.prior_refunded_amount
      ) {
        reject(
          "fee_refund_requires_review",
          "The application fee was adjusted outside this operation. Reconcile it before continuing.",
          409,
        );
      }
      this.canMutate(operation.first_attempt_at);
      refund = await this.request(
        path,
        {
          amount: String(operation.amount_minor),
          "metadata[kma_fee_operation_id]": String(operation.id),
          "metadata[kma_managed_order_id]": order.id,
        },
        `kma-fee-refund:${operation.id}`,
        true,
      );
    }
    if (
      oid(refund.fee) !== operation.application_fee_id ||
      !Number.isSafeInteger(refund.amount) || Number(refund.amount) <= 0 ||
      !/^[a-z]{3}$/.test(String(refund.currency)) ||
      (String(refund.currency).toUpperCase() === order.currency &&
        refund.amount !== operation.amount_minor) ||
      !object(refund.metadata) ||
      refund.metadata.kma_fee_operation_id !== operation.id ||
      refund.metadata.kma_managed_order_id !== order.id
    ) mismatch();
    // Stripe may express the refund object in the merchant's settlement
    // currency. The linked platform balance debit proves the canonical fee
    // amount; do not compare converted minor units or infer an exchange rate.
    if (!refund.balance_transaction) {
      reject(
        "fee_refund_pending",
        "The fee refund is awaiting platform balance evidence.",
        503,
      );
    }
    const refundBalanceId = id(oid(refund.balance_transaction), "txn");
    const refundBalance = await this.request(
      `balance_transactions/${refundBalanceId}`,
      undefined,
      undefined,
      true,
    );
    if (
      refundBalance.id !== refundBalanceId ||
      refundBalance.type !== "application_fee_refund" ||
      oid(refundBalance.source) !== operation.application_fee_id ||
      String(refundBalance.currency).toUpperCase() !== order.currency ||
      refundBalance.amount !== -Number(operation.amount_minor)
    ) mismatch();
    const after = await this.feeSnapshot(order, charge);
    if (
      after.application_fee_verified !== true ||
      after.application_fee_id !== operation.application_fee_id ||
      !Number.isSafeInteger(after.application_fee_refunded_amount) ||
      Number(after.application_fee_refunded_amount) <
        Number(operation.target_refunded_amount)
    ) {
      reject(
        "fee_refund_pending",
        "The fee refund is awaiting provider reconciliation.",
        503,
      );
    }
    return {
      refund_id: id(refund.id, "fr"),
      application_fee_id: operation.application_fee_id,
      amount_minor: -Number(refundBalance.amount),
      refunded_amount: after.application_fee_refunded_amount,
      currency: order.currency,
      livemode: order.livemode,
      platform_account_id: this.binding.platformAccountId,
      refund_amount: refund.amount,
      refund_currency: String(refund.currency).toUpperCase(),
      platform_balance_transaction_id: refundBalanceId,
    };
  }
  commerceBinding(order: ManagedOrder): CommerceBinding {
    return {
      secret: this.binding.secret,
      productId: this.binding.productId,
      funnelId: this.binding.funnelId,
      accountId: this.binding.accountId,
      livemode: this.binding.livemode,
      stripeReadKey: this.binding.stripeKey,
      metadataPurpose: "kma_managed_payment",
      ...(this.binding.chargeMode === "merchant_direct"
        ? {
          connectedAccount: true,
          applicationFeeAmount: this.expectedFee(order),
        }
        : {}),
    };
  }
  async commission(order: ManagedOrder): Promise<CommerceEvidence> {
    return await verifyCommerceWithStripe(
      {
        event_id: order.id,
        kind: "purchase",
        click_id: order.request.click_id!,
        occurred_at: order.paid_at!,
        order_id: order.external_order_id,
        checkout_session_id: order.checkout_session_id!,
        payment_intent_id: order.payment_intent_id!,
        account_id: order.account_id,
        livemode: order.livemode,
        amount_minor: order.amount_minor,
        currency: order.currency,
        attribution: order.request.attribution!,
      },
      this.commerceBinding(order),
      this.fetcher,
    );
  }
  async adjustment(order: ManagedOrder, fact: Json): Promise<Json> {
    const e = fact.evidence as Json;
    return {
      provider_event_id: `evt_managed${await attributionHash({
        account_id: order.account_id,
        livemode: order.livemode,
        payment_intent_id: order.payment_intent_id,
        kind: fact.kind,
        key: fact.provider_key,
      })}`,
      stripe_account_id: order.account_id,
      livemode: order.livemode,
      product_id: order.product_id,
      funnel_id: order.funnel_id,
      payment_intent_id: order.payment_intent_id,
      external_order_id: order.external_order_id,
      order_amount_minor: order.amount_minor,
      currency: order.currency,
      kind: fact.kind === "refund" ? "refund" : e.kind,
      amount_minor: e.amount_minor,
      occurred_at: e.occurred_at,
      ...(fact.kind === "refund"
        ? { refund_id: e.refund_id }
        : { dispute_id: e.dispute_id }),
      observed_at: new Date(this.now()).toISOString(),
      payload_sha256: await attributionHash(e),
    };
  }
}
