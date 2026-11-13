-- Provider-free test of a merchant's prepaid program balance: what the Balance page
-- reads, the automatic top-up settings, and every function the three balance edge
-- functions call. Stripe is never called: customers, cards, Checkout Sessions and
-- PaymentIntents are ids made up here. Programs are made live with the Phase 2 functions
-- while program money is still off, creators join with the Phase 3 functions, and sales
-- and commissions are fixture rows written straight into the tables.
begin;
set local time zone 'UTC';
create temporary table balance_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program balance assertion failed: %', label; end if;
  insert into balance_assertions values (label);
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$
  select value::uuid from qa where key = k
$$;
create function pg_temp.keep(k text, v text) returns void language sql as $$
  insert into qa values (k, v) on conflict (key) do update set value = excluded.value
$$;
-- Signs in. KissMyApps staff (kma_...) get a session that used their sign-in credentials.
create function pg_temp.sign_in(who text) returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('sub', pg_temp.q(who), 'role', 'authenticated')
    || case when who like 'kma\_%' then jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'pass' || 'word')))
      else '{}'::jsonb end)::text, true)
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
-- The same with nobody signed in, as one of the API roles.
create function pg_temp.try_signed_out(api_role text, statement text) returns text language plpgsql as $$
declare reason text;
begin
  perform set_config('request.jwt.claims', '', true);
  execute format('set local role %I', api_role);
  execute statement;
  reset role;
  return 'ok';
exception when others then
  reset role;
  get stacked diagnostics reason = pg_exception_detail;
  return btrim(sqlstate || ' ' || coalesce(reason, ''));
end $$;
-- Calls one service function the way an edge function does: as the service role.
create function pg_temp.svc(fn text, input jsonb) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  execute format('select public.%I(%L)', fn, input) into result;
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
-- Prints one function result as the front ends receive it (kept by KMA_DB_TEST_OUTPUT).
create function pg_temp.capture(name text, result jsonb) returns text language sql as $$
  select 'capture ' || name || ' ' || result::text
$$;
create function pg_temp.program(workspace text) returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q(workspace)
$$;
create function pg_temp.live_terms(workspace text) returns public.affiliate_program_terms language sql as $$
  select t from public.affiliate_program_terms t
  where t.program_id = (pg_temp.program(workspace)).id and t.version = (pg_temp.program(workspace)).live_terms_version
$$;
-- A workspace's live Stripe connection, as Phase 1 leaves it.
create function pg_temp.connect(workspace text, account text, business text) returns void language plpgsql as $$
declare v_business uuid;
begin
  insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
  select business, 'billing@' || workspace || '.example', w.created_by, w.id
  from public.analytics_workspaces w where w.id = pg_temp.q(workspace) returning id into v_business;
  insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status, business_name,
    country, charges_enabled, details_submitted, confirmed_at, verified_at)
  values (v_business, 'acct_Platform', true, account, 'active', business, 'GB', true, true, now(), now());
end $$;
-- The merchant saves the form, reads the agreement and publishes; KissMyApps approves.
create function pg_temp.publish(who text, workspace text, input jsonb) returns void language plpgsql as $$
begin
  perform pg_temp.call(who, format('select public.workspace_program_save(%L, %L)', pg_temp.q(workspace), input));
  perform pg_temp.call(who, format('select public.workspace_program_mark_agreement_read(%L, %L)', pg_temp.q(workspace),
    pg_temp.call(who, format('select public.workspace_program_agreement(%L)', pg_temp.q(workspace)))->>'sha256'));
  perform pg_temp.call(who, format('select public.workspace_program_submit(%L, %s)', pg_temp.q(workspace),
    (pg_temp.program(workspace)).revision));
  perform pg_temp.call('kma_owner', format('select public.review_admin_program(%L)',
    jsonb_build_object('program_id', (pg_temp.program(workspace)).id, 'decision', 'approve')));
end $$;
create function pg_temp.set_status(who text, workspace text, new_status text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_program_set_status(%L, %L, %s)', pg_temp.q(workspace), new_status,
    (pg_temp.program(workspace)).revision))
$$;
-- The Balance page, and a change of its settings.
create function pg_temp.page(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_program_balance(%L)', pg_temp.q(workspace)))
$$;
create function pg_temp.settings_sql(workspace text, input jsonb) returns text language sql as $$
  select format('select public.workspace_program_balance_settings(%L, %L)', pg_temp.q(workspace), input)
$$;
create function pg_temp.account(workspace text) returns public.program_balance_accounts language sql as $$
  select a from public.program_balance_accounts a where a.program_id = (pg_temp.program(workspace)).id
$$;
create function pg_temp.topup(k text) returns public.program_topups language sql as $$
  select t from public.program_topups t where t.id = pg_temp.q(k)
$$;
-- What an edge function passes when it has read a succeeded PaymentIntent back.
create function pg_temp.paid(k text, intent text, customer text, card text default null, overrides jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object('topup_id', pg_temp.q(k), 'outcome', 'succeeded', 'payment_intent_id', intent,
    'livemode', true, 'amount_minor', (pg_temp.topup(k)).amount_minor, 'currency', lower((pg_temp.topup(k)).currency),
    'customer_id', customer)
    || case when card is null then '{}'::jsonb else jsonb_build_object('card', jsonb_build_object(
      'payment_method_id', card, 'brand', 'visa', 'last4', '4242', 'exp_month', 4, 'exp_year', 2029)) end
    || overrides
$$;
-- Starts a deposit as the edge function does and remembers the top-up under a name.
create function pg_temp.deposit(k text, workspace text, who text, amount bigint) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  result := pg_temp.svc('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q(workspace),
    'user_id', pg_temp.q(who), 'platform_account_id', 'acct_Platform', 'amount_minor', amount));
  perform pg_temp.keep(k, result->>'topup_id');
  return result;
end $$;
-- Claims the accounts due for an automatic top-up and remembers the first top-up.
create function pg_temp.claim(k text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  result := pg_temp.svc('claim_program_auto_topups', '{"platform_account_id":"acct_Platform","limit":10,"lease_seconds":300}');
  if jsonb_array_length(result->'topups') > 0 then
    perform pg_temp.keep(k, result->'topups'->0->>'topup_id');
  end if;
  return result;
end $$;
create function pg_temp.entries(workspace text, kinds text[] default null) returns bigint language sql as $$
  select count(*) from public.program_balance_entries e
  where e.account_id = (pg_temp.account(workspace)).id and (kinds is null or e.kind = any(kinds))
$$;
create function pg_temp.audits(action_name text, target uuid) returns bigint language sql as $$
  select count(*) from public.audit_logs where action = action_name and target_id = target
$$;
create function pg_temp.n(rows_of text) returns bigint language plpgsql as $$
declare result bigint;
begin
  execute 'select count(*) from ' || rows_of into result;
  return result;
end $$;
create function pg_temp.money(enabled boolean) returns void language sql as $$
  update public.platform_settings set program_money_enabled = enabled where singleton
$$;
-- A disposable test cluster made without UTF-8 cannot run normalize(), which the readable
-- link address uses. This suite has no such names (see suite 76 for the same step).
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
grant all on qa, balance_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- People, workspaces and programs (program money is still off) ---------------------------------
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('f8000000-0000-4000-8000-000000000001', 'owner@speaksix.com', now(), '{"company":"SpeakSix"}'),
  ('f8000000-0000-4000-8000-000000000002', 'admin@speaksix.com', now(), '{}'),
  ('f8000000-0000-4000-8000-000000000003', 'analyst@speaksix.com', now(), '{}'),
  ('f8000000-0000-4000-8000-000000000004', 'owner@rival.co', now(), '{"company":"Rival"}'),
  ('f8000000-0000-4000-8000-000000000005', 'owner@draft.co', now(), '{"company":"Draft"}'),
  ('f8000000-0000-4000-8000-000000000006', 'owner@empty.co', now(), '{"company":"Empty"}'),
  ('f8000000-0000-4000-8000-000000000011', 'owner@kissmyapps.dev', now(), '{}'),
  ('f8000000-0000-4000-8000-000000000021', 'ada@creators.example', now(), '{}'),
  ('f8000000-0000-4000-8000-000000000026', 'stranger@elsewhere.co', now(), '{}');
insert into qa values
  ('owner', 'f8000000-0000-4000-8000-000000000001'), ('admin', 'f8000000-0000-4000-8000-000000000002'),
  ('analyst', 'f8000000-0000-4000-8000-000000000003'), ('rival_owner', 'f8000000-0000-4000-8000-000000000004'),
  ('draft_owner', 'f8000000-0000-4000-8000-000000000005'), ('empty_owner', 'f8000000-0000-4000-8000-000000000006'),
  ('kma_owner', 'f8000000-0000-4000-8000-000000000011'), ('ada', 'f8000000-0000-4000-8000-000000000021'),
  ('stranger', 'f8000000-0000-4000-8000-000000000026'),
  ('creator_ada', 'f9000000-0000-4000-8000-000000000001');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner');
insert into public.affiliates(id, public_name, legal_name, slug, status, country_code, channels, website_url) values
  (pg_temp.q('creator_ada'), 'Ada Okafor', 'Ada N. Okafor', 'ada-okafor', 'active', 'NG', array['tiktok'], null);
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at) values
  (pg_temp.q('creator_ada'), pg_temp.q('ada'), 'owner', true, false, now());
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true;
select pg_temp.money(false);

select pg_temp.sign_in('owner');
insert into qa select 'acme', public.analytics_bootstrap()->'workspaces'->0->>'id';
select public.analytics_invite_member(pg_temp.q('acme'), 'admin@speaksix.com', 'admin');
select public.analytics_invite_member(pg_temp.q('acme'), 'analyst@speaksix.com', 'analyst');
select pg_temp.sign_in('admin');
select public.analytics_bootstrap();
select pg_temp.sign_in('analyst');
select public.analytics_bootstrap();
select pg_temp.sign_in('rival_owner');
insert into qa select 'rival', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('draft_owner');
insert into qa select 'draft', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('empty_owner');
insert into qa select 'empty', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
select pg_temp.connect('acme', 'acct_SpeakSix', 'SpeakSix Ltd');
select pg_temp.connect('rival', 'acct_Rival', 'Rival Media');

select pg_temp.publish('owner', 'acme', '{"name":"SpeakSix","category":"education","tagline":"Speak English with confidence.",
  "landing_url":"https://speaksix.com/start","commission_type":"percent","commission_rate_bps":3000,
  "commission_duration":"months","commission_months":12}');
select pg_temp.publish('rival_owner', 'rival', '{"name":"Rival Reader","category":"entertainment","tagline":"Stories worth an evening.",
  "landing_url":"https://rivalreader.co/","commission_type":"fixed","commission_fixed_minor":500,
  "commission_duration":"first_payment"}');
select pg_temp.call('draft_owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('draft'), '{"name":"Draft Thing"}'::jsonb));
select pg_temp.call('ada', format('select public.partner_program_join(%L)', jsonb_build_object(
  'slug', 'speaksix', 'terms_version', t.version, 'agreement_sha256', t.agreement_sha256)))
from pg_temp.live_terms('acme') t;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select array_agg(p.slug || ':' || p.status order by p.slug) = array['draft-thing:draft', 'rival-reader:live',
    'speaksix:live'] from public.affiliate_programs p)
  and (select m.status = 'active' from public.affiliate_program_members m where m.affiliate_id = pg_temp.q('creator_ada')),
  'two programs are live, one is a draft, and one creator has joined');

