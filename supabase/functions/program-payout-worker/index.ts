// Payout worker. An admin makes a payout; this sends it: one Stripe transfer
// from the KissMyApps platform account to the creator's own Stripe account,
// through the legacy ConnectProvider, unchanged. Called by the schedule when a
// payout is due, or by a person.
//
// For each payout it was handed (claim, with a lease):
//   1. If Stripe was ever asked for it, look the transfer up first. Found: paid.
//      Not found and too old to ask again (23 hours): failed.
//   2. Read the creator's account from Stripe and store what it says. Not able
//      to receive: failed, Stripe is not asked.
//   3. The platform must have the amount available in that currency. If not:
//      wait, Stripe is not asked.
//   4. The account must be payable in that currency. If not: failed.
//   5. Tell the database Stripe is about to be asked (begin), then ask once.
//
// The transfer carries the payout id as its Idempotency-Key, transfer group
// and metadata, so asking twice makes one transfer and a lost answer is found
// again by looking. "failed" gives the money back to the creator's sum; it is
// only ever said when Stripe has no transfer for the payout.
// Off unless PROGRAM_PAYOUTS_ENABLED is exactly "true". Live only. Logs carry
// outcome codes and payout ids only.
import { constantTimeEqualStrings } from "../_shared/crypto.ts";
import {
  ConfigurationError,
  DatabaseBoundaryError,
  RequestError,
} from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  requestId,
  requireMethod,
} from "../_shared/http.ts";
import {
  type AccountSnapshot,
  type ConnectConfig,
  ConnectProvider,
  type JsonObject,
  ProviderError,
  type TransferJob,
} from "../creator-connect/provider.ts";
import {
  programPayoutBinding,
  programPayoutsEnabled,
} from "../program-payout-account/config.ts";
import { watchStripe } from "./observe.ts";
import {
  type ClaimedPayout,
  databasePayoutStore,
  parseBegun,
  parseClaim,
  type PayoutStore,
  StoreRejection,
} from "./store.ts";

const WORKER = "program-payout-worker";

/** No payout is started after this much of a run has passed. */
export const WORK_BUDGET_MS = 40_000;
/** Payouts handed out per claim, and claims per run. */
export const CLAIM_BATCH = 5;
export const MAX_CLAIMS = 10;
/** How long a claimed payout belongs to this run. */
export const LEASE_SECONDS = 300;
/** Wait while the platform has too little available to send a payout. */
export const BALANCE_WAIT_SECONDS = 900;
/** Wait for a payout a person has to look at. It is never failed by itself. */
export const REVIEW_WAIT_SECONDS = 86_400;
/** Wait for the payouts handed back when a run stops early. */
export const STOPPED_WAIT_SECONDS = 300;

/**
 * The wait after Stripe gave no clear answer: 5, 10, 20, 40 minutes, then an
 * hour. From the first time Stripe was asked it is at least 10 minutes, so
 * the next run's lookup sees a transfer Stripe made after all.
 */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(3600, 300 * 2 ** Math.min(Math.max(attempts, 0), 4));
}

/** Why a payout ended as failed. Nothing else is ever stored on a failed one. */
export type PayoutFailure =
  /** The creator's Stripe account is missing or cannot receive money now. */
  | "account_not_ready"
  /** The account cannot be paid in this currency. */
  | "currency_unavailable"
  /** Stripe refused the transfer and will not change its mind. */
  | "transfer_rejected"
  /** Stripe keeps repeating that the platform's balance was too small. */
  | "platform_balance_low"
  /** Too old to ask again, and Stripe has no transfer for it. */
  | "transfer_not_found";

type Level = "info" | "warning" | "error";

export interface PayoutWorkerLogEntry {
  level: Level;
  worker: typeof WORKER;
  outcome: string;
  request_id: string;
  payout_id?: string;
  code?: string;
  /** Stripe's own error code for a refusal. */
  provider_code?: string;
  counts?: Record<string, number>;
}

export interface ProgramPayoutWorkerDependencies {
  enabled: () => boolean;
  authenticate: (request: Request) => void;
  /** The console platform's live binding; null when there is none. */
  binding: () => ConnectConfig | null;
  store: () => PayoutStore;
  fetcher: typeof fetch;
  now: () => number;
  log: (entry: PayoutWorkerLogEntry) => void;
}

