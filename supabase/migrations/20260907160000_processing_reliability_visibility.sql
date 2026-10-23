-- Read-only Admin health and write-once, allowlisted dispatch diagnostics.
-- No schedules, credentials, financial facts, retries or recipients are changed.
begin;

create table kma_internal.processing_stage_diagnostics (
  run_id uuid primary key references kma_internal.processing_stage_runs(id),
  code text not null check (code in ('worker_http_failure','worker_transport_failure','worker_response_invalid')),
  upstream_http_status integer check (upstream_http_status between 100 and 599),
  duration_ms integer not null check (duration_ms between 0 and 180000),
  recorded_at timestamptz not null default now(),
  check ((code='worker_transport_failure' and upstream_http_status is null)
    or (code='worker_http_failure' and upstream_http_status is not null and upstream_http_status<>200)
    or (code='worker_response_invalid' and upstream_http_status is not null and upstream_http_status=200))
);
revoke all on kma_internal.processing_stage_diagnostics from public,anon,authenticated,service_role;

create function public.record_processing_stage_diagnostic(p_diagnostic jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare s kma_internal.processing_schedule%rowtype; run uuid; status_value integer;
begin
  if jsonb_typeof(p_diagnostic) is distinct from 'object'
    or not public.stripe_json_has_exact_keys(p_diagnostic,
      array['run_id','worker','code','upstream_http_status','duration_ms'],
      array['run_id','worker','code','upstream_http_status','duration_ms'])
    or coalesce(p_diagnostic->>'run_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    or coalesce(p_diagnostic->>'code','') not in ('worker_http_failure','worker_transport_failure','worker_response_invalid')
    or jsonb_typeof(p_diagnostic->'duration_ms') is distinct from 'number'
    or (p_diagnostic->>'duration_ms') !~ '^[0-9]{1,6}$'
    or (p_diagnostic->>'duration_ms')::integer>180000
    or (p_diagnostic->'upstream_http_status'<>'null'::jsonb and
      (jsonb_typeof(p_diagnostic->'upstream_http_status') is distinct from 'number'
       or (p_diagnostic->>'upstream_http_status') !~ '^[1-5][0-9]{2}$'))
    then raise exception 'invalid processing diagnostic' using errcode='22023'; end if;
  run := (p_diagnostic->>'run_id')::uuid;
  status_value := (p_diagnostic->>'upstream_http_status')::integer;
  select * into s from kma_internal.processing_schedule where singleton for update;
  if s.run_id is distinct from run or s.worker is distinct from p_diagnostic->>'worker'
    or not exists(select 1 from kma_internal.processing_stage_runs r
      where r.id=run and r.worker=s.worker and r.outcome='running') then return false; end if;
  insert into kma_internal.processing_stage_diagnostics(run_id,code,upstream_http_status,duration_ms)
    values(run,p_diagnostic->>'code',status_value,(p_diagnostic->>'duration_ms')::integer)
    on conflict(run_id) do nothing;
  return found;
end $$;
revoke all on function public.record_processing_stage_diagnostic(jsonb) from public,anon,authenticated;
grant execute on function public.record_processing_stage_diagnostic(jsonb) to service_role;

create function kma_internal.processing_health_reasons(h jsonb, recent_worker_issue boolean)
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
  return reasons;
end $$;
revoke all on function kma_internal.processing_health_reasons(jsonb,boolean) from public,anon,authenticated,service_role;

create function public.get_admin_processing_health()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare h jsonb; reasons text[]; s jsonb; incident jsonb;
begin
  perform public.assert_admin_password(array['owner','operations']::text[], 'view processing health');
  h := public.processing_scheduler_health(); s := h->'schedule';
  reasons := kma_internal.processing_health_reasons(h,exists(
    select 1 from kma_internal.processing_stage_runs where outcome in ('degraded','failed')
      and dispatched_at>now()-interval '1 hour'));
  select jsonb_build_object('run_id',r.id,'worker',r.worker,'outcome',r.outcome,
    'dispatched_at',r.dispatched_at,'finished_at',r.finished_at,'error_code',r.error_code,
    'dispatch_http_status',r.http_status,'diagnostic_code',d.code,
    'upstream_http_status',d.upstream_http_status,'duration_ms',d.duration_ms)
    into incident from kma_internal.processing_stage_runs r
    left join kma_internal.processing_stage_diagnostics d on d.run_id=r.id
    where r.outcome in ('failed','degraded') order by r.dispatched_at desc,r.id desc limit 1;
  return jsonb_build_object('generated_at',now(),'attention_required',cardinality(reasons)>0,
    'reasons',to_jsonb(reasons),'enabled',(s->>'enabled')::boolean,
    'current_worker',s->>'worker','last_tick_at',s->>'last_tick_at','last_cycle_at',s->>'last_cycle_at',
    'queues',h->'queues','last_incident',incident,'external_alerts_configured',false);
end $$;
revoke all on function public.get_admin_processing_health() from public,anon,service_role;
grant execute on function public.get_admin_processing_health() to authenticated;

commit;
