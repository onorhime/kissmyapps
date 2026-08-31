create extension if not exists pgcrypto with schema extensions;

create type public.product_status as enum ('draft', 'active', 'paused', 'archived');
create type public.affiliate_status as enum ('draft', 'invited', 'active', 'paused', 'terminated');
create type public.partner_entity_type as enum ('individual', 'company');
create type public.agreement_status as enum ('draft', 'awaiting_signature', 'active', 'superseded', 'expired', 'terminated');
create type public.rule_status as enum ('draft', 'active', 'superseded');
create type public.commission_model as enum ('cpl', 'cpa', 'revenue_share', 'hybrid');
create type public.attribution_method as enum ('deterministic_web', 'singular', 'manual');
create type public.acquisition_status as enum ('open', 'resolved', 'rejected');
create type public.event_source as enum ('first_party', 'stripe', 'singular', 'manual');
create type public.subscription_status as enum ('incomplete', 'trialing', 'active', 'past_due', 'cancelled', 'unpaid');
create type public.entitlement_status as enum ('inactive', 'trialing', 'active', 'grace_period', 'revoked', 'expired');
create type public.link_status as enum ('active', 'paused', 'archived');
create type public.period_status as enum ('open', 'review', 'closed');
create type public.payout_status as enum ('open', 'review', 'approved', 'scheduled', 'paid', 'on_hold', 'failed', 'carried_forward');
create type public.ledger_entry_type as enum ('commission', 'adjustment', 'refund_reversal', 'dispute_reversal', 'dispute_offset', 'carry_forward');
create type public.payment_method as enum ('bank', 'crypto');
create type public.destination_status as enum ('draft', 'verification_pending', 'pending_hold', 'active', 'replaced', 'revoked');
create type public.verification_status as enum ('not_started', 'pending', 'passed', 'failed');
create type public.document_status as enum ('draft', 'awaiting_partner_signature', 'awaiting_kissmyapps_signature', 'signed', 'active', 'superseded', 'expired', 'terminated');
create type public.provider_name as enum ('stripe', 'singular', 'click_tracker');
create type public.processing_status as enum ('pending', 'processing', 'processed', 'failed');
create type public.metric_completeness as enum ('partial', 'complete');
create type public.reconciliation_stage as enum ('preliminary', 'reconciled', 'finalized');
create type public.reconciliation_status as enum ('queued', 'running', 'passed', 'failed');
create type public.exception_status as enum ('open', 'investigating', 'resolved', 'ignored');

create table public.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 1 and 120),
  status public.product_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.platform_settings (
  singleton boolean primary key default true check (singleton),
  tracking_base_url text check (
    tracking_base_url is null
    or (tracking_base_url ~ '^https://' and tracking_base_url !~ '/$' and char_length(tracking_base_url) <= 500)
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  full_name text check (full_name is null or char_length(full_name) between 1 and 120),
  preferred_timezone text not null default 'UTC' check (char_length(preferred_timezone) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'operations', 'finance', 'analyst', 'support')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.affiliates (
  id uuid primary key default gen_random_uuid(),
  public_name text not null check (char_length(public_name) between 1 and 100),
  legal_name text check (legal_name is null or char_length(legal_name) between 1 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  entity_type public.partner_entity_type,
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  reporting_timezone text not null default 'UTC' check (char_length(reporting_timezone) between 1 and 80),
  preferred_currency text not null default 'USD' check (preferred_currency ~ '^[A-Z]{3}$'),
  website_url text check (website_url is null or (char_length(website_url) <= 500 and website_url ~ '^https://')),
  category text check (category is null or char_length(category) <= 100),
  audience_description text check (audience_description is null or char_length(audience_description) <= 1000),
  audience_countries text[] not null default '{}',
  channels text[] not null default '{}',
  channel_details text check (channel_details is null or char_length(channel_details) <= 1000),
  status public.affiliate_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(audience_countries) <= 100),
  check (cardinality(channels) <= 50)
);

create table public.affiliate_users (
  affiliate_id uuid not null references public.affiliates (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'finance', 'analyst', 'member')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (affiliate_id, user_id)
);

create unique index affiliate_users_one_active_partner_per_user
  on public.affiliate_users (user_id)
  where active;

create table public.affiliate_settings (
  affiliate_id uuid not null references public.affiliates (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  notify_statements boolean not null default true,
  notify_payouts boolean not null default true,
  notify_verification boolean not null default true,
  notify_signatures boolean not null default true,
  notify_adjustments boolean not null default true,
  notify_inactive_links boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (affiliate_id, user_id)
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  external_key text unique,
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  device_locale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (auth_user_id is not null or external_key is not null)
);

create table public.agreements (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates (id),
  product_id uuid not null references public.products (id),
  version integer not null check (version > 0),
  model public.commission_model not null,
  status public.agreement_status not null default 'draft',
  attribution_window_days integer not null default 30 check (attribution_window_days between 1 and 365),
  renewal_duration_days integer check (renewal_duration_days is null or renewal_duration_days > 0),
  payout_frequency_days integer not null default 14 check (payout_frequency_days > 0),
  payout_currency text not null default 'USD' check (payout_currency ~ '^[A-Z]{3}$'),
  minimum_payout_minor bigint not null default 10000 check (minimum_payout_minor >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (affiliate_id, product_id, version),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (status <> 'active' or starts_at is not null)
);

create unique index agreements_one_active_per_affiliate_product
  on public.agreements (affiliate_id, product_id)
  where status = 'active';

create table public.commission_rules (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.agreements (id),
  name text not null check (char_length(name) between 1 and 120),
  version integer not null default 1 check (version > 0),
  status public.rule_status not null default 'draft',
  model public.commission_model not null,
  trigger_event text not null check (trigger_event ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  fixed_amount_minor bigint,
  rate_basis_points integer,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  validation_window_hours integer not null default 72 check (validation_window_hours > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agreement_id, name, version),
  check (
    (model in ('cpl', 'cpa') and fixed_amount_minor > 0 and rate_basis_points is null and currency is not null)
    or (model = 'revenue_share' and fixed_amount_minor is null and rate_basis_points between 1 and 10000 and currency is null)
    or (model = 'hybrid' and fixed_amount_minor > 0 and rate_basis_points between 1 and 10000 and currency is not null)
  )
);

create unique index commission_rules_one_active_name
  on public.commission_rules (agreement_id, name)
  where status = 'active';

create table public.funnels (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id),
  key text not null check (key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 1 and 120),
  destination_url text,
  status text not null default 'draft' check (status in ('draft', 'live', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, key),
  check (destination_url is null or (char_length(destination_url) <= 2000 and destination_url ~ '^https://')),
  check (status <> 'live' or destination_url is not null)
);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id),
  key text not null check (key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 1 and 120),
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'active', 'completed', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, key),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table public.affiliate_links (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates (id),
  product_id uuid not null references public.products (id),
  source_id uuid references public.sources (id),
  campaign_id uuid references public.campaigns (id),
  funnel_id uuid not null references public.funnels (id),
  name text not null check (char_length(name) between 1 and 120),
  public_code text not null unique check (public_code ~ '^[a-zA-Z0-9_-]{16,64}$'),
  tracking_url text not null check (tracking_url ~ '^https://' and char_length(tracking_url) <= 1000),
  parent_link_id uuid references public.affiliate_links (id),
  sub1 text not null check (char_length(sub1) <= 64 and sub1 ~ '^[A-Za-z0-9_-]+$'),
  sub2 text check (sub2 is null or (char_length(sub2) <= 64 and sub2 ~ '^[A-Za-z0-9_-]+$')),
  sub3 text check (sub3 is null or (char_length(sub3) <= 64 and sub3 ~ '^[A-Za-z0-9_-]+$')),
  status public.link_status not null default 'active',
  status_changed_at timestamptz not null default now(),
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'archived' and archived_at is not null) or status <> 'archived')
);

create unique index affiliate_links_active_dimensions_unique
  on public.affiliate_links (
    affiliate_id,
    product_id,
    coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid),
    funnel_id,
    coalesce(sub1, ''),
    coalesce(sub2, ''),
    coalesce(sub3, '')
  )
  where status <> 'archived';

create table public.clicks (
  id uuid primary key default gen_random_uuid(),
  public_click_id text not null unique check (public_click_id ~ '^[A-Za-z0-9_-]{16,128}$'),
  affiliate_link_id uuid not null references public.affiliate_links (id),
  affiliate_id uuid not null references public.affiliates (id),
  product_id uuid not null references public.products (id),
  source_id uuid references public.sources (id),
  campaign_id uuid references public.campaigns (id),
  funnel_id uuid not null references public.funnels (id),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  session_id_hash text,
  user_agent_hash text,
  ip_hash text,
  is_bot boolean not null default false,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.acquisitions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id),
  affiliate_id uuid references public.affiliates (id),
  click_record_id uuid references public.clicks (id),
  account_id uuid references public.accounts (id),
  source_id uuid references public.sources (id),
  campaign_id uuid references public.campaigns (id),
  funnel_id uuid references public.funnels (id),
  singular_id text,
  click_country text check (click_country is null or click_country ~ '^[A-Z]{2}$'),
  install_country text check (install_country is null or install_country ~ '^[A-Z]{2}$'),
  attribution_method public.attribution_method not null,
  status public.acquisition_status not null default 'open',
  rejection_reason text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status = 'rejected' and rejection_reason is not null) or (status <> 'rejected' and rejection_reason is null)),
  check ((status = 'resolved' and resolved_at is not null) or status <> 'resolved'),
  check (
    (attribution_method = 'deterministic_web' and click_record_id is not null)
    or (attribution_method = 'singular' and singular_id is not null)
    or attribution_method = 'manual'
  )
);

create unique index acquisitions_one_per_click
  on public.acquisitions (click_record_id)
  where click_record_id is not null;

create unique index acquisitions_one_per_singular_product
  on public.acquisitions (product_id, singular_id)
  where singular_id is not null;

