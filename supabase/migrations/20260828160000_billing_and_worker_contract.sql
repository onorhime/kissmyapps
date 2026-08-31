-- Production billing hand-off and durable provider worker leases.
-- This migration deliberately creates no products, offers, checkout attempts, or provider facts.

create table public.billing_offers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id),
  key text not null check (key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  version integer not null default 1 check (version > 0),
  name text not null check (char_length(name) between 1 and 120),
  billing_mode text not null check (billing_mode in ('payment', 'subscription')),
  stripe_price_id text unique check (
    stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9_]{8,128}$'
  ),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  unit_amount_minor bigint check (
    unit_amount_minor is null or unit_amount_minor between 1 and 99999999
  ),
  success_url_template text check (
    success_url_template is null
    or (
      char_length(success_url_template) <= 2000
      and success_url_template ~ '^https://'
      and success_url_template !~ '[[:space:]]'
    )
  ),
  cancel_url text check (
    cancel_url is null
    or (
      char_length(cancel_url) <= 2000
      and cancel_url ~ '^https://'
      and cancel_url !~ '[[:space:]]'
    )
  ),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, key, version),
  constraint billing_offers_payment_mode_dormant check (
    status <> 'active' or billing_mode = 'subscription'
  ),
  check (
    status <> 'active'
    or (
      stripe_price_id is not null
      and currency is not null
      and unit_amount_minor is not null
      and success_url_template is not null
      and cancel_url is not null
      and position('{CHECKOUT_SESSION_ID}' in success_url_template) > 0
    )
  )
);

create unique index billing_offers_one_active_key
  on public.billing_offers (product_id, key)
  where status = 'active';

create table public.checkout_attempts (
  id uuid primary key default gen_random_uuid(),
  public_attempt_id text not null unique default encode(extensions.gen_random_bytes(24), 'hex')
    check (public_attempt_id ~ '^[A-Za-z0-9_-]{32,128}$'),
  idempotency_key text not null unique
    check (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  billing_offer_id uuid not null references public.billing_offers (id),
  product_id uuid not null references public.products (id),
  acquisition_id uuid not null references public.acquisitions (id),
  click_record_id uuid not null references public.clicks (id),
  affiliate_id uuid references public.affiliates (id),
  billing_mode text not null check (billing_mode in ('payment', 'subscription')),
  stripe_price_id text not null check (stripe_price_id ~ '^price_[A-Za-z0-9_]{8,128}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  unit_amount_minor bigint not null check (unit_amount_minor between 1 and 99999999),
  success_url_snapshot text not null check (
    char_length(success_url_snapshot) <= 2000
    and success_url_snapshot ~ '^https://'
    and success_url_snapshot !~ '[[:space:]]'
    and position('{CHECKOUT_SESSION_ID}' in success_url_snapshot) > 0
  ),
  cancel_url_snapshot text not null check (
    char_length(cancel_url_snapshot) <= 2000
    and cancel_url_snapshot ~ '^https://'
    and cancel_url_snapshot !~ '[[:space:]]'
  ),
  status text not null default 'prepared'
    check (status in ('prepared', 'open', 'completed', 'expired', 'failed')),
  stripe_checkout_session_id text unique check (
    stripe_checkout_session_id is null
    or stripe_checkout_session_id ~ '^cs_live_[A-Za-z0-9_]{8,160}$'
  ),
  checkout_url text check (
    checkout_url is null
    or (
      char_length(checkout_url) <= 4000
      and checkout_url ~ '^https://checkout[.]stripe[.]com/'
      and checkout_url !~ '[[:space:]]'
    )
  ),
  stripe_session_expires_at timestamptz,
  failure_code text check (
    failure_code is null or failure_code ~ '^[a-z][a-z0-9_.-]{0,99}$'
  ),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'prepared'
      and stripe_checkout_session_id is null
      and checkout_url is null
      and stripe_session_expires_at is null
      and failure_code is null
      and completed_at is null)
    or (status = 'open'
      and stripe_checkout_session_id is not null
      and checkout_url is not null
      and stripe_session_expires_at is not null
      and failure_code is null
      and completed_at is null)
    or (status = 'completed'
      and stripe_checkout_session_id is not null
      and checkout_url is not null
      and stripe_session_expires_at is not null
      and failure_code is null
      and completed_at is not null)
    or (status = 'expired'
      and stripe_checkout_session_id is not null
      and checkout_url is not null
      and stripe_session_expires_at is not null
      and failure_code is null
      and completed_at is null)
    or (status = 'failed'
      and stripe_checkout_session_id is null
      and checkout_url is null
      and stripe_session_expires_at is null
      and failure_code is not null
      and completed_at is null)
  )
);

