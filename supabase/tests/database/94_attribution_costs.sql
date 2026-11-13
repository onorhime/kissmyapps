-- Provider-free test of Attribution Phase 3, piece B: ad spend typed in the console, uploaded
-- as a spreadsheet (already read by the browser), and fixed prices per install or per click
-- on a smart link.
--
-- The project keeps Tokyo time, so a day is Tokyo's day: a click at 00:30 in Tokyo is on the
-- day before in UTC. Clicks come from the link service through attribution_record_clicks, app
-- installs through attribution_install as the analytics-ingest edge function makes them, the
-- website visit through analytics_ingest, the bot mark through analytics_set_override. The
-- ECB rates are inserted directly (piece A's worker writes them), and say so.
begin;
set local time zone 'UTC';
create temporary table cost_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Attribution cost assertion failed: %', label; end if;
  insert into cost_assertions values (label);
end $$;
create function pg_temp.as_user(id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', id, 'role', 'authenticated')::text, true)
$$;
-- 'ok', or the SQLSTATE and the message the console would show.
create function pg_temp.err(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- The DETAIL of a refusal.
create function pg_temp.detail(statement text) returns text language plpgsql as $$
declare reason text;
begin
  execute statement;
  return 'ok';
exception when others then
  get stacked diagnostics reason = pg_exception_detail;
  return reason;
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
create function pg_temp.v(k text) returns text language sql as $$ select value from qa where key = k $$;
create function pg_temp.j(k text) returns jsonb language sql as $$ select value::jsonb from qa where key = k $$;
create function pg_temp.keep(k text, value jsonb) returns jsonb language sql as $$
  insert into qa values (k, value::text) on conflict (key) do update set value = excluded.value returning value::jsonb
$$;
-- Prints one function result as the front ends receive it (kept by KMA_DB_TEST_OUTPUT).
create function pg_temp.capture(name text, result jsonb) returns text language sql as $$
  select 'capture ' || name || ' ' || result::text
$$;
-- Tokyo's today, a day before it as YYYY-MM-DD, and a Tokyo clock time on a day before today
-- as the apps and the link service write times (UTC, milliseconds).
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Asia/Tokyo')::date $$;
create function pg_temp.d(days_ago integer) returns text language sql as $$ select (pg_temp.today() - days_ago)::text $$;
create function pg_temp.tokyo(days_ago integer, local_time text) returns text language sql as $$
  select to_char((((pg_temp.today() - days_ago)::timestamp + local_time::interval) at time zone 'Asia/Tokyo') at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
create function pg_temp.at(minutes_ago numeric) returns text language sql as $$
  select to_char((now() - make_interval(secs => minutes_ago * 60)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
create function pg_temp.device(name text) returns text language sql as $$
  select encode(extensions.digest(name, 'sha256'), 'hex')
$$;
-- An app's install call as the edge function makes it: the ingest envelope, as the service
-- role, nobody signed in. Android with Google Play's install referrer.
create function pg_temp.install(anon text, installed_at text, extra jsonb default '{}', app_key text default null)
returns jsonb language plpgsql as $$
declare
  result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  result := public.attribution_install(jsonb_build_object(
    'key_hash', encode(extensions.digest(coalesce(app_key, pg_temp.v('live_key')), 'sha256'), 'hex'), 'origin', null,
    'body', jsonb_build_object('anonymous_id', anon, 'session_id', 'session-' || anon, 'platform', 'android',
      'installed_at', installed_at, 'sdk', 'kma-android/1.1.0', 'app_version', '3.0.0') || extra,
    'geo', jsonb_build_object('country', 'JP', 'region', 'Tokyo', 'city', 'Tokyo', 'source', 'ip'),
    'ip_sha', repeat('c', 64), 'user_agent', 'Kanji/3.0.0 okhttp', 'clock_skew_ms', 0));
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- Clicks from the link service, through the function it calls.
create function pg_temp.clicks(clicks jsonb) returns integer language plpgsql as $$
declare result integer;
begin
  set local role service_role;
  result := public.attribution_record_clicks(clicks);
  reset role;
  return result;
end $$;
create function pg_temp.click(id text, link text, clicked_at text, platform text, destination text) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'link_id', pg_temp.v(link), 'clicked_at', clicked_at, 'platform', platform,
    'destination', destination, 'ip_sha', repeat('a', 64))
$$;
-- A web SDK request: a visit that lands with ctx.
create function pg_temp.visit(anon text, minutes_ago numeric, ctx jsonb) returns jsonb language sql as $$
  select public.analytics_ingest(jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.v('live_key'), 'sha256'), 'hex'),
    'origin', 'https://kanji.example.test',
    'body', jsonb_build_object(
      'anonymous_id', anon,
      'session', jsonb_build_object('id', 'web-' || anon, 'started_at', pg_temp.at(minutes_ago)),
      'context', jsonb_build_object('platform', 'web', 'browser', 'Safari', 'device_type', 'mobile', 'interactions', 3,
        'page_path', '/') || ctx,
      'events', jsonb_build_array(jsonb_build_object('name', 'page_view', 'insert_id', anon || ':page_view',
        'time', pg_temp.at(minutes_ago), 'properties', '{}'::jsonb)))))
$$;
create function pg_temp.person(anon text) returns uuid language sql as $$
  select id from public.analytics_people where project_id = pg_temp.q('project')
    and (distinct_id = anon or anon = any(anonymous_ids)) limit 1
$$;
create function pg_temp.installed(anon text) returns public.attribution_installs language sql as $$
  select i from public.attribution_installs i where i.person_id = pg_temp.person(anon)
$$;
-- The console's calls on the Tokyo project, as whoever is signed in.
create function pg_temp.costs(input jsonb default '{"range": "30d"}') returns jsonb language sql as $$
  select public.attribution_costs(pg_temp.q('project'), input)
$$;
create function pg_temp.save(rows jsonb) returns jsonb language sql as $$
  select public.attribution_cost_save(pg_temp.q('project'), jsonb_build_object('rows', rows))
$$;
create function pg_temp.save_err(rows jsonb) returns text language sql as $$
  select pg_temp.err(format('select public.attribution_cost_save(%L, %L)', pg_temp.q('project'), jsonb_build_object('rows', rows)))
$$;
create function pg_temp.import(input jsonb) returns jsonb language sql as $$
  select public.attribution_cost_import(pg_temp.q('project'), input)
$$;
create function pg_temp.rule(input jsonb) returns jsonb language sql as $$
  select public.attribution_cost_rule_save(pg_temp.q('project'), input)
$$;
create function pg_temp.rule_err(input jsonb) returns text language sql as $$
  select pg_temp.err(format('select public.attribution_cost_rule_save(%L, %L)', pg_temp.q('project'), input))
$$;
-- A spend row as the console sends it.
create function pg_temp.r(days_ago integer, source text, amount numeric, extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('day', pg_temp.d(days_ago), 'source', source, 'amount', amount) || extra
$$;
-- The stored row of a day and names, and the same row in a costs answer.
create function pg_temp.stored(p_days integer, p_source text, p_campaign text default '', p_adset text default '', p_ad text default '')
returns public.attribution_costs language sql as $$
  select c from public.attribution_costs c where c.project_id = pg_temp.q('project') and c.day = pg_temp.today() - p_days
    and c.source = p_source and c.campaign = p_campaign and c.adset = p_adset and c.ad = p_ad
$$;
create function pg_temp.listed(report jsonb, p_days integer, p_source text, p_campaign text default '') returns jsonb language sql as $$
  select x from jsonb_array_elements(report->'rows') x
  where x->>'day' = pg_temp.d(p_days) and x->>'source' = p_source and x->>'campaign' = p_campaign and x->>'adset' = '' and x->>'ad' = ''
$$;
create function pg_temp.import_listed(report jsonb, id uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(report->'imports') x where (x->>'id')::uuid = id
$$;
-- The link prices' cost lines of the last 30 Tokyo days, oldest first, without ids.
create function pg_temp.link_lines() returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('days_ago', pg_temp.today() - l.day, 'link', k.key, 'origin', l.origin,
      'amount', l.amount, 'currency', l.currency, 'source', l.source, 'campaign', l.campaign, 'adset', l.adset, 'ad', l.ad)
    order by l.day, k.key), '[]'::jsonb)
  from kma_internal.attribution_cost_lines(pg_temp.q('project'), pg_temp.today() - 29, pg_temp.today()) l
  join qa k on k.key in ('ada', 'tt', 'old', 'qr') and k.value::uuid = l.link_id
$$;
grant all on qa, cost_assertions to authenticated, service_role;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('f9400000-0000-4000-8000-000000000001', 'owner@kanji.example.test', now(), '{"full_name":"Ada Owner"}'::jsonb),
  ('f9400000-0000-4000-8000-000000000002', 'analyst@kanji.example.test', now(), '{}'),
  ('f9400000-0000-4000-8000-000000000003', 'developer@kanji.example.test', now(), '{}'),
  ('f9400000-0000-4000-8000-000000000004', 'stranger@elsewhere.example.test', now(), '{}');

-- Closed by default ----------------------------------------------------------------------------
select pg_temp.check((select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
  from unnest(array['public.attribution_costs(uuid,jsonb)', 'public.attribution_cost_save(uuid,jsonb)',
    'public.attribution_cost_delete(uuid,uuid[])', 'public.attribution_cost_import(uuid,jsonb)',
    'public.attribution_cost_import_undo(uuid,uuid)', 'public.attribution_cost_rule_save(uuid,jsonb)',
    'public.attribution_cost_rule_delete(uuid,uuid)']) f), 'members call the cost functions, visitors do not');
select pg_temp.check((select count(*) = 7 and bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
  from pg_proc p where p.oid in ('public.attribution_costs(uuid,jsonb)'::regprocedure, 'public.attribution_cost_save(uuid,jsonb)'::regprocedure,
    'public.attribution_cost_delete(uuid,uuid[])'::regprocedure, 'public.attribution_cost_import(uuid,jsonb)'::regprocedure,
    'public.attribution_cost_import_undo(uuid,uuid)'::regprocedure, 'public.attribution_cost_rule_save(uuid,jsonb)'::regprocedure,
    'public.attribution_cost_rule_delete(uuid,uuid)'::regprocedure)), 'they run as their owner with an empty search path');
select pg_temp.check((select bool_and(not has_function_privilege(r, f, 'execute'))
  from unnest(array['kma_internal.attribution_cost_lines(uuid,date,date)', 'kma_internal.attribution_link_costs(uuid,date,date)',
    'kma_internal.attribution_cost_row(jsonb,text,date)']) f, unnest(array['anon', 'authenticated']) r),
  'the cost lines and the row check are internal');
select pg_temp.check(not has_table_privilege('authenticated', 'public.attribution_costs', 'select')
  and not has_table_privilege('authenticated', 'public.attribution_cost_imports', 'select')
  and not has_table_privilege('authenticated', 'public.attribution_cost_rules', 'select')
  and not has_table_privilege('anon', 'public.attribution_costs', 'select'), 'spend is read only through functions');

-- A project in Tokyo with attribution on, its links, members and neighbours ----------------------
select pg_temp.as_user('f9400000-0000-4000-8000-000000000001');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Kanji', array['ios', 'android', 'web'], 'Asia/Tokyo') r)
insert into qa select 'project', r->'project'->>'id' from created
union all select 'live_key', r->'key'->>('to' || 'ken') from created;
insert into qa select 'dev_key', public.analytics_create_key(pg_temp.q('project'), 'Staging', 'client', 'development')->>('to' || 'ken');
select public.analytics_update_project(pg_temp.q('project'), '{"allowed_origins":["https://kanji.example.test"]}'::jsonb);
select public.attribution_enable(pg_temp.q('project'), 'kanji');
insert into qa select 'ada', public.attribution_save_link(pg_temp.q('project'), null,
  '{"name":"Ada''s reels","path":"ada","source":"instagram","campaign":"ada-reels"}')->>'id';
insert into qa select 'tt', public.attribution_save_link(pg_temp.q('project'), null, '{"name":"TikTok bio","path":"tt","source":"tiktok"}')->>'id';
insert into qa select 'old', public.attribution_save_link(pg_temp.q('project'), null, '{"name":"Newsletter","path":"news","source":"email"}')->>'id';
insert into qa select 'qr', public.attribution_save_link(pg_temp.q('project'), null, '{"name":"Poster","path":"poster","source":"qr"}')->>'id';
-- A project of the same workspace without attribution, and one with a link of its own.
insert into qa select 'quiet', public.analytics_create_project(pg_temp.q('workspace'), 'Quiet', array['web'], 'UTC')->'project'->>'id';
insert into qa select 'other', public.analytics_create_project(pg_temp.q('workspace'), 'Other', array['android'], 'UTC')->'project'->>'id';
select public.attribution_enable(pg_temp.q('other'), 'kanji-other');
insert into qa select 'other_link', public.attribution_save_link(pg_temp.q('other'), null, '{"name":"Other","path":"ada","source":"tiktok"}')->>'id';
select public.attribution_cost_save(pg_temp.q('other'), jsonb_build_object('rows', jsonb_build_array(pg_temp.r(1, 'meta', 500, '{"campaign":"spring"}'))));
insert into qa select 'other_row', id::text from public.attribution_costs where project_id = pg_temp.q('other');
select public.analytics_invite_member(pg_temp.q('workspace'), 'analyst@kanji.example.test', 'analyst');
select public.analytics_invite_member(pg_temp.q('workspace'), 'developer@kanji.example.test', 'developer');
select pg_temp.as_user('f9400000-0000-4000-8000-000000000002');
select public.analytics_bootstrap();
select pg_temp.as_user('f9400000-0000-4000-8000-000000000003');
select public.analytics_bootstrap();
select pg_temp.as_user('f9400000-0000-4000-8000-000000000004');
select public.analytics_bootstrap();

-- Nothing yet --------------------------------------------------------------------------------------
select pg_temp.as_user('f9400000-0000-4000-8000-000000000002');
select pg_temp.keep('empty', pg_temp.costs());
select pg_temp.capture('costs_empty', pg_temp.j('empty'));
select pg_temp.check(pg_temp.j('empty') = jsonb_build_object('currency', 'USD', 'range', '30d', 'from', pg_temp.d(29), 'to', pg_temp.d(0),
  'rows', '[]'::jsonb, 'link_costs', '[]'::jsonb, 'imports', '[]'::jsonb, 'rules', '[]'::jsonb, 'sources', '[]'::jsonb,
  'totals', '{"cost": 0, "typed": 0, "uploaded": 0, "links": 0, "unconverted": 0}'::jsonb),
  'an analyst reads an empty Costs screen: 30 Tokyo days, the project''s currency, nothing spent');
select pg_temp.check(pg_temp.costs('{}')->>'range' = '30d' and pg_temp.costs(null)->>'range' = '30d'
  and pg_temp.costs('{"range":"7d"}')->>'from' = pg_temp.d(6) and pg_temp.costs('{"range":"90d"}')->>'from' = pg_temp.d(89)
  and pg_temp.costs('{"range":"90d"}')->>'to' = pg_temp.d(0), 'the range is 7, 30 or 90 Tokyo days up to today, 30 by default');
select pg_temp.check(pg_temp.err(format('select public.attribution_costs(%L, ''{"range":"today"}'')', pg_temp.q('project')))
    = '22023 Choose 7, 30 or 90 days'
  and pg_temp.err(format('select public.attribution_costs(%L, ''{"range":"1y"}'')', pg_temp.q('project'))) = '22023 Choose 7, 30 or 90 days'
  and pg_temp.err(format('select public.attribution_costs(%L, ''[]'')', pg_temp.q('project'))) = '22023 Choose 7, 30 or 90 days',
  'any other range is refused');

-- Typing spend: what is checked -------------------------------------------------------------------
select pg_temp.as_user('f9400000-0000-4000-8000-000000000003');
select pg_temp.check(pg_temp.save_err('[]') = '22023 Send 1 to 500 rows'
  and pg_temp.err(format('select public.attribution_cost_save(%L, ''{}'')', pg_temp.q('project'))) = '22023 Send 1 to 500 rows'
  and pg_temp.save_err((select jsonb_agg(pg_temp.r(1, 'meta', 1, jsonb_build_object('campaign', 'c' || i))) from generate_series(1, 501) i))
    = '22023 Send 1 to 500 rows', 'a save sends 1 to 500 rows');
select pg_temp.check(pg_temp.detail(format('select public.attribution_cost_save(%L, %L)', pg_temp.q('project'),
  jsonb_build_object('rows', jsonb_build_array(pg_temp.r(1, 'meta', -1))))) = 'invalid_input', 'a bad row is invalid_input');
select pg_temp.check(pg_temp.save_err('["meta"]') = '22023 Each row needs a day, a source and an amount'
  and pg_temp.save_err('[{"source":"meta","amount":1}]') = '22023 Add the day, as YYYY-MM-DD'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"day":"2026-13-01"}'))) = '22023 Day 2026-13-01 is not a date'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"day":"2026-02-29"}'))) = '22023 Day 2026-02-29 is not a date'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"day":"13/11/2026"}'))) = '22023 Day 13/11/2026 is not a date'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(-1, 'meta', 1))) = format('22023 Day %s is in the future', pg_temp.d(-1))
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(0, 'meta', 1,
    jsonb_build_object('day', ((pg_temp.today() - interval '2 years')::date - 1)::text))))
    = format('22023 Day %s is more than 2 years ago', ((pg_temp.today() - interval '2 years')::date - 1)::text),
  'the day is a real day, not after Tokyo''s today and not more than 2 years back');
