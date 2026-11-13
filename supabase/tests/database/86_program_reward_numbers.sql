-- Provider-free test of Phase 6, the numbers everyone reads: a creator's Earnings, Links and
-- Performance answers and a merchant's Creators and Balance answers, for a program that pays
-- for events, one that pays for sales and events, and one that pays for sales only.
--
-- Programs and members are made with the Phase 2 to 5 functions, the way suite 83 does, and
-- sales are judged by the real commission sync and tick. What the other Phase 6 pieces write
-- is written here directly, as fixtures: what a program earns from, its rewards and budget,
-- a terms version that names them, and the awards of the reward engine with their
-- commissions and balance entries (posted through kma_internal.program_balance_post, so the
-- books stay in balance). Stripe is never called.
begin;
set local time zone 'UTC';
create temporary table numbers_assertions(label text);
create temporary table qa(key text primary key, value text);
create temporary table answers(name text primary key, answer jsonb);
-- The analytics events the fixture awards stand for. No answer may name one.
create temporary sequence award_events start 7700000001;
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program reward numbers assertion failed: %', label; end if;
  insert into numbers_assertions values (label);
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

-- What Phase 6 adds to an answer -----------------------------------------------------------------
-- An answer as it was before Phase 6: without the keys this phase adds, at any depth. `kind`
-- is new only where it says sale or reward (a link and a balance entry had a kind before).
create function pg_temp.old_shape(j jsonb) returns jsonb language plpgsql as $$
begin
  return case jsonb_typeof(j)
    when 'object' then coalesce((select jsonb_object_agg(e.key, pg_temp.old_shape(e.value)) from jsonb_each(j) e
      where e.key not in ('events', 'earn_from', 'rewards', 'budget_reached', 'reward_label')
        and not (e.key = 'kind' and e.value in ('"sale"', '"reward"'))), '{}'::jsonb)
    when 'array' then coalesce((select jsonb_agg(pg_temp.old_shape(e.value) order by e.n)
      from jsonb_array_elements(j) with ordinality e(value, n)), '[]'::jsonb)
    else j end;
end $$;
-- Whether every key this phase adds holds its neutral value, wherever it is in the answer.
create function pg_temp.neutral(j jsonb) returns boolean language sql as $$
  select not exists (select 1 from jsonb_path_query(j, '$.**.events') v where v <> '0')
    and not exists (select 1 from jsonb_path_query(j, '$.**.earn_from') v where v <> '"sales"')
    and not exists (select 1 from jsonb_path_query(j, '$.**.rewards') v where v <> '[]')
    and not exists (select 1 from jsonb_path_query(j, '$.**.budget_reached') v where v <> 'false')
    and not exists (select 1 from jsonb_path_query(j, '$.**.reward_label') v where v <> 'null')
    and not exists (select 1 from jsonb_path_query(j, '$.**.kind') v where v = '"reward"')
$$;
-- How many times a key is in an answer, at any depth.
create function pg_temp.times(j jsonb, k text) returns bigint language plpgsql as $$
begin
  return case jsonb_typeof(j)
    when 'object' then (select coalesce(sum((e.key = k)::integer + pg_temp.times(e.value, k)), 0) from jsonb_each(j) e)
    when 'array' then (select coalesce(sum(pg_temp.times(e.value, k)), 0) from jsonb_array_elements(j) e(value))
    else 0 end;
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
-- A fixture for what the program form of Phase 6 does when terms change: a new version of
-- the published terms with `patch` laid over them, which every member has accepted.
create function pg_temp.new_terms(workspace text, patch jsonb) returns void language plpgsql as $$
declare p public.affiliate_programs := pg_temp.program(workspace);
begin
  insert into public.affiliate_program_terms(program_id, version, terms, agreement, agreement_sha256, created_by)
  select t.program_id, t.version + 1, t.terms || patch, t.agreement, t.agreement_sha256, t.created_by
  from public.affiliate_program_terms t where t.program_id = p.id and t.version = p.live_terms_version;
  update public.affiliate_programs set live_terms_version = live_terms_version + 1 where id = p.id;
  update public.affiliate_program_members set terms_version = terms_version + 1 where program_id = p.id;
end $$;
-- A fixture for a program published before Phase 6: its published terms say nothing about
-- what creators earn from. (The program form of Phase 6 writes "sales" there.)
create function pg_temp.terms_from_before(workspace text) returns void language plpgsql as $$
declare p public.affiliate_programs := pg_temp.program(workspace);
begin
  insert into public.affiliate_program_terms(program_id, version, terms, agreement, agreement_sha256, created_by)
  select t.program_id, t.version + 1, t.terms - 'earn_from' - 'rewards', t.agreement, t.agreement_sha256, t.created_by
  from public.affiliate_program_terms t where t.program_id = p.id and t.version = p.live_terms_version;
  update public.affiliate_programs set live_terms_version = live_terms_version + 1 where id = p.id;
end $$;
-- The same for a program that starts paying for events: what it earns from, its rewards and
-- its monthly budget on the program, and terms that name the first two. A program that pays
-- for events only has no commission in its terms.
create function pg_temp.pays_for(workspace text, how text, list jsonb, budget bigint) returns void language plpgsql as $$
begin
  update public.affiliate_programs set earn_from = how, rewards = list, reward_budget_minor = budget
  where id = (pg_temp.program(workspace)).id;
  perform pg_temp.new_terms(workspace, jsonb_build_object('earn_from', how, 'rewards', list)
    || case when how = 'events' then '{"commission_type":null,"commission_rate_bps":null,"commission_fixed_minor":null,
      "commission_duration":null,"commission_months":null}'::jsonb else '{}'::jsonb end);
end $$;
create function pg_temp.set_budget(workspace text, budget bigint) returns void language sql as $$
  update public.affiliate_programs set reward_budget_minor = budget where id = (pg_temp.program(workspace)).id
$$;

-- Creators ---------------------------------------------------------------------------------------
create function pg_temp.join(creator text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(creator, format('select public.partner_program_join(%L)', jsonb_build_object(
    'slug', p.slug, 'terms_version', t.version, 'agreement_sha256', t.agreement_sha256)))
  from pg_temp.program(workspace) p
  join public.affiliate_program_terms t on t.program_id = p.id and t.version = p.live_terms_version
$$;
create function pg_temp.member(creator text, workspace text) returns public.affiliate_program_members language sql as $$
  select m from public.affiliate_program_members m
  where m.program_id = (pg_temp.program(workspace)).id and m.affiliate_id = pg_temp.q('creator_' || creator)
$$;

-- Links ------------------------------------------------------------------------------------------
create function pg_temp.link_row(creator text, workspace text, link_name text) returns public.affiliate_links language sql as $$
  select l from public.affiliate_links l
  where l.affiliate_id = pg_temp.q('creator_' || creator) and l.product_id = (pg_temp.program(workspace)).product_id
    and case when link_name = 'Main link' then l.is_main else not l.is_main and l.name = link_name end
  order by (l.status = 'archived'), l.created_at desc limit 1
$$;
-- The Links page, one program on it and one link of that program.
create function pg_temp.links(creator text) returns jsonb language sql as $$
  select pg_temp.call(creator, 'select public.partner_program_links()')
$$;
create function pg_temp.listed(answer jsonb, program_slug text) returns jsonb language sql as $$
  select p from jsonb_array_elements(answer->'programs') p where p->>'slug' = program_slug
$$;
create function pg_temp.line(program jsonb, link_name text) returns jsonb language sql as $$
  select l from jsonb_array_elements(program->'links') l where l->>'name' = link_name
$$;
-- A line of numbers of each link that has any, in the order given:
-- <name> <clicks>/<sales>/<events>/<earnings>.
create function pg_temp.numbers(lines jsonb) returns text language sql as $$
  select coalesce(string_agg(format('%s %s/%s/%s/%s', l->>'name', l->>'clicks', l->>'sales', l->>'events', l->>'earnings_minor'),
    ', ' order by n), '')
  from jsonb_array_elements(lines) with ordinality x(l, n)
  where (l->>'clicks')::bigint + (l->>'sales')::bigint + (l->>'events')::bigint + (l->>'earnings_minor')::bigint > 0
$$;
-- A visitor opens a link by its long address: the click row that visit made.
create function pg_temp.open(creator text, workspace text, link_name text) returns uuid language plpgsql as $$
declare
  v_slug text;
  v_code text;
  v_visit text;
begin
  select a.slug, l.public_code into v_slug, v_code
  from pg_temp.link_row(creator, workspace, link_name) l join public.affiliates a on a.id = l.affiliate_id;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select r.click_id into v_visit from public.register_tracking_click(v_slug, v_code, '{}'::jsonb) r;
  reset role;
  return (select k.id from public.clicks k where k.public_click_id = v_visit);
exception when others then
  reset role;
  raise;
end $$;
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
-- The days of a Performance answer that have anything:
-- <days back> <clicks>/<sales>/<events>/<earnings>.
create function pg_temp.days(answer jsonb) returns text language sql as $$
  select coalesce(string_agg(format('%s %s/%s/%s/%s', (answer->>'ends_on')::date - (d->>'day')::date,
    d->>'clicks', d->>'sales', d->>'events', d->>'earnings_minor'), ', ' order by n desc), '')
  from jsonb_array_elements(answer->'daily') with ordinality x(d, n)
  where (d->>'clicks')::bigint + (d->>'sales')::bigint + (d->>'events')::bigint + (d->>'earnings_minor')::bigint > 0
$$;
-- The rewards of a Performance answer in one line: <label> <amount> <count>/<earnings>.
create function pg_temp.rewards(answer jsonb) returns text language sql as $$
  select coalesce(string_agg(format('%s %s %s/%s', r->>'label', r->>'amount_minor', r->>'count', r->>'earnings_minor'), ', ' order by n), '')
  from jsonb_array_elements(answer->'rewards') with ordinality x(r, n)
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
-- A payment Stripe reported, tied to a creator's click, then what the end of that
-- transaction does: the real commission sync judges it.
create function pg_temp.sale(k text, workspace text, click uuid, amount bigint, paid timestamptz) returns void language plpgsql as $$
declare
  p public.affiliate_programs := pg_temp.program(workspace);
  v_click public.clicks;
  v_id uuid := gen_random_uuid();
begin
  select * into v_click from public.clicks where id = click;
  insert into public.program_sales(id, program_id, connection_id, account_id, payment_intent_id, charge_id,
      checkout_session_id, customer_id, amount_minor, currency, refunded_minor, status, paid_at,
      click_id, click_record_id, affiliate_id, match_source, created_at)
    select v_id, p.id, c.id, c.account_id, 'pi_p6buyer' || k, 'ch_p6buyer' || k, 'cs_p6buyer' || k, 'cus_P6Buyer' || k,
      amount, 'USD', 0, 'paid', paid, v_click.public_click_id, v_click.id, v_click.affiliate_id, 'metadata', now()
    from public.merchant_connections c join public.merchant_businesses b on b.id = c.merchant_id
    where b.workspace_id = p.workspace_id;
  insert into qa values (k, v_id);
  perform pg_temp.flush();
end $$;
-- A sale's commission in one line: <status> <amount> <fee>.
create function pg_temp.commission(k text) returns text language sql as $$
  select coalesce((select format('%s %s %s', x.status, x.amount_minor, x.fee_minor)
    from public.program_commissions x where x.sale_id = pg_temp.q(k)), 'none')
$$;
-- A fixture for what the reward engine writes when it judges an event that came through a
-- creator's click (or, with no click, for `creator`): the award and, when it earned, its
-- commission with the amount and the 10% fee set aside from the merchant's balance.
--   held: earned, in its hold. approved: the hold passed and the reward is the creator's.
--   rejected: the merchant took it back in the hold; everything set aside went back.
--   not_earned:<reason>: it counts for nothing and has no commission.
create function pg_temp.award(k text, workspace text, creator text, click uuid, reward text, at timestamptz,
  state text default 'held') returns void language plpgsql as $$
declare
  p public.affiliate_programs := pg_temp.program(workspace);
  m public.affiliate_program_members := pg_temp.member(creator, workspace);
  t public.affiliate_program_terms;
  v_reward jsonb;
  v_amount bigint;
  v_fee bigint;
  v_award uuid := gen_random_uuid();
  v_commission uuid := gen_random_uuid();
  v_account uuid := (pg_temp.account(workspace)).id;
begin
  select * into t from public.affiliate_program_terms x where x.program_id = p.id and x.version = p.live_terms_version;
  select r into v_reward from jsonb_array_elements(t.terms->'rewards') r where r->>'key' = reward;
  v_amount := (v_reward->>'amount_minor')::bigint;
  v_fee := div(v_amount * 1000, 10000);
  insert into public.program_reward_awards(id, program_id, reward_key, reward_label, event_id, person_id, occurred_at,
    member_id, affiliate_id, click_record_id, terms_version, status, reason, currency, amount_minor)
  values (v_award, p.id, reward, v_reward->>'label', nextval('award_events'), gen_random_uuid(), at,
    m.id, m.affiliate_id, click, t.version, case when state like 'not_earned:%' then 'not_earned' else 'earned' end,
    nullif(split_part(state, ':', 2), ''), 'USD', v_amount);
  insert into qa values (k, v_award);
  if state like 'not_earned:%' then
    return;
  end if;
  insert into public.program_commissions(id, award_id, program_id, member_id, affiliate_id, terms_version, status, currency,
    basis_minor, commission_type, commission_fixed_minor, fee_bps, earned_minor, amount_minor, fee_earned_minor, fee_minor,
    hold_until)
  values (v_commission, v_award, p.id, m.id, m.affiliate_id, t.version, 'held', 'USD',
    v_amount, 'reward', v_amount, 1000, v_amount, v_amount, v_fee, v_fee,
    at + make_interval(days => (t.terms->>'hold_days')::integer));
  perform kma_internal.program_balance_post(v_account, 'commission_reserved', -v_amount, null, v_commission);
  perform kma_internal.program_balance_post(v_account, 'fee_reserved', -v_fee, null, v_commission);
  if state = 'approved' then
    update public.program_commissions set status = 'approved', approved_at = hold_until where id = v_commission;
    insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, commission_id)
    values (m.affiliate_id, p.id, 'USD', 'commission_approved', v_amount, v_commission);
  elsif state = 'rejected' then
    perform kma_internal.program_balance_post(v_account, 'commission_returned', v_amount, null, v_commission);
    perform kma_internal.program_balance_post(v_account, 'fee_returned', v_fee, null, v_commission);
    update public.program_commissions set status = 'reversed', amount_minor = 0, fee_minor = 0, reversed_at = now()
    where id = v_commission;
    update public.program_reward_awards set status = 'rejected', rejected_at = now(), reject_reason = 'fake' where id = v_award;
  end if;
