// Exchange-rate worker for attribution ROI, called once a day by the schedule
// (16:30 UTC, after the ECB publishes around 16:00 CET) or by hand with the
// internal worker credential. Each run reads the European Central Bank's euro
// reference rates and stores them through attribution_fx_store, in calls of at
// most CHUNK_SIZE rates, so revenue and cost in any ECB currency can be shown in
// the project's currency.
//
// The body picks the file: {} or no body reads the last 90 days
// (eurofxref-hist-90d.xml), {"range":"daily"} the latest day
// (eurofxref-daily.xml), {"range":"all"} every day since 1999
// (eurofxref-hist.xml). Storing a day again replaces it, so any run can be
// repeated. Off unless ATTRIBUTION_FX_ENABLED is exactly "true". Logs carry
// outcome codes and counts only.
import { constantTimeEqualStrings } from "../_shared/crypto.ts";
import {
  ConfigurationError,
  DatabaseBoundaryError,
  RequestError,
} from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireMethod,
} from "../_shared/http.ts";
import { isPlainObject } from "../_shared/validation.ts";
import { ECB_URLS, type EcbRange, isDay, parseEcbXml } from "./ecb.ts";
import { databaseFxStore, type FxStore } from "./store.ts";

const WORKER = "attribution-fx-worker";

/** Rates sent to the database per call (it takes up to 20000). */
export const CHUNK_SIZE = 5_000;
/** The whole history is a few megabytes; anything far larger is not the ECB's file. */
export const MAXIMUM_XML_BYTES = 32 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;
const MAXIMUM_BODY_BYTES = 1024;
/** The first day of the euro's reference rates. */
const FIRST_DAY = "1999-01-04";

export interface FxWorkerLogEntry {
  level: "info" | "warning" | "error";
  worker: typeof WORKER;
  outcome: string;
  request_id: string;
  range?: EcbRange;
  /** The ECB's HTTP status when it did not answer 200. */
  upstream_status?: number;
  counts?: Record<string, number>;
}

export interface FxWorkerDependencies {
  enabled: () => boolean;
  authenticate: (request: Request) => void;
  store: () => FxStore;
  fetcher: typeof fetch;
  now: () => number;
  log: (entry: FxWorkerLogEntry) => void;
}

function defaults(): FxWorkerDependencies {
  return {
    enabled: () => Deno.env.get("ATTRIBUTION_FX_ENABLED") === "true",
    // The schedule has its own credential; a person or another function uses
    // the internal worker credential.
    authenticate: (request) => {
      const scheduled = request.headers.has("x-kma-scheduler-secret");
      const expected = Deno.env.get(
        scheduled
          ? "ATTRIBUTION_FX_SCHEDULER_SECRET"
          : "INTERNAL_WORKER_SECRET",
      )?.trim() ?? "";
      const supplied = request.headers.get(
        scheduled ? "x-kma-scheduler-secret" : "x-kma-worker-secret",
      ) ?? "";
      if (
        request.headers.has("origin") || expected.length < 32 ||
        !constantTimeEqualStrings(supplied, expected)
      ) {
        throw new RequestError(
          401,
          "unauthorized",
          "Worker authentication failed.",
        );
      }
    },
    store: databaseFxStore,
    fetcher: fetch,
    now: Date.now,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

/** The ECB could not be read; upstreamStatus is its HTTP status, if it answered. */
export class EcbError extends RequestError {
  constructor(code: string, readonly upstreamStatus?: number) {
    super(502, code, "The ECB exchange rates could not be read.");
    this.name = "EcbError";
  }
}

/** The file the body asks for: 90 days unless it says daily or all. */
export async function readRange(request: Request): Promise<EcbRange> {
  const raw = await readRequestBytes(request, MAXIMUM_BODY_BYTES);
  let body: unknown = {};
  const text = new TextDecoder().decode(raw).trim();
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!isPlainObject(body)) {
    throw new RequestError(400, "invalid_body", "The body is a JSON object.");
  }
  const range = body.range ?? "90d";
  if (range !== "daily" && range !== "90d" && range !== "all") {
    throw new RequestError(
      400,
      "invalid_range",
      'range is "daily", "90d" or "all".',
    );
  }
  return range;
}

/** The ECB file as text, at most MAXIMUM_XML_BYTES. */
export async function fetchEcb(
  fetcher: typeof fetch,
  url: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/xml, text/xml;q=0.9" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new EcbError("ecb_unreachable");
  }
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw new EcbError("ecb_unavailable", response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAXIMUM_XML_BYTES) {
        await reader.cancel();
        throw new EcbError("ecb_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof EcbError) throw error;
    throw new EcbError("ecb_unreachable");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createAttributionFxWorker(
  overrides: Partial<FxWorkerDependencies> = {},
) {
  const deps: FxWorkerDependencies = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    const counts = { days: 0, rates: 0, stored: 0, skipped: 0 };
    let range: EcbRange | undefined;
    try {
      requireMethod(request, ["POST"]);
      deps.authenticate(request);
      if (!deps.enabled()) {
        return jsonResponse(200, { enabled: false, request_id: rid });
      }
      range = await readRange(request);
      const parsed = parseEcbXml(await fetchEcb(deps.fetcher, ECB_URLS[range]));
      // Only days the database takes: from the euro's first day to tomorrow.
      const tomorrow = new Date(deps.now() + 86_400_000).toISOString().slice(
        0,
        10,
      );
      const rates = parsed.rates.filter((rate) =>
        isDay(rate.day) && rate.day >= FIRST_DAY && rate.day <= tomorrow
      );
      counts.rates = rates.length;
      counts.days = new Set(rates.map((rate) => rate.day)).size;
      counts.skipped = parsed.skipped + parsed.rates.length - rates.length;
      if (rates.length === 0) throw new EcbError("ecb_no_rates");

      const store = deps.store();
      let latestDay: string | null = null;
      for (let start = 0; start < rates.length; start += CHUNK_SIZE) {
        const answer = await store.save(rates.slice(start, start + CHUNK_SIZE));
        counts.stored += answer.stored;
        latestDay = answer.latestDay;
      }
      deps.log({
        level: "info",
        worker: WORKER,
        outcome: "processed",
        request_id: rid,
        range,
        counts,
      });
      return jsonResponse(200, {
        status: "processed",
        worker: WORKER,
        enabled: true,
        range,
        ...counts,
        latest_day: latestDay,
        request_id: rid,
      });
    } catch (error) {
      const response = errorResponse(error, rid);
      deps.log({
        level: response.status >= 500 ? "error" : "warning",
        worker: WORKER,
        outcome: error instanceof RequestError ||
            error instanceof ConfigurationError ||
            error instanceof DatabaseBoundaryError
          ? error.code
          : "internal_error",
        request_id: rid,
        ...(range ? { range } : {}),
        ...(error instanceof EcbError && error.upstreamStatus !== undefined
          ? { upstream_status: error.upstreamStatus }
          : {}),
        counts,
      });
      return response;
    }
  };
}

export const handleAttributionFxWorker = createAttributionFxWorker();
if (import.meta.main) Deno.serve(handleAttributionFxWorker);
