-- Merchant-owned payments are opt-in. No connection, checkout, or transfer is
-- enabled by this migration. OAuth tokens and raw invitation secrets stay out
-- of the database; only one-use hashes and verified account facts are retained.
begin;
create table public.merchant_businesses (
 id uuid primary key default gen_random_uuid(), business_name text not null check(length(business_name) between 1 and 160),
 email text not null check(length(email)<=254 and email=lower(trim(email)) and email like '%@%'),
 created_by uuid not null references auth.users, created_at timestamptz not null default now()
);
create table public.merchant_connections (
 id uuid primary key default gen_random_uuid(), merchant_id uuid not null references public.merchant_businesses,
 platform_account_id text not null check(platform_account_id~'^acct_[A-Za-z0-9]+$'),livemode boolean not null,
 account_id text check(account_id~'^acct_[A-Za-z0-9]+$'),status text not null default 'pending' check(status in('pending','active','revoked')),
 business_name text,country text,charges_enabled boolean not null default false,payouts_enabled boolean not null default false,details_submitted boolean not null default false,
 confirmed_by uuid references auth.users,confirmed_at timestamptz,verified_at timestamptz,revoked_at timestamptz,
 unique(merchant_id,livemode),check(account_id is null or account_id<>platform_account_id)
);
create unique index merchant_account_one_owner on public.merchant_connections(platform_account_id,livemode,account_id) where account_id is not null and status='active';
create table public.merchant_invitations (
 id uuid primary key default gen_random_uuid(),merchant_id uuid not null references public.merchant_businesses,
 connection_id uuid not null references public.merchant_connections,token_sha256 text not null unique check(token_sha256~'^[a-f0-9]{64}$'),
 email text not null,expires_at timestamptz not null,created_by uuid not null references auth.users,created_at timestamptz not null default now(),
 claimed_by uuid references auth.users,claimed_at timestamptz,confirmed_at timestamptz,revoked_at timestamptz,candidate jsonb
);
create table public.merchant_oauth_states (
 state_sha256 text primary key check(state_sha256~'^[a-f0-9]{64}$'),invitation_id uuid not null references public.merchant_invitations,
 user_id uuid not null references auth.users,expires_at timestamptz not null,created_at timestamptz not null default now(),consumed_at timestamptz,invalidated_at timestamptz
);
create table public.product_merchant_connections (
 product_id uuid not null references public.products,livemode boolean not null,connection_id uuid not null references public.merchant_connections,
 assigned_by uuid not null references auth.users,assigned_at timestamptz not null default now(),primary key(product_id,livemode)
);
do $$declare t text;begin foreach t in array array['merchant_businesses','merchant_connections','merchant_invitations','merchant_oauth_states','product_merchant_connections'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 end loop;end $$;

create function kma_internal.merchant_invitation_view(i public.merchant_invitations) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('invitation_id',i.id,'merchant_id',i.merchant_id,'business_name',b.business_name,'email',i.email,
 'platform_account_id',c.platform_account_id,'livemode',c.livemode,'expires_at',i.expires_at,
 'status',case when i.revoked_at is not null or c.status='revoked' then 'revoked' when i.confirmed_at is not null then 'connected' when i.expires_at<=clock_timestamp() then 'expired' when i.claimed_by is not null then 'claimed' else 'invited' end,
 'candidate',case when i.revoked_at is null and i.expires_at>clock_timestamp() then i.candidate else null end)
 from public.merchant_businesses b join public.merchant_connections c on c.id=i.connection_id where b.id=i.merchant_id;
$$;
create function kma_internal.merchant_invitation_actor(p_id uuid,p_user uuid,p_allow_confirmed boolean default false) returns public.merchant_invitations language plpgsql stable set search_path='' as $$
declare i public.merchant_invitations;begin
 select * into i from public.merchant_invitations where id=p_id;
 if i.id is null or i.claimed_by is distinct from p_user or i.revoked_at is not null or i.expires_at<=clock_timestamp() or (not p_allow_confirmed and i.confirmed_at is not null) or not exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null and lower(trim(email))=i.email) then raise exception 'Merchant invitation is unavailable' using errcode='42501';end if;
 return i;end $$;
