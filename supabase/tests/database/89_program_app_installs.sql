-- Phase 7 working with Phases 1 to 6 and attribution, through the real functions: an app
-- program pays a creator for an install of the merchant's Android app and for a later
-- sign-up in it. The merchant's project has attribution on, an Android package and a smart
-- link; the program's landing page is that smart link; a creator joins; a person opens the
-- creator's link, the tracking redirect sends them to the smart link with kma_click, the
-- link service records the smart-link click with the creator's click on it and sends them to
-- Google Play; the app's first launch sends its events (app_installed) and its install call,
-- which is matched to that click through the install referrer; the minute tick pays the
-- creator. A reinstall of the same phone and an install rejected as fraud earn nothing.
--
-- Until Piece A (attribution_install, suite 88) is merged, the install call is played by
-- pg_temp.attribution_install below, which calls the real attribution_install as the edge
-- function does. Everything is the real thing.
begin;
set local time zone 'UTC';
create temporary table app_install_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program app install assertion failed: %', label; end if;
  insert into app_install_assertions values (label);
end $$;
create function pg_temp.capture(name text, result jsonb) returns text language sql as $$
  select 'capture ' || name || ' ' || result::text
$$;
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
create function pg_temp.t(k text) returns text language sql as $$ select value from qa where key = k $$;
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
-- What the end of a writing transaction does: the deferred commission triggers run.
create function pg_temp.flush() returns void language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end $$;
-- The minute job, as pg_cron runs it.
create function pg_temp.tick() returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  result := public.program_rewards_tick('{}'::jsonb);
  perform pg_temp.flush();
  return result;
end $$;
create function pg_temp.program() returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q('workspace')
$$;
create function pg_temp.account() returns public.program_balance_accounts language sql as $$
  select a from public.program_balance_accounts a where a.program_id = (pg_temp.program()).id
$$;
create function pg_temp.save(input jsonb) returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
    input || jsonb_build_object('revision', (pg_temp.program()).revision)))
$$;
create function pg_temp.state() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_get(%L)', pg_temp.q('workspace')))
$$;
create function pg_temp.app_links(who text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_program_app_links(%L)', pg_temp.q('workspace')))
$$;
create function pg_temp.reward_events() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_reward_events(%L)', pg_temp.q('workspace')))
$$;
create function pg_temp.balance() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_balance(%L)', pg_temp.q('workspace')))
$$;
create function pg_temp.rewards() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_rewards(%L, %L)', pg_temp.q('workspace'), '{}'::jsonb))
$$;
create function pg_temp.earnings() returns jsonb language sql as $$
  select pg_temp.call('creator', 'select public.partner_program_earnings()')
$$;
create function pg_temp.performance() returns jsonb language sql as $$
  select pg_temp.call('creator', format('select public.partner_program_performance(%L)',
    jsonb_build_object('slug', (pg_temp.program()).slug, 'days', 30)))
$$;
create function pg_temp.links() returns jsonb language sql as $$
  select pg_temp.call('creator', 'select public.partner_program_links()')
$$;
-- A moment as the phone's clock writes it.
create function pg_temp.iso(at timestamptz) returns text language sql immutable as $$
  select to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
-- A person opens the creator's main link, as the tracking-redirect function asks for it:
-- {click_id, destination_url, is_bot}. The function then sends them to destination_url with
-- kma_click=<click_id> on it.
create function pg_temp.creator_click() returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select to_jsonb(r) into result from public.register_tracking_click('app-install-creator',
    split_part(pg_temp.t('link_url'), '/', 6), '{}'::jsonb) r;
  reset role;
  return result;
end $$;
-- The link service records clicks on the smart link in a batch, as the attribution-links
-- function passes them on. Returns how many were stored.
create function pg_temp.record_clicks(clicks jsonb) returns integer language plpgsql as $$
declare result integer;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  result := public.attribution_record_clicks(clicks);
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- One click on the smart link, opened from the creator's redirect with kma_click on it.
create function pg_temp.smart_click(click_id text, platform text, destination text, creator_click text, at timestamptz)
returns integer language sql as $$
  select pg_temp.record_clicks(jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
    'id', click_id, 'link_id', pg_temp.t('link_id'), 'platform', platform, 'destination', destination,
    'clicked_at', pg_temp.iso(at), 'params', jsonb_strip_nulls(jsonb_build_object('creator_click', creator_click)),
    'user_agent', 'Mozilla/5.0 (Linux; Android 15; Pixel 9)'))))
$$;
-- One request from the Android SDK: the person, the session and the named events, a few
-- milliseconds apart from `at`.
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
      'context', jsonb_build_object('platform', 'android', 'sdk', 'kma-android/1.1.0', 'timezone', 'Europe/London',
        'language', 'en-GB', 'device_type', 'mobile', 'device_model', 'Pixel 9', 'os_name', 'Android', 'os_version', '15',
        'app_version', '2.4.0', 'screen_width', 412, 'screen_height', 915),
      'events', coalesce((select jsonb_agg(jsonb_build_object('name', e, 'insert_id', session || ':' || e || ':' || i,
        'time', pg_temp.iso(at + make_interval(secs => (i - 1) * 0.01)), 'properties', '{}'::jsonb) order by i)
        from unnest(events) with ordinality u(e, i)), '[]'::jsonb))));
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- One request from the web SDK on the merchant's site, with the click IDs of its landing page.
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
exception when others then
  reset role;
  raise;
