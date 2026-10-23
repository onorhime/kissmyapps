begin;

-- The signed provider receipt stays immutable. Recovery adds only missing,
-- minimized billing-period evidence from Stripe's ORIGINAL Event resource.
create table kma_internal.stripe_subscription_event_supplements (
  provider_event_id uuid primary key references public.provider_events(id),
  payload jsonb not null,
  recovered_at timestamptz not null default now()
);
alter table kma_internal.stripe_subscription_event_supplements enable row level security;
revoke all on kma_internal.stripe_subscription_event_supplements from public, anon, authenticated, service_role;

create function kma_internal.stripe_subscription_period(p_object jsonb, p_edge text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare item jsonb; start_value jsonb; end_value jsonb; first_start jsonb; first_end jsonb;
begin
  if p_edge not in ('start','end') then raise exception 'Invalid period edge' using errcode='22023'; end if;
  if p_object#>'{items,has_more}'='true'::jsonb then
    raise exception 'Paginated subscription periods unsupported' using errcode='23514';
  end if;
  if jsonb_typeof(p_object->'current_period_start')='number' and
     jsonb_typeof(p_object->'current_period_end')='number' then
    first_start:=p_object->'current_period_start'; first_end:=p_object->'current_period_end';
  end if;
  if p_object ? 'items' then
    if jsonb_typeof(p_object#>'{items,data}') is distinct from 'array' or
      jsonb_array_length(p_object#>'{items,data}')=0 then
      raise exception 'Missing subscription periods' using errcode='23514';
    end if;
    for item in select value from jsonb_array_elements(p_object#>'{items,data}') loop
      start_value:=item->'current_period_start'; end_value:=item->'current_period_end';
      if first_start is null then first_start:=start_value; first_end:=end_value; end if;
      if start_value is distinct from first_start or end_value is distinct from first_end then
        raise exception 'Mixed subscription periods unsupported' using errcode='23514';
      end if;
    end loop;
  end if;
  if first_start is null or first_end is null or
    public.stripe_epoch_timestamp(first_end)<=public.stripe_epoch_timestamp(first_start) then
    raise exception 'Invalid subscription periods' using errcode='23514';
  end if;
  return case p_edge when 'start' then first_start else first_end end;
end $$;
revoke all on function kma_internal.stripe_subscription_period(jsonb,text) from public,anon,authenticated,service_role;

create function public.supplement_stripe_subscription_event(p_provider_event_id uuid,p_claim_token uuid,p_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare pe public.provider_events%rowtype; old_payload jsonb; item jsonb;
begin
  select * into pe from public.provider_events where id=p_provider_event_id for share;
  if pe.provider is distinct from 'stripe' or not pe.signature_verified or
    pe.event_type not in ('customer.subscription.created','customer.subscription.updated','customer.subscription.deleted') or
    pe.payload#>'{data,object,items}' is not null or
    jsonb_typeof(pe.payload#>'{data,object,current_period_start}')='number' or
    not exists(select 1 from public.provider_event_processing where provider_event_id=pe.id
      and status='processing' and claim_token=p_claim_token and lease_expires_at>now()) then
    raise exception 'Recovery scope or lease invalid' using errcode='23514';
  end if;
  if (p_payload #- '{data,object,items}') is distinct from pe.payload or
    jsonb_typeof(p_payload#>'{data,object,items,data}') is distinct from 'array' or
    exists(select 1 from jsonb_object_keys(p_payload#>'{data,object,items}') key where key not in ('data','has_more')) then
    raise exception 'Original event identity changed' using errcode='23514';
  end if;
  for item in select value from jsonb_array_elements(p_payload#>'{data,object,items,data}') loop
    if jsonb_typeof(item) is distinct from 'object' or
      not public.stripe_json_has_exact_keys(item,array['current_period_start','current_period_end'],array['current_period_start','current_period_end']) then
      raise exception 'Unexpected recovery data' using errcode='23514';
    end if;
  end loop;
  perform kma_internal.stripe_subscription_period(p_payload#>'{data,object}','start');
  insert into kma_internal.stripe_subscription_event_supplements(provider_event_id,payload)
    values(pe.id,p_payload) on conflict do nothing;
  select payload into old_payload from kma_internal.stripe_subscription_event_supplements where provider_event_id=pe.id;
  if old_payload is distinct from p_payload then raise exception 'Recovery evidence conflict' using errcode='23505'; end if;
end $$;
revoke all on function public.supplement_stripe_subscription_event(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.supplement_stripe_subscription_event(uuid,uuid,jsonb) to service_role;

-- Assert exact source fragments before replacing them. All identity, claim,
-- settlement, zero-total, ordering and idempotency checks remain in place.
do $patch$
declare body text; before text; after text;
begin
  body:=pg_get_functiondef('public.normalize_stripe_provider_event(uuid,uuid,jsonb)'::regprocedure);
  before:='provider_object := provider_record.payload #> ''{data,object}'';';
  after:='provider_object := coalesce((select s.payload #> ''{data,object}'' from kma_internal.stripe_subscription_event_supplements s where s.provider_event_id=provider_record.id), provider_record.payload #> ''{data,object}'');';
  if (length(body)-length(replace(body,before,'')))/length(before)<>1 then raise exception 'Normalizer source drift'; end if;
  body:=replace(body,before,after);
  foreach before in array array['start','end'] loop
    after:='public.stripe_epoch_timestamp(provider_object -> ''current_period_'||before||''')';
    if (length(body)-length(replace(body,after,'')))/length(after)<>1 then raise exception 'Period source drift'; end if;
    body:=replace(body,after,'public.stripe_epoch_timestamp(kma_internal.stripe_subscription_period(provider_object,'''||before||'''))');
  end loop;
  before:='provider_object -> ''paid'' is distinct from ''true''::jsonb';
  if (length(body)-length(replace(body,before,'')))/length(before)<>1 then raise exception 'Invoice source drift'; end if;
  body:=replace(body,before,'(provider_object ? ''paid'' and provider_object -> ''paid'' is distinct from ''true''::jsonb)');
  execute body;
  body:=pg_get_functiondef('public.normalize_stripe_zero_total_event(uuid,uuid,jsonb)'::regprocedure);
  before:='obj->''paid'' is distinct from ''true''::jsonb';
  if (length(body)-length(replace(body,before,'')))/length(before)<>1 then raise exception 'Zero invoice source drift'; end if;
  execute replace(body,before,'(obj ? ''paid'' and obj->''paid'' is distinct from ''true''::jsonb)');
end $patch$;
commit;
