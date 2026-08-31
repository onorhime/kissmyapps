const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,99}$/
const PROPERTY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,79}$/
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const EVENT_KEYS = new Set(['event_id', 'event_name', 'click_id', 'occurred_at', 'properties'])

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

export type ServerEventPropertyValue = string | number | boolean | null

export interface ServerEventPayload {
  event_id: string
  event_name: string
  click_id: string
  occurred_at: string
  properties: Record<string, ServerEventPropertyValue>
}

export interface FunnelSigningConfiguration {
  keyId: string
  secret: string
}

export interface SignedRequestOptions {
  endpoint: string
  body: unknown
  signing: FunnelSigningConfiguration
  nonce?: string
  timestampSeconds?: number
}

export interface SignedRequestParts {
  endpoint: string
  body: string
  headers: Readonly<Record<string, string>>
}

export interface SendServerEventOptions {
  endpoint: string
  event: ServerEventPayload
  signing: FunnelSigningConfiguration
  nonce?: string
  timestampSeconds?: number
  fetcher?: typeof fetch
  signal?: AbortSignal
}

export interface ServerEventReceipt {
  accepted: true
  event_id: string
  duplicate: boolean
  request_id: string
}

export class ServerIntegrationError extends Error {
  readonly code: string
  readonly status: number | null

  constructor(message: string, code: string, status: number | null = null) {
    super(message)
    this.name = 'ServerIntegrationError'
    this.code = code
    this.status = status
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

function secureNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function requireHttpsEndpoint(endpoint: string): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new ServerIntegrationError('Endpoint URL is invalid.', 'invalid_endpoint')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new ServerIntegrationError(
      'Endpoint must be a credential-free HTTPS URL without a fragment.',
      'invalid_endpoint',
    )
  }
  return parsed.toString()
}

function validateSigningConfiguration(signing: FunnelSigningConfiguration): void {
  if (!KEY_ID_PATTERN.test(signing.keyId) || signing.secret.length < 32) {
    throw new ServerIntegrationError(
      'Funnel signing configuration is invalid.',
      'invalid_signing_configuration',
    )
  }
}

function containsControlCharacter(value: string): boolean {
  // oxlint-disable-next-line no-control-regex
  return /[\u0000-\u001f]/u.test(value)
}

function validateEvent(event: ServerEventPayload): void {
  const occurredAt = Date.parse(event.occurred_at)
  const keys = Object.keys(event)
  if (
    keys.length !== EVENT_KEYS.size ||
    keys.some((key) => !EVENT_KEYS.has(key)) ||
    !EVENT_ID_PATTERN.test(event.event_id) ||
    !CLICK_ID_PATTERN.test(event.click_id) ||
    !EVENT_NAME_PATTERN.test(event.event_name) ||
    !Number.isFinite(occurredAt) ||
    typeof event.properties !== 'object' ||
    event.properties === null ||
    Array.isArray(event.properties)
  ) {
    throw new ServerIntegrationError('Server event is invalid.', 'invalid_event')
  }
  const propertyKeys = Object.keys(event.properties)
  if (
    propertyKeys.length > 25 ||
    new TextEncoder().encode(JSON.stringify(event.properties)).byteLength > 16_384
  ) {
    throw new ServerIntegrationError('Server event properties are invalid.', 'invalid_event')
  }
  for (const key of propertyKeys) {
    const value = event.properties[key]
    if (
      !PROPERTY_KEY_PATTERN.test(key) ||
      FORBIDDEN_PROPERTY_NAMES.has(key) ||
      (value !== null &&
        typeof value !== 'boolean' &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          Math.abs(value) > 1_000_000_000_000) &&
        (typeof value !== 'string' || value.length > 500 || containsControlCharacter(value)))
    ) {
      throw new ServerIntegrationError('Server event properties are invalid.', 'invalid_event')
    }
  }
}

async function hmacSha256(secret: string, message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, Uint8Array.from(message).buffer)
  return bytesToHex(new Uint8Array(signature))
}

/**
 * Signs one exact serialized body. Send `parts.body` unchanged; parsing and
 * re-stringifying it after this call invalidates the signature by design.
 */
export async function createSignedRequest(
  options: SignedRequestOptions,
): Promise<SignedRequestParts> {
  validateSigningConfiguration(options.signing)
  const endpoint = requireHttpsEndpoint(options.endpoint)
  const nonce = options.nonce ?? secureNonce()
  const timestamp = options.timestampSeconds ?? Math.floor(Date.now() / 1_000)
  if (!NONCE_PATTERN.test(nonce) || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new ServerIntegrationError(
      'Request signing metadata is invalid.',
      'invalid_signing_metadata',
    )
  }

  const body = JSON.stringify(options.body)
  if (typeof body !== 'string') {
    throw new ServerIntegrationError(
      'Request body cannot be serialized as JSON.',
      'invalid_request_body',
    )
  }
  const bodyBytes = new TextEncoder().encode(body)
  const prefix = new TextEncoder().encode(`${timestamp}.${nonce}.`)
  const canonical = new Uint8Array(prefix.byteLength + bodyBytes.byteLength)
  canonical.set(prefix)
  canonical.set(bodyBytes, prefix.byteLength)
  const signature = await hmacSha256(options.signing.secret, canonical)

  return {
    endpoint,
    body,
    headers: {
      'Content-Type': 'application/json',
      'x-kma-key-id': options.signing.keyId,
      'x-kma-timestamp': String(timestamp),
      'x-kma-nonce': nonce,
      'x-kma-signature': signature,
    },
  }
}

export async function sendServerEvent(
  options: SendServerEventOptions,
): Promise<ServerEventReceipt> {
  validateEvent(options.event)
  const request = await createSignedRequest({
    endpoint: options.endpoint,
    body: options.event,
    signing: options.signing,
    nonce: options.nonce,
    timestampSeconds: options.timestampSeconds,
  })
  const response = await (options.fetcher ?? fetch)(request.endpoint, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    cache: 'no-store',
    redirect: 'error',
    signal: options.signal,
  })

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ServerIntegrationError(
      'The event service returned an invalid response.',
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
    throw new ServerIntegrationError(
      'The event service rejected the request.',
      code,
      response.status,
    )
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    !('accepted' in payload) ||
    payload.accepted !== true ||
    !('event_id' in payload) ||
    payload.event_id !== options.event.event_id ||
    !('duplicate' in payload) ||
    typeof payload.duplicate !== 'boolean' ||
    !('request_id' in payload) ||
    typeof payload.request_id !== 'string'
  ) {
    throw new ServerIntegrationError(
      'The event service returned an invalid receipt.',
      'invalid_service_response',
      response.status,
    )
  }
  return payload as unknown as ServerEventReceipt
}
