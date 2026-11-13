// Promo code worker, called once a minute by the schedule (or by hand with the
// internal worker credential). Each run claims the creator promo codes the
// database has waiting and, on each merchant's own Stripe account (platform
// key and Stripe-Account header):
//   * makes a pending code: a percent-off coupon (one per program and
//     discount, reused once made) and a promotion code with the code's text;
//   * switches a retired code off (`active=false`).
// Every outcome goes back to the database, which counts attempts and gives a
// code up after its last one. A code Stripe already has on the account ends
// with the error "code_taken". Off unless PROGRAM_PROMO_CODES_ENABLED is
// exactly "true". Logs carry outcome codes and counts only.
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
import { requireLiveStripeKey } from "../_shared/stripe-auth.ts";
import {
  ConnectedStripe,
  ConnectedStripeError,
} from "../program-checkout/stripe.ts";
import {
  type CodeToMake,
  type CodeToRetire,
  databasePromoStore,
  type PromoFinish,
  type PromoStore,
} from "./store.ts";

const WORKER = "program-promo-worker";

/** Nothing new is started after this much of a run has passed. */
export const WORK_BUDGET_MS = 40_000;
export const BATCH_SIZE = 10;
export const MAX_BATCHES = 5;

export interface PromoWorkerLogEntry {
  level: "info" | "warning" | "error";
  worker: typeof WORKER;
  outcome: string;
  request_id: string;
  counts?: Record<string, number>;
}

export interface PromoWorkerDependencies {
  enabled: () => boolean;
  authenticate: (request: Request) => void;
  /** The platform's live Stripe key. Read only while the worker is on. */
  stripeKey: () => string;
  store: () => PromoStore;
  fetcher: typeof fetch;
  now: () => number;
  log: (entry: PromoWorkerLogEntry) => void;
}