-- Two sales of SpeakSix, written while program money is off so nothing evaluates them.
insert into qa values ('sale_held', gen_random_uuid()::text), ('sale_approved', gen_random_uuid()::text),
  ('commission_held', gen_random_uuid()::text), ('commission_approved', gen_random_uuid()::text);
insert into public.program_sales(id, program_id, connection_id, account_id, payment_intent_id, amount_minor, currency, paid_at)
select pg_temp.q(s.k), (pg_temp.program('acme')).id, c.id, c.account_id, s.intent, s.amount, 'USD', now() - s.age
from (values ('sale_held', 'pi_SaleHeld', 4900, interval '2 days'), ('sale_approved', 'pi_SaleApproved', 9800, interval '40 days'))
  s(k, intent, amount, age), public.merchant_connections c where c.account_id = 'acct_SpeakSix';

-- Closed by default ------------------------------------------------------------------------------
select pg_temp.check((select bool_and(not has_table_privilege(r, t, p))
  from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['public.program_balance_events', 'public.program_topups', 'public.program_balance_accounts',
      'public.program_balance_entries', 'kma_internal.program_balance_schedule']) t,
    unnest(array['select', 'insert', 'update', 'delete']) p)
  and (select relrowsecurity from pg_class where oid = 'public.program_balance_events'::regclass),
  'no API role can read or write the balance tables, and row security is on for the event receipts');
select pg_temp.check((select count(*) = 2 and bool_and(has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute')
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('workspace_program_balance', 'workspace_program_balance_settings')),
  'signed-in users may call the two merchant functions; each is a security definer function with an empty search path');
select pg_temp.check((select count(*) = 14 and bool_and(has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('open_program_balance', 'attach_program_balance_customer',
    'begin_program_deposit', 'find_program_topup', 'attach_program_topup', 'settle_program_topup', 'reverse_program_topup',
    'save_program_balance_card', 'record_program_balance_event', 'finish_program_balance_event',
    'claim_program_auto_topups', 'claim_program_topup_checks', 'release_program_topup', 'program_balance_health')),
  'only the service role may call the fourteen service functions');
select pg_temp.check((select count(*) >= 10 and bool_and(not has_function_privilege(r, p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'service_role']) r
  where n.nspname = 'kma_internal' and (p.proname like 'program\_balance\_%' or p.proname like 'program\_topup\_%'
    or p.proname = 'tick_program_balance_schedule')),
  'the internal helpers and the schedule tick are closed to every API role');
select pg_temp.check(pg_temp.try_signed_out(r, s) = '42501', format('%s cannot run %s', r, left(s, 60)))
from unnest(array['anon', 'authenticated']) r, unnest(array[
  format('select public.workspace_program_balance(%L)', pg_temp.q('acme')),
  pg_temp.settings_sql('acme', '{"auto_topup":false}'),
  'select public.open_program_balance(''{}'')', 'select public.settle_program_topup(''{}'')',
  'select public.reverse_program_topup(''{}'')', 'select public.claim_program_auto_topups(''{}'')',
  'select public.save_program_balance_card(''{}'')', 'select public.program_balance_health()',
  'select kma_internal.program_balance_post(null, ''deposit'', 1)', 'select kma_internal.tick_program_balance_schedule()']) s;
select pg_temp.check(pg_temp.try_signed_out('service_role', format('select public.workspace_program_balance(%L)', pg_temp.q('acme'))) = '42501'
  and pg_temp.try_signed_out('service_role', pg_temp.settings_sql('acme', '{"auto_topup":false}')) = '42501'
  and pg_temp.try_signed_out('service_role', 'select kma_internal.program_balance_resume(null)') = '42501'
  and pg_temp.try('owner', 'select public.settle_program_topup(''{}'')') = '42501'
  and pg_temp.try('owner', 'select public.begin_program_deposit(''{}'')') = '42501',
  'the service role cannot call the merchant functions, and a signed-in merchant cannot call a service function');

-- Program money switched off -----------------------------------------------------------------------
select pg_temp.capture('workspace_program_balance.money_off', pg_temp.page('owner', 'acme'));
select pg_temp.check(pg_temp.page('owner', 'acme') @> '{"enabled":false,"can_manage":true,"account":null,"activity":[],"pending_topup":null,
    "min_deposit_minor":5000,"fee_bps":1000,"program":{"name":"SpeakSix","status":"live","pause_reason":null,"currency":"USD"}}'
  and pg_temp.page('owner', 'acme')->'program'->>'id' = (pg_temp.program('acme')).id::text,
  'while program money is off the page says so and shows the program without a balance');
select pg_temp.check(pg_temp.svc_try('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('acme'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_Platform')) = '22023 program_money_disabled'
  and pg_temp.svc('claim_program_auto_topups', '{"platform_account_id":"acct_Platform"}') = '{"topups":[]}'
  and pg_temp.n('public.program_balance_accounts') = 0,
  'while program money is off no balance can be opened and nothing is claimed');
select pg_temp.money(true);

-- Who may see and open a balance -------------------------------------------------------------------
select pg_temp.capture('workspace_program_balance.no_program', pg_temp.page('empty_owner', 'empty'));
select pg_temp.capture('workspace_program_balance.no_account', pg_temp.page('owner', 'acme'));
select pg_temp.check(pg_temp.page('empty_owner', 'empty') = '{"enabled":true,"can_manage":true,"program":null,"account":null,
    "min_deposit_minor":5000,"fee_bps":1000,"activity":[],"pending_topup":null}'
  and pg_temp.page('analyst', 'acme') @> '{"enabled":true,"can_manage":false,"account":null}'
  and pg_temp.page('admin', 'acme') @> '{"can_manage":true}'
  and pg_temp.try('stranger', format('select public.workspace_program_balance(%L)', pg_temp.q('acme'))) = 'P0002'
  and pg_temp.try('rival_owner', format('select public.workspace_program_balance(%L)', pg_temp.q('acme'))) = 'P0002',
  'any member reads the page, only owners and admins can manage, and nobody outside the workspace sees it');
select pg_temp.check(
  pg_temp.svc_try('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('stranger'),
    'platform_account_id', 'acct_Platform')) = '42501 not_a_member'
  and pg_temp.svc_try('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('analyst'),
    'platform_account_id', 'acct_Platform')) = '42501 owner_or_admin_required'
  and pg_temp.svc_try('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('empty'), 'user_id', pg_temp.q('empty_owner'),
    'platform_account_id', 'acct_Platform')) = '22023 no_program'
  and pg_temp.svc_try('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('owner'),
    'platform_account_id', 'acct_Platform', 'create', false)) = '22023 balance_not_started'
  and pg_temp.svc_try('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('owner'),
    'platform_account_id', 'not an account')) = '22023 invalid_input'
  and pg_temp.svc_try('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('owner'),
    'platform_account_id', 'acct_Platform', 'extra', 1)) = '22023 invalid_input'
  and pg_temp.svc_try('open_program_balance', '[]') = '22023 invalid_input'
  and pg_temp.n('public.program_balance_accounts') = 0,
  'a balance is opened only by an owner or admin of a workspace that has a program');

create temporary table opened as select pg_temp.svc('open_program_balance', jsonb_build_object(
  'workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('admin'), 'platform_account_id', 'acct_Platform')) as answer;
select pg_temp.check((select answer @> '{"currency":"USD","program_currency":"USD","program_name":"SpeakSix","business_name":"SpeakSix Ltd",
      "stripe_customer_id":null,"has_card":false,"min_deposit_minor":5000,"max_deposit_minor":100000000}'
      and answer->>'account_id' = (pg_temp.account('acme')).id::text and answer->>'program_id' = (pg_temp.program('acme')).id::text
    from opened)
  and (select a.currency = 'USD' and a.available_minor = 0 and a.platform_account_id = 'acct_Platform' and a.auto_topup
      and a.min_balance_minor = 5000 and a.topup_amount_minor = 10000 and a.created_by = pg_temp.q('admin')
    from pg_temp.account('acme') a)
  and pg_temp.audits('program_balance_opened', (pg_temp.account('acme')).id) = 1,
  'an admin opens the balance in the program''s currency with the default top-up settings');
select pg_temp.check(pg_temp.svc('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('acme'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_Platform'))->>'account_id' = (select answer->>'account_id' from opened)
  and pg_temp.n('public.program_balance_accounts') = 1
  and pg_temp.audits('program_balance_opened', (pg_temp.account('acme')).id) = 1
  and pg_temp.svc_try('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('owner'),
    'platform_account_id', 'acct_Other')) = '22023 platform_mismatch',
  'opening again returns the same account, and another Stripe platform cannot take it over');

-- The Stripe customer -----------------------------------------------------------------------------
select pg_temp.check(pg_temp.svc_try('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('acme'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_Platform', 'amount_minor', 5000)) = '22023 balance_not_started',
  'a deposit cannot start before the account has its Stripe customer');
select pg_temp.check(
  pg_temp.svc('attach_program_balance_customer', jsonb_build_object('account_id', (pg_temp.account('acme')).id,
    'stripe_customer_id', 'cus_Acme', 'platform_account_id', 'acct_Platform'))->>'stripe_customer_id' = 'cus_Acme'
  and pg_temp.svc('attach_program_balance_customer', jsonb_build_object('account_id', (pg_temp.account('acme')).id,
    'stripe_customer_id', 'cus_Second', 'platform_account_id', 'acct_Platform'))->>'stripe_customer_id' = 'cus_Acme'
  and pg_temp.svc_try('attach_program_balance_customer', jsonb_build_object('account_id', (pg_temp.account('acme')).id,
    'stripe_customer_id', 'cus_Acme', 'platform_account_id', 'acct_Other')) = '22023 platform_mismatch'
  and pg_temp.svc_try('attach_program_balance_customer', jsonb_build_object('account_id', (pg_temp.account('acme')).id,
    'stripe_customer_id', 'not a customer', 'platform_account_id', 'acct_Platform')) = '22023 invalid_input'
  and pg_temp.svc_try('attach_program_balance_customer', jsonb_build_object('account_id', gen_random_uuid(),
    'stripe_customer_id', 'cus_Acme', 'platform_account_id', 'acct_Platform')) = 'P0002 account_not_found',
  'the first Stripe customer stored for an account stays');

-- Starting a deposit -------------------------------------------------------------------------------
select pg_temp.check(pg_temp.svc_try('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('acme'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_Platform', 'amount_minor', bad.amount)) = '22023 invalid_amount_minor',
  format('a first deposit of %s is refused', bad.amount))
from (values ('4999'::jsonb), ('0'), ('100000001'), ('50.5'), ('"5000"'), ('-5000'), ('true')) bad(amount);
select pg_temp.check(
  pg_temp.svc_try('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('analyst'),
    'platform_account_id', 'acct_Platform', 'amount_minor', 5000)) = '42501 owner_or_admin_required'
  and pg_temp.svc_try('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('stranger'),
    'platform_account_id', 'acct_Platform', 'amount_minor', 5000)) = '42501 not_a_member'
  and pg_temp.svc_try('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('owner'),
    'platform_account_id', 'acct_Other', 'amount_minor', 5000)) = '22023 platform_mismatch'
  and pg_temp.svc_try('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('owner'),
    'platform_account_id', 'acct_Platform')) = '22023 invalid_input'
  and pg_temp.n('public.program_topups') = 0,
  'only an owner or admin starts a deposit, on the platform the balance belongs to');