select pg_temp.check(pg_temp.save_err('[{"day":"2026-11-01","amount":1}]') like '22023 %'
  and pg_temp.save_err(jsonb_build_array(jsonb_build_object('day', pg_temp.d(1), 'amount', 1))) = '22023 Add the source, such as meta or tiktok'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, ' ', 1))) = '22023 Add the source, such as meta or tiktok'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'Face Book', 1)))
    = '22023 Source Face Book is not a source name: use up to 60 letters, numbers and _ . -, such as meta or tiktok',
  'the source is a source name');
select pg_temp.check(pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"adset":"broad"}'))) = '22023 An ad set needs a campaign'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"campaign":"spring","ad":"red"}'))) = '22023 An ad needs an ad set'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"campaign":"spring","adset":"  ","ad":"red"}'))) = '22023 An ad needs an ad set'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, jsonb_build_object('campaign', repeat('c', 201)))))
    = '22023 Campaign is up to 200 characters'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"campaign":"spring","adset":7}'))) = '22023 Ad set is text',
  'an ad set needs a campaign, an ad needs an ad set, and names are short text');
select pg_temp.check(pg_temp.save_err(jsonb_build_array(jsonb_build_object('day', pg_temp.d(1), 'source', 'meta'))) = '22023 Add the amount'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"amount":"abc"}'))) = '22023 Amount abc is not a number'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"amount":true}'))) = '22023 The amount is a number, such as 120.50'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', -0.01))) = '22023 The amount cannot be negative'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1000000000.01))) = '22023 The amount is at most 1,000,000,000'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"currency":"US"}'))) = '22023 Currency US is not a three-letter code, such as USD'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"currency":"US1"}'))) = '22023 Currency US1 is not a three-letter code, such as USD',
  'the amount is a number from 0 to a billion, the currency a three-letter code');
