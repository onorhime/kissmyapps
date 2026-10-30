-- Provider-free test of merchant analytics: workspaces, projects and keys, the
-- ingest path, identity merging, reports, bot filtering and session replays.
begin;
set local time zone 'UTC';
create temporary table analytics_assertions(label text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Analytics assertion failed: %', label; end if;
  insert into analytics_assertions values (label);
end $$;
-- Runs a statement and returns its SQLSTATE and message, or 'ok'.
create function pg_temp.fails(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.as_user(id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', id, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.ingest(token text, body jsonb, extra jsonb default '{}') returns jsonb language sql as $$
  select public.analytics_ingest(jsonb_build_object('key_hash', encode(extensions.digest(token, 'sha256'), 'hex'), 'body', body) || extra)
$$;
create function pg_temp.at(minutes_ago numeric) returns text language sql as $$
  select to_char((now() - make_interval(secs => minutes_ago * 60)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
create function pg_temp.ev(name text, insert_id text, minutes_ago numeric, screen text default null, props jsonb default '{}') returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('name', name, 'insert_id', insert_id, 'time', pg_temp.at(minutes_ago), 'screen', screen))
    || jsonb_build_object('properties', props)
$$;
create temporary table qa(key text primary key, value text);
grant all on qa, analytics_assertions to authenticated, service_role;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('a1000000-0000-4000-8000-000000000001', 'owner@nobrainer.example', now(), '{"full_name":"Ada Owner","company":"Nobrainer Lab"}'::jsonb),
  ('a1000000-0000-4000-8000-000000000002', 'analyst@nobrainer.example', now(), '{"full_name":"Tolu Analyst"}'::jsonb),
  ('a1000000-0000-4000-8000-000000000003', 'stranger@elsewhere.example', now(), '{}'),
  ('a1000000-0000-4000-8000-000000000004', 'unconfirmed@nobrainer.example', null, '{}');

-- Privileges -------------------------------------------------------------------------------
select pg_temp.check(not has_table_privilege('authenticated', 'public.analytics_events', 'select'), 'members cannot read raw events');
select pg_temp.check(not has_table_privilege('anon', 'public.analytics_people', 'select'), 'anon cannot read people');
select pg_temp.check(not has_function_privilege('authenticated', 'public.analytics_ingest(jsonb)', 'execute'), 'only the ingest service writes');
select pg_temp.check(not has_function_privilege('anon', 'public.analytics_overview(uuid,text)', 'execute'), 'anon cannot read reports');
select pg_temp.check(has_function_privilege('service_role', 'public.analytics_ingest(jsonb)', 'execute'), 'ingest service can write');
select pg_temp.check(not has_function_privilege('authenticated', 'public.analytics_purge_replays(interval)', 'execute'), 'members cannot purge');
select pg_temp.check(pg_temp.fails('select public.analytics_context()') like '42501%', 'signed-out calls are refused');

-- Workspace bootstrap ----------------------------------------------------------------------
select pg_temp.as_user('a1000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.check(pg_temp.fails('select count(*) from public.analytics_projects') like '42501%', 'tables stay closed to members');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
reset role;
select pg_temp.check((select name = 'Nobrainer Lab' from public.analytics_workspaces where id = (select value::uuid from qa where key = 'workspace')), 'workspace named after the company');
select pg_temp.check(jsonb_array_length(public.analytics_bootstrap()->'workspaces') = 1, 'bootstrap is idempotent');
select pg_temp.check((public.analytics_context()->'workspaces'->0->>'role') = 'owner', 'creator owns the workspace');

-- Projects and keys -----------------------------------------------------------------------
select pg_temp.check(pg_temp.fails(format('select public.analytics_create_project(%L, %L, array[''web''], ''UTC'')', (select value from qa where key = 'workspace'), ' ')) like '22023%', 'project needs a name');
select pg_temp.check(pg_temp.fails(format('select public.analytics_create_project(%L, ''X'', array[''web''], ''Mars/Olympus'')', (select value from qa where key = 'workspace'))) like '22023%', 'project needs a real time zone');
select pg_temp.check(pg_temp.fails(format('select public.analytics_create_project(%L, ''X'', array[''tv''], ''UTC'')', (select value from qa where key = 'workspace'))) like '22023%', 'project needs a known platform');
with created as (select public.analytics_create_project((select value::uuid from qa where key = 'workspace'), 'SpeakSix', array['web', 'ios', 'web'], 'Africa/Lagos') r)
insert into qa select 'project', r->'project'->>'id' from created
union all select 'client_token', r->'key'->>'token' from created
union all select 'client_name', r->'key'->>'name' from created;
select pg_temp.check((select value ~ '^kma_pk_live_[A-Za-z0-9]{24}$' from qa where key = 'client_token'), 'new project gets a live client key');
select pg_temp.check((select value = 'Apps' from qa where key = 'client_name'), 'client key named for apps');
select pg_temp.check((select platforms = array['ios', 'web'] from public.analytics_projects where id = (select value::uuid from qa where key = 'project')), 'platforms are de-duplicated');
select pg_temp.check((select count(*) = 4 and bool_and(enabled) from public.analytics_bot_rules where project_id = (select value::uuid from qa where key = 'project')), 'bot rules start enabled');
select pg_temp.check((select token_hash = extensions.digest((select value from qa where key = 'client_token'), 'sha256') from public.analytics_api_keys where project_id = (select value::uuid from qa where key = 'project')), 'keys are stored as hashes');

insert into qa select 'server_token', public.analytics_create_key((select value::uuid from qa where key = 'project'), 'Backend', 'server', 'production')->>'token';
insert into qa select 'dev_token', public.analytics_create_key((select value::uuid from qa where key = 'project'), 'Staging', 'client', 'development')->>'token';
select pg_temp.check((select value ~ '^kma_sk_live_[A-Za-z0-9]{40}$' from qa where key = 'server_token'), 'server key format');
select pg_temp.check((select value ~ '^kma_pk_test_' from qa where key = 'dev_token'), 'development key format');
select pg_temp.check((select bool_and(case k->>'kind' when 'server' then k->>'token' is null else k->>'token' is not null end)
  from jsonb_array_elements(public.analytics_project_settings((select value::uuid from qa where key = 'project'))->'keys') k), 'server keys are never shown again');
select pg_temp.check(pg_temp.fails(format('select public.analytics_create_key(%L, ''x'', ''root'', ''production'')', (select value from qa where key = 'project'))) like '22023%', 'unknown key kind refused');

-- A second project in the same workspace, for switching and isolation.
insert into qa select 'project2', public.analytics_create_project((select value::uuid from qa where key = 'workspace'), 'DramaPal', array['android'], 'UTC')->'project'->>'id';

-- Ingest: an anonymous web visitor -------------------------------------------------------------
select pg_temp.check(pg_temp.fails($$select pg_temp.ingest('kma_pk_live_nope', '{}')$$) like '28000%', 'unknown key refused');
select pg_temp.as_user(null);
set local role service_role;
insert into qa select 'r1', pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object(
  'anonymous_id', 'anon-web-1',
  'session', jsonb_build_object('id', 'sess-web-1', 'started_at', pg_temp.at(12)),
  'context', jsonb_build_object('platform', 'web', 'timezone', 'Africa/Lagos', 'language', 'en-NG', 'device_type', 'desktop',
    'os_name', 'macOS', 'os_version', '14.5', 'browser', 'Chrome', 'browser_version', '129.0.6668', 'screen_width', 1440, 'screen_height', 900,
    'referrer', 'https://www.google.com/search?q=speak', 'utm', jsonb_build_object('source', 'newsletter', 'campaign', 'autumn'),
    'page_path', '/', 'interactions', 7, 'sdk', 'kma-web/1.0.0'),
  'events', jsonb_build_array(
    pg_temp.ev('session_started', 'w1-1', 12),
    pg_temp.ev('page_viewed', 'w1-2', 12, '/'),
    pg_temp.ev('page_viewed', 'w1-3', 9, '/pricing'),
    pg_temp.ev('plan_selected', 'w1-4', 8, '/pricing', '{"plan":"annual","price":59.99}'::jsonb),
    pg_temp.ev('page_viewed', 'w1-5', 7, '/checkout'),
    pg_temp.ev('bad name!', 'w1-6', 7),
    jsonb_build_object('name', 'page_viewed', 'insert_id', 'w1-7', 'time', '2020-01-01T00:00:00Z'),
    jsonb_build_object('name', 'page_viewed', 'insert_id', 'w1-8', 'time', pg_temp.at(-30))
  )), jsonb_build_object('ip_sha', 'ip-lagos-1', 'origin', 'https://speaksix.example', 'user_agent', 'Mozilla/5.0 (Macintosh) Chrome/129.0',
    'geo', jsonb_build_object('country', 'NG', 'region', 'Lagos', 'city', 'Lagos', 'source', 'edge')))::text;
reset role;
select pg_temp.check((select value::jsonb->>'stored' = '5' from qa where key = 'r1'), 'valid events stored');
select pg_temp.check((select (select jsonb_agg(x->>'reason' order by (x->>'index')::int) from jsonb_array_elements(value::jsonb->'rejected') x)
  = '["invalid_event","time_out_of_range","time_out_of_range"]'::jsonb from qa where key = 'r1'), 'bad, stale and future events rejected with reasons');
select pg_temp.check((select count(*) = 1 from public.analytics_people where distinct_id = 'anon-web-1' and country = 'NG' and city = 'Lagos'
  and browser = 'Chrome' and os_name = 'macOS' and timezone = 'Africa/Lagos' and sessions_count = 1 and events_count = 5
  and initial_utm_source = 'newsletter' and initial_landing = '/'), 'anonymous person carries place, device and source');
select pg_temp.check((select screens_count = 3 and events_count = 5 and entry_screen = '/' and exit_screen = '/checkout' and interactions = 7
  and ended_at > started_at and bot_reasons = '{}' and ip_hash is not null and ip_hash <> 'ip-lagos-1'
  from public.analytics_sessions where session_key = 'sess-web-1'), 'session records screens, entry, exit and a hashed network');
select pg_temp.check(pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object('anonymous_id', 'anon-web-1',
  'session', jsonb_build_object('id', 'sess-web-1'), 'events', jsonb_build_array(pg_temp.ev('page_viewed', 'w1-2', 12, '/'))))->>'duplicates' = '1', 'resent events are counted once');

select pg_temp.check((select jsonb_agg(x->>'reason') from jsonb_array_elements(pg_temp.ingest((select value from qa where key = 'client_token'),
  jsonb_build_object('events', jsonb_build_array(pg_temp.ev('page_viewed', 'anon-0', 1, '/'))))->'rejected') x) = '["identity_required"]'::jsonb, 'events need a person');

-- Identify on the same device keeps the same person.
select pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object(
  'anonymous_id', 'anon-web-1', 'user_id', 'user-42', 'traits', '{"email":"amaka@example.com","name":"Amaka Obi","plan":"annual"}'::jsonb,
  'session', jsonb_build_object('id', 'sess-web-1'), 'context', '{"platform":"web","browser":"Chrome","interactions":12}'::jsonb,
  'events', jsonb_build_array(pg_temp.ev('trial_started', 'w1-10', 6, '/checkout'))));
select pg_temp.check((select count(*) = 1 from public.analytics_people where project_id = (select value::uuid from qa where key = 'project')), 'identify does not create a second person');
select pg_temp.check((select distinct_id = 'user-42' and user_id = 'user-42' and anonymous_ids = array['anon-web-1'] and traits->>'email' = 'amaka@example.com'
  and events_count = 6 from public.analytics_people where project_id = (select value::uuid from qa where key = 'project')), 'person takes the user ID and traits');

-- The same user on a phone, first anonymously, then signed in: both devices fold into one person.
select pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object(
  'anonymous_id', 'anon-ios-1', 'session', jsonb_build_object('id', 'sess-ios-1', 'started_at', pg_temp.at(5)),
  'context', '{"platform":"ios","device_type":"mobile","device_model":"iPhone 15","os_name":"iOS","os_version":"18.1","app_version":"2.4.0","network":"wifi","carrier":"MTN"}'::jsonb,
  'events', jsonb_build_array(pg_temp.ev('session_started', 'i1-1', 5), pg_temp.ev('screen_viewed', 'i1-2', 5, 'Home'))),
  '{"ip_sha":"ip-lagos-2","geo":{"country":"NG","source":"timezone"}}'::jsonb);
select pg_temp.check((select count(*) = 2 from public.analytics_people where project_id = (select value::uuid from qa where key = 'project')), 'a new device starts as its own person');
select pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object(
  'anonymous_id', 'anon-ios-1', 'session', jsonb_build_object('id', 'sess-ios-1'),
  'context', '{"platform":"ios","device_type":"mobile","device_model":"iPhone 15","os_name":"iOS","os_version":"18.1","app_version":"2.4.0","interactions":4}'::jsonb,
  'events', jsonb_build_array(pg_temp.ev('screen_viewed', 'i1-3', 4, 'Lesson'),
    pg_temp.ev('lesson_completed', 'i1-4', 3, 'Lesson', '{"lesson":3}'::jsonb) || '{"user_id":"user-42"}'::jsonb)),
  '{"ip_sha":"ip-lagos-2","geo":{"country":"NG","source":"timezone"}}'::jsonb);