create table public.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider public.provider_name not null,
  provider_event_id text not null,
  event_type text not null,
  schema_version integer not null default 1 check (schema_version > 0),
  payload jsonb not null,
  signature_verified boolean not null default false,
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create table public.provider_event_processing (
  provider_event_id uuid primary key references public.provider_events (id) on delete cascade,
  status public.processing_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  processing_error text,
  claimed_at timestamptz,
  processed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((status = 'processed' and processed_at is not null and processing_error is null) or status <> 'processed'),
  check ((status = 'failed' and processing_error is not null) or status <> 'failed')
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  source public.event_source not null,
  source_event_id text not null,
  schema_version integer not null default 1 check (schema_version > 0),
  event_name text not null check (event_name ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  product_id uuid not null references public.products (id),
  affiliate_id uuid references public.affiliates (id),
  acquisition_id uuid references public.acquisitions (id),
  account_id uuid references public.accounts (id),
  source_id uuid references public.sources (id),
  campaign_id uuid references public.campaigns (id),
  funnel_id uuid references public.funnels (id),
  provider_event_id uuid references public.provider_events (id),
  properties jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (source, source_event_id)
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  product_id uuid not null references public.products (id),
  acquisition_id uuid references public.acquisitions (id),
  stripe_customer_id text not null,
  stripe_subscription_id text not null unique,
  status public.subscription_status not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  current_period_starts_at timestamptz,
  current_period_ends_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (current_period_ends_at is null or current_period_starts_at is null or current_period_ends_at > current_period_starts_at)
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions (id),
  acquisition_id uuid references public.acquisitions (id),
  provider_event_id uuid not null references public.provider_events (id),
  stripe_invoice_id text not null unique,
  balance_transaction_id text unique,
  kind text not null check (kind in ('first_purchase', 'renewal')),
  gross_minor bigint not null check (gross_minor >= 0),
  fee_minor bigint not null default 0 check (fee_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  settlement_adjustment_minor bigint not null default 0,
  eligible_net_minor bigint not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  settled_currency text not null check (settled_currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index transactions_one_fact_per_provider_event
  on public.transactions (provider_event_id);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions (id),
  provider_event_id uuid not null references public.provider_events (id),
  stripe_refund_id text not null unique,
  amount_minor bigint not null check (amount_minor > 0),
  balance_impact_minor bigint not null check (balance_impact_minor <= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index refunds_one_fact_per_provider_event
  on public.refunds (provider_event_id);

create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions (id),
  provider_event_id uuid not null references public.provider_events (id),
  stripe_dispute_id text not null,
  status text not null check (status in ('open', 'won', 'lost', 'warning_closed')),
  disputed_minor bigint not null check (disputed_minor > 0),
  fee_minor bigint not null default 0 check (fee_minor >= 0),
  balance_impact_minor bigint not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (stripe_dispute_id, provider_event_id)
);

create unique index disputes_one_fact_per_provider_event
  on public.disputes (provider_event_id);

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  product_id uuid not null references public.products (id),
  subscription_id uuid references public.subscriptions (id),
  status public.entitlement_status not null default 'inactive',
  starts_at timestamptz,
  ends_at timestamptz,
  source text not null default 'stripe' check (source in ('stripe', 'manual', 'promotion')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, product_id),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table public.conversions (
  id uuid primary key default gen_random_uuid(),
  acquisition_id uuid not null references public.acquisitions (id),
  affiliate_id uuid not null references public.affiliates (id),
  product_id uuid not null references public.products (id),
  agreement_id uuid not null references public.agreements (id),
  commission_rule_id uuid not null references public.commission_rules (id),
  event_id uuid not null references public.events (id),
  event_name text not null,
  account_id uuid references public.accounts (id),
  transaction_id uuid references public.transactions (id),
  qualified boolean not null default true,
  rejection_reason text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  check ((qualified and rejection_reason is null) or (not qualified and rejection_reason is not null))
);

create unique index conversions_transaction_dedupe
  on public.conversions (acquisition_id, agreement_id, commission_rule_id, event_name, transaction_id)
  where transaction_id is not null;

create unique index conversions_non_transaction_dedupe
  on public.conversions (acquisition_id, agreement_id, commission_rule_id, event_name)
  where transaction_id is null;

create table public.payout_periods (
  id uuid primary key default gen_random_uuid(),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  review_starts_at timestamptz not null,
  payout_due_at timestamptz not null,
  status public.period_status not null default 'open',
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (starts_at, ends_at),
  check (ends_at > starts_at),
  check (review_starts_at >= ends_at),
  check (payout_due_at >= review_starts_at),
  check ((status = 'closed' and closed_at is not null) or status <> 'closed')
);

create table public.commission_entries (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates (id),
  product_id uuid not null references public.products (id),
  agreement_id uuid not null references public.agreements (id),
  commission_rule_id uuid references public.commission_rules (id),
  conversion_id uuid references public.conversions (id),
  transaction_id uuid references public.transactions (id),
  source_payout_id uuid,
  payout_period_id uuid not null references public.payout_periods (id),
  entry_type public.ledger_entry_type not null,
  amount_minor bigint not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  source_key text not null unique,
  partner_visible_description text not null check (char_length(partner_visible_description) between 1 and 500),
  internal_note text,
  created_at timestamptz not null default now(),
  check (amount_minor <> 0),
  check (entry_type <> 'commission' or amount_minor > 0),
  check (entry_type not in ('refund_reversal', 'dispute_reversal', 'dispute_offset') or amount_minor < 0),
  check (entry_type <> 'commission' or (commission_rule_id is not null and conversion_id is not null)),
  check ((entry_type = 'carry_forward' and source_payout_id is not null) or (entry_type <> 'carry_forward' and source_payout_id is null))
);

create table public.payout_destinations (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates (id),
  version integer not null check (version > 0),
  method public.payment_method not null,
  display_label text not null check (char_length(display_label) between 1 and 160),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  provider_reference text not null,
  status public.destination_status not null default 'draft',
  verification_status public.verification_status not null default 'not_started',
  verification_method text,
  verified_at timestamptz,
  reauthenticated_at timestamptz not null,
  email_confirmed_at timestamptz not null,
  hold_until timestamptz not null,
  effective_at timestamptz,
  test_transfer_status public.verification_status not null default 'not_started',
  test_transfer_completed_at timestamptz,
  replacement_id uuid references public.payout_destinations (id),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (affiliate_id, version),
  check (hold_until >= created_at + interval '48 hours'),
  check (reauthenticated_at <= created_at and reauthenticated_at >= created_at - interval '30 minutes'),
  check (email_confirmed_at <= created_at and email_confirmed_at >= created_at - interval '24 hours'),
  check ((verification_status = 'passed' and verified_at is not null) or verification_status <> 'passed'),
  check ((test_transfer_status = 'passed' and test_transfer_completed_at is not null) or test_transfer_status <> 'passed'),
  check (
    status <> 'active'
    or (
      verification_status = 'passed'
      and verified_at is not null
      and effective_at is not null
      and effective_at >= hold_until
      and (method <> 'crypto' or (test_transfer_status = 'passed' and test_transfer_completed_at is not null))
    )
  ),
  check ((status = 'replaced' and replacement_id is not null) or status <> 'replaced')
);

create unique index payout_destinations_one_active_currency
  on public.payout_destinations (affiliate_id, currency)
  where status = 'active';

create table public.payout_destination_events (
  id uuid primary key default gen_random_uuid(),
  payout_destination_id uuid not null references public.payout_destinations (id),
  status public.destination_status not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  reason text,
  created_at timestamptz not null default now()
);

create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates (id),
  product_id uuid not null references public.products (id),
  payout_period_id uuid not null references public.payout_periods (id),
  status public.payout_status not null default 'open',
  eligible_net_minor bigint not null default 0,
  earnings_minor bigint not null default 0,
  adjustments_minor bigint not null default 0,
  carry_in_minor bigint not null default 0,
  carry_out_minor bigint not null default 0,
  final_payout_minor bigint not null default 0 check (final_payout_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  minimum_payout_minor_snapshot bigint check (minimum_payout_minor_snapshot is null or minimum_payout_minor_snapshot >= 0),
  payout_frequency_days_snapshot integer check (payout_frequency_days_snapshot is null or payout_frequency_days_snapshot > 0),
  payout_destination_id uuid references public.payout_destinations (id),
  payment_method_snapshot public.payment_method,
  destination_label_snapshot text,
  destination_version_snapshot integer,
  calculation_finalized_at timestamptz,
  calculation_finalized_by uuid references auth.users (id) on delete restrict,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete restrict,
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete restrict,
  scheduled_at timestamptz,
  statement_number text unique,
  statement_storage_path text,
  payment_reference text,
  paid_at timestamptz,
  hold_reason text,
  held_from_status public.payout_status check (
    held_from_status is null or held_from_status in ('open', 'review', 'approved', 'scheduled', 'failed')
  ),
  failure_reason text,
  reconciliation_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (affiliate_id, product_id, payout_period_id),
  check (final_payout_minor = earnings_minor + adjustments_minor + carry_in_minor - carry_out_minor),
  check (status not in ('review', 'approved', 'scheduled', 'paid', 'carried_forward') or (reviewed_at is not null and reviewed_by is not null)),
  check (status not in ('approved', 'scheduled', 'paid') or (approved_at is not null and approved_by is not null)),
  check (status not in ('approved', 'scheduled', 'paid', 'carried_forward') or (calculation_finalized_at is not null and calculation_finalized_by is not null)),
  check (status not in ('scheduled', 'paid') or scheduled_at is not null),
  check (status <> 'paid' or (paid_at is not null and payment_reference is not null)),
  check (status <> 'on_hold' or (hold_reason is not null and held_from_status is not null)),
  check (status <> 'failed' or failure_reason is not null),
  check (status <> 'carried_forward' or final_payout_minor = 0),
  check (
    payout_destination_id is null
    or (payment_method_snapshot is not null and destination_label_snapshot is not null and destination_version_snapshot is not null)
  ),
  check (statement_storage_path is null or statement_storage_path ~ ('^' || affiliate_id::text || '/'))
);

alter table public.commission_entries
  add constraint commission_entries_source_payout_fk
  foreign key (source_payout_id) references public.payouts (id);

create table public.payout_agreement_snapshots (
  payout_id uuid not null references public.payouts (id),
  agreement_id uuid not null references public.agreements (id),
  agreement_version integer not null check (agreement_version > 0),
  model public.commission_model not null,
  attribution_window_days integer not null check (attribution_window_days between 1 and 365),
  payout_frequency_days integer not null check (payout_frequency_days > 0),
  payout_currency text not null check (payout_currency ~ '^[A-Z]{3}$'),
  minimum_payout_minor bigint not null check (minimum_payout_minor >= 0),
  rules_snapshot jsonb not null,
  snapshotted_at timestamptz not null default now(),
  primary key (payout_id, agreement_id)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates (id),
  agreement_id uuid references public.agreements (id),
  name text not null check (char_length(name) between 1 and 160),
  document_type text not null check (char_length(document_type) between 1 and 100),
  version integer not null check (version > 0),
  file_path text not null check (file_path ~ ('^' || affiliate_id::text || '/')),
  status public.document_status not null default 'draft',
  effective_at timestamptz,
  expires_at timestamptz,
  terminated_at timestamptz,
  signed_by_partner_at timestamptz,
  signed_by_kissmyapps_at timestamptz,
  supersedes_document_id uuid references public.documents (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (affiliate_id, document_type, version),
  check (expires_at is null or effective_at is null or expires_at > effective_at),
  check (status <> 'terminated' or terminated_at is not null),
  check (status not in ('signed', 'active') or (signed_by_partner_at is not null and signed_by_kissmyapps_at is not null))
);

create table public.affiliate_daily_metrics (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates (id),
  product_id uuid not null references public.products (id),
  affiliate_link_id uuid references public.affiliate_links (id),
  metric_date date not null,
  source_id uuid references public.sources (id),
  campaign_id uuid references public.campaigns (id),
  funnel_id uuid references public.funnels (id),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  sub1 text,
  sub2 text,
  sub3 text,
  clicks bigint not null default 0 check (clicks >= 0),
  visitors bigint not null default 0 check (visitors >= 0),
  funnel_starts bigint not null default 0 check (funnel_starts >= 0),
  payment_views bigint not null default 0 check (payment_views >= 0),
  app_store_clicks bigint not null default 0 check (app_store_clicks >= 0),
  leads bigint not null default 0 check (leads >= 0),
  trials bigint not null default 0 check (trials >= 0),
  installs bigint not null default 0 check (installs >= 0),
  purchases bigint not null default 0 check (purchases >= 0),
  renewals bigint not null default 0 check (renewals >= 0),
  cancellations bigint not null default 0 check (cancellations >= 0),
  activations bigint not null default 0 check (activations >= 0),
  refunds bigint not null default 0 check (refunds >= 0),
  disputes bigint not null default 0 check (disputes >= 0),
  gross_collected_minor bigint not null default 0,
  eligible_revenue_minor bigint not null default 0,
  earnings_minor bigint not null default 0,
  active_subscriptions bigint not null default 0 check (active_subscriptions >= 0),
  is_subscription_snapshot boolean not null default false,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  completeness public.metric_completeness not null default 'partial',
  reconciliation_stage public.reconciliation_stage not null default 'preliminary',
  reconciled_through date,
  source_freshness jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (
    affiliate_id, product_id, affiliate_link_id, metric_date, source_id, campaign_id, funnel_id,
    country_code, sub1, sub2, sub3, is_subscription_snapshot
  ),
  check (reconciliation_stage = 'preliminary' or completeness = 'complete'),
  check (reconciliation_stage = 'preliminary' or reconciled_through >= metric_date),
  check (
    (
      is_subscription_snapshot
      and affiliate_link_id is null and source_id is null and campaign_id is null and funnel_id is null
      and country_code is null and sub1 is null and sub2 is null and sub3 is null
      and clicks = 0 and visitors = 0 and funnel_starts = 0 and payment_views = 0
      and app_store_clicks = 0 and leads = 0 and trials = 0 and installs = 0
      and purchases = 0 and renewals = 0 and cancellations = 0 and activations = 0
      and refunds = 0 and disputes = 0 and gross_collected_minor = 0
      and eligible_revenue_minor = 0 and earnings_minor = 0
    )
    or (not is_subscription_snapshot and active_subscriptions = 0)
  )
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_type text not null check (actor_type in ('admin', 'affiliate', 'customer', 'service', 'system')),
  action text not null,
  target_table text not null,
  target_id uuid,
  reason text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  provider public.provider_name not null default 'stripe',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status public.reconciliation_status not null default 'queued',
  idempotency_key text not null unique,
  provider_total_minor bigint,
  internal_total_minor bigint,
  unexplained_difference_minor bigint,
  exception_count integer not null default 0 check (exception_count >= 0),
  details jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((status = 'running' and started_at is not null) or status <> 'running'),
  check (status not in ('passed', 'failed') or completed_at is not null),
  check (
    status <> 'passed'
    or (
      provider_total_minor is not null
      and internal_total_minor is not null
      and unexplained_difference_minor = 0
      and exception_count = 0
    )
  ),
  check (
    provider_total_minor is null
    or internal_total_minor is null
    or unexplained_difference_minor = provider_total_minor - internal_total_minor
  )
);

create table public.reconciliation_exceptions (
  id uuid primary key default gen_random_uuid(),
  reconciliation_run_id uuid not null references public.reconciliation_runs (id),
  source_key text not null,
  category text not null,
  status public.exception_status not null default 'open',
  amount_minor bigint,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  summary text not null,
  resolution_note text,
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reconciliation_run_id, source_key),
  check ((status = 'resolved' and resolved_at is not null and resolution_note is not null) or status <> 'resolved')
);

alter table public.payouts
  add constraint payouts_reconciliation_run_fk
  foreign key (reconciliation_run_id) references public.reconciliation_runs (id);

create index affiliate_users_user_id_idx on public.affiliate_users (user_id) where active;
create index agreements_affiliate_product_idx on public.agreements (affiliate_id, product_id, status);
create index affiliate_links_affiliate_idx on public.affiliate_links (affiliate_id, status, created_at desc);
create index clicks_affiliate_occurred_idx on public.clicks (affiliate_id, occurred_at desc);
create index acquisitions_affiliate_created_idx on public.acquisitions (affiliate_id, created_at desc);
create index events_affiliate_occurred_idx on public.events (affiliate_id, occurred_at desc);
create index subscriptions_account_product_idx on public.subscriptions (account_id, product_id);
create index commission_entries_affiliate_period_idx on public.commission_entries (affiliate_id, payout_period_id, currency);
create unique index commission_entries_one_carry_consumption
  on public.commission_entries (source_payout_id)
  where entry_type = 'carry_forward';
create unique index commission_entries_one_commission_per_conversion
  on public.commission_entries (conversion_id)
  where entry_type = 'commission';
create index payouts_affiliate_status_idx on public.payouts (affiliate_id, status, created_at desc);
create index documents_affiliate_status_idx on public.documents (affiliate_id, status);
create index affiliate_daily_metrics_query_idx on public.affiliate_daily_metrics (affiliate_id, product_id, metric_date);
create index reconciliation_exceptions_queue_idx on public.reconciliation_exceptions (status, created_at);
create unique index reconciliation_runs_one_live_window
  on public.reconciliation_runs (provider, starts_at, ends_at, currency)
  where status in ('queued', 'running', 'passed');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end;
$$;

create or replace function public.validate_reporting_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  timezone_name text;
begin
  timezone_name := case tg_table_name
    when 'profiles' then to_jsonb(new) ->> 'preferred_timezone'
    when 'affiliates' then to_jsonb(new) ->> 'reporting_timezone'
  end;
  if timezone_name is null or not exists (
    select 1 from pg_catalog.pg_timezone_names as timezone where timezone.name = timezone_name
  ) then
    raise exception 'reporting timezone must be a valid IANA timezone name' using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace function public.current_user_is_admin(required_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users as admin_user
    where admin_user.user_id = auth.uid()
      and admin_user.active
      and admin_user.role = any(required_roles)
  );
$$;

create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_is_admin(array['owner', 'operations', 'finance', 'analyst', 'support']::text[]);
$$;

create or replace function public.current_user_has_affiliate_role(
  target_affiliate_id uuid,
  required_roles text[],
  require_active_affiliate boolean default false
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.affiliate_users as membership
    join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
    where membership.user_id = auth.uid()
      and membership.affiliate_id = target_affiliate_id
      and membership.active
      and membership.role = any(required_roles)
      and (
        (require_active_affiliate and affiliate.status = 'active')
        or (not require_active_affiliate and affiliate.status in ('active', 'paused'))
      )
  );
$$;

create or replace function public.current_user_has_affiliate(target_affiliate_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_user_has_affiliate_role(
    target_affiliate_id,
    array['owner', 'finance', 'analyst', 'member']::text[],
    false
  );
$$;

create or replace function public.current_partner_affiliate_id(require_active_affiliate boolean default false)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  affiliate_ids uuid[];
begin
  select array_agg(membership.affiliate_id)
  into affiliate_ids
  from public.affiliate_users as membership
  join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
  where membership.user_id = auth.uid()
    and membership.active
    and (
      (require_active_affiliate and affiliate.status = 'active')
      or (not require_active_affiliate and affiliate.status in ('active', 'paused'))
    );

  if coalesce(cardinality(affiliate_ids), 0) = 0 then
    raise exception 'no authorized partner workspace' using errcode = '42501';
  end if;
  if cardinality(affiliate_ids) <> 1 then
    raise exception 'partner workspace is ambiguous' using errcode = '42501';
  end if;
  return affiliate_ids[1];
end;
$$;

create or replace function public.current_user_can_view_product(target_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.affiliate_users as membership
    join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
    where membership.user_id = auth.uid()
      and membership.active
      and affiliate.status in ('active', 'paused')
      and (
        exists (
          select 1 from public.agreements as agreement
          where agreement.affiliate_id = membership.affiliate_id
            and agreement.product_id = target_product_id
        )
        or exists (
          select 1 from public.affiliate_links as link
          where link.affiliate_id = membership.affiliate_id
            and link.product_id = target_product_id
        )
        or exists (
          select 1 from public.payouts as payout
          where payout.affiliate_id = membership.affiliate_id
            and payout.product_id = target_product_id
        )
        or exists (
          select 1 from public.affiliate_daily_metrics as metric
          where metric.affiliate_id = membership.affiliate_id
            and metric.product_id = target_product_id
        )
      )
  );
$$;

create or replace function public.storage_path_affiliate_id(object_name text)
returns uuid
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  path_prefix text;
begin
  path_prefix := split_part(object_name, '/', 1);
  if path_prefix ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return path_prefix::uuid;
  end if;
  return null;
end;
$$;

create or replace function public.current_user_can_download_storage_object(
  target_bucket_id text,
  target_object_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    target_bucket_id = 'affiliate-private-documents'
    and public.current_user_has_affiliate(public.storage_path_affiliate_id(target_object_name))
    and (
      exists (
        select 1
        from public.documents as document
        where document.affiliate_id = public.storage_path_affiliate_id(target_object_name)
          and document.file_path = target_object_name
          and document.status <> 'draft'
      )
      or exists (
        select 1
        from public.payouts as payout
        where payout.affiliate_id = public.storage_path_affiliate_id(target_object_name)
          and payout.statement_storage_path = target_object_name
          and payout.calculation_finalized_at is not null
          and payout.status in ('approved', 'scheduled', 'paid', 'on_hold', 'failed', 'carried_forward')
      )
    );
$$;

create or replace function public.protect_agreement_history()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  active_rules integer;
  has_fixed boolean;
  has_rate boolean;
  incompatible_rules integer;
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'awaiting_signature') then
      raise exception 'agreement versions must begin in draft or awaiting_signature' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'agreement versions cannot be deleted' using errcode = 'P0001';
  end if;

  if new.id is distinct from old.id
     or new.affiliate_id is distinct from old.affiliate_id
     or new.product_id is distinct from old.product_id
     or new.version is distinct from old.version
     or new.created_at is distinct from old.created_at then
    raise exception 'agreement version identity is immutable' using errcode = 'P0001';
  end if;

  if old.status in ('draft', 'awaiting_signature') then
    if new.status = 'active'
       or new.model is distinct from old.model
       or new.payout_currency is distinct from old.payout_currency then
      select
        count(*),
        coalesce(bool_or(rule.fixed_amount_minor is not null), false),
        coalesce(bool_or(rule.rate_basis_points is not null), false),
        count(*) filter (
          where (new.model <> 'hybrid' and rule.model <> new.model)
             or (
               rule.fixed_amount_minor is not null
               and rule.currency is distinct from new.payout_currency
             )
        )
      into active_rules, has_fixed, has_rate, incompatible_rules
      from public.commission_rules as rule
      where rule.agreement_id = old.id and rule.status = 'active';

      if incompatible_rules > 0 then
        raise exception 'active commission rules must match the agreement model and payout currency' using errcode = 'P0001';
      end if;
      if new.status = 'active' then
        if active_rules = 0 then
          raise exception 'an agreement requires at least one active commission rule' using errcode = 'P0001';
        end if;
        if new.model = 'hybrid' and not (has_fixed and has_rate) then
          raise exception 'a hybrid agreement requires active fixed and rate components' using errcode = 'P0001';
        end if;
      end if;
    end if;
    return new;
  end if;

  if old.status = 'active'
     and new.status in ('superseded', 'terminated', 'expired')
     and new.ends_at is not null
     and new.ends_at > new.starts_at
     and (to_jsonb(new) - 'status' - 'ends_at' - 'updated_at')
       = (to_jsonb(old) - 'status' - 'ends_at' - 'updated_at') then
    return new;
  end if;

  raise exception 'active and historical agreement versions are immutable' using errcode = 'P0001';
end;
$$;

create or replace function public.protect_commission_rule_history()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  agreement_model public.commission_model;
  agreement_state public.agreement_status;
  agreement_currency text;
  target_agreement uuid;
begin
  target_agreement := case when tg_op = 'DELETE' then old.agreement_id else new.agreement_id end;
  select agreement.model, agreement.status, agreement.payout_currency
  into agreement_model, agreement_state, agreement_currency
  from public.agreements as agreement
  where agreement.id = target_agreement
  for update;

  if agreement_state not in ('draft', 'awaiting_signature') then
    raise exception 'rules on active or historical agreements are immutable' using errcode = 'P0001';
  end if;

  if tg_op <> 'DELETE' and agreement_model <> 'hybrid' and new.model <> agreement_model then
    raise exception 'commission rule model must match its agreement' using errcode = 'P0001';
  end if;
  if tg_op <> 'DELETE'
     and new.model in ('cpl', 'cpa', 'hybrid')
     and new.currency is distinct from agreement_currency then
    raise exception 'fixed commission rule currency must match the agreement payout currency' using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.validate_affiliate_link()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  funnel_product uuid;
  funnel_state text;
  product_state public.product_status;
  campaign_product uuid;
  campaign_state text;
  parent_record public.affiliate_links%rowtype;
  old_status public.link_status;
  expected_tracking_url text;
begin
  select funnel.product_id, funnel.status into funnel_product, funnel_state
  from public.funnels as funnel where funnel.id = new.funnel_id;
  if funnel_product is distinct from new.product_id then
    raise exception 'funnel does not belong to the selected product' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and (
    new.affiliate_id <> old.affiliate_id
    or new.product_id <> old.product_id
    or new.funnel_id <> old.funnel_id
    or new.public_code <> old.public_code
    or new.tracking_url <> old.tracking_url
    or new.parent_link_id is distinct from old.parent_link_id
  ) then
    raise exception 'issued link identity and routing are immutable' using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    select setting.tracking_base_url || '/r/' || affiliate.slug || '/' || new.public_code
    into expected_tracking_url
    from public.affiliates as affiliate
    cross join public.platform_settings as setting
    where affiliate.id = new.affiliate_id and setting.singleton;
    if expected_tracking_url is null or new.tracking_url <> expected_tracking_url then
      raise exception 'tracking URL must be issued from the configured tracking domain' using errcode = '23514';
    end if;
  end if;

  if new.campaign_id is not null then
    select campaign.product_id, campaign.status into campaign_product, campaign_state
    from public.campaigns as campaign where campaign.id = new.campaign_id;
    if campaign_product is distinct from new.product_id then
      raise exception 'campaign does not belong to the selected product' using errcode = '23514';
    end if;
    if new.status = 'active' and campaign_state <> 'active' then
      raise exception 'active links require an active campaign' using errcode = '23514';
    end if;
  end if;

  if new.parent_link_id is not null then
    select * into parent_record from public.affiliate_links where id = new.parent_link_id;
    if parent_record.id is null
       or parent_record.affiliate_id <> new.affiliate_id
       or parent_record.product_id <> new.product_id
       or parent_record.parent_link_id is not null then
      raise exception 'parent link must be a root link in the same partner product' using errcode = '23514';
    end if;
  end if;

  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    select product.status into product_state from public.products as product where product.id = new.product_id;
    if product_state <> 'active'
       or funnel_state <> 'live'
       or not exists (
         select 1 from public.agreements as agreement
         where agreement.affiliate_id = new.affiliate_id
           and agreement.product_id = new.product_id
           and agreement.status = 'active'
       ) then
      raise exception 'active link requires an active product, live funnel, and active agreement' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    old_status := old.status;
    if not (
      (old_status = 'active' and new.status in ('paused', 'archived'))
      or (old_status = 'paused' and new.status in ('active', 'archived'))
      or (old_status = 'archived' and new.status = 'paused')
    ) then
      raise exception 'invalid affiliate link status transition: % -> %', old.status, new.status using errcode = 'P0001';
    end if;
    new.status_changed_at := now();
    if new.status = 'archived' then
      new.archived_at := now();
    elsif old.status = 'archived' then
      new.archived_at := null;
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.validate_click_dimensions()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  link_record public.affiliate_links%rowtype;
begin
  select * into link_record from public.affiliate_links where id = new.affiliate_link_id;
  if link_record.id is null
     or link_record.affiliate_id <> new.affiliate_id
     or link_record.product_id <> new.product_id
     or link_record.funnel_id <> new.funnel_id
     or link_record.source_id is distinct from new.source_id
     or link_record.campaign_id is distinct from new.campaign_id then
    raise exception 'click dimensions must match the issued affiliate link' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_acquisition_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  click_record public.clicks%rowtype;
begin
  if new.click_record_id is not null then
    select * into click_record from public.clicks where id = new.click_record_id;
    if click_record.id is null
       or click_record.product_id <> new.product_id
       or click_record.affiliate_id is distinct from new.affiliate_id
       or click_record.source_id is distinct from new.source_id
       or click_record.campaign_id is distinct from new.campaign_id
       or click_record.funnel_id is distinct from new.funnel_id then
      raise exception 'acquisition dimensions must match its click record' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.status <> 'open' or new.status not in ('resolved', 'rejected') then
      raise exception 'invalid acquisition status transition: % -> %', old.status, new.status using errcode = 'P0001';
    end if;
    if (to_jsonb(new) - 'status' - 'account_id' - 'resolved_at' - 'rejection_reason')
       <> (to_jsonb(old) - 'status' - 'account_id' - 'resolved_at' - 'rejection_reason') then
      raise exception 'acquisition attribution identity is immutable' using errcode = 'P0001';
    end if;
    if new.status = 'resolved' and new.account_id is null then
      raise exception 'resolved acquisition requires an account' using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.subscriptions as subscription
      where subscription.acquisition_id = new.id
        and (
          subscription.account_id is distinct from new.account_id
          or subscription.product_id <> new.product_id
        )
    ) then
      raise exception 'acquisition resolution must match referencing subscriptions' using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.events as event
      where event.acquisition_id = new.id
        and event.account_id is not null
        and event.account_id is distinct from new.account_id
    ) then
      raise exception 'acquisition resolution must match account-scoped canonical events' using errcode = '23514';
    end if;
    if new.status = 'rejected' and exists (
      select 1 from public.subscriptions as subscription where subscription.acquisition_id = new.id
    ) then
      raise exception 'an acquisition referenced by a subscription cannot be rejected' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.validate_subscription_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  acquisition_record public.acquisitions%rowtype;
begin
  if new.acquisition_id is not null then
    select * into acquisition_record
    from public.acquisitions
    where id = new.acquisition_id
    for update;
    if acquisition_record.id is null
       or acquisition_record.status = 'rejected'
       or acquisition_record.account_id is distinct from new.account_id
       or acquisition_record.product_id <> new.product_id then
      raise exception 'subscription acquisition must match its account and product' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' and (
    new.account_id <> old.account_id
    or new.product_id <> old.product_id
    or new.acquisition_id is distinct from old.acquisition_id
    or new.stripe_customer_id <> old.stripe_customer_id
    or new.stripe_subscription_id <> old.stripe_subscription_id
    or new.currency <> old.currency
    or new.created_at <> old.created_at
  ) then
    raise exception 'subscription identity and billing currency are immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.validate_entitlement_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  subscription_record public.subscriptions%rowtype;
begin
  if new.subscription_id is not null then
    select * into subscription_record from public.subscriptions where id = new.subscription_id;
    if subscription_record.id is null
       or subscription_record.account_id <> new.account_id
       or subscription_record.product_id <> new.product_id then
      raise exception 'entitlement subscription must match its account and product' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' and (
    new.account_id <> old.account_id
    or new.product_id <> old.product_id
    or new.subscription_id is distinct from old.subscription_id
    or new.source <> old.source
    or new.created_at <> old.created_at
  ) then
    raise exception 'entitlement identity is immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.validate_transaction_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  subscription_record public.subscriptions%rowtype;
  acquisition_record public.acquisitions%rowtype;
  provider_record public.provider_events%rowtype;
begin
  select * into subscription_record from public.subscriptions where id = new.subscription_id;
  select * into provider_record from public.provider_events where id = new.provider_event_id;
  if subscription_record.id is null
     or new.acquisition_id is distinct from subscription_record.acquisition_id
     or new.currency <> subscription_record.currency
     or new.settled_currency <> subscription_record.currency then
    raise exception 'transaction must match its subscription acquisition and billing currency' using errcode = '23514';
  end if;
  if new.eligible_net_minor
     <> new.gross_minor - new.fee_minor - new.tax_minor + new.settlement_adjustment_minor then
    raise exception 'transaction eligible net must equal gross less fees and tax plus settlement adjustment' using errcode = '23514';
  end if;
  if provider_record.id is null
     or provider_record.provider <> 'stripe'
     or not provider_record.signature_verified
     or provider_record.event_type not in (
       'invoice.paid', 'checkout.session.completed', 'charge.succeeded', 'payment_intent.succeeded'
     ) then
    raise exception 'transaction requires a signature-verified Stripe payment event' using errcode = '23514';
  end if;
  if new.acquisition_id is not null then
    select * into acquisition_record from public.acquisitions where id = new.acquisition_id;
    if acquisition_record.id is null
       or acquisition_record.account_id is distinct from subscription_record.account_id
       or acquisition_record.product_id <> subscription_record.product_id then
      raise exception 'transaction acquisition must match the subscription account and product' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.validate_refund_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  transaction_record public.transactions%rowtype;
  provider_record public.provider_events%rowtype;
  existing_refunded_minor bigint;
begin
  select * into transaction_record
  from public.transactions
  where id = new.transaction_id
  for update;
  select * into provider_record
  from public.provider_events
  where id = new.provider_event_id;

  if transaction_record.id is null
     or new.currency <> transaction_record.currency then
    raise exception 'refund must match its canonical transaction currency' using errcode = '23514';
  end if;
  if provider_record.id is null
     or provider_record.provider <> 'stripe'
     or not provider_record.signature_verified
     or provider_record.event_type not in ('charge.refunded', 'refund.created', 'refund.updated') then
    raise exception 'refund requires a signature-verified Stripe refund event' using errcode = '23514';
  end if;
  if new.balance_impact_minor <> -new.amount_minor then
    raise exception 'refund balance impact must exactly reverse its refund amount' using errcode = '23514';
  end if;

  select coalesce(sum(refund.amount_minor), 0)::bigint
  into existing_refunded_minor
  from public.refunds as refund
  where refund.transaction_id = new.transaction_id;
  if existing_refunded_minor + new.amount_minor > transaction_record.gross_minor then
    raise exception 'cumulative refunds cannot exceed the canonical transaction gross' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_dispute_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  transaction_record public.transactions%rowtype;
  provider_record public.provider_events%rowtype;
begin
  select * into transaction_record
  from public.transactions
  where id = new.transaction_id
  for update;
  select * into provider_record
  from public.provider_events
  where id = new.provider_event_id;

  if transaction_record.id is null
     or new.currency <> transaction_record.currency
     or new.disputed_minor > transaction_record.gross_minor then
    raise exception 'dispute must match its canonical transaction currency and gross amount' using errcode = '23514';
  end if;
  if provider_record.id is null
     or provider_record.provider <> 'stripe'
     or not provider_record.signature_verified
     or (
       provider_record.event_type not like 'charge.dispute.%'
       and provider_record.event_type not like 'radar.early_fraud_warning.%'
     ) then
    raise exception 'dispute requires a signature-verified Stripe dispute event' using errcode = '23514';
  end if;
  if (new.status = 'open' and new.balance_impact_minor <> -(new.disputed_minor + new.fee_minor))
     or (new.status = 'lost' and new.balance_impact_minor <> 0)
     or (new.status in ('won', 'warning_closed') and (
       new.balance_impact_minor < 0
       or new.balance_impact_minor > new.disputed_minor + new.fee_minor
     )) then
    raise exception 'dispute balance impact does not match its lifecycle state' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_conversion()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  acquisition_record public.acquisitions%rowtype;
  agreement_record public.agreements%rowtype;
  rule_record public.commission_rules%rowtype;
  event_record public.events%rowtype;
  transaction_record public.transactions%rowtype;
  subscription_record public.subscriptions%rowtype;
begin
  select * into acquisition_record from public.acquisitions where id = new.acquisition_id;
  select * into agreement_record from public.agreements where id = new.agreement_id;
  select * into rule_record from public.commission_rules where id = new.commission_rule_id;
  select * into event_record from public.events where id = new.event_id;

  if acquisition_record.product_id <> new.product_id
     or acquisition_record.affiliate_id is distinct from new.affiliate_id
     or agreement_record.product_id <> new.product_id
     or agreement_record.affiliate_id <> new.affiliate_id
     or rule_record.agreement_id <> new.agreement_id
     or event_record.product_id <> new.product_id
     or event_record.affiliate_id is distinct from new.affiliate_id
     or event_record.acquisition_id is distinct from new.acquisition_id
     or event_record.account_id is distinct from new.account_id
     or acquisition_record.account_id is distinct from new.account_id then
    raise exception 'conversion identity does not match acquisition, agreement, rule, and event' using errcode = '23514';
  end if;
  if acquisition_record.status <> 'resolved'
     or (new.qualified and acquisition_record.account_id is null)
     or new.event_name <> event_record.event_name
     or new.event_name <> rule_record.trigger_event
     or new.occurred_at <> event_record.occurred_at then
    raise exception 'conversion requires a resolved acquisition and the exact qualifying trigger event' using errcode = '23514';
  end if;
  if agreement_record.status not in ('active', 'superseded', 'expired', 'terminated')
     or rule_record.status <> 'active'
     or agreement_record.starts_at > new.occurred_at
     or (agreement_record.ends_at is not null and agreement_record.ends_at <= new.occurred_at) then
    raise exception 'conversion requires an immutable agreement version and active rule effective at the event time' using errcode = '23514';
  end if;
  if event_record.source not in ('first_party', 'stripe', 'singular', 'manual') then
    raise exception 'behavioral analytics sources cannot qualify commercial conversions' using errcode = '23514';
  end if;
  if new.occurred_at < acquisition_record.created_at
     or new.occurred_at > acquisition_record.created_at
       + make_interval(days => agreement_record.attribution_window_days) then
    raise exception 'conversion is outside its agreement attribution window' using errcode = '23514';
  end if;
  if rule_record.model in ('cpa', 'revenue_share', 'hybrid') and new.transaction_id is null then
    raise exception 'CPA, revenue-share, and hybrid conversions require a canonical transaction' using errcode = '23514';
  end if;
  if rule_record.model = 'cpl' and new.transaction_id is not null then
    raise exception 'CPL conversions cannot be qualified from a billing transaction' using errcode = '23514';
  end if;
  if new.transaction_id is not null then
    select * into transaction_record from public.transactions where id = new.transaction_id;
    select * into subscription_record from public.subscriptions where id = transaction_record.subscription_id;
    if transaction_record.id is null
       or transaction_record.acquisition_id is distinct from new.acquisition_id
       or subscription_record.id is null
       or subscription_record.acquisition_id is distinct from new.acquisition_id
       or subscription_record.account_id is distinct from new.account_id
       or subscription_record.product_id <> new.product_id
       or subscription_record.currency <> agreement_record.payout_currency
       or transaction_record.currency <> agreement_record.payout_currency
       or transaction_record.settled_currency <> agreement_record.payout_currency then
      raise exception 'conversion transaction and subscription must match acquisition, account, product, and payout currency' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.validate_commission_entry()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  agreement_record public.agreements%rowtype;
  period_state public.period_status;
  period_record public.payout_periods%rowtype;
  rule_record public.commission_rules%rowtype;
  conversion_agreement_id uuid;
  conversion_record public.conversions%rowtype;
  commission_transaction public.transactions%rowtype;
  expected_commission_minor bigint;
  source_payout_record public.payouts%rowtype;
  source_period_end timestamptz;
begin
  select * into agreement_record from public.agreements where id = new.agreement_id;
  select * into period_record
  from public.payout_periods as period
  where period.id = new.payout_period_id
  for share;
  period_state := period_record.status;

  if agreement_record.affiliate_id <> new.affiliate_id
     or agreement_record.product_id <> new.product_id
     or agreement_record.payout_currency <> new.currency then
    raise exception 'ledger entry must match its agreement and payout currency' using errcode = '23514';
  end if;
  if period_state <> 'open' then
    raise exception 'commission entries can only be posted to an open payout period' using errcode = 'P0001';
  end if;
  if new.commission_rule_id is not null then
    select * into rule_record from public.commission_rules as rule where rule.id = new.commission_rule_id;
    if rule_record.id is null or rule_record.agreement_id <> new.agreement_id then
      raise exception 'commission rule must belong to the ledger agreement' using errcode = '23514';
    end if;
  end if;
  if new.conversion_id is not null then
    select * into conversion_record from public.conversions as conversion where conversion.id = new.conversion_id;
    conversion_agreement_id := conversion_record.agreement_id;
    if conversion_agreement_id <> new.agreement_id
       or conversion_record.affiliate_id <> new.affiliate_id
       or conversion_record.product_id <> new.product_id
       or conversion_record.commission_rule_id is distinct from new.commission_rule_id
       or not conversion_record.qualified
       or conversion_record.transaction_id is distinct from new.transaction_id then
      raise exception 'commission entry requires a qualified conversion with matching identity' using errcode = '23514';
    end if;
  end if;
  if new.entry_type = 'commission' then
    if rule_record.model in ('revenue_share', 'hybrid') then
      select * into commission_transaction
      from public.transactions
      where id = conversion_record.transaction_id;
    end if;
    expected_commission_minor := case rule_record.model
      when 'cpl' then rule_record.fixed_amount_minor
      when 'cpa' then rule_record.fixed_amount_minor
      when 'revenue_share' then floor(
        commission_transaction.eligible_net_minor::numeric * rule_record.rate_basis_points / 10000
      )::bigint
      when 'hybrid' then rule_record.fixed_amount_minor + floor(
        commission_transaction.eligible_net_minor::numeric * rule_record.rate_basis_points / 10000
      )::bigint
    end;
    if expected_commission_minor is null or new.amount_minor <> expected_commission_minor then
      raise exception 'commission amount must exactly match its immutable rule and transaction basis' using errcode = '23514';
    end if;
  end if;
  if new.entry_type = 'carry_forward' then
    select * into source_payout_record from public.payouts where id = new.source_payout_id;
    select period.ends_at into source_period_end
    from public.payout_periods as period where period.id = source_payout_record.payout_period_id;
    if source_payout_record.status <> 'carried_forward'
       or source_payout_record.affiliate_id <> new.affiliate_id
       or source_payout_record.product_id <> new.product_id
       or source_payout_record.currency <> new.currency
       or source_payout_record.carry_out_minor <> new.amount_minor
       or source_period_end > period_record.starts_at then
      raise exception 'carry-forward entry must exactly continue a prior finalized payout balance' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.protect_payout_destination()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allowed boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'new payout destinations must begin in draft' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'payout destination history cannot be deleted' using errcode = 'P0001';
  end if;

  if old.status in ('active', 'replaced', 'revoked') then
    if old.status <> 'active' or new.status not in ('replaced', 'revoked') then
      raise exception 'active and historical payout destinations are immutable' using errcode = 'P0001';
    end if;
    if (to_jsonb(new) - 'status' - 'replacement_id' - 'updated_at')
       <> (to_jsonb(old) - 'status' - 'replacement_id' - 'updated_at') then
      raise exception 'active payout destination facts are immutable' using errcode = 'P0001';
    end if;
  end if;

  if (to_jsonb(new) - 'status' - 'verification_status' - 'verification_method' - 'verified_at'
      - 'effective_at' - 'test_transfer_status' - 'test_transfer_completed_at'
      - 'replacement_id' - 'updated_at')
     <> (to_jsonb(old) - 'status' - 'verification_status' - 'verification_method' - 'verified_at'
      - 'effective_at' - 'test_transfer_status' - 'test_transfer_completed_at'
      - 'replacement_id' - 'updated_at') then
    raise exception 'payout destination identity and security evidence are immutable' using errcode = 'P0001';
  end if;

  if new.status = old.status then
    return new;
  end if;

  allowed := case old.status
    when 'draft' then new.status in ('verification_pending', 'revoked')
    when 'verification_pending' then new.status in ('pending_hold', 'revoked')
    when 'pending_hold' then new.status in ('active', 'revoked')
    when 'active' then new.status in ('replaced', 'revoked')
    else false
  end;

  if not allowed then
    raise exception 'invalid payout destination status transition: % -> %', old.status, new.status using errcode = 'P0001';
  end if;

  if new.status = 'active' and now() < new.hold_until then
    raise exception 'payout destination cannot activate before its 48-hour hold ends' using errcode = 'P0001';
  end if;

  if new.status = 'replaced' and not exists (
    select 1 from public.payout_destinations as replacement
    where replacement.id = new.replacement_id
      and replacement.affiliate_id = new.affiliate_id
      and replacement.currency = new.currency
      and replacement.status = 'pending_hold'
      and replacement.verification_status = 'passed'
      and replacement.verified_at is not null
      and replacement.hold_until <= now()
      and (
        replacement.method <> 'crypto'
        or (
          replacement.test_transfer_status = 'passed'
          and replacement.test_transfer_completed_at is not null
        )
      )
  ) then
    raise exception 'replacement destination must be an eligible pending destination for the same affiliate and currency' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create or replace function public.protect_payout_period()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'open' or new.closed_at is not null then
      raise exception 'new payout periods must begin open without closure evidence' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'payout periods cannot be deleted' using errcode = 'P0001';
  end if;
  if old.status = 'closed' then
    raise exception 'closed payout periods are immutable' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'status' - 'closed_at' - 'updated_at')
     <> (to_jsonb(old) - 'status' - 'closed_at' - 'updated_at') then
    raise exception 'payout-period identity and boundaries are immutable' using errcode = 'P0001';
  end if;
  if new.status <> 'closed' and new.closed_at is not null then
    raise exception 'payout-period closure evidence can only be recorded when closing' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'open' and new.status = 'review')
    or (old.status = 'review' and new.status = 'closed')
  ) then
    raise exception 'invalid payout period status transition: % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  if old.status = 'open' and new.status = 'review'
     and clock_timestamp() < new.review_starts_at then
    raise exception 'payout period cannot enter review before review_starts_at' using errcode = 'P0001';
  end if;
  if old.status = 'review' and new.status = 'closed' and (
    clock_timestamp() < new.review_starts_at
    or new.closed_at is null
    or new.closed_at < new.review_starts_at
    or new.closed_at > clock_timestamp()
  ) then
    raise exception 'payout period cannot close before its review window begins' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.validate_payout_agreement_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  payout_record public.payouts%rowtype;
  agreement_record public.agreements%rowtype;
  canonical_rules jsonb;
