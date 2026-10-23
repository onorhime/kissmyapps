import { RequestError } from "../_shared/errors.ts";

export interface CreatorAuthentication {
  userId: string;
  assuranceLevel: string;
  methods: Array<{ method: string; timestamp: number }>;
  hasVerifiedMfa: boolean;
}

// Call only after Supabase getUser(token) has verified this exact bearer token.
// JWT refresh timestamps do not prove that the creator recently authenticated.
export function verifiedCreatorAuthentication(
  token: string,
  user: {
    id: string;
    is_anonymous?: boolean;
    factors?: Array<{ status: string }>;
  },
): CreatorAuthentication {
  try {
    const part = token.split(".")[1];
    const encoded = part.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(
      atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")),
    );
    if (
      claims.sub !== user.id || claims.role !== "authenticated" ||
      claims.is_anonymous !== false || user.is_anonymous === true
    ) throw Error("Invalid identity");
    return {
      userId: user.id,
      assuranceLevel: claims.aal,
      methods: Array.isArray(claims.amr)
        ? claims.amr.filter((entry: unknown) =>
          entry && typeof entry === "object" &&
          typeof (entry as Record<string, unknown>).method === "string" &&
          typeof (entry as Record<string, unknown>).timestamp === "number"
        )
        : [],
      hasVerifiedMfa: user.factors?.some((factor) =>
        factor.status === "verified"
      ) ?? false,
    };
  } catch {
    throw new RequestError(
      401,
      "unauthorized",
      "Sign in to manage your creator payment account.",
    );
  }
}

const PRIMARY_METHODS = new Set([
  "password",
  "oauth",
  "otp",
  "sso/saml",
  "magiclink",
  "email/signup",
]);
export const CREATOR_AUTH_MAX_AGE_SECONDS = 10 * 60;

export function requireRecentCreatorAuthentication(
  auth: CreatorAuthentication,
  now: number,
): void {
  const nowSeconds = now / 1000;
  const fresh = (timestamp: number) =>
    Number.isFinite(timestamp) &&
    timestamp <= nowSeconds + 30 &&
    timestamp >= nowSeconds - CREATOR_AUTH_MAX_AGE_SECONDS;
  if (
    !auth.userId || !["aal1", "aal2"].includes(auth.assuranceLevel) ||
    !auth.methods.some(({ method, timestamp }) =>
      PRIMARY_METHODS.has(method) && fresh(timestamp)
    )
  ) {
    throw new RequestError(
      403,
      "reauthentication_required",
      "Confirm your KMA password to securely open payout setup.",
    );
  }
  if (
    auth.hasVerifiedMfa && (auth.assuranceLevel !== "aal2" ||
      !auth.methods.some(({ method, timestamp }) =>
        method === "totp" && fresh(timestamp)
      ))
  ) {
    throw new RequestError(
      403,
      "mfa_required",
      "Enter your authenticator code to securely open payout setup.",
    );
  }
}
