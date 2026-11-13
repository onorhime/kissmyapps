-- Affiliate self-serve, Phase 4: what a sale earns.
--
-- Every change of a sale is followed by kma_internal.program_commission_sync, which makes
-- the sale's one row in program_commissions what it should be now and moves the merchant's
-- balance by the difference. Commission and the KissMyApps fee are taken out of the balance
-- the moment a sale earns (held), go back on a refund or a lost dispute, and become the
-- creator's when the hold has passed (program_commissions_tick). A program whose balance
-- cannot cover a commission earns nothing on that sale and pauses.
--
-- Nothing here pays anyone: no transfer, no payout. Nothing here acts while
-- platform_settings.program_money_enabled is false.
--
-- The sync runs when the transaction that changed the sale commits, never in the middle of
-- it: record_program_sale writes a sale in several steps (the payment, the creator match,
-- the place in its subscription) and only the finished sale may be judged. A failure inside
-- the sync never fails the sale: it is noted in program_commission_retries and the tick
-- tries again.
--
-- Callers tell failures apart by the DETAIL of the error, one short code: balance_required,
-- invalid_input, invalid_<field>: SQLSTATE 22023; settings_changed: SQLSTATE 40001.
begin;

-- When the switch was last turned on ----------------------------------------------------------
-- A sale recorded before that moment is never judged: it was made while programs had no
-- balance to take commission from.
alter table public.platform_settings add column program_money_enabled_at timestamptz;
update public.platform_settings set program_money_enabled_at = now() where program_money_enabled;
alter table public.platform_settings add constraint platform_settings_program_money_since
  check (not program_money_enabled or program_money_enabled_at is not null);

create function kma_internal.program_money_switched() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.program_money_enabled then
      new.program_money_enabled_at := coalesce(new.program_money_enabled_at, now());
    end if;
  elsif new.program_money_enabled and not old.program_money_enabled
    and new.program_money_enabled_at is not distinct from old.program_money_enabled_at then
    new.program_money_enabled_at := now();
  end if;
  return new;
end $$;
create trigger platform_settings_program_money_switch
  before insert or update on public.platform_settings
  for each row execute function kma_internal.program_money_switched();

-- Storage ---------------------------------------------------------------------------------------

-- A sale that moves to another creator while its commission is held gives the money back and
-- sets it aside again, so one commission can have more than one reserve entry. What must
-- hold instead is checked after every change (kma_internal.program_commission_check): the
-- entries of a commission always add up to exactly what it has set aside now.
drop index public.program_balance_one_reserve;
create index program_balance_entries_commission on public.program_balance_entries(commission_id)
  where commission_id is not null;
create index program_creator_entries_commission on public.program_creator_entries(commission_id)
  where commission_id is not null;

-- Sales whose commission could not be worked out. The tick tries each again after
-- next_attempt_at; the row goes when the sale has been judged. last_error_code is a SQLSTATE.
create table public.program_commission_retries (
  sale_id uuid primary key references public.program_sales(id),
  attempts integer not null default 1 check (attempts > 0),
  last_error_code text not null check (last_error_code ~ '^[A-Z0-9]{5}$'),
  next_attempt_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index program_commission_retries_due on public.program_commission_retries(next_attempt_at);
alter table public.program_commission_retries enable row level security;
revoke all on public.program_commission_retries from public, anon, authenticated, service_role;

-- Small helpers ---------------------------------------------------------------------------------

create function kma_internal.program_money_enabled() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select s.program_money_enabled from public.platform_settings s where s.singleton), false)
$$;

-- The commission on a basis: a share of it, or a fixed amount that is never more than it.
-- Whole-number division, so nothing is ever rounded up.
create function kma_internal.program_commission_of(
  p_type text, p_rate_bps integer, p_fixed_minor bigint, p_basis_minor bigint
) returns bigint language sql immutable set search_path = '' as $$
  select case p_type
    when 'percent' then div(p_basis_minor::numeric * p_rate_bps, 10000)::bigint
    when 'fixed' then least(p_fixed_minor, p_basis_minor) end
$$;

-- The part of an amount that is left when p_refunded_minor of a p_sale_minor sale went back.
create function kma_internal.program_commission_part(
  p_minor bigint, p_sale_minor bigint, p_refunded_minor bigint
) returns bigint language sql immutable set search_path = '' as $$
  select div(p_minor::numeric * greatest(p_sale_minor - p_refunded_minor, 0), p_sale_minor)::bigint
$$;

