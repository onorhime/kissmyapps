-- Affiliate self-serve, Phase 4, part two: paying creators. The functions.
--
-- What a creator has coming from a program is the sum of their rows in
-- program_creator_entries. A payout takes the whole of what can be paid in one currency out
-- of those sums the moment a KissMyApps admin makes it, and a worker then sends it as one
-- Stripe transfer from the KissMyApps platform account to the creator's own Stripe account.
-- A payout that is canceled, or fails for good, puts the same amounts back, once.
--
-- The platform is the Stripe account the program balances are on
-- (program_balance_accounts.platform_account_id), live mode. A creator's payout account is
-- their row in external_creator_accounts for that platform: the table, and the functions
-- that reserve and refresh an account, belong to the older external settlement system and
-- are used here as they are.
--
-- Nothing here acts until platform_settings.program_payouts_enabled is true, and program
-- money with it. Nothing is ever paid by itself: a payout exists only because an admin
-- made it.
--
-- Callers tell failures apart by the DETAIL of the error, one short code:
--   invalid_input, invalid_enabled, invalid_min_payout_minor, invalid_expected_updated_at,
--   money_disabled, no_platform, amount_changed, not_payable, too_many_ready, not_cancelable,
--   lease_lost, destination_changed, transfer_mismatch, not_begun, program_payouts_disabled:
--   SQLSTATE 22023; settings_changed: SQLSTATE 40001; payout_not_found: SQLSTATE P0002.
-- The creator's payout account context refuses with SQLSTATE 42501.
--
-- Locks. Whatever changes a creator's sum first takes kma_internal.program_creator_lock for
-- each program it touches, programs in id order. A payout row is locked "for no key update"
-- before its status changes; closing one locks the row first and the creator's sums after.
begin;

-- Small helpers ----------------------------------------------------------------------------

-- Payouts act only while both switches are on.
create function kma_internal.program_payouts_enabled() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select s.program_payouts_enabled and s.program_money_enabled
    from public.platform_settings s where s.singleton), false)
$$;

-- The Stripe platform account program money is on: the one the balance accounts name.
-- There is one in practice; were there ever two, the one with the most balances.
create function kma_internal.program_payout_platform() returns text
language sql stable set search_path = '' as $$
  select b.platform_account_id from public.program_balance_accounts b
  where b.platform_account_id is not null
  group by b.platform_account_id order by count(*) desc, b.platform_account_id limit 1
$$;

-- Creators can only connect and be paid on a platform that is registered and enabled.
create function kma_internal.program_payout_platform_ready(p_platform text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.external_settlement_platforms x
    where x.platform_account_id = p_platform and x.livemode and x.enabled)
$$;

-- What each creator has coming from each program on a platform, where that is more than
-- nothing. A program's currency is the currency of its entries.
create function kma_internal.program_payout_sums(p_platform text, p_affiliate uuid default null)
returns table(affiliate_id uuid, program_id uuid, currency text, amount_minor bigint)
language sql stable set search_path = '' as $$
  select e.affiliate_id, e.program_id, e.currency, sum(e.amount_minor)::bigint
  from public.program_creator_entries e
  join public.program_balance_accounts b on b.program_id = e.program_id
  where b.platform_account_id = p_platform and (p_affiliate is null or e.affiliate_id = p_affiliate)
  group by e.affiliate_id, e.program_id, e.currency
  having sum(e.amount_minor) > 0
$$;

-- Every creator and currency with something to pay on a platform, and the first reason it
-- cannot be paid now (null: it can).
create function kma_internal.program_payout_candidates(p_platform text, p_affiliate uuid default null)
returns table(affiliate_id uuid, name text, currency text, payable_minor bigint, programs jsonb,
  account_status text, account_country text, blocker text)
language sql stable set search_path = '' as $$
  with settings as (
    select kma_internal.program_payouts_enabled() as enabled,
      kma_internal.program_payout_platform_ready(p_platform) as platform_ready,
      coalesce((select s.program_min_payout_minor from public.platform_settings s where s.singleton), 2500) as minimum),
  sums as (
    select s.affiliate_id, s.currency, sum(s.amount_minor)::bigint as payable_minor,
      jsonb_agg(jsonb_build_object('program_id', s.program_id, 'name', p.name, 'amount_minor', s.amount_minor)
        order by p.name, p.id) as programs
    from kma_internal.program_payout_sums(p_platform, p_affiliate) s
    join public.affiliate_programs p on p.id = s.program_id
    group by s.affiliate_id, s.currency)
  select x.affiliate_id, f.public_name, x.currency, x.payable_minor, x.programs,
    coalesce(a.status, 'not_connected'), a.country,
    case
      when not g.enabled then 'payouts_off'
      when not g.platform_ready then 'platform_not_ready'
      when exists (select 1 from public.program_payouts o
        where o.affiliate_id = x.affiliate_id and o.platform_account_id = p_platform and o.currency = x.currency
          and o.status in ('approved', 'processing')) then 'payout_open'
      when a.id is null or a.connect_account_id is null then 'no_account'
      when a.status <> 'ready' then 'account_not_ready'
      when x.payable_minor < g.minimum then 'below_minimum'
    end
  from sums x
  cross join settings g
  join public.affiliates f on f.id = x.affiliate_id
  left join public.external_creator_accounts a
    on a.affiliate_id = x.affiliate_id and a.platform_account_id = p_platform and a.livemode
$$;

