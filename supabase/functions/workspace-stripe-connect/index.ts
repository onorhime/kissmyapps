// A merchant console workspace connects its own live Stripe account: no admin,
// no invitation. Live only. See the Phase 1 contract for the request and
// response shapes; the database rules live in
// supabase/migrations/20261113101000_workspace_stripe_connect.sql.
import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  requestId,
  requireMethod,
  securityHeaders,
} from "../_shared/http.ts";
import { authenticatedClient, serviceClient } from "../_shared/supabase.ts";
import { type Json, object } from "../merchant-connect/provider.ts";
import {
  type ConsoleConnectConfig,
  consoleConnectConfig,
  consoleConnectEnabled,
  consoleConnectOrigin,
} from "./config.ts";
import { type ConsoleStripe, ConsoleStripeProvider } from "./stripe.ts";

export interface ConsoleIdentity {
  userId: string;
}
export interface WorkspaceStripeDependencies {
  enabled: () => boolean;
  origin: () => string;
  config: () => ConsoleConnectConfig;
  authenticate: (authorization: string) => Promise<ConsoleIdentity>;
  /** Calls a service-role database function; failures are already mapped. */
  rpc: (name: string, args: Json) => Promise<Json>;
  provider: (config: ConsoleConnectConfig) => ConsoleStripe;
  random: () => string;
  now: () => number;
  log: (entry: Json) => void;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^ac_[A-Za-z0-9_]{8,500}$/;
const STATE_LIFETIME_MS = 10 * 60_000;
const ACTIONS: Record<string, readonly string[]> = {
  status: ["workspace_id"],
  start: ["workspace_id"],
  complete: ["state", "code"],
  disconnect: ["workspace_id"],
};

// The one-word reasons the database functions raise as the error DETAIL.
const REASONS: Record<string, readonly [number, string]> = {
  invalid_input: [400, "Check the connection details."],
  not_a_member: [403, "You are not a member of this workspace."],
  owner_or_admin_required: [
    403,
    "Only a workspace owner or admin can connect or disconnect Stripe.",
  ],
  verified_email_required: [
    401,
    "Confirm your email address, then sign in again.",
  ],
  state_invalid: [
    403,
    "This connection attempt has expired or was already used. Start again from the Connections page.",
  ],
  stripe_not_live: [409, "Only a live Stripe account can be connected."],
  stripe_account_not_ready: [
    409,
    "Finish setting up your Stripe account so it can take payments, then connect again.",
  ],
  stripe_account_in_use: [
    409,
    "This Stripe account is already connected to another workspace.",
  ],
  connection_in_use: [
    409,
    "Products are assigned to this Stripe connection. Ask KissMyApps to move them first.",
  ],
};
function reason(code: string): RequestError {
  const [status, message] = REASONS[code];
  return new RequestError(status, code, message);
}

/** Turns a database failure into the error the console is told about. */
export function databaseError(
  error: { code?: unknown; details?: unknown; message?: unknown },
): Error {
  const code = typeof error.code === "string" ? error.code : undefined;
  if (
    typeof error.details === "string" && Object.hasOwn(REASONS, error.details)
  ) {
    return reason(error.details);
  }
  // The payment summary raises a bare 42501 for someone who is not a member.
  // A missing grant is a deployment fault, not something about the user.
  if (
    code === "42501" &&
    !(typeof error.message === "string" &&
      error.message.startsWith("permission denied"))
  ) return reason("not_a_member");
  if (["22023", "23505", "23514", "P0001", "55000"].includes(code ?? "")) {
    return new RequestError(
      409,
      "merchant_connection_conflict",
      "The Stripe connection could not be changed. Refresh the page and try again.",
    );
  }
  return new DatabaseBoundaryError(code);
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
): ConsoleIdentity {
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

export async function stateHash(value: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function nonce(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  ).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function invalid(): never {
  throw new RequestError(400, "invalid_input", "Check the connection details.");
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid();
  return String(value).toLowerCase();
}

function noPayments(): Json {
  return { seen: 0, tagged: 0, last_at: null, last_tagged_at: null };
}
// Only the agreed fields leave the function, whatever the database returns.
function paymentsView(value: Json): Json {
  const count = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
  const time = (v: unknown) => typeof v === "string" ? v : null;
  return {
    seen: count(value.seen),
    tagged: count(value.tagged),
    last_at: time(value.last_at),
    last_tagged_at: time(value.last_tagged_at),
  };
}
// A pending or revoked connection is "not connected" to the merchant.
function connectionView(value: unknown): Json | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Json;
  if (c.status !== "active" || typeof c.account_id !== "string") return null;
  return {
    status: "active",
    account_id: c.account_id,
    business_name: typeof c.business_name === "string" && c.business_name
      ? c.business_name
      : c.account_id,
    country: typeof c.country === "string" ? c.country : null,
    charges_enabled: c.charges_enabled === true,
    payouts_enabled: c.payouts_enabled === true,
    details_submitted: c.details_submitted === true,
    connected_at: typeof c.connected_at === "string" ? c.connected_at : null,
  };
}

function defaults(): WorkspaceStripeDependencies {
  return {
    enabled: consoleConnectEnabled,
    origin: consoleConnectOrigin,
    config: consoleConnectConfig,
    authenticate: async (authorization) => {
      const { data, error } = await authenticatedClient(authorization).auth
        .getUser(authorization.slice(7));
      return verifiedIdentity(error ? null : data.user);
    },
    rpc: async (name, args) => {
      const { data, error } = await serviceClient().rpc(name, args);
      if (error) throw databaseError(error);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new DatabaseBoundaryError();
      }
      return data as Json;
    },
    provider: (config) => new ConsoleStripeProvider(config),
    random: nonce,
    now: Date.now,
    log: (entry) => console.warn(JSON.stringify(entry)),
  };
}

export function createWorkspaceStripeConnectHandler(
  overrides: Partial<WorkspaceStripeDependencies> = {},
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
      const input = object(await readJsonBody(request, 4096));
      const action = typeof input.action === "string" ? input.action : "";
      if (
        !Object.hasOwn(ACTIONS, action) ||
        Object.keys(input).length !== ACTIONS[action].length + 1 ||
        ACTIONS[action].some((key) => !Object.hasOwn(input, key))
      ) invalid();
      const workspaceId = action === "complete"
        ? ""
        : identifier(input.workspace_id);
      if (
        action === "complete" &&
        (typeof input.state !== "string" || !STATE.test(input.state) ||
          typeof input.code !== "string" || !CODE.test(input.code))
      ) invalid();

      const authorization = request.headers.get("authorization") ?? "";
      if (!/^Bearer [A-Za-z0-9._~-]{32,4096}$/.test(authorization)) {
        throw new RequestError(
          401,
          "unauthorized",
          "Sign in to manage the Stripe connection.",
        );
      }
      const { userId } = await deps.authenticate(authorization);

      // Switched off: no database call, no Stripe call, no key is read.
      if (!deps.enabled()) {
        if (action !== "status") {
          throw new RequestError(
            503,
            "console_connect_disabled",
            "Connecting Stripe is not available yet.",
          );
        }
        return jsonResponse(200, {
          enabled: false,
          workspace_id: workspaceId,
          can_manage: false,
          connection: null,
          payments: noPayments(),
        }, headers);
      }
      const config = deps.config();
      const member = { workspace_id: workspaceId, user_id: userId };
      const payments = async (workspace: string) =>
        paymentsView(
          await deps.rpc("workspace_stripe_payment_summary", {
            p_input: { workspace_id: workspace, user_id: userId },
          }),
        );

      if (action === "status") {
        const view = await deps.rpc("workspace_stripe_status", {
          p_input: member,
        });
        const connection = connectionView(view.connection);
        return jsonResponse(200, {
          enabled: true,
          workspace_id: workspaceId,
          can_manage: view.can_manage === true,
          connection,
          payments: connection ? await payments(workspaceId) : noPayments(),
        }, headers);
      }

      if (action === "start") {
        const provider = deps.provider(config);
        const state = deps.random();
        const authorizationUrl = provider.authorizationUrl(state);
        // The database decides who may start, before any call to Stripe. Only
        // the hash of the state is stored.
        await deps.rpc("begin_workspace_stripe_connect", {
          p_input: {
            ...member,
            state_sha256: await stateHash(state),
            expires_at: new Date(deps.now() + STATE_LIFETIME_MS).toISOString(),
            platform_account_id: config.platformAccountId,
          },
        });
        // The state is useless unless it is returned, and it is returned only
        // once the key is known to belong to the configured platform.
        await provider.verifyPlatform();
        return jsonResponse(
          200,
          { authorization_url: authorizationUrl },
          headers,
        );
      }

      if (action === "complete") {
        const hash = await stateHash(String(input.state));
        // The database checks the user and uses up the state BEFORE the exchange.
        const attempt = await deps.rpc("consume_workspace_stripe_oauth", {
          p_input: { state_sha256: hash, user_id: userId },
        });
        const workspace = String(attempt.workspace_id).toLowerCase();
        if (!UUID.test(workspace)) throw new DatabaseBoundaryError();
        if (attempt.platform_account_id !== config.platformAccountId) {
          throw reason("state_invalid");
        }
        const provider = deps.provider(config);
        await provider.verifyPlatform();
        // Exactly one exchange: a Stripe code is single-use and is never retried.
        const accountId = await provider.exchange(String(input.code));
        const snapshot = await provider.account(accountId);
        if (!snapshot.charges_enabled || !snapshot.details_submitted) {
          throw reason("stripe_account_not_ready");
        }
        const activated = await deps.rpc(
          "activate_workspace_stripe_connection",
          {
            p_input: {
              state_sha256: hash,
              user_id: userId,
              platform_account_id: config.platformAccountId,
              livemode: true,
              account_id: snapshot.account_id,
              business_name: snapshot.business_name,
              country: snapshot.country,
              charges_enabled: snapshot.charges_enabled,
              payouts_enabled: snapshot.payouts_enabled,
              details_submitted: snapshot.details_submitted,
            },
          },
        );
        const connection = connectionView(activated.connection);
        if (!connection) throw new DatabaseBoundaryError();
        // The account is connected from here on. A failure to count payments
        // must not turn that into an error for the merchant.
        let seen = noPayments();
        try {
          seen = await payments(workspace);
        } catch {
          deps.log({
            event: "workspace_stripe_payment_summary_unavailable",
            request_id: rid,
          });
        }
        return jsonResponse(200, {
          enabled: true,
          workspace_id: workspace,
          can_manage: true,
          connection,
          payments: seen,
        }, headers);
      }

      // disconnect
      const revoked = await deps.rpc("disconnect_workspace_stripe", {
        p_input: member,
      });
      const body: Json = {
        enabled: true,
        workspace_id: workspaceId,
        can_manage: true,
        connection: null,
        payments: noPayments(),
      };
      if (typeof revoked.account_id === "string") {
        // The local revoke stands whatever Stripe answers. One attempt.
        let deauthorized = false;
        let failure = "other_platform";
        if (revoked.platform_account_id === config.platformAccountId) {
          try {
            await deps.provider(config).deauthorize(revoked.account_id);
            deauthorized = true;
          } catch (error) {
            failure = error instanceof RequestError ? error.code : "unexpected";
          }
        }
        if (!deauthorized) {
          deps.log({
            event: "workspace_stripe_deauthorize_failed",
            request_id: rid,
            workspace_id: workspaceId,
            reason: failure,
          });
        }
        body.stripe_deauthorized = deauthorized;
      }
      return jsonResponse(200, body, headers);
    } catch (error) {
      return errorResponse(error, rid, headers);
    }
  };
}
export const handleWorkspaceStripeConnect =
  createWorkspaceStripeConnectHandler();
if (import.meta.main) Deno.serve(handleWorkspaceStripeConnect);
