-- Provider-free test of smart links and web attribution: a project makes links, the link
-- service resolves them and records clicks, the web SDK's visits carry each landing page's
-- source, and reports credit conversions to the last (or first) visit with a source.
begin;
set local time zone 'UTC';
create temporary table links_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Links assertion failed: %', label; end if;
  insert into links_assertions values (label);
end $$;
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
create function pg_temp.q(k text) returns uuid language sql as $$
  select value::uuid from qa where key = k
$$;
create function pg_temp.v(k text) returns text language sql as $$
  select value from qa where key = k
$$;
create function pg_temp.at(minutes_ago numeric) returns text language sql as $$
  select to_char((now() - make_interval(secs => minutes_ago * 60)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
-- One web visit: a session that lands with ctx (utm, click, referrer), then the named events.
create function pg_temp.visit(token text, anon text, user_id text, session text, minutes_ago numeric, ctx jsonb, events text[])
returns jsonb language sql as $$
  select public.analytics_ingest(jsonb_build_object(
    'key_hash', encode(extensions.digest(token, 'sha256'), 'hex'),
    'origin', 'https://speaksix.app',
    'body', jsonb_strip_nulls(jsonb_build_object(
      'anonymous_id', anon, 'user_id', user_id,
      'session', jsonb_build_object('id', session, 'started_at', pg_temp.at(minutes_ago)),
      'context', jsonb_build_object('platform', 'web', 'browser', 'Safari', 'device_type', 'mobile', 'interactions', 3,
        'page_path', '/') || ctx,
      'events', (select jsonb_agg(jsonb_build_object('name', e, 'insert_id', session || ':' || e || ':' || i,
        'time', pg_temp.at(minutes_ago - i), 'properties', '{}'::jsonb)) from unnest(events) with ordinality u(e, i))))))
$$;
create function pg_temp.save(link uuid, fields jsonb) returns jsonb language sql as $$
  select public.attribution_save_link(pg_temp.q('project'), link, fields)
$$;
create function pg_temp.save_fails(link uuid, fields jsonb) returns text language sql as $$
  select pg_temp.fails(format('select public.attribution_save_link(%L, %L, %L)', pg_temp.q('project'), link, fields))
$$;
create function pg_temp.row(report jsonb, k text) returns jsonb language sql as $$
  select x from jsonb_array_elements(report->'rows') x where x->>'key' is not distinct from k
$$;
create function pg_temp.link_row(report jsonb, id uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(report->'links') x where (x->>'id')::uuid = id
$$;
grant all on qa, links_assertions to authenticated, service_role;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('f1000000-0000-4000-8000-000000000001', 'owner@speaksix.example', now(), '{"full_name":"Ada Owner"}'::jsonb),
  ('f1000000-0000-4000-8000-000000000002', 'analyst@speaksix.example', now(), '{}'),
  ('f1000000-0000-4000-8000-000000000003', 'developer@speaksix.example', now(), '{}'),
  ('f1000000-0000-4000-8000-000000000004', 'stranger@elsewhere.example', now(), '{}');

-- Closed by default --------------------------------------------------------------------------
select pg_temp.check(not has_table_privilege('authenticated', 'public.attribution_links', 'select')
  and not has_table_privilege('authenticated', 'public.attribution_clicks', 'select')
  and not has_table_privilege('anon', 'public.attribution_links', 'select'), 'links and clicks are read only through functions');
select pg_temp.check(has_function_privilege('authenticated', 'public.attribution_save_link(uuid,uuid,jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.attribution_sources(uuid,text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.attribution_links(uuid,text)', 'execute'), 'only members call the link and report functions');
select pg_temp.check(has_function_privilege('service_role', 'public.attribution_link_target(text,text)', 'execute')
  and has_function_privilege('service_role', 'public.attribution_record_clicks(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.attribution_record_clicks(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.attribution_link_target(text,text)', 'execute'), 'only the link service resolves links and records clicks');

-- A project with attribution on, its apps and website, and members --------------------------
select pg_temp.as_user('f1000000-0000-4000-8000-000000000001');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'SpeakSix', array['ios', 'android', 'web'], 'UTC') r)
insert into qa select 'project', r->'project'->>'id' from created
union all select 'token', r->'key'->>'token' from created;
insert into qa select 'dev_token', public.analytics_create_key(pg_temp.q('project'), 'Staging', 'client', 'development')->>'token';
select public.analytics_update_project(pg_temp.q('project'), '{"allowed_origins":["https://speaksix.app"]}'::jsonb);
select pg_temp.check(pg_temp.fails(format('select public.attribution_links(%L, ''7d'')', pg_temp.q('project'))) like '22023%', 'links need attribution on');
select public.attribution_enable(pg_temp.q('project'), 'speaksix');
select public.attribution_update(pg_temp.q('project'), '{"ios_app_store_id":"1612345678","ios_bundle_id":"app.speaksix.ios","ios_team_id":"ABCDE12345","android_package":"app.speaksix","android_sha256":["146DE983C5730650D8EEB9952F34FC6416A08342E61DBEA88A0496B23FCF44E5"],"web_url":"https://speaksix.app/"}'::jsonb);
select public.analytics_invite_member(pg_temp.q('workspace'), 'analyst@speaksix.example', 'analyst');
select public.analytics_invite_member(pg_temp.q('workspace'), 'developer@speaksix.example', 'developer');
select pg_temp.as_user('f1000000-0000-4000-8000-000000000002');
select public.analytics_bootstrap();
select pg_temp.as_user('f1000000-0000-4000-8000-000000000003');
select public.analytics_bootstrap();
select pg_temp.as_user('f1000000-0000-4000-8000-000000000004');
select public.analytics_bootstrap();

-- Making links ---------------------------------------------------------------------------------
select pg_temp.as_user('f1000000-0000-4000-8000-000000000002');
select pg_temp.check(pg_temp.save_fails(null, '{"name":"Launch","source":"tiktok"}') like '42501%', 'analysts cannot make links');
select pg_temp.as_user('f1000000-0000-4000-8000-000000000004');
select pg_temp.check(pg_temp.save_fails(null, '{"name":"Launch","source":"tiktok"}') like 'P0002%', 'strangers cannot make links');

select pg_temp.as_user('f1000000-0000-4000-8000-000000000003');
insert into qa select 'launch', l->>'id' from pg_temp.save(null, '{"name":"October launch","path":"/October-Launch/","source":"TikTok Ads",
  "campaign":"october_launch","adset":"lagos","ad":"video_1","deep_link_value":"lesson","deep_link_params":{"id":"4"},
  "web_url":"speaksix.app/start"}') l;
select pg_temp.check((select l->>'path' = 'october-launch' and l->>'source' = 'tiktok_ads' and l->>'web_url' = 'https://speaksix.app/start'
  and l->>'url' = 'https://speaksix.go.kissmyapps.dev/october-launch' and l->>'status' = 'active' and l->'deep_link_params'->>'id' = '4'
  from (select public.attribution_links(pg_temp.q('project'), '7d')->'links'->0 l) t), 'a link is cleaned up: lowercase path, source and an https website');
insert into qa select 'random', l->>'id' from pg_temp.save(null, '{"name":"Bio link","source":"instagram"}') l;
select pg_temp.check((select path ~ '^[a-km-np-z2-9]{7}$' from public.attribution_links where id = pg_temp.q('random')), 'a link without an address gets a short random one');
select pg_temp.check(pg_temp.save_fails(null, '{"name":"Again","source":"tiktok","path":"october-launch"}') like '23505%', 'two links cannot share an address');
select pg_temp.check(pg_temp.save_fails(null, '{"name":"Health","source":"tiktok","path":"healthz"}') like '22023%', 'addresses kept for the service are refused');
select pg_temp.check(pg_temp.save_fails(null, '{"name":"Bad","source":"tiktok","path":"a b"}') like '22023%', 'an address is letters, numbers, hyphens and underscores');
select pg_temp.check(pg_temp.save_fails(null, '{"name":"","source":"tiktok"}') like '22023%', 'a link needs a name');
select pg_temp.check(pg_temp.save_fails(null, '{"name":"No source"}') like '22023%', 'a link needs a source');
select pg_temp.check(pg_temp.save_fails(null, '{"name":"Web","source":"x","web_url":"http://speaksix.app"}') like '22023%', 'destinations use https');
select pg_temp.check(pg_temp.save_fails(null, '{"name":"Params","source":"x","deep_link_params":{"1bad":"x"}}') like '22023%', 'in-app parameter names are checked');
select pg_temp.check(pg_temp.save_fails(null, '{"name":"Extra","source":"x","owner":"me"}') like '22023%', 'unknown fields are refused');
select pg_temp.check(pg_temp.save_fails(gen_random_uuid(), '{"name":"Missing"}') like 'P0002%', 'changing a missing link says so');
select pg_temp.check((select l->>'campaign' is null and l->>'name' = 'Bio link' and l->>'source' = 'instagram'
  from pg_temp.save(pg_temp.q('random'), '{"campaign":"","ios_url":"apps.apple.com/app/id1612345678?ppid=bio"}') l), 'a change keeps what it leaves out and clears what is empty');
select pg_temp.check((select ios_url = 'https://apps.apple.com/app/id1612345678?ppid=bio' from public.attribution_links where id = pg_temp.q('random')), 'a custom store page is kept');

-- What the link service sees ---------------------------------------------------------------------
select pg_temp.as_user(null);
set local role service_role;
select pg_temp.check((select t->>'id' = pg_temp.v('launch') and t->>'status' = 'active' and t->>'project_name' = 'SpeakSix'
  and t->>'ios_url' = 'https://apps.apple.com/app/id1612345678' and t->>'android_package' = 'app.speaksix'
  and t->>'web_url' = 'https://speaksix.app/start' and t->>'source' = 'tiktok_ads' and t->'social' = 'null'::jsonb
  from (select public.attribution_link_target('SpeakSix.go.kissmyapps.dev', '/october-launch/') t) x), 'a link resolves on its host, in any case, with its destinations');
select pg_temp.check((select t->>'web_url' = 'https://speaksix.app/' and (t->>'ios_custom')::boolean
  from (select public.attribution_link_target('speaksix.go.kissmyapps.dev', (select path from public.attribution_links where id = pg_temp.q('random'))) t) x),
  'a link without its own website page uses the project''s');
select pg_temp.check(public.attribution_link_target('speaksix.go.kissmyapps.dev', 'nothing-here') is null
  and public.attribution_link_target('unknown.go.kissmyapps.dev', 'october-launch') is null, 'unknown links and hosts resolve to nothing');

-- Clicks: two on the launch link (one from an Instagram ad that set its own source), one on the
-- bio link, a repeat and junk that is skipped.
select pg_temp.check(public.attribution_record_clicks(jsonb_build_array(
  jsonb_build_object('id', 'clickLaunchIos000001', 'link_id', pg_temp.v('launch'), 'clicked_at', pg_temp.at(3 * 1440 + 5),
    'platform', 'ios', 'destination', 'web', 'ip_sha', repeat('a', 64), 'user_agent', 'Mozilla/5.0 (iPhone)', 'params', jsonb_build_object('sub1', 'creator_9')),
  jsonb_build_object('id', 'clickLaunchInsta0001', 'link_id', pg_temp.v('launch'), 'clicked_at', pg_temp.at(60), 'platform', 'android',
    'in_app', 'instagram', 'destination', 'play_store', 'overrides', jsonb_build_object('source', 'Instagram', 'campaign', 'reels'),
    'click_ids', jsonb_build_object('fbclid', 'IwAR123', 'other', 'x')),
  jsonb_build_object('id', 'clickBioDesktop00001', 'link_id', pg_temp.v('random'), 'clicked_at', pg_temp.at(30), 'platform', 'desktop', 'destination', 'web'),
  jsonb_build_object('id', 'clickLaunchIos000001', 'link_id', pg_temp.v('launch'), 'clicked_at', pg_temp.at(1), 'platform', 'ios', 'destination', 'web'),
  jsonb_build_object('id', 'clickUnknownLink0001', 'link_id', gen_random_uuid(), 'clicked_at', pg_temp.at(1), 'platform', 'ios', 'destination', 'web'),
  jsonb_build_object('id', 'short', 'link_id', pg_temp.v('launch'), 'clicked_at', pg_temp.at(1), 'platform', 'ios', 'destination', 'web'),
  jsonb_build_object('id', 'clickTooOld000000001', 'link_id', pg_temp.v('launch'), 'clicked_at', pg_temp.at(8 * 1440), 'platform', 'ios', 'destination', 'web')
)) = 3, 'new clicks are stored once; unknown links, bad IDs and old clicks are skipped');
select pg_temp.check((select source = 'instagram' and campaign = 'reels' and adset = 'lagos' and in_app = 'instagram'
  and click_ids = '{"fbclid":"IwAR123"}'::jsonb and ip_hash is null from public.attribution_clicks where id = 'clickLaunchInsta0001'),
  'an address can set the source and campaign for one ad; other parts come from the link');
select pg_temp.check((select source = 'tiktok_ads' and campaign = 'october_launch' and params = '{"sub1":"creator_9"}'::jsonb
  and ip_hash = encode(extensions.digest(pg_temp.v('project') || ':' || repeat('a', 64), 'sha256'), 'hex')
  from public.attribution_clicks where id = 'clickLaunchIos000001'), 'a click keeps the link''s source as it was and the address hashed with the project');
select pg_temp.check(pg_temp.fails('select public.attribution_record_clicks(''{}''::jsonb)') like '22023%', 'clicks come as a list');

-- Visits from the web SDK -----------------------------------------------------------------------
-- A: lands from the launch link 3 days ago, comes back direct and signs up.
select pg_temp.visit(pg_temp.v('token'), 'anon-a', null, 'sess-a1', 3 * 1440, '{"click":{"kma_lc":"clickLaunchIos000001"}}', array['page_viewed']);
select pg_temp.visit(pg_temp.v('token'), 'anon-a', null, 'sess-a2', 120, '{}', array['page_viewed', 'email_entered']);
-- B: a Facebook ad tagged with UTMs and fbclid; the UTMs name it.
select pg_temp.visit(pg_temp.v('token'), 'anon-b', null, 'sess-b1', 90,
  '{"utm":{"source":"Facebook","medium":"paid_social","campaign":"launch","content":"carousel","term":"english"},"click":{"fbclid":"IwAR9"}}', array['page_viewed', 'email_entered']);
-- C: a Google ad with only gclid.
select pg_temp.visit(pg_temp.v('token'), 'anon-c', null, 'sess-c1', 80, '{"click":{"gclid":"Cj0KCQ"}}', array['page_viewed', 'email_entered']);
-- D: found on Google search, then back from checkout: the checkout page is not a source.
select pg_temp.visit(pg_temp.v('token'), 'anon-d', null, 'sess-d1', 2 * 1440, '{"referrer":"https://www.google.com/search?q=english"}', array['page_viewed']);
select pg_temp.visit(pg_temp.v('token'), 'anon-d', null, 'sess-d2', 70, '{"referrer":"https://checkout.stripe.com/c/pay/x"}', array['page_viewed', 'email_entered']);
-- E: direct, and from the merchant's own site.
select pg_temp.visit(pg_temp.v('token'), 'anon-e', null, 'sess-e1', 60, '{"referrer":"https://www.speaksix.app/pricing"}', array['page_viewed', 'email_entered']);
-- G: Instagram first, TikTok last.
select pg_temp.visit(pg_temp.v('token'), 'anon-g', null, 'sess-g1', 5 * 1440, '{"utm":{"source":"instagram","campaign":"bio"}}', array['page_viewed']);
select pg_temp.visit(pg_temp.v('token'), 'anon-g', null, 'sess-g2', 1440, '{"utm":{"source":"tiktok","campaign":"duet"}}', array['page_viewed']);
select pg_temp.visit(pg_temp.v('token'), 'anon-g', null, 'sess-g3', 50, '{}', array['page_viewed', 'email_entered']);
-- F: a newsletter visit that is too old for the web window.
select pg_temp.visit(pg_temp.v('token'), 'anon-f', null, 'sess-f1', 100, '{"utm":{"source":"newsletter"}}', array['page_viewed']);
update public.analytics_sessions set started_at = now() - interval '40 days', ended_at = now() - interval '40 days' where session_key = 'sess-f1';
select pg_temp.visit(pg_temp.v('token'), 'anon-f', null, 'sess-f2', 40, '{}', array['page_viewed', 'email_entered']);
-- H: WhatsApp on the phone; signs up on a laptop, and only later signs in on the phone.
select pg_temp.visit(pg_temp.v('token'), 'anon-h-phone', null, 'sess-h1', 1440, '{"utm":{"source":"whatsapp"}}', array['page_viewed']);
select pg_temp.visit(pg_temp.v('token'), 'anon-h-laptop', 'user-h', 'sess-h2', 30, '{}', array['page_viewed', 'email_entered']);
-- The Instagram ad click opens the site; a junk kma_lc is ignored; a test site's visit does not count.
select pg_temp.visit(pg_temp.v('token'), 'anon-i', null, 'sess-i1', 55, '{"click":{"kma_lc":"clickLaunchInsta0001"}}', array['page_viewed', 'purchase']);
select pg_temp.visit(pg_temp.v('token'), 'anon-j', null, 'sess-j1', 20, '{"click":{"kma_lc":"not a click id"}}', array['page_viewed']);
select pg_temp.visit(pg_temp.v('dev_token'), 'anon-dev', null, 'sess-dev', 10, '{"utm":{"source":"tiktok"}}', array['page_viewed', 'email_entered']);

select pg_temp.check((select link_click = 'clickLaunchIos000001' from public.analytics_sessions where session_key = 'sess-a1')
  and (select link_click is null from public.analytics_sessions where session_key = 'sess-j1'), 'a visit keeps its link click; junk is dropped');
select pg_temp.check((select click_ids = '{"fbclid":"IwAR9"}'::jsonb and utm_content = 'carousel' and utm_term = 'english'
  from public.analytics_sessions where session_key = 'sess-b1'), 'a visit keeps ad click IDs and every UTM tag');
select pg_temp.visit(pg_temp.v('token'), 'anon-b', null, 'sess-b1', 85, '{"click":{"gclid":"later"}}', array['page_viewed']);
select pg_temp.check((select click_ids = '{"fbclid":"IwAR9"}'::jsonb from public.analytics_sessions where session_key = 'sess-b1'),
  'a visit''s landing source does not change later in the visit');

-- Conversions ------------------------------------------------------------------------------------
reset role;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000002');
select pg_temp.check(pg_temp.fails(format('select public.attribution_set_conversions(%L, array[''email_entered''], 30)', pg_temp.q('project'))) like '42501%', 'analysts cannot choose conversions');
select pg_temp.check((select (r->'totals'->>'conversions')::int = 0 and (r->'totals'->>'visits')::int > 0
  from (select public.attribution_sources(pg_temp.q('project'), '7d') r) x), 'without conversion events nothing converts, but visits count');
select pg_temp.as_user('f1000000-0000-4000-8000-000000000003');
select pg_temp.check(pg_temp.fails(format('select public.attribution_set_conversions(%L, array[''1bad''], 30)', pg_temp.q('project'))) like '22023%', 'conversion event names are checked');
select pg_temp.check(pg_temp.fails(format('select public.attribution_set_conversions(%L, array[''a''], 91)', pg_temp.q('project'))) like '22023%', 'the website window is 1 to 90 days');
select pg_temp.check(pg_temp.fails(format('select public.attribution_set_conversions(%L, (select array_agg(''e'' || i) from generate_series(1, 21) i), 30)', pg_temp.q('project'))) like '22023%', 'up to 20 conversion events');
select pg_temp.check((select v->'settings'->'conversion_events' = '["email_entered", "purchase"]'::jsonb and (v->'setup'->>'conversions')::boolean
  and exists (select 1 from jsonb_array_elements(v->'events') e where e->>'name' = 'email_entered')
  from (select public.attribution_set_conversions(pg_temp.q('project'), array['purchase', ' email_entered ', 'purchase', ''], 30) v) x),
  'conversions are chosen from the project''s events and the setup step is done');

-- Sources report -----------------------------------------------------------------------------------
select pg_temp.as_user('f1000000-0000-4000-8000-000000000002');
insert into qa select 'last', public.attribution_sources(pg_temp.q('project'), '7d');
select pg_temp.check((pg_temp.row(pg_temp.v('last')::jsonb, 'tiktok_ads')->>'conversions')::int = 1
  and (pg_temp.row(pg_temp.v('last')::jsonb, 'tiktok_ads')->>'clicks')::int = 1
  and (pg_temp.row(pg_temp.v('last')::jsonb, 'tiktok_ads')->>'visits')::int = 1, 'a link visit gets the sign-up of a later direct visit');
select pg_temp.check((pg_temp.row(pg_temp.v('last')::jsonb, 'facebook')->>'conversions')::int = 1, 'UTM tags name the source, in lowercase');
select pg_temp.check((pg_temp.row(pg_temp.v('last')::jsonb, 'google_ads')->>'conversions')::int = 1, 'a gclid alone names Google Ads');
select pg_temp.check((pg_temp.row(pg_temp.v('last')::jsonb, 'google.com')->>'conversions')::int = 1
  and pg_temp.row(pg_temp.v('last')::jsonb, 'checkout.stripe.com') is null, 'a referring site counts; coming back from checkout does not');
select pg_temp.check(pg_temp.row(pg_temp.v('last')::jsonb, 'speaksix.app') is null, 'the merchant''s own site is not a source');
select pg_temp.check((pg_temp.row(pg_temp.v('last')::jsonb, 'tiktok')->>'conversions')::int = 1
  and (pg_temp.row(pg_temp.v('last')::jsonb, 'instagram')->>'conversions')::int = 1, 'last touch: TikTok gets G''s sign-up; the Instagram ad click gets its purchase');
select pg_temp.check((pg_temp.row(pg_temp.v('last')::jsonb, 'instagram')->>'clicks')::int = 2
  and (pg_temp.row(pg_temp.v('last')::jsonb, 'instagram')->>'visits')::int = 2, 'Instagram has the ad''s and the bio link''s clicks, the ad visit and G''s first visit');
-- Direct: E, F (newsletter is outside the window) and H (the phone is not joined yet).
select pg_temp.check((pg_temp.row(pg_temp.v('last')::jsonb, null)->>'conversions')::int = 3, 'conversions with no source in the window are direct');
select pg_temp.check(pg_temp.row(pg_temp.v('last')::jsonb, 'whatsapp') is not null and (pg_temp.row(pg_temp.v('last')::jsonb, 'whatsapp')->>'conversions')::int = 0, 'a source can have visits and no conversions');
select pg_temp.check((pg_temp.v('last')::jsonb->'totals'->>'conversions')::int = 9 and (pg_temp.v('last')::jsonb->'totals'->>'converters')::int = 9,
  'every production conversion is counted once; the test site''s are not');

-- Signing in on the phone joins H's visits, and the laptop sign-up now goes to WhatsApp.
reset role;
select pg_temp.as_user(null);
set local role service_role;
select pg_temp.visit(pg_temp.v('token'), 'anon-h-phone', 'user-h', 'sess-h3', 10, '{}', array['page_viewed']);
reset role;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000002');
select pg_temp.check((pg_temp.row(public.attribution_sources(pg_temp.q('project'), '7d'), 'whatsapp')->>'conversions')::int = 1, 'credit follows a person across devices once they sign in');

-- First touch, the window, and a source's campaigns.
insert into qa select 'first', public.attribution_sources(pg_temp.q('project'), '7d', 'first');
select pg_temp.check((pg_temp.row(pg_temp.v('first')::jsonb, 'instagram')->>'conversions')::int = 2
  and (pg_temp.row(pg_temp.v('first')::jsonb, 'tiktok')->>'conversions')::int = 0, 'first touch: Instagram gets G''s sign-up');
select pg_temp.check((pg_temp.row(pg_temp.v('first')::jsonb, 'newsletter')->>'conversions')::int = 1, 'first touch has no window');
select pg_temp.as_user('f1000000-0000-4000-8000-000000000003');
select public.attribution_set_conversions(pg_temp.q('project'), array['email_entered', 'purchase'], 60);
select pg_temp.check((pg_temp.row(public.attribution_sources(pg_temp.q('project'), '7d'), 'newsletter')->>'conversions')::int = 1, 'a longer window reaches older visits');
select pg_temp.check((select (r->'rows'->0->>'key') = 'october_launch' and (r->'rows'->0->>'conversions')::int = 1 and r->>'source' = 'tiktok_ads'
  from (select public.attribution_sources(pg_temp.q('project'), '7d', 'last', 'tiktok_ads') r) x), 'a source opens into its campaigns');
select pg_temp.check(pg_temp.fails(format('select public.attribution_sources(%L, ''7d'', ''middle'')', pg_temp.q('project'))) like '22023%', 'the model is last or first');
select pg_temp.as_user('f1000000-0000-4000-8000-000000000004');
select pg_temp.check(pg_temp.fails(format('select public.attribution_sources(%L, ''7d'')', pg_temp.q('project'))) like 'P0002%', 'strangers cannot read reports');

-- Links report ----------------------------------------------------------------------------------
select pg_temp.as_user('f1000000-0000-4000-8000-000000000002');
insert into qa select 'links', public.attribution_links(pg_temp.q('project'), '7d');
select pg_temp.check((select (r->>'clicks')::int = 2 and (r->>'visits')::int = 2 and (r->>'conversions')::int = 2
  from (select pg_temp.link_row(pg_temp.v('links')::jsonb, pg_temp.q('launch')) r) x), 'a link counts its clicks, the visits they opened and the conversions it got');
select pg_temp.check((select (r->>'clicks')::int = 1 and (r->>'visits')::int = 0
  from (select pg_temp.link_row(pg_temp.v('links')::jsonb, pg_temp.q('random')) r) x), 'a click without a visit still counts');
select pg_temp.check(pg_temp.v('links')::jsonb->'hosts' = '["speaksix.go.kissmyapps.dev"]'::jsonb, 'the report lists the domains links work on');

-- Pausing, deleting, turning off --------------------------------------------------------------------
select pg_temp.as_user('f1000000-0000-4000-8000-000000000003');
select pg_temp.check((public.attribution_set_link_status(pg_temp.q('launch'), 'paused')->>'status') = 'paused', 'developers pause links');
select pg_temp.check(pg_temp.fails(format('select public.attribution_set_link_status(%L, ''gone'')', pg_temp.q('launch'))) like '22023%', 'a link is active or paused');
select pg_temp.check(pg_temp.fails(format('select public.attribution_delete_link(%L)', pg_temp.q('launch'))) like '22023%', 'a link with clicks cannot be deleted');
insert into qa select 'spare', l->>'id' from pg_temp.save(null, '{"name":"Spare","source":"email"}') l;
select pg_temp.check((public.attribution_delete_link(pg_temp.q('spare'))->>'deleted')::boolean, 'a link nobody clicked can be deleted');
select pg_temp.check(not exists (select 1 from public.attribution_links where id = pg_temp.q('spare')), 'a deleted link is gone');
select pg_temp.as_user(null);
set local role service_role;
select pg_temp.check((public.attribution_link_target('speaksix.go.kissmyapps.dev', 'october-launch')->>'status') = 'paused', 'the link service sees a paused link');
reset role;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000001');
select public.attribution_set_link_status(pg_temp.q('launch'), 'active');
select public.attribution_disable(pg_temp.q('project'));
select pg_temp.as_user(null);
set local role service_role;
select pg_temp.check((public.attribution_link_target('speaksix.go.kissmyapps.dev', 'october-launch')->>'status') = 'paused', 'turning attribution off pauses every link');
reset role;

-- Deleting the project deletes its links and clicks ---------------------------------------------------
select pg_temp.as_user('f1000000-0000-4000-8000-000000000001');
select public.analytics_delete_project(pg_temp.q('project'), 'SpeakSix');
select pg_temp.check(not exists (select 1 from public.attribution_links where project_id = pg_temp.q('project'))
  and not exists (select 1 from public.attribution_clicks where project_id = pg_temp.q('project')), 'a deleted project takes its links and clicks with it');

select 'ok ' || count(*) || ' merchant attribution link assertions' from links_assertions;
rollback;
