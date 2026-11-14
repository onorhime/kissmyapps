-- Attribution Phase 3, piece C: return on ad spend and cohorts.
--
-- Each person counts once, on the day we first saw them (their first visit or, when earlier,
-- their app install), and is credited to the first source we know for them: the install's
-- source or the first visit that came from somewhere, whichever was earlier. Their revenue
-- since that moment, net of refunds, is set against what was spent on that source on the
-- same keys (source, campaign, ad set, ad). Revenue and cost are shown in the project's
-- currency at the ECB's rate of the day; an amount in a currency without a rate is left out
-- and counted as such.
--
-- Everything is worked out when a report is read, from production data only, without
-- people or visits the merchant or the bot rules marked as bots. Nothing returned names a
-- person: counts and money only.
--
-- No index is added: every lookup here goes through an existing one. People by
-- analytics_people_first_seen, installs by attribution_install_once, a person's visits by
-- analytics_sessions_person, revenue by attribution_revenue_person, events by
-- analytics_events_person, costs by attribution_costs_key, clicks by their primary key.
begin;

-- Helpers -----------------------------------------------------------------------------------

-- A campaign, ad set or ad as reports group it: trimmed, lower case, empty as none.
create function kma_internal.attribution_key(p_value text) returns text
language sql immutable set search_path = '' as $$
  select nullif(lower(btrim(p_value)), '')
$$;

