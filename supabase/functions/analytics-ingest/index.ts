import { RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  securityHeaders,
} from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import {
  APPLE_ADS_FIELD,
  appleAdsAttribution,
  attributionDatabaseError,
  type AttributionKind,
  type AttributionPayload,
  AttributionRequestError,
  isAttributionAnswer,
  normalizeAttribution,
} from "./attribution.ts";
import {
  apiKey,
  clientIp,
  contextPlace,
  geoFromRequest,
  type IngestKind,
  type IngestPayload,
  normalizeBody,
  sha256Hex,
  visitorHeaders,
} from "./payload.ts";

export interface IngestResult {
  stored?: number;
  duplicates?: number;
  blocked?: boolean;
  rejected?: { index: number; reason: string }[];
}

export interface IngestError {
  code?: string;
  message?: string;
  /** The DETAIL of the database's error, a one-word code for attribution refusals. */
  details?: string | null;
}

export interface IngestDependencies {
  ingest(
    payload: IngestPayload,
  ): Promise<{ data: IngestResult | null; error: IngestError | null }>;
  /** public.attribution_install or public.attribution_open, with the same envelope. */
  attribute?(
    kind: AttributionKind,
    payload: AttributionPayload,
  ): Promise<{ data: unknown; error: IngestError | null }>;
  /** Apple's attribution API is called with this (fetch); tests stub it. */
  appleFetch?(url: string, init: RequestInit): Promise<Response>;
  /** The wait before asking Apple again; tests skip it. */
  sleep?(ms: number): Promise<void>;
  /** How long one call to Apple may take. */
  appleTimeoutMs?: number;
  ipSalt(): string;
  /** Shared with the events.kissmyapps.dev proxy; see visitorHeaders. */
  proxySecret?(): string | null;
  now(): Date;
}

const LIMITS: Record<IngestKind, number> = {
  events: 512 * 1024,
  replay: 4 * 1024 * 1024,
};

// Apps and websites call from anywhere; which websites may use a key is checked
// against the project's allowed origins after the key is known.
function cors(origin: string | null): HeadersInit {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function databaseError(error: IngestError): RequestError {
  switch (error.code) {
    case "28000":
      return new RequestError(
        401,
        "invalid_key",
        "This API key is unknown or revoked.",
      );
    case "42501":
      return new RequestError(
        403,
        "origin_not_allowed",
        "This website is not allowed to use this key. Add it under the project's allowed websites.",
      );
    case "55000":
      return new RequestError(
        409,
        "replay_disabled",
        "Session replay is turned off for this project.",
      );
    case "54000":
      return new RequestError(
        413,
        "replay_too_large",
        "This session's replay is over the 20 MB limit.",
      );
    case "22023":
    case "22007":
    case "22P02":
      return new RequestError(
        400,
        "invalid_request",
        error.message ?? "The request is malformed.",
      );
    default:
      return new RequestError(
        503,
        "unavailable",
        "Events could not be stored. Retry later.",
      );
  }
}

async function parseJson(request: Request, limit: number): Promise<unknown> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim()
    .toLowerCase();
  // sendBeacon posts text/plain so that the page does not need a preflight.
  if (type !== "application/json" && type !== "text/plain") {
    throw new RequestError(415, "unsupported_media_type", "Send JSON.");
  }
  const bytes = await readRequestBytes(request, limit);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError(400, "invalid_json", "The body is not valid JSON.");
  }
}

type Route = IngestKind | AttributionKind;

