-- Disabled-by-default sequential scheduler. Provision its dedicated credential
-- in Vault + Edge secrets separately; no credentials or cron jobs in history.
begin;

create table kma_internal.processing_schedule (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  paused_reason text,
  worker text not null default 'stripe-worker'
    check (worker in ('stripe-worker','commercial-worker','metrics-worker')),
  run_id uuid,
  request_id bigint,
  dispatched_at timestamptz,
  last_tick_at timestamptz,
  last_cycle_at timestamptz,
  check ((run_id is null and request_id is null and dispatched_at is null)
    or (run_id is not null and request_id is not null and dispatched_at is not null))
);
insert into kma_internal.processing_schedule default values;

create table kma_internal.processing_stage_runs (
  id uuid primary key,
  worker text not null check (worker in ('stripe-worker','commercial-worker','metrics-worker')),
  dispatched_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  outcome text not null default 'dispatched'
    check (outcome in ('dispatched','running','succeeded','degraded','failed')),
  error_code text,
  counts jsonb,
  http_status integer
);
create index processing_stage_runs_recent on kma_internal.processing_stage_runs(dispatched_at desc);
alter table kma_internal.processing_schedule add foreign key(run_id)
  references kma_internal.processing_stage_runs(id);
revoke all on kma_internal.processing_schedule, kma_internal.processing_stage_runs
  from public, anon, authenticated, service_role;