select pg_temp.check((select count(*) = 1 from public.analytics_people where project_id = (select value::uuid from qa where key = 'project')), 'signing in on the phone merges the devices');
select pg_temp.check((select sessions_count = 2 and events_count = 10 and anonymous_ids @> array['anon-web-1', 'anon-ios-1']
  and platform = 'ios' and device_model = 'iPhone 15' and initial_utm_source = 'newsletter'
  from public.analytics_people where distinct_id = 'user-42'), 'merged person keeps both histories and the latest device');
select pg_temp.check((select count(distinct person_id) = 1 from public.analytics_sessions where project_id = (select value::uuid from qa where key = 'project')), 'both sessions belong to the user');
select pg_temp.check((select count(*) = 0 from public.analytics_events e where e.project_id = (select value::uuid from qa where key = 'project')
  and not exists (select 1 from public.analytics_people p where p.id = e.person_id)), 'no event is orphaned by the merge');

-- A heartbeat with no events keeps the session going.
select pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object('anonymous_id', 'anon-ios-1', 'user_id', 'user-42',
  'session', jsonb_build_object('id', 'sess-ios-1'), 'sent_at', pg_temp.at(1), 'events', '[]'::jsonb));
select pg_temp.check((select ended_at >= now() - interval '90 seconds' from public.analytics_sessions where session_key = 'sess-ios-1'), 'heartbeat extends the session');

