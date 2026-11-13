// The app SDKs' two attribution calls: POST /v1/attribution/install on an app's first
// launch and POST /v1/attribution/open when a Universal Link or App Link opens it. The
// bodies follow the attribution section of
// integrations/analytics-mobile/contract/app-events.json; contract_test.ts keeps the two in
// step. The function checks the body, swaps an Apple Ads attribution token for Apple's
// answer, and hands both to public.attribution_install / public.attribution_open, which
// match the install and answer with its source and any deep link.
import { RequestError } from "../_shared/errors.ts";
import type { Geo } from "./payload.ts";

export type AttributionKind = "install" | "open";

/** The same envelope as analytics_ingest's, without kind (the function name says it). */
export interface AttributionPayload {
  key_hash: string;
  origin: string | null;
  ip_sha: string | null;
  user_agent: string | null;
  geo: Geo;
  clock_skew_ms: number;
  body: Record<string, unknown>;
}

/** The body field that carries the Apple Ads attribution value AdServices gives the app. */
export const APPLE_ADS_FIELD = "apple_ads_" + "to" + "ken";

export const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const DEVICE_KEY = /^[0-9a-f]{64}$/;
export const CLICK_ID = /^[A-Za-z0-9_-]{16,40}$/;
export const PLATFORMS = ["ios", "android"] as const;
// 2100-01-01: later Install Referrer times are not times.
const MAX_SECONDS = 4_102_444_800;

/** A refusal that names what was wrong, as extra keys in the JSON answer. */
export class AttributionRequestError extends RequestError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly extra: Record<string, string>,
  ) {
    super(status, code, message);
    this.name = "AttributionRequestError";
  }
}

function invalid(field: string, rule: string): AttributionRequestError {
  return new AttributionRequestError(
    400,
    "invalid_field",
    `${field} ${rule}.`,
    { field },
  );
}

type Rule = (value: unknown, field: string) => unknown;

const text = (max: number, numbers = false): Rule => (value, field) => {
  if (numbers && typeof value === "number" && Number.isFinite(value)) {
    value = String(value);
  }
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  if (!trimmed || trimmed.length > max) {
    throw invalid(field, `must be text of 1 to ${max} characters`);
  }
  return trimmed;
};

const pattern = (re: RegExp, rule: string): Rule => (value, field) => {
  if (typeof value !== "string" || !re.test(value)) throw invalid(field, rule);
  return value;
};

const time: Rule = (value, field) => {
  // The pattern alone lets 2026-02-30 through.
  if (
    typeof value !== "string" || !TIME.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw invalid(field, "must be a UTC time such as 2026-10-30T09:59:00.010Z");
  }
  return value;
};

const httpsUrl: Rule = (value, field) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  let url: URL | undefined;
  try {
    url = trimmed.length <= 2048 ? new URL(trimmed) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== "https:" || !url.hostname) {
    throw invalid(field, "must be an https URL of at most 2048 characters");
  }
  return trimmed;
};

// Google Play answers 0 when it does not know a time; that is "not sent", not 1970.
const seconds: Rule = (value, field) => {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < 0 ||
    value > MAX_SECONDS
  ) {
    throw invalid(field, "must be whole seconds since 1970");
  }
  return value === 0 ? undefined : value;
};

const platform: Rule = (value, field) => {
  if (!PLATFORMS.includes(value as typeof PLATFORMS[number])) {
    throw invalid(field, "must be ios or android");
  }
  return value;
};

const COMMON: Record<string, Rule> = {
  anonymous_id: text(200),
  session_id: text(100),
  platform,
  sdk: text(60),
  user_id: text(200, true),
  app_version: text(40),
  device_key: pattern(DEVICE_KEY, "must be 64 lowercase hex characters"),
};

const RULES: Record<AttributionKind, Record<string, Rule>> = {
  install: {
    ...COMMON,
    installed_at: time,
    link_url: httpsUrl,
    referrer: text(1024),
    referrer_click_ts: seconds,
    install_begin_ts: seconds,
    [APPLE_ADS_FIELD]: text(4096),
    clipboard_click: pattern(CLICK_ID, "must be a link click ID"),
  },
  open: {
    ...COMMON,
    url: httpsUrl,
    opened_at: time,
  },
};

