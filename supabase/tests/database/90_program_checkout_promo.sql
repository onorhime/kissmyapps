-- Phase 8, piece A, working with Phases 1 to 7 through the real functions only: a merchant sells
-- one product through a KissMyApps checkout link and gives buyers 10% off with each creator's
-- promo code. The merchant fills in the product and the discount and publishes; KissMyApps
-- approves; two creators join and each gets a code; the promo worker claims the codes and
-- reports what Stripe made; a creator's link opens the checkout, which knows the product and
-- that creator's code; a buyer who clicked the first creator's link but paid with the second
-- creator's code is the second creator's sale and earns them the commission; a creator who
-- leaves has their code retired and switched off; a new discount retires the old codes and
-- issues new ones. Stripe is never called: each service function is given what its edge
-- function passes after reading Stripe.
begin;
set local time zone 'UTC';
create temporary table checkout_promo_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program checkout promo assertion failed: %', label; end if;
  insert into checkout_promo_assertions values (label);
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
  execute format('select public.%I(%L)', fn, input) into result;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- The same, as 'ok' or the SQLSTATE.
create function pg_temp.svc_try(fn text, input jsonb) returns text language plpgsql as $$
begin
  perform pg_temp.svc(fn, input);
  return 'ok';
exception when others then
  return sqlstate;
end $$;
-- What the end of a writing transaction does: the deferred commission triggers run.
create function pg_temp.flush() returns void language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end $$;
-- Rounded up: a payment recorded in the same second as the join must not fall before it.
create function pg_temp.epoch(p_at timestamptz) returns bigint language sql as $$ select ceil(extract(epoch from p_at))::bigint $$;
create function pg_temp.program() returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q('workspace')
$$;
create function pg_temp.save(input jsonb) returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
    input || jsonb_build_object('revision', (pg_temp.program()).revision)))
$$;
create function pg_temp.save_fails(input jsonb) returns text language sql as $$
  select pg_temp.try('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
    input || jsonb_build_object('revision', (pg_temp.program()).revision)))
$$;
create function pg_temp.state() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_get(%L)', pg_temp.q('workspace')))
$$;
create function pg_temp.agreement() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_agreement(%L)', pg_temp.q('workspace')))
$$;
create function pg_temp.read_agreement() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_mark_agreement_read(%L, %L)', pg_temp.q('workspace'),
    pg_temp.agreement()->>'sha256'))
$$;
create function pg_temp.submit_sql() returns text language sql as $$
  select format('select public.workspace_program_submit(%L, %s)', pg_temp.q('workspace'), (pg_temp.program()).revision)
$$;
create function pg_temp.links(who text) returns jsonb language sql as $$
  select pg_temp.call(who, 'select public.partner_program_links()')
$$;
create function pg_temp.detail(who text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.partner_program_detail(%L)', (pg_temp.program()).slug))
$$;
create function pg_temp.target(program text, click text) returns jsonb language sql as $$
  select pg_temp.svc('program_checkout_target', jsonb_build_object('program', program, 'click', click))
$$;
create function pg_temp.code_of(who text) returns public.program_promo_codes language sql as $$
  select c from public.program_promo_codes c
  join public.affiliate_program_members m on m.id = c.member_id
  join public.affiliate_users u on u.affiliate_id = m.affiliate_id
  where u.user_id = pg_temp.q(who) and c.status <> 'retired'
$$;
-- A creator joins: reads the program, accepts its agreement, keeps their main link.
create function pg_temp.join(who text) returns jsonb language plpgsql as $$
declare
  d jsonb := pg_temp.detail(who);
  m jsonb;
begin
  m := pg_temp.call(who, format('select public.partner_program_join(%L)', jsonb_build_object('slug', d->'program'->>'slug',
    'terms_version', d->'program'->'terms_version', 'agreement_sha256', d->'program'->>'agreement_sha256')));
  insert into qa values (who || '_link', m->'membership'->'link'->>'url');
  return m;
end $$;
-- A visitor opens a creator's main link, as the tracking-redirect function asks for it.
create function pg_temp.click(who text, slug text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select to_jsonb(r) into result from public.register_tracking_click(slug, split_part(pg_temp.t(who || '_link'), '/', 6), '{}'::jsonb) r;
  reset role;
  return result;
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
    'stripe_customer_id', 'cus_P8Checkout', 'platform_account_id', 'acct_KMAPlatform'));
  v_begun := pg_temp.svc('begin_program_deposit', jsonb_build_object('workspace_id', pg_temp.q('workspace'),
    'user_id', pg_temp.q('owner'), 'platform_account_id', 'acct_KMAPlatform', 'amount_minor', amount));
  perform pg_temp.svc('attach_program_topup', jsonb_build_object('topup_id', v_begun->>'topup_id',
    'checkout_session_id', 'cs_live_' || k));
  return pg_temp.svc('settle_program_topup', jsonb_build_object('topup_id', v_begun->>'topup_id', 'outcome', 'succeeded',
    'payment_intent_id', 'pi_p8dep' || k, 'livemode', true, 'amount_minor', amount, 'currency', 'usd',
    'customer_id', 'cus_P8Checkout', 'card', jsonb_build_object('payment_method_id', 'pm_P8CheckoutVisa', 'brand', 'visa',
      'last4', '4242', 'exp_month', 4, 'exp_year', 2029)));
