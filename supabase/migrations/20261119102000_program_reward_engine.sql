-- Affiliate self-serve, Phase 6: the reward engine.
--
-- A program can pay creators for events a person does on the merchant's site. This file
-- is what turns such an event into money:
--
--   1. program_reward_events lists, per analytics project, the event names a published
--      program pays for. It is rebuilt whenever a program is published, changes its terms or
--      stops, and when a workspace gets a new project.
--   2. A trigger on analytics_events puts a production event with one of those names on
--      program_reward_queue. It is one key lookup, and it can never fail the event.
--   3. program_rewards_tick, run every minute by pg_cron, judges the queued events (who, if
--      anyone, earns the reward) and approves the rewards whose hold has passed.
--   4. The merchant reads workspace_program_rewards and can take a reward back during its
--      hold with workspace_program_reward_reject.
--
-- A reward that earns is a row in program_reward_awards with a commission of its own
-- (program_commissions.award_id). The money moves exactly as it does for a sale: the reward
-- and the KissMyApps fee are set aside from the merchant's balance when it is earned, both
-- or neither; a rejection gives both back; after the hold the reward is the creator's and
-- is paid out with everything else they are owed.
--
-- Locks, always in this order: the queue row or the award, its commission, the balance, and
-- last the program (only to pause it). Nothing here takes from what a creator is owed, so
-- the creator's sum (kma_internal.program_creator_lock) is never locked here; a later change
-- that needs it takes it after the commission and before the balance.
--
-- Nothing here acts while platform_settings.program_money_enabled is false. No person,
-- session or event id, and no email, is in anything a merchant or a creator reads.
--
-- Callers tell failures apart by the DETAIL of the error, one short code: invalid_input,
-- not_rejectable: SQLSTATE 22023. A workspace role that is too low gets the repo's 42501
-- with no DETAIL (P0002 for a workspace the caller is not in).
begin;

-- Reading the terms --------------------------------------------------------------------------

-- The rewards of a terms snapshot, in the merchant's order: [{key, label, amount_minor}],
-- read with kma_internal.program_terms_rewards (empty for terms that pay for sales only and
-- for terms from before Phase 6). An item that is not a whole reward is left out, so
-- nothing after this has to doubt what it reads.
create function kma_internal.program_reward_list(p_terms jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', r->>'key', 'label', btrim(r->>'label'),
      'amount_minor', (r->>'amount_minor')::bigint) order by n), '[]'::jsonb)
  from jsonb_array_elements(coalesce(kma_internal.program_terms_rewards(p_terms), '[]'::jsonb)) with ordinality x(r, n)
  where case when jsonb_typeof(r) = 'object' and jsonb_typeof(r->'key') = 'string'
      and jsonb_typeof(r->'label') = 'string' and jsonb_typeof(r->'amount_minor') = 'number'
      and (r->>'amount_minor') ~ '^[0-9]{1,9}$'
    then (r->>'key') ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$' and length(btrim(r->>'label')) between 1 and 40
      and (r->>'amount_minor')::bigint between 1 and 100000000
    else false end
$$;

-- One reward of a terms snapshot by its event name, or null.
create function kma_internal.program_reward_of(p_terms jsonb, p_key text) returns jsonb
language sql immutable set search_path = '' as $$
  select r from jsonb_array_elements(kma_internal.program_reward_list(p_terms)) with ordinality x(r, n)
  where r->>'key' = p_key order by n limit 1
$$;

-- What one creator can earn in rewards in one day: a share of the monthly budget, and
-- never less than the largest reward, so a small budget still lets a reward through.
create function kma_internal.program_reward_daily_cap(p_budget_minor bigint, p_rewards jsonb) returns bigint
language sql stable set search_path = '' as $$
  select greatest(
    div(p_budget_minor::numeric * coalesce(
      (select s.program_reward_daily_share_bps from public.platform_settings s where s.singleton), 1000), 10000)::bigint,
    (select max((r->>'amount_minor')::bigint) from jsonb_array_elements(p_rewards) r))
  where p_budget_minor is not null
$$;

