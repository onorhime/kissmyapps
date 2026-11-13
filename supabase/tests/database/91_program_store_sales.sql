-- Phase 8 in-app subscriptions working with Phases 1 to 7, through the real functions: the
-- merchant's app sells a monthly subscription in the App Store and Google Play through
-- RevenueCat and Adapty. The merchant's project has attribution on and a smart link; the
-- program pays for sales (and one event); a creator joins; a person opens the creator's link,
-- the smart link keeps the creator's click, the app's install call is matched to it (Phase 7)
-- and the app identifies the person with the user ID RevenueCat knows them by. The merchant
-- connects RevenueCat and Adapty in the console and the webhook (played here by the
-- normalized body program-store-webhook passes) reports the purchase, a renewal, a refund,
-- a sandbox purchase and purchases nobody can be matched to. RevenueCat and Adapty are never
-- called.
begin;
set local time zone 'UTC';
create temporary table store_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program store sales assertion failed: %', label; end if;
  insert into store_assertions values (label);
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
-- The operator view, as the service role reads it.
create function pg_temp.health() returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  result := public.program_sales_health();
  reset role;
  return result;
end $$;
create function pg_temp.program() returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q('workspace')
$$;
create function pg_temp.account() returns public.program_balance_accounts language sql as $$
  select a from public.program_balance_accounts a where a.program_id = (pg_temp.program()).id
$$;
create function pg_temp.balance() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_balance(%L)', pg_temp.q('workspace')))
$$;
create function pg_temp.sales() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_sales(%L, %L)', pg_temp.q('workspace'), '{}'::jsonb))
$$;
create function pg_temp.connections(who text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_store_connections(%L)', pg_temp.q('workspace')))
$$;
create function pg_temp.earnings() returns jsonb language sql as $$
  select pg_temp.call('creator', 'select public.partner_program_earnings()')
$$;
create function pg_temp.performance() returns jsonb language sql as $$
  select pg_temp.call('creator', format('select public.partner_program_performance(%L)',
    jsonb_build_object('slug', (pg_temp.program()).slug, 'days', 30)))
$$;
-- Saves, reads the agreement, submits and has KissMyApps approve, as suite 76 publishes.
create function pg_temp.publish(input jsonb) returns void language plpgsql as $$
begin
  perform pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
    input || case when (pg_temp.program()).id is null then '{}'::jsonb
      else jsonb_build_object('revision', (pg_temp.program()).revision) end));
  perform pg_temp.call('owner', format('select public.workspace_program_mark_agreement_read(%L, %L)', pg_temp.q('workspace'),
    pg_temp.call('owner', format('select public.workspace_program_agreement(%L)', pg_temp.q('workspace')))->>'sha256'));
  perform pg_temp.call('owner', format('select public.workspace_program_submit(%L, %s)', pg_temp.q('workspace'),
    (pg_temp.program()).revision));
  if (pg_temp.program()).status = 'in_review' then
    perform pg_temp.call('kma_owner', format('select public.review_admin_program(%L)',
      jsonb_build_object('program_id', (pg_temp.program()).id, 'decision', 'approve')));
  end if;
end $$;
-- A moment as the phone's clock writes it.
create function pg_temp.iso(at timestamptz) returns text language sql immutable as $$
  select to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
create function pg_temp.epoch(at timestamptz) returns bigint language sql immutable as $$
  select floor(extract(epoch from at))::bigint
$$;
create function pg_temp.sha256(value text) returns text language sql immutable as $$
  select encode(extensions.digest(value, 'sha256'), 'hex')
$$;
-- A person opens the creator's main link, as the tracking-redirect function asks for it.
create function pg_temp.creator_click() returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select to_jsonb(r) into result from public.register_tracking_click('store-sales-creator',
    split_part(pg_temp.t('link_url'), '/', 6), '{}'::jsonb) r;
  reset role;
  return result;
end $$;
-- The link service records one click on the smart link, opened from the creator's redirect.
create function pg_temp.smart_click(click_id text, creator_click text, at timestamptz) returns integer
language plpgsql as $$
declare result integer;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  result := public.attribution_record_clicks(jsonb_build_array(jsonb_build_object(
    'id', click_id, 'link_id', pg_temp.t('link_id'), 'platform', 'android', 'destination', 'play_store',
    'clicked_at', pg_temp.iso(at), 'params', jsonb_build_object('creator_click', creator_click),
    'user_agent', 'Mozilla/5.0 (Linux; Android 15; Pixel 9)')));
  reset role;
  return result;
end $$;
-- One request from the Android SDK: the person, the session and the named events.
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
      'context', jsonb_build_object('platform', 'android', 'sdk', 'kma-android/1.1.0', 'device_type', 'mobile',
        'os_name', 'Android', 'app_version', '2.4.0'),
      'events', coalesce((select jsonb_agg(jsonb_build_object('name', e, 'insert_id', session || ':' || e || ':' || i,
        'time', pg_temp.iso(at + make_interval(secs => (i - 1) * 0.01)), 'properties', '{}'::jsonb) order by i)
        from unnest(events) with ordinality u(e, i)), '[]'::jsonb))));
  reset role;
  return result;
end $$;
-- One request from the web SDK on the merchant's site, with the creator click of its landing page.
create function pg_temp.web(anon text, user_id text, session text, at timestamptz, creator_click text) returns jsonb
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
        'page_path', '/start', 'click', jsonb_build_object('kma_click', creator_click)),
      'events', jsonb_build_array(jsonb_build_object('name', 'page_viewed', 'insert_id', session || ':page',
        'time', pg_temp.iso(at), 'properties', '{}'::jsonb)))));
  reset role;
  return result;
end $$;
-- The Android SDK's install call on first launch, through the real attribution_install.
create function pg_temp.install(anon text, session text, at timestamptz, device text, referrer text) returns jsonb
language sql as $$
  select pg_temp.svc('attribution_install', jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.t('ingest_key'), 'sha256'), 'hex'),
    'body', jsonb_build_object('anonymous_id', anon, 'session_id', session, 'platform', 'android',
      'installed_at', pg_temp.iso(at), 'sdk', 'kma-android/1.1.0', 'app_version', '2.4.0',
      'device_key', encode(extensions.digest(device, 'sha256'), 'hex'), 'referrer', referrer),
    'geo', '{}'::jsonb, 'clock_skew_ms', 0))
