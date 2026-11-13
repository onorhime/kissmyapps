-- Provider-free test of the creator click on a visit: the web SDK sends the landing page's
-- kma_click with the other click IDs, the session keeps it in creator_click, a value that is
-- not a click ID is dropped, and kma_lc and the ad platforms' click IDs behave as before.
begin;
set local time zone 'UTC';
create temporary table creator_click_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Creator click assertion failed: %', label; end if;
  insert into creator_click_assertions values (label);
end $$;
create function pg_temp.as_user(id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', id, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.q(k text) returns uuid language sql as $$
  select value::uuid from qa where key = k
$$;
create function pg_temp.v(k text) returns text language sql as $$
  select value from qa where key = k
$$;
create function pg_temp.at(minutes_ago numeric) returns text language sql as $$
  select to_char((now() - make_interval(secs => minutes_ago * 60)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
-- One request from the web SDK: a session with ctx (utm, click, referrer) and the named events.
-- No events is a heartbeat.
create function pg_temp.visit(anon text, user_id text, traits jsonb, session text, minutes_ago numeric, ctx jsonb, events text[])
returns jsonb language sql as $$
  select public.analytics_ingest(jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.v('token'), 'sha256'), 'hex'),
    'origin', 'https://speaksix.app',
    'body', jsonb_strip_nulls(jsonb_build_object(
      'anonymous_id', anon, 'user_id', user_id, 'traits', traits,
      'session', jsonb_build_object('id', session, 'started_at', pg_temp.at(minutes_ago)),
      'context', jsonb_build_object('platform', 'web', 'browser', 'Safari', 'device_type', 'mobile', 'interactions', 3,
        'page_path', '/start') || ctx)) || jsonb_build_object(
      'events', coalesce((select jsonb_agg(jsonb_build_object('name', e, 'insert_id', session || ':' || e || ':' || i || ':' || minutes_ago,
        'time', pg_temp.at(minutes_ago), 'properties', '{}'::jsonb)) from unnest(events) with ordinality u(e, i)), '[]'::jsonb))))
$$;
create function pg_temp.session(key text) returns public.analytics_sessions language sql as $$
  select s from public.analytics_sessions s where s.project_id = pg_temp.q('project') and s.session_key = key
$$;
grant all on qa, creator_click_assertions to authenticated, service_role;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('f7400000-0000-4000-8000-000000000001', 'owner@speaksix.example', now(), '{"full_name":"Ada Owner"}'::jsonb);

-- The function is the one ingest already calls: same arguments, same closed schema ------------
select pg_temp.check((select count(*) = 1 and bool_and(not p.prosecdef) and bool_and(p.proconfig = array['search_path=""'])
  from pg_proc p where p.pronamespace = 'kma_internal'::regnamespace and p.proname = 'analytics_touch_session'),
  'there is still one session function, with an empty search path');
select pg_temp.check(not has_schema_privilege('authenticated', 'kma_internal', 'usage')
  and not has_schema_privilege('anon', 'kma_internal', 'usage')
  and not has_function_privilege('authenticated', 'public.analytics_ingest(jsonb)', 'execute')
  and not has_table_privilege('authenticated', 'public.analytics_sessions', 'select'),
  'visitors and members still cannot reach sessions or the internal schema');

select pg_temp.as_user('f7400000-0000-4000-8000-000000000001');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'SpeakSix', array['web'], 'UTC') r)
insert into qa select 'project', r->'project'->>'id' from created
union all select 'token', r->'key'->>'token' from created;
select public.analytics_update_project(pg_temp.q('project'), '{"allowed_origins":["https://speaksix.app"]}'::jsonb);
select pg_temp.as_user(null);
set local role service_role;

-- A visit from a creator's link keeps the click ----------------------------------------------------
select pg_temp.visit('anon-a', null, null, 'sess-a1', 60, '{"click":{"kma_click":"kc_7Hq2mW9xLp4RtZ8vB3nD"}}', array['page_viewed']);
select pg_temp.check((select (s).creator_click = 'kc_7Hq2mW9xLp4RtZ8vB3nD' from pg_temp.session('sess-a1') s),
  'a new session stores the creator click');
