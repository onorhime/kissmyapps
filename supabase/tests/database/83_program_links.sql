-- Provider-free test of Phase 5, links and numbers: the channel links a member gets (on
-- automatic and manual approval, and by the backfill for members from before), custom
-- links and their limits, what each kind of link does when a visitor opens it, the
-- creator's Links and Performance answers (clicks, sales and earnings per link and per day
-- in the creator's time zone), and the merchant's Creators and Sales answers.
--
-- Programs and members are made with the Phase 2 and 3 functions. Visits go through the
-- redirect functions; visits on earlier days are click rows written directly. Sales are
-- inserted directly and judged by the real commission sync and tick. Stripe is never called.
begin;
set local time zone 'UTC';
create temporary table link_assertions(label text);
create temporary table qa(key text primary key, value text);
create temporary table answers(name text primary key, answer jsonb);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program link assertion failed: %', label; end if;
  insert into link_assertions values (label);
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
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
-- Prints one function result as the front ends receive it (kept by KMA_DB_TEST_OUTPUT).
create function pg_temp.capture(name text, result jsonb) returns text language sql as $$
  select 'capture ' || name || ' ' || result::text
$$;
-- Keeps an answer so that later statements can look at it without calling again.
create function pg_temp.keep(k text, result jsonb) returns jsonb language sql as $$
  insert into answers values (k, result) on conflict (name) do update set answer = excluded.answer returning answer
$$;
create function pg_temp.kept(k text) returns jsonb language sql as $$ select answer from answers where name = k $$;
create function pg_temp.keys(j jsonb) returns text language sql as $$
  select string_agg(k, ' ' order by k) from jsonb_object_keys(j) k
$$;
-- What the end of the writing transaction does: the deferred commission triggers run.
create function pg_temp.flush() returns void language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end $$;
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
  select business, 'billing@' || workspace || '.example.test', w.created_by, w.id
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
-- The merchant pauses or resumes their program.
create function pg_temp.set_status(who text, workspace text, new_status text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_program_set_status(%L, %L, %s)', pg_temp.q(workspace), new_status,
    (pg_temp.program(workspace)).revision))
$$;
create function pg_temp.tracking(enabled boolean) returns void language sql as $$
  update public.platform_settings set tracking_enabled = enabled where singleton
$$;

