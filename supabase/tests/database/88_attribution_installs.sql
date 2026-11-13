-- Provider-free test of attribution Phase 2: app installs matched to the click that brought
-- them, deep links delivered once, links that open the app again, organic installs matched
-- later when the person signs in, and what the console reads about all of it.
--
-- The app's calls go through attribution_install and attribution_open as the analytics-ingest
-- edge function makes them (service role, the ingest envelope); clicks come from the link
-- service through attribution_record_clicks, and website visits and app events through
-- analytics_ingest. Two clicks are written directly, and say so: one carrying a creator's click
-- (attribution_record_clicks keeps that only once Piece B lands) and one older than the link
-- service may send.
-- kma_internal.attribution_install_matched is whatever the migrations define (Piece B
-- replaces the stub); the suite counts its calls with the function statistics.
begin;
set local time zone 'UTC';
set local track_functions = 'all';
create temporary table installs_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Attribution install assertion failed: %', label; end if;
  insert into installs_assertions values (label);
end $$;
create function pg_temp.as_user(id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', id, 'role', 'authenticated')::text, true)
$$;
-- 'ok', or the SQLSTATE and the DETAIL code (or message) of the refusal.
create function pg_temp.fails(statement text) returns text language plpgsql as $$
declare reason text;
begin
  execute statement;
  return 'ok';
exception when others then
  get stacked diagnostics reason = pg_exception_detail;
  return sqlstate || ' ' || coalesce(nullif(reason, ''), sqlerrm);
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
create function pg_temp.v(k text) returns text language sql as $$ select value from qa where key = k $$;
create function pg_temp.j(k text) returns jsonb language sql as $$ select value::jsonb from qa where key = k $$;
create function pg_temp.keep(k text, value jsonb) returns jsonb language sql as $$
  insert into qa values (k, value::text) on conflict (key) do update set value = excluded.value returning value::jsonb
$$;
create function pg_temp.at(minutes_ago numeric) returns text language sql as $$
  select to_char((now() - make_interval(secs => minutes_ago * 60)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
create function pg_temp.epoch(minutes_ago numeric) returns bigint language sql as $$
  select floor(extract(epoch from now() - make_interval(secs => minutes_ago * 60)))::bigint
$$;
create function pg_temp.device(name text) returns text language sql as $$
  select encode(extensions.digest(name, 'sha256'), 'hex')
$$;
-- Prints one function result as the front ends receive it (kept by KMA_DB_TEST_OUTPUT).
create function pg_temp.capture(name text, result jsonb) returns text language sql as $$
  select 'capture ' || name || ' ' || result::text
$$;
-- How many times attribution_install_matched ran in this transaction.
create function pg_temp.matched_calls() returns bigint language sql as $$
  select coalesce(pg_stat_get_xact_function_calls('kma_internal.attribution_install_matched(uuid)'::regprocedure), 0)
$$;
-- An app's attribution call as the edge function makes it: the ingest envelope, as the
-- service role, nobody signed in.
create function pg_temp.envelope(app_key text, body jsonb, extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object('key_hash', encode(extensions.digest(app_key, 'sha256'), 'hex'), 'origin', null, 'body', body,
    'geo', jsonb_build_object('country', 'NG', 'region', 'Lagos', 'city', 'Lagos', 'source', 'ip'),
    'ip_sha', repeat('b', 64), 'user_agent', 'Fluent/2.4.0 CFNetwork/1490', 'clock_skew_ms', 0) || coalesce(extra, '{}')
$$;
create function pg_temp.app(fn text, app_key text, body jsonb, extra jsonb default '{}') returns jsonb language plpgsql as $$
declare
  v_p jsonb := pg_temp.envelope(app_key, body, extra);
  result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  execute format('select public.%I($1)', fn) into result using v_p;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
create function pg_temp.try_app(fn text, app_key text, body jsonb, extra jsonb default '{}') returns text language plpgsql as $$
declare reason text;
begin
  perform pg_temp.app(fn, app_key, body, extra);
  return 'ok';
exception when others then
  get stacked diagnostics reason = pg_exception_detail;
  return sqlstate || ' ' || coalesce(nullif(reason, ''), sqlerrm);
end $$;
-- The contract's install and open bodies.
create function pg_temp.install_body(anon text, platform text, minutes_ago numeric, extra jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object('anonymous_id', anon, 'session_id', 'session-' || anon, 'platform', platform,
    'installed_at', pg_temp.at(minutes_ago), 'sdk', case platform when 'ios' then 'kma-ios/1.1.0' else 'kma-android/1.1.0' end,
    'app_version', '2.4.0') || extra
$$;
create function pg_temp.open_body(anon text, platform text, minutes_ago numeric, url text, extra jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object('anonymous_id', anon, 'session_id', 'session-' || anon || '-open', 'platform', platform,
    'url', url, 'opened_at', pg_temp.at(minutes_ago),
    'sdk', case platform when 'ios' then 'kma-ios/1.1.0' else 'kma-android/1.1.0' end) || extra
$$;
create function pg_temp.install(anon text, platform text, minutes_ago numeric, extra jsonb default '{}', app_key text default null)
returns jsonb language sql as $$
  select pg_temp.app('attribution_install', coalesce(app_key, pg_temp.v('live_key')), pg_temp.install_body(anon, platform, minutes_ago, extra))
$$;
create function pg_temp.open(anon text, platform text, minutes_ago numeric, url text, extra jsonb default '{}') returns jsonb
language sql as $$
  select pg_temp.app('attribution_open', pg_temp.v('live_key'), pg_temp.open_body(anon, platform, minutes_ago, url, extra))
$$;
create function pg_temp.refused(body jsonb, fn text default 'attribution_install') returns text language sql as $$
  select pg_temp.try_app(fn, pg_temp.v('live_key'), body)
$$;
-- Clicks from the link service, through the function it calls.
create function pg_temp.clicks(clicks jsonb) returns integer language plpgsql as $$
declare result integer;
begin
  set local role service_role;
  result := public.attribution_record_clicks(clicks);
  reset role;
  return result;
end $$;
-- A web SDK request: a visit that lands with ctx, then the named events. And an app's events.
create function pg_temp.visit(anon text, user_id text, session text, minutes_ago numeric, ctx jsonb, events text[])
returns jsonb language sql as $$
  select public.analytics_ingest(jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.v('live_key'), 'sha256'), 'hex'),
    'origin', 'https://fluent.app',
    'body', jsonb_strip_nulls(jsonb_build_object(
      'anonymous_id', anon, 'user_id', user_id,
      'session', jsonb_build_object('id', session, 'started_at', pg_temp.at(minutes_ago)),
      'context', jsonb_build_object('platform', 'web', 'browser', 'Safari', 'device_type', 'mobile', 'interactions', 3,
        'page_path', '/') || ctx,
      'events', (select jsonb_agg(jsonb_build_object('name', e, 'insert_id', session || ':' || e || ':' || i,
        'time', pg_temp.at(minutes_ago - i * 0.1), 'properties', '{}'::jsonb)) from unnest(events) with ordinality u(e, i))))))
$$;
create function pg_temp.app_events(anon text, user_id text, platform text, minutes_ago numeric, events text[]) returns jsonb
language sql as $$
  select public.analytics_ingest(jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.v('live_key'), 'sha256'), 'hex'), 'origin', null,
    'body', jsonb_strip_nulls(jsonb_build_object(
      'anonymous_id', anon, 'user_id', user_id, 'sent_at', pg_temp.at(minutes_ago),
      'session', jsonb_build_object('id', 'session-' || anon, 'started_at', pg_temp.at(minutes_ago)),
      'context', jsonb_build_object('platform', platform, 'sdk', 'kma-' || platform || '/1.1.0', 'timezone', 'Africa/Lagos',
        'language', 'en', 'device_type', 'mobile', 'os_name', platform, 'os_version', '17', 'screen_width', 390,
        'screen_height', 844, 'app_version', '2.4.0'),
      'events', (select jsonb_agg(jsonb_build_object('name', e, 'insert_id', anon || ':' || e || ':' || minutes_ago,
        'time', pg_temp.at(minutes_ago), 'properties', '{}'::jsonb)) from unnest(events) e)))))
