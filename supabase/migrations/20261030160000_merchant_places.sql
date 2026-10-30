-- City-level places. The events relay on the VPS looks each visitor's address up in
-- DB-IP's city database, so sessions now arrive with a region and city as well as a
-- country. This keeps a place whole as it is stored, lets the Overview open a country
-- into its regions and cities, and lets the Users list be filtered by region or city.
begin;

create or replace function kma_internal.analytics_resolve_person(
  p_project uuid, p_environment text, p_user_id text, p_anonymous_id text, p_at timestamptz,
  p_context jsonb, p_geo jsonb, p_traits jsonb
) returns uuid language plpgsql volatile set search_path = '' as $$
declare
  v_user_person uuid;
  v_anon_person uuid;
  v_person uuid;
  v_distinct text := coalesce(p_user_id, p_anonymous_id);
begin
  if v_distinct is null then
    raise exception 'Each event needs a user ID or an anonymous ID' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('analytics-person:' || p_project::text || ':' || v_distinct, 0));
  if p_user_id is not null then
    select id into v_user_person from public.analytics_people where project_id = p_project and distinct_id = p_user_id;
    if p_anonymous_id is not null then
      select id into v_anon_person from public.analytics_people
      where project_id = p_project and distinct_id = p_anonymous_id and user_id is null;
    end if;
    if v_user_person is null and v_anon_person is not null then
      -- First identify on this device: the anonymous person becomes the user.
      update public.analytics_people
      set distinct_id = p_user_id, user_id = p_user_id,
          anonymous_ids = (select array_agg(distinct a) from unnest(anonymous_ids || p_anonymous_id) a)
      where id = v_anon_person;
      v_user_person := v_anon_person;
    elsif v_user_person is not null and v_anon_person is not null and v_anon_person <> v_user_person then
      -- The user was already known from another device: fold this device's history in.
      update public.analytics_sessions set person_id = v_user_person where person_id = v_anon_person;
      update public.analytics_events set person_id = v_user_person where person_id = v_anon_person;
      delete from public.analytics_bot_overrides o
      where o.person_id = v_anon_person
        and exists (select 1 from public.analytics_bot_overrides x where x.person_id = v_user_person);
      update public.analytics_bot_overrides set person_id = v_user_person where person_id = v_anon_person;
      update public.analytics_people u
      set first_seen = least(u.first_seen, a.first_seen),
          last_seen = greatest(u.last_seen, a.last_seen),
          sessions_count = u.sessions_count + a.sessions_count,
          events_count = u.events_count + a.events_count,
          anonymous_ids = (select array_agg(distinct x) from unnest(u.anonymous_ids || a.anonymous_ids || p_anonymous_id) x),
          traits = a.traits || u.traits,
          environment = case when 'production' in (u.environment, a.environment) then 'production' else 'development' end,
          initial_referrer = case when a.first_seen < u.first_seen then a.initial_referrer else u.initial_referrer end,
          initial_utm_source = case when a.first_seen < u.first_seen then a.initial_utm_source else u.initial_utm_source end,
          initial_utm_medium = case when a.first_seen < u.first_seen then a.initial_utm_medium else u.initial_utm_medium end,
          initial_utm_campaign = case when a.first_seen < u.first_seen then a.initial_utm_campaign else u.initial_utm_campaign end,
          initial_landing = case when a.first_seen < u.first_seen then a.initial_landing else u.initial_landing end
      from public.analytics_people a
      where u.id = v_user_person and a.id = v_anon_person;
      delete from public.analytics_people where id = v_anon_person;
    end if;
    v_person := v_user_person;
  else
    -- An anonymous ID that was later identified still belongs to that user.
    select id into v_person from public.analytics_people
    where project_id = p_project and (distinct_id = p_anonymous_id or anonymous_ids @> array[p_anonymous_id])
    order by (distinct_id = p_anonymous_id) desc limit 1;
  end if;

  if v_person is null then
    insert into public.analytics_people(
      project_id, distinct_id, user_id, anonymous_ids, environment, first_seen, last_seen,
      initial_referrer, initial_utm_source, initial_utm_medium, initial_utm_campaign, initial_landing
    ) values (
      p_project, v_distinct, p_user_id,
      case when p_anonymous_id is not null then array[p_anonymous_id] else '{}' end,
      p_environment, p_at, p_at,
      kma_internal.analytics_text(p_context->'referrer', 500),
      kma_internal.analytics_text(p_context#>'{utm,source}'),
      kma_internal.analytics_text(p_context#>'{utm,medium}'),
      kma_internal.analytics_text(p_context#>'{utm,campaign}'),
      kma_internal.analytics_text(p_context->'page_path', 500)
    )
    on conflict (project_id, distinct_id) do update set last_seen = public.analytics_people.last_seen
    returning id into v_person;
  end if;

  update public.analytics_people p set
    last_seen = greatest(p.last_seen, p_at),
    first_seen = least(p.first_seen, p_at),
    environment = case when p_environment = 'production' then 'production' else p.environment end,
    anonymous_ids = case
      when p_anonymous_id is null or p_anonymous_id = any(p.anonymous_ids) or cardinality(p.anonymous_ids) >= 20 then p.anonymous_ids
      else p.anonymous_ids || p_anonymous_id end,
    traits = case when p_traits is not null and jsonb_typeof(p_traits) = 'object' then p.traits || p_traits else p.traits end
  where p.id = v_person;

  -- Latest known device and place, only when this is the newest thing we heard.
  if p_context is not null then
    update public.analytics_people p set
      platform = coalesce(kma_internal.analytics_text(p_context->'platform', 20), p.platform),
      -- A place is one thing: a new city brings its own region, and a new country without
      -- a city (say, from the time zone) drops the old country's region and city.
      country = coalesce(p_geo->>'country', p.country),
      region = case when p_geo->>'country' is null or (p_geo->>'city' is null and p_geo->>'country' = p.country)
        then p.region else p_geo->>'region' end,
      city = case when p_geo->>'country' is null or (p_geo->>'city' is null and p_geo->>'country' = p.country)
        then p.city else p_geo->>'city' end,
      timezone = coalesce(kma_internal.analytics_text(p_context->'timezone', 64), p.timezone),
      language = coalesce(kma_internal.analytics_text(p_context->'language', 35), p.language),
      device_type = coalesce(kma_internal.analytics_text(p_context->'device_type', 20), p.device_type),
      device_model = coalesce(kma_internal.analytics_text(p_context->'device_model', 80), p.device_model),
      os_name = coalesce(kma_internal.analytics_text(p_context->'os_name', 40), p.os_name),
      os_version = coalesce(kma_internal.analytics_text(p_context->'os_version', 40), p.os_version),
      browser = coalesce(kma_internal.analytics_text(p_context->'browser', 40), p.browser),
      browser_version = coalesce(kma_internal.analytics_text(p_context->'browser_version', 40), p.browser_version),
      app_version = coalesce(kma_internal.analytics_text(p_context->'app_version', 40), p.app_version),
      sdk = coalesce(kma_internal.analytics_text(p_context->'sdk', 60), p.sdk),
      screen_width = coalesce(kma_internal.analytics_int(p_context->'screen_width'), p.screen_width),
      screen_height = coalesce(kma_internal.analytics_int(p_context->'screen_height'), p.screen_height)
    where p.id = v_person and p.last_seen <= p_at;
  end if;
  return v_person;
end $$;

create or replace function kma_internal.analytics_touch_session(
  p_project uuid, p_environment text, p_person uuid, p_session_key text, p_started_at timestamptz,
  p_at timestamptz, p_context jsonb, p_geo jsonb, p_ip_hash text, p_user_agent text
) returns uuid language plpgsql volatile set search_path = '' as $$
declare
  v_session uuid;
  v_inserted boolean;
begin
  insert into public.analytics_sessions(
    project_id, person_id, session_key, environment, started_at, ended_at, platform,
    country, region, city, location_source, timezone, language, device_type, device_model, os_name, os_version,
    browser, browser_version, app_version, sdk, screen_width, screen_height, network, carrier, user_agent, ip_hash,
    referrer, utm_source, utm_medium, utm_campaign, landing, interactions, webdriver
  ) values (
    p_project, p_person, p_session_key, p_environment, least(coalesce(p_started_at, p_at), p_at), p_at,
    coalesce(kma_internal.analytics_text(p_context->'platform', 20), 'web'),
    p_geo->>'country', p_geo->>'region', p_geo->>'city', p_geo->>'source',
    kma_internal.analytics_text(p_context->'timezone', 64),
    kma_internal.analytics_text(p_context->'language', 35),
    kma_internal.analytics_text(p_context->'device_type', 20),
    kma_internal.analytics_text(p_context->'device_model', 80),
    kma_internal.analytics_text(p_context->'os_name', 40),
    kma_internal.analytics_text(p_context->'os_version', 40),
    kma_internal.analytics_text(p_context->'browser', 40),
    kma_internal.analytics_text(p_context->'browser_version', 40),
    kma_internal.analytics_text(p_context->'app_version', 40),
    kma_internal.analytics_text(p_context->'sdk', 60),
    kma_internal.analytics_int(p_context->'screen_width'),
    kma_internal.analytics_int(p_context->'screen_height'),
    kma_internal.analytics_text(p_context->'network', 20),
    kma_internal.analytics_text(p_context->'carrier', 60),
    left(p_user_agent, 400), p_ip_hash,
    kma_internal.analytics_text(p_context->'referrer', 500),
    kma_internal.analytics_text(p_context#>'{utm,source}'),
    kma_internal.analytics_text(p_context#>'{utm,medium}'),
    kma_internal.analytics_text(p_context#>'{utm,campaign}'),
    kma_internal.analytics_text(p_context->'page_path', 500),
    coalesce(kma_internal.analytics_int(p_context->'interactions'), 0),
    coalesce((p_context->>'webdriver')::boolean, false)
  )
  on conflict (project_id, session_key) do update set
    ended_at = greatest(public.analytics_sessions.ended_at, excluded.ended_at),
    started_at = least(public.analytics_sessions.started_at, excluded.started_at),
    person_id = excluded.person_id,
    environment = case when excluded.environment = 'production' then 'production' else public.analytics_sessions.environment end,
    interactions = greatest(public.analytics_sessions.interactions, excluded.interactions),
    webdriver = public.analytics_sessions.webdriver or excluded.webdriver,
    app_version = coalesce(excluded.app_version, public.analytics_sessions.app_version),
    -- A session keeps its first place, unless a later event knows more: a place where it
    -- had none, or a city where it had only a country. The place moves as a whole.
    country = case when (public.analytics_sessions.country is null and excluded.country is not null)
      or (public.analytics_sessions.city is null and excluded.city is not null)
      then excluded.country else public.analytics_sessions.country end,
    region = case when (public.analytics_sessions.country is null and excluded.country is not null)
      or (public.analytics_sessions.city is null and excluded.city is not null)
      then excluded.region else public.analytics_sessions.region end,
    city = case when (public.analytics_sessions.country is null and excluded.country is not null)
      or (public.analytics_sessions.city is null and excluded.city is not null)
      then excluded.city else public.analytics_sessions.city end,
    location_source = case when (public.analytics_sessions.country is null and excluded.country is not null)
      or (public.analytics_sessions.city is null and excluded.city is not null)
      then excluded.location_source else public.analytics_sessions.location_source end,
    ip_hash = coalesce(public.analytics_sessions.ip_hash, excluded.ip_hash)
  returning id, (xmax = 0) into v_session, v_inserted;
  if v_inserted then
    update public.analytics_people set sessions_count = sessions_count + 1 where id = p_person;
  end if;
  return v_session;
end $$;


-- Where the people in a range were: the countries' regions and cities, or the cities
-- everywhere when no country is given. People count once per place they had a session in,
-- like the Overview's countries, so a country's regions can add up to more than it.
create function public.analytics_places(p_project uuid, p_range text, p_country text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  w record;
  v_country text := upper(nullif(btrim(p_country), ''));
  v_result jsonb;
begin
  if v_country is not null and v_country !~ '^[A-Z]{2}$' then
    raise exception 'Choose a country by its two-letter code' using errcode = '22023';
  end if;
  select * into w from kma_internal.analytics_window(p_range, v.timezone);
  with s as (
    select x.person_id, x.country, x.region, x.city
    from kma_internal.analytics_report_sessions(p_project, w.from_at, w.to_at) x
    where v_country is null or x.country = v_country
  )
  select jsonb_build_object(
    'range', jsonb_build_object('key', p_range, 'from', w.from_at, 'to', w.to_at),
    'country', v_country,
    'users', (select count(distinct person_id) from s where country is not null),
    -- People none of whose sessions there had a known region or city.
    'unknown_region', (select count(*) from (select person_id from s where country is not null
      group by 1 having bool_and(region is null)) t),
    'unknown_city', (select count(*) from (select person_id from s where country is not null
      group by 1 having bool_and(city is null)) t),
    'regions', case when v_country is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('key', k, 'users', n) order by n desc, k) from (
        select region k, count(distinct person_id) n from s where region is not null
        group by 1 order by 2 desc, 1 limit 100) t), '[]'::jsonb) end,
    'cities', coalesce((
      select jsonb_agg(jsonb_build_object('key', k, 'region', r, 'country', c, 'users', n) order by n desc, k, r) from (
        select city k, region r, country c, count(distinct person_id) n from s where city is not null
        group by 1, 2, 3 order by 4 desc, 1, 2 limit 100) t), '[]'::jsonb)
  ) into v_result;
  return v_result;
end $$;

-- The Users list, now filtered by the places people's sessions in the range were in (as
-- the Overview counts them), down to a region or city. Someone found by a search who was
-- not active in the range is matched by their latest place instead.
create or replace function public.analytics_people_page(p_project uuid, p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
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
  )
  select jsonb_build_object(
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
        || jsonb_build_object('sessions_in_range', f.sessions_in_range) order by f.ord)
      from (select id, sessions_in_range, row_number() over (order by
        case when v_sort = 'last_seen' and v_desc then last_seen end desc nulls last,
        case when v_sort = 'last_seen' and not v_desc then last_seen end asc nulls last,
        case when v_sort = 'first_seen' and v_desc then first_seen end desc nulls last,
        case when v_sort = 'first_seen' and not v_desc then first_seen end asc nulls last,
        case when v_sort = 'sessions' and v_desc then sessions_count end desc nulls last,
        case when v_sort = 'sessions' and not v_desc then sessions_count end asc nulls last,
        case when v_sort = 'events' and v_desc then events_count end desc nulls last,
        case when v_sort = 'events' and not v_desc then events_count end asc nulls last,
        last_seen desc, id) ord
        from filtered order by ord limit v_limit offset v_offset) f
      join public.analytics_people p on p.id = f.id), '[]'::jsonb)
  ) into v_result;
  return v_result;
end $$;

revoke all on function public.analytics_places(uuid, text, text) from public, anon;
grant execute on function public.analytics_places(uuid, text, text) to authenticated;

commit;
