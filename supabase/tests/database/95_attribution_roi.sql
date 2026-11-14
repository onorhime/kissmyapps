-- Provider-free test of attribution Phase 3, piece C: return on ad spend by source, campaign,
-- ad set, ad and day, and cohorts with revenue per person, ROAS and retention.
--
-- People are made through the real functions: website visits and app events through
-- analytics_ingest (a server key for visits older than an app key may send), link clicks
-- through attribution_record_clicks, app installs through attribution_install, bot marks through
-- analytics_set_override. Revenue rows are inserted directly into attribution_revenue (piece A
-- owns the intake), costs directly into attribution_costs (piece B owns the console), exchange
-- rates directly into attribution_fx_rates (piece A owns the ECB worker).
--
-- Times are relative to now(). Someone acquired "k days ago" was first seen k whole days and a
-- few minutes before now (never more than half the time since local midnight), so they fall on
-- the local day k days ago and their day n is complete exactly when n < k, whatever the time of
-- day the suite runs at. Every expected number below was worked out by hand from this cast.
begin;
set local time zone 'UTC';
create temporary table roi_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Attribution ROI assertion failed: %', label; end if;
  insert into roi_assertions values (label);
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
-- The message of a refusal, or 'ok'.
create function pg_temp.message(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlerrm;
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

-- Time ------------------------------------------------------------------------------------------
-- The project's local day k days ago, as reports write it.
create function pg_temp.d(k integer) returns text language sql as $$
  select to_char((now() at time zone 'Africa/Lagos')::date - k, 'YYYY-MM-DD')
$$;
create function pg_temp.date(k integer) returns date language sql as $$
  select (now() at time zone 'Africa/Lagos')::date - k
$$;
-- A few minutes, and less than half the time since local midnight.
create function pg_temp.delta() returns interval language sql as $$
  select least(interval '5 minutes', date_trunc('milliseconds',
    (now() - (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos')) / 2))
$$;
-- A few minutes, and less than half the time until the next local midnight.
create function pg_temp.eps() returns interval language sql as $$
  select least(interval '5 minutes', date_trunc('milliseconds',
    (((date_trunc('day', now() at time zone 'Africa/Lagos') + interval '1 day') at time zone 'Africa/Lagos') - now()) / 2))
$$;
-- First seen k days ago: on the local day k days ago, more than k whole days before now.
create function pg_temp.ago(k integer) returns timestamptz language sql as $$
  select date_trunc('milliseconds', now()) - make_interval(hours => 24 * k) - pg_temp.delta()
$$;
-- First seen yesterday, less than a whole day before now.
create function pg_temp.yesterday_late() returns timestamptz language sql as $$
  select date_trunc('milliseconds', now()) - interval '24 hours' + pg_temp.eps()
$$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$
  select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- Making people through the real functions ---------------------------------------------------------
-- A website visit (session) that starts at t with one event, as the web SDK sends it. Each
-- visitor comes from their own network.
create function pg_temp.web(key_name text, anon text, user_id text, session text, t timestamptz, ctx jsonb,
  event text default 'page_viewed') returns void language plpgsql as $$
declare result jsonb;
begin
  result := public.analytics_ingest(jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.v(key_name), 'sha256'), 'hex'),
    'origin', case when key_name = 'live_key' then 'https://parla.app' end,
    'ip_sha', encode(extensions.digest('network-' || anon, 'sha256'), 'hex'),
    'user_agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1',
    'body', jsonb_strip_nulls(jsonb_build_object(
      'anonymous_id', anon, 'user_id', user_id,
      'session', jsonb_build_object('id', session, 'started_at', pg_temp.iso(t)),
      'context', jsonb_build_object('platform', 'web', 'browser', 'Safari', 'device_type', 'mobile', 'interactions', 3,
        'page_path', '/') || ctx,
      'events', jsonb_build_array(jsonb_build_object('name', event, 'insert_id', session || ':' || event,
        'time', pg_temp.iso(t), 'properties', '{}'::jsonb))))));
  if result->>'stored' is distinct from '1' then
    raise exception 'visit % was not stored: %', session, result;
  end if;
end $$;
-- An app event in its own session, as the app SDKs send it.
create function pg_temp.app(anon text, user_id text, platform text, session text, t timestamptz, event text) returns void
language plpgsql as $$
declare result jsonb;
begin
  result := public.analytics_ingest(jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.v('live_key'), 'sha256'), 'hex'), 'origin', null,
    'ip_sha', encode(extensions.digest('network-' || anon, 'sha256'), 'hex'),
    'body', jsonb_strip_nulls(jsonb_build_object(
      'anonymous_id', anon, 'user_id', user_id,
      'session', jsonb_build_object('id', session, 'started_at', pg_temp.iso(t)),
      'context', jsonb_build_object('platform', platform, 'sdk', 'kma-' || platform || '/1.1.0', 'device_type', 'mobile',
        'os_name', platform, 'app_version', '2.4.0'),
      'events', jsonb_build_array(jsonb_build_object('name', event, 'insert_id', session || ':' || event,
        'time', pg_temp.iso(t), 'properties', '{}'::jsonb))))));
  if result->>'stored' is distinct from '1' then
    raise exception 'app event % was not stored: %', session, result;
  end if;
end $$;
-- An app's first launch, as the analytics-ingest edge function passes it (service role).
create function pg_temp.install(anon text, platform text, t timestamptz, extra jsonb default '{}', key_name text default 'live_key')
returns jsonb language plpgsql as $$
declare
  result jsonb;
  claims text := current_setting('request.jwt.claims', true);
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  result := public.attribution_install(jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.v(key_name), 'sha256'), 'hex'), 'origin', null,
    'body', jsonb_build_object('anonymous_id', anon, 'session_id', 'install-' || anon, 'platform', platform,
      'installed_at', pg_temp.iso(t), 'sdk', 'kma-' || platform || '/1.1.0', 'app_version', '2.4.0') || extra,
    'geo', jsonb_build_object('country', 'NG', 'region', 'Lagos', 'city', 'Lagos', 'source', 'ip'),
    'ip_sha', encode(extensions.digest('network-' || anon, 'sha256'), 'hex'), 'user_agent', 'Parla/2.4.0', 'clock_skew_ms', 0));
  reset role;
  perform set_config('request.jwt.claims', coalesce(claims, ''), true);
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
create function pg_temp.person(anon text) returns uuid language sql as $$
  select id from public.analytics_people where project_id = pg_temp.q('project')
    and (distinct_id = anon or anon = any(anonymous_ids)) limit 1
$$;
-- A payment (or, negative, a refund) written directly, as piece A's intake would write it.
create function pg_temp.pay(anon text, t timestamptz, amount numeric, currency text, label text, env text default 'production')
returns void language sql as $$
  insert into public.attribution_revenue(project_id, person_id, environment, occurred_at, amount, currency, origin, store,
    transaction_id, dedupe_key)
  values (pg_temp.q('project'), pg_temp.person(anon), env, t, amount, currency, 'store', 'revenuecat', label,
    case when amount < 0 then 'refund:' else 'txn:' end || label)
$$;
-- A day's spend written directly, as piece B's console would write it.
create function pg_temp.spend(project uuid, k integer, source text, campaign text, adset text, ad text, amount numeric, currency text)
returns void language sql as $$
  insert into public.attribution_costs(project_id, day, source, campaign, adset, ad, amount, currency, origin)
  values (project, pg_temp.date(k), source, campaign, adset, ad, amount, currency, 'manual')
$$;

-- Reading reports -------------------------------------------------------------------------------
create function pg_temp.roi(input jsonb, project text default 'project') returns jsonb language sql as $$
  select public.attribution_roi(pg_temp.q(project), input)
$$;
create function pg_temp.cohorts(input jsonb, project text default 'project') returns jsonb language sql as $$
  select public.attribution_cohorts(pg_temp.q(project), input)
$$;
create function pg_temp.line(report jsonb, k text) returns jsonb language sql as $$
  select x - 'key' from jsonb_array_elements(report->'rows') x where x->>'key' is not distinct from k
$$;
-- One ROI line as it should read, every figure worked out by hand.
create function pg_temp.m(users integer, installs integer, cost numeric, payers integer, revenue numeric, d0 numeric, d7 numeric,
  d30 numeric, cpi numeric, cost_per_user numeric, cost_per_payer numeric, arpu numeric, roas numeric, roas_d0 numeric,
  roas_d7 numeric, roas_d30 numeric) returns jsonb language sql as $$
  select jsonb_build_object('users', users, 'installs', installs, 'cost', cost, 'payers', payers, 'revenue', revenue,
    'revenue_d0', d0, 'revenue_d7', d7, 'revenue_d30', d30, 'cpi', cpi, 'cost_per_user', cost_per_user,
    'cost_per_payer', cost_per_payer, 'arpu', arpu, 'roas', roas, 'roas_d0', roas_d0, 'roas_d7', roas_d7, 'roas_d30', roas_d30)
$$;
create function pg_temp.cohort(report jsonb, start text) returns jsonb language sql as $$
  select x from jsonb_array_elements(report->'cohorts') x where x->>'start' = start
$$;
create function pg_temp.cell(report jsonb, start text, day integer) returns jsonb language sql as $$
  select c from jsonb_array_elements(pg_temp.cohort(report, start)->'cells') c where (c->>'day')::integer = day
