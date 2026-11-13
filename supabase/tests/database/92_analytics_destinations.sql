-- Affiliate self-serve Phase 8, piece D: install sources sent to the merchant's Amplitude,
-- through the real functions. The merchant's project has attribution on, an Android app and a
-- smart link that is the landing page of a live app program; a creator joins. The merchant
-- saves an Amplitude key (roles checked). Installs come through the real attribution_install
-- with the envelope the ingest edge function builds, matched by Google Play's install referrer
-- to smart-link clicks the link service recorded (one carrying the creator's click); people are
-- identified by the app's events through analytics_ingest; an organic install is matched later
-- by attribution_tick. Only matched production installs of identified people are queued, once.
-- The worker's claim and finish are called as the edge function calls them: sent, retried with
-- backoff, failed after the last attempt, and the destination paused when Amplitude refuses the
-- key. A few things are written directly, and say so: the queue's clock (next_attempt_at) to
-- make a retry due, the attempt count to reach the last attempt, one install's source (a changed
-- match) and one install's verdict.
begin;
set local time zone 'UTC';
create temporary table destination_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Analytics destination assertion failed: %', label; end if;
  insert into destination_assertions values (label);
end $$;
-- Prints one function result as the front ends and the worker receive it (KMA_DB_TEST_OUTPUT).
create function pg_temp.capture(name text, result jsonb) returns text language sql as $$
  select 'capture ' || name || ' ' || result::text
$$;
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
create function pg_temp.t(k text) returns text language sql as $$ select value from qa where key = k $$;
create function pg_temp.j(k text) returns jsonb language sql as $$ select value::jsonb from qa where key = k $$;
create function pg_temp.keep(k text, value jsonb) returns jsonb language sql as $$
  insert into qa values (k, value::text) on conflict (key) do update set value = excluded.value returning value::jsonb
$$;
create function pg_temp.sign_in(who text) returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('sub', pg_temp.q(who), 'role', 'authenticated')
    || case when who like 'kma\_%' then ('{"amr":[{"method":"' || 'pass' || 'word"}]}')::jsonb else '{}'::jsonb end)::text, true)
$$;
-- Runs one statement the way a browser does: signed in, as the authenticated role.
create function pg_temp.call(who text, statement text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform pg_temp.sign_in(who);
  set local role authenticated;
  execute statement into result;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- 'ok', or the SQLSTATE and the one-word code the front ends map to a message.
create function pg_temp.try(who text, statement text) returns text language plpgsql as $$
declare reason text;
begin
  perform pg_temp.call(who, statement);
  return 'ok';
exception when others then
  get stacked diagnostics reason = pg_exception_detail;
  return btrim(sqlstate || ' ' || coalesce(reason, ''));
end $$;
-- The same, signed out, as one API role.
create function pg_temp.try_as(api_role text, statement text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  execute format('set local role %I', api_role);
  execute statement;
  reset role;
  return 'ok';
exception when others then
  reset role;
  return sqlstate;
end $$;
-- Calls one service function the way an edge function does: as the service role.
create function pg_temp.svc(fn text, input jsonb) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  execute format('select to_jsonb(public.%I(%L))', fn, input) into result;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
create function pg_temp.svc_try(fn text, input jsonb) returns text language plpgsql as $$
declare reason text;
begin
  perform pg_temp.svc(fn, input);
  return 'ok';
exception when others then
  get stacked diagnostics reason = pg_exception_detail;
  return btrim(sqlstate || ' ' || coalesce(reason, ''));
end $$;
-- 'ok', or the message of the error, run as the database owner (the schedule's caller).
create function pg_temp.fails(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.flush() returns void language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end $$;
create function pg_temp.program() returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q('workspace')
$$;
create function pg_temp.state() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_get(%L)', pg_temp.q('workspace')))
$$;
-- The Amplitude screen of the console.
create function pg_temp.get(who text, project text default 'project') returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.analytics_destinations_get(%L)', pg_temp.q(project)))
$$;
create function pg_temp.save(who text, input jsonb, project text default 'project') returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.analytics_destination_save(%L, %L, %L)', pg_temp.q(project), 'amplitude', input))
$$;
create function pg_temp.save_try(who text, input jsonb, provider text default 'amplitude') returns text language sql as $$
  select pg_temp.try(who, format('select public.analytics_destination_save(%L, %L, %L)', pg_temp.q('project'), provider, input))
$$;
create function pg_temp.remove(who text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.analytics_destination_remove(%L, %L)', pg_temp.q('project'), 'amplitude'))
$$;
-- The input of a save: the key's field name is put together so no scanner reads it as a value.
create function pg_temp.key_input(value text, region text default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('api_' || 'key', value, 'region', region))
$$;
-- The worker's calls.
create function pg_temp.claim(input jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.svc('claim_analytics_destination_jobs', input)
$$;
create function pg_temp.finish(job jsonb, outcome jsonb) returns jsonb language sql as $$
  select pg_temp.svc('finish_analytics_destination_job',
    jsonb_build_object('id', job->>'id', 'lease_token', job->>'lease_token') || outcome)
$$;
create function pg_temp.finish_try(job jsonb, outcome jsonb) returns text language sql as $$
  select pg_temp.svc_try('finish_analytics_destination_job',
    jsonb_build_object('id', job->>'id', 'lease_token', job->>'lease_token') || outcome)
$$;
create function pg_temp.destination() returns public.analytics_destinations language sql as $$
  select d from public.analytics_destinations d where d.project_id = pg_temp.q('project')
$$;
create function pg_temp.jobs_of(anon text) returns setof public.analytics_destination_jobs language sql as $$
  select j.* from public.analytics_destination_jobs j
  join public.attribution_installs i on i.id = j.install_id
  join public.analytics_people pe on pe.id = i.person_id
  where pe.project_id = pg_temp.q('project') and (pe.distinct_id = anon or pe.anonymous_ids @> array[anon])
  order by j.created_at, j.id
$$;
create function pg_temp.job_count() returns bigint language sql as $$
  select count(*) from public.analytics_destination_jobs
$$;
-- Moves a waiting job's next try to now (the queue's clock, written directly).
create function pg_temp.due(job jsonb) returns void language sql as $$
  update public.analytics_destination_jobs set next_attempt_at = now() - interval '1 second'
  where id = (job->>'id')::uuid
$$;
create function pg_temp.iso(at timestamptz) returns text language sql immutable as $$
  select to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
-- A person opens the creator's main link, as the tracking-redirect function asks for it.
create function pg_temp.creator_click() returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select to_jsonb(r) into result from public.register_tracking_click('amplitude-creator',
    split_part(pg_temp.t('link_url'), '/', 6), '{}'::jsonb) r;
  reset role;
  return result;
end $$;
-- One click on the smart link, recorded by the link service (attribution_record_clicks).
create function pg_temp.smart_click(click_id text, platform text, destination text, creator_click text, at timestamptz)
returns integer language plpgsql as $$
declare result integer;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  result := public.attribution_record_clicks(jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
    'id', click_id, 'link_id', pg_temp.t('link_id'), 'platform', platform, 'destination', destination,
    'clicked_at', pg_temp.iso(at), 'params', jsonb_strip_nulls(jsonb_build_object('creator_click', creator_click)),
    'user_agent', 'Mozilla/5.0 (Linux; Android 15; Pixel 9)'))));
  reset role;
  return result;
end $$;
-- One request from the Android SDK, or from the web SDK with the click IDs of its landing page.
create function pg_temp.app(anon text, user_id text, session text, at timestamptz, events text[]) returns jsonb
language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  result := public.analytics_ingest(jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.t('ingest_key'), 'sha256'), 'hex'),
    'body', jsonb_strip_nulls(jsonb_build_object('anonymous_id', anon, 'user_id', user_id)) || jsonb_build_object(
      'session', jsonb_build_object('id', session, 'started_at', pg_temp.iso(at)),
      'sent_at', pg_temp.iso(at + interval '5 seconds'),
      'context', jsonb_build_object('platform', 'android', 'sdk', 'kma-android/1.1.0', 'app_version', '2.4.0'),
      'events', coalesce((select jsonb_agg(jsonb_build_object('name', e, 'insert_id', session || ':' || e || ':' || i,
        'time', pg_temp.iso(at + make_interval(secs => (i - 1) * 0.01)), 'properties', '{}'::jsonb) order by i)
        from unnest(events) with ordinality u(e, i)), '[]'::jsonb))));
  reset role;
  return result;
