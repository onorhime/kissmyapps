-- Candidate schema and these checks must share one ROLLBACK transaction.
-- No HTTP, worker invocation, financial writes, Auth API or outbound email.
create temporary table reliability_checks(label text);
grant select,insert on reliability_checks to authenticated,service_role;
create function pg_temp.reliability_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Reliability check failed: %',label; end if;
  insert into reliability_checks values(label);
end $$;
create function pg_temp.reliability_error(statement text,code text,label text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate<>code then raise; end if;
    insert into reliability_checks values(label); return;
  end;
  raise exception 'Expected rejection: %',label;
end $$;
grant execute on function pg_temp.reliability_assert(boolean,text),pg_temp.reliability_error(text,text,text) to authenticated,service_role;

select pg_temp.reliability_assert(not has_function_privilege('authenticated','public.processing_scheduler_health()','execute'),'original health remains private');
select pg_temp.reliability_assert(not has_function_privilege('anon','public.get_admin_processing_health()','execute'),'anonymous cannot read health');
select pg_temp.reliability_assert(not has_function_privilege('authenticated','public.record_processing_stage_diagnostic(jsonb)','execute'),'browser cannot write diagnostics');
select pg_temp.reliability_assert(has_function_privilege('service_role','public.record_processing_stage_diagnostic(jsonb)','execute'),'service can record guarded diagnostic');
select pg_temp.reliability_assert(not has_table_privilege('service_role','kma_internal.processing_stage_diagnostics','insert'),'service cannot bypass guarded writer');
select pg_temp.reliability_assert(not has_table_privilege('authenticated','kma_internal.processing_stage_diagnostics','select'),'browser cannot read diagnostic table');
select pg_temp.reliability_assert(not has_function_privilege('authenticated','kma_internal.processing_health_reasons(jsonb,boolean)','execute'),'alert helper private');
select pg_temp.reliability_assert(not has_function_privilege('authenticated','public.begin_processing_stage(uuid,text)','execute'),'browser cannot start processing');

do $$ declare h jsonb; q jsonb; variant jsonb; field text; reason text; owner_id uuid;
begin
  select user_id into strict owner_id from public.admin_users where role='owner' and active order by created_at limit 1;
  perform set_config('kma_test.reliability_owner',owner_id::text,true);
  q := jsonb_build_object('worker','stripe','pending',0,'processing',0,'failed',0,'expired_leases',0,'oldest_unfinished_at',null);
  h := jsonb_build_object('schedule',jsonb_build_object('enabled',true,'paused_reason',null,'last_tick_at',now(),'last_cycle_at',now()),
    'queues',jsonb_build_array(q,q||'{"worker":"commercial"}'::jsonb,q||'{"worker":"metrics"}'::jsonb));
  perform pg_temp.reliability_assert(kma_internal.processing_health_reasons(h,false)='{}'::text[],'fresh empty queues are healthy');
  perform pg_temp.reliability_assert(kma_internal.processing_health_reasons(h,true)=array['recent_worker_issue'],'recent issue remains visible');
  variant := jsonb_set(h,'{schedule,enabled}','false');
  perform pg_temp.reliability_assert('scheduler_paused'=any(kma_internal.processing_health_reasons(variant,false)),'disabled schedule alert');
  variant := jsonb_set(h,'{schedule,paused_reason}','"worker_http_failure"');
  perform pg_temp.reliability_assert('scheduler_paused'=any(kma_internal.processing_health_reasons(variant,false)),'pause reason alert');
  foreach field in array array['last_tick_at','last_cycle_at'] loop
    reason := case when field='last_tick_at' then 'heartbeat_stale' else 'cycle_stale' end;
    variant := jsonb_set(h,array['schedule',field],to_jsonb(now()-interval '11 minutes'));
    perform pg_temp.reliability_assert(reason=any(kma_internal.processing_health_reasons(variant,false)),'stale '||field);
    variant := jsonb_set(h,array['schedule',field],'null');
    perform pg_temp.reliability_assert(reason=any(kma_internal.processing_health_reasons(variant,false)),'missing '||field);
  end loop;
  for n in 0..2 loop
    variant := jsonb_set(h,array['queues',n::text,'failed'],'1');
    perform pg_temp.reliability_assert('jobs_failed'=any(kma_internal.processing_health_reasons(variant,false)),'failed queue '||n);
    variant := jsonb_set(h,array['queues',n::text,'expired_leases'],'1');
    perform pg_temp.reliability_assert('leases_expired'=any(kma_internal.processing_health_reasons(variant,false)),'expired queue lease '||n);
    variant := jsonb_set(h,array['queues',n::text,'oldest_unfinished_at'],to_jsonb(now()-interval '11 minutes'));
    perform pg_temp.reliability_assert('jobs_stalled'=any(kma_internal.processing_health_reasons(variant,false)),'stalled queue '||n);
  end loop;
  perform pg_temp.reliability_error($q$select kma_internal.processing_health_reasons('{}',false)$q$,'55000','missing health fails closed');
end $$;

set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('kma_test.reliability_owner'),'role','authenticated','amr',jsonb_build_array(jsonb_build_object('method','password')))::text,true);
select pg_temp.reliability_assert(public.get_admin_processing_health() ?& array['generated_at','reasons','queues','last_incident'],'password owner reads health');
select pg_temp.reliability_assert(public.get_admin_processing_health()->>'external_alerts_configured'='false','no imaginary external alerts');
select pg_temp.reliability_assert(public.get_admin_processing_health()::text !~ '(secret|request_id|customer|payload)','health excludes operational secrets and buyer data');
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('kma_test.reliability_owner'),'role','authenticated','amr',jsonb_build_array(jsonb_build_object('method','recovery')))::text,true);
select pg_temp.reliability_error('select public.get_admin_processing_health()','42501','recovery session denied');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000009999","role":"authenticated","amr":[{"method":"password"}]}',true);
select pg_temp.reliability_error('select public.get_admin_processing_health()','42501','non-admin denied');
select set_config('request.jwt.claims','{}',true);
select pg_temp.reliability_error('select public.get_admin_processing_health()','28000','missing identity denied');
reset role;

