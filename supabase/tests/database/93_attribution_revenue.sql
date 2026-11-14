-- Attribution Phase 3, piece A: revenue and exchange rates. The base migration's helpers first;
-- then piece A's revenue intake, the store revenue call, the rates call and the console.
--
-- Events come in through analytics_ingest as the SDKs and servers send them (service role, the
-- ingest envelope); the store webhook is played by the normalized body program-store-webhook
-- hands record_program_store_event and then attribution_store_revenue; the console calls run
-- signed in, as the authenticated role. One bot verdict and one constraint that breaks the
-- revenue insert on purpose are written directly, and say so.
begin;
set local time zone 'UTC';
create temporary table revenue_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Attribution revenue assertion failed: %', label; end if;
  insert into revenue_assertions values (label);
end $$;

-- Base helpers -----------------------------------------------------------------------------
select pg_temp.check(kma_internal.currency_exponent('USD') = 2 and kma_internal.currency_exponent('JPY') = 0
  and kma_internal.currency_exponent('KWD') = 3 and kma_internal.currency_exponent('NGN') = 2,
  'currency decimals follow ISO 4217');
select pg_temp.check(kma_internal.attribution_source_family('Facebook') = 'meta'
  and kma_internal.attribution_source_family('ig') = 'meta'
  and kma_internal.attribution_source_family('tt') = 'tiktok'
  and kma_internal.attribution_source_family('adwords') = 'google_ads'
  and kma_internal.attribution_source_family(' Newsletter ') = 'newsletter'
  and kma_internal.attribution_source_family(null) is null,
  'source names fold into their ad platform');

insert into public.attribution_fx_rates(currency, day, per_eur) values
  ('USD', '2026-11-02', 1.10), ('USD', '2026-11-03', 1.12), ('GBP', '2026-11-03', 0.88), ('JPY', '2026-11-03', 165);
select pg_temp.check(kma_internal.attribution_fx_rate('USD', 'USD', '2026-11-03') = 1
  and kma_internal.attribution_fx_rate('XYZ', 'XYZ', '2026-11-03') = 1, 'a currency is worth itself');
select pg_temp.check(kma_internal.attribution_fx_rate('EUR', 'USD', '2026-11-03') = 1.12
  and kma_internal.attribution_fx_rate('USD', 'EUR', '2026-11-02') = 1 / 1.10::numeric,
  'euro rates are the ECB rate');
select pg_temp.check(round(kma_internal.attribution_fx_rate('GBP', 'USD', '2026-11-03'), 6) = round(1.12 / 0.88, 6),
  'a cross rate goes through the euro');
select pg_temp.check(kma_internal.attribution_fx_rate('EUR', 'USD', '2026-11-09') = 1.12
  and kma_internal.attribution_fx_rate('EUR', 'USD', '2026-10-01') = 1.10,
  'a day without a rate uses the latest before it, else the earliest after it');
select pg_temp.check(kma_internal.attribution_fx_rate('NGN', 'USD', '2026-11-03') is null,
  'a currency the ECB does not publish has no rate');

-- Piece A helpers --------------------------------------------------------------------------
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
create function pg_temp.t(k text) returns text language sql as $$ select value from qa where key = k $$;
create function pg_temp.j(k text) returns jsonb language sql as $$ select value::jsonb from qa where key = k $$;
create function pg_temp.keep(k text, value jsonb) returns jsonb language sql as $$
  insert into qa values (k, value::text) on conflict (key) do update set value = excluded.value returning value::jsonb
$$;
-- Prints one function result as the front ends receive it (kept by KMA_DB_TEST_OUTPUT).
create function pg_temp.capture(name text, result jsonb) returns text language sql as $$
  select 'capture ' || name || ' ' || result::text
