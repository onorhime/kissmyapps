-- Atomic normalization of live, signature-verified Stripe callbacks.
--
-- The Edge worker may retrieve live Stripe objects to expand immutable evidence,
-- but this boundary never trusts attribution, products, amounts, or currency from
-- the caller. Those dimensions are reconciled against the durable Checkout
-- attempt and the signed provider event before canonical facts are committed.

create table public.stripe_customer_accounts (
  stripe_customer_id text primary key check (
    stripe_customer_id ~ '^cus_[A-Za-z0-9_]{8,128}$'
  ),
  account_id uuid not null unique references public.accounts (id),
  created_at timestamptz not null default now()
);

create table public.stripe_subscription_evidence (
  subscription_id uuid primary key references public.subscriptions (id),
  checkout_attempt_id uuid not null unique references public.checkout_attempts (id),
  last_event_created_at timestamptz not null,
  last_provider_event_id uuid not null references public.provider_events (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stripe_transaction_evidence (
  transaction_id uuid primary key references public.transactions (id),
  checkout_attempt_id uuid not null references public.checkout_attempts (id),
  stripe_payment_intent_id text unique check (
    stripe_payment_intent_id is null
    or stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]{8,160}$'
  ),
  stripe_charge_id text not null unique check (
    stripe_charge_id ~ '^ch_[A-Za-z0-9_]{8,160}$'
  ),
  created_at timestamptz not null default now()
);

create index stripe_transaction_evidence_checkout_idx
  on public.stripe_transaction_evidence (checkout_attempt_id);

create or replace function public.stripe_json_has_exact_keys(
  p_value jsonb,
  p_allowed text[],
  p_required text[]
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    jsonb_typeof(p_value) = 'object'
    and not exists (
      select 1
      from jsonb_object_keys(p_value) as candidate(key)
      where candidate.key <> all(p_allowed)
    )
    and p_value ?& p_required;
$$;

create or replace function public.stripe_epoch_timestamp(p_value jsonb)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
declare
  epoch_value bigint;
begin
  if p_value is null
     or jsonb_typeof(p_value) <> 'number'
     or p_value::text !~ '^[0-9]{1,12}$' then
    raise exception 'Stripe timestamp evidence is invalid' using errcode = '22023';
  end if;
  epoch_value := (p_value::text)::bigint;
  if epoch_value < 946684800 or epoch_value > 4102444800 then
    raise exception 'Stripe timestamp evidence is outside supported bounds'
      using errcode = '22023';
  end if;
  return to_timestamp(epoch_value::double precision);
end;
$$;

create or replace function public.ensure_stripe_customer_account(p_customer_id text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  customer_id_value text := trim(coalesce(p_customer_id, ''));
  account_id_value uuid;
  mapped_account_id uuid;
begin
  if customer_id_value !~ '^cus_[A-Za-z0-9_]{8,128}$' then
    raise exception 'Stripe customer evidence is invalid' using errcode = '22023';
  end if;

  select mapping.account_id into account_id_value
  from public.stripe_customer_accounts as mapping
  where mapping.stripe_customer_id = customer_id_value
  for update;

  if account_id_value is not null then
    return account_id_value;
  end if;

  insert into public.accounts (external_key)
  values ('stripe:' || customer_id_value)
  on conflict (external_key) do nothing;

  select account.id into account_id_value
  from public.accounts as account
  where account.external_key = 'stripe:' || customer_id_value
  for update;

  if account_id_value is null then
    raise exception 'Stripe customer account could not be established'
      using errcode = 'P0001';
  end if;

  insert into public.stripe_customer_accounts (stripe_customer_id, account_id)
  values (customer_id_value, account_id_value)
  on conflict (stripe_customer_id) do nothing;

  select mapping.account_id into mapped_account_id
  from public.stripe_customer_accounts as mapping
  where mapping.stripe_customer_id = customer_id_value
  for update;

  if mapped_account_id is distinct from account_id_value then
    raise exception 'Stripe customer is already bound to a different account'
      using errcode = '23505';
  end if;
  return account_id_value;
end;
$$;

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

  account_id_value := public.ensure_stripe_customer_account(p_customer_id);

  select * into acquisition_record
  from public.acquisitions as acquisition
  where acquisition.id = attempt_record.acquisition_id
  for update;

  if acquisition_record.id is null or acquisition_record.status = 'rejected' then
    raise exception 'Stripe checkout acquisition is unavailable' using errcode = 'P0002';
  end if;
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

create or replace function public.upsert_stripe_subscription(
  p_attempt_id uuid,
  p_account_id uuid,
  p_provider_event_id uuid,
  p_event_created_at timestamptz,
  p_customer_id text,
  p_subscription_id text,
  p_status public.subscription_status,
  p_currency text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cancelled_at timestamptz
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  attempt_record public.checkout_attempts%rowtype;
  subscription_record public.subscriptions%rowtype;
  evidence_record public.stripe_subscription_evidence%rowtype;
begin
  select * into attempt_record
  from public.checkout_attempts as attempt
  where attempt.id = p_attempt_id
  for share;

  if attempt_record.id is null
     or attempt_record.billing_mode <> 'subscription'
     or attempt_record.currency <> upper(p_currency)
     or attempt_record.acquisition_id is null then
    raise exception 'Stripe subscription does not match a subscription checkout attempt'
      using errcode = '23514';
  end if;
  if p_subscription_id !~ '^sub_[A-Za-z0-9_]{8,160}$'
     or p_customer_id !~ '^cus_[A-Za-z0-9_]{8,128}$'
     or p_period_start is null
     or p_period_end is null
     or p_period_end <= p_period_start then
    raise exception 'Stripe subscription evidence is invalid' using errcode = '22023';
  end if;

  select * into subscription_record
  from public.subscriptions as subscription
  where subscription.stripe_subscription_id = p_subscription_id
  for update;

  if subscription_record.id is null then
    insert into public.subscriptions (
      account_id,
      product_id,
      acquisition_id,
      stripe_customer_id,
      stripe_subscription_id,
      status,
      currency,
      current_period_starts_at,
      current_period_ends_at,
      cancelled_at
    ) values (
      p_account_id,
      attempt_record.product_id,
      attempt_record.acquisition_id,
      p_customer_id,
      p_subscription_id,
      p_status,
      upper(p_currency),
      p_period_start,
      p_period_end,
      p_cancelled_at
    )
    returning * into subscription_record;
  elsif subscription_record.account_id <> p_account_id
     or subscription_record.product_id <> attempt_record.product_id
     or subscription_record.acquisition_id is distinct from attempt_record.acquisition_id
     or subscription_record.stripe_customer_id <> p_customer_id
     or subscription_record.currency <> upper(p_currency) then
    raise exception 'Stripe subscription conflicts with canonical identity'
      using errcode = '23514';
  end if;

  insert into public.stripe_subscription_evidence (
    subscription_id,
    checkout_attempt_id,
    last_event_created_at,
    last_provider_event_id
  ) values (
    subscription_record.id,
    attempt_record.id,
    p_event_created_at,
    p_provider_event_id
  )
  on conflict (subscription_id) do nothing;

  select * into evidence_record
  from public.stripe_subscription_evidence as evidence
  where evidence.subscription_id = subscription_record.id
  for update;

  if evidence_record.checkout_attempt_id <> attempt_record.id then
    raise exception 'Stripe subscription is already bound to another checkout attempt'
      using errcode = '23505';
  end if;

  if p_event_created_at = evidence_record.last_event_created_at
     and p_provider_event_id <> evidence_record.last_provider_event_id
     and (
       subscription_record.status <> p_status
       or subscription_record.current_period_starts_at is distinct from p_period_start
       or subscription_record.current_period_ends_at is distinct from p_period_end
       or subscription_record.cancelled_at is distinct from p_cancelled_at
     ) then
    raise exception 'Stripe subscription events share a timestamp but conflict in state'
      using errcode = '23514';
  end if;

  if p_event_created_at > evidence_record.last_event_created_at then
    update public.subscriptions as subscription
    set
      status = p_status,
      current_period_starts_at = p_period_start,
      current_period_ends_at = p_period_end,
      cancelled_at = p_cancelled_at,
      updated_at = now()
    where subscription.id = subscription_record.id;

    update public.stripe_subscription_evidence as evidence
    set
      last_event_created_at = p_event_created_at,
      last_provider_event_id = p_provider_event_id,
      updated_at = now()
    where evidence.subscription_id = subscription_record.id;
  end if;

  return subscription_record.id;
end;
$$;

create or replace function public.insert_stripe_event_fact(
  p_provider_event_id uuid,
  p_source_event_id text,
  p_event_name text,
  p_acquisition_id uuid,
  p_account_id uuid,
  p_commercial_eligible boolean,
  p_properties jsonb,
  p_occurred_at timestamptz
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  acquisition_record public.acquisitions%rowtype;
  event_id_value uuid;
begin
  select * into acquisition_record
  from public.acquisitions as acquisition
  where acquisition.id = p_acquisition_id;

  if acquisition_record.id is null
     or acquisition_record.account_id is distinct from p_account_id then
    raise exception 'Stripe event attribution is unavailable' using errcode = 'P0002';
  end if;

  insert into public.events (
    source,
    source_event_id,
    schema_version,
    event_name,
    product_id,
    affiliate_id,
    acquisition_id,
    account_id,
    source_id,
    campaign_id,
    funnel_id,
    provider_event_id,
    properties,
    occurred_at,
    trust,
    commercial_eligible
  ) values (
    'stripe',
    p_source_event_id,
    1,
    p_event_name,
    acquisition_record.product_id,
    acquisition_record.affiliate_id,
    acquisition_record.id,
    p_account_id,
    acquisition_record.source_id,
    acquisition_record.campaign_id,
    acquisition_record.funnel_id,
    p_provider_event_id,
    coalesce(p_properties, '{}'::jsonb),
    p_occurred_at,
    'provider',
    p_commercial_eligible
  )
  on conflict (source, source_event_id) do nothing
  returning id into event_id_value;

  if event_id_value is null then
    select event.id into event_id_value
    from public.events as event
    where event.source = 'stripe'
      and event.source_event_id = p_source_event_id
      and event.event_name = p_event_name
      and event.product_id = acquisition_record.product_id
      and event.affiliate_id is not distinct from acquisition_record.affiliate_id
      and event.acquisition_id = acquisition_record.id
      and event.account_id = p_account_id;
  end if;
  if event_id_value is null then
    raise exception 'Stripe event fact conflicts with existing canonical evidence'
      using errcode = '23505';
  end if;
  return event_id_value;
end;
$$;

create or replace function public.normalize_stripe_provider_event(
  p_provider_event_id uuid,
  p_claim_token uuid,
  p_input jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  provider_record public.provider_events%rowtype;
  processing_record public.provider_event_processing%rowtype;
  provider_object jsonb;
  input_kind text;
  object_id_value text;
  event_occurred_at timestamptz;
  attempt_id_value uuid;
  attempt_record public.checkout_attempts%rowtype;
  account_id_value uuid;
  acquisition_id_value uuid;
  product_id_value uuid;
  affiliate_id_value uuid;
  source_id_value uuid;
  campaign_id_value uuid;
  funnel_id_value uuid;
  subscription_id_value uuid;
  canonical_event_id uuid;
  transaction_id_value uuid;
  subscription_record public.subscriptions%rowtype;
  subscription_evidence public.stripe_subscription_evidence%rowtype;
  transaction_record public.transactions%rowtype;
  transaction_evidence public.stripe_transaction_evidence%rowtype;
  stripe_customer_id_value text;
  stripe_subscription_id_value text;
  stripe_payment_intent_id_value text;
  stripe_charge_id_value text;
  stripe_balance_transaction_id_value text;
  subscription_status_value public.subscription_status;
  currency_value text;
  settlement_currency_value text;
  period_start_value timestamptz;
  period_end_value timestamptz;
  cancelled_at_value timestamptz;
  gross_minor_value bigint;
  fee_minor_value bigint;
  tax_minor_value bigint;
  balance_amount_value bigint;
  balance_net_value bigint;
  invoice_total_value bigint;
  invoice_total_excluding_tax_value bigint;
  billing_reason_value text;
  paid_at_value timestamptz;
  transaction_kind_value text;
  refund_id_value uuid;
  dispute_id_value uuid;
  dispute_status_value text;
  dispute_amount_value bigint;
  dispute_fee_value bigint := 0;
  dispute_impact_value bigint := 0;
  negative_amount_value bigint := 0;
  negative_fee_value bigint := 0;
  negative_net_value bigint := 0;
  positive_net_value bigint := 0;
  invalid_balance_count bigint := 0;
  changed integer;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or jsonb_typeof(p_input -> 'kind') <> 'string'
     or jsonb_typeof(p_input -> 'object_id') <> 'string' then
    raise exception 'Stripe normalization input is invalid' using errcode = '22023';
  end if;

  select * into processing_record
  from public.provider_event_processing as processing
  where processing.provider_event_id = p_provider_event_id
  for update;

  if processing_record.provider_event_id is null
     or processing_record.status <> 'processing'
     or processing_record.claim_token is distinct from p_claim_token
     or processing_record.lease_expires_at <= now() then
    raise exception 'Stripe provider event claim is unavailable' using errcode = 'P0002';
  end if;

  select * into provider_record
  from public.provider_events as event
  where event.id = p_provider_event_id
  for share;

  if provider_record.id is null
     or provider_record.provider <> 'stripe'
     or not provider_record.signature_verified
     or not provider_record.livemode then
    raise exception 'Stripe provider evidence is unavailable' using errcode = 'P0002';
  end if;

  provider_object := provider_record.payload #> '{data,object}';
  if jsonb_typeof(provider_object) <> 'object'
     or provider_record.payload ->> 'id' <> provider_record.provider_event_id
     or provider_record.payload ->> 'type' <> provider_record.event_type
     or provider_record.payload -> 'livemode' is distinct from 'true'::jsonb then
    raise exception 'Stripe signed envelope is internally inconsistent'
      using errcode = '23514';
  end if;

  input_kind := p_input ->> 'kind';
  object_id_value := trim(p_input ->> 'object_id');
  if object_id_value is distinct from provider_object ->> 'id' then
    raise exception 'Stripe object identity does not match the signed event'
      using errcode = '23514';
  end if;
  event_occurred_at := public.stripe_epoch_timestamp(provider_record.payload -> 'created');

  if input_kind = 'checkout_subscription_paid' then
    if not public.stripe_json_has_exact_keys(
      p_input,
      array[
        'kind', 'object_id', 'subscription_id', 'subscription_customer_id',
        'subscription_attempt_id', 'subscription_status', 'subscription_currency',
        'period_start', 'period_end', 'cancelled_at', 'subscription_livemode'
      ],
      array[
        'kind', 'object_id', 'subscription_id', 'subscription_customer_id',
        'subscription_attempt_id', 'subscription_status', 'subscription_currency',
        'period_start', 'period_end', 'cancelled_at', 'subscription_livemode'
      ]
    ) then
      raise exception 'Stripe Checkout normalization shape is invalid' using errcode = '22023';
    end if;
    if provider_record.event_type not in (
      'checkout.session.completed', 'checkout.session.async_payment_succeeded'
    )
       or provider_object ->> 'object' <> 'checkout.session'
       or provider_object ->> 'mode' <> 'subscription'
       or provider_object ->> 'status' <> 'complete'
       or provider_object ->> 'payment_status' <> 'paid'
       or p_input -> 'subscription_livemode' is distinct from 'true'::jsonb then
      raise exception 'Stripe Checkout is not a paid live subscription session'
        using errcode = '23514';
    end if;

    begin
      attempt_id_value := (provider_object #>> '{metadata,kma_attempt_id}')::uuid;
    exception when invalid_text_representation then
      raise exception 'Stripe Checkout attempt metadata is invalid' using errcode = '22023';
    end;
    select * into attempt_record
    from public.checkout_attempts as attempt
    where attempt.id = attempt_id_value
    for update;
    if attempt_record.id is null then
      raise exception 'Stripe Checkout attempt is unavailable' using errcode = 'P0002';
    end if;
    if jsonb_typeof(provider_object -> 'amount_total') <> 'number'
       or (provider_object ->> 'amount_total') !~ '^[0-9]+$'
       or provider_object ->> 'id' <> attempt_record.stripe_checkout_session_id
       or provider_object ->> 'client_reference_id' <> attempt_record.public_attempt_id
       or provider_object #>> '{metadata,kma_public_attempt_id}' <> attempt_record.public_attempt_id
       or provider_object #>> '{metadata,kma_offer_id}' <> attempt_record.billing_offer_id::text
       or provider_object #>> '{metadata,kma_product_id}' <> attempt_record.product_id::text
       or provider_object #>> '{metadata,kma_acquisition_id}' <> attempt_record.acquisition_id::text
       or provider_object #>> '{metadata,kma_click_id}' <> attempt_record.click_record_id::text
       or provider_object #>> '{metadata,kma_expected_amount_minor}' <> attempt_record.unit_amount_minor::text
       or upper(provider_object ->> 'currency') <> attempt_record.currency
       or (provider_object ->> 'amount_total')::bigint <> attempt_record.unit_amount_minor then
      raise exception 'Stripe Checkout metadata conflicts with canonical attribution or price'
        using errcode = '23514';
    end if;

    stripe_customer_id_value := trim(p_input ->> 'subscription_customer_id');
    stripe_subscription_id_value := trim(p_input ->> 'subscription_id');
    if provider_object ->> 'customer' <> stripe_customer_id_value
       or provider_object ->> 'subscription' <> stripe_subscription_id_value
       or p_input ->> 'subscription_attempt_id' <> attempt_record.id::text then
      raise exception 'Stripe subscription retrieval conflicts with the signed Checkout session'
        using errcode = '23514';
    end if;

    begin
      subscription_status_value := case p_input ->> 'subscription_status'
        when 'incomplete' then 'incomplete'::public.subscription_status
        when 'trialing' then 'trialing'::public.subscription_status
        when 'active' then 'active'::public.subscription_status
        when 'past_due' then 'past_due'::public.subscription_status
        when 'canceled' then 'cancelled'::public.subscription_status
        when 'unpaid' then 'unpaid'::public.subscription_status
        else null
      end;
      currency_value := upper(p_input ->> 'subscription_currency');
      period_start_value := public.stripe_epoch_timestamp(p_input -> 'period_start');
      period_end_value := public.stripe_epoch_timestamp(p_input -> 'period_end');
      cancelled_at_value := case
        when p_input -> 'cancelled_at' = 'null'::jsonb then null
        else public.stripe_epoch_timestamp(p_input -> 'cancelled_at')
      end;
    exception when others then
      raise exception 'Stripe subscription state evidence is invalid' using errcode = '22023';
    end;
    if subscription_status_value is null
       or currency_value !~ '^[A-Z]{3}$'
       or currency_value <> attempt_record.currency then
      raise exception 'Stripe subscription state is unsupported or inconsistent'
        using errcode = '23514';
    end if;

    select * into account_id_value, acquisition_id_value, product_id_value,
      affiliate_id_value, source_id_value, campaign_id_value, funnel_id_value
    from public.resolve_stripe_checkout(
      attempt_record.id,
      provider_object ->> 'id',
      stripe_customer_id_value,
      (provider_object ->> 'amount_total')::bigint,
      provider_object ->> 'currency'
    );

    subscription_id_value := public.upsert_stripe_subscription(
      attempt_record.id,
      account_id_value,
      provider_record.id,
      event_occurred_at,
      stripe_customer_id_value,
      stripe_subscription_id_value,
      subscription_status_value,
      currency_value,
      period_start_value,
      period_end_value,
      cancelled_at_value
    );

    canonical_event_id := public.insert_stripe_event_fact(
      provider_record.id,
      provider_record.provider_event_id,
      'checkout.completed',
      acquisition_id_value,
      account_id_value,
      false,
      jsonb_build_object(
        'checkout_session_id', provider_object ->> 'id',
        'subscription_id', stripe_subscription_id_value,
        'amount_minor', attempt_record.unit_amount_minor,
        'currency', attempt_record.currency
      ),
      event_occurred_at
    );

  elsif input_kind = 'subscription_changed' then
    if not public.stripe_json_has_exact_keys(
      p_input,
      array['kind', 'object_id'],
      array['kind', 'object_id']
    ) then
      raise exception 'Stripe subscription normalization shape is invalid' using errcode = '22023';
    end if;
    if provider_record.event_type not in (
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted'
    ) or provider_object ->> 'object' <> 'subscription'
      or provider_object -> 'livemode' is distinct from 'true'::jsonb then
      raise exception 'Stripe subscription callback is unsupported' using errcode = '23514';
    end if;

    stripe_subscription_id_value := provider_object ->> 'id';
    select subscription.* into subscription_record
    from public.subscriptions as subscription
    where subscription.stripe_subscription_id = stripe_subscription_id_value
    for update;

    select evidence.* into subscription_evidence
    from public.stripe_subscription_evidence as evidence
    where evidence.subscription_id = subscription_record.id
    for update;

    if subscription_record.id is null then
      raise exception 'Stripe subscription checkout evidence is not available yet'
        using errcode = 'P0002';
    end if;
    if provider_object ->> 'customer' <> subscription_record.stripe_customer_id
       or upper(provider_object ->> 'currency') <> subscription_record.currency then
      raise exception 'Stripe subscription callback conflicts with canonical identity'
        using errcode = '23514';
    end if;

    subscription_status_value := case provider_object ->> 'status'
      when 'incomplete' then 'incomplete'::public.subscription_status
      when 'trialing' then 'trialing'::public.subscription_status
      when 'active' then 'active'::public.subscription_status
      when 'past_due' then 'past_due'::public.subscription_status
      when 'canceled' then 'cancelled'::public.subscription_status
      when 'unpaid' then 'unpaid'::public.subscription_status
      else null
    end;
    if subscription_status_value is null then
      raise exception 'Stripe subscription status is unsupported' using errcode = '0A000';
    end if;
    period_start_value := public.stripe_epoch_timestamp(provider_object -> 'current_period_start');
    period_end_value := public.stripe_epoch_timestamp(provider_object -> 'current_period_end');
    cancelled_at_value := case
      when provider_object -> 'canceled_at' is null
        or provider_object -> 'canceled_at' = 'null'::jsonb then null
      else public.stripe_epoch_timestamp(provider_object -> 'canceled_at')
    end;

    subscription_id_value := public.upsert_stripe_subscription(
      subscription_evidence.checkout_attempt_id,
      subscription_record.account_id,
      provider_record.id,
      event_occurred_at,
      subscription_record.stripe_customer_id,
      stripe_subscription_id_value,
      subscription_status_value,
      subscription_record.currency,
      period_start_value,
      period_end_value,
      cancelled_at_value
    );

    canonical_event_id := public.insert_stripe_event_fact(
      provider_record.id,
      provider_record.provider_event_id,
      case subscription_status_value
        when 'cancelled' then 'subscription.cancelled'
        when 'past_due' then 'subscription.past_due'
        when 'unpaid' then 'subscription.unpaid'
        when 'trialing' then 'subscription.trialing'
        when 'active' then 'subscription.active'
        else 'subscription.incomplete'
      end,
      subscription_record.acquisition_id,
      subscription_record.account_id,
      false,
      jsonb_build_object(
        'subscription_id', stripe_subscription_id_value,
        'status', subscription_status_value::text,
        'currency', subscription_record.currency
      ),
      event_occurred_at
    );

  elsif input_kind = 'invoice_paid' then
    if not public.stripe_json_has_exact_keys(
      p_input,
      array[
        'kind', 'object_id', 'subscription_id', 'customer_id',
        'payment_intent_id', 'charge_id', 'balance_transaction_id',
        'charge_amount_minor', 'charge_currency', 'charge_paid', 'charge_livemode',
        'payment_intent_status', 'payment_intent_livemode',
        'balance_amount_minor', 'balance_fee_minor', 'balance_net_minor',
        'balance_currency'
      ],
      array[
        'kind', 'object_id', 'subscription_id', 'customer_id',
        'payment_intent_id', 'charge_id', 'balance_transaction_id',
        'charge_amount_minor', 'charge_currency', 'charge_paid', 'charge_livemode',
        'payment_intent_status', 'payment_intent_livemode',
        'balance_amount_minor', 'balance_fee_minor', 'balance_net_minor',
        'balance_currency'
      ]
    ) then
      raise exception 'Stripe invoice normalization shape is invalid' using errcode = '22023';
    end if;
    if provider_record.event_type <> 'invoice.paid'
       or provider_object ->> 'object' <> 'invoice'
       or provider_object ->> 'status' <> 'paid'
       or provider_object -> 'paid' is distinct from 'true'::jsonb
       or p_input -> 'charge_paid' is distinct from 'true'::jsonb
       or p_input -> 'charge_livemode' is distinct from 'true'::jsonb
       or p_input ->> 'payment_intent_status' <> 'succeeded'
       or p_input -> 'payment_intent_livemode' is distinct from 'true'::jsonb then
      raise exception 'Stripe invoice is not backed by a completed live payment'
        using errcode = '23514';
    end if;

    stripe_subscription_id_value := coalesce(
      nullif(provider_object ->> 'subscription', ''),
      nullif(provider_object #>> '{parent,subscription_details,subscription}', '')
    );
    stripe_customer_id_value := trim(p_input ->> 'customer_id');
    if stripe_subscription_id_value is null
       or p_input ->> 'subscription_id' <> stripe_subscription_id_value
       or provider_object ->> 'customer' <> stripe_customer_id_value then
      raise exception 'Stripe invoice subscription identity is unavailable'
        using errcode = '23514';
    end if;

    select subscription.* into subscription_record
    from public.subscriptions as subscription
    where subscription.stripe_subscription_id = stripe_subscription_id_value
    for update;

    select evidence.* into subscription_evidence
    from public.stripe_subscription_evidence as evidence
    where evidence.subscription_id = subscription_record.id
    for update;

    if subscription_record.id is null then
      raise exception 'Stripe invoice arrived before its subscription checkout evidence'
        using errcode = 'P0002';
    end if;
    if subscription_record.stripe_customer_id <> stripe_customer_id_value then
      raise exception 'Stripe invoice customer conflicts with the canonical subscription'
        using errcode = '23514';
    end if;

    if jsonb_typeof(provider_object -> 'amount_paid') <> 'number'
       or jsonb_typeof(provider_object -> 'total') <> 'number'
       or jsonb_typeof(provider_object -> 'total_excluding_tax') <> 'number'
       or (provider_object ->> 'amount_paid') !~ '^[0-9]+$'
       or (provider_object ->> 'total') !~ '^[0-9]+$'
       or (provider_object ->> 'total_excluding_tax') !~ '^[0-9]+$' then
      raise exception 'Stripe invoice amount or tax evidence is incomplete'
        using errcode = '22023';
    end if;
    gross_minor_value := (provider_object ->> 'amount_paid')::bigint;
    invoice_total_value := (provider_object ->> 'total')::bigint;
    invoice_total_excluding_tax_value := (provider_object ->> 'total_excluding_tax')::bigint;
    tax_minor_value := invoice_total_value - invoice_total_excluding_tax_value;
    currency_value := upper(provider_object ->> 'currency');
    billing_reason_value := provider_object ->> 'billing_reason';
    paid_at_value := public.stripe_epoch_timestamp(provider_object #> '{status_transitions,paid_at}');
    if gross_minor_value <= 0
       or gross_minor_value <> invoice_total_value
       or tax_minor_value < 0
       or currency_value <> subscription_record.currency then
      raise exception 'Stripe invoice amount, tax, or currency is unsupported'
        using errcode = '23514';
    end if;
    transaction_kind_value := case billing_reason_value
      when 'subscription_create' then 'first_purchase'
      when 'subscription_cycle' then 'renewal'
      else null
    end;
    if transaction_kind_value is null then
      raise exception 'Stripe invoice billing reason is unsupported' using errcode = '0A000';
    end if;

    stripe_payment_intent_id_value := nullif(trim(p_input ->> 'payment_intent_id'), '');
    stripe_charge_id_value := trim(p_input ->> 'charge_id');
    stripe_balance_transaction_id_value := trim(p_input ->> 'balance_transaction_id');
    if stripe_payment_intent_id_value !~ '^pi_[A-Za-z0-9_]{8,160}$'
       or stripe_charge_id_value !~ '^ch_[A-Za-z0-9_]{8,160}$'
       or stripe_balance_transaction_id_value !~ '^txn_[A-Za-z0-9_]{8,160}$'
       or jsonb_typeof(p_input -> 'charge_amount_minor') <> 'number'
       or jsonb_typeof(p_input -> 'balance_amount_minor') <> 'number'
       or jsonb_typeof(p_input -> 'balance_fee_minor') <> 'number'
       or jsonb_typeof(p_input -> 'balance_net_minor') <> 'number' then
      raise exception 'Stripe payment settlement identifiers or values are invalid'
        using errcode = '22023';
    end if;
    balance_amount_value := (p_input ->> 'balance_amount_minor')::bigint;
    fee_minor_value := (p_input ->> 'balance_fee_minor')::bigint;
    balance_net_value := (p_input ->> 'balance_net_minor')::bigint;
    settlement_currency_value := upper(p_input ->> 'balance_currency');
    if (p_input ->> 'charge_amount_minor')::bigint <> gross_minor_value
       or upper(p_input ->> 'charge_currency') <> currency_value
       or balance_amount_value <> gross_minor_value
       or fee_minor_value < 0
       or balance_net_value <> balance_amount_value - fee_minor_value
       or settlement_currency_value <> currency_value then
      raise exception 'Stripe charge and settlement do not exactly reconcile to the invoice'
        using errcode = '23514';
    end if;

    select * into transaction_record
    from public.transactions as transaction
    where transaction.stripe_invoice_id = object_id_value
    for update;

    if transaction_record.id is null then
      insert into public.transactions (
        subscription_id,
        acquisition_id,
        provider_event_id,
        stripe_invoice_id,
        balance_transaction_id,
        kind,
        gross_minor,
        fee_minor,
        tax_minor,
        settlement_adjustment_minor,
        eligible_net_minor,
        currency,
        settled_currency,
        occurred_at
      ) values (
        subscription_record.id,
        subscription_record.acquisition_id,
        provider_record.id,
        object_id_value,
        stripe_balance_transaction_id_value,
        transaction_kind_value,
        gross_minor_value,
        fee_minor_value,
        tax_minor_value,
        0,
        gross_minor_value - fee_minor_value - tax_minor_value,
        currency_value,
        settlement_currency_value,
        paid_at_value
      ) returning * into transaction_record;

      insert into public.stripe_transaction_evidence (
        transaction_id,
        checkout_attempt_id,
        stripe_payment_intent_id,
        stripe_charge_id
      ) values (
        transaction_record.id,
        subscription_evidence.checkout_attempt_id,
        stripe_payment_intent_id_value,
        stripe_charge_id_value
      );
    else
      select * into transaction_evidence
      from public.stripe_transaction_evidence as evidence
      where evidence.transaction_id = transaction_record.id;
      if transaction_record.subscription_id <> subscription_record.id
         or transaction_record.acquisition_id is distinct from subscription_record.acquisition_id
         or transaction_record.balance_transaction_id is distinct from stripe_balance_transaction_id_value
         or transaction_record.kind <> transaction_kind_value
         or transaction_record.gross_minor <> gross_minor_value
         or transaction_record.fee_minor <> fee_minor_value
         or transaction_record.tax_minor <> tax_minor_value
         or transaction_record.currency <> currency_value
         or transaction_record.settled_currency <> settlement_currency_value
         or transaction_evidence.checkout_attempt_id is distinct from subscription_evidence.checkout_attempt_id
         or transaction_evidence.stripe_payment_intent_id is distinct from stripe_payment_intent_id_value
         or transaction_evidence.stripe_charge_id is distinct from stripe_charge_id_value then
        raise exception 'Stripe invoice conflicts with an existing canonical transaction'
          using errcode = '23505';
      end if;
    end if;
    transaction_id_value := transaction_record.id;

    canonical_event_id := public.insert_stripe_event_fact(
      provider_record.id,
      'invoice:' || object_id_value || ':paid',
      'purchase.completed',
      subscription_record.acquisition_id,
      subscription_record.account_id,
      true,
      jsonb_build_object(
        'invoice_id', object_id_value,
        'transaction_id', transaction_record.id,
        'kind', transaction_kind_value,
        'gross_minor', gross_minor_value,
        'fee_minor', fee_minor_value,
        'tax_minor', tax_minor_value,
        'eligible_net_minor', transaction_record.eligible_net_minor,
        'currency', currency_value
      ),
      paid_at_value
    );

  elsif input_kind = 'refund_succeeded' then
    if not public.stripe_json_has_exact_keys(
      p_input,
      array['kind', 'object_id'],
      array['kind', 'object_id']
    ) then
      raise exception 'Stripe refund normalization shape is invalid' using errcode = '22023';
    end if;
    if provider_record.event_type not in ('refund.created', 'refund.updated')
       or provider_object ->> 'object' <> 'refund'
       or provider_object ->> 'status' <> 'succeeded' then
      raise exception 'Stripe refund callback is not a succeeded refund'
        using errcode = '23514';
    end if;
    stripe_charge_id_value := provider_object ->> 'charge';
    if stripe_charge_id_value !~ '^ch_[A-Za-z0-9_]{8,160}$'
       or (provider_object ->> 'amount') !~ '^[1-9][0-9]*$'
       or (provider_object ->> 'currency') !~ '^[a-z]{3}$' then
      raise exception 'Stripe refund evidence is incomplete' using errcode = '22023';
    end if;
    gross_minor_value := (provider_object ->> 'amount')::bigint;
    currency_value := upper(provider_object ->> 'currency');
    event_occurred_at := public.stripe_epoch_timestamp(provider_object -> 'created');

    select evidence.* into transaction_evidence
    from public.stripe_transaction_evidence as evidence
    where evidence.stripe_charge_id = stripe_charge_id_value;

    select transaction.* into transaction_record
    from public.transactions as transaction
    where transaction.id = transaction_evidence.transaction_id
    for update;

    if transaction_record.id is null then
      raise exception 'Stripe refund arrived before its canonical charge transaction'
        using errcode = 'P0002';
    end if;
    if transaction_record.currency <> currency_value then
      raise exception 'Stripe refund currency conflicts with the canonical transaction'
        using errcode = '23514';
    end if;

    select refund.id into refund_id_value
    from public.refunds as refund
    where refund.stripe_refund_id = object_id_value;

    if refund_id_value is null then
      insert into public.refunds (
        transaction_id,
        provider_event_id,
        stripe_refund_id,
        amount_minor,
        balance_impact_minor,
        currency,
        occurred_at
      ) values (
        transaction_record.id,
        provider_record.id,
        object_id_value,
        gross_minor_value,
        -gross_minor_value,
        currency_value,
        event_occurred_at
      ) returning id into refund_id_value;
    elsif not exists (
      select 1 from public.refunds as refund
      where refund.id = refund_id_value
        and refund.transaction_id = transaction_record.id
        and refund.amount_minor = gross_minor_value
        and refund.currency = currency_value
    ) then
      raise exception 'Stripe refund conflicts with an existing canonical refund'
        using errcode = '23505';
    end if;

    select * into subscription_record
    from public.subscriptions as subscription
    where subscription.id = transaction_record.subscription_id;

    canonical_event_id := public.insert_stripe_event_fact(
      provider_record.id,
      'refund:' || object_id_value || ':succeeded',
      'refund.succeeded',
      transaction_record.acquisition_id,
      subscription_record.account_id,
      true,
      jsonb_build_object(
        'refund_id', object_id_value,
        'transaction_id', transaction_record.id,
        'amount_minor', gross_minor_value,
        'currency', currency_value
      ),
      event_occurred_at
    );

  elsif input_kind = 'dispute_changed' then
    if not public.stripe_json_has_exact_keys(
      p_input,
      array['kind', 'object_id'],
      array['kind', 'object_id']
    ) then
      raise exception 'Stripe dispute normalization shape is invalid' using errcode = '22023';
    end if;
    if provider_record.event_type not in (
      'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed'
    ) or provider_object ->> 'object' <> 'dispute' then
      raise exception 'Stripe dispute callback is unsupported' using errcode = '23514';
    end if;
    stripe_charge_id_value := provider_object ->> 'charge';
    if stripe_charge_id_value !~ '^ch_[A-Za-z0-9_]{8,160}$'
       or (provider_object ->> 'amount') !~ '^[1-9][0-9]*$'
       or (provider_object ->> 'currency') !~ '^[a-z]{3}$'
       or jsonb_typeof(provider_object -> 'balance_transactions') <> 'array' then
      raise exception 'Stripe dispute evidence is incomplete' using errcode = '22023';
    end if;
    dispute_amount_value := (provider_object ->> 'amount')::bigint;
    currency_value := upper(provider_object ->> 'currency');
    event_occurred_at := public.stripe_epoch_timestamp(provider_object -> 'created');
    dispute_status_value := case provider_object ->> 'status'
      when 'needs_response' then 'open'
      when 'under_review' then 'open'
      when 'warning_needs_response' then 'open'
      when 'warning_under_review' then 'open'
      when 'won' then 'won'
      when 'lost' then 'lost'
      when 'warning_closed' then 'warning_closed'
      else null
    end;
    if dispute_status_value is null then
      raise exception 'Stripe dispute status is unsupported' using errcode = '0A000';
    end if;

    select
      count(*) filter (
        where jsonb_typeof(item.value) <> 'object'
          or (item.value ->> 'id') !~ '^txn_[A-Za-z0-9_]{8,160}$'
          or (item.value ->> 'amount') !~ '^-?[0-9]+$'
          or (item.value ->> 'fee') !~ '^[0-9]+$'
          or (item.value ->> 'net') !~ '^-?[0-9]+$'
          or (item.value ->> 'currency') !~ '^[a-z]{3}$'
          or jsonb_typeof(item.value -> 'created') <> 'number'
          or public.stripe_epoch_timestamp(item.value -> 'created') > now() + interval '5 minutes'
          or upper(item.value ->> 'currency') <> currency_value
          or (item.value ->> 'net')::bigint
            <> (item.value ->> 'amount')::bigint - (item.value ->> 'fee')::bigint
      ),
      coalesce(sum((item.value ->> 'amount')::bigint) filter (
        where (item.value ->> 'amount') ~ '^-[0-9]+$'
      ), 0),
      coalesce(sum((item.value ->> 'fee')::bigint) filter (
        where (item.value ->> 'amount') ~ '^-[0-9]+$'
      ), 0),
      coalesce(sum((item.value ->> 'net')::bigint) filter (
        where (item.value ->> 'amount') ~ '^-[0-9]+$'
      ), 0),
      coalesce(sum((item.value ->> 'net')::bigint) filter (
        where (item.value ->> 'amount') ~ '^[1-9][0-9]*$'
      ), 0)
    into invalid_balance_count, negative_amount_value, negative_fee_value,
      negative_net_value, positive_net_value
    from jsonb_array_elements(provider_object -> 'balance_transactions') as item(value);

    if invalid_balance_count > 0 then
      raise exception 'Stripe dispute balance evidence is invalid' using errcode = '22023';
    end if;
    if dispute_status_value = 'open' then
      dispute_fee_value := negative_fee_value;
      dispute_impact_value := negative_net_value;
      if negative_amount_value <> -dispute_amount_value
         or dispute_impact_value <> -(dispute_amount_value + dispute_fee_value) then
        raise exception 'Stripe dispute withdrawal does not exactly reconcile'
          using errcode = '23514';
      end if;
    elsif dispute_status_value = 'won' then
      dispute_fee_value := 0;
      dispute_impact_value := positive_net_value;
      if dispute_impact_value < 0 or dispute_impact_value > dispute_amount_value then
        raise exception 'Stripe dispute reinstatement is unsupported'
          using errcode = '23514';
      end if;
    else
      dispute_fee_value := 0;
      dispute_impact_value := 0;
    end if;

    select evidence.* into transaction_evidence
    from public.stripe_transaction_evidence as evidence
    where evidence.stripe_charge_id = stripe_charge_id_value;

    select transaction.* into transaction_record
    from public.transactions as transaction
    where transaction.id = transaction_evidence.transaction_id
    for update;
    if transaction_record.id is null then
      raise exception 'Stripe dispute arrived before its canonical charge transaction'
        using errcode = 'P0002';
    end if;
    if transaction_record.currency <> currency_value then
      raise exception 'Stripe dispute currency conflicts with the canonical transaction'
        using errcode = '23514';
    end if;

    insert into public.disputes (
      transaction_id,
      provider_event_id,
      stripe_dispute_id,
      status,
      disputed_minor,
      fee_minor,
      balance_impact_minor,
      currency,
      occurred_at
    ) values (
      transaction_record.id,
      provider_record.id,
      object_id_value,
      dispute_status_value,
      dispute_amount_value,
      dispute_fee_value,
      dispute_impact_value,
      currency_value,
      event_occurred_at
    ) returning id into dispute_id_value;

    select * into subscription_record
    from public.subscriptions as subscription
    where subscription.id = transaction_record.subscription_id;

    canonical_event_id := public.insert_stripe_event_fact(
      provider_record.id,
      provider_record.provider_event_id,
      case dispute_status_value
        when 'open' then 'dispute.opened'
        when 'won' then 'dispute.won'
        when 'lost' then 'dispute.lost'
        else 'dispute.warning_closed'
      end,
      transaction_record.acquisition_id,
      subscription_record.account_id,
      true,
      jsonb_build_object(
        'dispute_id', object_id_value,
        'transaction_id', transaction_record.id,
        'status', dispute_status_value,
        'disputed_minor', dispute_amount_value,
        'fee_minor', dispute_fee_value,
        'balance_impact_minor', dispute_impact_value,
        'currency', currency_value
      ),
      event_occurred_at
    );
  else
    raise exception 'Stripe event type is unsupported by the canonical ledger'
      using errcode = '0A000';
  end if;

  update public.provider_event_processing as processing
  set
    status = 'processed',
    processing_error = null,
    claimed_at = null,
    claimed_by = null,
    claim_token = null,
    lease_expires_at = null,
    processed_at = now(),
    updated_at = now()
  where processing.provider_event_id = p_provider_event_id
    and processing.status = 'processing'
    and processing.claim_token = p_claim_token
    and processing.lease_expires_at > now();
  get diagnostics changed = row_count;
  if changed <> 1 then
    raise exception 'Stripe provider event claim expired before commit' using errcode = 'P0002';
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'status', 'processed',
    'kind', input_kind,
    'canonical_event_id', canonical_event_id,
    'subscription_id', subscription_id_value,
    'transaction_id', transaction_id_value,
    'refund_id', refund_id_value,
    'dispute_id', dispute_id_value
  ));
end;
$$;

alter table public.stripe_customer_accounts enable row level security;
alter table public.stripe_subscription_evidence enable row level security;
alter table public.stripe_transaction_evidence enable row level security;

revoke all on public.stripe_customer_accounts,
  public.stripe_subscription_evidence,
  public.stripe_transaction_evidence
  from public, anon, authenticated, service_role;

revoke all on function public.stripe_json_has_exact_keys(jsonb, text[], text[])
  from public, anon, authenticated, service_role;
revoke all on function public.stripe_epoch_timestamp(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.ensure_stripe_customer_account(text)
  from public, anon, authenticated, service_role;
revoke all on function public.resolve_stripe_checkout(uuid, text, text, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function public.upsert_stripe_subscription(
  uuid, uuid, uuid, timestamptz, text, text, public.subscription_status,
  text, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.insert_stripe_event_fact(
  uuid, text, text, uuid, uuid, boolean, jsonb, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.normalize_stripe_provider_event(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.normalize_stripe_provider_event(uuid, uuid, jsonb)
  to service_role;

comment on table public.stripe_customer_accounts is
  'PII-free binding from an exact live Stripe Customer identifier to one canonical account.';
comment on table public.stripe_subscription_evidence is
  'Checkout attribution and monotonic Stripe event version evidence for canonical subscriptions.';
comment on table public.stripe_transaction_evidence is
  'Exact live Stripe PaymentIntent and Charge identifiers supporting a canonical invoice transaction.';
comment on function public.normalize_stripe_provider_event(uuid, uuid, jsonb) is
  'Service-only atomic normalization of a currently leased, signature-verified live Stripe event. One-time payment mode remains unsupported and fails closed.';