/** Which fields each call needs and may send, as the contract lists them. */
export const FIELDS: Record<
  AttributionKind,
  { required: string[]; optional: string[] }
> = {
  install: {
    required: ["anonymous_id", "session_id", "platform", "installed_at", "sdk"],
    optional: [
      "user_id",
      "app_version",
      "device_key",
      "link_url",
      "referrer",
      "referrer_click_ts",
      "install_begin_ts",
      APPLE_ADS_FIELD,
      "clipboard_click",
    ],
  },
  open: {
    required: [
      "anonymous_id",
      "session_id",
      "platform",
      "url",
      "opened_at",
      "sdk",
    ],
    optional: ["user_id", "app_version", "device_key"],
  },
};

const absent = (value: unknown) =>
  value === undefined || value === null ||
  (typeof value === "string" && value.trim() === "");

/**
 * The body to pass on: every field the contract lists, checked, and nothing else. An
 * optional field sent as null or empty counts as not sent. Values are never echoed back.
 */
export function normalizeAttribution(
  raw: unknown,
  kind: AttributionKind,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RequestError(400, "invalid_body", "Send a JSON object.");
  }
  const sent = raw as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  const { required, optional } = FIELDS[kind];
  for (const field of [...required, ...optional]) {
    const value = sent[field];
    if (absent(value)) {
      if (required.includes(field)) {
        throw new AttributionRequestError(
          400,
          "missing_field",
          `${field} is required.`,
          { field },
        );
      }
      continue;
    }
    const checked = RULES[kind][field](value, field);
    if (checked !== undefined) body[field] = checked;
  }
  return body;
}

export const APPLE_ADS_URL = "https://api-adservices.apple.com/api/v1/";

export interface AppleAdsDependencies {
  fetch(url: string, init: RequestInit): Promise<Response>;
  sleep(ms: number): Promise<void>;
  timeoutMs: number;
}

const APPLE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Apple's answer, kept to plain values: campaign, ad group and keyword IDs, never a person. */
function appleAnswer(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (!APPLE_KEY.test(key)) continue;
    if (
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item)) ||
      (typeof item === "string" && item.length <= 200)
    ) out[key] = item;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Swaps the Apple Ads attribution token for Apple's answer: 200 gives the answer, 404 (not
 * ready yet) is tried once more after a second, and anything else, a timeout or a failure
 * gives null. The value is sent to Apple only, never logged.
 */
export async function appleAdsAttribution(
  value: string,
  deps: AppleAdsDependencies,
): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await deps.sleep(1_000);
    try {
      const response = await deps.fetch(APPLE_ADS_URL, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: value,
        redirect: "error",
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      if (response.status === 404 && attempt === 0) {
        await response.body?.cancel();
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return null;
      }
      const answer = await response.text();
      return answer.length <= 16_384 ? appleAnswer(JSON.parse(answer)) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The database's answer, as the contract's response section describes it. */
export function isAttributionAnswer(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const answer = value as Record<string, unknown>;
  return typeof answer.matched === "boolean" &&
    typeof answer.method === "string" &&
    (answer.deep_link === null ||
      (typeof answer.deep_link === "object" &&
        !Array.isArray(answer.deep_link)));
}

/**
 * The database's refusals, mapped as analytics_ingest's are. A function that names its
 * reason in the error's DETAIL (a one-word code) has it passed on as reason.
 */
export function attributionDatabaseError(
  error: { code?: string; message?: string; details?: string | null },
): RequestError {
  switch (error.code) {
    case "28000":
      return new RequestError(
        401,
        "invalid_key",
        "This API key is unknown or revoked.",
      );
    case "42501":
      return new RequestError(
        403,
        "origin_not_allowed",
        "This website is not allowed to use this key. Add it under the project's allowed websites.",
      );
    case "22023":
    case "22007":
    case "22P02": {
      const reason: Record<string, string> =
        typeof error.details === "string" &&
          /^[a-z][a-z0-9_]{1,59}$/.test(error.details)
          ? { reason: error.details }
          : {};
      return new AttributionRequestError(
        400,
        "invalid_request",
        error.message ?? "The request is malformed.",
        reason,
      );
    }
    default:
      return new RequestError(
        503,
        "unavailable",
        "Attribution is unavailable. Retry later.",
      );
  }
}
