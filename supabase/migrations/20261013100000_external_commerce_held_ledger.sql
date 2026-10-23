-- SpeakSix one-off merchant ingress. No activation, commission approval, transfer
-- or payout occurs here. Configure scopes separately after merchant verification.
begin;
create table public.external_commerce_merchants (
 product_id uuid not null references public.products(id),funnel_id uuid not null references public.funnels(id),
 stripe_account_id text not null check(stripe_account_id~'^acct_[A-Za-z0-9]+$'),livemode boolean not null,
 enabled boolean not null default false,created_at timestamptz not null default now(),
 primary key(product_id,funnel_id,stripe_account_id,livemode)
);
create table public.external_commerce_orders (
 id uuid primary key default gen_random_uuid(),external_order_id uuid not null,
 product_id uuid not null,funnel_id uuid not null,stripe_account_id text not null,livemode boolean not null,
 click_record_id uuid not null references public.clicks(id),acquisition_id uuid not null references public.acquisitions(id),affiliate_id uuid not null references public.affiliates(id),
 stripe_session_id text not null, stripe_payment_intent_id text not null,
 amount_minor bigint not null check(amount_minor>0),currency text not null check(currency~'^[A-Z]{3}$'),attribution_sha256 text not null check(attribution_sha256~'^[a-f0-9]{64}$'),
 commission_status text not null default 'held' check(commission_status='held'),
 hold_reason text not null default 'External merchant contract and commission terms require approval.',
 created_at timestamptz not null default now(),
 foreign key(product_id,funnel_id,stripe_account_id,livemode) references public.external_commerce_merchants(product_id,funnel_id,stripe_account_id,livemode),
 unique(stripe_account_id,livemode,external_order_id),unique(stripe_account_id,livemode,stripe_payment_intent_id),unique(stripe_account_id,livemode,stripe_session_id)
);
create table public.external_commerce_events (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.external_commerce_orders(id),
 kind text not null check(kind in('purchase','refund')),provider_id text not null,amount_minor bigint not null check(amount_minor>0),
 provider_occurred_at timestamptz not null,evidence jsonb not null,created_at timestamptz not null default now(),unique(order_id,kind)
);
create table public.external_commerce_receipts (
 stripe_account_id text not null,livemode boolean not null,external_event_id uuid not null,
 event_id uuid not null references public.external_commerce_events(id),evidence jsonb not null,created_at timestamptz not null default now(),
 primary key(stripe_account_id,livemode,external_event_id)
);
create function kma_internal.external_commerce_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'External commercial evidence is immutable; append a verified refund instead.' using errcode='22023';end $$;
create trigger external_commerce_order_immutable before update or delete on public.external_commerce_orders for each row execute function kma_internal.external_commerce_immutable();
create trigger external_commerce_event_immutable before update or delete on public.external_commerce_events for each row execute function kma_internal.external_commerce_immutable();
create trigger external_commerce_receipt_immutable before update or delete on public.external_commerce_receipts for each row execute function kma_internal.external_commerce_immutable();

