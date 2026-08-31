import type { SupabaseClient } from "@supabase/supabase-js";
import {
  bytesToHex,
  constantTimeEqual,
  hexToBytes,
  hmacSha256,
} from "./crypto.ts";
import { DatabaseBoundaryError, RequestError } from "./errors.ts";
import { isPlainObject } from "./validation.ts";
import { STRIPE_API_VERSION } from "./stripe-api.ts";

const encoder = new TextEncoder();

export const SUPPORTED_STRIPE_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "refund.created",
  "refund.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
] as const;

const supportedEventTypes = new Set<string>(SUPPORTED_STRIPE_EVENT_TYPES);

const CHECKOUT_METADATA_FIELDS = [
  "kma_attempt_id",
  "kma_public_attempt_id",
  "kma_offer_id",
  "kma_product_id",
  "kma_acquisition_id",
  "kma_click_id",
  "kma_expected_amount_minor",
  "kma_expected_currency",
] as const;

// Keep these projections synchronized with normalize_stripe_provider_event.
// Expanded Stripe resources are collapsed to IDs so their embedded PII never
// crosses the persistence boundary.

export interface StripeEventEnvelope {
  id: string;
  type: string;
  livemode: boolean;
  apiVersion: string | null;
  payload: Record<string, unknown>;
}

interface StripeSignature {
  timestamp: number;
  signatures: string[];
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function projectScalarFields(
  source: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (!hasOwn(source, field)) continue;
    const value = source[field];
    projected[field] = value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ? value
      : null;
  }
  return projected;
}

function projectExpandableId(value: unknown): unknown {
  if (typeof value === "string" || value === null) return value;
  if (!isPlainObject(value)) return null;
  return typeof value.id === "string" ? value.id : null;
}

function projectExpandableField(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  field: string,
): void {
  if (hasOwn(source, field)) {
    target[field] = projectExpandableId(source[field]);
  }
}

function projectNestedScalars(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  field: string,
  nestedFields: readonly string[],
): void {
  if (!hasOwn(source, field)) return;
  target[field] = isPlainObject(source[field])
    ? projectScalarFields(source[field], nestedFields)
    : {};
}

function projectCheckoutObject(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const projected = projectScalarFields(source, [
    "id",
    "object",
    "mode",
    "status",
    "payment_status",
    "amount_total",
    "currency",
    "client_reference_id",
  ]);
  projectExpandableField(projected, source, "customer");
  projectExpandableField(projected, source, "subscription");
  projectNestedScalars(
    projected,
    source,
    "metadata",
    CHECKOUT_METADATA_FIELDS,
  );
  return projected;
}

function projectSubscriptionObject(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const projected = projectScalarFields(source, [
    "id",
    "object",
    "livemode",
    "status",
    "currency",
    "current_period_start",
    "current_period_end",
    "canceled_at",
  ]);
  projectExpandableField(projected, source, "customer");
  projectNestedScalars(projected, source, "metadata", ["kma_attempt_id"]);
  return projected;
}

function projectInvoiceObject(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const projected = projectScalarFields(source, [
    "id",
    "object",
    "status",
    "paid",
    "amount_paid",
    "total",
    "total_excluding_tax",
    "currency",
    "billing_reason",
  ]);
  projectExpandableField(projected, source, "customer");
  projectExpandableField(projected, source, "subscription");
  projectNestedScalars(projected, source, "status_transitions", ["paid_at"]);
  if (
    hasOwn(source, "parent") &&
    (typeof projected.subscription !== "string" ||
      projected.subscription.length === 0)
  ) {
    const parent = isPlainObject(source.parent) ? source.parent : null;
    const details = parent && isPlainObject(parent.subscription_details)
      ? parent.subscription_details
      : null;
    const subscriptionDetails: Record<string, unknown> = {};
    if (details && hasOwn(details, "subscription")) {
      subscriptionDetails.subscription = projectExpandableId(
        details.subscription,
      );
    }
    projected.parent = { subscription_details: subscriptionDetails };
  }
  return projected;
}

function projectRefundObject(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const projected = projectScalarFields(source, [
    "id",
    "object",
    "status",
    "amount",
    "currency",
    "created",
  ]);
  projectExpandableField(projected, source, "charge");
  return projected;
}

function projectDisputeObject(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const projected = projectScalarFields(source, [
    "id",
    "object",
    "status",
    "amount",
    "currency",
    "created",
  ]);
  projectExpandableField(projected, source, "charge");
  if (hasOwn(source, "balance_transactions")) {
    projected.balance_transactions = Array.isArray(source.balance_transactions)
      ? source.balance_transactions.map((item) =>
        isPlainObject(item)
          ? projectScalarFields(item, [
            "id",
            "amount",
            "fee",
            "net",
            "currency",
            "created",
          ])
          : {}
      )
      : null;
  }
  return projected;
}

