const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const OFFER_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ALLOWED_BROWSER_EVENTS = new Set([
  'landing_viewed',
  'funnel_started',
  'payment_viewed',
  'app_store_clicked',
])

const ALLOWED_BROWSER_PROPERTIES = new Set([
  'device_type',
  'experiment',
  'locale',
  'page_name',
  'page_path',
  'placement',
  'referrer_host',
  'variant',
])

const FORBIDDEN_PROPERTY_NAMES = new Set([
  'address',
  'card',
  'card_number',
  'email',
  'email_address',
  'first_name',
  'full_name',
  'last_name',
  'password',
  'phone',
  'phone_number',
  'secret',
  'token',
])

export const ATTRIBUTION_QUERY_PARAMETER = 'kma_click'
export const ATTRIBUTION_STORAGE_KEY = 'kma_attribution_v1'
export const PENDING_ATTRIBUTION_STORAGE_KEY = 'kma_attribution_pending_v1'
export const DEFAULT_ATTRIBUTION_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000
export const MAX_ATTRIBUTION_TTL_MILLISECONDS = 90 * 24 * 60 * 60 * 1_000

export type BrowserEventName =
  'landing_viewed' | 'funnel_started' | 'payment_viewed' | 'app_store_clicked'

export type BrowserEventPropertyValue = string | number | boolean | null
export type BrowserEventProperties = Partial<
  Record<
    | 'device_type'
    | 'experiment'
    | 'locale'
    | 'page_name'
    | 'page_path'
    | 'placement'
    | 'referrer_host'
    | 'variant',
    BrowserEventPropertyValue
  >
>

export interface BrowserEventPayload {
  event_id: string
  event_name: BrowserEventName
  click_id: string
  occurred_at: string
  properties: BrowserEventProperties
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface AttributionCaptureOptions {
  href?: string
  storage?: StorageLike | null
  nowMilliseconds?: number
  ttlMilliseconds?: number
  replaceUrl?: (url: string) => void
}

export interface AttributionCaptureResult {
  clickId: string | null
  captured: boolean
  persisted: boolean
  cleanedUrl: string
}

export interface BrowserEventOptions {
  endpoint: string
  eventName: BrowserEventName
  properties?: BrowserEventProperties
  clickId?: string | null
  storage?: StorageLike | null
  occurredAt?: Date
  eventId?: string
  fetcher?: typeof fetch
  signal?: AbortSignal
}

export interface BrowserEventReceipt {
  accepted: true
  event_id: string
  duplicate: boolean
  request_id: string
}

export interface CheckoutOptions {
  /**
   * A funnel-owned server endpoint. It must add the HMAC headers before calling
   * the production `checkout-session` Edge Function. Never expose that secret
   * in this browser module.
   */
  endpoint: string
  offerKey: string
  /** Billing prefill only. Never send this in attribution/browser events. */
  customerEmail?: string
  /** Keep the same value when retrying one checkout attempt. */
  idempotencyKey?: string
  clickId?: string | null
  storage?: StorageLike | null
  fetcher?: typeof fetch
  signal?: AbortSignal
}

export interface HostedCheckoutReceipt {
  checkout_url: string
  attempt_id: string
  expires_at: string
  request_id: string
}
export interface EmbeddedCheckoutReceipt {
  ui_mode: 'embedded'
  checkout_url: null
  client_secret: string
  session_id: string
  publishable_key: string
  attempt_id: string
  expires_at: string
  request_id: string
}
export type CheckoutReceipt = HostedCheckoutReceipt | EmbeddedCheckoutReceipt

interface StoredAttribution {
  version: 1
  click_id: string
  captured_at: number
  expires_at: number
}

export class FunnelIntegrationError extends Error {
  readonly code: string
  readonly status: number | null

  constructor(message: string, code: string, status: number | null = null) {
    super(message)
    this.name = 'FunnelIntegrationError'
    this.code = code
    this.status = status
  }
}

function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function currentHref(): string {
  if (!globalThis.location?.href) {
    throw new FunnelIntegrationError(
      'The current browser URL is unavailable.',
      'browser_url_unavailable',
    )
  }
  return globalThis.location.href
}

function defaultReplaceUrl(url: string): void {
  globalThis.history.replaceState(globalThis.history.state, '', url)
}

function normalizedTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ATTRIBUTION_TTL_MILLISECONDS) {
    throw new FunnelIntegrationError(
      'Attribution TTL must be between one millisecond and 90 days.',
      'invalid_attribution_ttl',
    )
  }
  return value
}

export function isValidClickId(value: unknown): value is string {
  return typeof value === 'string' && CLICK_ID_PATTERN.test(value)
}

