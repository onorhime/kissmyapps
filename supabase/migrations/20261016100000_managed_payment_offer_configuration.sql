-- Reuse the existing verified Stripe Price catalog for managed one-time payments.
-- No product is enabled by this migration. Legacy subscription checkout and its
-- launch/link readiness stay unchanged; managed checkout has a separate service
-- boundary and an additional disabled-by-default runtime switch.

create table public.managed_payment_products (
  product_id uuid primary key references public.products (id),
  enabled boolean not null default false
);
alter table public.managed_payment_products enable row level security;
revoke all on public.managed_payment_products from public, anon, authenticated;
grant select, insert, update, delete on public.managed_payment_products to service_role;
comment on table public.managed_payment_products is
  'Service-provisioned managed checkout opt-in. Does not enable legacy public checkout or product-owner transfers.';

alter table public.billing_offers drop constraint billing_offers_payment_mode_dormant;

create function public.validate_managed_payment_offer_activation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.billing_mode = 'payment' and new.status = 'active' then
    perform 1 from public.managed_payment_products as managed
    where managed.product_id = new.product_id and managed.enabled
    for share;
    if not found then
      raise exception 'enable the managed checkout integration before activating a one-time offer'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.validate_managed_payment_offer_activation()
  from public, anon, authenticated, service_role;
create trigger billing_offers_validate_managed_payment
  before insert or update on public.billing_offers
  for each row execute function public.validate_managed_payment_offer_activation();

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
     and existing.billing_mode = 'subscription'
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
    if existing.billing_mode = 'payment' and not exists (
      select 1 from public.managed_payment_products as managed
      where managed.product_id = existing.product_id and managed.enabled
    ) then
      raise exception 'enable the managed checkout integration before activating a one-time offer'
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
    if existing.billing_mode = 'payment' then
      if not exists (select 1 from public.managed_payment_offer_prices price
        where price.offer_id=existing.id and price.offer_version=existing.version
          and price.configured_price_id=existing.stripe_price_id
          and price.currency=existing.currency and price.unit_amount_minor=existing.unit_amount_minor) then
        raise exception 'verify a Price for the managed checkout account and mode before activation' using errcode='P0001';
      end if;
    elsif existing.stripe_livemode_verified_at is null
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

-- Preserve the complete current configuration projection (including document
-- redaction and signed-policy checks) and expose only the integration opt-in.
alter function public.get_admin_product_configuration(uuid)
  rename to get_admin_product_configuration_before_managed_payments;
revoke all on function public.get_admin_product_configuration_before_managed_payments(uuid)
  from public, anon, authenticated, service_role;