begin
  select * into payout_record
  from public.payouts
  where id = new.payout_id
  for update;
  select * into agreement_record from public.agreements where id = new.agreement_id;
  if payout_record.status not in ('open', 'review', 'on_hold')
     or payout_record.calculation_finalized_at is not null then
    raise exception 'agreement snapshots cannot be added after payout finalization' using errcode = 'P0001';
  end if;
  if agreement_record.affiliate_id <> payout_record.affiliate_id
     or agreement_record.product_id <> payout_record.product_id
     or agreement_record.payout_currency <> payout_record.currency
     or agreement_record.version <> new.agreement_version
     or agreement_record.model <> new.model
     or agreement_record.attribution_window_days <> new.attribution_window_days
     or agreement_record.payout_frequency_days <> new.payout_frequency_days
     or agreement_record.payout_currency <> new.payout_currency
     or agreement_record.minimum_payout_minor <> new.minimum_payout_minor then
    raise exception 'payout agreement snapshot must exactly match its agreement version' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.commission_entries as entry
    where entry.affiliate_id = payout_record.affiliate_id
      and entry.product_id = payout_record.product_id
      and entry.payout_period_id = payout_record.payout_period_id
      and entry.agreement_id = new.agreement_id
  ) then
    raise exception 'payout snapshots require a ledger entry from that agreement' using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'name', rule.name,
      'version', rule.version,
      'status', rule.status,
      'model', rule.model,
      'trigger_event', rule.trigger_event,
      'fixed_amount_minor', rule.fixed_amount_minor,
      'rate_basis_points', rule.rate_basis_points,
      'currency', rule.currency,
      'validation_window_hours', rule.validation_window_hours
    ) order by rule.name, rule.version
  ), '[]'::jsonb)
  into canonical_rules
  from public.commission_rules as rule
  where rule.agreement_id = new.agreement_id;

  if new.rules_snapshot <> canonical_rules then
    raise exception 'payout rule snapshot must exactly match versioned commission rules' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.require_payout_agreement_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.payout_agreement_snapshots as snapshot where snapshot.payout_id = new.id
  ) then
    raise exception 'every payout must have an agreement snapshot before commit' using errcode = '23514';
  end if;
  return null;