$$;
create function pg_temp.person(anon text) returns uuid language sql as $$
  select id from public.analytics_people where project_id = pg_temp.q('project')
    and (distinct_id = anon or anon = any(anonymous_ids)) limit 1
$$;
create function pg_temp.installed(anon text) returns public.attribution_installs language sql as $$
  select i from public.attribution_installs i where i.person_id = pg_temp.person(anon)
$$;
create function pg_temp.link_row(report jsonb, id uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(report->'links') x where (x->>'id')::uuid = id
$$;
create function pg_temp.source_row(report jsonb, k text) returns jsonb language sql as $$
  select x from jsonb_array_elements(report->'rows') x where x->>'key' is not distinct from k
$$;
create function pg_temp.link_host(host text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  set local role service_role;
  result := public.attribution_link_host(host);
  reset role;
  return result;
end $$;
grant all on qa, installs_assertions to authenticated, service_role;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('f8800000-0000-4000-8000-000000000001', 'owner@fluent.example.test', now(), '{"full_name":"Ada Owner"}'::jsonb),
  ('f8800000-0000-4000-8000-000000000002', 'analyst@fluent.example.test', now(), '{}'),
  ('f8800000-0000-4000-8000-000000000003', 'stranger@elsewhere.example.test', now(), '{}');

-- Closed by default -----------------------------------------------------------------------------
select pg_temp.check(has_function_privilege('service_role', 'public.attribution_install(jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.attribution_open(jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.attribution_tick(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.attribution_install(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.attribution_open(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.attribution_tick(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.attribution_install(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.attribution_open(jsonb)', 'execute'),
  'only the edge function and the minute job call the app functions');
select pg_temp.check(has_function_privilege('authenticated', 'public.attribution_test_device(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.attribution_test_device(uuid,uuid)', 'execute'),
  'members test a phone');
select pg_temp.check((select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
  from pg_proc p where p.oid in ('public.attribution_install(jsonb)'::regprocedure, 'public.attribution_open(jsonb)'::regprocedure,
    'public.attribution_tick(jsonb)'::regprocedure, 'public.attribution_test_device(uuid,uuid)'::regprocedure)),
  'the new functions run with an empty search path');
select pg_temp.check((select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
  from unnest(array['public.attribution_get(uuid)', 'public.attribution_update(uuid,jsonb)', 'public.attribution_links(uuid,text)',
    'public.attribution_sources(uuid,text,text,text)', 'public.analytics_person(uuid,uuid)']) f)
  and has_function_privilege('service_role', 'public.attribution_link_host(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.attribution_link_host(text)', 'execute'),
  'the readers this phase changes keep who may call them');
select pg_temp.check(not has_table_privilege('authenticated', 'public.attribution_installs', 'select')
  and not has_table_privilege('service_role', 'public.attribution_installs', 'select')
  and not has_table_privilege('authenticated', 'public.attribution_engagements', 'select'),
  'installs and re-engagements are read only through functions');

-- A project with attribution on, its apps, links and keys --------------------------------------
select pg_temp.as_user('f8800000-0000-4000-8000-000000000001');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Fluent', array['ios', 'android', 'web'], 'UTC') r)
insert into qa select 'project', r->'project'->>'id' from created
union all select 'live_key', r->'key'->>('to' || 'ken') from created;
insert into qa select 'dev_key', public.analytics_create_key(pg_temp.q('project'), 'Staging', 'client', 'development')->>('to' || 'ken');
insert into qa select 'server_key', public.analytics_create_key(pg_temp.q('project'), 'Backend', 'server', 'production')->>('to' || 'ken');
with k as (select public.analytics_create_key(pg_temp.q('project'), 'Old build', 'client', 'production') r)
insert into qa select 'old_build_key', r->>('to' || 'ken') from k union all select 'old_build_id', r->>'id' from k;
select public.analytics_revoke_key(pg_temp.q('old_build_id'));
select public.analytics_update_project(pg_temp.q('project'), '{"allowed_origins":["https://fluent.app"]}'::jsonb);
select public.attribution_enable(pg_temp.q('project'), 'fluent');
select public.attribution_update(pg_temp.q('project'), '{"ios_app_store_id":"1612345678","ios_bundle_id":"app.fluent.ios","ios_team_id":"ABCDE12345","android_package":"app.fluent","android_sha256":["146DE983C5730650D8EEB9952F34FC6416A08342E61DBEA88A0496B23FCF44E5"],"web_url":"https://fluent.app/"}'::jsonb);
insert into qa select 'lesson', public.attribution_save_link(pg_temp.q('project'), null, '{"name":"Lesson 4","path":"lesson-4",
  "source":"tiktok","campaign":"launch","deep_link_value":"lesson","deep_link_params":{"id":"4"}}')->>'id';
insert into qa select 'bio', public.attribution_save_link(pg_temp.q('project'), null, '{"name":"Bio link","path":"bio","source":"instagram"}')->>'id';
insert into qa select 'qr', public.attribution_save_link(pg_temp.q('project'), null, '{"name":"Phone test","path":"qr-test",
  "source":"qr","deep_link_value":"welcome"}')->>'id';
insert into qa select 'old', public.attribution_save_link(pg_temp.q('project'), null, '{"name":"Old mail","path":"old","source":"email"}')->>'id';
select public.attribution_set_link_status(pg_temp.q('old'), 'paused');
-- A project without attribution, and another merchant's project with a link of the same name.
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Quiet', array['android'], 'UTC') r)
insert into qa select 'quiet', r->'project'->>'id' from created union all select 'quiet_key', r->'key'->>('to' || 'ken') from created;
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Rival', array['android'], 'UTC') r)
insert into qa select 'rival', r->'project'->>'id' from created union all select 'rival_key', r->'key'->>('to' || 'ken') from created;
select public.attribution_enable(pg_temp.q('rival'), 'rival');
insert into qa select 'rival_link', public.attribution_save_link(pg_temp.q('rival'), null, '{"name":"Rival","path":"lesson-4","source":"tiktok"}')->>'id';
select public.analytics_invite_member(pg_temp.q('workspace'), 'analyst@fluent.example.test', 'analyst');
select pg_temp.as_user('f8800000-0000-4000-8000-000000000002');
select public.analytics_bootstrap();
select pg_temp.as_user('f8800000-0000-4000-8000-000000000003');
select public.analytics_bootstrap();
select pg_temp.as_user('f8800000-0000-4000-8000-000000000001');
select pg_temp.check((select a->'setup'->>'sdk' = 'false' and a->'installs' = '{"total": 0, "last_at": null}'::jsonb
  and a->'settings'->>'ios_clipboard_handoff' = 'false'
  from (select public.attribution_get(pg_temp.q('project')) a) x), 'before any install the SDK step is open and nothing is counted');
select pg_temp.check(pg_temp.link_host('fluent.go.kissmyapps.dev')->>'ios_clipboard_handoff' = 'false',
  'the link service reads clipboard handoff, off by default');

-- Clipboard handoff is a setting ---------------------------------------------------------------
select pg_temp.check((public.attribution_update(pg_temp.q('project'), '{"ios_clipboard_handoff":true}')->'settings'->>'ios_clipboard_handoff') = 'true',
  'a developer turns clipboard handoff on and the answer says so');
select pg_temp.check(pg_temp.fails(format('select public.attribution_update(%L, ''{"ios_clipboard_handoff":"yes"}'')', pg_temp.q('project'))) like '22023%',
  'clipboard handoff is on or off');
select pg_temp.as_user('f8800000-0000-4000-8000-000000000002');
select pg_temp.check(pg_temp.fails(format('select public.attribution_update(%L, ''{"ios_clipboard_handoff":false}'')', pg_temp.q('project'))) like '42501%',
  'analysts cannot change clipboard handoff');
select pg_temp.check((public.attribution_get(pg_temp.q('project'))->'settings'->>'ios_clipboard_handoff') = 'true', 'members read it back');
select pg_temp.check((pg_temp.link_host('fluent.go.kissmyapps.dev')->>'ios_clipboard_handoff') = 'true'
  and (pg_temp.link_host('rival.go.kissmyapps.dev')->>'ios_clipboard_handoff') = 'false', 'the link service sees it for that project only');

-- Attribution off: nothing is stored ----------------------------------------------------------------
select pg_temp.keep('off', pg_temp.install('anon-quiet', 'android', 1, '{}', pg_temp.v('quiet_key')));
select pg_temp.capture('attribution_install.off', pg_temp.j('off'));
select pg_temp.check(pg_temp.j('off') = '{"matched": false, "method": "off", "deep_link": null}'::jsonb, 'a project without attribution answers off');
select pg_temp.check(pg_temp.app('attribution_open', pg_temp.v('quiet_key'), pg_temp.open_body('anon-quiet', 'android', 1,
  'https://fluent.go.kissmyapps.dev/lesson-4')) = '{"matched": false, "method": "off", "deep_link": null}'::jsonb, 'opens answer off too');
select pg_temp.check(not exists (select 1 from public.analytics_people where project_id = pg_temp.q('quiet')), 'and no person is made');

-- Keys, as for events ----------------------------------------------------------------------------
select pg_temp.check(pg_temp.try_app('attribution_install', 'kma_pk_live_unknown', pg_temp.install_body('anon-k', 'ios', 1)) like '28000%',
  'an unknown key is refused');
select pg_temp.check(pg_temp.try_app('attribution_install', pg_temp.v('old_build_key'), pg_temp.install_body('anon-k', 'ios', 1)) like '28000%'
  and pg_temp.try_app('attribution_open', pg_temp.v('old_build_key'), pg_temp.open_body('anon-k', 'ios', 1, 'https://fluent.go.kissmyapps.dev/bio')) like '28000%',
  'a revoked key is refused');
select pg_temp.check(pg_temp.try_app('attribution_install', pg_temp.v('live_key'), pg_temp.install_body('anon-k', 'ios', 1),
  '{"origin":"https://evil.example.test"}') like '42501%', 'a live client key from a website the project does not allow is refused');
select pg_temp.check(pg_temp.try_app('attribution_install', pg_temp.v('live_key'), pg_temp.install_body('anon-origin-ok', 'ios', 1),
  '{"origin":"https://fluent.app"}') = 'ok'
  and pg_temp.try_app('attribution_install', pg_temp.v('dev_key'), pg_temp.install_body('anon-dev-origin', 'ios', 1),
  '{"origin":"https://evil.example.test"}') = 'ok', 'an allowed website and a development key pass');
select pg_temp.check(not exists (select 1 from public.analytics_people where project_id = pg_temp.q('project') and distinct_id = 'anon-k'),
  'a refused key stores nothing');

-- The body is checked against the contract --------------------------------------------------------
select pg_temp.check(pg_temp.refused('[]'::jsonb) = '22023 invalid_body', 'the body is an object');
select pg_temp.check(pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 1, jsonb_build_object('apple_ads_' || 'to' || 'ken', 'abc'))) = '22023 unknown_field',
  'the raw Apple Ads value from the phone never reaches the database');
