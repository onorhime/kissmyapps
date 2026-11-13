-- Provider-free test of program commissions: what a sale earns and why it may earn nothing,
-- the money set aside from the merchant's balance and given back, approval after the hold,
-- refunds after approval, the balance a program needs to publish, what a creator sees and
-- the admin switch. Programs, members and clicks are made with the Phase 2 and 3 functions;
-- balances are fixture rows funded through kma_internal.program_balance_post; most sales are
-- inserted directly, and some go through record_program_sale and record_program_sale_event.
--
-- The commission of a sale is worked out when the transaction that changed the sale commits.
-- This suite is one transaction, so pg_temp.flush() stands for that commit.
begin;
set local time zone 'UTC';
create temporary table commission_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program commission assertion failed: %', label; end if;
  insert into commission_assertions values (label);
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
create function pg_temp.t(k text) returns text language sql as $$ select value from qa where key = k $$;
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
-- Runs one statement the way an edge function does: as the service role, nobody signed in.
create function pg_temp.service(statement text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  execute statement into result;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- Prints one function result as the front ends receive it (kept by KMA_DB_TEST_OUTPUT).
create function pg_temp.capture(name text, result jsonb) returns text language sql as $$
  select 'capture ' || name || ' ' || result::text
$$;
-- What the end of the writing transaction does: the deferred commission triggers run.
create function pg_temp.flush() returns void language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end $$;
create function pg_temp.ago(p interval) returns timestamptz language sql as $$
  select date_trunc('second', now()) - p
$$;
create function pg_temp.epoch(p_at timestamptz) returns bigint language sql as $$
  select extract(epoch from p_at)::bigint
$$;
-- Counts rows as they are now, also inside a statement that changed them earlier.
create function pg_temp.n(rows_of text) returns bigint language plpgsql as $$
declare result bigint;
begin
  execute 'select count(*) from ' || rows_of into result;
  return result;
end $$;

-- Programs -------------------------------------------------------------------------------------
create function pg_temp.program(workspace text) returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q(workspace)
$$;
create function pg_temp.connect(workspace text, account text, business text) returns void language plpgsql as $$
declare v_business uuid;
begin
  insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
  select business, 'billing@' || workspace || '.example', w.created_by, w.id
  from public.analytics_workspaces w where w.id = pg_temp.q(workspace) returning id into v_business;
  insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status, business_name,
    country, charges_enabled, details_submitted, confirmed_at, verified_at)
  values (v_business, 'acct_KMAPlatform', true, account, 'active', business, 'GB', true, true, now(), now());
end $$;
create function pg_temp.save(who text, workspace text, input jsonb) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_program_save(%L, %L)', pg_temp.q(workspace),
    input || case when (pg_temp.program(workspace)).id is null then '{}'::jsonb
      else jsonb_build_object('revision', (pg_temp.program(workspace)).revision) end))
$$;
create function pg_temp.read_agreement(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_program_mark_agreement_read(%L, %L)', pg_temp.q(workspace),
    pg_temp.call(who, format('select public.workspace_program_agreement(%L)', pg_temp.q(workspace)))->>'sha256'))
$$;
create function pg_temp.submit_sql(workspace text) returns text language sql as $$
  select format('select public.workspace_program_submit(%L, %s)', pg_temp.q(workspace), (pg_temp.program(workspace)).revision)
$$;
create function pg_temp.approve_sql(workspace text) returns text language sql as $$
  select format('select public.review_admin_program(%L)',
    jsonb_build_object('program_id', (pg_temp.program(workspace)).id, 'decision', 'approve'))
$$;
-- The merchant saves the form, reads the agreement and publishes; KissMyApps approves a
-- first listing. On a live program this publishes the next version of the terms.
create function pg_temp.publish(who text, workspace text, input jsonb) returns void language plpgsql as $$
begin
  perform pg_temp.save(who, workspace, input);
  perform pg_temp.read_agreement(who, workspace);
  perform pg_temp.call(who, pg_temp.submit_sql(workspace));
  if (pg_temp.program(workspace)).status = 'in_review' then
    perform pg_temp.call('kma_owner', pg_temp.approve_sql(workspace));
  end if;
end $$;
create function pg_temp.status_sql(workspace text, new_status text) returns text language sql as $$
  select format('select public.workspace_program_set_status(%L, %L, %s)', pg_temp.q(workspace), new_status,
    (pg_temp.program(workspace)).revision)
$$;
create function pg_temp.state(workspace text) returns text language sql as $$
  select p.status || coalesce(':' || p.pause_reason, '') from pg_temp.program(workspace) p
$$;

