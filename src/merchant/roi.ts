import type {
  CohortInterval,
  CostInput,
  LinkCost,
  MoneyRange,
  RevenueEvent,
  RoiFilters,
  RoiGroup,
  Unconverted,
} from './api'
import { ANALYTICS_ENDPOINT } from './config'
import { sourceLabel } from './attribution'
import { plural } from './format'

// Revenue, costs, return on ad spend and cohorts: the words, figures and files the attribution
// money screens share. Nothing here talks to the database.

export const moneyRangeOptions: Array<{ value: MoneyRange; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
]

// Money ---------------------------------------------------------------------------------------

const MINUS = '−'
const digitsByCurrency = new Map<string, number>()

/** How many decimals a currency is written with: 2 for dollars, 0 for yen. */
export function currencyDigits(currency: string): number {
  let digits = digitsByCurrency.get(currency)
  if (digits === undefined) {
    try {
      digits =
        new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
          .maximumFractionDigits ?? 2
    } catch {
      digits = 2
    }
    digitsByCurrency.set(currency, digits)
  }
  return digits
}

/**
 * Money as the console writes it elsewhere: "$1,234.56" for dollars, "1,234.56 EUR" for others.
 * whole leaves the cents off, for big figures in a tile.
 */
export function formatMoney(value: number, currency: string, whole = false): string {
  const digits = whole ? 0 : currencyDigits(currency)
  const figure = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(value))
  const sign = value < 0 && Number(figure.replace(/,/g, '')) !== 0 ? MINUS : ''
  return currency === 'USD' ? `${sign}$${figure}` : `${sign}${figure} ${currency}`
}

/** An axis tick: whole units, with cents only on a small scale such as 0.50. */
export function formatMoneyTick(value: number, currency: string): string {
  return formatMoney(value, currency, Number.isInteger(value))
}

/** A tile's figure: cents while it is small enough to read at a glance. */
export function formatMoneyTile(value: number, currency: string): string {
  return formatMoney(value, currency, Math.abs(value) >= 10_000)
}

/** Money that may have nothing to divide by: a dash then. */
export function formatMoneyOrDash(value: number | null, currency: string): string {
  return value === null ? '—' : formatMoney(value, currency)
}

/** A ratio as a share: 0.863 is "86%", 0.004 is "0.4%", 12.5 is "1,250%". Null is a dash. */
export function formatRatio(value: number | null): string {
  if (value === null) return '—'
  const percent = value * 100
  const digits = Math.abs(percent) > 0 && Math.abs(percent) < 10 ? 1 : 0
  const text = new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(percent)
  return `${text.replace('-', MINUS)}%`
}

/**
 * The currencies the European Central Bank publishes a daily rate for (besides the euro
 * itself). Payments and spend in any other currency can only be shown in that same currency.
 */
export const ECB_CURRENCIES = new Set([
  'EUR',
  'USD',
  'JPY',
  'BGN',
  'CZK',
  'DKK',
  'GBP',
  'HUF',
  'PLN',
  'RON',
  'SEK',
  'CHF',
  'ISK',
  'NOK',
  'TRY',
  'AUD',
  'BRL',
  'CAD',
  'CNY',
  'HKD',
  'IDR',
  'ILS',
  'INR',
  'KRW',
  'MXN',
  'MYR',
  'NZD',
  'PHP',
  'SGD',
  'THB',
  'ZAR',
])

const joinWords = (words: string[]) =>
  words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

/**
 * The note on payments and spend left out of a report because their currency has no daily rate,
 * or null when nothing was left out: "1 payment and 1 spend line in NGN aren't included: the
 * European Central Bank publishes no daily rate for it."
 */
export function unconvertedNote({ revenue, cost, currencies }: Unconverted): string | null {
  if (revenue <= 0 && cost <= 0) return null
  const parts = [
    revenue > 0 ? plural(revenue, 'payment') : '',
    cost > 0 ? plural(cost, 'spend line') : '',
  ].filter(Boolean)
  const verb = revenue + cost === 1 ? "isn't" : "aren't"
  if (!currencies.length)
    return `${joinWords(parts)} ${verb} included: the European Central Bank publishes no daily rate for ${revenue + cost === 1 ? 'its' : 'their'} currency.`
  return `${joinWords(parts)} in ${joinWords(currencies)} ${verb} included: the European Central Bank publishes no daily rate for ${currencies.length === 1 ? 'it' : 'them'}.`
}

// Names --------------------------------------------------------------------------------------