end $$;
-- The books: every balance is the sum of its entries, nothing was set aside from money that
-- was not there, and every commission (for a sale or for a reward) agrees with its entries.
create function pg_temp.books() returns boolean language sql as $$
  select (select coalesce(bool_and(a.available_minor = coalesce((select sum(e.amount_minor)
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
    and (select coalesce(bool_and(a.available_minor = coalesce((select sum(e.amount_minor)
          from public.program_balance_entries e where e.account_id = a.id and e.topup_id is not null), 0)
        - coalesce((select sum(c.amount_minor + c.fee_minor) from public.program_commissions c
          where c.program_id = a.program_id), 0)), true)
      from public.program_balance_accounts a)
    and public.program_balance_health()->>'ledger_mismatches' = '0'
$$;
-- The first moment of this calendar month (UTC), and what a program's rewards have used of
-- its budget this month, counted the way the reward engine counts it.
create function pg_temp.month_start() returns timestamptz language sql as $$
  select date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
$$;
create function pg_temp.used(workspace text) returns bigint language sql as $$
  select coalesce(sum(w.amount_minor), 0)::bigint from public.program_reward_awards w
  where w.program_id = (pg_temp.program(workspace)).id and w.status = 'earned' and w.occurred_at >= pg_temp.month_start()
    and w.occurred_at < pg_temp.month_start() + interval '1 month'
$$;
create function pg_temp.earnings(creator text) returns jsonb language sql as $$
  select pg_temp.call(creator, 'select public.partner_program_earnings()')
$$;
-- The creator's line of one program in their earnings, and their recent commissions of one
-- program in one line: <kind> <status> <amount> <reward label>, newest first.
create function pg_temp.earnings_line(answer jsonb, program_slug text) returns jsonb language sql as $$
  select p from jsonb_array_elements(answer->'programs') p where p->>'slug' = program_slug
$$;
create function pg_temp.recent(answer jsonb, program text) returns text language sql as $$
  select coalesce(string_agg(format('%s %s %s %s', r->>'kind', r->>'status', r->>'amount_minor', coalesce(r->>'reward_label', '-')),
    ', ' order by n), '')
  from jsonb_array_elements(answer->'recent') with ordinality x(r, n) where r->>'program_name' = program
$$;

-- The merchant -----------------------------------------------------------------------------------
create function pg_temp.creators(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_program_creators(%L)', pg_temp.q(workspace)))
$$;
create function pg_temp.creator(answer jsonb, handle text) returns jsonb language sql as $$
  select c from jsonb_array_elements(answer->'creators') c where c->>'handle' = handle
$$;
create function pg_temp.balance(who text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(who, format('select public.workspace_program_balance(%L)', pg_temp.q(workspace)))
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
grant all on qa, numbers_assertions, answers to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- People ---------------------------------------------------------------------------------------
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('b8000000-0000-4000-8000-000000000001', 'owner@speaksix.example.test', now(), '{"company":"SpeakSix"}'),
  ('b8000000-0000-4000-8000-000000000002', 'analyst@speaksix.example.test', now(), '{}'),
  ('b8000000-0000-4000-8000-000000000003', 'owner@rival.example.test', now(), '{"company":"Rival"}'),
  ('b8000000-0000-4000-8000-000000000004', 'owner@quiet.example.test', now(), '{"company":"Quiet"}'),
  ('b8000000-0000-4000-8000-000000000005', 'owner@empty.example.test', now(), '{"company":"Empty"}'),
  ('b8000000-0000-4000-8000-000000000011', 'owner@kma.example.test', now(), '{}'),
  ('b8000000-0000-4000-8000-000000000021', 'ada@creators.example.test', now(), '{}'),
  ('b8000000-0000-4000-8000-000000000022', 'ben@creators.example.test', now(), '{}'),
  ('b8000000-0000-4000-8000-000000000023', 'cy@creators.example.test', now(), '{}'),
  ('b8000000-0000-4000-8000-000000000024', 'dee@creators.example.test', now(), '{}'),
  ('b8000000-0000-4000-8000-000000000025', 'eve@creators.example.test', now(), '{}');
insert into qa values
  ('owner', 'b8000000-0000-4000-8000-000000000001'), ('analyst', 'b8000000-0000-4000-8000-000000000002'),
  ('rival_owner', 'b8000000-0000-4000-8000-000000000003'), ('quiet_owner', 'b8000000-0000-4000-8000-000000000004'),
  ('empty_owner', 'b8000000-0000-4000-8000-000000000005'), ('kma_owner', 'b8000000-0000-4000-8000-000000000011'),
  ('ada', 'b8000000-0000-4000-8000-000000000021'), ('ben', 'b8000000-0000-4000-8000-000000000022'),
  ('cy', 'b8000000-0000-4000-8000-000000000023'), ('dee', 'b8000000-0000-4000-8000-000000000024'),
  ('eve', 'b8000000-0000-4000-8000-000000000025'),
  ('creator_ada', 'b9000000-0000-4000-8000-000000000001'), ('creator_ben', 'b9000000-0000-4000-8000-000000000002'),
  ('creator_cy', 'b9000000-0000-4000-8000-000000000003'), ('creator_dee', 'b9000000-0000-4000-8000-000000000004'),
  ('creator_eve', 'b9000000-0000-4000-8000-000000000005');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner');
-- Ada's calendar is fourteen hours ahead of UTC; the others keep the default, UTC.
insert into public.affiliates(id, public_name, legal_name, slug, status, reporting_timezone, country_code, channels) values
  (pg_temp.q('creator_ada'), 'Ada Okafor', 'Ada N. Okafor', 'ada-okafor', 'active', 'Pacific/Kiritimati', 'NG', array['tiktok', 'instagram']),
  (pg_temp.q('creator_ben'), 'Ben Creator', null, 'ben-creator', 'active', 'UTC', 'GB', array['youtube']),
  (pg_temp.q('creator_cy'), 'Cy Park', null, 'cy-park', 'active', 'UTC', null, '{}'),
  (pg_temp.q('creator_dee'), 'Dee Vale', null, 'dee-vale', 'active', 'UTC', 'US', array['newsletter']),
  (pg_temp.q('creator_eve'), 'Eve Stone', null, 'eve-stone', 'active', 'UTC', null, '{}');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at)
  select pg_temp.q('creator_' || c), pg_temp.q(c), 'owner', true, false, now()
  from unnest(array['ada', 'ben', 'cy', 'dee', 'eve']) c;
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true,
    program_money_enabled = false, program_fee_bps = 1000, program_min_deposit_minor = 5000,
    program_payouts_enabled = false, program_min_payout_minor = 2500;

-- Workspaces and programs ------------------------------------------------------------------------
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
-- All three start as programs of before Phase 6, paying a commission on sales: SpeakSix 30%
-- with a hold of 30 days, Rival Reader and Quiet Club 20% with a hold of 14.
select pg_temp.publish('owner', 'acme', '{"name":"SpeakSix","category":"education","tagline":"Speak English in six weeks.",
  "landing_url":"https://speaksix.com/start","commission_type":"percent","commission_rate_bps":3000,
  "commission_duration":"lifetime"}');
select pg_temp.publish('rival_owner', 'rival', '{"name":"Rival Reader","category":"entertainment","tagline":"Stories worth an evening.",
  "landing_url":"https://rivalreader.co/","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"lifetime","hold_days":14}');
select pg_temp.publish('quiet_owner', 'quiet', '{"name":"Quiet Club","category":"lifestyle","tagline":"A calmer phone.",
  "landing_url":"https://quietclub.io/join","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"lifetime","hold_days":14}');
-- Quiet Club was published before Phase 6: its terms name neither what creators earn from nor rewards.
select pg_temp.terms_from_before('quiet');
select pg_temp.check((select bool_and(p.status = 'live' and p.earn_from = 'sales' and p.rewards = '[]' and p.reward_budget_minor is null)
      and count(*) = 3 from public.affiliate_programs p)
  and (select not t.terms ? 'earn_from' and not t.terms ? 'rewards' and t.terms->>'commission_type' = 'percent'
    from public.affiliate_program_terms t join public.affiliate_programs p on p.id = t.program_id and p.live_terms_version = t.version
    where p.id = (pg_temp.program('quiet')).id),
  'three programs are live, paying for sales, and the terms of one say nothing about events');

-- Closed by default ----------------------------------------------------------------------------
select pg_temp.check((select count(*) = 4 and bool_and(has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('partner_program_earnings', 'partner_program_links',
    'partner_program_performance', 'workspace_program_creators')),
  'the four functions that grew are still for signed-in users only, security definer with an empty search path');
select pg_temp.check((select count(*) = 10 and bool_and(not has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
    and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'kma_internal' and p.proname in ('program_link_earn_from', 'program_link_rewards',
    'program_link_budget_reached', 'program_link_stats', 'program_link_totals', 'program_links_json', 'program_link_brief',
    'program_link_member_stats', 'program_creator_json', 'program_balance_state')),
  'the internal functions made or made again here are closed to every API role');
select pg_temp.check(pg_temp.try_signed_out(r, s) = '42501', format('%s cannot run %s', r, left(s, 60)))
from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array[
  format('select kma_internal.program_link_stats(%L, %L, now(), now())', gen_random_uuid(), gen_random_uuid()),
  format('select kma_internal.program_link_member_stats(m) from public.affiliate_program_members m'),
  format('select kma_internal.program_link_earn_from(p) from public.affiliate_programs p'),
  format('select kma_internal.program_link_rewards(p) from public.affiliate_programs p'),
  format('select kma_internal.program_link_budget_reached(p) from public.affiliate_programs p'),
  format('select kma_internal.program_balance_state(%L, ''owner'')', pg_temp.q('acme'))]) s;
select pg_temp.check(pg_temp.try_signed_out(r, s) = '42501', format('signed out, %s cannot run %s', r, left(s, 60)))
from unnest(array['anon', 'authenticated']) r, unnest(array[
  'select public.partner_program_earnings()', 'select public.partner_program_links()', pg_temp.performance_sql(null, 30),
  format('select public.workspace_program_creators(%L)', pg_temp.q('acme')),
  format('select public.workspace_program_balance(%L)', pg_temp.q('acme'))]) s;
select pg_temp.check((select bool_and(exists (select 1 from pg_indexes i
    where i.schemaname = 'public' and i.indexname = x.name and i.indexdef like x.shape))
  from (values ('program_reward_awards_creator', '%(affiliate_id, program_id, occurred_at DESC)%'),
    ('program_reward_awards_program', '%(program_id, occurred_at DESC, id)%'),
    ('program_commissions_award_id_key', '%UNIQUE%(award_id)%')) x(name, shape)),
  'the awards of a creator in a program by time, of a program by time, and the commission of an award are indexed');

-- Members, clicks and sales ------------------------------------------------------------------------
-- Ada is in all three programs, Ben in SpeakSix, Cy in Rival Reader, Dee in Quiet Club. Eve
-- is in none. Everybody has been a member for a long time.
select pg_temp.check(bool_and(pg_temp.join(x.creator, x.workspace)->'membership'->>'status' = 'active'), 'the creators join')
from (values ('ada', 'acme'), ('ada', 'rival'), ('ada', 'quiet'), ('ben', 'acme'), ('cy', 'rival'), ('dee', 'quiet')) x(creator, workspace);
update public.affiliate_program_members set activated_at = now() - interval '500 days';
select pg_temp.call('ada', format('select public.partner_program_link_create(%L)', '{"slug":"speaksix","name":"Podcast"}'::jsonb));
-- Today's visits.
insert into qa values
  ('click_ada_main', pg_temp.open('ada', 'acme', 'Main link')), ('click_ada_tiktok', pg_temp.open('ada', 'acme', 'TikTok')),
  ('click_ada_podcast', pg_temp.open('ada', 'acme', 'Podcast')), ('click_ben_main', pg_temp.open('ben', 'acme', 'Main link')),
  ('click_ada_rival', pg_temp.open('ada', 'rival', 'Main link')), ('click_cy_rival', pg_temp.open('cy', 'rival', 'Main link')),
  ('click_ada_quiet', pg_temp.open('ada', 'quiet', 'Main link')), ('click_dee_quiet', pg_temp.open('dee', 'quiet', 'TikTok'));
-- Visits on earlier days of Ada's calendar. Two pairs straddle a midnight of hers: the first
-- moment of a day, and the last moment of the day before.
insert into qa select x.k, pg_temp.click_at('ada', x.workspace, x.link, pg_temp.day('ada', x.back) - make_interval(secs => x.before))
from (values ('click_ada_tt1', 'acme', 'TikTok', 1, 0), ('click_ada_tt2', 'acme', 'TikTok', 1, 0.000001),
  ('click_ada_ig29', 'acme', 'Instagram', 29, 0), ('click_ada_ig30', 'acme', 'Instagram', 29, 0.000001),
  ('click_ada_yt45', 'acme', 'YouTube', 45, 0), ('click_ada_rival20', 'rival', 'TikTok', 20, 0)) x(k, workspace, link, back, before);
select pg_temp.check((select count(*) = 14 and count(k.id) = 14 from qa q left join public.clicks k on k.id::text = q.value
    where q.key like 'click\_%')
  and (select (k.occurred_at at time zone 'UTC')::date = (k.occurred_at at time zone 'Pacific/Kiritimati')::date - 1
    from public.clicks k where k.id = pg_temp.q('click_ada_tt1')),
  'fourteen visits were credited, and the first moment of a day of Ada''s calendar is still the day before in UTC');

-- Program money is switched on and each balance funded. Then the sales, while every program
-- still pays for sales: Ada sent one to SpeakSix 100 days ago; to Rival Reader and to Quiet
-- Club one 20 days ago and one today; Dee sent one to Quiet Club today.
update public.platform_settings set program_money_enabled = true where singleton;
select pg_temp.open_account('acme', 'owner'), pg_temp.open_account('rival', 'rival_owner'), pg_temp.open_account('quiet', 'quiet_owner');
select pg_temp.fund('acme', 500000), pg_temp.fund('rival', 100000), pg_temp.fund('quiet', 100000);
select pg_temp.sale('s_old', 'acme', pg_temp.q('click_ada_main'), 4900, pg_temp.day('ada', 100) + interval '12 hours');
select pg_temp.sale('r1', 'rival', pg_temp.q('click_ada_rival'), 5000, pg_temp.day('ada', 20) + interval '12 hours');
select pg_temp.sale('r2', 'rival', pg_temp.q('click_ada_rival'), 2500, pg_temp.day('ada', 0));
select pg_temp.sale('q1', 'quiet', pg_temp.q('click_ada_quiet'), 4000, now());
select pg_temp.sale('q2', 'quiet', pg_temp.q('click_ada_quiet'), 5000, pg_temp.day('ada', 20) + interval '12 hours');
select pg_temp.sale('d1', 'quiet', pg_temp.q('click_dee_quiet'), 3000, now());
select pg_temp.check(pg_temp.svc('program_commissions_tick', '{"limit":100}')->>'approved' = '3'
  and pg_temp.commission('s_old') = 'approved 1470 147' and pg_temp.commission('r1') = 'approved 1000 100'
  and pg_temp.commission('r2') = 'held 500 50' and pg_temp.commission('q1') = 'held 800 80'
  and pg_temp.commission('q2') = 'approved 1000 100' and pg_temp.commission('d1') = 'held 600 60'
  and pg_temp.books(),
  'the fixture sales: three approved after their hold, three still held, and the books balance');

-- A program that pays for sales only, before any reward exists ---------------------------------------
-- Every answer keeps the keys it had with the values it had, and the keys of Phase 6 hold
-- their neutral values: events 0, earn_from "sales", rewards [], budget_reached false,
-- kind "sale", reward_label null.
select pg_temp.capture('partner_program_performance.sales_program',
  pg_temp.keep('quiet_performance', pg_temp.performance('ada', 'quiet-club', 30)));
select pg_temp.check((select pg_temp.keys(a) = 'budget_reached channels daily days ends_on latest money previous program '
        || 'programs rewards starts_on timezone totals'
      and a->'rewards' = '[]' and a->'budget_reached' = 'false'
      and a->'program' = jsonb_build_object('program_id', (pg_temp.program('quiet')).id, 'slug', 'quiet-club',
        'name', 'Quiet Club', 'currency', 'USD', 'earn_from', 'sales')
      and a->'totals' = '{"clicks":1,"sales":2,"events":0,"earnings_minor":1800}'
      and a->'previous' = '{"clicks":0,"sales":0,"events":0,"earnings_minor":0}'
      and pg_temp.days(a) = '0 1/1/0/800, 20 0/1/0/1000'
      and pg_temp.numbers(a->'channels') = 'Main link 1/2/0/1800'
      and a->'daily'->29 = jsonb_build_object('day', pg_temp.date_of('ada', 0), 'clicks', 1, 'sales', 1, 'events', 0, 'earnings_minor', 800)
      and a->'channels'->0 = jsonb_build_object('link_id', (pg_temp.link_row('ada', 'quiet', 'Main link')).id, 'kind', 'main',
        'channel', null, 'name', 'Main link', 'clicks', 1, 'sales', 2, 'events', 0, 'earnings_minor', 1800)
      and a->'latest' = jsonb_build_array(
        jsonb_build_object('paid_at', now(), 'link_name', 'Main link', 'amount_minor', 800, 'status', 'held',
          'kind', 'sale', 'reward_label', null),
        jsonb_build_object('paid_at', pg_temp.day('ada', 20) + interval '12 hours', 'link_name', 'Main link', 'amount_minor', 1000,
          'status', 'approved', 'kind', 'sale', 'reward_label', null))
      and pg_temp.neutral(a)
      -- One events key on each total, each of the 30 days and each of the 7 links.
      and pg_temp.times(a, 'events') = 39 and pg_temp.times(a, 'earn_from') = 4 and pg_temp.times(a, 'kind') = 9
    from (select pg_temp.kept('quiet_performance') as a) x),
  'the Performance page of a sales program: every key of Phase 6 is there with its neutral value');
select pg_temp.check((select pg_temp.keys(o) = 'channels daily days ends_on latest money previous program programs starts_on timezone totals'
      and o->'program' = jsonb_build_object('program_id', (pg_temp.program('quiet')).id, 'slug', 'quiet-club',
        'name', 'Quiet Club', 'currency', 'USD')
      and o->'programs' = jsonb_build_array(o->'program',
        jsonb_build_object('program_id', (pg_temp.program('rival')).id, 'slug', 'rival-reader', 'name', 'Rival Reader', 'currency', 'USD'),
        jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'slug', 'speaksix', 'name', 'SpeakSix', 'currency', 'USD'))
      and o->'totals' = '{"clicks":1,"sales":2,"earnings_minor":1800}' and o->'previous' = '{"clicks":0,"sales":0,"earnings_minor":0}'
      and jsonb_array_length(o->'daily') = 30
      and o->'daily'->29 = jsonb_build_object('day', pg_temp.date_of('ada', 0), 'clicks', 1, 'sales', 1, 'earnings_minor', 800)
      and o->'daily'->9 = jsonb_build_object('day', pg_temp.date_of('ada', 20), 'clicks', 0, 'sales', 1, 'earnings_minor', 1000)
      and o->'daily'->0 = jsonb_build_object('day', pg_temp.date_of('ada', 29), 'clicks', 0, 'sales', 0, 'earnings_minor', 0)
      and (select string_agg(pg_temp.keys(c), '|') = repeat('channel clicks earnings_minor kind link_id name sales|', 6)
          || 'channel clicks earnings_minor kind link_id name sales' from jsonb_array_elements(o->'channels') c)
      and o->'money' = jsonb_build_object('pending_minor', 800, 'approved_minor', 1000, 'paying_minor', 0, 'paid_minor', 0,
        'next_release_at', now() + interval '14 days')
      and o->'latest' = jsonb_build_array(
        jsonb_build_object('paid_at', now(), 'link_name', 'Main link', 'amount_minor', 800, 'status', 'held'),
        jsonb_build_object('paid_at', pg_temp.day('ada', 20) + interval '12 hours', 'link_name', 'Main link', 'amount_minor', 1000,
          'status', 'approved'))
    from (select pg_temp.old_shape(pg_temp.kept('quiet_performance')) as o) x),
  'without the keys of Phase 6 that answer is what the page read before: the same keys with the same values');
-- Dee is only in the sales program: nothing she reads says anything about events.
select pg_temp.keep('dee_links', pg_temp.links('dee')), pg_temp.keep('dee_performance', pg_temp.performance('dee', null, 7)),
  pg_temp.keep('dee_earnings', pg_temp.earnings('dee')), pg_temp.keep('ada_links_before', pg_temp.links('ada'));
select pg_temp.check((select pg_temp.neutral(l) and pg_temp.neutral(f) and pg_temp.neutral(e)
      and pg_temp.times(l, 'earn_from') = 1 and pg_temp.times(l, 'events') = 7
      and pg_temp.keys(l->'programs'->0) = 'currency custom_links earn_from links name paused_reason program_id slug working'
      and pg_temp.old_shape(l->'programs'->0) - 'links' = jsonb_build_object('program_id', (pg_temp.program('quiet')).id,
        'slug', 'quiet-club', 'name', 'Quiet Club', 'currency', 'USD', 'working', true, 'paused_reason', null, 'custom_links', 0)
      and pg_temp.line(l->'programs'->0, 'TikTok') - 'link_id' - 'created_at' = '{"kind":"channel","channel":"tiktok","name":"TikTok",
        "url":"https://go.kissmyapps.dev/quiet-club/dee-vale/tiktok","clicks":1,"sales":1,"events":0,"earnings_minor":600,"removable":false}'
      and f->'totals' = '{"clicks":1,"sales":1,"events":0,"earnings_minor":600}'
      and pg_temp.keys(e->'programs'->0) = 'approved_minor currency events name next_release_at paid_minor paying_minor pending_minor '
        || 'program_id sales slug'
      and pg_temp.old_shape(e->'programs'->0) = jsonb_build_object('program_id', (pg_temp.program('quiet')).id, 'slug', 'quiet-club',
        'name', 'Quiet Club', 'currency', 'USD', 'pending_minor', 600, 'approved_minor', 0, 'paying_minor', 0, 'paid_minor', 0,
        'sales', 1, 'next_release_at', now() + interval '14 days')
      and e->'programs'->0->'events' = '0'
      and pg_temp.keys(e->'recent'->0) = 'amount_minor approved_at currency earned_minor hold_until id kind paid_at program_id '
        || 'program_name reward_label sale_amount_minor status'
      and pg_temp.old_shape(e->'recent'->0) - 'id' = jsonb_build_object('program_id', (pg_temp.program('quiet')).id,
        'program_name', 'Quiet Club', 'status', 'held', 'amount_minor', 600, 'earned_minor', 600, 'currency', 'USD',
        'sale_amount_minor', 3000, 'paid_at', now(), 'hold_until', now() + interval '14 days', 'approved_at', null)
      and e->'recent'->0 @> '{"kind":"sale","reward_label":null}' and jsonb_array_length(e->'recent') = 1
    from (select pg_temp.kept('dee_links') as l, pg_temp.kept('dee_performance') as f, pg_temp.kept('dee_earnings') as e) x),
  'a creator of a sales program reads the Links, Performance and Earnings pages as before, with the new keys neutral');
select pg_temp.keep('quiet_creators', pg_temp.creators('quiet_owner', 'quiet')),
  pg_temp.keep('quiet_balance', pg_temp.balance('quiet_owner', 'quiet'));
select pg_temp.check((select pg_temp.neutral(c) and pg_temp.neutral(b)
      and pg_temp.keys(c) = 'can_manage counts creators currency earn_from program totals' and c->>'earn_from' = 'sales'
      and c->'totals' = '{"clicks":2,"sales":3,"events":0,"sales_amount_minor":12000,"commission_minor":2400,"pending_minor":1400}'
      and pg_temp.creator(c, 'ada-okafor') @> '{"clicks":1,"sales":2,"events":0,"sales_amount_minor":9000,"commission_minor":1800,"pending_minor":800}'
      and pg_temp.creator(c, 'dee-vale') @> '{"clicks":1,"sales":1,"events":0,"sales_amount_minor":3000,"commission_minor":600,"pending_minor":600}'
      and pg_temp.old_shape(c)->'totals' = '{"clicks":2,"sales":3,"sales_amount_minor":12000,"commission_minor":2400,"pending_minor":1400}'
      and (select bool_and(pg_temp.keys(x) = 'activated_at channels clicks commission_minor country_code decision_note ended_at '
          || 'handle last_click_at member_id name needs_new_terms pending_minor requested_at sales sales_amount_minor status '
          || 'terms_version website_url') from jsonb_array_elements(pg_temp.old_shape(c)->'creators') x)
      and b->'account' @> '{"available_minor":97360,"reserved_minor":1540,"creators_pending_minor":1400,
        "creators_approved_minor":1000,"fees_minor":240,"deposited_minor":100000}'
      and jsonb_array_length(b->'activity') = 7 and pg_temp.times(b, 'reward_label') = 7
      and (select bool_and(pg_temp.keys(x) = 'amount_minor available_after_minor created_at creator_name id kind note '
          || 'reward_label sale_amount_minor topup_kind') from jsonb_array_elements(b->'activity') x)
      and (b->'activity'->0) - 'id' - 'created_at' = '{"kind":"fee_reserved","amount_minor":-60,"available_after_minor":97360,
        "creator_name":"Dee Vale","sale_amount_minor":3000,"reward_label":null,"topup_kind":null,"note":null}'
    from (select pg_temp.kept('quiet_creators') as c, pg_temp.kept('quiet_balance') as b) x),
  'the merchant of a sales program reads the Creators and Balance pages as before, with the new keys neutral');
select pg_temp.check(pg_temp.creators('empty_owner', 'empty') = '{"can_manage":true,"program":null,"currency":null,"earn_from":"sales",
    "counts":{"pending":0,"active":0,"ended":0},"creators":[],
    "totals":{"clicks":0,"sales":0,"events":0,"sales_amount_minor":0,"commission_minor":0,"pending_minor":0}}'::jsonb
  and (select a - 'starts_on' - 'ends_on' = '{"days":30,"timezone":"UTC","programs":[],"program":null,
      "totals":{"clicks":0,"sales":0,"events":0,"earnings_minor":0},"previous":{"clicks":0,"sales":0,"events":0,"earnings_minor":0},
      "daily":[],"channels":[],"rewards":[],"budget_reached":false,"money":null,"latest":[]}'::jsonb
    from (select pg_temp.performance('eve', null, 30) as a) x)
  and pg_temp.earnings('eve') @> '{"programs":[],"recent":[]}',
  'a workspace with no program and a creator with no program get the new keys with their neutral values too');

-- The programs start paying for events ---------------------------------------------------------------
-- SpeakSix now pays for events only: 2.00 for an account, 5.00 for a trial, within 500.00 a
-- month. Rival Reader pays for both: its 20% and 3.00 for a sign-up, 10.00 for a free trial,
-- within 50.00 a month. Quiet Club stays as it is.
select pg_temp.pays_for('acme', 'events', '[{"key":"signup_completed","label":"Account created","amount_minor":200},
  {"key":"trial_started","label":"Trial started","amount_minor":500}]', 50000);
select pg_temp.pays_for('rival', 'both', '[{"key":"signup_completed","label":"Sign-up","amount_minor":300},
  {"key":"trial_started","label":"Free trial","amount_minor":1000}]', 5000);
-- Ada's events in SpeakSix, by her calendar: today; the first moment of yesterday and the
-- last moment of the day before; one the merchant rejected 3 days ago; 4 and 5 days ago (the
-- second through no click that is known); the first moment of the 30-day window and the last
-- moment before it; and one 45 days ago whose hold has passed. Two more counted for nothing.
select pg_temp.award('e1', 'acme', 'ada', pg_temp.q('click_ada_tiktok'), 'signup_completed', now());
select pg_temp.award('e2', 'acme', 'ada', pg_temp.q('click_ada_tt1'), 'trial_started', pg_temp.day('ada', 1));
select pg_temp.award('e3', 'acme', 'ada', pg_temp.q('click_ada_tt2'), 'signup_completed', pg_temp.day('ada', 1) - interval '0.000001 seconds');
select pg_temp.award('e4', 'acme', 'ada', pg_temp.q('click_ada_main'), 'signup_completed', pg_temp.day('ada', 3) + interval '12 hours', 'rejected');
select pg_temp.award('e5', 'acme', 'ada', pg_temp.q('click_ada_ig29'), 'trial_started', pg_temp.day('ada', 29));
select pg_temp.award('e6', 'acme', 'ada', pg_temp.q('click_ada_ig30'), 'signup_completed', pg_temp.day('ada', 29) - interval '0.000001 seconds');
select pg_temp.award('e7', 'acme', 'ada', pg_temp.q('click_ada_yt45'), 'signup_completed', pg_temp.day('ada', 45) + interval '12 hours', 'approved');
select pg_temp.award('e8', 'acme', 'ada', pg_temp.q('click_ada_main'), 'signup_completed', pg_temp.day('ada', 2) + interval '12 hours',
  'not_earned:already_rewarded');
select pg_temp.award('e9', 'acme', 'ada', pg_temp.q('click_ada_main'), 'trial_started', pg_temp.day('ada', 2) + interval '13 hours',
  'not_earned:daily_limit');
select pg_temp.award('e10', 'acme', 'ada', null, 'signup_completed', pg_temp.day('ada', 5) + interval '12 hours');
select pg_temp.award('e11', 'acme', 'ada', pg_temp.q('click_ada_podcast'), 'signup_completed', pg_temp.day('ada', 4) + interval '12 hours');
-- Ben's in SpeakSix: an account today and a trial 3 days ago.
select pg_temp.award('b1', 'acme', 'ben', pg_temp.q('click_ben_main'), 'signup_completed', now());
select pg_temp.award('b2', 'acme', 'ben', pg_temp.q('click_ben_main'), 'trial_started', pg_temp.day('ben', 3) + interval '12 hours');
-- Ada's in Rival Reader: a sign-up today, and a free trial 20 days ago whose hold has passed.
select pg_temp.award('ra1', 'rival', 'ada', pg_temp.q('click_ada_rival'), 'signup_completed', now());
select pg_temp.award('ra2', 'rival', 'ada', pg_temp.q('click_ada_rival20'), 'trial_started', pg_temp.day('ada', 20) + interval '13 hours', 'approved');
select pg_temp.check((select count(*) = 15 and count(*) filter (where w.status = 'earned') = 12
      and count(*) filter (where w.status = 'rejected') = 1 and count(*) filter (where w.status = 'not_earned') = 2
      and count(distinct w.person_id) = 15 and count(distinct w.event_id) = 15
    from public.program_reward_awards w)
  and (select count(*) = 13 and count(*) filter (where x.status = 'held') = 10 and count(*) filter (where x.status = 'approved') = 2
      and count(*) filter (where x.status = 'reversed') = 1 and bool_and(x.commission_type = 'reward' and x.sale_id is null)
    from public.program_commissions x where x.award_id is not null)
  and (pg_temp.account('acme')).available_minor = 495193 and (pg_temp.account('rival')).available_minor = 96920
  and pg_temp.books(),
  'the fixture awards: twelve earned (ten held, two approved), one rejected, two not earned, and the books balance');
select set_config('request.jwt.claims', '', true);

-- Earnings ---------------------------------------------------------------------------------------------
select pg_temp.capture('partner_program_earnings.with_rewards', pg_temp.keep('ada_earnings', pg_temp.earnings('ada')));
select pg_temp.check((select pg_temp.keys(e) = 'payout payouts programs recent'
      and (select string_agg(p->>'name', ', ' order by n) = 'Quiet Club, Rival Reader, SpeakSix'
          and bool_and(pg_temp.keys(p) = 'approved_minor currency events name next_release_at paid_minor paying_minor '
            || 'pending_minor program_id sales slug')
        from jsonb_array_elements(e->'programs') with ordinality x(p, n))
      -- SpeakSix: the sale of 100 days ago is her one sale; the eight events that count are
      -- events and no longer sales. The rejected reward and the two that earned nothing are neither.
      and pg_temp.earnings_line(e, 'speaksix') - 'program_id' = jsonb_build_object('slug', 'speaksix', 'name', 'SpeakSix',
        'currency', 'USD', 'pending_minor', 2000, 'approved_minor', 1670, 'paying_minor', 0, 'paid_minor', 0,
        'sales', 1, 'events', 8, 'next_release_at', pg_temp.day('ada', 29) - interval '0.000001 seconds' + interval '30 days')
      and pg_temp.earnings_line(e, 'rival-reader') - 'program_id' = jsonb_build_object('slug', 'rival-reader', 'name', 'Rival Reader',
        'currency', 'USD', 'pending_minor', 800, 'approved_minor', 2000, 'paying_minor', 0, 'paid_minor', 0,
        'sales', 2, 'events', 2, 'next_release_at', pg_temp.day('ada', 0) + interval '14 days')
      and pg_temp.earnings_line(e, 'quiet-club') - 'program_id' = jsonb_build_object('slug', 'quiet-club', 'name', 'Quiet Club',
        'currency', 'USD', 'pending_minor', 800, 'approved_minor', 1000, 'paying_minor', 0, 'paid_minor', 0,
        'sales', 2, 'events', 0, 'next_release_at', now() + interval '14 days')
    from (select pg_temp.kept('ada_earnings') as e) x),
  'earnings: sales counts the sales that earn and events the events that count; the money sums cover both');
select pg_temp.check((select jsonb_array_length(e->'recent') = 16
      and (select bool_and(pg_temp.keys(r) = 'amount_minor approved_at currency earned_minor hold_until id kind paid_at program_id '
            || 'program_name reward_label sale_amount_minor status')
          and bool_and((r->>'kind' = 'reward') = (r->'sale_amount_minor' = 'null') and (r->>'kind' = 'reward') = (r->'reward_label' <> 'null')
            and r->>'kind' in ('sale', 'reward'))
          and count(*) filter (where r->>'kind' = 'reward') = 11
        from jsonb_array_elements(e->'recent') r)
      -- Newest first, a reward placed by when its event happened.
      and (select bool_and(d.at <= d.before) from (select (r->>'paid_at')::timestamptz as at,
          lag((r->>'paid_at')::timestamptz) over (order by n) as before
        from jsonb_array_elements(e->'recent') with ordinality x(r, n)) d where d.before is not null)
      and pg_temp.recent(e, 'SpeakSix') = 'reward held 200 Account created, reward held 500 Trial started, '
        || 'reward held 200 Account created, reward reversed 0 Account created, reward held 200 Account created, '
        || 'reward held 200 Account created, reward held 500 Trial started, reward held 200 Account created, '
        || 'reward approved 200 Account created, sale approved 1470 -'
      and pg_temp.recent(e, 'Rival Reader') = 'reward held 300 Sign-up, sale held 500 -, reward approved 1000 Free trial, sale approved 1000 -'
      and pg_temp.recent(e, 'Quiet Club') = 'sale held 800 -, sale approved 1000 -'
      and (select r - 'id' = jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'program_name', 'SpeakSix',
          'status', 'held', 'amount_minor', 500, 'earned_minor', 500, 'currency', 'USD', 'sale_amount_minor', null,
          'paid_at', pg_temp.day('ada', 1), 'hold_until', pg_temp.day('ada', 1) + interval '30 days', 'approved_at', null,
          'kind', 'reward', 'reward_label', 'Trial started')
        from jsonb_array_elements(e->'recent') r where (r->>'paid_at')::timestamptz = pg_temp.day('ada', 1))
      and (select r @> '{"status":"approved","amount_minor":1000,"kind":"reward","reward_label":"Free trial","sale_amount_minor":null}'
          and (r->>'approved_at')::timestamptz = pg_temp.day('ada', 20) + interval '13 hours' + interval '14 days'
        from jsonb_array_elements(e->'recent') r where (r->>'paid_at')::timestamptz = pg_temp.day('ada', 20) + interval '13 hours')
      and (select r @> '{"status":"reversed","amount_minor":0,"earned_minor":200,"kind":"reward","reward_label":"Account created"}'
        from jsonb_array_elements(e->'recent') r where (r->>'paid_at')::timestamptz = pg_temp.day('ada', 3) + interval '12 hours')
      and (select r @> '{"status":"approved","amount_minor":1470,"sale_amount_minor":4900,"kind":"sale","reward_label":null}'
        from jsonb_array_elements(e->'recent') r where (r->>'paid_at')::timestamptz = pg_temp.day('ada', 100) + interval '12 hours')
    from (select pg_temp.kept('ada_earnings') as e) x),
  'the recent list holds rewards beside sales: a reward names its label, has no sale amount and is dated by its event; '
    || 'a rejected reward shows as returned, and an event that earned nothing is not listed');
select pg_temp.keep('ben_earnings', pg_temp.earnings('ben'));
select pg_temp.check((select jsonb_array_length(e->'programs') = 1
      and e->'programs'->0 @> '{"slug":"speaksix","pending_minor":700,"approved_minor":0,"sales":0,"events":2}'
      and pg_temp.recent(e, 'SpeakSix') = 'reward held 200 Account created, reward held 500 Trial started'
    from (select pg_temp.kept('ben_earnings') as e) x)
  and pg_temp.earnings('dee') = pg_temp.kept('dee_earnings'),
  'a creator who only earned rewards has events and no sales; a creator of the sales program reads what they read before');

-- The Links page -----------------------------------------------------------------------------------------
select pg_temp.capture('partner_program_links.events_program', pg_temp.keep('ben_links', pg_temp.links('ben')));
select pg_temp.capture('partner_program_links.both_program', pg_temp.keep('ada_links', pg_temp.links('ada')));
select pg_temp.check((select pg_temp.keys(a) = 'channels max_custom_links programs stats_days' and jsonb_array_length(a->'programs') = 1
      and p - 'links' = jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'slug', 'speaksix', 'name', 'SpeakSix',
        'currency', 'USD', 'earn_from', 'events', 'working', true, 'paused_reason', null, 'custom_links', 0)
      and pg_temp.numbers(p->'links') = 'Main link 1/0/2/700'
      and pg_temp.line(p, 'Main link') - 'link_id' - 'created_at' = '{"kind":"main","channel":null,"name":"Main link",
        "url":"https://go.kissmyapps.dev/speaksix/ben-creator","clicks":1,"sales":0,"events":2,"earnings_minor":700,"removable":false}'
      and (select bool_and(pg_temp.keys(l) = 'channel clicks created_at earnings_minor events kind link_id name removable sales url')
        from jsonb_array_elements(p->'links') l)
    from (select pg_temp.kept('ben_links') as a, pg_temp.kept('ben_links')->'programs'->0 as p) x),
  'the Links page of an events program: each link has its events, and its earnings are what those events earned');