create temporary table first_deposit as select pg_temp.deposit('t_first', 'acme', 'owner', 5000) as answer;
select pg_temp.check((select answer @> '{"kind":"deposit","status":"pending","amount_minor":5000,"currency":"USD","reversed_minor":0,
      "stripe_customer_id":"cus_Acme","platform_account_id":"acct_Platform","program_name":"SpeakSix","superseded":[],
      "checkout_session_id":null,"payment_intent_id":null}'
      and answer->>'account_id' = (pg_temp.account('acme')).id::text and answer->>'workspace_id' = pg_temp.q('acme')::text
    from first_deposit)
  and (select t.requested_by = pg_temp.q('owner') and t.lease_until between clock_timestamp() + interval '9 minutes'
      and clock_timestamp() + interval '11 minutes' from pg_temp.topup('t_first') t),
  'the minimum first deposit starts as one pending top-up that the worker first looks at ten minutes later');

-- Stripe ids are written once.
select pg_temp.check(
  pg_temp.svc('attach_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_first'), 'checkout_session_id', 'cs_live_First'))
    @> '{"status":"processing","checkout_session_id":"cs_live_First","payment_intent_id":null}'
  and pg_temp.svc('attach_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_first'), 'checkout_session_id', 'cs_live_First'))
    @> '{"status":"processing"}'
  and pg_temp.svc_try('attach_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_first'), 'checkout_session_id', 'cs_live_Other'))
    = '22023 topup_mismatch'
  and pg_temp.svc_try('attach_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_first'))) = '22023 invalid_input'
  and pg_temp.svc_try('attach_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_first'), 'payment_intent_id', 'cs_wrong'))
    = '22023 invalid_input'
  and pg_temp.svc_try('attach_program_topup', jsonb_build_object('topup_id', gen_random_uuid(), 'payment_intent_id', 'pi_Nobody'))
    = 'P0002 topup_not_found',
  'a top-up takes its Checkout Session once and then counts as processing');
select pg_temp.capture('workspace_program_balance.first_deposit_pending', pg_temp.page('owner', 'acme'));
select pg_temp.check((select d->'pending_topup' = jsonb_build_object('id', pg_temp.q('t_first'), 'amount_minor', 5000,
      'status', 'processing', 'created_at', to_jsonb((pg_temp.topup('t_first')).created_at))
      and d->'account' @> '{"currency":"USD","available_minor":0,"reserved_minor":0,"creators_pending_minor":0,
        "creators_approved_minor":0,"fees_minor":0,"deposited_minor":0,"card":null,"auto_topup":true,
        "min_balance_minor":5000,"topup_amount_minor":10000,"topup_problem":null}'
      and d->'activity' = '[]'
    from pg_temp.page('analyst', 'acme') d),
  'the page shows the deposit that is on its way and an empty balance');

-- A second deposit closes the first, which was never paid.
create temporary table second_deposit as select pg_temp.deposit('t_main', 'acme', 'admin', 15000) as answer;
select pg_temp.check((select answer->'superseded' = jsonb_build_array(jsonb_build_object('topup_id', pg_temp.q('t_first'),
      'checkout_session_id', 'cs_live_First')) from second_deposit)
  and (select t.status = 'canceled' and t.failure_code = 'superseded' and t.settled_at is not null and t.lease_until is null
    from pg_temp.topup('t_first') t)
  and pg_temp.page('owner', 'acme')->'pending_topup'->>'id' = pg_temp.q('t_main')::text
  and pg_temp.page('owner', 'acme')->'pending_topup'->>'status' = 'pending',
  'starting again closes the unpaid deposit and hands back its Checkout Session to be ended at Stripe');
select pg_temp.svc('attach_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_main'), 'checkout_session_id', 'cs_live_Main'));

-- Finding a top-up from a Stripe object -------------------------------------------------------------
select pg_temp.check(
  pg_temp.svc('find_program_topup', '{"checkout_session_id":"cs_live_Main"}') @> jsonb_build_object('found', true,
    'topup_id', pg_temp.q('t_main'), 'status', 'processing', 'kind', 'deposit', 'amount_minor', 15000, 'currency', 'USD',
    'stripe_customer_id', 'cus_Acme', 'platform_account_id', 'acct_Platform', 'payment_method_id', null)
  and pg_temp.svc('find_program_topup', jsonb_build_object('payment_intent_id', 'pi_Main', 'topup_id', pg_temp.q('t_main')))
    ->>'topup_id' = pg_temp.q('t_main')::text
  and pg_temp.svc('find_program_topup', '{"payment_intent_id":"pi_Nobody"}') = '{"found":false}'
  and pg_temp.svc('find_program_topup', jsonb_build_object('checkout_session_id', 'cs_live_Main', 'topup_id', pg_temp.q('t_first')))
    = '{"found":false,"conflict":true}'
  and pg_temp.svc('find_program_topup', jsonb_build_object('checkout_session_id', 'cs_live_Other', 'topup_id', pg_temp.q('t_main')))
    = '{"found":false,"conflict":true}'
  and pg_temp.svc_try('find_program_topup', '{}') = '22023 invalid_input'
  and pg_temp.svc_try('find_program_topup', '{"topup_id":"not-a-uuid"}') = '22023 invalid_input'
  and pg_temp.svc_try('find_program_topup', '{"payment_intent_id":"cs_live_Main"}') = '22023 invalid_input',
  'a top-up is found by its payment, its Checkout Session or its own id, and two ids must agree');

-- Settling: only the exact payment adds to the balance, and only once ------------------------------
select pg_temp.check(pg_temp.svc_try('settle_program_topup', pg_temp.paid('t_main', 'pi_Main', 'cus_Acme', 'pm_AcmeVisa', wrong.change))
    = '22023 topup_mismatch', 'a payment is not credited when ' || wrong.why)
from (values ('{"amount_minor":14999}'::jsonb, 'its amount is lower'), ('{"amount_minor":15001}', 'its amount is higher'),
  ('{"currency":"eur"}', 'its currency differs'), ('{"customer_id":"cus_Other"}', 'it was paid by another customer'),
  ('{"customer_id":null}', 'it has no customer'), ('{"livemode":false}', 'it is not a live payment'),
  ('{"amount_minor":"15000"}', 'its amount is not a number')) wrong(change, why);
select pg_temp.check(
  pg_temp.svc_try('settle_program_topup', pg_temp.paid('t_main', 'pi_Main', 'cus_Acme') - 'payment_intent_id') = '22023 invalid_input'
  and pg_temp.svc_try('settle_program_topup', pg_temp.paid('t_main', 'pi_Main', 'cus_Acme', 'pm_AcmeVisa',
    '{"card":{"payment_method_id":"pm_AcmeVisa","brand":"visa","last4":"42424242","exp_month":4,"exp_year":2029}}')) = '22023 invalid_input'
  and pg_temp.svc_try('settle_program_topup', pg_temp.paid('t_main', 'pi_Main', 'cus_Acme', 'pm_AcmeVisa',
    '{"card":{"payment_method_id":"pm_AcmeVisa","brand":"visa","last4":"4242","exp_month":13,"exp_year":2029}}')) = '22023 invalid_input'
  and pg_temp.svc_try('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_main'), 'outcome', 'refunded')) = '22023 invalid_input'
  and pg_temp.svc_try('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_main'), 'outcome', 'failed')) = '22023 invalid_input'
  and pg_temp.svc_try('settle_program_topup', jsonb_build_object('topup_id', gen_random_uuid(), 'outcome', 'canceled')) = 'P0002 topup_not_found'
  and (pg_temp.account('acme')).available_minor = 0 and pg_temp.entries('acme') = 0
  and (pg_temp.topup('t_main')).status = 'processing' and (pg_temp.account('acme')).payment_method_id is null,
  'a settlement that is incomplete or malformed changes nothing');

create temporary table settled as select pg_temp.svc('settle_program_topup',
  pg_temp.paid('t_main', 'pi_Main', 'cus_Acme', 'pm_AcmeVisa')) as answer;
select pg_temp.check((select answer @> '{"status":"succeeded","changed":true,"available_minor":15000,"program_resumed":false,
      "payment_intent_id":"pi_Main","replaced_payment_method_id":null,"topup_failures":0}' from settled)
  and (select a.available_minor = 15000 and a.payment_method_id = 'pm_AcmeVisa' and a.card_brand = 'visa' and a.card_last4 = '4242'
      and a.card_exp_month = 4 and a.card_exp_year = 2029 from pg_temp.account('acme') a)
  and (select t.status = 'succeeded' and t.settled_at is not null and t.lease_until is null and t.payment_intent_id = 'pi_Main'
    from pg_temp.topup('t_main') t)
  and (select count(*) = 1 and bool_and(e.kind = 'deposit' and e.amount_minor = 15000 and e.available_after_minor = 15000
      and e.topup_id = pg_temp.q('t_main')) from public.program_balance_entries e where e.account_id = (pg_temp.account('acme')).id),
  'the exact live payment adds the deposit to the balance and saves the card Stripe reports');

-- The same event again, in any form, adds nothing.
select pg_temp.check(
  pg_temp.svc('settle_program_topup', pg_temp.paid('t_main', 'pi_Main', 'cus_Acme', 'pm_AcmeVisa'))
    @> '{"status":"succeeded","changed":false,"available_minor":15000}'
  and pg_temp.svc('settle_program_topup', pg_temp.paid('t_main', 'pi_Main', 'cus_Acme'))  @> '{"changed":false}'
  and pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_main'), 'outcome', 'failed',
    'payment_intent_id', 'pi_Main', 'failure_code', 'card_declined')) @> '{"status":"succeeded","changed":false}'
  and pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_main'), 'outcome', 'canceled'))
    @> '{"status":"succeeded","changed":false}'
  and pg_temp.svc_try('settle_program_topup', pg_temp.paid('t_main', 'pi_Other', 'cus_Acme')) = '22023 topup_mismatch'
  and pg_temp.svc_try('attach_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_first'), 'payment_intent_id', 'pi_Main'))
    = '22023 topup_mismatch'
  and pg_temp.svc_try('settle_program_topup', pg_temp.paid('t_first', 'pi_Main', 'cus_Acme')) = '22023 topup_mismatch'
  and (pg_temp.account('acme')).available_minor = 15000 and pg_temp.entries('acme') = 1
  and (pg_temp.topup('t_first')).status = 'canceled',
  'a repeated or late event for a settled top-up adds nothing, and one payment cannot settle two top-ups');
select pg_temp.check(pg_temp.page('owner', 'acme') @> '{"pending_topup":null,"account":{"available_minor":15000,"deposited_minor":15000,
    "card":{"brand":"visa","last4":"4242","exp_month":4,"exp_year":2029}}}'
  and pg_temp.svc('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('owner'),
    'platform_account_id', 'acct_Platform', 'create', false)) @> '{"has_card":true,"min_deposit_minor":1000,"stripe_customer_id":"cus_Acme"}',
  'after the first deposit the page shows the card, and later deposits may be as small as 10.00');
select pg_temp.check(pg_temp.svc_try('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('acme'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_Platform', 'amount_minor', 999)) = '22023 invalid_amount_minor',
  'a later deposit below 10.00 is refused');

-- Settings -----------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.try(bad.who, pg_temp.settings_sql(bad.workspace, bad.input)) = bad.expected,
  format('settings %s by %s end as %s', bad.input, bad.who, bad.expected))