/** The report levels a source opens into, in order. */
export const ROI_LEVELS = ['source', 'campaign', 'adset', 'ad'] as const
export type RoiLevel = (typeof ROI_LEVELS)[number]

export const levelNouns: Record<RoiLevel, { one: string; title: string }> = {
  source: { one: 'source', title: 'Source' },
  campaign: { one: 'campaign', title: 'Campaign' },
  adset: { one: 'ad set', title: 'Ad set' },
  ad: { one: 'ad', title: 'Ad' },
}

/** A row's name at its level. A source with none is a person who came on their own. */
export function roiKeyLabel(level: RoiLevel, key: string | null): string {
  if (level === 'source') return key === null ? 'Direct and organic' : sourceLabel(key)
  if (key !== null) return key
  return level === 'campaign' ? 'No campaign' : level === 'adset' ? 'No ad set' : 'No ad'
}

/** The filters for a path of opened rows: [source] lists its campaigns, and so on. */
export function filtersFor(path: Array<string | null>): RoiFilters {
  const filters: RoiFilters = {}
  if (path.length > 0) filters.source = path[0]
  if (path.length > 1) filters.campaign = path[1]
  if (path.length > 2) filters.adset = path[2]
  return filters
}

/** The level a path of opened rows shows. */
export function levelFor(path: Array<string | null>): RoiLevel {
  return ROI_LEVELS[Math.min(path.length, ROI_LEVELS.length - 1)]
}

export function groupFor(path: Array<string | null>): Exclude<RoiGroup, 'day'> {
  return levelFor(path)
}

// Plain dates ---------------------------------------------------------------------------------
//
// Report days are calendar dates in the project's time zone, sent as YYYY-MM-DD, so they are
// read and written in UTC to stay on the same day.

const utc = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' })

const dayFormats = {
  short: utc({ month: 'short', day: 'numeric' }),
  weekday: utc({ weekday: 'short', month: 'short', day: 'numeric' }),
  long: utc({ month: 'short', day: 'numeric', year: 'numeric' }),
  month: utc({ month: 'long', year: 'numeric' }),
}

export function plainDate(day: string, style: keyof typeof dayFormats = 'short'): string {
  const time = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(time) ? dayFormats[style].format(time) : day
}

/** Today's date where the project counts its days. */
export function todayIn(timezone: string, now: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  } catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}

export function addDays(day: string, days: number): string {
  const time = Date.parse(`${day}T00:00:00Z`)
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10)
}

export function cohortLabel(interval: CohortInterval, start: string): string {
  if (interval === 'week') return `Week of ${plainDate(start)}`
  if (interval === 'month') return plainDate(start, 'month')
  return plainDate(start, 'weekday')
}

/**
 * One hue, deeper as the figure grows, as the retention table does. The square root keeps
 * small figures apart, and the cap keeps white text above 4.5:1 on the darkest cell.
 */
export function heatShade(share: number): string {
  const clamped = Math.min(1, Math.max(0, share))
  return `rgba(39, 159, 215, ${(0.1 + 0.6 * Math.sqrt(clamped)).toFixed(3)})`
}

// Revenue -------------------------------------------------------------------------------------

/** Why payments could not be counted, in plain words that follow "3 payments". */
export function skipReason(reason: string): string {
  switch (reason) {
    case 'no_currency':
      return 'came without a currency'
    case 'bad_currency':
      return 'had a currency that is not a three-letter code, such as USD'
    case 'bad_amount':
      return 'had an amount that was zero or not a number'
    case 'no_person':
      return 'came from your store tool for buyers your app has not sent yet'
    default:
      return 'could not be read'
  }
}

export const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/
export const PROPERTY_NAME = /^[A-Za-z_$][A-Za-z0-9_.$:-]{0,79}$/
export const MAX_REVENUE_EVENTS = 10

export type RevenueEventErrors = Partial<
  Record<'event' | 'amount_property' | 'currency_property' | 'currency', string>
>