-- What a person reads for an award, from its status and its commission's.
create function kma_internal.program_reward_status(p_award_status text, p_commission_status text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_award_status = 'not_earned' then 'not_counted'
    when p_award_status = 'rejected' then 'rejected'
    when p_commission_status = 'approved' then 'approved'
    else 'pending' end
$$;

-- Which events a program pays for ----------------------------------------------------------------

-- One sync of a workspace's rows at a time. A program going live and a project being added
-- each take it before they look, so whichever comes second sees what the first did.
create function kma_internal.program_reward_events_lock(p_workspace uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('kma-program-reward-events:' || p_workspace::text, 0))
$$;

-- Rebuilds program_reward_events for one program, or for all: a live or paused program
-- whose published terms have rewards gets one row per project of its workspace and reward.
create function kma_internal.program_reward_events_sync(p_program uuid default null) returns void
language plpgsql volatile set search_path = '' as $$
declare r record;
begin
  for r in
    select p.id, p.workspace_id from public.affiliate_programs p
    where p.id = p_program
      or (p_program is null and (p.status in ('live', 'paused')
        or exists (select 1 from public.program_reward_events e where e.program_id = p.id)))
    order by p.workspace_id, p.id
  loop
    perform kma_internal.program_reward_events_lock(r.workspace_id);
    delete from public.program_reward_events e
    where e.program_id = r.id and not exists (
      select 1 from public.affiliate_programs p
      join public.affiliate_program_terms t on t.program_id = p.id and t.version = p.live_terms_version
      join public.analytics_projects pr on pr.workspace_id = p.workspace_id
      cross join lateral jsonb_array_elements(kma_internal.program_reward_list(t.terms)) w
      where p.id = r.id and p.status in ('live', 'paused') and pr.id = e.project_id and w->>'key' = e.event_name);
    insert into public.program_reward_events(project_id, event_name, program_id)
    select pr.id, w->>'key', p.id
    from public.affiliate_programs p
    join public.affiliate_program_terms t on t.program_id = p.id and t.version = p.live_terms_version
    join public.analytics_projects pr on pr.workspace_id = p.workspace_id
    cross join lateral jsonb_array_elements(kma_internal.program_reward_list(t.terms)) w
    where p.id = r.id and p.status in ('live', 'paused')
    on conflict (project_id, event_name) do update set program_id = excluded.program_id
      where public.program_reward_events.program_id is distinct from excluded.program_id;
  end loop;
end $$;

-- The moments the rows can change: a program starts or stops being published, or publishes
-- new terms; a workspace gets a project. The rows come second to what set the trigger off:
-- a failure here is reported as a warning, public.program_reward_health() shows that the
-- rows are out of step, and kma_internal.program_reward_events_sync() puts them right.
create function kma_internal.program_reward_events_on_program() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform kma_internal.program_reward_events_sync(new.id);
  exception when others then
    raise warning 'The reward events of program % were not brought up to date: %', new.id, sqlerrm;
  end;
  return null;
end $$;
create trigger affiliate_programs_reward_events_insert
  after insert on public.affiliate_programs
  for each row when (new.status in ('live', 'paused'))
  execute function kma_internal.program_reward_events_on_program();
-- Pausing and resuming change nothing: a paused program keeps its rows, so its events are
-- still judged (and earn nothing while it is paused).
create trigger affiliate_programs_reward_events_update
  after update of status, live_terms_version on public.affiliate_programs
  for each row when (
    (old.status in ('live', 'paused')) is distinct from (new.status in ('live', 'paused'))
    or old.live_terms_version is distinct from new.live_terms_version)
  execute function kma_internal.program_reward_events_on_program();

create function kma_internal.program_reward_events_on_project() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  begin
    perform kma_internal.program_reward_events_lock(new.workspace_id);
    for r in select p.id from public.affiliate_programs p
      where p.workspace_id = new.workspace_id and p.status in ('live', 'paused')
    loop
      perform kma_internal.program_reward_events_sync(r.id);
    end loop;
  exception when others then
    raise warning 'The reward events of project % were not made: %', new.id, sqlerrm;
  end;
  return null;
end $$;
create trigger analytics_projects_reward_events
  after insert on public.analytics_projects
  for each row execute function kma_internal.program_reward_events_on_project();

-- The event intake ---------------------------------------------------------------------------------

-- Puts a production event a program pays for on the queue. For every other event this is
-- one lookup by primary key in a table of a few rows. Whatever goes wrong in here is
-- swallowed: an event is never lost or refused because of rewards. An event that arrives
-- while program money is switched off is not queued, and so never rewarded, the way a sale
-- recorded while it was off is never judged.
create function kma_internal.program_reward_event_queue() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if exists (select 1 from public.program_reward_events r
        where r.project_id = new.project_id and r.event_name = new.name)
      and kma_internal.program_money_enabled() then
      insert into public.program_reward_queue(event_id, project_id, event_name, person_id, session_id, occurred_at)
      values (new.id, new.project_id, new.name, new.person_id, new.session_id, new.occurred_at)
      on conflict (event_id) do nothing;
    end if;
  exception when others then
    null;
  end;
  return null;
end $$;
create trigger analytics_events_program_rewards
  after insert on public.analytics_events
  for each row when (new.environment = 'production')
  execute function kma_internal.program_reward_event_queue();

-- A reward's money ---------------------------------------------------------------------------------

-- Raises unless a reward's commission agrees with its entries and its award: the merchant's
-- balance entries for it add up to exactly what it has set aside now, the creator's entries
-- to exactly what was approved, and the award says the same as the commission (earned while
-- it is held or approved, rejected once it went back). Run at the end of every change of a
-- reward's commission, inside the same transaction, so a change that would break this is
-- undone as a whole.
create function kma_internal.program_reward_commission_check(p_commission uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  c public.program_commissions;
  a public.program_reward_awards;
  v_balance bigint;
  v_creator bigint;
begin
  select * into c from public.program_commissions x where x.id = p_commission and x.award_id is not null;
  if not found then
    return;
  end if;
  select * into a from public.program_reward_awards w where w.id = c.award_id;
  select coalesce(sum(e.amount_minor), 0) into v_balance
  from public.program_balance_entries e where e.commission_id = c.id;
  select coalesce(sum(e.amount_minor), 0) into v_creator
  from public.program_creator_entries e where e.commission_id = c.id;
  if v_balance <> -(c.amount_minor + c.fee_minor)
    or v_creator <> (case when c.status = 'approved' then c.amount_minor else 0 end)
    or a.status is distinct from (case when c.status in ('held', 'approved') then 'earned'
      when c.status = 'reversed' then 'rejected' end)
    or (c.status in ('held', 'approved') and c.amount_minor <> a.amount_minor)
    or c.program_id <> a.program_id or c.affiliate_id <> a.affiliate_id then
    raise exception 'Reward commission % does not agree with its entries', c.id
      using errcode = 'P0001', detail = 'commission_out_of_balance';
  end if;
end $$;

-- Two events of one program are never judged for budget at the same time.
create function kma_internal.program_reward_lock(p_program uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('kma-program-rewards:' || p_program::text, 0))
$$;

-- Judging one event ---------------------------------------------------------------------------------

-- Judges one queued event and writes what came of it. Returns 'none' (nothing is written:
-- no program pays for it any more, or no creator sent the person), 'not_earned' (an award
-- that counts for nothing, with its reason) or 'earned' (an award and its commission, set
-- aside from the balance). The caller holds the queue row and removes it. Raises on
-- anything unexpected; the caller notes the failure and tries again later.
create function kma_internal.program_reward_judge(q public.program_reward_queue) returns text
language plpgsql volatile set search_path = '' as $$
declare
  a public.program_reward_awards;
  p public.affiliate_programs;
  m public.affiliate_program_members;
  v_account public.program_balance_accounts;
  v_person uuid;
  v_published jsonb;
  v_listed jsonb;
  v_terms jsonb;
  v_reward jsonb;
  v_window integer;
  v_click record;
  v_email text;
  v_budget bigint;
  v_used bigint;
  v_cap bigint;
  v_from timestamptz;
  v_fee_bps integer;
  v_fee bigint;
  v_commission uuid := gen_random_uuid();
  v_detail text;
  v_short boolean := false;
begin
  -- An event is judged once.
  if exists (select 1 from public.program_reward_awards w where w.event_id = q.event_id) then
    return 'none';
  end if;

  -- 1. The program that pays for this event, and the reward as it is published now.
  select g.* into p from public.program_reward_events e
  join public.affiliate_programs g on g.id = e.program_id
  where e.project_id = q.project_id and e.event_name = q.event_name;
  if p.id is null then
    return 'none';
  end if;
  select t.terms into v_published from public.affiliate_program_terms t
  where t.program_id = p.id and t.version = p.live_terms_version;
  v_listed := kma_internal.program_reward_of(v_published, q.event_name);
  if v_listed is null then
    return 'none';
  end if;

  -- The person as analytics knows them now: a profile that was anonymous when the event
  -- arrived may since have been folded into the profile of the user it turned out to be.
  select e.person_id into v_person from public.analytics_events e where e.id = q.event_id;
  v_person := coalesce(v_person, q.person_id);

  -- 2. The last creator link of the program's product the person opened before the event.
  select c.id as click_record_id, c.affiliate_id, c.occurred_at into v_click
  from public.analytics_sessions s
  cross join lateral kma_internal.program_sale_click(p.product_id, s.creator_click) k
  join public.clicks c on c.id = k.click_record_id
  where s.person_id = v_person and s.creator_click is not null and c.occurred_at <= q.occurred_at
  order by c.occurred_at desc, c.id desc limit 1;
  if not found then
    return 'none';
  end if;

  a.id := gen_random_uuid();
  a.program_id := p.id;
  a.reward_key := q.event_name;
  a.reward_label := v_listed->>'label';
  a.amount_minor := (v_listed->>'amount_minor')::bigint;
  a.currency := coalesce(v_published->>'currency', p.currency);
  a.event_id := q.event_id;
  a.person_id := v_person;
  a.occurred_at := q.occurred_at;
  a.affiliate_id := v_click.affiliate_id;
  a.click_record_id := v_click.click_record_id;
  a.status := 'not_earned';
  a.created_at := now();

  -- 3. The creator was an active member of the program when the event happened.
  select x.* into m from public.affiliate_program_members x
  where x.program_id = p.id and x.affiliate_id = v_click.affiliate_id
    and x.activated_at <= q.occurred_at
    and ((x.ended_at is null and x.status = 'active') or x.ended_at > q.occurred_at);
  if m.id is null then
    -- Nobody's terms apply, so the published counting window decides whether the click is
    -- still worth a line in the merchant's list.
    v_window := case when (v_published->>'attribution_window_days') ~ '^[0-9]{1,3}$'
      then (v_published->>'attribution_window_days')::integer else p.attribution_window_days end;
    if v_click.occurred_at < q.occurred_at - make_interval(days => v_window) then
      return 'none';
    end if;
    a.reason := 'not_a_member';
    insert into public.program_reward_awards values (a.*);
    return 'not_earned';
  end if;
  a.member_id := m.id;

  -- 4. The terms they had accepted by then; before any acceptance, the first they accepted.
  a.terms_version := coalesce(
    (select c.terms_version from public.affiliate_program_acceptances c
      where c.member_id = m.id and c.accepted_at <= q.occurred_at
      order by c.accepted_at desc, c.terms_version desc limit 1),
    (select c.terms_version from public.affiliate_program_acceptances c
      where c.member_id = m.id
      order by c.accepted_at, c.terms_version limit 1),
    m.terms_version);
  select t.terms into v_terms from public.affiliate_program_terms t
  where t.program_id = p.id and t.version = a.terms_version;
  if v_terms is null then
    raise exception 'Terms version % of program % not found', a.terms_version, p.id using errcode = 'P0002';
  end if;
  v_window := case when (v_terms->>'attribution_window_days') ~ '^[0-9]{1,3}$'
    then (v_terms->>'attribution_window_days')::integer else p.attribution_window_days end;
  if v_click.occurred_at < q.occurred_at - make_interval(days => v_window) then
    return 'none';
  end if;
  v_reward := kma_internal.program_reward_of(v_terms, q.event_name);
  if v_reward is null then
    a.reason := 'not_in_terms';
    insert into public.program_reward_awards values (a.*);
    return 'not_earned';
  end if;
  -- From here on the reward is what this creator agreed to.
  a.reward_label := v_reward->>'label';
  a.amount_minor := (v_reward->>'amount_minor')::bigint;
  a.currency := coalesce(v_terms->>'currency', p.currency);

  -- 5. Money to pay it from, in the right currency, and a program that is live.
  select b.* into v_account from public.program_balance_accounts b where b.program_id = p.id;
  if v_account.id is null then
    a.reason := 'balance_empty';
  elsif v_account.currency <> a.currency then
    a.reason := 'currency_mismatch';
  elsif (select g.status from public.affiliate_programs g where g.id = p.id) is distinct from 'live' then
    a.reason := 'program_paused';
  end if;
  if a.reason is not null then
    insert into public.program_reward_awards values (a.*);
    if a.reason = 'balance_empty' then
      perform kma_internal.program_commission_pause(p.id);
    end if;
    return 'not_earned';
  end if;

  -- 6 to 10, one event of the program at a time.
  perform kma_internal.program_reward_lock(p.id);

  -- 6. Once per person. The second test finds the person through their events, so a reward
  -- earned by a profile that has since been folded into this one still counts.
  if exists (select 1 from public.program_reward_awards w
      where w.program_id = p.id and w.reward_key = a.reward_key and w.person_id = v_person
        and w.status in ('earned', 'rejected'))
    or exists (select 1 from public.analytics_events e
      join public.program_reward_awards w on w.event_id = e.id
      where e.person_id = v_person and e.name = a.reward_key and e.id <> q.event_id
        and w.program_id = p.id and w.reward_key = a.reward_key and w.status in ('earned', 'rejected')) then
    a.reason := 'already_rewarded';
    insert into public.program_reward_awards values (a.*);
    return 'not_earned';
  end if;

  -- 7. A creator earns nothing from their own actions: the person has the email of
  -- somebody on the creator's account. The email is compared and never written anywhere.
  select lower(btrim(pe.traits->>'email')) into v_email from public.analytics_people pe where pe.id = v_person;
  if v_email is not null and v_email <> '' and exists (
    select 1 from public.affiliate_users au join auth.users u on u.id = au.user_id
    where au.affiliate_id = a.affiliate_id and lower(btrim(u.email)) = v_email) then
    a.reason := 'own_action';
    insert into public.program_reward_awards values (a.*);
    return 'not_earned';
  end if;

  -- 8. The monthly budget, in the calendar month (UTC) the event happened in.
  select g.reward_budget_minor into v_budget from public.affiliate_programs g where g.id = p.id;
  v_from := date_trunc('month', q.occurred_at at time zone 'UTC') at time zone 'UTC';
  select coalesce(sum(w.amount_minor), 0) into v_used from public.program_reward_awards w
  where w.program_id = p.id and w.status = 'earned'
    and w.occurred_at >= v_from and w.occurred_at < v_from + interval '1 month';
  if v_budget is null or v_used + a.amount_minor > v_budget then
    a.reason := 'budget_reached';
    insert into public.program_reward_awards values (a.*);
    return 'not_earned';
  end if;

  -- 9. What one creator can earn in one day (UTC).
  v_cap := kma_internal.program_reward_daily_cap(v_budget, kma_internal.program_reward_list(v_terms));
  v_from := date_trunc('day', q.occurred_at at time zone 'UTC') at time zone 'UTC';
  select coalesce(sum(w.amount_minor), 0) into v_used from public.program_reward_awards w
  where w.program_id = p.id and w.affiliate_id = a.affiliate_id and w.status = 'earned'
    and w.occurred_at >= v_from and w.occurred_at < v_from + interval '1 day';
  if v_used + a.amount_minor > v_cap then
    a.reason := 'daily_limit';
    insert into public.program_reward_awards values (a.*);
    return 'not_earned';
  end if;

  -- 10. It earns: the reward and the fee are set aside together, or not at all.
  select s.program_fee_bps into v_fee_bps from public.platform_settings s where s.singleton;
  v_fee := div(a.amount_minor::numeric * v_fee_bps, 10000)::bigint;
  begin
    a.status := 'earned';
    insert into public.program_reward_awards values (a.*);
    insert into public.program_commissions(
      id, award_id, program_id, member_id, affiliate_id, terms_version, status, currency,
      basis_minor, commission_type, commission_fixed_minor, fee_bps,
      earned_minor, amount_minor, fee_earned_minor, fee_minor, hold_until)
    values (
      v_commission, a.id, p.id, m.id, a.affiliate_id, a.terms_version, 'held', a.currency,
      a.amount_minor, 'reward', a.amount_minor, v_fee_bps,
      a.amount_minor, a.amount_minor, v_fee, v_fee,
      -- An event sent late still waits out a full hold, less a day.
      greatest(q.occurred_at, clock_timestamp() - interval '1 day')
        + make_interval(days => coalesce((v_terms->>'hold_days')::integer, p.hold_days)));
    perform kma_internal.program_balance_post(v_account.id, 'commission_reserved', -a.amount_minor, null, v_commission);
    if v_fee > 0 then
      perform kma_internal.program_balance_post(v_account.id, 'fee_reserved', -v_fee, null, v_commission);
    end if;
    perform kma_internal.program_reward_commission_check(v_commission);
  exception when raise_exception then
    -- Leaving this block undoes the award, the commission and whatever was set aside.
    get stacked diagnostics v_detail = pg_exception_detail;
    if v_detail is distinct from 'balance_insufficient' then
      raise;
    end if;
    v_short := true;
  end;
  if v_short then
    -- The balance cannot cover it: it earns nothing and the program pauses.
    a.status := 'not_earned';
    a.reason := 'balance_empty';
    insert into public.program_reward_awards values (a.*);
    perform kma_internal.program_commission_pause(p.id);
    return 'not_earned';
  end if;
  return 'earned';
end $$;

-- The tick -----------------------------------------------------------------------------------------

-- Run every minute by pg_cron, as the service role or the database owner. Judges the queued
-- events that are due, each on its own: one that fails is noted with the SQLSTATE and tried
-- again after 1, 2, 4 ... minutes, at most every 6 hours, and the others go on. Then
-- approves the held rewards whose hold has passed, which writes the creator's entry, as the
-- sales tick does for a sale. Safe to run again; a second call while one is running
-- returns at once.
-- Input: {"limit": 1..1000} (default 500), for each of the two parts.
-- Output: {"judged", "earned", "approved", "remaining"}.
create function public.program_rewards_tick(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_input jsonb := coalesce(p_input, '{}'::jsonb);
  v_limit integer;
  v_now timestamptz := clock_timestamp();
  v_judged integer := 0;
  v_earned integer := 0;
  v_approved integer := 0;
  v_remaining bigint;
  v_outcome text;
  v_code text;
  q public.program_reward_queue;
  c public.program_commissions;
  r record;
begin
  if jsonb_typeof(v_input) <> 'object'
    or exists (select 1 from jsonb_object_keys(v_input) k where k <> 'limit')
    or (v_input ? 'limit' and (jsonb_typeof(v_input->'limit') <> 'number' or v_input->>'limit' !~ '^[0-9]{1,4}$'
      or (v_input->>'limit')::integer not between 1 and 1000)) then
    perform kma_internal.program_fail('invalid_input', 'The tick takes a limit from 1 to 1000');
  end if;
  v_limit := coalesce((v_input->>'limit')::integer, 500);
  if not kma_internal.program_money_enabled() then
    return jsonb_build_object('judged', 0, 'earned', 0, 'approved', 0, 'remaining', 0);
  end if;

  if pg_try_advisory_xact_lock(hashtextextended('kma-program-rewards-tick', 0)) then
    for q in
      select w.* from public.program_reward_queue w
      where w.next_attempt_at <= v_now
      order by w.next_attempt_at, w.event_id limit v_limit
      for update skip locked
    loop
      v_outcome := null;
      begin
        v_outcome := kma_internal.program_reward_judge(q);
        delete from public.program_reward_queue where event_id = q.event_id;
      exception when others then
        -- Everything done for this event is undone; the others go on.
        get stacked diagnostics v_code = returned_sqlstate;
        v_outcome := null;
        begin
          update public.program_reward_queue set
            attempts = attempts + 1, last_error = coalesce(v_code, 'XX000'),
            next_attempt_at = clock_timestamp() + make_interval(mins => least(360, power(2, least(attempts, 10))::integer))
          where event_id = q.event_id;
        exception when others then
          null;
        end;
      end;
      if v_outcome is not null then
        v_judged := v_judged + 1;
        if v_outcome = 'earned' then
          v_earned := v_earned + 1;
        end if;
      end if;
    end loop;

    for r in
      select x.id, x.award_id from public.program_commissions x
      where x.status = 'held' and x.award_id is not null and x.hold_until <= v_now
      order by x.hold_until, x.id limit v_limit
    loop
      begin
        -- The award first, then its commission, like a rejection. One that is being
        -- rejected right now is left to that.
        perform 1 from public.program_reward_awards w where w.id = r.award_id for no key update skip locked;
        if not found then
          continue;
        end if;
        select * into c from public.program_commissions x where x.id = r.id for no key update;
        if c.status = 'held' and c.hold_until <= clock_timestamp() then
          update public.program_commissions set status = 'approved', approved_at = v_now, updated_at = v_now
          where id = c.id;
          insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, commission_id)
          values (c.affiliate_id, c.program_id, c.currency, 'commission_approved', c.amount_minor, c.id);
          perform kma_internal.program_reward_commission_check(c.id);
          v_approved := v_approved + 1;
        end if;
      exception when others then
        -- Undone as a whole and left held: the next tick tries it again.
        null;
      end;
    end loop;
  end if;

  v_now := clock_timestamp();
  select (select count(*) from public.program_reward_queue w where w.next_attempt_at <= v_now)
    + (select count(*) from public.program_commissions x
      where x.status = 'held' and x.award_id is not null and x.hold_until <= v_now)
    into v_remaining;
  return jsonb_build_object('judged', v_judged, 'earned', v_earned, 'approved', v_approved, 'remaining', v_remaining);
end $$;

-- What a merchant does -------------------------------------------------------------------------------

-- The merchant takes rewards back during their hold. Each must be a reward of the
-- workspace's program that earned and is still held; one that is not refuses the whole
-- call and nothing changes. The reward and its fee go back to the balance.
-- Input: {"award_ids": [1 to 100 UUIDs], "reason": fake | duplicate | own_action |
-- low_quality | other, "note": up to 300 characters or null}.
-- Output: {"rejected": n, "returned_minor": the rewards and fees given back}.
create function public.workspace_program_reward_reject(p_workspace_id uuid, p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id, 'admin');
  p public.affiliate_programs := kma_internal.program_of(p_workspace_id);
  v_ids uuid[];
  v_left uuid[];
  v_note text;
  v_account uuid;
  v_now timestamptz := clock_timestamp();
  v_returned bigint := 0;
  a public.program_reward_awards;
  c public.program_commissions;
begin
  perform kma_internal.program_member_input(p_input, array['award_ids', 'reason', 'note']);
  if jsonb_typeof(p_input->'award_ids') is distinct from 'array'
    or jsonb_array_length(p_input->'award_ids') not between 1 and 100
    or exists (select 1 from jsonb_array_elements(p_input->'award_ids') e
      where jsonb_typeof(e) <> 'string' or kma_internal.workspace_stripe_uuid(e #>> '{}') is null) then
    perform kma_internal.program_fail('invalid_input', 'award_ids must be 1 to 100 UUIDs');
  end if;
  if jsonb_typeof(p_input->'reason') is distinct from 'string'
    or p_input->>'reason' not in ('fake', 'duplicate', 'own_action', 'low_quality', 'other') then
    perform kma_internal.program_fail('invalid_input', 'reason must be fake, duplicate, own_action, low_quality or other');
  end if;
  if jsonb_typeof(p_input->'note') not in ('string', 'null') or length(btrim(p_input->>'note')) > 300 then
    perform kma_internal.program_fail('invalid_input', 'note must be text of up to 300 characters');
  end if;
  v_note := nullif(btrim(p_input->>'note'), '');
  select array_agg(distinct kma_internal.workspace_stripe_uuid(e #>> '{}')) into v_ids
  from jsonb_array_elements(p_input->'award_ids') e;
  v_left := v_ids;

  -- The awards in one order, each before its commission.
  for a in
    select w.* from public.program_reward_awards w
    where w.id = any(v_ids) and w.program_id = p.id
    order by w.id for no key update
  loop
    select * into c from public.program_commissions x where x.award_id = a.id for no key update;
    if a.status <> 'earned' or c.id is null or c.status <> 'held' then
      perform kma_internal.program_fail('not_rejectable', 'Only rewards that are still on hold can be rejected');
    end if;
    select b.id into v_account from public.program_balance_accounts b where b.program_id = c.program_id;
    if c.amount_minor > 0 then
      perform kma_internal.program_balance_post(v_account, 'commission_returned', c.amount_minor, null, c.id);
    end if;
    if c.fee_minor > 0 then
      perform kma_internal.program_balance_post(v_account, 'fee_returned', c.fee_minor, null, c.id);
    end if;
    update public.program_commissions set
      status = 'reversed', amount_minor = 0, fee_minor = 0, reversed_at = v_now, updated_at = v_now
    where id = c.id;
    update public.program_reward_awards set
      status = 'rejected', rejected_by = auth.uid(), rejected_at = v_now,
      reject_reason = p_input->>'reason', reject_note = v_note
    where id = a.id;
    perform kma_internal.program_reward_commission_check(c.id);
    v_returned := v_returned + c.amount_minor + c.fee_minor;
    v_left := array_remove(v_left, a.id);
  end loop;
  -- Anything left names no reward of this workspace's program.
  if cardinality(v_left) > 0 then
    perform kma_internal.program_fail('not_rejectable', 'Only rewards that are still on hold can be rejected');
  end if;

  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, reason, after_data)
  values (auth.uid(), 'system', 'affiliate_program_rewards_rejected', 'affiliate_programs', p.id, p_input->>'reason',
    jsonb_build_object('award_ids', to_jsonb(v_ids), 'returned_minor', v_returned, 'note', v_note));
  return jsonb_build_object('rejected', cardinality(v_ids), 'returned_minor', v_returned);
end $$;

-- What a merchant reads -------------------------------------------------------------------------------

-- The awards of a program, with what a person reads as their status, for one creator or
-- all and one status or all. A member of another program names no creator and lists nothing.
create function kma_internal.program_reward_rows(p_program uuid, p_member uuid, p_affiliate uuid, p_status text)
returns table (award_id uuid, occurred_at timestamptz, shown text, hold_until timestamptz)
language sql stable set search_path = '' as $$
  select a.id, a.occurred_at, kma_internal.program_reward_status(a.status, x.status), x.hold_until
  from public.program_reward_awards a
  left join public.program_commissions x on x.award_id = a.id
  where a.program_id = p_program
    and (p_member is null or a.affiliate_id = p_affiliate)
    and (p_status is null or kma_internal.program_reward_status(a.status, x.status) = p_status)
$$;

-- The Rewards page: this month's budget, the rewards with this month's counts, each
-- creator's last 30 days, and the rewards themselves, newest first, a page at a time.
-- "Counts" means what it means everywhere: an award that earned and whose commission is
-- held or approved. Days and months are UTC. Nothing here names the person who did an event.
-- Input: {"limit": 1..100 (50), "before": time or null, "member_id": UUID or null,
-- "status": pending | approved | rejected | not_counted | null}.
create function public.workspace_program_rewards(p_workspace_id uuid, p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := kma_internal.analytics_require_workspace(p_workspace_id);
  v_can_manage boolean := v_role in ('owner', 'admin');
  p public.affiliate_programs := kma_internal.program_of(p_workspace_id);
  v_limit integer := 50;
  v_before timestamptz;
  v_member uuid;
  v_affiliate uuid;
  v_status text;
  v_terms jsonb;
  v_earn_from text;
  v_rewards jsonb;
  v_first text;
  v_others text[];
  v_cut timestamptz;
  v_more boolean := false;
  v_awards jsonb := '[]'::jsonb;
  v_month timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_since timestamptz := ((now() at time zone 'UTC')::date - 29)::timestamp at time zone 'UTC';
begin
  perform kma_internal.program_member_input(p_input, array['limit', 'before', 'member_id', 'status']);
  if jsonb_typeof(p_input->'limit') = 'number' and p_input->>'limit' ~ '^[0-9]{1,3}$' then
    v_limit := (p_input->>'limit')::integer;
  elsif jsonb_typeof(p_input->'limit') <> 'null' then
    v_limit := 0;
  end if;
  if v_limit not between 1 and 100 then
    perform kma_internal.program_fail('invalid_input', 'limit must be a whole number from 1 to 100');
  end if;
  if jsonb_typeof(p_input->'before') not in ('string', 'null') then
    perform kma_internal.program_fail('invalid_input', 'before must be a time');
  end if;
  begin
    v_before := (p_input->>'before')::timestamptz;
  exception when others then
    perform kma_internal.program_fail('invalid_input', 'before must be a time');
  end;
  if jsonb_typeof(p_input->'member_id') not in ('string', 'null')
    or (p_input->>'member_id' is not null and kma_internal.workspace_stripe_uuid(p_input->>'member_id') is null) then
    perform kma_internal.program_fail('invalid_input', 'member_id must be a UUID');
  end if;
  if jsonb_typeof(p_input->'status') not in ('string', 'null')
    or p_input->>'status' not in ('pending', 'approved', 'rejected', 'not_counted') then
    perform kma_internal.program_fail('invalid_input', 'status must be pending, approved, rejected or not_counted');
  end if;
  v_member := kma_internal.workspace_stripe_uuid(p_input->>'member_id');
  v_status := p_input->>'status';

  select t.terms into v_terms from public.affiliate_program_terms t
  where t.program_id = p.id and t.version = p.live_terms_version;
  v_earn_from := kma_internal.program_terms_earn_from(v_terms);
  -- No program, or one that pays for sales only. A program that used to pay for events
  -- still shows the rewards it has, so the ones on hold can be looked at and rejected.
  if p.id is null or (v_earn_from = 'sales'
    and not exists (select 1 from public.program_reward_awards a where a.program_id = p.id)) then
    return jsonb_build_object('can_manage', v_can_manage, 'program', null, 'currency', null, 'budget', null,
      'rewards', '[]'::jsonb, 'creators', '[]'::jsonb, 'awards', '[]'::jsonb, 'next_before', null);
  end if;
  v_rewards := kma_internal.program_reward_list(v_terms);
  v_first := v_rewards->0->>'key';
  select array_agg(r->>'key') into v_others from jsonb_array_elements(v_rewards) r where r->>'key' <> v_first;
  -- A member of another program matches nothing.
  select m.affiliate_id into v_affiliate from public.affiliate_program_members m
  where m.id = v_member and m.program_id = p.id;

  -- A page ends on a whole moment: awards of the same instant as its last one come with it,
  -- so the next page can start strictly before that instant and miss nothing.
  select min(q.occurred_at) into v_cut from (
    select r.occurred_at from kma_internal.program_reward_rows(p.id, v_member, v_affiliate, v_status) r
    where v_before is null or r.occurred_at < v_before
    order by r.occurred_at desc, r.award_id desc limit v_limit) q;
  v_more := exists (select 1 from kma_internal.program_reward_rows(p.id, v_member, v_affiliate, v_status) r
    where r.occurred_at < v_cut);
  select coalesce(jsonb_agg(jsonb_build_object(
      'award_id', a.id, 'occurred_at', a.occurred_at,
      'member_id', (select m.id from public.affiliate_program_members m
        where m.program_id = a.program_id and m.affiliate_id = a.affiliate_id),
      'creator_name', f.public_name, 'link_name', coalesce(b.name, 'No link'),
      'reward_key', a.reward_key, 'reward_label', a.reward_label, 'amount_minor', a.amount_minor,
      'status', r.shown, 'reason', a.reason, 'hold_until', r.hold_until, 'reject_reason', a.reject_reason,
      'can_reject', v_can_manage and r.shown = 'pending')
    order by a.occurred_at desc, a.id desc), '[]'::jsonb) into v_awards
  from kma_internal.program_reward_rows(p.id, v_member, v_affiliate, v_status) r
  join public.program_reward_awards a on a.id = r.award_id
  join public.affiliates f on f.id = a.affiliate_id
  left join public.clicks k on k.id = a.click_record_id
  left join public.affiliate_links l on l.id = k.affiliate_link_id
  left join lateral kma_internal.program_link_label(p.funnel_id, l) b on l.id is not null
  where r.occurred_at >= v_cut and (v_before is null or r.occurred_at < v_before);

  return jsonb_build_object(
    'can_manage', v_can_manage,
    'program', jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name, 'status', p.status, 'earn_from', v_earn_from),
    'currency', kma_internal.program_link_currency(p),
    'budget', jsonb_build_object(
      'month', to_char(now() at time zone 'UTC', 'YYYY-MM'),
      'budget_minor', p.reward_budget_minor,
      'used_minor', (select coalesce(sum(a.amount_minor), 0)::bigint from public.program_reward_awards a
        where a.program_id = p.id and a.status = 'earned'
          and a.occurred_at >= v_month and a.occurred_at < v_month + interval '1 month'),
      'daily_limit_minor', kma_internal.program_reward_daily_cap(p.reward_budget_minor, v_rewards),
      'fee_bps', coalesce((select s.program_fee_bps from public.platform_settings s where s.singleton), 1000)),
    'rewards', (
      select coalesce(jsonb_agg(w.r || jsonb_build_object('count', s.events, 'amount_total_minor', s.total) order by w.n),
        '[]'::jsonb)
      from jsonb_array_elements(v_rewards) with ordinality w(r, n)
      cross join lateral (
        select count(*) as events, coalesce(sum(x.amount_minor), 0)::bigint as total
        from public.program_reward_awards a
        join public.program_commissions x on x.award_id = a.id and x.status in ('held', 'approved')
        where a.program_id = p.id and a.reward_key = w.r->>'key' and a.status = 'earned'
          and a.occurred_at >= v_month and a.occurred_at < v_month + interval '1 month') s),
    'creators', coalesce((
      select jsonb_agg(c.line order by c.earned_minor desc, c.name, c.member_id)
      from (
        select m.id as member_id, f.public_name as name, s.earned_minor,
          jsonb_build_object(
            'member_id', m.id, 'name', f.public_name,
            'clicks', (select count(*) from public.clicks k
              join public.affiliate_links l on l.id = k.affiliate_link_id and coalesce(l.tracking_environment, 'live') = 'live'
              where k.affiliate_id = m.affiliate_id and k.product_id = p.product_id and not k.is_bot
                and k.occurred_at >= v_since),
            'people', s.people,
            'went_further', case when jsonb_array_length(v_rewards) > 1 then s.went_further end,
            'counts', (
              select coalesce(jsonb_agg(jsonb_build_object('key', w.r->>'key', 'count', (
                  select count(*) from public.program_reward_awards a
                  join public.program_commissions x on x.award_id = a.id and x.status in ('held', 'approved')
                  where a.program_id = p.id and a.affiliate_id = m.affiliate_id and a.reward_key = w.r->>'key'
                    and a.status = 'earned' and a.occurred_at >= v_since)) order by w.n), '[]'::jsonb)
              from jsonb_array_elements(v_rewards) with ordinality w(r, n)),
            'earned_minor', s.earned_minor, 'pending_minor', s.pending_minor,
            'rejected', s.rejected, 'not_counted', s.not_counted) as line
        from (
          select a.affiliate_id,
            -- The people this creator sent who did the first-listed event and were rewarded
            -- for it, and how many of them were also rewarded for another event of the program.
            count(distinct a.person_id) filter (where a.reward_key = v_first and a.status = 'earned'
              and x.status in ('held', 'approved')) as people,
            count(distinct a.person_id) filter (where a.reward_key = v_first and a.status = 'earned'
              and x.status in ('held', 'approved') and exists (
                select 1 from public.program_reward_awards o
                join public.program_commissions y on y.award_id = o.id and y.status in ('held', 'approved')
                where o.program_id = a.program_id and o.reward_key = any(v_others) and o.person_id = a.person_id
                  and o.status = 'earned')) as went_further,
            coalesce(sum(x.amount_minor) filter (where x.status in ('held', 'approved')), 0)::bigint as earned_minor,
            coalesce(sum(x.amount_minor) filter (where x.status = 'held'), 0)::bigint as pending_minor,
            count(*) filter (where a.status = 'rejected') as rejected,
            count(*) filter (where a.status = 'not_earned') as not_counted
          from public.program_reward_awards a
          left join public.program_commissions x on x.award_id = a.id
          where a.program_id = p.id and a.occurred_at >= v_since
          group by a.affiliate_id) s
        join public.affiliate_program_members m on m.program_id = p.id and m.affiliate_id = s.affiliate_id
        join public.affiliates f on f.id = m.affiliate_id
        order by s.earned_minor desc, f.public_name, m.id limit 500) c), '[]'::jsonb),
    'awards', v_awards,
    'next_before', case when v_more then v_cut end);
end $$;

-- What an operator reads ------------------------------------------------------------------------------

-- Counts and codes only. ledger_mismatches counts reward commissions that do not agree with
-- their entries or their award, and events_out_of_step the rows of program_reward_events
-- that are missing or should not be there; each is 0 or something is wrong.
create function public.program_reward_health() returns jsonb
language sql stable security definer set search_path = '' as $$
  with wanted as (
    select pr.id as project_id, w->>'key' as event_name, p.id as program_id
    from public.affiliate_programs p
    join public.affiliate_program_terms t on t.program_id = p.id and t.version = p.live_terms_version
    join public.analytics_projects pr on pr.workspace_id = p.workspace_id
    cross join lateral jsonb_array_elements(kma_internal.program_reward_list(t.terms)) w
    where p.status in ('live', 'paused'))
  select jsonb_build_object(
    'enabled', kma_internal.program_money_enabled(),
    'programs', (select count(distinct e.program_id) from public.program_reward_events e),
    'events_out_of_step',
      (select count(*) from wanted w where not exists (select 1 from public.program_reward_events e
        where e.project_id = w.project_id and e.event_name = w.event_name and e.program_id = w.program_id))
      + (select count(*) from public.program_reward_events e where not exists (select 1 from wanted w
        where e.project_id = w.project_id and e.event_name = w.event_name and e.program_id = w.program_id)),
    'queue', (select jsonb_build_object(
        'due', count(*) filter (where q.next_attempt_at <= now()),
        'waiting', count(*) filter (where q.next_attempt_at > now()),
        'failing', count(*) filter (where q.attempts > 0),
        'oldest_enqueued_at', min(q.enqueued_at))
      from public.program_reward_queue q),
    'errors', (select coalesce(jsonb_object_agg(r.last_error, r.n), '{}'::jsonb)
      from (select q.last_error, count(*) as n from public.program_reward_queue q
        where q.last_error is not null group by q.last_error) r),
    'awards_last_day', (select coalesce(jsonb_object_agg(r.label, r.n), '{}'::jsonb)
      from (select coalesce(a.reason, a.status) as label, count(*) as n from public.program_reward_awards a
        where a.created_at > now() - interval '1 day' group by 1) r),
    'held_due', (select count(*) from public.program_commissions x
      where x.status = 'held' and x.award_id is not null and x.hold_until <= now()),
    'ledger_mismatches', (select count(*) from public.program_commissions c
      join public.program_reward_awards a on a.id = c.award_id
      where -(c.amount_minor + c.fee_minor) <> coalesce((select sum(e.amount_minor)
          from public.program_balance_entries e where e.commission_id = c.id), 0)
        or (case when c.status = 'approved' then c.amount_minor else 0 end) <> coalesce((select sum(e.amount_minor)
          from public.program_creator_entries e where e.commission_id = c.id), 0)
        or a.status is distinct from (case when c.status in ('held', 'approved') then 'earned'
          when c.status = 'reversed' then 'rejected' end))
      + (select count(*) from public.program_reward_awards a
        where a.status <> 'not_earned' and not exists (select 1 from public.program_commissions c where c.award_id = a.id)))
$$;

-- Programs that are published already, with rewards in their terms, get their rows now.
select kma_internal.program_reward_events_sync();

-- Who may call what ------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'kma_internal' and p.proname like 'program\_reward%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.signature);
  end loop;
end $$;

revoke all on function
    public.program_rewards_tick(jsonb), public.program_reward_health(),
    public.workspace_program_reward_reject(uuid, jsonb), public.workspace_program_rewards(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.program_rewards_tick(jsonb), public.program_reward_health() to service_role;
grant execute on function
    public.workspace_program_reward_reject(uuid, jsonb), public.workspace_program_rewards(uuid, jsonb)
  to authenticated;

commit;