end $$;
create function pg_temp.web(anon text, user_id text, session text, at timestamptz, click jsonb, events text[]) returns jsonb
language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  result := public.analytics_ingest(jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.t('ingest_key'), 'sha256'), 'hex'),
    'origin', 'https://fluent-app.io',
    'body', jsonb_strip_nulls(jsonb_build_object('anonymous_id', anon, 'user_id', user_id)) || jsonb_build_object(
      'session', jsonb_build_object('id', session, 'started_at', pg_temp.iso(at)),
      'context', jsonb_build_object('platform', 'web', 'browser', 'Chrome', 'device_type', 'desktop', 'interactions', 3,
        'page_path', '/start', 'click', click),
      'events', coalesce((select jsonb_agg(jsonb_build_object('name', e, 'insert_id', session || ':' || e || ':' || i,
        'time', pg_temp.iso(at), 'properties', '{}'::jsonb)) from unnest(events) with ordinality u(e, i)), '[]'::jsonb))));
  reset role;
  return result;
end $$;
-- The Android SDK's install call on first launch, through the real attribution_install with the
-- envelope the ingest edge function builds.
create function pg_temp.install(anon text, user_id text, at timestamptz, device text, referrer text,
  begin_ts bigint default null, app_key text default null) returns jsonb language sql as $$
  select pg_temp.svc('attribution_install', jsonb_build_object(
    'key_hash', encode(extensions.digest(coalesce(app_key, pg_temp.t('ingest_key')), 'sha256'), 'hex'),
    'body', jsonb_strip_nulls(jsonb_build_object(
      'anonymous_id', anon, 'user_id', user_id, 'session_id', 'sess-' || anon, 'platform', 'android',
      'installed_at', pg_temp.iso(at), 'sdk', 'kma-android/1.1.0', 'app_version', '2.4.0',
      'device_key', encode(extensions.digest(device, 'sha256'), 'hex'), 'referrer', referrer,
      'referrer_click_ts', case when begin_ts is not null then begin_ts - 5 end, 'install_begin_ts', begin_ts)),
    'geo', '{}'::jsonb, 'clock_skew_ms', 0))
$$;
create function pg_temp.person(anon text) returns uuid language sql as $$
  select pe.id from public.analytics_people pe
  where pe.project_id = pg_temp.q('project') and (pe.distinct_id = anon or pe.anonymous_ids @> array[anon])
$$;
create function pg_temp.install_of(anon text) returns public.attribution_installs language sql as $$
  select i from public.attribution_installs i where i.person_id = pg_temp.person(anon)
$$;
create function pg_temp.deposit(k text, amount bigint) returns jsonb language plpgsql as $$
declare
  v_opened jsonb;
  v_begun jsonb;
begin
  v_opened := pg_temp.svc('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('workspace'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_KMAPlatform'));
  perform pg_temp.svc('attach_program_balance_customer', jsonb_build_object('account_id', v_opened->>'account_id',
    'stripe_customer_id', 'cus_Amplitude', 'platform_account_id', 'acct_KMAPlatform'));
  v_begun := pg_temp.svc('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('workspace'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_KMAPlatform', 'amount_minor', amount));
  perform pg_temp.svc('attach_program_topup', jsonb_build_object('topup_id', v_begun->>'topup_id',
    'checkout_session_id', 'cs_live_' || k));
  return pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', v_begun->>'topup_id', 'outcome', 'succeeded',
    'payment_intent_id', 'pi_ampdep' || k, 'livemode', true, 'amount_minor', amount, 'currency', 'usd',
    'customer_id', 'cus_Amplitude', 'card', jsonb_build_object('payment_method_id', 'pm_AmplitudeVisa', 'brand', 'visa',
      'last4', '4242', 'exp_month', 4, 'exp_year', 2029)));
end $$;
do $$
begin
  if current_setting('server_encoding') <> 'UTF8' then
    create or replace function kma_internal.readable_handle(p_text text, p_fallback text, p_max integer) returns text
    language sql immutable set search_path = '' as $f$
      select coalesce(nullif(trim(both '-' from left(regexp_replace(lower(coalesce(p_text, '')),
        '[^[:alnum:]]+', '-', 'g'), p_max)), ''), p_fallback)
    $f$;
  end if;
