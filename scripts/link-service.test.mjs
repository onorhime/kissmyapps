import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, get } from 'node:http'
import test from 'node:test'
import {
  createLinkService,
  createUpstream,
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

function setup(options = {}) {
  let clock = 1_000_000
  const lookups = []
  const seen = []
  const logs = []
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
    now: () => clock,
    log: (message) => logs.push(message),
    ...options.service,
  })
  return { service, hosts, lookups, seen, logs, tick: (ms) => (clock += ms) }
}

// The handlers take Node's request and response; these stand in for them.
async function call(handler, { host = speaksix.host, path = '/', method = 'GET' } = {}) {
  const request = { method, url: path, headers: { host } }
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
      return new Response(
        JSON.stringify(action === 'host' ? { domain: speaksix } : { seen: true }),
        {
          status: 200,
        },
      )
    },
  })
  assert.deepEqual(await upstream.lookup(speaksix.host), speaksix)
  assert.equal(await upstream.seen(speaksix.host), true)
  assert.equal(calls[0].url, 'https://ref.supabase.co/functions/v1/attribution-links')
  assert.equal(calls[0].init.headers['x-kma-link-secret'], 's'.repeat(40))
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'host', host: speaksix.host })
  assert.deepEqual(JSON.parse(calls[1].init.body), { action: 'seen', host: speaksix.host })

  const failing = createUpstream({
    url: 'https://ref.supabase.co/functions/v1/attribution-links',
    secret: 's'.repeat(40),
    fetchImpl: async () => new Response('{}', { status: 503 }),
  })
  await assert.rejects(failing.lookup(speaksix.host), /answered 503/)
  assert.throws(() => createUpstream({ url: 'https://x', secret: 'short' }), /secret/)
})

test('the server answers links and certificate checks on their own ports', async (t) => {
  // A stand-in for the attribution-links function.
  const fake = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const { action, host } = JSON.parse(body)
      const ok = request.headers['x-kma-link-secret'] === 's'.repeat(40)
      response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          action === 'host' ? { domain: host === speaksix.host ? speaksix : null } : { seen: true },
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
})
