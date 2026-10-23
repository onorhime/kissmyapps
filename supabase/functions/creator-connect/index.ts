import {
  type CreatorAuthentication,
  requireRecentCreatorAuthentication,
  verifiedCreatorAuthentication,
} from "./auth-policy.ts";
import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readJsonBody,
  requestId,
  requireMethod,
} from "../_shared/http.ts";
import { authenticatedClient, serviceClient } from "../_shared/supabase.ts";
import {
  type AccountSnapshot,
  connectBindings,
  type ConnectConfig,
  ConnectProvider,
  object,
} from "./provider.ts";
import { accountCreationPrefill } from "./prefill.ts";

export interface CreatorContext {
  affiliate_id: string;
  connect_account_id: string | null;
  account_key: string;
  platform_account_id: string;
  livemode: boolean;
  created_at: string;
}
export interface ConnectDependencies {
  bindings: () => Map<string, ConnectConfig>;
  authenticate: (authorization: string) => Promise<CreatorAuthentication>;
  context: (
    authorization: string,
    config: ConnectConfig,
  ) => Promise<CreatorContext | null>;
  reserve: (
    context: CreatorContext,
    country: string,
    actorUserId: string,
  ) => Promise<{
    country: string;
    first_account_attempt_at: string;
    account_creation_prefill?: unknown;
  }>;
  persist: (
    context: CreatorContext,
    snapshot: AccountSnapshot,
    verifiedAt: string,
  ) => Promise<void>;
  provider: (config: ConnectConfig) => ConnectProvider;
  now: () => number;
}

