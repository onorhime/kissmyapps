begin;
create temporary table managed_scheduler_assertions(label text);
create function pg_temp.managed_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'Managed scheduler assertion failed: %',label;end if;
 insert into managed_scheduler_assertions values(label);
end $$;
select pg_temp.managed_assert(not enabled and run_id is null,'new scheduler disabled') from kma_internal.managed_checkout_schedule;
select pg_temp.managed_assert(not('managed_checkout_issue'=any(kma_internal.processing_health_reasons(public.processing_scheduler_health(),false))),'disabled unstarted managed schedule does not trigger alert');
select pg_temp.managed_assert(kma_internal.tick_managed_checkout_schedule()->>'status'='paused','disabled never calls network');
select pg_temp.managed_assert(not has_function_privilege('anon','public.begin_managed_checkout_worker(uuid)','execute'),'anonymous cannot run');
select pg_temp.managed_assert(not has_function_privilege('authenticated','public.begin_managed_checkout_worker(uuid)','execute'),'user cannot run');
select pg_temp.managed_assert(not has_table_privilege('service_role','kma_internal.managed_checkout_schedule','update'),'service cannot enable schedule');
select pg_temp.managed_assert(not has_function_privilege('service_role','kma_internal.tick_managed_checkout_schedule()','execute'),'service cannot dispatch');
select pg_temp.managed_assert(not has_function_privilege('service_role','kma_internal.recover_managed_checkout_schedule(uuid)','execute'),'service cannot force recovery');
select pg_temp.managed_assert(has_function_privilege('service_role','public.managed_checkout_scheduler_health()','execute'),'private monitoring available');
select pg_temp.managed_assert(not has_function_privilege('authenticated','public.managed_checkout_scheduler_health()','execute'),'monitoring is private');

do $$
declare lease jsonb; run uuid; token uuid; other uuid:=gen_random_uuid(); zero jsonb:='{"reconciled":0,"delivered":0,"failed":0}';
begin
 lease:=public.begin_managed_checkout_worker();run:=(lease->>'run_id')::uuid;token:=(lease->>'lease_token')::uuid;
 perform pg_temp.managed_assert(run is not null,'manual reconciliation works with sales/schedule disabled');
 perform pg_temp.managed_assert(public.begin_managed_checkout_worker() is null,'second invocation blocked durably');
 perform pg_temp.managed_assert(public.begin_managed_checkout_worker(run) is null,'manual identity cannot become scheduled replay');
 perform pg_temp.managed_assert(not public.heartbeat_managed_checkout_worker(run,other),'wrong lease heartbeat rejected');
 perform pg_temp.managed_assert(public.heartbeat_managed_checkout_worker(run,token,'binding-a'),'owner heartbeat accepted');
 perform pg_temp.managed_assert(kma_internal.tick_managed_checkout_schedule()->>'status'='waiting','tick cannot overlap manual worker');
 perform pg_temp.managed_assert(not public.finish_managed_checkout_worker(other,token,zero),'stale run result rejected');
 perform pg_temp.managed_assert(not public.finish_managed_checkout_worker(run,other,zero),'wrong owner completion rejected');
 perform pg_temp.managed_assert(public.finish_managed_checkout_worker(run,token,zero),'owner finishes');
 perform pg_temp.managed_assert(not public.finish_managed_checkout_worker(run,token,zero),'double finish rejected');
 perform pg_temp.managed_assert((select run_id is null and last_success_at is not null and binding_cursor='binding-a' from kma_internal.managed_checkout_schedule),'completion records heartbeat and releases');

 run:=gen_random_uuid();insert into kma_internal.managed_checkout_worker_runs(id,source) values(run,'scheduled');
 update kma_internal.managed_checkout_schedule set enabled=true,run_id=run,request_id=-9901 where singleton;
 perform pg_temp.managed_assert(public.begin_managed_checkout_worker(other) is null,'unissued schedule token rejected');
 lease:=public.begin_managed_checkout_worker(run);token:=(lease->>'lease_token')::uuid;
 perform pg_temp.managed_assert(token is not null,'issued scheduled run starts');
 perform pg_temp.managed_assert(public.begin_managed_checkout_worker(run) is null,'replayed scheduled run rejected');
 perform pg_temp.managed_assert(kma_internal.tick_managed_checkout_schedule()->>'status'='waiting','second tick does not dispatch');
 perform pg_temp.managed_assert(not kma_internal.recover_managed_checkout_schedule(run),'cannot recover live run');
 update kma_internal.managed_checkout_worker_runs set issued_at=clock_timestamp()-interval '4 minutes',lease_expires_at=clock_timestamp()-interval '1 minute',heartbeat_at=clock_timestamp()-interval '4 minutes' where id=run;
 perform pg_temp.managed_assert(not public.finish_managed_checkout_worker(run,token,zero),'expired worker cannot finish');
 perform pg_temp.managed_assert(not public.heartbeat_managed_checkout_worker(run,token),'expired worker cannot renew');
 perform pg_temp.managed_assert(kma_internal.tick_managed_checkout_schedule()->>'status'='paused','crashed expired worker pauses');
 perform pg_temp.managed_assert(public.managed_checkout_scheduler_health()->>'attention_required'='true','stale worker visible in health');
 perform pg_temp.managed_assert(public.begin_managed_checkout_worker() is null,'manual cannot bypass crash pause');
 perform pg_temp.managed_assert(not kma_internal.recover_managed_checkout_schedule(other),'recovery requires exact failed run');
 perform pg_temp.managed_assert(kma_internal.recover_managed_checkout_schedule(run),'expired crashed run recovers safely');
 perform pg_temp.managed_assert((select not enabled and run_id is null and paused_reason is null from kma_internal.managed_checkout_schedule),'recovery stays disabled');
 perform pg_temp.managed_assert(not public.finish_managed_checkout_worker(run,token,zero),'old completion cannot clear next owner');
 lease:=public.begin_managed_checkout_worker();
 perform pg_temp.managed_assert(lease is not null,'new manual run allowed after recovery');
 perform pg_temp.managed_assert(public.finish_managed_checkout_worker((lease->>'run_id')::uuid,(lease->>'lease_token')::uuid,zero||'{"failed":1}'),'degraded run completes safely');
 perform pg_temp.managed_assert(public.managed_checkout_scheduler_health()->>'attention_required'='true','failed callback visible in run health');
 update kma_internal.managed_checkout_schedule set enabled=true where singleton;
 perform pg_temp.managed_assert(kma_internal.tick_managed_checkout_schedule()->>'reason'='scheduler_credential_missing','missing secret pauses without network');