-- Raises unless a payout agrees with its rows: its items add up to its amount, and its
-- entries to minus the amount while the money is out (approved, processing, paid) or to
-- nothing once it is back (failed, canceled). Run at the end of every change of a payout.
create function kma_internal.program_payout_check(p_payout uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  o public.program_payouts;
  v_items bigint;
  v_entries bigint;
begin
  select * into o from public.program_payouts where id = p_payout;
  select coalesce(sum(i.amount_minor), 0) into v_items from public.program_payout_items i where i.payout_id = p_payout;
  select coalesce(sum(e.amount_minor), 0) into v_entries from public.program_creator_entries e where e.payout_id = p_payout;
  if v_items <> o.amount_minor
    or v_entries <> (case when o.status in ('failed', 'canceled') then 0 else -o.amount_minor end) then
    raise exception 'Payout % does not agree with its entries', p_payout
      using errcode = 'P0001', detail = 'payout_out_of_balance';
  end if;
end $$;

-- Makes one payout: everything the creator can be paid in the currency, taken out of their
-- sums program by program. Refuses when that is no longer p_expected_minor (amount_changed)
-- or the creator cannot be paid now (not_payable, with the reason in the message).
create function kma_internal.program_payout_make(
  p_platform text, p_affiliate uuid, p_currency text, p_expected_minor bigint, p_actor uuid, p_via text
) returns uuid language plpgsql volatile set search_path = '' as $$
declare
  v_programs uuid[];
  v_program uuid;
  c record;
  v_payout uuid;
  v_now timestamptz := clock_timestamp();
begin
  -- One change at a time to each of the creator's sums, programs in id order.
  select coalesce(array_agg(distinct e.program_id order by e.program_id), '{}') into v_programs
  from public.program_creator_entries e
  join public.program_balance_accounts b on b.program_id = e.program_id
  where e.affiliate_id = p_affiliate and b.platform_account_id = p_platform;
  foreach v_program in array v_programs loop
    perform kma_internal.program_creator_lock(v_program, p_affiliate);
  end loop;

  -- Read again, now that nothing else can take from them. A program that only appeared
  -- while the locks were taken is not held: the admin reloads.
  select * into c from kma_internal.program_payout_candidates(p_platform, p_affiliate) k where k.currency = p_currency;
  if c.affiliate_id is null or c.payable_minor <> p_expected_minor
    or exists (select 1 from jsonb_array_elements(c.programs) x where (x->>'program_id')::uuid <> all(v_programs)) then
    perform kma_internal.program_fail('amount_changed', 'What this creator can be paid has changed');
  end if;
  if c.blocker is not null then
    perform kma_internal.program_fail('not_payable', format('This creator cannot be paid now: %s', c.blocker));
  end if;

  begin
    insert into public.program_payouts(affiliate_id, platform_account_id, currency, amount_minor, approved_by, created_at, updated_at)
    values (p_affiliate, p_platform, p_currency, c.payable_minor, p_actor, v_now, v_now)
    returning id into v_payout;
  exception when unique_violation then
    perform kma_internal.program_fail('not_payable', 'This creator cannot be paid now: payout_open');
  end;
  insert into public.program_payout_items(payout_id, program_id, amount_minor)
  select v_payout, (x->>'program_id')::uuid, (x->>'amount_minor')::bigint from jsonb_array_elements(c.programs) x;
  insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, payout_id)
  select p_affiliate, i.program_id, p_currency, 'payout', -i.amount_minor, v_payout
  from public.program_payout_items i where i.payout_id = v_payout order by i.program_id;
  perform kma_internal.program_payout_check(v_payout);

  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, after_data, metadata)
  values (p_actor, 'admin', 'program_payout_approved', 'program_payouts', v_payout,
    jsonb_build_object('affiliate_id', p_affiliate, 'platform_account_id', p_platform, 'currency', p_currency,
      'amount_minor', c.payable_minor, 'programs', c.programs),
    jsonb_build_object('via', p_via));
  return v_payout;
end $$;

-- Puts a payout's amounts back into the creator's sums, one entry per program. The caller
-- holds the payout row and closes it; a payout gives back once (program_creator_one_payout_reversal).
create function kma_internal.program_payout_reverse(p_payout public.program_payouts) returns void
language plpgsql volatile set search_path = '' as $$
declare i record;
begin
  for i in select t.program_id from public.program_payout_items t where t.payout_id = p_payout.id order by t.program_id loop
    perform kma_internal.program_creator_lock(i.program_id, p_payout.affiliate_id);
  end loop;
  insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, payout_id)
  select p_payout.affiliate_id, t.program_id, p_payout.currency, 'payout_reversed', t.amount_minor, p_payout.id
  from public.program_payout_items t where t.payout_id = p_payout.id order by t.program_id;
end $$;

-- What a worker function says about a payout. The destination, its key and its status are
-- the creator's payout account as it is now. lookup_only: Stripe was first asked more than
-- 23 hours ago and may have forgotten the idempotency key, so the transfer may only be
-- looked up, never asked for again.
create function kma_internal.program_payout_json(o public.program_payouts) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'payout_id', o.id, 'lease_token', o.lease_token, 'affiliate_id', o.affiliate_id,
    'amount_minor', o.amount_minor, 'currency', o.currency, 'platform_account_id', o.platform_account_id,
    'status', o.status, 'attempts', o.attempts, 'first_attempt_at', o.first_attempt_at,
    'connect_account_id', a.connect_account_id, 'account_key', a.id,
    'account_status', coalesce(a.status, 'not_connected'),
    'lookup_only', coalesce(o.first_attempt_at < clock_timestamp() - interval '23 hours', false),
    'transfer_id', o.transfer_id, 'failure_code', o.failure_code, 'next_attempt_at', o.next_attempt_at)
  from (select true as present) one
  left join public.external_creator_accounts a
    on a.affiliate_id = o.affiliate_id and a.platform_account_id = o.platform_account_id and a.livemode
$$;

-- The creator's payout account ---------------------------------------------------------------

