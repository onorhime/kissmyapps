-- Provider-free test of creators joining a merchant's affiliate program: the marketplace
-- reads, the click-accept, automatic and manual approval, the main link a join issues (and
-- that the click rule really resolves it), declining, removing, leaving, joining again,
-- newer terms, and what the merchant's Creators page reads. Programs are made live with
-- the Phase 2 functions; Stripe is never called: connections are fixture rows.
begin;
set local time zone 'UTC';
create temporary table join_assertions(label text);
create temporary table qa(key text primary key, value text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program join assertion failed: %', label; end if;
  insert into join_assertions values (label);
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$
  select value::uuid from qa where key = k
$$;
-- Signs in. KissMyApps staff (kma_...) get a session that used their sign-in credentials,
-- as the admin app gives them.
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
create function pg_temp.program(workspace text) returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q(workspace)
$$;
create function pg_temp.live_terms(workspace text) returns public.affiliate_program_terms language sql as $$
  select t from public.affiliate_program_terms t
  where t.program_id = (pg_temp.program(workspace)).id and t.version = (pg_temp.program(workspace)).live_terms_version
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
-- The merchant saves the form, reads the agreement and publishes; KissMyApps approves a
-- first listing. On a live program this publishes the next version of the terms.
create function pg_temp.publish(who text, workspace text, input jsonb) returns void language plpgsql as $$
begin
  perform pg_temp.call(who, format('select public.workspace_program_save(%L, %L)', pg_temp.q(workspace),
    input || case when (pg_temp.program(workspace)).id is null then '{}'::jsonb
      else jsonb_build_object('revision', (pg_temp.program(workspace)).revision) end));
  perform pg_temp.call(who, format('select public.workspace_program_mark_agreement_read(%L, %L)', pg_temp.q(workspace),
    pg_temp.call(who, format('select public.workspace_program_agreement(%L)', pg_temp.q(workspace)))->>'sha256'));
  perform pg_temp.call(who, format('select public.workspace_program_submit(%L, %s)', pg_temp.q(workspace),
    (pg_temp.program(workspace)).revision));
  if (pg_temp.program(workspace)).status = 'in_review' then
    perform pg_temp.call('kma_owner', format('select public.review_admin_program(%L)',
      jsonb_build_object('program_id', (pg_temp.program(workspace)).id, 'decision', 'approve')));
  end if;
end $$;
create function pg_temp.set_status(who text, workspace text, new_status text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_program_set_status(%L, %L, %s)', pg_temp.q(workspace), new_status,
    (pg_temp.program(workspace)).revision))
