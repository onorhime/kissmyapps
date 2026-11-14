-- Provider-free test of the affiliate money follow-ups of 2026-11-13
-- (20261122104000_program_refund_recovery.sql): programs pay creators in US dollars, the
-- agreement's new wording, and a refund after approval carried over to the creator's later
-- earnings, with the merchant paid back as it is recovered and the KissMyApps fee returned
-- at once.
--
-- Programs, members and clicks are made with the real functions; balances are opened with
-- open_program_balance and funded as fixtures; sales are inserted directly and become
-- commissions through the real sync and tick; payouts go through the real admin and worker
-- functions. A reward is inserted as a held reward commission (suite 85 covers how one is
-- earned) and approved by the real rewards tick. Stripe is never called.
begin;
set local time zone 'UTC';
create temporary table recovery_assertions(label text);
create temporary table qa(key text primary key, value text);
create sequence pg_temp.award_events start 960001;
create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Program refund recovery assertion failed: %', label; end if;
  insert into recovery_assertions values (label);
end $$;
create function pg_temp.q(k text) returns uuid language sql as $$ select value::uuid from qa where key = k $$;
create function pg_temp.t(k text) returns text language sql as $$ select value from qa where key = k $$;
create function pg_temp.keep(k text, v text) returns void language sql as $$
  insert into qa values (k, v) on conflict (key) do update set value = excluded.value
$$;
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
-- 'ok', or the SQLSTATE, the code and the words of a statement run directly.
create function pg_temp.fails(statement text) returns text language plpgsql as $$
declare reason text;
begin
  execute statement;
  return 'ok';
exception when others then
  get stacked diagnostics reason = pg_exception_detail;
  return sqlstate || ' ' || coalesce(reason, '') || ' ' || sqlerrm;
end $$;
-- Runs one statement the way an edge function or pg_cron does: as the service role.
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
-- What the end of the writing transaction does: the deferred commission triggers run.
create function pg_temp.flush() returns void language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end $$;
create function pg_temp.ago(p interval) returns timestamptz language sql as $$
  select date_trunc('second', now()) - p
$$;

-- Programs -------------------------------------------------------------------------------------
create function pg_temp.program(workspace text) returns public.affiliate_programs language sql as $$
  select p from public.affiliate_programs p where workspace_id = pg_temp.q(workspace)
$$;
create function pg_temp.terms_row(workspace text) returns public.affiliate_program_terms language sql as $$
  select t from public.affiliate_program_terms t join public.affiliate_programs p on p.id = t.program_id
  where p.workspace_id = pg_temp.q(workspace) and t.version = p.live_terms_version
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
-- A save of the program form, carrying the revision once the program exists.
create function pg_temp.save_sql(workspace text, input jsonb) returns text language sql as $$
  select format('select public.workspace_program_save(%L, %L)', pg_temp.q(workspace),
    input || coalesce((select jsonb_build_object('revision', p.revision) from pg_temp.program(workspace) p), '{}'::jsonb))
$$;
create function pg_temp.read_sql(who text, workspace text) returns text language sql as $$
  select format('select public.workspace_program_mark_agreement_read(%L, %L)', pg_temp.q(workspace),
    pg_temp.call(who, format('select public.workspace_program_agreement(%L)', pg_temp.q(workspace)))->>'sha256')
$$;
create function pg_temp.submit_sql(workspace text) returns text language sql as $$
  select format('select public.workspace_program_submit(%L, %s)', pg_temp.q(workspace), (pg_temp.program(workspace)).revision)
$$;
create function pg_temp.status_sql(workspace text, status text) returns text language sql as $$
  select format('select public.workspace_program_set_status(%L, %L, %s)', pg_temp.q(workspace), status,
    (pg_temp.program(workspace)).revision)
$$;
-- The merchant saves the form, reads the agreement and publishes; KissMyApps approves.
create function pg_temp.publish(who text, workspace text, input jsonb) returns void language plpgsql as $$
begin
  perform pg_temp.call(who, pg_temp.save_sql(workspace, input));
  perform pg_temp.call(who, pg_temp.read_sql(who, workspace));
  perform pg_temp.call(who, pg_temp.submit_sql(workspace));
  perform pg_temp.call('kma_owner', format('select public.review_admin_program(%L)',
    jsonb_build_object('program_id', (pg_temp.program(workspace)).id, 'decision', 'approve')));
end $$;

-- Creators ---------------------------------------------------------------------------------------
create function pg_temp.join(creator text, workspace text) returns jsonb language sql as $$
  select pg_temp.call(creator, format('select public.partner_program_join(%L)', jsonb_build_object(
    'slug', p.slug, 'terms_version', t.version, 'agreement_sha256', t.agreement_sha256)))
  from pg_temp.program(workspace) p
  join public.affiliate_program_terms t on t.program_id = p.id and t.version = p.live_terms_version
$$;
-- A visitor opens the creator's link: the click the redirect function records.
create function pg_temp.click(creator text, workspace text) returns uuid language plpgsql as $$
declare
  v_slug text;
  v_code text;
  result text;
begin
  select a.slug, l.public_code into v_slug, v_code
  from public.affiliate_program_members m
  join public.affiliate_links l on l.id = m.main_link_id
  join public.affiliates a on a.id = l.affiliate_id
  where m.program_id = (pg_temp.program(workspace)).id and m.affiliate_id = pg_temp.q('creator_' || creator);
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  select r.click_id into result from public.register_tracking_click(v_slug, v_code, '{}'::jsonb) r;
  reset role;
  return (select k.id from public.clicks k where k.public_click_id = result);
exception when others then
  reset role;
  raise;
end $$;
-- What the creator has coming from one program (the sum of their entries), and what their
-- refunds there still owe back.
create function pg_temp.owed(creator text, workspace text) returns bigint language sql as $$
  select coalesce(sum(e.amount_minor), 0)::bigint from public.program_creator_entries e
  where e.affiliate_id = pg_temp.q('creator_' || creator) and e.program_id = (pg_temp.program(workspace)).id
$$;
create function pg_temp.due(creator text, workspace text) returns bigint language sql as $$
  select coalesce(sum(c.recovery_due_minor), 0)::bigint from public.program_commissions c
  where c.affiliate_id = pg_temp.q('creator_' || creator) and c.program_id = (pg_temp.program(workspace)).id
