-- Provider-free test of sale tracking: payment receipts of a connected merchant account become
-- verified sales, one per PaymentIntent, tied to a creator click when possible; refunds and
-- disputes update the sale. The worker's Stripe reads are replaced by the inputs given here.
-- Programs, products, links, clicks, connections and analytics profiles are inserted directly.
begin;
set local time zone 'UTC';
create temporary table sales_assertions(label text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program sales assertion failed: %', label; end if;
  insert into sales_assertions values (label);
end $$;
create function pg_temp.fails(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- The time everything is counted from: five days ago. now() is fixed inside the transaction.
create function pg_temp.t(p_offset interval default '0') returns timestamptz language sql as $$
  select date_trunc('second', now()) - interval '5 days' + p_offset
$$;
create function pg_temp.epoch(p_at timestamptz) returns bigint language sql as $$
  select extract(epoch from p_at)::bigint
$$;
-- Stores a receipt the way the webhook does.
create function pg_temp.receipt(p_event text, p_type text, p_object text, p_intent text,
  p_at timestamptz default pg_temp.t(), p_account text default 'acct_SaleA',
  p_tag text default null, p_source text default null, p_amount bigint default 4900) returns jsonb language sql as $$
  select public.record_merchant_payment_event(jsonb_build_object(
    'platform_account_id', 'acct_KMAPlatform', 'livemode', true, 'account_id', p_account,
    'event_id', p_event, 'event_type', p_type, 'event_created', pg_temp.epoch(p_at),
    'object_id', p_object, 'payment_intent_id', p_intent, 'amount_minor', p_amount, 'currency', 'usd',
    'kma_click', p_tag, 'tag_source', p_source, 'payload_sha256', repeat('a', 64)))
$$;
-- The reference a worker holds for a receipt. Leases it first when nobody holds it, the way
-- a claim does.
create function pg_temp.ref(p_event text) returns jsonb language plpgsql security definer as $$
declare v_token uuid;
begin
  update public.merchant_payment_events
    set lease_until = clock_timestamp() + interval '2 minutes', lease_token = gen_random_uuid(),
      process_attempts = process_attempts + 1
    where event_id = p_event and processed_at is null and lease_token is null;
  select lease_token into v_token from public.merchant_payment_events where event_id = p_event;
  return jsonb_build_object('platform_account_id', 'acct_KMAPlatform', 'event_id', p_event,
    'lease_token', coalesce(v_token, '00000000-0000-4000-8000-000000000000'));
end $$;
-- What the worker sends after reading a payment from Stripe; each test overrides what it is about.
create function pg_temp.sale_input(p_event text, p_intent text, overrides jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.ref(p_event) || jsonb_build_object(
    'livemode', true, 'payment_intent_id', p_intent, 'charge_id', 'ch_' || substr(p_intent, 4),
    'amount_minor', 4900, 'currency', 'usd', 'refunded_minor', 0, 'paid_at', pg_temp.epoch(pg_temp.t())) || overrides
$$;
create function pg_temp.sale(p_event text, p_intent text, overrides jsonb default '{}') returns jsonb language sql as $$
  select public.record_program_sale(pg_temp.sale_input(p_event, p_intent, overrides))
$$;
create function pg_temp.sale_fails(p_event text, p_intent text, overrides jsonb) returns text language sql as $$
  select pg_temp.fails(format('select public.record_program_sale(%L)', pg_temp.sale_input(p_event, p_intent, overrides)))
$$;
create function pg_temp.done(p_event text, p_code text default 'recorded') returns jsonb language sql as $$
  select public.finish_program_sale_receipt(pg_temp.ref(p_event) || jsonb_build_object('action', 'done', 'code', p_code))
$$;
-- A receipt, its sale and its finish in one step; returns the answer of the sale call.
create function pg_temp.paid(p_event text, p_type text, p_object text, p_intent text, overrides jsonb default '{}',
  p_tag text default null, p_source text default null) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.receipt(p_event, p_type, p_object, case when p_type = 'invoice.paid' then null else p_intent end,
    pg_temp.t(), 'acct_SaleA', p_tag, p_source);
  v := pg_temp.sale(p_event, p_intent, overrides);
  perform pg_temp.done(p_event);
  return v;
end $$;
create function pg_temp.the_sale(p_intent text) returns public.program_sales language sql as $$
  select * from public.program_sales where payment_intent_id = p_intent
$$;
-- Volatile on purpose: read after a change made earlier in the same statement.
create function pg_temp.the_receipt(p_event text) returns public.merchant_payment_events language sql as $$
  select * from public.merchant_payment_events where event_id = p_event
$$;
create function pg_temp.adjust(p_event text, p_intent text, body jsonb) returns jsonb language sql as $$
  select public.record_program_sale_event(pg_temp.ref(p_event) || jsonb_build_object('payment_intent_id', p_intent) || body)
$$;
create function pg_temp.adjust_fails(p_event text, p_intent text, body jsonb) returns text language sql as $$
  select pg_temp.fails(format('select public.record_program_sale_event(%L)',
    pg_temp.ref(p_event) || jsonb_build_object('payment_intent_id', p_intent) || body))
$$;
create function pg_temp.refund_event(p_id text, p_amount bigint, p_state text default 'succeeded') returns jsonb language sql as $$
  select jsonb_build_object('kind', 'refund', 'stripe_object_id', p_id, 'state', p_state, 'amount_minor', p_amount,
    'currency', 'usd', 'occurred_at', pg_temp.epoch(pg_temp.t('1 day')))
$$;
create function pg_temp.dispute_event(p_id text, p_state text, p_amount bigint default 4900) returns jsonb language sql as $$
  select jsonb_build_object('kind', 'dispute', 'stripe_object_id', p_id, 'state', p_state, 'amount_minor', p_amount,
    'currency', 'usd', 'occurred_at', pg_temp.epoch(pg_temp.t('2 days')))
$$;
create function pg_temp.claim(p_limit integer default 10, p_platform text default 'acct_KMAPlatform') returns jsonb language sql as $$
  select public.claim_program_sale_receipts(jsonb_build_object('platform_account_id', p_platform, 'limit', p_limit, 'lease_seconds', 120))
$$;
create function pg_temp.tracking(p_workspace text) returns jsonb language sql as $$
  select public.workspace_program_tracking(p_workspace::uuid)
$$;
grant all on sales_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- Workspaces, connections and programs ---------------------------------------------------------
-- A: live program. B: connected, no program. C: connected, draft program. D: paused program.
-- E: live program whose connection is revoked later. F: never connected.
insert into auth.users(id, email, email_confirmed_at) values
  ('e8000000-0000-4000-8000-000000000001', 'owner@speaksix.example', now()),
  ('e8000000-0000-4000-8000-000000000002', 'analyst@speaksix.example', now()),
  ('e8000000-0000-4000-8000-000000000003', 'owner@elsewhere.example', now()),
  ('e8000000-0000-4000-8000-000000000004', 'stranger@nowhere.example', now());
insert into public.analytics_workspaces(id, name, created_by)
  select ('a8000000-0000-4000-8000-00000000000' || n)::uuid, 'Workspace ' || n, 'e8000000-0000-4000-8000-000000000001'
  from generate_series(1, 6) n;
insert into public.analytics_workspace_members(workspace_id, user_id, role) values
  ('a8000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000001', 'owner'),
  ('a8000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000002', 'analyst'),
  ('a8000000-0000-4000-8000-000000000002', 'e8000000-0000-4000-8000-000000000003', 'owner'),
  ('a8000000-0000-4000-8000-000000000006', 'e8000000-0000-4000-8000-000000000003', 'admin');
insert into public.merchant_businesses(id, business_name, email, created_by, workspace_id)
  select ('b8000000-0000-4000-8000-00000000000' || n)::uuid, 'Business ' || n, 'owner@speaksix.example',
    'e8000000-0000-4000-8000-000000000001', ('a8000000-0000-4000-8000-00000000000' || n)::uuid
  from generate_series(1, 5) n;
insert into public.merchant_connections(id, merchant_id, platform_account_id, livemode, account_id, status,
    charges_enabled, payouts_enabled, details_submitted, confirmed_at)
  select ('c8000000-0000-4000-8000-00000000000' || n)::uuid, ('b8000000-0000-4000-8000-00000000000' || n)::uuid,
    'acct_KMAPlatform', true, 'acct_Sale' || chr(64 + n), 'active', true, true, true, now()
  from generate_series(1, 5) n;

insert into public.platform_settings(singleton, tracking_base_url) values (true, 'https://tracking.example.invalid')
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url;
insert into public.products(id, slug, name, status)
  select ('28000000-0000-4000-8000-00000000000' || n)::uuid, 'sales-fixture-' || n, 'Sales fixture ' || n, 'active'
  from generate_series(1, 4) n;
insert into public.funnels(id, product_id, key, name, destination_url, status, is_default)
  select ('78000000-0000-4000-8000-00000000000' || n)::uuid, ('28000000-0000-4000-8000-00000000000' || n)::uuid,
    'main', 'Main', 'https://speaksix.example/start', 'live', true
  from generate_series(1, 4) n;
-- Product 1 is program A's, 3 is D's, 4 is E's; product 2 belongs to no program.
insert into public.affiliate_programs(id, workspace_id, product_id, funnel_id, slug, status, pause_reason, name, category,
    tagline, landing_url, commission_type, commission_rate_bps, commission_duration, attribution_window_days,
    live_terms_version, first_published_at, created_by) values
  ('d8000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001',
    '78000000-0000-4000-8000-000000000001', 'sales-a', 'live', null, 'SpeakSix', 'education', 'Speak in six weeks.',
    'https://speaksix.example/start', 'percent', 3000, 'lifetime', 60, 1, now() - interval '20 days', 'e8000000-0000-4000-8000-000000000001'),
  ('d8000000-0000-4000-8000-000000000003', 'a8000000-0000-4000-8000-000000000003', null, null, 'sales-c', 'draft', null,
    'Draft', null, null, null, null, null, null, 30, null, null, 'e8000000-0000-4000-8000-000000000001'),
  ('d8000000-0000-4000-8000-000000000004', 'a8000000-0000-4000-8000-000000000004', '28000000-0000-4000-8000-000000000003',
    '78000000-0000-4000-8000-000000000003', 'sales-d', 'paused', 'merchant', 'Paused', 'education', 'Paused for now.',
    'https://speaksix.example/start', 'percent', 3000, 'lifetime', 30, 1, now() - interval '20 days', 'e8000000-0000-4000-8000-000000000001'),
  ('d8000000-0000-4000-8000-000000000005', 'a8000000-0000-4000-8000-000000000005', '28000000-0000-4000-8000-000000000004',
    '78000000-0000-4000-8000-000000000004', 'sales-e', 'live', null, 'Gone', 'education', 'Disconnects later.',
    'https://speaksix.example/start', 'percent', 3000, 'lifetime', 30, 1, now() - interval '20 days', 'e8000000-0000-4000-8000-000000000001');
-- Creators agreed to 30 days. The 60 days on program A's working copy are an unpublished edit.
insert into public.affiliate_program_terms(program_id, version, terms, agreement, agreement_sha256, created_by) values
  ('d8000000-0000-4000-8000-000000000001', 1, '{"attribution_window_days":30}', '{}', repeat('a', 64), 'e8000000-0000-4000-8000-000000000001');

-- Creators, links and clicks --------------------------------------------------------------------
insert into public.affiliates(id, public_name, slug, status) values
  ('38000000-0000-4000-8000-000000000001', 'Creator one', 'sales-creator-one', 'active'),
  ('38000000-0000-4000-8000-000000000002', 'Creator two', 'sales-creator-two', 'active');
-- The readable short alias of a link is not part of this suite, and making one needs a UTF8
-- database; the disposable test cluster may not be one. Rolled back with everything else.
alter table public.affiliate_links disable trigger affiliate_links_allocate_alias;
insert into public.affiliate_links(id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url, sub1, status, tracking_environment) values
  ('48000000-0000-4000-8000-000000000001', '38000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', '78000000-0000-4000-8000-000000000001', 'One', 'sales_fixture_link_one', 'https://tracking.example.invalid/r/sales-creator-one/sales_fixture_link_one', null, 'paused', null),
  ('48000000-0000-4000-8000-000000000002', '38000000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000001', '78000000-0000-4000-8000-000000000001', 'Two', 'sales_fixture_link_two', 'https://tracking.example.invalid/r/sales-creator-two/sales_fixture_link_two', null, 'paused', 'live'),
  ('48000000-0000-4000-8000-000000000003', '38000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000002', '78000000-0000-4000-8000-000000000002', 'Other product', 'sales_fixture_link_other', 'https://tracking.example.invalid/r/sales-creator-one/sales_fixture_link_other', null, 'paused', null),
  ('48000000-0000-4000-8000-000000000004', '38000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', '78000000-0000-4000-8000-000000000001', 'Test link', 'sales_fixture_link_test', 'https://tracking.example.invalid/r/sales-creator-one/sales_fixture_link_test', null, 'paused', 'test');
alter table public.affiliate_links enable trigger affiliate_links_allocate_alias;
-- Click ids as register_tracking_click makes them: 48 lower-case hex characters.
insert into public.clicks(id, public_click_id, affiliate_link_id, affiliate_id, product_id, funnel_id, destination_url_snapshot, occurred_at, created_at, is_bot) values
  ('58000000-0000-4000-8000-000000000001', repeat('a1', 24), '48000000-0000-4000-8000-000000000001', '38000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', '78000000-0000-4000-8000-000000000001', 'https://speaksix.example/start', pg_temp.t('-1 day'), pg_temp.t('-1 day'), false),
  ('58000000-0000-4000-8000-000000000002', repeat('b2', 24), '48000000-0000-4000-8000-000000000002', '38000000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000001', '78000000-0000-4000-8000-000000000001', 'https://speaksix.example/start', pg_temp.t('-2 days'), pg_temp.t('-2 days'), false),
  ('58000000-0000-4000-8000-000000000003', repeat('c3', 24), '48000000-0000-4000-8000-000000000001', '38000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', '78000000-0000-4000-8000-000000000001', 'https://speaksix.example/start', pg_temp.t('-1 day'), pg_temp.t('-1 day'), true),
  ('58000000-0000-4000-8000-000000000004', repeat('d4', 24), '48000000-0000-4000-8000-000000000003', '38000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000002', '78000000-0000-4000-8000-000000000002', 'https://speaksix.example/start', pg_temp.t('-1 day'), pg_temp.t('-1 day'), false),
  ('58000000-0000-4000-8000-000000000005', repeat('e5', 24), '48000000-0000-4000-8000-000000000004', '38000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', '78000000-0000-4000-8000-000000000001', 'https://speaksix.example/start', pg_temp.t('-1 day'), pg_temp.t('-1 day'), false);

-- Identified profiles for email matching ---------------------------------------------------------
insert into public.analytics_projects(id, workspace_id, name) values
  ('f8000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000001', 'SpeakSix web'),
  ('f8000000-0000-4000-8000-000000000002', 'a8000000-0000-4000-8000-000000000002', 'Elsewhere web');
insert into public.analytics_people(id, project_id, distinct_id, traits, environment, first_seen, last_seen) values
  ('98000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001', 'user-1', '{"email":"Buyer@Example.com","name":"Jane Private"}', 'production', pg_temp.t('-60 days'), pg_temp.t()),
  ('98000000-0000-4000-8000-000000000002', 'f8000000-0000-4000-8000-000000000001', 'user-2', '{"email":"old@example.com"}', 'production', pg_temp.t('-60 days'), pg_temp.t()),
  ('98000000-0000-4000-8000-000000000003', 'f8000000-0000-4000-8000-000000000001', 'user-3', '{"email":"late@example.com"}', 'production', pg_temp.t('-60 days'), pg_temp.t()),
  ('98000000-0000-4000-8000-000000000004', 'f8000000-0000-4000-8000-000000000001', 'user-4', '{"email":"bot@example.com"}', 'production', pg_temp.t('-60 days'), pg_temp.t()),
  ('98000000-0000-4000-8000-000000000005', 'f8000000-0000-4000-8000-000000000001', 'user-5', '{"plan":"pro"}', 'production', pg_temp.t('-60 days'), pg_temp.t()),
  -- The same email identified in another workspace's project.
  ('98000000-0000-4000-8000-000000000006', 'f8000000-0000-4000-8000-000000000002', 'user-1', '{"email":"elsewhere@example.com"}', 'production', pg_temp.t('-60 days'), pg_temp.t());
insert into public.analytics_sessions(project_id, person_id, session_key, environment, started_at, ended_at, platform, creator_click) values
  -- Buyer: an old visit through creator two, a recent one through creator one, one with no click.
  ('f8000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', 's1', 'production', pg_temp.t('-10 days'), pg_temp.t('-10 days'), 'web', repeat('b2', 24)),
  ('f8000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', 's2', 'production', pg_temp.t('-3 days'), pg_temp.t('-3 days'), 'web', repeat('a1', 24)),
  ('f8000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', 's3', 'production', pg_temp.t('-1 hour'), pg_temp.t('-1 hour'), 'web', null),
  -- Old: 45 days before, outside the published 30 days but inside the unpublished 60.
  ('f8000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000002', 's4', 'production', pg_temp.t('-45 days'), pg_temp.t('-45 days'), 'web', repeat('a1', 24)),
  -- Late: the visit came after the payment.
  ('f8000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000003', 's5', 'production', pg_temp.t('1 hour'), pg_temp.t('1 hour'), 'web', repeat('a1', 24)),
  -- Bot: the most recent visit carries a bot click, the one before it a real click.
  ('f8000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000004', 's6', 'production', pg_temp.t('-2 days'), pg_temp.t('-2 days'), 'web', repeat('c3', 24)),
  ('f8000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000004', 's7', 'production', pg_temp.t('-4 days'), pg_temp.t('-4 days'), 'web', repeat('b2', 24)),
  ('f8000000-0000-4000-8000-000000000002', '98000000-0000-4000-8000-000000000006', 's8', 'production', pg_temp.t('-1 day'), pg_temp.t('-1 day'), 'web', repeat('a1', 24));

-- Closed by default ------------------------------------------------------------------------------
select pg_temp.check((select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.program_sales'::regclass, 'public.program_sale_events'::regclass))
  and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('program_sales', 'program_sale_events')),
  'sales and their events have row level security on and no policy');
select pg_temp.check((select bool_and(not has_table_privilege(r, t, p))
  from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['public.program_sales', 'public.program_sale_events', 'public.merchant_payment_events', 'kma_internal.program_sales_schedule']) t,
    unnest(array['select', 'insert', 'update', 'delete']) p),
  'no API role reads or writes sales, sale events, receipts or the schedule directly');
select pg_temp.check((select bool_and(has_function_privilege('service_role', f, 'execute')
    and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
  from unnest(array['public.claim_program_sale_receipts(jsonb)', 'public.record_program_sale(jsonb)',
    'public.record_program_sale_event(jsonb)', 'public.finish_program_sale_receipt(jsonb)', 'public.program_sales_health()']) f),
  'only the service role may call the worker functions');
select pg_temp.check(has_function_privilege('authenticated', 'public.workspace_program_tracking(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.workspace_program_tracking(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.workspace_program_tracking(uuid)', 'execute'),
  'only a signed-in user may call the tracking status');
select pg_temp.check((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))
  from pg_proc p where p.oid in ('public.claim_program_sale_receipts(jsonb)'::regprocedure,
    'public.record_program_sale(jsonb)'::regprocedure, 'public.record_program_sale_event(jsonb)'::regprocedure,
    'public.finish_program_sale_receipt(jsonb)'::regprocedure, 'public.program_sales_health()'::regprocedure,
    'public.workspace_program_tracking(uuid)'::regprocedure, 'kma_internal.tick_program_sales_schedule()'::regprocedure)),
  'every entry point is security definer with an empty search path and is not open to everyone');
select pg_temp.check((select bool_and(not has_function_privilege(r, p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'service_role']) r
  where n.nspname = 'kma_internal' and (p.proname like 'program\_sale%' or p.proname = 'tick_program_sales_schedule')),
  'no API role may call the internal helpers or the schedule tick');
set local role anon;
select pg_temp.check(pg_temp.fails('select public.claim_program_sale_receipts(''{}'')') like '42501%'
  and pg_temp.fails('select public.record_program_sale(''{}'')') like '42501%'
  and pg_temp.fails('select public.workspace_program_tracking(''a8000000-0000-4000-8000-000000000001'')') like '42501%'
  and pg_temp.fails('select count(*) from public.program_sales') like '42501%', 'a visitor reaches nothing');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e8000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select pg_temp.check(pg_temp.fails('select public.claim_program_sale_receipts(''{}'')') like '42501%'
  and pg_temp.fails('select public.record_program_sale(''{}'')') like '42501%'
  and pg_temp.fails('select public.record_program_sale_event(''{}'')') like '42501%'
  and pg_temp.fails('select public.finish_program_sale_receipt(''{}'')') like '42501%'
  and pg_temp.fails('select public.program_sales_health()') like '42501%'
  and pg_temp.fails('select kma_internal.tick_program_sales_schedule()') like '42501%'
  and pg_temp.fails('select count(*) from public.program_sales') like '42501%'
  and pg_temp.fails('select count(*) from public.program_sale_events') like '42501%',
  'a signed-in owner cannot run the worker functions or read sales from the browser');
reset role;
select set_config('request.jwt.claims', '', true);

-- Claiming ---------------------------------------------------------------------------------------
select pg_temp.receipt('evt_a_pi_1', 'payment_intent.succeeded', 'pi_a1', 'pi_a1', pg_temp.t('1 minute'));
select pg_temp.receipt('evt_a_pi_2', 'payment_intent.succeeded', 'pi_a2', 'pi_a2', pg_temp.t('2 minutes'));
select pg_temp.receipt('evt_a_old', 'payment_intent.succeeded', 'pi_a_old', 'pi_a_old', now() - interval '25 days');
select pg_temp.receipt('evt_b_pi_1', 'payment_intent.succeeded', 'pi_b1', 'pi_b1', pg_temp.t(), 'acct_SaleB');
select pg_temp.receipt('evt_c_pi_1', 'payment_intent.succeeded', 'pi_c1', 'pi_c1', pg_temp.t(), 'acct_SaleC');
select pg_temp.receipt('evt_d_pi_1', 'payment_intent.succeeded', 'pi_d1', 'pi_d1', pg_temp.t('3 minutes'), 'acct_SaleD');
select pg_temp.receipt('evt_e_pi_1', 'payment_intent.succeeded', 'pi_e1', 'pi_e1', pg_temp.t(), 'acct_SaleE');
select pg_temp.check((select count(*) = 7 and bool_and(processed_at is null and process_outcome is null and process_attempts = 0
    and process_error is null and next_attempt_at <= clock_timestamp() and lease_until is null and lease_token is null)
  from public.merchant_payment_events), 'a new receipt waits in the queue, due at once');
-- E disconnects after its payment was received.
update public.merchant_connections set status = 'revoked', revoked_at = now() where id = 'c8000000-0000-4000-8000-000000000005';

select pg_temp.check((select bool_and(pg_temp.fails(format('select public.claim_program_sale_receipts(%L)', x)) like '22023%') from unnest(array[
    '{}', '[]', '{"platform_account_id":"not-an-account"}', '{"platform_account_id":"acct_KMAPlatform","limit":0}',
    '{"platform_account_id":"acct_KMAPlatform","limit":26}', '{"platform_account_id":"acct_KMAPlatform","limit":"5"}',
    '{"platform_account_id":"acct_KMAPlatform","lease_seconds":10}', '{"platform_account_id":"acct_KMAPlatform","lease_seconds":601}'
  ]::jsonb[]) x) and pg_temp.fails('select public.claim_program_sale_receipts(null)') like '22023%', 'a malformed claim is refused');
select pg_temp.check(pg_temp.claim(10, 'acct_OtherPlatform') = '{"receipts":[],"skipped":0,"failed":0}'::jsonb,
  'another platform account claims nothing');

set local role service_role;
create temporary table first_claim as select pg_temp.claim(2) as answer;
reset role;
select pg_temp.check((select (answer->>'skipped')::int = 4 and jsonb_array_length(answer->'receipts') = 2
    and answer->'receipts'->0->>'event_id' = 'evt_a_pi_1' and answer->'receipts'->1->>'event_id' = 'evt_a_pi_2' from first_claim),
  'a claim takes the oldest receipts that can become sales, up to its limit, and finishes the ones that cannot');
select pg_temp.check((select answer->'receipts'->0 = jsonb_build_object('event_id', 'evt_a_pi_1', 'event_type', 'payment_intent.succeeded',
    'account_id', 'acct_SaleA', 'object_id', 'pi_a1', 'payment_intent_id', 'pi_a1', 'amount_minor', 4900, 'currency', 'USD',
    'event_created', pg_temp.epoch(pg_temp.t('1 minute')), 'attempts', 1,
    'lease_token', (select lease_token from public.merchant_payment_events where event_id = 'evt_a_pi_1')) from first_claim),
  'a claimed receipt carries its identifiers, amount, time, attempt number and lease token, and nothing else');
select pg_temp.check((select jsonb_object_agg(event_id, process_outcome) from public.merchant_payment_events where processed_at is not null)
  = '{"evt_a_old":"before_program","evt_b_pi_1":"no_program","evt_c_pi_1":"no_program","evt_e_pi_1":"connection_inactive"}'::jsonb,
  'no program, a draft program, an event older than the program and a disconnected account end without a Stripe call');
select pg_temp.check((select bool_and(lease_until > clock_timestamp() + interval '100 seconds' and lease_token is not null and process_attempts = 1)
  from public.merchant_payment_events where event_id in ('evt_a_pi_1', 'evt_a_pi_2')), 'claimed receipts are leased for the time asked');
select pg_temp.check(pg_temp.claim()->'receipts' @> '[{"event_id":"evt_d_pi_1","account_id":"acct_SaleD"}]',
  'a paused program still gets its sales');
select pg_temp.check(pg_temp.claim() = '{"receipts":[],"skipped":0,"failed":0}'::jsonb, 'a leased receipt is not handed out twice');

-- A lease that ran out is handed out again with a new token; the old token is dead.
create temporary table old_lease as select lease_token from public.merchant_payment_events where event_id = 'evt_a_pi_2';
update public.merchant_payment_events set lease_until = clock_timestamp() - interval '1 second' where event_id = 'evt_a_pi_2';
select pg_temp.check(pg_temp.claim()->'receipts' @> '[{"event_id":"evt_a_pi_2","attempts":2}]', 'an expired lease is claimed again as a second attempt');
select pg_temp.check((select e.lease_token <> o.lease_token from public.merchant_payment_events e, old_lease o where e.event_id = 'evt_a_pi_2')
  and pg_temp.fails(format('select public.finish_program_sale_receipt(%L)', jsonb_build_object('platform_account_id', 'acct_KMAPlatform',
    'event_id', 'evt_a_pi_2', 'lease_token', (select lease_token from old_lease), 'action', 'done', 'code', 'recorded'))) like '55000%'
  and pg_temp.fails(format('select public.record_program_sale(%L)', pg_temp.sale_input('evt_a_pi_2', 'pi_a2')
    || jsonb_build_object('lease_token', (select lease_token from old_lease)))) like '55000%',
  'the worker that lost the lease can neither record nor finish');
select pg_temp.check((select bool_and(pg_temp.fails(format('select public.record_program_sale(%L)', x)) like '22023%') from unnest(array[
    '{}', '{"platform_account_id":"acct_KMAPlatform","event_id":"evt_a_pi_1"}',
    '{"platform_account_id":"acct_KMAPlatform","event_id":"evt_a_pi_1","lease_token":"not-a-token"}'
  ]::jsonb[]) x)
  and pg_temp.fails('select public.record_program_sale(''{"platform_account_id":"acct_KMAPlatform","event_id":"evt_unknown","lease_token":"00000000-0000-4000-8000-000000000000"}'')') like '55000%',
  'a call without a held receipt is refused');

-- A one-off payment with a creator tag ---------------------------------------------------------
set local role service_role;
create temporary table first_sale as select pg_temp.sale('evt_a_pi_1', 'pi_a1', jsonb_build_object(
  'customer_id', 'cus_a1', 'tax_minor', 400, 'fee_minor', 172, 'fee_currency', 'usd',
  'kma_click', repeat('a1', 24), 'tag_source', 'metadata', 'buyer_email', 'someone@nowhere.example')) as answer;
reset role;
select pg_temp.check((select answer = jsonb_build_object('recorded', true, 'created', true, 'sale_id', (pg_temp.the_sale('pi_a1')).id,
    'status', 'paid', 'match_source', 'metadata', 'matched', true, 'fee_known', true) from first_sale),
  'a verified payment becomes a sale and the answer says how it was matched');
select pg_temp.check((select s.program_id = 'd8000000-0000-4000-8000-000000000001' and s.connection_id = 'c8000000-0000-4000-8000-000000000001'
    and s.account_id = 'acct_SaleA' and s.livemode and s.charge_id = 'ch_a1' and s.customer_id = 'cus_a1'
    and s.checkout_session_id is null and s.invoice_id is null and s.subscription_id is null and s.billing_reason is null
    and s.amount_minor = 4900 and s.currency = 'USD' and s.tax_minor = 400 and s.fee_minor = 172 and s.fee_currency = 'USD'
    and s.refunded_minor = 0 and s.status = 'paid' and s.paid_at = pg_temp.t()
    and s.click_id = repeat('a1', 24) and s.click_record_id = '58000000-0000-4000-8000-000000000001'
    and s.affiliate_id = '38000000-0000-4000-8000-000000000001' and s.match_source = 'metadata'
    and s.subscription_sequence is null and s.first_sale_id is null and s.verified_at is not null and s.created_at is not null
  from pg_temp.the_sale('pi_a1') s), 'the sale holds the Stripe identifiers, amounts, the click and its creator');
select pg_temp.check(pg_temp.sale('evt_a_pi_1', 'pi_a1', jsonb_build_object('kma_click', repeat('a1', 24), 'tag_source', 'metadata'))
    @> '{"recorded":true,"created":false,"match_source":"metadata"}'
  and (select count(*) = 1 from public.program_sales where payment_intent_id = 'pi_a1')
  and (select tax_minor = 400 and fee_minor = 172 and customer_id = 'cus_a1' from pg_temp.the_sale('pi_a1')),
  'recording the same payment again changes nothing and loses nothing');
select pg_temp.check(pg_temp.sale('evt_a_pi_1', 'pi_a1', '{"amount_minor":100}') = '{"recorded":false,"reason":"sale_conflict"}'::jsonb
  and pg_temp.sale('evt_a_pi_1', 'pi_a1', '{"currency":"eur"}') = '{"recorded":false,"reason":"sale_conflict"}'::jsonb
  and (select amount_minor = 4900 and currency = 'USD' from pg_temp.the_sale('pi_a1')),
  'a different amount or currency for a payment already recorded is refused');
select pg_temp.check((select bool_and(pg_temp.sale_fails('evt_a_pi_1', 'pi_a1', x) like '22023%') from unnest(array[
    '{"livemode":false}', '{"livemode":null}', '{"payment_intent_id":"ch_notanintent"}', '{"payment_intent_id":"pi_someoneelse"}',
    '{"charge_id":null}', '{"charge_id":"x"}', '{"checkout_session_id":"in_notasession"}', '{"invoice_id":"cs_notaninvoice"}',
    '{"subscription_id":"cus_notasubscription"}', '{"customer_id":"sub_notacustomer"}', '{"billing_reason":"Not A Reason"}',
    '{"amount_minor":0}', '{"amount_minor":-5}', '{"amount_minor":49.5}', '{"amount_minor":"4900"}', '{"amount_minor":null}',
    '{"currency":"dollars"}', '{"currency":null}', '{"tax_minor":-1}', '{"fee_minor":10}', '{"fee_currency":"usd"}',
    '{"fee_minor":10,"fee_currency":"dollars"}', '{"refunded_minor":"0"}', '{"paid_at":null}', '{"paid_at":0}',
    '{"paid_at":"2026-11-13T12:00:00Z"}', '{"kma_click":12345678901234567890,"tag_source":"metadata"}',
    '{"kma_click":"a1a1a1a1a1a1a1a1a1a1","tag_source":"customer_email"}', '{"kma_click":"a1a1a1a1a1a1a1a1a1a1"}',
    '{"buyer_email":42}'
  ]::jsonb[]) x)
  and pg_temp.sale_fails('evt_a_pi_1', 'pi_a1', jsonb_build_object('paid_at', pg_temp.epoch(now() + interval '1 day'))) like '22023%',
  'a malformed sale is refused');
select pg_temp.check(pg_temp.done('evt_a_pi_1') = '{"state":"done","outcome":"recorded"}'::jsonb, 'a receipt is finished with an outcome');
select pg_temp.check((select processed_at is not null and process_outcome = 'recorded' and lease_token is null and lease_until is null and process_error is null
    from public.merchant_payment_events where event_id = 'evt_a_pi_1'), 'finishing a receipt records its outcome and frees it');
select pg_temp.check(pg_temp.fails(format('select public.finish_program_sale_receipt(%L)', pg_temp.ref('evt_a_pi_1') || '{"action":"done","code":"recorded"}')) like '55000%'
  and pg_temp.sale_fails('evt_a_pi_1', 'pi_a1', '{}') like '55000%'
  and jsonb_array_length(pg_temp.claim()->'receipts') = 0, 'a finished receipt cannot be finished, used or claimed again');
-- A paused program records sales; a program that left 'live' and 'paused' does not.
select pg_temp.check(pg_temp.sale('evt_d_pi_1', 'pi_d1') @> '{"recorded":true,"created":true,"match_source":"none"}'
  and (select program_id = 'd8000000-0000-4000-8000-000000000004' and account_id = 'acct_SaleD' from pg_temp.the_sale('pi_d1')),
  'a sale of a paused program is recorded for that program');
select pg_temp.done('evt_d_pi_1');
select pg_temp.receipt('evt_d_pi_2', 'payment_intent.succeeded', 'pi_d2', 'pi_d2', pg_temp.t(), 'acct_SaleD');
select pg_temp.ref('evt_d_pi_2');
update public.affiliate_programs set status = 'archived', pause_reason = null where id = 'd8000000-0000-4000-8000-000000000004';
select pg_temp.check(pg_temp.sale('evt_d_pi_2', 'pi_d2') = '{"recorded":false,"reason":"no_program"}'::jsonb
  and pg_temp.the_sale('pi_d2') is null, 'a receipt claimed just before its program was archived records nothing');
select pg_temp.done('evt_d_pi_2', 'no_program');

-- The creator tag --------------------------------------------------------------------------------
select pg_temp.check(pg_temp.sale('evt_a_pi_2', 'pi_a2', jsonb_build_object('kma_click', 'kma_' || repeat('b2', 24), 'tag_source', 'client_reference_id'))
    @> '{"match_source":"client_reference_id","matched":true}'
  and (select click_id = repeat('b2', 24) and affiliate_id = '38000000-0000-4000-8000-000000000002'
    and click_record_id = '58000000-0000-4000-8000-000000000002' from pg_temp.the_sale('pi_a2')),
  'a tag from client_reference_id loses its kma_ prefix and matches the click of a live link');
select pg_temp.done('evt_a_pi_2');
-- The worker read no tag, but the signed event carried one.
select pg_temp.check(pg_temp.paid('evt_a_cs_3', 'checkout.session.completed', 'cs_a3', 'pi_a3', '{"checkout_session_id":"cs_a3"}',
    'kma_' || repeat('a1', 24), 'client_reference_id') @> '{"match_source":"client_reference_id","matched":true}'
  and (select click_id = repeat('a1', 24) and checkout_session_id = 'cs_a3' from pg_temp.the_sale('pi_a3')),
  'the tag stored with the receipt is used when Stripe no longer shows one');
select pg_temp.check(pg_temp.paid('evt_a_pi_4', 'payment_intent.succeeded', 'pi_a4', 'pi_a4',
    jsonb_build_object('kma_click', repeat('f6', 24), 'tag_source', 'metadata')) @> '{"match_source":"metadata","matched":false}'
  and (select click_id = repeat('f6', 24) and click_record_id is null and affiliate_id is null from pg_temp.the_sale('pi_a4')),
  'a tag that names no click is kept on the sale, unmatched');
select pg_temp.check((select bool_and((pg_temp.paid('evt_a_pi_5' || n, 'payment_intent.succeeded', 'pi_a5' || n, 'pi_a5' || n,
    jsonb_build_object('kma_click', tag, 'tag_source', 'metadata')) @> '{"matched":false}')
    and (pg_temp.the_sale('pi_a5' || n)).click_record_id is null)
  from unnest(array[repeat('c3', 24), repeat('d4', 24), repeat('e5', 24)]) with ordinality as x(tag, n)),
  'a bot click, a click on another product and a click of a test link are not matched');
select pg_temp.check((select bool_and((pg_temp.paid('evt_a_pi_6' || n, 'payment_intent.succeeded', 'pi_a6' || n, 'pi_a6' || n,
    jsonb_build_object('kma_click', tag, 'tag_source', source)) @> '{"match_source":"none","matched":false}')
    and (pg_temp.the_sale('pi_a6' || n)).click_id is null)
  from (values ('short', 'metadata', 1), ('has space ' || repeat('a1', 24), 'metadata', 2), (repeat('x', 129), 'metadata', 3),
    ('kma_short', 'client_reference_id', 4), (null, null, 5)) as x(tag, source, n)),
  'a tag that is not a click id, or no tag at all, leaves the sale without a click');
-- A metadata tag keeps its text: only client_reference_id carries the kma_ prefix.
select pg_temp.check(pg_temp.paid('evt_a_pi_7', 'payment_intent.succeeded', 'pi_a7', 'pi_a7',
    jsonb_build_object('kma_click', 'kma_' || repeat('a1', 24), 'tag_source', 'metadata')) @> '{"match_source":"metadata","matched":false}'
  and (select click_id = 'kma_' || repeat('a1', 24) from pg_temp.the_sale('pi_a7')), 'a metadata tag is taken as written');

-- Email matching --------------------------------------------------------------------------------
select pg_temp.check(pg_temp.paid('evt_a_pi_m1', 'payment_intent.succeeded', 'pi_m1', 'pi_m1', '{"buyer_email":"  BUYER@example.COM "}')
    @> '{"match_source":"email","matched":true}'
  and (select click_id = repeat('a1', 24) and click_record_id = '58000000-0000-4000-8000-000000000001'
    and affiliate_id = '38000000-0000-4000-8000-000000000001' from pg_temp.the_sale('pi_m1')),
  'with no tag, the buyer''s most recent visit with a creator click inside the window decides');
select pg_temp.check(pg_temp.paid('evt_a_pi_m2', 'payment_intent.succeeded', 'pi_m2', 'pi_m2', '{"buyer_email":"old@example.com"}')
    @> '{"match_source":"none","matched":false}', 'a visit older than the published attribution window does not count');
select pg_temp.check(pg_temp.paid('evt_a_pi_m3', 'payment_intent.succeeded', 'pi_m3', 'pi_m3', '{"buyer_email":"late@example.com"}')
    @> '{"match_source":"none"}', 'nor does a visit after the payment');
select pg_temp.check(pg_temp.paid('evt_a_pi_m4', 'payment_intent.succeeded', 'pi_m4', 'pi_m4', '{"buyer_email":"bot@example.com"}')
    @> '{"match_source":"email","matched":true}'
  and (select click_id = repeat('b2', 24) and affiliate_id = '38000000-0000-4000-8000-000000000002' from pg_temp.the_sale('pi_m4')),
  'a visit whose click is a bot is passed over for the one before it');
select pg_temp.check(pg_temp.paid('evt_a_pi_m5', 'payment_intent.succeeded', 'pi_m5', 'pi_m5', '{"buyer_email":"elsewhere@example.com"}')
    @> '{"match_source":"none"}'
  and pg_temp.paid('evt_a_pi_m6', 'payment_intent.succeeded', 'pi_m6', 'pi_m6', '{"buyer_email":"nobody@example.com"}') @> '{"match_source":"none"}'
  and pg_temp.paid('evt_a_pi_m7', 'payment_intent.succeeded', 'pi_m7', 'pi_m7', '{"buyer_email":"not an email"}') @> '{"match_source":"none"}'
  and pg_temp.paid('evt_a_pi_m8', 'payment_intent.succeeded', 'pi_m8', 'pi_m8', '{"buyer_email":null}') @> '{"match_source":"none"}',
  'a profile of another workspace, an unknown email, a malformed one or none match nothing');
-- The tag wins over email, whichever arrives first; a matched tag is never replaced.
select pg_temp.check(pg_temp.paid('evt_a_pi_m9', 'payment_intent.succeeded', 'pi_m9', 'pi_m9', jsonb_build_object(
    'buyer_email', 'buyer@example.com', 'kma_click', repeat('b2', 24), 'tag_source', 'metadata')) @> '{"match_source":"metadata"}'
  and (select affiliate_id = '38000000-0000-4000-8000-000000000002' from pg_temp.the_sale('pi_m9')), 'a creator tag wins over email');
select pg_temp.check(pg_temp.paid('evt_a_cs_m1', 'checkout.session.completed', 'cs_m1', 'pi_m1', jsonb_build_object(
    'checkout_session_id', 'cs_m1', 'kma_click', 'kma_' || repeat('b2', 24), 'tag_source', 'client_reference_id')) @> '{"created":false,"match_source":"client_reference_id"}'
  and (select click_id = repeat('b2', 24) and affiliate_id = '38000000-0000-4000-8000-000000000002' and checkout_session_id = 'cs_m1'
    from pg_temp.the_sale('pi_m1')), 'a tag that arrives with a later receipt replaces an email match');
select pg_temp.check(pg_temp.paid('evt_a_cs_m9', 'checkout.session.completed', 'cs_m9', 'pi_m9', jsonb_build_object(
    'checkout_session_id', 'cs_m9', 'kma_click', 'kma_' || repeat('a1', 24), 'tag_source', 'client_reference_id', 'buyer_email', 'buyer@example.com'))
    @> '{"match_source":"metadata"}'
  and (select click_id = repeat('b2', 24) from pg_temp.the_sale('pi_m9')), 'a matched tag is not replaced by a second tag or by email');
select pg_temp.check(pg_temp.paid('evt_a_cs_4', 'checkout.session.completed', 'cs_a4', 'pi_a4', '{"checkout_session_id":"cs_a4","buyer_email":"buyer@example.com"}')
    @> '{"match_source":"email","matched":true}'
  and (select click_id = repeat('a1', 24) from pg_temp.the_sale('pi_a4')), 'an unknown tag gives way to an email match');
select pg_temp.check(not exists (select 1 from public.program_sales s where to_jsonb(s)::text ~* 'example\.com|buyer|jane')
  and not exists (select 1 from public.merchant_payment_events e where to_jsonb(e)::text ~* 'example\.com|buyer@|jane'),
  'the buyer''s email and name are stored nowhere');

-- One subscription checkout, three receipts, one sale -----------------------------------------
-- The PaymentIntent arrives first and knows nothing; the invoice adds the subscription; the
-- Checkout Session adds the creator tag.
select pg_temp.check(pg_temp.paid('evt_s1_pi', 'payment_intent.succeeded', 'pi_s1', 'pi_s1', '{"customer_id":"cus_s1"}')
    @> '{"created":true,"match_source":"none","fee_known":false}', 'the PaymentIntent of a subscription checkout opens the sale');
select pg_temp.check(pg_temp.paid('evt_s1_in', 'invoice.paid', 'in_s1', 'pi_s1', '{"invoice_id":"in_s1","subscription_id":"sub_s1","billing_reason":"subscription_create","tax_minor":300,"fee_minor":172,"fee_currency":"usd"}')
    @> '{"created":false,"match_source":"none","fee_known":true}', 'its invoice adds to the same sale');
select pg_temp.check(pg_temp.paid('evt_s1_cs', 'checkout.session.completed', 'cs_s1', 'pi_s1', jsonb_build_object(
    'checkout_session_id', 'cs_s1', 'subscription_id', 'sub_s1', 'kma_click', 'kma_' || repeat('a1', 24), 'tag_source', 'client_reference_id'))
    @> '{"created":false,"match_source":"client_reference_id","matched":true}', 'and so does its Checkout Session');
select pg_temp.check((select count(*) = 1 from public.program_sales where payment_intent_id = 'pi_s1' or subscription_id = 'sub_s1')
  and (select s.checkout_session_id = 'cs_s1' and s.invoice_id = 'in_s1' and s.subscription_id = 'sub_s1' and s.customer_id = 'cus_s1'
    and s.billing_reason = 'subscription_create' and s.tax_minor = 300 and s.fee_minor = 172 and s.subscription_sequence = 1
    and s.first_sale_id is null and s.match_source = 'client_reference_id' and s.click_id = repeat('a1', 24)
    and s.affiliate_id = '38000000-0000-4000-8000-000000000001' from pg_temp.the_sale('pi_s1') s),
  'the three receipts of one subscription checkout are one sale with everything each of them knew');
-- The same three in the opposite order end in the same row.
select pg_temp.paid('evt_s2_cs', 'checkout.session.completed', 'cs_s2', 'pi_s2', jsonb_build_object(
  'checkout_session_id', 'cs_s2', 'subscription_id', 'sub_s2', 'kma_click', 'kma_' || repeat('a1', 24), 'tag_source', 'client_reference_id'));
select pg_temp.paid('evt_s2_in', 'invoice.paid', 'in_s2', 'pi_s2', '{"invoice_id":"in_s2","subscription_id":"sub_s2","billing_reason":"subscription_create","tax_minor":300,"fee_minor":172,"fee_currency":"usd"}');
select pg_temp.paid('evt_s2_pi', 'payment_intent.succeeded', 'pi_s2', 'pi_s2', '{"customer_id":"cus_s2"}');
select pg_temp.check((select count(*) = 1 from public.program_sales where payment_intent_id = 'pi_s2')
  and (select replace((to_jsonb(a) - '{id,payment_intent_id,charge_id,verified_at,created_at}'::text[])::text, 's1', 's2')::jsonb
      = to_jsonb(b) - '{id,payment_intent_id,charge_id,verified_at,created_at}'::text[]
    from pg_temp.the_sale('pi_s1') a, pg_temp.the_sale('pi_s2') b), 'in any order the receipts converge on the same sale');

-- Renewals -------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.paid('evt_s1_r1_pi', 'payment_intent.succeeded', 'pi_s1r1', 'pi_s1r1',
    jsonb_build_object('paid_at', pg_temp.epoch(pg_temp.t('1 day')), 'buyer_email', 'bot@example.com')) @> '{"match_source":"email"}',
  'a renewal whose PaymentIntent arrives first looks like a one-off payment');