$$;
-- What the acceptance screen sends: the program's address and the terms that were shown.
create function pg_temp.shown(workspace text, overrides jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('slug', (pg_temp.program(workspace)).slug, 'terms_version', t.version,
    'agreement_sha256', t.agreement_sha256) || overrides
  from pg_temp.live_terms(workspace) t
$$;
create function pg_temp.join_sql(workspace text, overrides jsonb default '{}') returns text language sql as $$
  select format('select public.partner_program_join(%L)', pg_temp.shown(workspace, overrides))
$$;
create function pg_temp.accept_sql(workspace text, overrides jsonb default '{}') returns text language sql as $$
  select format('select public.partner_program_accept_terms(%L)',
    pg_temp.shown(workspace) - 'slug' || jsonb_build_object('program_id', (pg_temp.program(workspace)).id) || overrides)
$$;
create function pg_temp.leave_sql(workspace text) returns text language sql as $$
  select format('select public.partner_program_leave(%L)', jsonb_build_object('program_id', (pg_temp.program(workspace)).id))
$$;
-- A creator's membership row, their main link and what they are shown.
create function pg_temp.member(creator text, workspace text) returns public.affiliate_program_members language sql as $$
  select m from public.affiliate_program_members m
  where m.program_id = (pg_temp.program(workspace)).id and m.affiliate_id = pg_temp.q('creator_' || creator)
$$;
create function pg_temp.link(creator text, workspace text) returns public.affiliate_links language sql as $$
  select l from public.affiliate_links l where l.id = (pg_temp.member(creator, workspace)).main_link_id
$$;
create function pg_temp.membership(creator text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(creator, format('select public.partner_program_detail(%L)', (pg_temp.program(workspace)).slug))->'membership'
$$;
-- A visitor opens the creator's link: what the redirect function gets back.
create function pg_temp.click(creator text, workspace text, context jsonb default '{}') returns jsonb language plpgsql as $$
declare
  v_slug text;
  v_code text;
  result jsonb;
begin
  select a.slug, l.public_code into v_slug, v_code
  from pg_temp.link(creator, workspace) l join public.affiliates a on a.id = l.affiliate_id;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select to_jsonb(r) into result from public.register_tracking_click(v_slug, v_code, context) r;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- The merchant's Creators page, one creator on it, and a decision.
create function pg_temp.creators(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_program_creators(%L)', pg_temp.q(workspace)))
$$;
create function pg_temp.creator(who text, workspace text, handle text) returns jsonb language sql as $$
  select c from jsonb_array_elements(pg_temp.creators(who, workspace)->'creators') c where c->>'handle' = handle
$$;
create function pg_temp.decide_sql(workspace text, creator text, action text, extra jsonb default '{}') returns text language sql as $$
  select format('select public.workspace_program_creator_decide(%L, %L)', pg_temp.q(workspace),
    jsonb_build_object('member_id', (pg_temp.member(creator, workspace)).id, 'action', action) || extra)
$$;
create function pg_temp.audits(creator text, workspace text, action_name text) returns bigint language sql as $$
  select count(*) from public.audit_logs
  where action = action_name and target_table = 'affiliate_program_members' and target_id = (pg_temp.member(creator, workspace)).id
$$;
create function pg_temp.audit_reason(creator text, workspace text, action_name text) returns text language sql as $$
  select reason from public.audit_logs
  where action = action_name and target_table = 'affiliate_program_members' and target_id = (pg_temp.member(creator, workspace)).id
  order by created_at desc limit 1
$$;
-- Counts rows as they are now. A plain subquery in a statement cannot see what a function
-- called earlier in that same statement wrote; a function call can.
create function pg_temp.n(rows_of text) returns bigint language plpgsql as $$
declare result bigint;
begin
  execute 'select count(*) from ' || rows_of into result;
  return result;
end $$;
create function pg_temp.tracking(enabled boolean) returns void language sql as $$
  update public.platform_settings set tracking_enabled = enabled where singleton
$$;
-- A disposable test cluster made without UTF-8 cannot run normalize(), which the readable
-- link address uses for names outside ASCII. This suite has no such names, so on such a
-- cluster (and only there, and only inside this rolled-back transaction) the same rule
-- runs without it. On a UTF-8 database the real function is tested.
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
grant all on qa, join_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- People ---------------------------------------------------------------------------------------
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('f6000000-0000-4000-8000-000000000001', 'owner@speaksix.com', now(), '{"company":"SpeakSix"}'),
  ('f6000000-0000-4000-8000-000000000002', 'admin@speaksix.com', now(), '{}'),
  ('f6000000-0000-4000-8000-000000000003', 'analyst@speaksix.com', now(), '{}'),
  ('f6000000-0000-4000-8000-000000000004', 'owner@rival.co', now(), '{"company":"Rival"}'),
  ('f6000000-0000-4000-8000-000000000005', 'owner@quiet.co', now(), '{"company":"Quiet"}'),
  ('f6000000-0000-4000-8000-000000000006', 'owner@draft.co', now(), '{"company":"Draft"}'),
  ('f6000000-0000-4000-8000-000000000011', 'owner@kissmyapps.dev', now(), '{}'),
  ('f6000000-0000-4000-8000-000000000021', 'ada@creators.example', now(), '{}'),
  ('f6000000-0000-4000-8000-000000000022', 'ben@creators.example', now(), '{}'),
  ('f6000000-0000-4000-8000-000000000023', 'cy@creators.example', now(), '{}'),
  ('f6000000-0000-4000-8000-000000000024', 'dee@creators.example', now(), '{}'),
  ('f6000000-0000-4000-8000-000000000025', 'helper@creators.example', now(), '{}'),
  ('f6000000-0000-4000-8000-000000000026', 'stranger@elsewhere.co', now(), '{}');
insert into qa values
  ('owner', 'f6000000-0000-4000-8000-000000000001'), ('admin', 'f6000000-0000-4000-8000-000000000002'),
  ('analyst', 'f6000000-0000-4000-8000-000000000003'), ('rival_owner', 'f6000000-0000-4000-8000-000000000004'),
  ('quiet_owner', 'f6000000-0000-4000-8000-000000000005'), ('draft_owner', 'f6000000-0000-4000-8000-000000000006'),
  ('kma_owner', 'f6000000-0000-4000-8000-000000000011'),
  ('ada', 'f6000000-0000-4000-8000-000000000021'), ('ben', 'f6000000-0000-4000-8000-000000000022'),
  ('cy', 'f6000000-0000-4000-8000-000000000023'), ('dee', 'f6000000-0000-4000-8000-000000000024'),
  -- Works on Ada's creator account but does not own it.
  ('ada_helper', 'f6000000-0000-4000-8000-000000000025'),
  ('stranger', 'f6000000-0000-4000-8000-000000000026'),
  ('creator_ada', 'f7000000-0000-4000-8000-000000000001'), ('creator_ben', 'f7000000-0000-4000-8000-000000000002'),
  ('creator_cy', 'f7000000-0000-4000-8000-000000000003'), ('creator_dee', 'f7000000-0000-4000-8000-000000000004');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner');
insert into public.affiliates(id, public_name, legal_name, slug, status, country_code, channels, website_url) values
  (pg_temp.q('creator_ada'), 'Ada Okafor', 'Ada N. Okafor', 'ada-okafor', 'active', 'NG', array['tiktok', 'instagram'], null),
  (pg_temp.q('creator_ben'), 'Ben Creator', null, 'ben-creator', 'active', 'GB', array['youtube'], 'https://ben.example.com'),
  (pg_temp.q('creator_cy'), 'Cy Park', '  ', 'cy-park', 'active', null, '{}', null),
  (pg_temp.q('creator_dee'), 'Dee Vale', null, 'dee-vale', 'active', 'US', array['newsletter'], null);
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at) values
  (pg_temp.q('creator_ada'), pg_temp.q('ada'), 'owner', true, false, now()),
  (pg_temp.q('creator_ada'), pg_temp.q('ada_helper'), 'member', true, false, now()),
  (pg_temp.q('creator_ben'), pg_temp.q('ben'), 'owner', true, false, now()),
  (pg_temp.q('creator_cy'), pg_temp.q('cy'), 'owner', true, false, now()),
  (pg_temp.q('creator_dee'), pg_temp.q('dee'), 'owner', true, false, now());
-- The production tracking address is set, but tracking is still switched off.
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', false)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = false;

-- Workspaces and their programs ---------------------------------------------------------------
select pg_temp.sign_in('owner');
insert into qa select 'acme', public.analytics_bootstrap()->'workspaces'->0->>'id';
select public.analytics_invite_member(pg_temp.q('acme'), 'admin@speaksix.com', 'admin');
select public.analytics_invite_member(pg_temp.q('acme'), 'analyst@speaksix.com', 'analyst');
select pg_temp.sign_in('admin');
select public.analytics_bootstrap();
select pg_temp.sign_in('analyst');
select public.analytics_bootstrap();
select pg_temp.sign_in('rival_owner');
insert into qa select 'rival', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('quiet_owner');
insert into qa select 'quiet', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('draft_owner');
insert into qa select 'draft', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
select pg_temp.connect('acme', 'acct_SpeakSix', 'SpeakSix Ltd');
select pg_temp.connect('rival', 'acct_Rival', 'Rival Media');
select pg_temp.connect('quiet', 'acct_Quiet', 'Quiet Club');
insert into storage.objects(id, bucket_id, name) values (gen_random_uuid(), 'program-logos', pg_temp.q('acme') || '/logo.png');

-- SpeakSix approves creators automatically; Rival Reader approves each one; Quiet Club is
-- not listed in the marketplace; the fourth workspace only has a draft.
select pg_temp.publish('owner', 'acme', jsonb_build_object('name', 'SpeakSix', 'category', 'education',
  'tagline', 'Speak English with confidence in six weeks.', 'logo_path', pg_temp.q('acme') || '/logo.png',
  'landing_url', 'https://speaksix.com/start', 'commission_type', 'percent', 'commission_rate_bps', 3000,
  'commission_duration', 'months', 'commission_months', 12));
select pg_temp.publish('rival_owner', 'rival', '{"name":"Rival Reader","category":"entertainment","tagline":"Stories worth an evening.",
  "landing_url":"https://rivalreader.co/","commission_type":"fixed","commission_fixed_minor":500,
  "commission_duration":"first_payment","approval_mode":"manual"}');
select pg_temp.publish('quiet_owner', 'quiet', '{"name":"Quiet Club","category":"lifestyle","tagline":"A calmer phone.",
  "landing_url":"https://quietclub.io/join","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"lifetime","marketplace_listed":false}');
select pg_temp.call('draft_owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('draft'), '{"name":"Draft Thing"}'::jsonb));
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select array_agg(p.slug || ':' || p.status order by p.slug) = array['draft-thing:draft', 'quiet-club:live',
    'rival-reader:live', 'speaksix:live'] from public.affiliate_programs p),
  'three programs are live and one is a draft');

-- Closed by default ----------------------------------------------------------------------------
select pg_temp.check((select bool_and(not has_table_privilege(r, t, p))
  from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['public.affiliate_program_members', 'public.affiliate_program_acceptances']) t,
    unnest(array['select', 'insert', 'update', 'delete']) p)
  and (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.affiliate_program_members'::regclass, 'public.affiliate_program_acceptances'::regclass)),
  'no API role can read or write the membership tables, and row security is on');
select pg_temp.check((select count(*) = 7 and bool_and(has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute')
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('partner_marketplace', 'partner_program_detail', 'partner_program_join',
    'partner_program_accept_terms', 'partner_program_leave', 'workspace_program_creators', 'workspace_program_creator_decide')),
  'signed-in users may call the creator and merchant functions; each is a security definer function with an empty search path');
select pg_temp.check((select count(*) = 2 and bool_and(has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('marketplace_programs', 'marketplace_program')),
  'only the service role may call the two marketplace reads');
select pg_temp.check((select count(*) >= 12 and bool_and(not has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'kma_internal' and p.proname in ('program_card', 'program_detail', 'program_marketplace',
    'program_membership_json', 'program_creator_json', 'program_creator', 'program_accept_name', 'program_member_input',
    'program_member_terms', 'program_member_lock', 'program_member_audit', 'program_member_accept',
    'program_member_activate', 'program_member_end', 'program_member_of_creator')),
  'the internal helpers are closed to every API role');
select pg_temp.check(pg_temp.try_signed_out(r, s) = '42501', format('%s cannot run %s', r, left(s, 50)))
from unnest(array['anon', 'authenticated']) r, unnest(array[
  'select public.marketplace_programs()', 'select public.marketplace_program(''speaksix'')',
  'select public.partner_marketplace()', 'select public.partner_program_detail(''speaksix'')',
  pg_temp.join_sql('acme'), pg_temp.accept_sql('acme'), pg_temp.leave_sql('acme'),
  format('select public.workspace_program_creators(%L)', pg_temp.q('acme')),
  format('select public.workspace_program_creator_decide(%L, ''{}'')', pg_temp.q('acme'))]) s;
select pg_temp.check(pg_temp.try_signed_out('service_role', 'select public.partner_marketplace()') = '42501'
  and pg_temp.try_signed_out('service_role', pg_temp.join_sql('acme')) = '42501'
  and pg_temp.try_signed_out('service_role', format('select public.workspace_program_creators(%L)', pg_temp.q('acme'))) = '42501'
  and pg_temp.try('ada', 'select public.marketplace_programs()') = '42501'
  and pg_temp.try('owner', 'select public.marketplace_program(''speaksix'')') = '42501'
  and pg_temp.try('ada', 'select kma_internal.program_card(null)') = '42501',
  'the service role cannot act as a creator or a merchant, and a signed-in user cannot call the marketplace reads or the helpers');
select pg_temp.check(pg_temp.try(u, 'select public.partner_marketplace()') = '42501'
  and pg_temp.try(u, 'select public.partner_program_detail(''speaksix'')') = '42501'
  and pg_temp.try(u, pg_temp.join_sql('acme')) = '42501'
  and pg_temp.try(u, pg_temp.accept_sql('acme')) = '42501'
  and pg_temp.try(u, pg_temp.leave_sql('acme')) = '42501',
  format('%s has no creator account, so the creator functions refuse', u))
from unnest(array['stranger', 'owner']) u;

-- The public marketplace -----------------------------------------------------------------------
select pg_temp.capture('marketplace_programs', pg_temp.service('select public.marketplace_programs()'));
select pg_temp.capture('marketplace_program', pg_temp.service('select public.marketplace_program(''speaksix'')'));
select pg_temp.check((select jsonb_array_length(r->'programs') = 2 and r->'programs'->0->>'slug' = 'rival-reader'
    and r->'programs'->1 = jsonb_build_object(
      'slug', 'speaksix', 'name', 'SpeakSix', 'category', 'education', 'tagline', 'Speak English with confidence in six weeks.',
      'logo_path', pg_temp.q('acme') || '/logo.png', 'brand_name', 'SpeakSix Ltd',
      'commission_type', 'percent', 'commission_rate_bps', 3000, 'commission_fixed_minor', null, 'currency', 'USD',
      'commission_duration', 'months', 'commission_months', 12,
      'attribution_window_days', 30, 'hold_days', 30, 'minimum_payout_minor', 2000,
      'approval_mode', 'automatic', 'terms_version', 1, 'earn_from', 'sales', 'rewards', '[]'::jsonb)
    and r->'programs'->0 @> '{"name":"Rival Reader","brand_name":"Rival Media","logo_path":null,"commission_type":"fixed",
      "commission_rate_bps":null,"commission_fixed_minor":500,"commission_duration":"first_payment","commission_months":null,
      "approval_mode":"manual","terms_version":1}'
  from pg_temp.service('select public.marketplace_programs()') r),
  'the marketplace lists the live, listed programs as cards, the newest first; the unlisted one and the draft are left out');
select pg_temp.check((select d->'program' = (pg_temp.service('select public.marketplace_programs()')->'programs'->1)
      || jsonb_build_object('id', (pg_temp.program('acme')).id, 'status', 'live', 'landing_url', 'https://speaksix.com/start',
        'agreement', t.agreement, 'agreement_sha256', t.agreement_sha256)
    and d->'program'->'agreement'->>'title' = 'SpeakSix Affiliate Agreement'
    and d->'program'->>'agreement_sha256' = encode(sha256(convert_to((d->'program'->'agreement')::text, 'utf8')), 'hex')
  from pg_temp.service('select public.marketplace_program(''speaksix'')') d, pg_temp.live_terms('acme') t),
  'a program page is the card plus its id, status, landing page, the published agreement and that agreement''s hash');
select pg_temp.check((pg_temp.service('select public.marketplace_program(''quiet-club'')')->'program')
    @> '{"slug":"quiet-club","status":"live","commission_rate_bps":2000,"commission_duration":"lifetime"}'
  and pg_temp.service('select public.marketplace_program(''draft-thing'')') = '{"program":null}'
  and pg_temp.service('select public.marketplace_program(''nothing-here'')') = '{"program":null}'
  and pg_temp.service('select public.marketplace_program(null)') = '{"program":null}',
  'an unlisted program opens by its address; a draft and an unknown address give nothing');

-- A creator reads the marketplace ----------------------------------------------------------------
select pg_temp.check((select r->'tracking_ready' = 'false' and r->'memberships' = '[]'
    and jsonb_array_length(r->'programs') = 2
    and r->'programs'->1 = (pg_temp.service('select public.marketplace_programs()')->'programs'->1) || '{"membership_status":null}'
    and r->'programs'->0->>'slug' = 'rival-reader' and r->'programs'->0->'membership_status' = 'null'
  from pg_temp.call('ada', 'select public.partner_marketplace()') r),
  'a creator sees the same list with their status on each card, no memberships yet, and that links are not available yet');
select pg_temp.check((select d->'program' = pg_temp.service('select public.marketplace_program(''speaksix'')')->'program'
    and d->'membership' = 'null' and d->>'accept_name' = 'Ada N. Okafor'
  from pg_temp.call('ada', 'select public.partner_program_detail(''speaksix'')') d)
  and pg_temp.call('ben', 'select public.partner_program_detail(''speaksix'')')->>'accept_name' = 'Ben Creator'
  and pg_temp.call('cy', 'select public.partner_program_detail(''quiet-club'')')->>'accept_name' = 'Cy Park'
  and pg_temp.call('ada_helper', 'select public.partner_program_detail(''speaksix'')')->>'accept_name' = 'Ada N. Okafor',
  'a creator opens a program and sees the name they would accept under: the legal name, or the public name without one');
select pg_temp.check(pg_temp.try('ada', 'select public.partner_program_detail(''draft-thing'')') = 'P0002 program_not_found'
  and pg_temp.try('ada', 'select public.partner_program_detail(''nothing-here'')') = 'P0002 program_not_found'
  and pg_temp.try('ada', 'select public.partner_program_detail(null)') = 'P0002 program_not_found',
  'a draft or an unknown address is not found');

-- What a join must carry ---------------------------------------------------------------------------
select pg_temp.check(pg_temp.try('ada', 'select public.partner_program_join(' || v.input || ')') = v.code,
  format('a join with %s is refused as %s', left(v.input, 60), v.code))
from (values
  ('null', '22023 invalid_input'),
  ('''[]''', '22023 invalid_input'),
  (quote_literal(pg_temp.shown('acme', '{"status":"active"}')), '22023 invalid_input'),
  (quote_literal(pg_temp.shown('acme', '{"slug":7}')), '22023 invalid_slug'),
  (quote_literal(pg_temp.shown('acme') - 'slug'), '22023 invalid_slug'),
  (quote_literal(pg_temp.shown('acme', '{"slug":"nothing-here"}')), 'P0002 program_not_found'),
  (quote_literal(pg_temp.shown('acme', '{"slug":"draft-thing"}')), 'P0002 program_not_found'),
  (quote_literal(pg_temp.shown('acme', '{"terms_version":"1"}')), '22023 invalid_terms_version'),
  (quote_literal(pg_temp.shown('acme', '{"terms_version":1.5}')), '22023 invalid_terms_version'),
  (quote_literal(pg_temp.shown('acme') - 'terms_version'), '22023 invalid_terms_version'),
  (quote_literal(pg_temp.shown('acme', '{"agreement_sha256":"abc"}')), '22023 invalid_agreement_sha256'),
  (quote_literal(pg_temp.shown('acme') - 'agreement_sha256'), '22023 invalid_agreement_sha256'),
  (quote_literal(pg_temp.shown('acme', '{"terms_version":2}')), '40001 terms_changed'),
  (quote_literal(pg_temp.shown('acme', jsonb_build_object('agreement_sha256', repeat('a', 64)))), '40001 terms_changed'),
  (quote_literal(pg_temp.shown('acme', jsonb_build_object('agreement_sha256', (pg_temp.live_terms('rival')).agreement_sha256))),
    '40001 terms_changed')) v(input, code);
select pg_temp.check(pg_temp.try('ada_helper', pg_temp.join_sql('acme')) = '42501',
  'someone who works on a creator account but does not own it cannot accept an agreement for it');

-- Tracking is off: no link can be issued -------------------------------------------------------------
select pg_temp.check(pg_temp.try('ada', pg_temp.join_sql('acme')) = '22023 tracking_not_enabled'
  and pg_temp.n('public.affiliate_program_members') = 0
  and pg_temp.n('public.affiliate_program_acceptances') = 0
  and pg_temp.n('public.affiliate_links') = 0
  and pg_temp.n('public.audit_logs where target_table = ''affiliate_program_members''') = 0,
  'while tracking is switched off a join that would issue a link is refused and leaves nothing behind');
update public.platform_settings set tracking_enabled = true, tracking_base_url = 'https://tracking.example.invalid' where singleton;
select pg_temp.check(pg_temp.try('ada', pg_temp.join_sql('acme')) = '22023 tracking_not_enabled'
  and pg_temp.call('ada', 'select public.partner_marketplace()')->'tracking_ready' = 'false',
  'tracking that is on but not at the production address does not count either');
update public.platform_settings set tracking_base_url = 'https://go.kissmyapps.dev' where singleton;
select pg_temp.check(pg_temp.call('ada', 'select public.partner_marketplace()')->'tracking_ready' = 'true',
  'with tracking on at the production address, links are available');

-- Automatic approval: accept and get a working link ---------------------------------------------------
insert into qa select 'ada_joined', pg_temp.call('ada', pg_temp.join_sql('acme'))::text;
select pg_temp.capture('join_automatic', (select value::jsonb from qa where key = 'ada_joined'));
select pg_temp.check((select m - 'id' - 'link' - 'accepted_at' - 'requested_at' - 'activated_at' = jsonb_build_object(
      'program_id', (pg_temp.program('acme')).id,
      'program', pg_temp.service('select public.marketplace_programs()')->'programs'->1,
      'program_status', 'live', 'status', 'active', 'terms_version', 1, 'needs_new_terms', false,
      'ended_at', null, 'decision_note', null)
    and m->>'id' = (pg_temp.member('ada', 'acme')).id::text
    and (m->>'accepted_at')::timestamptz = (m->>'requested_at')::timestamptz
    and (m->>'activated_at')::timestamptz = (m->>'requested_at')::timestamptz
    and (m->'link') - 'url' = '{"short_url":"https://go.kissmyapps.dev/speaksix/ada-okafor","working":true}'
    and m->'link'->>'url' ~ '^https://go\.kissmyapps\.dev/r/ada-okafor/[0-9a-f]{36}$'
  from (select (value::jsonb)->'membership' as m from qa where key = 'ada_joined') j),
  'accepting a program that approves automatically makes the creator active at once, with a link');
select pg_temp.check((select m.status = 'active' and m.terms_version = 1 and m.joined_by = pg_temp.q('ada')
    and m.activated_at = m.requested_at and m.updated_at = m.requested_at and m.ended_at is null
    and m.decided_by is null and m.decided_at is null and m.decision_note is null
  from pg_temp.member('ada', 'acme') m)
  and (select l.is_main and l.commercial_eligible and l.tracking_environment = 'live' and l.status = 'active'
      and l.product_id = (pg_temp.program('acme')).product_id and l.funnel_id = (pg_temp.program('acme')).funnel_id
      and l.source_id is null and l.campaign_id is null and l.parent_link_id is null
      and l.sub1 is null and l.sub2 is null and l.sub3 is null
      and l.name = 'SpeakSix · Main' and l.created_by = pg_temp.q('ada') and l.public_code ~ '^[0-9a-f]{36}$'
      and l.tracking_url = 'https://go.kissmyapps.dev/r/ada-okafor/' || l.public_code
    from pg_temp.link('ada', 'acme') l)
  and (select count(*) = 1 from public.affiliate_links where is_main),
  'the membership is active and its link is a live, commercial main link on the program''s product and landing page');
select pg_temp.check((select count(*) = 1 and bool_and(a.program_id = (pg_temp.program('acme')).id and a.terms_version = 1
      and a.agreement_sha256 = (pg_temp.live_terms('acme')).agreement_sha256 and a.accepted_by = pg_temp.q('ada')
      and a.accepted_name = 'Ada N. Okafor' and a.accepted_at = (pg_temp.member('ada', 'acme')).requested_at)
    from public.affiliate_program_acceptances a where a.member_id = (pg_temp.member('ada', 'acme')).id)
  and (select count(*) = 1 and bool_and(a.actor_user_id = pg_temp.q('ada') and a.actor_type = 'affiliate'
      and a.before_data is null and a.after_data @> '{"status":"active","terms_version":1}')
    from public.audit_logs a where a.action = 'affiliate_program_member_joined'
      and a.target_table = 'affiliate_program_members' and a.target_id = (pg_temp.member('ada', 'acme')).id)
  and (select count(*) >= 2 from public.audit_logs a where a.target_table = 'affiliate_links'
    and a.target_id = (pg_temp.link('ada', 'acme')).id),
  'the acceptance is recorded with the agreement hash and the name, and the join and the link are in the audit log');
select pg_temp.check(pg_temp.try('ada', pg_temp.join_sql('acme')) = '22023 already_member'
  and pg_temp.n('public.affiliate_program_members') = 1 and pg_temp.n('public.affiliate_links where is_main') = 1
  and pg_temp.n('public.affiliate_program_acceptances') = 1,
  'an active member cannot join again');

-- The link really works: the click rule resolves it and records the click.
insert into qa select 'ada_click', pg_temp.click('ada', 'acme')::text;
select pg_temp.check((select c->>'click_id' ~ '^[0-9a-f]{48}$' and c->>'destination_url' = 'https://speaksix.com/start'
      and c->'is_bot' = 'false' from (select value::jsonb as c from qa where key = 'ada_click') x)
  and (select count(*) = 1 and bool_and(k.affiliate_id = pg_temp.q('creator_ada') and k.commercial_eligible and not k.is_bot
      and k.product_id = (pg_temp.program('acme')).product_id
      and k.public_click_id = (select value::jsonb->>'click_id' from qa where key = 'ada_click'))
    from public.clicks k where k.affiliate_link_id = (pg_temp.link('ada', 'acme')).id),
  'a click on the link a join issued is recorded and gets a click id for the landing page');
select pg_temp.check((select r.click_id ~ '^[0-9a-f]{48}$' and r.destination_url = 'https://speaksix.com/start'
    from public.register_short_tracking_click('/speaksix/ada-okafor', '{}') r)
  and pg_temp.n(format('public.clicks where affiliate_link_id = %L', (pg_temp.link('ada', 'acme')).id)) = 2,
  'the short address of the link resolves the same way');

select pg_temp.capture('partner_marketplace', pg_temp.call('ada', 'select public.partner_marketplace()'));
select pg_temp.capture('partner_program_detail', pg_temp.call('ada', 'select public.partner_program_detail(''speaksix'')'));
select pg_temp.check((select r->'programs'->1->>'membership_status' = 'active' and r->'programs'->0->'membership_status' = 'null'
    and r->'memberships' = jsonb_build_array((select value::jsonb->'membership' from qa where key = 'ada_joined'))
  from pg_temp.call('ada', 'select public.partner_marketplace()') r)
  and pg_temp.membership('ada', 'acme') = (select value::jsonb->'membership' from qa where key = 'ada_joined')
  and pg_temp.membership('ada_helper', 'acme')->>'status' = 'active',
  'the creator sees the membership in their marketplace and on the program');
select pg_temp.check((select r->'memberships' = '[]' and r->'programs'->1->'membership_status' = 'null'
    from pg_temp.call('ben', 'select public.partner_marketplace()') r)
  and pg_temp.membership('ben', 'acme') = 'null'
  and pg_temp.try('ben', pg_temp.leave_sql('acme')) = '22023 not_a_member'
  and pg_temp.try('ben', pg_temp.accept_sql('acme')) = '22023 not_a_member'
  and (pg_temp.member('ada', 'acme')).status = 'active',
  'another creator sees nothing of that membership and cannot leave it or accept terms for it');

-- The merchant sees who joined -----------------------------------------------------------------------
select pg_temp.capture('creators_one_active', pg_temp.creators('owner', 'acme'));
select pg_temp.check((select r - 'creators' = jsonb_build_object('can_manage', true,
      'program', jsonb_build_object('id', (pg_temp.program('acme')).id, 'slug', 'speaksix', 'name', 'SpeakSix', 'status', 'live',
        'approval_mode', 'automatic', 'marketplace_listed', true),
      'currency', 'USD', 'earn_from', 'sales',
      'totals', '{"clicks":2,"sales":0,"events":0,"sales_amount_minor":0,"commission_minor":0,"pending_minor":0}'::jsonb,
      'counts', '{"pending":0,"active":1,"ended":0}'::jsonb)
    and jsonb_array_length(r->'creators') = 1
    and (r->'creators'->0) - 'requested_at' - 'activated_at' - 'last_click_at' = jsonb_build_object(
      'member_id', (pg_temp.member('ada', 'acme')).id, 'status', 'active', 'name', 'Ada Okafor', 'handle', 'ada-okafor',
      'country_code', 'NG', 'channels', '["tiktok","instagram"]'::jsonb, 'website_url', null,
      'ended_at', null, 'decision_note', null, 'terms_version', 1, 'needs_new_terms', false, 'clicks', 2, 'sales', 0,
      'events', 0, 'sales_amount_minor', 0, 'commission_minor', 0, 'pending_minor', 0)
    and (r->'creators'->0->>'activated_at')::timestamptz = (pg_temp.member('ada', 'acme')).activated_at
    and (r->'creators'->0->>'last_click_at')::timestamptz = (select max(occurred_at) from public.clicks)
  from pg_temp.creators('owner', 'acme') r),
  'the merchant sees the creator with their public profile, clicks and sales');
select pg_temp.check(pg_temp.creators('owner', 'acme')::text !~* 'creators\.example|Ada N\. Okafor',
  'the merchant never sees a creator''s email or legal name');
select pg_temp.check((pg_temp.creators('analyst', 'acme')->>'can_manage')::boolean = false
  and pg_temp.creators('analyst', 'acme')->'creators' = pg_temp.creators('admin', 'acme')->'creators'
  and (pg_temp.creators('admin', 'acme')->>'can_manage')::boolean,
  'every member of the workspace can read the creators; only owners and admins can manage them');
select pg_temp.check(pg_temp.try('rival_owner', format('select public.workspace_program_creators(%L)', pg_temp.q('acme'))) like 'P0002%'
  and pg_temp.try('ada', format('select public.workspace_program_creators(%L)', pg_temp.q('acme'))) like 'P0002%'
  and pg_temp.try('rival_owner', pg_temp.decide_sql('acme', 'ada', 'remove')) like 'P0002%'
  and pg_temp.try('analyst', pg_temp.decide_sql('acme', 'ada', 'remove')) = '42501'
  and pg_temp.try('rival_owner', format('select public.workspace_program_creator_decide(%L, %L)', pg_temp.q('rival'),
    jsonb_build_object('member_id', (pg_temp.member('ada', 'acme')).id, 'action', 'remove'))) = '22023 not_a_member'
  and (pg_temp.member('ada', 'acme')).status = 'active',
  'a member of another workspace cannot see or change these creators, and an analyst cannot change them');
select pg_temp.check(pg_temp.creators('draft_owner', 'draft') - 'program'
    = '{"can_manage":true,"counts":{"pending":0,"active":0,"ended":0},"creators":[],"currency":"USD","earn_from":"sales",
      "totals":{"clicks":0,"sales":0,"events":0,"sales_amount_minor":0,"commission_minor":0,"pending_minor":0}}'::jsonb
  and pg_temp.creators('draft_owner', 'draft')->'program' = jsonb_build_object('id', (pg_temp.program('draft')).id,
    'slug', 'draft-thing', 'name', 'Draft Thing', 'status', 'draft', 'approval_mode', 'automatic', 'marketplace_listed', true),
  'a program that is still a draft has no creators');

-- Approval by the merchant: the request waits ---------------------------------------------------------
select pg_temp.tracking(false);
insert into qa select 'ben_joined', pg_temp.call('ben', pg_temp.join_sql('rival'))::text;
select pg_temp.capture('join_manual', (select value::jsonb from qa where key = 'ben_joined'));
select pg_temp.check((select m @> '{"status":"pending","program_status":"live","terms_version":1,"needs_new_terms":false,
      "link":null,"activated_at":null,"ended_at":null,"decision_note":null}'
    and m->'program'->>'slug' = 'rival-reader' and m->>'program_id' = (pg_temp.program('rival')).id::text
    and (m->>'accepted_at')::timestamptz = (m->>'requested_at')::timestamptz
  from (select value::jsonb->'membership' as m from qa where key = 'ben_joined') j)
  and (select m.status = 'pending' and m.main_link_id is null and m.activated_at is null from pg_temp.member('ben', 'rival') m)
  and (select count(*) = 1 from public.affiliate_links where is_main)
  and (select count(*) = 1 and bool_and(a.accepted_name = 'Ben Creator') from public.affiliate_program_acceptances a
    where a.member_id = (pg_temp.member('ben', 'rival')).id)
  and pg_temp.audits('ben', 'rival', 'affiliate_program_member_requested') = 1,
  'accepting a program that approves each creator records the acceptance and waits; no link is issued, so it needs no tracking');
select pg_temp.check(pg_temp.try('ben', pg_temp.join_sql('rival')) = '22023 already_member', 'a waiting creator cannot ask twice');
select pg_temp.call('cy', pg_temp.join_sql('rival'));
update public.affiliates set public_name = ' ' where id = pg_temp.q('creator_dee');
select pg_temp.check(pg_temp.try('dee', pg_temp.join_sql('rival')) = '22023 invalid_accept_name'
  and (pg_temp.member('dee', 'rival')).id is null, 'a creator with no name on their profile cannot accept an agreement');
update public.affiliates set public_name = 'Dee Vale' where id = pg_temp.q('creator_dee');
select pg_temp.call('dee', pg_temp.join_sql('rival'));
select pg_temp.capture('creators_pending', pg_temp.creators('rival_owner', 'rival'));
select pg_temp.check((select r->'counts' = '{"pending":3,"active":0,"ended":0}'
    and (select array_agg(c->>'handle' order by n) = array['ben-creator', 'cy-park', 'dee-vale']
      from jsonb_array_elements(r->'creators') with ordinality e(c, n))
    and r->'program' @> '{"slug":"rival-reader","approval_mode":"manual","status":"live"}'
    and (r->'creators'->0) - 'member_id' - 'requested_at' = '{"status":"pending","name":"Ben Creator","handle":"ben-creator",
      "country_code":"GB","channels":["youtube"],"website_url":"https://ben.example.com","activated_at":null,"ended_at":null,
      "decision_note":null,"terms_version":1,"needs_new_terms":false,"clicks":0,"sales":0,"events":0,"last_click_at":null,
      "sales_amount_minor":0,"commission_minor":0,"pending_minor":0}'::jsonb
  from pg_temp.creators('rival_owner', 'rival') r),
  'the merchant sees the waiting creators, the oldest request first');

-- What a decision must carry.
select pg_temp.check(pg_temp.try('rival_owner', format('select public.workspace_program_creator_decide(%L, %s)', pg_temp.q('rival'), v.input)) = v.code,
  format('a decision with %s is refused as %s', left(v.input, 70), v.code))
from (values
  ('null', '22023 invalid_input'),
  ('''[]''', '22023 invalid_input'),
  (quote_literal(jsonb_build_object('member_id', (pg_temp.member('ben', 'rival')).id, 'action', 'approve', 'status', 'active')), '22023 invalid_input'),
  ('''{"action":"approve"}''', '22023 invalid_member_id'),
  ('''{"member_id":"nope","action":"approve"}''', '22023 invalid_member_id'),
  ('''{"member_id":7,"action":"approve"}''', '22023 invalid_member_id'),
  (quote_literal(jsonb_build_object('member_id', (pg_temp.member('ben', 'rival')).id)), '22023 invalid_action'),
  (quote_literal(jsonb_build_object('member_id', (pg_temp.member('ben', 'rival')).id, 'action', 'ban')), '22023 invalid_action'),
  (quote_literal(jsonb_build_object('member_id', (pg_temp.member('ben', 'rival')).id, 'action', 'decline', 'note', 7)), '22023 invalid_note'),
  (quote_literal(jsonb_build_object('member_id', (pg_temp.member('ben', 'rival')).id, 'action', 'decline', 'note', repeat('x', 501))),
    '22023 invalid_note'),
  (quote_literal(jsonb_build_object('member_id', gen_random_uuid(), 'action', 'approve')), '22023 not_a_member'),
  (quote_literal(jsonb_build_object('member_id', (pg_temp.member('ada', 'acme')).id, 'action', 'remove')), '22023 not_a_member'),
  (quote_literal(jsonb_build_object('member_id', (pg_temp.member('ben', 'rival')).id, 'action', 'remove')), '22023 status_not_allowed')) v(input, code);
select pg_temp.check(pg_temp.try('draft_owner', format('select public.workspace_program_creator_decide(%L, %L)', pg_temp.q('draft'),
    jsonb_build_object('member_id', (pg_temp.member('ben', 'rival')).id, 'action', 'approve'))) = '22023 not_a_member',
  'a workspace cannot decide on another program''s creator');

-- Approve: tracking must be on, the creator's account active.
select pg_temp.check(pg_temp.try('rival_owner', pg_temp.decide_sql('rival', 'ben', 'approve')) = '22023 tracking_not_enabled'
  and (pg_temp.member('ben', 'rival')).status = 'pending',
  'a creator cannot be approved while tracking is off, because no link could be issued');
select pg_temp.tracking(true);
update public.affiliates set status = 'paused' where id = pg_temp.q('creator_ben');
select pg_temp.check(pg_temp.try('rival_owner', pg_temp.decide_sql('rival', 'ben', 'approve')) = '22023 status_not_allowed'
  and pg_temp.try('ben', 'select public.partner_marketplace()') = '42501',
  'a creator whose account is not active cannot be approved, and cannot use the creator functions');
update public.affiliates set status = 'active' where id = pg_temp.q('creator_ben');
insert into qa select 'ben_approved', pg_temp.call('rival_owner', pg_temp.decide_sql('rival', 'ben', 'approve'))::text;
select pg_temp.capture('decide_approve', (select value::jsonb from qa where key = 'ben_approved'));
select pg_temp.check((select c @> '{"status":"active","handle":"ben-creator","decision_note":null,"ended_at":null,"clicks":0,"sales":0}'
    and c->>'activated_at' is not null and c = pg_temp.creator('rival_owner', 'rival', 'ben-creator')
  from (select value::jsonb->'creator' as c from qa where key = 'ben_approved') x)
  and (select m.status = 'active' and m.decided_by = pg_temp.q('rival_owner') and m.decided_at = m.activated_at
      and m.updated_at = m.activated_at and m.activated_at > m.requested_at from pg_temp.member('ben', 'rival') m)
  and (select l.status = 'active' and l.is_main and l.tracking_environment = 'live' and l.created_by = pg_temp.q('rival_owner')
      and l.product_id = (pg_temp.program('rival')).product_id from pg_temp.link('ben', 'rival') l)
  and (select count(*) = 1 and bool_and(a.actor_user_id = pg_temp.q('rival_owner') and a.actor_type = 'system'
      and a.before_data->>'status' = 'pending' and a.after_data->>'status' = 'active')
    from public.audit_logs a where a.action = 'affiliate_program_member_approved' and a.target_id = (pg_temp.member('ben', 'rival')).id),
  'the merchant approves: the creator becomes active with a main link, and the decision is recorded');
select pg_temp.check((select m @> '{"status":"active","decision_note":null}'
      and m->'link' @> '{"short_url":"https://go.kissmyapps.dev/rival-reader/ben-creator","working":true}'
    from pg_temp.membership('ben', 'rival') m)
  and pg_temp.click('ben', 'rival')->>'click_id' ~ '^[0-9a-f]{48}$'
  and pg_temp.click('ben', 'rival')->>'destination_url' = 'https://rivalreader.co/',
  'the approved creator sees their link, and it records clicks');
select pg_temp.check(pg_temp.try('rival_owner', pg_temp.decide_sql('rival', 'ben', 'approve')) = '22023 status_not_allowed'
  and pg_temp.try('rival_owner', pg_temp.decide_sql('rival', 'ben', 'decline')) = '22023 status_not_allowed',
  'an active creator cannot be approved or declined');

-- Decline, with a note the creator sees.
select pg_temp.check((select c @> '{"status":"declined","handle":"cy-park","decision_note":"Not a fit for our readers.","activated_at":null}'
    and c->>'ended_at' is not null
  from (select pg_temp.call('rival_owner', pg_temp.decide_sql('rival', 'cy', 'decline', '{"note":"  Not a fit for our readers.  "}'))->'creator' as c) x)
  and (select m.status = 'declined' and m.ended_at = m.decided_at and m.decided_by = pg_temp.q('rival_owner') and m.main_link_id is null
    from pg_temp.member('cy', 'rival') m)
  and pg_temp.membership('cy', 'rival') @> '{"status":"declined","decision_note":"Not a fit for our readers.","link":null}'
  and pg_temp.audits('cy', 'rival', 'affiliate_program_member_declined') = 1
  and pg_temp.audit_reason('cy', 'rival', 'affiliate_program_member_declined') = 'Not a fit for our readers.',
  'the merchant declines a waiting creator with a note, and the creator sees it');
select pg_temp.check(pg_temp.try('cy', pg_temp.join_sql('rival')) = '22023 membership_closed'
  and pg_temp.try('cy', pg_temp.leave_sql('rival')) = '22023 not_a_member'
  and pg_temp.try('cy', pg_temp.accept_sql('rival')) = '22023 not_a_member'
  and pg_temp.try('rival_owner', pg_temp.decide_sql('rival', 'cy', 'decline')) = '22023 status_not_allowed'
  and pg_temp.try('rival_owner', pg_temp.decide_sql('rival', 'cy', 'remove')) = '22023 status_not_allowed',
  'a declined creator cannot join again, leave or accept terms; they cannot be declined twice or removed');
select pg_temp.check((select c @> '{"status":"active","decision_note":null,"ended_at":null}'
    from (select pg_temp.call('rival_owner', pg_temp.decide_sql('rival', 'cy', 'approve', '{"note":null}'))->'creator' as c) x)
  and (select l.status = 'active' from pg_temp.link('cy', 'rival') l)
  and pg_temp.membership('cy', 'rival')->'link'->'working' = 'true',
  'the merchant can change their mind and approve a declined creator, which clears the note');

-- Remove: the link goes off; approve again: the same link comes back.
insert into qa select 'ben_link', (pg_temp.link('ben', 'rival')).id::text;
select pg_temp.check((select c @> '{"status":"removed","decision_note":"Posted misleading claims.","clicks":2}' and c->>'ended_at' is not null
    from (select pg_temp.call('rival_owner', pg_temp.decide_sql('rival', 'ben', 'remove', '{"note":"Posted misleading claims."}'))->'creator' as c) x)
  and (select m.status = 'removed' and m.ended_at = m.decided_at and m.main_link_id = pg_temp.q('ben_link') from pg_temp.member('ben', 'rival') m)
  and (select l.status = 'paused' from pg_temp.link('ben', 'rival') l)
  and pg_temp.audits('ben', 'rival', 'affiliate_program_member_removed') = 1,
  'the merchant removes an active creator with a note, and their link is switched off');
select pg_temp.check((select m @> '{"status":"removed","decision_note":"Posted misleading claims."}' and m->'link'->'working' = 'false'
      and m->'link'->>'short_url' = 'https://go.kissmyapps.dev/rival-reader/ben-creator' from pg_temp.membership('ben', 'rival') m)
  and pg_temp.click('ben', 'rival') = '{"click_id":null,"destination_url":"https://rivalreader.co/","is_bot":false}'
  and pg_temp.n(format('public.clicks where affiliate_link_id = %L', pg_temp.q('ben_link'))) = 2
  and pg_temp.try('ben', pg_temp.join_sql('rival')) = '22023 membership_closed',
  'a removed creator''s link still opens the landing page but records nothing, and they cannot join again by themselves');
select pg_temp.check((select c @> '{"status":"active","decision_note":null,"ended_at":null}'
    from (select pg_temp.call('rival_owner', pg_temp.decide_sql('rival', 'ben', 'approve'))->'creator' as c) x)
  and (select m.main_link_id = pg_temp.q('ben_link') and m.ended_at is null and m.activated_at < m.decided_at from pg_temp.member('ben', 'rival') m)
  and (select l.status = 'active' from pg_temp.link('ben', 'rival') l)
  and pg_temp.n(format('public.affiliate_links where is_main and affiliate_id = %L', pg_temp.q('creator_ben'))) = 1
  and pg_temp.click('ben', 'rival')->>'click_id' ~ '^[0-9a-f]{48}$'
  and pg_temp.audits('ben', 'rival', 'affiliate_program_member_approved') = 2,
  'approving a removed creator again switches the same link back on; the first activation date is kept');
-- An archived link (KissMyApps can archive any link) comes back the same way.
select pg_temp.call('rival_owner', pg_temp.decide_sql('rival', 'ben', 'remove'));
select set_config('request.jwt.claims', '', true);
update public.affiliate_links set status = 'archived' where id = pg_temp.q('ben_link');
select pg_temp.check(pg_temp.membership('ben', 'rival') @> '{"status":"removed","decision_note":null}'
  and pg_temp.call('rival_owner', pg_temp.decide_sql('rival', 'ben', 'approve'))->'creator'->>'status' = 'active'
  and (select l.id = pg_temp.q('ben_link') and l.status = 'active' and l.archived_at is null from pg_temp.link('ben', 'rival') l)
  and pg_temp.n(format('public.affiliate_links where is_main and affiliate_id = %L', pg_temp.q('creator_ben'))) = 1,
  'a removal without a note clears the old one, and a link that was archived meanwhile is restored instead of replaced');

-- Leave, and join again -----------------------------------------------------------------------------------
insert into qa select 'ada_link', (pg_temp.link('ada', 'acme')).id::text;
insert into qa select 'ada_first_request', (pg_temp.member('ada', 'acme')).requested_at::text;
select pg_temp.check(pg_temp.try('ada_helper', pg_temp.leave_sql('acme')) = '42501'
  and pg_temp.try('ada', 'select public.partner_program_leave(''{}'')') = '22023 invalid_program_id'
  and pg_temp.try('ada', 'select public.partner_program_leave(''{"program_id":"nope"}'')') = '22023 invalid_program_id'
  and pg_temp.try('ada', 'select public.partner_program_leave(null)') = '22023 invalid_input'
  and pg_temp.try('ada', format('select public.partner_program_leave(%L)', jsonb_build_object('program_id', gen_random_uuid())))
    = 'P0002 program_not_found'
  and pg_temp.try('ada', format('select public.partner_program_leave(%L)',
    jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'reason', 'bored'))) = '22023 invalid_input'
  and pg_temp.try('ada', format('select public.partner_program_leave(%L)',
    jsonb_build_object('program_id', (pg_temp.program('draft')).id))) = 'P0002 program_not_found'
  and pg_temp.try('ada', pg_temp.leave_sql('rival')) = '22023 not_a_member'
  and (pg_temp.member('ada', 'acme')).status = 'active',
  'leaving needs the owner of the creator account, a program id and a membership');