end $$;
grant all on qa, destination_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- Plain placeholder keys: 32 hex characters each.
insert into qa values ('key_one', repeat('a', 28) || 'beef'), ('key_two', repeat('c', 28) || 'cafe'),
  ('key_three', repeat('d', 28) || 'f00d');

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('ed920000-0000-4000-8000-000000000001', 'owner@fluent.example.test', now(), '{"company":"Fluent"}'),
  ('ed920000-0000-4000-8000-000000000002', 'dev@fluent.example.test', now(), '{}'),
  ('ed920000-0000-4000-8000-000000000003', 'analyst@fluent.example.test', now(), '{}'),
  ('ed920000-0000-4000-8000-000000000004', 'stranger@elsewhere.example.test', now(), '{}'),
  ('ed920000-0000-4000-8000-000000000011', 'founder@kma.example.test', now(), '{}'),
  ('ed920000-0000-4000-8000-000000000021', 'mira@creators.example.test', now(), '{}');
insert into qa values ('owner', 'ed920000-0000-4000-8000-000000000001'), ('developer', 'ed920000-0000-4000-8000-000000000002'),
  ('analyst', 'ed920000-0000-4000-8000-000000000003'), ('stranger', 'ed920000-0000-4000-8000-000000000004'),
  ('kma_owner', 'ed920000-0000-4000-8000-000000000011'), ('creator', 'ed920000-0000-4000-8000-000000000021');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner');
insert into public.affiliates(id, public_name, slug, status) values
  ('ee920000-0000-4000-8000-000000000001', 'Mira Maker', 'amplitude-creator', 'active');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at) values
  ('ee920000-0000-4000-8000-000000000001', pg_temp.q('creator'), 'owner', true, false, now());
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true;

-- Closed by default ---------------------------------------------------------------------------
select pg_temp.check((select bool_and(has_function_privilege('authenticated', f, 'execute')
    and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('service_role', f, 'execute'))
  from unnest(array['public.analytics_destinations_get(uuid)', 'public.analytics_destination_save(uuid,text,jsonb)',
    'public.analytics_destination_remove(uuid,text)']) f),
  'only signed-in people call the console functions');
select pg_temp.check((select bool_and(has_function_privilege('service_role', f, 'execute')
    and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
  from unnest(array['public.claim_analytics_destination_jobs(jsonb)', 'public.finish_analytics_destination_job(jsonb)']) f),
  'only the worker claims and finishes jobs');
select pg_temp.check((select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
  from pg_proc p where p.oid in ('public.analytics_destinations_get(uuid)'::regprocedure,
    'public.analytics_destination_save(uuid,text,jsonb)'::regprocedure, 'public.analytics_destination_remove(uuid,text)'::regprocedure,
    'public.claim_analytics_destination_jobs(jsonb)'::regprocedure, 'public.finish_analytics_destination_job(jsonb)'::regprocedure)),
  'the new functions run with an empty search path');
select pg_temp.check((select bool_and(not has_function_privilege(r, p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join unnest(array['anon', 'authenticated', 'service_role']) r
  where n.nspname = 'kma_internal' and (p.proname like 'analytics\_destination%' or p.proname = 'tick_analytics_destination_schedule')),
  'nobody calls the helpers, the triggers or the schedule directly');
select pg_temp.check((select bool_and(not has_table_privilege(r, t, 'select') and not has_table_privilege(r, t, 'insert'))
  from unnest(array['public.analytics_destinations', 'public.analytics_destination_jobs']) t
  cross join unnest(array['anon', 'authenticated', 'service_role']) r),
  'the key and the queue are read only through functions: no API role reads the tables');

-- The merchant's app sends its analytics, has attribution on and a live app program -----------------
select pg_temp.sign_in('owner');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Fluent', array['android', 'web'], 'UTC') r)
insert into qa select 'project', r->'project'->>'id' from created
union all select 'ingest_key', r->'key'->>('to' || 'ken') from created;
insert into qa select 'dev_key', public.analytics_create_key(pg_temp.q('project'), 'Staging', 'client', 'development')->>('to' || 'ken');
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Quiet', array['android'], 'UTC') r)
insert into qa select 'quiet', r->'project'->>'id' from created;
select public.analytics_invite_member(pg_temp.q('workspace'), 'dev@fluent.example.test', 'developer');
select public.analytics_invite_member(pg_temp.q('workspace'), 'analyst@fluent.example.test', 'analyst');
select pg_temp.sign_in('developer');
select public.analytics_bootstrap();
select pg_temp.sign_in('analyst');
select public.analytics_bootstrap();
select pg_temp.sign_in('stranger');
select public.analytics_bootstrap();
select set_config('request.jwt.claims', '', true);
with business as (
  insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
  values ('Fluent Ltd', 'billing@fluent.example.test', pg_temp.q('owner'), pg_temp.q('workspace')) returning id)
insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status, business_name,
  country, charges_enabled, details_submitted, confirmed_at, verified_at)
select id, 'acct_KMAPlatform', true, 'acct_Amplitude', 'active', 'Fluent Ltd', 'GB', true, true, now(), now() from business;
select pg_temp.call('owner', format('select public.attribution_enable(%L, %L)', pg_temp.q('project'), 'fluent'));
select pg_temp.call('owner', format('select public.attribution_update(%L, %L)', pg_temp.q('project'),
  '{"android_package":"io.fluent.app","android_sha256":["14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5"],"web_url":"https://fluent-app.io/start"}'::jsonb));
insert into qa select 'link_id', pg_temp.call('owner', format('select public.attribution_save_link(%L, null, %L)', pg_temp.q('project'),
  '{"path":"get-app","name":"Get the app","source":"creators","campaign":"launch"}'::jsonb))->>'id';
insert into qa values ('app_link_url', 'https://fluent.go.kissmyapps.dev/get-app');
select pg_temp.call('kma_owner', format('select public.configure_admin_program_money(%L)', jsonb_build_object('enabled', true,
  'expected_updated_at', pg_temp.call('kma_owner', 'select public.get_admin_program_money()')->'updated_at')));
select pg_temp.app('anon-early', null, 'sess-early', clock_timestamp(), array['app_installed']);
select pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
  jsonb_build_object('name', 'Fluent', 'category', 'education', 'tagline', 'Speak a new language in a month.',
    'landing_url', pg_temp.t('app_link_url'), 'earn_from', 'events', 'hold_days', 14,
    'rewards', '[{"key":"app_installed","label":"App installed","amount_minor":150}]'::jsonb, 'reward_budget_minor', 10000)));
