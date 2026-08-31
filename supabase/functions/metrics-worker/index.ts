import type { SupabaseClient } from "@supabase/supabase-js";
import { constantTimeEqualStrings } from "../_shared/crypto.ts";
import { requiredSecret } from "../_shared/env.ts";
import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  requestId,
  requireMethod,
} from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTS = 8;

export interface MetricClaim {
  refreshId: string;
  claimToken: string;
  attemptCount: number;
}
export interface MetricsWorkerDependencies {
  claim(): Promise<MetricClaim[]>;
  process(claim: MetricClaim): Promise<void>;
  fail(claim: MetricClaim, code: string, terminal: boolean): Promise<void>;
}
class MetricsRpcError extends Error {
  constructor(readonly databaseCode?: string) {
    super("Metrics worker RPC failed.");
  }
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatabaseBoundaryError();
  }
  return value as Record<string, unknown>;
}
function parseClaim(value: unknown): MetricClaim {
  const row = record(value);
  if (
    typeof row.refresh_id !== "string" || !UUID.test(row.refresh_id) ||
    typeof row.claim_token !== "string" || !UUID.test(row.claim_token) ||
    !Number.isInteger(row.attempt_count) || Number(row.attempt_count) < 1
  ) throw new DatabaseBoundaryError();
  return {
    refreshId: row.refresh_id,
    claimToken: row.claim_token,
    attemptCount: Number(row.attempt_count),
  };
}
function defaultDependencies(
  client: SupabaseClient,
): MetricsWorkerDependencies {
  return {
    claim: async () => {
      const { data, error } = await client.rpc(
        "claim_commercial_metric_refreshes",
        {
          p_worker: "metrics-worker",
          p_limit: 25,
          p_lease_seconds: 180,
        },
      );
      if (error || !Array.isArray(data)) {
        throw new DatabaseBoundaryError(error?.code);
      }
      return data.map(parseClaim);
    },
    process: async (claim) => {
      const { data, error } = await client.rpc(
        "process_commercial_metric_refresh",
        {
          p_refresh_id: claim.refreshId,
          p_claim_token: claim.claimToken,
        },
      );
      if (error) throw new MetricsRpcError(error.code);
      if (record(data).status !== "processed") {
        throw new DatabaseBoundaryError();
      }
    },
    fail: async (claim, code, terminal) => {
      const { data, error } = await client.rpc(
        "fail_commercial_metric_refresh",
        {
          p_refresh_id: claim.refreshId,
          p_claim_token: claim.claimToken,
          p_error_code: code,
          p_retry_delay_seconds: terminal
            ? 0
            : Math.min(3600, 30 * 2 ** Math.min(claim.attemptCount, 6)),
          p_terminal: terminal,
        },
      );
      if (error || (data !== "pending" && data !== "failed")) {
        throw new DatabaseBoundaryError(error?.code);
      }
    },
  };
}
function authenticate(request: Request): void {
  const expected = requiredSecret("INTERNAL_WORKER_SECRET");
  const supplied = request.headers.get("x-kma-worker-secret") ?? "";
  if (!supplied || !constantTimeEqualStrings(expected, supplied)) {
    throw new RequestError(
      401,
      "unauthorized",
      "Worker authentication failed.",
    );
  }
}
export function createMetricsWorkerHandler(
  supplied?: MetricsWorkerDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      authenticate(request);
      const dependencies = supplied ?? defaultDependencies(serviceClient());
      const claims = await dependencies.claim();
      let processed = 0;
      let retried = 0;
      let failed = 0;
      for (const claim of claims) {
        try {
          await dependencies.process(claim);
          processed += 1;
        } catch (error) {
          const terminal = (error instanceof MetricsRpcError &&
            ["0A000", "22023", "23505", "23514"].includes(
              error.databaseCode ?? "",
            )) ||
            claim.attemptCount >= MAX_ATTEMPTS;
          await dependencies.fail(
            claim,
            terminal
              ? "metric_refresh_rejected"
              : "metric_dependency_unavailable",
            terminal,
          );
          if (terminal) failed += 1;
          else retried += 1;
        }
      }
      return jsonResponse(200, {
        status: "processed",
        worker: "metrics-worker",
        claimed: claims.length,
        processed,
        retried,
        failed,
        mutation_enabled: true,
        request_id: id,
      });
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}
export const handleMetricsWorker = createMetricsWorkerHandler();
if (import.meta.main) Deno.serve(handleMetricsWorker);
