// One-shot, user-approved recovery of the inspected 2026-09-07 metrics 502.
// Only scheduler control + an audit row change. No event replay, credential
// access, Stripe calls, function deployments, checkout or payout activation.
import { execFileSync } from 'node:child_process'
const project = 'mmyruzjemjecqyivhrgr'
const failedRun = '409f4981-dad5-4fbd-817e-87811be6ad37'
const query = sql => JSON.parse(execFileSync('pnpm', ['exec', 'supabase', 'db',
  'query', '--linked', '--project-ref', project, '--file', '/dev/stdin', '--output', 'json'],
{ input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
  maxBuffer: 4 * 1024 * 1024 })).rows
const snapshot = () => query(`select jsonb_build_object(
  'at',now(),'health',public.processing_scheduler_health(),
  'facts',jsonb_build_object(
    'attempts',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.checkout_attempts t),
    'events',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.provider_events t),
    'subscriptions',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.subscriptions t),
    'transactions',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.transactions t),
    'commissions',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.commission_entries t)),
  'counts',jsonb_build_object('checkout_attempts',(select count(*) from public.checkout_attempts),
    'provider_events',(select count(*) from public.provider_events),'subscriptions',(select count(*) from public.subscriptions),
    'transactions',(select count(*) from public.transactions),'commissions',(select count(*) from public.commission_entries)),
  'recovery_audit',(select jsonb_build_object('id',id,'created_at',created_at) from public.audit_logs
    where action='processing.scheduler_recovered' and metadata->>'failed_run_id'='${failedRun}' order by created_at desc limit 1),
  'failed_stage',(select to_jsonb(r) from kma_internal.processing_stage_runs r where id='${failedRun}'),
  'cron',(select jsonb_agg(jsonb_build_object('name',jobname,'schedule',schedule,'active',active))
    from cron.job where jobname='kma-processing-chain')
) as state`)[0].state

const recovery = `begin;
set local lock_timeout='3s'; set local statement_timeout='20s';
select pg_advisory_xact_lock(hashtextextended('kma-processing-scheduler',0));
do $$ declare s kma_internal.processing_schedule%rowtype;
  r kma_internal.processing_stage_runs%rowtype; h net._http_response%rowtype;
begin
  select * into strict s from kma_internal.processing_schedule where singleton for update;
  if s.enabled or s.paused_reason is distinct from 'worker_http_failure'
    or s.run_id is distinct from '${failedRun}'::uuid or s.worker is distinct from 'metrics-worker'
    then raise exception 'Recovery target/state drift'; end if;
  select * into strict r from kma_internal.processing_stage_runs where id=s.run_id for update;
  if r.outcome is distinct from 'failed' or r.http_status is distinct from 503
    or r.error_code is distinct from 'worker_http_failure' or r.finished_at is null
    or r.finished_at > now()-interval '10 minutes'
    then raise exception 'Failed invocation is not safely complete'; end if;
  select * into strict h from net._http_response where id=s.request_id;
  if h.status_code is distinct from 503 or coalesce(h.timed_out,false) or h.error_msg is not null
    then raise exception 'HTTP completion receipt differs'; end if;
  if exists(select 1 from kma_internal.processing_stage_runs where outcome in ('running','dispatched'))
    then raise exception 'Another scheduler stage is in flight'; end if;
  if exists(select 1 from public.provider_event_processing where status in ('pending','processing','failed'))
    or exists(select 1 from public.commercial_fact_processing where status in ('pending','processing','failed'))
    or exists(select 1 from public.commercial_metric_refresh_queue where status in ('pending','processing','failed'))
    then raise exception 'Work queues changed; inspect before recovery'; end if;
  if (select count(*) from cron.job where jobname='kma-processing-chain' and active and schedule='* * * * *')<>1
    then raise exception 'Expected single active processing cron'; end if;
  if exists(select 1 from public.audit_logs where action='processing.scheduler_recovered'
    and metadata->>'failed_run_id'='${failedRun}') then raise exception 'Recovery already recorded'; end if;
  update kma_internal.processing_schedule set enabled=true,paused_reason=null,worker='stripe-worker',
    run_id=null,request_id=null,dispatched_at=null where singleton;
  insert into public.audit_logs(actor_type,action,target_table,reason,before_data,after_data,metadata)
  values('service','processing.scheduler_recovered','processing_schedule',
    'User approved one supervised recovery after completed metrics HTTP 502/dispatch 503; no active stages or leases; historical run preserved',
    to_jsonb(s)-'last_tick_at',(select to_jsonb(t)-'last_tick_at' from kma_internal.processing_schedule t where singleton),
    jsonb_build_object('failed_run_id','${failedRun}','scope','scheduler_control_only','checkout_called',false));
end $$;
`
try {
  const mode=process.argv[2]
  if (!['--status','--test','--resume-approved'].includes(mode)) throw Error('Explicit mode required')
  const before=snapshot()
  if (mode==='--status') {
    const auditAt=before.recovery_audit?.created_at
    const recent=before.health.recent_runs.filter(r=>auditAt && r.dispatched_at>auditAt)
    const fullCycle=['stripe-worker','commercial-worker','metrics-worker'].every(w=>recent.some(r=>r.worker===w&&r.outcome==='succeeded'&&r.http_status===200))
    console.log(JSON.stringify({...before, fullCycleAfterRecovery:fullCycle,
      health:{...before.health,recent_runs:recent.length?recent:before.health.recent_runs.slice(0,1)}}))
    process.exit(0)
  }
  query(recovery+(mode==='--test'?'rollback;':'commit;'))
  const after=snapshot()
  const evidenceUnchanged=JSON.stringify(before.facts)===JSON.stringify(after.facts)
    && JSON.stringify(before.failed_stage)===JSON.stringify(after.failed_stage)
    && JSON.stringify(before.cron)===JSON.stringify(after.cron)
  const control = s => ({...s,last_tick_at:null})
  const rolledBack=mode==='--test'&&JSON.stringify(control(before.health.schedule))===JSON.stringify(control(after.health.schedule))
    && JSON.stringify(before.recovery_audit)===JSON.stringify(after.recovery_audit)
  const passed=evidenceUnchanged&&(mode==='--test'?rolledBack:after.health.schedule.enabled&&after.health.schedule.paused_reason===null&&Boolean(after.recovery_audit))
  console.log(JSON.stringify({mode,passed,evidenceUnchanged,rolledBack,before,after}))
  if(!passed)process.exitCode=1
} catch {
  console.error('Scheduler recovery stopped. Inspect current state before retrying; no automatic reset or checkout was attempted.')
  process.exitCode=1
}