select pg_temp.call('owner', format('select public.workspace_program_mark_agreement_read(%L, %L)', pg_temp.q('workspace'),
  pg_temp.call('owner', format('select public.workspace_program_agreement(%L)', pg_temp.q('workspace')))->>'sha256'));
select pg_temp.deposit('first', 5000);
select pg_temp.call('owner', format('select public.workspace_program_submit(%L, %s)', pg_temp.q('workspace'), (pg_temp.program()).revision));
select pg_temp.call('kma_owner', format('select public.review_admin_program(%L)',
  jsonb_build_object('program_id', (pg_temp.program()).id, 'decision', 'approve', 'note', null)));
insert into qa select 'shown', pg_temp.call('creator', format('select public.partner_program_detail(%L)', (pg_temp.program()).slug))::text;
insert into qa select 'link_url', pg_temp.call('creator', format('select public.partner_program_join(%L)',
  jsonb_build_object('slug', d->'program'->>'slug', 'terms_version', d->'program'->'terms_version',
    'agreement_sha256', d->'program'->>'agreement_sha256')))->'membership'->'link'->>'url'
from (select pg_temp.t('shown')::jsonb as d) x;
select pg_temp.check((pg_temp.program()).status = 'live' and pg_temp.t('link_url') like 'https://go.kissmyapps.dev/r/amplitude-creator/%',
  'the app program is live and the creator has a link to it');

-- Saving the key: roles and checks -------------------------------------------------------------------
select pg_temp.check(pg_temp.get('analyst') = '{"destinations":[]}'::jsonb
  and pg_temp.get('owner') = '{"destinations":[]}'::jsonb, 'members read that no destination is set');
select pg_temp.check(
  pg_temp.try('stranger', format('select public.analytics_destinations_get(%L)', pg_temp.q('project'))) like 'P0002%'
  and pg_temp.try('creator', format('select public.analytics_destinations_get(%L)', pg_temp.q('project'))) like 'P0002%'
  and pg_temp.try('owner', 'select public.analytics_destinations_get(gen_random_uuid())') like 'P0002%'
  and pg_temp.try_as('anon', format('select public.analytics_destinations_get(%L)', pg_temp.q('project'))) = '42501'
  and pg_temp.try_as('service_role', format('select public.analytics_destinations_get(%L)', pg_temp.q('project'))) = '42501',
  'only people of the workspace read it');
select pg_temp.check(pg_temp.save_try('analyst', pg_temp.key_input(pg_temp.t('key_one'))) like '42501%'
  and pg_temp.save_try('stranger', pg_temp.key_input(pg_temp.t('key_one'))) like 'P0002%'
  and pg_temp.try_as('anon', format('select public.analytics_destination_save(%L, %L, %L)', pg_temp.q('project'), 'amplitude',
    pg_temp.key_input(pg_temp.t('key_one')))) = '42501'
  and pg_temp.try_as('service_role', format('select public.analytics_destination_save(%L, %L, %L)', pg_temp.q('project'), 'amplitude',
    pg_temp.key_input(pg_temp.t('key_one')))) = '42501',
  'an analyst, a stranger and the API roles cannot save a key');
select pg_temp.check(
  pg_temp.save_try('developer', pg_temp.key_input('not-a-key')) = '22023 invalid_key'
  and pg_temp.save_try('developer', pg_temp.key_input(repeat('a', 31))) = '22023 invalid_key'
  and pg_temp.save_try('developer', pg_temp.key_input(repeat('g', 32))) = '22023 invalid_key'
  and pg_temp.save_try('developer', jsonb_build_object('api_' || 'key', 12345)) = '22023 invalid_key'
  and pg_temp.save_try('developer', pg_temp.key_input(pg_temp.t('key_one'), 'asia')) = '22023 invalid_region'
  and pg_temp.save_try('developer', pg_temp.key_input(pg_temp.t('key_one')) || '{"colour":"blue"}') = '22023 invalid_input'
  and pg_temp.save_try('developer', '[]'::jsonb) = '22023 invalid_input'
  and pg_temp.save_try('developer', pg_temp.key_input(pg_temp.t('key_one')), 'mixpanel') = '22023 invalid_provider'
  and pg_temp.save_try('developer', '{"region":"eu"}'::jsonb) = '22023 key_required',
  'the key is 32 hex characters, the region US or EU, the tool Amplitude, and the first save needs the key');
select pg_temp.check(not exists (select 1 from public.analytics_destinations), 'a refused save stores nothing');
select pg_temp.keep('saved', pg_temp.save('developer', pg_temp.key_input('  ' || upper(pg_temp.t('key_one')) || ' ')));
select pg_temp.capture('analytics_destinations_get.saved', pg_temp.get('analyst'));
select pg_temp.check(pg_temp.j('saved') = jsonb_build_object('destinations', jsonb_build_array(jsonb_build_object(
    'provider', 'amplitude', 'region', 'us', 'key_last4', 'beef', 'status', 'active', 'last_sent_at', null,
    'last_error', null, 'sent_30d', 0, 'failed_30d', 0)))
  and pg_temp.get('analyst') = pg_temp.j('saved'),
  'a developer saves the key: the answer shows its last 4, US by default, active, nothing sent yet');
select pg_temp.check((pg_temp.destination()).project_key = pg_temp.t('key_one')
  and position(pg_temp.t('key_one') in pg_temp.get('owner')::text) = 0
  and not exists (select 1 from public.audit_logs a where a.action like 'analytics\_destination%'
    and position(pg_temp.t('key_one') in a::text) > 0)
  and exists (select 1 from public.audit_logs a where a.action = 'analytics_destination_saved'
    and a.actor_user_id = pg_temp.q('developer') and a.after_data @> '{"key_last4":"beef","region":"us"}'),
  'the key is stored trimmed and lower case, never read back whole, and the audit log names only its last 4');