/** What is wrong with each payment event, by its place in the list; empty when all can be saved. */
export function checkRevenueEvents(events: RevenueEvent[]): Map<number, RevenueEventErrors> {
  const found = new Map<number, RevenueEventErrors>()
  const seen = new Set<string>()
  events.forEach((item, index) => {
    const errors: RevenueEventErrors = {}
    const name = item.event.trim()
    if (!EVENT_NAME.test(name))
      errors.event = 'Event names use letters, numbers and _ . : -, starting with a letter.'
    else if (seen.has(name)) errors.event = `${name} is listed twice.`
    seen.add(name)
    if (!PROPERTY_NAME.test(item.amount_property.trim()))
      errors.amount_property = 'Name the property that holds the amount, such as value.'
    else if (item.amount_property.trim() === 'kma_revenue')
      errors.amount_property = 'kma_revenue counts on its own: no entry is needed for it.'
    if (item.currency_property !== null) {
      if (!PROPERTY_NAME.test(item.currency_property.trim()))
        errors.currency_property = 'Name the property that holds the currency, such as currency.'
    } else if (!/^[A-Z]{3}$/.test(item.currency ?? ''))
      errors.currency = 'Choose the currency these payments are in.'
    if (Object.keys(errors).length) found.set(index, errors)
  })
  return found
}

const DEFAULT_ENDPOINT = 'https://events.kissmyapps.dev'

/** The revenue call of each SDK, and the same payment sent from a server. */
export function revenueSnippets() {
  const endpoint = ANALYTICS_ENDPOINT || DEFAULT_ENDPOINT
  return {
    web: `// When a payment succeeds
kma('revenue', 59.99, 'USD', {
  productId: 'annual',
  transactionId: 'order-1042',
})

// A refund is the same call with a negative amount
kma('revenue', -59.99, 'USD', { transactionId: 'order-1042' })`,
    ios: `// When a purchase succeeds
KissMyApps.revenue(
  59.99,
  currency: "USD",
  productId: "annual",
  transactionId: "order-1042"
)

// A refund is the same call with a negative amount
KissMyApps.revenue(-59.99, currency: "USD", transactionId: "order-1042")`,
    android: `// When a purchase succeeds
KissMyApps.revenue(
  59.99,
  "USD",
  productId = "annual",
  transactionId = "order-1042",
)

// A refund is the same call with a negative amount
KissMyApps.revenue(-59.99, "USD", transactionId = "order-1042")`,
    reactNative: `// When a purchase succeeds
KissMyApps.revenue(59.99, 'USD', {
  productId: 'annual',
  transactionId: 'order-1042',
})

// A refund is the same call with a negative amount
KissMyApps.revenue(-59.99, 'USD', { transactionId: 'order-1042' })`,
    flutter: `// When a purchase succeeds
KissMyApps.revenue(
  59.99,
  'USD',
  productId: 'annual',
  transactionId: 'order-1042',
);

// A refund is the same call with a negative amount
KissMyApps.revenue(-59.99, 'USD', transactionId: 'order-1042');`,
    server: `curl ${endpoint}/v1/events \\
  -H "Authorization: Bearer kma_sk_live_YOUR_SERVER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "user_id": "user-42",
    "events": [{ "name": "purchase", "insert_id": "order-1042",
                 "properties": { "kma_revenue": 59.99, "kma_currency": "USD",
                                 "kma_product_id": "annual",
                                 "kma_transaction_id": "order-1042" } }]
  }'`,
  }
}

// Costs ---------------------------------------------------------------------------------------

export const SOURCE_NAME = /^[a-z0-9][a-z0-9_.-]{0,59}$/
export const MAX_COST_AMOUNT = 1_000_000_000
export const MAX_UPLOAD_ROWS = 5_000

/** The sources spend is most often for, offered with the project's own. */
export const COST_SOURCE_SUGGESTIONS = [
  'meta',
  'tiktok',
  'google_ads',
  'apple_ads',
  'snapchat',
  'x',
  'youtube',
  'influencer',
]

/** What each link's price added over a report's range: its installs or clicks, and the amounts by currency. */
export function linkCostTotals(
  lines: LinkCost[],
): Map<string, { count: number; amounts: Map<string, number> }> {
  const added = new Map<string, { count: number; amounts: Map<string, number> }>()
  for (const line of lines) {
    const entry = added.get(line.link_id) ?? { count: 0, amounts: new Map<string, number>() }
    entry.count += line.count
    // Cents, so 0.05 a click added up stays 0.15 and not 0.15000000000000002.
    const sum = (entry.amounts.get(line.currency) ?? 0) + line.amount
    entry.amounts.set(line.currency, Math.round(sum * 100) / 100)
    added.set(line.link_id, entry)
  }
  return added
}

/** A source as stored: lower case, spaces as underscores. */
export function sourceKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_')
}

/**
 * An amount as people type it or a spreadsheet exports it: "1,234.56", "$1 234.56", "1.234,56"
 * or "120,50". Thousands separators go; with both marks the last one is the decimal point.
 * Null when it is not a number.
 */
