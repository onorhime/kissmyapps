-- Additive KMA-owned, one-time checkout. All activation switches default off.
-- Existing subscription attempts, commission rates and payout policy are unchanged.
begin;
create table public.managed_payment_offer_prices (
 offer_id uuid not null references public.billing_offers,account_id text not null check(account_id~'^acct_[A-Za-z0-9]+$'),livemode boolean not null,
 stripe_price_id text not null check(stripe_price_id~'^price_[A-Za-z0-9_]{8,128}$'),currency text not null check(currency~'^[A-Z]{3}$'),unit_amount_minor bigint not null check(unit_amount_minor>0),
 offer_version integer not null,configured_price_id text not null,verified_at timestamptz not null default now(),primary key(offer_id,account_id,livemode)
);
alter table public.managed_payment_offer_prices enable row level security;
revoke all on public.managed_payment_offer_prices from public,anon,authenticated,service_role;
grant select on public.managed_payment_offer_prices to service_role;
create function public.get_admin_managed_price_verification_candidate(p_billing_offer_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare base jsonb;o public.billing_offers;
begin
 base:=public.get_admin_billing_offer_verification_candidate(p_billing_offer_id);
 select * into o from public.billing_offers where id=p_billing_offer_id;
 if o.billing_mode<>'payment' then raise exception 'Managed verification is for one-time offers only' using errcode='22023';end if;
 return base||jsonb_build_object('product_id',o.product_id,'offer_version',o.version);
end $$;
revoke all on function public.get_admin_managed_price_verification_candidate(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_admin_managed_price_verification_candidate(uuid) to authenticated;
create function public.record_managed_price_verification(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.billing_offers;m public.managed_payment_offer_prices;
begin
 select * into o from public.billing_offers where id=(p_input->>'billing_offer_id')::uuid for update;
 if not found or o.status<>'draft' or o.billing_mode<>'payment' or o.product_id::text is distinct from p_input->>'product_id' or o.version is distinct from (p_input->>'offer_version')::integer or o.stripe_price_id is distinct from p_input->>'configured_price_id' or o.currency is distinct from p_input->>'currency' or o.unit_amount_minor is distinct from (p_input->>'unit_amount_minor')::bigint or jsonb_typeof(p_input->'livemode') is distinct from 'boolean' then raise exception 'Managed Price must match the current draft offer' using errcode='22023';end if;
 insert into public.managed_payment_offer_prices(offer_id,account_id,livemode,stripe_price_id,currency,unit_amount_minor,offer_version,configured_price_id) values(o.id,p_input->>'account_id',(p_input->>'livemode')::boolean,p_input->>'stripe_price_id',o.currency,o.unit_amount_minor,o.version,o.stripe_price_id) on conflict(offer_id,account_id,livemode) do update set stripe_price_id=excluded.stripe_price_id,currency=excluded.currency,unit_amount_minor=excluded.unit_amount_minor,offer_version=excluded.offer_version,configured_price_id=excluded.configured_price_id,verified_at=clock_timestamp() returning * into m;
 return to_jsonb(m);
end $$;
revoke all on function public.record_managed_price_verification(jsonb) from public,anon,authenticated;
grant execute on function public.record_managed_price_verification(jsonb) to service_role;
create table public.managed_checkout_orders (
 id uuid primary key default gen_random_uuid(), binding_id text not null,
 product_id uuid not null references public.products, funnel_id uuid not null references public.funnels,
 account_id text not null check(account_id~'^acct_[A-Za-z0-9]+$'), livemode boolean not null,
 external_order_id uuid not null, attempt_id uuid not null, learner_id text not null,
 reservation_id text not null, reservation_expires_at timestamptz not null, context jsonb not null,
 offer_id uuid not null references public.billing_offers, offer_key text not null, offer_version integer not null,
 stripe_price_id text not null, amount_minor bigint not null check(amount_minor>0), currency text not null check(currency~'^[A-Z]{3}$'),
 request jsonb not null, attribution_sha256 text not null check(attribution_sha256~'^[a-f0-9]{64}$'),
 status text not null default 'creating' check(status in('creating','open','processing','paid','expired','partially_refunded','refunded','disputed')),
 checkout_session_id text, checkout_url text, payment_intent_id text, expires_at timestamptz not null,
 session_status text, payment_status text, paid_at timestamptz, refunded_amount_minor bigint not null default 0,
 refund_id text, refund_status text, refund_created_at timestamptz, dispute_status text, duplicate_capture boolean not null default false,
 is_primary_capture boolean not null default false, revision bigint not null default 1,
 created_at timestamptz not null default now(), first_attempt_at timestamptz,
 next_reconcile_at timestamptz not null default now(), commission_recorded boolean not null default false,
 reconcile_attempts integer not null default 0,last_reconcile_error text,
 unique(product_id,funnel_id,account_id,livemode,attempt_id),
 unique(account_id,livemode,checkout_session_id),unique(account_id,livemode,payment_intent_id),
 check(refunded_amount_minor between 0 and amount_minor)
);
create unique index managed_checkout_one_primary on public.managed_checkout_orders(product_id,funnel_id,account_id,livemode,external_order_id) where is_primary_capture;
create index managed_checkout_reconcile_due on public.managed_checkout_orders(next_reconcile_at);
create table public.managed_checkout_operations (
 id uuid primary key, order_id uuid not null references public.managed_checkout_orders,
 action text not null check(action in('create','expire','refund')), request jsonb not null, amount_minor bigint,
 first_attempt_at timestamptz not null default now(), provider_id text, completed_at timestamptz,
 unique(order_id,id)
);
create table public.managed_checkout_facts (
 order_id uuid not null references public.managed_checkout_orders, kind text not null,
 provider_key text not null, evidence jsonb not null, created_at timestamptz not null default now(),
 primary key(order_id,kind,provider_key)
);
create table public.managed_checkout_outbox (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.managed_checkout_orders,
 binding_id text not null, payload jsonb not null, state text not null default 'pending' check(state in('pending','leased','delivered')),
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
 lease_token uuid, lease_expires_at timestamptz, delivered_at timestamptz, last_error text,
 created_at timestamptz not null default now()
);
create index managed_checkout_delivery_due on public.managed_checkout_outbox(next_attempt_at) where state<>'delivered';

create function kma_internal.managed_scope_matches(o public.managed_checkout_orders,s jsonb) returns boolean language sql immutable set search_path='' as $$
 select o.binding_id=s->>'id' and o.product_id=(s->>'product_id')::uuid and o.funnel_id=(s->>'funnel_id')::uuid and o.account_id=s->>'account_id' and o.livemode=(s->>'livemode')::boolean;
$$;
create function kma_internal.managed_public_order(o public.managed_checkout_orders) returns jsonb language sql immutable set search_path='' as $$
 select to_jsonb(o)-array['request','stripe_price_id','first_attempt_at','attribution_sha256','binding_id','created_at','offer_id','next_reconcile_at','commission_recorded','is_primary_capture','reconcile_attempts','last_reconcile_error','refund_created_at'];
$$;
create function public.managed_checkout_quote(p_scope jsonb,p_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare offer public.billing_offers;price public.managed_payment_offer_prices;
begin
 if not exists(select 1 from public.managed_payment_products m join public.products p on p.id=m.product_id where m.product_id=(p_scope->>'product_id')::uuid and m.enabled and p.status='active') or not exists(select 1 from public.funnels where id=(p_scope->>'funnel_id')::uuid and product_id=(p_scope->>'product_id')::uuid) then raise exception 'Managed checkout is not enabled for this product' using errcode='55000';end if;
 select * into offer from public.billing_offers where product_id=(p_scope->>'product_id')::uuid and key=p_key and status='active' and billing_mode='payment';
 if not found then raise exception 'An active one-time offer is required' using errcode='55000';end if;
 select * into price from public.managed_payment_offer_prices where offer_id=offer.id and account_id=p_scope->>'account_id' and livemode=(p_scope->>'livemode')::boolean and offer_version=offer.version and configured_price_id=offer.stripe_price_id and currency=offer.currency and unit_amount_minor=offer.unit_amount_minor;
 if not found then raise exception 'This merchant and payment mode need a verified Price mapping' using errcode='55000';end if;
 return jsonb_build_object('id',offer.id,'key',offer.key,'version',offer.version,'name',offer.name,'currency',offer.currency,'unit_amount_minor',offer.unit_amount_minor,'billing_mode','payment','stripe_price_id',price.stripe_price_id);
end $$;
create function public.get_managed_checkout(p_scope jsonb,p_attempt_id uuid,p_order_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.managed_checkout_orders;
begin
 select * into o from public.managed_checkout_orders where attempt_id=p_attempt_id and kma_internal.managed_scope_matches(managed_checkout_orders,p_scope);
 if not found or (p_order_id is not null and o.external_order_id<>p_order_id) then raise exception 'Checkout attempt unavailable' using errcode='P0002';end if;
 return to_jsonb(o);
end $$;
create function public.prepare_managed_checkout(p_scope jsonb,p_input jsonb,p_attribution_sha256 text) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.managed_checkout_orders; prior public.managed_checkout_orders; offer jsonb; expiry timestamptz;
begin
 if p_input->>'action'<>'create' or (p_input->>'attempt_id')::uuid is distinct from (p_input->>'request_id')::uuid or p_attribution_sha256!~'^[a-f0-9]{64}$' then raise exception 'Invalid checkout request' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended((p_scope->>'account_id')||(p_scope->>'livemode')||(p_input->>'order_id'),1600));
 select * into o from public.managed_checkout_orders where attempt_id=(p_input->>'attempt_id')::uuid and kma_internal.managed_scope_matches(managed_checkout_orders,p_scope);
 if found then
  if o.request is distinct from p_input or o.attribution_sha256<>p_attribution_sha256 then raise exception 'Attempt input is immutable' using errcode='22023';end if;
  return to_jsonb(o);
 end if;
 select * into prior from public.managed_checkout_orders where external_order_id=(p_input->>'order_id')::uuid and kma_internal.managed_scope_matches(managed_checkout_orders,p_scope) order by created_at desc limit 1;
 if found then
  if prior.learner_id is distinct from p_input->>'learner_id' or prior.context is distinct from p_input->'context' or prior.reservation_id is distinct from p_input->>'reservation_id' or prior.reservation_expires_at is distinct from (p_input->>'reservation_expires_at')::timestamptz or prior.offer_key is distinct from p_input->>'offer_key' or prior.offer_version is distinct from (p_input->>'offer_version')::integer or prior.amount_minor is distinct from (p_input->>'amount_minor')::bigint or prior.currency is distinct from p_input->>'currency' or prior.attribution_sha256<>p_attribution_sha256 then raise exception 'Order identity cannot change' using errcode='22023';end if;
  if exists(select 1 from public.managed_checkout_orders where external_order_id=prior.external_order_id and kma_internal.managed_scope_matches(managed_checkout_orders,p_scope) and status<>'expired') then raise exception 'Existing checkout must be definitively expired before another attempt' using errcode='55000';end if;
  -- Renew the frozen business reservation at its agreed Price. Current catalog
  -- edits cannot silently reprice it; the provider still re-verifies this Price.
  offer:=jsonb_build_object('id',prior.offer_id,'key',prior.offer_key,'version',prior.offer_version,'stripe_price_id',prior.stripe_price_id,'unit_amount_minor',prior.amount_minor,'currency',prior.currency);
 else
  offer:=public.managed_checkout_quote(p_scope,p_input->>'offer_key');
 end if;
 if (offer->>'version')::integer is distinct from (p_input->>'offer_version')::integer or (offer->>'unit_amount_minor')::bigint is distinct from (p_input->>'amount_minor')::bigint or offer->>'currency' is distinct from p_input->>'currency' then raise exception 'Offer changed; review the current price' using errcode='22023';end if;
 expiry:=date_trunc('second',(p_input->>'checkout_expires_at')::timestamptz);
 if expiry is null or expiry<clock_timestamp()+interval '31 minutes' or expiry>(p_input->>'reservation_expires_at')::timestamptz or expiry>clock_timestamp()+interval '23 hours 55 minutes' then raise exception 'Checkout must have 31 minutes to 23 hours 55 minutes remaining within the reservation' using errcode='55000';end if;
 if p_input?'click_id' then perform public.assert_funnel_request_scope('managed-checkout',p_input->>'click_id',(p_scope->>'product_id')::uuid,(p_scope->>'funnel_id')::uuid);end if;
 insert into public.managed_checkout_orders(binding_id,product_id,funnel_id,account_id,livemode,external_order_id,attempt_id,learner_id,reservation_id,reservation_expires_at,context,offer_id,offer_key,offer_version,stripe_price_id,amount_minor,currency,request,attribution_sha256,expires_at)
 values(p_scope->>'id',(p_scope->>'product_id')::uuid,(p_scope->>'funnel_id')::uuid,p_scope->>'account_id',(p_scope->>'livemode')::boolean,(p_input->>'order_id')::uuid,(p_input->>'attempt_id')::uuid,p_input->>'learner_id',p_input->>'reservation_id',(p_input->>'reservation_expires_at')::timestamptz,p_input->'context',(offer->>'id')::uuid,offer->>'key',(offer->>'version')::integer,offer->>'stripe_price_id',(offer->>'unit_amount_minor')::bigint,offer->>'currency',p_input,p_attribution_sha256,expiry) returning * into o;
 return to_jsonb(o);
end $$;
create function public.begin_managed_checkout_operation(p_scope jsonb,p_attempt_id uuid,p_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.managed_checkout_orders; op public.managed_checkout_operations; action_value text:=p_request->>'action';effective_amount bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_attempt_id::text,1601));
 o:=jsonb_populate_record(null::public.managed_checkout_orders,public.get_managed_checkout(p_scope,p_attempt_id,(p_request->>'order_id')::uuid));
 select * into op from public.managed_checkout_operations where id=(p_request->>'request_id')::uuid;
 if found then
  if op.order_id<>o.id or op.request is distinct from p_request then raise exception 'Operation identity cannot change' using errcode='22023';end if;
  return to_jsonb(op);
 end if;
 if action_value not in('create','expire','refund') then raise exception 'Invalid operation' using errcode='22023';end if;
 if action_value='create' and (o.checkout_session_id is not null or o.status<>'creating') then raise exception 'Checkout already exists' using errcode='55000';end if;
 if action_value='refund' then
  effective_amount:=case when p_request->>'refund_remaining'='true' then o.amount_minor-o.refunded_amount_minor else (p_request->>'amount_minor')::bigint end;
  if p_request->>'refund_remaining'='true' and (p_request->>'amount_minor')::bigint is distinct from o.amount_minor then raise exception 'Refund original amount assertion differs' using errcode='22023';end if;
  if o.paid_at is null or o.payment_intent_id is null or effective_amount<=0 or effective_amount>o.amount_minor-o.refunded_amount_minor then raise exception 'Refund exceeds verified remaining payment' using errcode='22023';end if;
  if exists(select 1 from public.managed_checkout_operations where order_id=o.id and action='refund' and completed_at is null) then raise exception 'An earlier refund must be reconciled first' using errcode='55000';end if;
 end if;
 insert into public.managed_checkout_operations(id,order_id,action,request,amount_minor) values((p_request->>'request_id')::uuid,o.id,action_value,p_request,effective_amount) returning * into op;
 if action_value='create' then update public.managed_checkout_orders set first_attempt_at=op.first_attempt_at where id=o.id;end if;
 return to_jsonb(op);
end $$;
create function public.complete_managed_checkout_operation(p_scope jsonb,p_attempt_id uuid,p_request_id uuid,p_provider_id text) returns void language plpgsql security definer set search_path='' as $$
declare o public.managed_checkout_orders;op public.managed_checkout_operations;
begin
 o:=jsonb_populate_record(null::public.managed_checkout_orders,public.get_managed_checkout(p_scope,p_attempt_id));
 select * into op from public.managed_checkout_operations where id=p_request_id and order_id=o.id for update;
 if not found or op.provider_id is not null and op.provider_id<>p_provider_id then raise exception 'Operation receipt conflicts' using errcode='22023';end if;
 update public.managed_checkout_operations set provider_id=p_provider_id,completed_at=coalesce(completed_at,clock_timestamp()) where id=op.id;
end $$;
create function public.record_managed_checkout_snapshot(p_scope jsonb,p_attempt_id uuid,p_snapshot jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.managed_checkout_orders; old_o public.managed_checkout_orders; paid boolean; duplicate_value boolean; f jsonb; previous jsonb; event_type text; event_id uuid; fact_key text; observed_refunds bigint; dispute text; refund_op public.managed_checkout_operations;
begin
 o:=jsonb_populate_record(null::public.managed_checkout_orders,public.get_managed_checkout(p_scope,p_attempt_id));
 perform pg_advisory_xact_lock(hashtextextended(o.account_id||o.livemode::text||o.external_order_id::text,1600));
 select * into o from public.managed_checkout_orders where id=o.id for update;old_o:=o;
 if p_snapshot->>'checkout_session_id'!~'^cs_[A-Za-z0-9_]+$' or (o.checkout_session_id is not null and o.checkout_session_id is distinct from p_snapshot->>'checkout_session_id') or (p_snapshot->>'amount_minor')::bigint is distinct from o.amount_minor or p_snapshot->>'currency' is distinct from o.currency or p_snapshot->>'account_id' is distinct from o.account_id or (p_snapshot->>'livemode')::boolean is distinct from o.livemode or (p_snapshot->>'expires_at')::timestamptz>o.reservation_expires_at or (o.payment_intent_id is not null and p_snapshot->>'payment_intent_id' is not null and o.payment_intent_id is distinct from p_snapshot->>'payment_intent_id') then raise exception 'Provider snapshot does not match the order' using errcode='22023';end if;
 paid:=p_snapshot->>'session_status'='complete' and p_snapshot->>'payment_status'='paid';
 if o.paid_at is not null and not paid then raise exception 'Paid evidence cannot be downgraded' using errcode='22023';end if;
 if paid and (p_snapshot->>'payment_intent_id'!~'^pi_[A-Za-z0-9]+$' or p_snapshot->>'paid_at' is null) then raise exception 'Paid identity missing' using errcode='22023';end if;
 duplicate_value:=paid and exists(select 1 from public.managed_checkout_orders x where x.product_id=o.product_id and x.funnel_id=o.funnel_id and x.account_id=o.account_id and x.livemode=o.livemode and x.external_order_id=o.external_order_id and x.is_primary_capture and x.id<>o.id);
 for f in select value from jsonb_array_elements(coalesce(p_snapshot->'facts','[]')) loop
  if f->>'kind' not in('refund','dispute') or f->>'provider_key' is null or jsonb_typeof(f->'evidence')<>'object' then raise exception 'Invalid provider fact' using errcode='22023';end if;
  select evidence into previous from public.managed_checkout_facts where order_id=o.id and kind=f->>'kind' and provider_key=f->>'provider_key';
  if found and previous is distinct from f->'evidence' then raise exception 'Provider fact identity changed' using errcode='22023';end if;
  insert into public.managed_checkout_facts(order_id,kind,provider_key,evidence) values(o.id,f->>'kind',f->>'provider_key',f->'evidence') on conflict do nothing;
 end loop;
 select coalesce(sum((evidence->>'amount_minor')::bigint),0) into observed_refunds from public.managed_checkout_facts where order_id=o.id and kind='refund';
 if observed_refunds<o.refunded_amount_minor or observed_refunds>o.amount_minor then raise exception 'Refund evidence exceeds original payment' using errcode='22023';end if;
 -- Reconciliation completes pending operation identities even when the caller
 -- never retries the original refund request. Later refunds remain possible.
 for f in select value from jsonb_array_elements(coalesce(p_snapshot->'refund_operations','[]')) loop
  select * into refund_op from public.managed_checkout_operations where id=(f->>'operation_id')::uuid and order_id=o.id and action='refund' for update;
  if not found or refund_op.amount_minor is distinct from (f->>'amount_minor')::bigint or (refund_op.provider_id is not null and refund_op.provider_id<>f->>'refund_id') or f->>'status' not in('succeeded','failed','canceled','pending','requires_action') then raise exception 'Refund operation evidence conflicts' using errcode='22023';end if;
  update public.managed_checkout_operations set provider_id=f->>'refund_id',completed_at=case when f->>'status' in('succeeded','failed','canceled') then coalesce(completed_at,clock_timestamp()) else completed_at end where id=refund_op.id;
 end loop;
 dispute:=case when o.dispute_status in('won','lost') then o.dispute_status else coalesce(p_snapshot->>'dispute_status',o.dispute_status) end;
 -- Pending refund results are durable revisions; stale provider reads cannot
 -- replace them with an older refund or regress a terminal status.
 if o.refund_id is not null and ((p_snapshot->>'refund_created_at')::timestamptz<o.refund_created_at or ((p_snapshot->>'refund_created_at')::timestamptz=o.refund_created_at and p_snapshot->>'refund_id'<>o.refund_id and not exists(select 1 from public.managed_checkout_operations incoming where incoming.id=(p_snapshot->>'refund_operation_id')::uuid and incoming.order_id=o.id and incoming.first_attempt_at>coalesce((select previous_op.first_attempt_at from public.managed_checkout_operations previous_op where previous_op.order_id=o.id and previous_op.provider_id=o.refund_id limit 1),'-infinity'::timestamptz))) or (p_snapshot->>'refund_id'=o.refund_id and o.refund_status in('succeeded','failed','canceled') and p_snapshot->>'refund_status' not in('succeeded','failed','canceled'))) then p_snapshot:=p_snapshot-array['refund_id','refund_status','refund_created_at'];end if;
 update public.managed_checkout_orders set
 checkout_session_id=p_snapshot->>'checkout_session_id',checkout_url=case when p_snapshot->>'session_status'='open' then p_snapshot->>'checkout_url' else null end,
 payment_intent_id=coalesce(p_snapshot->>'payment_intent_id',payment_intent_id),expires_at=(p_snapshot->>'expires_at')::timestamptz,
 session_status=p_snapshot->>'session_status',payment_status=p_snapshot->>'payment_status',paid_at=case when paid then coalesce(paid_at,(p_snapshot->>'paid_at')::timestamptz) else paid_at end,
 is_primary_capture=is_primary_capture or (paid and not duplicate_value),duplicate_capture=duplicate_capture or duplicate_value,refunded_amount_minor=observed_refunds,
 refund_id=coalesce(p_snapshot->>'refund_id',refund_id),refund_status=coalesce(p_snapshot->>'refund_status',refund_status),refund_created_at=coalesce((p_snapshot->>'refund_created_at')::timestamptz,refund_created_at),dispute_status=dispute,
 status=case when dispute is not null and dispute<>'won' then 'disputed' when observed_refunds=amount_minor then 'refunded' when observed_refunds>0 then 'partially_refunded' when paid then 'paid' when p_snapshot->>'session_status'='expired' then 'expired' when p_snapshot->>'session_status'='complete' then 'processing' else 'open' end,
 next_reconcile_at=clock_timestamp()+interval '5 minutes'
 where id=o.id returning * into o;
 if kma_internal.managed_public_order(o) is distinct from kma_internal.managed_public_order(old_o) then
  update public.managed_checkout_orders set revision=revision+1 where id=o.id returning * into o;
  event_type:=case when o.dispute_status is distinct from old_o.dispute_status then case when o.dispute_status in('won','lost') then 'order.dispute_closed' else 'order.disputed' end when o.refunded_amount_minor>old_o.refunded_amount_minor then case when o.refunded_amount_minor=o.amount_minor then 'order.refunded' else 'order.partially_refunded' end when o.paid_at is not null and old_o.paid_at is null then 'order.paid' when o.status='expired' and old_o.status<>'expired' then 'order.expired' else null end;
  -- A refund/dispute observed with the first payment still delivers complete
  -- paid evidence first; the snapshot already prevents granting a reversed sale.
  if event_type is not null then
   event_id:=gen_random_uuid();
   insert into public.managed_checkout_outbox(id,order_id,binding_id,payload) values(event_id,o.id,o.binding_id,jsonb_build_object('version',1,'event_id',event_id,'type',event_type,'occurred_at',clock_timestamp(),'product_id',o.product_id,'funnel_id',o.funnel_id,'account_id',o.account_id,'livemode',o.livemode,'order',kma_internal.managed_public_order(o)-'checkout_url'));
  end if;
 end if;
 return to_jsonb(o);
end $$;
create function public.managed_checkout_reconcile_candidates(p_scope jsonb,p_limit integer default 10) returns setof jsonb language sql security definer set search_path='' as $$
 select to_jsonb(o) from public.managed_checkout_orders o where kma_internal.managed_scope_matches(o,p_scope) and o.next_reconcile_at<=clock_timestamp() and (o.status in('creating','open','processing') or (o.paid_at is not null and o.created_at>clock_timestamp()-interval '180 days')) order by o.next_reconcile_at,o.id limit greatest(1,least(p_limit,25));
$$;
create function public.managed_checkout_reconcile_failure(p_scope jsonb,p_attempt_id uuid,p_error text) returns void language plpgsql security definer set search_path='' as $$
declare o public.managed_checkout_orders;
begin
 o:=jsonb_populate_record(null::public.managed_checkout_orders,public.get_managed_checkout(p_scope,p_attempt_id));
 update public.managed_checkout_orders set reconcile_attempts=reconcile_attempts+1,last_reconcile_error=left(p_error,120),next_reconcile_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,least(reconcile_attempts,7)))::integer) where id=o.id;
end $$;
create function public.managed_checkout_record_commission(p_scope jsonb,p_attempt_id uuid,p_evidence jsonb,p_basis jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.managed_checkout_orders;receipt jsonb;
begin
 o:=jsonb_populate_record(null::public.managed_checkout_orders,public.get_managed_checkout(p_scope,p_attempt_id));
 if not o.is_primary_capture or o.duplicate_capture or o.paid_at is null or o.request->>'click_id' is null then return jsonb_build_object('eligible',false);end if;
 if p_evidence->'input'->>'order_id' is distinct from o.external_order_id::text or p_evidence->'input'->>'payment_intent_id' is distinct from o.payment_intent_id or p_evidence->'input'->>'checkout_session_id' is distinct from o.checkout_session_id or p_evidence->'input'->>'click_id' is distinct from o.request->>'click_id' or p_evidence->>'attribution_sha256' is distinct from o.attribution_sha256 or p_evidence->>'product_id' is distinct from o.product_id::text or p_evidence->>'funnel_id' is distinct from o.funnel_id::text then raise exception 'Managed commission identity mismatch' using errcode='22023';end if;
 receipt:=public.ingest_external_commerce(p_evidence);
 if p_basis is not null then perform public.record_external_commission_basis(p_basis);end if;
 update public.managed_checkout_orders set commission_recorded=true where id=o.id;
 return receipt;
end $$;
create function public.claim_managed_checkout_deliveries(p_binding_id text,p_limit integer default 10) returns setof jsonb language plpgsql security definer set search_path='' as $$
declare e public.managed_checkout_outbox;
begin
 for e in select * from public.managed_checkout_outbox where binding_id=p_binding_id and ((state='pending' and next_attempt_at<=clock_timestamp()) or (state='leased' and lease_expires_at<clock_timestamp())) order by created_at,id for update skip locked limit greatest(1,least(p_limit,25)) loop
  update public.managed_checkout_outbox set state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '60 seconds' where id=e.id returning * into e;return next to_jsonb(e);
 end loop;
end $$;
create function public.finish_managed_checkout_delivery(p_event_id uuid,p_lease_token uuid,p_accepted boolean,p_error text default null) returns void language plpgsql security definer set search_path='' as $$
begin
 update public.managed_checkout_outbox set state=case when p_accepted then 'delivered' else 'pending' end,delivered_at=case when p_accepted then clock_timestamp() else null end,next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,least(attempts,7)))::integer),last_error=case when p_accepted then null else left(p_error,200) end,lease_token=null,lease_expires_at=null where id=p_event_id and state='leased' and lease_token=p_lease_token;
 if not found then raise exception 'Delivery lease changed' using errcode='55000';end if;
end $$;

-- Service role can read for bounded reconciliation only. All writes use scoped
-- routines; browser roles cannot grant payment or mutate outbound evidence.
do $$declare t text;f regprocedure;begin
 foreach t in array array['managed_checkout_orders','managed_checkout_operations','managed_checkout_facts','managed_checkout_outbox'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);execute format('grant select on public.%I to service_role',t);
 end loop;
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like '%managed_checkout%' or p.proname='managed_checkout_quote') loop execute format('revoke all on function %s from public,anon,authenticated',f);execute format('grant execute on function %s to service_role',f);end loop;
end $$;
revoke all on function kma_internal.managed_scope_matches(public.managed_checkout_orders,jsonb),kma_internal.managed_public_order(public.managed_checkout_orders) from public,anon,authenticated,service_role;
create trigger managed_checkout_facts_immutable before update or delete on public.managed_checkout_facts for each row execute function kma_internal.external_commerce_immutable();
commit;
