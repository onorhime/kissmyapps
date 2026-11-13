-- Affiliate self-serve, Phase 4: money. This migration creates the tables only.
--
-- The rule the whole phase serves: KissMyApps never owes a creator money it has not already
-- collected. A merchant keeps a prepaid balance per program. When a sale earns commission,
-- the commission and the KissMyApps fee are taken out of that balance at that moment and
-- set aside. A refund inside the hold puts them back. After the hold the commission is the
-- creator's. A program whose balance cannot cover a commission stops earning and pauses.
begin;

-- Platform switches. Nothing in this phase acts until program_money_enabled is true.
alter table public.platform_settings
  add column program_money_enabled boolean not null default false,
  -- The KissMyApps fee, charged to the merchant on top of each commission (1000 = 10%).
  add column program_fee_bps integer not null default 1000 check (program_fee_bps between 0 and 5000),
  -- The smallest first deposit, in minor units of the program's currency.
  add column program_min_deposit_minor bigint not null default 5000 check (program_min_deposit_minor between 100 and 100000000);

-- A program can now also be paused because its balance ran out.
alter table public.affiliate_programs drop constraint affiliate_programs_pause_reason_check;
alter table public.affiliate_programs add constraint affiliate_programs_pause_reason_check
  check (pause_reason in ('merchant', 'stripe_disconnected', 'admin', 'balance_empty'));

-- One prepaid balance per program, in the program's currency. The card details are what
-- Stripe reports about the saved card (brand, last four digits, expiry); the card itself
-- lives only at Stripe, on the KissMyApps platform account named here.
create table public.program_balance_accounts (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null unique references public.affiliate_programs(id),
  workspace_id uuid not null references public.analytics_workspaces(id),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- What can still be set aside for commission. Kept in step with the entries below by
  -- kma_internal.program_balance_post, the only writer of both.
  available_minor bigint not null default 0,
  platform_account_id text check (platform_account_id ~ '^acct_[A-Za-z0-9]+$'),
  stripe_customer_id text check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  payment_method_id text check (payment_method_id ~ '^pm_[A-Za-z0-9]{1,250}$'),
  card_brand text check (card_brand ~ '^[a-z_]{1,30}$'),
  card_last4 text check (card_last4 ~ '^[0-9]{4}$'),
  card_exp_month integer check (card_exp_month between 1 and 12),
  card_exp_year integer check (card_exp_year between 2024 and 2100),
  -- Automatic top-up: when available falls below min_balance_minor, charge topup_amount_minor.
  auto_topup boolean not null default true,
  min_balance_minor bigint not null default 5000 check (min_balance_minor between 0 and 100000000),
  topup_amount_minor bigint not null default 10000 check (topup_amount_minor between 1000 and 100000000),
  -- A failed automatic top-up is retried after 1, 3 and 7 days.
  topup_failures integer not null default 0 check (topup_failures >= 0),
  topup_retry_at timestamptz,
  topup_failure_code text check (length(topup_failure_code) between 1 and 80),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint program_balance_card_shape check (
    (payment_method_id is null) = (card_last4 is null)
    and (payment_method_id is null or stripe_customer_id is not null))
);

-- Money the merchant paid in: a deposit they made themselves, or an automatic top-up.
create table public.program_topups (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.program_balance_accounts(id),
  kind text not null check (kind in ('deposit', 'auto')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- pending: created here, not yet at Stripe. processing: Stripe has it. succeeded: paid
  -- and added to the balance. failed, canceled: nothing was added. reversed: it was added
  -- and later taken back (the card payment was refunded or lost a dispute).
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'succeeded', 'failed', 'canceled', 'reversed')),
  checkout_session_id text unique check (checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,252}$'),
  payment_intent_id text unique check (payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,252}$'),
  failure_code text check (length(failure_code) between 1 and 80),
  requested_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz
);
create index program_topups_account on public.program_topups(account_id, created_at desc);