-- Origins and keys -------------------------------------------------------------------------------
select pg_temp.as_user('a1000000-0000-4000-8000-000000000001');
select public.analytics_update_project((select value::uuid from qa where key = 'project'), '{"allowed_origins":["https://speaksix.example","HTTPS://WWW.SPEAKSIX.EXAMPLE "]}'::jsonb);
select pg_temp.check((select allowed_origins = array['https://speaksix.example', 'https://www.speaksix.example'] from public.analytics_projects where id = (select value::uuid from qa where key = 'project')), 'origins normalised');
select pg_temp.check(pg_temp.fails(format('select public.analytics_update_project(%L, ''{"allowed_origins":["speaksix.example/path"]}'')', (select value from qa where key = 'project'))) like '22023%', 'origins must be bare origins');
select pg_temp.check(pg_temp.fails(format('select public.analytics_update_project(%L, ''{"owner":"me"}'')', (select value from qa where key = 'project'))) like '22023%', 'unknown settings refused');
select pg_temp.check(pg_temp.fails($$select pg_temp.ingest((select value from qa where key = 'client_token'), '{"anonymous_id":"x","events":[]}'::jsonb, '{"origin":"https://evil.example"}'::jsonb)$$) like '42501%', 'other websites cannot use the client key');
select pg_temp.check(pg_temp.fails($$select pg_temp.ingest((select value from qa where key = 'client_token'), '{"anonymous_id":"x","events":[]}'::jsonb, '{"origin":"https://www.speaksix.example"}'::jsonb)$$) = 'ok', 'listed websites can');
select pg_temp.check(pg_temp.fails($$select pg_temp.ingest((select value from qa where key = 'dev_token'), '{"anonymous_id":"x","events":[]}'::jsonb, '{"origin":"http://localhost:3000"}'::jsonb)$$) = 'ok', 'development keys work from any site');

