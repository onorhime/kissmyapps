import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseFunnelSignatureHeaders,
  verifyFunnelSignature,
} from "../_shared/crypto.ts";
import {
  type FunnelKeyBinding,
  funnelKeyBindings,
  funnelSigningSecrets,
  productionOrigins,
  requiredSecret,
} from "../_shared/env.ts";
import {
  ConfigurationError,
  DatabaseBoundaryError,
  NotFoundError,
  RequestError,
} from "../_shared/errors.ts";
import { assertFunnelRequestScope } from "../_shared/rpc.ts";
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
import {
  STRIPE_API_VERSION,
  stripeRequestSignal,
} from "../_shared/stripe-api.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const OFFER_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIVE_PRICE_PATTERN = /^price_[A-Za-z0-9_]{8,128}$/;
const LIVE_SESSION_PATTERN = /^cs_live_[A-Za-z0-9_]{8,160}$/;
const CHECKOUT_KEYS = new Set(["click_id", "offer_key"]);

export interface CheckoutRequestInput {
  click_id: string;
  offer_key: string;
}

export interface PreparedCheckout {
  attemptId: string;
  publicAttemptId: string;
  billingOfferId: string;
  productId: string;
  acquisitionId: string;
  clickRecordId: string;
  affiliateId: string | null;
  billingMode: "payment" | "subscription";
  stripePriceId: string;
  currency: string;
  unitAmountMinor: number;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeCheckoutSession {
  id: string;
  url: string;
  expiresAt: string;
}

export interface CheckoutFinalization {
  attempt_id: string;
  status: "open" | "failed";
  stripe_session_id?: string;
  checkout_url?: string;
  expires_at?: string;
  failure_code?: string;
}

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CheckoutDependencies {
  funnelBindings: () => ReadonlyMap<string, FunnelKeyBinding>;
  redirectOrigins: () => ReadonlySet<string>;
  stripeSecret: () => string;
  authorizeScope: (
    keyId: string,
    clickId: string,
    productId: string,
    funnelId: string,
  ) => Promise<void>;
  prepare: (
    input: CheckoutRequestInput,
    idempotencyKey: string,
  ) => Promise<PreparedCheckout>;
  finalize: (input: CheckoutFinalization) => Promise<void>;
  createStripeSession: (
    secret: string,
    prepared: PreparedCheckout,
  ) => Promise<StripeCheckoutSession>;
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    const first = data[0];
    return isPlainObject(first) ? first : null;
  }
  return isPlainObject(data) ? data : null;
}

function requiredString(
  row: Record<string, unknown>,
  name: string,
  pattern?: RegExp,
): string {
  const value = row[name];
  if (typeof value !== "string" || (pattern && !pattern.test(value))) {
    throw new DatabaseBoundaryError();
  }
  return value;
}

function productionRedirectUrl(
  value: string,
  requiresSessionToken: boolean,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DatabaseBoundaryError();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname.endsWith(".test") ||
    parsed.hostname.endsWith(".invalid") ||
    (requiresSessionToken && !value.includes("{CHECKOUT_SESSION_ID}"))
  ) {
    throw new DatabaseBoundaryError();
  }
  return value;
}

function parseCheckoutInput(value: unknown): CheckoutRequestInput {
  if (!isPlainObject(value)) {
    throw new RequestError(
      400,
      "invalid_checkout",
      "Checkout input must be a JSON object.",
    );
  }
  const keys = Object.keys(value);
  if (
    keys.length !== CHECKOUT_KEYS.size ||
    keys.some((key) => !CHECKOUT_KEYS.has(key)) ||
    typeof value.click_id !== "string" ||
    typeof value.offer_key !== "string"
  ) {
    throw new RequestError(
      400,
      "invalid_checkout",
      "Checkout input contains unsupported or missing fields.",
    );
  }
  const clickId = value.click_id.trim();
  const offerKey = value.offer_key.trim().toLowerCase();
  if (!CLICK_ID_PATTERN.test(clickId) || !OFFER_KEY_PATTERN.test(offerKey)) {
    throw new RequestError(
      400,
      "invalid_checkout",
      "Checkout identifiers are invalid.",
    );
  }
  return { click_id: clickId, offer_key: offerKey };
}