end;
$$;

create or replace function public.validate_affiliate_daily_metric()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  link_record public.affiliate_links%rowtype;
begin
  if new.affiliate_link_id is not null then
    select * into link_record from public.affiliate_links where id = new.affiliate_link_id;
    if link_record.id is null
       or link_record.affiliate_id <> new.affiliate_id
       or link_record.product_id <> new.product_id
       or link_record.source_id is distinct from new.source_id
       or link_record.campaign_id is distinct from new.campaign_id
       or link_record.funnel_id is distinct from new.funnel_id
       or link_record.sub1 is distinct from new.sub1
       or link_record.sub2 is distinct from new.sub2
       or link_record.sub3 is distinct from new.sub3 then
      raise exception 'link-scoped metrics must match their immutable tracking dimensions' using errcode = '23514';
    end if;
  end if;
  if not exists (
    select 1 from public.agreements as agreement
    where agreement.affiliate_id = new.affiliate_id
      and agreement.product_id = new.product_id
      and agreement.payout_currency = new.currency
      and (agreement.starts_at is null or agreement.starts_at::date <= new.metric_date)
      and (agreement.ends_at is null or agreement.ends_at::date >= new.metric_date)
  ) then
    raise exception 'metric currency and date require a matching agreement version' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.protect_reconciliation_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'queued'
       or new.provider_total_minor is not null
       or new.internal_total_minor is not null
       or new.unexplained_difference_minor is not null
       or new.exception_count <> 0
       or new.started_at is not null
       or new.completed_at is not null then
      raise exception 'new reconciliation runs must begin queued without result evidence' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'reconciliation runs cannot be deleted' using errcode = 'P0001';
  end if;
  if old.status in ('passed', 'failed') then
    raise exception 'completed reconciliation runs are immutable' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'status' - 'provider_total_minor' - 'internal_total_minor'
      - 'unexplained_difference_minor' - 'exception_count' - 'details'
      - 'started_at' - 'completed_at' - 'updated_at')
     <> (to_jsonb(old) - 'status' - 'provider_total_minor' - 'internal_total_minor'
      - 'unexplained_difference_minor' - 'exception_count' - 'details'
      - 'started_at' - 'completed_at' - 'updated_at') then
    raise exception 'reconciliation identity, window, and idempotency key are immutable' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'queued' and new.status = 'running')
    or (old.status = 'running' and new.status in ('passed', 'failed'))
  ) then
    raise exception 'invalid reconciliation status transition: % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  if new.status = 'passed' and (
    clock_timestamp() < new.ends_at
    or new.completed_at < new.ends_at
    or new.completed_at > clock_timestamp()
  ) then
    raise exception 'reconciliation cannot pass before its window ends' using errcode = 'P0001';
  end if;
  if new.status = 'passed' and new.exception_count <> (
    select count(*)::integer
    from public.reconciliation_exceptions as exception
    where exception.reconciliation_run_id = new.id
      and exception.status in ('open', 'investigating')
  ) then
    raise exception 'reconciliation exception count must match the open exception queue' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.protect_reconciliation_exception()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_run_status public.reconciliation_status;
  new_run_status public.reconciliation_status;
begin
  if tg_op = 'INSERT' then
    select run.status into new_run_status
    from public.reconciliation_runs as run
    where run.id = new.reconciliation_run_id;
    if new_run_status in ('passed', 'failed') then
      raise exception 'exceptions cannot be attached to completed reconciliation runs' using errcode = 'P0001';
    end if;
    if new.status <> 'open'
       or new.resolution_note is not null
       or new.resolved_by is not null
       or new.resolved_at is not null then
      raise exception 'new reconciliation exceptions must begin open without resolution evidence' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'reconciliation exception facts cannot be deleted' using errcode = 'P0001';
  end if;

  if tg_op <> 'INSERT' then
    select run.status into old_run_status
    from public.reconciliation_runs as run
    where run.id = old.reconciliation_run_id;
    if old_run_status in ('passed', 'failed') then
      raise exception 'exceptions on completed reconciliation runs are immutable' using errcode = 'P0001';
    end if;
  end if;

  if (to_jsonb(new) - 'status' - 'resolution_note' - 'resolved_by' - 'resolved_at' - 'updated_at')
     <> (to_jsonb(old) - 'status' - 'resolution_note' - 'resolved_by' - 'resolved_at' - 'updated_at') then
    raise exception 'reconciliation exception facts are immutable' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'open' and new.status in ('investigating', 'resolved'))
    or (old.status = 'investigating' and new.status = 'resolved')
  ) then
    raise exception 'invalid reconciliation exception status transition: % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  if new.status is not distinct from old.status
     and (
       new.resolution_note is distinct from old.resolution_note
       or new.resolved_by is distinct from old.resolved_by
       or new.resolved_at is distinct from old.resolved_at
     ) then
    raise exception 'resolution evidence can only be recorded when resolving an exception' using errcode = 'P0001';
  end if;
  if new.status <> 'resolved'
     and (new.resolution_note is not null or new.resolved_by is not null or new.resolved_at is not null) then
    raise exception 'only resolved exceptions may contain resolution evidence' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.record_payout_destination_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.payout_destination_events (
      payout_destination_id, status, actor_user_id, reason
    ) values (
      new.id,
      new.status,
      auth.uid(),
      case when tg_op = 'INSERT' then 'destination_created' else 'status_changed' end
    );
  end if;
  return new;
end;
$$;

