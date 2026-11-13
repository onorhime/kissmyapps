// Sale tracking worker: turns the payment receipts stored by
// connect-payments-webhook into verified sales. It claims receipts, reads each
// payment back from the merchant's live Stripe account (GET only) and hands
// what Stripe says to the database, which keeps one sale per PaymentIntent and
// ties it to a creator click. Called by the webhook's nudge and by the
// once-a-minute schedule. Off unless PROGRAM_SALES_ENABLED is exactly "true".
// Logs carry outcome codes and event ids only: no names, emails or payloads.
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
import { serviceClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";
import { StripeReader, StripeReadError } from "./stripe.ts";

const WORKER = "program-sales-worker";

/** New receipts are not started after this much of a run has passed. */
export const WORK_BUDGET_MS = 40_000;
export const BATCH_SIZE = 5;
export const MAX_BATCHES = 6;
/** Long enough for a whole batch even when every Stripe read times out. */
export const LEASE_SECONDS = 180;
/** A sale without its Stripe fee is looked at again this many times. */
export const FEE_ATTEMPTS = 4;
/** The wait before looking again for a fee, or for a refund's payment. */
export const SHORT_RETRY_SECONDS = 45;

type Json = Record<string, unknown>;

const PAYMENT_EVENTS: readonly string[] = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "payment_intent.succeeded",
  "invoice.paid",
];
const ADJUSTMENT_EVENTS: readonly string[] = [
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "charge.dispute.created",
  "charge.dispute.closed",
];

export interface ClaimedReceipt {
  event_id: string;
  event_type: string;
  account_id: string;
  object_id: string;
  payment_intent_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  event_created: number;
  attempts: number;
  lease_token: string;
}

export interface ClaimResult {
  receipts: ClaimedReceipt[];
  /** Receipts the database closed itself, without a Stripe read. */
  skipped: number;
  failed: number;
}

/** The four database functions, each taking and returning one JSON object. */
export interface ProgramSalesStore {
  claim(input: Json): Promise<ClaimResult>;
  recordSale(input: Json): Promise<Json>;
  recordSaleEvent(input: Json): Promise<Json>;
  finish(input: Json): Promise<Json>;
}

export interface ProgramSalesConfig {
  secret: string;
  platformAccountId: string;
}

export interface ProgramSalesLogEntry {
  level: "info" | "warning" | "error";
  worker: typeof WORKER;
  outcome: string;
  request_id: string;
  event_id?: string;
  event_type?: string;
  counts?: Record<string, number>;
}

export interface ProgramSalesWorkerDependencies {
  enabled: () => boolean;
  authenticate: (request: Request) => void;
  config: () => ProgramSalesConfig;
  store: () => ProgramSalesStore;
  fetcher: typeof fetch;
  now: () => number;
  log: (entry: ProgramSalesLogEntry) => void;
}

/**
 * The platform's live Stripe key and account, shared with the console's
 * connect flow. Read only while the worker is on. Anything but a live secret
 * key is a configuration error.
 */
export function programSalesConfig(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): ProgramSalesConfig {
  const secret = (env("CONSOLE_CONNECT_STRIPE_SECRET") ?? "").trim();
  const platformAccountId = (env("CONSOLE_CONNECT_PLATFORM_ACCOUNT") ?? "")
    .trim();
  if (
    !/^sk_live_[A-Za-z0-9]+$/.test(secret) ||
    !/^acct_[A-Za-z0-9]{3,128}$/.test(platformAccountId)
  ) throw new ConfigurationError();
  return { secret, platformAccountId };
}

const EVENT_ID = /^evt_[A-Za-z0-9_]{3,251}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{3,128}$/;
const OBJECT_ID = /^[A-Za-z0-9_]{3,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function count(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) throw new DatabaseBoundaryError();
  return value;
}

