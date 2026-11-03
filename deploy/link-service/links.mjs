// The link service: the edge Caddy hands it every request for a merchant's link domain
// (a subdomain of the link root, or a domain of the merchant's own) and asks it, before
// getting a certificate, whether a host is one of those. It learns what a host serves
// from the attribution-links function and keeps the answer for a minute.
//
// It serves what lets links open apps (Apple's apple-app-site-association and Android's
// assetlinks.json, built from the project's settings) and the links themselves: each one
// sends a phone to the App Store or Google Play and a computer to the website, records the
// click, and hands the click ID on as kma_lc so the web SDK (and later the app SDKs) can
// say which link a visit came from. Clicks go to the database in batches.

import { randomBytes } from 'node:crypto'

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

// Link preview fetchers and other robots: they get the link's preview and are never counted.
const BOT =
  /bot\b|crawler|spider|facebookexternalhit|facebot|twitterbot|slackbot|linkedinbot|whatsapp|telegrambot|discordbot|embedly|pinterest|redditbot|skypeuripreview|applebot|googlebot|bingbot|bingpreview|yandex|duckduckbot|baiduspider|ia_archiver|vkshare|quora link preview|bitlybot|iframely|snap url preview|google-pagerenderer|headlesschrome|lighthouse|curl\/|wget\/|python-requests|python-urllib|go-http-client|node-fetch|axios\/|okhttp|java\/|libwww|httpclient|scrapy/i