-- A source as reports group it: its ad platform (facebook and instagram are meta), empty as
-- none. PL/pgSQL because it runs once per person: an SQL function with its own search_path
-- calling another one costs several times more per call.
create function kma_internal.attribution_source_key(p_value text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  return kma_internal.attribution_source_family(nullif(btrim(p_value), ''));
end $$;

-- Money in reports: 2 decimals, without trailing zeros.
create function kma_internal.attribution_money(p_value numeric) returns numeric
language sql immutable set search_path = '' as $$
  select trim_scale(round(coalesce(p_value, 0), 2))
$$;

-- A ratio rounded to p_places decimals, or null when there is nothing to divide by.
create function kma_internal.attribution_ratio(p_value numeric, p_by numeric, p_places integer) returns numeric
language sql immutable set search_path = '' as $$
  select case when coalesce(p_by, 0) = 0 then null else trim_scale(round(coalesce(p_value, 0) / p_by, p_places)) end
$$;

-- People acquired in [p_from, p_to): when, on which platform, and the first source we know.
--
-- Acquired: the first time we saw them, or their counted app install when that was earlier
-- (a counted install is live, not rejected and not a reinstall of the same phone). Source:
-- of their counted install (when it has one) and their first visit that came from somewhere,
-- the earlier; neither is "direct and organic" (source null). Platform: the install's, else
-- the first visit's, else web.
--
-- Production people only, without those marked as bots. Visits the bot rules or a blocked
-- network leave out of reports are skipped, and a person all of whose visits are left out
-- (and who has no counted install) is left out too.
create function kma_internal.attribution_acquisitions(p_project uuid, p_from timestamptz, p_to timestamptz)
returns table (person_id uuid, acquired_at timestamptz, platform text, method text, source text, campaign text,
  adset text, ad text, link_id uuid, installed boolean)
language sql stable set search_path = '' as $$
  with ctx as materialized (
    select kma_internal.attribution_own_hosts(p_project) hosts,
      coalesce((select array_agg(r.rule) from public.analytics_bot_rules r
        where r.project_id = p_project and r.enabled), '{}'::text[]) rules
  ), people as materialized (
    select pe.id, least(pe.first_seen, i.installed_at) acquired_at, i.id is not null installed, i.installed_at,
      i.platform i_platform, i.method i_method, i.source i_source, i.campaign i_campaign, i.adset i_adset, i.ad i_ad,
      i.link_id i_link,
      exists (select 1 from public.analytics_bot_overrides o
        where o.project_id = p_project and o.verdict = 'human' and o.person_id = pe.id) human
    from public.analytics_people pe
    left join public.attribution_installs i on i.project_id = pe.project_id and i.person_id = pe.id
      and i.environment = 'production' and i.verdict <> 'rejected' and i.method <> 'reinstall'
    where pe.project_id = p_project and pe.environment = 'production'
      -- Acquired no earlier than p_from means first seen no earlier than p_from (the index).
      and pe.first_seen >= p_from
      and least(pe.first_seen, i.installed_at) >= p_from and least(pe.first_seen, i.installed_at) < p_to
      and not exists (select 1 from public.analytics_bot_overrides o
        where o.project_id = p_project and o.verdict = 'bot' and o.person_id = pe.id)
  )
  select x.id, x.acquired_at,
    coalesce(case when x.installed then x.i_platform end, fv.platform, 'web'),
    case k.pick when 'install' then x.i_method when 'visit' then t.touch->>'method' end,
    case k.pick when 'install' then x.i_source when 'visit' then t.touch->>'source' end,
    case k.pick when 'install' then x.i_campaign when 'visit' then t.touch->>'campaign' end,
    case k.pick when 'install' then x.i_adset when 'visit' then t.touch->>'adset' end,
    case k.pick when 'install' then x.i_ad when 'visit' then t.touch->>'ad' end,
    case k.pick when 'install' then x.i_link when 'visit' then (t.touch->>'link_id')::uuid end,
    x.installed
  from people x
  cross join ctx
  -- Their first visit that counts in reports.
  left join lateral (
    select s.platform from public.analytics_sessions s
    where s.person_id = x.id and s.environment = 'production'
      and (x.human or not (s.bot_reasons && ctx.rules))
      and not exists (select 1 from public.analytics_bot_overrides o
        where o.project_id = p_project and o.verdict = 'bot' and o.ip_hash = s.ip_hash)
    order by s.started_at, s.id limit 1
  ) fv on true
  -- Their first such visit that came from somewhere. A visit with no link click, UTM source,
  -- ad click ID or referrer has no source, so attribution_touch is only asked about the others.
  left join lateral (
    select v.started_at, v.touch
    from (
      select s.started_at, s.id, kma_internal.attribution_touch(s, ctx.hosts) touch
      from public.analytics_sessions s
      where s.person_id = x.id and s.environment = 'production'
        and (x.human or not (s.bot_reasons && ctx.rules))
        and (s.link_click is not null or s.utm_source is not null or s.click_ids <> '{}'::jsonb or s.referrer is not null)
        and not exists (select 1 from public.analytics_bot_overrides o
          where o.project_id = p_project and o.verdict = 'bot' and o.ip_hash = s.ip_hash)
      offset 0 -- so attribution_touch runs once per visit, not again for the one picked
    ) v
    where v.touch is not null
    order by v.started_at, v.id limit 1
  ) t on true
  -- Whether they have any production visit at all (one index probe; a correlated EXISTS here
  -- would let the planner hash every production session of every project instead).
  left join lateral (
    select true found from public.analytics_sessions s
    where s.person_id = x.id and s.environment = 'production' limit 1
  ) av on true
  cross join lateral (
    select case
      when x.i_source is not null and (t.touch is null or x.installed_at <= t.started_at) then 'install'
      when t.touch is not null then 'visit'
    end pick
  ) k
  where x.installed or fv.platform is not null or av.found is null
$$;

-- The people acquired in [p_from, p_to) with their group keys and what they paid since they
-- were acquired, in p_currency: net revenue to date, and the same by day, revenue_amounts[i]
-- being the net revenue of day revenue_days[i] (day n is the n-th 24 hours after the
-- acquisition; only days with revenue, in order). Revenue before the acquisition is ignored.
-- Each person's payments are added up per UTC day and currency and converted at that day's
-- rate; those in a currency without a rate are left out and counted in unconverted (rows) and
-- unconverted_currencies.
create function kma_internal.attribution_people_value(p_project uuid, p_currency text, p_from timestamptz, p_to timestamptz)
returns table (person_id uuid, acquired_at timestamptz, installed boolean, source_key text, campaign_key text,
  adset_key text, ad_key text, revenue numeric, revenue_days integer[], revenue_amounts numeric[], unconverted integer,
  unconverted_currencies text[])
language sql stable set search_path = '' as $$
  with acq as materialized (
    select a.person_id, a.acquired_at, a.installed, kma_internal.attribution_source_key(a.source) source_key,
      kma_internal.attribution_key(a.campaign) campaign_key, kma_internal.attribution_key(a.adset) adset_key,
      kma_internal.attribution_key(a.ad) ad_key
    from kma_internal.attribution_acquisitions(p_project, p_from, p_to) a
  ), raw as (
    select r.person_id, floor(extract(epoch from r.occurred_at - a.acquired_at) / 86400)::integer day_index,
      (r.occurred_at at time zone 'UTC')::date utc_day, r.currency, sum(r.amount) amount, count(*)::integer n
    from acq a
    join public.attribution_revenue r on r.person_id = a.person_id
    -- No one here was acquired before p_from, so nothing they paid before it counts.
    where r.project_id = p_project and r.environment = 'production' and r.occurred_at >= p_from
      and r.occurred_at >= a.acquired_at
    group by 1, 2, 3, 4
  ), rates as materialized (
    -- Materialized, or the rate would be looked up again for every row it is joined to.
    select x.utc_day, x.currency, kma_internal.attribution_fx_rate(x.currency, p_currency, x.utc_day) rate
    from (select distinct raw.utc_day, raw.currency from raw) x
  ), conv as (
    -- amount is null when the currency had no rate.
    select raw.person_id, raw.day_index, raw.amount * rt.rate amount, raw.currency, raw.n
    from raw join rates rt on rt.utc_day = raw.utc_day and rt.currency = raw.currency
  ), by_day as (
    select d.person_id, sum(d.amount) revenue, array_agg(d.day_index order by d.day_index) revenue_days,
      array_agg(d.amount order by d.day_index) revenue_amounts
    from (select c.person_id, c.day_index, sum(c.amount) amount from conv c where c.amount is not null group by 1, 2) d
    group by d.person_id
  ), left_out as (
    select c.person_id, sum(c.n)::integer unconverted, array_agg(distinct c.currency) currencies
    from conv c where c.amount is null group by c.person_id
  )
  select a.person_id, a.acquired_at, a.installed, a.source_key, a.campaign_key, a.adset_key, a.ad_key,
    coalesce(bd.revenue, 0), coalesce(bd.revenue_days, '{}'::integer[]), coalesce(bd.revenue_amounts, '{}'::numeric[]),
    coalesce(lo.unconverted, 0), coalesce(lo.currencies, '{}'::text[])
  from acq a
  left join by_day bd on bd.person_id = a.person_id
  left join left_out lo on lo.person_id = a.person_id
$$;

-- One ROI line: people, installs, spend, paying people and revenue, and what follows from them.
create function kma_internal.attribution_roi_metrics(p_users bigint, p_installs bigint, p_cost numeric, p_payers bigint,
  p_revenue numeric, p_d0 numeric, p_d7 numeric, p_d30 numeric) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'users', coalesce(p_users, 0), 'installs', coalesce(p_installs, 0), 'cost', kma_internal.attribution_money(p_cost),
    'payers', coalesce(p_payers, 0), 'revenue', kma_internal.attribution_money(p_revenue),
    'revenue_d0', kma_internal.attribution_money(p_d0), 'revenue_d7', kma_internal.attribution_money(p_d7),
    'revenue_d30', kma_internal.attribution_money(p_d30),
    'cpi', kma_internal.attribution_ratio(p_cost, p_installs, 2),
    'cost_per_user', kma_internal.attribution_ratio(p_cost, p_users, 2),
    'cost_per_payer', kma_internal.attribution_ratio(p_cost, p_payers, 2),
    'arpu', kma_internal.attribution_ratio(p_revenue, p_users, 2),
    'roas', kma_internal.attribution_ratio(p_revenue, p_cost, 4),
    'roas_d0', kma_internal.attribution_ratio(p_d0, p_cost, 4),
    'roas_d7', kma_internal.attribution_ratio(p_d7, p_cost, 4),
    'roas_d30', kma_internal.attribution_ratio(p_d30, p_cost, 4))
