// A merchant adds money to their affiliate program's prepaid balance, or
// replaces the card that automatic top-ups charge. Both happen on Stripe's own
// hosted Checkout page, on the KissMyApps platform's live Stripe account: this
// function only makes the page and answers with its address. Card data never
// passes through it. Nothing is added to a balance here: that happens only
// when Stripe confirms the payment (program-balance-webhook, and the worker's
// periodic check). The database rules live in
// supabase/migrations/20261116102000_program_balance.sql.
// Off unless PROGRAM_BALANCE_ENABLED is exactly "true". Live only.
import {
  ConfigurationError,
  DatabaseBoundaryError,
  RequestError,
} from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  requestId,
  requireMethod,
  securityHeaders,
} from "../_shared/http.ts";
import { authenticatedClient } from "../_shared/supabase.ts";
import { isPlainObject } from "../_shared/validation.ts";
import { consoleConnectOrigin } from "../workspace-stripe-connect/config.ts";
import {
  type BalanceReturnUrls,
  balanceReturnUrls,
  type ProgramBalanceConfig,
  programBalanceConfig,
  programBalanceEnabled,
} from "./config.ts";
import {
  type BalanceStore,
  databaseBalanceStore,
  parseTopup,
  StoreRejection,
} from "./store.ts";
import { BalanceStripe, STRIPE_ID, StripeCallError } from "./stripe.ts";

const FUNCTION = "program-balance";
/** Stripe allows 30 minutes to 24 hours. The page is good for 35 minutes. */
export const CHECKOUT_LIFETIME_SECONDS = 35 * 60;
export const MAX_AMOUNT_MINOR = 100_000_000;

export interface BalanceIdentity {
  userId: string;
}

export interface ProgramBalanceLogEntry {
  level: "info" | "warning" | "error";
  function: typeof FUNCTION;
  outcome: string;
  request_id: string;
  topup_id?: string;
}

export interface ProgramBalanceDependencies {
  enabled: () => boolean;
  origin: () => string;
  config: () => ProgramBalanceConfig;
  returnUrls: () => BalanceReturnUrls;
  authenticate: (authorization: string) => Promise<BalanceIdentity>;
  store: () => BalanceStore;
  fetcher: typeof fetch;
  /** A fresh value for the Idempotency-Key of a card change. */
  random: () => string;
  now: () => number;
  log: (entry: ProgramBalanceLogEntry) => void;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS: Record<string, readonly string[]> = {
  deposit: ["workspace_id", "amount_minor"],
  card: ["workspace_id"],
};

// The one-word reasons the database functions raise as the error DETAIL, and
// what the console is told for each.
const REASONS: Record<string, readonly [number, string]> = {
  invalid_input: [400, "Check the details and try again."],
  invalid_amount_minor: [400, "Choose an amount within the allowed range."],
  not_a_member: [403, "You are not a member of this workspace."],
  owner_or_admin_required: [
    403,
    "Only a workspace owner or admin can add funds or change the card.",
  ],
  verified_email_required: [
    401,
    "Confirm your email address, then sign in again.",
  ],
  program_money_disabled: [409, "Balances are not available yet."],
  no_program: [409, "Create your affiliate program first."],
  balance_not_started: [409, "Make a first deposit before changing the card."],
  currency_mismatch: [
    409,
    "The balance is in another currency than the program. Contact KissMyApps.",
  ],
  platform_mismatch: [409, "This balance cannot be changed from here."],
};
function reason(code: string): RequestError {
  const [status, message] = REASONS[code];
  return new RequestError(status, code, message);
}

/** Turns a failure below the handler into the error the console is told. */
function surfaced(error: unknown): unknown {
  if (error instanceof StoreRejection) {
    return Object.hasOwn(REASONS, error.reason)
      ? reason(error.reason)
      : new RequestError(
        409,
        "balance_conflict",
        "The balance could not be changed. Refresh the page and try again.",
      );
  }
  if (error instanceof StripeCallError) {
    if (error.kind === "configuration") return new ConfigurationError();
    return error.kind === "unavailable"
      ? new RequestError(
        502,
        "stripe_unavailable",
        "Stripe could not be reached. Try again in a moment.",
      )
      : new RequestError(
        502,
        "stripe_rejected",
        "Stripe did not accept the request. Try again, or contact KissMyApps.",
      );
  }
  return error;
}

/** Only a real, signed-in person with a confirmed email may use the console. */
export function verifiedIdentity(
  user:
    | {
      id?: unknown;
      email?: unknown;
      email_confirmed_at?: unknown;
      is_anonymous?: unknown;
    }
    | null
    | undefined,
): BalanceIdentity {
  if (
    !user || typeof user.id !== "string" || !UUID.test(user.id) ||
    user.is_anonymous || !user.email_confirmed_at || !user.email
  ) {
    throw new RequestError(
      401,
      "verified_email_required",
      "Sign in with a confirmed email address.",
    );
  }
  return { userId: user.id.toLowerCase() };
}

function invalid(): never {
  throw new RequestError(
    400,
    "invalid_input",
    "Check the details and try again.",
  );
}
function text(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new DatabaseBoundaryError();
  }
  return value;
}
function amount(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) throw new DatabaseBoundaryError();
  return value;
}