$$;
-- One cohort cell as it should read.
create function pg_temp.c(day integer, state text, complete_users integer, revenue numeric, revenue_per_user numeric, roas numeric,
  returned integer, retention numeric) returns jsonb language sql as $$
  select jsonb_build_object('day', day, 'state', state, 'complete_users', complete_users, 'revenue', revenue,
    'revenue_per_user', revenue_per_user, 'roas', roas, 'returned', returned, 'retention', retention)
$$;
create function pg_temp.point(report jsonb, day integer) returns jsonb language sql as $$
  select x from jsonb_array_elements(report->'curve') x where (x->>'day')::integer = day
$$;
grant all on qa, roi_assertions to authenticated, service_role;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('f9500000-0000-4000-8000-000000000001', 'owner@parla.example.test', now(), '{"full_name":"Ada Owner"}'::jsonb),
  ('f9500000-0000-4000-8000-000000000002', 'analyst@parla.example.test', now(), '{}'),
  ('f9500000-0000-4000-8000-000000000003', 'stranger@elsewhere.example.test', now(), '{}');

-- Closed by default -------------------------------------------------------------------------------
select pg_temp.check((select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
  from unnest(array['public.attribution_roi(uuid,jsonb)', 'public.attribution_cohorts(uuid,jsonb)']) f),
  'members read ROI and cohorts; nobody signed out does');
select pg_temp.check((select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
  from pg_proc p where p.oid in ('public.attribution_roi(uuid,jsonb)'::regprocedure, 'public.attribution_cohorts(uuid,jsonb)'::regprocedure)),
  'the readers run as their owner with an empty search path');
select pg_temp.check((select bool_and(not has_function_privilege(r, f, 'execute'))
  from unnest(array['kma_internal.attribution_acquisitions(uuid,timestamptz,timestamptz)',
    'kma_internal.attribution_people_value(uuid,text,timestamptz,timestamptz)']) f, unnest(array['anon', 'authenticated']) r),
  'the helpers are not callable from outside');

-- A project with attribution on, its links and keys --------------------------------------------------
select pg_temp.as_user('f9500000-0000-4000-8000-000000000001');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Parla', array['ios', 'android', 'web'], 'Africa/Lagos') r)
insert into qa select 'project', r->'project'->>'id' from created
union all select 'live_key', r->'key'->>('to' || 'ken') from created;
insert into qa select 'dev_key', public.analytics_create_key(pg_temp.q('project'), 'Staging', 'client', 'development')->>('to' || 'ken');
insert into qa select 'server_key', public.analytics_create_key(pg_temp.q('project'), 'Backend', 'server', 'production')->>('to' || 'ken');
select public.analytics_update_project(pg_temp.q('project'), '{"allowed_origins":["https://parla.app"]}'::jsonb);
select public.attribution_enable(pg_temp.q('project'), 'parla');
select public.attribution_update(pg_temp.q('project'), '{"android_package":"app.parla","web_url":"https://parla.app/"}'::jsonb);
insert into qa select 'lesson', public.attribution_save_link(pg_temp.q('project'), null,
  '{"name":"Lesson","path":"lesson","source":"tiktok","campaign":"Launch"}')->>'id';
insert into qa select 'story', public.attribution_save_link(pg_temp.q('project'), null,
  '{"name":"Story","path":"story","source":"instagram","campaign":"Spring","adset":"Stories","ad":"Clip-1"}')->>'id';
insert into qa select 'getapp', public.attribution_save_link(pg_temp.q('project'), null,
  '{"name":"Get the app","path":"get-app","source":"website","campaign":"Funnel"}')->>'id';
-- A project with attribution on and nothing in it, and one with attribution off.
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Quiet', array['web'], 'Africa/Lagos') r)
insert into qa select 'quiet', r->'project'->>'id' from created;
select public.attribution_enable(pg_temp.q('quiet'), 'quiet');
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Plain', array['web'], 'Africa/Lagos') r)
insert into qa select 'plain', r->'project'->>'id' from created;
select public.analytics_invite_member(pg_temp.q('workspace'), 'analyst@parla.example.test', 'analyst');
select pg_temp.as_user('f9500000-0000-4000-8000-000000000002');
select public.analytics_bootstrap();
-- Another merchant, with a person, a payment and spend of their own.
select pg_temp.as_user('f9500000-0000-4000-8000-000000000003');
insert into qa select 'rival_workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('rival_workspace'), 'Rival', array['web'], 'Africa/Lagos') r)
insert into qa select 'rival', r->'project'->>'id' from created union all select 'rival_key', r->'key'->>('to' || 'ken') from created;
select public.attribution_enable(pg_temp.q('rival'), 'rival');
select public.analytics_ingest(jsonb_build_object('key_hash', encode(extensions.digest(pg_temp.v('rival_key'), 'sha256'), 'hex'),
  'body', jsonb_build_object('anonymous_id', 'anon-rival', 'session', jsonb_build_object('id', 'rv-1', 'started_at', pg_temp.iso(pg_temp.ago(2))),
    'context', jsonb_build_object('platform', 'web', 'utm', jsonb_build_object('source', 'facebook', 'campaign', 'Spring')),
    'events', jsonb_build_array(jsonb_build_object('name', 'page_viewed', 'insert_id', 'rv-1', 'time', pg_temp.iso(pg_temp.ago(2)))))));
insert into public.attribution_revenue(project_id, person_id, environment, occurred_at, amount, currency, origin, store, dedupe_key)
select pg_temp.q('rival'), id, 'production', pg_temp.ago(2) + interval '1 hour', 900, 'USD', 'store', 'adapty', 'txn:rival-1'
from public.analytics_people where project_id = pg_temp.q('rival');
select pg_temp.spend(pg_temp.q('rival'), 1, 'meta', 'Spring', '', '', 5000, 'USD');
select pg_temp.as_user('f9500000-0000-4000-8000-000000000001');

-- Exchange rates: one euro bought 1.10 dollars from 60 days ago and 1.20 from 10 days ago (UTC
-- days). Every euro amount below is far from the change, so 1.10 or 1.20 applies without doubt.
-- The naira has no ECB rate.
insert into public.attribution_fx_rates(currency, day, per_eur) values
  ('USD', (now() at time zone 'UTC')::date - 60, 1.10), ('USD', (now() at time zone 'UTC')::date - 10, 1.20);

-- The cast -----------------------------------------------------------------------------------------
-- meta_utm, 5 days ago: a visit from a Meta ad (utm_source=facebook, Spring, Video-A), back on
-- days 1 and 3 (on day 3 from a TikTok ad, which changes nothing: the first source stays).
-- Pays $10 on day 0 and 20 euros on day 2 ($24), $4 refunded on day 3: $30.
select pg_temp.web('live_key', 'anon-meta-utm', null, 'mu-1', pg_temp.ago(5),
  '{"utm":{"source":"facebook","campaign":"Spring","content":"Video-A"}}');
select pg_temp.web('live_key', 'anon-meta-utm', null, 'mu-2', pg_temp.ago(5) + interval '25 hours', '{}');
select pg_temp.web('live_key', 'anon-meta-utm', null, 'mu-3', pg_temp.ago(5) + interval '73 hours',
  '{"utm":{"source":"tiktok","campaign":"Launch"}}');
select pg_temp.pay('anon-meta-utm', pg_temp.ago(5) + interval '1 hour', 10, 'USD', 'mu-pay-1');
select pg_temp.pay('anon-meta-utm', pg_temp.ago(5) + interval '49 hours', 20, 'EUR', 'mu-pay-2');
select pg_temp.pay('anon-meta-utm', pg_temp.ago(5) + interval '72 hours', -4, 'USD', 'mu-pay-1');
-- A test purchase from a development build of the same person: never counted.
select pg_temp.pay('anon-meta-utm', pg_temp.ago(5) + interval '1 hour', 1000, 'USD', 'mu-dev', 'development');

-- meta_link, 2 days ago: clicked the Instagram story link (Spring, Stories, Clip-1) and landed on
-- the website. Pays $15 on day 0.
select pg_temp.check(pg_temp.clicks(jsonb_build_array(
  jsonb_build_object('id', 'StoryClick0000000001', 'link_id', pg_temp.v('story'), 'clicked_at', pg_temp.iso(pg_temp.ago(2) - interval '2 minutes'),
    'platform', 'ios', 'in_app', 'instagram', 'destination', 'web'),
  jsonb_build_object('id', 'LessonClick000000001', 'link_id', pg_temp.v('lesson'), 'clicked_at', pg_temp.iso(pg_temp.ago(3) - interval '1 minute'),
    'platform', 'desktop', 'destination', 'web'),
  jsonb_build_object('id', 'LessonClick000000002', 'link_id', pg_temp.v('lesson'), 'clicked_at', pg_temp.iso(pg_temp.ago(3) - interval '30 minutes'),
    'platform', 'android', 'destination', 'play_store'))) = 3, 'the link service records the clicks');
select pg_temp.web('live_key', 'anon-meta-link', null, 'ml-1', pg_temp.ago(2), '{"click":{"kma_lc":"StoryClick0000000001"}}');
select pg_temp.pay('anon-meta-link', pg_temp.ago(2) + interval '30 minutes', 15, 'USD', 'ml-pay-1');