create function public.ingest_external_commerce(p_evidence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare input jsonb:=p_evidence->'input';product uuid:=(p_evidence->>'product_id')::uuid;funnel uuid:=(p_evidence->>'funnel_id')::uuid;
 account text:=input->>'account_id';live boolean:=(input->>'livemode')::boolean;external_id uuid:=(input->>'event_id')::uuid;external_order uuid:=(input->>'order_id')::uuid;
 click_record public.clicks;acquisition public.acquisitions;stored public.external_commerce_orders;receipt public.external_commerce_receipts;fact public.external_commerce_events;
 token text:=input->>'click_id';kind_value text:=input->>'kind';amount_value bigint:=(input->>'amount_minor')::bigint;provider text;duplicate_value boolean:=false;
 normalized jsonb;
begin
 if jsonb_typeof(input) is distinct from 'object' or account is null or account!~'^acct_[A-Za-z0-9]+$' or live is null or external_id is null or external_order is null or product is null or funnel is null or token is null or token!~'^[A-Za-z0-9_-]{16,128}$' or kind_value is null or kind_value not in('purchase','refund') or amount_value is null or amount_value<=0 or input->>'currency' is null or input->>'currency'!~'^[A-Z]{3}$' or p_evidence->>'attribution_sha256' is null or p_evidence->>'attribution_sha256'!~'^[a-f0-9]{64}$' or input->'attribution'->>'kmaClick' is distinct from token or p_evidence->>'provider_occurred_at' is null then raise exception 'Invalid verified commerce evidence.' using errcode='22023';end if;
 if input->>'checkout_session_id' is null or input->>'checkout_session_id'!~'^cs_[A-Za-z0-9_]+$' or input->>'payment_intent_id' is null or input->>'payment_intent_id'!~'^pi_[A-Za-z0-9]+$' then raise exception 'Invalid provider identity.' using errcode='22023';end if;
 if not exists(select 1 from public.external_commerce_merchants m where m.product_id=product and m.funnel_id=funnel and m.stripe_account_id=account and m.livemode=live and m.enabled) then raise exception 'Merchant not enabled.' using errcode='P0002';end if;
 perform public.assert_funnel_request_scope('external-commerce',token,product,funnel);
 select * into click_record from public.clicks where public_click_id=token;
 select * into acquisition from public.acquisitions where click_record_id=click_record.id;
 provider:=case when kind_value='purchase' then input->>'payment_intent_id' else input->>'refund_id' end;
 if provider is null or (kind_value='refund' and provider!~'^re_[A-Za-z0-9]+$') or (kind_value='purchase' and input?'refund_id') then raise exception 'Invalid commercial event kind.' using errcode='22023';end if;
 -- Lock both logical event and provider payment, so different request IDs and
 -- out-of-order refund/purchase arrivals cannot reassign attribution or duplicate.
 perform pg_advisory_xact_lock(hashtextextended(account||live::text||external_id::text,57));
 perform pg_advisory_xact_lock(hashtextextended(account||live::text||(input->>'payment_intent_id'),58));
 select * into receipt from public.external_commerce_receipts where stripe_account_id=account and livemode=live and external_event_id=external_id;
 if found then
  if receipt.evidence is distinct from p_evidence then raise exception 'External event ID changed.' using errcode='22023';end if;
  return jsonb_build_object('event_id',receipt.event_id,'duplicate',true);
 end if;
 select * into stored from public.external_commerce_orders where stripe_account_id=account and livemode=live and external_order_id=external_order;
 if not found then
  insert into public.external_commerce_orders(external_order_id,product_id,funnel_id,stripe_account_id,livemode,click_record_id,acquisition_id,affiliate_id,stripe_session_id,stripe_payment_intent_id,amount_minor,currency,attribution_sha256)
  values(external_order,product,funnel,account,live,click_record.id,acquisition.id,click_record.affiliate_id,input->>'checkout_session_id',input->>'payment_intent_id',amount_value,input->>'currency',p_evidence->>'attribution_sha256') returning * into stored;
 end if;
 if stored.product_id<>product or stored.funnel_id<>funnel or stored.click_record_id<>click_record.id or stored.acquisition_id<>acquisition.id or stored.stripe_session_id is distinct from input->>'checkout_session_id' or stored.stripe_payment_intent_id is distinct from input->>'payment_intent_id' or stored.amount_minor<>amount_value or stored.currency is distinct from input->>'currency' or stored.attribution_sha256 is distinct from p_evidence->>'attribution_sha256' then raise exception 'Order evidence changed.' using errcode='22023';end if;
 normalized:=jsonb_set(p_evidence,'{input}',input-array['event_id','occurred_at']);
 select * into fact from public.external_commerce_events where order_id=stored.id and kind=kind_value;
 if found then
  if fact.evidence is distinct from normalized then raise exception 'Provider fact changed.' using errcode='22023';end if;
  duplicate_value:=true;
 else
  insert into public.external_commerce_events(order_id,kind,provider_id,amount_minor,provider_occurred_at,evidence)
  values(stored.id,kind_value,provider,amount_value,(p_evidence->>'provider_occurred_at')::timestamptz,normalized) returning * into fact;
 end if;
 insert into public.external_commerce_receipts(stripe_account_id,livemode,external_event_id,event_id,evidence) values(account,live,external_id,fact.id,p_evidence);
 return jsonb_build_object('event_id',fact.id,'duplicate',duplicate_value);
end $$;

do $$declare target text;begin
 foreach target in array array['external_commerce_merchants','external_commerce_orders','external_commerce_events','external_commerce_receipts'] loop
  execute format('alter table public.%I enable row level security',target);
  execute format('revoke all on public.%I from public,anon,authenticated',target);
  execute format('grant select on public.%I to service_role',target);
 end loop;
end $$;
grant insert,update on public.external_commerce_merchants to service_role;
revoke all on function public.ingest_external_commerce(jsonb) from public,anon,authenticated;
grant execute on function public.ingest_external_commerce(jsonb) to service_role;
revoke all on function kma_internal.external_commerce_immutable() from public,anon,authenticated;
comment on table public.external_commerce_orders is 'Held, external merchant evidence only. No affiliate commission or payout is created by this ledger.';
commit;
