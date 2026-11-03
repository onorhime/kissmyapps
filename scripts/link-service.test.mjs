import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, get } from 'node:http'
import test from 'node:test'
import {
  classify,
  createClickQueue,
  createLinkService,
  createUpstream,
  newClickId,
  page,
  requestHost,
} from '../deploy/link-service/links.mjs'

const speaksix = {
  host: 'speaksix.go.kissmyapps.dev',
  project_id: 'eff8dda2-6ece-474a-87da-bd604a2c8602',
  kind: 'kma',
  enabled: true,
  ios_app_ids: ['ABCDE12345.app.speaksix.ios'],
  android: { package: 'app.speaksix', sha256: ['AB:CD'] },
  web_url: 'https://speaksix.app/start',
}
const bare = {
  host: 'go.bare.example',
  project_id: 'f0000000-0000-4000-8000-000000000000',
  kind: 'custom',
  enabled: true,
  ios_app_ids: [],
  android: null,
  web_url: null,
}

const launch = {
  id: '0b6d3c8e-7a4f-4e21-9d6b-2f1c5e8a9b70',
  project_id: speaksix.project_id,
  project_name: 'SpeakSix',
  path: 'october-launch',
  status: 'active',
  source: 'tiktok_ads',
  campaign: 'october_launch',
  channel: null,
  adset: 'lagos',
  ad: 'video_1',
  deep_link_value: 'lesson',
  deep_link_params: { id: '4' },
  web_url: 'https://speaksix.app/start?ref=kma',
  ios_url: 'https://apps.apple.com/app/id1612345678',
  ios_custom: false,
  android_url: null,
  android_package: 'app.speaksix',
  social: null,
}
const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  desktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  instagram:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0.0 (iPhone15,4; iOS 18_1; en_NG)',
  tiktok:
    'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 trill_350100 BytedanceWebview/d8a21c6',
  facebook:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0;FBBV/1]',
  whatsapp: 'WhatsApp/2.24.22.79 A',
  slack: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  facebookPreview: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
}

function setup(options = {}) {
  let clock = 1_000_000
  let ids = 0
  const lookups = []
  const linkLookups = []
  const clicks = []
  const seen = []
  const logs = []
  const links = new Map([[`${speaksix.host}/october-launch`, launch]])
  const hosts = new Map([
    [speaksix.host, speaksix],
    [bare.host, bare],
  ])
  const service = createLinkService({
    lookup: async (host) => {
      lookups.push(host)
      if (options.fail?.()) throw new Error('database down')
      return hosts.get(host) ?? null
    },
    seen: async (host) => {
      seen.push(host)
    },
    link: async (host, path) => {
      linkLookups.push(`${host}/${path}`)
      if (options.failLinks?.()) throw new Error('database down')
      return links.get(`${host}/${path}`) ?? null
    },
    record: (click) => clicks.push(click),
    clickId: () => `click${String(++ids).padStart(17, '0')}`,
    now: () => clock,
    log: (message) => logs.push(message),
    ...options.service,
  })
  return {
    service,
    hosts,
    links,
    lookups,
    linkLookups,
    clicks,
    seen,
    logs,
    tick: (ms) => (clock += ms),
  }
}

// The handlers take Node's request and response; these stand in for them.
async function call(
  handler,
  { host = speaksix.host, path = '/', method = 'GET', ua = UA.desktop, headers = {} } = {},
) {
  const request = { method, url: path, headers: { host, 'user-agent': ua, ...headers } }
  const result = { status: 0, headers: {}, body: '' }
  const response = {
    headersSent: false,
    writeHead(status, headers) {
      result.status = status
      result.headers = headers
      this.headersSent = true
    },
    end(body) {
      result.body = body ?? ''
    },
  }
  await handler(request, response)
  return result
}

test('the host is read from the request, without port or trailing dot', () => {
  assert.equal(requestHost('SpeakSix.Go.KissMyApps.dev:443'), 'speaksix.go.kissmyapps.dev')
  assert.equal(requestHost('go.speaksix.app.'), 'go.speaksix.app')
  for (const bad of [undefined, '', 'localhost', '127.0.0.1', 'a b.com', 'x'.repeat(250) + '.com'])
    assert.equal(requestHost(bad), null)
})