select pg_temp.check(pg_temp.paid('evt_s1_r1_in', 'invoice.paid', 'in_s1r1', 'pi_s1r1', jsonb_build_object(
    'paid_at', pg_temp.epoch(pg_temp.t('1 day')), 'invoice_id', 'in_s1r1', 'subscription_id', 'sub_s1',
    'billing_reason', 'subscription_cycle', 'buyer_email', 'bot@example.com')) @> '{"created":false,"match_source":"subscription","matched":true}'
  and (select s.subscription_sequence = 2 and s.first_sale_id = (pg_temp.the_sale('pi_s1')).id and s.click_id = repeat('a1', 24)
    and s.click_record_id = '58000000-0000-4000-8000-000000000001' and s.affiliate_id = '38000000-0000-4000-8000-000000000001'
    from pg_temp.the_sale('pi_s1r1') s),
  'once its invoice says it is a renewal, the email match is dropped and it takes the click and creator of the first sale');
select pg_temp.check(pg_temp.paid('evt_s1_r2_in', 'invoice.paid', 'in_s1r2', 'pi_s1r2', jsonb_build_object(
    'paid_at', pg_temp.epoch(pg_temp.t('2 days')), 'invoice_id', 'in_s1r2', 'subscription_id', 'sub_s1', 'billing_reason', 'subscription_cycle',
    'kma_click', repeat('b2', 24), 'tag_source', 'metadata')) @> '{"match_source":"metadata"}'
  and (select subscription_sequence = 3 and first_sale_id = (pg_temp.the_sale('pi_s1')).id and affiliate_id = '38000000-0000-4000-8000-000000000002'
    from pg_temp.the_sale('pi_s1r2')), 'a renewal that carries its own creator tag keeps it');
