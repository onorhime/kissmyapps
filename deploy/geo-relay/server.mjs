// Runs the events relay (relay.mjs) with DB-IP's free city database, and keeps that
// database current: once a day it checks for the month's new file, downloads it beside
// the old one, checks it opens and answers, then swaps it in without a restart.
//
// Environment:
//   KMA_INGEST_URL              the analytics-ingest function URL (required)
//   KMA_ANALYTICS_PROXY_SECRET  the function's ANALYTICS_PROXY_SECRET (required)
//   KMA_GEO_DATABASE            where the database lives (default /data/dbip-city-lite.mmdb)
//   KMA_GEO_AUTO_UPDATE         "0" to never download (default on)
//   KMA_GEO_MIN_FREE_MB         free disk needed before a download (default 400)
//   KMA_GEO_DOWNLOAD_BASE       where the monthly files come from (default DB-IP's)
//   PORT                        default 8787
//
// IP geolocation by DB-IP (https://db-ip.com), licensed under CC BY 4.0.

import { createWriteStream } from 'node:fs'
import { readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { openMmdb } from './mmdb.mjs'
import { createRelay } from './relay.mjs'

const env = process.env
const path = env.KMA_GEO_DATABASE || '/data/dbip-city-lite.mmdb'
const minFree = Number(env.KMA_GEO_MIN_FREE_MB || 400) * 1024 * 1024
const log = (message) => console.log(`${new Date().toISOString()} ${message}`)

let database = null
// The month of DB-IP's file last downloaded, kept beside it: a file can be built on the
// last day of the month before the one it is named for.
let downloaded = null
let checkedAt = null
let lastProblem = null

/** The database's build month, "2026-10", from its metadata. */
const builtMonth = (db) =>
  db ? new Date(Number(db.metadata.build_epoch) * 1000).toISOString().slice(0, 7) : null

/** Opens a file and checks it is a city database that knows a well-known address. */
async function load(file) {
  const db = openMmdb(await readFile(file))
  if (!/city/i.test(String(db.metadata.database_type)))
    throw new Error(`${file} is a ${db.metadata.database_type} database, not a city one.`)
  if (!db.lookup('8.8.8.8')?.country?.iso_code) throw new Error(`${file} does not know 8.8.8.8.`)
  return db
}

const downloadBase = (env.KMA_GEO_DOWNLOAD_BASE || 'https://download.db-ip.com/free').replace(
  /\/+$/,
  '',
)
export const downloadUrl = (month) => `${downloadBase}/dbip-city-lite-${month}.mmdb.gz`

/** This month and last month, newest first: a new month's file appears a day or two in. */
export function wantedMonths(now = new Date()) {
  const month = (date) => date.toISOString().slice(0, 7)
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return [month(now), month(previous)]
}

async function update() {
  checkedAt = new Date().toISOString()
  const have = [builtMonth(database), downloaded].filter(Boolean).sort().at(-1)
  for (const month of wantedMonths()) {
    if (have && have >= month) return
    const disk = await statfs(path.replace(/\/[^/]*$/, '') || '/')
    if (disk.bavail * disk.bsize < minFree) {
      lastProblem = `Not enough free disk to download the ${month} database.`
      return log(lastProblem)
    }
    const response = await fetch(downloadUrl(month), { signal: AbortSignal.timeout(300_000) })
    if (response.status === 404) continue
    if (!response.ok || !response.body) {
      lastProblem = `Downloading the ${month} database failed with ${response.status}.`
      return log(lastProblem)
    }
    const temporary = `${path}.download`
    try {
      await pipeline(Readable.fromWeb(response.body), createGunzip(), createWriteStream(temporary))
      const next = await load(temporary)
      await rename(temporary, path)
      await writeFile(`${path}.month`, month)
      database = next
      downloaded = month
      lastProblem = null
      return log(`Loaded the ${month} database (built ${builtMonth(next)}).`)
    } catch (error) {
      await rm(temporary, { force: true })
      lastProblem = `The ${month} database was not usable: ${error.message}`
      return log(lastProblem)
    }
  }
}

async function main() {
  try {
    database = await load(path)
    downloaded = (await readFile(`${path}.month`, 'utf8').catch(() => '')).trim() || null
    log(`Loaded ${path} (built ${builtMonth(database)}).`)
  } catch (error) {
    lastProblem = error.code === 'ENOENT' ? 'No database yet.' : error.message
    log(`Running without a database: ${lastProblem}`)
  }
  const handle = createRelay({
    upstream: env.KMA_INGEST_URL,
    secret: env.KMA_ANALYTICS_PROXY_SECRET,
    database: () => database,
    status: () => ({
      database: database
        ? { type: database.metadata.database_type, built: builtMonth(database) }
        : null,
      checked_at: checkedAt,
      problem: lastProblem,
    }),
    log,
  })
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      log(`request failed: ${error.message}`)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end('{"error":{"code":"relay_error","message":"The relay failed."}}')
    })
  })
  server.keepAliveTimeout = 65_000
  server.listen(Number(env.PORT || 8787), () => log(`Relay listening on ${env.PORT || 8787}.`))

  if (env.KMA_GEO_AUTO_UPDATE !== '0') {
    const check = () => update().catch((error) => log(`Update check failed: ${error.message}`))
    setTimeout(check, Number(env.KMA_GEO_FIRST_CHECK_MS || 5_000)).unref()
    setInterval(check, 24 * 60 * 60 * 1000).unref()
  }
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()

export { load }