$$;
create function pg_temp.line(creator text, program_name text) returns jsonb language sql as $$
  select p from jsonb_array_elements(pg_temp.call(creator, 'select public.partner_program_earnings()')->'programs') p
  where p->>'name' = program_name
$$;

-- Balances -------------------------------------------------------------------------------------
create function pg_temp.account(workspace text) returns public.program_balance_accounts language sql as $$
  select a from public.program_balance_accounts a where a.program_id = (pg_temp.program(workspace)).id
$$;
create function pg_temp.available(workspace text) returns bigint language sql as $$
  select (pg_temp.account(workspace)).available_minor
$$;
create function pg_temp.entries(workspace text) returns bigint language sql as $$
  select count(*) from public.program_balance_entries e where e.account_id = (pg_temp.account(workspace)).id
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

-- Sales, rewards and commissions -------------------------------------------------------------------
-- A sale credited to the creator, paid at the given time; its commission is synced.
create function pg_temp.sale(k text, workspace text, creator text, amount bigint, paid timestamptz) returns void language plpgsql as $$
declare
  p public.affiliate_programs := pg_temp.program(workspace);
  v_click public.clicks;
  v_id uuid := gen_random_uuid();
begin
  select * into v_click from public.clicks where id = pg_temp.q('click_' || creator);
  insert into public.program_sales(id, program_id, connection_id, account_id, payment_intent_id, amount_minor, currency,
      refunded_minor, status, paid_at, click_id, click_record_id, affiliate_id, match_source)
    select v_id, p.id, c.id, c.account_id, 'pi_' || k, amount, p.currency, 0, 'paid', paid,
      v_click.public_click_id, v_click.id, v_click.affiliate_id, 'metadata'
    from public.merchant_connections c join public.merchant_businesses b on b.id = c.merchant_id
    where b.workspace_id = p.workspace_id;
  insert into qa values (k, v_id);
  perform pg_temp.flush();
end $$;
create function pg_temp.tick() returns jsonb language sql as $$
  select pg_temp.svc('program_commissions_tick', '{"limit":100}')
$$;
-- A sale 40 days ago, past every hold, and the tick that approves its commission.
create function pg_temp.earn(k text, workspace text, creator text, amount bigint) returns void language plpgsql as $$
begin
  perform pg_temp.sale(k, workspace, creator, amount, pg_temp.ago('40 days'));
  perform pg_temp.tick();
end $$;
-- Stripe now reports this much of the payment refunded.
create function pg_temp.refund(k text, total bigint) returns void language plpgsql as $$
begin
  update public.program_sales set refunded_minor = total where id = pg_temp.q(k);
  perform kma_internal.program_sale_refresh_status(pg_temp.q(k));
  perform pg_temp.flush();
end $$;
-- A reward the creator earned 40 days ago, held with its fee set aside, as the reward engine
-- leaves it (a fixture: suite 85 covers how a reward is earned).
create function pg_temp.reward(k text, workspace text, creator text, amount bigint) returns void language plpgsql as $$
declare
  p public.affiliate_programs := pg_temp.program(workspace);
  m public.affiliate_program_members;
  v_award uuid := gen_random_uuid();
  v_commission uuid := gen_random_uuid();
  v_fee bigint := div(amount * 1000, 10000);
begin
  select * into m from public.affiliate_program_members x where x.program_id = p.id and x.affiliate_id = pg_temp.q('creator_' || creator);
  insert into public.program_reward_awards(id, program_id, reward_key, reward_label, event_id, person_id, occurred_at,
    member_id, affiliate_id, terms_version, status, currency, amount_minor)
  values (v_award, p.id, 'chapter_read', 'First chapter read', nextval('pg_temp.award_events'), gen_random_uuid(),
    pg_temp.ago('40 days'), m.id, m.affiliate_id, p.live_terms_version, 'earned', 'USD', amount);
  insert into public.program_commissions(id, award_id, program_id, member_id, affiliate_id, terms_version, status, currency,
    basis_minor, commission_type, commission_fixed_minor, fee_bps, earned_minor, amount_minor, fee_earned_minor, fee_minor,
    hold_until)
  values (v_commission, v_award, p.id, m.id, m.affiliate_id, p.live_terms_version, 'held', 'USD',
    amount, 'reward', amount, 1000, amount, amount, v_fee, v_fee, pg_temp.ago('10 days'));
  perform kma_internal.program_balance_post((pg_temp.account(workspace)).id, 'commission_reserved', -amount, null, v_commission);
  perform kma_internal.program_balance_post((pg_temp.account(workspace)).id, 'fee_reserved', -v_fee, null, v_commission);
  insert into qa values (k, v_award);
end $$;
create function pg_temp.rewards_tick() returns jsonb language sql as $$
  select pg_temp.svc('program_rewards_tick', '{"limit":100}')
$$;
-- The commission of a sale or a reward, and in one line: status amount+fee due what it owes back.
create function pg_temp.com(k text) returns public.program_commissions language sql as $$
  select c from public.program_commissions c where c.sale_id = pg_temp.q(k) or c.award_id = pg_temp.q(k)
$$;
create function pg_temp.c(k text) returns text language sql as $$
  select c.status || ' ' || c.amount_minor || '+' || c.fee_minor || ' due ' || c.recovery_due_minor from pg_temp.com(k) c
$$;
-- The commission's entries of one kind, on the balance and on the creator's sum: <how many>x<their sum>.
create function pg_temp.moved(k text, p_kind text) returns text language sql as $$
  select count(*) || 'x' || coalesce(sum(e.amount_minor), 0) from public.program_balance_entries e
  where e.commission_id = (pg_temp.com(k)).id and e.kind = p_kind
$$;
create function pg_temp.credited(k text, p_kind text) returns text language sql as $$
  select count(*) || 'x' || coalesce(sum(e.amount_minor), 0) from public.program_creator_entries e
  where e.commission_id = (pg_temp.com(k)).id and e.kind = p_kind
$$;
-- What was paid back to the merchant from the creator's later earnings for this commission.
create function pg_temp.recovered(k text) returns text language sql as $$
  select count(*) || 'x' || coalesce(sum(e.amount_minor), 0) from public.program_balance_entries e
  where e.commission_id = (pg_temp.com(k)).id and e.kind = 'commission_returned'
    and e.note = 'Refund recovered from the creator''s later earnings'
$$;

-- Payouts ----------------------------------------------------------------------------------------
create function pg_temp.payout(k text) returns public.program_payouts language sql as $$
  select p from public.program_payouts p where p.id = pg_temp.q(k)