-- A subscription whose renewal is recorded before its first payment, and whose first payment
-- gets its tag last.
select pg_temp.paid('evt_s3_r1_in', 'invoice.paid', 'in_s3r1', 'pi_s3r1', jsonb_build_object(
  'paid_at', pg_temp.epoch(pg_temp.t('3 days')), 'invoice_id', 'in_s3r1', 'subscription_id', 'sub_s3', 'billing_reason', 'subscription_cycle',
  'buyer_email', 'buyer@example.com'));
select pg_temp.check((select subscription_sequence = 1 and first_sale_id is null and match_source = 'none' from pg_temp.the_sale('pi_s3r1')),
  'a renewal seen before its first payment stands alone for now, and is not matched by email');
select pg_temp.paid('evt_s3_in', 'invoice.paid', 'in_s3', 'pi_s3', '{"invoice_id":"in_s3","subscription_id":"sub_s3","billing_reason":"subscription_create"}');
select pg_temp.check((select subscription_sequence = 1 and first_sale_id is null from pg_temp.the_sale('pi_s3'))
  and (select subscription_sequence = 2 and first_sale_id = (pg_temp.the_sale('pi_s3')).id and match_source = 'none' from pg_temp.the_sale('pi_s3r1')),
  'when the earlier payment is recorded the sales of the subscription are renumbered by payment time');
