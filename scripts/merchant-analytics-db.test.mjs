/** Merchant analytics SQL suite on a disposable local Postgres cluster.
 * Applies the bootstrap and every migration, then runs each merchant analytics suite in
 * supabase/tests/database, each in its own rolled-back transaction.
 * Skips when no Postgres binaries are installed. PG_BIN picks the binaries; when
 * running as root, PG_RUN_AS names the user that runs the cluster.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function postgresBin() {
  const candidates = [
    process.env.PG_BIN,
    '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/local/opt/postgresql@17/bin',
    ...(existsSync('/usr/lib/postgresql')
      ? readdirSync('/usr/lib/postgresql')
          .sort((a, b) => Number(b) - Number(a))
          .map((version) => `/usr/lib/postgresql/${version}/bin`)
      : []),
  ].filter(Boolean)
  return candidates.find((dir) => existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'psql')))
}

// Each suite runs in its own rolled-back transaction and ends by printing its count.
const suites = [
  ['63_merchant_analytics.sql', /^ok \d+ merchant analytics assertions$/m],
  ['64_merchant_funnels.sql', /^ok \d+ merchant funnel assertions$/m],
  ['65_merchant_retention.sql', /^ok \d+ merchant retention assertions$/m],
  ['66_merchant_places.sql', /^ok \d+ merchant places assertions$/m],
  ['67_merchant_attribution.sql', /^ok \d+ merchant attribution assertions$/m],
  ['68_merchant_attribution_links.sql', /^ok \d+ merchant attribution link assertions$/m],
  ['69_workspace_stripe_connect.sql', /^ok \d+ workspace stripe connect assertions$/m],
  ['70_merchant_payment_events.sql', /^ok \d+ merchant payment event assertions$/m],
  ['71_merchant_event_active_connection.sql', /^ok \d+ merchant event active connection assertions$/m],
  ['72_affiliate_programs.sql', /^ok \d+ affiliate program assertions$/m],
  ['73_program_sales.sql', /^ok \d+ program sales assertions$/m],
  ['74_analytics_creator_click.sql', /^ok \d+ analytics creator click assertions$/m],
  ['75_affiliate_program_end_to_end.sql', /^ok \d+ program end to end assertions$/m],
  ['76_program_join.sql', /^ok \d+ program join assertions$/m],
  ['77_program_link_tracking.sql', /^ok \d+ program link tracking assertions$/m],
  ['78_program_creator_end_to_end.sql', /^ok \d+ program creator end to end assertions$/m],
  ['79_program_commissions.sql', /^ok \d+ program commission assertions$/m],
]

const bin = postgresBin()
const runAs = process.getuid?.() === 0 ? process.env.PG_RUN_AS : undefined
const skip = !bin
  ? 'Postgres binaries not found (set PG_BIN)'
  : process.getuid?.() === 0 && !runAs
    ? 'Postgres will not run as root (set PG_RUN_AS)'
    : false

test('merchant analytics database suite', { skip, timeout: 300_000 }, () => {
  const dir = mkdtempSync('/tmp/kma-analytics-db.')
  chmodSync(dir, 0o777)
  const env = { ...process.env, PGHOST: dir, PGDATABASE: 'postgres' }
  for (const key of ['PGPASSWORD', 'PGSERVICE', 'PGSERVICEFILE', 'PGPORT', 'PGUSER'])
    delete env[key]
  const run = (name, args, input) => {
    const [command, commandArgs] = runAs
      ? ['runuser', ['-u', runAs, '--', join(bin, name), ...args]]
      : [join(bin, name), args]
    return execFileSync(command, commandArgs, {
      cwd: root,
      env,
      input,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }
  const sql = (input) =>
    run('psql', ['-h', dir, '-d', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1'], input)
  let started = false
  try {
    // UTF-8 like the hosted database: the readable link address needs it.
    run('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-E', 'UTF8', '--locale=C'])
    run('pg_ctl', [
      '-D',
      join(dir, 'data'),
      '-l',
      join(dir, 'postgres.log'),
      '-o',
      `-k ${dir} -c listen_addresses=''`,
      '-w',
      'start',
    ])
    started = true
    sql(
      readFileSync(join(root, 'supabase/tests/bootstrap/external-commerce-native.sql'), 'utf8') +
        '\nalter table auth.users add column created_at timestamptz default now(), add column updated_at timestamptz default now(), add column last_sign_in_at timestamptz;' +
        'grant usage on schema storage, extensions to anon, authenticated, service_role;',
    )
    const migrations = readdirSync(join(root, 'supabase/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort()
    for (const file of migrations) {
      sql(
        readFileSync(join(root, 'supabase/migrations', file), 'utf8').replace(
          /^create extension if not exists pg_net with schema extensions;\s*$/m,
          '',
        ),
      )
    }
    for (const [file, done] of suites) {
      let output
      try {
        output = sql(readFileSync(join(root, 'supabase/tests/database', file), 'utf8'))
      } catch (error) {
        assert.fail(`${file}: ${error.stderr?.toString() || error.message}`)
      }
      // KMA_DB_TEST_OUTPUT=<file> keeps what each suite printed, for example the
      // "capture" lines of suite 75 that the front-end reader fixtures are made from.
      if (process.env.KMA_DB_TEST_OUTPUT)
        appendFileSync(process.env.KMA_DB_TEST_OUTPUT, `-- ${file}\n${output}\n`)
      assert.match(output, done)
    }
  } finally {
    if (started) run('pg_ctl', ['-D', join(dir, 'data'), 'stop', '-m', 'fast'])
    rmSync(dir, { recursive: true, force: true })
  }
})
