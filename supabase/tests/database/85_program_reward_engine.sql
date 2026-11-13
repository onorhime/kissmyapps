-- Provider-free test of Phase 6, the reward engine: which events of which project a program
-- pays for, the trigger that queues such an event (and never fails one), every outcome of
-- judging an event, the budget and the daily limit at their edges, the balance running out,
-- the hold and its approval, rejection by the merchant, and what the Rewards page reads.
--
-- Programs and members are made with the Phase 2 and 3 functions. Saving a program with
-- rewards is the program form's job (suite 84), so here a program's rewards, budget and the
-- terms that name them are written directly, as fixtures. Visits are click rows and
-- sessions written directly; events are rows of analytics_events, which is what the intake
-- writes. Stripe is never called.
begin;
set local time zone 'UTC';
create temporary table reward_assertions(label text);
create temporary table qa(key text primary key, value text);
create temporary table answers(name text primary key, answer jsonb);
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program reward engine assertion failed: %', label; end if;
  insert into reward_assertions values (label);
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
-- Runs one statement the way pg_cron or an edge function does: as the service role.
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
create function pg_temp.n(rows_of text) returns bigint language plpgsql as $$
declare result bigint;
begin
  execute 'select count(*) from ' || rows_of into result;
  return result;
end $$;
-- Whether a statement run by the database owner fails, and with what.
create function pg_temp.fails(statement text) returns text language plpgsql as $$
declare reason text;
begin
  execute statement;
  return 'ok';
exception when others then
  get stacked diagnostics reason = pg_exception_detail;
  return btrim(sqlstate || ' ' || coalesce(reason, ''));
end $$;
-- A moment a few milliseconds before this transaction began: "just now", in a known order.
create function pg_temp.ms(back integer) returns timestamptz language sql as $$
  select now() - make_interval(secs => back / 1000.0)
$$;

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
-- A fixture for what the program form of this phase does when rewards are published: the
-- program's columns, and a new version of its terms that is the one before with `patch`
-- laid over it. The agreement text is carried over; its hash only has to be a new one.
create function pg_temp.publish_rewards(workspace text, patch jsonb, budget bigint) returns integer language plpgsql as $$
declare
  p public.affiliate_programs := pg_temp.program(workspace);
  v_version integer := p.live_terms_version + 1;
begin
  insert into public.affiliate_program_terms(program_id, version, terms, agreement, agreement_sha256, created_by)
  select p.id, v_version, t.terms || patch, t.agreement,
    encode(extensions.digest(p.id::text || ' terms ' || v_version, 'sha256'), 'hex'), p.created_by
  from public.affiliate_program_terms t where t.program_id = p.id and t.version = p.live_terms_version;
  update public.affiliate_programs set
    earn_from = patch->>'earn_from', rewards = patch->'rewards', reward_budget_minor = budget,
    live_terms_version = v_version, revision = revision + 1
  where id = p.id;
  return v_version;
end $$;
-- The merchant changes the monthly budget (it is not part of the terms).
create function pg_temp.budget(workspace text, amount bigint) returns void language sql as $$
  update public.affiliate_programs set reward_budget_minor = amount where id = (pg_temp.program(workspace)).id
$$;
create function pg_temp.terms(workspace text, version integer) returns jsonb language sql as $$
  select t.terms from public.affiliate_program_terms t where t.program_id = (pg_temp.program(workspace)).id and t.version = $2
$$;
-- The rows of program_reward_events of a workspace's program: <project>:<event>, in order.
create function pg_temp.pays_for(workspace text) returns text language sql as $$
  select coalesce(string_agg(q.key || ':' || e.event_name, ' ' order by q.key, e.event_name), '')
  from public.program_reward_events e join qa q on q.value = e.project_id::text and q.key like 'project\_%'
  where e.program_id = (pg_temp.program(workspace)).id
$$;

