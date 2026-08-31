-- Production Admin billing-offer configuration and live Stripe Price attestation.
-- This migration creates no offers and never accepts Stripe credentials from a browser.

alter table public.billing_offers
  add column verified_stripe_price_id text,
  add column verified_currency text,
  add column verified_unit_amount_minor bigint,
  add column verified_billing_mode text,
  add column stripe_livemode_verified_at timestamptz,
  add constraint billing_offers_verification_complete check (
    (
      verified_stripe_price_id is null
      and verified_currency is null
      and verified_unit_amount_minor is null
      and verified_billing_mode is null
      and stripe_livemode_verified_at is null
    )
    or (
      verified_stripe_price_id ~ '^price_[A-Za-z0-9_]{8,128}$'
      and verified_currency ~ '^[A-Z]{3}$'
      and verified_unit_amount_minor between 1 and 99999999
      and verified_billing_mode in ('payment', 'subscription')
      and stripe_livemode_verified_at is not null
    )
  );

create or replace function public.product_has_launch_ready_billing_offer(p_product_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.billing_offers as offer
    where offer.product_id = p_product_id
      and offer.status = 'active'
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
      and offer.verified_billing_mode = offer.billing_mode
  );
$$;

create or replace function public.validate_active_link_billing_readiness()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'active'
     and not public.product_has_launch_ready_billing_offer(new.product_id) then
    raise exception 'active links require an active live-verified subscription offer'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger affiliate_links_validate_billing_readiness
  before insert or update on public.affiliate_links
  for each row execute function public.validate_active_link_billing_readiness();

do $$
begin
  if exists (
    select 1
    from public.affiliate_links as link
    where link.status = 'active'
      and not public.product_has_launch_ready_billing_offer(link.product_id)
  ) then
    raise exception 'existing active links require an active live-verified subscription offer'
      using errcode = 'P0001';
  end if;