$$;
create function pg_temp.panel() returns jsonb language sql as $$
  select pg_temp.call('kma_finance', 'select public.get_admin_program_payouts()')
$$;
create function pg_temp.listed(creator text) returns jsonb language sql as $$
  select c from jsonb_array_elements(pg_temp.panel()->'creators') c
  where c->>'affiliate_id' = pg_temp.q('creator_' || creator)::text and c->>'currency' = 'USD'
$$;
create function pg_temp.act_sql(input jsonb) returns text language sql as $$
  select format('select public.perform_admin_program_payout(%L)', input)
$$;
create function pg_temp.pay_sql(creator text, amount bigint) returns text language sql as $$
  select pg_temp.act_sql(jsonb_build_object('action', 'pay', 'affiliate_id', pg_temp.q('creator_' || creator),
    'currency', 'USD', 'expected_amount_minor', amount))
$$;
-- KissMyApps finance pays the creator what they can be paid now.
create function pg_temp.make_payout(k text, creator text, amount bigint) returns void language plpgsql as $$
begin
  perform pg_temp.call('kma_finance', pg_temp.pay_sql(creator, amount));
  insert into qa select k, p.id from public.program_payouts p
  where p.affiliate_id = pg_temp.q('creator_' || creator) and p.status = 'approved';
end $$;
-- ... and the worker claims it, begins it and Stripe pays it.
create function pg_temp.pay(k text, creator text, amount bigint) returns void language plpgsql as $$
declare v_ref jsonb;
begin
  perform pg_temp.make_payout(k, creator, amount);
  perform pg_temp.svc('claim_program_payouts', '{"platform_account_id":"acct_KMAPlatform","limit":25}');
  v_ref := (select jsonb_build_object('payout_id', p.id, 'lease_token', p.lease_token) from pg_temp.payout(k) p);
  perform pg_temp.svc('begin_program_payout', v_ref || '{"connect_account_id":"acct_AdaPay"}');
  perform pg_temp.svc('finish_program_payout', v_ref || jsonb_build_object('outcome', 'paid', 'transfer_id', 'tr_' || k));
end $$;
create function pg_temp.items(k text) returns text language sql as $$
  select string_agg(p.name || ' ' || i.amount_minor, '; ' order by p.name) from public.program_payout_items i
  join public.affiliate_programs p on p.id = i.program_id where i.payout_id = pg_temp.q(k)
$$;

-- Locks ------------------------------------------------------------------------------------------
create function pg_temp.holds(lock_name text, creator text, workspace text) returns boolean language sql as $$
  select exists (select 1 from pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted
      and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(lock_name || ':'
        || (pg_temp.program(workspace)).id::text || ':' || pg_temp.q('creator_' || creator)::text, 0))
$$;

-- The books --------------------------------------------------------------------------------------
-- Every balance is the sum of its entries; every commission's balance entries add up to minus
-- what it holds and what it still owes back, and its entries on the creator's sum to what it
-- holds once approved; what a merchant paid in is what is available plus what commissions
-- hold or still owe back; per creator and program, what refunds still owe back is exactly how
-- far the sum is below zero; and the engine's own checks agree.
create function pg_temp.books() returns boolean language plpgsql as $$
declare r record;
begin
  for r in select distinct e.program_id, e.affiliate_id from public.program_creator_entries e loop
    perform kma_internal.program_creator_recovery_check(r.program_id, r.affiliate_id);
  end loop;
  for r in select c.id, c.sale_id from public.program_commissions c loop
    if r.sale_id is not null then
      perform kma_internal.program_commission_check(r.sale_id);
    else
      perform kma_internal.program_reward_commission_check(r.id);
    end if;
  end loop;
  return (select coalesce(bool_and(a.available_minor = coalesce((select sum(e.amount_minor)
        from public.program_balance_entries e where e.account_id = a.id), 0)), true)
      from public.program_balance_accounts a)
    and (select coalesce(bool_and(-(c.amount_minor + c.fee_minor + c.recovery_due_minor) = coalesce((select sum(e.amount_minor)
          from public.program_balance_entries e where e.commission_id = c.id), 0)
        and (case when c.status = 'approved' then c.amount_minor else 0 end) = coalesce((select sum(e.amount_minor)
          from public.program_creator_entries e where e.commission_id = c.id), 0)
        and (c.recovery_due_minor = 0 or c.status = 'approved')), true)
      from public.program_commissions c)
    and (select coalesce(bool_and(a.available_minor = coalesce((select sum(e.amount_minor)
          from public.program_balance_entries e where e.account_id = a.id and e.topup_id is not null), 0)
        - coalesce((select sum(c.amount_minor + c.fee_minor + c.recovery_due_minor) from public.program_commissions c
          where c.program_id = a.program_id), 0)), true)
      from public.program_balance_accounts a)
    and not exists (select 1 from public.program_creator_entries e group by e.affiliate_id, e.program_id
      having greatest(-sum(e.amount_minor), 0) <> (select coalesce(sum(c.recovery_due_minor), 0) from public.program_commissions c
        where c.affiliate_id = e.affiliate_id and c.program_id = e.program_id))
    and (pg_temp.service('select public.program_reward_health()')->>'ledger_mismatches')::bigint = 0
    and (pg_temp.service('select public.program_payout_health()')->>'ledger_mismatches')::bigint = 0;
end $$;

-- The agreement ----------------------------------------------------------------------------------
create function pg_temp.terms(overrides jsonb default '{}') returns jsonb language sql as $$
  select '{"program_name":"SpeakSix","brand_name":"SpeakSix Ltd","landing_url":"https://speaksix.com/start",
    "commission_type":"percent","commission_rate_bps":3000,"commission_fixed_minor":null,"currency":"USD",
    "commission_duration":"months","commission_months":12,"attribution_window_days":30,"hold_days":30,
    "minimum_payout_minor":2000,"approval_mode":"automatic","extra_terms":null,"earn_from":"sales","rewards":[]}'::jsonb || overrides
$$;
create function pg_temp.doc(overrides jsonb default '{}') returns jsonb language sql as $$
  select kma_internal.program_agreement(pg_temp.terms(overrides))
$$;
-- The paragraphs of the section with this heading (without its number).
create function pg_temp.section(document jsonb, heading text) returns jsonb language sql as $$
  select s->'paragraphs' from jsonb_array_elements(document->'sections') s where s->>'heading' ~ ('^\d+\. ' || heading || '$')
