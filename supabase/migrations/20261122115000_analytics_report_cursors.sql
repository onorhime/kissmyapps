begin;
-- Cursors carry the actual sort values, including the ID tie-breaker. Offset remains available for older clients.
CREATE OR REPLACE FUNCTION public.analytics_people_page(p_project uuid, p_query jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  w record;
  v_search text := nullif(btrim(coalesce(p_query->>'search', '')), '');
  v_status text := coalesce(p_query->>'status', 'all');
  v_platform text := nullif(p_query->>'platform', '');
  v_country text := upper(nullif(p_query->>'country', ''));
  v_region text := nullif(p_query->>'region', '');
  v_city text := nullif(p_query->>'city', '');
  v_sort text := coalesce(p_query->>'sort', 'last_seen');
  v_desc boolean := coalesce(p_query->>'direction', 'desc') = 'desc';
  v_limit integer := greatest(1, least(coalesce((p_query->>'limit')::integer, 50), 1000));
  v_offset integer := greatest(0, coalesce((p_query->>'offset')::integer, 0));
  cursor_value jsonb := p_query->'cursor';
  v_result jsonb;
begin
  select * into w from kma_internal.analytics_window(coalesce(p_query->>'range', '30d'), v.timezone);
  if v_status not in ('all', 'online', 'new', 'returning') or v_sort not in ('last_seen', 'first_seen', 'sessions', 'events') then
    raise exception 'Unknown filter' using errcode = '22023';
  end if;
  if v_country is null and (v_region is not null or v_city is not null) then
    raise exception 'Choose a country before a region or city' using errcode = '22023';
  end if;
  with ranged as (
    select s.person_id, s.country, s.region, s.city
    from kma_internal.analytics_report_sessions(p_project, w.from_at, w.to_at) s
  ), active as (
    select r.person_id, count(*) sessions_in_range,
      bool_or(coalesce(r.country = v_country and (v_region is null or r.region = v_region)
        and (v_city is null or r.city = v_city), false)) in_place
    from ranged r group by r.person_id
  ), matched as (
    -- A search looks through everyone the project has seen; otherwise the people active in the range.
    select p.id, p.last_seen, p.first_seen, p.sessions_count, p.events_count, p.platform, p.country, p.region, p.city,
      coalesce(a.sessions_in_range, 0) sessions_in_range, a.in_place,
      exists (select 1 from public.analytics_sessions s where s.person_id = p.id and s.ended_at >= now() - interval '5 minutes') online
    from public.analytics_people p left join active a on a.person_id = p.id
    where p.project_id = p_project and (a.person_id is not null or v_search is not null)
      and (v_search is null or p.distinct_id ilike '%' || v_search || '%' or p.user_id ilike '%' || v_search || '%'
        or p.traits->>'email' ilike '%' || v_search || '%' or p.traits->>'name' ilike '%' || v_search || '%'
        or exists (select 1 from unnest(p.anonymous_ids) x where x ilike '%' || v_search || '%'))
      and (v_status <> 'new' or p.first_seen >= w.from_at)
      and (v_status <> 'returning' or p.first_seen < w.from_at)
  ), filtered as (
    select * from matched
    where (v_status <> 'online' or online)
      and (v_platform is null or platform = v_platform)
      and (v_country is null or coalesce(in_place, country = v_country and (v_region is null or region = v_region)
        and (v_city is null or city = v_city), false))
  ), places as (
    -- Where the matched people were: their sessions in the range, or a searched person's latest place.
    select r.country, r.region, r.city from ranged r join matched m on m.id = r.person_id
    union
    select m.country, m.region, m.city from matched m where m.in_place is null
  ), ordered as (
    select f.*, (case v_sort when 'last_seen' then extract(epoch from last_seen) when 'first_seen' then extract(epoch from first_seen)
      when 'sessions' then sessions_count else events_count end) * (case when v_desc then -1 else 1 end) primary_order,
      -extract(epoch from last_seen) recent_order from filtered f
  ), page_rows as materialized (
    select * from ordered where cursor_value is null or (primary_order,recent_order,id)>
      ((cursor_value->>'primary')::numeric,(cursor_value->>'recent')::numeric,(cursor_value->>'id')::uuid)
    order by primary_order,recent_order,id limit v_limit+1 offset (case when cursor_value is null then v_offset else 0 end)
  ), visible as (select * from page_rows order by primary_order,recent_order,id limit v_limit)
  select jsonb_build_object(
    'next_cursor',case when (select count(*) from page_rows)>v_limit then
      (select jsonb_build_object('primary',primary_order::text,'recent',recent_order::text,'id',id) from visible order by primary_order desc,recent_order desc,id desc limit 1) end,
    'total', (select count(*) from filtered),
    'range', jsonb_build_object('key', coalesce(p_query->>'range', '30d'), 'from', w.from_at, 'to', w.to_at),
    'facets', jsonb_build_object(
      'platforms', coalesce((select jsonb_agg(distinct platform) from matched where platform is not null), '[]'::jsonb),
      'countries', coalesce((select jsonb_agg(distinct country) from places where country is not null), '[]'::jsonb),
      'places', case when v_country is null then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('region', region, 'city', city) order by region nulls last, city nulls first) from (
          select distinct region, city from places where country = v_country and (region is not null or city is not null)
          order by 1 nulls last, 2 nulls first limit 500) t), '[]'::jsonb) end),
    'rows', coalesce((select jsonb_agg(kma_internal.analytics_person_view(p)
        || jsonb_build_object('sessions_in_range', f.sessions_in_range) order by f.primary_order,f.recent_order,f.id)
      from visible f
      join public.analytics_people p on p.id = f.id), '[]'::jsonb)
  ) into v_result;
  return v_result;
