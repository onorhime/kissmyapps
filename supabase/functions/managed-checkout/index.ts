import {
  parseFunnelSignatureHeaders,
  verifyFunnelSignature,
} from "../_shared/crypto.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireJsonContentType,
  requireMethod,
} from "../_shared/http.ts";
import {
  type ManagedBinding,
  managedBindings,
  reject,
  validateInput,
} from "./contract.ts";
import { ManagedProvider } from "./provider.ts";
import {
  databaseStore,
  ManagedCheckoutService,
  type ManagedStore,
  resolveManagedBinding,
} from "./service.ts";
export interface ManagedCheckoutDependencies {
  bindings: () => Map<string, ManagedBinding>;
  enabled: () => boolean;
  store: ManagedStore;
  provider: (binding: ManagedBinding) => ManagedProvider;
  now: () => number;
}
export function managedDefaults(): ManagedCheckoutDependencies {
  return {
    bindings: managedBindings,
    enabled: () => Deno.env.get("MANAGED_CHECKOUT_ENABLED") === "true",
    store: databaseStore(),
    provider: (b) => new ManagedProvider(b),
    now: Date.now,
  };
}
export function createManagedCheckoutHandler(
  overrides: Partial<ManagedCheckoutDependencies> = {},
) {
  const deps = { ...managedDefaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      requireJsonContentType(request);
      if (request.headers.has("origin")) {
        reject(
          "browser_request_rejected",
          "Server authentication is required.",
          403,
        );
      }
      const bytes = await readRequestBytes(request, 24 * 1024),
        signature = parseFunnelSignatureHeaders(request.headers),
        bindings = deps.bindings();
      await verifyFunnelSignature(
        bytes,
        signature,
        new Map([...bindings].map(([key, b]) => [key, b.secret])),
        Math.floor(deps.now() / 1000),
      );
      const binding = bindings.get(signature.keyId)!;
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        reject("invalid_json", "A JSON request is required.");
      }
      const input = validateInput(parsed, binding, deps.now());
      if (
        (input.action === "quote" || input.action === "create") &&
        !deps.enabled()
      ) {
        reject("checkout_not_enabled", "Checkout is disabled.", 503);
      }
      const effective = await resolveManagedBinding(deps.store, binding, input);
      const output = await new ManagedCheckoutService(
        deps.store,
        deps.provider(effective),
        deps.enabled(),
      ).execute(input);
      return jsonResponse(200, { ...output, request_id: rid }, {
        "X-Request-ID": rid,
      });
    } catch (error) {
      return errorResponse(error, rid, { "X-Request-ID": rid });
    }
  };
}
export const handleManagedCheckout = createManagedCheckoutHandler();
if (import.meta.main) Deno.serve(handleManagedCheckout);
