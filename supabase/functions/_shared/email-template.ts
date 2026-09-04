/**
 * Shared KissMyApps transactional email layout. Dark-card design on a light
 * background with the platform pink accent, mirroring the brand direction of
 * the partner dashboard. All emails are self-contained tables for client
 * compatibility; no external CSS or web fonts.
 */

export interface EmailTemplateInput {
  readonly eyebrow: string;
  readonly title: string;
  readonly bodyHtml: string;
  readonly actionLabel?: string;
  readonly actionUrl?: string;
  readonly noteHtml?: string;
}

const BRAND_PINK = "#ff80bf";
const INK = "#111111";
const CARD = "#1c1c1e";
const TEXT = "#f5f5f7";
const MUTED = "#a9a9ae";
const PAGE_BG = "#f4f2f4";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderPlatformEmail(input: EmailTemplateInput): string {
  const button = input.actionLabel && input.actionUrl
    ? `<tr><td style="padding:26px 0 0 0;">
  <a href="${
      escapeHtml(input.actionUrl)
    }" style="display:inline-block;background:#ff80bf;color:#3d1f2d;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;padding:13px 26px;border-radius:9px;text-decoration:none;">${
      escapeHtml(input.actionLabel)
    }</a>
</td></tr>`
    : "";
  const note = input.noteHtml
    ? `<tr><td style="padding:22px 0 0 0;border-top:1px solid #3a3a3c;" class="kma-note">
  <p style="margin:0;color:#a9a9ae;font-size:12.5px;line-height:1.7;">${input.noteHtml}</p>
</td></tr>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};">
<span style="display:none;font-size:1px;color:${PAGE_BG};">KissMyApps · ${
    escapeHtml(input.title)
  }</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="padding:0 8px 18px 8px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="padding-right:11px;">
      <table role="presentation" cellpadding="0" cellspacing="0" style="background:${BRAND_PINK};border-radius:11px;">
        <tr><td style="padding:9px 11px;font-size:17px;line-height:1;">&#128136;</td></tr>
      </table>
    </td>
    <td style="font-family:Georgia,'Times New Roman',serif;font-size:21px;font-weight:700;color:${INK};">
      KissMyApps<span style="color:#c9568d;">.dev</span>
      <span style="display:block;font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:800;letter-spacing:1.6px;color:#9b8f96;text-transform:uppercase;margin-top:2px;">Partners</span>
    </td>
  </tr></table>
</td></tr>
<tr><td>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border-radius:16px;overflow:hidden;">
<tr><td style="padding:34px 34px 30px 34px;font-family:Arial,Helvetica,sans-serif;">
  <p style="margin:0 0 10px 0;font-size:10.5px;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;color:#ff80bf;">${
    escapeHtml(input.eyebrow)
  }</p>
  <h1 style="margin:0 0 14px 0;font-size:23px;line-height:1.3;color:${TEXT};">${
    escapeHtml(input.title)
  }</h1>
  <div style="font-size:14.5px;line-height:1.75;color:#d9d9de;">${input.bodyHtml}</div>
  ${button}
  ${note}
</td></tr>
</table>
</td></tr>
<tr><td style="padding:20px 8px 4px 8px;">
  <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.7;color:#8a8a90;">
    You receive this because you have a KissMyApps partnership account.
    Manage notifications in your dashboard profile. &nbsp;&#10035;
  </p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export { escapeHtml };
