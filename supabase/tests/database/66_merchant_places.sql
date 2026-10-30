-- Provider-free test of city-level places: a session's and a person's place stay whole as
-- events arrive, a country opens into its regions and cities, and the Users list filtered
-- by a place counts the same people as the Overview.
begin;
set local time zone 'UTC';
create temporary table places_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Places assertion failed: %', label; end if;
  insert into places_assertions values (label);
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
create function pg_temp.at(minutes_ago integer) returns text language sql as $$
  select to_char((now() - make_interval(mins => minutes_ago)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
-- One page view in a session, with the place the function worked out for the request.
create function pg_temp.visit(key text, anon text, session text, minutes_ago integer, geo jsonb, context jsonb default '{}')
returns jsonb language sql as $$
  select public.analytics_ingest(jsonb_build_object(
    'key_hash', encode(extensions.digest((select value from qa where qa.key = visit.key), 'sha256'), 'hex'),
    'geo', geo,
    'body', jsonb_build_object('anonymous_id', anon,
      'session', jsonb_build_object('id', session, 'started_at', pg_temp.at(minutes_ago)),
      'context', jsonb_build_object('platform', 'web', 'device_type', 'desktop', 'browser', 'Chrome', 'interactions', 5) || context,
      'events', jsonb_build_array(jsonb_build_object('name', 'page_viewed', 'insert_id', session || '-' || minutes_ago,
        'time', pg_temp.at(minutes_ago), 'screen', '/')))))
$$;
create function pg_temp.place(country text, region text, city text, source text default 'ip') returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('country', country, 'region', region, 'city', city, 'source', source))
$$;
create function pg_temp.places(country text default null) returns jsonb language sql as $$
  select public.analytics_places((select value::uuid from qa where key = 'project'), '7d', country)
$$;
create function pg_temp.people(query jsonb) returns jsonb language sql as $$
  select public.analytics_people_page((select value::uuid from qa where key = 'project'), '{"range":"7d"}'::jsonb || query)
$$;
create function pg_temp.users_in(list jsonb, k text) returns integer language sql as $$
  select (x->>'users')::int from jsonb_array_elements(list) x where x->>'key' = k
$$;
grant all on qa, places_assertions to authenticated, service_role;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('d1000000-0000-4000-8000-000000000001', 'owner@places.example', now(), '{"full_name":"Ada Owner","company":"Places Lab"}'::jsonb),
  ('d1000000-0000-4000-8000-000000000002', 'stranger@elsewhere.example', now(), '{}');

select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project((select value::uuid from qa where key = 'workspace'), 'SpeakSix', array['web'], 'Africa/Lagos') r)
insert into qa select 'project', r->'project'->>'id' from created;
insert into qa select 'client', public.analytics_create_key((select value::uuid from qa where key = 'project'), 'Website', 'client', 'production')->>'token';
insert into qa select 'server', public.analytics_create_key((select value::uuid from qa where key = 'project'), 'Backend', 'server', 'production')->>'token';
insert into qa select 'dev', public.analytics_create_key((select value::uuid from qa where key = 'project'), 'Staging', 'client', 'development')->>'token';

-- Visits ----------------------------------------------------------------------------------------
select pg_temp.as_user(null);
set local role service_role;
-- In Ikeja; a later event in the same session looked up elsewhere does not move it.
select pg_temp.visit('client', 'p-1', 's-1', 60, pg_temp.place('NG', 'Lagos', 'Ikeja'));
select pg_temp.visit('client', 'p-1', 's-1', 50, pg_temp.place('NG', 'Lagos', 'Lagos'));
-- First known only by the time zone, then looked up: the session takes the whole place.
select pg_temp.visit('client', 'p-2', 's-2', 60, pg_temp.place('NG', null, null, 'timezone'));
select pg_temp.visit('client', 'p-2', 's-2', 55, pg_temp.place('NG', 'Lagos', 'Lagos'));
select pg_temp.visit('client', 'p-3', 's-3', 60, pg_temp.place('NG', 'Federal Capital Territory', 'Abuja'));
-- In London, then back in Nigeria known only by the time zone: London's region and city go.
select pg_temp.visit('client', 'p-4', 's-4a', 180, pg_temp.place('GB', 'England', 'London'));
select pg_temp.visit('client', 'p-4', 's-4b', 60, pg_temp.place('NG', null, null, 'timezone'));
-- In Ikeja, then in Nigeria known only by the time zone: still Ikeja.
select pg_temp.visit('client', 'p-5', 's-5a', 180, pg_temp.place('NG', 'Lagos', 'Ikeja'));
select pg_temp.visit('client', 'p-5', 's-5b', 60, pg_temp.place('NG', null, null, 'timezone'));
select pg_temp.visit('client', 'p-6', 's-6', 60, pg_temp.place('NG', null, null, 'timezone'));
-- A merchant's server names the place itself; the request's own place is not used.
select pg_temp.visit('server', 'p-7', 's-7', 60, pg_temp.place('US', 'Virginia', 'Ashburn'),
  '{"platform":"server","country":"NG","region":"Kano","city":"Kano"}');
-- Development traffic stays out of reports.
select pg_temp.visit('dev', 'p-8', 's-8', 60, pg_temp.place('NG', 'Kano', 'Kano'));
reset role;