export function parseAmount(value: string): number | null {
  let text = value
    .trim()
    .replace(/[\s  ']/g, '')
    .replace(/^[^\d.,()-]+|[^\d.,)]+$/g, '')
  if (!text) return null
  let negative = false
  if (/^\(.*\)$/.test(text) || text.startsWith('-')) {
    negative = true
    text = text.replace(/^\(|\)$/g, '').replace(/^-/, '')
  }
  if (!/^[\d.,]+$/.test(text)) return null
  const lastDot = text.lastIndexOf('.')
  const lastComma = text.lastIndexOf(',')
  let normal: string
  if (lastDot >= 0 && lastComma >= 0) {
    // Both: whichever comes last is the decimal point.
    normal =
      lastDot > lastComma ? text.replace(/,/g, '') : text.replace(/\./g, '').replace(',', '.')
  } else if (lastComma >= 0 || lastDot >= 0) {
    const mark = lastComma >= 0 ? ',' : '.'
    const parts = text.split(mark)
    // "1,234" is a thousand; one dot is always a decimal point ("1.234"), two group ("1.234.567").
    const grouped =
      parts.length > (mark === '.' ? 2 : 1) && parts.slice(1).every((part) => part.length === 3)
    if (grouped && parts[0].length >= 1 && parts[0].length <= 3) normal = parts.join('')
    else if (parts.length === 2) normal = `${parts[0] || '0'}.${parts[1]}`
    else return null
  } else normal = text
  const parsed = Number(normal)
  if (!Number.isFinite(parsed)) return null
  return negative ? -parsed : parsed
}

/** YYYY-MM-DD, also written with slashes or dots, or with a time after it. */
export function parseDay(value: string): string | null {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(value.trim())
  if (!match) return null
  const day = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  const time = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(day) ? day : null
}

export type CostDraft = {
  day: string
  source: string
  campaign: string
  adset: string
  ad: string
  amount: string
  currency: string
}

export type CostDraftErrors = Partial<Record<keyof CostDraft, string>>

/** What is wrong with a day's spend before it is sent; the database checks the same. */
export function checkCostDraft(
  draft: CostDraft,
  today: string,
): { errors: CostDraftErrors; input: CostInput | null } {
  const errors: CostDraftErrors = {}
  const day = parseDay(draft.day)
  if (!day) errors.day = 'Choose the day the money was spent.'
  else if (day > today) errors.day = 'Spend can only be added for today or earlier.'
  else if (day < addDays(today, -730)) errors.day = 'Spend can go back up to two years.'
  const source = sourceKey(draft.source)
  if (!SOURCE_NAME.test(source))
    errors.source = 'Name the source in letters, numbers and _ . -, such as meta.'
  const campaign = draft.campaign.trim()
  const adset = draft.adset.trim()
  const ad = draft.ad.trim()
  if (adset && !campaign) errors.adset = 'An ad set needs its campaign.'
  if (ad && !adset) errors.ad = 'An ad needs its ad set.'
  for (const [key, value] of [
    ['campaign', campaign],
    ['adset', adset],
    ['ad', ad],
  ] as const)
    if (value.length > 200) errors[key] = 'Use up to 200 characters.'
  const amount = parseAmount(draft.amount)
  if (amount === null) errors.amount = 'Enter what was spent, such as 120.50.'
  else if (amount < 0) errors.amount = 'Spend cannot be below zero.'
  else if (amount > MAX_COST_AMOUNT) errors.amount = 'That is more than a billion.'
  const currency = draft.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'Choose a currency.'
  if (Object.keys(errors).length || !day || amount === null) return { errors, input: null }
  return {
    errors,
    input: {
      day,
      source,
      ...(campaign ? { campaign } : {}),
      ...(adset ? { adset } : {}),
      ...(ad ? { ad } : {}),
      amount,
      currency,
    },
  }
}

/** The first line of the spreadsheet template. */
export const COST_COLUMNS = ['day', 'source', 'campaign', 'adset', 'ad', 'amount', 'currency']

type CostColumn = (typeof COST_COLUMNS)[number]

const HEADER_NAMES: Record<string, CostColumn> = {
  day: 'day',
  date: 'day',
  source: 'source',
  'media source': 'source',
  campaign: 'campaign',
  'campaign name': 'campaign',
  adset: 'adset',
  'ad set': 'adset',
  'ad set name': 'adset',
  'ad group': 'adset',
  ad: 'ad',
  'ad name': 'ad',
  amount: 'amount',
  spend: 'amount',
  cost: 'amount',
  'amount spent': 'amount',
  currency: 'currency',
}

/** A heading as the template names it: "Amount spent (USD)" is amount. */
function columnOf(heading: string): CostColumn | null {
  const name = heading
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[\s_-]+/g, ' ')
    .trim()
  return HEADER_NAMES[name] ?? null
}