end $$;

-- The install call of the app's first launch, through the real attribution_install (Piece A),
-- with the envelope the ingest edge function builds.
create function pg_temp.attribution_install(body jsonb) returns jsonb language sql as $$
  select pg_temp.svc('attribution_install', jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.t('ingest_key'), 'sha256'), 'hex'), 'body', body,
    'geo', '{}'::jsonb, 'clock_skew_ms', 0))
$$;

-- The Android SDK's install call on first launch (the contract's install body).
create function pg_temp.install(anon text, user_id text, session text, at timestamptz, device text, referrer text,
  begin_ts bigint default null) returns jsonb language sql as $$
  select pg_temp.attribution_install(jsonb_strip_nulls(jsonb_build_object(
    'anonymous_id', anon, 'user_id', user_id, 'session_id', session, 'platform', 'android',
    'installed_at', pg_temp.iso(at), 'sdk', 'kma-android/1.1.0', 'app_version', '2.4.0',
    'device_key', encode(extensions.digest(device, 'sha256'), 'hex'), 'referrer', referrer,
    'referrer_click_ts', case when begin_ts is not null then begin_ts - 5 end, 'install_begin_ts', begin_ts)))
$$;
create function pg_temp.person(anon text) returns uuid language sql as $$
  select pe.id from public.analytics_people pe
  where pe.project_id = pg_temp.q('project') and (pe.distinct_id = anon or pe.anonymous_ids @> array[anon])
$$;
create function pg_temp.install_of(anon text) returns public.attribution_installs language sql as $$
  select i from public.attribution_installs i where i.person_id = pg_temp.person(anon)
$$;
create function pg_temp.session(key text) returns public.analytics_sessions language sql as $$
  select s from public.analytics_sessions s where s.project_id = pg_temp.q('project') and s.session_key = key
$$;
-- The awards of one person, oldest first.
create function pg_temp.awards_of(anon text) returns setof public.program_reward_awards language sql as $$
  select w.* from public.program_reward_awards w where w.person_id = pg_temp.person(anon)
  order by w.occurred_at, w.id
$$;
create function pg_temp.commission_of(award uuid) returns public.program_commissions language sql as $$
  select c from public.program_commissions c where c.award_id = award
$$;
-- The merchant pays into the balance: the calls the program-balance function and the webhook
-- make around one Stripe Checkout payment.
create function pg_temp.deposit(k text, amount bigint) returns jsonb language plpgsql as $$
declare
  v_opened jsonb;
  v_begun jsonb;
begin
  v_opened := pg_temp.svc('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('workspace'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_KMAPlatform'));
  perform pg_temp.svc('attach_program_balance_customer', jsonb_build_object('account_id', v_opened->>'account_id',
    'stripe_customer_id', 'cus_AppInstall', 'platform_account_id', 'acct_KMAPlatform'));
  v_begun := pg_temp.svc('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('workspace'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_KMAPlatform', 'amount_minor', amount));
  perform pg_temp.svc('attach_program_topup', jsonb_build_object('topup_id', v_begun->>'topup_id',
    'checkout_session_id', 'cs_live_' || k));
  return pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', v_begun->>'topup_id', 'outcome', 'succeeded',
    'payment_intent_id', 'pi_appdep' || k, 'livemode', true, 'amount_minor', amount, 'currency', 'usd',
    'customer_id', 'cus_AppInstall', 'card', jsonb_build_object('payment_method_id', 'pm_AppInstallVisa', 'brand', 'visa',
      'last4', '4242', 'exp_month', 4, 'exp_year', 2029)));
end $$;
-- On a test cluster made without UTF-8 the readable link address cannot run normalize();
-- there, and only inside this rolled-back transaction, the same rule runs without it.
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
grant all on qa, app_install_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('eb890000-0000-4000-8000-000000000001', 'owner@fluent.example.test', now(), '{"company":"Fluent"}'),
  ('eb890000-0000-4000-8000-000000000011', 'founder@kma.example.test', now(), '{}'),
  ('eb890000-0000-4000-8000-000000000021', 'mira@creators.example.test', now(), '{}');
insert into qa values ('owner', 'eb890000-0000-4000-8000-000000000001'),
  ('kma_owner', 'eb890000-0000-4000-8000-000000000011'), ('creator', 'eb890000-0000-4000-8000-000000000021');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner');
insert into public.affiliates(id, public_name, slug, status) values
  ('ec890000-0000-4000-8000-000000000001', 'Mira Maker', 'app-install-creator', 'active');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at) values
  ('ec890000-0000-4000-8000-000000000001', pg_temp.q('creator'), 'owner', true, false, now());
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true;