-- How much of a sale went back to the buyer. A lost dispute takes the whole payment back
-- without changing refunded_minor, so it counts as a full refund.
create function kma_internal.program_commission_refunded(p_sale public.program_sales) returns bigint
language sql stable set search_path = '' as $$
  select case when exists (select 1 from public.program_sale_events e
      where e.sale_id = p_sale.id and e.kind = 'dispute' and e.state = 'lost')
    then p_sale.amount_minor
    else least(p_sale.refunded_minor, p_sale.amount_minor) end
$$;

-- True while a dispute of the sale is open or was lost.
create function kma_internal.program_commission_disputed(p_sale public.program_sales) returns boolean
language sql stable set search_path = '' as $$
  select p_sale.status = 'disputed' or exists (
    select 1 from public.program_sale_events d
    where d.sale_id = p_sale.id and d.kind = 'dispute' and not exists (
      select 1 from public.program_sale_events w
      where w.sale_id = d.sale_id and w.kind = 'dispute'
        and w.stripe_object_id = d.stripe_object_id and w.state = 'won'))
$$;

-- One change at a time to what a creator has coming from a program. Anything that takes
-- from that sum (a clawback here, a payout later) holds this first.
create function kma_internal.program_creator_lock(p_program uuid, p_affiliate uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('kma-program-creator:' || p_program::text || ':' || p_affiliate::text, 0))
$$;