select pg_temp.check(pg_temp.save_err(jsonb_build_array(pg_temp.r(3, 'bing', 7), pg_temp.r(3, 'yahoo', 1) - 'amount')) = '22023 Row 2: Add the amount'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(3, 'bing', 7, '{"campaign":"x"}'), pg_temp.r(3, 'Bing', 8, '{"campaign":" x "}')))
    = '22023 Row 2 repeats row 1: same day, source, campaign, ad set and ad'
  and not exists (select 1 from public.attribution_costs where project_id = pg_temp.q('project')),
  'with several rows the message names the row, and one bad row writes nothing');

-- Typing spend: written, replaced, changed, deleted ------------------------------------------------
select pg_temp.check(pg_temp.save(jsonb_build_array(
  pg_temp.r(1, ' Meta ', 120.5, '{"campaign":"  spring "}'),
  pg_temp.r(1, 'Facebook', 30, '{"campaign":"spring","adset":"adset-a","ad":null}'),
  pg_temp.r(2, 'tiktok', 50, '{"currency":"eur","campaign":""}'),
  pg_temp.r(10, 'google_ads', 20, '{"currency":"GBP"}'),
  pg_temp.r(1, 'snapchat', 10, '{"currency":"NGN"}'),
  pg_temp.r(1, 'reddit', 0, '{"amount":"5.25","note":"ignored"}'),
  pg_temp.r(0, 'meta', 1, jsonb_build_object('day', ((pg_temp.today() - interval '2 years')::date)::text, 'campaign', 'old'))))
  = '{"saved": 7}', 'a developer types seven rows of spend');
select pg_temp.check((select c.source = 'meta' and c.campaign = 'spring' and c.adset = '' and c.ad = '' and c.amount = 120.5
  and c.currency = 'USD' and c.origin = 'manual' and c.import_id is null and c.created_by = 'f9400000-0000-4000-8000-000000000003'
  from pg_temp.stored(1, 'meta', 'spring') c), 'the source is lower case, the names trimmed, the currency the project''s');