insert into qa select 'ada_left', pg_temp.call('ada', pg_temp.leave_sql('acme'))::text;
select pg_temp.capture('leave', (select value::jsonb from qa where key = 'ada_left'));
select pg_temp.check((select m @> '{"status":"left","program_status":"live","decision_note":null}' and m->>'ended_at' is not null
      and m->'link' @> '{"short_url":"https://go.kissmyapps.dev/speaksix/ada-okafor","working":false}'
    from (select value::jsonb->'membership' as m from qa where key = 'ada_left') x)
  and (select m.status = 'left' and m.ended_at = m.updated_at and m.decided_by is null and m.main_link_id = pg_temp.q('ada_link')
    from pg_temp.member('ada', 'acme') m)
  and (select l.status = 'paused' from pg_temp.link('ada', 'acme') l)
  and (select count(*) = 1 and bool_and(a.actor_type = 'affiliate' and a.actor_user_id = pg_temp.q('ada')
      and a.before_data->>'status' = 'active' and a.after_data->>'status' = 'left')
    from public.audit_logs a where a.action = 'affiliate_program_member_left' and a.target_id = (pg_temp.member('ada', 'acme')).id),
  'a creator leaves: the membership ends and the link is switched off');
select pg_temp.check(pg_temp.click('ada', 'acme') = '{"click_id":null,"destination_url":"https://speaksix.com/start","is_bot":false}'
  and pg_temp.n(format('public.clicks where affiliate_link_id = %L', pg_temp.q('ada_link'))) = 2
  and pg_temp.try('ada', pg_temp.leave_sql('acme')) = '22023 not_a_member'
  and pg_temp.try('ada', pg_temp.accept_sql('acme')) = '22023 not_a_member'
  and pg_temp.try('owner', pg_temp.decide_sql('acme', 'ada', 'approve')) = '22023 status_not_allowed'
  and pg_temp.try('owner', pg_temp.decide_sql('acme', 'ada', 'remove')) = '22023 status_not_allowed'
  and pg_temp.creators('owner', 'acme')->'counts' = '{"pending":0,"active":0,"ended":1}'
  and pg_temp.call('ada', 'select public.partner_marketplace()')->'programs'->1->>'membership_status' = 'left',
  'after leaving the link redirects untracked; the creator cannot leave twice and the merchant cannot bring them back');
