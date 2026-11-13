// RevenueCat and Adapty webhooks for in-app subscriptions (affiliate Phase 8).
//
// POST /functions/v1/program-store-webhook/revenuecat and /adapty. The merchant
// pastes the address and an Authorization header value the console showed once
// into the tool's webhook settings. This function never sees that value again
// in clear: it hashes the header of each call (SHA-256) and the database looks
// the connection up by the hash. The tool's body is turned into one plain shape
// and handed to record_program_store_event, which stores the call once per
// event ID and turns a purchase into a program sale when it can find the
// creator. Nothing else of the body is kept or logged: no app user ID, alias,
// email, device or attribution data leaves this function except the app user
// ID and aliases passed to that one call, used for a lookup and dropped.
//
// Fields read, as the tools document them:
//   RevenueCat (https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields):
//     event.id, type, app_user_id, original_app_user_id, aliases, environment,
//     store, product_id, transaction_id, original_transaction_id,
//     purchased_at_ms, currency, price, price_in_purchased_currency,
//     tax_percentage, commission_percentage, cancel_reason. Proceeds are
//     price * (1 - tax_percentage - commission_percentage), as RevenueCat's
//     taxes and commissions page says.
//   Adapty (https://adapty.io/docs/webhook-event-types-and-fields):
//     event_type, customer_user_id, profile_id, event_datetime and
//     event_properties.profile_event_id, environment, store, vendor_product_id,
//     transaction_id, original_transaction_id, purchase_date, currency,
//     price_local, price_usd, tax_amount_local, net_revenue_local,
//     net_revenue_usd, proceeds_local, proceeds_usd. Adapty's Save sends a POST
//     with the body {} to check the address: it is answered 200.
import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import { bytesToHex } from "../_shared/crypto.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireJsonContentType,
  requireMethod,
} from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";

const WORKER = "program-store-webhook";
const MAXIMUM_BODY_BYTES = 256 * 1024;
const MAXIMUM_AUTHORIZATION_LENGTH = 1024;
const MAXIMUM_ALIASES = 20;

type Json = Record<string, unknown>;

export type StoreProvider = "revenuecat" | "adapty";
export type StoreEventType =
  | "initial_purchase"
  | "renewal"
  | "refund"
  | "cancellation"
  | "other";
export type StoreName =
  | "app_store"
  | "play_store"
  | "stripe"
  | "amazon"
  | "other";

/** What record_program_store_event receives, besides the header hash and the tool. */
export interface NormalizedStoreEvent {
  event_id: string;
  type: StoreEventType;
  environment: "production" | "sandbox";
  app_user_id: string | null;
  aliases: string[];
  store: StoreName | null;
  product_id: string | null;
  transaction_id: string | null;
  original_transaction_id: string | null;
  /** Epoch seconds. */
  purchased_at: number | null;
  currency: string | null;
  amount_minor: number | null;
  tax_minor: number | null;
  store_fee_minor: number | null;
  usd: { amount_minor: number | null; proceeds_minor: number | null } | null;
  refunded_minor: number | null;
}

export interface StoreEventCall extends NormalizedStoreEvent {
  header_sha256: string;
  provider: StoreProvider;
}

export interface ProgramStoreLogEntry {
  level: "info" | "warning" | "error";
  worker: typeof WORKER;
  outcome: string;
  request_id: string;
  provider?: StoreProvider;
  event_type?: StoreEventType;
  database_code?: string;
}

export interface ProgramStoreWebhookDependencies {
  enabled: () => boolean;
  record: (call: StoreEventCall) => Promise<unknown>;
  log: (entry: ProgramStoreLogEntry) => void;
}

/** Digits after the decimal point, ISO 4217; every other currency has two. */
const MINOR_EXPONENT: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

function invalidEvent(): never {
  throw new RequestError(400, "invalid_event", "Invalid provider event.");
}

/** A string of 1 to 200 characters without control characters, else null. */
function text(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    return null;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return value;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A share of the price from 0 to 1, else null. */
function share(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
}

function currencyCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value)
    ? value.toUpperCase()
    : null;
}

