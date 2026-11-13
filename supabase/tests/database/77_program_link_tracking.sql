-- The base rules of program links (20261115100000_program_membership.sql): who may hold an
-- active link without a signed document or a KissMyApps offer, what a click on such a link
-- does, and when a link that cannot be credited still sends the visitor on. Members, links
-- and programs are inserted directly, in the order a join makes them: link switched off,
-- member active with that link, link switched on. The older agreement and tracking-only
-- paths are set up through their own admin functions and must behave as they did.
begin;
set local time zone 'UTC';
create temporary table link_assertions(label text);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program link tracking assertion failed: %', label; end if;
  insert into link_assertions values (label);
end $$;
-- 'ok', or the error a statement ends with.
create function pg_temp.fails(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- The answer to a question as it would be after a change, without keeping the change.
create function pg_temp.probe(change text, question text) returns text language plpgsql as $$
declare answer text;
begin
  execute change;
  execute question into answer;
  raise exception using errcode = 'KMA77', message = coalesce(answer, 'null');
exception when sqlstate 'KMA77' then
  return sqlerrm;
end $$;
create function pg_temp.id(kind text, n integer) returns uuid language sql immutable as $$
  select (case kind when 'user' then 'a77' when 'workspace' then 'b77' when 'product' then 'c77' when 'funnel' then 'd77'
    when 'program' then 'e77' when 'creator' then 'f77' when 'link' then '177' when 'member' then '277' end
    || '00000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.code(n integer) returns text language sql immutable as $$
  select 'link77fixture' || lpad(n::text, 4, '0')
$$;
create function pg_temp.slug(p_creator integer) returns text language sql stable as $$
  select slug from public.affiliates where id = pg_temp.id('creator', p_creator)
$$;
create function pg_temp.sign_in(p_user integer) returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('sub', pg_temp.id('user', p_user), 'role', 'authenticated')
    || '{"amr":[{"method":"password"}]}'::jsonb)::text, true)