-- Server import: history for many users, place from the payload, no browser rules.
select pg_temp.as_user(null);
insert into qa select 'server_import', pg_temp.ingest((select value from qa where key = 'server_token'), jsonb_build_object(
  'session', jsonb_build_object('id', 'srv-old-1', 'started_at', to_char((now() - interval '10 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  'context', '{"platform":"android","country":"gh","city":"Accra","app_version":"2.3.1","device_model":"Pixel 8","os_name":"Android","os_version":"15"}'::jsonb,
  'user_id', 'user-77', 'traits', '{"email":"kwame@example.com"}'::jsonb,
  'events', jsonb_build_array(pg_temp.ev('session_started', 'srv-1', 14400), pg_temp.ev('screen_viewed', 'srv-2', 14399, 'Home'))),
  '{"origin":"https://evil.example","ip_sha":"server-ip","geo":{"country":"US","source":"edge"},"user_agent":"node-fetch/1.0"}'::jsonb)::text;
select pg_temp.check((select value::jsonb->>'stored' = '2' from qa where key = 'server_import'), 'server keys may import history and ignore origins');
select pg_temp.check((select country = 'GH' and city = 'Accra' and location_source = 'api' and ip_hash is null and user_agent is null and bot_reasons = '{}'
  from public.analytics_sessions where session_key = 'srv-old-1'), 'server calls take place from the payload, not the server');
-- The returning user comes back today on the app.
select pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object('user_id', 'user-77', 'anonymous_id', 'anon-android-77',
  'session', jsonb_build_object('id', 'sess-android-77', 'started_at', pg_temp.at(30)),
  'context', '{"platform":"android","device_type":"mobile","device_model":"Pixel 8","os_name":"Android","os_version":"15","app_version":"2.4.0","interactions":9}'::jsonb,
  'events', jsonb_build_array(pg_temp.ev('session_started', 'a77-1', 30), pg_temp.ev('screen_viewed', 'a77-2', 30, 'Home'),
    pg_temp.ev('lesson_completed', 'a77-3', 25, 'Lesson', '{"lesson":8}'::jsonb), pg_temp.ev('error_thrown', 'a77-4', 24, 'Lesson', '{"message":"Audio failed"}'::jsonb))),
  '{"ip_sha":"ip-accra","geo":{"country":"GH","region":"Greater Accra","city":"Accra","source":"edge"}}'::jsonb);

-- Development traffic is kept apart from reports.
select pg_temp.ingest((select value from qa where key = 'dev_token'), jsonb_build_object('anonymous_id', 'dev-tester',
  'session', jsonb_build_object('id', 'sess-dev'), 'context', '{"platform":"web","interactions":1}'::jsonb,
  'events', jsonb_build_array(pg_temp.ev('page_viewed', 'dev-1', 2, '/'))));

-- Bots ----------------------------------------------------------------------------------------------
-- A headless browser, a crawler, and a script that fires 30 events in two seconds.
select pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object('anonymous_id', 'anon-headless',
  'session', jsonb_build_object('id', 'sess-headless'), 'context', '{"platform":"web","webdriver":true,"interactions":0}'::jsonb,
  'events', jsonb_build_array(pg_temp.ev('page_viewed', 'hl-1', 6, '/'))),
  '{"ip_sha":"ip-dc-1","user_agent":"Mozilla/5.0 HeadlessChrome/129.0","geo":{"country":"US"}}'::jsonb);
select pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object('anonymous_id', 'anon-crawler',
  'session', jsonb_build_object('id', 'sess-crawler'), 'context', '{"platform":"web"}'::jsonb,
  'events', jsonb_build_array(pg_temp.ev('page_viewed', 'cr-1', 6, '/'))),
  '{"ip_sha":"ip-dc-2","user_agent":"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)","geo":{"country":"US"}}'::jsonb);
select pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object('anonymous_id', 'anon-fast',
  'session', jsonb_build_object('id', 'sess-fast'), 'context', '{"platform":"android","app_version":"2.4.0"}'::jsonb,
  'events', (select jsonb_agg(pg_temp.ev('button_tapped', 'fast-' || n, 4 - n / 900.0)) from generate_series(1, 30) n)),
  '{"ip_sha":"ip-dc-3","geo":{"country":"DE"}}'::jsonb);
select pg_temp.check((select bot_reasons = array['automation'] from public.analytics_sessions where session_key = 'sess-headless'), 'headless browser flagged');
select pg_temp.check((select bot_reasons = array['crawler'] from public.analytics_sessions where session_key = 'sess-crawler'), 'crawler flagged');
select pg_temp.check((select bot_reasons = array['too_fast'] from public.analytics_sessions where session_key = 'sess-fast'), 'inhuman speed flagged');
select pg_temp.check((select bot_reasons = '{}' from public.analytics_sessions where session_key = 'sess-android-77'), 'real app session is not flagged');

