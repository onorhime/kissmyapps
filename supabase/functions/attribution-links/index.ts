// The link service's way into the database. deploy/link-service runs on the VPS behind
// the edge Caddy and answers every link domain; it asks this function what a host should
// serve and tells it when a host was reached over HTTPS. It sends the shared secret in
// X-Kma-Link-Secret; nothing else may call it.
import { constantTimeEqualStrings } from "../_shared/crypto.ts";
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

interface DatabaseResult<T> {
  data: T | null;
  error: { code?: string; message?: string } | null;
}

export interface LinkDependencies {
  /** The shared secret; throws ConfigurationError when it is not set. */
  secret(): string;
  host(host: string): Promise<DatabaseResult<LinkHost>>;
  seen(host: string): Promise<DatabaseResult<boolean>>;
}

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
      const body = await readJsonBody(request, 4096);
      const { action, host: raw } =
        (typeof body === "object" && body !== null ? body : {}) as Record<
          string,
          unknown
        >;
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
      throw new RequestError(400, "invalid_action", "Use host or seen.");
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
});

if (import.meta.main) Deno.serve(handleAttributionLinks);