-- Creators ---------------------------------------------------------------------------------------
create function pg_temp.join(creator text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(creator, format('select public.partner_program_join(%L)', jsonb_build_object(
    'slug', p.slug, 'terms_version', t.version, 'agreement_sha256', t.agreement_sha256)))
  from pg_temp.program(workspace) p
  join public.affiliate_program_terms t on t.program_id = p.id and t.version = p.live_terms_version
$$;
create function pg_temp.member(creator text, workspace text) returns public.affiliate_program_members language sql as $$
  select m from public.affiliate_program_members m
  where m.program_id = (pg_temp.program(workspace)).id and m.affiliate_id = pg_temp.q('creator_' || creator)
$$;
-- A visitor opens the creator's link: the click id the redirect function gets back.
create function pg_temp.click(creator text, workspace text) returns text language plpgsql as $$
declare
  v_slug text;
  v_code text;
  result text;
begin
  select a.slug, l.public_code into v_slug, v_code
  from public.affiliate_links l join public.affiliates a on a.id = l.affiliate_id
  where l.id = (pg_temp.member(creator, workspace)).main_link_id;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select r.click_id into result from public.register_tracking_click(v_slug, v_code, '{}'::jsonb) r;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;

-- Balances (fixtures: the balance functions belong to another migration) ----------------------
create function pg_temp.account(workspace text) returns public.program_balance_accounts language sql as $$
  select a from public.program_balance_accounts a where a.program_id = (pg_temp.program(workspace)).id
$$;
create function pg_temp.available(workspace text) returns bigint language sql as $$
  select a.available_minor from public.program_balance_accounts a where a.program_id = (pg_temp.program(workspace)).id
$$;
create function pg_temp.open_account(workspace text) returns void language sql as $$
  insert into public.program_balance_accounts(program_id, workspace_id, currency)
  select p.id, p.workspace_id, 'USD' from pg_temp.program(workspace) p
$$;
-- A deposit that Stripe confirmed.
create function pg_temp.fund(workspace text, amount bigint) returns void language plpgsql as $$
declare v_topup uuid;
begin
  insert into public.program_topups(account_id, kind, amount_minor, currency, status, settled_at)
  values ((pg_temp.account(workspace)).id, 'deposit', amount, 'USD', 'succeeded', now()) returning id into v_topup;
  perform kma_internal.program_balance_post((pg_temp.account(workspace)).id, 'deposit', amount, v_topup);
end $$;
create function pg_temp.money(enabled boolean) returns void language sql as $$
  update public.platform_settings set program_money_enabled = enabled where singleton
$$;

-- Sales ------------------------------------------------------------------------------------------
-- A verified sale, as record_program_sale leaves one, followed by the end of its transaction.
-- extra: currency, tax_minor, refunded_minor, status, subscription, sequence, first (the key
-- of the subscription's first sale), created_at.
create function pg_temp.sale(k text, workspace text, creator text, amount bigint, paid timestamptz, extra jsonb default '{}')
returns void language plpgsql as $$
declare
  p public.affiliate_programs := pg_temp.program(workspace);
  v_click public.clicks;
  v_id uuid := gen_random_uuid();
begin
  select * into v_click from public.clicks where id = pg_temp.q('click_' || creator);
  insert into public.program_sales(id, program_id, connection_id, account_id, payment_intent_id, amount_minor, currency,
      tax_minor, refunded_minor, status, paid_at, click_id, click_record_id, affiliate_id, match_source,
      subscription_id, subscription_sequence, first_sale_id, created_at)
    select v_id, p.id, c.id, c.account_id, 'pi_' || k, amount, coalesce(extra->>'currency', 'USD'),
      (extra->>'tax_minor')::bigint, coalesce((extra->>'refunded_minor')::bigint, 0), coalesce(extra->>'status', 'paid'), paid,
      v_click.public_click_id, v_click.id, v_click.affiliate_id, case when v_click.id is null then 'none' else 'metadata' end,
      extra->>'subscription', (extra->>'sequence')::integer, pg_temp.q(extra->>'first'),
      coalesce((extra->>'created_at')::timestamptz, now())
    from public.merchant_connections c join public.merchant_businesses b on b.id = c.merchant_id
    where b.workspace_id = p.workspace_id;
  insert into qa values (k, v_id);
  perform pg_temp.flush();
end $$;
-- Stripe now reports this much of the payment refunded.
create function pg_temp.refund(k text, total bigint) returns void language plpgsql as $$
begin
  update public.program_sales set refunded_minor = total where id = pg_temp.q(k);
  perform kma_internal.program_sale_refresh_status(pg_temp.q(k));
  perform pg_temp.flush();
end $$;
-- The sale is matched to another creator, or to nobody.
create function pg_temp.rematch(k text, creator text) returns void language plpgsql as $$
declare v_click public.clicks;
begin
  select * into v_click from public.clicks where id = pg_temp.q('click_' || creator);
  update public.program_sales set click_id = v_click.public_click_id, click_record_id = v_click.id,
    affiliate_id = v_click.affiliate_id, match_source = case when v_click.id is null then 'none' else 'metadata' end
  where id = pg_temp.q(k);
  perform pg_temp.flush();
end $$;
create function pg_temp.com(k text) returns public.program_commissions language sql as $$
  select c from public.program_commissions c where c.sale_id = pg_temp.q(k)
$$;
-- A sale's commission in one word: none, not_earned:<reason>, or <status> <commission>+<fee>.
create function pg_temp.c(k text) returns text language sql as $$
  select coalesce((select case when c.status = 'not_earned' then 'not_earned:' || c.reason
      else c.status || ' ' || c.amount_minor || '+' || c.fee_minor end
    from public.program_commissions c where c.sale_id = pg_temp.q(k)), 'none')
$$;
-- The balance entries of one kind for a sale's commission: <how many>x<their sum>.
create function pg_temp.moved(k text, p_kind text) returns text language sql as $$
  select count(*) || 'x' || coalesce(sum(e.amount_minor), 0) from public.program_balance_entries e
  where e.commission_id = (pg_temp.com(k)).id and e.kind = p_kind
$$;
-- The creator's entries of one kind for a sale's commission, the same way.
create function pg_temp.credited(k text, p_kind text) returns text language sql as $$
  select count(*) || 'x' || coalesce(sum(e.amount_minor), 0) from public.program_creator_entries e
  where e.commission_id = (pg_temp.com(k)).id and e.kind = p_kind
$$;
create function pg_temp.owed(creator text, workspace text) returns bigint language sql as $$
  select coalesce(sum(e.amount_minor), 0)::bigint from public.program_creator_entries e
  where e.affiliate_id = pg_temp.q('creator_' || creator) and e.program_id = (pg_temp.program(workspace)).id
$$;
create function pg_temp.tick(input jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.service(format('select public.program_commissions_tick(%L)', input))
$$;
-- How many held commissions the next tick may approve.
create function pg_temp.due() returns bigint language sql as $$
  select count(*) from public.program_commissions c join public.program_sales s on s.id = c.sale_id
  where c.status = 'held' and c.hold_until <= clock_timestamp() and s.status <> 'disputed'
$$;
-- The books: every balance is the sum of its entries and each entry carries the running
-- total; no commission or fee ever took a balance below zero; every commission agrees with
-- its entries on both ledgers; what a merchant paid in is what is available plus what
-- commissions hold or have passed on.
create function pg_temp.books() returns boolean language sql as $$
  select (select coalesce(bool_and(a.available_minor = coalesce((select sum(e.amount_minor)
        from public.program_balance_entries e where e.account_id = a.id), 0)), true)
      from public.program_balance_accounts a)
    and not exists (select 1 from public.program_balance_entries e
      where e.kind in ('commission_reserved', 'fee_reserved') and e.available_after_minor < 0)
    and (select coalesce(bool_and(-(c.amount_minor + c.fee_minor) = coalesce((select sum(e.amount_minor)
          from public.program_balance_entries e where e.commission_id = c.id), 0)
        and (case when c.status = 'approved' then c.amount_minor else 0 end) = coalesce((select sum(e.amount_minor)
          from public.program_creator_entries e where e.commission_id = c.id), 0)
        and (c.status in ('held', 'approved') or c.amount_minor + c.fee_minor = 0)), true)
      from public.program_commissions c)
    and (select coalesce(bool_and(a.available_minor = coalesce((select sum(e.amount_minor)
          from public.program_balance_entries e where e.account_id = a.id and e.topup_id is not null), 0)
        - coalesce((select sum(c.amount_minor + c.fee_minor) from public.program_commissions c
          where c.program_id = a.program_id), 0)), true)
      from public.program_balance_accounts a)
$$;

-- The worker's calls, for the sales that go through the real functions ------------------------
create function pg_temp.receipt(p_event text, p_type text, p_object text, p_intent text, p_account text,
  p_tag text default null) returns jsonb language sql as $$
  select public.record_merchant_payment_event(jsonb_build_object(
    'platform_account_id', 'acct_KMAPlatform', 'livemode', true, 'account_id', p_account,
    'event_id', p_event, 'event_type', p_type, 'event_created', pg_temp.epoch(now()),
    'object_id', p_object, 'payment_intent_id', p_intent, 'amount_minor', 4900, 'currency', 'usd',
    'kma_click', p_tag, 'tag_source', case when p_tag is not null then 'metadata' end, 'payload_sha256', repeat('a', 64)))
$$;
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
-- A payment becomes a sale through record_program_sale, called as the service role. The
-- commission triggers have not run when this returns: the caller flushes.
create function pg_temp.pay(k text, p_account text, p_tag text, p_paid timestamptz, overrides jsonb default '{}',
  p_type text default 'payment_intent.succeeded', p_event text default null) returns jsonb language plpgsql as $$
declare
  v jsonb;
  v_event text := coalesce(p_event, 'evt_' || k);
begin
  perform pg_temp.receipt(v_event, p_type, case when p_type = 'invoice.paid' then 'in_' || k else 'pi_' || k end,
    case when p_type = 'invoice.paid' then null else 'pi_' || k end, p_account, p_tag);
  v := pg_temp.service(format('select public.record_program_sale(%L)', pg_temp.ref(v_event) || jsonb_build_object(
    'livemode', true, 'payment_intent_id', 'pi_' || k, 'charge_id', 'ch_' || k, 'amount_minor', 4900, 'currency', 'usd',
    'refunded_minor', 0, 'paid_at', pg_temp.epoch(p_paid), 'kma_click', p_tag,
    'tag_source', case when p_tag is not null then 'metadata' end) || overrides));
  perform public.finish_program_sale_receipt(pg_temp.ref(v_event) || '{"action":"done","code":"recorded"}');
  insert into qa values (k, v->>'sale_id') on conflict (key) do nothing;
  return v;
end $$;
-- A dispute of that sale reaches the given state, through record_program_sale_event.
create function pg_temp.dispute(k text, p_account text, p_state text) returns jsonb language plpgsql as $$
declare
  v jsonb;
  v_event text := 'evt_' || k || '_' || p_state;
begin
  perform pg_temp.receipt(v_event, case when p_state = 'open' then 'charge.dispute.created' else 'charge.dispute.closed' end,
    'dp_' || k, 'pi_' || k, p_account);
  v := pg_temp.service(format('select public.record_program_sale_event(%L)', pg_temp.ref(v_event) || jsonb_build_object(
    'payment_intent_id', 'pi_' || k, 'events', jsonb_build_array(jsonb_build_object('kind', 'dispute',
      'stripe_object_id', 'dp_' || k, 'state', p_state, 'amount_minor', 4900, 'currency', 'usd',
      'occurred_at', pg_temp.epoch(now()))))));
  perform public.finish_program_sale_receipt(pg_temp.ref(v_event) || '{"action":"done","code":"recorded"}');
  perform pg_temp.flush();
  return v;
end $$;
-- A disposable test cluster made without UTF-8 cannot run normalize(), which the readable
-- link address uses. On such a cluster (and only inside this rolled-back transaction) the
-- same rule runs without it.
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
grant all on qa, commission_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- People ---------------------------------------------------------------------------------------
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('f9000000-0000-4000-8000-000000000001', 'owner@speaksix.com', now(), '{"company":"SpeakSix"}'),
  ('f9000000-0000-4000-8000-000000000002', 'owner@rival.co', now(), '{"company":"Rival"}'),
  ('f9000000-0000-4000-8000-000000000003', 'owner@quiet.co', now(), '{"company":"Quiet"}'),
  ('f9000000-0000-4000-8000-000000000004', 'owner@fresh.co', now(), '{"company":"Fresh"}'),
  ('f9000000-0000-4000-8000-000000000011', 'owner@kissmyapps.dev', now(), '{}'),
  ('f9000000-0000-4000-8000-000000000012', 'operations@kissmyapps.dev', now(), '{}'),
  ('f9000000-0000-4000-8000-000000000021', 'ada@creators.example', now(), '{}'),
  ('f9000000-0000-4000-8000-000000000022', 'ben@creators.example', now(), '{}'),
  ('f9000000-0000-4000-8000-000000000023', 'cy@creators.example', now(), '{}'),
  ('f9000000-0000-4000-8000-000000000024', 'dee@creators.example', now(), '{}'),
  ('f9000000-0000-4000-8000-000000000026', 'stranger@elsewhere.co', now(), '{}');
insert into qa values
  ('owner', 'f9000000-0000-4000-8000-000000000001'), ('rival_owner', 'f9000000-0000-4000-8000-000000000002'),
  ('quiet_owner', 'f9000000-0000-4000-8000-000000000003'), ('fresh_owner', 'f9000000-0000-4000-8000-000000000004'),
  ('kma_owner', 'f9000000-0000-4000-8000-000000000011'), ('kma_operations', 'f9000000-0000-4000-8000-000000000012'),
  ('ada', 'f9000000-0000-4000-8000-000000000021'), ('ben', 'f9000000-0000-4000-8000-000000000022'),
  ('cy', 'f9000000-0000-4000-8000-000000000023'), ('dee', 'f9000000-0000-4000-8000-000000000024'),
  ('stranger', 'f9000000-0000-4000-8000-000000000026'),
  ('creator_ada', 'fa000000-0000-4000-8000-000000000001'), ('creator_ben', 'fa000000-0000-4000-8000-000000000002'),
  ('creator_cy', 'fa000000-0000-4000-8000-000000000003'), ('creator_dee', 'fa000000-0000-4000-8000-000000000004');
insert into public.admin_users(user_id, role) values
  (pg_temp.q('kma_owner'), 'owner'), (pg_temp.q('kma_operations'), 'operations');
insert into public.affiliates(id, public_name, legal_name, slug, status) values
  (pg_temp.q('creator_ada'), 'Ada Okafor', 'Ada N. Okafor', 'ada-okafor', 'active'),
  (pg_temp.q('creator_ben'), 'Ben Creator', null, 'ben-creator', 'active'),
  (pg_temp.q('creator_cy'), 'Cy Park', null, 'cy-park', 'active'),
  (pg_temp.q('creator_dee'), 'Dee Vale', null, 'dee-vale', 'active');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at) values
  (pg_temp.q('creator_ada'), pg_temp.q('ada'), 'owner', true, false, now()),
  (pg_temp.q('creator_ben'), pg_temp.q('ben'), 'owner', true, false, now()),
  (pg_temp.q('creator_cy'), pg_temp.q('cy'), 'owner', true, false, now()),
  (pg_temp.q('creator_dee'), pg_temp.q('dee'), 'owner', true, false, now());
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true,
    program_money_enabled = false, program_fee_bps = 1000, program_min_deposit_minor = 5000;

-- Workspaces and programs, published while program money is still off --------------------------
select pg_temp.sign_in('owner');
insert into qa select 'acme', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('rival_owner');
insert into qa select 'rival', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('quiet_owner');
insert into qa select 'quiet', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('fresh_owner');
insert into qa select 'fresh', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
select pg_temp.connect('acme', 'acct_SpeakSix', 'SpeakSix Ltd');
select pg_temp.connect('rival', 'acct_Rival', 'Rival Media');
select pg_temp.connect('quiet', 'acct_Quiet', 'Quiet Club');
select pg_temp.connect('fresh', 'acct_Fresh', 'Fresh Start');

-- SpeakSix: 30% of every payment for 12 months, held 30 days. Rival Reader: $5.00 on the
-- first payment. Quiet Club: 20% of every payment, held 14 days.
select pg_temp.publish('owner', 'acme', '{"name":"SpeakSix","category":"education","tagline":"Speak English in six weeks.",
  "landing_url":"https://speaksix.com/start","commission_type":"percent","commission_rate_bps":3000,
  "commission_duration":"months","commission_months":12}');
select pg_temp.publish('rival_owner', 'rival', '{"name":"Rival Reader","category":"entertainment","tagline":"Stories worth an evening.",
  "landing_url":"https://rivalreader.co/","commission_type":"fixed","commission_fixed_minor":500,
  "commission_duration":"first_payment"}');
select pg_temp.publish('quiet_owner', 'quiet', '{"name":"Quiet Club","category":"lifestyle","tagline":"A calmer phone.",
  "landing_url":"https://quietclub.io/join","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"lifetime","hold_days":14}');
select pg_temp.check(pg_temp.state('acme') = 'live' and pg_temp.state('rival') = 'live' and pg_temp.state('quiet') = 'live'
  and pg_temp.n('public.program_balance_accounts') = 0,
  'while program money is off a program is reviewed and goes live with no balance at all');

-- Creators join; each has one click. Ada is in all three programs.
select pg_temp.check(pg_temp.join(j.creator, j.workspace)->'membership'->>'status' = 'active',
  format('%s joins %s', j.creator, j.workspace))
from (values ('ada', 'acme'), ('ada', 'rival'), ('ada', 'quiet'), ('ben', 'acme'), ('cy', 'quiet')) j(creator, workspace);
insert into qa values ('tag_ada', pg_temp.click('ada', 'acme')), ('tag_ada_rival', pg_temp.click('ada', 'rival')),
  ('tag_ben', pg_temp.click('ben', 'acme')), ('tag_cy', pg_temp.click('cy', 'quiet'));
insert into qa select 'click_' || substr(q.key, 5), k.id from qa q join public.clicks k on k.public_click_id = q.value
  where q.key like 'tag\_%';
-- They joined long ago: a sale counts for a member only from the moment they became one.
update public.affiliate_program_members set activated_at = pg_temp.ago('500 days');
-- Dee asked to join SpeakSix 100 days ago and accepted its first terms 60 days ago.
insert into public.affiliate_program_members(program_id, affiliate_id, status, terms_version, joined_by, requested_at)
  select p.id, pg_temp.q('creator_dee'), 'pending', 1, pg_temp.q('dee'), pg_temp.ago('100 days') from pg_temp.program('acme') p;
insert into public.affiliate_program_acceptances(member_id, program_id, terms_version, agreement_sha256, accepted_by, accepted_name, accepted_at)
  select m.id, m.program_id, 1, t.agreement_sha256, pg_temp.q('dee'), 'Dee Vale', pg_temp.ago('60 days')
  from pg_temp.member('dee', 'acme') m join public.affiliate_program_terms t on t.program_id = m.program_id and t.version = 1;
select pg_temp.check(pg_temp.call('owner', format('select public.workspace_program_creator_decide(%L, %L)', pg_temp.q('acme'),
  jsonb_build_object('member_id', (pg_temp.member('dee', 'acme')).id, 'action', 'approve')))->'creator'->>'status' = 'active',
  'the merchant lets Dee in');
update public.affiliate_program_members set activated_at = pg_temp.ago('100 days') where id = (pg_temp.member('dee', 'acme')).id;
insert into qa values ('tag_dee', pg_temp.click('dee', 'acme'));
insert into qa select 'click_dee', k.id from public.clicks k where k.public_click_id = pg_temp.t('tag_dee');
select set_config('request.jwt.claims', '', true);
select pg_temp.check(pg_temp.n('public.affiliate_program_members where status = ''active''') = 6
  and pg_temp.n('qa where key like ''click\_%''') = 5, 'six active memberships and a click for each creator');

-- Closed by default ----------------------------------------------------------------------------
select pg_temp.check((select bool_and(not has_table_privilege(r, t, p))
  from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['public.program_commissions', 'public.program_commission_retries', 'public.program_balance_entries',
      'public.program_creator_entries', 'public.program_balance_accounts']) t,
    unnest(array['select', 'insert', 'update', 'delete']) p)
  and (select relrowsecurity from pg_class where oid = 'public.program_commission_retries'::regclass)
  and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'program_commission_retries'),
  'no API role can read or write commissions, retries or either ledger; the retry table has row security and no policy');
select pg_temp.check((select count(*) = 3 and bool_and(has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute')
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('partner_program_earnings', 'get_admin_program_money', 'configure_admin_program_money')),
  'signed-in users may call the creator read and the two admin functions; each is security definer with an empty search path');
select pg_temp.check((select count(*) = 1 and bool_and(has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'program_commissions_tick'),
  'only the service role may run the tick');
select pg_temp.check((select count(*) >= 16 and bool_and(not has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'kma_internal' and (p.proname like 'program\_commission%' or p.proname like 'program\_money%'
    or p.proname in ('program_require_balance', 'program_creator_lock', 'program_balance_post'))),
  'the internal commission functions are closed to every API role');
select pg_temp.check((select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p where p.oid in ('kma_internal.program_commission_sync(uuid)'::regprocedure,
    'kma_internal.program_commission_changed()'::regprocedure, 'kma_internal.program_require_balance()'::regprocedure)),
  'the sync and the trigger functions run as their owner with an empty search path');
select pg_temp.check(pg_temp.try_signed_out(r, s) = '42501', format('%s cannot run %s', r, left(s, 60)))
from unnest(array['anon', 'authenticated']) r, unnest(array[
  'select public.program_commissions_tick(''{}'')', 'select public.partner_program_earnings()',
  'select public.configure_admin_program_money(''{}'')',
  format('select kma_internal.program_commission_sync(%L)', gen_random_uuid()),
  format('select kma_internal.program_commission_apply(%L)', gen_random_uuid())]) s
where not (r = 'authenticated' and s like '%configure_admin%');
select pg_temp.check(pg_temp.try_signed_out('anon', 'select public.get_admin_program_money()') = '42501'
  and pg_temp.try_signed_out('authenticated', 'select public.get_admin_program_money()') = '28000'
  and pg_temp.try_signed_out('authenticated', 'select public.configure_admin_program_money(''{}'')') = '28000'
  and pg_temp.try_signed_out('service_role', 'select public.get_admin_program_money()') = '42501'
  and pg_temp.try_signed_out('service_role', 'select public.partner_program_earnings()') = '42501'
  and pg_temp.try_signed_out('service_role', format('select kma_internal.program_commission_sync(%L)', gen_random_uuid())) = '42501'
  and pg_temp.try_signed_out('service_role', 'select kma_internal.program_money_json()') = '42501',
  'signed-out, anonymous and service-role calls of the creator, admin and internal functions are refused');

-- Program money off: nothing is judged -----------------------------------------------------------
select pg_temp.sale('pre', 'acme', 'ada', 4900, pg_temp.ago('3 days'),
  jsonb_build_object('created_at', pg_temp.ago('1 day')));
select pg_temp.check(pg_temp.c('pre') = 'none' and pg_temp.n('public.program_commissions') = 0
  and pg_temp.n('public.program_commission_retries') = 0,
  'while program money is off a sale credited to a creator gets no commission row');
select kma_internal.program_commission_sync(pg_temp.q('pre'));
select pg_temp.check(pg_temp.c('pre') = 'none', 'the sync itself does nothing while program money is off');
select pg_temp.check(pg_temp.tick() = '{"approved":0,"retried":0,"remaining":0}'::jsonb,
  'the tick does nothing while program money is off');

-- The admin switch -------------------------------------------------------------------------------
select pg_temp.capture('admin_program_money_off', pg_temp.call('kma_operations', 'select public.get_admin_program_money()'));
insert into qa select 'settings_at', pg_temp.call('kma_owner', 'select public.get_admin_program_money()')->>'updated_at';
select pg_temp.check((select m - 'updated_at' = '{"enabled":false,"fee_bps":1000,"min_deposit_minor":5000,
      "programs_with_balance":0,"available_minor_by_currency":{},"reserved_minor_by_currency":{},
      "owed_to_creators_minor_by_currency":{}}'::jsonb
      and (m->>'updated_at')::timestamptz = (select updated_at from public.platform_settings)
    from pg_temp.call('kma_operations', 'select public.get_admin_program_money()') m),
  'staff read the switch, the fee, the smallest first deposit and empty totals');
select pg_temp.check(pg_temp.try('stranger', 'select public.get_admin_program_money()') = '42501'
  and pg_temp.try('owner', 'select public.get_admin_program_money()') = '42501'
  and pg_temp.try('kma_operations', format('select public.configure_admin_program_money(%L)',
    jsonb_build_object('enabled', true, 'expected_updated_at', pg_temp.t('settings_at')))) = '42501'
  and pg_temp.try('owner', format('select public.configure_admin_program_money(%L)',
    jsonb_build_object('enabled', true, 'expected_updated_at', pg_temp.t('settings_at')))) = '42501',
  'only staff read program money and only the owner role changes it');
select pg_temp.check(pg_temp.try('kma_owner', format('select public.configure_admin_program_money(%L)', i)) = e,
  format('the switch refuses %s with %s', i, e))
from (values
  ('{"enabled":true}'::jsonb, '22023 invalid_input'),
  ('[]', '22023 invalid_input'),
  (jsonb_build_object('enabled', true, 'expected_updated_at', pg_temp.t('settings_at'), 'mode', 'live'), '22023 invalid_input'),
  (jsonb_build_object('enabled', 'yes', 'expected_updated_at', pg_temp.t('settings_at')), '22023 invalid_enabled'),
  (jsonb_build_object('fee_bps', 5001, 'expected_updated_at', pg_temp.t('settings_at')), '22023 invalid_fee_bps'),
  (jsonb_build_object('fee_bps', 10.5, 'expected_updated_at', pg_temp.t('settings_at')), '22023 invalid_fee_bps'),
  (jsonb_build_object('fee_bps', '1000', 'expected_updated_at', pg_temp.t('settings_at')), '22023 invalid_fee_bps'),
  (jsonb_build_object('min_deposit_minor', 99, 'expected_updated_at', pg_temp.t('settings_at')), '22023 invalid_min_deposit_minor'),
  (jsonb_build_object('min_deposit_minor', 100000001, 'expected_updated_at', pg_temp.t('settings_at')), '22023 invalid_min_deposit_minor'),
  (jsonb_build_object('enabled', true, 'expected_updated_at', 7), '22023 invalid_expected_updated_at'),
  (jsonb_build_object('enabled', true, 'expected_updated_at', 'yesterday-ish'), '22023 invalid_expected_updated_at'),
  (jsonb_build_object('enabled', true, 'expected_updated_at', null), '40001 settings_changed'),
  (jsonb_build_object('enabled', true, 'expected_updated_at', pg_temp.ago('1 hour')), '40001 settings_changed')) v(i, e);
select pg_temp.check((select not program_money_enabled and program_money_enabled_at is null from public.platform_settings),
  'a refused change leaves the switch off');
select pg_temp.capture('admin_program_money_on', pg_temp.call('kma_owner', format('select public.configure_admin_program_money(%L)',
  jsonb_build_object('enabled', true, 'fee_bps', 1200, 'min_deposit_minor', 2500, 'expected_updated_at', pg_temp.t('settings_at')))));
select pg_temp.check((select program_money_enabled and program_fee_bps = 1200 and program_min_deposit_minor = 2500
      and program_money_enabled_at = now() and updated_at > pg_temp.t('settings_at')::timestamptz
    from public.platform_settings)
  and pg_temp.try('kma_owner', format('select public.configure_admin_program_money(%L)',
    jsonb_build_object('fee_bps', 900, 'expected_updated_at', pg_temp.t('settings_at')))) = '40001 settings_changed',
  'the owner switches program money on and sets the fee and the smallest deposit; the old read can no longer save');
-- A key that is left out keeps its value.
select pg_temp.check((select m @> '{"enabled":true,"fee_bps":1000,"min_deposit_minor":2500}'
    from pg_temp.call('kma_owner', format('select public.configure_admin_program_money(%L)', jsonb_build_object('fee_bps', 1000,
      'expected_updated_at', (select updated_at from public.platform_settings)))) m),
  'the owner changes the fee alone; the switch and the smallest deposit stay');
select pg_temp.check((select m @> '{"enabled":true,"fee_bps":1000,"min_deposit_minor":5000}'
    from pg_temp.call('kma_owner', format('select public.configure_admin_program_money(%L)', jsonb_build_object('min_deposit_minor', 5000,
      'expected_updated_at', (select updated_at from public.platform_settings)))) m),
  'the owner changes the smallest deposit alone; the switch and the fee stay');
select pg_temp.check((select count(*) = 3 and bool_and(a.actor_type = 'admin' and a.actor_user_id = pg_temp.q('kma_owner')
      and a.before_data ?& array['enabled', 'fee_bps', 'min_deposit_minor'] and a.after_data ?& array['enabled', 'fee_bps', 'min_deposit_minor'])
      and bool_or(a.before_data->>'enabled' = 'false' and a.after_data->>'enabled' = 'true')
    from public.audit_logs a where a.action = 'program_money_configured' and a.target_table = 'platform_settings'),
  'every change of the switch is in the audit log with who made it, before and after');
select set_config('request.jwt.claims', '', true);

-- A sale recorded before the switch is never judged -----------------------------------------------
select pg_temp.refund('pre', 1000);
select kma_internal.program_commission_sync(pg_temp.q('pre'));
select pg_temp.check(pg_temp.c('pre') = 'none' and pg_temp.n('public.program_commission_retries') = 0,
  'a sale recorded before the switch was turned on gets no commission when it changes later');

-- A program needs money in its balance to publish ------------------------------------------------
select from pg_temp.save('fresh_owner', 'fresh', '{"name":"Fresh Start","category":"productivity","tagline":"A cleaner morning.",
  "landing_url":"https://freshstart.io/","commission_type":"percent","commission_rate_bps":2500,"commission_duration":"lifetime"}');
select from pg_temp.read_agreement('fresh_owner', 'fresh');
select pg_temp.check(pg_temp.try('fresh_owner', pg_temp.submit_sql('fresh')) = '22023 balance_required'
  and pg_temp.state('fresh') = 'draft', 'with program money on, a program with no balance cannot be sent for review');
select from pg_temp.open_account('fresh');
select pg_temp.check(pg_temp.try('fresh_owner', pg_temp.submit_sql('fresh')) = '22023 balance_required',
  'a balance with nothing in it is not enough to publish');
select from pg_temp.fund('fresh', 5000);
select pg_temp.check(pg_temp.try('fresh_owner', pg_temp.submit_sql('fresh')) = 'ok' and pg_temp.state('fresh') = 'in_review',
  'after the first deposit the program goes to review');
-- The deposit is taken back before the review (fixture: an adjustment of the whole balance).
select from kma_internal.program_balance_post((pg_temp.account('fresh')).id, 'adjustment', -5000, null, null, 'fixture');
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.approve_sql('fresh')) = '22023 balance_required'
  and pg_temp.state('fresh') = 'in_review', 'a program whose balance is empty again cannot be approved into live');
select from kma_internal.program_balance_post((pg_temp.account('fresh')).id, 'adjustment', 5000, null, null, 'fixture');
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.approve_sql('fresh')) = 'ok' and pg_temp.state('fresh') = 'live',
  'with money in the balance the review makes it live');
