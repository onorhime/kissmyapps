import { RequestError } from "../_shared/errors.ts";
import {
  escapeHtml,
  paragraph,
  renderPlatformEmail,
} from "../_shared/email-template.ts";

export interface InvitationMailConfig {
  enabled: boolean;
  from: string;
  activeKeyId: string;
  tokenKeys: Record<string, string>;
}
export interface InvitationEnvelope {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}
export interface InvitationMailOutcome {
  status: "sent" | "failed" | "unknown";
  provider_id?: string;
  error_code?: string;
}
export function invitationMailConfig(): InvitationMailConfig {
  const enabled = Deno.env.get("MERCHANT_INVITATION_EMAIL_ENABLED") === "true";
  let keys: Record<string, string> = {};
  try {
    keys = JSON.parse(
      Deno.env.get("MERCHANT_INVITATION_TOKEN_KEYS_JSON") || "{}",
    );
  } catch { /* fail closed below */ }
  const activeKeyId = Deno.env.get("MERCHANT_INVITATION_TOKEN_KEY_ID") || "";
  const from = Deno.env.get("AGREEMENT_EMAIL_FROM") || "";
  if (
    !/^[a-zA-Z0-9_-]{1,40}$/.test(activeKeyId) || !keys ||
    typeof keys !== "object" || Array.isArray(keys) ||
    !Object.hasOwn(keys, activeKeyId) ||
    Object.values(keys).some((v) =>
      typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)
    ) ||
    (enabled &&
      (!from || /[\r\n]/.test(from) || !Deno.env.get("RESEND_API_KEY")))
  ) {
    throw new RequestError(
      503,
      "invitation_email_unavailable",
      "Merchant invitation delivery is not configured. Contact the administrator.",
    );
  }
  return { enabled, from, activeKeyId, tokenKeys: keys };
}
export async function deriveInvitationToken(
  config: InvitationMailConfig,
  keyId: string,
  requestId: string,
): Promise<string> {
  const value = config.tokenKeys[keyId];
  if (!value || !/^[a-f0-9]{64}$/.test(value)) {
    throw new RequestError(
      503,
      "invitation_key_unavailable",
      "This invitation needs a new link. Contact the administrator.",
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(value.match(/../g)!.map((x) => parseInt(x, 16))),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        `kma/merchant-invitation/v1/${requestId.toLowerCase()}`,
      ),
    ),
  );
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}
// Version 1 is immutable: retries must reconstruct the exact original envelope.
export function renderInvitationEmail(
  fields: Record<string, unknown>,
  invitationUrl: string,
): InvitationEnvelope {
  if (fields.template_version !== 1) {
    throw new RequestError(
      409,
      "invitation_template_unavailable",
      "Create a new invitation to send this email.",
    );
  }
  const business = String(fields.business_name),
    to = String(fields.to),
    expiry = new Date(String(fields.expires_at)).toISOString().replace("T", " ")
      .replace(/\.\d{3}Z$/, " UTC");
  return {
    from: String(fields.from),
    to,
    subject: "Connect your Stripe account to KissMyApps",
    text:
      `Hello ${business},\n\nYou have been invited to connect your business’s Stripe account to KissMyApps. Sign in to KissMyApps using ${to}, then choose the Stripe business account you want to connect and review its details before confirming. Your Stripe account login can use a different email.\n\nConnect your Stripe account: ${invitationUrl}\n\nThis link expires at ${expiry}. Do not forward it. Connecting an account does not enable checkout or payouts. If you did not expect this invitation, ignore it.\n\n— KissMyApps`,
    html: renderPlatformEmail({
      preheader:
        `Connect the Stripe account for ${business} securely with KissMyApps.`,
      eyebrow: "Merchant invitation",
      title: "Connect your business to KissMyApps",
      greetingHtml: `Hello ${escapeHtml(business)},`,
      bodyHtml: paragraph(
        "You have been invited to connect your business’s Stripe account to KissMyApps.",
      ) +
        paragraph(
          `Sign in to KissMyApps with <strong>${
            escapeHtml(to)
          }</strong>. Then choose the Stripe business account you want to connect and review its details before confirming. Your Stripe account login can use a different email.`,
        ),
      actionLabel: "Connect your Stripe account",
      actionUrl: invitationUrl,
      noteTitle: "Your secure invitation",
      noteHtml: `This link expires at ${
        escapeHtml(expiry)
      }. Do not forward it. Connecting an account does not enable checkout or payouts. If you did not expect this invitation, you can ignore this email.`,
      closingHtml: "— KissMyApps",
    }),
  };
}
export async function sendInvitationEmail(
  envelope: InvitationEnvelope,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<InvitationMailOutcome> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    return { status: "failed", error_code: "provider_not_configured" };
  }
  let response: Response;
  try {
    response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { status: "unknown", error_code: "provider_response_unknown" };
  }
  if (response.status === 409) {
    let name = "";
    try {
      name = String((await response.json())?.name ?? "");
    } catch { /* uncertain */ }
    return {
      status: "unknown",
      error_code: name === "invalid_idempotent_request"
        ? "provider_payload_conflict"
        : "provider_concurrent_unknown",
    };
  }
  if (!response.ok) {
    return {
      status: response.status >= 500 || response.status === 409
        ? "unknown"
        : "failed",
      error_code: `provider_http_${response.status}`,
    };
  }
  try {
    const body = await response.json();
    if (
      typeof body?.id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(body.id)
    ) return { status: "sent", provider_id: body.id };
  } catch { /* no trustworthy receipt */ }
  return { status: "unknown", error_code: "provider_receipt_unknown" };
}
