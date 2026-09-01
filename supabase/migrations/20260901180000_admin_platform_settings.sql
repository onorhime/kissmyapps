begin;

-- Privacy-safe, aggregate-only configuration state for the protected Admin
-- Settings workspace. Public hostnames are explicit constants; secrets, raw
-- row identifiers, destinations, payment identifiers, and provider data are
-- never returned.

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
        and exists (
          select 1
          from public.funnels as funnel
          where funnel.product_id = product.id
            and funnel.is_default
            and funnel.status = 'live'
            and funnel.destination_url is not null
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

-- The foundation-wide updated_at trigger uses transaction_timestamp() (`now()`),
-- which is constant for an entire transaction and can overwrite a caller's
-- compare-and-swap timestamp. Platform Settings needs a strictly advancing
-- token even when two writes occur in the same transaction.
create or replace function public.set_platform_settings_updated_at()
returns trigger
language plpgsql
volatile
set search_path = ''
as $$
begin
  new.updated_at := greatest(
    statement_timestamp(),
    old.updated_at + interval '1 microsecond'
  );
  return new;
end;
$$;

revoke all on function public.set_platform_settings_updated_at()
  from public, anon, authenticated, service_role;

drop trigger if exists platform_settings_set_updated_at on public.platform_settings;
create trigger platform_settings_set_updated_at
  before update on public.platform_settings
  for each row execute function public.set_platform_settings_updated_at();

-- Keep upgrades fail closed. The prior configuration RPC allowed the switch to
-- be enabled before a commercial chain existed, so an already-enabled singleton
-- must be revalidated when this stricter contract is installed. A legacy
-- noncanonical origin is cleared even when its switch was already off, so the
-- strict read contract can still return a usable CAS token. This internal
-- helper remains callable by the migration owner so the upgrade behavior can be
-- covered transactionally by pgTAP without granting it to an API role.
create or replace function public.enforce_platform_tracking_fail_closed()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('platform-tracking-configuration', 0)
  );

  update public.platform_settings as setting
  set tracking_base_url = case
        when setting.tracking_base_url is null
          or setting.tracking_base_url = 'https://go.kissmyapps.dev'
          then setting.tracking_base_url
        else null
      end,
      tracking_enabled = false,
      updated_at = greatest(
        statement_timestamp(),
        setting.updated_at + interval '1 microsecond'
      )
  where setting.singleton
    and (
      (
        setting.tracking_enabled
        and not public.platform_tracking_enablement_ready(setting.tracking_base_url)
      )
      or (
        setting.tracking_base_url is not null
        and setting.tracking_base_url <> 'https://go.kissmyapps.dev'
      )
    )
  returning true into changed;

  return coalesce(changed, false);
end;
$$;

revoke all on function public.enforce_platform_tracking_fail_closed()
  from public, anon, authenticated, service_role;

select public.enforce_platform_tracking_fail_closed();

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
  readiness_record record;
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

  select
    (
      select count(*)::bigint
      from public.products as product
      where product.status = 'active'
    ) as active_product_count,
    (
      select count(*)::bigint
      from public.funnels as funnel
      where funnel.is_default
        and funnel.status = 'live'
        and funnel.destination_url is not null
        and public.is_production_https_url(funnel.destination_url, true)
    ) as live_default_funnel_count,
    (
      select count(*)::bigint
      from public.agreements as agreement
      where public.agreement_is_launch_ready(agreement.id, generated_at_value)
    ) as launch_ready_agreement_count,
    (
      select count(*)::bigint
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
        and offer.verified_billing_mode = offer.billing_mode
    ) as verified_active_offer_count,
    (
      select count(*)::bigint
      from public.affiliate_links as link
      where link.is_main
        and link.status = 'active'
    ) as active_main_link_count,
    (
      select count(*)::bigint
      from public.products as product
      where product.status = 'active'
        and exists (
          select 1
          from public.funnels as funnel
          where funnel.product_id = product.id
            and funnel.is_default
            and funnel.status = 'live'
            and funnel.destination_url is not null
            and public.is_production_https_url(funnel.destination_url, true)
        )
        and exists (
          select 1
          from public.agreements as agreement
          join public.affiliates as affiliate
            on affiliate.id = agreement.affiliate_id
           and affiliate.status = 'active'
          where agreement.product_id = product.id
            and public.agreement_is_launch_ready(agreement.id, generated_at_value)
        )
        and public.product_has_launch_ready_billing_offer(product.id)
    ) as enable_ready_product_count,
    (
      select count(*)::bigint
      from public.products as product
      where product.status = 'active'
        and coalesce(setting_record.tracking_enabled, false)
        and setting_record.tracking_base_url = 'https://go.kissmyapps.dev'
        and exists (
          select 1
          from public.funnels as funnel
          where funnel.product_id = product.id
            and funnel.is_default
            and funnel.status = 'live'
            and funnel.destination_url is not null
            and public.is_production_https_url(funnel.destination_url, true)
        )
        and public.product_has_launch_ready_billing_offer(product.id)
        and exists (
          select 1
          from public.agreements as agreement
          join public.affiliates as affiliate
            on affiliate.id = agreement.affiliate_id
           and affiliate.status = 'active'
          join public.affiliate_links as link
            on link.affiliate_id = agreement.affiliate_id
           and link.product_id = agreement.product_id
           and link.is_main
           and link.status = 'active'
           and link.tracking_url like 'https://go.kissmyapps.dev/r/%'
          join public.funnels as link_funnel
            on link_funnel.id = link.funnel_id
           and link_funnel.product_id = product.id
           and link_funnel.is_default
           and link_funnel.status = 'live'
           and link_funnel.destination_url is not null
           and public.is_production_https_url(link_funnel.destination_url, true)
          where agreement.product_id = product.id
            and public.agreement_is_launch_ready(agreement.id, generated_at_value)
        )
    ) as fully_live_product_count
  into readiness_record;

  return jsonb_build_object(
    -- Flat aliases preserve the original configure_admin_tracking response.
    'base_url', setting_record.tracking_base_url,
    'enabled', coalesce(setting_record.tracking_enabled, false),
    'updated_at', setting_record.updated_at,
    'tracking', jsonb_build_object(
      'base_url', setting_record.tracking_base_url,
      'enabled', coalesce(setting_record.tracking_enabled, false),
      'updated_at', setting_record.updated_at
    ),
    'readiness', jsonb_build_object(
      'can_enable',
        public.platform_tracking_enablement_ready(setting_record.tracking_base_url),
      'active_product_count', readiness_record.active_product_count,
      'live_default_funnel_count', readiness_record.live_default_funnel_count,
      'launch_ready_agreement_count', readiness_record.launch_ready_agreement_count,
      'verified_active_offer_count', readiness_record.verified_active_offer_count,
      'active_main_link_count', readiness_record.active_main_link_count,
      'enable_ready_product_count', readiness_record.enable_ready_product_count,
      'fully_live_product_count', readiness_record.fully_live_product_count
    ),
    'expected_hosts', jsonb_build_object(
      'partner', 'https://partners.kissmyapps.dev',
      'admin', 'https://admin.kissmyapps.dev',
      'tracking', 'https://go.kissmyapps.dev'
    )
  );