$$;
create function pg_temp.has(paragraphs jsonb, sentence text) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements_text(paragraphs) x where strpos(x, sentence) > 0)
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
grant all on qa, recovery_assertions to anon, authenticated, service_role;
grant usage on sequence pg_temp.award_events to anon, authenticated, service_role;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- People ---------------------------------------------------------------------------------------
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
  ('a9600000-0000-4000-8000-000000000001', 'owner@speaksix.example.test', now(), '{"company":"SpeakSix"}'),
  ('a9600000-0000-4000-8000-000000000002', 'owner@rival.example.test', now(), '{"company":"Rival"}'),
  ('a9600000-0000-4000-8000-000000000003', 'owner@lingot.example.test', now(), '{"company":"Lingot"}'),
  ('a9600000-0000-4000-8000-000000000004', 'owner@draft.example.test', now(), '{"company":"Draft"}'),
  ('a9600000-0000-4000-8000-000000000005', 'owner@fresh.example.test', now(), '{"company":"Fresh"}'),
  ('a9600000-0000-4000-8000-000000000011', 'owner@kissmyapps.example.test', now(), '{}'),
  ('a9600000-0000-4000-8000-000000000012', 'finance@kissmyapps.example.test', now(), '{}'),
  ('a9600000-0000-4000-8000-000000000021', 'ada@creators.example.test', now(), '{}'),
  ('a9600000-0000-4000-8000-000000000022', 'ben@creators.example.test', now(), '{}');
insert into qa values
  ('owner', 'a9600000-0000-4000-8000-000000000001'), ('rival_owner', 'a9600000-0000-4000-8000-000000000002'),
  ('euro_owner', 'a9600000-0000-4000-8000-000000000003'), ('draft_owner', 'a9600000-0000-4000-8000-000000000004'),
  ('fresh_owner', 'a9600000-0000-4000-8000-000000000005'),
  ('kma_owner', 'a9600000-0000-4000-8000-000000000011'), ('kma_finance', 'a9600000-0000-4000-8000-000000000012'),
  ('ada', 'a9600000-0000-4000-8000-000000000021'), ('ben', 'a9600000-0000-4000-8000-000000000022'),
  ('creator_ada', 'a9610000-0000-4000-8000-000000000001'), ('creator_ben', 'a9610000-0000-4000-8000-000000000002');
insert into public.admin_users(user_id, role) values (pg_temp.q('kma_owner'), 'owner'), (pg_temp.q('kma_finance'), 'finance');
insert into public.affiliates(id, public_name, legal_name, slug, status) values
  (pg_temp.q('creator_ada'), 'Ada Okafor', null, 'ada-okafor', 'active'),
  (pg_temp.q('creator_ben'), 'Ben Creator', null, 'ben-creator', 'active');
insert into public.affiliate_users(affiliate_id, user_id, role, active, activation_pending, activated_at)
  select pg_temp.q('creator_' || c), pg_temp.q(c), 'owner', true, false, now() from unnest(array['ada', 'ben']) c;
insert into public.platform_settings(singleton, tracking_base_url, tracking_enabled) values (true, 'https://go.kissmyapps.dev', true)
  on conflict (singleton) do update set tracking_base_url = excluded.tracking_base_url, tracking_enabled = true,
    program_money_enabled = false, program_fee_bps = 1000, program_min_deposit_minor = 5000,
    program_payouts_enabled = false, program_min_payout_minor = 2500;
select pg_temp.sign_in('owner');
insert into qa select 'acme', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('rival_owner');
insert into qa select 'rival', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('euro_owner');
insert into qa select 'euro', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('draft_owner');
insert into qa select 'draft', public.analytics_bootstrap()->'workspaces'->0->>'id';
select pg_temp.sign_in('fresh_owner');
insert into qa select 'fresh', public.analytics_bootstrap()->'workspaces'->0->>'id';
select set_config('request.jwt.claims', '', true);
select pg_temp.connect('acme', 'acct_SpeakSix', 'SpeakSix Ltd');
select pg_temp.connect('rival', 'acct_Rival', 'Rival Media');
select pg_temp.connect('euro', 'acct_Lingot', 'Lingot SAS');
select pg_temp.connect('draft', 'acct_Draft', 'Draft Works');

-- 1. Programs pay creators in US dollars ---------------------------------------------------------
select pg_temp.check(pg_temp.try('fresh_owner', pg_temp.save_sql('fresh', jsonb_build_object('name', 'Fresh', 'currency', v.code)))
    = '22023 invalid_input'
  and pg_temp.message('fresh_owner', pg_temp.save_sql('fresh', jsonb_build_object('name', 'Fresh', 'currency', v.code)))
    = 'Programs pay creators in US dollars for now.',
  format('a new program cannot be saved in %s', v.code))
from (values ('EUR'), ('GBP'), ('CAD'), ('AUD')) v(code);
select pg_temp.check(pg_temp.program('fresh') is null
  and pg_temp.try('fresh_owner', pg_temp.save_sql('fresh', '{"name":"Fresh","currency":"usd"}')) = '22023 invalid_currency'
  and pg_temp.try('fresh_owner', pg_temp.save_sql('fresh', '{"name":"Fresh","currency":"JPY"}')) = '22023 invalid_currency',
  'a refused save makes no program, and a currency that is not a currency is still refused as before');
select pg_temp.call('fresh_owner', pg_temp.save_sql('fresh', '{"name":"Fresh"}'));
select pg_temp.check((pg_temp.program('fresh')).currency = 'USD'
  and pg_temp.try('fresh_owner', pg_temp.save_sql('fresh', '{"currency":"USD"}')) = 'ok'
  and pg_temp.try('fresh_owner', pg_temp.save_sql('fresh', '{"currency":null}')) = 'ok'
  and pg_temp.try('fresh_owner', pg_temp.save_sql('fresh', '{"currency":"EUR"}')) = '22023 invalid_input'
  and (pg_temp.program('fresh')).currency = 'USD',
  'a program is in US dollars, saving it in US dollars or with no currency works, and it cannot move to euros');