end $$;
-- Local transport stub: records one issued request, performs no HTTP. This
-- replacement and the dummy Vault value are rolled back with the test.
create temporary table managed_scheduler_http_requests(id bigint generated always as identity,url text,body jsonb,headers jsonb,timeout_ms integer);
create or replace function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 5000) returns bigint language plpgsql as $$
declare issued bigint;begin
 insert into managed_scheduler_http_requests(url,body,headers,timeout_ms) values(url,body,headers,timeout_milliseconds) returning id into issued;
 return -issued;end $$;
insert into vault.decrypted_secrets(name,decrypted_secret) values('kma_managed_checkout_scheduler',repeat('local-fixture-only-',3));
update kma_internal.managed_checkout_schedule set enabled=true,paused_reason=null;
do $$
declare issued jsonb;lease jsonb;run uuid;token uuid;zero jsonb:='{"reconciled":0,"delivered":0,"failed":0}';
begin
 issued:=kma_internal.tick_managed_checkout_schedule();run:=(issued->>'run_id')::uuid;
 perform pg_temp.managed_assert(issued->>'status'='dispatched','enabled tick issues one authenticated worker request');
 perform pg_temp.managed_assert((select count(*)=1 from managed_scheduler_http_requests),'exactly one request queued');
 perform pg_temp.managed_assert((select headers?'x-kma-scheduler-secret' and body->>'run_id'=run::text and timeout_ms=80000 from managed_scheduler_http_requests),'dedicated auth and bounded transport');
 perform pg_temp.managed_assert(kma_internal.tick_managed_checkout_schedule()->>'status'='waiting','competing tick cannot enqueue duplicate');
 perform pg_temp.managed_assert((select count(*)=1 from managed_scheduler_http_requests),'waiting leaves queue unchanged');
 lease:=public.begin_managed_checkout_worker(run);token:=(lease->>'lease_token')::uuid;
 perform pg_temp.managed_assert(public.finish_managed_checkout_worker(run,token,zero),'scheduled acknowledgement completes issued identity');
 issued:=kma_internal.tick_managed_checkout_schedule();run:=(issued->>'run_id')::uuid;
 perform pg_temp.managed_assert((select count(*)=2 from managed_scheduler_http_requests),'next tick starts after completed run');
 insert into net._http_response(id,status_code,content,timed_out) select request_id,401,'{}',false from kma_internal.managed_checkout_schedule;
 perform pg_temp.managed_assert(kma_internal.tick_managed_checkout_schedule()->>'status'='paused','worker auth/config failure pauses');
 perform pg_temp.managed_assert(public.begin_managed_checkout_worker(run) is null,'paused issued request cannot start late');
 perform pg_temp.managed_assert(not kma_internal.recover_managed_checkout_schedule(run),'early recovery rejected after HTTP failure');
 update kma_internal.managed_checkout_worker_runs set issued_at=clock_timestamp()-interval '4 minutes',lease_expires_at=clock_timestamp()-interval '1 minute' where id=run;
 perform pg_temp.managed_assert(kma_internal.recover_managed_checkout_schedule(run),'failed dispatch recovers after safe expiry');
end $$;
select pg_temp.managed_assert((public.processing_scheduler_health()->'managed_checkout'->>'attention_required')::boolean,'existing health aggregates managed failures');
select pg_temp.managed_assert('managed_checkout_issue'=any(kma_internal.processing_health_reasons(public.processing_scheduler_health(),false)),'existing alert reason includes managed failure');
select pg_temp.managed_assert((select not enabled from kma_internal.processing_alert_config),'monitor configuration unchanged and disabled');
select kma_internal.observe_processing_alerts(public.processing_scheduler_health(),false);
select pg_temp.managed_assert((select count(*)=0 from kma_internal.processing_alert_jobs),'disabled monitor sends nothing');
update kma_internal.processing_alert_config set enabled=true,recipient_email='operator@example.invalid';
select kma_internal.observe_processing_alerts(public.processing_scheduler_health(),false);
select pg_temp.managed_assert((select count(*)=1 and bool_and('managed_checkout_issue'=any(reasons)) from kma_internal.processing_alert_jobs),'configured monitor receives managed failure in existing outbox');
select count(*) as passed_managed_scheduler_assertions from managed_scheduler_assertions;
rollback;
