// Balance worker, called once a minute by the schedule. Each run:
//   1. lets the commission piece approve what is due (program_commissions_tick);
//   2. tops up the balances that fell below the minimum their merchant chose:
//      the database hands out one new top-up per due account, and the saved
//      card is charged once for it, off-session, on the KissMyApps platform's
//      live Stripe account;
//   3. checks open top-ups against Stripe: a deposit whose event never came, a
//      Checkout page that expired, a charge whose worker stopped half way.
//
// A top-up is charged with one POST whose Idempotency-Key is the top-up, and
// that POST is never sent again by anyone: a charge whose answer was lost is
// looked up at Stripe instead. Money is added to a balance only after the
// PaymentIntent was read back and is exactly what the top-up asked for.
// Off unless PROGRAM_BALANCE_ENABLED is exactly "true". Logs carry outcome
// codes and top-up ids only.
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
  type ProgramBalanceConfig,
  programBalanceConfig,
  programBalanceEnabled,
} from "../program-balance/config.ts";
import {
  closeTopup,
  reconcileIntent,
  type SettleContext,
  type Settled,
} from "../program-balance/settle.ts";
import {
  type BalanceStore,
  databaseBalanceStore,
  parseClaim,
  StoreRejection,
  type Topup,
} from "../program-balance/store.ts";
import {
  BalanceStripe,
  StripeCallError,
  type TopupToPay,
} from "../program-balance/stripe.ts";

const WORKER = "program-balance-worker";

/** Nothing new is started after this much of a run has passed. */
export const WORK_BUDGET_MS = 40_000;
/** Accounts charged in one run; each at most once. */
export const CHARGE_BATCH = 5;
/** How long a claimed top-up belongs to this run. */
export const CHARGE_LEASE_SECONDS = 300;
/**
 * A claimed top-up is charged only this soon after the claim. A check of it
 * starts only after the lease has run out: by then a charge request of this
 * run has long ended, so "Stripe has no payment for it" can be believed.
 */
export const CHARGE_WINDOW_MS = 60_000;
export const CHECK_BATCH = 10;
export const CHECK_LEASE_SECONDS = 120;
/** How long until an open top-up is looked at again. */
export const RECHECK_SECONDS = 300;
/** A deposit that never got its Checkout page is closed after this long. */
export const UNSTARTED_DEPOSIT_SECONDS = 600;
export const TICK_LIMIT = 500;
export const MAX_TICKS = 3;

export interface BalanceWorkerLogEntry {
  level: "info" | "warning" | "error";
  worker: typeof WORKER;
  outcome: string;
  request_id: string;
  topup_id?: string;
  counts?: Record<string, number>;
}

export interface ProgramBalanceWorkerDependencies {
  enabled: () => boolean;
  authenticate: (request: Request) => void;
  config: () => ProgramBalanceConfig;
  store: () => BalanceStore;
  fetcher: typeof fetch;
  now: () => number;
  log: (entry: BalanceWorkerLogEntry) => void;
}