$$;
create function pg_temp.person(known_as text) returns uuid language sql as $$
  select pe.id from public.analytics_people pe
  where pe.project_id = pg_temp.q('project') and (pe.distinct_id = known_as or pe.anonymous_ids @> array[known_as])
$$;
create function pg_temp.session(key text) returns public.analytics_sessions language sql as $$
  select s from public.analytics_sessions s where s.project_id = pg_temp.q('project') and s.session_key = key
$$;
-- A person whose creator touch came from the creator's link: a creator click, the smart-link
-- click that carries it, the install call matched to that click by the install referrer, and
-- a later launch that signs the person in with the user ID the store tool knows them by.
create function pg_temp.creator_install(name text) returns void language plpgsql as $$
declare
  v_click text := pg_temp.creator_click()->>'click_id';
  v_smart text := initcap(name) || 'StoreSmartClick01';
begin
  insert into qa values (name || '_creator_click', v_click);
  perform pg_temp.smart_click(v_smart, v_click, clock_timestamp());
  perform pg_temp.install('anon-' || name, 'sess-' || name, clock_timestamp() + interval '1 minute',
    'android-id-' || name, 'kma_lc=' || v_smart || '&utm_source=creators');
  perform pg_temp.app('anon-' || name, 'u-' || name, 'sess-' || name || '-2', clock_timestamp() + interval '1 minute',
    array['session_started', 'app_opened']);
end $$;
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
    'stripe_customer_id', 'cus_StoreSales', 'platform_account_id', 'acct_KMAPlatform'));
  v_begun := pg_temp.svc('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('workspace'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_KMAPlatform', 'amount_minor', amount));
  perform pg_temp.svc('attach_program_topup', jsonb_build_object('topup_id', v_begun->>'topup_id',
    'checkout_session_id', 'cs_live_' || k));
  return pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', v_begun->>'topup_id', 'outcome', 'succeeded',
    'payment_intent_id', 'pi_storedep' || k, 'livemode', true, 'amount_minor', amount, 'currency', 'usd',
    'customer_id', 'cus_StoreSales', 'card', jsonb_build_object('payment_method_id', 'pm_StoreSalesVisa', 'brand', 'visa',
      'last4', '4242', 'exp_month', 4, 'exp_year', 2029)));
end $$;

-- The webhook ---------------------------------------------------------------------------------------
-- What program-store-webhook hands the database for one call: the body it normalized, the
-- SHA-256 of the call's Authorization header and the tool the address names. The header
-- values are the ones the console showed, kept in qa under their name.
create function pg_temp.store(header_key text, provider text, body jsonb) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  result := pg_temp.svc('record_program_store_event', body || jsonb_build_object(
    'header' || '_sha256', pg_temp.sha256(pg_temp.t(header_key)), 'provider', provider));
  perform pg_temp.flush();
  return result;
end $$;
create function pg_temp.store_try(header_key text, provider text, body jsonb) returns text language plpgsql as $$
begin
  perform pg_temp.store(header_key, provider, body);
  return 'ok';
exception when others then
  return sqlstate;
end $$;
-- A RevenueCat purchase of the monthly plan at $9.99 as the webhook normalizes it: 10% tax and
-- a 15% store cut (tax_percentage 0.1, commission_percentage 0.15), so $7.49 of proceeds.
create function pg_temp.rc(event_id text, kind text, app_user text, tx text, original text, at timestamptz,
  extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('event_id', event_id, 'type', kind, 'environment', 'production',
    'app_user_id', app_user, 'aliases', jsonb_build_array('$RCAnonymousID:' || md5(app_user)),
    'store', 'app_store', 'product_id', 'fluent_pro_monthly', 'transaction_id', tx,
    'original_transaction_id', original, 'purchased_at', pg_temp.epoch(at), 'currency', 'USD',
    'amount_minor', 999, 'tax_minor', 100, 'store_fee_minor', 150,
    'usd', jsonb_build_object('amount_minor', 999, 'proceeds_minor', 749), 'refunded_minor', null) || extra
$$;
create function pg_temp.sale(tx text) returns public.program_sales language sql as $$
  select s from public.program_sales s where s.program_id = (pg_temp.program()).id and s.store_transaction_id = tx
$$;
create function pg_temp.commission(tx text) returns public.program_commissions language sql as $$
  select c from public.program_commissions c where c.sale_id = (pg_temp.sale(tx)).id
$$;
create function pg_temp.receipts(outcome text) returns bigint language sql as $$
  select count(*) from public.program_store_events e
  join public.program_store_connections c on c.id = e.connection_id
  where c.workspace_id = pg_temp.q('workspace') and e.outcome = outcome
$$;

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
grant all on qa, store_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('eb910000-0000-4000-8000-000000000001', 'owner@fluent.example.test', now(), '{"company":"Fluent"}'),
  ('eb910000-0000-4000-8000-000000000002', 'dev@fluent.example.test', now(), '{}'),
  ('eb910000-0000-4000-8000-000000000003', 'analyst@fluent.example.test', now(), '{}'),
  ('eb910000-0000-4000-8000-000000000004', 'owner@rival.example.test', now(), '{"company":"Rival"}'),
  ('eb910000-0000-4000-8000-000000000011', 'founder@kma.example.test', now(), '{}'),
  ('eb910000-0000-4000-8000-000000000021', 'mira@creators.example.test', now(), '{}');
insert into qa values ('owner', 'eb910000-0000-4000-8000-000000000001'), ('developer', 'eb910000-0000-4000-8000-000000000002'),
  ('analyst', 'eb910000-0000-4000-8000-000000000003'), ('rival', 'eb910000-0000-4000-8000-000000000004'),
  ('kma_owner', 'eb910000-0000-4000-8000-000000000011'), ('creator', 'eb910000-0000-4000-8000-000000000021');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner');
insert into public.affiliates(id, public_name, slug, status) values
  ('ec910000-0000-4000-8000-000000000001', 'Mira Maker', 'store-sales-creator', 'active');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at) values
  ('ec910000-0000-4000-8000-000000000001', pg_temp.q('creator'), 'owner', true, false, now());
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true;

