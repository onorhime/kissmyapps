import { constantTimeEqualStrings } from "./crypto.ts";
import { requiredSecret } from "./env.ts";
import { RequestError } from "./errors.ts";
import {
  errorResponse,
  jsonResponse,
  requestId,
  requireMethod,
} from "./http.ts";

function authenticateWorker(request: Request): void {
  const expected = requiredSecret("INTERNAL_WORKER_SECRET");
  const supplied = request.headers.get("x-kma-worker-secret") ?? "";
  if (!supplied || !constantTimeEqualStrings(expected, supplied)) {
    throw new RequestError(
      401,
      "unauthorized",
      "Worker authentication failed.",
    );
  }
}

export function foundationWorker(
  worker: string,
): (request: Request) => Response {
  return (request: Request): Response => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      authenticateWorker(request);
      return jsonResponse(200, {
        status: "foundation_idle",
        worker,
        processed: 0,
        mutation_enabled: false,
        request_id: id,
      });
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}