end $$;
-- The webhook's receipt for one payment on the merchant's account, tagged with a creator click
-- when the PaymentIntent or the Checkout Session carried one.
create function pg_temp.receipt(p_event text, p_type text, p_intent text, p_amount bigint, p_tag text) returns jsonb language sql as $$
  select public.record_merchant_payment_event(jsonb_build_object(
    'platform_account_id', 'acct_KMAPlatform', 'livemode', true, 'account_id', 'acct_P8Checkout',
    'event_id', p_event, 'event_type', p_type, 'event_created', pg_temp.epoch(clock_timestamp()) + 2,
    'object_id', case when p_type = 'payment_intent.succeeded' then p_intent else 'cs_' || p_intent end,
    'payment_intent_id', p_intent, 'amount_minor', p_amount, 'currency', 'usd',
    'kma_click', p_tag, 'tag_source', case when p_tag is not null then 'metadata' end, 'payload_sha256', repeat('b', 64)))
$$;
-- The sales worker: claims the waiting receipt, records the sale it read back from Stripe (with
-- the promotion code the buyer used, when Stripe names one) and finishes the receipt. Each call
-- is a new event of the same payment.
create function pg_temp.pay_on(k text, p_type text, amount bigint, tag text, promo text) returns jsonb language plpgsql as $$
declare
  v_claim jsonb;
  v_ref jsonb;
  v jsonb;
begin
  perform pg_temp.receipt('evt_p8' || k || '_' || (select count(*) from public.merchant_payment_events e
    where e.payment_intent_id = 'pi_p8' || k), p_type, 'pi_p8' || k, amount, tag);
  v_claim := pg_temp.svc('claim_program_sale_receipts', '{"platform_account_id":"acct_KMAPlatform","limit":5}');
  v_ref := jsonb_build_object('platform_account_id', 'acct_KMAPlatform')
    || ((v_claim->'receipts'->0) - 'event_type' - 'account_id' - 'object_id' - 'payment_intent_id' - 'amount_minor'
      - 'currency' - 'event_created' - 'attempts');
  v := pg_temp.svc('record_program_sale', v_ref || jsonb_strip_nulls(jsonb_build_object(
    'livemode', true, 'payment_intent_id', 'pi_p8' || k, 'charge_id', 'ch_p8' || k,
    'checkout_session_id', case when p_type <> 'payment_intent.succeeded' then 'cs_pi_p8' || k end,
    'amount_minor', amount, 'currency', 'usd', 'refunded_minor', 0, 'paid_at', pg_temp.epoch(clock_timestamp()),
    'kma_click', tag, 'tag_source', case when tag is not null then 'metadata' end, 'promotion_code_id', promo)));
  perform pg_temp.svc('finish_program_sale_receipt', v_ref || '{"action":"done","code":"recorded"}');
  perform pg_temp.flush();
  return v;
end $$;
create function pg_temp.pay(k text, amount bigint, tag text, promo text) returns jsonb language sql as $$
  select pg_temp.pay_on(k, 'checkout.session.completed', amount, tag, promo)
$$;
create function pg_temp.sale(k text) returns public.program_sales language sql as $$
  select s from public.program_sales s where s.payment_intent_id = 'pi_p8' || k
$$;
create function pg_temp.commission(k text) returns public.program_commissions language sql as $$
  select c from public.program_commissions c join public.program_sales s on s.id = c.sale_id where s.payment_intent_id = 'pi_p8' || k
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
grant all on qa, checkout_promo_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('eb900000-0000-4000-8000-000000000001', 'owner@fluent.example.test', now(), '{"company":"Fluent"}'),
  ('eb900000-0000-4000-8000-000000000011', 'founder@kma.example.test', now(), '{}'),
  ('eb900000-0000-4000-8000-000000000021', 'anna@creators.example.test', now(), '{}'),
  ('eb900000-0000-4000-8000-000000000022', 'ben@creators.example.test', now(), '{}');
insert into qa values ('owner', 'eb900000-0000-4000-8000-000000000001'),
  ('kma_owner', 'eb900000-0000-4000-8000-000000000011'),
  ('anna', 'eb900000-0000-4000-8000-000000000021'), ('ben', 'eb900000-0000-4000-8000-000000000022');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner');
insert into public.affiliates(id, public_name, slug, status) values
  ('ec900000-0000-4000-8000-000000000001', 'Anna', 'p8-anna', 'active'),
  ('ec900000-0000-4000-8000-000000000002', 'Ben Rivers', 'p8-ben', 'active');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at) values
  ('ec900000-0000-4000-8000-000000000001', pg_temp.q('anna'), 'owner', true, false, now()),
  ('ec900000-0000-4000-8000-000000000002', pg_temp.q('ben'), 'owner', true, false, now());
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true;
select pg_temp.sign_in('owner');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
with business as (
  insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
  values ('Fluent Ltd', 'billing@fluent.example.test', pg_temp.q('owner'), pg_temp.q('workspace')) returning id)
insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status, business_name,
  country, charges_enabled, details_submitted, confirmed_at, verified_at)
select id, 'acct_KMAPlatform', true, 'acct_P8Checkout', 'active', 'Fluent Ltd', 'GB', false, true, now(), now() from business;
select pg_temp.call('kma_owner', format('select public.configure_admin_program_money(%L)', jsonb_build_object('enabled', true,
  'expected_updated_at', pg_temp.call('kma_owner', 'select public.get_admin_program_money()')->'updated_at')));

-- Who may call what ------------------------------------------------------------------------------
select pg_temp.check(
  (select bool_and(pg_temp.try_as(r, format('select public.%s(''{}''::jsonb)', f)) = '42501')
    from unnest(array['anon', 'authenticated']) r,
      unnest(array['claim_program_promo_codes', 'finish_program_promo_code', 'program_checkout_target', 'record_program_sale']) f)
  and pg_temp.try_as('service_role', 'select kma_internal.program_promo_sync(null)') = '42501'
  and pg_temp.try_as('service_role', 'select count(*) from public.program_promo_codes') = '42501'
  and pg_temp.try_as('service_role', 'select count(*) from public.program_promo_code_uses') = '42501',
  'only the service role reaches the promo worker and the checkout target; nobody reads the code tables directly');