from (values
  ('analyst', 'acme', '{"auto_topup":false}'::jsonb, '42501'),
  ('stranger', 'acme', '{"auto_topup":false}', 'P0002'),
  ('rival_owner', 'acme', '{"auto_topup":false}', 'P0002'),
  ('rival_owner', 'rival', '{"auto_topup":false}', '22023 balance_not_started'),
  ('empty_owner', 'empty', '{"auto_topup":false}', '22023 balance_not_started'),
  ('owner', 'acme', '{}', '22023 invalid_input'),
  ('owner', 'acme', '[]', '22023 invalid_input'),
  ('owner', 'acme', '{"auto_topup":true,"card":"pm_x"}', '22023 invalid_input'),
  ('owner', 'acme', '{"auto_topup":"yes"}', '22023 invalid_auto_topup'),
  ('owner', 'acme', '{"auto_topup":null}', '22023 invalid_auto_topup'),
  ('owner', 'acme', '{"min_balance_minor":-1}', '22023 invalid_min_balance_minor'),
  ('owner', 'acme', '{"min_balance_minor":100000001}', '22023 invalid_min_balance_minor'),
  ('owner', 'acme', '{"min_balance_minor":50.5}', '22023 invalid_min_balance_minor'),
  ('owner', 'acme', '{"min_balance_minor":"5000"}', '22023 invalid_min_balance_minor'),
  ('owner', 'acme', '{"topup_amount_minor":999}', '22023 invalid_topup_amount_minor'),
  ('owner', 'acme', '{"topup_amount_minor":100000001}', '22023 invalid_topup_amount_minor'),
  ('owner', 'acme', '{"topup_amount_minor":null}', '22023 invalid_topup_amount_minor')) bad(who, workspace, input, expected);
select pg_temp.check((select a.auto_topup and a.min_balance_minor = 5000 and a.topup_amount_minor = 10000 from pg_temp.account('acme') a)
  and pg_temp.audits('program_balance_settings_changed', (pg_temp.account('acme')).id) = 0,
  'a refused settings change leaves everything as it was');
create temporary table saved as select pg_temp.call('admin', pg_temp.settings_sql('acme',
  '{"auto_topup":false,"min_balance_minor":20000,"topup_amount_minor":10000}')) as answer;
select pg_temp.capture('workspace_program_balance_settings', (select answer from saved));
select pg_temp.check((select answer->'account' @> '{"auto_topup":false,"min_balance_minor":20000,"topup_amount_minor":10000}'
      and answer @> '{"enabled":true,"can_manage":true}' and answer ? 'activity' from saved)
  and (select a.actor_user_id = pg_temp.q('admin') and a.before_data = '{"auto_topup":true,"min_balance_minor":5000,"topup_amount_minor":10000}'
      and a.after_data = '{"auto_topup":false,"min_balance_minor":20000,"topup_amount_minor":10000}'
    from public.audit_logs a where a.action = 'program_balance_settings_changed' and a.target_id = (pg_temp.account('acme')).id)
  and pg_temp.call('owner', pg_temp.settings_sql('acme', '{"min_balance_minor":20000}'))->'account'->>'min_balance_minor' = '20000'
  and pg_temp.audits('program_balance_settings_changed', (pg_temp.account('acme')).id) = 1
  and pg_temp.call('owner', pg_temp.settings_sql('acme', '{"auto_topup":true}'))->'account'->>'auto_topup' = 'true'
  and pg_temp.call('owner', pg_temp.settings_sql('acme', '{"min_balance_minor":0}'))->'account'->>'min_balance_minor' = '0'
  and pg_temp.call('owner', pg_temp.settings_sql('acme', '{"min_balance_minor":20000}'))->'account'->>'min_balance_minor' = '20000'
  and pg_temp.audits('program_balance_settings_changed', (pg_temp.account('acme')).id) = 4,
  'an owner or admin changes the settings, gets the page back, and each real change is in the audit log');

-- A balance without a card: the draft program's.
select pg_temp.svc('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('draft'), 'user_id', pg_temp.q('draft_owner'),
  'platform_account_id', 'acct_Platform'));
select pg_temp.check((select a.auto_topup and a.payment_method_id is null from pg_temp.account('draft') a)
  and pg_temp.try('draft_owner', pg_temp.settings_sql('draft', '{"auto_topup":true}')) = '22023 card_required'
  and pg_temp.call('draft_owner', pg_temp.settings_sql('draft', '{"topup_amount_minor":25000}'))->'account'
    @> '{"auto_topup":true,"topup_amount_minor":25000,"card":null}'
  and pg_temp.call('draft_owner', pg_temp.settings_sql('draft', '{"auto_topup":false}'))->'account'->>'auto_topup' = 'false'
  and pg_temp.try('draft_owner', pg_temp.settings_sql('draft', '{"auto_topup":true,"min_balance_minor":1000}')) = '22023 card_required'
  and pg_temp.svc('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('draft'), 'user_id', pg_temp.q('draft_owner'),
    'platform_account_id', 'acct_Platform')) @> '{"business_name":"Draft","program_name":"Draft Thing","currency":"USD"}',
  'a draft program can open its balance; automatic top-up cannot be switched on without a card');
-- Nothing has happened on that account, so it follows a change of the program's currency.
select pg_temp.call('draft_owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('draft'),
  jsonb_build_object('currency', 'EUR', 'revision', (pg_temp.program('draft')).revision)));
select pg_temp.check(pg_temp.svc('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('draft'),
    'user_id', pg_temp.q('draft_owner'), 'platform_account_id', 'acct_Platform')) @> '{"currency":"EUR","program_currency":"EUR"}'
  and (pg_temp.account('draft')).currency = 'EUR',
  'an account nothing has happened on follows the program''s currency');
-- Once money has been asked for, the currency is fixed, and a program in another currency cannot be paid into.
select pg_temp.svc('attach_program_balance_customer', jsonb_build_object('account_id', (pg_temp.account('draft')).id,
  'stripe_customer_id', 'cus_Draft', 'platform_account_id', 'acct_Platform'));
select pg_temp.deposit('t_draft', 'draft', 'draft_owner', 5000);
select pg_temp.call('draft_owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('draft'),
  jsonb_build_object('currency', 'GBP', 'revision', (pg_temp.program('draft')).revision)));
select pg_temp.check(pg_temp.svc('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('draft'),
    'user_id', pg_temp.q('draft_owner'), 'platform_account_id', 'acct_Platform')) @> '{"currency":"EUR","program_currency":"GBP"}'
  and (pg_temp.topup('t_draft')).currency = 'EUR'
  and pg_temp.svc_try('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('draft'), 'user_id', pg_temp.q('draft_owner'),
    'platform_account_id', 'acct_Platform', 'amount_minor', 5000)) = '22023 currency_mismatch'
  and (pg_temp.topup('t_draft')).status = 'pending',
  'once a deposit was started the balance keeps its currency, and it takes no deposit while the program is in another one');

-- Commissions on the page -----------------------------------------------------------------------------
-- Fixture rows: one commission still in its hold, one already approved.
insert into public.program_commissions(id, sale_id, program_id, member_id, affiliate_id, terms_version, status, currency,
  basis_minor, commission_type, commission_rate_bps, fee_bps, earned_minor, amount_minor, fee_earned_minor, fee_minor,
  hold_until, approved_at)
select pg_temp.q(c.k), pg_temp.q(c.sale), m.program_id, m.id, m.affiliate_id, m.terms_version, c.status, 'USD',
  c.basis, 'percent', 3000, 1000, c.amount, c.amount, c.fee, c.fee, now() + c.hold, c.approved
from (values ('commission_held', 'sale_held', 'held', 4900, 1470, 147, interval '28 days', null::timestamptz),
    ('commission_approved', 'sale_approved', 'approved', 9800, 2940, 294, interval '-10 days', now() - interval '10 days'))
  c(k, sale, status, basis, amount, fee, hold, approved),
  public.affiliate_program_members m where m.affiliate_id = pg_temp.q('creator_ada');
select kma_internal.program_balance_post((pg_temp.account('acme')).id, 'commission_reserved', -2940, null, pg_temp.q('commission_approved'));
select kma_internal.program_balance_post((pg_temp.account('acme')).id, 'fee_reserved', -294, null, pg_temp.q('commission_approved'));
select kma_internal.program_balance_post((pg_temp.account('acme')).id, 'commission_reserved', -1470, null, pg_temp.q('commission_held'));
select kma_internal.program_balance_post((pg_temp.account('acme')).id, 'fee_reserved', -147, null, pg_temp.q('commission_held'));
insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, commission_id)
values (pg_temp.q('creator_ada'), (pg_temp.program('acme')).id, 'USD', 'commission_approved', 2940, pg_temp.q('commission_approved'));
select pg_temp.capture('workspace_program_balance.funded', pg_temp.page('owner', 'acme'));
select pg_temp.check((select d->'account' = '{"currency":"USD","available_minor":10149,"reserved_minor":1617,
      "creators_pending_minor":1470,"creators_approved_minor":2940,"fees_minor":441,"deposited_minor":15000,
      "card":{"brand":"visa","last4":"4242","exp_month":4,"exp_year":2029},
      "auto_topup":true,"min_balance_minor":20000,"topup_amount_minor":10000,"topup_problem":null,"topup_limit":null}'
      and jsonb_array_length(d->'activity') = 5
      and (select array_agg(e->>'kind') = array['fee_reserved', 'commission_reserved', 'fee_reserved', 'commission_reserved', 'deposit']
          and array_agg((e->>'amount_minor')::int) = array[-147, -1470, -294, -2940, 15000]
          and array_agg((e->>'available_after_minor')::int) = array[10149, 10296, 11766, 12060, 15000]
          and array_agg(e->>'creator_name') = array['Ada Okafor', 'Ada Okafor', 'Ada Okafor', 'Ada Okafor', null]
          and array_agg((e->>'sale_amount_minor')::int) = array[4900, 4900, 9800, 9800, null]
          and array_agg(e->>'topup_kind') = array[null, null, null, null, 'deposit']
          and bool_and(e ? 'note' and e->>'note' is null and e->>'id' is not null and e->>'created_at' is not null)
        from jsonb_array_elements(d->'activity') with ordinality x(e, i))
      and (select bool_and(k = any(array['id', 'kind', 'amount_minor', 'available_after_minor', 'created_at', 'creator_name',
          'sale_amount_minor', 'topup_kind', 'note'])) and count(*) = 45
        from jsonb_array_elements(d->'activity') e, jsonb_object_keys(e) k)
    from pg_temp.page('owner', 'acme') d)
  and pg_temp.page('analyst', 'acme') - 'can_manage' = pg_temp.page('owner', 'acme') - 'can_manage',
  'the page adds up what is reserved, pending, approved and kept as fees, and lists every movement newest first');
select pg_temp.check((select array_agg(k order by k) = array['account', 'activity', 'can_manage', 'enabled', 'fee_bps',
      'min_deposit_minor', 'pending_topup', 'program']
    from jsonb_object_keys(pg_temp.page('owner', 'acme')) k)
  and (select array_agg(k order by k) = array['auto_topup', 'available_minor', 'card', 'creators_approved_minor',
      'creators_pending_minor', 'currency', 'deposited_minor', 'fees_minor', 'min_balance_minor', 'reserved_minor',
      'topup_amount_minor', 'topup_limit', 'topup_problem'] from jsonb_object_keys(pg_temp.page('owner', 'acme')->'account') k)
  and (select array_agg(k order by k) = array['currency', 'id', 'name', 'pause_reason', 'status']
    from jsonb_object_keys(pg_temp.page('owner', 'acme')->'program') k),
  'the page has exactly the agreed fields');
-- A clawback after approval lowers what was approved for creators.
insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, commission_id)
values (pg_temp.q('creator_ada'), (pg_temp.program('acme')).id, 'USD', 'clawback', -940, pg_temp.q('commission_approved'));
select kma_internal.program_balance_post((pg_temp.account('acme')).id, 'commission_returned', 940, null, pg_temp.q('commission_approved'));
update public.program_commissions set amount_minor = 2000 where id = pg_temp.q('commission_approved');
select pg_temp.check(pg_temp.page('owner', 'acme')->'account' @> '{"available_minor":11089,"creators_approved_minor":2000,
    "reserved_minor":1617,"fees_minor":441}'
  and pg_temp.page('owner', 'acme')->'activity'->0 @> '{"kind":"commission_returned","amount_minor":940,"available_after_minor":11089,
    "creator_name":"Ada Okafor","sale_amount_minor":9800}',
  'money returned after a refund shows as approved less, and available more');

