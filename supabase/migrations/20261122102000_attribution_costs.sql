-- Attribution Phase 3, piece B: what the merchant spent to bring people.
--
-- Spend reaches a project three ways in this phase:
--   - typed in the console, one day, source and campaign (ad set and ad when known) at a time;
--   - uploaded as a spreadsheet, which the browser reads and sends as rows. An upload is all or
--     nothing, and can be undone as a whole while its rows are still there;
--   - a fixed price per install or per click on one smart link, for a creator or influencer
--     deal: the cost of a day is the link's counted installs (or clicks) that day times the
--     price.
-- Writing the same day, source, campaign, ad set and ad again replaces the amount, whoever
-- wrote it first. Spend is kept in the currency it was paid in; reports show it in the
-- project's currency with the ECB's rate of its day.
--
-- Read by members (analysts and up); written by developers and up. Nothing here calls Meta or
-- TikTok, and nothing is joined across projects.
begin;

-- Link prices ---------------------------------------------------------------------------------

-- The cost of each link price, per day in the project's time zone, between p_from and p_to
-- (both included) and inside the price's own first and last day: one row per day that had
-- counted installs (kind install) or clicks (kind click) on the link. An install counts as the
-- Phase 2 reports count one (live, not rejected, not a reinstall of the same phone), and not
-- when the merchant marked its person as a bot. The link service never records a robot's
-- click (deploy/link-service/links.mjs sends robots the preview only), so every stored click
-- counts. Source, campaign, ad set and ad are the link's as they are now (empty when none).
create function kma_internal.attribution_link_costs(p_project uuid, p_from date, p_to date)
returns table (day date, rule_id uuid, link_id uuid, kind text, units bigint, amount numeric, currency text,
  source text, campaign text, adset text, ad text)
language sql stable set search_path = '' as $$
  with project as (
    select x.timezone tz from public.analytics_projects x
    where x.id = p_project and p_from is not null and p_to is not null
  ), rules as (
    select r.id, r.link_id, r.kind, r.amount, r.currency, project.tz,
      greatest(p_from, r.starts_on) d_from, least(p_to, coalesce(r.ends_on, p_to)) d_to
    from public.attribution_cost_rules r cross join project
    where r.project_id = p_project
  ), windows as (
    select r.*, (r.d_from::timestamp at time zone r.tz) t_from, ((r.d_to + 1)::timestamp at time zone r.tz) t_to
    from rules r where r.d_from <= r.d_to
  ), counts as (
    select w.id rule_id, (i.installed_at at time zone w.tz)::date d, count(*) n
    from windows w
    join public.attribution_installs i on i.link_id = w.link_id
      and i.installed_at >= w.t_from and i.installed_at < w.t_to
    where w.kind = 'install' and i.project_id = p_project and i.environment = 'production'
      and i.verdict <> 'rejected' and i.method <> 'reinstall'
      and not exists (select 1 from public.analytics_bot_overrides b
        where b.project_id = p_project and b.verdict = 'bot' and b.person_id = i.person_id)
    group by 1, 2
    union all
    select w.id, (c.clicked_at at time zone w.tz)::date, count(*)
    from windows w
    join public.attribution_clicks c on c.link_id = w.link_id
      and c.clicked_at >= w.t_from and c.clicked_at < w.t_to
    where w.kind = 'click' and c.project_id = p_project
    group by 1, 2
  )
  select k.d, w.id, w.link_id, w.kind, k.n, k.n * w.amount, w.currency,
    l.source, coalesce(l.campaign, ''), coalesce(l.adset, ''), coalesce(l.ad, '')
  from counts k
  join windows w on w.id = k.rule_id
  join public.attribution_links l on l.id = w.link_id
$$;

-- Every cost of a project with its day between p_from and p_to (both included), in its own
-- currency: typed and uploaded spend (and, later, spend read from the ad platforms), and the
-- link prices (origin link_install or link_click, with the link). The definition from
-- 20261122100000_attribution_roi_base.sql with the link prices added; same columns.
create or replace function kma_internal.attribution_cost_lines(p_project uuid, p_from date, p_to date)
returns table (day date, source text, campaign text, adset text, ad text, link_id uuid,
  amount numeric, currency text, origin text)
