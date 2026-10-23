-- Separate, disabled-by-default payment reconciliation schedule. No cron job,
-- secret, activation or change to the legacy three-worker chain is installed.
begin;
create table kma_internal.managed_checkout_schedule (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false, paused_reason text,
 run_id uuid, request_id bigint, last_tick_at timestamptz,
 last_success_at timestamptz, binding_cursor text,
 check(run_id is not null or request_id is null)
);
create table kma_internal.managed_checkout_worker_runs (
 id uuid primary key, lease_token uuid not null default gen_random_uuid(),
 source text not null check(source in('scheduled','manual')),
 issued_at timestamptz not null default clock_timestamp(),
 lease_expires_at timestamptz not null default clock_timestamp()+interval '120 seconds',
 started_at timestamptz, heartbeat_at timestamptz, finished_at timestamptz,
 outcome text not null default 'dispatched' check(outcome in('dispatched','running','succeeded','degraded','failed')),
 error_code text, counts jsonb
);
create index managed_checkout_worker_runs_recent on kma_internal.managed_checkout_worker_runs(issued_at desc);
alter table kma_internal.managed_checkout_schedule add foreign key(run_id) references kma_internal.managed_checkout_worker_runs(id);
insert into kma_internal.managed_checkout_schedule default values;
revoke all on kma_internal.managed_checkout_schedule,kma_internal.managed_checkout_worker_runs from public,anon,authenticated,service_role;