select pg_temp.check((pg_temp.stored(1, 'facebook', 'spring', 'adset-a')).amount = 30 and (pg_temp.stored(2, 'tiktok')).currency = 'EUR'
  and (pg_temp.stored(1, 'reddit')).amount = 5.25 and (pg_temp.stored(10, 'google_ads')).currency = 'GBP',
  'a source is kept as typed (facebook stays facebook), a currency in capitals, an amount sent as text read');
insert into qa select 'meta_spring', (pg_temp.stored(1, 'meta', 'spring')).id::text;
insert into qa select 'tiktok_row', (pg_temp.stored(2, 'tiktok')).id::text;
insert into qa select 'reddit_row', (pg_temp.stored(1, 'reddit')).id::text;
insert into qa select 'oldest_row', id::text from public.attribution_costs where project_id = pg_temp.q('project') and campaign = 'old';

select pg_temp.check(pg_temp.save(jsonb_build_array(pg_temp.r(1, 'META', 125, '{"campaign":"spring"}'))) = '{"saved": 1}'
  and (select count(*) = 1 from public.attribution_costs where project_id = pg_temp.q('project') and source = 'meta' and campaign = 'spring')
  and (pg_temp.stored(1, 'meta', 'spring')).id = pg_temp.q('meta_spring') and (pg_temp.stored(1, 'meta', 'spring')).amount = 125,
  'typing the same day and names again replaces the amount');
select pg_temp.check(pg_temp.save(jsonb_build_array(pg_temp.r(2, 'tiktok', 60, jsonb_build_object('id', pg_temp.v('tiktok_row'), 'currency', 'EUR'))))
  = '{"saved": 1}' and (pg_temp.stored(2, 'tiktok')).id = pg_temp.q('tiktok_row') and (pg_temp.stored(2, 'tiktok')).amount = 60,
  'a row changes by its id');
select pg_temp.check(pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 60, jsonb_build_object('id', pg_temp.v('tiktok_row'), 'campaign', 'spring'))))
  = '22023 Another row already has that day, source, campaign, ad set and ad'
  and (pg_temp.stored(2, 'tiktok')).amount = 60, 'a row cannot be moved onto another row''s day and names');
select pg_temp.check(pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, jsonb_build_object('id', pg_temp.v('other_row')))))
    = 'P0002 Spend row not found'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"id":"9d1b3a52-0000-4000-8000-000000000000"}'))) = 'P0002 Spend row not found'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1, '{"id":"nope"}'))) = 'P0002 Spend row not found'
  and (select amount = 500 from public.attribution_costs where id = pg_temp.q('other_row')),
  'another project''s row, or a row that is not there, is not found');
select pg_temp.check(public.attribution_cost_delete(pg_temp.q('project'), array[pg_temp.q('reddit_row'), pg_temp.q('oldest_row')]) = '{"deleted": 2}'
  and public.attribution_cost_delete(pg_temp.q('project'), array[pg_temp.q('reddit_row')]) = '{"deleted": 0}'
  and public.attribution_cost_delete(pg_temp.q('project'), array[pg_temp.q('other_row')]) = '{"deleted": 0}'
  and public.attribution_cost_delete(pg_temp.q('project'), '{}') = '{"deleted": 0}'
  and exists (select 1 from public.attribution_costs where id = pg_temp.q('other_row'))
  and pg_temp.err(format('select public.attribution_cost_delete(%L, null)', pg_temp.q('project'))) = '22023 Choose up to 1,000 rows to delete',
  'rows are deleted by id, only the project''s own');

-- Uploading a spreadsheet ---------------------------------------------------------------------------
select pg_temp.check(pg_temp.err(format('select public.attribution_cost_import(%L, ''{"rows":[]}'')', pg_temp.q('project')))
    = '22023 Upload 1 to 5,000 rows at a time'
  and pg_temp.err(format('select public.attribution_cost_import(%L, ''{"rows":{}}'')', pg_temp.q('project'))) = '22023 Upload 1 to 5,000 rows at a time'
  and pg_temp.err(format('select public.attribution_cost_import(%L, %L)', pg_temp.q('project'), jsonb_build_object('rows',
    (select jsonb_agg(pg_temp.r(1, 'meta', 1)) from generate_series(1, 5001))))) = '22023 Upload 1 to 5,000 rows at a time',
  'an upload is 1 to 5,000 rows');
select pg_temp.keep('import_errors', pg_temp.import(jsonb_build_object('file_name', 'bad.csv', 'rows', jsonb_build_array(
  pg_temp.r(2, 'meta', 100, '{"campaign":"spring"}'),
  pg_temp.r(2, 'meta', 1, '{"day":"2026-13-01"}'),
  pg_temp.r(2, 'Face Book', 1),
  pg_temp.r(2, 'meta', 1, '{"campaign":"spring","ad":"red"}'),
  pg_temp.r(2, 'META', 5, '{"campaign":" spring"}'),
  pg_temp.r(2, 'meta', 1, '{"amount":"12,50"}'),
  pg_temp.r(-3, 'meta', 1)))));
select pg_temp.capture('cost_import_errors', pg_temp.j('import_errors'));
select pg_temp.check(pg_temp.j('import_errors') = jsonb_build_object('imported', 0, 'errors', jsonb_build_array(
    '{"row": 2, "message": "Day 2026-13-01 is not a date"}'::jsonb,
    '{"row": 3, "message": "Source Face Book is not a source name: use up to 60 letters, numbers and _ . -, such as meta or tiktok"}'::jsonb,
    '{"row": 4, "message": "An ad needs an ad set"}'::jsonb,
    '{"row": 5, "message": "Repeats row 1: same day, source, campaign, ad set and ad"}'::jsonb,
    '{"row": 6, "message": "Amount 12,50 is not a number"}'::jsonb,
    jsonb_build_object('row', 7, 'message', format('Day %s is in the future', pg_temp.d(-3))))),
  'a bad upload lists every problem by row, a repeated row too');
select pg_temp.check(not exists (select 1 from public.attribution_cost_imports where project_id = pg_temp.q('project'))
  and (select count(*) = 5 from public.attribution_costs where project_id = pg_temp.q('project')),
  'and writes nothing at all');
select pg_temp.check((select jsonb_array_length(x->'errors') = 50 and x->'errors'->49->>'row' = '50' and x->>'imported' = '0'
  from (select pg_temp.import(jsonb_build_object('rows', (select jsonb_agg(pg_temp.r(1, 'meta', 1, '{"day":"yesterday"}'))
    from generate_series(1, 60)))) x) y), 'at most 50 problems are listed');

select pg_temp.keep('import_ok', pg_temp.import(jsonb_build_object('file_name', '  meta-oct.csv ', 'rows', jsonb_build_array(
  pg_temp.r(2, 'meta', 100, '{"campaign":"spring"}'),
  pg_temp.r(2, 'meta', 40, '{"campaign":"autumn"}'),
  pg_temp.r(1, 'meta', 99, '{"campaign":"spring","id":"ignored"}'),
  pg_temp.r(2, 'meta', 15, '{"campaign":"winter","currency":"usd"}')))));
select pg_temp.capture('cost_import_ok', pg_temp.j('import_ok'));
insert into qa select 'import1', pg_temp.j('import_ok')->>'import_id';
select pg_temp.check(pg_temp.j('import_ok') - 'import_id' = '{"imported": 4, "replaced": 1, "errors": []}'::jsonb
  and (select i.file_name = 'meta-oct.csv' and i.rows = 4 and i.created_by = 'f9400000-0000-4000-8000-000000000003'
    from public.attribution_cost_imports i where i.id = pg_temp.q('import1') and i.project_id = pg_temp.q('project')),
  'a good upload writes every row and says how many replaced a row already there');
