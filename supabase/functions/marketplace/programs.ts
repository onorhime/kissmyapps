// The two shapes the public marketplace hands out, and nothing else. Each
// reader copies the named fields out of what the database returned, so a
// field added to the database answer later never reaches the public by
// accident. Anything that does not fit the shape is refused (null).

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const COMMISSION_TYPES = ["percent", "fixed"] as const;
const COMMISSION_DURATIONS = ["first_payment", "months", "lifetime"] as const;
const APPROVAL_MODES = ["automatic", "manual"] as const;
const PUBLIC_STATUSES = ["live", "paused"] as const;
const EARN_FROM = ["sales", "events", "both"] as const;
const REWARD_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;

export const MAXIMUM_SLUG_LENGTH = 80;
export const MAXIMUM_REWARDS = 5;
export const MAXIMUM_REWARD_LABEL_LENGTH = 40;
export const MAXIMUM_REWARD_MINOR = 100_000_000;

/** One event a program pays for: what creators read and what it pays. */
export interface ProgramReward {
  key: string;
  label: string;
  amount_minor: number;
}

export interface ProgramCard {
  slug: string;
  name: string;
  category: string | null;
  tagline: string | null;
  logo_path: string | null;
  brand_name: string | null;
  /** Null only for a program that pays for events and not for sales. */
  commission_type: typeof COMMISSION_TYPES[number] | null;
  commission_rate_bps: number | null;
  commission_fixed_minor: number | null;
  currency: string;
  commission_duration: typeof COMMISSION_DURATIONS[number] | null;
  commission_months: number | null;
  attribution_window_days: number;
  hold_days: number;
  minimum_payout_minor: number;
  approval_mode: typeof APPROVAL_MODES[number];
  terms_version: number;
  /**
   * What creators earn from, and the rewards for events. Both are left out of
   * an answer from before programs could pay for events: that is a sales
   * program with no rewards.
   */
  earn_from?: typeof EARN_FROM[number];
  rewards?: ProgramReward[];
}

export interface AgreementDoc {
  title: string;
  brand_name: string;
  program_name: string;
  summary: { label: string; value: string }[];
  sections: { heading: string; paragraphs: string[] }[];
  extra_terms: string | null;
}