function decodedQueryKey(rawSegment: string): string | null {
  const separator = rawSegment.indexOf('=')
  const rawKey = separator === -1 ? rawSegment : rawSegment.slice(0, separator)
  try {
    return decodeURIComponent(rawKey.replaceAll('+', ' '))
  } catch {
    return null
  }
}

/** Removes every `kma_click` parameter while preserving all other raw URL data. */
export function stripAttributionParameter(href: string): string {
  // Parsing first rejects malformed or non-browser URLs. Reconstructing from the
  // raw string avoids normalizing unrelated query values such as `+` or `%20`.
  new URL(href)
  const hashIndex = href.indexOf('#')
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex)
  const queryIndex = beforeHash.indexOf('?')
  if (queryIndex === -1) return href

  const base = beforeHash.slice(0, queryIndex)
  const rawQuery = beforeHash.slice(queryIndex + 1)
  const retained = rawQuery
    .split('&')
    .filter((segment) => decodedQueryKey(segment) !== ATTRIBUTION_QUERY_PARAMETER)
  const query = retained.length > 0 ? `?${retained.join('&')}` : ''
  return `${base}${query}${hash}`
}

function removeStoredAttribution(storage: StorageLike | null, key = ATTRIBUTION_STORAGE_KEY): void {
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    // Storage is an optimization. Browser privacy settings must not break the funnel.
  }
}

function readAttribution(
  storage: StorageLike | null,
  key: string,
  nowMilliseconds: number,
): StoredAttribution | null {
  if (!storage) return null
  let encoded: string | null
  try {
    encoded = storage.getItem(key)
  } catch {
    return null
  }
  if (!encoded) return null

  try {
    const value = JSON.parse(encoded) as Partial<StoredAttribution>
    const duration = (value.expires_at ?? 0) - (value.captured_at ?? 0)
    if (
      value.version !== 1 ||
      !isValidClickId(value.click_id) ||
      !Number.isSafeInteger(value.captured_at) ||
      !Number.isSafeInteger(value.expires_at) ||
      duration <= 0 ||
      duration > MAX_ATTRIBUTION_TTL_MILLISECONDS ||
      (value.captured_at ?? 0) > nowMilliseconds + 5 * 60 * 1_000 ||
      (value.expires_at ?? 0) <= nowMilliseconds
    ) {
      removeStoredAttribution(storage, key)
      return null
    }
    return value as StoredAttribution
  } catch {
    removeStoredAttribution(storage, key)
    return null
  }
}

export function readStoredClickId(
  storage: StorageLike | null = browserStorage(),
  nowMilliseconds = Date.now(),
): string | null {
  return readAttribution(storage, ATTRIBUTION_STORAGE_KEY, nowMilliseconds)?.click_id ?? null
}

function readPendingClickId(
  storage: StorageLike | null,
  nowMilliseconds = Date.now(),
): string | null {
  return (
    readAttribution(storage, PENDING_ATTRIBUTION_STORAGE_KEY, nowMilliseconds)?.click_id ?? null
  )
}