create or replace function public.protect_payout_history()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allowed boolean := false;
  period_state public.period_status;
  destination_record public.payout_destinations%rowtype;
  reconciliation_record public.reconciliation_runs%rowtype;
  period_record public.payout_periods%rowtype;
  expected_earnings bigint;
  expected_adjustments bigint;
  expected_carry bigint;
  expected_eligible_net bigint;
  available_minor bigint;
  snapshot_count integer;
  maximum_minimum bigint;
  maximum_frequency integer;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'open' then
      raise exception 'new payouts must begin in open status' using errcode = 'P0001';
    end if;
    if new.minimum_payout_minor_snapshot is not null
       or new.payout_frequency_days_snapshot is not null
       or new.payout_destination_id is not null
       or new.payment_method_snapshot is not null
       or new.destination_label_snapshot is not null
       or new.destination_version_snapshot is not null
       or new.calculation_finalized_at is not null
       or new.calculation_finalized_by is not null
       or new.reviewed_at is not null
       or new.reviewed_by is not null
       or new.approved_at is not null
       or new.approved_by is not null
       or new.scheduled_at is not null
       or new.statement_number is not null
       or new.statement_storage_path is not null
       or new.payment_reference is not null
       or new.paid_at is not null
       or new.hold_reason is not null
       or new.held_from_status is not null
       or new.failure_reason is not null
       or new.reconciliation_run_id is not null then
      raise exception 'open payouts cannot prefill future workflow or settlement evidence' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'payouts cannot be deleted' using errcode = 'P0001';
  end if;

  if old.status = 'paid' then
    raise exception 'paid payouts are immutable' using errcode = 'P0001';
  end if;

  if old.reviewed_at is not null
     and (new.reviewed_at is distinct from old.reviewed_at or new.reviewed_by is distinct from old.reviewed_by) then
    raise exception 'payout review evidence is immutable' using errcode = 'P0001';
  end if;
  if old.reviewed_at is null
     and (new.reviewed_at is not null or new.reviewed_by is not null)
     and (
       new.status <> 'review'
       or new.reviewed_at is null
       or new.reviewed_by is null
     ) then
    raise exception 'review evidence can only be recorded together when entering review' using errcode = 'P0001';
  end if;
  if old.reviewed_at is null and new.reviewed_at is not null and not exists (
    select 1 from public.admin_users as admin_user
    where admin_user.user_id = new.reviewed_by
      and admin_user.active
      and admin_user.role in ('owner', 'finance')
  ) then
    raise exception 'payout reviewer must be an active owner or finance admin' using errcode = '42501';
  end if;
  if old.approved_at is not null
     and (new.approved_at is distinct from old.approved_at or new.approved_by is distinct from old.approved_by) then
    raise exception 'payout approval evidence is immutable' using errcode = 'P0001';
  end if;
  if old.approved_at is null
     and (new.approved_at is not null or new.approved_by is not null)
     and (
       new.status <> 'approved'
       or new.approved_at is null
       or new.approved_by is null
     ) then
    raise exception 'approval evidence can only be recorded together when entering approved' using errcode = 'P0001';
  end if;
  if old.approved_at is null and new.approved_at is not null and not exists (
    select 1 from public.admin_users as admin_user
    where admin_user.user_id = new.approved_by
      and admin_user.active
      and admin_user.role in ('owner', 'finance')
  ) then
    raise exception 'payout approver must be an active owner or finance admin' using errcode = '42501';
  end if;
  if old.scheduled_at is not null and new.scheduled_at is distinct from old.scheduled_at then
    raise exception 'payout scheduling evidence is immutable' using errcode = 'P0001';
  end if;
  if old.scheduled_at is null and new.scheduled_at is not null and new.status <> 'scheduled' then
    raise exception 'scheduled_at can only be recorded when entering scheduled' using errcode = 'P0001';
  end if;
  if old.payment_reference is not null
     and (new.payment_reference is distinct from old.payment_reference or new.paid_at is distinct from old.paid_at) then
    raise exception 'payout settlement evidence is immutable' using errcode = 'P0001';
  end if;
  if old.payment_reference is null and new.payment_reference is not null and new.status <> 'paid' then
    raise exception 'settlement evidence can only be recorded when entering paid' using errcode = 'P0001';
  end if;
  if old.calculation_finalized_at is null
     and (new.calculation_finalized_at is not null or new.calculation_finalized_by is not null)
     and (
       new.status not in ('approved', 'carried_forward')
       or new.calculation_finalized_at is null
       or new.calculation_finalized_by is null
     ) then
    raise exception 'calculation evidence can only be recorded together on approval or carry-forward' using errcode = 'P0001';
  end if;
  if old.calculation_finalized_at is null and new.calculation_finalized_at is not null and not exists (
    select 1 from public.admin_users as admin_user
    where admin_user.user_id = new.calculation_finalized_by
      and admin_user.active
      and admin_user.role in ('owner', 'finance')
  ) then
    raise exception 'payout calculation finalizer must be an active owner or finance admin' using errcode = '42501';
  end if;

  if old.calculation_finalized_at is not null
     and (to_jsonb(new) - 'status' - 'approved_at' - 'approved_by' - 'scheduled_at'
       - 'payment_reference' - 'paid_at' - 'hold_reason' - 'held_from_status' - 'failure_reason' - 'updated_at')
       <> (to_jsonb(old) - 'status' - 'approved_at' - 'approved_by' - 'scheduled_at'
       - 'payment_reference' - 'paid_at' - 'hold_reason' - 'held_from_status' - 'failure_reason' - 'updated_at') then
    raise exception 'finalized payout calculations and snapshots are immutable' using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    allowed := case old.status
      when 'open' then new.status in ('review', 'on_hold')
      when 'review' then new.status in ('approved', 'carried_forward', 'on_hold')
      when 'approved' then new.status in ('scheduled', 'on_hold')
      when 'scheduled' then new.status in ('paid', 'failed', 'on_hold')
      when 'on_hold' then new.status = old.held_from_status
      when 'failed' then new.status in ('scheduled', 'carried_forward', 'on_hold')
      else false
    end;
    if not allowed then
      raise exception 'invalid payout status transition: % -> %', old.status, new.status using errcode = 'P0001';
    end if;
    if new.status = 'on_hold' then
      new.held_from_status := old.status;
    elsif old.status = 'on_hold' then
      new.held_from_status := old.held_from_status;
    end if;
  elsif new.held_from_status is distinct from old.held_from_status then
    raise exception 'payout hold-resume evidence is immutable' using errcode = 'P0001';
  end if;

  if new.status in ('approved', 'scheduled', 'paid', 'carried_forward') then
    select * into period_record
    from public.payout_periods as period where period.id = new.payout_period_id;
    period_state := period_record.status;
    if period_state <> 'closed' then
      raise exception 'a payout cannot finalize before its payout period is closed' using errcode = 'P0001';
    end if;

    if new.reconciliation_run_id is null then
      raise exception 'finalized payout requires a passed Stripe reconciliation' using errcode = 'P0001';
    end if;
    select * into reconciliation_record
    from public.reconciliation_runs where id = new.reconciliation_run_id;
    if reconciliation_record.status <> 'passed'
       or reconciliation_record.provider <> 'stripe'
       or reconciliation_record.currency <> new.currency
       or reconciliation_record.starts_at <> period_record.starts_at
       or reconciliation_record.ends_at <> period_record.ends_at
       or reconciliation_record.unexplained_difference_minor <> 0
       or reconciliation_record.exception_count <> 0 then
      raise exception 'payout reconciliation must be passed, exact-window, exact-currency, and exception-free' using errcode = 'P0001';
    end if;

    if exists (
      select 1 from public.commission_entries as entry
      where entry.affiliate_id = new.affiliate_id
        and entry.product_id = new.product_id
        and entry.payout_period_id = new.payout_period_id
        and entry.currency <> new.currency
    ) then
      raise exception 'payout ledger contains a different currency' using errcode = 'P0001';
    end if;

    select
      coalesce(sum(entry.amount_minor) filter (where entry.entry_type = 'commission'), 0),
      coalesce(sum(entry.amount_minor) filter (where entry.entry_type not in ('commission', 'carry_forward')), 0),
      coalesce(sum(entry.amount_minor) filter (where entry.entry_type = 'carry_forward'), 0)
    into expected_earnings, expected_adjustments, expected_carry
    from public.commission_entries as entry
    where entry.affiliate_id = new.affiliate_id
      and entry.product_id = new.product_id
      and entry.payout_period_id = new.payout_period_id
      and entry.currency = new.currency;

    select coalesce(sum(transaction.eligible_net_minor), 0)::bigint
    into expected_eligible_net
    from public.transactions as transaction
    where transaction.id in (
      select distinct entry.transaction_id
      from public.commission_entries as entry
      where entry.affiliate_id = new.affiliate_id
        and entry.product_id = new.product_id
        and entry.payout_period_id = new.payout_period_id
        and entry.currency = new.currency
        and entry.entry_type = 'commission'
        and entry.transaction_id is not null
    );

    if new.eligible_net_minor <> expected_eligible_net
       or new.earnings_minor <> expected_earnings
       or new.adjustments_minor <> expected_adjustments
       or new.carry_in_minor <> expected_carry then
      raise exception 'payout arithmetic does not match its immutable ledger' using errcode = 'P0001';
    end if;

    select count(*), max(snapshot.minimum_payout_minor), max(snapshot.payout_frequency_days)
    into snapshot_count, maximum_minimum, maximum_frequency
    from public.payout_agreement_snapshots as snapshot
    where snapshot.payout_id = new.id;

    if snapshot_count = 0 then
      raise exception 'a finalized payout requires agreement snapshots' using errcode = 'P0001';
    end if;
    if exists (
      select 1
      from public.commission_entries as entry
      where entry.affiliate_id = new.affiliate_id
        and entry.product_id = new.product_id
        and entry.payout_period_id = new.payout_period_id
        and not exists (
          select 1 from public.payout_agreement_snapshots as snapshot
          where snapshot.payout_id = new.id and snapshot.agreement_id = entry.agreement_id
        )
    ) then
      raise exception 'every ledger agreement must be frozen into the payout snapshot' using errcode = 'P0001';
    end if;

    if new.minimum_payout_minor_snapshot is distinct from maximum_minimum then
      raise exception 'payout minimum must match the strictest agreement snapshot' using errcode = 'P0001';
    end if;
    if new.payout_frequency_days_snapshot is distinct from maximum_frequency then
      raise exception 'payout frequency must match its agreement snapshots' using errcode = 'P0001';
    end if;

    available_minor := new.earnings_minor + new.adjustments_minor + new.carry_in_minor;
    if new.status = 'carried_forward' then
      if available_minor >= new.minimum_payout_minor_snapshot
         or new.final_payout_minor <> 0
         or new.carry_out_minor <> available_minor then
        raise exception 'carried-forward payout must carry the complete below-minimum signed balance' using errcode = 'P0001';
      end if;
    else
      if available_minor < new.minimum_payout_minor_snapshot
         or new.carry_out_minor <> 0
         or new.final_payout_minor <> available_minor then
        raise exception 'approved payout must meet its minimum and pay the complete available balance' using errcode = 'P0001';
      end if;
    end if;
  end if;

  if new.status in ('approved', 'scheduled', 'paid') then
    if new.payout_destination_id is null then
      raise exception 'approved payout requires a frozen payout destination' using errcode = 'P0001';
    end if;
    select * into destination_record
    from public.payout_destinations where id = new.payout_destination_id;
    if destination_record.affiliate_id <> new.affiliate_id
       or destination_record.currency <> new.currency then
      raise exception 'payout destination does not belong to this affiliate and currency' using errcode = 'P0001';
    end if;
    if new.payment_method_snapshot is distinct from destination_record.method
       or new.destination_label_snapshot is distinct from destination_record.display_label
       or new.destination_version_snapshot is distinct from destination_record.version then
      raise exception 'payout destination snapshot does not match destination history' using errcode = 'P0001';
    end if;
    if new.status = 'approved' and old.status <> 'approved'
       and (
         destination_record.status <> 'active'
         or destination_record.effective_at > coalesce(new.approved_at, now())
         or destination_record.hold_until > coalesce(new.approved_at, now())
       ) then
      raise exception 'payout destination is not active and eligible at approval time' using errcode = 'P0001';
    end if;
    if new.status in ('scheduled', 'paid') and destination_record.status not in ('active', 'replaced') then
      raise exception 'revoked payout destination requires the payout to be placed on hold' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.audit_actor_type()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  jwt_role text := current_setting('request.jwt.claim.role', true);
begin
  if jwt_role = 'service_role' then return 'service'; end if;
  if public.current_user_is_admin() then return 'admin'; end if;
  if exists (select 1 from public.affiliate_users where user_id = auth.uid() and active) then return 'affiliate'; end if;
  if auth.uid() is not null then return 'customer'; end if;
  return 'system';
end;
$$;

create or replace function public.audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  before_record jsonb;
  after_record jsonb;
  record_id uuid;
begin
  before_record := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  after_record := case when tg_op = 'DELETE' then null else to_jsonb(new) end;

  if tg_table_name = 'payout_destinations' then
    before_record := before_record - 'provider_reference';
    after_record := after_record - 'provider_reference';
  end if;
  if tg_table_name = 'provider_events' then
    before_record := before_record - 'payload';
    after_record := after_record - 'payload';
  end if;

  record_id := nullif(coalesce(after_record ->> 'id', before_record ->> 'id'), '')::uuid;
  insert into public.audit_logs (
    actor_user_id, actor_type, action, target_table, target_id, before_data, after_data
  ) values (
    auth.uid(), public.audit_actor_type(), lower(tg_op), tg_table_name, record_id, before_record, after_record
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, full_name)
  values (
    new.id,
    nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120), '')
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'products', 'platform_settings', 'profiles', 'admin_users', 'affiliates', 'affiliate_users',
    'affiliate_settings', 'accounts', 'agreements', 'commission_rules', 'funnels',
    'campaigns', 'affiliate_links', 'provider_event_processing', 'subscriptions',
    'entitlements', 'payout_periods', 'payout_destinations', 'payouts', 'documents',
    'affiliate_daily_metrics', 'reconciliation_runs', 'reconciliation_exceptions'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      table_name || '_set_updated_at', table_name
    );
  end loop;
end;
$$;

create trigger agreements_protect_history
  before insert or update or delete on public.agreements
  for each row execute function public.protect_agreement_history();
create trigger profiles_validate_reporting_timezone
  before insert or update of preferred_timezone on public.profiles
  for each row execute function public.validate_reporting_timezone();
create trigger affiliates_validate_reporting_timezone
  before insert or update of reporting_timezone on public.affiliates
  for each row execute function public.validate_reporting_timezone();
create trigger commission_rules_protect_history
  before insert or update or delete on public.commission_rules
  for each row execute function public.protect_commission_rule_history();
create trigger affiliate_links_validate
  before insert or update on public.affiliate_links
  for each row execute function public.validate_affiliate_link();
create trigger clicks_validate_dimensions
  before insert on public.clicks
  for each row execute function public.validate_click_dimensions();
create trigger acquisitions_validate_identity
  before insert or update on public.acquisitions
  for each row execute function public.validate_acquisition_identity();
create trigger subscriptions_validate_identity
  before insert or update on public.subscriptions
  for each row execute function public.validate_subscription_identity();
create trigger entitlements_validate_identity
  before insert or update on public.entitlements
  for each row execute function public.validate_entitlement_identity();
create trigger transactions_validate_identity
  before insert on public.transactions
  for each row execute function public.validate_transaction_identity();
create trigger refunds_validate_identity
  before insert on public.refunds
  for each row execute function public.validate_refund_identity();
create trigger disputes_validate_identity
  before insert on public.disputes
  for each row execute function public.validate_dispute_identity();
create trigger conversions_validate_identity
  before insert on public.conversions
  for each row execute function public.validate_conversion();
create trigger commission_entries_validate
  before insert on public.commission_entries
  for each row execute function public.validate_commission_entry();
create trigger payout_periods_protect_history
  before insert or update or delete on public.payout_periods
  for each row execute function public.protect_payout_period();
create trigger payout_destinations_protect_history
  before insert or update or delete on public.payout_destinations
  for each row execute function public.protect_payout_destination();
create trigger payout_destinations_record_event
  after insert or update on public.payout_destinations
  for each row execute function public.record_payout_destination_event();
create trigger payouts_protect_history
  before insert or update or delete on public.payouts
  for each row execute function public.protect_payout_history();
create trigger payout_agreement_snapshots_validate
  before insert on public.payout_agreement_snapshots
  for each row execute function public.validate_payout_agreement_snapshot();
create constraint trigger payouts_require_agreement_snapshot
  after insert on public.payouts
  deferrable initially deferred
  for each row execute function public.require_payout_agreement_snapshot();
create trigger affiliate_daily_metrics_validate
  before insert or update on public.affiliate_daily_metrics
  for each row execute function public.validate_affiliate_daily_metric();
