/** Private TEST-only Stripe CLI forwarding. No webhook endpoint mutation. */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { relayStripeCli } from './merchant-real-relay.mjs'
import { readFile, writeFile, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
const controllerFile = process.argv[2]
if (
  !/^\/tmp\/kma-managed-crossapp\.[A-Za-z0-9]+\/controller-private\.json$/.test(
    controllerFile ?? '',
  )
)
  throw Error('Supply the active private local controller file.')
const directory = dirname(controllerFile),
  root = dirname(dirname(fileURLToPath(import.meta.url)))
const controller = JSON.parse(await readFile(controllerFile, 'utf8'))
if (
  controller.origin !== 'http://127.0.0.1:5194' ||
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(controller.bridgeOrigin) ||
  !/^[a-f0-9]{64}$/.test(controller.control)
)
  throw Error('Invalid loopback controller.')
const file = join(root, '.env.stripe-test.local'),
  stat = await lstat(file)
if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Private TEST key file required.')
const env = parseEnv(await readFile(file, 'utf8')),
  key = env.KMA_REAL_TEST_STRIPE_SECRET_KEY
if (
  !/^sk_test_[A-Za-z0-9]{12,}$/.test(key ?? '') ||
  env.KMA_REAL_TEST_STRIPE_ACCOUNT_ID !== 'acct_1SaSp9E47mNwFlz1'
)
  throw Error('Only the verified KMA TEST platform is permitted.')
const binary = '/tmp/kma-stripe-cli-20261016/node_modules/@stripe/cli-darwin-arm64/bin/stripe'
const webhook =
  controller.bridgeOrigin + '/functions/v1/managed-checkout-webhook?binding_id=merchant-real-test'
const children = [],
  secrets = {},
  localSecrets = {
    platform: 'whsec_' + randomBytes(32).toString('hex'),
    connected: 'whsec_' + randomBytes(32).toString('hex'),
  },
  status = {
    checkedAt: new Date().toISOString(),
    managerPid: process.pid,
    configured: false,
    livemode: false,
    processes: [],
    events: [],
    rejectedEvents: 0,
    realHostedDestinationSecretsTested: false,
    signingBoundary:
      'Real Stripe CLI raw signature verified first; unchanged payload forwarded under two separate local test scope secrets.',
  }
let relay, relayOrigin
let stopping = false
async function save() {
  await writeFile(join(directory, 'merchant-listeners.json'), JSON.stringify(status, null, 2), {
    mode: 0o600,
  })
}
async function stop() {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  if (relay) {
    relay.closeAllConnections()
    await new Promise((r) => relay.close(r))
  }
  status.stoppedAt = new Date().toISOString()
  await save()
}
try {
  relay = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(relayOrigin).host) {
        res.statusCode = 403
        res.end()
        return
      }
      const chunks = []
      let size = 0
      for await (const part of req) {
        size += part.length
        if (size > 512 * 1024) throw Error('Event too large')
        chunks.push(part)
      }
      const response = await relayStripeCli(
        new Request(relayOrigin + req.url, {
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks),
        }),
        {
          cliSecrets: secrets,
          localSecrets,
          forward: (raw, headers) =>
            fetch(webhook, { method: 'POST', headers, body: raw, redirect: 'error' }),
          record: (receipt) => {
            status.events.push(receipt)
            if (status.events.length > 100) status.events.shift()
          },
        },
      )
      if (!response.ok) status.rejectedEvents++
      res.statusCode = response.status
      res.setHeader('content-type', 'application/json')
      res.end(await response.text())
      await save()
    } catch {
      status.rejectedEvents++
      res.statusCode = 400
      res.end('Local relay rejected the event.')
      await save()
    }
  })
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')
  relayOrigin = `http://127.0.0.1:${relay.address().port}`
  status.relayOrigin = relayOrigin
  await Promise.all(
    [
      [
        'platform',
        '@self',
        'application_fee.created,application_fee.refunded,application_fee.refund.updated',
      ],
      [
        'connected',
        '@accounts',
        'checkout.session.completed,checkout.session.expired,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,refund.created,refund.updated,charge.refunded,charge.dispute.created,charge.dispute.updated,charge.dispute.closed',
      ],
    ].map(async ([scope, from, events]) => {
      const config = join(directory, `stripe-${scope}.toml`)
      await writeFile(config, '', { mode: 0o600 })
      const device = `kma-merchant-${scope}-${directory.split('.').at(-1)}`
      const child = spawn(
        binary,
        [
          '--config',
          config,
          '--device-name',
          device,
          'listen',
          '--skip-update',
          '--events-from',
          from,
          '--events',
          events,
          '--forward-to',
          relayOrigin + '/' + scope,
          ...(scope === 'connected' ? ['--forward-connect-to', relayOrigin + '/' + scope] : []),
        ],
        {
          env: {
            PATH: process.env.PATH,
            USER: process.env.USER,
            STRIPE_API_KEY: key,
            STRIPE_DEVICE_NAME: device,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      children.push(child)
      status.processes.push({ scope, pid: child.pid, eventsFrom: from })
      await new Promise((resolve, reject) => {
        let text = '',
          received = false
        const timer = setTimeout(
          () => reject(Error(`${scope} TEST listener readiness timed out.`)),
          30000,
        )
        const inspect = (chunk) => {
          text = (text + chunk).slice(-16384)
          const secret = text.match(/whsec_[A-Za-z0-9]+/)?.[0]
          if (secret && !received) {
            received = true
            clearTimeout(timer)
            secrets[scope] = secret
            resolve()
          }
        }
        child.stdout.on('data', inspect)
        child.stderr.on('data', inspect)
        child.once('exit', (code) => {
          clearTimeout(timer)
          if (!received)
            reject(
              Error(
                `${scope} TEST listener exited before readiness (${code}): ${text.replace(/(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/g, '[redacted]').slice(-1000)}`,
              ),
            )
          if (!stopping && received) {
            status.failure = `${scope} listener stopped`
            save().catch(() => {})
          }
        })
      })
    }),
  )
  status.distinctCliSecrets = secrets.platform !== secrets.connected
  const r = await fetch(controller.origin + '/api/webhook-secrets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-local-control': controller.control },
    body: JSON.stringify({ ...localSecrets, source: 'verified_cli_relay' }),
    redirect: 'error',
  })
  if (!r.ok) throw Error('Local handler rejected the TEST signing-secret configuration.')
  status.configured = true
  await save()
  console.log(JSON.stringify(status))
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => stop().then(() => process.exit(0)))
} catch (error) {
  status.failure = error.message
  console.error(error.message)
  await stop()
  process.exitCode = 1
}
