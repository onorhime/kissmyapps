// Every Stripe call of the three balance functions: on the KissMyApps platform's
// own live account (no Stripe-Account header), with the pinned API version, a
// timeout and, on every POST, an Idempotency-Key derived from the top-up or
// the balance account. Card numbers never reach this code: cards are entered
// on Stripe's hosted Checkout page, and only brand, last four digits and expiry
// are read back. Provider bodies are never returned or logged: callers get
// normalized facts or a StripeCallError with a short code.
import { ConfigurationError } from "../_shared/errors.ts";
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";
import { isPlainObject } from "../_shared/validation.ts";

type Json = Record<string, unknown>;

const API = "https://api.stripe.com/v1";
const CODE = /^[a-z][a-z0-9_]{1,59}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const STRIPE_ID = {
  customer: /^cus_[A-Za-z0-9]{1,250}$/,
  session: /^cs_[A-Za-z0-9_]{1,252}$/,
  intent: /^pi_[A-Za-z0-9_]{1,252}$/,
  setupIntent: /^seti_[A-Za-z0-9_]{1,250}$/,
  paymentMethod: /^pm_[A-Za-z0-9]{1,250}$/,
  charge: /^(?:ch|py)_[A-Za-z0-9_]{1,252}$/,
  dispute: /^(?:dp|du)_[A-Za-z0-9_]{1,252}$/,
} as const;

/**
 * Why a Stripe call did not give an answer to work with.
 *   unavailable: not reached, timed out, 5xx, rate limited or unreadable. For a
 *     POST the outcome is unknown: Stripe may have done it.
 *   rejected: Stripe refused the request (4xx). Nothing was done.
 *   card: Stripe tried the card and it failed (402).
 *   configuration: the platform key was refused.
 */
export class StripeCallError extends Error {
  constructor(
    readonly kind: "unavailable" | "rejected" | "card" | "configuration",
    readonly code: string,
    /** The PaymentIntent Stripe made for a failed charge, when it says so. */
    readonly paymentIntentId: string | null = null,
  ) {
    super(`Stripe call failed: ${kind}`);
    this.name = "StripeCallError";
  }
}

export interface CardFacts {
  payment_method_id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

/** A PaymentIntent as Stripe reports it, reduced to what settlement needs. */
export interface IntentFacts {
  id: string;
  livemode: boolean;
  status: string;
  amountMinor: number;
  receivedMinor: number;
  currency: string;
  customerId: string | null;
  /** The top-up id KissMyApps put in the metadata, when it is there. */
  topupId: string | null;
  /** The card that paid, when it is saved on the paying customer. */
  card: CardFacts | null;
  /** What has been refunded of the charge that paid, so far. */
  refundedMinor: number;
  /** Why the last attempt failed, as a code that is safe to show. */
  failureCode: string | null;
}

export interface SessionFacts {
  id: string;
  livemode: boolean;
  mode: string;
  status: string;
  paymentIntentId: string | null;
  setupIntentId: string | null;
}

export interface SetupFacts {
  id: string;
  livemode: boolean;
  status: string;
  customerId: string | null;
  accountId: string | null;
  card: CardFacts | null;
}

export interface DisputeFacts {
  id: string;
  livemode: boolean;
  status: string;
  paymentIntentId: string | null;
}

export interface ChargeFacts {
  id: string;
  livemode: boolean;
  paymentIntentId: string | null;
  refundedMinor: number;
}

/** What a top-up needs to be charged or paid for. */
export interface TopupToPay {
  topupId: string;
  accountId: string;
  programId: string;
  workspaceId: string;
  customerId: string;
  amountMinor: number;
  /** Three letters, as the database stores it (upper case). */
  currency: string;
}

// Decline reasons Stripe asks not to be passed on to the payer.
const HIDDEN_DECLINES = new Set([
  "fraudulent",
  "lost_card",
  "stolen_card",
  "merchant_blacklist",
  "pickup_card",
  "restricted_card",
  "security_violation",
]);

/**
 * The code kept for a failed charge: Stripe's decline code when the card was
 * declined, otherwise Stripe's error code. Reasons Stripe asks to keep from the
 * payer become a plain card_declined.
 */
export function failureCode(code: unknown, declineCode: unknown): string {
  const safe = (value: unknown): string | null =>
    typeof value === "string" && CODE.test(value) ? value : null;
  const decline = safe(declineCode);
  const error = safe(code);
  if (decline && HIDDEN_DECLINES.has(decline)) return "card_declined";
  if (decline && (error === null || error === "card_declined")) return decline;
  return error ?? decline ?? "card_declined";
}

/**
 * Checkout is limited to cards. The parameter that does this was renamed in
 * API version 2026-09-30: the pinned version decides which name is sent.
 */
export function cardOnlyParameter(
  version: string = STRIPE_API_VERSION,
): string {
  return version.slice(0, 10) >= "2026-09-30"
    ? "allowed_payment_method_types[0]"
    : "payment_method_types[0]";
}

function unreadable(): never {
  throw new StripeCallError("unavailable", "stripe_unreadable");
}
function whole(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) unreadable();
  return value as number;
}
function text(value: unknown): string {
  if (typeof value !== "string") unreadable();
  return value as string;
}
function identifier(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) unreadable();
  return value as string;
}
/** An id, whether Stripe sent it bare or as an expanded object. */
function reference(value: unknown, pattern: RegExp): string | null {
  const id = isPlainObject(value) ? value.id : value;
  return typeof id === "string" && pattern.test(id) ? id : null;
}
function metadataValue(value: unknown, key: string): string | null {
  if (!isPlainObject(value) || !isPlainObject(value.metadata)) return null;
  const found = value.metadata[key];
  return typeof found === "string" && UUID.test(found) ? found : null;
}

