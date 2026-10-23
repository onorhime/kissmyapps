/** Real Connect.js + real creator-connect handler + disposable PostgreSQL.
 * Real test credentials arrive ONLY through stdin. Never reads .env files.
 * --fake-smoke tests the bridge without contacting any provider.
 * --stripe-test stays open for authorized browser acceptance (Ctrl-C stops DB).
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, lstatSync, copyFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve, join } from 'node:path'
import { userInfo } from 'node:os'
import assert from 'node:assert/strict'
import {
  browserOrigin,
  bridgeOrigin,
  validateTestCredentials,
  localBrowserRequestAllowed,
} from './creator-connect-browser-policy.mjs'

const mode = process.argv[2]
const resumeArgs = process.argv.slice(3)
const resuming = resumeArgs.length > 0
if (!['--fake-smoke', '--stripe-test'].includes(mode) || (resuming && (
  mode !== '--stripe-test' || resumeArgs.length !== 4 ||
  resumeArgs[0] !== '--resume-fixture' || !/^\/tmp\/kma-creator-browser\.[A-Za-z0-9]+$/.test(resumeArgs[1]) ||
  resumeArgs[2] !== '--expected-account' || !/^acct_[A-Za-z0-9]+$/.test(resumeArgs[3])
))) {
  throw Error('Use --fake-smoke, or --stripe-test with optional --resume-fixture /tmp/kma-creator-browser.ID --expected-account acct_ID.')
}
const expectedAccount = resuming ? resumeArgs[3] : null
let raw = ''
if (mode === '--stripe-test') {
  for await (const chunk of process.stdin) {
    raw += chunk
    if (raw.length > 16_384) throw Error('Credential input exceeds the local limit.')
  }
}
let credentials
try {
  credentials = validateTestCredentials(
    mode === '--fake-smoke'
      ? {
          secretKey: 'sk_test_localfixture',
          publishableKey: 'pk_test_localfixture',
          platformAccountId: 'acct_fixture',
        }
      : JSON.parse(raw),
  )
} catch {
  throw Error('Invalid input: provide only verified KMA Stripe test credentials through stdin.')
}
raw = ''
const root = resolve(import.meta.dirname, '..'),
  pg = '/opt/homebrew/opt/postgresql@17/bin'
const directory = resuming ? resumeArgs[1] : mkdtempSync('/tmp/kma-creator-browser.'),
  token = randomBytes(32).toString('hex'), runId = randomBytes(12).toString('hex')
const metadataFile = join(directory, 'fixture-metadata.json')
let metadata
if (resuming) {
  const owned = (path, directoryExpected = false) => {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || info.uid !== userInfo().uid ||
      (directoryExpected ? !info.isDirectory() : !info.isFile())) throw Error('Only an owned local fixture may be resumed.')
  }
  owned(directory, true); owned(join(directory, 'data'), true)
  owned(join(directory, 'data/PG_VERSION'))
  owned(join(directory, 'acceptance-evidence.json'))
  if (existsSync(join(directory, 'data/postmaster.pid')) || readFileSync(join(directory, 'data/PG_VERSION'), 'utf8').trim() !== '17') throw Error('Resume requires a stopped PostgreSQL 17 fixture.')
  const previous = JSON.parse(readFileSync(join(directory, 'acceptance-evidence.json'), 'utf8'))
  if (previous.mode !== 'stripe-test' || previous.account?.connectedAccountId !== expectedAccount || previous.databaseOnlyLocal !== true || previous.moneyMovementEnabled !== false) throw Error('Saved test evidence does not match the expected creator account.')
  if (existsSync(metadataFile)) {
    owned(metadataFile)
    metadata = JSON.parse(readFileSync(metadataFile, 'utf8'))
    if (metadata.version !== 1 || metadata.kind !== 'local-creator-connect' || metadata.mode !== 'stripe-test' || metadata.platformAccountId !== credentials.platformAccountId || metadata.connectedAccountId !== expectedAccount) throw Error('Fixture identity differs from the supplied test credentials.')
  } else if (directory !== '/tmp/kma-creator-browser.O5Dl02' || expectedAccount !== 'acct_1URJIdE2asTL6F4V') {
    // Only this explicitly approved, pre-manifest fixture can be adopted once.
    throw Error('This older fixture has no verified resume metadata.')
  }
  copyFileSync(join(directory, 'acceptance-evidence.json'), join(directory, `acceptance-evidence-before-${runId}.json`))
}
const env = { PATH: process.env.PATH, USER: userInfo().username, LC_ALL: 'C', LANG: 'C' }
const run = (name, args, input) =>
  execFileSync(join(pg, name), args, {
    cwd: root,
    env,
    input,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
const sql = (statement) =>
  run('psql', ['-h', directory, '-d', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1'], statement)
let started = false,
  bridge,
  vite,
  ending = false
const saveEvidence = async () => {
  if (!bridge || bridge.exitCode !== null) return
  const response = await fetch(`${bridgeOrigin}/evidence`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (response.ok) {
    const evidence = await response.json()
    writeFileSync(
      join(directory, 'acceptance-evidence.json'),
      JSON.stringify(evidence, null, 2),
      { mode: 0o600 },
    )
    writeFileSync(join(directory, `acceptance-evidence-${runId}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 })
    metadata.connectedAccountId = evidence.account?.connectedAccountId ?? metadata.connectedAccountId
    writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), { mode: 0o600 })
  }
}
const shutdown = async () => {
  if (ending) return
  ending = true
  await saveEvidence().catch(() => {})
  await vite?.close().catch(() => {})
  bridge?.kill('SIGTERM')
  if (started) {
    run('pg_ctl', ['-D', join(directory, 'data'), 'stop', '-m', 'fast'])
    started = false
  }
}
try {
  if (!resuming) run('initdb', ['-D', join(directory, 'data'), '-A', 'trust', '--locale=C'])
  run('pg_ctl', [
    '-D',
    join(directory, 'data'),
    '-l',
    join(directory, 'postgres.log'),
    '-o',
    `-k ${directory} -c listen_addresses=''`,
    'start',
  ])
  started = true
  if (resuming) {
    const scope = JSON.parse(sql(`select jsonb_build_object('listen',current_setting('listen_addresses'),'socket',current_setting('unix_socket_directories'),'accounts',(select jsonb_agg(jsonb_build_object('affiliate',affiliate_id,'platform',platform_account_id,'livemode',livemode,'connected',connect_account_id)) from public.external_creator_accounts),'money_jobs',(select count(*) from public.external_settlement_jobs));`).trim())
    if (scope.listen !== '' || scope.socket !== directory || scope.money_jobs !== 0 || scope.accounts?.length !== 1 ||
      scope.accounts[0].affiliate !== 'ac570000-0000-4000-8000-000000000003' || scope.accounts[0].platform !== credentials.platformAccountId ||
      scope.accounts[0].livemode !== false || scope.accounts[0].connected !== expectedAccount) throw Error('Persisted database is not the expected isolated test creator fixture.')
  } else {
  sql(
    readFileSync(join(root, 'supabase/tests/bootstrap/external-commerce-native.sql'), 'utf8') +
      `\nalter table auth.users add column created_at timestamptz default now(),add column updated_at timestamptz default now(),add column last_sign_in_at timestamptz;grant usage on schema storage,extensions to anon,authenticated,service_role;grant all on storage.objects to authenticated,service_role;alter table storage.objects enable row level security;`,
  )
  for (const name of readdirSync(join(root, 'supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    sql(
      readFileSync(join(root, 'supabase/migrations', name), 'utf8').replace(
        /^create extension if not exists pg_net with schema extensions;\s*$/m,
        '',
      ),
    )
  }
  // Existing signed canonical fixture; no purchase, payout batch or transfer jobs.
  const fixture = readFileSync(
    join(root, 'supabase/tests/fixtures/external-canonical.sql'),
    'utf8',
  ).replaceAll('acct_fixture', credentials.platformAccountId)
  sql(
    `begin;${fixture}\nupdate public.external_settlement_platforms set enabled=true where platform_account_id='${credentials.platformAccountId}' and not livemode;commit;`,
  )
  // Synthetic, confirmed profile data exercises the same server-side prefill
  // used for a real creator. No real person's contact or identity is supplied.
  sql(`update auth.users set email='creator.prefill@example.com',email_confirmed_at=now() where id='ac570000-0000-4000-8000-000000000012';
    update public.affiliates set entity_type='individual' where id='ac570000-0000-4000-8000-000000000003';`)
  }
  metadata = { version: 1, kind: 'local-creator-connect', mode: mode === '--fake-smoke' ? 'fake' : 'stripe-test', platformAccountId: credentials.platformAccountId, connectedAccountId: expectedAccount, resumed: resuming, runId }
  writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), { mode: 0o600 })
  bridge = spawn(
    'deno',
    [
      'run',
      '--config',
      'supabase/functions/deno.json',
      '--allow-env=USER',
      `--allow-run=${pg}/psql`,
      mode === '--fake-smoke'
        ? '--allow-net=127.0.0.1:5194'
        : '--allow-net=api.stripe.com,127.0.0.1:5194',
      'scripts/creator-connect-browser-bridge.ts',
    ],
    { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  bridge.stdin.end(
    JSON.stringify({
      credentials,
      socket: directory,
      token,
      mode: mode === '--fake-smoke' ? 'fake' : 'stripe-test',
      expectedAccount,
      runId,
    }),
  )
  // Do not forward child errors: provider/SDK exceptions could contain secrets.
  bridge.stderr.resume()
  bridge.stdout.resume()
  credentials = null
  let ready = false
  for (let attempt = 0; attempt < 150; attempt++) {
    if (bridge.exitCode !== null)
      throw Error(
        'Creator bridge stopped before readiness; verify test credential scope and configuration.',
      )
    try {
      ready = (await fetch(`${bridgeOrigin}/health`)).ok
    } catch {
      /* Startup only. */
    }
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (!ready) throw Error('Local creator bridge did not become ready.')
  // Vite gets neither .env files nor inherited browser configuration.
  for (const key of Object.keys(process.env)) if (key.startsWith('VITE_')) delete process.env[key]
  const { createServer } = await import('vite'),
    { default: react } = await import('@vitejs/plugin-react')
  vite = await createServer({
    root,
    configFile: false,
    envDir: false,
    plugins: [
      react(),
      {
        name: 'local-creator-acceptance',
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            const send = (status, body) => {
              response.writeHead(status, {
                'content-type': 'application/json',
                'cache-control': 'no-store',
              })
              response.end(JSON.stringify(body))
            }
            if (request.headers.host !== '127.0.0.1:5193')
              return send(403, { error: 'Loopback host required.' })
            if (
              request.url?.split('?')[0] === '/creator-connect-local.html' &&
              request.method === 'GET'
            ) {
              response.setHeader(
                'set-cookie',
                `kma_creator_local=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
              )
              response.setHeader('cache-control', 'no-store')
              response.setHeader('cross-origin-opener-policy', 'unsafe-none')
              response.setHeader('referrer-policy', 'no-referrer')
              response.setHeader('content-type', 'text/html')
              response.end(
                await server.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KMA local Stripe test onboarding</title></head><body style="margin:0;background:#f7f8f4;font-family:system-ui;color:#173d35"><div id="root"></div><script type="module" src="/scripts/creator-connect-browser-ui.tsx"></script></body></html>',
                ),
              )
              return
            }
            if (!request.url?.startsWith('/__creator/')) return next()
            if (request.method !== 'POST' || !localBrowserRequestAllowed(request.headers, token))
              return send(403, { error: 'Authenticated local creator request required.' })
            if (request.url === '/__creator/signout') {
              response.setHeader(
                'set-cookie',
                'kma_creator_local=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
              )
              return send(200, { signedOut: true })
            }
            if (request.url !== '/__creator/connect')
              return send(404, { error: 'Unavailable local operation.' })
            try {
              let body = ''
              for await (const chunk of request) {
                body += chunk
                if (body.length > 2048) return send(413, { error: 'Request too large.' })
              }
              const result = await fetch(`${bridgeOrigin}/creator-connect`, {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${token}`,
                  origin: browserOrigin,
                  'content-type': 'application/json',
                },
                body,
              })
              const payload = await result.text()
              response.writeHead(result.status, {
                'content-type': 'application/json',
                'cache-control': 'no-store, max-age=0',
                'referrer-policy': 'no-referrer',
              })
              response.end(payload)
              // Return short-lived Account Session data promptly; evidence is
              // private and must never delay the browser receiving its session.
              void saveEvidence().catch(() => {})
            } catch {
              send(500, { error: 'Local creator setup could not complete the request.' })
            }
          })
        },
      },
    ],
    server: {
      host: '127.0.0.1',
      port: 5193,
      strictPort: true,
      headers: { 'Cross-Origin-Opener-Policy': 'unsafe-none' },
    },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': '""',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '""',
    },
  })
  await vite.listen()
  console.log(`Local creator acceptance: ${browserOrigin}/creator-connect-local.html`)
  console.log(
    `Disposable database and safe evidence: ${directory}. No keys or Account Session secrets are written.`,
  )
  if (mode === '--fake-smoke') {
    const doc = await fetch(`${browserOrigin}/creator-connect-local.html`)
    assert.equal(
      (await fetch(`${browserOrigin}/scripts/creator-connect-browser-ui.tsx`)).status,
      200,
    )
    const cookie = doc.headers.get('set-cookie').split(';')[0]
    const invoke = (body, overrides = {}) =>
      fetch(`${browserOrigin}/__creator/connect`, {
        method: 'POST',
        headers: {
          cookie,
          origin: browserOrigin,
          'content-type': 'application/json',
          ...overrides,
        },
        body: JSON.stringify(body),
      })
    assert.equal((await invoke({ action: 'status' }, { cookie: '' })).status, 403)
    assert.equal(
      (await invoke({ action: 'status' }, { origin: 'https://unrelated.invalid' })).status,
      403,
    )
    const initial = await (await invoke({ action: 'status' })).json()
    assert.equal(initial.bindings[0].status, 'not_connected')
    const created = await invoke({ action: 'session', binding_id: 'local_test', country: 'US' })
    assert.equal(created.status, 200)
    assert.match(created.headers.get('cache-control'), /no-store/)
    const session = await created.json()
    assert.equal(session.account_session.livemode, false)
    assert.equal(session.account_session.connected_account_id, 'acct_newcreator')
    assert.equal((await invoke({ action: 'session', binding_id: 'wrong_creator' })).status, 403)
    assert.equal(
      (
        await invoke({
          action: 'session',
          binding_id: 'local_test',
          country: 'US',
          affiliate_id: 'unrelated',
        })
      ).status,
      400,
    )
    assert.equal((await invoke({ action: 'onboard', binding_id: 'local_test' })).status, 400)
    const resumed = await (await invoke({ action: 'session', binding_id: 'local_test' })).json()
    assert.equal(
      resumed.account_session.connected_account_id,
      session.account_session.connected_account_id,
    )
    assert.equal(
      sql(
        `select count(*) from public.external_creator_accounts where to_jsonb(external_creator_accounts)::text like '%local_session_fixture_secret%';`,
      ).trim(),
      '0',
    )
    assert.equal(sql('select count(*) from public.external_settlement_jobs;').trim(), '0')
    await saveEvidence()
    console.log(
      'PASS: real handler + actual local SQL; host/session/CSRF/scope guards; create/resume; no secrets persisted; no money jobs. Provider transport simulated.',
    )
    await shutdown()
  } else {
    console.log(
      resuming
        ? 'Stripe TEST provider ready. Resuming the verified existing creator; account creation and transfers are blocked.'
        : 'Stripe TEST provider ready. Browser setup creates one test connected account when you select a country and click Set up payouts. Transfers are blocked.',
    )
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, () => {
        void shutdown().then(() => process.exit(0))
      })
    bridge.once('exit', () => {
      if (!ending) {
        console.error('Creator bridge stopped; closing local acceptance.')
        void shutdown().then(() => process.exit(1))
      }
    })
  }
} catch {
  console.error(
    `Local creator acceptance could not start or failed its checks. Safe evidence directory: ${directory}`,
  )
  await shutdown()
  process.exitCode = 1
}
