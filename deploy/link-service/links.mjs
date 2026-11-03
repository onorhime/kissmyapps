// The link service: the edge Caddy hands it every request for a merchant's link domain
// (a subdomain of the link root, or a domain of the merchant's own) and asks it, before
// getting a certificate, whether a host is one of those. It learns what a host serves
// from the attribution-links function and keeps the answer for a minute.
//
// Phase 0 serves what lets links open apps: Apple's apple-app-site-association and
// Android's assetlinks.json, built from the project's settings. The bare domain sends
// people to the project's website. Links themselves come in the next phase.

const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/

/** The host a request was made for: lowercase, without its port or trailing dot. */
export function requestHost(value) {
  const host = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
  return HOST.test(host) ? host : null
}

/** Apple's file. Every path but the bare domain opens the app. */
export function appleAppSiteAssociation(domain) {
  return {
    applinks: {
      details: [
        {
          appIDs: domain.ios_app_ids,
          components: [{ '/': '/?*', comment: 'Every link; the bare domain opens the website.' }],
        },
      ],
    },
  }
}

/** Android's file: the app may open every link on this domain. */
export function assetLinks(domain) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: domain.android.package,
        sha256_cert_fingerprints: domain.android.sha256,
      },
    },
  ]
}

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

/** A small page for people who reach a link domain without a link that works. */
export function page({ title, message, website }) {
  const action = website
    ? `<a class="button" href="${escape(website)}" rel="noreferrer">Go to the website</a>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(title)}</title>
<style>
:root { color-scheme: light dark; --ground: #f6f6f7; --surface: #ffffff; --text: #111111; --muted: #5f5f66; --accent: #111111; --on-accent: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --ground: #111111; --surface: #222222; --text: #ffffff; --muted: #a9a9ae; --accent: #ffffff; --on-accent: #111111; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--ground); color: var(--text);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
main { width: 100%; max-width: 420px; background: var(--surface); border-radius: 16px; padding: 32px 28px; }
h1 { margin: 0 0 8px; font-size: 22px; line-height: 1.25; font-weight: 600; }
p { margin: 0; color: var(--muted); }
.button { display: inline-block; margin-top: 24px; padding: 12px 18px; border-radius: 10px; background: var(--accent); color: var(--on-accent);
  text-decoration: none; font-weight: 600; }
footer { margin-top: 28px; font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${escape(title)}</h1>
<p>${escape(message)}</p>
${action}
<footer>Links by KissMyApps</footer>
</main>
</body>
</html>
`
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
}

/** Calls the attribution-links function with the shared secret. */
export function createUpstream({ url, secret, fetchImpl = fetch, timeoutMs = 5_000 }) {
  if (!url || !secret || secret.length < 32)
    throw new Error('The link service needs the attribution-links URL and its secret.')
  const call = async (action, host) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kma-link-secret': secret },
      body: JSON.stringify({ action, host }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`attribution-links answered ${response.status}`)
    return response.json()
  }
  return {
    lookup: async (host) => (await call('host', host)).domain ?? null,
    seen: async (host) => (await call('seen', host)).seen === true,
  }
}

/**
 * lookup(host): what the host serves, or null; throws when it cannot tell.
 * seen(host): tells the database a request for the host reached us over HTTPS.
 */
