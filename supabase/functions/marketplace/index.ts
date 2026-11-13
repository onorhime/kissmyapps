// Public marketplace: the live affiliate programs, and one program by its
// address. Read only, signed out, no cookies and no request body. Everything
// it answers comes from two service-only database functions and is copied
// field by field into the two public shapes in programs.ts.
//
// GET /marketplace              -> 200 {"programs": [ProgramCard, ...]}
// GET /marketplace?slug=<slug>  -> 200 {"program": ProgramDetail} or 404
//
// Off unless MARKETPLACE_ENABLED is exactly "true".
import {
  ConfigurationError,
  DatabaseBoundaryError,
  NotFoundError,
  RequestError,
} from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  requestId,
  requireMethod,
  securityHeaders,
} from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { isProgramSlug, programAnswer, programList } from "./programs.ts";

const WORKER = "marketplace";
const DATABASE_TIMEOUT_MS = 8_000;
const SUCCESS_CACHE = "public, max-age=60";

/**
 * Any site may read the marketplace. No credential is read, so none is
 * allowed; the request headers listed are the ones browser clients add on
 * their own, and the function ignores all of them.
 */
const CORS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "apikey, authorization, content-type, x-client-info",
  "Access-Control-Max-Age": "600",
};

/** The two database reads. Each returns the function's JSON answer as is. */
export interface MarketplaceStore {
  list: () => Promise<unknown>;
  detail: (slug: string) => Promise<unknown>;
}

export interface MarketplaceLogEntry {
  level: "warning" | "error";
  worker: typeof WORKER;
  outcome: string;
  request_id: string;
  database_code?: string;
}

export interface MarketplaceDependencies {
  enabled: () => boolean;
  store: () => MarketplaceStore;
  log: (entry: MarketplaceLogEntry) => void;
}

function databaseStore(): MarketplaceStore {
  const call = async (name: string, input?: Record<string, unknown>) => {
    const { data, error } = await serviceClient(DATABASE_TIMEOUT_MS).rpc(
      name,
      input,
    );
    if (error) throw new DatabaseBoundaryError(error.code);
    return data as unknown;
  };
  return {
    list: () => call("marketplace_programs"),
    detail: (slug) => call("marketplace_program", { p_slug: slug }),
  };
}

function defaults(): MarketplaceDependencies {
  return {
    enabled: () => Deno.env.get("MARKETPLACE_ENABLED") === "true",
    store: databaseStore,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

/** The slug asked for, `null` for the list, or a 404 for anything else. */
function requestedSlug(url: URL): string | null {
  const slugs = url.searchParams.getAll("slug");
  if (slugs.length === 0) return null;
  if (slugs.length > 1 || !isProgramSlug(slugs[0])) throw new NotFoundError();
  return slugs[0];
}

export function createMarketplaceHandler(
  overrides: Partial<MarketplaceDependencies> = {},
) {
  const deps: MarketplaceDependencies = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    const headers = { ...CORS, "X-Request-ID": rid };
    const ok = (body: unknown): Response =>
      jsonResponse(200, body, { ...headers, "Cache-Control": SUCCESS_CACHE });
    try {
      requireMethod(request, ["GET", "OPTIONS"]);
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: securityHeaders(headers),
        });
      }
      if (!deps.enabled()) {
        throw new RequestError(
          503,
          "marketplace_disabled",
          "The marketplace is not enabled.",
        );
      }
      const slug = requestedSlug(new URL(request.url));
      const store = deps.store();
      if (slug === null) {
        const programs = programList(await store.list());
        // An answer that is not the agreed shape is never passed on.
        if (!programs) throw new DatabaseBoundaryError();
        return ok({ programs });
      }
      let answer: unknown;
      try {
        answer = await store.detail(slug);
      } catch (error) {
        // The database may also say "no such program" by raising it.
        if (
          error instanceof DatabaseBoundaryError &&
          error.databaseCode === "P0002"
        ) throw new NotFoundError();
        throw error;
      }
      const program = programAnswer(answer);
      if (program === undefined) throw new DatabaseBoundaryError();
      if (program === null) throw new NotFoundError();
      return ok({ program });
    } catch (error) {
      const response = errorResponse(error, rid, headers);
      if (response.status >= 500) {
        try {
          deps.log({
            level: error instanceof RequestError ? "warning" : "error",
            worker: WORKER,
            outcome: error instanceof RequestError ||
                error instanceof DatabaseBoundaryError ||
                error instanceof ConfigurationError
              ? error.code
              : "internal_error",
            request_id: rid,
            ...(error instanceof DatabaseBoundaryError &&
                /^[0-9A-Z]{5}$/.test(error.databaseCode ?? "")
              ? { database_code: error.databaseCode }
              : {}),
          });
        } catch {
          // A log sink that throws must not change the answer.
        }
      }
      return response;
    }
  };
}

export const handleMarketplace = createMarketplaceHandler();
if (import.meta.main) Deno.serve(handleMarketplace);