select pg_temp.check((pg_temp.save('owner', '{"region":"eu"}')->'destinations'->0) @> '{"region":"eu","key_last4":"beef"}'
  and (pg_temp.destination()).project_key = pg_temp.t('key_one'),
  'the owner moves it to the EU region without pasting the key again');
select pg_temp.check(pg_temp.get('owner', 'quiet') = '{"destinations":[]}'::jsonb, 'another project of the workspace has none');

-- Installs: only matched production installs of identified people are queued ------------------------
select pg_temp.check(pg_temp.job_count() = 0, 'nothing waits yet');
insert into qa select 'ann_creator_click', c->>'click_id' from pg_temp.creator_click() c;
insert into qa values ('ann_at', clock_timestamp()::text);
select pg_temp.smart_click('AnnSmartLinkClick001', 'android', 'play_store', pg_temp.t('ann_creator_click'), clock_timestamp());
insert into qa select 'ann_install', pg_temp.install('anon-ann', 'user-ann-01', pg_temp.t('ann_at')::timestamptz + interval '1 minute',
  'android-id-ann', 'kma_lc=AnnSmartLinkClick001&utm_source=creators')::text;
select pg_temp.check(pg_temp.j('ann_install') @> '{"matched":true,"method":"install_referrer","source":"creators"}'
  and (pg_temp.install_of('anon-ann')).creator_click = pg_temp.t('ann_creator_click')
  and (select count(*) = 1 from pg_temp.jobs_of('anon-ann') j where j.status = 'pending' and j.attempts = 0)
  and pg_temp.job_count() = 1,
  'Ann, signed in, installs through the creator''s smart link: her matched install waits once to be sent');
select pg_temp.install('anon-ann', 'user-ann-01', pg_temp.t('ann_at')::timestamptz + interval '1 minute', 'android-id-ann',
  'kma_lc=AnnSmartLinkClick001');
select pg_temp.check(pg_temp.job_count() = 1, 'the same install call again queues nothing more');

select pg_temp.smart_click('BoSmartLinkClick0001', 'android', 'play_store', null, clock_timestamp());
insert into qa select 'bo_install', pg_temp.install('anon-bo', null, clock_timestamp() + interval '1 minute', 'android-id-bo',
  'kma_lc=BoSmartLinkClick0001')::text;
select pg_temp.check(pg_temp.j('bo_install') @> '{"matched":true,"method":"install_referrer"}'
  and not exists (select 1 from pg_temp.jobs_of('anon-bo')),
  'Bo''s install is matched, but nobody knows who Bo is yet: nothing is queued');
select pg_temp.app('anon-bo', null, 'sess-anon-bo', clock_timestamp() + interval '2 minutes', array['app_opened']);
select pg_temp.check(not exists (select 1 from pg_temp.jobs_of('anon-bo')), 'his anonymous events queue nothing either');
select pg_temp.app('anon-bo', 'user-bo-02', 'sess-anon-bo', clock_timestamp() + interval '3 minutes', array['signup_completed']);
select pg_temp.check((select user_id = 'user-bo-02' from public.analytics_people where id = pg_temp.person('anon-bo'))
  and (select count(*) = 1 from pg_temp.jobs_of('anon-bo') j where j.status = 'pending'),
  'the app identifies Bo: his install, never sent, now waits');
select pg_temp.app('anon-bo', 'user-bo-02', 'sess-anon-bo', clock_timestamp() + interval '4 minutes', array['lesson_started']);
select pg_temp.check((select count(*) = 1 from pg_temp.jobs_of('anon-bo')), 'later events of the same person change nothing');

select pg_temp.install('anon-cy', 'user-cy-03', clock_timestamp() + interval '1 minute', 'android-id-cy', null);
select pg_temp.check((pg_temp.install_of('anon-cy')).method = 'organic' and not exists (select 1 from pg_temp.jobs_of('anon-cy')),
  'an organic install of a signed-in person is not sent');
select pg_temp.smart_click('DevSmartLinkClick001', 'android', 'play_store', null, clock_timestamp());
select pg_temp.install('anon-dev', 'user-dev-04', clock_timestamp() + interval '1 minute', 'android-id-dev',
  'kma_lc=DevSmartLinkClick001', null, pg_temp.t('dev_key'));
select pg_temp.check((pg_temp.install_of('anon-dev')).environment = 'development'
  and (pg_temp.install_of('anon-dev')).method = 'install_referrer' and not exists (select 1 from pg_temp.jobs_of('anon-dev')),
  'a matched install from a development key is not sent');
insert into qa values ('rex_fraud_at', clock_timestamp()::text);
select pg_temp.smart_click('RexInjectedClick0001', 'android', 'play_store', null, pg_temp.t('rex_fraud_at')::timestamptz);
select pg_temp.install('anon-rex', 'user-rex-05', clock_timestamp() + interval '1 minute', 'android-id-rex',
  'kma_lc=RexInjectedClick0001', floor(extract(epoch from pg_temp.t('rex_fraud_at')::timestamptz))::bigint - 30);
select pg_temp.check((pg_temp.install_of('anon-rex')).verdict = 'rejected' and not exists (select 1 from pg_temp.jobs_of('anon-rex')),
  'an install rejected as fraud is not sent');

-- An organic install matched later, when the person turns out to have come from a link
select pg_temp.smart_click('DeeWebClick000000001', 'desktop', 'web', null, clock_timestamp() - interval '10 minutes');
select pg_temp.web('web-anon-dee', 'user-dee-06', 'sess-dee-web', clock_timestamp() - interval '9 minutes',
  '{"kma_lc":"DeeWebClick000000001"}'::jsonb, array['page_viewed']);
select pg_temp.install('anon-dee', null, clock_timestamp() - interval '5 minutes', 'android-id-dee', null);
select pg_temp.app('anon-dee', 'user-dee-06', 'sess-anon-dee', clock_timestamp() - interval '4 minutes', array['app_opened']);
select pg_temp.check((pg_temp.install_of('user-dee-06')).method = 'organic' and not exists (select 1 from pg_temp.jobs_of('user-dee-06')),
  'Dee''s phone folds into her signed-in profile; her install is organic, so nothing is queued');
