begin;

-- A tracking-only product uses the real redirect and first-party analytics
-- boundaries, but it can never create or inherit a commercial fact. The
-- default remains the existing commercial behavior.
create type public.product_tracking_mode as enum ('commercial', 'tracking_only');

alter table public.products
  add column tracking_mode public.product_tracking_mode not null default 'commercial',
  add column tracking_only_funnel_id uuid references public.funnels (id) on delete restrict,
  add column tracking_only_destination_url_snapshot text,
  add column tracking_only_approved_by uuid references auth.users (id) on delete restrict,
  add column tracking_only_approved_at timestamptz,
  add constraint products_tracking_only_approval_complete check (
    (
      tracking_mode = 'commercial'
      and tracking_only_funnel_id is null
      and tracking_only_destination_url_snapshot is null
      and tracking_only_approved_by is null
      and tracking_only_approved_at is null
    )
    or (
      tracking_mode = 'tracking_only'
      and tracking_only_funnel_id is not null
      and tracking_only_destination_url_snapshot is not null
      and tracking_only_approved_by is not null
      and tracking_only_approved_at is not null
      and char_length(tracking_only_destination_url_snapshot) <= 2000
      and tracking_only_destination_url_snapshot ~ '^https://'
    )
  );

alter table public.affiliate_links
  add column commercial_eligible boolean not null default true;

alter table public.clicks
  add column commercial_eligible boolean not null default true;

alter table public.acquisitions
  add column commercial_eligible boolean not null default true;

create index affiliate_links_tracking_scope_idx
  on public.affiliate_links (product_id, affiliate_id, commercial_eligible, status);
create index clicks_tracking_scope_idx
  on public.clicks (product_id, commercial_eligible, occurred_at desc);
create index acquisitions_tracking_scope_idx
  on public.acquisitions (product_id, commercial_eligible, created_at desc);

comment on column public.products.tracking_mode is
  'Explicit commercial or tracking-only operating mode. Tracking-only requires an Owner approval snapshot.';
comment on column public.products.tracking_only_destination_url_snapshot is
  'Audited public HTTPS destination approved for tracking-only redirect use; exact equality is rechecked at use time.';
comment on column public.affiliate_links.commercial_eligible is
  'Immutable issuance-time scope. False links and all descendant facts can never become billable.';
comment on column public.clicks.commercial_eligible is
  'Immutable scope inherited from the issued link at redirect time.';
comment on column public.acquisitions.commercial_eligible is
  'Immutable scope inherited from the canonical click; false attribution can never create commercial facts.';

-- Product mode updates use a real compare-and-swap token even when a test or
-- administrative transaction performs more than one write in one transaction.
create or replace function public.set_products_updated_at()
returns trigger
language plpgsql
volatile
set search_path = ''
as $$
begin
  new.updated_at := greatest(statement_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$;

-- Defined before any views reference it. A repeated CREATE OR REPLACE near the
-- mutation helpers below keeps that section self-contained without changing
-- this contract.
create or replace function public.tracking_only_product_is_ready(p_product_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select
      product.tracking_mode = 'tracking_only'
      and product.tracking_only_funnel_id = funnel.id
      and product.tracking_only_destination_url_snapshot = funnel.destination_url
      and product.tracking_only_approved_by is not null
      and product.tracking_only_approved_at is not null
      and funnel.product_id = product.id
      and funnel.is_default
      and funnel.status = 'live'
      and public.is_production_https_url(funnel.destination_url, true)
    from public.products as product
    join public.funnels as funnel on funnel.id = product.tracking_only_funnel_id
    where product.id = p_product_id
  ), false);
$$;

create or replace function public.validate_affiliate_link()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  funnel_record public.funnels%rowtype;
  product_record public.products%rowtype;
  campaign_product uuid;
  campaign_state text;
  parent_record public.affiliate_links%rowtype;
  old_status public.link_status;
  expected_tracking_url text;
  commercial_scope_ready boolean := false;
  tracking_scope_ready boolean := false;
begin
  select * into funnel_record
  from public.funnels as funnel
  where funnel.id = new.funnel_id;

  select * into product_record
  from public.products as product
  where product.id = new.product_id;

  if funnel_record.product_id is distinct from new.product_id then
    raise exception 'funnel does not belong to the selected product' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and (
    new.affiliate_id <> old.affiliate_id
    or new.product_id <> old.product_id
    or new.funnel_id <> old.funnel_id
    or new.source_id is distinct from old.source_id
    or new.campaign_id is distinct from old.campaign_id
    or new.public_code <> old.public_code
    or new.tracking_url <> old.tracking_url
    or new.parent_link_id is distinct from old.parent_link_id
    or new.sub1 is distinct from old.sub1
    or new.sub2 is distinct from old.sub2
    or new.sub3 is distinct from old.sub3
    or new.is_main <> old.is_main
    or new.commercial_eligible <> old.commercial_eligible
  ) then
    raise exception 'issued link attribution, commercial scope, and routing are immutable'
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    select setting.tracking_base_url || '/r/' || affiliate.slug || '/' || new.public_code
    into expected_tracking_url
    from public.affiliates as affiliate
    cross join public.platform_settings as setting
    where affiliate.id = new.affiliate_id and setting.singleton;

    if expected_tracking_url is null or new.tracking_url <> expected_tracking_url then
      raise exception 'tracking URL must be issued from the configured tracking domain'
        using errcode = '23514';
    end if;
    if new.commercial_eligible <> (product_record.tracking_mode = 'commercial') then
      raise exception 'link commercial scope must match the product mode at issuance'
        using errcode = '23514';
    end if;
  end if;

  if new.is_main then
    if new.parent_link_id is not null
       or new.source_id is not null
       or new.campaign_id is not null
       or new.sub1 is not null
       or new.sub2 is not null
       or new.sub3 is not null then
      raise exception 'main links cannot contain parent, source, campaign, or Sub ID dimensions'
        using errcode = '23514';
    end if;
    if not coalesce(funnel_record.is_default, false) then
      raise exception 'a main link must route through the product default funnel'
        using errcode = '23514';
    end if;
  end if;

  if new.campaign_id is not null then
    select campaign.product_id, campaign.status
    into campaign_product, campaign_state
    from public.campaigns as campaign
    where campaign.id = new.campaign_id;

    if campaign_product is distinct from new.product_id then
      raise exception 'campaign does not belong to the selected product' using errcode = '23514';
    end if;
    if new.status = 'active' and campaign_state <> 'active' then
      raise exception 'active links require an active campaign' using errcode = '23514';
    end if;
  end if;

  if new.parent_link_id is not null then
    select * into parent_record
    from public.affiliate_links
    where id = new.parent_link_id;

    if parent_record.id is null
       or not parent_record.is_main
       or parent_record.status <> 'active'
       or parent_record.affiliate_id <> new.affiliate_id
       or parent_record.product_id <> new.product_id
       or parent_record.commercial_eligible <> new.commercial_eligible then
      raise exception 'parent link must be the current active main link with the same scope'
        using errcode = '23514';
    end if;
  elsif not new.is_main and not new.commercial_eligible then
    raise exception 'tracking-only derived links require the current main parent link'
      using errcode = '23514';
  end if;

  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    commercial_scope_ready :=
      new.commercial_eligible
      and product_record.tracking_mode = 'commercial'
      and exists (
        select 1
        from public.agreements as agreement
        where agreement.affiliate_id = new.affiliate_id
          and agreement.product_id = new.product_id
          and public.agreement_is_launch_ready(agreement.id, now())
      );

    tracking_scope_ready :=
      not new.commercial_eligible
      and public.tracking_only_product_is_ready(new.product_id)
      and product_record.tracking_only_funnel_id = new.funnel_id
      and product_record.tracking_only_destination_url_snapshot = funnel_record.destination_url;

    if product_record.status <> 'active'
       or funnel_record.status <> 'live'
       or not (commercial_scope_ready or tracking_scope_ready) then
      raise exception 'active link requires a ready commercial chain or approved tracking-only funnel'
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    old_status := old.status;
    if not (
      (old_status = 'active' and new.status in ('paused', 'archived'))
      or (old_status = 'paused' and new.status in ('active', 'archived'))
      or (old_status = 'archived' and new.status = 'paused')
    ) then
      raise exception 'invalid affiliate link status transition: % -> %', old.status, new.status
        using errcode = 'P0001';
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
  funnel_destination text;
begin
  if tg_op = 'UPDATE' and (
    new.public_click_id <> old.public_click_id
    or new.affiliate_link_id <> old.affiliate_link_id
    or new.affiliate_id <> old.affiliate_id
    or new.product_id <> old.product_id
    or new.source_id is distinct from old.source_id
    or new.campaign_id is distinct from old.campaign_id
    or new.funnel_id <> old.funnel_id
    or new.sub1 is distinct from old.sub1
    or new.sub2 is distinct from old.sub2
    or new.sub3 is distinct from old.sub3
    or new.destination_url_snapshot <> old.destination_url_snapshot
    or new.commercial_eligible <> old.commercial_eligible
  ) then
    raise exception 'click attribution, routing, and commercial scope are immutable'
      using errcode = 'P0001';
  end if;

  select * into link_record
  from public.affiliate_links
  where id = new.affiliate_link_id;

  select funnel.destination_url into funnel_destination
  from public.funnels as funnel
  where funnel.id = new.funnel_id;

  if link_record.id is null
     or link_record.affiliate_id <> new.affiliate_id
     or link_record.product_id <> new.product_id
     or link_record.funnel_id <> new.funnel_id
     or link_record.source_id is distinct from new.source_id
     or link_record.campaign_id is distinct from new.campaign_id
     or link_record.sub1 is distinct from new.sub1
     or link_record.sub2 is distinct from new.sub2
     or link_record.sub3 is distinct from new.sub3
     or link_record.commercial_eligible <> new.commercial_eligible
     or funnel_destination is null
     or funnel_destination is distinct from new.destination_url_snapshot then
    raise exception 'click dimensions, commercial scope, and destination must match the issued link'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger clicks_protect_tracking_scope
  before update of
    public_click_id, affiliate_link_id, affiliate_id, product_id, source_id,
    campaign_id, funnel_id, sub1, sub2, sub3, destination_url_snapshot,
    commercial_eligible
  on public.clicks
  for each row execute function public.validate_click_dimensions();

create or replace function public.validate_acquisition_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  click_record public.clicks%rowtype;
  product_mode public.product_tracking_mode;
