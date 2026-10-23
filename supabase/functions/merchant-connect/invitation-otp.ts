import { requiredEnv } from "../_shared/env.ts";

export type InvitationOtpOutcome = { status: "sent" | "failed" | "unknown" };
// This is the normal Supabase Auth OTP endpoint with the public project key,
// not an admin account creation or session-generation API. No OTP is returned.
export async function sendInvitationOtp(
  email: string,
  recipientOrigin: string,
  fetcher: typeof fetch = fetch,
  read: (name: string) => string = requiredEnv,
): Promise<InvitationOtpOutcome> {
  const base = read("SUPABASE_URL"), key = read("SUPABASE_ANON_KEY");
  const url = new URL(`${base.replace(/\/$/, "")}/auth/v1/otp`);
  url.searchParams.set("redirect_to", `${recipientOrigin}/merchant/connect`);
  try {
    const response = await fetcher(url.toString(), {
      method: "POST",
      redirect: "error",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        create_user: true,
        data: { registration_flow: "merchant_v1" },
        gotrue_meta_security: {},
      }),
      signal: AbortSignal.timeout(8000),
    });
    // Auth deliberately returns no account/session/OTP for this send operation.
    return {
      status: response.ok
        ? "sent"
        : response.status >= 500
        ? "unknown"
        : "failed",
    };
  } catch {
    return { status: "unknown" };
  }
}