-- The signed-in creator's payout account on the platform, made on first use. The same answer
-- as creator_connect_context (the account row and account_key), for a creator who is in a
-- program: an owner or finance member of an active creator account that has joined, asked
-- to join, or earned in a program whose balance is on this platform.
create function public.program_creator_payout_context(p_platform_account_id text, p_livemode boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_affiliate uuid := public.current_partner_affiliate_id(true);
  a public.external_creator_accounts;
begin
  if not kma_internal.program_payouts_enabled() then
    raise exception 'Program payouts are switched off' using errcode = '42501', detail = 'payouts_off';
  end if;
  if p_livemode is distinct from true then
    raise exception 'Program payouts are live only' using errcode = '42501', detail = 'not_live';
  end if;
  if not public.current_user_has_affiliate_role(v_affiliate, array['owner', 'finance']::text[], true) then
    raise exception 'Only an owner or finance member manages the payout account' using errcode = '42501', detail = 'role_required';
  end if;
  if p_platform_account_id is null or not exists (
    select 1 from public.program_balance_accounts b
    where b.platform_account_id = p_platform_account_id and (
      exists (select 1 from public.affiliate_program_members m
        where m.program_id = b.program_id and m.affiliate_id = v_affiliate)
      or exists (select 1 from public.program_creator_entries e
        where e.program_id = b.program_id and e.affiliate_id = v_affiliate))) then
    raise exception 'No program on this platform' using errcode = '42501', detail = 'no_program';
  end if;
  if not kma_internal.program_payout_platform_ready(p_platform_account_id) then
    raise exception 'The platform is not set up for payouts' using errcode = '42501', detail = 'platform_not_ready';
  end if;
  insert into public.external_creator_accounts(affiliate_id, platform_account_id, livemode)
  values (v_affiliate, p_platform_account_id, true) on conflict do nothing;
  select * into a from public.external_creator_accounts x
  where x.affiliate_id = v_affiliate and x.platform_account_id = p_platform_account_id and x.livemode;
  return to_jsonb(a) || jsonb_build_object('account_key', a.id);
end $$;

-- What a creator sees --------------------------------------------------------------------------

-- The signed-in creator's earnings: one line per program they have earned in, their latest
-- 50 commissions, their latest 20 payouts, and what can be paid out. No buyer data.
-- Per program: approved is what is still theirs to be paid, paying is in a payout that is
-- under way, paid is in payouts Stripe confirmed.
create or replace function public.partner_program_earnings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_affiliate uuid := public.current_partner_affiliate_id(true);
  v_platform text := kma_internal.program_payout_platform();
begin
  -- The payout account is offered to a creator who is in a program on the platform.
  if v_platform is not null and not exists (
    select 1 from public.program_balance_accounts b
    where b.platform_account_id = v_platform and (
      exists (select 1 from public.affiliate_program_members m
        where m.program_id = b.program_id and m.affiliate_id = v_affiliate)
      or exists (select 1 from public.program_creator_entries e
        where e.program_id = b.program_id and e.affiliate_id = v_affiliate))) then
    v_platform := null;
  end if;
  return jsonb_build_object(
    'programs', coalesce((
      select jsonb_agg(jsonb_build_object(
          'program_id', p.id, 'slug', p.slug, 'name', p.name,
          'currency', coalesce(
            (select a.currency from public.program_balance_accounts a where a.program_id = p.id),
            cm.currency, en.currency),
          'pending_minor', cm.pending_minor, 'approved_minor', en.approved_minor,
          'paying_minor', en.paying_minor, 'paid_minor', en.paid_minor,
          'sales', cm.sales, 'next_release_at', cm.next_release_at)
        order by p.name, p.id)
      from (
        select x.program_id from public.program_commissions x
        where x.affiliate_id = v_affiliate and x.status in ('held', 'approved', 'reversed')
        union
        select e.program_id from public.program_creator_entries e where e.affiliate_id = v_affiliate) k
      join public.affiliate_programs p on p.id = k.program_id
      cross join lateral (
        select coalesce(sum(x.amount_minor) filter (where x.status = 'held'), 0)::bigint as pending_minor,
          count(*) filter (where x.status in ('held', 'approved')) as sales,
          min(x.hold_until) filter (where x.status = 'held') as next_release_at,
          max(x.currency) filter (where x.status <> 'not_earned') as currency
        from public.program_commissions x
        where x.program_id = p.id and x.affiliate_id = v_affiliate) cm
      cross join lateral (
        select coalesce(sum(e.amount_minor), 0)::bigint as approved_minor,
          coalesce(-sum(e.amount_minor) filter (where e.kind = 'payout' and o.status in ('approved', 'processing')), 0)::bigint
            as paying_minor,
          coalesce(-sum(e.amount_minor) filter (where e.kind = 'payout' and o.status = 'paid'), 0)::bigint as paid_minor,
          max(e.currency) as currency
        from public.program_creator_entries e
        left join public.program_payouts o on o.id = e.payout_id
        where e.program_id = p.id and e.affiliate_id = v_affiliate) en), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', q.id, 'program_id', q.program_id, 'program_name', q.program_name, 'status', q.status,
          'amount_minor', q.amount_minor, 'earned_minor', q.earned_minor, 'currency', q.currency,
          'sale_amount_minor', q.sale_amount_minor, 'paid_at', q.paid_at,
          'hold_until', q.hold_until, 'approved_at', q.approved_at)
        order by q.place)
      from (
        select x.id, x.program_id, p.name as program_name, x.status, x.amount_minor, x.earned_minor, x.currency,
          s.amount_minor as sale_amount_minor, s.paid_at, x.hold_until, x.approved_at,
          row_number() over (order by s.paid_at desc, x.created_at desc, x.id) as place
        from public.program_commissions x
        join public.program_sales s on s.id = x.sale_id
        join public.affiliate_programs p on p.id = x.program_id
        where x.affiliate_id = v_affiliate and x.status in ('held', 'approved', 'reversed')
        order by place limit 50) q), '[]'::jsonb),
    'payouts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', q.id, 'amount_minor', q.amount_minor, 'currency', q.currency, 'status', q.status,
          'created_at', q.created_at, 'paid_at', q.paid_at)
        order by q.created_at desc, q.id)
      from (
        select o.id, o.amount_minor, o.currency, o.status, o.created_at, o.paid_at
        from public.program_payouts o where o.affiliate_id = v_affiliate
        order by o.created_at desc, o.id limit 20) q), '[]'::jsonb),
    'payout', jsonb_build_object(
      'enabled', kma_internal.program_payouts_enabled(),
      'min_payout_minor', coalesce((select s.program_min_payout_minor from public.platform_settings s where s.singleton), 2500),
      'platform_account_id', v_platform,
      'payable', coalesce((
        select jsonb_agg(jsonb_build_object('currency', x.currency, 'amount_minor', x.total) order by x.currency)
        from (select s.currency, sum(s.amount_minor)::bigint as total
          from kma_internal.program_payout_sums(v_platform, v_affiliate) s group by s.currency) x), '[]'::jsonb)));
