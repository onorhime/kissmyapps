// The database side of the three balance functions: the service-role functions
// of supabase/migrations/20261116102000_program_balance.sql, each taking and
// returning one JSON object. Tests replace the whole store with an in-memory one.
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";

export type Json = Record<string, unknown>;

/** The database functions the balance functions may call, and nothing else. */
export type BalanceFunction =
  | "open_program_balance"
  | "attach_program_balance_customer"
  | "begin_program_deposit"
  | "find_program_topup"
  | "attach_program_topup"
  | "settle_program_topup"
  | "reverse_program_topup"
  | "save_program_balance_card"
  | "record_program_balance_event"
  | "finish_program_balance_event"
  | "claim_program_auto_topups"
  | "claim_program_topup_checks"
  | "release_program_topup"
  // Owned by the commission piece; the worker only calls it.
  | "program_commissions_tick";

export interface BalanceStore {
  call(name: BalanceFunction, input: Json): Promise<Json>;
}

/**
 * The database refused the request for a reason it names: the one-word code a
 * function raises as its error DETAIL (for example topup_mismatch).
 */
export class StoreRejection extends Error {
  constructor(readonly sqlstate: string, readonly reason: string) {
    super("The database refused the request.");
    this.name = "StoreRejection";
  }
}

export function databaseBalanceStore(timeoutMs = 10_000): BalanceStore {
  const client = serviceClient(timeoutMs);
  return {
    call: async (name, input) => {
      const { data, error } = await client.rpc(name, { p_input: input });
      if (error) {
        const code = typeof error.code === "string" ? error.code : undefined;
        if (
          code && typeof error.details === "string" &&
          /^[a-z][a-z0-9_]{1,59}$/.test(error.details)
        ) throw new StoreRejection(code, error.details);
        throw new DatabaseBoundaryError(code);
      }
      if (!isPlainObject(data)) throw new DatabaseBoundaryError();
      return data;
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A top-up as the database functions describe it. */
export interface Topup {
  topupId: string;
  accountId: string;
  programId: string;
  workspaceId: string;
  kind: "deposit" | "auto";
  status:
    | "pending"
    | "processing"
    | "succeeded"
    | "failed"
    | "canceled"
    | "reversed";
  amountMinor: number;
  currency: string;
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  customerId: string | null;
  paymentMethodId: string | null;
  platformAccountId: string;
  /** Epoch seconds. */
  createdAt: number;
  /** Only on a claimed top-up. */
  leaseToken: string | null;
}

function optional(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new DatabaseBoundaryError();
  return value;
}

/** Reads a top-up out of a database answer; anything unexpected is refused. */
export function parseTopup(value: unknown): Topup {
  if (
    !isPlainObject(value) ||
    typeof value.topup_id !== "string" || !UUID.test(value.topup_id) ||
    typeof value.account_id !== "string" || !UUID.test(value.account_id) ||
    typeof value.program_id !== "string" || !UUID.test(value.program_id) ||
    typeof value.workspace_id !== "string" || !UUID.test(value.workspace_id) ||
    (value.kind !== "deposit" && value.kind !== "auto") ||
    typeof value.status !== "string" ||
    !["pending", "processing", "succeeded", "failed", "canceled", "reversed"]
      .includes(value.status) ||
    typeof value.amount_minor !== "number" ||
    !Number.isSafeInteger(value.amount_minor) || value.amount_minor <= 0 ||
    typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency) ||
    typeof value.platform_account_id !== "string" ||
    typeof value.created_at !== "number" ||
    !Number.isSafeInteger(value.created_at) ||
    (value.lease_token !== undefined &&
      (typeof value.lease_token !== "string" || !UUID.test(value.lease_token)))
  ) throw new DatabaseBoundaryError();
  return {
    topupId: value.topup_id,
    accountId: value.account_id,
    programId: value.program_id,
    workspaceId: value.workspace_id,
    kind: value.kind,
    status: value.status as Topup["status"],
    amountMinor: value.amount_minor,
    currency: value.currency,
    checkoutSessionId: optional(value.checkout_session_id),
    paymentIntentId: optional(value.payment_intent_id),
    customerId: optional(value.stripe_customer_id),
    paymentMethodId: optional(value.payment_method_id),
    platformAccountId: value.platform_account_id,
    createdAt: value.created_at,
    leaseToken: typeof value.lease_token === "string"
      ? value.lease_token
      : null,
  };
}

/** The top-ups of a claim answer. */
export function parseClaim(value: Json): Topup[] {
  if (!Array.isArray(value.topups)) throw new DatabaseBoundaryError();
  return value.topups.map((row: unknown) => {
    const topup = parseTopup(row);
    if (topup.leaseToken === null) throw new DatabaseBoundaryError();
    return topup;
  });
}

export function isOpen(topup: Topup): boolean {
  return topup.status === "pending" || topup.status === "processing";
}