-- Creators ---------------------------------------------------------------------------------------
create function pg_temp.join(creator text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(creator, format('select public.partner_program_join(%L)', jsonb_build_object(
    'slug', p.slug, 'terms_version', t.version, 'agreement_sha256', t.agreement_sha256)))
  from pg_temp.program(workspace) p
  join public.affiliate_program_terms t on t.program_id = p.id and t.version = p.live_terms_version
$$;
create function pg_temp.leave(creator text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(creator, format('select public.partner_program_leave(%L)',
    jsonb_build_object('program_id', (pg_temp.program(workspace)).id)))
$$;
create function pg_temp.member(creator text, workspace text) returns public.affiliate_program_members language sql as $$
  select m from public.affiliate_program_members m
  where m.program_id = (pg_temp.program(workspace)).id and m.affiliate_id = pg_temp.q('creator_' || creator)
$$;
-- The merchant approves, declines or removes a creator.
create function pg_temp.decide(who text, workspace text, creator text, action text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_program_creator_decide(%L, %L)', pg_temp.q(workspace),
    jsonb_build_object('member_id', (pg_temp.member(creator, workspace)).id, 'action', action)))
$$;

-- Links ------------------------------------------------------------------------------------------
-- The link rows a creator has for a program, and one of them by the name the Links page
-- shows ('Main link' for the main one). A link that is not archived comes before one that is.
create function pg_temp.link_rows(creator text, workspace text) returns setof public.affiliate_links language sql as $$
  select l from public.affiliate_links l
  where l.affiliate_id = pg_temp.q('creator_' || creator) and l.product_id = (pg_temp.program(workspace)).product_id
$$;
create function pg_temp.link_row(creator text, workspace text, link_name text) returns public.affiliate_links language sql as $$
  select l from pg_temp.link_rows(creator, workspace) l
  where case when link_name = 'Main link' then l.is_main else not l.is_main and l.name = link_name end
  order by (l.status = 'archived'), l.created_at desc limit 1
$$;
-- The link rows in one line, in the order they were made: <name>:<source>:<status>.
create function pg_temp.link_roll(creator text, workspace text) returns text language sql as $$
  select string_agg(format('%s:%s:%s', l.name, coalesce(s.key, '-'), l.status), ' ' order by l.is_main desc, l.created_at, l.name)
  from pg_temp.link_rows(creator, workspace) l left join public.sources s on s.id = l.source_id
$$;
create function pg_temp.short_path(creator text, workspace text, link_name text) returns text language sql as $$
  select a.path from kma_internal.tracking_link_aliases a where a.link_id = (pg_temp.link_row(creator, workspace, link_name)).id
$$;
-- The Links page, one program on it, one link of that program, and its link names in order.
create function pg_temp.links(creator text) returns jsonb language sql as $$
  select pg_temp.call(creator, 'select public.partner_program_links()')
$$;
create function pg_temp.listed(answer jsonb, program_slug text) returns jsonb language sql as $$
  select p from jsonb_array_elements(answer->'programs') p where p->>'slug' = program_slug
$$;
create function pg_temp.line(program jsonb, link_name text) returns jsonb language sql as $$
  select l from jsonb_array_elements(program->'links') l where l->>'name' = link_name
$$;
create function pg_temp.names(program jsonb) returns text language sql as $$
  select string_agg(l->>'name', ', ' order by n) from jsonb_array_elements(program->'links') with ordinality x(l, n)
$$;
-- A line of numbers of each link that has any, in the order given: <name> <clicks>/<sales>/<earnings>.
create function pg_temp.numbers(lines jsonb) returns text language sql as $$
  select coalesce(string_agg(format('%s %s/%s/%s', l->>'name', l->>'clicks', l->>'sales', l->>'earnings_minor'), ', ' order by n), '')
  from jsonb_array_elements(lines) with ordinality x(l, n)
  where (l->>'clicks')::bigint + (l->>'sales')::bigint + (l->>'earnings_minor')::bigint > 0
$$;
create function pg_temp.create_sql(program_slug text, link_name text) returns text language sql as $$
  select format('select public.partner_program_link_create(%L)', jsonb_build_object('slug', program_slug, 'name', link_name))
$$;
create function pg_temp.remove_sql(link uuid) returns text language sql as $$
  select format('select public.partner_program_link_remove(%L)', jsonb_build_object('link_id', link))
$$;
-- A visitor opens a link by its long address: what the redirect function gets back.
create function pg_temp.open(creator text, workspace text, link_name text, context jsonb default '{}') returns jsonb
language plpgsql as $$
declare
  v_slug text;
  v_code text;
  result jsonb;
begin
  select a.slug, l.public_code into v_slug, v_code
  from pg_temp.link_row(creator, workspace, link_name) l join public.affiliates a on a.id = l.affiliate_id;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select to_jsonb(r) into result from public.register_tracking_click(v_slug, v_code, context) r;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- The same by its readable address.
create function pg_temp.open_short(path text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select to_jsonb(r) into result from public.register_short_tracking_click(path, '{}'::jsonb) r;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- The click row a visit made.
create function pg_temp.click_of(visit jsonb) returns public.clicks language sql as $$
  select k from public.clicks k where k.public_click_id = visit->>'click_id'
$$;
-- A visit on an earlier day: the click row the redirect function would have written then.
create function pg_temp.click_at(creator text, workspace text, link_name text, at timestamptz) returns uuid
language plpgsql as $$
declare
  l public.affiliate_links := pg_temp.link_row(creator, workspace, link_name);
  v_id uuid := gen_random_uuid();
begin
  insert into public.clicks(id, public_click_id, affiliate_link_id, affiliate_id, product_id, source_id, campaign_id,
    funnel_id, sub1, sub2, sub3, destination_url_snapshot, is_bot, commercial_eligible, occurred_at, created_at)
  select v_id, encode(extensions.gen_random_bytes(24), 'hex'), l.id, l.affiliate_id, l.product_id, l.source_id, l.campaign_id,
    l.funnel_id, l.sub1, l.sub2, l.sub3, f.destination_url, false, l.commercial_eligible, at, at
  from public.funnels f where f.id = l.funnel_id;
  return v_id;
end $$;
-- The first moment of a day of the creator's calendar, `back` days before today.
create function pg_temp.day(creator text, back integer) returns timestamptz language sql as $$
  select ((now() at time zone a.reporting_timezone)::date - back)::timestamp at time zone a.reporting_timezone
  from public.affiliates a where a.id = pg_temp.q('creator_' || creator)
$$;
-- That day as the answers name it.
create function pg_temp.date_of(creator text, back integer) returns text language sql as $$
  select ((now() at time zone a.reporting_timezone)::date - back)::text
  from public.affiliates a where a.id = pg_temp.q('creator_' || creator)
$$;
create function pg_temp.performance_sql(program_slug text, days integer) returns text language sql as $$
  select format('select public.partner_program_performance(%L)', jsonb_build_object('slug', program_slug, 'days', days))
$$;
create function pg_temp.performance(creator text, program_slug text, days integer) returns jsonb language sql as $$
  select pg_temp.call(creator, pg_temp.performance_sql(program_slug, days))
$$;
-- The days of a Performance answer that have anything: <days back> <clicks>/<sales>/<earnings>.
create function pg_temp.days(creator text, answer jsonb) returns text language sql as $$
  select coalesce(string_agg(format('%s %s/%s/%s', (answer->>'ends_on')::date - (d->>'day')::date,
    d->>'clicks', d->>'sales', d->>'earnings_minor'), ', ' order by n desc), '')
  from jsonb_array_elements(answer->'daily') with ordinality x(d, n)
  where (d->>'clicks')::bigint + (d->>'sales')::bigint + (d->>'earnings_minor')::bigint > 0
$$;

-- Money ------------------------------------------------------------------------------------------
create function pg_temp.account(workspace text) returns public.program_balance_accounts language sql as $$
  select a from public.program_balance_accounts a where a.program_id = (pg_temp.program(workspace)).id
$$;
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
-- A payment Stripe reported, tied to a creator's click (or to none), then what the end of
-- that transaction does. Everything Stripe names about the buyer is filled in, so the
-- tests can show that none of it reaches a creator.
create function pg_temp.sale(k text, workspace text, click uuid, amount bigint, paid timestamptz,
  matched_by text default 'metadata', made timestamptz default now()) returns void language plpgsql as $$
declare
  p public.affiliate_programs := pg_temp.program(workspace);
  v_click public.clicks;
  v_id uuid := gen_random_uuid();
begin
  select * into v_click from public.clicks where id = click;
  insert into public.program_sales(id, program_id, connection_id, account_id, payment_intent_id, charge_id,
      checkout_session_id, customer_id, amount_minor, currency, refunded_minor, status, paid_at,
      click_id, click_record_id, affiliate_id, match_source, created_at)
    select v_id, p.id, c.id, c.account_id, 'pi_p5buyer' || k, 'ch_p5buyer' || k, 'cs_p5buyer' || k, 'cus_P5Buyer' || k,
      amount, 'USD', 0, 'paid', paid, v_click.public_click_id, v_click.id, v_click.affiliate_id,
      case when v_click.id is null then 'none' else matched_by end, made
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
-- A sale's commission in one line: <status> <amount> <fee> <reason>.
create function pg_temp.commission(k text) returns text language sql as $$
  select coalesce((select format('%s %s %s %s', x.status, x.amount_minor, x.fee_minor, coalesce(x.reason, '-'))
    from public.program_commissions x where x.sale_id = pg_temp.q(k)), 'none')
$$;
-- The creator's line of one program in their earnings.
create function pg_temp.earnings_line(creator text, program_slug text) returns jsonb language sql as $$
  select p from jsonb_array_elements(pg_temp.call(creator, 'select public.partner_program_earnings()')->'programs') p
  where p->>'slug' = program_slug
$$;

-- The merchant -----------------------------------------------------------------------------------
create function pg_temp.creators(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_program_creators(%L)', pg_temp.q(workspace)))
$$;
create function pg_temp.creator(answer jsonb, handle text) returns jsonb language sql as $$
  select c from jsonb_array_elements(answer->'creators') c where c->>'handle' = handle
$$;
create function pg_temp.sales_sql(workspace text, input jsonb default '{}') returns text language sql as $$
  select format('select public.workspace_program_sales(%L, %L)', pg_temp.q(workspace), input)
$$;
create function pg_temp.sales(who text, workspace text, input jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.call(who, pg_temp.sales_sql(workspace, input))
$$;
-- The sales of an answer in one line, by the names they were kept under.
create function pg_temp.sold(answer jsonb) returns text language sql as $$
  select coalesce(string_agg(q.key, ' ' order by n), '')
  from jsonb_array_elements(answer->'sales') with ordinality x(s, n)
  join qa q on q.value = s->>'sale_id' and q.key ~ '^[a-z][0-9]$'
$$;
create function pg_temp.sold_line(answer jsonb, k text) returns jsonb language sql as $$
  select s from jsonb_array_elements(answer->'sales') s where s->>'sale_id' = pg_temp.q(k)::text
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
grant all on qa, link_assertions, answers to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- People ---------------------------------------------------------------------------------------
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('b5000000-0000-4000-8000-000000000001', 'owner@speaksix.example.test', now(), '{"company":"SpeakSix"}'),
  ('b5000000-0000-4000-8000-000000000002', 'analyst@speaksix.example.test', now(), '{}'),
  ('b5000000-0000-4000-8000-000000000003', 'owner@rival.example.test', now(), '{"company":"Rival"}'),
  ('b5000000-0000-4000-8000-000000000004', 'owner@quiet.example.test', now(), '{"company":"Quiet"}'),
  ('b5000000-0000-4000-8000-000000000005', 'owner@empty.example.test', now(), '{"company":"Empty"}'),
  ('b5000000-0000-4000-8000-000000000011', 'owner@kma.example.test', now(), '{}'),
  ('b5000000-0000-4000-8000-000000000021', 'ada@creators.example.test', now(), '{}'),
  ('b5000000-0000-4000-8000-000000000022', 'ben@creators.example.test', now(), '{}'),
  ('b5000000-0000-4000-8000-000000000023', 'cy@creators.example.test', now(), '{}'),
  ('b5000000-0000-4000-8000-000000000024', 'dee@creators.example.test', now(), '{}'),
  ('b5000000-0000-4000-8000-000000000025', 'eve@creators.example.test', now(), '{}'),
  ('b5000000-0000-4000-8000-000000000026', 'helper@creators.example.test', now(), '{}'),
  ('b5000000-0000-4000-8000-000000000027', 'numbers@creators.example.test', now(), '{}'),
  ('b5000000-0000-4000-8000-000000000028', 'stranger@elsewhere.example.test', now(), '{}');
insert into qa values
  ('owner', 'b5000000-0000-4000-8000-000000000001'), ('analyst', 'b5000000-0000-4000-8000-000000000002'),
  ('rival_owner', 'b5000000-0000-4000-8000-000000000003'), ('quiet_owner', 'b5000000-0000-4000-8000-000000000004'),
  ('empty_owner', 'b5000000-0000-4000-8000-000000000005'), ('kma_owner', 'b5000000-0000-4000-8000-000000000011'),
  ('ada', 'b5000000-0000-4000-8000-000000000021'), ('ben', 'b5000000-0000-4000-8000-000000000022'),
  ('cy', 'b5000000-0000-4000-8000-000000000023'), ('dee', 'b5000000-0000-4000-8000-000000000024'),
  ('eve', 'b5000000-0000-4000-8000-000000000025'),
  -- Two more people on Ada's creator account: one works on it, one only reads the numbers.
  ('ada_helper', 'b5000000-0000-4000-8000-000000000026'), ('ada_reader', 'b5000000-0000-4000-8000-000000000027'),
  ('stranger', 'b5000000-0000-4000-8000-000000000028'),
  ('creator_ada', 'b6000000-0000-4000-8000-000000000001'), ('creator_ben', 'b6000000-0000-4000-8000-000000000002'),
  ('creator_cy', 'b6000000-0000-4000-8000-000000000003'), ('creator_dee', 'b6000000-0000-4000-8000-000000000004'),
  ('creator_eve', 'b6000000-0000-4000-8000-000000000005');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner');
-- Ada's calendar is fourteen hours ahead of UTC; the others keep the default, UTC.
insert into public.affiliates(id, public_name, legal_name, slug, status, reporting_timezone) values
  (pg_temp.q('creator_ada'), 'Ada Okafor', 'Ada N. Okafor', 'ada-okafor', 'active', 'Pacific/Kiritimati'),
  (pg_temp.q('creator_ben'), 'Ben Creator', null, 'ben-creator', 'active', 'UTC'),
  (pg_temp.q('creator_cy'), 'Cy Park', null, 'cy-park', 'active', 'UTC'),
  (pg_temp.q('creator_dee'), 'Dee Vale', null, 'dee-vale', 'active', 'UTC'),
  (pg_temp.q('creator_eve'), 'Eve Stone', null, 'eve-stone', 'active', 'UTC');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at)
  select pg_temp.q('creator_' || c), pg_temp.q(c), 'owner', true, false, now()
  from unnest(array['ada', 'ben', 'cy', 'dee', 'eve']) c;
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at) values
  (pg_temp.q('creator_ada'), pg_temp.q('ada_helper'), 'member', true, false, now()),
  (pg_temp.q('creator_ada'), pg_temp.q('ada_reader'), 'analyst', true, false, now());
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true,
    program_money_enabled = false, program_fee_bps = 1000, program_min_deposit_minor = 5000,
    program_payouts_enabled = false, program_min_payout_minor = 2500;

-- Workspaces and programs, published while program money is still off --------------------------
select pg_temp.sign_in('owner');
insert into qa select 'acme', public.analytics_bootstrap()->'workspaces'->0->>'id';
select public.analytics_invite_member(pg_temp.q('acme'), 'analyst@speaksix.example.test', 'analyst');
select pg_temp.sign_in('analyst');
select public.analytics_bootstrap();
select pg_temp.sign_in('rival_owner');
insert into qa select 'rival', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('quiet_owner');
insert into qa select 'quiet', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('empty_owner');
insert into qa select 'empty', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
select pg_temp.connect('acme', 'acct_SpeakSix', 'SpeakSix Ltd');
select pg_temp.connect('rival', 'acct_Rival', 'Rival Media');
select pg_temp.connect('quiet', 'acct_Quiet', 'Quiet Club');
-- SpeakSix pays 30% and approves creators automatically; Rival Reader pays 20% and approves
-- each creator itself; Quiet Club pays 20%. All for every payment.
select pg_temp.publish('owner', 'acme', '{"name":"SpeakSix","category":"education","tagline":"Speak English in six weeks.",
  "landing_url":"https://speaksix.com/start","commission_type":"percent","commission_rate_bps":3000,
  "commission_duration":"lifetime"}');
select pg_temp.publish('rival_owner', 'rival', '{"name":"Rival Reader","category":"entertainment","tagline":"Stories worth an evening.",
  "landing_url":"https://rivalreader.co/","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"lifetime","hold_days":14,"approval_mode":"manual"}');
select pg_temp.publish('quiet_owner', 'quiet', '{"name":"Quiet Club","category":"lifestyle","tagline":"A calmer phone.",
  "landing_url":"https://quietclub.io/join","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"lifetime","hold_days":14}');
select pg_temp.check((select bool_and(p.status = 'live') and count(*) = 3 from public.affiliate_programs p),
  'three programs are live');

-- Closed by default ----------------------------------------------------------------------------
select pg_temp.check((select count(*) = 6 and bool_and(has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('partner_program_links', 'partner_program_link_create',
    'partner_program_link_remove', 'partner_program_performance', 'workspace_program_creators', 'workspace_program_sales')),
  'signed-in users may call the six functions; each is security definer with an empty search path');
select pg_temp.check((select count(*) >= 15 and bool_and(not has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'kma_internal' and (p.proname like 'program\_link%' or p.proname = 'program_creator_json')),
  'the internal link functions are closed to every API role');
select pg_temp.check(pg_temp.try_signed_out(r, s) = '42501', format('%s cannot run %s', r, left(s, 60)))
from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array[
  'select kma_internal.program_links_sync()', 'select kma_internal.program_link_channels()',
  format('select kma_internal.program_link_rows(%L, %L)', gen_random_uuid(), gen_random_uuid()),
  format('select kma_internal.program_link_stats(%L, %L, now(), now())', gen_random_uuid(), gen_random_uuid()),
  format('select kma_internal.program_link_money(%L, %L)', gen_random_uuid(), gen_random_uuid())]) s;
select pg_temp.check(pg_temp.try_signed_out(r, s) = '42501', format('signed out, %s cannot run %s', r, left(s, 60)))
from unnest(array['anon', 'authenticated']) r, unnest(array[
  'select public.partner_program_links()', pg_temp.create_sql('speaksix', 'Podcast'),
  pg_temp.remove_sql(gen_random_uuid()), pg_temp.performance_sql(null, 30),
  format('select public.workspace_program_creators(%L)', pg_temp.q('acme')), pg_temp.sales_sql('acme')]) s;
select pg_temp.check(pg_temp.try('stranger', 'select public.partner_program_links()') = '42501'
  and pg_temp.try('stranger', pg_temp.create_sql('speaksix', 'Podcast')) = '42501'
  and pg_temp.try('stranger', pg_temp.remove_sql(gen_random_uuid())) = '42501'
  and pg_temp.try('stranger', pg_temp.performance_sql(null, 30)) = '42501'
  and pg_temp.try('owner', 'select public.partner_program_links()') = '42501'
  and pg_temp.try('owner', pg_temp.performance_sql(null, 30)) = '42501',
  'somebody with no creator account cannot read or change links or read performance');
select pg_temp.check((select bool_and(exists (select 1 from pg_indexes i
    where i.schemaname = 'public' and i.indexname = x.name and i.indexdef like x.shape))
  from (values ('program_sales_click', '%(click_record_id)%'), ('clicks_link_occurred', '%(affiliate_link_id, occurred_at DESC)%')) x(name, shape)),
  'the sales of a click and the clicks of a link by time are indexed');

-- A creator with no program ----------------------------------------------------------------------
select pg_temp.capture('partner_program_links.empty', pg_temp.keep('links_empty', pg_temp.links('eve')));
select pg_temp.check(pg_temp.kept('links_empty') = '{"stats_days":30,"max_custom_links":20,"programs":[],"channels":[
    {"key":"tiktok","name":"TikTok"},{"key":"instagram","name":"Instagram"},{"key":"youtube","name":"YouTube"},
    {"key":"facebook","name":"Facebook"},{"key":"x","name":"X"},{"key":"newsletter","name":"Newsletter"}]}'::jsonb,
  'a creator with no program gets the channels, the limits and no programs');
select pg_temp.capture('partner_program_performance.none', pg_temp.keep('performance_none', pg_temp.performance('eve', null, 30)));
select pg_temp.check((select a - 'starts_on' - 'ends_on' = '{"days":30,"timezone":"UTC","programs":[],"program":null,
      "totals":{"clicks":0,"sales":0,"earnings_minor":0},"previous":{"clicks":0,"sales":0,"earnings_minor":0},
      "daily":[],"channels":[],"money":null,"latest":[]}'::jsonb
      and a->>'ends_on' = (now() at time zone 'UTC')::date::text
      and a->>'starts_on' = ((now() at time zone 'UTC')::date - 29)::text
    from (select pg_temp.kept('performance_none') as a) x)
  and pg_temp.try('eve', pg_temp.performance_sql('speaksix', 30)) = 'P0002 program_not_found',
  'a creator with no program gets an empty performance answer, and no program by its address');

-- Members from before this migration: the backfill -------------------------------------------------
-- Cy and Dee joined when a member only got a main link. Quiet Club was paused after Dee joined.
alter table public.affiliate_program_members disable trigger affiliate_program_members_links;
select pg_temp.check(pg_temp.join('cy', 'acme')->'membership'->>'status' = 'active'
  and pg_temp.join('dee', 'quiet')->'membership'->>'status' = 'active', 'Cy and Dee join');
alter table public.affiliate_program_members enable trigger affiliate_program_members_links;
select pg_temp.set_status('quiet_owner', 'quiet', 'paused');
select pg_temp.check(pg_temp.link_roll('cy', 'acme') = 'SpeakSix · Main:-:active'
  and pg_temp.link_roll('dee', 'quiet') = 'Quiet Club · Main:-:active' and pg_temp.n('public.affiliate_links') = 2,
  'before the backfill a member has only a main link');
-- What the migration runs.
select set_config('request.jwt.claims', '', true);
select kma_internal.program_links_sync();
select pg_temp.check(pg_temp.link_roll('cy', 'acme') = 'SpeakSix · Main:-:active TikTok:tiktok:active Instagram:instagram:active '
    || 'YouTube:youtube:active Facebook:facebook:active X:x:active Newsletter:newsletter:active',
  'the backfill gives a member of a live program the six channel links, switched on');
select pg_temp.check(pg_temp.link_roll('dee', 'quiet') = 'Quiet Club · Main:-:active TikTok:tiktok:paused Instagram:instagram:paused '
    || 'YouTube:youtube:paused Facebook:facebook:paused X:x:paused Newsletter:newsletter:paused',
  'the backfill gives a member of a paused program the six channel links, waiting switched off');
select kma_internal.program_links_sync();
select pg_temp.check(pg_temp.n('public.affiliate_links') = 14, 'running the backfill again makes nothing twice');
select pg_temp.check((select p->>'working' = 'false' and p->>'paused_reason' = 'program_paused'
      and pg_temp.names(p) = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter'
      and pg_temp.line(p, 'TikTok')->>'url' = 'https://go.kissmyapps.dev/quiet-club/dee-vale/tiktok'
    from (select pg_temp.listed(pg_temp.links('dee'), 'quiet-club') as p) x)
  and pg_temp.open('dee', 'quiet', 'TikTok') = '{"click_id":null,"destination_url":"https://quietclub.io/join","is_bot":false}'
  and pg_temp.open_short('/quiet-club/dee-vale/tiktok')->>'click_id' is null
  and pg_temp.open('dee', 'quiet', 'Main link')->>'click_id' is null
  and pg_temp.n('public.clicks') = 0,
  'the links of a paused program are shown as paused; they send the visitor on and credit nothing');
-- The program goes live again: the links that were waiting are switched on with it.
select pg_temp.set_status('quiet_owner', 'quiet', 'live');
select pg_temp.check(pg_temp.link_roll('dee', 'quiet') = 'Quiet Club · Main:-:active TikTok:tiktok:active Instagram:instagram:active '
    || 'YouTube:youtube:active Facebook:facebook:active X:x:active Newsletter:newsletter:active'
  and (select p->>'working' = 'true' and p->'paused_reason' = 'null'
    from (select pg_temp.listed(pg_temp.links('dee'), 'quiet-club') as p) x),
  'when the program goes live again its waiting links are switched on');
select pg_temp.check((select k.affiliate_link_id = (pg_temp.link_row('dee', 'quiet', 'TikTok')).id
      and k.source_id = (select s.id from public.sources s where s.key = 'tiktok') and not k.is_bot
      and k.affiliate_id = pg_temp.q('creator_dee') and k.commercial_eligible
    from pg_temp.click_of(pg_temp.open_short('/quiet-club/dee-vale/tiktok')) k)
  and pg_temp.n('public.clicks') = 1,
  'a visit on a channel link of a live program is a click that carries the channel''s source');

-- Automatic approval -------------------------------------------------------------------------------
select pg_temp.check(pg_temp.join('ada', 'acme')->'membership'->>'status' = 'active', 'Ada joins SpeakSix');
select pg_temp.check(pg_temp.link_roll('ada', 'acme') = 'SpeakSix · Main:-:active TikTok:tiktok:active Instagram:instagram:active '
    || 'YouTube:youtube:active Facebook:facebook:active X:x:active Newsletter:newsletter:active'
  and (select bool_and(not l.is_main and l.commercial_eligible and l.tracking_environment = 'live'
      and l.funnel_id = (pg_temp.program('acme')).funnel_id and l.campaign_id is null and l.parent_link_id is null
      and l.sub1 is null and l.sub2 is null and l.sub3 is null and l.created_by = pg_temp.q('ada')
      and l.public_code ~ '^[0-9a-f]{36}$' and l.tracking_url = 'https://go.kissmyapps.dev/r/ada-okafor/' || l.public_code)
    from pg_temp.link_rows('ada', 'acme') l where not l.is_main)
  and (select count(*) = 7 and count(distinct l.public_code) = 7 from pg_temp.link_rows('ada', 'acme') l)
  and (select string_agg(a.path, ' ' order by a.path) = '/speaksix/ada-okafor /speaksix/ada-okafor/facebook '
      || '/speaksix/ada-okafor/instagram /speaksix/ada-okafor/newsletter /speaksix/ada-okafor/tiktok '
      || '/speaksix/ada-okafor/x /speaksix/ada-okafor/youtube'
    from kma_internal.tracking_link_aliases a join pg_temp.link_rows('ada', 'acme') l on l.id = a.link_id)
  and (select count(*) = 6 from public.audit_logs g where g.target_table = 'affiliate_links' and g.action = 'insert'
    and g.target_id in (select l.id from pg_temp.link_rows('ada', 'acme') l where not l.is_main)),
  'a creator who is approved automatically gets the six channel links at once: live, commercial, on the program''s '
    || 'landing page, each with its channel''s source and a readable address');
select pg_temp.capture('partner_program_links.one_program', pg_temp.keep('links_fresh', pg_temp.links('ada')));
select pg_temp.check((select pg_temp.keys(a) = 'channels max_custom_links programs stats_days'
      and jsonb_array_length(a->'programs') = 1
      and p - 'links' = jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'slug', 'speaksix', 'name', 'SpeakSix',
        'currency', 'USD', 'working', true, 'paused_reason', null, 'custom_links', 0)
      and pg_temp.names(p) = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter'
      and (select bool_and(pg_temp.keys(l) = 'channel clicks created_at earnings_minor kind link_id name removable sales url'
          and l @> '{"clicks":0,"sales":0,"earnings_minor":0,"removable":false}'
          and (l->>'created_at')::timestamptz = r.created_at and l->>'link_id' = r.id::text)
        from jsonb_array_elements(p->'links') l join public.affiliate_links r on r.id = (l->>'link_id')::uuid)
      and pg_temp.line(p, 'Main link') @> '{"kind":"main","channel":null,"url":"https://go.kissmyapps.dev/speaksix/ada-okafor"}'
      and pg_temp.line(p, 'TikTok') @> '{"kind":"channel","channel":"tiktok","url":"https://go.kissmyapps.dev/speaksix/ada-okafor/tiktok"}'
      and pg_temp.line(p, 'X') @> '{"kind":"channel","channel":"x","url":"https://go.kissmyapps.dev/speaksix/ada-okafor/x"}'
      and (select string_agg(l->>'channel', ' ' order by n) = 'tiktok instagram youtube facebook x newsletter'
        from jsonb_array_elements(p->'links') with ordinality e(l, n) where l->>'kind' = 'channel')
    from (select pg_temp.kept('links_fresh') as a, pg_temp.listed(pg_temp.kept('links_fresh'), 'speaksix') as p) x),
  'the Links page shows the main link, then the six channels in their order, each with its address and no results yet');
select pg_temp.check(pg_temp.links('ada_helper') = pg_temp.kept('links_fresh')
  and pg_temp.links('ada_reader') = pg_temp.kept('links_fresh')
  and pg_temp.links('cy')->'programs'->0->>'slug' = 'speaksix'
  and pg_temp.line(pg_temp.links('cy')->'programs'->0, 'TikTok')->>'url' = 'https://go.kissmyapps.dev/speaksix/cy-park/tiktok',
  'everyone on a creator account reads the same Links page; another creator reads their own');
select pg_temp.capture('partner_program_performance.no_results',
  pg_temp.keep('performance_fresh', pg_temp.performance('ada', 'speaksix', 7)));
select pg_temp.check((select pg_temp.keys(a) = 'channels daily days ends_on latest money previous program programs starts_on timezone totals'
      and a @> '{"days":7,"timezone":"Pacific/Kiritimati","latest":[],
        "totals":{"clicks":0,"sales":0,"earnings_minor":0},"previous":{"clicks":0,"sales":0,"earnings_minor":0},
        "money":{"pending_minor":0,"approved_minor":0,"paying_minor":0,"paid_minor":0,"next_release_at":null}}'
      and a->'program' = jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'slug', 'speaksix', 'name', 'SpeakSix', 'currency', 'USD')
      and a->'programs' = jsonb_build_array(a->'program')
      and jsonb_array_length(a->'daily') = 7 and pg_temp.days('ada', a) = ''
      and a->'daily'->0 = jsonb_build_object('day', pg_temp.date_of('ada', 6), 'clicks', 0, 'sales', 0, 'earnings_minor', 0)
      and a->'daily'->6->>'day' = pg_temp.date_of('ada', 0)
      and a->>'starts_on' = pg_temp.date_of('ada', 6) and a->>'ends_on' = pg_temp.date_of('ada', 0)
      and (select string_agg(c->>'name', ', ' order by n) = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter'
          and bool_and(pg_temp.keys(c) = 'channel clicks earnings_minor kind link_id name sales')
        from jsonb_array_elements(a->'channels') with ordinality e(c, n))
    from (select pg_temp.kept('performance_fresh') as a) x),
  'a new member''s Performance page has a row for every day and every link, all zero, and money that is all zero');

