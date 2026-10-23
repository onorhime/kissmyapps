/** Real local Supabase Auth + native PostgreSQL + production client/handler.
 * No .env files, hosted Supabase, real Stripe, email, deployment or money movement.
 * Pinned official macOS Auth release; signing keys and plaintext passwords stay
 * in memory. Only the disposable Auth database retains synthetic auth records.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { userInfo } from 'node:os'
import { createServer as netServer } from 'node:net'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { createServer as viteServer } from 'vite'

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw Error('This runner requires macOS arm64 and native PostgreSQL17.')
const root = resolve(import.meta.dirname, '..'),
  pg = '/opt/homebrew/opt/postgresql@17/bin'
const release = 'v2.197.0',
  deps = `/tmp/kma-gotrue-${release}`,
  archive = join(deps, 'auth.tar.gz')
const digest = '3fb7998e7061e2c14f3f9555b1d94d447358c965395728e0d81eac82e0e5868b'
const directory = mkdtempSync('/tmp/kma-real-auth.'),
  checks = []
const env = { PATH: process.env.PATH, USER: userInfo().username, LC_ALL: 'C', LANG: 'C' }
const secret = randomBytes(48).toString('hex'),
  control = randomBytes(24).toString('hex')
const password = randomBytes(24).toString('base64url')
const sign = (role) => {
  const now = Math.floor(Date.now() / 1000)
  const base = [
    { alg: 'HS256', typ: 'JWT' },
    { role, iss: 'local-auth-fixture', iat: now, exp: now + 7200 },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.')
  return `${base}.${createHmac('sha256', secret).update(base).digest('base64url')}`
}
const anon = sign('anon'),
  service = sign('service_role')
const run = (name, args, input) =>
  execFileSync(join(pg, name), args, {
    cwd: directory,
    env,
    input,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
const sql = (statement) =>
  run('psql', ['-h', directory, '-d', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1'], statement)
const port = () =>
  new Promise((resolve, reject) => {
    const server = netServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port
      server.close(() => resolve(p))
    })
  })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function healthy(url, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('Local auth process exited during startup.')
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return
    } catch {}
    await wait(100)
  }
  throw Error('Local auth service did not become healthy.')
}
function totp(base32) {
  let bits = ''
  for (const letter of base32.replaceAll('=', ''))
    bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(letter).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)))
  const hash = createHmac('sha1', key).update(counter).digest(),
    offset = hash.at(-1) & 15
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0')
}
let started = false,
  auth,
  bridge,
  vite
const clients = []
try {
  mkdirSync(deps, { recursive: true })
  if (!existsSync(archive)) {
    const response = await fetch(
      `https://github.com/supabase/auth/releases/download/${release}/auth-${release}-darwin-arm64.tar.gz`,
    )
    if (!response.ok) throw Error('Official pinned Auth binary download failed.')
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()), { mode: 0o600 })
  }
  assert.equal(
    createHash('sha256').update(readFileSync(archive)).digest('hex'),
    digest,
    'Official Auth release checksum mismatch.',
  )
  execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', deps], { stdio: 'ignore' })
  const binary = [join(deps, 'auth'), join(deps, 'gotrue')].find(existsSync)
  if (!binary) throw Error('Official Auth archive has no expected executable.')
  chmodSync(binary, 0o700)
  run('initdb', ['-D', join(directory, 'data'), '-A', 'trust', '--locale=C'])
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
  sql('create schema auth;create role postgres;')
  const authPort = await port(),
    bridgePort = await port(),
    authUrl = `http://127.0.0.1:${authPort}`,
    origin = `http://127.0.0.1:${bridgePort}`
  const authEnv = {
    ...env,
    GOTRUE_DB_DRIVER: 'postgres',
    DATABASE_URL: `postgres://${env.USER}@/postgres?host=${encodeURIComponent(directory)}&search_path=auth`,
    DB_NAMESPACE: 'auth',
    GOTRUE_API_HOST: '127.0.0.1',
    PORT: String(authPort),
    API_EXTERNAL_URL: `${origin}/auth/v1`,
    GOTRUE_SITE_URL: origin,
    GOTRUE_JWT_SECRET: secret,
    GOTRUE_JWT_EXP: '3600',
    GOTRUE_JWT_AUD: 'authenticated',
    GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
    GOTRUE_JWT_ADMIN_ROLES: 'service_role',
    GOTRUE_MAILER_AUTOCONFIRM: 'true',
    GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
    GOTRUE_EXTERNAL_PHONE_ENABLED: 'false',
    GOTRUE_MFA_TOTP_ENROLL_ENABLED: 'true',
    GOTRUE_MFA_TOTP_VERIFY_ENABLED: 'true',
    GOTRUE_RATE_LIMIT_TOKEN_REFRESH: '1000',
    GOTRUE_DB_MAX_POOL_SIZE: '5',
    GOTRUE_LOG_LEVEL: 'error',
    LOG_LEVEL: 'error',
  }
  auth = spawn(binary, [], { cwd: deps, env: authEnv, stdio: ['ignore', 'ignore', 'pipe'] })
  let authError = ''
  auth.stderr.on('data', (chunk) => {
    authError = (authError + chunk.toString()).slice(-4000)
  })
  try {
    await healthy(`${authUrl}/health`, auth)
  } catch {
    // Diagnostics exclude credentials/token/request bodies; report only stable code.
    const known = [
      'connection refused',
      'permission denied',
      'migrations',
      'DATABASE_URL',
      'No such file',
    ].find((term) => authError.includes(term))
    const safeStartup = [secret, anon, service, password, control]
      .reduce((text, value) => text.replaceAll(value, '[redacted]'), authError)
      .replace(/postgres:\/\/[^\s"']+/g, '[local-database]')
    writeFileSync(join(directory, 'auth-startup-error.log'), safeStartup, { mode: 0o600 })
    throw Error(`Native Auth startup failed (${known ?? 'configuration'}).`)
  }
  let bootstrap = readFileSync(
    join(root, 'supabase/tests/bootstrap/external-commerce-native.sql'),
    'utf8',
  )
    .replace('create schema auth;', '')
    .replace(/create table auth\.users\([^;]+;/, '')
    .replaceAll('create function auth.', 'create or replace function auth.')
  sql(
    bootstrap +
      '\ngrant usage on schema storage,extensions to anon,authenticated,service_role;grant all on storage.objects to authenticated,service_role;alter table storage.objects enable row level security;',
  )
  const migrations = readdirSync(join(root, 'supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
  for (const name of migrations)
    sql(
      readFileSync(join(root, 'supabase/migrations', name), 'utf8').replace(
        /^create extension if not exists pg_net with schema extensions;\s*$/m,
        '',
      ),
    )
  const ids = []
  for (const name of ['owner', 'creator', 'other']) {
    const response = await fetch(`${authUrl}/admin/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `${name}@local-auth.example.test`,
        password,
        email_confirm: true,
      }),
    })
    assert.equal(response.status, 200, 'Real local Auth synthetic user creation failed.')
    const user = await response.json()
    ids.push(user.id)
  }
  let fixture = readFileSync(
    join(root, 'supabase/tests/fixtures/external-canonical.sql'),
    'utf8',
  ).replace(/^insert into auth\.users[^\n]+\n/m, '')
  for (let i = 0; i < ids.length; i++)
    fixture = fixture.replaceAll(`ac570000-0000-4000-8000-00000000001${i + 1}`, ids[i])
  sql(
    `begin;${fixture}\nupdate public.external_settlement_platforms set enabled=true where platform_account_id='acct_fixture' and not livemode;commit;`,
  )
  bridge = spawn(
    'deno',
    [
      'run',
      '--config',
      'supabase/functions/deno.json',
      '--allow-env=USER,SUPABASE_URL,SUPABASE_ANON_KEY',
      `--allow-net=127.0.0.1:${authPort},127.0.0.1:${bridgePort}`,
      `--allow-run=${pg}/psql`,
      'scripts/creator-connect-real-auth-bridge.ts',
    ],
    { cwd: root, env, stdio: ['pipe', 'ignore', 'ignore'] },
  )
  bridge.stdin.end(
    JSON.stringify({ socket: directory, port: bridgePort, authPort, control, anonKey: anon }),
  )
  await healthy(`${origin}/auth/v1/health`, bridge)
  const localFetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.origin !== origin) throw Error('External network blocked by real-auth test.')
    return fetch(input, init)
  }
  const client = createClient(origin, anon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: localFetch },
  })
  clients.push(client)
  vite = await viteServer({
    root,
    cacheDir: join(directory, 'vite-cache'),
    configFile: false,
    envDir: false,
    mode: 'test',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': 'undefined',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': 'undefined',
    },
  })
  const { createConnectGateway, ConnectReauthenticationRequired, ConnectMfaRequired } =
    await vite.ssrLoadModule('/src/features/creator-settlements/connect.ts')
  const gateway = createConnectGateway(client)
  const admin = (path, body) =>
    fetch(`${origin}/test/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-local-control': control, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const login = await client.auth.signInWithPassword({
    email: 'creator@local-auth.example.test',
    password,
  })
  assert.equal(login.error, null, 'Real password login failed.')
  const initial = login.data.session.access_token
  const passwordTime = (jwt) =>
    JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).amr.find(
      (entry) => entry.method === 'password',
    ).timestamp
  const initialPasswordAt = passwordTime(initial)
  assert.equal((await gateway.status()).bindings.length, 1)
  const first = await gateway.session('fixture', 'US')
  assert.equal(first.connected_account_id, 'acct_newcreator')
  checks.push('real password JWT opens own embedded session')
  await admin('clock', { offset: 601000 })
  await assert.rejects(gateway.session('fixture'), ConnectReauthenticationRequired)
  assert.equal((await client.auth.refreshSession()).error, null)
  await assert.rejects(gateway.session('fixture'), ConnectReauthenticationRequired)
  checks.push(
    'real token refresh cannot satisfy stale password AMR (handler clock advanced 601 seconds)',
  )
  await assert.rejects(
    gateway.reauthenticate('wrong-local-password'),
    /password could not be verified/,
  )
  while (Math.floor(Date.now() / 1000) <= initialPasswordAt) await wait(50)
  await gateway.reauthenticate(password)
  const reauthenticated = (await client.auth.getSession()).data.session.access_token
  assert.ok(passwordTime(reauthenticated) > initialPasswordAt)
  // One common time makes the original AMR stale and the new password AMR fresh.
  assert.equal((await admin('clock', { now: (initialPasswordAt + 601) * 1000 })).status, 200)
  const oldDenied = await fetch(`${origin}/functions/v1/creator-connect`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${initial}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'session', binding_id: 'fixture' }),
  })
  assert.equal(oldDenied.status, 403)
  assert.equal((await oldDenied.json()).error, 'reauthentication_required')
  assert.equal((await gateway.session('fixture')).connected_account_id, first.connected_account_id)
  checks.push(
    'actual gateway rejects wrong password; fresh password reauthentication passes while original JWT remains stale at the same handler time',
  )
  await admin('clock', { offset: 0 })
  const enrollment = await client.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Disposable acceptance authenticator',
  })
  assert.equal(enrollment.error, null, 'Real TOTP enrollment failed.')
  const totpSecret = enrollment.data.totp.secret
  const enrollmentStep = Math.floor(Date.now() / 30000)
  const verified = await client.auth.mfa.challengeAndVerify({
    factorId: enrollment.data.id,
    code: totp(totpSecret),
  })
  assert.equal(verified.error, null, 'Real TOTP verification failed.')
  await assert.rejects(gateway.reauthenticate(password), ConnectMfaRequired)
  await assert.rejects(gateway.session('fixture'), ConnectMfaRequired)
  const wrongCode = `${(Number(totp(totpSecret)) + 123456) % 1000000}`.padStart(6, '0')
  await assert.rejects(gateway.verifyMfa(wrongCode), /could not be confirmed/)
  await assert.rejects(gateway.session('fixture'), ConnectMfaRequired)
  // The service correctly refuses reusing a previously accepted TOTP step.
  while (Math.floor(Date.now() / 30000) <= enrollmentStep) await wait(250)
  await gateway.verifyMfa(totp(totpSecret))
  assert.equal((await gateway.session('fixture')).connected_account_id, first.connected_account_id)
  const session = (await client.auth.getSession()).data.session
  const claims = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url'))
  assert.equal(claims.aal, 'aal2')
  assert.equal(
    claims.amr.some((entry) => entry.method === 'totp'),
    true,
  )
  checks.push(
    'real enrolled TOTP requires AAL2; wrong code blocked; actual gateway verifies and resumes same account',
  )
  const tampered = initial.split('.')
  const altered = JSON.parse(Buffer.from(tampered[1], 'base64url'))
  altered.sub = ids[2]
  tampered[1] = Buffer.from(JSON.stringify(altered)).toString('base64url')
  const denied = await fetch(`${origin}/functions/v1/creator-connect`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tampered.join('.')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'session', binding_id: 'fixture' }),
  })
  assert.equal(denied.status, 401)
  checks.push('tampered bearer token fails real GoTrue verification before provider access')
  const other = createClient(origin, anon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: localFetch },
  })
  clients.push(other)
  assert.equal(
    (await other.auth.signInWithPassword({ email: 'other@local-auth.example.test', password }))
      .error,
    null,
  )
  assert.equal((await createConnectGateway(other).status()).bindings.length, 0)
  await assert.rejects(createConnectGateway(other).session('fixture', 'US'))
  checks.push('real other-user JWT cannot access the first creator funding scope')
  await client.auth.signOut({ scope: 'local' })
  await assert.rejects(gateway.session('fixture'), /Sign in again/)
  checks.push('real client sign-out blocks new payout sessions')
  const evidence = await (await admin('evidence')).json()
  assert.equal(evidence.accountCreates, 1)
  assert.equal(
    evidence.accountSessions,
    3,
    'Rejected authentication paths must not create provider sessions.',
  )
  const result = {
    status: 'passed',
    authVersion: release,
    realAuth: true,
    realFrontendGateway: true,
    actualHandler: true,
    sqlAdapter: 'native PostgreSQL RPC adapter instead of PostgREST',
    stripeTransport: 'fake; no provider calls',
    clockTest:
      'authentication clock advances at most601 seconds; old and reauthenticated JWTs compared at same cutoff; provider/DB verification uses real wall time',
    migrations: migrations.length,
    checks,
    evidence,
    noHostedMutation: true,
    noDeployment: true,
    noMoneyMovement: true,
  }
  writeFileSync(join(directory, 'acceptance.json'), JSON.stringify(result, null, 2), {
    mode: 0o600,
  })
  console.log(
    JSON.stringify({
      status: 'passed',
      checks: checks.length,
      evidence: join(directory, 'acceptance.json'),
    }),
  )
} catch (error) {
  // Do not print SDK responses, signed JWTs, credentials, SQL data, or process env.
  console.error(
    JSON.stringify({
      status: 'failed',
      stage: checks.length,
      message:
        error instanceof Error
          ? error.message.split('\n')[0].slice(0, 250)
          : 'Local acceptance failed.',
      evidenceDirectory: directory,
    }),
  )
  process.exitCode = 1
} finally {
  for (const client of clients) client.auth.stopAutoRefresh()
  await vite?.close().catch(() => {})
  bridge?.kill('SIGTERM')
  auth?.kill('SIGTERM')
  if (started) run('pg_ctl', ['-D', join(directory, 'data'), 'stop', '-m', 'fast'])
}
