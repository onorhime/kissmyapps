-- Independent notification outbox. Disabled until separately approved setup.
-- No customer data, worker retries, payment writes, or credentials in history.
begin;
create table kma_internal.processing_alert_config (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  recipient_email text check(recipient_email ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$' and length(recipient_email)<=254),
  sender text not null default 'KissMyApps Operations <partners@send.kissmyapps.dev>',
  last_observed_at timestamptz,
  healthy_since timestamptz,
  check(not enabled or recipient_email is not null)
);
insert into kma_internal.processing_alert_config default values;
create table kma_internal.processing_alert_incidents (
  id uuid primary key default gen_random_uuid(),
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  reasons text[] not null
);
create unique index processing_alert_one_open on kma_internal.processing_alert_incidents((true)) where resolved_at is null;
create table kma_internal.processing_alert_jobs (
  id uuid primary key default gen_random_uuid(),
  sequence_number bigint generated always as identity,
  incident_id uuid references kma_internal.processing_alert_incidents(id),
  kind text not null check(kind in ('failure','recovery','test')),
  recipient_email text not null,
  reasons text[] not null default '{}',
  observed_at timestamptz not null default now(),
  status text not null default 'pending' check(status in ('pending','processing','accepted','failed','cancelled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  lease_until timestamptz,
  claim_token uuid,
  envelope jsonb,
  provider_id text,
  last_error text,
  accepted_at timestamptz,
  check((kind='test' and incident_id is null) or (kind<>'test' and incident_id is not null)),
  unique nulls not distinct(incident_id,kind)
);
create index processing_alert_jobs_pending on kma_internal.processing_alert_jobs(next_attempt_at) where status in ('pending','processing');
revoke all on kma_internal.processing_alert_config,kma_internal.processing_alert_incidents,kma_internal.processing_alert_jobs from public,anon,authenticated,service_role;
alter table kma_internal.processing_alert_config enable row level security;
alter table kma_internal.processing_alert_incidents enable row level security;
alter table kma_internal.processing_alert_jobs enable row level security;

-- Private factor permits deterministic rollback tests without altering workers.
create function kma_internal.observe_processing_alerts(h jsonb,recent_issue boolean)
returns void language plpgsql security definer set search_path='' as $$
declare c kma_internal.processing_alert_config%rowtype; incident uuid; reasons text[];
begin
  select * into c from kma_internal.processing_alert_config where singleton for update;
  if not c.enabled then return; end if;
  reasons:=kma_internal.processing_health_reasons(h,recent_issue);
  update kma_internal.processing_alert_config set last_observed_at=now() where singleton;
  select id into incident from kma_internal.processing_alert_incidents where resolved_at is null;
  if cardinality(reasons)>0 then
    update kma_internal.processing_alert_config set healthy_since=null where singleton;
    if incident is null then
      insert into kma_internal.processing_alert_incidents(reasons) values(reasons) returning id into incident;
      insert into kma_internal.processing_alert_jobs(incident_id,kind,recipient_email,reasons)
        values(incident,'failure',c.recipient_email,reasons);
    end if;
  elsif incident is not null then
    update kma_internal.processing_alert_config set healthy_since=coalesce(healthy_since,now()) where singleton;
    if c.healthy_since<=now()-interval '2 minutes' and exists(
      select 1 from kma_internal.processing_alert_incidents where id=incident
        and (h#>>'{schedule,last_cycle_at}')::timestamptz>opened_at) then
      update kma_internal.processing_alert_incidents set resolved_at=now() where id=incident;
      insert into kma_internal.processing_alert_jobs(incident_id,kind,recipient_email)
        values(incident,'recovery',c.recipient_email);
      update kma_internal.processing_alert_config set healthy_since=null where singleton;
    end if;
  end if;
end $$;
revoke all on function kma_internal.observe_processing_alerts(jsonb,boolean) from public,anon,authenticated,service_role;

create function public.claim_processing_alert_job()
returns jsonb language plpgsql security definer set search_path='' as $$
declare c kma_internal.processing_alert_config%rowtype; j kma_internal.processing_alert_jobs%rowtype;
begin
  select * into c from kma_internal.processing_alert_config where singleton for update;
  if not c.enabled then return '[]'::jsonb; end if;
  perform kma_internal.observe_processing_alerts(public.processing_scheduler_health(),exists(
    select 1 from kma_internal.processing_stage_runs where outcome in ('degraded','failed')
      and dispatched_at>now()-interval '1 hour'));
  update kma_internal.processing_alert_jobs set status='cancelled',last_error='recipient_changed'
    where status in ('pending','processing') and (lease_until is null or lease_until<now())
      and recipient_email is distinct from c.recipient_email;
  -- Stop well before Resend's 24-hour deduplication window expires.
  update kma_internal.processing_alert_jobs set status='failed',last_error='retry_window_exhausted'
    where status in ('pending','processing') and (lease_until is null or lease_until<now())
      and (attempts>=8 or first_attempt_at<now()-interval '20 hours');
  -- Serialize logical sends, so recovery cannot overtake a leased failure email.
  if exists(select 1 from kma_internal.processing_alert_jobs where status='processing' and lease_until>=now()) then
    return '[]'::jsonb; end if;
  select * into j from kma_internal.processing_alert_jobs
    where status in ('pending','processing')
    order by observed_at,sequence_number limit 1 for update;
  if j.id is null or j.next_attempt_at>now() then return '[]'::jsonb; end if;
  update kma_internal.processing_alert_jobs set status='processing',attempts=attempts+1,
    first_attempt_at=coalesce(first_attempt_at,now()),lease_until=now()+interval '2 minutes',claim_token=gen_random_uuid()
    where id=j.id returning * into j;
  return jsonb_build_array(jsonb_build_object('id',j.id,'claimToken',j.claim_token,'kind',j.kind,
    'to',j.recipient_email,'from',c.sender,'reasons',to_jsonb(j.reasons),'observedAt',j.observed_at,'envelope',j.envelope));
end $$;
revoke all on function public.claim_processing_alert_job() from public,anon,authenticated;
grant execute on function public.claim_processing_alert_job() to service_role;

create function public.seal_processing_alert_job(p_id uuid,p_claim_token uuid,p_envelope jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j kma_internal.processing_alert_jobs%rowtype; c kma_internal.processing_alert_config%rowtype;
begin
  select * into c from kma_internal.processing_alert_config where singleton for update;
  select * into j from kma_internal.processing_alert_jobs where id=p_id for update;
  if not c.enabled or j.id is null or j.status<>'processing' or j.claim_token is distinct from p_claim_token
    or j.lease_until<now() or j.recipient_email is distinct from c.recipient_email then
    raise exception 'invalid alert claim' using errcode='P0001'; end if;
  if j.envelope is not null then return j.envelope; end if;
  if jsonb_typeof(p_envelope) is distinct from 'object'
    or not public.stripe_json_has_exact_keys(p_envelope,array['from','to','subject','html'],array['from','to','subject','html'])
    or p_envelope->>'to' is distinct from j.recipient_email or p_envelope->>'from' is distinct from c.sender
    or jsonb_typeof(p_envelope->'subject') is distinct from 'string'
    or jsonb_typeof(p_envelope->'html') is distinct from 'string' or octet_length(p_envelope::text)>32768 then
    raise exception 'invalid alert envelope' using errcode='22023'; end if;
  update kma_internal.processing_alert_jobs set envelope=p_envelope where id=j.id;
  return p_envelope;
end $$;
revoke all on function public.seal_processing_alert_job(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.seal_processing_alert_job(uuid,uuid,jsonb) to service_role;

create function public.finish_processing_alert_job(p_id uuid,p_claim_token uuid,p_provider_id text default null,p_error text default null,p_retryable boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
declare j kma_internal.processing_alert_jobs%rowtype;
begin
  select * into j from kma_internal.processing_alert_jobs where id=p_id for update;
  if j.id is null or j.status<>'processing' or j.claim_token is distinct from p_claim_token or j.lease_until<now() then return false; end if;
  if p_provider_id is not null then
    if p_error is not null or j.envelope is null or p_provider_id !~ '^[A-Za-z0-9_-]{1,160}$' then
      raise exception 'invalid alert receipt' using errcode='22023'; end if;
    update kma_internal.processing_alert_jobs set status='accepted',provider_id=p_provider_id,accepted_at=now(),
      lease_until=null,claim_token=null,last_error=null where id=j.id;
  else
    if p_error is null or p_error !~ '^(envelope_unavailable|provider_unavailable|invalid_provider_receipt|provider_http_[1-5][0-9]{2})$' then
      raise exception 'invalid alert failure' using errcode='22023'; end if;
    update kma_internal.processing_alert_jobs set
      status=case when coalesce(p_retryable,false) and attempts<8 and first_attempt_at>now()-interval '20 hours' then 'pending' else 'failed' end,
      next_attempt_at=now()+make_interval(mins=>least(60,power(2,j.attempts)::integer)),
      lease_until=null,claim_token=null,last_error=p_error where id=j.id;
  end if;
  return true;
end $$;
revoke all on function public.finish_processing_alert_job(uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.finish_processing_alert_job(uuid,uuid,text,text,boolean) to service_role;

create function kma_internal.dispatch_processing_alerts()
returns void language plpgsql security definer set search_path='' as $$
declare credential text;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('kma-processing-alert-dispatch',0)) then return; end if;
  if not exists(select 1 from kma_internal.processing_alert_config where singleton and enabled) then return; end if;
  select decrypted_secret into credential from vault.decrypted_secrets where name='kma_processing_alerts';
  if credential is null or length(credential)<32 then raise exception 'alert credential unavailable'; end if;
  perform net.http_post(url:='https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/processing-alerts',
    headers:=jsonb_build_object('Content-Type','application/json','x-kma-alert-secret',credential),
    body:='{}'::jsonb,timeout_milliseconds:=40000);
end $$;
revoke all on function kma_internal.dispatch_processing_alerts() from public,anon,authenticated,service_role;

-- Extend only the new Admin read model, preserving the private scheduler RPC.
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
    'queues',h->'queues','last_incident',incident,'external_alerts_configured',(notifications->>'enabled')::boolean,'notifications',notifications);
end $$;
revoke all on function public.get_admin_processing_health() from public,anon,service_role;
grant execute on function public.get_admin_processing_health() to authenticated;
commit;