-- The merchant's app already sends its analytics, and has attribution on ---------------------------
select pg_temp.sign_in('owner');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Fluent', array['android', 'web'], 'UTC') r)
insert into qa select 'project', r->'project'->>'id' from created
union all select 'ingest_key', r->'key'->>('to' || 'ken') from created;
select set_config('request.jwt.claims', '', true);
with business as (
  insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
  values ('Fluent Ltd', 'billing@fluent.example.test', pg_temp.q('owner'), pg_temp.q('workspace')) returning id)
insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status, business_name,
  country, charges_enabled, details_submitted, confirmed_at, verified_at)
select id, 'acct_KMAPlatform', true, 'acct_AppInstall', 'active', 'Fluent Ltd', 'GB', true, true, now(), now() from business;

select pg_temp.check(
  pg_temp.app_links('owner') = '{"links":[]}'::jsonb
  and (pg_temp.state() @> '{"app_links_available":false,"program":null}'),
  'before attribution is on, the program form has no app link to offer');
select pg_temp.call('owner', format('select public.attribution_enable(%L, %L)', pg_temp.q('project'), 'fluent'));
select pg_temp.call('owner', format('select public.attribution_update(%L, %L)', pg_temp.q('project'),
  '{"android_package":"io.fluent.app","android_sha256":["14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5"],"web_url":"https://fluent-app.io/start"}'::jsonb));
select pg_temp.check(pg_temp.app_links('owner') = '{"links":[]}'::jsonb,
  'attribution on with no smart link yet: still nothing to offer');
insert into qa select 'link_id', pg_temp.call('owner', format('select public.attribution_save_link(%L, null, %L)', pg_temp.q('project'),
  '{"path":"get-app","name":"Get the app","source":"creators","campaign":"launch","deep_link_value":"lesson"}'::jsonb))->>'id';
insert into qa select 'old_link_id', pg_temp.call('owner', format('select public.attribution_save_link(%L, null, %L)', pg_temp.q('project'),
  '{"path":"old-promo","name":"Old promo","source":"creators"}'::jsonb))->>'id';
select pg_temp.call('owner', format('select public.attribution_set_link_status(%L, %L)', pg_temp.q('old_link_id'), 'paused'));
insert into qa values ('app_link_url', 'https://fluent.go.kissmyapps.dev/get-app');

select pg_temp.capture('workspace_program_app_links.listed', pg_temp.app_links('owner'));
select pg_temp.check(pg_temp.app_links('owner') = jsonb_build_object('links', jsonb_build_array(jsonb_build_object(
    'id', pg_temp.q('link_id'), 'url', 'https://fluent.go.kissmyapps.dev/get-app', 'name', 'Get the app',
    'project_id', pg_temp.q('project'), 'project_name', 'Fluent', 'ios', false, 'android', true))),
  'the program form offers the active smart link of the Android app, and not the paused one');
select pg_temp.call('owner', format('select public.attribution_update(%L, %L)', pg_temp.q('project'), '{"ios_app_store_id":"1234567890"}'::jsonb));
select pg_temp.check(pg_temp.app_links('owner')->'links'->0 @> '{"ios":true,"android":true}',
  'with an App Store ID the same link is also for iPhone');
select pg_temp.call('owner', format('select public.attribution_disable(%L)', pg_temp.q('project')));
select pg_temp.check(pg_temp.app_links('owner') = '{"links":[]}'::jsonb and pg_temp.state() @> '{"app_links_available":false}',
  'with attribution off its links are not offered');
select pg_temp.call('owner', format('select public.attribution_enable(%L, %L)', pg_temp.q('project'), 'fluent'));
select pg_temp.check(pg_temp.state() @> '{"app_links_available":true,"program":null}',
  'with attribution back on, the form is told an app link is available before there is a program');
select pg_temp.check(
  pg_temp.try('creator', format('select public.workspace_program_app_links(%L)', pg_temp.q('workspace'))) like 'P0002%'
  and pg_temp.try('owner', 'select public.workspace_program_app_links(null)') like 'P0002%'
  and pg_temp.try_as('anon', format('select public.workspace_program_app_links(%L)', pg_temp.q('workspace'))) = '42501'
  and pg_temp.try_as('service_role', format('select public.workspace_program_app_links(%L)', pg_temp.q('workspace'))) = '42501',
  'only people of the workspace read its app links');

-- Somebody already uses the app: its events reach the merchant's analytics --------------------------
select pg_temp.app('anon-early', null, 'sess-early', clock_timestamp(),
  array['session_started', 'app_installed', 'app_opened', 'signup_completed']);
select pg_temp.check(
  (select count(*) = 4 from public.analytics_events where project_id = pg_temp.q('project'))
  and (select count(*) = 0 from public.program_reward_queue),
  'the app''s events are stored, and with no program paying for them nothing waits to be judged');

-- KissMyApps switches program money on --------------------------------------------------------------
select pg_temp.check(
  (select m @> '{"enabled":true,"fee_bps":1000}'
    from pg_temp.call('kma_owner', format('select public.configure_admin_program_money(%L)', jsonb_build_object('enabled', true,
      'expected_updated_at', pg_temp.call('kma_owner', 'select public.get_admin_program_money()')->'updated_at'))) m),
  'the KissMyApps owner switches program money on with a 10% fee');