$$;
create function pg_temp.at(minutes_ago numeric) returns text language sql as $$
  select to_char((now() - make_interval(secs => minutes_ago * 60)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
create function pg_temp.epoch(minutes_ago numeric) returns bigint language sql as $$
  select floor(extract(epoch from now() - make_interval(secs => minutes_ago * 60)))::bigint
$$;
create function pg_temp.sha256(value text) returns text language sql immutable as $$
  select encode(extensions.digest(value, 'sha256'), 'hex')
$$;
create function pg_temp.sign_in(who text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.q(who), 'role', 'authenticated')::text, true)
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
-- 'ok', or the SQLSTATE and the DETAIL code of the refusal.
create function pg_temp.try(who text, statement text) returns text language plpgsql as $$
declare reason text;
begin
  perform pg_temp.call(who, statement);
  return 'ok';
exception when others then
  get stacked diagnostics reason = pg_exception_detail;
  return btrim(sqlstate || ' ' || coalesce(reason, ''));
end $$;
-- The message a refusal shows.
create function pg_temp.message(who text, statement text) returns text language plpgsql as $$
begin
  perform pg_temp.call(who, statement);
  return 'ok';
exception when others then
  return sqlerrm;
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
-- One request from an SDK or a server with one event: the key named in qa, the person, the
-- event's name, properties and time. Returns what analytics_ingest answers.
create function pg_temp.send(key_name text, anon text, user_id text, name text, props jsonb, minutes_ago numeric default 1)
returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  result := public.analytics_ingest(jsonb_build_object(
    'key_hash', encode(extensions.digest(pg_temp.t(key_name), 'sha256'), 'hex'), 'origin', null,
    'body', jsonb_strip_nulls(jsonb_build_object('anonymous_id', anon, 'user_id', user_id)) || jsonb_build_object(
      'session', jsonb_build_object('id', 'sess-' || coalesce(anon, user_id), 'started_at', pg_temp.at(minutes_ago)),
      'context', jsonb_build_object('platform', 'ios', 'sdk', 'kma-ios/1.1.0', 'device_type', 'mobile'),
      'events', jsonb_build_array(jsonb_build_object('name', name, 'insert_id', gen_random_uuid()::text,
        'time', pg_temp.at(minutes_ago), 'properties', props)))));
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
create function pg_temp.person(project_key text, known_as text) returns uuid language sql as $$
  select pe.id from public.analytics_people pe
  where pe.project_id = pg_temp.q(project_key) and (pe.distinct_id = known_as or known_as = any(pe.anonymous_ids))
$$;
create function pg_temp.rev(project_key text, dedupe text) returns public.attribution_revenue language sql as $$
  select r from public.attribution_revenue r where r.project_id = pg_temp.q(project_key) and r.dedupe_key = dedupe
$$;
-- The newest event of a project with that name, and the revenue row it made.
create function pg_temp.last_event(project_key text, named text) returns public.analytics_events language sql as $$
  select e from public.analytics_events e where e.project_id = pg_temp.q(project_key) and e.name = named
  order by e.id desc limit 1
$$;
create function pg_temp.rev_of_last(project_key text, named text) returns public.attribution_revenue language sql as $$
  select r from public.attribution_revenue r where r.event_id = (pg_temp.last_event(project_key, named)).id
$$;
create function pg_temp.revenue_rows(project_key text) returns bigint language sql as $$
  select count(*) from public.attribution_revenue r where r.project_id = pg_temp.q(project_key)
$$;
create function pg_temp.skips(project_key text, why text) returns bigint language sql as $$
  select coalesce(sum(s.events), 0) from public.attribution_revenue_skips s
  where s.project_id = pg_temp.q(project_key) and s.reason = why
$$;
-- What program-store-webhook does for one call: record_program_store_event, then
-- attribution_store_revenue with the same body. Returns the second answer.
create function pg_temp.webhook(header_key text, provider text, body jsonb) returns jsonb language plpgsql as $$
declare
  v_p jsonb := body || jsonb_build_object('header' || '_sha256', pg_temp.sha256(pg_temp.t(header_key)), 'provider', provider);
  result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  perform public.record_program_store_event(v_p);
  result := public.attribution_store_revenue(v_p);
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- A RevenueCat purchase as the webhook normalizes it, made 30 minutes ago.
create function pg_temp.store_body(event_id text, kind text, app_user text, tx text, amount bigint, currency text,
  extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('event_id', event_id, 'type', kind, 'environment', 'production',
    'app_user_id', app_user, 'aliases', jsonb_build_array('$RCAnonymousID:' || md5(coalesce(app_user, event_id))),
    'store', 'app_store', 'product_id', 'pro_monthly', 'transaction_id', tx, 'original_transaction_id', tx,
    'purchased_at', pg_temp.epoch(30), 'currency', currency,
    'amount_minor', case when kind = 'refund' then null else amount end, 'tax_minor', null, 'store_fee_minor', null,
    'usd', null, 'refunded_minor', case when kind = 'refund' then amount end) || extra
$$;
create function pg_temp.setup(who text, project_key text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.attribution_revenue_setup(%L)', pg_temp.q(project_key)))
$$;
create function pg_temp.save(who text, project_key text, events jsonb) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.attribution_revenue_events_save(%L, %L)', pg_temp.q(project_key), events))
$$;
create function pg_temp.save_try(who text, project_key text, events jsonb) returns text language sql as $$
  select pg_temp.try(who, format('select public.attribution_revenue_events_save(%L, %L)', pg_temp.q(project_key), events))
$$;
create function pg_temp.save_message(events jsonb) returns text language sql as $$
  select pg_temp.message('developer', format('select public.attribution_revenue_events_save(%L, %L)', pg_temp.q('project'), events))
$$;
grant all on qa, revenue_assertions to authenticated, service_role;
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- Who may call what -------------------------------------------------------------------------
select pg_temp.check((select bool_and(has_function_privilege('service_role', f, 'execute')
    and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
  from unnest(array['public.attribution_store_revenue(jsonb)', 'public.attribution_fx_store(jsonb)']) f),
  'only edge functions record store revenue and rates');
select pg_temp.check((select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
  from unnest(array['public.attribution_revenue_setup(uuid)', 'public.attribution_revenue_events_save(uuid,jsonb)']) f),
  'signed-in members call the console functions, nobody signed out');
select pg_temp.check((select bool_and(p.prosecdef and p.proconfig = array['search_path=""']) from pg_proc p
  where p.oid in ('public.attribution_store_revenue(jsonb)'::regprocedure, 'public.attribution_fx_store(jsonb)'::regprocedure,
    'public.attribution_revenue_setup(uuid)'::regprocedure, 'public.attribution_revenue_events_save(uuid,jsonb)'::regprocedure,
    'kma_internal.attribution_revenue_event()'::regprocedure)),
  'the new functions run as their owner with an empty search path');
select pg_temp.check(exists (select 1 from pg_trigger g where g.tgrelid = 'public.analytics_events'::regclass
    and g.tgname = 'analytics_events_attribution_revenue' and g.tgfoid = 'kma_internal.attribution_revenue_event()'::regprocedure),
  'every new event passes the revenue intake');
select pg_temp.check(not has_table_privilege('authenticated', 'public.attribution_revenue', 'select')
  and not has_table_privilege('service_role', 'public.attribution_revenue', 'select')
  and not has_table_privilege('authenticated', 'public.attribution_revenue_events', 'insert'),
  'revenue is read and written only through functions');

-- People, projects and keys ------------------------------------------------------------------
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('e9300000-0000-4000-8000-000000000001', 'owner@fluent.example.test', now(), '{}'),
  ('e9300000-0000-4000-8000-000000000002', 'dev@fluent.example.test', now(), '{}'),
  ('e9300000-0000-4000-8000-000000000003', 'analyst@fluent.example.test', now(), '{}'),
  ('e9300000-0000-4000-8000-000000000004', 'stranger@elsewhere.example.test', now(), '{}');
insert into qa values ('owner', 'e9300000-0000-4000-8000-000000000001'), ('developer', 'e9300000-0000-4000-8000-000000000002'),
  ('analyst', 'e9300000-0000-4000-8000-000000000003'), ('stranger', 'e9300000-0000-4000-8000-000000000004');
select pg_temp.sign_in('owner');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Fluent', array['ios', 'android', 'web'], 'UTC') r)
insert into qa select 'project', r->'project'->>'id' from created
union all select 'live_key', r->'key'->>('to' || 'ken') from created;
insert into qa select 'dev_key', public.analytics_create_key(pg_temp.q('project'), 'Staging', 'client', 'development')->>('to' || 'ken');
select public.attribution_enable(pg_temp.q('project'), 'fluent-revenue');
-- A project that never turned attribution on.
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Quiet', array['ios'], 'UTC') r)
insert into qa select 'quiet', r->'project'->>'id' from created
union all select 'quiet_key', r->'key'->>('to' || 'ken') from created;
-- A clean project for the console's numbers.
with created as (select public.analytics_create_project(pg_temp.q('workspace'), 'Shop', array['ios', 'web'], 'UTC') r)
insert into qa select 'shop', r->'project'->>'id' from created
union all select 'shop_key', r->'key'->>('to' || 'ken') from created;
insert into qa select 'shop_dev_key', public.analytics_create_key(pg_temp.q('shop'), 'Staging', 'client', 'development')->>('to' || 'ken');
insert into qa select 'shop_server_key', public.analytics_create_key(pg_temp.q('shop'), 'Backend', 'server', 'production')->>('to' || 'ken');
select public.attribution_enable(pg_temp.q('shop'), 'shop-revenue');
select set_config('request.jwt.claims', '', true);
insert into public.analytics_workspace_members(workspace_id, user_id, role) values
  (pg_temp.q('workspace'), pg_temp.q('developer'), 'developer'), (pg_temp.q('workspace'), pg_temp.q('analyst'), 'analyst');
select pg_temp.sign_in('stranger');
select public.analytics_bootstrap();

-- The console before anything arrives ------------------------------------------------------------
select pg_temp.keep('setup_empty', pg_temp.setup('analyst', 'shop'));
select pg_temp.capture('revenue_setup_empty', pg_temp.j('setup_empty'));
select pg_temp.check(pg_temp.j('setup_empty') - 'rates_day' = '{"currency": "USD", "events": [],
    "stores": [{"provider": "revenuecat", "connected": false}, {"provider": "adapty", "connected": false}],
    "last_7d": {"payments": 0, "refunds": 0, "payers": 0, "revenue": 0, "unconverted": 0},
    "last_received_at": null, "last_development_at": null, "by_origin": [], "skipped_7d": []}'::jsonb
  and pg_temp.j('setup_empty')->>'rates_day' = '2026-11-03',
  'before anything arrives the console shows the currency, nothing counted, no tool connected and the newest ECB day');

-- The SDKs' revenue call: reserved properties ------------------------------------------------------
select pg_temp.check((pg_temp.send('live_key', 'anon-ann', null, 'purchase', '{"kma_revenue": 9.99, "kma_currency": " usd ",
    "kma_product_id": "pro_monthly", "kma_transaction_id": " T-1 ", "plan": "monthly"}')->>'stored') = '1',
  'a purchase event is stored');
select pg_temp.check((select r.amount = 9.99 and r.currency = 'USD' and r.origin = 'event' and r.event_name = 'purchase'
    and r.event_id = (pg_temp.last_event('project', 'purchase')).id and r.person_id = pg_temp.person('project', 'anon-ann')
    and r.environment = 'production' and r.occurred_at = (pg_temp.last_event('project', 'purchase')).occurred_at
    and r.product_id = 'pro_monthly' and r.transaction_id = 'T-1' and r.store is null and r.dedupe_key = 'txn:T-1'
  from pg_temp.rev('project', 'txn:T-1') r),
  'kma_revenue and kma_currency make a payment, its currency upper case, keyed by its transaction');
select pg_temp.send('live_key', 'anon-ann', null, 'purchase', '{"kma_revenue": 9.99, "kma_currency": "USD", "kma_transaction_id": "T-1"}');
select pg_temp.check((select count(*) = 1 from public.attribution_revenue r where r.project_id = pg_temp.q('project')
    and r.transaction_id = 'T-1' and r.amount > 0)
  and (select count(*) = 2 from public.analytics_events e where e.project_id = pg_temp.q('project') and e.name = 'purchase'),
  'the same transaction sent twice is one payment, and both events are kept');
select pg_temp.send('live_key', 'anon-ann', null, 'refund', '{"kma_revenue": -9.99, "kma_currency": "USD", "kma_transaction_id": "T-1"}');
select pg_temp.check((select r.amount = -9.99 and r.event_name = 'refund' and r.transaction_id = 'T-1'
  from pg_temp.rev('project', 'refund:T-1') r), 'a negative amount with a transaction is that transaction''s refund');
select pg_temp.send('live_key', 'anon-ann', null, 'tip_sent', '{"kma_revenue": 2, "kma_currency": "EUR",
  "kma_transaction_id": 123, "kma_product_id": ""}');
select pg_temp.check((select r.dedupe_key = 'event:' || r.event_id and r.transaction_id is null and r.product_id is null
    and r.amount = 2 and r.currency = 'EUR'
  from pg_temp.rev_of_last('project', 'tip_sent') r),
  'without a usable transaction ID a payment is keyed by its event; IDs that are not text of 1 to 200 characters are ignored');
select pg_temp.send('live_key', 'anon-ann', null, 'tip_sent', jsonb_build_object('kma_revenue', 3, 'kma_currency', 'EUR',
  'kma_transaction_id', repeat('x', 201), 'kma_product_id', repeat('p', 200)));
select pg_temp.check((select r.transaction_id is null and r.product_id = repeat('p', 200)
  from pg_temp.rev_of_last('project', 'tip_sent') r), 'an ID of 200 characters is kept, 201 is not');
select pg_temp.send('live_key', 'anon-ann', null, 'gift_refunded', '{"kma_revenue": -1.5, "kma_currency": "USD"}');
select pg_temp.check((pg_temp.rev_of_last('project', 'gift_refunded')).dedupe_key like 'event:%'
  and (pg_temp.rev_of_last('project', 'gift_refunded')).amount = -1.5, 'a refund without a transaction is keyed by its event');
select pg_temp.send('live_key', 'anon-ann', null, 'coins', '{"kma_revenue": 0.1234567, "kma_currency": "KWD"}');
select pg_temp.check((pg_temp.rev_of_last('project', 'coins')).amount = 0.123457, 'amounts keep six decimals');

-- Every skip reason, per day and reason -------------------------------------------------------------
insert into qa select 'rows_before_skips', pg_temp.revenue_rows('project')::text;
select pg_temp.check((select bool_and((pg_temp.send('live_key', 'anon-ann', null, 'purchase', p)->>'stored') = '1')
  from unnest(array['{"kma_revenue": "9.99", "kma_currency": "USD"}', '{"kma_revenue": 0, "kma_currency": "USD"}',
    '{"kma_revenue": 1000000001, "kma_currency": "USD"}', '{"kma_revenue": -2e9, "kma_currency": "USD"}',
    '{"kma_revenue": 0.0000001, "kma_currency": "USD"}', '{"kma_revenue": null, "kma_currency": "USD"}',
    '{"kma_revenue": [1], "kma_currency": "USD"}']::jsonb[]) p),
  'events with an amount that is not a nonzero number up to a billion are stored');
select pg_temp.check((select bool_and((pg_temp.send('live_key', 'anon-ann', null, 'purchase', p)->>'stored') = '1')
  from unnest(array['{"kma_revenue": 5}', '{"kma_revenue": 5, "kma_currency": null}', '{"kma_revenue": 5, "kma_currency": "  "}']::jsonb[]) p)
  and (select bool_and((pg_temp.send('live_key', 'anon-ann', null, 'purchase', p)->>'stored') = '1')
  from unnest(array['{"kma_revenue": 5, "kma_currency": "US"}', '{"kma_revenue": 5, "kma_currency": "US1"}',
    '{"kma_revenue": 5, "kma_currency": "dollars"}', '{"kma_revenue": 5, "kma_currency": 840}']::jsonb[]) p),
  'so are events without a currency or with one that is not three letters');
select pg_temp.check(pg_temp.revenue_rows('project') = pg_temp.t('rows_before_skips')::bigint,
  'none of them is a payment');
select pg_temp.check(pg_temp.skips('project', 'bad_amount') = 7 and pg_temp.skips('project', 'no_currency') = 3
    and pg_temp.skips('project', 'bad_currency') = 4
    and (select bool_and(s.day = ((now() - interval '1 minute') at time zone 'UTC')::date and s.last_at = now()) from public.attribution_revenue_skips s
      where s.project_id = pg_temp.q('project')),
  'each is counted under its reason on the UTC day it happened: bad_amount, no_currency, bad_currency');

-- Development and projects without attribution ------------------------------------------------------
select pg_temp.send('dev_key', 'anon-dev', null, 'purchase', '{"kma_revenue": 4.99, "kma_currency": "USD", "kma_transaction_id": "DEV-1"}');
select pg_temp.check((pg_temp.rev('project', 'txn:DEV-1')).environment = 'development'
  and (pg_temp.rev('project', 'txn:DEV-1')).person_id = pg_temp.person('project', 'anon-dev'),
  'a payment from a development key is kept as development');
select pg_temp.keep('quiet_sent', jsonb_build_array(
  pg_temp.send('quiet_key', 'anon-quiet', null, 'purchase', '{"kma_revenue": 4.99, "kma_currency": "USD"}'),
  pg_temp.send('quiet_key', 'anon-quiet', null, 'purchase', '{"kma_revenue": 4.99}')));
select pg_temp.check(pg_temp.j('quiet_sent')->0->>'stored' = '1' and pg_temp.j('quiet_sent')->1->>'stored' = '1'
  and pg_temp.revenue_rows('quiet') = 0
  and not exists (select 1 from public.attribution_revenue_skips s where s.project_id = pg_temp.q('quiet')),
  'a project that never turned attribution on keeps its events and no revenue or skips');

-- Events the merchant names in the console ----------------------------------------------------------
select pg_temp.save('developer', 'project', '[
  {"event": "order_paid", "amount_property": "value", "currency_property": "currency"},
  {"event": "coins_bought", "amount_property": "price_cents", "unit": "minor", "currency": "usd"},
  {"event": "yen_pack", "amount_property": "price", "unit": "minor", "currency": "JPY"},
  {"event": "dinar_pack", "amount_property": "amount", "unit": "minor", "currency_property": "cur", "currency": null}]');
select pg_temp.send('live_key', 'anon-bo', null, 'order_paid', '{"value": " 19.90 ", "currency": "eur", "kma_transaction_id": "ORD-1",
  "kma_product_id": "basket"}');
select pg_temp.check((select r.amount = 19.90 and r.currency = 'EUR' and r.event_name = 'order_paid' and r.transaction_id = 'ORD-1'
    and r.product_id = 'basket' and r.person_id = pg_temp.person('project', 'anon-bo')
  from pg_temp.rev('project', 'txn:ORD-1') r),
  'a named event: the amount from its property (a numeric string here), the currency from another, the transaction from kma_transaction_id');
select pg_temp.send('live_key', 'anon-bo', null, 'order_paid', '{"value": 24.5, "currency": "GBP"}');
select pg_temp.check((select r.amount = 24.5 and r.currency = 'GBP' and r.dedupe_key = 'event:' || r.event_id
  from pg_temp.rev_of_last('project', 'order_paid') r), 'a JSON number works the same, keyed by the event without a transaction');
select pg_temp.send('live_key', 'anon-bo', null, 'coins_bought', '{"price_cents": 499}');
select pg_temp.check((select r.amount = 4.99 and r.currency = 'USD' from pg_temp.rev_of_last('project', 'coins_bought') r),
  'cents of a fixed currency: 499 is 4.99 USD');
select pg_temp.send('live_key', 'anon-bo', null, 'yen_pack', '{"price": "500"}');
select pg_temp.check((select r.amount = 500 and r.currency = 'JPY' from pg_temp.rev_of_last('project', 'yen_pack') r),
  'yen have no cents: 500 is 500 JPY');
select pg_temp.send('live_key', 'anon-bo', null, 'dinar_pack', '{"amount": 1250, "cur": "kwd"}');
select pg_temp.check((select r.amount = 1.25 and r.currency = 'KWD' from pg_temp.rev_of_last('project', 'dinar_pack') r),
  'dinars have three decimals: 1250 is 1.250 KWD');
select pg_temp.send('live_key', 'anon-bo', null, 'order_paid', '{"value": -19.90, "currency": "EUR", "kma_transaction_id": "ORD-1"}');
select pg_temp.check((pg_temp.rev('project', 'refund:ORD-1')).amount = -19.90, 'a named event with a negative amount is a refund');
select pg_temp.send('live_key', 'anon-bo', null, 'coins_bought', '{"price_cents": 10000, "kma_revenue": 3, "kma_currency": "CHF"}');
select pg_temp.check((select r.amount = 3 and r.currency = 'CHF' from pg_temp.rev_of_last('project', 'coins_bought') r),
  'kma_revenue wins over the event''s entry');
insert into qa select 'rows_before_mapped_skips', pg_temp.revenue_rows('project')::text;
select pg_temp.check((select bool_and((pg_temp.send('live_key', 'anon-bo', null, 'order_paid', p)->>'stored') = '1')
  from unnest(array['{"currency": "EUR"}', '{"value": "abc", "currency": "EUR"}', '{"value": "1e5", "currency": "EUR"}',
    '{"value": {"amount": 5}, "currency": "EUR"}', '{"value": 0, "currency": "EUR"}', '{"value": 5}',
    '{"value": 5, "currency": ["EUR"]}', '{"value": 5, "currency": "EURO"}']::jsonb[]) p)
  and (pg_temp.send('live_key', 'anon-bo', null, 'coins_bought', '{"price_cents": 0.00001}')->>'stored') = '1',
  'named events with a missing or broken amount or currency are stored');
select pg_temp.check(pg_temp.revenue_rows('project') = pg_temp.t('rows_before_mapped_skips')::bigint
    and pg_temp.skips('project', 'bad_amount') = 7 + 6 and pg_temp.skips('project', 'no_currency') = 3 + 1
    and pg_temp.skips('project', 'bad_currency') = 4 + 2,
  'and counted as skips: no amount, text that is not a number, an object, zero and a cent too small are bad amounts');
select pg_temp.send('live_key', 'anon-bo', null, 'page_viewed', '{"value": 5, "currency": "EUR", "kma_currency": "EUR"}');
select pg_temp.check(pg_temp.revenue_rows('project') = pg_temp.t('rows_before_mapped_skips')::bigint
    and pg_temp.skips('project', 'bad_amount') = 13,
  'any other event is not looked at, whatever its properties');

-- Nothing in the intake can fail an event ----------------------------------------------------------------
-- Written directly, on purpose: a constraint that makes the revenue insert fail for GBP.
alter table public.attribution_revenue add constraint qa_breaks_the_insert check (currency <> 'GBP') not valid;
insert into qa select 'rows_before_break', pg_temp.revenue_rows('project')::text;
select pg_temp.check((pg_temp.send('live_key', 'anon-bo', null, 'order_paid', '{"value": 7, "currency": "GBP"}')->>'stored') = '1'
  and (pg_temp.send('live_key', 'anon-bo', null, 'purchase', '{"kma_revenue": 7, "kma_currency": "GBP"}')->>'stored') = '1'
  and (pg_temp.last_event('project', 'order_paid')).properties->>'currency' = 'GBP'
  and pg_temp.revenue_rows('project') = pg_temp.t('rows_before_break')::bigint,
  'when recording the payment fails, the event is still stored and nothing else happens');
alter table public.attribution_revenue drop constraint qa_breaks_the_insert;
select pg_temp.check((pg_temp.send('live_key', 'anon-bo', null, 'order_paid', '{"value": 1e400, "currency": "EUR"}')->>'stored') = '1'
  and (pg_temp.send('live_key', 'anon-bo', null, 'order_paid', jsonb_build_object('value', 5, 'currency', repeat('E', 5000)))->>'stored') = '1',
  'a huge number or a huge currency text never fails the event');

-- A person folded into another brings their revenue ------------------------------------------------------
select pg_temp.send('live_key', 'anon-fold-a', 'user-fold', 'purchase', '{"kma_revenue": 12, "kma_currency": "USD", "kma_transaction_id": "FOLD-A"}');
select pg_temp.send('live_key', 'anon-fold-b', null, 'purchase', '{"kma_revenue": 8, "kma_currency": "USD", "kma_transaction_id": "FOLD-B"}');
insert into qa select 'fold_b', pg_temp.person('project', 'anon-fold-b');
select pg_temp.check(pg_temp.q('fold_b') <> pg_temp.person('project', 'user-fold')
  and (pg_temp.rev('project', 'txn:FOLD-B')).person_id = pg_temp.q('fold_b'), 'two people, each with a payment');
select pg_temp.send('live_key', 'anon-fold-b', 'user-fold', 'app_opened', '{}');
select pg_temp.check(not exists (select 1 from public.analytics_people where id = pg_temp.q('fold_b'))
  and (pg_temp.rev('project', 'txn:FOLD-B')).person_id = pg_temp.person('project', 'user-fold')
  and (pg_temp.rev('project', 'txn:FOLD-A')).person_id = pg_temp.person('project', 'user-fold'),
  'when the second phone signs in as the same user, its person folds in and the payment moves with it');

-- Store revenue: RevenueCat and Adapty --------------------------------------------------------------------
insert into qa select 'rc_header', pg_temp.call('owner', format('select public.workspace_store_connection_create(%L, %L, %L)',
  pg_temp.q('workspace'), pg_temp.q('project'), 'revenuecat'))->>'header_value';
insert into qa select 'adapty_header', pg_temp.call('owner', format('select public.workspace_store_connection_create(%L, %L, %L)',
  pg_temp.q('workspace'), pg_temp.q('project'), 'adapty'))->>'header_value';
insert into qa select 'quiet_header', pg_temp.call('owner', format('select public.workspace_store_connection_create(%L, %L, %L)',
  pg_temp.q('workspace'), pg_temp.q('quiet'), 'revenuecat'))->>'header_value';
select pg_temp.send('live_key', 'anon-store', 'u-store', 'app_opened', '{}');
insert into qa select 'store_person', pg_temp.person('project', 'u-store');

select pg_temp.keep('store_recorded', pg_temp.webhook('rc_header', 'revenuecat',
  pg_temp.store_body('rc-ev-1', 'initial_purchase', 'u-store', 'RC-TX-10', 999, 'USD')));
select pg_temp.capture('attribution_store_revenue.recorded', pg_temp.j('store_recorded'));
select pg_temp.check(pg_temp.j('store_recorded') = '{"outcome": "recorded"}'::jsonb
  and (select r.amount = 9.99 and r.currency = 'USD' and r.origin = 'store' and r.store = 'revenuecat' and r.event_id is null
    and r.event_name is null and r.person_id = pg_temp.q('store_person') and r.environment = 'production'
    and r.product_id = 'pro_monthly' and r.transaction_id = 'RC-TX-10' and r.occurred_at = to_timestamp(pg_temp.epoch(30))
  from pg_temp.rev('project', 'txn:RC-TX-10') r),
  'a RevenueCat purchase of the person with that user ID is recorded at the gross price, when it was made');
select pg_temp.check(pg_temp.webhook('rc_header', 'revenuecat',
    pg_temp.store_body('rc-ev-2', 'initial_purchase', 'u-store', 'RC-TX-10', 999, 'USD')) = '{"outcome": "duplicate"}'::jsonb
  and pg_temp.webhook('rc_header', 'revenuecat',
    pg_temp.store_body('rc-ev-1', 'initial_purchase', 'u-store', 'RC-TX-10', 999, 'USD')) = '{"outcome": "duplicate"}'::jsonb
  and (select count(*) = 1 from public.attribution_revenue r where r.project_id = pg_temp.q('project') and r.transaction_id = 'RC-TX-10'),
  'the same transaction again, or the same call again, is a duplicate');
select pg_temp.check(pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-3', 'renewal', 'nobody-known', 'RC-TX-11', 999, 'USD',
    jsonb_build_object('aliases', jsonb_build_array('$RCAnonymousID:x', 'anon-store')))) = '{"outcome": "recorded"}'::jsonb
  and (pg_temp.rev('project', 'txn:RC-TX-11')).person_id = pg_temp.q('store_person'),
  'a renewal is recorded too; an alias that is one of the person''s anonymous IDs finds them');
select pg_temp.check(pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-4', 'renewal', 'u-store', 'RC-TX-12', 1200, 'JPY'))
    = '{"outcome": "recorded"}'::jsonb
  and (pg_temp.rev('project', 'txn:RC-TX-12')).amount = 1200 and (pg_temp.rev('project', 'txn:RC-TX-12')).currency = 'JPY',
  'minor units follow the currency: 1200 yen is 1200 JPY');
select pg_temp.check(pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-5', 'initial_purchase', 'nobody', 'RC-TX-13', 999, 'USD'))
    = '{"outcome": "skipped", "reason": "no_person"}'::jsonb
  and pg_temp.rev('project', 'txn:RC-TX-13') is null and pg_temp.skips('project', 'no_person') = 1,
  'a purchase of someone the project does not know is skipped and counted as no_person');
select pg_temp.check(pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-6', 'refund', 'u-store', 'RC-TX-10', 999, 'USD'))
    = '{"outcome": "recorded"}'::jsonb
  and (select r.amount = -9.99 and r.currency = 'USD' and r.origin = 'store' and r.occurred_at >= now()
    and r.person_id = pg_temp.q('store_person') from pg_temp.rev('project', 'refund:RC-TX-10') r)
  and pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-7', 'refund', 'u-store', 'RC-TX-10', 999, 'USD'))
    = '{"outcome": "duplicate"}'::jsonb,
  'a refund is the negative refunded amount, dated when it arrives, once');
select pg_temp.check(pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-8', 'refund', 'someone-else', 'RC-TX-12', null, null))
    = '{"outcome": "recorded"}'::jsonb
  and (select r.amount = -1200 and r.currency = 'JPY' and r.person_id = pg_temp.q('store_person')
    from pg_temp.rev('project', 'refund:RC-TX-12') r),
  'a refund without an amount takes back the whole recorded payment, from whoever paid it');
select pg_temp.check(pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-9', 'refund', 'u-store', 'RC-TX-99', null, 'USD'))
    = '{"outcome": "ignored", "reason": "no_payment"}'::jsonb
  and pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-10', 'initial_purchase', 'u-store', 'RC-TX-14', 999, 'USD',
    '{"environment": "sandbox"}')) = '{"outcome": "ignored", "reason": "sandbox"}'::jsonb
  and pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-11', 'cancellation', 'u-store', 'RC-TX-10', null, 'USD'))
    = '{"outcome": "ignored", "reason": "not_a_payment"}'::jsonb
  and pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-12', 'other', 'u-store', null, null, null))
    = '{"outcome": "ignored", "reason": "not_a_payment"}'::jsonb
  and pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-13', 'initial_purchase', 'u-store', 'RC-TX-15', 0, 'USD'))
    = '{"outcome": "ignored", "reason": "free"}'::jsonb
  and pg_temp.webhook('quiet_header', 'revenuecat', pg_temp.store_body('rc-ev-14', 'initial_purchase', 'u-store', 'RC-TX-16', 999, 'USD'))
    = '{"outcome": "ignored", "reason": "attribution_off"}'::jsonb
  and pg_temp.revenue_rows('quiet') = 0,
  'a refund of a payment never seen, sandbox, a cancellation, other types, a free purchase and a project without attribution record nothing');
