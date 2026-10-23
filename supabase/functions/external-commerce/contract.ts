import { ConfigurationError, RequestError } from "../_shared/errors.ts";
import { bytesToHex } from "../_shared/crypto.ts";

export interface CommerceBinding {
  secret: string;
  productId: string;
  funnelId: string;
  accountId: string;
  livemode: boolean;
  stripeReadKey: string;
  /** Server-owned product purpose; omitted legacy bindings retain their original contract. */
  metadataPurpose?: string;
  webhookSecret?: string;
  /** Internal managed-checkout proof, never accepted from external event input. */
  connectedAccount?: boolean;
  applicationFeeAmount?: number;
}
export interface CommerceInput {
  event_id: string;
  kind: "purchase" | "refund";
  click_id: string;
  occurred_at: string;
  order_id: string;
  checkout_session_id: string;
  payment_intent_id: string;
  account_id: string;
  livemode: boolean;
  amount_minor: number;
  currency: string;
  attribution: Record<string, string>;
  refund_id?: string;
}
export interface CommerceEvidence {
  input: CommerceInput;
  product_id: string;
  funnel_id: string;
  attribution_sha256: string;
  provider_occurred_at: string;
  basis_verified?: true;
  basis_policy?: "post_discount_excluding_tax_shipping";
  eligible_basis_minor?: number;
  cost_evidence?: {
    tax_minor: number;
    shipping_minor: number;
    fee_verified: boolean;
    fee_unavailable_reason?:
      | "provider_fee_pending"
      | "settlement_currency_mismatch"
      | "invalid_provider_fee_evidence";
    fee_minor?: number;
    fee_currency?: string;
    balance_transaction_id?: string;
    provider_charge_id?: string;
  };
}
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function invalid(): never {
  throw new RequestError(
    400,
    "invalid_commerce_event",
    "Check the external commerce event.",
  );
}
export function validateCommerce(value: unknown): CommerceInput {
  if (!record(value)) invalid();
  const allowed = new Set([
    "event_id",
    "kind",
    "click_id",
    "occurred_at",
    "order_id",
    "checkout_session_id",
    "payment_intent_id",
    "account_id",
    "livemode",
    "amount_minor",
    "currency",
    "attribution",
    "refund_id",
  ]);
  if (Object.keys(value).some((k) => !allowed.has(k))) invalid();
  if (
    !["purchase", "refund"].includes(String(value.kind)) ||
    !UUID.test(String(value.event_id)) || !UUID.test(String(value.order_id)) ||
    typeof value.click_id !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.click_id)
  ) invalid();
  for (
    const [key, pattern] of Object.entries({
      checkout_session_id: /^cs_[A-Za-z0-9_]+$/,
      payment_intent_id: /^pi_[A-Za-z0-9]+$/,
      account_id: /^acct_[A-Za-z0-9]+$/,
    })
  ) {
    if (
      typeof value[key] !== "string" || !pattern.test(value[key] as string)
    ) invalid();
  }
  if (
    typeof value.livemode !== "boolean" ||
    !Number.isSafeInteger(value.amount_minor) ||
    Number(value.amount_minor) <= 0 || typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency)
  ) invalid();
  if (
    typeof value.occurred_at !== "string" ||
    !Number.isFinite(Date.parse(value.occurred_at)) ||
    Date.parse(value.occurred_at) > Date.now() + 300_000
  ) invalid();
  if (
    (value.kind === "refund") !== (typeof value.refund_id === "string") ||
    value.refund_id !== undefined &&
      !/^re_[A-Za-z0-9]+$/.test(String(value.refund_id))
  ) invalid();
  const source = value.attribution;
  const sourceKeys = new Set([
    "status",
    "capturedAt",
    "kmaClick",
    "ref",
    "utmSource",
    "utmMedium",
    "utmCampaign",
    "utmContent",
  ]);
  if (
    !record(source) || source.kmaClick !== value.click_id ||
    Object.entries(source).some(([k, v]) =>
      !sourceKeys.has(k) || typeof v !== "string" || v.length > 200
    ) || source.status !== undefined && source.status !== "unverified"
  ) invalid();
  return value as unknown as CommerceInput;
}
export function commerceBindings(): ReadonlyMap<string, CommerceBinding> {
  try {
    const raw: unknown = JSON.parse(
      Deno.env.get("EXTERNAL_COMMERCE_HMAC_BINDINGS") ?? "{}",
    );
    if (!record(raw) || !Object.keys(raw).length) throw new Error();
    return new Map(
      Object.entries(raw).map(([key, value]) => {
        if (
          !/^[A-Za-z0-9_-]{1,64}$/.test(key) || !record(value) ||
          Object.keys(value).filter((name) =>
              !["metadata_purpose", "stripe_webhook_secret_env"].includes(name)
            )
              .sort().join(",") !==
            "funnel_id,livemode,product_id,secret,stripe_account_id,stripe_read_key" ||
          typeof value.secret !== "string" || value.secret.length < 32 ||
          !UUID.test(String(value.product_id)) ||
          !UUID.test(String(value.funnel_id)) ||
          typeof value.stripe_account_id !== "string" ||
          !/^acct_[A-Za-z0-9]+$/.test(value.stripe_account_id) ||
          typeof value.livemode !== "boolean" ||
          typeof value.stripe_read_key !== "string" ||
          !/^rk_(test|live)_[A-Za-z0-9]+$/.test(value.stripe_read_key) ||
          value.stripe_read_key.startsWith("rk_live_") !== value.livemode ||
          value.metadata_purpose !== undefined &&
            (typeof value.metadata_purpose !== "string" ||
              !/^[a-z][a-z0-9_]{2,79}$/.test(value.metadata_purpose)) ||
          value.stripe_webhook_secret_env !== undefined &&
            (typeof value.stripe_webhook_secret_env !== "string" ||
              !/^[A-Z][A-Z0-9_]+$/.test(value.stripe_webhook_secret_env) ||
              !(Deno.env.get(value.stripe_webhook_secret_env) ?? "").startsWith(
                "whsec_",
              ))
        ) throw new Error();
        return [key, {
          secret: value.secret,
          productId: String(value.product_id),
          funnelId: String(value.funnel_id),
          accountId: value.stripe_account_id,
          livemode: value.livemode,
          stripeReadKey: value.stripe_read_key,
          metadataPurpose: typeof value.metadata_purpose === "string"
            ? value.metadata_purpose
            : "speaksix_marathon",
          ...(typeof value.stripe_webhook_secret_env === "string"
            ? { webhookSecret: Deno.env.get(value.stripe_webhook_secret_env)! }
            : {}),
        }];
      }),
    );
  } catch {
    throw new ConfigurationError("External commerce is not configured.");
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
        [key, item],
      ) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
export async function attributionHash(value: unknown): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(value)),
      ),
    ),
  );
}
function rejectEvidence(): never {
  throw new RequestError(
    409,
    "payment_evidence_mismatch",
    "The provider evidence does not match the attributed order.",
  );
}
function objectId(value: unknown) {
  return typeof value === "string"
    ? value
    : record(value)
    ? value.id
    : undefined;
}
/** Stripe totals already include discounts. Remove all tax and the shipping
 * amount excluding its own tax, so shipping tax is not subtracted twice.
 * Missing historical totals remain unknown; they never become a guessed zero. */