select pg_temp.check(
  (select bool_and(p.proargnames = array['p_input']) and count(*) = 4 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('claim_program_promo_codes', 'finish_program_promo_code',
      'program_checkout_target', 'record_program_sale')),
  'each service function takes one argument named p_input, the name the edge functions call it with');

-- The merchant fills in a checkout link and a discount ----------------------------------------------
select pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
  '{"name":"Fluent","category":"education","tagline":"Speak a new language in a month.",
    "landing_url":"https://fluent-app.io/start","commission_type":"percent","commission_rate_bps":3000,
    "commission_duration":"lifetime","hold_days":14}'::jsonb));
select pg_temp.check(
  (select s->'program' @> '{"payment_mode":"own_checkout","checkout":null,"buyer_discount_bps":null,
      "landing_url":"https://fluent-app.io/start"}'
      and s->'program'->'promo_codes' = 'null'
    from pg_temp.state() s),
  'a program sells through the merchant''s own checkout with no discount until the merchant says otherwise');
select pg_temp.check(
  pg_temp.save_fails('{"payment_mode":"stripe"}') = '22023 invalid_payment_mode'
  and pg_temp.save_fails('{"payment_mode":"kma_checkout","checkout":{"name":"Fluent Pro","interval":"week"}}') = '22023 invalid_checkout'
  and pg_temp.save_fails('{"payment_mode":"kma_checkout","checkout":{"name":"Fluent Pro","amount_minor":0}}') = '22023 invalid_checkout'
  and pg_temp.save_fails('{"payment_mode":"kma_checkout","checkout":{"success_url":"http://fluent-app.io/welcome"}}') = '22023 invalid_checkout'
  and pg_temp.save_fails('{"payment_mode":"kma_checkout","checkout":{"success_url":"https://fluent.example.test/welcome"}}') = '22023 invalid_checkout'
  and pg_temp.save_fails('{"payment_mode":"kma_checkout","checkout":{"name":"Fluent Pro","price":999}}') = '22023 invalid_checkout'
  and pg_temp.save_fails('{"payment_mode":"kma_checkout","checkout":"Fluent Pro"}') = '22023 invalid_checkout'
  and pg_temp.save_fails('{"buyer_discount_bps":50}') = '22023 invalid_buyer_discount_bps'
  and pg_temp.save_fails('{"buyer_discount_bps":9500}') = '22023 invalid_buyer_discount_bps'
  and pg_temp.save_fails('{"earn_from":"events","payment_mode":"kma_checkout","rewards":[{"key":"signup","label":"Sign-up","amount_minor":100}],
    "reward_budget_minor":1000}') = '22023 invalid_payment_mode'
  and pg_temp.save_fails('{"earn_from":"events","buyer_discount_bps":1000,"rewards":[{"key":"signup","label":"Sign-up","amount_minor":100}],
    "reward_budget_minor":1000}') = '22023 invalid_buyer_discount_bps'
  and (pg_temp.program()).payment_mode = 'own_checkout',
  'the form refuses a product that is not complete or not valid, a discount outside 1% to 90%, and codes or a checkout on an events-only program');
select pg_temp.save('{"payment_mode":"kma_checkout","landing_url":"https://fluent-app.io/elsewhere",
  "checkout":{"name":"Fluent Pro","amount_minor":999,"interval":"month"},"buyer_discount_bps":1000}');
select pg_temp.check(
  (select s->'program' @> '{"payment_mode":"kma_checkout","landing_url":"https://kissmyapps.dev/checkout/fluent","slug":"fluent",
      "checkout":{"name":"Fluent Pro","amount_minor":999,"interval":"month","success_url":null},"buyer_discount_bps":1000}'
      and not (s->'checklist'->>'landing_page')::boolean and not (s->'checklist'->>'stripe_connected')::boolean
      and not (s->>'stripe_charges_enabled')::boolean and (s->>'stripe_connected')::boolean is false
    from pg_temp.state() s)
  and (pg_temp.agreement()->>'complete')::boolean is false,
  'a checkout link leads to kissmyapps.dev/checkout/<address> whatever landing page is sent; without a page after payment the product is not complete');
select pg_temp.save('{"checkout":{"success_url":"https://fluent-app.io/welcome"},"name":"Fluent Club"}');
select pg_temp.check(
  (select s->'program' @> '{"slug":"fluent-club","landing_url":"https://kissmyapps.dev/checkout/fluent-club",
      "checkout":{"name":"Fluent Pro","amount_minor":999,"interval":"month","success_url":"https://fluent-app.io/welcome"}}'
      and (s->'checklist'->>'landing_page')::boolean
    from pg_temp.state() s),
  'a partial product keeps what it had; until approval the checkout address follows the marketplace address, which follows the name');
select pg_temp.save('{"name":"Fluent"}');
select pg_temp.check(
  (select a->'agreement'->'summary' = '[{"label":"Commission","value":"30% of every payment"},
        {"label":"Product","value":"Fluent Pro, $9.99 a month"},{"label":"Buyer discount","value":"10% off with your code"},
        {"label":"Attribution window","value":"30 days"},{"label":"Hold before payout","value":"14 days"},
        {"label":"Minimum payout","value":"$20.00"}]'
      and a->'agreement'->'sections'->1->'paragraphs'->>0 = 'You promote Fluent. KissMyApps gives you your own link, and people '
        || 'who click it go to a checkout where they can buy Fluent Pro for $9.99 a month.'
      and a->'agreement'->'sections'->3->'paragraphs' @> '["KissMyApps also gives you your own promo code, which gives buyers 10% off and is applied by itself on the checkout your link opens.",
        "A sale paid with your promo code is credited to you, even if the customer did not click your link or clicked another creator''s link. Commission is worked out on what the customer paid after the discount."]'
      and jsonb_array_length(a->'agreement'->'sections'->3->'paragraphs') = 6
    from pg_temp.agreement() a)
  and (select kma_internal.program_terms(p) @> '{"payment_mode":"kma_checkout","checkout":{"name":"Fluent Pro","amount_minor":999,"interval":"month"},
      "buyer_discount_bps":1000,"landing_url":"https://kissmyapps.dev/checkout/fluent"}'
      and not (kma_internal.program_terms(p)->'checkout' ? 'success_url')
    from pg_temp.program() p),
  'the agreement names the product, its price and the discount, and says how a code credits a sale; the terms carry them, not the page after payment');

