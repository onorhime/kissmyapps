-- Receipts for payment, refund and dispute events on connected merchant Stripe
-- accounts, written by the connect-payments-webhook Edge Function (service role).
-- Live only. One small row per Stripe event: identifiers, amount, currency and
-- the creator tag. No names, emails, card data or raw payload; only its SHA-256.
-- Receipts only: no commission, ledger or order is created by this migration.
begin;

create table public.merchant_payment_events (
  platform_account_id text not null check (platform_account_id ~ '^acct_[A-Za-z0-9]+$'),
  livemode boolean not null check (livemode),
  event_id text not null check (event_id ~ '^evt_[A-Za-z0-9_]+$' and length(event_id) <= 255),
  connection_id uuid not null references public.merchant_connections(id),
  account_id text not null check (account_id ~ '^acct_[A-Za-z0-9]+$' and account_id <> platform_account_id),
  event_type text not null check (event_type in (
    'checkout.session.completed', 'checkout.session.async_payment_succeeded',
    'payment_intent.succeeded', 'invoice.paid',
    'charge.refunded', 'refund.created', 'refund.updated',
    'charge.dispute.created', 'charge.dispute.closed')),
  object_id text not null check (object_id ~ '^[A-Za-z0-9_]{3,255}$'),
  payment_intent_id text check (payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,252}$'),
  amount_minor bigint check (amount_minor >= 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  kma_click text check (kma_click ~ '^[A-Za-z0-9_-]{8,200}$'),
  tag_source text check (tag_source in ('metadata', 'client_reference_id')),
  event_created timestamptz not null,
  received_at timestamptz not null default now(),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  primary key (platform_account_id, livemode, event_id),
  constraint merchant_payment_event_tag_has_source check ((kma_click is null) = (tag_source is null))
);

-- The console summary reads one connection's payment events, newest first.
create index merchant_payment_events_summary
  on public.merchant_payment_events(connection_id, account_id, event_created desc)
  include (payment_intent_id, object_id, kma_click)
  where event_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded',
    'payment_intent.succeeded', 'invoice.paid');

alter table public.merchant_payment_events enable row level security;
revoke all on public.merchant_payment_events from public, anon, authenticated, service_role;