end $$;

-- The admin panel --------------------------------------------------------------------------------

-- Everything the Program payouts panel shows: the switch, the platform, who has something
-- to be paid and what stands in the way, payouts under way and the latest 50 that ended.
-- Creators appear by their public name only.
create function kma_internal.program_payouts_json() returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_platform text := kma_internal.program_payout_platform();
  s public.platform_settings;
  v_creators jsonb;
  v_open jsonb;
  v_recent jsonb;
  v_totals jsonb;
begin
  select * into s from public.platform_settings x where x.singleton;

  -- Those who can be paid now first, then by name.
  select coalesce(jsonb_agg(jsonb_build_object(
      'affiliate_id', k.affiliate_id, 'name', k.name, 'currency', k.currency, 'payable_minor', k.payable_minor,
      'programs', k.programs, 'account_status', k.account_status, 'account_country', k.account_country,
      'blocker', k.blocker)
    order by (k.blocker is not null), k.name, k.affiliate_id, k.currency), '[]'::jsonb) into v_creators
  from kma_internal.program_payout_candidates(v_platform) k;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'affiliate_id', o.affiliate_id, 'name', f.public_name, 'currency', o.currency,
      'amount_minor', o.amount_minor, 'status', o.status, 'attempts', o.attempts, 'failure_code', o.failure_code,
      'created_at', o.created_at, 'next_attempt_at', o.next_attempt_at,
      'can_cancel', o.status = 'approved' and o.first_attempt_at is null)
    order by o.created_at, o.id), '[]'::jsonb) into v_open
  from public.program_payouts o join public.affiliates f on f.id = o.affiliate_id
  where o.status in ('approved', 'processing');

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', q.id, 'affiliate_id', q.affiliate_id, 'name', q.name, 'currency', q.currency,
      'amount_minor', q.amount_minor, 'status', q.status, 'failure_code', q.failure_code,
      'created_at', q.created_at, 'closed_at', q.closed_at, 'transfer_id', q.transfer_id)
    order by q.closed_at desc, q.id), '[]'::jsonb) into v_recent
  from (
    select o.id, o.affiliate_id, f.public_name as name, o.currency, o.amount_minor, o.status, o.failure_code,
      o.created_at, o.closed_at, o.transfer_id
    from public.program_payouts o join public.affiliates f on f.id = o.affiliate_id
    where o.status in ('paid', 'failed', 'canceled')
    order by o.closed_at desc, o.id limit 50) q;

  -- Every currency that appears anywhere has a figure in each of the three sums.
  with listed as (
    select c->>'currency' as currency, (c->>'payable_minor')::bigint as minor, c->>'blocker' is null as ready
    from jsonb_array_elements(v_creators) c),
  paid as (
    select o.currency, sum(o.amount_minor)::bigint as minor from public.program_payouts o
    where o.status = 'paid' group by o.currency),
  currencies as (
    select l.currency from listed l union select p.currency from paid p
    union select o.currency from public.program_payouts o where o.status in ('approved', 'processing'))
  select jsonb_build_object(
    'ready_minor_by_currency', coalesce(jsonb_object_agg(c.currency,
      coalesce((select sum(l.minor) from listed l where l.currency = c.currency and l.ready), 0)::bigint), '{}'::jsonb),
    'ready_count', (select count(*) from listed l where l.ready),
    'waiting_minor_by_currency', coalesce(jsonb_object_agg(c.currency,
      coalesce((select sum(l.minor) from listed l where l.currency = c.currency and not l.ready), 0)::bigint), '{}'::jsonb),
    'paid_minor_by_currency', coalesce(jsonb_object_agg(c.currency,
      coalesce((select p.minor from paid p where p.currency = c.currency), 0)), '{}'::jsonb))
  into v_totals from currencies c;

  return jsonb_build_object(
    'enabled', coalesce(s.program_payouts_enabled, false),
    'money_enabled', coalesce(s.program_money_enabled, false),
    'min_payout_minor', coalesce(s.program_min_payout_minor, 2500),
    'updated_at', s.updated_at,
    'platform', case when v_platform is null then null else jsonb_build_object(
      'account_id', v_platform,
      'registered', exists (select 1 from public.external_settlement_platforms x
        where x.platform_account_id = v_platform and x.livemode),
      'enabled', kma_internal.program_payout_platform_ready(v_platform)) end,
    'creators', v_creators, 'open', v_open, 'recent', v_recent, 'totals', v_totals);
end $$;

create function public.get_admin_program_payouts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(array['owner', 'operations', 'finance', 'analyst']::text[]) then
    raise exception 'admin role cannot view program payouts' using errcode = '42501';
  end if;
  return kma_internal.program_payouts_json();
end $$;

