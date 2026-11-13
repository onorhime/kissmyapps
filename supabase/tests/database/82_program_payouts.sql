-- Provider-free test of program payouts: who can be paid and what stands in the way, the
-- creator's payout account gate, an admin paying one creator or everyone who is ready and
-- taking a payout back, the worker's claim, begin and finish for every outcome, the money
-- leaving and returning to the creator's sums exactly once, what the creator and the admin
-- see at each step, the schedule, the operator view and the switch.
--
-- Programs, members and clicks are made with the Phase 2 and 3 functions; balances are
-- opened with open_program_balance on the platform and funded as fixtures; sales are
-- inserted directly and become approved commissions through the real sync and tick. A
-- creator's payout account is put into each state the way the older settlement functions
-- do it (reserve_creator_connect_account, set_creator_connect_account). Stripe is never called.
begin;
set local time zone 'UTC';
create temporary table payout_assertions(label text);
create temporary table qa(key text primary key, value text);
create temporary table answers(name text primary key, answer jsonb);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program payout assertion failed: %', label; end if;
  insert into payout_assertions values (label);
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
create function pg_temp.t(k text) returns text language sql as $$ select value from qa where key = k $$;
-- Signs in. KissMyApps staff (kma_...) get a session they opened by signing in themselves.
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
-- The words of a refusal.
create function pg_temp.message(who text, statement text) returns text language plpgsql as $$
begin
  perform pg_temp.call(who, statement);
  return 'ok';
exception when others then
  return sqlerrm;
end $$;
-- The same for staff whose session was opened by a link in an email, not by signing in themselves.
create function pg_temp.try_by_link(who text, statement text) returns text language plpgsql as $$
declare reason text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.q(who), 'role', 'authenticated',
    'amr', jsonb_build_array(jsonb_build_object('method', 'otp')))::text, true);
  set local role authenticated;
  execute statement;
  reset role;
  return 'ok';
exception when others then
  reset role;
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
create function pg_temp.svc(fn text, input jsonb) returns jsonb language sql as $$
  select pg_temp.service(format('select public.%I(%L)', fn, input))
$$;
create function pg_temp.svc_try(fn text, input jsonb) returns text language plpgsql as $$
declare reason text;
begin
  perform pg_temp.svc(fn, input);
  return 'ok';
exception when others then
  get stacked diagnostics reason = pg_exception_detail;
  return btrim(sqlstate || ' ' || coalesce(reason, ''));
end $$;
-- 'ok', or the SQLSTATE and message of a statement run directly.
create function pg_temp.fails(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- Prints one function result as the front ends receive it (kept by KMA_DB_TEST_OUTPUT).
create function pg_temp.capture(name text, result jsonb) returns text language sql as $$
  select 'capture ' || name || ' ' || result::text
$$;
-- Keeps an answer so that later statements can look at it without calling again.
create function pg_temp.keep(k text, result jsonb) returns jsonb language sql as $$
  insert into answers values (k, result) on conflict (name) do update set answer = excluded.answer returning answer
$$;
create function pg_temp.kept(k text) returns jsonb language sql as $$ select answer from answers where name = k $$;
create function pg_temp.keys(j jsonb) returns text[] language sql as $$
  select array_agg(k order by k) from jsonb_object_keys(j) k
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

-- Creators ---------------------------------------------------------------------------------------
create function pg_temp.join(creator text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(creator, format('select public.partner_program_join(%L)', jsonb_build_object(
    'slug', p.slug, 'terms_version', t.version, 'agreement_sha256', t.agreement_sha256)))
  from pg_temp.program(workspace) p
  join public.affiliate_program_terms t on t.program_id = p.id and t.version = p.live_terms_version
$$;
-- A visitor opens the creator's link: the click the redirect function records.
create function pg_temp.click(creator text, workspace text) returns uuid language plpgsql as $$
declare
  v_slug text;
  v_code text;
  result text;
begin
  select a.slug, l.public_code into v_slug, v_code
  from public.affiliate_program_members m
  join public.affiliate_links l on l.id = m.main_link_id
  join public.affiliates a on a.id = l.affiliate_id
  where m.program_id = (pg_temp.program(workspace)).id and m.affiliate_id = pg_temp.q('creator_' || creator);
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select r.click_id into result from public.register_tracking_click(v_slug, v_code, '{}'::jsonb) r;
  reset role;
  return (select k.id from public.clicks k where k.public_click_id = result);
exception when others then
  reset role;
  raise;
end $$;
-- What the creator has coming from one program: the sum of their entries.
create function pg_temp.owed(creator text, workspace text) returns bigint language sql as $$
  select coalesce(sum(e.amount_minor), 0)::bigint from public.program_creator_entries e
  where e.affiliate_id = pg_temp.q('creator_' || creator) and e.program_id = (pg_temp.program(workspace)).id
$$;
create function pg_temp.earnings(creator text) returns jsonb language sql as $$
  select pg_temp.call(creator, 'select public.partner_program_earnings()')
$$;
-- One program's line of a creator's earnings.
create function pg_temp.line(earnings jsonb, program_name text) returns jsonb language sql as $$
  select p from jsonb_array_elements(earnings->'programs') p where p->>'name' = program_name
$$;

-- Balances -------------------------------------------------------------------------------------
create function pg_temp.account(workspace text) returns public.program_balance_accounts language sql as $$
  select a from public.program_balance_accounts a where a.program_id = (pg_temp.program(workspace)).id
$$;
-- The balance is opened the way the program-balance function does it, on the KissMyApps platform.
create function pg_temp.open_account(workspace text, who text) returns jsonb language sql as $$
  select pg_temp.svc('open_program_balance', jsonb_build_object('workspace_id', pg_temp.q(workspace),
    'user_id', pg_temp.q(who), 'platform_account_id', 'acct_KMAPlatform'))
$$;
-- A deposit that Stripe confirmed (a fixture: suite 80 covers deposits).
create function pg_temp.fund(workspace text, amount bigint) returns void language plpgsql as $$
declare v_topup uuid;
begin
  insert into public.program_topups(account_id, kind, amount_minor, currency, status, settled_at)
  values ((pg_temp.account(workspace)).id, 'deposit', amount, (pg_temp.account(workspace)).currency, 'succeeded', now())
  returning id into v_topup;
  perform kma_internal.program_balance_post((pg_temp.account(workspace)).id, 'deposit', amount, v_topup);
end $$;
create function pg_temp.money(enabled boolean) returns void language sql as $$
  update public.platform_settings set program_money_enabled = enabled where singleton
$$;

-- Sales ------------------------------------------------------------------------------------------
-- A sale credited to the creator 40 days ago, so its hold has passed, then the worker's tick:
-- the commission is approved and is the creator's.
create function pg_temp.earn(k text, workspace text, creator text, amount bigint) returns void language plpgsql as $$
declare
  p public.affiliate_programs := pg_temp.program(workspace);
  v_click public.clicks;
  v_id uuid := gen_random_uuid();
begin
  select * into v_click from public.clicks where id = pg_temp.q('click_' || creator);
  insert into public.program_sales(id, program_id, connection_id, account_id, payment_intent_id, amount_minor, currency,
      refunded_minor, status, paid_at, click_id, click_record_id, affiliate_id, match_source)
    select v_id, p.id, c.id, c.account_id, 'pi_' || k, amount, p.currency, 0, 'paid', pg_temp.ago('40 days'),
      v_click.public_click_id, v_click.id, v_click.affiliate_id, 'metadata'
    from public.merchant_connections c join public.merchant_businesses b on b.id = c.merchant_id
    where b.workspace_id = p.workspace_id;
  insert into qa values (k, v_id);
  perform pg_temp.flush();
  perform pg_temp.svc('program_commissions_tick', '{"limit":100}');
end $$;
-- Stripe now reports this much of the payment refunded.
create function pg_temp.refund(k text, total bigint) returns void language plpgsql as $$
begin
  update public.program_sales set refunded_minor = total where id = pg_temp.q(k);
  perform kma_internal.program_sale_refresh_status(pg_temp.q(k));
  perform pg_temp.flush();
end $$;

-- Payout accounts --------------------------------------------------------------------------------
create function pg_temp.context_sql(platform text default 'acct_KMAPlatform', live boolean default true) returns text language sql as $$
  select format('select public.program_creator_payout_context(%L, %L)', platform, live)
$$;
create function pg_temp.payout_account(creator text) returns public.external_creator_accounts language sql as $$
  select a from public.external_creator_accounts a
  where a.affiliate_id = pg_temp.q('creator_' || creator) and a.platform_account_id = 'acct_KMAPlatform' and a.livemode
$$;
-- The creator opens the payout card and goes through Stripe's onboarding, as the older
-- settlement functions record it: the country is reserved, then what Stripe says about the
-- account is stored. state: pending (details missing), ready, restricted (Stripe disabled it).
create function pg_temp.onboard(creator text, connect text, state text, country text default 'US') returns jsonb language plpgsql as $$
declare v_key uuid;
begin
  v_key := (pg_temp.call(creator, pg_temp.context_sql())->>'account_key')::uuid;
  perform pg_temp.svc('reserve_creator_connect_account',
    jsonb_build_object('account_key', v_key, 'country', country, 'actor_user_id', pg_temp.q(creator)));
  return pg_temp.svc('set_creator_connect_account', jsonb_build_object(
    'account_key', v_key, 'affiliate_id', pg_temp.q('creator_' || creator), 'platform_account_id', 'acct_KMAPlatform',
    'livemode', true, 'connect_account_id', connect, 'charges_enabled', false,
    'payouts_enabled', state = 'ready', 'transfers_enabled', state = 'ready', 'details_submitted', state <> 'pending',
    'disabled_reason', case when state = 'restricted' then 'requirements.past_due' end,
    'requirements_due', case when state = 'ready' then '[]'::jsonb else '["external_account"]'::jsonb end,
    'verified_at', clock_timestamp()));
end $$;

-- The admin panel ----------------------------------------------------------------------------------
create function pg_temp.panel(who text default 'kma_finance') returns jsonb language sql as $$
  select pg_temp.call(who, 'select public.get_admin_program_payouts()')
$$;
create function pg_temp.act_sql(input jsonb) returns text language sql as $$
  select format('select public.perform_admin_program_payout(%L)', input)
$$;
create function pg_temp.pay_sql(creator text, currency text, amount bigint) returns text language sql as $$
  select pg_temp.act_sql(jsonb_build_object('action', 'pay', 'affiliate_id', pg_temp.q('creator_' || creator),
    'currency', currency, 'expected_amount_minor', amount))
$$;
create function pg_temp.configure_sql(input jsonb) returns text language sql as $$
  select format('select public.configure_admin_program_payouts(%L)', input)
$$;
-- A creator's row in the panel for one currency, and its blocker in one word ('ready' for none).
create function pg_temp.listed(panel jsonb, creator text, currency text default 'USD') returns jsonb language sql as $$
  select c from jsonb_array_elements(panel->'creators') c
  where c->>'affiliate_id' = pg_temp.q('creator_' || creator)::text and c->>'currency' = currency
$$;
create function pg_temp.blocker(creator text, currency text default 'USD') returns text language sql as $$
  select case when c is null then 'not listed' else coalesce(c->>'blocker', 'ready') end
  from (select pg_temp.listed(pg_temp.panel(), creator, currency) as c) x
$$;
-- The creators of a panel in one line: name currency amount blocker, in the order given.
create function pg_temp.roll(panel jsonb) returns text language sql as $$
  select coalesce(string_agg(format('%s %s %s %s', c->>'name', c->>'currency', c->>'payable_minor', coalesce(c->>'blocker', 'ready')),
    '; ' order by o), '')
  from jsonb_array_elements(panel->'creators') with ordinality x(c, o)
$$;

-- Payouts and the worker ---------------------------------------------------------------------------
create function pg_temp.payout(k text) returns public.program_payouts language sql as $$
  select p from public.program_payouts p where p.id = pg_temp.q(k)
$$;
-- The open payout of a creator in a currency.
create function pg_temp.open_payout(creator text, p_currency text default 'USD') returns uuid language sql as $$
  select p.id from public.program_payouts p
  where p.affiliate_id = pg_temp.q('creator_' || creator) and p.currency = p_currency and p.status in ('approved', 'processing')
$$;
-- A payout's entries of one kind: <how many>x<their sum>.
create function pg_temp.moved(k text, p_kind text) returns text language sql as $$
  select count(*) || 'x' || coalesce(sum(e.amount_minor), 0) from public.program_creator_entries e
  where e.payout_id = pg_temp.q(k) and e.kind = p_kind
$$;
create function pg_temp.claim(input jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.svc('claim_program_payouts', '{"platform_account_id":"acct_KMAPlatform"}'::jsonb || input)
$$;
-- The ids of the payouts a claim handed out, as the names they were kept under.
create function pg_temp.claimed(claim jsonb) returns text language sql as $$
  select coalesce(string_agg(q.key, ' ' order by q.key), '')
  from jsonb_array_elements(claim->'payouts') p join qa q on q.value = p->>'payout_id' and q.key ~ '^p[0-9]+$'
$$;
-- What the worker holds for a payout it claimed: the payout and the lease it was given.
create function pg_temp.ref(k text) returns jsonb language sql as $$
  select jsonb_build_object('payout_id', p.id, 'lease_token', p.lease_token) from public.program_payouts p where p.id = pg_temp.q(k)
$$;
-- Time passes: the lease runs out, or the wait before the next try is over.
create function pg_temp.lapse(k text) returns void language sql as $$
  update public.program_payouts set
    lease_until = case when lease_token is not null then clock_timestamp() - interval '1 second' end,
    next_attempt_at = case when next_attempt_at is not null then clock_timestamp() - interval '1 second' end
  where id = pg_temp.q(k)
$$;
-- Whether this transaction holds the lock on what a creator has coming from a program.
create function pg_temp.holds_lock(creator text, workspace text) returns boolean language sql as $$
  select exists (select 1 from pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted
      and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('kma-program-creator:'
        || (pg_temp.program(workspace)).id::text || ':' || pg_temp.q('creator_' || creator)::text, 0))
$$;
create function pg_temp.health() returns jsonb language sql as $$
  select pg_temp.service('select public.program_payout_health()')
$$;
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
grant all on qa, payout_assertions, answers to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- People ---------------------------------------------------------------------------------------
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('a2000000-0000-4000-8000-000000000001', 'owner@speaksix.com', now(), '{"company":"SpeakSix"}'),
  ('a2000000-0000-4000-8000-000000000002', 'owner@rival.co', now(), '{"company":"Rival"}'),
  ('a2000000-0000-4000-8000-000000000003', 'owner@lingot.fr', now(), '{"company":"Lingot"}'),
  ('a2000000-0000-4000-8000-000000000004', 'owner@quiet.co', now(), '{"company":"Quiet"}'),
  ('a2000000-0000-4000-8000-000000000011', 'owner@kissmyapps.dev', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000012', 'finance@kissmyapps.dev', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000013', 'operations@kissmyapps.dev', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000014', 'analyst@kissmyapps.dev', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000015', 'support@kissmyapps.dev', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000021', 'ada@creators.example', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000022', 'ben@creators.example', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000023', 'cy@creators.example', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000024', 'dee@creators.example', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000025', 'eve@creators.example', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000026', 'fay@creators.example', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000027', 'gus@creators.example', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000028', 'hal@creators.example', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000029', 'numbers@creators.example', now(), '{}'),
  ('a2000000-0000-4000-8000-000000000030', 'stranger@elsewhere.co', now(), '{}');
insert into qa values
  ('owner', 'a2000000-0000-4000-8000-000000000001'), ('rival_owner', 'a2000000-0000-4000-8000-000000000002'),
  ('euro_owner', 'a2000000-0000-4000-8000-000000000003'), ('quiet_owner', 'a2000000-0000-4000-8000-000000000004'),
  ('kma_owner', 'a2000000-0000-4000-8000-000000000011'), ('kma_finance', 'a2000000-0000-4000-8000-000000000012'),
  ('kma_operations', 'a2000000-0000-4000-8000-000000000013'), ('kma_analyst', 'a2000000-0000-4000-8000-000000000014'),
  ('kma_support', 'a2000000-0000-4000-8000-000000000015'),
  ('ada', 'a2000000-0000-4000-8000-000000000021'), ('ben', 'a2000000-0000-4000-8000-000000000022'),
  ('cy', 'a2000000-0000-4000-8000-000000000023'), ('dee', 'a2000000-0000-4000-8000-000000000024'),
  ('eve', 'a2000000-0000-4000-8000-000000000025'), ('fay', 'a2000000-0000-4000-8000-000000000026'),
  ('gus', 'a2000000-0000-4000-8000-000000000027'), ('hal', 'a2000000-0000-4000-8000-000000000028'),
  ('ada_analyst', 'a2000000-0000-4000-8000-000000000029'), ('stranger', 'a2000000-0000-4000-8000-000000000030'),
  ('creator_ada', 'a3000000-0000-4000-8000-000000000001'), ('creator_ben', 'a3000000-0000-4000-8000-000000000002'),
  ('creator_cy', 'a3000000-0000-4000-8000-000000000003'), ('creator_dee', 'a3000000-0000-4000-8000-000000000004'),
  ('creator_eve', 'a3000000-0000-4000-8000-000000000005'), ('creator_fay', 'a3000000-0000-4000-8000-000000000006'),
  ('creator_gus', 'a3000000-0000-4000-8000-000000000007'), ('creator_hal', 'a3000000-0000-4000-8000-000000000008');
insert into public.admin_users(user_id, role) values
  (pg_temp.q('kma_owner'), 'owner'), (pg_temp.q('kma_finance'), 'finance'), (pg_temp.q('kma_operations'), 'operations'),
  (pg_temp.q('kma_analyst'), 'analyst'), (pg_temp.q('kma_support'), 'support');
insert into public.affiliates(id, public_name, legal_name, slug, status) values
  (pg_temp.q('creator_ada'), 'Ada Okafor', 'Ada N. Okafor', 'ada-okafor', 'active'),
  (pg_temp.q('creator_ben'), 'Ben Creator', null, 'ben-creator', 'active'),
  (pg_temp.q('creator_cy'), 'Cy Park', null, 'cy-park', 'active'),
  (pg_temp.q('creator_dee'), 'Dee Vale', null, 'dee-vale', 'active'),
  (pg_temp.q('creator_eve'), 'Eve Stone', null, 'eve-stone', 'active'),
  (pg_temp.q('creator_fay'), 'Fay Lind', null, 'fay-lind', 'active'),
  (pg_temp.q('creator_gus'), 'Gus Hale', null, 'gus-hale', 'active'),
  (pg_temp.q('creator_hal'), 'Hal Moss', null, 'hal-moss', 'active');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at)
  select pg_temp.q('creator_' || c), pg_temp.q(c), 'owner', true, false, now()
  from unnest(array['ada', 'ben', 'cy', 'dee', 'eve', 'fay', 'gus', 'hal']) c;
-- Ada's creator account has a second person who only reads the numbers.
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at)
  values (pg_temp.q('creator_ada'), pg_temp.q('ada_analyst'), 'analyst', true, false, now());
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true,
    program_money_enabled = false, program_fee_bps = 1000, program_min_deposit_minor = 5000,
    program_payouts_enabled = false, program_min_payout_minor = 2500;

-- Workspaces and programs, published while program money is still off --------------------------
select pg_temp.sign_in('owner');
insert into qa select 'acme', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('rival_owner');
insert into qa select 'rival', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('euro_owner');
insert into qa select 'euro', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('quiet_owner');
insert into qa select 'quiet', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
select pg_temp.connect('acme', 'acct_SpeakSix', 'SpeakSix Ltd');
select pg_temp.connect('rival', 'acct_Rival', 'Rival Media');
select pg_temp.connect('euro', 'acct_Lingot', 'Lingot SAS');
select pg_temp.connect('quiet', 'acct_Quiet', 'Quiet Club');
-- SpeakSix pays 30%, Rival Reader 20%, Lingot 25% in euros, Quiet Club 20%; all for every payment.
select pg_temp.publish('owner', 'acme', '{"name":"SpeakSix","category":"education","tagline":"Speak English in six weeks.",
  "landing_url":"https://speaksix.com/start","commission_type":"percent","commission_rate_bps":3000,
  "commission_duration":"lifetime"}');
select pg_temp.publish('rival_owner', 'rival', '{"name":"Rival Reader","category":"entertainment","tagline":"Stories worth an evening.",
  "landing_url":"https://rivalreader.co/","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"lifetime","hold_days":14}');
select pg_temp.publish('euro_owner', 'euro', '{"name":"Lingot","category":"education","tagline":"Le francais en un mois.",
  "landing_url":"https://lingot.fr/","commission_type":"percent","commission_rate_bps":2500,"currency":"EUR",
  "commission_duration":"lifetime","hold_days":14}');
select pg_temp.publish('quiet_owner', 'quiet', '{"name":"Quiet Club","category":"lifestyle","tagline":"A calmer phone.",
  "landing_url":"https://quietclub.io/join","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"lifetime","hold_days":14}');
select pg_temp.check((select bool_and(p.status = 'live') and count(*) = 4 from public.affiliate_programs p),
  'four programs are live');

-- Ada is in three programs. Fay joined and has sold nothing. Hal has only asked to join.
select pg_temp.check(pg_temp.join(j.creator, j.workspace)->'membership'->>'status' = 'active',
  format('%s joins %s', j.creator, j.workspace))
from (values ('ada', 'acme'), ('ada', 'rival'), ('ada', 'euro'), ('ben', 'acme'), ('cy', 'acme'), ('dee', 'acme'),
  ('eve', 'rival'), ('fay', 'acme'), ('gus', 'quiet')) j(creator, workspace);
insert into qa values ('click_ada', pg_temp.click('ada', 'acme')), ('click_ben', pg_temp.click('ben', 'acme')),
  ('click_cy', pg_temp.click('cy', 'acme')), ('click_dee', pg_temp.click('dee', 'acme')),
  ('click_eve', pg_temp.click('eve', 'rival')), ('click_gus', pg_temp.click('gus', 'quiet'));
update public.affiliate_program_members set activated_at = pg_temp.ago('500 days');
insert into public.affiliate_program_members(program_id, affiliate_id, status, terms_version, joined_by, requested_at)
  select p.id, pg_temp.q('creator_hal'), 'pending', 1, pg_temp.q('hal'), now() from pg_temp.program('acme') p;
select set_config('request.jwt.claims', '', true);

-- Program money on; no balance yet, so no platform --------------------------------------------------
select pg_temp.money(true);
select pg_temp.capture('get_admin_program_payouts.no_platform', pg_temp.keep('no_platform', pg_temp.panel('kma_owner')));
select pg_temp.check((select a - 'updated_at' = '{"enabled":false,"money_enabled":true,"min_payout_minor":2500,"platform":null,
      "creators":[],"open":[],"recent":[],
      "totals":{"ready_minor_by_currency":{},"ready_count":0,"waiting_minor_by_currency":{},"paid_minor_by_currency":{}}}'::jsonb
      and (a->>'updated_at')::timestamptz = (select updated_at from public.platform_settings)
    from (select pg_temp.kept('no_platform') as a) x),
  'before any program has a balance the panel is empty and names no platform');
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.configure_sql(jsonb_build_object('enabled', true,
    'expected_updated_at', pg_temp.kept('no_platform')->'updated_at'))) = '22023 no_platform'
  and (select not program_payouts_enabled from public.platform_settings)
  and pg_temp.n('public.external_settlement_platforms') = 0,
  'payouts cannot be switched on before a program has a balance to pay from');

-- Balances on the KissMyApps platform, and approved commissions --------------------------------------
select pg_temp.open_account('acme', 'owner'), pg_temp.open_account('rival', 'rival_owner'), pg_temp.open_account('euro', 'euro_owner');
-- Quiet Club's balance was made before balances named their platform.
insert into public.program_balance_accounts(program_id, workspace_id, currency)
  select p.id, p.workspace_id, 'USD' from pg_temp.program('quiet') p;
select pg_temp.fund('acme', 100000), pg_temp.fund('rival', 50000), pg_temp.fund('euro', 50000), pg_temp.fund('quiet', 50000);
select pg_temp.check((select count(*) = 3 and bool_and(a.platform_account_id = 'acct_KMAPlatform')
    from public.program_balance_accounts a where a.platform_account_id is not null)
  and (pg_temp.account('euro')).currency = 'EUR' and (pg_temp.account('quiet')).platform_account_id is null,
  'three balances are on the KissMyApps platform, one of them in euros; one old balance names no platform');
select pg_temp.earn('s_ada_acme', 'acme', 'ada', 10000);
select pg_temp.earn('s_ada_rival', 'rival', 'ada', 7050);
select pg_temp.earn('s_ada_euro', 'euro', 'ada', 12000);
select pg_temp.earn('s_ben', 'acme', 'ben', 3000);
select pg_temp.earn('s_cy', 'acme', 'cy', 10000);
select pg_temp.earn('s_dee', 'acme', 'dee', 12000);
select pg_temp.earn('s_eve', 'rival', 'eve', 20000);
select pg_temp.earn('s_gus', 'quiet', 'gus', 10000);
select pg_temp.check(pg_temp.owed('ada', 'acme') = 3000 and pg_temp.owed('ada', 'rival') = 1410 and pg_temp.owed('ada', 'euro') = 3000
  and pg_temp.owed('ben', 'acme') = 900 and pg_temp.owed('cy', 'acme') = 3000 and pg_temp.owed('dee', 'acme') = 3600
  and pg_temp.owed('eve', 'rival') = 4000 and pg_temp.owed('gus', 'quiet') = 2000
  and pg_temp.n('public.program_creator_entries') = 8 and pg_temp.n('public.program_commissions where status = ''approved''') = 8,
  'eight approved commissions: Ada has 30.00 and 14.10 in dollars from two programs and 30.00 in euros from a third');

-- Closed by default ----------------------------------------------------------------------------
select pg_temp.check((select bool_and(not has_table_privilege(r, t, p))
  from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['public.program_payouts', 'public.program_payout_items', 'kma_internal.program_payout_schedule']) t,
    unnest(array['select', 'insert', 'update', 'delete']) p)
  and (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.program_payouts'::regclass, 'public.program_payout_items'::regclass))
  and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('program_payouts', 'program_payout_items')),
  'no API role can read or write payouts, their items or the schedule; both tables have row security and no policy');