create trigger reconciliation_runs_protect_history
  before insert or update or delete on public.reconciliation_runs
  for each row execute function public.protect_reconciliation_run();
create trigger reconciliation_exceptions_protect_history
  before insert or update or delete on public.reconciliation_exceptions
  for each row execute function public.protect_reconciliation_exception();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'clicks', 'provider_events', 'events', 'transactions', 'refunds', 'disputes',
    'conversions', 'commission_entries', 'payout_destination_events',
    'payout_agreement_snapshots', 'audit_logs'
  ] loop
    execute format(
      'create trigger %I before update or delete on public.%I for each row execute function public.reject_mutation()',
      table_name || '_are_append_only', table_name
    );
  end loop;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'platform_settings', 'profiles', 'admin_users', 'affiliates', 'affiliate_users', 'affiliate_settings',
    'agreements', 'commission_rules', 'funnels', 'campaigns', 'affiliate_links',
    'provider_events', 'provider_event_processing', 'subscriptions', 'entitlements',
    'payout_periods', 'payout_destinations', 'payouts', 'payout_agreement_snapshots', 'documents',
    'reconciliation_runs', 'reconciliation_exceptions'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_mutation()',
      table_name || '_audit_mutation', table_name
    );
  end loop;
end;
$$;

create trigger kissmyapps_create_profile
  after insert on auth.users
  for each row execute function public.handle_new_user();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'products', 'platform_settings', 'profiles', 'admin_users', 'affiliates', 'affiliate_users',
    'affiliate_settings', 'accounts', 'agreements', 'commission_rules', 'funnels',
    'sources', 'campaigns', 'affiliate_links', 'clicks', 'acquisitions',
    'provider_events', 'provider_event_processing', 'events', 'subscriptions',
    'transactions', 'refunds', 'disputes', 'entitlements', 'conversions',
    'payout_periods', 'commission_entries', 'payout_destinations',
    'payout_destination_events', 'payouts', 'payout_agreement_snapshots',
    'documents', 'affiliate_daily_metrics', 'audit_logs', 'reconciliation_runs',
    'reconciliation_exceptions'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.current_user_is_admin(array[''owner'']::text[]))',
      'owner_read_' || table_name, table_name
    );
  end loop;
end;
$$;

create policy profiles_read_self on public.profiles
  for select to authenticated using (user_id = auth.uid());
create policy profiles_insert_self on public.profiles
  for insert to authenticated with check (user_id = auth.uid());
create policy profiles_update_self on public.profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy admin_users_read_self on public.admin_users
  for select to authenticated using (user_id = auth.uid());

create policy affiliates_read_own on public.affiliates
  for select to authenticated using (public.current_user_has_affiliate(id));
create policy affiliate_users_read_own on public.affiliate_users
  for select to authenticated using (public.current_user_has_affiliate(affiliate_id));
create policy affiliate_settings_read_own on public.affiliate_settings
  for select to authenticated using (
    user_id = auth.uid() and public.current_user_has_affiliate(affiliate_id)
  );
create policy products_read_related on public.products
  for select to authenticated using (public.current_user_can_view_product(id));
create policy agreements_read_own on public.agreements
  for select to authenticated using (public.current_user_has_affiliate(affiliate_id));
create policy commission_rules_read_own on public.commission_rules
  for select to authenticated using (
    exists (
      select 1 from public.agreements as agreement
      where agreement.id = commission_rules.agreement_id
        and public.current_user_has_affiliate(agreement.affiliate_id)
    )
  );
create policy affiliate_links_read_own on public.affiliate_links
  for select to authenticated using (public.current_user_has_affiliate(affiliate_id));
create policy commission_entries_read_own on public.commission_entries
  for select to authenticated using (public.current_user_has_affiliate(affiliate_id));
create policy payouts_read_own on public.payouts
  for select to authenticated using (public.current_user_has_affiliate(affiliate_id));
create policy payout_destinations_read_own on public.payout_destinations
  for select to authenticated using (public.current_user_has_affiliate(affiliate_id));
create policy documents_read_own on public.documents
  for select to authenticated using (public.current_user_has_affiliate(affiliate_id));
create policy affiliate_daily_metrics_read_own on public.affiliate_daily_metrics
  for select to authenticated using (public.current_user_has_affiliate(affiliate_id));

create policy accounts_read_self on public.accounts
  for select to authenticated using (auth_user_id = auth.uid());
create policy subscriptions_read_self on public.subscriptions
  for select to authenticated using (
    exists (
      select 1 from public.accounts as account
      where account.id = subscriptions.account_id and account.auth_user_id = auth.uid()
    )
  );
create policy entitlements_read_self on public.entitlements
  for select to authenticated using (
    exists (
      select 1 from public.accounts as account
      where account.id = entitlements.account_id and account.auth_user_id = auth.uid()
    )
  );

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'products', 'profiles', 'affiliates', 'affiliate_users', 'affiliate_settings',
    'agreements', 'commission_rules', 'funnels', 'sources', 'campaigns',
    'affiliate_links', 'clicks', 'acquisitions', 'provider_events',
    'provider_event_processing', 'events', 'subscriptions', 'entitlements',
    'documents', 'affiliate_daily_metrics', 'audit_logs', 'reconciliation_runs',
    'reconciliation_exceptions'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.current_user_is_admin(array[''operations'']::text[]))',
      'operations_read_' || table_name, table_name
    );
  end loop;

  foreach table_name in array array[
    'products', 'affiliates', 'agreements', 'commission_rules', 'subscriptions',
    'transactions', 'refunds', 'disputes', 'conversions', 'payout_periods',
    'commission_entries', 'payout_destinations', 'payout_destination_events',
    'payouts', 'payout_agreement_snapshots', 'documents', 'affiliate_daily_metrics',
    'reconciliation_runs', 'reconciliation_exceptions'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.current_user_is_admin(array[''finance'']::text[]))',
      'finance_read_' || table_name, table_name
    );
  end loop;

  foreach table_name in array array[
    'products', 'affiliates', 'agreements', 'commission_rules', 'affiliate_links',
    'payout_periods', 'commission_entries', 'payouts', 'payout_agreement_snapshots',
    'affiliate_daily_metrics', 'reconciliation_runs', 'reconciliation_exceptions'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.current_user_is_admin(array[''analyst'']::text[]))',
      'analyst_read_' || table_name, table_name
    );
  end loop;

  foreach table_name in array array[
    'profiles', 'affiliates', 'affiliate_users', 'affiliate_settings', 'documents'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.current_user_is_admin(array[''support'']::text[]))',
      'support_read_' || table_name, table_name
    );
  end loop;
end;
$$;

insert into storage.buckets (id, name, public)
values ('affiliate-private-documents', 'affiliate-private-documents', false)
on conflict (id) do nothing;

drop policy if exists affiliate_private_documents_partner_read on storage.objects;
create policy affiliate_private_documents_partner_read
  on storage.objects for select to authenticated
  using (
    public.current_user_can_download_storage_object(bucket_id, name)
  );

drop policy if exists affiliate_private_documents_admin_read on storage.objects;
create policy affiliate_private_documents_admin_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'affiliate-private-documents'
    and public.current_user_is_admin(array['owner', 'operations', 'support']::text[])
  );

create view public.partner_profile
with (security_barrier = true)
as
select
  auth.jwt() ->> 'email' as email,
  coalesce(profile.full_name, affiliate.public_name) as full_name,
  affiliate.public_name,
  coalesce(affiliate.legal_name, affiliate.public_name) as legal_name,
  case affiliate.entity_type
    when 'individual' then 'Individual'
    when 'company' then 'Company'
    else null
  end as entity_type,
  affiliate.country_code,
  affiliate.reporting_timezone as timezone,
  affiliate.preferred_currency,
  affiliate.website_url as website,
  affiliate.category,
  affiliate.audience_description,
  affiliate.audience_countries,
  affiliate.channels,
  affiliate.channel_details,
  membership.role,
  affiliate.status,
  jsonb_build_object(
    'statements', coalesce(settings.notify_statements, true),
    'payouts', coalesce(settings.notify_payouts, true),
    'verification', coalesce(settings.notify_verification, true),
    'signatures', coalesce(settings.notify_signatures, true),
    'adjustments', coalesce(settings.notify_adjustments, true),
    'inactive_links', coalesce(settings.notify_inactive_links, true)
  ) as notifications
from public.affiliate_users as membership
join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
left join public.profiles as profile on profile.user_id = membership.user_id
left join public.affiliate_settings as settings
  on settings.affiliate_id = affiliate.id and settings.user_id = membership.user_id
where membership.user_id = auth.uid()
  and membership.active
  and affiliate.status in ('active', 'paused');

create view public.partner_product_directory
with (security_barrier = true)
as
select distinct
  product.id,
  product.slug,
  product.name,
  product.status,
  agreement.status as agreement_status,
  agreement.model as commercial_model,
  agreement.payout_currency,
  exists (
    select 1 from public.funnels as live_funnel
    where live_funnel.product_id = product.id and live_funnel.status = 'live'
  ) as has_live_funnel,
  case
    when affiliate.status = 'active'
      and product.status = 'active'
      and agreement.status = 'active'
      and setting.tracking_base_url is not null
      and exists (
        select 1 from public.funnels as live_funnel
        where live_funnel.product_id = product.id and live_funnel.status = 'live'
      )
    then setting.tracking_base_url || '/r/' || affiliate.slug
    else null
  end as main_tracking_url
from public.affiliate_users as membership
join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
join public.products as product on (
  exists (
    select 1 from public.agreements as agreement
    where agreement.affiliate_id = membership.affiliate_id and agreement.product_id = product.id
  )
  or exists (
    select 1 from public.affiliate_links as link
    where link.affiliate_id = membership.affiliate_id and link.product_id = product.id
  )
  or exists (
    select 1 from public.payouts as payout
    where payout.affiliate_id = membership.affiliate_id and payout.product_id = product.id
  )
  or exists (
    select 1 from public.affiliate_daily_metrics as metric
    where metric.affiliate_id = membership.affiliate_id and metric.product_id = product.id
  )
)
left join lateral (
  select candidate.status, candidate.model, candidate.payout_currency
  from public.agreements as candidate
  where candidate.affiliate_id = membership.affiliate_id
    and candidate.product_id = product.id
  order by (candidate.status = 'active') desc, candidate.version desc
  limit 1
) as agreement on true
left join public.platform_settings as setting on setting.singleton
where membership.user_id = auth.uid()
  and membership.active
  and affiliate.status in ('active', 'paused');

create view public.partner_link_option_directory
with (security_barrier = true)
as
select
  funnel.id,
  'funnel'::text as kind,
  funnel.product_id,
  funnel.key,
  funnel.name,
  (
    affiliate.status = 'active'
    and product.status = 'active'
    and funnel.status = 'live'
    and exists (
      select 1 from public.agreements as agreement
      where agreement.affiliate_id = membership.affiliate_id
        and agreement.product_id = funnel.product_id
        and agreement.status = 'active'
    )
  ) as available
from public.affiliate_users as membership
join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
join public.funnels as funnel on exists (
  select 1 from public.agreements as agreement
  where agreement.affiliate_id = membership.affiliate_id
    and agreement.product_id = funnel.product_id
)
join public.products as product on product.id = funnel.product_id
where membership.user_id = auth.uid()
  and membership.active
  and affiliate.status in ('active', 'paused')
union all
select
  campaign.id,
  'campaign'::text,
  campaign.product_id,
  campaign.key,
  campaign.name,
  (
    affiliate.status = 'active'
    and product.status = 'active'
    and campaign.status = 'active'
    and exists (
      select 1 from public.agreements as agreement
      where agreement.affiliate_id = membership.affiliate_id
        and agreement.product_id = campaign.product_id
        and agreement.status = 'active'
    )
  )
from public.affiliate_users as membership
join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
join public.campaigns as campaign on exists (
  select 1 from public.agreements as agreement
  where agreement.affiliate_id = membership.affiliate_id
    and agreement.product_id = campaign.product_id
)
join public.products as product on product.id = campaign.product_id
where membership.user_id = auth.uid()
  and membership.active
  and affiliate.status in ('active', 'paused')
union all
select
  source.id,
  'source'::text,
  null::uuid,
  source.key,
  source.name,
  (affiliate.status = 'active')
from public.affiliate_users as membership
join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
cross join public.sources as source
where membership.user_id = auth.uid()
  and membership.active
  and affiliate.status in ('active', 'paused')
  and exists (
    select 1 from public.agreements as agreement
    where agreement.affiliate_id = membership.affiliate_id
  );

create view public.partner_link_directory
with (security_barrier = true)
as
select
  link.id,
  link.name,
  link.product_id,
  product.name as product_name,
  product.slug as product_slug,
  link.funnel_id,
  funnel.name as funnel_name,
  link.source_id,
  source.name as source_name,
  link.campaign_id,
  campaign.name as campaign_name,
  link.sub1,
  coalesce(link.sub2, '') as sub2,
  coalesce(link.sub3, '') as sub3,
  link.status,
  link.tracking_url,
  link.parent_link_id,
  metric.clicks,
  metric.leads,
  metric.installs,
  metric.purchases,
  metric.earnings_minor,
  agreement.payout_currency as currency,
  link.created_at
from public.affiliate_links as link
join public.affiliates as affiliate on affiliate.id = link.affiliate_id
join public.products as product on product.id = link.product_id
join public.funnels as funnel on funnel.id = link.funnel_id
left join public.sources as source on source.id = link.source_id
left join public.campaigns as campaign on campaign.id = link.campaign_id
join lateral (
  select candidate.payout_currency
  from public.agreements as candidate
  where candidate.affiliate_id = link.affiliate_id and candidate.product_id = link.product_id
  order by (candidate.status = 'active') desc, candidate.version desc
  limit 1
) as agreement on true
left join lateral (
  select
    (select count(*)::bigint from public.clicks as click where click.affiliate_link_id = link.id) as clicks,
    (
      select count(*)::bigint
      from public.conversions as conversion
      join public.commission_rules as rule on rule.id = conversion.commission_rule_id and rule.model = 'cpl'
      join public.acquisitions as acquisition on acquisition.id = conversion.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and conversion.qualified
    ) as leads,
    (
      select case when count(*) = 0 then null else count(*)::bigint end
      from public.acquisitions as acquisition
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and acquisition.attribution_method = 'singular'
    ) as installs,
    (
      select count(*)::bigint
      from public.transactions as transaction
      join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id
    ) as purchases,
    (
      select coalesce(sum(entry.amount_minor), 0)::bigint
      from public.commission_entries as entry
      join public.conversions as conversion on conversion.id = entry.conversion_id
      join public.acquisitions as acquisition on acquisition.id = conversion.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id
        and entry.entry_type = 'commission'
        and entry.currency = agreement.payout_currency
    ) as earnings_minor
) as metric on true
where public.current_user_has_affiliate(link.affiliate_id);

create view public.partner_payout_summary
with (security_barrier = true)
as
select
  case when count(distinct payout.currency) = 1 then min(payout.currency) end as currency,
  case when count(distinct payout.currency) = 1 then
    coalesce(sum(payout.final_payout_minor) filter (where payout.status in ('open', 'review', 'on_hold')), 0)::bigint
  end as open_minor,
  case when count(distinct payout.currency) = 1 then
    coalesce(sum(payout.final_payout_minor) filter (where payout.status = 'approved'), 0)::bigint
  end as approved_minor,
  case when count(distinct payout.currency) = 1 then
    coalesce(sum(payout.final_payout_minor) filter (where payout.status = 'scheduled'), 0)::bigint
  end as scheduled_minor,
  case when count(distinct payout.currency) = 1 then
    coalesce(sum(payout.final_payout_minor) filter (where payout.status = 'paid'), 0)::bigint
  end as paid_minor,
  case when count(distinct payout.currency) = 1 then
    (array_agg(
      case
        when payout.status = 'carried_forward' then payout.carry_out_minor
        when payout.status in ('open', 'review', 'on_hold') then payout.carry_in_minor
        else 0
      end
      order by period.ends_at desc, payout.id desc
    ))[1]::bigint
  end as carried_forward_minor,
  min(period.payout_due_at) filter (where payout.status in ('open', 'review', 'approved', 'scheduled')) as next_expected_payment_at,
  payout.product_id
