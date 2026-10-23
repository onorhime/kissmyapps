-- Run in one rollback transaction, with the migration applied in that same
-- transaction. This suite never calls net.http_post or any worker/financial RPC.
create temporary table scheduler_assertions(label text);
create function pg_temp.scheduler_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Scheduler assertion failed: %',label; end if;
  insert into scheduler_assertions values(label);
end $$;
select pg_temp.scheduler_assert(not enabled,'disabled by default') from kma_internal.processing_schedule;
select pg_temp.scheduler_assert(not has_function_privilege('anon','public.begin_processing_stage(uuid,text)','execute'), 'anon cannot dispatch');
select pg_temp.scheduler_assert(not has_function_privilege('authenticated','public.begin_processing_stage(uuid,text)','execute'), 'user cannot dispatch');
select pg_temp.scheduler_assert(has_function_privilege('service_role','public.begin_processing_stage(uuid,text)','execute'), 'service may claim issued stage');
select pg_temp.scheduler_assert(not has_table_privilege('service_role','kma_internal.processing_schedule','update'),'service cannot rewrite schedule');
select pg_temp.scheduler_assert(not has_function_privilege('service_role','kma_internal.tick_processing_schedule()','execute'),'service cannot enqueue');
select pg_temp.scheduler_assert(not has_function_privilege('authenticated','public.processing_scheduler_health()','execute'),'private health');
select pg_temp.scheduler_assert(kma_internal.tick_processing_schedule()->>'status'='paused','disabled tick does not dispatch');

do $$
declare
  run uuid;
  other uuid := gen_random_uuid();
  w text;
  payload jsonb;
  zero jsonb := '{"claimed":0,"processed":0,"retried":0,"failed":0,"deferred":0}';
  code text;
begin
  foreach w in array array['stripe-worker','commercial-worker','metrics-worker'] loop
    run := gen_random_uuid();
    insert into kma_internal.processing_stage_runs(id,worker) values(run,w);
    update kma_internal.processing_schedule set enabled=true,paused_reason=null,worker=w,
      run_id=run,request_id=-1,dispatched_at=now();
    perform pg_temp.scheduler_assert(not public.begin_processing_stage(other,w),'unknown run blocked');
    perform pg_temp.scheduler_assert(not public.begin_processing_stage(run,'not-a-worker'),'wrong worker blocked');
    perform pg_temp.scheduler_assert(public.begin_processing_stage(run,w),'issued stage starts once');
    perform pg_temp.scheduler_assert(not public.begin_processing_stage(run,w),'duplicate stage blocked');
    payload := zero || jsonb_build_object('run_id',run,'worker',w,'status','processed');
    perform pg_temp.scheduler_assert(not kma_internal.finish_processing_stage(other,200,payload,false),'stale result ignored');
    perform pg_temp.scheduler_assert(kma_internal.finish_processing_stage(run,200,payload,false),'success accepted');
    perform pg_temp.scheduler_assert(not kma_internal.finish_processing_stage(run,200,payload,false),'duplicate result ignored');
    perform pg_temp.scheduler_assert((select run_id is null and worker=case w
      when 'stripe-worker' then 'commercial-worker' when 'commercial-worker' then 'metrics-worker'
      else 'stripe-worker' end from kma_internal.processing_schedule),'chain advances in order');
  end loop;
  perform pg_temp.scheduler_assert((select last_cycle_at is not null from kma_internal.processing_schedule),'full cycle recorded');

  foreach code in array array['transport','http','wrong_run','missing_count','inconsistent','negative','string','wrong_worker'] loop
    run := gen_random_uuid();
    insert into kma_internal.processing_stage_runs(id,worker) values(run,'stripe-worker');
    update kma_internal.processing_schedule set enabled=true,paused_reason=null,worker='stripe-worker',
      run_id=run,request_id=-1,dispatched_at=now();
    perform public.begin_processing_stage(run,'stripe-worker');
    payload := zero || jsonb_build_object('run_id',run,'worker','stripe-worker','status','processed');
    if code='wrong_run' then payload := payload || jsonb_build_object('run_id',other); end if;
    if code='missing_count' then payload := payload-'claimed'; end if;
    if code='inconsistent' then payload := payload || '{"claimed":1}'::jsonb; end if;
    if code='negative' then payload := payload || '{"claimed":-1}'::jsonb; end if;
    if code='string' then payload := payload || '{"claimed":"0"}'::jsonb; end if;
    if code='wrong_worker' then payload := payload || '{"worker":"metrics-worker"}'::jsonb; end if;
    perform pg_temp.scheduler_assert(not kma_internal.finish_processing_stage(run,
      case when code='http' then 401 else 200 end,payload,code='transport'),'bad response rejected');
    perform pg_temp.scheduler_assert((select not enabled and paused_reason is not null and run_id=run
      from kma_internal.processing_schedule),'failure pauses and retains identity');
    perform pg_temp.scheduler_assert(not public.begin_processing_stage(run,'stripe-worker'),'paused stage cannot restart');
  end loop;

  run := gen_random_uuid();
  insert into kma_internal.processing_stage_runs(id,worker) values(run,'stripe-worker');
  update kma_internal.processing_schedule set enabled=true,paused_reason=null,worker='stripe-worker',
    run_id=run,request_id=-999999999,dispatched_at=now()-interval '4 minutes';
  perform pg_temp.scheduler_assert(not public.begin_processing_stage(run,'stripe-worker'),'expired dispatch cannot start');
  perform pg_temp.scheduler_assert(kma_internal.tick_processing_schedule()->>'status'='paused','missing response pauses after deadline');
  perform pg_temp.scheduler_assert(public.processing_scheduler_health()->>'attention_required'='true','pause visible in health');

  run := gen_random_uuid();
  insert into kma_internal.processing_stage_runs(id,worker) values(run,'stripe-worker');
  update kma_internal.processing_schedule set enabled=true,paused_reason=null,worker='stripe-worker',
    run_id=run,request_id=-1,dispatched_at=now();
  perform pg_temp.scheduler_assert(kma_internal.tick_processing_schedule()->>'status'='waiting','waiting does not enqueue another stage');
  perform public.begin_processing_stage(run,'stripe-worker');
  payload := jsonb_build_object('run_id',run,'worker','stripe-worker','status','processed',
    'claimed',3,'processed',0,'retried',1,'failed',1,'deferred',1);
  perform pg_temp.scheduler_assert(kma_internal.finish_processing_stage(run,200,payload,false),'completed degraded batch advances');
  perform pg_temp.scheduler_assert((select outcome='degraded' from kma_internal.processing_stage_runs where id=run),'degraded counts retained');
  perform pg_temp.scheduler_assert(public.processing_scheduler_health()->>'attention_required'='true','degraded batch visible in health');
end $$;
select count(*) as passed_scheduler_assertions from scheduler_assertions;