-- Publishing needs a Stripe account that can take payments -------------------------------------------
select pg_temp.read_agreement();
select pg_temp.deposit('first', 10000);
select pg_temp.check(pg_temp.try('owner', pg_temp.submit_sql()) = '22023 stripe_charges_disabled'
    and (pg_temp.program()).status = 'draft' and not (pg_temp.state()->>'can_submit')::boolean,
  'a checkout link cannot be published while the merchant''s Stripe account cannot take payments');
update public.merchant_connections set charges_enabled = true where account_id = 'acct_P8Checkout';
select pg_temp.check((pg_temp.state()->>'can_submit')::boolean and (pg_temp.state()->>'stripe_charges_enabled')::boolean,
  'once Stripe can take payments the program can be published');
select pg_temp.call('owner', pg_temp.submit_sql());
select pg_temp.capture('program_checkout_target.not_live', pg_temp.target('fluent', null));
select pg_temp.check(pg_temp.target('fluent', null) = '{"ok":false,"reason":"not_live"}'
    and pg_temp.target('nobody-here', null) = '{"ok":false,"reason":"not_found"}'
    and pg_temp.target('../fluent', null) = '{"ok":false,"reason":"not_found"}'
    and pg_temp.svc_try('program_checkout_target', '{"program":"fluent","extra":1}') = '22023',
  'while the program waits for review its checkout sells nothing; an unknown address is not found');
select pg_temp.call('kma_owner', format('select public.review_admin_program(%L)',
  jsonb_build_object('program_id', (pg_temp.program()).id, 'decision', 'approve', 'note', null)));
select pg_temp.capture('workspace_program_get.kma_checkout', pg_temp.state());
select pg_temp.check((pg_temp.program()).status = 'live'
  and (select f.destination_url = 'https://kissmyapps.dev/checkout/fluent' from public.funnels f where f.id = (pg_temp.program()).funnel_id)
  and (select t.terms @> '{"payment_mode":"kma_checkout","buyer_discount_bps":1000}' from public.affiliate_program_terms t
    where t.program_id = (pg_temp.program()).id and t.version = 1)
  and (select count(*) = 0 from public.program_promo_codes),
  'approved: the link destination is the checkout, the terms carry the product and the discount, and with no creators there are no codes');

-- The marketplace says what buyers get --------------------------------------------------------------
select pg_temp.capture('marketplace_program.with_checkout', public.marketplace_program('fluent'));
select pg_temp.check(
  (select m->'program' @> '{"payment_mode":"kma_checkout","checkout":{"name":"Fluent Pro","amount_minor":999,"interval":"month"},
      "buyer_discount_bps":1000,"currency":"USD","landing_url":"https://kissmyapps.dev/checkout/fluent"}'
      and not (m->'program'->'checkout' ? 'success_url')
    from (select public.marketplace_program('fluent') m) x)
  and (select c @> '{"slug":"fluent","payment_mode":"kma_checkout","buyer_discount_bps":1000}'
    from jsonb_array_elements(public.marketplace_programs()->'programs') c),
  'the marketplace card and detail show the product, its price and the buyer discount');

-- Two creators join and each gets a code --------------------------------------------------------------
select pg_temp.join('anna'), pg_temp.join('ben');
select pg_temp.check(
  (pg_temp.code_of('anna')).code = 'ANNA10' and (pg_temp.code_of('anna')).status = 'pending'
  and (pg_temp.code_of('anna')).discount_bps = 1000 and (pg_temp.code_of('anna')).account_id = 'acct_P8Checkout'
  and (pg_temp.code_of('ben')).code = 'BENRIVERS10' and (pg_temp.code_of('ben')).status = 'pending'
  and (select d->'membership'->'promo_code' = '{"code":"ANNA10","discount_bps":1000,"status":"pending"}' from pg_temp.detail('anna') d)
  and (select l->'programs'->0->'promo_code' = '{"code":"BENRIVERS10","discount_bps":1000,"status":"pending"}' from pg_temp.links('ben') l)
  and (select s->'program'->'promo_codes' = '{"pending":2,"active":0,"failed":0,"last_error":null}' from pg_temp.state() s),
  'each creator who joins gets a code made from their public name and the discount, waiting to be made on Stripe');

-- The promo worker makes them on the merchant's Stripe ------------------------------------------------
select pg_temp.check(pg_temp.svc_try('claim_program_promo_codes', '{"limit":0}') = '22023'
    and pg_temp.svc_try('claim_program_promo_codes', '{"size":5}') = '22023'
    and pg_temp.svc_try('finish_program_promo_code', '{"id":"x"}') = '22023'
    and pg_temp.svc_try('finish_program_promo_code', jsonb_build_object('id', (pg_temp.code_of('anna')).id, 'error', 'Stripe said no')) = '22023'
    and pg_temp.svc_try('finish_program_promo_code', jsonb_build_object('id', gen_random_uuid(), 'deactivated', true)) = 'P0002',
  'the worker functions refuse malformed calls');