select pg_temp.check(pg_temp.webhook('adapty_header', 'adapty', pg_temp.store_body('ad-ev-1', 'initial_purchase', 'u-store', 'GPA.0001', 499, 'EUR',
    '{"store": "play_store"}')) = '{"outcome": "recorded"}'::jsonb
  and (select r.store = 'adapty' and r.amount = 4.99 and r.currency = 'EUR' from pg_temp.rev('project', 'txn:GPA.0001') r),
  'an Adapty purchase is recorded with Adapty as its tool');
select pg_temp.check(pg_temp.svc_try('attribution_store_revenue', pg_temp.store_body('rc-x', 'initial_purchase', 'u-store', 'X', 1, 'USD')
    || jsonb_build_object('header' || '_sha256', repeat('0', 64), 'provider', 'revenuecat')) = '28000'
  and pg_temp.svc_try('attribution_store_revenue', pg_temp.store_body('rc-x', 'initial_purchase', 'u-store', 'X', 1, 'USD')
    || jsonb_build_object('header' || '_sha256', pg_temp.sha256(pg_temp.t('rc_header')), 'provider', 'adapty')) = '28000'
  and pg_temp.svc_try('attribution_store_revenue', '{"provider": "revenuecat"}') = '22023 invalid_event'
  and pg_temp.svc_try('attribution_store_revenue', '[]') = '22023 invalid_event',
  'an unknown connection, the wrong tool for a header and a malformed body are refused as by the first call');