select pg_temp.check((select m @> '{"status":"active","terms_version":1,"ended_at":null}' and m->'link'->'working' = 'true'
      and m->'link'->>'url' = (pg_temp.link('ada', 'acme')).tracking_url
    from (select pg_temp.call('ada', pg_temp.join_sql('acme'))->'membership' as m) x)
  and (select m.status = 'active' and m.main_link_id = pg_temp.q('ada_link') and m.ended_at is null
      and m.requested_at > (select value::timestamptz from qa where key = 'ada_first_request')
      and m.activated_at = (select value::timestamptz from qa where key = 'ada_first_request') from pg_temp.member('ada', 'acme') m)
  and (select l.status = 'active' from pg_temp.link('ada', 'acme') l)
  and pg_temp.n(format('public.affiliate_links where is_main and affiliate_id = %L', pg_temp.q('creator_ada'))) = 1
  and pg_temp.n(format('public.affiliate_program_acceptances where member_id = %L', (pg_temp.member('ada', 'acme')).id)) = 1
  and pg_temp.n(format('public.affiliate_program_acceptances where member_id = %L and accepted_at = %L',
    (pg_temp.member('ada', 'acme')).id, (select value::timestamptz from qa where key = 'ada_first_request'))) = 1
  and pg_temp.audits('ada', 'acme', 'affiliate_program_member_joined') = 2
  and pg_temp.click('ada', 'acme')->>'click_id' ~ '^[0-9a-f]{48}$',
  'joining again gives back the same link, working; the same version of the terms is not accepted twice');