-- An owner or finance admin pays creators, or takes a payout back before it is sent.
--   {"action":"pay","affiliate_id","currency","expected_amount_minor"}: one creator, the
--     whole of what they can be paid in that currency, which must be the amount the admin saw.
--   {"action":"pay_ready","currency","expected_count","expected_total_minor"}: every creator
--     who can be paid now in that currency, or nobody. The count and the total must be what
--     the admin saw, of all of them. One call makes at most 200 payouts: with more creators
--     ready it is refused (too_many_ready) and they are paid one by one.
--   {"action":"cancel","payout_id"}: only a payout the worker has not started. The money
--     goes back into the creator's sums. Allowed while payouts are switched off.
-- Answers with the panel as it is afterwards.
create function public.perform_admin_program_payout(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid;
  v_platform text;
  v_affiliate uuid;
  v_currency text;
  v_amount bigint;
  v_count bigint;
  v_total bigint;
  v_ready bigint;
  v_ready_total bigint;
  v_made bigint := 0;
  v_made_total bigint := 0;
  v_payout uuid;
  o public.program_payouts;
  r record;
  v_now timestamptz := clock_timestamp();
begin
  perform public.assert_admin_password(array['owner', 'finance']::text[], 'pay program creators');
  v_actor := auth.uid();
  if p_input is null or jsonb_typeof(p_input) <> 'object' or jsonb_typeof(p_input->'action') is distinct from 'string' then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  v_platform := kma_internal.program_payout_platform();

  case p_input->>'action'
  when 'pay' then
    perform kma_internal.program_balance_keys(p_input,
      array['action', 'affiliate_id', 'currency', 'expected_amount_minor'],
      array['action', 'affiliate_id', 'currency', 'expected_amount_minor']);
    v_affiliate := kma_internal.workspace_stripe_uuid(p_input->>'affiliate_id');
    v_currency := p_input->>'currency';
    v_amount := kma_internal.program_balance_int(p_input, 'expected_amount_minor');
    if v_affiliate is null or jsonb_typeof(p_input->'currency') <> 'string' or v_currency !~ '^[A-Z]{3}$'
      or v_amount is null or v_amount < 1 then
      perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
    end if;
    perform kma_internal.program_payout_make(v_platform, v_affiliate, v_currency, v_amount, v_actor, 'pay');

  when 'pay_ready' then
    perform kma_internal.program_balance_keys(p_input,
      array['action', 'currency', 'expected_count', 'expected_total_minor'],
      array['action', 'currency', 'expected_count', 'expected_total_minor']);
    v_currency := p_input->>'currency';
    v_count := kma_internal.program_balance_int(p_input, 'expected_count');
    v_total := kma_internal.program_balance_int(p_input, 'expected_total_minor');
    if jsonb_typeof(p_input->'currency') <> 'string' or v_currency !~ '^[A-Z]{3}$'
      or v_count is null or v_count < 1 or v_total is null or v_total < 1 then
      perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
    end if;
    select count(*), coalesce(sum(k.payable_minor), 0) into v_ready, v_ready_total
    from kma_internal.program_payout_candidates(v_platform) k
    where k.currency = v_currency and k.blocker is null;
    if v_ready > 200 then
      perform kma_internal.program_fail('too_many_ready', 'More than 200 creators are ready: pay them one by one');
    end if;
    if (v_ready, v_ready_total) is distinct from (v_count, v_total) then
      perform kma_internal.program_fail('amount_changed', 'Who can be paid, or how much, has changed');
    end if;
    -- Made in creator id order, so that two admins pressing the button together wait for
    -- each other instead of colliding. Each creator's amount is read again under the locks:
    -- one that changed in between, or a creator who became ready in between, undoes the
    -- whole call.
    for r in
      select c.affiliate_id, c.payable_minor from kma_internal.program_payout_candidates(v_platform) c
      where c.currency = v_currency and c.blocker is null
      order by c.affiliate_id
    loop
      v_made := v_made + 1;
      v_made_total := v_made_total + r.payable_minor;
      perform kma_internal.program_payout_make(v_platform, r.affiliate_id, v_currency, r.payable_minor, v_actor, 'pay_ready');
    end loop;
    if (v_made, v_made_total) is distinct from (v_count, v_total) then
      perform kma_internal.program_fail('amount_changed', 'Who can be paid, or how much, has changed');
    end if;

  when 'cancel' then
    perform kma_internal.program_balance_keys(p_input, array['action', 'payout_id'], array['action', 'payout_id']);
    v_payout := kma_internal.workspace_stripe_uuid(p_input->>'payout_id');
    if v_payout is null then
      perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
    end if;
    select * into o from public.program_payouts x where x.id = v_payout for no key update;
    if o.id is null or o.status <> 'approved' or o.first_attempt_at is not null then
      perform kma_internal.program_fail('not_cancelable', 'This payout can no longer be canceled');
    end if;
    perform kma_internal.program_payout_reverse(o);
    update public.program_payouts set
      status = 'canceled', closed_at = v_now, updated_at = v_now,
      next_attempt_at = null, lease_token = null, lease_until = null
    where id = o.id;
    perform kma_internal.program_payout_check(o.id);
    insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, before_data, after_data)
    values (v_actor, 'admin', 'program_payout_canceled', 'program_payouts', o.id,
      jsonb_build_object('status', o.status, 'affiliate_id', o.affiliate_id, 'currency', o.currency, 'amount_minor', o.amount_minor),
      jsonb_build_object('status', 'canceled'));

  else
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end case;
  return kma_internal.program_payouts_json();
end $$;

