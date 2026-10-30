// The events relay: the edge Caddy hands it each SDK request with the visitor's address
// in X-Kma-Client-Ip, it looks the address up in the city database, and passes the
// request on to the analytics-ingest function with the place and the proxy secret.
// Addresses are only looked up, never written down. Without a database, or for an
// address it does not know, the request goes on without a place and the function falls
// back to the device's time zone.

import { addressBytes } from './mmdb.mjs'

const PATHS = new Set(['/v1/events', '/v1/replay'])
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

/** The country, region and city in a DB-IP or GeoIP2 city record, or null. */
export function placeOf(record) {
  const country = record?.country?.iso_code
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) return null
  const name = (value) =>
    typeof value === 'string' && value.trim() && value.length <= 80 ? value.trim() : undefined
  const region = name(record.subdivisions?.[0]?.names?.en)
  const city = name(record.city?.names?.en)
  return { country, ...(region ? { region } : {}), ...(city ? { city } : {}) }
}

/** Place headers; names are percent-encoded because header values are not UTF-8. */
function placeHeaders(prefix, place) {
  const headers = { [`${prefix}-country`]: place.country }
  if (place.region) headers[`${prefix}-region`] = encodeURIComponent(place.region)
  if (place.city) headers[`${prefix}-city`] = encodeURIComponent(place.city)
  return headers
}

function serverKey(headers, body) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')?.[1]
  if (bearer) return bearer.startsWith('kma_sk_')
  return typeof body?.api_key === 'string'
    ? body.api_key.startsWith('kma_sk_')
    : typeof body?.key === 'string' && body.key.startsWith('kma_sk_')
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const collect = (chunk) => {
      size += chunk.length
      if (size <= limit) return chunks.push(chunk)
      // Let the rest drain unread so the client gets the answer, not a reset connection.
      request.off('data', collect)
      request.resume()
      reject(Object.assign(new Error('Request body too large.'), { status: 413 }))
    }
    request.on('data', collect)
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function reply(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

/**
 * upstream: the function's URL, such as https://<ref>.supabase.co/functions/v1/analytics-ingest
 * secret: the value the function holds as ANALYTICS_PROXY_SECRET
 * database: () => an open database (see mmdb.mjs) or null
 * status: () => what /healthz reports about the database
 */
export function createRelay({
  upstream,
  secret,
  database,
  status = () => ({}),
  maxBody = 5 * 1024 * 1024,
  timeoutMs = 15_000,
  fetchImpl = fetch,
  log = (message) => console.error(message),
}) {
  if (!upstream || !secret) throw new Error('The relay needs the ingest URL and the proxy secret.')
  const base = upstream.replace(/\/+$/, '')

  const lookup = (ip) => {
    const db = database()
    if (!db || !addressBytes(ip)) return null
    try {
      return placeOf(db.lookup(ip))
    } catch (error) {
      log(`lookup failed: ${error.message}`)
      return null
    }
  }

  return async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://relay')
    if (request.method === 'GET' && url.pathname === '/healthz')
      return reply(response, 200, { ok: true, ...status() })
    if (!PATHS.has(url.pathname))
      return reply(response, 404, { error: { code: 'not_found', message: 'Not found.' } })
    if (request.method !== 'POST' && request.method !== 'OPTIONS')
      return reply(response, 405, { error: { code: 'method_not_allowed', message: 'Use POST.' } })

    let body
    try {
      body = request.method === 'POST' ? await readBody(request, maxBody) : undefined
    } catch (error) {
      return reply(
        response,
        error.status ?? 400,
        { error: { code: 'invalid_body', message: error.message } },
        { connection: 'close' },
      )
    }

    const headers = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (HOP_BY_HOP.has(name) || name.startsWith('x-kma-') || value === undefined) continue
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    headers['x-kma-via'] = 'geo-relay'
    headers['x-kma-proxy'] = secret
    // Only the edge Caddy reaches the relay, and it sets this from the connection.
    const ip = request.headers['x-kma-client-ip']?.trim()
    if (ip && addressBytes(ip)) {
      headers['x-kma-client-ip'] = ip
      const place = lookup(ip)
      if (place)
        Object.assign(headers, placeHeaders('x-kma', place), { 'x-kma-place-source': 'ip' })
    }
    // A merchant's server may name its user's address; the function uses that place for
    // server keys only, and the address goes no further than this lookup.
    if (body?.length && url.pathname === '/v1/events') {
      let parsed
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        parsed = undefined
      }
      const userIp = parsed?.context?.ip
      if (serverKey(request.headers, parsed) && typeof userIp === 'string') {
        const place = lookup(userIp)
        if (place) Object.assign(headers, placeHeaders('x-kma-context', place))
      }
    }

    let upstreamResponse
    try {
      upstreamResponse = await fetchImpl(`${base}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: body?.length ? body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError'
      log(`upstream ${timedOut ? 'timed out' : `failed: ${error?.message}`}`)
      return reply(response, timedOut ? 504 : 502, {
        error: {
          code: 'upstream_unavailable',
          message: 'Events could not be delivered. Try again shortly.',
        },
      })
    }
    const out = {}
    upstreamResponse.headers.forEach((value, name) => {
      // fetch has already decoded the body, so its encoding and length no longer apply.
      if (HOP_BY_HOP.has(name) || name === 'content-encoding') return
      out[name] = value
    })
    const payload = Buffer.from(await upstreamResponse.arrayBuffer())
    response.writeHead(upstreamResponse.status, out)
    response.end(payload)
  }
}