/** A decimal price in minor units of its currency, its sign dropped. */
export function toMinor(
  value: unknown,
  currency: string | null,
): number | null {
  const number = finite(value);
  if (number === null || currency === null) return null;
  const minor = Math.round(
    Math.abs(number) * 10 ** (MINOR_EXPONENT[currency] ?? 2),
  );
  return Number.isSafeInteger(minor) ? minor : null;
}

/** ISO 8601 as Adapty writes it (2024-11-15T10:45:36.181000+0000), in epoch seconds. */
export function epochSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/
      .exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, zone] = match;
  let offsetMinutes = 0;
  if (zone && zone !== "Z") {
    const digits = zone.replace(":", "");
    offsetMinutes = (digits[0] === "-" ? -1 : 1) *
      (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5)));
  }
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - offsetMinutes * 60_000;
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

function aliasList(appUserId: string | null, values: unknown[]): string[] {
  const seen = new Set<string>(appUserId === null ? [] : [appUserId]);
  const list: string[] = [];
  for (const value of values) {
    const alias = text(value);
    if (alias === null || seen.has(alias)) continue;
    seen.add(alias);
    list.push(alias);
    if (list.length >= MAXIMUM_ALIASES) break;
  }
  return list;
}

const REVENUECAT_STORES: Readonly<Record<string, StoreName>> = {
  APP_STORE: "app_store",
  MAC_APP_STORE: "app_store",
  PLAY_STORE: "play_store",
  AMAZON: "amazon",
  STRIPE: "stripe",
};

/** Tax and the store's cut of an amount, never more than the amount together. */
function cut(
  amount: number | null,
  taxShare: number | null,
  feeShare: number | null,
): { tax: number | null; fee: number | null } {
  if (amount === null) return { tax: null, fee: null };
  const tax = taxShare === null
    ? null
    : Math.min(Math.round(amount * taxShare), amount);
  const fee = feeShare === null
    ? null
    : Math.min(Math.round(amount * feeShare), amount - (tax ?? 0));
  return { tax, fee };
}

/** A RevenueCat webhook body: {api_version, event}. */
export function normalizeRevenueCat(body: Json): NormalizedStoreEvent {
  const e = body.event;
  if (!isPlainObject(e)) invalidEvent();
  const eventId = text(e.id);
  if (eventId === null) invalidEvent();
  const local = finite(e.price_in_purchased_currency);
  const usdPrice = finite(e.price);
  let type: StoreEventType;
  switch (e.type) {
    case "INITIAL_PURCHASE":
    case "NON_RENEWING_PURCHASE":
      type = "initial_purchase";
      break;
    case "RENEWAL":
      type = "renewal";
      break;
    case "CANCELLATION":
      // A refund is a CANCELLATION with the reason CUSTOMER_SUPPORT and a
      // negative price.
      type = e.cancel_reason === "CUSTOMER_SUPPORT" || (local ?? 0) < 0 ||
          (usdPrice ?? 0) < 0
        ? "refund"
        : "cancellation";
      break;
    default:
      type = "other";
  }
  const rawStore = typeof e.store === "string" ? e.store : null;
  const store: StoreName | null = rawStore === null
    ? null
    : REVENUECAT_STORES[rawStore] ?? "other";
  const currency = currencyCode(e.currency);
  const appUserId = text(e.app_user_id);
  const purchasedMs = finite(e.purchased_at_ms);
  const event: NormalizedStoreEvent = {
    event_id: eventId,
    type,
    // The test store is never real money, whatever environment it names.
    environment: e.environment === "PRODUCTION" && rawStore !== "TEST_STORE"
      ? "production"
      : "sandbox",
    app_user_id: appUserId,
    aliases: aliasList(appUserId, [
      e.original_app_user_id,
      ...(Array.isArray(e.aliases) ? e.aliases : []),
    ]),
    store,
    product_id: text(e.product_id),
    transaction_id: text(e.transaction_id),
    original_transaction_id: text(e.original_transaction_id),
    purchased_at: purchasedMs !== null && purchasedMs > 0
      ? Math.floor(purchasedMs / 1000)
      : null,
    currency,
    amount_minor: null,
    tax_minor: null,
    store_fee_minor: null,
    usd: null,
    refunded_minor: null,
  };
  const taxShare = share(e.tax_percentage);
  const feeShare = share(e.commission_percentage);
  if (type === "initial_purchase" || type === "renewal") {
    event.amount_minor = toMinor(local, currency);
    const localCut = cut(event.amount_minor, taxShare, feeShare);
    event.tax_minor = localCut.tax;
    event.store_fee_minor = localCut.fee;
    if (usdPrice !== null) {
      event.usd = {
        amount_minor: toMinor(usdPrice, "USD"),
        proceeds_minor: taxShare !== null && feeShare !== null
          ? Math.max(
            Math.round(Math.abs(usdPrice) * (1 - taxShare - feeShare) * 100),
            0,
          )
          : null,
      };
    }
  } else if (type === "refund") {
    event.refunded_minor = toMinor(local, currency);
    if (usdPrice !== null) {
      event.usd = {
        amount_minor: toMinor(usdPrice, "USD"),
        proceeds_minor: null,
      };
    }
  }
  return event;
}

