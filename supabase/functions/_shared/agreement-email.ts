import {
  escapeHtml,
  paragraph,
  renderPlatformEmail,
} from "./email-template.ts";
const PARTNER_PORTAL_URL = "https://partners.kissmyapps.dev";
const ADMIN_PORTAL_URL = "https://admin.kissmyapps.dev";
export interface LoadedContext {
  partnerName: string;
  productName: string;
  agreementVersion: number;
  partnerEmails: string[];
  adminEmails: string[];
}
export function renderEmail(
  event: { type: string },
  context: LoadedContext,
): { to: string[]; subject: string; html: string } {
  const termsLine = `<strong>${
    escapeHtml(context.productName)
  }</strong> · agreement version ${context.agreementVersion}`;

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
        greetingHtml: `Hi ${escapeHtml(context.partnerName)},`,
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
      greetingHtml: `Hi ${escapeHtml(context.partnerName)},`,
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