select pg_temp.check((select (select string_agg(p->>'name' || ' ' || (p->>'earn_from'), ', ' order by n)
          = 'Quiet Club sales, Rival Reader both, SpeakSix events' from jsonb_array_elements(a->'programs') with ordinality x(p, n))
      -- The last 30 days of Ada's calendar. The rejected reward and the two that earned nothing are
      -- not events; the event through no known click is on no link.
      and pg_temp.numbers(pg_temp.listed(a, 'speaksix')->'links')
        = 'Main link 1/0/0/0, TikTok 3/0/3/900, Instagram 1/0/1/500, Podcast 1/0/1/200'
      -- Sales and events of one link add up in its earnings: 15.00 for two sales and 3.00 for a sign-up.
      and pg_temp.numbers(pg_temp.listed(a, 'rival-reader')->'links') = 'Main link 1/2/1/1800, TikTok 1/0/1/1000'
      and pg_temp.numbers(pg_temp.listed(a, 'quiet-club')->'links') = 'Main link 1/2/0/1800'
      and pg_temp.listed(a, 'quiet-club') = pg_temp.listed(pg_temp.kept('ada_links_before'), 'quiet-club')
    from (select pg_temp.kept('ada_links') as a) x)
  and pg_temp.links('dee') = pg_temp.kept('dee_links'),
  'the Links page names what each program pays for, and a link''s earnings add its sales and its events');