function decodeCheckoutBody(bytes: Uint8Array): CheckoutRequestInput {
  if (bytes.byteLength === 0) {
    throw new RequestError(
      400,
      "empty_body",
      "A JSON request body is required.",
    );
  }
  try {
    return parseCheckoutInput(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(
      400,
      "invalid_json",
      "Request body must be valid JSON.",
    );
  }
}

function liveStripeSecret(): string {
  const secret = requiredSecret("STRIPE_SECRET_KEY");
  if (!/^sk_live_[A-Za-z0-9_]{16,}$/.test(secret)) {
    throw new ConfigurationError();
  }
  return secret;
}

function validateRedirectOrigins(
  prepared: PreparedCheckout,
  allowedOrigins: ReadonlySet<string>,
): void {
  const successUrl = productionRedirectUrl(prepared.successUrl, true);
  const cancelUrl = productionRedirectUrl(prepared.cancelUrl, false);
  if (
    !allowedOrigins.has(new URL(successUrl).origin) ||
    !allowedOrigins.has(new URL(cancelUrl).origin)
  ) {
    throw new DatabaseBoundaryError();
  }
}

function metadata(
  prepared: PreparedCheckout,
): Readonly<Record<string, string>> {
  return {
    kma_attempt_id: prepared.attemptId,
    kma_public_attempt_id: prepared.publicAttemptId,
    kma_offer_id: prepared.billingOfferId,
    kma_product_id: prepared.productId,
    kma_acquisition_id: prepared.acquisitionId,
    kma_click_id: prepared.clickRecordId,
    kma_expected_amount_minor: String(prepared.unitAmountMinor),
    kma_expected_currency: prepared.currency,
  };
}

function addMetadata(
  form: URLSearchParams,
  prefix: string,
  values: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(values)) {
    form.set(`${prefix}[${key}]`, value);
  }
}

export async function createLiveStripeCheckoutSession(
  secret: string,
  prepared: PreparedCheckout,
  fetcher: Fetcher = fetch,
): Promise<StripeCheckoutSession> {
  if (!/^sk_live_[A-Za-z0-9_]{16,}$/.test(secret)) {
    throw new ConfigurationError();
  }
  if (
    !UUID_PATTERN.test(prepared.attemptId) ||
    !UUID_PATTERN.test(prepared.billingOfferId) ||
    !UUID_PATTERN.test(prepared.productId) ||
    !UUID_PATTERN.test(prepared.acquisitionId) ||
    !UUID_PATTERN.test(prepared.clickRecordId) ||
    (prepared.affiliateId !== null &&
      !UUID_PATTERN.test(prepared.affiliateId)) ||
    !LIVE_PRICE_PATTERN.test(prepared.stripePriceId) ||
    !/^[A-Z]{3}$/.test(prepared.currency) ||
    !Number.isSafeInteger(prepared.unitAmountMinor) ||
    prepared.unitAmountMinor <= 0
  ) {
    throw new DatabaseBoundaryError();
  }

  const successUrl = productionRedirectUrl(prepared.successUrl, true);
  const cancelUrl = productionRedirectUrl(prepared.cancelUrl, false);
  const form = new URLSearchParams({
    mode: prepared.billingMode,
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: prepared.publicAttemptId,
    "line_items[0][price]": prepared.stripePriceId,
    "line_items[0][quantity]": "1",
  });
  const values = metadata(prepared);
  addMetadata(form, "metadata", values);
  addMetadata(
    form,
    prepared.billingMode === "subscription"
      ? "subscription_data[metadata]"
      : "payment_intent_data[metadata]",
    values,
  );

  let response: Response;
  try {
    response = await fetcher("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `kma-checkout-${prepared.attemptId}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
      body: form.toString(),
      signal: stripeRequestSignal(),
    });
  } catch {
    throw new RequestError(
      502,
      "provider_unavailable",
      "Checkout could not be created.",
    );
  }

  if (response.status === 429 || response.status >= 500) {
    throw new RequestError(
      502,
      "provider_unavailable",
      "Checkout could not be created.",
    );
  }
  if (!response.ok) {
    throw new RequestError(
      502,
      "provider_rejected",
      "Checkout could not be created.",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RequestError(
      502,
      "provider_invalid_response",
      "Checkout could not be created.",
    );
  }
  if (
    !isPlainObject(payload) ||
    payload.livemode !== true ||
    typeof payload.id !== "string" ||
    !LIVE_SESSION_PATTERN.test(payload.id) ||
    typeof payload.url !== "string" ||
    typeof payload.expires_at !== "number" ||
    !Number.isSafeInteger(payload.expires_at)
  ) {
    throw new RequestError(
      502,
      "provider_invalid_response",
      "Checkout could not be created.",
    );
  }
  const checkoutUrl = new URL(payload.url);
  if (
    checkoutUrl.origin !== "https://checkout.stripe.com" ||
    checkoutUrl.username ||
    checkoutUrl.password
  ) {
    throw new RequestError(
      502,
      "provider_invalid_response",
      "Checkout could not be created.",
    );
  }
  const expiresAt = new Date(payload.expires_at * 1000);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new RequestError(
      502,
      "provider_invalid_response",
      "Checkout could not be created.",
    );
  }
  return {
    id: payload.id,
    url: payload.url,
    expiresAt: expiresAt.toISOString(),
  };
}

