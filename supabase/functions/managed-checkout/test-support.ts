/** Synthetic transport only. Never imports a provider key or forwards network. */
import {
  type Json,
  type ManagedBinding,
  type ManagedInput,
  type ManagedOrder,
} from "./contract.ts";
export const fixtureBinding: ManagedBinding = {
  id: "managed-local",
  secret: "managed-local-inbound-secret-fixture-only",
  productId: "ac570000-0000-4000-8000-000000000001",
  funnelId: "ac570000-0000-4000-8000-000000000002",
  accountId: "acct_managedfixture",
  livemode: false,
  stripeKey: "sk_test_fixtureOnly",
  webhookSecret: "whsec_managed_fixture_only",
  callbackUrl: "http://127.0.0.1:3299/kma-events",
  callbackKeyId: "managed-callback",
  callbackSecret: "managed-local-outbound-secret-fixture-only",
  redirectOrigins: [
    "http://127.0.0.1:3299",
    "https://marathon.example.invalid",
  ],
};
export function fixtureInput(
  overrides: Partial<ManagedInput> = {},
): ManagedInput {
  return {
    action: "create",
    request_id: "ac570000-0000-4000-8000-000000000050",
    attempt_id: "ac570000-0000-4000-8000-000000000050",
    order_id: "ac570000-0000-4000-8000-000000000051",
    learner_id: "ac570000-0000-4000-8000-000000000052",
    reservation_id: "a".repeat(64),
    reservation_expires_at: new Date(Date.now() + 7200000).toISOString(),
    checkout_expires_at: new Date(Date.now() + 3600000).toISOString(),
    offer_key: "marathon",
    offer_version: 1,
    amount_minor: 16900,
    currency: "USD",
    success_url: "https://marathon.example.invalid/complete",
    cancel_url: "https://marathon.example.invalid/offer",
    context: {
      calendar_hash: "a".repeat(64),
      registration_id: "ac570000-0000-4000-8000-000000000053",
      cohort_id: "ac570000-0000-4000-8000-000000000054",
    },
    ...overrides,
  };
}
export function fixtureOrder(
  overrides: Partial<ManagedOrder> = {},
): ManagedOrder {
  const r = fixtureInput();
  return {
    id: "ac570000-0000-4000-8000-000000000055",
    binding_id: fixtureBinding.id,
    external_order_id: r.order_id!,
    attempt_id: r.attempt_id!,
    product_id: fixtureBinding.productId,
    funnel_id: fixtureBinding.funnelId,
    account_id: fixtureBinding.accountId,
    livemode: false,
    learner_id: r.learner_id!,
    reservation_id: r.reservation_id!,
    reservation_expires_at: r.reservation_expires_at!,
    context: r.context!,
    offer_key: r.offer_key!,
    offer_version: 1,
    stripe_price_id: "price_ManagedFixture169",
    amount_minor: 16900,
    currency: "USD",
    status: "creating",
    checkout_session_id: null,
    checkout_url: null,
    payment_intent_id: null,
    expires_at: r.checkout_expires_at!,
    session_status: null,
    payment_status: null,
    paid_at: null,
    refunded_amount_minor: 0,
    refund_id: null,
    refund_status: null,
    dispute_status: null,
    duplicate_capture: false,
    revision: 1,
    request: r,
    created_at: new Date().toISOString(),
    first_attempt_at: null,
    attribution_sha256: "a".repeat(64),
    ...overrides,
  };
}
export class FakeManagedStripe {
  readonly calls: {
    path: string;
    method: string;
    form: Record<string, string>;
    account?: string | null;
  }[] = [];
  readonly sessions = new Map<string, Json>();
  readonly payments = new Map<string, Json>();
  readonly charges = new Map<string, Json>();
  readonly balances = new Map<string, Json>();
  readonly refunds = new Map<string, Json>();
  readonly disputes = new Map<string, Json>();
  readonly fees = new Map<string, Json>();
  readonly feeRefunds = new Map<string, Json>();
  readonly receipts = new Map<string, Json>();
  accountId = fixtureBinding.accountId;
  platformAccountId: string | null = null;
  platformCountry = "US";
  merchantCountry = "US";
  chargesEnabled = true;
  livemode = false;
  priceId = "price_ManagedFixture169";
  priceAmount = 16900;
  priceCurrency = "usd";
  priceType = "one_time";
  failAfterCreate = false;
  failAfterRefund = false;
  failAfterFeeRefund = false;
  refundStatus = "succeeded";
  private sequence = 0;
  fetch: typeof fetch = async (input, init) => {
    // Keep the transport asynchronous so concurrency/retry tests do not hide
    // request interleaving behind a synchronously resolved in-memory provider.
    await Promise.resolve();
    const u = new URL(String(input));
    if (
      u.origin !== "https://api.stripe.com" || !u.pathname.startsWith("/v1/")
    ) throw Error("fixture refuses external network");
    const path = u.pathname.slice(4),
      method = init?.method ?? "GET",
      form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    const account = new Headers(init?.headers).get("Stripe-Account");
    this.calls.push({ path, method, form, account });
    if (
      new Headers(init?.headers).get("Authorization") !==
        `Bearer ${fixtureBinding.stripeKey}`
    ) return Response.json({ error: "fixture key required" }, { status: 401 });
    const reply = (v: unknown, status = 200) => Response.json(v, { status });
    const key = new Headers(init?.headers).get("Idempotency-Key");
    if (method === "POST" && key && this.receipts.has(key)) {
      return reply(this.receipts.get(key));
    }
    if (this.platformAccountId) {
      const platformPath = path === "balance" ||
        path.startsWith("application_fees/") ||
        path.startsWith("balance_transactions/txn_fee");
      if (
        account && account !== this.accountId || platformPath && account ||
        path !== "account" && !platformPath && account !== this.accountId
      ) return reply({}, 403);
    }
    if (path === "account") {
      return reply({
        id: this.platformAccountId && !account
          ? this.platformAccountId
          : this.accountId,
        charges_enabled: this.chargesEnabled,
        type: "standard",
        details_submitted: true,
        country: this.platformAccountId && !account
          ? this.platformCountry
          : this.merchantCountry,
      });
    }
    if (path === "balance") return reply({ livemode: this.livemode });
    if (path.startsWith("application_fees/")) {
      const fid = path.split("/")[1], fee = this.fees.get(fid);
      if (!fee) return reply({}, 404);
      if (path.endsWith("/refunds")) {
        if (method === "GET") {
          return reply({
            data: [...this.feeRefunds.values()].filter((r) => r.fee === fid),
            has_more: false,
          });
        }
        const amount = Number(form.amount);
        if (Number(fee.amount_refunded) + amount > Number(fee.amount)) {
          return reply({}, 400);
        }
        const r = {
          id: `fr_managed${++this.sequence}`,
          fee: fid,
          amount,
          currency: fee.currency,
          balance_transaction: `txn_fee_refund${this.sequence}`,
          metadata: Object.fromEntries(
            Object.entries(form).filter(([k]) => k.startsWith("metadata[")).map(
              ([k, v]) => [k.slice(9, -1), v],
            ),
          ),
        };
        this.balances.set(r.balance_transaction, {
          id: r.balance_transaction,
          type: "application_fee_refund",
          source: fid,
          amount: -amount,
          currency: fee.currency,
          net: -amount,
          fee: 0,
        });
        this.feeRefunds.set(r.id, r);
        fee.amount_refunded = Number(fee.amount_refunded) + amount;
        if (key) this.receipts.set(key, r);
        if (this.failAfterFeeRefund) {
          this.failAfterFeeRefund = false;
          throw Error("fixture lost fee refund reply");
        }
        return reply(r);
      }
      return reply(fee);
    }
    if (path.startsWith("prices/")) {
      return reply({
        id: this.priceId,
        livemode: this.livemode,
        active: true,
        type: this.priceType,
        recurring: this.priceType === "one_time" ? null : { interval: "month" },
        unit_amount: this.priceAmount,
        currency: this.priceCurrency,
        billing_scheme: "per_unit",
        transform_quantity: null,
      });
    }
    if (path === "checkout/sessions" && method === "POST") {
      const n = ++this.sequence,
        id = `cs_test_managed${n}`,
        metadata = Object.fromEntries(
          Object.entries(form).filter(([k]) => k.startsWith("metadata[")).map((
            [k, v],
          ) => [k.slice(9, -1), v]),
        );
      const s: Json = {
        id,
        object: "checkout.session",
        mode: form.mode,
        status: "open",
        payment_status: "unpaid",
        payment_intent: null,
        client_reference_id: form.client_reference_id,
        amount_total: this.priceAmount,
        amount_subtotal: this.priceAmount,
        currency: this.priceCurrency,
        livemode: this.livemode,
        expires_at: Number(form.expires_at),
        url: `https://checkout.stripe.com/c/pay/${id}`,
        metadata,
        application_fee_amount:
          form["payment_intent_data[application_fee_amount]"] === undefined
            ? null
            : Number(form["payment_intent_data[application_fee_amount]"]),
        total_details: {
          amount_tax: 0,
          amount_shipping: 0,
          amount_discount: 0,
        },
        created: Math.floor(Date.now() / 1000),
      };
      this.sessions.set(id, s);
      if (key) this.receipts.set(key, s);
      if (this.failAfterCreate) {
        this.failAfterCreate = false;
        throw Error("fixture lost reply");
      }
      return reply(s);
    }
    if (path === "checkout/sessions") {
      return reply({ data: [...this.sessions.values()], has_more: false });
    }
    if (path.startsWith("checkout/sessions/")) {
      const sid = path.split("/")[2], s = this.sessions.get(sid);
      if (!s) return reply({}, 404);
      if (path.endsWith("/expire") && method === "POST") {
        if (s.status === "open") s.status = "expired";
        if (key) this.receipts.set(key, s);
      }
      return reply(s);
    }
    if (path.startsWith("payment_intents/")) {
      return this.payments.has(path.slice(16))
        ? reply(this.payments.get(path.slice(16)))
        : reply({}, 404);
    }
    if (path.startsWith("charges/")) {
      return this.charges.has(path.slice(8))
        ? reply(this.charges.get(path.slice(8)))
        : reply({}, 404);
    }
    if (path.startsWith("balance_transactions/")) {
      return this.balances.has(path.slice(21))
        ? reply(this.balances.get(path.slice(21)))
        : reply({}, 404);
    }
    if (path === "refunds" && method === "POST") {
      const p = this.payments.get(form.payment_intent);
      if (!p) return reply({}, 404);
      const n = ++this.sequence,
        rid = `re_managed${n}`,
        charge = this.charges.get(String(p.latest_charge))!;
      const amount = Number(form.amount);
      if (Number(charge.amount_refunded) + amount > Number(charge.amount)) {
        return reply({}, 400);
      }
      const r: Json = {
        id: rid,
        object: "refund",
        livemode: this.livemode,
        status: this.refundStatus,
        payment_intent: p.id,
        charge: charge.id,
        amount,
        currency: p.currency,
        created: Math.floor(Date.now() / 1000),
        metadata: Object.fromEntries(
          Object.entries(form).filter(([k]) => k.startsWith("metadata[")).map((
            [k, v],
          ) => [k.slice(9, -1), v]),
        ),
      };
      this.refunds.set(rid, r);
      if (this.refundStatus === "succeeded") {
        charge.amount_refunded = Number(charge.amount_refunded) + amount;
      }
      if (key) this.receipts.set(key, r);
      if (this.failAfterRefund) {
        this.failAfterRefund = false;
        throw Error("fixture lost refund reply");
      }
      return reply(r);
    }
    if (path === "refunds") {
      return reply({
        data: [...this.refunds.values()].filter((r) =>
          !u.searchParams.get("payment_intent") ||
          r.payment_intent === u.searchParams.get("payment_intent")
        ),
        has_more: false,
      });
    }
    if (path.startsWith("refunds/")) {
      return this.refunds.has(path.slice(8))
        ? reply(this.refunds.get(path.slice(8)))
        : reply({}, 404);
    }
    if (path === "disputes") {
      return reply({
        data: [...this.disputes.values()].filter((d) =>
          !u.searchParams.get("payment_intent") ||
          d.payment_intent === u.searchParams.get("payment_intent")
        ),
        has_more: false,
      });
    }
    if (path.startsWith("disputes/")) {
      return this.disputes.has(path.slice(9))
        ? reply(this.disputes.get(path.slice(9)))
        : reply({}, 404);
    }
    return reply({ error: "unexpected fixture route" }, 404);
  };
  pay(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw Error("unknown session");
    if (s.payment_intent) return String(s.payment_intent);
    const n = ++this.sequence,
      pid = `pi_managed${n}`,
      cid = `ch_managed${n}`,
      tid = `txn_managed${n}`,
      created = Math.floor(Date.now() / 1000);
    s.status = "complete";
    s.payment_status = "paid";
    s.payment_intent = pid;
    this.payments.set(pid, {
      id: pid,
      object: "payment_intent",
      status: "succeeded",
      livemode: this.livemode,
      amount: this.priceAmount,
      amount_received: this.priceAmount,
      currency: this.priceCurrency,
      metadata: s.metadata,
      latest_charge: cid,
      created,
      transfer_data: null,
      application_fee_amount: s.application_fee_amount,
      on_behalf_of: null,
    });
    this.charges.set(cid, {
      id: cid,
      object: "charge",
      livemode: this.livemode,
      paid: true,
      amount: this.priceAmount,
      amount_refunded: 0,
      payment_intent: pid,
      currency: this.priceCurrency,
      balance_transaction: tid,
    });
    this.balances.set(tid, {
      id: tid,
      type: "charge",
      source: cid,
      amount: this.priceAmount,
      fee: 520,
      net: this.priceAmount - 520,
      currency: this.priceCurrency,
      exchange_rate: null,
    });
    if (this.platformAccountId && Number(s.application_fee_amount) > 0) {
      const fid = `fee_managed${n}`, tid = `txn_fee${n}`;
      this.charges.get(cid)!.application_fee = fid;
      this.charges.get(cid)!.application_fee_amount = s.application_fee_amount;
      this.fees.set(fid, {
        id: fid,
        account: this.accountId,
        charge: cid,
        amount: s.application_fee_amount,
        amount_refunded: 0,
        currency: s.currency,
        livemode: this.livemode,
        balance_transaction: tid,
      });
      this.balances.set(tid, {
        id: tid,
        source: fid,
        type: "application_fee",
        amount: s.application_fee_amount,
        currency: s.currency,
      });
    }
    return pid;
  }
  dispute(paymentId: string, status = "needs_response") {
    const p = this.payments.get(paymentId);
    if (!p) throw Error("unknown payment");
    const existing = [...this.disputes.values()].find((d) =>
      d.payment_intent === paymentId
    );
    if (existing) {
      existing.status = status;
      return String(existing.id);
    }
    const did = `dp_managed${++this.sequence}`;
    this.disputes.set(did, {
      id: did,
      object: "dispute",
      livemode: this.livemode,
      charge: p.latest_charge,
      payment_intent: paymentId,
      amount: p.amount,
      currency: p.currency,
      status,
      created: Math.floor(Date.now() / 1000),
    });
    return did;
  }
}
