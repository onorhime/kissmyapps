// The payout tables and the functions the worker calls, in memory, following
// the rules written in the phase 4 part two contract (the real ones are
// supabase/migrations/20261117101000_program_payouts.sql and the legacy
// set_creator_connect_account). No database. Every value here is made up.
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import { fakeUuid, PLATFORM } from "../program-payout-account/testing.ts";
import {
  type Json,
  type PayoutFunction,
  type PayoutStore,
  StoreRejection,
} from "./store.ts";

const HOUR = 3_600_000;

export interface FakeCreator {
  /** The id of the creator's account row. */
  accountKey: string;
  affiliateId: string;
  /** Their Stripe account; null: none yet. */
  id: string | null;
  status: "not_connected" | "pending" | "ready" | "restricted";
  /** How many times Stripe's view of the account was stored. */
  stored: number;
}

export interface FakePayout {
  id: string;
  affiliateId: string;
  platformAccountId: string;
  currency: string;
  amountMinor: number;
  status: "approved" | "processing" | "paid" | "failed" | "canceled";
  connectAccountId: string | null;
  transferId: string | null;
  failureCode: string | null;
  attempts: number;
  firstAttemptAt: number | null;
  nextAttemptAt: number | null;
  lease: string | null;
  leaseUntil: number | null;
}

function reject(reason: string): never {
  throw new StoreRejection("22023", reason);
}

/** A time the way Postgres writes it into JSON. */
function written(time: number | null): string | null {
  return time === null
    ? null
    : new Date(time).toISOString().replace("Z", "000+00:00");
}

export class FakePayoutStore implements PayoutStore {
  /** platform_settings.program_payouts_enabled. */
  payoutsEnabled = true;
  readonly creators = new Map<string, FakeCreator>();
  readonly payouts = new Map<string, FakePayout>();
  /** Payouts whose money went back to the creator's sum. */
  readonly returned: string[] = [];
  readonly calls: { name: PayoutFunction; input: Json }[] = [];
  /** Functions that fail as if the database were down. */
  readonly down = new Set<PayoutFunction>();
  /** Runs just before a function, for example to take a lease away. */
  before: Partial<Record<PayoutFunction, (input: Json) => void>> = {};

  constructor(private readonly now: () => number) {}

  addCreator(options: Partial<FakeCreator> = {}): FakeCreator {
    const creator: FakeCreator = {
      accountKey: fakeUuid(),
      affiliateId: fakeUuid(),
      id: `acct_FakeCreator${this.creators.size + 1}`,
      status: "ready",
      stored: 0,
      ...options,
    };
    this.creators.set(creator.affiliateId, creator);
    return creator;
  }

  /** A payout an admin just made. */
  addPayout(
    creator: FakeCreator,
    options: Partial<FakePayout> = {},
  ): FakePayout {
    const payout: FakePayout = {
      id: fakeUuid(),
      affiliateId: creator.affiliateId,
      platformAccountId: PLATFORM,
      currency: "USD",
      amountMinor: 4410,
      status: "approved",
      connectAccountId: null,
      transferId: null,
      failureCode: null,
      attempts: 0,
      firstAttemptAt: null,
      nextAttemptAt: null,
      lease: null,
      leaseUntil: null,
      ...options,
    };
    this.payouts.set(payout.id, payout);
    return payout;
  }

  /** What another run would do: take over a payout whose lease it holds now. */
  takeLease(payout: FakePayout): void {
    payout.lease = fakeUuid();
    payout.leaseUntil = this.now() + 300_000;
  }

  named(name: PayoutFunction): Json[] {
    return this.calls.filter((call) => call.name === name).map((call) =>
      call.input
    );
  }

  private row(payout: FakePayout): Json {
    const creator = this.creators.get(payout.affiliateId);
    return {
      payout_id: payout.id,
      lease_token: payout.lease,
      affiliate_id: payout.affiliateId,
      amount_minor: payout.amountMinor,
      currency: payout.currency,
      platform_account_id: payout.platformAccountId,
      status: payout.status,
      attempts: payout.attempts,
      first_attempt_at: written(payout.firstAttemptAt),
      connect_account_id: creator?.id ?? null,
      account_key: creator?.accountKey ?? null,
      account_status: creator?.status ?? "not_connected",
      lookup_only: payout.firstAttemptAt !== null &&
        this.now() - payout.firstAttemptAt > 23 * HOUR,
    };
  }

  private held(input: Json): FakePayout {
    const payout = this.payouts.get(String(input.payout_id));
    if (!payout) reject("invalid_input");
    const offered = input.lease_token;
    if (
      payout.lease === null || payout.lease !== offered ||
      (payout.leaseUntil ?? 0) <= this.now()
    ) reject("lease_lost");
    return payout;
  }

