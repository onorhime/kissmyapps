-- The Phase 2 pieces working together, with no fixtures standing in for each other: a
-- merchant saves, reads and publishes a program; KissMyApps approves it; a visitor arrives
-- from a creator click and the web SDK reports it; a tagged payment and an untagged one by
-- the same identified buyer both become sales tied to that click; the console's tracking
-- line and the admin queue see it; disconnecting Stripe pauses the program.
-- Stripe is never called: the connection and the receipts are written the way the
-- Phase 1 functions write them.
begin;
set local time zone 'UTC';
create temporary table e2e_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program end to end assertion failed: %', label; end if;
  insert into e2e_assertions values (label);
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
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
create function pg_temp.program() returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q('workspace')
$$;
grant all on qa, e2e_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('e2000000-0000-4000-8000-000000000001', 'owner@lingo.example', now(), '{"company":"Lingo"}'),
  ('e2000000-0000-4000-8000-000000000011', 'operations@kissmyapps.dev', now(), '{}');
insert into qa values ('owner', 'e2000000-0000-4000-8000-000000000001'), ('kma_operations', 'e2000000-0000-4000-8000-000000000011');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_operations'), 'operations');
select pg_temp.sign_in('owner');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);

-- Stripe connected, as workspace-stripe-connect leaves it.
with business as (
  insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
  values ('Lingo Ltd', 'billing@lingo.example', pg_temp.q('owner'), pg_temp.q('workspace')) returning id)
insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status, business_name,
  country, charges_enabled, details_submitted, confirmed_at, verified_at)
select id, 'acct_KMAPlatform', true, 'acct_LingoE2E', 'active', 'Lingo Ltd', 'GB', true, true, now(), now() from business;

-- The merchant: one form, read the agreement, publish ---------------------------------------
select pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
  '{"name":"Lingo","category":"education","tagline":"Learn a language in ten minutes a day.",
    "landing_url":"https://lingo-app.io/start","commission_type":"percent","commission_rate_bps":3000,
    "commission_duration":"months","commission_months":12}'::jsonb));
select pg_temp.check((pg_temp.program()).status = 'draft' and (pg_temp.program()).attribution_window_days = 30,
  'the first save creates a draft with the default options');
select pg_temp.call('owner', format('select public.workspace_program_mark_agreement_read(%L, %L)', pg_temp.q('workspace'),
  pg_temp.call('owner', format('select public.workspace_program_agreement(%L)', pg_temp.q('workspace')))->>'sha256'));
select pg_temp.check(
  (pg_temp.call('owner', format('select public.workspace_program_get(%L)', pg_temp.q('workspace')))->>'can_submit')::boolean,
  'a complete, read program with Stripe connected can be published');
select pg_temp.call('owner', format('select public.workspace_program_submit(%L, %s)', pg_temp.q('workspace'), (pg_temp.program()).revision));
select pg_temp.check((pg_temp.program()).status = 'in_review', 'publishing sends the first listing to review');

-- KissMyApps: the queue shows it, approval makes it live -------------------------------------
select pg_temp.check(
  (select q->'programs'->0->>'name' = 'Lingo' and q->'programs'->0->>'stripe_account_id' = 'acct_LingoE2E'
      and q->'programs'->0->'agreement'->>'title' = 'Lingo Affiliate Agreement'
    from pg_temp.call('kma_operations', 'select public.list_admin_program_reviews()') q),
  'the admin queue shows the program with its Stripe account and agreement');
select pg_temp.call('kma_operations', format('select public.review_admin_program(%L)',
  jsonb_build_object('program_id', (pg_temp.program()).id, 'decision', 'approve', 'note', null)));
select pg_temp.check((pg_temp.program()).status = 'live' and (pg_temp.program()).live_terms_version = 1
  and exists (select 1 from public.products where id = (pg_temp.program()).product_id and status = 'active')
  and exists (select 1 from public.funnels where id = (pg_temp.program()).funnel_id and status = 'live'
    and destination_url = 'https://lingo-app.io/start'),
  'approval makes the program live with a product, a live landing page and terms version 1');
select set_config('request.jwt.claims', '', true);

-- A creator click on the program's product. Creators join in Phase 3; until then the link
-- and click rows are written directly (paused link, so no launch checks apply).
insert into public.platform_settings(singleton, tracking_base_url) values (true, 'https://tracking.example.invalid')
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url;
insert into public.affiliates(id, public_name, slug, status) values
  ('e3000000-0000-4000-8000-000000000001', 'Creator', 'e2e-creator', 'active');
alter table public.affiliate_links disable trigger affiliate_links_allocate_alias;
insert into public.affiliate_links(id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url, sub1, status)
select 'e4000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', p.product_id, p.funnel_id,
  'Main', 'e2e_fixture_link_one', 'https://tracking.example.invalid/r/e2e-creator/e2e_fixture_link_one', null, 'paused'
from pg_temp.program() p;
alter table public.affiliate_links enable trigger affiliate_links_allocate_alias;
insert into public.clicks(id, public_click_id, affiliate_link_id, affiliate_id, product_id, funnel_id,
  destination_url_snapshot, occurred_at, created_at, is_bot)
select 'e5000000-0000-4000-8000-000000000001', repeat('e7', 24), 'e4000000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000001', p.product_id, p.funnel_id, 'https://lingo-app.io/start', now(), now(), false
from pg_temp.program() p;