function projectStripeObject(
  eventType: string,
  source: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventType) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return projectCheckoutObject(source);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return projectSubscriptionObject(source);
    case "invoice.paid":
      return projectInvoiceObject(source);
    case "refund.created":
    case "refund.updated":
      return projectRefundObject(source);
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      return projectDisputeObject(source);
    default:
      throw new RequestError(
        400,
        "unsupported_event_type",
        "Webhook event type is unsupported.",
      );
  }
}

export function parseStripeSignatureHeader(
  value: string | null,
): StripeSignature {
  if (!value || value.length > 2048) {
    throw new RequestError(
      400,
      "invalid_signature",
      "Webhook signature is invalid.",
    );
  }
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const component of value.split(",")) {
    const [key, raw] = component.trim().split("=", 2);
    if (key === "t" && /^\d{1,12}$/.test(raw ?? "")) timestamp = Number(raw);
    if (key === "v1" && /^[0-9a-f]{64}$/i.test(raw ?? "")) {
      signatures.push(raw.toLowerCase());
    }
  }
  if (
    !Number.isSafeInteger(timestamp) || timestamp === null ||
    signatures.length === 0
  ) {
    throw new RequestError(
      400,
      "invalid_signature",
      "Webhook signature is invalid.",
    );
  }
  return { timestamp, signatures };
}

export async function verifyStripeSignature(
  body: Uint8Array,
  headerValue: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): Promise<void> {
  const parsed = parseStripeSignatureHeader(headerValue);
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    throw new RequestError(
      400,
      "expired_signature",
      "Webhook signature is invalid.",
    );
  }
  const prefix = encoder.encode(`${parsed.timestamp}.`);
  const canonical = new Uint8Array(prefix.byteLength + body.byteLength);
  canonical.set(prefix);
  canonical.set(body, prefix.byteLength);
  const expected = await hmacSha256(secret, canonical);
  const verified = parsed.signatures.some((signature) => {
    const supplied = hexToBytes(signature);
    return supplied !== null && constantTimeEqual(expected, supplied);
  });
  if (!verified) {
    throw new RequestError(
      400,
      "invalid_signature",
      "Webhook signature is invalid.",
    );
  }
}

export function parseStripeEvent(body: Uint8Array): StripeEventEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new RequestError(400, "invalid_event", "Webhook payload is invalid.");
  }
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    !/^evt_[A-Za-z0-9_]{8,128}$/.test(value.id) ||
    typeof value.type !== "string" ||
    !/^[a-z][a-z0-9_.]{1,120}$/.test(value.type) ||
    typeof value.livemode !== "boolean" ||
    !isPlainObject(value.data)
  ) {
    throw new RequestError(400, "invalid_event", "Webhook payload is invalid.");
  }
  const apiVersion = value.api_version;
  if (
    apiVersion !== undefined && apiVersion !== null &&
    typeof apiVersion !== "string"
  ) {
    throw new RequestError(400, "invalid_event", "Webhook payload is invalid.");
  }
  if (typeof apiVersion === "string" && apiVersion !== STRIPE_API_VERSION) {
    throw new RequestError(
      400,
      "unsupported_stripe_api_version",
      "Webhook API version is unsupported.",
    );
  }
  if (!supportedEventTypes.has(value.type)) {
    throw new RequestError(
      400,
      "unsupported_event_type",
      "Webhook event type is unsupported.",
    );
  }
  const stripeObject = isPlainObject(value.data.object)
    ? value.data.object
    : {};
  const payload: Record<string, unknown> = {
    id: value.id,
    type: value.type,
    livemode: value.livemode,
    data: { object: projectStripeObject(value.type, stripeObject) },
  };
  Object.assign(payload, projectScalarFields(value, ["created"]));
  return {
    id: value.id,
    type: value.type,
    livemode: value.livemode,
    // Stripe documents this field as nullable for events created before
    // 2014-10-31. Preserve those signed envelopes, but reject any explicit
    // incompatible version above.
    apiVersion: typeof apiVersion === "string" ? apiVersion : null,
    payload,
  };
}

export async function stripeSignedBodySha256(
  body: Uint8Array,
): Promise<string> {
  const exactBody = Uint8Array.from(body).buffer;
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", exactBody)),
  );
}

export async function persistStripeEvent(
  client: SupabaseClient,
  event: StripeEventEnvelope,
  signedBodySha256: string,
): Promise<{ duplicate: boolean }> {
  const { data, error } = await client.rpc("persist_stripe_provider_event", {
    p_input: {
      event_id: event.id,
      event_type: event.type,
      payload: event.payload,
      signed_body_sha256: signedBodySha256,
    },
  });
  if (error) {
    if (error.code === "23505") {
      throw new RequestError(
        409,
        "event_id_conflict",
        "Webhook event identity conflicts with prior evidence.",
      );
    }
    throw new DatabaseBoundaryError(error.code);
  }
  if (!isPlainObject(data) || typeof data.duplicate !== "boolean") {
    throw new DatabaseBoundaryError();
  }
  return { duplicate: data.duplicate };
}