select pg_temp.check((select count(*) = 5 and bool_and(has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('program_creator_payout_context', 'partner_program_earnings',
    'get_admin_program_payouts', 'perform_admin_program_payout', 'configure_admin_program_payouts')),
  'signed-in users may call the creator context, the creator read and the three admin functions; each is security '
    || 'definer with an empty search path');
select pg_temp.check((select count(*) = 4 and bool_and(has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('claim_program_payouts', 'begin_program_payout', 'finish_program_payout',
    'program_payout_health')),
  'only the service role may claim, begin and finish payouts and read the operator view');
select pg_temp.check((select count(*) = 11 and bool_and(not has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'kma_internal' and (p.proname like 'program\_payout%' or p.proname = 'tick_program_payout_schedule')),
  'the eleven internal payout functions, the schedule tick among them, are closed to every API role');
select pg_temp.check(pg_temp.try_signed_out(r, s) = '42501', format('%s cannot run %s', r, left(s, 70)))
from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array[
  'select kma_internal.program_payouts_enabled()', 'select kma_internal.program_payout_platform()',
  'select kma_internal.program_payouts_json()', 'select kma_internal.tick_program_payout_schedule()',
  format('select kma_internal.program_payout_make(''acct_KMAPlatform'', %L, ''USD'', 1, %L, ''pay'')', gen_random_uuid(), gen_random_uuid()),
  format('select kma_internal.program_payout_check(%L)', gen_random_uuid()),
  'select * from kma_internal.program_payout_candidates(''acct_KMAPlatform'')',
  'select * from kma_internal.program_payout_sums(''acct_KMAPlatform'')']) s;
select pg_temp.check(pg_temp.try_signed_out('anon', s) = '42501', format('nobody signed in cannot run %s', left(s, 70)))
from unnest(array['select public.get_admin_program_payouts()', 'select public.perform_admin_program_payout(''{}'')',
  'select public.configure_admin_program_payouts(''{}'')', pg_temp.context_sql(), 'select public.partner_program_earnings()',
  'select public.claim_program_payouts(''{"platform_account_id":"acct_KMAPlatform"}'')',
  'select public.begin_program_payout(''{}'')', 'select public.finish_program_payout(''{}'')',
  'select public.program_payout_health()']) s;
select pg_temp.check(pg_temp.try_signed_out('authenticated', 'select public.get_admin_program_payouts()') = '28000'
  and pg_temp.try_signed_out('authenticated', 'select public.perform_admin_program_payout(''{}'')') = '28000'
  and pg_temp.try_signed_out('authenticated', 'select public.configure_admin_program_payouts(''{}'')') = '28000'
  and pg_temp.try_signed_out('authenticated', pg_temp.context_sql()) = '42501'
  and pg_temp.try_signed_out('authenticated', 'select public.claim_program_payouts(''{"platform_account_id":"acct_KMAPlatform"}'')') = '42501'
  and pg_temp.try_signed_out('authenticated', 'select public.finish_program_payout(''{}'')') = '42501'
  and pg_temp.try_signed_out('authenticated', 'select public.program_payout_health()') = '42501'
  and pg_temp.try_signed_out('service_role', 'select public.get_admin_program_payouts()') = '42501'
  and pg_temp.try_signed_out('service_role', 'select public.perform_admin_program_payout(''{}'')') = '42501'
  and pg_temp.try_signed_out('service_role', 'select public.configure_admin_program_payouts(''{}'')') = '42501'
  and pg_temp.try_signed_out('service_role', pg_temp.context_sql()) = '42501',
  'a session without a user reaches no admin function, a browser never reaches the worker functions, and the '
    || 'service role never reaches the admin or creator ones');

-- Payouts switched off --------------------------------------------------------------------------------
select pg_temp.capture('get_admin_program_payouts.off', pg_temp.keep('off', pg_temp.panel('kma_operations')));
select pg_temp.check((select pg_temp.keys(a) = array['creators', 'enabled', 'min_payout_minor', 'money_enabled', 'open',
        'platform', 'recent', 'totals', 'updated_at']
      and a @> '{"enabled":false,"money_enabled":true,"min_payout_minor":2500,"open":[],"recent":[],
        "platform":{"account_id":"acct_KMAPlatform","registered":false,"enabled":false}}'
      and pg_temp.roll(a) = 'Ada Okafor EUR 3000 payouts_off; Ada Okafor USD 4410 payouts_off; Ben Creator USD 900 payouts_off; '
        || 'Cy Park USD 3000 payouts_off; Dee Vale USD 3600 payouts_off; Eve Stone USD 4000 payouts_off'
      and a->'totals' = '{"ready_minor_by_currency":{"EUR":0,"USD":0},"ready_count":0,
        "waiting_minor_by_currency":{"EUR":3000,"USD":15910},"paid_minor_by_currency":{"EUR":0,"USD":0}}'::jsonb
    from (select pg_temp.kept('off') as a) x),
  'with payouts off the panel lists what every creator has coming on the platform and says payouts are off; a balance '
    || 'that names no platform is left out');