function defaults(): ProgramBalanceDependencies {
  return {
    enabled: programBalanceEnabled,
    origin: consoleConnectOrigin,
    config: programBalanceConfig,
    returnUrls: balanceReturnUrls,
    authenticate: async (authorization) => {
      const { data, error } = await authenticatedClient(authorization).auth
        .getUser(authorization.slice(7));
      return verifiedIdentity(error ? null : data.user);
    },
    store: databaseBalanceStore,
    fetcher: fetch,
    random: () => crypto.randomUUID(),
    now: Date.now,
    log: (entry) => console.warn(JSON.stringify(entry)),
  };
}

export function createProgramBalanceHandler(
  overrides: Partial<ProgramBalanceDependencies> = {},
) {
  const deps = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    let headers: Record<string, string> = {};
    try {
      requireMethod(request, ["POST", "OPTIONS"]);
      const origin = request.headers.get("origin") ?? "";
      if (origin !== deps.origin()) {
        throw new RequestError(
          403,
          "origin_rejected",
          "This origin is not allowed.",
        );
      }
      headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers":
          "authorization,apikey,content-type,x-client-info",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      };
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: securityHeaders(headers),
        });
      }
      const input = await readJsonBody(request, 4096);
      if (!isPlainObject(input)) invalid();
      const action = typeof input.action === "string" ? input.action : "";
      if (
        !Object.hasOwn(ACTIONS, action) ||
        Object.keys(input).length !== ACTIONS[action].length + 1 ||
        ACTIONS[action].some((key) => !Object.hasOwn(input, key)) ||
        typeof input.workspace_id !== "string" || !UUID.test(input.workspace_id)
      ) invalid();
      const workspaceId = (input.workspace_id as string).toLowerCase();
      const amountMinor = input.amount_minor;
      if (
        action === "deposit" &&
        (typeof amountMinor !== "number" ||
          !Number.isSafeInteger(amountMinor) ||
          amountMinor <= 0 || amountMinor > MAX_AMOUNT_MINOR)
      ) throw reason("invalid_amount_minor");

      const authorization = request.headers.get("authorization") ?? "";
      if (!/^Bearer [A-Za-z0-9._~-]{32,4096}$/.test(authorization)) {
        throw new RequestError(
          401,
          "unauthorized",
          "Sign in to manage the balance.",
        );
      }
      const { userId } = await deps.authenticate(authorization);

      // Switched off: no database call, no Stripe call, no key is read.
      if (!deps.enabled()) {
        throw new RequestError(
          503,
          "program_balance_disabled",
          "Adding funds is not available yet.",
        );
      }
      const config = deps.config();
      const urls = deps.returnUrls();
      const store = deps.store();
      const stripe = new BalanceStripe(config.secret, {
        fetcher: deps.fetcher,
      });
      const note = (
        level: ProgramBalanceLogEntry["level"],
        outcome: string,
        topupId?: string,
      ): void =>
        deps.log({
          level,
          function: FUNCTION,
          outcome,
          request_id: rid,
          ...(topupId ? { topup_id: topupId } : {}),
        });
      const member = {
        workspace_id: workspaceId,
        user_id: userId,
        platform_account_id: config.platformAccountId,
      };
      const expiresAt = Math.floor(deps.now() / 1000) +
        CHECKOUT_LIFETIME_SECONDS;

      // The database decides who may do this, before any call to Stripe. A
      // card change never opens a balance: that is what the first deposit does.
      const account = await store.call("open_program_balance", {
        ...member,
        ...(action === "card" ? { create: false } : {}),
      });
      const accountId = text(account.account_id);
      const programId = text(account.program_id);
      const currency = text(account.currency);
      if (currency !== account.program_currency) {
        throw reason("currency_mismatch");
      }
      // Known to be out of range before anything is made at Stripe.
      if (
        action === "deposit" &&
        ((amountMinor as number) < amount(account.min_deposit_minor) ||
          (amountMinor as number) > amount(account.max_deposit_minor))
      ) throw reason("invalid_amount_minor");

      // One Stripe customer per balance account: the business, not a person.
      let customerId = account.stripe_customer_id;
      if (customerId === null || customerId === undefined) {
        const created = await stripe.createCustomer({
          accountId,
          programId,
          workspaceId,
          businessName: text(account.business_name),
        });
        // The first customer stored for the account stays, whoever made it.
        customerId = (await store.call("attach_program_balance_customer", {
          account_id: accountId,
          stripe_customer_id: created,
          platform_account_id: config.platformAccountId,
        })).stripe_customer_id;
      }
      if (
        typeof customerId !== "string" || !STRIPE_ID.customer.test(customerId)
      ) {
        throw new DatabaseBoundaryError();
      }

      if (action === "card") {
        const session = await stripe.createCardSession({
          accountId,
          programId,
          workspaceId,
          customerId,
          currency,
          successUrl: urls.cardDone,
          cancelUrl: urls.cardCanceled,
          expiresAt,
          nonce: deps.random(),
        });
        note("info", "card_change_started");
        return jsonResponse(200, { checkout_url: session.url }, headers);
      }

      const begun = await store.call("begin_program_deposit", {
        ...member,
        amount_minor: amountMinor,
      });
      const topup = parseTopup(begun);
      if (
        topup.customerId !== customerId || topup.amountMinor !== amountMinor ||
        topup.currency !== currency
      ) throw new DatabaseBoundaryError();

      let session: { id: string; url: string };
      try {
        session = await stripe.createDepositSession({
          topupId: topup.topupId,
          accountId,
          programId,
          workspaceId,
          customerId,
          amountMinor: topup.amountMinor,
          currency: topup.currency,
        }, {
          programName: text(account.program_name),
          successUrl: urls.depositDone,
          cancelUrl: urls.depositCanceled,
          expiresAt,
        });
      } catch (error) {
        // No page was handed out, so nobody can pay this top-up: close it.
        // If Stripe did make the page after all, nobody has its address.
        try {
          await store.call("settle_program_topup", {
            topup_id: topup.topupId,
            outcome: "canceled",
            failure_code: "checkout_not_created",
          });
        } catch {
          note("warning", "topup_not_closed", topup.topupId);
        }
        throw error;
      }
      await store.call("attach_program_topup", {
        topup_id: topup.topupId,
        checkout_session_id: session.id,
      });

      // The pages of earlier, unpaid deposits are ended at Stripe. If that
      // fails the answer stands: a payment on an old page is still credited,
      // once, to the top-up it belongs to.
      const superseded = Array.isArray(begun.superseded)
        ? begun.superseded
        : [];
      for (const old of superseded) {
        if (
          !isPlainObject(old) || typeof old.topup_id !== "string" ||
          typeof old.checkout_session_id !== "string"
        ) continue;
        try {
          await stripe.expireSession(old.checkout_session_id, old.topup_id);
        } catch {
          note("warning", "old_checkout_not_expired", old.topup_id);
        }
      }
      note("info", "deposit_started", topup.topupId);
      return jsonResponse(200, { checkout_url: session.url }, headers);
    } catch (caught) {
      const error = surfaced(caught);
      const response = errorResponse(error, rid, headers);
      if (response.status >= 500) {
        deps.log({
          level: "error",
          function: FUNCTION,
          outcome: error instanceof RequestError ||
              error instanceof ConfigurationError ||
              error instanceof DatabaseBoundaryError
            ? error.code
            : "internal_error",
          request_id: rid,
        });
      }
      return response;
    }
  };
}

export const handleProgramBalance = createProgramBalanceHandler();
if (import.meta.main) Deno.serve(handleProgramBalance);