-- The balance cannot cover a commission: the live program pauses, the way a Stripe
-- disconnect pauses it. It becomes live again when money arrives.
-- Row locks in this file are "for no key update": they keep two changes of the same row
-- apart, and do not collide with the key-share locks that every insert of a sale, a
-- commission or an entry takes on the rows it points at. A plain "for update" here would
-- make two sales of one program that both find the balance empty wait for each other.
create function kma_internal.program_commission_pause(p_program uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_before public.affiliate_programs;
  v_saved public.affiliate_programs;
begin
  select * into v_before from public.affiliate_programs p where p.id = p_program and p.status = 'live' for no key update;
  if not found then
    return;
  end if;
  update public.affiliate_programs set
    status = 'paused', pause_reason = 'balance_empty',
    revision = revision + 1, updated_at = clock_timestamp()
  where id = v_before.id returning * into v_saved;
  perform kma_internal.program_audit('affiliate_program_balance_paused', 'system', v_before, v_saved);
end $$;

-- Judging a sale --------------------------------------------------------------------------------

-- What a sale earns, judged from the top, as an unsaved commission row. Reads only.
-- p_refunded_minor is what kma_internal.program_commission_refunded says of the sale.
create function kma_internal.program_commission_decide(p_sale public.program_sales, p_refunded_minor bigint)
returns public.program_commissions language plpgsql volatile set search_path = '' as $$
declare
  c public.program_commissions;
  v_member public.affiliate_program_members;
  v_terms jsonb;
  v_first_paid_at timestamptz;
  v_account public.program_balance_accounts;
  v_status text;
begin
  c.sale_id := p_sale.id;
  c.program_id := p_sale.program_id;
  c.affiliate_id := p_sale.affiliate_id;
  c.currency := p_sale.currency;
  c.status := 'not_earned';
  c.earned_minor := 0;
  c.amount_minor := 0;
  c.fee_earned_minor := 0;
  c.fee_minor := 0;

  if p_refunded_minor >= p_sale.amount_minor then
    c.reason := 'refunded';
    return c;
  end if;
  if p_sale.affiliate_id is null then
    c.reason := 'no_creator';
    return c;
  end if;

  -- The creator was an active member of the program when the buyer paid.
  select m.* into v_member from public.affiliate_program_members m
  where m.program_id = p_sale.program_id and m.affiliate_id = p_sale.affiliate_id
    and m.activated_at <= p_sale.paid_at
    and ((m.ended_at is null and m.status = 'active') or m.ended_at > p_sale.paid_at);
  if v_member.id is null then
    c.reason := 'not_a_member';
    return c;
  end if;
  c.member_id := v_member.id;

  -- The terms they had accepted by then; before any acceptance, the first they accepted.
  c.terms_version := coalesce(
    (select a.terms_version from public.affiliate_program_acceptances a
      where a.member_id = v_member.id and a.accepted_at <= p_sale.paid_at
      order by a.accepted_at desc, a.terms_version desc limit 1),
    (select a.terms_version from public.affiliate_program_acceptances a
      where a.member_id = v_member.id
      order by a.accepted_at, a.terms_version limit 1),
    v_member.terms_version);
  select t.terms into v_terms from public.affiliate_program_terms t
  where t.program_id = p_sale.program_id and t.version = c.terms_version;
  if v_terms is null then
    raise exception 'Terms version % of program % not found', c.terms_version, p_sale.program_id using errcode = 'P0002';
  end if;

  case v_terms->>'commission_duration'
    when 'first_payment' then
      if coalesce(p_sale.subscription_sequence, 1) <> 1 then
        c.reason := 'outside_duration';
      end if;
    when 'months' then
      -- Counted from the first sale of the subscription. A sale outside a subscription, and
      -- the first sale itself, always earn.
      if p_sale.first_sale_id is not null then
        select f.paid_at into v_first_paid_at from public.program_sales f where f.id = p_sale.first_sale_id;
        if p_sale.paid_at >= v_first_paid_at + make_interval(months => (v_terms->>'commission_months')::integer) then
          c.reason := 'outside_duration';
        end if;
      end if;
    when 'lifetime' then
      null;
    else
      raise exception 'Unknown commission duration in terms version %', c.terms_version using errcode = 'P0001';
  end case;
  if c.reason is not null then
    return c;
  end if;

  if p_sale.currency is distinct from v_terms->>'currency' then
    c.reason := 'currency_mismatch';
    return c;
  end if;
  select a.* into v_account from public.program_balance_accounts a where a.program_id = p_sale.program_id;
  if v_account.id is null then
    c.reason := 'balance_empty';
    return c;
  end if;
  if v_account.currency <> p_sale.currency then
    c.reason := 'currency_mismatch';
    return c;
  end if;

  select p.status into v_status from public.affiliate_programs p where p.id = p_sale.program_id;
  if v_status is distinct from 'live' then
    c.reason := 'program_paused';
    return c;
  end if;

  -- The payment without tax; the commission on it; what is left of both after any refund.
  c.basis_minor := greatest(p_sale.amount_minor - coalesce(p_sale.tax_minor, 0), 0);
  c.commission_type := v_terms->>'commission_type';
  c.commission_rate_bps := (v_terms->>'commission_rate_bps')::integer;
  c.commission_fixed_minor := (v_terms->>'commission_fixed_minor')::bigint;
  c.earned_minor := kma_internal.program_commission_of(
    c.commission_type, c.commission_rate_bps, c.commission_fixed_minor, c.basis_minor);
  if c.earned_minor is null then
    raise exception 'Unknown commission in terms version %', c.terms_version using errcode = 'P0001';
  end if;
  c.amount_minor := kma_internal.program_commission_part(c.earned_minor, p_sale.amount_minor, p_refunded_minor);
  if c.amount_minor <= 0 then
    c.reason := 'zero_amount';
    c.basis_minor := null;
    c.commission_type := null;
    c.commission_rate_bps := null;
    c.commission_fixed_minor := null;
    c.earned_minor := 0;
    c.amount_minor := 0;
    return c;
  end if;
  select s.program_fee_bps into c.fee_bps from public.platform_settings s where s.singleton;
  c.fee_earned_minor := div(c.earned_minor::numeric * c.fee_bps, 10000)::bigint;
  c.fee_minor := kma_internal.program_commission_part(c.fee_earned_minor, p_sale.amount_minor, p_refunded_minor);
  c.hold_until := p_sale.paid_at + make_interval(days => (v_terms->>'hold_days')::integer);
  c.status := 'held';
  return c;
end $$;

-- Judges a sale and writes the result: a new row, or (p_existing) the sale's row in place.
-- A commission that earns is set aside from the balance here, commission and fee together
-- or not at all. When the balance cannot cover both, or the program has no balance, the sale
-- earns nothing and the program pauses.
create function kma_internal.program_commission_evaluate(
  p_sale public.program_sales, p_refunded_minor bigint, p_existing uuid
) returns void language plpgsql volatile set search_path = '' as $$
declare
  c public.program_commissions := kma_internal.program_commission_decide(p_sale, p_refunded_minor);
  v_id uuid := p_existing;
  v_account uuid;
  v_detail text;
  v_short boolean := false;
begin
  if p_existing is null then
    insert into public.program_commissions(
      sale_id, program_id, member_id, affiliate_id, terms_version, status, reason, currency,
      basis_minor, commission_type, commission_rate_bps, commission_fixed_minor, fee_bps,
      earned_minor, amount_minor, fee_earned_minor, fee_minor, hold_until)
    values (
      c.sale_id, c.program_id, c.member_id, c.affiliate_id, c.terms_version, c.status, c.reason, c.currency,
      c.basis_minor, c.commission_type, c.commission_rate_bps, c.commission_fixed_minor, c.fee_bps,
      c.earned_minor, c.amount_minor, c.fee_earned_minor, c.fee_minor, c.hold_until)
    returning id into v_id;
  else
    update public.program_commissions set
      member_id = c.member_id, affiliate_id = c.affiliate_id, terms_version = c.terms_version,
      status = c.status, reason = c.reason, currency = c.currency,
      basis_minor = c.basis_minor, commission_type = c.commission_type,
      commission_rate_bps = c.commission_rate_bps, commission_fixed_minor = c.commission_fixed_minor,
      fee_bps = c.fee_bps, earned_minor = c.earned_minor, amount_minor = c.amount_minor,
      fee_earned_minor = c.fee_earned_minor, fee_minor = c.fee_minor, hold_until = c.hold_until,
      approved_at = null, reversed_at = null, updated_at = clock_timestamp()
    where id = p_existing;
  end if;

  if c.status = 'held' then
    select a.id into v_account from public.program_balance_accounts a where a.program_id = c.program_id;
    begin
      perform kma_internal.program_balance_post(v_account, 'commission_reserved', -c.amount_minor, null, v_id);
      if c.fee_minor > 0 then
        perform kma_internal.program_balance_post(v_account, 'fee_reserved', -c.fee_minor, null, v_id);
      end if;
    exception when raise_exception then
      -- Leaving this block undoes whatever of the two was set aside.
      get stacked diagnostics v_detail = pg_exception_detail;
      if v_detail is distinct from 'balance_insufficient' then
        raise;
      end if;
      v_short := true;
    end;
    if v_short then
      update public.program_commissions set
        status = 'not_earned', reason = 'balance_empty',
        basis_minor = null, commission_type = null, commission_rate_bps = null, commission_fixed_minor = null,
        fee_bps = null, earned_minor = 0, amount_minor = 0, fee_earned_minor = 0, fee_minor = 0, hold_until = null,
        updated_at = clock_timestamp()
      where id = v_id;
    end if;
  end if;
  if v_short or c.reason = 'balance_empty' then
    perform kma_internal.program_commission_pause(c.program_id);
  end if;
end $$;

-- Raises unless the sale's commission agrees with its entries: the merchant's balance
-- entries for it add up to exactly what it has set aside now, and the creator's entries to
-- exactly what was approved and not taken back. Run at the end of every change, inside the
-- same transaction, so a change that would break this is undone as a whole.
create function kma_internal.program_commission_check(p_sale_id uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  c public.program_commissions;
  v_balance bigint;
  v_creator bigint;
begin
  select * into c from public.program_commissions x where x.sale_id = p_sale_id;
  if not found then
    return;
  end if;
  select coalesce(sum(e.amount_minor), 0) into v_balance
  from public.program_balance_entries e where e.commission_id = c.id;
  select coalesce(sum(e.amount_minor), 0) into v_creator
  from public.program_creator_entries e where e.commission_id = c.id;
  if v_balance <> -(c.amount_minor + c.fee_minor)
    or v_creator <> (case when c.status = 'approved' then c.amount_minor else 0 end) then
    raise exception 'Commission % does not agree with its entries', c.id
      using errcode = 'P0001', detail = 'commission_out_of_balance';
  end if;
end $$;

-- Makes the sale's commission what it should be now. Raises on any failure; callers that
-- must not fail use kma_internal.program_commission_sync.
-- Locks, always in this order: the sale, its commission, the creator's sum, the balance,
-- and last the program (only to pause it, after the balance lock of a failed reserve is gone).
create function kma_internal.program_commission_apply(p_sale_id uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_sale public.program_sales;
  c public.program_commissions;
  v_refunded bigint;
  v_account uuid;
  v_cap bigint;
  v_amount bigint;
  v_fee bigint;
  v_owed bigint;
  v_take bigint;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_sale from public.program_sales s where s.id = p_sale_id for no key update;
  if not found then
    return;
  end if;
  select * into c from public.program_commissions x where x.sale_id = p_sale_id for no key update;
  v_refunded := kma_internal.program_commission_refunded(v_sale);

  if c.id is null then
    -- A sale recorded before the switch was turned on is never judged.
    if v_sale.created_at < (select s.program_money_enabled_at from public.platform_settings s where s.singleton) then
      return;
    end if;
    perform kma_internal.program_commission_evaluate(v_sale, v_refunded, null);

  elsif c.status = 'not_earned' then
    -- Final, except a sale nobody was credited for that now has a creator.
    if c.reason = 'no_creator' and v_sale.affiliate_id is not null then
      perform kma_internal.program_commission_evaluate(v_sale, v_refunded, c.id);
    else
      return;
    end if;

  elsif c.status = 'held' and v_sale.affiliate_id is distinct from c.affiliate_id then
    -- The sale moved to another creator, or to nobody: everything set aside goes back and
    -- the sale is judged again from the top.
    select a.id into v_account from public.program_balance_accounts a where a.program_id = c.program_id;
    if c.amount_minor > 0 then
      perform kma_internal.program_balance_post(v_account, 'commission_returned', c.amount_minor, null, c.id);
    end if;
    if c.fee_minor > 0 then
      perform kma_internal.program_balance_post(v_account, 'fee_returned', c.fee_minor, null, c.id);
    end if;
    perform kma_internal.program_commission_evaluate(v_sale, v_refunded, c.id);

  elsif c.status in ('held', 'approved') then
    -- What the commission may still be: never more than it is, less when part of the
    -- payment was refunded (or tax turned out higher than first known).
    v_cap := least(c.earned_minor, kma_internal.program_commission_of(c.commission_type, c.commission_rate_bps,
      c.commission_fixed_minor, greatest(v_sale.amount_minor - coalesce(v_sale.tax_minor, 0), 0)));
    v_amount := least(c.amount_minor, kma_internal.program_commission_part(v_cap, v_sale.amount_minor, v_refunded));
    if v_amount is null then
      raise exception 'Commission % cannot be worked out again', c.id using errcode = 'P0001';
    end if;

    if c.status = 'held' then
      v_fee := case when v_amount = 0 then 0 else least(c.fee_minor, kma_internal.program_commission_part(
        div(v_cap::numeric * c.fee_bps, 10000)::bigint, v_sale.amount_minor, v_refunded)) end;
      if v_amount = c.amount_minor and v_fee = c.fee_minor then
        return;
      end if;
      select a.id into v_account from public.program_balance_accounts a where a.program_id = c.program_id;
      if v_amount < c.amount_minor then
        perform kma_internal.program_balance_post(v_account, 'commission_returned', c.amount_minor - v_amount, null, c.id);
      end if;
      if v_fee < c.fee_minor then
        perform kma_internal.program_balance_post(v_account, 'fee_returned', c.fee_minor - v_fee, null, c.id);
      end if;
      update public.program_commissions set
        amount_minor = v_amount, fee_minor = v_fee,
        status = case when v_amount = 0 then 'reversed' else 'held' end,
        reversed_at = case when v_amount = 0 then v_now end,
        updated_at = v_now
      where id = c.id;

    else
      -- Approved: the commission is the creator's, so what a refund takes back comes out of
      -- what the creator still has coming from this program, and never more than that. The
      -- fee stays.
      if v_amount = c.amount_minor then
        return;
      end if;
      perform kma_internal.program_creator_lock(c.program_id, c.affiliate_id);
      select coalesce(sum(e.amount_minor), 0) into v_owed from public.program_creator_entries e
      where e.affiliate_id = c.affiliate_id and e.program_id = c.program_id;
      v_take := least(c.amount_minor - v_amount, greatest(v_owed, 0));
      if v_take <= 0 then
        return;
      end if;
      select a.id into v_account from public.program_balance_accounts a where a.program_id = c.program_id;
      insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, commission_id)
      values (c.affiliate_id, c.program_id, c.currency, 'clawback', -v_take, c.id);
      perform kma_internal.program_balance_post(v_account, 'commission_returned', v_take, null, c.id);
      update public.program_commissions set amount_minor = amount_minor - v_take, updated_at = v_now where id = c.id;
    end if;

  else
    -- Reversed: nothing more can happen to it.
    return;
  end if;

  perform kma_internal.program_commission_check(p_sale_id);
end $$;

-- Notes that a sale's commission could not be worked out, with the SQLSTATE of the failure.
-- Tried again after 1, 2, 4 ... minutes, at most every 6 hours.
create function kma_internal.program_commission_retry(p_sale_id uuid, p_code text) returns void
language sql volatile set search_path = '' as $$
  insert into public.program_commission_retries as r (sale_id, attempts, last_error_code, next_attempt_at)
  values (p_sale_id, 1, coalesce(p_code, 'XX000'), clock_timestamp() + interval '1 minute')
  on conflict (sale_id) do update set
    attempts = r.attempts + 1, last_error_code = excluded.last_error_code,
    next_attempt_at = clock_timestamp() + make_interval(mins => least(360, power(2, least(r.attempts, 10))::integer)),
    updated_at = clock_timestamp()
$$;

-- The one entry point: brings a sale's commission up to date. Does nothing while program
-- money is switched off. Never raises: whatever went wrong inside is undone as a whole and
-- the sale is left for the tick.
create function kma_internal.program_commission_sync(p_sale_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code text;
begin
  if p_sale_id is null or not kma_internal.program_money_enabled() then
    return;
  end if;
  begin
    perform kma_internal.program_commission_apply(p_sale_id);
    delete from public.program_commission_retries where sale_id = p_sale_id;
  exception when others then
    get stacked diagnostics v_code = returned_sqlstate;
    begin
      perform kma_internal.program_commission_retry(p_sale_id, v_code);
    exception when others then
      null;
    end;
  end;
end $$;

-- Following every change of a sale ----------------------------------------------------------------
-- Deferred: they run once the writing transaction is about to commit, on the sale as it
-- finally is. Only changes that can matter to a commission are followed. One transaction
-- often changes a sale several times; a change that a later one has already overtaken is
-- skipped, because the later one is followed too.

create function kma_internal.program_commission_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'program_sale_events' then
    perform kma_internal.program_commission_sync(new.sale_id);
  elsif exists (select 1 from public.program_sales s where s.id = new.id
    and (s.affiliate_id, s.refunded_minor, s.status, s.tax_minor)
      is not distinct from (new.affiliate_id, new.refunded_minor, new.status, new.tax_minor)) then
    perform kma_internal.program_commission_sync(new.id);
  end if;
  return null;
end $$;

create constraint trigger program_sales_commission_insert
  after insert on public.program_sales
  deferrable initially deferred
  for each row execute function kma_internal.program_commission_changed();
create constraint trigger program_sales_commission_update
  after update on public.program_sales
  deferrable initially deferred
  for each row when (
    old.affiliate_id is distinct from new.affiliate_id
    or old.refunded_minor is distinct from new.refunded_minor
    or old.status is distinct from new.status
    or old.tax_minor is distinct from new.tax_minor)
  execute function kma_internal.program_commission_changed();
-- A dispute that is opened or won changes the status of the sale, which is followed above.
-- A dispute that is lost usually leaves the sale as it was (disputed), so it is followed here.
create constraint trigger program_sale_events_commission
  after insert on public.program_sale_events
  deferrable initially deferred
  for each row when (new.kind = 'dispute' and new.state = 'lost')
  execute function kma_internal.program_commission_changed();

-- Approving after the hold ----------------------------------------------------------------------

-- Run on a schedule by the service role. Tries again the sales whose commission could not
-- be worked out, then approves held commissions whose hold has passed: each sale is first
-- brought up to date (a refund or a lost dispute that was missed is applied), and a sale
-- that is disputed is left held. Approval writes the creator's entry. Safe to run again and
-- at the same time as itself: a sale somebody else is working on is skipped.
-- Input: {"limit": 1..1000} (default 500). Output: {"approved", "retried", "remaining"}.
create function public.program_commissions_tick(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_input jsonb := coalesce(p_input, '{}'::jsonb);
  v_limit integer;
  v_now timestamptz := clock_timestamp();
  v_approved integer := 0;
  v_retried integer := 0;
  v_remaining bigint;
  v_sale public.program_sales;
  c public.program_commissions;
  v_account uuid;
  v_code text;
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
    return jsonb_build_object('approved', 0, 'retried', 0, 'remaining', 0);
  end if;

  for r in
    select t.sale_id from public.program_commission_retries t
    where t.next_attempt_at <= v_now
    order by t.next_attempt_at, t.sale_id limit v_limit
  loop
    -- The sale first, like every other path. A sale that is being written right now is
    -- synced by its own transaction.
    perform 1 from public.program_sales s where s.id = r.sale_id for no key update skip locked;
    if not found then
      continue;
    end if;
    perform 1 from public.program_commission_retries t
    where t.sale_id = r.sale_id and t.next_attempt_at <= v_now for no key update;
    if not found then
      continue;
    end if;
    perform kma_internal.program_commission_sync(r.sale_id);
    v_retried := v_retried + 1;
  end loop;

  for r in
    select x.id, x.sale_id from public.program_commissions x
    join public.program_sales s on s.id = x.sale_id
    where x.status = 'held' and x.hold_until <= v_now
      and (s.status <> 'disputed' or exists (select 1 from public.program_sale_events e
        where e.sale_id = s.id and e.kind = 'dispute' and e.state = 'lost'))
    order by x.hold_until, x.id limit v_limit
  loop
    begin
      select * into v_sale from public.program_sales s where s.id = r.sale_id for no key update skip locked;
      if not found then
        continue;
      end if;
      perform kma_internal.program_commission_apply(r.sale_id);
      select * into c from public.program_commissions x where x.id = r.id for no key update;
      if c.status = 'held' and c.hold_until <= clock_timestamp()
        and not kma_internal.program_commission_disputed(v_sale) then
        if c.amount_minor = 0 then
          -- Nothing is left of it: it goes back to the merchant instead.
          if c.fee_minor > 0 then
            select a.id into v_account from public.program_balance_accounts a where a.program_id = c.program_id;
            perform kma_internal.program_balance_post(v_account, 'fee_returned', c.fee_minor, null, c.id);
          end if;
          update public.program_commissions set
            status = 'reversed', fee_minor = 0, reversed_at = v_now, updated_at = v_now
          where id = c.id;
        else
          update public.program_commissions set status = 'approved', approved_at = v_now, updated_at = v_now
          where id = c.id;
          insert into public.program_creator_entries(affiliate_id, program_id, currency, kind, amount_minor, commission_id)
          values (c.affiliate_id, c.program_id, c.currency, 'commission_approved', c.amount_minor, c.id);
          v_approved := v_approved + 1;
        end if;
        perform kma_internal.program_commission_check(r.sale_id);
      end if;
    exception when others then
      -- Everything done for this sale is undone; the others go on.
      get stacked diagnostics v_code = returned_sqlstate;
      perform kma_internal.program_commission_retry(r.sale_id, v_code);
    end;
  end loop;

  v_now := clock_timestamp();
  select (select count(*) from public.program_commissions x
      join public.program_sales s on s.id = x.sale_id
      where x.status = 'held' and x.hold_until <= v_now and s.status <> 'disputed')
    + (select count(*) from public.program_commission_retries t where t.next_attempt_at <= v_now)
    into v_remaining;
  return jsonb_build_object('approved', v_approved, 'retried', v_retried, 'remaining', v_remaining);
end $$;

-- Keeping a program honest about its balance ---------------------------------------------------
-- While program money is on, a program can only be sent for review, or become live, with
-- money in its balance. This is what makes the first deposit a condition of publishing.

create function kma_internal.program_require_balance() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if kma_internal.program_money_enabled() and not exists (
    select 1 from public.program_balance_accounts a where a.program_id = new.id and a.available_minor > 0) then
    perform kma_internal.program_fail('balance_required', 'Add funds to the program balance first');
  end if;
  return new;
end $$;
create trigger affiliate_programs_require_balance
  before update of status on public.affiliate_programs
  for each row when (new.status is distinct from old.status and new.status in ('in_review', 'live'))
  execute function kma_internal.program_require_balance();

-- What a creator sees --------------------------------------------------------------------------

-- The signed-in creator's earnings: one line per program they have earned in, and their
-- latest 50 commissions. No buyer data.
create function public.partner_program_earnings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_affiliate uuid := public.current_partner_affiliate_id(true);
begin
  return jsonb_build_object(
    'programs', coalesce((
      select jsonb_agg(jsonb_build_object(
          'program_id', p.id, 'slug', p.slug, 'name', p.name,
          'currency', coalesce(
            (select a.currency from public.program_balance_accounts a where a.program_id = p.id),
            cm.currency, en.currency),
          'pending_minor', cm.pending_minor, 'approved_minor', en.approved_minor, 'paid_minor', en.paid_minor,
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
        -- What is owed and not yet paid out, and what was paid out (nothing, until payouts exist).
        select coalesce(sum(e.amount_minor), 0)::bigint as approved_minor,
          coalesce(-sum(e.amount_minor) filter (where e.kind in ('payout', 'payout_reversed')), 0)::bigint as paid_minor,
          max(e.currency) as currency
        from public.program_creator_entries e
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
        order by place limit 50) q), '[]'::jsonb));
end $$;

-- The admin switch -------------------------------------------------------------------------------

-- The switch, the fee, the smallest first deposit, and what is held across all programs.
-- A program "with balance" has money available now.
create function kma_internal.program_money_json() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'enabled', coalesce(s.program_money_enabled, false),
    'fee_bps', coalesce(s.program_fee_bps, 1000),
    'min_deposit_minor', coalesce(s.program_min_deposit_minor, 5000),
    'updated_at', s.updated_at,
    'programs_with_balance', (select count(*) from public.program_balance_accounts a where a.available_minor > 0),
    'available_minor_by_currency', (
      select coalesce(jsonb_object_agg(x.currency, x.total), '{}'::jsonb)
      from (select a.currency, sum(a.available_minor)::bigint as total
        from public.program_balance_accounts a group by a.currency) x),
    'reserved_minor_by_currency', (
      select coalesce(jsonb_object_agg(x.currency, x.total), '{}'::jsonb)
      from (select c.currency, sum(c.amount_minor + c.fee_minor)::bigint as total
        from public.program_commissions c where c.status = 'held' group by c.currency) x),
    'owed_to_creators_minor_by_currency', (
      select coalesce(jsonb_object_agg(x.currency, x.total), '{}'::jsonb)
      from (select e.currency, sum(e.amount_minor)::bigint as total
        from public.program_creator_entries e group by e.currency) x))
  from (select true as present) one
  left join public.platform_settings s on s.singleton
$$;

create function public.get_admin_program_money() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(array['owner', 'operations', 'finance', 'analyst']::text[]) then
    raise exception 'admin role cannot view program money' using errcode = '42501';
  end if;
  return kma_internal.program_money_json();
end $$;

-- The owner changes the switch, the fee or the smallest first deposit. A key that is left
-- out keeps its value. expected_updated_at must be the updated_at that was read (null only
-- when there are no platform settings yet), like configure_admin_tracking.
create function public.configure_admin_program_money(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_keys constant text[] := array['enabled', 'fee_bps', 'min_deposit_minor', 'expected_updated_at'];
  v_expected timestamptz;
  v_before public.platform_settings;
  v_saved public.platform_settings;
  v_found boolean;
begin
  perform public.assert_admin_password(array['owner']::text[], 'configure program money');
  if p_input is null or jsonb_typeof(p_input) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_input) k where k <> all(v_keys))
    or not p_input ? 'expected_updated_at' then
    perform kma_internal.program_fail('invalid_input',
      'Send expected_updated_at with any of enabled, fee_bps and min_deposit_minor');
  end if;
  if p_input ? 'enabled' and jsonb_typeof(p_input->'enabled') <> 'boolean' then
    perform kma_internal.program_fail('invalid_enabled', 'enabled must be true or false');
  end if;
  if p_input ? 'fee_bps' and (jsonb_typeof(p_input->'fee_bps') <> 'number' or p_input->>'fee_bps' !~ '^[0-9]{1,4}$'
    or (p_input->>'fee_bps')::integer > 5000) then
    perform kma_internal.program_fail('invalid_fee_bps', 'The fee must be between 0% and 50%');
  end if;
  if p_input ? 'min_deposit_minor' and (jsonb_typeof(p_input->'min_deposit_minor') <> 'number'
    or p_input->>'min_deposit_minor' !~ '^[0-9]{1,9}$'
    or (p_input->>'min_deposit_minor')::bigint not between 100 and 100000000) then
    perform kma_internal.program_fail('invalid_min_deposit_minor', 'The smallest first deposit must be between 1.00 and 1,000,000.00');
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

  if v_found then
    update public.platform_settings set
      program_money_enabled = coalesce((p_input->>'enabled')::boolean, program_money_enabled),
      program_fee_bps = coalesce((p_input->>'fee_bps')::integer, program_fee_bps),
      program_min_deposit_minor = coalesce((p_input->>'min_deposit_minor')::bigint, program_min_deposit_minor)
    where singleton returning * into v_saved;
  else
    insert into public.platform_settings(singleton, program_money_enabled, program_fee_bps, program_min_deposit_minor)
    values (true, coalesce((p_input->>'enabled')::boolean, false), coalesce((p_input->>'fee_bps')::integer, 1000),
      coalesce((p_input->>'min_deposit_minor')::bigint, 5000))
    returning * into v_saved;
  end if;
  insert into public.audit_logs(actor_user_id, actor_type, action, target_table, before_data, after_data)
  values (auth.uid(), 'admin', 'program_money_configured', 'platform_settings',
    case when v_found then jsonb_build_object('enabled', v_before.program_money_enabled,
      'fee_bps', v_before.program_fee_bps, 'min_deposit_minor', v_before.program_min_deposit_minor) end,
    jsonb_build_object('enabled', v_saved.program_money_enabled,
      'fee_bps', v_saved.program_fee_bps, 'min_deposit_minor', v_saved.program_min_deposit_minor));
  return kma_internal.program_money_json();
end $$;

-- Who may call what ------------------------------------------------------------------------

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'kma_internal' and p.proname like 'program\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.signature);
  end loop;
end $$;

revoke all on function
  public.program_commissions_tick(jsonb),
  public.partner_program_earnings(),
  public.get_admin_program_money(),
  public.configure_admin_program_money(jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.program_commissions_tick(jsonb) to service_role;
grant execute on function
  public.partner_program_earnings(),
  public.get_admin_program_money(),
  public.configure_admin_program_money(jsonb)
to authenticated;

commit;