insert into qa select 'claim_1', pg_temp.svc('claim_program_promo_codes', '{"limit":10}')::text;
select pg_temp.capture('claim_program_promo_codes.pending', pg_temp.t('claim_1')::jsonb);
select pg_temp.check(
  (select c = jsonb_build_object('codes', jsonb_build_array(jsonb_build_object('id', (pg_temp.code_of('anna')).id, 'code', 'ANNA10',
      'account_id', 'acct_P8Checkout', 'discount_bps', 1000, 'coupon_id', null, 'program_id', (pg_temp.program()).id)),
      'deactivate', '[]'::jsonb)
    from (select pg_temp.t('claim_1')::jsonb c) x)
  and pg_temp.svc('claim_program_promo_codes', '{}') = '{"codes":[],"deactivate":[]}',
  'of two codes that need the same new coupon only the first is handed out, and a leased code is not handed out twice');
select pg_temp.check(
  pg_temp.svc('finish_program_promo_code', jsonb_build_object('id', (pg_temp.code_of('anna')).id,
    'coupon_id', 'kmaP8Ten', 'promotion_code_id', 'promo_P8Anna')) @> '{"code":"ANNA10","status":"active","attempts":0}'
  and (pg_temp.code_of('anna')).stripe_coupon_id = 'kmaP8Ten' and (pg_temp.code_of('anna')).activated_at is not null,
  'Stripe made the first code: it is active with its coupon and promotion code');
insert into qa select 'claim_2', pg_temp.svc('claim_program_promo_codes', '{}')::text;
select pg_temp.check(
  (select c->'codes'->0 @> '{"code":"BENRIVERS10","coupon_id":"kmaP8Ten"}' and jsonb_array_length(c->'codes') = 1
    from (select pg_temp.t('claim_2')::jsonb c) x),
  'the second code reuses the coupon of the first');
select pg_temp.check(
  pg_temp.svc('finish_program_promo_code', jsonb_build_object('id', (pg_temp.code_of('ben')).id, 'error', 'code_taken'))
    @> '{"code":"BENRIVERS102","status":"pending","attempts":1}'
  and pg_temp.svc('claim_program_promo_codes', '{}')->'codes'->0 @> '{"code":"BENRIVERS102","coupon_id":"kmaP8Ten"}',
  'a code that is taken on the merchant''s Stripe gets a digit and is tried again at once');
select pg_temp.svc('finish_program_promo_code', jsonb_build_object('id', (pg_temp.code_of('ben')).id,
  'coupon_id', 'kmaP8Ten', 'promotion_code_id', 'promo_P8Ben'));
select pg_temp.check(
  (pg_temp.code_of('ben')).status = 'active' and (pg_temp.code_of('ben')).stripe_promotion_code_id = 'promo_P8Ben'
  and pg_temp.svc_try('finish_program_promo_code', jsonb_build_object('id', (pg_temp.code_of('ben')).id,
    'coupon_id', 'kmaP8Ten', 'promotion_code_id', 'promo_P8Other')) = '55000'
  and pg_temp.svc('finish_program_promo_code', jsonb_build_object('id', (pg_temp.code_of('ben')).id,
    'coupon_id', 'kmaP8Ten', 'promotion_code_id', 'promo_P8Ben')) @> '{"status":"active"}'
  and (select s->'program'->'promo_codes' = '{"pending":0,"active":2,"failed":0,"last_error":null}' from pg_temp.state() s),
  'both codes are active; reporting the same code again changes nothing, and another promotion code for it is refused');
select pg_temp.capture('partner_program_links.with_code', pg_temp.links('anna'));
select pg_temp.check(
  (select l->'programs'->0->'promo_code' = '{"code":"ANNA10","discount_bps":1000,"status":"active"}' from pg_temp.links('anna') l)
  and (select d->'membership'->'promo_code' = '{"code":"BENRIVERS102","discount_bps":1000,"status":"active"}' from pg_temp.detail('ben') d)
  and (select bool_and(not (x::text ~* '(promo_P8|kmaP8|acct_P8)')) from (values (pg_temp.links('anna')), (pg_temp.detail('ben'))) v(x)),
  'each creator reads their own code and its discount, and nothing of Stripe');

-- A creator's link opens the checkout with their code --------------------------------------------------
insert into qa select 'anna_click', pg_temp.click('anna', 'p8-anna')::text;
select pg_temp.check((pg_temp.t('anna_click')::jsonb)->>'destination_url' = 'https://kissmyapps.dev/checkout/fluent',
  'the creator''s link sends the visitor to the checkout address');
select pg_temp.capture('program_checkout_target.ok', pg_temp.target('fluent', (pg_temp.t('anna_click')::jsonb)->>'click_id'));
select pg_temp.check(
  pg_temp.target('fluent', (pg_temp.t('anna_click')::jsonb)->>'click_id') = jsonb_build_object('ok', true,
    'program_name', 'Fluent', 'account_id', 'acct_P8Checkout', 'currency', 'USD',
    'product', jsonb_build_object('name', 'Fluent Pro', 'amount_minor', 999, 'interval', 'month'),
    'success_url', 'https://fluent-app.io/welcome', 'cancel_url', 'https://fluent-app.io/',
    'click', (pg_temp.t('anna_click')::jsonb)->>'click_id', 'promotion_code_id', 'promo_P8Anna', 'buyer_discount_bps', 1000)
  and pg_temp.target('fluent', null) @> '{"ok":true,"click":null,"promotion_code_id":null,"buyer_discount_bps":1000}'
  and pg_temp.target('fluent', 'not-a-click-of-this-program-000') @> '{"ok":true,"click":null,"promotion_code_id":null}'
  and pg_temp.target('fluent', '<script>') @> '{"ok":true,"click":null}',
  'the checkout target gives the product, the merchant''s Stripe account, the visit''s click and that creator''s code; a visit with no real click gets no code');