create function public.create_admin_merchant_invitation(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.merchant_businesses;c public.merchant_connections;i public.merchant_invitations;expiry timestamptz:=(p_input->>'expires_at')::timestamptz;
begin
 perform public.assert_admin_password(array['owner','operations'],'invite a merchant');
 if coalesce(p_input->>'token_sha256','')!~'^[a-f0-9]{64}$' or coalesce(trim(p_input->>'business_name'),'')='' or length(trim(p_input->>'business_name'))>160 or coalesce(p_input->>'email','')!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or length(p_input->>'email')>254 or coalesce(p_input->>'platform_account_id','')!~'^acct_[A-Za-z0-9]+$' or jsonb_typeof(p_input->'livemode') is distinct from 'boolean' or expiry is null or expiry<=clock_timestamp() or expiry>clock_timestamp()+interval '7 days' then raise exception 'Invalid merchant invitation' using errcode='22023';end if;
 if p_input->>'merchant_id' is not null then
  select * into b from public.merchant_businesses where id=(p_input->>'merchant_id')::uuid for update;
  if b.id is null or b.email<>lower(trim(p_input->>'email')) or b.business_name<>trim(p_input->>'business_name') then raise exception 'Merchant identity does not match' using errcode='22023';end if;
 else insert into public.merchant_businesses(business_name,email,created_by) values(trim(p_input->>'business_name'),lower(trim(p_input->>'email')),auth.uid()) returning * into b;end if;
 insert into public.merchant_connections(merchant_id,platform_account_id,livemode) values(b.id,p_input->>'platform_account_id',(p_input->>'livemode')::boolean) on conflict(merchant_id,livemode) do nothing;
 select * into c from public.merchant_connections where merchant_id=b.id and livemode=(p_input->>'livemode')::boolean for update;
 if c.platform_account_id<>p_input->>'platform_account_id' then raise exception 'Merchant platform cannot change' using errcode='22023';end if;
 if c.status='revoked' then update public.merchant_connections set status='pending' where id=c.id;end if;
 update public.merchant_invitations set revoked_at=clock_timestamp() where connection_id=c.id and confirmed_at is null and revoked_at is null;
 insert into public.merchant_invitations(merchant_id,connection_id,token_sha256,email,expires_at,created_by) values(b.id,c.id,p_input->>'token_sha256',b.email,expiry,auth.uid()) returning * into i;
 insert into public.audit_logs(actor_user_id,actor_type,action,target_table,target_id,after_data) values(auth.uid(),'admin','merchant_invited','merchant_invitations',i.id,jsonb_build_object('merchant_id',b.id,'livemode',c.livemode));
 return kma_internal.merchant_invitation_view(i);
end $$;
create function public.get_admin_merchant_connections() returns jsonb language plpgsql stable security definer set search_path='' as $$begin
 perform public.assert_admin_password(array['owner','operations','finance'],'view merchant connections');
 return jsonb_build_object('merchants',coalesce((select jsonb_agg(to_jsonb(b)||jsonb_build_object('connections',coalesce((select jsonb_agg(to_jsonb(c)) from public.merchant_connections c where c.merchant_id=b.id),'[]'::jsonb))) from public.merchant_businesses b),'[]'::jsonb),'assignments',coalesce((select jsonb_agg(to_jsonb(a)) from public.product_merchant_connections a),'[]'::jsonb));end $$;
create function public.assign_admin_product_merchant(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare c public.merchant_connections;a public.product_merchant_connections;begin
 perform public.assert_admin_password(array['owner','operations'],'assign a merchant');
 select * into c from public.merchant_connections where merchant_id=(p_input->>'merchant_id')::uuid and livemode=(p_input->>'livemode')::boolean for share;
 if c.id is null or c.status<>'active' or not c.charges_enabled or not c.details_submitted then raise exception 'An active verified merchant is required' using errcode='55000';end if;
 insert into public.product_merchant_connections(product_id,livemode,connection_id,assigned_by) values((p_input->>'product_id')::uuid,c.livemode,c.id,auth.uid()) on conflict(product_id,livemode) do update set connection_id=excluded.connection_id,assigned_by=excluded.assigned_by,assigned_at=clock_timestamp() returning * into a;
 insert into public.external_commerce_merchants(product_id,funnel_id,stripe_account_id,livemode,enabled) select a.product_id,f.id,c.account_id,c.livemode,true from public.funnels f where f.product_id=a.product_id on conflict(product_id,funnel_id,stripe_account_id,livemode) do update set enabled=true;
 insert into public.audit_logs(actor_user_id,actor_type,action,target_table,target_id,after_data) values(auth.uid(),'admin','product_merchant_assigned','products',a.product_id,to_jsonb(a));return to_jsonb(a);end $$;
create function public.revoke_admin_merchant_connection(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare c public.merchant_connections;begin
 perform public.assert_admin_password(array['owner','operations'],'revoke a merchant');
 update public.merchant_connections set status='revoked',revoked_at=clock_timestamp() where merchant_id=(p_input->>'merchant_id')::uuid and livemode=(p_input->>'livemode')::boolean returning * into c;
 if c.id is null then raise exception 'Merchant connection unavailable' using errcode='P0002';end if;
 update public.merchant_invitations set revoked_at=coalesce(revoked_at,clock_timestamp()) where connection_id=c.id;
 insert into public.audit_logs(actor_user_id,actor_type,action,target_table,target_id,after_data) values(auth.uid(),'admin','merchant_revoked','merchant_connections',c.id,jsonb_build_object('status','revoked'));return to_jsonb(c);end $$;
create function public.merchant_invitation_context(p_token_sha256 text) returns jsonb language plpgsql security definer set search_path='' as $$declare i public.merchant_invitations;begin
 select * into i from public.merchant_invitations where token_sha256=p_token_sha256;
 if i.id is null or i.revoked_at is not null or i.confirmed_at is not null or i.expires_at<=clock_timestamp() then raise exception 'Merchant invitation is unavailable' using errcode='P0002';end if;
 return kma_internal.merchant_invitation_view(i);end $$;
create function public.claim_merchant_invitation(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare i public.merchant_invitations;u uuid:=(p_input->>'user_id')::uuid;begin
 select * into i from public.merchant_invitations where token_sha256=p_input->>'token_sha256' for update;
 if i.id is null or i.revoked_at is not null or i.confirmed_at is not null or i.expires_at<=clock_timestamp() or (i.claimed_by is not null and i.claimed_by<>u) or not exists(select 1 from auth.users where id=u and email_confirmed_at is not null and lower(trim(email))=i.email) then raise exception 'Verified invited email is required' using errcode='42501';end if;
 update public.merchant_invitations set claimed_by=u,claimed_at=coalesce(claimed_at,clock_timestamp()) where id=i.id returning * into i;
 return kma_internal.merchant_invitation_view(i);end $$;
create function public.begin_merchant_oauth(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare i public.merchant_invitations;expiry timestamptz:=(p_input->>'expires_at')::timestamptz;begin
 perform 1 from public.merchant_invitations where id=(p_input->>'invitation_id')::uuid for update;
 i:=kma_internal.merchant_invitation_actor((p_input->>'invitation_id')::uuid,(p_input->>'user_id')::uuid);
 if coalesce(p_input->>'state_sha256','')!~'^[a-f0-9]{64}$' or expiry is null or expiry<=clock_timestamp() or expiry>clock_timestamp()+interval '10 minutes' or expiry>i.expires_at then raise exception 'Invalid merchant authorisation state' using errcode='22023';end if;
 update public.merchant_oauth_states set invalidated_at=clock_timestamp() where invitation_id=i.id and invalidated_at is null;
 update public.merchant_invitations set candidate=null where id=i.id;
 insert into public.merchant_oauth_states(state_sha256,invitation_id,user_id,expires_at) values(p_input->>'state_sha256',i.id,i.claimed_by,expiry);
 return kma_internal.merchant_invitation_view(i);end $$;
create function public.consume_merchant_oauth(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare s public.merchant_oauth_states;i public.merchant_invitations;begin
 select * into s from public.merchant_oauth_states where state_sha256=p_input->>'state_sha256' for update;
 if s.state_sha256 is null or s.user_id is distinct from (p_input->>'user_id')::uuid or s.expires_at<=clock_timestamp() or s.consumed_at is not null or s.invalidated_at is not null then raise exception 'Merchant authorisation state is unavailable' using errcode='42501';end if;
 i:=kma_internal.merchant_invitation_actor(s.invitation_id,s.user_id);
 update public.merchant_oauth_states set consumed_at=clock_timestamp() where state_sha256=s.state_sha256;
 return kma_internal.merchant_invitation_view(i);end $$;
create function public.record_merchant_connection_candidate(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare s public.merchant_oauth_states;i public.merchant_invitations;c public.merchant_connections;v jsonb;begin
 select * into s from public.merchant_oauth_states where state_sha256=p_input->>'state_sha256' for update;
 if s.state_sha256 is null or s.consumed_at is null or s.invalidated_at is not null or s.expires_at<=clock_timestamp() then raise exception 'Consumed merchant authorisation is required' using errcode='42501';end if;
 i:=kma_internal.merchant_invitation_actor(s.invitation_id,s.user_id);
 select * into c from public.merchant_connections where id=i.connection_id;
 if p_input->>'platform_account_id' is distinct from c.platform_account_id or (p_input->>'livemode')::boolean is distinct from c.livemode or coalesce(p_input->>'account_id','')!~'^acct_[A-Za-z0-9]+$' or p_input->>'account_id'=c.platform_account_id or jsonb_typeof(p_input->'charges_enabled') is distinct from 'boolean' or jsonb_typeof(p_input->'payouts_enabled') is distinct from 'boolean' or jsonb_typeof(p_input->'details_submitted') is distinct from 'boolean' or (p_input->>'provider_verified_at')::timestamptz is null or abs(extract(epoch from(clock_timestamp()-(p_input->>'provider_verified_at')::timestamptz)))>300 then raise exception 'Verified merchant facts do not match the authorised platform and mode' using errcode='22023';end if;
 v:=p_input-array['state_sha256'];
 if i.candidate is not null and i.candidate<>v then raise exception 'Merchant candidate is immutable; reconnect to change it' using errcode='22023';end if;
 update public.merchant_invitations set candidate=v where id=i.id returning * into i;return kma_internal.merchant_invitation_view(i);end $$;
create function public.merchant_connection_status(p_input jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$declare i public.merchant_invitations;begin
 i:=kma_internal.merchant_invitation_actor((p_input->>'invitation_id')::uuid,(p_input->>'user_id')::uuid,true);return kma_internal.merchant_invitation_view(i);end $$;
create function public.confirm_merchant_connection(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare i public.merchant_invitations;c public.merchant_connections;begin
 perform 1 from public.merchant_invitations where id=(p_input->>'invitation_id')::uuid for update;
 i:=kma_internal.merchant_invitation_actor((p_input->>'invitation_id')::uuid,(p_input->>'user_id')::uuid,true);
 if i.candidate is null or i.candidate->>'account_id' is distinct from p_input->>'account_id' then raise exception 'Confirm the verified merchant account' using errcode='22023';end if;
 if i.confirmed_at is not null then return kma_internal.merchant_invitation_view(i);end if;
 select * into c from public.merchant_connections where id=i.connection_id for update;
 if c.account_id is not null and c.account_id<>i.candidate->>'account_id' and exists(select 1 from public.product_merchant_connections where connection_id=c.id) then raise exception 'This merchant is assigned to products. Connect a separate merchant and have an admin explicitly reassign those products.' using errcode='55000';end if;

 if i.candidate->'charges_enabled' is distinct from 'true'::jsonb or i.candidate->'details_submitted' is distinct from 'true'::jsonb or (i.candidate->>'provider_verified_at')::timestamptz<clock_timestamp()-interval '15 minutes' then raise exception 'Complete Stripe requirements and reconnect before confirming' using errcode='55000';end if;
 update public.merchant_connections set account_id=i.candidate->>'account_id',status='active',business_name=i.candidate->>'business_name',country=i.candidate->>'country',charges_enabled=(i.candidate->>'charges_enabled')::boolean,payouts_enabled=(i.candidate->>'payouts_enabled')::boolean,details_submitted=(i.candidate->>'details_submitted')::boolean,confirmed_by=i.claimed_by,confirmed_at=clock_timestamp(),verified_at=(i.candidate->>'provider_verified_at')::timestamptz,revoked_at=null where id=i.connection_id returning * into c;
 update public.merchant_invitations set confirmed_at=clock_timestamp() where id=i.id returning * into i;
 insert into public.audit_logs(actor_user_id,actor_type,action,target_table,target_id,after_data) values(i.claimed_by,'system','merchant_confirmed','merchant_connections',c.id,jsonb_build_object('account_id',c.account_id,'livemode',c.livemode));return kma_internal.merchant_invitation_view(i);end $$;

create table public.merchant_connection_events (
 platform_account_id text not null,livemode boolean not null,event_id text not null,account_id text not null,event_created timestamptz not null,event_type text not null,payload_sha256 text not null check(payload_sha256~'^[a-f0-9]{64}$'),
 primary key(platform_account_id,livemode,event_id)
);
alter table public.merchant_connection_events enable row level security;
revoke all on public.merchant_connection_events from public,anon,authenticated,service_role;
create function public.merchant_connection_event_context(p_input jsonb) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('matched',exists(select 1 from public.merchant_connections where platform_account_id=p_input->>'platform_account_id' and livemode=(p_input->>'livemode')::boolean and account_id=p_input->>'account_id'));$$;
create function public.apply_merchant_connection_event(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare c public.merchant_connections;previous public.merchant_connection_events;begin
 if p_input->>'event_type' not in('account.updated','account.application.deauthorized') or coalesce(p_input->>'event_id','')!~'^evt_[A-Za-z0-9_]+$' or jsonb_typeof(p_input->'event_created') is distinct from 'number' or (p_input->>'event_created')::bigint<=0 or coalesce(p_input->>'payload_sha256','')!~'^[a-f0-9]{64}$' then raise exception 'Invalid merchant event' using errcode='22023';end if;
 select * into c from public.merchant_connections where platform_account_id=p_input->>'platform_account_id' and account_id=p_input->>'account_id' and livemode=(p_input->>'livemode')::boolean for update;
 if c.id is null then return jsonb_build_object('matched',false);end if;
 select * into previous from public.merchant_connection_events where platform_account_id=c.platform_account_id and livemode=c.livemode and event_id=p_input->>'event_id';
 if found then if previous.account_id<>c.account_id or previous.event_type<>p_input->>'event_type' or previous.event_created<>to_timestamp((p_input->>'event_created')::double precision) or previous.payload_sha256<>p_input->>'payload_sha256' then raise exception 'Merchant event identity changed' using errcode='22023';end if;return jsonb_build_object('matched',true,'status',c.status,'replayed',true);end if;
 insert into public.merchant_connection_events values(c.platform_account_id,c.livemode,p_input->>'event_id',c.account_id,to_timestamp((p_input->>'event_created')::double precision),p_input->>'event_type',p_input->>'payload_sha256');
 if p_input->>'event_type'='account.application.deauthorized' and c.confirmed_at is not null and to_timestamp((p_input->>'event_created')::double precision)<date_trunc('second',c.confirmed_at) then return jsonb_build_object('matched',true,'status',c.status,'ignored_historical',true);end if;
 if p_input->>'event_type'='account.application.deauthorized' then
  update public.merchant_connections set status='revoked',revoked_at=clock_timestamp() where id=c.id returning * into c;
  update public.merchant_invitations set revoked_at=coalesce(revoked_at,clock_timestamp()) where connection_id=c.id;
 elsif (p_input->>'provider_verified_at')::timestamptz>coalesce(c.verified_at,'-infinity'::timestamptz) and c.status<>'revoked' then
  if jsonb_typeof(p_input->'charges_enabled') is distinct from 'boolean' or jsonb_typeof(p_input->'details_submitted') is distinct from 'boolean' or jsonb_typeof(p_input->'payouts_enabled') is distinct from 'boolean' or (p_input->>'provider_verified_at')::timestamptz>clock_timestamp()+interval '5 minutes' then raise exception 'Complete verified merchant capabilities required' using errcode='22023';end if;
  update public.merchant_connections set charges_enabled=(p_input->>'charges_enabled')::boolean,payouts_enabled=(p_input->>'payouts_enabled')::boolean,details_submitted=(p_input->>'details_submitted')::boolean,verified_at=(p_input->>'provider_verified_at')::timestamptz where id=c.id returning * into c;
 end if;
 return jsonb_build_object('matched',true,'status',c.status);end $$;

alter table public.managed_checkout_orders
 add column charge_mode text not null default 'platform' check(charge_mode in('platform','merchant_direct')),
 add column platform_account_id text,
 add column merchant_connection_id uuid references public.merchant_connections,
 add column application_fee_amount bigint not null default 0 check(application_fee_amount>=0 and application_fee_amount<=amount_minor),
 add column application_fee_id text,
 add column application_fee_refunded_amount bigint not null default 0,
 add column application_fee_verified_at timestamptz,
 add column commission_terms_id uuid references public.external_commission_terms,
 add column commission_policy_snapshot jsonb;
create function public.resolve_managed_merchant_scope(p_scope jsonb,p_attempt_id uuid default null,p_order_id uuid default null,p_action text default 'quote') returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.merchant_connections;o public.managed_checkout_orders;platform text;begin
 if coalesce(p_scope->>'charge_mode','platform')='platform' then return p_scope||jsonb_build_object('charge_mode','platform','platform_account_id',p_scope->>'account_id');end if;
 if p_scope->>'charge_mode'<>'merchant_direct' or coalesce(p_scope->>'platform_account_id',p_scope->>'account_id')!~'^acct_[A-Za-z0-9]+$' then raise exception 'Invalid payment platform scope' using errcode='22023';end if;
 platform:=coalesce(p_scope->>'platform_account_id',p_scope->>'account_id');
 if p_attempt_id is not null then
  select * into o from public.managed_checkout_orders where attempt_id=p_attempt_id and binding_id=p_scope->>'id' and product_id=(p_scope->>'product_id')::uuid and funnel_id=(p_scope->>'funnel_id')::uuid and livemode=(p_scope->>'livemode')::boolean and ((platform_account_id=platform and charge_mode='merchant_direct') or (account_id=platform and charge_mode='platform'));
  if found then
   if p_order_id is not null and o.external_order_id<>p_order_id then raise exception 'Checkout order does not match' using errcode='42501';end if;
   if p_action='create' and o.checkout_session_id is null and (o.charge_mode='platform' or not exists(select 1 from public.product_merchant_connections pc join public.merchant_connections mc on mc.id=pc.connection_id where pc.product_id=o.product_id and pc.livemode=o.livemode and mc.id=o.merchant_connection_id and mc.account_id=o.account_id and mc.platform_account_id=platform and mc.status='active' and mc.charges_enabled and mc.details_submitted)) then raise exception 'Merchant connection changed or was revoked. Reconcile this existing attempt before starting checkout.' using errcode='55000';end if;

   return p_scope||jsonb_build_object('account_id',o.account_id,'platform_account_id',platform,'merchant_connection_id',o.merchant_connection_id,'charge_mode',o.charge_mode);
  elsif p_action not in('quote','create') then raise exception 'Checkout attempt unavailable' using errcode='P0002';end if;
 end if;
 if not exists(select 1 from public.funnels where id=(p_scope->>'funnel_id')::uuid and product_id=(p_scope->>'product_id')::uuid) then raise exception 'Payment funnel does not match product' using errcode='42501';end if;
 select m.* into c from public.product_merchant_connections a join public.merchant_connections m on m.id=a.connection_id where a.product_id=(p_scope->>'product_id')::uuid and a.livemode=(p_scope->>'livemode')::boolean;
 if c.id is null or c.platform_account_id<>platform or c.livemode is distinct from (p_scope->>'livemode')::boolean or c.status<>'active' or not c.charges_enabled or not c.details_submitted then raise exception 'Connect and verify this product merchant before checkout' using errcode='55000';end if;
 return p_scope||jsonb_build_object('account_id',c.account_id,'platform_account_id',platform,'merchant_connection_id',c.id,'merchant_id',c.merchant_id,'charge_mode','merchant_direct');end $$;

-- Preserve historical platform-owned checkout behavior. Only new explicitly
-- opted-in requests use merchant routing and a frozen signed commission.
alter function public.managed_checkout_quote(jsonb,text) rename to managed_checkout_quote_before_merchants;
create function public.managed_checkout_quote(p_scope jsonb,p_key text) returns jsonb language plpgsql security definer set search_path='' as $$declare scope jsonb;begin
 scope:=public.resolve_managed_merchant_scope(p_scope);return public.managed_checkout_quote_before_merchants(scope,p_key)||jsonb_build_object('account_id',scope->>'account_id','platform_account_id',scope->>'platform_account_id','charge_mode',scope->>'charge_mode');end $$;

-- Application fees are funds collected by KMA for the existing commission,
-- not an independent commission policy or a product-owner payout mechanism.
alter table public.external_commission_terms drop constraint external_commission_terms_funding_model_check;
alter table public.external_commission_terms drop constraint external_funding_model;
alter table public.external_commission_terms add constraint external_commission_terms_funding_model_check check(funding_model in('merchant_direct','prefunded_platform','application_fee'));
alter table public.external_commission_terms add constraint external_funding_model check(funding_model is null or funding_model in('prefunded_platform','application_fee') or stripe_account_id=platform_account_id);
create or replace function public.configure_admin_external_commission_terms(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.external_commission_terms;policy jsonb;a public.agreements;r public.commission_rules;prior integer;request uuid;previous public.external_settlement_requests;product uuid;funnel uuid;affiliate uuid;merchant text;platform text;live boolean;currency_value text;funding text;
begin
 perform public.assert_admin_password(array['owner','finance'],'configure external settlement bindings');
 if p_input is null or jsonb_typeof(p_input)<>'object' or not(p_input ?& array['request_id','agreement_id','commission_rule_id','product_id','funnel_id','affiliate_id','stripe_account_id','platform_account_id','livemode','currency','funding_model','effective_from','expected_version','reason']) or exists(select 1 from jsonb_object_keys(p_input) k where k not in('request_id','agreement_id','commission_rule_id','product_id','funnel_id','affiliate_id','stripe_account_id','platform_account_id','livemode','currency','funding_model','effective_from','effective_until','expected_version','reason')) or jsonb_typeof(p_input->'livemode')<>'boolean' then raise exception 'Select canonical terms; independent commission inputs are not accepted' using errcode='22023';end if;
 request:=(p_input->>'request_id')::uuid;if request is null then raise exception 'Request identity required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(8154,42);
 select * into previous from public.external_settlement_requests where request_id=request;
 if found then if previous.actor_id<>auth.uid() or previous.input<>p_input then raise exception 'Request identity changed' using errcode='22023';end if;return previous.result;end if;
 product:=(p_input->>'product_id')::uuid;funnel:=(p_input->>'funnel_id')::uuid;affiliate:=(p_input->>'affiliate_id')::uuid;merchant:=p_input->>'stripe_account_id';platform:=p_input->>'platform_account_id';live:=(p_input->>'livemode')::boolean;currency_value:=p_input->>'currency';funding:=p_input->>'funding_model';
 policy:=kma_internal.external_canonical_policy((p_input->>'agreement_id')::uuid,(p_input->>'commission_rule_id')::uuid);
 a:=jsonb_populate_record(null::public.agreements,policy->'agreement');r:=jsonb_populate_record(null::public.commission_rules,policy->'rule');
 if funding='application_fee' and (r.commission_basis_policy<>'subtotal_ex_tax_shipping' or r.first_purchase_only) then raise exception 'Application-fee funding requires a signed subtotal commission rule without first-purchase-only eligibility; choose a compatible signed rule before enabling checkout' using errcode='55000';end if;
 if funding='application_fee' and r.rate_basis_points>=10000 then raise exception 'Application-fee commission must be less than the payment amount' using errcode='55000';end if;
 if funding='application_fee' and exists(select 1 from public.product_merchant_connections pc join public.merchant_connections mc on mc.id=pc.connection_id join public.funnels f on f.product_id=pc.product_id where pc.product_id=product and f.id=funnel and pc.livemode=live and mc.account_id=merchant and mc.platform_account_id=platform and mc.status='active' and mc.charges_enabled and mc.details_submitted) then insert into public.external_commerce_merchants(product_id,funnel_id,stripe_account_id,livemode,enabled) values(product,funnel,merchant,live,true) on conflict(product_id,funnel_id,stripe_account_id,livemode) do update set enabled=true;end if;
 if a.product_id is distinct from product or a.affiliate_id is distinct from affiliate or a.payout_currency is distinct from currency_value or platform is null or platform!~'^acct_[A-Za-z0-9]+$' or funding is null or funding not in('merchant_direct','prefunded_platform','application_fee') or (funding='merchant_direct' and merchant<>platform) or not exists(select 1 from public.products where id=product and tracking_mode='commercial' and status='active') or not exists(select 1 from public.affiliates where id=affiliate and status='active') or not exists(select 1 from public.funnels where id=funnel and product_id=product and status='live') or not exists(select 1 from public.affiliate_links where affiliate_id=affiliate and product_id=product and funnel_id=funnel) or not exists(select 1 from public.external_commerce_merchants where product_id=product and funnel_id=funnel and stripe_account_id=merchant and livemode=live) then raise exception 'Canonical agreement or funding scope does not match' using errcode='22023';end if;
 if funding='application_fee' and not exists(select 1 from public.product_merchant_connections pc join public.merchant_connections mc on mc.id=pc.connection_id where pc.product_id=product and pc.livemode=live and mc.account_id=merchant and mc.platform_account_id=platform and mc.status='active' and mc.charges_enabled and mc.details_submitted) then raise exception 'Application fee funding requires the confirmed product merchant' using errcode='55000';end if;
 select coalesce(max(version),0) into prior from public.external_commission_terms where product_id=product and funnel_id=funnel and affiliate_id=affiliate and stripe_account_id=merchant and livemode=live and currency=currency_value;
 if (p_input->>'expected_version')::integer is distinct from prior then raise exception 'Binding changed; reload before saving' using errcode='40001';end if;
 insert into public.external_settlement_platforms(platform_account_id,livemode) values(platform,live) on conflict do nothing;
 insert into public.external_commission_terms(product_id,funnel_id,affiliate_id,stripe_account_id,platform_account_id,livemode,currency,version,calculation,basis_points,fixed_minor,hold_days,attribution_window_days,effective_from,effective_until,reason,created_by,agreement_id,commission_rule_id,signed_document_id,terms_sha256,canonical_snapshot,policy_version,validation_window_hours,refund_cutoff_days,commission_basis_policy,minimum_payout_minor,payout_frequency_days,funding_model)
 values(product,funnel,affiliate,merchant,platform,live,currency_value,prior+1,case r.model when 'cpa' then 'fixed' when 'revenue_share' then 'percentage' else 'hybrid' end,r.rate_basis_points,r.fixed_amount_minor,ceil(r.validation_window_hours::numeric/24),a.attribution_window_days,(p_input->>'effective_from')::timestamptz,(p_input->>'effective_until')::timestamptz,trim(p_input->>'reason'),auth.uid(),a.id,r.id,(policy->>'signed_document_id')::uuid,policy->>'terms_sha256',policy,r.policy_version,r.validation_window_hours,r.refund_cutoff_days,r.commission_basis_policy,a.minimum_payout_minor,a.payout_frequency_days,funding) returning * into t;
 insert into public.audit_logs(actor_user_id,actor_type,action,target_table,target_id,after_data) values(auth.uid(),'admin','external_canonical_binding_created','external_commission_terms',t.id,to_jsonb(t));
 insert into public.external_settlement_requests(request_id,actor_id,input,result) values(request,auth.uid(),p_input,to_jsonb(t));return to_jsonb(t);
end $$;

alter function public.prepare_managed_checkout(jsonb,jsonb,text) rename to prepare_managed_checkout_before_merchants;
create function public.prepare_managed_checkout(p_scope jsonb,p_input jsonb,p_attribution_sha256 text) returns jsonb language plpgsql security definer set search_path='' as $$
declare scope jsonb;o public.managed_checkout_orders;prior public.managed_checkout_orders;t public.external_commission_terms;c public.clicks;a public.acquisitions;fee bigint:=0;expiry timestamptz;now_at timestamptz:=clock_timestamp();
begin
 scope:=public.resolve_managed_merchant_scope(p_scope,(p_input->>'attempt_id')::uuid,(p_input->>'order_id')::uuid,'create');
 if scope->>'charge_mode'='platform' then return public.prepare_managed_checkout_before_merchants(scope,p_input,p_attribution_sha256);end if;
 perform pg_advisory_xact_lock(hashtextextended((scope->>'platform_account_id')||(scope->>'livemode')||(p_input->>'order_id'),1710));
 select * into prior from public.managed_checkout_orders where binding_id=scope->>'id' and product_id=(scope->>'product_id')::uuid and funnel_id=(scope->>'funnel_id')::uuid and external_order_id=(p_input->>'order_id')::uuid and livemode=(scope->>'livemode')::boolean and platform_account_id=scope->>'platform_account_id' order by created_at desc limit 1;
 if prior.id is not null and prior.account_id<>scope->>'account_id' then raise exception 'Existing order merchant is immutable' using errcode='22023';end if;
 if prior.id is not null and prior.commission_terms_id is not null and prior.attempt_id<>(p_input->>'attempt_id')::uuid then
  select * into t from public.external_commission_terms where id=prior.commission_terms_id;
  select ac.* into a from public.acquisitions ac join public.clicks cl on cl.id=ac.click_record_id where cl.public_click_id=prior.request->>'click_id';
  expiry:=(p_input->>'checkout_expires_at')::timestamptz;
  if expiry>a.created_at+make_interval(days=>t.attribution_window_days) or (t.effective_until is not null and expiry>=t.effective_until) or exists(select 1 from public.external_commission_term_endings e where e.terms_id=t.id and expiry>=e.effective_until) or ((t.canonical_snapshot#>>'{agreement,ends_at}') is not null and expiry>=(t.canonical_snapshot#>>'{agreement,ends_at}')::timestamptz) or exists(select 1 from public.agreements ag where ag.id=t.agreement_id and ag.ends_at is not null and expiry>=ag.ends_at) or exists(select 1 from public.documents d where d.id=t.signed_document_id and ((d.expires_at is not null and expiry>=d.expires_at) or (d.terminated_at is not null and expiry>=d.terminated_at))) then raise exception 'Frozen commission attribution or agreement cannot cover the renewed checkout' using errcode='55000';end if;
 end if;
 if prior.id is null and p_input->>'click_id' is not null then
  perform public.assert_funnel_request_scope('managed-checkout',p_input->>'click_id',(scope->>'product_id')::uuid,(scope->>'funnel_id')::uuid);
  select * into c from public.clicks where public_click_id=p_input->>'click_id';select * into a from public.acquisitions where click_record_id=c.id;
  if c.commercial_eligible and a.commercial_eligible and exists(select 1 from public.products where id=c.product_id and status='active' and tracking_mode='commercial') and exists(select 1 from public.funnels where id=c.funnel_id and status='live') and exists(select 1 from public.affiliates where id=c.affiliate_id and status='active') then
   select * into t from public.external_commission_terms x where x.product_id=c.product_id and x.funnel_id=c.funnel_id and x.affiliate_id=c.affiliate_id and x.stripe_account_id=scope->>'account_id' and x.platform_account_id=scope->>'platform_account_id' and x.livemode=(scope->>'livemode')::boolean and x.currency=p_input->>'currency' and x.funding_model='application_fee' and x.status='approved' and x.agreement_id is not null and x.approved_at<=now_at and x.effective_from<=now_at and (x.effective_until is null or x.effective_until>now_at) and not exists(select 1 from public.external_commission_term_endings e where e.terms_id=x.id and e.effective_until<=now_at) order by x.version desc limit 1;
   if t.id is null then raise exception 'An approved signed application-fee commission binding is required for this referral' using errcode='55000';end if;
   if t.canonical_snapshot is distinct from kma_internal.external_canonical_policy(t.agreement_id,t.commission_rule_id,now_at) then raise exception 'Signed commission binding changed; review it before checkout' using errcode='55000';end if;
   if now_at>=a.created_at and now_at<=a.created_at+make_interval(days=>t.attribution_window_days) then
    if t.commission_basis_policy<>'subtotal_ex_tax_shipping' or t.first_purchase_only then raise exception 'Upfront merchant fees require a signed subtotal commission rule without first-purchase-only eligibility' using errcode='55000';end if;
    fee:=public.commercial_commission_amount((t.canonical_snapshot#>>'{rule,model}')::public.commission_model,t.fixed_minor,t.basis_points,(p_input->>'amount_minor')::bigint);
    if fee>=(p_input->>'amount_minor')::bigint or fee<0 then raise exception 'Commission exceeds the checkout amount' using errcode='55000';end if;
    expiry:=(p_input->>'checkout_expires_at')::timestamptz;
    if expiry>a.created_at+make_interval(days=>t.attribution_window_days) or (t.effective_until is not null and expiry>=t.effective_until) or exists(select 1 from public.external_commission_term_endings e where e.terms_id=t.id and expiry>=e.effective_until) or ((t.canonical_snapshot#>>'{agreement,ends_at}') is not null and expiry>=(t.canonical_snapshot#>>'{agreement,ends_at}')::timestamptz) or exists(select 1 from public.documents d where d.id=t.signed_document_id and d.expires_at is not null and expiry>=d.expires_at) then raise exception 'Commission attribution or agreement expires before this checkout; shorten its expiry or review attribution' using errcode='55000';end if;
   else t:=null;end if;
  end if;
 end if;
 o:=jsonb_populate_record(null::public.managed_checkout_orders,public.prepare_managed_checkout_before_merchants(scope,p_input,p_attribution_sha256));
 if o.charge_mode='platform' then
  update public.managed_checkout_orders set charge_mode='merchant_direct',platform_account_id=scope->>'platform_account_id',merchant_connection_id=(scope->>'merchant_connection_id')::uuid,application_fee_amount=coalesce(prior.application_fee_amount,fee),commission_terms_id=coalesce(prior.commission_terms_id,t.id),commission_policy_snapshot=coalesce(prior.commission_policy_snapshot,to_jsonb(t)) where id=o.id returning * into o;
 end if;
 return to_jsonb(o);end $$;

create or replace function kma_internal.managed_public_order(o public.managed_checkout_orders) returns jsonb language sql immutable set search_path='' as $$
 select to_jsonb(o)-array['request','stripe_price_id','first_attempt_at','attribution_sha256','binding_id','created_at','offer_id','next_reconcile_at','commission_recorded','is_primary_capture','reconcile_attempts','last_reconcile_error','refund_created_at','application_fee_amount','application_fee_id','application_fee_refunded_amount','application_fee_verified_at','commission_terms_id','commission_policy_snapshot','merchant_connection_id'];$$;

alter function public.record_managed_checkout_snapshot(jsonb,uuid,jsonb) rename to record_managed_checkout_snapshot_before_merchants;
create function public.record_managed_checkout_snapshot(p_scope jsonb,p_attempt_id uuid,p_snapshot jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare o public.managed_checkout_orders;begin
 o:=jsonb_populate_record(null::public.managed_checkout_orders,public.get_managed_checkout(p_scope,p_attempt_id));
 if o.charge_mode='merchant_direct' and o.application_fee_amount=0 and p_snapshot->'application_fee_verified'='true'::jsonb and ((p_snapshot->>'application_fee_amount')::bigint is distinct from 0::bigint or p_snapshot->>'application_fee_id' is not null or (p_snapshot->>'application_fee_refunded_amount')::bigint is distinct from 0::bigint or p_snapshot->>'platform_account_id' is distinct from o.platform_account_id) then raise exception 'Organic checkout must not collect an application fee' using errcode='22023';end if;
 if o.charge_mode='merchant_direct' and p_snapshot->'application_fee_verified'='true'::jsonb and o.application_fee_amount>0 then
  if coalesce(p_snapshot->>'application_fee_id','')!~'^fee_[A-Za-z0-9]+$' or p_snapshot->>'platform_account_id' is distinct from o.platform_account_id or (p_snapshot->>'application_fee_amount')::bigint is distinct from o.application_fee_amount or (p_snapshot->>'application_fee_refunded_amount')::bigint is null or (p_snapshot->>'application_fee_refunded_amount')::bigint not between 0 and o.application_fee_amount or (o.application_fee_id is not null and o.application_fee_id<>p_snapshot->>'application_fee_id') then raise exception 'Application fee evidence does not match the frozen commission' using errcode='22023';end if;
 end if;
 o:=jsonb_populate_record(null::public.managed_checkout_orders,public.record_managed_checkout_snapshot_before_merchants(p_scope,p_attempt_id,p_snapshot));
 if o.charge_mode='merchant_direct' and p_snapshot->'application_fee_verified'='true'::jsonb and o.application_fee_amount>0 then
  update public.managed_checkout_orders set application_fee_id=p_snapshot->>'application_fee_id',application_fee_refunded_amount=greatest(application_fee_refunded_amount,(p_snapshot->>'application_fee_refunded_amount')::bigint),application_fee_verified_at=clock_timestamp() where id=o.id returning * into o;
 end if;
 return to_jsonb(o);end $$;

alter function public.managed_checkout_record_commission(jsonb,uuid,jsonb,jsonb) rename to managed_checkout_record_commission_before_merchants;
create function public.managed_checkout_record_commission(p_scope jsonb,p_attempt_id uuid,p_evidence jsonb,p_basis jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare o public.managed_checkout_orders;receipt jsonb;ext public.external_commerce_orders;t public.external_commission_terms;a public.external_commission_awards;begin
 o:=jsonb_populate_record(null::public.managed_checkout_orders,public.get_managed_checkout(p_scope,p_attempt_id));
 if o.charge_mode='platform' then return public.managed_checkout_record_commission_before_merchants(p_scope,p_attempt_id,p_evidence,p_basis);end if;
 if not o.is_primary_capture or o.duplicate_capture then return jsonb_build_object('eligible',false);end if;
 if o.commission_terms_id is null or o.application_fee_amount=0 then return public.managed_checkout_record_commission_before_merchants(p_scope,p_attempt_id,p_evidence,p_basis);end if;
 if o.application_fee_verified_at is null or o.application_fee_id is null then return jsonb_build_object('eligible',false,'blocker','application_fee_verification_pending');end if;
 if p_basis is null or (p_basis->>'eligible_basis_minor')::bigint is distinct from o.amount_minor then raise exception 'Verified subtotal must match the frozen fee basis' using errcode='22023';end if;
 perform pg_advisory_xact_lock(8154,42);
 receipt:=public.managed_checkout_record_commission_before_merchants(p_scope,p_attempt_id,p_evidence,p_basis);
 select * into ext from public.external_commerce_orders where external_order_id=o.external_order_id and stripe_account_id=o.account_id and livemode=o.livemode;
 if ext.id is null then return receipt;end if;
 select * into t from public.external_commission_terms where id=o.commission_terms_id;
 insert into public.external_commission_awards(order_id,terms_id,terms_snapshot,basis_minor,commission_minor,original_commission_minor,eligible_at,status,blocker) values(ext.id,t.id,o.commission_policy_snapshot,o.amount_minor,o.application_fee_amount,o.application_fee_amount,o.paid_at+make_interval(hours=>t.validation_window_hours),'held','validation_window') on conflict(order_id) do nothing;
 select * into a from public.external_commission_awards where order_id=ext.id;
 if a.terms_id is distinct from t.id or a.original_commission_minor is distinct from o.application_fee_amount then raise exception 'Commission ledger differs from the collected fee' using errcode='22023';end if;
 insert into public.external_commission_ledger(award_id,affiliate_id,platform_account_id,livemode,currency,kind,amount_minor,source_key) values(a.id,ext.affiliate_id,o.platform_account_id,o.livemode,o.currency,'earned',o.application_fee_amount,'earned:'||a.id) on conflict(source_key) do nothing;
 perform kma_internal.refresh_external_award(ext.id);return receipt;end $$;

create or replace function public.managed_checkout_reconcile_candidates(p_scope jsonb,p_limit integer default 10) returns setof jsonb language sql security definer set search_path='' as $$
 select to_jsonb(o) from public.managed_checkout_orders o where
 (case when coalesce(p_scope->>'charge_mode','platform')='merchant_direct' then o.binding_id=p_scope->>'id' and o.product_id=(p_scope->>'product_id')::uuid and o.funnel_id=(p_scope->>'funnel_id')::uuid and o.livemode=(p_scope->>'livemode')::boolean and ((o.platform_account_id=coalesce(p_scope->>'platform_account_id',p_scope->>'account_id') and o.charge_mode='merchant_direct') or (o.account_id=coalesce(p_scope->>'platform_account_id',p_scope->>'account_id') and o.charge_mode='platform')) else kma_internal.managed_scope_matches(o,p_scope) end)
 and o.next_reconcile_at<=clock_timestamp() and (o.status in('creating','open','processing') or (o.paid_at is not null and o.created_at>clock_timestamp()-interval '180 days')) order by o.next_reconcile_at,o.id limit greatest(1,least(p_limit,25));$$;

-- A manually refunded application fee cannot leave an unfunded creator award
-- payable. Existing holds, signed payout cadence, and manual approval remain.
alter function kma_internal.external_order_payable(uuid) rename to external_order_payable_before_merchant_fees;
create function kma_internal.external_order_payable(p_order uuid) returns boolean language sql stable set search_path='' as $$
 select kma_internal.external_order_payable_before_merchant_fees(p_order) and not exists(
 select 1 from public.external_commerce_orders e join public.managed_checkout_orders o on o.external_order_id=e.external_order_id and o.account_id=e.stripe_account_id and o.livemode=e.livemode
 join public.external_commission_awards a on a.order_id=e.id
 where e.id=p_order and o.charge_mode='merchant_direct' and (o.commission_terms_id is null or o.application_fee_amount=0 or o.application_fee_verified_at is null or o.application_fee_amount-o.application_fee_refunded_amount<a.commission_minor));$$;
alter function kma_internal.refresh_external_award(uuid) rename to refresh_external_award_before_merchant_fees;
create function kma_internal.refresh_external_award(p_order uuid) returns void language plpgsql set search_path='' as $$begin
 perform kma_internal.refresh_external_award_before_merchant_fees(p_order);
 update public.external_commission_awards a set status='held',blocker='application_fee_funding_requires_review',revision=a.revision+1
 from public.external_commerce_orders e join public.managed_checkout_orders o on o.external_order_id=e.external_order_id and o.account_id=e.stripe_account_id and o.livemode=e.livemode
 where a.order_id=e.id and e.id=p_order and o.charge_mode='merchant_direct' and a.commission_minor>0 and (o.application_fee_verified_at is null or o.application_fee_amount-o.application_fee_refunded_amount<a.commission_minor) and (a.status<>'held' or a.blocker is distinct from 'application_fee_funding_requires_review');end $$;

create table public.managed_application_fee_refunds (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.managed_checkout_orders,
 application_fee_id text not null,amount_minor bigint not null check(amount_minor>0),prior_refunded_amount bigint not null,target_refunded_amount bigint not null,
 first_attempt_at timestamptz not null default clock_timestamp(),refund_id text,completed_at timestamptz,
 check(target_refunded_amount=prior_refunded_amount+amount_minor),unique(application_fee_id,refund_id)
);
create unique index managed_one_pending_fee_refund on public.managed_application_fee_refunds(order_id) where completed_at is null;
alter table public.managed_application_fee_refunds enable row level security;
revoke all on public.managed_application_fee_refunds from public,anon,authenticated,service_role;
create function public.managed_checkout_fee_refund_plan(p_scope jsonb,p_attempt_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.managed_checkout_orders;op public.managed_application_fee_refunds;ext public.external_commerce_orders;a public.external_commission_awards;target bigint;begin
 o:=jsonb_populate_record(null::public.managed_checkout_orders,public.get_managed_checkout(p_scope,p_attempt_id));
 perform pg_advisory_xact_lock(hashtextextended(o.id::text,1711));
 select * into o from public.managed_checkout_orders where id=o.id for update;
 if o.charge_mode<>'merchant_direct' or o.application_fee_verified_at is null or o.application_fee_id is null or o.application_fee_amount=0 then return null;end if;
 select * into op from public.managed_application_fee_refunds where order_id=o.id and completed_at is null;
 if found then return to_jsonb(op);end if;
 if o.duplicate_capture then target:=o.application_fee_amount;
 else
  select * into ext from public.external_commerce_orders where external_order_id=o.external_order_id and stripe_account_id=o.account_id and livemode=o.livemode;
  if ext.id is null then return null;end if;
  perform kma_internal.refresh_external_award(ext.id);
  select * into a from public.external_commission_awards where order_id=ext.id;
  if a.id is null or a.terms_id is distinct from o.commission_terms_id then return null;end if;
  target:=a.reversed_minor;
 end if;
 if target<=o.application_fee_refunded_amount then return null;end if;
 insert into public.managed_application_fee_refunds(order_id,application_fee_id,amount_minor,prior_refunded_amount,target_refunded_amount) values(o.id,o.application_fee_id,target-o.application_fee_refunded_amount,o.application_fee_refunded_amount,target) returning * into op;return to_jsonb(op);end $$;
create function public.complete_managed_checkout_fee_refund(p_scope jsonb,p_attempt_id uuid,p_operation_id uuid,p_receipt jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.managed_checkout_orders;op public.managed_application_fee_refunds;begin
 o:=jsonb_populate_record(null::public.managed_checkout_orders,public.get_managed_checkout(p_scope,p_attempt_id));
 perform pg_advisory_xact_lock(hashtextextended(o.id::text,1711));
 select * into op from public.managed_application_fee_refunds where id=p_operation_id and order_id=o.id for update;
 if op.id is null or p_receipt->>'application_fee_id' is distinct from op.application_fee_id or p_receipt->>'platform_account_id' is distinct from o.platform_account_id or p_receipt->>'currency' is distinct from o.currency or (p_receipt->>'livemode')::boolean is distinct from o.livemode or coalesce(p_receipt->>'refund_id','')!~'^fr_[A-Za-z0-9]+$' or (p_receipt->>'amount_minor')::bigint is distinct from op.amount_minor or (p_receipt->>'refunded_amount')::bigint is null or (p_receipt->>'refunded_amount')::bigint<op.target_refunded_amount or (p_receipt->>'refunded_amount')::bigint>o.application_fee_amount or (op.refund_id is not null and op.refund_id<>p_receipt->>'refund_id') then raise exception 'Application fee refund receipt conflicts' using errcode='22023';end if;
 update public.managed_application_fee_refunds set refund_id=p_receipt->>'refund_id',completed_at=coalesce(completed_at,clock_timestamp()) where id=op.id returning * into op;
 update public.managed_checkout_orders set application_fee_refunded_amount=greatest(application_fee_refunded_amount,(p_receipt->>'refunded_amount')::bigint),application_fee_verified_at=clock_timestamp() where id=o.id;
 return to_jsonb(op);end $$;

create function public.refresh_merchant_connection_candidate(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare i public.merchant_invitations;v jsonb;begin
 perform 1 from public.merchant_invitations where id=(p_input->>'invitation_id')::uuid for update;
 i:=kma_internal.merchant_invitation_actor((p_input->>'invitation_id')::uuid,(p_input->>'user_id')::uuid);
 if i.candidate is null or i.candidate->>'account_id' is distinct from p_input->>'account_id' or jsonb_typeof(p_input->'charges_enabled') is distinct from 'boolean' or jsonb_typeof(p_input->'payouts_enabled') is distinct from 'boolean' or jsonb_typeof(p_input->'details_submitted') is distinct from 'boolean' or (p_input->>'provider_verified_at')::timestamptz is null or abs(extract(epoch from(clock_timestamp()-(p_input->>'provider_verified_at')::timestamptz)))>300 then raise exception 'Refresh only the verified candidate account' using errcode='22023';end if;
 v:=i.candidate||jsonb_build_object('business_name',p_input->>'business_name','country',p_input->>'country','charges_enabled',(p_input->>'charges_enabled')::boolean,'payouts_enabled',(p_input->>'payouts_enabled')::boolean,'details_submitted',(p_input->>'details_submitted')::boolean,'provider_verified_at',p_input->>'provider_verified_at');
 update public.merchant_invitations set candidate=v where id=i.id returning * into i;return kma_internal.merchant_invitation_view(i);end $$;

-- Public execution is opt-in for every entrypoint. Service methods trust only
-- the authenticated edge boundary; browsers cannot inject identities or facts.
do $$declare fn regprocedure;begin
 for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like '%before_merchants' or p.proname in('create_admin_merchant_invitation','get_admin_merchant_connections','assign_admin_product_merchant','revoke_admin_merchant_connection','merchant_invitation_context','claim_merchant_invitation','begin_merchant_oauth','consume_merchant_oauth','record_merchant_connection_candidate','refresh_merchant_connection_candidate','merchant_connection_status','confirm_merchant_connection','apply_merchant_connection_event','merchant_connection_event_context','resolve_managed_merchant_scope','managed_checkout_quote','prepare_managed_checkout','record_managed_checkout_snapshot','managed_checkout_record_commission','managed_checkout_fee_refund_plan','complete_managed_checkout_fee_refund')) loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',fn);end loop;
 for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='kma_internal' and p.proname in('merchant_invitation_view','merchant_invitation_actor','external_order_payable_before_merchant_fees','external_order_payable','refresh_external_award_before_merchant_fees','refresh_external_award') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',fn);end loop;
end $$;
grant execute on function public.create_admin_merchant_invitation(jsonb),public.get_admin_merchant_connections(),public.assign_admin_product_merchant(jsonb),public.revoke_admin_merchant_connection(jsonb) to authenticated;
grant execute on function public.merchant_invitation_context(text),public.claim_merchant_invitation(jsonb),public.begin_merchant_oauth(jsonb),public.consume_merchant_oauth(jsonb),public.record_merchant_connection_candidate(jsonb),public.refresh_merchant_connection_candidate(jsonb),public.merchant_connection_status(jsonb),public.confirm_merchant_connection(jsonb),public.apply_merchant_connection_event(jsonb),public.merchant_connection_event_context(jsonb),public.resolve_managed_merchant_scope(jsonb,uuid,uuid,text),public.managed_checkout_quote(jsonb,text),public.prepare_managed_checkout(jsonb,jsonb,text),public.record_managed_checkout_snapshot(jsonb,uuid,jsonb),public.managed_checkout_record_commission(jsonb,uuid,jsonb,jsonb),public.managed_checkout_fee_refund_plan(jsonb,uuid),public.complete_managed_checkout_fee_refund(jsonb,uuid,uuid,jsonb) to service_role;
commit;