select pg_temp.check(pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 1) - 'anonymous_id') = '22023 invalid_anonymous_id'
  and pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 1) - 'session_id') = '22023 invalid_session_id'
  and pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 1) - 'sdk') = '22023 invalid_sdk',
  'the identity, session and SDK are required');
select pg_temp.check(pg_temp.refused(pg_temp.install_body('anon-v', 'web', 1)) = '22023 invalid_platform', 'installs are iOS or Android');
select pg_temp.check(pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 1) || '{"installed_at":"2026-11-13T10:00:00Z"}') = '22023 invalid_installed_at'
  and pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 1) || '{"installed_at":"2026-13-40T10:00:00.000Z"}') = '22023 invalid_installed_at',
  'the install time is the contract''s UTC time with milliseconds');
select pg_temp.check(pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 60 * 24 * 8)) = '22023 time_out_of_range'
  and pg_temp.refused(pg_temp.install_body('anon-v', 'ios', -10)) = '22023 time_out_of_range', 'apps send installs of the last 7 days');
select pg_temp.check(pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 1, jsonb_build_object('device_key', upper(pg_temp.device('x'))))) = '22023 invalid_device_key',
  'the device key is the SDK''s lowercase SHA-256');
select pg_temp.check(pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 1, '{"link_url":"http://fluent.go.kissmyapps.dev/bio"}')) = '22023 invalid_link_url'
  and pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 1, jsonb_build_object('link_url', 'https://fluent.go.kissmyapps.dev/' || repeat('a', 2048)))) = '22023 invalid_link_url',
  'a link address is https, at most 2048 characters');
select pg_temp.check(pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 1, '{"referrer":"kma_lc=abc"}')) = '22023 invalid_referrer'
  and pg_temp.refused(pg_temp.install_body('anon-v', 'android', 1, '{"install_begin_ts":"1761818320"}')) = '22023 invalid_install_begin_ts'
  and pg_temp.refused(pg_temp.install_body('anon-v', 'android', 1, '{"referrer_click_ts":1.5}')) = '22023 invalid_referrer_click_ts',
  'the install referrer and its times are Android''s, in whole seconds');
select pg_temp.check(pg_temp.refused(pg_temp.install_body('anon-v', 'android', 1, '{"apple_ads":{"attribution":true}}')) = '22023 invalid_apple_ads'
  and pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 1, '{"apple_ads":{"campaignId":1}}')) = '22023 invalid_apple_ads',
  'Apple''s answer is iOS''s and says whether it attributed');