-- Vary only a synthetic diagnostic run and the scheduler pointer in this
-- rollback transaction. The runner holds the scheduler advisory lock.
do $$ declare run uuid:=gen_random_uuid(); d jsonb; original jsonb; n integer;
begin
  insert into kma_internal.processing_stage_runs(id,worker,outcome,started_at)
    values(run,'metrics-worker','running',now());
  update kma_internal.processing_schedule set worker='metrics-worker',run_id=run,request_id=-1,dispatched_at=now() where singleton;
  d:=jsonb_build_object('run_id',run,'worker','metrics-worker','code','worker_http_failure','upstream_http_status',502,'duration_ms',4);
  perform pg_temp.reliability_assert(not public.record_processing_stage_diagnostic(d||jsonb_build_object('run_id',gen_random_uuid())),'foreign run rejected');
  perform pg_temp.reliability_assert(not public.record_processing_stage_diagnostic(d||'{"worker":"stripe-worker"}'),'foreign worker rejected');
  perform pg_temp.reliability_error(format('select public.record_processing_stage_diagnostic(%L::jsonb)',d||'{"raw_body":"never store me"}'),'22023','raw body rejected');
  perform pg_temp.reliability_error(format('select public.record_processing_stage_diagnostic(%L::jsonb)',d||'{"upstream_http_status":0}'),'22023','invalid HTTP rejected');
  perform pg_temp.reliability_error(format('select public.record_processing_stage_diagnostic(%L::jsonb)',d||'{"duration_ms":180001}'),'22023','duration bounded');
  perform pg_temp.reliability_error(format('select public.record_processing_stage_diagnostic(%L::jsonb)',d||'{"code":"arbitrary"}'),'22023','unknown error code rejected');
  perform pg_temp.reliability_error(format('select public.record_processing_stage_diagnostic(%L::jsonb)',d||'{"upstream_http_status":200}'),'23514','HTTP failure cannot claim success status');
  perform pg_temp.reliability_error(format('select public.record_processing_stage_diagnostic(%L::jsonb)',d||'{"code":"worker_response_invalid","upstream_http_status":null}'),'23514','invalid response requires observed HTTP');
  perform pg_temp.reliability_error(format('select public.record_processing_stage_diagnostic(%L::jsonb)',d||'{"code":"worker_transport_failure"}'),'23514','transport failure cannot invent HTTP');
  perform pg_temp.reliability_assert(public.record_processing_stage_diagnostic(d),'first diagnostic recorded');
  perform pg_temp.reliability_assert(not public.record_processing_stage_diagnostic(d),'exact retry does not duplicate');
  perform pg_temp.reliability_assert(not public.record_processing_stage_diagnostic(d||'{"upstream_http_status":503}'),'conflict does not overwrite');
  perform pg_temp.reliability_assert((select upstream_http_status=502 from kma_internal.processing_stage_diagnostics where run_id=run),'original upstream status preserved');
  update kma_internal.processing_stage_runs set outcome='failed',finished_at=now(),error_code='worker_http_failure',http_status=503 where id=run;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('kma_test.reliability_owner'),'role','authenticated','amr',jsonb_build_array(jsonb_build_object('method','password')))::text,true);
  original:=public.get_admin_processing_health();
  perform pg_temp.reliability_assert(original#>>'{last_incident,upstream_http_status}'='502','admin sees real worker status');
  perform pg_temp.reliability_assert(original#>>'{last_incident,dispatch_http_status}'='503','admin distinguishes dispatcher status');
  perform pg_temp.reliability_assert(original->>'attention_required'='true','new failed stage alerts admin');
  perform pg_temp.reliability_assert(not public.record_processing_stage_diagnostic(d),'completed stage cannot be rewritten');
end $$;
select count(*) as passed_reliability_assertions from reliability_checks;
