-- Merchant evidence is independent of the explicitly bound payout platform.
-- This records provider-verified observations only; no provider call or money
-- movement is performed by this migration or by the receipt RPC.
create table public.external_merchant_adjustment_receipts (
  id uuid primary key default gen_random_uuid(),
  stripe_account_id text not null check(stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  livemode boolean not null,
  product_id uuid not null,
  funnel_id uuid not null,
  external_order_id uuid not null,
  payment_intent_id text not null check(payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  provider_event_id text not null check(provider_event_id ~ '^evt_[A-Za-z0-9]+$'),
  provider_object_id text not null,
  kind text not null check(kind in('refund','dispute_open','dispute_won','dispute_lost')),
  order_amount_minor bigint not null check(order_amount_minor>0),
  amount_minor bigint not null check(amount_minor>0 and amount_minor<=order_amount_minor),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null,
  observed_at timestamptz not null,
  payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),
  order_id uuid references public.external_commerce_orders(id),
  applied_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check((kind='refund' and provider_object_id ~ '^re_[A-Za-z0-9]+$') or (kind<>'refund' and provider_object_id ~ '^dp_[A-Za-z0-9]+$')),
  foreign key(product_id,funnel_id,stripe_account_id,livemode) references public.external_commerce_merchants(product_id,funnel_id,stripe_account_id,livemode),
  unique(stripe_account_id,livemode,provider_event_id,provider_object_id,kind)
);
create index external_merchant_unbound_adjustments on public.external_merchant_adjustment_receipts(stripe_account_id,livemode,payment_intent_id) where applied_at is null;
alter table public.external_merchant_adjustment_receipts enable row level security;
revoke all on public.external_merchant_adjustment_receipts from public,anon,authenticated,service_role;
grant select on public.external_merchant_adjustment_receipts to service_role;

create function kma_internal.guard_external_merchant_receipt() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'Merchant evidence is immutable' using errcode='22023'; end if;
  if (to_jsonb(new)-array['order_id','applied_at']) is distinct from (to_jsonb(old)-array['order_id','applied_at'])
    or old.applied_at is not null or old.order_id is not null or new.applied_at is null or new.order_id is null
    then raise exception 'Merchant evidence is immutable; only its first exact order binding is allowed' using errcode='22023'; end if;
  if not exists(select 1 from public.external_commerce_orders o where o.id=new.order_id and o.stripe_account_id=new.stripe_account_id and o.livemode=new.livemode
    and o.product_id=new.product_id and o.funnel_id=new.funnel_id and o.external_order_id=new.external_order_id
    and o.stripe_payment_intent_id=new.payment_intent_id and o.amount_minor=new.order_amount_minor and o.currency=new.currency)
    then raise exception 'Merchant order binding conflicts with evidence' using errcode='23514'; end if;
  return new;
end $$;
create trigger external_merchant_receipt_history before update or delete on public.external_merchant_adjustment_receipts for each row execute function kma_internal.guard_external_merchant_receipt();

create function kma_internal.apply_external_merchant_adjustment(p_receipt uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare receipt public.external_merchant_adjustment_receipts; order_record public.external_commerce_orders;
begin
  perform pg_advisory_xact_lock(8154,42);
  select * into receipt from public.external_merchant_adjustment_receipts where id=p_receipt for update;
  if not found or receipt.applied_at is not null then return false; end if;
  select * into order_record from public.external_commerce_orders
    where stripe_account_id=receipt.stripe_account_id and livemode=receipt.livemode and stripe_payment_intent_id=receipt.payment_intent_id;
  if not found then return false; end if;
  if order_record.external_order_id<>receipt.external_order_id or order_record.product_id<>receipt.product_id or order_record.funnel_id<>receipt.funnel_id
    or order_record.amount_minor<>receipt.order_amount_minor or order_record.currency<>receipt.currency
    then raise exception 'Merchant adjustment scope conflicts with verified order' using errcode='23514'; end if;
  perform public.record_external_commission_adjustment(jsonb_build_object(
    'order_id',order_record.id,'provider_event_id',receipt.provider_event_id,'kind',receipt.kind,
    'amount_minor',receipt.amount_minor,'occurred_at',receipt.occurred_at,
    case when receipt.kind='refund' then 'refund_id' else 'dispute_id' end,receipt.provider_object_id));
  update public.external_merchant_adjustment_receipts set order_id=order_record.id,applied_at=clock_timestamp() where id=receipt.id;
  return true;
end $$;
create function kma_internal.apply_early_external_merchant_adjustments() returns trigger
language plpgsql security definer set search_path='' as $$
declare receipt uuid;
begin
  perform pg_advisory_xact_lock(8154,42);
  for receipt in select id from public.external_merchant_adjustment_receipts where stripe_account_id=new.stripe_account_id and livemode=new.livemode and payment_intent_id=new.stripe_payment_intent_id and applied_at is null order by created_at,id loop
    perform kma_internal.apply_external_merchant_adjustment(receipt);
  end loop;
  return new;
end $$;
create trigger external_order_apply_early_merchant_adjustments after insert on public.external_commerce_orders for each row execute function kma_internal.apply_early_external_merchant_adjustments();

create function public.ingest_external_merchant_adjustment(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare receipt public.external_merchant_adjustment_receipts; merchant text; mode boolean; event_name text; object_name text; kind_value text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service authentication required' using errcode='42501'; end if;
  if p_input is null or jsonb_typeof(p_input)<>'object' or exists(select 1 from jsonb_object_keys(p_input) k where k not in('provider_event_id','stripe_account_id','livemode','product_id','funnel_id','payment_intent_id','external_order_id','order_amount_minor','currency','kind','amount_minor','occurred_at','refund_id','dispute_id','observed_at','payload_sha256')) then raise exception 'Invalid merchant adjustment' using errcode='22023'; end if;
  merchant:=p_input->>'stripe_account_id';mode:=(p_input->>'livemode')::boolean;event_name:=p_input->>'provider_event_id';kind_value:=p_input->>'kind';
  object_name:=case when kind_value='refund' then p_input->>'refund_id' else p_input->>'dispute_id' end;
  if merchant is null or mode is null or event_name is null or object_name is null or kind_value is null
    or jsonb_typeof(p_input->'livemode') is distinct from 'boolean' or kind_value not in('refund','dispute_open','dispute_won','dispute_lost')
    or (kind_value='refund' and p_input ? 'dispute_id') or (kind_value<>'refund' and p_input ? 'refund_id')
    or (p_input->>'observed_at')::timestamptz is null or (p_input->>'observed_at')::timestamptz>clock_timestamp()+interval '1 minute'
    or (p_input->>'occurred_at')::timestamptz is null or (p_input->>'occurred_at')::timestamptz>clock_timestamp()+interval '5 minutes'
    then raise exception 'Invalid merchant adjustment evidence' using errcode='22023'; end if;
  if not exists(select 1 from public.external_commerce_merchants where product_id=(p_input->>'product_id')::uuid and funnel_id=(p_input->>'funnel_id')::uuid and stripe_account_id=merchant and livemode=mode) then raise exception 'Merchant scope is not configured' using errcode='42501'; end if;
  -- Accept risk evidence for a paused merchant too: pausing collection must not
  -- discard a later refund or dispute on an already accepted order.
  perform pg_advisory_xact_lock(8154,42);
  select * into receipt from public.external_merchant_adjustment_receipts where stripe_account_id=merchant and livemode=mode and provider_event_id=event_name and provider_object_id=object_name and kind=kind_value for update;
  if found then
    if receipt.product_id is distinct from (p_input->>'product_id')::uuid or receipt.funnel_id is distinct from (p_input->>'funnel_id')::uuid
      or receipt.external_order_id is distinct from (p_input->>'external_order_id')::uuid or receipt.payment_intent_id is distinct from p_input->>'payment_intent_id'
      or receipt.amount_minor is distinct from (p_input->>'amount_minor')::bigint or receipt.order_amount_minor is distinct from (p_input->>'order_amount_minor')::bigint
      or receipt.currency is distinct from p_input->>'currency' or receipt.occurred_at is distinct from (p_input->>'occurred_at')::timestamptz
      or receipt.payload_sha256 is distinct from p_input->>'payload_sha256' then raise exception 'Merchant adjustment replay conflicts' using errcode='23505'; end if;
    perform kma_internal.apply_external_merchant_adjustment(receipt.id);
    return jsonb_build_object('id',receipt.id,'duplicate',true);
  end if;
  insert into public.external_merchant_adjustment_receipts(stripe_account_id,livemode,product_id,funnel_id,external_order_id,payment_intent_id,provider_event_id,provider_object_id,kind,order_amount_minor,amount_minor,currency,occurred_at,observed_at,payload_sha256)
    values(merchant,mode,(p_input->>'product_id')::uuid,(p_input->>'funnel_id')::uuid,(p_input->>'external_order_id')::uuid,p_input->>'payment_intent_id',event_name,object_name,kind_value,(p_input->>'order_amount_minor')::bigint,(p_input->>'amount_minor')::bigint,p_input->>'currency',(p_input->>'occurred_at')::timestamptz,(p_input->>'observed_at')::timestamptz,p_input->>'payload_sha256') returning * into receipt;
  perform kma_internal.apply_external_merchant_adjustment(receipt.id);
  return jsonb_build_object('id',receipt.id,'duplicate',false);
end $$;
revoke all on function kma_internal.apply_external_merchant_adjustment(uuid),kma_internal.apply_early_external_merchant_adjustments(),kma_internal.guard_external_merchant_receipt() from public,anon,authenticated,service_role;
revoke all on function public.ingest_external_merchant_adjustment(jsonb) from public,anon,authenticated;
grant execute on function public.ingest_external_merchant_adjustment(jsonb) to service_role;