select pg_temp.check(pg_temp.try('ada', pg_temp.context_sql()) = '42501 payouts_off'
  and pg_temp.try('kma_finance', pg_temp.pay_sql('ada', 'USD', 4410)) = '22023 not_payable'
  and pg_temp.message('kma_finance', pg_temp.pay_sql('ada', 'USD', 4410)) like '%payouts_off'
  and pg_temp.try('kma_finance', pg_temp.act_sql('{"action":"pay_ready","currency":"USD","expected_count":5,"expected_total_minor":15910}'))
    = '22023 amount_changed'
  and pg_temp.claim() = '{"payouts":[]}'
  and pg_temp.n('public.program_payouts') = 0 and pg_temp.n('public.external_creator_accounts') = 0,
  'with payouts off a creator cannot open a payout account and nobody can be paid');
select pg_temp.capture('partner_program_earnings.payouts_off', pg_temp.keep('earnings_off', pg_temp.earnings('ada')));
select pg_temp.check((select pg_temp.keys(e) = array['payout', 'payouts', 'programs', 'recent']
      and e->'payouts' = '[]'::jsonb
      and e->'payout' = '{"enabled":false,"min_payout_minor":2500,"platform_account_id":"acct_KMAPlatform",
        "payable":[{"currency":"EUR","amount_minor":3000},{"currency":"USD","amount_minor":4410}]}'::jsonb
      and (select bool_and(pg_temp.keys(p) = array['approved_minor', 'currency', 'events', 'name', 'next_release_at', 'paid_minor',
          'paying_minor', 'pending_minor', 'program_id', 'sales', 'slug']) from jsonb_array_elements(e->'programs') p)
      and pg_temp.line(e, 'SpeakSix') @> '{"currency":"USD","pending_minor":0,"approved_minor":3000,"paying_minor":0,"paid_minor":0,"sales":1}'
      and pg_temp.line(e, 'Lingot') @> '{"currency":"EUR","approved_minor":3000,"paying_minor":0,"paid_minor":0}'
      and jsonb_array_length(e->'recent') = 3
    from (select pg_temp.kept('earnings_off') as e) x),
  'with payouts off the creator still reads their earnings, with no payouts and the payout account switched off');

-- The switch ---------------------------------------------------------------------------------------------
insert into qa select 'settings_at', pg_temp.panel('kma_owner')->>'updated_at';
select pg_temp.check(pg_temp.try(who, pg_temp.configure_sql(jsonb_build_object('enabled', true,
    'expected_updated_at', pg_temp.t('settings_at')))) = '42501', format('%s cannot switch payouts on', who))
from unnest(array['kma_finance', 'kma_operations', 'kma_analyst', 'kma_support', 'owner', 'ada', 'stranger']) who;
select pg_temp.check(pg_temp.try_by_link('kma_owner', pg_temp.configure_sql(jsonb_build_object('enabled', true,
    'expected_updated_at', pg_temp.t('settings_at')))) = '42501',
  'the owner cannot switch payouts on from a session opened by an emailed link');
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.configure_sql(i)) = e, format('the switch refuses %s with %s', i, e))
from (values
  ('{"enabled":true}'::jsonb, '22023 invalid_input'),
  ('[]', '22023 invalid_input'),
  (jsonb_build_object('enabled', true, 'expected_updated_at', pg_temp.t('settings_at'), 'mode', 'live'), '22023 invalid_input'),
  (jsonb_build_object('enabled', 'yes', 'expected_updated_at', pg_temp.t('settings_at')), '22023 invalid_enabled'),
  (jsonb_build_object('min_payout_minor', 99, 'expected_updated_at', pg_temp.t('settings_at')), '22023 invalid_min_payout_minor'),
  (jsonb_build_object('min_payout_minor', 100000001, 'expected_updated_at', pg_temp.t('settings_at')), '22023 invalid_min_payout_minor'),
  (jsonb_build_object('min_payout_minor', 25.5, 'expected_updated_at', pg_temp.t('settings_at')), '22023 invalid_min_payout_minor'),
  (jsonb_build_object('min_payout_minor', '2500', 'expected_updated_at', pg_temp.t('settings_at')), '22023 invalid_min_payout_minor'),
  (jsonb_build_object('enabled', true, 'expected_updated_at', 7), '22023 invalid_expected_updated_at'),
  (jsonb_build_object('enabled', true, 'expected_updated_at', 'yesterday-ish'), '22023 invalid_expected_updated_at'),
  (jsonb_build_object('enabled', true, 'expected_updated_at', null), '40001 settings_changed'),
  (jsonb_build_object('enabled', true, 'expected_updated_at', pg_temp.ago('1 hour')), '40001 settings_changed')) v(i, e);
select pg_temp.money(false);
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.configure_sql(jsonb_build_object('enabled', true,
    'expected_updated_at', (select updated_at from public.platform_settings)))) = '22023 money_disabled'
  and (select not program_payouts_enabled from public.platform_settings)
  and pg_temp.n('public.external_settlement_platforms') = 0,
  'payouts cannot be switched on while program money is off, and a refused change registers no platform');
select pg_temp.money(true);
-- The smallest payout can be set before the switch is on.
select pg_temp.keep('minimum', pg_temp.call('kma_owner', pg_temp.configure_sql(jsonb_build_object('min_payout_minor', 5000,
  'expected_updated_at', (select updated_at from public.platform_settings)))));
select pg_temp.check(pg_temp.kept('minimum') @> '{"enabled":false,"min_payout_minor":5000}'
  and pg_temp.n('public.external_settlement_platforms') = 0,
  'the owner changes the smallest payout alone; the switch stays off');
select pg_temp.capture('configure_admin_program_payouts.on', pg_temp.keep('on', pg_temp.call('kma_owner',
  pg_temp.configure_sql(jsonb_build_object('enabled', true, 'min_payout_minor', 2500,
    'expected_updated_at', pg_temp.kept('minimum')->'updated_at')))));
select pg_temp.check((select a @> '{"enabled":true,"money_enabled":true,"min_payout_minor":2500,
        "platform":{"account_id":"acct_KMAPlatform","registered":true,"enabled":true}}'
      and pg_temp.keys(a) = pg_temp.keys(pg_temp.kept('off'))
      and (a->>'updated_at')::timestamptz > (pg_temp.kept('minimum')->>'updated_at')::timestamptz
      and pg_temp.roll(a) = 'Ada Okafor EUR 3000 no_account; Ada Okafor USD 4410 no_account; Ben Creator USD 900 no_account; '
        || 'Cy Park USD 3000 no_account; Dee Vale USD 3600 no_account; Eve Stone USD 4000 no_account'
    from (select pg_temp.kept('on') as a) x)
  and (select count(*) = 1 and bool_and(x.platform_account_id = 'acct_KMAPlatform' and x.livemode and x.enabled)
    from public.external_settlement_platforms x)
  and pg_temp.try('kma_owner', pg_temp.configure_sql(jsonb_build_object('min_payout_minor', 100,
    'expected_updated_at', pg_temp.kept('minimum')->'updated_at'))) = '40001 settings_changed',
  'the owner switches payouts on: the platform is registered for creator payout accounts, and the old read can no longer save');
select pg_temp.check((select count(*) = 2 and bool_and(a.actor_type = 'admin' and a.actor_user_id = pg_temp.q('kma_owner')
      and a.before_data ?& array['enabled', 'min_payout_minor'] and a.after_data ?& array['enabled', 'min_payout_minor'])
      and bool_or(a.before_data->>'enabled' = 'false' and a.after_data->>'enabled' = 'true'
        and a.metadata->>'platform_registered' = 'acct_KMAPlatform')
    from public.audit_logs a where a.action = 'program_payouts_configured' and a.target_table = 'platform_settings'),
  'both changes of the settings are in the audit log with who made them, before and after');
-- A platform the older settlement system registered and switched off stays exactly as it is.
select pg_temp.call('kma_owner', pg_temp.configure_sql(jsonb_build_object('enabled', false,
  'expected_updated_at', (select updated_at from public.platform_settings))));
update public.external_settlement_platforms set enabled = false, revision = 7 where platform_account_id = 'acct_KMAPlatform';
select pg_temp.keep('platform_off', pg_temp.call('kma_owner', pg_temp.configure_sql(jsonb_build_object('enabled', true,
  'expected_updated_at', (select updated_at from public.platform_settings)))));
select pg_temp.check((select a @> '{"enabled":true,"platform":{"account_id":"acct_KMAPlatform","registered":true,"enabled":false}}'
      and pg_temp.roll(a) like 'Ada Okafor EUR 3000 platform_not_ready; Ada Okafor USD 4410 platform_not_ready; %'
      and a->'totals'->>'ready_count' = '0'
    from (select pg_temp.kept('platform_off') as a) x)
  and (select count(*) = 1 and bool_and(not x.enabled and x.revision = 7) from public.external_settlement_platforms x)
  and pg_temp.try('ada', pg_temp.context_sql()) = '42501 platform_not_ready'
  and pg_temp.try('kma_finance', pg_temp.pay_sql('ada', 'USD', 4410)) = '22023 not_payable'
  and pg_temp.message('kma_finance', pg_temp.pay_sql('ada', 'USD', 4410)) like '%platform_not_ready',
  'switching on never changes a platform that is already registered: while it is disabled nobody connects and nobody is paid');
update public.external_settlement_platforms set enabled = true where platform_account_id = 'acct_KMAPlatform';

-- The creator's payout account ----------------------------------------------------------------------------
select pg_temp.check(pg_temp.try('ada', pg_temp.context_sql('acct_KMAPlatform', false)) = '42501 not_live'
  and pg_temp.try('ada', 'select public.program_creator_payout_context(''acct_KMAPlatform'', null)') = '42501 not_live'
  and pg_temp.try('ada_analyst', pg_temp.context_sql()) = '42501 role_required'
  and pg_temp.try('gus', pg_temp.context_sql()) = '42501 no_program'
  and pg_temp.try('ada', pg_temp.context_sql('acct_Elsewhere')) = '42501 no_program'
  and pg_temp.try('ada', 'select public.program_creator_payout_context(null, true)') = '42501 no_program'
  and pg_temp.try('stranger', pg_temp.context_sql()) = '42501'
  and pg_temp.try('owner', pg_temp.context_sql()) = '42501'
  and pg_temp.try('kma_owner', pg_temp.context_sql()) = '42501'
  and pg_temp.n('public.external_creator_accounts') = 0,
  'the payout account is refused outside live mode, to a member who is not owner or finance, to a creator with no '
    || 'program on the platform, on another platform, and to anybody who is not a creator; a refusal makes no account');
select pg_temp.capture('program_creator_payout_context', pg_temp.keep('context', pg_temp.call('ada', pg_temp.context_sql())));
select pg_temp.check((select c @> jsonb_build_object('affiliate_id', pg_temp.q('creator_ada'), 'platform_account_id', 'acct_KMAPlatform',
        'livemode', true, 'status', 'not_connected', 'connect_account_id', null, 'country', null)
      and c->>'account_key' = c->>'id' and c->>'created_at' is not null
      and pg_temp.keys(c) = (select array_agg(k order by k) from (
        select a.attname::text as k from pg_attribute a
        where a.attrelid = 'public.external_creator_accounts'::regclass and a.attnum > 0 and not a.attisdropped
        union select 'account_key') s)
    from (select pg_temp.kept('context') as c) x)
  and pg_temp.call('ada', pg_temp.context_sql()) = pg_temp.kept('context')
  and pg_temp.n('public.external_creator_accounts') = 1,
  'a creator in a program gets their payout account, made on first use and the same one after: the account row and its '
    || 'key, the shape the older creator_connect_context answers with');
select pg_temp.check(pg_temp.try('fay', pg_temp.context_sql()) = 'ok' and pg_temp.try('hal', pg_temp.context_sql()) = 'ok'
  and (pg_temp.payout_account('fay')).status = 'not_connected' and (pg_temp.payout_account('hal')).status = 'not_connected',
  'a member who has earned nothing yet, and a creator who has only asked to join, may set up the account too');
-- A member who was let go keeps the account they are still owed through.
update public.affiliate_program_members set status = 'removed', ended_at = now()
  where affiliate_id = pg_temp.q('creator_dee') and program_id = (pg_temp.program('acme')).id;
select pg_temp.check(pg_temp.try('dee', pg_temp.context_sql()) = 'ok', 'a creator whose membership ended still reaches the account');

-- Each creator's account, as Stripe onboarding leaves it. Cy never opens the card.
select pg_temp.keep('ada_account', pg_temp.onboard('ada', 'acct_AdaPay', 'ready'));
select pg_temp.onboard('ben', 'acct_BenPay', 'ready'), pg_temp.onboard('dee', 'acct_DeePay', 'pending'),
  pg_temp.onboard('eve', 'acct_EvePay', 'ready', 'GB');