-- meta_fbclid, yesterday but less than a day ago: a direct visit, then one with Facebook's click
-- ID two hours later. Their first visit that came from somewhere is the second: Meta, no campaign.
select pg_temp.web('live_key', 'anon-fbclid', null, 'mf-1', pg_temp.yesterday_late(), '{}');
select pg_temp.web('live_key', 'anon-fbclid', null, 'mf-2', pg_temp.yesterday_late() + interval '2 hours', '{"click":{"fbclid":"IwAR0parla"}}');

-- tiktok_web, 3 days ago: clicked the TikTok lesson link on a computer. Pays 8 euros on day 1 ($9.60).
select pg_temp.web('live_key', 'anon-tt-web', null, 'tw-1', pg_temp.ago(3), '{"click":{"kma_lc":"LessonClick000000001"}}');
select pg_temp.pay('anon-tt-web', pg_temp.ago(3) + interval '25 hours', 8, 'EUR', 'tw-pay-1');

-- tiktok_install, 3 days ago: installed the Android app from the same link (install referrer),
-- opened it on days 0 and 1, and on day 1 visited the website from a Meta retargeting ad, which
-- is later than the install and changes nothing. Pays $9.99 on day 0, refunded on day 1: $0.
insert into qa select 'tt_install', pg_temp.install('anon-tt-app', 'android', pg_temp.ago(3),
  jsonb_build_object('device_key', encode(extensions.digest('android-tt', 'sha256'), 'hex'), 'referrer', 'kma_lc=LessonClick000000002'));
select pg_temp.check(pg_temp.j('tt_install')->>'method' = 'install_referrer' and pg_temp.j('tt_install')->>'source' = 'tiktok',
  'the Android install is matched to the TikTok click by the install referrer');
select pg_temp.app('anon-tt-app', null, 'android', 'ta-1', pg_temp.ago(3) + interval '1 minute', 'app_opened');
select pg_temp.app('anon-tt-app', null, 'android', 'ta-2', pg_temp.ago(3) + interval '25 hours', 'lesson_started');
select pg_temp.web('live_key', 'anon-tt-app', null, 'ta-web', pg_temp.ago(3) + interval '27 hours',
  '{"utm":{"source":"facebook","campaign":"Retarget"}}');
select pg_temp.pay('anon-tt-app', pg_temp.ago(3) + interval '2 hours', 9.99, 'USD', 'ta-pay-1');
select pg_temp.pay('anon-tt-app', pg_temp.ago(3) + interval '24 hours', -9.99, 'USD', 'ta-pay-1');

-- organic, 4 days ago: installed the iPhone app with no link, and has sent nothing since.
select pg_temp.check(pg_temp.install('anon-organic', 'ios', pg_temp.ago(4))->>'method' = 'organic', 'an install without a link is organic');

-- direct, 6 days ago: came from the merchant's own site (no source). On day 2 a scripted browser
-- with a utm_source visited as them; the bot rules leave that visit out, so it is neither their
-- source nor their coming back. Paid 5000 naira (no rate) on day 0, and $77 an hour before they
-- were first seen (before acquisition: ignored).
select pg_temp.web('live_key', 'anon-direct', null, 'dw-1', pg_temp.ago(6), '{"referrer":"https://parla.app/pricing"}');
select pg_temp.web('live_key', 'anon-direct', null, 'dw-2', pg_temp.ago(6) + interval '49 hours', '{"utm":{"source":"spam"},"webdriver":true}');
select pg_temp.pay('anon-direct', pg_temp.ago(6) + interval '1 hour', 5000, 'NGN', 'dw-pay-1');
select pg_temp.pay('anon-direct', pg_temp.ago(6) - interval '1 hour', 77, 'USD', 'dw-pay-0');

-- speaksix, 4 days ago, the pilot's path: a Meta ad (utm_source=fb, SpeakSix-Funnel) to the web
-- funnel, a $29.99 payment on the web, the iPhone app installed the next day through the funnel's
-- "Get the app" smart link and signed in, then signed in on the web too, which folds the web
-- visitor (and their payment) into the app's person. A $29.99 renewal on day 3. Acquired on the
-- first web visit and credited to Meta: the visit came before the install's link.
select pg_temp.web('live_key', 'anon-s6-web', null, 's6-1', pg_temp.ago(4), '{"utm":{"source":"fb","campaign":"SpeakSix-Funnel"}}');
select pg_temp.pay('anon-s6-web', pg_temp.ago(4) + interval '20 minutes', 29.99, 'USD', 's6-pay-1');
select pg_temp.check(pg_temp.install('anon-s6-app', 'ios', pg_temp.ago(4) + interval '26 hours',
  '{"link_url":"https://parla.go.kissmyapps.dev/get-app"}')->>'source' = 'website',
  'the pilot person''s app install is matched to the funnel''s smart link');
select pg_temp.app('anon-s6-app', 'user-s6', 'ios', 's6-app', pg_temp.ago(4) + interval '26 hours 1 minute', 'signed_in');
select pg_temp.web('live_key', 'anon-s6-web', 'user-s6', 's6-2', pg_temp.ago(4) + interval '27 hours', '{}');
select pg_temp.check((select count(*) = 1 from public.analytics_people where project_id = pg_temp.q('project') and user_id = 'user-s6')
  and pg_temp.person('anon-s6-web') = pg_temp.person('anon-s6-app')
  and (select first_seen from public.analytics_people where id = pg_temp.person('user-s6')) = pg_temp.ago(4)
  and exists (select 1 from public.attribution_installs where person_id = pg_temp.person('user-s6'))
  and (select count(*) from public.attribution_revenue where person_id = pg_temp.person('user-s6')) = 1,
  'signing in on both folds the web visitor into the app''s person, with the web payment and the install');
select pg_temp.pay('user-s6', pg_temp.ago(4) + interval '73 hours', 29.99, 'USD', 's6-pay-2');

-- today, just now: a direct visit and a $3 payment.
select pg_temp.web('live_key', 'anon-today', null, 'td-1', pg_temp.ago(0), '{}');
select pg_temp.pay('anon-today', pg_temp.ago(0) + pg_temp.delta() / 2, 3, 'USD', 'td-pay-1');

-- reinstall, yesterday and more than a day ago: the same Android phone as tiktok_install, a new
-- person. A reinstall is not a counted install, and its copied source is not theirs.
select pg_temp.check(pg_temp.install('anon-reinstall', 'android', pg_temp.ago(1),
  jsonb_build_object('device_key', encode(extensions.digest('android-tt', 'sha256'), 'hex')))->>'reinstall' = 'true',
  'the same phone again is a reinstall');
select pg_temp.app('anon-reinstall', null, 'android', 'ri-1', pg_temp.ago(1) + interval '1 minute', 'app_opened');

-- old_meta, 40 days ago (server key): Instagram (Spring), back on days 7 and 30. Pays $50 on day
-- 0, 100 euros on day 10 ($110 at 1.10) and $7 on day 35: $167.
select pg_temp.web('server_key', 'anon-old-meta', null, 'om-1', pg_temp.ago(40), '{"utm":{"source":"instagram","campaign":"Spring"}}');
select pg_temp.web('server_key', 'anon-old-meta', null, 'om-2', pg_temp.ago(40) + interval '7 days 1 hour', '{}');
select pg_temp.web('server_key', 'anon-old-meta', null, 'om-3', pg_temp.ago(40) + interval '30 days 1 hour', '{}');
select pg_temp.pay('anon-old-meta', pg_temp.ago(40) + interval '1 hour', 50, 'USD', 'om-pay-1');
select pg_temp.pay('anon-old-meta', pg_temp.ago(40) + interval '240 hours', 100, 'EUR', 'om-pay-2');
select pg_temp.pay('anon-old-meta', pg_temp.ago(40) + interval '840 hours', 7, 'USD', 'om-pay-3');
-- news, 50 days ago: the newsletter (November). Pays $12 on day 0.
select pg_temp.web('server_key', 'anon-news', null, 'nw-1', pg_temp.ago(50), '{"utm":{"source":"Newsletter","campaign":"November"}}');
select pg_temp.pay('anon-news', pg_temp.ago(50) + interval '1 hour', 12, 'USD', 'nw-pay-1');
-- ancient, 200 days ago: outside every range and cohort frame, whatever they pay now.
select pg_temp.web('server_key', 'anon-ancient', null, 'an-1', pg_temp.ago(200), '{}');
select pg_temp.pay('anon-ancient', pg_temp.ago(2), 40, 'USD', 'an-pay-1');

-- Never counted: a person the merchant marked as a bot, a scripted browser the bot rules catch,
-- and development builds (a visit and an install), each with a payment.
select pg_temp.web('live_key', 'anon-bot', null, 'bt-1', pg_temp.ago(2), '{"utm":{"source":"facebook","campaign":"Spring"}}');
select public.analytics_set_override(pg_temp.q('project'), 'bot', pg_temp.person('anon-bot'));
select pg_temp.pay('anon-bot', pg_temp.ago(2) + interval '1 hour', 100, 'USD', 'bt-pay-1');
select pg_temp.web('live_key', 'anon-robot', null, 'rb-1', pg_temp.ago(2), '{"utm":{"source":"facebook","campaign":"Spring"},"webdriver":true}');
select pg_temp.pay('anon-robot', pg_temp.ago(2) + interval '1 hour', 100, 'USD', 'rb-pay-1');
select pg_temp.web('dev_key', 'anon-dev', null, 'dv-1', pg_temp.ago(1), '{"utm":{"source":"facebook","campaign":"Spring"}}');
select pg_temp.pay('anon-dev', pg_temp.ago(1) + interval '1 hour', 100, 'USD', 'dv-pay-1', 'development');
select pg_temp.pay('anon-dev', pg_temp.ago(1) + interval '2 hours', 100, 'USD', 'dv-pay-2');
select pg_temp.check(pg_temp.install('anon-dev-app', 'ios', pg_temp.ago(1), '{}', 'dev_key')->>'method' = 'organic', 'a development build installs');

