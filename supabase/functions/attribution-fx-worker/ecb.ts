// The European Central Bank's euro reference rates, read from its XML files
// (https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/).
// Each file is one <Cube> per day, <Cube time="2026-11-12">, holding one
// <Cube currency="USD" rate="1.1580"/> per currency: how many of the currency
// one euro bought that day. The daily file writes attributes in single quotes
// with indentation, the history files in double quotes on one line; any layout
// is read here with two regular expressions, without an XML library.

export type EcbRange = "daily" | "90d" | "all";

export const ECB_URLS: Readonly<Record<EcbRange, string>> = {
  daily: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
  "90d": "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml",
  all: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml",
};

/** One rate as attribution_fx_store takes it. */
export interface EcbRate {
  day: string;
  currency: string;
  per_eur: number;
}

export interface EcbRates {
  rates: EcbRate[];
  /** Days with at least one rate. */
  days: number;
  /** Currency cubes that could not be read (no day, a bad code or rate). */
  skipped: number;
}

const COMMENT = /<!--[\s\S]*?-->/g;
const CUBE = /<Cube\b([^>]*)>/g;
const ATTRIBUTE = /([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DECIMAL = /^[0-9]{1,12}(\.[0-9]{1,12})?$/;

/** A calendar day written YYYY-MM-DD. */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value;
}

/** Every currency rate of an ECB file, in the file's order. The euro is never listed. */
export function parseEcbXml(xml: string): EcbRates {
  const rates: EcbRate[] = [];
  const days = new Set<string>();
  let day: string | null = null;
  let skipped = 0;
  for (const tag of xml.replace(COMMENT, "").matchAll(CUBE)) {
    const attributes = new Map<string, string>();
    for (const match of tag[1].matchAll(ATTRIBUTE)) {
      attributes.set(match[1], match[2] ?? match[3]);
    }
    const time = attributes.get("time");
    if (time !== undefined) {
      day = isDay(time.trim()) ? time.trim() : null;
      continue;
    }
    const currency = attributes.get("currency")?.trim();
    const rate = attributes.get("rate")?.trim();
    // The cube around the days carries nothing.
    if (currency === undefined && rate === undefined) continue;
    const value = rate !== undefined && DECIMAL.test(rate) ? Number(rate) : NaN;
    if (
      day === null || currency === undefined ||
      !/^[A-Z]{3}$/.test(currency) || currency === "EUR" ||
      !Number.isFinite(value) || value <= 0
    ) {
      skipped += 1;
      continue;
    }
    days.add(day);
    rates.push({ day, currency, per_eur: value });
  }
  return { rates, days: days.size, skipped };
}