const ADAPTY_TYPES: Readonly<Record<string, StoreEventType>> = {
  subscription_started: "initial_purchase",
  trial_converted: "initial_purchase",
  non_subscription_purchase: "initial_purchase",
  subscription_renewed: "renewal",
  subscription_refunded: "refund",
  non_subscription_purchase_refunded: "refund",
  subscription_renewal_cancelled: "cancellation",
  trial_renewal_cancelled: "cancellation",
};

const ADAPTY_STORES: Readonly<Record<string, StoreName>> = {
  app_store: "app_store",
  play_store: "play_store",
  stripe: "stripe",
  amazon: "amazon",
};

/** An Adapty webhook body: the profile, event_type and event_properties. */
export function normalizeAdapty(body: Json): NormalizedStoreEvent {
  const p = body.event_properties;
  if (!isPlainObject(p)) invalidEvent();
  const eventId = text(p.profile_event_id);
  if (eventId === null) invalidEvent();
  const type: StoreEventType = typeof body.event_type === "string" &&
      Object.hasOwn(ADAPTY_TYPES, body.event_type)
    ? ADAPTY_TYPES[body.event_type]
    : "other";
  const rawStore = typeof p.store === "string" ? p.store : null;
  const currency = currencyCode(p.currency);
  const appUserId = text(body.customer_user_id);
  const event: NormalizedStoreEvent = {
    event_id: eventId,
    type,
    environment: p.environment === "Production" ? "production" : "sandbox",
    app_user_id: appUserId,
    aliases: aliasList(appUserId, [body.profile_id]),
    store: rawStore === null ? null : ADAPTY_STORES[rawStore] ?? "other",
    product_id: text(p.vendor_product_id),
    transaction_id: text(p.transaction_id),
    original_transaction_id: text(p.original_transaction_id),
    purchased_at: epochSeconds(p.purchase_date) ??
      epochSeconds(body.event_datetime),
    currency,
    amount_minor: null,
    tax_minor: null,
    store_fee_minor: null,
    usd: null,
    refunded_minor: null,
  };
  if (type === "initial_purchase" || type === "renewal") {
    const amount = toMinor(p.price_local, currency);
    // The tax is included in the price. Net revenue is the price after the
    // store's cut and the tax; the store's cut is what lies between them.
    const tax = amount === null ? null : (() => {
      const value = toMinor(p.tax_amount_local, currency);
      return value === null ? null : Math.min(value, amount);
    })();
    // Without net revenue, proceeds (after the cut, tax still inside) lose
    // the tax share the way Adapty computes net revenue from them.
    const untaxed = amount !== null && amount > 0 && tax !== null
      ? (amount - tax) / amount
      : 1;
    const netOf = (net: unknown, proceeds: unknown, code: string | null) => {
      const value = toMinor(net, code);
      if (value !== null) return value;
      const gross = toMinor(proceeds, code);
      return gross === null ? null : Math.round(gross * untaxed);
    };
    const net = netOf(p.net_revenue_local, p.proceeds_local, currency);
    event.amount_minor = amount;
    event.tax_minor = tax;
    event.store_fee_minor = amount === null || net === null
      ? null
      : Math.max(amount - (tax ?? 0) - Math.min(net, amount), 0);
    if (finite(p.price_usd) !== null) {
      event.usd = {
        amount_minor: toMinor(p.price_usd, "USD"),
        proceeds_minor: netOf(p.net_revenue_usd, p.proceeds_usd, "USD"),
      };
    }
  } else if (type === "refund") {
    event.refunded_minor = toMinor(p.price_local, currency);
    if (finite(p.price_usd) !== null) {
      event.usd = {
        amount_minor: toMinor(p.price_usd, "USD"),
        proceeds_minor: null,
      };
    }
  }
  return event;
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

function providerOf(url: string): StoreProvider | null {
  const last = new URL(url).pathname.split("/").filter(Boolean).pop();
  return last === "revenuecat" || last === "adapty" ? last : null;
}

function defaults(): ProgramStoreWebhookDependencies {
  return {
    enabled: () => Deno.env.get("PROGRAM_STORE_WEBHOOK_ENABLED") === "true",
    log: (entry) => console.log(JSON.stringify(entry)),
    record: async (call) => {
      const { data, error } = await serviceClient().rpc(
        "record_program_store_event",
        { p: call },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return data;
    },
  };
}

export function createProgramStoreWebhook(
  overrides: Partial<ProgramStoreWebhookDependencies> = {},
) {
  const deps: ProgramStoreWebhookDependencies = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    // Only values that passed their checks are ever logged.
    const seen: { provider?: StoreProvider; event_type?: StoreEventType } = {};
    const answer = (outcome: string, body: Json): Response => {
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
          "program_store_webhook_disabled",
          "This provider endpoint is not enabled.",
        );
      }
      const provider = providerOf(request.url);
      if (provider === null) {
        throw new RequestError(404, "unknown_provider", "Unknown provider.");
      }
      seen.provider = provider;
      const authorization = request.headers.get("authorization")?.trim() ?? "";
      if (authorization === "") {
        throw new RequestError(
          401,
          "missing_authorization",
          "Provider authentication is required.",
        );
      }
      if (authorization.length > MAXIMUM_AUTHORIZATION_LENGTH) {
        throw new RequestError(
          401,
          "unknown_connection",
          "Provider authentication failed.",
        );
      }

      const raw = await readRequestBytes(request, MAXIMUM_BODY_BYTES);
      let body: Json;
      try {
        const parsed: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
        );
        if (!isPlainObject(parsed)) throw new Error("not an object");
        body = parsed;
      } catch {
        invalidEvent();
      }
      // Adapty checks a new address with an empty object when the merchant saves.
      if (provider === "adapty" && Object.keys(body).length === 0) {
        return answer("verification", { verified: true });
      }
      const event = provider === "revenuecat"
        ? normalizeRevenueCat(body)
        : normalizeAdapty(body);
      seen.event_type = event.type;
      const outcome: unknown = await deps.record({
        ...event,
        header_sha256: await sha256Hex(authorization),
        provider,
      });
      if (
        !isPlainObject(outcome) || typeof outcome.outcome !== "string" ||
        typeof outcome.duplicate !== "boolean"
      ) throw new DatabaseBoundaryError();
      return answer(outcome.duplicate ? "duplicate" : outcome.outcome, {
        outcome: outcome.outcome,
        duplicate: outcome.duplicate,
      });
    } catch (caught) {
      const code = caught instanceof DatabaseBoundaryError
        ? caught.databaseCode
        : undefined;
      // An unknown or removed connection, and a body the database refused.
      const error = code === "28000"
        ? new RequestError(
          401,
          "unknown_connection",
          "Provider authentication failed.",
        )
        : code === "22023"
        ? new RequestError(400, "invalid_event", "Invalid provider event.")
        : caught;
      const response = errorResponse(error, rid, { "X-Request-ID": rid });
      deps.log({
        level: response.status >= 500 ? "error" : "warning",
        worker: WORKER,
        outcome: error instanceof RequestError
          ? error.code
          : error instanceof DatabaseBoundaryError
          ? error.code
          : response.status === 503
          ? "configuration_error"
          : "internal_error",
        request_id: rid,
        ...seen,
        ...(code && /^[0-9A-Z]{5}$/.test(code) ? { database_code: code } : {}),
      });
      return response;
    }
  };
}

export const handleProgramStoreWebhook = createProgramStoreWebhook();
if (import.meta.main) Deno.serve(handleProgramStoreWebhook);