-- Creators ---------------------------------------------------------------------------------------
create function pg_temp.join(creator text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(creator, format('select public.partner_program_join(%L)', jsonb_build_object(
    'slug', p.slug, 'terms_version', t.version, 'agreement_sha256', t.agreement_sha256)))
  from pg_temp.program(workspace) p
  join public.affiliate_program_terms t on t.program_id = p.id and t.version = p.live_terms_version
$$;
create function pg_temp.accept(creator text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(creator, format('select public.partner_program_accept_terms(%L)', jsonb_build_object(
    'program_id', p.id, 'terms_version', t.version, 'agreement_sha256', t.agreement_sha256)))
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

-- Links and visits -------------------------------------------------------------------------------
create function pg_temp.link_row(creator text, workspace text, link_name text) returns public.affiliate_links language sql as $$
  select l from public.affiliate_links l
  where l.affiliate_id = pg_temp.q('creator_' || creator) and l.product_id = (pg_temp.program(workspace)).product_id
    and case when link_name = 'Main link' then l.is_main else not l.is_main and l.name = link_name end
  order by (l.status = 'archived'), l.created_at desc limit 1
$$;
-- A visitor opens a link by its long address: what the redirect function gets back.
create function pg_temp.open(creator text, workspace text, link_name text) returns jsonb language plpgsql as $$
declare
  v_slug text;
  v_code text;
  result jsonb;
begin
  select a.slug, l.public_code into v_slug, v_code
  from pg_temp.link_row(creator, workspace, link_name) l join public.affiliates a on a.id = l.affiliate_id;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select to_jsonb(r) into result from public.register_tracking_click(v_slug, v_code, '{}'::jsonb) r;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;
-- A person as analytics knows them: anonymous (the SDK's own id) or identified by the
-- merchant's user id, with the traits the merchant sent. Kept as person_<k>.
create function pg_temp.person(k text, traits jsonb default '{}', identified boolean default false, workspace text default 'acme')
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.analytics_people(id, project_id, distinct_id, user_id, anonymous_ids, traits, environment, first_seen, last_seen)
  values (v_id, pg_temp.q('project_' || workspace), case when identified then 'user-' else 'anon-' end || k,
    case when identified then 'user-' || k end, case when identified then '{}' else array['anon-' || k] end,
    traits, 'production', now() - interval '400 days', now());
  insert into qa values ('person_' || k, v_id);
  return v_id;
end $$;
-- A person opens a creator's link at a moment: the click row the redirect function writes,
-- and the visit on the merchant's site that carries it. The person is made when new.
create function pg_temp.visit(k text, creator text, link_name text, at timestamptz, workspace text default 'acme',
  bot boolean default false, site text default null) returns uuid language plpgsql as $$
declare
  l public.affiliate_links := pg_temp.link_row(creator, workspace, link_name);
  v_click uuid := gen_random_uuid();
begin
  if pg_temp.q('person_' || k) is null then
    perform pg_temp.person(k, '{}', false, coalesce(site, workspace));
  end if;
  insert into public.clicks(id, public_click_id, affiliate_link_id, affiliate_id, product_id, source_id, campaign_id,
    funnel_id, sub1, sub2, sub3, destination_url_snapshot, is_bot, commercial_eligible, occurred_at, created_at)
  select v_click, encode(extensions.gen_random_bytes(24), 'hex'), l.id, l.affiliate_id, l.product_id, l.source_id, l.campaign_id,
    l.funnel_id, l.sub1, l.sub2, l.sub3, f.destination_url, bot, l.commercial_eligible, at, at
  from public.funnels f where f.id = l.funnel_id;
  insert into public.analytics_sessions(project_id, person_id, session_key, environment, started_at, ended_at, platform, creator_click)
  select pe.project_id, pe.id, 'visit-' || v_click, 'production', at, at, 'web', c.public_click_id
  from public.analytics_people pe, public.clicks c where pe.id = pg_temp.q('person_' || k) and c.id = v_click;
  return v_click;
end $$;
-- The person does something on the merchant's site: one row of analytics_events, as the
-- intake writes it. Its id is kept as event_<k>.
create function pg_temp.event(k text, who text, event_name text, at timestamptz, env text default 'production')
returns bigint language plpgsql as $$
declare v_id bigint;
begin
  if pg_temp.q('person_' || who) is null then
    perform pg_temp.person(who);
  end if;
  insert into public.analytics_events(project_id, person_id, session_id, environment, name, occurred_at, insert_id)
  select pe.project_id, pe.id, (select s.id from public.analytics_sessions s where s.person_id = pe.id
      order by s.started_at desc, s.id limit 1), env, event_name, at, 'event-' || k
  from public.analytics_people pe where pe.id = pg_temp.q('person_' || who)
  returning id into v_id;
  insert into qa values ('event_' || k, v_id);
  return v_id;
end $$;
create function pg_temp.eid(k text) returns bigint language sql as $$ select value::bigint from qa where key = 'event_' || k $$;
create function pg_temp.queued(k text) returns public.program_reward_queue language sql as $$
  select w from public.program_reward_queue w where w.event_id = pg_temp.eid(k)
$$;
create function pg_temp.waiting() returns bigint language sql as $$ select count(*) from public.program_reward_queue $$;

-- Rewards ----------------------------------------------------------------------------------------
create function pg_temp.tick(input jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.svc('program_rewards_tick', input)
$$;
create function pg_temp.award(k text) returns public.program_reward_awards language sql as $$
  select a from public.program_reward_awards a where a.event_id = pg_temp.eid(k)
$$;
create function pg_temp.com(k text) returns public.program_commissions language sql as $$
  select c from public.program_commissions c where c.award_id = (pg_temp.award(k)).id
$$;
-- What came of an event in one line: none, or <creator> <award status>[:<reason>] <reward>,
-- and for one that earned its commission: <status> <amount>+<fee>.
create function pg_temp.aw(k text) returns text language sql as $$
  select coalesce((select format('%s %s%s %s%s', (select q.key from qa q where q.value = a.affiliate_id::text and q.key like 'creator\_%'),
      a.status, coalesce(':' || a.reason, ''), a.amount_minor,
      coalesce((select format(', %s %s+%s', c.status, c.amount_minor, c.fee_minor)
        from public.program_commissions c where c.award_id = a.id), ''))
    from public.program_reward_awards a where a.event_id = pg_temp.eid(k)), 'none')
$$;
-- The balance entries of an event's commission in one line: <kind> <amount>, in order.
create function pg_temp.moved(k text) returns text language sql as $$
  select coalesce(string_agg(e.kind || ' ' || e.amount_minor, ', ' order by e.seq), '')
  from public.program_balance_entries e where e.commission_id = (pg_temp.com(k)).id
$$;
create function pg_temp.rewards_sql(workspace text, input jsonb default '{}') returns text language sql as $$
  select format('select public.workspace_program_rewards(%L, %L)', pg_temp.q(workspace), input)
$$;
create function pg_temp.rewards(who text, workspace text, input jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.call(who, pg_temp.rewards_sql(workspace, input))
$$;
create function pg_temp.reject_sql(workspace text, input jsonb) returns text language sql as $$
  select format('select public.workspace_program_reward_reject(%L, %L)', pg_temp.q(workspace), input)
$$;
create function pg_temp.award_ids(variadic k text[]) returns jsonb language sql as $$
  select jsonb_agg((pg_temp.award(e)).id order by n) from unnest(k) with ordinality x(e, n)
$$;
-- The awards of an answer in one line, by the names their events were kept under.
create function pg_temp.listed(answer jsonb) returns text language sql as $$
  select coalesce(string_agg(substr(q.key, 7), ' ' order by n), '')
  from jsonb_array_elements(answer->'awards') with ordinality x(s, n)
  join public.program_reward_awards a on a.id = (s->>'award_id')::uuid
  join qa q on q.value = a.event_id::text and q.key like 'event\_%'
$$;
create function pg_temp.row_of(answer jsonb, k text) returns jsonb language sql as $$
  select s from jsonb_array_elements(answer->'awards') s where s->>'award_id' = (pg_temp.award(k)).id::text
$$;
create function pg_temp.creator_of(answer jsonb, creator_name text) returns jsonb language sql as $$
  select c from jsonb_array_elements(answer->'creators') c where c->>'name' = creator_name
$$;
-- Every key of an answer, at any depth.
create function pg_temp.all_keys(answer jsonb) returns text[] language sql as $$
  select array_agg(distinct k order by k)
  from jsonb_path_query(answer, 'strict $.** ? (@.type() == "object")') o, jsonb_object_keys(o) k
$$;

-- Money ------------------------------------------------------------------------------------------
create function pg_temp.account(workspace text) returns public.program_balance_accounts language sql as $$
  select a from public.program_balance_accounts a where a.program_id = (pg_temp.program(workspace)).id
$$;
create function pg_temp.available(workspace text) returns bigint language sql as $$
  select (pg_temp.account(workspace)).available_minor
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
create function pg_temp.money(enabled boolean) returns void language sql as $$
  update public.platform_settings set program_money_enabled = enabled where singleton
$$;
-- The books: every balance is the sum of its entries, nothing was set aside from money that
-- was not there, every commission (of a sale or of a reward) agrees with its entries, every
-- award agrees with its commission, and every reward commission passes the engine's own check.
create function pg_temp.books() returns boolean language plpgsql as $$
declare r record;
begin
  for r in select c.id from public.program_commissions c where c.award_id is not null loop
    perform kma_internal.program_reward_commission_check(r.id);
  end loop;
  return (select coalesce(bool_and(a.available_minor = coalesce((select sum(e.amount_minor)
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
    and not exists (select 1 from public.program_reward_awards a
      left join public.program_commissions c on c.award_id = a.id
      where (a.status = 'earned') is distinct from coalesce(c.status in ('held', 'approved'), false)
        or (a.status = 'rejected') is distinct from coalesce(c.status = 'reversed', false)
        or (a.status = 'not_earned' and c.id is not null))
    and pg_temp.service('select public.program_reward_health()')->>'ledger_mismatches' = '0'
    and pg_temp.service('select public.program_balance_health()')->>'ledger_mismatches' = '0'
    and pg_temp.service('select public.program_payout_health()')->>'ledger_mismatches' = '0';
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
grant all on qa, reward_assertions, answers to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- People ---------------------------------------------------------------------------------------
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('c5000000-0000-4000-8000-000000000001', 'owner@fluent.example.test', now(), '{"company":"Fluent"}'),
  ('c5000000-0000-4000-8000-000000000002', 'admin@fluent.example.test', now(), '{}'),
  ('c5000000-0000-4000-8000-000000000003', 'analyst@fluent.example.test', now(), '{}'),
  ('c5000000-0000-4000-8000-000000000004', 'owner@rival.example.test', now(), '{"company":"Rival"}'),
  ('c5000000-0000-4000-8000-000000000005', 'owner@quiet.example.test', now(), '{"company":"Quiet"}'),
  ('c5000000-0000-4000-8000-000000000006', 'owner@empty.example.test', now(), '{"company":"Empty"}'),
  ('c5000000-0000-4000-8000-000000000011', 'owner@kma.example.test', now(), '{}'),
  ('c5000000-0000-4000-8000-000000000021', 'ada@creators.example.test', now(), '{}'),
  ('c5000000-0000-4000-8000-000000000022', 'ben@creators.example.test', now(), '{}'),
  ('c5000000-0000-4000-8000-000000000023', 'cy@creators.example.test', now(), '{}'),
  ('c5000000-0000-4000-8000-000000000024', 'dee@creators.example.test', now(), '{}'),
  ('c5000000-0000-4000-8000-000000000025', 'eve@creators.example.test', now(), '{}'),
  ('c5000000-0000-4000-8000-000000000026', 'helper@creators.example.test', now(), '{}'),
  ('c5000000-0000-4000-8000-000000000027', 'stranger@elsewhere.example.test', now(), '{}');
insert into qa values
  ('owner', 'c5000000-0000-4000-8000-000000000001'), ('admin', 'c5000000-0000-4000-8000-000000000002'),
  ('analyst', 'c5000000-0000-4000-8000-000000000003'), ('rival_owner', 'c5000000-0000-4000-8000-000000000004'),
  ('quiet_owner', 'c5000000-0000-4000-8000-000000000005'), ('empty_owner', 'c5000000-0000-4000-8000-000000000006'),
  ('kma_owner', 'c5000000-0000-4000-8000-000000000011'),
  ('ada', 'c5000000-0000-4000-8000-000000000021'), ('ben', 'c5000000-0000-4000-8000-000000000022'),
  ('cy', 'c5000000-0000-4000-8000-000000000023'), ('dee', 'c5000000-0000-4000-8000-000000000024'),
  ('eve', 'c5000000-0000-4000-8000-000000000025'),
  -- A second person on Ada's creator account.
  ('ada_helper', 'c5000000-0000-4000-8000-000000000026'), ('stranger', 'c5000000-0000-4000-8000-000000000027'),
  ('creator_ada', 'c6000000-0000-4000-8000-000000000001'), ('creator_ben', 'c6000000-0000-4000-8000-000000000002'),
  ('creator_cy', 'c6000000-0000-4000-8000-000000000003'), ('creator_dee', 'c6000000-0000-4000-8000-000000000004'),
  ('creator_eve', 'c6000000-0000-4000-8000-000000000005'),
  ('project_acme', 'c7000000-0000-4000-8000-000000000001'), ('project_acme_app', 'c7000000-0000-4000-8000-000000000002'),
  ('project_rival', 'c7000000-0000-4000-8000-000000000003'), ('project_quiet', 'c7000000-0000-4000-8000-000000000004');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner');
insert into public.affiliates(id, public_name, legal_name, slug, status, country_code, channels) values
  (pg_temp.q('creator_ada'), 'Ada Okafor', 'Ada N. Okafor', 'ada-okafor', 'active', 'NG', array['tiktok', 'instagram']),
  (pg_temp.q('creator_ben'), 'Ben Creator', null, 'ben-creator', 'active', 'GB', array['youtube']),
  (pg_temp.q('creator_cy'), 'Cy Park', null, 'cy-park', 'active', null, '{}'),
  (pg_temp.q('creator_dee'), 'Dee Vale', null, 'dee-vale', 'active', 'US', array['newsletter']),
  (pg_temp.q('creator_eve'), 'Eve Stone', null, 'eve-stone', 'active', null, '{}');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at)
  select pg_temp.q('creator_' || c), pg_temp.q(c), 'owner', true, false, now()
  from unnest(array['ada', 'ben', 'cy', 'dee', 'eve']) c;
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at) values
  (pg_temp.q('creator_ada'), pg_temp.q('ada_helper'), 'member', true, false, now());
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true,
    program_money_enabled = false, program_fee_bps = 1000, program_min_deposit_minor = 5000,
    program_payouts_enabled = false, program_min_payout_minor = 2500, program_reward_daily_share_bps = 1000;

-- Workspaces, their sites and their programs, published while program money is still off ---------
select pg_temp.sign_in('owner');
insert into qa select 'acme', public.analytics_bootstrap()->'workspaces'->0->>'id';
select public.analytics_invite_member(pg_temp.q('acme'), 'admin@fluent.example.test', 'admin');
select public.analytics_invite_member(pg_temp.q('acme'), 'analyst@fluent.example.test', 'analyst');
select pg_temp.sign_in('admin');
select public.analytics_bootstrap();
select pg_temp.sign_in('analyst');
select public.analytics_bootstrap();
select pg_temp.sign_in('rival_owner');
insert into qa select 'rival', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('quiet_owner');
insert into qa select 'quiet', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('empty_owner');
insert into qa select 'empty', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
insert into public.analytics_projects(id, workspace_id, name) values
  (pg_temp.q('project_acme'), pg_temp.q('acme'), 'Fluent web'),
  (pg_temp.q('project_rival'), pg_temp.q('rival'), 'Rival Reader web'),
  (pg_temp.q('project_quiet'), pg_temp.q('quiet'), 'Quiet Club web');
select pg_temp.connect('acme', 'acct_Fluent', 'Fluent Ltd');
select pg_temp.connect('rival', 'acct_Rival', 'Rival Media');
select pg_temp.connect('quiet', 'acct_Quiet', 'Quiet Club');
-- All three start as programs that pay for sales, which is all the merged form can publish.
select pg_temp.publish('owner', 'acme', '{"name":"Fluent","category":"education","tagline":"Speak a language in six weeks.",
  "landing_url":"https://speaksix.com/start","commission_type":"percent","commission_rate_bps":3000,
  "commission_duration":"lifetime","hold_days":14}');
select pg_temp.publish('rival_owner', 'rival', '{"name":"Rival Reader","category":"entertainment","tagline":"Stories worth an evening.",
  "landing_url":"https://rivalreader.co/","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"lifetime","hold_days":14}');
select pg_temp.publish('quiet_owner', 'quiet', '{"name":"Quiet Club","category":"lifestyle","tagline":"A calmer phone.",
  "landing_url":"https://quietclub.io/join","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"lifetime","hold_days":14}');
select pg_temp.check((select bool_and(p.status = 'live' and p.earn_from = 'sales') and count(*) = 3 from public.affiliate_programs p),
  'three programs are live, paying for sales');
select set_config('request.jwt.claims', '', true);

-- Closed by default ----------------------------------------------------------------------------
select pg_temp.check((select count(*) = 2 and bool_and(has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('workspace_program_rewards', 'workspace_program_reward_reject')),
  'signed-in users may call the two merchant functions; each is security definer with an empty search path');
select pg_temp.check((select count(*) = 2 and bool_and(has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('program_rewards_tick', 'program_reward_health')),
  'only the service role may run the tick and read the health of the engine');
select pg_temp.check((select count(*) >= 13 and bool_and(not has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'kma_internal' and p.proname like 'program\_reward%'),
  'the internal reward functions are closed to every API role');
select pg_temp.check(pg_temp.try_signed_out(r, s) = '42501', format('%s cannot run %s', r, left(s, 60)))
from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array[
  'select kma_internal.program_reward_events_sync()',
  format('select kma_internal.program_reward_commission_check(%L)', gen_random_uuid()),
  format('select kma_internal.program_reward_lock(%L)', gen_random_uuid()),
  'select kma_internal.program_reward_list(''{}'')',
  format('select * from kma_internal.program_reward_rows(%L, null, null, null)', gen_random_uuid())]) s;
select pg_temp.check(pg_temp.try_signed_out(r, s) = '42501', format('signed out, %s cannot run %s', r, left(s, 60)))
from unnest(array['anon', 'authenticated']) r, unnest(array[
  pg_temp.rewards_sql('acme'), pg_temp.reject_sql('acme', jsonb_build_object('award_ids', jsonb_build_array(gen_random_uuid()), 'reason', 'fake')),
  'select public.program_rewards_tick(''{}'')', 'select public.program_reward_health()']) s;
select pg_temp.check(not has_table_privilege(r, t, 'select') and not has_table_privilege(r, t, 'insert'),
  format('%s cannot touch %s', r, t))
from unnest(array['anon', 'authenticated', 'service_role']) r,
  unnest(array['public.program_reward_awards', 'public.program_reward_events', 'public.program_reward_queue']) t;
select pg_temp.check((select count(*) = 4 from pg_trigger g where not g.tgisinternal and g.tgname in (
    'affiliate_programs_reward_events_insert', 'affiliate_programs_reward_events_update',
    'analytics_projects_reward_events', 'analytics_events_program_rewards'))
  and (select g.tgtype & 1 = 1 and g.tgtype & 2 = 0 and g.tgtype & 4 = 4 and g.tgqual is not null
    from pg_trigger g where g.tgname = 'analytics_events_program_rewards'),
  'the triggers are in place; the one on events runs after each insert, and only where its condition holds');

-- Reading terms ------------------------------------------------------------------------------------
select pg_temp.check(
  kma_internal.program_terms_earn_from('{"commission_type":"percent"}') = 'sales'
  and kma_internal.program_terms_earn_from(null) = 'sales'
  and kma_internal.program_terms_earn_from('{"earn_from":"both"}') = 'both'
  and kma_internal.program_terms_earn_from('{"earn_from":"installs"}') = 'sales'
  and kma_internal.program_reward_list('{"commission_type":"percent"}') = '[]'
  and kma_internal.program_reward_list(null) = '[]'
  and kma_internal.program_reward_list('{"earn_from":"events"}') = '[]'
  and kma_internal.program_reward_list('{"earn_from":"events","rewards":{"key":"a"}}') = '[]'
  -- Terms that pay for sales have no rewards, whatever else they carry.
  and kma_internal.program_reward_list('{"earn_from":"sales","rewards":[{"key":"signup","label":"Sign-up","amount_minor":200}]}') = '[]'
  and kma_internal.program_reward_list('{"rewards":[{"key":"signup","label":"Sign-up","amount_minor":200}]}') = '[]'
  and kma_internal.program_reward_list('{"earn_from":"events","rewards":[
      {"key":"signup","label":" Sign-up ","amount_minor":200,"extra":true}, "text", {"key":"9bad","label":"x","amount_minor":1},
      {"key":"no_label","amount_minor":5}, {"key":"half","label":"Half","amount_minor":2.5},
      {"key":"zero","label":"Zero","amount_minor":0}, {"key":"text_amount","label":"Text","amount_minor":"200"},
      {"key":"trial.started","label":"Trial","amount_minor":100000000}]}')
    = '[{"key":"signup","label":"Sign-up","amount_minor":200},{"key":"trial.started","label":"Trial","amount_minor":100000000}]'
  and kma_internal.program_reward_of('{"earn_from":"both","rewards":[{"key":"a","label":"A","amount_minor":1},{"key":"b","label":"B","amount_minor":2}]}', 'b')
    = '{"key":"b","label":"B","amount_minor":2}'
  and kma_internal.program_reward_of('{"earn_from":"both","rewards":[{"key":"a","label":"A","amount_minor":1}]}', 'c') is null,
  'terms from before this phase pay for sales and have no rewards; a reward that is not whole is not read');
select pg_temp.check(
  kma_internal.program_reward_daily_cap(50000, '[{"amount_minor":200},{"amount_minor":600}]') = 5000
  and kma_internal.program_reward_daily_cap(3000, '[{"amount_minor":200},{"amount_minor":600}]') = 600
  and kma_internal.program_reward_daily_cap(1999, '[{"amount_minor":100}]') = 199
  and kma_internal.program_reward_daily_cap(null, '[{"amount_minor":100}]') is null,
  'one creator can earn a tenth of the budget in a day, and never less than the largest reward');

-- Which events a program pays for -------------------------------------------------------------------
select pg_temp.check(pg_temp.n('public.program_reward_events') = 0
  and pg_temp.service('select public.program_reward_health()') @> '{"events_out_of_step":0,"programs":0,"ledger_mismatches":0}',
  'programs that pay for sales pay for no events');
-- Before rewards: the Rewards page of a program that pays for sales, and of no program.
select pg_temp.capture('workspace_program_rewards.sales_program', pg_temp.keep('sales_program', pg_temp.rewards('rival_owner', 'rival')));
select pg_temp.check(pg_temp.kept('sales_program') = '{"can_manage":true,"program":null,"currency":null,"budget":null,
    "rewards":[],"creators":[],"awards":[],"next_before":null}'::jsonb
  and pg_temp.rewards('empty_owner', 'empty') = pg_temp.kept('sales_program')
  and pg_temp.rewards('analyst', 'acme') = pg_temp.kept('sales_program') || '{"can_manage":false}',
  'a program that pays for sales only, and a workspace with no program, have nothing on the Rewards page');

-- Dee joins Fluent while it pays for sales. She never accepts anything later.
select pg_temp.check(pg_temp.join('dee', 'acme')->'membership'->>'status' = 'active', 'Dee joins while Fluent pays for sales');
select set_config('request.jwt.claims', '', true);
-- Program money is switched on and Fluent gets a balance.
select pg_temp.money(true);
select pg_temp.open_account('acme', 'owner'), pg_temp.open_account('rival', 'rival_owner');
select pg_temp.fund('acme', 100000), pg_temp.fund('rival', 20000);

-- Fluent now pays for events only: 2.00 for an account, 5.00 for a trial, 500.00 a month.
select pg_temp.publish_rewards('acme', '{"earn_from":"events","rewards":[
    {"key":"signup_completed","label":"Account created","amount_minor":200},
    {"key":"trial_started","label":"Trial started","amount_minor":500}],
  "commission_type":null,"commission_rate_bps":null,"commission_fixed_minor":null,
  "commission_duration":null,"commission_months":null}', 50000);
select pg_temp.check(pg_temp.pays_for('acme') = 'project_acme:signup_completed project_acme:trial_started'
  and pg_temp.n('public.program_reward_events') = 2,
  'publishing terms with rewards lists each reward for the site of the workspace');
insert into public.analytics_projects(id, workspace_id, name) values (pg_temp.q('project_acme_app'), pg_temp.q('acme'), 'Fluent app');
select pg_temp.check(pg_temp.pays_for('acme') = 'project_acme:signup_completed project_acme:trial_started '
    || 'project_acme_app:signup_completed project_acme_app:trial_started'
  and pg_temp.pays_for('rival') = '' and pg_temp.n('public.program_reward_events') = 4,
  'a site added later is listed too; a program that pays for sales still lists nothing');
select pg_temp.set_status('owner', 'acme', 'paused');
select pg_temp.check((pg_temp.program('acme')).status = 'paused' and pg_temp.n('public.program_reward_events') = 4,
  'a paused program keeps its events');
select pg_temp.set_status('owner', 'acme', 'live');
select set_config('request.jwt.claims', '', true);
-- Rows that went missing or stray are put right by the sync, and the health view counts them.
delete from public.program_reward_events where event_name = 'trial_started';
insert into public.program_reward_events(project_id, event_name, program_id)
  values (pg_temp.q('project_rival'), 'signup_completed', (pg_temp.program('rival')).id);
select pg_temp.check(pg_temp.service('select public.program_reward_health()')->>'events_out_of_step' = '3',
  'rows out of step are counted');
select kma_internal.program_reward_events_sync();
select pg_temp.check(pg_temp.n('public.program_reward_events') = 4 and pg_temp.pays_for('rival') = ''
  and pg_temp.service('select public.program_reward_health()') @> '{"events_out_of_step":0,"programs":1}',
  'and the sync puts them right');

-- Ada, Ben and Cy join now and accept the terms with rewards. Everyone has been a member for long.
select pg_temp.check(pg_temp.join('ada', 'acme')->'membership'->>'status' = 'active'
  and pg_temp.join('ben', 'acme')->'membership'->>'status' = 'active'
  and pg_temp.join('cy', 'acme')->'membership'->>'status' = 'active'
  and pg_temp.join('ada', 'rival')->'membership'->>'status' = 'active', 'Ada, Ben and Cy join Fluent; Ada joins Rival Reader too');
select set_config('request.jwt.claims', '', true);
update public.affiliate_program_members set activated_at = now() - interval '500 days';
select pg_temp.check((pg_temp.member('ada', 'acme')).terms_version = 2 and (pg_temp.member('dee', 'acme')).terms_version = 1
  and (select count(*) = 7 from public.affiliate_links l
    where l.affiliate_id = pg_temp.q('creator_ada') and l.product_id = (pg_temp.program('acme')).product_id and l.status = 'active'),
  'Ada accepted the terms with rewards and has her links; Dee is still on the terms that pay for sales');

-- The Rewards page before any event.
select pg_temp.capture('workspace_program_rewards.empty', pg_temp.keep('empty', pg_temp.rewards('owner', 'acme')));
select pg_temp.check((select a - 'program' - 'budget' = '{"can_manage":true,"currency":"USD","creators":[],"awards":[],"next_before":null,
        "rewards":[{"key":"signup_completed","label":"Account created","amount_minor":200,"count":0,"amount_total_minor":0},
          {"key":"trial_started","label":"Trial started","amount_minor":500,"count":0,"amount_total_minor":0}]}'::jsonb
      and a->'program' = jsonb_build_object('id', (pg_temp.program('acme')).id, 'slug', 'fluent', 'name', 'Fluent',
        'status', 'live', 'earn_from', 'events')
      and a->'budget' = jsonb_build_object('month', to_char(now() at time zone 'UTC', 'YYYY-MM'), 'budget_minor', 50000,
        'used_minor', 0, 'daily_limit_minor', 5000, 'fee_bps', 1000)
    from (select pg_temp.kept('empty') as a) x),
  'a program with rewards and no events yet shows its budget, its rewards and empty lists');

-- The intake -----------------------------------------------------------------------------------------
-- Ada's first visitor, a1, opens her TikTok link and makes an account.
select pg_temp.visit('a1', 'ada', 'TikTok', now() - interval '2 hours');
select pg_temp.event('a1', 'a1', 'signup_completed', pg_temp.ms(900));
select pg_temp.check((select w.project_id = pg_temp.q('project_acme') and w.event_name = 'signup_completed'
      and w.person_id = pg_temp.q('person_a1') and w.occurred_at = pg_temp.ms(900) and w.attempts = 0
      and w.session_id = (select s.id from public.analytics_sessions s where s.person_id = pg_temp.q('person_a1'))
      and w.next_attempt_at <= clock_timestamp() and w.last_error is null
    from pg_temp.queued('a1') w)
  and pg_temp.waiting() = 1,
  'a production event a program pays for is queued as it arrives');
-- Other events are of no interest: another name, a development event, another workspace's site.
select pg_temp.event('skip_name', 'a1', 'page_viewed', pg_temp.ms(899));
select pg_temp.event('skip_dev', 'a1', 'signup_completed', pg_temp.ms(898), 'development');
select pg_temp.person('r1', '{}', false, 'rival');
select pg_temp.event('skip_site', 'r1', 'signup_completed', pg_temp.ms(897));
select pg_temp.check(pg_temp.waiting() = 1 and pg_temp.n('public.analytics_events') = 4,
  'an event with another name, a development event and an event of another workspace are stored and not queued');
-- While program money is off nothing is queued, and the tick does nothing.
select pg_temp.money(false);
select pg_temp.visit('off1', 'ada', 'TikTok', now() - interval '2 hours');
select pg_temp.event('off1', 'off1', 'signup_completed', pg_temp.ms(896));
select pg_temp.capture('program_rewards_tick.money_off', pg_temp.keep('tick_off', pg_temp.tick()));
select pg_temp.check(pg_temp.kept('tick_off') = '{"judged":0,"earned":0,"approved":0,"remaining":0}'
  and (pg_temp.queued('off1')).event_id is null and (pg_temp.queued('a1')).event_id is not null and pg_temp.waiting() = 1
  and pg_temp.n('public.program_reward_awards') = 0,
  'with program money off an event is not queued, and the tick leaves the queue alone');
select pg_temp.money(true);
-- Nothing that goes wrong in the trigger can lose or refuse an event.
alter table public.program_reward_queue add constraint fixture_refuses check (event_name <> 'trial_started') not valid;
select pg_temp.check(pg_temp.fails($$select pg_temp.event('boom1', 'a1', 'trial_started', pg_temp.ms(895))$$) = 'ok', 'the insert of boom1 goes through');
select pg_temp.check(exists (select 1 from public.analytics_events e where e.id = pg_temp.eid('boom1'))
  and (pg_temp.queued('boom1')).event_id is null,
  'an event the queue refuses is stored all the same');
alter table public.program_reward_queue drop constraint fixture_refuses;
alter table public.program_reward_queue rename to program_reward_queue_gone;
select pg_temp.check(pg_temp.fails($$select pg_temp.event('boom2', 'a1', 'signup_completed', pg_temp.ms(894))$$) = 'ok', 'the insert of boom2 goes through');
select pg_temp.check(exists (select 1 from public.analytics_events e where e.id = pg_temp.eid('boom2')),
  'an event is stored even when the queue is not there');
alter table public.program_reward_queue_gone rename to program_reward_queue;
alter table public.program_reward_events rename to program_reward_events_gone;
select pg_temp.check(pg_temp.fails($$select pg_temp.event('boom3', 'a1', 'signup_completed', pg_temp.ms(893))$$) = 'ok', 'the insert of boom3 goes through');
select pg_temp.check(exists (select 1 from public.analytics_events e where e.id = pg_temp.eid('boom3')),
  'and when the list of rewarded events is not there');
alter table public.program_reward_events_gone rename to program_reward_events;
select pg_temp.check(pg_temp.waiting() = 1 and pg_temp.n('public.analytics_events') = 8, 'eight events are stored, one is queued');
-- The same event is never queued twice.
insert into public.program_reward_queue(event_id, project_id, event_name, person_id, occurred_at)
  select w.event_id, w.project_id, w.event_name, w.person_id, w.occurred_at from pg_temp.queued('a1') w
  on conflict do nothing;
select pg_temp.check(pg_temp.waiting() = 1, 'an event is in the queue once');

-- Judging ----------------------------------------------------------------------------------------------
-- The tick takes a limit and nothing else.
select pg_temp.check(pg_temp.try_signed_out('service_role', 'select public.program_rewards_tick(''{"limit":0}'')') = '22023 invalid_input'
  and pg_temp.try_signed_out('service_role', 'select public.program_rewards_tick(''{"limit":1001}'')') = '22023 invalid_input'
  and pg_temp.try_signed_out('service_role', 'select public.program_rewards_tick(''{"limit":"5"}'')') = '22023 invalid_input'
  and pg_temp.try_signed_out('service_role', 'select public.program_rewards_tick(''{"batch":5}'')') = '22023 invalid_input'
  and pg_temp.try_signed_out('service_role', 'select public.program_rewards_tick(''[]'')') = '22023 invalid_input'
  and pg_temp.waiting() = 1, 'the tick takes a limit from 1 to 1000');

-- People nobody sent: no visit through a link, only a visit that was a bot, a link of
-- another program, and a link opened after the event.
select pg_temp.event('n1', 'n1', 'signup_completed', pg_temp.ms(890));
select pg_temp.visit('n2', 'ada', 'TikTok', now() - interval '2 hours', 'acme', true);
select pg_temp.event('n2', 'n2', 'signup_completed', pg_temp.ms(880));
select pg_temp.visit('n3', 'ada', 'Main link', now() - interval '2 hours', 'rival', false, 'acme');
select pg_temp.event('n3', 'n3', 'signup_completed', pg_temp.ms(870));
select pg_temp.visit('n4', 'ada', 'TikTok', pg_temp.ms(100));
select pg_temp.event('n4', 'n4', 'signup_completed', pg_temp.ms(860));
-- l1 opened Ada's link two days ago and Ben's yesterday, makes an account, opens Ada's
-- YouTube link, makes an account again (some sites send it twice) and starts a trial.
select pg_temp.visit('l1', 'ada', 'Main link', now() - interval '2 days');
select pg_temp.visit('l1', 'ben', 'Main link', now() - interval '1 day');
select pg_temp.visit('l1', 'ada', 'YouTube', pg_temp.ms(600));
select pg_temp.event('l1', 'l1', 'signup_completed', pg_temp.ms(700));
select pg_temp.event('l1_again', 'l1', 'signup_completed', pg_temp.ms(500));
select pg_temp.event('l1_trial', 'l1', 'trial_started', pg_temp.ms(480));
-- The counting window is 30 days: w1 opened the link exactly 30 days before, w2 a second earlier.
select pg_temp.visit('w1', 'ada', 'Instagram', pg_temp.ms(450) - interval '30 days');
select pg_temp.event('w1', 'w1', 'signup_completed', pg_temp.ms(450));
select pg_temp.visit('w2', 'ada', 'Instagram', pg_temp.ms(440) - interval '30 days 1 second');
select pg_temp.event('w2', 'w2', 'signup_completed', pg_temp.ms(440));
-- A creator's own actions: o1 has Ada's email (written another way), o2 the email of the
-- second person on her account, both through her link. o3 has Ada's email and came through Ben's.
select pg_temp.person('o1', '{"email":" Ada@Creators.Example.TEST ","name":"Ada Private"}');
select pg_temp.person('o2', '{"email":"helper@creators.example.test"}', true);
select pg_temp.person('o3', '{"email":"ada@creators.example.test"}');
select pg_temp.visit('o1', 'ada', 'TikTok', now() - interval '2 hours');
select pg_temp.visit('o2', 'ada', 'TikTok', now() - interval '2 hours');
select pg_temp.visit('o3', 'ben', 'TikTok', now() - interval '2 hours');
select pg_temp.event('o1', 'o1', 'signup_completed', pg_temp.ms(430));
select pg_temp.event('o2', 'o2', 'signup_completed', pg_temp.ms(420));
select pg_temp.event('o3', 'o3', 'signup_completed', pg_temp.ms(410));
-- Dee's terms pay for sales.
select pg_temp.visit('d1', 'dee', 'Main link', now() - interval '2 hours');
select pg_temp.event('d1', 'd1', 'signup_completed', pg_temp.ms(405));
-- a1 starts a trial, and their account event arrives once more.
select pg_temp.event('a1_trial', 'a1', 'trial_started', pg_temp.ms(400));
select pg_temp.event('a1_again', 'a1', 'signup_completed', pg_temp.ms(390));
select pg_temp.check(pg_temp.waiting() = 16, 'sixteen events wait');

-- One at a time, oldest arrival first.
select pg_temp.capture('program_rewards_tick.limited', pg_temp.keep('tick_one', pg_temp.tick('{"limit":1}')));
select pg_temp.check(pg_temp.kept('tick_one') = '{"judged":1,"earned":1,"approved":0,"remaining":15}'
  and (pg_temp.queued('a1')).event_id is null and pg_temp.waiting() = 15, 'a tick with a limit of one judges the event that arrived first');
select pg_temp.check(pg_temp.aw('a1') = 'creator_ada earned 200, held 200+20'
  and (select a.program_id = (pg_temp.program('acme')).id and a.reward_key = 'signup_completed'
      and a.reward_label = 'Account created' and a.person_id = pg_temp.q('person_a1') and a.occurred_at = pg_temp.ms(900)
      and a.member_id = (pg_temp.member('ada', 'acme')).id and a.terms_version = 2 and a.currency = 'USD'
      and a.click_record_id = (select c.id from public.clicks c join public.analytics_sessions s on s.creator_click = c.public_click_id
        where s.person_id = pg_temp.q('person_a1'))
      and a.reason is null and a.rejected_at is null
    from pg_temp.award('a1') a)
  and (select c.sale_id is null and c.program_id = (pg_temp.program('acme')).id
      and c.member_id = (pg_temp.member('ada', 'acme')).id and c.affiliate_id = pg_temp.q('creator_ada')
      and c.terms_version = 2 and c.currency = 'USD' and c.commission_type = 'reward' and c.commission_rate_bps is null
      and c.basis_minor = 200 and c.commission_fixed_minor = 200 and c.earned_minor = 200 and c.fee_bps = 1000
      and c.fee_earned_minor = 20 and c.hold_until = pg_temp.ms(900) + interval '14 days'
      and c.approved_at is null and c.reversed_at is null and c.reason is null
    from pg_temp.com('a1') c)
  and pg_temp.moved('a1') = 'commission_reserved -200, fee_reserved -20'
  and pg_temp.available('acme') = 100000 - 220
  and pg_temp.n('public.program_creator_entries') = 0,
  'an event of a person a creator sent earns the reward: the award, its commission held for the hold of the terms, '
    || 'and the reward and the fee set aside from the balance');

select pg_temp.keep('tick_first', pg_temp.tick());
select pg_temp.check(pg_temp.kept('tick_first') = '{"judged":15,"earned":5,"approved":0,"remaining":0}' and pg_temp.waiting() = 0,
  'the next tick judges the rest');
select pg_temp.check(pg_temp.aw('n1') = 'none' and pg_temp.aw('n2') = 'none' and pg_temp.aw('n3') = 'none' and pg_temp.aw('n4') = 'none',
  'no award for a person nobody sent: no link, a bot visit, a link of another program, a link opened after the event');
select pg_temp.check(pg_temp.aw('l1') = 'creator_ben earned 200, held 200+20'
  and pg_temp.aw('l1_again') = 'creator_ada not_earned:already_rewarded 200'
  and pg_temp.aw('l1_trial') = 'creator_ada earned 500, held 500+50'
  and (pg_temp.award('l1_trial')).click_record_id = (select c.id from public.clicks c
    where c.affiliate_link_id = (pg_temp.link_row('ada', 'acme', 'YouTube')).id),
  'the last link opened before the event gets the reward; a reward is earned once per person, whoever sent them the '
    || 'second time; another reward of the same person goes to the link they opened last by then');
select pg_temp.check(pg_temp.aw('w1') = 'creator_ada earned 200, held 200+20' and pg_temp.aw('w2') = 'none',
  'a link opened exactly as long ago as the counting window still counts; a second longer ago it does not');
select pg_temp.check(pg_temp.aw('o1') = 'creator_ada not_earned:own_action 200'
  and pg_temp.aw('o2') = 'creator_ada not_earned:own_action 200'
  and pg_temp.aw('o3') = 'creator_ben earned 200, held 200+20',
  'a person with the email of anybody on the creator''s account earns that creator nothing; the same person earns '
    || 'another creator the reward');
select pg_temp.check(pg_temp.aw('d1') = 'creator_dee not_earned:not_in_terms 200'
  and (select a.member_id = (pg_temp.member('dee', 'acme')).id and a.terms_version = 1 and a.reward_label = 'Account created'
    from pg_temp.award('d1') a),
  'a creator whose terms pay for sales earns nothing for an event; the award names the reward as it is published');
select pg_temp.check(pg_temp.aw('a1_trial') = 'creator_ada earned 500, held 500+50'
  and pg_temp.aw('a1_again') = 'creator_ada not_earned:already_rewarded 200',
  'a person earns each reward once');
select pg_temp.check(pg_temp.available('acme') = 100000 - 220 - 220 - 550 - 220 - 220 - 550
  and pg_temp.n('public.program_reward_awards') = 11 and pg_temp.n('public.program_commissions where award_id is not null') = 6
  and pg_temp.books(), 'six rewards are set aside, and the books balance');

-- New terms: the trial pays 6.00 and a finished quiz 1.00. Ada accepts them, the others do not.
select pg_temp.publish_rewards('acme', '{"earn_from":"events","rewards":[
    {"key":"signup_completed","label":"Account created","amount_minor":200},
    {"key":"trial_started","label":"Trial started","amount_minor":600},
    {"key":"quiz_done","label":"Quiz finished","amount_minor":100}]}', 50000);
select pg_temp.check(pg_temp.pays_for('acme') = 'project_acme:quiz_done project_acme:signup_completed project_acme:trial_started '
    || 'project_acme_app:quiz_done project_acme_app:signup_completed project_acme_app:trial_started',
  'new terms with one more reward list one more event');
select pg_temp.check(pg_temp.accept('ada', 'acme')->'membership'->>'terms_version' = '3', 'Ada accepts the new terms');
select set_config('request.jwt.claims', '', true);
select pg_temp.visit('c1', 'cy', 'TikTok', now() - interval '1 hour');
select pg_temp.visit('a2', 'ada', 'Newsletter', now() - interval '1 hour');
select pg_temp.visit('b2', 'ben', 'YouTube', now() - interval '1 hour');
select pg_temp.event('c1_quiz', 'c1', 'quiz_done', clock_timestamp());
select pg_temp.event('a2_trial', 'a2', 'trial_started', clock_timestamp());
select pg_temp.event('b2_trial', 'b2', 'trial_started', clock_timestamp());
select pg_temp.event('a1_quiz', 'a1', 'quiz_done', clock_timestamp());
select pg_temp.check(pg_temp.tick() = '{"judged":4,"earned":3,"approved":0,"remaining":0}', 'four more events are judged');
select pg_temp.check(pg_temp.aw('c1_quiz') = 'creator_cy not_earned:not_in_terms 100'
  and (select a.terms_version = 2 and a.reward_label = 'Quiz finished' from pg_temp.award('c1_quiz') a)
  and pg_temp.aw('a2_trial') = 'creator_ada earned 600, held 600+60' and (pg_temp.award('a2_trial')).terms_version = 3
  and pg_temp.aw('b2_trial') = 'creator_ben earned 500, held 500+50' and (pg_temp.award('b2_trial')).terms_version = 2
  and pg_temp.aw('a1_quiz') = 'creator_ada earned 100, held 100+10',
  'a reward is what the creator had agreed to when the event happened: Ada earns the new amounts and the new reward, '
    || 'Ben the amount he accepted, and Cy nothing for a reward that is not in his terms');

-- A member who leaves --------------------------------------------------------------------------------
-- g1 made their account before Cy left (the event is judged after), g2 after. g3 opened Cy's
-- link 40 days ago, longer than the published counting window.
select pg_temp.visit('g1', 'cy', 'Main link', now() - interval '3 hours');
select pg_temp.visit('g2', 'cy', 'Main link', now() - interval '3 hours');
select pg_temp.visit('g3', 'cy', 'Main link', now() - interval '40 days');
select pg_temp.event('g1', 'g1', 'signup_completed', pg_temp.ms(300));
select pg_temp.leave('cy', 'acme');
select set_config('request.jwt.claims', '', true);
select pg_temp.event('g2', 'g2', 'signup_completed', clock_timestamp());
select pg_temp.event('g3', 'g3', 'signup_completed', clock_timestamp());
select pg_temp.check(pg_temp.tick() = '{"judged":3,"earned":1,"approved":0,"remaining":0}', 'three events around Cy leaving');
select pg_temp.check(pg_temp.aw('g1') = 'creator_cy earned 200, held 200+20'
  and pg_temp.aw('g2') = 'creator_cy not_earned:not_a_member 200'
  and (select a.member_id is null and a.terms_version is null and a.reward_label = 'Account created' and a.currency = 'USD'
    from pg_temp.award('g2') a)
  and pg_temp.aw('g3') = 'none',
  'an event from while the creator was a member earns after they left; one from after they left is not counted; '
    || 'and a link of somebody who is not a member that was opened before the counting window leaves no trace');

-- A paused program -----------------------------------------------------------------------------------
select pg_temp.visit('h1', 'ada', 'TikTok', now() - interval '2 hours');
select pg_temp.set_status('owner', 'acme', 'paused');
select set_config('request.jwt.claims', '', true);
select pg_temp.event('h1', 'h1', 'signup_completed', clock_timestamp());
select pg_temp.check((pg_temp.queued('h1')).event_id is not null and pg_temp.tick() = '{"judged":1,"earned":0,"approved":0,"remaining":0}'
  and pg_temp.aw('h1') = 'creator_ada not_earned:program_paused 200'
  and (pg_temp.award('h1')).member_id = (pg_temp.member('ada', 'acme')).id,
  'an event that arrives while the program is paused is judged and earns nothing');
select pg_temp.set_status('owner', 'acme', 'live');
select set_config('request.jwt.claims', '', true);
insert into qa values ('available_before_months', pg_temp.available('acme')::text);
select pg_temp.check(pg_temp.available('acme') = 100000 - 1980 - 660 - 550 - 110 - 220, 'ten rewards are set aside so far');

-- The monthly budget ----------------------------------------------------------------------------------
-- Three months ago, so that nothing here touches this month or the last 30 days. The budget
-- is 9.00 and, for this part, one creator may use all of it in a day.
insert into qa values ('month', (date_trunc('month', now() at time zone 'UTC') - interval '3 months')::text);
create function pg_temp.month(plus interval default '0') returns timestamptz language sql as $$
  select ((select value::timestamp from qa where key = 'month') + plus) at time zone 'UTC'
$$;
update public.platform_settings set program_reward_daily_share_bps = 10000 where singleton;
select pg_temp.budget('acme', 900);
select pg_temp.visit('p1', 'ada', 'Main link', pg_temp.month('9 days'));
select pg_temp.visit('p2', 'ben', 'Main link', pg_temp.month('10 days'));
select pg_temp.visit('p3', 'ben', 'Main link', pg_temp.month('11 days'));
select pg_temp.visit('p4', 'ada', 'Main link', pg_temp.month('20 days'));
select pg_temp.visit('p5', 'ada', 'Main link', pg_temp.month('20 days'));
select pg_temp.event('i1', 'p1', 'signup_completed', pg_temp.month('10 days'));
select pg_temp.event('i2', 'p1', 'trial_started', pg_temp.month('10 days 1 hour'));
select pg_temp.event('i3', 'p2', 'signup_completed', pg_temp.month('11 days'));
select pg_temp.event('i4', 'p3', 'signup_completed', pg_temp.month('12 days'));
-- The last second of that month, the first moment of the next, and p4 once more an hour later.
select pg_temp.event('i5', 'p4', 'signup_completed', pg_temp.month('1 month') - interval '1 second');
select pg_temp.event('i6', 'p5', 'signup_completed', pg_temp.month('1 month'));
select pg_temp.event('i7', 'p4', 'signup_completed', pg_temp.month('1 month 1 hour'));
select pg_temp.capture('program_rewards_tick.result', pg_temp.keep('tick_months', pg_temp.tick()));
select pg_temp.check(pg_temp.kept('tick_months') = '{"judged":7,"earned":5,"approved":5,"remaining":0}',
  'seven events of three months ago are judged, and the five that earn are approved in the same tick: their hold has passed');
select pg_temp.check(pg_temp.aw('i1') = 'creator_ada earned 200, approved 200+20'
  and pg_temp.aw('i2') = 'creator_ada earned 500, approved 500+50'
  and pg_temp.aw('i3') = 'creator_ben earned 200, approved 200+20'
  and pg_temp.aw('i4') = 'creator_ben not_earned:budget_reached 200',
  'rewards earn until the month''s budget is used, to the cent: 9.00 of 9.00 earns, the next reward does not');
select pg_temp.check(pg_temp.aw('i5') = 'creator_ada not_earned:budget_reached 200'
  and pg_temp.aw('i6') = 'creator_ada earned 200, approved 200+20'
  and pg_temp.aw('i7') = 'creator_ada earned 200, approved 200+20',
  'the budget is per calendar month: the last second of a used-up month earns nothing, the first moment of the next '
    || 'month earns, and so does a person whose earlier event earned nothing');
select pg_temp.check((select c.status = 'approved' and c.approved_at >= c.hold_until and c.amount_minor = 500 and c.fee_minor = 50
      and c.hold_until = pg_temp.month('10 days 1 hour') + interval '14 days'
      and (select count(*) = 1 and bool_and(e.kind = 'commission_approved' and e.amount_minor = 500 and e.currency = 'USD'
          and e.affiliate_id = pg_temp.q('creator_ada') and e.program_id = (pg_temp.program('acme')).id)
        from public.program_creator_entries e where e.commission_id = c.id)
    from pg_temp.com('i2') c)
  and pg_temp.moved('i2') = 'commission_reserved -500, fee_reserved -50'
  and (pg_temp.award('i2')).terms_version = 2
  and (select sum(e.amount_minor) = 1300 from public.program_creator_entries e),
  'approval after the hold makes the reward the creator''s: one entry of its amount, and the fee stays with KissMyApps');

-- The daily limit ------------------------------------------------------------------------------------
-- A budget of 60.00 lets one creator earn 6.00 a day: three accounts, not four.
update public.platform_settings set program_reward_daily_share_bps = 1000 where singleton;
select pg_temp.budget('acme', 6000);
select pg_temp.visit(k, 'ben', 'Main link', pg_temp.month('1 month 14 days')) from unnest(array['q1', 'q2', 'q3', 'q4', 'q5']) k;
select pg_temp.visit(k, 'ada', 'Main link', pg_temp.month('1 month 14 days')) from unnest(array['q6', 'q7', 'q8']) k;
select pg_temp.event('j1', 'q1', 'signup_completed', pg_temp.month('1 month 15 days 1 hour'));
select pg_temp.event('j2', 'q2', 'signup_completed', pg_temp.month('1 month 15 days 2 hours'));
select pg_temp.event('j3', 'q3', 'signup_completed', pg_temp.month('1 month 15 days 3 hours'));
select pg_temp.event('j4', 'q4', 'signup_completed', pg_temp.month('1 month 16 days') - interval '1 second');
select pg_temp.event('j5', 'q5', 'signup_completed', pg_temp.month('1 month 16 days'));
select pg_temp.event('j6', 'q6', 'signup_completed', pg_temp.month('1 month 15 days 5 hours'));
select pg_temp.check(pg_temp.tick() = '{"judged":6,"earned":5,"approved":5,"remaining":0}', 'six events of one day and the next');
select pg_temp.check(pg_temp.aw('j1') = 'creator_ben earned 200, approved 200+20'
  and pg_temp.aw('j2') = 'creator_ben earned 200, approved 200+20'
  and pg_temp.aw('j3') = 'creator_ben earned 200, approved 200+20'
  and pg_temp.aw('j4') = 'creator_ben not_earned:daily_limit 200'
  and pg_temp.aw('j5') = 'creator_ben earned 200, approved 200+20'
  and pg_temp.aw('j6') = 'creator_ada earned 200, approved 200+20',
  'one creator earns up to the daily limit, to the cent, and nothing more that day (UTC); the next day earns again, '
    || 'and another creator has a limit of their own');
-- A budget of 30.00 would make the limit 3.00, less than the largest reward: it is 5.00.
select pg_temp.budget('acme', 3000);
select pg_temp.event('j7', 'q7', 'trial_started', pg_temp.month('1 month 18 days 1 hour'));
select pg_temp.event('j8', 'q8', 'signup_completed', pg_temp.month('1 month 18 days 2 hours'));
select pg_temp.check(pg_temp.tick() = '{"judged":2,"earned":1,"approved":1,"remaining":0}'
  and pg_temp.aw('j7') = 'creator_ada earned 500, approved 500+50'
  and pg_temp.aw('j8') = 'creator_ada not_earned:daily_limit 200',
  'the daily limit is never less than the largest reward of the creator''s terms');
select pg_temp.budget('acme', 50000);
select pg_temp.check(pg_temp.available('acme') = (select value::bigint from qa where key = 'available_before_months')
    - 220 - 550 - 220 - 220 - 220 - 4 * 220 - 220 - 550
  and pg_temp.books(), 'eleven rewards of earlier months were set aside and approved, and the books balance');

-- Twenty days ago: inside the last 30 days, and the hold of 14 days has passed.
select pg_temp.visit('x1', 'ada', 'Facebook', now() - interval '21 days');
select pg_temp.visit('x2', 'ada', 'Facebook', now() - interval '21 days');
select pg_temp.event('x1', 'x1', 'signup_completed', now() - interval '20 days');
select pg_temp.event('x1_trial', 'x1', 'trial_started', now() - interval '20 days' + interval '1 hour');
select pg_temp.event('x2', 'x2', 'signup_completed', now() - interval '20 days' + interval '2 hours');
select pg_temp.check(pg_temp.tick() = '{"judged":3,"earned":3,"approved":3,"remaining":0}'
  and pg_temp.aw('x1') = 'creator_ada earned 200, approved 200+20'
  and pg_temp.aw('x1_trial') = 'creator_ada earned 500, approved 500+50'
  and pg_temp.aw('x2') = 'creator_ada earned 200, approved 200+20',
  'three events of twenty days ago earn and are approved');
-- An approved reward is money a payout can pay.
select pg_temp.check((select count(*) = 2
      and bool_and(k.blocker = 'payouts_off' and k.currency = 'USD' and jsonb_array_length(k.programs) = 1
        and k.programs->0->>'name' = 'Fluent')
      and max(k.payable_minor) filter (where k.affiliate_id = pg_temp.q('creator_ada')) = 200 + 500 + 200 + 200 + 200 + 500 + 900
      and max(k.payable_minor) filter (where k.affiliate_id = pg_temp.q('creator_ben')) = 200 + 3 * 200 + 200
    from kma_internal.program_payout_candidates('acct_KMAPlatform') k)
  and (select sum(e.amount_minor) = 3700 from public.program_creator_entries e),
  'the payout list sees what Ada and Ben have coming from approved rewards');
-- The sales tick has nothing to do with rewards.
select pg_temp.check(pg_temp.svc('program_commissions_tick', '{}') = '{"approved":0,"retried":0,"remaining":0}',
  'the sales tick finds no sale to approve');

-- Rejecting ------------------------------------------------------------------------------------------
insert into qa values ('available_before_reject', pg_temp.available('acme')::text);
select pg_temp.keep('reject_one', pg_temp.call('owner', pg_temp.reject_sql('acme', jsonb_build_object(
  'award_ids', pg_temp.award_ids('w1'), 'reason', 'fake', 'note', '  Looks scripted  '))));
select pg_temp.check(pg_temp.kept('reject_one') = '{"rejected":1,"returned_minor":220}'
  and pg_temp.aw('w1') = 'creator_ada rejected 200, reversed 0+0'
  and (select a.rejected_by = pg_temp.q('owner') and a.rejected_at is not null and a.reject_reason = 'fake'
      and a.reject_note = 'Looks scripted' and a.reason is null from pg_temp.award('w1') a)
  and (select c.reversed_at is not null and c.earned_minor = 200 and c.fee_earned_minor = 20 and c.approved_at is null
    from pg_temp.com('w1') c)
  and pg_temp.moved('w1') = 'commission_reserved -200, fee_reserved -20, commission_returned 200, fee_returned 20'
  and pg_temp.available('acme') = (select value::bigint from qa where key = 'available_before_reject') + 220
  and (select count(*) = 1 from public.audit_logs l where l.action = 'affiliate_program_rewards_rejected'
    and l.actor_user_id = pg_temp.q('owner') and l.target_id = (pg_temp.program('acme')).id and l.reason = 'fake'
    and l.after_data @> '{"returned_minor":220}'),
  'the merchant rejects a reward on hold: the reward and its fee go back to the balance, and the award says who, when and why');
-- Several at once, by an admin of the workspace; an id sent twice counts once.
select pg_temp.capture('workspace_program_reward_reject.done', pg_temp.keep('reject_many',
  pg_temp.call('admin', pg_temp.reject_sql('acme', jsonb_build_object(
    'award_ids', pg_temp.award_ids('o3', 'b2_trial', 'o3'), 'reason', 'duplicate', 'note', null)))));
select pg_temp.check(pg_temp.kept('reject_many') = '{"rejected":2,"returned_minor":770}'
  and pg_temp.aw('o3') = 'creator_ben rejected 200, reversed 0+0' and pg_temp.aw('b2_trial') = 'creator_ben rejected 500, reversed 0+0'
  and (select a.rejected_by = pg_temp.q('admin') and a.reject_reason = 'duplicate' and a.reject_note is null from pg_temp.award('o3') a)
  and pg_temp.available('acme') = (select value::bigint from qa where key = 'available_before_reject') + 220 + 770,
  'several rewards are rejected in one call');
-- What cannot be rejected: an approved reward, an award that earned nothing, one already
-- rejected, something that is not an award of this program. One of these refuses the whole call.
select pg_temp.check(pg_temp.try('owner', pg_temp.reject_sql('acme', jsonb_build_object('award_ids', ids, 'reason', 'other')))
  = '22023 not_rejectable', 'cannot reject ' || what)
from (values ('an approved reward', pg_temp.award_ids('i1')), ('an award that earned nothing', pg_temp.award_ids('d1')),
  ('a rejected reward', pg_temp.award_ids('w1')), ('an unknown award', jsonb_build_array(gen_random_uuid())),
  ('a reward on hold together with an approved one', pg_temp.award_ids('a1', 'i1')),
  ('a reward on hold together with an unknown one', pg_temp.award_ids('l1') || jsonb_build_array(gen_random_uuid()))) x(what, ids);
select pg_temp.check(pg_temp.try('rival_owner', pg_temp.reject_sql('rival', jsonb_build_object('award_ids', pg_temp.award_ids('a1'), 'reason', 'fake')))
    = '22023 not_rejectable'
  and pg_temp.try('empty_owner', pg_temp.reject_sql('empty', jsonb_build_object('award_ids', pg_temp.award_ids('a1'), 'reason', 'fake')))
    = '22023 not_rejectable'
  and pg_temp.aw('a1') = 'creator_ada earned 200, held 200+20' and pg_temp.aw('l1') = 'creator_ben earned 200, held 200+20'
  and pg_temp.aw('i1') = 'creator_ada earned 200, approved 200+20'
  and pg_temp.available('acme') = (select value::bigint from qa where key = 'available_before_reject') + 220 + 770
  and pg_temp.n('public.program_reward_awards where status = ''rejected''') = 3,
  'a merchant cannot reject a reward of another program, and a refused call changes nothing');
select pg_temp.check(pg_temp.try('owner', pg_temp.reject_sql('acme', input)) = '22023 invalid_input', 'refused: ' || input::text)
from (values ('{"reason":"fake"}'::jsonb), ('{"award_ids":[],"reason":"fake"}'), ('{"award_ids":"all","reason":"fake"}'),
  ('{"award_ids":["not-a-uuid"],"reason":"fake"}'), ('{"award_ids":[7],"reason":"fake"}'),
  (jsonb_build_object('award_ids', (select jsonb_agg(gen_random_uuid()) from generate_series(1, 101)), 'reason', 'fake')),
  (jsonb_build_object('award_ids', pg_temp.award_ids('a1'))),
  (jsonb_build_object('award_ids', pg_temp.award_ids('a1'), 'reason', 'boring')),
  (jsonb_build_object('award_ids', pg_temp.award_ids('a1'), 'reason', null)),
  (jsonb_build_object('award_ids', pg_temp.award_ids('a1'), 'reason', 'fake', 'note', 7)),
  (jsonb_build_object('award_ids', pg_temp.award_ids('a1'), 'reason', 'fake', 'note', repeat('n', 301))),
  (jsonb_build_object('award_ids', pg_temp.award_ids('a1'), 'reason', 'fake', 'person_id', gen_random_uuid())),
  ('[]'), ('null')) x(input);
select pg_temp.check(pg_temp.try('owner', format('select public.workspace_program_reward_reject(%L, null)', pg_temp.q('acme')))
    = '22023 invalid_input'
  and pg_temp.try('analyst', pg_temp.reject_sql('acme', jsonb_build_object('award_ids', pg_temp.award_ids('a1'), 'reason', 'fake')))
    = '42501'
  and pg_temp.try('rival_owner', pg_temp.reject_sql('acme', jsonb_build_object('award_ids', pg_temp.award_ids('a1'), 'reason', 'fake')))
    = 'P0002'
  and pg_temp.try('ada', pg_temp.reject_sql('acme', jsonb_build_object('award_ids', pg_temp.award_ids('a1'), 'reason', 'fake')))
    = 'P0002'
  and pg_temp.aw('a1') = 'creator_ada earned 200, held 200+20',
  'only the owner and the admins of the workspace reject rewards');
-- A note of exactly 300 characters is kept; an empty one is no note.
select pg_temp.check(pg_temp.call('owner', pg_temp.reject_sql('acme', jsonb_build_object(
    'award_ids', pg_temp.award_ids('g1'), 'reason', 'low_quality', 'note', repeat('n', 300)))) = '{"rejected":1,"returned_minor":220}'
  and length((pg_temp.award('g1')).reject_note) = 300 and (pg_temp.award('g1')).reject_reason = 'low_quality',
  'a note can be 300 characters long');
select set_config('request.jwt.claims', '', true);
-- A rejected reward is not earned again by the same person.
select pg_temp.event('o3_again', 'o3', 'signup_completed', clock_timestamp());
select pg_temp.check(pg_temp.tick() = '{"judged":1,"earned":0,"approved":0,"remaining":0}'
  and pg_temp.aw('o3_again') = 'creator_ben not_earned:already_rewarded 200'
  and pg_temp.books(), 'a person whose reward was rejected does not earn it again, and the books balance');

-- An event that cannot be judged -----------------------------------------------------------------------
-- A fixture makes the award of one person impossible to write. Its event is noted and tried
-- again later; the event after it is judged in the same tick.
select pg_temp.visit('f1', 'ada', 'X', now() - interval '2 hours');
select pg_temp.visit('f2', 'ada', 'X', now() - interval '2 hours');
do $$
begin
  execute format('alter table public.program_reward_awards add constraint fixture_refuses check (person_id <> %L) not valid',
    pg_temp.q('person_f1'));
end $$;
select pg_temp.event('f1', 'f1', 'signup_completed', clock_timestamp());
select pg_temp.event('f2', 'f2', 'signup_completed', clock_timestamp());
insert into qa values ('available_before_failure', pg_temp.available('acme')::text);
select pg_temp.check(pg_temp.tick() = '{"judged":1,"earned":1,"approved":0,"remaining":0}'
  and pg_temp.aw('f2') = 'creator_ada earned 200, held 200+20' and pg_temp.aw('f1') = 'none'
  and (select w.attempts = 1 and w.last_error = '23514'
      and w.next_attempt_at between clock_timestamp() + interval '50 seconds' and clock_timestamp() + interval '60 seconds'
    from pg_temp.queued('f1') w)
  and pg_temp.available('acme') = (select value::bigint from qa where key = 'available_before_failure') - 220,
  'an event that fails is kept with the code of the failure and tried again in a minute; nothing of it is written, '
    || 'and the next event is judged');
select pg_temp.check(pg_temp.tick() = '{"judged":0,"earned":0,"approved":0,"remaining":0}' and (pg_temp.queued('f1')).attempts = 1,
  'it is not tried before its time');
update public.program_reward_queue set next_attempt_at = now() where event_id = pg_temp.eid('f1');
select pg_temp.check(pg_temp.tick() = '{"judged":0,"earned":0,"approved":0,"remaining":0}'
  and (select w.attempts = 2 and w.next_attempt_at between clock_timestamp() + interval '110 seconds' and clock_timestamp() + interval '120 seconds'
    from pg_temp.queued('f1') w),
  'a second failure waits two minutes');
update public.program_reward_queue set next_attempt_at = now(), attempts = 12 where event_id = pg_temp.eid('f1');
select pg_temp.check(pg_temp.tick()->>'judged' = '0'
  and (select w.attempts = 13 and w.next_attempt_at between clock_timestamp() + interval '359 minutes' and clock_timestamp() + interval '360 minutes'
    from pg_temp.queued('f1') w)
  and pg_temp.service('select public.program_reward_health()') @> '{"queue":{"due":0,"waiting":1,"failing":1},"errors":{"23514":1}}',
  'the wait doubles up to six hours, and the health view shows the failing event');
alter table public.program_reward_awards drop constraint fixture_refuses;
update public.program_reward_queue set next_attempt_at = now() where event_id = pg_temp.eid('f1');
select pg_temp.check(pg_temp.tick() = '{"judged":1,"earned":1,"approved":0,"remaining":0}'
  and pg_temp.aw('f1') = 'creator_ada earned 200, held 200+20' and pg_temp.waiting() = 0
  and pg_temp.available('acme') = (select value::bigint from qa where key = 'available_before_failure') - 440,
  'once it can be judged it is, and it leaves the queue');

-- A person whose profiles are folded together ---------------------------------------------------------
-- m1 is anonymous and earns. Then they sign in on that device as a user analytics already
-- knows: the two profiles become one, and that one person does not earn the reward again.
select pg_temp.visit('m1', 'ada', 'TikTok', now() - interval '2 hours');
select pg_temp.event('m1', 'm1', 'signup_completed', clock_timestamp());
select pg_temp.check(pg_temp.tick()->>'earned' = '1' and pg_temp.aw('m1') = 'creator_ada earned 200, held 200+20', 'm1 earns');
select pg_temp.person('u1', '{}', true);
select pg_temp.visit('u1', 'ben', 'Main link', now() - interval '1 hour');
select pg_temp.keep('resolved_u1', to_jsonb(kma_internal.analytics_resolve_person(pg_temp.q('project_acme'), 'production',
  'user-u1', 'anon-m1', clock_timestamp(), '{}'::jsonb, '{}'::jsonb, null)));
select pg_temp.check(pg_temp.kept('resolved_u1') = to_jsonb(pg_temp.q('person_u1'))
  and not exists (select 1 from public.analytics_people p where p.id = pg_temp.q('person_m1'))
  and (select e.person_id = pg_temp.q('person_u1') from public.analytics_events e where e.id = pg_temp.eid('m1')),
  'analytics folds the anonymous profile into the user''s');
select pg_temp.event('u1', 'u1', 'signup_completed', clock_timestamp());
select pg_temp.check(pg_temp.tick() = '{"judged":1,"earned":0,"approved":0,"remaining":0}'
  and pg_temp.aw('u1') = 'creator_ben not_earned:already_rewarded 200',
  'the reward an anonymous profile earned counts for the user it turned out to be');
-- m2's event is still waiting when their profile is folded into u2's: it is judged for u2.
select pg_temp.visit('m2', 'ada', 'TikTok', now() - interval '2 hours');
select pg_temp.person('u2', '{}', true);
select pg_temp.event('m2', 'm2', 'signup_completed', clock_timestamp());
select kma_internal.analytics_resolve_person(pg_temp.q('project_acme'), 'production', 'user-u2', 'anon-m2',
  clock_timestamp(), '{}'::jsonb, '{}'::jsonb, null);
select pg_temp.check((pg_temp.queued('m2')).person_id = pg_temp.q('person_m2')
  and pg_temp.tick() = '{"judged":1,"earned":1,"approved":0,"remaining":0}'
  and pg_temp.aw('m2') = 'creator_ada earned 200, held 200+20' and (pg_temp.award('m2')).person_id = pg_temp.q('person_u2'),
  'an event that waited while its profile was folded into another is judged for the person it belongs to now');

-- The balance runs out --------------------------------------------------------------------------------
-- 2.10 is left: enough for a reward of 2.00, not for the reward and its fee.
select kma_internal.program_balance_post((pg_temp.account('acme')).id, 'adjustment', 210 - pg_temp.available('acme'), null, null, 'Fixture');
select pg_temp.visit(k, 'ada', 'TikTok', now() - interval '2 hours') from unnest(array['z1', 'z2', 'z3']) k;
select pg_temp.event('z1', 'z1', 'signup_completed', clock_timestamp());
select pg_temp.keep('tick_z1', pg_temp.tick());
select pg_temp.check(pg_temp.kept('tick_z1') = '{"judged":1,"earned":0,"approved":0,"remaining":0}'
  and pg_temp.aw('z1') = 'creator_ada not_earned:balance_empty 200'
  and (pg_temp.award('z1')).member_id = (pg_temp.member('ada', 'acme')).id and (pg_temp.award('z1')).terms_version = 3
  and pg_temp.available('acme') = 210
  and (select e.kind = 'adjustment' from public.program_balance_entries e
    where e.account_id = (pg_temp.account('acme')).id order by e.seq desc limit 1)
  and (select p.status = 'paused' and p.pause_reason = 'balance_empty' from pg_temp.program('acme') p)
  and exists (select 1 from public.audit_logs l where l.action = 'affiliate_program_balance_paused'
    and l.target_id = (pg_temp.program('acme')).id),
  'a reward the balance cannot cover with its fee earns nothing: neither part is set aside, there is no commission, '
    || 'and the program pauses');
select pg_temp.check(pg_temp.open('ada', 'acme', 'TikTok')->>'click_id' is null and pg_temp.n('public.program_reward_events') = 6,
  'while the program is paused for its balance its links credit nothing, and its events are still judged');
select pg_temp.event('z2', 'z2', 'signup_completed', clock_timestamp());
select pg_temp.check(pg_temp.tick()->>'earned' = '0' and pg_temp.aw('z2') = 'creator_ada not_earned:program_paused 200',
  'an event that arrives meanwhile is not counted');
-- Money arrives: the program is live again and rewards earn.
select pg_temp.fund('acme', 50000);
select pg_temp.check(kma_internal.program_balance_resume((pg_temp.account('acme')).id) and (pg_temp.program('acme')).status = 'live',
  'money arrives and the program is live again');
select pg_temp.event('z3', 'z3', 'signup_completed', clock_timestamp());
select pg_temp.check(pg_temp.tick()->>'earned' = '1' and pg_temp.aw('z3') = 'creator_ada earned 200, held 200+20'
  and pg_temp.available('acme') = 50210 - 220 and pg_temp.books(), 'the next event earns, and the books balance');

-- A program that pays for both, with no balance yet, in another currency --------------------------------
-- Quiet Club's terms now also pay 3.00 EUR for an account. It never opened a balance.
select pg_temp.publish_rewards('quiet', '{"earn_from":"both","currency":"EUR","rewards":[
  {"key":"signup_completed","label":"Joined the club","amount_minor":300}]}', 10000);
select pg_temp.check(pg_temp.join('eve', 'quiet')->'membership'->>'status' = 'active', 'Eve joins Quiet Club');
select set_config('request.jwt.claims', '', true);
update public.affiliate_program_members set activated_at = now() - interval '500 days' where id = (pg_temp.member('eve', 'quiet')).id;
select pg_temp.person('k1', '{}', false, 'quiet');
select pg_temp.person('k2', '{}', false, 'quiet');
select pg_temp.visit('k1', 'eve', 'Main link', now() - interval '2 hours', 'quiet');
select pg_temp.visit('k2', 'eve', 'Main link', now() - interval '2 hours', 'quiet');
select pg_temp.event('k1', 'k1', 'signup_completed', clock_timestamp());
select pg_temp.check(pg_temp.pays_for('quiet') = 'project_quiet:signup_completed'
  and pg_temp.tick() = '{"judged":1,"earned":0,"approved":0,"remaining":0}'
  and pg_temp.aw('k1') = 'creator_eve not_earned:balance_empty 300' and (pg_temp.award('k1')).currency = 'EUR'
  and (pg_temp.award('k1')).reward_label = 'Joined the club'
  and (select p.status = 'paused' and p.pause_reason = 'balance_empty' from pg_temp.program('quiet') p),
  'a program with no balance earns nothing for an event and pauses');
select pg_temp.open_account('quiet', 'quiet_owner');
select pg_temp.fund('quiet', 20000);
select pg_temp.check(kma_internal.program_balance_resume((pg_temp.account('quiet')).id) and (pg_temp.account('quiet')).currency = 'USD',
  'Quiet Club opens a balance in dollars and is live again');
select pg_temp.event('k2', 'k2', 'signup_completed', clock_timestamp());
select pg_temp.check(pg_temp.tick()->>'earned' = '0' and pg_temp.aw('k2') = 'creator_eve not_earned:currency_mismatch 300'
  and pg_temp.available('quiet') = 20000 and (pg_temp.program('quiet')).status = 'live',
  'a reward in another currency than the balance is not counted');
select pg_temp.check(pg_temp.try('quiet_owner', pg_temp.reject_sql('quiet', jsonb_build_object('award_ids', pg_temp.award_ids('a1'), 'reason', 'fake')))
    = '22023 not_rejectable'
  and (select a->'program'->>'earn_from' = 'both' and jsonb_array_length(a->'awards') = 2 and jsonb_array_length(a->'creators') = 1
      and a->'creators'->0 @> '{"name":"Eve Stone","people":0,"went_further":null,"earned_minor":0,"not_counted":2}'
      and a->'budget' @> '{"budget_minor":10000,"used_minor":0,"daily_limit_minor":1000}'
    from (select pg_temp.rewards('quiet_owner', 'quiet') as a) x),
  'Quiet Club reads its own rewards and cannot reject Fluent''s; a program with one reward has no "went further"');
select set_config('request.jwt.claims', '', true);

-- What the merchant reads ------------------------------------------------------------------------------
select pg_temp.capture('workspace_program_rewards.busy', pg_temp.keep('busy', pg_temp.rewards('owner', 'acme')));
select pg_temp.check((select pg_temp.keys(a) = 'awards budget can_manage creators currency next_before program rewards'
      and a->'program' = jsonb_build_object('id', (pg_temp.program('acme')).id, 'slug', 'fluent', 'name', 'Fluent',
        'status', 'live', 'earn_from', 'events')
      and a->>'currency' = 'USD' and a->>'can_manage' = 'true' and a->>'next_before' is null
      and (select bool_and(pg_temp.keys(s) = 'amount_minor award_id can_reject creator_name hold_until link_name member_id '
          || 'occurred_at reason reject_reason reward_key reward_label status') from jsonb_array_elements(a->'awards') s)
      and (select bool_and(pg_temp.keys(c) = 'clicks counts earned_minor member_id name not_counted pending_minor people '
          || 'rejected went_further') from jsonb_array_elements(a->'creators') c)
      and pg_temp.keys(a->'budget') = 'budget_minor daily_limit_minor fee_bps month used_minor'
    from (select pg_temp.kept('busy') as a) x),
  'the Rewards page has the shape the console reads');
-- The three events of twenty days ago are of this month only when this month is that old.
select pg_temp.check((select a->'budget' = jsonb_build_object('month', to_char(now() at time zone 'UTC', 'YYYY-MM'),
        'budget_minor', 50000, 'daily_limit_minor', 5000, 'fee_bps', 1000,
        'used_minor', 200 + 200 + 500 + 500 + 600 + 100 + 200 + 200 + 200 + 200 + 200
          + case when now() - interval '20 days' >= m.start then 200 else 0 end
          + case when now() - interval '20 days' + interval '1 hour' >= m.start then 500 else 0 end
          + case when now() - interval '20 days' + interval '2 hours' >= m.start then 200 else 0 end)
      and a->'rewards' = jsonb_build_array(
        jsonb_build_object('key', 'signup_completed', 'label', 'Account created', 'amount_minor', 200,
          'count', 7 + case when now() - interval '20 days' >= m.start then 1 else 0 end
            + case when now() - interval '20 days' + interval '2 hours' >= m.start then 1 else 0 end,
          'amount_total_minor', 1400 + case when now() - interval '20 days' >= m.start then 200 else 0 end
            + case when now() - interval '20 days' + interval '2 hours' >= m.start then 200 else 0 end),
        jsonb_build_object('key', 'trial_started', 'label', 'Trial started', 'amount_minor', 600,
          'count', 3 + case when now() - interval '20 days' + interval '1 hour' >= m.start then 1 else 0 end,
          'amount_total_minor', 1600 + case when now() - interval '20 days' + interval '1 hour' >= m.start then 500 else 0 end),
        jsonb_build_object('key', 'quiz_done', 'label', 'Quiz finished', 'amount_minor', 100, 'count', 1, 'amount_total_minor', 100))
    from (select pg_temp.kept('busy') as a) x,
      (select date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' as start) m),
  'the budget shows what this month''s rewards have used (a rejected reward gives its part back), and each reward as it '
    || 'is published with this month''s events and what they came to');
select pg_temp.check((select jsonb_array_length(a->'creators') = 4
      and (select string_agg(c->>'name', ', ' order by n) from jsonb_array_elements(a->'creators') with ordinality x(c, n))
        = 'Ada Okafor, Ben Creator, Cy Park, Dee Vale'
      and pg_temp.creator_of(a, 'Ada Okafor') - 'clicks' = jsonb_build_object('member_id', (pg_temp.member('ada', 'acme')).id,
        'name', 'Ada Okafor', 'people', 8, 'went_further', 2,
        'counts', '[{"key":"signup_completed","count":8},{"key":"trial_started","count":4},{"key":"quiz_done","count":1}]'::jsonb,
        'earned_minor', 8 * 200 + 500 + 500 + 600 + 500 + 100, 'pending_minor', 6 * 200 + 500 + 500 + 600 + 100,
        'rejected', 1, 'not_counted', 7)
      and pg_temp.creator_of(a, 'Ben Creator') - 'clicks' = jsonb_build_object('member_id', (pg_temp.member('ben', 'acme')).id,
        'name', 'Ben Creator', 'people', 1, 'went_further', 1,
        'counts', '[{"key":"signup_completed","count":1},{"key":"trial_started","count":0},{"key":"quiz_done","count":0}]'::jsonb,
        'earned_minor', 200, 'pending_minor', 200, 'rejected', 2, 'not_counted', 2)
      and pg_temp.creator_of(a, 'Cy Park') - 'clicks' = jsonb_build_object('member_id', (pg_temp.member('cy', 'acme')).id,
        'name', 'Cy Park', 'people', 0, 'went_further', 0,
        'counts', '[{"key":"signup_completed","count":0},{"key":"trial_started","count":0},{"key":"quiz_done","count":0}]'::jsonb,
        'earned_minor', 0, 'pending_minor', 0, 'rejected', 1, 'not_counted', 2)
      and pg_temp.creator_of(a, 'Dee Vale') - 'clicks' = jsonb_build_object('member_id', (pg_temp.member('dee', 'acme')).id,
        'name', 'Dee Vale', 'people', 0, 'went_further', 0,
        'counts', '[{"key":"signup_completed","count":0},{"key":"trial_started","count":0},{"key":"quiz_done","count":0}]'::jsonb,
        'earned_minor', 0, 'pending_minor', 0, 'rejected', 0, 'not_counted', 1)
      and (select bool_and((c->>'clicks')::bigint = (select count(*) from public.clicks k
          join public.affiliate_program_members m on m.affiliate_id = k.affiliate_id and m.id = (c->>'member_id')::uuid
          where k.product_id = (pg_temp.program('acme')).product_id and not k.is_bot
            and k.occurred_at >= ((now() at time zone 'UTC')::date - 29)::timestamp at time zone 'UTC'))
        from jsonb_array_elements(a->'creators') c)
      and (pg_temp.creator_of(a, 'Dee Vale')->>'clicks')::bigint = 1 and (pg_temp.creator_of(a, 'Cy Park')->>'clicks')::bigint = 3
    from (select pg_temp.kept('busy') as a) x),
  'each creator''s last 30 days: clicks, the people who made an account and were rewarded for it, how many of those '
    || 'went on to another reward, each reward''s count, what the rewards are worth and the part on hold, rejected and not counted');
select pg_temp.check((select jsonb_array_length(a->'awards') = 45 and pg_temp.n('public.program_reward_awards') = 47
      and (select bool_and((s->>'occurred_at')::timestamptz >= (t->>'occurred_at')::timestamptz)
        from jsonb_array_elements(a->'awards') with ordinality x(s, n)
        join jsonb_array_elements(a->'awards') with ordinality y(t, o) on o = n + 1)
      and left(pg_temp.listed(a), 64) = 'z3 z2 z1 m2 u1 m1 f2 f1 o3_again h1 g2 a1_quiz b2_trial a2_trial'
      and right(pg_temp.listed(a), 41) = 'j7 j5 j4 j6 j3 j2 j1 i7 i6 i5 i4 i3 i2 i1'
      and pg_temp.row_of(a, 'a1') = jsonb_build_object('award_id', (pg_temp.award('a1')).id, 'occurred_at', pg_temp.ms(900),
        'member_id', (pg_temp.member('ada', 'acme')).id, 'creator_name', 'Ada Okafor', 'link_name', 'TikTok',
        'reward_key', 'signup_completed', 'reward_label', 'Account created', 'amount_minor', 200, 'status', 'pending',
        'reason', null, 'hold_until', pg_temp.ms(900) + interval '14 days', 'reject_reason', null, 'can_reject', true)
      and pg_temp.row_of(a, 'i2') @> '{"status":"approved","can_reject":false,"amount_minor":500,"link_name":"Main link","reason":null}'
      and pg_temp.row_of(a, 'w1') @> '{"status":"rejected","can_reject":false,"amount_minor":200,"link_name":"Instagram","reject_reason":"fake"}'
      and (pg_temp.row_of(a, 'w1')->>'hold_until') is not null
      and pg_temp.row_of(a, 'd1') @> '{"status":"not_counted","reason":"not_in_terms","can_reject":false,"hold_until":null,
        "creator_name":"Dee Vale","link_name":"Main link","reject_reason":null}'
      and pg_temp.row_of(a, 'g2') @> jsonb_build_object('status', 'not_counted', 'reason', 'not_a_member', 'creator_name', 'Cy Park',
        'member_id', (pg_temp.member('cy', 'acme')).id)
      and pg_temp.row_of(a, 'l1_trial') @> '{"status":"pending","link_name":"YouTube","reward_label":"Trial started","amount_minor":500}'
      and pg_temp.row_of(a, 'a2_trial') @> '{"status":"pending","link_name":"Newsletter","amount_minor":600}'
      and pg_temp.row_of(a, 'x1') @> '{"status":"approved","link_name":"Facebook"}'
      and (select count(*) from jsonb_array_elements(a->'awards') s where s->>'can_reject' = 'true')
        = pg_temp.n('public.program_commissions where award_id is not null and status = ''held'' and program_id = '
          || quote_literal((pg_temp.program('acme')).id))
      and (select string_agg(distinct s->>'reason', ' ' order by s->>'reason') from jsonb_array_elements(a->'awards') s)
        = 'already_rewarded balance_empty budget_reached daily_limit not_a_member not_in_terms own_action program_paused'
    from (select pg_temp.kept('busy') as a) x),
  'the rewards are listed newest first, each with its creator, the link it came through, what it is worth, its status '
    || 'and why it was not counted; the ones on hold can be rejected');
-- Nothing about the people who did the events.
select pg_temp.check((select not exists (select 1 from unnest(pg_temp.all_keys(a)) k
        where k ~ '(person|session|event|email|trait|distinct|anonymous|user)')
      and not exists (select 1 from public.analytics_people p where a::text like '%' || p.id::text || '%')
      and not exists (select 1 from public.analytics_sessions s where a::text like '%' || s.id::text || '%')
      and not exists (select 1 from qa where key like 'person\_%' and a::text like '%' || value || '%')
      and a::text not like '%@%' and a::text not like '%Private%' and a::text !~ 'anon-|user-|visit-'
    from (select pg_temp.kept('busy') as a) x),
  'no person, session or event id, no email and no trait is in what the merchant reads');

-- One creator, one status, pages.
select pg_temp.capture('workspace_program_rewards.filtered_creator', pg_temp.keep('by_ben',
  pg_temp.rewards('owner', 'acme', jsonb_build_object('member_id', (pg_temp.member('ben', 'acme')).id))));
select pg_temp.check((select pg_temp.listed(a) = 'u1 o3_again b2_trial o3 l1 j5 j4 j3 j2 j1 i4 i3'
      and (select bool_and(s->>'creator_name' = 'Ben Creator') from jsonb_array_elements(a->'awards') s)
      and a - 'awards' = pg_temp.kept('busy') - 'awards'
    from (select pg_temp.kept('by_ben') as a) x),
  'the list can be of one creator; the budget, the rewards and the creators stay those of the program');
select pg_temp.capture('workspace_program_rewards.pending_only', pg_temp.keep('pending',
  pg_temp.rewards('admin', 'acme', '{"status":"pending"}')));
select pg_temp.check((select pg_temp.listed(a) = 'z3 m2 m1 f2 f1 a1_quiz a2_trial a1_trial l1_trial l1 a1'
      and (select bool_and(s @> '{"status":"pending","can_reject":true,"reason":null}') from jsonb_array_elements(a->'awards') s)
      and a->>'can_manage' = 'true'
    from (select pg_temp.kept('pending') as a) x)
  and pg_temp.listed(pg_temp.rewards('owner', 'acme', '{"status":"rejected"}')) = 'b2_trial g1 o3 w1'
  and pg_temp.listed(pg_temp.rewards('owner', 'acme', '{"status":"approved"}')) = 'x2 x1_trial x1 j7 j5 j6 j3 j2 j1 i7 i6 i3 i2 i1'
  and pg_temp.listed(pg_temp.rewards('owner', 'acme', '{"status":"not_counted"}'))
    = 'z2 z1 u1 o3_again h1 g2 c1_quiz a1_again d1 o2 o1 l1_again j8 j4 i5 i4'
  and pg_temp.listed(pg_temp.rewards('owner', 'acme', jsonb_build_object('status', 'rejected',
    'member_id', (pg_temp.member('ben', 'acme')).id))) = 'b2_trial o3'
  and pg_temp.listed(pg_temp.rewards('owner', 'acme', jsonb_build_object('member_id', (pg_temp.member('eve', 'quiet')).id))) = ''
  and pg_temp.listed(pg_temp.rewards('owner', 'acme', jsonb_build_object('member_id', gen_random_uuid()))) = '',
  'the list can be of one status, or of one creator and one status; a member of another program lists nothing');
-- Somebody who only reads cannot reject.
select pg_temp.check((select a->>'can_manage' = 'false' and jsonb_array_length(a->'awards') = 45
      and not exists (select 1 from jsonb_array_elements(a->'awards') s where s->>'can_reject' = 'true')
      and a - 'awards' - 'can_manage' = pg_temp.kept('busy') - 'awards' - 'can_manage'
    from (select pg_temp.rewards('analyst', 'acme') as a) x),
  'an analyst reads the same page and can reject nothing');
-- Pages: five at a time. The first page ends on a whole moment.
select pg_temp.keep('page_1', pg_temp.rewards('owner', 'acme', '{"limit":5}'));
select pg_temp.capture('workspace_program_rewards.next_page', pg_temp.keep('page_2',
  pg_temp.rewards('owner', 'acme', jsonb_build_object('limit', 5, 'before', pg_temp.kept('page_1')->>'next_before'))));
select pg_temp.check(pg_temp.listed(pg_temp.kept('page_1')) = 'z3 z2 z1 m2 u1'
  and (pg_temp.kept('page_1')->>'next_before')::timestamptz = (pg_temp.award('u1')).occurred_at
  and pg_temp.listed(pg_temp.kept('page_2')) = 'm1 f2 f1 o3_again h1'
  and (pg_temp.kept('page_2')->>'next_before')::timestamptz = (pg_temp.award('h1')).occurred_at,
  'the list comes a page at a time, each page starting before the last moment of the one before');
select pg_temp.check((with recursive pages as (
      select 1 as page, pg_temp.rewards('owner', 'acme', '{"limit":7}') as a
      union all
      select page + 1, pg_temp.rewards('owner', 'acme', jsonb_build_object('limit', 7, 'before', a->>'next_before'))
      from pages where a->>'next_before' is not null and page < 20)
    select count(*) = 7 and string_agg(pg_temp.listed(a), ' ' order by page) = pg_temp.listed(pg_temp.kept('busy'))
    from pages),
  'walking the pages lists every reward once, in order');
-- Awards of the same instant come on one page, however small the limit.
insert into qa values ('same_instant', (clock_timestamp() + interval '1 minute')::text);
select pg_temp.visit(k, 'ada', 'X', now() - interval '2 hours') from unnest(array['t1', 't2', 't3']) k;
select pg_temp.event(k, k, 'signup_completed', (select value::timestamptz from qa where key = 'same_instant'))
  from unnest(array['t1', 't2', 't3']) k;
select pg_temp.check(pg_temp.tick()->>'earned' = '3'
  and (select jsonb_array_length(a->'awards') = 3 and (a->>'next_before')::timestamptz = (select value::timestamptz from qa where key = 'same_instant')
    from (select pg_temp.rewards('owner', 'acme', '{"limit":1}') as a) x)
  and pg_temp.listed(pg_temp.rewards('owner', 'acme', jsonb_build_object('limit', 1,
    'before', (select value from qa where key = 'same_instant')))) = 'z3',
  'three rewards of one instant come together, and the next page starts before them');
select pg_temp.check(pg_temp.try('owner', pg_temp.rewards_sql('acme', input)) = '22023 invalid_input', 'refused: ' || input::text)
from (values ('{"limit":0}'::jsonb), ('{"limit":101}'), ('{"limit":"5"}'), ('{"limit":2.5}'), ('{"before":"yesterday-ish"}'),
  ('{"before":7}'), ('{"member_id":"ben"}'), ('{"member_id":7}'), ('{"status":"held"}'), ('{"status":7}'),
  ('{"person_id":"x"}'), ('[]'), ('null')) x(input);
select pg_temp.check(pg_temp.try('owner', format('select public.workspace_program_rewards(%L, null)', pg_temp.q('acme'))) = '22023 invalid_input'
  and pg_temp.try('owner', pg_temp.rewards_sql('acme', '{"limit":null,"before":null,"member_id":null,"status":null}')) = 'ok'
  and pg_temp.try('rival_owner', pg_temp.rewards_sql('acme')) = 'P0002'
  and pg_temp.try('ada', pg_temp.rewards_sql('acme')) = 'P0002'
  and pg_temp.try('stranger', pg_temp.rewards_sql('acme')) = 'P0002',
  'the page is for the members of the workspace, and every field of the request may be null');

-- A program that goes back to sales keeps showing the rewards it has --------------------------------
select pg_temp.publish_rewards('acme', '{"earn_from":"sales","rewards":[],"commission_type":"percent","commission_rate_bps":3000,
  "commission_duration":"lifetime"}', 50000);
select pg_temp.check(pg_temp.pays_for('acme') = '' and pg_temp.n('public.program_reward_events') = 1
  and (select a->'program'->>'earn_from' = 'sales' and a->'rewards' = '[]'::jsonb and jsonb_array_length(a->'awards') = 48
      and pg_temp.row_of(a, 'a1') @> '{"status":"pending","can_reject":true}'
      and (select bool_and(c->'counts' = '[]'::jsonb and c->>'people' = '0' and c->>'went_further' is null)
        from jsonb_array_elements(a->'creators') c)
      and a->'budget'->>'daily_limit_minor' = '5000'
    from (select pg_temp.rewards('owner', 'acme') as a) x),
  'when the published terms pay for sales again no event is paid for, and the rewards already there can still be read and rejected');
-- An event that arrives now is not queued; one that was waiting is dropped without an award.
select pg_temp.visit('late1', 'ada', 'TikTok', now() - interval '2 hours');
select pg_temp.event('late1', 'late1', 'signup_completed', clock_timestamp());
insert into public.program_reward_queue(event_id, project_id, event_name, person_id, occurred_at)
  select e.id, e.project_id, e.name, e.person_id, e.occurred_at from public.analytics_events e where e.id = pg_temp.eid('late1');
select pg_temp.check(pg_temp.waiting() = 1 and pg_temp.tick() = '{"judged":1,"earned":0,"approved":0,"remaining":0}'
  and pg_temp.aw('late1') = 'none' and pg_temp.waiting() = 0,
  'an event of a program that no longer pays for it is dropped');
-- A program that stops being published gives up its rows (a fixture: nothing archives a program yet).
update public.affiliate_programs set status = 'archived', pause_reason = null where id = (pg_temp.program('quiet')).id;
select pg_temp.check(pg_temp.n('public.program_reward_events') = 0
  and pg_temp.service('select public.program_reward_health()') @> '{"events_out_of_step":0,"programs":0}',
  'a program that is no longer published pays for no events');

-- The check and the books, at the end ----------------------------------------------------------------
-- A stray entry against a reward's commission is what the check and the health view are for.
create function pg_temp.with_stray_entry() returns text language plpgsql as $$
declare result text;
begin
  insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, commission_id)
  select c.affiliate_id, c.program_id, c.currency, 'clawback', -1, c.id from pg_temp.com('i1') c;
  result := pg_temp.fails(format('select kma_internal.program_reward_commission_check(%L)', (pg_temp.com('i1')).id))
    || ' / ' || (pg_temp.service('select public.program_reward_health()')->>'ledger_mismatches');
  raise exception using errcode = 'P0001', message = result;
exception when raise_exception then
  return sqlerrm;
end $$;
select pg_temp.check(pg_temp.with_stray_entry() = 'P0001 commission_out_of_balance / 1',
  'a commission that does not agree with its entries is refused by the check and counted by the health view');
select pg_temp.check(pg_temp.books()
  and (select bool_and(c.commission_type = 'reward' and c.sale_id is null and c.basis_minor = c.earned_minor
      and c.commission_fixed_minor = c.earned_minor and c.fee_earned_minor = div(c.earned_minor * c.fee_bps, 10000)
      and c.hold_until = a.occurred_at + interval '14 days' and c.earned_minor = a.amount_minor
      and c.affiliate_id = a.affiliate_id and c.member_id = a.member_id and c.terms_version = a.terms_version)
    from public.program_commissions c join public.program_reward_awards a on a.id = c.award_id)
  and (select count(*) = count(distinct (a.program_id, a.reward_key, a.person_id))
    from public.program_reward_awards a where a.status in ('earned', 'rejected'))
  and not exists (select 1 from public.program_creator_entries e group by e.affiliate_id, e.program_id having sum(e.amount_minor) < 0)
  and pg_temp.service('select public.program_reward_health()') @> '{"enabled":true,"ledger_mismatches":0,"held_due":0,
    "queue":{"due":0,"waiting":0,"failing":0,"oldest_enqueued_at":null},"errors":{}}'
  and pg_temp.service('select public.program_balance_health()')->>'ledger_mismatches' = '0'
  and pg_temp.service('select public.program_payout_health()')->>'ledger_mismatches' = '0',
  'every reward''s commission is the reward of its award, held from the event for the hold of the terms; each reward is '
    || 'earned once per person; and the balance, payout and reward ledgers report no mismatch');
select pg_temp.check(pg_temp.fails('update public.program_balance_entries set amount_minor = 1') <> 'ok'
  and pg_temp.fails('delete from public.program_creator_entries') <> 'ok',
  'the entries of rewards cannot be changed or deleted either');
select set_config('request.jwt.claims', '', true);

select 'ok ' || count(*) || ' program reward engine assertions' from reward_assertions;
rollback;