-- Reports ---------------------------------------------------------------------------------------------
select pg_temp.as_user('a1000000-0000-4000-8000-000000000001');
insert into qa select 'overview', public.analytics_overview((select value::uuid from qa where key = 'project'), '7d')::text;
select pg_temp.check((select (value::jsonb->'current'->>'users')::int = 2 from qa where key = 'overview'), 'bots and development traffic are not users');
select pg_temp.check((select (value::jsonb->'current'->>'new_users')::int = 1 and (value::jsonb->'current'->>'returning_users')::int = 1 from qa where key = 'overview'), 'new and returning users split');
select pg_temp.check((select (value::jsonb->'current'->>'sessions')::int = 3 and (value::jsonb->'current'->>'errors')::int = 1 from qa where key = 'overview'), 'sessions and errors counted');
select pg_temp.check((select (value::jsonb->>'online_now')::int = 1 from qa where key = 'overview'), 'online now counts people active in the last five minutes');
select pg_temp.check((select value::jsonb->'breakdowns'->'countries' = '[{"key":"NG","users":1},{"key":"GH","users":1}]'::jsonb
  or value::jsonb->'breakdowns'->'countries' = '[{"key":"GH","users":1},{"key":"NG","users":1}]'::jsonb from qa where key = 'overview'), 'countries counted by people');
select pg_temp.check((select value::jsonb->'breakdowns'->'actions'->0->>'key' = 'lesson_completed' and (value::jsonb->'breakdowns'->'actions'->0->>'users')::int = 2
  from qa where key = 'overview'), 'top action counted by people');
select pg_temp.check((select value::jsonb->'breakdowns'->'referrers' = '[{"key":"newsletter","users":1}]'::jsonb from qa where key = 'overview'), 'acquisition source reported');
select pg_temp.check((select (value::jsonb->'bots'->>'excluded_sessions')::int = 3 from qa where key = 'overview'), 'bot sessions summarised');
select pg_temp.check((select jsonb_array_length(value::jsonb->'series') = 7 and (select sum((x->>'sessions')::int) from jsonb_array_elements(value::jsonb->'series') x) = 3
  from qa where key = 'overview'), 'daily series covers the week and adds up');
select pg_temp.check(jsonb_array_length(public.analytics_overview((select value::uuid from qa where key = 'project'), 'today')->'series') = 24, 'today charts 24 hours');
select pg_temp.check((select (value::jsonb->'previous'->>'users')::int = 1 from qa where key = 'overview'), 'previous week has the imported user');
select pg_temp.check(pg_temp.fails(format('select public.analytics_overview(%L, ''1y'')', (select value from qa where key = 'project'))) like '22023%', 'unknown range refused');

insert into qa select 'people', public.analytics_people_page((select value::uuid from qa where key = 'project'), '{"range":"7d"}'::jsonb)::text;
select pg_temp.check((select (value::jsonb->>'total')::int = 2 from qa where key = 'people'), 'people list matches active users');
select pg_temp.check((select value::jsonb->'rows'->0->>'distinct_id' = 'user-42' and (value::jsonb->'rows'->0->>'online')::boolean
  from qa where key = 'people'), 'most recent person first, shown online');
select pg_temp.check((public.analytics_people_page((select value::uuid from qa where key = 'project'), '{"range":"7d","status":"new"}'::jsonb)->>'total')::int = 1, 'new filter');
select pg_temp.check((public.analytics_people_page((select value::uuid from qa where key = 'project'), '{"range":"7d","country":"GH"}'::jsonb)->'rows'->0->>'distinct_id') = 'user-77', 'country filter');
select pg_temp.check((public.analytics_people_page((select value::uuid from qa where key = 'project'), '{"range":"7d","search":"kwame@"}'::jsonb)->>'total')::int = 1, 'search by email trait');
select pg_temp.check((public.analytics_people_page((select value::uuid from qa where key = 'project'), '{"range":"7d","search":"anon-headless"}'::jsonb)->>'total')::int = 1, 'search finds anyone, even bots');
select pg_temp.check((public.analytics_people_page((select value::uuid from qa where key = 'project'), '{"range":"7d","sort":"events","direction":"asc"}'::jsonb)->'rows'->0->>'distinct_id') = 'user-77', 'sort by events');

insert into qa select 'person', public.analytics_person((select value::uuid from qa where key = 'project'), (select id from public.analytics_people where distinct_id = 'user-42'))::text;
select pg_temp.check((select jsonb_array_length(value::jsonb->'sessions') = 2 and (value::jsonb->'stats'->>'sessions')::int = 2
  and value::jsonb->'person'->'traits'->>'name' = 'Amaka Obi' and jsonb_array_length(value::jsonb->'recent_events') = 10 from qa where key = 'person'), 'profile lists sessions and activity');

insert into qa select 'sessions', public.analytics_sessions_page((select value::uuid from qa where key = 'project'), '{"range":"7d"}'::jsonb)::text;
select pg_temp.check((select (value::jsonb->>'total')::int = 3 from qa where key = 'sessions'), 'sessions exclude bots by default');
select pg_temp.check((public.analytics_sessions_page((select value::uuid from qa where key = 'project'), '{"range":"7d","bots":"only"}'::jsonb)->>'total')::int = 3, 'bot sessions on request');
select pg_temp.check((public.analytics_sessions_page((select value::uuid from qa where key = 'project'), '{"range":"7d","platform":"ios"}'::jsonb)->'rows'->0->>'distinct_id') = 'user-42', 'platform filter');
select pg_temp.check((public.analytics_sessions_page((select value::uuid from qa where key = 'project'), jsonb_build_object('range', '30d', 'person_id', (select id from public.analytics_people where distinct_id = 'user-77')))->>'total')::int = 2, 'person filter');

