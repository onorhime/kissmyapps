-- Runs with both candidate migrations in one rollback transaction. No HTTP.
create temporary table alert_checks(label text);
create function pg_temp.alert_assert(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Alert assertion: %',label; end if;
insert into alert_checks values(label); end $$;
create function pg_temp.alert_reject(stmt text,expected text,label text) returns void language plpgsql as $$
begin begin execute stmt; exception when others then if sqlstate<>expected then raise; end if;
insert into alert_checks values(label); return; end; raise exception 'Expected rejection: %',label; end $$;
select pg_temp.alert_assert(not has_function_privilege('authenticated','public.claim_processing_alert_job()','execute'),'browser cannot trigger sends');
select pg_temp.alert_assert(not has_function_privilege('anon','public.claim_processing_alert_job()','execute'),'anonymous cannot trigger sends');
select pg_temp.alert_assert(has_function_privilege('service_role','public.claim_processing_alert_job()','execute'),'dedicated worker may claim');
select pg_temp.alert_assert(not has_function_privilege('service_role','kma_internal.observe_processing_alerts(jsonb,boolean)','execute'),'service cannot fabricate observations');
select pg_temp.alert_assert(not has_table_privilege('authenticated','kma_internal.processing_alert_config','select'),'recipient stays private');
select pg_temp.alert_assert(not has_table_privilege('service_role','kma_internal.processing_alert_jobs','insert'),'no arbitrary service outbox inserts');
select pg_temp.alert_assert(public.claim_processing_alert_job()='[]'::jsonb,'disabled monitor sends nothing');
do $$ declare h jsonb; bad jsonb; q jsonb; j jsonb; envelope jsonb; old_id uuid; token uuid; current_id uuid;
begin
  q:=jsonb_build_object('worker','stripe','pending',0,'processing',0,'failed',0,'expired_leases',0,'oldest_unfinished_at',null);
  h:=jsonb_build_object('schedule',jsonb_build_object('enabled',true,'paused_reason',null,'last_tick_at',now(),'last_cycle_at',now()),
    'queues',jsonb_build_array(q,q||'{"worker":"commercial"}',q||'{"worker":"metrics"}'));
  bad:=jsonb_set(h,'{schedule,enabled}','false');
  update kma_internal.processing_alert_config set enabled=true,recipient_email='operator@example.com' where singleton;
  perform kma_internal.observe_processing_alerts(h,false);
  perform pg_temp.alert_assert((select count(*)=0 from kma_internal.processing_alert_jobs),'healthy bootstrap quiet');
  perform kma_internal.observe_processing_alerts(bad,false);
  perform kma_internal.observe_processing_alerts(bad,false);
  perform pg_temp.alert_assert((select count(*)=1 from kma_internal.processing_alert_jobs),'repeated failure one email');
  select id into old_id from kma_internal.processing_alert_incidents where resolved_at is null;
  perform kma_internal.observe_processing_alerts(h,false);
  perform pg_temp.alert_assert((select resolved_at is null from kma_internal.processing_alert_incidents where id=old_id),'recovery waits for stability');
  update kma_internal.processing_alert_config set healthy_since=now()-interval '3 minutes';
  update kma_internal.processing_alert_incidents set opened_at=now()-interval '5 minutes' where id=old_id;
  perform kma_internal.observe_processing_alerts(h,false);
  perform kma_internal.observe_processing_alerts(h,false);
  perform pg_temp.alert_assert((select count(*)=1 from kma_internal.processing_alert_jobs where kind='recovery'),'one recovery email');
  perform kma_internal.observe_processing_alerts(bad,false);
  perform pg_temp.alert_assert((select count(*)=2 from kma_internal.processing_alert_incidents),'new incident after recovery');

  -- Real live health may be healthy or degraded, but cannot alter our already-open incident.
  j:=public.claim_processing_alert_job()->0;
  current_id:=(j->>'id')::uuid;token:=(j->>'claimToken')::uuid;
  perform pg_temp.alert_assert(j->>'to'='operator@example.com' and j->>'kind'='failure','server-owned first recipient and failure');
  perform pg_temp.alert_assert(public.claim_processing_alert_job()='[]','active send cannot be leased twice');
  envelope:=jsonb_build_object('from',j->>'from','to',j->>'to','subject','Test fixture','html','<p>Fixture</p>');
  perform pg_temp.alert_reject(format('select public.seal_processing_alert_job(%L,%L,%L)',current_id,gen_random_uuid(),envelope),'P0001','wrong lease rejected');
  perform pg_temp.alert_reject(format('select public.seal_processing_alert_job(%L,%L,%L)',current_id,token,envelope||'{"to":"other@example.com"}'),'22023','recipient substitution rejected');
  perform pg_temp.alert_assert(public.seal_processing_alert_job(current_id,token,envelope)=envelope,'envelope sealed before sending');
  perform pg_temp.alert_assert(public.seal_processing_alert_job(current_id,token,envelope||'{"subject":"changed"}')=envelope,'envelope immutable');
  perform pg_temp.alert_assert(not public.finish_processing_alert_job(current_id,gen_random_uuid(),'receipt'),'wrong ack token rejected');
  perform pg_temp.alert_reject(format('select public.finish_processing_alert_job(%L,%L,null,%L,true)',current_id,token,'raw customer body'),'22023','raw error rejected');
  perform pg_temp.alert_assert(public.finish_processing_alert_job(current_id,token,null,'provider_unavailable',true),'retry stored');
  perform pg_temp.alert_assert(public.claim_processing_alert_job()='[]','recovery cannot overtake retry backoff');
  update kma_internal.processing_alert_jobs set next_attempt_at=now()-interval '1 minute' where id=current_id;
  j:=public.claim_processing_alert_job()->0;token:=(j->>'claimToken')::uuid;
  perform pg_temp.alert_assert(j->>'id'=current_id::text and j->'envelope'=envelope,'retry retains identity and envelope');
  perform pg_temp.alert_assert(public.finish_processing_alert_job(current_id,token,'provider_receipt'),'acceptance acknowledged');
  perform pg_temp.alert_assert(not public.finish_processing_alert_job(current_id,token,'provider_receipt'),'duplicate acknowledgement inert');
  perform pg_temp.alert_assert((select status='accepted' from kma_internal.processing_alert_jobs where id=current_id),'acceptance is not delivery');
  j:=public.claim_processing_alert_job()->0;
  perform pg_temp.alert_assert(j->>'kind'='recovery','recovery follows accepted failure');
  update kma_internal.processing_alert_jobs set lease_until=now()-interval '1 minute',first_attempt_at=now()-interval '21 hours' where id=(j->>'id')::uuid;
  perform public.claim_processing_alert_job();
  perform pg_temp.alert_assert((select status='failed' and last_error='retry_window_exhausted' from kma_internal.processing_alert_jobs where id=(j->>'id')::uuid),'dedup window expiry stops retry');
  update kma_internal.processing_alert_jobs set lease_until=now()-interval '1 minute' where status='processing';
  update kma_internal.processing_alert_config set recipient_email='changed@example.com';
  perform public.claim_processing_alert_job();
  perform pg_temp.alert_assert(not exists(select 1 from kma_internal.processing_alert_jobs where recipient_email='operator@example.com' and status in ('pending','processing')),'recipient change does not redirect old emails');
  update kma_internal.processing_alert_config set enabled=false;
  perform pg_temp.alert_assert(public.claim_processing_alert_job()='[]','disabled monitor cannot send remaining jobs');
end $$;
select count(*) as passed_alert_assertions from alert_checks;