-- A waiting creator can withdraw the request and ask again.
select pg_temp.check(pg_temp.call('dee', pg_temp.leave_sql('rival'))->'membership' @> '{"status":"left","link":null}'
  and pg_temp.call('dee', pg_temp.join_sql('rival'))->'membership' @> '{"status":"pending","link":null,"ended_at":null}'
  and pg_temp.audits('dee', 'rival', 'affiliate_program_member_requested') = 2
  and pg_temp.n(format('public.affiliate_program_acceptances where member_id = %L', (pg_temp.member('dee', 'rival')).id)) = 1,
  'a waiting creator can withdraw their request and ask again');

-- The Creator counts ------------------------------------------------------------------------------------------
select pg_temp.click('ada', 'acme', '{"is_bot":true}');
insert into public.program_sales(program_id, connection_id, account_id, payment_intent_id, amount_minor, currency, paid_at,
  click_id, click_record_id, affiliate_id, match_source)
select (pg_temp.program('acme')).id, c.id, c.account_id, 'pi_join' || n, 4900, 'USD', now(), k.public_click_id, k.id, k.affiliate_id, 'metadata'
from public.merchant_connections c, generate_series(1, 2) n,
  (select * from public.clicks where affiliate_link_id = pg_temp.q('ada_link') and not is_bot order by created_at limit 1) k