insert into qa select 'session', public.analytics_session((select value::uuid from qa where key = 'project'), (select id from public.analytics_sessions where session_key = 'sess-web-1'))::text;
select pg_temp.check((select (select jsonb_agg(e->>'name') from jsonb_array_elements(value::jsonb->'events') e)
  = '["session_started","page_viewed","page_viewed","plan_selected","page_viewed","trial_started"]'::jsonb from qa where key = 'session'), 'session events in order');
select pg_temp.check((select value::jsonb->'session'->>'country' = 'NG' and value::jsonb->'session'->>'city' = 'Lagos' and value::jsonb->'session'->>'browser' = 'Chrome'
  and value::jsonb->'person'->>'distinct_id' = 'user-42' from qa where key = 'session'), 'session shows place, device and person');

insert into qa select 'catalog', public.analytics_events_catalog((select value::uuid from qa where key = 'project'), '7d')::text;
select pg_temp.check((select (e->>'users')::int = 2 and (e->>'events')::int = 2 from qa, jsonb_array_elements(value::jsonb->'events') e
  where qa.key = 'catalog' and e->>'name' = 'lesson_completed'), 'catalogue counts people and events');
select pg_temp.check((select (e->>'events')::int = 0 from qa, jsonb_array_elements(value::jsonb->'events') e
  where qa.key = 'catalog' and e->>'name' = 'button_tapped'), 'bot-only events count nothing');
insert into qa select 'event', public.analytics_event((select value::uuid from qa where key = 'project'), 'lesson_completed', '7d', 'platform')::text;
select pg_temp.check((select value::jsonb->'keys' = '["android","ios"]'::jsonb and (value::jsonb->'totals'->>'users')::int = 2
  and value::jsonb->'properties'->0->>'key' = 'lesson' and jsonb_array_length(value::jsonb->'series') = 7 from qa where key = 'event'), 'event detail breaks down by platform');
select pg_temp.check(jsonb_array_length(public.analytics_live((select value::uuid from qa where key = 'project'), null, 500)) = 49, 'live feed lists every event');
select pg_temp.check(jsonb_array_length(public.analytics_live((select value::uuid from qa where key = 'project'),
  (select max(id) - 2 from public.analytics_events), 500)) = 2, 'live feed pages after an ID');

-- Bot overrides and rules ---------------------------------------------------------------------------
insert into qa select 'bots', public.analytics_bots((select value::uuid from qa where key = 'project'), '7d')::text;
select pg_temp.check((select (value::jsonb->'totals'->>'excluded_sessions')::int = 3 and jsonb_array_length(value::jsonb->'flagged') = 3
  and (select (r->>'sessions')::int from jsonb_array_elements(value::jsonb->'rules') r where r->>'rule' = 'automation') = 1 from qa where key = 'bots'), 'bots report lists flagged sessions by rule');
select public.analytics_set_override((select value::uuid from qa where key = 'project'), 'human', (select id from public.analytics_people where distinct_id = 'anon-headless'), null, 'Our QA robot');
select pg_temp.check((public.analytics_overview((select value::uuid from qa where key = 'project'), '7d')->'current'->>'users')::int = 3, 'marking a person human brings them back');
select public.analytics_set_bot_rule((select value::uuid from qa where key = 'project'), 'crawler', false);
select pg_temp.check((public.analytics_overview((select value::uuid from qa where key = 'project'), '7d')->'current'->>'users')::int = 4, 'turning a rule off counts its sessions');
select pg_temp.check(pg_temp.fails(format('select public.analytics_set_bot_rule(%L, ''vibes'', true)', (select value from qa where key = 'project'))) like '22023%', 'unknown rule refused');
select public.analytics_set_override((select value::uuid from qa where key = 'project'), 'bot', (select id from public.analytics_people where distinct_id = 'user-77'), null, 'Scraper account');
select pg_temp.check((public.analytics_overview((select value::uuid from qa where key = 'project'), '7d')->'current'->>'users')::int = 3, 'blocking a person removes them');
select pg_temp.check((select (select jsonb_agg(x->>'reason') from jsonb_array_elements(pg_temp.ingest((select value from qa where key = 'client_token'),
  jsonb_build_object('user_id', 'user-77', 'session', jsonb_build_object('id', 'sess-android-77'), 'events', jsonb_build_array(pg_temp.ev('screen_viewed', 'a77-9', 1, 'Home'))))->'rejected') x)
  = '["blocked"]'::jsonb), 'blocked person cannot send more');
select public.analytics_set_override((select value::uuid from qa where key = 'project'), 'bot', null, (select id from public.analytics_sessions where session_key = 'sess-fast'), 'Data centre');
select pg_temp.check((pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object('anonymous_id', 'brand-new',
  'events', jsonb_build_array(pg_temp.ev('page_viewed', 'bn-1', 1, '/'))), '{"ip_sha":"ip-dc-3"}'::jsonb)->>'blocked')::boolean, 'blocked network cannot send');
select pg_temp.check(pg_temp.fails(format('select public.analytics_set_override(%L, ''human'', null, %L)', (select value from qa where key = 'project'),
  (select id from public.analytics_sessions where session_key = 'sess-fast'))) like '22023%', 'networks can only be blocked');