function defaults(): ProgramBalanceWorkerDependencies {
  return {
    enabled: programBalanceEnabled,
    // The schedule has its own credential; a person or another function uses
    // the internal worker credential.
    authenticate: (request) => {
      const scheduled = request.headers.has("x-kma-scheduler-secret");
      const expected = Deno.env.get(
        scheduled
          ? "PROGRAM_BALANCE_SCHEDULER_SECRET"
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
    config: programBalanceConfig,
    store: databaseBalanceStore,
    fetcher: fetch,
    now: Date.now,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

/** Stops the run: the platform's Stripe key was refused. */
class RunStopped extends Error {}

function whole(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function toPay(topup: Topup): TopupToPay | null {
  return topup.customerId === null ? null : {
    topupId: topup.topupId,
    accountId: topup.accountId,
    programId: topup.programId,
    workspaceId: topup.workspaceId,
    customerId: topup.customerId,
    amountMinor: topup.amountMinor,
    currency: topup.currency,
  };
}

export function createProgramBalanceWorker(
  overrides: Partial<ProgramBalanceWorkerDependencies> = {},
) {
  const deps: ProgramBalanceWorkerDependencies = {
    ...defaults(),
    ...overrides,
  };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    const counts = {
      commissions_approved: 0,
      commissions_retried: 0,
      commissions_remaining: 0,
      claimed: 0,
      credited: 0,
      failed: 0,
      canceled: 0,
      pending: 0,
      mismatched: 0,
      checked: 0,
      errors: 0,
    };
    try {
      requireMethod(request, ["POST"]);
      deps.authenticate(request);
      if (!deps.enabled()) {
        return jsonResponse(200, {
          enabled: false,
          ...counts,
          request_id: rid,
        });
      }
      const config = deps.config();
      const store = deps.store();
      const stripe = new BalanceStripe(config.secret, {
        fetcher: deps.fetcher,
      });
      const deadline = deps.now() + WORK_BUDGET_MS;
      const note = (
        level: BalanceWorkerLogEntry["level"],
        outcome: string,
        topupId?: string,
      ): void =>
        deps.log({
          level,
          worker: WORKER,
          outcome,
          request_id: rid,
          ...(topupId ? { topup_id: topupId } : {}),
        });
      const ctx: SettleContext = {
        store,
        stripe,
        platformAccountId: config.platformAccountId,
        note,
      };
      const tally = (outcome: Settled): void => {
        if (outcome === "credited") counts.credited += 1;
        else if (outcome === "failed") counts.failed += 1;
        else if (outcome === "canceled") counts.canceled += 1;
        else if (outcome === "mismatch") counts.mismatched += 1;
        else if (outcome === "pending") counts.pending += 1;
      };
      /** Hands a top-up that is still open back, to be checked again later. */
      const release = async (topup: Topup, seconds: number): Promise<void> => {
        if (topup.leaseToken === null) return;
        await store.call("release_program_topup", {
          topup_id: topup.topupId,
          lease_token: topup.leaseToken,
          delay_seconds: seconds,
        });
      };
      /** A failure that is about one top-up, not about the whole run. */
      const contained = (error: unknown, topup: Topup): void => {
        if (error instanceof RunStopped) throw error;
        if (
          error instanceof StripeCallError && error.kind === "configuration"
        ) {
          throw new RunStopped();
        }
        counts.errors += 1;
        note(
          error instanceof StripeCallError && error.kind === "unavailable"
            ? "warning"
            : "error",
          error instanceof StripeCallError
            ? error.code
            : error instanceof StoreRejection
            ? error.reason
            : error instanceof DatabaseBoundaryError
            ? "database_unavailable"
            : "worker_error",
          topup.topupId,
        );
      };

      // 1. Commissions whose hold has passed. This belongs to the commission
      // piece; whatever it does, top-ups go on.
      try {
        for (let round = 0; round < MAX_TICKS; round++) {
          const ticked = await store.call("program_commissions_tick", {
            limit: TICK_LIMIT,
          });
          counts.commissions_approved += whole(ticked.approved);
          counts.commissions_retried += whole(ticked.retried);
          counts.commissions_remaining = whole(ticked.remaining);
          if (counts.commissions_remaining === 0 || deps.now() >= deadline) {
            break;
          }
        }
      } catch {
        counts.errors += 1;
        note("error", "commissions_tick_failed");
      }

      // 2. Automatic top-ups. One claim per run: an account is handed out at
      // most once, with one new top-up, and is charged at most once for it.
      const charge = async (topup: Topup): Promise<void> => {
        const pay = toPay(topup);
        if (pay === null || topup.paymentMethodId === null) {
          await closeTopup(ctx, topup, "canceled", "never_charged");
          counts.canceled += 1;
          return;
        }
        let intentId: string | null;
        try {
          intentId = await stripe.chargeSavedCard(pay, topup.paymentMethodId);
        } catch (error) {
          if (!(error instanceof StripeCallError)) throw error;
          if (error.kind === "configuration") {
            // The key was refused: Stripe made nothing.
            await closeTopup(ctx, topup, "canceled", "never_charged");
            counts.canceled += 1;
            throw new RunStopped();
          }
          if (error.kind === "unavailable") {
            // Stripe may or may not have charged. The top-up stays open and
            // is looked up at Stripe once its lease has run out. No second
            // charge request is ever sent for it.
            counts.pending += 1;
            note("warning", "charge_outcome_unknown", topup.topupId);
            return;
          }
          if (error.kind === "rejected") {
            // Stripe refused the request and made nothing.
            await closeTopup(ctx, topup, "failed", error.code);
            counts.failed += 1;
            note("warning", error.code, topup.topupId);
            return;
          }
          // The card was tried and failed.
          if (error.paymentIntentId === null) {
            await closeTopup(ctx, topup, "failed", error.code);
            counts.failed += 1;
            return;
          }
          intentId = error.paymentIntentId;
        }
        await store.call("attach_program_topup", {
          topup_id: topup.topupId,
          payment_intent_id: intentId,
        });
        // Read back from Stripe before anything is settled.
        const settled = await reconcileIntent(ctx, intentId);
        tally(settled.outcome);
        if (settled.outcome === "pending") await release(topup, 60);
      };

      if (deps.now() < deadline) {
        const claimedAt = deps.now();
        const due = parseClaim(
          await store.call("claim_program_auto_topups", {
            platform_account_id: config.platformAccountId,
            limit: CHARGE_BATCH,
            lease_seconds: CHARGE_LEASE_SECONDS,
          }),
        );
        counts.claimed = due.length;
        for (const topup of due) {
          try {
            if (
              deps.now() >= deadline ||
              deps.now() - claimedAt > CHARGE_WINDOW_MS
            ) {
              // Too late to charge safely in this run. Nothing was sent to
              // Stripe for it, so it is closed and the next run starts afresh.
              await closeTopup(ctx, topup, "canceled", "never_charged");
              counts.canceled += 1;
              continue;
            }
            await charge(topup);
          } catch (error) {
            contained(error, topup);
          }
        }
      }

      // 3. Open top-ups nobody is working on.
      const check = async (topup: Topup): Promise<void> => {
        const age = Math.floor(deps.now() / 1000) - topup.createdAt;
        let intentId = topup.paymentIntentId;
        if (intentId === null && topup.kind === "deposit") {
          if (topup.checkoutSessionId === null) {
            // The Checkout page was never made, or its address never reached
            // the merchant: nobody can pay this.
            if (age < UNSTARTED_DEPOSIT_SECONDS) {
              return await release(topup, RECHECK_SECONDS);
            }
            await closeTopup(ctx, topup, "canceled", "never_started");
            counts.canceled += 1;
            return;
          }
          const session = await stripe.session(topup.checkoutSessionId);
          intentId = session.paymentIntentId;
          if (intentId === null) {
            if (session.status === "expired") {
              await closeTopup(ctx, topup, "canceled", "checkout_expired");
              counts.canceled += 1;
              return;
            }
            counts.pending += 1;
            return await release(topup, RECHECK_SECONDS);
          }
          if (session.status === "expired") {
            // An expired page with a payment: the payment decides, and if it
            // did not succeed the deposit is over.
            const settled = await reconcileIntent(ctx, intentId);
            if (settled.outcome !== "pending") return tally(settled.outcome);
            await closeTopup(ctx, topup, "canceled", "checkout_expired");
            counts.canceled += 1;
            return;
          }
        }
        if (intentId === null) {
          // An automatic top-up without a PaymentIntent: its worker stopped
          // around the charge. Ask Stripe whether the charge exists.
          if (age < CHARGE_LEASE_SECONDS - 60 || topup.customerId === null) {
            return await release(topup, CHECK_LEASE_SECONDS);
          }
          intentId = await stripe.findCharge(
            topup.customerId,
            topup.topupId,
            topup.createdAt - 300,
          );
          if (intentId === null) {
            // Stripe has no payment for it: it was never charged. Closed
            // without counting a failure; the next run starts afresh.
            await closeTopup(ctx, topup, "canceled", "never_charged");
            counts.canceled += 1;
            return;
          }
        }
        const settled = await reconcileIntent(ctx, intentId);
        tally(settled.outcome);
        if (settled.outcome === "pending") {
          await release(topup, RECHECK_SECONDS);
        } else if (settled.outcome === "mismatch") {
          // Left open for a person; looked at again in a day at the latest.
          await release(topup, 86_400);
        }
      };

      if (deps.now() < deadline) {
        const open = parseClaim(
          await store.call("claim_program_topup_checks", {
            platform_account_id: config.platformAccountId,
            limit: CHECK_BATCH,
            lease_seconds: CHECK_LEASE_SECONDS,
          }),
        );
        for (const topup of open) {
          // Out of time: the lease runs out and a later run takes it.
          if (deps.now() >= deadline) break;
          counts.checked += 1;
          try {
            await check(topup);
          } catch (error) {
            contained(error, topup);
          }
        }
      }

      deps.log({
        level: counts.errors > 0 || counts.mismatched > 0 ? "warning" : "info",
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
      const error = caught instanceof RunStopped ||
          (caught instanceof StripeCallError && caught.kind === "configuration")
        ? new ConfigurationError()
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
        counts,
      });
      return response;
    }
  };
}

export const handleProgramBalanceWorker = createProgramBalanceWorker();
if (import.meta.main) Deno.serve(handleProgramBalanceWorker);