-- Spend, by the project's local day. "facebook" is Meta; campaigns match whatever their case.
select pg_temp.spend(pg_temp.q('project'), 3, 'meta', 'Spring', '', '', 100, 'USD');
select pg_temp.spend(pg_temp.q('project'), 2, 'meta', 'Spring', 'Stories', 'Clip-1', 50, 'EUR');   -- $60 at 1.20
select pg_temp.spend(pg_temp.q('project'), 1, 'meta', '', '', '', 30, 'USD');                     -- Meta, no campaign
select pg_temp.spend(pg_temp.q('project'), 2, 'tiktok', 'launch', '', '', 40, 'USD');
select pg_temp.spend(pg_temp.q('project'), 0, 'tiktok', 'Launch', '', '', 5, 'USD');               -- today
select pg_temp.spend(pg_temp.q('project'), 8, 'google_ads', 'Brand', '', '', 25, 'USD');          -- nobody came from it; 30 days, not 7
select pg_temp.spend(pg_temp.q('project'), 5, 'meta', 'Summer', '', '', 2000, 'NGN');             -- no rate
select pg_temp.spend(pg_temp.q('project'), 6, 'facebook', 'Spring', '', '', 10, 'USD');
select pg_temp.spend(pg_temp.q('project'), 40, 'meta', 'Spring', '', '', 200, 'USD');             -- 90 days only
select pg_temp.spend(pg_temp.q('project'), 100, 'meta', 'Spring', '', '', 999, 'USD');            -- outside every range

-- Acquisitions ------------------------------------------------------------------------------------
select pg_temp.as_user(null);
create temporary table acq as
select a.*, (select distinct_id from public.analytics_people where id = a.person_id) who
from kma_internal.attribution_acquisitions(pg_temp.q('project'), pg_temp.date(29)::timestamp at time zone 'Africa/Lagos', now()) a;
select pg_temp.check((select count(*) from acq) = 10
  and not exists (select 1 from acq where who in ('anon-bot', 'anon-robot', 'anon-dev', 'anon-dev-app', 'anon-old-meta', 'anon-news', 'anon-ancient')),
  'ten people were acquired in the last 30 days; bots, development and older people are not among them');
select pg_temp.check((select acquired_at = pg_temp.ago(4) and platform = 'ios' and method = 'utm' and source = 'fb'
    and campaign = 'SpeakSix-Funnel' and adset is null and ad is null and link_id is null and installed from acq where who = 'user-s6'),
  'the pilot person is acquired on their first web visit, credited to the Meta ad, with their iPhone install counted');
select pg_temp.check((select acquired_at = pg_temp.ago(3) and platform = 'android' and method = 'install_referrer' and source = 'tiktok'
    and campaign = 'Launch' and link_id = pg_temp.q('lesson') and installed from acq where who = 'anon-tt-app'),
  'an install with a source before any web visit credits the install''s click');
select pg_temp.check((select platform = 'web' and method = 'link' and source = 'instagram' and campaign = 'Spring' and adset = 'Stories'
    and ad = 'Clip-1' and link_id = pg_temp.q('story') and not installed from acq where who = 'anon-meta-link'),
  'a link click on the website carries the link''s ad set and ad');
select pg_temp.check((select method = 'utm' and source = 'facebook' and campaign = 'Spring' and adset is null and ad = 'Video-A'
    from acq where who = 'anon-meta-utm'), 'UTM tags give the source, campaign and ad (utm_content)');
select pg_temp.check((select acquired_at = pg_temp.yesterday_late() and method = 'click_id' and source = 'meta' and campaign is null
    from acq where who = 'anon-fbclid'), 'the first visit that came from somewhere counts, not the first visit');
select pg_temp.check((select method is null and source is null and platform = 'web' and not installed from acq where who = 'anon-direct'),
  'a visit from the merchant''s own site is direct, and a visit the bot rules leave out is no source');
select pg_temp.check((select method is null and source is null and platform = 'ios' and installed and acquired_at = pg_temp.ago(4)
    from acq where who = 'anon-organic'), 'an organic install counts as an install, with no source');
select pg_temp.check((select source is null and platform = 'android' and not installed from acq where who = 'anon-reinstall'),
  'a reinstall is not a counted install, and the first install''s source stays with the first install');
select pg_temp.check((select count(*) = 3 from acq where installed), 'three counted installs');
select pg_temp.check((select count(*) from kma_internal.attribution_acquisitions(pg_temp.q('project'), pg_temp.ago(40), pg_temp.ago(40) + interval '1 millisecond')) = 1
  and (select count(*) from kma_internal.attribution_acquisitions(pg_temp.q('project'), pg_temp.ago(40) + interval '1 millisecond', now() - interval '7 days')) = 0,
  'people are acquired in [from, to)');
select pg_temp.as_user('f9500000-0000-4000-8000-000000000001');