export function verifiedCommissionBasis(
  session: Record<string, unknown>,
): Pick<
  CommerceEvidence,
  "basis_verified" | "basis_policy" | "eligible_basis_minor"
> {
  const details = session.total_details;
  const nonnegative = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (
    !record(details) || !nonnegative(session.amount_total) ||
    !nonnegative(details.amount_tax) || !nonnegative(details.amount_shipping)
  ) return {};
  let shippingExcludingTax = 0;
  if (session.shipping_cost == null) {
    if (details.amount_shipping !== 0) return {};
  } else {
    const shipping = session.shipping_cost;
    if (
      !record(shipping) || !nonnegative(shipping.amount_total) ||
      !nonnegative(shipping.amount_tax) ||
      shipping.amount_tax > shipping.amount_total ||
      shipping.amount_tax > details.amount_tax
    ) return {};
    shippingExcludingTax = shipping.amount_total - shipping.amount_tax;
  }
  const basis = session.amount_total - details.amount_tax -
    shippingExcludingTax;
  if (!Number.isSafeInteger(basis) || basis < 0) return {};
  return {
    basis_verified: true,
    basis_policy: "post_discount_excluding_tax_shipping",
    eligible_basis_minor: basis,
  };
}
/** Read-only Stripe verification. Fixed provider origin, no redirects or writes.
 * A restricted key for the separately approved SpeakSix merchant is required. */