end;
$$;

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
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(array['owner', 'operations', 'finance', 'analyst']::text[]) then
    raise exception 'admin role cannot view product configuration' using errcode = '42501';
  end if;

  select * into product_record
  from public.products as product
  where product.id = p_product_id;
  if product_record.id is null then
    raise exception 'product not found' using errcode = 'P0002';
  end if;

  select * into tracking_record
  from public.platform_settings as setting
  where setting.singleton;

  return jsonb_build_object(
    'product', jsonb_build_object(
      'id', product_record.id,
      'slug', product_record.slug,
      'name', product_record.name,
      'status', product_record.status,
      'created_at', product_record.created_at,
      'updated_at', product_record.updated_at
    ),
    'tracking', jsonb_build_object(
      'enabled', coalesce(tracking_record.tracking_enabled, false),
      'base_url', tracking_record.tracking_base_url
    ),
    'readiness', jsonb_build_object(
      'has_live_default_funnel', exists (
        select 1
        from public.funnels as funnel
        where funnel.product_id = p_product_id
          and funnel.is_default
          and funnel.status = 'live'
          and funnel.destination_url is not null
      ),
      'has_active_agreement', exists (
        select 1
        from public.agreements as agreement
        where agreement.product_id = p_product_id
          and agreement.status = 'active'
      ),
      'has_active_billing_offer', public.product_has_launch_ready_billing_offer(p_product_id),
      'tracking_ready', coalesce(tracking_record.tracking_enabled, false)
        and tracking_record.tracking_base_url is not null
    ),
    'funnels', coalesce((
      select jsonb_agg(to_jsonb(funnel) order by funnel.is_default desc, funnel.name, funnel.id)
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
            select 1
            from public.documents as document
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

create or replace function public.create_admin_billing_offer(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'product_id', 'key', 'name', 'billing_mode', 'stripe_price_id', 'currency',
    'unit_amount_minor', 'success_url_template', 'cancel_url'
  ];
  product_id_value uuid;
  key_value text;
  name_value text;
  billing_mode_value text;
  stripe_price_id_value text;
  currency_value text;
  unit_amount_value bigint;
  success_url_value text;
  cancel_url_value text;
  next_version integer;
  stored public.billing_offers%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'create billing offers');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'billing offer input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) as input_key(key_name)
    where input_key.key_name <> all(allowed_keys)
  ) or not (p_input ?& array['product_id', 'key', 'name', 'billing_mode']) then
    raise exception 'billing offer input contains unsupported or missing fields'
      using errcode = '22023';
  end if;

  begin
    product_id_value := nullif(trim(p_input ->> 'product_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'product_id must be a UUID' using errcode = '22023';
  end;
  key_value := trim(p_input ->> 'key');
  name_value := trim(p_input ->> 'name');
  billing_mode_value := trim(p_input ->> 'billing_mode');
  stripe_price_id_value := nullif(trim(p_input ->> 'stripe_price_id'), '');
  currency_value := nullif(trim(p_input ->> 'currency'), '');
  success_url_value := nullif(trim(p_input ->> 'success_url_template'), '');
  cancel_url_value := nullif(trim(p_input ->> 'cancel_url'), '');

  if product_id_value is null
     or not exists (select 1 from public.products as product where product.id = product_id_value) then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if key_value !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or char_length(key_value) > 120 then
    raise exception 'billing offer key must be a canonical lowercase slug' using errcode = '22023';
  end if;
  if char_length(name_value) not between 1 and 120 then
    raise exception 'billing offer name must contain between 1 and 120 characters'
      using errcode = '22023';
  end if;
  if billing_mode_value not in ('payment', 'subscription') then
    raise exception 'billing mode must be payment or subscription' using errcode = '22023';
  end if;
  if stripe_price_id_value is not null
     and stripe_price_id_value !~ '^price_[A-Za-z0-9_]{8,128}$' then
    raise exception 'Stripe price ID is invalid' using errcode = '22023';
  end if;
  if currency_value is not null and currency_value !~ '^[A-Z]{3}$' then
    raise exception 'billing currency must be a three-letter uppercase code' using errcode = '22023';
  end if;
  if p_input ? 'unit_amount_minor' and jsonb_typeof(p_input -> 'unit_amount_minor') <> 'null' then
    if jsonb_typeof(p_input -> 'unit_amount_minor') <> 'number'
       or (p_input ->> 'unit_amount_minor') !~ '^[0-9]+$' then
      raise exception 'billing amount must be an integer in minor units' using errcode = '22023';
    end if;
    unit_amount_value := (p_input ->> 'unit_amount_minor')::bigint;
    if unit_amount_value not between 1 and 99999999 then
      raise exception 'billing amount is outside the supported range' using errcode = '22023';
    end if;
  end if;
  if success_url_value is not null
     and not public.is_production_https_url(success_url_value, true) then
    raise exception 'success URL must be a production HTTPS URL without a fragment'
      using errcode = '22023';
  end if;
  if cancel_url_value is not null
     and not public.is_production_https_url(cancel_url_value, true) then
    raise exception 'cancel URL must be a production HTTPS URL without a fragment'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(product_id_value::text || ':' || key_value, 0)
  );
  select coalesce(max(offer.version), 0) + 1 into next_version
  from public.billing_offers as offer
  where offer.product_id = product_id_value and offer.key = key_value;

  insert into public.billing_offers (
    product_id, key, version, name, billing_mode, stripe_price_id, currency,
    unit_amount_minor, success_url_template, cancel_url, status
  ) values (
    product_id_value, key_value, next_version, name_value, billing_mode_value,
    stripe_price_id_value, currency_value, unit_amount_value, success_url_value,
    cancel_url_value, 'draft'
  ) returning * into stored;

  return (to_jsonb(stored)
    - 'verified_stripe_price_id'
    - 'verified_currency'
    - 'verified_unit_amount_minor'
    - 'verified_billing_mode')
    || jsonb_build_object('stripe_price_verified', false);
end;
$$;

create or replace function public.update_admin_billing_offer(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'billing_offer_id', 'name', 'billing_mode', 'stripe_price_id', 'currency',
    'unit_amount_minor', 'success_url_template', 'cancel_url'
  ];
  offer_id_value uuid;
  name_value text;
  billing_mode_value text;
  stripe_price_id_value text;
  currency_value text;
  unit_amount_value bigint;
  success_url_value text;
  cancel_url_value text;
  existing public.billing_offers%rowtype;
  stored public.billing_offers%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'update billing offers');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'billing offer update must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) as input_key(key_name)
    where input_key.key_name <> all(allowed_keys)
  ) or not (p_input ?& allowed_keys) then
    raise exception 'billing offer update must contain exactly the editable configuration fields'
      using errcode = '22023';
  end if;

  begin
    offer_id_value := nullif(trim(p_input ->> 'billing_offer_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'billing_offer_id must be a UUID' using errcode = '22023';
  end;
  select * into existing
  from public.billing_offers as offer
  where offer.id = offer_id_value
  for update;
  if existing.id is null then
    raise exception 'billing offer not found' using errcode = 'P0002';
  end if;
  if existing.status <> 'draft' then
    raise exception 'only draft billing offers can be edited' using errcode = 'P0001';
  end if;

  name_value := trim(p_input ->> 'name');
  billing_mode_value := trim(p_input ->> 'billing_mode');
  stripe_price_id_value := nullif(trim(p_input ->> 'stripe_price_id'), '');
  currency_value := nullif(trim(p_input ->> 'currency'), '');
  success_url_value := nullif(trim(p_input ->> 'success_url_template'), '');
  cancel_url_value := nullif(trim(p_input ->> 'cancel_url'), '');

  if char_length(name_value) not between 1 and 120 then
    raise exception 'billing offer name must contain between 1 and 120 characters'
      using errcode = '22023';
  end if;
  if billing_mode_value not in ('payment', 'subscription') then
    raise exception 'billing mode must be payment or subscription' using errcode = '22023';
  end if;
  if stripe_price_id_value is not null
     and stripe_price_id_value !~ '^price_[A-Za-z0-9_]{8,128}$' then
    raise exception 'Stripe price ID is invalid' using errcode = '22023';
  end if;
  if currency_value is not null and currency_value !~ '^[A-Z]{3}$' then
    raise exception 'billing currency must be a three-letter uppercase code' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'unit_amount_minor') <> 'null' then
    if jsonb_typeof(p_input -> 'unit_amount_minor') <> 'number'
       or (p_input ->> 'unit_amount_minor') !~ '^[0-9]+$' then
      raise exception 'billing amount must be an integer in minor units' using errcode = '22023';
    end if;
    unit_amount_value := (p_input ->> 'unit_amount_minor')::bigint;
    if unit_amount_value not between 1 and 99999999 then
      raise exception 'billing amount is outside the supported range' using errcode = '22023';
    end if;
  end if;
  if success_url_value is not null
     and not public.is_production_https_url(success_url_value, true) then
    raise exception 'success URL must be a production HTTPS URL without a fragment'
      using errcode = '22023';
  end if;
  if cancel_url_value is not null
     and not public.is_production_https_url(cancel_url_value, true) then
    raise exception 'cancel URL must be a production HTTPS URL without a fragment'
      using errcode = '22023';
  end if;

  update public.billing_offers as offer
  set
    name = name_value,
    billing_mode = billing_mode_value,
    stripe_price_id = stripe_price_id_value,
    currency = currency_value,
    unit_amount_minor = unit_amount_value,
    success_url_template = success_url_value,
    cancel_url = cancel_url_value,
    verified_stripe_price_id = null,
    verified_currency = null,
    verified_unit_amount_minor = null,
    verified_billing_mode = null,
    stripe_livemode_verified_at = null
  where offer.id = offer_id_value
  returning * into stored;

  return (to_jsonb(stored)
    - 'verified_stripe_price_id'
    - 'verified_currency'
    - 'verified_unit_amount_minor'
    - 'verified_billing_mode')
    || jsonb_build_object('stripe_price_verified', false);
end;
$$;

create or replace function public.record_billing_offer_stripe_verification(p_input jsonb)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'billing_offer_id', 'stripe_price_id', 'livemode', 'active', 'currency',
    'unit_amount_minor', 'billing_mode'
  ];
  offer_id_value uuid;
  price_id_value text;
  currency_value text;
  amount_value bigint;
  mode_value text;
  existing public.billing_offers%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role is required' using errcode = '42501';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key(key_name)
       where input_key.key_name <> all(allowed_keys)
     )
     or not (p_input ?& allowed_keys) then
    raise exception 'Stripe Price verification input is invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'livemode') <> 'boolean'
     or jsonb_typeof(p_input -> 'active') <> 'boolean'
     or (p_input ->> 'livemode')::boolean is not true
     or (p_input ->> 'active')::boolean is not true then
    raise exception 'only an active live-mode Stripe Price can be verified'
      using errcode = '22023';
  end if;

  begin
    offer_id_value := nullif(trim(p_input ->> 'billing_offer_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'billing_offer_id must be a UUID' using errcode = '22023';
  end;
  price_id_value := trim(p_input ->> 'stripe_price_id');
  currency_value := trim(p_input ->> 'currency');
  mode_value := trim(p_input ->> 'billing_mode');
  if jsonb_typeof(p_input -> 'unit_amount_minor') <> 'number'
     or (p_input ->> 'unit_amount_minor') !~ '^[0-9]+$' then
    raise exception 'verified amount must be an integer in minor units' using errcode = '22023';
  end if;
  amount_value := (p_input ->> 'unit_amount_minor')::bigint;

  select * into existing
  from public.billing_offers as offer
  where offer.id = offer_id_value
  for update;
  if existing.id is null then
    raise exception 'billing offer not found' using errcode = 'P0002';
  end if;
  if existing.status <> 'draft' then
    raise exception 'only a draft billing offer can receive Price verification'
      using errcode = 'P0001';
  end if;
  if existing.stripe_price_id is distinct from price_id_value
     or existing.currency is distinct from currency_value
     or existing.unit_amount_minor is distinct from amount_value
     or existing.billing_mode <> mode_value then
    raise exception 'Stripe Price facts do not exactly match the configured offer'
      using errcode = '23514';
  end if;

  update public.billing_offers as offer
  set
    verified_stripe_price_id = price_id_value,
    verified_currency = currency_value,
    verified_unit_amount_minor = amount_value,
    verified_billing_mode = mode_value,
    stripe_livemode_verified_at = now()
  where offer.id = offer_id_value;
  return true;
end;
$$;

create or replace function public.set_admin_billing_offer_status(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['billing_offer_id', 'status'];
  offer_id_value uuid;
  status_value text;
  existing public.billing_offers%rowtype;
  stored public.billing_offers%rowtype;
  product_state public.product_status;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'change billing offer status');
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key(key_name)
       where input_key.key_name <> all(allowed_keys)
     )
     or not (p_input ?& allowed_keys)
     or jsonb_typeof(p_input -> 'billing_offer_id') <> 'string'
     or jsonb_typeof(p_input -> 'status') <> 'string' then
    raise exception 'billing offer status input must contain exactly billing_offer_id and status'
      using errcode = '22023';
  end if;
  begin
    offer_id_value := nullif(trim(p_input ->> 'billing_offer_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'billing_offer_id must be a UUID' using errcode = '22023';
  end;
  status_value := trim(p_input ->> 'status');
  if status_value not in ('active', 'paused', 'archived') then
    raise exception 'billing offer status is invalid' using errcode = '22023';
  end if;

  select * into existing
  from public.billing_offers as offer
  where offer.id = offer_id_value
  for update;
  if existing.id is null then
    raise exception 'billing offer not found' using errcode = 'P0002';
  end if;
  if not (
    (existing.status = 'draft' and status_value in ('active', 'archived'))
    or (existing.status = 'active' and status_value in ('paused', 'archived'))
    or (existing.status = 'paused' and status_value in ('active', 'archived'))
  ) then
    raise exception 'billing offer cannot move to that status' using errcode = 'P0001';
  end if;

  if existing.status = 'active'
     and status_value in ('paused', 'archived')
     and exists (
       select 1
       from public.affiliate_links as link
       where link.product_id = existing.product_id and link.status = 'active'
     )
     and not exists (
       select 1
       from public.billing_offers as replacement
       where replacement.product_id = existing.product_id
         and replacement.id <> existing.id
         and replacement.status = 'active'
         and replacement.billing_mode = 'subscription'
         and replacement.stripe_price_id is not null
         and replacement.currency is not null
         and replacement.unit_amount_minor is not null
         and replacement.success_url_template is not null
         and replacement.cancel_url is not null
         and position('{CHECKOUT_SESSION_ID}' in replacement.success_url_template) > 0
         and public.is_production_https_url(replacement.success_url_template, true)
         and public.is_production_https_url(replacement.cancel_url, true)
         and replacement.stripe_livemode_verified_at is not null
         and replacement.verified_stripe_price_id is not distinct from replacement.stripe_price_id
         and replacement.verified_currency is not distinct from replacement.currency
         and replacement.verified_unit_amount_minor is not distinct from replacement.unit_amount_minor
         and replacement.verified_billing_mode = replacement.billing_mode
     ) then
    raise exception 'pause active partner links or activate a replacement offer first'
      using errcode = 'P0001';
  end if;

  if status_value = 'active' then
    if existing.billing_mode <> 'subscription' then
      raise exception 'payment-mode offers are draft-only until canonical one-time transactions are enabled'
        using errcode = 'P0001';
    end if;
    select product.status into product_state
    from public.products as product
    where product.id = existing.product_id
    for share;
    if product_state <> 'active' then
      raise exception 'billing offer activation requires an active product' using errcode = 'P0001';
    end if;
    if existing.stripe_price_id is null
       or existing.currency is null
       or existing.unit_amount_minor is null
       or existing.success_url_template is null
       or existing.cancel_url is null
       or position('{CHECKOUT_SESSION_ID}' in existing.success_url_template) = 0
       or not public.is_production_https_url(existing.success_url_template, true)
       or not public.is_production_https_url(existing.cancel_url, true) then
      raise exception 'complete the production Stripe Price, exact amount, currency, and redirect URLs before activation'
        using errcode = 'P0001';
    end if;
    if existing.stripe_livemode_verified_at is null
       or existing.verified_stripe_price_id is distinct from existing.stripe_price_id
       or existing.verified_currency is distinct from existing.currency
       or existing.verified_unit_amount_minor is distinct from existing.unit_amount_minor
       or existing.verified_billing_mode <> existing.billing_mode then
      raise exception 'the configured Stripe Price must be verified in live mode before activation'
        using errcode = 'P0001';
    end if;
    if exists (
      select 1
      from public.billing_offers as offer
      where offer.product_id = existing.product_id
        and offer.key = existing.key
        and offer.id <> existing.id
        and offer.status = 'active'
    ) then
      raise exception 'another version of this billing offer is already active'
        using errcode = '23505';
    end if;
  end if;

  update public.billing_offers as offer
  set status = status_value
  where offer.id = offer_id_value
  returning * into stored;

  return (to_jsonb(stored)
    - 'verified_stripe_price_id'
    - 'verified_currency'
    - 'verified_unit_amount_minor'
    - 'verified_billing_mode')
    || jsonb_build_object(
      'stripe_price_verified',
        stored.stripe_livemode_verified_at is not null
        and stored.verified_stripe_price_id is not distinct from stored.stripe_price_id
        and stored.verified_currency is not distinct from stored.currency
        and stored.verified_unit_amount_minor is not distinct from stored.unit_amount_minor
        and stored.verified_billing_mode = stored.billing_mode
    );
end;
$$;

revoke all on function public.create_admin_billing_offer(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.update_admin_billing_offer(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.set_admin_billing_offer_status(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.record_billing_offer_stripe_verification(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.validate_active_link_billing_readiness()
  from public, anon, authenticated, service_role;
revoke all on function public.product_has_launch_ready_billing_offer(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.create_admin_billing_offer(jsonb) to authenticated;
grant execute on function public.update_admin_billing_offer(jsonb) to authenticated;
grant execute on function public.set_admin_billing_offer_status(jsonb) to authenticated;
grant execute on function public.record_billing_offer_stripe_verification(jsonb) to service_role;

comment on function public.create_admin_billing_offer(jsonb) is
  'Owner/Operations password-proven creation of an immutable-key, versioned draft offer.';
comment on function public.update_admin_billing_offer(jsonb) is
  'Owner/Operations password-proven draft-only term update. Any change clears prior Price verification.';
comment on function public.record_billing_offer_stripe_verification(jsonb) is
  'Service-only attestation that an active live Stripe Price exactly matches draft offer facts.';
comment on function public.set_admin_billing_offer_status(jsonb) is
  'Owner/Operations password-proven offer lifecycle. Payment activation is fail-closed.';
comment on function public.product_has_launch_ready_billing_offer(uuid) is
  'Internal exact-match production billing gate used before any partner link can be active.';