create index checkout_attempts_acquisition_created_idx
  on public.checkout_attempts (acquisition_id, created_at desc);
create index checkout_attempts_open_expiry_idx
  on public.checkout_attempts (stripe_session_expires_at)
  where status = 'open';

alter table public.provider_events
  add column livemode boolean generated always as (
    payload @> '{"livemode": true}'::jsonb
  ) stored;

alter table public.provider_event_processing
  add column claimed_by text,
  add column claim_token uuid,
  add column lease_expires_at timestamptz,
  add column next_attempt_at timestamptz not null default now();

alter table public.provider_event_processing
  add constraint provider_event_processing_claim_fields check (
    (status = 'processing'
      and claimed_by is not null
      and claim_token is not null
      and claimed_at is not null
      and lease_expires_at is not null
      and lease_expires_at > claimed_at
      and processed_at is null)
    or (status <> 'processing'
      and claimed_by is null
      and claim_token is null
      and claimed_at is null
      and lease_expires_at is null)
  );

create unique index provider_event_processing_claim_token_unique
  on public.provider_event_processing (claim_token)
  where claim_token is not null;

create index provider_event_processing_ready_idx
  on public.provider_event_processing (status, next_attempt_at, updated_at);

create or replace function public.protect_billing_offer()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  product_state public.product_status;
begin
  if tg_op = 'DELETE' then
    raise exception 'billing offers are retained for commercial history' using errcode = 'P0001';
  end if;

  select product.status into product_state
  from public.products as product
  where product.id = new.product_id
  for share;

  if product_state is null then
    raise exception 'billing offer requires a product' using errcode = '23514';
  end if;
  if new.status = 'active' and product_state <> 'active' then
    raise exception 'an active billing offer requires an active product' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if new.product_id <> old.product_id
       or new.key <> old.key
       or new.version <> old.version
       or new.created_at <> old.created_at then
      raise exception 'billing offer identity is immutable' using errcode = 'P0001';
    end if;
    if old.status <> 'draft' and (
      new.name <> old.name
      or new.billing_mode <> old.billing_mode
      or new.stripe_price_id is distinct from old.stripe_price_id
      or new.currency is distinct from old.currency
      or new.unit_amount_minor is distinct from old.unit_amount_minor
      or new.success_url_template is distinct from old.success_url_template
      or new.cancel_url is distinct from old.cancel_url
    ) then
      raise exception 'activated billing terms are immutable; create a new offer version' using errcode = 'P0001';
    end if;
    if not (
      (old.status = 'draft' and new.status in ('draft', 'active', 'archived'))
      or (old.status = 'active' and new.status in ('active', 'paused', 'archived'))
      or (old.status = 'paused' and new.status in ('paused', 'active', 'archived'))
      or (old.status = 'archived' and new.status = 'archived')
    ) then
      raise exception 'invalid billing offer status transition: % -> %', old.status, new.status
        using errcode = 'P0001';
    end if;
  elsif new.status not in ('draft', 'active') then
    raise exception 'new billing offers must be draft or active' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create or replace function public.validate_checkout_attempt()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  click_record public.clicks%rowtype;
  acquisition_record public.acquisitions%rowtype;
  offer_record public.billing_offers%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'checkout attempts are retained for provider reconciliation' using errcode = 'P0001';
  end if;

  select * into click_record
  from public.clicks
  where id = new.click_record_id;
  select * into acquisition_record
  from public.acquisitions
  where id = new.acquisition_id;
  select * into offer_record
  from public.billing_offers
  where id = new.billing_offer_id;

  if click_record.id is null
     or click_record.is_bot
     or acquisition_record.id is null
     or acquisition_record.status = 'rejected'
     or acquisition_record.click_record_id <> click_record.id
     or acquisition_record.product_id <> new.product_id
     or acquisition_record.affiliate_id is distinct from new.affiliate_id
     or click_record.product_id <> new.product_id
     or click_record.affiliate_id is distinct from new.affiliate_id then
    raise exception 'checkout attempt must match an eligible canonical click and acquisition'
      using errcode = '23514';
  end if;

  if offer_record.id is null
     or offer_record.product_id <> new.product_id
     or (tg_op = 'INSERT' and offer_record.status <> 'active')
     or offer_record.billing_mode <> new.billing_mode
     or offer_record.stripe_price_id is distinct from new.stripe_price_id
     or offer_record.currency is distinct from new.currency
     or offer_record.unit_amount_minor is distinct from new.unit_amount_minor
     or offer_record.success_url_template is distinct from new.success_url_snapshot
     or offer_record.cancel_url is distinct from new.cancel_url_snapshot then
    raise exception 'checkout attempt must snapshot the active server-owned billing offer'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if (to_jsonb(new)
        - 'status'
        - 'stripe_checkout_session_id'
        - 'checkout_url'
        - 'stripe_session_expires_at'
        - 'failure_code'
        - 'completed_at'
        - 'updated_at')
       <> (to_jsonb(old)
        - 'status'
        - 'stripe_checkout_session_id'
        - 'checkout_url'
        - 'stripe_session_expires_at'
        - 'failure_code'
        - 'completed_at'
        - 'updated_at') then
      raise exception 'checkout attribution and offer snapshots are immutable' using errcode = 'P0001';
    end if;
    if not (
      (old.status = 'prepared' and new.status in ('open', 'failed'))
      or (old.status = 'open' and new.status in ('completed', 'expired'))
    ) then
      raise exception 'invalid checkout attempt status transition: % -> %', old.status, new.status
        using errcode = 'P0001';
    end if;
  elsif new.status <> 'prepared' then
    raise exception 'new checkout attempts must be prepared' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger billing_offers_protect_history
  before insert or update or delete on public.billing_offers
  for each row execute function public.protect_billing_offer();
