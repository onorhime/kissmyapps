-- Phase 4, part one, working with Phases 1 to 3 through the real functions only: KissMyApps
-- switches program money on; a merchant cannot publish before the balance has funds; the
-- first deposit is settled and the program goes live; a creator joins; a tagged payment
-- sets commission and fee aside from the balance; a refund inside the hold gives both back;
-- after the hold the commission is the creator's; a sale the balance cannot cover pauses
-- the program and stops the link crediting; the next deposit brings it back by itself.
-- Stripe is never called: each service function is given what its edge function passes
-- after reading Stripe.
begin;
set local time zone 'UTC';
create temporary table e2e_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program money end to end assertion failed: %', label; end if;
  insert into e2e_assertions values (label);
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
create function pg_temp.t(k text) returns text language sql as $$ select value from qa where key = k $$;
create function pg_temp.sign_in(who text) returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('sub', pg_temp.q(who), 'role', 'authenticated')
    || case when who like 'kma\_%' then '{"amr":[{"method":"password"}]}'::jsonb else '{}'::jsonb end)::text, true)
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
-- What the end of a writing transaction does: the deferred commission triggers run.
create function pg_temp.flush() returns void language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end $$;
create function pg_temp.epoch(p_at timestamptz) returns bigint language sql as $$ select extract(epoch from p_at)::bigint $$;
create function pg_temp.program() returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q('workspace')
$$;
create function pg_temp.account() returns public.program_balance_accounts language sql as $$
  select a from public.program_balance_accounts a where a.program_id = (pg_temp.program()).id
$$;
create function pg_temp.balance() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_balance(%L)', pg_temp.q('workspace')))
$$;
create function pg_temp.earnings() returns jsonb language sql as $$
  select pg_temp.call('creator', 'select public.partner_program_earnings()')
$$;
create function pg_temp.commission(k text) returns public.program_commissions language sql as $$
  select c from public.program_commissions c join public.program_sales s on s.id = c.sale_id
  where s.payment_intent_id = 'pi_' || k
$$;
-- A visitor opens the creator's link, as the tracking-redirect function asks for it.
create function pg_temp.click() returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select to_jsonb(r) into result from public.register_tracking_click('e2e-money-creator',
    split_part(pg_temp.t('link_url'), '/', 6), '{}'::jsonb) r;
  reset role;
  return result;
end $$;
-- The merchant pays into the balance: the four calls the program-balance function and the
-- webhook make around one Stripe Checkout payment.
create function pg_temp.deposit(k text, amount bigint) returns jsonb language plpgsql as $$
declare
  v_opened jsonb;
  v_begun jsonb;
begin
  v_opened := pg_temp.svc('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q('workspace'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_KMAPlatform'));
  perform pg_temp.svc('attach_program_balance_customer', jsonb_build_object('account_id', v_opened->>'account_id',
    'stripe_customer_id', 'cus_E2EMoney', 'platform_account_id', 'acct_KMAPlatform'));
  v_begun := pg_temp.svc('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('workspace'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_KMAPlatform', 'amount_minor', amount));
  perform pg_temp.svc('attach_program_topup', jsonb_build_object('topup_id', v_begun->>'topup_id',
    'checkout_session_id', 'cs_live_' || k));
  return pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', v_begun->>'topup_id', 'outcome', 'succeeded',
    'payment_intent_id', 'pi_dep' || k, 'livemode', true, 'amount_minor', amount, 'currency', 'usd',
    'customer_id', 'cus_E2EMoney', 'card', jsonb_build_object('payment_method_id', 'pm_E2EVisa', 'brand', 'visa',
      'last4', '4242', 'exp_month', 4, 'exp_year', 2029)));
