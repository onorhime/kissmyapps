-- Provider-free test of merchant analytics retention: who starts in which cohort, who comes
-- back in which period, in the project's time zone, without bots or development data.
begin;
set local time zone 'UTC';
create temporary table retention_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Retention assertion failed: %', label; end if;
  insert into retention_assertions values (label);
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
  select public.analytics_ingest(jsonb_build_object('key_hash', encode(extensions.digest(token, 'sha256'), 'hex'), 'body', body))
$$;
-- A wall-clock time in Lagos (UTC+1), some days before today there.
create function pg_temp.lagos(days_ago integer, clock text) returns text language sql as $$
  select to_char(((((now() at time zone 'Africa/Lagos')::date - days_ago) + clock::time) at time zone 'Africa/Lagos') at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
-- One session of one person on one day, with page views or the events given.
create function pg_temp.visit(token text, anon text, session text, device text, days_ago integer, clock text,
  names text[] default array['page_viewed'], extra jsonb default '{}')
returns jsonb language sql as $$
  select pg_temp.ingest(token, jsonb_build_object('anonymous_id', anon,
    'session', jsonb_build_object('id', session, 'started_at', pg_temp.lagos(days_ago, clock)),
    'context', jsonb_build_object('platform', 'web', 'device_type', device, 'browser', 'Chrome', 'interactions', 5) || extra,
    'events', (select jsonb_agg(jsonb_build_object('name', n, 'insert_id', session || '-' || i, 'time', pg_temp.lagos(days_ago, clock),
      'screen', case when n = 'page_viewed' then '/' end)) from unnest(names) with ordinality u(n, i))))
$$;
create function pg_temp.report(definition jsonb, breakdown text default 'none') returns jsonb language sql as $$
  select public.analytics_retention_report((select value::uuid from qa where key = 'project'), definition, breakdown)
$$;
-- A cohort's returns by period, as {period: people}, leaving out periods nobody came back in.
create function pg_temp.cells(r jsonb, days_ago integer) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(x->>'period', (x->>'people')::int) filter (where (x->>'people')::int > 0), '{}')
  from jsonb_array_elements(r->'cohorts') c, jsonb_array_elements(c->'values') x
  where (c->>'start')::date = (now() at time zone 'Africa/Lagos')::date - days_ago
$$;
grant all on qa, retention_assertions to authenticated, service_role;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('c1000000-0000-4000-8000-000000000001', 'owner@retention.example', now(), '{"full_name":"Ada Owner","company":"Retention Lab"}'::jsonb),
  ('c1000000-0000-4000-8000-000000000002', 'analyst@retention.example', now(), '{"full_name":"Tolu Analyst"}'::jsonb),
  ('c1000000-0000-4000-8000-000000000003', 'stranger@elsewhere.example', now(), '{}');

select pg_temp.as_user('c1000000-0000-4000-8000-000000000001');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project((select value::uuid from qa where key = 'workspace'), 'SpeakSix', array['web'], 'Africa/Lagos') r)
insert into qa select 'project', r->'project'->>'id' from created;
-- History older than a week comes in through a server key, as an import would.
insert into qa select 'server', public.analytics_create_key((select value::uuid from qa where key = 'project'), 'Import', 'server', 'production')->>'token';
insert into qa select 'dev', public.analytics_create_key((select value::uuid from qa where key = 'project'), 'Staging', 'client', 'development')->>'token';
select public.analytics_invite_member((select value::uuid from qa where key = 'workspace'), 'analyst@retention.example', 'analyst');
select pg_temp.as_user('c1000000-0000-4000-8000-000000000002');
select public.analytics_bootstrap();