test('Apple gets the apps that may open links, for every path but the bare domain', async () => {
  const { service } = setup()
  for (const path of ['/.well-known/apple-app-site-association', '/apple-app-site-association']) {
    const response = await call(service.handle, { path })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(response.body), {
      applinks: {
        details: [
          {
            appIDs: ['ABCDE12345.app.speaksix.ios'],
            components: [{ '/': '/?*', comment: 'Every link; the bare domain opens the website.' }],
          },
        ],
      },
    })
  }
})

test('Android gets the package and its signing certificates', async () => {
  const { service } = setup()
  const response = await call(service.handle, { path: '/.well-known/assetlinks.json' })
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'app.speaksix',
        sha256_cert_fingerprints: ['AB:CD'],
      },
    },
  ])
})

test('a project without apps has no app files', async () => {
  const { service } = setup()
  for (const path of ['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json'])
    assert.equal((await call(service.handle, { host: bare.host, path })).status, 404)
})

test('the bare domain sends people to the website', async () => {
  const { service } = setup()
  const response = await call(service.handle)
  assert.equal(response.status, 302)
  assert.equal(response.headers.location, 'https://speaksix.app/start')
  assert.equal(response.headers['cache-control'], 'no-store, max-age=0')
})

test('a link that does not exist offers the website', async () => {
  const { service } = setup()
  const response = await call(service.handle, { path: '/spring-sale' })
  assert.equal(response.status, 404)
  assert.match(response.headers['content-type'], /^text\/html/)
  assert.match(response.body, /Link not found/)
  assert.match(response.body, /href="https:\/\/speaksix.app\/start"/)
  assert.match(response.headers['content-security-policy'], /default-src 'none'/)
})

test('without a website, the bare domain says links live here', async () => {
  const { service } = setup()
  const response = await call(service.handle, { host: bare.host })
  assert.equal(response.status, 404)
  assert.doesNotMatch(response.body, /Go to the website/)
})

test('when attribution is off, pages say so but the app files stay', async () => {
  const { service, hosts } = setup()
  hosts.set(speaksix.host, { ...speaksix, enabled: false })
  const root = await call(service.handle)
  assert.equal(root.status, 404)
  assert.match(root.body, /Links are turned off/)
  const apple = await call(service.handle, { path: '/.well-known/apple-app-site-association' })
  assert.equal(apple.status, 200)
})

test('unknown hosts and bad hosts are not served', async () => {
  const { service, seen } = setup()
  assert.equal((await call(service.handle, { host: 'nobody.example' })).status, 404)
  assert.equal((await call(service.handle, { host: 'not a host' })).status, 404)
  assert.deepEqual(seen, [])
})