select pg_temp.check(pg_temp.refused(pg_temp.install_body('anon-v', 'ios', 1, '{"clipboard_click":"short"}')) = '22023 invalid_clipboard_click',
  'a clipboard click is a click ID');
select pg_temp.check(pg_temp.refused(pg_temp.open_body('anon-v', 'ios', 1, 'https://fluent.go.kissmyapps.dev/bio') - 'url', 'attribution_open') = '22023 invalid_url'
  and pg_temp.refused(pg_temp.open_body('anon-v', 'ios', 1, 'https://fluent.go.kissmyapps.dev/bio') - 'opened_at', 'attribution_open') = '22023 invalid_opened_at'
  and pg_temp.refused(pg_temp.open_body('anon-v', 'ios', 1, 'https://fluent.go.kissmyapps.dev/bio', '{"referrer":"x"}'), 'attribution_open') = '22023 unknown_field',
  'an open has its own fields');
select pg_temp.check(not exists (select 1 from public.analytics_people where project_id = pg_temp.q('project') and distinct_id = 'anon-v'),
  'a refused body stores nothing');
select pg_temp.check((pg_temp.install('anon-nulls', 'android', 1, '{"user_id":null,"device_key":null,"referrer":null,"apple_ads":null}')->>'method') = 'organic',
  'optional fields may be null');

-- 3. Google Play's install referrer --------------------------------------------------------------
select pg_temp.check(pg_temp.clicks(jsonb_build_array(
  jsonb_build_object('id', 'Q2xpY2tJZDAwMDAwMDAwMQ', 'link_id', pg_temp.v('lesson'), 'clicked_at', pg_temp.at(30),
    'platform', 'android', 'destination', 'play_store', 'ip_sha', repeat('a', 64)),
  jsonb_build_object('id', 'RejectedClick0000001', 'link_id', pg_temp.v('lesson'), 'clicked_at', pg_temp.at(10),
    'platform', 'android', 'destination', 'play_store'),
  jsonb_build_object('id', 'TooFastClick00000001', 'link_id', pg_temp.v('lesson'), 'clicked_at', pg_temp.at(65 / 60.0),
    'platform', 'android', 'destination', 'play_store'),
  jsonb_build_object('id', 'RivalClick0000000001', 'link_id', pg_temp.v('rival_link'), 'clicked_at', pg_temp.at(20),
    'platform', 'android', 'destination', 'play_store'))) = 4, 'the link service records the store clicks');
insert into qa values ('calls_before', pg_temp.matched_calls()::text);
select pg_temp.keep('referrer', pg_temp.install('anon-ref', 'android', 20, jsonb_build_object('device_key', pg_temp.device('android-1'),
  'referrer', 'kma_lc=Q2xpY2tJZDAwMDAwMDAwMQ&utm_source=tiktok&utm_campaign=launch',
  'referrer_click_ts', pg_temp.epoch(30), 'install_begin_ts', pg_temp.epoch(25))));
select pg_temp.capture('attribution_install.referrer', pg_temp.j('referrer'));
select pg_temp.check(pg_temp.j('referrer') = '{"matched": true, "method": "install_referrer", "source": "tiktok", "campaign": "launch",
  "channel": null, "adset": null, "ad": null, "reinstall": false, "deep_link": {"value": "lesson", "params": {"id": "4"}, "deferred": true}}'::jsonb,
  'the referrer''s click is the source, with the link''s deep link, deferred');
select pg_temp.check((select i.method = 'install_referrer' and i.exact and i.click_id = 'Q2xpY2tJZDAwMDAwMDAwMQ' and i.link_id = pg_temp.q('lesson')
  and i.verdict = 'counted' and i.fraud_reason is null and i.environment = 'production' and i.platform = 'android'
  and i.session_key = 'session-anon-ref' and i.app_version = '2.4.0' and i.deep_link_delivered_at is not null
  and i.installed_at = pg_temp.at(20)::timestamptz and i.creator_click is null
  and i.device_hash = encode(extensions.digest(pg_temp.v('project') || ':' || pg_temp.device('android-1'), 'sha256'), 'hex')
  from pg_temp.installed('anon-ref') i), 'the install keeps how it was matched and the phone hashed again with the project');
select pg_temp.check((select p.acquisition_source = 'tiktok' and p.acquisition_campaign = 'launch' and p.acquisition_method = 'install_referrer'
  and p.installed_at = pg_temp.at(20)::timestamptz and p.platform = 'android' and p.country = 'NG'
  from public.analytics_people p where p.id = pg_temp.person('anon-ref')), 'the person keeps where they were acquired');
select pg_temp.check(pg_temp.matched_calls() = pg_temp.v('calls_before')::bigint + 1, 'the matched hook runs once for the install');
select pg_temp.check(pg_temp.install('anon-ref', 'android', 20, jsonb_build_object('device_key', pg_temp.device('android-1'),
  'referrer', 'kma_lc=Q2xpY2tJZDAwMDAwMDAwMQ')) = pg_temp.j('referrer') || '{"deep_link": null}'::jsonb
  and (select count(*) from public.attribution_installs where person_id = pg_temp.person('anon-ref')) = 1
  and pg_temp.matched_calls() = pg_temp.v('calls_before')::bigint + 1,
  'asking again gives the same answer without the deep link, which went out once');

select pg_temp.keep('rejected', pg_temp.install('anon-inject', 'android', 9, jsonb_build_object(
  'referrer', 'kma_lc=RejectedClick0000001', 'referrer_click_ts', pg_temp.epoch(10), 'install_begin_ts', pg_temp.epoch(12))));
select pg_temp.capture('attribution_install.rejected', pg_temp.j('rejected'));
select pg_temp.check(pg_temp.j('rejected') = '{"matched": false, "method": "install_referrer", "source": null, "campaign": null,
  "channel": null, "adset": null, "ad": null, "reinstall": false, "deep_link": null}'::jsonb
  and (select i.verdict = 'rejected' and i.fraud_reason = 'click_after_install' and i.click_id = 'RejectedClick0000001'
    and i.source is null and i.creator_click is null and i.deep_link_delivered_at is null and i.exact
    from pg_temp.installed('anon-inject') i),
  'a click after the install began is kept as rejected and credits nobody');
select pg_temp.check((select x->>'matched' = 'true' and i.verdict = 'flagged' and i.fraud_reason = 'too_fast' and i.source = 'tiktok'
  from (select pg_temp.install('anon-fast', 'android', 1, '{"referrer":"utm_source=tiktok&kma_lc=TooFastClick00000001"}') x) a,
    lateral (select * from pg_temp.installed('anon-fast')) i), 'a click 5 seconds before the app opened still counts, flagged');
select pg_temp.check((select x->>'matched' = 'true' and i.verdict = 'counted'
  from (select pg_temp.install('anon-zero-ts', 'android', 9, '{"referrer":"kma_lc=RejectedClick0000001","install_begin_ts":0}') x) a,
    lateral (select * from pg_temp.installed('anon-zero-ts')) i), 'Play''s 0 for an unknown install time is unknown, not a click after the install');