-- Manual approval ------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.join('ben', 'rival')->'membership'->>'status' = 'pending'
  and pg_temp.n(format('public.affiliate_links where affiliate_id = %L', pg_temp.q('creator_ben'))) = 0
  and pg_temp.links('ben')->'programs' = '[]'
  and pg_temp.try('ben', pg_temp.create_sql('rival-reader', 'Podcast')) = '42501 not_member'
  and pg_temp.performance('ben', null, 30)->'programs' = '[]'
  and pg_temp.try('ben', pg_temp.performance_sql('rival-reader', 30)) = 'P0002 program_not_found',
  'a creator who is waiting for the merchant has no links, cannot add one and has no program to report on');
select pg_temp.check(pg_temp.decide('rival_owner', 'rival', 'ben', 'approve')->'creator'->>'status' = 'active'
  and pg_temp.link_roll('ben', 'rival') = 'Rival Reader · Main:-:active TikTok:tiktok:active Instagram:instagram:active '
    || 'YouTube:youtube:active Facebook:facebook:active X:x:active Newsletter:newsletter:active'
  and pg_temp.names(pg_temp.listed(pg_temp.links('ben'), 'rival-reader')) = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter'
  and pg_temp.short_path('ben', 'rival', 'Newsletter') = '/rival-reader/ben-creator/newsletter',
  'the merchant''s approval gives the creator the six channel links');

-- What a visit on a link does ----------------------------------------------------------------------
select pg_temp.check((select k.source_id = (select s.id from public.sources s where s.key = 'instagram')
      and k.affiliate_link_id = (pg_temp.link_row('ben', 'rival', 'Instagram')).id
    from pg_temp.click_of(pg_temp.open('ben', 'rival', 'Instagram')) k)
  and pg_temp.open('ben', 'rival', 'Instagram', '{"is_bot":true}')->>'is_bot' = 'true',
  'a channel link credits like the main link, by its long address too');
-- The merchant pauses the program.
select pg_temp.set_status('rival_owner', 'rival', 'paused');
select pg_temp.check(pg_temp.open('ben', 'rival', 'Instagram') = '{"click_id":null,"destination_url":"https://rivalreader.co/","is_bot":false}'
  and pg_temp.open_short('/rival-reader/ben-creator/newsletter')->>'click_id' is null
  and pg_temp.n(format('public.clicks where affiliate_id = %L', pg_temp.q('creator_ben'))) = 2
  and (pg_temp.link_row('ben', 'rival', 'Instagram')).status = 'active'
  and (select p @> '{"working":false,"paused_reason":"program_paused"}'
    from (select pg_temp.listed(pg_temp.links('ben'), 'rival-reader') as p) x),
  'while the program is paused its channel links send the visitor on and credit nothing');
-- A custom link added while the program is paused waits, and is switched on when the program is live.
select pg_temp.check((select pg_temp.line(p, 'While paused') @> '{"kind":"custom","removable":true}' and p @> '{"working":false,"custom_links":1}'
    from (select pg_temp.call('ben', pg_temp.create_sql('rival-reader', 'While paused')) as p) x)
  and (pg_temp.link_row('ben', 'rival', 'While paused')).status = 'paused',
  'a custom link can be added while the program is paused; it waits switched off');
select pg_temp.set_status('rival_owner', 'rival', 'live');
select pg_temp.check((pg_temp.link_row('ben', 'rival', 'While paused')).status = 'active'
  and pg_temp.open('ben', 'rival', 'While paused')->>'click_id' is not null
  and pg_temp.open('ben', 'rival', 'Instagram')->>'click_id' is not null
  and pg_temp.n(format('public.clicks where affiliate_id = %L', pg_temp.q('creator_ben'))) = 4,
  'when the program is live again every link credits, the one that was waiting too');
-- Tracking is switched off for the whole platform, and on again.
select pg_temp.tracking(false);
select pg_temp.check((select pg_temp.line(p, 'While off')->>'kind' = 'custom' and p @> '{"working":false,"paused_reason":"program_paused"}'
    from (select pg_temp.call('ben', pg_temp.create_sql('rival-reader', 'While off')) as p) x)
  and (pg_temp.link_row('ben', 'rival', 'While off')).status = 'paused'
  and pg_temp.set_status('rival_owner', 'rival', 'paused')->'program'->>'status' = 'paused'
  and pg_temp.set_status('rival_owner', 'rival', 'live')->'program'->>'status' = 'live'
  and (pg_temp.link_row('ben', 'rival', 'While off')).status = 'paused',
  'while tracking is off a new custom link waits, and a program can still be paused and resumed');
select pg_temp.tracking(true);
select pg_temp.check((pg_temp.link_row('ben', 'rival', 'While off')).status = 'active'
  and pg_temp.listed(pg_temp.links('ben'), 'rival-reader') @> '{"working":true,"paused_reason":null,"custom_links":2}',
  'switching tracking on switches the waiting links on');