-- A buyer who clicked Anna's link pays with Ben's code -----------------------------------------------
-- (Each payment runs in a statement of its own: a statement does not see the rows it wrote.)
insert into qa select 'pay_one', pg_temp.pay('one', 899, (pg_temp.t('anna_click')::jsonb)->>'click_id', 'promo_P8Ben')::text;
select pg_temp.check(
  pg_temp.t('pay_one')::jsonb @> '{"recorded":true,"created":true,"match_source":"promotion_code","matched":true}'
  and (pg_temp.sale('one')).affiliate_id = 'ec900000-0000-4000-8000-000000000002'
  and (pg_temp.sale('one')).promotion_code_id = 'promo_P8Ben'
  and (select l.id = m.main_link_id and k.occurred_at = (pg_temp.sale('one')).paid_at and not k.is_bot
      and u.code_id = (pg_temp.code_of('ben')).id
    from public.clicks k
    join public.program_promo_code_uses u on u.click_record_id = k.id and u.sale_id = (pg_temp.sale('one')).id
    join public.affiliate_links l on l.id = k.affiliate_link_id
    join public.affiliate_program_members m on m.affiliate_id = k.affiliate_id and m.program_id = (pg_temp.program()).id
    where k.id = (pg_temp.sale('one')).click_record_id),
  'the code beats the earlier link click: the sale is Ben''s, tied to a click on his main link marked as a code use');
select pg_temp.check(
  (pg_temp.commission('one')).status = 'held' and (pg_temp.commission('one')).affiliate_id = 'ec900000-0000-4000-8000-000000000002'
  and (pg_temp.commission('one')).basis_minor = 899 and (pg_temp.commission('one')).amount_minor = 269
  and (pg_temp.commission('one')).fee_minor = 26,
  'Ben earns 30% of what the buyer paid after the discount, set aside from the balance with the KissMyApps fee');
select pg_temp.check(
  (select r @> '{"recorded":true,"created":false,"match_source":"promotion_code"}'
    from pg_temp.pay('one', 899, (pg_temp.t('anna_click')::jsonb)->>'click_id', null) r)
  and (select count(*) = 1 from public.program_promo_code_uses u where u.sale_id = (pg_temp.sale('one')).id)
  and (pg_temp.sale('one')).affiliate_id = 'ec900000-0000-4000-8000-000000000002',
  'another receipt of the same payment that does not name the code keeps the sale with Ben and makes no second click');
select pg_temp.check(
  (select r @> '{"match_source":"metadata"}' from pg_temp.pay('two', 899, (pg_temp.t('anna_click')::jsonb)->>'click_id', null) r)
  and (pg_temp.sale('two')).affiliate_id = 'ec900000-0000-4000-8000-000000000001'
  and (select r @> '{"match_source":"metadata"}'
    from pg_temp.pay('three', 999, (pg_temp.t('anna_click')::jsonb)->>'click_id', 'promo_SomeoneElse') r)
  and (pg_temp.sale('three')).promotion_code_id = 'promo_SomeoneElse'
  and (pg_temp.sale('three')).affiliate_id = 'ec900000-0000-4000-8000-000000000001'
  and pg_temp.svc_try('record_program_sale', '{"promotion_code_id":"WELCOME"}') = '22023',
  'without a creator code the tag decides; a promotion code that is not a creator code is kept on the sale and credits nobody');
select pg_temp.capture('workspace_program_sales.promo',
  pg_temp.call('owner', format('select public.workspace_program_sales(%L, %L)', pg_temp.q('workspace'), '{}'::jsonb)));
select pg_temp.check(
  (select exists (select 1 from jsonb_array_elements(w->'sales') s
      where s @> '{"creator_name":"Ben Rivers","match_source":"promotion_code","link_name":"Main link","status":"pending","commission_minor":269}')
    from (select pg_temp.call('owner', format('select public.workspace_program_sales(%L, %L)', pg_temp.q('workspace'), '{}'::jsonb)) w) x)
  and (select l->'programs'->0->'links'->0 @> '{"kind":"main","sales":1,"earnings_minor":269}' from pg_temp.links('ben') l),
  'the merchant''s Sales page and Ben''s Links page both show the code sale on his main link');

-- The PaymentIntent's receipt usually comes first and names no code: the sale is Anna's by her
-- tag. The Checkout Session's receipt then names Ben's code: the sale and its commission move to
-- Ben, and what was set aside for Anna goes back to the balance first.
insert into qa select 'pay_cross_1', pg_temp.pay_on('cross', 'payment_intent.succeeded', 899,
  (pg_temp.t('anna_click')::jsonb)->>'click_id', null)::text;
select pg_temp.check(
  pg_temp.t('pay_cross_1')::jsonb @> '{"recorded":true,"created":true,"match_source":"metadata"}'
  and (pg_temp.sale('cross')).affiliate_id = 'ec900000-0000-4000-8000-000000000001'
  and (pg_temp.sale('cross')).promotion_code_id is null
  and (pg_temp.commission('cross')).status = 'held'
  and (pg_temp.commission('cross')).affiliate_id = 'ec900000-0000-4000-8000-000000000001'
  and (pg_temp.commission('cross')).amount_minor = 269,
  'the PaymentIntent receipt with Anna''s tag and no code makes the sale Anna''s and sets her commission aside');
insert into qa select 'cross_available', (select a.available_minor from public.program_balance_accounts a
  where a.program_id = (pg_temp.program()).id)::text;
