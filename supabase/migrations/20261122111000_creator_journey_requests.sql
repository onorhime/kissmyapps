begin;

-- Merchants can hand a saved behavioral report to the operator who owns the
-- commercial journey. A completed handoff references a published version.
create table kma_internal.creator_journey_requests (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.analytics_funnels on delete set null,
  program_id uuid not null references public.affiliate_programs on delete cascade,
  funnel_id uuid not null references public.funnels on delete cascade,
  source_name text not null,
  steps jsonb not null,
  window_seconds integer not null,
  requested_by uuid references auth.users on delete set null,
  requested_at timestamptz not null default now(),
  environment text not null check(environment in ('test','live')),
  outcome text not null default 'pending' check(outcome in ('pending','published','changes_requested')),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users on delete set null,
  response text,
  published_version integer,
  foreign key(funnel_id,published_version) references public.funnel_journey_definition_versions(funnel_id,version)
);
create unique index creator_journey_request_open on kma_internal.creator_journey_requests(source_id) where outcome='pending';
create index creator_journey_request_queue on kma_internal.creator_journey_requests(requested_at desc,id desc);
revoke all on kma_internal.creator_journey_requests from public,anon,authenticated,service_role;

create function public.workspace_request_journey(p_source uuid,p_environment text) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  source public.analytics_funnels;
  pr public.analytics_projects;
  program public.affiliate_programs;
  request_id uuid;
begin
  select * into strict source from public.analytics_funnels where id=p_source;
  pr:=kma_internal.analytics_require_project(source.project_id,'admin');
  program:=kma_internal.program_of(pr.workspace_id);
  if program.funnel_id is null then raise exception 'Publish an affiliate program before requesting a creator journey' using errcode='22023'; end if;
  if coalesce(p_environment,'') not in ('test','live') then raise exception 'Choose Test or Live' using errcode='22023'; end if;
  insert into kma_internal.creator_journey_requests(source_id,program_id,funnel_id,source_name,steps,window_seconds,requested_by,environment)
    values(source.id,program.id,program.funnel_id,source.name,source.steps,source.window_seconds,auth.uid(),p_environment)
    on conflict do nothing returning id into request_id;
  if request_id is null then select id into strict request_id from kma_internal.creator_journey_requests where source_id=p_source and outcome='pending'; end if;
  return request_id;
end $$;

create function public.admin_review_creator_journey(p_request uuid,p_outcome text,p_response text) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  r kma_internal.creator_journey_requests;
  version_number integer;
begin
  perform public.assert_admin_password(array['owner','operations']::text[],'review creator journeys');
  if coalesce(p_outcome,'') not in ('published','changes_requested') or coalesce(length(trim(p_response)),0) not between 5 and 1000 then
    raise exception 'Choose an outcome and explain the decision' using errcode='22023';
  end if;
  select * into strict r from kma_internal.creator_journey_requests where id=p_request for update;
  if r.outcome=p_outcome and r.response=trim(p_response) then return r.id; end if;
  if r.outcome<>'pending' then raise exception 'This request has been reviewed' using errcode='22023'; end if;
  if p_outcome='published' then
    select v.version into version_number from public.funnel_journey_definition_versions v
    join public.funnel_journey_configuration c on c.funnel_id=v.funnel_id
    where v.funnel_id=r.funnel_id and v.archived_at is null and v.published_at>=r.requested_at and c.environment=r.environment;
    if version_number is null then raise exception 'Publish the requested journey in the selected environment first' using errcode='22023'; end if;
  end if;
  update kma_internal.creator_journey_requests set outcome=p_outcome,response=trim(p_response),reviewed_at=now(),reviewed_by=auth.uid(),published_version=version_number where id=r.id;
  insert into kma_internal.program_notices(workspace_id,reference,label)
    select p.workspace_id,r.id,'Creator journey · '||r.source_name||' · '||replace(p_outcome,'_',' ') from public.affiliate_programs p where p.id=r.program_id;
  return r.id;
end $$;

create function public.creator_journey_requests_page(p_source uuid,p_before_at timestamptz,p_before_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare project uuid;
begin
  if p_source is null then perform public.assert_admin_password(array['owner','operations']::text[],'review creator journeys');
  else
    select project_id into strict project from public.analytics_funnels where id=p_source;
    perform kma_internal.analytics_require_project(project);
  end if;
  return (with page as materialized (
    select r.id,r.source_name,r.requested_at,r.environment,r.outcome,r.steps,r.window_seconds,r.response,r.published_version,r.funnel_id,p.name program
    from kma_internal.creator_journey_requests r join public.affiliate_programs p on p.id=r.program_id
    where (p_source is null or r.source_id=p_source) and (p_before_at is null or (r.requested_at,r.id)<(p_before_at,p_before_id))
    order by r.requested_at desc,r.id desc limit 51
  ), visible as(select * from page order by requested_at desc,id desc limit 50)
  select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(v) order by requested_at desc,id desc) from visible v),'[]'::jsonb),'more',(select count(*)>50 from page)));
end $$;
revoke all on function public.workspace_request_journey(uuid,text),public.admin_review_creator_journey(uuid,text,text),public.creator_journey_requests_page(uuid,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.workspace_request_journey(uuid,text),public.admin_review_creator_journey(uuid,text,text),public.creator_journey_requests_page(uuid,timestamptz,uuid) to authenticated;

commit;
