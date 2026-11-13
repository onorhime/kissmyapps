-- Affiliate self-serve, Phase 8: the shared storage only.
--
-- Phase 8 adds three ways for a program to earn and one way to share attribution:
--   * a KissMyApps checkout link: a creator's link opens a Stripe Checkout that KissMyApps
--     starts on the merchant's own Stripe account (payment_mode 'kma_checkout');
--   * creator promo codes: each creator gets a Stripe promotion code on the merchant's account,
--     and a sale that used it goes to that creator;
--   * in-app subscriptions bought through the App Store or Google Play and reported by
--     RevenueCat or Adapty;
--   * install sources sent to the merchant's Amplitude (its own migration).
--
-- This file only adds the columns and the one table more than one later migration reads, so
-- each can be written and tested alone. Nothing here acts by itself.
begin;

-- A program's payment mode: the merchant's own checkout (Phases 2 to 7) or a checkout link
-- KissMyApps starts on the merchant's Stripe account.
alter table public.affiliate_programs drop constraint affiliate_programs_payment_mode_check;
alter table public.affiliate_programs add constraint affiliate_programs_payment_mode_check
  check (payment_mode in ('own_checkout', 'kma_checkout'));

-- Where a sale came from, and how its creator was found.
alter table public.program_sales
  add column source text not null default 'stripe' check (source in ('stripe', 'revenuecat', 'adapty')),
  -- The Stripe promotion code the buyer used (promo_...), whatever matched the sale.
  add column promotion_code_id text check (promotion_code_id ~ '^promo_[A-Za-z0-9]{1,250}$'),
  -- A store purchase: the store, its transaction, the first transaction of its subscription and
  -- the store's product ID, as RevenueCat or Adapty report them.
  add column store text check (store in ('app_store', 'play_store', 'stripe', 'amazon', 'other')),
  add column store_transaction_id text check (length(store_transaction_id) between 1 and 200),
  add column store_original_transaction_id text check (length(store_original_transaction_id) between 1 and 200),
  add column store_product_id text check (length(store_product_id) between 1 and 200),
  add constraint program_sale_store_shape check (
    (source = 'stripe') = (store_transaction_id is null));
alter table public.program_sales drop constraint program_sales_match_source_check;
alter table public.program_sales add constraint program_sales_match_source_check
  check (match_source in ('metadata', 'client_reference_id', 'subscription', 'email', 'none',
    'promotion_code', 'app_user'));
create index program_sales_promotion_code on public.program_sales(account_id, promotion_code_id)
  where promotion_code_id is not null;

-- One promo code per creator and program, made on the merchant's Stripe account.
create table public.program_promo_codes (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.affiliate_programs(id) on delete cascade,
  member_id uuid not null references public.affiliate_program_members(id) on delete cascade,
  -- What the buyer types, as shown: letters and digits, 3 to 20.
  code text not null check (code ~ '^[A-Z0-9]{3,20}$'),
  -- The merchant's Stripe account the code lives on.
  account_id text not null check (account_id ~ '^acct_[A-Za-z0-9]+$'),
  -- The buyer discount the code gives, in basis points (1000 = 10%), as the program set it
  -- when the code was made.
  discount_bps integer not null check (discount_bps between 100 and 9000),
  stripe_coupon_id text check (length(stripe_coupon_id) between 1 and 200),
  stripe_promotion_code_id text check (stripe_promotion_code_id ~ '^promo_[A-Za-z0-9]{1,250}$'),
  -- pending: waiting for the worker to make it on Stripe; active: buyers can use it;
  -- failed: Stripe refused (last_error says why); retired: switched off (the creator left, the
  -- program changed its discount or stopped codes).
  status text not null default 'pending' check (status in ('pending', 'active', 'failed', 'retired')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (length(last_error) <= 500),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz,
  constraint program_promo_code_active check ((status = 'active') = (stripe_promotion_code_id is not null and retired_at is null))
);
-- A code is unique on its Stripe account while it is not retired, as Stripe requires.
create unique index program_promo_codes_code on public.program_promo_codes(account_id, code)
  where status <> 'retired';
create unique index program_promo_codes_member on public.program_promo_codes(program_id, member_id)
  where status <> 'retired';
create unique index program_promo_codes_stripe on public.program_promo_codes(account_id, stripe_promotion_code_id)
  where stripe_promotion_code_id is not null;
create index program_promo_codes_pending on public.program_promo_codes(created_at) where status = 'pending';

alter table public.program_promo_codes enable row level security;
revoke all on public.program_promo_codes from public, anon, authenticated, service_role;

commit;