-- The merchant makes an app program: the landing page is the smart link ------------------------------
select pg_temp.capture('workspace_program_reward_events.with_app_events', pg_temp.reward_events());
select pg_temp.check(
  (select bool_and(case e->>'name' when 'app_installed' then e->>'suggested_label' = 'App installed'
      when 'app_opened' then e->>'suggested_label' = 'App opened'
      else e ? 'suggested_label' and e->'suggested_label' = 'null' end)
    and count(*) = 4 and bool_and(e ?& array['name', 'description', 'first_seen', 'last_seen'])
    from jsonb_array_elements(pg_temp.reward_events()->'events') e),
  'the event picker suggests "App installed" and "App opened" for the events the app SDK sends, and nothing for the rest');
select pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
  jsonb_build_object('name', 'Fluent', 'category', 'education', 'tagline', 'Speak a new language in a month.',
    'landing_url', pg_temp.t('app_link_url'), 'earn_from', 'events', 'hold_days', 14,
    'rewards', '[{"key":"app_installed","label":"App installed","amount_minor":150},
                 {"key":"signup_completed","label":"Account created","amount_minor":200}]'::jsonb,
    'reward_budget_minor', 10000)));
select pg_temp.capture('workspace_program_get.app_program', pg_temp.state());
select pg_temp.check(
  (select s->'program'->'app_link' = jsonb_build_object('id', pg_temp.q('link_id'), 'url', pg_temp.t('app_link_url'), 'name', 'Get the app')
      and (s->>'app_links_available')::boolean and s->'program'->>'landing_url' = pg_temp.t('app_link_url')
      and s->'program' @> '{"earn_from":"events","status":"draft","rewards":[{"key":"app_installed","label":"App installed","amount_minor":150}]}'
    from pg_temp.state() s),
  'the saved program says its landing page is the app''s smart link "Get the app"');
select pg_temp.save(jsonb_build_object('landing_url', 'https://FLUENT.go.kissmyapps.dev/Get-App/?utm_source=creators'));
select pg_temp.check(pg_temp.state()->'program'->'app_link'->>'url' = pg_temp.t('app_link_url'),
  'the same link written with capitals, a trailing slash and a query is still the app link, with its own address');
select pg_temp.save('{"landing_url":"https://fluent-app.io/start"}'::jsonb);
select pg_temp.check((select s->'program'->'app_link' = 'null' and (s->>'app_links_available')::boolean from pg_temp.state() s),
  'a web landing page is not an app link, and the form still offers the app');
select pg_temp.save('{"landing_url":"https://fluent.go.kissmyapps.dev/old-promo"}'::jsonb);
select pg_temp.check(pg_temp.state()->'program'->'app_link' = 'null', 'a paused smart link is not an app link');
select pg_temp.save(jsonb_build_object('landing_url', pg_temp.t('app_link_url')));
select pg_temp.call('owner', format('select public.workspace_program_mark_agreement_read(%L, %L)', pg_temp.q('workspace'),
  pg_temp.call('owner', format('select public.workspace_program_agreement(%L)', pg_temp.q('workspace')))->>'sha256'));
select pg_temp.check(
  (select d @> '{"status":"succeeded","amount_minor":5000}' from pg_temp.deposit('first', 5000) d),
  'the merchant pays 50.00 into the balance');
select pg_temp.call('owner', format('select public.workspace_program_submit(%L, %s)', pg_temp.q('workspace'), (pg_temp.program()).revision));
select pg_temp.call('kma_owner', format('select public.review_admin_program(%L)',
  jsonb_build_object('program_id', (pg_temp.program()).id, 'decision', 'approve', 'note', null)));
select pg_temp.check((pg_temp.program()).status = 'live'
  and (select count(*) = 2 from public.program_reward_events
    where project_id = pg_temp.q('project') and event_name in ('app_installed', 'signup_completed'))
  and (pg_temp.state()->'program'->'app_link'->>'name') = 'Get the app',
  'once approved the app program is live and the intake knows it pays for app_installed and signup_completed');

-- A creator joins -----------------------------------------------------------------------------------
insert into qa select 'shown', pg_temp.call('creator',
  format('select public.partner_program_detail(%L)', (pg_temp.program()).slug))::text;
insert into qa select 'link_url', pg_temp.call('creator', format('select public.partner_program_join(%L)',
  jsonb_build_object('slug', d->'program'->>'slug', 'terms_version', d->'program'->'terms_version',
    'agreement_sha256', d->'program'->>'agreement_sha256')))->'membership'->'link'->>'url'
from (select pg_temp.t('shown')::jsonb as d) x;
select pg_temp.check(pg_temp.t('link_url') like 'https://go.kissmyapps.dev/r/app-install-creator/%'
  and (select d->'program' @> '{"earn_from":"events","rewards":[{"key":"app_installed","label":"App installed","amount_minor":150}]}'
    from (select pg_temp.t('shown')::jsonb d) x),
  'the creator reads that an install pays 1.50, accepts the agreement and has a link');