where c.account_id = 'acct_SpeakSix';
insert into public.program_sales(program_id, connection_id, account_id, payment_intent_id, amount_minor, currency, paid_at)
select (pg_temp.program('acme')).id, c.id, c.account_id, 'pi_joinplain', 4900, 'USD', now()
from public.merchant_connections c where c.account_id = 'acct_SpeakSix';
select pg_temp.check((select c @> '{"clicks":3,"sales":2}'
      and (c->>'last_click_at')::timestamptz = (select max(k.occurred_at) from public.clicks k
        where k.affiliate_link_id = pg_temp.q('ada_link') and not k.is_bot)
    from pg_temp.creator('owner', 'acme', 'ada-okafor') c)
  and (select count(*) = 4 from public.clicks where affiliate_link_id = pg_temp.q('ada_link'))
  and pg_temp.creator('rival_owner', 'rival', 'ben-creator') @> '{"clicks":3,"sales":0}',
  'clicks count the visits on the creator''s link that are not bots; sales count the program''s sales credited to the creator');

-- Newer terms ----------------------------------------------------------------------------------------------------
insert into qa select 'acme_v1', pg_temp.shown('acme')::text;
-- An edit that is saved but not published changes the card only where the card is the program row.
select pg_temp.call('owner', format('select public.workspace_program_save(%L, %L)', pg_temp.q('acme'),
  jsonb_build_object('tagline', 'Six weeks to confident English.', 'commission_rate_bps', 4000, 'hold_days', 14,
    'approval_mode', 'manual', 'landing_url', 'https://speaksix.com/go', 'revision', (pg_temp.program('acme')).revision)));
select pg_temp.check((select d->'program' @> '{"tagline":"Six weeks to confident English.","landing_url":"https://speaksix.com/go",
      "commission_rate_bps":3000,"hold_days":30,"approval_mode":"automatic","terms_version":1}'
    and d->'program'->'agreement' = (select t.agreement from public.affiliate_program_terms t
      where t.program_id = (pg_temp.program('acme')).id and t.version = 1)
    and d->'program'->'agreement'->'summary'->0->>'value' = '30% of every payment for 12 months'
  from pg_temp.service('select public.marketplace_program(''speaksix'')') d)
  and pg_temp.service('select public.marketplace_programs()')->'programs'->1
    @> '{"tagline":"Six weeks to confident English.","commission_rate_bps":3000,"hold_days":30,"approval_mode":"automatic"}'
  and pg_temp.creators('owner', 'acme')->'program'->>'approval_mode' = 'automatic'
  and pg_temp.membership('ada', 'acme') @> '{"needs_new_terms":false,"terms_version":1}'
  and (select pg_temp.call('cy', format('select public.partner_program_join(%L)', jsonb_build_object('slug', d->'program'->'slug',
        'terms_version', d->'program'->'terms_version', 'agreement_sha256', d->'program'->'agreement_sha256')))->'membership'
      @> '{"status":"active","terms_version":1}'
    from pg_temp.call('cy', 'select public.partner_program_detail(''speaksix'')') d),
  'while edits are unpublished the card keeps the published commission and options, and a join with what the program page '
    || 'showed still follows the published terms');