select pg_temp.check((pg_temp.install('anon-rival-ref', 'android', 15, '{"referrer":"kma_lc=RivalClick0000000001"}')->>'method') = 'organic',
  'another project''s click never matches');
select pg_temp.check((pg_temp.install('anon-encoded', 'android', 14, '{"referrer":"kma_lc%3DQ2xpY2tJZDAwMDAwMDAwMQ%26utm_source%3Dtiktok"}')->>'method') = 'install_referrer',
  'a referrer Play encoded once more is read');

-- 2. A link opened the app on its first launch ----------------------------------------------------
select pg_temp.keep('link_open', pg_temp.install('anon-link', 'ios', 15, jsonb_build_object('device_key', pg_temp.device('iphone-1'),
  'link_url', 'https://Fluent.go.kissmyapps.dev/lesson-4/?dl=quiz&src=Instagram&cmp=reels&sub1=story%20one&kma_click=' || repeat('c0ffee', 8) || '&fbclid=IwAR9#top')));
select pg_temp.capture('attribution_install.link_open', pg_temp.j('link_open'));
select pg_temp.check(pg_temp.j('link_open') = '{"matched": true, "method": "link_open", "source": "instagram", "campaign": "reels",
  "channel": null, "adset": null, "ad": null, "reinstall": false, "deep_link": {"value": "quiz", "params": {"id": "4"}, "deferred": true}}'::jsonb,
  'the opening link is the source, with the address''s own source and deep link value');
select pg_temp.check((select c.destination = 'app' and c.platform = 'ios' and c.in_app is null and c.source = 'instagram' and c.campaign = 'reels'
  and c.params = jsonb_build_object('dl', 'quiz', 'sub1', 'story one', 'creator_click', repeat('c0ffee', 8))
  and c.click_ids = '{"fbclid": "IwAR9"}'::jsonb and c.clicked_at = i.installed_at and c.id ~ '^[A-Za-z0-9_-]{22}$'
  and c.ip_hash = encode(extensions.digest(pg_temp.v('project') || ':' || repeat('b', 64), 'sha256'), 'hex')
  and c.user_agent = 'Fluent/2.4.0 CFNetwork/1490'
  and i.click_id = c.id and i.exact and i.verdict = 'counted' and i.creator_click = repeat('c0ffee', 8)
  from pg_temp.installed('anon-link') i join public.attribution_clicks c on c.id = i.click_id),
  'the link is recorded as a click on the app, with its creator''s click');
select pg_temp.check((pg_temp.install('anon-paused', 'ios', 14, '{"link_url":"https://fluent.go.kissmyapps.dev/old"}')->>'method') = 'organic',
  'a paused link does not match');
select pg_temp.check(not exists (select 1 from public.attribution_clicks where link_id = pg_temp.q('old')), 'and records no click');
select pg_temp.check((pg_temp.install('anon-elsewhere', 'ios', 14, '{"link_url":"https://elsewhere.example.test/lesson-4"}')->>'method') = 'organic'
  and (pg_temp.install('anon-rival-link', 'ios', 14, '{"link_url":"https://rival.go.kissmyapps.dev/lesson-4"}')->>'method') = 'organic',
  'another site or another project''s link does not match');
select pg_temp.check(not exists (select 1 from public.attribution_clicks where link_id = pg_temp.q('rival_link') and destination = 'app'),
  'nothing is recorded on the other project');

-- 4. Apple Ads -------------------------------------------------------------------------------------
select pg_temp.keep('apple_ads', pg_temp.install('anon-apple', 'ios', 12, jsonb_build_object('apple_ads', jsonb_build_object(
  'attribution', true, 'orgId', 40669820, 'campaignId', 542370539, 'adGroupId', 542317095, 'keywordId', 87675432,
  'adId', 542317136, 'clickDate', '2026-11-13T09:00Z', 'conversionType', 'Download', 'countryOrRegion', 'US', 'claimType', 'Click'))));
select pg_temp.capture('attribution_install.apple_ads', pg_temp.j('apple_ads'));
select pg_temp.check(pg_temp.j('apple_ads') = '{"matched": true, "method": "apple_ads", "source": "apple_ads", "campaign": "542370539",
  "channel": null, "adset": "542317095", "ad": "542317136", "reinstall": false, "deep_link": null}'::jsonb
  and (select i.exact and i.click_id is null and i.apple_ads = '{"orgId": 40669820, "campaignId": 542370539, "adGroupId": 542317095,
    "keywordId": 87675432, "adId": 542317136, "clickDate": "2026-11-13T09:00Z"}'::jsonb from pg_temp.installed('anon-apple') i),
  'an Apple Ads install keeps Apple''s IDs and click date, nothing else');
select pg_temp.check((pg_temp.install('anon-apple-no', 'ios', 12, '{"apple_ads":{"attribution":false}}')->>'method') = 'organic',
  'an install Apple did not attribute is not Apple''s');

-- 5. The clipboard ---------------------------------------------------------------------------------
-- The iPhone landing page's clicks, written directly: one with a creator's click (which
-- attribution_record_clicks keeps only once Piece B lands) and one older than the click window
-- (older than the link service may send).
insert into public.attribution_clicks(id, project_id, link_id, clicked_at, platform, destination, source, params) values
  ('ClipboardClick000001', pg_temp.q('project'), pg_temp.q('bio'), now() - interval '20 minutes', 'ios', 'page', 'instagram',
    jsonb_build_object('creator_click', repeat('ab12', 12))),
  ('OldClipboardClick001', pg_temp.q('project'), pg_temp.q('bio'), now() - interval '8 days', 'ios', 'page', 'instagram', '{}');
select pg_temp.check((select x->>'method' = 'clipboard' and x->'deep_link' = 'null'::jsonb and i.creator_click = repeat('ab12', 12)
  and i.source = 'instagram' and i.link_id = pg_temp.q('bio') and i.verdict = 'counted'
  from (select pg_temp.install('anon-clip', 'ios', 18, '{"clipboard_click":"ClipboardClick000001"}') x) a,
    lateral (select * from pg_temp.installed('anon-clip')) i), 'the click on the clipboard matches, and the link without a deep link sends none');
select pg_temp.check((pg_temp.install('anon-clip-old', 'ios', 18, '{"clipboard_click":"OldClipboardClick001"}')->>'method') = 'organic',
  'a click older than the click window does not match');

-- 7. Organic ---------------------------------------------------------------------------------------
select pg_temp.keep('organic', pg_temp.install('anon-organic', 'android', 5, jsonb_build_object('device_key', pg_temp.device('android-2'))));
select pg_temp.capture('attribution_install.organic', pg_temp.j('organic'));
select pg_temp.check(pg_temp.j('organic') = '{"matched": false, "method": "organic", "source": null, "campaign": null,
  "channel": null, "adset": null, "ad": null, "reinstall": false, "deep_link": null}'::jsonb
  and (select not i.exact and i.verdict = 'counted' and i.click_id is null from pg_temp.installed('anon-organic') i)
  and (select acquisition_method = 'organic' and acquisition_source is null from public.analytics_people where id = pg_temp.person('anon-organic')),
  'with nothing to go on the install is organic');