-- What each sale earned, one row per sale, decided once and then only reduced.
--   not_earned: the sale earns nothing; `reason` says why.
--   held: commission and fee are set aside from the merchant's balance until hold_until.
--   approved: the hold passed; the commission is the creator's (see program_creator_entries).
--   reversed: the whole commission went back to the merchant (refund or lost dispute in the hold).
create table public.program_commissions (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null unique references public.program_sales(id),
  program_id uuid not null references public.affiliate_programs(id),
  member_id uuid references public.affiliate_program_members(id),
  affiliate_id uuid references public.affiliates(id),
  -- The terms the creator had accepted when the sale was paid.
  terms_version integer,
  status text not null check (status in ('not_earned', 'held', 'approved', 'reversed')),
  reason text check (reason in (
    'no_creator', 'not_a_member', 'outside_duration', 'currency_mismatch', 'program_paused',
    'balance_empty', 'zero_amount', 'refunded')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- What the commission was worked out on: the payment without tax.
  basis_minor bigint check (basis_minor >= 0),
  commission_type text check (commission_type in ('percent', 'fixed')),
  commission_rate_bps integer,
  commission_fixed_minor bigint,
  fee_bps integer check (fee_bps between 0 and 5000),
  -- As first earned, and as it stands now after partial refunds.
  earned_minor bigint not null default 0 check (earned_minor >= 0),
  amount_minor bigint not null default 0 check (amount_minor >= 0 and amount_minor <= earned_minor),
  fee_earned_minor bigint not null default 0 check (fee_earned_minor >= 0),
  fee_minor bigint not null default 0 check (fee_minor >= 0 and fee_minor <= fee_earned_minor),
  hold_until timestamptz,
  approved_at timestamptz,
  reversed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (program_id, terms_version) references public.affiliate_program_terms(program_id, version),
  constraint program_commission_reason check ((status = 'not_earned') = (reason is not null)),
  constraint program_commission_earning_shape check (
    status = 'not_earned'
    or (member_id is not null and affiliate_id is not null and terms_version is not null
      and basis_minor is not null and commission_type is not null and fee_bps is not null
      and hold_until is not null and earned_minor > 0)),
  constraint program_commission_approved check ((status = 'approved') = (approved_at is not null)),
  constraint program_commission_reversed check (status <> 'reversed' or (reversed_at is not null and amount_minor = 0 and fee_minor = 0))
);
create index program_commissions_program on public.program_commissions(program_id, created_at desc);
create index program_commissions_affiliate on public.program_commissions(affiliate_id, created_at desc)
  where affiliate_id is not null;
create index program_commissions_hold on public.program_commissions(hold_until) where status = 'held';

-- Every movement of a merchant's balance. Rows never change. A positive amount adds to
-- what is available, a negative amount takes from it.
create table public.program_balance_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.program_balance_accounts(id),
  kind text not null check (kind in (
    'deposit', 'deposit_reversed', 'commission_reserved', 'commission_returned',
    'fee_reserved', 'fee_returned', 'withdrawal', 'adjustment')),
  amount_minor bigint not null check (amount_minor <> 0),
  available_after_minor bigint not null,
  topup_id uuid references public.program_topups(id),
  commission_id uuid references public.program_commissions(id),
  note text check (length(note) between 1 and 300),
  created_at timestamptz not null default now(),
  constraint program_balance_entry_sign check (
    (kind in ('deposit', 'commission_returned', 'fee_returned') and amount_minor > 0)
    or (kind in ('deposit_reversed', 'commission_reserved', 'fee_reserved', 'withdrawal') and amount_minor < 0)
    or kind = 'adjustment'),
  constraint program_balance_entry_subject check (
    (kind in ('deposit', 'deposit_reversed')) = (topup_id is not null)
    and (kind in ('commission_reserved', 'commission_returned', 'fee_reserved', 'fee_returned')) = (commission_id is not null))
);
create unique index program_balance_one_deposit on public.program_balance_entries(topup_id) where kind = 'deposit';
create unique index program_balance_one_deposit_reversal on public.program_balance_entries(topup_id) where kind = 'deposit_reversed';
create unique index program_balance_one_reserve on public.program_balance_entries(commission_id, kind)
  where kind in ('commission_reserved', 'fee_reserved');