select pg_temp.check((select c.id = pg_temp.q('meta_spring') and c.amount = 99 and c.origin = 'csv' and c.import_id = pg_temp.q('import1')
  from pg_temp.stored(1, 'meta', 'spring') c)
  and (select bool_and(c.origin = 'csv' and c.import_id = pg_temp.q('import1')) from public.attribution_costs c
    where c.project_id = pg_temp.q('project') and c.source = 'meta' and c.day = pg_temp.today() - 2),
  'uploaded rows are csv rows of the upload, and replace a typed row with the same day and names');

insert into qa select 'import2', pg_temp.import(jsonb_build_object('rows', jsonb_build_array(
  pg_temp.r(3, 'meta', 10, '{"campaign":"spring"}'), pg_temp.r(2, 'meta', 45, '{"campaign":"autumn"}'))))->>'import_id';
select pg_temp.check((select pg_temp.import_listed(x, pg_temp.q('import1'))->>'remaining' = '3'
    and pg_temp.import_listed(x, pg_temp.q('import2')) = jsonb_build_object('id', pg_temp.q('import2'), 'file_name', null, 'rows', 2,
      'remaining', 2, 'created_at', (select created_at from public.attribution_cost_imports where id = pg_temp.q('import2')))
    and (x->'imports'->0->>'id')::uuid = pg_temp.q('import2')
  from pg_temp.costs() x), 'uploads are listed newest first with the rows still their own');
select pg_temp.keep('undo2', public.attribution_cost_import_undo(pg_temp.q('project'), pg_temp.q('import2')));
select pg_temp.check(pg_temp.j('undo2') = '{"deleted": 2}'
  and pg_temp.stored(2, 'meta', 'autumn') is null and pg_temp.stored(3, 'meta', 'spring') is null
  and not exists (select 1 from public.attribution_cost_imports where id = pg_temp.q('import2'))
  and pg_temp.import_listed(pg_temp.costs(), pg_temp.q('import1'))->>'remaining' = '3',
  'undoing an upload deletes the rows still its own and the upload');
select pg_temp.check(pg_temp.err(format('select public.attribution_cost_import_undo(%L, %L)', pg_temp.q('project'), pg_temp.q('import2')))
    = 'P0002 Upload not found'
  and pg_temp.err(format('select public.attribution_cost_import_undo(%L, %L)', pg_temp.q('other'), pg_temp.q('import1'))) = 'P0002 Upload not found',
  'an upload undone, or another project''s, is not found');
select pg_temp.keep('over_names', pg_temp.save(jsonb_build_array(pg_temp.r(2, 'meta', 101, '{"campaign":"spring"}'))));
select pg_temp.keep('over_id', pg_temp.save(jsonb_build_array(pg_temp.r(1, 'meta', 98,
  jsonb_build_object('id', pg_temp.v('meta_spring'), 'campaign', 'spring')))));
select pg_temp.check(pg_temp.j('over_names') = '{"saved": 1}' and pg_temp.j('over_id') = '{"saved": 1}'
  and (select c.origin = 'manual' and c.import_id is null and c.amount = 101 from pg_temp.stored(2, 'meta', 'spring') c)
  and (select c.origin = 'manual' and c.import_id is null and c.amount = 98 and c.id = pg_temp.q('meta_spring')
    from pg_temp.stored(1, 'meta', 'spring') c)
  and pg_temp.import_listed(pg_temp.costs(), pg_temp.q('import1'))->>'remaining' = '1',
  'typing over an uploaded row, by its names or its id, makes it typed and no longer the upload''s');

-- Link prices -----------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.rule_err('{}') = '22023 Choose one of the project''s links'
  and pg_temp.rule_err('{"link_id":"nope","kind":"click","amount":1,"starts_on":"2026-11-01"}') = '22023 Choose one of the project''s links'
  and pg_temp.rule_err(jsonb_build_object('link_id', pg_temp.v('other_link'), 'kind', 'click', 'amount', 1, 'starts_on', pg_temp.d(1)))
    = 'P0002 Link not found'
  and pg_temp.rule_err(jsonb_build_object('link_id', pg_temp.v('qr'), 'kind', 'view', 'amount', 1, 'starts_on', pg_temp.d(1)))
    = '22023 Choose a price per install or per click'
  and pg_temp.rule_err(jsonb_build_object('link_id', pg_temp.v('qr'), 'kind', 'click', 'amount', 0, 'starts_on', pg_temp.d(1)))
    = '22023 Set a price above 0 and up to 1,000,000'
  and pg_temp.rule_err(jsonb_build_object('link_id', pg_temp.v('qr'), 'kind', 'click', 'amount', 1000001, 'starts_on', pg_temp.d(1)))
    = '22023 Set a price above 0 and up to 1,000,000'
  and pg_temp.rule_err(jsonb_build_object('link_id', pg_temp.v('qr'), 'kind', 'click', 'amount', 'free', 'starts_on', pg_temp.d(1)))
    = '22023 Set a price above 0 and up to 1,000,000'
  and pg_temp.rule_err(jsonb_build_object('link_id', pg_temp.v('qr'), 'kind', 'click', 'amount', 1, 'currency', 'dollars', 'starts_on', pg_temp.d(1)))
    = '22023 Currency dollars is not a three-letter code, such as USD'
  and pg_temp.rule_err(jsonb_build_object('link_id', pg_temp.v('qr'), 'kind', 'click', 'amount', 1))
    = '22023 Add the first day the price applies, as YYYY-MM-DD'
  and pg_temp.rule_err(jsonb_build_object('link_id', pg_temp.v('qr'), 'kind', 'click', 'amount', 1, 'starts_on', '2026-02-30'))
    = '22023 Start date 2026-02-30 is not a date'
  and pg_temp.rule_err(jsonb_build_object('link_id', pg_temp.v('qr'), 'kind', 'click', 'amount', 1, 'starts_on', pg_temp.d(1), 'ends_on', 'soon'))
    = '22023 End date soon is not a date'
  and pg_temp.rule_err(jsonb_build_object('link_id', pg_temp.v('qr'), 'kind', 'click', 'amount', 1, 'starts_on', pg_temp.d(1), 'ends_on', pg_temp.d(2)))
    = '22023 The last day is on or after the first day'
  and not exists (select 1 from public.attribution_cost_rules where project_id = pg_temp.q('project')),
  'a link price names one of the project''s links, install or click, a price, a currency and its days');

select pg_temp.keep('rule', pg_temp.rule(jsonb_build_object('link_id', pg_temp.v('ada'), 'kind', 'install', 'amount', 2, 'starts_on', pg_temp.d(2))));
select pg_temp.capture('cost_rule', pg_temp.j('rule'));
select pg_temp.check(pg_temp.j('rule') - 'id' - 'updated_at' = jsonb_build_object('link_id', pg_temp.v('ada'), 'link_name', 'Ada''s reels',
    'link_source', 'instagram', 'link_campaign', 'ada-reels', 'kind', 'install', 'amount', 2, 'currency', 'USD',
    'starts_on', pg_temp.d(2), 'ends_on', null)
  and (select r.id = (pg_temp.j('rule')->>'id')::uuid and r.project_id = pg_temp.q('project') and r.amount = 2
    from public.attribution_cost_rules r where r.link_id = pg_temp.q('ada')),
  'a developer prices Ada''s link at 2 dollars an install from two days ago, with no last day');