select public.analytics_delete_override((select id from public.analytics_bot_overrides where person_id = (select id from public.analytics_people where distinct_id = 'user-77')));
select pg_temp.check((public.analytics_overview((select value::uuid from qa where key = 'project'), '7d')->'current'->>'users')::int = 4, 'unblocking restores the person');

-- Blocking an event name ------------------------------------------------------------------------------
select public.analytics_set_event((select value::uuid from qa where key = 'project'), 'plan_selected', 'blocked', 'Old pricing test');
select pg_temp.check((select (select jsonb_agg(x->>'reason') from jsonb_array_elements(pg_temp.ingest((select value from qa where key = 'client_token'),
  jsonb_build_object('anonymous_id', 'anon-web-9', 'events', jsonb_build_array(pg_temp.ev('plan_selected', 'pb-1', 1, '/pricing'))))->'rejected') x)
  = '["event_blocked"]'::jsonb), 'blocked events are refused');
select pg_temp.check((select status = 'blocked' and description = 'Old pricing test' from public.analytics_event_definitions where name = 'plan_selected'), 'event status and description saved');

-- Session replay ----------------------------------------------------------------------------------------
select pg_temp.as_user(null);
select pg_temp.check((pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object('anonymous_id', 'anon-web-1', 'user_id', 'user-42',
  'session', jsonb_build_object('id', 'sess-web-1'), 'context', '{"platform":"web"}'::jsonb,
  'replay', jsonb_build_object('seq', 1, 'first_ts', (extract(epoch from now() - interval '8 minutes') * 1000)::bigint,
    'last_ts', (extract(epoch from now() - interval '7 minutes') * 1000)::bigint, 'events', '[{"type":3,"data":{"source":2},"timestamp":2}]'::jsonb)), '{"kind":"replay"}'::jsonb)->>'stored') = '1', 'replay chunk stored');
select pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object('anonymous_id', 'anon-web-1',
  'session', jsonb_build_object('id', 'sess-web-1'), 'context', '{"platform":"web"}'::jsonb,
  'replay', jsonb_build_object('seq', 0, 'first_ts', (extract(epoch from now() - interval '12 minutes') * 1000)::bigint,
    'last_ts', (extract(epoch from now() - interval '8 minutes') * 1000)::bigint, 'events', '[{"type":4,"data":{"href":"/"},"timestamp":1},{"type":2,"data":{},"timestamp":1}]'::jsonb)), '{"kind":"replay"}'::jsonb);
select pg_temp.check((pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object('anonymous_id', 'anon-web-1',
  'session', jsonb_build_object('id', 'sess-web-1'), 'replay', jsonb_build_object('seq', 1, 'first_ts', (extract(epoch from now() - interval '8 minutes') * 1000)::bigint,
    'last_ts', (extract(epoch from now() - interval '7 minutes') * 1000)::bigint, 'events', '[]'::jsonb)), '{"kind":"replay"}'::jsonb)->>'duplicates') = '1', 'resent chunk ignored');
select pg_temp.check(pg_temp.fails($$select pg_temp.ingest((select value from qa where key = 'client_token'), '{"anonymous_id":"a","session":{"id":"s"},"replay":{"seq":"x","events":[]}}'::jsonb, '{"kind":"replay"}'::jsonb)$$) like '22023%', 'malformed chunk refused');
select pg_temp.check((select replay_chunks = 2 and replay_bytes > 0 from public.analytics_sessions where session_key = 'sess-web-1'), 'session knows it has a replay');
select pg_temp.as_user('a1000000-0000-4000-8000-000000000001');
select pg_temp.check((select jsonb_agg(c->>'seq') = '["0","1"]'::jsonb from jsonb_array_elements(public.analytics_session_replay((select value::uuid from qa where key = 'project'),
  (select id from public.analytics_sessions where session_key = 'sess-web-1'), 0)->'chunks') c), 'replay returns chunks in order');
select pg_temp.check((public.analytics_sessions_page((select value::uuid from qa where key = 'project'), '{"range":"7d","replay_only":true}'::jsonb)->>'total')::int = 1, 'replay filter');
select public.analytics_update_project((select value::uuid from qa where key = 'project'), '{"replay_enabled":false}'::jsonb);
select pg_temp.as_user(null);
select pg_temp.check(pg_temp.fails($$select pg_temp.ingest((select value from qa where key = 'client_token'), jsonb_build_object('anonymous_id', 'a', 'session', '{"id":"s"}'::jsonb,
  'replay', jsonb_build_object('seq', 0, 'first_ts', (extract(epoch from now()) * 1000)::bigint, 'last_ts', (extract(epoch from now()) * 1000)::bigint, 'events', '[]'::jsonb)), '{"kind":"replay"}'::jsonb)$$) like '55000%', 'replay can be turned off');
update public.analytics_replay_chunks set received_at = now() - interval '40 days' where seq = 0;
select pg_temp.check(public.analytics_purge_replays() = 1, 'old replays are purged');
select pg_temp.check((select replay_chunks = 1 from public.analytics_sessions where session_key = 'sess-web-1'), 'purge keeps the session counts right');