function defaults(): ProgramPayoutWorkerDependencies {
  return {
    enabled: programPayoutsEnabled,
    // The schedule has its own credential; a person or another function uses
    // the internal worker credential.
    authenticate: (request) => {
      const scheduled = request.headers.has("x-kma-scheduler-secret");
      const expected = Deno.env.get(
        scheduled
          ? "PROGRAM_PAYOUT_SCHEDULER_SECRET"
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
    binding: programPayoutBinding,
    store: databasePayoutStore,
    fetcher: fetch,
    now: Date.now,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

/** What is told to the database about one payout. */
type Verdict =
  | { outcome: "paid"; transferId: string; fresh: boolean }
  | { outcome: "retry"; code: string; delay: number; level: Level }
  | { outcome: "failed"; code: PayoutFailure };

const failed = (code: PayoutFailure): Verdict => ({ outcome: "failed", code });
const later = (code: string, delay: number): Verdict => ({
  outcome: "retry",
  code,
  delay,
  level: "warning",
});
/** Left open for a person. Looked at again in a day. */
const review = (code: string): Verdict => ({
  outcome: "retry",
  code,
  delay: REVIEW_WAIT_SECONDS,
  level: "error",
});

/** Stops the run: something is wrong that no single payout is to blame for. */
class RunStopped extends Error {
  constructor(
    readonly code: string,
    readonly kind: "configuration" | "unavailable",
  ) {
    super(code);
  }
}
/** Another run holds the payout now. Nothing more is written for it here. */
class LeaseLost extends Error {}

export function createProgramPayoutWorker(
  overrides: Partial<ProgramPayoutWorkerDependencies> = {},
) {
  const deps: ProgramPayoutWorkerDependencies = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    const counts = {
      claimed: 0,
      paid: 0,
      retried: 0,
      failed: 0,
      lease_lost: 0,
      errors: 0,
    };
    const note = (
      level: Level,
      outcome: string,
      payoutId?: string,
      code?: string,
      providerCode?: string | null,
    ): void =>
      deps.log({
        level,
        worker: WORKER,
        outcome,
        request_id: rid,
        ...(payoutId ? { payout_id: payoutId } : {}),
        ...(code ? { code } : {}),
        ...(providerCode ? { provider_code: providerCode } : {}),
      });
    try {
      requireMethod(request, ["POST"]);
      deps.authenticate(request);
      // Switched off: no database call, no Stripe call, no key is read.
      if (!deps.enabled()) {
        return jsonResponse(200, {
          enabled: false,
          ...counts,
          request_id: rid,
        });
      }
      const config = deps.binding();
      if (config === null) {
        note("error", "binding_missing");
        throw new ConfigurationError();
      }
      const store = deps.store();
      const watch = watchStripe(deps.fetcher);
      const deadline = deps.now() + WORK_BUDGET_MS;
      const refusedWith = (...statuses: number[]): boolean =>
        watch.refusal !== null && statuses.includes(watch.refusal.status);

      // Stripe is first asked when there is a payout to send: whose account
      // the key belongs to, what it has available, and where it may pay.
      let provider: ConnectProvider | null = null;
      const open = async (): Promise<ConnectProvider> => {
        const made = new ConnectProvider(config, watch.fetch, deps.now);
        try {
          await made.verifyPlatform();
          await made.eligibility();
        } catch (error) {
          if (error instanceof RequestError) {
            throw new RunStopped(error.code, "configuration");
          }
          if (!(error instanceof ProviderError)) throw error;
          throw error.ambiguous
            ? new RunStopped("stripe_unavailable", "unavailable")
            : new RunStopped(
              refusedWith(401, 403) ? "stripe_key_refused" : error.safeCode,
              "configuration",
            );
        }
        return made;
      };

      /**
       * Stripe gave no usable answer to a question, so nothing is known about
       * the payout that was not known before. It is never failed for that.
       */
      const unanswered = (error: unknown, attempts: number): Verdict => {
        if (error instanceof ProviderError) {
          if (error.ambiguous) {
            return later("stripe_unavailable", retryDelaySeconds(attempts));
          }
          // The key itself was refused: no payout is to blame.
          if (refusedWith(401, 403)) {
            throw new RunStopped("stripe_key_refused", "configuration");
          }
          return review(error.safeCode);
        }
        if (error instanceof RequestError) return review(error.code);
        throw error;
      };

      const decide = async (
        stripe: ConnectProvider,
        payout: ClaimedPayout,
      ): Promise<Verdict> => {
        const asked = payout.firstAttemptAt !== null;
        if (payout.connectAccountId === null || payout.accountKey === null) {
          // No payout account. If Stripe was asked before, there was one.
          return asked
            ? review("destination_missing")
            : failed("account_not_ready");
        }
        const destination = payout.connectAccountId;
        const job: TransferJob = {
          id: payout.payoutId,
          lease_token: payout.lease,
          kind: "transfer",
          amount_minor: payout.amountMinor,
          currency: payout.currency,
          destination,
          platform_account_id: payout.platformAccountId,
          livemode: true,
          idempotency_key: `program-payout:${payout.payoutId}`,
          first_attempt_at: payout.firstAttemptAt,
          transfer_id: null,
          transfer_group: `program-payout:${payout.payoutId}`,
        };
        try {
          stripe.validateJob(job);
        } catch (error) {
          return unanswered(error, payout.attempts);
        }

        // 1. Stripe was asked before: it may have the transfer. Look first,
        // so that nothing below can fail a payout that was in fact sent.
        if (asked) {
          try {
            const found = await stripe.execute(job, false);
            return {
              outcome: "paid",
              transferId: found.provider_id,
              fresh: false,
            };
          } catch (error) {
            if (
              !(error instanceof RequestError &&
                error.code === "provider_receipt_pending")
            ) return unanswered(error, payout.attempts);
          }
          // Stripe has no transfer for it, and it is too old to ask again.
          if (payout.lookupOnly) return failed("transfer_not_found");
        }

        // 2. The creator's account, as Stripe has it now.
        let account: JsonObject;
        try {
          account = await stripe.account(destination);
        } catch (error) {
          // Stripe says the platform has no such account (any more). A 403
          // with another code is about the key, not about this creator.
          if (
            error instanceof ProviderError && !error.ambiguous &&
            (refusedWith(404) ||
              (refusedWith(403) && watch.refusal?.code === "account_invalid"))
          ) return failed("account_not_ready");
          return unanswered(error, payout.attempts);
        }
        let snapshot: AccountSnapshot;
        try {
          snapshot = stripe.snapshot(
            account,
            destination,
            payout.affiliateId,
            payout.accountKey,
          );
        } catch (error) {
          if (!(error instanceof RequestError)) throw error;
          // The Stripe account is not this creator's. Nothing is stored.
          note("error", "account_mismatch", payout.payoutId, error.code);
          return failed("account_not_ready");
        }
        const stored = await store.call("set_creator_connect_account", {
          affiliate_id: payout.affiliateId,
          platform_account_id: payout.platformAccountId,
          livemode: true,
          account_key: payout.accountKey,
          connect_account_id: snapshot.account_id,
          charges_enabled: snapshot.charges_enabled,
          payouts_enabled: snapshot.payouts_enabled,
          transfers_enabled: snapshot.transfers_active,
          details_submitted: snapshot.details_submitted,
          disabled_reason: snapshot.disabled_reason,
          requirements_due: snapshot.requirements_due,
          verified_at: new Date(deps.now()).toISOString(),
        });
        if (typeof stored.status !== "string") {
          throw new DatabaseBoundaryError();
        }
        // "ready" is the database's word, the one the admin page shows.
        if (stored.status !== "ready" || !snapshot.transfers_active) {
          return failed("account_not_ready");
        }

        // 3. The platform's own money. Asking Stripe for more than it has
        // available would be refused, and Stripe may repeat that refusal for
        // a day to every later try for this payout. So it is not asked.
        if ((watch.funds?.get(payout.currency) ?? 0) < payout.amountMinor) {
          return later("platform_balance_low", BALANCE_WAIT_SECONDS);
        }

        // 4. The account must take this currency: the platform has it (just
        // checked), so a refusal here is about the creator's account.
        try {
          await stripe.assertTransferCurrency(job, account);
        } catch (error) {
          if (
            error instanceof RequestError &&
            ["transfer_currency_unavailable", "transfer_currency_precision"]
              .includes(error.code)
          ) return failed("currency_unavailable");
          return unanswered(error, payout.attempts);
        }

        // 5. Ask Stripe. The provider looks once more, then has the database
        // note that Stripe is about to be asked, then sends one POST.
        let begun = false;
        try {
          const sent = await stripe.execute(job, true, async () => {
            const answer = await store.call("begin_program_payout", {
              payout_id: payout.payoutId,
              lease_token: payout.lease,
              connect_account_id: destination,
            });
            begun = true;
            const current = parseBegun(answer, payout.payoutId);
            // The provider refuses to send if any of this is not what it was
            // given a moment ago.
            return {
              ...job,
              amount_minor: current.amountMinor,
              currency: current.currency,
              destination: current.connectAccountId,
              platform_account_id: current.platformAccountId,
              first_attempt_at: current.firstAttemptAt,
            };
          });
          return {
            outcome: "paid",
            transferId: sent.provider_id,
            fresh: !sent.reconciled,
          };
        } catch (error) {
          const attempts = payout.attempts + (begun ? 1 : 0);
          if (error instanceof StoreRejection) {
            if (error.reason === "lease_lost") throw new LeaseLost();
            if (error.reason === "destination_changed") {
              return review("destination_changed");
            }
            throw error;
          }
          if (
            error instanceof RequestError && asked && !begun &&
            error.code === "manual_reconciliation_required"
          ) {
            // By this clock it is too old to ask again, and the lookup just
            // made found nothing.
            return failed("transfer_not_found");
          }
          if (!(error instanceof ProviderError) || error.ambiguous) {
            return unanswered(error, attempts);
          }
          const refusal = watch.refusal;
          // The key was refused, or it was the lookup that Stripe refused:
          // neither says anything about the transfer.
          if (
            refusedWith(401, 403) || !begun || refusal?.method !== "POST"
          ) return unanswered(error, attempts);
          // Stripe refused to make the transfer, so there is none.
          if (error.safeCode === "provider_balance_or_account_unavailable") {
            // Too little available after all. If Stripe only repeated its
            // first answer, it will keep doing so: give the money back, so an
            // admin can pay again as a new payout.
            return refusal.replayed
              ? failed("platform_balance_low")
              : later("platform_balance_low", BALANCE_WAIT_SECONDS);
          }
          note("warning", "refused", payout.payoutId, undefined, refusal.code);
          return failed("transfer_rejected");
        }
      };

      const finish = async (
        payout: ClaimedPayout,
        verdict: Verdict,
      ): Promise<void> => {
        try {
          await store.call("finish_program_payout", {
            payout_id: payout.payoutId,
            lease_token: payout.lease,
            outcome: verdict.outcome,
            ...(verdict.outcome === "paid"
              ? { transfer_id: verdict.transferId }
              : { failure_code: verdict.code }),
            ...(verdict.outcome === "retry"
              ? { delay_seconds: verdict.delay }
              : {}),
          });
        } catch (error) {
          if (
            error instanceof StoreRejection && error.reason === "lease_lost"
          ) {
            throw new LeaseLost();
          }
          throw error;
        }
      };

      for (
        let claims = 0;
        claims < MAX_CLAIMS && deps.now() < deadline;
        claims++
      ) {
        const batch = parseClaim(
          await store.call("claim_program_payouts", {
            platform_account_id: config.platformAccountId,
            limit: CLAIM_BATCH,
            lease_seconds: LEASE_SECONDS,
          }),
        );
        if (batch.length === 0) break;
        counts.claimed += batch.length;
        for (const [index, payout] of batch.entries()) {
          // Out of time: the lease runs out and a later run takes it.
          if (deps.now() >= deadline) break;
          try {
            provider ??= await open();
            const verdict = await decide(provider, payout);
            await finish(payout, verdict);
            if (verdict.outcome === "paid") {
              counts.paid += 1;
              note("info", "paid", payout.payoutId);
              if (verdict.fresh && watch.funds) {
                watch.funds.set(
                  payout.currency,
                  (watch.funds.get(payout.currency) ?? 0) - payout.amountMinor,
                );
              }
            } else if (verdict.outcome === "retry") {
              counts.retried += 1;
              note(verdict.level, "retry", payout.payoutId, verdict.code);
            } else {
              counts.failed += 1;
              note("warning", "failed", payout.payoutId, verdict.code);
            }
          } catch (error) {
            if (error instanceof RunStopped) {
              // Hand back this payout and the rest of the batch, untouched.
              for (const rest of batch.slice(index)) {
                try {
                  await finish(
                    rest,
                    later(error.code, STOPPED_WAIT_SECONDS),
                  );
                } catch { /* Its lease runs out instead. */ }
              }
              throw error;
            }
            if (error instanceof LeaseLost) {
              counts.lease_lost += 1;
              note("warning", "lease_lost", payout.payoutId);
              continue;
            }
            // About this payout only. Nothing more is written for it: its
            // lease runs out and a later run starts by looking at Stripe.
            counts.errors += 1;
            note(
              "error",
              "error",
              payout.payoutId,
              error instanceof StoreRejection
                ? error.reason
                : error instanceof DatabaseBoundaryError
                ? "database_unavailable"
                : "worker_error",
            );
          }
        }
      }

      deps.log({
        level: counts.errors > 0 ? "warning" : "info",
        worker: WORKER,
        outcome: "processed",
        request_id: rid,
        counts,
      });
      return jsonResponse(200, {
        status: "processed",
        worker: WORKER,
        enabled: true,
        ...counts,
        request_id: rid,
      });
    } catch (caught) {
      const error = caught instanceof RunStopped
        ? caught.kind === "configuration"
          ? new ConfigurationError()
          : new RequestError(
            502,
            "stripe_unavailable",
            "Stripe could not be reached.",
          )
        : caught instanceof StoreRejection
        ? new DatabaseBoundaryError(caught.sqlstate)
        : caught;
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
        ...(caught instanceof RunStopped ? { code: caught.code } : {}),
        counts,
      });
      return response;
    }
  };
}

export const handleProgramPayoutWorker = createProgramPayoutWorker();
if (import.meta.main) Deno.serve(handleProgramPayoutWorker);