select pg_temp.check(pg_temp.kept('ada_account') @> '{"status":"ready","connect_account_id":"acct_AdaPay","country":"US"}'
  and (pg_temp.payout_account('ben')).status = 'ready' and (pg_temp.payout_account('dee')).status = 'pending'
  and (pg_temp.payout_account('eve')).status = 'ready' and (pg_temp.payout_account('eve')).country = 'GB'
  and (pg_temp.payout_account('cy')).id is null
  and pg_temp.call('ada', pg_temp.context_sql()) @> '{"status":"ready","connect_account_id":"acct_AdaPay"}',
  'the older reserve and set functions work on an account made here, and the context then answers with the connected account');

-- Who can be paid ------------------------------------------------------------------------------------------
select pg_temp.capture('get_admin_program_payouts.ready', pg_temp.keep('ready', pg_temp.panel()));
select pg_temp.check((select pg_temp.roll(a) = 'Ada Okafor EUR 3000 ready; Ada Okafor USD 4410 ready; Eve Stone USD 4000 ready; '
        || 'Ben Creator USD 900 below_minimum; Cy Park USD 3000 no_account; Dee Vale USD 3600 account_not_ready'
      and a->'totals' = '{"ready_minor_by_currency":{"EUR":3000,"USD":8410},"ready_count":3,
        "waiting_minor_by_currency":{"EUR":0,"USD":7500},"paid_minor_by_currency":{"EUR":0,"USD":0}}'::jsonb
      and a->'open' = '[]'::jsonb and a->'recent' = '[]'::jsonb
    from (select pg_temp.kept('ready') as a) x),
  'creators who can be paid now come first, then the others by name, each with the first thing in the way; the totals '
    || 'add up per currency');
select pg_temp.check((select (select bool_and(pg_temp.keys(c) = array['account_country', 'account_status', 'affiliate_id', 'blocker',
          'currency', 'name', 'payable_minor', 'programs']) from jsonb_array_elements(a->'creators') c)
      and pg_temp.listed(a, 'ada') = jsonb_build_object('affiliate_id', pg_temp.q('creator_ada'), 'name', 'Ada Okafor',
        'currency', 'USD', 'payable_minor', 4410, 'account_status', 'ready', 'account_country', 'US', 'blocker', null,
        'programs', jsonb_build_array(
          jsonb_build_object('program_id', (pg_temp.program('rival')).id, 'name', 'Rival Reader', 'amount_minor', 1410),
          jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'name', 'SpeakSix', 'amount_minor', 3000)))
      and pg_temp.listed(a, 'ada', 'EUR') @> '{"payable_minor":3000,"programs":[{"name":"Lingot","amount_minor":3000}]}'
      and pg_temp.listed(a, 'cy') @> '{"account_status":"not_connected","account_country":null,"blocker":"no_account"}'
      and pg_temp.listed(a, 'dee') @> '{"account_status":"pending","account_country":"US","blocker":"account_not_ready"}'
      and pg_temp.listed(a, 'eve') @> '{"account_status":"ready","account_country":"GB"}'
      and pg_temp.listed(a, 'gus') is null and pg_temp.listed(a, 'fay') is null
      and a::text !~ '@|Ada N\.|acct_(Ada|Ben|Dee|Eve)|requirements'
    from (select pg_temp.kept('ready') as a) x),
  'a creator''s row has their public name, the amount per program by program name, the account status and country, and '
    || 'no email, legal name, Stripe account or requirement');
select pg_temp.check(pg_temp.panel(who) - 'updated_at' = pg_temp.kept('ready') - 'updated_at', format('%s reads the panel', who))
from unnest(array['kma_owner', 'kma_finance', 'kma_operations', 'kma_analyst']) who;
select pg_temp.check(pg_temp.try(who, 'select public.get_admin_program_payouts()') = '42501', format('%s cannot read the panel', who))
from unnest(array['kma_support', 'owner', 'ada', 'stranger']) who;
-- The other blockers, one at a time.
select pg_temp.call('cy', pg_temp.context_sql());
select pg_temp.check(pg_temp.blocker('cy') = 'no_account' and (pg_temp.payout_account('cy')).status = 'not_connected',
  'a creator who opened the card and went no further still has no account');
select pg_temp.onboard('dee', 'acct_DeePay', 'restricted');
select pg_temp.check((select c @> '{"account_status":"restricted","blocker":"account_not_ready"}'
  from (select pg_temp.listed(pg_temp.panel(), 'dee') as c) x), 'an account Stripe has restricted is not ready');
select pg_temp.onboard('dee', 'acct_DeePay', 'pending');
select pg_temp.call('kma_owner', pg_temp.configure_sql(jsonb_build_object('min_payout_minor', 900,
  'expected_updated_at', (select updated_at from public.platform_settings))));
select pg_temp.check(pg_temp.blocker('ben') = 'ready', 'a sum that is exactly the smallest payout can be paid');
select pg_temp.call('kma_owner', pg_temp.configure_sql(jsonb_build_object('min_payout_minor', 2500,
  'expected_updated_at', (select updated_at from public.platform_settings))));
select pg_temp.check(pg_temp.blocker('ben') = 'below_minimum', 'and one cent less cannot');

select pg_temp.capture('partner_program_earnings.before', pg_temp.keep('earnings_before', pg_temp.earnings('ada')));
select pg_temp.check((select e->'payout' = '{"enabled":true,"min_payout_minor":2500,"platform_account_id":"acct_KMAPlatform",
        "payable":[{"currency":"EUR","amount_minor":3000},{"currency":"USD","amount_minor":4410}]}'::jsonb
      and e->'payouts' = '[]'::jsonb and e - 'payout' = pg_temp.kept('earnings_off') - 'payout'
    from (select pg_temp.kept('earnings_before') as e) x)
  and (select e->'payout' = '{"enabled":true,"min_payout_minor":2500,"platform_account_id":null,"payable":[]}'::jsonb
      and pg_temp.line(e, 'Quiet Club') @> '{"approved_minor":2000,"paying_minor":0,"paid_minor":0}'
    from (select pg_temp.earnings('gus') as e) x)
  and (select e->'payout' @> '{"platform_account_id":"acct_KMAPlatform","payable":[]}' and e->'programs' = '[]'::jsonb
    from (select pg_temp.earnings('fay') as e) x),
  'before any payout a creator sees what can be paid per currency and the smallest payout; a creator with no program '
    || 'on the platform is offered no payout account, a new member is');

-- Paying one creator: refusals ------------------------------------------------------------------------------
select pg_temp.check(pg_temp.try(who, pg_temp.pay_sql('ada', 'USD', 4410)) = '42501', format('%s cannot pay', who))
from unnest(array['kma_operations', 'kma_analyst', 'kma_support', 'owner', 'ada', 'stranger']) who;
select pg_temp.check(pg_temp.try_by_link('kma_finance', pg_temp.pay_sql('ada', 'USD', 4410)) = '42501'
  and pg_temp.try_by_link('kma_owner', pg_temp.act_sql('{"action":"cancel","payout_id":"a2000000-0000-4000-8000-000000000001"}')) = '42501',
  'paying and canceling need a session the admin opened by signing in, not one opened by an emailed link');
select pg_temp.check(pg_temp.try('kma_finance', pg_temp.act_sql(i)) = '22023 invalid_input', format('paying refuses %s', i))
from (values
  ('{}'::jsonb), ('[]'), ('"pay"'), ('{"action":"send"}'), ('{"action":7}'),
  (jsonb_build_object('action', 'pay', 'affiliate_id', pg_temp.q('creator_ada'), 'currency', 'USD')),
  (jsonb_build_object('action', 'pay', 'affiliate_id', pg_temp.q('creator_ada'), 'currency', 'USD', 'expected_amount_minor', 4410, 'livemode', false)),
  (jsonb_build_object('action', 'pay', 'affiliate_id', 'ada', 'currency', 'USD', 'expected_amount_minor', 4410)),
  (jsonb_build_object('action', 'pay', 'affiliate_id', pg_temp.q('creator_ada'), 'currency', 'usd', 'expected_amount_minor', 4410)),
  (jsonb_build_object('action', 'pay', 'affiliate_id', pg_temp.q('creator_ada'), 'currency', 'USD', 'expected_amount_minor', 0)),
  (jsonb_build_object('action', 'pay', 'affiliate_id', pg_temp.q('creator_ada'), 'currency', 'USD', 'expected_amount_minor', 44.1)),
  (jsonb_build_object('action', 'pay', 'affiliate_id', pg_temp.q('creator_ada'), 'currency', 'USD', 'expected_amount_minor', '4410')),
  ('{"action":"pay_ready","currency":"USD","expected_count":2}'),
  ('{"action":"pay_ready","currency":"USD","expected_count":0,"expected_total_minor":8410}'),
  ('{"action":"pay_ready","currency":"dollars","expected_count":2,"expected_total_minor":8410}'),
  ('{"action":"pay_ready","currency":"USD","expected_count":2,"expected_total_minor":8410,"affiliate_id":null}'),
  ('{"action":"cancel"}'), ('{"action":"cancel","payout_id":"p1"}'),
  ('{"action":"cancel","payout_id":"a2000000-0000-4000-8000-000000000001","reason":"x"}')) v(i);
select pg_temp.check(pg_temp.try('kma_finance', pg_temp.pay_sql('ada', 'USD', 4409)) = '22023 amount_changed'
  and pg_temp.try('kma_finance', pg_temp.pay_sql('ada', 'USD', 7410)) = '22023 amount_changed'
  and pg_temp.try('kma_finance', pg_temp.pay_sql('ada', 'GBP', 4410)) = '22023 amount_changed'
  and pg_temp.try('kma_finance', pg_temp.pay_sql('gus', 'USD', 2000)) = '22023 amount_changed'
  and pg_temp.try('kma_finance', pg_temp.pay_sql('fay', 'USD', 1)) = '22023 amount_changed',
  'a payment is refused when the amount is not what the creator can be paid now in that currency on the platform');
select pg_temp.check(pg_temp.try('kma_finance', pg_temp.pay_sql(v.creator, 'USD', v.amount)) = '22023 not_payable'
  and pg_temp.message('kma_finance', pg_temp.pay_sql(v.creator, 'USD', v.amount)) = 'This creator cannot be paid now: ' || v.blocker,
  format('%s cannot be paid: %s', v.creator, v.blocker))
from (values ('ben', 900, 'below_minimum'), ('cy', 3000, 'no_account'), ('dee', 3600, 'account_not_ready')) v(creator, amount, blocker);
select pg_temp.check(pg_temp.n('public.program_payouts') = 0 and pg_temp.n('public.program_creator_entries') = 8
  and not pg_temp.holds_lock('eve', 'rival'), 'no refusal made a payout or moved a cent');

-- Paying one creator ---------------------------------------------------------------------------------------
select pg_temp.capture('perform_admin_program_payout.pay', pg_temp.keep('pay', pg_temp.call('kma_finance', pg_temp.pay_sql('ada', 'USD', 4410))));
insert into qa select 'p1', pg_temp.open_payout('ada');
select pg_temp.check((select p.status = 'approved' and p.amount_minor = 4410 and p.currency = 'USD'
      and p.platform_account_id = 'acct_KMAPlatform' and p.approved_by = pg_temp.q('kma_finance') and p.attempts = 0
      and p.connect_account_id is null and p.first_attempt_at is null and p.lease_token is null and p.closed_at is null
    from pg_temp.payout('p1') p)
  and (select count(*) = 2 and sum(i.amount_minor) = 4410
      and bool_and(i.amount_minor = case i.program_id when (pg_temp.program('acme')).id then 3000 else 1410 end)
    from public.program_payout_items i where i.payout_id = pg_temp.q('p1'))
  and (select count(*) = 2 and bool_and(e.kind = 'payout' and e.currency = 'USD' and e.affiliate_id = pg_temp.q('creator_ada')
      and e.amount_minor = -(select i.amount_minor from public.program_payout_items i where i.payout_id = e.payout_id and i.program_id = e.program_id))
    from public.program_creator_entries e where e.payout_id = pg_temp.q('p1'))
  and pg_temp.owed('ada', 'acme') = 0 and pg_temp.owed('ada', 'rival') = 0 and pg_temp.owed('ada', 'euro') = 3000
  and pg_temp.owed('eve', 'rival') = 4000,
  'one payout takes the whole 44.10 out of Ada''s two dollar programs, one item and one entry each; her euros and '
    || 'everybody else''s money stay where they are');
select pg_temp.check((select pg_temp.keys(a) = pg_temp.keys(pg_temp.kept('ready'))
      and pg_temp.roll(a) = 'Ada Okafor EUR 3000 ready; Eve Stone USD 4000 ready; '
        || 'Ben Creator USD 900 below_minimum; Cy Park USD 3000 no_account; Dee Vale USD 3600 account_not_ready'
      and jsonb_array_length(a->'open') = 1
      and pg_temp.keys(a->'open'->0) = array['affiliate_id', 'amount_minor', 'attempts', 'can_cancel', 'created_at', 'currency',
        'failure_code', 'id', 'name', 'next_attempt_at', 'status']
      and a->'open'->0 @> jsonb_build_object('id', pg_temp.q('p1'), 'affiliate_id', pg_temp.q('creator_ada'), 'name', 'Ada Okafor',
        'currency', 'USD', 'amount_minor', 4410, 'status', 'approved', 'attempts', 0, 'failure_code', null,
        'next_attempt_at', null, 'can_cancel', true)
      and a->'totals' = '{"ready_minor_by_currency":{"EUR":3000,"USD":4000},"ready_count":2,
        "waiting_minor_by_currency":{"EUR":0,"USD":7500},"paid_minor_by_currency":{"EUR":0,"USD":0}}'::jsonb
    from (select pg_temp.kept('pay') as a) x),
  'the answer is the panel afterwards: Ada''s dollars are on their way and can still be canceled');
select pg_temp.check(pg_temp.holds_lock('ada', 'acme') and pg_temp.holds_lock('ada', 'rival') and pg_temp.holds_lock('ada', 'euro')
  and not pg_temp.holds_lock('eve', 'rival') and not pg_temp.holds_lock('ben', 'acme'),
  'making the payout held the lock on each of Ada''s sums on the platform, and on nobody else''s');
select pg_temp.check((select count(*) = 1 and bool_and(a.actor_type = 'admin' and a.actor_user_id = pg_temp.q('kma_finance')
      and a.target_id = pg_temp.q('p1') and a.after_data @> '{"currency":"USD","amount_minor":4410}'
      and jsonb_array_length(a.after_data->'programs') = 2 and a.metadata = '{"via":"pay"}'::jsonb)
    from public.audit_logs a where a.action = 'program_payout_approved'),
  'the payout is in the audit log with who made it');