create index program_balance_entries_account on public.program_balance_entries(account_id, created_at desc, id);
create trigger program_balance_entries_are_append_only before update or delete on public.program_balance_entries
  for each row execute function public.reject_mutation();

-- What a creator has coming from a program. Rows never change. The sum per creator and
-- program is what KissMyApps owes them, all of it already collected from the merchant.
-- Payouts (Phase 4, part two) take from it; payout_id has no table to point at yet.
create table public.program_creator_entries (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id),
  program_id uuid not null references public.affiliate_programs(id),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  kind text not null check (kind in ('commission_approved', 'clawback', 'payout', 'payout_reversed', 'adjustment')),
  amount_minor bigint not null check (amount_minor <> 0),
  commission_id uuid references public.program_commissions(id),
  payout_id uuid,
  note text check (length(note) between 1 and 300),
  created_at timestamptz not null default now(),
  constraint program_creator_entry_sign check (
    (kind in ('commission_approved', 'payout_reversed') and amount_minor > 0)
    or (kind in ('clawback', 'payout') and amount_minor < 0)
    or kind = 'adjustment'),
  constraint program_creator_entry_subject check (
    (kind in ('commission_approved', 'clawback')) = (commission_id is not null)
    and (kind in ('payout', 'payout_reversed')) = (payout_id is not null))
);
create unique index program_creator_one_approval on public.program_creator_entries(commission_id) where kind = 'commission_approved';
create index program_creator_entries_owner on public.program_creator_entries(affiliate_id, program_id, created_at desc);
create trigger program_creator_entries_are_append_only before update or delete on public.program_creator_entries
  for each row execute function public.reject_mutation();

-- The one way money moves in or out of a merchant's balance: it writes the entry and the
-- new available amount together, under a lock on the account. Taking money for a
-- commission or its fee is refused when the balance cannot cover it (P0001, DETAIL
-- balance_insufficient), so a commission can never be promised from money that is not there.
create function kma_internal.program_balance_post(
  p_account uuid, p_kind text, p_amount_minor bigint,
  p_topup uuid default null, p_commission uuid default null, p_note text default null
) returns bigint language plpgsql volatile security definer set search_path = '' as $$
declare v_available bigint;
begin
  select a.available_minor into v_available from public.program_balance_accounts a where a.id = p_account for update;
  if not found then
    raise exception 'Balance account not found' using errcode = 'P0002';
  end if;
  if p_kind in ('commission_reserved', 'fee_reserved', 'withdrawal') and v_available + p_amount_minor < 0 then
    raise exception 'The balance cannot cover this' using errcode = 'P0001', detail = 'balance_insufficient';
  end if;
  v_available := v_available + p_amount_minor;
  insert into public.program_balance_entries(account_id, kind, amount_minor, available_after_minor, topup_id, commission_id, note)
  values (p_account, p_kind, p_amount_minor, v_available, p_topup, p_commission, p_note);
  update public.program_balance_accounts set available_minor = v_available, updated_at = now() where id = p_account;
  return v_available;
end $$;
revoke all on function kma_internal.program_balance_post(uuid, text, bigint, uuid, uuid, text)
  from public, anon, authenticated, service_role;

alter table public.program_balance_accounts enable row level security;
alter table public.program_topups enable row level security;
alter table public.program_commissions enable row level security;
alter table public.program_balance_entries enable row level security;
alter table public.program_creator_entries enable row level security;
revoke all on public.program_balance_accounts, public.program_topups, public.program_commissions,
  public.program_balance_entries, public.program_creator_entries
  from public, anon, authenticated, service_role;

commit;