-- The owner switches payouts on or off and sets the smallest payout. A key that is left out
-- keeps its value. expected_updated_at must be the updated_at that was read (null only when
-- there are no platform settings yet), like configure_admin_program_money.
-- Switching on needs program money on and a platform to pay from, and registers that
-- platform for creator payout accounts if it is not registered yet. A platform the older
-- settlement system already registered is left exactly as it is, enabled or not.
create function public.configure_admin_program_payouts(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_keys constant text[] := array['enabled', 'min_payout_minor', 'expected_updated_at'];
  v_expected timestamptz;
  v_before public.platform_settings;
  v_saved public.platform_settings;
  v_found boolean;
  v_platform text;
  v_registered boolean := false;
begin
  perform public.assert_admin_password(array['owner']::text[], 'configure program payouts');
  if p_input is null or jsonb_typeof(p_input) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_input) k where k <> all(v_keys))
    or not p_input ? 'expected_updated_at' then
    perform kma_internal.program_fail('invalid_input',
      'Send expected_updated_at with any of enabled and min_payout_minor');
  end if;
  if p_input ? 'enabled' and jsonb_typeof(p_input->'enabled') <> 'boolean' then
    perform kma_internal.program_fail('invalid_enabled', 'enabled must be true or false');
  end if;
  if p_input ? 'min_payout_minor' and (jsonb_typeof(p_input->'min_payout_minor') <> 'number'
    or p_input->>'min_payout_minor' !~ '^[0-9]{1,9}$'
    or (p_input->>'min_payout_minor')::bigint not between 100 and 100000000) then
    perform kma_internal.program_fail('invalid_min_payout_minor', 'The smallest payout must be between 1.00 and 1,000,000.00');
  end if;
  if jsonb_typeof(p_input->'expected_updated_at') not in ('string', 'null') then
    perform kma_internal.program_fail('invalid_expected_updated_at', 'expected_updated_at must be a timestamp or null');
  end if;
  if jsonb_typeof(p_input->'expected_updated_at') = 'string' then
    begin
      v_expected := (p_input->>'expected_updated_at')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      perform kma_internal.program_fail('invalid_expected_updated_at', 'expected_updated_at must be a timestamp or null');
    end;
  end if;

  -- The same lock configure_admin_tracking takes: one change to the settings at a time.
  perform pg_advisory_xact_lock(hashtextextended('platform-tracking-configuration', 0));
  select * into v_before from public.platform_settings s where s.singleton for update;
  v_found := found;
  if (v_expected is null and v_found)
    or (v_expected is not null and (not v_found or v_before.updated_at is distinct from v_expected)) then
    perform kma_internal.program_fail('settings_changed', 'platform settings changed; reload before saving', '40001');
  end if;

  if coalesce((p_input->>'enabled')::boolean, false) and not coalesce(v_before.program_payouts_enabled, false) then
    if not coalesce(v_before.program_money_enabled, false) then
      perform kma_internal.program_fail('money_disabled', 'Switch program money on first');
    end if;
    v_platform := kma_internal.program_payout_platform();
    if v_platform is null then
      perform kma_internal.program_fail('no_platform', 'No program has a balance yet, so there is nothing to pay from');
    end if;
    insert into public.external_settlement_platforms(platform_account_id, livemode, enabled)
    values (v_platform, true, true) on conflict do nothing;
    v_registered := found;
  end if;

  if v_found then
    update public.platform_settings set
      program_payouts_enabled = coalesce((p_input->>'enabled')::boolean, program_payouts_enabled),
      program_min_payout_minor = coalesce((p_input->>'min_payout_minor')::bigint, program_min_payout_minor)
    where singleton returning * into v_saved;
  else
    insert into public.platform_settings(singleton, program_payouts_enabled, program_min_payout_minor)
    values (true, false, coalesce((p_input->>'min_payout_minor')::bigint, 2500))
    returning * into v_saved;
  end if;
  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, before_data, after_data, metadata)
  values (auth.uid(), 'admin', 'program_payouts_configured', 'platform_settings',
    case when v_found then jsonb_build_object('enabled', v_before.program_payouts_enabled,
      'min_payout_minor', v_before.program_min_payout_minor) end,
    jsonb_build_object('enabled', v_saved.program_payouts_enabled, 'min_payout_minor', v_saved.program_min_payout_minor),
    case when v_registered then jsonb_build_object('platform_registered', v_platform) else '{}'::jsonb end);
  return kma_internal.program_payouts_json();
end $$;

-- Service functions: the worker (edge function program-payout-worker) -------------------------