select pg_temp.capture('partner_program_earnings.during', pg_temp.keep('earnings_during', pg_temp.earnings('ada')));
select pg_temp.check((select pg_temp.line(e, 'SpeakSix') @> '{"approved_minor":0,"paying_minor":3000,"paid_minor":0}'
      and pg_temp.line(e, 'Rival Reader') @> '{"approved_minor":0,"paying_minor":1410,"paid_minor":0}'
      and pg_temp.line(e, 'Lingot') @> '{"approved_minor":3000,"paying_minor":0,"paid_minor":0}'
      and e->'payout'->'payable' = '[{"currency":"EUR","amount_minor":3000}]'::jsonb
      and jsonb_array_length(e->'payouts') = 1
      and pg_temp.keys(e->'payouts'->0) = array['amount_minor', 'created_at', 'currency', 'id', 'paid_at', 'status']
      and e->'payouts'->0 @> jsonb_build_object('id', pg_temp.q('p1'), 'amount_minor', 4410, 'currency', 'USD',
        'status', 'approved', 'paid_at', null)
      and e->'recent' = pg_temp.kept('earnings_before')->'recent'
    from (select pg_temp.kept('earnings_during') as e) x)
  and pg_temp.earnings('eve')->'payouts' = '[]'::jsonb,
  'while the payout is under way the creator sees the money as on its way, not as approved and not as paid');

-- Two payouts never overlap -----------------------------------------------------------------------------------
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.pay_sql('ada', 'USD', 4410)) = '22023 amount_changed',
  'the same payment pressed again is refused: the amount is no longer there');
select pg_temp.earn('s_ada_acme2', 'acme', 'ada', 10000);
select pg_temp.check((select c @> '{"payable_minor":3000,"blocker":"payout_open","account_status":"ready"}'
    from (select pg_temp.listed(pg_temp.panel(), 'ada') as c) x)
  and pg_temp.try('kma_finance', pg_temp.pay_sql('ada', 'USD', 3000)) = '22023 not_payable'
  and pg_temp.message('kma_finance', pg_temp.pay_sql('ada', 'USD', 3000)) like '%payout_open'
  and pg_temp.blocker('ada', 'EUR') = 'ready',
  'what a creator earns while a payout is under way waits for it; another currency does not');
select pg_temp.check(pg_temp.fails(format('insert into public.program_payouts(affiliate_id, platform_account_id, currency, amount_minor, approved_by) '
    || 'values (%L, ''acct_KMAPlatform'', ''USD'', 3000, %L)', pg_temp.q('creator_ada'), pg_temp.q('kma_owner'))) like '23505 %program_payouts_one_open%'
  and pg_temp.fails(format('insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, payout_id) '
    || 'values (%L, %L, ''USD'', ''payout'', -1, %L)', pg_temp.q('creator_ada'), (pg_temp.program('acme')).id, pg_temp.q('p1')))
    like '23505 %program_creator_one_payout%'
  and pg_temp.fails('update public.program_payout_items set amount_minor = 1') <> 'ok'
  and pg_temp.fails('delete from public.program_payout_items') <> 'ok',
  'the tables themselves refuse a second open payout for the creator and currency, a second taking from a program for '
    || 'one payout, and any change of a payout''s items');

-- Canceling ---------------------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.try(who, pg_temp.act_sql(jsonb_build_object('action', 'cancel', 'payout_id', pg_temp.q('p1')))) = '42501',
  format('%s cannot cancel', who))
from unnest(array['kma_operations', 'kma_analyst', 'kma_support', 'ada']) who;
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.act_sql(jsonb_build_object('action', 'cancel', 'payout_id', gen_random_uuid())))
  = '22023 not_cancelable', 'a payout that does not exist cannot be canceled');
select pg_temp.capture('perform_admin_program_payout.cancel', pg_temp.keep('cancel', pg_temp.call('kma_owner',
  pg_temp.act_sql(jsonb_build_object('action', 'cancel', 'payout_id', pg_temp.q('p1'))))));
select pg_temp.check((select p.status = 'canceled' and p.closed_at is not null and p.paid_at is null and p.transfer_id is null
    from pg_temp.payout('p1') p)
  and pg_temp.moved('p1', 'payout') = '2x-4410' and pg_temp.moved('p1', 'payout_reversed') = '2x4410'
  and (select bool_and(e.amount_minor = (select i.amount_minor from public.program_payout_items i
      where i.payout_id = e.payout_id and i.program_id = e.program_id))
    from public.program_creator_entries e where e.payout_id = pg_temp.q('p1') and e.kind = 'payout_reversed')
  and pg_temp.owed('ada', 'acme') = 6000 and pg_temp.owed('ada', 'rival') = 1410 and pg_temp.owed('ada', 'euro') = 3000,
  'a canceled payout gives each program''s amount back: Ada has her 44.10 again, next to what she earned meanwhile');
select pg_temp.check((select a->'open' = '[]'::jsonb and jsonb_array_length(a->'recent') = 1
      and pg_temp.keys(a->'recent'->0) = array['affiliate_id', 'amount_minor', 'closed_at', 'created_at', 'currency',
        'failure_code', 'id', 'name', 'status', 'transfer_id']
      and a->'recent'->0 @> jsonb_build_object('id', pg_temp.q('p1'), 'name', 'Ada Okafor', 'status', 'canceled',
        'amount_minor', 4410, 'currency', 'USD', 'failure_code', null, 'transfer_id', null)
      and pg_temp.listed(a, 'ada') @> '{"payable_minor":7410,"blocker":null}'
      and a->'totals' @> '{"ready_count":3,"ready_minor_by_currency":{"EUR":3000,"USD":11410},"paid_minor_by_currency":{"EUR":0,"USD":0}}'
    from (select pg_temp.kept('cancel') as a) x),
  'the answer shows the payout among the recent ones and the creator ready to be paid again, now 74.10');
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.act_sql(jsonb_build_object('action', 'cancel', 'payout_id', pg_temp.q('p1'))))
    = '22023 not_cancelable'
  and pg_temp.moved('p1', 'payout_reversed') = '2x4410'
  and pg_temp.fails(format('insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, payout_id) '
    || 'values (%L, %L, ''USD'', ''payout_reversed'', 1, %L)', pg_temp.q('creator_ada'), (pg_temp.program('acme')).id, pg_temp.q('p1')))
    like '23505 %program_creator_one_payout_reversal%',
  'a canceled payout cannot be canceled again, and the table refuses a second giving back');
select pg_temp.check((select count(*) = 1 and bool_and(a.actor_user_id = pg_temp.q('kma_owner') and a.target_id = pg_temp.q('p1')
      and a.before_data @> '{"status":"approved","amount_minor":4410}' and a.after_data = '{"status":"canceled"}'::jsonb)
    from public.audit_logs a where a.action = 'program_payout_canceled')
  and (select e->'payouts'->0 @> '{"status":"canceled","paid_at":null}'
      and pg_temp.line(e, 'SpeakSix') @> '{"approved_minor":6000,"paying_minor":0,"paid_minor":0}'
      and pg_temp.line(e, 'Rival Reader') @> '{"approved_minor":1410,"paying_minor":0,"paid_minor":0}'
    from (select pg_temp.earnings('ada') as e) x),
  'the cancel is in the audit log, and the creator sees the payout as not sent with the money back in approved');

-- Paying everyone who is ready ---------------------------------------------------------------------------------
select pg_temp.check(pg_temp.try('kma_finance', pg_temp.act_sql(i)) = '22023 amount_changed', format('paying all refuses %s', i))
from (values
  ('{"action":"pay_ready","currency":"USD","expected_count":3,"expected_total_minor":11410}'::jsonb),
  ('{"action":"pay_ready","currency":"USD","expected_count":2,"expected_total_minor":8410}'),
  ('{"action":"pay_ready","currency":"USD","expected_count":3,"expected_total_minor":14410}'),
  ('{"action":"pay_ready","currency":"GBP","expected_count":2,"expected_total_minor":11410}')) v(i);
select pg_temp.check(pg_temp.try('kma_operations', pg_temp.act_sql('{"action":"pay_ready","currency":"USD","expected_count":2,"expected_total_minor":11410}'))
  = '42501' and pg_temp.n('public.program_payouts where status = ''approved''') = 0,
  'paying everyone is refused to other roles, and a refusal pays nobody');
select pg_temp.capture('perform_admin_program_payout.pay_ready', pg_temp.keep('pay_ready', pg_temp.call('kma_owner',
  pg_temp.act_sql('{"action":"pay_ready","currency":"USD","expected_count":2,"expected_total_minor":11410}'))));
insert into qa select 'p2', pg_temp.open_payout('ada') union all select 'p3', pg_temp.open_payout('eve');
select pg_temp.check((select p.status = 'approved' and p.amount_minor = 7410 and p.approved_by = pg_temp.q('kma_owner') from pg_temp.payout('p2') p)
  and (select p.status = 'approved' and p.amount_minor = 4000 from pg_temp.payout('p3') p)
  and (select p2.created_at < p3.created_at from pg_temp.payout('p2') p2, pg_temp.payout('p3') p3)
  and pg_temp.n('public.program_payouts where status = ''approved''') = 2
  and pg_temp.moved('p2', 'payout') = '2x-7410' and pg_temp.moved('p3', 'payout') = '1x-4000'
  and pg_temp.owed('ada', 'acme') = 0 and pg_temp.owed('ada', 'rival') = 0 and pg_temp.owed('eve', 'rival') = 0
  and pg_temp.owed('ada', 'euro') = 3000 and pg_temp.owed('ben', 'acme') = 900 and pg_temp.owed('cy', 'acme') = 3000
  and pg_temp.holds_lock('eve', 'rival'),
  'one press pays the two creators who are ready in dollars, each the whole of what they can be paid; euros and the '
    || 'creators who are waiting are untouched');
select pg_temp.check((select pg_temp.roll(a) = 'Ada Okafor EUR 3000 ready; Ben Creator USD 900 below_minimum; '
        || 'Cy Park USD 3000 no_account; Dee Vale USD 3600 account_not_ready'
      and jsonb_array_length(a->'open') = 2 and a->'open'->0->>'id' = pg_temp.t('p2') and a->'open'->1->>'id' = pg_temp.t('p3')
      and a->'totals' = '{"ready_minor_by_currency":{"EUR":3000,"USD":0},"ready_count":1,
        "waiting_minor_by_currency":{"EUR":0,"USD":7500},"paid_minor_by_currency":{"EUR":0,"USD":0}}'::jsonb
    from (select pg_temp.kept('pay_ready') as a) x)
  and (select count(*) = 2 and bool_and(a.metadata = '{"via":"pay_ready"}'::jsonb and a.actor_user_id = pg_temp.q('kma_owner'))
    from public.audit_logs a where a.action = 'program_payout_approved' and a.target_id in (pg_temp.q('p2'), pg_temp.q('p3'))),
  'the answer lists both payouts oldest first, and each is in the audit log');
select pg_temp.call('kma_finance', pg_temp.pay_sql('ada', 'EUR', 3000));
insert into qa select 'p4', pg_temp.open_payout('ada', 'EUR');
select pg_temp.check((select p.status = 'approved' and p.amount_minor = 3000 and p.currency = 'EUR' from pg_temp.payout('p4') p)
  and pg_temp.owed('ada', 'euro') = 0 and pg_temp.panel()->'creators' @> '[{"name":"Ada Okafor"}]' is false,
  'a creator can have a payout under way in each currency: Ada''s euros are paid while her dollars are on their way');

-- The worker: claiming ------------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.svc_try('claim_program_payouts', i) = '22023 invalid_input', format('a claim refuses %s', i))
from (values ('{}'::jsonb), ('[]'), ('{"platform_account_id":"KMAPlatform"}'),
  ('{"platform_account_id":"acct_KMAPlatform","limit":0}'), ('{"platform_account_id":"acct_KMAPlatform","limit":26}'),
  ('{"platform_account_id":"acct_KMAPlatform","lease_seconds":59}'), ('{"platform_account_id":"acct_KMAPlatform","lease_seconds":901}'),
  ('{"platform_account_id":"acct_KMAPlatform","livemode":false}')) v(i);
select pg_temp.check(pg_temp.svc('claim_program_payouts', '{"platform_account_id":"acct_Elsewhere"}') = '{"payouts":[]}',
  'another platform has no payouts to claim');
select pg_temp.capture('claim_program_payouts', pg_temp.keep('claim', pg_temp.claim('{"limit":1,"lease_seconds":120}')));
select pg_temp.check((select jsonb_array_length(c->'payouts') = 1
      and pg_temp.keys(c->'payouts'->0) = array['account_key', 'account_status', 'affiliate_id', 'amount_minor', 'attempts',
        'connect_account_id', 'currency', 'failure_code', 'first_attempt_at', 'lease_token', 'lookup_only', 'next_attempt_at',
        'payout_id', 'platform_account_id', 'status', 'transfer_id']
      and c->'payouts'->0 = jsonb_build_object('payout_id', pg_temp.q('p2'), 'lease_token', (pg_temp.payout('p2')).lease_token,
        'affiliate_id', pg_temp.q('creator_ada'), 'amount_minor', 7410, 'currency', 'USD', 'platform_account_id', 'acct_KMAPlatform',
        'status', 'approved', 'attempts', 0, 'first_attempt_at', null, 'connect_account_id', 'acct_AdaPay',
        'account_key', (pg_temp.payout_account('ada')).id, 'account_status', 'ready', 'lookup_only', false,
        'transfer_id', null, 'failure_code', null, 'next_attempt_at', null)
    from (select pg_temp.kept('claim') as c) x)
  and (select p.lease_token is not null and p.lease_until between clock_timestamp() + interval '110 seconds' and clock_timestamp() + interval '120 seconds'
      and p.status = 'approved' and p.attempts = 0 from pg_temp.payout('p2') p),
  'a claim hands out the oldest payout with a lease, and with the creator''s account as it is now');
select pg_temp.check((select kma_internal.program_payout_json(jsonb_populate_record(null::public.program_payouts,
      to_jsonb(p) || jsonb_build_object('affiliate_id', pg_temp.q('creator_gus'))))
      @> '{"connect_account_id":null,"account_key":null,"account_status":"not_connected","lookup_only":false,"amount_minor":7410}'
    from pg_temp.payout('p2') p)
  and (select bool_and(jsonb_typeof(c->k) = 'string' and c->>k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and jsonb_typeof(c->'amount_minor') = 'number' and jsonb_typeof(c->'lookup_only') = 'boolean')
    from (select pg_temp.kept('claim')->'payouts'->0 as c) x, unnest(array['payout_id', 'lease_token', 'affiliate_id', 'account_key']) k),
  'ids are lowercase uuid text, the amount a number and the flag a boolean; a creator with no account row would be '
    || 'handed out with no destination and no key');