export function createLinkService({
  lookup,
  seen,
  now = () => Date.now(),
  log = (message) => console.error(message),
  knownMs = 60_000,
  unknownMs = 15_000,
  seenEveryMs = 60 * 60_000,
  maxEntries = 5_000,
}) {
  const cache = new Map()
  const pending = new Map()
  const lastSeen = new Map()

  const remember = (map, key, value) => {
    map.delete(key)
    map.set(key, value)
    if (map.size > maxEntries) map.delete(map.keys().next().value)
  }

  /** What the host serves, from the cache while it is fresh. */
  async function domainFor(host) {
    const cached = cache.get(host)
    if (cached && cached.expires > now()) return cached.domain
    if (pending.has(host)) return pending.get(host)
    const request = (async () => {
      try {
        const domain = await lookup(host)
        remember(cache, host, { domain, expires: now() + (domain ? knownMs : unknownMs) })
        return domain
      } catch (error) {
        // Keep answering from what we last knew while the database is unreachable.
        if (cached) {
          log(`lookup for ${host} failed, using the last answer: ${error.message}`)
          return cached.domain
        }
        throw error
      } finally {
        pending.delete(host)
      }
    })()
    pending.set(host, request)
    return request
  }

  function markSeen(host) {
    const last = lastSeen.get(host)
    if (last !== undefined && now() - last < seenEveryMs) return
    remember(lastSeen, host, now())
    seen(host).catch((error) => {
      lastSeen.delete(host)
      log(`could not mark ${host} seen: ${error.message}`)
    })
  }

  function send(request, response, status, headers, body = '') {
    response.writeHead(status, headers)
    response.end(request.method === 'HEAD' ? undefined : body)
  }
  const json = (request, response, status, body, cache = 'no-store, max-age=0') =>
    send(
      request,
      response,
      status,
      {
        'content-type': 'application/json',
        'cache-control': cache,
        'x-content-type-options': 'nosniff',
      },
      JSON.stringify(body),
    )
  const html = (request, response, status, content) =>
    send(request, response, status, PAGE_HEADERS, page(content))

  /** Public traffic for link domains, from the edge Caddy. */
  async function handle(request, response) {
    const path = new URL(request.url ?? '/', 'http://link').pathname
    if (path === '/healthz') return json(request, response, 200, { ok: true, hosts: cache.size })
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return send(
        request,
        response,
        405,
        { allow: 'GET, HEAD', 'content-type': 'text/plain' },
        'Method not allowed',
      )

    const host = requestHost(request.headers.host)
    let domain = null
    if (host) {
      try {
        domain = await domainFor(host)
      } catch (error) {
        log(`lookup for ${host} failed: ${error.message}`)
        return html(request, response, 503, {
          title: 'Try again in a moment',
          message: 'This link could not be opened just now.',
        })
      }
    }
    if (!domain)
      return html(request, response, 404, {
        title: 'Link not found',
        message: 'This address is not set up for links.',
      })
    markSeen(host)

    if (
      path === '/.well-known/apple-app-site-association' ||
      path === '/apple-app-site-association'
    ) {
      if (!domain.ios_app_ids?.length) return json(request, response, 404, { error: 'no_ios_app' })
      return json(request, response, 200, appleAppSiteAssociation(domain), 'public, max-age=300')
    }
    if (path === '/.well-known/assetlinks.json') {
      if (!domain.android) return json(request, response, 404, { error: 'no_android_app' })
      return json(request, response, 200, assetLinks(domain), 'public, max-age=300')
    }
    if (path === '/robots.txt')
      return send(
        request,
        response,
        200,
        { 'content-type': 'text/plain', 'cache-control': 'public, max-age=3600' },
        'User-agent: *\nDisallow: /\n',
      )
    if (path === '/favicon.ico')
      return send(request, response, 404, { 'cache-control': 'public, max-age=3600' })

    if (!domain.enabled)
      return html(request, response, 404, {
        title: 'Links are turned off',
        message: 'The links on this address are not active right now.',
        website: domain.web_url,
      })
    if (path === '/' && domain.web_url)
      return send(request, response, 302, {
        location: domain.web_url,
        'cache-control': 'no-store, max-age=0',
        'referrer-policy': 'no-referrer',
      })
    return html(request, response, 404, {
      title: 'Link not found',
      message: 'This link does not exist or has been removed.',
      website: domain.web_url,
    })
  }

  /** Caddy's on-demand TLS check: 200 lets it get a certificate for ?domain=. */
  async function ask(request, response) {
    const host = requestHost(new URL(request.url ?? '/', 'http://ask').searchParams.get('domain'))
    if (!host) return send(request, response, 400, { 'content-type': 'text/plain' }, 'bad domain')
    try {
      const domain = await domainFor(host)
      return send(
        request,
        response,
        domain ? 200 : 404,
        { 'content-type': 'text/plain' },
        domain ? 'ok' : 'unknown',
      )
    } catch (error) {
      log(`certificate check for ${host} failed: ${error.message}`)
      return send(request, response, 503, { 'content-type': 'text/plain' }, 'unavailable')
    }
  }

  return { handle, ask, domainFor }
}