-- The Performance page ---------------------------------------------------------------------------------
select pg_temp.capture('partner_program_performance.events_days7', pg_temp.keep('p7', pg_temp.performance('ada', 'speaksix', 7)));
select pg_temp.capture('partner_program_performance.events_days30', pg_temp.keep('p30', pg_temp.performance('ada', 'speaksix', 30)));
select pg_temp.capture('partner_program_performance.events_days90', pg_temp.keep('p90', pg_temp.performance('ada', 'speaksix', 90)));
select pg_temp.check((select pg_temp.keys(a) = 'budget_reached channels daily days ends_on latest money previous program '
        || 'programs rewards starts_on timezone totals'
      and a @> '{"days":30,"timezone":"Pacific/Kiritimati","budget_reached":false,
        "totals":{"clicks":6,"sales":0,"events":6,"earnings_minor":1800},"previous":{"clicks":2,"sales":0,"events":2,"earnings_minor":400}}'
      and a->>'starts_on' = pg_temp.date_of('ada', 29) and a->>'ends_on' = pg_temp.date_of('ada', 0)
      and a->'program' = jsonb_build_object('program_id', (pg_temp.program('acme')).id, 'slug', 'speaksix', 'name', 'SpeakSix',
        'currency', 'USD', 'earn_from', 'events')
      and a->'programs' = jsonb_build_array(
        jsonb_build_object('program_id', (pg_temp.program('quiet')).id, 'slug', 'quiet-club', 'name', 'Quiet Club', 'currency', 'USD',
          'earn_from', 'sales'),
        jsonb_build_object('program_id', (pg_temp.program('rival')).id, 'slug', 'rival-reader', 'name', 'Rival Reader', 'currency', 'USD',
          'earn_from', 'both'),
        a->'program')
      -- <days back> <clicks>/<sales>/<events>/<earnings>. The event at the first moment of yesterday
      -- is yesterday's, the one a moment earlier the day before's; the first moment of the window is in it.
      and jsonb_array_length(a->'daily') = 30
      and pg_temp.days(a) = '0 3/0/1/200, 1 1/0/1/500, 2 1/0/1/200, 4 0/0/1/200, 5 0/0/1/200, 29 1/0/1/500'
      and a->'daily'->28 = jsonb_build_object('day', pg_temp.date_of('ada', 1), 'clicks', 1, 'sales', 0, 'events', 1, 'earnings_minor', 500)
      and pg_temp.numbers(a->'channels')
        = 'Main link 1/0/0/0, TikTok 3/0/3/900, Instagram 1/0/1/500, Podcast 1/0/1/200, No link 0/0/1/200'
      and a->'channels'->-1 = '{"link_id":null,"kind":"none","channel":null,"name":"No link","clicks":0,"sales":0,"events":1,"earnings_minor":200}'
      and a->'channels'->1 = jsonb_build_object('link_id', (pg_temp.link_row('ada', 'acme', 'TikTok')).id, 'kind', 'channel',
        'channel', 'tiktok', 'name', 'TikTok', 'clicks', 3, 'sales', 0, 'events', 3, 'earnings_minor', 900)
      and jsonb_array_length(a->'channels') = 9
      and a->'rewards' = '[{"key":"signup_completed","label":"Account created","amount_minor":200,"count":4,"earnings_minor":800},
        {"key":"trial_started","label":"Trial started","amount_minor":500,"count":2,"earnings_minor":1000}]'
    from (select pg_temp.kept('p30') as a) x),
  '30 days of an events program: events per day in the creator''s calendar and per link, the rewards with their counts, '
    || 'and the window before it');