-- Automatic top-up: who is due ----------------------------------------------------------------------
-- SpeakSix has 110.89 and asked to be kept at 200.00: it is due. Each reason not to charge is tried.
create function pg_temp.due() returns boolean language plpgsql as $$
declare result jsonb;
begin
  result := pg_temp.svc('claim_program_auto_topups', '{"platform_account_id":"acct_Platform","limit":10,"lease_seconds":300}');
  -- Only looking: whatever was claimed is closed again without counting as a failure.
  update public.program_topups set status = 'canceled', failure_code = 'test_only', settled_at = now(),
    lease_token = null, lease_until = null where kind = 'auto' and status = 'pending';
  return jsonb_array_length(result->'topups') = 1 and result->'topups'->0->>'account_id' = (pg_temp.account('acme')).id::text;
end $$;
select pg_temp.check(pg_temp.due(), 'an account below its minimum with a card and automatic top-up on is due');
select pg_temp.money(false);
select pg_temp.check(not pg_temp.due(), 'nothing is due while program money is off');
select pg_temp.money(true);
select pg_temp.call('owner', pg_temp.settings_sql('acme', '{"auto_topup":false}'));
select pg_temp.check(not pg_temp.due(), 'nothing is due when the merchant switched automatic top-up off');
select pg_temp.call('owner', pg_temp.settings_sql('acme', '{"auto_topup":true,"min_balance_minor":11089}'));
select pg_temp.check(not pg_temp.due(), 'nothing is due when the balance is exactly the minimum');
select pg_temp.call('owner', pg_temp.settings_sql('acme', '{"min_balance_minor":20000}'));
select pg_temp.check(pg_temp.svc('claim_program_auto_topups', '{"platform_account_id":"acct_Other"}') = '{"topups":[]}'
  and pg_temp.svc_try('claim_program_auto_topups', '{"platform_account_id":"acct_Platform","limit":0}') = '22023 invalid_input'
  and pg_temp.svc_try('claim_program_auto_topups', '{"platform_account_id":"acct_Platform","limit":26}') = '22023 invalid_input'
  and pg_temp.svc_try('claim_program_auto_topups', '{"platform_account_id":"acct_Platform","lease_seconds":59}') = '22023 invalid_input'
  and pg_temp.svc_try('claim_program_auto_topups', '{"platform_account_id":"acct_Platform","limit":999999999999999}') = '22023 invalid_input'
  and pg_temp.svc_try('claim_program_auto_topups', '{"limit":5}') = '22023 invalid_input'
  and pg_temp.svc_try('claim_program_topup_checks', '{"platform_account_id":"acct_Platform","lease_seconds":901}') = '22023 invalid_input',
  'another platform account claims nothing, and a malformed claim is refused');
select pg_temp.set_status('owner', 'acme', 'paused');
select pg_temp.check(not pg_temp.due(), 'nothing is due while the merchant has paused the program');
select pg_temp.set_status('owner', 'acme', 'live');
update public.program_balance_accounts set payment_method_id = null, card_brand = null, card_last4 = null,
  card_exp_month = null, card_exp_year = null where id = (pg_temp.account('acme')).id;
select pg_temp.check(not pg_temp.due(), 'nothing is due without a saved card');
update public.program_balance_accounts set payment_method_id = 'pm_AcmeVisa', card_brand = 'visa', card_last4 = '4242',
  card_exp_month = 4, card_exp_year = 2029 where id = (pg_temp.account('acme')).id;
select pg_temp.deposit('t_blocking', 'acme', 'owner', 2000);
select pg_temp.check(not pg_temp.due(), 'nothing is due while a deposit of the account is still open');
select pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_blocking'), 'outcome', 'canceled',
  'failure_code', 'checkout_expired'));
select pg_temp.check((pg_temp.topup('t_blocking')).status = 'canceled' and (pg_temp.topup('t_blocking')).failure_code = 'checkout_expired'
  and (pg_temp.account('acme')).topup_failures = 0 and pg_temp.due(),
  'an expired deposit is canceled without counting as a failure, and the account is due again');

-- Automatic top-up: at most five charges of a card in any 24 hours ----------------------------------
insert into public.program_topups(account_id, kind, amount_minor, currency, status, created_at, updated_at, settled_at)
select (pg_temp.account('acme')).id, 'auto', 10000, 'USD', case when n = 2 then 'reversed' else 'succeeded' end,
  now() - make_interval(hours => n * 4), now(), now() - make_interval(hours => n * 4)
from generate_series(1, 4) n;
select pg_temp.check(pg_temp.due() and pg_temp.page('owner', 'acme')->'account'->'topup_limit' = 'null'::jsonb,
  'four automatic charges in a day leave room for a fifth');
insert into public.program_topups(account_id, kind, amount_minor, currency, status, created_at, updated_at, settled_at)
values ((pg_temp.account('acme')).id, 'auto', 10000, 'USD', 'succeeded', now() - interval '23 hours', now(), now() - interval '23 hours');
select pg_temp.check(not pg_temp.due()
  and pg_temp.page('owner', 'acme')->'account'->'topup_limit'->>'per_day' = '5'
  and (pg_temp.page('owner', 'acme')->'account'->'topup_limit'->>'resumes_at')::timestamptz
    between now() + interval '59 minutes' and now() + interval '61 minutes',
  'after five automatic charges in a day nothing is due, and the page says when it starts again');
select pg_temp.capture('workspace_program_balance.topup_limited', pg_temp.page('owner', 'acme'));
select pg_temp.call('owner', pg_temp.settings_sql('acme', '{"auto_topup":false}'));
select pg_temp.check(pg_temp.page('owner', 'acme')->'account'->'topup_limit' = 'null'::jsonb,
  'the limit is not mentioned while automatic top-up is off');
select pg_temp.call('owner', pg_temp.settings_sql('acme', '{"auto_topup":true}'));
update public.program_topups set created_at = now() - interval '25 hours'
  where account_id = (pg_temp.account('acme')).id and kind = 'auto' and created_at < now() - interval '22 hours';
select pg_temp.check(pg_temp.due() and pg_temp.page('owner', 'acme')->'account'->'topup_limit' = 'null'::jsonb,
  'once the oldest of the five is a day old the account is due again');
-- Failed and canceled tries do not count toward the limit; only charges that went through do.
insert into public.program_topups(account_id, kind, amount_minor, currency, status, failure_code, created_at, updated_at, settled_at)
select (pg_temp.account('acme')).id, 'auto', 10000, 'USD', case when n % 2 = 0 then 'failed' else 'canceled' end, 'test_only',
  now() - make_interval(mins => n), now(), now() from generate_series(1, 6) n;
select pg_temp.check(pg_temp.due(), 'tries that charged nothing do not count toward the limit');
delete from public.program_topups where account_id = (pg_temp.account('acme')).id and kind = 'auto'
  and (status in ('succeeded', 'reversed') or failure_code = 'test_only')
  and checkout_session_id is null and payment_intent_id is null;

-- Automatic top-up: one charge per shortfall, and the retry schedule ----------------------------------
create temporary table claimed as select pg_temp.claim('t_auto1') as answer;
select pg_temp.check((select jsonb_array_length(answer->'topups') = 1 and answer->'topups'->0 @> jsonb_build_object(
      'topup_id', pg_temp.q('t_auto1'), 'kind', 'auto', 'status', 'pending', 'amount_minor', 10000, 'currency', 'USD',
      'stripe_customer_id', 'cus_Acme', 'payment_method_id', 'pm_AcmeVisa', 'platform_account_id', 'acct_Platform',
      'account_id', (pg_temp.account('acme')).id, 'workspace_id', pg_temp.q('acme'))
      and answer->'topups'->0->>'lease_token' = (pg_temp.topup('t_auto1')).lease_token::text from claimed)
  and (select t.lease_until between clock_timestamp() + interval '4 minutes' and clock_timestamp() + interval '6 minutes'
    from pg_temp.topup('t_auto1') t),
  'a claim makes one automatic top-up for the amount the merchant chose and leases it to the worker');
select pg_temp.check(pg_temp.claim('t_never') = '{"topups":[]}' and pg_temp.claim('t_never') = '{"topups":[]}'
  and pg_temp.n('public.program_topups where kind = ''auto'' and status in (''pending'', ''processing'')') = 1,
  'a second and a third claim find nothing: the open top-up is the only charge for this shortfall');
do $$
begin
  insert into public.program_topups(account_id, kind, amount_minor, currency)
  values ((pg_temp.account('acme')).id, 'auto', 10000, 'USD');
  raise exception 'a second open automatic top-up was accepted';
exception when unique_violation then null;
end $$;
select pg_temp.check(true, 'the table itself refuses a second open automatic top-up for an account');
-- The worker stores the PaymentIntent, then the charge fails.
select pg_temp.svc('attach_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_auto1'), 'payment_intent_id', 'pi_Auto1'));
create temporary table failed as select pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_auto1'),
  'outcome', 'failed', 'payment_intent_id', 'pi_Auto1', 'failure_code', 'card_declined')) as answer;
select pg_temp.check((select answer @> '{"status":"failed","changed":true,"available_minor":11089,"topup_failures":1,
      "failure_code":"card_declined"}' from failed)
  and (select a.topup_failures = 1 and a.topup_failure_code = 'card_declined'
      and a.topup_retry_at between clock_timestamp() + interval '1 day' - interval '1 minute' and clock_timestamp() + interval '1 day'
    from pg_temp.account('acme') a)
  and pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_auto1'), 'outcome', 'failed',
    'payment_intent_id', 'pi_Auto1', 'failure_code', 'card_declined')) @> '{"changed":false,"topup_failures":1}'
  and (pg_temp.account('acme')).topup_failures = 1 and pg_temp.entries('acme', array['deposit']) = 1
  and pg_temp.claim('t_never') = '{"topups":[]}',
  'a declined top-up adds nothing, counts once however often it is reported, and is not tried again for a day');
select pg_temp.capture('workspace_program_balance.topup_failed', pg_temp.page('owner', 'acme'));
select pg_temp.check((select d->'account'->'topup_problem' = jsonb_build_object('code', 'card_declined',
      'failed_at', to_jsonb((pg_temp.topup('t_auto1')).settled_at), 'retry_at', to_jsonb((pg_temp.account('acme')).topup_retry_at))
      and d->'pending_topup' is not distinct from 'null'::jsonb
    from pg_temp.page('owner', 'acme') d),
  'the page says what went wrong, when, and when the next try is');
-- The second, third and fourth failures: 3 days, 7 days, then no more tries.
create function pg_temp.fail_again(k text, intent text, code text) returns jsonb language plpgsql as $$
begin
  update public.program_balance_accounts set topup_retry_at = clock_timestamp() - interval '1 second'
    where id = (pg_temp.account('acme')).id;
  perform pg_temp.claim(k);
  return pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q(k), 'outcome', 'failed',
    'payment_intent_id', intent, 'failure_code', code));
end $$;
select pg_temp.check(pg_temp.fail_again('t_auto2', 'pi_Auto2', 'insufficient_funds') @> '{"status":"failed","topup_failures":2}'
  and (select a.topup_failure_code = 'insufficient_funds'
      and a.topup_retry_at between clock_timestamp() + interval '3 days' - interval '1 minute' and clock_timestamp() + interval '3 days'
    from pg_temp.account('acme') a),
  'after the second failure the next try is three days later');