-- 1. Reinstalls -------------------------------------------------------------------------------------
select pg_temp.keep('reinstall', pg_temp.install('anon-reinstall', 'android', 2, jsonb_build_object('device_key', pg_temp.device('android-1'),
  'referrer', 'kma_lc=TooFastClick00000001')));
select pg_temp.capture('attribution_install.reinstall', pg_temp.j('reinstall'));
select pg_temp.check(pg_temp.j('reinstall') = '{"matched": true, "method": "reinstall", "source": "tiktok", "campaign": "launch",
  "channel": null, "adset": null, "ad": null, "reinstall": true, "deep_link": null}'::jsonb
  and (select i.reinstall_of = (pg_temp.installed('anon-ref')).id and i.exact and i.click_id = 'Q2xpY2tJZDAwMDAwMDAwMQ'
    and i.deep_link_value is null and i.deep_link_delivered_at is null from pg_temp.installed('anon-reinstall') i),
  'the same phone inside the reinstall window keeps the first install''s source, without a deep link');
select pg_temp.check((select i.method = 'reinstall' and i.reinstall_of = (pg_temp.installed('anon-ref')).id
  from (select pg_temp.install('anon-reinstall-2', 'android', 1.5, jsonb_build_object('device_key', pg_temp.device('android-1')))) x,
    lateral (select * from pg_temp.installed('anon-reinstall-2')) i), 'a second reinstall points at the first install');
select pg_temp.check((select x->>'method' = 'organic' and i.environment = 'development'
  from (select pg_temp.install('anon-dev', 'android', 1.5, jsonb_build_object('device_key', pg_temp.device('android-1')), pg_temp.v('dev_key')) x) a,
    lateral (select * from pg_temp.installed('anon-dev')) i), 'a development key is never a reinstall, so a merchant can test again');
select pg_temp.check((select x->>'method' = 'reinstall' and x->'deep_link' = '{"value": "lesson", "params": {"id": "4"}, "deferred": false}'::jsonb
  and i.reinstall_of = (pg_temp.installed('anon-link')).id and i.source = 'instagram' and i.deep_link_value is null
  from (select pg_temp.install('anon-relink', 'ios', 1.5, jsonb_build_object('device_key', pg_temp.device('iphone-1'),
    'link_url', 'https://fluent.go.kissmyapps.dev/lesson-4')) x) a,
    lateral (select * from pg_temp.installed('anon-relink')) i),
  'a link that opens a reinstalled app opens its screen; the source stays the first install''s');
select pg_temp.check(exists (select 1 from public.attribution_clicks c where c.link_id = pg_temp.q('lesson') and c.destination = 'app'
  and c.clicked_at = (pg_temp.installed('anon-relink')).installed_at), 'and it counts as a click on the link');
-- Servers may send older installs: one 100 days ago is outside the 90-day reinstall window.
select pg_temp.check((pg_temp.install('anon-server', 'android', 60 * 24 * 100, jsonb_build_object('device_key', pg_temp.device('android-3')),
  pg_temp.v('server_key'))->>'method') = 'organic'
  and (pg_temp.install('anon-window', 'android', 1.5, jsonb_build_object('device_key', pg_temp.device('android-3')))->>'method') = 'organic',
  'outside the reinstall window the phone is attributed afresh');

-- 6. Login: a signed-in person who came to the website through a link --------------------------------
select pg_temp.check(pg_temp.clicks(jsonb_build_array(
  jsonb_build_object('id', 'WebClickDesktop00001', 'link_id', pg_temp.v('lesson'), 'clicked_at', pg_temp.at(180), 'platform', 'desktop', 'destination', 'web'),
  jsonb_build_object('id', 'WebClickLater0000001', 'link_id', pg_temp.v('bio'), 'clicked_at', pg_temp.at(120), 'platform', 'desktop', 'destination', 'web'))) = 2,
  'the link service records two website clicks');
select pg_temp.visit('web-anon-1', 'user-web', 'web-s1', 179, '{"click":{"kma_lc":"WebClickDesktop00001"}}', array['page_viewed']);
select pg_temp.visit('web-anon-2', 'user-later', 'web-s2', 119, '{"click":{"kma_lc":"WebClickLater0000001"}}', array['page_viewed']);
select pg_temp.check((select x->>'method' = 'login' and x->>'source' = 'tiktok' and i.click_id = 'WebClickDesktop00001' and i.exact
  and i.person_id = pg_temp.person('user-web') and x->'deep_link' = '{"value": "lesson", "params": {"id": "4"}, "deferred": true}'::jsonb
  from (select pg_temp.install('anon-login', 'ios', 60, '{"user_id":"user-web"}') x) a,
    lateral (select * from pg_temp.installed('anon-login')) i), 'a signed-in person''s website click matches the install');

-- Organic installs matched later, once the person signs in ------------------------------------------
select pg_temp.check((pg_temp.install('anon-tick', 'android', 90)->>'method') = 'organic', 'an anonymous first launch is organic');
insert into qa select 'tick_app_person', pg_temp.person('anon-tick');
select pg_temp.check((pg_temp.app_events('anon-tick', 'user-later', 'android', 80, array['app_opened'])->>'stored') = '1',
  'the app signs the person in');
select pg_temp.check(not exists (select 1 from public.analytics_people where id = pg_temp.q('tick_app_person'))
  and (select i.person_id = pg_temp.person('user-later') and i.method = 'organic' and i.session_key = 'session-anon-tick'
    from pg_temp.installed('user-later') i)
  and (select acquisition_method = 'organic' and installed_at = pg_temp.at(90)::timestamptz and 'anon-tick' = any(anonymous_ids)
    from public.analytics_people where id = pg_temp.person('user-later')),
  'the phone''s person folds into the signed-in user; the install and the acquisition survive on the user');
insert into qa values ('calls_before_tick', pg_temp.matched_calls()::text);
select pg_temp.check(pg_temp.fails('select public.attribution_tick(''{"limit":0}'')') = '22023 invalid_input'
  and pg_temp.fails('select public.attribution_tick(''{"every":1}'')') = '22023 invalid_input', 'the tick takes a limit from 1 to 1000');
set local role service_role;
select pg_temp.keep('tick', public.attribution_tick('{}'::jsonb));
reset role;
select pg_temp.capture('attribution_tick.login', pg_temp.j('tick'));
select pg_temp.check(pg_temp.j('tick') = '{"checked": 1, "upgraded": 1}'::jsonb, 'the tick looks at the signed-in organic install and upgrades it');
select pg_temp.check((select i.method = 'login' and i.exact and i.click_id = 'WebClickLater0000001' and i.link_id = pg_temp.q('bio')
  and i.source = 'instagram' and i.verdict = 'counted' and i.deep_link_value is null
  from pg_temp.installed('user-later') i)
  and (select acquisition_method = 'login' and acquisition_source = 'instagram' and installed_at = pg_temp.at(90)::timestamptz
    from public.analytics_people where id = pg_temp.person('user-later'))
  and pg_temp.matched_calls() = pg_temp.v('calls_before_tick')::bigint + 1, 'the install and the person say login, and the hook runs');
