-- Provider-free test of merchant analytics funnels: saved funnels and who may change
-- them, step checks, and the people counted at each step of a report.
begin;
set local time zone 'UTC';
create temporary table funnel_assertions(label text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Funnel assertion failed: %', label; end if;
  insert into funnel_assertions values (label);
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
create function pg_temp.ingest(token text, body jsonb) returns jsonb language sql as $$
  select public.analytics_ingest(jsonb_build_object('key_hash', encode(extensions.digest(token, 'sha256'), 'hex'), 'body', body,
    'geo', jsonb_build_object('country', 'NG', 'source', 'edge')))
$$;
create function pg_temp.at(minutes_ago numeric) returns text language sql as $$
  select to_char((now() - make_interval(secs => minutes_ago * 60)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
create function pg_temp.ev(name text, insert_id text, minutes_ago numeric, screen text default null, props jsonb default '{}') returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('name', name, 'insert_id', insert_id, 'time', pg_temp.at(minutes_ago), 'screen', screen))
    || jsonb_build_object('properties', props)
$$;
-- One visit: an anonymous ID (and optionally a user ID), a device, and its events.
create function pg_temp.visit(token text, anon text, session text, device text, events jsonb, user_id text default null, extra jsonb default '{}')
returns jsonb language sql as $$
  select pg_temp.ingest(token, jsonb_strip_nulls(jsonb_build_object('anonymous_id', anon, 'user_id', user_id,
    'session', jsonb_build_object('id', session, 'started_at', events->0->>'time'),
    'context', jsonb_build_object('platform', 'web', 'device_type', device, 'browser', 'Chrome', 'interactions', 5) || extra,
    'events', events)))
$$;
create function pg_temp.report(project text, definition jsonb, breakdown text default 'none') returns jsonb language sql as $$
  select public.analytics_funnel_report(project::uuid, definition, '7d', breakdown)
$$;
create function pg_temp.people_at(r jsonb) returns jsonb language sql as $$
  select jsonb_agg((s->>'people')::int order by (s->>'index')::int) from jsonb_array_elements(r->'steps') s
$$;
create temporary table qa(key text primary key, value text);
grant all on qa, funnel_assertions to authenticated, service_role;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('b1000000-0000-4000-8000-000000000001', 'owner@funnels.example', now(), '{"full_name":"Ada Owner","company":"Funnel Lab"}'::jsonb),
  ('b1000000-0000-4000-8000-000000000002', 'analyst@funnels.example', now(), '{"full_name":"Tolu Analyst"}'::jsonb),
  ('b1000000-0000-4000-8000-000000000003', 'stranger@elsewhere.example', now(), '{}');

select pg_temp.as_user('b1000000-0000-4000-8000-000000000001');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project((select value::uuid from qa where key = 'workspace'), 'BC Learn', array['web'], 'UTC') r)
insert into qa select 'project', r->'project'->>'id' from created
union all select 'token', r->'key'->>'token' from created;
insert into qa select 'dev_token', public.analytics_create_key((select value::uuid from qa where key = 'project'), 'Staging', 'client', 'development')->>'token';
select public.analytics_invite_member((select value::uuid from qa where key = 'workspace'), 'analyst@funnels.example', 'analyst');
select pg_temp.as_user('b1000000-0000-4000-8000-000000000002');
select public.analytics_bootstrap();

-- Visits -------------------------------------------------------------------------------------
select pg_temp.as_user(null);
set local role service_role;
-- Completes every step, then repeats the first two.
select pg_temp.visit((select value from qa where key = 'token'), 'f-1', 's-1', 'desktop', jsonb_build_array(
  pg_temp.ev('page_viewed', 'f1-1', 60, '/'), pg_temp.ev('slide_1_passed', 'f1-2', 55), pg_temp.ev('slide_2_passed', 'f1-3', 50),
  pg_temp.ev('email_entered', 'f1-4', 45, null, '{"plan":"pro"}'::jsonb), pg_temp.ev('page_viewed', 'f1-5', 44, '/checkout'),
  pg_temp.ev('page_viewed', 'f1-6', 20, '/'), pg_temp.ev('slide_1_passed', 'f1-7', 19)));
-- Stops after slide 1, which they pass twice.
select pg_temp.visit((select value from qa where key = 'token'), 'f-2', 's-2', 'desktop', jsonb_build_array(
  pg_temp.ev('page_viewed', 'f2-1', 60, '/'), pg_temp.ev('slide_1_passed', 'f2-2', 58), pg_temp.ev('slide_1_passed', 'f2-3', 57),
  pg_temp.ev('page_viewed', 'f2-4', 56, '/Pricing/')));
-- Passed slide 1 before ever opening the first page, so only the entry counts.
select pg_temp.visit((select value from qa where key = 'token'), 'f-3', 's-3', 'desktop', jsonb_build_array(
  pg_temp.ev('slide_1_passed', 'f3-1', 70), pg_temp.ev('page_viewed', 'f3-2', 65, '/')));
-- Enters 10 hours ago and passes slide 1 nine hours later: inside a day, outside an hour.
select pg_temp.visit((select value from qa where key = 'token'), 'f-4', 's-4a', 'desktop', jsonb_build_array(
  pg_temp.ev('page_viewed', 'f4-1', 600, '/')));
select pg_temp.visit((select value from qa where key = 'token'), 'f-4', 's-4b', 'desktop', jsonb_build_array(
  pg_temp.ev('slide_1_passed', 'f4-2', 60)));
-- Starts on a phone, finishes on a laptop, and signs in on both.
select pg_temp.visit((select value from qa where key = 'token'), 'f-5-laptop', 's-5b', 'desktop', jsonb_build_array(
  pg_temp.ev('slide_2_passed', 'f5-3', 30), pg_temp.ev('email_entered', 'f5-4', 29, null, '{"plan":"free"}'::jsonb)), 'u-5');
select pg_temp.visit((select value from qa where key = 'token'), 'f-5-phone', 's-5a', 'mobile', jsonb_build_array(
  pg_temp.ev('page_viewed', 'f5-1', 40, '/'), pg_temp.ev('slide_1_passed', 'f5-2', 39)));
select pg_temp.visit((select value from qa where key = 'token'), 'f-5-phone', 's-5a', 'mobile', jsonb_build_array(
  pg_temp.ev('identified', 'f5-5', 38)), 'u-5');
-- An automated browser and a development key, both left out.
select pg_temp.visit((select value from qa where key = 'token'), 'f-bot', 's-bot', 'desktop', jsonb_build_array(
  pg_temp.ev('page_viewed', 'fb-1', 60, '/'), pg_temp.ev('slide_1_passed', 'fb-2', 59)), null, '{"webdriver":true}'::jsonb);
select pg_temp.visit((select value from qa where key = 'dev_token'), 'f-dev', 's-dev', 'desktop', jsonb_build_array(
  pg_temp.ev('page_viewed', 'fd-1', 60, '/'), pg_temp.ev('slide_1_passed', 'fd-2', 59)));
reset role;
select pg_temp.check((select count(*) = 1 from public.analytics_people where user_id = 'u-5'), 'the phone and laptop are one person');

insert into qa values ('funnel', jsonb_build_object('window_seconds', 86400, 'steps', jsonb_build_array(
  jsonb_build_object('kind', 'screen', 'match', 'is', 'value', '/', 'label', 'Opened the quiz'),
  jsonb_build_object('kind', 'event', 'event', 'slide_1_passed'),
  jsonb_build_object('kind', 'event', 'event', 'slide_2_passed'),
  jsonb_build_object('kind', 'event', 'event', 'email_entered')))::text);

-- Reports ------------------------------------------------------------------------------------
select pg_temp.as_user('b1000000-0000-4000-8000-000000000002');
insert into qa select 'report', pg_temp.report((select value from qa where key = 'project'), (select value::jsonb from qa where key = 'funnel'))::text;
select pg_temp.check((select pg_temp.people_at(value::jsonb) = '[5,4,2,2]'::jsonb from qa where key = 'report'),
  'people reach each step in order, once each, across devices, without bots or development data');
select pg_temp.check((select value::jsonb->>'started' = '5' and value::jsonb->>'converted' = '2' from qa where key = 'report'), 'started and converted totals');
select pg_temp.check((select jsonb_agg(s->'dropped' order by (s->>'index')::int) = '[1,2,0,null]'::jsonb
  and jsonb_agg(s->'from_start' order by (s->>'index')::int) = '[1,0.8,0.4,0.4]'::jsonb
  and jsonb_agg(s->'from_previous' order by (s->>'index')::int) = '[null,0.8,0.5,1]'::jsonb
  from qa, jsonb_array_elements(value::jsonb->'steps') s where key = 'report'), 'drop-off and conversion rates');
select pg_temp.check((select (value::jsonb#>>'{steps,1,median_seconds}')::int = 210 from qa where key = 'report'), 'median time between steps');
select pg_temp.check((select value::jsonb#>>'{steps,0,step,label}' = 'Opened the quiz' from qa where key = 'report'), 'steps keep their names');
select pg_temp.check((select (select sum((b->>'started')::int) from jsonb_array_elements(value::jsonb->'series') b) = 5
  and (select sum((b->>'converted')::int) from jsonb_array_elements(value::jsonb->'series') b) = 2
  and jsonb_array_length(value::jsonb->'series') = 7 from qa where key = 'report'), 'daily series adds up to the totals');

select pg_temp.check(pg_temp.people_at(pg_temp.report((select value from qa where key = 'project'),
  (select jsonb_set(value::jsonb, '{window_seconds}', '3600') from qa where key = 'funnel'))) = '[5,3,2,2]'::jsonb,
  'a shorter time limit drops the slow finisher');
select pg_temp.check(pg_temp.people_at(pg_temp.report((select value from qa where key = 'project'),
  (select jsonb_set(value::jsonb, '{steps,3,filter}', '{"property":"plan","value":"pro"}') from qa where key = 'funnel'))) = '[5,4,2,1]'::jsonb,
  'a property filter narrows a step');
select pg_temp.check(pg_temp.people_at(pg_temp.report((select value from qa where key = 'project'),
  '{"window_seconds":86400,"steps":[{"kind":"event","event":"slide_1_passed"},{"kind":"event","event":"slide_1_passed"}]}')) = '[5,2]'::jsonb,
  'the same event as two steps needs two separate events');
select pg_temp.check(pg_temp.people_at(pg_temp.report((select value from qa where key = 'project'),
  '{"window_seconds":86400,"steps":[{"kind":"screen","value":"/"},{"kind":"screen","match":"contains","value":"PRIC"}]}')) = '[5,1]'::jsonb,
  'page steps match without case or trailing slash');
select pg_temp.check(pg_temp.people_at(pg_temp.report((select value from qa where key = 'project'),
  '{"window_seconds":86400,"steps":[{"kind":"screen","value":"/"},{"kind":"screen","match":"starts_with","value":"/check"}]}')) = '[5,1]'::jsonb,
  'starts-with page steps');
select pg_temp.check((select jsonb_agg(jsonb_build_object(b->>'key', b->'steps') order by b->>'key') = '[{"desktop":[4,3,1,1]},{"mobile":[1,1,1,1]}]'::jsonb
  from jsonb_array_elements(pg_temp.report((select value from qa where key = 'project'), (select value::jsonb from qa where key = 'funnel'), 'device')->'breakdown') b),
  'breakdown by the device where each person started');

-- The people behind a bar.
select pg_temp.check((select (r->>'total')::int = 2 and (select array_agg(p->>'distinct_id' order by p->>'distinct_id') from jsonb_array_elements(r->'people') p) = array['f-2', 'f-4']
  from (select public.analytics_funnel_people((select value::uuid from qa where key = 'project'), (select value::jsonb from qa where key = 'funnel'), '7d', 2, 'dropped') r) t),
  'people who stopped after a step');
select pg_temp.check((select min((r->>'total')::int) = 2 and bool_and(p->>'session_id' is not null) and bool_or(p->>'distinct_id' = 'u-5')
  from (select public.analytics_funnel_people((select value::uuid from qa where key = 'project'), (select value::jsonb from qa where key = 'funnel'), '7d', 4, 'reached') r) t,
  jsonb_array_elements(r->'people') p), 'people who finished, each with the session of that step');
select pg_temp.check((select (r->>'total')::int = 1 and r#>>'{people,0,distinct_id}' = 'u-5'
  from (select public.analytics_funnel_people((select value::uuid from qa where key = 'project'), (select value::jsonb from qa where key = 'funnel'), '7d', 1, 'reached', 'device', 'mobile') r) t),
  'people in one breakdown group');
select pg_temp.check(pg_temp.fails(format('select public.analytics_funnel_people(%L, %L, ''7d'', 4, ''dropped'')',
  (select value from qa where key = 'project'), (select value from qa where key = 'funnel'))) like '22023%', 'nobody drops after the last step');

-- Step checks ----------------------------------------------------------------------------------
select pg_temp.check(pg_temp.fails(format('select pg_temp.report(%L, %L)', (select value from qa where key = 'project'),
  '{"window_seconds":86400,"steps":[{"kind":"event","event":"a"}]}')) like '22023%', 'a funnel needs two steps');
select pg_temp.check(pg_temp.fails(format('select pg_temp.report(%L, %L)', (select value from qa where key = 'project'),
  '{"window_seconds":60,"steps":[{"kind":"event","event":"a"},{"kind":"event","event":"b"}]}')) like '22023%', 'only the offered time limits');
select pg_temp.check(pg_temp.fails(format('select pg_temp.report(%L, %L)', (select value from qa where key = 'project'),
  '{"window_seconds":3600,"steps":[{"kind":"event","event":"a"},{"kind":"screen","match":"ends_with","value":"/x"}]}')) like '22023%', 'unknown page matches refused');
select pg_temp.check(pg_temp.fails(format('select pg_temp.report(%L, %L)', (select value from qa where key = 'project'),
  '{"window_seconds":3600,"steps":[{"kind":"event","event":"a"},{"kind":"event","event":"bad name!"}]}')) like '22023%', 'event names are checked');
select pg_temp.check(pg_temp.fails(format('select pg_temp.report(%L, %L)', (select value from qa where key = 'project'),
  '{"window_seconds":3600,"steps":[{"kind":"event","event":"a"},{"kind":"event","event":"b","filter":{"property":"plan"}}]}')) like '22023%', 'filters need a value');
select pg_temp.check(pg_temp.fails(format('select pg_temp.report(%L, %L, ''planet'')', (select value from qa where key = 'project'),
  (select value from qa where key = 'funnel'))) like '22023%', 'unknown breakdowns refused');

-- Saved funnels ----------------------------------------------------------------------------------
insert into qa select 'saved', public.analytics_save_funnel((select value::uuid from qa where key = 'project'), null, ' Quiz to email ',
  (select value::jsonb->'steps' from qa where key = 'funnel'), 86400)->>'id';
select pg_temp.check((select f->>'name' = 'Quiz to email' and f->>'created_by' = 'Tolu Analyst' and jsonb_array_length(f->'steps') = 4
  from jsonb_array_elements(public.analytics_funnels((select value::uuid from qa where key = 'project'))) f), 'analysts save funnels for the team');
select public.analytics_save_funnel((select value::uuid from qa where key = 'project'), (select value::uuid from qa where key = 'saved'), 'Quiz',
  '[{"kind":"screen","value":"/"},{"kind":"event","event":"slide_1_passed","unknown":"dropped"}]', 3600);
select pg_temp.check((select f->>'name' = 'Quiz' and (f->>'window_seconds')::int = 3600 and f->'steps'->1 = '{"kind":"event","event":"slide_1_passed"}'::jsonb
  and f#>>'{steps,0,match}' = 'is'
  from jsonb_array_elements(public.analytics_funnels((select value::uuid from qa where key = 'project'))) f), 'saving again replaces the steps in their stored shape');
select pg_temp.check(pg_temp.fails(format('select public.analytics_save_funnel(%L, null, '''', %L, 3600)', (select value from qa where key = 'project'),
  '[{"kind":"event","event":"a"},{"kind":"event","event":"b"}]')) like '22023%', 'funnels need a name');
select pg_temp.check((select o->'events' @> '[{"name":"slide_1_passed"}]' and o->'screens' @> '[{"screen":"/"}]'
  and o#>'{properties,email_entered}' @> '[{"key":"plan"}]' and o#>'{properties,email_entered,0,values}' ?| array['pro', 'free']
  from (select public.analytics_funnel_options((select value::uuid from qa where key = 'project')) o) t), 'the step picker offers events, pages and property values');

select pg_temp.as_user('b1000000-0000-4000-8000-000000000003');
select pg_temp.check(pg_temp.fails(format('select public.analytics_funnels(%L)', (select value from qa where key = 'project'))) like 'P0002%', 'outsiders cannot see funnels');
select pg_temp.check(pg_temp.fails(format('select public.analytics_delete_funnel(%L)', (select value from qa where key = 'saved'))) like 'P0002%', 'outsiders cannot delete funnels');
select pg_temp.check(pg_temp.fails(format('select public.analytics_funnel_report(%L, %L, ''7d'')', (select value from qa where key = 'project'),
  (select value from qa where key = 'funnel'))) like 'P0002%', 'outsiders cannot run reports');
select pg_temp.as_user('b1000000-0000-4000-8000-000000000001');
select public.analytics_delete_funnel((select value::uuid from qa where key = 'saved'));
select pg_temp.check(public.analytics_funnels((select value::uuid from qa where key = 'project')) = '[]'::jsonb, 'deleted funnels are gone');
select pg_temp.check(not has_table_privilege('authenticated', 'public.analytics_funnels', 'select'), 'funnels are read only through the reports');
select pg_temp.check(not has_function_privilege('anon', 'public.analytics_funnel_report(uuid,jsonb,text,text)', 'execute'), 'anon cannot run funnels');

select 'ok ' || count(*) || ' merchant funnel assertions' from funnel_assertions;
rollback;
