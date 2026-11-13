// Checkout link of an affiliate program (payment mode "kma_checkout"):
//
//   GET kissmyapps.dev/checkout/<program key>?kma_click=<click id>
//
// The edge proxy sends it here. The database says which merchant account,
// product and price the program sells, checks the creator's click and names
// that creator's promo code. KissMyApps then starts a Stripe Checkout Session
// on the merchant's own Stripe account (a direct charge: the platform key and
// the Stripe-Account header) and answers 303 to Stripe's page. The session
// carries the click exactly as the merchant's own checkout snippet does
// (metadata.kma_click and client_reference_id "kma_<click>"), so the payment
// webhook, the sales worker and record_program_sale record the sale as before.
//
// Link previews, bots and HEAD requests get a small page with a "Continue to
// checkout" link (the same address with go=1) and never create a session.
// Off unless PROGRAM_CHECKOUT_ENABLED is exactly "true". Logs carry outcome
// codes only: no click ids, no Stripe ids, never the key.
import { bytesToHex } from "../_shared/crypto.ts";
import {
  ConfigurationError,
  DatabaseBoundaryError,
} from "../_shared/errors.ts";
import { requestId } from "../_shared/http.ts";
import { requireLiveStripeKey } from "../_shared/stripe-auth.ts";
import { serviceClient } from "../_shared/supabase.ts";
import {
  pageHeaders,
  pageResponse,
  previewPage,
  type RefusalPage,
  refusalPage,
} from "./pages.ts";
import {
  ConnectedStripe,
  ConnectedStripeError,
  type FormParams,
} from "./stripe.ts";
import {
  type CheckoutTarget,
  CLICK_ID,
  isProgramKey,
  parseTarget,
  RPC_ARGUMENT,
  TARGET_FUNCTION,
  targetInput,
} from "./target.ts";

const WORKER = "program-checkout";
const DATABASE_TIMEOUT_MS = 8_000;

export interface ProgramCheckoutStore {
  /** program_checkout_target's answer, as returned. */
  target(input: Record<string, unknown>): Promise<unknown>;
}

export interface ProgramCheckoutLogEntry {
  level: "info" | "warning" | "error";
  worker: typeof WORKER;
  outcome: string;
  request_id: string;
  database_code?: string;
}

export interface ProgramCheckoutDependencies {
  enabled: () => boolean;
  /** The platform's live Stripe key. Read only when a session is created. */
  stripeKey: () => string;
  store: () => ProgramCheckoutStore;
  fetcher: typeof fetch;
  now: () => number;
  /** Makes the Idempotency-Key of a checkout without a click its own. */
  nonce: () => string;
  log: (entry: ProgramCheckoutLogEntry) => void;
}

function databaseStore(): ProgramCheckoutStore {
  return {
    target: async (input) => {
      const { data, error } = await serviceClient(DATABASE_TIMEOUT_MS).rpc(
        TARGET_FUNCTION,
        { [RPC_ARGUMENT]: input },
      );
      if (error) throw new DatabaseBoundaryError(error.code);
      return data as unknown;
    },
  };
}

function defaults(): ProgramCheckoutDependencies {
  return {
    enabled: () => Deno.env.get("PROGRAM_CHECKOUT_ENABLED") === "true",
    stripeKey: () =>
      requireLiveStripeKey(
        (Deno.env.get("CONSOLE_CONNECT_STRIPE_SECRET") ?? "").trim(),
      ),
    store: databaseStore,
    fetcher: fetch,
    now: Date.now,
    nonce: () => crypto.randomUUID(),
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

/**
 * The program key from the path. The function is reached as
 * /program-checkout/checkout/<key> through the edge proxy, or as
 * /program-checkout/<key> directly.
 */
export function programKeyFromPath(pathname: string): string | null {
  let path = pathname;
  for (const prefix of ["/functions/v1", "/program-checkout", "/checkout"]) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      path = path.slice(prefix.length);
    }
  }
  const match = /^\/([^/]+)\/?$/.exec(path);
  if (!match) return null;
  let key: string;
  try {
    key = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return isProgramKey(key) ? key : null;
}

/** The click from the query: exactly one, shaped like a click id, else none. */
export function clickFromQuery(url: URL): string | null {
  const values = url.searchParams.getAll("kma_click");
  return values.length === 1 && CLICK_ID.test(values[0]) ? values[0] : null;
}

const PREVIEW_AGENTS = new RegExp(
  [
    "bot\\b",
    "bot/",
    "crawl",
    "spider",
    "slurp",
    "preview",
    "facebookexternalhit",
    "facebookcatalog",
    "meta-externalagent",
    "embedly",
    "whatsapp",
    "telegram",
    "discord",
    "slack",
    "skypeuri",
    "linkedin",
    "pinterest",
    "vkshare",
    "redditbot",
    "tumblr",
    "bitly",
    "outbrain",
    "headlesschrome",
    "lighthouse",
    "curl/",
    "wget/",
    "python-",
    "go-http-client",
    "okhttp",
    "node-fetch",
    "axios",
    "java/",
    "libwww",
    "httpclient",
  ].join("|"),
  "i",
);

/**
 * A link preview, a crawler, a prefetch or a script: anything that is not a
 * person opening the link. Such requests never create a Checkout Session.
 */
export function isPreview(request: Request): boolean {
  const agent = request.headers.get("user-agent")?.trim() ?? "";
  if (agent.length < 8 || PREVIEW_AGENTS.test(agent)) return true;
  const purpose = [
    request.headers.get("sec-purpose"),
    request.headers.get("purpose"),
    request.headers.get("x-purpose"),
    request.headers.get("x-moz"),
  ].join(" ").toLowerCase();
  return /prefetch|preview|prerender/.test(purpose);
}

/** The form fields of the Checkout Session, in a fixed order. */
export function checkoutSessionParams(target: CheckoutTarget): FormParams {
  const mode = target.product.interval === null ? "payment" : "subscription";
  const params: [string, string][] = [
    ["mode", mode],
    ["line_items[0][quantity]", "1"],
    ["line_items[0][price_data][currency]", target.currency],
    [
      "line_items[0][price_data][unit_amount]",
      String(target.product.amountMinor),
    ],
    ["line_items[0][price_data][product_data][name]", target.product.name],
  ];
  if (target.product.interval !== null) {
    params.push([
      "line_items[0][price_data][recurring][interval]",
      target.product.interval,
    ]);
  }
  if (target.click !== null) {
    // What the merchant's own checkout snippet sends, so the sales worker
    // matches it the same way: metadata first, then the reference.
    params.push(
      ["client_reference_id", `kma_${target.click}`],
      ["metadata[kma_click]", target.click],
      mode === "payment"
        ? ["payment_intent_data[metadata][kma_click]", target.click]
        : ["subscription_data[metadata][kma_click]", target.click],
    );
  }
  // Stripe takes one or the other: the creator's own code applied for the
  // buyer, or a field where the buyer may type a code.
  if (target.promotionCodeId !== null) {
    params.push(["discounts[0][promotion_code]", target.promotionCodeId]);
  } else if (target.codesOffered) {
    params.push(["allow_promotion_codes", "true"]);
  }
  params.push(
    ["success_url", target.successUrl],
    ["cancel_url", target.cancelUrl],
  );
  return params;
}

/**
 * One session per program, click and minute: a double click or a reload
 * opens the same page. A checkout without a click gets its own key, so two
 * buyers never share a session.
 */
export async function checkoutIdempotencyKey(
  target: CheckoutTarget,
  programKey: string,
  now: number,
  nonce: string,
): Promise<string> {
  const scope = target.click === null
    ? `nonce:${nonce}`
    : `click:${target.click}:${Math.floor(now / 60_000)}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${target.accountId}|${programKey}|${scope}`),
  );
  return `kma-checkout-${bytesToHex(new Uint8Array(digest))}`;
}