-- Members and isolation -------------------------------------------------------------------------------
select pg_temp.as_user('a1000000-0000-4000-8000-000000000003');
select public.analytics_bootstrap('Elsewhere');
select pg_temp.check(pg_temp.fails(format('select public.analytics_overview(%L, ''7d'')', (select value from qa where key = 'project'))) like 'P0002%', 'other workspaces cannot see the project');
select pg_temp.check(pg_temp.fails(format('select public.analytics_person(%L, %L)', (select value from qa where key = 'project'), (select id from public.analytics_people where distinct_id = 'user-42'))) like 'P0002%', 'or its people');
select pg_temp.check(pg_temp.fails(format('select public.analytics_revoke_key(%L)', (select id from public.analytics_api_keys where name = 'Backend'))) like 'P0002%', 'or its keys');
select pg_temp.as_user('a1000000-0000-4000-8000-000000000001');
select public.analytics_invite_member((select value::uuid from qa where key = 'workspace'), ' Analyst@Nobrainer.example ', 'analyst');
select public.analytics_invite_member((select value::uuid from qa where key = 'workspace'), 'unconfirmed@nobrainer.example', 'developer');
select pg_temp.check(pg_temp.fails(format('select public.analytics_invite_member(%L, ''owner@nobrainer.example'', ''admin'')', (select value from qa where key = 'workspace'))) like '23505%', 'members cannot be invited twice');
select pg_temp.check(pg_temp.fails(format('select public.analytics_invite_member(%L, ''x@y.example'', ''owner'')', (select value from qa where key = 'workspace'))) like '22023%', 'nobody is invited as owner');
select pg_temp.as_user('a1000000-0000-4000-8000-000000000002');
select pg_temp.check((select jsonb_array_length(c->'workspaces') = 1 and c->'workspaces'->0->>'name' = 'Nobrainer Lab'
  and c->'workspaces'->0->>'role' = 'analyst' from (select public.analytics_bootstrap() c) t), 'invited analyst joins the workspace instead of a new one');
select pg_temp.check((public.analytics_overview((select value::uuid from qa where key = 'project'), '7d')->'current'->>'users')::int = 4, 'analysts read reports');
select pg_temp.check(pg_temp.fails(format('select public.analytics_create_key(%L, ''x'', ''server'', ''production'')', (select value from qa where key = 'project'))) like '42501%', 'analysts cannot create keys');
select pg_temp.check(pg_temp.fails(format('select public.analytics_set_bot_rule(%L, ''crawler'', true)', (select value from qa where key = 'project'))) like '42501%', 'analysts cannot change rules');
select pg_temp.as_user('a1000000-0000-4000-8000-000000000004');
select pg_temp.check((select public.analytics_bootstrap()->'workspaces'->0->>'name' <> 'Nobrainer Lab'), 'an unconfirmed address cannot accept an invite');
select pg_temp.as_user('a1000000-0000-4000-8000-000000000001');
select pg_temp.check((select jsonb_array_length(m->'members') = 2 and jsonb_array_length(m->'invites') = 1 from (select public.analytics_members((select value::uuid from qa where key = 'workspace')) m) t), 'members and open invites listed');
select public.analytics_set_member_role((select value::uuid from qa where key = 'workspace'), 'a1000000-0000-4000-8000-000000000002', 'developer');
select pg_temp.check(pg_temp.fails(format('select public.analytics_remove_member(%L, %L)', (select value from qa where key = 'workspace'), 'a1000000-0000-4000-8000-000000000001')) like '42501%', 'the owner stays');
select public.analytics_cancel_invite((select id from public.analytics_workspace_invites where email = 'unconfirmed@nobrainer.example'));
select pg_temp.as_user('a1000000-0000-4000-8000-000000000002');
select pg_temp.check(public.analytics_create_key((select value::uuid from qa where key = 'project'), 'CI', 'server', 'development')->>'token' like 'kma_sk_test_%', 'developers create keys');
select pg_temp.check(pg_temp.fails(format('select public.analytics_delete_project(%L, ''DramaPal'')', (select value from qa where key = 'project2'))) like '42501%', 'developers cannot delete projects');
select pg_temp.as_user('a1000000-0000-4000-8000-000000000001');
select public.analytics_remove_member((select value::uuid from qa where key = 'workspace'), 'a1000000-0000-4000-8000-000000000002');
select pg_temp.as_user('a1000000-0000-4000-8000-000000000002');
select pg_temp.check(pg_temp.fails(format('select public.analytics_overview(%L, ''7d'')', (select value from qa where key = 'project'))) like 'P0002%', 'removed members lose access');

-- Revoking and deleting -----------------------------------------------------------------------------------
select pg_temp.as_user('a1000000-0000-4000-8000-000000000001');
select public.analytics_revoke_key((select id from public.analytics_api_keys where name = 'Backend'));
select pg_temp.check(pg_temp.fails($$select pg_temp.ingest((select value from qa where key = 'server_token'), '{"user_id":"x","events":[]}'::jsonb)$$) like '28000%', 'revoked keys stop working');
select pg_temp.check(pg_temp.fails(format('select public.analytics_delete_project(%L, ''speaksix'')', (select value from qa where key = 'project'))) like '22023%', 'delete needs the exact name');
select public.analytics_delete_project((select value::uuid from qa where key = 'project'), 'SpeakSix');
select pg_temp.check((select count(*) = 0 from public.analytics_events) and (select count(*) = 0 from public.analytics_people)
  and (select count(*) = 0 from public.analytics_replay_chunks) and (select count(*) = 0 from public.analytics_api_keys where project_id = (select value::uuid from qa where key = 'project')), 'deleting a project removes everything it collected');
select pg_temp.check(jsonb_array_length(public.analytics_context()->'workspaces'->0->'projects') = 1, 'other projects remain');

select 'ok ' || count(*) || ' merchant analytics assertions' from analytics_assertions;
reset role;
rollback;