test('only GET and HEAD are answered; HEAD has no body', async () => {
  const { service } = setup()
  const post = await call(service.handle, { method: 'POST' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET, HEAD')
  const head = await call(service.handle, { method: 'HEAD', path: '/.well-known/assetlinks.json' })
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
})

test('robots stay out, and health is answered on any host', async () => {
  const { service, lookups } = setup()
  const robots = await call(service.handle, { path: '/robots.txt' })
  assert.equal(robots.body, 'User-agent: *\nDisallow: /\n')
  const health = await call(service.handle, { host: '127.0.0.1:8788', path: '/healthz' })
  assert.equal(health.status, 200)
  assert.equal(JSON.parse(health.body).ok, true)
  assert.deepEqual(lookups, [speaksix.host])
})

test('answers are kept for a minute, unknown hosts for 15 seconds', async () => {
  const { service, lookups, tick } = setup()
  await call(service.handle)
  await call(service.handle, { path: '/x' })
  assert.equal(lookups.length, 1)
  tick(61_000)
  await call(service.handle)
  assert.equal(lookups.length, 2)
  await call(service.handle, { host: 'new.example' })
  tick(10_000)
  await call(service.handle, { host: 'new.example' })
  assert.equal(lookups.length, 3)
  tick(6_000)
  await call(service.handle, { host: 'new.example' })
  assert.equal(lookups.length, 4)
})

test('requests at once for a host share one lookup', async () => {
  const { service, lookups } = setup()
  await Promise.all([1, 2, 3].map(() => call(service.handle)))
  assert.equal(lookups.length, 1)
})

test('while the database is down, the last answer is used, and without one, a retry page', async () => {
  let down = false
  const { service, tick, logs } = setup({ fail: () => down })
  await call(service.handle)
  down = true
  tick(61_000)
  assert.equal((await call(service.handle)).status, 302)
  const unknown = await call(service.handle, { host: bare.host })
  assert.equal(unknown.status, 503)
  assert.match(unknown.body, /Try again/)
  assert.ok(logs.some((line) => line.includes('using the last answer')))
})

test('a host reached over HTTPS is marked seen, at most hourly', async () => {
  const { service, seen, tick } = setup()
  await call(service.handle)
  await call(service.handle, { path: '/.well-known/assetlinks.json' })
  assert.deepEqual(seen, [speaksix.host])
  tick(60 * 60_000)
  await call(service.handle)
  assert.deepEqual(seen, [speaksix.host, speaksix.host])
})

test('a failed seen is tried again on the next request', async () => {
  const logs = []
  let attempts = 0
  const service = createLinkService({
    lookup: async () => speaksix,
    seen: async () => {
      attempts += 1
      throw new Error('down')
    },
    log: (message) => logs.push(message),
  })
  await call(service.handle)
  await new Promise((resolve) => setImmediate(resolve))
  await call(service.handle)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(attempts, 2)
  assert.ok(logs[0].includes('could not mark'))
})

test('Caddy gets certificates only for link domains', async () => {
  let down = false
  const { service } = setup({ fail: () => down })
  const ask = (domain) => call(service.ask, { path: `/check?domain=${encodeURIComponent(domain)}` })
  assert.equal((await ask('speaksix.go.kissmyapps.dev')).status, 200)
  assert.equal((await ask('GO.BARE.EXAMPLE')).status, 200)
  assert.equal((await ask('nobody.go.kissmyapps.dev')).status, 404)
  assert.equal((await ask('not a host')).status, 400)
  assert.equal((await call(service.ask, { path: '/check' })).status, 400)
  down = true
  assert.equal((await ask('another.example')).status, 503)
})

test('devices, app browsers and robots are told apart', () => {
  assert.deepEqual(classify(UA.iphone), { bot: false, platform: 'ios', inApp: null })
  assert.deepEqual(classify(UA.android), { bot: false, platform: 'android', inApp: null })
  assert.deepEqual(classify(UA.desktop), { bot: false, platform: 'desktop', inApp: null })
  assert.equal(classify(UA.instagram).inApp, 'instagram')
  assert.equal(classify(UA.tiktok).inApp, 'tiktok')
  assert.equal(classify(UA.facebook).inApp, 'facebook')
  for (const ua of [UA.whatsapp, UA.slack, UA.facebookPreview, 'curl/8.7.1', ''])
    assert.equal(classify(ua).bot, true, ua)
  assert.match(newClickId(), /^[A-Za-z0-9_-]{22}$/)
  assert.notEqual(newClickId(), newClickId())
})

test("a computer goes to the website with the click and the link's tags", async () => {
  const { service, clicks } = setup()
  const response = await call(service.handle, {
    path: '/October-Launch/?fbclid=IwAR1&kma_lc=forged&src=instagram&sub1=creator_9',
    headers: { 'x-kma-client-ip': '102.89.1.2', referer: 'https://www.instagram.com/' },
  })
  assert.equal(response.status, 302)
  const url = new URL(response.headers.location)
  assert.equal(url.origin + url.pathname, 'https://speaksix.app/start')
  assert.equal(url.searchParams.get('ref'), 'kma')
  assert.equal(url.searchParams.get('kma_lc'), 'click00000000000000001')
  assert.equal(url.searchParams.get('fbclid'), 'IwAR1', "the ad platform's click ID is passed on")
  assert.equal(url.searchParams.get('utm_source'), 'instagram', 'the address may set the source')
  assert.equal(url.searchParams.get('utm_campaign'), 'october_launch')
  assert.equal(url.searchParams.get('utm_content'), 'video_1')
  assert.equal(url.searchParams.get('src'), null, "the link's own settings are not passed on")
  assert.equal(url.searchParams.get('sub1'), null)
  assert.equal(response.headers['referrer-policy'], 'no-referrer')
  assert.equal(response.headers['cache-control'], 'no-store, max-age=0')
  assert.deepEqual(clicks, [
    {
      id: 'click00000000000000001',
      link_id: launch.id,
      clicked_at: new Date(1_000_000).toISOString(),
      platform: 'desktop',
      in_app: null,
      destination: 'web',
      overrides: { source: 'instagram' },
      params: { sub1: 'creator_9' },
      click_ids: { fbclid: 'IwAR1' },
      ip: '102.89.1.2',
      user_agent: UA.desktop,
      referrer: 'https://www.instagram.com/',
    },
  ])
})

test('an iPhone goes to the App Store, an Android phone to Google Play with the click', async () => {
  const { service, clicks } = setup()
  const iphone = await call(service.handle, { path: '/october-launch', ua: UA.iphone })
  assert.equal(iphone.status, 302)
  assert.equal(iphone.headers.location, 'https://apps.apple.com/app/id1612345678')
  const android = await call(service.handle, { path: '/october-launch?cmp=reels', ua: UA.android })
  const play = new URL(android.headers.location)
  assert.equal(play.origin + play.pathname, 'https://play.google.com/store/apps/details')
  assert.equal(play.searchParams.get('id'), 'app.speaksix')
  const referrer = new URLSearchParams(play.searchParams.get('referrer'))
  assert.equal(referrer.get('kma_lc'), 'click00000000000000002')
  assert.equal(referrer.get('utm_source'), 'tiktok_ads')
  assert.equal(referrer.get('utm_campaign'), 'reels')
  assert.deepEqual(
    clicks.map((c) => [c.platform, c.destination, c.ip]),
    [
      ['ios', 'app_store', undefined],
      ['android', 'play_store', undefined],
    ],
  )
})

test("a link's own store pages win, and a project without apps sends phones to the website", async () => {
  const { service, links } = setup()
  links.set(`${speaksix.host}/custom`, {
    ...launch,
    path: 'custom',
    ios_url: 'https://apps.apple.com/app/id1612345678?ppid=abc',
    ios_custom: true,
    android_url: 'https://play.google.com/store/apps/details?id=app.speaksix&listing=promo',
  })
  links.set(`${speaksix.host}/web-only`, {
    ...launch,
    path: 'web-only',
    ios_url: null,
    android_package: null,
  })
  const ios = await call(service.handle, { path: '/custom', ua: UA.iphone })
  assert.equal(ios.headers.location, 'https://apps.apple.com/app/id1612345678?ppid=abc')
  const android = await call(service.handle, { path: '/custom', ua: UA.android })
  assert.match(android.headers.location, /listing=promo$/)
  const phone = await call(service.handle, { path: '/web-only', ua: UA.iphone })
  assert.match(phone.headers.location, /^https:\/\/speaksix\.app\/start\?.*kma_lc=click/)
})

test("in an app's own browser, people choose the app or the website", async () => {
  const { service, clicks } = setup()
  const response = await call(service.handle, { path: '/october-launch', ua: UA.instagram })
  assert.equal(response.status, 200)
  assert.match(response.body, /Open in the app/)
  assert.match(response.body, /href="https:\/\/apps\.apple\.com\/app\/id1612345678"/)
  assert.match(response.body, /Continue to the website/)
  assert.match(response.body, /kma_lc=click00000000000000001/)
  assert.deepEqual([clicks[0].in_app, clicks[0].destination], ['instagram', 'page'])
})

test('a computer with an app-only link gets the store buttons', async () => {
  const { service, links } = setup()
  links.set(`${speaksix.host}/apps`, { ...launch, path: 'apps', web_url: null })
  const response = await call(service.handle, { path: '/apps' })
  assert.equal(response.status, 200)
  assert.match(response.body, /Download on the App Store/)
  assert.match(response.body, /Get it on Google Play/)
  links.set(`${speaksix.host}/nowhere`, {
    ...launch,
    path: 'nowhere',
    web_url: null,
    ios_url: null,
    android_package: null,
  })
  const nowhere = await call(service.handle, { path: '/nowhere' })
  assert.equal(nowhere.status, 404)
  assert.match(nowhere.body, /nowhere to go/)
})

test('robots get the preview and are never counted', async () => {
  const { service, links, clicks } = setup()
  const plain = await call(service.handle, { path: '/october-launch', ua: UA.whatsapp })
  assert.equal(plain.status, 302, "without a preview of its own, the website's is used")
  assert.equal(new URL(plain.headers.location).searchParams.get('kma_lc'), null)
  links.set(`${speaksix.host}/shared`, {
    ...launch,
    path: 'shared',
    social: {
      title: 'Speak English in 6 weeks',
      description: 'Start <free>',
      image: 'https://speaksix.app/og.png',
    },
  })
  const preview = await call(service.handle, { path: '/shared', ua: UA.facebookPreview })
  assert.equal(preview.status, 200)
  assert.match(preview.body, /<meta property="og:title" content="Speak English in 6 weeks">/)
  assert.match(preview.body, /<meta property="og:description" content="Start &lt;free&gt;">/)
  assert.match(preview.body, /<meta property="og:image" content="https:\/\/speaksix.app\/og.png">/)
  assert.match(
    preview.body,
    /<meta property="og:url" content="https:\/\/speaksix.go.kissmyapps.dev\/shared">/,
  )
  const head = await call(service.handle, { path: '/october-launch', method: 'HEAD' })
  assert.equal(head.body, '')
  assert.deepEqual(clicks, [])
})

test('a paused link goes to the website without counting', async () => {
  const { service, links, clicks } = setup()
  links.set(`${speaksix.host}/paused`, { ...launch, path: 'paused', status: 'paused' })
  const response = await call(service.handle, { path: '/paused', ua: UA.iphone })
  assert.equal(response.status, 302)
  assert.equal(response.headers.location, 'https://speaksix.app/start?ref=kma')
  links.set(`${speaksix.host}/paused-nowhere`, {
    ...launch,
    path: 'paused-nowhere',
    status: 'paused',
    web_url: null,
  })
  const nowhere = await call(service.handle, { path: '/paused-nowhere' })
  assert.equal(nowhere.status, 404)
  assert.match(nowhere.body, /paused/)
  assert.deepEqual(clicks, [])
})

test('links are looked up once a minute and kept while the database is down', async () => {
  let down = false
  const { service, linkLookups, tick, logs } = setup({ failLinks: () => down })
  await call(service.handle, { path: '/october-launch' })
  await call(service.handle, { path: '/OCTOBER-LAUNCH' })
  assert.deepEqual(linkLookups, [`${speaksix.host}/october-launch`])
  tick(61_000)
  down = true
  const stale = await call(service.handle, { path: '/october-launch' })
  assert.equal(stale.status, 302)
  assert.match(logs.join('\n'), /using the last answer/)
  const unknown = await call(service.handle, { path: '/never-seen' })
  assert.equal(unknown.status, 503)
  for (const path of ['/a/b', '/-x', '/' + 'a'.repeat(65)]) {
    const bad = await call(service.handle, { path })
    assert.equal(bad.status, 404, path)
  }
})

test('clicks are sent in batches, kept when sending fails, and the oldest go when full', async () => {
  const sent = []
  const logs = []
  let fail = false
  const timers = []
  const queue = createClickQueue({
    send: async (batch) => {
      if (fail) throw new Error('down')
      sent.push(batch.map((c) => c.id))
    },
    log: (message) => logs.push(message),
    batch: 2,
    max: 3,
    setTimer: (fn, ms) => {
      timers.push(ms)
      return { fn }
    },
    clearTimer: () => {},
  })
  queue.push({ id: 1 })
  assert.deepEqual(timers, [2_000], 'one click waits for the timer')
  queue.push({ id: 2 })
  await queue.flush()
  assert.deepEqual(sent, [[1, 2]], 'a full batch goes at once')
  fail = true
  queue.push({ id: 3 })
  await queue.flush()
  assert.equal(queue.size, 1)
  assert.match(logs.join('\n'), /could not send 1 clicks/)
  for (const id of [4, 5, 6]) queue.push({ id })
  assert.equal(queue.size, 3)
  assert.match(logs.join('\n'), /dropping 1 clicks/)
  fail = false
  await queue.flush()
  assert.deepEqual(sent, [[1, 2], [4, 5], [6]])
  assert.equal(queue.size, 0)
})

test('the page escapes what it shows', () => {
  const html = page({ title: '<b>', message: '"x"', website: 'https://a.example/?a=1&b="2"' })
  assert.match(html, /&lt;b&gt;/)
  assert.match(html, /&quot;x&quot;/)
  assert.match(html, /href="https:\/\/a.example\/\?a=1&amp;b=&quot;2&quot;"/)
})

test('the upstream calls attribution-links with the secret', async () => {
  const calls = []
  const upstream = createUpstream({
    url: 'https://ref.supabase.co/functions/v1/attribution-links',
    secret: 's'.repeat(40),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      const { action } = JSON.parse(init.body)
      const answers = {
        host: { domain: speaksix },
        seen: { seen: true },
        link: { link: launch },
        clicks: { stored: 2 },
      }
      return new Response(JSON.stringify(answers[action]), { status: 200 })
    },
  })
  assert.deepEqual(await upstream.lookup(speaksix.host), speaksix)
  assert.equal(await upstream.seen(speaksix.host), true)
  assert.equal(calls[0].url, 'https://ref.supabase.co/functions/v1/attribution-links')
  assert.equal(calls[0].init.headers['x-kma-link-secret'], 's'.repeat(40))
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'host', host: speaksix.host })
  assert.deepEqual(JSON.parse(calls[1].init.body), { action: 'seen', host: speaksix.host })
  assert.deepEqual(await upstream.link(speaksix.host, 'october-launch'), launch)
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    action: 'link',
    host: speaksix.host,
    path: 'october-launch',
  })
  assert.equal(await upstream.clicks([{ id: 'a' }, { id: 'b' }]), 2)
  assert.deepEqual(JSON.parse(calls[3].init.body), {
    action: 'clicks',
    clicks: [{ id: 'a' }, { id: 'b' }],
  })

  const failing = createUpstream({
    url: 'https://ref.supabase.co/functions/v1/attribution-links',
    secret: 's'.repeat(40),
    fetchImpl: async () => new Response('{}', { status: 503 }),
  })
  await assert.rejects(failing.lookup(speaksix.host), /answered 503/)
  assert.throws(() => createUpstream({ url: 'https://x', secret: 'short' }), /secret/)
})