end $$;
-- The reference a worker holds for a receipt; leases it first, the way a claim does.
create function pg_temp.ref(p_event text) returns jsonb language plpgsql as $$
declare v_lease uuid;
begin
  update public.merchant_payment_events
    set lease_until = clock_timestamp() + interval '2 minutes', lease_token = gen_random_uuid(),
      process_attempts = process_attempts + 1
    where event_id = p_event and processed_at is null and lease_token is null;
  select lease_token into v_lease from public.merchant_payment_events where event_id = p_event;
  return jsonb_build_object('platform_account_id', 'acct_KMAPlatform', 'event_id', p_event, 'lease_token', v_lease);
end $$;
create function pg_temp.receipt(p_event text, p_type text, p_object text, p_intent text, p_amount bigint, p_tag text default null)
returns jsonb language sql as $$
  select public.record_merchant_payment_event(jsonb_build_object(
    'platform_account_id', 'acct_KMAPlatform', 'livemode', true, 'account_id', 'acct_E2EMoney',
    'event_id', p_event, 'event_type', p_type, 'event_created', pg_temp.epoch(clock_timestamp()) + 2,
    'object_id', p_object, 'payment_intent_id', p_intent, 'amount_minor', p_amount, 'currency', 'usd',
    'kma_click', p_tag, 'tag_source', case when p_tag is not null then 'metadata' end, 'payload_sha256', repeat('a', 64)))
$$;
-- A buyer who came through the creator's link pays: the webhook's receipt, then the worker's sale.
create function pg_temp.pay(k text, amount bigint) returns jsonb language plpgsql as $$
declare
  v jsonb;
  v_tag text := pg_temp.click()->>'click_id';
begin
  perform pg_temp.receipt('evt_' || k, 'payment_intent.succeeded', 'pi_' || k, 'pi_' || k, amount, v_tag);
  v := public.record_program_sale(pg_temp.ref('evt_' || k) || jsonb_build_object(
    'livemode', true, 'payment_intent_id', 'pi_' || k, 'charge_id', 'ch_' || k, 'amount_minor', amount, 'currency', 'usd',
    'refunded_minor', 0, 'paid_at', pg_temp.epoch(clock_timestamp()), 'kma_click', v_tag, 'tag_source', 'metadata'));
  perform public.finish_program_sale_receipt(pg_temp.ref('evt_' || k) || '{"action":"done","code":"recorded"}');
  perform pg_temp.flush();
  return v;
end $$;
-- Stripe reports the whole payment refunded.
create function pg_temp.refund(k text, amount bigint) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.receipt('evt_' || k || '_refund', 'charge.refunded', 'ch_' || k, 'pi_' || k, amount);
  v := public.record_program_sale_event(pg_temp.ref('evt_' || k || '_refund') || jsonb_build_object(
    'payment_intent_id', 'pi_' || k, 'refunded_minor', amount));
  perform public.finish_program_sale_receipt(pg_temp.ref('evt_' || k || '_refund') || '{"action":"done","code":"recorded"}');
  perform pg_temp.flush();
  return v;
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
grant all on qa, e2e_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('eb000000-0000-4000-8000-000000000001', 'owner@fluent.example', now(), '{"company":"Fluent"}'),
  ('eb000000-0000-4000-8000-000000000011', 'founder@kissmyapps.dev', now(), '{}'),
  ('eb000000-0000-4000-8000-000000000021', 'creator@creators.example', now(), '{}');
insert into qa values ('owner', 'eb000000-0000-4000-8000-000000000001'),
  ('kma_owner', 'eb000000-0000-4000-8000-000000000011'), ('creator', 'eb000000-0000-4000-8000-000000000021');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner');
insert into public.affiliates(id, public_name, slug, status) values
  ('ec000000-0000-4000-8000-000000000001', 'Mira Maker', 'e2e-money-creator', 'active');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at) values
  ('ec000000-0000-4000-8000-000000000001', pg_temp.q('creator'), 'owner', true, false, now());
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true;
select pg_temp.sign_in('owner');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
with business as (
  insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
  values ('Fluent Ltd', 'billing@fluent.example', pg_temp.q('owner'), pg_temp.q('workspace')) returning id)
insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status, business_name,
  country, charges_enabled, details_submitted, confirmed_at, verified_at)
