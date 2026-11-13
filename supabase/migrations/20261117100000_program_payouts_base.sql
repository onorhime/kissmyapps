-- Affiliate self-serve, Phase 4, part two: paying creators. The tables only.
--
-- What a creator is owed is the sum of their rows in program_creator_entries, all of it
-- collected from the merchant before it was approved. A payout takes from that sum and
-- sends it to the creator's own Stripe account as one transfer from the KissMyApps platform
-- account. A payout is made by a KissMyApps admin, never by itself.
--
-- The money leaves the creator's sum the moment the payout is made (entries of kind
-- 'payout'), so nothing else can take it while Stripe is asked. If the payout is canceled
-- or fails for good, the same amounts come back (entries of kind 'payout_reversed').
--
-- Nothing here acts until platform_settings.program_payouts_enabled is true.
begin;

alter table public.platform_settings
  add column program_payouts_enabled boolean not null default false,
  -- The smallest sum, in one currency, that is paid out.
  add column program_min_payout_minor bigint not null default 2500
    check (program_min_payout_minor between 100 and 100000000);

-- One transfer to one creator in one currency.
--   approved: made by an admin, waiting for the worker.
--   processing: the worker has asked Stripe, or is about to.
--   paid: Stripe confirmed the transfer; transfer_id is set.
--   failed: given up; the money is back in the creator's sum.
--   canceled: an admin took it back before the worker started; the money is back.
create table public.program_payouts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id),
  platform_account_id text not null check (platform_account_id ~ '^acct_[A-Za-z0-9]{1,250}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor between 1 and 9007199254740991),
  status text not null default 'approved'
    check (status in ('approved', 'processing', 'paid', 'failed', 'canceled')),
  -- The creator's Stripe account the worker sent to, written when it starts.
  connect_account_id text check (connect_account_id ~ '^acct_[A-Za-z0-9]{1,250}$'),
  transfer_id text unique check (transfer_id ~ '^tr_[A-Za-z0-9]{1,250}$'),
  failure_code text check (failure_code ~ '^[a-z][a-z0-9_]{1,79}$'),
  attempts integer not null default 0 check (attempts >= 0),
  -- The first time Stripe was asked. Stripe forgets an idempotency key after a day, so a
  -- payout older than that is only ever looked up, never asked for again.
  first_attempt_at timestamptz,
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  approved_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  closed_at timestamptz,
  constraint program_payout_paid check ((status = 'paid') = (paid_at is not null) and (status <> 'paid' or transfer_id is not null)),
  constraint program_payout_closed check ((status in ('paid', 'failed', 'canceled')) = (closed_at is not null)),
  constraint program_payout_lease check ((lease_token is null) = (lease_until is null))
);
-- A creator has at most one payout under way per platform and currency.
create unique index program_payouts_one_open on public.program_payouts(affiliate_id, platform_account_id, currency)
  where status in ('approved', 'processing');
create index program_payouts_due on public.program_payouts(next_attempt_at) where status in ('approved', 'processing');
create index program_payouts_creator on public.program_payouts(affiliate_id, created_at desc);

-- What each program contributes to a payout. The entries of kind 'payout' mirror these rows.
create table public.program_payout_items (
  payout_id uuid not null references public.program_payouts(id),
  program_id uuid not null references public.affiliate_programs(id),
  amount_minor bigint not null check (amount_minor > 0),
  primary key (payout_id, program_id)
);
create trigger program_payout_items_are_append_only before update or delete on public.program_payout_items
  for each row execute function public.reject_mutation();

-- payout_id on a creator entry now has a table to point at.
alter table public.program_creator_entries
  add constraint program_creator_entries_payout_fk foreign key (payout_id) references public.program_payouts(id);
create index program_creator_entries_payout on public.program_creator_entries(payout_id) where payout_id is not null;
-- A payout takes from a program once, and gives back once.
create unique index program_creator_one_payout on public.program_creator_entries(payout_id, program_id) where kind = 'payout';
create unique index program_creator_one_payout_reversal on public.program_creator_entries(payout_id, program_id)
  where kind = 'payout_reversed';

alter table public.program_payouts enable row level security;
alter table public.program_payout_items enable row level security;
revoke all on public.program_payouts, public.program_payout_items from public, anon, authenticated, service_role;

commit;