-- Visits -------------------------------------------------------------------------------------
select pg_temp.as_user(null);
set local role service_role;
-- Starts 10 days ago, back the next day and on day 7.
select pg_temp.visit((select value from qa where key = 'server'), 'r-1', 's-1a', 'desktop', 10, '10:00', array['page_viewed', 'signed_up']);
select pg_temp.visit((select value from qa where key = 'server'), 'r-1', 's-1b', 'desktop', 9, '10:00');
select pg_temp.visit((select value from qa where key = 'server'), 'r-1', 's-1c', 'desktop', 3, '10:00');
-- Starts 10 days ago and is back only the next day.
select pg_temp.visit((select value from qa where key = 'server'), 'r-2', 's-2a', 'desktop', 10, '11:00');
select pg_temp.visit((select value from qa where key = 'server'), 'r-2', 's-2b', 'desktop', 9, '12:00');
-- Starts 10 days ago and never comes back.
select pg_temp.visit((select value from qa where key = 'server'), 'r-3', 's-3a', 'desktop', 10, '09:00');
-- Starts 8 days ago on a phone, back on day 7 to finish a lesson.
select pg_temp.visit((select value from qa where key = 'server'), 'r-4', 's-4a', 'mobile', 8, '10:00');
select pg_temp.visit((select value from qa where key = 'server'), 'r-4', 's-4b', 'mobile', 1, '10:00', array['lesson_completed']);
-- Starts 2 days ago and has not been back.
select pg_temp.visit((select value from qa where key = 'server'), 'r-5', 's-5a', 'mobile', 2, '10:00');
-- Starts at 00:30 in Lagos (23:30 the day before in UTC), again that evening, then at 01:00 the next day.
select pg_temp.visit((select value from qa where key = 'server'), 'r-6', 's-6a', 'desktop', 3, '00:30');
select pg_temp.visit((select value from qa where key = 'server'), 'r-6', 's-6b', 'desktop', 3, '23:00');
select pg_temp.visit((select value from qa where key = 'server'), 'r-6', 's-6c', 'desktop', 2, '01:00');
-- Started 40 days ago and was back on day 30.
select pg_temp.visit((select value from qa where key = 'server'), 'r-old', 's-oa', 'desktop', 40, '10:00');
select pg_temp.visit((select value from qa where key = 'server'), 'r-old', 's-ob', 'desktop', 10, '10:00');
-- An automated browser and a development key, both left out.
select pg_temp.visit((select value from qa where key = 'server'), 'r-bot', 's-ba', 'desktop', 10, '10:00', array['page_viewed'], '{"webdriver":true}');
select pg_temp.visit((select value from qa where key = 'server'), 'r-bot', 's-bb', 'desktop', 9, '10:00', array['page_viewed'], '{"webdriver":true}');
select pg_temp.visit((select value from qa where key = 'dev'), 'r-dev', 's-da', 'desktop', 5, '10:00');
select pg_temp.visit((select value from qa where key = 'dev'), 'r-dev', 's-db', 'desktop', 4, '10:00');
reset role;
select pg_temp.check((select count(*) = 9 from public.analytics_people where project_id = (select value::uuid from qa where key = 'project')),
  'every visitor was stored');

-- Day cohorts ------------------------------------------------------------------------------------
select pg_temp.as_user('c1000000-0000-4000-8000-000000000002');
insert into qa select 'day', pg_temp.report('{"interval":"day"}')::text;
select pg_temp.check((select r->'definition' = '{"interval":"day","start":{"kind":"first_seen"},"return":{"kind":"any"}}'::jsonb
  and (r->>'periods')::int = 14 and jsonb_array_length(r->'cohorts') = 15 and (r->>'started')::int = 6
  from (select value::jsonb r from qa where key = 'day') t), 'fifteen daily cohorts for two weeks, six people without bots, development or older starts');
select pg_temp.check((select jsonb_object_agg(c->>'start', (c->>'people')::int) filter (where (c->>'people')::int > 0)
  = jsonb_build_object(((now() at time zone 'Africa/Lagos')::date - 10)::text, 3, ((now() at time zone 'Africa/Lagos')::date - 8)::text, 1,
    ((now() at time zone 'Africa/Lagos')::date - 3)::text, 1, ((now() at time zone 'Africa/Lagos')::date - 2)::text, 1)
  from qa, jsonb_array_elements(value::jsonb->'cohorts') c where key = 'day'), 'people start on their first day in the project time zone');
