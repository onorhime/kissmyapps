import type { BotRule, Platform, Traits } from './api'

const integer = new Intl.NumberFormat('en-US')
const oneDecimal = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

export function formatCount(value: number): string {
  return integer.format(Math.round(value))
}

export function formatDecimal(value: number, digits = 1): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value)
}

/** Axis ticks: 0, 500, 1K, 2.5K, 1.2M. */
export function formatCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (abs >= 1_000) return `${trim(value / 1_000)}K`
  return trim(value)
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : oneDecimal.format(value).replace(/\.0$/, '')
}

export function formatPercent(part: number, whole: number): string {
  if (!whole) return '0%'
  const share = (part / whole) * 100
  if (share > 0 && share < 1) return '<1%'
  return `${Math.round(share)}%`
}

export type Tone = 'positive' | 'negative' | 'neutral'

/** A change with its sign, coloured by whether the move is good for this metric. */
export function formatChange(
  current: number,
  previous: number,
  goodWhenUp = true,
): { text: string; tone: Tone } {
  if (previous === 0) {
    return current === 0
      ? { text: 'No change', tone: 'neutral' }
      : { text: `+${formatCount(current)} (new)`, tone: 'neutral' }
  }
  // Percentages on small counts swing wildly, so show the difference instead.
  if (Number.isInteger(current) && Number.isInteger(previous) && Math.max(current, previous) < 20) {
    const difference = current - previous
    if (difference === 0) return { text: 'No change', tone: 'neutral' }
    return {
      text: `${difference > 0 ? '+' : '−'}${formatCount(Math.abs(difference))}`,
      tone: difference > 0 === goodWhenUp ? 'positive' : 'negative',
    }
  }
  const change = ((current - previous) / previous) * 100
  if (Math.abs(change) < 0.05) return { text: 'No change', tone: 'neutral' }
  const up = change > 0
  return {
    text: `${up ? '+' : '−'}${oneDecimal.format(Math.abs(change))}%`,
    tone: up === goodWhenUp ? 'positive' : 'negative',
  }
}

/** 42 s, 3 m 12 s, 1 h 04 m. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total} s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours) return `${hours} h ${String(minutes).padStart(2, '0')} m`
  const rest = total % 60
  return rest ? `${minutes} m ${String(rest).padStart(2, '0')} s` : `${minutes} m`
}

/** 0:42, 12:07, 1:02:09 for a replay clock. */
export function formatClockDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

export function formatAgo(time: number | string, now: number): string {
  const at = typeof time === 'string' ? Date.parse(time) : time
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 45) return `${days} days ago`
  return `${Math.round(days / 30)} months ago`
}

const timeFormats = new Map<string, Intl.DateTimeFormat>()
function zoned(timezone: string, options: Intl.DateTimeFormatOptions, locale = 'en-GB') {
  const key = `${timezone}|${locale}|${JSON.stringify(options)}`
  let format = timeFormats.get(key)
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone })
    } catch {
      format = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' })
    }
    timeFormats.set(key, format)
  }
  return format
}

const at = (time: number | string) => (typeof time === 'string' ? Date.parse(time) : time)

/** Times are shown in the project's time zone, the same one its days are counted in. */
export function timeIn(timezone: string) {
  return {
    clock: (time: number | string) =>
      zoned(timezone, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(at(time)),
    time: (time: number | string) =>
      zoned(timezone, { hour: '2-digit', minute: '2-digit', hour12: false }).format(at(time)),
    date: (time: number | string) =>
      zoned(timezone, { month: 'short', day: 'numeric' }, 'en-US').format(at(time)),
    weekday: (time: number | string) =>
      zoned(timezone, { weekday: 'short', month: 'short', day: 'numeric' }, 'en-US').format(
        at(time),
      ),
    longDate: (time: number | string) =>
      zoned(timezone, { month: 'short', day: 'numeric', year: 'numeric' }, 'en-US').format(
        at(time),
      ),
    dateTime: (time: number | string) =>
      `${zoned(timezone, { month: 'short', day: 'numeric' }, 'en-US').format(at(time))}, ${zoned(
        timezone,
        {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        },
      ).format(at(time))}`,
  }
}

/** The person's own wall clock: "14:32 in Lagos (UTC+1)". */
export function localClock(timezone: string | null, now: number): string | null {
  if (!timezone) return null
  try {
    const time = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
    }).format(now)
    const offset = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    })
      .formatToParts(now)
      .find((part) => part.type === 'timeZoneName')?.value
    return `${time} (${offset?.replace('GMT', 'UTC') ?? timezone})`
  } catch {
    return null
  }
}