select pg_temp.paid('evt_s3_cs', 'checkout.session.completed', 'cs_s3', 'pi_s3', jsonb_build_object(
  'checkout_session_id', 'cs_s3', 'kma_click', 'kma_' || repeat('b2', 24), 'tag_source', 'client_reference_id'));
select pg_temp.check((select match_source = 'client_reference_id' from pg_temp.the_sale('pi_s3'))
  and (select match_source = 'subscription' and click_id = repeat('b2', 24) and affiliate_id = '38000000-0000-4000-8000-000000000002'
    from pg_temp.the_sale('pi_s3r1')), 'a renewal already recorded follows when the first sale is matched later');
-- The first payment of a subscription may be matched by email, and its renewals inherit it.
select pg_temp.paid('evt_s4_in', 'invoice.paid', 'in_s4', 'pi_s4', '{"invoice_id":"in_s4","subscription_id":"sub_s4","billing_reason":"subscription_create","buyer_email":"buyer@example.com"}');
select pg_temp.paid('evt_s4_r1_in', 'invoice.paid', 'in_s4r1', 'pi_s4r1', jsonb_build_object(
  'paid_at', pg_temp.epoch(pg_temp.t('1 day')), 'invoice_id', 'in_s4r1', 'subscription_id', 'sub_s4', 'billing_reason', 'subscription_cycle'));