insert into qa select 'pay_cross_2', pg_temp.pay_on('cross', 'checkout.session.completed', 899,
  (pg_temp.t('anna_click')::jsonb)->>'click_id', 'promo_P8Ben')::text;
select pg_temp.check(
  pg_temp.t('pay_cross_2')::jsonb @> '{"recorded":true,"created":false,"match_source":"promotion_code","matched":true}'
  and (pg_temp.sale('cross')).affiliate_id = 'ec900000-0000-4000-8000-000000000002'
  and (pg_temp.sale('cross')).promotion_code_id = 'promo_P8Ben'
  and (pg_temp.sale('cross')).checkout_session_id = 'cs_pi_p8cross'
  and (pg_temp.commission('cross')).status = 'held'
  and (pg_temp.commission('cross')).affiliate_id = 'ec900000-0000-4000-8000-000000000002'
  and (pg_temp.commission('cross')).amount_minor = 269
  and (select count(*) = 1 from public.program_balance_entries e
    where e.commission_id = (pg_temp.commission('cross')).id and e.kind = 'commission_returned' and e.amount_minor = 269)
  and (select a.available_minor = pg_temp.t('cross_available')::bigint from public.program_balance_accounts a
    where a.program_id = (pg_temp.program()).id),
  'the Checkout Session receipt with Ben''s code moves the sale to Ben: Anna''s held commission goes back and Ben''s is set aside');
select pg_temp.check(
  (select r @> '{"recorded":true,"created":false,"match_source":"promotion_code"}'
    from pg_temp.pay_on('cross', 'payment_intent.succeeded', 899, (pg_temp.t('anna_click')::jsonb)->>'click_id', null) r)
  and (pg_temp.sale('cross')).affiliate_id = 'ec900000-0000-4000-8000-000000000002'
  and (pg_temp.sale('cross')).promotion_code_id = 'promo_P8Ben'
  and (pg_temp.commission('cross')).affiliate_id = 'ec900000-0000-4000-8000-000000000002',
  'a later receipt with the tag and no code never takes the sale back from the code or wipes the code');

-- Paused programs sell nothing ----------------------------------------------------------------------
select pg_temp.call('owner', format('select public.workspace_program_set_status(%L, %L, %s)', pg_temp.q('workspace'), 'paused',
  (pg_temp.program()).revision));
select pg_temp.check(pg_temp.target('fluent', null) = '{"ok":false,"reason":"paused"}', 'a paused program''s checkout sells nothing');
select pg_temp.call('owner', format('select public.workspace_program_set_status(%L, %L, %s)', pg_temp.q('workspace'), 'live',
  (pg_temp.program()).revision));
update public.merchant_connections set charges_enabled = false where account_id = 'acct_P8Checkout';
select pg_temp.check(pg_temp.target('fluent', null) = '{"ok":false,"reason":"no_connection"}',
  'nor does one whose Stripe account can no longer take payments');
update public.merchant_connections set charges_enabled = true where account_id = 'acct_P8Checkout';

-- Ben leaves: his code is retired and switched off ----------------------------------------------------
insert into qa select 'ben_code', (pg_temp.code_of('ben')).id::text;
select pg_temp.call('ben', format('select public.partner_program_leave(%L)', jsonb_build_object('program_id', (pg_temp.program()).id)));
select pg_temp.check(
  (select c.status = 'retired' and c.retired_at is not null and c.deactivated_at is null
    from public.program_promo_codes c where c.id = pg_temp.q('ben_code'))
  and (select d->'membership'->'promo_code' = 'null' from pg_temp.detail('ben') d),
  'a creator who leaves has their code retired at once and no longer reads one');
insert into qa select 'claim_3', pg_temp.svc('claim_program_promo_codes', '{}')::text;
select pg_temp.check(
  (select c = jsonb_build_object('codes', '[]'::jsonb, 'deactivate', jsonb_build_array(jsonb_build_object('id', pg_temp.q('ben_code'),
      'account_id', 'acct_P8Checkout', 'promotion_code_id', 'promo_P8Ben')))
    from (select pg_temp.t('claim_3')::jsonb c) x)
  and pg_temp.svc('claim_program_promo_codes', '{}') = '{"codes":[],"deactivate":[]}',
  'the worker is handed the retired code to switch off on Stripe, and nobody else while it holds it');
select pg_temp.check(
  (select r @> '{"status":"retired"}' from pg_temp.svc('finish_program_promo_code',
    jsonb_build_object('id', pg_temp.q('ben_code'), 'error', 'rate_limited')) r),
  'switching it off failed: the code stays retired');
select pg_temp.check(
  (select c.status = 'retired' and c.deactivate_attempts = 1 and c.lease_until is null and c.next_attempt_at > now()
      and c.last_error = 'rate_limited'
    from public.program_promo_codes c where c.id = pg_temp.q('ben_code'))
  and pg_temp.svc('claim_program_promo_codes', '{}') = '{"codes":[],"deactivate":[]}',
  'a failed switch-off counts a try and waits before it is offered again');
update public.program_promo_codes set next_attempt_at = now(), deactivate_attempts = 7 where id = pg_temp.q('ben_code');
update public.program_promo_codes set lease_until = now() - interval '1 second', next_attempt_at = now() - interval '1 hour'
  where id = pg_temp.q('ben_code');
select pg_temp.check(
  (select c->'deactivate'->0->>'id' = pg_temp.t('ben_code') from pg_temp.svc('claim_program_promo_codes', '{}') c),
  'a switch-off is offered again however often it failed, and a claim whose lease ran out is handed out again');