-- The creator leaves, and joins again.
select pg_temp.leave('ben', 'rival');
select pg_temp.check(pg_temp.open('ben', 'rival', 'Instagram')->>'click_id' is null
  and pg_temp.open('ben', 'rival', 'While paused')->>'click_id' is null
  and pg_temp.open('ben', 'rival', 'Main link')->>'click_id' is null
  and pg_temp.open('ben', 'rival', 'Instagram')->>'destination_url' = 'https://rivalreader.co/'
  and pg_temp.n(format('public.clicks where affiliate_id = %L', pg_temp.q('creator_ben'))) = 4
  and pg_temp.links('ben')->'programs' = '[]'
  and pg_temp.try('ben', pg_temp.create_sql('rival-reader', 'After leaving')) = '42501 not_member'
  and pg_temp.try('ben', pg_temp.remove_sql((pg_temp.link_row('ben', 'rival', 'While off')).id)) = 'P0002 link_not_found',
  'after a creator leaves, none of their links credits, the program is off their Links page and they cannot change its links');
select pg_temp.check(pg_temp.join('ben', 'rival')->'membership'->>'status' = 'pending'
  and pg_temp.open('ben', 'rival', 'TikTok')->>'click_id' is null
  and pg_temp.decide('rival_owner', 'rival', 'ben', 'approve')->'creator'->>'status' = 'active'
  and pg_temp.n(format('public.affiliate_links where affiliate_id = %L', pg_temp.q('creator_ben'))) = 9
  and pg_temp.names(pg_temp.listed(pg_temp.links('ben'), 'rival-reader'))
    = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter, While paused, While off'
  and pg_temp.open('ben', 'rival', 'TikTok')->>'click_id' is not null
  and pg_temp.open('ben', 'rival', 'While off')->>'click_id' is not null,
  'a creator who joins again has the same links, and they credit again');
-- A channel link the creator archived (the older Links page could) comes back the next time they become active.
select pg_temp.call('ben', format('select to_jsonb(r) from public.set_partner_link_status(%L, ''archived'') r',
  (pg_temp.link_row('ben', 'rival', 'YouTube')).id));
select pg_temp.check(pg_temp.names(pg_temp.listed(pg_temp.links('ben'), 'rival-reader'))
    = 'Main link, TikTok, Instagram, Facebook, X, Newsletter, While paused, While off'
  and pg_temp.open('ben', 'rival', 'YouTube') = '{"click_id":null,"destination_url":"https://rivalreader.co/","is_bot":false}',
  'an archived link is off the Links page; opened, it sends the visitor on and credits nothing');
select pg_temp.leave('ben', 'rival');
select pg_temp.join('ben', 'rival');
select pg_temp.decide('rival_owner', 'rival', 'ben', 'approve');
select pg_temp.check(pg_temp.n(format('public.affiliate_links where affiliate_id = %L', pg_temp.q('creator_ben'))) = 9
  and (pg_temp.link_row('ben', 'rival', 'YouTube')).status = 'active'
  and pg_temp.line(pg_temp.listed(pg_temp.links('ben'), 'rival-reader'), 'YouTube')->>'url'
    = 'https://go.kissmyapps.dev/rival-reader/ben-creator/youtube',
  'a channel link that was archived comes back with its address when the creator becomes active again');
-- A channel whose source the catalog no longer offers is left out, and nothing else fails.
update public.sources set active = false, archived_at = now() where key = 'newsletter';
select pg_temp.check(pg_temp.join('eve', 'quiet')->'membership'->>'status' = 'active'
  and pg_temp.names(pg_temp.listed(pg_temp.links('eve'), 'quiet-club')) = 'Main link, TikTok, Instagram, YouTube, Facebook, X',
  'a creator still joins when a channel''s source is switched off: that channel is left out');
update public.sources set active = true, archived_at = null where key = 'newsletter';
-- Links come second to what sets them off. Were making one ever to fail, the program still
-- goes live and the creator still joins; the next call makes the link.
create function public.p5_test_refuse_links() returns trigger language plpgsql as $$
begin
  if not new.is_main and exists (select 1 from qa where key = 'refuse_links') then
    raise exception 'refused by the test';
  end if;
  return new;
end $$;
create trigger p5_test_refuse_links before insert on public.affiliate_links
  for each row execute function public.p5_test_refuse_links();
insert into qa values ('refuse_links', 'yes');
select pg_temp.check(pg_temp.set_status('quiet_owner', 'quiet', 'paused')->'program'->>'status' = 'paused'
  and pg_temp.set_status('quiet_owner', 'quiet', 'live')->'program'->>'status' = 'live'
  and pg_temp.leave('eve', 'quiet')->'membership'->>'status' = 'left'
  and pg_temp.join('eve', 'quiet')->'membership' @> '{"status":"active","link":{"working":true}}'
  and pg_temp.names(pg_temp.listed(pg_temp.links('eve'), 'quiet-club')) = 'Main link, TikTok, Instagram, YouTube, Facebook, X',
  'a link that cannot be made never stops a program going live or a creator joining');
delete from qa where key = 'refuse_links';
select pg_temp.set_status('quiet_owner', 'quiet', 'paused');
select pg_temp.set_status('quiet_owner', 'quiet', 'live');
select pg_temp.check(pg_temp.names(pg_temp.listed(pg_temp.links('eve'), 'quiet-club'))
    = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter'
  and (pg_temp.link_row('eve', 'quiet', 'Newsletter')).status = 'active',
  'the next time the program goes live the missing channel link is made');
select pg_temp.leave('eve', 'quiet');

-- Custom links ---------------------------------------------------------------------------------------
select pg_temp.capture('partner_program_link_create.first',
  pg_temp.keep('created', pg_temp.call('ada', pg_temp.create_sql('speaksix', 'Podcast'))));
select pg_temp.check((select pg_temp.keys(p) = 'currency custom_links links name paused_reason program_id slug working'
      and p @> '{"slug":"speaksix","working":true,"custom_links":1}'
      and pg_temp.names(p) = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter, Podcast'
      and pg_temp.line(p, 'Podcast') - 'link_id' - 'created_at' = '{"kind":"custom","channel":null,"name":"Podcast",
        "url":"https://go.kissmyapps.dev/speaksix/ada-okafor/podcast","clicks":0,"sales":0,"earnings_minor":0,"removable":true}'::jsonb
      and p = pg_temp.listed(pg_temp.links('ada'), 'speaksix')
    from (select pg_temp.kept('created') as p) x)
  and (select not l.is_main and l.status = 'active' and l.source_id is null and l.campaign_id is null and l.sub1 = 'podcast'
      and l.sub2 is null and l.sub3 is null and l.commercial_eligible and l.tracking_environment = 'live'
      and l.funnel_id = (pg_temp.program('acme')).funnel_id and l.created_by = pg_temp.q('ada')
      and l.tracking_url = 'https://go.kissmyapps.dev/r/ada-okafor/' || l.public_code
    from pg_temp.link_row('ada', 'acme', 'Podcast') l),
  'a creator adds a custom link: it is live at once, has a readable address and no source, and the answer is the program as it is now');
