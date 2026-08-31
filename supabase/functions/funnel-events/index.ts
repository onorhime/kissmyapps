import {
  parseFunnelSignatureHeaders,
  verifyFunnelSignature,
} from "../_shared/crypto.ts";
import {
  configuredNames,
  type FunnelKeyBinding,
  funnelKeyBindings,
  funnelSigningSecrets,
  optionalConfiguredNames,
} from "../_shared/env.ts";
import { RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireJsonContentType,
  requireMethod,
} from "../_shared/http.ts";
import {
  assertFunnelRequestScope,
  type EventReceipt,
  ingestFunnelEvent,
} from "../_shared/rpc.ts";
import { serviceClient } from "../_shared/supabase.ts";
import {
  type CanonicalEventInput,
  validateFunnelEvent,
} from "../_shared/validation.ts";

export interface FunnelEventDependencies {
  bindings: () => ReadonlyMap<string, FunnelKeyBinding>;
  allowedNames: () => ReadonlySet<string>;
  allowedProperties: () => ReadonlySet<string>;
  authorizeScope: (
    keyId: string,
    clickId: string,
    productId: string,
    funnelId: string,
  ) => Promise<void>;
  ingest: (input: CanonicalEventInput) => Promise<EventReceipt>;
}

function defaultDependencies(): FunnelEventDependencies {
  return {
    bindings: funnelKeyBindings,
    allowedNames: () => configuredNames("FUNNEL_EVENT_ALLOWED_NAMES"),
    allowedProperties: () =>
      optionalConfiguredNames("FUNNEL_EVENT_ALLOWED_PROPERTIES"),
    authorizeScope: (keyId, clickId, productId, funnelId) =>
      assertFunnelRequestScope(
        serviceClient(),
        keyId,
        clickId,
        productId,
        funnelId,
      ),
    ingest: (input) => ingestFunnelEvent(serviceClient(), input),
  };
}

function decodeJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) {
    throw new RequestError(
      400,
      "empty_body",
      "A JSON request body is required.",
    );
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError(
      400,
      "invalid_json",
      "Request body must be valid JSON.",
    );
  }
}

export function createFunnelEventHandler(
  overrides: Partial<FunnelEventDependencies> = {},
): (request: Request) => Promise<Response> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      if (request.headers.has("origin")) {
        throw new RequestError(
          403,
          "browser_request_rejected",
          "Server authentication is required.",
        );
      }
      requireJsonContentType(request);
      const bytes = await readRequestBytes(request, 32 * 1024);
      const signature = parseFunnelSignatureHeaders(request.headers);
      const bindings = dependencies.bindings();
      await verifyFunnelSignature(
        bytes,
        signature,
        funnelSigningSecrets(bindings),
      );
      const input = validateFunnelEvent(
        decodeJson(bytes),
        dependencies.allowedNames(),
        dependencies.allowedProperties(),
      );
      const binding = bindings.get(signature.keyId);
      if (!binding) {
        throw new RequestError(
          401,
          "invalid_signature",
          "Request authentication failed.",
        );
      }
      await dependencies.authorizeScope(
        signature.keyId,
        input.click_id,
        binding.productId,
        binding.funnelId,
      );
      const receipt = await dependencies.ingest(input);
      return jsonResponse(
        200,
        {
          accepted: true,
          event_id: receipt.eventId,
          duplicate: receipt.duplicate,
          request_id: id,
        },
        { "X-Request-ID": id },
      );
    } catch (error) {
      return errorResponse(error, id, { "X-Request-ID": id });
    }
  };
}

export const handleFunnelEvent = createFunnelEventHandler();

if (import.meta.main) Deno.serve(handleFunnelEvent);