select id, 'acct_KMAPlatform', true, 'acct_E2EMoney', 'active', 'Fluent Ltd', 'GB', true, true, now(), now() from business;

-- KissMyApps switches program money on -----------------------------------------------------------
select pg_temp.check(
  (select m @> '{"enabled":true,"fee_bps":1000,"min_deposit_minor":5000}'
    from pg_temp.call('kma_owner', format('select public.configure_admin_program_money(%L)', jsonb_build_object('enabled', true,
      'expected_updated_at', pg_temp.call('kma_owner', 'select public.get_admin_program_money()')->'updated_at'))) m),
  'the KissMyApps owner switches program money on with a 10% fee and a 50.00 first deposit');

-- No funds, no publishing ------------------------------------------------------------------------
select pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
  '{"name":"Fluent","category":"education","tagline":"Speak a new language in a month.",
    "landing_url":"https://fluent-app.io/start","commission_type":"percent","commission_rate_bps":3000,
    "commission_duration":"months","commission_months":12,"hold_days":14}'::jsonb));
select pg_temp.call('owner', format('select public.workspace_program_mark_agreement_read(%L, %L)', pg_temp.q('workspace'),
  pg_temp.call('owner', format('select public.workspace_program_agreement(%L)', pg_temp.q('workspace')))->>'sha256'));
select pg_temp.check(
  pg_temp.try('owner', format('select public.workspace_program_submit(%L, %s)', pg_temp.q('workspace'), (pg_temp.program()).revision))
    = '22023 balance_required'
  and (pg_temp.program()).status = 'draft',
  'a program cannot be published before its balance has funds');

-- The first deposit ------------------------------------------------------------------------------
select pg_temp.check(
  (select d @> '{"status":"succeeded","amount_minor":10000}' from pg_temp.deposit('first', 10000) d)
  and (select b->'account' @> '{"currency":"USD","available_minor":10000,"reserved_minor":0,"deposited_minor":10000,
      "card":{"brand":"visa","last4":"4242","exp_month":4,"exp_year":2029},"auto_topup":true}'
      and b->'activity'->0 @> '{"kind":"deposit","amount_minor":10000,"available_after_minor":10000,"topup_kind":"deposit"}'
      and b->'pending_topup' = 'null'::jsonb
    from pg_temp.balance() b),
  'a paid deposit of 100.00 is the balance, with the card kept for automatic top-ups');
select pg_temp.call('owner', format('select public.workspace_program_submit(%L, %s)', pg_temp.q('workspace'), (pg_temp.program()).revision));
select pg_temp.call('kma_owner', format('select public.review_admin_program(%L)',
  jsonb_build_object('program_id', (pg_temp.program()).id, 'decision', 'approve', 'note', null)));
select pg_temp.check((pg_temp.program()).status = 'live', 'with funds in the balance the program is published and approved');

-- A creator joins and sends a buyer ----------------------------------------------------------------
insert into qa select 'shown', pg_temp.call('creator',
  format('select public.partner_program_detail(%L)', (pg_temp.program()).slug))::text;
insert into qa select 'link_url', pg_temp.call('creator', format('select public.partner_program_join(%L)',
  jsonb_build_object('slug', d->'program'->>'slug', 'terms_version', d->'program'->'terms_version',
    'agreement_sha256', d->'program'->>'agreement_sha256')))->'membership'->'link'->>'url'
from (select pg_temp.t('shown')::jsonb as d) x;
select pg_temp.check(pg_temp.t('link_url') like 'https://go.kissmyapps.dev/r/e2e-money-creator/%',
  'the creator accepts the agreement and has a link');
select pg_temp.check((select e->'programs' = '[]'::jsonb or (e->'programs'->0->>'pending_minor' = '0' and e->'programs'->0->>'sales' = '0')
    from pg_temp.earnings() e), 'before any sale the creator has earned nothing');