-- ROI by source, last 30 days ----------------------------------------------------------------------
-- Users 10, installs 3, spend $270 (100 + 60 + 30 + 40 + 5 + 25 + 10; the naira line left out),
-- payers 5 (tiktok_install's refund makes them $0), revenue $117.58, day 0 $67.98.
select pg_temp.keep('sources', pg_temp.roi('{"range":"30d","group":"source"}'));
select pg_temp.capture('roi_sources', pg_temp.j('sources'));
select pg_temp.check(pg_temp.j('sources')->>'currency' = 'USD' and pg_temp.j('sources')->>'range' = '30d'
  and pg_temp.j('sources')->>'from' = pg_temp.d(29) and pg_temp.j('sources')->>'to' = pg_temp.d(0)
  and pg_temp.j('sources')->>'timezone' = 'Africa/Lagos' and pg_temp.j('sources')->>'group' = 'source'
  and pg_temp.j('sources')->'filters' = '{}'::jsonb, 'the report says what it covers, in the project''s days and currency');
select pg_temp.check(pg_temp.j('sources')->'totals' = pg_temp.m(10, 3, 270, 5, 117.58, 67.98, 117.58, 117.58,
  90, 27, 54, 11.76, 0.4355, 0.2518, 0.4355, 0.4355), 'the totals add every person and every converted cost once');
select pg_temp.check((select jsonb_agg(x->'key') from jsonb_array_elements(pg_temp.j('sources')->'rows') x)
  = '["meta", "tiktok", "google_ads", null]'::jsonb, 'rows go by spend, then people, with direct and organic last');
select pg_temp.check(pg_temp.line(pg_temp.j('sources'), 'meta') = pg_temp.m(4, 1, 200, 3, 104.98, 54.99, 104.98, 104.98,
  200, 50, 66.67, 26.25, 0.5249, 0.275, 0.5249, 0.5249),
  'Meta: the UTM visitor, the story link, the click ID and the pilot person; facebook, fb and instagram spend all count');
select pg_temp.check(pg_temp.line(pg_temp.j('sources'), 'tiktok') = pg_temp.m(2, 1, 45, 1, 9.6, 9.99, 9.6, 9.6,
  45, 22.5, 45, 4.8, 0.2133, 0.222, 0.2133, 0.2133),
  'TikTok: the link click and the install; a refund on day 1 takes the day 0 payment back by day 7');
select pg_temp.check(pg_temp.line(pg_temp.j('sources'), 'google_ads') = pg_temp.m(0, 0, 25, 0, 0, 0, 0, 0,
  null, null, null, null, 0, 0, 0, 0), 'spend nobody came from still makes a row');
select pg_temp.check(pg_temp.line(pg_temp.j('sources'), null) = pg_temp.m(4, 1, 0, 1, 3, 3, 3, 3,
  0, 0, 0, 0.75, null, null, null, null), 'direct and organic: no spend, so no ROAS');
select pg_temp.check(pg_temp.j('sources')->'unconverted' = '{"revenue": 1, "cost": 1, "currencies": ["NGN"]}'::jsonb,
  'the naira payment and the naira spend are left out and counted');
select pg_temp.check(pg_temp.j('sources')->'complete' = '{"d0": false, "d7": false, "d30": false}'::jsonb,
  'people acquired less than a day ago leave even day 0 filling');
select pg_temp.check(pg_temp.j('sources')->>'has_costs' = 'true' and pg_temp.j('sources')->>'has_revenue' = 'true',
  'the project has spend and revenue');

-- The last 7 days leave out the Google spend of 8 days ago; the last 90 add the two older people
-- and the spend of 40 days ago, but not that of 100 days ago.
select pg_temp.keep('week', pg_temp.roi('{"range":"7d"}'));
select pg_temp.check(pg_temp.j('week')->'totals' = pg_temp.m(10, 3, 245, 5, 117.58, 67.98, 117.58, 117.58,
  81.67, 24.5, 49, 11.76, 0.4799, 0.2775, 0.4799, 0.4799)
  and pg_temp.j('week')->>'from' = pg_temp.d(6) and pg_temp.j('week')->>'group' = 'source'
  and pg_temp.line(pg_temp.j('week'), 'google_ads') is null, 'the last 7 days, grouped by source by default');
select pg_temp.keep('quarter', pg_temp.roi('{"range":"90d","group":"source"}'));
select pg_temp.check(pg_temp.j('quarter')->'totals' = pg_temp.m(12, 3, 470, 7, 296.58, 129.98, 179.58, 289.58,
  156.67, 39.17, 67.14, 24.72, 0.631, 0.2766, 0.3821, 0.6161), 'the last 90 days');
select pg_temp.check(pg_temp.line(pg_temp.j('quarter'), 'meta') = pg_temp.m(5, 1, 400, 4, 271.98, 104.99, 154.98, 264.98,
  400, 80, 100, 54.4, 0.68, 0.2625, 0.3875, 0.6625)
  and pg_temp.line(pg_temp.j('quarter'), 'newsletter') = pg_temp.m(1, 0, 0, 1, 12, 12, 12, 12, null, 0, 0, 12, null, null, null, null),
  'day 30 revenue stops at day 30 (the euro payment of day 10 at 1.10 is in, the $7 of day 35 is not)');
select pg_temp.check((select jsonb_agg(x->'key') from jsonb_array_elements(pg_temp.j('quarter')->'rows') x)
  = '["meta", "tiktok", "google_ads", "newsletter", null]'::jsonb, 'with no spend, more people come first');

-- Drilling down -------------------------------------------------------------------------------------
select pg_temp.keep('campaigns', pg_temp.roi('{"range":"30d","group":"campaign","source":"meta"}'));
select pg_temp.capture('roi_campaigns', pg_temp.j('campaigns'));
select pg_temp.check(pg_temp.j('campaigns')->'filters' = '{"source": "meta"}'::jsonb
  and pg_temp.j('campaigns')->'totals' = pg_temp.line(pg_temp.j('sources'), 'meta'), 'a source''s campaigns add up to the source');
select pg_temp.check((select jsonb_agg(x->'key') from jsonb_array_elements(pg_temp.j('campaigns')->'rows') x)
  = '["spring", "speaksix-funnel", null]'::jsonb, 'campaign keys are lower case; the unconverted Summer spend makes no row');
select pg_temp.check(pg_temp.line(pg_temp.j('campaigns'), 'spring') = pg_temp.m(2, 0, 170, 2, 45, 25, 45, 45,
  null, 85, 85, 22.5, 0.2647, 0.1471, 0.2647, 0.2647), 'Spring: two people and spend typed as Spring, spring and on facebook');
select pg_temp.check(pg_temp.line(pg_temp.j('campaigns'), 'speaksix-funnel') = pg_temp.m(1, 1, 0, 1, 59.98, 29.99, 59.98, 59.98,
  0, 0, 0, 59.98, null, null, null, null), 'the funnel campaign of the pilot person');
select pg_temp.check(pg_temp.line(pg_temp.j('campaigns'), null) = pg_temp.m(1, 0, 30, 0, 0, 0, 0, 0,
  null, 30, null, 0, 0, 0, 0, 0), 'no campaign: the click ID visitor, with the spend typed without a campaign');
select pg_temp.check(pg_temp.j('campaigns')->'unconverted' = '{"revenue": 0, "cost": 1, "currencies": ["NGN"]}'::jsonb
  and pg_temp.j('campaigns')->'complete' = '{"d0": false, "d7": false, "d30": false}'::jsonb, 'unconverted and complete follow the filter');
select pg_temp.keep('adsets', pg_temp.roi('{"range":"30d","group":"adset","source":"Meta","campaign":"Spring"}'));
select pg_temp.check(pg_temp.j('adsets')->'filters' = '{"source": "meta", "campaign": "spring"}'::jsonb
  and (select jsonb_agg(x->'key') from jsonb_array_elements(pg_temp.j('adsets')->'rows') x) = '["stories", null]'::jsonb
  and pg_temp.line(pg_temp.j('adsets'), 'stories') = pg_temp.m(1, 0, 60, 1, 15, 15, 15, 15, null, 60, 60, 15, 0.25, 0.25, 0.25, 0.25)
  and pg_temp.line(pg_temp.j('adsets'), null) = pg_temp.m(1, 0, 110, 1, 30, 10, 30, 30, null, 110, 110, 30, 0.2727, 0.0909, 0.2727, 0.2727),
  'ad sets: the story link''s, and the UTM visitor with the spend not split by ad set (filters are read as keys)');
select pg_temp.check(pg_temp.j('adsets')->'complete' = '{"d0": true, "d7": false, "d30": false}'::jsonb,
  'both people have had day 0 in full');
select pg_temp.keep('ads', pg_temp.roi('{"range":"30d","group":"ad","source":"meta","campaign":"spring","adset":"stories"}'));
select pg_temp.check(pg_temp.j('ads')->'rows' = jsonb_build_array(pg_temp.m(1, 0, 60, 1, 15, 15, 15, 15, null, 60, 60, 15, 0.25, 0.25, 0.25, 0.25)
  || '{"key": "clip-1"}'), 'the ad of the story ad set');
select pg_temp.keep('ads_null', pg_temp.roi('{"range":"30d","group":"ad","source":"meta","campaign":"spring","adset":null}'));
select pg_temp.check(pg_temp.j('ads_null')->'filters' = '{"source": "meta", "campaign": "spring", "adset": null}'::jsonb
  and pg_temp.j('ads_null')->'rows' = jsonb_build_array(
    pg_temp.m(1, 0, 0, 1, 30, 10, 30, 30, null, 0, 0, 30, null, null, null, null) || '{"key": "video-a"}',
    pg_temp.m(0, 0, 110, 0, 0, 0, 0, 0, null, null, null, null, 0, 0, 0, 0) || '{"key": null}')
  and pg_temp.j('ads_null')->'totals' = pg_temp.m(1, 0, 110, 1, 30, 10, 30, 30, null, 110, 110, 30, 0.2727, 0.0909, 0.2727, 0.2727),
  'a null ad set filter means no ad set: the UTM visitor''s ad, and spend with no ad');
select pg_temp.keep('direct_campaigns', pg_temp.roi('{"range":"30d","group":"campaign","source":null}'));
select pg_temp.check(pg_temp.j('direct_campaigns')->'filters' = '{"source": null}'::jsonb
  and pg_temp.j('direct_campaigns')->'rows' = jsonb_build_array(pg_temp.m(4, 1, 0, 1, 3, 3, 3, 3, 0, 0, 0, 0.75, null, null, null, null)
    || '{"key": null}'), 'a null source filter means direct and organic');

-- By day ---------------------------------------------------------------------------------------------
select pg_temp.keep('days', pg_temp.roi('{"range":"30d","group":"day"}'));
select pg_temp.capture('roi_days', pg_temp.j('days'));
select pg_temp.check(jsonb_array_length(pg_temp.j('days')->'rows') = 30
  and pg_temp.j('days')->'rows'->0->>'key' = pg_temp.d(29) and pg_temp.j('days')->'rows'->29->>'key' = pg_temp.d(0)
  and pg_temp.j('days')->'totals' = pg_temp.j('sources')->'totals', 'one row per day, oldest first, adding up to the same totals');
select pg_temp.check(pg_temp.line(pg_temp.j('days'), pg_temp.d(29)) = pg_temp.m(0, 0, 0, 0, 0, 0, 0, 0, null, null, null, null, null, null, null, null)
  and pg_temp.line(pg_temp.j('days'), pg_temp.d(8)) = pg_temp.m(0, 0, 25, 0, 0, 0, 0, 0, null, null, null, null, 0, 0, 0, 0)
  and pg_temp.line(pg_temp.j('days'), pg_temp.d(6)) = pg_temp.m(1, 0, 10, 0, 0, 0, 0, 0, null, 10, null, 0, 0, 0, 0, 0)
  and pg_temp.line(pg_temp.j('days'), pg_temp.d(5)) = pg_temp.m(1, 0, 0, 1, 30, 10, 30, 30, null, 0, 0, 30, null, null, null, null)
  and pg_temp.line(pg_temp.j('days'), pg_temp.d(4)) = pg_temp.m(2, 2, 0, 1, 59.98, 29.99, 59.98, 59.98, 0, 0, 0, 29.99, null, null, null, null)
  and pg_temp.line(pg_temp.j('days'), pg_temp.d(3)) = pg_temp.m(2, 1, 100, 1, 9.6, 9.99, 9.6, 9.6, 100, 50, 100, 4.8, 0.096, 0.0999, 0.096, 0.096)
  and pg_temp.line(pg_temp.j('days'), pg_temp.d(2)) = pg_temp.m(1, 0, 100, 1, 15, 15, 15, 15, null, 100, 100, 15, 0.15, 0.15, 0.15, 0.15)
  and pg_temp.line(pg_temp.j('days'), pg_temp.d(1)) = pg_temp.m(2, 0, 30, 0, 0, 0, 0, 0, null, 15, null, 0, 0, 0, 0, 0)
  and pg_temp.line(pg_temp.j('days'), pg_temp.d(0)) = pg_temp.m(1, 0, 5, 1, 3, 3, 3, 3, null, 5, 5, 3, 0.6, 0.6, 0.6, 0.6),
  'people by the day they were acquired, spend by its day');
select pg_temp.keep('tiktok_days', pg_temp.roi('{"range":"30d","group":"day","source":"tiktok"}'));
select pg_temp.check(pg_temp.line(pg_temp.j('tiktok_days'), pg_temp.d(3)) = pg_temp.m(2, 1, 0, 1, 9.6, 9.99, 9.6, 9.6, 0, 0, 0, 4.8, null, null, null, null)
  and pg_temp.line(pg_temp.j('tiktok_days'), pg_temp.d(2)) = pg_temp.m(0, 0, 40, 0, 0, 0, 0, 0, null, null, null, null, 0, 0, 0, 0)
  and pg_temp.line(pg_temp.j('tiktok_days'), pg_temp.d(0)) = pg_temp.m(0, 0, 5, 0, 0, 0, 0, 0, null, null, null, null, 0, 0, 0, 0)
  and pg_temp.j('tiktok_days')->'totals' = pg_temp.line(pg_temp.j('sources'), 'tiktok')
  and pg_temp.j('tiktok_days')->'complete' = '{"d0": true, "d7": false, "d30": false}'::jsonb,
  'days take filters too; both TikTok people have had day 0 in full');
select pg_temp.keep('news_days', pg_temp.roi('{"range":"90d","group":"day","source":"newsletter"}'));
select pg_temp.check(jsonb_array_length(pg_temp.j('news_days')->'rows') = 90
  and pg_temp.j('news_days')->'complete' = '{"d0": true, "d7": true, "d30": true}'::jsonb
  and pg_temp.line(pg_temp.j('news_days'), pg_temp.d(50)) = pg_temp.m(1, 0, 0, 1, 12, 12, 12, 12, null, 0, 0, 12, null, null, null, null)
  and pg_temp.j('news_days')->'unconverted' = '{"revenue": 0, "cost": 0, "currencies": []}'::jsonb,
  'someone acquired 50 days ago has had day 30 in full');

-- In euros -------------------------------------------------------------------------------------------
-- $83.98 of dollar payments at 1/1.20 plus 28 euros; $210 of dollar spend at 1/1.20 plus 50 euros.
select public.attribution_update(pg_temp.q('project'), '{"currency":"EUR"}'::jsonb);
select pg_temp.keep('euros', pg_temp.roi('{"range":"30d"}'));
select pg_temp.check(pg_temp.j('euros')->>'currency' = 'EUR'
  and pg_temp.j('euros')->'totals' = pg_temp.m(10, 3, 225, 5, 97.98, 56.65, 97.98, 97.98, 75, 22.5, 45, 9.8, 0.4355, 0.2518, 0.4355, 0.4355),
  'a project in euros sees every amount in euros at the day''s rate');
select public.attribution_update(pg_temp.q('project'), '{"currency":"USD"}'::jsonb);

-- Refusals ---------------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.message(format('select public.attribution_roi(%L, ''{"group":"campaign"}'')', pg_temp.q('project')))
  = 'Choose a source to see its campaigns'
  and pg_temp.message(format('select public.attribution_roi(%L, ''{"group":"adset","source":"meta"}'')', pg_temp.q('project')))
  = 'Choose a source and a campaign to see their ad sets'
  and pg_temp.message(format('select public.attribution_roi(%L, ''{"group":"ad","source":"meta","campaign":"spring"}'')', pg_temp.q('project')))
  = 'Choose a source, a campaign and an ad set to see their ads'
  and pg_temp.fails(format('select public.attribution_roi(%L, ''{"group":"adset","source":null,"campaign":null}'')', pg_temp.q('project'))) = 'ok',
  'campaigns need a source, ad sets a campaign too, ads an ad set too (null filters count as given)');