select pg_temp.check(pg_temp.try('fresh_owner', pg_temp.status_sql('fresh', 'paused')) = 'ok'
  and pg_temp.try('fresh_owner', pg_temp.status_sql('fresh', 'live')) = 'ok' and pg_temp.state('fresh') = 'live',
  'pausing never needs a balance, and resuming with money in the balance works');
select set_config('request.jwt.claims', '', true);

-- No balance at all: the sale earns nothing and the program pauses -------------------------------
select pg_temp.sale('r_empty', 'rival', 'ada', 4900, pg_temp.ago('5 days'));
select pg_temp.check(pg_temp.c('r_empty') = 'not_earned:balance_empty' and pg_temp.state('rival') = 'paused:balance_empty'
  and (select c.member_id = (pg_temp.member('ada', 'rival')).id and c.terms_version = 1 and c.earned_minor = 0
      and c.hold_until is null and c.currency = 'USD' from pg_temp.com('r_empty') c)
  and pg_temp.n('public.program_balance_entries') = 3,
  'a sale of a live program that has no balance earns nothing, moves no money and pauses the program');
select pg_temp.check((select count(*) = 1 and bool_and(a.actor_type = 'system' and a.actor_user_id is null
      and a.before_data->>'status' = 'live' and a.after_data->>'status' = 'paused'
      and a.after_data->>'pause_reason' = 'balance_empty' and a.after_data ? 'revision')
    from public.audit_logs a where a.action = 'affiliate_program_balance_paused'
      and a.target_table = 'affiliate_programs' and a.target_id = (pg_temp.program('rival')).id),
  'the pause is in the audit log like the other pauses');
