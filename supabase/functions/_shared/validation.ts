import { RequestError } from "./errors.ts";

const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,99}$/;
const PROPERTY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;
const BROWSER_EVENT_NAMES = new Set([
  "landing_viewed",
  "funnel_started",
  "payment_viewed",
  "app_store_clicked",
]);
const BROWSER_PROPERTY_NAMES = new Set([
  "device_type",
  "experiment",
  "locale",
  "page_name",
  "page_path",
  "placement",
  "referrer_host",
  "variant",
]);
const FORBIDDEN_PROPERTY_NAMES = new Set([
  "address",
  "card",
  "card_number",
  "email",
  "email_address",
  "first_name",
  "full_name",
  "last_name",
  "password",
  "phone",
  "phone_number",
  "secret",
  "token",
]);
const EVENT_KEYS = new Set([
  "click_id",
  "event_id",
  "event_name",
  "occurred_at",
  "properties",
]);

export type EventPropertyValue = string | number | boolean | null;

export interface CanonicalEventInput {
  event_id: string;
  event_name: string;
  click_id: string;
  occurred_at: string;
  properties: Record<string, EventPropertyValue>;
}

export interface TrackingRoute {
  affiliateSlug: string;
  publicCode: string;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f);
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new RequestError(
      400,
      "invalid_payload",
      "Request contains unsupported fields.",
    );
  }
}

function validateOccurredAt(
  value: unknown,
  maximumAgeMilliseconds: number,
  nowMilliseconds: number,
): string {
  if (typeof value !== "string" || value.length > 40) {
    throw new RequestError(400, "invalid_event_time", "Event time is invalid.");
  }
  const milliseconds = Date.parse(value);
  const maximumFutureSkew = 5 * 60 * 1000;
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds > nowMilliseconds + maximumFutureSkew ||
    milliseconds < nowMilliseconds - maximumAgeMilliseconds
  ) {
    throw new RequestError(
      400,
      "invalid_event_time",
      "Event time is outside the accepted window.",
    );
  }
  return new Date(milliseconds).toISOString();
}