-- A draft saved in euros before this rule keeps its euros and can be saved, but is not sent for review in them.
select pg_temp.call('draft_owner', pg_temp.save_sql('draft', '{"name":"Draft Thing","category":"education",
  "tagline":"A draft from before.","landing_url":"https://draftworks.co/start","commission_type":"percent",
  "commission_rate_bps":2000,"commission_duration":"lifetime"}'));
update public.affiliate_programs set currency = 'EUR' where workspace_id = pg_temp.q('draft');
select pg_temp.check(pg_temp.try('draft_owner', pg_temp.save_sql('draft', '{"hold_days":20}')) = 'ok'
  and pg_temp.try('draft_owner', pg_temp.save_sql('draft', '{"currency":"EUR"}')) = 'ok'
  and pg_temp.try('draft_owner', pg_temp.save_sql('draft', '{"currency":"GBP"}')) = '22023 invalid_input'
  and (select p.currency = 'EUR' and p.hold_days = 20 from pg_temp.program('draft') p),
  'a draft saved in euros before the rule keeps them: it saves in euros, and cannot move to another currency but dollars');
select pg_temp.call('draft_owner', pg_temp.read_sql('draft_owner', 'draft'));
select pg_temp.check(pg_temp.try('draft_owner', pg_temp.submit_sql('draft')) = '22023 invalid_input'
  and pg_temp.message('draft_owner', pg_temp.submit_sql('draft')) = 'Programs pay creators in US dollars for now.'
  and (pg_temp.program('draft')).status = 'draft'
  and pg_temp.fails(format('update public.affiliate_programs set status = %L where workspace_id = %L', 'live', pg_temp.q('draft')))
    = '22023 invalid_input Programs pay creators in US dollars for now.'
  and (pg_temp.program('draft')).status = 'draft',
  'a program never published is not sent for review, or made live by any path, in another currency');
select pg_temp.call('draft_owner', pg_temp.save_sql('draft', '{"currency":"USD"}'));
select pg_temp.call('draft_owner', pg_temp.read_sql('draft_owner', 'draft'));
select pg_temp.check(pg_temp.try('draft_owner', pg_temp.submit_sql('draft')) = 'ok'
  and (select p.status = 'in_review' and p.currency = 'USD' from pg_temp.program('draft') p),
  'moved to US dollars, the draft is sent for review');

-- Lingot was published in euros before the rule: it is saved in dollars, moved to euros on the
-- row, and published with the first-publish check switched off.
select pg_temp.call('euro_owner', pg_temp.save_sql('euro', '{"name":"Lingot","category":"education",
  "tagline":"Le francais en un mois.","landing_url":"https://lingot.fr/","commission_type":"percent",
  "commission_rate_bps":2500,"commission_duration":"lifetime","hold_days":14}'));
update public.affiliate_programs set currency = 'EUR' where workspace_id = pg_temp.q('euro');
alter table public.affiliate_programs disable trigger affiliate_programs_require_usd;
select pg_temp.publish('euro_owner', 'euro', '{}');
alter table public.affiliate_programs enable trigger affiliate_programs_require_usd;
select pg_temp.check((select p.status = 'live' and p.currency = 'EUR' from pg_temp.program('euro') p)
  and (pg_temp.terms_row('euro')).terms->>'currency' = 'EUR',
  'a program published in euros before the rule is live in euros');
select pg_temp.check(pg_temp.try('euro_owner', pg_temp.save_sql('euro', '{"hold_days":21}')) = 'ok'
  and pg_temp.try('euro_owner', pg_temp.save_sql('euro', '{"currency":"EUR"}')) = 'ok'
  and pg_temp.try('euro_owner', pg_temp.save_sql('euro', '{"currency":"GBP"}')) = '22023 invalid_input'
  and pg_temp.try('euro_owner', pg_temp.status_sql('euro', 'paused')) = 'ok'
  and (pg_temp.program('euro')).status = 'paused'
  and pg_temp.try('euro_owner', pg_temp.status_sql('euro', 'live')) = 'ok'
  and (pg_temp.program('euro')).status = 'live',
  'it keeps working in euros: it saves, pauses and goes live again, and cannot move to another currency');
select pg_temp.call('euro_owner', pg_temp.read_sql('euro_owner', 'euro'));
select pg_temp.check(pg_temp.try('euro_owner', pg_temp.submit_sql('euro')) = 'ok'
  and (select t.version = 2 and t.terms->>'currency' = 'EUR' and (t.terms->>'hold_days')::integer = 21
    from pg_temp.terms_row('euro') t)
  and (select p.status = 'live' and p.currency = 'EUR' from pg_temp.program('euro') p),
  'and it publishes new terms in euros');

-- 2. The agreement -------------------------------------------------------------------------------
select pg_temp.check(pg_temp.has(pg_temp.section(pg_temp.doc(), 'Commission'),
    'Commission is worked out on what the customer paid after tax and, for a purchase made in an app store, after the app store''s fee.')
  and pg_temp.section(pg_temp.doc(), 'How a sale is credited to you')->>-1
    = 'App store purchases that SpeakSix Ltd reports to KissMyApps through RevenueCat or Adapty count like any other sale. '
      || 'Only sales that KissMyApps has tracked and confirmed as paid count. A sale that cannot be traced to your link earns no commission.'
  and pg_temp.section(pg_temp.doc(), 'Hold, refunds and chargebacks')->>-1
    = 'If that happens after the commission was approved, even after it was paid out to you, the amount is taken from your '
      || 'later commission in this program. You are never billed for it.'
  and pg_temp.doc()::text !~ 'checkout your link opens|promo code',
  'a sales agreement says what commission is worked out on, that app store purchases count, and that a refund after '
    || 'approval, even after a payout, comes out of later commission and is never billed; no checkout or promo code');
select pg_temp.check(not pg_temp.has(pg_temp.section(pg_temp.doc(v.o), 'Commission'), 'worked out on')
  and pg_temp.has(pg_temp.section(pg_temp.doc(v.o), 'How a sale is credited to you'),
    format('App store purchases that %s reports to KissMyApps through RevenueCat or Adapty count like any other sale.', v.brand))
  and pg_temp.has(pg_temp.section(pg_temp.doc(v.o), 'Hold, refunds and chargebacks'), 'You are never billed for it.'),
  format('a fixed commission (%s) does not say what a share is worked out on, and says the rest', v.o))
from (values ('{"commission_type":"fixed","commission_rate_bps":null,"commission_fixed_minor":2000}'::jsonb, 'SpeakSix Ltd'),
  ('{"commission_type":"fixed","commission_rate_bps":null,"commission_fixed_minor":2000,"brand_name":null}', 'SpeakSix')) v(o, brand);
select pg_temp.check((select bool_and(jsonb_array_length(s->'paragraphs') between 1 and 4) and count(*) = 11
    from jsonb_array_elements(pg_temp.doc()->'sections') s),
  'the plain sales agreement keeps eleven sections of at most four paragraphs');
select pg_temp.check((select pg_temp.section(d, 'How a sale is credited to you')->>-1
      = 'Sales made on the checkout your link opens, and app store purchases that SpeakSix Ltd reports to KissMyApps through '
        || 'RevenueCat or Adapty, count like any other sale. Only sales that KissMyApps has tracked and confirmed as paid count. '
        || 'A sale that cannot be traced to your link earns no commission.'
      and pg_temp.has(pg_temp.section(d, 'How a sale is credited to you'),
        'A sale paid with your promo code is credited to you, even if the customer did not click your link or clicked another creator''s link.')
      and pg_temp.has(pg_temp.section(d, 'Commission'), 'worked out on what the customer paid after tax')
    from (select pg_temp.doc('{"payment_mode":"kma_checkout","checkout":{"name":"Fluent Pro","amount_minor":999,"interval":"month"},
      "buyer_discount_bps":1000}') as d) x),
  'a checkout-link program with a buyer discount says that checkout sales and app store purchases count like any other '
    || 'sale and that a promo code sale is the code''s creator''s over any link');
select pg_temp.check(pg_temp.has(pg_temp.section(pg_temp.doc('{"buyer_discount_bps":1000}'), 'How a sale is credited to you'),
    'A sale paid with your promo code is credited to you')
  and pg_temp.doc('{"buyer_discount_bps":1000}')::text !~ 'checkout your link opens',
  'a promo code without a checkout link has the code rule and no checkout sentence');
select pg_temp.check((select pg_temp.has(pg_temp.section(d, 'Commission'), 'worked out on what the customer paid after tax')
      and pg_temp.has(pg_temp.section(d, 'How a sale is credited to you'), 'App store purchases that SpeakSix Ltd reports')
      and pg_temp.section(d, 'Hold, refunds and chargebacks')->>-1
        = 'If that happens after the commission was approved, even after it was paid out to you, the amount is taken from '
          || 'what you earn later in this program. You are never billed for it.'
    from (select pg_temp.doc('{"earn_from":"both","rewards":[{"key":"chapter_read","label":"First chapter read","amount_minor":150}]}') as d) x),
  'a program that pays for sales and events says the same about sales');
select pg_temp.check(pg_temp.doc('{"commission_type":null,"commission_rate_bps":null,"commission_duration":null,"commission_months":null,
    "earn_from":"events","rewards":[{"key":"chapter_read","label":"First chapter read","amount_minor":150}]}')::text
    !~ 'worked out on|App store purchases|never billed|checkout your link opens|promo code',
  'a program that pays for events only has no sales, so none of it is in its agreement');

-- 3. Refund carry-over ------------------------------------------------------------------------------
-- SpeakSix pays 30% and Rival Reader 20%, for every payment; KissMyApps takes 10% on top.
select pg_temp.publish('owner', 'acme', '{"name":"SpeakSix","category":"education","tagline":"Speak English in six weeks.",
  "landing_url":"https://speaksix.com/start","commission_type":"percent","commission_rate_bps":3000,
  "commission_duration":"lifetime"}');
select pg_temp.publish('rival_owner', 'rival', '{"name":"Rival Reader","category":"entertainment","tagline":"Stories worth an evening.",
  "landing_url":"https://rivalreader.co/","commission_type":"percent","commission_rate_bps":2000,
  "commission_duration":"lifetime","hold_days":14}');
select pg_temp.check((select p.status = 'live' and p.currency = 'USD' from pg_temp.program('acme') p)
  and pg_temp.has(pg_temp.section((pg_temp.terms_row('acme')).agreement, 'Hold, refunds and chargebacks'), 'You are never billed for it.')
  and pg_temp.has(pg_temp.section((pg_temp.terms_row('acme')).agreement, 'Commission'), 'worked out on what the customer paid'),
  'a program published now carries the new wording in the terms creators accept');
select pg_temp.check(pg_temp.join(j.creator, j.workspace)->'membership'->>'status' = 'active',
  format('%s joins %s', j.creator, j.workspace))
from (values ('ada', 'acme'), ('ada', 'rival'), ('ben', 'acme')) j(creator, workspace);
insert into qa values ('click_ada', pg_temp.click('ada', 'acme')), ('click_ben', pg_temp.click('ben', 'acme'));
update public.affiliate_program_members set activated_at = pg_temp.ago('500 days');
select set_config('request.jwt.claims', '', true);
update public.platform_settings set program_money_enabled = true where singleton;
select pg_temp.open_account('acme', 'owner'), pg_temp.open_account('rival', 'rival_owner');
select pg_temp.fund('acme', 100000), pg_temp.fund('rival', 50000);
select pg_temp.call('kma_owner', format('select public.configure_admin_program_payouts(%L)', jsonb_build_object('enabled', true,
  'expected_updated_at', (select updated_at from public.platform_settings))));
do $$
declare v_key uuid;
begin
  v_key := (pg_temp.call('ada', 'select public.program_creator_payout_context(''acct_KMAPlatform'', true)')->>'account_key')::uuid;
  perform pg_temp.svc('reserve_creator_connect_account', jsonb_build_object('account_key', v_key, 'country', 'US',
    'actor_user_id', pg_temp.q('ada')));
  perform pg_temp.svc('set_creator_connect_account', jsonb_build_object('account_key', v_key, 'affiliate_id', pg_temp.q('creator_ada'),
    'platform_account_id', 'acct_KMAPlatform', 'livemode', true, 'connect_account_id', 'acct_AdaPay', 'charges_enabled', false,
    'payouts_enabled', true, 'transfers_enabled', true, 'details_submitted', true, 'requirements_due', '[]'::jsonb,
    'verified_at', clock_timestamp()));
end $$;

select pg_temp.earn('s1', 'acme', 'ada', 10000);
select pg_temp.earn('s2', 'acme', 'ada', 10000);
select pg_temp.earn('s3', 'acme', 'ada', 5000);
select pg_temp.earn('r1', 'rival', 'ada', 5000);
select pg_temp.earn('b1', 'acme', 'ben', 10000);
select pg_temp.check(pg_temp.c('s1') = 'approved 3000+300 due 0' and pg_temp.c('s2') = 'approved 3000+300 due 0'
  and pg_temp.c('s3') = 'approved 1500+150 due 0' and pg_temp.c('r1') = 'approved 1000+100 due 0'
  and pg_temp.owed('ada', 'acme') = 7500 and pg_temp.owed('ada', 'rival') = 1000 and pg_temp.owed('ben', 'acme') = 3000
  and pg_temp.books(),
  'Ada has three approved SpeakSix commissions and one from Rival Reader; Ben has one from SpeakSix; the books balance');
-- An approval holds no creator's sum, as before, so it never waits for a payout; it takes the recovery lock.
select pg_temp.check(not pg_temp.holds('kma-program-creator', 'ben', 'acme') and pg_temp.holds('kma-program-recovery', 'ben', 'acme'),
  'approving a commission takes the creator''s recovery lock, not the lock on their sum');

-- Before approval: unchanged.
select pg_temp.sale('h1', 'acme', 'ada', 10000, now());
select pg_temp.keep('acme_before', pg_temp.available('acme')::text);
select pg_temp.refund('h1', 4000);
select pg_temp.check(pg_temp.c('h1') = 'held 1800+180 due 0' and pg_temp.moved('h1', 'commission_returned') = '1x1200'
  and pg_temp.moved('h1', 'fee_returned') = '1x120' and pg_temp.credited('h1', 'clawback') = '0x0'
  and pg_temp.owed('ada', 'acme') = 7500 and pg_temp.available('acme') = pg_temp.t('acme_before')::bigint + 1320
  and pg_temp.books(),
  'a refund in the hold works as before: the commission and its fee shrink and go back, the creator''s sum is not touched');

-- After approval, before a payout: the creator's sum covers it.
select pg_temp.keep('acme_before', pg_temp.available('acme')::text);
select pg_temp.refund('s1', 10000);
select pg_temp.check(pg_temp.c('s1') = 'approved 0+0 due 0' and pg_temp.credited('s1', 'clawback') = '1x-3000'
  and pg_temp.moved('s1', 'commission_returned') = '1x3000' and pg_temp.moved('s1', 'fee_returned') = '1x300'
  and pg_temp.owed('ada', 'acme') = 4500 and pg_temp.available('acme') = pg_temp.t('acme_before')::bigint + 3300
  and pg_temp.books(),
  'a refund after approval is taken from the creator''s sum; the commission and the fee go back to the merchant at once');

-- Ada is paid everything she has: 45.00 from SpeakSix and 10.00 from Rival Reader.
select pg_temp.pay('p1', 'ada', 5500);
select pg_temp.check((pg_temp.payout('p1')).status = 'paid' and pg_temp.items('p1') = 'Rival Reader 1000; SpeakSix 4500'
  and pg_temp.owed('ada', 'acme') = 0 and pg_temp.owed('ada', 'rival') = 0 and pg_temp.books(),
  'Ada is paid 55.00 and has nothing left in either program');
select pg_temp.earn('s4', 'acme', 'ada', 2000);
select pg_temp.check(pg_temp.c('s4') = 'approved 600+60 due 0' and pg_temp.owed('ada', 'acme') = 600 and pg_temp.books(),
  'she earns 6.00 more from SpeakSix');

-- After a payout: the sum goes below zero; the merchant gets back what it covered, and the fee.
select pg_temp.keep('acme_before', pg_temp.available('acme')::text);
insert into qa select 'rival_entries', pg_temp.entries('rival');
select pg_temp.refund('s2', 10000);
select pg_temp.check(pg_temp.c('s2') = 'approved 0+0 due 2400' and pg_temp.credited('s2', 'clawback') = '1x-3000'
  and pg_temp.moved('s2', 'commission_returned') = '1x600' and pg_temp.moved('s2', 'fee_returned') = '1x300'
  and pg_temp.owed('ada', 'acme') = -2400 and pg_temp.due('ada', 'acme') = 2400
  and pg_temp.available('acme') = pg_temp.t('acme_before')::bigint + 600 + 300
  and (pg_temp.payout('p1')).status = 'paid' and pg_temp.books(),
  'a refund after the payout takes the whole 30.00: the merchant gets back the 6.00 she still had and the 3.00 fee now, '
    || 'and 24.00 is owed back from what she earns later');
select pg_temp.refund('s3', 2500);
select pg_temp.check(pg_temp.c('s3') = 'approved 750+75 due 750' and pg_temp.credited('s3', 'clawback') = '1x-750'
  and pg_temp.moved('s3', 'commission_returned') = '0x0' and pg_temp.moved('s3', 'fee_returned') = '1x75'
  and pg_temp.owed('ada', 'acme') = -3150 and pg_temp.due('ada', 'acme') = 3150 and pg_temp.books(),
  'half of another paid-out sale refunded: with nothing left to take from, all of it is owed back and only the fee goes back');
select pg_temp.check(pg_temp.owed('ada', 'rival') = 0 and pg_temp.due('ada', 'rival') = 0
  and pg_temp.entries('rival') = pg_temp.t('rival_entries')::bigint
  and pg_temp.owed('ben', 'acme') = 3000 and pg_temp.c('b1') = 'approved 3000+300 due 0',
  'her Rival Reader sum and Ben''s SpeakSix sum are not touched');
select pg_temp.check((pg_temp.line('ada', 'SpeakSix')->>'approved_minor')::bigint = 0
  and (pg_temp.line('ada', 'Rival Reader')->>'approved_minor')::bigint = 0
  and pg_temp.listed('ada') is null and (pg_temp.listed('ben')->>'payable_minor')::bigint = 3000
  and (pg_temp.call('kma_owner', 'select public.get_admin_program_money()')->'owed_to_creators_minor_by_currency'->>'USD')::bigint
    = 3000
  and (select sum(e.amount_minor) from public.program_creator_entries e) = 3000 - 3150
  and pg_temp.try('kma_finance', pg_temp.pay_sql('ada', 1)) = '22023 amount_changed',
  'no read shows a negative amount: Ada has nothing to be paid, is not on the payout panel and cannot be paid; what '
    || 'creators are owed counts only sums above zero');

-- A new sale pays the merchant back, oldest refund first.
select pg_temp.sale('s5', 'acme', 'ada', 4000, pg_temp.ago('40 days'));
select pg_temp.keep('acme_before', pg_temp.available('acme')::text);
select pg_temp.check(pg_temp.tick() @> '{"approved":1}', 'the tick approves her next sale');
select pg_temp.check(pg_temp.c('s5') = 'approved 1200+120 due 0' and pg_temp.credited('s5', 'commission_approved') = '1x1200'
  and pg_temp.c('s2') = 'approved 0+0 due 1200' and pg_temp.recovered('s2') = '1x1200'
  and pg_temp.c('s3') = 'approved 750+75 due 750' and pg_temp.recovered('s3') = '0x0'
  and pg_temp.owed('ada', 'acme') = -1950 and pg_temp.available('acme') = pg_temp.t('acme_before')::bigint + 1200
  and pg_temp.books(),
  'its 12.00 goes to the merchant against the oldest refund still owed, and her sum is 12.00 less below zero');

-- A reward approved does the same, across two refunds.
select pg_temp.reward('w1', 'acme', 'ada', 1500);
select pg_temp.keep('acme_before', pg_temp.available('acme')::text);
select pg_temp.check(pg_temp.rewards_tick() @> '{"approved":1}', 'the rewards tick approves her reward');
select pg_temp.check(pg_temp.c('w1') = 'approved 1500+150 due 0'
  and pg_temp.c('s2') = 'approved 0+0 due 0' and pg_temp.recovered('s2') = '2x2400'
  and pg_temp.c('s3') = 'approved 750+75 due 450' and pg_temp.recovered('s3') = '1x300'
  and pg_temp.owed('ada', 'acme') = -450 and pg_temp.available('acme') = pg_temp.t('acme_before')::bigint + 1500
  and pg_temp.books(),
  'its 15.00 pays off the rest of the first refund and 3.00 of the second, oldest first');

-- Another program of the same creator is paid; the one below zero is left out.
select pg_temp.earn('r2', 'rival', 'ada', 15000);
select pg_temp.check(pg_temp.c('r2') = 'approved 3000+300 due 0' and pg_temp.owed('ada', 'rival') = 3000
  and pg_temp.owed('ada', 'acme') = -450 and pg_temp.due('ada', 'acme') = 450 and pg_temp.due('ada', 'rival') = 0
  and (select count(*) = 0 from public.program_balance_entries e where e.account_id = (pg_temp.account('rival')).id
    and e.kind = 'commission_returned')
  and (pg_temp.listed('ada')->>'payable_minor')::bigint = 3000
  and pg_temp.listed('ada')->'programs' = jsonb_build_array(jsonb_build_object('name', 'Rival Reader',
    'program_id', (pg_temp.program('rival')).id, 'amount_minor', 3000))
  and pg_temp.books(),
  'a Rival Reader sale is hers to be paid: nothing of it goes to SpeakSix''s refunds, and she can be paid 30.00 from Rival Reader only');
select pg_temp.pay('p2', 'ada', 3000);
select pg_temp.check((pg_temp.payout('p2')).status = 'paid' and pg_temp.items('p2') = 'Rival Reader 3000'
  and pg_temp.owed('ada', 'rival') = 0 and pg_temp.owed('ada', 'acme') = -450 and pg_temp.books(),
  'the payout pays the program above zero and skips the one below');

-- A payout given back pays refunds owed in its program.
select pg_temp.earn('s6', 'acme', 'ada', 15000);
select pg_temp.check(pg_temp.c('s6') = 'approved 4500+450 due 0' and pg_temp.c('s3') = 'approved 750+75 due 0'
  and pg_temp.recovered('s3') = '2x750' and pg_temp.owed('ada', 'acme') = 4050 and pg_temp.books(),
  'her next SpeakSix sale pays off the last 4.50 owed, and 40.50 is hers');
select pg_temp.make_payout('p3', 'ada', 4050);
select pg_temp.check((pg_temp.payout('p3')).status = 'approved' and pg_temp.items('p3') = 'SpeakSix 4050'
  and pg_temp.owed('ada', 'acme') = 0, 'a payout of the 40.50 is made');
select pg_temp.refund('s5', 4000);
select pg_temp.check(pg_temp.c('s5') = 'approved 0+0 due 1200' and pg_temp.moved('s5', 'commission_returned') = '0x0'
  and pg_temp.moved('s5', 'fee_returned') = '1x120' and pg_temp.owed('ada', 'acme') = -1200 and pg_temp.books(),
  'a refund while the payout is under way: what the payout took is no longer in her sum, so all of it is owed back');
select pg_temp.keep('acme_before', pg_temp.available('acme')::text);
select pg_temp.call('kma_owner', pg_temp.act_sql(jsonb_build_object('action', 'cancel', 'payout_id', pg_temp.q('p3'))));
select pg_temp.check((pg_temp.payout('p3')).status = 'canceled'
  and (select count(*) = 1 and sum(e.amount_minor) = 4050 from public.program_creator_entries e
    where e.payout_id = pg_temp.q('p3') and e.kind = 'payout_reversed')
  and pg_temp.c('s5') = 'approved 0+0 due 0' and pg_temp.recovered('s5') = '1x1200'
  and pg_temp.owed('ada', 'acme') = 2850 and pg_temp.available('acme') = pg_temp.t('acme_before')::bigint + 1200
  and pg_temp.books(),
  'the payout is canceled: the money comes back to her sum, and 12.00 of it pays the merchant back first');
select pg_temp.check(pg_temp.holds('kma-program-creator', 'ada', 'acme') and pg_temp.holds('kma-program-recovery', 'ada', 'acme')
  and not pg_temp.holds('kma-program-creator', 'ben', 'acme'),
  'refunds, payouts and their reversal held Ada''s sum and her recovery lock; nobody touched Ben''s sum');

-- At the end -------------------------------------------------------------------------------------
select pg_temp.check(pg_temp.books()
  and (select sum(e.amount_minor) from public.program_balance_entries e
      where e.kind = 'commission_returned' and e.note = 'Refund recovered from the creator''s later earnings')
    = 1200 + 1500 + 450 + 1200
  and (select coalesce(sum(c.recovery_due_minor), 0) from public.program_commissions c) = 0
  and not exists (select 1 from public.program_creator_entries e group by e.affiliate_id, e.program_id having sum(e.amount_minor) < 0)
  and (select bool_and(s.status in ('paid', 'refunded', 'partially_refunded')) from public.program_sales s),
  'everything that was owed back has been paid back from later earnings, exactly once, and the books balance');

select 'ok ' || count(*) || ' program refund recovery assertions' from recovery_assertions;
rollback;