from public.payouts as payout
join public.products as product on product.id = payout.product_id
join public.payout_periods as period on period.id = payout.payout_period_id
where public.current_user_has_affiliate(payout.affiliate_id)
  and exists (
    select 1 from public.payout_agreement_snapshots as snapshot where snapshot.payout_id = payout.id
  )
group by payout.affiliate_id, payout.product_id;

create view public.partner_payout_history
with (security_barrier = true)
as
select
  payout.id,
  product.name as product_name,
  period.starts_at as period_starts_at,
  period.ends_at as period_ends_at,
  period.payout_due_at as expected_payment_at,
  payout.status,
  payout.eligible_net_minor,
  payout.earnings_minor,
  payout.adjustments_minor,
  payout.final_payout_minor,
  payout.currency,
  payout.statement_number,
  exists (
    select 1 from storage.objects as object
    where object.bucket_id = 'affiliate-private-documents'
      and object.name = payout.statement_storage_path
  ) as statement_available,
  payout.payment_method_snapshot as payment_method,
  payout.payment_reference,
  payout.paid_at,
  payout.product_id
from public.payouts as payout
join public.products as product on product.id = payout.product_id
join public.payout_periods as period on period.id = payout.payout_period_id
where public.current_user_has_affiliate(payout.affiliate_id)
  and exists (
    select 1 from public.payout_agreement_snapshots as snapshot where snapshot.payout_id = payout.id
  );

create view public.partner_document_directory
with (security_barrier = true)
as
select
  document.id,
  document.name,
  document.document_type,
  document.version,
  document.status,
  document.created_at,
  document.effective_at,
  document.expires_at,
  document.terminated_at,
  document.signed_by_partner_at as partner_signed_at,
  document.signed_by_kissmyapps_at as company_signed_at,
  document.supersedes_document_id,
  superseding.id as superseded_by_document_id,
  document.status <> 'draft' and exists (
    select 1 from storage.objects as object
    where object.bucket_id = 'affiliate-private-documents' and object.name = document.file_path
  ) as download_available,
  agreement.product_id
from public.documents as document
left join public.agreements as agreement on agreement.id = document.agreement_id
left join public.documents as superseding on superseding.supersedes_document_id = document.id
where public.current_user_has_affiliate(document.affiliate_id);

create view public.partner_agreement_directory
with (security_barrier = true)
as
select
  agreement.product_id,
  product.name as product_name,
  agreement.version,
  agreement.model,
  agreement.status,
  agreement.attribution_window_days,
  agreement.renewal_duration_days,
  agreement.payout_frequency_days,
  agreement.payout_currency,
  agreement.minimum_payout_minor,
  agreement.starts_at,
  agreement.ends_at,
  coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'name', rule.name,
        'version', rule.version,
        'status', rule.status,
        'model', rule.model,
        'trigger_event', rule.trigger_event,
        'fixed_amount_minor', rule.fixed_amount_minor,
        'rate_basis_points', rule.rate_basis_points,
        'currency', rule.currency,
        'validation_window_hours', rule.validation_window_hours
      ) order by rule.name, rule.version
    )
    from public.commission_rules as rule
    where rule.agreement_id = agreement.id
  ), '[]'::jsonb) as rules
from public.agreements as agreement
join public.products as product on product.id = agreement.product_id
where public.current_user_has_affiliate(agreement.affiliate_id);

create or replace function public.get_partner_dashboard_summary(
  p_product_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_timezone text,
  p_source_id uuid,
  p_campaign_id uuid,
  p_funnel_id uuid,
  p_country_code text,
  p_sub_id text
)
returns table (
  starts_on date,
  ends_on date,
  timezone text,
  currency text,
  has_data boolean,
  reconciliation_stage public.reconciliation_stage,
  reconciled_through date,
  clicks bigint,
  visitors bigint,
  funnel_starts bigint,
  payment_views bigint,
  app_store_clicks bigint,
  leads bigint,
  trials bigint,
  installs bigint,
  purchases bigint,
  activations bigint,
  renewals bigint,
  cancellations bigint,
  refunds bigint,
  disputes bigint,
  gross_collected_minor bigint,
  eligible_revenue_minor bigint,
  earnings_minor bigint,
  active_subscriptions bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  partner_id uuid;
  partner_timezone text;
begin
  partner_id := public.current_partner_affiliate_id(false);
  select affiliate.reporting_timezone into partner_timezone
  from public.affiliates as affiliate where affiliate.id = partner_id;

  if p_product_id is null or not public.current_user_can_view_product(p_product_id) then
    raise exception 'an authorized product is required' using errcode = '42501';
  end if;

  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on
     or p_ends_on - p_starts_on > 366 then
    raise exception 'reporting period must contain between 1 and 367 days' using errcode = '22023';
  end if;
  if p_timezone is null or p_timezone <> partner_timezone then
    raise exception 'reporting timezone must match the partner profile' using errcode = '22023';
  end if;
  if p_country_code is not null and p_country_code !~ '^[A-Z]{2}$' then
    raise exception 'country code must be ISO alpha-2 uppercase' using errcode = '22023';
  end if;
  if p_sub_id is not null and char_length(p_sub_id) > 64 then
    raise exception 'sub ID filter is too long' using errcode = '22023';
  end if;

  return query
  with filtered as (
    select metric.*
    from public.affiliate_daily_metrics as metric
    where metric.affiliate_id = partner_id
      and metric.metric_date between p_starts_on and p_ends_on
      and (p_product_id is null or metric.product_id = p_product_id)
      and (p_source_id is null or metric.source_id = p_source_id)
      and (p_campaign_id is null or metric.campaign_id = p_campaign_id)
      and (p_funnel_id is null or metric.funnel_id = p_funnel_id)
      and (p_country_code is null or metric.country_code = p_country_code)
      and (
        p_sub_id is null
        or metric.sub1 ilike '%' || p_sub_id || '%'
        or metric.sub2 ilike '%' || p_sub_id || '%'
        or metric.sub3 ilike '%' || p_sub_id || '%'
      )
  )
  select
    p_starts_on,
    p_ends_on,
    p_timezone,
    case when count(filtered.id) = 0 or count(distinct filtered.currency) <> 1 then null else min(filtered.currency) end,
    count(filtered.id) > 0,
    case
      when count(filtered.id) = 0 then null
      when not bool_and(filtered.completeness = 'complete') then 'preliminary'::public.reconciliation_stage
      when bool_or(filtered.reconciliation_stage = 'preliminary') then 'preliminary'::public.reconciliation_stage
      when bool_or(filtered.reconciliation_stage = 'reconciled') then 'reconciled'::public.reconciliation_stage
      else 'finalized'::public.reconciliation_stage
    end,
    min(filtered.reconciled_through),
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.clicks)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.visitors)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.funnel_starts)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.payment_views)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.app_store_clicks)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.leads)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.trials)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.installs)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.purchases)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.activations)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.renewals)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.cancellations)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.refunds)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.disputes)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') or count(distinct filtered.currency) <> 1 then null else sum(filtered.gross_collected_minor)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') or count(distinct filtered.currency) <> 1 then null else sum(filtered.eligible_revenue_minor)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') or count(distinct filtered.currency) <> 1 then null else sum(filtered.earnings_minor)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else
      (array_agg(filtered.active_subscriptions order by filtered.metric_date desc, filtered.id desc)
        filter (where filtered.is_subscription_snapshot))[1]
    end
  from filtered;
end;
$$;

create or replace function public.get_partner_dashboard_trends(
  p_product_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_timezone text,
  p_source_id uuid,
  p_campaign_id uuid,
  p_funnel_id uuid,
  p_country_code text,
  p_sub_id text,
  p_grain text,
  p_breakdown text
)
returns table (
  bucket_start date,
  bucket_end date,
  dimension_key text,
  dimension_label text,
  reconciliation_stage public.reconciliation_stage,
  clicks bigint,
  visitors bigint,
  funnel_starts bigint,
  payment_views bigint,
  app_store_clicks bigint,
  leads bigint,
  trials bigint,
  installs bigint,
  purchases bigint,
  activations bigint,
  renewals bigint,
  cancellations bigint,
  refunds bigint,
  disputes bigint,
  gross_collected_minor bigint,
  eligible_revenue_minor bigint,
  earnings_minor bigint,
  active_subscriptions bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  partner_id uuid;
  partner_timezone text;
begin
  partner_id := public.current_partner_affiliate_id(false);
  select affiliate.reporting_timezone into partner_timezone
  from public.affiliates as affiliate where affiliate.id = partner_id;

  if p_product_id is null or not public.current_user_can_view_product(p_product_id) then
    raise exception 'an authorized product is required' using errcode = '42501';
  end if;

  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on
     or p_ends_on - p_starts_on > 366 then
    raise exception 'reporting period must contain between 1 and 367 days' using errcode = '22023';
  end if;
  if p_timezone is null or p_timezone <> partner_timezone then
    raise exception 'reporting timezone must match the partner profile' using errcode = '22023';
  end if;
  if p_country_code is not null and p_country_code !~ '^[A-Z]{2}$' then
    raise exception 'country code must be ISO alpha-2 uppercase' using errcode = '22023';
  end if;
  if p_sub_id is not null and char_length(p_sub_id) > 64 then
    raise exception 'sub ID filter is too long' using errcode = '22023';
  end if;
  if p_grain not in ('day', 'week', 'month') then
    raise exception 'unsupported reporting grain' using errcode = '22023';
  end if;
  if p_breakdown not in ('date', 'source', 'country', 'campaign', 'funnel', 'subId') then
    raise exception 'unsupported reporting breakdown' using errcode = '22023';
  end if;

  return query
  with filtered as (
    select
      metric.*,
      source.key as source_key,
      source.name as source_name,
      campaign.key as campaign_key,
      campaign.name as campaign_name,
      funnel.key as funnel_key,
      funnel.name as funnel_name,
      date_trunc(p_grain, metric.metric_date::timestamp)::date as grouped_date
    from public.affiliate_daily_metrics as metric
    left join public.sources as source on source.id = metric.source_id
    left join public.campaigns as campaign on campaign.id = metric.campaign_id
    left join public.funnels as funnel on funnel.id = metric.funnel_id
    where metric.affiliate_id = partner_id
      and metric.metric_date between p_starts_on and p_ends_on
      and (p_breakdown = 'date' or not metric.is_subscription_snapshot)
      and (p_product_id is null or metric.product_id = p_product_id)
      and (p_source_id is null or metric.source_id = p_source_id)
      and (p_campaign_id is null or metric.campaign_id = p_campaign_id)
      and (p_funnel_id is null or metric.funnel_id = p_funnel_id)
      and (p_country_code is null or metric.country_code = p_country_code)
      and (
        p_sub_id is null
        or metric.sub1 ilike '%' || p_sub_id || '%'
        or metric.sub2 ilike '%' || p_sub_id || '%'
        or metric.sub3 ilike '%' || p_sub_id || '%'
      )
  ), labelled as (
    select
      filtered.*,
      case p_breakdown
        when 'date' then filtered.grouped_date::text
        when 'source' then coalesce(filtered.source_key, 'untagged')
        when 'country' then coalesce(filtered.country_code, 'unknown')
        when 'campaign' then coalesce(filtered.campaign_key, 'untagged')
        when 'funnel' then coalesce(filtered.funnel_key, 'unknown')
        when 'subId' then coalesce(filtered.sub1, 'untagged')
      end as grouped_key,
      case p_breakdown
        when 'date' then filtered.grouped_date::text
        when 'source' then coalesce(filtered.source_name, 'Direct / untagged')
        when 'country' then coalesce(filtered.country_code, 'Unknown')
        when 'campaign' then coalesce(filtered.campaign_name, 'Untagged')
        when 'funnel' then coalesce(filtered.funnel_name, 'Unknown')
        when 'subId' then coalesce(filtered.sub1, 'Untagged')
      end as grouped_label
    from filtered
  )
  select
    labelled.grouped_date,
    case p_grain
      when 'day' then labelled.grouped_date
      when 'week' then (labelled.grouped_date + 6)
      when 'month' then (labelled.grouped_date + interval '1 month - 1 day')::date
    end,
    labelled.grouped_key,
    labelled.grouped_label,
    case
      when not bool_and(labelled.completeness = 'complete') then 'preliminary'::public.reconciliation_stage
      when bool_or(labelled.reconciliation_stage = 'preliminary') then 'preliminary'::public.reconciliation_stage
      when bool_or(labelled.reconciliation_stage = 'reconciled') then 'reconciled'::public.reconciliation_stage
      else 'finalized'::public.reconciliation_stage
    end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.clicks)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.visitors)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.funnel_starts)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.payment_views)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.app_store_clicks)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.leads)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.trials)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.installs)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.purchases)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.activations)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.renewals)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.cancellations)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.refunds)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.disputes)::bigint end,
    case when bool_and(labelled.completeness = 'complete') and count(distinct labelled.currency) = 1 then sum(labelled.gross_collected_minor)::bigint end,
    case when bool_and(labelled.completeness = 'complete') and count(distinct labelled.currency) = 1 then sum(labelled.eligible_revenue_minor)::bigint end,
    case when bool_and(labelled.completeness = 'complete') and count(distinct labelled.currency) = 1 then sum(labelled.earnings_minor)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then
      (array_agg(labelled.active_subscriptions order by labelled.metric_date desc, labelled.id desc)
        filter (where labelled.is_subscription_snapshot))[1]
    end
  from labelled
  group by labelled.grouped_date, labelled.grouped_key, labelled.grouped_label
  order by labelled.grouped_date, labelled.grouped_label;
end;
$$;

create or replace function public.get_partner_payout_detail(p_payout_id uuid)
returns table (
  id uuid,
  product_name text,
  period_starts_at timestamptz,
  period_ends_at timestamptz,
  expected_payment_at timestamptz,
  status public.payout_status,
  eligible_net_minor bigint,
  earnings_minor bigint,
  adjustments_minor bigint,
  final_payout_minor bigint,
  currency text,
  statement_number text,
  statement_available boolean,
  payment_method public.payment_method,
  payment_reference text,
  paid_at timestamptz,
  agreement_version integer,
  agreement_label text,
  commercial_model public.commission_model,
  minimum_payout_minor bigint,
  payout_frequency_days integer,
  calculation jsonb,
  history jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  partner_id uuid;
begin
  partner_id := public.current_partner_affiliate_id(false);
  return query
  select
    payout.id,
    product.name,
    period.starts_at,
    period.ends_at,
    period.payout_due_at,
    payout.status,
    payout.eligible_net_minor,
    payout.earnings_minor,
    payout.adjustments_minor,
    payout.final_payout_minor,
    payout.currency,
    payout.statement_number,
    exists (
      select 1 from storage.objects as object
      where object.bucket_id = 'affiliate-private-documents'
        and object.name = payout.statement_storage_path
    ),
    payout.payment_method_snapshot,
    payout.payment_reference,
    payout.paid_at,
    snapshot.agreement_version,
    'Agreement v' || snapshot.agreement_version::text,
    snapshot.model,
    coalesce(payout.minimum_payout_minor_snapshot, snapshot.minimum_payout_minor),
    coalesce(payout.payout_frequency_days_snapshot, snapshot.payout_frequency_days),
    jsonb_build_array(
      jsonb_build_object('key', 'eligible_net', 'label', 'Eligible net revenue', 'amount_minor', payout.eligible_net_minor, 'note', 'Verified eligible revenue snapshot.'),
      jsonb_build_object('key', 'earnings', 'label', 'Commission earnings', 'amount_minor', payout.earnings_minor, 'note', 'Commission entries in this payout period.'),
      jsonb_build_object('key', 'adjustments', 'label', 'Adjustments', 'amount_minor', payout.adjustments_minor, 'note', 'Refund, dispute, and approved adjustment entries.'),
      jsonb_build_object('key', 'carry_in', 'label', 'Carried in', 'amount_minor', payout.carry_in_minor, 'note', 'Balance carried from an earlier period.'),
      jsonb_build_object('key', 'carry_out', 'label', 'Carried forward', 'amount_minor', -payout.carry_out_minor, 'note', 'Balance retained for a future period.'),
      jsonb_build_object('key', 'final', 'label', 'Final payout', 'amount_minor', payout.final_payout_minor, 'note', 'Immutable amount after finalization.')
    ),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'occurred_at', entry.created_at,
          'label', entry.partner_visible_description,
          'amount_minor', entry.amount_minor
        ) order by entry.created_at, entry.id
      )
      from public.commission_entries as entry
      where entry.affiliate_id = payout.affiliate_id
        and entry.product_id = payout.product_id
        and entry.payout_period_id = payout.payout_period_id
        and entry.currency = payout.currency
    ), '[]'::jsonb)
  from public.payouts as payout
  join public.products as product on product.id = payout.product_id
  join public.payout_periods as period on period.id = payout.payout_period_id
  join lateral (
    select
      frozen.agreement_version,
      frozen.model,
      frozen.minimum_payout_minor,
      frozen.payout_frequency_days
    from public.payout_agreement_snapshots as frozen
    where frozen.payout_id = payout.id
    order by frozen.agreement_version desc
    limit 1
  ) as snapshot on true
  where payout.id = p_payout_id and payout.affiliate_id = partner_id;