-- The merchant's app sends its analytics, has attribution on and a smart link ------------------------
select pg_temp.sign_in('owner');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Fluent', array['android', 'ios'], 'UTC') r)
insert into qa select 'project', r->'project'->>'id' from created
union all select 'ingest_key', r->'key'->>('to' || 'ken') from created;
insert into qa select 'web_project', public.analytics_create_project(pg_temp.q('workspace'), 'Fluent web', array['web'], 'UTC')->'project'->>'id';
select pg_temp.sign_in('rival');
insert into qa select 'rival_workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
insert into qa select 'rival_project', public.analytics_create_project(pg_temp.q('rival_workspace'), 'Rival', array['ios'], 'UTC')->'project'->>'id';
select set_config('request.jwt.claims', '', true);
insert into public.analytics_workspace_members(workspace_id, user_id, role) values
  (pg_temp.q('workspace'), pg_temp.q('developer'), 'developer'), (pg_temp.q('workspace'), pg_temp.q('analyst'), 'analyst');
with business as (
  insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
  values ('Fluent Ltd', 'billing@fluent.example.test', pg_temp.q('owner'), pg_temp.q('workspace')) returning id)
insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status, business_name,
  country, charges_enabled, details_submitted, confirmed_at, verified_at)
select id, 'acct_KMAPlatform', true, 'acct_StoreSales', 'active', 'Fluent Ltd', 'GB', true, true, now(), now() from business;
select pg_temp.call('owner', format('select public.attribution_enable(%L, %L)', pg_temp.q('project'), 'fluent'));
select pg_temp.call('owner', format('select public.attribution_update(%L, %L)', pg_temp.q('project'),
  '{"android_package":"io.fluent.app","android_sha256":["14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5"],"ios_app_store_id":"1234567890"}'::jsonb));
insert into qa select 'link_id', pg_temp.call('owner', format('select public.attribution_save_link(%L, null, %L)', pg_temp.q('project'),
  '{"path":"get-app","name":"Get the app","source":"creators","campaign":"launch"}'::jsonb))->>'id';

-- KissMyApps switches program money on --------------------------------------------------------------
select pg_temp.check(
  (select m @> '{"enabled":true,"fee_bps":1000}'
    from pg_temp.call('kma_owner', format('select public.configure_admin_program_money(%L)', jsonb_build_object('enabled', true,
      'expected_updated_at', pg_temp.call('kma_owner', 'select public.get_admin_program_money()')->'updated_at'))) m),
  'the KissMyApps owner switches program money on with a 10% fee');

-- The program: 30% of the first payment, plus one event reward; the landing page is the app link ------
select pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
  jsonb_build_object('name', 'Fluent', 'category', 'education', 'tagline', 'Speak a new language in a month.',
    'landing_url', 'https://fluent.go.kissmyapps.dev/get-app', 'earn_from', 'both', 'hold_days', 14,
    'commission_type', 'percent', 'commission_rate_bps', 3000, 'commission_duration', 'first_payment',
    'rewards', '[{"key":"lesson_completed","label":"Lesson completed","amount_minor":100}]'::jsonb,
    'reward_budget_minor', 10000)));
select pg_temp.check((select d @> '{"status":"succeeded","amount_minor":5000}' from pg_temp.deposit('first', 5000) d),
  'the merchant pays 50.00 into the balance');
select pg_temp.publish('{}'::jsonb);
select pg_temp.check((pg_temp.program()).status = 'live' and (pg_temp.program()).earn_from = 'both'
    and (pg_temp.program()).live_terms_version = 1,
  'the program pays for sales and events, and is live once approved');

-- A creator joins -----------------------------------------------------------------------------------
insert into qa select 'link_url', pg_temp.call('creator', format('select public.partner_program_join(%L)',
  jsonb_build_object('slug', d->'program'->>'slug', 'terms_version', d->'program'->'terms_version',
    'agreement_sha256', d->'program'->>'agreement_sha256')))->'membership'->'link'->>'url'
from (select pg_temp.call('creator', format('select public.partner_program_detail(%L)', (pg_temp.program()).slug)) as d) x;
select pg_temp.check(pg_temp.t('link_url') like 'https://go.kissmyapps.dev/r/store-sales-creator/%',
  'the creator accepts the agreement and has a link');

-- The merchant connects RevenueCat and Adapty in the console ---------------------------------------
select pg_temp.check(pg_temp.connections('owner') = jsonb_build_object('can_manage', true, 'connections', '[]'::jsonb,
    'projects', jsonb_build_array(jsonb_build_object('id', pg_temp.q('project'), 'name', 'Fluent'),
      jsonb_build_object('id', pg_temp.q('web_project'), 'name', 'Fluent web'))),
  'before anything is connected, the console lists the workspace''s projects to connect');
insert into qa select 'rc_created', pg_temp.call('owner', format('select public.workspace_store_connection_create(%L, %L, %L)',
  pg_temp.q('workspace'), pg_temp.q('project'), 'revenuecat'))::text;
insert into qa select 'rc_header', pg_temp.t('rc_created')::jsonb->>'header_value';
insert into qa select 'rc_connection', pg_temp.t('rc_created')::jsonb->>'id';
-- The captured answer carries a placeholder in place of the random header value.
select pg_temp.capture('workspace_store_connection_create.revenuecat',
  pg_temp.t('rc_created')::jsonb || jsonb_build_object('header_value', 'Bearer ' || repeat('K', 43)));