select pg_temp.publish('owner', 'acme', '{"landing_url":"https://speaksix.com/start"}');
select pg_temp.check((pg_temp.program('acme')).live_terms_version = 2
  and pg_temp.service('select public.marketplace_program(''speaksix'')')->'program'
    @> '{"commission_rate_bps":4000,"hold_days":14,"approval_mode":"manual","terms_version":2}'
  and pg_temp.creators('owner', 'acme')->'program'->>'approval_mode' = 'manual',
  'publishing makes version 2 the card''s terms');
select pg_temp.check((select m @> '{"status":"active","terms_version":1,"needs_new_terms":true}' and m->'link'->'working' = 'true'
      and m->'program' @> '{"terms_version":2,"commission_rate_bps":4000}' from pg_temp.membership('ada', 'acme') m)
  and pg_temp.creator('owner', 'acme', 'ada-okafor') @> '{"status":"active","terms_version":1,"needs_new_terms":true}'
  and (pg_temp.member('ada', 'acme')).terms_version = 1
  and pg_temp.click('ada', 'acme')->>'click_id' ~ '^[0-9a-f]{48}$',
  'a new version changes nothing for a member until they accept it: they stay active on the version they accepted');
select pg_temp.check(
  pg_temp.try('ada', format('select public.partner_program_accept_terms(%L)', (select value::jsonb - 'slug' from qa where key = 'acme_v1')
    || jsonb_build_object('program_id', (pg_temp.program('acme')).id))) = '40001 terms_changed'
  and pg_temp.try('ada', pg_temp.accept_sql('acme', jsonb_build_object('agreement_sha256', repeat('b', 64)))) = '40001 terms_changed'
  and pg_temp.try('ada', pg_temp.accept_sql('acme', '{"terms_version":"2"}')) = '22023 invalid_terms_version'
  and pg_temp.try('ada', pg_temp.accept_sql('acme', '{"agreement_sha256":null}')) = '22023 invalid_agreement_sha256'
  and pg_temp.try('ada', pg_temp.accept_sql('acme', '{"slug":"speaksix"}')) = '22023 invalid_input'
  and pg_temp.try('ada', pg_temp.accept_sql('acme', '{"program_id":"nope"}')) = '22023 invalid_program_id'
  and pg_temp.try('ada', pg_temp.accept_sql('acme', jsonb_build_object('program_id', gen_random_uuid()))) = 'P0002 program_not_found'
  and pg_temp.try('ada_helper', pg_temp.accept_sql('acme')) = '42501'
  and pg_temp.try('ben', pg_temp.accept_sql('acme')) = '22023 not_a_member'
  and pg_temp.try('dee', format('select public.partner_program_join(%L)', (select value::jsonb from qa where key = 'acme_v1')))
    = '40001 terms_changed'
  and (pg_temp.member('ada', 'acme')).terms_version = 1,
  'accepting or joining with the version that was replaced is refused as changed terms');
-- The request is built only from what the program page returned: the program's id, the
-- version and the hash that were shown.
insert into qa select 'ada_accepted', pg_temp.call('ada', format('select public.partner_program_accept_terms(%L)',
  jsonb_build_object('program_id', d->'program'->'id', 'terms_version', d->'program'->'terms_version',
    'agreement_sha256', d->'program'->'agreement_sha256')))::text
from pg_temp.call('ada', 'select public.partner_program_detail(''speaksix'')') d;
select pg_temp.capture('accept_terms', (select value::jsonb from qa where key = 'ada_accepted'));
select pg_temp.check((select m @> '{"status":"active","terms_version":2,"needs_new_terms":false}' and m->'link'->'working' = 'true'
      and (m->>'accepted_at')::timestamptz > (m->>'requested_at')::timestamptz
    from (select value::jsonb->'membership' as m from qa where key = 'ada_accepted') x)
  and (select array_agg(a.terms_version order by a.accepted_at) = array[1, 2]
      and bool_and(a.accepted_name = 'Ada N. Okafor' and a.accepted_by = pg_temp.q('ada'))
      and bool_and(a.agreement_sha256 = (select t.agreement_sha256 from public.affiliate_program_terms t
        where t.program_id = a.program_id and t.version = a.terms_version))
    from public.affiliate_program_acceptances a where a.member_id = (pg_temp.member('ada', 'acme')).id)
  and (select m.terms_version = 2 and m.status = 'active' and m.main_link_id = pg_temp.q('ada_link') from pg_temp.member('ada', 'acme') m)
  and pg_temp.audits('ada', 'acme', 'affiliate_program_member_terms_accepted') = 1
  and pg_temp.creator('owner', 'acme', 'ada-okafor') @> '{"terms_version":2,"needs_new_terms":false}',
  'the member accepts version 2: a second acceptance is recorded and nothing else about the membership changes');
select pg_temp.check(pg_temp.call('ada', pg_temp.accept_sql('acme')) = (select value::jsonb from qa where key = 'ada_accepted')
  and pg_temp.n(format('public.affiliate_program_acceptances where member_id = %L', (pg_temp.member('ada', 'acme')).id)) = 2
  and pg_temp.audits('ada', 'acme', 'affiliate_program_member_terms_accepted') = 1,
  'accepting the version already accepted changes nothing');
-- Version 2 approves each creator, so a new join now waits; members who joined before stay active.
select pg_temp.check(pg_temp.call('dee', pg_temp.join_sql('acme'))->'membership' @> '{"status":"pending","terms_version":2,"link":null}'
  and (pg_temp.member('cy', 'acme')).status = 'active'
  and pg_temp.creators('owner', 'acme')->'counts' = '{"pending":1,"active":2,"ended":0}',
  'once the published terms say the merchant approves each creator, a new join waits');
-- A pending member can accept newer terms too, and stays pending.
select pg_temp.publish('owner', 'acme', '{"hold_days":21}');
select pg_temp.check(pg_temp.membership('dee', 'acme') @> '{"status":"pending","terms_version":2,"needs_new_terms":true}'
  and pg_temp.call('dee', pg_temp.accept_sql('acme'))->'membership' @> '{"status":"pending","terms_version":3,"needs_new_terms":false,"link":null}'
  and pg_temp.call('owner', pg_temp.decide_sql('acme', 'cy', 'remove'))->'creator' @> '{"status":"removed","terms_version":1,"needs_new_terms":true}'
  and pg_temp.call('owner', pg_temp.decide_sql('acme', 'cy', 'approve'))->'creator' @> '{"status":"active","terms_version":1,"needs_new_terms":true}',
  'a waiting creator can accept newer terms and keeps waiting; approving a creator does not accept terms for them');

-- The acceptances never change.
do $$
begin
  begin
    update public.affiliate_program_acceptances set accepted_name = 'Someone Else';
    raise exception 'an acceptance was edited';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%append-only' then raise; end if;
  end;
  begin
    delete from public.affiliate_program_acceptances;
    raise exception 'an acceptance was deleted';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%append-only' then raise; end if;
  end;
  perform pg_temp.check(true, 'an acceptance can be neither edited nor deleted');
end $$;

-- A paused program ------------------------------------------------------------------------------------------------
select pg_temp.set_status('owner', 'acme', 'paused');
select pg_temp.check((select array_agg(c->>'slug') = array['rival-reader'] from jsonb_array_elements(
      pg_temp.service('select public.marketplace_programs()')->'programs') c)
  and pg_temp.service('select public.marketplace_program(''speaksix'')')->'program' @> '{"slug":"speaksix","status":"paused"}'
  and (select jsonb_array_length(r->'programs') = 1 and jsonb_array_length(r->'memberships') = 1
      and r->'memberships'->0 @> '{"status":"active","program_status":"paused"}' and r->'memberships'->0->'link'->'working' = 'false'
    from pg_temp.call('ada', 'select public.partner_marketplace()') r)
  and pg_temp.call('ben', 'select public.partner_program_detail(''speaksix'')')->'program'->>'status' = 'paused',
  'a paused program leaves the list but still opens by its address; a member sees that their link is not working');
select pg_temp.check(pg_temp.try('ben', pg_temp.join_sql('acme')) = '22023 program_not_open'
  and pg_temp.try('ada', pg_temp.accept_sql('acme')) = '22023 program_not_open'
  and pg_temp.try('owner', pg_temp.decide_sql('acme', 'dee', 'approve')) = '22023 program_not_open'
  and (pg_temp.member('ben', 'acme')).id is null
  and (pg_temp.member('dee', 'acme')).status = 'pending',
  'nobody can join, accept terms or be approved while the program is paused');
select pg_temp.check(pg_temp.click('ada', 'acme') = '{"click_id":null,"destination_url":"https://speaksix.com/start","is_bot":false}'
  and (select l.status = 'active' from pg_temp.link('ada', 'acme') l),
  'a member''s link stays as it is while the program is paused, and redirects without recording');
select pg_temp.check(pg_temp.call('owner', pg_temp.decide_sql('acme', 'dee', 'decline'))->'creator'->>'status' = 'declined'
  and pg_temp.call('owner', pg_temp.decide_sql('acme', 'cy', 'remove'))->'creator'->>'status' = 'removed'
  and pg_temp.call('cy', pg_temp.leave_sql('rival'))->'membership' @> '{"status":"left"}',
  'the merchant can still decline and remove while paused, and a creator can still leave');