select pg_temp.check(pg_temp.fails(format('select public.attribution_roi(%L, ''{"range":"today"}'')', pg_temp.q('project'))) = '22023 invalid_input'
  and pg_temp.fails(format('select public.attribution_roi(%L, ''{"group":"week"}'')', pg_temp.q('project'))) = '22023 invalid_input'
  and pg_temp.fails(format('select public.attribution_roi(%L, ''{"campain":"spring"}'')', pg_temp.q('project'))) = '22023 invalid_input'
  and pg_temp.fails(format('select public.attribution_roi(%L, ''{"source":5}'')', pg_temp.q('project'))) = '22023 invalid_input'
  and pg_temp.fails(format('select public.attribution_roi(%L, ''[]'')', pg_temp.q('project'))) = '22023 invalid_input'
  and pg_temp.message(format('select public.attribution_roi(%L, ''{"range":"1y"}'')', pg_temp.q('project'))) = 'Choose 7, 30 or 90 days',
  'ranges are 7, 30 or 90 days; groups, options and filters are checked');
select pg_temp.check(pg_temp.fails(format('select public.attribution_cohorts(%L, ''{"interval":"year"}'')', pg_temp.q('project'))) = '22023 invalid_input'
  and pg_temp.fails(format('select public.attribution_cohorts(%L, ''{"adset":"stories"}'')', pg_temp.q('project'))) = '22023 invalid_input'
  and pg_temp.fails(format('select public.attribution_cohorts(%L, ''{"campaign":["a"]}'')', pg_temp.q('project'))) = '22023 invalid_input',
  'cohorts check their options too');
select pg_temp.check(pg_temp.message(format('select public.attribution_roi(%L, ''{}'')', pg_temp.q('plain'))) = 'Turn on attribution for this project first'
  and pg_temp.message(format('select public.attribution_cohorts(%L, ''{}'')', pg_temp.q('plain'))) = 'Turn on attribution for this project first',
  'a project without attribution is told to turn it on');

-- Roles and other workspaces ---------------------------------------------------------------------------
select pg_temp.as_user('f9500000-0000-4000-8000-000000000002');
select pg_temp.check(pg_temp.roi('{"range":"30d","group":"source"}') = pg_temp.j('sources')
  and pg_temp.fails(format('select public.attribution_cohorts(%L, ''{}'')', pg_temp.q('project'))) = 'ok', 'analysts read both');
select pg_temp.check(pg_temp.fails(format('select public.attribution_roi(%L, ''{}'')', pg_temp.q('rival'))) = 'P0002 Workspace not found',
  'another merchant''s project is not found');
select pg_temp.as_user('f9500000-0000-4000-8000-000000000003');
select pg_temp.check(pg_temp.fails(format('select public.attribution_roi(%L, ''{}'')', pg_temp.q('project'))) = 'P0002 Workspace not found'
  and pg_temp.fails(format('select public.attribution_cohorts(%L, ''{}'')', pg_temp.q('project'))) = 'P0002 Workspace not found',
  'someone from another workspace reads neither');
select pg_temp.check((pg_temp.roi('{"range":"30d"}', 'rival')->'totals'->>'users') = '1'
  and (pg_temp.roi('{"range":"30d"}', 'rival')->'totals'->>'revenue') = '900'
  and (pg_temp.roi('{"range":"30d"}', 'rival')->'totals'->>'cost') = '5000', 'the other merchant sees only their own');
select pg_temp.as_user(null);
select pg_temp.check(pg_temp.fails(format('select public.attribution_roi(%L, ''{}'')', pg_temp.q('project'))) like '42501%',
  'nobody signed in reads nothing');
select pg_temp.as_user('f9500000-0000-4000-8000-000000000001');

-- Nothing yet --------------------------------------------------------------------------------------------
select pg_temp.keep('roi_empty', pg_temp.roi('{"range":"30d","group":"source"}', 'quiet'));
select pg_temp.capture('roi_empty', pg_temp.j('roi_empty'));
select pg_temp.check(pg_temp.j('roi_empty')->'rows' = '[]'::jsonb
  and pg_temp.j('roi_empty')->'totals' = pg_temp.m(0, 0, 0, 0, 0, 0, 0, 0, null, null, null, null, null, null, null, null)
  and pg_temp.j('roi_empty')->'complete' = '{"d0": true, "d7": true, "d30": true}'::jsonb
  and pg_temp.j('roi_empty')->'unconverted' = '{"revenue": 0, "cost": 0, "currencies": []}'::jsonb
  and pg_temp.j('roi_empty')->>'has_costs' = 'false' and pg_temp.j('roi_empty')->>'has_revenue' = 'false',
  'a project with nothing yet: no rows, zeros, and it says there is no spend or revenue');
select pg_temp.check(jsonb_array_length(pg_temp.roi('{"range":"7d","group":"day"}', 'quiet')->'rows') = 7, 'days are listed even when empty');

-- Cohorts by day ------------------------------------------------------------------------------------------
select pg_temp.keep('cohorts_day', pg_temp.cohorts('{"interval":"day"}'));
select pg_temp.capture('cohorts_day', pg_temp.j('cohorts_day'));
select pg_temp.check(pg_temp.j('cohorts_day')->>'currency' = 'USD' and pg_temp.j('cohorts_day')->>'interval' = 'day'
  and pg_temp.j('cohorts_day')->>'timezone' = 'Africa/Lagos' and pg_temp.j('cohorts_day')->>'today' = pg_temp.d(0)
  and pg_temp.j('cohorts_day')->'filters' = '{}'::jsonb and pg_temp.j('cohorts_day')->'days' = '[0, 1, 3, 7, 14, 30, 60, 90]'::jsonb,
  'the cohort table says what it covers');
select pg_temp.check(jsonb_array_length(pg_temp.j('cohorts_day')->'cohorts') = 30
  and (select bool_and((x->>'start')::date = pg_temp.date((i - 1)::integer) and jsonb_array_length(x->'cells') = 8)
    from jsonb_array_elements(pg_temp.j('cohorts_day')->'cohorts') with ordinality c(x, i)),
  'the last 30 days, today first, each with 8 cells');