-- One transaction from the app and from the store is one payment --------------------------------------------
select pg_temp.send('live_key', 'anon-store', 'u-store', 'purchase', '{"kma_revenue": 9.99, "kma_currency": "USD", "kma_transaction_id": "RC-TX-20"}');
select pg_temp.check(pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-20', 'initial_purchase', 'u-store', 'RC-TX-20', 999, 'USD'))
    = '{"outcome": "duplicate"}'::jsonb
  and (pg_temp.rev('project', 'txn:RC-TX-20')).origin = 'event',
  'the app''s revenue call first: the store tool''s webhook for that transaction is a duplicate');
select pg_temp.keep('both_store_first', jsonb_build_array(
  pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-21', 'initial_purchase', 'u-store', 'RC-TX-21', 999, 'USD')),
  pg_temp.send('live_key', 'anon-store', 'u-store', 'purchase', '{"kma_revenue": 9.99, "kma_currency": "USD", "kma_transaction_id": "RC-TX-21"}')));
select pg_temp.check(pg_temp.j('both_store_first')->0 = '{"outcome": "recorded"}'::jsonb
  and pg_temp.j('both_store_first')->1->>'stored' = '1'
  and (select count(*) = 1 and bool_and(r.origin = 'store') from public.attribution_revenue r
    where r.project_id = pg_temp.q('project') and r.transaction_id = 'RC-TX-21'),
  'the webhook first: the app''s call for that transaction adds nothing');