export function createProgramCheckout(
  overrides: Partial<ProgramCheckoutDependencies> = {},
) {
  const deps: ProgramCheckoutDependencies = { ...defaults(), ...overrides };
  return async (request: Request): Promise<Response> => {
    const rid = requestId(request);
    const head = request.method === "HEAD";
    const url = new URL(request.url);
    const click = clickFromQuery(url);
    const note = (
      level: ProgramCheckoutLogEntry["level"],
      outcome: string,
      databaseCode?: string,
    ) =>
      deps.log({
        level,
        worker: WORKER,
        outcome,
        request_id: rid,
        ...(databaseCode ? { database_code: databaseCode } : {}),
      });
    const refuse = (kind: RefusalPage, extra: Record<string, string> = {}) => {
      const { status, content } = refusalPage(kind, click);
      return pageResponse(status, content, rid, head, extra);
    };

    if (request.method !== "GET" && !head) {
      return refuse("method", { Allow: "GET, HEAD" });
    }
    if (!deps.enabled()) return refuse("disabled");
    const programKey = programKeyFromPath(url.pathname);
    if (programKey === null) return refuse("not_found");
    const preview = head ||
      (url.searchParams.get("go") !== "1" && isPreview(request));

    let target: CheckoutTarget;
    try {
      const answer = parseTarget(
        await deps.store().target(targetInput(programKey, click)),
      );
      if (!answer.ok) return refuse(answer.reason);
      target = answer;
    } catch (error) {
      note(
        "error",
        "database_unavailable",
        error instanceof DatabaseBoundaryError ? error.databaseCode : undefined,
      );
      return refuse("unavailable");
    }

    if (preview) {
      return pageResponse(
        200,
        previewPage({
          programName: target.programName,
          product: target.product,
          currency: target.currency,
          click: target.click,
        }),
        rid,
        head,
      );
    }

    try {
      const stripe = new ConnectedStripe(deps.stripeKey(), deps.fetcher);
      const mode = target.product.interval === null
        ? "payment"
        : "subscription";
      const key = await checkoutIdempotencyKey(
        target,
        programKey,
        deps.now(),
        deps.nonce(),
      );
      let session: { id: string; url: string };
      try {
        session = await stripe.createCheckoutSession(
          target.accountId,
          checkoutSessionParams(target),
          key,
          mode,
        );
      } catch (error) {
        // A code Stripe no longer takes (switched off a moment ago) must not
        // stop the sale: open the checkout without it, with a code field.
        if (
          !(error instanceof ConnectedStripeError) ||
          error.kind !== "rejected" || target.promotionCodeId === null
        ) throw error;
        note("warning", "promotion_code_refused");
        session = await stripe.createCheckoutSession(
          target.accountId,
          checkoutSessionParams({
            ...target,
            promotionCodeId: null,
            codesOffered: true,
          }),
          `${key}-plain`,
          mode,
        );
      }
      note("info", "session_created");
      return new Response(null, {
        status: 303,
        headers: pageHeaders(rid, { Location: session.url }),
      });
    } catch (error) {
      if (error instanceof ConnectedStripeError) {
        note(
          error.kind === "configuration" ? "error" : "warning",
          error.code,
        );
      } else if (error instanceof ConfigurationError) {
        note("error", error.code);
      } else {
        note("error", "internal_error");
      }
      return refuse("unavailable");
    }
  };
}

export const handleProgramCheckout = createProgramCheckout();
if (import.meta.main) Deno.serve(handleProgramCheckout);
