-- One readiness predicate for commercial creator links and admin projections.
-- Adds no offers, merchant assignments, links, checkout permission or payout gate.
begin;

create function kma_internal.billing_offer_is_launch_ready(p_offer_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.billing_offers as offer
    where offer.id = p_offer_id
      and offer.status = 'active'
      and offer.stripe_price_id is not null
      and offer.currency is not null
      and offer.unit_amount_minor is not null
      and offer.success_url_template is not null
      and offer.cancel_url is not null
      and position('{CHECKOUT_SESSION_ID}' in offer.success_url_template) > 0
      and public.is_production_https_url(offer.success_url_template, true)
      and public.is_production_https_url(offer.cancel_url, true)
      and (
        (
          offer.billing_mode = 'subscription'
          and offer.stripe_livemode_verified_at is not null
          and offer.verified_stripe_price_id is not distinct from offer.stripe_price_id
          and offer.verified_currency is not distinct from offer.currency
          and offer.verified_unit_amount_minor is not distinct from offer.unit_amount_minor
          and offer.verified_billing_mode = offer.billing_mode
        )
        or (
          offer.billing_mode = 'payment'
          and exists (
            select 1 from public.products as product
            join public.managed_payment_products as managed on managed.product_id = product.id
            where product.id = offer.product_id and product.status = 'active' and managed.enabled
          )
          and exists (
            select 1 from public.managed_payment_offer_prices as proof
            where proof.offer_id = offer.id
              and proof.livemode
              and proof.offer_version = offer.version
              and proof.configured_price_id = offer.stripe_price_id
              and proof.currency = offer.currency
              and proof.unit_amount_minor = offer.unit_amount_minor
              and proof.verified_at is not null
              and (
                -- Platform-owned checkout uses trusted service-verifier evidence.
                -- A TEST assignment does not change the LIVE merchant boundary.
                not exists (
                  select 1 from public.product_merchant_connections as assignment
                  where assignment.product_id = offer.product_id and assignment.livemode
                )
                or exists (
                  select 1 from public.product_merchant_connections as assignment
                  join public.merchant_connections as connection on connection.id = assignment.connection_id
                  where assignment.product_id = offer.product_id
                    and assignment.livemode and connection.livemode
                    and connection.account_id = proof.account_id
                    and connection.status = 'active'
                    and connection.charges_enabled and connection.details_submitted
                )
              )
          )
        )
      )
  );