language sql stable set search_path = '' as $$
  select c.day, c.source, c.campaign, c.adset, c.ad, null::uuid, c.amount, c.currency, c.origin
  from public.attribution_costs c
  where c.project_id = p_project and c.day >= p_from and c.day <= p_to
  union all
  select l.day, l.source, l.campaign, l.adset, l.ad, l.link_id, l.amount, l.currency, 'link_' || l.kind
  from kma_internal.attribution_link_costs(p_project, p_from, p_to) l
$$;

-- Checking what the console sends ---------------------------------------------------------------

-- A calendar day written YYYY-MM-DD, or null when it is not one (2026-13-01, 2026-02-30).
-- Checked by hand so a bad day never raises.
create function kma_internal.attribution_cost_date(p_value text) returns date
language plpgsql immutable set search_path = '' as $$
declare
  y integer;
  m integer;
  d integer;
  last_day integer;
begin
  if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  y := substr(p_value, 1, 4)::integer;
  m := substr(p_value, 6, 2)::integer;
  d := substr(p_value, 9, 2)::integer;
  if y < 1 or m not between 1 and 12 or d < 1 then
    return null;
  end if;
  last_day := case
    when m = 2 then case when (y % 4 = 0 and y % 100 <> 0) or y % 400 = 0 then 29 else 28 end
    when m in (4, 6, 9, 11) then 30 else 31 end;
  if d > last_day then
    return null;
  end if;
  return make_date(y, m, d);
end $$;

