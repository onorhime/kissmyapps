/** Merchant analytics SQL suite on a disposable local Postgres cluster.
 * Applies the bootstrap and every migration, then runs
 * supabase/tests/database/63_merchant_analytics.sql in one rolled-back transaction.
 * Skips when no Postgres binaries are installed. PG_BIN picks the binaries; when
 * running as root, PG_RUN_AS names the user that runs the cluster.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
    run('initdb', ['-D', join(dir, 'data'), '-A', 'trust'])
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
    let output
    try {
      output = sql(
        readFileSync(join(root, 'supabase/tests/database/63_merchant_analytics.sql'), 'utf8'),
      )
    } catch (error) {
      assert.fail(error.stderr?.toString() || error.message)
    }
    assert.match(output, /^ok \d+ merchant analytics assertions$/m)
  } finally {
    if (started) run('pg_ctl', ['-D', join(dir, 'data'), 'stop', '-m', 'fast'])
    rmSync(dir, { recursive: true, force: true })
  }
})