select pg_temp.check(pg_temp.j('cohorts_day')->'totals' = '{"users": 10, "cost": 270, "revenue": 117.58, "payers": 5}'::jsonb
  and pg_temp.j('cohorts_day')->'unconverted' = '{"revenue": 1, "cost": 1, "currencies": ["NGN"]}'::jsonb,
  'the totals of the last 30 days');
select pg_temp.check((select jsonb_agg(jsonb_build_array(x->>'start', x->'users', x->'cost') order by x->>'start' desc)
    from jsonb_array_elements(pg_temp.j('cohorts_day')->'cohorts') x where (x->>'users')::integer > 0 or (x->>'cost')::numeric > 0)
  = jsonb_build_array(jsonb_build_array(pg_temp.d(0), 1, 5), jsonb_build_array(pg_temp.d(1), 2, 30), jsonb_build_array(pg_temp.d(2), 1, 100),
    jsonb_build_array(pg_temp.d(3), 2, 100), jsonb_build_array(pg_temp.d(4), 2, 0), jsonb_build_array(pg_temp.d(5), 1, 0),
    jsonb_build_array(pg_temp.d(6), 1, 10), jsonb_build_array(pg_temp.d(8), 0, 25)),
  'people and spend by day; a day with spend and nobody is still listed');
select pg_temp.check(pg_temp.cohort(pg_temp.j('cohorts_day'), pg_temp.d(0))->'cells' = jsonb_build_array(
    pg_temp.c(0, 'future', 0, 3, 3, 0.6, 0, null), pg_temp.c(1, 'future', 0, 3, 3, 0.6, 0, null), pg_temp.c(3, 'future', 0, 3, 3, 0.6, 0, null),
    pg_temp.c(7, 'future', 0, 3, 3, 0.6, 0, null), pg_temp.c(14, 'future', 0, 3, 3, 0.6, 0, null), pg_temp.c(30, 'future', 0, 3, 3, 0.6, 0, null),
    pg_temp.c(60, 'future', 0, 3, 3, 0.6, 0, null), pg_temp.c(90, 'future', 0, 3, 3, 0.6, 0, null)),
  'today''s cohort: every day still to come, revenue so far shown');
select pg_temp.check(pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(1), 0) = pg_temp.c(0, 'partial', 1, 0, 0, 0, 1, 1)
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(1), 1) = pg_temp.c(1, 'future', 0, 0, 0, 0, 0, null),
  'yesterday: one person has had day 0 in full and came back on it, the other not yet (their day 0 events wait)');
select pg_temp.check(pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(2), 0) = pg_temp.c(0, 'complete', 1, 15, 15, 0.15, 1, 1)
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(2), 1) = pg_temp.c(1, 'complete', 1, 15, 15, 0.15, 0, 0)
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(2), 3) = pg_temp.c(3, 'future', 0, 15, 15, 0.15, 0, null), '2 days ago');
select pg_temp.check(pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(3), 0) = pg_temp.c(0, 'complete', 2, 9.99, 4.995, 0.0999, 2, 1)
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(3), 1) = pg_temp.c(1, 'complete', 2, 9.6, 4.8, 0.096, 1, 0.5)
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(3), 3) = pg_temp.c(3, 'future', 0, 9.6, 4.8, 0.096, 0, null),
  '3 days ago: revenue is cumulative and refunds subtract; the app person came back on day 1');
select pg_temp.check(pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(4), 0) = pg_temp.c(0, 'complete', 2, 29.99, 14.995, null, 1, 0.5)
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(4), 1) = pg_temp.c(1, 'complete', 2, 29.99, 14.995, null, 1, 0.5)
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(4), 3) = pg_temp.c(3, 'complete', 2, 59.98, 29.99, null, 0, 0)
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(4), 7) = pg_temp.c(7, 'future', 0, 59.98, 29.99, null, 0, null),
  '4 days ago: an install with no events never comes back; no spend, no ROAS');
select pg_temp.check(pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(5), 0) = pg_temp.c(0, 'complete', 1, 10, 10, null, 1, 1)
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(5), 1) = pg_temp.c(1, 'complete', 1, 10, 10, null, 1, 1)
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(5), 3) = pg_temp.c(3, 'complete', 1, 30, 30, null, 1, 1),
  '5 days ago: the naira spend that day is left out, so no ROAS');
select pg_temp.check(pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(6), 0) = pg_temp.c(0, 'complete', 1, 0, 0, 0, 1, 1)
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(6), 1) = pg_temp.c(1, 'complete', 1, 0, 0, 0, 0, 0)
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(6), 3) = pg_temp.c(3, 'complete', 1, 0, 0, 0, 0, 0),
  '6 days ago: the unconverted payment counts nothing');
select pg_temp.check((select jsonb_agg(c->>'state' order by (c->>'day')::integer) from jsonb_array_elements(pg_temp.cohort(pg_temp.j('cohorts_day'), pg_temp.d(8))->'cells') c)
    = '["complete", "complete", "complete", "partial", "future", "future", "future", "future"]'::jsonb
  and pg_temp.cell(pg_temp.j('cohorts_day'), pg_temp.d(8), 0) = pg_temp.c(0, 'complete', 0, 0, null, 0, 0, null)
  and (select jsonb_agg(c->>'state' order by (c->>'day')::integer) from jsonb_array_elements(pg_temp.cohort(pg_temp.j('cohorts_day'), pg_temp.d(29))->'cells') c)
    = '["complete", "complete", "complete", "complete", "complete", "future", "future", "future"]'::jsonb,
  'a cohort nobody joined takes its states from its dates');
select pg_temp.check((select jsonb_agg(x order by (x->>'day')::integer) from jsonb_array_elements(pg_temp.j('cohorts_day')->'curve') x
    where (x->>'day')::integer <= 6) = '[
    {"day": 0, "users": 8, "revenue_per_user": 8.1225, "retention": 0.875},
    {"day": 1, "users": 7, "revenue_per_user": 9.2271, "retention": 0.4286},
    {"day": 2, "users": 6, "revenue_per_user": 12.265, "retention": 0},
    {"day": 3, "users": 4, "revenue_per_user": 22.495, "retention": 0.25},
    {"day": 4, "users": 2, "revenue_per_user": 15, "retention": 0},
    {"day": 5, "users": 1, "revenue_per_user": 0, "retention": 0},
    {"day": 6, "users": 0, "revenue_per_user": null, "retention": null}]'::jsonb
  and jsonb_array_length(pg_temp.j('cohorts_day')->'curve') = 31
  and pg_temp.point(pg_temp.j('cohorts_day'), 30) = '{"day": 30, "users": 0, "revenue_per_user": null, "retention": null}'::jsonb,
  'the curve averages each day over the people who have had it in full (the scripted visit on day 2 is not coming back)');

select pg_temp.keep('cohorts_meta', pg_temp.cohorts('{"interval":"day","source":"meta"}'));
select pg_temp.check(pg_temp.j('cohorts_meta')->'filters' = '{"source": "meta"}'::jsonb
  and pg_temp.j('cohorts_meta')->'totals' = '{"users": 4, "cost": 200, "revenue": 104.98, "payers": 3}'::jsonb
  and pg_temp.cohort(pg_temp.j('cohorts_meta'), pg_temp.d(3))->'users' = '0' and pg_temp.cohort(pg_temp.j('cohorts_meta'), pg_temp.d(3))->'cost' = '100'
  and pg_temp.cell(pg_temp.j('cohorts_meta'), pg_temp.d(2), 0) = pg_temp.c(0, 'complete', 1, 15, 15, 0.25, 1, 1)
  and pg_temp.cell(pg_temp.j('cohorts_meta'), pg_temp.d(1), 0) = pg_temp.c(0, 'future', 0, 0, 0, 0, 0, null)
  and pg_temp.point(pg_temp.j('cohorts_meta'), 1) = '{"day": 1, "users": 3, "revenue_per_user": 18.33, "retention": 0.6667}'::jsonb
  and pg_temp.point(pg_temp.j('cohorts_meta'), 3) = '{"day": 3, "users": 2, "revenue_per_user": 44.99, "retention": 0.5}'::jsonb,
  'cohorts of one source, with that source''s spend');
select pg_temp.keep('cohorts_meta_none', pg_temp.cohorts('{"source":"meta","campaign":null}'));
select pg_temp.check(pg_temp.j('cohorts_meta_none')->'filters' = '{"source": "meta", "campaign": null}'::jsonb
  and pg_temp.j('cohorts_meta_none')->>'interval' = 'day'
  and pg_temp.j('cohorts_meta_none')->'totals' = '{"users": 1, "cost": 30, "revenue": 0, "payers": 0}'::jsonb
  and pg_temp.j('cohorts_meta_none')->'unconverted' = '{"revenue": 0, "cost": 0, "currencies": []}'::jsonb,
  'a null campaign filter means no campaign (by day when no interval is given)');

-- Cohorts by week and month -----------------------------------------------------------------------------
-- Which week or month each person falls in depends on the date the suite runs, so the expected
-- counts are worked out from the cast: the local day each was acquired (k days ago), and the
-- last day each has had in full (complete_k - 1).
create temporary table cast_k(who text, k integer, complete_k integer);
insert into cast_k values ('meta_utm', 5, 5), ('meta_link', 2, 2), ('meta_fbclid', 1, 0), ('tiktok_web', 3, 3),
  ('tiktok_install', 3, 3), ('organic', 4, 4), ('direct', 6, 6), ('speaksix', 4, 4), ('today', 0, 0), ('reinstall', 1, 1),
  ('old_meta', 40, 40), ('news', 50, 50);
