-- The Phase 3 pieces working with Phase 2, through the real functions only: a merchant
-- publishes a program and KissMyApps approves it; a creator reads the agreement, accepts
-- and gets a link; a visitor clicks it; the buyer's tagged payment becomes a sale credited
-- to that creator; the merchant sees the creator with one click and one sale; pausing the
-- program stops crediting while the link keeps opening the landing page.
-- Stripe is never called: the connection and the receipt are written the way the Phase 1
-- and Phase 2 functions write them.
begin;
set local time zone 'UTC';
create temporary table e2e_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program creator end to end assertion failed: %', label; end if;
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
create function pg_temp.program() returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q('workspace')
$$;
-- A visitor opens the creator's link, as the tracking-redirect function asks for it.
create function pg_temp.click() returns jsonb language sql as $$
  select pg_temp.service(format('select to_jsonb(r) from public.register_tracking_click(%L, %L, %L) r',
    'e2e-creator', split_part(pg_temp.t('link_url'), '/', 6), '{}'::jsonb))
$$;
create function pg_temp.creators() returns jsonb language sql as $$
  select pg_temp.call('owner', format('select public.workspace_program_creators(%L)', pg_temp.q('workspace')))
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
grant all on qa, e2e_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('e9000000-0000-4000-8000-000000000001', 'owner@lingo.example', now(), '{"company":"Lingo"}'),
  ('e9000000-0000-4000-8000-000000000011', 'operations@kissmyapps.dev', now(), '{}'),
  ('e9000000-0000-4000-8000-000000000021', 'creator@creators.example', now(), '{}');
insert into qa values ('owner', 'e9000000-0000-4000-8000-000000000001'),
  ('kma_operations', 'e9000000-0000-4000-8000-000000000011'), ('creator', 'e9000000-0000-4000-8000-000000000021');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_operations'), 'operations');
insert into public.affiliates(id, public_name, slug, status) values
  ('ea000000-0000-4000-8000-000000000001', 'Cleo Creator', 'e2e-creator', 'active');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at) values
  ('ea000000-0000-4000-8000-000000000001', pg_temp.q('creator'), 'owner', true, false, now());
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true;
select pg_temp.sign_in('owner');
insert into qa select 'workspace', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
with business as (
  insert into public.merchant_businesses(business_name, email, created_by, workspace_id)
  values ('Lingo Ltd', 'billing@lingo.example', pg_temp.q('owner'), pg_temp.q('workspace')) returning id)
insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status, business_name,
  country, charges_enabled, details_submitted, confirmed_at, verified_at)
select id, 'acct_KMAPlatform', true, 'acct_LingoCreators', 'active', 'Lingo Ltd', 'GB', true, true, now(), now() from business;

-- The merchant publishes, KissMyApps approves ------------------------------------------------
select pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('workspace'),
  '{"name":"Lingo","category":"education","tagline":"Learn a language in ten minutes a day.",
    "landing_url":"https://lingo-app.io/start","commission_type":"percent","commission_rate_bps":3000,
    "commission_duration":"months","commission_months":12}'::jsonb));
select pg_temp.call('owner', format('select public.workspace_program_mark_agreement_read(%L, %L)', pg_temp.q('workspace'),
  pg_temp.call('owner', format('select public.workspace_program_agreement(%L)', pg_temp.q('workspace')))->>'sha256'));
select pg_temp.call('owner', format('select public.workspace_program_submit(%L, %s)', pg_temp.q('workspace'), (pg_temp.program()).revision));
select pg_temp.call('kma_operations', format('select public.review_admin_program(%L)',
  jsonb_build_object('program_id', (pg_temp.program()).id, 'decision', 'approve', 'note', null)));
select pg_temp.check((pg_temp.program()).status = 'live', 'the program is live after approval');

-- The public marketplace, as the edge function reads it ---------------------------------------
select pg_temp.check(
  (select m->'programs'->0->>'slug' = (pg_temp.program()).slug and m->'programs'->0->>'commission_rate_bps' = '3000'
    from pg_temp.service('select public.marketplace_programs()') m),
  'the live program is listed in the public marketplace with its published commission');

-- The creator reads the agreement, accepts and gets a link --------------------------------------
insert into qa select 'shown', pg_temp.call('creator',
  format('select public.partner_program_detail(%L)', (pg_temp.program()).slug))::text;
select pg_temp.check(
  (select d->'program'->'agreement'->>'title' = 'Lingo Affiliate Agreement' and d->'membership' = 'null'::jsonb
      and d->>'accept_name' = 'Cleo Creator'
    from (select pg_temp.t('shown')::jsonb as d) x),
  'a signed-in creator is shown the agreement and the name they accept under');
insert into qa select 'joined', pg_temp.call('creator', format('select public.partner_program_join(%L)',
  jsonb_build_object('slug', d->'program'->>'slug', 'terms_version', d->'program'->'terms_version',
    'agreement_sha256', d->'program'->>'agreement_sha256')))::text
from (select pg_temp.t('shown')::jsonb as d) x;
insert into qa select 'link_url', pg_temp.t('joined')::jsonb->'membership'->'link'->>'url';
select pg_temp.check(
  (select j->'membership'->>'status' = 'active' and (j->'membership'->'link'->>'working')::boolean
      and j->'membership'->'link'->>'url' like 'https://go.kissmyapps.dev/r/e2e-creator/%'
    from (select pg_temp.t('joined')::jsonb as j) x),
  'accepting gives the creator an active membership and a working link at once');
