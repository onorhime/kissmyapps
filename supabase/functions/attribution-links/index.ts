// The link service's way into the database. deploy/link-service runs on the VPS behind
// the edge Caddy and answers every link domain; it asks this function what a host and a
// link on it should serve, tells it when a host was reached over HTTPS, and sends the
// clicks it records in batches. It sends the shared secret in X-Kma-Link-Secret; nothing
// else may call it. Clicks arrive with the visitor's address, which is hashed here with
// the analytics salt (as the events relay's addresses are) and never stored.
import { bytesToHex, constantTimeEqualStrings } from "../_shared/crypto.ts";
import { requiredSecret } from "../_shared/env.ts";
import { ConfigurationError, RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  requestId,
  requireMethod,
} from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";

/** What a link domain serves; null when no project uses the host. */
export interface LinkHost {
  host: string;
  project_id: string;
  kind: "kma" | "custom";
  enabled: boolean;
  ios_app_ids: string[];
  android: { package: string; sha256: string[] } | null;
  web_url: string | null;
}

/** What a link leads to; null when the host or the path is unknown. */
export interface LinkTarget {
  id: string;
  project_id: string;
  project_name: string;
  path: string;
  status: "active" | "paused";
  source: string;
  campaign: string | null;
  channel: string | null;
  adset: string | null;
  ad: string | null;
  deep_link_value: string | null;
  deep_link_params: Record<string, string>;
  web_url: string | null;
  ios_url: string | null;
  ios_custom: boolean;
  android_url: string | null;
  android_package: string | null;
  social: { title: string; description?: string; image?: string } | null;
}

/** A click as the link service sends it; ip is replaced by ip_sha before the database. */
export type Click = Record<string, unknown> & { ip?: unknown };

interface DatabaseResult<T> {
  data: T | null;
  error: { code?: string; message?: string } | null;
}

export interface LinkDependencies {
  /** The shared secret; throws ConfigurationError when it is not set. */
  secret(): string;
  host(host: string): Promise<DatabaseResult<LinkHost>>;
  seen(host: string): Promise<DatabaseResult<boolean>>;
  link(host: string, path: string): Promise<DatabaseResult<LinkTarget>>;
  clicks(clicks: Click[]): Promise<DatabaseResult<number>>;
  /** The analytics salt, so a click's address hashes as a session's does. */
  ipSalt(): string;
}

const MAX_CLICKS = 500;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToHex(new Uint8Array(digest));
}
const PATH = /^\/?[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/?$/;
const IP = /^[0-9a-fA-F:.]{2,45}$/;

const HOST =
  /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

function unavailable(): RequestError {
  return new RequestError(
    503,
    "unavailable",
    "The link database is unavailable. Retry shortly.",
  );
}

export function createAttributionLinksHandler(deps: LinkDependencies) {
  return async function handle(request: Request): Promise<Response> {
    const id = requestId(request);
    const headers = { "X-Request-ID": id };
    try {
      requireMethod(request, ["POST"]);
      const secret = deps.secret();
      const sent = request.headers.get("x-kma-link-secret") ?? "";
      if (!constantTimeEqualStrings(sent, secret)) {
        throw new RequestError(401, "unauthorized", "Not allowed.");
      }
      const body = await readJsonBody(request, 512 * 1024);
      const { action, host: raw, path, clicks } =
        (typeof body === "object" && body !== null ? body : {}) as Record<
          string,
          unknown
        >;
      if (action === "clicks") {
        if (
          !Array.isArray(clicks) || clicks.length === 0 ||
          clicks.length > MAX_CLICKS
        ) {
          throw new RequestError(
            400,
            "invalid_clicks",
            `Send 1 to ${MAX_CLICKS} clicks.`,
          );
        }
        const salt = deps.ipSalt();
        const hashed: Click[] = [];
        for (const click of clicks) {
          if (typeof click !== "object" || click === null) continue;
          const { ip, ...rest } = click as Click;
          hashed.push(
            typeof ip === "string" && IP.test(ip)
              ? { ...rest, ip_sha: await sha256Hex(`${salt}:${ip}`) }
              : rest,
          );
        }
        const { data, error } = await deps.clicks(hashed);
        if (error) throw unavailable();
        return jsonResponse(200, { stored: data ?? 0 }, headers);
      }
      const host = typeof raw === "string"
        ? raw.trim().toLowerCase().replace(/\.$/, "")
        : "";
      if (!HOST.test(host)) {
        throw new RequestError(400, "invalid_host", "Send a host name.");
      }
      if (action === "host") {
        const { data, error } = await deps.host(host);
        if (error) throw unavailable();
        return jsonResponse(200, { domain: data ?? null }, headers);
      }
      if (action === "seen") {
        const { data, error } = await deps.seen(host);
        if (error) throw unavailable();
        return jsonResponse(200, { seen: data === true }, headers);
      }
      if (action === "link") {
        if (typeof path !== "string" || !PATH.test(path)) {
          throw new RequestError(400, "invalid_path", "Send a link path.");
        }
        const { data, error } = await deps.link(host, path);
        if (error) throw unavailable();
        return jsonResponse(200, { link: data ?? null }, headers);
      }
      throw new RequestError(
        400,
        "invalid_action",
        "Use host, seen, link or clicks.",
      );
    } catch (error) {
      return errorResponse(error, id, headers);
    }
  };
}

export const handleAttributionLinks = createAttributionLinksHandler({
  secret: () => {
    try {
      return requiredSecret("ATTRIBUTION_LINK_SECRET");
    } catch {
      throw new ConfigurationError();
    }
  },
  host: async (host) => {
    const { data, error } = await serviceClient(5_000).rpc(
      "attribution_link_host",
      { p_host: host },
    );
    return { data: data as LinkHost | null, error };
  },
  seen: async (host) => {
    const { data, error } = await serviceClient(5_000).rpc(
      "attribution_link_seen",
      { p_host: host },
    );
    return { data: data as boolean | null, error };
  },
  link: async (host, path) => {
    const { data, error } = await serviceClient(5_000).rpc(
      "attribution_link_target",
      { p_host: host, p_path: path },
    );
    return { data: data as LinkTarget | null, error };
  },
  clicks: async (clicks) => {
    const { data, error } = await serviceClient(10_000).rpc(
      "attribution_record_clicks",
      { p_clicks: clicks },
    );
    return { data: data as number | null, error };
  },
  ipSalt: () => Deno.env.get("ANALYTICS_IP_SALT") ?? "kma-analytics",
});

if (import.meta.main) Deno.serve(handleAttributionLinks);