select pg_temp.check((select (s).link_click is null and (s).click_ids = '{}'::jsonb from pg_temp.session('sess-a1') s),
  'the creator click is not a link click and is not among the ad click IDs');
-- The shortest and longest click IDs the redirect can issue.
select pg_temp.visit('anon-min', null, null, 'sess-min', 59, jsonb_build_object('click', jsonb_build_object('kma_click', repeat('a', 16))), array['page_viewed']);
select pg_temp.visit('anon-max', null, null, 'sess-max', 59, jsonb_build_object('click', jsonb_build_object('kma_click', repeat('Z', 128))), array['page_viewed']);
select pg_temp.check((select (s).creator_click = repeat('a', 16) from pg_temp.session('sess-min') s)
  and (select (s).creator_click = repeat('Z', 128) from pg_temp.session('sess-max') s),
  'click IDs of 16 and 128 characters are kept whole');

-- Anything that is not a click ID is dropped, and the visit is still recorded -------------------
select pg_temp.visit('anon-b1', null, null, 'sess-b1', 58, '{"click":{"kma_click":"too-short"}}', array['page_viewed']);
select pg_temp.visit('anon-b2', null, null, 'sess-b2', 58, '{"click":{"kma_click":"has spaces in the value"}}', array['page_viewed']);
select pg_temp.visit('anon-b3', null, null, 'sess-b3', 58, jsonb_build_object('click', jsonb_build_object('kma_click', repeat('a', 129))), array['page_viewed']);
select pg_temp.visit('anon-b4', null, null, 'sess-b4', 58, '{"click":{"kma_click":1234567890123456789}}', array['page_viewed']);
select pg_temp.visit('anon-b5', null, null, 'sess-b5', 58, '{"click":{"kma_click":{"id":"kc_7Hq2mW9xLp4RtZ8vB3nD"}}}', array['page_viewed']);
select pg_temp.visit('anon-b6', null, null, 'sess-b6', 58, '{"click":{"kma_click":"kc_7Hq2mW9xLp4RtZ8vB3nD;drop"}}', array['page_viewed']);
select pg_temp.visit('anon-b7', null, null, 'sess-b7', 58, '{"click":"kc_7Hq2mW9xLp4RtZ8vB3nD"}', array['page_viewed']);
select pg_temp.check((select count(*) = 7 and count(creator_click) = 0 from public.analytics_sessions
  where project_id = pg_temp.q('project') and session_key like 'sess-b_'),
  'a short, long, spaced, numeric, nested or punctuated value is dropped and the visit is kept');
select pg_temp.visit('anon-c', null, null, 'sess-c1', 57, '{"utm":{"source":"newsletter"}}', array['page_viewed']);
select pg_temp.check((select (s).creator_click is null and (s).utm_source = 'newsletter' from pg_temp.session('sess-c1') s),
  'a visit with no creator click has none');

-- kma_lc and the ad click IDs are as they were ----------------------------------------------------
select pg_temp.visit('anon-d', null, null, 'sess-d1', 56,
  '{"utm":{"source":"facebook","medium":"paid","campaign":"launch","content":"carousel","term":"english"},
    "click":{"kma_lc":"clickLaunchIos000001","kma_click":"kc_Zz91AbCdEfGhIjKlMnOp","fbclid":"IwAR9","gclid":"Cj0KCQ","junk":"x"}}',
  array['page_viewed']);
select pg_temp.check((select (s).link_click = 'clickLaunchIos000001' and (s).click_ids = '{"fbclid":"IwAR9","gclid":"Cj0KCQ"}'::jsonb
  and (s).creator_click = 'kc_Zz91AbCdEfGhIjKlMnOp' and (s).utm_source = 'facebook' and (s).utm_content = 'carousel'
  and (s).utm_term = 'english' and (s).landing = '/start' from pg_temp.session('sess-d1') s),
  'a visit keeps its link click, ad click IDs and UTM tags beside the creator click');