create function public.begin_managed_checkout_worker(p_run_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s kma_internal.managed_checkout_schedule%rowtype; r kma_internal.managed_checkout_worker_runs%rowtype;
begin
 select * into s from kma_internal.managed_checkout_schedule where singleton for update;
 if s.paused_reason is not null then return null;end if;
 if p_run_id is null then
  if s.run_id is not null then return null;end if;
  insert into kma_internal.managed_checkout_worker_runs(id,source) values(gen_random_uuid(),'manual') returning * into r;
  update kma_internal.managed_checkout_schedule set run_id=r.id where singleton;
 else
  if not s.enabled or s.run_id is distinct from p_run_id then return null;end if;
  select * into r from kma_internal.managed_checkout_worker_runs where id=p_run_id;
 end if;
 if r.outcome<>'dispatched' or r.issued_at<clock_timestamp()-interval '60 seconds' then return null;end if;
 update kma_internal.managed_checkout_worker_runs set started_at=clock_timestamp(),heartbeat_at=clock_timestamp(),outcome='running' where id=r.id;
 return jsonb_build_object('run_id',r.id,'lease_token',r.lease_token,'binding_cursor',s.binding_cursor);
end $$;

create function public.heartbeat_managed_checkout_worker(p_run_id uuid,p_lease_token uuid,p_binding_cursor text default null)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform 1 from kma_internal.managed_checkout_schedule where singleton and run_id=p_run_id for update;
 if not found then return false;end if;
 update kma_internal.managed_checkout_worker_runs set heartbeat_at=clock_timestamp()
 where id=p_run_id and lease_token=p_lease_token and outcome='running' and lease_expires_at>clock_timestamp();
 if not found then return false;end if;
 update kma_internal.managed_checkout_schedule set binding_cursor=coalesce(left(p_binding_cursor,128),binding_cursor) where singleton;
 return true;
end $$;

create function public.finish_managed_checkout_worker(p_run_id uuid,p_lease_token uuid,p_counts jsonb,p_error text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare k text; n integer; degraded boolean;
begin
 if jsonb_typeof(p_counts) is distinct from 'object' then raise exception 'Invalid worker counts' using errcode='22023';end if;
 foreach k in array array['reconciled','delivered','failed'] loop
  if jsonb_typeof(p_counts->k) is distinct from 'number' or (p_counts->>k)!~'^[0-9]{1,2}$' then raise exception 'Invalid worker counts' using errcode='22023';end if;
  n:=(p_counts->>k)::integer;if n>12 then raise exception 'Invalid worker counts' using errcode='22023';end if;
 end loop;
 perform 1 from kma_internal.managed_checkout_schedule where singleton and run_id=p_run_id for update;
 if not found then return false;end if;
 degraded := (p_counts->>'failed')::integer>0;
 update kma_internal.managed_checkout_worker_runs set finished_at=clock_timestamp(),heartbeat_at=clock_timestamp(),counts=p_counts,
 outcome=case when p_error is not null then 'failed' when degraded then 'degraded' else 'succeeded' end,
 error_code=case when p_error is null then null else 'worker_failed' end
 where id=p_run_id and lease_token=p_lease_token and outcome='running' and lease_expires_at>clock_timestamp();
 if not found then return false;end if;
 update kma_internal.managed_checkout_schedule set run_id=null,request_id=null,
 last_success_at=case when p_error is null then clock_timestamp() else last_success_at end where singleton;
 return true;
end $$;

create function kma_internal.tick_managed_checkout_schedule() returns jsonb
language plpgsql security definer set search_path='' as $$
declare s kma_internal.managed_checkout_schedule%rowtype; r kma_internal.managed_checkout_worker_runs%rowtype;
 response net._http_response%rowtype; credential text; request_number bigint; new_run uuid; code text;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('kma-managed-checkout-scheduler',0)) then return jsonb_build_object('status','locked');end if;
 select * into s from kma_internal.managed_checkout_schedule where singleton for update;
 update kma_internal.managed_checkout_schedule set last_tick_at=clock_timestamp() where singleton;
 if s.run_id is not null then
  select * into r from kma_internal.managed_checkout_worker_runs where id=s.run_id;
  if s.request_id is not null then
   select * into response from net._http_response where id=s.request_id;
   if found then code := case when response.timed_out or response.error_msg is not null then 'worker_response_unknown' else 'worker_did_not_finish' end;end if;
  end if;
  if clock_timestamp()>r.issued_at+interval '3 minutes' then code:='worker_lease_expired';end if;
  if code is not null then
   update kma_internal.managed_checkout_worker_runs set outcome='failed',error_code=code where id=r.id and outcome in('dispatched','running');
   update kma_internal.managed_checkout_schedule set enabled=false,paused_reason=code where singleton;
   return jsonb_build_object('status','paused','reason',code);
  end if;
  return jsonb_build_object('status','waiting');
 end if;
 if not s.enabled or s.paused_reason is not null then return jsonb_build_object('status','paused');end if;
 select decrypted_secret into credential from vault.decrypted_secrets where name='kma_managed_checkout_scheduler';
 if credential is null or length(credential)<32 then
  update kma_internal.managed_checkout_schedule set enabled=false,paused_reason='scheduler_credential_missing' where singleton;
  return jsonb_build_object('status','paused','reason','scheduler_credential_missing');
 end if;
 new_run:=gen_random_uuid();
 insert into kma_internal.managed_checkout_worker_runs(id,source) values(new_run,'scheduled');
 request_number:=net.http_post(
  url:='https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/managed-checkout-worker',
  body:=jsonb_build_object('run_id',new_run),
  headers:=jsonb_build_object('Content-Type','application/json','x-kma-scheduler-secret',credential),timeout_milliseconds:=80000);
 update kma_internal.managed_checkout_schedule set run_id=new_run,request_id=request_number where singleton;
 return jsonb_build_object('status','dispatched','run_id',new_run);
end $$;

-- Operator-only recovery. A stale response never releases an in-flight run.
-- Inspect the runtime/queue first, then recover this exact expired identity.
-- Recovery leaves scheduling disabled until explicitly enabled again.
create function kma_internal.recover_managed_checkout_schedule(p_run_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from kma_internal.managed_checkout_schedule s join kma_internal.managed_checkout_worker_runs r on r.id=s.run_id
 where s.singleton and not s.enabled and s.paused_reason is not null and s.run_id=p_run_id
 and r.issued_at<clock_timestamp()-interval '3 minutes' and r.lease_expires_at<clock_timestamp() for update of s;
 if not found then return false;end if;
 update kma_internal.managed_checkout_worker_runs set outcome='failed',finished_at=clock_timestamp(),error_code=coalesce(error_code,'operator_recovered') where id=p_run_id;
 update kma_internal.managed_checkout_schedule set run_id=null,request_id=null,paused_reason=null where singleton;
 return true;
end $$;

create function public.managed_checkout_scheduler_health() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
 'schedule',(select to_jsonb(s)-'request_id' from kma_internal.managed_checkout_schedule s),
 'recent_runs',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from(select id,source,issued_at,started_at,heartbeat_at,lease_expires_at,finished_at,outcome,error_code,counts from kma_internal.managed_checkout_worker_runs order by issued_at desc limit 12)r),
 'callbacks',(select jsonb_build_object('pending',count(*) filter(where state='pending'),'leased',count(*) filter(where state='leased'),'expired_leases',count(*) filter(where state='leased' and lease_expires_at<now()),'oldest_unfinished_at',min(created_at) filter(where state<>'delivered'),'retrying',count(*) filter(where state<>'delivered' and last_error is not null)) from public.managed_checkout_outbox),
 'reconciliation',(select jsonb_build_object('due',count(*) filter(where next_reconcile_at<=now()),'retrying',count(*) filter(where last_reconcile_error is not null)) from public.managed_checkout_orders),
 'attention_required',(select paused_reason is not null or(enabled and(last_tick_at is null or last_tick_at<now()-interval '3 minutes' or last_success_at is null or last_success_at<now()-interval '10 minutes')) from kma_internal.managed_checkout_schedule)
 or exists(select 1 from kma_internal.managed_checkout_worker_runs where(outcome in('failed','degraded') and issued_at>now()-interval '1 hour')or(outcome='running' and heartbeat_at<now()-interval '90 seconds'))
 or exists(select 1 from public.managed_checkout_outbox where state<>'delivered' and created_at<now()-interval '10 minutes')
 or exists(select 1 from public.managed_checkout_orders where last_reconcile_error is not null and reconcile_attempts>=3),
 'scheduler_can_create_checkouts',false,'scheduler_can_transfer_creators',false);