select pg_temp.check(
  (select string_agg(k, ' ' order by k) = 'created_at events_30d header_value id ignored_30d last_event_at project_id '
      || 'project_name provider sales_30d status webhook_url'
      and a @> jsonb_build_object('provider', 'revenuecat', 'project_id', pg_temp.q('project'), 'project_name', 'Fluent',
        'status', 'active', 'events_30d', 0, 'sales_30d', 0, 'ignored_30d', 0, 'last_event_at', null,
        'webhook_url', 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-store-webhook/revenuecat')
      and a->>'header_value' ~ '^Bearer [A-Za-z0-9_-]{43}$'
    from (select pg_temp.t('rc_created')::jsonb as a) x, jsonb_object_keys(a) k group by a),
  'connecting RevenueCat gives the webhook address and a header value "Bearer" and 43 random characters');
select pg_temp.check(
  (select c.header_sha256 = pg_temp.sha256(pg_temp.t('rc_header')) and c.created_by = pg_temp.q('owner')
      and c.workspace_id = pg_temp.q('workspace')
      and not exists (select 1 from public.program_store_connections x, jsonb_each_text(to_jsonb(x)) v
        where v.value like '%' || substr(pg_temp.t('rc_header'), 8) || '%')
    from public.program_store_connections c where c.id = pg_temp.q('rc_connection'))
  and (select count(*) = 1 from public.audit_logs a where a.action = 'program_store_connection_created'
    and a.target_id = pg_temp.q('rc_connection') and not a.after_data::text like '%' || substr(pg_temp.t('rc_header'), 8) || '%'),
  'only the SHA-256 of the header value is kept, and the audit log names the connection without the value');
insert into qa select 'adapty_created', pg_temp.call('owner', format('select public.workspace_store_connection_create(%L, %L, %L)',
  pg_temp.q('workspace'), pg_temp.q('project'), 'adapty'))::text;
insert into qa select 'adapty_header', pg_temp.t('adapty_created')::jsonb->>'header_value';
insert into qa select 'adapty_connection', pg_temp.t('adapty_created')::jsonb->>'id';
select pg_temp.check(pg_temp.t('adapty_header') <> pg_temp.t('rc_header')
    and pg_temp.t('adapty_created')::jsonb->>'webhook_url' like '%/functions/v1/program-store-webhook/adapty',
  'Adapty is connected to the same app with its own address and header value');
select pg_temp.check(
  pg_temp.try('owner', format('select public.workspace_store_connection_create(%L, %L, %L)',
      pg_temp.q('workspace'), pg_temp.q('project'), 'revenuecat')) = '22023 already_connected'
  and pg_temp.try('owner', format('select public.workspace_store_connection_create(%L, %L, %L)',
      pg_temp.q('workspace'), pg_temp.q('project'), 'superwall')) = '22023 invalid_provider'
  and pg_temp.try('owner', format('select public.workspace_store_connection_create(%L, %L, null)',
      pg_temp.q('workspace'), pg_temp.q('project'))) = '22023 invalid_provider'
  and pg_temp.try('owner', format('select public.workspace_store_connection_create(%L, %L, %L)',
      pg_temp.q('workspace'), pg_temp.q('rival_project'), 'revenuecat')) = 'P0002 project_not_found'
  and pg_temp.try('developer', format('select public.workspace_store_connection_create(%L, %L, %L)',
      pg_temp.q('workspace'), pg_temp.q('web_project'), 'revenuecat')) = '42501'
  and pg_temp.try('analyst', format('select public.workspace_store_connection_rotate(%L)', pg_temp.q('rc_connection'))) = '42501'
  and pg_temp.try('developer', format('select public.workspace_store_connection_remove(%L)', pg_temp.q('rc_connection'))) = '42501'
  and pg_temp.try('rival', format('select public.workspace_store_connections(%L)', pg_temp.q('workspace'))) = 'P0002'
  and pg_temp.try('rival', format('select public.workspace_store_connection_rotate(%L)', pg_temp.q('rc_connection'))) = 'P0002'
  and pg_temp.try('rival', format('select public.workspace_store_connection_create(%L, %L, %L)',
      pg_temp.q('workspace'), pg_temp.q('project'), 'revenuecat')) = 'P0002'
  and pg_temp.try('owner', format('select public.workspace_store_connection_rotate(%L)', gen_random_uuid())) = 'P0002 connection_not_found'
  and pg_temp.connections('analyst') @> '{"can_manage":false}' and pg_temp.connections('developer') @> '{"can_manage":false}'
  and jsonb_array_length(pg_temp.connections('analyst')->'connections') = 2
  and not pg_temp.connections('analyst')::text like '%header_value%',
  'one connection per app and tool; only an owner or admin of the workspace connects, rotates or removes, any member reads, and nobody else sees it');
select pg_temp.check(
  (select bool_and(pg_temp.try_as(r, f) = '42501')
    from unnest(array['anon', 'service_role']) r,
      unnest(array[format('select public.workspace_store_connections(%L)', pg_temp.q('workspace')),
        format('select public.workspace_store_connection_create(%L, %L, %L)', pg_temp.q('workspace'), pg_temp.q('project'), 'revenuecat'),
        format('select public.workspace_store_connection_rotate(%L)', pg_temp.q('rc_connection')),
        format('select public.workspace_store_connection_remove(%L)', pg_temp.q('rc_connection'))]) f)
  and (select bool_and(pg_temp.try_as(r, 'select public.record_program_store_event(''{}'')') = '42501')
    from unnest(array['anon', 'authenticated']) r)
  and (select bool_and(not has_table_privilege(r, t, x))
    from unnest(array['anon', 'authenticated', 'service_role']) r,
      unnest(array['public.program_store_connections', 'public.program_store_events']) t,
      unnest(array['select', 'insert', 'update', 'delete']) x)
  and (select bool_and(not has_function_privilege(r, p.oid, 'execute'))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'service_role']) r
    where n.nspname = 'kma_internal' and (p.proname like 'program\_store%' or p.proname = 'program_sale_basis'))
  and (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p
    where p.oid in ('public.record_program_store_event(jsonb)'::regprocedure, 'public.workspace_store_connections(uuid)'::regprocedure,
      'public.workspace_store_connection_create(uuid,uuid,text)'::regprocedure,
      'public.workspace_store_connection_rotate(uuid)'::regprocedure, 'public.workspace_store_connection_remove(uuid)'::regprocedure)),
  'the console functions are for signed-in members, the webhook function for the service role, and no API role reads the tables or the helpers');