select pg_temp.visit('anon-e', null, null, 'sess-e1', 55, '{"click":{"kma_lc":"not a click id","kma_click":"kc_7Hq2mW9xLp4RtZ8vB3nD","ttclid":"E.C.P"}}', array['page_viewed']);
select pg_temp.check((select (s).link_click is null and (s).click_ids = '{"ttclid":"E.C.P"}'::jsonb
  and (s).creator_click = 'kc_7Hq2mW9xLp4RtZ8vB3nD' from pg_temp.session('sess-e1') s),
  'a junk link click is still dropped on its own');
select pg_temp.visit('anon-f', null, null, 'sess-f1', 54, '{"click":{"kma_lc":"clickLaunchIos000001","kma_click":"nope","msclkid":"ms1"}}', array['page_viewed']);
select pg_temp.check((select (s).link_click = 'clickLaunchIos000001' and (s).click_ids = '{"msclkid":"ms1"}'::jsonb
  and (s).creator_click is null from pg_temp.session('sess-f1') s),
  'a junk creator click does not disturb the link click or the ad click IDs');
select pg_temp.check((select sessions_count = 1 from public.analytics_people p
  where p.id = (select (s).person_id from pg_temp.session('sess-d1') s)), 'a new session is still counted once for its person');

-- Later requests in the same visit -----------------------------------------------------------------
select pg_temp.visit('anon-a', null, null, 'sess-a1', 50, '{"click":{"kma_click":"kc_Zz91AbCdEfGhIjKlMnOp","gclid":"later"}}', array['plan_selected']);
select pg_temp.check((select (s).creator_click = 'kc_7Hq2mW9xLp4RtZ8vB3nD' and (s).click_ids = '{"gclid":"later"}'::jsonb
  from pg_temp.session('sess-a1') s), 'a visit''s creator click does not change later in the visit');
select pg_temp.visit('anon-a', null, null, 'sess-a1', 49, '{}', '{}');
select pg_temp.check((select (s).creator_click = 'kc_7Hq2mW9xLp4RtZ8vB3nD' from pg_temp.session('sess-a1') s)
  and (select sessions_count = 1 from public.analytics_people p where p.id = (select (s).person_id from pg_temp.session('sess-a1') s)),
  'a heartbeat without the click leaves it in place');
-- A heartbeat that arrives first opens the session; the landing request then fills the click in.
select pg_temp.visit('anon-g', null, null, 'sess-g1', 48, '{}', '{}');
select pg_temp.check((select (s).creator_click is null from pg_temp.session('sess-g1') s), 'a session opened without a click has none yet');
select pg_temp.visit('anon-g', null, null, 'sess-g1', 47, '{"click":{"kma_click":"kc_7Hq2mW9xLp4RtZ8vB3nD"}}', array['page_viewed']);
select pg_temp.check((select (s).creator_click = 'kc_7Hq2mW9xLp4RtZ8vB3nD' from pg_temp.session('sess-g1') s),
  'a later request fills in a creator click the first one lacked');

-- An identified buyer's latest creator click can be found through their visits ----------------
select pg_temp.visit('anon-h', null, null, 'sess-h1', 3 * 1440, '{"click":{"kma_click":"kc_OlderClick000000001"}}', array['page_viewed']);
select pg_temp.visit('anon-h', null, null, 'sess-h2', 1440, '{"click":{"kma_click":"kc_NewerClick000000002"}}', array['page_viewed']);
select pg_temp.visit('anon-h', 'user-h', '{"email":"Buyer@Example.com"}', 'sess-h3', 30, '{}', array['page_viewed', 'purchase']);
select pg_temp.check((select s.creator_click = 'kc_NewerClick000000002'
  from public.analytics_people p join public.analytics_sessions s on s.person_id = p.id
  where p.project_id = pg_temp.q('project') and lower(p.traits->>'email') = 'buyer@example.com' and s.creator_click is not null
  order by s.started_at desc limit 1),
  'the latest creator click of a person is found from their email');
select pg_temp.check(exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'analytics_sessions'
  and indexname = 'analytics_sessions_creator_click'), 'the lookup by person has its index');
reset role;

select 'ok ' || count(*) || ' analytics creator click assertions' from creator_click_assertions;
rollback;