select pg_temp.keep('cohorts_week', pg_temp.cohorts('{"interval":"week"}'));
select pg_temp.capture('cohorts_week', pg_temp.j('cohorts_week'));
select pg_temp.check(jsonb_array_length(pg_temp.j('cohorts_week')->'cohorts') = 12
  and (select bool_and((x->>'start')::date = date_trunc('week', pg_temp.date(0))::date - 7 * (i - 1)::integer
      and extract(isodow from (x->>'start')::date) = 1)
    from jsonb_array_elements(pg_temp.j('cohorts_week')->'cohorts') with ordinality c(x, i)),
  'the last 12 weeks, from Monday, this week first');
select pg_temp.check(pg_temp.j('cohorts_week')->'totals' = '{"users": 12, "cost": 470, "revenue": 296.58, "payers": 7}'::jsonb,
  'twelve weeks hold everyone but the 200-day-old person, and the spend of 40 days ago but not of 100');
select pg_temp.check((select bool_and((x->>'users')::integer = (select count(*) from cast_k ck
      where date_trunc('week', pg_temp.date(ck.k))::date = (x->>'start')::date)
    and (select bool_and((ce->>'complete_users')::integer = (select count(*) from cast_k ck
        where date_trunc('week', pg_temp.date(ck.k))::date = (x->>'start')::date and ck.complete_k >= (ce->>'day')::integer + 1)
      and (ce->>'state' = case when (x->>'users')::integer = 0 then ce->>'state'
        when (ce->>'complete_users')::integer = (x->>'users')::integer then 'complete'
        when (ce->>'complete_users')::integer = 0 then 'future' else 'partial' end))
      from jsonb_array_elements(x->'cells') ce))
  from jsonb_array_elements(pg_temp.j('cohorts_week')->'cohorts') x), 'each week has the people acquired in it, each cell the right state');
select pg_temp.check(pg_temp.cohort(pg_temp.j('cohorts_week'), to_char(date_trunc('week', pg_temp.date(40)), 'YYYY-MM-DD'))->'cells' = jsonb_build_array(
    pg_temp.c(0, 'complete', 1, 50, 50, 0.25, 1, 1), pg_temp.c(1, 'complete', 1, 50, 50, 0.25, 0, 0),
    pg_temp.c(3, 'complete', 1, 50, 50, 0.25, 0, 0), pg_temp.c(7, 'complete', 1, 50, 50, 0.25, 1, 1),
    pg_temp.c(14, 'complete', 1, 160, 160, 0.8, 0, 0), pg_temp.c(30, 'complete', 1, 160, 160, 0.8, 1, 1),
    pg_temp.c(60, 'future', 0, 167, 167, 0.835, 0, null), pg_temp.c(90, 'future', 0, 167, 167, 0.835, 0, null)),
  'the week of 40 days ago: one person, $200 of spend, back on days 7 and 30');
select pg_temp.check((select jsonb_agg(c->>'state' order by (c->>'day')::integer) from jsonb_array_elements(pg_temp.j('cohorts_week')->'cohorts'->11->'cells') c)
  = '["complete", "complete", "complete", "complete", "complete", "complete", "complete", "future"]'::jsonb,
  'the oldest week nobody joined: day 60 has passed for any day of it, day 90 for none');
select pg_temp.check(pg_temp.point(pg_temp.j('cohorts_week'), 0) = '{"day": 0, "users": 10, "revenue_per_user": 12.698, "retention": 0.9}'::jsonb
  and pg_temp.point(pg_temp.j('cohorts_week'), 7) = '{"day": 7, "users": 2, "revenue_per_user": 31, "retention": 0.5}'::jsonb
  and pg_temp.point(pg_temp.j('cohorts_week'), 30) = '{"day": 30, "users": 2, "revenue_per_user": 86, "retention": 0.5}'::jsonb,
  'the weekly curve includes the older people');

select pg_temp.keep('cohorts_month', pg_temp.cohorts('{"interval":"month"}'));
select pg_temp.check(jsonb_array_length(pg_temp.j('cohorts_month')->'cohorts') = 6
  and (select bool_and((x->>'start')::date = (date_trunc('month', pg_temp.date(0)) - make_interval(months => (i - 1)::integer))::date)
    from jsonb_array_elements(pg_temp.j('cohorts_month')->'cohorts') with ordinality c(x, i))
  and pg_temp.j('cohorts_month')->'totals' = '{"users": 12, "cost": 1469, "revenue": 296.58, "payers": 7}'::jsonb
  and (select bool_and((x->>'users')::integer = (select count(*) from cast_k ck
      where date_trunc('month', pg_temp.date(ck.k))::date = (x->>'start')::date))
    from jsonb_array_elements(pg_temp.j('cohorts_month')->'cohorts') x),
  'the last 6 months, this month first, with the spend of 100 days ago too');

select pg_temp.keep('cohorts_empty', pg_temp.cohorts('{"interval":"day"}', 'quiet'));
select pg_temp.capture('cohorts_empty', pg_temp.j('cohorts_empty'));
select pg_temp.check(jsonb_array_length(pg_temp.j('cohorts_empty')->'cohorts') = 30
  and (select bool_and(x->'users' = '0' and x->'cost' = '0') from jsonb_array_elements(pg_temp.j('cohorts_empty')->'cohorts') x)
  and pg_temp.cell(pg_temp.j('cohorts_empty'), pg_temp.d(0), 0) = pg_temp.c(0, 'future', 0, 0, null, null, 0, null)
  and pg_temp.cell(pg_temp.j('cohorts_empty'), pg_temp.d(1), 0) = pg_temp.c(0, 'partial', 0, 0, null, null, 0, null)
  and pg_temp.cell(pg_temp.j('cohorts_empty'), pg_temp.d(2), 0) = pg_temp.c(0, 'complete', 0, 0, null, null, 0, null)
  and (select bool_and(x->'users' = '0' and x->'revenue_per_user' = 'null' and x->'retention' = 'null')
    from jsonb_array_elements(pg_temp.j('cohorts_empty')->'curve') x)
  and pg_temp.j('cohorts_empty')->'totals' = '{"users": 0, "cost": 0, "revenue": 0, "payers": 0}'::jsonb,
  'a project with nothing yet: every cohort listed and empty');

-- Bot marks change the numbers when they change -------------------------------------------------------
-- Marking the scripted browser as human brings them in (Meta, Spring, $100 on day 0); blocking the
-- network of today's visitor takes them out.
select public.analytics_set_override(pg_temp.q('project'), 'human', pg_temp.person('anon-robot'));
select pg_temp.check(pg_temp.roi('{"range":"30d"}')->'totals' = pg_temp.m(11, 3, 270, 6, 217.58, 167.98, 217.58, 217.58,
  90, 24.55, 45, 19.78, 0.8059, 0.6221, 0.8059, 0.8059), 'someone marked human counts whatever the bot rules say');
select public.analytics_set_override(pg_temp.q('project'), 'bot', null,
  (select id from public.analytics_sessions where project_id = pg_temp.q('project') and session_key = 'td-1'));
select pg_temp.check(pg_temp.roi('{"range":"30d"}')->'totals' = pg_temp.m(10, 3, 270, 5, 214.58, 164.98, 214.58, 214.58,
  90, 27, 54, 21.46, 0.7947, 0.611, 0.7947, 0.7947), 'a person whose only visits come from a blocked network is left out');

-- Day boundaries -----------------------------------------------------------------------------------
-- old_meta pays $2 in the last minute of day 7 and $1 at the very start of day 8. Over 90 days, with
-- the robot now in (+$100 on day 0) and today's visitor out (-$3 on day 0): revenue 296.58 + 97 + 3,
-- day 0 129.98 + 97, day 7 179.58 + 97 + 2, day 30 289.58 + 97 + 3.
select pg_temp.pay('anon-old-meta', pg_temp.ago(40) + interval '191 hours 59 minutes', 2, 'USD', 'om-pay-4');
select pg_temp.pay('anon-old-meta', pg_temp.ago(40) + interval '192 hours', 1, 'USD', 'om-pay-5');
select pg_temp.check(pg_temp.roi('{"range":"90d"}')->'totals' = pg_temp.m(12, 3, 470, 7, 396.58, 226.98, 278.58, 389.58,
  156.67, 39.17, 67.14, 33.05, 0.8438, 0.4829, 0.5927, 0.8289), 'day 7 ends 192 hours after the acquisition');
select pg_temp.check((select jsonb_agg(jsonb_build_array(ce->'day', ce->'revenue', ce->'roas') order by (ce->>'day')::integer)
    from jsonb_array_elements(pg_temp.cohort(pg_temp.cohorts('{"interval":"week"}'),
      to_char(date_trunc('week', pg_temp.date(40)), 'YYYY-MM-DD'))->'cells') ce)
  = '[[0, 50, 0.25], [1, 50, 0.25], [3, 50, 0.25], [7, 52, 0.26], [14, 163, 0.815], [30, 163, 0.815], [60, 170, 0.85], [90, 170, 0.85]]'::jsonb,
  'a cohort cell for day 7 counts what was paid up to the end of day 7, not after');

select 'ok ' || count(*) || ' attribution roi assertions' from roi_assertions;
rollback;