$$;

-- Reads a source, campaign or ad set filter of a report's input into (given, key). Absent: not
-- given. JSON null: the null key (direct and organic, or no campaign). A name: its key.
create function kma_internal.attribution_filter(p_input jsonb, p_name text, out given boolean, out key text)
language plpgsql immutable set search_path = '' as $$
begin
  given := p_input ? p_name;
  if not given then
    return;
  end if;
  if jsonb_typeof(p_input->p_name) not in ('string', 'null') then
    raise exception 'A % filter is a name, or null for none', replace(p_name, 'adset', 'ad set')
      using errcode = '22023', detail = 'invalid_input';
  end if;
  key := case when p_name = 'source' then kma_internal.attribution_source_key(p_input->>p_name)
    else kma_internal.attribution_key(p_input->>p_name) end;
end $$;

-- Reports -----------------------------------------------------------------------------------

-- Return on ad spend for the people acquired in a range, by source, campaign, ad set, ad or
-- day of acquisition. Input: {"range": "7d"|"30d"|"90d", "group": "source"|"campaign"|"adset"|
-- "ad"|"day", "source"?, "campaign"?, "adset"?}; a filter given as null means the null key.
-- Campaigns need a source; ad sets a source and a campaign; ads all three. Spend is matched
-- to people by the same keys, so spend on a key nobody came from still shows (users 0).
create function public.attribution_roi(p_project uuid, p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.analytics_projects := kma_internal.analytics_require_project(p_project);
  s public.attribution_settings := kma_internal.attribution_require_settings(p_project);
  v_input jsonb := coalesce(p_input, '{}'::jsonb);
  v_range text;
  v_group text;
  w record;
  v_from date;
  v_to date;
  fs record;
  fc record;
  fa record;
  v_filters jsonb := '{}'::jsonb;
  v_result jsonb;
begin
  if jsonb_typeof(v_input) <> 'object' then
    raise exception 'Send the ROI options as an object' using errcode = '22023', detail = 'invalid_input';
  end if;
  if exists (select 1 from jsonb_object_keys(v_input) x where x <> all(array['range', 'group', 'source', 'campaign', 'adset'])) then
    raise exception 'ROI takes a range, a grouping and source, campaign and ad set filters' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_range := coalesce(v_input->>'range', '30d');
  if v_range not in ('7d', '30d', '90d') then
    raise exception 'Choose 7, 30 or 90 days' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_group := coalesce(v_input->>'group', 'source');
  if v_group not in ('source', 'campaign', 'adset', 'ad', 'day') then
    raise exception 'Group ROI by source, campaign, ad set, ad or day' using errcode = '22023', detail = 'invalid_input';
  end if;
  select * into fs from kma_internal.attribution_filter(v_input, 'source');
  select * into fc from kma_internal.attribution_filter(v_input, 'campaign');
  select * into fa from kma_internal.attribution_filter(v_input, 'adset');
  if v_group = 'campaign' and not fs.given then
    raise exception 'Choose a source to see its campaigns' using errcode = '22023', detail = 'invalid_input';
  elsif v_group = 'adset' and not (fs.given and fc.given) then
    raise exception 'Choose a source and a campaign to see their ad sets' using errcode = '22023', detail = 'invalid_input';
  elsif v_group = 'ad' and not (fs.given and fc.given and fa.given) then
    raise exception 'Choose a source, a campaign and an ad set to see their ads' using errcode = '22023', detail = 'invalid_input';
  end if;
  if fs.given then v_filters := v_filters || jsonb_build_object('source', fs.key); end if;
  if fc.given then v_filters := v_filters || jsonb_build_object('campaign', fc.key); end if;
  if fa.given then v_filters := v_filters || jsonb_build_object('adset', fa.key); end if;

  select * into w from kma_internal.analytics_window(v_range, p.timezone);
  v_from := (w.from_at at time zone p.timezone)::date;
  v_to := ((w.to_at - interval '1 microsecond') at time zone p.timezone)::date;

  with people as materialized (
    select x.*, case v_group
        when 'source' then x.source_key when 'campaign' then x.campaign_key when 'adset' then x.adset_key
        when 'ad' then x.ad_key else to_char((x.acquired_at at time zone p.timezone)::date, 'YYYY-MM-DD') end k
    from kma_internal.attribution_people_value(p_project, s.currency, w.from_at, w.to_at) x
    where (not fs.given or x.source_key is not distinct from fs.key)
      and (not fc.given or x.campaign_key is not distinct from fc.key)
      and (not fa.given or x.adset_key is not distinct from fa.key)
  ), cost_lines as (
    select c.day, c.currency, sum(c.amount) amount, count(*)::integer n, case v_group
        when 'source' then c.source_key when 'campaign' then c.campaign_key when 'adset' then c.adset_key
        when 'ad' then c.ad_key else to_char(c.day, 'YYYY-MM-DD') end k
    from (
      select l.day, l.currency, l.amount, kma_internal.attribution_source_key(l.source) source_key,
        kma_internal.attribution_key(l.campaign) campaign_key, kma_internal.attribution_key(l.adset) adset_key,
        kma_internal.attribution_key(l.ad) ad_key
      from kma_internal.attribution_cost_lines(p_project, v_from, v_to) l
    ) c
    where (not fs.given or c.source_key is not distinct from fs.key)
      and (not fc.given or c.campaign_key is not distinct from fc.key)
      and (not fa.given or c.adset_key is not distinct from fa.key)
    group by 1, 2, 5
  ), cost_rates as materialized (
    select x.day, x.currency, kma_internal.attribution_fx_rate(x.currency, s.currency, x.day) rate
    from (select distinct cl.day, cl.currency from cost_lines cl) x
  ), costs as (
    -- cost is null when the currency had no rate that day: left out, and counted.
    select cl.k, cl.currency, cl.n, cl.amount * r.rate cost
    from cost_lines cl join cost_rates r on r.day = cl.day and r.currency = cl.currency
  ), facts as (
    -- One line per person, per day a person paid on, per cost, and (by day) per day of the
    -- range, added up by key below. Every person is in exactly one group.
    select pp.k, 1 users, case when pp.installed then 1 else 0 end installs, case when pp.revenue > 0 then 1 else 0 end payers,
      pp.revenue, 0::numeric d0, 0::numeric d7, 0::numeric d30, 0::numeric cost
    from people pp
    union all
    select pp.k, 0, 0, 0, 0, case when u.day_index <= 0 then u.amount else 0 end, case when u.day_index <= 7 then u.amount else 0 end,
      case when u.day_index <= 30 then u.amount else 0 end, 0
    from people pp cross join lateral unnest(pp.revenue_days, pp.revenue_amounts) u(day_index, amount)
    union all
    select c.k, 0, 0, 0, 0, 0, 0, 0, c.cost from costs c where c.cost is not null
    union all
    select to_char(d, 'YYYY-MM-DD'), 0, 0, 0, 0, 0, 0, 0, 0
    from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') d where v_group = 'day'
  ), grouped as (
    select f.k, sum(f.users) users, sum(f.installs) installs, sum(f.cost) cost, sum(f.payers) payers, sum(f.revenue) revenue,
      sum(f.d0) d0, sum(f.d7) d7, sum(f.d30) d30
    from facts f group by f.k
  ), shown as (
    select g.*, row_number() over (order by case when v_group = 'day' then g.k end,
      g.k is null, g.cost desc, g.users desc, g.k) position
    from grouped g
  )
  select jsonb_build_object(
    'currency', s.currency, 'range', v_range, 'from', v_from, 'to', v_to, 'timezone', p.timezone,
    'group', v_group, 'filters', v_filters,
    -- Day n is complete for a person once n + 1 whole days have passed since they were acquired.
    'complete', (select jsonb_build_object(
        'd0', coalesce(bool_and(pp.acquired_at + interval '24 hours' <= now()), true),
        'd7', coalesce(bool_and(pp.acquired_at + interval '192 hours' <= now()), true),
        'd30', coalesce(bool_and(pp.acquired_at + interval '744 hours' <= now()), true))
      from people pp),
    'totals', (select kma_internal.attribution_roi_metrics(sum(g.users)::bigint, sum(g.installs)::bigint, sum(g.cost),
        sum(g.payers)::bigint, sum(g.revenue), sum(g.d0), sum(g.d7), sum(g.d30)) from grouped g),
    'rows', coalesce((select jsonb_agg(kma_internal.attribution_roi_metrics(sh.users, sh.installs, sh.cost, sh.payers,
        sh.revenue, sh.d0, sh.d7, sh.d30) || jsonb_build_object('key', sh.k) order by sh.position)
      from shown sh where v_group = 'day' or sh.position <= 200), '[]'::jsonb),
    'unconverted', jsonb_build_object(
      'revenue', (select coalesce(sum(pp.unconverted), 0) from people pp),
      'cost', (select coalesce(sum(c.n), 0) from costs c where c.cost is null),
      'currencies', coalesce((select jsonb_agg(x.c order by x.c) from (
        select unnest(pp.unconverted_currencies) c from people pp
        union select c.currency from costs c where c.cost is null) x), '[]'::jsonb)),
    'has_costs', exists (select 1 from public.attribution_costs c where c.project_id = p_project)
      or exists (select 1 from public.attribution_cost_rules r where r.project_id = p_project),
    'has_revenue', exists (select 1 from public.attribution_revenue r where r.project_id = p_project and r.environment = 'production')
  ) into v_result;
  return v_result;
end $$;

-- Cohorts: the people acquired in each day (the last 30), week (the last 12, from Monday) or
-- month (the last 6) in the project's time zone, with what they paid up to day 0, 1, 3, 7,
-- 14, 30, 60 and 90, the return on what was spent in that period, and how many came back on
-- that day. Input: {"interval": "day"|"week"|"month", "source"?, "campaign"?} (a filter given
-- as null means the null key).
--
-- A cell is complete when every person in the cohort has had that day in full, future when
-- that day has not begun for anyone in it yet, partial otherwise, so a cell with money in it
-- is never shown as still to come. For a cohort nobody joined the same goes by its dates:
-- future when the day has not begun for someone acquired at its start, complete when it is
-- over for someone acquired at its end. Revenue counts everyone in the cohort; coming back
-- counts the people who have had the day in full, so retention is over the same people. The
-- curve averages each day 0 to 30 over the people who have had it in full.
create function public.attribution_cohorts(p_project uuid, p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.analytics_projects := kma_internal.analytics_require_project(p_project);
  s public.attribution_settings := kma_internal.attribution_require_settings(p_project);
  v_input jsonb := coalesce(p_input, '{}'::jsonb);
  v_interval text;
  v_step interval;
  v_today date;
  v_current date;
  v_first date;
  fs record;
  fc record;
  v_filters jsonb := '{}'::jsonb;
  v_days integer[] := array[0, 1, 3, 7, 14, 30, 60, 90];
  v_result jsonb;
begin
  if jsonb_typeof(v_input) <> 'object' then
    raise exception 'Send the cohort options as an object' using errcode = '22023', detail = 'invalid_input';
  end if;
  if exists (select 1 from jsonb_object_keys(v_input) x where x <> all(array['interval', 'source', 'campaign'])) then
    raise exception 'Cohorts take an interval and source and campaign filters' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_interval := coalesce(v_input->>'interval', 'day');
  if v_interval not in ('day', 'week', 'month') then
    raise exception 'Group cohorts by day, week or month' using errcode = '22023', detail = 'invalid_input';
  end if;
  select * into fs from kma_internal.attribution_filter(v_input, 'source');
  select * into fc from kma_internal.attribution_filter(v_input, 'campaign');
  if fs.given then v_filters := v_filters || jsonb_build_object('source', fs.key); end if;
  if fc.given then v_filters := v_filters || jsonb_build_object('campaign', fc.key); end if;

  v_today := (now() at time zone p.timezone)::date;
  v_current := kma_internal.analytics_period_start(v_interval, v_today);
  v_first := case v_interval when 'day' then v_today - 29 when 'week' then v_current - 77
    else (v_current - interval '5 months')::date end;
  v_step := case v_interval when 'day' then interval '1 day' when 'week' then interval '7 days' else interval '1 month' end;

  with people as materialized (
    select x.*, kma_internal.analytics_period_start(v_interval, (x.acquired_at at time zone p.timezone)::date) cohort
    from kma_internal.attribution_people_value(p_project, s.currency, v_first::timestamp at time zone p.timezone, now()) x
    where (not fs.given or x.source_key is not distinct from fs.key)
      and (not fc.given or x.campaign_key is not distinct from fc.key)
  ), skipped as materialized (
    -- Their visits that reports leave out (bot rules, blocked networks): events in them are
    -- not coming back.
    select se.id
    from people pp
    join public.analytics_sessions se on se.person_id = pp.person_id
    cross join (select coalesce(array_agg(r.rule), '{}'::text[]) rules from public.analytics_bot_rules r
      where r.project_id = p_project and r.enabled) br
    where se.environment = 'production' and (
      exists (select 1 from public.analytics_bot_overrides o
        where o.project_id = p_project and o.verdict = 'bot' and o.ip_hash = se.ip_hash)
      or (se.bot_reasons && br.rules and not exists (select 1 from public.analytics_bot_overrides o
        where o.project_id = p_project and o.verdict = 'human' and o.person_id = se.person_id)))
  ), back as (
    -- The days (0 to 90) on which each person had a production event.
    select e.person_id, array_agg(distinct floor(extract(epoch from e.occurred_at - pp.acquired_at) / 86400)::integer) days
    from people pp
    join public.analytics_events e on e.person_id = pp.person_id
    where e.project_id = p_project and e.environment = 'production' and e.occurred_at >= pp.acquired_at
      and e.occurred_at < pp.acquired_at + interval '2184 hours'
      and (e.session_id is null or e.session_id not in (select sk.id from skipped sk))
    group by e.person_id
  ), folk as (
    -- done: the last day each person has had in full (-1 in their first 24 hours).
    select pp.*, coalesce(b.days, '{}'::integer[]) came_back,
      floor(extract(epoch from now() - pp.acquired_at) / 86400)::integer - 1 done
    from people pp left join back b on b.person_id = pp.person_id
  ), members as (
    -- Who is in each cohort and how many days they have had in full, and below what they
    -- paid on each day and on which days they came back, in a few rows per cohort.
    select f.cohort, f.done, count(*) users from folk f group by f.cohort, f.done
  ), paid as (
    select f.cohort, f.done, u.day_index, sum(u.amount) amount
    from folk f cross join lateral unnest(f.revenue_days, f.revenue_amounts) u(day_index, amount)
    group by f.cohort, f.done, u.day_index
  ), came as (
    select f.cohort, b.n, count(*) returned
    from folk f cross join lateral unnest(f.came_back) b(n)
    where b.n <= f.done
    group by f.cohort, b.n
  ), cohorts as (
    select g::date cohort, g::date::timestamp at time zone p.timezone starts_at,
      (g::date + v_step)::timestamp at time zone p.timezone ends_at
    from generate_series(v_first::timestamp, v_current::timestamp, v_step) g
  ), cost_lines as (
    select c.day, c.currency, sum(c.amount) amount, count(*)::integer n
    from kma_internal.attribution_cost_lines(p_project, v_first, v_today) c
    where (not fs.given or kma_internal.attribution_source_key(c.source) is not distinct from fs.key)
      and (not fc.given or kma_internal.attribution_key(c.campaign) is not distinct from fc.key)
    group by 1, 2
  ), costs as (
    -- cost is null when the currency had no rate that day: left out, and counted.
    select kma_internal.analytics_period_start(v_interval, cl.day) cohort, cl.currency, cl.n,
      cl.amount * kma_internal.attribution_fx_rate(cl.currency, s.currency, cl.day) cost
    from cost_lines cl
  ), cohort_costs as (
    select c.cohort, sum(c.cost) cost from costs c where c.cost is not null group by c.cohort
  ), cell_people as (
    select c.cohort, d.n, c.starts_at, c.ends_at, coalesce(sum(g.users), 0) users,
      coalesce(sum(g.users) filter (where g.done >= d.n), 0) complete_users,
      -- Day n has begun for someone once n whole days have passed (done >= n - 1).
      coalesce(sum(g.users) filter (where g.done >= d.n - 1), 0) begun_users
    from cohorts c cross join unnest(v_days) d(n) left join members g on g.cohort = c.cohort
    group by c.cohort, d.n, c.starts_at, c.ends_at
  ), cell_revenue as (
    select pd.cohort, d.n, sum(pd.amount) revenue
    from paid pd join unnest(v_days) d(n) on pd.day_index <= d.n
    group by pd.cohort, d.n
  ), cells as (
    -- Revenue counts everyone in the cohort; coming back only those who had the day in full.
    select cp.*, coalesce(cr.revenue, 0) revenue, coalesce(cm.returned, 0) returned
    from cell_people cp
    left join cell_revenue cr on cr.cohort = cp.cohort and cr.n = cp.n
    left join came cm on cm.cohort = cp.cohort and cm.n = cp.n
  ), curve as (
    -- Each day 0 to 30 over the people who have had it in full.
    select d.n,
      coalesce((select sum(g.users) from members g where g.done >= d.n), 0) users,
      coalesce((select sum(pd.amount) from paid pd where pd.day_index <= d.n and pd.done >= d.n), 0) revenue,
      coalesce((select sum(cm.returned) from came cm where cm.n = d.n), 0) returned
    from generate_series(0, 30) d(n)
  )
  select jsonb_build_object(
    'currency', s.currency, 'interval', v_interval, 'timezone', p.timezone, 'today', v_today,
    'filters', v_filters, 'days', to_jsonb(v_days),
    'cohorts', (
      select jsonb_agg(jsonb_build_object(
        'start', c.cohort,
        'users', (select ce.users from cells ce where ce.cohort = c.cohort and ce.n = 0),
        'cost', kma_internal.attribution_money(cc.cost),
        'cells', (
          select jsonb_agg(jsonb_build_object(
            'day', ce.n,
            'state', case
              when ce.users > 0 and ce.complete_users = ce.users then 'complete'
              when ce.users > 0 and ce.begun_users = 0 then 'future'
              when ce.users > 0 then 'partial'
              when ce.ends_at + make_interval(hours => 24 * (ce.n + 1)) <= now() then 'complete'
              when ce.starts_at + make_interval(hours => 24 * ce.n) > now() then 'future'
              else 'partial' end,
            'complete_users', ce.complete_users,
            'revenue', kma_internal.attribution_money(ce.revenue),
            'revenue_per_user', kma_internal.attribution_ratio(ce.revenue, ce.users, 4),
            'roas', kma_internal.attribution_ratio(ce.revenue, cc.cost, 4),
            'returned', ce.returned,
            'retention', kma_internal.attribution_ratio(ce.returned, ce.complete_users, 4)) order by ce.n)
          from cells ce where ce.cohort = c.cohort)) order by c.cohort desc)
      from cohorts c left join cohort_costs cc on cc.cohort = c.cohort),
    'curve', (
      select jsonb_agg(jsonb_build_object('day', cu.n, 'users', cu.users,
        'revenue_per_user', kma_internal.attribution_ratio(cu.revenue, cu.users, 4),
        'retention', kma_internal.attribution_ratio(cu.returned, cu.users, 4)) order by cu.n)
      from curve cu),
    'totals', (select jsonb_build_object('users', count(*), 'cost', kma_internal.attribution_money((select sum(c.cost) from costs c)),
        'revenue', kma_internal.attribution_money(sum(f.revenue)), 'payers', count(*) filter (where f.revenue > 0))
      from folk f),
    'unconverted', jsonb_build_object(
      'revenue', (select coalesce(sum(f.unconverted), 0) from folk f),
      'cost', (select coalesce(sum(c.n), 0) from costs c where c.cost is null),
      'currencies', coalesce((select jsonb_agg(x.c order by x.c) from (
        select unnest(f.unconverted_currencies) c from folk f
        union select c.currency from costs c where c.cost is null) x), '[]'::jsonb))
  ) into v_result;
  return v_result;
end $$;

revoke all on function kma_internal.attribution_key(text) from public, anon, authenticated;
revoke all on function kma_internal.attribution_source_key(text) from public, anon, authenticated;
revoke all on function kma_internal.attribution_money(numeric) from public, anon, authenticated;
revoke all on function kma_internal.attribution_ratio(numeric, numeric, integer) from public, anon, authenticated;
revoke all on function kma_internal.attribution_acquisitions(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function kma_internal.attribution_people_value(uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function kma_internal.attribution_roi_metrics(bigint, bigint, numeric, bigint, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke all on function kma_internal.attribution_filter(jsonb, text) from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array['attribution_roi(uuid,jsonb)', 'attribution_cohorts(uuid,jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