select pg_temp.check((select a @> '{"days":7,"totals":{"clicks":5,"sales":0,"events":5,"earnings_minor":1300},
        "previous":{"clicks":0,"sales":0,"events":0,"earnings_minor":0}}'
      and pg_temp.days(a) = '0 3/0/1/200, 1 1/0/1/500, 2 1/0/1/200, 4 0/0/1/200, 5 0/0/1/200'
      and pg_temp.numbers(a->'channels') = 'Main link 1/0/0/0, TikTok 3/0/3/900, Podcast 1/0/1/200, No link 0/0/1/200'
      and pg_temp.rewards(a) = 'Account created 200 4/800, Trial started 500 1/500'
    from (select pg_temp.kept('p7') as a) x)
  and (select a @> '{"days":90,"totals":{"clicks":8,"sales":0,"events":8,"earnings_minor":2200},
        "previous":{"clicks":0,"sales":1,"events":0,"earnings_minor":1470}}'
      and pg_temp.days(a) = '0 3/0/1/200, 1 1/0/1/500, 2 1/0/1/200, 4 0/0/1/200, 5 0/0/1/200, 29 1/0/1/500, 30 1/0/1/200, 45 1/0/1/200'
      and pg_temp.numbers(a->'channels')
        = 'Main link 1/0/0/0, TikTok 3/0/3/900, Instagram 2/0/2/700, YouTube 1/0/1/200, Podcast 1/0/1/200, No link 0/0/1/200'
      and pg_temp.rewards(a) = 'Account created 200 6/1200, Trial started 500 2/1000'
    from (select pg_temp.kept('p90') as a) x),
  '7 and 90 days: an event a moment before the 30-day window is in the window before it, the sale from when the program '
    || 'paid for sales is still a sale, and an event that was rejected or earned nothing is in no window');
