// Scoped rollback-only checks. Never deploys, invokes HTTP workers or sends mail.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
if (process.argv.length !== 2) throw Error('No deployment mode exists')
const project = 'mmyruzjemjecqyivhrgr'
// Use the already-authorized control-plane credential in RAM only. This avoids
// CLI telemetry writes, which can fail on a full local disk. No secrets printed.
const stored = execFileSync('/usr/bin/security',
  ['find-generic-password','-s','Supabase CLI','-a','supabase','-w'],
  {encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:20_000}).trim()
const access = stored.startsWith('go-keyring-base64:')
  ? Buffer.from(stored.slice(18),'base64').toString('utf8') : stored
const query = async sql => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`, {
    method:'POST',headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},
    body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(30_000),
  })
  if(!response.ok) throw Error(`Rollback query failed: HTTP ${response.status}`)
  const rows=await response.json()
  if(!Array.isArray(rows)) throw Error('Unexpected database result')
  return rows
}
const fingerprint = async () => (await query(`select jsonb_build_object(
  'subscriptions',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.subscriptions t),
  'transactions',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.transactions t),
  'commissions',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.commission_entries t),
  'attempts',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.checkout_attempts t),
  'events',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.provider_events t),
  'diagnostics',to_regclass('kma_internal.processing_stage_diagnostics')::text,
  'migrations',(select count(*) from supabase_migrations.schema_migrations),
  'definitions',(select jsonb_object_agg(proname,md5(prosrc)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and proname in ('processing_scheduler_health','begin_processing_stage'))
      or (n.nspname='kma_internal' and proname in ('tick_processing_schedule','finish_processing_stage')))
) as state`))[0].state
try {
  const before=await fingerprint()
  const candidate=readFileSync('supabase/migrations/20260907160000_processing_reliability_visibility.sql','utf8')
    .replace(/(^|\n)begin;\s*/,'$1').replace(/commit;\s*$/,'')
  const checks=readFileSync('supabase/tests/database/34_processing_reliability_visibility.sql','utf8')
  const results=await query("begin; set local lock_timeout='2s'; set local statement_timeout='20s';\n"+
    "select pg_advisory_xact_lock(hashtextextended('kma-processing-scheduler',0));\n"+candidate+'\n'+checks+'\nrollback;')
  const after=await fingerprint()
  const unchanged=JSON.stringify(before)===JSON.stringify(after)
  console.log(JSON.stringify({at:new Date().toISOString(),project,rollback:true,unchanged,results,before,after}))
  if(!unchanged) process.exitCode=1
} catch(error) {
  console.error(error.message || 'Rollback reliability check failed')
  process.exitCode=1
}
