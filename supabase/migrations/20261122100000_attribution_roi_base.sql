-- Attribution Phase 3: return on ad spend and cohorts. The storage only.
--
-- Revenue: a payment a person made, tied to that person, in the currency it was paid in. It
-- comes from the merchant's own events (the SDKs' revenue call, which sets kma_revenue and
-- kma_currency, or an event the merchant names in the console with the property that holds the
-- amount) and from the app stores through RevenueCat or Adapty. A refund is a negative row. Two
-- reports of one store transaction (the app's call and the store tool's webhook) are one row.
--
-- Cost: what the merchant spent to bring people, per day, source and campaign (and, when known,
-- ad set and ad). Typed in, uploaded as a spreadsheet, or later read from Meta and TikTok. A link
-- can also carry a fixed price per install or per click, for creator and influencer deals.
--
-- Exchange rates: the European Central Bank's daily reference rates, so revenue and cost in any
-- of its currencies can be shown in the project's currency (attribution_settings.currency).
--
-- Nothing here is read until a project turns attribution on, and nothing is joined across
-- projects. A person's revenue goes with them when two people are folded into one, and is
-- deleted with them.
begin;

-- Revenue -------------------------------------------------------------------------------------

create table public.attribution_revenue (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  person_id uuid not null references public.analytics_people(id) on delete cascade,
  environment text not null check (environment in ('production', 'development')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  -- In the currency's major unit (4.99 dollars, 500 yen). Negative for a refund.
  amount numeric(20, 6) not null check (amount <> 0 and abs(amount) <= 1000000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- event: an analytics event (event_id, event_name). store: a RevenueCat or Adapty webhook
  -- (store names the tool).
  origin text not null check (origin in ('event', 'store')),
  event_id bigint,
  event_name text check (event_name ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$'),
  store text check (store in ('revenuecat', 'adapty')),
  product_id text check (length(product_id) between 1 and 200),
  transaction_id text check (length(transaction_id) between 1 and 200),
  -- 'txn:<transaction id>' for a payment, 'refund:<transaction id>' for its refund, or
  -- 'event:<event id>' for an event that names no transaction.
  dedupe_key text not null check (length(dedupe_key) between 1 and 220),
  unique (project_id, dedupe_key),
  check ((origin = 'event') = (event_id is not null)),
  check ((origin = 'store') = (store is not null))
);
create index attribution_revenue_project on public.attribution_revenue(project_id, occurred_at desc);
create index attribution_revenue_person on public.attribution_revenue(person_id, occurred_at);

-- The events, besides those carrying kma_revenue, that the merchant says are payments, and
-- where in each the amount and the currency are. Read by the event trigger with one key lookup.
create table public.attribution_revenue_events (
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  event_name text not null check (event_name ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$'),
  amount_property text not null check (amount_property ~ '^[A-Za-z_$][A-Za-z0-9_.$:-]{0,79}$'),
  -- major: 4.99 means 4.99. minor: 499 means 4.99 (cents), by the currency's decimals.
  unit text not null default 'major' check (unit in ('major', 'minor')),
  -- Exactly one: the property that holds the currency code, or the currency every such event
  -- is in.
  currency_property text check (currency_property ~ '^[A-Za-z_$][A-Za-z0-9_.$:-]{0,79}$'),
  currency text check (currency ~ '^[A-Z]{3}$'),
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (project_id, event_name),
  check ((currency_property is null) <> (currency is null))
);

-- Payments that could not be counted, per project, day and reason, so the console can say why.
-- Reasons: no_currency, bad_currency, bad_amount (an event's), no_person (a store payment of
-- someone the project does not know).
create table public.attribution_revenue_skips (
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  day date not null,
  reason text not null check (reason in ('no_currency', 'bad_currency', 'bad_amount', 'no_person')),
  events integer not null default 0 check (events >= 0),
  last_at timestamptz not null default now(),
  primary key (project_id, day, reason)
);

-- Exchange rates ----------------------------------------------------------------------------

-- One ECB reference rate: how many of the currency one euro bought that day. The euro itself
-- is never stored; it is 1.
create table public.attribution_fx_rates (
  currency text not null check (currency ~ '^[A-Z]{3}$' and currency <> 'EUR'),
  day date not null,
  per_eur numeric(20, 8) not null check (per_eur > 0),
  primary key (currency, day)
);

-- Cost --------------------------------------------------------------------------------------

-- One spreadsheet upload, so it can be undone as a whole.
create table public.attribution_cost_imports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  file_name text check (length(file_name) between 1 and 200),
  rows integer not null check (rows >= 0),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index attribution_cost_imports_project on public.attribution_cost_imports(project_id, created_at desc);

-- What was spent on one day for one source and campaign (ad set and ad when known). An empty
-- text means "not split further". Writing the same day and names again replaces the amount.
create table public.attribution_costs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  day date not null,
  source text not null check (source ~ '^[a-z0-9][a-z0-9_.-]{0,59}$'),
  campaign text not null default '' check (length(campaign) <= 200),
  adset text not null default '' check (length(adset) <= 200),
  ad text not null default '' check (length(ad) <= 200),
  amount numeric(20, 6) not null check (amount >= 0 and amount <= 1000000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- manual: typed in the console. csv: a spreadsheet upload (import_id). meta, tiktok: read
  -- from the ad platform (a later phase).
  origin text not null check (origin in ('manual', 'csv', 'meta', 'tiktok')),
  import_id uuid references public.attribution_cost_imports(id) on delete cascade,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((origin = 'csv') = (import_id is not null)),
  check (campaign <> '' or (adset = '' and ad = '')),
  check (adset <> '' or ad = '')
);
create unique index attribution_costs_key on public.attribution_costs(project_id, day, source, campaign, adset, ad);
create index attribution_costs_import on public.attribution_costs(import_id) where import_id is not null;

-- A fixed price per install or per click of one link, for a deal paid that way. The cost of a
-- day is the link's counted installs (or clicks) that day times the price.
create table public.attribution_cost_rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  link_id uuid not null references public.attribution_links(id) on delete cascade,
  kind text not null check (kind in ('install', 'click')),
  amount numeric(20, 6) not null check (amount > 0 and amount <= 1000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  starts_on date not null,
  ends_on date,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (link_id),
  check (ends_on is null or ends_on >= starts_on)
);
create index attribution_cost_rules_project on public.attribution_cost_rules(project_id);

-- Shared helpers ----------------------------------------------------------------------------

-- How many decimals a currency's minor unit has (ISO 4217), for amounts given in cents.
create function kma_internal.currency_exponent(p_currency text) returns integer
language sql immutable set search_path = '' as $$
  select case
    when p_currency in ('BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX',
      'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF') then 0
    when p_currency in ('BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND') then 3
    else 2
  end
$$;

-- What one unit of p_from is worth in p_to on p_day: the latest ECB rate on or before the day
-- for each currency, else the earliest after it. Null when either currency has no ECB rate.
create function kma_internal.attribution_fx_rate(p_from text, p_to text, p_day date) returns numeric
language sql stable set search_path = '' as $$
  with r as (
    select c, case when c = 'EUR' then 1::numeric else coalesce(
      (select x.per_eur from public.attribution_fx_rates x where x.currency = c and x.day <= p_day
        order by x.day desc limit 1),
      (select x.per_eur from public.attribution_fx_rates x where x.currency = c and x.day > p_day
        order by x.day limit 1)) end per_eur
    from unnest(array[p_from, p_to]) c
  )
  select case when p_from = p_to then 1::numeric
    else (select per_eur from r where c = p_to) / nullif((select per_eur from r where c = p_from), 0) end
$$;

-- The ad platform a source name stands for, so spend typed as "meta" meets visits tagged
-- utm_source=facebook or instagram, and "tiktok" meets "tt". Any other name is itself.
create function kma_internal.attribution_source_family(p_source text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_source is null then null
    when lower(btrim(p_source)) in ('meta', 'facebook', 'fb', 'instagram', 'ig', 'facebook.com', 'instagram.com',
      'facebook_ads', 'meta_ads', 'instagram_ads') then 'meta'
    when lower(btrim(p_source)) in ('tiktok', 'tt', 'tiktok.com', 'tiktok_ads') then 'tiktok'
    when lower(btrim(p_source)) in ('google_ads', 'googleads', 'adwords', 'google_adwords') then 'google_ads'
    else lower(btrim(p_source))
  end
$$;

-- Every cost of a project with its day between p_from and p_to (both included), in its own
-- currency. Typed and uploaded costs; the per-install and per-click prices of links are added
-- by 20261122102000_attribution_costs.sql, which replaces this definition (same columns).
create function kma_internal.attribution_cost_lines(p_project uuid, p_from date, p_to date)
returns table (day date, source text, campaign text, adset text, ad text, link_id uuid,
  amount numeric, currency text, origin text)
language sql stable set search_path = '' as $$
  select c.day, c.source, c.campaign, c.adset, c.ad, null::uuid, c.amount, c.currency, c.origin
  from public.attribution_costs c
  where c.project_id = p_project and c.day >= p_from and c.day <= p_to
$$;

-- A person folded into another (analytics_resolve_person) brings their revenue too. The
-- definition from 20261120101000_attribution_install_match.sql with that one line added.
create or replace function kma_internal.attribution_fold_person(p_from uuid, p_into uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  f public.attribution_installs;
  t public.attribution_installs;
begin
  update public.attribution_engagements set person_id = p_into where person_id = p_from;
  update public.attribution_revenue set person_id = p_into where person_id = p_from;
  select * into f from public.attribution_installs where person_id = p_from;
  if f.id is null then
    return;
  end if;
  select * into t from public.attribution_installs where person_id = p_into;
  if t.id is not null and t.installed_at <= f.installed_at then
    return;
  end if;
  delete from public.attribution_installs where id = t.id;
  update public.attribution_installs set person_id = p_into where id = f.id returning * into f;
  update public.analytics_people set acquisition_source = f.source, acquisition_campaign = f.campaign,
    acquisition_method = f.method, installed_at = f.installed_at
  where id = p_into;
end $$;

revoke all on function kma_internal.currency_exponent(text) from public, anon, authenticated;
revoke all on function kma_internal.attribution_fx_rate(text, text, date) from public, anon, authenticated;
revoke all on function kma_internal.attribution_source_family(text) from public, anon, authenticated;
revoke all on function kma_internal.attribution_cost_lines(uuid, date, date) from public, anon, authenticated;

alter table public.attribution_revenue enable row level security;
alter table public.attribution_revenue_events enable row level security;
alter table public.attribution_revenue_skips enable row level security;
alter table public.attribution_fx_rates enable row level security;
alter table public.attribution_cost_imports enable row level security;
alter table public.attribution_costs enable row level security;
alter table public.attribution_cost_rules enable row level security;
revoke all on public.attribution_revenue, public.attribution_revenue_events, public.attribution_revenue_skips,
  public.attribution_fx_rates, public.attribution_cost_imports, public.attribution_costs, public.attribution_cost_rules
  from public, anon, authenticated, service_role;

commit;
