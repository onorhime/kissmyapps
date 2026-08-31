import { privateSignalHash, randomBase64Url } from "../_shared/crypto.ts";
import { requiredSecret } from "../_shared/env.ts";
import {
  errorResponse,
  requestId,
  requireMethod,
  securityHeaders,
} from "../_shared/http.ts";
import { registerTrackingClick } from "../_shared/rpc.ts";
import { serviceClient } from "../_shared/supabase.ts";
import {
  clientIpFromHeaders,
  countryCodeFromHeaders,
  isAutomatedRequest,
  parseTrackingRoute,
  validatedRedirectUrl,
} from "../_shared/validation.ts";

const SESSION_COOKIE = "kma_sid";

export function sessionIdFromCookie(
  cookieHeader: string | null,
): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name === SESSION_COOKIE && /^[A-Za-z0-9_-]{32,64}$/.test(value)) {
      return value;
    }
  }
  return null;
}

export async function handleTrackingRedirect(
  request: Request,
): Promise<Response> {
  const id = requestId(request);
  try {
    requireMethod(request, ["GET"]);
    const route = parseTrackingRoute(new URL(request.url).pathname);
    const hashSecret = requiredSecret("TRACKING_HASH_SECRET");
    const existingSessionId = sessionIdFromCookie(
      request.headers.get("cookie"),
    );
    const sessionId = existingSessionId ?? randomBase64Url(24);
    const userAgent = request.headers.get("user-agent")?.slice(0, 1024) ?? null;
    const ipAddress = clientIpFromHeaders(request.headers);
    const isBot = isAutomatedRequest(request.headers);
    const [sessionIdHash, userAgentHash, ipHash] = await Promise.all([
      privateSignalHash(hashSecret, "session", sessionId),
      privateSignalHash(hashSecret, "user-agent", userAgent),
      privateSignalHash(hashSecret, "ip", ipAddress),
    ]);

    const registration = await registerTrackingClick(
      serviceClient(),
      route.affiliateSlug,
      route.publicCode,
      {
        country_code: countryCodeFromHeaders(request.headers),
        session_id_hash: sessionIdHash,
        user_agent_hash: userAgentHash,
        ip_hash: ipHash,
        is_bot: isBot,
      },
    );
    const location = validatedRedirectUrl(
      registration.destinationUrl,
      registration.clickId,
    );
    const headers = securityHeaders({
      "Content-Type": "text/plain; charset=utf-8",
      Location: location,
      "X-Request-ID": id,
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    });
    if (!existingSessionId) {
      headers.set(
        "Set-Cookie",
        `${SESSION_COOKIE}=${sessionId}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax`,
      );
    }
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return errorResponse(error, id, {
      "X-Request-ID": id,
      "X-Robots-Tag": "noindex",
    });
  }
}

if (import.meta.main) Deno.serve(handleTrackingRedirect);