/** A saved card, only when it is a card saved on exactly this customer. */
function cardOf(method: unknown, customerId: string | null): CardFacts | null {
  if (
    !isPlainObject(method) || method.type !== "card" ||
    !isPlainObject(method.card) || customerId === null ||
    reference(method.customer, STRIPE_ID.customer) !== customerId
  ) return null;
  const { brand, last4, exp_month, exp_year } = method.card;
  if (
    typeof method.id !== "string" || !STRIPE_ID.paymentMethod.test(method.id) ||
    typeof brand !== "string" || !/^[a-z_]{1,30}$/.test(brand) ||
    typeof last4 !== "string" || !/^[0-9]{4}$/.test(last4) ||
    typeof exp_month !== "number" || !Number.isInteger(exp_month) ||
    exp_month < 1 || exp_month > 12 ||
    typeof exp_year !== "number" || !Number.isInteger(exp_year) ||
    exp_year < 2024 || exp_year > 2100
  ) return null;
  return { payment_method_id: method.id, brand, last4, exp_month, exp_year };
}

export function parseIntent(value: unknown): IntentFacts {
  if (!isPlainObject(value) || value.object !== "payment_intent") unreadable();
  const body = value as Json;
  if (typeof body.livemode !== "boolean") unreadable();
  const customerId = reference(body.customer, STRIPE_ID.customer);
  const failure = isPlainObject(body.last_payment_error)
    ? failureCode(
      body.last_payment_error.code,
      body.last_payment_error.decline_code,
    )
    : null;
  return {
    id: identifier(body.id, STRIPE_ID.intent),
    livemode: body.livemode as boolean,
    status: text(body.status),
    amountMinor: whole(body.amount),
    receivedMinor: whole(body.amount_received ?? 0),
    currency: text(body.currency).toUpperCase(),
    customerId,
    topupId: metadataValue(body, "kma_topup_id"),
    card: cardOf(body.payment_method, customerId),
    refundedMinor: isPlainObject(body.latest_charge)
      ? whole(body.latest_charge.amount_refunded ?? 0)
      : 0,
    failureCode: failure,
  };
}

export interface BalanceStripeOptions {
  fetcher?: typeof fetch;
  /** The pinned API version; tests pass another to check the guard. */
  version?: string;
}

/** The Stripe calls of the balance functions. Create one per request. */
export class BalanceStripe {
  private readonly fetcher: typeof fetch;
  private readonly version: string;

