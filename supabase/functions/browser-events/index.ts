import { productionOriginsWithExtra } from "../_shared/env.ts";
import { RequestError } from "../_shared/errors.ts";
import {
  corsHeaders,
  errorResponse,
  jsonResponse,
  readJsonBody,
  requestId,
  requireMethod,
  securityHeaders,
} from "../_shared/http.ts";
import { ingestBrowserEvent } from "../_shared/rpc.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { validateBrowserEvent } from "../_shared/validation.ts";

function acceptedOrigin(request: Request): string {
  const origin = request.headers.get("origin")?.trim();
  if (
    !origin ||
    !productionOriginsWithExtra("BROWSER_EVENT_ALLOWED_ORIGINS").has(origin)
  ) {
    throw new RequestError(
      403,
      "origin_not_allowed",
      "Request origin is not allowed.",
    );
  }
  return origin;
}

export async function handleBrowserEvent(request: Request): Promise<Response> {
  const id = requestId(request);
  let responseCors: HeadersInit = {};
  try {
    requireMethod(request, ["POST", "OPTIONS"]);
    const origin = acceptedOrigin(request);
    responseCors = corsHeaders(origin);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: securityHeaders(responseCors),
      });
    }
    const input = validateBrowserEvent(await readJsonBody(request, 16 * 1024));
    const receipt = await ingestBrowserEvent(serviceClient(), input);
    return jsonResponse(
      200,
      {
        accepted: true,
        event_id: receipt.eventId,
        duplicate: receipt.duplicate,
        request_id: id,
      },
      { ...responseCors, "X-Request-ID": id },
    );
  } catch (error) {
    return errorResponse(error, id, { ...responseCors, "X-Request-ID": id });
  }
}

if (import.meta.main) Deno.serve(handleBrowserEvent);