-- An amount sent as a JSON number or as plain decimal text ("1234.5"), or null.
create function kma_internal.attribution_cost_number(p_value jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select case jsonb_typeof(p_value)
    when 'number' then (p_value #>> '{}')::numeric
    when 'string' then case when btrim(p_value #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then btrim(p_value #>> '{}')::numeric end
  end
$$;

-- One spend row as the console or a spreadsheet sends it ({day, source, campaign?, adset?,
-- ad?, amount, currency?}; any other field is ignored), checked and tidied: the source in lower
-- case, the names trimmed (empty when none), the currency the project's when none is given.
-- Returns the tidy row, or {"error": what is wrong, in plain words}.
create function kma_internal.attribution_cost_row(p_row jsonb, p_currency text, p_today date) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_text text;
  v_day date;
  v_source text;
  v_names text[] := array['', '', ''];
  v_amount numeric;
  v_currency text := p_currency;
  k text;
  i integer := 0;
begin
  if jsonb_typeof(p_row) is distinct from 'object' then
    return jsonb_build_object('error', 'Each row needs a day, a source and an amount');
  end if;

  if jsonb_typeof(p_row->'day') is distinct from 'string' or btrim(p_row->>'day') = '' then
    return jsonb_build_object('error', 'Add the day, as YYYY-MM-DD');
  end if;
  v_text := left(btrim(p_row->>'day'), 40);
  v_day := kma_internal.attribution_cost_date(v_text);
  if v_day is null then
    return jsonb_build_object('error', format('Day %s is not a date', v_text));
  elsif v_day > p_today then
    return jsonb_build_object('error', format('Day %s is in the future', v_text));
  elsif v_day < (p_today - interval '2 years')::date then
    return jsonb_build_object('error', format('Day %s is more than 2 years ago', v_text));
  end if;

  if jsonb_typeof(p_row->'source') is distinct from 'string' or btrim(p_row->>'source') = '' then
    return jsonb_build_object('error', 'Add the source, such as meta or tiktok');
  end if;
  v_source := lower(btrim(p_row->>'source'));
  if v_source !~ '^[a-z0-9][a-z0-9_.-]{0,59}$' then
    return jsonb_build_object('error', format(
      'Source %s is not a source name: use up to 60 letters, numbers and _ . -, such as meta or tiktok',
      left(btrim(p_row->>'source'), 60)));
  end if;

  foreach k in array array['campaign', 'adset', 'ad'] loop
    i := i + 1;
    continue when coalesce(jsonb_typeof(p_row->k), 'null') = 'null';
    if jsonb_typeof(p_row->k) <> 'string' then
      return jsonb_build_object('error', format('%s is text', case k when 'campaign' then 'Campaign' when 'adset' then 'Ad set' else 'Ad' end));
    end if;
    v_names[i] := btrim(p_row->>k);
    if length(v_names[i]) > 200 then
      return jsonb_build_object('error', format('%s is up to 200 characters', case k when 'campaign' then 'Campaign' when 'adset' then 'Ad set' else 'Ad' end));
    end if;
  end loop;
  if v_names[1] = '' and v_names[2] <> '' then
    return jsonb_build_object('error', 'An ad set needs a campaign');
  elsif v_names[2] = '' and v_names[3] <> '' then
    return jsonb_build_object('error', 'An ad needs an ad set');
  end if;

  if coalesce(jsonb_typeof(p_row->'amount'), 'null') = 'null' then
    return jsonb_build_object('error', 'Add the amount');
  end if;
  v_amount := kma_internal.attribution_cost_number(p_row->'amount');
  if v_amount is null then
    return jsonb_build_object('error', case when jsonb_typeof(p_row->'amount') = 'string'
      then format('Amount %s is not a number', left(btrim(p_row->>'amount'), 40))
      else 'The amount is a number, such as 120.50' end);
  elsif v_amount < 0 then
    return jsonb_build_object('error', 'The amount cannot be negative');
  elsif v_amount > 1000000000 then
    return jsonb_build_object('error', 'The amount is at most 1,000,000,000');
  end if;

  if coalesce(jsonb_typeof(p_row->'currency'), 'null') <> 'null' and btrim(coalesce(p_row->>'currency', '')) <> '' then
    v_currency := upper(btrim(p_row->>'currency'));
    if jsonb_typeof(p_row->'currency') <> 'string' or v_currency !~ '^[A-Z]{3}$' then
      return jsonb_build_object('error', format('Currency %s is not a three-letter code, such as USD', left(btrim(p_row->>'currency'), 20)));
    end if;
  end if;

  return jsonb_build_object('day', v_day, 'source', v_source, 'campaign', v_names[1], 'adset', v_names[2],
    'ad', v_names[3], 'amount', v_amount, 'currency', v_currency);
end $$;

-- A link price as the console shows it.
create function kma_internal.attribution_cost_rule_view(r public.attribution_cost_rules, l public.attribution_links) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', r.id, 'link_id', r.link_id, 'link_name', l.name, 'link_source', l.source,
    'link_campaign', coalesce(l.campaign, ''), 'kind', r.kind,
    -- A price, not a total: a click can cost a fraction of a cent, so it is shown as stored.
    'amount', trim_scale(r.amount), 'currency', r.currency,
    'starts_on', r.starts_on, 'ends_on', r.ends_on, 'updated_at', r.updated_at)
$$;

-- The console --------------------------------------------------------------------------------

-- The Costs screen. Input {"range": "7d"|"30d"|"90d" (default 30d), "source"?: a source}. The
-- source filter is a source family (attribution_source_family: "facebook" means meta) and
-- narrows rows, link_costs and totals; imports, rules and sources are the project's whole
-- lists. Days are the project's days. Totals are in the project's currency, converted per day
-- and currency with the ECB's rate; a cost line without a rate is left out and counted in
-- unconverted.
create function public.attribution_costs(p_project uuid, p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.analytics_projects := kma_internal.analytics_require_project(p_project);
  s public.attribution_settings := kma_internal.attribution_require_settings(p_project);
  v_input jsonb := coalesce(p_input, '{}'::jsonb);
  v_range text;
  v_family text;
  v_from date;
  v_to date;
  v_today date := (now() at time zone p.timezone)::date;
  v_totals jsonb;
  w record;
begin
  if jsonb_typeof(v_input) <> 'object' then
    raise exception 'Choose 7, 30 or 90 days' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_range := coalesce(nullif(v_input->>'range', ''), '30d');
  if v_range not in ('7d', '30d', '90d') then
    raise exception 'Choose 7, 30 or 90 days' using errcode = '22023', detail = 'invalid_input';
  end if;
  if jsonb_typeof(v_input->'source') = 'string' and btrim(v_input->>'source') <> '' then
    v_family := kma_internal.attribution_source_family(left(v_input->>'source', 100));
  end if;
  select * into w from kma_internal.analytics_window(v_range, p.timezone);
  v_from := (w.from_at at time zone p.timezone)::date;
  v_to := ((w.to_at - interval '1 microsecond') at time zone p.timezone)::date;

  with lines as (
    select x.day, x.currency, x.origin, x.amount
    from kma_internal.attribution_cost_lines(p_project, v_from, v_to) x
    where v_family is null or kma_internal.attribution_source_family(x.source) = v_family
  ), grouped as (
    select g.day, g.currency, g.origin, sum(g.amount) amount, count(*) n from lines g group by 1, 2, 3
  ), converted as (
    select g.origin, g.n, g.amount * kma_internal.attribution_fx_rate(g.currency, s.currency, g.day) amount
    from grouped g
  )
  select jsonb_build_object(
    'cost', round(coalesce(sum(c.amount), 0), 2),
    'typed', round(coalesce(sum(c.amount) filter (where c.origin = 'manual'), 0), 2),
    'uploaded', round(coalesce(sum(c.amount) filter (where c.origin = 'csv'), 0), 2),
    'links', round(coalesce(sum(c.amount) filter (where c.origin in ('link_install', 'link_click')), 0), 2),
    'unconverted', coalesce(sum(c.n) filter (where c.amount is null), 0))
  into v_totals
  from converted c;

  return jsonb_build_object(
    'currency', s.currency,
    'range', v_range,
    'from', v_from,
    'to', v_to,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'day', c.day, 'source', c.source, 'campaign', c.campaign,
          'adset', c.adset, 'ad', c.ad, 'amount', round(c.amount, 2), 'currency', c.currency, 'origin', c.origin,
          'import_id', c.import_id, 'updated_at', c.updated_at)
        order by c.day desc, c.source, c.campaign, c.adset, c.ad)
      from (
        select * from public.attribution_costs x
        where x.project_id = p_project and x.day >= v_from and x.day <= v_to and x.origin in ('manual', 'csv')
          and (v_family is null or kma_internal.attribution_source_family(x.source) = v_family)
        order by x.day desc, x.source, x.campaign, x.adset, x.ad
        limit 1000
      ) c), '[]'::jsonb),
    'link_costs', coalesce((
      select jsonb_agg(jsonb_build_object('day', c.day, 'link_id', c.link_id, 'link_name', c.link_name,
          'source', c.source, 'campaign', c.campaign, 'kind', c.kind, 'count', c.units,
          'amount', round(c.amount, 2), 'currency', c.currency)
        order by c.day desc, c.link_name, c.link_id, c.kind)
      from (
        select x.*, l.name link_name
        from kma_internal.attribution_link_costs(p_project, v_from, v_to) x
        join public.attribution_links l on l.id = x.link_id
        where v_family is null or kma_internal.attribution_source_family(x.source) = v_family
        order by x.day desc, l.name, x.link_id, x.kind
        limit 1000
      ) c), '[]'::jsonb),
    'totals', v_totals,
    'imports', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'file_name', i.file_name, 'rows', i.rows,
          'created_at', i.created_at,
          'remaining', (select count(*) from public.attribution_costs c where c.import_id = i.id))
        order by i.created_at desc, i.id)
      from (
        select * from public.attribution_cost_imports x where x.project_id = p_project
        order by x.created_at desc, x.id limit 20
      ) i), '[]'::jsonb),
    'rules', coalesce((
      select jsonb_agg(kma_internal.attribution_cost_rule_view(r, l) order by l.name, r.created_at, r.id)
      from public.attribution_cost_rules r
      join public.attribution_links l on l.id = r.link_id
      where r.project_id = p_project), '[]'::jsonb),
    -- Names to suggest when typing spend: the source families this project saw in the last 90
    -- days, most seen first. Only names spend can be saved under.
    'sources', coalesce((
      select jsonb_agg(f.family order by f.n desc, f.family)
      from (
        select y.family, count(*) n
        from (
          select kma_internal.attribution_source_family(i.source) family
          from public.attribution_installs i
          where i.project_id = p_project and i.environment = 'production' and i.installed_at >= now() - interval '90 days'
          union all
          select kma_internal.attribution_source_family(c.source)
          from public.attribution_clicks c
          where c.project_id = p_project and c.clicked_at >= now() - interval '90 days'
          union all
          select kma_internal.attribution_source_family(coalesce(nullif(btrim(se.utm_source), ''),
            kma_internal.attribution_click_source(se.click_ids)))
          from public.analytics_sessions se
          where se.project_id = p_project and se.environment = 'production' and se.started_at >= now() - interval '90 days'
          union all
          select kma_internal.attribution_source_family(c.source)
          from public.attribution_costs c
          where c.project_id = p_project and c.day >= v_today - 90
        ) y
        where y.family ~ '^[a-z0-9][a-z0-9_.-]{0,59}$'
        group by y.family
        order by count(*) desc, y.family
        limit 30
      ) f), '[]'::jsonb)
  );