select pg_temp.check(
  (select count(*) = 1 from public.affiliate_program_acceptances a
    where a.agreement_sha256 = pg_temp.t('shown')::jsonb->'program'->>'agreement_sha256'
      and a.accepted_by = pg_temp.q('creator') and a.accepted_name = 'Cleo Creator'),
  'the acceptance of exactly that agreement text is on record');

-- A visitor clicks the link; the buyer pays with the tag ----------------------------------------
insert into qa select 'click', pg_temp.click()::text;
select pg_temp.check(
  (select c->>'click_id' ~ '^[A-Za-z0-9_-]{16,128}$' and c->>'destination_url' = 'https://lingo-app.io/start'
    from (select pg_temp.t('click')::jsonb as c) x),
  'a click on the link is recorded and returns the click id that travels to the landing page');
select pg_temp.check(
  public.record_merchant_payment_event(jsonb_build_object(
    'platform_account_id', 'acct_KMAPlatform', 'livemode', true, 'account_id', 'acct_LingoCreators',
    'event_id', 'evt_e2e_creator', 'event_type', 'payment_intent.succeeded',
    'event_created', extract(epoch from clock_timestamp())::bigint + 2,
    'object_id', 'pi_e2ecreator', 'payment_intent_id', 'pi_e2ecreator', 'amount_minor', 4900, 'currency', 'usd',
    'kma_click', pg_temp.t('click')::jsonb->>'click_id', 'tag_source', 'metadata', 'payload_sha256', repeat('a', 64)))
    @> '{"matched":true,"duplicate":false}',
  'the webhook stores the receipt of the tagged payment');
create temporary table claimed as
  select r->>'event_id' as event_id, r->>'lease_token' as lease_token
  from jsonb_array_elements(public.claim_program_sale_receipts(
    '{"platform_account_id":"acct_KMAPlatform","limit":10,"lease_seconds":120}')->'receipts') r;
select pg_temp.check(
  public.record_program_sale(jsonb_build_object(
    'platform_account_id', 'acct_KMAPlatform', 'event_id', 'evt_e2e_creator',
    'lease_token', (select lease_token from claimed where event_id = 'evt_e2e_creator'),
    'livemode', true, 'payment_intent_id', 'pi_e2ecreator', 'charge_id', 'ch_e2ecreator',
    'amount_minor', 4900, 'currency', 'usd', 'refunded_minor', 0,
    'paid_at', extract(epoch from clock_timestamp())::bigint,
    'kma_click', pg_temp.t('click')::jsonb->>'click_id', 'tag_source', 'metadata')) @> '{"recorded":true,"created":true}',
  'the verified payment becomes a sale');
select pg_temp.check(
  (select count(*) = 1 and bool_and(s.affiliate_id = 'ea000000-0000-4000-8000-000000000001' and s.match_source = 'metadata'
      and s.program_id = (pg_temp.program()).id)
    from public.program_sales s where s.account_id = 'acct_LingoCreators'),
  'the sale is credited to the creator whose link was clicked');

-- The merchant sees the creator, one click and one sale -----------------------------------------
select pg_temp.check(
  (select c->'counts' = '{"pending":0,"active":1,"ended":0}'::jsonb and c->'creators'->0->>'name' = 'Cleo Creator'
      and c->'creators'->0->>'clicks' = '1' and c->'creators'->0->>'sales' = '1'
      and c->'creators'->0->>'last_click_at' is not null and c::text not ilike '%creators.example%'
    from pg_temp.creators() c),
  'the merchant sees the creator with one click and one sale, and no email address');

-- Pausing: the link still opens the page but nothing is credited --------------------------------
select pg_temp.call('owner', format('select public.workspace_program_set_status(%L, %L, %s)', pg_temp.q('workspace'), 'paused',
  (pg_temp.program()).revision));
select pg_temp.check(
  (select c->'click_id' = 'null'::jsonb and c->>'destination_url' = 'https://lingo-app.io/start' from pg_temp.click() c),
  'while the program is paused the link opens the landing page without a click id');
select pg_temp.check(
  (select m->'memberships'->0->>'program_status' = 'paused' and not (m->'memberships'->0->'link'->>'working')::boolean
    from pg_temp.call('creator', 'select public.partner_marketplace()') m)
  and (select c->'creators'->0->>'clicks' = '1' from pg_temp.creators() c),
  'the creator is told the link is not being credited, and no click was added');
select pg_temp.call('owner', format('select public.workspace_program_set_status(%L, %L, %s)', pg_temp.q('workspace'), 'live',
  (pg_temp.program()).revision));
select pg_temp.check(
  (select c->>'click_id' is not null from pg_temp.click() c)
  and (select c->'creators'->0->>'clicks' = '2' from pg_temp.creators() c),
  'resuming the program makes the same link count clicks again');

-- The merchant removes the creator --------------------------------------------------------------
select pg_temp.call('owner', format('select public.workspace_program_creator_decide(%L, %L)', pg_temp.q('workspace'),
  jsonb_build_object('member_id', (select id from public.affiliate_program_members), 'action', 'remove', 'note', 'Thanks for your help.')));
select pg_temp.check(
  (select c->'click_id' = 'null'::jsonb from pg_temp.click() c)
  and (select m->'memberships'->0->>'status' = 'removed' and m->'memberships'->0->>'decision_note' = 'Thanks for your help.'
    from pg_temp.call('creator', 'select public.partner_marketplace()') m),
  'a removed creator sees the note, and their link no longer credits them');
select set_config('request.jwt.claims', '', true);

select 'ok ' || count(*) || ' program creator end to end assertions' from e2e_assertions;
rollback;