select pg_temp.svc('attribution_tick', '{}'::jsonb);
select pg_temp.check((pg_temp.install_of('user-dee-06')).method = 'login'
  and (select count(*) = 1 from pg_temp.jobs_of('user-dee-06') j where j.status = 'pending'),
  'the minute tick matches it to her website click: now it waits to be sent');
select pg_temp.check(pg_temp.job_count() = 3, 'three installs wait: Ann''s, Bo''s and Dee''s');

-- The queue never fails an install or an event
select pg_temp.smart_click('HalSmartLinkClick001', 'android', 'play_store', null, clock_timestamp());
select pg_temp.install('anon-hal', null, clock_timestamp() + interval '1 minute', 'android-id-hal', 'kma_lc=HalSmartLinkClick001');
-- The queue breaks (a constraint no new row meets, for this test only).
alter table public.analytics_destination_jobs add constraint queue_down check (false) not valid;
select pg_temp.smart_click('EveSmartLinkClick001', 'android', 'play_store', null, clock_timestamp());
insert into qa select 'eve_install', pg_temp.install('anon-eve', 'user-eve-07', clock_timestamp() + interval '1 minute',
  'android-id-eve', 'kma_lc=EveSmartLinkClick001')::text;
insert into qa select 'hal_events', pg_temp.app('anon-hal', 'user-hal-08', 'sess-anon-hal', clock_timestamp() + interval '2 minutes',
  array['app_opened'])::text;
select pg_temp.check(pg_temp.j('eve_install') @> '{"matched":true}' and (pg_temp.install_of('anon-eve')).id is not null
  and (pg_temp.j('hal_events')->>'stored') = '1'
  and (select user_id = 'user-hal-08' from public.analytics_people where id = pg_temp.person('anon-hal'))
  and not exists (select 1 from pg_temp.jobs_of('anon-eve')) and not exists (select 1 from pg_temp.jobs_of('anon-hal')),
  'when the queue fails, the install and the events are still stored and answered (a warning is all)');
alter table public.analytics_destination_jobs drop constraint queue_down;

-- The worker: claim and finish ------------------------------------------------------------------------
select pg_temp.check(pg_temp.svc_try('claim_analytics_destination_jobs', '{"limit":0}') = '22023 invalid_input'
  and pg_temp.svc_try('claim_analytics_destination_jobs', '{"limit":501}') = '22023 invalid_input'
  and pg_temp.svc_try('claim_analytics_destination_jobs', '{"lease_seconds":10}') = '22023 invalid_input'
  and pg_temp.svc_try('claim_analytics_destination_jobs', '{"every":1}') = '22023 invalid_input',
  'a claim takes a limit from 1 to 500 and a lease from 30 to 600 seconds');
-- Ann's install is claimed first, alone.
update public.analytics_destination_jobs set next_attempt_at = now() + interval '1 hour'
where install_id <> (pg_temp.install_of('anon-ann')).id;
select pg_temp.keep('claim_one', pg_temp.claim('{"limit":10}'));
select pg_temp.capture('claim_analytics_destination_jobs.one', pg_temp.j('claim_one'));
insert into qa select 'ann_job', pg_temp.j('claim_one')->'jobs'->0;
select pg_temp.check(jsonb_array_length(pg_temp.j('claim_one')->'jobs') = 1
  and (select (pg_temp.j('ann_job') - 'id' - 'lease_token') = jsonb_build_object(
      'provider', 'amplitude', 'region', 'eu', 'api_' || 'key', pg_temp.t('key_one'), 'user_id', 'user-ann-01',
      'insert_id', 'kma-' || j.id, 'time', floor(extract(epoch from i.installed_at) * 1000)::bigint,
      'event_properties', jsonb_build_object('source', 'creators', 'campaign', 'launch', 'method', 'install_referrer',
        'exact', true, 'platform', 'android', 'creator', 'Mira Maker'),
      'user_properties', jsonb_build_object('kma_source', 'creators', 'kma_campaign', 'launch',
        'kma_method', 'install_referrer', 'kma_creator', 'Mira Maker'))
    and pg_temp.j('ann_job')->>'id' = j.id::text and pg_temp.j('ann_job')->>'lease_token' = j.lease_token::text
    and j.attempts = 1 and j.lease_until > now()
    from pg_temp.jobs_of('anon-ann') j, pg_temp.install_of('anon-ann') i),
  'the claim hands the worker Ann''s install: the key, her user ID, an insert ID per job, the install time, the source and the creator''s public name');
select pg_temp.check(pg_temp.claim() = '{"jobs":[]}'::jsonb, 'a held job is not handed out twice');
select pg_temp.check(
  pg_temp.finish_try(pg_temp.j('ann_job'), '{"ok":true,"error":"x","retry":true}') = '22023 invalid_input'
  and pg_temp.finish_try(pg_temp.j('ann_job'), '{"ok":false}') = '22023 invalid_input'
  and pg_temp.finish_try(pg_temp.j('ann_job'), '{"error":"Bad Thing"}') = '22023 invalid_input'
  and pg_temp.finish_try(pg_temp.j('ann_job'), '{"error":"server_error"}') = '22023 invalid_input'
  and pg_temp.finish_try(pg_temp.j('ann_job'), '{"error":"server_error","retry":true,"delay_seconds":1}') = '22023 invalid_input'
  and pg_temp.finish_try(pg_temp.j('ann_job'), '{"error":"invalid_key","retry":true}') = '22023 invalid_input'
  and pg_temp.finish_try(pg_temp.j('ann_job') || jsonb_build_object('lease_token', gen_random_uuid()), '{"ok":true}') = '22023 lease_lost'
  and pg_temp.finish_try(pg_temp.j('ann_job') || jsonb_build_object('id', gen_random_uuid()), '{"ok":true}') = 'P0002 job_not_found',
  'a finish says one outcome in plain codes, for the job it holds');
select pg_temp.check(pg_temp.finish(pg_temp.j('ann_job'), '{"ok":true}')
    = jsonb_build_object('id', pg_temp.j('ann_job')->>'id', 'status', 'sent', 'next_attempt_at', null, 'destination_status', 'active'),
  'Amplitude took it: the job is sent');
