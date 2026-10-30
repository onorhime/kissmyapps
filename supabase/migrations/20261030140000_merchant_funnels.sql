-- Merchant analytics funnels: named step-by-step conversions per project. A report is
-- calculated from the stored events when it is read, so a new funnel covers past
-- visits too. Every workspace member can create funnels: they are reports, not
-- settings.
begin;

create table public.analytics_funnels (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  -- Checked by kma_internal.analytics_funnel_steps before every write.
  steps jsonb not null check (jsonb_typeof(steps) = 'array'),
  window_seconds integer not null check (window_seconds in (1800, 3600, 86400, 604800, 2592000)),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index analytics_funnels_project on public.analytics_funnels(project_id, created_at);

alter table public.analytics_funnels enable row level security;
revoke all on public.analytics_funnels from public, anon, authenticated;
grant all on public.analytics_funnels to service_role;

-- Steps -----------------------------------------------------------------------------

-- Checks a funnel's steps and returns them in their stored shape. A step is an event,
-- or a page or app screen matched by its address, with an optional property filter.
create function kma_internal.analytics_funnel_steps(p_steps jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_step jsonb;
  v_out jsonb := '[]'::jsonb;
  v_kind text;
  v_event text;
  v_match text;
  v_value text;
  v_label text;
  v_property text;
  v_wanted text;
begin
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) not between 2 and 10 then
    raise exception 'A funnel needs 2 to 10 steps' using errcode = '22023';
  end if;
  for v_step in select value from jsonb_array_elements(p_steps) loop
    if jsonb_typeof(v_step) <> 'object' then
      raise exception 'Each step is an event or a page' using errcode = '22023';
    end if;
    v_kind := v_step->>'kind';
    v_event := null;
    v_match := null;
    v_value := null;
    v_property := null;
    v_wanted := null;
    v_label := nullif(btrim(coalesce(v_step->>'label', '')), '');
    if length(v_label) > 80 then
      raise exception 'A step name can be up to 80 characters' using errcode = '22023';
    end if;
    if v_kind = 'event' then
      v_event := btrim(coalesce(v_step->>'event', ''));
      if v_event !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$' then
        raise exception 'Choose an event for every event step' using errcode = '22023';
      end if;
    elsif v_kind = 'screen' then
      v_match := coalesce(v_step->>'match', 'is');
      v_value := btrim(coalesce(v_step->>'value', ''));
      if v_match not in ('is', 'starts_with', 'contains') then
        raise exception 'A page step matches an address that is, starts with or contains a value' using errcode = '22023';
      end if;
      if length(v_value) not between 1 and 300 then
        raise exception 'Enter the page or screen for every page step' using errcode = '22023';
      end if;
    else
      raise exception 'Each step is an event or a page' using errcode = '22023';
    end if;
    if jsonb_typeof(v_step->'filter') = 'object' then
      v_property := btrim(coalesce(v_step#>>'{filter,property}', ''));
      v_wanted := coalesce(v_step#>>'{filter,value}', '');
      if length(v_property) not between 1 and 100 or length(v_wanted) not between 1 and 200 then
        raise exception 'A step filter needs a property and a value' using errcode = '22023';
      end if;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'kind', v_kind, 'event', v_event, 'match', v_match, 'value', v_value, 'label', v_label,
      'filter', case when v_property is not null then jsonb_build_object('property', v_property, 'value', v_wanted) end
    )));
  end loop;
  return v_out;
end $$;

create function kma_internal.analytics_funnel_window(p_seconds jsonb) returns integer
language plpgsql immutable set search_path = '' as $$
declare v_seconds integer;
begin
  if jsonb_typeof(p_seconds) = 'number' then
    v_seconds := (p_seconds #>> '{}')::numeric::integer;
  end if;
  if v_seconds is null or v_seconds not in (1800, 3600, 86400, 604800, 2592000) then
    raise exception 'Choose 30 minutes, 1 hour, 1 day, 7 days or 30 days to finish' using errcode = '22023';
  end if;
  return v_seconds;
end $$;

-- The event names a step can match, so lookups can use the name index.
create function kma_internal.analytics_step_names(p_step jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select case p_step->>'kind' when 'event' then array[p_step->>'event'] else array['page_viewed', 'screen_viewed'] end
$$;

-- Addresses compare without case and without a trailing slash.
create function kma_internal.analytics_screen_key(p_screen text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(lower(p_screen), '(.)/+$', '\1')
$$;

create function kma_internal.analytics_step_matches(p_step jsonb, p_name text, p_screen text, p_properties jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case p_step->>'kind'
      when 'event' then p_name = p_step->>'event'
      when 'screen' then p_name in ('page_viewed', 'screen_viewed') and p_screen is not null and case p_step->>'match'
        when 'is' then kma_internal.analytics_screen_key(p_screen) = kma_internal.analytics_screen_key(p_step->>'value')
        when 'starts_with' then starts_with(lower(p_screen), lower(p_step->>'value'))
        else strpos(lower(p_screen), lower(p_step->>'value')) > 0 end
      else false end
    and (p_step->'filter' is null or p_properties->>(p_step#>>'{filter,property}') = p_step#>>'{filter,value}')
$$;

-- For every person whose first step 1 falls in [p_from, p_to): how far they went, in
-- order, within the window from that step 1, with the time and session of each step.
-- Bot sessions and blocked people are left out, as in every other report.
create function kma_internal.analytics_funnel_walk(
  p_project uuid, p_steps jsonb, p_window interval, p_from timestamptz, p_to timestamptz
) returns table (person_id uuid, reached integer, times timestamptz[], sessions uuid[])
language sql stable set search_path = '' as $$
  with recursive entry as (
    select distinct on (e.person_id) e.person_id, e.occurred_at, e.id, e.session_id
    from public.analytics_events e
    left join public.analytics_sessions s on s.id = e.session_id
    where e.project_id = p_project and e.environment = 'production'
      and e.name = any(kma_internal.analytics_step_names(p_steps->0))
      and e.occurred_at >= p_from and e.occurred_at < p_to
      and kma_internal.analytics_step_matches(p_steps->0, e.name, e.screen, e.properties)
      and (s.id is null or not kma_internal.analytics_session_excluded(s))
      and not exists (
        select 1 from public.analytics_bot_overrides o
        where o.project_id = p_project and o.verdict = 'bot' and o.person_id = e.person_id
      )
    order by e.person_id, e.occurred_at, e.id
  ), walk as (
    select f.person_id, 1 as step, f.occurred_at as at, f.id as event_id, f.occurred_at as started_at,
      array[f.occurred_at] as times, array[f.session_id] as sessions
    from entry f
    union all
    select w.person_id, w.step + 1, n.occurred_at, n.id, w.started_at, w.times || n.occurred_at, w.sessions || n.session_id
    from walk w
    cross join lateral (
      select e.occurred_at, e.id, e.session_id
      from public.analytics_events e
      left join public.analytics_sessions s on s.id = e.session_id
      where e.person_id = w.person_id and e.project_id = p_project and e.environment = 'production'
        and e.name = any(kma_internal.analytics_step_names(p_steps->w.step))
        and (e.occurred_at, e.id) > (w.at, w.event_id) and e.occurred_at <= w.started_at + p_window
        and kma_internal.analytics_step_matches(p_steps->w.step, e.name, e.screen, e.properties)
        and (s.id is null or not kma_internal.analytics_session_excluded(s))
      order by e.occurred_at, e.id
      limit 1
    ) n
    where w.step < jsonb_array_length(p_steps)
  )
  select distinct on (walk.person_id) walk.person_id, walk.step, walk.times, walk.sessions
  from walk order by walk.person_id, walk.step desc
$$;

-- The group a person falls in for a breakdown, from the session where they started.
create function kma_internal.analytics_funnel_group(p_breakdown text, s public.analytics_sessions) returns text
language sql stable set search_path = '' as $$
  select case p_breakdown
    when 'country' then coalesce(s.country, 'Unknown')
    when 'device' then coalesce(s.device_type, 'Unknown')
    when 'platform' then coalesce(s.platform, 'server')
    when 'browser' then coalesce(s.browser, case when s.platform in ('ios', 'android') then 'App' else 'Unknown' end)
    when 'source' then coalesce(s.utm_source, nullif(substring(s.referrer from '^[a-z]+://(?:www\.)?([^/:?#]+)'), ''), 'Direct')
    else 'all' end
$$;

-- Saved funnels ------------------------------------------------------------------------

create function kma_internal.analytics_funnel_view(f public.analytics_funnels) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', f.id, 'name', f.name, 'steps', f.steps, 'window_seconds', f.window_seconds,
    'created_at', f.created_at, 'updated_at', f.updated_at,
    'created_by', (select coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), u.email) from auth.users u where u.id = f.created_by)
  )
$$;

create function public.analytics_funnels(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_project(p_project);
  return coalesce((
    select jsonb_agg(kma_internal.analytics_funnel_view(f) order by f.created_at, f.id)
    from public.analytics_funnels f where f.project_id = p_project
  ), '[]'::jsonb);
end $$;

-- Creates a funnel, or replaces the name, steps and window of an existing one.
create function public.analytics_save_funnel(
  p_project uuid, p_funnel uuid, p_name text, p_steps jsonb, p_window_seconds integer
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_steps jsonb;
  v_window integer;
  v_name text := btrim(coalesce(p_name, ''));
  f public.analytics_funnels;
begin
  perform kma_internal.analytics_require_project(p_project);
  if length(v_name) not between 1 and 80 then
    raise exception 'Name the funnel in up to 80 characters' using errcode = '22023';
  end if;
  v_steps := kma_internal.analytics_funnel_steps(p_steps);
  v_window := kma_internal.analytics_funnel_window(to_jsonb(p_window_seconds));
  if p_funnel is null then
    perform pg_advisory_xact_lock(hashtextextended('analytics-funnels:' || p_project::text, 0));
    if (select count(*) from public.analytics_funnels where project_id = p_project) >= 100 then
      raise exception 'A project can keep up to 100 funnels' using errcode = '22023';
    end if;
    insert into public.analytics_funnels(project_id, name, steps, window_seconds, created_by)
    values (p_project, v_name, v_steps, v_window, auth.uid())
    returning * into f;
  else
    update public.analytics_funnels
    set name = v_name, steps = v_steps, window_seconds = v_window, updated_at = now()
    where id = p_funnel and project_id = p_project
    returning * into f;
    if f.id is null then
      raise exception 'Funnel not found' using errcode = 'P0002';
    end if;
  end if;
  return kma_internal.analytics_funnel_view(f);
end $$;

create function public.analytics_delete_funnel(p_funnel uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_project uuid;
begin
  select project_id into v_project from public.analytics_funnels where id = p_funnel;
  if v_project is null then
    raise exception 'Funnel not found' using errcode = 'P0002';
  end if;
  perform kma_internal.analytics_require_project(v_project);
  delete from public.analytics_funnels where id = p_funnel;
  return jsonb_build_object('deleted', p_funnel);
end $$;

-- What the step picker offers: the project's events, its most visited pages and
-- screens, and the common properties of each event with their frequent values.
create function public.analytics_funnel_options(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  v_since timestamptz := now() - interval '30 days';
begin
  return jsonb_build_object(
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('name', d.name, 'description', d.description, 'last_seen', d.last_seen)
        order by d.last_seen desc, d.name)
      from public.analytics_event_definitions d
      where d.project_id = v.id and d.status = 'live'), '[]'::jsonb),
    'screens', coalesce((
      select jsonb_agg(jsonb_build_object('screen', screen, 'users', users) order by users desc, screen)
      from (
        select e.screen, count(distinct e.person_id) users
        from public.analytics_events e
        where e.project_id = v.id and e.environment = 'production' and e.name in ('page_viewed', 'screen_viewed')
          and e.occurred_at >= v_since and e.screen is not null
        group by e.screen order by count(distinct e.person_id) desc, e.screen limit 50) t), '[]'::jsonb),
    'properties', coalesce((
      select jsonb_object_agg(name, props)
      from (
        select n.name, (
          select coalesce(jsonb_agg(jsonb_build_object('key', k, 'values', vals) order by seen desc, k), '[]'::jsonb)
          from (
            select kv.key k, count(*) seen, (
              select jsonb_agg(val order by c desc, val) from (
                select r2.properties->>kv.key val, count(*) c
                from (select e2.properties from public.analytics_events e2
                  where e2.project_id = v.id and e2.name = n.name and e2.occurred_at >= v_since
                  order by e2.occurred_at desc limit 300) r2
                where r2.properties ? kv.key and jsonb_typeof(r2.properties->kv.key) in ('string', 'number', 'boolean')
                group by 1 order by count(*) desc, 1 limit 8) vv) vals
            from (select e.properties from public.analytics_events e
              where e.project_id = v.id and e.name = n.name and e.occurred_at >= v_since
              order by e.occurred_at desc limit 300) r, jsonb_each(r.properties) kv
            where jsonb_typeof(kv.value) in ('string', 'number', 'boolean')
            group by kv.key order by count(*) desc, kv.key limit 15) keys) props
        from (
          select d.name from public.analytics_event_definitions d
          where d.project_id = v.id and d.status = 'live' and d.last_seen >= v_since
          order by d.last_seen desc limit 40) n) per_event
      where jsonb_array_length(props) > 0), '{}'::jsonb)
  );
end $$;

-- Reports ------------------------------------------------------------------------------

-- Conversion through a funnel definition ({steps, window_seconds}), saved or not, for
-- people who did step 1 within the range.
create function public.analytics_funnel_report(
  p_project uuid, p_definition jsonb, p_range text, p_breakdown text default 'none'
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  v_steps jsonb := kma_internal.analytics_funnel_steps(p_definition->'steps');
  v_window integer := kma_internal.analytics_funnel_window(p_definition->'window_seconds');
  v_n integer;
  w record;
begin
  if p_breakdown not in ('none', 'country', 'device', 'platform', 'browser', 'source') then
    raise exception 'Unknown breakdown' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(v_steps);
  select * into w from kma_internal.analytics_window(p_range, v.timezone);
  return (
    with walk as (
      select * from kma_internal.analytics_funnel_walk(p_project, v_steps, make_interval(secs => v_window), w.from_at, w.to_at)
    ), grouped as (
      select wk.*, kma_internal.analytics_funnel_group(p_breakdown, s) as grp
      from walk wk left join public.analytics_sessions s on s.id = wk.sessions[1]
    ), per_step as (
      select k,
        count(*) filter (where g.reached >= k) as people,
        percentile_cont(0.5) within group (order by extract(epoch from g.times[k] - g.times[k - 1]))
          filter (where k > 1 and g.reached >= k) as median_seconds
      from generate_series(1, v_n) k cross join grouped g
      group by k
    ), top_groups as (
      select grp, count(*) starters from grouped group by grp order by count(*) desc, grp limit 10
    )
    select jsonb_build_object(
      'range', jsonb_build_object('key', p_range, 'from', w.from_at, 'to', w.to_at, 'bucket', w.bucket, 'timezone', v.timezone),
      'window_seconds', v_window,
      'steps', coalesce((
        select jsonb_agg(jsonb_build_object(
          'index', p.k, 'step', v_steps->(p.k - 1), 'people', p.people,
          'from_start', case when first.people > 0 then round(p.people::numeric / first.people, 4) end,
          'from_previous', case when p.k > 1 and prev.people > 0 then round(p.people::numeric / prev.people, 4) end,
          'dropped', case when p.k < v_n then p.people - coalesce(nxt.people, 0) end,
          'median_seconds', round(p.median_seconds::numeric)
        ) order by p.k)
        from per_step p
        join per_step first on first.k = 1
        left join per_step prev on prev.k = p.k - 1
        left join per_step nxt on nxt.k = p.k + 1), '[]'::jsonb),
      'started', (select count(*) from grouped),
      'converted', (select count(*) from grouped where reached = v_n),
      'series', coalesce((
        select jsonb_agg(jsonb_build_object(
          'start', b.bucket_start, 'partial', b.bucket_end > now(),
          'started', (select count(*) from grouped g where g.times[1] >= b.bucket_start and g.times[1] < b.bucket_end),
          'converted', (select count(*) from grouped g where g.reached = v_n and g.times[1] >= b.bucket_start and g.times[1] < b.bucket_end)
        ) order by b.bucket_start)
        from kma_internal.analytics_buckets(p_range, v.timezone) b), '[]'::jsonb),
      'breakdown', case when p_breakdown = 'none' then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object(
          'key', t.grp,
          'steps', (select jsonb_agg((select count(*) from grouped g where g.grp = t.grp and g.reached >= k) order by k)
            from generate_series(1, v_n) k)
        ) order by t.starters desc, t.grp)
        from top_groups t), '[]'::jsonb) end,
      'other_groups', case when p_breakdown = 'none' then 0 else
        (select count(distinct grp) from grouped) - (select count(*) from top_groups) end
    )
  );
end $$;

-- The people behind one bar of a funnel: those who reached a step ('reached'), or who
-- reached it and went no further ('dropped'). Each comes with the session of that step.
create function public.analytics_funnel_people(
  p_project uuid, p_definition jsonb, p_range text, p_step integer, p_outcome text,
  p_breakdown text default 'none', p_group text default null, p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  v_steps jsonb := kma_internal.analytics_funnel_steps(p_definition->'steps');
  v_window integer := kma_internal.analytics_funnel_window(p_definition->'window_seconds');
  v_n integer;
  w record;
begin
  v_n := jsonb_array_length(v_steps);
  if p_step is null or p_step not between 1 and v_n or p_outcome not in ('reached', 'dropped')
    or (p_outcome = 'dropped' and p_step = v_n) then
    raise exception 'Choose a step and whether people reached it or dropped after it' using errcode = '22023';
  end if;
  if p_breakdown not in ('none', 'country', 'device', 'platform', 'browser', 'source') then
    raise exception 'Unknown breakdown' using errcode = '22023';
  end if;
  select * into w from kma_internal.analytics_window(p_range, v.timezone);
  return (
    with walk as (
      select * from kma_internal.analytics_funnel_walk(p_project, v_steps, make_interval(secs => v_window), w.from_at, w.to_at)
    ), chosen as (
      select wk.* from walk wk
      left join public.analytics_sessions s on s.id = wk.sessions[1]
      where (case p_outcome when 'reached' then wk.reached >= p_step else wk.reached = p_step end)
        and (p_group is null or kma_internal.analytics_funnel_group(p_breakdown, s) = p_group)
    )
    select jsonb_build_object(
      'total', (select count(*) from chosen),
      'people', coalesce((
        select jsonb_agg(row_data order by (row_data->>'at') desc)
        from (
          select jsonb_build_object(
            'id', p.id, 'distinct_id', p.distinct_id, 'user_id', p.user_id, 'traits', p.traits,
            'country', p.country, 'city', p.city, 'platform', p.platform, 'device_type', p.device_type,
            'last_seen', p.last_seen, 'at', c.times[p_step], 'session_id', c.sessions[p_step],
            'replay', coalesce(s.replay_chunks > 0, false)
          ) row_data
          from chosen c
          join public.analytics_people p on p.id = c.person_id
          left join public.analytics_sessions s on s.id = c.sessions[p_step]
          order by c.times[p_step] desc, p.id
          offset greatest(coalesce(p_offset, 0), 0) limit 50) t), '[]'::jsonb)
    )
  );
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'analytics_funnels(uuid)', 'analytics_save_funnel(uuid,uuid,text,jsonb,integer)', 'analytics_delete_funnel(uuid)',
    'analytics_funnel_options(uuid)', 'analytics_funnel_report(uuid,jsonb,text,text)',
    'analytics_funnel_people(uuid,jsonb,text,integer,text,text,text,integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