select pg_temp.check((select bool_and(
      (a->'totals'->>'clicks')::bigint = (select sum((d->>'clicks')::bigint) from jsonb_array_elements(a->'daily') d)
      and (a->'totals'->>'events')::bigint = (select sum((d->>'events')::bigint) from jsonb_array_elements(a->'daily') d)
      and (a->'totals'->>'earnings_minor')::bigint = (select sum((d->>'earnings_minor')::bigint) from jsonb_array_elements(a->'daily') d)
      and (a->'totals'->>'clicks')::bigint = (select sum((c->>'clicks')::bigint) from jsonb_array_elements(a->'channels') c)
      and (a->'totals'->>'events')::bigint = (select sum((c->>'events')::bigint) from jsonb_array_elements(a->'channels') c)
      and (a->'totals'->>'earnings_minor')::bigint = (select sum((c->>'earnings_minor')::bigint) from jsonb_array_elements(a->'channels') c)
      and (a->'totals'->>'events')::bigint = (select sum((r->>'count')::bigint) from jsonb_array_elements(a->'rewards') r)
      and (a->'totals'->>'earnings_minor')::bigint = (select sum((r->>'earnings_minor')::bigint) from jsonb_array_elements(a->'rewards') r)
      and a->'money' = pg_temp.kept('p7')->'money' and a->'latest' = pg_temp.kept('p7')->'latest')
    from (select answer as a from answers where name in ('p7', 'p30', 'p90')) x),
  'the days, the links and the rewards each add up to the totals, and the money and the latest list do not depend on the window');
select pg_temp.check((select a->'money' = jsonb_build_object('pending_minor', 2000, 'approved_minor', 1670, 'paying_minor', 0,
        'paid_minor', 0, 'next_release_at', pg_temp.day('ada', 29) - interval '0.000001 seconds' + interval '30 days')
      and a->'money' = pg_temp.earnings_line(pg_temp.kept('ada_earnings'), 'speaksix')
        - 'program_id' - 'slug' - 'name' - 'currency' - 'sales' - 'events'
      and a->'latest' = jsonb_build_array(
        jsonb_build_object('paid_at', now(), 'link_name', 'TikTok', 'amount_minor', 200, 'status', 'held',
          'kind', 'reward', 'reward_label', 'Account created'),
        jsonb_build_object('paid_at', pg_temp.day('ada', 1), 'link_name', 'TikTok', 'amount_minor', 500, 'status', 'held',
          'kind', 'reward', 'reward_label', 'Trial started'),
        jsonb_build_object('paid_at', pg_temp.day('ada', 1) - interval '0.000001 seconds', 'link_name', 'TikTok', 'amount_minor', 200,
          'status', 'held', 'kind', 'reward', 'reward_label', 'Account created'),
        jsonb_build_object('paid_at', pg_temp.day('ada', 3) + interval '12 hours', 'link_name', 'Main link', 'amount_minor', 0,
          'status', 'reversed', 'kind', 'reward', 'reward_label', 'Account created'),
        jsonb_build_object('paid_at', pg_temp.day('ada', 4) + interval '12 hours', 'link_name', 'Podcast', 'amount_minor', 200,
          'status', 'held', 'kind', 'reward', 'reward_label', 'Account created'))
    from (select pg_temp.kept('p30') as a) x),
  'the money is the program''s line of the creator''s earnings; the latest five commissions are rewards, newest first, '
    || 'each dated by its event with its link, its label and what it is worth now');
select pg_temp.check((select a @> '{"timezone":"UTC","budget_reached":false,"totals":{"clicks":1,"sales":0,"events":2,"earnings_minor":700},
        "program":{"slug":"speaksix","earn_from":"events"}}'
      and pg_temp.days(a) = '0 1/0/1/200, 3 0/0/1/500' and pg_temp.numbers(a->'channels') = 'Main link 1/0/2/700'
      and pg_temp.rewards(a) = 'Account created 200 1/200, Trial started 500 1/500'
      and jsonb_array_length(a->'latest') = 2 and a->'latest'->1 @> '{"link_name":"Main link","amount_minor":500,"kind":"reward","reward_label":"Trial started"}'
    from (select pg_temp.performance('ben', 'speaksix', 7) as a) x),
  'each creator reads their own events');