select pg_temp.check((select match_source = 'email' and click_id = repeat('a1', 24) from pg_temp.the_sale('pi_s4'))
  and (select match_source = 'subscription' and click_id = repeat('a1', 24) and subscription_sequence = 2 from pg_temp.the_sale('pi_s4r1')),
  'a first subscription payment matched by email passes its creator on to renewals');
select pg_temp.check(not exists (select 1 from public.program_sales s where s.subscription_id is not null
    and (s.subscription_sequence = 1) <> (s.first_sale_id is null))
  and (select count(*) = count(distinct (subscription_id, subscription_sequence)) from public.program_sales where subscription_id is not null),
  'every subscription has one first sale and a distinct number for each sale');

-- The fee arrives later ----------------------------------------------------------------------------
select pg_temp.receipt('evt_f1_pi', 'payment_intent.succeeded', 'pi_f1', 'pi_f1');
select pg_temp.check(pg_temp.sale('evt_f1_pi', 'pi_f1') @> '{"created":true,"fee_known":false}'
  and (select fee_minor is null and fee_currency is null from pg_temp.the_sale('pi_f1')), 'a sale can be recorded before Stripe has settled its fee');
select pg_temp.check(pg_temp.sale('evt_f1_pi', 'pi_f1', '{"fee_minor":201,"fee_currency":"eur"}') @> '{"created":false,"fee_known":true}'
  and (select fee_minor = 201 and fee_currency = 'EUR' from pg_temp.the_sale('pi_f1')), 'a later read fills the fee, in its own currency');