select pg_temp.check(pg_temp.try('ada', 'select public.partner_program_link_create(null)') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_link_create(''[]'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_link_create(''{"slug":"speaksix","name":"A","source":"tiktok"}'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_link_create(''{"name":"A"}'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_link_create(''{"slug":7,"name":"A"}'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_link_create(''{"slug":"speaksix"}'')') = '22023 invalid_name'
  and pg_temp.try('ada', 'select public.partner_program_link_create(''{"slug":"speaksix","name":7}'')') = '22023 invalid_name'
  and pg_temp.try('ada', 'select public.partner_program_link_create(''{"slug":"speaksix","name":null}'')') = '22023 invalid_name'
  and pg_temp.try('ada', pg_temp.create_sql('speaksix', '')) = '22023 invalid_name'
  and pg_temp.try('ada', pg_temp.create_sql('speaksix', E' \t\n ')) = '22023 invalid_name'
  and pg_temp.try('ada', pg_temp.create_sql('speaksix', repeat('a', 41))) = '22023 invalid_name'
  and pg_temp.try('ada', pg_temp.create_sql('speaksix', E'Pod\u0007cast')) = '22023 invalid_name'
  and pg_temp.n(format('public.affiliate_links where affiliate_id = %L', pg_temp.q('creator_ada'))) = 8,
  'a request that is not a slug and a name of 1 to 40 characters is refused');
select pg_temp.check(pg_temp.try('ada', pg_temp.create_sql('speaksix', 'podcast')) = '22023 name_taken'
  and pg_temp.try('ada', pg_temp.create_sql('speaksix', '  PODCAST ')) = '22023 name_taken'
  and pg_temp.try('ada', pg_temp.create_sql('speaksix', 'tiktok')) = '22023 name_taken'
  and pg_temp.try('ada', pg_temp.create_sql('speaksix', 'X')) = '22023 name_taken'
  and pg_temp.try('ada', pg_temp.create_sql('speaksix', 'Main Link')) = '22023 name_taken'
  and pg_temp.try('ada', pg_temp.create_sql('speaksix', 'speaksix · main')) = '22023 name_taken'
  and pg_temp.message('ada', pg_temp.create_sql('speaksix', 'podcast')) = 'You already have a link with this name'
  and pg_temp.n(format('public.affiliate_links where affiliate_id = %L', pg_temp.q('creator_ada'))) = 8,
  'a name another link of the member has, a channel''s name or the main link''s name is taken, whatever its case');
select pg_temp.check(pg_temp.try('ada', pg_temp.create_sql('no-such-program', 'Podcast')) = '42501 not_member'
  and pg_temp.try('ada', pg_temp.create_sql('rival-reader', 'Podcast')) = '42501 not_member'
  and pg_temp.try('eve', pg_temp.create_sql('speaksix', 'Podcast')) = '42501 not_member'
  and pg_temp.try('eve', pg_temp.create_sql('quiet-club', 'Podcast')) = '42501 not_member'
  and pg_temp.try('ada_reader', pg_temp.create_sql('speaksix', 'Reader')) = '42501'
  and pg_temp.message('ada_reader', pg_temp.create_sql('speaksix', 'Reader')) = 'Your role on this creator account cannot change links'
  and pg_temp.try('ada_reader', pg_temp.remove_sql((pg_temp.link_row('ada', 'acme', 'Podcast')).id)) = '42501',
  'only an active member can add a link to a program, and somebody who only reads a creator account cannot change links');
-- Somebody who works on the creator account can. Spaces around and inside a name are tidied.
select pg_temp.check(pg_temp.names(pg_temp.call('ada_helper', pg_temp.create_sql('speaksix', E'  Blog \t  post  ')))
    = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter, Podcast, Blog post'
  and (pg_temp.link_row('ada', 'acme', 'Blog post')).sub1 = 'blog-post'
  and (pg_temp.link_row('ada', 'acme', 'Blog post')).created_by = pg_temp.q('ada_helper')
  and pg_temp.short_path('ada', 'acme', 'Blog post') = '/speaksix/ada-okafor/blog-post'
  and pg_temp.call('ada', pg_temp.create_sql('speaksix', repeat('n', 40)))->>'custom_links' = '3',
  'a member of the creator account can add a link; a name is one line of up to 40 characters');

-- Removing.
select pg_temp.capture('partner_program_link_remove.done',
  pg_temp.keep('removed', pg_temp.call('ada', pg_temp.remove_sql((pg_temp.link_row('ada', 'acme', repeat('n', 40))).id))));
select pg_temp.check((select pg_temp.keys(p) = 'currency custom_links links name paused_reason program_id slug working'
      and p->>'custom_links' = '2' and p = pg_temp.listed(pg_temp.links('ada'), 'speaksix')
      and pg_temp.names(p) = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter, Podcast, Blog post'
    from (select pg_temp.kept('removed') as p) x)
  and (select l.status = 'archived' and l.archived_at is not null from pg_temp.link_row('ada', 'acme', repeat('n', 40)) l)
  and pg_temp.try('ada', pg_temp.remove_sql((pg_temp.link_row('ada', 'acme', repeat('n', 40))).id)) = 'P0002 link_not_found',
  'a custom link nobody opened can be removed: the row is archived and the answer is the program without it');
select pg_temp.check(pg_temp.try('ada', 'select public.partner_program_link_remove(null)') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_link_remove(''{}'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_link_remove(''{"link_id":"nope"}'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_link_remove(''{"link_id":7}'')') = '22023 invalid_input'
  and pg_temp.try('ada', format('select public.partner_program_link_remove(%L)',
    jsonb_build_object('link_id', (pg_temp.link_row('ada', 'acme', 'Podcast')).id, 'force', true))) = '22023 invalid_input'
  and pg_temp.try('ada', pg_temp.remove_sql(gen_random_uuid())) = 'P0002 link_not_found'
  and pg_temp.try('ada', pg_temp.remove_sql((pg_temp.link_row('ben', 'rival', 'While off')).id)) = 'P0002 link_not_found'
  and pg_temp.try('ben', pg_temp.remove_sql((pg_temp.link_row('ada', 'acme', 'Podcast')).id)) = 'P0002 link_not_found'
  and pg_temp.try('ada', pg_temp.remove_sql((pg_temp.link_row('ada', 'acme', 'Main link')).id)) = '22023 not_removable'
  and pg_temp.try('ada', pg_temp.remove_sql((pg_temp.link_row('ada', 'acme', 'TikTok')).id)) = '22023 not_removable'
  and (select bool_and(l.status = 'active') and count(*) = 9 from pg_temp.link_rows('ada', 'acme') l where l.status <> 'archived'),
  'a link that is not the caller''s is not found, and the main link and the channel links cannot be removed');
-- The archived link, opened: the visitor is sent on and nothing is credited.
select pg_temp.check(pg_temp.open('ada', 'acme', repeat('n', 40))
    = '{"click_id":null,"destination_url":"https://speaksix.com/start","is_bot":false}'
  and pg_temp.open_short('/speaksix/ada-okafor/' || repeat('n', 40))->>'click_id' is null
  and pg_temp.n(format('public.clicks where affiliate_id = %L', pg_temp.q('creator_ada'))) = 0,
  'a removed link still sends the visitor to the landing page and credits nothing');
-- Adding the same name again brings the removed link back, with its address.
insert into qa select 'ada_removed', (pg_temp.link_row('ada', 'acme', repeat('n', 40))).id;
select pg_temp.keep('added_again', pg_temp.call('ada', pg_temp.create_sql('speaksix', repeat('N', 40))));
select pg_temp.check(pg_temp.line(pg_temp.kept('added_again'), repeat('N', 40)) @> jsonb_build_object('link_id', pg_temp.q('ada_removed'),
    'url', 'https://go.kissmyapps.dev/speaksix/ada-okafor/' || repeat('n', 40), 'removable', true)
  and pg_temp.n(format('public.affiliate_links where affiliate_id = %L', pg_temp.q('creator_ada'))) = 10
  and (select l.status = 'active' and l.archived_at is null and l.name = repeat('N', 40)
    from public.affiliate_links l where l.id = pg_temp.q('ada_removed')),
  'adding a removed name again brings that link back with the address it had');
select pg_temp.check(pg_temp.call('ada', pg_temp.remove_sql(pg_temp.q('ada_removed')))->>'custom_links' = '2', 'and it can be removed again');
-- A link that was opened stays, even when only a bot opened it.
select pg_temp.call('ada', pg_temp.create_sql('speaksix', 'Old bio'));
insert into qa select 'visit_ada_blog', pg_temp.open('ada', 'acme', 'Blog post')->>'click_id';
select pg_temp.check(pg_temp.open('ada', 'acme', 'Old bio', '{"is_bot":true}')->>'click_id' is not null
  and (select pg_temp.line(p, 'Blog post') @> '{"clicks":1,"removable":false}' and pg_temp.line(p, 'Old bio') @> '{"clicks":0,"removable":false}'
      and pg_temp.line(p, 'Podcast') @> '{"clicks":0,"removable":true}' and p->>'custom_links' = '3'
    from (select pg_temp.listed(pg_temp.links('ada'), 'speaksix') as p) x)
  and pg_temp.try('ada', pg_temp.remove_sql((pg_temp.link_row('ada', 'acme', 'Blog post')).id)) = '22023 link_in_use'
  and pg_temp.try('ada', pg_temp.remove_sql((pg_temp.link_row('ada', 'acme', 'Old bio')).id)) = '22023 link_in_use'
  and pg_temp.message('ada', pg_temp.remove_sql((pg_temp.link_row('ada', 'acme', 'Old bio')).id)) = 'This link has been opened, so it stays'
  and (pg_temp.link_row('ada', 'acme', 'Blog post')).status = 'active' and (pg_temp.link_row('ada', 'acme', 'Old bio')).status = 'active',
  'a link that was opened cannot be removed, so a posted link never dies; a bot''s visit counts for that and not as a click');

-- A link that has no readable address is shown by its long one.
alter table public.affiliate_links disable trigger affiliate_links_allocate_alias;
select pg_temp.call('dee', pg_temp.create_sql('quiet-club', 'Plain'));
alter table public.affiliate_links enable trigger affiliate_links_allocate_alias;
select pg_temp.check((select pg_temp.line(p, 'Plain')->>'url' ~ '^https://go\.kissmyapps\.dev/r/dee-vale/[0-9a-f]{36}$'
      and pg_temp.line(p, 'Plain')->>'url' = (pg_temp.link_row('dee', 'quiet', 'Plain')).tracking_url
    from (select pg_temp.listed(pg_temp.links('dee'), 'quiet-club') as p) x)
  and pg_temp.call('dee', pg_temp.remove_sql((pg_temp.link_row('dee', 'quiet', 'Plain')).id))->>'custom_links' = '0',
  'a link without a readable address shows its long address');

-- Names that share a tag, names with no letters, and the limit (Cy, on SpeakSix).
select pg_temp.call('cy', pg_temp.create_sql('speaksix', 'My Link'));
select pg_temp.call('cy', pg_temp.create_sql('speaksix', 'my-link'));
select pg_temp.call('cy', pg_temp.create_sql('speaksix', '!!!'));
select pg_temp.call('cy', pg_temp.create_sql('speaksix', 'Podcast'));
select pg_temp.check((pg_temp.link_row('cy', 'acme', 'My Link')).sub1 = 'my-link'
  and (pg_temp.link_row('cy', 'acme', 'my-link')).sub1 = 'my-link-2'
  and (pg_temp.link_row('cy', 'acme', '!!!')).sub1 = 'link'
  and pg_temp.short_path('cy', 'acme', 'My Link') = '/speaksix/cy-park/my-link'
  and pg_temp.short_path('cy', 'acme', 'my-link') = '/speaksix/cy-park/my-link-2'
  and pg_temp.short_path('cy', 'acme', '!!!') = '/speaksix/cy-park/link'
  and pg_temp.short_path('cy', 'acme', 'Podcast') = '/speaksix/cy-park/podcast'
  and pg_temp.open_short('/speaksix/cy-park/my-link-2')->>'click_id' is not null,
  'two names that differ only in punctuation get two addresses, and one creator''s names do not block another''s');
select pg_temp.call('cy', pg_temp.create_sql('speaksix', 'Extra ' || n)) from generate_series(1, 16) n;
select pg_temp.check((select p->>'custom_links' = '20' and jsonb_array_length(p->'links') = 27
      and pg_temp.names(p) = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter, My Link, my-link, !!!, Podcast, '
        || (select string_agg('Extra ' || n, ', ' order by n) from generate_series(1, 16) n)
    from (select pg_temp.listed(pg_temp.links('cy'), 'speaksix') as p) x)
  and pg_temp.try('cy', pg_temp.create_sql('speaksix', 'One too many')) = '22023 too_many_links'
  and pg_temp.message('cy', pg_temp.create_sql('speaksix', 'One too many')) = 'You can have up to 20 custom links for a program'
  and pg_temp.call('cy', pg_temp.remove_sql((pg_temp.link_row('cy', 'acme', 'Extra 16')).id))->>'custom_links' = '19'
  and pg_temp.call('cy', pg_temp.create_sql('speaksix', 'Room again'))->>'custom_links' = '20'
  and pg_temp.try('cy', pg_temp.create_sql('speaksix', 'One too many')) = '22023 too_many_links',
  'a member can have 20 custom links for a program, listed oldest first after the channels; removing one makes room');

-- Clicks and sales ---------------------------------------------------------------------------------
-- Ada is also in Rival Reader; Ben is also in SpeakSix. Everybody has been a member for a long time.
select pg_temp.join('ada', 'rival');
select pg_temp.decide('rival_owner', 'rival', 'ada', 'approve');
select pg_temp.join('ben', 'acme');
update public.affiliate_program_members set activated_at = now() - interval '500 days';
-- Today's visits (the visit on Ada's Blog post link above is one of them).
insert into qa values
  ('visit_ada_main', pg_temp.open('ada', 'acme', 'Main link')->>'click_id'),
  ('visit_ada_tiktok', pg_temp.open_short('/speaksix/ada-okafor/tiktok')->>'click_id'),
  ('visit_ada_podcast', pg_temp.open_short('/speaksix/ada-okafor/podcast')->>'click_id'),
  ('visit_ada_rival', pg_temp.open('ada', 'rival', 'Main link')->>'click_id'),
  ('visit_ben_main', pg_temp.open('ben', 'acme', 'Main link')->>'click_id'),
  ('visit_cy_main', pg_temp.open('cy', 'acme', 'Main link')->>'click_id'),
  ('visit_dee_tiktok', pg_temp.open('dee', 'quiet', 'TikTok')->>'click_id');
insert into qa select replace(q.key, 'visit_', 'click_'), k.id from qa q join public.clicks k on k.public_click_id = q.value
  where q.key like 'visit\_%';
select pg_temp.open('ada', 'acme', 'Main link', '{"is_bot":true}');
select pg_temp.check((select count(*) = 8 from qa where key like 'click\_%')
  and (select k.source_id = (select s.id from public.sources s where s.key = 'tiktok') and k.sub1 is null
    from public.clicks k where k.id = pg_temp.q('click_ada_tiktok'))
  and (select k.source_id is null and k.sub1 = 'podcast' from public.clicks k where k.id = pg_temp.q('click_ada_podcast')),
  'a click copies its link''s source: the channel''s for a channel link, none for a custom link, which carries its tag');
-- Visits on earlier days of Ada's calendar. Each pair straddles a midnight of hers: the
-- first moment of a day, and the last moment of the day before.
select pg_temp.click_at('ada', 'acme', x.link, pg_temp.day('ada', x.back) - make_interval(secs => x.before))
from (values ('TikTok', 1, 0), ('TikTok', 1, 0.000001), ('Instagram', 6, 0), ('Instagram', 6, 0.000001),
  ('Main link', 29, 0), ('Main link', 29, 0.000001), ('Main link', 59, 0), ('Main link', 59, 0.000001),
  ('YouTube', 89, 0), ('YouTube', 89, 0.000001), ('YouTube', 179, 0), ('YouTube', 179, 0.000001)) x(link, back, before);
select pg_temp.click_at('ada', 'rival', 'TikTok', pg_temp.day('ada', 20));
select pg_temp.check((select (k.occurred_at at time zone 'UTC')::date = (k.occurred_at at time zone 'Pacific/Kiritimati')::date - 1
    from public.clicks k where k.affiliate_id = pg_temp.q('creator_ada') and k.occurred_at = pg_temp.day('ada', 1))
  and pg_temp.n(format('public.clicks where affiliate_id = %L and product_id = %L and not is_bot',
    pg_temp.q('creator_ada'), (pg_temp.program('acme')).product_id)) = 16,
  'the first moment of a day of Ada''s calendar is still the day before in UTC');

-- A sale from before program money was switched on is never judged.
select pg_temp.sale('s0', 'acme', pg_temp.q('click_ada_main'), 2500, pg_temp.day('ada', 5) + interval '12 hours',
  'metadata', now() - interval '1 day');
select pg_temp.check(pg_temp.commission('s0') = 'none', 'a sale from before program money has no commission');
update public.platform_settings set program_money_enabled = true where singleton;
select pg_temp.open_account('acme', 'owner'), pg_temp.open_account('rival', 'rival_owner');
select pg_temp.fund('acme', 500000), pg_temp.fund('rival', 100000);
-- Ada's sales in SpeakSix, by her calendar: today, the first moment of yesterday, the last
-- moment of the day before, 3, 4, 40 and 100 days ago.
select pg_temp.sale('s1', 'acme', pg_temp.q('click_ada_tiktok'), 4900, now());
select pg_temp.sale('s2', 'acme', pg_temp.q('click_ada_main'), 10000, pg_temp.day('ada', 1), 'client_reference_id');
select pg_temp.sale('s3', 'acme', pg_temp.q('click_ada_podcast'), 2000, pg_temp.day('ada', 1) - interval '0.000001 seconds', 'email');
select pg_temp.sale('s4', 'acme', pg_temp.q('click_ada_tiktok'), 4900, pg_temp.day('ada', 40) + interval '12 hours');
select pg_temp.sale('s5', 'acme', pg_temp.q('click_ada_tiktok'), 4900, pg_temp.day('ada', 3) + interval '12 hours');
select pg_temp.sale('s6', 'acme', pg_temp.q('click_ada_main'), 8000, pg_temp.day('ada', 4) + interval '12 hours');
select pg_temp.sale('s7', 'acme', pg_temp.q('click_ada_main'), 6000, pg_temp.day('ada', 100) + interval '12 hours');
-- Ben's one sale was paid in the same instant as Ada's of today.
select pg_temp.sale('b1', 'acme', pg_temp.q('click_ben_main'), 2000, now());
-- A payment nobody sent.
select pg_temp.sale('n1', 'acme', null, 9900, now());
-- Ada in Rival Reader: one sale 20 days ago, one today.
select pg_temp.sale('r1', 'rival', pg_temp.q('click_ada_rival'), 5000, pg_temp.day('ada', 20) + interval '12 hours');
select pg_temp.sale('r2', 'rival', pg_temp.q('click_ada_rival'), 2500, now());
-- One payment is refunded in full, one by half. The holds that have passed are approved.
select pg_temp.refund('s5', 4900), pg_temp.refund('s6', 4000);
select pg_temp.check(pg_temp.svc('program_commissions_tick', '{"limit":100}')->>'approved' = '3', 'three holds have passed');
-- The merchant pauses SpeakSix for a moment: a payment that arrives then earns nothing.
select pg_temp.set_status('owner', 'acme', 'paused');
select pg_temp.sale('s8', 'acme', pg_temp.q('click_ada_main'), 3000, clock_timestamp());
select pg_temp.set_status('owner', 'acme', 'live');
-- Cy leaves SpeakSix; a payment through an old click of theirs earns nothing.
select pg_temp.leave('cy', 'acme');
select pg_temp.sale('c1', 'acme', pg_temp.q('click_cy_main'), 1500, clock_timestamp());
-- Quiet Club has no balance: Dee's sale earns nothing and the program pauses.
select pg_temp.sale('d1', 'quiet', pg_temp.q('click_dee_tiktok'), 4000, now());
select pg_temp.check(pg_temp.commission('s1') = 'held 1470 147 -' and pg_temp.commission('s2') = 'held 3000 300 -'
  and pg_temp.commission('s3') = 'held 600 60 -' and pg_temp.commission('s4') = 'approved 1470 147 -'
  and pg_temp.commission('s5') = 'reversed 0 0 -' and pg_temp.commission('s6') = 'held 1200 120 -'
  and pg_temp.commission('s7') = 'approved 1800 180 -' and pg_temp.commission('s8') = 'not_earned 0 0 program_paused'
  and pg_temp.commission('b1') = 'held 600 60 -' and pg_temp.commission('c1') = 'not_earned 0 0 not_a_member'
  and pg_temp.commission('n1') = 'not_earned 0 0 no_creator' and pg_temp.commission('d1') = 'not_earned 0 0 balance_empty'
  and pg_temp.commission('r1') = 'approved 1000 100 -' and pg_temp.commission('r2') = 'held 500 50 -'
  and pg_temp.commission('s0') = 'none'
  and (pg_temp.program('acme')).status = 'live' and (pg_temp.program('quiet')).pause_reason = 'balance_empty',
  'the fixture sales: held, approved, returned, partly refunded, not earned for three reasons, sent by nobody, and not judged');
-- A payout of Ada's Rival Reader money was paid; one of her SpeakSix money is under way.
insert into public.program_payouts(id, affiliate_id, platform_account_id, currency, amount_minor, status, connect_account_id,
    transfer_id, approved_by, paid_at, closed_at) values
  ('b7000000-0000-4000-8000-000000000001', pg_temp.q('creator_ada'), 'acct_KMAPlatform', 'USD', 1000, 'paid', 'acct_AdaPayouts',
    'tr_p5paid', pg_temp.q('kma_owner'), now(), now()),
  ('b7000000-0000-4000-8000-000000000002', pg_temp.q('creator_ada'), 'acct_KMAPlatform', 'USD', 1800, 'approved', null,
    null, pg_temp.q('kma_owner'), null, null);
insert into public.program_payout_items(payout_id, program_id, amount_minor) values
  ('b7000000-0000-4000-8000-000000000001', (pg_temp.program('rival')).id, 1000),
  ('b7000000-0000-4000-8000-000000000002', (pg_temp.program('acme')).id, 1800);
insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, payout_id) values
  (pg_temp.q('creator_ada'), (pg_temp.program('rival')).id, 'USD', 'payout', -1000, 'b7000000-0000-4000-8000-000000000001'),
  (pg_temp.q('creator_ada'), (pg_temp.program('acme')).id, 'USD', 'payout', -1800, 'b7000000-0000-4000-8000-000000000002');

-- The Links page with results ----------------------------------------------------------------------
select pg_temp.capture('partner_program_links.two_programs', pg_temp.keep('links_two', pg_temp.links('ada')));
select pg_temp.check((select jsonb_array_length(a->'programs') = 2
      and a->'programs'->0->>'name' = 'Rival Reader' and a->'programs'->1->>'name' = 'SpeakSix'
      and s - 'links' = jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'slug', 'speaksix', 'name', 'SpeakSix',
        'currency', 'USD', 'working', true, 'paused_reason', null, 'custom_links', 3)
      and pg_temp.names(s) = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter, Podcast, Blog post, Old bio'
      -- The last 30 days of Ada's calendar. The refunded sale, the unjudged one and the one that earned nothing are not sales.
      and pg_temp.numbers(s->'links') = 'Main link 2/2/4200, TikTok 3/1/1470, Instagram 2/0/0, Podcast 1/1/600, Blog post 1/0/0'
      and pg_temp.numbers(r->'links') = 'Main link 1/2/1500, TikTok 1/0/0'
      and r @> '{"working":true,"custom_links":0,"currency":"USD"}'
      and (select bool_and((l->>'removable')::boolean = (l->>'name' = 'never')) from jsonb_array_elements(s->'links') l)
    from (select pg_temp.kept('links_two') as a, pg_temp.listed(pg_temp.kept('links_two'), 'speaksix') as s,
      pg_temp.listed(pg_temp.kept('links_two'), 'rival-reader') as r) x),
  'the Links page lists a creator''s programs by name, each link with its clicks, sales and earnings of the last 30 days');