let regions: Intl.DisplayNames | null = null
let languages: Intl.DisplayNames | null = null

export function countryName(code: string | null | undefined): string {
  if (!code) return 'Unknown'
  try {
    regions ??= new Intl.DisplayNames(['en'], { type: 'region' })
    return regions.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

export function languageName(code: string | null | undefined): string {
  if (!code) return 'Unknown'
  try {
    languages ??= new Intl.DisplayNames(['en'], { type: 'language' })
    return languages.of(code) ?? code
  } catch {
    return code
  }
}

export const platformLabels: Record<Platform, string> = {
  ios: 'iOS app',
  android: 'Android app',
  web: 'Website',
  server: 'Server',
}

export const deviceTypeLabels: Record<string, string> = {
  mobile: 'Phone',
  tablet: 'Tablet',
  desktop: 'Computer',
  unknown: 'Unknown',
}

export const botRuleLabels: Record<BotRule, { name: string; detail: string }> = {
  automation: {
    name: 'Automated browser',
    detail: 'Headless or remote-controlled browsers, such as Puppeteer, Playwright or Selenium.',
  },
  crawler: {
    name: 'Crawler',
    detail: 'Search engines, link previews, scrapers and scripts that name themselves as bots.',
  },
  too_fast: {
    name: 'Too fast',
    detail: 'More than 3 events a second across 20 or more events.',
  },
  no_interaction: {
    name: 'No interaction',
    detail: 'Five or more pages in a session without a single click, key press or scroll.',
  },
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** How a person is shown: their name or email when the app sent one, else their ID. */
export function personLabel(person: {
  traits?: Traits | null
  distinct_id: string
  user_id?: string | null
}): {
  name: string
  detail: string | null
  anonymous: boolean
} {
  const traits = person.traits ?? {}
  const name = text(traits.name) ?? text(traits.full_name) ?? text(traits.username)
  const email = text(traits.email)
  const anonymous = !person.user_id
  if (name) return { name, detail: email ?? person.distinct_id, anonymous }
  if (email) return { name: email, detail: person.user_id ?? null, anonymous }
  if (!anonymous) return { name: person.distinct_id, detail: null, anonymous }
  return {
    name: `Anonymous ${person.distinct_id.slice(0, 6)}`,
    detail: person.distinct_id,
    anonymous,
  }
}

/** A stable pale tint per person, so the same person looks the same on every screen. */
export function personHue(id: string): number {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  return hash % 6
}

export function deviceLabel(item: {
  platform?: Platform | null
  device_model?: string | null
  device_type?: string | null
  os_name?: string | null
  os_version?: string | null
  browser?: string | null
  browser_version?: string | null
  app_version?: string | null
}): { primary: string; secondary: string | null } {
  const os = [item.os_name, item.os_version].filter(Boolean).join(' ') || null
  if (item.platform === 'web') {
    const browser = [item.browser, item.browser_version?.split('.')[0]].filter(Boolean).join(' ')
    const where =
      item.device_model ?? (item.device_type ? deviceTypeLabels[item.device_type] : null)
    return {
      primary: browser || 'Browser',
      secondary: [os, where].filter(Boolean).join(' · ') || null,
    }
  }
  if (item.platform === 'server') return { primary: 'Server', secondary: null }
  const app = item.app_version ? `App ${item.app_version}` : null
  return {
    primary:
      item.device_model ?? (item.device_type ? deviceTypeLabels[item.device_type] : 'Device'),
    secondary: [os, app].filter(Boolean).join(' · ') || null,
  }
}

type Place = { country?: string | null; region?: string | null; city?: string | null }

/** The short place for lists: "Ikeja, Nigeria". */
export function placeLabel(item: Place): string {
  if (!item.country) return 'Unknown'
  const city = item.city && item.city !== item.region ? item.city : null
  return [city ?? item.region, countryName(item.country)].filter(Boolean).join(', ')
}

/** The whole place for a profile or session: "Ikeja, Lagos, Nigeria". */
export function fullPlace(item: Place): string {
  if (!item.country) return 'Unknown'
  const region = item.region && item.region !== item.city ? item.region : null
  return [item.city, region, countryName(item.country)].filter(Boolean).join(', ')
}

/** How a session's place was found, for the line under it. */
export const placeSources: Record<string, string> = {
  ip: 'From their internet address',
  edge: 'From their internet address',
  api: 'Sent by your server',
  timezone: 'From the device time zone',
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`
}

export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null
  try {
    return new URL(referrer).host.replace(/^www\./, '')
  } catch {
    return referrer
  }
}