-- The smart link keeps the creator's click -----------------------------------------------------------
-- (A statement sees what the functions it calls wrote only through other function calls, so
-- each step below that writes runs on its own, and what it did is looked at afterwards.)
insert into qa select 'ann_creator_click', c->>'click_id' from pg_temp.creator_click() c;
select pg_temp.check(pg_temp.t('ann_creator_click') ~ '^[0-9a-f]{48}$'
  and (select c->>'destination_url' = pg_temp.t('app_link_url') from pg_temp.creator_click() c),
  'the creator''s redirect sends the person on to the smart link, the program''s landing page');
insert into qa select 'recorded', pg_temp.record_clicks(jsonb_build_array(
    jsonb_build_object('id', 'KeepCreatorClick0001', 'link_id', pg_temp.t('link_id'), 'platform', 'android',
      'destination', 'play_store', 'clicked_at', pg_temp.iso(clock_timestamp()),
      'params', jsonb_build_object('creator_click', pg_temp.t('ann_creator_click'), 'sub1', 'story')),
    jsonb_build_object('id', 'DropCreatorClick0002', 'link_id', pg_temp.t('link_id'), 'platform', 'android',
      'destination', 'play_store', 'clicked_at', pg_temp.iso(clock_timestamp()),
      'params', jsonb_build_object('creator_click', upper(pg_temp.t('ann_creator_click')), 'sub1', 'story')),
    jsonb_build_object('id', 'DropCreatorClick0003', 'link_id', pg_temp.t('link_id'), 'platform', 'ios',
      'destination', 'app_store', 'clicked_at', pg_temp.iso(clock_timestamp()),
      'params', jsonb_build_object('creator_click', left(pg_temp.t('ann_creator_click'), 47))),
    jsonb_build_object('id', 'DropCreatorClick0004', 'link_id', pg_temp.t('link_id'), 'platform', 'desktop',
      'destination', 'web', 'clicked_at', pg_temp.iso(clock_timestamp()),
      'params', jsonb_build_object('creator_click', 123456789012345678901234567890123456789012345678::numeric)),
    jsonb_build_object('id', 'DropCreatorClick0005', 'link_id', pg_temp.t('link_id'), 'platform', 'desktop',
      'destination', 'web', 'clicked_at', pg_temp.iso(clock_timestamp()),
      'params', jsonb_build_object('creator_click', '<script>', 'dl', 'lesson-2'))));
select pg_temp.check(pg_temp.t('recorded') = '5'
  and (select c.params = jsonb_build_object('sub1', 'story', 'creator_click', pg_temp.t('ann_creator_click'))
    from public.attribution_clicks c where c.id = 'KeepCreatorClick0001')
  and (select c.params = '{"sub1":"story"}' from public.attribution_clicks c where c.id = 'DropCreatorClick0002')
  and (select bool_and(c.params = '{}') from public.attribution_clicks c where c.id in ('DropCreatorClick0003', 'DropCreatorClick0004'))
  and (select c.params = '{"dl":"lesson-2"}' and c.source = 'creators' and c.campaign = 'launch'
    from public.attribution_clicks c where c.id = 'DropCreatorClick0005'),
  'a smart-link click keeps a creator click of 48 lowercase hex characters and drops anything else, and keeps the rest as before');

-- Ann: the app's events reach us before its install call ---------------------------------------------
insert into qa values ('ann_at', pg_temp.iso(clock_timestamp() + interval '1 minute'));
select pg_temp.smart_click('AnnSmartLinkClick001', 'android', 'play_store', pg_temp.t('ann_creator_click'), clock_timestamp());
select pg_temp.app('anon-ann', null, 'sess-ann', pg_temp.t('ann_at')::timestamptz,
  array['session_started', 'app_installed', 'app_opened']);
select pg_temp.check((select count(*) = 1 from public.program_reward_queue q where q.event_name = 'app_installed'),
  'the first launch''s app_installed is queued to be judged');
select pg_temp.check(pg_temp.tick() @> '{"judged":1,"earned":0,"remaining":0}', 'the minute tick judges it before the install call arrives');
select pg_temp.check(not exists (select 1 from pg_temp.awards_of('anon-ann'))
    and not exists (select 1 from public.program_reward_queue),
  'judged before the install is matched, Ann''s install names no creator and nothing is written');
insert into qa select 'ann_install', pg_temp.install('anon-ann', null, 'sess-ann', pg_temp.t('ann_at')::timestamptz, 'android-id-ann',
  'kma_lc=AnnSmartLinkClick001&utm_source=creators&utm_campaign=launch')::text;
select pg_temp.check(pg_temp.t('ann_install')::jsonb @> '{"matched":true,"method":"install_referrer"}'
  and (pg_temp.install_of('anon-ann')).creator_click = pg_temp.t('ann_creator_click')
  and (pg_temp.install_of('anon-ann')).verdict = 'counted'
  and (pg_temp.session('sess-ann')).creator_click = pg_temp.t('ann_creator_click')
  and (select count(*) = 1 from public.program_reward_queue q where q.person_id = pg_temp.person('anon-ann')
    and q.event_name = 'app_installed'),
  'the install call matches Ann''s install to the creator''s smart-link click: her app session gets the creator click and her install is queued again');