select pg_temp.check((select pg_temp.numbers(pg_temp.listed(pg_temp.links('ben'), 'speaksix')->'links') = 'Main link 1/1/600'
    and pg_temp.listed(pg_temp.links('cy'), 'speaksix') is null),
  'each creator sees their own results, and a program they left is gone from their Links page');

-- The Performance page -----------------------------------------------------------------------------
select pg_temp.capture('partner_program_performance.days7', pg_temp.keep('p7', pg_temp.performance('ada', 'speaksix', 7)));
select pg_temp.capture('partner_program_performance.days30', pg_temp.keep('p30', pg_temp.performance('ada', 'speaksix', 30)));
select pg_temp.capture('partner_program_performance.days90', pg_temp.keep('p90', pg_temp.performance('ada', 'speaksix', 90)));
select pg_temp.check((select a @> '{"days":7,"timezone":"Pacific/Kiritimati",
        "totals":{"clicks":7,"sales":4,"earnings_minor":6270},"previous":{"clicks":1,"sales":0,"earnings_minor":0}}'
      and a->>'starts_on' = pg_temp.date_of('ada', 6) and a->>'ends_on' = pg_temp.date_of('ada', 0)
      and jsonb_array_length(a->'daily') = 7
      -- <days back> <clicks>/<sales>/<earnings>: today, yesterday, the day before, 4 and 6 days back.
      and pg_temp.days('ada', a) = '0 4/1/1470, 1 1/1/3000, 2 1/1/600, 4 0/1/1200, 6 1/0/0'
      and pg_temp.numbers(a->'channels') = 'Main link 1/2/4200, TikTok 3/1/1470, Instagram 1/0/0, Podcast 1/1/600, Blog post 1/0/0'
      and (select string_agg(c->>'name', ', ' order by n)
          = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter, Podcast, Blog post, Old bio'
        from jsonb_array_elements(a->'channels') with ordinality e(c, n))
      and a->'programs' = jsonb_build_array(
        jsonb_build_object('program_id', (pg_temp.program('rival')).id, 'slug', 'rival-reader', 'name', 'Rival Reader', 'currency', 'USD'),
        jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'slug', 'speaksix', 'name', 'SpeakSix', 'currency', 'USD'))
      and a->'program' = a->'programs'->1
    from (select pg_temp.kept('p7') as a) x),
  '7 days: a click or a sale at the first moment of a day of the creator''s calendar belongs to that day, one a moment '
    || 'earlier to the day before; the window before it has the click of the day before the window');
select pg_temp.check((select a @> '{"days":30,"totals":{"clicks":9,"sales":4,"earnings_minor":6270},
        "previous":{"clicks":2,"sales":1,"earnings_minor":1470}}'
      and a->>'starts_on' = pg_temp.date_of('ada', 29) and jsonb_array_length(a->'daily') = 30
      and pg_temp.days('ada', a) = '0 4/1/1470, 1 1/1/3000, 2 1/1/600, 4 0/1/1200, 6 1/0/0, 7 1/0/0, 29 1/0/0'
      and pg_temp.numbers(a->'channels') = 'Main link 2/2/4200, TikTok 3/1/1470, Instagram 2/0/0, Podcast 1/1/600, Blog post 1/0/0'
      and a->'channels' = (select jsonb_agg(l - 'url' - 'created_at' - 'removable' order by n)
        from jsonb_array_elements(pg_temp.listed(pg_temp.kept('links_two'), 'speaksix')->'links') with ordinality e(l, n))
    from (select pg_temp.kept('p30') as a) x),
  '30 days: the numbers per link are the Links page''s; the 30 days before hold the approved sale of 40 days ago');
select pg_temp.check((select a @> '{"days":90,"totals":{"clicks":13,"sales":5,"earnings_minor":7740},
        "previous":{"clicks":2,"sales":1,"earnings_minor":1800}}'
      and a->>'starts_on' = pg_temp.date_of('ada', 89) and jsonb_array_length(a->'daily') = 90
      and pg_temp.days('ada', a) = '0 4/1/1470, 1 1/1/3000, 2 1/1/600, 4 0/1/1200, 6 1/0/0, 7 1/0/0, 29 1/0/0, 30 1/0/0, '
        || '40 0/1/1470, 59 1/0/0, 60 1/0/0, 89 1/0/0'
      and pg_temp.numbers(a->'channels')
        = 'Main link 5/2/4200, TikTok 3/2/2940, Instagram 2/0/0, YouTube 1/0/0, Podcast 1/1/600, Blog post 1/0/0'
    from (select pg_temp.kept('p90') as a) x),
  '90 days: every edge of the window and of the 90 days before it falls on the creator''s midnight');
select pg_temp.check((select bool_and(
      (a->'totals'->>'clicks')::bigint = (select sum((d->>'clicks')::bigint) from jsonb_array_elements(a->'daily') d)
      and (a->'totals'->>'sales')::bigint = (select sum((d->>'sales')::bigint) from jsonb_array_elements(a->'daily') d)
      and (a->'totals'->>'earnings_minor')::bigint = (select sum((d->>'earnings_minor')::bigint) from jsonb_array_elements(a->'daily') d)
      and (a->'totals'->>'clicks')::bigint = (select sum((c->>'clicks')::bigint) from jsonb_array_elements(a->'channels') c)
      and (a->'totals'->>'sales')::bigint = (select sum((c->>'sales')::bigint) from jsonb_array_elements(a->'channels') c)
      and (a->'totals'->>'earnings_minor')::bigint = (select sum((c->>'earnings_minor')::bigint) from jsonb_array_elements(a->'channels') c)
      and (select bool_and((d->>'day')::date = (a->>'starts_on')::date + (n - 1)::integer)
        from jsonb_array_elements(a->'daily') with ordinality e(d, n))
      and a->'money' = pg_temp.kept('p7')->'money' and a->'latest' = pg_temp.kept('p7')->'latest')
    from (select answer as a from answers where name in ('p7', 'p30', 'p90')) x),
  'the days and the links each add up to the totals, the days run without a gap, and the money and the latest sales '
    || 'do not depend on the window');
select pg_temp.check((select a->'money' = jsonb_build_object('pending_minor', 6270, 'approved_minor', 1470, 'paying_minor', 1800,
        'paid_minor', 0, 'next_release_at', pg_temp.day('ada', 4) + interval '12 hours' + interval '30 days')
      and a->'money' = e - 'program_id' - 'slug' - 'name' - 'currency' - 'sales'
      and a->'latest' = jsonb_build_array(
        jsonb_build_object('paid_at', now(), 'link_name', 'TikTok', 'amount_minor', 1470, 'status', 'held'),
        jsonb_build_object('paid_at', pg_temp.day('ada', 1), 'link_name', 'Main link', 'amount_minor', 3000, 'status', 'held'),
        jsonb_build_object('paid_at', pg_temp.day('ada', 1) - interval '0.000001 seconds', 'link_name', 'Podcast',
          'amount_minor', 600, 'status', 'held'),
        jsonb_build_object('paid_at', pg_temp.day('ada', 3) + interval '12 hours', 'link_name', 'TikTok', 'amount_minor', 0, 'status', 'reversed'),
        jsonb_build_object('paid_at', pg_temp.day('ada', 4) + interval '12 hours', 'link_name', 'Main link', 'amount_minor', 1200, 'status', 'held'))
    from (select pg_temp.kept('p7') as a, pg_temp.earnings_line('ada', 'speaksix') as e) x),
  'the money is the program''s line of the creator''s earnings, to date; the latest five commissions come newest first '
    || 'with their link and what they are worth now');