function persistClickId(
  storage: StorageLike | null,
  key: string,
  clickId: string,
  capturedAt: number,
  ttlMilliseconds: number,
): boolean {
  if (!storage) return false
  const value: StoredAttribution = {
    version: 1,
    click_id: clickId,
    captured_at: capturedAt,
    expires_at: capturedAt + ttlMilliseconds,
  }
  try {
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function promotePendingClickId(
  storage: StorageLike | null,
  clickId: string,
  nowMilliseconds = Date.now(),
): boolean {
  if (!storage) return false
  const pending = readAttribution(storage, PENDING_ATTRIBUTION_STORAGE_KEY, nowMilliseconds)
  if (!pending || pending.click_id !== clickId) return false
  try {
    storage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(pending))
    storage.removeItem(PENDING_ATTRIBUTION_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

function discardPendingClickId(storage: StorageLike | null, clickId: string): void {
  if (readPendingClickId(storage) === clickId) {
    removeStoredAttribution(storage, PENDING_ATTRIBUTION_STORAGE_KEY)
  }
}

/**
 * Run before analytics or third-party assets. A syntactically valid redirect
 * token is held as pending until the server accepts an event or checkout. The
 * previous confirmed attribution remains intact until that promotion succeeds.
 */
export function captureAttributionFromUrl(
  options: AttributionCaptureOptions = {},
): AttributionCaptureResult {
  const href = options.href ?? currentHref()
  const parsed = new URL(href)
  const storage = options.storage === undefined ? browserStorage() : options.storage
  const nowMilliseconds = options.nowMilliseconds ?? Date.now()
  const ttlMilliseconds = normalizedTtl(
    options.ttlMilliseconds ?? DEFAULT_ATTRIBUTION_TTL_MILLISECONDS,
  )
  const candidates = parsed.searchParams.getAll(ATTRIBUTION_QUERY_PARAMETER)
  const cleanedUrl = stripAttributionParameter(href)
  const clickId = candidates.length === 1 && isValidClickId(candidates[0]) ? candidates[0] : null
  const persisted = clickId
    ? persistClickId(
        storage,
        PENDING_ATTRIBUTION_STORAGE_KEY,
        clickId,
        nowMilliseconds,
        ttlMilliseconds,
      )
    : false

  if (candidates.length > 0) {
    ;(options.replaceUrl ?? defaultReplaceUrl)(cleanedUrl)
  }

  if (clickId) {
    return {
      clickId,
      captured: true,
      persisted,
      cleanedUrl,
    }
  }

  return {
    clickId:
      readPendingClickId(storage, nowMilliseconds) ?? readStoredClickId(storage, nowMilliseconds),
    captured: false,
    persisted: false,
    cleanedUrl,
  }
}

function resolvedClickId(
  clickId: string | null | undefined,
  storage: StorageLike | null | undefined,
): string {
  const selectedStorage = storage === undefined ? browserStorage() : storage
  const value = clickId ?? readPendingClickId(selectedStorage) ?? readStoredClickId(selectedStorage)
  if (!isValidClickId(value)) {
    throw new FunnelIntegrationError('A valid affiliate click is required.', 'missing_attribution')
  }
  return value
}

function requireHttpsEndpoint(endpoint: string): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint, globalThis.location?.href)
  } catch {
    throw new FunnelIntegrationError('Endpoint URL is invalid.', 'invalid_endpoint')
  }
  const localSameOrigin =
    parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) &&
    parsed.origin === globalThis.location?.origin
  if (
    (!localSameOrigin && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new FunnelIntegrationError(
      'Endpoint must be a credential-free HTTPS URL without a fragment.',
      'invalid_endpoint',
    )
  }
  return parsed.toString()
}

function containsControlCharacter(value: string): boolean {
  // oxlint-disable-next-line no-control-regex
  return /[\u0000-\u001f]/u.test(value)
}

function validateBrowserProperties(properties: BrowserEventProperties): BrowserEventProperties {
  const keys = Object.keys(properties)
  if (keys.length > 25 || new TextEncoder().encode(JSON.stringify(properties)).byteLength > 8_192) {
    throw new FunnelIntegrationError(
      'Browser event properties are too large.',
      'invalid_event_properties',
    )
  }
  for (const key of keys) {
    const value = properties[key as keyof BrowserEventProperties]
    if (!ALLOWED_BROWSER_PROPERTIES.has(key) || FORBIDDEN_PROPERTY_NAMES.has(key)) {
      throw new FunnelIntegrationError(
        'Browser event contains an unsupported property.',
        'invalid_event_properties',
      )
    }
    if (
      value !== null &&
      typeof value !== 'boolean' &&
      (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        Math.abs(value) > 1_000_000_000_000) &&
      (typeof value !== 'string' || value.length > 500 || containsControlCharacter(value))
    ) {
      throw new FunnelIntegrationError(
        'Browser event contains an invalid property value.',
        'invalid_event_properties',
      )
    }
    if (
      key === 'page_path' &&
      typeof value === 'string' &&
      (!value.startsWith('/') || /[?#]/u.test(value))
    ) {
      throw new FunnelIntegrationError(
        'page_path must be a path without a query or fragment.',
        'invalid_event_properties',
      )
    }
    if (key === 'referrer_host' && typeof value === 'string') {
      try {
        if (new URL(`https://${value}`).hostname !== value.toLowerCase()) throw new Error()
      } catch {
        throw new FunnelIntegrationError(
          'referrer_host must be a normalized host name.',
          'invalid_event_properties',
        )
      }
    }
  }
  return { ...properties }
}

function createEventId(): string {
  const eventId = globalThis.crypto?.randomUUID?.()
  if (!eventId || !UUID_PATTERN.test(eventId)) {
    throw new FunnelIntegrationError(
      'Secure UUID generation is unavailable.',
      'event_id_unavailable',
    )
  }
  return eventId
}

export function createBrowserEventPayload(
  options: Omit<BrowserEventOptions, 'endpoint' | 'fetcher' | 'signal'>,
): BrowserEventPayload {
  const eventId = options.eventId ?? createEventId()
  if (!UUID_PATTERN.test(eventId)) {
    throw new FunnelIntegrationError('Event ID is invalid.', 'invalid_event_id')
  }
  if (!ALLOWED_BROWSER_EVENTS.has(options.eventName)) {
    throw new FunnelIntegrationError('Browser event name is unsupported.', 'unsupported_event')
  }
  const occurredAt = (options.occurredAt ?? new Date()).toISOString()
  return {
    event_id: eventId.toLowerCase(),
    event_name: options.eventName,
    click_id: resolvedClickId(options.clickId, options.storage),
    occurred_at: occurredAt,
    properties: validateBrowserProperties(options.properties ?? {}),
  }
}

async function parseResponse(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new FunnelIntegrationError(
      'The attribution service returned an invalid response.',
      'invalid_service_response',
      response.status,
    )
  }
  if (!response.ok) {
    const code =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : 'service_rejected'
    throw new FunnelIntegrationError(
      'The attribution service rejected the request.',
      code,
      response.status,
    )
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new FunnelIntegrationError(
      'The attribution service returned an invalid response.',
      'invalid_service_response',
      response.status,
    )
  }
  return payload as Record<string, unknown>
}

export async function sendBrowserEvent(options: BrowserEventOptions): Promise<BrowserEventReceipt> {
  const payload = createBrowserEventPayload(options)
  const response = await (options.fetcher ?? fetch)(requireHttpsEndpoint(options.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: options.signal,
  })
  let receipt: Record<string, unknown>
  try {
    receipt = await parseResponse(response)
  } catch (error) {
    if (error instanceof FunnelIntegrationError && error.code === 'click_unavailable') {
      discardPendingClickId(
        options.storage === undefined ? browserStorage() : options.storage,
        payload.click_id,
      )
    }
    throw error
  }
  if (
    receipt.accepted !== true ||
    receipt.event_id !== payload.event_id ||
    typeof receipt.duplicate !== 'boolean' ||
    typeof receipt.request_id !== 'string'
  ) {
    throw new FunnelIntegrationError(
      'The attribution service returned an invalid event receipt.',
      'invalid_service_response',
      response.status,
    )
  }
  promotePendingClickId(
    options.storage === undefined ? browserStorage() : options.storage,
    payload.click_id,
  )
  return receipt as unknown as BrowserEventReceipt
}

export async function requestCheckout(options: CheckoutOptions): Promise<CheckoutReceipt> {
  if (!OFFER_KEY_PATTERN.test(options.offerKey)) {
    throw new FunnelIntegrationError('Offer key is invalid.', 'invalid_offer_key')
  }
  const selectedStorage = options.storage === undefined ? browserStorage() : options.storage
  const clickId = resolvedClickId(options.clickId, selectedStorage)
  const idempotencyKey = options.idempotencyKey ?? createEventId()
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    throw new FunnelIntegrationError('Checkout attempt key is invalid.', 'invalid_idempotency_key')
  }
  const response = await (options.fetcher ?? fetch)(requireHttpsEndpoint(options.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      click_id: clickId,
      offer_key: options.offerKey,
      ...(options.customerEmail !== undefined ? { customer_email: options.customerEmail } : {}),
    }),
    cache: 'no-store',
    credentials: 'same-origin',
    referrerPolicy: 'no-referrer',
    signal: options.signal,
  })
  const receipt = await parseResponse(response)
  const embedded = receipt.ui_mode === 'embedded'
  let checkoutUrl: URL | null = null
  try {
    if (!embedded) checkoutUrl = new URL(String(receipt.checkout_url))
  } catch {
    throw new FunnelIntegrationError(
      'The checkout service returned an invalid receipt.',
      'invalid_service_response',
      response.status,
    )
  }
  if (
    (!embedded &&
      (typeof receipt.checkout_url !== 'string' ||
        !checkoutUrl ||
        checkoutUrl.origin !== 'https://checkout.stripe.com' ||
        checkoutUrl.username ||
        checkoutUrl.password)) ||
    (embedded &&
      (receipt.checkout_url !== null ||
        typeof receipt.session_id !== 'string' ||
        !/^cs_live_[A-Za-z0-9_]{8,160}$/.test(receipt.session_id) ||
        typeof receipt.client_secret !== 'string' ||
        receipt.client_secret.length > 512 ||
        !receipt.client_secret.startsWith(`${receipt.session_id}_secret_`) ||
        typeof receipt.publishable_key !== 'string' ||
        !/^pk_live_[A-Za-z0-9_]{16,256}$/.test(receipt.publishable_key))) ||
    typeof receipt.attempt_id !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(receipt.attempt_id) ||
    typeof receipt.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(receipt.expires_at)) ||
    typeof receipt.request_id !== 'string'
  ) {
    throw new FunnelIntegrationError(
      'The checkout service returned an invalid receipt.',
      'invalid_service_response',
      response.status,
    )
  }
  promotePendingClickId(selectedStorage, clickId)
  return receipt as unknown as CheckoutReceipt
}