end $function$;

CREATE OR REPLACE FUNCTION public.analytics_sessions_page(p_project uuid, p_query jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  w record;
  v_platform text := nullif(p_query->>'platform', '');
  v_country text := nullif(p_query->>'country', '');
  v_person uuid := nullif(p_query->>'person_id', '')::uuid;
  v_replay boolean := coalesce((p_query->>'replay_only')::boolean, false);
  v_live boolean := coalesce((p_query->>'live_only')::boolean, false);
  v_min integer := greatest(0, coalesce((p_query->>'min_seconds')::integer, 0));
  v_bots text := coalesce(p_query->>'bots', 'exclude');
  v_search text := nullif(btrim(coalesce(p_query->>'search', '')), '');
  v_limit integer := greatest(1, least(coalesce((p_query->>'limit')::integer, 50), 1000));
  v_offset integer := greatest(0, coalesce((p_query->>'offset')::integer, 0));
  cursor_value jsonb := p_query->'cursor';
  v_result jsonb;
begin
  select * into w from kma_internal.analytics_window(coalesce(p_query->>'range', '7d'), v.timezone);
  if v_bots not in ('exclude', 'include', 'only') then
    raise exception 'Unknown filter' using errcode = '22023';
  end if;
  with matched as (
    select s.id, s.started_at, s.platform, s.country, kma_internal.analytics_session_excluded(s) excluded
    from public.analytics_sessions s join public.analytics_people p on p.id = s.person_id
    where s.project_id = p_project and s.environment = 'production'
      and s.started_at >= w.from_at and s.started_at < w.to_at
      and (v_person is null or s.person_id = v_person)
      and (not v_replay or s.replay_chunks > 0)
      and (not v_live or s.ended_at >= now() - interval '5 minutes')
      and extract(epoch from (s.ended_at - s.started_at)) >= v_min
      and (v_search is null or p.distinct_id ilike '%' || v_search || '%' or p.traits->>'email' ilike '%' || v_search || '%'
        or p.traits->>'name' ilike '%' || v_search || '%' or s.entry_screen ilike '%' || v_search || '%'
        or s.exit_screen ilike '%' || v_search || '%')
  ), botted as (
    select * from matched
    where (v_bots = 'include') or (v_bots = 'exclude' and not excluded) or (v_bots = 'only' and excluded)
  ), filtered as (
    select * from botted where (v_platform is null or platform = v_platform) and (v_country is null or country = v_country)
  ), page_rows as materialized (
    select * from filtered where cursor_value is null or started_at<(cursor_value->>'at')::timestamptz
      or (started_at=(cursor_value->>'at')::timestamptz and id>(cursor_value->>'id')::uuid)
    order by started_at desc,id limit v_limit+1 offset (case when cursor_value is null then v_offset else 0 end)
  ), visible as (select * from page_rows order by started_at desc,id limit v_limit)
  select jsonb_build_object(
    'next_cursor',case when (select count(*) from page_rows)>v_limit then
      (select jsonb_build_object('at',started_at,'id',id) from visible order by started_at,id desc limit 1) end,
    'total', (select count(*) from filtered),
    'range', jsonb_build_object('key', coalesce(p_query->>'range', '7d'), 'from', w.from_at, 'to', w.to_at),
    'facets', jsonb_build_object(
      'platforms', coalesce((select jsonb_agg(distinct platform) from botted), '[]'::jsonb),
      'countries', coalesce((select jsonb_agg(distinct country) from botted where country is not null), '[]'::jsonb)),
    'rows', coalesce((select jsonb_agg(kma_internal.analytics_session_view(s)
        || jsonb_build_object('distinct_id', p.distinct_id, 'user_id', p.user_id, 'traits', p.traits) order by s.started_at desc, s.id)
      from visible f
      join public.analytics_sessions s on s.id = f.id
      join public.analytics_people p on p.id = s.person_id), '[]'::jsonb)
  ) into v_result;
  return v_result;
end $function$;
commit;