-- Ann installs the app from the creator's link and signs in -------------------------------------------
select pg_temp.creator_install('ann');
select pg_temp.check((select i.creator_click = pg_temp.t('ann_creator_click') and i.verdict = 'counted' and i.method = 'install_referrer'
      from public.attribution_installs i where i.person_id = pg_temp.person('u-ann'))
    and (select pe.user_id = 'u-ann' and pe.anonymous_ids @> array['anon-ann'] from public.analytics_people pe where pe.id = pg_temp.person('u-ann'))
    and (pg_temp.session('sess-ann-2')).creator_click is null,
  'Ann''s install is matched to the creator''s smart-link click, and she signs in as u-ann; her app sessions carry no creator click');

-- RevenueCat: Ann's first payment ------------------------------------------------------------------
insert into qa select 'ann_paid_at', (clock_timestamp() + interval '3 minutes')::text;
insert into qa select 'purchase', pg_temp.store('rc_header', 'revenuecat',
  pg_temp.rc('rc-evt-ann-1', 'initial_purchase', 'u-ann', 'rc-ann-1', 'rc-ann-1', pg_temp.t('ann_paid_at')::timestamptz))::text;
select pg_temp.capture('record_program_store_event.purchase', pg_temp.t('purchase')::jsonb);
select pg_temp.check(
  (select a = jsonb_build_object('received', true, 'duplicate', false, 'outcome', 'sale', 'sale_id', (pg_temp.sale('rc-ann-1')).id,
      'subscription_sequence', 1) from (select pg_temp.t('purchase')::jsonb as a) x)
  and (select s.source = 'revenuecat' and s.store = 'app_store' and s.match_source = 'app_user'
      and s.amount_minor = 999 and s.currency = 'USD' and s.tax_minor = 100 and s.store_fee_minor = 150
      and s.store_original_transaction_id = 'rc-ann-1' and s.store_product_id = 'fluent_pro_monthly'
      and s.subscription_sequence = 1 and s.first_sale_id is null
      and s.paid_at = to_timestamp(pg_temp.epoch(pg_temp.t('ann_paid_at')::timestamptz))
      and s.affiliate_id = 'ec910000-0000-4000-8000-000000000001' and s.click_id = pg_temp.t('ann_creator_click')
      and s.click_record_id = (select c.id from public.clicks c where c.public_click_id = pg_temp.t('ann_creator_click'))
      and s.connection_id is null and s.account_id is null and s.payment_intent_id is null
    from pg_temp.sale('rc-ann-1') s),
  'RevenueCat''s purchase by u-ann becomes a sale of the creator who brought her install, matched by her app user ID');
select pg_temp.check(
  (select c.status = 'held' and c.basis_minor = 749 and c.amount_minor = 224 and c.fee_minor = 22 and c.terms_version = 1
      and c.hold_until = (pg_temp.sale('rc-ann-1')).paid_at + interval '14 days'
    from pg_temp.commission('rc-ann-1') c)
  and (select b->'account' @> '{"available_minor":4754,"reserved_minor":246,"creators_pending_minor":224,"fees_minor":22}'
    from pg_temp.balance() b),
  'the commission is 30% of the proceeds (9.99 less 1.00 tax and the 1.50 store cut): 2.24 with a 0.22 fee, set aside from the balance');

-- The same call again, and another call about the same transaction -------------------------------------
select pg_temp.check(
  pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-ann-1', 'initial_purchase', 'u-ann', 'rc-ann-1', 'rc-ann-1',
      pg_temp.t('ann_paid_at')::timestamptz)) = jsonb_build_object('received', true, 'duplicate', true, 'outcome', 'sale',
      'sale_id', (pg_temp.sale('rc-ann-1')).id, 'subscription_sequence', 1)
  and pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-ann-1-again', 'initial_purchase', 'u-ann', 'rc-ann-1', 'rc-ann-1',
      pg_temp.t('ann_paid_at')::timestamptz)) @> jsonb_build_object('duplicate', false, 'outcome', 'sale_exists',
      'sale_id', (pg_temp.sale('rc-ann-1')).id)
  and (select count(*) = 1 from public.program_sales s where s.source = 'revenuecat')
  and (select count(*) = 1 from public.program_commissions),
  'a call RevenueCat sends again changes nothing, and another event about the same transaction makes no second sale');

-- A renewal: the second payment of the subscription earns nothing under "first payment" -----------------
insert into qa select 'renewal', pg_temp.store('rc_header', 'revenuecat',
  pg_temp.rc('rc-evt-ann-2', 'renewal', 'u-ann', 'rc-ann-2', 'rc-ann-1', clock_timestamp() + interval '4 minutes'))::text;
select pg_temp.check(pg_temp.t('renewal')::jsonb @> '{"outcome":"sale","subscription_sequence":2}'
  and (select s.subscription_sequence = 2 and s.first_sale_id = (pg_temp.sale('rc-ann-1')).id and s.match_source = 'subscription'
      and s.affiliate_id = (pg_temp.sale('rc-ann-1')).affiliate_id and s.click_record_id = (pg_temp.sale('rc-ann-1')).click_record_id
    from pg_temp.sale('rc-ann-2') s)
  and (select c.status = 'not_earned' and c.reason = 'outside_duration' and c.amount_minor = 0 from pg_temp.commission('rc-ann-2') c),
  'the renewal is the second payment of Ann''s subscription, the first sale''s creator''s, and earns nothing under "first payment"');

-- The merchant changes the terms to every payment; the creator accepts --------------------------------
select pg_temp.publish('{"commission_duration":"lifetime"}'::jsonb);
select pg_temp.call('creator', format('select public.partner_program_accept_terms(%L)', jsonb_build_object(
  'program_id', (pg_temp.program()).id, 'terms_version', t.version, 'agreement_sha256', t.agreement_sha256)))
from public.affiliate_program_terms t where t.program_id = (pg_temp.program()).id and t.version = (pg_temp.program()).live_terms_version;
select pg_temp.check((pg_temp.program()).live_terms_version = 2 and (pg_temp.program()).status = 'live'
    and (select m.terms_version = 2 from public.affiliate_program_members m where m.program_id = (pg_temp.program()).id),
  'version 2 pays on every payment, and the creator accepts it');
insert into qa select 'third', pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-ann-3', 'renewal', 'u-ann', 'rc-ann-3',
  'rc-ann-1', clock_timestamp() + interval '6 minutes'))::text;