select pg_temp.check(pg_temp.try('rival_owner', pg_temp.status_sql('rival', 'live')) = '22023 balance_required'
  and pg_temp.state('rival') = 'paused:balance_empty', 'the merchant cannot resume a program whose balance is empty');
select from pg_temp.open_account('rival');
select from pg_temp.fund('rival', 100000);
select pg_temp.check(pg_temp.try('rival_owner', pg_temp.status_sql('rival', 'live')) = 'ok' and pg_temp.state('rival') = 'live',
  'once money is in the balance the program can be resumed');
select kma_internal.program_commission_sync(pg_temp.q('r_empty'));
select pg_temp.check(pg_temp.c('r_empty') = 'not_earned:balance_empty' and pg_temp.available('rival') = 100000,
  'the sale that found the balance empty stays unearned after money arrives');
select set_config('request.jwt.claims', '', true);

-- Percent, tax and the reasons a sale earns nothing ----------------------------------------------
select from pg_temp.open_account('acme') a, pg_temp.open_account('quiet') b;
select from pg_temp.fund('acme', 100000) a, pg_temp.fund('quiet', 1000) b;
select pg_temp.sale('a1', 'acme', 'ada', 4900, pg_temp.ago('5 days'));
select pg_temp.check(pg_temp.c('a1') = 'held 1470+147'
  and (select c.program_id = (pg_temp.program('acme')).id and c.affiliate_id = pg_temp.q('creator_ada')
      and c.member_id = (pg_temp.member('ada', 'acme')).id and c.terms_version = 1 and c.currency = 'USD'
      and c.basis_minor = 4900 and c.commission_type = 'percent' and c.commission_rate_bps = 3000
      and c.commission_fixed_minor is null and c.fee_bps = 1000 and c.earned_minor = 1470 and c.fee_earned_minor = 147
      and c.hold_until = pg_temp.ago('5 days') + interval '30 days' and c.approved_at is null and c.reversed_at is null
    from pg_temp.com('a1') c),
  '30% of a $49.00 sale is $14.70, with a 10% fee of $1.47 on top, held for the 30 days of the terms');
select pg_temp.check(pg_temp.moved('a1', 'commission_reserved') = '1x-1470' and pg_temp.moved('a1', 'fee_reserved') = '1x-147'
  and pg_temp.available('acme') = 98383
  and (select array_agg(e.available_after_minor order by e.available_after_minor desc) = array[98530, 98383]::bigint[]
    from public.program_balance_entries e where e.commission_id = (pg_temp.com('a1')).id),
  'commission and fee are set aside from the balance in two entries, each carrying the balance after it');
select pg_temp.sale('a_tax', 'acme', 'ada', 5900, pg_temp.ago('5 days'), '{"tax_minor":1000}');
select pg_temp.check(pg_temp.c('a_tax') = 'held 1470+147' and (pg_temp.com('a_tax')).basis_minor = 4900,
  'tax is not part of what commission is worked out on');
select pg_temp.sale('a_zero', 'acme', 'ada', 3, pg_temp.ago('5 days'));
select pg_temp.sale('a_alltax', 'acme', 'ada', 500, pg_temp.ago('5 days'), '{"tax_minor":500}');
select pg_temp.sale('a_refunded', 'acme', 'ada', 4900, pg_temp.ago('5 days'), '{"refunded_minor":4900,"status":"refunded"}');
select pg_temp.sale('a_none', 'acme', null, 4900, pg_temp.ago('5 days'));
select pg_temp.sale('a_nobody', 'acme', null, 4900, pg_temp.ago('5 days'));
select pg_temp.sale('a_cy', 'acme', 'cy', 4900, pg_temp.ago('5 days'));
select pg_temp.sale('a_eur', 'acme', 'ada', 4900, pg_temp.ago('5 days'), '{"currency":"EUR"}');
select pg_temp.check(pg_temp.c('a_zero') = 'not_earned:zero_amount' and pg_temp.c('a_alltax') = 'not_earned:zero_amount'
  and pg_temp.c('a_refunded') = 'not_earned:refunded' and pg_temp.c('a_none') = 'not_earned:no_creator'
  and pg_temp.c('a_nobody') = 'not_earned:no_creator'
  and pg_temp.c('a_cy') = 'not_earned:not_a_member' and pg_temp.c('a_eur') = 'not_earned:currency_mismatch'
  and (pg_temp.com('a_eur')).currency = 'EUR' and (pg_temp.com('a_none')).affiliate_id is null,
  'a commission of nothing, a refunded sale, a sale with no creator, a creator who is not a member and a sale in another '
    || 'currency each earn nothing, with the reason');
select pg_temp.check(pg_temp.available('acme') = 96766 and pg_temp.state('acme') = 'live'
  and (select count(*) = 0 from public.program_balance_entries e join public.program_commissions c on c.id = e.commission_id
    where c.status = 'not_earned'),
  'a sale that earns nothing moves no money and does not pause the program');

-- A creator found later ------------------------------------------------------------------------
select pg_temp.rematch('a_none', 'ada');
select pg_temp.check(pg_temp.c('a_none') = 'held 1470+147' and (pg_temp.com('a_none')).affiliate_id = pg_temp.q('creator_ada')
  and pg_temp.moved('a_none', 'commission_reserved') = '1x-1470' and pg_temp.available('acme') = 95149,
  'a sale with no creator is judged again from the top when it gets one');
select pg_temp.rematch('a_cy', 'ada');
select pg_temp.check(pg_temp.c('a_cy') = 'not_earned:not_a_member' and pg_temp.available('acme') = 95149,
  'every other reason is final: a sale that earned nothing for one creator does not earn for the next');

-- A fixed amount, and the first payment only ----------------------------------------------------
select pg_temp.sale('r1', 'rival', 'ada', 4900, pg_temp.ago('5 days'));
select pg_temp.sale('r_small', 'rival', 'ada', 300, pg_temp.ago('5 days'));
select pg_temp.sale('r_sub1', 'rival', 'ada', 4900, pg_temp.ago('40 days'), '{"subscription":"sub_rival","sequence":1}');
select pg_temp.sale('r_sub2', 'rival', 'ada', 4900, pg_temp.ago('10 days'), '{"subscription":"sub_rival","sequence":2,"first":"r_sub1"}');
select pg_temp.check(pg_temp.c('r1') = 'held 500+50'
  and (select c.commission_type = 'fixed' and c.commission_fixed_minor = 500 and c.commission_rate_bps is null and c.basis_minor = 4900
    from pg_temp.com('r1') c)
  and pg_temp.c('r_small') = 'held 300+30',
  'a fixed commission is its amount, and never more than the sale it is paid on');
select pg_temp.check(pg_temp.c('r_sub1') = 'held 500+50' and pg_temp.c('r_sub2') = 'not_earned:outside_duration'
  and pg_temp.available('rival') = 100000 - 550 - 330 - 550,
  'first payment only: a one-off sale and the first payment of a subscription earn, its renewal does not');

-- The balance cannot cover commission and fee ---------------------------------------------------
select pg_temp.sale('q_short', 'quiet', 'cy', 4900, pg_temp.ago('5 days'));
select pg_temp.check(pg_temp.c('q_short') = 'not_earned:balance_empty' and pg_temp.state('quiet') = 'paused:balance_empty'
  and pg_temp.available('quiet') = 1000 and pg_temp.moved('q_short', 'commission_reserved') = '0x0'
  and pg_temp.n(format('public.program_balance_entries where account_id = %L', (pg_temp.account('quiet')).id)) = 1
  and (select count(*) = 1 from public.audit_logs a where a.action = 'affiliate_program_balance_paused'
    and a.target_id = (pg_temp.program('quiet')).id),
  'a balance of $10.00 covers the $9.80 commission but not the fee with it: nothing is set aside, the sale earns nothing '
    || 'and the program pauses');