function isRetryableStripeFailure(error: unknown): boolean {
  return error instanceof RequestError && error.code === "provider_unavailable";
}

async function prepareCheckoutRpc(
  client: SupabaseClient,
  input: CheckoutRequestInput,
  idempotencyKey: string,
): Promise<PreparedCheckout> {
  const { data, error } = await client.rpc("prepare_checkout_attempt", {
    p_input: { ...input, idempotency_key: idempotencyKey },
  });
  if (error) {
    if (error.code === "P0002") throw new NotFoundError();
    if (["22023", "23505", "23514", "P0001"].includes(error.code ?? "")) {
      throw new RequestError(
        409,
        "checkout_rejected",
        "Checkout is unavailable for this request.",
      );
    }
    throw new DatabaseBoundaryError(error.code);
  }
  const row = firstRow(data);
  if (!row) throw new DatabaseBoundaryError();
  const amount = row.unit_amount_minor;
  const affiliate = row.affiliate_id;
  const mode = row.billing_mode;
  if (
    !Number.isSafeInteger(amount) ||
    (amount as number) <= 0 ||
    (affiliate !== null &&
      (typeof affiliate !== "string" || !UUID_PATTERN.test(affiliate))) ||
    (mode !== "payment" && mode !== "subscription")
  ) {
    throw new DatabaseBoundaryError();
  }
  return {
    attemptId: requiredString(row, "attempt_id", UUID_PATTERN),
    publicAttemptId: requiredString(
      row,
      "public_attempt_id",
      /^[A-Za-z0-9_-]{32,128}$/,
    ),
    billingOfferId: requiredString(row, "billing_offer_id", UUID_PATTERN),
    productId: requiredString(row, "product_id", UUID_PATTERN),
    acquisitionId: requiredString(row, "acquisition_id", UUID_PATTERN),
    clickRecordId: requiredString(row, "click_record_id", UUID_PATTERN),
    affiliateId: affiliate as string | null,
    billingMode: mode,
    stripePriceId: requiredString(row, "stripe_price_id", LIVE_PRICE_PATTERN),
    currency: requiredString(row, "currency", /^[A-Z]{3}$/),
    unitAmountMinor: amount as number,
    successUrl: productionRedirectUrl(
      requiredString(row, "success_url"),
      true,
    ),
    cancelUrl: productionRedirectUrl(requiredString(row, "cancel_url"), false),
  };
}

