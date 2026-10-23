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
import {
  type Json,
  type MerchantBinding,
  merchantBindings,
  merchantOrigins,
  MerchantProvider,
  object,
} from "./provider.ts";

import {
  deriveInvitationToken,
  type InvitationEnvelope,
  type InvitationMailConfig,
  invitationMailConfig,
  type InvitationMailOutcome,
  renderInvitationEmail,
  sendInvitationEmail,
} from "./invitation-email.ts";

import {
  type InvitationOtpOutcome,
  sendInvitationOtp,
} from "./invitation-otp.ts";

export interface MerchantIdentity {
  userId: string;
}
export interface MerchantDependencies {
  bindings: () => Map<string, MerchantBinding>;
  origins: () => Set<string>;
  authenticate: (authorization: string) => Promise<MerchantIdentity>;
  rpc: (name: string, args: Json, authorization?: string) => Promise<Json>;
  provider: (binding: MerchantBinding) => MerchantProvider;
  random: () => string;
  now: () => number;
  otpSend: (
    email: string,
    recipientOrigin: string,
  ) => Promise<InvitationOtpOutcome>;
  mailConfig: () => InvitationMailConfig;
  mailSend: (
    envelope: InvitationEnvelope,
    idempotencyKey: string,
  ) => Promise<InvitationMailOutcome>;
}
export async function tokenHash(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function nonce() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ADMIN_ACTIONS = new Set([
  "status",
  "create_invitation",
  "resend_invitation",
  "get_invitation_link",
  "assign_product",
  "revoke",
]);
const ACTIONS: Record<string, readonly string[]> = {
  status: [],
  request_invitation_code: ["invite_token", "request_id"],
  create_invitation: [
    "binding_id",
    "business_name",
    "email",
    "merchant_id",
    "request_id",
  ],
  resend_invitation: ["invitation_id", "request_id"],
  get_invitation_link: ["invitation_id"],
  assign_product: ["product_id", "merchant_id", "livemode"],
  revoke: ["merchant_id", "livemode"],
  inspect_invitation: ["invite_token"],
  start_connection: ["invite_token"],
  complete_connection: ["state", "code"],
  connection_status: ["invitation_id"],
  refresh_connection: ["invitation_id"],
  confirm_connection: ["invitation_id"],
};
function invalid(): never {
  throw new RequestError(400, "invalid_input", "Check the connection details.");
}
function identifier(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) invalid();
  return String(value).toLowerCase();
}
function token(value: unknown) {
  if (typeof value !== "string" || !TOKEN.test(value)) invalid();
  return String(value);
}
function defaults(): MerchantDependencies {
  return {
    bindings: merchantBindings,
    origins: merchantOrigins,
    authenticate: async (authorization) => {
      const { data, error } = await authenticatedClient(authorization).auth
        .getUser(authorization.slice(7));
      if (
        error || !data.user || data.user.is_anonymous ||
        !data.user.email_confirmed_at || !data.user.email
      ) {
        throw new RequestError(
          401,
          "verified_email_required",
          "Sign in with your verified invitation email.",
        );
      }
      return { userId: data.user.id };
    },
    rpc: async (name, args, authorization) => {
      const client = authorization
        ? authenticatedClient(authorization)
        : serviceClient();
      const { data, error } = await client.rpc(name, args);
      if (error) {
        if (["42501", "28000", "P0002"].includes(error.code)) {
          throw new RequestError(
            403,
            "merchant_access_denied",
            "This invitation or connection is unavailable for this signed-in account. It may have expired or been used.",
          );
        }
        if (
          ["22023", "23505", "23514", "P0001", "55000"].includes(error.code)
        ) {
          throw new RequestError(
            409,
            "merchant_connection_conflict",
            "The connection could not be changed. Refresh its status or ask the administrator for a new invitation.",
          );
        }
        throw new DatabaseBoundaryError(error.code);
      }
      return object(data);
    },
    provider: (binding) => new MerchantProvider(binding),
    random: nonce,
    now: Date.now,
    otpSend: sendInvitationOtp,
    mailConfig: invitationMailConfig,
    mailSend: sendInvitationEmail,
  };
}
export function createMerchantConnectHandler(
  overrides: Partial<MerchantDependencies> = {},
) {
  const deps = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    let headers: Record<string, string> = {};
    try {
      requireMethod(request, ["POST", "OPTIONS"]);
      const origin = request.headers.get("origin") ?? "";
      if (!deps.origins().has(origin)) {
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
        Vary: "Origin",
      };
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: securityHeaders(headers),
        });
      }
      const input = object(await readJsonBody(request, 4096));
      const action = String(input.action);
      if (
        !Object.hasOwn(ACTIONS, action) ||
        Object.keys(input).some((k) =>
          k !== "action" && !ACTIONS[action].includes(k)
        )
      ) invalid();
      const auth = request.headers.get("authorization") ?? "";
      let identity: MerchantIdentity | null = null;
      // Only a high-entropy invitation token can initiate the public code send.
      // Every other action retains the existing verified-user authentication.
      if (action !== "request_invitation_code") {
        if (!/^Bearer [A-Za-z0-9._~-]{32,4096}$/.test(auth)) {
          throw new RequestError(
            401,
            "unauthorized",
            "Sign in to manage a merchant connection.",
          );
        }
        identity = await deps.authenticate(auth);
      }
      const bindings = deps.bindings();
      const adminAction = ADMIN_ACTIONS.has(action);
      const configured = [...bindings.values()].filter((b) =>
        adminAction
          ? (b.adminOrigins ?? [b.origin]).includes(origin)
          : b.origin === origin
      );
      // CORS is only the outer allowlist. Each action still needs its own
      // configured portal, and admin RPCs continue to check the signed-in role.
      // Preserve the authenticated disabled-status response when no binding exists.
      if (!configured.length && (action !== "status" || bindings.size > 0)) {
        throw new RequestError(
          403,
          "origin_rejected",
          "This action is not configured for this site.",
        );
      }
      const findBinding = (context: Json) => {
        const b = configured.find((b) =>
          b.platformAccountId === context.platform_account_id &&
          b.livemode === context.livemode
        );
        if (!b) {
          throw new RequestError(
            503,
            "merchant_binding_unavailable",
            "This merchant connection is not configured for this site.",
          );
        }
        return b;
      };
      const result = (body: Json) =>
        jsonResponse(200, { ...body, request_id: rid }, headers);
      if (action === "request_invitation_code") {
        const hash = await tokenHash(token(input.invite_token));
        const requestId = identifier(input.request_id);
        let context: Json;
        try {
          context = await deps.rpc("merchant_invitation_context", {
            p_token_sha256: hash,
          });
        } catch (error) {
          if (error instanceof RequestError && error.status === 403) {
            throw new RequestError(
              403,
              "invitation_unavailable",
              "This invitation is unavailable. Ask your KMA administrator for a new link.",
            );
          }
          throw error;
        }
        if (!["invited", "claimed"].includes(String(context.status))) {
          throw new RequestError(
            403,
            "invitation_unavailable",
            "This invitation is unavailable. Ask your KMA administrator for a new link.",
          );
        }
        const binding = findBinding(context);
        let pending: Json;
        try {
          pending = await deps.rpc("prepare_merchant_invitation_code", {
            p_token_sha256: hash,
            p_request_id: requestId,
            p_recipient_origin: binding.origin,
          });
        } catch (error) {
          if (
            error instanceof RequestError && [403, 409].includes(error.status)
          ) {
            throw new RequestError(
              403,
              "invitation_unavailable",
              "This invitation is unavailable. Ask your KMA administrator for a new link.",
            );
          }
          throw error;
        }
        let response = pending;
        if (pending.send === true) {
          let outcome: InvitationOtpOutcome;
          try {
            outcome = await deps.otpSend(String(pending.email), binding.origin);
          } catch {
            outcome = { status: "unknown" };
          }
          try {
            response = await deps.rpc("finish_merchant_invitation_code", {
              p_request_id: requestId,
              p_lease_id: pending.lease_id,
              p_status: outcome.status,
            });
          } catch {
            response = { ...pending, status: "unknown" };
          }
        }
        // Never return token hashes, lease IDs, account metadata or Auth secrets.
        return result({
          email: response.email,
          expires_at: response.expires_at,
          status: response.status,
          retry_at: response.retry_at,
        });
      }
      if (!identity) {
        throw new RequestError(
          401,
          "unauthorized",
          "Sign in to manage a merchant connection.",
        );
      }
      if (action === "status") {
        const workspace = await deps.rpc(
          "get_admin_merchant_connections",
          {},
          auth,
        );
        return result({
          enabled: configured.length > 0,
          bindings: configured.map((b) => ({
            id: b.id,
            platform_account_id: b.platformAccountId,
            livemode: b.livemode,
            provider_enabled: b.providerEnabled,
          })),
          workspace,
        });
      }
      const invitationResult = async (
        invite: Json,
        b: MerchantBinding,
        sendRequestId?: string,
      ) => {
        const config = deps.mailConfig();
        if (
          !["invited", "claimed"].includes(String(invite.status)) ||
          !invite.token_request_id || !invite.token_key_id
        ) {
          throw new RequestError(
            409,
            "invitation_unavailable",
            "Create a new invitation. This link is expired, already used, revoked or cannot be recovered.",
          );
        }
        const raw = await deriveInvitationToken(
          config,
          String(invite.token_key_id),
          String(invite.token_request_id),
        );
        if (await tokenHash(raw) !== invite.token_sha256) {
          throw new DatabaseBoundaryError();
        }
        const invitationUrl = `${b.origin}/merchant/connect#invite=${raw}`;
        let delivery = object(invite.delivery);
        if (!config.enabled) {
          delivery = { ...delivery, status: "disabled", can_retry: false };
        } else if (sendRequestId) {
          let fields: Json = {
            template_version: 1,
            from: config.from,
            to: invite.email,
            business_name: invite.business_name,
            expires_at: invite.expires_at,
            origin: b.origin,
          };
          let envelope = renderInvitationEmail(fields, invitationUrl);
          const prepare = (f: Json, e: InvitationEnvelope) =>
            tokenHash(JSON.stringify(e)).then((sha) =>
              deps.rpc("prepare_admin_merchant_invitation_email", {
                p_input: {
                  invitation_id: invite.invitation_id,
                  request_id: sendRequestId,
                  envelope_fields: f,
                  envelope_sha256: sha,
                },
              }, auth)
            );
          let pending = await prepare(fields, envelope);
          if (pending.needs_frozen_envelope === true) {
            fields = object(pending.envelope_fields);
            // Origin is frozen; only a still-configured recipient origin can be used.
            if (fields.origin !== b.origin) {
              throw new RequestError(
                409,
                "invitation_origin_changed",
                "Create a new invitation for the current merchant portal.",
              );
            }
            envelope = renderInvitationEmail(fields, invitationUrl);
            if (
              await tokenHash(JSON.stringify(envelope)) !==
                pending.envelope_sha256
            ) {
              throw new RequestError(
                409,
                "invitation_template_changed",
                "Create a new invitation to send this email.",
              );
            }
            pending = await prepare(fields, envelope);
          }
          delivery = object(pending.delivery);
          if (pending.send === true) {
            // One bounded provider request. A lost response remains unknown; retries
            // reuse the same durable operation, envelope and provider key.
            let outcome: InvitationMailOutcome;
            try {
              outcome = await deps.mailSend(
                envelope,
                String(pending.idempotency_key),
              );
            } catch {
              outcome = {
                status: "unknown",
                error_code: "provider_response_unknown",
              };
            }
            try {
              delivery = await deps.rpc("finish_merchant_invitation_email", {
                p_input: {
                  delivery_id: pending.delivery_id,
                  lease_id: pending.lease_id,
                  ...outcome,
                },
              });
            } catch {
              delivery = { ...delivery, status: "unknown", can_retry: false };
            }
          }
        }
        return {
          invitation_id: invite.invitation_id,
          merchant_id: invite.merchant_id,
          expires_at: invite.expires_at,
          status: invite.status,
          invitation_url: invitationUrl,
          delivery,
        };
      };
      if (action === "resend_invitation" || action === "get_invitation_link") {
        const sendId = action === "resend_invitation"
          ? identifier(input.request_id)
          : undefined;
        const invite = await deps.rpc(
          "get_admin_merchant_invitation_delivery",
          { p_invitation_id: identifier(input.invitation_id) },
          auth,
        );
        return result(
          await invitationResult(invite, findBinding(invite), sendId),
        );
      }
      if (action === "create_invitation") {
        const b = bindings.get(String(input.binding_id));
        if (!b || !configured.includes(b)) {
          throw new RequestError(
            503,
            "merchant_binding_unavailable",
            "Choose a configured connection mode.",
          );
        }
        if (
          typeof input.business_name !== "string" ||
          input.business_name.trim().length < 2 ||
          input.business_name.length > 160 ||
          typeof input.email !== "string" || input.email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
        ) invalid();
        const operationId = identifier(input.request_id);
        const config = deps.mailConfig();
        const raw = await deriveInvitationToken(
          config,
          config.activeKeyId,
          operationId,
        );
        const invite = await deps.rpc("create_admin_merchant_invitation_v2", {
          p_input: {
            request_id: operationId,
            key_id: config.activeKeyId,
            business_name: input.business_name.trim(),
            email: input.email.trim().toLowerCase(),
            platform_account_id: b.platformAccountId,
            livemode: b.livemode,
            token_sha256: await tokenHash(raw),
            expires_at: new Date(deps.now() + 7 * 86400000).toISOString(),
            ...(input.merchant_id
              ? { merchant_id: identifier(input.merchant_id) }
              : {}),
          },
        }, auth);
        return result(await invitationResult(invite, b, operationId));
      }
      if (action === "assign_product" || action === "revoke") {
        if (typeof input.livemode !== "boolean") invalid();
        if (!configured.some((b) => b.livemode === input.livemode)) {
          throw new RequestError(
            503,
            "merchant_binding_unavailable",
            "Choose a configured connection mode.",
          );
        }
        const p_input: Json = {
          merchant_id: identifier(input.merchant_id),
          livemode: input.livemode,
        };
        if (action === "assign_product") {
          p_input.product_id = identifier(input.product_id);
        }
        const connection = await deps.rpc(
          action === "assign_product"
            ? "assign_admin_product_merchant"
            : "revoke_admin_merchant_connection",
          { p_input },
          auth,
        );
        return result({ connection });
      }
      if (action === "inspect_invitation" || action === "start_connection") {
        const context = await deps.rpc("claim_merchant_invitation", {
          p_input: {
            token_sha256: await tokenHash(token(input.invite_token)),
            user_id: identity.userId,
          },
        });
        const b = findBinding(context);
        if (action === "inspect_invitation") {
          return result({ invitation: context });
        }
        const provider = deps.provider(b),
          state = deps.random();
        // Check the external-call gate before creating a new one-use state.
        const authorizationUrl = provider.authorizationUrl(state);
        await provider.verifyPlatform();
        await deps.rpc("begin_merchant_oauth", {
          p_input: {
            invitation_id: identifier(context.invitation_id),
            user_id: identity.userId,
            state_sha256: await tokenHash(state),
            expires_at: new Date(
              Math.min(
                deps.now() + 10 * 60000,
                typeof context.expires_at === "string"
                  ? Date.parse(context.expires_at)
                  : deps.now() + 10 * 60000,
              ),
            ).toISOString(),
          },
        });
        return result({ authorization_url: authorizationUrl });
      }
      if (action === "complete_connection") {
        const stateHash = await tokenHash(token(input.state));
        if (
          typeof input.code !== "string" ||
          !/^ac_[A-Za-z0-9_]{8,500}$/.test(input.code)
        ) invalid();
        // The database checks the authenticated claimant and atomically consumes state BEFORE exchange.
        const context = await deps.rpc("consume_merchant_oauth", {
          p_input: { state_sha256: stateHash, user_id: identity.userId },
        });
        const b = findBinding(context), provider = deps.provider(b);
        await provider.verifyPlatform();
        const accountId = await provider.exchange(input.code);
        const candidate = await provider.account(accountId);
        await deps.rpc("record_merchant_connection_candidate", {
          p_input: {
            ...candidate,
            state_sha256: stateHash,
            platform_account_id: b.platformAccountId,
            livemode: b.livemode,
            provider_verified_at: new Date(deps.now()).toISOString(),
          },
        });
        const invitationId = identifier(context.invitation_id);
        const connection = await deps.rpc("merchant_connection_status", {
          p_input: { invitation_id: invitationId, user_id: identity.userId },
        });
        return result({ invitation_id: invitationId, connection });
      }
      const invitationId = identifier(input.invitation_id);
      let connection = await deps.rpc("merchant_connection_status", {
        p_input: { invitation_id: invitationId, user_id: identity.userId },
      });
      const b = findBinding(connection);
      if (action === "refresh_connection") {
        if (connection.status === "connected") return result({ connection });
        const candidate = object(connection.candidate);
        const provider = deps.provider(b);
        await provider.verifyPlatform();
        const snapshot = await provider.account(String(candidate.account_id));
        connection = await deps.rpc("refresh_merchant_connection_candidate", {
          p_input: {
            invitation_id: invitationId,
            user_id: identity.userId,
            ...snapshot,
            provider_verified_at: new Date(deps.now()).toISOString(),
          },
        });
      }
      if (action === "confirm_connection") {
        if (connection.status === "connected") return result({ connection });
        const candidate = object(connection.candidate);
        const provider = deps.provider(b);
        // Refresh the actual selected account immediately before making it usable.
        await provider.verifyPlatform();
        const snapshot = await provider.account(String(candidate.account_id));
        if (
          !snapshot.charges_enabled || !snapshot.payouts_enabled ||
          !snapshot.details_submitted
        ) {
          throw new RequestError(
            409,
            "merchant_account_incomplete",
            "Finish the account requirements in Stripe before confirming this merchant.",
          );
        }
        await deps.rpc("refresh_merchant_connection_candidate", {
          p_input: {
            invitation_id: invitationId,
            user_id: identity.userId,
            ...snapshot,
            provider_verified_at: new Date(deps.now()).toISOString(),
          },
        });
        connection = await deps.rpc("confirm_merchant_connection", {
          p_input: {
            invitation_id: invitationId,
            user_id: identity.userId,
            account_id: snapshot.account_id,
          },
        });
      }
      return result({ connection });
    } catch (error) {
      return errorResponse(error, rid, headers);
    }
  };
}
export const handleMerchantConnect = createMerchantConnectHandler();
if (import.meta.main) Deno.serve(handleMerchantConnect);
