import {
  parseFunnelSignatureHeaders,
  verifyFunnelSignature,
} from "../_shared/crypto.ts";
import {
  type FunnelKeyBinding,
  funnelMetricKeyBindings,
  funnelSigningSecrets,
} from "../_shared/env.ts";
import { DatabaseBoundaryError, RequestError } from "../_shared/errors.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireJsonContentType,
  requireMethod,
} from "../_shared/http.ts";
import { assertFunnelRequestScope } from "../_shared/rpc.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { type FunnelMetricEvent, validateMetricEvent } from "./contract.ts";
export interface JourneyClickContext {
  click_id: string;
  link_id: string;
  product_id: string;
  funnel_id: string;
  environment: "test" | "live";
}
export interface MetricEventDependencies {
  resolve: (
    product: string,
    funnel: string,
    click: string,
  ) => Promise<JourneyClickContext>;
  bindings: () => ReadonlyMap<string, FunnelKeyBinding>;
  authorize: (
    key: string,
    click: string,
    product: string,
    funnel: string,
  ) => Promise<void>;
  ingest: (
    product: string,
    funnel: string,
    event: FunnelMetricEvent,
  ) => Promise<{ event_id: string; duplicate: boolean }>;
}
export function createFunnelMetricEventHandler(
  overrides: Partial<MetricEventDependencies> = {},
) {
  const deps: MetricEventDependencies = {
    bindings: funnelMetricKeyBindings,
    resolve: async (product, funnel, click) => {
      const { data, error } = await serviceClient().rpc(
        "resolve_funnel_journey_click",
        {
          p_product_id: product,
          p_funnel_id: funnel,
          p_click_id: click,
        },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return data;
    },
    authorize: (key, click, product, funnel) =>
      assertFunnelRequestScope(serviceClient(), key, click, product, funnel),
    ingest: async (product, funnel, event) => {
      const { data, error } = await serviceClient().rpc(
        "ingest_funnel_metric_event",
        { p_product_id: product, p_funnel_id: funnel, p_event: event },
      );
      if (error) {
        if (["22023", "23505"].includes(error.code)) {
          throw new RequestError(
            409,
            "metric_event_conflict",
            "Check the event version, environment, identity and immutable evidence.",
          );
        }
        throw new DatabaseBoundaryError(error.code);
      }
      return data;
    },
    ...overrides,
  };
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
      const bytes = await readRequestBytes(request, 8192);
      const sig = parseFunnelSignatureHeaders(request.headers);
      const bindings = deps.bindings();
      await verifyFunnelSignature(bytes, sig, funnelSigningSecrets(bindings));
      let raw: unknown;
      try {
        raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new RequestError(
          400,
          "invalid_json",
          "A JSON metric event is required.",
        );
      }
      const binding = bindings.get(sig.keyId)!;
      if (
        typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
        "operation" in raw
      ) {
        const input = raw as Record<string, unknown>;
        if (
          input.operation !== "resolve_click" ||
          Object.keys(input).length !== 2 ||
          typeof input.click_id !== "string" ||
          !/^[A-Za-z0-9_-]{16,128}$/.test(input.click_id)
        ) {
          throw new RequestError(
            400,
            "invalid_context_request",
            "A scoped click reference is required.",
          );
        }
        await deps.authorize(
          sig.keyId,
          input.click_id,
          binding.productId,
          binding.funnelId,
        );
        const context = await deps.resolve(
          binding.productId,
          binding.funnelId,
          input.click_id,
        );
        return jsonResponse(200, { accepted: true, context, request_id: id }, {
          "X-Request-ID": id,
        });
      }
      const input = validateMetricEvent(raw);
      await deps.authorize(
        sig.keyId,
        input.click_id,
        binding.productId,
        binding.funnelId,
      );
      const receipt = await deps.ingest(
        binding.productId,
        binding.funnelId,
        input,
      );
      return jsonResponse(200, { accepted: true, ...receipt, request_id: id }, {
        "X-Request-ID": id,
      });
    } catch (error) {
      return errorResponse(error, id, { "X-Request-ID": id });
    }
  };
}
export const handleFunnelMetricEvent = createFunnelMetricEventHandler();
if (import.meta.main) Deno.serve(handleFunnelMetricEvent);