select pg_temp.check(
  pg_temp.t('third')::jsonb @> '{"outcome":"sale","subscription_sequence":3}'
  and (select c.status = 'held' and c.terms_version = 2 and c.amount_minor = 224 and c.fee_minor = 22 from pg_temp.commission('rc-ann-3') c)
  and (select (pg_temp.sale('rc-ann-3')).first_sale_id = (pg_temp.sale('rc-ann-1')).id),
  'the third payment, after the creator accepted version 2, earns 2.24 again');

-- A refund claws back -----------------------------------------------------------------------------
insert into qa select 'refund', pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-ann-refund', 'refund', 'u-ann',
  'rc-ann-1', 'rc-ann-1', pg_temp.t('ann_paid_at')::timestamptz, '{"amount_minor":null,"tax_minor":null,"store_fee_minor":null,
    "refunded_minor":999,"usd":{"amount_minor":999,"proceeds_minor":null}}'::jsonb))::text;
select pg_temp.check(
  pg_temp.t('refund')::jsonb = jsonb_build_object('received', true, 'duplicate', false, 'outcome', 'refund', 'sale_id', (pg_temp.sale('rc-ann-1')).id,
      'subscription_sequence', 1)
  and (select s.refunded_minor = 999 and s.status = 'refunded' from pg_temp.sale('rc-ann-1') s)
  and (select e.kind = 'refund' and e.state = 'succeeded' and e.amount_minor = 999 and e.currency = 'USD'
      and e.stripe_object_id ~ '^store_[0-9a-f]{32}$'
    from public.program_sale_events e where e.sale_id = (pg_temp.sale('rc-ann-1')).id)
  and (select c.status = 'reversed' and c.amount_minor = 0 and c.fee_minor = 0 from pg_temp.commission('rc-ann-1') c)
  and (select b->'account' @> '{"available_minor":4754,"reserved_minor":246,"creators_pending_minor":224,"fees_minor":22}'
    from pg_temp.balance() b),
  'RevenueCat''s refund of the first payment refunds that sale and gives its commission and fee back to the balance');
select pg_temp.check(
  pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-unknown-refund', 'refund', 'u-ann', 'rc-nobody-1', 'rc-nobody-1',
    clock_timestamp(), '{"refunded_minor":999}'::jsonb)) @> '{"outcome":"ignored_no_sale","sale_id":null}'
  and pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-ann-cancel', 'cancellation', 'u-ann', 'rc-ann-3', 'rc-ann-1',
    clock_timestamp())) @> '{"outcome":"cancellation","sale_id":null}'
  and (select s.refunded_minor = 0 and s.status = 'paid' from pg_temp.sale('rc-ann-3') s),
  'a refund of a transaction that is no sale changes nothing, and turning off renewal is only noted');

-- What is never a sale -----------------------------------------------------------------------------
insert into qa select 'ignored', pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-sandbox', 'initial_purchase', 'u-ann',
  'rc-sandbox-1', 'rc-sandbox-1', clock_timestamp(), '{"environment":"sandbox"}'::jsonb))::text;
select pg_temp.capture('record_program_store_event.ignored', pg_temp.t('ignored')::jsonb);
select pg_temp.check(pg_temp.t('ignored')::jsonb = '{"received":true,"duplicate":false,"outcome":"ignored_sandbox","sale_id":null,"subscription_sequence":null}'::jsonb
  and pg_temp.store('rc_header', 'revenuecat', jsonb_build_object('event_id', 'rc-evt-test', 'type', 'other',
    'environment', 'production')) @> '{"outcome":"ignored_type"}'
  and pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-stripe', 'initial_purchase', 'u-ann', 'rc-stripe-1', 'rc-stripe-1',
    clock_timestamp(), '{"store":"stripe"}'::jsonb)) @> '{"outcome":"ignored_store"}'
  and pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-nobody', 'initial_purchase', 'u-nobody', 'rc-nobody-2', 'rc-nobody-2',
    clock_timestamp() + interval '1 minute')) @> '{"outcome":"unmatched_person","sale_id":null}'
  and pg_sales.n = 3,
  'a sandbox purchase, a test event, a Stripe purchase and a purchase by an app user nobody knows are stored, never a sale')
from (select count(*) as n from public.program_sales s where s.source = 'revenuecat') pg_sales;

-- Bea uses the app without any creator's link --------------------------------------------------------
select pg_temp.app('anon-bea', 'u-bea', 'sess-bea', clock_timestamp(), array['session_started', 'app_opened']);
select pg_temp.check(
  pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-bea', 'initial_purchase', 'u-bea', 'rc-bea-1', 'rc-bea-1',
    clock_timestamp() + interval '1 minute')) @> '{"outcome":"unmatched_creator","sale_id":null}'
  and pg_temp.sale('rc-bea-1') is null,
  'Bea is known but no creator brought her: her purchase is stored unmatched');

-- Dee: a free trial on the web first, then her first paid month ----------------------------------------
insert into qa select 'dee_creator_click', pg_temp.creator_click()->>'click_id';
select pg_temp.web('anon-dee-web', 'u-dee', 'sess-dee-web', clock_timestamp(), pg_temp.t('dee_creator_click'));
select pg_temp.check((pg_temp.session('sess-dee-web')).creator_click = pg_temp.t('dee_creator_click'),
  'Dee opened the creator''s link on the merchant''s site, signed in as u-dee');
select pg_temp.check(
  pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-dee-trial', 'initial_purchase', 'u-dee', 'rc-dee-1', 'rc-dee-1',
    clock_timestamp() + interval '1 minute', '{"amount_minor":0,"tax_minor":0,"store_fee_minor":0,
      "usd":{"amount_minor":0,"proceeds_minor":0}}'::jsonb)) @> '{"outcome":"ignored_free"}'
  and pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-dee-paid', 'renewal', 'u-dee', 'rc-dee-2', 'rc-dee-1',
    clock_timestamp() + interval '2 minutes', '{"store":"play_store","amount_minor":499,"tax_minor":0,"store_fee_minor":150,
      "usd":{"amount_minor":499,"proceeds_minor":349}}'::jsonb)) @> '{"outcome":"sale","subscription_sequence":1}'
  and (select s.match_source = 'app_user' and s.store = 'play_store' and s.click_id = pg_temp.t('dee_creator_click')
      and s.first_sale_id is null from pg_temp.sale('rc-dee-2') s)
  and (select c.status = 'held' and c.basis_minor = 349 and c.amount_minor = 104 and c.fee_minor = 10 from pg_temp.commission('rc-dee-2') c),
  'the free trial is no payment, so the trial''s conversion is the first payment of her subscription, credited through her web visit: 1.04');