select pg_temp.check(pg_temp.fail_again('t_auto3', 'pi_Auto3', 'authentication_required') @> '{"status":"failed","topup_failures":3}'
  and (select a.topup_retry_at between clock_timestamp() + interval '7 days' - interval '1 minute' and clock_timestamp() + interval '7 days'
    from pg_temp.account('acme') a),
  'after the third failure the next try is seven days later');
select pg_temp.check(pg_temp.fail_again('t_auto4', 'pi_Auto4', 'expired_card') @> '{"status":"failed","topup_failures":4}'
  and (select a.topup_retry_at is null and a.topup_failures = 4 and a.topup_failure_code = 'expired_card' from pg_temp.account('acme') a)
  and pg_temp.claim('t_never') = '{"topups":[]}'
  and pg_temp.page('owner', 'acme')->'account'->'topup_problem' @> '{"code":"expired_card","retry_at":null}'
  and pg_temp.n('public.program_topups where kind = ''auto'' and status = ''failed''') = 4,
  'after the fourth failure automatic top-up stops until the merchant acts');
select pg_temp.capture('workspace_program_balance.topup_stopped', pg_temp.page('owner', 'acme'));

-- The merchant acts: a new card ------------------------------------------------------------------------
select pg_temp.check(
  pg_temp.svc_try('save_program_balance_card', jsonb_build_object('account_id', (pg_temp.account('acme')).id, 'customer_id', 'cus_Other',
    'card', '{"payment_method_id":"pm_AcmeNew","brand":"mastercard","last4":"4444","exp_month":9,"exp_year":2031}'::jsonb)) = '22023 card_mismatch'
  and pg_temp.svc_try('save_program_balance_card', jsonb_build_object('account_id', (pg_temp.account('acme')).id, 'customer_id', 'cus_Acme',
    'card', '{"payment_method_id":"pm_AcmeNew","brand":"MasterCard","last4":"4444","exp_month":9,"exp_year":2031}'::jsonb)) = '22023 invalid_input'
  and pg_temp.svc_try('save_program_balance_card', jsonb_build_object('account_id', (pg_temp.account('acme')).id, 'customer_id', 'cus_Acme',
    'card', '{"payment_method_id":"pm_AcmeNew","brand":"mastercard","last4":"4444","exp_month":9}'::jsonb)) = '22023 invalid_input'
  and pg_temp.svc_try('save_program_balance_card', jsonb_build_object('account_id', (pg_temp.account('acme')).id, 'customer_id', 'cus_Acme',
    'card', '{"payment_method_id":"card_Old","brand":"mastercard","last4":"4444","exp_month":9,"exp_year":2031}'::jsonb)) = '22023 invalid_input'
  and pg_temp.svc_try('save_program_balance_card', jsonb_build_object('account_id', gen_random_uuid(), 'customer_id', 'cus_Acme',
    'card', '{"payment_method_id":"pm_AcmeNew","brand":"mastercard","last4":"4444","exp_month":9,"exp_year":2031}'::jsonb)) = 'P0002 account_not_found'
  and (pg_temp.account('acme')).payment_method_id = 'pm_AcmeVisa' and (pg_temp.account('acme')).topup_failures = 4,
  'a card of another Stripe customer, or one that is not a card, is not saved');
select pg_temp.check(
  pg_temp.svc('save_program_balance_card', jsonb_build_object('account_id', (pg_temp.account('acme')).id, 'customer_id', 'cus_Acme',
    'card', '{"payment_method_id":"pm_AcmeNew","brand":"mastercard","last4":"4444","exp_month":9,"exp_year":2031}'::jsonb))
    = jsonb_build_object('account_id', (pg_temp.account('acme')).id, 'changed', true, 'replaced_payment_method_id', 'pm_AcmeVisa')
  and pg_temp.svc('save_program_balance_card', jsonb_build_object('account_id', (pg_temp.account('acme')).id, 'customer_id', 'cus_Acme',
    'card', '{"payment_method_id":"pm_AcmeNew","brand":"mastercard","last4":"4444","exp_month":9,"exp_year":2031}'::jsonb))
    @> '{"changed":false,"replaced_payment_method_id":null}'
  and (select a.payment_method_id = 'pm_AcmeNew' and a.card_brand = 'mastercard' and a.card_last4 = '4444' and a.card_exp_month = 9
      and a.card_exp_year = 2031 and a.topup_failures = 0 and a.topup_retry_at is null and a.topup_failure_code is null
    from pg_temp.account('acme') a)
  and pg_temp.page('owner', 'acme')->'account' @> '{"topup_problem":null,"card":{"brand":"mastercard","last4":"4444","exp_month":9,"exp_year":2031}}',
  'a new card replaces the old one and clears the failure; saving it again changes nothing');
select pg_temp.check((select count(*) = 1 and bool_and(a.before_data->>'card_last4' = '4242' and a.after_data->>'card_last4' = '4444'
      and a.after_data::text not like '%pm_%') from public.audit_logs a
    where a.action = 'program_balance_card_saved' and a.before_data is not null and a.target_id = (pg_temp.account('acme')).id),
  'the change of card is noted once, without the card''s Stripe id');

-- The next run charges the new card, and the payment lands.
select pg_temp.claim('t_auto5');
select pg_temp.check((pg_temp.topup('t_auto5')).status = 'pending'
  and pg_temp.svc('find_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_auto5'))) @> '{"found":true,"payment_method_id":"pm_AcmeNew"}',
  'after the new card the account is claimed again');
-- The webhook settles it from the PaymentIntent alone: the worker never stored the id.
select pg_temp.check(pg_temp.svc('settle_program_topup', pg_temp.paid('t_auto5', 'pi_Auto5', 'cus_Acme', 'pm_AcmeNew',
    '{"card":{"payment_method_id":"pm_AcmeNew","brand":"mastercard","last4":"4444","exp_month":10,"exp_year":2031}}'))
    @> '{"status":"succeeded","changed":true,"available_minor":21089,"replaced_payment_method_id":null,"payment_intent_id":"pi_Auto5"}'
  and (pg_temp.account('acme')).card_exp_month = 10
  and pg_temp.page('owner', 'acme')->'activity'->0 @> '{"kind":"deposit","amount_minor":10000,"available_after_minor":21089,"topup_kind":"auto"}'
  and pg_temp.page('owner', 'acme')->'account'->>'deposited_minor' = '25000'
  and pg_temp.claim('t_never') = '{"topups":[]}',
  'a succeeded automatic top-up lands once, shows as an automatic top-up, and the account is no longer due');

-- A failure is cleared by a deposit too.
select pg_temp.call('owner', pg_temp.settings_sql('acme', '{"min_balance_minor":30000}'));
select pg_temp.claim('t_auto6');
select pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_auto6'), 'outcome', 'failed',
  'failure_code', 'card_declined'));
select pg_temp.deposit('t_rescue', 'acme', 'owner', 1000);
select pg_temp.check((pg_temp.account('acme')).topup_failures = 1
  and pg_temp.svc('settle_program_topup', pg_temp.paid('t_rescue', 'pi_Rescue', 'cus_Acme', 'pm_AcmeNew'))
    @> '{"status":"succeeded","available_minor":22089,"topup_failures":0}'
  and (select a.topup_failures = 0 and a.topup_retry_at is null and a.topup_failure_code is null from pg_temp.account('acme') a)
  and pg_temp.page('owner', 'acme')->'account'->'topup_problem' is not distinct from 'null'::jsonb,
  'a deposit that lands clears the failure state');

-- A payment that arrives after its top-up was closed is still credited, once -------------------------
select pg_temp.claim('t_auto7');
select pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_auto7'), 'outcome', 'canceled',
  'failure_code', 'never_charged'));
select pg_temp.check((pg_temp.topup('t_auto7')).status = 'canceled' and (pg_temp.account('acme')).topup_failures = 0
  and pg_temp.svc('settle_program_topup', pg_temp.paid('t_auto7', 'pi_Auto7', 'cus_Acme', 'pm_AcmeNew'))
    @> '{"status":"succeeded","changed":true,"available_minor":32089}'
  and pg_temp.svc('settle_program_topup', pg_temp.paid('t_auto7', 'pi_Auto7', 'cus_Acme', 'pm_AcmeNew')) @> '{"changed":false,"available_minor":32089}'
  and (pg_temp.topup('t_auto7')).failure_code is null,
  'a top-up closed as never charged is credited when Stripe turns out to have taken the payment');
select pg_temp.check(pg_temp.svc('settle_program_topup', pg_temp.paid('t_auto6', 'pi_Auto6', 'cus_Acme', 'pm_AcmeNew'))
    @> '{"status":"succeeded","changed":true,"available_minor":42089}'
  and pg_temp.entries('acme', array['deposit']) = 5,
  'a top-up closed as failed is credited when its payment succeeded after all');

-- A card chosen while an automatic top-up is under way --------------------------------------------------
select pg_temp.call('owner', pg_temp.settings_sql('acme', '{"min_balance_minor":90000}'));
select pg_temp.claim('t_auto8');
select pg_temp.check(
  pg_temp.svc('save_program_balance_card', jsonb_build_object('account_id', (pg_temp.account('acme')).id, 'customer_id', 'cus_Acme',
    'card', '{"payment_method_id":"pm_AcmeThird","brand":"amex","last4":"0005","exp_month":1,"exp_year":2030}'::jsonb))
    @> '{"changed":true,"replaced_payment_method_id":null}'
  and (pg_temp.account('acme')).payment_method_id = 'pm_AcmeThird',
  'while an automatic top-up is under way a new card is saved, and the card being charged is not handed back for removal');
select pg_temp.check(pg_temp.svc('settle_program_topup', pg_temp.paid('t_auto8', 'pi_Auto8', 'cus_Acme', 'pm_AcmeNew'))
    @> '{"status":"succeeded","changed":true,"available_minor":52089,"replaced_payment_method_id":null}'
  and (select a.payment_method_id = 'pm_AcmeThird' and a.card_brand = 'amex' and a.card_last4 = '0005' from pg_temp.account('acme') a),
  'an automatic top-up that charged the earlier card does not bring that card back');
select pg_temp.deposit('t_card_back', 'acme', 'owner', 1000);
select pg_temp.check(pg_temp.svc('settle_program_topup', pg_temp.paid('t_card_back', 'pi_CardBack', 'cus_Acme', 'pm_AcmeNew'))
    @> '{"status":"succeeded","changed":true,"available_minor":53089,"replaced_payment_method_id":"pm_AcmeThird"}'
  and (select a.payment_method_id = 'pm_AcmeNew' and a.card_last4 = '4242' from pg_temp.account('acme') a),
  'the card a deposit was paid with becomes the saved card, and the one it replaces is handed back for removal');
select pg_temp.call('owner', pg_temp.settings_sql('acme', '{"min_balance_minor":30000}'));

-- Reversal: a refunded or disputed card payment --------------------------------------------------------
-- Rival Reader pays in 50.00.
select pg_temp.svc('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('rival'), 'user_id', pg_temp.q('rival_owner'),
  'platform_account_id', 'acct_Platform'));
select pg_temp.svc('attach_program_balance_customer', jsonb_build_object('account_id', (pg_temp.account('rival')).id,
  'stripe_customer_id', 'cus_Rival', 'platform_account_id', 'acct_Platform'));
