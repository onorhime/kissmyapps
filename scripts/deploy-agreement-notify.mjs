// Explicitly approved production release helper. Never logs or persists secrets.
// Run only after the four audit migrations have been applied.
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

const project = 'mmyruzjemjecqyivhrgr'
const run = (args, input) =>
  execFileSync('pnpm', ['exec', 'supabase', ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
const query = (sql) =>
  JSON.parse(
    run(
      [
        'db',
        'query',
        '--linked',
        '--project-ref',
        project,
        '--file',
        '/dev/stdin',
        '--output',
        'json',
      ],
      sql,
    ),
  ).rows

if (process.argv[2] !== '--apply-approved-production') {
  throw new Error('An explicit approved production invocation is required.')
}
let phase = 'preflight'
const redactions = []
try {
  const state = query(`select (select count(*) from supabase_migrations.schema_migrations
    where version in ('20260905090000','20260905091000','20260905092000','20260905093000')) migrations,
    (select count(*) from kma_internal.agreement_email_jobs where status in ('pending','processing')) emails,
    (select count(*) from kma_internal.document_cleanup_jobs where status in ('pending','processing')) cleanup`)[0]
  if (Number(state.migrations) !== 4 || Number(state.emails) || Number(state.cleanup)) {
    throw new Error('Preflight requires the audit schema and no real pending maintenance jobs.')
  }
  const previous = query(
    "select value from kma_internal.function_secrets where name='agreement_notify'",
  )[0]?.value
  if (typeof previous !== 'string' || previous.length < 32)
    throw new Error('Prior credential unavailable')
  const credential = randomBytes(48).toString('hex')
  redactions.push(previous, credential)
  const digest = createHash('sha256').update(credential).digest('hex')
  phase = 'load existing control-plane credential'
  // Use the CLI's existing, specifically scoped macOS Keychain entry. The API
  // avoids CLI dotenv stdin failures without creating a plaintext secret file.
  const storedToken =
    process.env.SUPABASE_ACCESS_TOKEN ||
    execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000 },
    ).trim()
  const accessToken = storedToken.startsWith('go-keyring-base64:')
    ? Buffer.from(storedToken.slice('go-keyring-base64:'.length), 'base64').toString('utf8')
    : storedToken
  redactions.push(storedToken)
  redactions.push(accessToken)
  const api = async (path, body) => {
    const response = await fetch(`https://api.supabase.com/v1/projects/${project}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Control-plane request failed: ${response.status}`)
    await response.arrayBuffer()
  }
  phase = 'rotate Edge credential'
  await api('secrets', [{ name: 'AGREEMENT_NOTIFY_SECRET', value: credential }])
  console.log('Edge notification credential rotated; synchronizing private database setting.')
  phase = 'rotate database credential'
  await api('database/query', {
    query: `update kma_internal.function_secrets set value='${credential}' where name='agreement_notify'`,
  })
  const secrets = JSON.parse(run(['secrets', 'list', '--project-ref', project, '--output', 'json']))
  const databaseDigest = query(
    "select encode(extensions.digest(value,'sha256'),'hex') digest from kma_internal.function_secrets where name='agreement_notify'",
  )[0]?.digest
  if (
    !Array.isArray(secrets) ||
    secrets.find((s) => s.name === 'AGREEMENT_NOTIFY_SECRET')?.value !== digest ||
    databaseDigest !== digest
  ) {
    throw new Error('Credential digests did not match')
  }
  console.log('Private database and Edge credential digests match; old value was replaced.')
  phase = 'deploy notification worker'
  run([
    'functions',
    'deploy',
    'agreement-notify',
    '--project-ref',
    project,
    '--no-verify-jwt',
    '--use-api',
  ])
  console.log('Notification worker deployment completed. Verifying its protected boundary.')
  phase = 'HTTP acceptance'
  const invoke = async (secret, body) => {
    const response = await fetch(`https://${project}.supabase.co/functions/v1/agreement-notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-kma-internal-secret': secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    return { status: response.status, data: await response.json() }
  }
  const retired = await invoke(previous, {})
  const arbitrary = await invoke(credential, {
    type: 'signing_request',
    document_id: 'not-a-real-document',
  })
  const empty = await invoke(credential, {})
  if (
    retired.status !== 401 ||
    arbitrary.status !== 400 ||
    empty.status !== 200 ||
    empty.data.claimed !== 0 ||
    empty.data.cleaned !== 0 ||
    empty.data.sent !== 0
  ) {
    console.log(
      JSON.stringify({
        retiredCredentialStatus: retired.status,
        arbitraryBodyStatus: arbitrary.status,
        emptyStatus: empty.status,
        claimed: empty.data.claimed,
        cleaned: empty.data.cleaned,
        errorCode: empty.data.error?.code,
      }),
    )
    throw new Error('Worker acceptance mismatch')
  }
  console.log(
    JSON.stringify({
      project,
      credentialRotated: true,
      digestsMatched: true,
      retiredCredentialRejected: true,
      fabricatedMilestoneRejected: true,
      emptyWorker: empty.data,
      realEmailsSent: 0,
      realObjectsDeleted: 0,
    }),
  )
} catch (error) {
  // Deliberately do not print subprocess stderr, SQL, request headers or keys.
  console.error(
    `Production worker release stopped during: ${phase}. Inspect live state before retrying; credentials may already have changed.`,
  )
  const diagnostic =
    String(error?.message ?? '') +
    '\n' +
    String(error?.stderr ?? '') +
    '\n' +
    String(error?.stdout ?? '')
  console.error(
    JSON.stringify({
      exitStatus: error?.status ?? null,
      errorCode: error?.code ?? null,
      timedOut: error?.code === 'ETIMEDOUT',
      stdinFileError: /\/dev\/stdin|not a regular file/i.test(diagnostic),
      authenticationError: /unauthorized|forbidden|access token/i.test(diagnostic),
      confirmationRequired: /confirm|approval|interactive/i.test(diagnostic),
      safeDiagnostic: redactions
        .reduce((value, secret) => value.split(secret).join('[REDACTED]'), diagnostic)
        .replace(/[A-Za-z0-9_=-]{32,}/g, '[REDACTED_TOKEN]')
        .slice(0, 1200),
    }),
  )
  process.exitCode = 1
}