-- Stores one receipt. The caller is the webhook, after it verified Stripe's
-- signature. Nothing is stored unless an ACTIVE live connection owns the account.
-- Delivering the same event again is a no-op; the same event id with a different
-- signed body is refused.
create function public.record_merchant_payment_event(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_platform text := p_input->>'platform_account_id';
  v_account text := p_input->>'account_id';
  v_event text := p_input->>'event_id';
  v_type text := p_input->>'event_type';
  v_sha text := p_input->>'payload_sha256';
  v_object text := p_input->>'object_id';
  v_intent text := p_input->>'payment_intent_id';
  v_currency text := upper(p_input->>'currency');
  v_tag text := p_input->>'kma_click';
  v_source text := p_input->>'tag_source';
  v_amount bigint;
  v_created timestamptz;
  v_connection uuid;
  v_previous public.merchant_payment_events;
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object'
    or p_input->'livemode' is distinct from 'true'::jsonb
    or coalesce(v_platform, '') !~ '^acct_[A-Za-z0-9]+$'
    or coalesce(v_account, '') !~ '^acct_[A-Za-z0-9]+$'
    or v_account = v_platform
    or coalesce(v_event, '') !~ '^evt_[A-Za-z0-9_]+$' or length(v_event) > 255
    or v_type is null or v_type not in (
      'checkout.session.completed', 'checkout.session.async_payment_succeeded',
      'payment_intent.succeeded', 'invoice.paid',
      'charge.refunded', 'refund.created', 'refund.updated',
      'charge.dispute.created', 'charge.dispute.closed')
    or coalesce(v_object, '') !~ '^[A-Za-z0-9_]{3,255}$'
    or (v_intent is not null and v_intent !~ '^pi_[A-Za-z0-9_]{1,252}$')
    or (v_currency is not null and v_currency !~ '^[A-Z]{3}$')
    or coalesce(v_sha, '') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_input->'event_created') is distinct from 'number'
    or (p_input->>'event_created') !~ '^[0-9]{1,12}$' or (p_input->>'event_created')::bigint <= 0
    or (jsonb_typeof(p_input->'amount_minor') not in ('number', 'null'))
    or (jsonb_typeof(p_input->'amount_minor') = 'number' and (p_input->>'amount_minor') !~ '^[0-9]{1,18}$')
    or (v_source is not null and v_source not in ('metadata', 'client_reference_id'))
    or (v_tag is not null and jsonb_typeof(p_input->'kma_click') <> 'string')
    or (v_tag is not null and v_source is null)
  then
    raise exception 'Invalid merchant payment event' using errcode = '22023';
  end if;
  v_amount := (p_input->>'amount_minor')::bigint;
  v_created := to_timestamp((p_input->>'event_created')::bigint);
  -- A tag that does not look like a creator tag is not kept.
  if v_tag is null or v_tag !~ '^[A-Za-z0-9_-]{8,200}$' then
    v_tag := null;
    v_source := null;
  end if;

  select c.id into v_connection from public.merchant_connections c
    where c.platform_account_id = v_platform and c.livemode and c.account_id = v_account and c.status = 'active';
  if v_connection is null then
    return jsonb_build_object('matched', false, 'duplicate', false);
  end if;

  insert into public.merchant_payment_events(platform_account_id, livemode, event_id, connection_id, account_id,
      event_type, object_id, payment_intent_id, amount_minor, currency, kma_click, tag_source, event_created, payload_sha256)
    values (v_platform, true, v_event, v_connection, v_account,
      v_type, v_object, v_intent, v_amount, v_currency, v_tag, v_source, v_created, v_sha)
    on conflict (platform_account_id, livemode, event_id) do nothing;
  if found then
    return jsonb_build_object('matched', true, 'duplicate', false);
  end if;

  select * into v_previous from public.merchant_payment_events e
    where e.platform_account_id = v_platform and e.livemode and e.event_id = v_event;
  if v_previous.payload_sha256 is distinct from v_sha or v_previous.account_id is distinct from v_account
    or v_previous.event_type is distinct from v_type then
    raise exception 'Merchant payment event identity conflicts with the stored receipt' using errcode = '23505';
  end if;
  return jsonb_build_object('matched', true, 'duplicate', true);
end $$;

-- What the console shows a workspace member: how many payments were seen on the
-- workspace's active live Stripe connection and how many carried a creator tag.
-- Only payment events count; refunds and disputes do not. One payment can arrive
-- as several events (a Checkout Session and its PaymentIntent), so events that
-- share a PaymentIntent count once, and the payment is tagged when any of them is.
create function public.workspace_stripe_payment_summary(p_input jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_workspace uuid := (p_input->>'workspace_id')::uuid;
  v_user uuid := (p_input->>'user_id')::uuid;
  v_result jsonb;
begin
  if v_workspace is null or v_user is null or not exists (
    select 1 from public.analytics_workspace_members m where m.workspace_id = v_workspace and m.user_id = v_user
  ) then
    raise exception 'Workspace membership is required' using errcode = '42501';
  end if;
  select jsonb_build_object(
      'seen', count(distinct coalesce(e.payment_intent_id, e.object_id))::int,
      'tagged', (count(distinct coalesce(e.payment_intent_id, e.object_id)) filter (where e.kma_click is not null))::int,
      'last_at', max(e.event_created),
      'last_tagged_at', max(e.event_created) filter (where e.kma_click is not null))
    into v_result
    from public.merchant_businesses b
    join public.merchant_connections c on c.merchant_id = b.id and c.livemode and c.status = 'active'
    join public.merchant_payment_events e on e.connection_id = c.id and e.account_id = c.account_id
    where b.workspace_id = v_workspace
      and e.event_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded',
        'payment_intent.succeeded', 'invoice.paid');
  return v_result;
end $$;

revoke all on function public.record_merchant_payment_event(jsonb), public.workspace_stripe_payment_summary(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_merchant_payment_event(jsonb), public.workspace_stripe_payment_summary(jsonb)
  to service_role;

commit;