select pg_temp.keep('both_refund', jsonb_build_array(
  pg_temp.webhook('rc_header', 'revenuecat', pg_temp.store_body('rc-ev-22', 'refund', 'u-store', 'RC-TX-20', 999, 'USD')),
  pg_temp.send('live_key', 'anon-store', 'u-store', 'refund', '{"kma_revenue": -9.99, "kma_currency": "USD", "kma_transaction_id": "RC-TX-20"}')));
select pg_temp.check(pg_temp.j('both_refund')->0 = '{"outcome": "recorded"}'::jsonb
  and pg_temp.j('both_refund')->1->>'stored' = '1'
  and (select count(*) = 1 and sum(r.amount) = -9.99 from public.attribution_revenue r
    where r.project_id = pg_temp.q('project') and r.dedupe_key = 'refund:RC-TX-20'),
  'and so is a refund reported by both');

-- Exchange rates ----------------------------------------------------------------------------------------------
select pg_temp.keep('fx', pg_temp.svc('attribution_fx_store', '{"rates": [
  {"day": "2026-10-01", "currency": "USD", "per_eur": 1.1},
  {"day": "2026-10-01", "currency": "CHF", "per_eur": 0.93},
  {"day": "2026-10-01", "currency": "EUR", "per_eur": 1},
  {"day": "2026-10-02", "currency": "CHF", "per_eur": 0.9},
  {"day": "2026-10-02", "currency": "CHF", "per_eur": 0.94}]}'));