select pg_temp.check((select pg_temp.cells(value::jsonb, 10) = '{"1":2,"7":1}'::jsonb and pg_temp.cells(value::jsonb, 8) = '{"7":1}'::jsonb
  and pg_temp.cells(value::jsonb, 2) = '{}'::jsonb from qa where key = 'day'), 'who came back on which day');
select pg_temp.check((select pg_temp.cells(value::jsonb, 3) = '{"1":1}'::jsonb from qa where key = 'day'),
  'a return later on the first local day does not count, the next local day does');
select pg_temp.check((select jsonb_agg(x->>'state' order by (x->>'period')::int) = '["complete","complete","complete","complete","complete","complete","complete","complete","complete","partial","future","future","future","future"]'::jsonb
  and bool_and(x->'people' = 'null'::jsonb) filter (where x->>'state' = 'future')
  from qa, jsonb_array_elements(value::jsonb->'cohorts') c, jsonb_array_elements(c->'values') x
  where key = 'day' and (c->>'start')::date = (now() at time zone 'Africa/Lagos')::date - 10), 'periods still to come are empty, today is in progress');
select pg_temp.check((select jsonb_agg(jsonb_build_array((x->>'people')::int, (x->>'returned')::int) order by (x->>'period')::int) filter (where (x->>'period')::int in (1, 2, 7, 9))
  = '[[6,3],[5,0],[4,2],[3,0]]'::jsonb from qa, jsonb_array_elements(value::jsonb->'curve') x where key = 'day'),
  'the curve counts only cohorts whose period has finished');
select pg_temp.check((select jsonb_agg(jsonb_build_array((h->>'day')::int, (h->>'people')::int, (h->>'returned')::int) order by (h->>'day')::int)
  = '[[1,6,3],[7,4,2],[30,1,1]]'::jsonb from qa, jsonb_array_elements(value::jsonb->'headline') h where key = 'day'),
  'day 1, 7 and 30 over the people who reached that day in the last 30 days');

select pg_temp.check((select jsonb_agg(jsonb_build_array((x->>'people')::int, (x->>'returned')::int) order by (x->>'period')::int) filter (where (x->>'period')::int in (1, 7))
  = '[[6,0],[4,1]]'::jsonb from jsonb_array_elements(pg_temp.report('{"interval":"day","return":{"kind":"event","event":"lesson_completed"}}')->'curve') x),
  'coming back can mean doing a chosen event');
select pg_temp.check((select (r->>'started')::int = 1 and pg_temp.cells(r, 10) = '{"1":1,"7":1}'::jsonb
  from (select pg_temp.report('{"interval":"day","start":{"kind":"event","event":"signed_up"}}') r) t), 'starting can mean doing a chosen event');