export async function verifyCommerceWithStripe(
  input: CommerceInput,
  binding: CommerceBinding,
  fetcher: typeof fetch = fetch,
): Promise<CommerceEvidence> {
  if (
    binding.accountId !== input.account_id ||
    binding.livemode !== input.livemode
  ) rejectEvidence();
  async function read(path: string) {
    const response = await fetcher(`https://api.stripe.com/v1/${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${binding.stripeReadKey}`,
        "Stripe-Version": "2025-09-30.clover",
        ...(binding.connectedAccount
          ? { "Stripe-Account": binding.accountId }
          : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new RequestError(
        response.status === 404 ? 409 : 503,
        "provider_verification_unavailable",
        "Payment verification is temporarily unavailable.",
      );
    }
    const value: unknown = await response.json();
    if (!record(value)) rejectEvidence();
    return value;
  }
  const account = await read("account");
  if (account.id !== binding.accountId) rejectEvidence();
  const session = await read(
    `checkout/sessions/${encodeURIComponent(input.checkout_session_id)}`,
  );
  const payment = await read(
    `payment_intents/${encodeURIComponent(input.payment_intent_id)}`,
  );
  const digest = await attributionHash(input.attribution);
  for (const item of [session, payment]) {
    if (
      item.livemode !== binding.livemode || !record(item.metadata) ||
      item.metadata.purpose !==
        (binding.metadataPurpose ?? "speaksix_marathon") ||
      item.metadata.order_id !== input.order_id ||
      item.metadata.stripe_account_id !== binding.accountId ||
      item.metadata.attribution_sha256 !== digest
    ) rejectEvidence();
  }
  if (
    session.id !== input.checkout_session_id || session.mode !== "payment" ||
    session.status !== "complete" || session.payment_status !== "paid" ||
    session.client_reference_id !== input.order_id ||
    objectId(session.payment_intent) !== input.payment_intent_id ||
    session.amount_total !== input.amount_minor ||
    String(session.currency).toUpperCase() !== input.currency
  ) rejectEvidence();
  if (
    payment.id !== input.payment_intent_id || payment.status !== "succeeded" ||
    payment.amount_received !== input.amount_minor ||
    payment.amount !== input.amount_minor ||
    String(payment.currency).toUpperCase() !== input.currency ||
    payment.transfer_data != null ||
    (binding.connectedAccount
      ? (!Number.isSafeInteger(binding.applicationFeeAmount) ||
        Number(binding.applicationFeeAmount) < 0 ||
        Number(payment.application_fee_amount ?? 0) !==
          binding.applicationFeeAmount)
      : payment.application_fee_amount != null) ||
    payment.on_behalf_of != null
  ) rejectEvidence();
  const basis = verifiedCommissionBasis(session);
  let costEvidence: CommerceEvidence["cost_evidence"];
  if (basis.basis_verified && record(session.total_details)) {
    costEvidence = {
      tax_minor: Number(session.total_details.amount_tax),
      shipping_minor: (session.amount_total as number) -
        Number(session.total_details.amount_tax) - basis.eligible_basis_minor!,
      fee_verified: false,
      fee_unavailable_reason: "provider_fee_pending",
    };
    const chargeId = objectId(payment.latest_charge);
    if (typeof chargeId === "string" && /^ch_[A-Za-z0-9]+$/.test(chargeId)) {
      const charge = await read(`charges/${encodeURIComponent(chargeId)}`);
      if (
        charge.id !== chargeId || charge.livemode !== binding.livemode ||
        objectId(charge.payment_intent) !== input.payment_intent_id ||
        charge.paid !== true ||
        charge.amount !== input.amount_minor ||
        String(charge.currency).toUpperCase() !== input.currency
      ) rejectEvidence();
      const transactionId = objectId(charge.balance_transaction);
      if (
        typeof transactionId === "string" &&
        /^txn_[A-Za-z0-9]+$/.test(transactionId)
      ) {
        const balance = await read(
          `balance_transactions/${encodeURIComponent(transactionId)}`,
        );
        if (
          balance.id !== transactionId ||
          objectId(balance.source) !== chargeId ||
          !["charge", "payment"].includes(String(balance.type))
        ) rejectEvidence();
        // Settlement FX cannot be guessed back into the order currency. Missing
        // or differently denominated fees remain unknown and hold net earnings.
        if (
          String(balance.currency).toUpperCase() === input.currency &&
          balance.amount === input.amount_minor &&
          typeof balance.fee === "number" &&
          Number.isSafeInteger(balance.fee) && balance.fee >= 0 &&
          balance.net === input.amount_minor - balance.fee &&
          balance.fee <= input.amount_minor &&
          (balance.exchange_rate === null ||
            balance.exchange_rate === undefined || balance.exchange_rate === 1)
        ) {
          costEvidence = {
            tax_minor: costEvidence.tax_minor,
            shipping_minor: costEvidence.shipping_minor,
            fee_verified: true,
            fee_minor: balance.fee,
            fee_currency: input.currency,
            balance_transaction_id: transactionId,
            provider_charge_id: chargeId,
          };
        } else {
          costEvidence.fee_unavailable_reason =
            String(balance.currency).toUpperCase() !== input.currency
              ? "settlement_currency_mismatch"
              : "invalid_provider_fee_evidence";
        }
      }
    }
  }
  let occurred = payment.created;
  if (input.kind === "refund") {
    const refund = await read(
      `refunds/${encodeURIComponent(input.refund_id!)}`,
    );
    if (
      refund.id !== input.refund_id || refund.status !== "succeeded" ||
      objectId(refund.payment_intent) !== input.payment_intent_id ||
      refund.amount !== input.amount_minor ||
      String(refund.currency).toUpperCase() !== input.currency ||
      !record(refund.metadata) || refund.metadata.order_id !== input.order_id ||
      refund.metadata.purpose !==
        (binding.metadataPurpose ?? "speaksix_marathon")
    ) rejectEvidence();
    occurred = refund.created;
  }
  if (
    typeof occurred !== "number" || !Number.isSafeInteger(occurred) ||
    occurred <= 0 || occurred * 1000 > Date.now() + 300_000
  ) rejectEvidence();
  return {
    input,
    product_id: binding.productId,
    funnel_id: binding.funnelId,
    attribution_sha256: digest,
    provider_occurred_at: new Date(occurred * 1000).toISOString(),
    ...basis,
    ...(costEvidence ? { cost_evidence: costEvidence } : {}),
  };
}
