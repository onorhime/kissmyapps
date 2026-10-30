-- Merchant analytics retention: of the people who started in a period, how many came
-- back in each period after it. Worked out from the stored events when read, in the
-- project's time zone, without bots or development data, like every other report.
begin;

-- Checks a retention definition and returns it in its stored shape. It counts by day, week
-- or month; people start when first seen or at their first matching event; and they come
-- back with any activity or a matching event. A matching event is a funnel step.
create function kma_internal.analytics_retention_definition(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_interval text;
  v_start jsonb;
  v_return jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'Choose when people start and what counts as coming back' using errcode = '22023';
  end if;
  v_interval := coalesce(p->>'interval', 'day');
  if v_interval not in ('day', 'week', 'month') then
    raise exception 'Count retention by day, week or month' using errcode = '22023';
  end if;
  v_start := coalesce(p->'start', '{"kind":"first_seen"}');
  v_return := coalesce(p->'return', '{"kind":"any"}');
  -- A single step is checked as a two-step funnel of itself.
  v_start := case when v_start->>'kind' = 'first_seen' then '{"kind":"first_seen"}'::jsonb
    else kma_internal.analytics_funnel_steps(jsonb_build_array(v_start, v_start))->0 end;
  v_return := case when v_return->>'kind' = 'any' then '{"kind":"any"}'::jsonb
    else kma_internal.analytics_funnel_steps(jsonb_build_array(v_return, v_return))->0 end;
  return jsonb_build_object('interval', v_interval, 'start', v_start, 'return', v_return);
end $$;

create function kma_internal.analytics_period_start(p_interval text, p_date date) returns date
language sql immutable set search_path = '' as $$
  select date_trunc(p_interval, p_date::timestamp)::date
$$;

-- How many days, weeks (from Monday) or calendar months p_to is after p_from.
create function kma_internal.analytics_period_index(p_interval text, p_from date, p_to date) returns integer
language sql immutable set search_path = '' as $$
  select case p_interval
    when 'day' then p_to - p_from
    when 'week' then (kma_internal.analytics_period_start('week', p_to) - kma_internal.analytics_period_start('week', p_from)) / 7
    else (extract(year from p_to)::integer - extract(year from p_from)::integer) * 12
      + extract(month from p_to)::integer - extract(month from p_from)::integer end
$$;

-- Everyone who started in [p_from, p_to): when, the local date, and the later local dates
-- on which they came back.
create function kma_internal.analytics_retention_walk(
  p_project uuid, p_definition jsonb, p_from timestamptz, p_to timestamptz, p_timezone text
) returns table (person_id uuid, started_at timestamptz, start_date date, returns date[])
language sql stable set search_path = '' as $$
  with excluded as (
    select s.id from public.analytics_sessions s
    where s.project_id = p_project and s.ended_at >= p_from and kma_internal.analytics_session_excluded(s)
  ), bots as (
    select o.person_id from public.analytics_bot_overrides o
    where o.project_id = p_project and o.verdict = 'bot' and o.person_id is not null
  ), activity as (
    select e.person_id, e.occurred_at, (e.occurred_at at time zone p_timezone)::date as day, e.name, e.screen, e.properties
    from public.analytics_events e
    where e.project_id = p_project and e.environment = 'production' and e.occurred_at >= p_from
      and (e.session_id is null or e.session_id not in (select id from excluded))
      and e.person_id not in (select person_id from bots)
  ), starters as (
    select p.id as person_id, p.first_seen as started_at
    from public.analytics_people p
    where p_definition#>>'{start,kind}' = 'first_seen' and p.project_id = p_project and p.environment = 'production'
      and p.first_seen >= p_from and p.first_seen < p_to
      and p.id in (select a.person_id from activity a)
    union all
    select a.person_id, min(a.occurred_at)
    from activity a
    where p_definition#>>'{start,kind}' <> 'first_seen' and a.occurred_at < p_to
      and a.name = any(kma_internal.analytics_step_names(p_definition->'start'))
      and kma_internal.analytics_step_matches(p_definition->'start', a.name, a.screen, a.properties)
    group by a.person_id
  ), came_back as (
    select st.person_id, array_agg(distinct a.day order by a.day) as days
    from starters st
    join activity a on a.person_id = st.person_id and a.day > (st.started_at at time zone p_timezone)::date
    where p_definition#>>'{return,kind}' = 'any'
      or (a.name = any(kma_internal.analytics_step_names(p_definition->'return'))
        and kma_internal.analytics_step_matches(p_definition->'return', a.name, a.screen, a.properties))
    group by st.person_id
  )
  select st.person_id, st.started_at, (st.started_at at time zone p_timezone)::date, coalesce(cb.days, '{}')
  from starters st left join came_back cb on cb.person_id = st.person_id
$$;

-- The group a person falls in for a breakdown, from where they were first seen.
create function kma_internal.analytics_person_group(p_breakdown text, p public.analytics_people) returns text
language sql stable set search_path = '' as $$
  select case p_breakdown
    when 'country' then coalesce(p.country, 'Unknown')
    when 'device' then coalesce(p.device_type, 'Unknown')
    when 'platform' then coalesce(p.platform, 'server')
    when 'browser' then coalesce(p.browser, case when p.platform in ('ios', 'android') then 'App' else 'Unknown' end)
    when 'source' then coalesce(p.initial_utm_source, nullif(substring(p.initial_referrer from '^[a-z]+://(?:www\.)?([^/:?#]+)'), ''), 'Direct')
    else 'all' end
$$;

-- The cohort table's shape for an interval: how many periods it follows, the first cohort,
-- and the window its people are read from (at least 60 days, enough for the day 30 figure).
create function kma_internal.analytics_retention_frame(p_interval text, p_timezone text)
returns table (periods integer, today date, current_period date, first_cohort date, read_from timestamptz)
language sql stable set search_path = '' as $$
  with t as (
    select (now() at time zone p_timezone)::date as today,
      case p_interval when 'day' then 14 when 'week' then 8 else 6 end as periods
  ), f as (
    select t.*, kma_internal.analytics_period_start(p_interval, t.today) as current_period,
      kma_internal.analytics_period_start(p_interval,
        (t.today - make_interval(days => case p_interval when 'day' then t.periods else 0 end,
          weeks => case p_interval when 'week' then t.periods else 0 end,
          months => case p_interval when 'month' then t.periods else 0 end))::date) as first_cohort
    from t
  )
  select f.periods, f.today, f.current_period, f.first_cohort,
    (least(f.first_cohort, f.today - 60)::timestamp at time zone p_timezone)
  from f
$$;

-- Retention for a definition ({interval, start, return}): a table of cohorts by the period
-- people started in, with how many came back in each later period; the same averaged into
-- a curve; day 1, 7 and 30 over the people who reached that day in the last 30 days; and a
-- breakdown.
create function public.analytics_retention_report(p_project uuid, p_definition jsonb, p_breakdown text default 'none')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  v_def jsonb := kma_internal.analytics_retention_definition(p_definition);
  v_interval text := v_def->>'interval';
  f record;
begin
  if p_breakdown not in ('none', 'country', 'device', 'platform', 'browser', 'source') then
    raise exception 'Unknown breakdown' using errcode = '22023';
  end if;
  select * into f from kma_internal.analytics_retention_frame(v_interval, v.timezone);
  return (
    with walk as (
      select w.*, kma_internal.analytics_period_start(v_interval, w.start_date) as cohort,
        array(select distinct kma_internal.analytics_period_index(v_interval, w.start_date, d) from unnest(w.returns) d) as came_back
      from kma_internal.analytics_retention_walk(p_project, v_def, f.read_from, now(), v.timezone) w
    ), tbl as (
      -- elapsed: how many periods of this cohort have started, so period k is complete when k < elapsed.
      select wk.*, kma_internal.analytics_period_index(v_interval, wk.cohort, f.current_period) as elapsed,
        case when p_breakdown = 'none' then 'all' else kma_internal.analytics_person_group(p_breakdown, p) end as grp
      from walk wk join public.analytics_people p on p.id = wk.person_id
      where wk.cohort >= f.first_cohort
    ), cohorts as (
      select kma_internal.analytics_period_start(v_interval, d::date) as cohort
      from generate_series(f.first_cohort, f.current_period,
        case v_interval when 'day' then interval '1 day' when 'week' then interval '1 week' else interval '1 month' end) d
    ), top_groups as (
      select grp, count(*) as people from tbl group by grp order by count(*) desc, grp limit 10
    )
    select jsonb_build_object(
      'definition', v_def,
      'timezone', v.timezone,
      'today', f.today,
      'periods', f.periods,
      'started', (select count(*) from tbl),
      -- Day n counts the people whose day n fell in the last 30 finished days, so every one of
      -- them has had the time, and day 7 matches the overview's figure.
      'headline', (
        select jsonb_agg(jsonb_build_object(
          'day', n,
          'people', (select count(*) from walk w where w.start_date + n between f.today - 30 and f.today - 1),
          'returned', (select count(*) from walk w where w.start_date + n between f.today - 30 and f.today - 1
            and (w.start_date + n) = any(w.returns))
        ) order by n)
        from unnest(array[1, 7, 30]) n),
      'cohorts', (
        select jsonb_agg(jsonb_build_object(
          'start', c.cohort,
          'people', (select count(*) from tbl t where t.cohort = c.cohort),
          'values', (
            select jsonb_agg(jsonb_build_object(
              'period', k,
              'state', case when k < e.elapsed then 'complete' when k = e.elapsed then 'partial' else 'future' end,
              'people', case when k <= e.elapsed then (select count(*) from tbl t where t.cohort = c.cohort and k = any(t.came_back)) end
            ) order by k)
            from generate_series(1, f.periods) k)
        ) order by c.cohort)
        from cohorts c
        cross join lateral (select kma_internal.analytics_period_index(v_interval, c.cohort, f.current_period) as elapsed) e),
      'curve', (
        select jsonb_agg(jsonb_build_object(
          'period', k,
          'people', (select count(*) from tbl t where k < t.elapsed),
          'returned', (select count(*) from tbl t where k < t.elapsed and k = any(t.came_back))
        ) order by k)
        from generate_series(1, f.periods) k),
      'breakdown', case when p_breakdown = 'none' then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object(
          'key', g.grp,
          'people', g.people,
          'values', (
            select jsonb_agg(jsonb_build_object(
              'period', k,
              'people', (select count(*) from tbl t where t.grp = g.grp and k < t.elapsed),
              'returned', (select count(*) from tbl t where t.grp = g.grp and k < t.elapsed and k = any(t.came_back))
            ) order by k)
            from generate_series(1, f.periods) k)
        ) order by g.people desc, g.grp)
        from top_groups g), '[]'::jsonb) end,
      'other_groups', case when p_breakdown = 'none' then 0 else
        (select count(distinct grp) from tbl) - (select count(*) from top_groups) end
    )
  );
