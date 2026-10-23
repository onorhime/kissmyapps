import { ConfigurationError, RequestError } from "../_shared/errors.ts";
import { UUID } from "../external-commerce/contract.ts";

export type Json = Record<string, unknown>;
export interface ManagedBinding {
  id: string;
  secret: string;
  productId: string;
  funnelId: string;
  accountId: string;
  livemode: boolean;
  stripeKey: string;
  webhookSecret: string;
  /** Connected-account destination secret, separate from platform events. */
  connectedWebhookSecret?: string;
  callbackUrl: string;
  callbackKeyId: string;
  callbackSecret: string;
  redirectOrigins: string[];
  /** The platform credential stays server-side; merchant scope comes from the DB. */
  chargeMode?: "merchant_direct";
  platformAccountId?: string;
  merchantId?: string;
}
export interface ManagedInput extends Json {
  action: "quote" | "create" | "status" | "expire" | "refund";
  offer_key?: string;
  offer_version?: number;
  request_id?: string;
  order_id?: string;
  attempt_id?: string;
  learner_id?: string;
  reservation_id?: string;
  reservation_expires_at?: string;
  checkout_expires_at?: string;
  amount_minor?: number;
  currency?: string;
  success_url?: string;
  cancel_url?: string;
  customer_email?: string;
  click_id?: string;
  attribution?: Record<string, string>;
  context?: Json;
  reason?: string;
  refund_remaining?: boolean;
}
export interface ManagedOrder extends Json {
  id: string;
  binding_id: string;
  external_order_id: string;
  attempt_id: string;
  product_id: string;
  funnel_id: string;
  account_id: string;
  livemode: boolean;
  learner_id: string;
  reservation_id: string;
  reservation_expires_at: string;
  context: Json;
  offer_key: string;
  offer_version: number;
  stripe_price_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  checkout_session_id: string | null;
  checkout_url: string | null;
  payment_intent_id: string | null;
  expires_at: string;
  session_status: string | null;
  payment_status: string | null;
  paid_at: string | null;
  refunded_amount_minor: number;
  refund_id: string | null;
  refund_status: string | null;
  dispute_status: string | null;
  duplicate_capture: boolean;
  revision: number;
  request: ManagedInput;
  created_at: string;
  first_attempt_at: string | null;
  attribution_sha256: string;
  charge_mode?: "platform" | "merchant_direct";
  platform_account_id?: string;
  merchant_id?: string;
  application_fee_amount?: number;
  application_fee_id?: string | null;
}
export const object = (v: unknown): v is Json =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function reject(
  code = "managed_request_invalid",
  message = "Check the payment request.",
  status = 400,
): never {
  throw new RequestError(status, code, message);
}
const opaque = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(v);
function exact(v: Json, keys: string[]) {
  if (Object.keys(v).some((k) => !keys.includes(k))) reject();
}
export function validateInput(
  value: unknown,
  binding: ManagedBinding,
  now = Date.now(),
): ManagedInput {
  if (!object(value)) reject();
  const v = value as ManagedInput;
  if (!["quote", "create", "status", "expire", "refund"].includes(v.action)) {
    reject();
  }
  if (v.action === "quote") {
    exact(v, ["action", "offer_key"]);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.offer_key ?? "")) reject();
    return v;
  }
  if (!UUID.test(v.order_id ?? "") || !UUID.test(v.attempt_id ?? "")) reject();
  if (v.action === "status") {
    exact(v, ["action", "order_id", "attempt_id"]);
    return v;
  }
  if (!UUID.test(v.request_id ?? "")) reject();
  if (v.action === "expire") {
    exact(v, ["action", "request_id", "order_id", "attempt_id"]);
    return v;
  }
  if (v.action === "refund") {
    if (v.refund_remaining !== undefined && v.refund_remaining !== true) {
      reject();
    }
    exact(v, [
      "action",
      "request_id",
      "order_id",
      "attempt_id",
      "amount_minor",
      "reason",
      "refund_remaining",
    ]);
    if (
      !Number.isSafeInteger(v.amount_minor) || v.amount_minor! < 1 ||
      typeof v.reason !== "string" || v.reason.length < 3 ||
      v.reason.length > 300
    ) reject();
    return v;
  }
  exact(v, [
    "action",
    "request_id",
    "order_id",
    "attempt_id",
    "learner_id",
    "reservation_id",
    "reservation_expires_at",
    "checkout_expires_at",
    "offer_key",
    "offer_version",
    "amount_minor",
    "currency",
    "success_url",
    "cancel_url",
    "customer_email",
    "click_id",
    "attribution",
    "context",
  ]);
  if (
    v.request_id !== v.attempt_id || !opaque(v.learner_id) ||
    !opaque(v.reservation_id) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.offer_key ?? "") ||
    !Number.isSafeInteger(v.offer_version) || v.offer_version! < 1 ||
    !Number.isSafeInteger(v.amount_minor) || v.amount_minor! < 1 ||
    v.amount_minor! > 99999999 || !/^[A-Z]{3}$/.test(v.currency ?? "")
  ) reject();
  // The reservation may expire later than Stripe's 24h session maximum. It must
  // have enough remaining lifetime for Stripe's minimum 30 minute checkout.
  if (
    typeof v.reservation_expires_at !== "string" ||
    !Number.isFinite(Date.parse(v.reservation_expires_at)) ||
    typeof v.checkout_expires_at !== "string" ||
    !Number.isFinite(Date.parse(v.checkout_expires_at)) ||
    Date.parse(v.checkout_expires_at) > Date.parse(v.reservation_expires_at)
  ) reject();
  if (!object(v.context)) reject();
  if (
    "purchase_id" in v.context || "intake_id" in v.context ||
    "terms_hash" in v.context
  ) {
    // An intake purchase can precede assessment and group placement. Bind it to
    // its immutable business order/terms, without inventing a cohort identity.
    exact(v.context, ["purchase_id", "intake_id", "terms_hash"]);
    if (
      !UUID.test(String(v.context.purchase_id)) ||
      !UUID.test(String(v.context.intake_id)) ||
      !/^[a-f0-9]{64}$/.test(String(v.context.terms_hash)) ||
      v.context.purchase_id !== v.order_id ||
      v.context.terms_hash !== v.reservation_id
    ) reject();
  } else {
    exact(v.context, ["calendar_hash", "registration_id", "cohort_id"]);
    if (
      !/^[a-f0-9]{64}$/.test(String(v.context.calendar_hash)) ||
      !UUID.test(String(v.context.registration_id)) ||
      !UUID.test(String(v.context.cohort_id))
    ) reject();
  }
  for (const key of ["success_url", "cancel_url"] as const) {
    let u: URL;
    try {
      u = new URL(v[key]!);
    } catch {
      reject();
    }
    if (
      !binding.redirectOrigins.includes(u.origin) || u.username || u.password ||
      u.hash || u.href.length > 2000 ||
      (!binding.livemode && u.protocol === "http:" &&
        !["localhost", "127.0.0.1"].includes(u.hostname)) ||
      binding.livemode && u.protocol !== "https:"
    ) {
      reject(
        "redirect_not_allowed",
        "The payment return address is not approved.",
      );
    }
  }
  if (
    v.customer_email !== undefined &&
    (typeof v.customer_email !== "string" || v.customer_email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.customer_email))
  ) reject();
  if (v.click_id !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(v.click_id)) {
    reject();
  }
  if (
    v.attribution !== undefined &&
    (!object(v.attribution) || Object.entries(v.attribution).some(([k, x]) =>
      ![
        "kmaClick",
        "status",
        "capturedAt",
        "ref",
        "utmSource",
        "utmMedium",
        "utmCampaign",
        "utmContent",
      ].includes(k) || typeof x !== "string" || x.length > 200
    ) || v.attribution.kmaClick !== v.click_id)
  ) reject();
  if (v.click_id && !v.attribution) reject();
  // Expiration is checked when preparing a NEW attempt, not here: a byte-exact
  // replay after expiry must recover its saved result without creating a session.
  void now;
  return v;
}
export function managedBindings(): Map<string, ManagedBinding> {
  const raw: unknown = JSON.parse(
    Deno.env.get("MANAGED_CHECKOUT_BINDINGS_JSON") ?? "{}",
  );
  if (!object(raw)) throw new ConfigurationError();
  return new Map(
    Object.entries(raw).map(([id, v]) => {
      if (
        !object(v) || !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
        !UUID.test(String(v.product_id)) || !UUID.test(String(v.funnel_id)) ||
        !/^acct_[A-Za-z0-9]+$/.test(String(v.account_id)) ||
        (v.charge_mode !== undefined && v.charge_mode !== "merchant_direct") ||
        (v.charge_mode === "merchant_direct" &&
          (!/^acct_[A-Za-z0-9]+$/.test(String(v.platform_account_id)) ||
            v.account_id !== v.platform_account_id)) ||
        typeof v.livemode !== "boolean" || typeof v.secret !== "string" ||
        v.secret.length < 32 || typeof v.callback_secret !== "string" ||
        v.callback_secret.length < 32 ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(String(v.callback_key_id)) ||
        !Array.isArray(v.redirect_origins) || !v.redirect_origins.length
      ) throw new ConfigurationError();
      const stripeKey = Deno.env.get(String(v.stripe_key_env)) ?? "",
        webhookSecret = Deno.env.get(String(v.webhook_secret_env)) ?? "",
        connectedWebhookSecret = v.charge_mode === "merchant_direct"
          ? Deno.env.get(String(v.connect_webhook_secret_env)) ?? ""
          : undefined;
      if (
        !new RegExp(`^(?:sk|rk)_${v.livemode ? "live" : "test"}_[A-Za-z0-9]+$`)
          .test(stripeKey) ||
        !webhookSecret.startsWith("whsec_") ||
        (v.charge_mode === "merchant_direct" &&
          (!/^[A-Z][A-Z0-9_]{1,100}$/.test(
            String(v.connect_webhook_secret_env),
          ) ||
            !connectedWebhookSecret?.startsWith("whsec_") ||
            connectedWebhookSecret === webhookSecret))
      ) throw new ConfigurationError();
      const callback = new URL(String(v.callback_url));
      if (
        callback.username || callback.password || callback.hash ||
        (callback.protocol !== "https:" &&
          (v.livemode || callback.protocol !== "http:" ||
            !["localhost", "127.0.0.1"].includes(callback.hostname)))
      ) throw new ConfigurationError();
      const origins = v.redirect_origins.map((x) => {
        const u = new URL(String(x));
        if (
          u.origin !== x || u.username || u.password ||
          (u.protocol !== "https:" &&
            (v.livemode || !["localhost", "127.0.0.1"].includes(u.hostname)))
        ) throw new ConfigurationError();
        return u.origin;
      });
      return [id, {
        id,
        secret: v.secret,
        productId: String(v.product_id),
        funnelId: String(v.funnel_id),
        accountId: String(v.account_id),
        livemode: v.livemode,
        stripeKey,
        webhookSecret,
        callbackUrl: callback.href,
        callbackKeyId: String(v.callback_key_id),
        callbackSecret: v.callback_secret,
        redirectOrigins: origins,
        ...(v.charge_mode === "merchant_direct"
          ? {
            chargeMode: "merchant_direct" as const,
            platformAccountId: String(v.platform_account_id),
            connectedWebhookSecret,
          }
          : {}),
      }];
    }),
  );
}
export function publicOrder(order: ManagedOrder): Json {
  const keys = [
    "id",
    "external_order_id",
    "attempt_id",
    "product_id",
    "funnel_id",
    "account_id",
    "livemode",
    "learner_id",
    "reservation_id",
    "reservation_expires_at",
    "context",
    "offer_key",
    "offer_version",
    "amount_minor",
    "currency",
    "status",
    "checkout_session_id",
    "checkout_url",
    "payment_intent_id",
    "expires_at",
    "session_status",
    "payment_status",
    "paid_at",
    "refunded_amount_minor",
    "refund_id",
    "refund_status",
    "dispute_status",
    "duplicate_capture",
    "revision",
  ];
  return Object.fromEntries(keys.map((key) => [key, order[key]]));
}
