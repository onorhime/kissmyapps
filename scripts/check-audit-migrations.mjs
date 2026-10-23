import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const project = 'mmyruzjemjecqyivhrgr'
const args = [
  'exec',
  'supabase',
  'db',
  'query',
  '--linked',
  '--project-ref',
  project,
  '--output',
  'json',
]
const run = (sql) =>
  execFileSync('pnpm', [...args, '--file', '/dev/stdin'], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  })
try {
  const state = JSON.parse(
    run(
      'select (select count(*) from public.products) as products, (select count(*) from public.documents) as documents',
    ),
  )
  if (Number(state.rows[0]?.products) !== 0 || Number(state.rows[0]?.documents) !== 0) {
    throw new Error(
      'This bounded prelaunch regression requires an empty product/document catalog. Stop and choose a separately reviewed test boundary.',
    )
  }
  const history = JSON.parse(run('select version from supabase_migrations.schema_migrations'))
  const applied = new Set(history.rows.map((row) => row.version))
  let sql = "begin;\nset local lock_timeout='3s';\nset local statement_timeout='20s';\n"
  for (const file of readdirSync('supabase/migrations')
    .filter((file) => file.startsWith('20260905'))
    .sort()) {
    if (!applied.has(file.split('_')[0])) {
      sql +=
        readFileSync(`supabase/migrations/${file}`, 'utf8')
          .replace(/^begin;\s*/, '')
          .replace(/commit;\s*$/, '') + '\n'
    }
  }
  sql += readFileSync('supabase/tests/database/24_agreement_audit_regression.sql', 'utf8')
    .replace(/(^|\n)begin;\s*/, '$1')
    .replace(/rollback;\s*$/, '')
  sql += '\nrollback;'
  if (process.argv.includes('--funnel')) {
    sql =
      sql.replace(/rollback;\s*$/, '') +
      '\n' +
      readFileSync('supabase/tests/database/25_funnel_checkout_context.sql', 'utf8') +
      '\n' +
      readFileSync('supabase/tests/database/26_zero_total_checkout.sql', 'utf8') +
      '\nrollback;'
  }
  console.log(
    'Hosted regression check: every schema change and synthetic fixture is rolled back; no HTTP or email send is invoked.',
  )
  console.log(run(sql))
} catch (error) {
  console.error(error.stderr?.toString() || error.message || 'Hosted rollback check failed.')
  process.exitCode = 1
}