select pg_temp.check(pg_temp.sale('evt_f1_pi', 'pi_f1') @> '{"fee_known":true}'
  and (select fee_minor = 201 and fee_currency = 'EUR' from pg_temp.the_sale('pi_f1')), 'and a read without a fee does not erase it');
select pg_temp.done('evt_f1_pi');

-- Refunds ----------------------------------------------------------------------------------------
select pg_temp.receipt('evt_a1_re_1', 'refund.created', 're_a1_1', 'pi_a1', pg_temp.t('1 day'), 'acct_SaleA', null, null, 1000);
select pg_temp.check(pg_temp.adjust('evt_a1_re_1', 'pi_a1', jsonb_build_object('refunded_minor', 1000, 'events', jsonb_build_array(pg_temp.refund_event('re_a1_1', 1000))))
    = jsonb_build_object('recorded', true, 'sale_id', (pg_temp.the_sale('pi_a1')).id, 'status', 'partially_refunded', 'refunded_minor', 1000, 'new_events', 1)
  and (select status = 'partially_refunded' and refunded_minor = 1000 from pg_temp.the_sale('pi_a1')), 'a partial refund marks the sale partially refunded');
select pg_temp.check(pg_temp.adjust('evt_a1_re_1', 'pi_a1', jsonb_build_object('refunded_minor', 1000, 'events', jsonb_build_array(pg_temp.refund_event('re_a1_1', 1000))))
    @> '{"recorded":true,"status":"partially_refunded","refunded_minor":1000,"new_events":0}'
  and (select count(*) = 1 from public.program_sale_events where stripe_object_id = 're_a1_1'), 'the same refund again changes nothing');
select pg_temp.done('evt_a1_re_1');
select pg_temp.check((select e.sale_id = (pg_temp.the_sale('pi_a1')).id and e.kind = 'refund' and e.state = 'succeeded' and e.amount_minor = 1000
    and e.currency = 'USD' and e.occurred_at = pg_temp.t('1 day') and e.recorded_at is not null
  from public.program_sale_events e where e.stripe_object_id = 're_a1_1'), 'the refund is kept with its amount and Stripe time');
-- charge.refunded carries only the charge's new total.
select pg_temp.receipt('evt_a1_ch_1', 'charge.refunded', 'ch_a1', 'pi_a1', pg_temp.t('2 days'), 'acct_SaleA', null, null, 4900);
select pg_temp.check(pg_temp.adjust('evt_a1_ch_1', 'pi_a1', '{"refunded_minor":4900}') @> '{"recorded":true,"status":"refunded","refunded_minor":4900,"new_events":0}'
  and (select status = 'refunded' and refunded_minor = 4900 from pg_temp.the_sale('pi_a1')), 'a refund of the rest marks the sale refunded');
select pg_temp.done('evt_a1_ch_1');
-- The second refund fails at the bank later: Stripe lowers the charge's refunded total again.
select pg_temp.receipt('evt_a1_re_2', 'refund.updated', 're_a1_2', 'pi_a1', pg_temp.t('3 days'), 'acct_SaleA', null, null, 3900);
select pg_temp.check(pg_temp.adjust('evt_a1_re_2', 'pi_a1', jsonb_build_object('refunded_minor', 1000, 'events', jsonb_build_array(pg_temp.refund_event('re_a1_2', 3900, 'failed'))))
    @> '{"status":"partially_refunded","refunded_minor":1000,"new_events":1}', 'a refund that failed afterwards lowers the refunded total again');
select pg_temp.done('evt_a1_re_2');
-- A payment receipt processed again later reads the same total from the charge.
select pg_temp.receipt('evt_a1_cs', 'checkout.session.completed', 'cs_a1', 'pi_a1');
select pg_temp.check(pg_temp.sale('evt_a1_cs', 'pi_a1', '{"checkout_session_id":"cs_a1","refunded_minor":1000}') @> '{"created":false,"status":"partially_refunded"}'
  and (select refunded_minor = 1000 and checkout_session_id = 'cs_a1' and match_source = 'metadata' from pg_temp.the_sale('pi_a1')),
  'a payment receipt processed after a refund keeps the refunded sale as it is');