/** Splits CSV text into rows of cells: quoted cells, doubled quotes, CRLF and a leading BOM. */
export function splitCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, '')
  const firstLine = source.slice(0, source.search(/\r?\n|$/))
  // The delimiter the first line uses most outside quotes: comma, semicolon or tab.
  const delimiter =
    ([',', ';', '\t'] as const)
      .map((mark) => ({ mark, count: firstLine.replace(/"[^"]*"/g, '').split(mark).length - 1 }))
      .sort((a, b) => b.count - a.count)
      .find((entry) => entry.count > 0)?.mark ?? ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"' && cell.trim() === '') {
      quoted = true
      cell = ''
    } else if (char === delimiter) {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += char
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

export type ParsedCosts = {
  /** Each row to send, with the line of the file it came from (the heading is line 1). */
  rows: Array<{ line: number; input: CostInput }>
  /** Problems with single rows, by line. */
  errors: Array<{ line: number; message: string }>
  /** A problem with the whole file; nothing can be sent. */
  problem: string | null
}

/** Reads a spend spreadsheet in the browser, so the upload sends rows, not a file. */
export function parseCostCsv(text: string): ParsedCosts {
  const lines = splitCsv(text)
  const headingAt = lines.findIndex((cells) => cells.some((cell) => cell.trim()))
  if (headingAt < 0) return { rows: [], errors: [], problem: 'The file is empty.' }
  const columns = lines[headingAt].map(columnOf)
  const missing = (['day', 'source', 'amount'] as const).filter((name) => !columns.includes(name))
  if (missing.length)
    return {
      rows: [],
      errors: [],
      problem: `The first line names the columns, and needs ${missing.join(', ')}. Download the template to see them.`,
    }
  const rows: ParsedCosts['rows'] = []
  const errors: ParsedCosts['errors'] = []
  lines.slice(headingAt + 1).forEach((cells, offset) => {
    if (!cells.some((cell) => cell.trim())) return
    const line = headingAt + offset + 2
    const value = (name: CostColumn) => {
      const at = columns.indexOf(name)
      return at >= 0 ? (cells[at] ?? '').trim() : ''
    }
    const rawDay = value('day')
    const day = parseDay(rawDay)
    const amountText = value('amount')
    const amount = parseAmount(amountText)
    const source = sourceKey(value('source'))
    const currency = value('currency').toUpperCase()
    const campaign = value('campaign')
    const adset = value('adset')
    const ad = value('ad')
    const problems: string[] = []
    if (!day) problems.push(`write the day as YYYY-MM-DD, not “${rawDay || 'empty'}”`)
    if (!source) problems.push('the source is empty')
    else if (!SOURCE_NAME.test(source))
      problems.push(`the source “${value('source')}” can use letters, numbers and _ . - only`)
    if (adset && !campaign) problems.push('an ad set needs its campaign')
    if (ad && !adset) problems.push('an ad needs its ad set')
    if (amount === null) problems.push(`the amount “${amountText || 'empty'}” is not a number`)
    else if (amount < 0) problems.push('spend cannot be below zero')
    if (currency && !/^[A-Z]{3}$/.test(currency))
      problems.push(`the currency “${currency}” is not a three-letter code`)
    if (problems.length || !day || amount === null) {
      const text = problems.join('; ')
      errors.push({ line, message: text.charAt(0).toUpperCase() + text.slice(1) + '.' })
      return
    }
    rows.push({
      line,
      input: {
        day,
        source,
        ...(campaign ? { campaign } : {}),
        ...(adset ? { adset } : {}),
        ...(ad ? { ad } : {}),
        amount,
        ...(currency ? { currency } : {}),
      },
    })
  })
  const total = rows.length + errors.length
  if (!total) return { rows: [], errors: [], problem: 'The file has no rows under its first line.' }
  if (total > MAX_UPLOAD_ROWS)
    return {
      rows: [],
      errors: [],
      problem: `Upload up to ${MAX_UPLOAD_ROWS.toLocaleString('en-US')} rows at a time; this file has ${total.toLocaleString('en-US')}. Split it and upload each part.`,
    }
  return { rows, errors, problem: null }
}