  call(name: PayoutFunction, input: Json): Promise<Json> {
    try {
      return Promise.resolve(this.answer(name, input));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private answer(name: PayoutFunction, input: Json): Json {
    this.calls.push({ name, input: structuredClone(input) });
    this.before[name]?.(input);
    if (this.down.has(name)) throw new DatabaseBoundaryError("57P01");
    const now = this.now();

    if (name === "claim_program_payouts") {
      const { limit, lease_seconds: seconds } = input;
      if (
        typeof limit !== "number" || limit < 1 || limit > 25 ||
        typeof seconds !== "number" || seconds < 60 || seconds > 900 ||
        typeof input.platform_account_id !== "string"
      ) reject("invalid_input");
      if (!this.payoutsEnabled) return { payouts: [] };
      const due = [...this.payouts.values()].filter((payout) =>
        (payout.status === "approved" || payout.status === "processing") &&
        payout.platformAccountId === input.platform_account_id &&
        (payout.leaseUntil === null || payout.leaseUntil <= now) &&
        (payout.nextAttemptAt === null || payout.nextAttemptAt <= now)
      ).slice(0, limit);
      for (const payout of due) {
        payout.lease = fakeUuid();
        payout.leaseUntil = now + seconds * 1000;
      }
      return { payouts: due.map((payout) => this.row(payout)) };
    }

    if (name === "begin_program_payout") {
      const payout = this.held(input);
      const destination = input.connect_account_id;
      if (typeof destination !== "string") reject("invalid_input");
      if (
        payout.connectAccountId !== null &&
        payout.connectAccountId !== destination
      ) reject("destination_changed");
      payout.status = "processing";
      payout.connectAccountId = destination;
      payout.firstAttemptAt ??= now;
      payout.attempts += 1;
      return this.row(payout);
    }

    if (name === "finish_program_payout") {
      const known = this.payouts.get(String(input.payout_id));
      // A repeat of "paid" with the same transfer is answered, not refused.
      if (
        known?.status === "paid" && input.outcome === "paid" &&
        known.transferId === input.transfer_id
      ) return this.row(known);
      const payout = this.held(input);
      if (input.outcome === "paid") {
        if (
          typeof input.transfer_id !== "string" ||
          !/^tr_[A-Za-z0-9]+$/.test(input.transfer_id)
        ) reject("invalid_input");
        payout.status = "paid";
        payout.transferId = input.transfer_id;
        payout.failureCode = null;
      } else if (input.outcome === "retry") {
        const delay = input.delay_seconds ?? 300;
        if (typeof delay !== "number" || delay < 60 || delay > 86_400) {
          reject("invalid_input");
        }
        if (input.failure_code !== undefined) {
          payout.failureCode = String(input.failure_code);
        }
        payout.nextAttemptAt = now + delay * 1000;
      } else if (input.outcome === "failed") {
        if (
          typeof input.failure_code !== "string" ||
          !/^[a-z][a-z0-9_]{1,79}$/.test(input.failure_code)
        ) reject("invalid_input");
        payout.status = "failed";
        payout.failureCode = input.failure_code;
        // One payout_reversed entry per item: the money is back.
        this.returned.push(payout.id);
      } else reject("invalid_input");
      payout.lease = null;
      payout.leaseUntil = null;
      return this.row(payout);
    }

    // set_creator_connect_account, as the legacy migration wrote it.
    const creator = [...this.creators.values()].find((entry) =>
      entry.accountKey === input.account_key
    );
    const destination = input.connect_account_id;
    if (
      !creator || creator.affiliateId !== input.affiliate_id ||
      input.platform_account_id !== PLATFORM || input.livemode !== true ||
      typeof destination !== "string" || !/^acct_/.test(destination) ||
      (creator.id !== null && creator.id !== destination) ||
      typeof input.verified_at !== "string" ||
      !Array.isArray(input.requirements_due) ||
      ["charges_enabled", "payouts_enabled", "transfers_enabled"].some((key) =>
        typeof input[key] !== "boolean"
      ) || typeof input.details_submitted !== "boolean"
    ) throw new DatabaseBoundaryError("22023");
    creator.id = destination;
    creator.stored += 1;
    creator.status = input.disabled_reason
      ? "restricted"
      : input.transfers_enabled && input.payouts_enabled &&
          input.details_submitted
      ? "ready"
      : "pending";
    return {
      id: creator.accountKey,
      account_key: creator.accountKey,
      affiliate_id: creator.affiliateId,
      connect_account_id: creator.id,
      status: creator.status,
    };
  }
}
