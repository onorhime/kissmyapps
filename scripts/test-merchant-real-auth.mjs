/** Real local Auth email OTP acceptance. Native PostgreSQL, pinned official Auth,
 * repository Go templates and an in-memory loopback SMTP sink. No .env files,
 * hosted APIs, external SMTP, Stripe, deployment or payment/payout activation.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as httpServer } from 'node:http'
import { createServer as netServer } from 'node:net'
import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const root = resolve(import.meta.dirname, '..')
const pg = '/opt/homebrew/opt/postgresql@17/bin'
const version = 'v2.197.0'
const deps = `/tmp/kma-gotrue-${version}`
const archive = join(deps, 'auth.tar.gz')
const checksum = '3fb7998e7061e2c14f3f9555b1d94d447358c965395728e0d81eac82e0e5868b'
assert.ok(
  existsSync(archive),
  'First cache the pinned Auth release with test-creator-real-auth.mjs.',
)
assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), checksum)
const directory = mkdtempSync('/tmp/kma-merchant-auth.')
// Run the bytes from the verified official archive, not an unchecked cached executable.
execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', directory], { stdio: 'ignore' })
const binary = join(directory, 'auth')
chmodSync(binary, 0o700)
const env = { PATH: process.env.PATH, USER: userInfo().username, LC_ALL: 'C', LANG: 'C' }
const secret = randomBytes(48).toString('hex')
const secretPayload = Buffer.from(
  JSON.stringify({
    role: 'anon',
    iss: 'local-auth-fixture',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
).toString('base64url')
const signingInput = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${secretPayload}`
const anon = `${signingInput}.${createHmac('sha256', secret).update(signingInput).digest('base64url')}`
const run = (name, args, input) =>
  execFileSync(join(pg, name), args, {
    cwd: directory,
    env,
    input,
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
const sql = (input) =>
  run('psql', ['-h', directory, '-d', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1'], input)
const listen = (server) =>
  new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => done(server.address().port))
  })
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const messages = [],
  templateRequests = [],
  clients = [],
  checks = []
let auth,
  started = false,
  smtp,
  web,
  authUrl
const sockets = new Set()
function decodedMessage(raw) {
  return raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}
function latest(email) {
  const item = messages.findLast((message) => message.recipient === email)
  assert.ok(item, 'Expected email in local SMTP sink.')
  return decodedMessage(item.raw)
}
function code(email) {
  const match = latest(email).match(/letter-spacing:6px[^>]*>([0-9]{8})</)
  assert.ok(match, 'Repository template must render the complete eight-digit OTP.')
  return match[1]
}
try {
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
  smtp = netServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')
    socket.write('220 localhost local-test-only\r\n')
    let buffer = '',
      body = null,
      recipient = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'),
          line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (body !== null) {
          if (line === '.') {
            messages.push({ recipient, raw: body.join('\r\n') })
            body = null
            socket.write('250 captured locally\r\n')
          } else body.push(line.replace(/^\.\./, '.'))
        } else if (/^(EHLO|HELO) /i.test(line)) socket.write('250 localhost\r\n')
        else if (/^MAIL FROM:/i.test(line)) socket.write('250 OK\r\n')
        else if (/^RCPT TO:/i.test(line)) {
          recipient = line.match(/<([^>]+)>/)?.[1] ?? ''
          if (!recipient.endsWith('@merchant-auth.example.invalid')) {
            socket.write('550 synthetic local recipients only\r\n')
            socket.end()
          } else socket.write('250 OK\r\n')
        } else if (line === 'DATA') {
          body = []
          socket.write('354 send data\r\n')
        } else if (line === 'QUIT') {
          socket.end('221 bye\r\n')
        } else if (line === 'RSET') {
          body = null
          recipient = ''
          socket.write('250 OK\r\n')
        } else socket.write('250 OK\r\n')
      }
    })
  })
  const smtpPort = await listen(smtp)
  web = httpServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname
      if (path === '/templates/confirmation' || path === '/templates/magic-link') {
        const name = path.endsWith('confirmation') ? 'confirmation.html' : 'magic_link.html'
        templateRequests.push(name)
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(readFileSync(join(root, 'supabase/templates', name)))
        return
      }
      if (!path.startsWith('/auth/v1/')) {
        response.writeHead(404)
        response.end()
        return
      }
      const chunks = []
      for await (const part of request) chunks.push(part)
      const upstream = await fetch(`${authUrl}${request.url.slice('/auth/v1'.length)}`, {
        method: request.method,
        headers: { ...request.headers, host: new URL(authUrl).host },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        redirect: 'manual',
      })
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
      response.end(Buffer.from(await upstream.arrayBuffer()))
    } catch {
      response.writeHead(500)
      response.end('Local test bridge failed')
    }
  })
  const webPort = await listen(web),
    origin = `http://127.0.0.1:${webPort}`
  const reservation = netServer(),
    authPort = await listen(reservation)
  await new Promise((done) => reservation.close(done))
  authUrl = `http://127.0.0.1:${authPort}`
  const config = readFileSync(join(root, 'supabase/config.toml'), 'utf8')
  const emailConfig = config.split('[auth.email]')[1].split('\n[')[0]
  assert.match(
    emailConfig,
    /^otp_length = 8$/m,
    'Local email Auth must preserve hosted eight-digit policy.',
  )
  auth = spawn(binary, [], {
    cwd: deps,
    env: {
      ...env,
      GOTRUE_DB_DRIVER: 'postgres',
      DATABASE_URL: `postgres://${env.USER}@/postgres?host=${encodeURIComponent(directory)}&search_path=auth`,
      DB_NAMESPACE: 'auth',
      GOTRUE_API_HOST: '127.0.0.1',
      PORT: String(authPort),
      API_EXTERNAL_URL: `${origin}/auth/v1`,
      GOTRUE_SITE_URL: origin,
      GOTRUE_URI_ALLOW_LIST: `${origin}/merchant/connect,${origin}/`,
      GOTRUE_JWT_SECRET: secret,
      GOTRUE_JWT_EXP: '3600',
      GOTRUE_JWT_AUD: 'authenticated',
      GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
      GOTRUE_JWT_ADMIN_ROLES: 'service_role',
      GOTRUE_DB_MAX_POOL_SIZE: '3',
      GOTRUE_LOG_LEVEL: 'error',
      LOG_LEVEL: 'error',
      GOTRUE_MAILER_URLPATHS_RECOVERY: '/auth/v1/verify',
      GOTRUE_MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify',
      GOTRUE_MAILER_URLPATHS_MAGIC_LINK: '/auth/v1/verify',
      GOTRUE_MAILER_AUTOCONFIRM: 'false',
      GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
      GOTRUE_EXTERNAL_PHONE_ENABLED: 'false',
      GOTRUE_MAILER_OTP_LENGTH: '8',
      GOTRUE_MAILER_OTP_EXP: '3600',
      GOTRUE_SMTP_MAX_FREQUENCY: '1ms',
      GOTRUE_RATE_LIMIT_EMAIL_SENT: '100',
      GOTRUE_RATE_LIMIT_VERIFY: '100',
      GOTRUE_SMTP_HOST: '127.0.0.1',
      GOTRUE_SMTP_PORT: String(smtpPort),
      GOTRUE_SMTP_ADMIN_EMAIL: 'no-reply@merchant-auth.example.invalid',
      GOTRUE_SMTP_SENDER_NAME: 'KMA LOCAL TEST',
      GOTRUE_MAILER_TEMPLATES_CONFIRMATION: `${origin}/templates/confirmation`,
      GOTRUE_MAILER_TEMPLATES_MAGIC_LINK: `${origin}/templates/magic-link`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  auth.stderr.on('data', (part) => {
    stderr = (stderr + part.toString()).slice(-5000)
  })
  let healthy = false
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${authUrl}/health`)).ok) {
        healthy = true
        break
      }
    } catch {}
    if (auth.exitCode !== null) break
    await delay(100)
  }
  if (!healthy) {
    writeFileSync(join(directory, 'startup.log'), stderr.replaceAll(secret, '[secret]'), {
      mode: 0o600,
    })
    throw Error('Native Auth startup failed; inspect private local startup log.')
  }
  const client = createClient(origin, anon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        assert.equal(
          new URL(typeof input === 'string' ? input : input.url).origin,
          origin,
          'External network is forbidden in this test.',
        )
        return fetch(input, init)
      },
    },
  })
  clients.push(client)
  const send = async (email) => {
    const before = messages.length
    const result = await new Promise((resolve, reject) => {
      const child = spawn('/opt/homebrew/bin/deno', [
        'run', '--cached-only',
        '--allow-env=MERCHANT_OTP_AUTH_URL,MERCHANT_OTP_AUTH_EMAIL,MERCHANT_OTP_AUTH_KEY',
        '--allow-net=127.0.0.1', '--config', 'supabase/functions/deno.json',
        'scripts/merchant-invitation-otp-auth-acceptance.ts',
      ], {
        cwd: root,
        env: { ...env, MERCHANT_OTP_AUTH_URL: origin, MERCHANT_OTP_AUTH_EMAIL: email, MERCHANT_OTP_AUTH_KEY: anon },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = '', errors = ''
      const timeout = setTimeout(() => child.kill('SIGTERM'), 15000)
      child.stdout.on('data', (chunk) => { output += chunk })
      child.stderr.on('data', (chunk) => { errors += chunk })
      child.on('error', reject)
      child.on('close', (exitCode) => {
        clearTimeout(timeout)
        if (exitCode !== 0) return reject(Error(`Production OTP transport failed locally: ${errors.slice(-1500)}`))
        try { resolve(JSON.parse(output.trim())) } catch (error) { reject(error) }
      })
    })
    assert.equal(result.status, 'sent', 'Production transport should send via real local Auth.')
    assert.equal(messages.length, before + 1, 'Exactly one message must reach only local SMTP.')
    return code(email)
  }
  const merchant = 'new@merchant-auth.example.invalid'
  let otp = await send(merchant)
  assert.match(latest(merchant), /Verify your email for KissMyApps/)
  assert.doesNotMatch(latest(merchant), /auth_action=signup/)
  const truncated = await client.auth.verifyOtp({
    email: merchant,
    token: otp.slice(0, 6),
    type: 'email',
  })
  assert.ok(truncated.error, 'Hosted eight-digit policy must reject a six-digit prefix.')
  const wrong = otp === '99999999' ? '88888888' : '99999999'
  assert.ok((await client.auth.verifyOtp({ email: merchant, token: wrong, type: 'email' })).error)
  const verified = await client.auth.verifyOtp({ email: merchant, token: otp, type: 'email' })
  assert.equal(verified.error, null)
  assert.ok(verified.data.session)
  assert.ok(verified.data.user.email_confirmed_at)
  assert.equal(verified.data.user.user_metadata.registration_flow, 'merchant_v1')
  checks.push(
    'Fresh merchant: real confirmation template renders eight-digit code; wrong/truncated codes rejected; full code creates confirmed Auth session.',
  )
  assert.ok(
    (await client.auth.verifyOtp({ email: merchant, token: otp, type: 'email' })).error,
    'Consumed code cannot be reused.',
  )
  await client.auth.signOut({ scope: 'local' })
  otp = await send(merchant)
  assert.match(latest(merchant), /Your KissMyApps sign-in code/)
  assert.doesNotMatch(latest(merchant), /sign-in link instead/)
  assert.equal(
    (await client.auth.verifyOtp({ email: merchant, token: otp, type: 'email' })).error,
    null,
  )
  await client.auth.signOut({ scope: 'local' })
  checks.push(
    'Returning merchant: real magic-link dispatch renders code-only template; eight-digit code verifies and consumed tokens fail.',
  )
  const expired = 'expired@merchant-auth.example.invalid'
  otp = await send(expired)
  sql(
    `update auth.users set confirmation_sent_at = now() - interval '2 hours' where email = '${expired}';`,
  )
  assert.ok(
    (await client.auth.verifyOtp({ email: expired, token: otp, type: 'email' })).error,
    'Expired code must fail real Auth.',
  )
  const replacement = await send(expired)
  assert.equal(
    (await client.auth.verifyOtp({ email: expired, token: replacement, type: 'email' })).error,
    null,
  )
  await client.auth.signOut({ scope: 'local' })
  checks.push('Real expiration rejection and resend recovery with the latest code.')
  const partner = 'partner@merchant-auth.example.invalid'
  const signup = await client.auth.signUp({
    email: partner,
    password: randomBytes(24).toString('base64url'),
    options: {
      data: { registration_flow: 'public_partner_v1', full_name: 'Synthetic Partner' },
      emailRedirectTo: `${origin}/`,
    },
  })
  assert.equal(signup.error, null)
  const partnerEmail = latest(partner)
  assert.match(partnerEmail, /Confirm email and open dashboard/)
  const tokenHash = partnerEmail.match(
    /auth_action=signup&amp;token_hash=([^&]+)&amp;type=email/,
  )?.[1]
  assert.ok(tokenHash, 'Partner confirmation URL must retain token-hash verification route.')
  assert.equal((await client.auth.verifyOtp({ token_hash: tokenHash, type: 'email' })).error, null)
  await client.auth.signOut({ scope: 'local' })
  otp = await send(partner)
  assert.match(latest(partner), /Your KissMyApps sign-in code/)
  assert.match(latest(partner), /sign-in link instead/)
  const links = [...latest(partner).matchAll(/href="([^"]+)"/g)].map(
    (match) => new URL(match[1].replaceAll('&amp;', '&')),
  )
  assert.equal(links.length, 1, 'Existing partner magic email retains one sign-in link.')
  assert.equal(
    links[0].origin,
    origin,
    `Expected loopback auth link origin, got ${links[0].origin}`,
  )
  assert.equal(
    links[0].pathname,
    '/auth/v1/verify',
    `Expected auth verification route, got ${links[0].pathname}`,
  )
  assert.ok(
    links[0].searchParams.has('token'),
    'Rendered magic link is missing token query parameter.',
  )
  const partnerSignin = await client.auth.verifyOtp({ email: partner, token: otp, type: 'email' })
  assert.equal(partnerSignin.error, null)
  assert.equal(
    partnerSignin.data.user.user_metadata.registration_flow,
    'public_partner_v1',
    'Merchant sign-in must not overwrite existing partner metadata.',
  )
  checks.push(
    'Existing partner retains signup confirmation link and metadata; merchant sign-in request still receives an eight-digit code plus legacy link fallback.',
  )
  assert.ok(templateRequests.includes('confirmation.html'))
  assert.ok(templateRequests.includes('magic_link.html'))
  const hashes = Object.fromEntries(
    ['confirmation.html', 'magic_link.html'].map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(join(root, 'supabase/templates', name)))
        .digest('hex'),
    ]),
  )
  const result = {
    status: 'passed',
    authVersion: version,
    realAuth: true,
    productionOtpTransport: true,
    realGoTemplates: true,
    emailOtpLength: 8,
    smtp: 'in-memory sink bound to 127.0.0.1; synthetic .invalid recipients only',
    templates: hashes,
    messagesCaptured: messages.length,
    checks,
    confirmationRequiredInDisposableFixture: true,
    noHostedMutation: true,
    noExternalEmail: true,
    noDeployment: true,
    noStripeOrMoneyMovement: true,
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
  console.error(
    JSON.stringify({
      status: 'failed',
      checks: checks.length,
      message: error.message.split('\n')[0].slice(0, 250),
      evidenceDirectory: directory,
    }),
  )
  process.exitCode = 1
} finally {
  for (const client of clients) client.auth.stopAutoRefresh()
  auth?.kill('SIGTERM')
  for (const socket of sockets) socket.destroy()
  await new Promise((done) => (smtp ? smtp.close(done) : done()))
  await new Promise((done) => (web ? web.close(done) : done()))
  if (started) run('pg_ctl', ['-D', join(directory, 'data'), 'stop', '-m', 'fast'])
}