select pg_temp.keep('claim_rest', pg_temp.claim('{"limit":25}'));
select pg_temp.check(pg_temp.claimed(pg_temp.kept('claim_rest')) = 'p3 p4' and pg_temp.claim() = '{"payouts":[]}'
  and (select p.lease_until between clock_timestamp() + interval '290 seconds' and clock_timestamp() + interval '300 seconds'
    from pg_temp.payout('p3') p),
  'a payout somebody holds is not handed out again: the next claim gets the other two, the one after nothing');
insert into answers select 'ref_p3_first', pg_temp.ref('p3');
select pg_temp.lapse('p3');
select pg_temp.keep('claim_again', pg_temp.claim());
select pg_temp.check(pg_temp.claimed(pg_temp.kept('claim_again')) = 'p3'
  and pg_temp.kept('claim_again')->'payouts'->0->>'lease_token' <> pg_temp.kept('ref_p3_first')->>'lease_token'
  and pg_temp.svc_try('begin_program_payout', pg_temp.kept('ref_p3_first') || '{"connect_account_id":"acct_EvePay"}') = '22023 lease_lost'
  and pg_temp.svc_try('finish_program_payout', pg_temp.kept('ref_p3_first') || '{"outcome":"retry"}') = '22023 lease_lost',
  'when a lease runs out the payout is handed out again with a new one, and the old holder can do nothing more');

-- The worker: beginning -----------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.svc_try('begin_program_payout', i) = e, format('beginning refuses %s with %s', i, e))
from (values
  ('{}'::jsonb, '22023 invalid_input'),
  (pg_temp.ref('p2'), '22023 invalid_input'),
  (pg_temp.ref('p2') || '{"connect_account_id":"AdaPay"}', '22023 invalid_input'),
  (pg_temp.ref('p2') || '{"connect_account_id":"acct_AdaPay","amount_minor":1}', '22023 invalid_input'),
  (jsonb_build_object('payout_id', 'p2', 'lease_token', (pg_temp.payout('p2')).lease_token, 'connect_account_id', 'acct_AdaPay'), '22023 invalid_input'),
  (jsonb_build_object('payout_id', gen_random_uuid(), 'lease_token', (pg_temp.payout('p2')).lease_token, 'connect_account_id', 'acct_AdaPay'), 'P0002 payout_not_found'),
  (jsonb_build_object('payout_id', pg_temp.q('p2'), 'lease_token', gen_random_uuid(), 'connect_account_id', 'acct_AdaPay'), '22023 lease_lost'),
  (jsonb_build_object('payout_id', pg_temp.q('p2'), 'lease_token', (pg_temp.payout('p3')).lease_token, 'connect_account_id', 'acct_AdaPay'), '22023 lease_lost'),
  (pg_temp.ref('p2') || '{"connect_account_id":"acct_EvePay"}', '22023 destination_changed'),
  (pg_temp.ref('p2') || '{"connect_account_id":"acct_KMAPlatform"}', '22023 destination_changed')) v(i, e);
select pg_temp.check((select p.status = 'approved' and p.attempts = 0 and p.first_attempt_at is null and p.connect_account_id is null
  from pg_temp.payout('p2') p), 'a refused begin changes nothing');
select pg_temp.capture('begin_program_payout', pg_temp.keep('begin', pg_temp.svc('begin_program_payout',
  pg_temp.ref('p2') || '{"connect_account_id":"acct_AdaPay"}')));
select pg_temp.check((select b @> jsonb_build_object('payout_id', pg_temp.q('p2'), 'status', 'processing', 'attempts', 1,
        'connect_account_id', 'acct_AdaPay', 'account_status', 'ready', 'lookup_only', false, 'amount_minor', 7410)
      and b->>'lease_token' = pg_temp.kept('claim')->'payouts'->0->>'lease_token'
      and (b->>'first_attempt_at')::timestamptz = (pg_temp.payout('p2')).first_attempt_at
      and pg_temp.keys(b) = pg_temp.keys(pg_temp.kept('claim')->'payouts'->0)
    from (select pg_temp.kept('begin') as b) x)
  and (select p.status = 'processing' and p.attempts = 1 and p.connect_account_id = 'acct_AdaPay'
      and p.first_attempt_at between clock_timestamp() - interval '10 seconds' and clock_timestamp() from pg_temp.payout('p2') p),
  'beginning makes the payout processing, counts the attempt, and writes the first time and the destination');
insert into qa select 'p2_first_attempt', (pg_temp.payout('p2')).first_attempt_at::text;
select pg_temp.svc('begin_program_payout', pg_temp.ref('p2') || '{"connect_account_id":"acct_AdaPay"}');
select pg_temp.check((select p.attempts = 2 and p.first_attempt_at = pg_temp.t('p2_first_attempt')::timestamptz
    and p.connect_account_id = 'acct_AdaPay' from pg_temp.payout('p2') p),
  'beginning again counts another attempt and keeps the first time');
-- The creator's account row is pointed at another Stripe account (the older functions never do this).
update public.external_creator_accounts set connect_account_id = 'acct_AdaOther' where id = (pg_temp.payout_account('ada')).id;
select pg_temp.check(pg_temp.svc_try('begin_program_payout', pg_temp.ref('p2') || '{"connect_account_id":"acct_AdaOther"}') = '22023 destination_changed'
  and pg_temp.svc_try('begin_program_payout', pg_temp.ref('p2') || '{"connect_account_id":"acct_AdaPay"}') = '22023 destination_changed'
  and (pg_temp.payout('p2')).attempts = 2,
  'a payout that was begun towards one account is never begun towards another, nor towards an account that is no longer the creator''s');
update public.external_creator_accounts set connect_account_id = 'acct_AdaPay' where id = (pg_temp.payout_account('ada')).id;
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.act_sql(jsonb_build_object('action', 'cancel', 'payout_id', pg_temp.q('p2'))))
    = '22023 not_cancelable'
  and (select o @> '{"status":"processing","attempts":2,"can_cancel":false}' from jsonb_array_elements(pg_temp.panel()->'open') o
    where o->>'id' = pg_temp.t('p2'))
  and (select o @> '{"status":"approved","attempts":0,"can_cancel":true}' from jsonb_array_elements(pg_temp.panel()->'open') o
    where o->>'id' = pg_temp.t('p3')),
  'once the worker has begun, the payout can no longer be canceled; one that is only claimed still can');

-- The worker: trying again later ----------------------------------------------------------------------------------
select pg_temp.check(pg_temp.svc_try('finish_program_payout', i) = e, format('finishing refuses %s with %s', i, e))
from (values
  ('{}'::jsonb, '22023 invalid_input'),
  (pg_temp.ref('p2'), '22023 invalid_input'),
  (pg_temp.ref('p2') || '{"outcome":"sent"}', '22023 invalid_input'),
  (pg_temp.ref('p2') || '{"outcome":"paid"}', '22023 invalid_input'),
  (pg_temp.ref('p2') || '{"outcome":"paid","transfer_id":"po_AdaOne"}', '22023 invalid_input'),
  (pg_temp.ref('p2') || '{"outcome":"failed"}', '22023 invalid_input'),
  (pg_temp.ref('p2') || '{"outcome":"failed","failure_code":"Not A Code"}', '22023 invalid_input'),
  (pg_temp.ref('p2') || '{"outcome":"retry","delay_seconds":59}', '22023 invalid_input'),
  (pg_temp.ref('p2') || '{"outcome":"retry","delay_seconds":86401}', '22023 invalid_input'),
  (pg_temp.ref('p2') || '{"outcome":"retry","delay_seconds":"600"}', '22023 invalid_input'),
  (pg_temp.ref('p2') || '{"outcome":"retry","amount_minor":1}', '22023 invalid_input'),
  (jsonb_build_object('payout_id', gen_random_uuid(), 'lease_token', gen_random_uuid(), 'outcome', 'retry'), 'P0002 payout_not_found'),
  (jsonb_build_object('payout_id', pg_temp.q('p2'), 'lease_token', gen_random_uuid(), 'outcome', 'retry'), '22023 lease_lost'),
  (jsonb_build_object('payout_id', pg_temp.q('p2'), 'lease_token', gen_random_uuid(), 'outcome', 'paid', 'transfer_id', 'tr_AdaOne'), '22023 lease_lost'),
  (jsonb_build_object('payout_id', pg_temp.q('p2'), 'lease_token', gen_random_uuid(), 'outcome', 'failed', 'failure_code', 'refused'), '22023 lease_lost'),
  (pg_temp.ref('p4') || '{"outcome":"paid","transfer_id":"tr_Never"}', '22023 not_begun')) v(i, e);
insert into answers select 'ref_p2', pg_temp.ref('p2');
select pg_temp.capture('finish_program_payout.retry', pg_temp.keep('retry', pg_temp.svc('finish_program_payout',
  pg_temp.kept('ref_p2') || '{"outcome":"retry","failure_code":"platform_balance_insufficient","delay_seconds":600}')));
select pg_temp.check((select r @> '{"status":"processing","attempts":2,"failure_code":"platform_balance_insufficient",
        "transfer_id":null,"lookup_only":false}' and r->>'lease_token' is null
      and (r->>'next_attempt_at')::timestamptz between clock_timestamp() + interval '590 seconds' and clock_timestamp() + interval '600 seconds'
    from (select pg_temp.kept('retry') as r) x)
  and (select p.status = 'processing' and p.lease_token is null and p.lease_until is null and p.closed_at is null from pg_temp.payout('p2') p)
  and pg_temp.moved('p2', 'payout') = '2x-7410' and pg_temp.moved('p2', 'payout_reversed') = '0x0'
  and pg_temp.claim() = '{"payouts":[]}'
  and pg_temp.svc_try('finish_program_payout', pg_temp.kept('ref_p2') || '{"outcome":"paid","transfer_id":"tr_AdaOne"}') = '22023 lease_lost'
  and (select o @> '{"status":"processing","failure_code":"platform_balance_insufficient","can_cancel":false}' and o->>'next_attempt_at' is not null
    from jsonb_array_elements(pg_temp.panel()->'open') o where o->>'id' = pg_temp.t('p2')),
  'a retry leaves the payout open and the money out, lets go of the lease, keeps the reason, and is not due again '
    || 'until the wait is over');
select pg_temp.lapse('p2');
select pg_temp.keep('claim_retry', pg_temp.claim());
select pg_temp.check(pg_temp.claimed(pg_temp.kept('claim_retry')) = 'p2'
  and pg_temp.kept('claim_retry')->'payouts'->0 @> '{"status":"processing","attempts":2,"lookup_only":false,"connect_account_id":"acct_AdaPay"}',
  'after the wait the payout is handed out again');
select pg_temp.keep('retry_default', pg_temp.svc('finish_program_payout', pg_temp.ref('p2') || '{"outcome":"retry"}'));
select pg_temp.check((select (r->>'next_attempt_at')::timestamptz between clock_timestamp() + interval '230 seconds' and clock_timestamp() + interval '240 seconds'
      and r->>'failure_code' = 'platform_balance_insufficient'
    from (select pg_temp.kept('retry_default') as r) x),
  'without a delay the wait grows with the attempts: four minutes after the second, and the earlier reason stays');
update public.program_payouts set attempts = 9 where id = pg_temp.q('p2');
select pg_temp.lapse('p2');
select pg_temp.claim();
select pg_temp.keep('retry_capped', pg_temp.svc('finish_program_payout', pg_temp.ref('p2') || '{"outcome":"retry","failure_code":"stripe_unavailable"}'));
select pg_temp.check((select (r->>'next_attempt_at')::timestamptz between clock_timestamp() + interval '3590 seconds' and clock_timestamp() + interval '3600 seconds'
      and r->>'failure_code' = 'stripe_unavailable'
    from (select pg_temp.kept('retry_capped') as r) x),
  'the wait never grows beyond an hour');

-- The worker: the 23 hour rule ----------------------------------------------------------------------------------------
update public.program_payouts set first_attempt_at = clock_timestamp() - interval '22 hours 59 minutes' where id = pg_temp.q('p2');
select pg_temp.lapse('p2');
select pg_temp.check(pg_temp.claim()->'payouts'->0 @> jsonb_build_object('payout_id', pg_temp.q('p2'), 'lookup_only', false),
  'a payout first tried less than 23 hours ago may still be asked for again');
update public.program_payouts set first_attempt_at = clock_timestamp() - interval '23 hours 1 minute' where id = pg_temp.q('p2');
select pg_temp.lapse('p2');
select pg_temp.keep('claim_old', pg_temp.claim());
select pg_temp.check(pg_temp.kept('claim_old')->'payouts'->0 @> jsonb_build_object('payout_id', pg_temp.q('p2'), 'lookup_only', true, 'status', 'processing')
  and pg_temp.svc('begin_program_payout', pg_temp.ref('p2') || '{"connect_account_id":"acct_AdaPay"}') @> '{"lookup_only":true,"attempts":10}'
  and (pg_temp.payout('p2')).first_attempt_at < clock_timestamp() - interval '23 hours',
  'a payout first tried more than 23 hours ago is handed out for looking up only, and beginning again never resets the first time');

-- The worker: paid ----------------------------------------------------------------------------------------------------
insert into answers select 'ref_p2', pg_temp.ref('p2') on conflict (name) do update set answer = excluded.answer;
select pg_temp.capture('finish_program_payout.paid', pg_temp.keep('paid', pg_temp.svc('finish_program_payout',
  pg_temp.kept('ref_p2') || '{"outcome":"paid","transfer_id":"tr_AdaOne"}')));
select pg_temp.check((select r @> '{"status":"paid","transfer_id":"tr_AdaOne","failure_code":null,"next_attempt_at":null}' and r->>'lease_token' is null
    from (select pg_temp.kept('paid') as r) x)
  and (select p.status = 'paid' and p.transfer_id = 'tr_AdaOne' and p.paid_at is not null and p.closed_at = p.paid_at
      and p.lease_token is null and p.failure_code is null and p.next_attempt_at is null from pg_temp.payout('p2') p)
  and pg_temp.moved('p2', 'payout') = '2x-7410' and pg_temp.moved('p2', 'payout_reversed') = '0x0'
  and pg_temp.owed('ada', 'acme') = 0 and pg_temp.owed('ada', 'rival') = 0,
  'a paid payout is closed with its transfer and the money stays out of the creator''s sums');