select pg_temp.capture('attribution_fx_store', pg_temp.j('fx'));
select pg_temp.check(pg_temp.j('fx') = '{"stored": 3, "latest_day": "2026-11-03"}'::jsonb
  and (select per_eur = 0.94 from public.attribution_fx_rates where currency = 'CHF' and day = '2026-10-02')
  and not exists (select 1 from public.attribution_fx_rates where currency = 'EUR'),
  'rates are stored by day and currency, the euro skipped, a repeated day keeping the last; the answer names the newest day stored');
select pg_temp.keep('fx_again', pg_temp.svc('attribution_fx_store', '{"rates": [{"day": "2026-10-01", "currency": "USD", "per_eur": 1.0823}]}'));
select pg_temp.check(pg_temp.j('fx_again') = '{"stored": 1, "latest_day": "2026-11-03"}'::jsonb
  and (select per_eur = 1.0823 from public.attribution_fx_rates where currency = 'USD' and day = '2026-10-01')
  and pg_temp.svc('attribution_fx_store', '{"rates": []}') = '{"stored": 0, "latest_day": "2026-11-03"}'::jsonb,
  'storing a day again replaces its rate; an empty list stores nothing');
select pg_temp.check((select bool_and(pg_temp.svc_try('attribution_fx_store', i) = '22023 invalid_input')
  from unnest(array['[]', '{}', '{"rates": {}}',
    '{"rates": [{"day": "2026-02-30", "currency": "USD", "per_eur": 1.1}]}',
    '{"rates": [{"day": "26-10-01", "currency": "USD", "per_eur": 1.1}]}',
    '{"rates": [{"day": "2999-01-01", "currency": "USD", "per_eur": 1.1}]}',
    '{"rates": [{"day": "2026-10-03", "currency": "usd", "per_eur": 1.1}]}',
    '{"rates": [{"day": "2026-10-03", "currency": "USD", "per_eur": 0}]}',
    '{"rates": [{"day": "2026-10-03", "currency": "USD", "per_eur": "1.1"}]}',
    '{"rates": [{"day": "2026-10-03", "currency": "USD", "per_eur": 1.1}, "USD"]}']::jsonb[]) i)
  and pg_temp.svc_try('attribution_fx_store', jsonb_build_object('rates', (select jsonb_agg(jsonb_build_object('day', '2026-10-03',
    'currency', 'USD', 'per_eur', 1.1)) from generate_series(1, 20001)))) = '22023 invalid_input'
  and not exists (select 1 from public.attribution_fx_rates where day = '2026-10-03'),
  'a bad day, currency or rate, or more than 20000 rates, refuses the whole call');