insert into qa select 'tt_rule', pg_temp.rule(jsonb_build_object('link_id', pg_temp.v('tt'), 'kind', 'install', 'amount', 1, 'starts_on', pg_temp.d(5)))->>'id';
select pg_temp.check((select x->>'id' = pg_temp.v('tt_rule') and x->>'kind' = 'click' and x->'amount' = '0.05'::jsonb and x->>'currency' = 'EUR'
    and x->>'starts_on' = pg_temp.d(1) and x->'ends_on' = 'null'::jsonb and x->>'link_campaign' = ''
  from pg_temp.rule(jsonb_build_object('link_id', pg_temp.v('tt'), 'kind', 'click', 'amount', '0.05', 'currency', 'eur',
    'starts_on', pg_temp.d(1), 'ends_on', null)) x)
  and (select count(*) = 1 from public.attribution_cost_rules where link_id = pg_temp.q('tt')),
  'a link has one price: saving again replaces it, and a click can cost a fraction of a cent');
select pg_temp.check(pg_temp.rule(jsonb_build_object('link_id', pg_temp.v('old'), 'kind', 'click', 'amount', 1, 'starts_on', pg_temp.d(30),
  'ends_on', pg_temp.d(2)))->>'ends_on' = pg_temp.d(2), 'a price can end');
insert into qa select 'qr_rule', pg_temp.rule(jsonb_build_object('link_id', pg_temp.v('qr'), 'kind', 'click', 'amount', 3, 'starts_on', pg_temp.d(5)))->>'id';
select pg_temp.check(public.attribution_cost_rule_delete(pg_temp.q('project'), pg_temp.q('qr_rule')) = '{"deleted": 1}'
  and pg_temp.err(format('select public.attribution_cost_rule_delete(%L, %L)', pg_temp.q('project'), pg_temp.q('qr_rule'))) = 'P0002 Link price not found'
  and pg_temp.err(format('select public.attribution_cost_rule_delete(%L, %L)', pg_temp.q('other'), pg_temp.q('tt_rule'))) = 'P0002 Link price not found',
  'a price is removed once, and only from its own project');

-- Clicks from the link service: Ada's link (store clicks people install from), the TikTok bio
-- link (one before its price starts, two just after midnight in Tokyo, which is still the day
-- before in UTC, one in the evening) and the newsletter link (one on the price's last day,
-- one after it).
select pg_temp.as_user(null);
select pg_temp.check(pg_temp.clicks(jsonb_build_array(
  pg_temp.click('AdaClick000000000001', 'ada', pg_temp.tokyo(2, '12:00'), 'android', 'play_store'),
  pg_temp.click('AdaClick000000000002', 'ada', pg_temp.tokyo(2, '13:00'), 'android', 'play_store'),
  pg_temp.click('AdaClick000000000003', 'ada', pg_temp.tokyo(1, '00:30'), 'android', 'play_store'),
  pg_temp.click('TikClick000000000001', 'tt', pg_temp.tokyo(2, '10:00'), 'ios', 'app_store'),
  pg_temp.click('TikClick000000000002', 'tt', pg_temp.tokyo(1, '00:30'), 'ios', 'app_store'),
  pg_temp.click('TikClick000000000003', 'tt', pg_temp.tokyo(1, '00:40'), 'ios', 'app_store'),
  pg_temp.click('TikClick000000000004', 'tt', pg_temp.tokyo(1, '20:00'), 'ios', 'app_store'),
  pg_temp.click('OldClick000000000001', 'old', pg_temp.tokyo(2, '09:00'), 'desktop', 'web'),
  pg_temp.click('OldClick000000000002', 'old', pg_temp.tokyo(1, '09:00'), 'desktop', 'web'))) = 9,
  'the link service records nine clicks');
select pg_temp.check((select (clicked_at at time zone 'UTC')::date = pg_temp.today() - 2
  and (clicked_at at time zone 'Asia/Tokyo')::date = pg_temp.today() - 1 from public.attribution_clicks where id = 'TikClick000000000002'),
  'a click at 00:30 in Tokyo is on the day before in UTC');
-- App installs: three counted from Ada's clicks (one just after midnight in Tokyo), and four
-- on her link that are never paid for: a click after the install began (rejected), the same
-- phone again (a reinstall), a development build, and a person the merchant marks as a bot.
select pg_temp.install('anon-a1', pg_temp.tokyo(2, '12:30'), jsonb_build_object('device_key', pg_temp.device('phone-a1'),
  'referrer', 'kma_lc=AdaClick000000000001'));
select pg_temp.install('anon-a2', pg_temp.tokyo(2, '13:30'), '{"referrer":"kma_lc=AdaClick000000000002"}');
select pg_temp.install('anon-a3', pg_temp.tokyo(1, '00:45'), '{"referrer":"kma_lc=AdaClick000000000003"}');
select pg_temp.install('anon-rejected', pg_temp.tokyo(2, '12:40'), jsonb_build_object('referrer', 'kma_lc=AdaClick000000000001',
  'install_begin_ts', floor(extract(epoch from pg_temp.tokyo(2, '12:00')::timestamptz))::bigint - 60));
select pg_temp.install('anon-reinstall', pg_temp.tokyo(1, '10:00'), jsonb_build_object('device_key', pg_temp.device('phone-a1')));
select pg_temp.install('anon-dev', pg_temp.tokyo(2, '14:00'), '{"referrer":"kma_lc=AdaClick000000000002"}', pg_temp.v('dev_key'));
select pg_temp.install('anon-bot', pg_temp.tokyo(1, '11:00'), '{"referrer":"kma_lc=AdaClick000000000003"}');
select pg_temp.check((select count(*) = 7 from public.attribution_installs where link_id = pg_temp.q('ada'))
  and (pg_temp.installed('anon-a1')).verdict = 'counted' and (pg_temp.installed('anon-a1')).method = 'install_referrer'
  and (pg_temp.installed('anon-rejected')).verdict = 'rejected' and (pg_temp.installed('anon-reinstall')).method = 'reinstall'
  and (pg_temp.installed('anon-dev')).environment = 'development' and (pg_temp.installed('anon-bot')).verdict = 'counted',
  'seven installs carry Ada''s link');
-- A website visit tagged with a newsletter, for the source suggestions.
select pg_temp.visit('anon-web', 60, '{"utm":{"source":"Newsletter","campaign":"November"}}');