-- Adapty: Cy pays in euros; the USD program takes Adapty's USD figures ------------------------------------
select pg_temp.creator_install('cy');
insert into qa select 'adapty_sale', pg_temp.store('adapty_header', 'adapty', jsonb_build_object(
  'event_id', '6f2a3c1e-0000-4000-8000-00000000c701', 'type', 'initial_purchase', 'environment', 'production',
  'app_user_id', 'u-cy', 'aliases', jsonb_build_array('0b6e0c5e-0000-4000-8000-00000000c7a1'), 'store', 'play_store',
  'product_id', 'fluent_pro_monthly', 'transaction_id', 'GPA.3311-0000-0000-00001', 'original_transaction_id', 'GPA.3311-0000-0000-00001',
  'purchased_at', pg_temp.epoch(clock_timestamp() + interval '2 minutes'), 'currency', 'EUR',
  'amount_minor', 899, 'tax_minor', 144, 'store_fee_minor', 113,
  'usd', jsonb_build_object('amount_minor', 979, 'proceeds_minor', 699), 'refunded_minor', null))::text;
select pg_temp.check(pg_temp.t('adapty_sale')::jsonb @> '{"outcome":"sale","subscription_sequence":1}'
  and (select s.source = 'adapty' and s.currency = 'USD' and s.amount_minor = 979 and s.tax_minor = 157 and s.store_fee_minor = 123
      and s.click_id = pg_temp.t('cy_creator_click') and s.match_source = 'app_user'
    from pg_temp.sale('GPA.3311-0000-0000-00001') s)
  and (select c.status = 'held' and c.currency = 'USD' and c.basis_minor = 699 and c.amount_minor = 209 and c.fee_minor = 20
    from pg_temp.commission('GPA.3311-0000-0000-00001') c),
  'Adapty''s purchase by u-cy in euros is recorded in USD from Adapty''s USD figures, and earns 30% of the 6.99 of proceeds');
select pg_temp.check(
  pg_temp.store('adapty_header', 'adapty', jsonb_build_object('event_id', '6f2a3c1e-0000-4000-8000-00000000c702',
    'type', 'initial_purchase', 'environment', 'sandbox', 'app_user_id', 'u-cy', 'store', 'app_store',
    'transaction_id', '2000000000000001', 'purchased_at', pg_temp.epoch(clock_timestamp()), 'currency', 'USD', 'amount_minor', 999))
    @> '{"outcome":"ignored_sandbox"}',
  'Adapty''s sandbox purchase is ignored through the same function');

-- Who may call the webhook function -----------------------------------------------------------------
insert into qa values ('nobody_header', 'Bearer ' || repeat('N', 43));
select pg_temp.check(
  pg_temp.store_try('nobody_header', 'revenuecat', pg_temp.rc('rc-evt-x', 'initial_purchase', 'u-ann', 'rc-x', 'rc-x', clock_timestamp())) = '28000'
  and pg_temp.store_try('rc_header', 'adapty', pg_temp.rc('rc-evt-x', 'initial_purchase', 'u-ann', 'rc-x', 'rc-x', clock_timestamp())) = '28000'
  and pg_temp.store_try('rc_header', 'revenuecat', pg_temp.rc('rc-evt-x', 'initial_purchase', 'u-ann', null, null, clock_timestamp())) = '22023'
  and pg_temp.store_try('rc_header', 'revenuecat', pg_temp.rc('rc-evt-x', 'initial_purchase', 'u-ann', 'rc-x', 'rc-x',
    clock_timestamp() + interval '1 hour')) = '22023'
  and pg_temp.store_try('rc_header', 'revenuecat', pg_temp.rc('rc-evt-x', 'refunded', 'u-ann', 'rc-x', 'rc-x', clock_timestamp())) = '22023'
  and pg_temp.store_try('rc_header', 'revenuecat', pg_temp.rc('rc-evt-x', 'initial_purchase', 'u-ann', 'rc-x', 'rc-x', clock_timestamp(),
    '{"amount_minor":"9.99"}'::jsonb)) = '22023'
  and pg_temp.store_try('rc_header', 'revenuecat', pg_temp.rc('', 'initial_purchase', 'u-ann', 'rc-x', 'rc-x', clock_timestamp())) = '22023'
  and (select count(*) = 0 from public.program_store_events e where e.event_id = 'rc-evt-x'),
  'an unknown header value, or one of the other tool, is refused as unknown (28000), and a malformed event as invalid (22023), storing nothing');

-- Rotating the header value ------------------------------------------------------------------------
insert into qa select 'rc_old_header', pg_temp.t('rc_header');
insert into qa select 'rc_rotated', pg_temp.call('owner', format('select public.workspace_store_connection_rotate(%L)',
  pg_temp.q('rc_connection')))::text;
update qa set value = pg_temp.t('rc_rotated')::jsonb->>'header_value' where key = 'rc_header';
select pg_temp.check(pg_temp.t('rc_header') ~ '^Bearer [A-Za-z0-9_-]{43}$' and pg_temp.t('rc_header') <> pg_temp.t('rc_old_header')
  and pg_temp.t('rc_rotated')::jsonb->>'id' = pg_temp.t('rc_connection')
  and pg_temp.store_try('rc_old_header', 'revenuecat', pg_temp.rc('rc-evt-old', 'other', null, null, null, null)) = '28000'
  and pg_temp.store('rc_header', 'revenuecat', pg_temp.rc('rc-evt-new', 'other', null, null, null, null)) @> '{"outcome":"ignored_type"}',
  'rotating gives a new header value once; the old one is refused at once and the new one works');