$$;
revoke all on function kma_internal.billing_offer_is_launch_ready(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.product_has_launch_ready_billing_offer(p_product_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.billing_offers as offer
    where offer.product_id = p_product_id
      and kma_internal.billing_offer_is_launch_ready(offer.id)
  );
$$;

create or replace function public.validate_active_link_billing_readiness()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'active' then
    if new.commercial_eligible then
      if not public.product_has_launch_ready_billing_offer(new.product_id) then
        raise exception 'active links require an active live-verified subscription or managed one-time offer' using errcode = 'P0001';
      end if;
    elsif not public.tracking_only_product_is_ready(new.product_id) then
      raise exception 'noncommercial links require a valid Owner-approved tracking-only product' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

-- Keep the permission checks, document redaction and existing configuration
-- fields. The per-offer flag includes the current assigned LIVE merchant check.
create or replace function public.get_admin_product_configuration(p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare configuration jsonb;
begin
  configuration := public.get_admin_product_configuration_before_managed_payments(p_product_id);
  configuration := jsonb_set(configuration, '{billing_offers}', coalesce((
    select jsonb_agg(offer || jsonb_build_object(
      'main_link_ready', kma_internal.billing_offer_is_launch_ready((offer->>'id')::uuid),
      'managed_price_verifications', coalesce((
        select jsonb_agg(to_jsonb(price) - 'offer_id' order by price.livemode, price.account_id)
        from public.managed_payment_offer_prices as price
        where price.offer_id = (offer->>'id')::uuid
          and price.offer_version = (offer->>'version')::integer
          and price.configured_price_id = offer->>'stripe_price_id'
          and price.currency = offer->>'currency'
          and price.unit_amount_minor = (offer->>'unit_amount_minor')::bigint
      ), '[]'::jsonb)
    )) from jsonb_array_elements(configuration->'billing_offers') as offer
  ), '[]'::jsonb));
  return jsonb_set(configuration, '{readiness,managed_payment_checkout_enabled}', to_jsonb(exists (
    select 1 from public.managed_payment_products as managed
    where managed.product_id = p_product_id and managed.enabled
  )));
end;
$$;

-- Preserve the complete protected operational projections, replacing only the
-- obsolete subscription-only offer counters. The renamed readers stay private.
alter function public.get_admin_platform_settings()
  rename to get_admin_platform_settings_before_managed_link_readiness;
revoke all on function public.get_admin_platform_settings_before_managed_link_readiness()
  from public, anon, authenticated, service_role;
create function public.get_admin_platform_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  result := public.get_admin_platform_settings_before_managed_link_readiness();
  return jsonb_set(result, '{readiness,verified_active_offer_count}', to_jsonb((
    select count(*) from public.billing_offers as offer
    where kma_internal.billing_offer_is_launch_ready(offer.id)
  )));
end;
$$;
revoke all on function public.get_admin_platform_settings() from public, anon, authenticated, service_role;
grant execute on function public.get_admin_platform_settings() to authenticated;

alter function public.get_admin_data_health()
  rename to get_admin_data_health_before_managed_link_readiness;
revoke all on function public.get_admin_data_health_before_managed_link_readiness()
  from public, anon, authenticated, service_role;
create function public.get_admin_data_health()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  result := public.get_admin_data_health_before_managed_link_readiness();
  return jsonb_set(result, '{catalog,verified_active_offer_count}', to_jsonb((
    select count(*) from public.billing_offers as offer
    where kma_internal.billing_offer_is_launch_ready(offer.id)
  )));
end;
$$;
revoke all on function public.get_admin_data_health() from public, anon, authenticated, service_role;
grant execute on function public.get_admin_data_health() to authenticated;

-- Same tracking switch/CAS/role behavior; the error now describes both paths.
create or replace function public.configure_admin_tracking(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['base_url', 'enabled', 'expected_updated_at'];
  base_url_value text;
  enabled_value boolean;
  expected_updated_at_value timestamptz;
  current_settings public.platform_settings%rowtype;
  settings_exist boolean := false;
  next_updated_at timestamptz;
begin
  perform public.assert_admin_password(array['owner']::text[], 'configure tracking');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'tracking input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) as input_key(key_name)
    where input_key.key_name <> all(allowed_keys)
  ) or not (p_input ?& allowed_keys) then
    raise exception 'tracking input must contain exactly base_url, enabled, and expected_updated_at'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'enabled') <> 'boolean'
     or jsonb_typeof(p_input -> 'base_url') not in ('string', 'null')
     or jsonb_typeof(p_input -> 'expected_updated_at') not in ('string', 'null') then
    raise exception 'tracking input types are invalid' using errcode = '22023';
  end if;

  base_url_value := nullif(trim(p_input ->> 'base_url'), '');
  enabled_value := (p_input ->> 'enabled')::boolean;
  if jsonb_typeof(p_input -> 'expected_updated_at') = 'string' then
    begin
      expected_updated_at_value := (p_input ->> 'expected_updated_at')::timestamptz;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        raise exception 'expected_updated_at must be a valid timestamp or null'
          using errcode = '22023';
    end;
  end if;

  if base_url_value is not null
     and base_url_value <> 'https://go.kissmyapps.dev' then
    raise exception 'tracking base URL must equal https://go.kissmyapps.dev'
      using errcode = '22023';
  end if;
  if enabled_value and base_url_value is null then
    raise exception 'tracking cannot be enabled without an HTTPS base URL' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('platform-tracking-configuration', 0)
  );

  select * into current_settings
  from public.platform_settings as setting
  where setting.singleton
  for update;
  settings_exist := found;

  if expected_updated_at_value is null then
    if settings_exist then
      raise exception 'platform settings changed; reload before saving' using errcode = '40001';
    end if;
  elsif not settings_exist
        or current_settings.updated_at is distinct from expected_updated_at_value then
    raise exception 'platform settings changed; reload before saving' using errcode = '40001';
  end if;

  if enabled_value
     and not public.platform_tracking_enablement_ready(base_url_value) then
    raise exception 'tracking activation requires the canonical origin and a ready commercial or Owner-approved tracking-only product; commercial products need a live default HTTPS funnel, signed agreement, and active live-verified subscription or managed one-time offer'
      using errcode = 'P0001';
  end if;

  next_updated_at := case
    when settings_exist then greatest(
      statement_timestamp(),
      current_settings.updated_at + interval '1 microsecond'
    )
    else statement_timestamp()
  end;

  if settings_exist then
    update public.platform_settings as setting
    set tracking_base_url = base_url_value,
        tracking_enabled = enabled_value,
        updated_at = next_updated_at
    where setting.singleton;
  else
    begin
      insert into public.platform_settings (
        singleton, tracking_base_url, tracking_enabled, updated_at
      ) values (
        true, base_url_value, enabled_value, next_updated_at
      );
    exception when unique_violation then
      raise exception 'platform settings changed; reload before saving' using errcode = '40001';
    end;
  end if;

  return public.get_admin_platform_settings();
end;
$$;

comment on function public.product_has_launch_ready_billing_offer(uuid) is
  'Commercial creator-link readiness: exact active live subscription verification or opted-in managed one-time verification for the current live merchant. Does not enable checkout or payouts.';
comment on function kma_internal.billing_offer_is_launch_ready(uuid) is
  'Internal per-offer readiness. Managed LIVE evidence must match the current configured price, version, amount, currency and assigned charge-enabled merchant, when assigned.';
commit;