create function public.get_admin_product_configuration(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  configuration jsonb;
begin
  configuration := public.get_admin_product_configuration_before_managed_payments(p_product_id);
  configuration := jsonb_set(configuration, '{billing_offers}', coalesce((
    select jsonb_agg(offer || jsonb_build_object('managed_price_verifications', coalesce((
      select jsonb_agg(to_jsonb(price) - 'offer_id' order by price.livemode, price.account_id)
      from public.managed_payment_offer_prices price
      where price.offer_id=(offer->>'id')::uuid
        and price.offer_version=(offer->>'version')::integer
        and price.configured_price_id=offer->>'stripe_price_id'
        and price.currency=offer->>'currency'
        and price.unit_amount_minor=(offer->>'unit_amount_minor')::bigint
    ), '[]'::jsonb))) from jsonb_array_elements(configuration->'billing_offers') offer
  ), '[]'::jsonb));
  return jsonb_set(configuration, '{readiness,managed_payment_checkout_enabled}',
    to_jsonb(exists (
      select 1 from public.managed_payment_products as managed
      where managed.product_id = p_product_id and managed.enabled
    )));
end;
$$;
revoke all on function public.get_admin_product_configuration(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_admin_product_configuration(uuid) to authenticated;

comment on function public.set_admin_billing_offer_status(jsonb) is
  'Password-proven catalog lifecycle. Verified one-time offers also require the managed checkout product opt-in.';

-- The original public checkout has subscription-only normalization. Callers
-- must not bypass managed checkout's order authentication/reservation by calling
-- the legacy endpoint directly with a newly active payment offer.
create or replace function public.prepare_checkout_attempt(p_input jsonb)
returns table (
  attempt_id uuid,
  public_attempt_id text,
  billing_offer_id uuid,
  product_id uuid,
  acquisition_id uuid,
  click_record_id uuid,
  affiliate_id uuid,
  billing_mode text,
  stripe_price_id text,
  currency text,
  unit_amount_minor bigint,
  success_url text,
  cancel_url text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['click_id', 'offer_key', 'idempotency_key'];
  click_public_id text;
  offer_key_value text;
  idempotency_key_value text;
  click_record public.clicks%rowtype;
  acquisition_record public.acquisitions%rowtype;
  offer_record public.billing_offers%rowtype;
  attempt_record public.checkout_attempts%rowtype;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'checkout input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) as input_key
    where input_key <> all(allowed_keys)
  ) then
    raise exception 'checkout input contains unsupported fields' using errcode = '22023';
  end if;
  if not (p_input ?& allowed_keys)
     or jsonb_typeof(p_input -> 'click_id') <> 'string'
     or jsonb_typeof(p_input -> 'offer_key') <> 'string'
     or jsonb_typeof(p_input -> 'idempotency_key') <> 'string' then
    raise exception 'click_id, offer_key, and idempotency_key are required strings'
      using errcode = '22023';
  end if;

  click_public_id := trim(p_input ->> 'click_id');
  offer_key_value := lower(trim(p_input ->> 'offer_key'));
  idempotency_key_value := trim(p_input ->> 'idempotency_key');
  if click_public_id !~ '^[A-Za-z0-9_-]{16,128}$'
     or offer_key_value !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or idempotency_key_value !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception 'checkout identifiers are invalid' using errcode = '22023';
  end if;

  select click.* into click_record
  from public.clicks as click
  join public.products as product
    on product.id = click.product_id and product.status = 'active'
  where click.public_click_id = click_public_id
    and not click.is_bot
  for share of click;

  if click_record.id is null then
    raise exception 'checkout context is unavailable' using errcode = 'P0002';
  end if;

  select acquisition.* into acquisition_record
  from public.acquisitions as acquisition
  where acquisition.click_record_id = click_record.id
    and acquisition.status <> 'rejected'
  for share of acquisition;

  if acquisition_record.id is null then
    raise exception 'checkout context is unavailable' using errcode = 'P0002';
  end if;

  select offer.* into offer_record
  from public.billing_offers as offer
  where offer.product_id = click_record.product_id
    and offer.key = offer_key_value
    and offer.status = 'active'
    and offer.billing_mode = 'subscription'
  for share of offer;

  if offer_record.id is null then
    raise exception 'billing offer is unavailable' using errcode = 'P0002';
  end if;

  insert into public.checkout_attempts (
    idempotency_key,
    billing_offer_id,
    product_id,
    acquisition_id,
    click_record_id,
    affiliate_id,
    billing_mode,
    stripe_price_id,
    currency,
    unit_amount_minor,
    success_url_snapshot,
    cancel_url_snapshot
  ) values (
    idempotency_key_value,
    offer_record.id,
    offer_record.product_id,
    acquisition_record.id,
    click_record.id,
    acquisition_record.affiliate_id,
    offer_record.billing_mode,
    offer_record.stripe_price_id,
    offer_record.currency,
    offer_record.unit_amount_minor,
    offer_record.success_url_template,
    offer_record.cancel_url
  )
  on conflict (idempotency_key) do nothing;

  select * into attempt_record
  from public.checkout_attempts as attempt
  where attempt.idempotency_key = idempotency_key_value;

  if attempt_record.id is null then
    raise exception 'checkout attempt could not be prepared' using errcode = 'P0001';
  end if;
  if attempt_record.click_record_id <> click_record.id
     or attempt_record.billing_offer_id <> offer_record.id then
    raise exception 'checkout idempotency key has already been used for different input'
      using errcode = '23505';
  end if;
  if attempt_record.status not in ('prepared', 'open') then
    raise exception 'checkout attempt is unavailable' using errcode = 'P0002';
  end if;

  return query select
    attempt_record.id,
    attempt_record.public_attempt_id,
    attempt_record.billing_offer_id,
    attempt_record.product_id,
    attempt_record.acquisition_id,
    attempt_record.click_record_id,
    attempt_record.affiliate_id,
    attempt_record.billing_mode,
    attempt_record.stripe_price_id,
    attempt_record.currency,
    attempt_record.unit_amount_minor,
    attempt_record.success_url_snapshot,
    attempt_record.cancel_url_snapshot;
end;
$$;