set local role service_role;
select pg_temp.check(public.attribution_tick('{"limit":10}'::jsonb) = '{"checked": 0, "upgraded": 0}'::jsonb, 'a second run has nothing to do');
reset role;

-- A person keeps one install when two phones' people fold together: the earliest.
select pg_temp.install('anon-x', 'ios', 30, '{"user_id":"user-two"}');
select pg_temp.install('anon-y', 'android', 40);
select pg_temp.check((pg_temp.open('anon-y', 'android', 35, 'https://fluent.go.kissmyapps.dev/bio')->>'method') = 'link_open',
  'the second phone comes back through a link');
select pg_temp.check(exists (select 1 from public.attribution_engagements where person_id = pg_temp.person('anon-y')), 'a re-engagement of that phone');
select pg_temp.app_events('anon-y', 'user-two', 'android', 20, array['app_opened']);
select pg_temp.check((select count(*) = 1 and bool_and(i.session_key = 'session-anon-y') from public.attribution_installs i where i.person_id = pg_temp.person('user-two'))
  and (select installed_at = pg_temp.at(40)::timestamptz from public.analytics_people where id = pg_temp.person('user-two'))
  and exists (select 1 from public.attribution_engagements where person_id = pg_temp.person('user-two')),
  'the earlier install and the re-engagement stay with the user');

-- Opens: a link opens the app again -------------------------------------------------------------------
select pg_temp.keep('reengagement', pg_temp.open('anon-ref', 'android', 1, 'https://fluent.go.kissmyapps.dev/lesson-4?dl=lesson&id=4'));
select pg_temp.capture('attribution_open.reengagement', pg_temp.j('reengagement'));
select pg_temp.check(pg_temp.j('reengagement') = '{"matched": true, "method": "link_open", "source": "tiktok", "campaign": "launch",
  "channel": null, "adset": null, "ad": null, "reinstall": false, "deep_link": {"value": "lesson", "params": {"id": "4"}, "deferred": false}}'::jsonb,
  'an open answers the link''s deep link, not deferred');
select pg_temp.check((select e.opened_at = pg_temp.at(1)::timestamptz and e.ends_at = e.opened_at + interval '30 days' and e.source = 'tiktok'
  and e.link_id = pg_temp.q('lesson') and c.destination = 'app' and c.platform = 'android'
  from public.attribution_engagements e join public.attribution_clicks c on c.id = e.click_id
  where e.person_id = pg_temp.person('anon-ref'))
  and (select acquisition_method = 'install_referrer' from public.analytics_people where id = pg_temp.person('anon-ref'))
  and (pg_temp.installed('anon-ref')).method = 'install_referrer', 'it is a re-engagement for the re-engagement window; the acquisition stays');
select pg_temp.check(pg_temp.open('anon-nolink', 'ios', 1, 'https://fluent.app/pricing') = '{"matched": false, "method": "organic", "deep_link": null}'::jsonb
  and pg_temp.person('anon-nolink') is null, 'an address that is not a link stores nothing');
insert into qa values ('calls_before_open', pg_temp.matched_calls()::text);
select pg_temp.check((select x->>'method' = 'link_open' and x->'deep_link'->>'deferred' = 'false' and i.method = 'link_open' and i.exact
  and i.deep_link_delivered_at is not null and i.installed_at = pg_temp.at(3)::timestamptz
  and pg_temp.matched_calls() = pg_temp.v('calls_before_open')::bigint + 1
  from (select pg_temp.open('anon-open-first', 'ios', 3, 'https://fluent.go.kissmyapps.dev/lesson-4') x) a,
    lateral (select * from pg_temp.installed('anon-open-first')) i), 'an open without an install stores one from the link');
select pg_temp.check((pg_temp.install('anon-open-first', 'ios', 3) - 'source' - 'campaign') = '{"matched": true, "method": "link_open",
  "channel": null, "adset": null, "ad": null, "reinstall": false, "deep_link": null}'::jsonb, 'a late install call gets that answer, without the deep link again');
select pg_temp.install('anon-fresh', 'ios', 0.5);
select pg_temp.check((pg_temp.open('anon-fresh', 'ios', 0.2, 'https://fluent.go.kissmyapps.dev/bio')->>'method') = 'link_open',
  'a link in the first minute after the install opens its screen');
select pg_temp.check(not exists (select 1 from public.attribution_engagements where person_id = pg_temp.person('anon-fresh')),
  'it is the same launch, not a re-engagement');

-- Bots the merchant marked are not matched -------------------------------------------------------------
insert into public.analytics_bot_overrides(project_id, verdict, ip_hash)
values (pg_temp.q('project'), 'bot', encode(extensions.digest(pg_temp.v('project') || ':' || repeat('d', 64), 'sha256'), 'hex'));
select pg_temp.check(pg_temp.app('attribution_install', pg_temp.v('live_key'), pg_temp.install_body('anon-botnet', 'ios', 1),
  jsonb_build_object('ip_sha', repeat('d', 64))) = '{"matched": false, "method": "organic", "deep_link": null}'::jsonb
  and pg_temp.person('anon-botnet') is null, 'an install from a blocked network stores nothing');
select pg_temp.app_events('anon-bot', null, 'ios', 2, array['app_opened']);
select pg_temp.as_user('f8800000-0000-4000-8000-000000000001');
select public.analytics_set_override(pg_temp.q('project'), 'bot', pg_temp.person('anon-bot'));
select pg_temp.check(pg_temp.install('anon-bot', 'ios', 2) = '{"matched": false, "method": "organic", "deep_link": null}'::jsonb
  and pg_temp.installed('anon-bot') is null, 'a person marked as a bot gets no install');

-- "Test on your phone" ---------------------------------------------------------------------------------
select pg_temp.clicks(jsonb_build_array(jsonb_build_object('id', 'QrTestClick000000001', 'link_id', pg_temp.v('qr'),
  'clicked_at', pg_temp.at(3), 'platform', 'android', 'destination', 'play_store')));
select pg_temp.as_user('f8800000-0000-4000-8000-000000000002');
select pg_temp.keep('waiting', public.attribution_test_device(pg_temp.q('project'), pg_temp.q('qr')));
select pg_temp.capture('attribution_test_device.waiting', pg_temp.j('waiting'));
select pg_temp.check(pg_temp.j('waiting') = jsonb_build_object('link', jsonb_build_object('id', pg_temp.v('qr'), 'url', 'https://fluent.go.kissmyapps.dev/qr-test'),
  'click', jsonb_build_object('at', pg_temp.at(3)::timestamptz, 'platform', 'android'), 'install', null, 'deep_link_delivered', false),
  'the click arrived; the install has not');
select pg_temp.install('anon-qr', 'android', 2, '{"referrer":"kma_lc=QrTestClick000000001"}');
select pg_temp.as_user('f8800000-0000-4000-8000-000000000002');
select pg_temp.keep('done', public.attribution_test_device(pg_temp.q('project'), pg_temp.q('qr')));
select pg_temp.capture('attribution_test_device.done', pg_temp.j('done'));
select pg_temp.check(pg_temp.j('done') = pg_temp.j('waiting') || jsonb_build_object('install', jsonb_build_object('at', pg_temp.at(2)::timestamptz,
  'method', 'install_referrer', 'platform', 'android', 'exact', true), 'deep_link_delivered', true),
  'the install matched and its deep link went out');