select from pg_temp.fund('quiet', 78);
select from pg_temp.call('quiet_owner', pg_temp.status_sql('quiet', 'live'));
select pg_temp.sale('q_exact', 'quiet', 'cy', 4900, pg_temp.ago('5 days'));
select pg_temp.check(pg_temp.c('q_exact') = 'held 980+98' and pg_temp.available('quiet') = 0 and pg_temp.state('quiet') = 'live'
  and (pg_temp.com('q_exact')).hold_until = pg_temp.ago('5 days') + interval '14 days',
  'a balance that covers commission and fee exactly is used to the last cent, and the program stays live');
select pg_temp.sale('q_next', 'quiet', 'cy', 100, pg_temp.ago('5 days'));
select pg_temp.check(pg_temp.c('q_next') = 'not_earned:balance_empty' and pg_temp.state('quiet') = 'paused:balance_empty'
  and pg_temp.available('quiet') = 0, 'the next sale finds the balance empty, earns nothing and pauses the program');
select pg_temp.sale('q_paused', 'quiet', 'cy', 4900, pg_temp.ago('5 days'));
select pg_temp.check(pg_temp.c('q_paused') = 'not_earned:program_paused',
  'a sale made while the program is paused earns nothing');
select pg_temp.check(pg_temp.try('quiet_owner', pg_temp.status_sql('quiet', 'live')) = '22023 balance_required',
  'a program paused for its balance cannot be resumed while the balance is empty');
select from pg_temp.fund('quiet', 100000);
select from pg_temp.call('quiet_owner', pg_temp.status_sql('quiet', 'live'));
select kma_internal.program_commission_sync(pg_temp.q('q_paused')), kma_internal.program_commission_sync(pg_temp.q('q_next'));
select pg_temp.check(pg_temp.c('q_paused') = 'not_earned:program_paused' and pg_temp.c('q_next') = 'not_earned:balance_empty'
  and pg_temp.available('quiet') = 100000, 'sales made while the program was paused or out of money stay unearned');
select set_config('request.jwt.claims', '', true);

-- The balance is in another currency than the sale ---------------------------------------------
update public.program_balance_accounts set currency = 'EUR' where id = (pg_temp.account('quiet')).id;
select pg_temp.sale('q_cur', 'quiet', 'cy', 4900, pg_temp.ago('5 days'));
update public.program_balance_accounts set currency = 'USD' where id = (pg_temp.account('quiet')).id;
select pg_temp.check(pg_temp.c('q_cur') = 'not_earned:currency_mismatch' and pg_temp.state('quiet') = 'live',
  'a program whose balance is in another currency than the sale earns nothing on it, without pausing');

-- The merchant paused the program ---------------------------------------------------------------
select from pg_temp.call('owner', pg_temp.status_sql('acme', 'paused'));
select pg_temp.sale('a_paused', 'acme', 'ada', 4900, pg_temp.ago('5 days'));
select from pg_temp.call('owner', pg_temp.status_sql('acme', 'live'));
select pg_temp.check(pg_temp.c('a_paused') = 'not_earned:program_paused' and pg_temp.state('acme') = 'live',
  'a sale recorded while the merchant has paused the program earns nothing');
select set_config('request.jwt.claims', '', true);

-- Every payment for 12 months, and every payment for ever ----------------------------------------
select pg_temp.sale('m1', 'acme', 'ada', 4900, pg_temp.ago('420 days'), '{"subscription":"sub_months","sequence":1}');
select pg_temp.sale('m_in', 'acme', 'ada', 4900, pg_temp.ago('420 days') + interval '12 months' - interval '1 second',
  '{"subscription":"sub_months","sequence":2,"first":"m1"}');
select pg_temp.sale('m_at', 'acme', 'ada', 4900, pg_temp.ago('420 days') + interval '12 months',
  '{"subscription":"sub_months","sequence":3,"first":"m1"}');
select pg_temp.sale('m_out', 'acme', 'ada', 4900, pg_temp.ago('10 days'), '{"subscription":"sub_months","sequence":4,"first":"m1"}');
select pg_temp.sale('m_single', 'acme', 'ada', 4900, pg_temp.ago('10 days'));
select pg_temp.check(pg_temp.c('m1') = 'held 1470+147' and pg_temp.c('m_in') = 'held 1470+147'
  and pg_temp.c('m_at') = 'not_earned:outside_duration' and pg_temp.c('m_out') = 'not_earned:outside_duration'
  and pg_temp.c('m_single') = 'held 1470+147',
  '12 months: the first payment and a renewal one second inside the window earn; a renewal at the end of the window or '
    || 'after it does not; a sale outside any subscription always earns');
select pg_temp.sale('q_l1', 'quiet', 'cy', 4900, pg_temp.ago('450 days'), '{"subscription":"sub_life","sequence":1}');
select pg_temp.sale('q_l15', 'quiet', 'cy', 4900, pg_temp.ago('5 days'), '{"subscription":"sub_life","sequence":15,"first":"q_l1"}');
select pg_temp.check(pg_temp.c('q_l1') = 'held 980+98' and pg_temp.c('q_l15') = 'held 980+98',
  'lifetime: a renewal more than a year after the first payment still earns');

-- The sale moves to another creator while its commission is held --------------------------------
select pg_temp.sale('x1', 'acme', 'ada', 4900, pg_temp.ago('5 days'));
insert into qa select 'acme_before_x1', pg_temp.available('acme') + 1617;
select pg_temp.rematch('x1', 'ben');
select pg_temp.check(pg_temp.c('x1') = 'held 1470+147' and (pg_temp.com('x1')).affiliate_id = pg_temp.q('creator_ben')
  and (pg_temp.com('x1')).member_id = (pg_temp.member('ben', 'acme')).id
  and pg_temp.moved('x1', 'commission_reserved') = '2x-2940' and pg_temp.moved('x1', 'commission_returned') = '1x1470'
  and pg_temp.moved('x1', 'fee_reserved') = '2x-294' and pg_temp.moved('x1', 'fee_returned') = '1x147'
  and pg_temp.available('acme') = pg_temp.t('acme_before_x1')::bigint - 1617
  and pg_temp.n(format('public.program_commissions where sale_id = %L', pg_temp.q('x1'))) = 1,
  'a held sale that moves to another member gives the money back and sets it aside again for them, in the same one row');
select pg_temp.rematch('x1', 'cy');
select pg_temp.check(pg_temp.c('x1') = 'not_earned:not_a_member' and (pg_temp.com('x1')).affiliate_id = pg_temp.q('creator_cy')
  and (select c.earned_minor = 0 and c.hold_until is null and c.member_id is null and c.fee_bps is null from pg_temp.com('x1') c)
  and pg_temp.moved('x1', 'commission_returned') = '2x2940' and pg_temp.moved('x1', 'fee_returned') = '2x294'
  and pg_temp.available('acme') = pg_temp.t('acme_before_x1')::bigint,
  'a held sale that moves to somebody who is not a member gives everything back and earns nothing');
select pg_temp.rematch('x1', 'ada');
select pg_temp.check(pg_temp.c('x1') = 'not_earned:not_a_member' and pg_temp.available('acme') = pg_temp.t('acme_before_x1')::bigint,
  'and that is final');
select pg_temp.sale('y1', 'acme', 'ada', 4900, pg_temp.ago('5 days'));
select pg_temp.rematch('y1', null);
select pg_temp.check(pg_temp.c('y1') = 'not_earned:no_creator' and pg_temp.available('acme') = pg_temp.t('acme_before_x1')::bigint,
  'a held sale that loses its creator gives everything back');
select pg_temp.rematch('y1', 'ben');
select pg_temp.check(pg_temp.c('y1') = 'held 1470+147' and (pg_temp.com('y1')).affiliate_id = pg_temp.q('creator_ben')
  and pg_temp.moved('y1', 'commission_reserved') = '2x-2940' and pg_temp.moved('y1', 'commission_returned') = '1x1470',
  'and earns again when it gets a creator who is a member');
select pg_temp.check(pg_temp.books(), 'the books balance after sales moved between creators');

-- A member who leaves ----------------------------------------------------------------------------
select from pg_temp.call('ben', format('select public.partner_program_leave(%L)', jsonb_build_object('program_id', (pg_temp.program('acme')).id)));
select set_config('request.jwt.claims', '', true);
select pg_temp.sale('b_before', 'acme', 'ben', 4900, pg_temp.ago('6 days'));
select pg_temp.sale('b_after', 'acme', 'ben', 4900, clock_timestamp() + interval '1 minute');
select pg_temp.check(pg_temp.c('b_before') = 'held 1470+147' and pg_temp.c('b_after') = 'not_earned:not_a_member'
  and pg_temp.c('y1') = 'held 1470+147',
  'a payment made while the creator was a member earns after they left; a payment made after they left does not');
-- Ben asks to come back but has not been let in again (fixture: the request is waiting).
update public.affiliate_program_members set status = 'pending', ended_at = null where id = (pg_temp.member('ben', 'acme')).id;
select pg_temp.sale('b_waiting', 'acme', 'ben', 4900, clock_timestamp() + interval '2 minutes');
select pg_temp.check(pg_temp.c('b_waiting') = 'not_earned:not_a_member',
  'a creator whose request to rejoin is still waiting is not a member');

-- The terms a creator had accepted when the buyer paid ------------------------------------------
-- SpeakSix publishes new terms: 40%, held 7 days. Dee accepted them 20 days ago; Ada has not.
select pg_temp.publish('owner', 'acme', '{"commission_rate_bps":4000,"hold_days":7}');
select set_config('request.jwt.claims', '', true);
insert into public.affiliate_program_acceptances(member_id, program_id, terms_version, agreement_sha256, accepted_by, accepted_name, accepted_at)
  select m.id, m.program_id, 2, t.agreement_sha256, pg_temp.q('dee'), 'Dee Vale', pg_temp.ago('20 days')
  from pg_temp.member('dee', 'acme') m join public.affiliate_program_terms t on t.program_id = m.program_id and t.version = 2;
update public.affiliate_program_members set terms_version = 2 where id = (pg_temp.member('dee', 'acme')).id;
select pg_temp.sale('d_first', 'acme', 'dee', 4900, pg_temp.ago('90 days'));
select pg_temp.sale('d_v1', 'acme', 'dee', 4900, pg_temp.ago('30 days'));
select pg_temp.sale('d_v2', 'acme', 'dee', 4900, pg_temp.ago('10 days'));
select pg_temp.sale('a_v1', 'acme', 'ada', 4900, pg_temp.ago('2 days'));
select pg_temp.check((pg_temp.program('acme')).live_terms_version = 2
  and pg_temp.c('d_v1') = 'held 1470+147' and (pg_temp.com('d_v1')).terms_version = 1
  and (pg_temp.com('d_v1')).hold_until = pg_temp.ago('30 days') + interval '30 days'
  and pg_temp.c('d_v2') = 'held 1960+196' and (pg_temp.com('d_v2')).terms_version = 2
  and (pg_temp.com('d_v2')).commission_rate_bps = 4000 and (pg_temp.com('d_v2')).hold_until = pg_temp.ago('10 days') + interval '7 days',
  'a sale is paid under the terms the creator had accepted when the buyer paid: 30% and 30 days before they accepted the '
    || 'new terms, 40% and 7 days after');