function defaults(): ConnectDependencies {
  return {
    bindings: connectBindings,
    authenticate: async (authorization) => {
      const { data, error } = await authenticatedClient(authorization).auth
        .getUser(authorization.slice(7));
      if (error || !data.user) {
        throw new RequestError(
          401,
          "unauthorized",
          "Sign in to manage your creator payment account.",
        );
      }
      return verifiedCreatorAuthentication(authorization.slice(7), data.user);
    },
    context: async (authorization, config) => {
      const { data, error } = await authenticatedClient(authorization).rpc(
        "creator_connect_context",
        {
          p_platform_account_id: config.platformAccountId,
          p_livemode: config.livemode,
        },
      );
      if (error?.code === "42501" || error?.code === "P0002") return null;
      if (error) throw new DatabaseBoundaryError(error.code);
      return data;
    },
    reserve: async (context, country, actorUserId) => {
      const { data, error } = await serviceClient().rpc(
        "reserve_creator_connect_account",
        {
          p_input: {
            account_key: context.account_key,
            country,
            actor_user_id: actorUserId,
          },
        },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return data;
    },
    persist: async (context, snapshot, verifiedAt) => {
      const { error } = await serviceClient().rpc(
        "set_creator_connect_account",
        {
          p_input: {
            affiliate_id: context.affiliate_id,
            platform_account_id: context.platform_account_id,
            livemode: context.livemode,
            account_key: context.account_key,
            connect_account_id: snapshot.account_id,
            charges_enabled: snapshot.charges_enabled,
            payouts_enabled: snapshot.payouts_enabled,
            transfers_enabled: snapshot.transfers_active,
            details_submitted: snapshot.details_submitted,
            disabled_reason: snapshot.disabled_reason,
            requirements_due: snapshot.requirements_due,
            verified_at: verifiedAt,
          },
        },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
    },
    provider: (config) => new ConnectProvider(config),
    now: Date.now,
  };
}

export function createCreatorConnectHandler(
  overrides: Partial<ConnectDependencies> = {},
) {
  const deps = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    let cors: Record<string, string> = {};
    try {
      requireMethod(request, ["POST", "OPTIONS"]);
      const bindings = deps.bindings(), origin = request.headers.get("origin");
      if (origin) {
        if (
          bindings.size &&
          ![...bindings.values()].some((config) => config.origin === origin)
        ) {
          throw new RequestError(
            403,
            "origin_rejected",
            "This origin is not allowed.",
          );
        }
        cors = {
          "Access-Control-Allow-Origin": origin,
          Vary: "Origin",
          "Access-Control-Allow-Headers":
            "authorization, apikey, content-type, x-client-info",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
        };
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }
      const authorization = request.headers.get("authorization") ?? "";
      if (!/^Bearer \S+$/i.test(authorization)) {
        throw new RequestError(
          401,
          "unauthorized",
          "Sign in to manage your creator payment account.",
        );
      }
      const authentication = await deps.authenticate(authorization);
      const input = object(await readJsonBody(request, 2048));
      if (
        Object.keys(input).some((key) =>
          !["action", "binding_id", "country"].includes(key)
        ) || !["status", "session"].includes(String(input.action)) ||
        (input.binding_id !== undefined &&
          (typeof input.binding_id !== "string" ||
            !/^[A-Za-z0-9_-]{1,64}$/.test(input.binding_id))) ||
        (input.country !== undefined &&
          (typeof input.country !== "string" ||
            !/^[A-Z]{2}$/.test(input.country)))
      ) {
        throw new RequestError(
          400,
          "invalid_input",
          "Choose an account action and an available funding scope.",
        );
      }
      if (!bindings.size) {
        return jsonResponse(200, { enabled: false, bindings: [] }, cors);
      }
      if (input.action !== "status" && typeof input.binding_id !== "string") {
        throw new RequestError(
          400,
          "binding_required",
          "Choose the account funding scope.",
        );
      }
      if (input.binding_id && !bindings.has(String(input.binding_id))) {
        throw new RequestError(
          403,
          "binding_unavailable",
          "This account funding scope is unavailable.",
        );
      }
      const results = [];
      let accountSession: Record<string, unknown> | undefined;
      for (const [bindingId, config] of bindings) {
        if (input.binding_id && input.binding_id !== bindingId) continue;
        if (origin && config.origin !== origin) continue;
        const context = await deps.context(authorization, config);
        if (!context) continue;
        if (
          context.platform_account_id !== config.platformAccountId ||
          context.livemode !== config.livemode
        ) throw new DatabaseBoundaryError("scope_mismatch");
        if (input.action === "session" && !config.publishableKey) {
          throw new RequestError(
            503,
            "embedded_setup_unavailable",
            "Embedded payout setup is not configured for this funding scope.",
          );
        }
        if (input.action === "session") {
          requireRecentCreatorAuthentication(authentication, deps.now());
        }
        const provider = deps.provider(config);
        let snapshot: AccountSnapshot | null = null;
        let allowedTransferCurrencies: string[] = [];
        const observedAt = new Date(deps.now()).toISOString();
        await provider.verifyPlatform();
        const eligibility = await provider.eligibility();
        const allowedCountries = eligibility.countries.map((entry) =>
          entry.country
        );
        if (context.connect_account_id || input.action !== "status") {
          let account;
          if (!context.connect_account_id) {
            if (
              typeof input.country !== "string" ||
              !allowedCountries.includes(input.country)
            ) {
              throw new RequestError(
                400,
                "country_required",
                "Choose an available country before starting onboarding.",
              );
            }
            const reservation = await deps.reserve(
              context,
              input.country,
              authentication.userId,
            );
            account = await provider.ensureAccount(
              context.affiliate_id,
              context.account_key,
              reservation.country,
              reservation.first_account_attempt_at,
              accountCreationPrefill(reservation.account_creation_prefill),
            );
            context.connect_account_id = String(account.id);
          } else account = await provider.account(context.connect_account_id);
          snapshot = provider.snapshot(
            account,
            context.connect_account_id,
            context.affiliate_id,
            context.account_key,
          );
          allowedTransferCurrencies = await provider.transferCurrencies(
            account,
          );
          await deps.persist(
            context,
            snapshot,
            observedAt,
          );
          if (input.action === "session") {
            accountSession = {
              binding_id: bindingId,
              connected_account_id: context.connect_account_id,
              platform_account_id: config.platformAccountId,
              livemode: config.livemode,
              publishable_key: config.publishableKey,
              ...await provider.onboardingSession(
                context.connect_account_id,
                context.affiliate_id,
                context.account_key,
              ),
            };
          }
        }
        const status = !snapshot
          ? "not_connected"
          : snapshot.transfers_active && snapshot.payouts_enabled &&
              !snapshot.disabled_reason &&
              snapshot.requirements_due.length === 0
          ? "ready"
          : snapshot.requirements_due.length || !snapshot.details_submitted
          ? "needs_information"
          : "pending_verification";
        results.push({
          binding_id: bindingId,
          platform_account_id: config.platformAccountId,
          livemode: config.livemode,
          allowed_countries: allowedCountries,
          eligibility,
          allowed_transfer_currencies: allowedTransferCurrencies,
          eligibility_reason: !context.connect_account_id
            ? null
            : allowedTransferCurrencies.length
            ? null
            : "A verified same-currency funding balance and recipient payout currency are required. Currency conversion has not been assumed.",
          connected_account_id: context.connect_account_id,
          status,
          details_submitted: snapshot?.details_submitted ?? false,
          transfers_enabled: snapshot?.transfers_active ?? false,
          payouts_enabled: snapshot?.payouts_enabled ?? false,
          requirements_due: snapshot?.requirements_due ?? [],
          disabled_reason: snapshot?.disabled_reason ?? null,
          verified_at: snapshot ? observedAt : null,
        });
      }
      if (input.binding_id && !results.length) {
        throw new RequestError(
          403,
          "binding_unavailable",
          "This creator cannot use the selected funding scope.",
        );
      }
      return jsonResponse(200, {
        enabled: true,
        bindings: results,
        ...(accountSession ? { account_session: accountSession } : {}),
      }, cors);
    } catch (error) {
      return errorResponse(error, id, cors);
    }
  };
}
export const handleCreatorConnect = createCreatorConnectHandler();
if (import.meta.main) Deno.serve(handleCreatorConnect);