-- What the merchant sees ------------------------------------------------------------------------------
select pg_temp.capture('workspace_store_connections.listed', pg_temp.connections('owner'));
select pg_temp.check(
  (select a->'projects' = jsonb_build_array(jsonb_build_object('id', pg_temp.q('project'), 'name', 'Fluent'),
        jsonb_build_object('id', pg_temp.q('web_project'), 'name', 'Fluent web'))
      and jsonb_array_length(a->'connections') = 2
      and a->'connections'->1 @> jsonb_build_object('id', pg_temp.q('rc_connection'), 'provider', 'revenuecat',
        'project_name', 'Fluent', 'status', 'active', 'events_30d', 15, 'sales_30d', 4, 'ignored_30d', 8)
      and (a->'connections'->1->>'last_event_at') is not null
      and a->'connections'->0 @> jsonb_build_object('id', pg_temp.q('adapty_connection'), 'provider', 'adapty',
        'events_30d', 2, 'sales_30d', 1, 'ignored_30d', 1)
      and not a::text ~* 'header_value|Bearer|u-ann|rc-ann|header_sha'
    from pg_temp.connections('owner') a)
  and (select c.events_count = 15 and c.sales_count = 4 and c.ignored_count = 8
    from public.program_store_connections c where c.id = pg_temp.q('rc_connection')),
  'the Connections page shows each tool''s calls, sales and ignored calls of the last 30 days, and never a header value or a buyer');
select pg_temp.capture('workspace_program_sales.store', pg_temp.sales());
select pg_temp.check(
  (select (select count(*) = 5 from jsonb_array_elements(a->'sales') s where s->>'source' in ('revenuecat', 'adapty'))
      and exists (select 1 from jsonb_array_elements(a->'sales') s where s @> jsonb_build_object(
        'sale_id', (pg_temp.sale('rc-ann-3')).id, 'source', 'revenuecat', 'store', 'app_store', 'promotion_code', null,
        'match_source', 'subscription', 'status', 'pending', 'commission_minor', 224, 'fee_minor', 22, 'creator_name', 'Mira Maker',
        'link_name', 'Main link'))
      and exists (select 1 from jsonb_array_elements(a->'sales') s where s @> jsonb_build_object(
        'sale_id', (pg_temp.sale('rc-ann-1')).id, 'status', 'returned', 'refunded_minor', 999))
      and exists (select 1 from jsonb_array_elements(a->'sales') s where s @> jsonb_build_object(
        'sale_id', (pg_temp.sale('rc-ann-2')).id, 'status', 'not_earned', 'reason', 'outside_duration'))
      and exists (select 1 from jsonb_array_elements(a->'sales') s where s @> '{"source":"adapty","store":"play_store","currency":"USD","amount_minor":979}')
      and a->'summary' = '{"days":30,"sales":3,"sales_amount_minor":2477,"commission_minor":537,"fee_minor":52}'
      and not a::text ~* 'u-ann|u-cy|u-dee|rc-ann|GPA\.|RCAnonymous|fluent_pro'
    from pg_temp.sales() a),
  'the Sales page lists the store sales with their source and store, and no app user, transaction or product');
select pg_temp.check(
  (select h->'store' @> '{"connections":2,"unmatched_30d":2}' and h->'store'->'outcomes_last_day' @> '{"sale":5,"refund":1,"ignored_sandbox":2}'
      and h->'sales'->'by_source' = '{"stripe":0,"revenuecat":4,"adapty":1}'::jsonb and h->'sales' @> '{"fee_unknown":0,"total":5}'
      and not h::text ~* 'u-ann|rc-ann|Bearer'
    from (select pg_temp.health() as h) x),
  'the operator view counts store connections, outcomes and unmatched purchases without identifiers');

-- What the creator sees ---------------------------------------------------------------------------------
select pg_temp.check(
  (select e->'programs'->0 @> '{"name":"Fluent","pending_minor":537}' from pg_temp.earnings() e)
  and (select p->'totals' @> '{"sales":3,"earnings_minor":537}' from pg_temp.performance() p)
  and (select bool_and(not (x::text ~* '(u-ann|u-bea|u-cy|u-dee|anon-|RCAnonymous|rc-ann|rc-dee|GPA\.|fluent_pro|example\.test|revenuecat|adapty|transaction|app_user)'))
    from (values (pg_temp.earnings()), (pg_temp.performance())) v(x)),
  'the creator''s Earnings and Performance pages count the three store sales that earn and never show an app user, a transaction or the tool');

-- Removing a connection ------------------------------------------------------------------------------
select pg_temp.check(
  (select jsonb_array_length(a->'connections') = 1 and a->'connections'->0->>'provider' = 'revenuecat'
    from pg_temp.call('owner', format('select public.workspace_store_connection_remove(%L)', pg_temp.q('adapty_connection'))) a)
  and pg_temp.store_try('adapty_header', 'adapty', jsonb_build_object('event_id', 'after-remove', 'type', 'other',
    'environment', 'production')) = '28000'
  and (pg_temp.sale('GPA.3311-0000-0000-00001')).id is not null
  and pg_temp.try('owner', format('select public.workspace_store_connection_rotate(%L)', pg_temp.q('adapty_connection'))) = 'P0002 connection_not_found'
  and pg_temp.call('owner', format('select public.workspace_store_connection_create(%L, %L, %L)',
    pg_temp.q('workspace'), pg_temp.q('project'), 'adapty'))->>'id' <> pg_temp.t('adapty_connection'),
  'removing Adapty refuses its calls from then on and keeps its sales; it can be connected again with a new value');

-- Every cent is accounted for --------------------------------------------------------------------------
select pg_temp.check(
  (select a.available_minor = (select sum(e.amount_minor) from public.program_balance_entries e where e.account_id = a.id)
      and a.available_minor = 5000 - 224 - 22 - 209 - 20 - 104 - 10
    from pg_temp.account() a)
  and public.program_balance_health()->>'ledger_mismatches' = '0'
  and not exists (select 1 from public.program_commission_retries),
  'the balance equals its entries: the deposit less the three commissions that earn and their fees');

select format('ok %s program store sales assertions', count(*)) from store_assertions;
rollback;