select pg_temp.check(pg_temp.c('d_first') = 'held 1470+147' and (pg_temp.com('d_first')).terms_version = 1
  and pg_temp.c('a_v1') = 'held 1470+147' and (pg_temp.com('a_v1')).terms_version = 1,
  'a sale from before any acceptance uses the first terms accepted, and a creator who has not accepted the new terms '
    || 'stays on the ones they accepted');

-- The fee comes from the settings when the commission is earned ----------------------------------
select from pg_temp.call('kma_owner', format('select public.configure_admin_program_money(%L)', jsonb_build_object('fee_bps', 0,
  'expected_updated_at', (select updated_at from public.platform_settings))));
select set_config('request.jwt.claims', '', true);
select pg_temp.sale('f0', 'acme', 'ada', 4900, pg_temp.ago('2 days'));
select pg_temp.check(pg_temp.c('f0') = 'held 1470+0' and (pg_temp.com('f0')).fee_bps = 0 and (pg_temp.com('f0')).fee_earned_minor = 0
  and pg_temp.moved('f0', 'commission_reserved') = '1x-1470' and pg_temp.moved('f0', 'fee_reserved') = '0x0',
  'with the fee set to nothing only the commission is set aside, in one entry');
select from pg_temp.call('kma_owner', format('select public.configure_admin_program_money(%L)', jsonb_build_object('fee_bps', 1500,
  'expected_updated_at', (select updated_at from public.platform_settings))));
select set_config('request.jwt.claims', '', true);
select pg_temp.sale('f15', 'acme', 'ada', 4900, pg_temp.ago('2 days'));
select pg_temp.check(pg_temp.c('f15') = 'held 1470+220' and (pg_temp.com('f15')).fee_bps = 1500
  and (pg_temp.com('a1')).fee_bps = 1000 and pg_temp.c('a_tax') = 'held 1470+147',
  'a fee of 15% is $2.20 on $14.70, rounded down; commissions earned earlier keep the fee they were earned with');
select from pg_temp.call('kma_owner', format('select public.configure_admin_program_money(%L)', jsonb_build_object('fee_bps', 1000,
  'expected_updated_at', (select updated_at from public.platform_settings))));
select set_config('request.jwt.claims', '', true);

-- Syncing again changes nothing -------------------------------------------------------------------
insert into qa select 'entries_before', pg_temp.n('public.program_balance_entries');
do $$ begin perform kma_internal.program_commission_sync(s.id), kma_internal.program_commission_sync(s.id) from public.program_sales s; end $$;
update public.program_sales set verified_at = clock_timestamp();
select pg_temp.flush();
select pg_temp.check(pg_temp.n('public.program_balance_entries') = pg_temp.t('entries_before')::bigint
  and pg_temp.n('public.program_creator_entries') = 0 and pg_temp.n('public.program_commission_retries') = 0
  and pg_temp.c('a_tax') = 'held 1470+147' and pg_temp.c('x1') = 'not_earned:not_a_member' and pg_temp.c('pre') = 'none'
  and pg_temp.books(),
  'syncing every sale twice more, and touching every sale, moves no money and changes no commission');

-- Tax that is only known later --------------------------------------------------------------------
select pg_temp.sale('t1', 'acme', 'ada', 4900, pg_temp.ago('2 days'));
update public.program_sales set tax_minor = 900 where id = pg_temp.q('t1');
select pg_temp.flush();
select pg_temp.check(pg_temp.c('t1') = 'held 1200+120' and (pg_temp.com('t1')).earned_minor = 1470
  and pg_temp.moved('t1', 'commission_returned') = '1x270' and pg_temp.moved('t1', 'fee_returned') = '1x27',
  'tax that is reported after the commission was held reduces it: the difference goes back to the merchant');
update public.program_sales set tax_minor = 0 where id = pg_temp.q('t1');
select pg_temp.flush();
select pg_temp.check(pg_temp.c('t1') = 'held 1200+120', 'a commission is never raised again once it was reduced');

-- Refunds while the commission is held -----------------------------------------------------------
insert into qa select 'acme_before_refund', pg_temp.available('acme');
select pg_temp.refund('a1', 2450);
select pg_temp.check(pg_temp.c('a1') = 'held 735+73' and (pg_temp.com('a1')).earned_minor = 1470
  and (pg_temp.com('a1')).fee_earned_minor = 147
  and pg_temp.moved('a1', 'commission_returned') = '1x735' and pg_temp.moved('a1', 'fee_returned') = '1x74'
  and pg_temp.available('acme') = pg_temp.t('acme_before_refund')::bigint + 809,
  'half the payment refunded: half the commission and half the fee go back to the merchant, and the rest stays held');
select pg_temp.refund('a1', 1000);
select pg_temp.check(pg_temp.c('a1') = 'held 735+73' and pg_temp.available('acme') = pg_temp.t('acme_before_refund')::bigint + 809,
  'a refund total that Stripe later reports lower does not raise the commission again');
select pg_temp.refund('a1', 4900);
select pg_temp.check(pg_temp.c('a1') = 'reversed 0+0' and (pg_temp.com('a1')).reversed_at is not null
  and (pg_temp.com('a1')).earned_minor = 1470
  and pg_temp.moved('a1', 'commission_returned') = '2x1470' and pg_temp.moved('a1', 'fee_returned') = '2x147'
  and pg_temp.available('acme') = pg_temp.t('acme_before_refund')::bigint + 1617,
  'the whole payment refunded: the commission is reversed and everything set aside for it is back in the balance');
select pg_temp.refund('a1', 0);
select pg_temp.rematch('a1', 'dee');
select pg_temp.check(pg_temp.c('a1') = 'reversed 0+0' and (pg_temp.com('a1')).affiliate_id = pg_temp.q('creator_ada'),
  'a reversed commission is final');
select pg_temp.sale('a_tiny', 'acme', 'ada', 10, pg_temp.ago('2 days'));
select pg_temp.check(pg_temp.c('a_tiny') = 'held 3+0', '30% of 10 cents is 3 cents, with a fee that rounds down to nothing');
select pg_temp.refund('a_tiny', 7);
select pg_temp.check(pg_temp.c('a_tiny') = 'reversed 0+0' and pg_temp.moved('a_tiny', 'commission_returned') = '1x3',
  'a partial refund that leaves nothing of a commission reverses it');
select pg_temp.check(pg_temp.books(), 'the books balance after refunds in the hold');

-- Sales that arrive through record_program_sale ---------------------------------------------------
-- The buyer of a Rival Reader subscription pays, tagged with Ada's click; its renewal follows.
select pg_temp.check((pg_temp.pay('p_s1', 'acct_Rival', pg_temp.t('tag_ada_rival'), pg_temp.ago('5 days'),
    '{"subscription_id":"sub_real","invoice_id":"in_real1","billing_reason":"subscription_create"}')
    @> '{"recorded":true,"created":true,"matched":true}')
  and pg_temp.c('p_s1') = 'none', 'record_program_sale records the sale; its commission is not worked out inside the call');
select pg_temp.flush();
select pg_temp.check(pg_temp.c('p_s1') = 'held 500+50' and pg_temp.moved('p_s1', 'commission_reserved') = '1x-500',
  'when the recording transaction ends the sale has its commission');
select pg_temp.check((pg_temp.pay('p_s2', 'acct_Rival', null, pg_temp.ago('2 days'),
    '{"subscription_id":"sub_real","invoice_id":"in_real2","billing_reason":"subscription_cycle"}', 'invoice.paid')
    @> '{"recorded":true,"created":true,"matched":true,"match_source":"subscription"}'),
  'the renewal is recorded and inherits the creator of the first payment');
select pg_temp.flush();
select pg_temp.check(pg_temp.c('p_s2') = 'not_earned:outside_duration'
  and pg_temp.n(format('public.program_balance_entries where commission_id = %L', (pg_temp.com('p_s2')).id)) = 0
  and pg_temp.state('rival') = 'live',
  'the renewal is judged once, as the second payment of its subscription: nothing was set aside and given back on the way');
-- The same payment reported again by another receipt changes nothing.
select pg_temp.check((pg_temp.pay('p_s1', 'acct_Rival', pg_temp.t('tag_ada_rival'), pg_temp.ago('5 days'),
    '{"subscription_id":"sub_real","invoice_id":"in_real1","billing_reason":"subscription_create"}', 'invoice.paid',
    'evt_p_s1_invoice') @> '{"recorded":true,"created":false}'), 'a second receipt of the same payment finds the same sale');
select pg_temp.flush();
select pg_temp.check(pg_temp.c('p_s1') = 'held 500+50' and pg_temp.moved('p_s1', 'commission_reserved') = '1x-500'
  and pg_temp.moved('p_s1', 'fee_reserved') = '1x-50', 'and its commission is set aside only once');

-- Disputes ---------------------------------------------------------------------------------------
-- Three SpeakSix sales of 40 days ago, tagged with Ada's click: their 30 day hold has passed.
select pg_temp.check(pg_temp.pay(k, 'acct_SpeakSix', pg_temp.t('tag_ada'), pg_temp.ago('40 days')) @> '{"recorded":true,"matched":true}',
  format('the sale %s is recorded', k)) from unnest(array['p_d1', 'p_d2', 'p_d3']) k;
select pg_temp.flush();
select pg_temp.check(pg_temp.c('p_d1') = 'held 1470+147' and pg_temp.c('p_d2') = 'held 1470+147' and pg_temp.c('p_d3') = 'held 1470+147'
  and (pg_temp.com('p_d1')).hold_until < now(), 'three sales whose hold has already passed are held until the tick runs');
select pg_temp.check((pg_temp.dispute('p_d1', 'acct_SpeakSix', 'open') @> '{"recorded":true,"status":"disputed"}')
  and (pg_temp.dispute('p_d2', 'acct_SpeakSix', 'open') @> '{"recorded":true,"status":"disputed"}')
  and pg_temp.c('p_d1') = 'held 1470+147' and pg_temp.c('p_d2') = 'held 1470+147'
  and pg_temp.moved('p_d1', 'commission_returned') = '0x0',
  'a dispute that is opened leaves the commission held and moves no money');

-- Approval after the hold ------------------------------------------------------------------------
insert into qa select 'due', pg_temp.due();
select pg_temp.check(pg_temp.t('due')::bigint >= 8 and pg_temp.n('public.program_creator_entries') = 0,
  'several holds have passed and nothing has been approved yet');
select pg_temp.check(pg_temp.try_signed_out('service_role', 'select public.program_commissions_tick(''{"limit":0}'')') = '22023 invalid_input'
  and pg_temp.try_signed_out('service_role', 'select public.program_commissions_tick(''{"limit":1001}'')') = '22023 invalid_input'
  and pg_temp.try_signed_out('service_role', 'select public.program_commissions_tick(''{"limit":"5"}'')') = '22023 invalid_input'
  and pg_temp.try_signed_out('service_role', 'select public.program_commissions_tick(''{"batch":5}'')') = '22023 invalid_input'
  and pg_temp.try_signed_out('service_role', 'select public.program_commissions_tick(''[]'')') = '22023 invalid_input',
  'the tick refuses a limit outside 1 to 1000 and anything else it does not know');
select pg_temp.check(pg_temp.tick('{"limit":1}') = jsonb_build_object('approved', 1, 'retried', 0, 'remaining', pg_temp.t('due')::bigint - 1),
  'a tick with a limit of one approves the oldest hold and says how many are left');
