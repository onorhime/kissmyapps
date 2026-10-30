import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { MmdbError, openMmdb } from '../deploy/geo-relay/mmdb.mjs'
import { buildMmdb } from '../deploy/geo-relay/mmdb-writer.mjs'
import { createRelay, placeOf } from '../deploy/geo-relay/relay.mjs'

// A small city database of known addresses, shaped like DB-IP's.
const place = (country, region, city) => ({
  city: { names: { en: city } },
  continent: { code: 'AF' },
  country: { iso_code: country, names: { en: country } },
  location: { latitude: 1.5, longitude: 2.5 },
  subdivisions: [{ names: { en: region } }],
})
const networks = [
  { network: '102.89.0.0/16', data: place('NG', 'Lagos', 'Lagos') },
  { network: '105.112.0.0/16', data: place('NG', 'Lagos', 'Lagos') },
  { network: '41.58.0.0/16', data: place('NG', 'Oyo', 'Ibadan') },
  { network: '83.4.0.0/16', data: place('PL', 'Łódź Voivodeship', 'Łódź') },
  { network: '8.8.8.0/24', data: place('US', 'California', 'Mountain View') },
  { network: '2a02:c7c::/32', data: place('GB', 'England', 'London') },
  // A country with no region or city, as DB-IP has for some ranges.
  { network: '196.200.0.0/16', data: { country: { iso_code: 'GH' } } },
]

test('reads what was written, at every record size', () => {
  for (const recordSize of [24, 28, 32]) {
    const db = openMmdb(buildMmdb({ networks, recordSize }))
    assert.equal(db.metadata.record_size, recordSize)
    assert.equal(db.metadata.database_type, 'DBIP-City-Lite')
    assert.equal(db.lookup('102.89.40.1').city.names.en, 'Lagos')
    assert.equal(db.lookup('41.58.200.9').city.names.en, 'Ibadan')
    assert.equal(db.lookupWithPrefix('83.4.1.2').prefixLength, 16)
    // IPv4 inside IPv6, and IPv4-mapped IPv6, find the same network.
    assert.equal(db.lookup('::ffff:102.89.0.1').city.names.en, 'Lagos')
    assert.equal(db.lookup('2a02:c7c:1:2::9').city.names.en, 'London')
    assert.equal(db.lookup('[2a02:c7c::1]').city.names.en, 'London')
    assert.equal(db.lookup('8.8.4.4'), null)
    assert.equal(db.lookup('2001:db8::1'), null)
    for (const bad of ['', 'localhost', '300.1.1.1', '1.2.3', null, 42])
      assert.equal(db.lookup(bad), null)
  }
})

test('refuses files that are not databases', () => {
  assert.throws(() => openMmdb(Buffer.from('not a database')), MmdbError)
  const good = buildMmdb({ networks })
  // The search tree cut away from its metadata.
  assert.throws(() => openMmdb(good.subarray(good.length - 300)), MmdbError)
})

test('a record becomes a country, region and city', () => {
  assert.deepEqual(placeOf(networks[3].data), {
    country: 'PL',
    region: 'Łódź Voivodeship',
    city: 'Łódź',
  })
  assert.deepEqual(placeOf(networks[6].data), { country: 'GH' })
  assert.equal(placeOf(null), null)
  assert.equal(placeOf({ country: { iso_code: 'ZZZ' } }), null)
  assert.equal(
    placeOf({ country: { iso_code: 'NG' }, city: { names: { en: 'x'.repeat(81) } } }).city,
    undefined,
  )
})

async function listen(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

/** The ingest function as the relay sees it: records each request and answers like it. */
async function fakeIngest() {
  const seen = []
  const { server, url } = await listen((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      })
      response.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': 'https://speaksix.com',
        'x-request-id': 'r-1',
      })
      response.end('{"stored":1}')
    })
  })
  return { seen, server, url }
}