select pg_temp.svc('finish_program_promo_code', jsonb_build_object('id', pg_temp.q('ben_code'), 'deactivated', true));
select pg_temp.check(
  (select c.deactivated_at is not null and c.status = 'retired' from public.program_promo_codes c where c.id = pg_temp.q('ben_code'))
  and pg_temp.svc('claim_program_promo_codes', '{}') = '{"codes":[],"deactivate":[]}',
  'once switched off it leaves the list for good');
select pg_temp.check(
  (select r @> '{"match_source":"metadata"}' from pg_temp.pay('four', 899, (pg_temp.t('anna_click')::jsonb)->>'click_id', 'promo_P8Ben') r)
  and (pg_temp.sale('four')).affiliate_id = 'ec900000-0000-4000-8000-000000000001'
  and (pg_temp.sale('one')).affiliate_id = 'ec900000-0000-4000-8000-000000000002'
  and (pg_temp.commission('one')).status = 'held',
  'a sale with a code retired before it was paid is not the code''s; the sale made while the code was live stays Ben''s');

-- A new discount retires the old codes and issues new ones ---------------------------------------------
select pg_temp.save('{"buyer_discount_bps":2000}');
select pg_temp.check(
  (select (s->'program'->>'has_unpublished_changes')::boolean and not (s->>'can_submit')::boolean from pg_temp.state() s)
  and (pg_temp.code_of('anna')).code = 'ANNA10' and (pg_temp.code_of('anna')).status = 'active',
  'a new discount is a change of terms: codes stay as they are until it is published');
select pg_temp.read_agreement();
select pg_temp.call('owner', pg_temp.submit_sql());
select pg_temp.check(
  (pg_temp.program()).live_terms_version = 2
  and (pg_temp.code_of('anna')).code = 'ANNA20' and (pg_temp.code_of('anna')).status = 'pending'
  and (pg_temp.code_of('anna')).discount_bps = 2000
  and (select count(*) = 1 from public.program_promo_codes c where c.code = 'ANNA10' and c.status = 'retired')
  and (select d->'membership' @> '{"needs_new_terms":true,"promo_code":{"code":"ANNA20","discount_bps":2000,"status":"pending"}}'
    from pg_temp.detail('anna') d),
  'publishing 20% retires ANNA10, issues ANNA20, and asks Anna to accept the new terms');
select pg_temp.check(
  (select c->'codes'->0 @> '{"code":"ANNA20","discount_bps":2000,"coupon_id":null}' and jsonb_array_length(c->'codes') = 1
      and c->'deactivate'->0 @> '{"promotion_code_id":"promo_P8Anna"}' and jsonb_array_length(c->'deactivate') = 1
    from pg_temp.svc('claim_program_promo_codes', '{}') c),
  'the worker makes the new code with a new coupon and switches the old one off');
select pg_temp.check(
  (select r @> '{"status":"pending","attempts":1}' from pg_temp.svc('finish_program_promo_code',
    jsonb_build_object('id', (pg_temp.code_of('anna')).id, 'error', 'rate_limited')) r)
  and (pg_temp.code_of('anna')).next_attempt_at > now()
  and pg_temp.svc('claim_program_promo_codes', '{}')->'codes' = '[]',
  'a code Stripe refused for another reason waits before it is tried again');
update public.program_promo_codes set attempts = 4, next_attempt_at = now() where id = (pg_temp.code_of('anna')).id;
select pg_temp.svc('claim_program_promo_codes', '{}');
select pg_temp.check(
  (select r @> '{"status":"failed","attempts":5}' from pg_temp.svc('finish_program_promo_code',
    jsonb_build_object('id', (pg_temp.code_of('anna')).id, 'error', 'rate_limited')) r)
  and (pg_temp.code_of('anna')).last_error = 'rate_limited'
  and (select l->'programs'->0->'promo_code' = '{"code":"ANNA20","discount_bps":2000,"status":"failed"}' from pg_temp.links('anna') l)
  and (select s->'program'->'promo_codes' = '{"active":0,"pending":0,"failed":1,"last_error":"rate_limited"}' from pg_temp.state() s),
  'after five refusals the code is failed: the creator reads that, and the merchant sees it counted with its plain reason');

-- Codes stay in line by themselves ------------------------------------------------------------------
delete from public.program_promo_codes where id = (pg_temp.code_of('anna')).id;
select pg_temp.svc('claim_program_promo_codes', '{}');
select pg_temp.check((pg_temp.code_of('anna')).code = 'ANNA20' and (pg_temp.code_of('anna')).status = 'pending',
  'an active member who has no code (a missed trigger) gets one at the next claim');
select pg_temp.save('{"buyer_discount_bps":null}');
select pg_temp.read_agreement();
select pg_temp.call('owner', pg_temp.submit_sql());
select pg_temp.check((select count(*) = 0 from public.program_promo_codes c where c.status <> 'retired')
    and (select d->'membership'->'promo_code' = 'null' and d->'program'->'buyer_discount_bps' = 'null' from pg_temp.detail('anna') d)
    and (select s->'program'->'promo_codes' = 'null' from pg_temp.state() s),
  'publishing no discount retires every code, and the merchant''s answer has no code counts');

-- Nothing about buyers reaches a creator --------------------------------------------------------------
select pg_temp.check(
  (select bool_and(not (x::text ~* '(creators\.example|fluent\.example|cus_|pi_p8|ch_p8|cs_pi|acct_P8|promo_p8|promo_some|kmap8)'))
    from (values (pg_temp.links('anna')), (pg_temp.links('ben')), (pg_temp.detail('anna')), (pg_temp.detail('ben')),
      (pg_temp.call('anna', 'select public.partner_program_earnings()')),
      (pg_temp.call('anna', 'select public.partner_marketplace()'))) v(x)),
  'no buyer, payment or Stripe data reaches a creator');

select format('ok %s program checkout promo assertions', count(*)) from checkout_promo_assertions;
rollback;
