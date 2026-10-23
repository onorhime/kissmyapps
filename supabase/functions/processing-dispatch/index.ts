import { constantTimeEqualStrings } from "../_shared/crypto.ts";
import { requiredEnv, requiredSecret } from "../_shared/env.ts";
import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireJsonContentType,
  requireMethod,
} from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";

const workers = ["stripe-worker", "commercial-worker", "metrics-worker"];
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DispatchDependencies {
  begin(runId: string, worker: string): Promise<boolean>;
  invoke(worker: string, runId: string): Promise<Response>;
  recordDiagnostic?(diagnostic: DispatchDiagnostic): Promise<void>;
}

export interface DispatchDiagnostic {
  run_id: string;
  worker: string;
  code:
    | "worker_http_failure"
    | "worker_transport_failure"
    | "worker_response_invalid";
  upstream_http_status: number | null;
  duration_ms: number;
}

// An upstream response is untrusted. Bound the stream before decoding and never
// persist its body, headers, exception text or credentials in diagnostics.
async function boundedResult(response: Response): Promise<unknown> {
  if (!response.body) throw new DatabaseBoundaryError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new DatabaseBoundaryError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function dependencies(): DispatchDependencies {
  return {
    async begin(runId, worker) {
      const { data, error } = await serviceClient(10_000).rpc(
        "begin_processing_stage",
        { p_run_id: runId, p_worker: worker },
      );
      if (error || typeof data !== "boolean") throw new DatabaseBoundaryError();
      return data;
    },
    invoke(worker, runId) {
      return fetch(`${requiredEnv("SUPABASE_URL")}/functions/v1/${worker}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kma-worker-secret": requiredSecret("INTERNAL_WORKER_SECRET"),
          "x-request-id": runId,
        },
        body: "{}",
        redirect: "error",
        signal: AbortSignal.timeout(80_000),
      });
    },
    async recordDiagnostic(diagnostic) {
      const { data, error } = await serviceClient(5_000).rpc(
        "record_processing_stage_diagnostic",
        { p_diagnostic: diagnostic },
      );
      if (error || typeof data !== "boolean") throw new DatabaseBoundaryError();
    },
  };
}

export function createDispatchHandler(supplied?: DispatchDependencies) {
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    let issued:
      | { runId: string; worker: string; deps: DispatchDependencies }
      | null = null;
    let upstreamStatus: number | null = null;
    let receivedResponse = false;
    let startedAt = 0;
    try {
      requireMethod(request, ["POST"]);
      const expected = requiredSecret("PROCESSING_SCHEDULER_SECRET");
      const received = request.headers.get("x-kma-scheduler-secret") ?? "";
      if (!received || !constantTimeEqualStrings(expected, received)) {
        throw new RequestError(
          401,
          "unauthorized",
          "Scheduler authentication failed.",
        );
      }
      requireJsonContentType(request);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(
          new TextDecoder().decode(await readRequestBytes(request, 512)),
        );
      } catch {
        throw new RequestError(
          400,
          "invalid_request",
          "Invalid scheduler request.",
        );
      }
      if (
        !body || Array.isArray(body) || Object.keys(body).length !== 2 ||
        typeof body.run_id !== "string" || !uuid.test(body.run_id) ||
        typeof body.worker !== "string" || !workers.includes(body.worker)
      ) {
        throw new RequestError(
          400,
          "invalid_request",
          "Invalid scheduler request.",
        );
      }
      const deps = supplied ?? dependencies();
      // The secret alone cannot start arbitrary/parallel work. Only the current
      // database-issued stage may begin, once, while the schedule is enabled.
      if (!await deps.begin(body.run_id, body.worker)) {
        throw new RequestError(
          409,
          "stage_not_current",
          "This stage cannot be started.",
        );
      }
      issued = { runId: body.run_id, worker: body.worker, deps };
      startedAt = Date.now();
      const response = await deps.invoke(body.worker, body.run_id);
      receivedResponse = true;
      upstreamStatus = response.status;
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new RequestError(
          503,
          "worker_unavailable",
          "Worker did not complete successfully.",
        );
      }
      const value = await boundedResult(response);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new DatabaseBoundaryError();
      }
      const result = value as Record<string, unknown>;
      if (result.status !== "processed" || result.worker !== body.worker) {
        throw new DatabaseBoundaryError();
      }
      const counts: Record<string, number> = {};
      for (
        const key of ["claimed", "processed", "retried", "failed", "deferred"]
      ) {
        const value = key === "deferred" && body.worker !== "stripe-worker"
          ? 0
          : result[key];
        if (
          typeof value !== "number" || !Number.isSafeInteger(value) ||
          value < 0 || value > 25
        ) {
          throw new DatabaseBoundaryError();
        }
        counts[key] = value;
      }
      if (
        counts.claimed !==
          counts.processed + counts.retried + counts.failed + counts.deferred
      ) {
        throw new DatabaseBoundaryError();
      }
      // Never forward worker errors, headers, payloads, or credentials to pg_net.
      return jsonResponse(200, {
        status: "processed",
        worker: body.worker,
        run_id: body.run_id,
        ...counts,
        request_id: id,
      });
    } catch (error) {
      if (issued) {
        const diagnostic: DispatchDiagnostic = {
          run_id: issued.runId,
          worker: issued.worker,
          code: !receivedResponse
            ? "worker_transport_failure"
            : upstreamStatus !== 200
            ? "worker_http_failure"
            : "worker_response_invalid",
          upstream_http_status: upstreamStatus,
          duration_ms: Math.min(180_000, Math.max(0, Date.now() - startedAt)),
        };
        console.warn(
          JSON.stringify({ event: "processing_stage_failure", ...diagnostic }),
        );
        try {
          await issued.deps.recordDiagnostic?.(diagnostic);
        } catch {
          // Diagnostic storage failure never retries a worker or hides its failure.
          console.warn(JSON.stringify({
            event: "processing_diagnostic_unavailable",
            run_id: issued.runId,
          }));
        }
      }
      return errorResponse(error, id);
    }
  };
}

export const handleProcessingDispatch = createDispatchHandler();
if (import.meta.main) Deno.serve(handleProcessingDispatch);