function defaults(): PromoWorkerDependencies {
  return {
    enabled: () => Deno.env.get("PROGRAM_PROMO_CODES_ENABLED") === "true",
    // The schedule has its own credential; a person or another function uses
    // the internal worker credential.
    authenticate: (request) => {
      const scheduled = request.headers.has("x-kma-scheduler-secret");
      const expected = Deno.env.get(
        scheduled ? "PROGRAM_PROMO_SCHEDULER_SECRET" : "INTERNAL_WORKER_SECRET",
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
    stripeKey: () =>
      requireLiveStripeKey(
        (Deno.env.get("CONSOLE_CONNECT_STRIPE_SECRET") ?? "").trim(),
      ),
    store: databasePromoStore,
    fetcher: fetch,
    now: Date.now,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

/** Stops the run: the platform's Stripe key was refused. */
class RunStopped extends Error {}

/** The error a code ends with when Stripe refused or could not be reached. */
export function errorCode(error: unknown): string {
  if (error instanceof ConnectedStripeError) {
    return error.kind === "rejected" && error.exists
      ? "code_taken"
      : error.code;
  }
  if (error instanceof ConfigurationError) return "worker_misconfigured";
  return "worker_error";
}

export function createProgramPromoWorker(
  overrides: Partial<PromoWorkerDependencies> = {},
) {
  const deps: PromoWorkerDependencies = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    const counts = {
      claimed: 0,
      made: 0,
      deactivated: 0,
      errors: 0,
      gave_up: 0,
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
      const stripe = new ConnectedStripe(deps.stripeKey(), deps.fetcher);
      const store = deps.store();
      const deadline = deps.now() + WORK_BUDGET_MS;
      // The coupon of each account, program and discount, once known.
      const coupons = new Map<string, string>();
      // The coupon each code got before its promotion code failed, if any.
      const couponsMade = new Map<string, string>();
      // A code is worked on once per run, even if a claim hands it out again.
      const seen = new Set<string>();

      const finish = async (outcome: PromoFinish): Promise<void> => {
        const answer = await store.finish(outcome);
        if (outcome.kind === "error") {
          counts.errors += 1;
          if (answer.gaveUp) counts.gave_up += 1;
          deps.log({
            level: "warning",
            worker: WORKER,
            outcome: answer.gaveUp ? "gave_up" : outcome.error,
            request_id: rid,
          });
        } else if (outcome.kind === "made") counts.made += 1;
        else counts.deactivated += 1;
      };

      const coupon = async (
        code: CodeToMake,
        fresh: boolean,
      ): Promise<string> => {
        const cacheKey =
          `${code.accountId}|${code.programId}|${code.discountBps}`;
        if (!fresh) {
          const known = coupons.get(cacheKey) ?? code.couponId;
          if (known) return known;
        }
        // One coupon per program and discount: the same Idempotency-Key gives
        // the same coupon for a day, and after that the database hands out
        // the first finished code's coupon. A replacement for a coupon the
        // merchant deleted is keyed on the code instead.
        const made = await stripe.createCoupon(
          code.accountId,
          { discountBps: code.discountBps, programId: code.programId },
          fresh
            ? `kma-promo-coupon-${code.programId}-${code.discountBps}-${code.id}`
            : `kma-promo-coupon-${code.programId}-${code.discountBps}`,
        );
        coupons.set(cacheKey, made);
        return made;
      };

      const make = async (code: CodeToMake): Promise<PromoFinish> => {
        const promotion = (couponId: string) =>
          stripe.createPromotionCode(
            code.accountId,
            {
              couponId,
              code: code.code,
              codeId: code.id,
              programId: code.programId,
            },
            `kma-promo-code-${code.id}-${code.code}`,
          );
        let couponId = await coupon(code, false);
        couponsMade.set(code.id, couponId);
        let promotionCodeId: string;
        try {
          promotionCodeId = await promotion(couponId);
        } catch (error) {
          // The coupon is gone (deleted in the merchant's dashboard): make a
          // new one once and try again.
          if (
            !(error instanceof ConnectedStripeError) ||
            error.kind !== "rejected" || error.code !== "resource_missing"
          ) throw error;
          couponId = await coupon(code, true);
          couponsMade.set(code.id, couponId);
          promotionCodeId = await promotion(couponId);
        }
        return { id: code.id, kind: "made", couponId, promotionCodeId };
      };

      const retire = async (code: CodeToRetire): Promise<PromoFinish> => {
        if (code.promotionCodeId === null) {
          return { id: code.id, kind: "deactivated" };
        }
        try {
          await stripe.deactivatePromotionCode(
            code.accountId,
            code.promotionCodeId,
            `kma-promo-retire-${code.id}`,
          );
        } catch (error) {
          // Nothing left to switch off.
          if (
            !(error instanceof ConnectedStripeError) ||
            error.kind !== "rejected" || error.code !== "resource_missing"
          ) throw error;
        }
        return { id: code.id, kind: "deactivated" };
      };

      const attempt = async (
        id: string,
        work: () => Promise<PromoFinish>,
      ): Promise<void> => {
        let outcome: PromoFinish;
        try {
          outcome = await work();
        } catch (error) {
          if (
            error instanceof ConnectedStripeError &&
            error.kind === "configuration"
          ) {
            // No code can be made with a refused key. The claimed codes are
            // left to the database's next claim, attempts untouched.
            throw new RunStopped();
          }
          const couponId = couponsMade.get(id);
          outcome = couponId
            ? { id, kind: "error", error: errorCode(error), couponId }
            : { id, kind: "error", error: errorCode(error) };
        }
        await finish(outcome);
      };

      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        if (deps.now() >= deadline) break;
        const claim = await store.claim(BATCH_SIZE);
        const retiring = claim.deactivate.filter((code) => !seen.has(code.id));
        const making = claim.codes.filter((code) => !seen.has(code.id));
        counts.claimed += retiring.length + making.length;
        for (const code of [...retiring, ...making]) seen.add(code.id);
        for (const code of retiring) {
          if (deps.now() >= deadline) break;
          await attempt(code.id, () => retire(code));
        }
        for (const code of making) {
          if (deps.now() >= deadline) break;
          await attempt(code.id, () => make(code));
        }
        if (
          (claim.codes.length < BATCH_SIZE &&
            claim.deactivate.length < BATCH_SIZE) ||
          retiring.length + making.length === 0
        ) break;
      }

      deps.log({
        level: "info",
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
        ? new ConfigurationError()
        : caught;
      const response = errorResponse(error, rid);
      deps.log({
        level: response.status >= 500 ? "error" : "warning",
        worker: WORKER,
        outcome: caught instanceof RunStopped
          ? "stripe_key_rejected"
          : error instanceof RequestError ||
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

export const handleProgramPromoWorker = createProgramPromoWorker();
if (import.meta.main) Deno.serve(handleProgramPromoWorker);
