import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DatabaseBoundaryError,
  NotFoundError,
  RequestError,
} from "./errors.ts";
import type { CanonicalEventInput } from "./validation.ts";

export interface TrackingContext {
  country_code: string | null;
  session_id_hash: string | null;
  user_agent_hash: string | null;
  ip_hash: string | null;
  is_bot: boolean;
}

export interface TrackingRegistration {
  clickId: string;
  destinationUrl: string;
  isBot: boolean;
}

export interface EventReceipt {
  eventId: string;
  duplicate: boolean;
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    const first = data[0];
    return typeof first === "object" && first !== null
      ? first as Record<string, unknown>
      : null;
  }
  return typeof data === "object" && data !== null
    ? data as Record<string, unknown>
    : null;
}

function isUnavailableCode(code: string | undefined): boolean {
  return code === "P0001" || code === "22023" || code === "23514" ||
    code === "42501" || code === "P0002";
}

function rateLimitError(): RequestError {
  return new RequestError(
    429,
    "rate_limited",
    "Too many requests. Try again later.",
  );
}

export async function registerTrackingClick(
  client: SupabaseClient,
  affiliateSlug: string,
  publicCode: string,
  context: TrackingContext,
): Promise<TrackingRegistration> {
  const { data, error } = await client.rpc("register_tracking_click", {
    p_affiliate_slug: affiliateSlug,
    p_public_code: publicCode,
    p_context: context,
  });
  if (error) {
    if (error.code === "KMA29") throw rateLimitError();
    if (isUnavailableCode(error.code)) throw new NotFoundError();
    throw new DatabaseBoundaryError(error.code);
  }
  const row = firstRow(data);
  if (
    !row ||
    typeof row.click_id !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(row.click_id) ||
    typeof row.destination_url !== "string" ||
    typeof row.is_bot !== "boolean"
  ) {
    throw new NotFoundError();
  }
  return {
    clickId: row.click_id,
    destinationUrl: row.destination_url,
    isBot: row.is_bot,
  };
}

async function ingestEvent(
  client: SupabaseClient,
  functionName: "ingest_browser_event" | "ingest_funnel_event",
  input: CanonicalEventInput,
): Promise<EventReceipt> {
  const { data, error } = await client.rpc(functionName, { p_input: input });
  if (error) {
    if (error.code === "KMA29") throw rateLimitError();
    if (error.code === "P0002") {
      throw new RequestError(
        404,
        "click_unavailable",
        "The affiliate click is unavailable.",
      );
    }
    if (isUnavailableCode(error.code)) {
      throw new RequestError(
        400,
        "event_rejected",
        "The event could not be accepted.",
      );
    }
    throw new DatabaseBoundaryError(error.code);
  }
  const row = firstRow(data);
  if (
    !row || typeof row.event_id !== "string" ||
    typeof row.duplicate !== "boolean"
  ) {
    throw new DatabaseBoundaryError();
  }
  return { eventId: row.event_id, duplicate: row.duplicate };
}

export function ingestBrowserEvent(
  client: SupabaseClient,
  input: CanonicalEventInput,
): Promise<EventReceipt> {
  return ingestEvent(client, "ingest_browser_event", input);
}

export function ingestFunnelEvent(
  client: SupabaseClient,
  input: CanonicalEventInput,
): Promise<EventReceipt> {
  return ingestEvent(client, "ingest_funnel_event", input);
}

export async function assertFunnelRequestScope(
  client: SupabaseClient,
  keyId: string,
  clickId: string,
  productId: string,
  funnelId: string,
): Promise<void> {
  const { data, error } = await client.rpc("assert_funnel_request_scope", {
    p_key_id: keyId,
    p_click_id: clickId,
    p_product_id: productId,
    p_funnel_id: funnelId,
  });
  if (error) {
    if (error.code === "P0002") {
      throw new RequestError(
        404,
        "click_unavailable",
        "The affiliate click is unavailable.",
      );
    }
    if (isUnavailableCode(error.code)) {
      throw new RequestError(
        403,
        "scope_rejected",
        "The request scope could not be accepted.",
      );
    }
    throw new DatabaseBoundaryError(error.code);
  }
  if (data !== true) throw new DatabaseBoundaryError();
}
