import {
  DatabaseBoundaryError,
  NotFoundError,
  RequestError,
} from "../_shared/errors.ts";
import { requiredSecret } from "../_shared/env.ts";
import {
  errorResponse,
  jsonResponse,
  readRequestBytes,
  requestId,
  requireJsonContentType,
  requireMethod,
} from "../_shared/http.ts";
import { renderPlatformEmail } from "../_shared/email-template.ts";
import { serviceClient } from "../_shared/supabase.ts";

const EVENT_TYPES = new Set([
  "signing_request",
  "partner_signed",
  "agreement_fully_signed",
]);

const PARTNER_PORTAL_URL = "https://partners.kissmyapps.dev";
const ADMIN_PORTAL_URL = "https://admin.kissmyapps.dev";
const DEFAULT_FROM = "KissMyApps Partners <partners@kissmyapps.dev>";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NotifyEvent {
  type: string;
  documentId: string;
}

function firstString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseEvent(value: unknown): NotifyEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(
      400,
      "invalid_event",
      "A JSON event object is required.",
    );
  }
  const row = value as Record<string, unknown>;
  const type = firstString(row.type);
  const documentId = firstString(row.document_id);
  if (
    !type || !documentId || !EVENT_TYPES.has(type) ||
    !UUID_PATTERN.test(documentId)
  ) {
    throw new RequestError(
      400,
      "invalid_event",
      "The event fields are invalid.",
    );
  }
  return { type, documentId };
}

interface LoadedContext {
  partnerName: string;
  productName: string;
  agreementVersion: number;
  partnerEmails: string[];
  adminEmails: string[];
}

function emailFromQuery(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const email = (row as { email?: unknown }).email;
  return typeof email === "string" && email.includes("@") ? email : null;
}

async function loadContext(
  client: ReturnType<typeof serviceClient>,
  event: NotifyEvent,
): Promise<LoadedContext> {
  const documentQuery = await client
    .from("documents")
    .select("id, agreement_id, affiliate_id")
    .eq("id", event.documentId)
    .maybeSingle();
  if (documentQuery.error) {
    throw new DatabaseBoundaryError(documentQuery.error.code);
  }
  const document = documentQuery.data as
    | { id: string; agreement_id: string | null; affiliate_id: string }
    | null;
  if (!document?.agreement_id) throw new NotFoundError();

  const agreementQuery = await client
    .from("agreements")
    .select("version, product_id, affiliate_id")
    .eq("id", document.agreement_id)
    .maybeSingle();
  if (agreementQuery.error) {
    throw new DatabaseBoundaryError(agreementQuery.error.code);
  }
  const agreement = agreementQuery.data as
    | { version: number; product_id: string; affiliate_id: string }
    | null;
  if (!agreement) throw new NotFoundError();

  const productQuery = await client
    .from("products")
    .select("name")
    .eq("id", agreement.product_id)
    .maybeSingle();
  const productName = firstString(
    (productQuery.data as { name?: unknown } | null)?.name,
  ) ?? "your product";

  const affiliateQuery = await client
    .from("affiliates")
    .select("public_name")
    .eq("id", agreement.affiliate_id)
    .maybeSingle();
  const partnerName = firstString(
    (affiliateQuery.data as { public_name?: unknown } | null)?.public_name,
  ) ?? "Partner";

  const membershipsQuery = await client
    .from("affiliate_users")
    .select("user_id")
    .eq("affiliate_id", agreement.affiliate_id)
    .eq("active", true);
  if (membershipsQuery.error) {
    throw new DatabaseBoundaryError(membershipsQuery.error.code);
  }
  const memberships = (membershipsQuery.data ?? []) as { user_id: string }[];
  const partnerEmails: string[] = [];
  for (const membership of memberships.slice(0, 5)) {
    const userQuery = await client.auth.admin.getUserById(membership.user_id);
    const email = userQuery.data?.user?.email;
    if (email) partnerEmails.push(email);
  }

  const adminsQuery = await client
    .from("admin_users")
    .select("user_id")
    .eq("active", true)
    .in("role", ["owner", "operations"]);
  if (adminsQuery.error) {
    throw new DatabaseBoundaryError(adminsQuery.error.code);
  }
  const adminMemberships = (adminsQuery.data ?? []) as { user_id: string }[];
  const adminEmails: string[] = [];
  for (const membership of adminMemberships.slice(0, 5)) {
    const userQuery = await client.auth.admin.getUserById(membership.user_id);
    const email = userQuery.data?.user?.email;
    if (email) adminEmails.push(email);
  }

  return {
    partnerName,
    productName,
    agreementVersion: agreement.version,
    partnerEmails,
    adminEmails,
  };
}