-- Stored places ---------------------------------------------------------------------------------
select pg_temp.check((select city = 'Ikeja' and region = 'Lagos' and location_source = 'ip'
  from public.analytics_sessions where session_key = 's-1'), 'a session keeps its first city');
select pg_temp.check((select country = 'NG' and region = 'Lagos' and city = 'Lagos' and location_source = 'ip'
  from public.analytics_sessions where session_key = 's-2'), 'a city replaces a place known only by the time zone, whole');
select pg_temp.check((select country = 'NG' and region is null and city is null
  from public.analytics_people where distinct_id = 'p-4'), 'a new country without a city drops the old city');
select pg_temp.check((select country = 'NG' and region = 'Lagos' and city = 'Ikeja'
  from public.analytics_people where distinct_id = 'p-5'), 'the same country without a city keeps the city');
select pg_temp.check((select country = 'NG' and region = 'Kano' and city = 'Kano' and location_source = 'api'
  from public.analytics_sessions where session_key = 's-7'), 'a server key''s place is the one it sent');

-- The Overview's drill-down ---------------------------------------------------------------------
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select pg_temp.check((select (r->>'users')::int = 7 and (r->>'unknown_city')::int = 2 and (r->>'unknown_region')::int = 2
  and r->>'country' = 'NG' from (select pg_temp.places('ng') r) t), 'a country''s people, and those never placed in a city there');
select pg_temp.check((select pg_temp.users_in(r->'regions', 'Lagos') = 3 and pg_temp.users_in(r->'regions', 'Federal Capital Territory') = 1
  and pg_temp.users_in(r->'regions', 'Kano') = 1 and jsonb_array_length(r->'regions') = 3
  from (select pg_temp.places('NG') r) t), 'a country''s regions, by people');
select pg_temp.check((select r->'cities'->0 = '{"key":"Ikeja","region":"Lagos","country":"NG","users":2}'::jsonb
  and pg_temp.users_in(r->'cities', 'Lagos') = 1 and pg_temp.users_in(r->'cities', 'Abuja') = 1
  and pg_temp.users_in(r->'cities', 'London') is null
  from (select pg_temp.places('NG') r) t), 'a country''s cities, largest first, with their regions');
select pg_temp.check((select pg_temp.users_in(r->'cities', 'London') = 1 and r->'regions' = '[]'::jsonb and (r->>'users')::int = 7
  from (select pg_temp.places() r) t), 'without a country, the cities everywhere');
select pg_temp.check((select pg_temp.users_in(o#>'{breakdowns,countries}', 'NG') = (pg_temp.places('NG')->>'users')::int
  from (select public.analytics_overview((select value::uuid from qa where key = 'project'), '7d') o) t),
  'a country opens to the same number of people the Overview shows for it');

-- The Users list, filtered by place ---------------------------------------------------------------
select pg_temp.check((pg_temp.people('{"country":"NG"}')->>'total')::int = 7, 'everyone with a session in the country');
select pg_temp.check((select (r->>'total')::int = 1 and r#>>'{rows,0,distinct_id}' = 'p-4'
  from (select pg_temp.people('{"country":"GB"}') r) t), 'people are found where they were in the range, not only where they are now');
select pg_temp.check((select (r->>'total')::int = 2
  and (select array_agg(x->>'distinct_id' order by x->>'distinct_id') from jsonb_array_elements(r->'rows') x) = array['p-1', 'p-5']
  from (select pg_temp.people('{"country":"NG","region":"Lagos","city":"Ikeja"}') r) t), 'filtered by city, as the drill-down counts it');
select pg_temp.check((pg_temp.people('{"country":"NG","region":"Lagos"}')->>'total')::int = pg_temp.users_in(pg_temp.places('NG')->'regions', 'Lagos'),
  'filtered by region, as the drill-down counts it');
select pg_temp.check((pg_temp.people('{"country":"NG","city":"Ikeja"}')->>'total')::int = 2, 'a city without its region');
select pg_temp.check((select r#>'{facets,places}' @> '[{"region":"Lagos","city":"Ikeja"},{"region":"Kano","city":"Kano"}]'
  and not r#>'{facets,places}' @> '[{"city":"London"}]' and r#>'{facets,countries}' @> '["GB","NG"]'
  from (select pg_temp.people('{"country":"NG"}') r) t), 'the places to choose from are the country''s');
select pg_temp.check(pg_temp.people('{}')#>'{facets,places}' = '[]'::jsonb, 'no places to choose before a country');
select pg_temp.check((select (r->>'total')::int = 1 from (select pg_temp.people('{"country":"GB","search":"p-4"}') r) t),
  'a search still filters by place');

-- Checks and access -----------------------------------------------------------------------------
select pg_temp.check(pg_temp.fails('select pg_temp.places(''Nigeria'')') like '22023%', 'countries are two-letter codes');
select pg_temp.check(pg_temp.fails('select pg_temp.people(''{"city":"Ikeja"}'')') like '22023%', 'a city needs its country');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select pg_temp.check(pg_temp.fails('select pg_temp.places(''NG'')') like 'P0002%', 'outsiders cannot read places');
select pg_temp.check(not has_function_privilege('anon', 'public.analytics_places(uuid,text,text)', 'execute'), 'anon cannot read places');

select 'ok ' || count(*) || ' merchant places assertions' from places_assertions;
rollback;
