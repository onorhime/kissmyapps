-- Provider-free test of payment receipts for connected merchant Stripe accounts: the webhook
-- stores one small row per live event of an actively connected account, and a workspace
-- member sees how many payments were seen and how many carried a creator tag.
-- The console-connect RPCs are tested elsewhere; this suite inserts its own workspaces,
-- members, merchant businesses and connections.
begin;
set local time zone 'UTC';
create temporary table payment_assertions(label text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Payment event assertion failed: %', label; end if;
  insert into payment_assertions values (label);
end $$;
create function pg_temp.fails(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.at(t text) returns bigint language sql as $$
  select extract(epoch from t::timestamptz)::bigint
$$;
-- A valid checkout receipt for merchant A; each test overrides what it is about.
create function pg_temp.ev(overrides jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object(
    'platform_account_id', 'acct_KMAPlatform', 'livemode', true, 'account_id', 'acct_MerchantA',
    'event_id', 'evt_a_checkout_1', 'event_type', 'checkout.session.completed',
    'event_created', pg_temp.at('2026-11-13 12:00:00+00'),
    'object_id', 'cs_live_a1', 'payment_intent_id', 'pi_a1', 'amount_minor', 4900, 'currency', 'usd',
    'kma_click', null, 'tag_source', null, 'payload_sha256', repeat('a', 64)) || overrides
$$;
create function pg_temp.record(overrides jsonb default '{}') returns jsonb language sql as $$
  select public.record_merchant_payment_event(pg_temp.ev(overrides))
$$;
-- The same, at a given time; true when the receipt was stored as new.
create function pg_temp.stored(overrides jsonb, t text default '2026-11-13 12:00:00+00') returns boolean language sql as $$
  select pg_temp.record(overrides || jsonb_build_object('event_created', pg_temp.at(t))) = '{"matched":true,"duplicate":false}'::jsonb
$$;
create function pg_temp.record_fails(overrides jsonb) returns text language sql as $$
  select pg_temp.fails(format('select public.record_merchant_payment_event(%L)', pg_temp.ev(overrides)))
$$;
create function pg_temp.summary(workspace text, member text) returns jsonb language sql as $$
  select public.workspace_stripe_payment_summary(jsonb_build_object('workspace_id', workspace, 'user_id', member))
$$;
create function pg_temp.summary_fails(workspace text, member text) returns text language sql as $$
  select pg_temp.fails(format('select public.workspace_stripe_payment_summary(%L)',
    jsonb_build_object('workspace_id', workspace, 'user_id', member)))
$$;
grant all on payment_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- Two merchants with a workspace each, a third workspace that never connected -------------------
insert into auth.users(id, email, email_confirmed_at) values
  ('e7000000-0000-4000-8000-000000000001', 'owner@speaksix.example', now()),
  ('e7000000-0000-4000-8000-000000000002', 'analyst@speaksix.example', now()),
  ('e7000000-0000-4000-8000-000000000003', 'owner@elsewhere.example', now()),
  ('e7000000-0000-4000-8000-000000000004', 'stranger@nowhere.example', now()),
  ('e7000000-0000-4000-8000-000000000005', 'owner@notconnected.example', now());
insert into public.analytics_workspaces(id, name, created_by) values
  ('a7000000-0000-4000-8000-000000000001', 'SpeakSix', 'e7000000-0000-4000-8000-000000000001'),
  ('a7000000-0000-4000-8000-000000000002', 'Elsewhere', 'e7000000-0000-4000-8000-000000000003'),
  ('a7000000-0000-4000-8000-000000000003', 'Not connected', 'e7000000-0000-4000-8000-000000000005');
insert into public.analytics_workspace_members(workspace_id, user_id, role) values
  ('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001', 'owner'),
  ('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000002', 'analyst'),
  ('a7000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000003', 'owner'),
  ('a7000000-0000-4000-8000-000000000003', 'e7000000-0000-4000-8000-000000000005', 'owner');
insert into public.merchant_businesses(id, business_name, email, created_by, workspace_id) values
  ('b7000000-0000-4000-8000-000000000001', 'SpeakSix Ltd', 'owner@speaksix.example', 'e7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001'),
  ('b7000000-0000-4000-8000-000000000002', 'Elsewhere Inc', 'owner@elsewhere.example', 'e7000000-0000-4000-8000-000000000003', 'a7000000-0000-4000-8000-000000000002'),
  ('b7000000-0000-4000-8000-000000000003', 'Revoked Co', 'owner@notconnected.example', 'e7000000-0000-4000-8000-000000000005', null),
  ('b7000000-0000-4000-8000-000000000004', 'Pending Co', 'owner@notconnected.example', 'e7000000-0000-4000-8000-000000000005', null);
insert into public.merchant_connections(id, merchant_id, platform_account_id, livemode, account_id, status, charges_enabled, payouts_enabled, details_submitted, confirmed_at, revoked_at) values
  ('c7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000001', 'acct_KMAPlatform', true, 'acct_MerchantA', 'active', true, true, true, now(), null),
  ('c7000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000002', 'acct_KMAPlatform', true, 'acct_MerchantB', 'active', true, true, true, now(), null),
  ('c7000000-0000-4000-8000-000000000003', 'b7000000-0000-4000-8000-000000000003', 'acct_KMAPlatform', true, 'acct_Revoked', 'revoked', true, true, true, now(), now()),
  ('c7000000-0000-4000-8000-000000000004', 'b7000000-0000-4000-8000-000000000004', 'acct_KMAPlatform', true, 'acct_Pending', 'pending', false, false, false, null, null),
  -- The same merchant business also has an active TEST connection to another account.
  ('c7000000-0000-4000-8000-000000000005', 'b7000000-0000-4000-8000-000000000001', 'acct_KMAPlatform', false, 'acct_TestOnly', 'active', true, true, true, now(), null);

-- Closed by default ------------------------------------------------------------------------
select pg_temp.check((select relrowsecurity from pg_class where oid = 'public.merchant_payment_events'::regclass)
  and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'merchant_payment_events'),
  'receipts have row level security on and no policy');
select pg_temp.check((select bool_and(not has_table_privilege(r, 'public.merchant_payment_events', p))
  from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete']) p),
  'no API role reads or writes receipts directly');
select pg_temp.check((select bool_and(has_function_privilege('service_role', f, 'execute')
    and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
  from unnest(array['public.record_merchant_payment_event(jsonb)', 'public.workspace_stripe_payment_summary(jsonb)']) f),
  'only the service role may call the two functions');
select pg_temp.check((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))
  from pg_proc p where p.oid in ('public.record_merchant_payment_event(jsonb)'::regprocedure,
    'public.workspace_stripe_payment_summary(jsonb)'::regprocedure)),
  'both functions are security definer with an empty search path and are not open to everyone');
set local role anon;
select pg_temp.check(pg_temp.record_fails('{}') like '42501%', 'a visitor cannot record a receipt');
select pg_temp.check(pg_temp.summary_fails('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001') like '42501%',
  'a visitor cannot read a summary');
select pg_temp.check(pg_temp.fails('select count(*) from public.merchant_payment_events') like '42501%', 'a visitor cannot read receipts');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e7000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select pg_temp.check(pg_temp.record_fails('{}') like '42501%', 'a signed-in owner cannot record a receipt from the browser');
select pg_temp.check(pg_temp.summary_fails('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001') like '42501%',
  'a signed-in owner cannot call the summary from the browser');
select pg_temp.check(pg_temp.fails('select count(*) from public.merchant_payment_events') like '42501%', 'or read receipts');
select pg_temp.check(pg_temp.fails('insert into public.merchant_payment_events(platform_account_id) values (''acct_x'')') like '42501%', 'or write them');
reset role;

-- Which accounts are recorded ------------------------------------------------------------------
set local role service_role;
select pg_temp.check(pg_temp.fails('select count(*) from public.merchant_payment_events') like '42501%',
  'the service role reaches receipts only through the functions');
select pg_temp.check(pg_temp.summary('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001')
  = '{"seen":0,"tagged":0,"last_at":null,"last_tagged_at":null}'::jsonb, 'a connection with no payments yet shows zeros');
select pg_temp.check(pg_temp.record('{"account_id":"acct_Unknown","event_id":"evt_unknown_1"}') = '{"matched":false,"duplicate":false}'::jsonb,
  'an account nobody connected is not matched');
select pg_temp.check(pg_temp.record('{"account_id":"acct_Revoked","event_id":"evt_revoked_1"}') = '{"matched":false,"duplicate":false}'::jsonb,
  'a revoked connection is not matched');
select pg_temp.check(pg_temp.record('{"account_id":"acct_Pending","event_id":"evt_pending_1"}') = '{"matched":false,"duplicate":false}'::jsonb,
  'a pending connection is not matched');
select pg_temp.check(pg_temp.record('{"account_id":"acct_TestOnly","event_id":"evt_testonly_1"}') = '{"matched":false,"duplicate":false}'::jsonb,
  'an account connected only in test mode is not matched');
select pg_temp.check(pg_temp.record('{"platform_account_id":"acct_OtherPlatform","event_id":"evt_platform_1"}') = '{"matched":false,"duplicate":false}'::jsonb,
  'the same account under another platform is not matched');
select pg_temp.check(pg_temp.record_fails('{"livemode":false}') like '22023%', 'a test mode event is refused');
select pg_temp.check(pg_temp.record_fails('{"livemode":false,"account_id":"acct_TestOnly"}') like '22023%', 'even for a test connection');
select pg_temp.check(pg_temp.record_fails('{"livemode":null}') like '22023%' and pg_temp.record_fails('{"livemode":"true"}') like '22023%',
  'live mode must be stated as true');
reset role;
select pg_temp.check((select count(*) = 0 from public.merchant_payment_events), 'nothing is stored for unmatched or refused events');

-- A matched receipt, delivered again ---------------------------------------------------------------
set local role service_role;
select pg_temp.check(pg_temp.record() = '{"matched":true,"duplicate":false}'::jsonb, 'an active live connection is matched');
select pg_temp.check(pg_temp.record() = '{"matched":true,"duplicate":true}'::jsonb, 'the same event again is a duplicate');
select pg_temp.check(pg_temp.record_fails(jsonb_build_object('payload_sha256', repeat('b', 64))) like '23505%',
  'the same event id with a different signed body is refused');
select pg_temp.check(pg_temp.record_fails('{"event_type":"payment_intent.succeeded"}') like '23505%',
  'or with a different event type');
reset role;
select pg_temp.check((select count(*) = 1 and bool_and(
    e.connection_id = 'c7000000-0000-4000-8000-000000000001' and e.account_id = 'acct_MerchantA'
    and e.platform_account_id = 'acct_KMAPlatform' and e.livemode and e.event_type = 'checkout.session.completed'
    and e.object_id = 'cs_live_a1' and e.payment_intent_id = 'pi_a1' and e.amount_minor = 4900 and e.currency = 'USD'
    and e.kma_click is null and e.tag_source is null and e.event_created = '2026-11-13 12:00:00+00'
    and e.received_at is not null and e.payload_sha256 = repeat('a', 64))
  from public.merchant_payment_events e), 'one receipt holds the identifiers, amount, upper-case currency and times');

-- The creator tag ----------------------------------------------------------------------------------
set local role service_role;
select pg_temp.check(
  pg_temp.stored('{"event_id":"evt_a_tag_meta","object_id":"cs_live_a2","payment_intent_id":"pi_a2","kma_click":"kma_Click-0001","tag_source":"metadata"}', '2026-11-13 12:05:00+00')
  and pg_temp.stored('{"event_id":"evt_a_tag_ref","object_id":"cs_live_a3","payment_intent_id":null,"kma_click":"kma_ref_0002","tag_source":"client_reference_id"}', '2026-11-13 12:10:00+00')
  and pg_temp.stored(jsonb_build_object('event_id', 'evt_a_tag_long', 'object_id', 'cs_live_a4', 'payment_intent_id', 'pi_a4', 'kma_click', repeat('x', 200), 'tag_source', 'metadata'), '2026-11-13 12:15:00+00'),
  'receipts with a creator tag are stored');
-- Not creator tags: too short, a forbidden character, too long.
select pg_temp.check(
  pg_temp.stored('{"event_id":"evt_a_tag_short","object_id":"cs_live_a5","payment_intent_id":"pi_a5","kma_click":"kma_123","tag_source":"metadata"}', '2026-11-13 12:20:00+00')
  and pg_temp.stored('{"event_id":"evt_a_tag_chars","object_id":"cs_live_a6","payment_intent_id":"pi_a6","kma_click":"kma click <script>","tag_source":"client_reference_id"}', '2026-11-13 12:25:00+00')
  and pg_temp.stored(jsonb_build_object('event_id', 'evt_a_tag_toolong', 'object_id', 'cs_live_a7', 'payment_intent_id', 'pi_a7', 'kma_click', repeat('x', 201), 'tag_source', 'metadata'), '2026-11-13 12:30:00+00'),
  'a receipt whose tag is not a creator tag is still stored');
select pg_temp.check(pg_temp.record_fails('{"event_id":"evt_a_tag_nosource","kma_click":"kma_Click-0001"}') like '22023%', 'a tag must say where it came from');
select pg_temp.check(pg_temp.record_fails('{"event_id":"evt_a_tag_badsource","kma_click":"kma_Click-0001","tag_source":"customer_email"}') like '22023%',
  'and only from metadata or the client reference');
select pg_temp.check(pg_temp.record_fails('{"event_id":"evt_a_tag_number","kma_click":12345678,"tag_source":"metadata"}') like '22023%', 'a tag is text');
reset role;
select pg_temp.check((select (kma_click, tag_source) = ('kma_Click-0001', 'metadata') from public.merchant_payment_events where event_id = 'evt_a_tag_meta')
  and (select (kma_click, tag_source) = ('kma_ref_0002', 'client_reference_id') from public.merchant_payment_events where event_id = 'evt_a_tag_ref')
  and (select kma_click = repeat('x', 200) and tag_source = 'metadata' from public.merchant_payment_events where event_id = 'evt_a_tag_long'),
  'a tag of 8 to 200 letters, digits, dashes and underscores is kept as sent, with its source');
select pg_temp.check((select count(*) = 3 and bool_and(kma_click is null and tag_source is null)
  from public.merchant_payment_events where event_id in ('evt_a_tag_short', 'evt_a_tag_chars', 'evt_a_tag_toolong')),
  'anything else is stored without a tag');
select pg_temp.check(pg_temp.fails('insert into public.merchant_payment_events(platform_account_id, livemode, event_id, connection_id, account_id, event_type, object_id, kma_click, tag_source, event_created, payload_sha256)
    values (''acct_KMAPlatform'', true, ''evt_direct_1'', ''c7000000-0000-4000-8000-000000000001'', ''acct_MerchantA'', ''invoice.paid'', ''in_1'', ''bad tag'', ''metadata'', now(), repeat(''a'', 64))') like '23514%'
  and pg_temp.fails('insert into public.merchant_payment_events(platform_account_id, livemode, event_id, connection_id, account_id, event_type, object_id, event_created, payload_sha256)
    values (''acct_KMAPlatform'', false, ''evt_direct_2'', ''c7000000-0000-4000-8000-000000000001'', ''acct_MerchantA'', ''invoice.paid'', ''in_1'', now(), repeat(''a'', 64))') like '23514%',
  'the table itself refuses a malformed tag and a test mode row');

-- Malformed receipts -------------------------------------------------------------------------------
set local role service_role;
select pg_temp.check((select bool_and(pg_temp.record_fails(x) like '22023%') from unnest(array[
    '{"event_id":"evt_bad_1","event_type":"customer.created"}',
    '{"event_id":"evt_bad_2","event_type":"charge.dispute.updated"}',
    '{"event_id":"not_an_event"}',
    '{"event_id":"evt_bad_3","account_id":"acct_KMAPlatform"}',
    '{"event_id":"evt_bad_4","account_id":null}',
    '{"event_id":"evt_bad_5","platform_account_id":null}',
    '{"event_id":"evt_bad_6","payload_sha256":"ABC"}',
    '{"event_id":"evt_bad_7","payload_sha256":null}',
    '{"event_id":"evt_bad_8","object_id":null}',
    '{"event_id":"evt_bad_9","object_id":"cs live"}',
    '{"event_id":"evt_bad_10","payment_intent_id":"ch_notanintent"}',
    '{"event_id":"evt_bad_11","amount_minor":-1}',
    '{"event_id":"evt_bad_12","amount_minor":10.5}',
    '{"event_id":"evt_bad_13","amount_minor":"4900"}',
    '{"event_id":"evt_bad_14","currency":"dollars"}',
    '{"event_id":"evt_bad_15","event_created":"2026-11-13T12:00:00Z"}',
    '{"event_id":"evt_bad_16","event_created":0}',
    '{"event_id":"evt_bad_17","event_created":null}'
  ]::jsonb[]) x), 'malformed receipts are refused');
select pg_temp.check(pg_temp.fails('select public.record_merchant_payment_event(null)') like '22023%'
  and pg_temp.fails('select public.record_merchant_payment_event(''[]'')') like '22023%', 'so is an empty call');
select pg_temp.check(pg_temp.stored('{"event_id":"evt_a_sparse","event_type":"invoice.paid","object_id":"in_a1","payment_intent_id":null,"amount_minor":null,"currency":null}', '2026-11-13 12:35:00+00'),
  'amount, currency and payment intent may be absent');

-- Refunds and disputes are receipts too, but not payments -----------------------------------------------
-- A tagged refund of an untagged payment, and a dispute about a payment that was never seen,
-- all later than every payment: none of it may show in the summary.
select pg_temp.check((select bool_and(pg_temp.stored(x, '2026-11-13 18:00:00+00')) from unnest(array[
    '{"event_id":"evt_a_refund_1","event_type":"charge.refunded","object_id":"ch_a5","payment_intent_id":"pi_a5","amount_minor":1000,"kma_click":"kma_Click-0005","tag_source":"metadata"}',
    '{"event_id":"evt_a_refund_2","event_type":"refund.created","object_id":"re_a5","payment_intent_id":"pi_a5","amount_minor":1000}',
    '{"event_id":"evt_a_refund_3","event_type":"refund.updated","object_id":"re_a5","payment_intent_id":"pi_a5","amount_minor":1000}',
    '{"event_id":"evt_a_dispute_1","event_type":"charge.dispute.created","object_id":"dp_a9","payment_intent_id":"pi_a9","amount_minor":4900,"kma_click":"kma_Click-0009","tag_source":"metadata"}',
    '{"event_id":"evt_a_dispute_2","event_type":"charge.dispute.closed","object_id":"dp_a9","payment_intent_id":"pi_a9","amount_minor":4900}'
  ]::jsonb[]) x), 'refund and dispute events are recorded');
-- The PaymentIntent of the first checkout, and an async success for the tagged one: no new payment.
select pg_temp.check(
  pg_temp.stored('{"event_id":"evt_a_intent_1","event_type":"payment_intent.succeeded","object_id":"pi_a1","payment_intent_id":"pi_a1"}', '2026-11-13 12:00:01+00')
  and pg_temp.stored('{"event_id":"evt_a_async_3","event_type":"checkout.session.async_payment_succeeded","object_id":"cs_live_a3","payment_intent_id":null}', '2026-11-13 12:40:00+00'),
  'further events of a payment already seen are recorded');

-- Another workspace's payments ----------------------------------------------------------------------
select pg_temp.check(
  pg_temp.stored('{"account_id":"acct_MerchantB","event_id":"evt_b_checkout_1","object_id":"cs_live_b1","payment_intent_id":"pi_b1","kma_click":"kma_Other-0009","tag_source":"metadata"}', '2026-11-14 09:00:00+00')
  and pg_temp.stored('{"account_id":"acct_MerchantB","event_id":"evt_b_invoice_1","event_type":"invoice.paid","object_id":"in_b2","payment_intent_id":null}', '2026-11-14 10:00:00+00'),
  'another connected account is recorded under its own connection');
-- Event ids are scoped to the platform account, not to the merchant: the same id cannot change hands.
select pg_temp.check(pg_temp.record_fails('{"account_id":"acct_MerchantB"}') like '23505%', 'an event id cannot move to another account');

-- The summary ----------------------------------------------------------------------------------------
-- Merchant A: checkouts a1..a7 and the sparse invoice are 8 payments; the PaymentIntent event of a1
-- and the async success of a3 belong to payments already counted; 3 carried a tag.
select pg_temp.check(pg_temp.summary('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001')
  = jsonb_build_object('seen', 8, 'tagged', 3, 'last_at', '2026-11-13 12:40:00+00'::timestamptz, 'last_tagged_at', '2026-11-13 12:15:00+00'::timestamptz),
  'the summary counts payments once each, not refunds or disputes, with the tagged count and both last times');
select pg_temp.check(jsonb_typeof(pg_temp.summary('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001')->'seen') = 'number'
  and (pg_temp.summary('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001')->>'last_at')::timestamptz = '2026-11-13 12:40:00+00',
  'counts are numbers and times are timestamps');
select pg_temp.check(pg_temp.summary('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000002')->>'seen' = '8',
  'any member of the workspace, such as an analyst, sees it');
select pg_temp.check(pg_temp.summary('a7000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000003')
  = jsonb_build_object('seen', 2, 'tagged', 1, 'last_at', '2026-11-14 10:00:00+00'::timestamptz, 'last_tagged_at', '2026-11-14 09:00:00+00'::timestamptz),
  'another workspace sees only its own payments');
select pg_temp.check(pg_temp.summary('a7000000-0000-4000-8000-000000000003', 'e7000000-0000-4000-8000-000000000005')
  = '{"seen":0,"tagged":0,"last_at":null,"last_tagged_at":null}'::jsonb, 'a workspace that never connected sees zeros');
select pg_temp.check(pg_temp.summary_fails('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000004') like '42501%',
  'someone who is in no workspace is refused');
select pg_temp.check(pg_temp.summary_fails('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000003') like '42501%'
  and pg_temp.summary_fails('a7000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000001') like '42501%',
  'a member of one workspace cannot read another');
select pg_temp.check(pg_temp.fails('select public.workspace_stripe_payment_summary(''{}'')') like '42501%'
  and pg_temp.fails('select public.workspace_stripe_payment_summary(null)') like '42501%'
  and pg_temp.fails('select public.workspace_stripe_payment_summary(''{"workspace_id":"a7000000-0000-4000-8000-000000000001"}'')') like '42501%'
  and pg_temp.fails('select public.workspace_stripe_payment_summary(''{"workspace_id":"a7000000-0000-4000-8000-000000000099","user_id":"e7000000-0000-4000-8000-000000000001"}'')') like '42501%',
  'a call without a known workspace and member is refused');
reset role;
select pg_temp.check((select count(*) = 15 from public.merchant_payment_events where account_id = 'acct_MerchantA')
  and (select count(*) = 2 from public.merchant_payment_events where account_id = 'acct_MerchantB')
  and (select count(*) = 17 from public.merchant_payment_events)
  and (select bool_and(e.connection_id = c.id) from public.merchant_payment_events e join public.merchant_connections c on c.account_id = e.account_id and c.livemode), 'every receipt belongs to the account that sent it');
select pg_temp.check((select indexdef like '%(connection_id, account_id, event_created DESC)%' and indexdef like '%WHERE%event_type%'
  from pg_indexes where schemaname = 'public' and indexname = 'merchant_payment_events_summary'), 'the summary has its own index per connection');

-- Disconnecting and reconnecting ------------------------------------------------------------------------
-- Workspace B reconnects with a different Stripe account on the same connection row.
update public.merchant_connections set account_id = 'acct_MerchantB2' where id = 'c7000000-0000-4000-8000-000000000002';
set local role service_role;
select pg_temp.check(pg_temp.summary('a7000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000003')->>'seen' = '0',
  'payments of a previously connected account are not shown for the new one');
select pg_temp.check(pg_temp.record('{"account_id":"acct_MerchantB","event_id":"evt_b_checkout_3"}') = '{"matched":false,"duplicate":false}'::jsonb
  and pg_temp.record('{"account_id":"acct_MerchantB2","event_id":"evt_b2_checkout_1","object_id":"cs_live_b2x","payment_intent_id":"pi_b2x"}') = '{"matched":true,"duplicate":false}'::jsonb,
  'only the account that is connected now is recorded');
select pg_temp.check(pg_temp.summary('a7000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000003')->>'seen' = '1',
  'and counted');
reset role;
-- Workspace A disconnects.
update public.merchant_connections set status = 'revoked', revoked_at = now() where id = 'c7000000-0000-4000-8000-000000000001';
set local role service_role;
select pg_temp.check(pg_temp.summary('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001')
  = '{"seen":0,"tagged":0,"last_at":null,"last_tagged_at":null}'::jsonb, 'after disconnecting the summary is empty');
select pg_temp.check(pg_temp.record('{"event_id":"evt_a_after_revoke"}') = '{"matched":false,"duplicate":false}'::jsonb
  and pg_temp.record() = '{"matched":false,"duplicate":false}'::jsonb, 'and new or repeated events are no longer recorded');
reset role;
select pg_temp.check((select count(*) = 15 from public.merchant_payment_events where account_id = 'acct_MerchantA'),
  'receipts already stored are kept');
update public.merchant_connections set status = 'active', revoked_at = null where id = 'c7000000-0000-4000-8000-000000000001';
set local role service_role;
select pg_temp.check(pg_temp.summary('a7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001')->>'seen' = '8',
  'and count again when the same account reconnects');
reset role;

select 'ok ' || count(*) || ' merchant payment event assertions' from payment_assertions;
rollback;