select pg_temp.done('evt_a1_cs');
select pg_temp.receipt('evt_a1_re_x', 'refund.created', 're_a1_x', 'pi_a1');
select pg_temp.check((select bool_and(pg_temp.adjust_fails('evt_a1_re_x', 'pi_a1', x) like '22023%') from unnest(array[
    '{"events":{}}', '{"events":[42]}', '{"refunded_minor":-1}', '{"refunded_minor":"1000"}',
    '{"events":[{"kind":"dispute","stripe_object_id":"dp_1","state":"open","amount_minor":1,"currency":"usd","occurred_at":1700000000}]}',
    '{"events":[{"kind":"refund","stripe_object_id":"re 1","state":"succeeded","amount_minor":1,"currency":"usd","occurred_at":1700000000}]}',
    '{"events":[{"kind":"refund","stripe_object_id":"re_1","state":"pending","amount_minor":1,"currency":"usd","occurred_at":1700000000}]}',
    '{"events":[{"kind":"refund","stripe_object_id":"re_1","state":"succeeded","amount_minor":-1,"currency":"usd","occurred_at":1700000000}]}',
    '{"events":[{"kind":"refund","stripe_object_id":"re_1","state":"succeeded","amount_minor":1,"currency":"dollars","occurred_at":1700000000}]}',
    '{"events":[{"kind":"refund","stripe_object_id":"re_1","state":"succeeded","amount_minor":1,"currency":"usd","occurred_at":0}]}',
    '{"events":[{"kind":"refund","stripe_object_id":"re_1","state":"succeeded","amount_minor":1,"currency":"usd"}]}'
  ]::jsonb[]) x)
  and pg_temp.adjust_fails('evt_a1_re_x', 'pi_a2', '{}') like '22023%'
  and pg_temp.adjust_fails('evt_a1_re_x', 'ch_a1', '{}') like '22023%'
  and pg_temp.adjust_fails('evt_a1_re_x', 'pi_a1', jsonb_build_object('events', (select jsonb_agg(pg_temp.refund_event('re_many_' || n, 1)) from generate_series(1, 21) n))) like '22023%'
  and pg_temp.fails(format('select public.record_program_sale(%L)', pg_temp.sale_input('evt_a1_re_x', 'pi_a1'))) like '22023%'
  and pg_temp.adjust_fails('evt_f1_pi', 'pi_f1', '{}') like '55000%',
  'a malformed refund, one for another payment, a refund receipt used as a sale or a finished receipt is refused');
select pg_temp.done('evt_a1_re_x', 'refund_pending');
-- A refund whose payment is not a sale: still waiting to be processed, or never one.
select pg_temp.receipt('evt_w1_pi', 'payment_intent.succeeded', 'pi_w1', 'pi_w1');
select pg_temp.receipt('evt_w1_re', 'refund.created', 're_w1', 'pi_w1', pg_temp.t('1 day'), 'acct_SaleA', null, null, 4900);
select pg_temp.check(pg_temp.adjust_fails('evt_w1_pi', 'pi_w1', '{}') like '22023%', 'a payment receipt cannot be used as a refund');
select pg_temp.check(pg_temp.adjust('evt_w1_re', 'pi_w1', jsonb_build_object('refunded_minor', 4900, 'events', jsonb_build_array(pg_temp.refund_event('re_w1', 4900))))
    = '{"recorded":false,"reason":"sale_pending"}'::jsonb, 'a refund that overtakes its payment waits for it');
select pg_temp.sale('evt_w1_pi', 'pi_w1');
select pg_temp.done('evt_w1_pi');
select pg_temp.check(pg_temp.adjust('evt_w1_re', 'pi_w1', jsonb_build_object('refunded_minor', 4900, 'events', jsonb_build_array(pg_temp.refund_event('re_w1', 4900))))
    @> '{"recorded":true,"status":"refunded","new_events":1}', 'and is recorded once the payment is a sale');
select pg_temp.done('evt_w1_re');
select pg_temp.receipt('evt_n1_re', 'refund.created', 're_n1', 'pi_never', pg_temp.t('1 day'), 'acct_SaleA', null, null, 4900);
select pg_temp.check(pg_temp.adjust('evt_n1_re', 'pi_never', jsonb_build_object('refunded_minor', 4900, 'events', jsonb_build_array(pg_temp.refund_event('re_n1', 4900))))
    = '{"recorded":false,"reason":"no_sale"}'::jsonb
  and not exists (select 1 from public.program_sale_events where stripe_object_id = 're_n1'),
  'a refund of a payment that never became a sale records nothing');
select pg_temp.done('evt_n1_re', 'no_sale');

-- Disputes ---------------------------------------------------------------------------------------
select pg_temp.receipt('evt_a2_dp_1', 'charge.dispute.created', 'dp_a2', 'pi_a2', pg_temp.t('2 days'));
select pg_temp.check(pg_temp.adjust('evt_a2_dp_1', 'pi_a2', jsonb_build_object('events', jsonb_build_array(pg_temp.dispute_event('dp_a2', 'open'))))
    @> '{"recorded":true,"status":"disputed","new_events":1,"refunded_minor":0}'
  and (select status = 'disputed' and refunded_minor = 0 from pg_temp.the_sale('pi_a2')), 'an opened dispute marks the sale disputed');
select pg_temp.check(pg_temp.adjust('evt_a2_dp_1', 'pi_a2', jsonb_build_object('events', jsonb_build_array(pg_temp.dispute_event('dp_a2', 'open'))))
    @> '{"status":"disputed","new_events":0}', 'the same dispute again changes nothing');
select pg_temp.check(pg_temp.adjust_fails('evt_a2_dp_1', 'pi_a2', '{"refunded_minor":100}') like '22023%'
  and pg_temp.adjust_fails('evt_a2_dp_1', 'pi_a2', jsonb_build_object('events', jsonb_build_array(pg_temp.refund_event('re_x', 1)))) like '22023%'
  and pg_temp.adjust_fails('evt_a2_dp_1', 'pi_a2', jsonb_build_object('events', jsonb_build_array(pg_temp.dispute_event('dp_a2', 'succeeded')))) like '22023%',
  'a dispute receipt cannot carry a refund');
select pg_temp.done('evt_a2_dp_1');
select pg_temp.receipt('evt_a2_dp_2', 'charge.dispute.closed', 'dp_a2', 'pi_a2', pg_temp.t('3 days'));
select pg_temp.check(pg_temp.adjust('evt_a2_dp_2', 'pi_a2', jsonb_build_object('events', jsonb_build_array(pg_temp.dispute_event('dp_a2', 'won'))))
    @> '{"status":"paid","new_events":1}' and (select status = 'paid' from pg_temp.the_sale('pi_a2')), 'a dispute won gives the sale its status back');
select pg_temp.done('evt_a2_dp_2');
select pg_temp.receipt('evt_a2_dp_3', 'charge.dispute.closed', 'dp_a2_b', 'pi_a2', pg_temp.t('4 days'));
select pg_temp.check(pg_temp.adjust('evt_a2_dp_3', 'pi_a2', jsonb_build_object('events', jsonb_build_array(pg_temp.dispute_event('dp_a2_b', 'lost'))))
    @> '{"status":"disputed","new_events":1}', 'a dispute lost leaves the sale disputed, even when its opening was never seen');
