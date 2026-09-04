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
import { paragraph, renderPlatformEmail } from "../_shared/email-template.ts";
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
        preheader:
          `Review and sign the partnership agreement for ${context.productName} to open your tracked links and earnings.`,
        eyebrow: "Signature requested",
        title: "Sign your partnership agreement",
        greetingHtml: `Hi ${context.partnerName},`,
        bodyHtml: `${
          paragraph(
            "KissMyApps recorded the commercial terms for your partnership: " +
              termsLine + ".",
          )
        }` +
          paragraph(
            "Before your tracked links and commissions can go live, we both sign the agreement. Review the document in your dashboard, then sign with your full legal name.",
          ),
        actionLabel: "Review & sign the agreement",
        actionUrl: `${PARTNER_PORTAL_URL}/#links`,
        noteTitle: "What happens next?",
        noteHtml:
          "Sign the document in your dashboard, and KissMyApps countersigns right after. Signing records your legal name, account, and the exact document version as immutable evidence. If you were not expecting this email, contact us before signing.",
        closingHtml:
          `Welcome aboard,<br /><strong style="color:#222222">Founder, KissMyApps</strong>`,
      }),
    };
  }

  if (event.type === "partner_signed") {
    return {
      to: context.adminEmails,
      subject:
        `Partner signed: ${context.partnerName} · ${context.productName}`,
      html: renderPlatformEmail({
        preheader:
          `${context.partnerName} signed the agreement for ${context.productName}; it now waits for the KissMyApps countersignature.`,
        eyebrow: "Partner signature received",
        title: `${context.partnerName} signed the agreement`,
        greetingHtml: "Hi team,",
        bodyHtml: paragraph(
          `The partner signed the agreement document for ${termsLine}. The document now waits for the KissMyApps countersignature before the agreement can be activated.`,
        ),
        actionLabel: "Open product configuration",
        actionUrl: `${ADMIN_PORTAL_URL}/#admin/products`,
        noteTitle: "Before you countersign",
        noteHtml:
          "Verify the typed partner name against the agreement terms. The countersignature completes the bilateral evidence, which is then preserved permanently.",
        closingHtml: `— KissMyApps platform notifications`,
      }),
    };
  }

  return {
    to: context.partnerEmails,
    subject:
      `Countersigned: your KissMyApps agreement for ${context.productName} is complete`,
    html: renderPlatformEmail({
      preheader:
        `Both signatures are recorded for ${context.productName}. The agreement terms are now in force.`,
      eyebrow: "Agreement fully signed",
      title: "Your agreement is complete",
      greetingHtml: `Hi ${context.partnerName},`,
      bodyHtml: paragraph(
        `KissMyApps countersigned the agreement for ${termsLine}. Both signatures are recorded and the terms are in force.`,
      ) +
        paragraph(
          "Your tracked links and earnings appear in your dashboard once the product launches.",
        ),
      actionLabel: "Open your dashboard",
      actionUrl: `${PARTNER_PORTAL_URL}/#performance`,
      noteTitle: "Keep this for your records",
      noteHtml:
        "The signed agreement is always available in Profile & Documents. Commission follows the terms you signed, including the attribution window and payout cadence.",
      closingHtml:
        `Welcome aboard,<br /><strong style="color:#222222">Founder, KissMyApps</strong>`,
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
