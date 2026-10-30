import { RequestError } from "../_shared/errors.ts";
import { countryFromTimezone } from "./timezones.ts";

export type IngestKind = "events" | "replay";

export interface Geo {
  country?: string;
  region?: string;
  city?: string;
  source?: "edge" | "timezone";
}

export interface IngestPayload {
  key_hash: string;
  kind: IngestKind;
  origin: string | null;
  ip_sha: string | null;
  user_agent: string | null;
  geo: Geo;
  clock_skew_ms: number;
  body: Record<string, unknown>;
}

const KEY_PATTERN = /^kma_(pk|sk)_(live|test)_[A-Za-z0-9]{20,64}$/;
const MAX_EVENTS = 500;
const SKEW_TOLERANCE_MS = 30_000;
const MAX_SKEW_MS = 400 * 24 * 60 * 60 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    value = String(value);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : undefined;
}

/** Accepts an ISO 8601 string or epoch milliseconds and returns ISO 8601 in UTC. */
export function isoTime(value: unknown): string | undefined {
  let date: Date | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value);
  } else if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/
      .test(value)
  ) date = new Date(value);
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export function apiKey(
  request: Request,
  body: Record<string, unknown>,
): string {
  const header = request.headers.get("authorization")?.match(
    /^Bearer\s+(\S+)$/i,
  )?.[1];
  const key = header ?? text(body.api_key, 100) ?? text(body.key, 100);
  if (!key || !KEY_PATTERN.test(key)) {
    throw new RequestError(
      401,
      "invalid_key",
      "Send a valid KissMyApps API key.",
    );
  }
  return key;
}

function normalizeContext(
  value: unknown,
  fromBrowser: boolean,
): Record<string, unknown> {
  const context = isObject(value) ? value : {};
  const out: Record<string, unknown> = {};
  const platform = text(context.platform, 20)?.toLowerCase();
  out.platform =
    platform && ["ios", "android", "web", "server"].includes(platform)
      ? platform
      : fromBrowser
      ? "web"
      : "server";
  const strings: Record<string, number> = {
    timezone: 64,
    language: 35,
    device_type: 20,
    device_model: 80,
    os_name: 40,
    os_version: 40,
    browser: 40,
    browser_version: 40,
    app_version: 40,
    sdk: 60,
    network: 20,
    carrier: 60,
    referrer: 500,
    page_path: 500,
    country: 2,
    region: 80,
    city: 80,
    user_agent: 400,
  };
  for (const [key, max] of Object.entries(strings)) {
    const value = text(context[key], max);
    if (value !== undefined) out[key] = value;
  }
  if (typeof out.device_type === "string") {
    out.device_type = out.device_type.toLowerCase();
  }
  for (const key of ["screen_width", "screen_height", "interactions"]) {
    const number = context[key];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) {
      out[key] = Math.min(Math.round(number), 100_000);
    }
  }
  if (typeof context.webdriver === "boolean") out.webdriver = context.webdriver;
  if (isObject(context.utm)) {
    const utm: Record<string, string> = {};
    for (const key of ["source", "medium", "campaign", "term", "content"]) {
      const value = text(context.utm[key], 200);
      if (value !== undefined) utm[key] = value;
    }
    out.utm = utm;
  }
  return out;
}

function normalizeEvent(value: unknown, receivedAt: string): unknown {
  if (!isObject(value)) return value;
  const event: Record<string, unknown> = {
    name: value.name,
    insert_id: text(value.insert_id, 100) ?? crypto.randomUUID(),
    time: value.time === undefined
      ? receivedAt
      : isoTime(value.time) ?? value.time,
    properties: value.properties === undefined ? {} : value.properties,
  };
  const screen = text(value.screen, 300);
  if (screen !== undefined) event.screen = screen;
  if ("user_id" in value) event.user_id = text(value.user_id, 200) ?? null;
  const anonymous = text(value.anonymous_id, 200);
  if (anonymous !== undefined) event.anonymous_id = anonymous;
  return event;
}