function parseClaim(value: unknown): ClaimResult {
  if (!isPlainObject(value) || !Array.isArray(value.receipts)) {
    throw new DatabaseBoundaryError();
  }
  const receipts = value.receipts.map((row: unknown): ClaimedReceipt => {
    if (
      !isPlainObject(row) ||
      typeof row.event_id !== "string" || !EVENT_ID.test(row.event_id) ||
      typeof row.event_type !== "string" ||
      !(PAYMENT_EVENTS.includes(row.event_type) ||
        ADJUSTMENT_EVENTS.includes(row.event_type)) ||
      typeof row.account_id !== "string" || !ACCOUNT_ID.test(row.account_id) ||
      typeof row.object_id !== "string" || !OBJECT_ID.test(row.object_id) ||
      (row.payment_intent_id !== null &&
        typeof row.payment_intent_id !== "string") ||
      (row.amount_minor !== null && typeof row.amount_minor !== "number") ||
      (row.currency !== null && typeof row.currency !== "string") ||
      typeof row.lease_token !== "string" || !UUID.test(row.lease_token)
    ) throw new DatabaseBoundaryError();
    return {
      event_id: row.event_id,
      event_type: row.event_type,
      account_id: row.account_id,
      object_id: row.object_id,
      payment_intent_id: row.payment_intent_id,
      amount_minor: row.amount_minor === null ? null : count(row.amount_minor),
      currency: row.currency,
      event_created: count(row.event_created),
      attempts: count(row.attempts),
      lease_token: row.lease_token,
    };
  });
  return {
    receipts,
    skipped: count(value.skipped),
    failed: count(value.failed),
  };
}

function databaseStore(): ProgramSalesStore {
  const client = serviceClient(10_000);
  const call = async (name: string, input: Json): Promise<Json> => {
    const { data, error } = await client.rpc(name, { p_input: input });
    if (error) throw new DatabaseBoundaryError(error.code);
    if (!isPlainObject(data)) throw new DatabaseBoundaryError();
    return data;
  };
  return {
    claim: async (input) =>
      parseClaim(await call("claim_program_sale_receipts", input)),
    recordSale: (input) => call("record_program_sale", input),
    recordSaleEvent: (input) => call("record_program_sale_event", input),
    finish: (input) => call("finish_program_sale_receipt", input),
  };
}