end;
$$;

-- Product activation is a pre-launch configuration step. Requiring the
-- tracking kill switch to be on here made it impossible to safely require an
-- active, offer-ready product before enabling tracking. The canonical origin
-- and live default funnel remain mandatory; tracking itself stays disabled
-- until configure_admin_tracking validates the complete commercial chain.
create or replace function public.activate_admin_product(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p_product_id uuid;
  existing public.products%rowtype;
  stored public.products%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'activate products');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'product activation input must contain exactly product_id'
      using errcode = '22023';
  end if;
  if not (p_input ? 'product_id')
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> 'product_id'
     ) then
    raise exception 'product activation input must contain exactly product_id'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'product_id') <> 'string' then
    raise exception 'product_id must be a UUID' using errcode = '22023';
  end if;
  begin
    p_product_id := nullif(trim(p_input ->> 'product_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'product_id must be a UUID' using errcode = '22023';
  end;
  select * into existing
  from public.products as product
  where product.id = p_product_id
  for update;
  if existing.id is null then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if existing.status not in ('draft', 'paused') then
    raise exception 'only a draft or paused product can be activated' using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from public.platform_settings as setting
    where setting.singleton
      and setting.tracking_base_url = 'https://go.kissmyapps.dev'
  ) then
    raise exception 'canonical production tracking origin must be configured first'
      using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from public.funnels as funnel
    where funnel.product_id = existing.id
      and funnel.is_default
      and funnel.status = 'live'
      and funnel.destination_url is not null
      and public.is_production_https_url(funnel.destination_url, true)
  ) then
    raise exception 'product requires one live default HTTPS funnel' using errcode = 'P0001';
  end if;

  update public.products as product
  set status = 'active'
  where product.id = existing.id
  returning * into stored;
  return to_jsonb(stored);
end;
$$;

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
    raise exception 'tracking activation requires the canonical origin, an active product with a live default HTTPS funnel, launch-ready agreement, active live-verified subscription offer, and canonical non-archived main links'
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

revoke all on function public.get_admin_platform_settings()
  from public, anon, authenticated, service_role;
revoke all on function public.configure_admin_tracking(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.activate_admin_product(jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.get_admin_platform_settings()
  to authenticated;
grant execute on function public.configure_admin_tracking(jsonb)
  to authenticated;
grant execute on function public.activate_admin_product(jsonb)
  to authenticated;

comment on function public.get_admin_platform_settings() is
  'Returns the actual tracking origin and kill-switch state, public expected hosts, and aggregate launch-readiness counts to Owner, Operations, Finance, and Analyst admins without exposing secrets or raw identifiers.';
comment on function public.configure_admin_tracking(jsonb) is
  'Configures only the canonical production tracking origin using an expected_updated_at compare-and-swap token. Only a password-authenticated Owner can mutate it; enabling requires one correlated active product, live default funnel, launch-ready agreement, active live-verified subscription offer, and canonical non-archived main links, while disabling remains immediately available.';
comment on function public.activate_admin_product(jsonb) is
  'Activates a product after the canonical production tracking origin and live default funnel are configured. The tracking kill switch remains off until the complete commercial chain passes configure_admin_tracking.';
comment on function public.platform_tracking_enablement_ready(text) is
  'Internal fail-closed predicate for the canonical tracking origin, correlated commercial readiness, and existing non-archived main-link prefixes. It is not granted to API roles.';
comment on function public.set_platform_settings_updated_at() is
  'Internal trigger that makes the Platform Settings updated_at compare-and-swap token advance monotonically, including for multiple writes in one transaction. It is not granted to API roles.';
comment on function public.enforce_platform_tracking_fail_closed() is
  'Internal migration-owner helper that disables an unsafe legacy enabled singleton, clears a legacy noncanonical origin, and advances its concurrency token. It is not granted to API roles.';

commit;