$$;

-- A late acknowledgement cannot commit a lease whose ownership has expired.
create or replace function public.finish_managed_checkout_delivery(p_event_id uuid,p_lease_token uuid,p_accepted boolean,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 update public.managed_checkout_outbox set state=case when p_accepted then 'delivered' else 'pending' end,
 delivered_at=case when p_accepted then clock_timestamp() else null end,
 next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,least(attempts,7)))::integer),
 last_error=case when p_accepted then null else left(p_error,200) end,lease_token=null,lease_expires_at=null
 where id=p_event_id and state='leased' and lease_token=p_lease_token and lease_expires_at>clock_timestamp();
 if not found then raise exception 'Delivery lease changed or expired' using errcode='55000';end if;
end $$;

revoke all on function public.begin_managed_checkout_worker(uuid),public.heartbeat_managed_checkout_worker(uuid,uuid,text),public.finish_managed_checkout_worker(uuid,uuid,jsonb,text),public.managed_checkout_scheduler_health() from public,anon,authenticated;
grant execute on function public.begin_managed_checkout_worker(uuid),public.heartbeat_managed_checkout_worker(uuid,uuid,text),public.finish_managed_checkout_worker(uuid,uuid,jsonb,text),public.managed_checkout_scheduler_health() to service_role;
revoke all on function kma_internal.tick_managed_checkout_schedule(),kma_internal.recover_managed_checkout_schedule(uuid) from public,anon,authenticated,service_role;
-- Add read-only managed health to the existing admin and independent alert monitor.
-- Existing legacy worker sequence, recipient and alert enablement are unchanged.
create or replace function public.processing_scheduler_health()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'schedule',(select to_jsonb(s)-'request_id' from kma_internal.processing_schedule s),
    'recent_runs',(select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from
      (select id,worker,dispatched_at,started_at,finished_at,outcome,error_code,counts,http_status
        from kma_internal.processing_stage_runs order by dispatched_at desc limit 12) r),
    'queues',(select jsonb_agg(q) from (
      select 'stripe' as worker,count(*) filter(where status='pending') as pending,
        count(*) filter(where status='processing') as processing,
        count(*) filter(where status='failed') as failed,
        count(*) filter(where status='processing' and lease_expires_at < now()) as expired_leases,
        min(updated_at) filter(where status in ('pending','processing')) as oldest_unfinished_at
        from public.provider_event_processing
      union all select 'commercial',count(*) filter(where status='pending'),
        count(*) filter(where status='processing'),count(*) filter(where status='failed'),
        count(*) filter(where status='processing' and lease_expires_at < now()),
        min(created_at) filter(where status in ('pending','processing')) from public.commercial_fact_processing
      union all select 'metrics',count(*) filter(where status='pending'),
        count(*) filter(where status='processing'),count(*) filter(where status='failed'),
        count(*) filter(where status='processing' and lease_expires_at < now()),
        min(updated_at) filter(where status in ('pending','processing')) from public.commercial_metric_refresh_queue
    ) q),
    'attention_required', (public.managed_checkout_scheduler_health()->>'attention_required')::boolean or (select not enabled or paused_reason is not null or
      last_tick_at is null or last_tick_at < now()-interval '3 minutes' or
      last_cycle_at is null or last_cycle_at < now()-interval '10 minutes'
      from kma_internal.processing_schedule)
      or exists(select 1 from kma_internal.processing_stage_runs where
        outcome in ('degraded','failed') and dispatched_at > now()-interval '1 hour')
      or exists(select 1 from public.provider_event_processing where status='failed'
        or (status in ('pending','processing') and updated_at < now()-interval '10 minutes'))
      or exists(select 1 from public.commercial_fact_processing where status='failed'
        or (status in ('pending','processing') and created_at < now()-interval '10 minutes'))
      or exists(select 1 from public.commercial_metric_refresh_queue where status='failed'
        or (status in ('pending','processing') and updated_at < now()-interval '10 minutes')),
    'managed_checkout',public.managed_checkout_scheduler_health(),
    'external_transfer_enabled',false
  );