-- The visitor lands with kma_click, the SDK reports it, and the app identifies the buyer.
insert into public.analytics_projects(id, workspace_id, name) values
  ('e8000000-0000-4000-8000-000000000001', pg_temp.q('workspace'), 'Lingo');
insert into qa values ('project', 'e8000000-0000-4000-8000-000000000001');
insert into public.analytics_people(id, project_id, distinct_id, user_id, traits, environment, first_seen, last_seen)
values ('e6000000-0000-4000-8000-000000000001', pg_temp.q('project'), 'user-1', 'user-1',
  '{"email":"Buyer@Example.com"}', 'production', now(), now());
select kma_internal.analytics_touch_session(pg_temp.q('project'), 'production', 'e6000000-0000-4000-8000-000000000001',
  'e2e-session-1', now() - interval '1 minute', now() - interval '1 minute',
  jsonb_build_object('click', jsonb_build_object('kma_click', repeat('e7', 24))), '{}'::jsonb, null, null);
select pg_temp.check(
  (select creator_click = repeat('e7', 24) from public.analytics_sessions where session_key = 'e2e-session-1'),
  'the visit keeps the creator click the SDK sent');

-- Two payments on the connected account: one tagged at checkout, one with no tag at all.
create function pg_temp.receipt(p_event text, p_intent text, p_tag text, p_source text) returns jsonb language sql as $$
  select public.record_merchant_payment_event(jsonb_build_object(
    'platform_account_id', 'acct_KMAPlatform', 'livemode', true, 'account_id', 'acct_LingoE2E',
    'event_id', p_event, 'event_type', 'payment_intent.succeeded',
    'event_created', extract(epoch from clock_timestamp())::bigint + 2,
    'object_id', p_intent, 'payment_intent_id', p_intent, 'amount_minor', 4900, 'currency', 'usd',
    'kma_click', p_tag, 'tag_source', p_source, 'payload_sha256', repeat('a', 64)))
$$;
select pg_temp.check(pg_temp.receipt('evt_e2e_tagged', 'pi_e2etagged', repeat('e7', 24), 'metadata') @> '{"matched":true,"duplicate":false}'
  and pg_temp.receipt('evt_e2e_plain', 'pi_e2eplain', null, null) @> '{"matched":true,"duplicate":false}',
  'the webhook stores a receipt for each payment on the connected account');

-- The worker claims both, reads Stripe (not here) and records what it verified.
create temporary table claimed as
  select r->>'event_id' as event_id, r->>'lease_token' as lease_token
  from jsonb_array_elements(public.claim_program_sale_receipts(
    '{"platform_account_id":"acct_KMAPlatform","limit":10,"lease_seconds":120}')->'receipts') r;
select pg_temp.check((select count(*) = 2 and bool_and(lease_token is not null) from claimed),
  'both receipts are handed to the worker because the account has an approved program');
create function pg_temp.sale(p_event text, p_intent text, extra jsonb) returns jsonb language sql as $$
  select public.record_program_sale(jsonb_build_object(
    'platform_account_id', 'acct_KMAPlatform', 'event_id', p_event,
    'lease_token', (select lease_token from claimed where event_id = p_event),
    'livemode', true, 'payment_intent_id', p_intent, 'charge_id', 'ch_' || substr(p_intent, 4),
    'amount_minor', 4900, 'currency', 'usd', 'refunded_minor', 0,
    'paid_at', extract(epoch from clock_timestamp())::bigint) || extra)
$$;
select pg_temp.check(
  pg_temp.sale('evt_e2e_tagged', 'pi_e2etagged', jsonb_build_object('kma_click', repeat('e7', 24), 'tag_source', 'metadata'))
    @> '{"recorded":true,"created":true}'
  and pg_temp.sale('evt_e2e_plain', 'pi_e2eplain', '{"buyer_email":"buyer@example.com"}') @> '{"recorded":true,"created":true}',
  'each verified payment becomes a sale');
select pg_temp.check(
  (select count(*) = 2
      and bool_and(program_id = (pg_temp.program()).id and affiliate_id = 'e3000000-0000-4000-8000-000000000001'
        and click_record_id = 'e5000000-0000-4000-8000-000000000001')
      and bool_or(match_source = 'metadata') and bool_or(match_source = 'email')
    from public.program_sales where account_id = 'acct_LingoE2E'),
  'the tagged sale and the untagged sale by the identified buyer are both tied to the creator click');
select pg_temp.check(
  not exists (select 1 from public.program_sales s where to_jsonb(s)::text ilike '%buyer@example.com%'),
  'the buyer email is not stored with the sale');

-- The console's tracking line.
select pg_temp.check(
  (select t @> '{"connected":true,"sales":2,"matched_sales":2}' and t->>'last_matched_at' is not null
      and t->>'sdk_click_seen_at' is not null and t->>'last_match_source' in ('metadata', 'email')
    from pg_temp.call('owner', format('select public.workspace_program_tracking(%L)', pg_temp.q('workspace'))) t),
  'the merchant sees the sales and that they are matched to creators');
select set_config('request.jwt.claims', '', true);

-- Stripe disconnected: the program pauses and says why.
update public.merchant_connections set status = 'revoked' where account_id = 'acct_LingoE2E';
select pg_temp.check((pg_temp.program()).status = 'paused' and (pg_temp.program()).pause_reason = 'stripe_disconnected',
  'disconnecting Stripe pauses the live program');

select 'ok ' || count(*) || ' program end to end assertions' from e2e_assertions;
rollback;