-- Hands the worker payouts that are due on a platform, each with a lease: approved or
-- processing, nobody holding it, and its next try not in the future. Nothing while payouts
-- are switched off.
-- Input: platform_account_id, limit 1..25 (5), lease_seconds 60..900 (300).
create function public.claim_program_payouts(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c record;
  o public.program_payouts;
  v_now timestamptz := clock_timestamp();
  v_payouts jsonb := '[]'::jsonb;
begin
  select * into c from kma_internal.program_balance_claim_input(p_input);
  if not kma_internal.program_payouts_enabled() then
    return jsonb_build_object('payouts', v_payouts);
  end if;
  for o in
    select p.* from public.program_payouts p
    where p.platform_account_id = c.platform and p.status in ('approved', 'processing')
      and (p.lease_until is null or p.lease_until < v_now)
      and (p.next_attempt_at is null or p.next_attempt_at <= v_now)
    order by p.next_attempt_at nulls first, p.created_at, p.id
    limit c.lot
    for no key update of p skip locked
  loop
    update public.program_payouts set
      lease_token = gen_random_uuid(), lease_until = v_now + make_interval(secs => c.lease), updated_at = v_now
    where id = o.id returning * into o;
    v_payouts := v_payouts || jsonb_build_array(kma_internal.program_payout_json(o));
  end loop;
  return jsonb_build_object('payouts', v_payouts);
end $$;

-- The worker is about to ask Stripe. The payout becomes processing, the first time is
-- noted, and the destination is written once: it must be the creator's own payout account,
-- and a payout that was begun towards one account never goes to another.
-- Input: payout_id, lease_token, connect_account_id.
create function public.begin_program_payout(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_payout uuid;
  v_lease uuid;
  v_destination text;
  o public.program_payouts;
  v_now timestamptz := clock_timestamp();
begin
  perform kma_internal.program_balance_keys(p_input,
    array['payout_id', 'lease_token', 'connect_account_id'], array['payout_id', 'lease_token', 'connect_account_id']);
  v_payout := kma_internal.workspace_stripe_uuid(p_input->>'payout_id');
  v_lease := kma_internal.workspace_stripe_uuid(p_input->>'lease_token');
  v_destination := p_input->>'connect_account_id';
  if v_payout is null or v_lease is null or jsonb_typeof(p_input->'connect_account_id') <> 'string'
    or v_destination !~ '^acct_[A-Za-z0-9]{1,250}$' then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  select * into o from public.program_payouts x where x.id = v_payout for no key update;
  if o.id is null then
    perform kma_internal.program_fail('payout_not_found', 'Payout not found', 'P0002');
  end if;
  if o.status not in ('approved', 'processing') or o.lease_token is distinct from v_lease or o.lease_until <= v_now then
    perform kma_internal.program_fail('lease_lost', 'This payout is no longer held by the caller');
  end if;
  if not kma_internal.program_payouts_enabled() then
    perform kma_internal.program_fail('program_payouts_disabled', 'Payouts are switched off');
  end if;
  if (o.connect_account_id is not null and o.connect_account_id <> v_destination)
    or not exists (select 1 from public.external_creator_accounts a
      where a.affiliate_id = o.affiliate_id and a.platform_account_id = o.platform_account_id and a.livemode
        and a.connect_account_id = v_destination) then
    perform kma_internal.program_fail('destination_changed', 'This is not the account the payout goes to');
  end if;
  update public.program_payouts set
    status = 'processing', first_attempt_at = coalesce(first_attempt_at, v_now),
    connect_account_id = v_destination, attempts = attempts + 1, updated_at = v_now
  where id = o.id returning * into o;
  return kma_internal.program_payout_json(o);
end $$;

-- Ends the worker's hold on a payout.
--   paid: Stripe confirmed the transfer. The same transfer reported again is answered with
--     the payout as it is; another transfer for a paid payout is transfer_mismatch.
--   retry: nothing is known for sure, or it cannot be done yet. The payout stays open and
--     is due again after delay_seconds; without one the wait doubles with each attempt, two
--     minutes at first and never more than an hour. failure_code, if sent, is kept as the reason.
--   failed: given up. Every amount goes back into the creator's sums, once.
-- Input: payout_id, lease_token, outcome, and transfer_id (paid), failure_code (failed;
-- optional for retry), delay_seconds 60..86400 (retry).
create function public.finish_program_payout(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_payout uuid;
  v_lease uuid;
  v_outcome text;
  v_transfer text;
  v_code text;
  v_delay bigint;
  o public.program_payouts;
  v_now timestamptz := clock_timestamp();
begin
  perform kma_internal.program_balance_keys(p_input,
    array['payout_id', 'lease_token', 'outcome', 'transfer_id', 'failure_code', 'delay_seconds'],
    array['payout_id', 'lease_token', 'outcome']);
  v_payout := kma_internal.workspace_stripe_uuid(p_input->>'payout_id');
  v_lease := kma_internal.workspace_stripe_uuid(p_input->>'lease_token');
  v_outcome := p_input->>'outcome';
  v_transfer := p_input->>'transfer_id';
  v_code := p_input->>'failure_code';
  if jsonb_typeof(p_input->'delay_seconds') is distinct from 'null' and p_input ? 'delay_seconds' then
    v_delay := coalesce(kma_internal.program_balance_int(p_input, 'delay_seconds'), -1);
  end if;
  if v_payout is null or v_lease is null or v_outcome is null or v_outcome not in ('paid', 'retry', 'failed')
    or (v_transfer is not null and v_transfer !~ '^tr_[A-Za-z0-9]{1,250}$')
    or (v_code is not null and v_code !~ '^[a-z][a-z0-9_]{1,79}$')
    or (v_delay is not null and v_delay not between 60 and 86400)
    or (v_outcome = 'paid' and v_transfer is null)
    or (v_outcome = 'failed' and v_code is null) then
    perform kma_internal.program_fail('invalid_input', 'Check the details and try again');
  end if;
  select * into o from public.program_payouts x where x.id = v_payout for no key update;
  if o.id is null then
    perform kma_internal.program_fail('payout_not_found', 'Payout not found', 'P0002');
  end if;
  if v_outcome = 'paid' and o.status = 'paid' then
    if o.transfer_id is distinct from v_transfer then
      perform kma_internal.program_fail('transfer_mismatch', 'This payout was paid with another transfer');
    end if;
    return kma_internal.program_payout_json(o);
  end if;
  if o.status not in ('approved', 'processing') or o.lease_token is distinct from v_lease or o.lease_until <= v_now then
    perform kma_internal.program_fail('lease_lost', 'This payout is no longer held by the caller');
  end if;

  if v_outcome = 'paid' then
    -- Only a payout the worker began can have a transfer.
    if o.status <> 'processing' or o.connect_account_id is null then
      perform kma_internal.program_fail('not_begun', 'This payout was never begun');
    end if;
    begin
      update public.program_payouts set
        status = 'paid', transfer_id = v_transfer, failure_code = null, paid_at = v_now, closed_at = v_now,
        updated_at = v_now, next_attempt_at = null, lease_token = null, lease_until = null
      where id = o.id returning * into o;
    exception when unique_violation then
      perform kma_internal.program_fail('transfer_mismatch', 'This transfer belongs to another payout');
    end;
    insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, after_data)
    values (null, 'system', 'program_payout_paid', 'program_payouts', o.id,
      jsonb_build_object('status', 'paid', 'amount_minor', o.amount_minor, 'currency', o.currency, 'transfer_id', o.transfer_id));
  elsif v_outcome = 'retry' then
    update public.program_payouts set
      next_attempt_at = v_now + make_interval(secs => coalesce(v_delay,
        least(3600, 60 * power(2, least(greatest(attempts, 1), 6))::integer))::integer),
      failure_code = coalesce(v_code, failure_code), updated_at = v_now, lease_token = null, lease_until = null
    where id = o.id returning * into o;
  else
    perform kma_internal.program_payout_reverse(o);
    update public.program_payouts set
      status = 'failed', failure_code = v_code, closed_at = v_now, updated_at = v_now,
      next_attempt_at = null, lease_token = null, lease_until = null
    where id = o.id returning * into o;
    insert into public.audit_logs(actor_user_id, actor_type, action, target_table, target_id, after_data)
    values (null, 'system', 'program_payout_failed', 'program_payouts', o.id,
      jsonb_build_object('status', 'failed', 'amount_minor', o.amount_minor, 'currency', o.currency, 'failure_code', v_code));
  end if;
  perform kma_internal.program_payout_check(o.id);
  return kma_internal.program_payout_json(o);
end $$;

-- Schedule ---------------------------------------------------------------------------------
-- Run once a minute by pg_cron (job kma-program-payouts). It calls the worker only when a
-- payout is due, and otherwise not at all. Disabled until enabled is set. The migration
-- installs no cron job and no Vault value (docs/affiliate-self-serve-phase4-payouts.md).
create table kma_internal.program_payout_schedule (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  last_tick_at timestamptz,
  last_dispatch_at timestamptz,
  last_request_id bigint
);
insert into kma_internal.program_payout_schedule default values;
revoke all on kma_internal.program_payout_schedule from public, anon, authenticated, service_role;

create function kma_internal.tick_program_payout_schedule() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_schedule kma_internal.program_payout_schedule;
  v_value text;
  v_request bigint;
  v_now timestamptz := clock_timestamp();
begin
  if not pg_try_advisory_xact_lock(hashtextextended('kma-program-payout-scheduler', 0)) then
    return jsonb_build_object('status', 'locked');
  end if;
  update kma_internal.program_payout_schedule set last_tick_at = v_now where singleton
    returning * into v_schedule;
  if not v_schedule.enabled then
    return jsonb_build_object('status', 'paused');
  end if;
  if not kma_internal.program_payouts_enabled() then
    return jsonb_build_object('status', 'payouts_disabled');
  end if;
  if not exists (select 1 from public.program_payouts p
    where p.status in ('approved', 'processing')
      and (p.lease_until is null or p.lease_until < v_now)
      and (p.next_attempt_at is null or p.next_attempt_at <= v_now)) then
    return jsonb_build_object('status', 'idle');
  end if;
  select decrypted_secret into v_value from vault.decrypted_secrets where name = 'kma_program_payout_scheduler';
  if v_value is null or length(v_value) < 32 then
    return jsonb_build_object('status', 'scheduler_value_missing');
  end if;
  v_request := net.http_post(
    url := 'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-payout-worker',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kma-scheduler-secret', v_value),
    timeout_milliseconds := 80000);
  update kma_internal.program_payout_schedule
    set last_dispatch_at = clock_timestamp(), last_request_id = v_request where singleton;
  return jsonb_build_object('status', 'dispatched');
end $$;

-- Operator view: counts and codes only. ledger_mismatches counts payouts whose entries do
-- not add up to what their status says; it is 0 or something is wrong.
create function public.program_payout_health() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enabled', kma_internal.program_payouts_enabled(),
    'schedule', (select to_jsonb(s) - 'last_request_id' - 'singleton' from kma_internal.program_payout_schedule s),
    'platforms', (select count(distinct b.platform_account_id) from public.program_balance_accounts b),
    'payouts', (select coalesce(jsonb_object_agg(r.status, r.n), '{}'::jsonb)
      from (select p.status, count(*) as n from public.program_payouts p group by p.status) r),
    'open_payouts', (select jsonb_build_object(
        'due', count(*) filter (where (p.lease_until is null or p.lease_until < clock_timestamp())
          and (p.next_attempt_at is null or p.next_attempt_at <= clock_timestamp())),
        'lookup_only', count(*) filter (where p.first_attempt_at < clock_timestamp() - interval '23 hours'),
        'oldest_created_at', min(p.created_at))
      from public.program_payouts p where p.status in ('approved', 'processing')),
    'failures', (select coalesce(jsonb_object_agg(r.code, r.n), '{}'::jsonb)
      from (select coalesce(p.failure_code, 'unknown') as code, count(*) as n from public.program_payouts p
        where p.status = 'failed' and p.closed_at > now() - interval '30 days' group by 1) r),
    'ledger_mismatches', (select count(*) from public.program_payouts p
      where coalesce((select sum(e.amount_minor) from public.program_creator_entries e where e.payout_id = p.id), 0)
        <> (case when p.status in ('failed', 'canceled') then 0 else -p.amount_minor end)))
$$;

-- Access -----------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'kma_internal'
      and (p.proname like 'program\_payout%' or p.proname = 'tick_program_payout_schedule')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.signature);
  end loop;
end $$;

revoke all on function
    public.program_creator_payout_context(text, boolean), public.partner_program_earnings(),
    public.get_admin_program_payouts(), public.perform_admin_program_payout(jsonb),
    public.configure_admin_program_payouts(jsonb),
    public.claim_program_payouts(jsonb), public.begin_program_payout(jsonb),
    public.finish_program_payout(jsonb), public.program_payout_health()
  from public, anon, authenticated, service_role;
grant execute on function
    public.program_creator_payout_context(text, boolean), public.partner_program_earnings(),
    public.get_admin_program_payouts(), public.perform_admin_program_payout(jsonb),
    public.configure_admin_program_payouts(jsonb)
  to authenticated;
grant execute on function
    public.claim_program_payouts(jsonb), public.begin_program_payout(jsonb),
    public.finish_program_payout(jsonb), public.program_payout_health()
  to service_role;

commit;