-- With no slug: the first program by name.
select pg_temp.capture('partner_program_performance.first_program', pg_temp.keep('p_rival', pg_temp.performance('ada', null, 30)));
select pg_temp.check((select a->'program'->>'slug' = 'rival-reader' and a = pg_temp.performance('ada', 'rival-reader', 30)
      and a = pg_temp.call('ada', 'select public.partner_program_performance(''{"days":30}'')')
      and a @> '{"totals":{"clicks":2,"sales":2,"earnings_minor":1500},"previous":{"clicks":0,"sales":0,"earnings_minor":0}}'
      and pg_temp.days('ada', a) = '0 1/1/500, 20 1/1/1000'
      and pg_temp.numbers(a->'channels') = 'Main link 1/2/1500, TikTok 1/0/0'
      and a->'money' = jsonb_build_object('pending_minor', 500, 'approved_minor', 0, 'paying_minor', 0, 'paid_minor', 1000,
        'next_release_at', now() + interval '14 days')
      and a->'money' = pg_temp.earnings_line('ada', 'rival-reader') - 'program_id' - 'slug' - 'name' - 'currency' - 'sales'
      and jsonb_array_length(a->'latest') = 2 and a->'latest'->1 @> '{"link_name":"Main link","amount_minor":1000,"status":"approved"}'
    from (select pg_temp.kept('p_rival') as a) x),
  'with no program named the first by name is reported; money that was paid out shows as paid');
select pg_temp.check(pg_temp.performance('ada_reader', 'speaksix', 30) = pg_temp.kept('p30')
  and pg_temp.performance('ada_helper', 'speaksix', 30) = pg_temp.kept('p30'),
  'everyone on the creator account reads the same Performance page');
select pg_temp.check(pg_temp.try('ada', 'select public.partner_program_performance(null)') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_performance(''[]'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_performance(''{}'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_performance(''{"slug":"speaksix"}'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_performance(''{"slug":"speaksix","days":"7"}'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_performance(''{"slug":"speaksix","days":8}'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_performance(''{"slug":"speaksix","days":7.5}'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_performance(''{"slug":"speaksix","days":null}'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_performance(''{"slug":7,"days":7}'')') = '22023 invalid_input'
  and pg_temp.try('ada', 'select public.partner_program_performance(''{"slug":"speaksix","days":7,"zone":"UTC"}'')') = '22023 invalid_input'
  and pg_temp.try('ada', pg_temp.performance_sql('quiet-club', 30)) = 'P0002 program_not_found'
  and pg_temp.try('ada', pg_temp.performance_sql('no-such-program', 30)) = 'P0002 program_not_found'
  and pg_temp.try('dee', pg_temp.performance_sql('speaksix', 30)) = 'P0002 program_not_found',
  'the window is 7, 30 or 90 days, and a program that is not the creator''s is not found');
-- Cy left SpeakSix: it is off their Links page, and still theirs to look back on.
select pg_temp.check((select a->'programs'->0->>'slug' = 'speaksix' and a->'program'->>'slug' = 'speaksix'
      and a->'totals' = '{"clicks":2,"sales":0,"earnings_minor":0}'
      and pg_temp.numbers(a->'channels') = 'Main link 1/0/0, my-link 1/0/0'
      and jsonb_array_length(a->'channels') = 27 and a->'latest' = '[]'
      and a->'money' = '{"pending_minor":0,"approved_minor":0,"paying_minor":0,"paid_minor":0,"next_release_at":null}'
    from (select pg_temp.performance('cy', null, 30) as a) x),
  'a creator who left a program can still read its performance; a sale after they left is not theirs');
-- A creator whose time zone Postgres does not know is counted in UTC.
alter table public.affiliates disable trigger affiliates_validate_reporting_timezone;
update public.affiliates set reporting_timezone = 'Mars/Olympus Mons' where id = pg_temp.q('creator_ben');
alter table public.affiliates enable trigger affiliates_validate_reporting_timezone;
select pg_temp.check((select a @> '{"timezone":"UTC","totals":{"clicks":1,"sales":1,"earnings_minor":600}}'
      and a->>'ends_on' = (now() at time zone 'UTC')::date::text and jsonb_array_length(a->'daily') = 7
    from (select pg_temp.performance('ben', 'speaksix', 7) as a) x)
  and pg_temp.numbers(pg_temp.listed(pg_temp.links('ben'), 'speaksix')->'links') = 'Main link 1/1/600',
  'a time zone Postgres does not know counts as UTC');
update public.affiliates set reporting_timezone = 'UTC' where id = pg_temp.q('creator_ben');
-- Ada moves her calendar to UTC and back: the same clicks fall on other days.
update public.affiliates set reporting_timezone = 'UTC' where id = pg_temp.q('creator_ada');
select pg_temp.check((select a->>'timezone' = 'UTC' and a->>'ends_on' = (now() at time zone 'UTC')::date::text
      and (select sum((d->>'clicks')::bigint) from jsonb_array_elements(a->'daily') d) = (a->'totals'->>'clicks')::bigint
      and a->'daily' <> pg_temp.kept('p90')->'daily'
    from (select pg_temp.performance('ada', 'speaksix', 90) as a) x),
  'the days follow the creator''s time zone');
update public.affiliates set reporting_timezone = 'Pacific/Kiritimati' where id = pg_temp.q('creator_ada');
select pg_temp.check(pg_temp.performance('ada', 'speaksix', 90) = pg_temp.kept('p90'), 'and back');

-- A sale whose link is gone: Ada archives the Podcast link on the older Links page.
select pg_temp.call('ada', format('select to_jsonb(r) from public.set_partner_link_status(%L, ''archived'') r',
  (pg_temp.link_row('ada', 'acme', 'Podcast')).id));
select pg_temp.capture('partner_program_performance.sale_without_link', pg_temp.keep('p_none', pg_temp.performance('ada', 'speaksix', 30)));
select pg_temp.check((select a->'totals' = pg_temp.kept('p30')->'totals' and a->'daily' = pg_temp.kept('p30')->'daily'
      and pg_temp.numbers(a->'channels') = 'Main link 2/2/4200, TikTok 3/1/1470, Instagram 2/0/0, Blog post 1/0/0, No link 1/1/600'
      and a->'channels'->-1 = '{"link_id":null,"kind":"none","channel":null,"name":"No link","clicks":1,"sales":1,"earnings_minor":600}'
      and jsonb_array_length(a->'channels') = 10
      and a->'latest'->2->>'link_name' = 'Podcast'
    from (select pg_temp.kept('p_none') as a) x)
  and pg_temp.names(pg_temp.listed(pg_temp.links('ada'), 'speaksix'))
    = 'Main link, TikTok, Instagram, YouTube, Facebook, X, Newsletter, Blog post, Old bio'
  and jsonb_array_length(pg_temp.kept('p30')->'channels') = 10
  and not exists (select 1 from jsonb_array_elements(pg_temp.kept('p30')->'channels') c where c->>'kind' = 'none'),
  'sales through a link that was archived since come under a last line, "No link", which is only there when it has sales');
select pg_temp.call('ada', format('select to_jsonb(r) from public.set_partner_link_status(%L, ''paused'') r',
  (pg_temp.link_row('ada', 'acme', 'Podcast')).id));
select pg_temp.call('ada', format('select to_jsonb(r) from public.set_partner_link_status(%L, ''active'') r',
  (pg_temp.link_row('ada', 'acme', 'Podcast')).id));
select pg_temp.check(pg_temp.performance('ada', 'speaksix', 30) = pg_temp.kept('p30'), 'the link is back and so is its line');

-- No buyer data reaches a creator ---------------------------------------------------------------------
select pg_temp.check((select bool_and(answer::text !~* 'p5buyer|pi_|ch_p5|cs_p5|cus_|acct_|tr_p5|example\.test|speaksix\.com|metadata|client_reference|@')
    from answers where name in ('links_two', 'p7', 'p30', 'p90', 'p_rival', 'p_none', 'created', 'removed', 'links_fresh'))
  and (select count(*) = 15 from public.program_sales s where s.customer_id like 'cus\_P5Buyer%' and s.payment_intent_id like 'pi\_p5buyer%'),
  'nothing Stripe says about a buyer or a payment, and no email, is in anything a creator reads');

-- The merchant's Creators page -----------------------------------------------------------------------
select pg_temp.capture('workspace_program_creators.with_money', pg_temp.keep('creators', pg_temp.creators('owner', 'acme')));
select pg_temp.check((select pg_temp.keys(a) = 'can_manage counts creators currency program totals'
      and a @> '{"can_manage":true,"currency":"USD","counts":{"pending":0,"active":2,"ended":1},
        "totals":{"clicks":19,"sales":11,"sales_amount_minor":49700,"commission_minor":10140,"pending_minor":6870}}'
      and a->'program' = jsonb_build_object('id', (pg_temp.program('acme')).id, 'slug', 'speaksix', 'name', 'SpeakSix',
        'status', 'live', 'approval_mode', 'automatic', 'marketplace_listed', true)
      and (select bool_and(pg_temp.keys(c) = 'activated_at channels clicks commission_minor country_code decision_note '
          || 'ended_at handle last_click_at member_id name needs_new_terms pending_minor requested_at sales '
          || 'sales_amount_minor status terms_version website_url') from jsonb_array_elements(a->'creators') c)
      -- Ada: 16 clicks on six links; nine sales credited to her, four of them worth nothing now.
      and pg_temp.creator(a, 'ada-okafor') @> '{"status":"active","clicks":16,"sales":9,"sales_amount_minor":46200,
        "commission_minor":9540,"pending_minor":6270}'
      and (pg_temp.creator(a, 'ada-okafor')->>'last_click_at')::timestamptz = now()
      and pg_temp.creator(a, 'ben-creator') @> '{"status":"active","clicks":1,"sales":1,"sales_amount_minor":2000,
        "commission_minor":600,"pending_minor":600}'
      and pg_temp.creator(a, 'cy-park') @> '{"status":"left","clicks":2,"sales":1,"sales_amount_minor":1500,
        "commission_minor":0,"pending_minor":0}'
      and (select sum((c->>'clicks')::bigint) = 19 and sum((c->>'sales_amount_minor')::bigint) = 49700
        from jsonb_array_elements(a->'creators') c)
    from (select pg_temp.kept('creators') as a) x),
  'the Creators page: each creator''s clicks on all their links, the sales credited to them and what those came to, their '
    || 'commission as it is worth now with the part still held, and the totals');
select pg_temp.check(pg_temp.creators('analyst', 'acme') = pg_temp.kept('creators') || '{"can_manage":false}'
  and pg_temp.try('rival_owner', format('select public.workspace_program_creators(%L)', pg_temp.q('acme'))) = 'P0002'
  and pg_temp.try('ada', format('select public.workspace_program_creators(%L)', pg_temp.q('acme'))) = 'P0002'
  and pg_temp.kept('creators')::text !~* 'example\.test|Ada N\. Okafor|p5buyer',
  'an analyst of the workspace reads the same page; nobody outside it does; no creator email or legal name is on it');
select pg_temp.capture('workspace_program_creators.no_program', pg_temp.keep('creators_none', pg_temp.creators('empty_owner', 'empty')));
select pg_temp.check(pg_temp.kept('creators_none') = '{"can_manage":true,"program":null,"currency":null,
    "counts":{"pending":0,"active":0,"ended":0},"creators":[],
    "totals":{"clicks":0,"sales":0,"sales_amount_minor":0,"commission_minor":0,"pending_minor":0}}'::jsonb,
  'a workspace with no program has no currency, no creators and totals of zero');
select pg_temp.check((select a->'totals' = '{"clicks":7,"sales":2,"sales_amount_minor":7500,"commission_minor":1500,"pending_minor":500}'
      and pg_temp.creator(a, 'ada-okafor') @> '{"clicks":2,"sales":2,"commission_minor":1500,"pending_minor":500}'
      and pg_temp.creator(a, 'ben-creator') @> '{"clicks":5,"sales":0,"sales_amount_minor":0,"commission_minor":0}'
    from (select pg_temp.creators('rival_owner', 'rival') as a) x),
  'another program has its own numbers');

-- The merchant's Sales page ----------------------------------------------------------------------------
select pg_temp.capture('workspace_program_sales.first_page', pg_temp.keep('page1', pg_temp.sales('owner', 'acme', '{"limit":5}')));
select pg_temp.capture('workspace_program_sales.next_page', pg_temp.keep('page2', pg_temp.sales('owner', 'acme',
  jsonb_build_object('limit', 5, 'before', pg_temp.kept('page1')->'next_before'))));
select pg_temp.capture('workspace_program_sales.last_page', pg_temp.keep('page3', pg_temp.sales('owner', 'acme',
  jsonb_build_object('limit', 5, 'before', pg_temp.kept('page2')->'next_before'))));
