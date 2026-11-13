-- Affiliate self-serve, Phase 2: the tables a merchant's affiliate program lives in.
-- A program belongs to a merchant console workspace. This migration only creates
-- storage; the functions that read and change it come in the migrations after it.
-- Nothing here creates a product, a link or a commission.
begin;

-- One program per workspace (v1). The row is the merchant's working copy: what they
-- last saved in the form. What creators agree to is the latest row in
-- affiliate_program_terms, written when the program is approved or its terms change.
create table public.affiliate_programs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.analytics_workspaces(id),
  -- Set when KissMyApps approves the first listing.
  product_id uuid unique references public.products(id),
  funnel_id uuid unique references public.funnels(id),
  -- Marketplace address: kissmyapps.dev/marketplace/<slug>.
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and length(slug) between 2 and 80),
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'changes_requested', 'live', 'paused', 'archived')),
  pause_reason text check (pause_reason in ('merchant', 'stripe_disconnected', 'admin')),
  review_note text check (length(review_note) between 1 and 1000),

  -- Product card
  name text check (length(btrim(name)) between 1 and 120),
  category text check (category in (
    'education', 'productivity', 'health_fitness', 'lifestyle', 'finance', 'entertainment',
    'games', 'social', 'utilities', 'business', 'shopping', 'travel', 'food_drink',
    'developer_tools', 'other')),
  tagline text check (length(btrim(tagline)) between 1 and 160),
  -- Object path in the public storage bucket program-logos: <workspace_id>/<file>.
  logo_path text check (length(logo_path) between 3 and 300),
  -- Where creator links send people.
  landing_url text check (length(landing_url) <= 2000 and landing_url ~ '^https://'),

  -- Commission
  payment_mode text not null default 'own_checkout' check (payment_mode in ('own_checkout')),
  commission_type text check (commission_type in ('percent', 'fixed')),
  commission_rate_bps integer check (commission_rate_bps between 1 and 10000),
  commission_fixed_minor bigint check (commission_fixed_minor between 1 and 100000000),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  commission_duration text check (commission_duration in ('first_payment', 'months', 'lifetime')),
  commission_months integer check (commission_months between 1 and 36),

  -- More options, with the defaults the form shows
  attribution_window_days integer not null default 30 check (attribution_window_days between 1 and 365),
  hold_days integer not null default 30 check (hold_days between 0 and 90),
  minimum_payout_minor bigint not null default 2000 check (minimum_payout_minor between 0 and 100000000),
  approval_mode text not null default 'automatic' check (approval_mode in ('automatic', 'manual')),
  marketplace_listed boolean not null default true,
  extra_terms text check (length(extra_terms) between 1 and 4000),

  -- The agreement text the merchant last opened and read (hash of the generated document).
  agreement_read_sha256 text check (agreement_read_sha256 ~ '^[a-f0-9]{64}$'),
  agreement_read_at timestamptz,
  -- The latest row in affiliate_program_terms, null until first approval.
  live_terms_version integer check (live_terms_version > 0),

  revision integer not null default 1 check (revision > 0),
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  first_published_at timestamptz,

  constraint affiliate_program_commission_shape check (
    commission_type is null
    or (commission_type = 'percent' and commission_rate_bps is not null and commission_fixed_minor is null)
    or (commission_type = 'fixed' and commission_fixed_minor is not null and commission_rate_bps is null)),
  constraint affiliate_program_duration_shape check (
    (commission_duration is null and commission_months is null)
    or (commission_duration = 'months' and commission_months is not null)
    or (commission_duration in ('first_payment', 'lifetime') and commission_months is null)),
  constraint affiliate_program_pause_has_reason check ((status = 'paused') = (pause_reason is not null)),
  constraint affiliate_program_agreement_read_complete check ((agreement_read_sha256 is null) = (agreement_read_at is null)),
  -- Anything past draft is complete.
  constraint affiliate_program_published_complete check (
    status in ('draft', 'changes_requested', 'archived')
    or (name is not null and category is not null and tagline is not null and landing_url is not null
      and commission_type is not null and commission_duration is not null)),
  constraint affiliate_program_live_has_engine check (
    status not in ('live', 'paused')
    or (product_id is not null and funnel_id is not null and live_terms_version is not null and first_published_at is not null))
);
create unique index affiliate_program_one_per_workspace
  on public.affiliate_programs(workspace_id) where status <> 'archived';
create index affiliate_programs_review_queue
  on public.affiliate_programs(submitted_at) where status = 'in_review';

-- What creators agree to. One row per published version of a program's terms; rows never
-- change. `terms` is the commercial snapshot, `agreement` is the generated document that
-- was shown, and agreement_sha256 is the hash of that document.
create table public.affiliate_program_terms (
  program_id uuid not null references public.affiliate_programs(id),
  version integer not null check (version > 0),
  terms jsonb not null check (jsonb_typeof(terms) = 'object'),
  agreement jsonb not null check (jsonb_typeof(agreement) = 'object'),
  agreement_sha256 text not null check (agreement_sha256 ~ '^[a-f0-9]{64}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (program_id, version)
);

alter table public.affiliate_programs enable row level security;
alter table public.affiliate_program_terms enable row level security;
revoke all on public.affiliate_programs from public, anon, authenticated, service_role;
revoke all on public.affiliate_program_terms from public, anon, authenticated, service_role;

-- The creator click that opened a visit on the merchant's site: the kma_click value the
-- tracking redirect adds to the landing page address, sent by the web SDK. It lets a
-- sale be matched to a creator through the buyer's identified profile when the payment
-- itself carries no creator tag.
alter table public.analytics_sessions
  add column creator_click text check (creator_click ~ '^[A-Za-z0-9_-]{16,128}$');
create index analytics_sessions_creator_click
  on public.analytics_sessions(person_id, started_at desc) where creator_click is not null;

commit;
