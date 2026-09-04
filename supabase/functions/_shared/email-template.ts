/**
 * Shared KissMyApps transactional email layout. Matches the production
 * signup/confirmation email design: light pink page, white rounded card,
 * dark logo bar with the platform icon, pink pill badge, yellow CTA button,
 * pink "what happens next" panel, and the dark terms footer. Self-contained
 * tables and inline styles for email-client compatibility.
 */

export interface EmailTemplateInput {
  /** Hidden preview text shown next to the subject in the inbox. */
  readonly preheader: string;
  /** Small pink pill above the heading (e.g. "KissMyApps Partners"). */
  readonly eyebrow?: string;
  readonly title: string;
  /** Optional greeting line, e.g. "Hi Victory,". */
  readonly greetingHtml?: string;
  /** Main paragraphs as HTML (each wrapped in the shared paragraph style). */
  readonly bodyHtml: string;
  readonly actionLabel?: string;
  readonly actionUrl?: string;
  /** Title inside the pink "what happens next" panel. */
  readonly noteTitle?: string;
  /** Body inside the pink panel. */
  readonly noteHtml?: string;
  /** Sign-off block, e.g. "Welcome aboard, — Founder, KissMyApps". */
  readonly closingHtml?: string;
  readonly footerTagline?: string;
}

const PAGE_BG = "#fff2f8";
const INK = "#111111";
const TEXT = "#4a4a4a";
const MUTED = "#a9a9ae";
const PILL_BG = "#ffe5f2";
const PILL_TEXT = "#804060";
const NOTE_BG = "#fff4fa";
const NOTE_BORDER = "#ffd4e9";
const YELLOW = "#ffea30";
const FONT = "Arial, 'Helvetica Neue', Helvetica, sans-serif";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function paragraph(html: string, marginBottom = 18): string {
  return `<p style="margin:0 0 ${marginBottom}px 0;padding:0;color:${TEXT};font-family:${FONT};font-size:17px;line-height:29px;">${html}</p>`;
}

export function renderPlatformEmail(input: EmailTemplateInput): string {
  const eyebrow = input.eyebrow ?? "KissMyApps Partners";
  const button = input.actionLabel && input.actionUrl
    ? `<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:0 0 28px 0">
<tr><td align="center" bgcolor="${YELLOW}" style="background-color:${YELLOW};border-radius:12px;mso-padding-alt:15px 22px;">
<a class="mobile-button" href="${
      escapeHtml(input.actionUrl)
    }" style="display:inline-block;padding:15px 22px;color:${INK};font-family:${FONT};font-size:16px;line-height:20px;font-weight:700;text-decoration:none;">${
      escapeHtml(input.actionLabel)
    }</a>
</td></tr>
</table>`
    : "";
  const note = input.noteTitle && input.noteHtml
    ? `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${NOTE_BG}" style="width:100%;margin:0 0 28px 0;background-color:${NOTE_BG};border:1px solid ${NOTE_BORDER};border-radius:16px;">
<tr><td style="padding:22px 24px">
<p style="margin:0 0 7px 0;padding:0;color:${PILL_TEXT};font-family:${FONT};font-size:16px;line-height:23px;font-weight:700;">${
      escapeHtml(input.noteTitle)
    }</p>
<p style="margin:0;padding:0;color:${TEXT};font-family:${FONT};font-size:15px;line-height:24px;">${input.noteHtml}</p>
</td></tr>
</table>`
    : "";
  const closing = input.closingHtml
    ? `<p style="margin:0;padding:0;color:${TEXT};font-family:${FONT};font-size:17px;line-height:29px;">${input.closingHtml}</p>`
    : "";

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html xmlns="http://www.w3.org/1999/xhtml" lang="en" dir="ltr">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" />
<title>${escapeHtml(input.title)}</title>
<style type="text/css">
body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
table { border-collapse: collapse !important; }
img { -ms-interpolation-mode: bicubic; }
@media only screen and (max-width: 620px) {
.mobile-gutter { padding-left: 12px !important; padding-right: 12px !important; }
.mobile-pad { padding-left: 24px !important; padding-right: 24px !important; }
.mobile-heading { font-size: 30px !important; line-height: 36px !important; }
.mobile-wordmark { font-size: 21px !important; letter-spacing: 0.2px !important; }
.mobile-button { display: block !important; text-align: center !important; }
}
</style>
</head>
<body style="margin:0;padding:0;width:100% !important;background-color:${PAGE_BG};color:${TEXT};font-family:${FONT};">
<div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0;color:transparent;">${
    escapeHtml(input.preheader)
  }</div>
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${PAGE_BG}" style="width:100%;background-color:${PAGE_BG};">
<tr><td class="mobile-gutter" align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:22px;overflow:hidden;">
<tr><td class="mobile-pad" bgcolor="${INK}" style="padding:30px 36px">
<table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr>
<td width="62" height="62" style="width:62px;height:62px;">
<img src="https://partners.kissmyapps.dev/apple-touch-icon.png" width="62" height="62" alt="" border="0" style="display:block;width:62px;height:62px;border:0;border-radius:14px;outline:none;text-decoration:none;" />
</td>
<td class="mobile-wordmark" valign="middle" style="padding-left:16px;color:#ffffff;font-family:${FONT};font-size:24px;line-height:30px;font-weight:700;letter-spacing:0.3px;">
KissMyApps<span style="color:#ff80bf">.dev</span>
</td>
</tr></table>
</td></tr>
<tr><td class="mobile-pad" style="padding:48px 42px 20px 42px">
<table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr>
<td bgcolor="${PILL_BG}" style="padding:8px 14px;background-color:${PILL_BG};border-radius:30px;color:${PILL_TEXT};font-family:${FONT};font-size:13px;line-height:18px;font-weight:700;">
${escapeHtml(eyebrow)}
</td></tr></table>
<h1 class="mobile-heading" style="margin:22px 0 18px 0;padding:0;color:#222222;font-family:${FONT};font-size:36px;line-height:42px;font-weight:700;">
${escapeHtml(input.title)}
</h1>
${input.greetingHtml ? paragraph(input.greetingHtml) : ""}
${input.bodyHtml}
${button}
${note}
${closing}
</td></tr>
<tr><td class="mobile-pad" style="padding:22px 42px 42px 42px">
<div style="border-top:1px solid #eadce3;padding-top:22px;color:#777777;font-family:${FONT};font-size:13px;line-height:20px;">
${
    escapeHtml(
      input.footerTagline ??
        "Secure partner access · Product-specific links · Clear reporting",
    )
  }
</div>
</td></tr>
<tr><td class="mobile-pad" align="center" bgcolor="${INK}" style="padding:24px 36px;background-color:${INK};text-align:center;color:${MUTED};font-family:${FONT};font-size:12px;line-height:20px;">
<a href="https://kissmyapps.dev/terms" style="color:#ff80bf;text-decoration:underline">Terms</a>
<span aria-hidden="true" style="color:#4a4a4a">&nbsp;·&nbsp;</span>
<a href="https://kissmyapps.dev/privacy" style="color:#ff80bf;text-decoration:underline">Privacy</a>
<br /><span style="color:${MUTED}">© KissMyApps</span>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export { escapeHtml };