begin
  select product.tracking_mode into product_mode
  from public.products as product
  where product.id = new.product_id;

  if new.click_record_id is not null then
    select * into click_record from public.clicks where id = new.click_record_id;
    if click_record.id is null
       or click_record.product_id <> new.product_id
       or click_record.affiliate_id is distinct from new.affiliate_id
       or click_record.source_id is distinct from new.source_id
       or click_record.campaign_id is distinct from new.campaign_id
       or click_record.funnel_id is distinct from new.funnel_id
       or click_record.commercial_eligible <> new.commercial_eligible then
      raise exception 'acquisition dimensions and commercial scope must match its click record'
        using errcode = '23514';
    end if;
  elsif product_mode = 'tracking_only' and new.commercial_eligible then
    raise exception 'tracking-only acquisitions cannot be commercially eligible'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if old.status <> 'open' or new.status not in ('resolved', 'rejected') then
      raise exception 'invalid acquisition status transition: % -> %', old.status, new.status
        using errcode = 'P0001';
    end if;
    if (to_jsonb(new) - 'status' - 'account_id' - 'resolved_at' - 'rejection_reason')
       <> (to_jsonb(old) - 'status' - 'account_id' - 'resolved_at' - 'rejection_reason') then
      raise exception 'acquisition attribution and commercial scope are immutable'
        using errcode = 'P0001';
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
      raise exception 'acquisition resolution must match referencing subscriptions'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from public.events as event
      where event.acquisition_id = new.id
        and event.account_id is not null
        and event.account_id is distinct from new.account_id
    ) then
      raise exception 'acquisition resolution must match account-scoped canonical events'
        using errcode = '23514';
    end if;
    if new.status = 'rejected' and exists (
      select 1 from public.subscriptions as subscription where subscription.acquisition_id = new.id
    ) then
      raise exception 'an acquisition referenced by a subscription cannot be rejected'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.guard_event_commercial_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  acquisition_commercial boolean;
  product_mode public.product_tracking_mode;
begin
  select product.tracking_mode into product_mode
  from public.products as product where product.id = new.product_id;
  if new.acquisition_id is not null then
    select acquisition.commercial_eligible into acquisition_commercial
    from public.acquisitions as acquisition where acquisition.id = new.acquisition_id;
  end if;
  if new.commercial_eligible and (
    product_mode = 'tracking_only'
    or new.acquisition_id is null
    or not coalesce(acquisition_commercial, false)
  ) then
    raise exception 'commercial events require commercially eligible attribution'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger events_00_tracking_scope_guard
  before insert or update on public.events
  for each row execute function public.guard_event_commercial_scope();

revoke all on function public.guard_event_commercial_scope()
  from public, anon, authenticated, service_role;