-- A program that pays for both.
select pg_temp.capture('partner_program_performance.both_days30', pg_temp.keep('p_both', pg_temp.performance('ada', 'rival-reader', 30)));
select pg_temp.check((select a @> '{"days":30,"budget_reached":false,"totals":{"clicks":2,"sales":2,"events":2,"earnings_minor":2800},
        "previous":{"clicks":0,"sales":0,"events":0,"earnings_minor":0},"program":{"slug":"rival-reader","earn_from":"both"}}'
      -- A day and a link add what their sales and their events earned.
      and pg_temp.days(a) = '0 1/1/1/800, 20 1/1/1/2000'
      and pg_temp.numbers(a->'channels') = 'Main link 1/2/1/1800, TikTok 1/0/1/1000'
      and a->'rewards' = '[{"key":"signup_completed","label":"Sign-up","amount_minor":300,"count":1,"earnings_minor":300},
        {"key":"trial_started","label":"Free trial","amount_minor":1000,"count":1,"earnings_minor":1000}]'
      and a->'money' = jsonb_build_object('pending_minor', 800, 'approved_minor', 2000, 'paying_minor', 0, 'paid_minor', 0,
        'next_release_at', pg_temp.day('ada', 0) + interval '14 days')
      and a->'latest' = jsonb_build_array(
        jsonb_build_object('paid_at', now(), 'link_name', 'Main link', 'amount_minor', 300, 'status', 'held',
          'kind', 'reward', 'reward_label', 'Sign-up'),
        jsonb_build_object('paid_at', pg_temp.day('ada', 0), 'link_name', 'Main link', 'amount_minor', 500, 'status', 'held',
          'kind', 'sale', 'reward_label', null),
        jsonb_build_object('paid_at', pg_temp.day('ada', 20) + interval '13 hours', 'link_name', 'TikTok', 'amount_minor', 1000,
          'status', 'approved', 'kind', 'reward', 'reward_label', 'Free trial'),
        jsonb_build_object('paid_at', pg_temp.day('ada', 20) + interval '12 hours', 'link_name', 'Main link', 'amount_minor', 1000,
          'status', 'approved', 'kind', 'sale', 'reward_label', null))
    from (select pg_temp.kept('p_both') as a) x),
  'a program that pays for both: sales and events are counted apart and their earnings together, and the latest list '
    || 'mixes them by time');

-- The days follow the creator's time zone for events as they do for sales.
update public.affiliates set reporting_timezone = 'UTC' where id = pg_temp.q('creator_ada');
select pg_temp.check((select a->>'timezone' = 'UTC' and a->>'ends_on' = (now() at time zone 'UTC')::date::text
      and (select sum((d->>'events')::bigint) from jsonb_array_elements(a->'daily') d) = (a->'totals'->>'events')::bigint
      -- The two events either side of Ada's midnight are on one day of the UTC calendar.
      and (select d->>'events' = '2' from jsonb_array_elements(a->'daily') d
        where d->>'day' = ((select w.occurred_at from public.program_reward_awards w where w.id = pg_temp.q('e2')) at time zone 'UTC')::date::text)
      and a->'daily' <> pg_temp.kept('p90')->'daily' and a->'totals'->'events' = '8'
    from (select pg_temp.performance('ada', 'speaksix', 90) as a) x),
  'in another time zone the same events fall on other days');
update public.affiliates set reporting_timezone = 'Pacific/Kiritimati' where id = pg_temp.q('creator_ada');
select pg_temp.check(pg_temp.performance('ada', 'speaksix', 90) = pg_temp.kept('p90'), 'and back');

-- An event whose link is gone: Ada archives the Podcast link on the older Links page.
select pg_temp.call('ada', format('select to_jsonb(r) from public.set_partner_link_status(%L, ''archived'') r',
  (pg_temp.link_row('ada', 'acme', 'Podcast')).id));
select pg_temp.check((select a->'totals' = pg_temp.kept('p30')->'totals' and a->'daily' = pg_temp.kept('p30')->'daily'
      and a->'rewards' = pg_temp.kept('p30')->'rewards'
      and pg_temp.numbers(a->'channels') = 'Main link 1/0/0/0, TikTok 3/0/3/900, Instagram 1/0/1/500, No link 1/0/2/400'
      and jsonb_array_length(a->'channels') = 8 and a->'latest'->4->>'link_name' = 'Podcast'
    from (select pg_temp.performance('ada', 'speaksix', 30) as a) x)
  and pg_temp.numbers(pg_temp.listed(pg_temp.links('ada'), 'speaksix')->'links')
    = 'Main link 1/0/0/0, TikTok 3/0/3/900, Instagram 1/0/1/500',
  'events through a link that was archived since come under "No link", with the events that came through no known click');
select pg_temp.call('ada', format('select to_jsonb(r) from public.set_partner_link_status(%L, ''paused'') r',
  (pg_temp.link_row('ada', 'acme', 'Podcast')).id));
select pg_temp.call('ada', format('select to_jsonb(r) from public.set_partner_link_status(%L, ''active'') r',
  (pg_temp.link_row('ada', 'acme', 'Podcast')).id));
select pg_temp.check(pg_temp.performance('ada', 'speaksix', 30) = pg_temp.kept('p30'), 'the link is back and so is its line');
-- A program with events and no "No link" line: the line is only there when it has sales or events.
select pg_temp.check(not exists (select 1 from jsonb_array_elements(pg_temp.kept('p_both')->'channels') c where c->>'kind' = 'none')
  and jsonb_array_length(pg_temp.kept('p_both')->'channels') = 7,
  'the "No link" line is only there when a sale or an event belongs to no link');

-- The budget -------------------------------------------------------------------------------------------
-- budget_reached says that this calendar month (UTC) no reward of the program fits in what is
-- left of its budget. What the month used is counted here the way the reward engine counts it.
insert into qa values ('used', pg_temp.used('rival')::text);
create function pg_temp.reached(creator text, program_slug text) returns boolean language sql as $$
  select (pg_temp.performance(creator, program_slug, 7)->>'budget_reached')::boolean
$$;
select pg_temp.check((select value::bigint in (300, 1300) from qa where key = 'used')
  and not pg_temp.reached('ada', 'rival-reader') and not pg_temp.reached('ada', 'speaksix') and not pg_temp.reached('ada', 'quiet-club'),
  'this month''s sign-up of today has used 3.00 of Rival Reader''s budget (the free trial of 20 days ago too when it was '
    || 'this month), and no budget is reached');
-- The smallest reward, 3.00, still fits exactly: not reached. One cent less: reached.
select pg_temp.set_budget('rival', (select value::bigint + 300 from qa where key = 'used'));
select pg_temp.check(not pg_temp.reached('ada', 'rival-reader'), 'a budget the smallest reward still fits in exactly is not reached');
select pg_temp.set_budget('rival', (select value::bigint + 299 from qa where key = 'used'));
select pg_temp.capture('partner_program_performance.budget_reached',
  pg_temp.keep('p_reached', pg_temp.performance('ada', 'rival-reader', 30)));
select pg_temp.check((select a->'budget_reached' = 'true' and a - 'budget_reached' = pg_temp.kept('p_both') - 'budget_reached'
    from (select pg_temp.kept('p_reached') as a) x)
  and pg_temp.reached('cy', 'rival-reader') and not pg_temp.reached('ada', 'speaksix') and not pg_temp.reached('ada', 'quiet-club')
  and pg_temp.kept('p_reached')::text !~ '"(reward_)?budget(_minor)?"',
  'when the smallest reward no longer fits the budget is reached, for every creator of that program and no other; '
    || 'nothing else in the answer changes, and the budget itself is never in it');
-- Room for two more sign-ups. Cy brings one at the first moment of the month: it counts. One a
-- moment earlier belongs to last month. A rejected reward gives its part back, and an event
-- that earned nothing uses nothing.
select pg_temp.set_budget('rival', (select value::bigint + 600 from qa where key = 'used'));
select pg_temp.award('cm1', 'rival', 'cy', pg_temp.q('click_cy_rival'), 'signup_completed', pg_temp.month_start());
select pg_temp.check(pg_temp.used('rival') = (select value::bigint + 300 from qa where key = 'used')
  and not pg_temp.reached('ada', 'rival-reader'), 'a reward at the first moment of the month uses this month''s budget');
select pg_temp.award('cm2', 'rival', 'cy', pg_temp.q('click_cy_rival'), 'signup_completed', pg_temp.month_start() - interval '0.000001 seconds');
select pg_temp.award('cm3', 'rival', 'cy', pg_temp.q('click_cy_rival'), 'signup_completed', now(), 'rejected');
select pg_temp.award('cm4', 'rival', 'cy', pg_temp.q('click_cy_rival'), 'trial_started', now(), 'not_earned:budget_reached');
select pg_temp.check(pg_temp.used('rival') = (select value::bigint + 300 from qa where key = 'used')
  and not pg_temp.reached('ada', 'rival-reader') and not pg_temp.reached('cy', 'rival-reader'),
  'a reward of the last moment of last month, a rejected reward and an event that earned nothing use none of this month''s budget');
select pg_temp.award('cm5', 'rival', 'cy', pg_temp.q('click_cy_rival'), 'signup_completed', now());
select pg_temp.check(pg_temp.used('rival') = (select value::bigint + 600 from qa where key = 'used')
  and pg_temp.reached('ada', 'rival-reader') and pg_temp.reached('cy', 'rival-reader'),
  'the next reward that earns uses the budget up');
-- The merchant raises the budget: it takes effect at once, and no terms change.
select pg_temp.set_budget('rival', 5000);
select pg_temp.check(not pg_temp.reached('ada', 'rival-reader') and not pg_temp.reached('cy', 'rival-reader')
  and pg_temp.performance('ada', 'rival-reader', 30) = pg_temp.kept('p_both')
  and (select a->'totals'->'events' = '3' and pg_temp.rewards(a) = 'Sign-up 300 3/900, Free trial 1000 0/0'
    from (select pg_temp.performance('cy', 'rival-reader', 90) as a) x)
  and pg_temp.books(),
  'a raised budget is not reached any more; Cy''s three rewards that earned are Cy''s events, and the books balance');

-- The merchant's Creators page ---------------------------------------------------------------------------
select pg_temp.capture('workspace_program_creators.with_events', pg_temp.keep('creators', pg_temp.creators('owner', 'acme')));
select pg_temp.check((select pg_temp.keys(a) = 'can_manage counts creators currency earn_from program totals'
      and a @> '{"can_manage":true,"currency":"USD","earn_from":"events","counts":{"pending":0,"active":2,"ended":0}}'
      and a->'totals' = '{"clicks":9,"sales":1,"events":10,"sales_amount_minor":4900,"commission_minor":4370,"pending_minor":2700}'
      and a->'program' = jsonb_build_object('id', (pg_temp.program('acme')).id, 'slug', 'speaksix', 'name', 'SpeakSix',
        'status', 'live', 'approval_mode', 'automatic', 'marketplace_listed', true)
      and (select bool_and(pg_temp.keys(c) = 'activated_at channels clicks commission_minor country_code decision_note '
          || 'ended_at events handle last_click_at member_id name needs_new_terms pending_minor requested_at sales '
          || 'sales_amount_minor status terms_version website_url') from jsonb_array_elements(a->'creators') c)
      -- Ada: her sale from before and its 14.70, and eight events worth 22.00, 20.00 of it still held.
      and pg_temp.creator(a, 'ada-okafor') @> '{"status":"active","clicks":8,"sales":1,"events":8,"sales_amount_minor":4900,
        "commission_minor":3670,"pending_minor":2000,"needs_new_terms":false}'
      and pg_temp.creator(a, 'ben-creator') @> '{"status":"active","clicks":1,"sales":0,"events":2,"sales_amount_minor":0,
        "commission_minor":700,"pending_minor":700}'
    from (select pg_temp.kept('creators') as a) x)
  and pg_temp.creators('analyst', 'acme') = pg_temp.kept('creators') || '{"can_manage":false}',
  'the Creators page of an events program: each creator''s events, and their commission and its held part with the rewards in them');
