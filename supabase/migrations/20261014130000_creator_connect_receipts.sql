-- Provider observations are separate from commission liabilities and transfers.
-- A connected-account payout may combine several balance sources. It does not
-- mark any commission batch as bank-paid and this migration sends no money.
create table public.creator_connect_events (
  id uuid primary key default gen_random_uuid(),
  platform_account_id text not null check (platform_account_id ~ '^acct_[A-Za-z0-9]+$'),
  livemode boolean not null,
  event_id text not null check (event_id ~ '^evt_[A-Za-z0-9]+$'),
  event_type text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique(platform_account_id,livemode,event_id)
);
create table public.creator_bank_payouts (
  id uuid primary key default gen_random_uuid(),
  account_key uuid not null references public.external_creator_accounts(id),
  platform_account_id text not null,
  livemode boolean not null,
  connected_account_id text not null,
  payout_id text not null check (payout_id ~ '^po_[A-Za-z0-9]+$'),
  status text not null check (status in ('pending','in_transit','paid','failed','canceled')),
  amount_minor bigint not null check (amount_minor>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  arrival_date timestamptz,
  failure_code text check (length(failure_code)<=100),
  observed_at timestamptz not null,
  latest_event_id uuid not null references public.creator_connect_events(id),
  unique(platform_account_id,livemode,connected_account_id,payout_id)
);
create table public.creator_transfer_receipts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.external_settlement_jobs(id),
  platform_account_id text not null,
  livemode boolean not null,
  transfer_id text not null check (transfer_id ~ '^tr_[A-Za-z0-9]+$'),
  destination text not null,
  amount_minor bigint not null check (amount_minor>0),
  amount_reversed_minor bigint not null check (amount_reversed_minor>=0 and amount_reversed_minor<=amount_minor),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  observed_at timestamptz not null,
  latest_event_id uuid not null references public.creator_connect_events(id),
  unique(platform_account_id,livemode,transfer_id)
);
create table public.creator_commercial_observations (
  id uuid primary key default gen_random_uuid(),
  event_receipt_id uuid not null unique references public.creator_connect_events(id),
  platform_account_id text not null,livemode boolean not null,
  payment_intent_id text not null check(payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  amount_minor bigint not null check(amount_minor>0),currency text not null check(currency ~ '^[A-Z]{3}$'),
  hold_type text not null check(hold_type in ('dispute','refund_full','refund_partial')),
  verified_amount_minor bigint not null check(verified_amount_minor>0 and verified_amount_minor<=amount_minor),
  reason text not null check(length(reason) between 5 and 500),
  check ((hold_type='refund_partial' and verified_amount_minor<amount_minor) or (hold_type in ('refund_full','dispute') and verified_amount_minor=amount_minor)),
  order_id uuid references public.external_commerce_orders(id),applied_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create index creator_unbound_commercial_holds on public.creator_commercial_observations(platform_account_id,livemode,payment_intent_id) where applied_at is null;
alter table public.creator_connect_events enable row level security;
alter table public.creator_bank_payouts enable row level security;
alter table public.creator_transfer_receipts enable row level security;
alter table public.creator_commercial_observations enable row level security;
revoke all on public.creator_connect_events,public.creator_bank_payouts,public.creator_transfer_receipts,public.creator_commercial_observations from public,anon,authenticated;
grant select on public.creator_connect_events,public.creator_bank_payouts,public.creator_transfer_receipts,public.creator_commercial_observations to service_role;

create function kma_internal.apply_creator_commercial_hold(p_observation uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare observation public.creator_commercial_observations;order_record public.external_commerce_orders;event_name text;
begin
  perform pg_advisory_xact_lock(8154,42);
  select * into observation from public.creator_commercial_observations where id=p_observation for update;
  if not found or observation.applied_at is not null then return false;end if;
  select * into order_record from public.external_commerce_orders where stripe_account_id=observation.platform_account_id and livemode=observation.livemode and stripe_payment_intent_id=observation.payment_intent_id;
  if not found then return false;end if;
  if order_record.amount_minor<>observation.amount_minor or order_record.currency<>observation.currency then raise exception 'Provider hold conflicts with verified order amount' using errcode='23514';end if;
  select event_id into event_name from public.creator_connect_events where id=observation.event_receipt_id;
  perform public.hold_external_commission_order(jsonb_build_object('order_id',order_record.id,'provider_event_id',event_name,'reason',observation.reason,'hold_type',observation.hold_type,'verified_amount_minor',observation.verified_amount_minor));
  update public.creator_commercial_observations set order_id=order_record.id,applied_at=clock_timestamp() where id=observation.id;
  return true;
end $$;
create function kma_internal.apply_early_creator_commercial_holds() returns trigger
language plpgsql security definer set search_path='' as $$
declare observation uuid;
begin
  perform pg_advisory_xact_lock(8154,42);
  for observation in select id from public.creator_commercial_observations where platform_account_id=new.stripe_account_id and livemode=new.livemode and payment_intent_id=new.stripe_payment_intent_id and applied_at is null order by created_at,id loop
    perform kma_internal.apply_creator_commercial_hold(observation);
  end loop;
  return new;
end $$;
create trigger external_order_apply_early_creator_holds after insert on public.external_commerce_orders for each row execute function kma_internal.apply_early_creator_commercial_holds();
revoke all on function kma_internal.apply_creator_commercial_hold(uuid),kma_internal.apply_early_creator_commercial_holds() from public,anon,authenticated,service_role;

create or replace function public.ingest_creator_connect_event(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  platform text; mode boolean; event_name text; event_type_value text; digest text;
  observed timestamptz; receipt public.creator_connect_events%rowtype;
  account_record public.external_creator_accounts%rowtype;
  job public.external_settlement_jobs%rowtype;
  snapshot jsonb; previous public.creator_bank_payouts%rowtype; observation uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service authentication required' using errcode='42501'; end if;
  if p_input is null or jsonb_typeof(p_input)<>'object' or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('event_id','event_type','platform_account_id','livemode','payload_sha256','observed_at','account_key','account','bank_payout','transfer','order_hold')) then raise exception 'invalid Connect event' using errcode='22023'; end if;
  platform:=p_input->>'platform_account_id'; mode:=(p_input->>'livemode')::boolean;
  event_name:=p_input->>'event_id'; event_type_value:=p_input->>'event_type'; digest:=p_input->>'payload_sha256'; observed:=(p_input->>'observed_at')::timestamptz;
  if platform is null or platform !~ '^acct_[A-Za-z0-9]+$' or mode is null or jsonb_typeof(p_input->'livemode')<>'boolean'
    or event_name is null or event_name !~ '^evt_[A-Za-z0-9]+$' or digest is null or digest !~ '^[a-f0-9]{64}$'
    or observed is null or observed>clock_timestamp()+interval '1 minute'
    or event_type_value not in ('account.updated','transfer.created','transfer.updated','transfer.reversed','payout.created','payout.updated','payout.paid','payout.failed','payout.canceled','charge.refunded','charge.dispute.created','charge.dispute.updated','charge.dispute.closed')
    or event_type_value is null then raise exception 'invalid Connect evidence' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('creator-connect-event:'||platform||':'||mode::text||':'||event_name,0));
  select * into receipt from public.creator_connect_events where platform_account_id=platform and livemode=mode and event_id=event_name;
  if found then
    if receipt.payload_sha256<>digest or receipt.event_type<>event_type_value then raise exception 'Connect event replay conflict' using errcode='23505'; end if;
    return jsonb_build_object('duplicate',true,'id',receipt.id);
  end if;
  if event_type_value like 'charge.%' then
    perform pg_advisory_xact_lock(8154,42);
    snapshot:=p_input->'order_hold';
    if jsonb_typeof(snapshot) is distinct from 'object' or p_input ? 'account' or p_input ? 'bank_payout' or p_input ? 'transfer' then raise exception 'invalid commercial hold observation' using errcode='22023'; end if;
    if not exists(select 1 from public.external_settlement_platforms where platform_account_id=platform and livemode=mode)
      or snapshot->>'payment_intent_id' is null or snapshot->>'payment_intent_id' !~ '^pi_[A-Za-z0-9]+$'
      or snapshot->>'hold_type' is null or snapshot->>'hold_type' not in ('dispute','refund_full','refund_partial')
      or (event_type_value='charge.refunded' and snapshot->>'hold_type'='dispute')
      or (event_type_value like 'charge.dispute.%' and snapshot->>'hold_type'<>'dispute')
      then raise exception 'commercial hold scope mismatch' using errcode='23514'; end if;
  elsif event_type_value like 'transfer.%' then
    perform pg_advisory_xact_lock(8154,42);
    snapshot:=p_input->'transfer';
    if jsonb_typeof(snapshot) is distinct from 'object' or p_input ? 'account' or p_input ? 'bank_payout' then raise exception 'invalid transfer observation' using errcode='22023'; end if;
    select * into job from public.external_settlement_jobs where id=(snapshot->>'job_id')::uuid for update;
    if not found or job.kind<>'transfer' or job.platform_account_id<>platform or job.livemode<>mode or job.destination is distinct from snapshot->>'destination'
      or job.amount_minor is distinct from (snapshot->>'amount_minor')::bigint or job.currency is distinct from snapshot->>'currency'
      or snapshot->>'transfer_id' is null or snapshot->>'transfer_id' !~ '^tr_[A-Za-z0-9]+$'
      or (job.provider_id is not null and job.provider_id<>snapshot->>'transfer_id')
      then raise exception 'Connect transfer scope mismatch' using errcode='23514'; end if;
  else
    select * into account_record from public.external_creator_accounts where id=(p_input->>'account_key')::uuid for update;
    if not found or account_record.platform_account_id<>platform or account_record.livemode<>mode or account_record.connect_account_id is null then raise exception 'Connect account scope mismatch' using errcode='23514'; end if;
    if event_type_value='account.updated' then
      snapshot:=p_input->'account';
      if jsonb_typeof(snapshot) is distinct from 'object' or p_input ? 'bank_payout' or p_input ? 'transfer'
        or snapshot->>'affiliate_id' is distinct from account_record.affiliate_id::text
        or snapshot->>'account_key' is distinct from account_record.id::text
        or snapshot->>'connect_account_id' is distinct from account_record.connect_account_id then raise exception 'Connect account evidence mismatch' using errcode='23514'; end if;
    else
      snapshot:=p_input->'bank_payout';
      if jsonb_typeof(snapshot) is distinct from 'object' or p_input ? 'account' or p_input ? 'transfer'
        or snapshot->>'connected_account_id' is distinct from account_record.connect_account_id then raise exception 'bank payout account mismatch' using errcode='23514'; end if;
      select * into previous from public.creator_bank_payouts where platform_account_id=platform and livemode=mode and connected_account_id=account_record.connect_account_id and payout_id=snapshot->>'payout_id';
      if found and (previous.amount_minor is distinct from (snapshot->>'amount_minor')::bigint or previous.currency is distinct from snapshot->>'currency') then raise exception 'bank payout identity changed' using errcode='23514'; end if;
    end if;
  end if;
  insert into public.creator_connect_events(platform_account_id,livemode,event_id,event_type,payload_sha256,observed_at)
    values(platform,mode,event_name,event_type_value,digest,observed) returning * into receipt;
  if event_type_value like 'charge.%' then
    insert into public.creator_commercial_observations(event_receipt_id,platform_account_id,livemode,payment_intent_id,amount_minor,currency,hold_type,verified_amount_minor,reason)
      values(receipt.id,platform,mode,snapshot->>'payment_intent_id',(snapshot->>'amount_minor')::bigint,snapshot->>'currency',snapshot->>'hold_type',(snapshot->>'verified_amount_minor')::bigint,snapshot->>'reason') returning id into observation;
    perform kma_internal.apply_creator_commercial_hold(observation);
  elsif event_type_value like 'transfer.%' then
    insert into public.creator_transfer_receipts(job_id,platform_account_id,livemode,transfer_id,destination,amount_minor,amount_reversed_minor,currency,observed_at,latest_event_id)
      values(job.id,platform,mode,snapshot->>'transfer_id',job.destination,job.amount_minor,(snapshot->>'amount_reversed_minor')::bigint,job.currency,observed,receipt.id)
      on conflict(platform_account_id,livemode,transfer_id) do update set amount_reversed_minor=excluded.amount_reversed_minor,observed_at=excluded.observed_at,latest_event_id=excluded.latest_event_id
      where public.creator_transfer_receipts.observed_at<excluded.observed_at;
    perform public.reconcile_creator_transfer_evidence(jsonb_build_object(
      'id',job.id,'platform_account_id',platform,'livemode',mode,'provider_id',snapshot->>'transfer_id',
      'destination',job.destination,'amount_minor',job.amount_minor,'currency',job.currency,
      'transfer_group',job.transfer_group,'amount_reversed',(snapshot->>'amount_reversed_minor')::bigint,'observed_at',observed));
    -- Provider transfer evidence never claims a bank payment.
  elsif event_type_value='account.updated' then
    perform public.set_creator_connect_account(snapshot||jsonb_build_object('platform_account_id',platform,'livemode',mode,'verified_at',observed));
  else
    insert into public.creator_bank_payouts(account_key,platform_account_id,livemode,connected_account_id,payout_id,status,amount_minor,currency,arrival_date,failure_code,observed_at,latest_event_id)
      values(account_record.id,platform,mode,account_record.connect_account_id,snapshot->>'payout_id',snapshot->>'status',(snapshot->>'amount_minor')::bigint,snapshot->>'currency',(snapshot->>'arrival_date')::timestamptz,snapshot->>'failure_code',observed,receipt.id)
      on conflict(platform_account_id,livemode,connected_account_id,payout_id) do update set status=excluded.status,arrival_date=excluded.arrival_date,failure_code=excluded.failure_code,observed_at=excluded.observed_at,latest_event_id=excluded.latest_event_id
      where public.creator_bank_payouts.observed_at<excluded.observed_at;
  end if;
  return jsonb_build_object('duplicate',false,'id',receipt.id);
end;
$$;

create or replace function kma_internal.external_bank_payout_rows(p_affiliate uuid,p_platform text default null,p_live boolean default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(to_jsonb(row) order by row.observed_at desc),'[]'::jsonb) from (
    select account.affiliate_id,payout.platform_account_id,payout.livemode,payout.connected_account_id,payout.payout_id,payout.status,payout.amount_minor,payout.currency,payout.arrival_date,payout.failure_code,payout.observed_at
    from public.creator_bank_payouts payout join public.external_creator_accounts account on account.id=payout.account_key
    where (p_affiliate is null or account.affiliate_id=p_affiliate) and (p_platform is null or payout.platform_account_id=p_platform) and (p_live is null or payout.livemode=p_live)
    order by payout.observed_at desc limit 100
  ) row;
$$;
revoke all on function kma_internal.external_bank_payout_rows(uuid,text,boolean) from public,anon,authenticated,service_role;

create or replace function public.get_partner_creator_bank_payouts()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare partner uuid; result jsonb;
begin
  partner:=public.current_partner_affiliate_id();
  select coalesce(jsonb_agg(to_jsonb(row) order by row.observed_at desc),'[]'::jsonb) into result from (
    select payout.platform_account_id,payout.livemode,payout.connected_account_id,payout.payout_id,payout.status,payout.amount_minor,payout.currency,payout.arrival_date,payout.failure_code,payout.observed_at
    from public.creator_bank_payouts payout join public.external_creator_accounts account on account.id=payout.account_key
    where account.affiliate_id=partner order by payout.observed_at desc limit 100
  ) row;
  return result;
end;
$$;
revoke all on function public.ingest_creator_connect_event(jsonb),public.get_partner_creator_bank_payouts() from public,anon,authenticated,service_role;
grant execute on function public.ingest_creator_connect_event(jsonb) to service_role;
grant execute on function public.get_partner_creator_bank_payouts() to authenticated;