select pg_temp.check((select m->>'program_id' = (pg_temp.program('acme')).id::text
      and pg_temp.call('ada', format('select public.partner_program_leave(%L)', jsonb_build_object('program_id', m->'program_id')))
        ->'membership' @> '{"status":"left","program_status":"paused"}'
    from (select pg_temp.call('ada', 'select public.partner_marketplace()')->'memberships'->0 as m) x)
  and pg_temp.try('ada', pg_temp.join_sql('acme')) = '22023 program_not_open'
  and (pg_temp.link('ada', 'acme')).status = 'paused',
  'the program id on a membership is what leaving takes; a creator who left a paused program cannot come back until it is live');
select pg_temp.set_status('owner', 'acme', 'live');
select pg_temp.check(pg_temp.call('ada', pg_temp.join_sql('acme'))->'membership' @> '{"status":"pending","terms_version":3}'
  and pg_temp.membership('ada', 'acme')->'link'->'working' = 'false'
  and pg_temp.click('ada', 'acme')->'click_id' = 'null'
  and pg_temp.call('owner', pg_temp.decide_sql('acme', 'ada', 'approve'))->'creator' @> '{"status":"active","terms_version":3,"clicks":4}'
  and (pg_temp.member('ada', 'acme')).main_link_id = pg_temp.q('ada_link')
  and pg_temp.membership('ada', 'acme')->'link'->'working' = 'true'
  and pg_temp.click('ada', 'acme')->>'click_id' ~ '^[0-9a-f]{48}$'
  and pg_temp.n(format('public.affiliate_program_acceptances where member_id = %L', (pg_temp.member('ada', 'acme')).id)) = 3,
  'once the program is live again they can ask again under the current terms; their old link stays off until the merchant approves');
select pg_temp.set_status('owner', 'acme', 'paused');
select pg_temp.set_status('owner', 'acme', 'live');
select pg_temp.check(pg_temp.membership('ada', 'acme')->'link'->'working' = 'true'
  and pg_temp.click('ada', 'acme')->>'click_id' ~ '^[0-9a-f]{48}$',
  'when a program is paused and resumed an active member''s link works again with nothing to do');

-- An unlisted program, and a link from the admin flow ------------------------------------------------------------------
-- Dee already has a main link on the product, switched off, as the admin flow would have left
-- it. It is an old one with no short address.
alter table public.affiliate_links disable trigger affiliate_links_allocate_alias;
insert into public.affiliate_links(id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url, is_main, status)
select 'f8000000-0000-4000-8000-000000000001', pg_temp.q('creator_dee'), p.product_id, p.funnel_id, 'Quiet Club · Main',
  'join_fixture_old_main_link', 'https://go.kissmyapps.dev/r/dee-vale/join_fixture_old_main_link', true, 'paused'
from pg_temp.program('quiet') p;
alter table public.affiliate_links enable trigger affiliate_links_allocate_alias;
select pg_temp.check((select not exists (select 1 from jsonb_array_elements(r->'programs') c where c->>'slug' = 'quiet-club')
    from pg_temp.call('ada', 'select public.partner_marketplace()') r)
  and pg_temp.call('ada', 'select public.partner_program_detail(''quiet-club'')')->'program' @> '{"slug":"quiet-club","status":"live"}',
  'an unlisted program is not in a creator''s marketplace but opens by its address');
select pg_temp.check((select m @> '{"status":"active","program_status":"live"}'
      and m->'link' @> '{"short_url":"https://go.kissmyapps.dev/quiet-club/ada-okafor","working":true}'
    from (select pg_temp.call('ada', pg_temp.join_sql('quiet'))->'membership' as m) x)
  and pg_temp.click('ada', 'quiet')->>'destination_url' = 'https://quietclub.io/join'
  and pg_temp.click('ada', 'quiet')->>'click_id' ~ '^[0-9a-f]{48}$'
  and (select jsonb_array_length(r->'memberships') = 2 and r->'memberships'->0->'program'->>'slug' = 'quiet-club'
    from pg_temp.call('ada', 'select public.partner_marketplace()') r),
  'and it can be joined by that address like any other');
select pg_temp.check((select m @> '{"status":"active"}' and m->'link' = '{"url":"https://go.kissmyapps.dev/r/dee-vale/join_fixture_old_main_link",
      "short_url":null,"working":true}'::jsonb
    from (select pg_temp.call('dee', pg_temp.join_sql('quiet'))->'membership' as m) x)
  and (select m.main_link_id = 'f8000000-0000-4000-8000-000000000001' from pg_temp.member('dee', 'quiet') m)
  and (pg_temp.link('dee', 'quiet')).status = 'active'
  and pg_temp.n(format('public.affiliate_links where is_main and affiliate_id = %L and product_id = %L',
    pg_temp.q('creator_dee'), (pg_temp.program('quiet')).product_id)) = 1
  and pg_temp.click('dee', 'quiet')->>'click_id' ~ '^[0-9a-f]{48}$',
  'a creator who already has a main link for the product keeps it: the join switches that link on instead of issuing a '
    || 'second, and a link with no short address is shown without one');

-- What a creator and a merchant see, in order ----------------------------------------------------------------------------
-- Ada: active in Quiet Club and SpeakSix. Dee: active in Quiet Club, waiting at Rival Reader, declined by SpeakSix.
select pg_temp.capture('partner_marketplace_mixed', pg_temp.call('dee', 'select public.partner_marketplace()'));
select pg_temp.check((select array_agg((m->'program'->>'slug') || ':' || (m->>'status') order by n)
      = array['quiet-club:active', 'rival-reader:pending', 'speaksix:declined']
    from jsonb_array_elements(pg_temp.call('dee', 'select public.partner_marketplace()')->'memberships') with ordinality e(m, n))
  and (select array_agg((c->>'slug') || ':' || coalesce(c->>'membership_status', 'none') order by n)
      = array['rival-reader:pending', 'speaksix:declined']
    from jsonb_array_elements(pg_temp.call('dee', 'select public.partner_marketplace()')->'programs') with ordinality e(c, n)),
  'a creator''s memberships come active first, then waiting, then ended, and each card carries their status');
select pg_temp.call('ada', pg_temp.join_sql('rival'));
select pg_temp.call('rival_owner', pg_temp.decide_sql('rival', 'ada', 'approve'));
select pg_temp.call('cy', pg_temp.join_sql('rival'));
select pg_temp.capture('creators_mixed', pg_temp.creators('rival_owner', 'rival'));
select pg_temp.check((select r->'counts' = '{"pending":2,"active":2,"ended":0}'
    and (select array_agg((c->>'handle') || ':' || (c->>'status') order by n)
      = array['dee-vale:pending', 'cy-park:pending', 'ada-okafor:active', 'ben-creator:active']
      from jsonb_array_elements(r->'creators') with ordinality e(c, n))
  from pg_temp.creators('rival_owner', 'rival') r),
  'the merchant sees waiting creators first, oldest request first, then active creators, newest first');
select pg_temp.call('rival_owner', pg_temp.decide_sql('rival', 'cy', 'decline'));
select pg_temp.call('rival_owner', pg_temp.decide_sql('rival', 'ada', 'remove'));
select pg_temp.check((select r->'counts' = '{"pending":1,"active":1,"ended":2}'
    and (select array_agg((c->>'handle') || ':' || (c->>'status') order by n)
      = array['dee-vale:pending', 'ben-creator:active', 'ada-okafor:removed', 'cy-park:declined']
      from jsonb_array_elements(r->'creators') with ordinality e(c, n))
  from pg_temp.creators('rival_owner', 'rival') r),
  'ended creators come last, the most recently ended first');

-- An archived program -------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
update public.affiliate_programs set status = 'archived' where id = (pg_temp.program('quiet')).id;
select pg_temp.check(pg_temp.service('select public.marketplace_program(''quiet-club'')') = '{"program":null}'
  and pg_temp.try('ben', 'select public.partner_program_detail(''quiet-club'')') = 'P0002 program_not_found'
  and (select d->'program'->>'status' = 'archived' and d->'membership' @> '{"status":"active","program_status":"archived"}'
      and d->'membership'->'link'->'working' = 'false'
    from pg_temp.call('ada', 'select public.partner_program_detail(''quiet-club'')') d)
  and pg_temp.try('ben', pg_temp.join_sql('quiet')) = '22023 program_not_open'
  and pg_temp.call('ada', pg_temp.leave_sql('quiet'))->'membership' @> '{"status":"left","program_status":"archived"}'
  and pg_temp.creators('quiet_owner', 'quiet') = '{"can_manage":true,"program":null,"counts":{"pending":0,"active":0,"ended":0},"creators":[],
    "currency":null,"earn_from":"sales",
    "totals":{"clicks":0,"sales":0,"events":0,"sales_amount_minor":0,"commission_minor":0,"pending_minor":0}}'::jsonb
  and pg_temp.try('quiet_owner', pg_temp.decide_sql('quiet', 'dee', 'remove')) = '22023 not_a_member',
  'an archived program is gone for everyone but its members, who can still see their membership and leave');

-- Housekeeping ---------------------------------------------------------------------------------------------------------------
select pg_temp.check((select count(*) >= 25 and bool_and(a.actor_type in ('affiliate', 'system') and a.actor_user_id is not null
      and a.action like 'affiliate\_program\_member\_%' and a.after_data ? 'updated_at')
    from public.audit_logs a where a.target_table = 'affiliate_program_members')
  and (select bool_and((m.status = 'active') = (l.status = 'active' and p.status <> 'archived')
        or (m.status = 'active' and p.status = 'archived'))
    from public.affiliate_program_members m join public.affiliate_programs p on p.id = m.program_id
    join public.affiliate_links l on l.id = m.main_link_id)
  and (select count(*) = count(distinct (l.affiliate_id, l.product_id)) from public.affiliate_links l where l.is_main)
  and (select bool_and(exists (select 1 from public.affiliate_program_acceptances a
      where a.member_id = m.id and a.terms_version = m.terms_version)) from public.affiliate_program_members m),
  'every change is in the audit log with who made it; only active members have a link that is on; nobody has two main '
    || 'links for a product; every member has accepted the version they are on');

select 'ok ' || count(*) || ' program join assertions' from join_assertions;
rollback;
