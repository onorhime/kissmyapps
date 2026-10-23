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
import {
  connectBindings,
  type ConnectConfig,
  ConnectProvider,
  ProviderError,
  type TransferJob,
} from "../creator-connect/provider.ts";

export interface PayoutWorkerDependencies {
  authenticate: (request: Request) => void;
  bindings: () => Map<string, ConnectConfig>;
  processCommissions: () => Promise<unknown>;
  reconciliationJobs: (config: ConnectConfig) => Promise<TransferJob[]>;
  reconcile: (
    job: TransferJob,
    providerId: string,
    provider: ConnectProvider,
  ) => Promise<unknown>;
  claim: (config: ConnectConfig) => Promise<TransferJob[]>;
  beginAttempt: (job: TransferJob) => Promise<TransferJob>;
  account: (
    job: TransferJob,
  ) => Promise<{ affiliate_id: string; account_key: string }>;
  finish: (
    input: {
      id: string;
      lease_token: string;
      status: "succeeded" | "retry" | "reconcile" | "failed";
      provider_id?: string;
      safe_error?: string;
    },
  ) => Promise<void>;
  provider: (config: ConnectConfig) => ConnectProvider;
}
function defaults(): PayoutWorkerDependencies {
  return {
    authenticate: (request) => {
      if (
        request.headers.has("origin") ||
        !constantTimeEqualStrings(
          request.headers.get("x-kma-worker-secret") ?? "",
          requiredSecret("INTERNAL_WORKER_SECRET"),
        )
      ) {
        throw new RequestError(
          401,
          "unauthorized",
          "Worker authentication failed.",
        );
      }
    },
    bindings: connectBindings,
    processCommissions: async () => {
      const { data, error } = await serviceClient().rpc(
        "process_external_commissions",
        { p_limit: 100 },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return data;
    },
    reconciliationJobs: async (config) => {
      const { data, error } = await serviceClient().rpc(
        "claim_creator_reconciliation_jobs",
        {
          p_platform_account_id: config.platformAccountId,
          p_livemode: config.livemode,
          p_limit: 10,
        },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return data ?? [];
    },
    reconcile: async (job, providerId, provider) => {
      const observedAt = new Date().toISOString();
      const transfer = await provider.transfer(
        job.kind === "transfer" ? providerId : job.transfer_id!,
      );
      const input = {
        id: job.id,
        platform_account_id: job.platform_account_id,
        livemode: job.livemode,
        provider_id: providerId,
        destination: job.destination,
        amount_minor: job.amount_minor,
        currency: job.currency,
        ...(job.kind === "transfer"
          ? {
            transfer_group: job.transfer_group,
            amount_reversed: transfer.amount_reversed,
          }
          : { transfer_id: job.transfer_id }),
        observed_at: observedAt,
      };
      const { data, error } = await serviceClient().rpc(
        job.kind === "transfer"
          ? "reconcile_creator_transfer_evidence"
          : "reconcile_creator_reversal_evidence",
        { p_input: input },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return data;
    },
    claim: async (config) => {
      const { data, error } = await serviceClient().rpc(
        "claim_creator_transfer_jobs",
        {
          p_platform_account_id: config.platformAccountId,
          p_livemode: config.livemode,
          p_limit: 2,
          p_lease_seconds: 300,
        },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return data ?? [];
    },
    beginAttempt: async (job) => {
      const { data, error } = await serviceClient().rpc(
        "begin_creator_transfer_attempt",
        { p_input: { id: job.id, lease_token: job.lease_token } },
      );
      if (error || !data) throw new DatabaseBoundaryError(error?.code);
      return data;
    },
    account: async (job) => {
      const { data, error } = await serviceClient().from(
        "external_creator_accounts",
      ).select("id,affiliate_id").eq(
        "platform_account_id",
        job.platform_account_id,
      ).eq("livemode", job.livemode).eq("connect_account_id", job.destination)
        .single();
      if (error || !data) throw new DatabaseBoundaryError(error?.code);
      return { affiliate_id: data.affiliate_id, account_key: data.id };
    },
    finish: async (input) => {
      const { error } = await serviceClient().rpc(
        "finish_creator_transfer_job",
        { p_input: input },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
    },
    provider: (config) => new ConnectProvider(config),
  };
}
export function createCreatorPayoutWorker(
  overrides: Partial<PayoutWorkerDependencies> = {},
) {
  const deps = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      deps.authenticate(request);
      const bindings = deps.bindings();
      await deps.processCommissions();
      if (!bindings.size) {
        return jsonResponse(200, { enabled: false, processed: 0 });
      }
      const outcomes: Array<{ id: string; status: string }> = [];
      for (const config of bindings.values()) {
        const provider = deps.provider(config);
        await provider.verifyPlatform();
        // Recovery remains read-only even while new transfers are disabled.
        for (const job of await deps.reconciliationJobs(config)) {
          try {
            const receipt = await provider.execute(job, false);
            const reconciliation = await deps.reconcile(
              job,
              receipt.provider_id,
              provider,
            );
            outcomes.push({
              id: job.id,
              status: reconciliation && typeof reconciliation === "object" &&
                  "reconciliation_required" in reconciliation &&
                  reconciliation.reconciliation_required === true
                ? "reconciliation_required"
                : "reconciled",
            });
          } catch (error) {
            if (error instanceof DatabaseBoundaryError) throw error;
            outcomes.push({ id: job.id, status: "reconciliation_pending" });
          }
        }
        if (!config.transfersEnabled) continue;
        for (const job of await deps.claim(config)) {
          let result: Parameters<PayoutWorkerDependencies["finish"]>[0];
          try {
            provider.validateJob(job);
            if (job.kind === "transfer") {
              const mapping = await deps.account(job);
              const account = await provider.account(job.destination);
              const current = provider.snapshot(
                account,
                job.destination,
                mapping.affiliate_id,
                mapping.account_key,
              );
              if (
                !current.transfers_active || !current.payouts_enabled ||
                current.disabled_reason || current.requirements_due.length
              ) {
                throw new RequestError(
                  409,
                  "creator_account_not_ready",
                  "The creator account needs attention before a transfer.",
                );
              }
              await provider.assertTransferCurrency(job, account);
            }
            const transfer = await provider.execute(
              job,
              true,
              () => deps.beginAttempt(job),
            );
            result = {
              id: job.id,
              lease_token: job.lease_token,
              status: "succeeded",
              provider_id: transfer.provider_id,
            };
          } catch (error) {
            // A timeout may mean Stripe accepted the movement. Reconcile first;
            // never turn an ambiguous response into a fresh transfer identity.
            result = {
              id: job.id,
              lease_token: job.lease_token,
              status: error instanceof ProviderError &&
                  (error.ambiguous ||
                    error.safeCode ===
                      "provider_balance_or_account_unavailable")
                ? "retry"
                : error instanceof RequestError &&
                    [
                      "creator_account_not_ready",
                      "transfer_currency_unavailable",
                    ].includes(error.code)
                ? "retry"
                : "failed",
              safe_error: error instanceof ProviderError
                ? error.safeCode
                : error instanceof RequestError
                ? error.code
                : "provider_processing_failed",
            };
          }
          // A failed DB commit deliberately bubbles out. The lease remains and a
          // later claim searches Stripe before retrying the same idempotent job.
          await deps.finish(result);
          outcomes.push({ id: job.id, status: result.status });
        }
      }
      return jsonResponse(200, {
        enabled: true,
        processed: outcomes.length,
        outcomes,
        bank_payouts_initiated: false,
      });
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}
export const handleCreatorPayoutWorker = createCreatorPayoutWorker();
if (import.meta.main) Deno.serve(handleCreatorPayoutWorker);