$$;
-- Runs one statement the way a browser does: signed in, as the authenticated role.
create function pg_temp.call(p_user integer, statement text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform pg_temp.sign_in(p_user);
  set local role authenticated;
  execute statement into result;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return result;
exception when others then
  reset role;
  perform set_config('request.jwt.claims', '', true);
  raise;
end $$;
create function pg_temp.run(p_user integer, statement text) returns text language plpgsql as $$
begin
  perform pg_temp.sign_in(p_user);
  set local role authenticated;
  execute statement;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'ok';
exception when others then
  reset role;
  perform set_config('request.jwt.claims', '', true);
  raise;
end $$;
-- A link in the main-link shape. Program links are commercial, live-environment links.
create function pg_temp.new_link(p_link integer, p_creator integer, p_product integer, p_status text,
  p_environment text default 'live', p_commercial boolean default true) returns text language plpgsql as $$
begin
  insert into public.affiliate_links(id, affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
    sub1, is_main, commercial_eligible, tracking_environment, status)
  values (pg_temp.id('link', p_link), pg_temp.id('creator', p_creator), pg_temp.id('product', p_product),
    pg_temp.id('funnel', p_product), 'Main', pg_temp.code(p_link),
    'https://go.kissmyapps.dev/r/' || pg_temp.slug(p_creator) || '/' || pg_temp.code(p_link),
    null, true, p_commercial, p_environment, p_status::public.link_status);
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.set_link(p_link integer, p_status text) returns text language sql as $$
  select pg_temp.fails(format('update public.affiliate_links set status = %L where id = %L', p_status, pg_temp.id('link', p_link)))
$$;
create function pg_temp.link_status(p_link integer) returns text language sql as $$
  select status::text from public.affiliate_links where id = pg_temp.id('link', p_link)
$$;
-- A membership row. The member id is the creator's number.
create function pg_temp.new_member(p_creator integer, p_program integer, p_status text, p_link integer default null)
returns void language sql as $$
  insert into public.affiliate_program_members(id, program_id, affiliate_id, status, terms_version, main_link_id,
    joined_by, activated_at, ended_at)
  values (pg_temp.id('member', p_creator), pg_temp.id('program', p_program), pg_temp.id('creator', p_creator), p_status, 1,
    case when p_link is not null then pg_temp.id('link', p_link) end, pg_temp.id('user', 3),
    case when p_status = 'active' then now() end,
    case when p_status in ('declined', 'removed', 'left') then now() end)
$$;
create function pg_temp.set_member(p_creator integer, p_status text) returns void language sql as $$
  update public.affiliate_program_members
  set status = p_status, ended_at = case when p_status in ('declined', 'removed', 'left') then now() end, updated_at = now()
  where id = pg_temp.id('member', p_creator)
$$;
-- A creator joins a program: the link is made switched off, the member becomes active with
-- it, then the link is switched on. Returns 'ok' or the error of the last step.
create function pg_temp.join(p_creator integer, p_program integer, p_link integer) returns text language plpgsql as $$
declare made text := pg_temp.new_link(p_link, p_creator, p_program, 'paused');
begin
  if made <> 'ok' then return made; end if;
  perform pg_temp.new_member(p_creator, p_program, 'active', p_link);
  return pg_temp.set_link(p_link, 'active');
end $$;
create function pg_temp.set_program(p_program integer, p_status text) returns void language sql as $$
  update public.affiliate_programs
  set status = p_status, pause_reason = case when p_status = 'paused' then 'merchant' end
  where id = pg_temp.id('program', p_program)
$$;
-- A click as tracking-redirect makes it: the service role calls the click function. Returns
-- the single row with how many rows came back, or the error code.
create function pg_temp.click_at(statement text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  set local role service_role;
  execute 'select jsonb_build_object(''rows'', count(*)) || coalesce((jsonb_agg(to_jsonb(c)))->0, ''{}''::jsonb) from '
    || statement || ' c' into result;
  reset role;
  return result;
exception when others then
  reset role;
  return jsonb_build_object('error', sqlstate);
end $$;
create function pg_temp.click(p_creator integer, p_link integer, p_context jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.click_at(format('public.register_tracking_click(%L, %L, %L)', pg_temp.slug(p_creator), pg_temp.code(p_link), p_context))
$$;
create function pg_temp.short_click(p_path text) returns jsonb language sql as $$
  select pg_temp.click_at(format('public.register_short_tracking_click(%L, %L)', p_path, '{}'::jsonb))
$$;
-- True when the answer is a recorded click sent to this address.
create function pg_temp.tracked(answer jsonb, p_destination text) returns boolean language sql as $$
  select coalesce((answer->>'rows')::integer = 1 and answer->>'click_id' ~ '^[a-f0-9]{48}$'
    and answer->>'destination_url' = p_destination, false)
$$;
-- True when the answer is "send the visitor to this address, nothing recorded".
create function pg_temp.untracked(answer jsonb, p_destination text) returns boolean language sql as $$
  select coalesce((answer->>'rows')::integer = 1 and answer ? 'click_id' and jsonb_typeof(answer->'click_id') = 'null'
    and answer->>'destination_url' = p_destination, false)
$$;
create function pg_temp.recorded() returns bigint language sql as $$
  select (select count(*) from public.clicks) + (select count(*) from public.acquisitions)
$$;
create function pg_temp.ready(p_base text default 'https://go.kissmyapps.dev') returns boolean language sql as $$
  select public.platform_tracking_enablement_ready(p_base)
$$;
grant all on link_assertions to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- People ------------------------------------------------------------------------------------
-- 1: a merchant. 2: a KissMyApps owner. 3: the person behind every creator here.
insert into auth.users(id, email, email_confirmed_at) values
  (pg_temp.id('user', 1), 'owner@speaksix.example', now()),
  (pg_temp.id('user', 2), 'owner@kissmyapps.example', now()),
  (pg_temp.id('user', 3), 'creator@creators.example', now());
insert into public.admin_users(user_id, role, active) values (pg_temp.id('user', 2), 'owner', true);
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled)
  values (true, 'https://go.kissmyapps.dev', false)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = false;

-- Products and landing pages ------------------------------------------------------------------
-- 1 to 4 belong to programs A to D. 5 is sold the older way, with a signed agreement and a
-- KissMyApps offer. 6 is a tracking-only product.
insert into public.products(id, slug, name, status)
  select pg_temp.id('product', n), 'link-fixture-' || n, 'Link fixture ' || n, case when n = 6 then 'draft' else 'active' end::public.product_status
  from generate_series(1, 6) n;
insert into public.funnels(id, product_id, key, name, destination_url, status, is_default)
  select pg_temp.id('funnel', n), pg_temp.id('product', n), 'main', 'Main',
    'https://landing-' || n || '.speaksix-app.io/start?plan=pro', 'live', true
  from generate_series(1, 6) n;
create function pg_temp.landing(n integer) returns text language sql immutable as $$
  select 'https://landing-' || n || '.speaksix-app.io/start?plan=pro'
$$;
select pg_temp.check(not pg_temp.ready(),
  'products with landing pages but no program, agreement or offer do not make tracking ready');

-- Programs ------------------------------------------------------------------------------------
-- A: live. B: live, paused later. C: live, archived later. D: paused from the start.
insert into public.analytics_workspaces(id, name, created_by)
  select pg_temp.id('workspace', n), 'Workspace ' || n, pg_temp.id('user', 1) from generate_series(1, 4) n;
insert into public.analytics_workspace_members(workspace_id, user_id, role)
  select pg_temp.id('workspace', n), pg_temp.id('user', 1), 'owner' from generate_series(1, 4) n;
insert into public.affiliate_programs(id, workspace_id, product_id, funnel_id, slug, status, pause_reason, name, category,
    tagline, landing_url, commission_type, commission_rate_bps, commission_duration, live_terms_version,
    first_published_at, created_by)
  select pg_temp.id('program', n), pg_temp.id('workspace', n), pg_temp.id('product', n), pg_temp.id('funnel', n),
    'link-program-' || n, 'paused', 'merchant', 'Program ' || n, 'education', 'A program.', pg_temp.landing(n),
    'percent', 3000, 'lifetime', 1, now() - interval '10 days', pg_temp.id('user', 1)
  from generate_series(1, 4) n;
insert into public.affiliate_program_terms(program_id, version, terms, agreement, agreement_sha256, created_by)
  select pg_temp.id('program', n), 1, '{"attribution_window_days":30}', '{}', repeat('a', 64), pg_temp.id('user', 1)
  from generate_series(1, 4) n;

-- Tracking may be switched on once a live program exists -------------------------------------
select pg_temp.check(not pg_temp.ready(), 'paused programs do not make tracking ready');
select pg_temp.check(
  pg_temp.fails(format('select pg_temp.call(2, %L)', 'select public.configure_admin_tracking(jsonb_build_object(
    ''base_url'', ''https://go.kissmyapps.dev'', ''enabled'', true,
    ''expected_updated_at'', public.get_admin_platform_settings() #>> ''{tracking,updated_at}''))')) like 'P0001%',
  'KissMyApps cannot switch tracking on while no program is live');
select pg_temp.set_program(n, 'live') from generate_series(1, 3) n;
select pg_temp.check(pg_temp.ready(), 'a live program with a live default landing page makes tracking ready');
select pg_temp.check(not pg_temp.ready('https://tracking.example.invalid') and not pg_temp.ready(null),
  'only the canonical tracking address is ever ready');
select pg_temp.check(
  pg_temp.probe('update public.affiliate_programs set status = ''archived'' where status = ''live''',
    'select pg_temp.ready()') = 'false'
  and pg_temp.probe('update public.affiliate_programs set status = ''draft'' where status = ''live''',
    'select pg_temp.ready()') = 'false',
  'archived and draft programs do not make tracking ready');
select pg_temp.check(
  pg_temp.probe(format('update public.products set status = ''archived'' where id in (%L, %L, %L)',
    pg_temp.id('product', 1), pg_temp.id('product', 2), pg_temp.id('product', 3)), 'select pg_temp.ready()') = 'false',
  'a live program whose product is not active does not make tracking ready');
select pg_temp.check(
  pg_temp.probe(format('update public.funnels set destination_url = ''https://localhost/start'' where id in (%L, %L, %L)',
    pg_temp.id('funnel', 1), pg_temp.id('funnel', 2), pg_temp.id('funnel', 3)), 'select pg_temp.ready()') = 'false',
  'a live program whose landing page is not a public https address does not make tracking ready');
select pg_temp.check(
  (pg_temp.call(2, 'select public.configure_admin_tracking(jsonb_build_object(
    ''base_url'', ''https://go.kissmyapps.dev'', ''enabled'', true,
    ''expected_updated_at'', public.get_admin_platform_settings() #>> ''{tracking,updated_at}''))') #>> '{tracking,enabled}')::boolean,
  'KissMyApps switches tracking on through its normal setting once a program is live');
select pg_temp.check((select tracking_enabled from public.platform_settings where singleton), 'and tracking is on');

-- Access --------------------------------------------------------------------------------------
select pg_temp.check(
  not has_table_privilege('anon', 'public.affiliate_program_members', 'select')
  and not has_table_privilege('authenticated', 'public.affiliate_program_members', 'select, insert, update, delete')
  and not has_table_privilege('service_role', 'public.affiliate_program_members', 'select, insert, update, delete')
  and not has_table_privilege('authenticated', 'public.affiliate_program_acceptances', 'select, insert, update, delete')
  and not has_table_privilege('service_role', 'public.affiliate_program_acceptances', 'select, insert, update, delete')
  and (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.affiliate_program_members'::regclass, 'public.affiliate_program_acceptances'::regclass)),
  'the membership tables are closed to every API role');
select pg_temp.check(
  not has_function_privilege('anon', 'kma_internal.program_link_is_ready(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'kma_internal.program_link_is_ready(uuid, uuid)', 'execute')
  and not has_function_privilege('service_role', 'kma_internal.program_link_is_ready(uuid, uuid)', 'execute'),
  'the readiness test of a program link is internal');
select pg_temp.check(
  has_function_privilege('service_role', 'public.register_tracking_click(text, text, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.register_tracking_click(text, text, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.register_tracking_click(text, text, jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.register_short_tracking_click(text, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.register_short_tracking_click(text, jsonb)', 'execute'),
  'only the service role registers clicks, as before');

-- Creators ------------------------------------------------------------------------------------
-- 1 ada: active in A.            2 ben: no membership.          3 cy: pending in A.
-- 4 dee: leaves A.               5 eve: removed from A.         6 fay: link switched off.
-- 7 gus: active in B (paused).   8 hal: active in C (archived). 9 ian: agreement and offer, product 5.
-- 10 jo: tracking-only, product 6.  11 kit: active in D (paused from the start).
insert into public.affiliates(id, public_name, slug, status)
  select pg_temp.id('creator', n::integer), initcap(name), 'trk-' || name, 'active'
  from unnest(array['ada', 'ben', 'cy', 'dee', 'eve', 'fay', 'gus', 'hal', 'ian', 'jo', 'kit']) with ordinality as t(name, n);
-- The readable short alias of a link needs a UTF8 database, which the disposable test
-- cluster may not be. The two aliases this suite uses are written directly below.
alter table public.affiliate_links disable trigger affiliate_links_allocate_alias;

-- Who may hold an active link ----------------------------------------------------------------
select pg_temp.check(pg_temp.join(1, 1, 1) = 'ok' and pg_temp.link_status(1) = 'active',
  'an active member of a live program holds an active main link');
select pg_temp.check(
  not exists (select 1 from public.agreements where affiliate_id = pg_temp.id('creator', 1))
  and not exists (select 1 from public.documents)
  and not exists (select 1 from public.billing_offers where product_id = pg_temp.id('product', 1))
  and (select is_main and commercial_eligible and tracking_environment = 'live' and source_id is null
      and campaign_id is null and sub1 is null and parent_link_id is null
    from public.affiliate_links where id = pg_temp.id('link', 1)),
  'that link is an ordinary commercial main link with no agreement document and no KissMyApps offer behind it');
select pg_temp.check(
  kma_internal.program_link_is_ready(pg_temp.id('creator', 1), pg_temp.id('product', 1))
  and not kma_internal.program_link_is_ready(pg_temp.id('creator', 1), pg_temp.id('product', 2))
  and not kma_internal.program_link_is_ready(pg_temp.id('creator', 2), pg_temp.id('product', 1))
  and not kma_internal.program_link_is_ready(pg_temp.id('creator', 1), pg_temp.id('product', 5))
  and not kma_internal.program_link_is_ready(null, pg_temp.id('product', 1)),
  'a program link is ready only for that creator and that program''s product');

select pg_temp.check(
  pg_temp.new_link(2, 2, 1, 'active') like 'P0001%'
  and pg_temp.new_link(2, 2, 1, 'paused') = 'ok'
  and pg_temp.set_link(2, 'active') like 'P0001%' and pg_temp.link_status(2) = 'paused',
  'a creator who is not a member cannot hold an active link');

select pg_temp.new_member(3, 1, 'pending');
select pg_temp.check(
  pg_temp.new_link(3, 3, 1, 'active') like 'P0001%'
  and pg_temp.new_link(3, 3, 1, 'paused') = 'ok'
  and pg_temp.set_link(3, 'active') like 'P0001%' and pg_temp.link_status(3) = 'paused',
  'a member who is still waiting for approval cannot hold an active link');
select pg_temp.check(
  pg_temp.fails(format('update public.affiliate_program_members set status = ''active'' where id = %L', pg_temp.id('member', 3))) like '23514%',
  'a member cannot be active without a main link');

select pg_temp.check(pg_temp.new_link(11, 11, 4, 'paused') = 'ok', 'a switched-off link needs no readiness');
select pg_temp.new_member(11, 4, 'active', 11);
select pg_temp.check(
  pg_temp.set_link(11, 'active') like 'P0001%' and pg_temp.link_status(11) = 'paused'
  and not kma_internal.program_link_is_ready(pg_temp.id('creator', 11), pg_temp.id('product', 4)),
  'a link cannot be switched on while its program is paused');
select pg_temp.check(
  pg_temp.probe(format('update public.affiliate_programs set status = ''live'', pause_reason = null where id = %L', pg_temp.id('program', 4)),
    format('select pg_temp.set_link(11, %L)', 'active')) = 'ok',
  'the same link switches on once the program is live');

select pg_temp.check(
  pg_temp.new_link(12, 1, 1, 'active', 'test') like 'P0001%'
  and pg_temp.new_link(12, 1, 1, 'paused', 'test') = 'ok'
  and pg_temp.set_link(12, 'active') like 'P0001%' and pg_temp.link_status(12) = 'paused',
  'a membership does not unlock a link of the test environment');
-- Two link rules refuse it; each one does so on its own.
select pg_temp.check(
  pg_temp.probe('alter table public.affiliate_links disable trigger affiliate_links_validate_billing_readiness',
    format('select pg_temp.set_link(12, %L)', 'active')) like 'P0001%'
  and pg_temp.probe('alter table public.affiliate_links disable trigger affiliate_links_validate',
    format('select pg_temp.set_link(12, %L)', 'active')) like 'P0001%',
  'the link rule and the offer rule each keep a test-environment link off on their own');
select pg_temp.check(
  pg_temp.new_link(13, 1, 1, 'active', 'live', false) like '23514%',
  'a program link cannot be issued as a tracking-only link');
select pg_temp.check(
  pg_temp.new_link(14, 1, 1, 'paused') like '23505%',
  'a creator still has one current main link per product');
select pg_temp.check(
  pg_temp.fails(format('update public.affiliate_links set product_id = %L, funnel_id = %L where id = %L',
    pg_temp.id('product', 2), pg_temp.id('funnel', 2), pg_temp.id('link', 1))) like 'P0001%',
  'an issued program link cannot be moved to another product');

-- More members of A, B and C, joined while their programs are live.
select pg_temp.check(
  pg_temp.join(4, 1, 4) = 'ok' and pg_temp.join(5, 1, 5) = 'ok' and pg_temp.join(6, 1, 6) = 'ok'
  and pg_temp.join(7, 2, 7) = 'ok' and pg_temp.join(8, 3, 8) = 'ok',
  'creators join live programs A, B and C');
insert into kma_internal.tracking_link_aliases(link_id, path) values
  (pg_temp.id('link', 1), '/link-fixture-1/trk-ada'), (pg_temp.id('link', 7), '/link-fixture-2/trk-gus');

-- Each acceptance of the agreement is kept as written.
insert into public.affiliate_program_acceptances(member_id, program_id, terms_version, agreement_sha256, accepted_by, accepted_name)
  values (pg_temp.id('member', 1), pg_temp.id('program', 1), 1, repeat('a', 64), pg_temp.id('user', 3), 'Ada');
select pg_temp.check(
  pg_temp.fails('update public.affiliate_program_acceptances set accepted_name = ''Someone else''') <> 'ok'
  and pg_temp.fails('delete from public.affiliate_program_acceptances') <> 'ok'
  and pg_temp.fails(format('insert into public.affiliate_program_acceptances(member_id, program_id, terms_version, agreement_sha256, accepted_by, accepted_name)
    values (%L, %L, 1, repeat(''b'', 64), %L, ''Ada'')', pg_temp.id('member', 1), pg_temp.id('program', 1), pg_temp.id('user', 3))) like '23505%'
  and (select count(*) = 1 from public.affiliate_program_acceptances),
  'an acceptance cannot be changed, removed or repeated for the same version');

-- A click on a working program link ------------------------------------------------------------
create temporary table seen(name text primary key, answer jsonb, recorded_before bigint);
grant all on seen to anon, authenticated, service_role;
insert into seen select 'ada', pg_temp.click(1, 1, jsonb_build_object('country_code', 'NG',
  'session_id_hash', repeat('1', 64), 'user_agent_hash', repeat('2', 64), 'ip_hash', repeat('3', 64), 'is_bot', false)), 0;
select pg_temp.check(pg_temp.tracked(answer, pg_temp.landing(1)) and (answer->>'is_bot')::boolean = false,
  'a click on an active member''s link returns a click id and the program''s landing page') from seen where name = 'ada';
select pg_temp.check(
  (select count(*) = 1 and bool_and(c.affiliate_link_id = pg_temp.id('link', 1) and c.affiliate_id = pg_temp.id('creator', 1)
      and c.product_id = pg_temp.id('product', 1) and c.funnel_id = pg_temp.id('funnel', 1)
      and c.destination_url_snapshot = pg_temp.landing(1) and c.country_code = 'NG'
      and c.session_id_hash = repeat('1', 64) and c.ip_hash = repeat('3', 64) and not c.is_bot and c.commercial_eligible)
    from public.clicks c where c.public_click_id = (select answer->>'click_id' from seen where name = 'ada'))
  and (select count(*) = 1 and bool_and(a.status = 'open' and a.affiliate_id = pg_temp.id('creator', 1) and a.commercial_eligible
      and a.attribution_method = 'deterministic_web')
    from public.acquisitions a join public.clicks c on c.id = a.click_record_id
    where c.public_click_id = (select answer->>'click_id' from seen where name = 'ada')),
  'the click and its open acquisition are recorded like any other creator click');
insert into seen select 'ada_bot', pg_temp.click(1, 1, '{"is_bot":true}'), 0;
select pg_temp.check(
  pg_temp.tracked(answer, pg_temp.landing(1)) and (answer->>'is_bot')::boolean
  and (select a.status = 'rejected' and a.rejection_reason = 'automated_traffic' and c.is_bot
    from public.clicks c join public.acquisitions a on a.click_record_id = c.id where c.public_click_id = answer->>'click_id'),
  'automated traffic on a program link is recorded and rejected, as on any link') from seen where name = 'ada_bot';
select pg_temp.check(
  pg_temp.tracked(pg_temp.short_click('/link-fixture-1/trk-ada'), pg_temp.landing(1)),
  'the readable short address of a program link records a click the same way');
select pg_temp.check(
  pg_temp.click(1, 1, '{"device":"phone"}') = '{"error":"22023"}'
  and pg_temp.click(1, 1, '{"country_code":"nigeria"}') = '{"error":"22023"}',
  'a click with an unsupported context is refused, as before');
select pg_temp.check(
  (select bool_and(pg_temp.tracked(pg_temp.click(1, 1, jsonb_build_object('session_id_hash', repeat('9', 64))), pg_temp.landing(1)))
    from generate_series(1, 30))
  and pg_temp.click(1, 1, jsonb_build_object('session_id_hash', repeat('9', 64))) = '{"error":"KMA29"}',
  'the per-session click limit applies to program links');

-- A link that cannot be credited still sends the visitor on ----------------------------------
-- Program B is paused: its member's link stays as it is and redirects, untracked.
select pg_temp.check(pg_temp.tracked(pg_temp.click(7, 7), pg_temp.landing(2)), 'a click in program B is credited while it is live');
select pg_temp.set_program(2, 'paused');
insert into seen select 'gus_paused', null, pg_temp.recorded();
update seen set answer = pg_temp.click(7, 7, jsonb_build_object('session_id_hash', repeat('4', 64), 'ip_hash', repeat('5', 64)))
  where name = 'gus_paused';
select pg_temp.check(pg_temp.untracked(answer, pg_temp.landing(2)) and pg_temp.recorded() = recorded_before,
  'a click in a paused program returns the landing page with a null click id and records nothing') from seen where name = 'gus_paused';
select pg_temp.check(pg_temp.link_status(7) = 'active', 'pausing a program leaves its members'' links as they are');
insert into seen select 'gus_short', null, pg_temp.recorded();
update seen set answer = pg_temp.short_click('/link-fixture-2/trk-gus') where name = 'gus_short';
select pg_temp.check(pg_temp.untracked(answer, pg_temp.landing(2)) and pg_temp.recorded() = recorded_before,
  'the short address of a link in a paused program redirects untracked too') from seen where name = 'gus_short';
select pg_temp.check(
  (select bool_and(pg_temp.untracked(pg_temp.click(7, 7, jsonb_build_object('session_id_hash', repeat('4', 64))), pg_temp.landing(2)))
    from generate_series(1, 40)),
  'untracked redirects are not counted against the click limit, since nothing is stored to count');
select pg_temp.set_program(2, 'live');
select pg_temp.check(pg_temp.tracked(pg_temp.click(7, 7), pg_temp.landing(2)),
  'clicks are credited again as soon as the program is live again');

-- The creator left: whether or not the link was switched off yet, nothing is credited.
select pg_temp.set_member(4, 'left');
insert into seen select 'dee_left', null, pg_temp.recorded();
update seen set answer = pg_temp.click(4, 4) where name = 'dee_left';
select pg_temp.check(pg_temp.untracked(answer, pg_temp.landing(1)) and pg_temp.recorded() = recorded_before
    and pg_temp.link_status(4) = 'active',
  'a creator who left is not credited even while the link row is still active') from seen where name = 'dee_left';
select pg_temp.check(pg_temp.set_link(4, 'paused') = 'ok' and pg_temp.untracked(pg_temp.click(4, 4), pg_temp.landing(1)),
  'after the link is switched off it keeps redirecting untracked');
select pg_temp.check(pg_temp.set_link(4, 'active') like 'P0001%' and pg_temp.link_status(4) = 'paused',
  'a creator who left cannot switch the link back on');

-- The merchant removed the creator and the link was switched off.
select pg_temp.set_member(5, 'removed');
select pg_temp.check(pg_temp.set_link(5, 'paused') = 'ok', 'a removed creator''s link is switched off');
insert into seen select 'eve_removed', null, pg_temp.recorded();
update seen set answer = pg_temp.click(5, 5) where name = 'eve_removed';
select pg_temp.check(pg_temp.untracked(answer, pg_temp.landing(1)) and pg_temp.recorded() = recorded_before,
  'a removed creator''s link redirects untracked') from seen where name = 'eve_removed';
-- Approved again: the same member row and the same link work again.
select pg_temp.set_member(5, 'active');
select pg_temp.check(pg_temp.set_link(5, 'active') = 'ok' and pg_temp.tracked(pg_temp.click(5, 5), pg_temp.landing(1)),
  'a creator approved again is credited again through the same link');

-- An active member whose link is switched off, and then archived.
select pg_temp.check(pg_temp.set_link(6, 'paused') = 'ok', 'an active member''s link can be switched off');
insert into seen select 'fay_off', null, pg_temp.recorded();
update seen set answer = pg_temp.click(6, 6) where name = 'fay_off';
select pg_temp.check(pg_temp.untracked(answer, pg_temp.landing(1)) and pg_temp.recorded() = recorded_before,
  'a switched-off link of an active member redirects untracked') from seen where name = 'fay_off';
select pg_temp.check(pg_temp.set_link(6, 'archived') = 'ok' and pg_temp.untracked(pg_temp.click(6, 6), pg_temp.landing(1)),
  'an archived program link redirects untracked');

-- Links on a program's product that were never creditable.
select pg_temp.check(
  pg_temp.untracked(pg_temp.click(2, 2), pg_temp.landing(1)) and pg_temp.untracked(pg_temp.click(3, 3), pg_temp.landing(1)),
  'the switched-off links of a non-member and of a waiting member redirect untracked');
select pg_temp.check(pg_temp.untracked(pg_temp.click(11, 11), pg_temp.landing(4)),
  'a link in a program that was paused before it was ever switched on redirects untracked');
select pg_temp.check(pg_temp.click(1, 12) = '{"error":"P0002"}',
  'a test-environment link on a program''s product is unavailable, not redirected');
-- The link rules already keep a test-environment link switched off. Were one ever active,
-- the click rule on its own still would not credit it.
select pg_temp.check(
  pg_temp.probe(format('alter table public.affiliate_links disable trigger user;
    update public.affiliate_links set status = ''active'' where id = %L', pg_temp.id('link', 12)),
    'select pg_temp.link_status(12) || '' '' || pg_temp.click(1, 12)::text') = 'active {"error": "P0002"}',
  'a membership never credits a click on a test-environment link');

-- A creator whose account is not active: no credit, the visitor is still sent on.
select pg_temp.check(
  pg_temp.probe(format('update public.affiliates set status = ''paused'' where id = %L', pg_temp.id('creator', 1)),
    'select pg_temp.untracked(pg_temp.click(1, 1), pg_temp.landing(1))::text') = 'true',
  'a paused creator account''s program link redirects untracked');
-- Tracking switched off for the whole platform: nothing is recorded anywhere.
select pg_temp.check(
  pg_temp.probe('update public.platform_settings set tracking_enabled = false',
    'select (pg_temp.untracked(pg_temp.click(1, 1), pg_temp.landing(1)) and pg_temp.recorded() = ' || pg_temp.recorded() || ')::text') = 'true',
  'with platform tracking off a program link redirects untracked');

-- What stays unavailable ---------------------------------------------------------------------
select pg_temp.check(pg_temp.tracked(pg_temp.click(8, 8), pg_temp.landing(3)), 'a click in program C is credited while it is live');
select pg_temp.set_program(3, 'archived');
insert into seen select 'hal_archived', null, pg_temp.recorded();
update seen set answer = pg_temp.click(8, 8) where name = 'hal_archived';
select pg_temp.check(answer = '{"error":"P0002"}' and pg_temp.recorded() = recorded_before,
  'a link of an archived program is unavailable') from seen where name = 'hal_archived';
select pg_temp.check(pg_temp.set_link(8, 'paused') = 'ok' and pg_temp.click(8, 8) = '{"error":"P0002"}',
  'and stays unavailable when it is switched off');
select pg_temp.check(
  pg_temp.click_at(format('public.register_tracking_click(%L, %L, %L)', 'trk-ada', 'link77fixture9999', '{}'::jsonb)) = '{"error":"P0002"}'
  and pg_temp.click_at(format('public.register_tracking_click(%L, %L, %L)', 'trk-nobody', pg_temp.code(1), '{}'::jsonb)) = '{"error":"P0002"}'
  and pg_temp.click_at(format('public.register_tracking_click(%L, %L, %L)', 'trk-ben', pg_temp.code(1), '{}'::jsonb)) = '{"error":"P0002"}'
  and pg_temp.click_at(format('public.register_tracking_click(%L, %L, %L)', 'trk-gus', pg_temp.code(1), '{}'::jsonb)) = '{"error":"P0002"}'
  and pg_temp.short_click('/link-fixture-1/trk-nobody') = '{"error":"P0002"}',
  'an unknown code, an unknown creator and a code under another creator''s name are unavailable');
select pg_temp.check(
  pg_temp.click_at(format('public.register_tracking_click(%L, %L, %L)', '', pg_temp.code(1), '{}'::jsonb)) = '{"error":"22023"}'
  and pg_temp.click_at(format('public.register_tracking_click(%L, %L, %L)', 'trk-ada', '  ', '{}'::jsonb)) = '{"error":"22023"}',
  'a click without a creator or a code is refused, as before');

-- The agreement-and-offer path behaves as before ------------------------------------------------
-- Product 5 has no program. Its creator needs a signed, countersigned, active agreement and
-- KissMyApps needs a live-verified offer before the link may be active.
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at)
  values (pg_temp.id('creator', 9), pg_temp.id('user', 3), 'owner', true, false, now());
insert into public.agreements(id, affiliate_id, product_id, version, model, status)
  values ('37700000-0000-4000-8000-000000000001', pg_temp.id('creator', 9), pg_temp.id('product', 5), 1, 'cpa', 'draft');
insert into public.commission_rules(agreement_id, name, model, trigger_event, fixed_amount_minor, currency, status)
  values ('37700000-0000-4000-8000-000000000001', 'Purchase', 'cpa', 'purchase.completed', 100, 'USD', 'active');
insert into storage.objects(id, bucket_id, name, metadata, version)
  values ('47700000-0000-4000-8000-000000000001', 'affiliate-private-documents',
    pg_temp.id('creator', 9) || '/agreements/terms.pdf', '{"mimetype":"application/pdf","size":100,"eTag":"fixture"}', 'fixture-version');
select pg_temp.check(
  pg_temp.new_link(9, 9, 5, 'active') like 'P0001%' and pg_temp.new_link(9, 9, 5, 'paused') = 'ok'
  and pg_temp.set_link(9, 'active') like 'P0001%',
  'without a ready agreement a link outside any program cannot be active');
select pg_temp.check(pg_temp.click(9, 9) = '{"error":"P0002"}',
  'a switched-off link on a product without a program is unavailable, not redirected');
create temporary table old_path(name text primary key, value jsonb);
grant all on old_path to anon, authenticated, service_role;
insert into old_path select 'document', pg_temp.call(2, format('select public.create_admin_agreement_document(%L)',
  jsonb_build_object('agreement_id', '37700000-0000-4000-8000-000000000001', 'name', 'Creator terms',
    'file_path', pg_temp.id('creator', 9) || '/agreements/terms.pdf', 'content_sha256', repeat('a', 64))));
select pg_temp.check(
  pg_temp.run(3, format('select public.partner_sign_agreement_document(%L)',
    jsonb_build_object('document_id', value->>'id', 'legal_name', 'Ian Creator', 'acknowledged', true))) = 'ok'
  and pg_temp.run(2, format('select public.admin_countersign_agreement_document(%L)', jsonb_build_object('document_id', value->>'id'))) = 'ok'
  and pg_temp.run(2, format('select public.activate_admin_agreement(%L)', '{"agreement_id":"37700000-0000-4000-8000-000000000001"}'::jsonb)) = 'ok',
  'the creator signs, KissMyApps countersigns and activates the agreement') from old_path where name = 'document';
select pg_temp.check(
  public.agreement_is_launch_ready('37700000-0000-4000-8000-000000000001', now())
  and not public.product_has_launch_ready_billing_offer(pg_temp.id('product', 5)),
  'the agreement is ready and no offer exists yet');
select pg_temp.check(pg_temp.set_link(9, 'active') like 'P0001%' and pg_temp.link_status(9) = 'paused',
  'a ready agreement without a KissMyApps offer still does not unlock the link');
insert into old_path select 'offer', pg_temp.call(2, format('select public.create_admin_billing_offer(%L)',
  jsonb_build_object('product_id', pg_temp.id('product', 5), 'key', 'main', 'name', 'One payment',
    'billing_mode', 'payment', 'stripe_price_id', 'price_LinkConfigured77', 'currency', 'USD', 'unit_amount_minor', 16900,
    'success_url_template', 'https://landing-5.speaksix-app.io/complete?session_id={CHECKOUT_SESSION_ID}',
    'cancel_url', 'https://landing-5.speaksix-app.io/checkout')));
insert into public.managed_payment_products(product_id, enabled) values (pg_temp.id('product', 5), true);
set local role service_role;
insert into old_path select 'price', public.record_managed_price_verification(jsonb_build_object(
  'billing_offer_id', value->>'id', 'product_id', value->>'product_id', 'offer_version', 1,
  'configured_price_id', 'price_LinkConfigured77', 'account_id', 'acct_LivePlatform77',
  'stripe_price_id', 'price_LinkActualLive77', 'livemode', true, 'currency', 'USD', 'unit_amount_minor', 16900))
  from old_path where name = 'offer';
reset role;
select pg_temp.check(
  pg_temp.run(2, format('select public.set_admin_billing_offer_status(%L)',
    jsonb_build_object('billing_offer_id', value->>'id', 'status', 'active'))) = 'ok',
  'KissMyApps activates the live-verified offer') from old_path where name = 'offer';
select pg_temp.check(public.product_has_launch_ready_billing_offer(pg_temp.id('product', 5)), 'the offer is ready');
select pg_temp.check(pg_temp.set_link(9, 'active') = 'ok' and pg_temp.link_status(9) = 'active',
  'with the agreement and the offer the link is active, as before');
insert into seen select 'ian', pg_temp.click(9, 9), 0;
select pg_temp.check(
  pg_temp.tracked(answer, pg_temp.landing(5))
  and (select c.commercial_eligible and a.status = 'open' and a.commercial_eligible
    from public.clicks c join public.acquisitions a on a.click_record_id = c.id where c.public_click_id = answer->>'click_id'),
  'a click on it is recorded as before') from seen where name = 'ian';
select pg_temp.check(
  pg_temp.probe('update public.managed_payment_offer_prices set livemode = false',
    'select pg_temp.click(9, 9)::text') = '{"error": "P0002"}',
  'when the offer stops being ready the link is unavailable, not redirected');
select pg_temp.check(
  pg_temp.set_link(9, 'paused') = 'ok' and pg_temp.click(9, 9) = '{"error":"P0002"}' and pg_temp.set_link(9, 'active') = 'ok',
  'a switched-off link of the older path is unavailable, and can be switched on again');
select pg_temp.check(
  pg_temp.new_link(15, 2, 5, 'active') like 'P0001%' and pg_temp.new_link(16, 1, 5, 'active') like 'P0001%',
  'creators without their own agreement, members of a program or not, get no active link on that product');

-- The tracking-only path behaves as before ----------------------------------------------------
select pg_temp.check(
  pg_temp.run(2, format('select public.set_admin_product_tracking_mode(jsonb_build_object(
    ''product_id'', %L, ''mode'', ''tracking_only'',
    ''expected_updated_at'', (select updated_at from public.get_admin_products() where id = %L)))',
    pg_temp.id('product', 6), pg_temp.id('product', 6))) = 'ok'
  and pg_temp.run(2, format('select public.activate_admin_product(%L)', jsonb_build_object('product_id', pg_temp.id('product', 6)))) = 'ok',
  'the KissMyApps owner approves and activates a tracking-only product');
select pg_temp.check(
  pg_temp.new_link(17, 10, 6, 'active', null, true) like '23514%'
  and pg_temp.new_link(10, 10, 6, 'active', null, false) = 'ok',
  'a tracking-only product takes a non-commercial link with no agreement, offer or membership');
insert into seen select 'jo', pg_temp.click(10, 10), 0;
select pg_temp.check(
  pg_temp.tracked(answer, pg_temp.landing(6))
  and (select not c.commercial_eligible and not a.commercial_eligible
    from public.clicks c join public.acquisitions a on a.click_record_id = c.id where c.public_click_id = answer->>'click_id'),
  'its click is recorded as tracking-only, as before') from seen where name = 'jo';
select pg_temp.check(pg_temp.set_link(10, 'paused') = 'ok' and pg_temp.click(10, 10) = '{"error":"P0002"}',
  'a switched-off tracking-only link is unavailable, not redirected');
alter table public.affiliate_links enable trigger affiliate_links_allocate_alias;

select 'ok ' || count(*) || ' program link tracking assertions' from link_assertions;
rollback;