select pg_temp.check((public.attribution_test_device(pg_temp.q('project'), pg_temp.q('old'))) = jsonb_build_object('link',
  jsonb_build_object('id', pg_temp.v('old'), 'url', 'https://fluent.go.kissmyapps.dev/old'), 'click', null, 'install', null, 'deep_link_delivered', false),
  'a link nothing happened on waits');
select pg_temp.check(pg_temp.fails(format('select public.attribution_test_device(%L, %L)', pg_temp.q('project'), pg_temp.q('rival_link'))) like 'P0002%',
  'another project''s link is not found');
select pg_temp.as_user('f8800000-0000-4000-8000-000000000003');
select pg_temp.check(pg_temp.fails(format('select public.attribution_test_device(%L, %L)', pg_temp.q('project'), pg_temp.q('qr'))) like 'P0002%',
  'strangers cannot test');

-- What the console reads ---------------------------------------------------------------------------------
select pg_temp.as_user('f8800000-0000-4000-8000-000000000002');
select pg_temp.keep('get', public.attribution_get(pg_temp.q('project')));
select pg_temp.capture('attribution_get.with_installs', pg_temp.j('get'));
select pg_temp.check((pg_temp.j('get')->'setup'->>'sdk') = 'true'
  and (pg_temp.j('get')->'installs'->>'total')::bigint = (select count(*) from public.attribution_installs where project_id = pg_temp.q('project'))
  and (pg_temp.j('get')->'installs'->>'last_at')::timestamptz = (select max(installed_at) from public.attribution_installs where project_id = pg_temp.q('project'))
  and pg_temp.j('get') ?& array['project_id', 'enabled', 'ever_enabled', 'link_root', 'cname_target', 'settings', 'domains', 'events', 'setup'],
  'the SDK step is done once an install arrived, with every install counted and the keys it had');

select pg_temp.keep('links', public.attribution_links(pg_temp.q('project'), '7d'));
select pg_temp.capture('attribution_links.with_installs', pg_temp.j('links'));
-- Lesson 4: the four referrer installs (plain, encoded, too fast, unknown install time), the
-- opening-link, login and open-first installs (the rejected one and the reinstalls do not
-- count), and one re-engagement. Bio: the clipboard and the
-- upgraded installs, and the second phone's re-engagement.
select pg_temp.check((select r->>'installs' = '7' and r->>'reengagements' = '1' and r ?& array['clicks', 'visits', 'conversions', 'deep_link_value']
  from pg_temp.link_row(pg_temp.j('links'), pg_temp.q('lesson')) r)
  and (select r->>'installs' = '2' and r->>'reengagements' = '1' from pg_temp.link_row(pg_temp.j('links'), pg_temp.q('bio')) r)
  and (select r->>'installs' = '1' and r->>'reengagements' = '0' from pg_temp.link_row(pg_temp.j('links'), pg_temp.q('qr')) r)
  and (select r->>'installs' = '0' and r->>'reengagements' = '0' from pg_temp.link_row(pg_temp.j('links'), pg_temp.q('old')) r),
  'each link counts its live installs and re-engagements');

select pg_temp.keep('sources', public.attribution_sources(pg_temp.q('project'), '7d'));
select pg_temp.capture('attribution_sources.with_installs', pg_temp.j('sources'));
select pg_temp.check((pg_temp.source_row(pg_temp.j('sources'), 'tiktok')->>'installs') = '6'
  and (pg_temp.source_row(pg_temp.j('sources'), 'instagram')->>'installs') = '3'
  and (pg_temp.source_row(pg_temp.j('sources'), 'apple_ads')->>'installs') = '1'
  and (pg_temp.source_row(pg_temp.j('sources'), 'qr')->>'installs') = '1'
  and (pg_temp.source_row(pg_temp.j('sources'), null)->>'installs')::bigint = (select count(*) from public.attribution_installs
    where project_id = pg_temp.q('project') and method = 'organic' and environment = 'production' and installed_at >= now() - interval '7 days')
  and (pg_temp.j('sources')->'totals'->>'installs')::bigint = (select count(*) from public.attribution_installs
    where project_id = pg_temp.q('project') and verdict <> 'rejected' and method <> 'reinstall' and environment = 'production'
      and installed_at >= now() - interval '7 days')
  and pg_temp.source_row(pg_temp.j('sources'), 'tiktok') ?& array['clicks', 'visits', 'people', 'conversions', 'converters'],
  'each source counts its live installs; rejected installs, reinstalls and development builds do not count');
select pg_temp.check((select r->>'key' = 'launch' and r->>'installs' = '6'
  from jsonb_array_elements(public.attribution_sources(pg_temp.q('project'), '7d', 'last', 'tiktok')->'rows') r where r->>'key' = 'launch'),
  'a source''s campaigns count their installs');

select pg_temp.keep('acquired', public.analytics_person(pg_temp.q('project'), pg_temp.person('anon-link')));
select pg_temp.capture('analytics_person.acquired', pg_temp.j('acquired'));
select pg_temp.check(pg_temp.j('acquired')->'acquisition' = jsonb_build_object('source', 'instagram', 'campaign', 'reels', 'method', 'link_open',
  'exact', true, 'installed_at', pg_temp.at(15)::timestamptz, 'link_name', 'Lesson 4', 'verdict', 'counted')
  and pg_temp.j('acquired') ?& array['person', 'override', 'stats', 'sessions', 'top_events', 'recent_events'],
  'a person shows where they were acquired, and everything they showed before');
select pg_temp.check((public.analytics_person(pg_temp.q('project'), pg_temp.person('anon-inject'))->'acquisition')
  = jsonb_build_object('source', null, 'campaign', null, 'method', 'install_referrer', 'exact', true,
    'installed_at', pg_temp.at(9)::timestamptz, 'link_name', 'Lesson 4', 'verdict', 'rejected'), 'a rejected install shows no source');
select pg_temp.app_events('anon-events-only', null, 'ios', 2, array['app_opened']);
select pg_temp.check(public.analytics_person(pg_temp.q('project'), pg_temp.person('anon-events-only'))->'acquisition' = 'null'::jsonb,
  'a person without an install has no acquisition');

-- Deleting ---------------------------------------------------------------------------------------------
select pg_temp.as_user(null);
delete from public.analytics_people where id = pg_temp.person('anon-ref');
select pg_temp.check((select bool_and(i.method = 'reinstall' and i.reinstall_of is null and i.source = 'tiktok')
  from public.attribution_installs i where i.person_id in (pg_temp.person('anon-reinstall'), pg_temp.person('anon-reinstall-2'))),
  'deleting a person keeps the reinstalls of their phone, with their source');
select pg_temp.as_user('f8800000-0000-4000-8000-000000000001');
select public.analytics_delete_project(pg_temp.q('project'), 'Fluent');
select pg_temp.check(not exists (select 1 from public.attribution_installs where project_id = pg_temp.q('project'))
  and not exists (select 1 from public.attribution_engagements where project_id = pg_temp.q('project')),
  'a deleted project takes its installs and re-engagements with it');

select 'ok ' || count(*) || ' attribution install assertions' from installs_assertions;
rollback;