select pg_temp.check(pg_temp.pay('first', 4900) @> '{"recorded":true,"created":true}', 'a tagged payment of 49.00 becomes a sale');
select pg_temp.check(
  (select c.status = 'held' and c.affiliate_id = 'ec000000-0000-4000-8000-000000000001' and c.basis_minor = 4900
      and c.earned_minor = 1470 and c.amount_minor = 1470 and c.fee_earned_minor = 147 and c.fee_minor = 147
      and c.terms_version = (pg_temp.program()).live_terms_version
      and c.hold_until between now() + interval '13 days 23 hours' and now() + interval '14 days 1 hour'
    from pg_temp.commission('first') c),
  'the sale earns 30% for the creator and a 10% fee on top, held for the 14 days of the terms');
select pg_temp.check(
  (select b->'account' @> '{"available_minor":8383,"reserved_minor":1617,"creators_pending_minor":1470,
      "creators_approved_minor":0,"fees_minor":147,"deposited_minor":10000}'
      and b->'activity'->0 @> '{"kind":"fee_reserved","amount_minor":-147,"available_after_minor":8383,"creator_name":"Mira Maker","sale_amount_minor":4900}'
      and b->'activity'->1 @> '{"kind":"commission_reserved","amount_minor":-1470,"available_after_minor":8530,"creator_name":"Mira Maker"}'
    from pg_temp.balance() b),
  'commission and fee are set aside from the merchant''s balance the moment the sale is recorded');
select pg_temp.check(
  (select e->'programs'->0 @> '{"name":"Fluent","currency":"USD","pending_minor":1470,"approved_minor":0,"paid_minor":0,"sales":1}'
      and e->'programs'->0->>'next_release_at' is not null
      and e->'recent'->0 @> '{"status":"held","amount_minor":1470,"earned_minor":1470,"sale_amount_minor":4900,"program_name":"Fluent"}'
      and e::text not ilike '%fluent.example%'
    from pg_temp.earnings() e),
  'the creator sees 14.70 pending with the day it leaves the hold, and nothing about the buyer');

-- A refund inside the hold gives everything back -------------------------------------------------
select pg_temp.pay('second', 4900);
select pg_temp.check((select b->'account' @> '{"available_minor":6766,"reserved_minor":3234}' from pg_temp.balance() b),
  'a second sale sets aside another 16.17');
select pg_temp.refund('second', 4900);
select pg_temp.check(
  (select c.status = 'reversed' and c.amount_minor = 0 and c.fee_minor = 0 and c.earned_minor = 1470 from pg_temp.commission('second') c)
  and (select b->'account' @> '{"available_minor":8383,"reserved_minor":1617,"creators_pending_minor":1470,"fees_minor":147}'
      and (select count(*) = 2 from jsonb_array_elements(b->'activity') a where a->>'kind' in ('commission_returned', 'fee_returned'))
    from pg_temp.balance() b)
  and (select e->'programs'->0 @> '{"pending_minor":1470,"sales":1}'
      and exists (select 1 from jsonb_array_elements(e->'recent') r where r @> '{"status":"reversed","amount_minor":0,"earned_minor":1470}')
    from pg_temp.earnings() e),
  'a full refund inside the hold returns the commission and the fee to the balance, and the creator sees it was returned');

-- The hold passes ----------------------------------------------------------------------------------
select pg_temp.check(pg_temp.svc('program_commissions_tick', '{"limit":100}') @> '{"approved":0,"remaining":0}',
  'nothing is approved while the hold is running');
-- Fourteen days go by.
update public.program_commissions set hold_until = now() - interval '1 minute' where id = (pg_temp.commission('first')).id;
select pg_temp.check(pg_temp.svc('program_commissions_tick', '{"limit":100}') @> '{"approved":1,"remaining":0}'
  and pg_temp.svc('program_commissions_tick', '{"limit":100}') @> '{"approved":0}',
  'after the hold the tick approves the commission, once');