select pg_temp.check((select pg_temp.keys(a) = 'currency next_before program sales summary'
      and a->'program' = jsonb_build_object('id', (pg_temp.program('acme')).id, 'slug', 'speaksix', 'name', 'SpeakSix', 'status', 'live')
      and a->>'currency' = 'USD'
      -- The last 30 days: the five sales whose commission is held. Ben's is one of them.
      and a->'summary' = '{"days":30,"sales":5,"sales_amount_minor":26900,"commission_minor":6870,"fee_minor":687}'
      and (select bool_and(pg_temp.keys(s) = 'amount_minor commission_minor creator_name currency fee_minor hold_until link_name '
          || 'match_source member_id paid_at reason refunded_minor sale_id status') from jsonb_array_elements(a->'sales') s)
    from (select pg_temp.kept('page1') as a) x),
  'the Sales page names the program, its currency and the last 30 days in one line');
select pg_temp.check(pg_temp.sold(pg_temp.kept('page1')) in ('c1 s8 s1 b1 s2', 'c1 s8 b1 s1 s2')
  and (pg_temp.kept('page1')->>'next_before')::timestamptz = pg_temp.day('ada', 1)
  and pg_temp.sold(pg_temp.kept('page2')) = 's3 s5 s6 s0 s4'
  and (pg_temp.kept('page2')->>'next_before')::timestamptz = pg_temp.day('ada', 40) + interval '12 hours'
  and pg_temp.sold(pg_temp.kept('page3')) = 's7' and pg_temp.kept('page3')->'next_before' = 'null'
  and pg_temp.kept('page2')->'summary' = pg_temp.kept('page1')->'summary'
  and pg_temp.kept('page3')->'summary' = pg_temp.kept('page1')->'summary'
  and (select count(*) = 11 and count(distinct s->>'sale_id') = 11
    from answers p, jsonb_array_elements(p.answer->'sales') s where p.name in ('page1', 'page2', 'page3')),
  'sales come newest first, a page at a time; the payment nobody sent is not among them');
select pg_temp.check((select pg_temp.sold_line(a, 's1') - 'sale_id' = jsonb_build_object('paid_at', now(), 'amount_minor', 4900,
        'currency', 'USD', 'refunded_minor', 0, 'member_id', (pg_temp.member('ada', 'acme')).id, 'creator_name', 'Ada Okafor',
        'link_name', 'TikTok', 'match_source', 'metadata', 'status', 'pending', 'reason', null, 'commission_minor', 1470,
        'fee_minor', 147, 'hold_until', now() + interval '30 days')
      and pg_temp.sold_line(a, 'b1') @> jsonb_build_object('member_id', (pg_temp.member('ben', 'acme')).id,
        'creator_name', 'Ben Creator', 'link_name', 'Main link', 'status', 'pending', 'commission_minor', 600, 'fee_minor', 60)
      and pg_temp.sold_line(a, 's2') @> '{"link_name":"Main link","match_source":"client_reference_id","status":"pending","commission_minor":3000}'
      and pg_temp.sold_line(a, 's8') @> '{"status":"not_earned","reason":"program_paused","commission_minor":0,"fee_minor":0,"hold_until":null}'
      and pg_temp.sold_line(a, 'c1') @> jsonb_build_object('status', 'not_earned', 'reason', 'not_a_member',
        'creator_name', 'Cy Park', 'member_id', (pg_temp.member('cy', 'acme')).id, 'amount_minor', 1500)
    from (select pg_temp.kept('page1') as a) x)
  and (select pg_temp.sold_line(a, 's3') @> '{"link_name":"Podcast","match_source":"email","status":"pending","commission_minor":600,"fee_minor":60}'
      and pg_temp.sold_line(a, 's5') @> '{"status":"returned","reason":null,"amount_minor":4900,"refunded_minor":4900,"commission_minor":0,"fee_minor":0}'
      and pg_temp.sold_line(a, 's6') @> '{"status":"pending","amount_minor":8000,"refunded_minor":4000,"commission_minor":1200,"fee_minor":120}'
      and pg_temp.sold_line(a, 's0') @> '{"status":"not_judged","reason":null,"commission_minor":0,"fee_minor":0,"hold_until":null}'
      and pg_temp.sold_line(a, 's4') @> '{"status":"approved","reason":null,"link_name":"TikTok","commission_minor":1470,"fee_minor":147}'
    from (select pg_temp.kept('page2') as a) x),
  'each sale shows who sent it and through which link, how it was matched, what it earned and its state in one word: '
    || 'pending, approved, returned, not earned with the reason, or not judged');
-- Two sales paid in the same instant are never split between pages.
select pg_temp.check((select pg_temp.sold(a) in ('c1 s8 s1 b1', 'c1 s8 b1 s1') and (a->>'next_before')::timestamptz = now()
      and pg_temp.sold(pg_temp.sales('owner', 'acme', jsonb_build_object('limit', 3, 'before', a->'next_before'))) = 's2 s3 s5'
    from (select pg_temp.sales('owner', 'acme', '{"limit":3}') as a) x)
  and pg_temp.sold(pg_temp.sales('owner', 'acme', '{"limit":1}')) = 'c1'
  and jsonb_array_length(pg_temp.sales('owner', 'acme')->'sales') = 11
  and pg_temp.sales('owner', 'acme')->'next_before' = 'null'
  and pg_temp.sales('owner', 'acme') = pg_temp.sales('owner', 'acme', '{"limit":null,"before":null,"member_id":null}')
  and jsonb_array_length(pg_temp.sales('owner', 'acme', '{"limit":100}')->'sales') = 11,
  'a page ends on a whole instant, so the next one misses nothing; without a limit a page has up to 50 sales');
select pg_temp.capture('workspace_program_sales.all_statuses', pg_temp.keep('sales_all', pg_temp.sales('owner', 'acme', '{"limit":100}')));
-- One creator's sales.
select pg_temp.capture('workspace_program_sales.one_creator', pg_temp.keep('sales_ben',
  pg_temp.sales('owner', 'acme', jsonb_build_object('member_id', (pg_temp.member('ben', 'acme')).id))));
select pg_temp.check(pg_temp.sold(pg_temp.kept('sales_ben')) = 'b1'
  and pg_temp.kept('sales_ben')->'summary' = pg_temp.kept('page1')->'summary'
  and (select pg_temp.sold(a) = 's8 s1 s2' and (a->>'next_before')::timestamptz = pg_temp.day('ada', 1)
    from (select pg_temp.sales('owner', 'acme', jsonb_build_object('limit', 3, 'member_id', (pg_temp.member('ada', 'acme')).id)) as a) x)
  and jsonb_array_length(pg_temp.sales('owner', 'acme', jsonb_build_object('member_id', (pg_temp.member('ada', 'acme')).id))->'sales') = 9
  and pg_temp.sales('owner', 'acme', jsonb_build_object('member_id', (pg_temp.member('ada', 'rival')).id))->'sales' = '[]'
  and pg_temp.sales('owner', 'acme', jsonb_build_object('member_id', gen_random_uuid()))->'sales' = '[]',
  'the list can be narrowed to one creator of the program; the summary stays the whole program''s');
select pg_temp.check(pg_temp.try('owner', pg_temp.sales_sql('acme', null)) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sales_sql('acme', '[]')) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sales_sql('acme', '{"page":2}')) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sales_sql('acme', '{"limit":0}')) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sales_sql('acme', '{"limit":101}')) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sales_sql('acme', '{"limit":2.5}')) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sales_sql('acme', '{"limit":"5"}')) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sales_sql('acme', '{"before":"yesterday-ish"}')) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sales_sql('acme', '{"before":7}')) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sales_sql('acme', '{"member_id":"ada"}')) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sales_sql('acme', '{"member_id":7}')) = '22023 invalid_input',
  'a request with anything but a limit of 1 to 100, a time and a member is refused');
select pg_temp.check(pg_temp.sales('analyst', 'acme', '{"limit":5}') = pg_temp.kept('page1')
  and pg_temp.try('rival_owner', pg_temp.sales_sql('acme')) = 'P0002'
  and pg_temp.try('ada', pg_temp.sales_sql('acme')) = 'P0002'
  and pg_temp.try('stranger', pg_temp.sales_sql('acme')) = 'P0002',
  'an analyst of the workspace reads the Sales page; nobody outside the workspace does');
select pg_temp.check((select bool_and(answer::text !~* 'p5buyer|pi_|cus_|cs_p5|ch_p5|example\.test|Ada N\. Okafor|@')
    from answers where name in ('page1', 'page2', 'page3', 'sales_all', 'sales_ben', 'creators')),
  'no buyer, no payment id and no email is on the Creators or the Sales page');
-- A program whose balance could not cover a commission.
select pg_temp.capture('workspace_program_sales.balance_empty', pg_temp.keep('sales_quiet', pg_temp.sales('quiet_owner', 'quiet')));
select pg_temp.check((select a->'program' @> '{"slug":"quiet-club","status":"paused"}'
      and a->'summary' = '{"days":30,"sales":0,"sales_amount_minor":0,"commission_minor":0,"fee_minor":0}'
      and a->'sales'->0 @> '{"status":"not_earned","reason":"balance_empty","creator_name":"Dee Vale","link_name":"TikTok","amount_minor":4000}'
      and jsonb_array_length(a->'sales') = 1 and a->'next_before' = 'null'
    from (select pg_temp.kept('sales_quiet') as a) x),
  'a sale the balance could not cover is listed as not earned, balance empty');
select pg_temp.capture('workspace_program_sales.no_sales', pg_temp.keep('sales_rival_ben',
  pg_temp.sales('rival_owner', 'rival', jsonb_build_object('member_id', (pg_temp.member('ben', 'rival')).id))));
select pg_temp.check(pg_temp.kept('sales_rival_ben') - 'program' = '{"currency":"USD","sales":[],"next_before":null,
    "summary":{"days":30,"sales":2,"sales_amount_minor":7500,"commission_minor":1500,"fee_minor":150}}'::jsonb,
  'a creator with no sales has an empty list');
select pg_temp.capture('workspace_program_sales.no_program', pg_temp.keep('sales_none', pg_temp.sales('empty_owner', 'empty')));
select pg_temp.check(pg_temp.kept('sales_none') = '{"program":null,"currency":null,"sales":[],"next_before":null,
    "summary":{"days":30,"sales":0,"sales_amount_minor":0,"commission_minor":0,"fee_minor":0}}'::jsonb
  and pg_temp.try('empty_owner', pg_temp.sales_sql('empty', '{"limit":0}')) = '22023 invalid_input',
  'a workspace with no program has no sales');

-- Paused programs on the Links page ---------------------------------------------------------------------
select pg_temp.set_status('rival_owner', 'rival', 'paused');
select pg_temp.capture('partner_program_links.paused', pg_temp.keep('links_paused', pg_temp.links('ada')));
select pg_temp.check((select pg_temp.listed(a, 'rival-reader') @> '{"working":false,"paused_reason":"program_paused"}'
      and pg_temp.listed(a, 'speaksix') @> '{"working":true,"paused_reason":null}'
      and pg_temp.numbers(pg_temp.listed(a, 'rival-reader')->'links') = 'Main link 1/2/1500, TikTok 1/0/0'
    from (select pg_temp.kept('links_paused') as a) x),
  'a program the merchant paused is shown as paused, with its links and their results; the other program is not touched');
select pg_temp.capture('partner_program_links.balance_empty', pg_temp.keep('links_balance', pg_temp.links('dee')));
select pg_temp.check((select jsonb_array_length(a->'programs') = 1
      and a->'programs'->0 @> '{"slug":"quiet-club","working":false,"paused_reason":"balance_empty","custom_links":0}'
      -- The sale earned nothing, so it is not a sale in these numbers.
      and pg_temp.numbers(a->'programs'->0->'links') = 'TikTok 2/0/0'
    from (select pg_temp.kept('links_balance') as a) x)
  and pg_temp.open('dee', 'quiet', 'TikTok')->>'click_id' is null,
  'a program paused for an empty balance says so, and its links credit nothing meanwhile');
select pg_temp.capture('partner_program_performance.paused_program', pg_temp.performance('dee', 'quiet-club', 30));
-- Money arrives: the program goes live by itself and its links credit again.
select pg_temp.open_account('quiet', 'quiet_owner');
select pg_temp.fund('quiet', 20000);
select pg_temp.check(kma_internal.program_balance_resume((pg_temp.account('quiet')).id)
  and (pg_temp.program('quiet')).status = 'live'
  and pg_temp.links('dee')->'programs'->0 @> '{"working":true,"paused_reason":null}'
  and pg_temp.open('dee', 'quiet', 'TikTok')->>'click_id' is not null,
  'when money arrives the program is live again and the links credit');
select set_config('request.jwt.claims', '', true);

select 'ok ' || count(*) || ' program link assertions' from link_assertions;
rollback;