$$;

create or replace function kma_internal.processing_health_reasons(h jsonb, recent_worker_issue boolean)
returns text[] language plpgsql stable set search_path='' as $$
declare reasons text[] := '{}'::text[]; s jsonb;
begin
  s := h->'schedule';
  if jsonb_typeof(s) is distinct from 'object' or jsonb_typeof(h->'queues') is distinct from 'array'
    or jsonb_array_length(h->'queues')<>3 or recent_worker_issue is null then
    raise exception 'processing health unavailable' using errcode='55000'; end if;
  if (s->>'enabled')::boolean is distinct from true or s->>'paused_reason' is not null then
    reasons := array_append(reasons,'scheduler_paused'); end if;
  if s->>'last_tick_at' is null or (s->>'last_tick_at')::timestamptz<now()-interval '3 minutes' then
    reasons := array_append(reasons,'heartbeat_stale'); end if;
  if s->>'last_cycle_at' is null or (s->>'last_cycle_at')::timestamptz<now()-interval '10 minutes' then
    reasons := array_append(reasons,'cycle_stale'); end if;
  if recent_worker_issue then
    reasons := array_append(reasons,'recent_worker_issue'); end if;
  if exists(select 1 from jsonb_array_elements(h->'queues') x where (x->>'failed')::bigint>0) then
    reasons := array_append(reasons,'jobs_failed'); end if;
  if exists(select 1 from jsonb_array_elements(h->'queues') x where (x->>'expired_leases')::bigint>0) then
    reasons := array_append(reasons,'leases_expired'); end if;
  if exists(select 1 from jsonb_array_elements(h->'queues') x
    where (x->>'oldest_unfinished_at')::timestamptz<now()-interval '10 minutes') then
    reasons := array_append(reasons,'jobs_stalled'); end if;
  if coalesce((h->'managed_checkout'->>'attention_required')::boolean,false) then
    reasons:=array_append(reasons,'managed_checkout_issue');end if;
  return reasons;
end $$;

create or replace function public.get_admin_processing_health()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare h jsonb; reasons text[]; s jsonb; incident jsonb; notifications jsonb;
begin
  perform public.assert_admin_password(array['owner','operations']::text[], 'view processing health');
  h:=public.processing_scheduler_health(); s:=h->'schedule';
  reasons:=kma_internal.processing_health_reasons(h,exists(select 1 from kma_internal.processing_stage_runs
    where outcome in ('degraded','failed') and dispatched_at>now()-interval '1 hour'));
  select jsonb_build_object('run_id',r.id,'worker',r.worker,'outcome',r.outcome,'dispatched_at',r.dispatched_at,
    'finished_at',r.finished_at,'error_code',r.error_code,'dispatch_http_status',r.http_status,
    'diagnostic_code',d.code,'upstream_http_status',d.upstream_http_status,'duration_ms',d.duration_ms)
    into incident from kma_internal.processing_stage_runs r left join kma_internal.processing_stage_diagnostics d on d.run_id=r.id
    where r.outcome in ('failed','degraded') order by r.dispatched_at desc,r.id desc limit 1;
  select jsonb_build_object('enabled',c.enabled,'last_checked_at',c.last_observed_at,
    'pending',(select count(*) from kma_internal.processing_alert_jobs where status in ('pending','processing')),
    'failed',(select count(*) from kma_internal.processing_alert_jobs where status='failed'),
    'last_accepted_at',(select max(accepted_at) from kma_internal.processing_alert_jobs)) into notifications
    from kma_internal.processing_alert_config c where singleton;
  return jsonb_build_object('generated_at',now(),'attention_required',cardinality(reasons)>0,'reasons',to_jsonb(reasons),
    'enabled',(s->>'enabled')::boolean,'current_worker',s->>'worker','last_tick_at',s->>'last_tick_at','last_cycle_at',s->>'last_cycle_at',
    'managed_checkout',h->'managed_checkout','queues',h->'queues','last_incident',incident,'external_alerts_configured',(notifications->>'enabled')::boolean,'notifications',notifications);
end $$;
commit;