select pg_temp.done('evt_a2_dp_3');
-- A refund on a disputed sale is counted but the sale stays disputed.
select pg_temp.receipt('evt_a2_ch', 'charge.refunded', 'ch_a2', 'pi_a2', pg_temp.t('4 days'));
select pg_temp.check(pg_temp.adjust('evt_a2_ch', 'pi_a2', '{"refunded_minor":4900}') @> '{"status":"disputed","refunded_minor":4900}', 'a disputed sale stays disputed when refunded');
select pg_temp.done('evt_a2_ch');
select pg_temp.check((select count(*) = 3 from public.program_sale_events e where e.sale_id = (pg_temp.the_sale('pi_a2')).id and e.kind = 'dispute')
  and pg_temp.fails('update public.program_sale_events set amount_minor = 1') like 'P0001%'
  and pg_temp.fails('delete from public.program_sale_events') like 'P0001%'
  and pg_temp.fails('insert into public.program_sale_events(sale_id, kind, stripe_object_id, state, amount_minor, currency, occurred_at)
    select id, ''refund'', ''re_bad'', ''won'', 1, ''USD'', now() from public.program_sales limit 1') like '23514%',
  'refund and dispute rows are append-only and keep their kind''s states');

-- Finishing, retrying and giving up ------------------------------------------------------------
select pg_temp.receipt('evt_r1_pi', 'payment_intent.succeeded', 'pi_r1', 'pi_r1');
select pg_temp.check((select bool_and(pg_temp.fails(format('select public.finish_program_sale_receipt(%L)', pg_temp.ref('evt_r1_pi') || x)) like '22023%') from unnest(array[
    '{}', '{"action":"done"}', '{"action":"finish","code":"recorded"}', '{"action":"done","code":"Stripe said: card declined for jane@example.com"}',
    '{"action":"done","code":"failed"}', '{"action":"done","code":"recorded","delay_seconds":60}',
    '{"action":"retry","code":"stripe_unavailable","delay_seconds":1}', '{"action":"retry","code":"stripe_unavailable","delay_seconds":"60"}',
    '{"action":"retry","code":"stripe_unavailable","delay_seconds":99999}'
  ]::jsonb[]) x), 'an outcome is a known action with a short code, never a message');
select pg_temp.check(public.finish_program_sale_receipt(pg_temp.ref('evt_r1_pi') || '{"action":"retry","code":"stripe_unavailable"}') @> '{"state":"retry"}',
  'a receipt that could not be processed is scheduled again');
select pg_temp.check((select processed_at is null and process_error = 'stripe_unavailable' and process_attempts = 1 and lease_token is null
    and next_attempt_at between clock_timestamp() + interval '110 seconds' and clock_timestamp() + interval '121 seconds'
    from public.merchant_payment_events where event_id = 'evt_r1_pi')
  and pg_temp.claim() = '{"receipts":[],"skipped":0,"failed":0}'::jsonb, 'a retry waits two minutes after the first attempt');
update public.merchant_payment_events set next_attempt_at = clock_timestamp() - interval '1 second' where event_id = 'evt_r1_pi';
select pg_temp.check(pg_temp.claim()->'receipts' @> '[{"event_id":"evt_r1_pi","attempts":2}]', 'when its time comes it is claimed again');
select pg_temp.check(public.finish_program_sale_receipt(pg_temp.ref('evt_r1_pi') || '{"action":"retry","code":"stripe_unavailable"}') @> '{"state":"retry"}'
  and (select next_attempt_at between clock_timestamp() + interval '230 seconds' and clock_timestamp() + interval '241 seconds'
    from pg_temp.the_receipt('evt_r1_pi')), 'and waits twice as long after each further attempt');
update public.merchant_payment_events set next_attempt_at = clock_timestamp() - interval '1 second' where event_id = 'evt_r1_pi';
select pg_temp.check(public.finish_program_sale_receipt(pg_temp.ref('evt_r1_pi') || '{"action":"retry","code":"fee_pending","delay_seconds":45}') @> '{"state":"retry"}'
  and (select process_attempts = 3 and process_error = 'fee_pending'
    and next_attempt_at between clock_timestamp() + interval '40 seconds' and clock_timestamp() + interval '46 seconds'
    from pg_temp.the_receipt('evt_r1_pi')), 'a retry may name its own short wait');
update public.merchant_payment_events set next_attempt_at = clock_timestamp() - interval '1 second' where event_id = 'evt_r1_pi';
select pg_temp.check(public.finish_program_sale_receipt(pg_temp.ref('evt_r1_pi') || '{"action":"release","code":"worker_stopped"}') @> '{"state":"released"}'
  and (select process_attempts = 3 and processed_at is null and lease_token is null and process_error = 'worker_stopped'
    and next_attempt_at between clock_timestamp() + interval '290 seconds' and clock_timestamp() + interval '301 seconds'
    from pg_temp.the_receipt('evt_r1_pi')), 'a release hands the receipt back without counting the attempt');
update public.merchant_payment_events set next_attempt_at = clock_timestamp() - interval '1 second', process_attempts = 7 where event_id = 'evt_r1_pi';
select pg_temp.check(public.finish_program_sale_receipt(pg_temp.ref('evt_r1_pi') || '{"action":"retry","code":"stripe_unavailable"}') = '{"state":"failed","outcome":"failed"}'::jsonb
  and (select processed_at is not null and process_outcome = 'failed' and process_error = 'stripe_unavailable' and process_attempts = 8 and lease_token is null
    from pg_temp.the_receipt('evt_r1_pi')), 'the eighth attempt that still fails is the last: the receipt ends as failed with its last code');
-- A worker that died holding the eighth attempt.
select pg_temp.receipt('evt_r2_pi', 'payment_intent.succeeded', 'pi_r2', 'pi_r2');
select pg_temp.ref('evt_r2_pi');
update public.merchant_payment_events set process_attempts = 8, lease_until = clock_timestamp() - interval '1 second' where event_id = 'evt_r2_pi';
select pg_temp.check(pg_temp.claim() @> '{"receipts":[],"failed":1}'
  and (select process_outcome = 'failed' and process_error = 'lease_expired' from pg_temp.the_receipt('evt_r2_pi')),
  'a receipt whose last attempt never reported back is given up by the next claim');
select pg_temp.check((select count(*) = 0 from public.merchant_payment_events where processed_at is null)
  and not exists (select 1 from public.merchant_payment_events where process_outcome !~ '^[a-z_]+$' or process_error !~ '^[a-z_]+$'),
  'every receipt of this suite is finished, with codes only');

-- What the console shows -----------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e8000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create temporary table tracking_a as select pg_temp.tracking('a8000000-0000-4000-8000-000000000001') as answer;
reset role;
-- Workspace A by now: 39 payments by the console's count (an invoice without a PaymentIntent on
-- its receipt counts on its own), one of them tagged in the event itself; 32 sales, 15 of them
-- tied to a click; the latest sale is the renewal matched through its subscription.
select pg_temp.check((select answer = jsonb_build_object(
    'connected', true, 'payments_seen', 39, 'tagged_payments', 1, 'sales', 32, 'matched_sales', 15,
    'last_sale_at', pg_temp.t('3 days'), 'last_matched_at', pg_temp.t('3 days'), 'last_match_source', 'subscription',
    'sdk_click_seen_at', pg_temp.t('1 hour')) from tracking_a),
  'a member sees whether Stripe is connected, payments seen and tagged, sales, matched sales, the last match and the last SDK click');
select pg_temp.check((select 32 = (select count(*) from public.program_sales where program_id = 'd8000000-0000-4000-8000-000000000001')
    and 15 = (select count(*) from public.program_sales where program_id = 'd8000000-0000-4000-8000-000000000001' and click_record_id is not null)
    and jsonb_typeof(answer->'payments_seen') = 'number' and jsonb_typeof(answer->'connected') = 'boolean'
    and (answer->>'last_sale_at')::timestamptz = pg_temp.t('3 days')
    and (select count(*) = 9 from jsonb_object_keys(answer)) from tracking_a),
  'the counts are the program''s own sales, in exactly the nine fields the console reads');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e8000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select pg_temp.check(pg_temp.tracking('a8000000-0000-4000-8000-000000000001') = (select answer from tracking_a), 'an analyst sees the same');
select pg_temp.check(pg_temp.fails('select public.workspace_program_tracking(''a8000000-0000-4000-8000-000000000002'')') like 'P0002%'
  and pg_temp.fails('select public.workspace_program_tracking(null)') like 'P0002%', 'a member of one workspace cannot read another');
select set_config('request.jwt.claims', '{"sub":"e8000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select pg_temp.check(pg_temp.fails('select public.workspace_program_tracking(''a8000000-0000-4000-8000-000000000001'')') like 'P0002%', 'someone in no workspace is refused');
select set_config('request.jwt.claims', '', true);
select pg_temp.check(pg_temp.fails('select public.workspace_program_tracking(''a8000000-0000-4000-8000-000000000001'')') like '42501%', 'and so is a call without a user');
select set_config('request.jwt.claims', '{"sub":"e8000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select pg_temp.check(pg_temp.tracking('a8000000-0000-4000-8000-000000000002') = jsonb_build_object('connected', true, 'payments_seen', 1, 'tagged_payments', 0,
    'sales', 0, 'matched_sales', 0, 'last_sale_at', null, 'last_matched_at', null, 'last_match_source', null, 'sdk_click_seen_at', pg_temp.t('-1 day')),
  'a connected workspace without a program sees its payments and SDK clicks but no sales');
select pg_temp.check(pg_temp.tracking('a8000000-0000-4000-8000-000000000006') = '{"connected":false,"payments_seen":0,"tagged_payments":0,"sales":0,"matched_sales":0,"last_sale_at":null,"last_matched_at":null,"last_match_source":null,"sdk_click_seen_at":null}'::jsonb,
  'a workspace that never connected sees zeros');
reset role;
select set_config('request.jwt.claims', '', true);

-- The schedule and the operator view ---------------------------------------------------------------
select pg_temp.check((select not enabled and last_tick_at is null from kma_internal.program_sales_schedule)
  and kma_internal.tick_program_sales_schedule() = '{"status":"paused"}'::jsonb, 'the sweep is off until it is enabled');
select pg_temp.check((select last_tick_at is not null and last_dispatch_at is null from kma_internal.program_sales_schedule),
  'a paused sweep only notes that it ticked');
update kma_internal.program_sales_schedule set enabled = true;
select pg_temp.check(kma_internal.tick_program_sales_schedule() = '{"status":"idle"}'::jsonb, 'with nothing waiting the sweep calls nobody');
select pg_temp.receipt('evt_t1_pi', 'payment_intent.succeeded', 'pi_t1', 'pi_t1');
select pg_temp.check(kma_internal.tick_program_sales_schedule() = '{"status":"credential_missing"}'::jsonb, 'without its credential the sweep calls nobody');
insert into vault.decrypted_secrets(name, decrypted_secret) values ('kma_program_sales_scheduler', repeat('s', 40));
-- The local fixture has no network: reaching net.http_post is the proof that the worker would be called.
select pg_temp.check(pg_temp.fails('select kma_internal.tick_program_sales_schedule()') like '%HTTP disabled in local isolated SQL fixture%',
  'with a receipt waiting and a credential the sweep calls the worker');
select pg_temp.ref('evt_t1_pi');
select pg_temp.check(kma_internal.tick_program_sales_schedule() = '{"status":"idle"}'::jsonb, 'a receipt a worker already holds is not a reason to call');
set local role service_role;
create temporary table health as select public.program_sales_health() as answer;
reset role;
select pg_temp.check((select answer->'schedule'->>'enabled' = 'true' and answer->'queue' @> '{"due":0,"waiting":0,"leased":1}'
    and answer->'failed' = '{"lease_expired":1,"stripe_unavailable":1}'::jsonb and answer->'retrying' = '{}'::jsonb
    and (answer->'outcomes_last_day'->>'recorded')::int > 20 and answer->'outcomes_last_day' @> '{"no_program":3,"before_program":1,"connection_inactive":1,"failed":2}'
    and (answer->'sales'->>'total')::int = (select count(*) from public.program_sales)
    and answer->'sales'->>'fee_unknown' is not null and not answer::text ~* 'acct_|pi_|evt_|@' from health),
  'the operator view counts the queue, outcomes and sales without identifiers');

select 'ok ' || count(*) || ' program sales assertions' from sales_assertions;
rollback;