select pg_temp.check(
  (select c.status = 'approved' and c.amount_minor = 1470 and c.approved_at is not null from pg_temp.commission('first') c)
  and (select count(*) = 1 and sum(e.amount_minor) = 1470 from public.program_creator_entries e
    where e.affiliate_id = 'ec000000-0000-4000-8000-000000000001' and e.kind = 'commission_approved')
  and (select b->'account' @> '{"available_minor":8383,"reserved_minor":0,"creators_pending_minor":0,
      "creators_approved_minor":1470,"fees_minor":147}' from pg_temp.balance() b)
  and (select e->'programs'->0 @> '{"pending_minor":0,"approved_minor":1470,"sales":1}'
      and exists (select 1 from jsonb_array_elements(e->'recent') r where r @> '{"status":"approved","amount_minor":1470}')
    from pg_temp.earnings() e),
  'the approved commission is the creator''s: 14.70 approved, nothing pending, and the balance no longer holds it');
select pg_temp.check(
  (select m @> '{"enabled":true,"programs_with_balance":1}' and m->'available_minor_by_currency' = '{"USD":8383}'::jsonb
      and m->'reserved_minor_by_currency' in ('{}'::jsonb, '{"USD":0}'::jsonb)
      and m->'owed_to_creators_minor_by_currency' = '{"USD":1470}'::jsonb
    from pg_temp.call('kma_owner', 'select public.get_admin_program_money()') m),
  'KissMyApps sees what merchants hold and what is owed to creators, and they add up');

-- A sale the balance cannot cover ----------------------------------------------------------------
-- 30% of 300.00 is 90.00, plus a 9.00 fee: more than the 83.83 left.
select pg_temp.pay('large', 30000);
select pg_temp.check(
  (select c.status = 'not_earned' and c.reason = 'balance_empty' from pg_temp.commission('large') c)
  and (select p.status = 'paused' and p.pause_reason = 'balance_empty' from pg_temp.program() p)
  and (select b->'account' @> '{"available_minor":8383}' and b->'program' @> '{"status":"paused","pause_reason":"balance_empty"}'
    from pg_temp.balance() b),
  'a sale the balance cannot cover earns nothing, takes nothing, and pauses the program');
select pg_temp.check(
  (select c->'click_id' = 'null'::jsonb and c->>'destination_url' = 'https://fluent-app.io/start' from pg_temp.click() c)
  and (select not (m->'memberships'->0->'link'->>'working')::boolean
    from pg_temp.call('creator', 'select public.partner_marketplace()') m),
  'while the program is paused for its balance the link opens the page without crediting, and the creator is told');

-- The next deposit brings the program back ---------------------------------------------------------
select pg_temp.check(
  (select d @> '{"status":"succeeded","amount_minor":20000}' from pg_temp.deposit('again', 20000) d)
  and (select p.status = 'live' and p.pause_reason is null from pg_temp.program() p)
  and (select b->'account' @> '{"available_minor":28383,"deposited_minor":30000}' from pg_temp.balance() b)
  and (select c->>'click_id' is not null from pg_temp.click() c),
  'adding funds makes the program live again by itself, and the same link credits again');
select pg_temp.pay('after', 4900);
select pg_temp.check(
  (select c.status = 'held' and c.amount_minor = 1470 from pg_temp.commission('after') c)
  and (select b->'account' @> '{"available_minor":26766,"reserved_minor":1617}' from pg_temp.balance() b),
  'the next sale earns commission again');

-- Every cent is accounted for ----------------------------------------------------------------------
select pg_temp.check(
  (select a.available_minor = (select sum(e.amount_minor) from public.program_balance_entries e where e.account_id = a.id)
      -- Paid in, less what creators hold or are owed and what KissMyApps keeps, is what is left.
      and a.available_minor = 30000 - 1470 - 147 - 1470 - 147
    from pg_temp.account() a)
  and public.program_balance_health()->>'ledger_mismatches' = '0',
  'the balance equals its entries, and deposits less commission and fees equals what is available');
select set_config('request.jwt.claims', '', true);

select 'ok ' || count(*) || ' program money end to end assertions' from e2e_assertions;
rollback;
