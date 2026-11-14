-- Provider-free test of a workspace's affiliate program: the merchant saves one form,
-- reads the generated agreement and publishes; KissMyApps reviews the first listing; an
-- approved program gets its product, default funnel and terms version 1; later term
-- changes publish without review. Stripe is never called: connections are fixture rows.
begin;
set local time zone 'UTC';
create temporary table program_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Affiliate program assertion failed: %', label; end if;
  insert into program_assertions values (label);
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$
  select value::uuid from qa where key = k
$$;
-- Signs in. KissMyApps staff (kma_...) get a password session, as the admin app gives them.
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
-- 'ok', or the SQLSTATE and the one-word code the console maps to a message.
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
-- The merchant functions, by the workspace's short name.
create function pg_temp.sql(fn text, workspace text, variadic args text[] default '{}') returns text language sql as $$
  select format('select public.%I(%L%s)', fn, pg_temp.q(workspace),
    (select coalesce(string_agg(', ' || a, '' order by n), '') from unnest(args) with ordinality x(a, n)))
$$;
create function pg_temp.program(workspace text) returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q(workspace) and status <> 'archived'
$$;
create function pg_temp.rev(workspace text) returns integer language sql as $$
  select (pg_temp.program(workspace)).revision
$$;
create function pg_temp.state(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, pg_temp.sql('workspace_program_get', workspace))
$$;
-- Save with the revision the caller last saw.
create function pg_temp.save_sql(workspace text, input jsonb) returns text language sql as $$
  select pg_temp.sql('workspace_program_save', workspace,
    quote_literal(input || jsonb_build_object('revision', pg_temp.rev(workspace))) || '::jsonb')
$$;
create function pg_temp.save(who text, workspace text, input jsonb) returns jsonb language sql as $$
  select pg_temp.call(who, pg_temp.save_sql(workspace, input))
$$;
create function pg_temp.save_fails(who text, workspace text, input jsonb) returns text language sql as $$
  select pg_temp.try(who, pg_temp.save_sql(workspace, input))
$$;
create function pg_temp.agreement(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, pg_temp.sql('workspace_program_agreement', workspace))
$$;
-- Open the agreement and press "I have read this".
create function pg_temp.read(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, pg_temp.sql('workspace_program_mark_agreement_read', workspace,
    quote_literal(pg_temp.agreement(who, workspace)->>'sha256')))
$$;
create function pg_temp.submit_sql(workspace text) returns text language sql as $$
  select pg_temp.sql('workspace_program_submit', workspace, pg_temp.rev(workspace)::text)
$$;
create function pg_temp.status_sql(workspace text, status text) returns text language sql as $$
  select pg_temp.sql('workspace_program_set_status', workspace, quote_literal(status), pg_temp.rev(workspace)::text)
$$;
create function pg_temp.review_sql(fn text, workspace text, input jsonb) returns text language sql as $$
  select format('select public.%I(%L)', fn, jsonb_build_object('program_id', (pg_temp.program(workspace)).id) || input)
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
create function pg_temp.set_connection(workspace text, new_status text) returns void language sql as $$
  update public.merchant_connections c set status = new_status
  from public.merchant_businesses b where b.id = c.merchant_id and b.workspace_id = pg_temp.q(workspace) and c.livemode
$$;
create function pg_temp.audits(workspace text, action_name text) returns bigint language sql as $$
  select count(*) from public.audit_logs
  where action = action_name and target_table = 'affiliate_programs' and target_id = (pg_temp.program(workspace)).id
$$;
create function pg_temp.terms(overrides jsonb default '{}') returns jsonb language sql as $$
  select '{"program_name":"SpeakSix","brand_name":"SpeakSix Ltd","landing_url":"https://speaksix.com/start",
    "commission_type":"percent","commission_rate_bps":3000,"commission_fixed_minor":null,"currency":"USD",
    "commission_duration":"months","commission_months":12,"attribution_window_days":30,"hold_days":30,
    "minimum_payout_minor":2000,"approval_mode":"automatic","extra_terms":null,
    "earn_from":"sales","rewards":[]}'::jsonb || overrides
$$;
create function pg_temp.doc(overrides jsonb default '{}') returns jsonb language sql as $$
  select kma_internal.program_agreement(pg_temp.terms(overrides))
$$;
create function pg_temp.sha(document jsonb) returns text language sql as $$
  select encode(sha256(convert_to(document::text, 'utf8')), 'hex')
$$;
grant all on qa, program_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;
-- The storage API works as the signed-in user, under row security.
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated;

insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('d2000000-0000-4000-8000-000000000001', 'owner@speaksix.com', now(), '{"company":"SpeakSix"}'),
  ('d2000000-0000-4000-8000-000000000002', 'admin@speaksix.com', now(), '{}'),
  ('d2000000-0000-4000-8000-000000000003', 'developer@speaksix.com', now(), '{}'),
  ('d2000000-0000-4000-8000-000000000004', 'analyst@speaksix.com', now(), '{}'),
  ('d2000000-0000-4000-8000-000000000005', 'owner@rival.co', now(), '{"company":"Rival"}'),
  ('d2000000-0000-4000-8000-000000000006', 'owner@third.co', now(), '{"company":"Third"}'),
  ('d2000000-0000-4000-8000-000000000007', 'stranger@elsewhere.co', now(), '{}'),
  ('d2000000-0000-4000-8000-000000000011', 'owner@kissmyapps.dev', now(), '{}'),
  ('d2000000-0000-4000-8000-000000000012', 'operations@kissmyapps.dev', now(), '{}'),
  ('d2000000-0000-4000-8000-000000000013', 'support@kissmyapps.dev', now(), '{}');
insert into qa values
  ('owner', 'd2000000-0000-4000-8000-000000000001'), ('admin', 'd2000000-0000-4000-8000-000000000002'),
  ('developer', 'd2000000-0000-4000-8000-000000000003'), ('analyst', 'd2000000-0000-4000-8000-000000000004'),
  ('rival_owner', 'd2000000-0000-4000-8000-000000000005'), ('third_owner', 'd2000000-0000-4000-8000-000000000006'),
  ('stranger', 'd2000000-0000-4000-8000-000000000007'),
  ('kma_owner', 'd2000000-0000-4000-8000-000000000011'), ('kma_operations', 'd2000000-0000-4000-8000-000000000012'),
  ('kma_support', 'd2000000-0000-4000-8000-000000000013'),
  -- A KissMyApps owner whose session did not use a password.
  ('passwordless_owner', 'd2000000-0000-4000-8000-000000000011');
insert into public.admin_users(user_id, role) values
  (pg_temp.q('kma_owner'), 'owner'), (pg_temp.q('kma_operations'), 'operations'), (pg_temp.q('kma_support'), 'support');

-- Workspaces: SpeakSix with every role, and two others with only an owner ------------------------
select pg_temp.sign_in('owner');
insert into qa select 'acme', public.analytics_bootstrap()->'workspaces'->0->>'id';
select public.analytics_invite_member(pg_temp.q('acme'), 'admin@speaksix.com', 'admin');
select public.analytics_invite_member(pg_temp.q('acme'), 'developer@speaksix.com', 'developer');
select public.analytics_invite_member(pg_temp.q('acme'), 'analyst@speaksix.com', 'analyst');
select pg_temp.sign_in('admin');
select public.analytics_bootstrap();
select pg_temp.sign_in('developer');
select public.analytics_bootstrap();
select pg_temp.sign_in('analyst');
select public.analytics_bootstrap();
select pg_temp.sign_in('rival_owner');
insert into qa select 'rival', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('third_owner');
insert into qa select 'third', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select count(*) = 4 from public.analytics_workspace_members where workspace_id = pg_temp.q('acme')),
  'the workspace has an owner, an admin, a developer and an analyst');

-- Closed by default ----------------------------------------------------------------------------
select pg_temp.check((select bool_and(not has_table_privilege(r, t, p))
  from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['public.affiliate_programs', 'public.affiliate_program_terms']) t,
    unnest(array['select', 'insert', 'update', 'delete']) p)
  and (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.affiliate_programs'::regclass, 'public.affiliate_program_terms'::regclass)),
  'no API role can read or write the program tables, and row security is on');