select pg_temp.check((select a->>'earn_from' = 'both'
      and a->'totals' = '{"clicks":3,"sales":2,"events":5,"sales_amount_minor":7500,"commission_minor":3700,"pending_minor":1700}'
      and pg_temp.creator(a, 'ada-okafor') @> '{"clicks":2,"sales":2,"events":2,"sales_amount_minor":7500,"commission_minor":2800,"pending_minor":800}'
      and pg_temp.creator(a, 'cy-park') @> '{"clicks":1,"sales":0,"events":3,"sales_amount_minor":0,"commission_minor":900,"pending_minor":900}'
    from (select pg_temp.creators('rival_owner', 'rival') as a) x)
  and pg_temp.creators('quiet_owner', 'quiet') = pg_temp.kept('quiet_creators'),
  'a program that pays for both adds sales and rewards; the sales program reads what it read before');

-- The merchant's Balance page ----------------------------------------------------------------------------
select pg_temp.capture('workspace_program_balance.with_rewards', pg_temp.keep('balance', pg_temp.balance('owner', 'acme')));
select pg_temp.check((select b->'account' @> '{"currency":"USD","available_minor":495193,"reserved_minor":2970,
        "creators_pending_minor":2700,"creators_approved_minor":1670,"fees_minor":437,"deposited_minor":500000}'
      and jsonb_array_length(b->'activity') = 27
      and (select bool_and(pg_temp.keys(e) = 'amount_minor available_after_minor created_at creator_name id kind note '
          || 'reward_label sale_amount_minor topup_kind') from jsonb_array_elements(b->'activity') e)
      -- Newest first: the last thing posted was the fee of Ben's trial.
      and (b->'activity'->0) - 'id' - 'created_at' = '{"kind":"fee_reserved","amount_minor":-50,"available_after_minor":495193,
        "creator_name":"Ben Creator","sale_amount_minor":null,"reward_label":"Trial started","topup_kind":null,"note":null}'
      and (b->'activity'->1) - 'id' - 'created_at' = '{"kind":"commission_reserved","amount_minor":-500,"available_after_minor":495243,
        "creator_name":"Ben Creator","sale_amount_minor":null,"reward_label":"Trial started","topup_kind":null,"note":null}'
      -- Every line about a reward's commission names the reward and no sale; every other line names no reward.
      and (select count(*) = 27 and count(w.id) = 24
          and bool_and(e->>'reward_label' is not distinct from w.reward_label)
          and bool_and((w.id is null) or (e->'sale_amount_minor' = 'null' and e->>'creator_name' is not null))
          and count(*) filter (where e->>'kind' in ('commission_returned', 'fee_returned') and e->>'reward_label' = 'Account created') = 2
          and count(*) filter (where e->'sale_amount_minor' = '4900' and e->'reward_label' = 'null') = 2
          and count(*) filter (where e->>'kind' = 'deposit' and e->'reward_label' = 'null' and e->'creator_name' = 'null') = 1
        from jsonb_array_elements(b->'activity') e
        join public.program_balance_entries r on r.id = (e->>'id')::uuid
        left join public.program_commissions x on x.id = r.commission_id
        left join public.program_reward_awards w on w.id = x.award_id)
    from (select pg_temp.kept('balance') as b) x)
  and pg_temp.balance('analyst', 'acme') - 'can_manage' = pg_temp.kept('balance') - 'can_manage'
  and pg_temp.balance('quiet_owner', 'quiet') = pg_temp.kept('quiet_balance'),
  'the Balance page: what rewards set aside is in every sum, and each line about a reward carries its label');

-- The sales program after all of it --------------------------------------------------------------------
-- What the other two programs earned changed nothing for Quiet Club; only the program picker
-- of Ada's Performance page now says what the other two pay for.
select pg_temp.check(pg_temp.performance('ada', 'quiet-club', 30) - 'programs' = pg_temp.kept('quiet_performance') - 'programs'
  and pg_temp.old_shape(pg_temp.performance('ada', 'quiet-club', 30)) = pg_temp.old_shape(pg_temp.kept('quiet_performance'))
  and pg_temp.performance('ada', null, 30)->'program'->>'slug' = 'quiet-club'
  and pg_temp.performance('dee', null, 7) = pg_temp.kept('dee_performance')
  and pg_temp.links('dee') = pg_temp.kept('dee_links') and pg_temp.earnings('dee') = pg_temp.kept('dee_earnings')
  and pg_temp.creators('quiet_owner', 'quiet') = pg_temp.kept('quiet_creators')
  and pg_temp.balance('quiet_owner', 'quiet') = pg_temp.kept('quiet_balance'),
  'every answer about the sales program is what it was before any reward existed');

-- Terms are read for what they say ------------------------------------------------------------------------
-- Some of the terms below could not be saved through the program form. Whatever keeps other
-- tables in step with a program's terms is switched off while they are written: this part is
-- only about how terms are read.
alter table public.affiliate_programs disable trigger user;
-- What a program earns from is what its published terms say, not what the form holds.
update public.affiliate_programs set earn_from = 'both', reward_budget_minor = 100,
  rewards = '[{"key":"signup_completed","label":"Joined","amount_minor":500}]' where id = (pg_temp.program('quiet')).id;
select pg_temp.check(pg_temp.performance('ada', 'quiet-club', 30) - 'programs' = pg_temp.kept('quiet_performance') - 'programs'
  and pg_temp.links('dee') = pg_temp.kept('dee_links')
  and pg_temp.creators('quiet_owner', 'quiet') = pg_temp.kept('quiet_creators'),
  'rewards saved on the form and not in the published terms change nothing');
-- Terms of a sales program as Phase 6 writes them, terms that list rewards beside "sales",
-- and terms with a word this phase does not know: all read as sales with no rewards.
select pg_temp.new_terms('quiet', '{"earn_from":"sales","rewards":[]}');
select pg_temp.check(pg_temp.performance('ada', 'quiet-club', 30) - 'programs' = pg_temp.kept('quiet_performance') - 'programs'
  and pg_temp.links('dee') = pg_temp.kept('dee_links'), 'terms that say "sales" read as the terms from before did');
select pg_temp.new_terms('quiet', '{"earn_from":"sales","rewards":[{"key":"signup_completed","label":"Joined","amount_minor":500}]}');
select pg_temp.check(pg_temp.performance('ada', 'quiet-club', 30) - 'programs' = pg_temp.kept('quiet_performance') - 'programs'
  and pg_temp.links('dee') = pg_temp.kept('dee_links'), 'rewards listed beside "sales" are not rewards');
select pg_temp.new_terms('quiet', '{"earn_from":"installs"}');
select pg_temp.check(pg_temp.performance('ada', 'quiet-club', 30) - 'programs' = pg_temp.kept('quiet_performance') - 'programs'
  and pg_temp.links('dee') = pg_temp.kept('dee_links') and pg_temp.creators('quiet_owner', 'quiet')->>'earn_from' = 'sales',
  'a word for what a program earns from that is not known reads as "sales"');
-- Terms whose rewards are not a list, and a list with items that are not rewards.
select pg_temp.new_terms('quiet', '{"earn_from":"events","rewards":"soon"}');
select pg_temp.check((select a->'program'->>'earn_from' = 'events' and a->'rewards' = '[]' and a->'budget_reached' = 'false'
      and pg_temp.old_shape(a) = pg_temp.old_shape(pg_temp.kept('quiet_performance'))
    from (select pg_temp.performance('ada', 'quiet-club', 30) as a) x),
  'rewards that are not a list read as none, and a program with no reward has no budget to reach');
select pg_temp.new_terms('quiet', '{"earn_from":"both","rewards":[{"key":"signup_completed","label":"Joined","amount_minor":500},
  {"key":7,"label":"No key","amount_minor":5},{"key":"no_amount","label":"No amount"},"text",
  {"key":"fraction","label":"Fraction","amount_minor":2.5},{"key":"huge","label":"Huge","amount_minor":1e30},
  {"key":"free","label":"Free","amount_minor":0}]}');
select pg_temp.check((select a->'program'->>'earn_from' = 'both'
      and a->'rewards' = '[{"key":"signup_completed","label":"Joined","amount_minor":500,"count":0,"earnings_minor":0}]'
      -- The form's budget of 1.00 cannot fit the 5.00 reward.
      and a->'budget_reached' = 'true'
      and pg_temp.old_shape(a) = pg_temp.old_shape(pg_temp.kept('quiet_performance'))
    from (select pg_temp.performance('ada', 'quiet-club', 30) as a) x)
  and pg_temp.creators('quiet_owner', 'quiet')->>'earn_from' = 'both'
  and pg_temp.listed(pg_temp.links('dee'), 'quiet-club')->>'earn_from' = 'both',
  'an item that is not a key, a label and a whole amount is left out, and the rest still reads');
alter table public.affiliate_programs enable trigger user;

-- Nothing about the person who did an event ---------------------------------------------------------------
select pg_temp.keep('cy_performance', pg_temp.performance('cy', 'rival-reader', 90)), pg_temp.keep('cy_links', pg_temp.links('cy')),
  pg_temp.keep('cy_earnings', pg_temp.earnings('cy')), pg_temp.keep('rival_creators', pg_temp.creators('rival_owner', 'rival')),
  pg_temp.keep('rival_balance', pg_temp.balance('rival_owner', 'rival'));
select pg_temp.check((select count(*) = 20 from public.program_reward_awards)
  and not exists (select 1 from answers a, public.program_reward_awards w
    where a.answer::text like '%' || w.person_id || '%' or a.answer::text like '%' || w.event_id || '%'
      or a.answer::text like '%' || w.id || '%')
  and (select bool_and(a.answer::text !~* '"(person|event|session|award)_?(id)?"|77000000|person|session')
    from answers a),
  'no person, event, session or award id is in any answer');
-- (The payout part of the earnings answer names the KissMyApps platform account, as it did.)
select pg_temp.check((select bool_and((answer - 'payout')::text !~* 'p6buyer|pi_|ch_p6|cs_p6|cus_|acct_|example\.test|speaksix\.com|metadata|@')
    from answers where name in ('ada_earnings', 'ben_earnings', 'dee_earnings', 'cy_earnings', 'ada_links', 'ben_links', 'dee_links',
      'cy_links', 'p7', 'p30', 'p90', 'p_both', 'p_reached', 'quiet_performance', 'dee_performance', 'cy_performance'))
  and (select bool_and(answer::text !~* 'p6buyer|pi_|ch_p6|cs_p6|cus_|example\.test|Ada N\. Okafor|@')
    from answers where name in ('creators', 'quiet_creators', 'rival_creators', 'balance', 'quiet_balance', 'rival_balance'))
  and (select count(*) = 6 from public.program_sales s where s.customer_id like 'cus\_P6Buyer%'),
  'no buyer, no payment id and no email is in anything a creator or a merchant reads here');
select pg_temp.check(pg_temp.books(), 'the books balance at the end');

select 'ok ' || count(*) || ' program reward numbers assertions' from numbers_assertions;
rollback;