select pg_temp.check(pg_temp.svc('attribution_fx_store', jsonb_build_object('rates', (select jsonb_agg(jsonb_build_object(
    'day', to_char(date '2000-01-03' + g / 4, 'YYYY-MM-DD'), 'currency', (array['SEK', 'NOK', 'DKK', 'PLN'])[g % 4 + 1],
    'per_eur', 9 + g / 100000.0)) from generate_series(0, 19999) g)))->>'stored' = '20000',
  'twenty thousand rates fit in one call');

-- The console: revenue events ----------------------------------------------------------------------------------
select pg_temp.check(pg_temp.save_try('analyst', 'project', '[]') = '42501'
  and pg_temp.save_try('stranger', 'project', '[]') = 'P0002'
  and pg_temp.save_try('developer', 'quiet', '[]') = '22023'
  and pg_temp.try('stranger', format('select public.attribution_revenue_setup(%L)', pg_temp.q('project'))) = 'P0002'
  and pg_temp.try('analyst', format('select public.attribution_revenue_setup(%L)', pg_temp.q('quiet'))) = '22023'
  and pg_temp.try('analyst', format('select public.attribution_revenue_setup(%L)', gen_random_uuid())) = 'P0002',
  'analysts cannot save; another workspace can neither read nor save; a project needs attribution on');
select pg_temp.check((select bool_and(pg_temp.save_try('developer', 'project', e) = '22023 invalid_input')
  from unnest(array['{}', '"order_paid"', (select jsonb_agg(jsonb_build_object('event', 'e' || g, 'amount_property', 'v', 'currency', 'USD'))
      from generate_series(1, 11) g)::text, '[1]', '[{"event": "a", "amount_property": "v", "currency": "USD", "note": "x"}]',
    '[{"amount_property": "v", "currency": "USD"}]', '[{"event": 5, "amount_property": "v", "currency": "USD"}]',
    '[{"event": "9lives", "amount_property": "v", "currency": "USD"}]',
    '[{"event": "a", "amount_property": "v", "currency": "USD"}, {"event": "a", "amount_property": "w", "currency": "USD"}]',
    '[{"event": "a", "currency": "USD"}]', '[{"event": "a", "amount_property": "a b", "currency": "USD"}]',
    '[{"event": "a", "amount_property": "kma_revenue", "currency": "USD"}]',
    '[{"event": "a", "amount_property": "v", "unit": "cents", "currency": "USD"}]',
    '[{"event": "a", "amount_property": "v", "currency": "USD", "currency_property": "cur"}]',
    '[{"event": "a", "amount_property": "v"}]', '[{"event": "a", "amount_property": "v", "currency_property": "1cur"}]',
    '[{"event": "a", "amount_property": "v", "currency": "US"}]']::jsonb[]) e),
  'every malformed list is refused as invalid_input');
select pg_temp.check(pg_temp.save_message('[{"event": "a", "amount_property": "v", "currency": "USD"}, {"event": "b", "amount_property": "v"}]')
    = 'Revenue event 2 (b) needs the property that holds the currency, or one currency for every such event'
  and pg_temp.save_message('[{"event": "order_paid", "amount_property": "v", "currency": "USD"}, {"event": "order_paid", "amount_property": "w", "currency": "USD"}]')
    = 'order_paid is listed twice; list each event once'
  and pg_temp.save_message('[{"event": "a", "amount_property": "kma_revenue", "currency": "USD"}]')
    = 'Revenue event 1 (a): events with kma_revenue are counted without an entry'
  and pg_temp.save_message('[{"event": "a", "amount_property": "v", "currency": "dollars"}]')
    = 'Revenue event 1 (a): a currency is a three-letter code such as USD'
  and pg_temp.save_message('[{"event": "a", "amount_property": "v", "currency": "USD", "note": "x"}]')
    = 'Revenue event 1 has a field that cannot be saved: note'
  and pg_temp.save_message('[{"event": " ", "amount_property": "v", "currency": "USD"}]') = 'Revenue event 1 needs an event name',
  'the messages name the entry and the problem in plain words');
select pg_temp.check(jsonb_array_length((pg_temp.setup('analyst', 'project'))->'events') = 4,
  'a refused save changes nothing');
select pg_temp.keep('saved', pg_temp.save('developer', 'project', '[
  {"event": "yen_pack", "amount_property": "price", "unit": "minor", "currency": "JPY"},
  {"event": " order_paid ", "amount_property": " total ", "unit": null, "currency_property": "currency", "currency": ""}]'));
select pg_temp.check(pg_temp.j('saved')->'events' = '[
    {"event": "yen_pack", "amount_property": "price", "unit": "minor", "currency_property": null, "currency": "JPY"},
    {"event": "order_paid", "amount_property": "total", "unit": "major", "currency_property": "currency", "currency": null}]'::jsonb
  and pg_temp.j('saved') = pg_temp.setup('analyst', 'project')
  and (select count(*) = 2 and bool_and(e.updated_by = pg_temp.q('developer')) from public.attribution_revenue_events e
    where e.project_id = pg_temp.q('project'))
  and (select position = 1 from public.attribution_revenue_events where project_id = pg_temp.q('project') and event_name = 'order_paid'),
  'a developer''s save replaces the list in the given order, trimmed, and answers what the setup reads');