select pg_temp.check(pg_temp.tick() @> '{"judged":1,"earned":1,"remaining":0}', 'the minute tick judges it again and it earns');
select pg_temp.check(
  (select w.status = 'earned' and w.reward_key = 'app_installed' and w.reward_label = 'App installed' and w.amount_minor = 150
      and w.affiliate_id = 'ec890000-0000-4000-8000-000000000001'
      and w.click_record_id = (select c.id from public.clicks c where c.public_click_id = pg_temp.t('ann_creator_click'))
      and (pg_temp.commission_of(w.id)).status = 'held' and (pg_temp.commission_of(w.id)).amount_minor = 150
      and (pg_temp.commission_of(w.id)).fee_minor = 15
      and (pg_temp.commission_of(w.id)).hold_until between now() + interval '13 days 23 hours' and now() + interval '14 days 1 hour'
    from pg_temp.awards_of('anon-ann') w),
  'Ann''s install earns the creator 1.50 with a 0.15 fee on top, held for the 14 days of the terms');
select pg_temp.check(
  (select b->'account' @> '{"available_minor":4835,"reserved_minor":165,"creators_pending_minor":150,"fees_minor":15}'
    from pg_temp.balance() b),
  'the reward and the fee are set aside from the merchant''s balance the moment it earns');
select kma_internal.attribution_install_matched((pg_temp.install_of('anon-ann')).id);
select pg_temp.check((select count(*) = 0 from public.program_reward_queue),
  'matching Ann''s install again queues nothing: her install has its award');

-- Ann signs up on a later launch --------------------------------------------------------------------
select pg_temp.app('anon-ann', 'u-ann', 'sess-ann-2', clock_timestamp() + interval '2 minutes',
  array['session_started', 'app_opened', 'signup_completed']);
select pg_temp.check(pg_temp.tick() @> '{"judged":1,"earned":1,"remaining":0}', 'her sign-up is judged and earns');
select pg_temp.check(
  (select w.status = 'earned' and w.amount_minor = 200 and (pg_temp.commission_of(w.id)).amount_minor = 200
    from pg_temp.awards_of('u-ann') w where w.reward_key = 'signup_completed'),
  'her sign-up in the app earns the creator 2.00');

-- Bea: the install call reaches us before the app's events -------------------------------------------
insert into qa select 'bea_creator_click', c->>'click_id' from pg_temp.creator_click() c;
insert into qa values ('bea_at', pg_temp.iso(clock_timestamp() + interval '1 minute'));
select pg_temp.smart_click('BeaSmartLinkClick001', 'android', 'play_store', pg_temp.t('bea_creator_click'), clock_timestamp());
insert into qa select 'bea_install', pg_temp.install('anon-bea', null, 'sess-bea', pg_temp.t('bea_at')::timestamptz,
  'android-id-bea', 'kma_lc=BeaSmartLinkClick001')::text;
select pg_temp.check(pg_temp.t('bea_install')::jsonb @> '{"matched":true,"method":"install_referrer"}'
  and (pg_temp.install_of('anon-bea')).creator_click = pg_temp.t('bea_creator_click')
  and pg_temp.session('sess-bea') is null
  and (select count(*) = 0 from public.program_reward_queue),
  'Bea''s install is matched before her app session exists, and nothing waits to be judged yet');
select pg_temp.app('anon-bea', null, 'sess-bea', pg_temp.t('bea_at')::timestamptz, array['session_started', 'app_installed', 'app_opened']);
select pg_temp.check(pg_temp.tick() @> '{"judged":1,"earned":1,"remaining":0}', 'her app_installed arrives, is judged and earns');
select pg_temp.check((pg_temp.session('sess-bea')).creator_click is null
  and (select w.status = 'earned' and w.amount_minor = 150
      and w.click_record_id = (select c.id from public.clicks c where c.public_click_id = pg_temp.t('bea_creator_click'))
    from pg_temp.awards_of('anon-bea') w),
  'her app session has no creator click of its own, yet her install names the creator: 1.50');

-- Ann reinstalls the app on the same phone ----------------------------------------------------------
insert into qa values ('again_at', pg_temp.iso(clock_timestamp() + interval '3 minutes'));
insert into qa select 'again_install', pg_temp.install('anon-ann-again', null, 'sess-ann-again', pg_temp.t('again_at')::timestamptz,
  'android-id-ann', null)::text;
select pg_temp.check(pg_temp.t('again_install')::jsonb @> '{"method":"reinstall"}'
  and (pg_temp.install_of('anon-ann-again')).creator_click = pg_temp.t('ann_creator_click')
  and (pg_temp.install_of('anon-ann-again')).reinstall_of = (pg_temp.install_of('anon-ann')).id,
  'the same phone installs again: a reinstall of Ann''s install, which still names the creator');
select pg_temp.app('anon-ann-again', null, 'sess-ann-again', pg_temp.t('again_at')::timestamptz,
  array['session_started', 'app_installed', 'app_opened']);