function renderEmail(
  event: NotifyEvent,
  context: LoadedContext,
): { to: string[]; subject: string; html: string } {
  const termsLine =
    `<strong>${context.productName}</strong> · agreement version ${context.agreementVersion}`;

  if (event.type === "signing_request") {
    return {
      to: context.partnerEmails,
      subject:
        `Action required: sign your KissMyApps agreement for ${context.productName}`,
      html: renderPlatformEmail({
        eyebrow: "Signature requested",
        title: "Your partnership agreement is ready to sign",
        bodyHtml: `<p style="margin:0 0 10px 0;">Hi ${context.partnerName},</p>
<p style="margin:0;">KissMyApps recorded the commercial terms for ${termsLine} and needs your signature to unlock your partner link and earnings.</p>
<p style="margin:12px 0 0 0;">Open your dashboard, review the document, and sign with your full legal name. KissMyApps countersigns right after you.</p>`,
        actionLabel: "Review & sign the agreement",
        actionUrl: `${PARTNER_PORTAL_URL}/#links`,
        noteHtml:
          `Signing records your legal name, account, and the exact document version as immutable evidence. If you were not expecting this, contact the KissMyApps team before signing.`,
      }),
    };
  }

  if (event.type === "partner_signed") {
    return {
      to: context.adminEmails,
      subject:
        `Partner signed: ${context.partnerName} · ${context.productName}`,
      html: renderPlatformEmail({
        eyebrow: "Partner signature received",
        title: `${context.partnerName} signed the agreement`,
        bodyHtml:
          `<p style="margin:0;">The partner signed the agreement document for ${termsLine}. The document now waits for the KissMyApps countersignature before the agreement can be activated.</p>`,
        actionLabel: "Open product configuration",
        actionUrl: `${ADMIN_PORTAL_URL}/#admin/products`,
        noteHtml:
          `Verify the typed partner name before countersigning. The countersignature completes the bilateral evidence.`,
      }),
    };
  }

  return {
    to: context.partnerEmails,
    subject:
      `Countersigned: your KissMyApps agreement for ${context.productName} is complete`,
    html: renderPlatformEmail({
      eyebrow: "Agreement fully signed",
      title: "Your agreement is complete",
      bodyHtml: `<p style="margin:0 0 10px 0;">Hi ${context.partnerName},</p>
<p style="margin:0;">KissMyApps countersigned the agreement for ${termsLine}. Both signatures are recorded and the terms are in force.</p>
<p style="margin:12px 0 0 0;">Your tracked links and earnings appear in your dashboard once the product launches.</p>`,
      actionLabel: "Open your dashboard",
      actionUrl: `${PARTNER_PORTAL_URL}/#performance`,
      noteHtml:
        `Keep this email for your records. The signed agreement is available in Profile & Documents.`,
    }),
  };
}

async function sendViaResend(
  apiKey: string,
  from: string,
  message: { to: string[]; subject: string; html: string },
): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: message.to,
      subject: message.subject,
      html: message.html,
    }),
  });
  if (!response.ok) {
    throw new RequestError(
      502,
      "email_unavailable",
      "The email could not be sent.",
    );
  }
}

export function createAgreementNotifyHandler(
  overrides: {
    notifySecret?: () => string;
    emailApiKey?: () => string;
    emailFrom?: () => string;
  } = {},
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const id = requestId(request);
    try {
      requireMethod(request, ["POST"]);
      const secret = (overrides.notifySecret ?? (() =>
        requiredSecret("AGREEMENT_NOTIFY_SECRET")))();
      const headerSecret = request.headers.get("x-kma-internal-secret") ?? "";
      if (!headerSecret || headerSecret !== secret) {
        throw new RequestError(
          401,
          "invalid_secret",
          "Request authentication failed.",
        );
      }
      requireJsonContentType(request);
      const bytes = await readRequestBytes(request, 4 * 1024);
      const event = parseEvent(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );

      const message = renderEmail(
        event,
        await loadContext(serviceClient(), event),
      );
      if (message.to.length === 0) {
        // Nothing to address: complete successfully so pg_net does not retry.
        return jsonResponse(200, { sent: 0, request_id: id }, {
          "X-Request-ID": id,
        });
      }

      const apiKey = (overrides.emailApiKey ?? (() =>
        requiredSecret("RESEND_API_KEY")))();
      const from = overrides.emailFrom?.() ??
        Deno.env.get("AGREEMENT_EMAIL_FROM")?.trim() ?? DEFAULT_FROM;
      await sendViaResend(apiKey, from, message);

      return jsonResponse(200, { sent: message.to.length, request_id: id }, {
        "X-Request-ID": id,
      });
    } catch (error) {
      return errorResponse(error, id, { "X-Request-ID": id });
    }
  };
}

export const handleAgreementNotify = createAgreementNotifyHandler();

if (import.meta.main) Deno.serve(handleAgreementNotify);