function validatePropertyValue(
  key: string,
  value: unknown,
): EventPropertyValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) {
      throw new RequestError(
        400,
        "invalid_properties",
        "Event properties are invalid.",
      );
    }
    return value;
  }
  if (
    typeof value !== "string" || value.length > 500 ||
    containsControlCharacter(value)
  ) {
    throw new RequestError(
      400,
      "invalid_properties",
      "Event properties are invalid.",
    );
  }
  if (key === "page_path" && (!value.startsWith("/") || /[?#]/u.test(value))) {
    throw new RequestError(
      400,
      "invalid_properties",
      "Event properties are invalid.",
    );
  }
  if (key === "referrer_host") {
    try {
      const host = new URL(`https://${value}`).hostname;
      if (host !== value.toLowerCase()) throw new Error("invalid host");
    } catch {
      throw new RequestError(
        400,
        "invalid_properties",
        "Event properties are invalid.",
      );
    }
  }
  return value;
}

function validateProperties(
  value: unknown,
  allowedPropertyNames: ReadonlySet<string>,
  maximumBytes: number,
): Record<string, EventPropertyValue> {
  if (!isPlainObject(value)) {
    throw new RequestError(
      400,
      "invalid_properties",
      "Event properties must be an object.",
    );
  }
  const keys = Object.keys(value);
  if (keys.length > 25) {
    throw new RequestError(
      400,
      "invalid_properties",
      "Too many event properties were supplied.",
    );
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes
  ) {
    throw new RequestError(
      400,
      "invalid_properties",
      "Event properties are too large.",
    );
  }
  const output: Record<string, EventPropertyValue> = {};
  for (const key of keys) {
    if (
      !PROPERTY_KEY_PATTERN.test(key) ||
      !allowedPropertyNames.has(key) ||
      FORBIDDEN_PROPERTY_NAMES.has(key)
    ) {
      throw new RequestError(
        400,
        "invalid_properties",
        "Event properties contain unsupported fields.",
      );
    }
    output[key] = validatePropertyValue(key, value[key]);
  }
  return output;
}

function validateEvent(
  value: unknown,
  allowedEventNames: ReadonlySet<string>,
  allowedPropertyNames: ReadonlySet<string>,
  maximumPropertyBytes: number,
  maximumAgeMilliseconds: number,
  nowMilliseconds: number,
): CanonicalEventInput {
  if (!isPlainObject(value)) {
    throw new RequestError(
      400,
      "invalid_payload",
      "Request body must be a JSON object.",
    );
  }
  requireExactKeys(value, EVENT_KEYS);
  if (
    typeof value.event_id !== "string" || !EVENT_ID_PATTERN.test(value.event_id)
  ) {
    throw new RequestError(400, "invalid_event_id", "Event ID is invalid.");
  }
  if (
    typeof value.click_id !== "string" || !CLICK_ID_PATTERN.test(value.click_id)
  ) {
    throw new RequestError(400, "invalid_click_id", "Click ID is invalid.");
  }
  if (
    typeof value.event_name !== "string" ||
    !EVENT_NAME_PATTERN.test(value.event_name) ||
    !allowedEventNames.has(value.event_name)
  ) {
    throw new RequestError(
      400,
      "unsupported_event",
      "Event name is unsupported.",
    );
  }
  return {
    event_id: value.event_id.toLowerCase(),
    event_name: value.event_name,
    click_id: value.click_id,
    occurred_at: validateOccurredAt(
      value.occurred_at,
      maximumAgeMilliseconds,
      nowMilliseconds,
    ),
    properties: validateProperties(
      value.properties,
      allowedPropertyNames,
      maximumPropertyBytes,
    ),
  };
}

export function validateBrowserEvent(
  value: unknown,
  nowMilliseconds = Date.now(),
): CanonicalEventInput {
  return validateEvent(
    value,
    BROWSER_EVENT_NAMES,
    BROWSER_PROPERTY_NAMES,
    8 * 1024,
    24 * 60 * 60 * 1000,
    nowMilliseconds,
  );
}

export function validateFunnelEvent(
  value: unknown,
  allowedEventNames: ReadonlySet<string>,
  allowedPropertyNames: ReadonlySet<string>,
  nowMilliseconds = Date.now(),
): CanonicalEventInput {
  if (allowedEventNames.size === 0) {
    throw new RequestError(
      503,
      "event_contract_unconfigured",
      "Funnel event contract is not configured.",
    );
  }
  return validateEvent(
    value,
    allowedEventNames,
    allowedPropertyNames,
    16 * 1024,
    7 * 24 * 60 * 60 * 1000,
    nowMilliseconds,
  );
}

export function parseTrackingRoute(pathname: string): TrackingRoute {
  const segments = pathname.split("/").filter(Boolean);
  const functionIndex = segments[0] === "tracking-redirect" ? 1 : 0;
  if (
    segments[functionIndex] !== "r" ||
    segments.length !== functionIndex + 3
  ) {
    throw new RequestError(
      404,
      "not_found",
      "The requested resource is unavailable.",
    );
  }
  let affiliateSlug: string;
  let publicCode: string;
  try {
    affiliateSlug = decodeURIComponent(segments[functionIndex + 1]);
    publicCode = decodeURIComponent(segments[functionIndex + 2]);
  } catch {
    throw new RequestError(
      404,
      "not_found",
      "The requested resource is unavailable.",
    );
  }
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(affiliateSlug) ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(publicCode)
  ) {
    throw new RequestError(
      404,
      "not_found",
      "The requested resource is unavailable.",
    );
  }
  return { affiliateSlug, publicCode };
}

export function validatedRedirectUrl(
  destination: string,
  clickId: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(destination);
  } catch {
    throw new RequestError(
      503,
      "invalid_destination",
      "The destination is unavailable.",
    );
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new RequestError(
      503,
      "invalid_destination",
      "The destination is unavailable.",
    );
  }
  parsed.searchParams.set("kma_click", clickId);
  return parsed.toString();
}

export function countryCodeFromHeaders(headers: Headers): string | null {
  const value = headers.get("cf-ipcountry") ??
    headers.get("x-vercel-ip-country");
  if (!value) return null;
  const normalized = value.toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

export function clientIpFromHeaders(headers: Headers): string | null {
  const cloudflare = headers.get("cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare.slice(0, 64);
  const forwarded = headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return forwarded ? forwarded.slice(0, 64) : null;
}

export function isAutomatedRequest(headers: Headers): boolean {
  const purpose = `${headers.get("purpose") ?? ""} ${
    headers.get("sec-purpose") ?? ""
  }`;
  if (/prefetch|preview/i.test(purpose)) return true;
  const userAgent = headers.get("user-agent") ?? "";
  return /bot|crawler|spider|slurp|facebookexternalhit|headless|preview/i.test(
    userAgent,
  );
}