select pg_temp.check(pg_temp.svc('finish_program_payout', pg_temp.kept('ref_p2') || '{"outcome":"paid","transfer_id":"tr_AdaOne"}')
    = pg_temp.kept('paid')
  and pg_temp.svc_try('finish_program_payout', pg_temp.kept('ref_p2') || '{"outcome":"paid","transfer_id":"tr_AdaTwo"}') = '22023 transfer_mismatch'
  and pg_temp.svc_try('finish_program_payout', pg_temp.kept('ref_p2') || '{"outcome":"failed","failure_code":"refused"}') = '22023 lease_lost'
  and pg_temp.svc_try('finish_program_payout', pg_temp.kept('ref_p2') || '{"outcome":"retry"}') = '22023 lease_lost'
  and pg_temp.svc_try('begin_program_payout', pg_temp.kept('ref_p2') || '{"connect_account_id":"acct_AdaPay"}') = '22023 lease_lost'
  and pg_temp.try('kma_owner', pg_temp.act_sql(jsonb_build_object('action', 'cancel', 'payout_id', pg_temp.q('p2')))) = '22023 not_cancelable'
  and (select p.status = 'paid' and p.transfer_id = 'tr_AdaOne' from pg_temp.payout('p2') p)
  and pg_temp.moved('p2', 'payout_reversed') = '0x0',
  'the same transfer reported again is answered with the paid payout; another transfer, a failure, a retry, a begin '
    || 'and a cancel are all refused, and nothing comes back');
select pg_temp.capture('partner_program_earnings.paid', pg_temp.keep('earnings_paid', pg_temp.earnings('ada')));
select pg_temp.check((select pg_temp.line(e, 'SpeakSix') @> '{"approved_minor":0,"paying_minor":0,"paid_minor":6000,"sales":2}'
      and pg_temp.line(e, 'Rival Reader') @> '{"approved_minor":0,"paying_minor":0,"paid_minor":1410}'
      and pg_temp.line(e, 'Lingot') @> '{"approved_minor":0,"paying_minor":3000,"paid_minor":0}'
      and e->'payout'->'payable' = '[]'::jsonb and jsonb_array_length(e->'payouts') = 3
      and e->'payouts'->0 @> jsonb_build_object('id', pg_temp.q('p4'), 'status', 'approved', 'currency', 'EUR', 'amount_minor', 3000)
      and e->'payouts'->1 @> jsonb_build_object('id', pg_temp.q('p2'), 'status', 'paid', 'currency', 'USD', 'amount_minor', 7410)
      and (e->'payouts'->1->>'paid_at')::timestamptz = (pg_temp.payout('p2')).paid_at
      and e->'payouts'->2 @> jsonb_build_object('id', pg_temp.q('p1'), 'status', 'canceled', 'paid_at', null)
    from (select pg_temp.kept('earnings_paid') as e) x),
  'after the transfer the creator sees 60.00 and 14.10 as paid, the payout with its day, newest payout first');

-- The worker: failed ---------------------------------------------------------------------------------------------------
select pg_temp.svc('begin_program_payout', pg_temp.ref('p3') || '{"connect_account_id":"acct_EvePay"}');
select pg_temp.check(pg_temp.svc_try('finish_program_payout', pg_temp.ref('p3') || '{"outcome":"paid","transfer_id":"tr_AdaOne"}')
  = '22023 transfer_mismatch' and (pg_temp.payout('p3')).status = 'processing',
  'a transfer that already paid one payout cannot pay another');
insert into answers select 'ref_p3', pg_temp.ref('p3');
select pg_temp.capture('finish_program_payout.failed', pg_temp.keep('failed', pg_temp.svc('finish_program_payout',
  pg_temp.kept('ref_p3') || '{"outcome":"failed","failure_code":"account_cannot_receive"}')));
select pg_temp.check((select r @> '{"status":"failed","failure_code":"account_cannot_receive","transfer_id":null,"attempts":1}' and r->>'lease_token' is null
    from (select pg_temp.kept('failed') as r) x)
  and (select p.status = 'failed' and p.closed_at is not null and p.paid_at is null and p.lease_token is null from pg_temp.payout('p3') p)
  and pg_temp.moved('p3', 'payout') = '1x-4000' and pg_temp.moved('p3', 'payout_reversed') = '1x4000'
  and pg_temp.owed('eve', 'rival') = 4000 and pg_temp.blocker('eve') = 'ready',
  'a failed payout gives the money back: Eve''s 40.00 is whole again and can be paid again');
select pg_temp.check(pg_temp.svc_try('finish_program_payout', pg_temp.kept('ref_p3') || '{"outcome":"failed","failure_code":"account_cannot_receive"}')
    = '22023 lease_lost'
  and pg_temp.svc_try('finish_program_payout', pg_temp.kept('ref_p3') || '{"outcome":"paid","transfer_id":"tr_EveLate"}') = '22023 lease_lost'
  and pg_temp.try('kma_owner', pg_temp.act_sql(jsonb_build_object('action', 'cancel', 'payout_id', pg_temp.q('p3')))) = '22023 not_cancelable'
  and pg_temp.moved('p3', 'payout_reversed') = '1x4000' and pg_temp.owed('eve', 'rival') = 4000
  and pg_temp.claim() = '{"payouts":[]}',
  'a failed payout is closed for good: it gives back once, and is never claimed, paid or canceled afterwards');
select pg_temp.check((select e->'payouts'->0 @> jsonb_build_object('id', pg_temp.q('p3'), 'status', 'failed', 'paid_at', null)
      and pg_temp.line(e, 'Rival Reader') @> '{"approved_minor":4000,"paying_minor":0,"paid_minor":0}'
      and e->'payout'->'payable' = '[{"currency":"USD","amount_minor":4000}]'::jsonb
    from (select pg_temp.earnings('eve') as e) x)
  and (select count(*) = 1 and bool_and(a.actor_type = 'system' and a.actor_user_id is null
      and a.after_data @> '{"status":"failed","failure_code":"account_cannot_receive","amount_minor":4000}')
    from public.audit_logs a where a.action = 'program_payout_failed' and a.target_id = pg_temp.q('p3'))
  and (select count(*) = 1 and bool_and(a.after_data @> '{"status":"paid","transfer_id":"tr_AdaOne","amount_minor":7410}')
    from public.audit_logs a where a.action = 'program_payout_paid' and a.target_id = pg_temp.q('p2')),
  'the creator sees the payout as not sent and the money back in approved; both endings are in the audit log');

-- Canceled while the worker holds it ---------------------------------------------------------------------------------
insert into answers select 'ref_p4', pg_temp.ref('p4');
select pg_temp.check((pg_temp.payout('p4')).lease_until > clock_timestamp() and (pg_temp.payout('p4')).status = 'approved',
  'the worker holds Ada''s euro payout and has not begun');
select pg_temp.call('kma_finance', pg_temp.act_sql(jsonb_build_object('action', 'cancel', 'payout_id', pg_temp.q('p4'))));
select pg_temp.check((select p.status = 'canceled' and p.lease_token is null from pg_temp.payout('p4') p)
  and pg_temp.svc_try('begin_program_payout', pg_temp.kept('ref_p4') || '{"connect_account_id":"acct_AdaPay"}') = '22023 lease_lost'
  and pg_temp.svc_try('finish_program_payout', pg_temp.kept('ref_p4') || '{"outcome":"failed","failure_code":"refused"}') = '22023 lease_lost'
  and pg_temp.moved('p4', 'payout_reversed') = '1x3000' and pg_temp.owed('ada', 'euro') = 3000,
  'an admin can cancel a payout the worker has claimed but not begun; the worker then finds its lease gone and the '
    || 'money went back once');

-- A failure before beginning, and paying again ------------------------------------------------------------------------
select pg_temp.call('kma_finance', pg_temp.pay_sql('eve', 'USD', 4000));
insert into qa select 'p5', pg_temp.open_payout('eve');
select pg_temp.onboard('eve', 'acct_EvePay', 'restricted', 'GB');
select pg_temp.keep('claim_p5', pg_temp.claim());
select pg_temp.check(pg_temp.claimed(pg_temp.kept('claim_p5')) = 'p5'
  and pg_temp.kept('claim_p5')->'payouts'->0 @> '{"account_status":"restricted","connect_account_id":"acct_EvePay","status":"approved"}',
  'a claim shows what the creator''s account has become since the payout was made');
-- The worker waits once for the account, without beginning: the payout stays as the admin made it.
select pg_temp.keep('retry_unbegun', pg_temp.svc('finish_program_payout', pg_temp.ref('p5') || '{"outcome":"retry","failure_code":"account_not_ready","delay_seconds":900}'));
select pg_temp.check(pg_temp.kept('retry_unbegun') @> '{"status":"approved","attempts":0,"first_attempt_at":null,"failure_code":"account_not_ready"}'
  and pg_temp.kept('retry_unbegun')->>'lease_token' is null
  and (pg_temp.kept('retry_unbegun')->>'next_attempt_at')::timestamptz > clock_timestamp() + interval '890 seconds'
  and (select o @> '{"status":"approved","failure_code":"account_not_ready","can_cancel":true}'
    from jsonb_array_elements(pg_temp.panel()->'open') o where o->>'id' = pg_temp.t('p5'))
  and pg_temp.claim() = '{"payouts":[]}',
  'a retry of a payout that was never begun leaves it approved, with the reason, still cancelable, and not due until the wait is over');
select pg_temp.lapse('p5');
select pg_temp.check(pg_temp.claimed(pg_temp.claim()) = 'p5', 'after the wait it is claimed again');
select pg_temp.keep('failed_unbegun', pg_temp.svc('finish_program_payout', pg_temp.ref('p5') || '{"outcome":"failed","failure_code":"account_not_ready"}'));
select pg_temp.check(pg_temp.kept('failed_unbegun') @> '{"status":"failed","attempts":0,"first_attempt_at":null,"failure_code":"account_not_ready"}'
  and pg_temp.owed('eve', 'rival') = 4000 and pg_temp.blocker('eve') = 'account_not_ready',
  'the worker can give up on a payout it never began: the money is back and the creator waits for their account');
select pg_temp.onboard('eve', 'acct_EvePay', 'ready', 'GB');
select pg_temp.call('kma_finance', pg_temp.pay_sql('eve', 'USD', 4000));
insert into qa select 'p6', pg_temp.open_payout('eve');
select pg_temp.check((select p.status = 'approved' and p.amount_minor = 4000 from pg_temp.payout('p6') p)
  and pg_temp.q('p6') not in (pg_temp.q('p3'), pg_temp.q('p5')) and pg_temp.owed('eve', 'rival') = 0
  and pg_temp.moved('p6', 'payout') = '1x-4000'
  and (select sum(e.amount_minor) = -4000 and count(*) = 5 from public.program_creator_entries e
    where e.affiliate_id = pg_temp.q('creator_eve') and e.payout_id is not null),
  'after a failure the creator is paid again with a new payout; over three payouts her 40.00 left her sum exactly once');

-- Everything at once, for the admin panel -------------------------------------------------------------------------------
select pg_temp.earn('s_ada_acme3', 'acme', 'ada', 10000);
select pg_temp.earn('s_eve2', 'rival', 'eve', 5000);
select pg_temp.call('kma_finance', pg_temp.pay_sql('ada', 'EUR', 3000));
insert into qa select 'p7', pg_temp.open_payout('ada', 'EUR');
select pg_temp.claim();
select pg_temp.svc('begin_program_payout', pg_temp.ref('p7') || '{"connect_account_id":"acct_AdaPay"}');
select pg_temp.svc('finish_program_payout', pg_temp.ref('p7') || '{"outcome":"retry","failure_code":"platform_balance_insufficient","delay_seconds":3600}');
select pg_temp.onboard('dee', 'acct_DeePay', 'restricted');
select pg_temp.capture('get_admin_program_payouts.full', pg_temp.keep('full', pg_temp.panel('kma_analyst')));
select pg_temp.check((select pg_temp.roll(a) = 'Ada Okafor USD 3000 ready; Ben Creator USD 900 below_minimum; Cy Park USD 3000 no_account; '
        || 'Dee Vale USD 3600 account_not_ready; Eve Stone USD 1000 payout_open'
      and (select string_agg(format('%s %s %s %s', o->>'name', o->>'currency', o->>'status', o->>'can_cancel'), '; ' order by n)
        from jsonb_array_elements(a->'open') with ordinality x(o, n)) = 'Eve Stone USD approved true; Ada Okafor EUR processing false'
      and a->'open'->1 @> '{"attempts":1,"failure_code":"platform_balance_insufficient"}' and a->'open'->1->>'next_attempt_at' is not null
      and (select string_agg(format('%s %s %s', r->>'name', r->>'amount_minor', r->>'status'), '; ' order by n)
        from jsonb_array_elements(a->'recent') with ordinality x(r, n))
        = 'Eve Stone 4000 failed; Ada Okafor 3000 canceled; Eve Stone 4000 failed; Ada Okafor 7410 paid; Ada Okafor 4410 canceled'
      and a->'recent'->0 @> '{"failure_code":"account_not_ready","transfer_id":null}'
      and a->'recent'->3 @> '{"failure_code":null,"transfer_id":"tr_AdaOne","currency":"USD"}'
      and (select bool_and((r->>'closed_at') is not null and (r->>'created_at') is not null) from jsonb_array_elements(a->'recent') r)
      and a->'totals' = '{"ready_minor_by_currency":{"EUR":0,"USD":3000},"ready_count":1,
        "waiting_minor_by_currency":{"EUR":0,"USD":8500},"paid_minor_by_currency":{"EUR":0,"USD":7410}}'::jsonb
      and a::text !~ '@|Ada N\.|acct_(Ada|Ben|Dee|Eve)|requirements'
    from (select pg_temp.kept('full') as a) x),
  'the panel with everything in it: one creator ready, four waiting for four reasons, a payout waiting for the worker '
    || 'and one waiting to be tried again, and the paid, failed and canceled ones newest first');

-- A refund after a payout -------------------------------------------------------------------------------------------------
-- The buyer of Ada's Rival Reader sale is refunded after her 14.10 was paid out.
select pg_temp.refund('s_ada_rival', 7050);
select pg_temp.check(pg_temp.owed('ada', 'rival') = 0
  and (select c.status = 'approved' and c.amount_minor = 1410 from public.program_commissions c where c.sale_id = pg_temp.q('s_ada_rival'))
  and pg_temp.n(format('public.program_creator_entries where kind = ''clawback'' and affiliate_id = %L', pg_temp.q('creator_ada'))) = 0
  and pg_temp.moved('p2', 'payout') = '2x-7410' and (pg_temp.payout('p2')).status = 'paid',
  'money that was paid out is not taken back by a later refund: the sum stays at nothing and the payout is untouched');