select pg_temp.check(pg_temp.link_lines() = jsonb_build_array(
    jsonb_build_object('days_ago', 2, 'link', 'ada', 'origin', 'link_install', 'amount', 4, 'currency', 'USD',
      'source', 'instagram', 'campaign', 'ada-reels', 'adset', '', 'ad', ''),
    jsonb_build_object('days_ago', 2, 'link', 'old', 'origin', 'link_click', 'amount', 1, 'currency', 'USD',
      'source', 'email', 'campaign', '', 'adset', '', 'ad', ''),
    jsonb_build_object('days_ago', 1, 'link', 'ada', 'origin', 'link_install', 'amount', 4, 'currency', 'USD',
      'source', 'instagram', 'campaign', 'ada-reels', 'adset', '', 'ad', ''),
    jsonb_build_object('days_ago', 1, 'link', 'tt', 'origin', 'link_click', 'amount', 0.15, 'currency', 'EUR',
      'source', 'tiktok', 'campaign', '', 'adset', '', 'ad', '')),
  'link prices cost their counted installs or clicks per Tokyo day, inside the price''s days');
select pg_temp.as_user('f9400000-0000-4000-8000-000000000003');
select public.analytics_set_override(pg_temp.q('project'), 'bot', pg_temp.person('anon-bot'));
select public.attribution_save_link(pg_temp.q('project'), pg_temp.q('ada'), '{"campaign":"ada-winter"}');
select pg_temp.check(pg_temp.link_lines()->2 = jsonb_build_object('days_ago', 1, 'link', 'ada', 'origin', 'link_install', 'amount', 2,
    'currency', 'USD', 'source', 'instagram', 'campaign', 'ada-winter', 'adset', '', 'ad', '')
  and pg_temp.link_lines()->0->>'campaign' = 'ada-winter',
  'a person marked as a bot is not paid for, and the lines carry the link''s campaign as it is now');
select pg_temp.check((select count(*) = 2 and bool_and(x.day = pg_temp.today() - 1)
  from kma_internal.attribution_cost_lines(pg_temp.q('project'), pg_temp.today() - 1, pg_temp.today() - 1) x where x.link_id is not null)
  and (select count(*) = 0 from kma_internal.attribution_link_costs(pg_temp.q('project'), pg_temp.today() - 30, pg_temp.today() - 3))
  and (select count(*) = 0 from kma_internal.attribution_link_costs(pg_temp.q('project'), null, pg_temp.today()))
  and (select count(*) = 0 from kma_internal.attribution_link_costs(pg_temp.q('other'), pg_temp.today() - 30, pg_temp.today())),
  'the lines keep to the days asked for and to the project');
select pg_temp.check((select count(*) = 3 and bool_and(x.origin = 'manual')
  from kma_internal.attribution_cost_lines(pg_temp.q('project'), pg_temp.today() - 1, pg_temp.today() - 1) x where x.link_id is null),
  'typed and uploaded spend are cost lines too, without a link');

-- The Costs screen, in dollars at the ECB's rates -------------------------------------------------
-- Rates written directly, as piece A's worker stores them: dollars per euro 1.10 forty days ago
-- and 1.20 from yesterday, pounds 0.85. The naira has none.
insert into public.attribution_fx_rates(currency, day, per_eur) values
  ('USD', pg_temp.today() - 40, 1.10), ('USD', pg_temp.today() - 1, 1.20), ('GBP', pg_temp.today() - 40, 0.85);
select pg_temp.as_user('f9400000-0000-4000-8000-000000000002');
select pg_temp.keep('costs', pg_temp.costs('{"range":"30d"}'));
select pg_temp.capture('costs', pg_temp.j('costs'));
-- Typed: 98 + 30 (yesterday, dollars) + 60 euros two days ago at 1.10 (66) + 20 pounds ten days
-- ago at 1.10 / 0.85 (25.8824) + 101 = 320.88; 10 naira unconverted. Uploaded: 15. Links: 4 and
-- 2 dollars of installs, 1 dollar of clicks, 0.15 euros of clicks yesterday at 1.20 (0.18) = 7.18.
select pg_temp.check(pg_temp.j('costs')->'totals' = '{"cost": 343.06, "typed": 320.88, "uploaded": 15, "links": 7.18, "unconverted": 1}'::jsonb,
  'totals are in dollars, each day and currency at its own rate, and a currency without a rate is counted apart');
select pg_temp.check((select jsonb_agg(jsonb_build_array(x->>'day', x->>'source', x->>'campaign', x->>'adset', x->'amount', x->>'currency', x->>'origin')
    order by n) from jsonb_array_elements(pg_temp.j('costs')->'rows') with ordinality y(x, n)) = jsonb_build_array(
    jsonb_build_array(pg_temp.d(1), 'facebook', 'spring', 'adset-a', 30, 'USD', 'manual'),
    jsonb_build_array(pg_temp.d(1), 'meta', 'spring', '', 98, 'USD', 'manual'),
    jsonb_build_array(pg_temp.d(1), 'snapchat', '', '', 10, 'NGN', 'manual'),
    jsonb_build_array(pg_temp.d(2), 'meta', 'spring', '', 101, 'USD', 'manual'),
    jsonb_build_array(pg_temp.d(2), 'meta', 'winter', '', 15, 'USD', 'csv'),
    jsonb_build_array(pg_temp.d(2), 'tiktok', '', '', 60, 'EUR', 'manual'),
    jsonb_build_array(pg_temp.d(10), 'google_ads', '', '', 20, 'GBP', 'manual')),
  'rows are the typed and uploaded spend, newest day first, in their own currency');
select pg_temp.check(pg_temp.listed(pg_temp.j('costs'), 2, 'meta', 'winter') - 'updated_at' = jsonb_build_object(
    'id', (pg_temp.stored(2, 'meta', 'winter')).id, 'day', pg_temp.d(2), 'source', 'meta', 'campaign', 'winter', 'adset', '', 'ad', '',
    'amount', 15, 'currency', 'USD', 'origin', 'csv', 'import_id', pg_temp.q('import1'))
  and pg_temp.listed(pg_temp.j('costs'), 1, 'meta', 'spring')->'import_id' = 'null'::jsonb,
  'an uploaded row names its upload');
select pg_temp.check(pg_temp.j('costs')->'link_costs' = jsonb_build_array(
    jsonb_build_object('day', pg_temp.d(1), 'link_id', pg_temp.q('ada'), 'link_name', 'Ada''s reels', 'source', 'instagram',
      'campaign', 'ada-winter', 'kind', 'install', 'count', 1, 'amount', 2, 'currency', 'USD'),
    jsonb_build_object('day', pg_temp.d(1), 'link_id', pg_temp.q('tt'), 'link_name', 'TikTok bio', 'source', 'tiktok',
      'campaign', '', 'kind', 'click', 'count', 3, 'amount', 0.15, 'currency', 'EUR'),
    jsonb_build_object('day', pg_temp.d(2), 'link_id', pg_temp.q('ada'), 'link_name', 'Ada''s reels', 'source', 'instagram',
      'campaign', 'ada-winter', 'kind', 'install', 'count', 2, 'amount', 4, 'currency', 'USD'),
    jsonb_build_object('day', pg_temp.d(2), 'link_id', pg_temp.q('old'), 'link_name', 'Newsletter', 'source', 'email',
      'campaign', '', 'kind', 'click', 'count', 1, 'amount', 1, 'currency', 'USD')),
  'link costs say how many installs or clicks each day was paid for');