select pg_temp.send('live_key', 'anon-bo', null, 'coins_bought', '{"price_cents": 499}');
select pg_temp.send('live_key', 'anon-bo', null, 'order_paid', '{"total": 30, "currency": "EUR", "kma_transaction_id": "ORD-2"}');
select pg_temp.check(pg_temp.rev_of_last('project', 'coins_bought') is null and (pg_temp.rev('project', 'txn:ORD-2')).amount = 30,
  'a removed event is no longer a payment; a changed one uses its new property');
select pg_temp.keep('saved_empty', pg_temp.save('developer', 'project', '[]'));
select pg_temp.check(pg_temp.j('saved_empty')->'events' = '[]'::jsonb
  and not exists (select 1 from public.attribution_revenue_events where project_id = pg_temp.q('project')),
  'an empty list removes every entry');

-- The console: what arrived ---------------------------------------------------------------------------------------
-- Rates before every payment of the last 7 days: 1.25 US dollars and 160 yen to the euro.
select pg_temp.svc('attribution_fx_store', jsonb_build_object('rates', jsonb_build_array(
  jsonb_build_object('day', to_char(current_date - 8, 'YYYY-MM-DD'), 'currency', 'USD', 'per_eur', 1.25),
  jsonb_build_object('day', to_char(current_date - 8, 'YYYY-MM-DD'), 'currency', 'JPY', 'per_eur', 160))));
select pg_temp.save('developer', 'shop', '[{"event": "order_paid", "amount_property": "value", "currency_property": "currency"},
  {"event": "coins_bought", "amount_property": "price_cents", "unit": "minor", "currency": "USD"}]');
insert into qa select 'shop_rc_header', pg_temp.call('owner', format('select public.workspace_store_connection_create(%L, %L, %L)',
  pg_temp.q('workspace'), pg_temp.q('shop'), 'revenuecat'))->>'header_value';
-- Ann pays 10 USD and is refunded; Ben pays 20 EUR in the app and 1200 JPY in the App Store; Cy
-- pays 5000 NGN (no ECB rate); a bot pays 99 USD; a developer pays 7 USD from a staging build;
-- the merchant's server imports a 50 USD payment from 10 days ago; three payments are skipped
-- today and one 10 days ago.
select pg_temp.send('shop_key', 'shop-ann', null, 'purchase', '{"kma_revenue": 10, "kma_currency": "USD", "kma_transaction_id": "S-1"}', 50);
select pg_temp.send('shop_key', 'shop-ann', null, 'refund', '{"kma_revenue": -10, "kma_currency": "USD", "kma_transaction_id": "S-1"}', 40);
select pg_temp.send('shop_key', 'shop-ben', 'u-ben', 'order_paid', '{"value": 20, "currency": "EUR"}', 30);
select pg_temp.webhook('shop_rc_header', 'revenuecat', pg_temp.store_body('shop-rc-1', 'initial_purchase', 'u-ben', 'SHOP-TX-1', 1200, 'JPY'));
select pg_temp.send('shop_key', 'shop-cy', null, 'purchase', '{"kma_revenue": 5000, "kma_currency": "NGN"}', 20);
select pg_temp.send('shop_key', 'shop-bot', null, 'purchase', '{"kma_revenue": 99, "kma_currency": "USD"}', 10);
-- Written directly: the merchant marks that person as a bot.
insert into public.analytics_bot_overrides(project_id, verdict, person_id) values (pg_temp.q('shop'), 'bot', pg_temp.person('shop', 'shop-bot'));
select pg_temp.send('shop_dev_key', 'shop-dev', null, 'purchase', '{"kma_revenue": 7, "kma_currency": "USD"}', 5);
select pg_temp.send('shop_server_key', null, 'u-old', 'purchase', '{"kma_revenue": 50, "kma_currency": "USD"}', 60 * 24 * 10);
select pg_temp.send('shop_server_key', null, 'u-old', 'purchase', '{"kma_revenue": 50, "kma_currency": "dollars"}', 60 * 24 * 10);
select pg_temp.send('shop_key', 'shop-cy', null, 'purchase', '{"kma_revenue": 5}', 15);
select pg_temp.send('shop_key', 'shop-cy', null, 'order_paid', '{"value": "free", "currency": "USD"}', 15);
select pg_temp.send('shop_key', 'shop-cy', null, 'coins_bought', '{"price_cents": true}', 15);

select pg_temp.keep('setup', pg_temp.setup('analyst', 'shop'));
select pg_temp.capture('revenue_setup', pg_temp.j('setup'));
select pg_temp.check(pg_temp.j('setup') - 'last_received_at' - 'last_development_at' - 'rates_day' = '{"currency": "USD",
    "events": [{"event": "order_paid", "amount_property": "value", "unit": "major", "currency_property": "currency", "currency": null},
      {"event": "coins_bought", "amount_property": "price_cents", "unit": "minor", "currency_property": null, "currency": "USD"}],
    "stores": [{"provider": "revenuecat", "connected": true}, {"provider": "adapty", "connected": false}],
    "last_7d": {"payments": 4, "refunds": 1, "payers": 3, "revenue": 34.38, "unconverted": 1},
    "by_origin": [{"origin": "event", "payments": 3}, {"origin": "store", "payments": 1}],
    "skipped_7d": [{"reason": "bad_amount", "events": 2}, {"reason": "no_currency", "events": 1}]}'::jsonb,
  'the last 7 days of production payments of people who are not bots, in US dollars: 10 - 10 + 25 (20 EUR) + 9.375 (1200 JPY) = 34.38, the NGN payment unconverted');
select pg_temp.check((pg_temp.j('setup')->>'last_received_at')::timestamptz = (select max(r.received_at) from public.attribution_revenue r
    where r.project_id = pg_temp.q('shop') and r.environment = 'production')
  and (pg_temp.j('setup')->>'last_development_at')::timestamptz = (select r.received_at from public.attribution_revenue r
    where r.project_id = pg_temp.q('shop') and r.environment = 'development')
  and pg_temp.j('setup')->>'rates_day' = to_char(current_date - 8, 'YYYY-MM-DD')
  and (select count(*) = 1 from public.attribution_revenue r where r.project_id = pg_temp.q('shop') and r.environment = 'development'),
  'it says when the last production and development payments arrived and the newest ECB day');
select pg_temp.check(pg_temp.setup('owner', 'shop') = pg_temp.j('setup') and pg_temp.setup('developer', 'shop') = pg_temp.j('setup')
  and pg_temp.j('setup')::text !~ '(@|u-ben|shop-ann|person|user_id)'
  and pg_temp.j('setup')::text not like '%' || pg_temp.t('shop') || '%',
  'every member reads the same counts and money, with no person, user or project ID');

select 'ok ' || count(*) || ' attribution revenue assertions' from revenue_assertions;
rollback;
