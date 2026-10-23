// Candidate read-model validation only. No deploy mode; all test DDL rolls back.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
if (process.argv.length !== 2) throw Error('No deployment mode exists')
const project = 'mmyruzjemjecqyivhrgr'
const stored = execFileSync(
  '/usr/bin/security',
  ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'],
  { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 },
).trim()
const access = stored.startsWith('go-keyring-base64:')
  ? Buffer.from(stored.slice(18), 'base64').toString('utf8')
  : stored
const query = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(45000),
  })
  if (!r.ok) {
    console.error((await r.text()).slice(0, 1500))
    throw Error(`Database check HTTP ${r.status}`)
  }
  return r.json()
}
const fingerprint = async () =>
  (
    await query(`select jsonb_build_object(
  'subscriptions',(select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.subscriptions s),
  'events',(select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.provider_events s),
  'attempts',(select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.checkout_attempts s),
  'transactions',(select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.transactions s),
  'commissions',(select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.commission_entries s),
  'admins',(select md5(coalesce(jsonb_agg(to_jsonb(s) order by user_id)::text,'')) from public.admin_users s),
  'migrations',(select count(*) from supabase_migrations.schema_migrations),
  'candidate',to_regprocedure('public.get_admin_subscriptions(text,text,uuid,integer,integer,text)')::text
) as state`)
  )[0].state
try {
  const before = await fingerprint()
  if (before.candidate !== null) throw Error('Read model already exists; inspect before testing')
  const sql = readFileSync('supabase/migrations/20260907180000_admin_subscriptions.sql', 'utf8')
    .replace(/(^|\n)begin;\s*/, '$1')
    .replace(/commit;\s*$/, '')
  const tests = readFileSync('supabase/tests/database/36_admin_subscriptions.sql', 'utf8')
  const results = await query(
    "begin;set local lock_timeout='3s';set local statement_timeout='25s';" +
      sql +
      tests +
      'rollback;',
  )
  const after = await fingerprint(),
    unchanged = JSON.stringify(before) === JSON.stringify(after)
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      project,
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
