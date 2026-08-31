-- Privacy-safe Stripe callback evidence. Existing immutable rows are left untouched.

alter table public.provider_events
  add column signed_body_sha256 text,
  add constraint provider_events_signed_body_sha256_sha256 check (
    signed_body_sha256 is null
    or signed_body_sha256 ~ '^[a-f0-9]{64}$'
  );

comment on column public.provider_events.signed_body_sha256 is
  'Lowercase SHA-256 of the exact signature-verified raw request body. Nullable only for immutable provider events received before this column existed; new Stripe webhook inserts always set it.';

comment on table public.provider_events is
  'Immutable provider callback evidence keyed by provider event ID. New Stripe rows retain an allowlisted normalization projection and an exact signed-body digest rather than raw request bodies or customer contact, address, and payment details. Legacy rows remain untouched and may contain the earlier raw payload shape.';

create or replace function public.persist_stripe_provider_event(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'event_id', 'event_type', 'payload', 'signed_body_sha256'
  ];
  supported_types constant text[] := array[
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.paid',
    'refund.created',
    'refund.updated',
    'charge.dispute.created',
    'charge.dispute.updated',
    'charge.dispute.closed'
  ];
  event_id_value text;
  event_type_value text;
  payload_value jsonb;
  digest_value text;
  provider_row public.provider_events%rowtype;
  duplicate_value boolean := false;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or (select count(*) from jsonb_object_keys(p_input)) <> 4
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     ) then
    raise exception 'Stripe provider input is invalid' using errcode = '22023';
  end if;

  event_id_value := p_input ->> 'event_id';
  event_type_value := p_input ->> 'event_type';
  payload_value := p_input -> 'payload';
  digest_value := p_input ->> 'signed_body_sha256';
  if event_id_value !~ '^evt_[A-Za-z0-9_]{8,128}$'
     or event_type_value <> all(supported_types)
     or jsonb_typeof(payload_value) <> 'object'
     or digest_value !~ '^[a-f0-9]{64}$'
     or payload_value ->> 'id' is distinct from event_id_value
     or payload_value ->> 'type' is distinct from event_type_value
     or payload_value -> 'livemode' is distinct from 'true'::jsonb
     or jsonb_typeof(payload_value #> '{data,object}') <> 'object' then
    raise exception 'Stripe provider input is inconsistent' using errcode = '23514';
  end if;

  insert into public.provider_events (
    provider,
    provider_event_id,
    event_type,
    schema_version,
    payload,
    signature_verified,
    signed_body_sha256
  ) values (
    'stripe',
    event_id_value,
    event_type_value,
    1,
    payload_value,
    true,
    digest_value
  )
  on conflict (provider, provider_event_id) do nothing
  returning * into provider_row;

  if provider_row.id is null then
    duplicate_value := true;
    select event.* into provider_row
    from public.provider_events as event
    where event.provider = 'stripe'
      and event.provider_event_id = event_id_value
    for share;
    if provider_row.id is null
       or provider_row.event_type is distinct from event_type_value
       or provider_row.payload is distinct from payload_value
       or not provider_row.signature_verified
       or provider_row.signed_body_sha256 is distinct from digest_value then
      raise exception 'Stripe event identity conflicts with prior evidence'
        using errcode = '23505';
    end if;
  end if;

  insert into public.provider_event_processing (provider_event_id)
  values (provider_row.id)
  on conflict (provider_event_id) do nothing;

  return jsonb_build_object(
    'provider_event_id', provider_row.id,
    'duplicate', duplicate_value
  );
end;
$$;

revoke all on public.provider_events, public.provider_event_processing
  from service_role;
revoke all on function public.persist_stripe_provider_event(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.persist_stripe_provider_event(jsonb)
  to service_role;

comment on function public.persist_stripe_provider_event(jsonb) is
  'Atomically stores a minimized, signature-verified live Stripe event and exact raw-body digest. Exact retries are idempotent; conflicting event IDs fail closed.';
