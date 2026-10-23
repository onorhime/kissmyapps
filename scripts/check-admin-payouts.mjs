// Rollback-only candidate validation. No deployment or transfer mode.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
if (process.argv.length !== 2) throw Error('No deployment mode exists')
const project = 'mmyruzjemjecqyivhrgr'
const stored = execFileSync(
  '/usr/bin/security',
  ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'],
  { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 },
).trim()
const token = stored.startsWith('go-keyring-base64:')
  ? Buffer.from(stored.slice(18), 'base64').toString()
  : stored
async function query(sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(45000),
  })
  if (!response.ok) throw Error((await response.text()).slice(0, 1800))
  return response.json()
}
async function fingerprint() {
  const tables = [
    'subscriptions',
    'provider_events',
    'checkout_attempts',
    'transactions',
    'commission_entries',
    'payouts',
    'payout_periods',
    'payout_destinations',
    'payout_agreement_snapshots',
    'admin_users',
    'payout_destination_events',
    'reconciliation_runs',
    'audit_logs',
    'products',
    'agreements',
  ]
  const fields = tables.flatMap((table) => [
    `'${table}'`,
    `(select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'')) from public.${table} t)`,
  ])
  return (
    await query(
      `select jsonb_build_object(${fields.join(',')},'migrations',(select count(*) from supabase_migrations.schema_migrations),'candidate',to_regprocedure('public.perform_admin_payout_action(jsonb)')::text) as state`,
    )
  )[0].state
}
try {
  const before = await fingerprint()
  if (before.candidate !== null) throw Error('Candidate already deployed; inspect first')
  const migration = readFileSync(
    'supabase/migrations/20260907190000_admin_payout_workflow.sql',
    'utf8',
  )
    .replace(/(^|\n)begin;\s*/, '$1')
    .replace(/commit;\s*$/, '')
  const tests = readFileSync('supabase/tests/database/37_admin_payout_workflow.sql', 'utf8')
  const results = await query(
    "begin;set local lock_timeout='3s';set local statement_timeout='25s';" +
      migration +
      tests +
      'rollback;',
  )
  const after = await fingerprint()
  const unchanged = JSON.stringify(before) === JSON.stringify(after)
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      rollback: true,
      unchanged,
      results,
      before,
      after,
    }),
  )
  if (!unchanged) process.exitCode = 1
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