create or replace function public.issue_admin_main_link(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['affiliate_id', 'product_id'];
  affiliate_id_value uuid;
  product_id_value uuid;
  existing public.affiliate_links%rowtype;
  funnel_record public.funnels%rowtype;
  affiliate_record public.affiliates%rowtype;
  product_record public.products%rowtype;
  tracking_base text;
  generated_code text;
  stored public.affiliate_links%rowtype;
  commercial_scope boolean;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'issue main links');

  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     )
     or not (p_input ?& allowed_keys)
     or jsonb_typeof(p_input -> 'affiliate_id') <> 'string'
     or jsonb_typeof(p_input -> 'product_id') <> 'string' then
    raise exception 'main-link input must contain exactly affiliate_id and product_id'
      using errcode = '22023';
  end if;

  begin
    affiliate_id_value := nullif(trim(p_input ->> 'affiliate_id'), '')::uuid;
    product_id_value := nullif(trim(p_input ->> 'product_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'affiliate_id and product_id must be UUIDs' using errcode = '22023';
  end;

  if affiliate_id_value is null or product_id_value is null then
    raise exception 'affiliate_id and product_id are required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'main-link:' || affiliate_id_value::text || ':' || product_id_value::text,
      0
    )
  );

  select * into product_record
  from public.products as product
  where product.id = product_id_value and product.status = 'active'
  for share;
  commercial_scope := product_record.tracking_mode = 'commercial';

  select * into existing
  from public.affiliate_links as link
  where link.affiliate_id = affiliate_id_value
    and link.product_id = product_id_value
    and link.is_main
    and link.status <> 'archived'
  order by link.created_at desc
  limit 1
  for share;

  select * into affiliate_record
  from public.affiliates as affiliate
  where affiliate.id = affiliate_id_value and affiliate.status = 'active'
  for share;

  select * into funnel_record
  from public.funnels as funnel
  where funnel.product_id = product_id_value
    and funnel.is_default
    and funnel.status = 'live'
    and funnel.destination_url is not null
  for share;

  select setting.tracking_base_url into tracking_base
  from public.platform_settings as setting
  where setting.singleton
    and setting.tracking_enabled
    and setting.tracking_base_url = 'https://go.kissmyapps.dev'
  for share;

  if affiliate_record.id is null or product_record.id is null
     or funnel_record.id is null or tracking_base is null then
    raise exception 'partner, product, default funnel, and production tracking must all be active'
      using errcode = 'P0001';
  end if;

  if commercial_scope then
    if not exists (
      select 1
      from public.agreements as agreement
      where agreement.affiliate_id = affiliate_id_value
        and agreement.product_id = product_id_value
        and public.agreement_is_launch_ready(agreement.id, now())
    ) then
      raise exception 'commercial main links require a signed agreement and purchase rule'
        using errcode = 'P0001';
    end if;
  elsif not public.tracking_only_product_is_ready(product_id_value)
        or product_record.tracking_only_funnel_id <> funnel_record.id
        or product_record.tracking_only_destination_url_snapshot <> funnel_record.destination_url then
    raise exception 'tracking-only main links require the exact Owner-approved funnel snapshot'
      using errcode = 'P0001';
  end if;

  -- Never return a previously issued demo link until its live product, exact
  -- approved funnel snapshot, and canonical gateway have all been rechecked.
  if existing.id is not null then
    if existing.commercial_eligible <> commercial_scope then
      raise exception 'current main link belongs to another commercial scope and must be archived'
        using errcode = 'P0001';
    end if;
    if not commercial_scope and existing.funnel_id <> funnel_record.id then
      raise exception 'current tracking-only main link belongs to a stale approved funnel'
        using errcode = 'P0001';
    end if;
    return to_jsonb(existing);
  end if;

  generated_code := encode(extensions.gen_random_bytes(18), 'hex');
  insert into public.affiliate_links (
    affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
    parent_link_id, sub1, sub2, sub3, is_main, commercial_eligible, created_by
  ) values (
    affiliate_id_value,
    product_id_value,
    funnel_record.id,
    product_record.name || ' · Main',
    generated_code,
    tracking_base || '/r/' || affiliate_record.slug || '/' || generated_code,
    null, null, null, null, true, commercial_scope, auth.uid()
  ) returning * into stored;

  return to_jsonb(stored);
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
  requested_parent_id uuid;
  parent_link public.affiliate_links%rowtype;
  product_record public.products%rowtype;
  funnel_record public.funnels%rowtype;
  partner_slug text;
  tracking_base text;
  generated_code text;
  inserted_id uuid;
  commercial_scope boolean;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     ) then
    raise exception 'link input must be a JSON object with supported fields'
      using errcode = '22023';
  end if;

  partner_id := public.current_partner_affiliate_id(true);
  if not public.current_user_has_affiliate_role(
    partner_id, array['owner', 'member']::text[], true
  ) then
    raise exception 'partner role cannot create links' using errcode = '42501';
  end if;

  begin
    product_id_value := nullif(p_input ->> 'product_id', '')::uuid;
    funnel_id_value := nullif(p_input ->> 'funnel_id', '')::uuid;
    source_id_value := nullif(p_input ->> 'source_id', '')::uuid;
    campaign_id_value := nullif(p_input ->> 'campaign_id', '')::uuid;
    requested_parent_id := nullif(p_input ->> 'parent_link_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'link identifiers must be UUIDs or null' using errcode = '22023';
  end;

  if nullif(trim(p_input ->> 'name'), '') is null
     or product_id_value is null
     or funnel_id_value is null
     or nullif(trim(p_input ->> 'sub1'), '') is null then
    raise exception 'name, product_id, funnel_id, and sub1 are required'
      using errcode = '22023';
  end if;

  select * into product_record
  from public.products as product
  where product.id = product_id_value and product.status = 'active'
  for share;
  select * into funnel_record
  from public.funnels as funnel
  where funnel.id = funnel_id_value
    and funnel.product_id = product_id_value
    and funnel.status = 'live'
  for share;

  if product_record.id is null or funnel_record.id is null then
    raise exception 'link requires an active product and live funnel' using errcode = 'P0001';
  end if;
  commercial_scope := product_record.tracking_mode = 'commercial';

  if commercial_scope then
    if not exists (
      select 1 from public.agreements as agreement
      where agreement.affiliate_id = partner_id
        and agreement.product_id = product_id_value
        and public.agreement_is_launch_ready(agreement.id, now())
    ) then
      raise exception 'commercial links require a launch-ready agreement'
        using errcode = 'P0001';
    end if;
  else
    if not public.tracking_only_product_is_ready(product_id_value)
       or product_record.tracking_only_funnel_id <> funnel_record.id
       or product_record.tracking_only_destination_url_snapshot <> funnel_record.destination_url then
      raise exception 'tracking-only links require the exact Owner-approved funnel snapshot'
        using errcode = 'P0001';
    end if;

    select * into parent_link
    from public.affiliate_links as link
    where link.affiliate_id = partner_id
      and link.product_id = product_id_value
      and link.is_main
      and link.status = 'active'
      and not link.commercial_eligible
    order by link.created_at desc
    limit 1
    for share;

    if parent_link.id is null
       or (requested_parent_id is not null and requested_parent_id <> parent_link.id) then
      raise exception 'tracking-only link requires the current noncommercial main link'
        using errcode = 'P0001';
    end if;
    requested_parent_id := parent_link.id;
  end if;

  if source_id_value is not null and not exists (
    select 1 from public.sources as source
    where source.id = source_id_value and source.active
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

  select affiliate.slug into partner_slug
  from public.affiliates as affiliate
  where affiliate.id = partner_id and affiliate.status = 'active';
  select setting.tracking_base_url into tracking_base
  from public.platform_settings as setting
  where setting.singleton
    and setting.tracking_enabled
    and setting.tracking_base_url = 'https://go.kissmyapps.dev';
  if partner_slug is null or tracking_base is null then
    raise exception 'partner and canonical tracking must be active' using errcode = 'P0001';
  end if;

  generated_code := encode(extensions.gen_random_bytes(18), 'hex');
  insert into public.affiliate_links (
    affiliate_id, product_id, source_id, campaign_id, funnel_id, name,
    public_code, tracking_url, parent_link_id, sub1, sub2, sub3,
    commercial_eligible, created_by
  ) values (
    partner_id, product_id_value, source_id_value, campaign_id_value,
    funnel_id_value, trim(p_input ->> 'name'), generated_code,
    tracking_base || '/r/' || partner_slug || '/' || generated_code,
    requested_parent_id, trim(p_input ->> 'sub1'),
    nullif(trim(p_input ->> 'sub2'), ''), nullif(trim(p_input ->> 'sub3'), ''),
    commercial_scope, auth.uid()
  ) returning id into inserted_id;

  return query
  select directory.* from public.partner_link_directory as directory
  where directory.id = inserted_id;
end;
$$;

revoke all on function public.issue_admin_main_link(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.create_partner_link(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.issue_admin_main_link(jsonb) to authenticated;
grant execute on function public.create_partner_link(jsonb) to authenticated;

create or replace view public.partner_product_directory
with (security_barrier = true)
as
select distinct
  product.id,
  product.slug,
  product.name,
  product.status,
  case when product.tracking_mode = 'commercial' then agreement.status else null end
    as agreement_status,
  case when product.tracking_mode = 'commercial' then agreement.model else null end
    as commercial_model,
  case when product.tracking_mode = 'commercial' then agreement.payout_currency else null end
    as payout_currency,
  exists (
    select 1
    from public.funnels as live_funnel
    where live_funnel.product_id = product.id and live_funnel.status = 'live'
  ) as has_live_funnel,
  case
    when affiliate.status = 'active'
      and product.status = 'active'
      and coalesce(setting.tracking_enabled, false)
      and setting.tracking_base_url = 'https://go.kissmyapps.dev'
      and main_link.tracking_url is not null
      and (
        (
          product.tracking_mode = 'commercial'
          and main_link.commercial_eligible
          and agreement.id is not null
          and public.agreement_is_launch_ready(agreement.id, now())
        )
        or (
          product.tracking_mode = 'tracking_only'
          and not main_link.commercial_eligible
          and public.tracking_only_product_is_ready(product.id)
          and main_link.funnel_id = product.tracking_only_funnel_id
        )
      )
    then main_link.tracking_url
    else null
  end as main_tracking_url,
  product.tracking_mode,
  public.tracking_only_product_is_ready(product.id) as tracking_only_ready,
  main_link.commercial_eligible as main_link_commercial_eligible,
  main_link.id as main_link_id
from public.affiliate_users as membership
join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
join public.products as product on (
  exists (
    select 1 from public.agreements as related_agreement
    where related_agreement.affiliate_id = membership.affiliate_id
      and related_agreement.product_id = product.id
  )
  or exists (
    select 1 from public.affiliate_links as related_link
    where related_link.affiliate_id = membership.affiliate_id
      and related_link.product_id = product.id
  )
  or exists (
    select 1 from public.payouts as related_payout
    where related_payout.affiliate_id = membership.affiliate_id
      and related_payout.product_id = product.id
  )
  or exists (
    select 1 from public.affiliate_daily_metrics as related_metric
    where related_metric.affiliate_id = membership.affiliate_id
      and related_metric.product_id = product.id
  )
)
left join lateral (
  select candidate.id, candidate.status, candidate.model, candidate.payout_currency
  from public.agreements as candidate
  where candidate.affiliate_id = membership.affiliate_id
    and candidate.product_id = product.id
  order by (candidate.status = 'active') desc, candidate.version desc
  limit 1
) as agreement on true
left join lateral (
  select link.id, link.tracking_url, link.funnel_id, link.commercial_eligible
  from public.affiliate_links as link
  join public.funnels as funnel
    on funnel.id = link.funnel_id
   and funnel.product_id = link.product_id
   and funnel.is_default
   and funnel.status = 'live'
  where link.affiliate_id = membership.affiliate_id
    and link.product_id = product.id
    and link.is_main
    and link.status = 'active'
  order by link.created_at desc, link.id desc
  limit 1
) as main_link on true
left join public.platform_settings as setting on setting.singleton
where membership.user_id = auth.uid()
  and membership.active
  and affiliate.status in ('active', 'paused');

create or replace view public.partner_link_option_directory
with (security_barrier = true)
as
with eligible_products as materialized (
  select distinct
    membership.affiliate_id,
    product.id as product_id,
    product.tracking_mode,
    product.tracking_only_funnel_id
  from public.affiliate_users as membership
  join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
  join public.products as product on product.status = 'active'
  left join public.platform_settings as setting on setting.singleton
  where membership.user_id = auth.uid()
    and membership.active
    and affiliate.status = 'active'
    and setting.tracking_enabled
    and setting.tracking_base_url = 'https://go.kissmyapps.dev'
    and (
      (
        product.tracking_mode = 'commercial'
        and exists (
          select 1 from public.agreements as agreement
          where agreement.affiliate_id = membership.affiliate_id
            and agreement.product_id = product.id
            and public.agreement_is_launch_ready(agreement.id, now())
        )
      )
      or (
        product.tracking_mode = 'tracking_only'
        and public.tracking_only_product_is_ready(product.id)
        and exists (
          select 1 from public.affiliate_links as link
          where link.affiliate_id = membership.affiliate_id
            and link.product_id = product.id
            and link.is_main
            and link.status = 'active'
            and not link.commercial_eligible
        )
      )
    )
)
select
  funnel.id,
  'funnel'::text as kind,
  funnel.product_id,
  funnel.key,
  funnel.name,
  (
    funnel.status = 'live'
    and (
      eligible.tracking_mode = 'commercial'
      or funnel.id = eligible.tracking_only_funnel_id
    )
  ) as available
from eligible_products as eligible
join public.funnels as funnel on funnel.product_id = eligible.product_id
union all
select
  campaign.id,
  'campaign'::text,
  campaign.product_id,
  campaign.key,
  campaign.name,
  (campaign.status = 'active')
from eligible_products as eligible
join public.campaigns as campaign on campaign.product_id = eligible.product_id
union all
select
  source.id,
  'source'::text,
  null::uuid,
  source.key,
  source.name,
  source.active
from public.sources as source
where source.active
  and exists (select 1 from eligible_products);

create or replace view public.partner_link_directory
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
  case when link.commercial_eligible then metric.leads else null end as leads,
  metric.installs,
  case when link.commercial_eligible then metric.purchases else null end as purchases,
  case when link.commercial_eligible then metric.earnings_minor else null end as earnings_minor,
  case when link.commercial_eligible then agreement.payout_currency else null end as currency,
  link.created_at,
  product.tracking_mode,
  link.commercial_eligible
from public.affiliate_links as link
join public.affiliates as affiliate on affiliate.id = link.affiliate_id
join public.products as product on product.id = link.product_id
join public.funnels as funnel on funnel.id = link.funnel_id
left join public.sources as source on source.id = link.source_id
left join public.campaigns as campaign on campaign.id = link.campaign_id
left join lateral (
  select candidate.payout_currency
  from public.agreements as candidate
  where candidate.affiliate_id = link.affiliate_id
    and candidate.product_id = link.product_id
  order by (candidate.status = 'active') desc, candidate.version desc
  limit 1
) as agreement on true
left join lateral (
  select
    (select count(*)::bigint from public.clicks as click
      where click.affiliate_link_id = link.id) as clicks,
    (
      select count(*)::bigint
      from public.conversions as conversion
      join public.commission_rules as rule
        on rule.id = conversion.commission_rule_id and rule.model = 'cpl'
      join public.acquisitions as acquisition on acquisition.id = conversion.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and conversion.qualified
    ) as leads,
    (
      select case when count(*) = 0 then null else count(*)::bigint end
      from public.acquisitions as acquisition
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id
        and acquisition.attribution_method = 'singular'
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
        and agreement.payout_currency is not null
        and entry.currency = agreement.payout_currency
    ) as earnings_minor
) as metric on true
where public.current_user_has_affiliate(link.affiliate_id)
  and not link.is_main;

create or replace function public.register_tracking_click(
  p_affiliate_slug text,
  p_public_code text,
  p_context jsonb
)
returns table (
  click_id text,
  destination_url text,
  is_bot boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'country_code', 'session_id_hash', 'user_agent_hash', 'ip_hash', 'is_bot'
  ];
  ip_clicks_per_minute constant integer := 300;
  session_clicks_per_minute constant integer := 30;
  link_id_value uuid;
  affiliate_id_value uuid;
  product_id_value uuid;
  source_id_value uuid;
  campaign_id_value uuid;
  funnel_id_value uuid;
  sub1_value text;
  sub2_value text;
  sub3_value text;
  destination_value text;
  commercial_scope_value boolean;
  country_value text;
  session_hash_value text;
  user_agent_hash_value text;
  ip_hash_value text;
  bot_value boolean := false;
  generated_click_id text;
  click_record_id uuid;
  rate_now timestamptz := statement_timestamp();
  recent_count bigint;
begin
  p_context := coalesce(p_context, '{}'::jsonb);
  if jsonb_typeof(p_context) <> 'object' then
    raise exception 'tracking context must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_context) as input_key
    where input_key <> all(allowed_keys)
  ) then
    raise exception 'tracking context contains unsupported fields' using errcode = '22023';
  end if;
  if nullif(trim(p_affiliate_slug), '') is null
     or nullif(trim(p_public_code), '') is null then
    raise exception 'affiliate slug and public code are required' using errcode = '22023';
  end if;

  country_value := nullif(upper(trim(p_context ->> 'country_code')), '');
  session_hash_value := nullif(lower(trim(p_context ->> 'session_id_hash')), '');
  user_agent_hash_value := nullif(lower(trim(p_context ->> 'user_agent_hash')), '');
  ip_hash_value := nullif(lower(trim(p_context ->> 'ip_hash')), '');

  if country_value is not null and country_value !~ '^[A-Z]{2}$' then
    raise exception 'country code must be ISO alpha-2 uppercase' using errcode = '22023';
  end if;
  if session_hash_value is not null and session_hash_value !~ '^[a-f0-9]{64}$' then
    raise exception 'session hash must be a lowercase SHA-256 digest' using errcode = '22023';
  end if;
  if user_agent_hash_value is not null and user_agent_hash_value !~ '^[a-f0-9]{64}$' then
    raise exception 'user-agent hash must be a lowercase SHA-256 digest' using errcode = '22023';
  end if;
  if ip_hash_value is not null and ip_hash_value !~ '^[a-f0-9]{64}$' then
    raise exception 'IP hash must be a lowercase SHA-256 digest' using errcode = '22023';
  end if;
  if p_context ? 'is_bot' then
    if jsonb_typeof(p_context -> 'is_bot') <> 'boolean' then
      raise exception 'is_bot must be a boolean' using errcode = '22023';
    end if;
    bot_value := (p_context ->> 'is_bot')::boolean;
  end if;

  select
    link.id,
    link.affiliate_id,
    link.product_id,
    link.source_id,
    link.campaign_id,
    link.funnel_id,
    link.sub1,
    link.sub2,
    link.sub3,
    funnel.destination_url,
    link.commercial_eligible
  into
    link_id_value,
    affiliate_id_value,
    product_id_value,
    source_id_value,
    campaign_id_value,
    funnel_id_value,
    sub1_value,
    sub2_value,
    sub3_value,
    destination_value,
    commercial_scope_value
  from public.affiliate_links as link
  join public.affiliates as affiliate
    on affiliate.id = link.affiliate_id and affiliate.status = 'active'
  join public.products as product
    on product.id = link.product_id and product.status = 'active'
  join public.funnels as funnel
    on funnel.id = link.funnel_id
   and funnel.product_id = link.product_id
   and funnel.status = 'live'
   and funnel.destination_url is not null
  left join public.campaigns as campaign on campaign.id = link.campaign_id
  join public.platform_settings as setting
    on setting.singleton
   and setting.tracking_enabled
   and setting.tracking_base_url = 'https://go.kissmyapps.dev'
  where affiliate.slug = trim(p_affiliate_slug)
    and link.public_code = trim(p_public_code)
    and link.status = 'active'
    and (link.campaign_id is null or campaign.status = 'active')
    and (
      (
        link.commercial_eligible
        and product.tracking_mode = 'commercial'
        and public.product_has_launch_ready_billing_offer(product.id)
        and exists (
          select 1
          from public.agreements as agreement
          where agreement.affiliate_id = link.affiliate_id
            and agreement.product_id = link.product_id
            and public.agreement_is_launch_ready(agreement.id, now())
        )
      )
      or (
        not link.commercial_eligible
        and product.tracking_mode = 'tracking_only'
        and public.tracking_only_product_is_ready(product.id)
        and product.tracking_only_funnel_id = funnel.id
        and product.tracking_only_destination_url_snapshot = funnel.destination_url
      )
    )
  for share of link, product, funnel;

  if link_id_value is null then
    raise exception 'tracking route is unavailable' using errcode = 'P0002';
  end if;

  if ip_hash_value is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'tracking-click:ip:' || link_id_value::text || ':' || ip_hash_value, 0
      )
    );
    select count(*) into recent_count
    from public.clicks as click
    where click.affiliate_link_id = link_id_value
      and click.ip_hash = ip_hash_value
      and click.created_at >= rate_now - interval '1 minute';
    if recent_count >= ip_clicks_per_minute then
      raise exception 'tracking click rate limit exceeded' using errcode = 'KMA29';
    end if;
  end if;

  if session_hash_value is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'tracking-click:session:' || link_id_value::text || ':' || session_hash_value, 0
      )
    );
    select count(*) into recent_count
    from public.clicks as click
    where click.affiliate_link_id = link_id_value
      and click.session_id_hash = session_hash_value
      and click.created_at >= rate_now - interval '1 minute';
    if recent_count >= session_clicks_per_minute then
      raise exception 'tracking click rate limit exceeded' using errcode = 'KMA29';
    end if;
  end if;

  generated_click_id := encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.clicks (
    public_click_id, affiliate_link_id, affiliate_id, product_id, source_id,
    campaign_id, funnel_id, sub1, sub2, sub3, destination_url_snapshot,
    country_code, session_id_hash, user_agent_hash, ip_hash, is_bot,
    commercial_eligible
  ) values (
    generated_click_id, link_id_value, affiliate_id_value, product_id_value,
    source_id_value, campaign_id_value, funnel_id_value, sub1_value, sub2_value,
    sub3_value, destination_value, country_value, session_hash_value,
    user_agent_hash_value, ip_hash_value, bot_value, commercial_scope_value
  ) returning id into click_record_id;

  insert into public.acquisitions (
    product_id, affiliate_id, click_record_id, source_id, campaign_id, funnel_id,
    click_country, attribution_method, status, rejection_reason, commercial_eligible
  ) values (
    product_id_value, affiliate_id_value, click_record_id, source_id_value,
    campaign_id_value, funnel_id_value, country_value, 'deterministic_web',
    case when bot_value then 'rejected'::public.acquisition_status
      else 'open'::public.acquisition_status end,
    case when bot_value then 'automated_traffic' else null end,
    commercial_scope_value
  );

  return query select generated_click_id, destination_value, bot_value;
