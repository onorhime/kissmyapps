import {
  ConfigurationError,
  DatabaseBoundaryError,
  NotFoundError,
  RequestError,
} from "./errors.ts";

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function securityHeaders(
  extra: HeadersInit = {},
): Headers {
  const headers = new Headers(BASE_HEADERS);
  const additions = new Headers(extra);
  additions.forEach((value, key) => headers.set(key, value));
  return headers;
}

export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: securityHeaders(extraHeaders),
  });
}

export function errorResponse(
  error: unknown,
  requestId: string,
  extraHeaders: HeadersInit = {},
): Response {
  if (error instanceof RequestError) {
    const responseHeaders = new Headers(extraHeaders);
    if (error.status === 429 && !responseHeaders.has("Retry-After")) {
      responseHeaders.set("Retry-After", "60");
    }
    return jsonResponse(
      error.status,
      { error: error.code, message: error.message, request_id: requestId },
      responseHeaders,
    );
  }
  if (error instanceof NotFoundError) {
    return jsonResponse(
      404,
      {
        error: error.code,
        message: "The requested resource is unavailable.",
        request_id: requestId,
      },
      extraHeaders,
    );
  }
  if (error instanceof ConfigurationError) {
    return jsonResponse(
      503,
      {
        error: error.code,
        message: "The service is not configured.",
        request_id: requestId,
      },
      extraHeaders,
    );
  }
  if (error instanceof DatabaseBoundaryError) {
    return jsonResponse(
      503,
      {
        error: error.code,
        message: "The service is temporarily unavailable.",
        request_id: requestId,
      },
      extraHeaders,
    );
  }
  return jsonResponse(
    500,
    {
      error: "internal_error",
      message: "The service could not complete the request.",
      request_id: requestId,
    },
    extraHeaders,
  );
}

export function requireMethod(
  request: Request,
  allowed: readonly string[],
): void {
  if (!allowed.includes(request.method)) {
    throw new RequestError(405, "method_not_allowed", "Method not allowed.");
  }
}

export function requireJsonContentType(request: Request): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]
    ?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new RequestError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }
}

export async function readRequestBytes(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new RequestError(
        400,
        "invalid_content_length",
        "Invalid request body.",
      );
    }
    if (parsedLength > maximumBytes) {
      throw new RequestError(
        413,
        "payload_too_large",
        "Request body is too large.",
      );
    }
  }

  if (request.body === null) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new RequestError(
        413,
        "payload_too_large",
        "Request body is too large.",
      );
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJsonBody(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  requireJsonContentType(request);
  const bytes = await readRequestBytes(request, maximumBytes);
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

export function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Headers": "content-type, x-kma-session-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function requestId(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  if (supplied && /^[A-Za-z0-9_-]{8,80}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}
