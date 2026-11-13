// The database side of the payout worker: the service-role functions of
// supabase/migrations/20261117101000_program_payouts.sql, each taking and
// returning one JSON object, and the legacy function that stores what Stripe
// says about a creator's account. Tests replace the whole store with an
// in-memory one.
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";
import { type Json, StoreRejection } from "../program-balance/store.ts";

export { type Json, StoreRejection };

/** The database functions the worker may call, and nothing else. */
export type PayoutFunction =
  | "claim_program_payouts"
  | "begin_program_payout"
  | "finish_program_payout"
  // Legacy, called unchanged: it owns external_creator_accounts.
  | "set_creator_connect_account";

export interface PayoutStore {
  call(name: PayoutFunction, input: Json): Promise<Json>;
}

export function databasePayoutStore(timeoutMs = 10_000): PayoutStore {
  const client = serviceClient(timeoutMs);
  return {
    call: async (name, input) => {
      const { data, error } = await client.rpc(name, { p_input: input });
      if (error) {
        const code = typeof error.code === "string" ? error.code : undefined;
        // The payout functions name their reason as the error DETAIL.
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
const ACCOUNT = /^acct_[A-Za-z0-9]{1,250}$/;

/** A payout handed to this run by claim_program_payouts. */
export interface ClaimedPayout {
  payoutId: string;
  /** Proves to the database that this run holds the payout. */
  lease: string;
  affiliateId: string;
  amountMinor: number;
  currency: string;
  platformAccountId: string;
  status: "approved" | "processing";
  /** How many times Stripe was asked, or was about to be. */
  attempts: number;
  /** When Stripe was first asked, as an ISO time; null: never. */
  firstAttemptAt: string | null;
  /** The creator's Stripe account, from their account row now. */
  connectAccountId: string | null;
  /** The id of that account row. */
  accountKey: string | null;
  /** Too old to ask Stripe again: the transfer may only be looked up. */
  lookupOnly: boolean;
}

/** One spelling of a database time, so two readings of it compare equal. */
function instant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new DatabaseBoundaryError();
  return new Date(time).toISOString();
}

function nullable(value: unknown, pattern: RegExp): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new DatabaseBoundaryError();
  }
  return value;
}

/** Reads a claimed payout; anything unexpected is refused. */
export function parsePayout(value: unknown): ClaimedPayout {
  if (!isPlainObject(value)) throw new DatabaseBoundaryError();
  const lease = value.lease_token;
  if (
    typeof value.payout_id !== "string" || !UUID.test(value.payout_id) ||
    typeof lease !== "string" || !UUID.test(lease) ||
    typeof value.affiliate_id !== "string" || !UUID.test(value.affiliate_id) ||
    typeof value.amount_minor !== "number" ||
    !Number.isSafeInteger(value.amount_minor) || value.amount_minor <= 0 ||
    typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency) ||
    typeof value.platform_account_id !== "string" ||
    !ACCOUNT.test(value.platform_account_id) ||
    (value.status !== "approved" && value.status !== "processing") ||
    typeof value.attempts !== "number" ||
    !Number.isSafeInteger(value.attempts) || value.attempts < 0 ||
    typeof value.lookup_only !== "boolean"
  ) throw new DatabaseBoundaryError();
  const firstAttemptAt = instant(value.first_attempt_at);
  // Only a payout Stripe was asked for can be too old to ask again.
  if (value.lookup_only && firstAttemptAt === null) {
    throw new DatabaseBoundaryError();
  }
  return {
    payoutId: value.payout_id,
    lease,
    affiliateId: value.affiliate_id,
    amountMinor: value.amount_minor,
    currency: value.currency,
    platformAccountId: value.platform_account_id,
    status: value.status,
    attempts: value.attempts,
    firstAttemptAt,
    connectAccountId: nullable(value.connect_account_id, ACCOUNT),
    accountKey: nullable(value.account_key, UUID),
    lookupOnly: value.lookup_only,
  };
}

/** The payouts of a claim answer. */
export function parseClaim(value: Json): ClaimedPayout[] {
  if (!Array.isArray(value.payouts)) throw new DatabaseBoundaryError();
  return value.payouts.map(parsePayout);
}

/** What begin_program_payout says the payout is, just before Stripe is asked. */
export interface BegunPayout {
  amountMinor: number;
  currency: string;
  platformAccountId: string;
  connectAccountId: string;
  firstAttemptAt: string;
}

/**
 * Reads the answer of begin_program_payout for one payout. Only what the
 * transfer is made of is read, so the worker sends what the database holds at
 * that moment and nothing it remembered from the claim.
 */
export function parseBegun(value: Json, payoutId: string): BegunPayout {
  const firstAttemptAt = instant(value.first_attempt_at);
  if (
    value.payout_id !== payoutId || value.status !== "processing" ||
    typeof value.amount_minor !== "number" ||
    typeof value.currency !== "string" ||
    typeof value.platform_account_id !== "string" ||
    typeof value.connect_account_id !== "string" ||
    !ACCOUNT.test(value.connect_account_id) || firstAttemptAt === null
  ) throw new DatabaseBoundaryError();
  return {
    amountMinor: value.amount_minor,
    currency: value.currency,
    platformAccountId: value.platform_account_id,
    connectAccountId: value.connect_account_id,
    firstAttemptAt,
  };
}