end $$;

-- Types in spend. Input {"rows": [{"id"?: uuid, "day", "source", "campaign"?, "adset"?, "ad"?,
-- "amount", "currency"?}]}, 1 to 500 rows. A row with an id changes that row of the project
-- (typed or uploaded), which becomes typed. A row without one is written on its day, source,
-- campaign, ad set and ad; a row already there (typed, uploaded or read from an ad platform)
-- is replaced and becomes typed. Two rows of one call may not share those names. Any bad row
-- stops the call and nothing is written. Output {"saved": n}.
create function public.attribution_cost_save(p_project uuid, p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.analytics_projects := kma_internal.analytics_require_project(p_project, 'developer');
  s public.attribution_settings := kma_internal.attribution_require_settings(p_project);
  v_today date := (now() at time zone p.timezone)::date;
  v_rows jsonb := case when jsonb_typeof(p_input) = 'object' then p_input->'rows' end;
  v_count integer;
  v_input jsonb;
  v_row jsonb;
  v_label text;
  v_key text;
  v_seen jsonb := '{}'::jsonb;
  v_id uuid;
  v_n integer := 0;
begin
  if jsonb_typeof(v_rows) is distinct from 'array' or jsonb_array_length(v_rows) not between 1 and 500 then
    raise exception 'Send 1 to 500 rows' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_count := jsonb_array_length(v_rows);
  for v_input in select x.value from jsonb_array_elements(v_rows) x loop
    v_n := v_n + 1;
    v_label := case when v_count > 1 then format('Row %s: ', v_n) else '' end;
    v_row := kma_internal.attribution_cost_row(v_input, s.currency, v_today);
    if v_row ? 'error' then
      raise exception '%', v_label || (v_row->>'error') using errcode = '22023', detail = 'invalid_input';
    end if;
    v_key := jsonb_build_array(v_row->'day', v_row->'source', v_row->'campaign', v_row->'adset', v_row->'ad')::text;
    if v_seen ? v_key then
      raise exception 'Row % repeats row %: same day, source, campaign, ad set and ad', v_n, v_seen->>v_key
        using errcode = '22023', detail = 'invalid_input';
    end if;
    v_seen := v_seen || jsonb_build_object(v_key, v_n);

    if coalesce(jsonb_typeof(v_input->'id'), 'null') <> 'null' then
      if v_input->>'id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        raise exception '%', v_label || 'Spend row not found' using errcode = 'P0002';
      end if;
      if v_seen ? ('id:' || lower(v_input->>'id')) then
        raise exception 'Row % repeats row %', v_n, v_seen->>('id:' || lower(v_input->>'id'))
          using errcode = '22023', detail = 'invalid_input';
      end if;
      v_seen := v_seen || jsonb_build_object('id:' || lower(v_input->>'id'), v_n);
      begin
        update public.attribution_costs set day = (v_row->>'day')::date, source = v_row->>'source',
          campaign = v_row->>'campaign', adset = v_row->>'adset', ad = v_row->>'ad',
          amount = (v_row->>'amount')::numeric, currency = v_row->>'currency',
          origin = 'manual', import_id = null, updated_at = now()
        where id = (v_input->>'id')::uuid and project_id = p_project and origin in ('manual', 'csv')
        returning id into v_id;
      exception when unique_violation then
        raise exception '%', v_label || 'Another row already has that day, source, campaign, ad set and ad'
          using errcode = '22023', detail = 'invalid_input';
      end;
      if v_id is null then
        raise exception '%', v_label || 'Spend row not found' using errcode = 'P0002';
      end if;
      v_id := null;
    else
      insert into public.attribution_costs(project_id, day, source, campaign, adset, ad, amount, currency, origin, created_by)
      values (p_project, (v_row->>'day')::date, v_row->>'source', v_row->>'campaign', v_row->>'adset', v_row->>'ad',
        (v_row->>'amount')::numeric, v_row->>'currency', 'manual', auth.uid())
      on conflict (project_id, day, source, campaign, adset, ad) do update
      set amount = excluded.amount, currency = excluded.currency, origin = 'manual', import_id = null, updated_at = now();
    end if;
  end loop;
  return jsonb_build_object('saved', v_n);
end $$;

-- Deletes typed and uploaded rows of the project (up to 1,000 at a time). Ids of other projects'
-- rows, or rows that are gone, are passed over. Output {"deleted": n}.
create function public.attribution_cost_delete(p_project uuid, p_ids uuid[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  perform kma_internal.attribution_require_settings(p_project);
  if p_ids is null or cardinality(p_ids) > 1000 then
    raise exception 'Choose up to 1,000 rows to delete' using errcode = '22023', detail = 'invalid_input';
  end if;
  delete from public.attribution_costs
  where project_id = p_project and id = any(p_ids) and origin in ('manual', 'csv');
  get diagnostics v_n = row_count;
  return jsonb_build_object('deleted', v_n);
end $$;

-- A spreadsheet upload, already read by the browser. Input {"file_name"?: text, "rows": [rows
-- as attribution_cost_save takes them, without id]}, 1 to 5,000 rows. All or nothing: when any
-- row is bad (or repeats an earlier row's day, source, campaign, ad set and ad) nothing is
-- written and the answer lists up to 50 problems by row number (1 = the first row sent).
-- Otherwise every row is written as uploaded, replacing any row with the same names.
-- Output {"import_id": uuid, "imported": n, "replaced": m, "errors": []} or
-- {"imported": 0, "errors": [{"row": 3, "message": "Day 2026-13-01 is not a date"}]}.
create function public.attribution_cost_import(p_project uuid, p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.analytics_projects := kma_internal.analytics_require_project(p_project, 'developer');
  s public.attribution_settings := kma_internal.attribution_require_settings(p_project);
  v_today date := (now() at time zone p.timezone)::date;
  v_rows jsonb := case when jsonb_typeof(p_input) = 'object' then p_input->'rows' end;
  v_file text;
  v_checked jsonb;
  v_errors jsonb;
  v_import uuid;
  v_replaced integer;
  v_count integer;
begin
  if jsonb_typeof(v_rows) is distinct from 'array' or jsonb_array_length(v_rows) not between 1 and 5000 then
    raise exception 'Upload 1 to 5,000 rows at a time' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_count := jsonb_array_length(v_rows);
  v_file := nullif(left(btrim(coalesce(p_input->>'file_name', '')), 200), '');

  select jsonb_agg(jsonb_build_object('n', x.ord) || kma_internal.attribution_cost_row(x.value, s.currency, v_today)
      order by x.ord)
  into v_checked
  from jsonb_array_elements(v_rows) with ordinality x(value, ord);

  select coalesce(jsonb_agg(jsonb_build_object('row', e.n, 'message', e.message) order by e.n), '[]'::jsonb)
  into v_errors
  from (
    select c.n, coalesce(c.r->>'error', format('Repeats row %s: same day, source, campaign, ad set and ad', c.first_n)) message
    from (
      select (y->>'n')::integer n, y r,
        min((y->>'n')::integer) over (partition by case when y ? 'error' then null
          else jsonb_build_array(y->'day', y->'source', y->'campaign', y->'adset', y->'ad') end) first_n
      from jsonb_array_elements(v_checked) y
    ) c
    where c.r ? 'error' or c.first_n < c.n
    order by c.n
    limit 50
  ) e;
  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('imported', 0, 'errors', v_errors);
  end if;

  -- clock_timestamp: two uploads in one transaction still list newest first.
  insert into public.attribution_cost_imports(project_id, file_name, rows, created_by, created_at)
  values (p_project, v_file, v_count, auth.uid(), clock_timestamp())
  returning id into v_import;
  select count(*) into v_replaced
  from jsonb_array_elements(v_checked) y
  join public.attribution_costs c on c.project_id = p_project and c.day = (y->>'day')::date and c.source = y->>'source'
    and c.campaign = y->>'campaign' and c.adset = y->>'adset' and c.ad = y->>'ad';
  insert into public.attribution_costs(project_id, day, source, campaign, adset, ad, amount, currency, origin, import_id, created_by)
  select p_project, (y->>'day')::date, y->>'source', y->>'campaign', y->>'adset', y->>'ad', (y->>'amount')::numeric,
    y->>'currency', 'csv', v_import, auth.uid()
  from jsonb_array_elements(v_checked) y
  on conflict (project_id, day, source, campaign, adset, ad) do update
  set amount = excluded.amount, currency = excluded.currency, origin = 'csv', import_id = excluded.import_id,
    updated_at = now();
  return jsonb_build_object('import_id', v_import, 'imported', v_count, 'replaced', v_replaced, 'errors', '[]'::jsonb);
end $$;

-- Undoes an upload: deletes the rows it wrote that are still its own (not since replaced or
-- deleted) and the upload. Output {"deleted": rows deleted}.
create function public.attribution_cost_import_undo(p_project uuid, p_import uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  perform kma_internal.attribution_require_settings(p_project);
  perform 1 from public.attribution_cost_imports where id = p_import and project_id = p_project for update;
  if not found then
    raise exception 'Upload not found' using errcode = 'P0002';
  end if;
  delete from public.attribution_costs where import_id = p_import and project_id = p_project;
  get diagnostics v_n = row_count;
  delete from public.attribution_cost_imports where id = p_import;
  return jsonb_build_object('deleted', v_n);
end $$;

-- Sets a link's price per install or per click. Input {"link_id": uuid, "kind": "install"|
-- "click", "amount": number, "currency"?: text (default the project's), "starts_on":
-- "YYYY-MM-DD", "ends_on"?: "YYYY-MM-DD"|null}. A link has one price: saving again replaces
-- it (same id). Output: the price as attribution_costs lists it.
create function public.attribution_cost_rule_save(p_project uuid, p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.analytics_projects := kma_internal.analytics_require_project(p_project, 'developer');
  s public.attribution_settings := kma_internal.attribution_require_settings(p_project);
  v_link public.attribution_links;
  v_kind text;
  v_amount numeric;
  v_currency text := s.currency;
  v_start date;
  v_end date;
  v_rule public.attribution_cost_rules;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
     or coalesce(p_input->>'link_id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'Choose one of the project''s links' using errcode = '22023', detail = 'invalid_input';
  end if;
  select * into v_link from public.attribution_links where id = (p_input->>'link_id')::uuid and project_id = p_project;
  if v_link.id is null then
    raise exception 'Link not found' using errcode = 'P0002';
  end if;
  v_kind := p_input->>'kind';
  if v_kind is null or v_kind not in ('install', 'click') then
    raise exception 'Choose a price per install or per click' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_amount := kma_internal.attribution_cost_number(p_input->'amount');
  if v_amount is null or round(v_amount, 6) <= 0 or v_amount > 1000000 then
    raise exception 'Set a price above 0 and up to 1,000,000' using errcode = '22023', detail = 'invalid_input';
  end if;
  if coalesce(jsonb_typeof(p_input->'currency'), 'null') <> 'null' and btrim(coalesce(p_input->>'currency', '')) <> '' then
    v_currency := upper(btrim(p_input->>'currency'));
    if jsonb_typeof(p_input->'currency') <> 'string' or v_currency !~ '^[A-Z]{3}$' then
      raise exception 'Currency % is not a three-letter code, such as USD', left(btrim(p_input->>'currency'), 20)
        using errcode = '22023', detail = 'invalid_input';
    end if;
  end if;
  if jsonb_typeof(p_input->'starts_on') is distinct from 'string' or btrim(p_input->>'starts_on') = '' then
    raise exception 'Add the first day the price applies, as YYYY-MM-DD' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_start := kma_internal.attribution_cost_date(btrim(p_input->>'starts_on'));
  if v_start is null then
    raise exception 'Start date % is not a date', left(btrim(p_input->>'starts_on'), 40) using errcode = '22023', detail = 'invalid_input';
  end if;
  if coalesce(jsonb_typeof(p_input->'ends_on'), 'null') <> 'null' and btrim(coalesce(p_input->>'ends_on', '')) <> '' then
    v_end := case when jsonb_typeof(p_input->'ends_on') = 'string' then kma_internal.attribution_cost_date(btrim(p_input->>'ends_on')) end;
    if v_end is null then
      raise exception 'End date % is not a date', left(btrim(p_input->>'ends_on'), 40) using errcode = '22023', detail = 'invalid_input';
    elsif v_end < v_start then
      raise exception 'The last day is on or after the first day' using errcode = '22023', detail = 'invalid_input';
    end if;
  end if;
  insert into public.attribution_cost_rules(project_id, link_id, kind, amount, currency, starts_on, ends_on, created_by)
  values (p_project, v_link.id, v_kind, v_amount, v_currency, v_start, v_end, auth.uid())
  on conflict (link_id) do update
  set kind = excluded.kind, amount = excluded.amount, currency = excluded.currency, starts_on = excluded.starts_on,
    ends_on = excluded.ends_on, updated_at = now()
  returning * into v_rule;
  return kma_internal.attribution_cost_rule_view(v_rule, v_link);
end $$;

-- Removes a link's price. Output {"deleted": 1}.
create function public.attribution_cost_rule_delete(p_project uuid, p_rule uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  perform kma_internal.attribution_require_settings(p_project);
  delete from public.attribution_cost_rules where id = p_rule and project_id = p_project;
  if not found then
    raise exception 'Link price not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('deleted', 1);
end $$;

revoke all on function kma_internal.attribution_link_costs(uuid, date, date) from public, anon, authenticated;
revoke all on function kma_internal.attribution_cost_date(text) from public, anon, authenticated;
revoke all on function kma_internal.attribution_cost_number(jsonb) from public, anon, authenticated;
revoke all on function kma_internal.attribution_cost_row(jsonb, text, date) from public, anon, authenticated;
revoke all on function kma_internal.attribution_cost_rule_view(public.attribution_cost_rules, public.attribution_links)
  from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array['attribution_costs(uuid,jsonb)', 'attribution_cost_save(uuid,jsonb)',
    'attribution_cost_delete(uuid,uuid[])', 'attribution_cost_import(uuid,jsonb)', 'attribution_cost_import_undo(uuid,uuid)',
    'attribution_cost_rule_save(uuid,jsonb)', 'attribution_cost_rule_delete(uuid,uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