select pg_temp.capture('commissions_tick', pg_temp.tick('{"limit":500}'));
select pg_temp.check(pg_temp.n('public.program_commissions where status = ''approved''') = pg_temp.t('due')::bigint
  and pg_temp.due() = 0 and pg_temp.tick() = '{"approved":0,"retried":0,"remaining":0}'::jsonb
  and pg_temp.tick(null) = '{"approved":0,"retried":0,"remaining":0}'::jsonb,
  'the next tick approves the rest; ticks after that find nothing to do');
select pg_temp.check(pg_temp.c('m1') = 'approved 1470+147' and (pg_temp.com('m1')).approved_at is not null
  and pg_temp.credited('m1', 'commission_approved') = '1x1470' and pg_temp.moved('m1', 'commission_returned') = '0x0'
  and pg_temp.c('p_d3') = 'approved 1470+147' and pg_temp.c('d_v2') = 'approved 1960+196'
  and pg_temp.c('q_l1') = 'approved 980+98' and pg_temp.c('r_sub1') = 'approved 500+50',
  'an approved commission is the creator''s: one entry for its amount on their side, and no money moves on the merchant''s');
select pg_temp.check(pg_temp.c('a_tax') = 'held 1470+147' and pg_temp.c('q_l15') = 'held 980+98' and pg_temp.c('d_v1') = 'approved 1470+147'
  and (select bool_and(c.hold_until <= c.approved_at) from public.program_commissions c where c.status = 'approved')
  and not exists (select 1 from public.program_commissions c where c.status = 'held' and c.hold_until <= now()
    and c.sale_id not in (pg_temp.q('p_d1'), pg_temp.q('p_d2'))),
  'nothing is approved before its hold has passed, and everything whose hold has passed is approved, except the disputed sales');
select pg_temp.check(pg_temp.c('p_d1') = 'held 1470+147' and pg_temp.c('p_d2') = 'held 1470+147'
  and pg_temp.credited('p_d1', 'commission_approved') = '0x0',
  'a commission whose sale is disputed is not approved, however long ago its hold passed');
select pg_temp.check(pg_temp.books(), 'the books balance after approvals');

-- A dispute won, and a dispute lost ---------------------------------------------------------------
select pg_temp.check((pg_temp.dispute('p_d1', 'acct_SpeakSix', 'won') @> '{"recorded":true,"status":"paid"}')
  and pg_temp.c('p_d1') = 'held 1470+147' and pg_temp.due() = 1, 'a dispute that is won leaves the commission held, ready for the tick');
select pg_temp.check(pg_temp.tick() = '{"approved":1,"retried":0,"remaining":0}'::jsonb and pg_temp.c('p_d1') = 'approved 1470+147',
  'and the next tick approves it');
insert into qa select 'acme_before_lost', pg_temp.available('acme');
select pg_temp.check((pg_temp.dispute('p_d2', 'acct_SpeakSix', 'lost') @> '{"recorded":true,"status":"disputed"}')
  and pg_temp.c('p_d2') = 'reversed 0+0' and pg_temp.moved('p_d2', 'commission_returned') = '1x1470'
  and pg_temp.moved('p_d2', 'fee_returned') = '1x147' and pg_temp.credited('p_d2', 'commission_approved') = '0x0'
  and pg_temp.available('acme') = pg_temp.t('acme_before_lost')::bigint + 1617,
  'a dispute that is lost in the hold reverses the commission like a full refund: commission and fee go back');
select pg_temp.check(pg_temp.tick() = '{"approved":0,"retried":0,"remaining":0}'::jsonb and pg_temp.c('p_d2') = 'reversed 0+0',
  'a reversed commission is never approved');

-- Refunds after approval --------------------------------------------------------------------------
insert into qa select 'ada_owed', pg_temp.owed('ada', 'acme');
insert into qa select 'acme_before_clawback', pg_temp.available('acme');
select pg_temp.refund('m1', 2450);
select pg_temp.check(pg_temp.c('m1') = 'approved 735+147' and pg_temp.credited('m1', 'clawback') = '1x-735'
  and pg_temp.moved('m1', 'commission_returned') = '1x735' and pg_temp.moved('m1', 'fee_returned') = '0x0'
  and pg_temp.owed('ada', 'acme') = pg_temp.t('ada_owed')::bigint - 735
  and pg_temp.available('acme') = pg_temp.t('acme_before_clawback')::bigint + 735,
  'half the payment refunded after approval: half the commission is taken back from the creator and returned to the '
    || 'merchant; the fee is kept');
select pg_temp.refund('m1', 4900);
select pg_temp.check(pg_temp.c('m1') = 'approved 0+147' and pg_temp.credited('m1', 'clawback') = '2x-1470'
  and pg_temp.moved('m1', 'commission_returned') = '2x1470' and (pg_temp.com('m1')).earned_minor = 1470
  and pg_temp.available('acme') = pg_temp.t('acme_before_clawback')::bigint + 1470,
  'the whole payment refunded after approval: the whole commission is taken back; the fee is still kept');
select pg_temp.check((pg_temp.dispute('p_d3', 'acct_SpeakSix', 'lost') @> '{"recorded":true,"status":"disputed"}')
  and pg_temp.c('p_d3') = 'approved 0+147' and pg_temp.credited('p_d3', 'clawback') = '1x-1470'
  and pg_temp.moved('p_d3', 'commission_returned') = '1x1470',
  'a dispute lost after approval takes the whole commission back the same way');
-- A payout (suite 82 covers how one is made) that left Ada only $5.00 from SpeakSix.
with payout as (
  insert into public.program_payouts(affiliate_id, platform_account_id, currency, amount_minor, status, connect_account_id,
    transfer_id, approved_by, paid_at, closed_at)
  select pg_temp.q('creator_ada'), 'acct_KMAPlatform', 'USD', pg_temp.owed('ada', 'acme') - 500, 'paid', 'acct_AdaPayouts',
    'tr_AdaFixture', pg_temp.q('kma_owner'), now(), now()
  returning id, amount_minor)
insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, payout_id)
  select pg_temp.q('creator_ada'), (pg_temp.program('acme')).id, 'USD', 'payout', -amount_minor, id from payout;
select pg_temp.refund('m_in', 4900);
select pg_temp.check(pg_temp.c('m_in') = 'approved 970+147' and pg_temp.credited('m_in', 'clawback') = '1x-500'
  and pg_temp.moved('m_in', 'commission_returned') = '1x500' and pg_temp.owed('ada', 'acme') = 0,
  'a refund never takes back more than the creator still has coming from the program');
select kma_internal.program_commission_sync(pg_temp.q('m_in'));
select pg_temp.refund('p_d1', 4900);
select pg_temp.check(pg_temp.c('m_in') = 'approved 970+147' and pg_temp.c('p_d1') = 'approved 1470+147'
  and pg_temp.credited('p_d1', 'clawback') = '0x0' and pg_temp.owed('ada', 'acme') = 0
  and pg_temp.n('public.program_commission_retries') = 0,
  'with nothing left to take from, a refund of an approved sale moves nothing and what the creator has coming never goes '
    || 'below zero');
select pg_temp.check(pg_temp.books(), 'the books balance after refunds of approved sales');

-- A refund that arrives while the switch is off -------------------------------------------------
select pg_temp.sale('hw', 'acme', 'dee', 4900, pg_temp.ago('40 days'));
select pg_temp.sale('hw2', 'acme', 'dee', 4900, pg_temp.ago('40 days'));
select pg_temp.money(false);
select pg_temp.refund('hw', 4900);
select pg_temp.refund('hw2', 2450);
select pg_temp.check(pg_temp.c('hw') = 'held 1470+147' and pg_temp.c('hw2') = 'held 1470+147'
  and pg_temp.tick() = '{"approved":0,"retried":0,"remaining":0}'::jsonb,
  'while the switch is off a refund changes no commission and the tick approves nothing');
select pg_temp.money(true);
select pg_temp.check(pg_temp.tick() = '{"approved":1,"retried":0,"remaining":0}'::jsonb
  and pg_temp.c('hw') = 'reversed 0+0' and pg_temp.credited('hw', 'commission_approved') = '0x0'
  and pg_temp.moved('hw', 'commission_returned') = '1x1470'
  and pg_temp.c('hw2') = 'approved 735+73' and pg_temp.credited('hw2', 'commission_approved') = '1x735'
  and pg_temp.moved('hw2', 'commission_returned') = '1x735' and pg_temp.moved('hw2', 'fee_returned') = '1x74',
  'the tick brings a sale up to date before it approves: the refunded sale is reversed, the half refunded one is approved '
    || 'for half');

-- A failure inside the sync never fails the sale --------------------------------------------------
create function pg_temp.broken() returns trigger language plpgsql as $$
begin
  raise exception 'a fault in commission evaluation' using errcode = 'KMA42';
end $$;
create trigger broken_for_test before insert on public.program_commissions for each row execute function pg_temp.broken();
insert into qa select 'entries_before_fault', pg_temp.n('public.program_balance_entries');
select pg_temp.check((pg_temp.pay('p_fail', 'acct_SpeakSix', pg_temp.t('tag_ada'), pg_temp.ago('2 days'))
    @> '{"recorded":true,"created":true,"matched":true}'), 'record_program_sale records a sale while evaluation is broken');
select pg_temp.flush();
select pg_temp.check(pg_temp.n(format('public.program_sales where id = %L', pg_temp.q('p_fail'))) = 1 and pg_temp.c('p_fail') = 'none'
  and (select r.attempts = 1 and r.last_error_code = 'KMA42' and r.next_attempt_at > clock_timestamp()
    from public.program_commission_retries r where r.sale_id = pg_temp.q('p_fail'))
  and pg_temp.n('public.program_commission_retries') = 1
  and pg_temp.n('public.program_balance_entries') = pg_temp.t('entries_before_fault')::bigint,
  'the transaction that recorded the sale ends normally: the sale is there, no money moved, and the sale is noted for '
    || 'another try with the code of the failure');
select pg_temp.check((pg_temp.dispute('p_fail', 'acct_SpeakSix', 'open') @> '{"recorded":true,"status":"disputed"}')
  and pg_temp.n(format('public.program_commission_retries where sale_id = %L and attempts = 2', pg_temp.q('p_fail'))) = 1,
  'record_program_sale_event does not fail either');
select pg_temp.check(pg_temp.tick() = '{"approved":0,"retried":0,"remaining":0}'::jsonb,
  'the tick waits until the next try is due');
update public.program_commission_retries set next_attempt_at = now() - interval '1 second';
select pg_temp.check(pg_temp.tick() = '{"approved":0,"retried":1,"remaining":0}'::jsonb, 'the tick tries the sale again when it is due');
select pg_temp.check((select r.attempts = 3 and r.next_attempt_at > clock_timestamp() + interval '3 minutes'
    from public.program_commission_retries r where r.sale_id = pg_temp.q('p_fail')) and pg_temp.c('p_fail') = 'none',
  'a try that fails again is counted and pushed further out');
drop trigger broken_for_test on public.program_commissions;
update public.program_commission_retries set next_attempt_at = now() - interval '1 second';
select pg_temp.capture('commissions_tick_retry', pg_temp.tick());
select pg_temp.check(pg_temp.c('p_fail') = 'held 1470+147' and pg_temp.n('public.program_commission_retries') = 0
  and pg_temp.moved('p_fail', 'commission_reserved') = '1x-1470',
  'once evaluation works again the tick gives the sale its commission and forgets the failure');
