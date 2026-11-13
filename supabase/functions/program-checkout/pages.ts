// The few small pages the checkout link shows instead of going to Stripe: the
// page link previews and bots see, and the pages that say why a checkout
// cannot open. Plain HTML with inline styles, no scripts, no images, nothing
// loaded from anywhere. Supabase serves text/html from its own domain as
// text/plain; the edge proxy for kissmyapps.dev/checkout puts text/html back.
import type { CheckoutProduct } from "./target.ts";

export const MARKETPLACE_URL = "https://kissmyapps.dev/marketplace";

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'",
};

/** Headers every answer of the function carries, redirects included. */
export function pageHeaders(
  requestId: string,
  extra: Record<string, string> = {},
): Headers {
  return new Headers({ ...PAGE_HEADERS, "X-Request-ID": requestId, ...extra });
}

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** "$9.99 a month", "€49 a year", "¥1,200": major units with the symbol. */
export function priceText(product: CheckoutProduct, currency: string): string {
  let amount: string;
  try {
    const format = new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency.toUpperCase(),
    });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    amount = format.format(product.amountMinor / 10 ** digits);
  } catch {
    amount = `${
      (product.amountMinor / 100).toFixed(2)
    } ${currency.toUpperCase()}`;
  }
  return product.interval === "month"
    ? `${amount} a month`
    : product.interval === "year"
    ? `${amount} a year`
    : amount;
}

interface PageContent {
  title: string;
  heading: string;
  lines: string[];
  link: { href: string; label: string; nofollow?: boolean };
}

const STYLE =
  "body{margin:0;font:16px/1.5 system-ui,-apple-system,'Segoe UI'," +
  "sans-serif;color:#17161a;background:#f7f6f3}main{max-width:28rem;" +
  "margin:12vh auto;padding:0 16px}h1{font-size:1.5rem;line-height:1.25;" +
  "margin:0 0 .75rem}p{margin:0 0 .75rem;color:#4a4850}a.go{display:" +
  "inline-block;margin-top:.5rem;padding:.7rem 1.1rem;border-radius:.6rem;" +
  "background:#17161a;color:#fff;text-decoration:none;font-weight:600}" +
  "small{display:block;margin-top:2rem;color:#77747d}" +
  "@media (prefers-color-scheme:dark){body{background:#151418;color:#f2f1ee}" +
  "p{color:#c4c1c9}a.go{background:#f2f1ee;color:#151418}small{color:#8f8b96}}";

function html(content: PageContent): string {
  const lines = content.lines.map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
  const rel = content.link.nofollow ? ' rel="nofollow"' : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<meta property="og:title" content="${escapeHtml(content.title)}">` +
    `<title>${escapeHtml(content.title)}</title><style>${STYLE}</style>` +
    `</head><body><main><h1>${escapeHtml(content.heading)}</h1>${lines}` +
    `<a class="go" href="${escapeHtml(content.link.href)}"${rel}>` +
    `${escapeHtml(content.link.label)}</a>` +
    `<small>Checkout by KissMyApps. Payment is taken by Stripe.</small>` +
    `</main></body></html>`;
}

export function pageResponse(
  status: number,
  content: PageContent,
  requestId: string,
  head: boolean,
  extra: Record<string, string> = {},
): Response {
  return new Response(head ? null : html(content), {
    status,
    headers: pageHeaders(requestId, extra),
  });
}

/** The query that opens the checkout from the page: the same click, and go=1. */
export function continueHref(click: string | null): string {
  const query = new URLSearchParams();
  if (click !== null) query.set("kma_click", click);
  query.set("go", "1");
  return `?${query}`;
}

/** What link previews, bots and HEAD requests get: nothing is created. */
export function previewPage(input: {
  programName: string;
  product: CheckoutProduct;
  currency: string;
  click: string | null;
}): PageContent {
  return {
    title: input.programName,
    heading: input.programName,
    lines: [
      `${input.product.name}, ${priceText(input.product, input.currency)}`,
    ],
    link: {
      href: continueHref(input.click),
      label: "Continue to checkout",
      nofollow: true,
    },
  };
}

export type RefusalPage =
  | "not_found"
  | "not_live"
  | "paused"
  | "no_connection"
  | "disabled"
  | "unavailable"
  | "method";

const marketplace = { href: MARKETPLACE_URL, label: "Browse the marketplace" };

/** Why a checkout cannot open, and the status it is answered with. */
export function refusalPage(
  kind: RefusalPage,
  click: string | null = null,
): { status: number; content: PageContent } {
  switch (kind) {
    case "not_found":
      return {
        status: 404,
        content: {
          title: "Checkout link not found",
          heading: "This checkout link does not work",
          lines: ["Check the address, or find the program on the marketplace."],
          link: marketplace,
        },
      };
    case "not_live":
      return {
        status: 404,
        content: {
          title: "Checkout not open",
          heading: "This checkout is not open",
          lines: ["The program is not taking orders through this link."],
          link: marketplace,
        },
      };
    case "paused":
    case "no_connection":
      return {
        status: 503,
        content: {
          title: "Checkout paused",
          heading: "This checkout is paused",
          lines: [
            "The program is not taking orders right now. Try again later.",
          ],
          link: marketplace,
        },
      };
    case "disabled":
      return {
        status: 503,
        content: {
          title: "Checkout not available",
          heading: "Checkout is not available right now",
          lines: ["Try again later."],
          link: marketplace,
        },
      };
    case "unavailable":
      return {
        status: 503,
        content: {
          title: "Checkout could not open",
          heading: "The checkout could not open",
          lines: ["Something went wrong on our side. Try again in a minute."],
          link: {
            href: continueHref(click),
            label: "Try again",
            nofollow: true,
          },
        },
      };
    case "method":
      return {
        status: 405,
        content: {
          title: "Not allowed",
          heading: "This address only opens a checkout",
          lines: ["Open the link in a browser."],
          link: marketplace,
        },
      };
  }
}