end $$;

-- The people behind one cell: a cohort (p_cohort) or a group of the breakdown (p_group),
-- and either everyone in it (p_period 0) or those who came back in period p_period.
create function public.analytics_retention_people(
  p_project uuid, p_definition jsonb, p_cohort date default null, p_period integer default 0,
  p_breakdown text default 'none', p_group text default null, p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  v_def jsonb := kma_internal.analytics_retention_definition(p_definition);
  v_interval text := v_def->>'interval';
  f record;
begin
  if p_breakdown not in ('none', 'country', 'device', 'platform', 'browser', 'source') then
    raise exception 'Unknown breakdown' using errcode = '22023';
  end if;
  select * into f from kma_internal.analytics_retention_frame(v_interval, v.timezone);
  if p_period is null or p_period not between 0 and f.periods then
    raise exception 'Choose a period from 0 to %', f.periods using errcode = '22023';
  end if;
  return (
    with walk as (
      select w.*, kma_internal.analytics_period_start(v_interval, w.start_date) as cohort,
        array(select distinct kma_internal.analytics_period_index(v_interval, w.start_date, d) from unnest(w.returns) d) as came_back
      from kma_internal.analytics_retention_walk(p_project, v_def, f.read_from, now(), v.timezone) w
    ), chosen as (
      select wk.*, p.*, cardinality(wk.returns) as days_back
      from walk wk join public.analytics_people p on p.id = wk.person_id
      where wk.cohort >= f.first_cohort
        and (p_cohort is null or wk.cohort = kma_internal.analytics_period_start(v_interval, p_cohort))
        and (p_group is null or kma_internal.analytics_person_group(p_breakdown, p) = p_group)
        -- A cohort's cell shows its period in progress; a group's only finished periods.
        and (p_period = 0 or (p_period = any(wk.came_back)
          and (p_cohort is not null or p_period < kma_internal.analytics_period_index(v_interval, wk.cohort, f.current_period))))
    )
    select jsonb_build_object(
      'total', (select count(*) from chosen),
      'people', coalesce((
        select jsonb_agg(row_data order by (row_data->>'started_at') desc, row_data->>'id')
        from (
          select jsonb_build_object(
            'id', c.person_id, 'distinct_id', c.distinct_id, 'user_id', c.user_id, 'traits', c.traits,
            'country', c.country, 'city', c.city, 'platform', c.platform, 'device_type', c.device_type,
            'started_at', c.started_at, 'last_seen', c.last_seen, 'days_back', c.days_back
          ) row_data
          from chosen c
          order by c.started_at desc, c.person_id
          offset greatest(coalesce(p_offset, 0), 0) limit 50) t), '[]'::jsonb)
    )
  );
end $$;

-- For the overview: of the people first seen in the 30 days that ended a week ago, how many
-- were back on their seventh day.
create function public.analytics_retention_summary(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  v_today date := (now() at time zone v.timezone)::date;
  v_from date := v_today - 37;
  v_to date := v_today - 7;
begin
  return (
    select jsonb_build_object(
      'day', 7, 'from', v_from, 'to', v_to - 1,
      'people', count(*),
      'returned', count(*) filter (where (w.start_date + 7) = any(w.returns)))
    from kma_internal.analytics_retention_walk(p_project, '{"interval":"day","start":{"kind":"first_seen"},"return":{"kind":"any"}}',
      (v_from::timestamp at time zone v.timezone), (v_to::timestamp at time zone v.timezone), v.timezone) w
  );
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'analytics_retention_report(uuid,jsonb,text)',
    'analytics_retention_people(uuid,jsonb,date,integer,text,text,integer)',
    'analytics_retention_summary(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