test('the server answers links and certificate checks on their own ports', async (t) => {
  const received = []
  // A stand-in for the attribution-links function.
  const fake = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const { action, host, path, clicks } = JSON.parse(body)
      const ok = request.headers['x-kma-link-secret'] === 's'.repeat(40)
      if (action === 'clicks') received.push(...clicks)
      response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          action === 'host'
            ? { domain: host === speaksix.host ? speaksix : null }
            : action === 'link'
              ? { link: host === speaksix.host && path === 'october-launch' ? launch : null }
              : action === 'clicks'
                ? { stored: clicks.length }
                : { seen: true },
        ),
      )
    })
  })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  t.after(() => fake.close())
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const child = spawn(process.execPath, ['deploy/link-service/server.mjs'], {
    env: {
      ...process.env,
      KMA_LINKS_URL: `http://127.0.0.1:${fake.address().port}/functions/v1/attribution-links`,
      KMA_ATTRIBUTION_LINK_SECRET: 's'.repeat(40),
      PORT: String(port),
      ASK_PORT: String(port + 1),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  t.after(() => child.kill())
  let started = 0
  await new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => {
      started += (String(chunk).match(/listening/g) ?? []).length
      if (started === 2) resolve()
    })
    child.on('exit', (code) => reject(new Error(`server exited with ${code}`)))
  })
  // fetch sets Host itself, so ask with http.get as Caddy would, naming the link domain.
  const apple = await new Promise((resolve, reject) => {
    get(
      {
        port,
        host: '127.0.0.1',
        path: '/.well-known/apple-app-site-association',
        headers: { host: speaksix.host },
      },
      (response) => {
        let body = ''
        response.on('data', (chunk) => (body += chunk))
        response.on('end', () => resolve({ status: response.statusCode, body }))
      },
    ).on('error', reject)
  })
  assert.equal(apple.status, 200)
  assert.deepEqual(JSON.parse(apple.body).applinks.details[0].appIDs, speaksix.ios_app_ids)
  const ask = await fetch(`http://127.0.0.1:${port + 1}/?domain=${speaksix.host}`)
  assert.equal(ask.status, 200)
  const unknown = await fetch(`http://127.0.0.1:${port + 1}/?domain=nobody.example`)
  assert.equal(unknown.status, 404)
  // A click on a link is answered at once and reaches the database within a few seconds.
  const link = await new Promise((resolve, reject) => {
    get(
      {
        port,
        host: '127.0.0.1',
        path: '/october-launch',
        headers: { host: speaksix.host, 'user-agent': UA.desktop, 'x-kma-client-ip': '102.89.1.2' },
      },
      (response) => {
        response.resume()
        resolve({ status: response.statusCode, location: response.headers.location })
      },
    ).on('error', reject)
  })
  assert.equal(link.status, 302)
  const id = new URL(link.location).searchParams.get('kma_lc')
  assert.match(id, /^[A-Za-z0-9_-]{22}$/)
  for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(
    received.map((c) => [c.id, c.ip, c.platform]),
    [[id, '102.89.1.2', 'desktop']],
  )
})