export function normalizeBody(
  raw: unknown,
  kind: IngestKind,
  fromBrowser: boolean,
  now: Date,
): { body: Record<string, unknown>; skewMs: number } {
  if (!isObject(raw)) {
    throw new RequestError(400, "invalid_body", "Send a JSON object.");
  }
  const receivedAt = now.toISOString();
  const body: Record<string, unknown> = {
    context: normalizeContext(raw.context, fromBrowser),
  };
  const anonymousId = text(raw.anonymous_id, 200);
  const userId = text(raw.user_id, 200);
  if (anonymousId) body.anonymous_id = anonymousId;
  if (userId) body.user_id = userId;
  if (raw.traits !== undefined) {
    if (!isObject(raw.traits)) {
      throw new RequestError(
        400,
        "invalid_traits",
        "traits must be an object.",
      );
    }
    body.traits = raw.traits;
  }
  if (raw.session !== undefined) {
    const session = isObject(raw.session) ? raw.session : {};
    const id = text(session.id, 100);
    if (!id) {
      throw new RequestError(
        400,
        "invalid_session",
        "session.id must be a string.",
      );
    }
    const startedAt = isoTime(session.started_at);
    body.session = startedAt ? { id, started_at: startedAt } : { id };
  }
  const sentAt = isoTime(raw.sent_at);
  if (sentAt) body.sent_at = sentAt;
  let skewMs = sentAt ? now.getTime() - Date.parse(sentAt) : 0;
  if (Math.abs(skewMs) < SKEW_TOLERANCE_MS || Math.abs(skewMs) > MAX_SKEW_MS) {
    skewMs = 0;
  }

  if (kind === "replay") {
    const replay = isObject(raw.replay) ? raw.replay : undefined;
    if (
      !replay || !Array.isArray(replay.events) ||
      !Number.isInteger(replay.seq) || (replay.seq as number) < 0 ||
      (replay.seq as number) > 2_000_000_000 ||
      typeof replay.first_ts !== "number" || typeof replay.last_ts !== "number"
    ) {
      throw new RequestError(
        400,
        "invalid_replay",
        "replay needs seq, first_ts, last_ts and events.",
      );
    }
    if (!body.session) {
      throw new RequestError(
        400,
        "invalid_session",
        "A replay needs a session.",
      );
    }
    body.replay = {
      seq: replay.seq,
      first_ts: replay.first_ts,
      last_ts: replay.last_ts,
      events: replay.events,
    };
  } else {
    const events = raw.events ?? [];
    if (!Array.isArray(events) || events.length > MAX_EVENTS) {
      throw new RequestError(
        400,
        "invalid_events",
        `events must be an array of up to ${MAX_EVENTS}.`,
      );
    }
    body.events = events.map((event) => normalizeEvent(event, receivedAt));
  }
  if (!body.anonymous_id && !body.user_id && kind === "replay") {
    throw new RequestError(
      400,
      "identity_required",
      "Send an anonymous_id or a user_id.",
    );
  }
  return { body, skewMs };
}

function header(headers: Headers, names: string[]): string | undefined {
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}

/** Place from the CDN's visitor headers, else the country of the device's time zone. */
export function geoFromRequest(headers: Headers, timezone: unknown): Geo {
  const country = header(headers, [
    "cf-ipcountry",
    "x-vercel-ip-country",
    "cloudfront-viewer-country",
    "x-country-code",
  ])?.toUpperCase();
  if (
    country && /^[A-Z]{2}$/.test(country) && country !== "XX" &&
    country !== "T1"
  ) {
    const geo: Geo = { country, source: "edge" };
    const region = header(headers, [
      "cf-region",
      "x-vercel-ip-country-region",
      "cloudfront-viewer-country-region-name",
    ]);
    const city = header(headers, [
      "cf-ipcity",
      "x-vercel-ip-city",
      "cloudfront-viewer-city",
    ]);
    if (region && region.length <= 80) geo.region = region;
    if (city && city.length <= 80) geo.city = city;
    return geo;
  }
  const fromZone = countryFromTimezone(timezone);
  return fromZone ? { country: fromZone, source: "timezone" } : {};
}

/**
 * The headers that describe the visitor. Behind the events.kissmyapps.dev proxy the hop
 * to this function carries the proxy's own address and CDN place, so the proxy marks the
 * request (x-kma-via) and passes the visitor's under x-kma-* names with a shared secret.
 * A proxied request whose secret does not match says nothing reliable about the visitor,
 * so it gets no address and no CDN place (the time zone still gives the country).
 */
export function visitorHeaders(
  headers: Headers,
  proxySecret: string | null,
): Headers {
  if (!headers.has("x-kma-via") && !headers.has("x-kma-proxy")) return headers;
  const visitor = new Headers();
  const sent = headers.get("x-kma-proxy") ?? "";
  if (!proxySecret || !sameText(sent, proxySecret)) return visitor;
  const copy = (from: string, to: string) => {
    const value = headers.get(from)?.trim();
    if (value) visitor.set(to, value);
  };
  copy("x-kma-client-ip", "x-real-ip");
  copy("x-kma-country", "cf-ipcountry");
  copy("x-kma-region", "cf-region");
  copy("x-kma-city", "cf-ipcity");
  return visitor;
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

export function clientIp(headers: Headers): string | null {
  const direct = headers.get("cf-connecting-ip")?.trim() ??
    headers.get("x-real-ip")?.trim();
  if (direct) return direct.slice(0, 64);
  const forwarded = headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return forwarded ? forwarded.slice(0, 64) : null;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  )
    .join("");
}