select pg_temp.deposit('t_rival1', 'rival', 'rival_owner', 5000);
select pg_temp.check(
  pg_temp.svc('reverse_program_topup', '{"payment_intent_id":"pi_Rival1","reason":"refunded","refunded_minor":5000}') = '{"found":false}'
  and pg_temp.svc_try('reverse_program_topup', '{"payment_intent_id":"pi_Rival1","reason":"refunded"}') = '22023 invalid_input'
  and pg_temp.svc_try('reverse_program_topup', '{"payment_intent_id":"pi_Rival1","reason":"chargeback"}') = '22023 invalid_input'
  and pg_temp.svc_try('reverse_program_topup', '{"payment_intent_id":"ch_Rival1","reason":"dispute_lost"}') = '22023 invalid_input',
  'a refund of a payment that is no top-up changes nothing');
select pg_temp.svc('attach_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_rival1'), 'payment_intent_id', 'pi_Rival1'));
select pg_temp.check(pg_temp.svc('reverse_program_topup', '{"payment_intent_id":"pi_Rival1","reason":"refunded","refunded_minor":5000}')
    @> '{"found":true,"changed":false,"status":"processing","available_minor":0}'
  and pg_temp.entries('rival') = 0,
  'a top-up that never added money has nothing to take back');
select pg_temp.svc('settle_program_topup', pg_temp.paid('t_rival1', 'pi_Rival1', 'cus_Rival', 'pm_RivalVisa'));
select pg_temp.check(
  pg_temp.svc('reverse_program_topup', '{"payment_intent_id":"pi_Rival1","reason":"refunded","refunded_minor":2000}')
    @> '{"found":true,"changed":true,"status":"succeeded","reversed_minor":2000,"available_minor":3000,"program_paused":false}'
  and pg_temp.svc('reverse_program_topup', '{"payment_intent_id":"pi_Rival1","reason":"refunded","refunded_minor":2000}')
    @> '{"changed":false,"reversed_minor":2000,"available_minor":3000}'
  and pg_temp.svc('reverse_program_topup', '{"payment_intent_id":"pi_Rival1","reason":"refunded","refunded_minor":1500}')
    @> '{"changed":false,"reversed_minor":2000,"available_minor":3000}'
  and pg_temp.svc('reverse_program_topup', '{"payment_intent_id":"pi_Rival1","reason":"refunded","refunded_minor":3500}')
    @> '{"changed":true,"status":"succeeded","reversed_minor":3500,"available_minor":1500}'
  and pg_temp.entries('rival', array['deposit_reversed']) = 2
  and pg_temp.page('rival_owner', 'rival')->'account' @> '{"available_minor":1500,"deposited_minor":1500}'
  and pg_temp.page('rival_owner', 'rival')->'activity'->0 @> '{"kind":"deposit_reversed","amount_minor":-1500,
    "available_after_minor":1500,"topup_kind":"deposit","note":"Card payment refunded"}'
  and (pg_temp.program('rival')).status = 'live',
  'a partial refund takes back what was refunded, and each further refund only what is new');
select pg_temp.check(
  pg_temp.svc('reverse_program_topup', '{"payment_intent_id":"pi_Rival1","reason":"dispute_lost"}')
    @> '{"changed":true,"status":"reversed","reversed_minor":5000,"available_minor":0,"program_paused":true}'
  and pg_temp.svc('reverse_program_topup', '{"payment_intent_id":"pi_Rival1","reason":"dispute_lost"}')
    @> '{"changed":false,"status":"reversed","available_minor":0,"program_paused":false}'
  and pg_temp.svc('reverse_program_topup', '{"payment_intent_id":"pi_Rival1","reason":"refunded","refunded_minor":5000}')
    @> '{"changed":false,"reversed_minor":5000}'
  and (select p.status = 'paused' and p.pause_reason = 'balance_empty' from pg_temp.program('rival') p)
  and pg_temp.audits('affiliate_program_balance_paused', (pg_temp.program('rival')).id) = 1
  and pg_temp.page('rival_owner', 'rival') @> '{"program":{"status":"paused","pause_reason":"balance_empty"},
    "account":{"available_minor":0,"deposited_minor":0}}'
  and pg_temp.page('rival_owner', 'rival')->'activity'->0->>'note' = 'Card payment dispute lost'
  and pg_temp.svc('settle_program_topup', pg_temp.paid('t_rival1', 'pi_Rival1', 'cus_Rival', 'pm_RivalVisa')) @> '{"status":"reversed","changed":false}',
  'a lost dispute takes back the rest, and the program pauses when its balance is empty');
select pg_temp.capture('workspace_program_balance.paused_for_balance', pg_temp.page('rival_owner', 'rival'));

-- Resume on deposit -------------------------------------------------------------------------------------
select pg_temp.deposit('t_rival2', 'rival', 'rival_owner', 1000);
create temporary table resumed as select (pg_temp.program('rival')).revision as revision_before, null::jsonb as answer;
update resumed set answer = pg_temp.svc('settle_program_topup', pg_temp.paid('t_rival2', 'pi_Rival2', 'cus_Rival', 'pm_RivalVisa'));
select pg_temp.check((select answer @> '{"status":"succeeded","changed":true,"available_minor":1000,"program_resumed":true}' from resumed)
  and (select p.status = 'live' and p.pause_reason is null and p.revision = r.revision_before + 1 from pg_temp.program('rival') p, resumed r)
  and pg_temp.audits('affiliate_program_balance_resumed', (pg_temp.program('rival')).id) = 1
  and pg_temp.svc('settle_program_topup', pg_temp.paid('t_rival2', 'pi_Rival2', 'cus_Rival', 'pm_RivalVisa')) @> '{"changed":false,"program_resumed":false}',
  'a deposit makes a program that was paused for its balance live again');

-- The balance goes below zero only when a card payment is taken back.
select kma_internal.program_balance_post((pg_temp.account('rival')).id, 'adjustment', -800, null, null, 'fixture: money already set aside');
select pg_temp.check(
  pg_temp.svc('reverse_program_topup', '{"payment_intent_id":"pi_Rival2","reason":"refunded","refunded_minor":1000}')
    @> '{"changed":true,"status":"reversed","available_minor":-800,"program_paused":true}'
  and (pg_temp.account('rival')).available_minor = -800
  and (select p.status = 'paused' and p.pause_reason = 'balance_empty' from pg_temp.program('rival') p)
  and pg_temp.page('rival_owner', 'rival')->'account' @> '{"available_minor":-800,"deposited_minor":0}',
  'taking back a deposit that was partly used leaves the balance below zero and pauses the program');
do $$
begin
  perform kma_internal.program_balance_post((pg_temp.account('rival')).id, 'commission_reserved', -1, null, null);
  raise exception 'a reserve was taken from an empty balance';
exception when sqlstate 'P0001' then null;
end $$;
select pg_temp.check(true, 'nothing can be set aside from a balance that is below zero');

-- A deposit that does not bring the balance above zero does not resume the program.
select pg_temp.deposit('t_rival3', 'rival', 'rival_owner', 1000);
update public.program_topups set amount_minor = 800 where id = pg_temp.q('t_rival3');
select pg_temp.check(pg_temp.svc('settle_program_topup', pg_temp.paid('t_rival3', 'pi_Rival3', 'cus_Rival', 'pm_RivalVisa'))
    @> '{"changed":true,"available_minor":0,"program_resumed":false}'
  and (pg_temp.program('rival')).status = 'paused',
  'a deposit that only brings the balance back to zero does not resume the program');
-- With Stripe disconnected the program cannot go live: it stays paused, for that reason now.
update public.merchant_connections set status = 'revoked', revoked_at = now() where account_id = 'acct_Rival';
select pg_temp.deposit('t_rival4', 'rival', 'rival_owner', 1000);
select pg_temp.check(pg_temp.svc('settle_program_topup', pg_temp.paid('t_rival4', 'pi_Rival4', 'cus_Rival', 'pm_RivalVisa'))
    @> '{"changed":true,"available_minor":1000,"program_resumed":false}'
  and (select p.status = 'paused' and p.pause_reason = 'stripe_disconnected' from pg_temp.program('rival') p)
  and pg_temp.audits('affiliate_program_balance_resumed', (pg_temp.program('rival')).id) = 1,
  'a deposit does not make a program live while its Stripe account is disconnected');
update public.merchant_connections set status = 'active', revoked_at = null where account_id = 'acct_Rival';
-- A pause the merchant chose is not lifted by a deposit.
select pg_temp.set_status('owner', 'acme', 'paused');
select pg_temp.deposit('t_paused', 'acme', 'owner', 1000);
select pg_temp.check(pg_temp.svc('settle_program_topup', pg_temp.paid('t_paused', 'pi_Paused', 'cus_Acme', 'pm_AcmeNew'))
    @> '{"changed":true,"program_resumed":false}'
  and (select p.status = 'paused' and p.pause_reason = 'merchant' from pg_temp.program('acme') p),
  'a deposit does not lift a pause the merchant chose');
select pg_temp.set_status('owner', 'acme', 'live');
-- While program money is off nothing is paused for its balance.
select pg_temp.set_status('rival_owner', 'rival', 'live');
select pg_temp.money(false);
select pg_temp.check(pg_temp.svc('reverse_program_topup', '{"payment_intent_id":"pi_Rival4","reason":"dispute_lost"}')
    @> '{"changed":true,"available_minor":0,"program_paused":false}'
  and (pg_temp.program('rival')).status = 'live',
  'while program money is off a reversal still moves the balance but pauses nothing');
select pg_temp.money(true);
-- A program paused for its balance is still topped up automatically: that is how it comes back.
update public.affiliate_programs set status = 'paused', pause_reason = 'balance_empty' where id = (pg_temp.program('rival')).id;
select pg_temp.check(pg_temp.claim('t_rival_auto')->'topups'->0 @> jsonb_build_object('account_id', (pg_temp.account('rival')).id,
    'kind', 'auto', 'amount_minor', 10000, 'payment_method_id', 'pm_RivalVisa')
  and pg_temp.svc('settle_program_topup', pg_temp.paid('t_rival_auto', 'pi_RivalAuto', 'cus_Rival', 'pm_RivalVisa'))
    @> '{"changed":true,"available_minor":10000,"program_resumed":true}'
  and (pg_temp.program('rival')).status = 'live',
  'a program paused for its balance is topped up automatically and comes back when the payment lands');

-- Open top-ups the worker checks against Stripe -----------------------------------------------------------
select pg_temp.deposit('t_check', 'acme', 'owner', 3000);
select pg_temp.check((select count(*) = 2 and bool_and(t.status = 'pending' and t.kind = 'deposit'
      and t.lease_until > clock_timestamp() + interval '9 minutes')
    from public.program_topups t where t.status in ('pending', 'processing'))
  and pg_temp.svc('claim_program_topup_checks', '{"platform_account_id":"acct_Platform"}') = '{"topups":[]}',
  'a deposit is not checked before its first ten minutes have passed');
update public.program_topups set lease_until = clock_timestamp() - interval '1 second' where id in (pg_temp.q('t_check'), pg_temp.q('t_draft'));
create temporary table checks as select pg_temp.svc('claim_program_topup_checks',
  '{"platform_account_id":"acct_Platform","limit":10,"lease_seconds":120}') as answer;
select pg_temp.check((select jsonb_array_length(answer->'topups') = 2
      and answer->'topups' @> jsonb_build_array(jsonb_build_object('topup_id', pg_temp.q('t_check'), 'kind', 'deposit', 'status', 'pending',
        'checks', 1, 'stripe_customer_id', 'cus_Acme', 'checkout_session_id', null, 'payment_intent_id', null,
        'lease_token', (pg_temp.topup('t_check')).lease_token))
      and answer->'topups' @> jsonb_build_array(jsonb_build_object('topup_id', pg_temp.q('t_draft'), 'checks', 1)) from checks)
  and (select t.lease_until between clock_timestamp() + interval '1 minute' and clock_timestamp() + interval '3 minutes'
    from pg_temp.topup('t_check') t)
  and pg_temp.svc('claim_program_topup_checks', '{"platform_account_id":"acct_Platform"}') = '{"topups":[]}'
  and pg_temp.svc('claim_program_topup_checks', '{"platform_account_id":"acct_Other"}') = '{"topups":[]}',
  'open top-ups past their time are handed out once, each with a lease');