select pg_temp.check((select d->'last_sent_at' <> 'null' and d @> '{"status":"active","sent_30d":1,"failed_30d":0,"last_error":null}'
    from (select pg_temp.get('analyst')->'destinations'->0 d) x)
  and (pg_temp.destination()).sent_total = 1,
  'the console shows when it last sent and one install sent in 30 days');
select pg_temp.check(pg_temp.finish_try(pg_temp.j('ann_job'), '{"ok":true}') = '22023 lease_lost',
  'a finished job cannot be finished again');
select pg_temp.install('anon-ann', 'user-ann-01', pg_temp.t('ann_at')::timestamptz + interval '1 minute', 'android-id-ann',
  'kma_lc=AnnSmartLinkClick001');
select pg_temp.app('anon-ann', 'user-ann-01', 'sess-anon-ann', clock_timestamp(), array['app_opened']);
select pg_temp.check((select count(*) = 1 from pg_temp.jobs_of('anon-ann')), 'a sent install is not sent again');
-- A changed match is sent again (the source is written directly, as a later match would write it).
update public.attribution_installs set source = 'tiktok', campaign = null where id = (pg_temp.install_of('anon-ann')).id;
select pg_temp.check((select count(*) = 2 from pg_temp.jobs_of('anon-ann'))
  and (select count(*) = 1 from pg_temp.jobs_of('anon-ann') j where j.status = 'pending'),
  'when the match of a sent install changes, it is queued again');
update public.attribution_installs set deep_link_delivered_at = now(), app_version = '2.5.0'
where id = (pg_temp.install_of('anon-ann')).id;
select pg_temp.check((select count(*) = 2 from pg_temp.jobs_of('anon-ann')), 'any other change queues nothing');
update public.analytics_destination_jobs set next_attempt_at = now() + interval '1 hour'
where install_id = (pg_temp.install_of('anon-ann')).id and status = 'pending';

-- Retries with backoff, then failed
update public.analytics_destination_jobs set next_attempt_at = now() - interval '1 second'
where install_id = (pg_temp.install_of('anon-bo')).id;
insert into qa select 'bo_job', pg_temp.claim()->'jobs'->0;
select pg_temp.check(pg_temp.j('bo_job')->>'user_id' = 'user-bo-02'
  and pg_temp.j('bo_job')->'event_properties' @> '{"creator":null,"method":"install_referrer"}'
  and pg_temp.j('bo_job')->'user_properties' @> '{"kma_creator":null}',
  'Bo''s install came through a plain smart-link click: no creator is named');
select pg_temp.keep('bo_retry', pg_temp.finish(pg_temp.j('bo_job'), '{"error":"server_error","retry":true}'));
select pg_temp.check(pg_temp.j('bo_retry') @> '{"status":"pending","destination_status":"failing"}'
  and (pg_temp.j('bo_retry')->>'next_attempt_at')::timestamptz between clock_timestamp() + interval '55 seconds' and clock_timestamp() + interval '61 seconds'
  and (select d @> '{"status":"failing","last_error":"server_error"}' from (select pg_temp.get('owner')->'destinations'->0 d) x),
  'Amplitude failed: the job is tried again in a minute and the console says the destination is failing');
select pg_temp.check(pg_temp.claim() = '{"jobs":[]}'::jsonb, 'not before its time');
select pg_temp.due(pg_temp.j('bo_job'));
insert into qa select 'bo_job2', pg_temp.claim()->'jobs'->0;
select pg_temp.check(pg_temp.j('bo_job2')->>'id' = pg_temp.j('bo_job')->>'id'
  and pg_temp.j('bo_job2')->>'insert_id' = pg_temp.j('bo_job')->>'insert_id'
  and pg_temp.j('bo_job2')->>'lease_token' <> pg_temp.j('bo_job')->>'lease_token'
  and (select attempts = 2 from pg_temp.jobs_of('anon-bo')),
  'then it is handed out again with the same insert ID, so Amplitude keeps one copy');
select pg_temp.keep('bo_retry2', pg_temp.finish(pg_temp.j('bo_job2'), '{"error":"throttled","retry":true,"delay_seconds":30}'));
select pg_temp.check((pg_temp.j('bo_retry2')->>'next_attempt_at')::timestamptz between clock_timestamp() + interval '25 seconds' and clock_timestamp() + interval '31 seconds',
  'a throttled send waits the delay the worker asks for');
select pg_temp.due(pg_temp.j('bo_job'));
insert into qa select 'bo_job3', pg_temp.claim()->'jobs'->0;
select pg_temp.finish(pg_temp.j('bo_job3'), '{"error":"server_error","retry":true}');
select pg_temp.check((select attempts = 3 and next_attempt_at between clock_timestamp() + interval '235 seconds'
    and clock_timestamp() + interval '241 seconds' from pg_temp.jobs_of('anon-bo')),
  'the wait doubles with each attempt: four minutes after the third');
-- The tenth attempt (the count is written directly).
update public.analytics_destination_jobs set attempts = 9, next_attempt_at = now() - interval '1 second'
where install_id = (pg_temp.install_of('anon-bo')).id;
insert into qa select 'bo_job10', pg_temp.claim()->'jobs'->0;
select pg_temp.check(pg_temp.finish(pg_temp.j('bo_job10'), '{"error":"server_error","retry":true}') @> '{"status":"failed","next_attempt_at":null}'
  and (select status = 'failed' and attempts = 10 and last_error = 'server_error' from pg_temp.jobs_of('anon-bo'))
  and (select d @> '{"failed_30d":1,"sent_30d":1,"status":"failing"}' from (select pg_temp.get('owner')->'destinations'->0 d) x),
  'after the tenth attempt the job has failed, and the console counts it');

-- Amplitude refuses the key: paused until the merchant saves a key again
update public.analytics_destination_jobs set next_attempt_at = now() - interval '1 second'
where install_id = (pg_temp.install_of('user-dee-06')).id;
insert into qa select 'dee_job', pg_temp.claim()->'jobs'->0;
select pg_temp.check(pg_temp.j('dee_job')->'event_properties' @> '{"method":"login","source":"creators","exact":true}',
  'Dee''s install goes out as matched at sign-in');