end;
$$;

revoke all on function public.register_tracking_click(text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.register_tracking_click(text, text, jsonb)
  to service_role;

create or replace function public.ingest_funnel_event(p_input jsonb)
returns table (
  event_id uuid,
  duplicate boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'event_id', 'event_name', 'click_id', 'occurred_at', 'properties'
  ];
  external_event_id uuid;
  event_name_value text;
  occurred_at_value timestamptz;
  properties_value jsonb;
  source_event_key text;
  click_record public.clicks%rowtype;
  acquisition_record public.acquisitions%rowtype;
  existing_event public.events%rowtype;
  inserted_event_id uuid;
  commercial_scope_value boolean;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     )
     or not (p_input ?& array['event_id', 'event_name', 'click_id', 'occurred_at']) then
    raise exception 'funnel event input contains unsupported or missing fields'
      using errcode = '22023';
  end if;

  begin
    external_event_id := (p_input ->> 'event_id')::uuid;
    occurred_at_value := (p_input ->> 'occurred_at')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception 'event_id and occurred_at must use canonical UUID and timestamp values'
      using errcode = '22023';
  end;

  event_name_value := trim(p_input ->> 'event_name');
  if event_name_value !~ '^[a-z][a-z0-9_.-]{0,99}$' then
    raise exception 'funnel event name is invalid' using errcode = '22023';
  end if;

  properties_value := coalesce(p_input -> 'properties', '{}'::jsonb);
  if jsonb_typeof(properties_value) <> 'object'
     or octet_length(properties_value::text) > 16384 then
    raise exception 'funnel event properties must be a JSON object no larger than 16 KiB'
      using errcode = '22023';
  end if;
  if properties_value ?| array[
    'affiliate_id', 'product_id', 'funnel_id', 'source_id', 'campaign_id',
    'amount', 'amount_minor', 'currency', 'price', 'revenue'
  ] then
    raise exception 'funnel event properties contain reserved commercial or identity fields'
      using errcode = '22023';
  end if;

  select * into click_record
  from public.clicks
  where public_click_id = p_input ->> 'click_id'
  for update;

  if click_record.id is null or click_record.is_bot then
    raise exception 'click is unavailable for event ingestion' using errcode = 'P0002';
  end if;

  select * into acquisition_record
  from public.acquisitions
  where click_record_id = click_record.id
  for update;

  if acquisition_record.id is null
     or acquisition_record.status = 'rejected'
     or acquisition_record.commercial_eligible <> click_record.commercial_eligible then
    raise exception 'acquisition is unavailable for event ingestion' using errcode = 'P0002';
  end if;
  if occurred_at_value < click_record.occurred_at - interval '5 minutes'
     or occurred_at_value > now() + interval '5 minutes' then
    raise exception 'event timestamp is outside the accepted clock bounds' using errcode = '22023';
  end if;

  commercial_scope_value := acquisition_record.commercial_eligible;
  source_event_key := 'funnel:' || external_event_id::text;
  select * into existing_event
  from public.events
  where source = 'first_party' and source_event_id = source_event_key;

  if existing_event.id is not null then
    if existing_event.acquisition_id is distinct from acquisition_record.id
       or existing_event.event_name <> event_name_value
       or existing_event.schema_version <> 1
       or existing_event.product_id <> acquisition_record.product_id
       or existing_event.affiliate_id is distinct from acquisition_record.affiliate_id
       or existing_event.account_id is distinct from acquisition_record.account_id
       or existing_event.source_id is distinct from acquisition_record.source_id
       or existing_event.campaign_id is distinct from acquisition_record.campaign_id
       or existing_event.funnel_id is distinct from acquisition_record.funnel_id
       or existing_event.provider_event_id is not null
       or existing_event.occurred_at <> occurred_at_value
       or existing_event.properties <> properties_value
       or existing_event.trust <> 'funnel_server'
       or existing_event.commercial_eligible <> commercial_scope_value then
      raise exception 'event ID has already been used for different funnel evidence'
        using errcode = '23505';
    end if;
    return query select existing_event.id, true;
    return;
  end if;

  insert into public.events (
    source, source_event_id, event_name, product_id, affiliate_id,
    acquisition_id, account_id, source_id, campaign_id, funnel_id, properties,
    occurred_at, trust, commercial_eligible
  ) values (
    'first_party', source_event_key, event_name_value,
    acquisition_record.product_id, acquisition_record.affiliate_id,
    acquisition_record.id, acquisition_record.account_id,
    acquisition_record.source_id, acquisition_record.campaign_id,
    acquisition_record.funnel_id, properties_value, occurred_at_value,
    'funnel_server', commercial_scope_value
  )
  on conflict (source, source_event_id) do nothing
  returning id into inserted_event_id;

  if inserted_event_id is null then
    select * into existing_event
    from public.events
    where source = 'first_party' and source_event_id = source_event_key;

    if existing_event.id is null
       or existing_event.acquisition_id is distinct from acquisition_record.id
       or existing_event.event_name <> event_name_value
       or existing_event.schema_version <> 1
       or existing_event.product_id <> acquisition_record.product_id
       or existing_event.affiliate_id is distinct from acquisition_record.affiliate_id
       or existing_event.account_id is distinct from acquisition_record.account_id
       or existing_event.source_id is distinct from acquisition_record.source_id
       or existing_event.campaign_id is distinct from acquisition_record.campaign_id
       or existing_event.funnel_id is distinct from acquisition_record.funnel_id
       or existing_event.provider_event_id is not null
       or existing_event.occurred_at <> occurred_at_value
       or existing_event.properties <> properties_value
       or existing_event.trust <> 'funnel_server'
       or existing_event.commercial_eligible <> commercial_scope_value then
      raise exception 'event ID has already been used for different funnel evidence'
        using errcode = '23505';
    end if;

    return query select existing_event.id, true;
    return;
  end if;

  return query select inserted_event_id, false;
end;
$$;