  constructor(
    private readonly secret: string,
    options: BalanceStripeOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.version = options.version ?? STRIPE_API_VERSION;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    params: readonly (readonly [string, string])[],
    idempotencyKey?: string,
  ): Promise<Json> {
    if (method === "POST" && !idempotencyKey) throw new ConfigurationError();
    const query = new URLSearchParams(params.map(([k, v]) => [k, v]));
    const url = method === "GET" && params.length > 0
      ? `${API}${path}?${query}`
      : `${API}${path}`;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.secret}`,
          "Stripe-Version": this.version,
          ...(method === "POST"
            ? {
              "Content-Type": "application/x-www-form-urlencoded",
              "Idempotency-Key": idempotencyKey as string,
            }
            : {}),
        },
        ...(method === "POST" ? { body: query } : {}),
        redirect: "error",
        signal: stripeRequestSignal(),
      });
    } catch {
      throw new StripeCallError("unavailable", "stripe_unreachable");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.ok) {
      if (!isPlainObject(body)) unreadable();
      return body as Json;
    }
    const error = isPlainObject(body) && isPlainObject(body.error)
      ? body.error
      : {};
    if (response.status === 401 || response.status === 403) {
      throw new StripeCallError("configuration", "stripe_key_refused");
    }
    if (response.status === 402) {
      throw new StripeCallError(
        "card",
        failureCode(error.code, error.decline_code),
        reference(error.payment_intent, STRIPE_ID.intent),
      );
    }
    // 409 is a request with the same Idempotency-Key still running.
    if (
      response.status === 409 || response.status === 429 ||
      response.status >= 500 || response.status < 400
    ) {
      throw new StripeCallError("unavailable", "stripe_unavailable");
    }
    throw new StripeCallError(
      "rejected",
      typeof error.code === "string" && CODE.test(error.code)
        ? error.code
        : "stripe_rejected",
    );
  }

  /** The Stripe customer of a balance account: the business, nobody's person. */
  async createCustomer(input: {
    accountId: string;
    programId: string;
    workspaceId: string;
    businessName: string;
  }): Promise<string> {
    const body = await this.request("POST", "/customers", [
      ["name", input.businessName.slice(0, 200)],
      ["metadata[kma_account_id]", input.accountId],
      ["metadata[kma_program_id]", input.programId],
      ["metadata[kma_workspace_id]", input.workspaceId],
    ], `kma-balance-customer-${input.accountId}`);
    if (body.livemode !== true) throw new ConfigurationError();
    return identifier(body.id, STRIPE_ID.customer);
  }

  private checkoutSession(body: Json, mode: string, customerId: string): {
    id: string;
    url: string;
  } {
    if (body.livemode !== true) throw new ConfigurationError();
    const id = identifier(body.id, STRIPE_ID.session);
    let url: URL;
    try {
      url = new URL(text(body.url));
    } catch {
      unreadable();
    }
    // Only Stripe's own hosted page is ever handed to a browser: https, that host,
    // and nothing else around the host (no user info, no port).
    const { pathname, search, hash } = url!;
    const hosted = `https://checkout.stripe.com${pathname}${search}${hash}`;
    if (
      body.mode !== mode ||
      reference(body.customer, STRIPE_ID.customer) !== customerId ||
      url!.href !== hosted
    ) unreadable();
    return { id, url: url!.href };
  }

  /**
   * A hosted Checkout page that takes one card payment of exactly the top-up's
   * amount and saves the card on the customer for later automatic top-ups.
   */
  async createDepositSession(
    topup: TopupToPay,
    options: {
      programName: string;
      successUrl: string;
      cancelUrl: string;
      expiresAt: number;
    },
  ): Promise<{ id: string; url: string }> {
    const metadata: [string, string][] = [
      ["kma_kind", "deposit"],
      ["kma_topup_id", topup.topupId],
      ["kma_account_id", topup.accountId],
      ["kma_program_id", topup.programId],
      ["kma_workspace_id", topup.workspaceId],
    ];
    const body = await this.request("POST", "/checkout/sessions", [
      ["mode", "payment"],
      ["customer", topup.customerId],
      ["client_reference_id", topup.topupId],
      [cardOnlyParameter(this.version), "card"],
      ["line_items[0][quantity]", "1"],
      ["line_items[0][price_data][currency]", topup.currency.toLowerCase()],
      ["line_items[0][price_data][unit_amount]", String(topup.amountMinor)],
      [
        "line_items[0][price_data][product_data][name]",
        `Affiliate program balance: ${options.programName}`.slice(0, 250),
      ],
      ["payment_intent_data[setup_future_usage]", "off_session"],
      [
        "payment_intent_data[description]",
        "KissMyApps affiliate program balance",
      ],
      ...metadata.map(([k, v]): [string, string] => [
        `payment_intent_data[metadata][${k}]`,
        v,
      ]),
      ...metadata.map(([k, v]): [string, string] => [`metadata[${k}]`, v]),
      [
        "custom_text[submit][message]",
        "Your card is saved for this balance. While automatic top-up is on, " +
        "KissMyApps charges it when the balance falls below the minimum you " +
        "set. You can switch automatic top-up off on the Balance page.",
      ],
      ["success_url", options.successUrl],
      ["cancel_url", options.cancelUrl],
      ["expires_at", String(options.expiresAt)],
    ], `kma-topup-${topup.topupId}-checkout`);
    return this.checkoutSession(body, "payment", topup.customerId);
  }

  /** A hosted Checkout page that only saves a new card. Nothing is charged. */
  async createCardSession(input: {
    accountId: string;
    programId: string;
    workspaceId: string;
    customerId: string;
    currency: string;
    successUrl: string;
    cancelUrl: string;
    expiresAt: number;
    /** Makes each request its own: a card change has no top-up to key on. */
    nonce: string;
  }): Promise<{ id: string; url: string }> {
    const metadata: [string, string][] = [
      ["kma_kind", "card"],
      ["kma_account_id", input.accountId],
      ["kma_program_id", input.programId],
      ["kma_workspace_id", input.workspaceId],
    ];
    const body = await this.request("POST", "/checkout/sessions", [
      ["mode", "setup"],
      ["customer", input.customerId],
      ["client_reference_id", input.accountId],
      ["currency", input.currency.toLowerCase()],
      [cardOnlyParameter(this.version), "card"],
      ...metadata.map(([k, v]): [string, string] => [
        `setup_intent_data[metadata][${k}]`,
        v,
      ]),
      ...metadata.map(([k, v]): [string, string] => [`metadata[${k}]`, v]),
      ["success_url", input.successUrl],
      ["cancel_url", input.cancelUrl],
      ["expires_at", String(input.expiresAt)],
    ], `kma-balance-card-${input.accountId}-${input.nonce}`);
    return this.checkoutSession(body, "setup", input.customerId);
  }

  /** Ends a Checkout page that will not be used. */
  async expireSession(sessionId: string, topupId: string): Promise<void> {
    await this.request(
      "POST",
      `/checkout/sessions/${identifier(sessionId, STRIPE_ID.session)}/expire`,
      [],
      `kma-topup-${topupId}-expire`,
    );
  }

  async session(sessionId: string): Promise<SessionFacts> {
    const body = await this.request(
      "GET",
      `/checkout/sessions/${identifier(sessionId, STRIPE_ID.session)}`,
      [],
    );
    if (typeof body.livemode !== "boolean") unreadable();
    return {
      id: identifier(body.id, STRIPE_ID.session),
      livemode: body.livemode as boolean,
      mode: text(body.mode),
      status: text(body.status),
      paymentIntentId: reference(body.payment_intent, STRIPE_ID.intent),
      setupIntentId: reference(body.setup_intent, STRIPE_ID.setupIntent),
    };
  }

  /** The PaymentIntent with the card that paid and its charge. */
  async intent(intentId: string): Promise<IntentFacts> {
    const facts = parseIntent(
      await this.request(
        "GET",
        `/payment_intents/${identifier(intentId, STRIPE_ID.intent)}`,
        [["expand[]", "payment_method"], ["expand[]", "latest_charge"]],
      ),
    );
    if (facts.id !== intentId) unreadable();
    return facts;
  }

  async setupIntent(setupIntentId: string): Promise<SetupFacts> {
    const body = await this.request(
      "GET",
      `/setup_intents/${identifier(setupIntentId, STRIPE_ID.setupIntent)}`,
      [["expand[]", "payment_method"]],
    );
    if (typeof body.livemode !== "boolean" || body.id !== setupIntentId) {
      unreadable();
    }
    const customerId = reference(body.customer, STRIPE_ID.customer);
    return {
      id: setupIntentId,
      livemode: body.livemode as boolean,
      status: text(body.status),
      customerId,
      accountId: metadataValue(body, "kma_account_id"),
      card: cardOf(body.payment_method, customerId),
    };
  }

  async dispute(disputeId: string): Promise<DisputeFacts> {
    const body = await this.request(
      "GET",
      `/disputes/${identifier(disputeId, STRIPE_ID.dispute)}`,
      [],
    );
    if (typeof body.livemode !== "boolean" || body.id !== disputeId) {
      unreadable();
    }
    return {
      id: disputeId,
      livemode: body.livemode as boolean,
      status: text(body.status),
      paymentIntentId: reference(body.payment_intent, STRIPE_ID.intent),
    };
  }

  async charge(chargeId: string): Promise<ChargeFacts> {
    const body = await this.request(
      "GET",
      `/charges/${identifier(chargeId, STRIPE_ID.charge)}`,
      [],
    );
    if (typeof body.livemode !== "boolean" || body.id !== chargeId) {
      unreadable();
    }
    return {
      id: chargeId,
      livemode: body.livemode as boolean,
      paymentIntentId: reference(body.payment_intent, STRIPE_ID.intent),
      refundedMinor: whole(body.amount_refunded ?? 0),
    };
  }

  /**
   * Charges the saved card with nobody present: one PaymentIntent, confirmed at
   * once. Returns its id whatever its status; a declined card is a
   * StripeCallError of kind "card" that names the PaymentIntent. The
   * Idempotency-Key is the top-up: a repeat can never charge twice.
   */
  async chargeSavedCard(
    topup: TopupToPay,
    paymentMethodId: string,
  ): Promise<string> {
    const body = await this.request("POST", "/payment_intents", [
      ["amount", String(topup.amountMinor)],
      ["currency", topup.currency.toLowerCase()],
      ["customer", topup.customerId],
      ["payment_method", identifier(paymentMethodId, STRIPE_ID.paymentMethod)],
      ["off_session", "true"],
      ["confirm", "true"],
      // Before 2026-09-30 a confirmed PaymentIntent asks for a return address
      // unless redirects are ruled out. A saved card never needs one.
      ...(this.version.slice(0, 10) >= "2026-09-30" ? [] : [
        ["automatic_payment_methods[enabled]", "true"],
        ["automatic_payment_methods[allow_redirects]", "never"],
      ] as [string, string][]),
      ["description", "KissMyApps affiliate program balance, automatic top-up"],
      ["metadata[kma_kind]", "auto"],
      ["metadata[kma_topup_id]", topup.topupId],
      ["metadata[kma_account_id]", topup.accountId],
      ["metadata[kma_program_id]", topup.programId],
      ["metadata[kma_workspace_id]", topup.workspaceId],
    ], `kma-topup-${topup.topupId}-charge`);
    if (body.livemode !== true) throw new ConfigurationError();
    return identifier(body.id, STRIPE_ID.intent);
  }

  /** Cancels a PaymentIntent that did not succeed, so it never can. */
  async cancelIntent(intentId: string, topupId: string): Promise<boolean> {
    const body = await this.request(
      "POST",
      `/payment_intents/${identifier(intentId, STRIPE_ID.intent)}/cancel`,
      [],
      `kma-topup-${topupId}-cancel`,
    );
    return body.status === "canceled";
  }

  /**
   * Looks for the PaymentIntent of an automatic top-up whose worker stopped
   * before it could store the id. Null means Stripe has none.
   */
  async findCharge(
    customerId: string,
    topupId: string,
    createdAfter: number,
  ): Promise<string | null> {
    const body = await this.request("GET", "/payment_intents", [
      ["customer", identifier(customerId, STRIPE_ID.customer)],
      ["created[gte]", String(Math.max(0, Math.floor(createdAfter)))],
      ["limit", "100"],
    ]);
    if (!Array.isArray(body.data)) unreadable();
    for (const row of body.data as unknown[]) {
      if (metadataValue(row, "kma_topup_id") === topupId) {
        return identifier((row as Json).id, STRIPE_ID.intent);
      }
    }
    // More than a page of payments since the top-up was made: not knowable here.
    if (body.has_more === true) {
      throw new StripeCallError("unavailable", "stripe_list_truncated");
    }
    return null;
  }

  /** Removes a card the merchant replaced from the customer at Stripe. */
  async detachCard(paymentMethodId: string): Promise<void> {
    await this.request(
      "POST",
      `/payment_methods/${
        identifier(paymentMethodId, STRIPE_ID.paymentMethod)
      }/detach`,
      [],
      `kma-balance-detach-${paymentMethodId}`,
    );
  }
}