export interface ProgramDetail extends ProgramCard {
  status: typeof PUBLIC_STATUSES[number];
  landing_url: string;
  agreement: AgreementDoc;
  agreement_sha256: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || isText(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCountOrNull(value: unknown): value is number | null {
  return value === null || isCount(value);
}

function isOneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** True for an address a marketplace program can have. */
export function isProgramSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAXIMUM_SLUG_LENGTH &&
    SLUG.test(value);
}

/** Reads the rewards of a card. One reward that does not fit refuses them all. */
function programRewards(value: unknown): ProgramReward[] | null {
  if (!Array.isArray(value) || value.length > MAXIMUM_REWARDS) return null;
  const rewards: ProgramReward[] = [];
  for (const entry of value) {
    if (!isObject(entry)) return null;
    const { key, amount_minor } = entry;
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (
      typeof key !== "string" || !REWARD_KEY.test(key) ||
      rewards.some((reward) => reward.key === key) || label === "" ||
      [...label].length > MAXIMUM_REWARD_LABEL_LENGTH ||
      !isCount(amount_minor) || amount_minor < 1 ||
      amount_minor > MAXIMUM_REWARD_MINOR
    ) return null;
    rewards.push({ key, label, amount_minor });
  }
  return rewards;
}

/**
 * What the card says creators earn from, checked against its commission.
 * `{}` for an answer from before programs could pay for events (neither key,
 * or both null), which must have a commission as it always did. `null` when
 * the card is not whole: sales and both need a commission, events must have
 * none, events and both need at least one reward, sales has none.
 */
function programEarnFrom(
  value: Json,
): Pick<ProgramCard, "earn_from" | "rewards"> | null {
  const commission = [
    value.commission_type,
    value.commission_rate_bps,
    value.commission_fixed_minor,
    value.commission_duration,
    value.commission_months,
  ];
  const hasCommission = value.commission_type !== null &&
    value.commission_duration !== null;
  if ((value.earn_from ?? null) === null && (value.rewards ?? null) === null) {
    return hasCommission ? {} : null;
  }
  const { earn_from } = value;
  const rewards = programRewards(value.rewards);
  if (!isOneOf(EARN_FROM, earn_from) || !rewards) return null;
  if (
    earn_from === "events"
      ? commission.some((field) => field !== null)
      : !hasCommission
  ) return null;
  if ((earn_from === "sales") !== (rewards.length === 0)) return null;
  return { earn_from, rewards };
}

export function programCard(value: unknown): ProgramCard | null {
  if (!isObject(value)) return null;
  const {
    slug,
    name,
    category,
    tagline,
    logo_path,
    brand_name,
    commission_type,
    commission_rate_bps,
    commission_fixed_minor,
    currency,
    commission_duration,
    commission_months,
    attribution_window_days,
    hold_days,
    minimum_payout_minor,
    approval_mode,
    terms_version,
  } = value;
  if (
    !isProgramSlug(slug) || !isText(name) || !isTextOrNull(category) ||
    !isTextOrNull(tagline) || !isTextOrNull(logo_path) ||
    !isTextOrNull(brand_name) ||
    !(commission_type === null ||
      isOneOf(COMMISSION_TYPES, commission_type)) ||
    !isCountOrNull(commission_rate_bps) ||
    !isCountOrNull(commission_fixed_minor) ||
    typeof currency !== "string" || !CURRENCY.test(currency) ||
    !(commission_duration === null ||
      isOneOf(COMMISSION_DURATIONS, commission_duration)) ||
    !isCountOrNull(commission_months) || !isCount(attribution_window_days) ||
    !isCount(hold_days) || !isCount(minimum_payout_minor) ||
    !isOneOf(APPROVAL_MODES, approval_mode) || !isCount(terms_version) ||
    terms_version < 1
  ) return null;
  const pays = programEarnFrom(value);
  if (!pays) return null;
  return {
    slug,
    name,
    category,
    tagline,
    logo_path,
    brand_name,
    commission_type,
    commission_rate_bps,
    commission_fixed_minor,
    currency,
    commission_duration,
    commission_months,
    attribution_window_days,
    hold_days,
    minimum_payout_minor,
    approval_mode,
    terms_version,
    ...pays,
  };
}

function agreementDoc(value: unknown): AgreementDoc | null {
  if (!isObject(value)) return null;
  const { title, brand_name, program_name, summary, sections, extra_terms } =
    value;
  if (
    !isText(title) || !isText(brand_name) || !isText(program_name) ||
    !Array.isArray(summary) || !Array.isArray(sections) ||
    !isTextOrNull(extra_terms)
  ) return null;
  const rows: AgreementDoc["summary"] = [];
  for (const row of summary) {
    if (
      !isObject(row) || typeof row.label !== "string" ||
      typeof row.value !== "string"
    ) return null;
    rows.push({ label: row.label, value: row.value });
  }
  const parts: AgreementDoc["sections"] = [];
  for (const section of sections) {
    if (
      !isObject(section) || typeof section.heading !== "string" ||
      !Array.isArray(section.paragraphs) ||
      !section.paragraphs.every((text): text is string =>
        typeof text === "string"
      )
    ) return null;
    parts.push({
      heading: section.heading,
      paragraphs: [...section.paragraphs],
    });
  }
  return {
    title,
    brand_name,
    program_name,
    summary: rows,
    sections: parts,
    extra_terms,
  };
}

export function programDetail(value: unknown): ProgramDetail | null {
  const card = programCard(value);
  if (!card || !isObject(value)) return null;
  const agreement = agreementDoc(value.agreement);
  const { status, landing_url, agreement_sha256 } = value;
  if (
    !agreement || !isOneOf(PUBLIC_STATUSES, status) ||
    !isHttpsUrl(landing_url) || typeof agreement_sha256 !== "string" ||
    !SHA256.test(agreement_sha256)
  ) return null;
  return { ...card, status, landing_url, agreement, agreement_sha256 };
}

/** Reads `{"programs": [...]}`. One card that does not fit refuses the list. */
export function programList(value: unknown): ProgramCard[] | null {
  if (!isObject(value) || !Array.isArray(value.programs)) return null;
  const cards: ProgramCard[] = [];
  for (const entry of value.programs) {
    const card = programCard(entry);
    if (!card) return null;
    cards.push(card);
  }
  return cards;
}

/**
 * Reads `{"program": {...} | null}`. `undefined` means the answer did not fit
 * the shape; `null` means there is no such program.
 */
export function programAnswer(
  value: unknown,
): ProgramDetail | null | undefined {
  if (!isObject(value) || !Object.hasOwn(value, "program")) return undefined;
  if (value.program === null) return null;
  return programDetail(value.program) ?? undefined;
}
