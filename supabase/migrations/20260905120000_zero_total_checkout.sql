-- Zero-total subscriptions are provider facts, never cash transactions or commissions.
-- Kept separate from the strict positive-payment normalizer. Service worker only.
create or replace function public.normalize_stripe_zero_total_event(
  p_provider_event_id uuid, p_claim_token uuid, p_input jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  pe public.provider_events%rowtype;
  processing public.provider_event_processing%rowtype;
  attempt public.checkout_attempts%rowtype;
  acquisition public.acquisitions%rowtype;
  subscription public.subscriptions%rowtype;
  obj jsonb;
  kind text;
  expected_keys text[];
  occurred_at_value timestamptz;
  account_id_value uuid;
  subscription_id_value uuid;
  event_id_value uuid;
  customer_id_value text;
  subscription_id_external text;
  subscription_status_value public.subscription_status;
  changed integer;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'Invalid zero-total input' using errcode='22023';
  end if;
  kind:=p_input->>'kind';
  expected_keys:=case kind
    when 'checkout_subscription_free' then array['kind','object_id','subscription_id',
      'subscription_customer_id','subscription_attempt_id','subscription_status',
      'subscription_currency','period_start','period_end','cancelled_at','subscription_livemode']
    when 'invoice_no_payment_required' then array['kind','object_id','subscription_id','customer_id']
    else null end;
  if expected_keys is null or public.stripe_json_has_exact_keys(p_input,expected_keys,expected_keys) is distinct from true then
    raise exception 'Invalid zero-total shape' using errcode='22023';
  end if;
  select * into processing from public.provider_event_processing p
    where p.provider_event_id=p_provider_event_id for update;
  if processing.provider_event_id is null or processing.status is distinct from 'processing'
    or p_claim_token is null or processing.claim_token is distinct from p_claim_token
    or processing.lease_expires_at is null or processing.lease_expires_at<=now() then
    raise exception 'Provider claim unavailable' using errcode='P0002';
  end if;
  select * into pe from public.provider_events p where p.id=p_provider_event_id for share;
  if pe.id is null or pe.provider is distinct from 'stripe'
    or pe.signature_verified is distinct from true or pe.livemode is distinct from true then
    raise exception 'Verified live provider evidence required' using errcode='P0002';
  end if;
  obj:=pe.payload#>'{data,object}';
  if jsonb_typeof(obj) is distinct from 'object'
    or pe.payload->>'id' is distinct from pe.provider_event_id
    or pe.payload->>'type' is distinct from pe.event_type
    or pe.payload->'livemode' is distinct from 'true'::jsonb
    or obj->>'id' is null or p_input->>'object_id' is distinct from obj->>'id' then
    raise exception 'Inconsistent signed envelope' using errcode='23514';
  end if;
  occurred_at_value:=public.stripe_epoch_timestamp(pe.payload->'created');

  if kind='checkout_subscription_free' then
    if pe.event_type is distinct from 'checkout.session.completed'
      or obj->>'object' is distinct from 'checkout.session'
      or obj->>'mode' is distinct from 'subscription' or obj->>'status' is distinct from 'complete'
      or coalesce(obj->>'payment_status','') not in ('paid','no_payment_required')
      or obj->'amount_total' is distinct from '0'::jsonb
      or obj#>'{total_details,amount_tax}' is distinct from '0'::jsonb
      or obj#>'{total_details,amount_shipping}' is distinct from '0'::jsonb
      or p_input->'subscription_livemode' is distinct from 'true'::jsonb then
      raise exception 'Not a completed zero-total subscription' using errcode='23514';
    end if;
    select * into attempt from public.checkout_attempts a
      where a.id=(obj#>>'{metadata,kma_attempt_id}')::uuid for update;
    if attempt.id is null then raise exception 'Attempt unavailable' using errcode='P0002'; end if;
    if attempt.status not in ('open','completed') or attempt.billing_mode<>'subscription'
      or attempt.unit_amount_minor<=0
      or obj->'amount_subtotal' is distinct from to_jsonb(attempt.unit_amount_minor)
      or obj#>'{total_details,amount_discount}' is distinct from to_jsonb(attempt.unit_amount_minor)
      or obj->>'id' is distinct from attempt.stripe_checkout_session_id
      or obj->>'client_reference_id' is distinct from attempt.public_attempt_id
      or obj#>>'{metadata,kma_public_attempt_id}' is distinct from attempt.public_attempt_id
      or obj#>>'{metadata,kma_offer_id}' is distinct from attempt.billing_offer_id::text
      or obj#>>'{metadata,kma_product_id}' is distinct from attempt.product_id::text
      or obj#>>'{metadata,kma_acquisition_id}' is distinct from attempt.acquisition_id::text
      or obj#>>'{metadata,kma_click_id}' is distinct from attempt.click_record_id::text
      or obj#>>'{metadata,kma_expected_amount_minor}' is distinct from attempt.unit_amount_minor::text
      or obj#>>'{metadata,kma_expected_currency}' is distinct from attempt.currency
      or upper(obj->>'currency') is distinct from attempt.currency then
      raise exception 'Zero-total evidence conflicts with the durable attempt' using errcode='23514';
    end if;
    customer_id_value:=p_input->>'subscription_customer_id';
    subscription_id_external:=p_input->>'subscription_id';
    if customer_id_value is null or subscription_id_external is null
      or obj->>'customer' is distinct from customer_id_value
      or obj->>'subscription' is distinct from subscription_id_external
      or p_input->>'subscription_attempt_id' is distinct from attempt.id::text
      or upper(p_input->>'subscription_currency') is distinct from attempt.currency then
      raise exception 'Retrieved subscription conflicts with signed checkout' using errcode='23514';
    end if;
    subscription_status_value:=case p_input->>'subscription_status'
      when 'active' then 'active'::public.subscription_status
      when 'canceled' then 'cancelled'::public.subscription_status else null end;
    if subscription_status_value is null then
      raise exception 'Free subscription must be active or subsequently cancelled, not a trial' using errcode='23514';
    end if;
    if attempt.status='completed' and not exists (
      select 1 from public.events e where e.acquisition_id=attempt.acquisition_id
        and e.source='stripe' and e.event_name='checkout.no_payment_required'
        and e.properties->>'checkout_session_id'=attempt.stripe_checkout_session_id
    ) then raise exception 'Existing completion is not zero-total' using errcode='23514'; end if;

    account_id_value:=public.ensure_stripe_customer_account(customer_id_value);
    select * into acquisition from public.acquisitions a where a.id=attempt.acquisition_id for update;
    if acquisition.id is null or acquisition.status='rejected' then
      raise exception 'Acquisition unavailable' using errcode='P0002';
    end if;
    if acquisition.account_id is not null and acquisition.account_id<>account_id_value then
      raise exception 'Acquisition belongs to another customer' using errcode='23514';
    end if;
    if acquisition.status='open' then
      update public.acquisitions a set status='resolved',account_id=account_id_value,resolved_at=now()
        where a.id=acquisition.id;
    elsif acquisition.status<>'resolved' or acquisition.account_id is distinct from account_id_value then
      raise exception 'Acquisition not resolvable' using errcode='23514';
    end if;
    if attempt.status='open' then
      update public.checkout_attempts a set status='completed',completed_at=now() where a.id=attempt.id;
    end if;
    subscription_id_value:=public.upsert_stripe_subscription(attempt.id,account_id_value,pe.id,
      occurred_at_value,customer_id_value,subscription_id_external,subscription_status_value,attempt.currency,
      public.stripe_epoch_timestamp(p_input->'period_start'),public.stripe_epoch_timestamp(p_input->'period_end'),
      case when p_input->'cancelled_at'='null'::jsonb then null else public.stripe_epoch_timestamp(p_input->'cancelled_at') end);
    event_id_value:=public.insert_stripe_event_fact(pe.id,pe.provider_event_id,'checkout.no_payment_required',
      acquisition.id,account_id_value,false,jsonb_build_object('checkout_session_id',obj->>'id',
      'subscription_id',subscription_id_external,'amount_minor',0,'list_amount_minor',attempt.unit_amount_minor,
      'currency',attempt.currency),occurred_at_value);
  else
    if pe.event_type is distinct from 'invoice.paid' or obj->>'object' is distinct from 'invoice'
      or obj->>'status' is distinct from 'paid' or obj->'paid' is distinct from 'true'::jsonb
      or obj->'amount_paid' is distinct from '0'::jsonb or obj->'total' is distinct from '0'::jsonb
      or obj->'total_excluding_tax' is distinct from '0'::jsonb
      or obj->'amount_due' is distinct from '0'::jsonb or obj->'amount_remaining' is distinct from '0'::jsonb
      or obj->>'customer' is distinct from p_input->>'customer_id'
      or coalesce(obj->>'subscription',obj#>>'{parent,subscription_details,subscription}') is distinct from p_input->>'subscription_id' then
      raise exception 'Not a verified zero-total invoice' using errcode='23514';
    end if;
    select s.* into subscription from public.subscriptions s
      join public.stripe_subscription_evidence evidence on evidence.subscription_id=s.id
      where s.stripe_subscription_id=p_input->>'subscription_id' for share of s;
    if subscription.id is null then raise exception 'Subscription not yet normalized' using errcode='P0002'; end if;
    if subscription.stripe_customer_id is distinct from p_input->>'customer_id'
      or subscription.currency is distinct from upper(obj->>'currency') then
      raise exception 'Invoice ownership or currency mismatch' using errcode='23514';
    end if;
    subscription_id_value:=subscription.id;
    event_id_value:=public.insert_stripe_event_fact(pe.id,pe.provider_event_id,'invoice.no_payment_required',
      subscription.acquisition_id,subscription.account_id,false,jsonb_build_object('invoice_id',obj->>'id',
      'subscription_id',subscription.stripe_subscription_id,'amount_minor',0,'currency',subscription.currency),occurred_at_value);
  end if;
  update public.provider_event_processing p set status='processed',processing_error=null,
    claimed_at=null,claimed_by=null,claim_token=null,lease_expires_at=null,processed_at=now(),updated_at=now()
    where p.provider_event_id=pe.id and p.status='processing' and p.claim_token=p_claim_token and p.lease_expires_at>now();
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'Provider claim expired' using errcode='P0002'; end if;
  return jsonb_build_object('status','processed','kind',kind,'canonical_event_id',event_id_value,
    'subscription_id',subscription_id_value);
end;
$$;
revoke all on function public.normalize_stripe_zero_total_event(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.normalize_stripe_zero_total_event(uuid,uuid,jsonb) to service_role;