select pg_temp.check(pg_temp.j('costs')->'imports' = jsonb_build_array(jsonb_build_object('id', pg_temp.q('import1'), 'file_name', 'meta-oct.csv',
    'rows', 4, 'remaining', 1, 'created_at', (select created_at from public.attribution_cost_imports where id = pg_temp.q('import1'))))
  and (select jsonb_agg(x->>'link_name' order by n) from jsonb_array_elements(pg_temp.j('costs')->'rules') with ordinality y(x, n))
    = '["Ada''s reels", "Newsletter", "TikTok bio"]'::jsonb
  and pg_temp.j('costs')->'rules'->0->>'link_campaign' = 'ada-winter',
  'the upload and the link prices are listed');
select pg_temp.check(pg_temp.j('costs')->'sources' = '["meta", "tiktok", "email", "google_ads", "newsletter", "snapchat"]'::jsonb,
  'sources suggest the families seen in installs, clicks, visits and spend, most seen first');
select pg_temp.check((select x->'totals' = '{"cost": 317.18, "typed": 295, "uploaded": 15, "links": 7.18, "unconverted": 1}'::jsonb
    and x->>'from' = pg_temp.d(6) and jsonb_array_length(x->'rows') = 6
  from pg_temp.costs('{"range":"7d"}') x), 'seven days leave out the pounds of ten days ago');
select pg_temp.check((select x->'totals' = '{"cost": 250, "typed": 229, "uploaded": 15, "links": 6, "unconverted": 0}'::jsonb
    and (select array_agg(r->>'source' order by r->>'source') from jsonb_array_elements(x->'rows') r) = array['facebook', 'meta', 'meta', 'meta']
    and (select bool_and(l->>'link_name' = 'Ada''s reels') from jsonb_array_elements(x->'link_costs') l)
    and jsonb_array_length(x->'link_costs') = 2 and jsonb_array_length(x->'rules') = 3
  from pg_temp.costs('{"range":"30d","source":"Facebook"}') x),
  'a source filter takes the whole family: facebook means meta, which Ada''s instagram link is part of');
select pg_temp.check((select x->'totals' = '{"cost": 66.18, "typed": 66, "uploaded": 0, "links": 0.18, "unconverted": 0}'::jsonb
  from pg_temp.costs('{"range":"30d","source":"tt"}') x), 'tt is tiktok');

-- Who may read and write --------------------------------------------------------------------------
select pg_temp.check(pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1))) = '42501 Your role cannot make this change'
  and pg_temp.err(format('select public.attribution_cost_import(%L, %L)', pg_temp.q('project'),
    jsonb_build_object('rows', jsonb_build_array(pg_temp.r(1, 'meta', 1))))) = '42501 Your role cannot make this change'
  and pg_temp.err(format('select public.attribution_cost_import_undo(%L, %L)', pg_temp.q('project'), pg_temp.q('import1')))
    = '42501 Your role cannot make this change'
  and pg_temp.err(format('select public.attribution_cost_delete(%L, %L)', pg_temp.q('project'), array[pg_temp.q('tiktok_row')]))
    = '42501 Your role cannot make this change'
  and pg_temp.rule_err(jsonb_build_object('link_id', pg_temp.v('qr'), 'kind', 'click', 'amount', 1, 'starts_on', pg_temp.d(1)))
    = '42501 Your role cannot make this change'
  and pg_temp.err(format('select public.attribution_cost_rule_delete(%L, %L)', pg_temp.q('project'), pg_temp.q('tt_rule')))
    = '42501 Your role cannot make this change'
  and (pg_temp.stored(2, 'tiktok')).amount = 60,
  'an analyst reads spend but cannot change it');
select pg_temp.as_user('f9400000-0000-4000-8000-000000000001');
select pg_temp.check(pg_temp.costs()->'totals' = pg_temp.j('costs')->'totals'
  and pg_temp.save(jsonb_build_array(pg_temp.r(2, 'tiktok', 60, '{"currency":"EUR"}'))) = '{"saved": 1}',
  'the owner reads and writes');
select pg_temp.check(pg_temp.err(format('select public.attribution_costs(%L, ''{}'')', pg_temp.q('quiet')))
    = '22023 Turn on attribution for this project first'
  and pg_temp.err(format('select public.attribution_cost_save(%L, %L)', pg_temp.q('quiet'),
    jsonb_build_object('rows', jsonb_build_array(pg_temp.r(1, 'meta', 1))))) = '22023 Turn on attribution for this project first'
  and pg_temp.err(format('select public.attribution_costs(%L, ''{}'')', 'f9400000-0000-4000-8000-0000000000ff')) = 'P0002 Project not found',
  'a project without attribution, or no project, has no Costs screen');
select pg_temp.as_user('f9400000-0000-4000-8000-000000000004');
select pg_temp.check(pg_temp.err(format('select public.attribution_costs(%L, ''{}'')', pg_temp.q('project'))) = 'P0002 Workspace not found'
  and pg_temp.save_err(jsonb_build_array(pg_temp.r(1, 'meta', 1))) = 'P0002 Workspace not found'
  and pg_temp.rule_err(jsonb_build_object('link_id', pg_temp.v('qr'), 'kind', 'click', 'amount', 1, 'starts_on', pg_temp.d(1)))
    = 'P0002 Workspace not found'
  and pg_temp.err(format('select public.attribution_cost_import_undo(%L, %L)', pg_temp.q('project'), pg_temp.q('import1')))
    = 'P0002 Workspace not found',
  'another workspace can neither read nor change the project''s spend');
select pg_temp.as_user(null);
select pg_temp.check(pg_temp.err(format('select public.attribution_costs(%L, ''{}'')', pg_temp.q('project'))) = '42501 Sign in to continue',
  'nobody signed in reads nothing');

-- A large upload ---------------------------------------------------------------------------------
select pg_temp.as_user('f9400000-0000-4000-8000-000000000003');
insert into qa select 'bulk', pg_temp.import(jsonb_build_object('file_name', 'bulk.csv', 'rows',
  (select jsonb_agg(pg_temp.r(3, 'bulk', 1, jsonb_build_object('campaign', 'c' || lpad(i::text, 4, '0')))) from generate_series(1, 1001) i)))->>'import_id';
select pg_temp.check((select jsonb_array_length(x->'rows') = 1000 and x->'totals'->'uploaded' = '1016'::jsonb
  and pg_temp.import_listed(x, pg_temp.q('bulk'))->>'remaining' = '1001' from pg_temp.costs() x),
  'the screen lists at most 1,000 rows, the totals count them all');
select pg_temp.keep('undo_bulk', public.attribution_cost_import_undo(pg_temp.q('project'), pg_temp.q('bulk')));
select pg_temp.check(pg_temp.j('undo_bulk') = '{"deleted": 1001}'
  and pg_temp.costs()->'totals' = pg_temp.j('costs')->'totals', 'and undoing it takes them all back');

-- Deleting ---------------------------------------------------------------------------------------
select pg_temp.as_user('f9400000-0000-4000-8000-000000000001');
select public.analytics_delete_project(pg_temp.q('project'), 'Kanji');
select pg_temp.check(not exists (select 1 from public.attribution_costs where project_id = pg_temp.q('project'))
  and not exists (select 1 from public.attribution_cost_imports where project_id = pg_temp.q('project'))
  and not exists (select 1 from public.attribution_cost_rules where project_id = pg_temp.q('project')),
  'a deleted project takes its spend, uploads and link prices with it');

select 'ok ' || count(*) || ' attribution cost assertions' from cost_assertions;
rollback;