select pg_temp.check(pg_temp.tick() @> '{"judged":1,"earned":0,"remaining":0}', 'the reinstall''s app_installed is judged and earns nothing');
select pg_temp.check(
  (select w.status = 'not_earned' and w.reason = 'already_rewarded' and pg_temp.commission_of(w.id) is null
    from pg_temp.awards_of('anon-ann-again') w),
  'a reinstall earns nothing: the install of that phone was already rewarded');

-- Rex: an install rejected as fraud (the click came after the install began) -------------------------
insert into qa select 'rex_creator_click', c->>'click_id' from pg_temp.creator_click() c;
insert into qa values ('rex_click_at', clock_timestamp()::text), ('rex_at', pg_temp.iso(clock_timestamp() + interval '1 minute'));
select pg_temp.smart_click('RexSmartLinkClick001', 'android', 'play_store', pg_temp.t('rex_creator_click'),
  pg_temp.t('rex_click_at')::timestamptz);
select pg_temp.app('anon-rex', null, 'sess-rex', pg_temp.t('rex_at')::timestamptz, array['session_started', 'app_installed', 'app_opened']);
insert into qa select 'rex_install', pg_temp.install('anon-rex', null, 'sess-rex', pg_temp.t('rex_at')::timestamptz, 'android-id-rex',
  'kma_lc=RexSmartLinkClick001', floor(extract(epoch from pg_temp.t('rex_click_at')::timestamptz))::bigint - 30)::text;
select pg_temp.check(pg_temp.t('rex_install')::jsonb @> '{"method":"install_referrer"}'
  and (pg_temp.install_of('anon-rex')).verdict = 'rejected' and (pg_temp.install_of('anon-rex')).creator_click is null
  and (pg_temp.session('sess-rex')).creator_click is null,
  'Rex''s install began before the click that claims it: it is rejected and names nobody');
select pg_temp.check(pg_temp.tick() @> '{"judged":1,"earned":0,"remaining":0}', 'his app_installed is judged');
select pg_temp.check(not exists (select 1 from pg_temp.awards_of('anon-rex')), 'a rejected install earns nothing');

-- Rae: she came through the creator's link on the web, then her install was rejected ----------------
insert into qa select 'rae_creator_click', c->>'click_id' from pg_temp.creator_click() c;
select pg_temp.smart_click('RaeSmartLinkClick001', 'desktop', 'web', pg_temp.t('rae_creator_click'), clock_timestamp());
select pg_temp.web('anon-rae-web', 'u-rae', 'sess-rae-web', clock_timestamp(),
  jsonb_build_object('kma_lc', 'RaeSmartLinkClick001', 'kma_click', pg_temp.t('rae_creator_click')), array['page_viewed']);
insert into qa values ('rae_fraud_at', clock_timestamp()::text), ('rae_at', pg_temp.iso(clock_timestamp() + interval '1 minute'));
select pg_temp.smart_click('RaeInjectedClick0001', 'android', 'play_store', null, pg_temp.t('rae_fraud_at')::timestamptz);
insert into qa select 'rae_install', pg_temp.install('anon-rae-app', 'u-rae', 'sess-rae-app', pg_temp.t('rae_at')::timestamptz,
  'android-id-rae', 'kma_lc=RaeInjectedClick0001',
  floor(extract(epoch from pg_temp.t('rae_fraud_at')::timestamptz))::bigint - 30)::text;
select pg_temp.check(pg_temp.t('rae_install')::jsonb @> '{"method":"install_referrer"}'
  and (pg_temp.install_of('u-rae')).verdict = 'rejected'
  and (pg_temp.session('sess-rae-web')).creator_click = pg_temp.t('rae_creator_click'),
  'Rae, signed in, came from the creator''s link on the web; another click claims her install after it began, so it is rejected');
select pg_temp.app('anon-rae-app', 'u-rae', 'sess-rae-app', pg_temp.t('rae_at')::timestamptz,
  array['session_started', 'app_installed', 'app_opened']);
select pg_temp.check(pg_temp.tick() @> '{"judged":1,"earned":0,"remaining":0}', 'her app_installed is judged and earns nothing');
select pg_temp.check(
  (select w.status = 'not_earned' and w.reason = 'install_rejected' and w.reward_key = 'app_installed'
      and w.affiliate_id = 'ec890000-0000-4000-8000-000000000001' and pg_temp.commission_of(w.id) is null
    from pg_temp.awards_of('u-rae') w),
  'the creator''s earlier web click finds Rae, but an install rejected as fraud earns nothing (install_rejected)');

-- Sam: an app without the install call (SDK 1.0) still pays through the creator's web click -------
insert into qa select 'sam_creator_click', c->>'click_id' from pg_temp.creator_click() c;
select pg_temp.smart_click('SamSmartLinkClick001', 'desktop', 'web', pg_temp.t('sam_creator_click'), clock_timestamp());
select pg_temp.web('anon-sam-web', 'u-sam', 'sess-sam-web', clock_timestamp(),
  jsonb_build_object('kma_lc', 'SamSmartLinkClick001', 'kma_click', pg_temp.t('sam_creator_click')), array['page_viewed']);