select pg_temp.check((select count(*) = 10 and bool_and(has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute')
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('workspace_program_get', 'workspace_program_agreement', 'workspace_program_save',
    'workspace_program_mark_agreement_read', 'workspace_program_submit', 'workspace_program_set_status',
    'list_admin_program_reviews', 'review_admin_program', 'set_admin_program_status', 'can_manage_program_logo')),
  'signed-in users may call the ten functions; each is a security definer function with an empty search path');
select pg_temp.check((select count(*) >= 20 and bool_and(not has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'kma_internal' and (p.proname like 'program\_%' or p.proname = 'pause_programs_on_stripe_disconnect')),
  'the internal helpers are closed to every API role');
select pg_temp.check(pg_temp.try_signed_out('authenticated', pg_temp.sql('workspace_program_get', 'acme')) = '42501'
  and pg_temp.try_signed_out('authenticated', pg_temp.sql('workspace_program_save', 'acme', '''{"name":"SpeakSix"}''::jsonb')) = '42501'
  and pg_temp.try_signed_out('authenticated', 'select public.list_admin_program_reviews()') = '28000'
  and pg_temp.try_signed_out('anon', pg_temp.sql('workspace_program_get', 'acme')) = '42501'
  and pg_temp.try_signed_out('service_role', pg_temp.sql('workspace_program_get', 'acme')) = '42501'
  and pg_temp.try_signed_out('authenticated', 'select kma_internal.program_agreement(''{}'')') = '42501',
  'signed-out, anonymous and service-role calls are refused');

-- Logos ------------------------------------------------------------------------------------------
select pg_temp.check((select public and file_size_limit = 2097152
    and allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'] from storage.buckets where id = 'program-logos'),
  'logos live in a public bucket that takes PNG, JPEG and WebP up to 2 MB');
select pg_temp.check(pg_temp.try('owner', format(
    'insert into storage.objects(id, bucket_id, name) values (gen_random_uuid(), ''program-logos'', %L) returning ''{}''::jsonb',
    pg_temp.q('acme') || '/logo.png')) = 'ok'
  and pg_temp.try('admin', format(
    'insert into storage.objects(id, bucket_id, name) values (gen_random_uuid(), ''program-logos'', %L) returning ''{}''::jsonb',
    pg_temp.q('acme') || '/logo-2.webp')) = 'ok', 'an owner and an admin can upload into their workspace''s folder');
select pg_temp.check(pg_temp.try(u, format(
    'insert into storage.objects(id, bucket_id, name) values (gen_random_uuid(), ''program-logos'', %L) returning ''{}''::jsonb',
    pg_temp.q('acme') || '/nope.png')) like '42501%', format('%s cannot upload into the workspace''s folder', u))
from unnest(array['developer', 'analyst', 'rival_owner', 'stranger']) u;
select pg_temp.check(pg_temp.try('owner', 'insert into storage.objects(id, bucket_id, name) values '
    || '(gen_random_uuid(), ''program-logos'', ''logo.png'') returning ''{}''::jsonb') like '42501%'
  and pg_temp.try('owner', 'insert into storage.objects(id, bucket_id, name) values '
    || '(gen_random_uuid(), ''program-logos'', ''not-a-workspace/logo.png'') returning ''{}''::jsonb') like '42501%'
  and pg_temp.try('owner', format(
    'insert into storage.objects(id, bucket_id, name) values (gen_random_uuid(), ''affiliate-private-documents'', %L) returning ''{}''::jsonb',
    pg_temp.q('acme') || '/logo.png')) like '42501%',
  'an upload outside a workspace folder, or into another bucket, is refused');
select pg_temp.check(
  pg_temp.call('developer', format('with gone as (delete from storage.objects where name = %L returning 1) '
    || 'select to_jsonb(count(*)) from gone', pg_temp.q('acme') || '/logo-2.webp')) = '0'
  and pg_temp.call('rival_owner', format('with changed as (update storage.objects set version = ''2'' where name = %L returning 1) '
    || 'select to_jsonb(count(*)) from changed', pg_temp.q('acme') || '/logo-2.webp')) = '0'
  and pg_temp.call('owner', format('with changed as (update storage.objects set version = ''2'' where name = %L returning 1) '
    || 'select to_jsonb(count(*)) from changed', pg_temp.q('acme') || '/logo-2.webp')) = '1'
  and pg_temp.call('admin', format('with gone as (delete from storage.objects where name = %L returning 1) '
    || 'select to_jsonb(count(*)) from gone', pg_temp.q('acme') || '/logo-2.webp')) = '1',
  'only an owner or admin can replace or delete a logo');
insert into storage.objects(id, bucket_id, name) values
  (gen_random_uuid(), 'program-logos', pg_temp.q('rival') || '/logo.png'),
  (gen_random_uuid(), 'affiliate-private-documents', pg_temp.q('acme') || '/private.png');

-- Before there is a program ------------------------------------------------------------------------
select pg_temp.check(pg_temp.try('owner', 'select public.workspace_program_get(null)') like 'P0002%'
  and pg_temp.try('stranger', pg_temp.sql('workspace_program_get', 'acme')) like 'P0002%'
  and pg_temp.try('rival_owner', pg_temp.sql('workspace_program_agreement', 'acme')) like 'P0002%'
  and pg_temp.try('rival_owner', pg_temp.sql('workspace_program_save', 'acme', '''{"name":"Mine"}''::jsonb')) like 'P0002%',
  'people outside the workspace cannot see or change its program');
select pg_temp.check(pg_temp.state('owner', 'acme') = '{"can_manage":true,"stripe_connected":false,"stripe_charges_enabled":false,"brand_name":null,"events_available":false,"app_links_available":false,"program":null,
    "checklist":{"stripe_connected":false,"details":false,"landing_page":false,"commission":false,"agreement_read":false},
    "can_submit":false}'::jsonb, 'a workspace with no program gets an empty state');
select pg_temp.check((pg_temp.state('analyst', 'acme')->>'can_manage')::boolean = false
  and (pg_temp.state('developer', 'acme')->>'can_manage')::boolean = false
  and (pg_temp.state('admin', 'acme')->>'can_manage')::boolean, 'every member can read; only owners and admins can manage');
select pg_temp.check(pg_temp.agreement('analyst', 'acme') = '{"agreement":null,"sha256":null,"complete":false}'::jsonb,
  'there is no agreement before there is a program');
select pg_temp.check(pg_temp.try(u, pg_temp.sql('workspace_program_save', 'acme', '''{"name":"SpeakSix"}''::jsonb')) like '42501%'
  and pg_temp.try(u, pg_temp.sql('workspace_program_mark_agreement_read', 'acme', quote_literal(repeat('a', 64)))) like '42501%'
  and pg_temp.try(u, pg_temp.sql('workspace_program_submit', 'acme', '1')) like '42501%'
  and pg_temp.try(u, pg_temp.sql('workspace_program_set_status', 'acme', '''paused''', '1')) like '42501%',
  format('a %s cannot change the program', u))
from unnest(array['developer', 'analyst']) u;
select pg_temp.check(pg_temp.try('owner', pg_temp.sql('workspace_program_submit', 'acme', '1')) = '22023 program_incomplete'
  and pg_temp.try('owner', pg_temp.sql('workspace_program_mark_agreement_read', 'acme', quote_literal(repeat('a', 64))))
    = '22023 program_incomplete'
  and pg_temp.try('owner', pg_temp.sql('workspace_program_set_status', 'acme', '''paused''', '1')) = '22023 status_not_allowed',
  'nothing can be published, read or paused before the first save');
select pg_temp.check((select count(*) = 0 from public.affiliate_programs), 'refused calls create nothing');

-- The first save creates the draft ---------------------------------------------------------------
select pg_temp.check(pg_temp.try('owner', pg_temp.sql('workspace_program_save', 'acme', '''[]''::jsonb')) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sql('workspace_program_save', 'acme', 'null')) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sql('workspace_program_save', 'acme', '''{"name":"SpeakSix","status":"live"}''::jsonb'))
    = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.sql('workspace_program_save', 'acme', '''{"name":"SpeakSix","slug":"mine"}''::jsonb'))
    = '22023 invalid_input', 'the form takes only its own fields');
select pg_temp.check(pg_temp.try('owner', pg_temp.sql('workspace_program_save', 'acme', '''{"name":"SpeakSix","hold_days":900}''::jsonb'))
    = '22023 invalid_hold_days' and (select count(*) = 0 from public.affiliate_programs)
  and (select count(*) = 0 from public.audit_logs where target_table = 'affiliate_programs'),
  'a first save with a wrong field leaves no draft behind');
select pg_temp.check(
  (pg_temp.call('owner', pg_temp.sql('workspace_program_save', 'acme', '''{"name":"  SpeakSix  "}''::jsonb'))->'program')
    - 'id' - 'updated_at'
  = '{"revision":1,"status":"draft","pause_reason":null,"review_note":null,"slug":"speaksix","name":"SpeakSix","category":null,
    "tagline":null,"logo_path":null,"landing_url":null,"commission_type":null,"commission_rate_bps":null,
    "commission_fixed_minor":null,"currency":"USD","commission_duration":null,"commission_months":null,
    "attribution_window_days":30,"hold_days":30,"minimum_payout_minor":2000,"approval_mode":"automatic",
    "marketplace_listed":true,"extra_terms":null,"agreement_read":false,"has_unpublished_changes":false,
    "live_terms_version":null,"submitted_at":null,"first_published_at":null,
    "earn_from":"sales","rewards":[],"reward_budget_minor":null,"app_link":null,
    "payment_mode":"own_checkout","checkout":null,"buyer_discount_bps":null,
    "promo_codes":null}'::jsonb,
  'the first save creates a draft with the form''s defaults and an address made from the name');
select pg_temp.check((select p.created_by = pg_temp.q('owner') and p.updated_by = pg_temp.q('owner') and p.payment_mode = 'own_checkout'
    from pg_temp.program('acme') p) and pg_temp.audits('acme', 'affiliate_program_created') = 1,
  'the draft names who made it, and the audit log has it');
select pg_temp.check(pg_temp.try('admin', pg_temp.sql('workspace_program_save', 'acme', '''{"name":"Again"}''::jsonb')) = '40001 program_changed'
  and pg_temp.try('admin', pg_temp.sql('workspace_program_save', 'acme', '''{"name":"Again","revision":null}''::jsonb')) = '40001 program_changed'
  and pg_temp.try('admin', pg_temp.sql('workspace_program_save', 'acme', '''{"name":"Again","revision":7}''::jsonb')) = '40001 program_changed'
  and pg_temp.try('admin', pg_temp.sql('workspace_program_save', 'acme', '''{"name":"Again","revision":"1"}''::jsonb')) = '22023 invalid_revision'
  and pg_temp.try('admin', pg_temp.sql('workspace_program_save', 'acme', '''{"name":"Again","revision":1.5}''::jsonb')) = '22023 invalid_revision',
  'once a program exists a save must carry the revision it was made from');
select pg_temp.check((select count(*) = 1 from public.affiliate_programs where workspace_id = pg_temp.q('acme'))
  and pg_temp.rev('acme') = 1 and (pg_temp.program('acme')).name = 'SpeakSix', 'a refused save changes nothing and makes no second program');
do $$
begin
  insert into public.affiliate_programs(workspace_id, slug, created_by)
  values (pg_temp.q('acme'), 'second-program', pg_temp.q('owner'));
  raise exception 'a second program was accepted';
exception when unique_violation then
  perform pg_temp.check(true, 'a workspace has one program: the table refuses a second');
end $$;

-- Every field is checked ---------------------------------------------------------------------------
select pg_temp.check(pg_temp.save_fails('owner', 'acme', v.input) = '22023 ' || v.code, format('%s is refused as %s', left(v.input::text, 60), v.code))
from (values
  ('{"name":5}'::jsonb, 'invalid_name'),
  (jsonb_build_object('name', repeat('x', 121)), 'invalid_name'),
  (jsonb_build_object('name', E'Speak\nSix'), 'invalid_name'),
  ('{"category":"crypto"}', 'invalid_category'),
  ('{"category":7}', 'invalid_category'),
  (jsonb_build_object('tagline', repeat('x', 161)), 'invalid_tagline'),
  ('{"tagline":true}', 'invalid_tagline'),
  ('{"logo_path":"logo.png"}', 'invalid_logo_path'),
  (jsonb_build_object('logo_path', pg_temp.q('acme') || '/'), 'invalid_logo_path'),
  (jsonb_build_object('logo_path', pg_temp.q('acme') || '/missing.png'), 'invalid_logo_path'),
  (jsonb_build_object('logo_path', pg_temp.q('acme') || '/private.png'), 'invalid_logo_path'),
  (jsonb_build_object('logo_path', pg_temp.q('rival') || '/logo.png'), 'invalid_logo_path'),
  ('{"landing_url":"http://speaksix.com/start"}', 'invalid_landing_url'),
  ('{"landing_url":"https://localhost/start"}', 'invalid_landing_url'),
  ('{"landing_url":"https://speaksix.example/start"}', 'invalid_landing_url'),
  ('{"landing_url":"https://speaksix.com/start#top"}', 'invalid_landing_url'),
  ('{"landing_url":"speaksix.com"}', 'invalid_landing_url'),
  ('{"landing_url":42}', 'invalid_landing_url'),
  ('{"commission_type":"tiered"}', 'invalid_commission_type'),
  ('{"commission_type":"percent","commission_rate_bps":0}', 'invalid_commission_rate_bps'),
  ('{"commission_type":"percent","commission_rate_bps":10001}', 'invalid_commission_rate_bps'),
  ('{"commission_type":"percent","commission_rate_bps":30.5}', 'invalid_commission_rate_bps'),
  ('{"commission_type":"percent","commission_rate_bps":"3000"}', 'invalid_commission_rate_bps'),
  ('{"commission_type":"fixed","commission_fixed_minor":0}', 'invalid_commission_fixed_minor'),
  ('{"commission_type":"fixed","commission_fixed_minor":100000001}', 'invalid_commission_fixed_minor'),
  ('{"commission_type":"fixed","commission_fixed_minor":"20.00"}', 'invalid_commission_fixed_minor'),
  ('{"currency":"usd"}', 'invalid_currency'),
  ('{"currency":"US"}', 'invalid_currency'),
  ('{"currency":"EURO"}', 'invalid_currency'),
  ('{"currency":"JPY"}', 'invalid_currency'),
  ('{"currency":"KWD"}', 'invalid_currency'),
  ('{"currency":840}', 'invalid_currency'),
  -- Programs pay creators in US dollars for now (20261122104000_program_refund_recovery.sql).
  ('{"currency":"EUR"}', 'invalid_input'),
  ('{"currency":"GBP"}', 'invalid_input'),
  ('{"commission_duration":"forever"}', 'invalid_commission_duration'),
  ('{"commission_duration":"months"}', 'invalid_commission_months'),
  ('{"commission_duration":"months","commission_months":0}', 'invalid_commission_months'),
  ('{"commission_duration":"months","commission_months":37}', 'invalid_commission_months'),
  ('{"commission_duration":"months","commission_months":"12"}', 'invalid_commission_months'),
  ('{"attribution_window_days":0}', 'invalid_attribution_window_days'),
  ('{"attribution_window_days":366}', 'invalid_attribution_window_days'),
  ('{"hold_days":-1}', 'invalid_hold_days'),
  ('{"hold_days":91}', 'invalid_hold_days'),
  ('{"minimum_payout_minor":-1}', 'invalid_minimum_payout_minor'),
  ('{"minimum_payout_minor":100000001}', 'invalid_minimum_payout_minor'),
  ('{"minimum_payout_minor":20.5}', 'invalid_minimum_payout_minor'),
  ('{"approval_mode":"invite_only"}', 'invalid_approval_mode'),
  ('{"marketplace_listed":"yes"}', 'invalid_marketplace_listed'),
  (jsonb_build_object('extra_terms', repeat('x', 4001)), 'invalid_extra_terms'),
  ('{"extra_terms":["no"]}', 'invalid_extra_terms')) v(input, code);
select pg_temp.check(pg_temp.rev('acme') = 1 and pg_temp.audits('acme', 'affiliate_program_saved') = 0,
  'none of the refused saves touched the draft');

-- Saving part of the form ---------------------------------------------------------------------------
select pg_temp.save('owner', 'acme', jsonb_build_object('category', 'education', 'tagline', ' Speak English with confidence in six weeks. ',
  'logo_path', pg_temp.q('acme') || '/logo.png', 'extra_terms', E'No coupon sites.\n  Keep it friendly.\n'));
select pg_temp.check((select p.revision = 2 and p.name = 'SpeakSix' and p.category = 'education'
    and p.tagline = 'Speak English with confidence in six weeks.' and p.logo_path = pg_temp.q('acme') || '/logo.png'
    and p.extra_terms = E'No coupon sites.\n  Keep it friendly.\n' from pg_temp.program('acme') p),
  'a save changes the fields it carries and leaves the rest; one-line fields are trimmed, extra terms are kept as typed');
select pg_temp.check((select a.actor_user_id = pg_temp.q('owner') and a.actor_type = 'system'
    and a.before_data = jsonb_build_object('category', null, 'tagline', null, 'logo_path', null, 'extra_terms', null,
      'revision', 1, 'updated_at', a.before_data->'updated_at')
    and a.after_data - 'updated_at' = jsonb_build_object('category', 'education',
      'tagline', 'Speak English with confidence in six weeks.', 'logo_path', pg_temp.q('acme') || '/logo.png',
      'extra_terms', E'No coupon sites.\n  Keep it friendly.\n', 'revision', 2)
    from public.audit_logs a where a.action = 'affiliate_program_saved' and a.target_id = (pg_temp.program('acme')).id),
  'the audit log keeps what changed, before and after, and who changed it');
select pg_temp.save('admin', 'acme', '{"tagline":null,"extra_terms":"   ","logo_path":""}');
select pg_temp.check((select p.revision = 3 and p.tagline is null and p.extra_terms is null and p.logo_path is null
    and p.category = 'education' and p.updated_by = pg_temp.q('admin') from pg_temp.program('acme') p),
  'null or blank clears a field; the save is stamped with who made it');
select pg_temp.save('owner', 'acme', '{"currency":"USD","attribution_window_days":60,"hold_days":0,"minimum_payout_minor":0,
  "approval_mode":"manual","marketplace_listed":false}');
select pg_temp.check((select p.currency = 'USD' and p.attribution_window_days = 60 and p.hold_days = 0 and p.minimum_payout_minor = 0
    and p.approval_mode = 'manual' and not p.marketplace_listed from pg_temp.program('acme') p), 'the options are saved');
select pg_temp.save('owner', 'acme', '{"currency":null,"attribution_window_days":null,"hold_days":null,"minimum_payout_minor":null,
  "approval_mode":null,"marketplace_listed":null}');
select pg_temp.check((select p.currency = 'USD' and p.attribution_window_days = 30 and p.hold_days = 30 and p.minimum_payout_minor = 2000
    and p.approval_mode = 'automatic' and p.marketplace_listed from pg_temp.program('acme') p),
  'clearing an option puts back its default');

-- Commission shape -----------------------------------------------------------------------------------
select pg_temp.save('owner', 'acme', '{"commission_type":"fixed"}');
select pg_temp.check((select p.commission_type is null and p.commission_fixed_minor is null from pg_temp.program('acme') p),
  'in a draft a commission type with no amount is not kept');
select pg_temp.save('owner', 'acme', '{"commission_type":"percent","commission_rate_bps":3000,"commission_duration":"months","commission_months":12}');
select pg_temp.check((select p.commission_type = 'percent' and p.commission_rate_bps = 3000 and p.commission_fixed_minor is null
    and p.commission_duration = 'months' and p.commission_months = 12 from pg_temp.program('acme') p), 'a percent commission for 12 months is saved');
select pg_temp.save('owner', 'acme', '{"commission_type":"fixed","commission_fixed_minor":2000,"commission_duration":"lifetime"}');
select pg_temp.check((select p.commission_type = 'fixed' and p.commission_fixed_minor = 2000 and p.commission_rate_bps is null
    and p.commission_duration = 'lifetime' and p.commission_months is null from pg_temp.program('acme') p),
  'switching to a fixed amount drops the percent, and a duration other than months drops the month count');
select pg_temp.save('owner', 'acme', '{"commission_rate_bps":2500,"commission_months":6}');
select pg_temp.check((select p.commission_type = 'fixed' and p.commission_rate_bps is null and p.commission_months is null
    from pg_temp.program('acme') p), 'an amount or month count that does not belong to the chosen commission is not kept');
select pg_temp.save('owner', 'acme', '{"commission_type":"percent","commission_rate_bps":3000,"commission_duration":"months","commission_months":12}');
select pg_temp.check((select p.commission_type = 'percent' and p.commission_rate_bps = 3000 and p.commission_fixed_minor is null
    and p.commission_months = 12 from pg_temp.program('acme') p), 'switching back to percent drops the fixed amount');

-- The marketplace address follows the name until approval ----------------------------------------------
select pg_temp.call('rival_owner', pg_temp.sql('workspace_program_save', 'rival', '''{"name":"Speak Six!"}''::jsonb'));
select pg_temp.check((pg_temp.program('rival')).slug = 'speak-six', 'the address is the name in lower case, joined by hyphens');
select pg_temp.save('rival_owner', 'rival', '{"name":"SPEAKSIX"}');
select pg_temp.check((pg_temp.program('rival')).slug = 'speaksix-2', 'a taken address gets -2');
select pg_temp.save('rival_owner', 'rival', '{"name":"SpeakSix."}');
select pg_temp.check((pg_temp.program('rival')).slug = 'speaksix-2', 'a rename that gives the same address keeps it');
select pg_temp.call('third_owner', pg_temp.sql('workspace_program_save', 'third', '''{"tagline":"No name yet"}''::jsonb'));
select pg_temp.check((pg_temp.program('third')).slug = 'program' and (pg_temp.program('third')).name is null,
  'a draft with no name gets a placeholder address');
select pg_temp.save('third_owner', 'third', '{"name":"日本語"}');
select pg_temp.check((pg_temp.program('third')).slug = 'program', 'a name with no latin letters keeps the placeholder');
select pg_temp.save('third_owner', 'third', '{"name":"Q"}');
select pg_temp.check((pg_temp.program('third')).slug = 'program-q', 'a one-letter name still gives a valid address');
select pg_temp.save('third_owner', 'third', '{"name":"Rival Reader"}');
select pg_temp.save('rival_owner', 'rival', '{"name":"Rival Reader"}');
select pg_temp.check((pg_temp.program('third')).slug = 'rival-reader' and (pg_temp.program('rival')).slug = 'rival-reader-2',
  'before approval a rename moves the address');

-- The checklist and the agreement ------------------------------------------------------------------------
select pg_temp.check(pg_temp.state('owner', 'acme')->'checklist'
  = '{"stripe_connected":false,"details":false,"landing_page":false,"commission":true,"agreement_read":false}'::jsonb
  and (pg_temp.agreement('owner', 'acme')->>'complete')::boolean = false
  and pg_temp.try('owner', pg_temp.submit_sql('acme')) = '22023 program_incomplete',
  'without a description and a landing page the program is incomplete and has no agreement');
select pg_temp.save('owner', 'acme', '{"landing_url":"https://speaksix.com/start"}');
select pg_temp.check(pg_temp.state('owner', 'acme')->'checklist'
  = '{"stripe_connected":false,"details":false,"landing_page":true,"commission":true,"agreement_read":false}'::jsonb
  and (pg_temp.agreement('analyst', 'acme')->>'complete')::boolean
  and pg_temp.try('owner', pg_temp.submit_sql('acme')) = '22023 program_incomplete',
  'the agreement can be read once it has a name, a landing page and a commission; publishing also needs the card');
select pg_temp.save('owner', 'acme', '{"tagline":"Speak English with confidence in six weeks."}');
select pg_temp.check(pg_temp.state('owner', 'acme')->'checklist'
  = '{"stripe_connected":false,"details":true,"landing_page":true,"commission":true,"agreement_read":false}'::jsonb
  and (pg_temp.state('owner', 'acme')->>'can_submit')::boolean = false, 'the checklist follows the form');

select pg_temp.check((select a->>'sha256' ~ '^[a-f0-9]{64}$' and a->>'sha256' = pg_temp.sha(a->'agreement')
    and a = pg_temp.agreement('analyst', 'acme')
    and a->'agreement' = kma_internal.program_agreement((select kma_internal.program_terms(p) from pg_temp.program('acme') p))
  from pg_temp.agreement('owner', 'acme') a),
  'the agreement hash is the SHA-256 of the document, and the same form always gives the same document');
select pg_temp.check((select kma_internal.program_terms(p) = pg_temp.terms('{"brand_name":"SpeakSix"}') from pg_temp.program('acme') p),
  'the terms snapshot holds the commercial fields; without Stripe the brand is the program name');
select pg_temp.check((select d - 'sections' = '{"title":"SpeakSix Affiliate Agreement","brand_name":"SpeakSix Ltd","program_name":"SpeakSix",
    "summary":[{"label":"Commission","value":"30% of every payment for 12 months"},{"label":"Attribution window","value":"30 days"},
      {"label":"Hold before payout","value":"30 days"},{"label":"Minimum payout","value":"$20.00"}],"extra_terms":null}'::jsonb
    and jsonb_array_length(d->'sections') = 11
    and (select bool_and(s.value->>'heading' ~ ('^' || s.n || '\. \S') and jsonb_array_length(s.value->'paragraphs') between 1 and 4
        and (select bool_and(jsonb_typeof(x) = 'string' and length(x #>> '{}') between 20 and 400) from jsonb_array_elements(s.value->'paragraphs') x))
      from jsonb_array_elements(d->'sections') with ordinality s(value, n))
  from pg_temp.doc() d), 'the agreement has a title, four summary rows and eleven numbered sections of short paragraphs');
select pg_temp.check(pg_temp.doc()::text !~ '\d{4}-\d{2}-\d{2}' and pg_temp.doc()::text !~* 'logo_path|\.png'
  and pg_temp.doc() = pg_temp.doc() and pg_temp.sha(pg_temp.doc()) = kma_internal.program_agreement_sha256(pg_temp.doc())
  and pg_temp.sha(pg_temp.doc()) <> pg_temp.sha(pg_temp.doc('{"hold_days":31}'))
  and (select provolatile = 'i' from pg_proc where oid = 'kma_internal.program_agreement(jsonb)'::regprocedure),
  'the document carries no date and no logo, so its hash is stable; any change of terms changes it');
select pg_temp.check(d->'sections'->2->'paragraphs'->>0 = v.sentence and d->'summary'->0->>'value' = v.headline,
  format('commission wording: %s', v.headline))
from (values
  ('{"commission_duration":"first_payment","commission_months":null}'::jsonb, '30% of the first payment',
    'You earn 30% of the first payment from each customer whose sale is credited to you. Renewals and other later payments from that customer do not earn commission.'),
  ('{}', '30% of every payment for 12 months',
    'You earn 30% of every payment credited to you, for 12 months counted from the customer''s first payment. Payments after that do not earn commission.'),
  ('{"commission_duration":"lifetime","commission_months":null}', '30% of every payment',
    'You earn 30% of every payment credited to you, with no time limit.'),
  ('{"commission_type":"fixed","commission_rate_bps":null,"commission_fixed_minor":2000,"commission_duration":"first_payment","commission_months":null}',
    '$20.00 on the first payment',
    'You earn $20.00 for the first payment from each customer whose sale is credited to you. Renewals and other later payments from that customer do not earn commission.'),
  ('{"commission_type":"fixed","commission_rate_bps":null,"commission_fixed_minor":2000}', '$20.00 on every payment for 12 months',
    'You earn $20.00 for every payment credited to you, for 12 months counted from the customer''s first payment. Payments after that do not earn commission.'),
  ('{"commission_type":"fixed","commission_rate_bps":null,"commission_fixed_minor":2000,"commission_duration":"lifetime","commission_months":null}',
    '$20.00 on every payment', 'You earn $20.00 for every payment credited to you, with no time limit.')) v(overrides, headline, sentence),
  lateral pg_temp.doc(v.overrides) d;
select pg_temp.check(
  pg_temp.doc('{"commission_rate_bps":1250,"commission_months":1}')->'summary'->0->>'value' = '12.5% of every payment for 1 month'
  and pg_temp.doc('{"commission_rate_bps":105}')->'summary'->0->>'value' like '1.05% %'
  and pg_temp.doc('{"commission_type":"fixed","commission_rate_bps":null,"commission_fixed_minor":125000,"currency":"EUR","minimum_payout_minor":5005}')
    ->'summary' @> '[{"label":"Commission","value":"1,250.00 EUR on every payment for 12 months"},{"label":"Minimum payout","value":"50.05 EUR"}]'
  and kma_internal.program_money(123456789, 'USD') = '$1,234,567.89' and kma_internal.program_money(5, 'GBP') = '0.05 GBP',
  'percentages and money are written in normal units, with the currency');
select pg_temp.check((select d->'summary' @> '[{"label":"Attribution window","value":"1 day"},{"label":"Hold before payout","value":"None"},
      {"label":"Minimum payout","value":"None"}]'
    and d->'sections'->3->'paragraphs'->>0 = 'A sale is credited to you when a customer clicks your link and pays SpeakSix Ltd within 1 day of that click.'
    and d->'sections'->4->'paragraphs'->>0 = 'There is no hold. Commission is ready for payout once KissMyApps has confirmed the payment.'
    and d->'sections'->5->'paragraphs'->>1 = 'Commission becomes payable once KissMyApps has confirmed the payment. There is no minimum payout.'
    and d->'sections'->1->'paragraphs'->>1 = 'SpeakSix Ltd approves each creator. You can start once you have been approved.'
  from pg_temp.doc('{"attribution_window_days":1,"hold_days":0,"minimum_payout_minor":0,"approval_mode":"manual"}') d)
  and pg_temp.doc()->'sections'->5->'paragraphs'->>1
    = 'Commission becomes payable once it has passed the hold. It is paid when your payable commission reaches $20.00.'
  and pg_temp.doc()->'sections'->1->'paragraphs'
    = '["You promote SpeakSix. KissMyApps gives you your own link, and people who click it land on https://speaksix.com/start.",
      "You can start as soon as you accept this agreement."]'::jsonb,
  'the window, the hold, the minimum payout and how creators join are written as they were set');
select pg_temp.check((select d->>'extra_terms' = E'No coupon sites.\n  Keep it friendly.\n' and jsonb_array_length(d->'sections') = 12
    and d->'sections'->11 = '{"heading":"12. Additional terms from SpeakSix Ltd","paragraphs":["SpeakSix Ltd added the terms below. They are part of this agreement, but they cannot reduce commission you have already earned."]}'::jsonb
  from pg_temp.doc(jsonb_build_object('extra_terms', E'No coupon sites.\n  Keep it friendly.\n')) d),
  'the brand''s extra terms come last, exactly as typed, under their own heading');
select pg_temp.check((select d->>'brand_name' = 'SpeakSix'
    and d->'sections'->0->'paragraphs'->>0 like 'This agreement is between you, the creator, and SpeakSix. KissMyApps is the platform%'
  from pg_temp.doc('{"brand_name":null}') d)
  and pg_temp.doc()->'sections'->0->'paragraphs'->>0 like 'This agreement is between you, the creator, and SpeakSix Ltd, the business behind SpeakSix.%'
  and pg_temp.doc('{"program_name":null}') is null and pg_temp.doc('{"commission_type":null}') is null,
  'with no Stripe business name the brand is the program; with too little to go on there is no document');

-- Reading the agreement ------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.try('owner', pg_temp.sql('workspace_program_mark_agreement_read', 'acme', quote_literal(repeat('a', 64))))
    = '22023 agreement_not_read'
  and pg_temp.try('owner', pg_temp.sql('workspace_program_mark_agreement_read', 'acme', 'null')) = '22023 agreement_not_read'
  and (pg_temp.program('acme')).agreement_read_sha256 is null, 'only the hash of the current agreement counts as read');
insert into qa select 'revision_before_read', pg_temp.rev('acme')::text;
select pg_temp.check((select (s->'program'->>'agreement_read')::boolean and (s->'checklist'->>'agreement_read')::boolean
    and (s->'program'->>'revision')::integer = (select value::integer + 1 from qa where key = 'revision_before_read')
    and not (s->>'can_submit')::boolean from pg_temp.read('admin', 'acme') s)
  and (select p.agreement_read_sha256 = pg_temp.agreement('owner', 'acme')->>'sha256' and p.agreement_read_at is not null
    and p.updated_by = pg_temp.q('admin') from pg_temp.program('acme') p)
  and pg_temp.audits('acme', 'affiliate_program_agreement_read') = 1, 'reading the agreement is recorded against its hash');
select pg_temp.save('owner', 'acme', jsonb_build_object('category', 'productivity', 'tagline', 'Speak English in six weeks.',
  'logo_path', pg_temp.q('acme') || '/logo.png', 'marketplace_listed', false));
select pg_temp.check((pg_temp.state('owner', 'acme')->'program'->>'agreement_read')::boolean,
  'changing the card does not change the agreement, so it stays read');
select pg_temp.check(not (pg_temp.save('owner', 'acme', v.input)->'program'->>'agreement_read')::boolean
  and (pg_temp.read('owner', 'acme')->'program'->>'agreement_read')::boolean,
  format('changing %s makes the agreement unread until it is opened again', v.input))
from (values ('{"commission_rate_bps":2500}'::jsonb), ('{"hold_days":45}'), ('{"extra_terms":"No coupon sites."}'),
  ('{"name":"SpeakSix Pro"}'), ('{"landing_url":"https://speaksix.com/go"}'), ('{"approval_mode":"manual"}'),
  ('{"attribution_window_days":45}'), ('{"minimum_payout_minor":5000}'), ('{"commission_duration":"lifetime"}')) v(input);
select pg_temp.save('owner', 'acme', '{"name":"SpeakSix","category":"education","tagline":"Speak English with confidence in six weeks.",
  "landing_url":"https://speaksix.com/start","commission_type":"percent","commission_rate_bps":3000,"commission_duration":"months",
  "commission_months":12,"attribution_window_days":30,"hold_days":30,"minimum_payout_minor":2000,"approval_mode":"automatic",
  "marketplace_listed":true,"extra_terms":null}');
select pg_temp.read('owner', 'acme');

-- Publishing needs Stripe ----------------------------------------------------------------------------------
select pg_temp.check(pg_temp.try('owner', pg_temp.submit_sql('acme')) = '22023 stripe_not_connected'
  and (select (s->'checklist'->>'agreement_read')::boolean and not (s->'checklist'->>'stripe_connected')::boolean
    and not (s->>'can_submit')::boolean from pg_temp.state('owner', 'acme') s), 'a program cannot be published before Stripe is connected');
select pg_temp.connect('acme', 'acct_SpeakSix', 'SpeakSix Ltd');
select pg_temp.connect('rival', 'acct_Rival', 'Rival Media');
select pg_temp.check((select s->>'brand_name' = 'SpeakSix Ltd' and (s->>'stripe_connected')::boolean
    and not (s->'program'->>'agreement_read')::boolean and not (s->>'can_submit')::boolean from pg_temp.state('owner', 'acme') s)
  and pg_temp.agreement('owner', 'acme')->'agreement' = pg_temp.doc()
  and pg_temp.try('owner', pg_temp.submit_sql('acme')) = '22023 agreement_not_read',
  'connecting Stripe puts the business name in the agreement, which must then be read again');
select pg_temp.check((pg_temp.read('owner', 'acme')->>'can_submit')::boolean
  and pg_temp.state('owner', 'acme')->'checklist'
    = '{"stripe_connected":true,"details":true,"landing_page":true,"commission":true,"agreement_read":true}'::jsonb,
  'with every item ticked the program can be published');
select pg_temp.check(pg_temp.try('owner', pg_temp.sql('workspace_program_submit', 'acme', (pg_temp.rev('acme') - 1)::text)) = '40001 program_changed'
  and pg_temp.try('owner', pg_temp.sql('workspace_program_submit', 'acme', 'null')) = '40001 program_changed'
  and pg_temp.try('owner', pg_temp.status_sql('acme', 'paused')) = '22023 status_not_allowed'
  and pg_temp.try('owner', pg_temp.status_sql('acme', 'live')) = '22023 status_not_allowed',
  'publishing needs the current revision, and a draft cannot be paused or resumed');

-- Sent for review -------------------------------------------------------------------------------------------
select pg_temp.check((select s->'program'->>'status' = 'in_review' and s->'program'->>'submitted_at' is not null
    and not (s->>'can_submit')::boolean and s->'program'->'live_terms_version' = 'null'
    from pg_temp.call('admin', pg_temp.submit_sql('acme')) s)
  and pg_temp.audits('acme', 'affiliate_program_submitted') = 1
  and (select count(*) = 0 from public.affiliate_program_terms) and (pg_temp.program('acme')).product_id is null,
  'publishing a first listing sends it for review; nothing is live yet');
select pg_temp.check(pg_temp.save_fails('owner', 'acme', '{"tagline":"Edited while waiting"}') = '22023 program_in_review'
  and pg_temp.try('owner', pg_temp.submit_sql('acme')) = '22023 program_in_review'
  and pg_temp.try('owner', pg_temp.sql('workspace_program_mark_agreement_read', 'acme',
    quote_literal(pg_temp.agreement('owner', 'acme')->>'sha256'))) = '22023 program_in_review'
  and pg_temp.try('owner', pg_temp.status_sql('acme', 'paused')) = '22023 status_not_allowed',
  'a program in review cannot be edited, published again or paused');

-- KissMyApps review: who may ------------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select bool_and(pg_temp.try(v.who, 'select public.list_admin_program_reviews()') like v.code
    and pg_temp.try(v.who, pg_temp.review_sql('review_admin_program', 'acme', '{"decision":"approve"}')) like v.code
    and pg_temp.try(v.who, pg_temp.review_sql('set_admin_program_status', 'acme', '{"status":"paused"}')) like v.code)
  from (values ('owner', '42501%'), ('kma_support', '42501%'), ('passwordless_owner', '42501%')) v(who, code))
  and (pg_temp.program('acme')).status = 'in_review',
  'a merchant, a support admin and an admin without a password session cannot review programs');

-- KissMyApps review: the queue ------------------------------------------------------------------------------
select pg_temp.check((select jsonb_array_length(r->'programs') = 1
    and (r->'programs'->0) - 'agreement' = pg_temp.state('owner', 'acme')->'program' || jsonb_build_object(
      'workspace_id', pg_temp.q('acme'), 'workspace_name', 'SpeakSix', 'brand_name', 'SpeakSix Ltd',
      'stripe_account_id', 'acct_SpeakSix', 'stripe_country', 'GB', 'reviewed_at', null)
    and r->'programs'->0->'agreement' = pg_temp.doc()
  from pg_temp.call('kma_operations', 'select public.list_admin_program_reviews()') r),
  'the review queue shows the program, its workspace, its Stripe account and the agreement creators would sign');
select pg_temp.check(pg_temp.try('kma_owner', 'select public.review_admin_program(''{"decision":"approve"}'')') = '22023 invalid_program_id'
  and pg_temp.try('kma_owner', 'select public.review_admin_program(''{"program_id":"nope","decision":"approve"}'')') = '22023 invalid_program_id'
  and pg_temp.try('kma_owner', 'select public.review_admin_program(''[]'')') = '22023 invalid_input'
  and pg_temp.try('kma_owner', format('select public.review_admin_program(%L)',
    jsonb_build_object('program_id', gen_random_uuid(), 'decision', 'approve'))) = 'P0002 program_not_found'
  and pg_temp.try('kma_owner', pg_temp.review_sql('review_admin_program', 'acme', '{"decision":"approve","force":true}')) = '22023 invalid_input'
  and pg_temp.try('kma_owner', pg_temp.review_sql('review_admin_program', 'acme', '{"decision":"approve","note":7}')) = '22023 invalid_input'
  and pg_temp.try('kma_owner', pg_temp.review_sql('review_admin_program', 'acme', '{}')) = '22023 invalid_decision'
  and pg_temp.try('kma_owner', pg_temp.review_sql('review_admin_program', 'acme', '{"decision":"reject"}')) = '22023 invalid_decision'
  and pg_temp.try('kma_owner', pg_temp.review_sql('review_admin_program', 'acme', '{"decision":"request_changes"}')) = '22023 invalid_note'
  and pg_temp.try('kma_owner', pg_temp.review_sql('review_admin_program', 'acme', '{"decision":"request_changes","note":" no "}')) = '22023 invalid_note'
  and pg_temp.try('kma_owner', pg_temp.review_sql('review_admin_program', 'acme',
    jsonb_build_object('decision', 'request_changes', 'note', repeat('x', 1001)))) = '22023 invalid_note'
  and pg_temp.try('kma_owner', pg_temp.review_sql('review_admin_program', 'rival', '{"decision":"approve"}')) = '22023 status_not_allowed'
  and (pg_temp.program('acme')).status = 'in_review', 'a review needs a program in review, a decision, and a note when changes are asked for');

-- Changes requested, edited and sent again ---------------------------------------------------------------
select pg_temp.check(pg_temp.call('kma_operations', pg_temp.review_sql('review_admin_program', 'acme',
    '{"decision":"request_changes","note":"  Please link to the pricing page.  "}'))
    = jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'status', 'changes_requested'),
  'operations asks for changes');
select pg_temp.check((select p.status = 'changes_requested' and p.review_note = 'Please link to the pricing page.'
    and p.reviewed_by = pg_temp.q('kma_operations') and p.reviewed_at is not null and p.product_id is null
    and p.updated_by = pg_temp.q('admin') from pg_temp.program('acme') p)
  and (select count(*) = 1 and bool_and(a.actor_type = 'admin' and a.actor_user_id = pg_temp.q('kma_operations')
      and a.reason = 'Please link to the pricing page.') from public.audit_logs a
    where a.action = 'affiliate_program_changes_requested' and a.target_id = (pg_temp.program('acme')).id),
  'asking for changes sends the program back with the note');
select pg_temp.check((select s->'program'->>'review_note' = 'Please link to the pricing page.' and (s->>'can_submit')::boolean
    and s->'program'->>'status' = 'changes_requested' from pg_temp.state('owner', 'acme') s)
  and (select jsonb_array_length(r->'programs') = 1 and r->'programs'->0->>'status' = 'changes_requested'
    from pg_temp.call('kma_owner', 'select public.list_admin_program_reviews()') r),
  'the merchant sees the note; the program moves to the reviewed list');
select pg_temp.save('owner', 'acme', '{"landing_url":"https://speaksix.com/pricing","tagline":null}');
select pg_temp.check(pg_temp.try('owner', pg_temp.submit_sql('acme')) = '22023 program_incomplete'
  and (pg_temp.save('owner', 'acme', '{"tagline":"Speak English with confidence in six weeks."}')->'program'->>'agreement_read')::boolean = false
  and pg_temp.try('owner', pg_temp.submit_sql('acme')) = '22023 agreement_not_read',
  'after changes are requested the form can be edited; an edited agreement must be read again');
select pg_temp.save('owner', 'acme', '{"landing_url":"https://speaksix.com/start"}');
select pg_temp.check((select s->'program'->>'status' = 'in_review' and s->'program'->'review_note' = 'null'
    from pg_temp.call('owner', pg_temp.submit_sql('acme')) s)
  and pg_temp.audits('acme', 'affiliate_program_submitted') = 2
  and (pg_temp.program('acme')).updated_by = pg_temp.q('owner'),
  'the agreement that was already read still counts, and sending again clears the note');

-- Approval is refused when the ground moved ----------------------------------------------------------------
select pg_temp.set_connection('acme', 'revoked');
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.review_sql('review_admin_program', 'acme', '{"decision":"approve"}'))
    = '22023 stripe_not_connected' and (pg_temp.program('acme')).status = 'in_review'
  and (pg_temp.call('kma_owner', 'select public.list_admin_program_reviews()')->'programs'->0)
    @> '{"brand_name":null,"stripe_account_id":null,"stripe_country":null}',
  'a program whose Stripe account was disconnected while waiting cannot be approved, and stays in review');
select pg_temp.set_connection('acme', 'active');
update public.merchant_connections set business_name = 'SpeakSix Holdings' where account_id = 'acct_SpeakSix';
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.review_sql('review_admin_program', 'acme', '{"decision":"approve"}'))
    = '22023 agreement_not_read' and (select count(*) = 0 from public.products where slug like 'speaksix%'),
  'if the agreement is no longer the one the merchant read, approval is refused and nothing is created');
update public.merchant_connections set business_name = 'SpeakSix Ltd' where account_id = 'acct_SpeakSix';

-- Approval -------------------------------------------------------------------------------------------------
insert into qa select 'revision_before_approval', pg_temp.rev('acme')::text;
select pg_temp.check(pg_temp.call('kma_owner', pg_temp.review_sql('review_admin_program', 'acme', '{"decision":"approve","note":"Looks good to go."}'))
  = jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'status', 'live'), 'an owner approves the listing');
select pg_temp.check((select p.status = 'live' and p.pause_reason is null and p.review_note is null and p.live_terms_version = 1
    and p.first_published_at is not null and p.reviewed_by = pg_temp.q('kma_owner') and p.reviewed_at = p.first_published_at
    and p.revision = (select value::integer + 1 from qa where key = 'revision_before_approval') and p.slug = 'speaksix'
    and p.updated_by = pg_temp.q('owner') from pg_temp.program('acme') p), 'the program is live at terms version 1');
select pg_temp.check((select count(*) = 1 and bool_and(x.name = 'SpeakSix' and x.slug = 'speaksix' and x.status = 'active'
    and x.tracking_mode = 'commercial') from public.products x where x.id = (pg_temp.program('acme')).product_id)
  and (select count(*) = 1 and bool_and(f.id = (pg_temp.program('acme')).funnel_id and f.key = 'main' and f.status = 'live'
    and f.is_default and f.destination_url = 'https://speaksix.com/start') from public.funnels f
    where f.product_id = (pg_temp.program('acme')).product_id),
  'approval creates an active commercial product and its live default funnel to the landing page');
select pg_temp.check((select count(*) = 1 and bool_and(t.version = 1 and t.terms = pg_temp.terms() and t.agreement = pg_temp.doc()
    and t.agreement_sha256 = pg_temp.sha(pg_temp.doc()) and t.created_by = pg_temp.q('owner'))
  from public.affiliate_program_terms t where t.program_id = (pg_temp.program('acme')).id),
  'terms version 1 is the snapshot and the agreement the merchant sent, in the merchant''s name');
select pg_temp.check((select count(*) = 1 and bool_and(a.actor_type = 'admin' and a.actor_user_id = pg_temp.q('kma_owner')
    and a.reason = 'Looks good to go.' and a.after_data->>'status' = 'live' and a.before_data->>'status' = 'in_review')
  from public.audit_logs a where a.action = 'affiliate_program_approved' and a.target_id = (pg_temp.program('acme')).id)
  and (select count(*) = 1 from public.audit_logs a where a.target_table = 'products' and a.action = 'insert'
    and a.target_id = (pg_temp.program('acme')).product_id),
  'the approval, the product and the funnel are in the audit log');
select pg_temp.check((select s->'program' @> '{"status":"live","has_unpublished_changes":false,"agreement_read":true,"live_terms_version":1}'
    and s->'program'->>'first_published_at' is not null and not (s->>'can_submit')::boolean from pg_temp.state('analyst', 'acme') s)
  and pg_temp.try('owner', pg_temp.submit_sql('acme')) = '22023 nothing_to_publish'
  and pg_temp.try('kma_owner', pg_temp.review_sql('review_admin_program', 'acme', '{"decision":"approve"}')) = '22023 status_not_allowed'
  and pg_temp.try('kma_owner', pg_temp.review_sql('review_admin_program', 'acme',
    '{"decision":"request_changes","note":"Too late for this."}')) = '22023 status_not_allowed',
  'a live program has nothing to publish and cannot be reviewed again');

-- A second listing: the product address is made unique ---------------------------------------------------
insert into public.products(name, slug, status) values ('An older product', 'rival-reader-2', 'draft');
select pg_temp.save('rival_owner', 'rival', '{"category":"entertainment","tagline":"Stories worth an evening.",
  "landing_url":"https://rivalreader.co/","commission_type":"fixed","commission_fixed_minor":500,"commission_duration":"first_payment"}');
select pg_temp.read('rival_owner', 'rival');
select pg_temp.call('rival_owner', pg_temp.submit_sql('rival'));
select pg_temp.check((select jsonb_array_length(r->'programs') = 2 and r->'programs'->0->>'slug' = 'rival-reader-2'
    and r->'programs'->0->>'status' = 'in_review' and r->'programs'->0->>'brand_name' = 'Rival Media'
    and r->'programs'->0->'agreement'->'summary'->0->>'value' = '$5.00 on the first payment'
    and r->'programs'->1->>'slug' = 'speaksix' and r->'programs'->1->>'status' = 'live'
    and (r->'programs'->1->>'reviewed_at')::timestamptz = (pg_temp.program('acme')).reviewed_at
    and r->'programs'->1->'agreement' = pg_temp.doc()
  from pg_temp.call('kma_owner', 'select public.list_admin_program_reviews()') r),
  'the queue lists programs waiting for review first, then the reviewed ones');
select pg_temp.call('kma_operations', pg_temp.review_sql('review_admin_program', 'rival', '{"decision":"approve","note":null}'));
select pg_temp.check((select x.slug = 'rival-reader-2-2' and x.name = 'Rival Reader' and x.status = 'active'
    from public.products x where x.id = (pg_temp.program('rival')).product_id)
  and (select p.status = 'live' and p.slug = 'rival-reader-2' and p.reviewed_by = pg_temp.q('kma_operations') from pg_temp.program('rival') p),
  'operations can approve too; a product address that is taken gets a suffix');
select pg_temp.check((select array_agg(x->>'slug' order by n) = array['rival-reader-2', 'speaksix']
  from jsonb_array_elements(pg_temp.call('kma_owner', 'select public.list_admin_program_reviews()')->'programs') with ordinality e(x, n)),
  'the most recently reviewed program comes first among the reviewed');

-- A live program: the card takes effect at once ---------------------------------------------------------
select pg_temp.check((select (s->'program'->>'has_unpublished_changes')::boolean = false and s->'program'->>'tagline' = 'Six weeks to confident English.'
    and s->'program'->>'category' = 'productivity' and (s->'program'->>'marketplace_listed')::boolean = false
    and (s->'program'->>'agreement_read')::boolean
  from pg_temp.save('owner', 'acme', '{"tagline":"Six weeks to confident English.","category":"productivity","marketplace_listed":false,"logo_path":null}') s),
  'card fields that are not in the agreement change without anything to publish');
select pg_temp.check((select (s->'program'->>'has_unpublished_changes')::boolean and s->'program'->>'slug' = 'speaksix'
    and s->'program'->>'status' = 'live' and not (s->>'can_submit')::boolean
  from pg_temp.save('admin', 'acme', '{"name":"SpeakSix Pro","landing_url":"https://speaksix.com/pro"}') s),
  'the name and the landing page are in the agreement, so changing them leaves something to publish');
select pg_temp.check((select x.name = 'SpeakSix Pro' and x.slug = 'speaksix' from public.products x where x.id = (pg_temp.program('acme')).product_id)
  and (select f.destination_url = 'https://speaksix.com/pro' from public.funnels f where f.id = (pg_temp.program('acme')).funnel_id)
  and (select t.terms->>'program_name' = 'SpeakSix' and t.terms->>'landing_url' = 'https://speaksix.com/start'
    from public.affiliate_program_terms t where t.program_id = (pg_temp.program('acme')).id and t.version = 1),
  'a new name and landing page reach the product and the funnel at once; the address never changes after approval; the published terms wait');
select pg_temp.check(pg_temp.save_fails('owner', 'acme', v.input) = '22023 ' || v.code,
  format('a published program cannot be saved with %s', v.input))
from (values ('{"name":null}'::jsonb, 'invalid_name'), ('{"category":null}', 'invalid_category'), ('{"tagline":" "}', 'invalid_tagline'),
  ('{"landing_url":null}', 'invalid_landing_url'), ('{"commission_type":null}', 'invalid_commission_type'),
  ('{"commission_rate_bps":null}', 'invalid_commission_rate_bps'), ('{"commission_type":"fixed"}', 'invalid_commission_fixed_minor'),
  ('{"commission_duration":null}', 'invalid_commission_duration'), ('{"landing_url":"https://speaksix.test/"}', 'invalid_landing_url')) v(input, code);

-- A live program: new terms publish without review ----------------------------------------------------------
select pg_temp.save('owner', 'acme', '{"name":"SpeakSix","landing_url":"https://speaksix.com/start","commission_rate_bps":4000,
  "commission_duration":"lifetime","extra_terms":"No coupon sites."}');
select pg_temp.check((select s->'program' @> '{"has_unpublished_changes":true,"agreement_read":false,"live_terms_version":1,"status":"live"}'
    and not (s->>'can_submit')::boolean from pg_temp.state('owner', 'acme') s)
  and pg_temp.try('owner', pg_temp.submit_sql('acme')) = '22023 agreement_not_read'
  and (select count(*) = 1 from public.affiliate_program_terms where program_id = (pg_temp.program('acme')).id),
  'changed terms wait on the working copy until the new agreement is read and published');
select pg_temp.check((pg_temp.read('owner', 'acme')->>'can_submit')::boolean, 'once read, the new terms can be published');
select pg_temp.check((select s->'program' @> '{"has_unpublished_changes":false,"agreement_read":true,"live_terms_version":2,"status":"live"}'
    and not (s->>'can_submit')::boolean from pg_temp.call('admin', pg_temp.submit_sql('acme')) s),
  'the merchant publishes the new terms and the program stays live');
select pg_temp.check((select count(*) = 2 from public.affiliate_program_terms where program_id = (pg_temp.program('acme')).id)
  and (select t.terms = pg_temp.terms('{"commission_rate_bps":4000,"commission_duration":"lifetime","commission_months":null,"extra_terms":"No coupon sites."}')
      and t.agreement = kma_internal.program_agreement(t.terms) and t.agreement_sha256 = pg_temp.sha(t.agreement)
      and t.agreement->'summary'->0->>'value' = '40% of every payment' and t.created_by = pg_temp.q('admin')
    from public.affiliate_program_terms t where t.program_id = (pg_temp.program('acme')).id and t.version = 2)
  and (select t.terms = pg_temp.terms() and t.agreement = pg_temp.doc()
    from public.affiliate_program_terms t where t.program_id = (pg_temp.program('acme')).id and t.version = 1)
  and (select p.reviewed_by = pg_temp.q('kma_owner') and p.submitted_at < p.first_published_at from pg_temp.program('acme') p)
  and pg_temp.audits('acme', 'affiliate_program_terms_published') = 1
  and pg_temp.try('owner', pg_temp.submit_sql('acme')) = '22023 nothing_to_publish',
  'publishing writes version 2 and makes it current with no second review; version 1 is untouched');
select pg_temp.check((pg_temp.call('kma_owner', 'select public.list_admin_program_reviews()')->'programs'->1->'agreement'->'summary'->0->>'value')
  = '40% of every payment', 'the review list shows the agreement that is in force');
do $$
begin
  begin
    update public.affiliate_program_terms set terms = terms || '{"commission_rate_bps":1}' where version = 1;
    raise exception 'a published version was edited';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%append-only' then raise; end if;
  end;
  begin
    delete from public.affiliate_program_terms where version = 1;
    raise exception 'a published version was deleted';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%append-only' then raise; end if;
  end;
  perform pg_temp.check(true, 'a published version of the terms can be neither edited nor deleted');
end $$;

-- Pause and resume ----------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.try('owner', pg_temp.status_sql('acme', 'archived')) = '22023 invalid_status'
  and pg_temp.try('owner', pg_temp.sql('workspace_program_set_status', 'acme', 'null', pg_temp.rev('acme')::text)) = '22023 invalid_status'
  and pg_temp.try('owner', pg_temp.sql('workspace_program_set_status', 'acme', '''paused''', '1')) = '40001 program_changed'
  and pg_temp.try('owner', pg_temp.status_sql('acme', 'live')) = '22023 status_not_allowed',
  'a status change needs paused or live, the current revision, and a program in the right state');
select pg_temp.check((select s->'program' @> '{"status":"paused","pause_reason":"merchant"}' from pg_temp.call('owner', pg_temp.status_sql('acme', 'paused')) s)
  and pg_temp.try('owner', pg_temp.status_sql('acme', 'paused')) = '22023 status_not_allowed'
  and pg_temp.audits('acme', 'affiliate_program_paused') = 1
  and (select x.status = 'active' from public.products x where x.id = (pg_temp.program('acme')).product_id),
  'the merchant pauses a live program');
select pg_temp.save('owner', 'acme', '{"hold_days":14}');
select pg_temp.read('owner', 'acme');
select pg_temp.check((select s->'program' @> '{"status":"paused","pause_reason":"merchant","live_terms_version":3,"has_unpublished_changes":false}'
    from pg_temp.call('owner', pg_temp.submit_sql('acme')) s), 'a paused program can still be edited and its terms published');
select pg_temp.check((select s->'program' @> '{"status":"live","pause_reason":null}' from pg_temp.call('admin', pg_temp.status_sql('acme', 'live')) s)
  and pg_temp.audits('acme', 'affiliate_program_resumed') = 1, 'and resumes it');

-- Paused by KissMyApps ---------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.review_sql('set_admin_program_status', 'acme', '{}')) = '22023 invalid_status'
  and pg_temp.try('kma_owner', pg_temp.review_sql('set_admin_program_status', 'acme', '{"status":"archived"}')) = '22023 invalid_status'
  and pg_temp.try('kma_owner', pg_temp.review_sql('set_admin_program_status', 'acme', '{"status":"paused","note":"no"}')) = '22023 invalid_note'
  and pg_temp.try('kma_owner', pg_temp.review_sql('set_admin_program_status', 'acme', '{"status":"paused","decision":"approve"}')) = '22023 invalid_input'
  and pg_temp.try('kma_owner', 'select public.set_admin_program_status(''{"status":"paused"}'')') = '22023 invalid_program_id'
  and pg_temp.try('kma_owner', pg_temp.review_sql('set_admin_program_status', 'acme', '{"status":"live"}')) = '22023 status_not_allowed'
  and pg_temp.try('kma_owner', pg_temp.review_sql('set_admin_program_status', 'third', '{"status":"paused"}')) = '22023 status_not_allowed',
  'KissMyApps can pause only a live program');
select pg_temp.check(pg_temp.call('kma_operations', pg_temp.review_sql('set_admin_program_status', 'acme',
    '{"status":"paused","note":"The landing page is down."}'))
    = jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'status', 'paused', 'pause_reason', 'admin'),
  'operations pauses the program with a reason');
select pg_temp.check((select s->'program' @> '{"status":"paused","pause_reason":"admin","review_note":"The landing page is down."}'
    from pg_temp.state('owner', 'acme') s)
  and pg_temp.try('owner', pg_temp.status_sql('acme', 'live')) = '22023 program_paused_by_admin'
  and pg_temp.try('kma_owner', pg_temp.review_sql('set_admin_program_status', 'acme', '{"status":"paused"}')) = '22023 status_not_allowed'
  and (select count(*) = 1 and bool_and(a.actor_type = 'admin' and a.reason = 'The landing page is down.') from public.audit_logs a
    where a.action = 'affiliate_program_admin_paused' and a.target_id = (pg_temp.program('acme')).id),
  'a pause by KissMyApps shows its reason and cannot be lifted by the merchant');
select pg_temp.check(pg_temp.call('kma_owner', pg_temp.review_sql('set_admin_program_status', 'acme', '{"status":"live"}'))
    = jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'status', 'live', 'pause_reason', null)
  and (select p.status = 'live' and p.pause_reason is null and p.review_note is null from pg_temp.program('acme') p)
  and pg_temp.audits('acme', 'affiliate_program_admin_pause_lifted') = 1, 'KissMyApps lifts its pause and the program is live again');
select pg_temp.call('owner', pg_temp.status_sql('acme', 'paused'));
select pg_temp.check(pg_temp.try('kma_owner', pg_temp.review_sql('set_admin_program_status', 'acme', '{"status":"live"}')) = '22023 status_not_allowed'
  and (pg_temp.program('acme')).pause_reason = 'merchant', 'KissMyApps cannot lift a pause the merchant chose');
select pg_temp.call('owner', pg_temp.status_sql('acme', 'live'));

-- Stripe disconnected ---------------------------------------------------------------------------------------
insert into public.merchant_connections(merchant_id, platform_account_id, livemode, account_id, status)
select b.id, 'acct_Platform', false, 'acct_SpeakSixTest', 'active' from public.merchant_businesses b where b.workspace_id = pg_temp.q('acme');
update public.merchant_connections set status = 'revoked' where account_id = 'acct_SpeakSixTest';
update public.merchant_connections set charges_enabled = false where account_id = 'acct_SpeakSix';
select pg_temp.check((pg_temp.program('acme')).status = 'live' and pg_temp.audits('acme', 'affiliate_program_stripe_paused') = 0,
  'a test-mode connection, or a change that leaves the live connection active, pauses nothing');
insert into qa select 'revision_before_disconnect', pg_temp.rev('acme')::text;
select set_config('request.jwt.claims', '', true);
set local role service_role;
select pg_temp.check(public.disconnect_workspace_stripe(jsonb_build_object('workspace_id', pg_temp.q('acme'), 'user_id', pg_temp.q('owner')))
  @> '{"disconnected":true}', 'the owner disconnects Stripe on the Connections page');
reset role;
select pg_temp.check((select p.status = 'paused' and p.pause_reason = 'stripe_disconnected'
    and p.revision = (select value::integer + 1 from qa where key = 'revision_before_disconnect') from pg_temp.program('acme') p)
  and (select count(*) = 1 and bool_and(a.actor_type = 'system' and a.before_data->>'status' = 'live'
      and a.after_data @> '{"status":"paused","pause_reason":"stripe_disconnected"}') from public.audit_logs a
    where a.action = 'affiliate_program_stripe_paused' and a.target_id = (pg_temp.program('acme')).id)
  and (pg_temp.program('rival')).status = 'live' and (pg_temp.program('third')).status = 'draft',
  'disconnecting Stripe pauses the workspace''s live program and no other');
select pg_temp.check((select not (s->>'stripe_connected')::boolean and s->'brand_name' = 'null'
    and s->'program' @> '{"status":"paused","pause_reason":"stripe_disconnected","has_unpublished_changes":false,"agreement_read":true}'
    and not (s->>'can_submit')::boolean from pg_temp.state('owner', 'acme') s)
  and pg_temp.agreement('owner', 'acme')->'agreement'->>'brand_name' = 'SpeakSix Ltd'
  and pg_temp.try('owner', pg_temp.status_sql('acme', 'live')) = '22023 stripe_not_connected',
  'while disconnected the program keeps its published brand, has nothing to publish and cannot be resumed');
select pg_temp.save('owner', 'acme', '{"hold_days":21}');
select pg_temp.read('owner', 'acme');
select pg_temp.check(pg_temp.try('owner', pg_temp.submit_sql('acme')) = '22023 stripe_not_connected',
  'new terms cannot be published without Stripe');
select pg_temp.set_connection('acme', 'active');
select pg_temp.check((select p.status = 'paused' and p.pause_reason = 'stripe_disconnected' from pg_temp.program('acme') p),
  'reconnecting Stripe does not resume the program');
select pg_temp.check((select s->'program' @> '{"status":"live","pause_reason":null}' from pg_temp.call('owner', pg_temp.status_sql('acme', 'live')) s)
  and (pg_temp.call('owner', pg_temp.submit_sql('acme'))->'program'->>'live_terms_version')::integer = 4,
  'the merchant resumes it, and can publish again');

-- A pause by KissMyApps that outlives the Stripe connection ---------------------------------------------------
select pg_temp.call('kma_owner', pg_temp.review_sql('set_admin_program_status', 'acme', '{"status":"paused"}'));
select pg_temp.set_connection('acme', 'revoked');
select pg_temp.check((select p.status = 'paused' and p.pause_reason = 'admin' and p.review_note is null from pg_temp.program('acme') p)
  and pg_temp.audits('acme', 'affiliate_program_stripe_paused') = 1, 'a program that is already paused keeps its reason when Stripe goes');
select pg_temp.check(pg_temp.call('kma_owner', pg_temp.review_sql('set_admin_program_status', 'acme', '{"status":"live"}'))
    = jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'status', 'paused', 'pause_reason', 'stripe_disconnected')
  and pg_temp.try('owner', pg_temp.status_sql('acme', 'live')) = '22023 stripe_not_connected',
  'lifting that pause leaves the program paused for the missing Stripe account, never live without one');
select pg_temp.set_connection('acme', 'active');
select pg_temp.call('owner', pg_temp.status_sql('acme', 'live'));
select pg_temp.check((pg_temp.program('acme')).status = 'live', 'after reconnecting the merchant resumes it');

-- Housekeeping ------------------------------------------------------------------------------------------------
select pg_temp.check((select count(*) >= 40 and bool_and(a.actor_type in ('system', 'admin')
    and (a.actor_user_id is not null or a.action = 'affiliate_program_stripe_paused')) from public.audit_logs a
  where a.target_table = 'affiliate_programs')
  and (select bool_and(p.revision = 1 + (select count(*) from public.audit_logs a
      where a.target_table = 'affiliate_programs' and a.target_id = p.id and a.action <> 'affiliate_program_created'))
    from public.affiliate_programs p),
  'every change is in the audit log with who made it, and each one moved the revision by exactly one');
select pg_temp.check((select count(*) = 3 from public.affiliate_programs)
  and (select count(*) = 5 from public.affiliate_program_terms)
  and (select bool_and(t.agreement_sha256 = pg_temp.sha(t.agreement) and t.agreement = kma_internal.program_agreement(t.terms))
    from public.affiliate_program_terms t),
  'three workspaces have three programs, and every stored agreement still matches its terms and its hash');

-- Which products are a program's (Phase 5: the admin app keeps its setup wizard for the others).
select pg_temp.check(
  (select jsonb_array_length(a->'products') = (select count(*) from public.affiliate_programs p where p.product_id is not null)
      and jsonb_array_length(a->'products') > 0
      and (select bool_and(exists (select 1 from public.affiliate_programs p
          where p.id = (x->>'program_id')::uuid and p.product_id = (x->>'product_id')::uuid
            and p.name = x->>'program_name' and p.slug = x->>'program_slug' and p.status = x->>'program_status'))
        from jsonb_array_elements(a->'products') x)
    from pg_temp.call('kma_operations', 'select public.get_admin_program_products()') a)
  and pg_temp.try('owner', 'select public.get_admin_program_products()') = '42501'
  and pg_temp.try_signed_out('authenticated', 'select public.get_admin_program_products()') = '28000'
  and pg_temp.try_signed_out('anon', 'select public.get_admin_program_products()') = '42501'
  and pg_temp.try_signed_out('service_role', 'select public.get_admin_program_products()') = '42501',
  'an admin can read which products belong to a program; a merchant and a signed-out caller cannot');

select 'ok ' || count(*) || ' affiliate program assertions' from program_assertions;
rollback;