async function finalizeCheckoutRpc(
  client: SupabaseClient,
  input: CheckoutFinalization,
): Promise<void> {
  const { data, error } = await client.rpc("finalize_checkout_attempt", {
    p_input: input,
  });
  if (error) throw new DatabaseBoundaryError(error.code);
  const row = firstRow(data);
  if (
    !row || row.attempt_id !== input.attempt_id || row.status !== input.status
  ) {
    throw new DatabaseBoundaryError();
  }
}

function defaultDependencies(): CheckoutDependencies {
  return {
    funnelBindings: funnelKeyBindings,
    redirectOrigins: () =>
      productionOrigins("CHECKOUT_ALLOWED_REDIRECT_ORIGINS"),
    stripeSecret: liveStripeSecret,
    authorizeScope: (keyId, clickId, productId, funnelId) =>
      assertFunnelRequestScope(
        serviceClient(),
        keyId,
        clickId,
        productId,
        funnelId,
      ),
    prepare: (input, idempotencyKey) =>
      prepareCheckoutRpc(serviceClient(), input, idempotencyKey),
    finalize: (input) => finalizeCheckoutRpc(serviceClient(), input),
    createStripeSession: (secret, prepared) =>
      createLiveStripeCheckoutSession(secret, prepared),
  };
}

export function createCheckoutSessionHandler(
  overrides: Partial<CheckoutDependencies> = {},
): (request: Request) => Promise<Response> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      if (request.headers.has("origin")) {
        throw new RequestError(
          403,
          "browser_request_rejected",
          "Server authentication is required.",
        );
      }
      requireJsonContentType(request);
      const stripeSecret = dependencies.stripeSecret();
      const redirectOrigins = dependencies.redirectOrigins();
      const bytes = await readRequestBytes(request, 16 * 1024);
      const signature = parseFunnelSignatureHeaders(request.headers);
      const bindings = dependencies.funnelBindings();
      await verifyFunnelSignature(
        bytes,
        signature,
        funnelSigningSecrets(bindings),
      );
      const input = decodeCheckoutBody(bytes);
      const binding = bindings.get(signature.keyId);
      if (!binding) {
        throw new RequestError(
          401,
          "invalid_signature",
          "Request authentication failed.",
        );
      }
      await dependencies.authorizeScope(
        signature.keyId,
        input.click_id,
        binding.productId,
        binding.funnelId,
      );
      const prepared = await dependencies.prepare(input, signature.nonce);
      validateRedirectOrigins(prepared, redirectOrigins);

      let stripeSession: StripeCheckoutSession;
      try {
        stripeSession = await dependencies.createStripeSession(
          stripeSecret,
          prepared,
        );
      } catch (error) {
        if (!isRetryableStripeFailure(error)) {
          try {
            await dependencies.finalize({
              attempt_id: prepared.attemptId,
              status: "failed",
              failure_code: error instanceof RequestError
                ? error.code
                : "stripe_request_failed",
            });
          } catch {
            // Preserve the original provider failure.
          }
        }
        // A transient provider/network failure leaves the attempt prepared so
        // the caller can reuse the nonce and Stripe idempotency key safely.
        throw error;
      }

      await dependencies.finalize({
        attempt_id: prepared.attemptId,
        status: "open",
        stripe_session_id: stripeSession.id,
        checkout_url: stripeSession.url,
        expires_at: stripeSession.expiresAt,
      });
      return jsonResponse(
        201,
        {
          checkout_url: stripeSession.url,
          attempt_id: prepared.publicAttemptId,
          expires_at: stripeSession.expiresAt,
          request_id: id,
        },
        { "X-Request-ID": id },
      );
    } catch (error) {
      return errorResponse(error, id, { "X-Request-ID": id });
    }
  };
}

export const handleCheckoutSession = createCheckoutSessionHandler();

if (import.meta.main) Deno.serve(handleCheckoutSession);