function defaults(): ProgramSalesWorkerDependencies {
  return {
    enabled: () => Deno.env.get("PROGRAM_SALES_ENABLED") === "true",
    // The schedule and the webhook's nudge each have their own credential.
    authenticate: (request) => {
      const scheduled = request.headers.has("x-kma-scheduler-secret");
      const expected = Deno.env.get(
        scheduled ? "PROGRAM_SALES_SCHEDULER_SECRET" : "INTERNAL_WORKER_SECRET",
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
    config: () => programSalesConfig(),
    store: databaseStore,
    fetcher: fetch,
    now: Date.now,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

type Finished = "recorded" | "skipped" | "retried" | "failed" | "released";

/** Stops the run: the reason is not about the receipt in hand. */
class RunStopped extends Error {}

export function createProgramSalesWorker(
  overrides: Partial<ProgramSalesWorkerDependencies> = {},
) {
  const deps: ProgramSalesWorkerDependencies = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    const counts = {
      claimed: 0,
      recorded: 0,
      skipped: 0,
      retried: 0,
      failed: 0,
      released: 0,
      closed_unread: 0,
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
      const reader = new StripeReader(config.secret, deps.fetcher);
      const deadline = deps.now() + WORK_BUDGET_MS;

      const reference = (receipt: ClaimedReceipt): Json => ({
        platform_account_id: config.platformAccountId,
        event_id: receipt.event_id,
        lease_token: receipt.lease_token,
      });
      const warn = (receipt: ClaimedReceipt, outcome: string) =>
        deps.log({
          level: "warning",
          worker: WORKER,
          outcome,
          request_id: rid,
          event_id: receipt.event_id,
          event_type: receipt.event_type,
        });
      const done = async (
        receipt: ClaimedReceipt,
        code: string,
      ): Promise<Finished> => {
        await store.finish({ ...reference(receipt), action: "done", code });
        return code === "recorded" ? "recorded" : "skipped";
      };
      const retry = async (
        receipt: ClaimedReceipt,
        code: string,
        delaySeconds?: number,
      ): Promise<Finished> => {
        const answer = await store.finish({
          ...reference(receipt),
          action: "retry",
          code,
          ...(delaySeconds ? { delay_seconds: delaySeconds } : {}),
        });
        if (answer.state !== "failed") return "retried";
        warn(receipt, "gave_up");
        return "failed";
      };
      const release = async (receipts: ClaimedReceipt[], code: string) => {
        for (const receipt of receipts) {
          try {
            await store.finish({
              ...reference(receipt),
              action: "release",
              code,
            });
            counts.released += 1;
          } catch {
            // The lease runs out by itself and the receipt is claimed again.
          }
        }
      };

      const work = async (receipt: ClaimedReceipt): Promise<Finished> => {
        if (PAYMENT_EVENTS.includes(receipt.event_type)) {
          const reading = await reader.payment(receipt);
          if ("skip" in reading) return await done(receipt, reading.skip);
          const answer = await store.recordSale({
            ...reference(receipt),
            ...reading.sale,
          });
          if (answer.recorded !== true) {
            return await done(receipt, outcomeCode(answer.reason));
          }
          // Stripe settles the fee a little after the payment: look again soon.
          if (
            reading.sale.fee_minor === null && receipt.attempts < FEE_ATTEMPTS
          ) {
            return await retry(receipt, "fee_pending", SHORT_RETRY_SECONDS);
          }
          return await done(receipt, "recorded");
        }
        const reading = await reader.adjustment(receipt);
        if ("skip" in reading) return await done(receipt, reading.skip);
        const answer = await store.recordSaleEvent({
          ...reference(receipt),
          ...reading.adjustment,
        });
        if (answer.recorded === true) return await done(receipt, "recorded");
        // The refund overtook its payment: wait for the sale to be recorded.
        return answer.reason === "sale_pending"
          ? await retry(receipt, "sale_pending", SHORT_RETRY_SECONDS)
          : await done(receipt, outcomeCode(answer.reason));
      };

      let stopped = false;
      for (let batch = 0; batch < MAX_BATCHES && !stopped; batch++) {
        if (deps.now() >= deadline) break;
        const claim = await store.claim({
          platform_account_id: config.platformAccountId,
          limit: BATCH_SIZE,
          lease_seconds: LEASE_SECONDS,
        });
        counts.claimed += claim.receipts.length;
        counts.closed_unread += claim.skipped + claim.failed;
        for (const [index, receipt] of claim.receipts.entries()) {
          if (deps.now() >= deadline) {
            await release(claim.receipts.slice(index), "worker_out_of_time");
            stopped = true;
            break;
          }
          let finished: Finished;
          try {
            finished = await work(receipt);
          } catch (error) {
            if (
              error instanceof StripeReadError && error.kind === "configuration"
            ) {
              // The platform key was refused: no receipt can be read. Hand
              // every claimed receipt back and fail the run loudly.
              await release(claim.receipts.slice(index), error.code);
              throw new RunStopped();
            }
            if (error instanceof StripeReadError) {
              warn(receipt, error.code);
              finished = await retry(receipt, error.code);
            } else if (
              error instanceof DatabaseBoundaryError &&
              error.databaseCode === "55000"
            ) {
              // Another run holds this receipt now. Leave it alone.
              warn(receipt, "lease_lost");
              finished = "released";
            } else {
              const code = error instanceof DatabaseBoundaryError
                ? ["22023", "23514", "23505"].includes(error.databaseCode ?? "")
                  ? "database_rejected"
                  : "database_unavailable"
                : "worker_error";
              warn(receipt, code);
              finished = await retry(receipt, code);
            }
          }
          counts[finished] += 1;
        }
        if (claim.receipts.length < BATCH_SIZE) break;
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

/** A reason from the database is used as an outcome only when it is a code. */
function outcomeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,59}$/.test(value) &&
      value !== "failed" && value !== "recorded"
    ? value
    : "not_recorded";
}

export const handleProgramSalesWorker = createProgramSalesWorker();
if (import.meta.main) Deno.serve(handleProgramSalesWorker);
