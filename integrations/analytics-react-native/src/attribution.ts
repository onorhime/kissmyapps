// The two attribution calls every KissMyApps app SDK makes: one install call on the first
// launch, and one open call for each link that opens the app later. What goes in them, and
// what comes back, is the `attribution` section of
// integrations/analytics-mobile/contract/app-events.json.

/** A deep link from KissMyApps, handed to `onDeepLink` once. */
export interface DeepLink {
  /** The link's deep link value, such as `lesson`, or null when it has only parameters. */
  value: string | null
  /** The deep link's parameters, such as `{ id: '4' }`. */
  params: Record<string, string>
  /** True when it came through an install (a deferred deep link), false when a link opened the app. */
  deferred: boolean
  /** The link that opened the app, or null when the deep link came from the store install. */
  url: string | null
}

/** What the optional native module `KissMyAppsAttribution` reads on the device. */
export interface AttributionInfo {
  /** Lowercase hex SHA-256 of identifierForVendor (iOS) or ANDROID_ID (Android). */
  deviceKey?: string | null
  /** The Google Play install referrer (Android). */
  referrer?: string | null
  /** Seconds since 1970, from the Install Referrer API (Android). */
  referrerClickTs?: number | null
  /** Seconds since 1970, from the Install Referrer API (Android). */
  installBeginTs?: number | null
  /** AAAttribution.attributionToken() (iOS 14.3+). */
  appleAdsToken?: string | null
  /** The click ID after `kma:` on the clipboard, read only when clipboard handoff is on (iOS). */
  clipboardClick?: string | null
  /** True when Google Play did not answer in time: the next try reads the referrer again. */
  retryReferrer?: boolean
}

/** What the SDK asks the native module for. */
export interface AttributionRequest {
  /** The first launch: also the install referrer or Apple Ads token; otherwise the device key only. */
  install: boolean
  /** Read a `kma:` click ID from the clipboard (iOS, clipboard handoff on). */
  clipboard: boolean
}

export const INSTALL_PATH = '/v1/attribution/install'
export const OPEN_PATH = '/v1/attribution/open'

const MAX_URL = 2048
const MAX_PARAMS = 10
const MAX_REFERRER = 1024
const MAX_APPLE_ADS = 4096
const DEVICE_KEY = /^[0-9a-f]{64}$/
const CLICK_ID = /^[A-Za-z0-9_-]{16,40}$/
// React Native's URL class leaves most of its parts unimplemented, so links are read by hand.
const HTTPS_URL = /^https:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i

/** The link as the SDK sends it: an https URL of at most 2,048 characters, or null. */
export function httpsLink(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const link = value.trim()
  return link.length <= MAX_URL && HTTPS_URL.test(link) ? link : null
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function seconds(value: unknown): number | null {
  // Play answers 0 when it does not know.
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

/** The device key when it is one: 64 lowercase hex characters. */
export function deviceKey(value: unknown): string | null {
  return typeof value === 'string' && DEVICE_KEY.test(value) ? value : null
}

export interface InstallInput {
  anonymousId: string
  sessionId: string
  platform: 'ios' | 'android'
  /** When app_installed was queued, in milliseconds since 1970. */
  installedAt: number
  sdk: string
  userId?: string | null
  appVersion?: string
  /** The link that opened the app on this launch, if any. */
  link?: string | null
  info: AttributionInfo
  /** Whether the app turned clipboard handoff on. */
  clipboard: boolean
}

/** The body of POST /v1/attribution/install. */
export function installBody(input: InstallInput): Record<string, unknown> {
  const { info } = input
  const body: Record<string, unknown> = {
    anonymous_id: input.anonymousId,
    session_id: input.sessionId,
    platform: input.platform,
    installed_at: new Date(input.installedAt).toISOString(),
    sdk: input.sdk,
  }
  if (input.userId) body.user_id = input.userId
  if (input.appVersion) body.app_version = input.appVersion
  const key = deviceKey(info.deviceKey)
  if (key) body.device_key = key
  const link = httpsLink(input.link)
  if (link) body.link_url = link
  if (input.platform === 'android') {
    // A longer referrer is cut to the contract's 1,024 characters.
    const referrer =
      typeof info.referrer === 'string' && info.referrer
        ? info.referrer.slice(0, MAX_REFERRER)
        : null
    const clicked = seconds(info.referrerClickTs)
    const began = seconds(info.installBeginTs)
    if (referrer) body.referrer = referrer
    if (clicked !== null) body.referrer_click_ts = clicked
    if (began !== null) body.install_begin_ts = began
  } else {
    const appleAds = text(info.appleAdsToken, MAX_APPLE_ADS)
    if (appleAds) body.apple_ads_token = appleAds
    const click = typeof info.clipboardClick === 'string' ? info.clipboardClick.trim() : ''
    if (input.clipboard && CLICK_ID.test(click)) body.clipboard_click = click
  }
  return body
}

export interface OpenInput {
  anonymousId: string
  sessionId: string
  platform: 'ios' | 'android'
  url: string
  /** When the link opened the app, in milliseconds since 1970. */
  openedAt: number
  sdk: string
  userId?: string | null
  appVersion?: string
  deviceKey?: string | null
}

/** The body of POST /v1/attribution/open. */
export function openBody(input: OpenInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    anonymous_id: input.anonymousId,
    session_id: input.sessionId,
    platform: input.platform,
    url: input.url,
    opened_at: new Date(input.openedAt).toISOString(),
    sdk: input.sdk,
  }
  if (input.userId) body.user_id = input.userId
  if (input.appVersion) body.app_version = input.appVersion
  const key = deviceKey(input.deviceKey)
  if (key) body.device_key = key
  return body
}

/** The deep link in an answer from either call, or null when it has none. */
export function deepLinkFrom(answer: unknown, url: string | null): DeepLink | null {
  if (!answer || typeof answer !== 'object') return null
  const link = (answer as { deep_link?: unknown }).deep_link
  if (!link || typeof link !== 'object' || Array.isArray(link)) return null
  const { value, params, deferred } = link as Record<string, unknown>
  const clean: Record<string, string> = {}
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    for (const [name, item] of Object.entries(params)) {
      if (Object.keys(clean).length >= MAX_PARAMS) break
      // Text as it is; numbers and true/false as text; anything else is left out.
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        clean[name] = String(item)
      }
    }
  }
  return {
    value: typeof value === 'string' ? value : null,
    params: clean,
    deferred: deferred === true,
    url,
  }
}

/** The answer's JSON, or null when it is not JSON. */
export function parseAnswer(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/** Settles with the promise's value, or with `fallback` after `ms` or when it fails. */
export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}
