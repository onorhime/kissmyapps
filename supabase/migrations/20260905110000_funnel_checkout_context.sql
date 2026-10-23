begin;

-- Bounded counters only: no email, IP, card data, or request bodies.
create table kma_internal.funnel_request_limits (
  click_record_id uuid not null references public.clicks(id) on delete cascade,
  action text not null check (action in ('offer','status','checkout')),
  window_start timestamptz not null,
  requests integer not null,
  primary key (click_record_id, action)
);
alter table kma_internal.funnel_request_limits enable row level security;
revoke all on kma_internal.funnel_request_limits from public, anon, authenticated, service_role;

create function public.consume_funnel_request(p_click_id text, p_action text)
returns void language plpgsql security definer set search_path = '' as $$
declare click_id_value uuid; count_value integer; limit_value integer;
begin
  if p_action not in ('offer','status','checkout') then
    raise exception 'unsupported action' using errcode='22023';
  end if;
  select id into click_id_value from public.clicks where public_click_id=p_click_id and not is_bot;
  if click_id_value is null then raise exception 'click unavailable' using errcode='P0002'; end if;
  limit_value := case p_action when 'status' then 30 when 'offer' then 10 else 6 end;
  insert into kma_internal.funnel_request_limits as stored (click_record_id,action,window_start,requests)
    values (click_id_value,p_action,statement_timestamp(),1)
    on conflict (click_record_id,action) do update set
      window_start=case when stored.window_start <= statement_timestamp()-interval '1 minute'
        then statement_timestamp() else stored.window_start end,
      requests=case when stored.window_start <= statement_timestamp()-interval '1 minute'
        then 1 else stored.requests+1 end
    returning requests into count_value;
  if count_value>limit_value then raise exception 'funnel request rate exceeded' using errcode='KMA29'; end if;
end $$;

create function public.get_funnel_checkout_context(p_input jsonb, p_product_id uuid, p_funnel_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare action_value text; click_value text; offer_record public.billing_offers%rowtype;
  attempt_record public.checkout_attempts%rowtype;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'invalid input' using errcode='22023'; end if;
  action_value:=p_input->>'action'; click_value:=p_input->>'click_id';
  perform public.assert_funnel_request_scope('context',click_value,p_product_id,p_funnel_id);
  if action_value='offer' then
    if not (p_input ?& array['action','click_id','offer_key']) or
      (select count(*) from jsonb_object_keys(p_input))<>3 or
      jsonb_typeof(p_input->'offer_key') is distinct from 'string' then
      raise exception 'invalid input' using errcode='22023';
    end if;
    if not exists (select 1 from public.clicks c join public.acquisitions a on a.click_record_id=c.id
      join public.affiliate_links l on l.id=c.affiliate_link_id
      join public.products p on p.id=c.product_id
      join public.funnels f on f.id=c.funnel_id
      where c.public_click_id=click_value and c.commercial_eligible and a.commercial_eligible
        and l.commercial_eligible and p.tracking_mode='commercial' and p.status='active'
        and f.status='live' and l.status='active' and a.status<>'rejected') then
      raise exception 'commercial checkout unavailable' using errcode='P0002';
    end if;
    select * into offer_record from public.billing_offers o where o.product_id=p_product_id
      and o.key=p_input->>'offer_key' and o.status='active' and o.billing_mode='subscription'
      and o.stripe_livemode_verified_at is not null
      and o.verified_stripe_price_id=o.stripe_price_id and o.verified_currency=o.currency
      and o.verified_unit_amount_minor=o.unit_amount_minor and o.verified_billing_mode=o.billing_mode;
    if offer_record.id is null then raise exception 'offer unavailable' using errcode='P0002'; end if;
    perform public.consume_funnel_request(click_value,'offer');
    -- Server-only Price identity is removed by the Edge before responding.
    return jsonb_build_object('key',offer_record.key,'version',offer_record.version,'name',offer_record.name,
      'currency',offer_record.currency,'unit_amount_minor',offer_record.unit_amount_minor,
      'billing_mode',offer_record.billing_mode,'stripe_price_id',offer_record.stripe_price_id);
  elsif action_value='status' then
    if not (p_input ?& array['action','click_id','attempt_id','session_id']) or
      (select count(*) from jsonb_object_keys(p_input))<>4 or
      jsonb_typeof(p_input->'attempt_id') is distinct from 'string' or
      jsonb_typeof(p_input->'session_id') is distinct from 'string' then
      raise exception 'invalid input' using errcode='22023';
    end if;
    select ca.* into attempt_record from public.checkout_attempts ca join public.clicks c on c.id=ca.click_record_id
      where c.public_click_id=click_value and ca.public_attempt_id=p_input->>'attempt_id'
        and ca.stripe_checkout_session_id=p_input->>'session_id' and ca.product_id=p_product_id
        and c.funnel_id=p_funnel_id and c.commercial_eligible;
    if attempt_record.id is null then raise exception 'receipt unavailable' using errcode='P0002'; end if;
    perform public.consume_funnel_request(click_value,'status');
    return jsonb_build_object('status',case when attempt_record.status='completed' and exists (
      select 1 from public.events e where e.acquisition_id=attempt_record.acquisition_id
        and e.source='stripe' and e.event_name='checkout.no_payment_required'
        and e.properties->>'checkout_session_id'=attempt_record.stripe_checkout_session_id
    ) then 'no_payment_required' when attempt_record.status='completed' then 'paid'
      when attempt_record.status='failed' then 'failed'
      when attempt_record.status='expired' then 'expired' else 'pending' end);
  end if;
  raise exception 'unsupported action' using errcode='22023';
end $$;

-- Lock the exact displayed version while the existing checkout procedure
-- snapshots pricing. The browser still sends only click_id and offer_key.
create function public.prepare_quoted_checkout_attempt(p_input jsonb)
returns table(attempt_id uuid,public_attempt_id text,billing_offer_id uuid,product_id uuid,
  acquisition_id uuid,click_record_id uuid,affiliate_id uuid,billing_mode text,stripe_price_id text,
  currency text,unit_amount_minor bigint,success_url text,cancel_url text)
language plpgsql security definer set search_path='' as $$
declare offer_record public.billing_offers%rowtype;
begin
  if jsonb_typeof(p_input->'offer_version') is distinct from 'number' or
    (p_input->>'offer_version') !~ '^[1-9][0-9]{0,8}$' then
    raise exception 'offer version required' using errcode='22023';
  end if;
  select o.* into offer_record from public.billing_offers o join public.clicks c on c.product_id=o.product_id
    where c.public_click_id=p_input->>'click_id' and o.key=p_input->>'offer_key' and o.status='active'
      and o.version=(p_input->>'offer_version')::integer for share of o;
  if offer_record.id is null then raise exception 'offer changed; review again' using errcode='P0002'; end if;
  return query select * from public.prepare_checkout_attempt(p_input-'offer_version');
end $$;

revoke all on function public.consume_funnel_request(text,text) from public,anon,authenticated,service_role;
revoke all on function public.get_funnel_checkout_context(jsonb,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.prepare_quoted_checkout_attempt(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.consume_funnel_request(text,text) to service_role;
grant execute on function public.get_funnel_checkout_context(jsonb,uuid,uuid) to service_role;
grant execute on function public.prepare_quoted_checkout_attempt(jsonb) to service_role;
commit;