-- Eve's second sale is refunded while her first payout is under way: only what is still in the sum goes back.
select pg_temp.refund('s_eve2', 5000);
select pg_temp.check(pg_temp.owed('eve', 'rival') = 0 and pg_temp.moved('p6', 'payout') = '1x-4000'
  and pg_temp.n(format('public.program_creator_entries where kind = ''clawback'' and affiliate_id = %L and amount_minor = -1000',
    pg_temp.q('creator_eve'))) = 1
  and pg_temp.listed(pg_temp.panel(), 'eve') is null,
  'a refund while a payout is under way takes back only what is still in the creator''s sum');

-- The schedule ------------------------------------------------------------------------------------------------------------
select pg_temp.check(kma_internal.tick_program_payout_schedule() = '{"status":"paused"}'::jsonb,
  'the schedule is off until it is enabled');
select pg_temp.check((select last_tick_at is not null and last_dispatch_at is null and not enabled
  from kma_internal.program_payout_schedule), 'a tick of the switched-off schedule is noted and calls nobody');
update kma_internal.program_payout_schedule set enabled = true where singleton;
-- Eve's payout is held by a worker and Ada's waits for its next try: nothing is due.
select pg_temp.check((pg_temp.payout('p6')).lease_until > clock_timestamp() and (pg_temp.payout('p7')).next_attempt_at > clock_timestamp()
  and kma_internal.tick_program_payout_schedule() = '{"status":"idle"}'::jsonb,
  'with no payout due the schedule calls nobody');
select pg_temp.lapse('p6');
select pg_temp.check(kma_internal.tick_program_payout_schedule() = '{"status":"scheduler_value_missing"}'::jsonb,
  'a payout is due, but without its Vault value the schedule calls nobody');
insert into vault.decrypted_secrets(name, decrypted_secret) values ('kma_program_payout_scheduler', repeat('s', 40));
-- The local fixture has no network: reaching net.http_post is the proof that the worker would be called.
select pg_temp.check(pg_temp.fails('select kma_internal.tick_program_payout_schedule()') like '%HTTP disabled in local isolated SQL fixture%',
  'with its Vault value and a payout due the schedule calls the worker');
select pg_temp.money(false);
select pg_temp.check(kma_internal.tick_program_payout_schedule() = '{"status":"payouts_disabled"}'::jsonb,
  'the schedule calls nobody while program money is off');
select pg_temp.money(true);
select pg_temp.keep('claim_p6', pg_temp.claim());
select pg_temp.check(pg_temp.claimed(pg_temp.kept('claim_p6')) = 'p6'
  and kma_internal.tick_program_payout_schedule() = '{"status":"idle"}'::jsonb,
  'once the worker holds the payout the schedule is quiet again');
select pg_temp.lapse('p7');
select pg_temp.check(pg_temp.fails('select kma_internal.tick_program_payout_schedule()') like '%HTTP disabled%',
  'a payout whose wait is over makes the schedule call the worker');
select pg_temp.keep('claim_p7', pg_temp.claim());
select pg_temp.check(pg_temp.claimed(pg_temp.kept('claim_p7')) = 'p7', 'and the worker claims it');

-- The operator view ----------------------------------------------------------------------------------------------------------
select pg_temp.capture('program_payout_health', pg_temp.keep('health', pg_temp.health()));
select pg_temp.check((select h @> '{"enabled":true,"ledger_mismatches":0,"platforms":1,"schedule":{"enabled":true},
        "payouts":{"approved":1,"processing":1,"paid":1,"failed":2,"canceled":2},
        "open_payouts":{"due":0,"lookup_only":0},
        "failures":{"account_cannot_receive":1,"account_not_ready":1}}'
      and (h->'open_payouts'->>'oldest_created_at')::timestamptz = (pg_temp.payout('p6')).created_at
      and not h->'schedule' ? 'last_request_id'
      and h::text !~ '(acct_|tr_|@)'
    from (select pg_temp.kept('health') as h) x),
  'the operator view counts payouts by status and failures by code, finds the ledger whole, and names no account or transfer');
-- A stray entry against a paid payout is what ledger_mismatches is for. Made and undone inside one block.
create function pg_temp.health_with_stray_entry() returns jsonb language plpgsql as $$
declare h jsonb;
begin
  begin
    insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, payout_id)
    values (pg_temp.q('creator_ada'), (pg_temp.program('euro')).id, 'USD', 'payout', -1, pg_temp.q('p2'));
    h := pg_temp.health();
    raise exception 'undo';
  exception when raise_exception then
    return h;
  end;
end $$;
select pg_temp.check(pg_temp.health_with_stray_entry()->>'ledger_mismatches' = '1' and pg_temp.health()->>'ledger_mismatches' = '0'
  and pg_temp.fails(format('select kma_internal.program_payout_check(%L)', pg_temp.q('p2'))) = 'ok',
  'a payout whose entries do not add up to what its status says is counted as a mismatch');

-- Switched off again -----------------------------------------------------------------------------------------------------------
select pg_temp.keep('off_again', pg_temp.call('kma_owner', pg_temp.configure_sql(jsonb_build_object('enabled', false,
  'expected_updated_at', (select updated_at from public.platform_settings)))));
select pg_temp.check((select a @> '{"enabled":false,"money_enabled":true,"platform":{"registered":true,"enabled":true}}'
      and (select bool_and(c->>'blocker' = 'payouts_off') and count(*) = 4 from jsonb_array_elements(a->'creators') c)
      and jsonb_array_length(a->'open') = 2 and a->'totals'->>'ready_count' = '0'
    from (select pg_temp.kept('off_again') as a) x)
  and (select count(*) = 1 and bool_and(x.enabled) from public.external_settlement_platforms x),
  'switching payouts off stops every creator being payable and leaves the open payouts and the platform as they are');
select pg_temp.lapse('p6');
select pg_temp.check(pg_temp.claim() = '{"payouts":[]}'
  and pg_temp.svc_try('begin_program_payout', pg_temp.ref('p7') || '{"connect_account_id":"acct_AdaPay"}') = '22023 program_payouts_disabled'
  and (pg_temp.payout('p7')).attempts = 1
  and kma_internal.tick_program_payout_schedule() = '{"status":"payouts_disabled"}'::jsonb
  and pg_temp.try('kma_finance', pg_temp.pay_sql('ada', 'USD', 3000)) = '22023 not_payable'
  and pg_temp.message('kma_finance', pg_temp.pay_sql('ada', 'USD', 3000)) like '%payouts_off'
  and pg_temp.try('kma_owner', pg_temp.act_sql('{"action":"pay_ready","currency":"USD","expected_count":1,"expected_total_minor":3000}'))
    = '22023 amount_changed'
  and pg_temp.try('ada', pg_temp.context_sql()) = '42501 payouts_off'
  and pg_temp.n('public.program_payouts where status in (''approved'', ''processing'')') = 2,
  'with payouts off the worker is handed nothing and may begin nothing, the schedule calls nobody, nobody is paid and '
    || 'no payout account is opened');
select pg_temp.check((select e->'payout' @> '{"enabled":false,"platform_account_id":"acct_KMAPlatform"}'
      and jsonb_array_length(e->'payouts') = 4 and pg_temp.line(e, 'Lingot') @> '{"paying_minor":3000}'
    from (select pg_temp.earnings('ada') as e) x),
  'with payouts off the creator still sees their payouts');
-- What was approved and never begun can be taken back while payouts are off.
select pg_temp.keep('cancel_off', pg_temp.call('kma_owner', pg_temp.act_sql(jsonb_build_object('action', 'cancel', 'payout_id', pg_temp.q('p6')))));
select pg_temp.check((pg_temp.payout('p6')).status = 'canceled' and pg_temp.owed('eve', 'rival') = 4000
  and pg_temp.moved('p6', 'payout_reversed') = '1x4000' and jsonb_array_length(pg_temp.kept('cancel_off')->'open') = 1,
  'a payout the worker has not begun can still be canceled while payouts are off, and the money goes back');
-- A payout that was already begun may still be closed with what Stripe says.
select pg_temp.keep('paid_off', pg_temp.svc('finish_program_payout', pg_temp.ref('p7') || '{"outcome":"paid","transfer_id":"tr_AdaEuro"}'));
select pg_temp.check(pg_temp.kept('paid_off') @> '{"status":"paid","transfer_id":"tr_AdaEuro","currency":"EUR"}'
  and pg_temp.owed('ada', 'euro') = 0,
  'a worker that already holds a begun payout can still record that Stripe paid it');
select pg_temp.call('kma_owner', pg_temp.configure_sql(jsonb_build_object('enabled', true,
  'expected_updated_at', (select updated_at from public.platform_settings))));
-- Program money off switches payouts off with it, whatever the payout switch says.
select pg_temp.money(false);
select pg_temp.check((select a @> '{"enabled":true,"money_enabled":false}' and a->'totals'->>'ready_count' = '0'
      and (select bool_and(c->>'blocker' = 'payouts_off') from jsonb_array_elements(a->'creators') c)
    from (select pg_temp.panel() as a) x)
  and pg_temp.try('kma_finance', pg_temp.pay_sql('ada', 'USD', 3000)) = '22023 not_payable'
  and pg_temp.try('ada', pg_temp.context_sql()) = '42501 payouts_off'
  and pg_temp.earnings('ada')->'payout'->>'enabled' = 'false',
  'with program money off payouts are off too, for the admin and for the creator');
select pg_temp.money(true);
select pg_temp.check(pg_temp.blocker('ada') = 'ready' and pg_temp.blocker('eve') = 'ready'
  and pg_temp.earnings('ada')->'payout'->>'enabled' = 'true',
  'and with both switches on again creators can be paid');

-- More than 200 creators ready ---------------------------------------------------------------------------------------------------
-- 201 creators with 25.00 each in pounds, as fixture rows: an adjustment entry and a ready account.
insert into public.affiliates(id, public_name, slug, status)
  select ('a4000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Bulk ' || lpad(g::text, 3, '0'), 'bulk-' || g, 'active'
  from generate_series(1, 201) g;
insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, note)
  select f.id, (pg_temp.program('acme')).id, 'GBP', 'adjustment', 2500, 'Fixture' from public.affiliates f where f.slug like 'bulk-%';
insert into public.external_creator_accounts(affiliate_id, platform_account_id, livemode, connect_account_id, country, status,
    payouts_enabled, transfers_enabled, details_submitted, verified_at)
  select f.id, 'acct_KMAPlatform', true, 'acct_Bulk' || substr(f.slug, 6), 'GB', 'ready', true, true, true, now()
  from public.affiliates f where f.slug like 'bulk-%';
select pg_temp.check(pg_temp.panel()->'totals' @> '{"ready_count":203,"ready_minor_by_currency":{"GBP":502500}}'
  and pg_temp.try('kma_owner', pg_temp.act_sql('{"action":"pay_ready","currency":"GBP","expected_count":201,"expected_total_minor":502500}'))
    = '22023 too_many_ready'
  and pg_temp.try('kma_owner', pg_temp.act_sql('{"action":"pay_ready","currency":"GBP","expected_count":200,"expected_total_minor":500000}'))
    = '22023 too_many_ready'
  and pg_temp.n('public.program_payouts where currency = ''GBP''') = 0,
  'with 201 creators ready in pounds, paying everyone is refused and nobody is paid: never a part of them');
-- One of them is paid alone: 200 are left, and one press pays them all.
select pg_temp.call('kma_owner', pg_temp.act_sql(jsonb_build_object('action', 'pay', 'currency', 'GBP', 'expected_amount_minor', 2500,
  'affiliate_id', (select f.id from public.affiliates f where f.slug = 'bulk-201'))));
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.act_sql('{"action":"pay_ready","currency":"GBP","expected_count":201,"expected_total_minor":502500}'))
  = '22023 amount_changed', 'the count and total sent must be of everyone who is ready now');
select pg_temp.keep('bulk', pg_temp.call('kma_owner',
  pg_temp.act_sql('{"action":"pay_ready","currency":"GBP","expected_count":200,"expected_total_minor":500000}')));
select pg_temp.check(pg_temp.n('public.program_payouts where currency = ''GBP'' and status = ''approved'' and amount_minor = 2500') = 201
  and (select a->'totals' @> '{"ready_minor_by_currency":{"GBP":0}}'
      and not exists (select 1 from jsonb_array_elements(a->'creators') c where c->>'currency' = 'GBP')
      and (select count(*) = 201 from jsonb_array_elements(a->'open') o where o->>'currency' = 'GBP')
    from (select pg_temp.kept('bulk') as a) x)
  and jsonb_array_length(pg_temp.claim('{"limit":25}')->'payouts') = 25,
  'one press pays 200 creators, each with their own payout, and the worker takes at most 25 at a time');

-- The ledger, at the end -----------------------------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.health()->>'ledger_mismatches' = '0'
  and (select bool_and(p.amount_minor = (select sum(i.amount_minor) from public.program_payout_items i where i.payout_id = p.id)
      and (case when p.status in ('failed', 'canceled') then 0 else -p.amount_minor end)
        = (select sum(e.amount_minor) from public.program_creator_entries e where e.payout_id = p.id)
      and (p.status in ('failed', 'canceled')) = exists (select 1 from public.program_creator_entries e
        where e.payout_id = p.id and e.kind = 'payout_reversed')
      and (p.status = 'paid') = (p.transfer_id is not null))
    from public.program_payouts p)
  and (select bool_and(i.amount_minor = -(select e.amount_minor from public.program_creator_entries e
      where e.payout_id = i.payout_id and e.program_id = i.program_id and e.kind = 'payout'))
    from public.program_payout_items i)
  and not exists (select 1 from public.program_creator_entries e group by e.affiliate_id, e.program_id having sum(e.amount_minor) < 0)
  and (select count(*) = count(distinct (p.affiliate_id, p.platform_account_id, p.currency))
    from public.program_payouts p where p.status in ('approved', 'processing')),
  'every payout agrees with its items and its entries, money that came back came back once, no creator''s sum is below '
    || 'zero, and no creator has two payouts under way in one currency');
select pg_temp.check((select sum(e.amount_minor) from public.program_creator_entries e
    where e.affiliate_id in (pg_temp.q('creator_ada'), pg_temp.q('creator_eve')))
    = (3000 + 1410 + 3000 + 3000 + 3000) + (4000 + 1000 - 1000) - (7410 + 3000),
  'what Ada and Eve earned, less what was paid to them, is what they still have coming');
select pg_temp.check(pg_temp.fails('update public.program_creator_entries set amount_minor = 1') <> 'ok'
  and pg_temp.fails('delete from public.program_creator_entries') <> 'ok',
  'creator entries still cannot be changed or deleted');
select set_config('request.jwt.claims', '', true);

select 'ok ' || count(*) || ' program payout assertions' from payout_assertions;
rollback;
