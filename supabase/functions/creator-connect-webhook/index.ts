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
import {
  stripeSignedBodySha256,
  verifyStripeSignature,
} from "../_shared/stripe.ts";
import {
  connectBindings,
  type ConnectConfig,
  ConnectProvider,
  identifier,
  type JsonObject,
  object,
} from "../creator-connect/provider.ts";

interface AccountMapping {
  id: string;
  affiliate_id: string;
  connect_account_id: string;
}
interface JobMapping {
  id: string;
  amount_minor: number;
  currency: string;
  destination: string;
  transfer_group: string;
}
export interface ConnectWebhookDependencies {
  bindings: () => Map<string, ConnectConfig>;
  account: (
    config: ConnectConfig,
    accountId: string,
  ) => Promise<AccountMapping | null>;
  job: (config: ConnectConfig, jobId: string) => Promise<JobMapping | null>;
  persist: (input: JsonObject) => Promise<{ duplicate: boolean }>;
  provider: (config: ConnectConfig) => ConnectProvider;
  now: () => number;
}
function defaults(): ConnectWebhookDependencies {
  return {
    bindings: connectBindings,
    account: async (config, accountId) => {
      const { data, error } = await serviceClient().from(
        "external_creator_accounts",
      ).select("id,affiliate_id,connect_account_id").eq(
        "platform_account_id",
        config.platformAccountId,
      ).eq("livemode", config.livemode).eq("connect_account_id", accountId)
        .maybeSingle();
      if (error) throw new DatabaseBoundaryError(error.code);
      return data;
    },
    job: async (config, jobId) => {
      const { data, error } = await serviceClient().from(
        "external_settlement_jobs",
      ).select("id,amount_minor,currency,destination,transfer_group").eq(
        "id",
        jobId,
      ).eq("platform_account_id", config.platformAccountId).eq(
        "livemode",
        config.livemode,
      ).eq("kind", "transfer").maybeSingle();
      if (error) throw new DatabaseBoundaryError(error.code);
      return data;
    },
    persist: async (input) => {
      const { data, error } = await serviceClient().rpc(
        "ingest_creator_connect_event",
        { p_input: input },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return data;
    },
    provider: (config) => new ConnectProvider(config),
    now: Date.now,
  };
}
export function createCreatorConnectWebhook(
  overrides: Partial<ConnectWebhookDependencies> = {},
) {
  const deps = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      requireJsonContentType(request);
      if (request.headers.has("origin")) {
        throw new RequestError(
          403,
          "browser_request_rejected",
          "Provider authentication is required.",
        );
      }
      const bindingId = new URL(request.url).searchParams.get("binding_id") ??
        "";
      const config = deps.bindings().get(bindingId);
      if (!config) {
        throw new RequestError(
          503,
          "connect_webhook_unavailable",
          "This provider endpoint is not enabled.",
        );
      }
      const bytes = await readRequestBytes(request, 512 * 1024);
      await verifyStripeSignature(
        bytes,
        request.headers.get("stripe-signature"),
        config.webhookSecret,
        Math.floor(deps.now() / 1000),
      );
      let envelope: JsonObject;
      try {
        envelope = object(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      } catch {
        throw new RequestError(400, "invalid_event", "Invalid provider event.");
      }
      identifier(envelope.id, "evt_");
      if (envelope.livemode !== config.livemode) {
        throw new RequestError(
          400,
          "provider_mode_mismatch",
          "Provider event mode does not match this endpoint.",
        );
      }
      const type = String(envelope.type);
      if (
        ![
          "account.updated",
          "transfer.created",
          "transfer.updated",
          "transfer.reversed",
          "payout.created",
          "payout.updated",
          "payout.paid",
          "payout.failed",
          "payout.canceled",
        ].includes(type)
      ) return jsonResponse(200, { received: true, ignored: true });
      const eventObject = object(object(envelope.data).object);
      const provider = deps.provider(config),
        observedAt = new Date(deps.now()).toISOString();
      await provider.verifyPlatform();
      const input: JsonObject = {
        event_id: envelope.id,
        event_type: type,
        platform_account_id: config.platformAccountId,
        livemode: config.livemode,
        payload_sha256: await stripeSignedBodySha256(bytes),
        observed_at: observedAt,
      };
      if (type.startsWith("transfer.")) {
        // Transfers belong to the funding platform, never to a connected account.
        if (envelope.account !== undefined && envelope.account !== null) {
          throw new RequestError(
            400,
            "event_scope_mismatch",
            "Transfer event must belong to the funding platform.",
          );
        }
        const transfer = await provider.transfer(
          identifier(eventObject.id, "tr_"),
        );
        const jobId = object(transfer.metadata ?? {}).kma_job_id;
        if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId)) {
          return jsonResponse(200, { received: true, ignored: true });
        }
        const job = await deps.job(config, jobId);
        if (!job) return jsonResponse(200, { received: true, ignored: true });
        if (
          transfer.livemode !== config.livemode ||
          transfer.destination !== job.destination ||
          transfer.amount !== job.amount_minor ||
          String(transfer.currency).toUpperCase() !==
            job.currency.toUpperCase() ||
          transfer.transfer_group !== job.transfer_group ||
          !Number.isSafeInteger(transfer.amount_reversed) ||
          Number(transfer.amount_reversed) < 0 ||
          Number(transfer.amount_reversed) > job.amount_minor
        ) {
          throw new RequestError(
            409,
            "transfer_evidence_mismatch",
            "Transfer evidence does not match an approved request.",
          );
        }
        input.transfer = {
          job_id: job.id,
          transfer_id: transfer.id,
          amount_minor: transfer.amount,
          amount_reversed_minor: transfer.amount_reversed,
          currency: job.currency.toUpperCase(),
          destination: job.destination,
        };
      } else {
        const accountId = identifier(envelope.account, "acct_");
        const mapping = await deps.account(config, accountId);
        if (!mapping) {
          return jsonResponse(200, { received: true, ignored: true });
        }
        input.account_key = mapping.id;
        if (type === "account.updated") {
          if (eventObject.id !== accountId) {
            throw new RequestError(
              400,
              "event_scope_mismatch",
              "Account event identity does not match its scope.",
            );
          }
          const snapshot = provider.snapshot(
            await provider.account(accountId),
            accountId,
            mapping.affiliate_id,
            mapping.id,
          );
          input.account = {
            affiliate_id: mapping.affiliate_id,
            account_key: mapping.id,
            connect_account_id: accountId,
            charges_enabled: snapshot.charges_enabled,
            details_submitted: snapshot.details_submitted,
            transfers_enabled: snapshot.transfers_active,
            payouts_enabled: snapshot.payouts_enabled,
            disabled_reason: snapshot.disabled_reason,
            requirements_due: snapshot.requirements_due,
          };
        } else {
          const payoutId = identifier(eventObject.id, "po_"),
            payout = await provider.payout(payoutId, accountId);
          if (
            payout.id !== payoutId || payout.livemode !== config.livemode ||
            typeof payout.amount !== "number" ||
            !Number.isSafeInteger(payout.amount) || payout.amount <= 0 ||
            !/^[a-zA-Z]{3}$/.test(String(payout.currency)) ||
            !["pending", "in_transit", "paid", "failed", "canceled"].includes(
              String(payout.status),
            )
          ) {
            throw new RequestError(
              409,
              "bank_payout_evidence_mismatch",
              "Bank payout evidence is invalid.",
            );
          }
          input.bank_payout = {
            payout_id: payoutId,
            connected_account_id: accountId,
            status: payout.status,
            amount_minor: payout.amount,
            currency: String(payout.currency).toUpperCase(),
            arrival_date: typeof payout.arrival_date === "number"
              ? new Date(payout.arrival_date * 1000).toISOString()
              : null,
            failure_code: typeof payout.failure_code === "string"
              ? payout.failure_code.slice(0, 100)
              : null,
          };
        }
      }
      const receipt = await deps.persist(input);
      return jsonResponse(200, {
        received: true,
        duplicate: receipt.duplicate,
      });
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}
export const handleCreatorConnectWebhook = createCreatorConnectWebhook();
if (import.meta.main) Deno.serve(handleCreatorConnectWebhook);