const send = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('the relay names the visitor and their place, with the secret, and passes the answer back', async () => {
  const ingest = await fakeIngest()
  const db = openMmdb(buildMmdb({ networks }))
  const relay = await listen(
    createRelay({
      upstream: `${ingest.url}/functions/v1/analytics-ingest/`,
      secret: 's3cret',
      database: () => db,
      log: () => {},
    }),
  )
  try {
    const body = { anonymous_id: 'a-1', events: [{ name: 'page_viewed' }] }
    const response = await send(`${relay.url}/v1/events?x=1`, body, {
      authorization: 'Bearer kma_pk_live_AAAAAAAAAAAAAAAAAAAAAAAA',
      origin: 'https://speaksix.com',
      'x-kma-client-ip': '83.4.1.2',
      // Whatever a browser claims is replaced, never passed on.
      'x-kma-country': 'US',
      'x-kma-proxy': 'guess',
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://speaksix.com')
    assert.equal(await response.text(), '{"stored":1}')
    const [hop] = ingest.seen
    assert.equal(hop.url, '/functions/v1/analytics-ingest/v1/events?x=1')
    assert.deepEqual(JSON.parse(hop.body), body)
    assert.equal(hop.headers['x-kma-proxy'], 's3cret')
    assert.equal(hop.headers['x-kma-via'], 'geo-relay')
    assert.equal(hop.headers['x-kma-client-ip'], '83.4.1.2')
    assert.equal(hop.headers['x-kma-country'], 'PL')
    assert.equal(decodeURIComponent(hop.headers['x-kma-region']), 'Łódź Voivodeship')
    assert.equal(decodeURIComponent(hop.headers['x-kma-city']), 'Łódź')
    assert.equal(hop.headers['x-kma-place-source'], 'ip')
    assert.equal(hop.headers.origin, 'https://speaksix.com')
    assert.equal(hop.headers['x-kma-context-country'], undefined)

    // An address the database does not know goes on without a place.
    await send(`${relay.url}/v1/replay`, { replay: {} }, { 'x-kma-client-ip': '10.1.2.3' })
    assert.equal(ingest.seen[1].headers['x-kma-client-ip'], '10.1.2.3')
    assert.equal(ingest.seen[1].headers['x-kma-country'], undefined)
    assert.equal(ingest.seen[1].headers['x-kma-place-source'], undefined)

    // Preflights pass through for the function to answer.
    const preflight = await fetch(`${relay.url}/v1/events`, {
      method: 'OPTIONS',
      headers: { origin: 'https://speaksix.com' },
    })
    assert.equal(preflight.status, 200)
    assert.equal(ingest.seen[2].method, 'OPTIONS')
  } finally {
    relay.server.close()
    ingest.server.close()
  }
})

test("a merchant's server can name its user's address, and only a server key's is looked up", async () => {
  const ingest = await fakeIngest()
  const db = openMmdb(buildMmdb({ networks }))
  const relay = await listen(
    createRelay({ upstream: ingest.url, secret: 's', database: () => db, log: () => {} }),
  )
  try {
    const body = { context: { ip: '41.58.1.1' }, events: [] }
    await send(`${relay.url}/v1/events`, body, {
      authorization: 'Bearer kma_sk_live_AAAAAAAAAAAAAAAAAAAAAAAA',
      'x-kma-client-ip': '8.8.8.8',
    })
    const [server] = ingest.seen
    assert.equal(server.headers['x-kma-context-country'], 'NG')
    assert.equal(server.headers['x-kma-context-city'], 'Ibadan')
    // The connection's own place still travels, for the function to ignore on server keys.
    assert.equal(server.headers['x-kma-country'], 'US')
    await send(`${relay.url}/v1/events`, {
      ...body,
      api_key: 'kma_sk_live_AAAAAAAAAAAAAAAAAAAAAAAA',
    })
    assert.equal(ingest.seen[1].headers['x-kma-context-country'], 'NG')
    await send(`${relay.url}/v1/events`, body, {
      authorization: 'Bearer kma_pk_live_AAAAAAAAAAAAAAAAAAAAAAAA',
    })
    assert.equal(ingest.seen[2].headers['x-kma-context-country'], undefined)
    await send(`${relay.url}/v1/events`, '{not json', {
      authorization: 'Bearer kma_sk_live_AAAAAAAAAAAAAAAAAAAAAAAA',
    })
    assert.equal(ingest.seen[3].body, '{not json')
  } finally {
    relay.server.close()
    ingest.server.close()
  }
})

test('the relay keeps working without a database and says when the function is unreachable', async () => {
  const ingest = await fakeIngest()
  const relay = await listen(
    createRelay({
      upstream: ingest.url,
      secret: 's',
      database: () => null,
      status: () => ({ database: null }),
      maxBody: 64,
      log: () => {},
    }),
  )
  const dead = await listen(() => {})
  const deadUrl = dead.url
  dead.server.close()
  const orphan = await listen(
    createRelay({ upstream: deadUrl, secret: 's', database: () => null, log: () => {} }),
  )
  try {
    const health = await fetch(`${relay.url}/healthz`)
    assert.deepEqual(await health.json(), { ok: true, database: null })
    assert.equal(
      (await send(`${relay.url}/v1/events`, {}, { 'x-kma-client-ip': '102.89.1.1' })).status,
      200,
    )
    assert.equal(ingest.seen[0].headers['x-kma-country'], undefined)
    assert.equal(ingest.seen[0].headers['x-kma-client-ip'], '102.89.1.1')
    assert.equal((await fetch(`${relay.url}/other`)).status, 404)
    assert.equal((await fetch(`${relay.url}/v1/events`)).status, 405)
    assert.equal((await send(`${relay.url}/v1/events`, { padding: 'x'.repeat(100) })).status, 413)
    const failed = await send(`${orphan.url}/v1/events`, {})
    assert.equal(failed.status, 502)
    assert.equal((await failed.json()).error.code, 'upstream_unavailable')
    assert.throws(() => createRelay({ upstream: ingest.url, database: () => null }))
  } finally {
    relay.server.close()
    orphan.server.close()
    ingest.server.close()
  }
})

async function until(check, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await check().catch(() => null)
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out waiting.')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test("the server downloads the month's database, swaps it in and relays with it", async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geo-relay-'))
  const ingest = await fakeIngest()
  const month = new Date().toISOString().slice(0, 7)
  const requested = []
  const files = await listen((request, response) => {
    requested.push(request.url)
    if (request.url === `/free/dbip-city-lite-${month}.mmdb.gz`) {
      response.writeHead(200, { 'content-type': 'application/gzip' })
      response.end(gzipSync(buildMmdb({ networks })))
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(
    process.execPath,
    [new URL('../deploy/geo-relay/server.mjs', import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PORT: String(port),
        KMA_INGEST_URL: ingest.url,
        KMA_ANALYTICS_PROXY_SECRET: 'from-env',
        KMA_GEO_DATABASE: join(directory, 'city.mmdb'),
        KMA_GEO_DOWNLOAD_BASE: `${files.url}/free/`,
        KMA_GEO_FIRST_CHECK_MS: '20',
        KMA_GEO_MIN_FREE_MB: '1',
      },
      stdio: 'ignore',
    },
  )
  try {
    const health = await until(async () => {
      const body = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()
      return body.database ? body : null
    })
    assert.equal(health.database.type, 'DBIP-City-Lite')
    assert.equal(health.problem, null)
    assert.deepEqual(requested, [`/free/dbip-city-lite-${month}.mmdb.gz`])
    assert.equal((await readFile(join(directory, 'city.mmdb.month'), 'utf8')).trim(), month)
    await assert.rejects(stat(join(directory, 'city.mmdb.download')))
    await send(`http://127.0.0.1:${port}/v1/events`, {}, { 'x-kma-client-ip': '102.89.3.4' })
    assert.equal(ingest.seen[0].headers['x-kma-city'], 'Lagos')
    assert.equal(ingest.seen[0].headers['x-kma-proxy'], 'from-env')
  } finally {
    child.kill()
    files.server.close()
    ingest.server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a download that is not a usable database is thrown away', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'geo-relay-'))
  const files = await listen((request, response) => {
    response.writeHead(200)
    response.end(gzipSync(Buffer.from('not a database')))
  })
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(
    process.execPath,
    [new URL('../deploy/geo-relay/server.mjs', import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PORT: String(port),
        KMA_INGEST_URL: 'http://127.0.0.1:9',
        KMA_ANALYTICS_PROXY_SECRET: 's',
        KMA_GEO_DATABASE: join(directory, 'city.mmdb'),
        KMA_GEO_DOWNLOAD_BASE: files.url,
        KMA_GEO_FIRST_CHECK_MS: '20',
        KMA_GEO_MIN_FREE_MB: '1',
      },
      stdio: 'ignore',
    },
  )
  try {
    const health = await until(async () => {
      const body = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()
      return body.checked_at && body.problem !== 'No database yet.' ? body : null
    })
    assert.equal(health.database, null)
    assert.match(health.problem, /not usable/)
    await assert.rejects(stat(join(directory, 'city.mmdb')))
    await assert.rejects(stat(join(directory, 'city.mmdb.download')))
  } finally {
    child.kill()
    files.server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
