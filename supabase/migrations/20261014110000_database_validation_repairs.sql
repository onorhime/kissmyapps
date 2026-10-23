-- Restore input validation lost during commercial RPC replacements.
-- Invalid identities/models/currencies fail with controlled invalid-parameter errors
-- before business lookups or casts. Authorization, audit/history behavior, the
-- enriched agreement response, tracking-only eligibility and link idempotency stay intact.

create or replace function public.create_admin_agreement(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'affiliate_id', 'product_id', 'model', 'attribution_window_days',
    'renewal_duration_days', 'payout_frequency_days', 'payout_currency',
    'minimum_payout_minor'
  ];
  affiliate_id_value uuid;
  product_id_value uuid;
  next_version integer;
  stored public.agreements%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'create agreements');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'agreement input is invalid' using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_object_keys(p_input) as input_key(key_name)
       where input_key.key_name <> all(allowed_keys)
     ) then
    raise exception 'agreement input is invalid' using errcode = '22023';
  end if;
  if not (p_input ? 'affiliate_id') or not (p_input ? 'product_id')
     or not (p_input ? 'model') or not (p_input ? 'payout_currency') then
    raise exception 'affiliate_id, product_id, model, and payout_currency are required'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'affiliate_id') <> 'string'
     or jsonb_typeof(p_input -> 'product_id') <> 'string'
     or jsonb_typeof(p_input -> 'model') <> 'string'
     or jsonb_typeof(p_input -> 'payout_currency') <> 'string' then
    raise exception 'agreement input types are invalid' using errcode = '22023';
  end if;
  if (p_input ? 'attribution_window_days'
      and jsonb_typeof(p_input -> 'attribution_window_days') not in ('number', 'null'))
     or (p_input ? 'renewal_duration_days'
         and jsonb_typeof(p_input -> 'renewal_duration_days') not in ('number', 'null'))
     or (p_input ? 'payout_frequency_days'
         and jsonb_typeof(p_input -> 'payout_frequency_days') not in ('number', 'null'))
     or (p_input ? 'minimum_payout_minor'
         and jsonb_typeof(p_input -> 'minimum_payout_minor') not in ('number', 'null')) then
    raise exception 'agreement input types are invalid' using errcode = '22023';
  end if;

  begin
    affiliate_id_value := nullif(trim(p_input ->> 'affiliate_id'), '')::uuid;
    product_id_value := nullif(trim(p_input ->> 'product_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'agreement identifiers must be UUIDs' using errcode = '22023';
  end;

  -- Reject malformed business input before looking up records or casting enum values.
  -- These checks were present before the enriched-response implementation.
  if affiliate_id_value is null or product_id_value is null then
    raise exception 'affiliate_id and product_id are required' using errcode = '22023';
  end if;
  if (p_input ->> 'model') not in ('cpl', 'cpa', 'revenue_share', 'hybrid')
     or upper(trim(p_input ->> 'payout_currency')) !~ '^[A-Z]{3}$' then
    raise exception 'agreement model or payout currency is invalid' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.affiliates as affiliate
    where affiliate.id = affiliate_id_value
      and affiliate.status in ('active', 'paused')
  ) then raise exception 'partner is not available for an agreement' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.products as product where product.id = product_id_value) then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'agreement-version:' || affiliate_id_value::text || ':' || product_id_value::text,
      0
    )
  );
  select coalesce(max(agreement.version), 0) + 1 into next_version
  from public.agreements as agreement
  where agreement.affiliate_id = affiliate_id_value and agreement.product_id = product_id_value;

  insert into public.agreements (
    affiliate_id, product_id, version, model, status, attribution_window_days,
    renewal_duration_days, payout_frequency_days, payout_currency, minimum_payout_minor
  ) values (
    affiliate_id_value,
    product_id_value,
    next_version,
    (p_input ->> 'model')::public.commission_model,
    'draft',
    coalesce((p_input ->> 'attribution_window_days')::integer, 30),
    nullif(p_input ->> 'renewal_duration_days', '')::integer,
    coalesce((p_input ->> 'payout_frequency_days')::integer, 14),
    upper(trim(p_input ->> 'payout_currency')),
    coalesce((p_input ->> 'minimum_payout_minor')::bigint, 10000)
  ) returning * into stored;

  return public.admin_agreement_enriched(stored);
end;
$$;

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

  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'main-link input must contain exactly affiliate_id and product_id'
      using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     ) or not (p_input ?& allowed_keys) then
    raise exception 'main-link input must contain exactly affiliate_id and product_id'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'affiliate_id') <> 'string'
     or jsonb_typeof(p_input -> 'product_id') <> 'string' then
    raise exception 'affiliate_id and product_id must be UUIDs' using errcode = '22023';
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

revoke all on function public.create_admin_agreement(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.issue_admin_main_link(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_admin_agreement(jsonb) to authenticated;
grant execute on function public.issue_admin_main_link(jsonb) to authenticated;