select pg_temp.app('anon-sam-app', 'u-sam', 'sess-sam-app', clock_timestamp() + interval '1 minute',
  array['session_started', 'app_installed', 'app_opened']);
select pg_temp.check(pg_temp.tick() @> '{"judged":1,"earned":1,"remaining":0}', 'Sam''s app_installed is judged and earns');
select pg_temp.check(pg_temp.install_of('u-sam') is null
  and (select w.status = 'earned' and w.amount_minor = 150
      and w.click_record_id = (select c.id from public.clicks c where c.public_click_id = pg_temp.t('sam_creator_click'))
    from pg_temp.awards_of('u-sam') w),
  'a person with no install row is judged by the Phase 6 rules alone: Sam''s install earns 1.50 through the creator''s web click');

-- The install hook never fails its caller ---------------------------------------------------------
select kma_internal.attribution_install_matched(null);
select kma_internal.attribution_install_matched('00000000-0000-4000-8000-000000000000');
select kma_internal.attribution_install_matched((pg_temp.install_of('anon-rex')).id);
select kma_internal.attribution_install_matched((pg_temp.install_of('u-rae')).id);
select pg_temp.check(
  (select count(*) = 0 from public.program_reward_queue)
  and pg_temp.try_as('service_role', format('select kma_internal.attribution_install_matched(%L)',
    (pg_temp.install_of('anon-ann')).id)) = '42501'
  and pg_temp.try_as('authenticated', format('select kma_internal.attribution_install_matched(%L)',
    (pg_temp.install_of('anon-ann')).id)) = '42501',
  'the install hook does nothing for an unknown or rejected install, never raises, and no API role can call it');

-- What everyone sees ------------------------------------------------------------------------------
select pg_temp.check(
  (select r->'rewards' @> '[{"key":"app_installed","count":3,"amount_total_minor":450},{"key":"signup_completed","count":1,"amount_total_minor":200}]'
      and (select count(*) = 4 from jsonb_array_elements(r->'awards') a where a @> '{"status":"pending"}')
      and exists (select 1 from jsonb_array_elements(r->'awards') a
        where a @> '{"status":"not_counted","reason":"already_rewarded","reward_key":"app_installed"}')
      and exists (select 1 from jsonb_array_elements(r->'awards') a
        where a @> '{"status":"not_counted","reason":"install_rejected","reward_key":"app_installed","link_name":"Main link"}')
      and r->'creators'->0 @> '{"name":"Mira Maker","earned_minor":650,"pending_minor":650}'
    from pg_temp.rewards() r),
  'the merchant''s Rewards page counts three installs and a sign-up, and says why the reinstall and the rejected install did not count');
select pg_temp.check(
  (select e->'programs'->0 @> '{"name":"Fluent","pending_minor":650,"approved_minor":0,"events":4,"sales":0}'
      and exists (select 1 from jsonb_array_elements(e->'recent') r
        where r @> '{"kind":"reward","reward_label":"App installed","amount_minor":150,"status":"held"}')
    from pg_temp.earnings() e)
  and (select p->'totals' @> '{"events":4,"earnings_minor":650}'
      and p->'rewards' @> '[{"key":"app_installed","count":3},{"key":"signup_completed","count":1}]'
    from pg_temp.performance() p),
  'the creator''s Earnings and Performance pages show 6.50 pending from three installs and a sign-up');
select pg_temp.check(
  (select bool_and(not (x::text ~* '(anon-|u-ann|u-rae|u-sam|sess-|SmartLinkClick|InjectedClick|android-id|io\.fluent|kma_lc|example\.test|person_id|event_id|device|install_referrer|reinstall|session)'))
    from (values (pg_temp.earnings()), (pg_temp.performance()), (pg_temp.links()), (pg_temp.t('shown')::jsonb)) v(x))
  and (select bool_and(not (x::text like '%' || i.device_hash || '%') and not (x::text like '%' || i.person_id::text || '%'))
    from public.attribution_installs i
    cross join (values (pg_temp.earnings()), (pg_temp.performance()), (pg_temp.links()), (pg_temp.rewards())) v(x)),
  'no person, device, session, event or smart-link click reaches the creator, and no person or device reaches the merchant''s Rewards page');

-- Every cent is accounted for ----------------------------------------------------------------------
select pg_temp.check(
  (select a.available_minor = (select sum(e.amount_minor) from public.program_balance_entries e where e.account_id = a.id)
      and a.available_minor = 5000 - 150 - 15 - 200 - 20 - 150 - 15 - 150 - 15
    from pg_temp.account() a)
  and public.program_balance_health()->>'ledger_mismatches' = '0'
  and public.program_reward_health() @> '{"ledger_mismatches":0,"events_out_of_step":0}'
  and (public.program_reward_health()->'queue') @> '{"due":0,"failing":0}',
  'the balance equals its entries, deposits less rewards and fees is what is left, and nothing waits or drifts');

select format('ok %s program app install assertions', count(*)) from app_install_assertions;
rollback;