// Apps whose own browser opens links: Universal Links and App Links often do not work in them.
const IN_APP = [
  ['instagram', /Instagram/],
  ['facebook', /FBAN|FBAV|FB_IAB|FBIOS|FB4A/],
  ['messenger', /Messenger|FB_IAB\/MESSENGER/],
  ['tiktok', /musical_ly|BytedanceWebview|TikTok|trill_/i],
  ['snapchat', /Snapchat/],
  ['linkedin', /LinkedInApp/],
  ['x', /Twitter(?:Android)?\b/],
  ['line', /\bLine\//],
  ['wechat', /MicroMessenger/],
  ['pinterest', /Pinterest\//],
]

/** What kind of device opened the link, and whether it was a robot or an app's own browser. */
export function classify(userAgent) {
  const ua = String(userAgent ?? '')
  const bot = ua === '' || BOT.test(ua)
  const platform = /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : 'desktop'
  const inApp = platform === 'desktop' ? null : (IN_APP.find(([, re]) => re.test(ua))?.[0] ?? null)
  // Messenger also says FBAN; name it for what it is.
  return {
    bot,
    platform,
    inApp: inApp === 'facebook' && /Messenger/.test(ua) ? 'messenger' : inApp,
  }
}

/** A click ID: 128 random bits, URL-safe. */
export const newClickId = () => randomBytes(16).toString('base64url')

// What the address of a link may set for one click.
const OVERRIDES = { src: 'source', cmp: 'campaign', chn: 'channel', adset: 'adset', ad: 'ad' }
const PARAMS = {
  sub1: 'sub1',
  sub2: 'sub2',
  sub3: 'sub3',
  sub4: 'sub4',
  sub5: 'sub5',
  dl: 'dl',
  kma_aid: 'web_id',
  kma_from: 'from',
}
const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid']
const LINK_KEYS = new Set([...Object.keys(OVERRIDES), ...Object.keys(PARAMS), 'kma_lc'])

function pick(query, names) {
  const out = {}
  for (const [from, to] of Object.entries(names)) {
    const value = query.get(from)?.trim()
    if (value) out[to] = value.slice(0, 500)
  }
  return out
}

/** The website address for a click: the link's page with kma_lc, its UTM tags and the address's own. */
export function webAddress(link, clickId, query, overrides = pick(query, OVERRIDES)) {
  if (!link.web_url) return null
  const url = new URL(link.web_url)
  const has = (key) => url.searchParams.has(key)
  for (const [key, value] of query)
    if (!LINK_KEYS.has(key) && !has(key)) url.searchParams.set(key, value)
  const tags = {
    utm_source: overrides.source ?? link.source,
    utm_medium: overrides.channel ?? link.channel,
    utm_campaign: overrides.campaign ?? link.campaign,
    utm_content: overrides.ad ?? link.ad,
  }
  for (const [key, value] of Object.entries(tags))
    if (value && !has(key)) url.searchParams.set(key, value)
  if (clickId) url.searchParams.set('kma_lc', clickId)
  return url.toString()
}

/** Google Play with the click in the install referrer, which the app reads on first launch. */
export function playAddress(link, clickId, overrides = {}) {
  const referrer = new URLSearchParams({
    kma_lc: clickId,
    utm_source: overrides.source ?? link.source,
  })
  const campaign = overrides.campaign ?? link.campaign
  if (campaign) referrer.set('utm_campaign', campaign)
  const url = new URL('https://play.google.com/store/apps/details')
  url.searchParams.set('id', link.android_package)
  url.searchParams.set('referrer', referrer.toString())
  return url.toString()
}

/**
 * Where one click goes. kind: redirect (to url), choose (an app's own browser: open the app
 * or the website), phone (a computer, for a link that only leads to apps) or none.
 */
export function route(link, device, clickId, query) {
  const overrides = pick(query, OVERRIDES)
  const web = webAddress(link, clickId, query, overrides)
  let app = null
  if (device.platform === 'ios' && link.ios_url)
    app = { url: link.ios_url, destination: link.ios_custom ? 'custom' : 'app_store' }
  if (device.platform === 'android' && link.android_url)
    app = { url: link.android_url, destination: 'custom' }
  else if (device.platform === 'android' && link.android_package)
    app = { url: playAddress(link, clickId, overrides), destination: 'play_store' }
  if (app && device.inApp) return { kind: 'choose', destination: 'page', app: app.url, web }
  if (app) return { kind: 'redirect', destination: app.destination, url: app.url }
  if (web) return { kind: 'redirect', destination: 'web', url: web }
  const ios = link.ios_url && !link.ios_custom ? link.ios_url : null
  const android = link.android_package ? playAddress(link, clickId, overrides) : null
  if (device.platform === 'desktop' && (ios || android))
    return { kind: 'phone', destination: 'page', ios, android }
  return { kind: 'none' }
}

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

/**
 * A small page: a title, a message and buttons (the first is the main one). Pages for
 * robots carry the link's preview in Open Graph tags.
 */
export function page({ title, message, website, actions = [], preview = null }) {
  const buttons = [...actions]
  if (website) buttons.push({ label: 'Go to the website', href: website })
  const links = buttons
    .map(
      ({ label, href }, i) =>
        `<a class="button${i ? ' quiet' : ''}" href="${escape(href)}" rel="noreferrer">${escape(label)}</a>`,
    )
    .join('\n')
  const meta = preview
    ? [
        ['og:title', preview.title],
        ['og:description', preview.description],
        ['og:image', preview.image],
        ['og:url', preview.url],
        ['og:type', 'website'],
        ['twitter:card', preview.image ? 'summary_large_image' : 'summary'],
      ]
        .filter(([, value]) => value)
        .map(([key, value]) => `<meta property="${key}" content="${escape(value)}">`)
        .join('\n')
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(title)}</title>
${preview?.description ? `<meta name="description" content="${escape(preview.description)}">\n` : ''}${meta}
<style>
:root { color-scheme: light dark; --ground: #f6f6f7; --surface: #ffffff; --text: #111111; --muted: #5f5f66; --accent: #111111; --on-accent: #ffffff; --line: #d9d9de; }
@media (prefers-color-scheme: dark) { :root { --ground: #111111; --surface: #222222; --text: #ffffff; --muted: #a9a9ae; --accent: #ffffff; --on-accent: #111111; --line: #3a3a3f; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--ground); color: var(--text);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
main { width: 100%; max-width: 420px; background: var(--surface); border-radius: 16px; padding: 32px 28px; }
h1 { margin: 0 0 8px; font-size: 22px; line-height: 1.25; font-weight: 600; }
p { margin: 0; color: var(--muted); }
.actions { display: grid; gap: 12px; margin-top: 24px; }
.button { display: block; padding: 13px 18px; border-radius: 10px; background: var(--accent); color: var(--on-accent);
  text-decoration: none; font-weight: 600; text-align: center; min-height: 48px; }
.button.quiet { background: transparent; color: var(--text); border: 1px solid var(--line); }
footer { margin-top: 28px; font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${escape(title)}</h1>
<p>${escape(message)}</p>
${links ? `<div class="actions">\n${links}\n</div>` : ''}
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

const REDIRECT_HEADERS = (location) => ({
  location,
  'cache-control': 'no-store, max-age=0',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow, noarchive',
})

// The edge Caddy names the visitor's address; it drops any X-Kma-* header the visitor sent.
const IP = /^[0-9a-fA-F:.]{2,45}$/
function clientIp(headers) {
  const ip = String(headers['x-kma-client-ip'] ?? '').trim()
  return IP.test(ip) ? ip : undefined
}

/** Calls the attribution-links function with the shared secret. */
export function createUpstream({ url, secret, fetchImpl = fetch, timeoutMs = 5_000 }) {
  if (!url || !secret || secret.length < 32)
    throw new Error('The link service needs the attribution-links URL and its secret.')
  const call = async (body) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kma-link-secret': secret },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`attribution-links answered ${response.status}`)
    return response.json()
  }
  return {
    lookup: async (host) => (await call({ action: 'host', host })).domain ?? null,
    seen: async (host) => (await call({ action: 'seen', host })).seen === true,
    link: async (host, path) => (await call({ action: 'link', host, path })).link ?? null,
    clicks: async (clicks) => (await call({ action: 'clicks', clicks })).stored ?? 0,
  }
}

/**
 * Holds clicks and sends them in batches: every flushMs, or at once when a batch is full.
 * A failed send keeps them and waits longer before the next try; past max, the oldest go.
 */
export function createClickQueue({
  send,
  log = (message) => console.error(message),
  flushMs = 2_000,
  batch = 200,
  max = 5_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let queue = []
  let timer = null
  let sending = null
  let wait = flushMs

  const schedule = (ms) => {
    if (timer || !queue.length) return
    timer = setTimer(() => {
      timer = null
      void flush()
    }, ms)
    timer.unref?.()
  }

  async function flush() {
    // One send at a time; a flush asked for during one runs after it.
    while (sending) await sending
    if (timer) {
      clearTimer(timer)
      timer = null
    }
    sending = (async () => {
      while (queue.length) {
        const next = queue.slice(0, batch)
        try {
          await send(next)
          // Clicks may have been dropped meanwhile, so remove exactly the ones sent.
          const sent = new Set(next)
          queue = queue.filter((click) => !sent.has(click))
          wait = flushMs
        } catch (error) {
          wait = Math.min(wait * 2, 60_000)
          log(
            `could not send ${next.length} clicks, trying again in ${wait / 1000}s: ${error.message}`,
          )
          break
        }
      }
    })().finally(() => {
      sending = null
      schedule(wait)
    })
    return sending
  }

  return {
    push(click) {
      queue.push(click)
      if (queue.length > max) {
        log(`dropping ${queue.length - max} clicks: the queue is full`)
        queue = queue.slice(queue.length - max)
      }
      if (queue.length >= batch && !sending) void flush()
      else schedule(wait)
    },
    flush,
    get size() {
      return queue.length
    },
  }
}

/**
 * lookup(host): what the host serves, or null; throws when it cannot tell.
 * seen(host): tells the database a request for the host reached us over HTTPS.
 * link(host, path): what a link leads to, or null; throws when it cannot tell.
 * record(click): keeps a click to send (see createClickQueue).
 */
export function createLinkService({
  lookup,
  seen,
  link = async () => null,
  record = () => {},
  clickId = newClickId,
  now = () => Date.now(),
  log = (message) => console.error(message),
  knownMs = 60_000,
  unknownMs = 15_000,
  seenEveryMs = 60 * 60_000,
  maxEntries = 5_000,
}) {
  const lastSeen = new Map()

  const remember = (map, key, value) => {
    map.delete(key)
    map.set(key, value)
    if (map.size > maxEntries) map.delete(map.keys().next().value)
  }

  /** An answer kept while fresh, shared by requests at once, and kept on while the database is down. */
  function cached(fetch, label) {
    const cache = new Map()
    const pending = new Map()
    const get = async (key, ...args) => {
      const hit = cache.get(key)
      if (hit && hit.expires > now()) return hit.value
      if (pending.has(key)) return pending.get(key)
      const request = (async () => {
        try {
          const value = await fetch(...args)
          remember(cache, key, { value, expires: now() + (value ? knownMs : unknownMs) })
          return value
        } catch (error) {
          // Keep answering from what we last knew while the database is unreachable.
          if (hit) {
            log(`${label} for ${key} failed, using the last answer: ${error.message}`)
            return hit.value
          }
          throw error
        } finally {
          pending.delete(key)
        }
      })()
      pending.set(key, request)
      return request
    }
    get.size = () => cache.size
    return get
  }

  const domains = cached(lookup, 'lookup')
  const links = cached(link, 'link lookup')

  /** What the host serves, from the cache while it is fresh. */
  const domainFor = (host) => domains(host, host)
  /** What a link leads to, from the cache while it is fresh. */
  const linkFor = (host, path) => links(`${host}/${path}`, host, path)

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
    if (path === '/healthz')
      return json(request, response, 200, { ok: true, hosts: domains.size() })
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
      return send(request, response, 302, REDIRECT_HEADERS(domain.web_url))

    const slug = path.match(/^\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/)?.[1]?.toLowerCase()
    let target = null
    if (slug) {
      try {
        target = await linkFor(host, slug)
      } catch (error) {
        log(`link lookup for ${host}/${slug} failed: ${error.message}`)
        return html(request, response, 503, {
          title: 'Try again in a moment',
          message: 'This link could not be opened just now.',
        })
      }
    }
    if (!target)
      return html(request, response, 404, {
        title: 'Link not found',
        message: 'This link does not exist or has been removed.',
        website: domain.web_url,
      })
    return openLink(request, response, host, target)
  }

  /** One link: robots get its preview; people are counted and sent on. */
  function openLink(request, response, host, target) {
    const query = new URL(request.url ?? '/', 'http://link').searchParams
    const device = classify(request.headers['user-agent'])
    if (target.status !== 'active') {
      if (target.web_url) return send(request, response, 302, REDIRECT_HEADERS(target.web_url))
      return html(request, response, 404, {
        title: 'This link is paused',
        message: 'It is not leading anywhere right now.',
      })
    }
    if (device.bot || request.method === 'HEAD') {
      // A preview the merchant wrote, or the website's own (without counting a click).
      if (target.social || !target.web_url)
        return html(request, response, 200, {
          title: target.social?.title ?? target.project_name,
          message: target.social?.description ?? '',
          preview: {
            ...(target.social ?? { title: target.project_name }),
            url: `https://${host}/${target.path}`,
          },
        })
      return send(request, response, 302, REDIRECT_HEADERS(webAddress(target, null, query)))
    }

    const id = clickId()
    const next = route(target, device, id, query)
    if (next.kind === 'none')
      return html(request, response, 404, {
        title: 'This link has nowhere to go yet',
        message: 'It does not lead to an app or a website for this device.',
      })
    record({
      id,
      link_id: target.id,
      clicked_at: new Date(now()).toISOString(),
      platform: device.platform,
      in_app: device.inApp,
      destination: next.destination,
      overrides: pick(query, OVERRIDES),
      params: pick(query, PARAMS),
      click_ids: pick(query, Object.fromEntries(CLICK_IDS.map((key) => [key, key]))),
      ip: clientIp(request.headers),
      user_agent: String(request.headers['user-agent'] ?? '').slice(0, 400) || undefined,
      referrer: String(request.headers.referer ?? '').slice(0, 500) || undefined,
    })
    if (next.kind === 'redirect') return send(request, response, 302, REDIRECT_HEADERS(next.url))
    if (next.kind === 'choose')
      return html(request, response, 200, {
        title: target.project_name,
        message: 'Open this in the app, or carry on in your browser.',
        actions: [
          { label: 'Open in the app', href: next.app },
          ...(next.web ? [{ label: 'Continue to the website', href: next.web }] : []),
        ],
      })
    return html(request, response, 200, {
      title: target.project_name,
      message: 'This link opens the app. Open it on your phone, or get the app here.',
      actions: [
        ...(next.ios ? [{ label: 'Download on the App Store', href: next.ios }] : []),
        ...(next.android ? [{ label: 'Get it on Google Play', href: next.android }] : []),
      ],
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

  return { handle, ask, domainFor, linkFor }
}