revoke all on function public.ingest_funnel_event(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.ingest_funnel_event(jsonb) to service_role;

create or replace function public.resolve_stripe_checkout(
  p_attempt_id uuid,
  p_session_id text,
  p_customer_id text,
  p_amount_minor bigint,
  p_currency text
)
returns table (
  account_id uuid,
  acquisition_id uuid,
  product_id uuid,
  affiliate_id uuid,
  source_id uuid,
  campaign_id uuid,
  funnel_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  attempt_record public.checkout_attempts%rowtype;
  acquisition_record public.acquisitions%rowtype;
  click_record public.clicks%rowtype;
  link_record public.affiliate_links%rowtype;
  product_mode public.product_tracking_mode;
  account_id_value uuid;
begin
  select * into attempt_record
  from public.checkout_attempts as attempt
  where attempt.id = p_attempt_id
  for update;

  if attempt_record.id is null then
    raise exception 'Stripe checkout attribution is unavailable' using errcode = 'P0002';
  end if;
  if attempt_record.billing_mode <> 'subscription' then
    raise exception 'one-time Stripe payments are not supported by the subscription ledger'
      using errcode = '0A000';
  end if;
  if attempt_record.status not in ('open', 'completed')
     or attempt_record.stripe_checkout_session_id is distinct from p_session_id
     or attempt_record.unit_amount_minor <> p_amount_minor
     or attempt_record.currency <> upper(p_currency) then
    raise exception 'Stripe checkout evidence conflicts with the durable attempt'
      using errcode = '23514';
  end if;

  select * into acquisition_record
  from public.acquisitions as acquisition
  where acquisition.id = attempt_record.acquisition_id
  for update;
  select * into click_record
  from public.clicks as click
  where click.id = attempt_record.click_record_id
  for share;
  select * into link_record
  from public.affiliate_links as link
  where link.id = click_record.affiliate_link_id
  for share;
  select product.tracking_mode into product_mode
  from public.products as product
  where product.id = attempt_record.product_id
  for share;

  -- This check intentionally precedes customer/account creation. Crafted
  -- Stripe metadata can persist provider evidence but cannot normalize a demo
  -- route or create a Stripe-backed account.
  if acquisition_record.id is null
     or acquisition_record.status = 'rejected'
     or product_mode <> 'commercial'
     or not acquisition_record.commercial_eligible
     or not click_record.commercial_eligible
     or not link_record.commercial_eligible then
    raise exception 'Stripe checkout attribution is unavailable' using errcode = 'P0002';
  end if;

  account_id_value := public.ensure_stripe_customer_account(p_customer_id);

  if acquisition_record.account_id is not null
     and acquisition_record.account_id <> account_id_value then
    raise exception 'Stripe customer conflicts with the canonical acquisition account'
      using errcode = '23514';
  end if;

  if acquisition_record.status = 'open' then
    update public.acquisitions as acquisition
    set status = 'resolved', account_id = account_id_value, resolved_at = now()
    where acquisition.id = acquisition_record.id;
  elsif acquisition_record.status <> 'resolved'
     or acquisition_record.account_id is distinct from account_id_value then
    raise exception 'Stripe checkout acquisition is not resolvable'
      using errcode = '23514';
  end if;

  if attempt_record.status = 'open' then
    update public.checkout_attempts as attempt
    set status = 'completed', completed_at = now()
    where attempt.id = attempt_record.id;
  end if;

  return query select
    account_id_value,
    acquisition_record.id,
    attempt_record.product_id,
    attempt_record.affiliate_id,
    acquisition_record.source_id,
    acquisition_record.campaign_id,
    acquisition_record.funnel_id;
end;
$$;

revoke all on function public.resolve_stripe_checkout(uuid, text, text, bigint, text)
  from public, anon, authenticated, service_role;

create or replace function public.get_admin_product_configuration(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  product_record public.products%rowtype;
  tracking_record public.platform_settings%rowtype;
  viewer_can_manage_routing boolean;
  tracking_only_ready_value boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(
    array['owner', 'operations', 'finance', 'analyst']::text[]
  ) then
    raise exception 'admin role cannot view product configuration' using errcode = '42501';
  end if;

  viewer_can_manage_routing := public.current_user_is_admin(array['owner', 'operations']::text[]);

  select * into product_record
  from public.products as product
  where product.id = p_product_id;
  if product_record.id is null then
    raise exception 'product not found' using errcode = 'P0002';
  end if;

  select * into tracking_record
  from public.platform_settings as setting
  where setting.singleton;
  tracking_only_ready_value := public.tracking_only_product_is_ready(p_product_id);

  return jsonb_build_object(
    'product', jsonb_build_object(
      'id', product_record.id,
      'slug', product_record.slug,
      'name', product_record.name,
      'status', product_record.status,
      'tracking_mode', product_record.tracking_mode,
      'tracking_only_funnel_id', product_record.tracking_only_funnel_id,
      'tracking_only_approved_by', product_record.tracking_only_approved_by,
      'tracking_only_approved_at', product_record.tracking_only_approved_at,
      'created_at', product_record.created_at,
      'updated_at', product_record.updated_at
    ) || case
      when viewer_can_manage_routing then jsonb_build_object(
        'tracking_only_destination_url_snapshot',
        product_record.tracking_only_destination_url_snapshot
      )
      else '{}'::jsonb
    end,
    'tracking', jsonb_build_object(
      'enabled', coalesce(tracking_record.tracking_enabled, false),
      'base_url', tracking_record.tracking_base_url
    ),
    'readiness', jsonb_build_object(
      'has_live_default_funnel', exists (
        select 1 from public.funnels as funnel
        where funnel.product_id = p_product_id
          and funnel.is_default
          and funnel.status = 'live'
          and funnel.destination_url is not null
      ),
      'has_active_agreement', exists (
        select 1 from public.agreements as agreement
        where agreement.product_id = p_product_id and agreement.status = 'active'
      ),
      'has_active_billing_offer', public.product_has_launch_ready_billing_offer(p_product_id),
      'tracking_only_ready', tracking_only_ready_value,
      'tracking_only_can_issue_links',
        product_record.tracking_mode = 'tracking_only'
        and product_record.status = 'active'
        and tracking_only_ready_value
        and coalesce(tracking_record.tracking_enabled, false)
        and tracking_record.tracking_base_url = 'https://go.kissmyapps.dev',
      'commercial_ready',
        product_record.tracking_mode = 'commercial'
        and exists (
          select 1 from public.agreements as agreement
          where agreement.product_id = p_product_id
            and public.agreement_is_launch_ready(agreement.id, now())
        )
        and public.product_has_launch_ready_billing_offer(p_product_id),
      'tracking_ready',
        coalesce(tracking_record.tracking_enabled, false)
        and tracking_record.tracking_base_url = 'https://go.kissmyapps.dev'
        and (
          (
            product_record.tracking_mode = 'tracking_only'
            and tracking_only_ready_value
          )
          or (
            product_record.tracking_mode = 'commercial'
            and exists (
              select 1 from public.agreements as agreement
              where agreement.product_id = p_product_id
                and public.agreement_is_launch_ready(agreement.id, now())
            )
            and public.product_has_launch_ready_billing_offer(p_product_id)
          )
        )
    ),
    'funnels', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', funnel.id,
          'product_id', funnel.product_id,
          'key', funnel.key,
          'name', funnel.name,
          'destination_configured', funnel.destination_url is not null,
          'is_default', funnel.is_default,
          'status', funnel.status,
          'created_at', funnel.created_at,
          'updated_at', funnel.updated_at
        ) || case
          when viewer_can_manage_routing then
            jsonb_build_object('destination_url', funnel.destination_url)
          else '{}'::jsonb
        end
        order by funnel.is_default desc, funnel.name, funnel.id
      )
      from public.funnels as funnel
      where funnel.product_id = p_product_id
    ), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(to_jsonb(campaign) order by campaign.name, campaign.id)
      from public.campaigns as campaign
      where campaign.product_id = p_product_id
    ), '[]'::jsonb),
    'agreements', coalesce((
      select jsonb_agg(
        to_jsonb(agreement) || jsonb_build_object(
          'partner_name', affiliate.public_name,
          'partner_slug', affiliate.slug,
          'has_signed_document', exists (
            select 1 from public.documents as document
            where document.agreement_id = agreement.id
              and document.affiliate_id = agreement.affiliate_id
              and document.status in ('signed', 'active')
              and document.signed_by_partner_at is not null
              and document.signed_by_partner_at <= now()
              and document.signed_by_kissmyapps_at is not null
              and document.signed_by_kissmyapps_at <= now()
              and (document.effective_at is null or document.effective_at <= now())
              and (document.expires_at is null or document.expires_at > now())
              and document.terminated_at is null
          ),
          'launch_ready', public.agreement_is_launch_ready(agreement.id, now()),
          'rules', coalesce((
            select jsonb_agg(to_jsonb(rule) order by rule.version, rule.id)
            from public.commission_rules as rule
            where rule.agreement_id = agreement.id
          ), '[]'::jsonb)
        )
        order by affiliate.public_name, agreement.version desc, agreement.id
      )
      from public.agreements as agreement
      join public.affiliates as affiliate on affiliate.id = agreement.affiliate_id
      where agreement.product_id = p_product_id
    ), '[]'::jsonb),
    'billing_offers', coalesce((
      select jsonb_agg(
        (to_jsonb(offer)
          - 'verified_stripe_price_id'
          - 'verified_currency'
          - 'verified_unit_amount_minor'
          - 'verified_billing_mode')
        || jsonb_build_object(
          'stripe_price_verified',
            offer.stripe_livemode_verified_at is not null
            and offer.verified_stripe_price_id is not distinct from offer.stripe_price_id
            and offer.verified_currency is not distinct from offer.currency
            and offer.verified_unit_amount_minor is not distinct from offer.unit_amount_minor
            and offer.verified_billing_mode = offer.billing_mode
        )
        order by offer.key, offer.version desc, offer.id
      )
      from public.billing_offers as offer
      where offer.product_id = p_product_id
    ), '[]'::jsonb),
    'main_links', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', link.id,
          'affiliate_id', link.affiliate_id,
          'partner_name', affiliate.public_name,
          'funnel_id', link.funnel_id,
          'status', link.status,
          'tracking_url', link.tracking_url,
          'commercial_eligible', link.commercial_eligible,
          'created_at', link.created_at
        ) order by affiliate.public_name, link.created_at, link.id
      )
      from public.affiliate_links as link
      join public.affiliates as affiliate on affiliate.id = link.affiliate_id
      where link.product_id = p_product_id and link.is_main
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_admin_product_configuration(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_admin_product_configuration(uuid) to authenticated;

create or replace function public.platform_tracking_enablement_ready(p_base_url text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select
    coalesce(p_base_url = 'https://go.kissmyapps.dev', false)
    and exists (
      select 1
      from public.products as product
      where product.status = 'active'
        and (
          (
            product.tracking_mode = 'commercial'
            and exists (
              select 1
              from public.funnels as funnel
              where funnel.product_id = product.id
                and funnel.is_default
                and funnel.status = 'live'
                and public.is_production_https_url(funnel.destination_url, true)
            )
            and exists (
              select 1
              from public.agreements as agreement
              join public.affiliates as affiliate
                on affiliate.id = agreement.affiliate_id
               and affiliate.status = 'active'
              where agreement.product_id = product.id
                and public.agreement_is_launch_ready(agreement.id, statement_timestamp())
            )
            and public.product_has_launch_ready_billing_offer(product.id)
          )
          or (
            product.tracking_mode = 'tracking_only'
            and public.tracking_only_product_is_ready(product.id)
          )
        )
    )
    and not exists (
      select 1
      from public.affiliate_links as link
      where link.is_main
        and link.status <> 'archived'
        and link.tracking_url not like 'https://go.kissmyapps.dev/r/%'
    );
$$;

revoke all on function public.platform_tracking_enablement_ready(text)
  from public, anon, authenticated, service_role;

create or replace function public.get_admin_platform_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  generated_at_value timestamptz := statement_timestamp();
  setting_record public.platform_settings%rowtype;
  active_product_count_value bigint;
  live_default_funnel_count_value bigint;
  launch_ready_agreement_count_value bigint;
  verified_active_offer_count_value bigint;
  active_main_link_count_value bigint;
  commercial_ready_count_value bigint;
  tracking_only_ready_count_value bigint;
  fully_live_count_value bigint;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(
    array['owner', 'operations', 'finance', 'analyst']::text[]
  ) then
    raise exception 'admin role cannot view platform settings' using errcode = '42501';
  end if;

  select * into setting_record
  from public.platform_settings as setting
  where setting.singleton;

  select count(*)::bigint into active_product_count_value
  from public.products as product where product.status = 'active';

  select count(*)::bigint into live_default_funnel_count_value
  from public.funnels as funnel
  where funnel.is_default
    and funnel.status = 'live'
    and public.is_production_https_url(funnel.destination_url, true);

  select count(*)::bigint into launch_ready_agreement_count_value
  from public.agreements as agreement
  where public.agreement_is_launch_ready(agreement.id, generated_at_value);

  select count(*)::bigint into verified_active_offer_count_value
  from public.billing_offers as offer
  where offer.status = 'active'
    and offer.billing_mode = 'subscription'
    and offer.stripe_price_id is not null
    and offer.currency is not null
    and offer.unit_amount_minor is not null
    and offer.success_url_template is not null
    and offer.cancel_url is not null
    and position('{CHECKOUT_SESSION_ID}' in offer.success_url_template) > 0
    and public.is_production_https_url(offer.success_url_template, true)
    and public.is_production_https_url(offer.cancel_url, true)
    and offer.stripe_livemode_verified_at is not null
    and offer.verified_stripe_price_id is not distinct from offer.stripe_price_id
    and offer.verified_currency is not distinct from offer.currency
    and offer.verified_unit_amount_minor is not distinct from offer.unit_amount_minor
    and offer.verified_billing_mode = offer.billing_mode;

  select count(*)::bigint into active_main_link_count_value
  from public.affiliate_links as link
  where link.is_main and link.status = 'active';

  select count(*)::bigint into commercial_ready_count_value
  from public.products as product
  where product.status = 'active'
    and product.tracking_mode = 'commercial'
    and exists (
      select 1 from public.funnels as funnel
      where funnel.product_id = product.id
        and funnel.is_default
        and funnel.status = 'live'
        and public.is_production_https_url(funnel.destination_url, true)
    )
    and exists (
      select 1
      from public.agreements as agreement
      join public.affiliates as affiliate
        on affiliate.id = agreement.affiliate_id and affiliate.status = 'active'
      where agreement.product_id = product.id
        and public.agreement_is_launch_ready(agreement.id, generated_at_value)
    )
    and public.product_has_launch_ready_billing_offer(product.id);

  select count(*)::bigint into tracking_only_ready_count_value
  from public.products as product
  where product.status = 'active'
    and product.tracking_mode = 'tracking_only'
    and public.tracking_only_product_is_ready(product.id);

  select count(distinct product.id)::bigint into fully_live_count_value
  from public.products as product
  join public.affiliate_links as link
    on link.product_id = product.id
   and link.is_main
   and link.status = 'active'
   and link.tracking_url like 'https://go.kissmyapps.dev/r/%'
  join public.affiliates as affiliate
    on affiliate.id = link.affiliate_id and affiliate.status = 'active'
  where product.status = 'active'
    and coalesce(setting_record.tracking_enabled, false)
    and setting_record.tracking_base_url = 'https://go.kissmyapps.dev'
    and (
      (
        product.tracking_mode = 'commercial'
        and link.commercial_eligible
        and public.product_has_launch_ready_billing_offer(product.id)
        and exists (
          select 1 from public.agreements as agreement
          where agreement.affiliate_id = link.affiliate_id
            and agreement.product_id = product.id
            and public.agreement_is_launch_ready(agreement.id, generated_at_value)
        )
      )
      or (
        product.tracking_mode = 'tracking_only'
        and not link.commercial_eligible
        and public.tracking_only_product_is_ready(product.id)
        and link.funnel_id = product.tracking_only_funnel_id
      )
    );

  return jsonb_build_object(
    'base_url', setting_record.tracking_base_url,
    'enabled', coalesce(setting_record.tracking_enabled, false),
    'updated_at', setting_record.updated_at,
    'tracking', jsonb_build_object(
      'base_url', setting_record.tracking_base_url,
      'enabled', coalesce(setting_record.tracking_enabled, false),
      'updated_at', setting_record.updated_at
    ),
    'readiness', jsonb_build_object(
      'can_enable', public.platform_tracking_enablement_ready(setting_record.tracking_base_url),
      'active_product_count', active_product_count_value,
      'live_default_funnel_count', live_default_funnel_count_value,
      'launch_ready_agreement_count', launch_ready_agreement_count_value,
      'verified_active_offer_count', verified_active_offer_count_value,
      'active_main_link_count', active_main_link_count_value,
      'commercial_enable_ready_product_count', commercial_ready_count_value,
      'tracking_only_ready_product_count', tracking_only_ready_count_value,
      'enable_ready_product_count',
        commercial_ready_count_value + tracking_only_ready_count_value,
      'fully_live_product_count', fully_live_count_value
    ),
    'expected_hosts', jsonb_build_object(
      'partner', 'https://partners.kissmyapps.dev',
      'admin', 'https://admin.kissmyapps.dev',
      'tracking', 'https://go.kissmyapps.dev'
    )
  );
end;
$$;

revoke all on function public.get_admin_platform_settings()
  from public, anon, authenticated, service_role;
grant execute on function public.get_admin_platform_settings() to authenticated;

comment on function public.platform_tracking_enablement_ready(text) is
  'Fail-closed readiness for either the unchanged commercial chain or an explicitly Owner-approved tracking-only product and exact public HTTPS funnel snapshot.';
comment on function public.configure_admin_tracking(jsonb) is
  'Owner-only canonical tracking kill switch. Enablement requires either one unchanged complete commercial chain or one explicitly approved tracking-only product; disabling remains immediate.';

-- Preserve the existing commercial reporting implementation byte-for-byte and
-- route only tracking-only products through bounded canonical click/event
-- aggregates. This makes demo traffic visible immediately without a scheduler.
alter function public.get_partner_dashboard_summary(
  uuid, date, date, text, uuid, uuid, uuid, text, text
) rename to get_partner_dashboard_summary_commercial;

alter function public.get_partner_dashboard_trends(
  uuid, date, date, text, uuid, uuid, uuid, text, text, text, text
) rename to get_partner_dashboard_trends_commercial;

revoke all on function public.get_partner_dashboard_summary_commercial(
  uuid, date, date, text, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.get_partner_dashboard_trends_commercial(
  uuid, date, date, text, uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated, service_role;

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
  product_mode public.product_tracking_mode;
begin
  partner_id := public.current_partner_affiliate_id(false);
  select affiliate.reporting_timezone into partner_timezone
  from public.affiliates as affiliate where affiliate.id = partner_id;
  select product.tracking_mode into product_mode
  from public.products as product where product.id = p_product_id;

  if product_mode = 'commercial' then
    return query
    select * from public.get_partner_dashboard_summary_commercial(
      p_product_id, p_starts_on, p_ends_on, p_timezone, p_source_id,
      p_campaign_id, p_funnel_id, p_country_code, p_sub_id
    );
    return;
  end if;

  if p_product_id is null
     or product_mode <> 'tracking_only'
     or not public.current_user_can_view_product(p_product_id) then
    raise exception 'an authorized product is required' using errcode = '42501';
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on
     or p_ends_on - p_starts_on > 366 then
    raise exception 'reporting period must contain between 1 and 367 days'
      using errcode = '22023';
  end if;
  if p_timezone is null or p_timezone <> partner_timezone then
    raise exception 'reporting timezone must match the partner profile'
      using errcode = '22023';
  end if;
  if p_country_code is not null and p_country_code !~ '^[A-Z]{2}$' then
    raise exception 'country code must be ISO alpha-2 uppercase' using errcode = '22023';
  end if;
  if p_sub_id is not null and char_length(p_sub_id) > 64 then
    raise exception 'sub ID filter is too long' using errcode = '22023';
  end if;

  return query
  with dimension_clicks as materialized (
    select click.*
    from public.clicks as click
    where click.affiliate_id = partner_id
      and click.product_id = p_product_id
      and not click.commercial_eligible
      and not click.is_bot
      and (p_source_id is null or click.source_id = p_source_id)
      and (p_campaign_id is null or click.campaign_id = p_campaign_id)
      and (p_funnel_id is null or click.funnel_id = p_funnel_id)
      and (p_country_code is null or click.country_code = p_country_code)
      and (
        p_sub_id is null
        or click.sub1 ilike '%' || p_sub_id || '%'
        or click.sub2 ilike '%' || p_sub_id || '%'
        or click.sub3 ilike '%' || p_sub_id || '%'
      )
  ), filtered_clicks as materialized (
    select click.*
    from dimension_clicks as click
    where (click.occurred_at at time zone p_timezone)::date
      between p_starts_on and p_ends_on
  ), filtered_events as materialized (
    select event.*
    from public.events as event
    join public.acquisitions as acquisition on acquisition.id = event.acquisition_id
    join dimension_clicks as click on click.id = acquisition.click_record_id
    where not event.commercial_eligible
      and (event.occurred_at at time zone p_timezone)::date
        between p_starts_on and p_ends_on
  ), aggregate_row as (
    select
      (select count(*)::bigint from filtered_clicks) as clicks,
      (select count(distinct coalesce(click.session_id_hash, click.id::text))::bigint
        from filtered_clicks as click) as visitors,
      (select count(*)::bigint from filtered_events as event
        where event.event_name = 'funnel_started') as funnel_starts,
      (select count(*)::bigint from filtered_events as event
        where event.event_name = 'payment_viewed') as payment_views,
      (select count(*)::bigint from filtered_events as event
        where event.event_name = 'app_store_clicked') as app_store_clicks
  )
  select
    p_starts_on,
    p_ends_on,
    p_timezone,
    null::text,
    aggregate_row.clicks > 0
      or aggregate_row.funnel_starts > 0
      or aggregate_row.payment_views > 0
      or aggregate_row.app_store_clicks > 0,
    case when aggregate_row.clicks > 0
      or aggregate_row.funnel_starts > 0
      or aggregate_row.payment_views > 0
      or aggregate_row.app_store_clicks > 0
      then 'preliminary'::public.reconciliation_stage else null end,
    null::date,
    case when aggregate_row.clicks > 0
        or aggregate_row.funnel_starts > 0
        or aggregate_row.payment_views > 0
        or aggregate_row.app_store_clicks > 0
      then aggregate_row.clicks else null end,
    case when aggregate_row.clicks > 0
        or aggregate_row.funnel_starts > 0
        or aggregate_row.payment_views > 0
        or aggregate_row.app_store_clicks > 0
      then aggregate_row.visitors else null end,
    case when aggregate_row.clicks > 0
        or aggregate_row.funnel_starts > 0
        or aggregate_row.payment_views > 0
        or aggregate_row.app_store_clicks > 0
      then aggregate_row.funnel_starts else null end,
    case when aggregate_row.clicks > 0
        or aggregate_row.funnel_starts > 0
        or aggregate_row.payment_views > 0
        or aggregate_row.app_store_clicks > 0
      then aggregate_row.payment_views else null end,
    case when aggregate_row.clicks > 0
        or aggregate_row.funnel_starts > 0
        or aggregate_row.payment_views > 0
        or aggregate_row.app_store_clicks > 0
      then aggregate_row.app_store_clicks else null end,
    null::bigint, null::bigint, null::bigint, null::bigint, null::bigint,
    null::bigint, null::bigint, null::bigint, null::bigint,
    null::bigint, null::bigint, null::bigint, null::bigint
  from aggregate_row;
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
  product_mode public.product_tracking_mode;
begin
  partner_id := public.current_partner_affiliate_id(false);
  select affiliate.reporting_timezone into partner_timezone
  from public.affiliates as affiliate where affiliate.id = partner_id;
  select product.tracking_mode into product_mode
  from public.products as product where product.id = p_product_id;

  if product_mode = 'commercial' then
    return query
    select * from public.get_partner_dashboard_trends_commercial(
      p_product_id, p_starts_on, p_ends_on, p_timezone, p_source_id,
      p_campaign_id, p_funnel_id, p_country_code, p_sub_id, p_grain, p_breakdown
    );
    return;
  end if;

  if p_product_id is null
     or product_mode <> 'tracking_only'
     or not public.current_user_can_view_product(p_product_id) then
    raise exception 'an authorized product is required' using errcode = '42501';
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on
     or p_ends_on - p_starts_on > 366 then
    raise exception 'reporting period must contain between 1 and 367 days'
      using errcode = '22023';
  end if;
  if p_timezone is null or p_timezone <> partner_timezone then
    raise exception 'reporting timezone must match the partner profile'
      using errcode = '22023';
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
  with dimension_clicks as materialized (
    select
      click.*,
      source.key as source_key,
      source.name as source_name,
      campaign.key as campaign_key,
      campaign.name as campaign_name,
      funnel.key as funnel_key,
      funnel.name as funnel_name
    from public.clicks as click
    left join public.sources as source on source.id = click.source_id
    left join public.campaigns as campaign on campaign.id = click.campaign_id
    left join public.funnels as funnel on funnel.id = click.funnel_id
    where click.affiliate_id = partner_id
      and click.product_id = p_product_id
      and not click.commercial_eligible
      and not click.is_bot
      and (p_source_id is null or click.source_id = p_source_id)
      and (p_campaign_id is null or click.campaign_id = p_campaign_id)
      and (p_funnel_id is null or click.funnel_id = p_funnel_id)
      and (p_country_code is null or click.country_code = p_country_code)
      and (
        p_sub_id is null
        or click.sub1 ilike '%' || p_sub_id || '%'
        or click.sub2 ilike '%' || p_sub_id || '%'
        or click.sub3 ilike '%' || p_sub_id || '%'
      )
  ), scoped_clicks as materialized (
    select click.*
    from dimension_clicks as click
    where (click.occurred_at at time zone p_timezone)::date
      between p_starts_on and p_ends_on
  ), fact_rows as (
    select
      (click.occurred_at at time zone p_timezone)::date as fact_date,
      click.source_key, click.source_name, click.country_code,
      click.campaign_key, click.campaign_name, click.funnel_key, click.funnel_name,
      click.sub1,
      1::bigint as click_count,
      coalesce(click.session_id_hash, click.id::text) as visitor_key,
      0::bigint as funnel_start_count,
      0::bigint as payment_view_count,
      0::bigint as app_store_click_count
    from scoped_clicks as click
    union all
    select
      (event.occurred_at at time zone p_timezone)::date,
      click.source_key, click.source_name, click.country_code,
      click.campaign_key, click.campaign_name, click.funnel_key, click.funnel_name,
      click.sub1,
      0::bigint, null::text,
      case when event.event_name = 'funnel_started' then 1 else 0 end,
      case when event.event_name = 'payment_viewed' then 1 else 0 end,
      case when event.event_name = 'app_store_clicked' then 1 else 0 end
    from public.events as event
    join public.acquisitions as acquisition on acquisition.id = event.acquisition_id
    join dimension_clicks as click on click.id = acquisition.click_record_id
    where not event.commercial_eligible
      and (event.occurred_at at time zone p_timezone)::date
        between p_starts_on and p_ends_on
      and event.event_name in ('funnel_started', 'payment_viewed', 'app_store_clicked')
  ), labelled as (
    select
      date_trunc(p_grain, fact.fact_date::timestamp)::date as grouped_date,
      case p_breakdown
        when 'date' then date_trunc(p_grain, fact.fact_date::timestamp)::date::text
        when 'source' then coalesce(fact.source_key, 'untagged')
        when 'country' then coalesce(fact.country_code, 'unknown')
        when 'campaign' then coalesce(fact.campaign_key, 'untagged')
        when 'funnel' then coalesce(fact.funnel_key, 'unknown')
        when 'subId' then coalesce(fact.sub1, 'untagged')
      end as grouped_key,
      case p_breakdown
        when 'date' then date_trunc(p_grain, fact.fact_date::timestamp)::date::text
        when 'source' then coalesce(fact.source_name, 'Direct / untagged')
        when 'country' then coalesce(fact.country_code, 'Unknown')
        when 'campaign' then coalesce(fact.campaign_name, 'Untagged')
        when 'funnel' then coalesce(fact.funnel_name, 'Unknown')
        when 'subId' then coalesce(fact.sub1, 'Untagged')
      end as grouped_label,
      fact.*
    from fact_rows as fact
  )
  select
    labelled.grouped_date,
    case p_grain
      when 'day' then labelled.grouped_date
      when 'week' then labelled.grouped_date + 6
      when 'month' then (labelled.grouped_date + interval '1 month - 1 day')::date
    end,
    labelled.grouped_key,
    labelled.grouped_label,
    'preliminary'::public.reconciliation_stage,
    sum(labelled.click_count)::bigint,
    count(distinct labelled.visitor_key)::bigint,
    sum(labelled.funnel_start_count)::bigint,
    sum(labelled.payment_view_count)::bigint,
    sum(labelled.app_store_click_count)::bigint,
    null::bigint, null::bigint, null::bigint, null::bigint, null::bigint,
    null::bigint, null::bigint, null::bigint, null::bigint,
    null::bigint, null::bigint, null::bigint, null::bigint
  from labelled
  group by labelled.grouped_date, labelled.grouped_key, labelled.grouped_label
  order by labelled.grouped_date, labelled.grouped_label;
end;
$$;

revoke all on function public.get_partner_dashboard_summary(
  uuid, date, date, text, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.get_partner_dashboard_trends(
  uuid, date, date, text, uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.get_partner_dashboard_summary(
  uuid, date, date, text, uuid, uuid, uuid, text, text
) to authenticated;
grant execute on function public.get_partner_dashboard_trends(
  uuid, date, date, text, uuid, uuid, uuid, text, text, text, text
) to authenticated;

-- Tracking-only dashboards aggregate canonical traffic directly, so demo
-- clicks/events must not enqueue the commercial metrics worker at all.
create or replace function public.queue_commercial_metric(
  p_affiliate_id uuid,
  p_product_id uuid,
  p_occurred_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  timezone_value text;
  date_value date;
begin
  if p_affiliate_id is null or p_product_id is null or p_occurred_at is null then
    return;
  end if;
  if exists (
    select 1 from public.products as product
    where product.id = p_product_id and product.tracking_mode = 'tracking_only'
  ) then
    return;
  end if;

  select affiliate.reporting_timezone into timezone_value
  from public.affiliates as affiliate where affiliate.id = p_affiliate_id;
  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = timezone_value
  ) then
    timezone_value := 'UTC';
  end if;
  date_value := (p_occurred_at at time zone timezone_value)::date;

  insert into public.commercial_metric_refresh_queue (
    affiliate_id, product_id, metric_date
  ) values (
    p_affiliate_id, p_product_id, date_value
  )
  on conflict (affiliate_id, product_id, metric_date) do update set
    status = case
      when commercial_metric_refresh_queue.status = 'processing'
        then commercial_metric_refresh_queue.status
      else 'pending'::public.processing_status
    end,
    processed_at = case
      when commercial_metric_refresh_queue.status = 'processing'
        then commercial_metric_refresh_queue.processed_at
      else null
    end,
    processing_error = null,
    next_attempt_at = now(),
    updated_at = now();
end;
$$;

revoke all on function public.queue_commercial_metric(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

drop function public.get_admin_products();
create function public.get_admin_products()
returns table (
  id uuid,
  slug text,
  name text,
  status public.product_status,
  created_at timestamptz,
  updated_at timestamptz,
  tracking_mode public.product_tracking_mode,
  tracking_only_approved_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(
    array['owner', 'operations', 'finance', 'analyst']::text[]
  ) then
    raise exception 'admin role cannot view products' using errcode = '42501';
  end if;

  return query
  select
    product.id,
    product.slug,
    product.name,
    product.status,
    product.created_at,
    product.updated_at,
    product.tracking_mode,
    product.tracking_only_approved_at
  from public.products as product
  order by product.name, product.id;
end;
$$;

drop function public.create_admin_product(jsonb);
create function public.create_admin_product(p_input jsonb)
returns table (
  id uuid,
  slug text,
  name text,
  status public.product_status,
  created_at timestamptz,
  updated_at timestamptz,
  tracking_mode public.product_tracking_mode,
  tracking_only_approved_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['name', 'slug'];
  name_value text;
  slug_value text;
  inserted_product public.products%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(array['owner', 'operations']::text[]) then
    raise exception 'admin role cannot create products' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(
      case
        when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr'
        else '[]'::jsonb
      end
    ) as authentication_method(entry)
    where authentication_method.entry ->> 'method' = 'password'
  ) then
    raise exception 'product creation requires a password-authenticated session'
      using errcode = '42501';
  end if;

  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'product input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) as input_key
    where input_key <> all(allowed_keys)
  ) then
    raise exception 'product input contains unsupported fields' using errcode = '22023';
  end if;
  if not (p_input ?& allowed_keys) then
    raise exception 'product name and slug are required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'name') <> 'string'
     or jsonb_typeof(p_input -> 'slug') <> 'string' then
    raise exception 'product name and slug must be strings' using errcode = '22023';
  end if;

  name_value := trim(p_input ->> 'name');
  slug_value := trim(p_input ->> 'slug');
  if char_length(name_value) not between 1 and 120 then
    raise exception 'product name must contain between 1 and 120 characters'
      using errcode = '22023';
  end if;
  if char_length(slug_value) not between 1 and 120
     or slug_value !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'product slug must use 1 to 120 lowercase letters, numbers, or single hyphens'
      using errcode = '22023';
  end if;

  insert into public.products (name, slug, status, tracking_mode)
  values (name_value, slug_value, 'draft', 'commercial')
  returning * into inserted_product;

  return query select
    inserted_product.id,
    inserted_product.slug,
    inserted_product.name,
    inserted_product.status,
    inserted_product.created_at,
    inserted_product.updated_at,
    inserted_product.tracking_mode,
    inserted_product.tracking_only_approved_at;
end;
$$;

revoke all on function public.get_admin_products()
  from public, anon, authenticated, service_role;
revoke all on function public.create_admin_product(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.get_admin_products() to authenticated;
grant execute on function public.create_admin_product(jsonb) to authenticated;

comment on function public.get_admin_products() is
  'Returns the admin product catalogue with explicit tracking mode and tracking-only approval time.';
comment on function public.create_admin_product(jsonb) is
  'Creates a draft commercial product and returns the explicit tracking-mode contract used by the admin catalogue.';










revoke all on function public.set_products_updated_at()
  from public, anon, authenticated, service_role;

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_products_updated_at();

create or replace function public.tracking_only_product_is_ready(p_product_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select
      product.tracking_mode = 'tracking_only'
      and product.tracking_only_funnel_id = funnel.id
      and product.tracking_only_destination_url_snapshot = funnel.destination_url
      and product.tracking_only_approved_by is not null
      and product.tracking_only_approved_at is not null
      and funnel.product_id = product.id
      and funnel.is_default
      and funnel.status = 'live'
      and public.is_production_https_url(funnel.destination_url, true)
    from public.products as product
    join public.funnels as funnel on funnel.id = product.tracking_only_funnel_id
    where product.id = p_product_id
  ), false);
$$;

create or replace function public.product_has_commercial_history(p_product_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select
    exists (select 1 from public.agreements as row where row.product_id = p_product_id)
    or exists (select 1 from public.billing_offers as row where row.product_id = p_product_id)
    or exists (select 1 from public.checkout_attempts as row where row.product_id = p_product_id)
    or exists (select 1 from public.subscriptions as row where row.product_id = p_product_id)
    or exists (select 1 from public.entitlements as row where row.product_id = p_product_id)
    or exists (select 1 from public.conversions as row where row.product_id = p_product_id)
    or exists (select 1 from public.commission_entries as row where row.product_id = p_product_id)
    or exists (select 1 from public.payouts as row where row.product_id = p_product_id)
    or exists (select 1 from public.affiliate_links as row where row.product_id = p_product_id)
    or exists (select 1 from public.clicks as row where row.product_id = p_product_id)
    or exists (select 1 from public.acquisitions as row where row.product_id = p_product_id)
    or exists (
      select 1 from public.events as row
      where row.product_id = p_product_id and row.commercial_eligible
    )
    or exists (
      select 1 from public.affiliate_daily_metrics as row
      where row.product_id = p_product_id
        and (
          row.leads <> 0 or row.trials <> 0 or row.purchases <> 0
          or row.renewals <> 0 or row.cancellations <> 0 or row.activations <> 0
          or row.refunds <> 0 or row.disputes <> 0
          or row.gross_collected_minor <> 0 or row.eligible_revenue_minor <> 0
          or row.earnings_minor <> 0 or row.active_subscriptions <> 0
          or row.is_subscription_snapshot
        )
    )
    or exists (
      select 1 from public.commercial_transaction_states as row
      where row.product_id = p_product_id
    )
    or exists (
      select 1 from public.commercial_source_applications as row
      where row.product_id = p_product_id
    );
$$;

create or replace function public.product_has_tracking_only_traffic(p_product_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select
    exists (
      select 1 from public.clicks as click
      where click.product_id = p_product_id and not click.commercial_eligible
    )
    or exists (
      select 1 from public.acquisitions as acquisition
      where acquisition.product_id = p_product_id and not acquisition.commercial_eligible
    )
    or exists (
      select 1
      from public.events as event
      join public.acquisitions as acquisition on acquisition.id = event.acquisition_id
      where event.product_id = p_product_id and not acquisition.commercial_eligible
    )
    or exists (
      select 1 from public.affiliate_daily_metrics as metric
      where metric.product_id = p_product_id
    );
$$;

revoke all on function public.tracking_only_product_is_ready(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.product_has_commercial_history(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.product_has_tracking_only_traffic(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.set_admin_product_tracking_mode(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['product_id', 'mode', 'expected_updated_at'];
  product_id_value uuid;
  mode_value public.product_tracking_mode;
  expected_updated_at_value timestamptz;
  existing public.products%rowtype;
  approved_funnel public.funnels%rowtype;
  stored public.products%rowtype;
begin
  perform public.assert_admin_password(array['owner']::text[], 'configure product tracking mode');

  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& allowed_keys)
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     ) then
    raise exception 'tracking-mode input must contain exactly product_id, mode, and expected_updated_at'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'product_id') <> 'string'
     or jsonb_typeof(p_input -> 'mode') <> 'string'
     or jsonb_typeof(p_input -> 'expected_updated_at') <> 'string' then
    raise exception 'tracking-mode input types are invalid' using errcode = '22023';
  end if;

  begin
    product_id_value := nullif(trim(p_input ->> 'product_id'), '')::uuid;
    mode_value := (trim(p_input ->> 'mode'))::public.product_tracking_mode;
    expected_updated_at_value := (p_input ->> 'expected_updated_at')::timestamptz;
  exception
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
      raise exception 'tracking-mode input values are invalid' using errcode = '22023';
  end;

  select * into existing
  from public.products as product
  where product.id = product_id_value
  for update;

  if existing.id is null then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if existing.updated_at is distinct from expected_updated_at_value then
    raise exception 'product changed; reload before saving' using errcode = '40001';
  end if;
  if existing.status = 'archived' then
    raise exception 'an archived product cannot change tracking mode' using errcode = 'P0001';
  end if;
  if existing.tracking_mode = mode_value and mode_value = 'commercial' then
    return to_jsonb(existing);
  end if;

  if mode_value = 'tracking_only' then
    if existing.tracking_mode = 'commercial'
       and public.product_has_commercial_history(existing.id) then
      raise exception 'tracking-only mode requires a product with no commercial or issued-link history'
        using errcode = 'P0001';
    end if;

    select * into approved_funnel
    from public.funnels as funnel
    where funnel.product_id = existing.id
      and funnel.is_default
      and funnel.status = 'live'
      and funnel.destination_url is not null
      and public.is_production_https_url(funnel.destination_url, true)
    for share;

    if approved_funnel.id is null then
      raise exception 'tracking-only mode requires one live default public HTTPS funnel'
        using errcode = 'P0001';
    end if;

    if existing.tracking_mode = 'tracking_only'
       and existing.tracking_only_funnel_id is distinct from approved_funnel.id then
      update public.affiliate_links as link
      set status = 'archived', archived_at = statement_timestamp()
      where link.product_id = existing.id
        and not link.commercial_eligible
        and link.status <> 'archived';
    end if;

    update public.products as product
    set tracking_mode = 'tracking_only',
        tracking_only_funnel_id = approved_funnel.id,
        tracking_only_destination_url_snapshot = approved_funnel.destination_url,
        tracking_only_approved_by = auth.uid(),
        tracking_only_approved_at = statement_timestamp()
    where product.id = existing.id
    returning * into stored;
  else
    if public.product_has_tracking_only_traffic(existing.id) then
      raise exception 'a product with tracking-only traffic cannot become commercial; create a new commercial product'
        using errcode = 'P0001';
    end if;

    -- Demo links are permanently noncommercial. Archiving them on graduation
    -- prevents the old route from being mistaken for a commercial main link.
    update public.affiliate_links as link
    set status = 'archived', archived_at = statement_timestamp()
    where link.product_id = existing.id
      and not link.commercial_eligible
      and link.status <> 'archived';

    update public.products as product
    set tracking_mode = 'commercial',
        tracking_only_funnel_id = null,
        tracking_only_destination_url_snapshot = null,
        tracking_only_approved_by = null,
        tracking_only_approved_at = null
    where product.id = existing.id
    returning * into stored;
  end if;

  return to_jsonb(stored);
end;
$$;

revoke all on function public.set_admin_product_tracking_mode(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_admin_product_tracking_mode(jsonb)
  to authenticated;

comment on function public.set_admin_product_tracking_mode(jsonb) is
  'Owner-only password-authenticated CAS mutation. Tracking-only approval snapshots one live default public HTTPS funnel and is rejected after any commercial or issued-link history.';

-- Direct product-scoped commercial tables all share the same fail-closed
-- boundary. Noncommercial traffic tables use specialized validators below.
create or replace function public.guard_tracking_only_commercial_product_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  product_id_value uuid;
begin
  product_id_value := nullif(to_jsonb(new) ->> 'product_id', '')::uuid;
  if exists (
    select 1 from public.products as product
    where product.id = product_id_value and product.tracking_mode = 'tracking_only'
  ) then
    raise exception 'tracking-only products cannot create commercial records'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_tracking_only_commercial_product_write()
  from public, anon, authenticated, service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'agreements', 'billing_offers', 'checkout_attempts', 'subscriptions',
    'entitlements', 'conversions', 'commission_entries', 'payouts',
    'commercial_transaction_states', 'commercial_source_applications'
  ] loop
    execute format(
      'drop trigger if exists %I on public.%I',
      table_name || '_tracking_only_commercial_guard', table_name
    );
    execute format(
      'create trigger %I before insert or update on public.%I '
      || 'for each row execute function public.guard_tracking_only_commercial_product_write()',
      table_name || '_tracking_only_commercial_guard', table_name
    );
  end loop;
end;
$$;

create or replace function public.guard_tracking_only_commission_rule_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.agreements as agreement
    join public.products as product on product.id = agreement.product_id
    where agreement.id = new.agreement_id
      and product.tracking_mode = 'tracking_only'
  ) then
    raise exception 'tracking-only products cannot create commission rules'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger commission_rules_tracking_only_commercial_guard
  before insert or update on public.commission_rules
  for each row execute function public.guard_tracking_only_commission_rule_write();

create or replace function public.guard_tracking_only_transaction_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.subscriptions as subscription
    join public.products as product on product.id = subscription.product_id
    left join public.acquisitions as acquisition on acquisition.id = new.acquisition_id
    where subscription.id = new.subscription_id
      and (
        product.tracking_mode = 'tracking_only'
        or coalesce(acquisition.commercial_eligible, false) = false
      )
  ) then
    raise exception 'noncommercial tracking cannot create transactions'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger transactions_tracking_only_commercial_guard
  before insert or update on public.transactions
  for each row execute function public.guard_tracking_only_transaction_write();

create or replace function public.guard_tracking_only_adjustment_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.transactions as transaction
    join public.subscriptions as subscription on subscription.id = transaction.subscription_id
    join public.products as product on product.id = subscription.product_id
    left join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
    where transaction.id = new.transaction_id
      and (
        product.tracking_mode = 'tracking_only'
        or coalesce(acquisition.commercial_eligible, false) = false
      )
  ) then
    raise exception 'noncommercial tracking cannot create refunds or disputes'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger refunds_tracking_only_commercial_guard
  before insert or update on public.refunds
  for each row execute function public.guard_tracking_only_adjustment_write();
create trigger disputes_tracking_only_commercial_guard
  before insert or update on public.disputes
  for each row execute function public.guard_tracking_only_adjustment_write();

create or replace function public.guard_tracking_only_checkout_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.products as product
    join public.acquisitions as acquisition on acquisition.id = new.acquisition_id
    join public.clicks as click on click.id = new.click_record_id
    join public.affiliate_links as link on link.id = click.affiliate_link_id
    where product.id = new.product_id
      and (
        product.tracking_mode = 'tracking_only'
        or not acquisition.commercial_eligible
        or not click.commercial_eligible
        or not link.commercial_eligible
      )
  ) then
    raise exception 'checkout is unavailable for noncommercial tracking'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger checkout_attempts_00_tracking_scope_guard
  before insert or update on public.checkout_attempts
  for each row execute function public.guard_tracking_only_checkout_scope();

create or replace function public.guard_tracking_only_subscription_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.products as product
    left join public.acquisitions as acquisition on acquisition.id = new.acquisition_id
    where product.id = new.product_id
      and (
        product.tracking_mode = 'tracking_only'
        or (new.acquisition_id is not null and not coalesce(acquisition.commercial_eligible, false))
      )
  ) then
    raise exception 'subscriptions are unavailable for noncommercial tracking'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger subscriptions_00_tracking_scope_guard
  before insert or update on public.subscriptions
  for each row execute function public.guard_tracking_only_subscription_scope();

create or replace function public.guard_tracking_only_conversion_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.products as product
    left join public.acquisitions as acquisition on acquisition.id = new.acquisition_id
    left join public.events as event on event.id = new.event_id
    where product.id = new.product_id
      and (
        product.tracking_mode = 'tracking_only'
        or not coalesce(acquisition.commercial_eligible, false)
        or not coalesce(event.commercial_eligible, false)
      )
  ) then
    raise exception 'conversions require commercially eligible attribution and events'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger conversions_00_tracking_scope_guard
  before insert or update on public.conversions
  for each row execute function public.guard_tracking_only_conversion_scope();

create or replace function public.guard_tracking_only_daily_metric()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
       select 1 from public.products as product
       where product.id = new.product_id and product.tracking_mode = 'tracking_only'
     ) and (
       new.leads <> 0 or new.trials <> 0 or new.purchases <> 0
       or new.renewals <> 0 or new.cancellations <> 0 or new.activations <> 0
       or new.refunds <> 0 or new.disputes <> 0
       or new.gross_collected_minor <> 0 or new.eligible_revenue_minor <> 0
       or new.earnings_minor <> 0 or new.active_subscriptions <> 0
       or new.is_subscription_snapshot
     ) then
    raise exception 'tracking-only metrics must remain traffic-only and noncommercial'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger affiliate_daily_metrics_00_tracking_only_guard
  before insert or update on public.affiliate_daily_metrics
  for each row execute function public.guard_tracking_only_daily_metric();

do $$
declare function_signature text;
begin
  foreach function_signature in array array[
    'public.guard_tracking_only_commission_rule_write()',
    'public.guard_tracking_only_transaction_write()',
    'public.guard_tracking_only_adjustment_write()',
    'public.guard_tracking_only_checkout_scope()',
    'public.guard_tracking_only_subscription_scope()',
    'public.guard_tracking_only_conversion_scope()',
    'public.guard_tracking_only_daily_metric()'
  ] loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      function_signature
    );
  end loop;
end;
$$;

commit;