create function public.begin_processing_stage(p_run_id uuid, p_worker text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare s kma_internal.processing_schedule%rowtype;
begin
  select * into s from kma_internal.processing_schedule where singleton for update;
  if not s.enabled or s.paused_reason is not null or s.run_id is distinct from p_run_id
    or s.worker is distinct from p_worker or s.dispatched_at < now()-interval '3 minutes'
    then return false; end if;
  update kma_internal.processing_stage_runs set outcome='running', started_at=now()
    where id=p_run_id and worker=p_worker and outcome='dispatched';
  return found;
end $$;
revoke all on function public.begin_processing_stage(uuid,text) from public, anon, authenticated;
grant execute on function public.begin_processing_stage(uuid,text) to service_role;

-- Factored response handling is independently testable without issuing HTTP.
-- Never accept arbitrary next-stage input or persist raw HTTP response bodies.
create function kma_internal.finish_processing_stage(
  p_run_id uuid, p_status integer, p_body jsonb, p_transport_failed boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  s kma_internal.processing_schedule%rowtype;
  r kma_internal.processing_stage_runs%rowtype;
  code text;
  k text;
  run_counts jsonb := '{}'::jsonb;
  n integer;
  degraded boolean;
begin
  select * into s from kma_internal.processing_schedule where singleton for update;
  if s.run_id is distinct from p_run_id or p_run_id is null then return false; end if;
  select * into r from kma_internal.processing_stage_runs where id=p_run_id;
  if r.outcome not in ('dispatched','running') then return false; end if;
  if p_transport_failed then code := 'worker_response_unknown';
  elsif p_status is distinct from 200 then code := 'worker_http_failure';
  elsif r.outcome <> 'running' or jsonb_typeof(p_body) is distinct from 'object'
    or p_body->>'run_id' is distinct from p_run_id::text
    or p_body->>'worker' is distinct from s.worker
    or p_body->>'status' is distinct from 'processed'
    then code := 'invalid_worker_response';
  else
    foreach k in array array['claimed','processed','retried','failed','deferred'] loop
      if jsonb_typeof(p_body->k) is distinct from 'number'
        or (p_body->>k) !~ '^[0-9]{1,2}$' then code := 'invalid_worker_counts'; exit; end if;
      n := (p_body->>k)::integer;
      if n > 25 then code := 'invalid_worker_counts'; exit; end if;
      run_counts := run_counts || jsonb_build_object(k,n);
    end loop;
    if code is null and (run_counts->>'claimed')::integer <>
      (run_counts->>'processed')::integer + (run_counts->>'retried')::integer +
      (run_counts->>'failed')::integer + (run_counts->>'deferred')::integer
      then code := 'invalid_worker_counts'; end if;
  end if;
  if code is not null then
    update kma_internal.processing_stage_runs set outcome='failed',error_code=code,
      finished_at=now(),http_status=p_status where id=p_run_id;
    -- Do not release the in-flight identity on ambiguity. A human must inspect
    -- leases/runtime before clearing it; no automatic overlapping restart.
    update kma_internal.processing_schedule set enabled=false,paused_reason=code where singleton;
    raise warning 'KMA processing paused: %',code;
    return false;
  end if;
  degraded := (run_counts->>'retried')::integer + (run_counts->>'failed')::integer +
    (run_counts->>'deferred')::integer > 0;
  update kma_internal.processing_stage_runs set outcome=case when degraded then 'degraded' else 'succeeded' end,
    finished_at=now(),http_status=p_status,counts=run_counts where id=p_run_id;
  update kma_internal.processing_schedule set
    worker=case s.worker when 'stripe-worker' then 'commercial-worker'
      when 'commercial-worker' then 'metrics-worker' else 'stripe-worker' end,
    last_cycle_at=case when s.worker='metrics-worker' then now() else last_cycle_at end,
    run_id=null,request_id=null,dispatched_at=null where singleton;
  if degraded then raise warning 'KMA processing items require attention: %',s.worker; end if;
  return true;
end $$;
revoke all on function kma_internal.finish_processing_stage(uuid,integer,jsonb,boolean)
  from public,anon,authenticated,service_role;

create function kma_internal.tick_processing_schedule()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s kma_internal.processing_schedule%rowtype;
  response net._http_response%rowtype;
  body jsonb;
  credential text;
  new_run uuid;
  request_number bigint;
  completed boolean;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('kma-processing-scheduler',0)) then
    return jsonb_build_object('status','locked');
  end if;
  select * into s from kma_internal.processing_schedule where singleton for update;
  update kma_internal.processing_schedule set last_tick_at=now() where singleton;
  if not s.enabled or s.paused_reason is not null then
    return jsonb_build_object('status','paused');
  end if;
  if s.run_id is not null then
    select * into response from net._http_response where id=s.request_id;
    if not found then
      if now()-s.dispatched_at > interval '3 minutes' then
        perform kma_internal.finish_processing_stage(s.run_id,null,null,true);
        return jsonb_build_object('status','paused');
      end if;
      return jsonb_build_object('status','waiting');
    end if;
    begin
      if octet_length(response.content) <= 4096 then body := response.content::jsonb; end if;
    exception when others then body := null;
    end;
    completed := kma_internal.finish_processing_stage(s.run_id,response.status_code,body,
      coalesce(response.timed_out,false) or response.error_msg is not null);
    if not completed then return jsonb_build_object('status','paused'); end if;
    select * into s from kma_internal.processing_schedule where singleton;
  end if;
  select decrypted_secret into credential from vault.decrypted_secrets
    where name='kma_processing_scheduler';
  if credential is null or length(credential) < 32 then
    update kma_internal.processing_schedule set enabled=false,paused_reason='scheduler_credential_missing' where singleton;
    raise warning 'KMA processing paused: scheduler_credential_missing';
    return jsonb_build_object('status','paused');
  end if;
  new_run := gen_random_uuid();
  insert into kma_internal.processing_stage_runs(id,worker) values(new_run,s.worker);
  request_number := net.http_post(
    url := 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/processing-dispatch',
    body := jsonb_build_object('worker',s.worker,'run_id',new_run),
    headers := jsonb_build_object('Content-Type','application/json','x-kma-scheduler-secret',credential),
    timeout_milliseconds := 100000
  );
  update kma_internal.processing_schedule set run_id=new_run,request_id=request_number,dispatched_at=now()
    where singleton;
  return jsonb_build_object('status','dispatched','worker',s.worker,'run_id',new_run);
end $$;
revoke all on function kma_internal.tick_processing_schedule() from public,anon,authenticated,service_role;

create function public.processing_scheduler_health()
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
    'attention_required', (select not enabled or paused_reason is not null or
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
    'external_transfer_enabled',false
  );
$$;
revoke all on function public.processing_scheduler_health() from public,anon,authenticated;
grant execute on function public.processing_scheduler_health() to service_role;
commit;