select pg_temp.check((select jsonb_agg(jsonb_build_object(b->>'key', jsonb_build_array((b->>'people')::int, (b#>>'{values,0,people}')::int, (b#>>'{values,0,returned}')::int)) order by b->>'key')
  = '[{"desktop":[4,4,3]},{"mobile":[2,2,0]}]'::jsonb
  from jsonb_array_elements(pg_temp.report('{"interval":"day"}', 'device')->'breakdown') b), 'breakdown by the device people were first seen on');

-- Weeks and months ---------------------------------------------------------------------------------
select pg_temp.check((select (r->>'periods')::int = 8 and jsonb_array_length(r->'cohorts') = 9 and (r->>'started')::int = 7
  and (select bool_and(extract(isodow from (c->>'start')::date) = 1) from jsonb_array_elements(r->'cohorts') c)
  from (select pg_temp.report('{"interval":"week"}') r) t), 'weekly cohorts start on Mondays and reach back eight weeks');
select pg_temp.check((select (r->>'periods')::int = 6 and jsonb_array_length(r->'cohorts') = 7 and (r->>'started')::int = 7
  and (select bool_and(extract(day from (c->>'start')::date) = 1) from jsonb_array_elements(r->'cohorts') c)
  from (select pg_temp.report('{"interval":"month"}') r) t), 'monthly cohorts start on the first and reach back six months');
select pg_temp.check(kma_internal.analytics_period_index('month', '2026-01-31', '2026-02-01') = 1
  and kma_internal.analytics_period_index('week', '2026-10-25', '2026-10-26') = 1
  and kma_internal.analytics_period_index('week', '2026-10-26', '2026-11-01') = 0, 'periods follow the calendar');

-- People --------------------------------------------------------------------------------------------
select pg_temp.check((select (r->>'total')::int = 2 and (select array_agg(p->>'distinct_id' order by p->>'distinct_id') from jsonb_array_elements(r->'people') p) = array['r-1', 'r-2']
  from (select public.analytics_retention_people((select value::uuid from qa where key = 'project'), '{"interval":"day"}',
    (now() at time zone 'Africa/Lagos')::date - 10, 1) r) t), 'the people who came back in one cell');
select pg_temp.check((select (r->>'total')::int = 3 and (r#>>'{people,0,days_back}')::int >= 0
  from (select public.analytics_retention_people((select value::uuid from qa where key = 'project'), '{"interval":"day"}',
    (now() at time zone 'Africa/Lagos')::date - 10, 0) r) t), 'everyone in a cohort');
select pg_temp.check((select (r->>'total')::int = 1 and r#>>'{people,0,distinct_id}' = 'r-4'
  from (select public.analytics_retention_people((select value::uuid from qa where key = 'project'), '{"interval":"day"}',
    null, 7, 'device', 'mobile') r) t), 'the people of one group who came back');
select pg_temp.check(pg_temp.fails(format('select public.analytics_retention_people(%L, ''{"interval":"day"}'', null, 15)',
  (select value from qa where key = 'project'))) like '22023%', 'periods past the table are refused');

-- Overview figure ------------------------------------------------------------------------------------
select pg_temp.check((select s->>'day' = '7' and (s->>'people')::int = 4 and (s->>'returned')::int = 2
  and (s->>'to')::date = (now() at time zone 'Africa/Lagos')::date - 8
  from (select public.analytics_retention_summary((select value::uuid from qa where key = 'project')) s) t),
  'back on day 7, of the people first seen in the 30 days to a week ago');
select pg_temp.check((select h->>'people' = s->>'people' and h->>'returned' = s->>'returned'
  from qa, jsonb_array_elements(value::jsonb->'headline') h,
    (select public.analytics_retention_summary((select value::uuid from qa where key = 'project')) s) t
  where key = 'day' and h->>'day' = '7'), 'the overview figure is the retention page''s day 7');

-- Checks and access ------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.fails('select pg_temp.report(''{"interval":"year"}'')') like '22023%', 'only days, weeks or months');
select pg_temp.check(pg_temp.fails('select pg_temp.report(''{"interval":"day","start":{"kind":"event","event":"bad name!"}}'')') like '22023%',
  'start events are checked');
select pg_temp.check(pg_temp.fails('select pg_temp.report(''{"interval":"day"}'', ''planet'')') like '22023%', 'unknown breakdowns refused');
select pg_temp.as_user('c1000000-0000-4000-8000-000000000003');
select pg_temp.check(pg_temp.fails('select pg_temp.report(''{"interval":"day"}'')') like 'P0002%', 'outsiders cannot read retention');
select pg_temp.check(pg_temp.fails(format('select public.analytics_retention_summary(%L)', (select value from qa where key = 'project'))) like 'P0002%',
  'outsiders cannot read the overview figure');
select pg_temp.check(not has_function_privilege('anon', 'public.analytics_retention_report(uuid,jsonb,text)', 'execute'), 'anon cannot read retention');

select 'ok ' || count(*) || ' merchant retention assertions' from retention_assertions;
rollback;