end;
$$;

create or replace function public.create_partner_link(p_input jsonb)
returns setof public.partner_link_directory
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'name', 'product_id', 'funnel_id', 'source_id', 'campaign_id',
    'sub1', 'sub2', 'sub3', 'parent_link_id'
  ];
  partner_id uuid;
  product_id_value uuid;
  funnel_id_value uuid;
  source_id_value uuid;
  campaign_id_value uuid;
  parent_link_id_value uuid;
  partner_slug text;
  tracking_base text;
  generated_code text;
  inserted_id uuid;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'link input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) as input_key
    where input_key <> all(allowed_keys)
  ) then
    raise exception 'link input contains unsupported fields' using errcode = '22023';
  end if;

  partner_id := public.current_partner_affiliate_id(true);
  if not public.current_user_has_affiliate_role(partner_id, array['owner', 'member']::text[], true) then
    raise exception 'partner role cannot create links' using errcode = '42501';
  end if;

  product_id_value := nullif(p_input ->> 'product_id', '')::uuid;
  funnel_id_value := nullif(p_input ->> 'funnel_id', '')::uuid;
  source_id_value := nullif(p_input ->> 'source_id', '')::uuid;
  campaign_id_value := nullif(p_input ->> 'campaign_id', '')::uuid;
  parent_link_id_value := nullif(p_input ->> 'parent_link_id', '')::uuid;

  if nullif(trim(p_input ->> 'name'), '') is null
     or product_id_value is null
     or funnel_id_value is null
     or nullif(trim(p_input ->> 'sub1'), '') is null then
    raise exception 'name, product_id, funnel_id, and sub1 are required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.products as product
    where product.id = product_id_value and product.status = 'active'
  ) or not exists (
    select 1 from public.funnels as funnel
    where funnel.id = funnel_id_value and funnel.product_id = product_id_value and funnel.status = 'live'
  ) or not exists (
    select 1 from public.agreements as agreement
    where agreement.affiliate_id = partner_id
      and agreement.product_id = product_id_value
      and agreement.status = 'active'
  ) then
    raise exception 'link requires an active product, live funnel, and active agreement' using errcode = 'P0001';
  end if;
  if source_id_value is not null and not exists (
    select 1 from public.sources as source where source.id = source_id_value
  ) then
    raise exception 'source is unavailable' using errcode = '22023';
  end if;
  if campaign_id_value is not null and not exists (
    select 1 from public.campaigns as campaign
    where campaign.id = campaign_id_value
      and campaign.product_id = product_id_value
      and campaign.status = 'active'
  ) then
    raise exception 'campaign is unavailable for this product' using errcode = '22023';
  end if;

  select affiliate.slug into partner_slug from public.affiliates as affiliate where affiliate.id = partner_id;
  select setting.tracking_base_url into tracking_base from public.platform_settings as setting where setting.singleton;
  if tracking_base is null then
    raise exception 'tracking domain is not configured' using errcode = 'P0001';
  end if;

  generated_code := encode(extensions.gen_random_bytes(18), 'hex');
  insert into public.affiliate_links (
    affiliate_id, product_id, source_id, campaign_id, funnel_id, name,
    public_code, tracking_url, parent_link_id, sub1, sub2, sub3, created_by
  ) values (
    partner_id,
    product_id_value,
    source_id_value,
    campaign_id_value,
    funnel_id_value,
    trim(p_input ->> 'name'),
    generated_code,
    tracking_base || '/r/' || partner_slug || '/' || generated_code,
    parent_link_id_value,
    trim(p_input ->> 'sub1'),
    nullif(trim(p_input ->> 'sub2'), ''),
    nullif(trim(p_input ->> 'sub3'), ''),
    auth.uid()
  ) returning id into inserted_id;

  return query select directory.* from public.partner_link_directory as directory where directory.id = inserted_id;
end;
$$;

create or replace function public.update_partner_link(p_link_id uuid, p_patch jsonb)
returns setof public.partner_link_directory
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['name', 'source_id', 'campaign_id', 'sub1', 'sub2', 'sub3'];
  existing public.affiliate_links%rowtype;
  candidate_source_id uuid;
  candidate_campaign_id uuid;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'link patch must be a non-empty JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_patch) as input_key
    where input_key <> all(allowed_keys)
  ) then
    raise exception 'link patch contains unsupported fields' using errcode = '22023';
  end if;

  select * into existing from public.affiliate_links as link where link.id = p_link_id;
  if existing.id is null
     or not public.current_user_has_affiliate_role(existing.affiliate_id, array['owner', 'member']::text[], true) then
    raise exception 'link not found or role cannot edit it' using errcode = '42501';
  end if;
  if existing.status = 'archived' then
    raise exception 'archived link must be restored before editing' using errcode = 'P0001';
  end if;

  candidate_source_id := case
    when p_patch ? 'source_id' then nullif(p_patch ->> 'source_id', '')::uuid
    else existing.source_id
  end;
  candidate_campaign_id := case
    when p_patch ? 'campaign_id' then nullif(p_patch ->> 'campaign_id', '')::uuid
    else existing.campaign_id
  end;
  if candidate_source_id is not null and not exists (
    select 1 from public.sources as source where source.id = candidate_source_id
  ) then
    raise exception 'source is unavailable' using errcode = '22023';
  end if;
  if candidate_campaign_id is not null and not exists (
    select 1 from public.campaigns as campaign
    where campaign.id = candidate_campaign_id
      and campaign.product_id = existing.product_id
      and campaign.status = 'active'
  ) then
    raise exception 'campaign is unavailable for this product' using errcode = '22023';
  end if;

  update public.affiliate_links as link
  set
    name = case when p_patch ? 'name' then trim(p_patch ->> 'name') else link.name end,
    source_id = case when p_patch ? 'source_id' then nullif(p_patch ->> 'source_id', '')::uuid else link.source_id end,
    campaign_id = case when p_patch ? 'campaign_id' then nullif(p_patch ->> 'campaign_id', '')::uuid else link.campaign_id end,
    sub1 = case when p_patch ? 'sub1' then trim(p_patch ->> 'sub1') else link.sub1 end,
    sub2 = case when p_patch ? 'sub2' then nullif(trim(p_patch ->> 'sub2'), '') else link.sub2 end,
    sub3 = case when p_patch ? 'sub3' then nullif(trim(p_patch ->> 'sub3'), '') else link.sub3 end
  where link.id = p_link_id;

  return query select directory.* from public.partner_link_directory as directory where directory.id = p_link_id;
end;
$$;

create or replace function public.set_partner_link_status(p_link_id uuid, p_status public.link_status)
returns setof public.partner_link_directory
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing public.affiliate_links%rowtype;
begin
  select * into existing from public.affiliate_links as link where link.id = p_link_id;
  if existing.id is null
     or not public.current_user_has_affiliate_role(existing.affiliate_id, array['owner', 'member']::text[], true) then
    raise exception 'link not found or role cannot change its status' using errcode = '42501';
  end if;
  if p_status is null or p_status = existing.status then
    raise exception 'new link status must be different' using errcode = '22023';
  end if;

  update public.affiliate_links as link set status = p_status where link.id = p_link_id;
  return query select directory.* from public.partner_link_directory as directory where directory.id = p_link_id;
end;
$$;

create or replace function public.update_partner_profile(p_profile jsonb)
returns setof public.partner_profile
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'full_name', 'public_name', 'legal_name', 'entity_type', 'country_code',
    'timezone', 'preferred_currency', 'website', 'category', 'audience_description',
    'audience_countries', 'channels', 'channel_details'
  ];
  partner_id uuid;
  audience_country_values text[];
  channel_values text[];
  entity_value public.partner_entity_type;
  existing_timezone text;
begin
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' then
    raise exception 'profile input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_profile) as input_key
    where input_key <> all(allowed_keys)
  ) then
    raise exception 'profile input contains unsupported fields' using errcode = '22023';
  end if;
  partner_id := public.current_partner_affiliate_id(true);
  if not public.current_user_has_affiliate_role(partner_id, array['owner']::text[], true) then
    raise exception 'only a partner owner can update the shared profile' using errcode = '42501';
  end if;

  if nullif(trim(p_profile ->> 'full_name'), '') is null
     or nullif(trim(p_profile ->> 'public_name'), '') is null
     or nullif(trim(p_profile ->> 'legal_name'), '') is null then
    raise exception 'full_name, public_name, and legal_name are required' using errcode = '22023';
  end if;
  entity_value := case p_profile ->> 'entity_type'
    when 'Individual' then 'individual'::public.partner_entity_type
    when 'Company' then 'company'::public.partner_entity_type
    else null
  end;
  if entity_value is null then
    raise exception 'entity_type must be Individual or Company' using errcode = '22023';
  end if;
  if jsonb_typeof(p_profile -> 'audience_countries') <> 'array'
     or jsonb_typeof(p_profile -> 'channels') <> 'array' then
    raise exception 'audience_countries and channels must be arrays' using errcode = '22023';
  end if;
  select affiliate.reporting_timezone into existing_timezone
  from public.affiliates as affiliate where affiliate.id = partner_id;
  if trim(p_profile ->> 'timezone') is distinct from existing_timezone
     and exists (
       select 1 from public.affiliate_daily_metrics as metric where metric.affiliate_id = partner_id
     ) then
    raise exception 'reporting timezone cannot change after daily reporting facts exist' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct value order by value), '{}')
  into audience_country_values
  from jsonb_array_elements_text(p_profile -> 'audience_countries') as item(value);
  select coalesce(array_agg(distinct value order by value), '{}')
  into channel_values
  from jsonb_array_elements_text(p_profile -> 'channels') as item(value);

  insert into public.profiles (user_id, full_name, preferred_timezone)
  values (auth.uid(), trim(p_profile ->> 'full_name'), trim(p_profile ->> 'timezone'))
  on conflict (user_id) do update set
    full_name = excluded.full_name,
    preferred_timezone = excluded.preferred_timezone;

  update public.affiliates as affiliate
  set
    public_name = trim(p_profile ->> 'public_name'),
    legal_name = trim(p_profile ->> 'legal_name'),
    entity_type = entity_value,
    country_code = nullif(trim(p_profile ->> 'country_code'), ''),
    reporting_timezone = trim(p_profile ->> 'timezone'),
    preferred_currency = upper(trim(p_profile ->> 'preferred_currency')),
    website_url = nullif(trim(p_profile ->> 'website'), ''),
    category = nullif(trim(p_profile ->> 'category'), ''),
    audience_description = nullif(trim(p_profile ->> 'audience_description'), ''),
    audience_countries = audience_country_values,
    channels = channel_values,
    channel_details = nullif(trim(p_profile ->> 'channel_details'), '')
  where affiliate.id = partner_id;

  return query select profile.* from public.partner_profile as profile;
end;
$$;

create or replace function public.update_partner_settings(p_settings jsonb)
returns setof public.partner_profile
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  partner_id uuid;
  notifications jsonb;
  allowed_notification_keys constant text[] := array[
    'statements', 'payouts', 'verification', 'signatures', 'adjustments', 'inactive_links'
  ];
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(p_settings) as input_key where input_key <> 'notifications'
     ) then
    raise exception 'settings input supports only notifications' using errcode = '22023';
  end if;
  notifications := p_settings -> 'notifications';
  if notifications is null or jsonb_typeof(notifications) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(notifications) as input_key
       where input_key <> all(allowed_notification_keys)
     )
     or (select count(*) from jsonb_object_keys(notifications)) <> 6 then
    raise exception 'all six notification preferences are required' using errcode = '22023';
  end if;

  partner_id := public.current_partner_affiliate_id(false);
  insert into public.affiliate_settings (
    affiliate_id, user_id, notify_statements, notify_payouts, notify_verification,
    notify_signatures, notify_adjustments, notify_inactive_links
  ) values (
    partner_id,
    auth.uid(),
    (notifications ->> 'statements')::boolean,
    (notifications ->> 'payouts')::boolean,
    (notifications ->> 'verification')::boolean,
    (notifications ->> 'signatures')::boolean,
    (notifications ->> 'adjustments')::boolean,
    (notifications ->> 'inactive_links')::boolean
  )
  on conflict (affiliate_id, user_id) do update set
    notify_statements = excluded.notify_statements,
    notify_payouts = excluded.notify_payouts,
    notify_verification = excluded.notify_verification,
    notify_signatures = excluded.notify_signatures,
    notify_adjustments = excluded.notify_adjustments,
    notify_inactive_links = excluded.notify_inactive_links;

  return query select profile.* from public.partner_profile as profile;
end;
$$;

revoke create on schema public from public, anon, authenticated;
revoke usage on schema public from public, anon;
revoke all on schema public from anon;
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant usage on schema public to authenticated;
grant select on
  public.partner_profile,
  public.partner_product_directory,
  public.partner_link_option_directory,
  public.partner_link_directory,
  public.partner_payout_summary,
  public.partner_payout_history,
  public.partner_document_directory,
  public.partner_agreement_directory
to authenticated;

grant execute on function public.current_user_is_admin(text[]) to authenticated;
grant execute on function public.current_user_is_admin() to authenticated;
grant execute on function public.current_user_has_affiliate_role(uuid, text[], boolean) to authenticated;
grant execute on function public.current_user_has_affiliate(uuid) to authenticated;
grant execute on function public.current_user_can_view_product(uuid) to authenticated;
grant execute on function public.storage_path_affiliate_id(text) to authenticated;
grant execute on function public.current_user_can_download_storage_object(text, text) to authenticated;
grant execute on function public.get_partner_dashboard_summary(uuid, date, date, text, uuid, uuid, uuid, text, text) to authenticated;
grant execute on function public.get_partner_dashboard_trends(uuid, date, date, text, uuid, uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.get_partner_payout_detail(uuid) to authenticated;
grant execute on function public.create_partner_link(jsonb) to authenticated;
grant execute on function public.update_partner_link(uuid, jsonb) to authenticated;
grant execute on function public.set_partner_link_status(uuid, public.link_status) to authenticated;
grant execute on function public.update_partner_profile(jsonb) to authenticated;
grant execute on function public.update_partner_settings(jsonb) to authenticated;

alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

comment on schema public is 'Canonical KissMyApps partner, attribution, entitlement, commission, and payout data.';
comment on table public.provider_events is 'Immutable raw provider callbacks keyed by provider event ID; processing state is stored separately.';
comment on table public.events is 'Canonical idempotent events with an explicit source event ID and schema version.';
comment on table public.acquisitions is 'Canonical identity bridge using an unambiguous click-record foreign key.';
comment on table public.commission_entries is 'Append-only commission ledger. Corrections are separate entries posted to a future open period.';
comment on table public.payout_agreement_snapshots is 'Immutable agreement and rule terms frozen into a finalized payout.';
comment on table public.payout_destinations is 'Versioned payout destination history. Provider references are never partner-readable.';
comment on table public.affiliate_daily_metrics is 'Partner-safe pre-aggregated reporting facts with explicit freshness and reconciliation state.';
comment on view public.partner_link_directory is 'Partner allowlist; returns issued tracking URLs but never raw funnel destinations.';
comment on view public.partner_document_directory is 'Partner allowlist; exposes availability but never private object paths.';
