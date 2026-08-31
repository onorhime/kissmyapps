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

export interface ReconciliationClaim {
  reconciliationRunId: string;
  claimToken: string;
  attemptCount: number;
}
export interface ReconciliationWorkerDependencies {
  claim(): Promise<ReconciliationClaim[]>;
  process(claim: ReconciliationClaim): Promise<"passed" | "failed">;
  fail(
    claim: ReconciliationClaim,
    code: string,
    terminal: boolean,
  ): Promise<void>;
  diagnostic?: (entry: Readonly<Record<string, unknown>>) => void;
}
class ReconciliationRpcError extends Error {
  constructor(readonly databaseCode?: string) {
    super("Reconciliation worker RPC failed.");
  }
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatabaseBoundaryError();
  }
  return value as Record<string, unknown>;
}
function parseClaim(value: unknown): ReconciliationClaim {
  const row = record(value);
  if (
    typeof row.reconciliation_run_id !== "string" ||
    !UUID.test(row.reconciliation_run_id) ||
    typeof row.claim_token !== "string" || !UUID.test(row.claim_token) ||
    !Number.isInteger(row.attempt_count) || Number(row.attempt_count) < 1
  ) throw new DatabaseBoundaryError();
  return {
    reconciliationRunId: row.reconciliation_run_id,
    claimToken: row.claim_token,
    attemptCount: Number(row.attempt_count),
  };
}
function defaultDependencies(
  client: SupabaseClient,
): ReconciliationWorkerDependencies {
  return {
    claim: async () => {
      const { data, error } = await client.rpc(
        "claim_commercial_reconciliations",
        {
          p_worker: "reconciliation-worker",
          p_limit: 10,
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
        "process_commercial_reconciliation",
        {
          p_reconciliation_run_id: claim.reconciliationRunId,
          p_claim_token: claim.claimToken,
        },
      );
      if (error) throw new ReconciliationRpcError(error.code);
      const status = record(data).status;
      if (status !== "passed" && status !== "failed") {
        throw new DatabaseBoundaryError();
      }
      return status;
    },
    fail: async (claim, code, terminal) => {
      const { data, error } = await client.rpc(
        "fail_commercial_reconciliation",
        {
          p_reconciliation_run_id: claim.reconciliationRunId,
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
export function createReconciliationWorkerHandler(
  supplied?: ReconciliationWorkerDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      authenticate(request);
      const dependencies = supplied ?? defaultDependencies(serviceClient());
      const claims = await dependencies.claim();
      const diagnostic = dependencies.diagnostic ?? ((entry) => {
        console.error(JSON.stringify(entry));
      });
      let processed = 0;
      let businessFailed = 0;
      let retried = 0;
      let failed = 0;
      for (const claim of claims) {
        try {
          const outcome = await dependencies.process(claim);
          processed += 1;
          if (outcome === "failed") {
            businessFailed += 1;
            diagnostic({
              level: "error",
              worker: "reconciliation-worker",
              outcome: "business_reconciliation_failed",
              reconciliation_run_id: claim.reconciliationRunId,
              attempt_count: claim.attemptCount,
              request_id: id,
            });
          }
        } catch (error) {
          const terminal = (error instanceof ReconciliationRpcError &&
            ["0A000", "22023", "23505", "23514"].includes(
              error.databaseCode ?? "",
            )) ||
            claim.attemptCount >= MAX_ATTEMPTS;
          await dependencies.fail(
            claim,
            terminal
              ? "reconciliation_rejected"
              : "reconciliation_dependency_unavailable",
            terminal,
          );
          if (terminal) {
            failed += 1;
            diagnostic({
              level: "error",
              worker: "reconciliation-worker",
              outcome: "terminal_item_failure",
              failure_code: "reconciliation_rejected",
              reconciliation_run_id: claim.reconciliationRunId,
              attempt_count: claim.attemptCount,
              request_id: id,
            });
          } else retried += 1;
        }
      }
      return jsonResponse(200, {
        status: "processed",
        worker: "reconciliation-worker",
        claimed: claims.length,
        processed,
        business_failed: businessFailed,
        retried,
        failed,
        mutation_enabled: true,
        external_transfer_enabled: false,
        request_id: id,
      });
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}
export const handleReconciliationWorker = createReconciliationWorkerHandler();
if (import.meta.main) Deno.serve(handleReconciliationWorker);