select pg_temp.check(pg_temp.finish(pg_temp.j('dee_job'), '{"error":"invalid_key"}') @> '{"status":"pending","destination_status":"paused"}'
  and (select attempts = 0 and last_error = 'invalid_key' from pg_temp.jobs_of('user-dee-06'))
  and (select d @> '{"status":"paused","last_error":"invalid_key"}' from (select pg_temp.get('analyst')->'destinations'->0 d) x),
  'Amplitude says the key is invalid: the destination is paused and the job waits, its attempt not counted');
select pg_temp.check(pg_temp.claim() = '{"jobs":[]}'::jsonb, 'nothing is handed out for a paused destination');
insert into qa select 'saved_two', pg_temp.save('developer', pg_temp.key_input(pg_temp.t('key_two')))::text;
select pg_temp.check((pg_temp.j('saved_two')->'destinations'->0)
    @> '{"status":"active","last_error":null,"key_last4":"cafe","region":"eu"}'
  and (select next_attempt_at <= clock_timestamp() from public.analytics_destination_jobs
    where install_id = (pg_temp.install_of('anon-ann')).id and status = 'pending'),
  'the developer pastes another key: active again, and what waited is due at once');
insert into qa select 'dee_job2', pg_temp.claim()->'jobs'->0;
select pg_temp.check(pg_temp.j('dee_job2')->>('api_' || 'key') = pg_temp.t('key_two') and pg_temp.j('dee_job2')->>'id' = pg_temp.j('dee_job')->>'id',
  'the waiting job goes out with the new key');
select pg_temp.save('developer', pg_temp.key_input(pg_temp.t('key_three')));
select pg_temp.check(pg_temp.finish(pg_temp.j('dee_job2'), '{"error":"invalid_key"}') @> '{"status":"pending","destination_status":"active"}',
  'a refusal of a key that was replaced since the claim pauses nothing');
select pg_temp.due(pg_temp.j('dee_job'));
insert into qa select 'dee_job3', pg_temp.claim()->'jobs'->0;
select pg_temp.check(pg_temp.finish(pg_temp.j('dee_job3'), '{"release":true}') @> '{"status":"pending"}'
  and (select attempts = 0 and lease_token is null from pg_temp.jobs_of('user-dee-06')),
  'a job the worker never sent is released without counting the attempt');

-- A job whose install is no longer one to send is skipped (the verdict is written directly).
update public.attribution_installs set verdict = 'rejected', fraud_reason = 'click_after_install'
where id = (pg_temp.install_of('user-dee-06')).id;
select pg_temp.check(pg_temp.claim() = '{"jobs":[]}'::jsonb
  and (select status = 'skipped' and finished_at is not null from pg_temp.jobs_of('user-dee-06')),
  'an install rejected since it was queued is skipped, not sent');
select pg_temp.check(pg_temp.svc_try('finish_analytics_destination_job', '[]') = '22023 invalid_input'
  and pg_temp.try_as('authenticated', 'select public.claim_analytics_destination_jobs(''{}'')') = '42501',
  'the worker functions check their input and refuse people');

-- The schedule ----------------------------------------------------------------------------------------
select pg_temp.check(kma_internal.tick_analytics_destination_schedule() = '{"status":"paused"}'::jsonb,
  'the schedule is installed paused');
update kma_internal.analytics_destination_schedule set enabled = true where singleton;
select pg_temp.check(kma_internal.tick_analytics_destination_schedule() = '{"status":"idle"}'::jsonb, 'with nothing due it calls nobody');
select pg_temp.smart_click('FayaSmartLinkClick01', 'android', 'play_store', null, clock_timestamp());
select pg_temp.install('anon-faya', 'user-faya-09', clock_timestamp() + interval '1 minute', 'android-id-faya',
  'kma_lc=FayaSmartLinkClick01');
select pg_temp.check(kma_internal.tick_analytics_destination_schedule() = '{"status":"scheduler_value_missing"}'::jsonb,
  'a due job without the Vault value: it says so and calls nobody');
insert into vault.decrypted_secrets(name, decrypted_secret) values ('kma_analytics_destinations_scheduler', repeat('s', 40));
-- The local fixture has no network: reaching net.http_post is the proof that the worker would be called.
select pg_temp.check(pg_temp.fails('select kma_internal.tick_analytics_destination_schedule()') like '%HTTP disabled in local isolated SQL fixture%',
  'with a due job and the value it calls the worker');
update public.analytics_destinations set status = 'paused' where project_id = pg_temp.q('project');
select pg_temp.check(kma_internal.tick_analytics_destination_schedule() = '{"status":"idle"}'::jsonb,
  'jobs of a paused destination wake nobody');
update public.analytics_destinations set status = 'active' where project_id = pg_temp.q('project');

-- Removing --------------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.try('analyst', format('select public.analytics_destination_remove(%L, %L)', pg_temp.q('project'), 'amplitude')) like '42501%',
  'an analyst cannot remove it');
insert into qa select 'removed', pg_temp.remove('developer')::text;
select pg_temp.check(pg_temp.j('removed') = '{"destinations":[]}'::jsonb
  and pg_temp.job_count() = 0 and not exists (select 1 from public.analytics_destinations)
  and exists (select 1 from public.audit_logs a where a.action = 'analytics_destination_removed' and a.before_data @> '{"key_last4":"f00d"}'),
  'a developer removes it: the key and everything queued for it are gone');
select pg_temp.check(pg_temp.remove('developer') = '{"destinations":[]}'::jsonb, 'removing it again changes nothing');
select pg_temp.smart_click('GusSmartLinkClick001', 'android', 'play_store', null, clock_timestamp());
select pg_temp.install('anon-gus', 'user-gus-10', clock_timestamp() + interval '1 minute', 'android-id-gus', 'kma_lc=GusSmartLinkClick001');
select pg_temp.check((pg_temp.install_of('anon-gus')).method = 'install_referrer' and pg_temp.job_count() = 0,
  'without a destination a matched install of a signed-in person queues nothing');
select pg_temp.save('owner', pg_temp.key_input(pg_temp.t('key_one')));
select pg_temp.check(pg_temp.job_count() = 0, 'a new key does not send installs made before it was saved');
select pg_temp.call('owner', format('select public.analytics_delete_project(%L, %L)', pg_temp.q('project'), 'Fluent'));
select pg_temp.check(not exists (select 1 from public.analytics_destinations), 'a deleted project takes its destination with it');

select 'ok ' || count(*) || ' analytics destination assertions' from destination_assertions;
rollback;