create trigger billing_offers_set_updated_at
  before update on public.billing_offers
  for each row execute function public.set_updated_at();
create trigger billing_offers_audit_mutation
  after insert or update or delete on public.billing_offers
  for each row execute function public.audit_mutation();

create trigger checkout_attempts_validate_identity
  before insert or update or delete on public.checkout_attempts
  for each row execute function public.validate_checkout_attempt();
create trigger checkout_attempts_set_updated_at
  before update on public.checkout_attempts
  for each row execute function public.set_updated_at();
create trigger checkout_attempts_audit_mutation
  after insert or update or delete on public.checkout_attempts
  for each row execute function public.audit_mutation();

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

create or replace function public.finalize_checkout_attempt(p_input jsonb)
returns table (
  attempt_id uuid,
  status text,
  checkout_url text,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'attempt_id', 'status', 'stripe_session_id', 'checkout_url', 'expires_at', 'failure_code'
  ];
  attempt_id_value uuid;
  status_value text;
  stripe_session_id_value text;
  checkout_url_value text;
  expires_at_value timestamptz;
  failure_code_value text;
  attempt_record public.checkout_attempts%rowtype;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'checkout finalization input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) as input_key
    where input_key <> all(allowed_keys)
  ) then
    raise exception 'checkout finalization input contains unsupported fields' using errcode = '22023';
  end if;
  if not (p_input ? 'attempt_id')
     or not (p_input ? 'status')
     or jsonb_typeof(p_input -> 'attempt_id') <> 'string'
     or jsonb_typeof(p_input -> 'status') <> 'string' then
    raise exception 'attempt_id and status are required strings' using errcode = '22023';
  end if;

  begin
    attempt_id_value := (p_input ->> 'attempt_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'attempt_id must be a UUID' using errcode = '22023';
  end;
  status_value := trim(p_input ->> 'status');
  if status_value not in ('open', 'failed') then
    raise exception 'checkout finalization status must be open or failed' using errcode = '22023';
  end if;

  if status_value = 'open' then
    if not (p_input ?& array['stripe_session_id', 'checkout_url', 'expires_at'])
       or p_input ? 'failure_code'
       or jsonb_typeof(p_input -> 'stripe_session_id') <> 'string'
       or jsonb_typeof(p_input -> 'checkout_url') <> 'string'
       or jsonb_typeof(p_input -> 'expires_at') <> 'string' then
      raise exception 'open checkout finalization requires only Stripe session fields'
        using errcode = '22023';
    end if;
    stripe_session_id_value := trim(p_input ->> 'stripe_session_id');
    checkout_url_value := trim(p_input ->> 'checkout_url');
    begin
      expires_at_value := (p_input ->> 'expires_at')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'checkout expiry must be a timestamp' using errcode = '22023';
    end;
    if stripe_session_id_value !~ '^cs_live_[A-Za-z0-9_]{8,160}$'
       or checkout_url_value !~ '^https://checkout[.]stripe[.]com/'
       or checkout_url_value ~ '[[:space:]]'
       or expires_at_value <= now() + interval '5 minutes'
       or expires_at_value > now() + interval '25 hours' then
      raise exception 'Stripe checkout session response is invalid' using errcode = '22023';
    end if;
  else
    if not (p_input ? 'failure_code')
       or p_input ?| array['stripe_session_id', 'checkout_url', 'expires_at']
       or jsonb_typeof(p_input -> 'failure_code') <> 'string' then
      raise exception 'failed checkout finalization requires only a failure code'
        using errcode = '22023';
    end if;
    failure_code_value := trim(p_input ->> 'failure_code');
    if failure_code_value !~ '^[a-z][a-z0-9_.-]{0,99}$' then
      raise exception 'checkout failure code is invalid' using errcode = '22023';
    end if;
  end if;

  select * into attempt_record
  from public.checkout_attempts as attempt
  where attempt.id = attempt_id_value
  for update;

  if attempt_record.id is null then
    raise exception 'checkout attempt is unavailable' using errcode = 'P0002';
  end if;

  if attempt_record.status = status_value then
    if (status_value = 'open' and (
      attempt_record.stripe_checkout_session_id is distinct from stripe_session_id_value
      or attempt_record.checkout_url is distinct from checkout_url_value
      or attempt_record.stripe_session_expires_at is distinct from expires_at_value
    )) or (status_value = 'failed' and attempt_record.failure_code is distinct from failure_code_value) then
      raise exception 'checkout finalization conflicts with the persisted result' using errcode = '23505';
    end if;
  elsif attempt_record.status = 'prepared' then
    update public.checkout_attempts as attempt
    set
      status = status_value,
      stripe_checkout_session_id = stripe_session_id_value,
      checkout_url = checkout_url_value,
      stripe_session_expires_at = expires_at_value,
      failure_code = failure_code_value
    where attempt.id = attempt_id_value
    returning * into attempt_record;
  else
    raise exception 'checkout attempt cannot be finalized from its current state' using errcode = 'P0001';
  end if;

  return query select
    attempt_record.id,
    attempt_record.status,
    attempt_record.checkout_url,
    attempt_record.stripe_session_expires_at;
end;
$$;

create or replace function public.claim_provider_events(
  p_worker text,
  p_limit integer default 25,
  p_lease_seconds integer default 60
)
returns table (
  provider_event_id uuid,
  claim_token uuid,
  provider public.provider_name,
  external_event_id text,
  event_type text,
  payload jsonb,
  attempt_count integer,
  received_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  p_worker := trim(coalesce(p_worker, ''));
  if p_worker !~ '^[a-z][a-z0-9_-]{1,63}$' then
    raise exception 'worker name is invalid' using errcode = '22023';
  end if;
  if p_limit is null
     or p_lease_seconds is null
     or p_limit not between 1 and 100
     or p_lease_seconds not between 15 and 900 then
    raise exception 'worker claim bounds are invalid' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select processing.provider_event_id
    from public.provider_event_processing as processing
    join public.provider_events as event on event.id = processing.provider_event_id
    where event.provider = 'stripe'
      and event.signature_verified
      and event.livemode
      and (
        (processing.status = 'pending' and processing.next_attempt_at <= now())
        or (
          processing.status = 'processing'
          and processing.lease_expires_at <= now()
        )
      )
    order by event.received_at, processing.provider_event_id
    for update of processing skip locked
    limit p_limit
  ), claimed as (
    update public.provider_event_processing as processing
    set
      status = 'processing',
      attempt_count = processing.attempt_count + 1,
      processing_error = null,
      claimed_at = now(),
      claimed_by = p_worker,
      claim_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
    from candidates
    where processing.provider_event_id = candidates.provider_event_id
    returning
      processing.provider_event_id,
      processing.claim_token,
      processing.attempt_count
  )
  select
    event.id,
    claimed.claim_token,
    event.provider,
    event.provider_event_id,
    event.event_type,
    event.payload,
    claimed.attempt_count,
    event.received_at
  from claimed
  join public.provider_events as event on event.id = claimed.provider_event_id
  order by event.received_at, event.id;
end;
$$;

create or replace function public.complete_provider_event(
  p_provider_event_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
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
  return changed = 1;
end;
$$;

create or replace function public.fail_provider_event(
  p_provider_event_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_retry_delay_seconds integer default 60,
  p_terminal boolean default false
)
returns public.processing_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  error_code_value text := trim(coalesce(p_error_code, ''));
  resulting_status public.processing_status;
begin
  if error_code_value !~ '^[a-z][a-z0-9_.-]{0,99}$' then
    raise exception 'provider processing error code is invalid' using errcode = '22023';
  end if;
  if p_retry_delay_seconds is null
     or p_terminal is null
     or p_retry_delay_seconds not between 0 and 86400 then
    raise exception 'provider retry delay is invalid' using errcode = '22023';
  end if;

  update public.provider_event_processing as processing
  set
    status = case when p_terminal then 'failed'::public.processing_status else 'pending'::public.processing_status end,
    processing_error = error_code_value,
    claimed_at = null,
    claimed_by = null,
    claim_token = null,
    lease_expires_at = null,
    next_attempt_at = case
      when p_terminal then processing.next_attempt_at
      else now() + make_interval(secs => p_retry_delay_seconds)
    end,
    updated_at = now()
  where processing.provider_event_id = p_provider_event_id
    and processing.status = 'processing'
    and processing.claim_token = p_claim_token
    and processing.lease_expires_at > now()
  returning processing.status into resulting_status;

  if resulting_status is null then
    raise exception 'provider event claim is unavailable' using errcode = 'P0002';
  end if;
  return resulting_status;
end;
$$;

-- Existing canonical money remains subscription-backed. Tighten it so only live,
-- signature-verified Stripe evidence can create a payable fact.
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
     or not provider_record.livemode
     or provider_record.event_type not in (
       'invoice.paid', 'checkout.session.completed', 'charge.succeeded', 'payment_intent.succeeded'
     ) then
    raise exception 'transaction requires a signature-verified live Stripe payment event' using errcode = '23514';
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

alter table public.billing_offers enable row level security;
alter table public.checkout_attempts enable row level security;

create policy owner_read_billing_offers on public.billing_offers
  for select to authenticated using (public.current_user_is_admin(array['owner']::text[]));
create policy operations_read_billing_offers on public.billing_offers
  for select to authenticated using (public.current_user_is_admin(array['operations']::text[]));
create policy finance_read_billing_offers on public.billing_offers
  for select to authenticated using (public.current_user_is_admin(array['finance']::text[]));
create policy owner_read_checkout_attempts on public.checkout_attempts
  for select to authenticated using (public.current_user_is_admin(array['owner']::text[]));
create policy operations_read_checkout_attempts on public.checkout_attempts
  for select to authenticated using (public.current_user_is_admin(array['operations']::text[]));
create policy finance_read_checkout_attempts on public.checkout_attempts
  for select to authenticated using (public.current_user_is_admin(array['finance']::text[]));

revoke all on public.billing_offers, public.checkout_attempts
  from public, anon, authenticated, service_role;
revoke all on function public.protect_billing_offer() from public, anon, authenticated, service_role;
revoke all on function public.validate_checkout_attempt() from public, anon, authenticated, service_role;
revoke all on function public.prepare_checkout_attempt(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.finalize_checkout_attempt(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.claim_provider_events(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.complete_provider_event(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.fail_provider_event(uuid, uuid, text, integer, boolean) from public, anon, authenticated, service_role;

grant execute on function public.prepare_checkout_attempt(jsonb) to service_role;
grant execute on function public.finalize_checkout_attempt(jsonb) to service_role;
grant execute on function public.claim_provider_events(text, integer, integer) to service_role;
grant execute on function public.complete_provider_event(uuid, uuid) to service_role;
grant execute on function public.fail_provider_event(uuid, uuid, text, integer, boolean) to service_role;

comment on table public.billing_offers is
  'Versioned server-owned Stripe price and redirect configuration. Payment-mode offers remain dormant until one-time canonical transactions are implemented.';
comment on table public.checkout_attempts is
  'Durable idempotent bridge from an immutable click/acquisition to a live Stripe Checkout Session.';
comment on column public.provider_events.livemode is
  'Fail-closed provider environment classification derived from the signed immutable payload.';
comment on function public.prepare_checkout_attempt(jsonb) is
  'Service-only checkout preparation. Resolves price, amount, mode, URLs, and attribution from canonical server data.';
comment on function public.finalize_checkout_attempt(jsonb) is
  'Service-only idempotent persistence of a live Stripe Checkout Session result or non-sensitive failure code.';
comment on function public.claim_provider_events(text, integer, integer) is
  'Service-only atomic live Stripe queue claim with a bounded lease and opaque claim token.';
comment on function public.complete_provider_event(uuid, uuid) is
  'Service-only compare-and-set completion for a currently leased provider event.';
comment on function public.fail_provider_event(uuid, uuid, text, integer, boolean) is
  'Service-only compare-and-set retry or terminal failure using non-sensitive error codes.';
