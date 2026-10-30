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
}

export interface IngestDependencies {
  ingest(
    payload: IngestPayload,
  ): Promise<{ data: IngestResult | null; error: IngestError | null }>;
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

export function createAnalyticsIngestHandler(deps: IngestDependencies) {
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
      const kind: IngestKind =
        new URL(request.url).pathname.replace(/\/+$/, "").endsWith("/replay")
          ? "replay"
          : "events";
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
  ipSalt: () => Deno.env.get("ANALYTICS_IP_SALT") ?? "kma-analytics",
  proxySecret: () => Deno.env.get("ANALYTICS_PROXY_SECRET") || null,
  now: () => new Date(),
});

if (import.meta.main) Deno.serve(handleAnalyticsIngest);