-- A fault while approving: the others are still approved, and the faulty one is retried.
select pg_temp.check(pg_temp.dispute('p_fail', 'acct_SpeakSix', 'won') @> '{"recorded":true,"status":"paid"}', 'that dispute is won');
select pg_temp.sale('ok_due', 'acme', 'dee', 4900, pg_temp.ago('40 days'));
select pg_temp.sale('bad_due', 'acme', 'dee', 4900, pg_temp.ago('40 days'));
create function pg_temp.broken_approval() returns trigger language plpgsql as $$
begin
  if new.commission_id = (pg_temp.com('bad_due')).id then
    raise exception 'a fault in approval' using errcode = 'KMA43';
  end if;
  return new;
end $$;
create trigger broken_for_test before insert on public.program_creator_entries for each row execute function pg_temp.broken_approval();
select pg_temp.check(pg_temp.tick() = '{"approved":1,"retried":0,"remaining":1}'::jsonb
  and pg_temp.c('ok_due') = 'approved 1470+147' and pg_temp.c('bad_due') = 'held 1470+147'
  and pg_temp.n(format('public.program_commission_retries where sale_id = %L and last_error_code = ''KMA43''', pg_temp.q('bad_due'))) = 1
  and pg_temp.credited('bad_due', 'commission_approved') = '0x0',
  'a fault while approving one commission leaves it held and noted, and does not stop the others');
drop trigger broken_for_test on public.program_creator_entries;
select pg_temp.check(pg_temp.tick() = '{"approved":1,"retried":0,"remaining":0}'::jsonb and pg_temp.c('bad_due') = 'approved 1470+147'
  and pg_temp.credited('bad_due', 'commission_approved') = '1x1470',
  'and it is approved, once, by the next tick');
update public.program_commission_retries set next_attempt_at = now() - interval '1 second';
select pg_temp.check(pg_temp.tick() = '{"approved":0,"retried":1,"remaining":0}'::jsonb
  and pg_temp.n('public.program_commission_retries') = 0, 'the note of the fault goes with the next retry');
select pg_temp.check(pg_temp.books(), 'the books balance after the faults');

-- What a creator sees ----------------------------------------------------------------------------
select pg_temp.capture('partner_program_earnings', pg_temp.call('ada', 'select public.partner_program_earnings()'));
select pg_temp.capture('partner_program_earnings_dee', pg_temp.call('dee', 'select public.partner_program_earnings()'));
select pg_temp.capture('partner_program_earnings_ben', pg_temp.call('ben', 'select public.partner_program_earnings()'));
select pg_temp.check((select jsonb_array_length(e->'programs') = 2
      and e->'programs'->0->>'name' = 'Rival Reader' and e->'programs'->1->>'name' = 'SpeakSix'
      and (select bool_and((select array_agg(k order by k) from jsonb_object_keys(p) k) = array['approved_minor', 'currency',
          'name', 'next_release_at', 'paid_minor', 'paying_minor', 'pending_minor', 'program_id', 'sales', 'slug'])
        from jsonb_array_elements(e->'programs') p)
      and (select bool_and((select array_agg(k order by k) from jsonb_object_keys(r) k) = array['amount_minor', 'approved_at',
          'currency', 'earned_minor', 'hold_until', 'id', 'paid_at', 'program_id', 'program_name', 'sale_amount_minor', 'status'])
        from jsonb_array_elements(e->'recent') r)
    from pg_temp.call('ada', 'select public.partner_program_earnings()') e),
  'a creator gets one line for each program they earned in, by name, and their recent commissions, with exactly the '
    || 'agreed fields and nothing about the buyer');
select pg_temp.check((select p->>'program_id' = (pg_temp.program('acme')).id::text and p->>'slug' = 'speaksix' and p->>'currency' = 'USD'
      and (p->>'pending_minor')::bigint = (select sum(c.amount_minor) from public.program_commissions c
        where c.affiliate_id = pg_temp.q('creator_ada') and c.program_id = (pg_temp.program('acme')).id and c.status = 'held')
      and (p->>'approved_minor')::bigint = 0
      and (p->>'paid_minor')::bigint = (select -sum(e.amount_minor) from public.program_creator_entries e
        where e.affiliate_id = pg_temp.q('creator_ada') and e.kind = 'payout')
      and (p->>'sales')::bigint = (select count(*) from public.program_commissions c
        where c.affiliate_id = pg_temp.q('creator_ada') and c.program_id = (pg_temp.program('acme')).id and c.status in ('held', 'approved'))
      and (p->>'next_release_at')::timestamptz = (select min(c.hold_until) from public.program_commissions c
        where c.affiliate_id = pg_temp.q('creator_ada') and c.program_id = (pg_temp.program('acme')).id and c.status = 'held')
    from pg_temp.call('ada', 'select public.partner_program_earnings()') e, jsonb_array_elements(e->'programs') p
    where p->>'name' = 'SpeakSix'),
  'pending is what is held, approved is what the creator still has coming, paid is what payouts took, sales counts held '
    || 'and approved commissions and the next release is the earliest hold');
select pg_temp.check((select (p->>'pending_minor')::bigint = 500 + 300 + 500 and (p->>'approved_minor')::bigint = 500
      and (p->>'paid_minor')::bigint = 0 and (p->>'sales')::bigint = 4
    from pg_temp.call('ada', 'select public.partner_program_earnings()') e, jsonb_array_elements(e->'programs') p
    where p->>'name' = 'Rival Reader'),
  'Rival Reader: three commissions pending, one approved');
select pg_temp.check((select jsonb_array_length(e->'recent') = (select least(count(*), 50) from public.program_commissions c
        where c.affiliate_id = pg_temp.q('creator_ada') and c.status in ('held', 'approved', 'reversed'))
      and (select bool_and(r->>'status' in ('held', 'approved', 'reversed')) from jsonb_array_elements(e->'recent') r)
      and (select array_agg((r->>'paid_at')::timestamptz order by o) = array_agg((r->>'paid_at')::timestamptz order by (r->>'paid_at')::timestamptz desc, o)
        from jsonb_array_elements(e->'recent') with ordinality x(r, o))
      and (select r @> jsonb_build_object('program_name', 'SpeakSix', 'status', 'reversed', 'amount_minor', 0, 'earned_minor', 1470,
          'currency', 'USD', 'sale_amount_minor', 4900, 'approved_at', null)
        from jsonb_array_elements(e->'recent') r where r->>'id' = (pg_temp.com('a1')).id::text)
      and (select r @> jsonb_build_object('status', 'approved', 'amount_minor', 970, 'earned_minor', 1470)
          and (r->>'approved_at') is not null and (r->>'hold_until')::timestamptz = (pg_temp.com('m_in')).hold_until
        from jsonb_array_elements(e->'recent') r where r->>'id' = (pg_temp.com('m_in')).id::text)
      and not exists (select 1 from jsonb_array_elements(e->'recent') r where r->>'id' = (pg_temp.com('a_zero')).id::text)
    from pg_temp.call('ada', 'select public.partner_program_earnings()') e),
  'recent commissions are the held, approved and reversed ones, newest payment first, each with what it was first worth '
    || 'and what it is worth now; sales that earned nothing are not listed');
select pg_temp.check(pg_temp.call('ben', 'select public.partner_program_earnings()') @> '{"recent":[]}'
  and jsonb_array_length(pg_temp.call('ben', 'select public.partner_program_earnings()')->'recent') > 0
  and not exists (select 1 from jsonb_array_elements(pg_temp.call('ben', 'select public.partner_program_earnings()')->'recent') r
    where r->>'id' in (select c.id::text from public.program_commissions c where c.affiliate_id <> pg_temp.q('creator_ben')))
  and pg_temp.try('stranger', 'select public.partner_program_earnings()') = '42501'
  and pg_temp.try('owner', 'select public.partner_program_earnings()') = '42501',
  'a creator sees only their own commissions; somebody with no creator account is refused');
insert into auth.users(id, email, email_confirmed_at) values ('f9000000-0000-4000-8000-000000000027', 'new@creators.example', now());
insert into qa values ('newbie', 'f9000000-0000-4000-8000-000000000027'), ('creator_newbie', 'fa000000-0000-4000-8000-000000000007');
insert into public.affiliates(id, public_name, slug, status) values (pg_temp.q('creator_newbie'), 'New Creator', 'new-creator', 'active');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at)
  values (pg_temp.q('creator_newbie'), pg_temp.q('newbie'), 'owner', true, false, now());
select pg_temp.capture('partner_program_earnings_none', pg_temp.call('newbie', 'select public.partner_program_earnings()'));
select pg_temp.check(pg_temp.call('newbie', 'select public.partner_program_earnings()') - 'payouts' - 'payout'
    = '{"programs":[],"recent":[]}'::jsonb,
  'a creator who has earned nothing gets two empty lists');
select set_config('request.jwt.claims', '', true);

-- The admin totals -------------------------------------------------------------------------------
select pg_temp.capture('admin_program_money_totals', pg_temp.call('kma_operations', 'select public.get_admin_program_money()'));
select pg_temp.check((select (m->>'programs_with_balance')::bigint = 4
      and m->'available_minor_by_currency' = jsonb_build_object('USD', (select sum(available_minor) from public.program_balance_accounts))
      and m->'reserved_minor_by_currency' = jsonb_build_object('USD',
        (select sum(c.amount_minor + c.fee_minor) from public.program_commissions c where c.status = 'held'))
      and m->'owed_to_creators_minor_by_currency' = jsonb_build_object('USD',
        (select sum(e.amount_minor) from public.program_creator_entries e))
      and (m->'reserved_minor_by_currency'->>'USD')::bigint > 0 and (m->'owed_to_creators_minor_by_currency'->>'USD')::bigint > 0
    from pg_temp.call('kma_operations', 'select public.get_admin_program_money()') m),
  'the admin totals are the balances available, what held commissions set aside and what creators have coming, by currency');
select set_config('request.jwt.claims', '', true);

-- The books, at the end ------------------------------------------------------------------------
select pg_temp.check(pg_temp.books()
  and (select bool_and(e.available_after_minor >= 0) from public.program_balance_entries e where e.commission_id is not null)
  and (select bool_and(a.available_minor >= 0) from public.program_balance_accounts a)
  and (select bool_and(s >= 0) from (select sum(e.amount_minor) as s from public.program_creator_entries e
    group by e.affiliate_id, e.program_id) x)
  and (select count(*) = count(distinct c.sale_id) from public.program_commissions c)
  and not exists (select 1 from public.program_commissions c join public.program_sales s on s.id = c.sale_id
    where c.status = 'approved' and c.approved_at < c.hold_until)
  and not exists (select 1 from public.program_creator_entries e join public.program_commissions c on c.id = e.commission_id
    where e.kind = 'commission_approved' and c.status <> 'approved')
  and (select count(*) = count(distinct e.commission_id) from public.program_creator_entries e where e.kind = 'commission_approved'),
  'at the end every balance equals the sum of its entries and never went below zero through a commission, every commission '
    || 'agrees with both ledgers, there is one commission per sale and one approval per commission, and no creator is owed '
    || 'less than nothing');
select pg_temp.check((select count(*) = 8 from (select distinct c.reason from public.program_commissions c where c.status = 'not_earned') r)
  and (select count(*) = 4 from (select distinct c.status from public.program_commissions c) s),
  'this suite produced every reason a sale earns nothing and every status a commission has');

select 'ok ' || count(*) || ' program commission assertions' from commission_assertions;
rollback;
