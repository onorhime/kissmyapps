/** Isolated, local-only browser acceptance harness. No hosted keys or services.
 * Usage: node scripts/funnel-metrics-local.mjs /tmp/kma-external-commerce-db.ID
 * A successful kma-all-sql-db.ID cluster may also be reused after seeding the
 * two local browser fixtures. Both remain disposable, socket-only databases.
 * Uses real report/editor components, gateway and PostgreSQL RPCs with seeded
 * identities. It is intentionally NOT a production authentication service. */
import { createServer } from 'node:http'
import { execFile as execCallback, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url)),
  socket = process.argv[2]
if (
  !/^\/(?:private\/)?tmp\/kma-(?:external-commerce|all-sql)-db\.[A-Za-z0-9]+$/.test(socket || '') ||
  !/^\/(?:private\/)?tmp\/kma-(?:external-commerce|all-sql)-db\.[A-Za-z0-9]+$/.test(
    realpathSync(socket),
  )
)
  throw Error('Choose only a disposable KMA native PostgreSQL fixture.')
const proof = JSON.parse(readFileSync(path.join(socket, 'result.json'), 'utf8'))
if (
  proof.passed !== true &&
  !(proof.failed === 0 && Number.isInteger(proof.passed) && proof.passed > 0)
)
  throw Error('The selected local database has not passed its native checks.')
if (readFileSync(path.join(socket, 'data/PG_VERSION'), 'utf8').trim() !== '17')
  throw Error('Expected PostgreSQL 17 fixture.')
const execFile = promisify(execCallback),
  origin = 'http://127.0.0.1:5189'
const roles = {
  admin: 'ac570000-0000-4000-8000-000000000011',
  creator: 'ac570000-0000-4000-8000-000000000012',
  other: 'ac570000-0000-4000-8000-000000000013',
}
const rpcNames = new Set([
  'get_admin_funnel_metrics_config',
  'save_admin_funnel_metrics_draft',
  'publish_admin_funnel_metrics',
  'validate_admin_funnel_metric_event',
  'preview_admin_funnel_metrics',
  'get_admin_funnel_metrics_report',
  'get_partner_funnel_metrics_report',
  'get_admin_funnel_journey_configuration',
  'configure_admin_funnel_journey',
  'get_admin_funnel_journey_definition',
  'save_admin_funnel_journey_definition',
  'publish_admin_funnel_journey_definition',
  'get_admin_external_settlement_workspace',
  'get_partner_external_settlement_workspace',
  'configure_admin_external_commission_terms',
  'perform_admin_external_settlement_action',
])
const literal = (value) =>
  `'${String(typeof value === 'object' ? JSON.stringify(value) : value).replaceAll("'", "''")}'`
const server = createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': origin,
      vary: 'Origin',
    })
    res.end(JSON.stringify(body))
  }
  if (req.headers.host !== '127.0.0.1:3204' || req.headers.origin !== origin)
    return send(403, { error: { message: 'Local browser origin required.' }, data: null })
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type,x-fixture-identity',
    })
    return res.end()
  }
  const name = req.url?.slice('/rpc/'.length),
    actor = roles[req.headers['x-fixture-identity']]
  if (
    req.method !== 'POST' ||
    !req.url?.startsWith('/rpc/') ||
    !rpcNames.has(name) ||
    !actor ||
    !req.headers['content-type']?.startsWith('application/json')
  )
    return send(400, { data: null, error: { message: 'Unsupported fixture request.' } })
  try {
    let body = ''
    for await (const part of req) {
      body += part
      if (body.length > 150_000) throw Error('Fixture payload too large.')
    }
    const input = JSON.parse(body),
      args = [
        'get_admin_funnel_metrics_config',
        'get_admin_funnel_journey_configuration',
        'get_admin_funnel_journey_definition',
      ].includes(name)
        ? [['p_funnel_id', 'uuid']]
        : name === 'publish_admin_funnel_metrics'
          ? [
              ['p_funnel_id', 'uuid'],
              ['p_expected_revision', 'integer'],
            ]
          : [['p_input', 'jsonb']]
    if (Object.keys(input).some((k) => !args.some(([key]) => k === key)))
      throw Error('Unsupported RPC arguments.')
    const statement = `begin;set local role authenticated;set local request.jwt.claims=${literal({ sub: actor, role: 'authenticated', amr: [{ method: 'password' }] })};select public.${name}(${args.map(([key, type]) => `${literal(input[key])}::${type}`).join(',')});commit;`
    const result = await execFile(
      '/opt/homebrew/opt/postgresql@17/bin/psql',
      [
        '-h',
        socket,
        '-U',
        userInfo().username,
        '-d',
        'postgres',
        '-XAtq',
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        'VERBOSITY=verbose',
        '-c',
        statement,
      ],
      { env: { PATH: '/usr/bin:/bin' }, maxBuffer: 2 * 1024 * 1024 },
    )
    send(200, { data: JSON.parse(result.stdout.trim() || 'null'), error: null })
  } catch (error) {
    const code = String(error.stderr || '').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1] || 'fixture_error'
    send(200, {
      data: null,
      error: {
        code,
        message:
          code === 'fixture_error' ? error.message : 'Database rejected this fixture operation.',
      },
    })
  }
})
const env = { ...process.env }
for (const file of ['.env', '.env.local', '.env.development', '.env.development.local'])
  if (existsSync(path.join(root, file)))
    for (const line of readFileSync(path.join(root, file), 'utf8').split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=/)
      if (match) env[match[1]] = ''
    }
for (const key of Object.keys(env))
  if (key.startsWith('VITE_') || /SUPABASE|STRIPE|KMA|RESEND|OPENAI/.test(key)) env[key] = ''
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(3204, '127.0.0.1', resolve)
})
const vite = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '5189',
    '--strictPort',
  ],
  { cwd: root, env, stdio: 'inherit' },
)
console.log(
  `Isolated metrics editor and creator reports: ${origin}/funnel-metrics-local.html\nFixture PostgreSQL: ${socket}. No hosted data, no real sign-in or delivery.`,
)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    vite.kill(signal)
    server.close()
  })
vite.on('exit', (code) => {
  server.close()
  process.exitCode = code ?? 0
})