function routeOf(request: Request): Route {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path.endsWith("/attribution/install")) return "install";
  if (path.endsWith("/attribution/open")) return "open";
  return path.endsWith("/replay") ? "replay" : "events";
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAnalyticsIngestHandler(deps: IngestDependencies) {
  /** An app's install or open: checked, Apple Ads answered, matched by the database. */
  async function attribution(
    request: Request,
    kind: AttributionKind,
    origin: string | null,
    headers: HeadersInit,
  ): Promise<Response> {
    const raw = await parseJson(request, LIMITS.events);
    const rawBody =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
    const key = apiKey(request, rawBody);
    const body = normalizeAttribution(raw, kind);
    const adServicesValue = body[APPLE_ADS_FIELD];
    // Apple's answer goes on; the value Apple was asked with never does.
    delete body[APPLE_ADS_FIELD];
    if (typeof adServicesValue === "string") {
      const answer = await appleAdsAttribution(adServicesValue, {
        fetch: deps.appleFetch ?? ((url, init) => fetch(url, init)),
        sleep: deps.sleep ?? sleep,
        timeoutMs: deps.appleTimeoutMs ?? 3_000,
      });
      if (answer) body.apple_ads = answer;
    }
    const visitor = visitorHeaders(
      request.headers,
      deps.proxySecret?.() ?? null,
    );
    const ip = clientIp(visitor);
    const payload: AttributionPayload = {
      key_hash: await sha256Hex(key),
      origin,
      ip_sha: ip ? await sha256Hex(`${deps.ipSalt()}:${ip}`) : null,
      user_agent: request.headers.get("user-agent")?.slice(0, 400) ?? null,
      geo: geoFromRequest(visitor, undefined),
      // The bodies carry no send time to measure the device's clock by.
      clock_skew_ms: 0,
      body,
    };
    if (!deps.attribute) throw attributionDatabaseError({});
    const { data, error } = await deps.attribute(kind, payload);
    if (error) throw attributionDatabaseError(error);
    if (!isAttributionAnswer(data)) throw attributionDatabaseError({});
    return jsonResponse(200, data, headers);
  }

  return async function handle(request: Request): Promise<Response> {
    const id = requestId(request);
    const origin = request.headers.get("origin");
    const headers = { ...cors(origin), "X-Request-ID": id };
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: securityHeaders(headers),
        });
      }
      if (request.method !== "POST") {
        throw new RequestError(405, "method_not_allowed", "Use POST.");
      }
      const route = routeOf(request);
      if (route === "install" || route === "open") {
        return await attribution(request, route, origin, headers);
      }
      const kind: IngestKind = route;
      const raw = await parseJson(request, LIMITS[kind]);
      const rawBody =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? raw as Record<string, unknown>
          : {};
      const key = apiKey(request, rawBody);
      const now = deps.now();
      const { body, skewMs } = normalizeBody(raw, kind, origin !== null, now);
      const visitor = visitorHeaders(
        request.headers,
        deps.proxySecret?.() ?? null,
      );
      // A server key's request comes from the merchant's server, so its own place says
      // nothing about the user; the place of the address it named does, unless it named a
      // country itself.
      const context = body.context as Record<string, unknown>;
      const named = key.startsWith("kma_sk_") ? contextPlace(visitor) : null;
      if (named && context.country === undefined) {
        Object.assign(context, {
          country: named.country,
          region: named.region,
          city: named.city,
        });
      }
      const ip = clientIp(visitor);
      const payload: IngestPayload = {
        key_hash: await sha256Hex(key),
        kind,
        origin,
        ip_sha: ip ? await sha256Hex(`${deps.ipSalt()}:${ip}`) : null,
        user_agent: request.headers.get("user-agent")?.slice(0, 400) ?? null,
        geo: geoFromRequest(visitor, context.timezone),
        clock_skew_ms: skewMs,
        body,
      };
      const { data, error } = await deps.ingest(payload);
      if (error) throw databaseError(error);
      return jsonResponse(200, { ...data, request_id: id }, headers);
    } catch (error) {
      if (error instanceof AttributionRequestError) {
        return jsonResponse(error.status, {
          error: error.code,
          message: error.message,
          ...error.extra,
          request_id: id,
        }, headers);
      }
      return errorResponse(error, id, headers);
    }
  };
}

export const handleAnalyticsIngest = createAnalyticsIngestHandler({
  ingest: async (payload) => {
    const { data, error } = await serviceClient(10_000).rpc(
      "analytics_ingest",
      { p: payload },
    );
    return { data: data as IngestResult | null, error };
  },
  attribute: async (kind, payload) => {
    const { data, error } = await serviceClient(10_000).rpc(
      kind === "install" ? "attribution_install" : "attribution_open",
      { p: payload },
    );
    return { data, error };
  },
  ipSalt: () => Deno.env.get("ANALYTICS_IP_SALT") ?? "kma-analytics",
  proxySecret: () => Deno.env.get("ANALYTICS_PROXY_SECRET") || null,
  now: () => new Date(),
});

if (import.meta.main) Deno.serve(handleAnalyticsIngest);