select pg_temp.check(
  pg_temp.svc('release_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_check'), 'lease_token', gen_random_uuid(),
    'delay_seconds', 600)) = '{"released":false}'
  and pg_temp.svc_try('release_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_check'),
    'lease_token', (pg_temp.topup('t_check')).lease_token, 'delay_seconds', 29)) = '22023 invalid_input'
  and pg_temp.svc('release_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_check'),
    'lease_token', (pg_temp.topup('t_check')).lease_token, 'delay_seconds', 600)) = '{"released":true}'
  and (select t.lease_token is null and t.status = 'pending'
      and t.lease_until between clock_timestamp() + interval '9 minutes' and clock_timestamp() + interval '11 minutes'
    from pg_temp.topup('t_check') t)
  and pg_temp.svc('claim_program_topup_checks', '{"platform_account_id":"acct_Platform"}') = '{"topups":[]}',
  'only the holder of the lease hands a top-up back, to be looked at again later');
select pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_check'), 'outcome', 'canceled',
  'failure_code', 'checkout_expired'));
select pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_draft'), 'outcome', 'canceled',
  'failure_code', 'never_started'));
select pg_temp.check(pg_temp.svc('release_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_draft'),
    'lease_token', gen_random_uuid(), 'delay_seconds', 600)) = '{"released":false}'
  and (pg_temp.topup('t_draft')).lease_until is null and (pg_temp.topup('t_draft')).status = 'canceled',
  'a closed top-up holds no lease');

-- Webhook receipts -------------------------------------------------------------------------------------------
select pg_temp.check(
  pg_temp.svc('record_program_balance_event', jsonb_build_object('event_id', 'evt_Balance1', 'event_type', 'payment_intent.succeeded',
    'object_id', 'pi_Main', 'payload_sha256', repeat('a', 64), 'event_created', 1794571200))
    = '{"duplicate":false,"processed":false,"outcome":null}'
  and pg_temp.svc('record_program_balance_event', jsonb_build_object('event_id', 'evt_Balance1', 'event_type', 'payment_intent.succeeded',
    'object_id', 'pi_Main', 'payload_sha256', repeat('a', 64), 'event_created', 1794571200))
    = '{"duplicate":true,"processed":false,"outcome":null}'
  and pg_temp.svc('finish_program_balance_event', jsonb_build_object('event_id', 'evt_Balance1', 'outcome', 'settled',
    'topup_id', pg_temp.q('t_main'))) = '{"found":true,"outcome":"settled"}'
  and pg_temp.svc('finish_program_balance_event', '{"event_id":"evt_Balance1","outcome":"ignored"}') = '{"found":true,"outcome":"settled"}'
  and pg_temp.svc('record_program_balance_event', jsonb_build_object('event_id', 'evt_Balance1', 'event_type', 'payment_intent.succeeded',
    'object_id', 'pi_Main', 'payload_sha256', repeat('a', 64), 'event_created', 1794571200))
    = '{"duplicate":true,"processed":true,"outcome":"settled"}'
  and pg_temp.svc_try('record_program_balance_event', jsonb_build_object('event_id', 'evt_Balance1', 'event_type', 'payment_intent.succeeded',
    'object_id', 'pi_Main', 'payload_sha256', repeat('b', 64), 'event_created', 1794571200)) = '23505'
  and pg_temp.svc_try('record_program_balance_event', jsonb_build_object('event_id', 'not an event', 'event_type', 'payment_intent.succeeded',
    'object_id', 'pi_Main', 'payload_sha256', repeat('a', 64), 'event_created', 1794571200)) = '22023 invalid_input'
  and pg_temp.svc_try('record_program_balance_event', jsonb_build_object('event_id', 'evt_Balance2', 'event_type', 'payment_intent.succeeded',
    'object_id', 'pi_Main', 'payload_sha256', repeat('a', 64))) = '22023 invalid_input'
  and pg_temp.svc('finish_program_balance_event', '{"event_id":"evt_Unknown","outcome":"ignored"}') = '{"found":false,"outcome":null}'
  and pg_temp.svc_try('finish_program_balance_event', '{"event_id":"evt_Balance1","outcome":"Not A Code"}') = '22023 invalid_input',
  'an event is noted once and says whether it was finished; the same id with another body is refused');
select pg_temp.check((select e.attempts = 3 and e.topup_id = pg_temp.q('t_main') and e.processed_at is not null
    from public.program_balance_events e where e.event_id = 'evt_Balance1')
  and pg_temp.n('public.program_balance_events') = 1,
  'the receipt counts its deliveries and keeps the first ending');

-- Schedule ------------------------------------------------------------------------------------------------------
select pg_temp.check(kma_internal.tick_program_balance_schedule() = '{"status":"paused"}'::jsonb,
  'the schedule is off until it is enabled');
select pg_temp.check((select last_tick_at is not null and last_dispatch_at is null and not enabled
  from kma_internal.program_balance_schedule), 'a tick of the switched-off schedule is noted and calls nobody');
update kma_internal.program_balance_schedule set enabled = true where singleton;
select pg_temp.money(false);
select pg_temp.check(kma_internal.tick_program_balance_schedule() = '{"status":"money_disabled"}'::jsonb,
  'the schedule calls nobody while program money is off');
select pg_temp.money(true);
select pg_temp.check(kma_internal.tick_program_balance_schedule() = '{"status":"credential_missing"}'::jsonb,
  'without its credential the schedule calls nobody');
insert into vault.decrypted_secrets(name, decrypted_secret) values ('kma_program_balance_scheduler', repeat('s', 40));
create function pg_temp.fails(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- The local fixture has no network: reaching net.http_post is the proof that the worker would be called.
select pg_temp.check(pg_temp.fails('select kma_internal.tick_program_balance_schedule()') like '%HTTP disabled in local isolated SQL fixture%',
  'with its credential the schedule calls the worker');
-- Nothing waiting and a call made a moment ago: no call.
update kma_internal.program_balance_schedule set last_dispatch_at = clock_timestamp() where singleton;
update public.program_commissions set hold_until = now() + interval '28 days', status = 'held', approved_at = null
  where id = pg_temp.q('commission_held');
select pg_temp.check((select count(*) = 0 from public.program_topups where status in ('pending', 'processing'))
  and pg_temp.claim('t_never') = '{"topups":[]}'
  and kma_internal.tick_program_balance_schedule() = '{"status":"idle"}'::jsonb,
  'with nothing to do and a recent call the schedule waits');
update kma_internal.program_balance_schedule set last_dispatch_at = clock_timestamp() - interval '6 minutes' where singleton;
select pg_temp.check(pg_temp.fails('select kma_internal.tick_program_balance_schedule()') like '%HTTP disabled%',
  'the schedule calls the worker at least every five minutes');
update kma_internal.program_balance_schedule set last_dispatch_at = clock_timestamp() where singleton;
select pg_temp.call('owner', pg_temp.settings_sql('acme', '{"min_balance_minor":90000}'));
select pg_temp.check(pg_temp.fails('select kma_internal.tick_program_balance_schedule()') like '%HTTP disabled%',
  'an account below its minimum makes the schedule call the worker at once');
select pg_temp.call('owner', pg_temp.settings_sql('acme', '{"min_balance_minor":5000}'));
update public.program_commissions set hold_until = now() - interval '1 minute' where id = pg_temp.q('commission_held');
select pg_temp.check(pg_temp.fails('select kma_internal.tick_program_balance_schedule()') like '%HTTP disabled%',
  'a commission whose hold has passed makes the schedule call the worker at once');
update public.program_commissions set hold_until = now() + interval '28 days' where id = pg_temp.q('commission_held');
select pg_temp.deposit('t_tick', 'acme', 'owner', 1000);
select pg_temp.check(kma_internal.tick_program_balance_schedule() = '{"status":"idle"}'::jsonb, 'a deposit that is still fresh is no reason to call');
update public.program_topups set lease_until = clock_timestamp() - interval '1 second' where id = pg_temp.q('t_tick');
select pg_temp.check(pg_temp.fails('select kma_internal.tick_program_balance_schedule()') like '%HTTP disabled%',
  'an open top-up that is due for a check makes the schedule call the worker');
select pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', pg_temp.q('t_tick'), 'outcome', 'canceled', 'failure_code', 'checkout_expired'));

-- Operator view -----------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
set local role service_role;
create temporary table health as select public.program_balance_health() as answer;
reset role;
select pg_temp.check((select answer @> '{"enabled":true,"ledger_mismatches":0,"schedule":{"enabled":true},
      "accounts":{"total":3,"with_card":2,"negative":0,"retrying":0,"stopped":0},
      "open_topups":{"due_for_check":0,"oldest_created_at":null},
      "events":{"unfinished":0,"outcomes_last_day":{"settled":1}}}'
      and (answer->'topups'->>'auto_failed')::int = 4 and (answer->'topups'->>'deposit_succeeded')::int >= 4
      and (answer->'failures'->>'superseded')::int = 1 and (answer->'failures'->>'checkout_expired')::int = 3
      and not answer->'schedule' ? 'last_request_id'
      and answer::text !~ '(cus_|pm_|pi_|cs_)' from health),
  'the operator view counts accounts, top-ups, failures and events, and names no Stripe object');

-- The ledger -------------------------------------------------------------------------------------------------------
select pg_temp.check((select bool_and(a.available_minor = coalesce((select sum(e.amount_minor) from public.program_balance_entries e
      where e.account_id = a.id), 0)) and count(*) = 3 from public.program_balance_accounts a)
  and (select bool_and(e.available_after_minor = e.running) from (
      select e.available_after_minor, sum(e.amount_minor) over (partition by e.account_id order by e.seq) as running
      from public.program_balance_entries e) e)
  and (select bool_and(e.kind = 'deposit_reversed') from public.program_balance_entries e where e.available_after_minor < 0)
  and (select count(*) = count(distinct e.topup_id) from public.program_balance_entries e where e.kind = 'deposit')
  and (select bool_and(t.status in ('succeeded', 'reversed')) from public.program_balance_entries e
    join public.program_topups t on t.id = e.topup_id)
  and (select bool_and((t.status = 'reversed') = (t.reversed_minor = t.amount_minor)
      and t.reversed_minor = coalesce((select -sum(e.amount_minor) from public.program_balance_entries e
        where e.topup_id = t.id and e.kind = 'deposit_reversed'), 0)
      and (t.status in ('succeeded', 'reversed')) = exists (select 1 from public.program_balance_entries e
        where e.topup_id = t.id and e.kind = 'deposit'))
    from public.program_topups t)
  and (select bool_and(a.available_minor >= 0) from public.program_balance_accounts a),
  'every balance equals the sum of its entries in order; each top-up was added at most once and taken back for no more than '
    || 'it was; only a reversed card payment ever left a balance below zero');
select pg_temp.check(pg_temp.fails('update public.program_balance_entries set amount_minor = 1') like '%'
  and pg_temp.fails('update public.program_balance_entries set amount_minor = 1') <> 'ok'
  and pg_temp.fails('delete from public.program_balance_entries') <> 'ok',
  'balance entries still cannot be changed or deleted');

select 'ok ' || count(*) || ' program balance assertions' from balance_assertions;
rollback;
