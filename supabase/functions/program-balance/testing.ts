// Test doubles for the three balance functions: a Stripe that lives in memory
// behind a fetch function, and a store that follows the rules of the database
// functions in supabase/migrations/20261116102000_program_balance.sql (suite
// supabase/tests/database/80_program_balance.sql tests the real ones). No
// network, no database, no real Stripe. Every value here is made up.
import { bytesToHex, hmacSha256 } from "../_shared/crypto.ts";
import { DatabaseBoundaryError } from "../_shared/errors.ts";
import {
  type BalanceFunction,
  type BalanceStore,
  type Json,
  StoreRejection,
} from "./store.ts";

export const PLATFORM = "acct_FakePlatform";
/** Shaped like a live key so the configuration check passes. Not a real key. */
export const LIVE_KEY = ["sk", "live", "FakeBalanceKey0000000000"].join("_");
export const SIGNING = ["whsec", "FakeBalanceSigning000000"].join("_");
export const ORIGIN = "https://merchant.kissmyapps.example";
export const CONFIG = { secret: LIVE_KEY, platformAccountId: PLATFORM };

let serial = 0;
/** A new id that looks like a UUID and is the same on every run. */
export function fakeUuid(): string {
  serial += 1;
  return `00000000-0000-4000-8000-${serial.toString(16).padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------
// Store

export interface FakeProgram {
  id: string;
  workspaceId: string;
  name: string;
  businessName: string;
  currency: string;
  status: string;
  pauseReason: string | null;
  stripeConnected: boolean;
  members: Map<string, "owner" | "admin" | "analyst">;
}
export interface FakeAccount {
  id: string;
  programId: string;
  workspaceId: string;
  currency: string;
  platformAccountId: string;
  availableMinor: number;
  customerId: string | null;
  card: Json | null;
  autoTopup: boolean;
  minBalanceMinor: number;
  topupAmountMinor: number;
  topupFailures: number;
  topupRetryAt: number | null;
  topupFailureCode: string | null;
}
export interface FakeTopup {
  id: string;
  accountId: string;
  kind: "deposit" | "auto";
  status: string;
  amountMinor: number;
  reversedMinor: number;
  currency: string;
  sessionId: string | null;
  intentId: string | null;
  failureCode: string | null;
  checks: number;
  createdAt: number;
  leaseToken: string | null;
  leaseUntil: number | null;
}
interface FakeEvent {
  sha: string;
  attempts: number;
  outcome: string | null;
  topupId: string | null;
}

const DAY = 86_400_000;

function reject(reason: string, sqlstate = "22023"): never {
  throw new StoreRejection(sqlstate, reason);
}

/** The balance tables and the functions over them, in memory. */
export class FakeStore implements BalanceStore {
  moneyEnabled = true;
  minFirstDepositMinor = 5000;
  readonly programs = new Map<string, FakeProgram>();
  readonly accounts = new Map<string, FakeAccount>();
  readonly topups = new Map<string, FakeTopup>();
  readonly events = new Map<string, FakeEvent>();
  /** The ledger: every movement of a balance. */
  readonly entries: {
    accountId: string;
    kind: string;
    amountMinor: number;
    topupId: string;
  }[] = [];
  readonly calls: { name: BalanceFunction; input: Json }[] = [];
  /** Functions that fail as if the database were down. */
  readonly down = new Set<BalanceFunction>();
  /** What the commission piece's tick answers; null: it is not there. */
  tick: (() => Json) | null = () => ({ approved: 0, retried: 0, remaining: 0 });

  constructor(private readonly now: () => number) {}

  /** A workspace with a live program and its owner. */
  addProgram(options: Partial<FakeProgram> & { owner: string }): FakeProgram {
    const program: FakeProgram = {
      id: fakeUuid(),
      workspaceId: fakeUuid(),
      name: "SpeakSix",
      businessName: "SpeakSix Ltd",
      currency: "USD",
      status: "live",
      pauseReason: null,
      stripeConnected: true,
      members: new Map([[options.owner, "owner"]]),
      ...options,
    };
    this.programs.set(program.workspaceId, program);
    return program;
  }

  /** A funded account with a saved card, as it is after a first deposit. */
  addFundedAccount(
    program: FakeProgram,
    options: Partial<FakeAccount> = {},
  ): FakeAccount {
    const account: FakeAccount = {
      id: fakeUuid(),
      programId: program.id,
      workspaceId: program.workspaceId,
      currency: program.currency,
      platformAccountId: PLATFORM,
      availableMinor: 0,
      customerId: "cus_FakeFunded",
      card: {
        payment_method_id: "pm_FakeSaved",
        brand: "visa",
        last4: "4242",
        exp_month: 4,
        exp_year: 2031,
      },
      autoTopup: true,
      minBalanceMinor: 5000,
      topupAmountMinor: 10000,
      topupFailures: 0,
      topupRetryAt: null,
      topupFailureCode: null,
      ...options,
    };
    this.accounts.set(account.id, account);
    return account;
  }

  accountOf(program: FakeProgram): FakeAccount {
    const account = [...this.accounts.values()].find((a) =>
      a.programId === program.id
    );
    if (!account) throw new Error("no account");
    return account;
  }
  topupsOf(account: FakeAccount, kind?: "deposit" | "auto"): FakeTopup[] {
    return [...this.topups.values()].filter((t) =>
      t.accountId === account.id && (!kind || t.kind === kind)
    );
  }
  /** The ledger total of an account: must always equal its balance. */
  ledgerOf(account: FakeAccount): number {
    return this.entries.filter((e) => e.accountId === account.id)
      .reduce((sum, e) => sum + e.amountMinor, 0);
  }
  called(name: BalanceFunction): Json[] {
    return this.calls.filter((c) => c.name === name).map((c) => c.input);
  }

  call(name: BalanceFunction, input: Json): Promise<Json> {
    this.calls.push({ name, input: structuredClone(input) });
    try {
      if (this.down.has(name)) throw new DatabaseBoundaryError("57014");
      return Promise.resolve(structuredClone(this.run(name, input)));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private run(name: BalanceFunction, input: Json): Json {
    switch (name) {
      case "open_program_balance":
        return this.open(input);
      case "attach_program_balance_customer":
        return this.attachCustomer(input);
      case "begin_program_deposit":
        return this.beginDeposit(input);
      case "find_program_topup":
        return this.find(input);
      case "attach_program_topup":
        return this.attach(input);
      case "settle_program_topup":
        return this.settle(input);
      case "reverse_program_topup":
        return this.reverse(input);
      case "save_program_balance_card":
        return this.saveCard(input);
      case "record_program_balance_event":
        return this.recordEvent(input);
      case "finish_program_balance_event":
        return this.finishEvent(input);
      case "claim_program_auto_topups":
        return this.claimAuto(input);
      case "claim_program_topup_checks":
        return this.claimChecks(input);
      case "release_program_topup":
        return this.release(input);
      case "program_commissions_tick":
        if (this.tick === null) throw new DatabaseBoundaryError("42883");
        return this.tick();
    }
  }

  private member(input: Json): FakeProgram | undefined {
    const program = this.programs.get(String(input.workspace_id));
    const role = program?.members.get(String(input.user_id));
    // Someone outside the workspace learns nothing about it.
    if (!role) reject("not_a_member", "42501");
    if (role === "analyst") reject("owner_or_admin_required", "42501");
    return program;
  }
  private programOf(account: FakeAccount): FakeProgram {
    return [...this.programs.values()].find((p) =>
      p.id === account.programId
    ) as FakeProgram;
  }
  private minDeposit(account: FakeAccount): number {
    return this.entries.some((e) =>
        e.accountId === account.id && e.kind === "deposit"
      )
      ? 1000
      : this.minFirstDepositMinor;
  }
  private charging(account: FakeAccount): boolean {
    return this.topupsOf(account, "auto").some((t) =>
      t.status === "pending" || t.status === "processing"
    );
  }
  private post(
    account: FakeAccount,
    kind: string,
    amountMinor: number,
    topupId: string,
  ): void {
    account.availableMinor += amountMinor;
    this.entries.push({ accountId: account.id, kind, amountMinor, topupId });
  }
  private topupJson(t: FakeTopup): Json {
    const account = this.accounts.get(t.accountId) as FakeAccount;
    return {
      topup_id: t.id,
      account_id: t.accountId,
      kind: t.kind,
      status: t.status,
      amount_minor: t.amountMinor,
      reversed_minor: t.reversedMinor,
      currency: t.currency,
      checkout_session_id: t.sessionId,
      payment_intent_id: t.intentId,
      failure_code: t.failureCode,
      checks: t.checks,
      created_at: Math.floor(t.createdAt / 1000),
      program_id: account.programId,
      workspace_id: account.workspaceId,
      stripe_customer_id: account.customerId,
      platform_account_id: account.platformAccountId,
      payment_method_id: account.card?.payment_method_id ?? null,
    };
  }

  private open(input: Json): Json {
    const program = this.member(input);
    if (!this.moneyEnabled) reject("program_money_disabled");
    if (!program) reject("no_program");
    let account = [...this.accounts.values()].find((a) =>
      a.programId === program!.id
    );
    if (!account && input.create !== false) {
      account = {
        id: fakeUuid(),
        programId: program!.id,
        workspaceId: program!.workspaceId,
        currency: program!.currency,
        platformAccountId: String(input.platform_account_id),
        availableMinor: 0,
        customerId: null,
        card: null,
        autoTopup: true,
        minBalanceMinor: 5000,
        topupAmountMinor: 10000,
        topupFailures: 0,
        topupRetryAt: null,
        topupFailureCode: null,
      };
      this.accounts.set(account.id, account);
    }
    if (!account) reject("balance_not_started");
    if (account!.platformAccountId !== input.platform_account_id) {
      reject("platform_mismatch");
    }
    return {
      account_id: account!.id,
      program_id: program!.id,
      workspace_id: program!.workspaceId,
      currency: account!.currency,
      program_currency: program!.currency,
      program_name: program!.name,
      business_name: program!.businessName,
      stripe_customer_id: account!.customerId,
      has_card: account!.card !== null,
      min_deposit_minor: this.minDeposit(account!),
      max_deposit_minor: 100_000_000,
    };
  }

  private attachCustomer(input: Json): Json {
    const account = this.accounts.get(String(input.account_id));
    if (!account) reject("account_not_found", "P0002");
    if (account!.platformAccountId !== input.platform_account_id) {
      reject("platform_mismatch");
    }
    account!.customerId ??= String(input.stripe_customer_id);
    return {
      account_id: account!.id,
      stripe_customer_id: account!.customerId,
    };
  }

  private beginDeposit(input: Json): Json {
    const program = this.member(input);
    if (!this.moneyEnabled) reject("program_money_disabled");
    if (!program) reject("no_program");
    const account = [...this.accounts.values()].find((a) =>
      a.programId === program!.id
    );
    if (!account || account.customerId === null) reject("balance_not_started");
    if (account!.platformAccountId !== input.platform_account_id) {
      reject("platform_mismatch");
    }
    if (account!.currency !== program!.currency) reject("currency_mismatch");
    const amount = input.amount_minor;
    if (
      typeof amount !== "number" || !Number.isSafeInteger(amount) ||
      amount < this.minDeposit(account!) || amount > 100_000_000
    ) reject("invalid_amount_minor");
    const superseded = this.topupsOf(account!, "deposit")
      .filter((t) => t.status === "pending" || t.status === "processing")
      .map((t) => {
        t.status = "canceled";
        t.failureCode = "superseded";
        t.leaseToken = t.leaseUntil = null;
        return { topup_id: t.id, checkout_session_id: t.sessionId };
      });
    const topup: FakeTopup = {
      id: fakeUuid(),
      accountId: account!.id,
      kind: "deposit",
      status: "pending",
      amountMinor: amount as number,
      reversedMinor: 0,
      currency: account!.currency,
      sessionId: null,
      intentId: null,
      failureCode: null,
      checks: 0,
      createdAt: this.now(),
      leaseToken: null,
      leaseUntil: this.now() + 600_000,
    };
    this.topups.set(topup.id, topup);
    return {
      ...this.topupJson(topup),
      program_name: program!.name,
      superseded,
    };
  }

  private find(input: Json): Json {
    const all = [...this.topups.values()];
    const intent = input.payment_intent_id as string | undefined;
    const session = input.checkout_session_id as string | undefined;
    const id = input.topup_id as string | undefined;
    if (!intent && !session && !id) reject("invalid_input");
    const topup = (intent && all.find((t) => t.intentId === intent)) ||
      (session && all.find((t) => t.sessionId === session)) ||
      (id && this.topups.get(id)) || undefined;
    if (!topup) return { found: false };
    if (
      (id && topup.id !== id) ||
      (intent && topup.intentId !== null && topup.intentId !== intent) ||
      (session && topup.sessionId !== null && topup.sessionId !== session)
    ) return { found: false, conflict: true };
    return { found: true, ...this.topupJson(topup) };
  }

  private taken(topup: FakeTopup, intent?: string, session?: string): boolean {
    return [...this.topups.values()].some((other) =>
      other.id !== topup.id &&
      ((intent !== undefined && other.intentId === intent) ||
        (session !== undefined && other.sessionId === session))
    );
  }

  private attach(input: Json): Json {
    const topup = this.topups.get(String(input.topup_id));
    const intent = input.payment_intent_id as string | undefined;
    const session = input.checkout_session_id as string | undefined;
    if (!intent && !session) reject("invalid_input");
    if (!topup) reject("topup_not_found", "P0002");
    if (
      (intent && topup!.intentId !== null && topup!.intentId !== intent) ||
      (session && topup!.sessionId !== null && topup!.sessionId !== session) ||
      this.taken(topup!, intent, session)
    ) reject("topup_mismatch");
    topup!.intentId ??= intent ?? null;
    topup!.sessionId ??= session ?? null;
    if (topup!.status === "pending") topup!.status = "processing";
    return this.topupJson(topup!);
  }

  private settle(input: Json): Json {
    const topup = this.topups.get(String(input.topup_id));
    const outcome = String(input.outcome);
    const intent = input.payment_intent_id as string | undefined;
    if (
      !["succeeded", "failed", "canceled"].includes(outcome) ||
      (outcome === "succeeded" && !intent) ||
      (outcome === "failed" && typeof input.failure_code !== "string")
    ) reject("invalid_input");
    if (!topup) reject("topup_not_found", "P0002");
    const t = topup as FakeTopup;
    const account = this.accounts.get(t.accountId) as FakeAccount;
    if (intent && t.intentId !== null && t.intentId !== intent) {
      reject("topup_mismatch");
    }
    let changed = false;
    let resumed = false;
    let replaced: unknown = null;
    if (outcome === "succeeded") {
      // Only the exact live payment of this top-up's customer adds money.
      if (
        input.livemode !== true || input.amount_minor !== t.amountMinor ||
        String(input.currency ?? "").toUpperCase() !== t.currency ||
        account.customerId === null || input.customer_id !== account.customerId
      ) reject("topup_mismatch");
      if (t.status !== "succeeded" && t.status !== "reversed") {
        if (this.taken(t, intent)) reject("topup_mismatch");
        t.intentId = intent as string;
        t.status = "succeeded";
        t.failureCode = null;
        t.leaseToken = t.leaseUntil = null;
        this.post(account, "deposit", t.amountMinor, t.id);
        let card = (input.card ?? null) as Json | null;
        if (
          t.kind === "auto" &&
          card?.payment_method_id !== account.card?.payment_method_id
        ) card = null;
        if (
          card && account.card &&
          account.card.payment_method_id !== card.payment_method_id &&
          !this.charging(account)
        ) replaced = account.card.payment_method_id;
        if (card) account.card = card;
        account.topupFailures = 0;
        account.topupRetryAt = account.topupFailureCode = null;
        const program = this.programOf(account);
        if (
          account.availableMinor > 0 && program.status === "paused" &&
          program.pauseReason === "balance_empty"
        ) {
          resumed = program.stripeConnected;
          program.status = resumed ? "live" : "paused";
          program.pauseReason = resumed ? null : "stripe_disconnected";
        }
        changed = true;
      }
    } else if (t.status === "pending" || t.status === "processing") {
      if (intent && this.taken(t, intent)) reject("topup_mismatch");
      t.intentId ??= intent ?? null;
      t.status = outcome;
      t.failureCode = (input.failure_code as string | undefined) ?? null;
      t.leaseToken = t.leaseUntil = null;
      if (outcome === "failed" && t.kind === "auto") {
        // 1 day, 3 days, 7 days, then no more tries.
        const wait = [1, 3, 7][account.topupFailures];
        account.topupRetryAt = wait ? this.now() + wait * DAY : null;
        account.topupFailures += 1;
        account.topupFailureCode = t.failureCode;
      }
      changed = true;
    }
    return {
      ...this.topupJson(t),
      changed,
      available_minor: account.availableMinor,
      program_resumed: resumed,
      topup_failures: account.topupFailures,
      replaced_payment_method_id: replaced,
    };
  }

  private reverse(input: Json): Json {
    const reason = String(input.reason);
    if (
      !["refunded", "dispute_lost"].includes(reason) ||
      (reason === "refunded" && typeof input.refunded_minor !== "number")
    ) reject("invalid_input");
    const topup = [...this.topups.values()].find((t) =>
      t.intentId === input.payment_intent_id
    );
    if (!topup) return { found: false };
    const account = this.accounts.get(topup.accountId) as FakeAccount;
    let delta = 0;
    let paused = false;
    if (topup.status === "succeeded" || topup.status === "reversed") {
      const target = reason === "dispute_lost"
        ? topup.amountMinor
        : Math.min(input.refunded_minor as number, topup.amountMinor);
      delta = Math.max(0, target - topup.reversedMinor);
      if (delta > 0) {
        this.post(account, "deposit_reversed", -delta, topup.id);
        topup.reversedMinor = target;
        if (target === topup.amountMinor) topup.status = "reversed";
        const program = this.programOf(account);
        if (
          this.moneyEnabled && account.availableMinor <= 0 &&
          program.status === "live"
        ) {
          program.status = "paused";
          program.pauseReason = "balance_empty";
          paused = true;
        }
      }
    }
    return {
      found: true,
      ...this.topupJson(topup),
      changed: delta > 0,
      available_minor: account.availableMinor,
      program_paused: paused,
    };
  }

  private saveCard(input: Json): Json {
    const account = this.accounts.get(String(input.account_id));
    const card = input.card as Json;
    if (!account) reject("account_not_found", "P0002");
    const a = account as FakeAccount;
    if (a.customerId === null || a.customerId !== input.customer_id) {
      reject("card_mismatch");
    }
    const changed = a.card?.payment_method_id !== card.payment_method_id;
    const replaced = changed && !this.charging(a)
      ? a.card?.payment_method_id ?? null
      : null;
    a.card = card;
    a.topupFailures = 0;
    a.topupRetryAt = a.topupFailureCode = null;
    return {
      account_id: a.id,
      changed,
      replaced_payment_method_id: replaced,
    };
  }

  private recordEvent(input: Json): Json {
    const id = String(input.event_id);
    const known = this.events.get(id);
    if (!known) {
      this.events.set(id, {
        sha: String(input.payload_sha256),
        attempts: 1,
        outcome: null,
        topupId: null,
      });
      return { duplicate: false, processed: false, outcome: null };
    }
    // The same id with another body is refused.
    if (known.sha !== input.payload_sha256) {
      throw new DatabaseBoundaryError("23505");
    }
    known.attempts += 1;
    return {
      duplicate: true,
      processed: known.outcome !== null,
      outcome: known.outcome,
    };
  }

  private finishEvent(input: Json): Json {
    const known = this.events.get(String(input.event_id));
    if (known && known.outcome === null) {
      known.outcome = String(input.outcome);
      known.topupId = (input.topup_id as string | undefined) ?? null;
    }
    return { found: Boolean(known), outcome: known?.outcome ?? null };
  }

  private claimAuto(input: Json): Json {
    const lease = (input.lease_seconds as number | undefined) ?? 300;
    const limit = (input.limit as number | undefined) ?? 5;
    const topups: Json[] = [];
    if (!this.moneyEnabled) return { topups };
    for (const account of this.accounts.values()) {
      const program = this.programOf(account);
      if (
        topups.length >= limit ||
        account.platformAccountId !== input.platform_account_id ||
        !account.autoTopup || account.card === null ||
        account.customerId === null ||
        account.availableMinor >= account.minBalanceMinor ||
        account.topupFailures >= 4 ||
        (account.topupRetryAt !== null && account.topupRetryAt > this.now()) ||
        account.currency !== program.currency ||
        !(program.status === "live" ||
          (program.status === "paused" &&
            program.pauseReason === "balance_empty")) ||
        // One open top-up per account: this is what stops a second charge.
        this.topupsOf(account).some((t) =>
          t.status === "pending" || t.status === "processing"
        )
      ) continue;
      const topup: FakeTopup = {
        id: fakeUuid(),
        accountId: account.id,
        kind: "auto",
        status: "pending",
        amountMinor: account.topupAmountMinor,
        reversedMinor: 0,
        currency: account.currency,
        sessionId: null,
        intentId: null,
        failureCode: null,
        checks: 0,
        createdAt: this.now(),
        leaseToken: fakeUuid(),
        leaseUntil: this.now() + lease * 1000,
      };
      this.topups.set(topup.id, topup);
      topups.push({ ...this.topupJson(topup), lease_token: topup.leaseToken });
    }
    return { topups };
  }

  private claimChecks(input: Json): Json {
    const lease = (input.lease_seconds as number | undefined) ?? 300;
    const limit = (input.limit as number | undefined) ?? 5;
    const topups: Json[] = [];
    for (const topup of this.topups.values()) {
      const account = this.accounts.get(topup.accountId) as FakeAccount;
      if (
        topups.length >= limit ||
        account.platformAccountId !== input.platform_account_id ||
        !(topup.status === "pending" || topup.status === "processing") ||
        (topup.leaseUntil !== null && topup.leaseUntil >= this.now())
      ) continue;
      topup.leaseToken = fakeUuid();
      topup.leaseUntil = this.now() + lease * 1000;
      topup.checks += 1;
      topups.push({ ...this.topupJson(topup), lease_token: topup.leaseToken });
    }
    return { topups };
  }

  private release(input: Json): Json {
    const topup = this.topups.get(String(input.topup_id));
    const delay = input.delay_seconds;
    if (typeof delay !== "number" || delay < 30 || delay > 86_400) {
      reject("invalid_input");
    }
    if (
      !topup || topup.leaseToken !== input.lease_token ||
      !(topup.status === "pending" || topup.status === "processing")
    ) return { released: false };
    topup.leaseToken = null;
    topup.leaseUntil = this.now() + (delay as number) * 1000;
    return { released: true };
  }
}

// ---------------------------------------------------------------------------
// Stripe

export interface StripeRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  idempotencyKey: string | null;
  authorization: string | null;
  version: string | null;
  account: string | null;
}

interface FakeIntent {
  id: string;
  amount: number;
  currency: string;
  customer: string | null;
  payment_method: string | null;
  status: string;
  metadata: Record<string, string>;
  amount_received: number;
  charge: string | null;
  last_payment_error: Json | null;
  created: number;
  livemode: boolean;
}
interface FakeSession {
  id: string;
  mode: string;
  status: string;
  customer: string;
  url: string;
  amount: number | null;
  currency: string | null;
  payment_intent: string | null;
  setup_intent: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string>;
  childMetadata: Record<string, string>;
  params: Record<string, string>;
}

/** How a saved card answers an off-session charge. */
export type CardBehaviour =
  | "succeeds"
  | "processing"
  /** 200 with a PaymentIntent that waits for the cardholder. */
  | "requires_action"
  /** 402 with this error code and, optionally, decline code. */
  | { code: string; decline?: string };

function nested(params: Record<string, string>, prefix: string) {
  const found: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith(`${prefix}[`) && key.endsWith("]")) {
      found[key.slice(prefix.length + 1, -1)] = value;
    }
  }
  return found;
}

/**
 * Stripe's live platform account, in memory. `fetch` is what the functions
 * are given instead of the network. Only api.stripe.com with the fake live
 * key is answered.
 */
export class FakeStripe {
  readonly requests: StripeRequest[] = [];
  readonly customers = new Map<string, Json>();
  readonly sessions = new Map<string, FakeSession>();
  readonly intents = new Map<string, FakeIntent>();
  readonly setups = new Map<string, Json>();
  readonly methods = new Map<string, Json>();
  readonly charges = new Map<string, Json>();
  readonly disputes = new Map<string, Json>();
  readonly detached: string[] = [];
  private readonly replies = new Map<string, { status: number; body: Json }>();
  private counter = 0;
  /** How each saved card answers a charge; "succeeds" when not listed. */
  readonly cards = new Map<string, CardBehaviour>();
  /**
   * Looked at before every request: return a Response to answer in Stripe's
   * place, "network" to fail the connection, "lost" to let Stripe do the work
   * and then lose the answer, or nothing to carry on.
   */
  intercept: (request: StripeRequest) => Response | "network" | "lost" | void =
    () => {};

  constructor(private readonly now: () => number) {
    this.addCard("pm_FakeSaved", "cus_FakeFunded");
  }

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}Fake${this.counter}`;
  }

  addCard(
    id: string,
    customer: string | null,
    card: Json = { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2031 },
  ): void {
    this.methods.set(id, {
      id,
      object: "payment_method",
      type: "card",
      customer,
      card,
    });
  }

  posts(pathPattern: RegExp): StripeRequest[] {
    return this.requests.filter((r) =>
      r.method === "POST" && pathPattern.test(r.path)
    );
  }

  /** The merchant pays on the hosted page with a card, which Stripe saves. */
  payCheckout(sessionId: string, method = "pm_FakePaid"): string {
    const session = this.sessions.get(sessionId) as FakeSession;
    if (!this.methods.has(method)) this.addCard(method, session.customer);
    (this.methods.get(method) as Json).customer = session.customer;
    const intent = this.makeIntent({
      amount: session.amount as number,
      currency: session.currency as string,
      customer: session.customer,
      payment_method: method,
      metadata: session.childMetadata,
      status: "succeeded",
    });
    session.status = "complete";
    session.payment_intent = intent.id;
    return intent.id;
  }

  /** The merchant saves a new card on the hosted page. */
  completeSetup(
    sessionId: string,
    method = "pm_FakeNew",
    card: Json = {
      brand: "mastercard",
      last4: "4444",
      exp_month: 9,
      exp_year: 2032,
    },
  ): string {
    const session = this.sessions.get(sessionId) as FakeSession;
    this.addCard(method, session.customer, card);
    const id = this.id("seti_");
    this.setups.set(id, {
      id,
      object: "setup_intent",
      livemode: true,
      status: "succeeded",
      customer: session.customer,
      payment_method: method,
      metadata: session.childMetadata,
    });
    session.status = "complete";
    session.setup_intent = id;
    return id;
  }

  refund(intentId: string, totalRefundedMinor: number): Json {
    const intent = this.intents.get(intentId) as FakeIntent;
    const charge = this.charges.get(intent.charge as string) as Json;
    charge.amount_refunded = totalRefundedMinor;
    return charge;
  }

  dispute(intentId: string, status: string): Json {
    const intent = this.intents.get(intentId) as FakeIntent;
    const dispute = {
      id: this.id("dp_"),
      object: "dispute",
      livemode: true,
      status,
      charge: intent.charge,
      payment_intent: intentId,
    };
    this.disputes.set(dispute.id, dispute);
    return dispute;
  }

  /** The session as an event carries it. */
  sessionObject(sessionId: string): Json {
    const s = this.sessions.get(sessionId) as FakeSession;
    return {
      id: s.id,
      object: "checkout.session",
      livemode: true,
      mode: s.mode,
      status: s.status,
      customer: s.customer,
      payment_intent: s.payment_intent,
      setup_intent: s.setup_intent,
      client_reference_id: s.client_reference_id,
      metadata: s.metadata,
    };
  }

  /** The PaymentIntent as an event carries it: nothing expanded. */
  intentObject(intentId: string): Json {
    const i = this.intents.get(intentId) as FakeIntent;
    return {
      id: i.id,
      object: "payment_intent",
      livemode: i.livemode,
      status: i.status,
      amount: i.amount,
      amount_received: i.amount_received,
      currency: i.currency,
      customer: i.customer,
      payment_method: i.payment_method,
      latest_charge: i.charge,
      metadata: i.metadata,
      last_payment_error: i.last_payment_error,
      created: i.created,
    };
  }

  private makeIntent(input: {
    amount: number;
    currency: string;
    customer: string | null;
    payment_method: string | null;
    metadata: Record<string, string>;
    status: string;
    error?: Json;
  }): FakeIntent {
    const id = this.id("pi_");
    let charge: string | null = null;
    if (input.status === "succeeded") {
      charge = this.id("ch_");
      this.charges.set(charge, {
        id: charge,
        object: "charge",
        livemode: true,
        payment_intent: id,
        amount: input.amount,
        amount_refunded: 0,
      });
    }
    const intent: FakeIntent = {
      id,
      amount: input.amount,
      currency: input.currency,
      customer: input.customer,
      payment_method: input.payment_method,
      status: input.status,
      metadata: input.metadata,
      amount_received: input.status === "succeeded" ? input.amount : 0,
      charge,
      last_payment_error: input.error ?? null,
      created: Math.floor(this.now() / 1000),
      livemode: true,
    };
    this.intents.set(id, intent);
    return intent;
  }

  private expandedIntent(id: string): Json {
    const i = this.intents.get(id) as FakeIntent;
    return {
      ...this.intentObject(id),
      payment_method: i.payment_method
        ? this.methods.get(i.payment_method) ?? i.payment_method
        : null,
      latest_charge: i.charge ? this.charges.get(i.charge) : null,
    };
  }

  private missing(): { status: number; body: Json } {
    return {
      status: 404,
      body: {
        error: { type: "invalid_request_error", code: "resource_missing" },
      },
    };
  }

  private route(request: StripeRequest): { status: number; body: Json } {
    const { method, path, params } = request;
    const ok = (body: Json) => ({ status: 200, body });
    let match: RegExpMatchArray | null;

    if (method === "POST" && path === "/v1/customers") {
      const id = this.id("cus_");
      this.customers.set(id, {
        name: params.name,
        metadata: nested(params, "metadata"),
        params,
      });
      return ok({ id, object: "customer", livemode: true });
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      const id = this.id("cs_live_");
      const session: FakeSession = {
        id,
        mode: params.mode,
        status: "open",
        customer: params.customer,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        amount: params["line_items[0][price_data][unit_amount]"]
          ? Number(params["line_items[0][price_data][unit_amount]"])
          : null,
        currency: params["line_items[0][price_data][currency]"] ??
          params.currency ?? null,
        payment_intent: null,
        setup_intent: null,
        client_reference_id: params.client_reference_id ?? null,
        metadata: nested(params, "metadata"),
        childMetadata: nested(
          params,
          params.mode === "payment"
            ? "payment_intent_data[metadata]"
            : "setup_intent_data[metadata]",
        ),
        params,
      };
      this.sessions.set(id, session);
      return ok({
        id,
        object: "checkout.session",
        livemode: true,
        mode: session.mode,
        customer: session.customer,
        url: session.url,
        status: "open",
      });
    }
    if (
      method === "POST" &&
      (match = path.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/))
    ) {
      const session = this.sessions.get(match[1]);
      if (!session) return this.missing();
      session.status = "expired";
      return ok(this.sessionObject(session.id));
    }
    if (
      method === "GET" &&
      (match = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))
    ) {
      return this.sessions.has(match[1])
        ? ok(this.sessionObject(match[1]))
        : this.missing();
    }
    if (method === "POST" && path === "/v1/payment_intents") {
      const behaviour = this.cards.get(params.payment_method) ?? "succeeds";
      const declined = typeof behaviour === "object";
      const intent = this.makeIntent({
        amount: Number(params.amount),
        currency: params.currency,
        customer: params.customer,
        payment_method: declined ? null : params.payment_method,
        metadata: nested(params, "metadata"),
        status: declined
          ? "requires_payment_method"
          : behaviour === "succeeds"
          ? "succeeded"
          : behaviour,
        ...(declined
          ? {
            error: {
              type: "card_error",
              code: behaviour.code,
              ...(behaviour.decline ? { decline_code: behaviour.decline } : {}),
            },
          }
          : {}),
      });
      if (declined) {
        return {
          status: 402,
          body: {
            error: {
              ...intent.last_payment_error,
              payment_intent: this.intentObject(intent.id),
            },
          },
        };
      }
      return ok(this.intentObject(intent.id));
    }
    if (method === "GET" && path === "/v1/payment_intents") {
      const since = Number(params["created[gte]"] ?? 0);
      return ok({
        object: "list",
        has_more: false,
        data: [...this.intents.values()]
          .filter((i) => i.customer === params.customer && i.created >= since)
          .map((i) => this.intentObject(i.id)),
      });
    }
    if (
      method === "POST" &&
      (match = path.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/))
    ) {
      const intent = this.intents.get(match[1]);
      if (!intent) return this.missing();
      if (intent.status === "succeeded" || intent.status === "canceled") {
        return {
          status: 400,
          body: {
            error: {
              type: "invalid_request_error",
              code: "payment_intent_unexpected_state",
            },
          },
        };
      }
      intent.status = "canceled";
      return ok(this.intentObject(intent.id));
    }
    if (
      method === "GET" &&
      (match = path.match(/^\/v1\/payment_intents\/([^/]+)$/))
    ) {
      return this.intents.has(match[1])
        ? ok(this.expandedIntent(match[1]))
        : this.missing();
    }
    if (
      method === "GET" && (match = path.match(/^\/v1\/setup_intents\/([^/]+)$/))
    ) {
      const setup = this.setups.get(match[1]);
      if (!setup) return this.missing();
      return ok({
        ...setup,
        payment_method: this.methods.get(String(setup.payment_method)) ??
          setup.payment_method,
      });
    }
    if (method === "GET" && (match = path.match(/^\/v1\/charges\/([^/]+)$/))) {
      const charge = this.charges.get(match[1]);
      return charge ? ok(charge) : this.missing();
    }
    if (method === "GET" && (match = path.match(/^\/v1\/disputes\/([^/]+)$/))) {
      const dispute = this.disputes.get(match[1]);
      return dispute ? ok(dispute) : this.missing();
    }
    if (
      method === "POST" &&
      (match = path.match(/^\/v1\/payment_methods\/([^/]+)\/detach$/))
    ) {
      const card = this.methods.get(match[1]);
      if (!card) return this.missing();
      card.customer = null;
      this.detached.push(match[1]);
      return ok(card);
    }
    return this.missing();
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.stripe.com") {
      return Promise.reject(new Error(`unexpected host ${url.host}`));
    }
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const source = method === "POST"
      ? new URLSearchParams(String(init?.body ?? ""))
      : url.searchParams;
    const request: StripeRequest = {
      method,
      path: url.pathname,
      params: Object.fromEntries(source),
      idempotencyKey: headers.get("idempotency-key"),
      authorization: headers.get("authorization"),
      version: headers.get("stripe-version"),
      account: headers.get("stripe-account"),
    };
    this.requests.push(request);
    const json = (status: number, body: Json): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    if (request.authorization !== `Bearer ${LIVE_KEY}`) {
      return json(401, { error: { type: "invalid_request_error" } });
    }
    const intercepted = this.intercept(request);
    if (intercepted instanceof Response) return Promise.resolve(intercepted);
    if (intercepted === "network") {
      return Promise.reject(new TypeError("connection failed"));
    }
    // The same Idempotency-Key gets the first answer again, as Stripe does.
    const replay = request.idempotencyKey
      ? this.replies.get(request.idempotencyKey)
      : undefined;
    const reply = replay ?? this.route(request);
    if (request.idempotencyKey && !replay) {
      this.replies.set(request.idempotencyKey, reply);
    }
    if (intercepted === "lost") {
      return Promise.reject(new TypeError("connection closed"));
    }
    return json(reply.status, reply.body);
  };
}

// ---------------------------------------------------------------------------
// Events

let events = 0;
/** A live event of the platform's own account, as Stripe would send it. */
export function stripeEvent(
  type: string,
  object: Json,
  nowMs: number,
  overrides: Json = {},
): Json {
  events += 1;
  return {
    id: `evt_Fake${events}`,
    object: "event",
    type,
    livemode: true,
    created: Math.floor(nowMs / 1000),
    data: { object },
    ...overrides,
  };
}

/** The request Stripe would make for an event, signed with the given value. */
export async function signedEventRequest(
  event: Json,
  nowMs: number,
  signing: string = SIGNING,
): Promise<Request> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(nowMs / 1000);
  const signature = bytesToHex(
    await hmacSha256(
      signing,
      new TextEncoder().encode(`${timestamp}.${body}`),
    ),
  );
  return new Request("https://functions.example/program-balance-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body,
  });
}
