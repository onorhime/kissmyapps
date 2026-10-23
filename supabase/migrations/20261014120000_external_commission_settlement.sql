-- External merchant settlement is deliberately separate from subscription
-- conversions, commission_entries and payouts. Installation enables no provider.
begin;

create table public.external_settlement_platforms (
 platform_account_id text not null check(platform_account_id ~ '^acct_[A-Za-z0-9]+$'),
 livemode boolean not null, enabled boolean not null default false,
 revision integer not null default 1 check(revision>0), primary key(platform_account_id,livemode)
);
create table public.external_commission_terms (
 id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products,
 funnel_id uuid not null references public.funnels, affiliate_id uuid not null references public.affiliates,
 stripe_account_id text not null, platform_account_id text not null, livemode boolean not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'), version integer not null check(version>0), revision integer not null default 1,
 status text not null default 'draft' check(status in('draft','approved')),
 calculation text not null check(calculation in('percentage','fixed')),
 basis_points integer, fixed_minor bigint,
 hold_days integer not null check(hold_days between 0 and 365), attribution_window_days integer not null check(attribution_window_days between 1 and 365),
 effective_from timestamptz not null,effective_until timestamptz,
 reason text not null check(length(reason) between 5 and 500), created_by uuid not null references auth.users,
 created_at timestamptz not null default clock_timestamp(),approved_by uuid references auth.users,approved_at timestamptz,
 check(stripe_account_id=platform_account_id), -- v1: the merchant is the funding platform; no assumed cross-account funding.
 check(effective_until is null or effective_until>effective_from),
 check((calculation='percentage' and basis_points is not null and basis_points between 1 and 10000 and fixed_minor is null) or (calculation='fixed' and fixed_minor is not null and fixed_minor between 1 and 9007199254740991 and basis_points is null)),
 foreign key(product_id,funnel_id,stripe_account_id,livemode) references public.external_commerce_merchants,
 foreign key(platform_account_id,livemode) references public.external_settlement_platforms,
 unique(product_id,funnel_id,affiliate_id,stripe_account_id,livemode,currency,version)
);
create table public.external_commission_term_endings (
 terms_id uuid primary key references public.external_commission_terms,successor_id uuid not null unique references public.external_commission_terms,effective_until timestamptz not null,created_at timestamptz not null default clock_timestamp()
);
create table public.external_commission_bases (
 order_id uuid primary key references public.external_commerce_orders,
 eligible_basis_minor bigint not null check(eligible_basis_minor between 0 and 9007199254740991),
 total_minor bigint not null check(total_minor>0),currency text not null,
 basis_policy text not null check(basis_policy='post_discount_excluding_tax_shipping'),
 verified_at timestamptz not null,created_at timestamptz not null default clock_timestamp(),check(eligible_basis_minor<=total_minor)
);
create table public.external_creator_accounts (
 id uuid primary key default gen_random_uuid(),affiliate_id uuid not null references public.affiliates,
 platform_account_id text not null,livemode boolean not null,
 connect_account_id text check(connect_account_id ~ '^acct_[A-Za-z0-9]+$'),country text check(country ~ '^[A-Z]{2}$'),
 first_account_attempt_at timestamptz,created_at timestamptz not null default clock_timestamp(),
 status text not null default 'not_connected' check(status in('not_connected','pending','ready','restricted')),
 charges_enabled boolean not null default false,payouts_enabled boolean not null default false,transfers_enabled boolean not null default false,details_submitted boolean not null default false,
 disabled_reason text,requirements_due jsonb not null default '[]' check(jsonb_typeof(requirements_due)='array'),
 revision integer not null default 1,verified_at timestamptz,
 foreign key(platform_account_id,livemode) references public.external_settlement_platforms,
 unique(affiliate_id,platform_account_id,livemode),unique(platform_account_id,livemode,connect_account_id)
);
create table public.external_commission_awards (
 id uuid primary key default gen_random_uuid(),order_id uuid not null unique references public.external_commerce_orders,
 terms_id uuid references public.external_commission_terms,terms_snapshot jsonb,
 basis_minor bigint,commission_minor bigint not null default 0 check(commission_minor>=0),
 status text not null default 'unconfigured' check(status in('unconfigured','held','eligible','reversed')),
 blocker text,eligible_at timestamptz,last_checked_at timestamptz,revision integer not null default 1,created_at timestamptz not null default clock_timestamp(),
 check(terms_id is null or terms_snapshot is not null)
);
create table public.external_commission_holds (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.external_commerce_orders,provider_event_id text not null unique,
 reason text not null,hold_type text not null default 'dispute' check(hold_type in('refund_full','refund_partial','dispute')),verified_amount_minor bigint,created_at timestamptz not null default clock_timestamp()
);
create table public.external_settlement_batches (
 id uuid primary key default gen_random_uuid(),product_id uuid not null references public.products,funnel_id uuid not null references public.funnels,
 affiliate_id uuid not null references public.affiliates,platform_account_id text not null,livemode boolean not null,currency text not null,
 amount_minor bigint not null check(amount_minor between 1 and 9007199254740991),
 status text not null default 'draft' check(status in('draft','reviewed','approved','held','processing','transferred','cancelled')),
 revision integer not null default 1,destination text,account_revision integer,
 created_at timestamptz not null default clock_timestamp(),reviewed_at timestamptz,approved_at timestamptz,transferred_at timestamptz,
 reason text not null,created_by uuid not null references auth.users,approved_by uuid references auth.users,
 foreign key(platform_account_id,livemode) references public.external_settlement_platforms
);
create table public.external_settlement_items (
 batch_id uuid not null references public.external_settlement_batches,award_id uuid not null references public.external_commission_awards,
 amount_minor bigint not null check(amount_minor>0), primary key(batch_id,award_id)
);
create table public.external_settlement_jobs (
 id uuid primary key default gen_random_uuid(),batch_id uuid not null references public.external_settlement_batches,order_id uuid references public.external_commerce_orders,
 kind text not null check(kind in('transfer','reversal')),state text not null default 'pending' check(state in('pending','leased','succeeded','reconcile','failed')),
 platform_account_id text not null,livemode boolean not null,amount_minor bigint not null check(amount_minor between 1 and 9007199254740991),currency text not null,
 destination text not null,transfer_id text,idempotency_key text not null unique,transfer_group text not null,
 lease_token uuid,lease_expires_at timestamptz,first_attempt_at timestamptz,attempt_count integer not null default 0,
 provider_id text,last_error text,next_attempt_at timestamptz not null default clock_timestamp(),last_reconciled_at timestamptz,created_at timestamptz not null default clock_timestamp(),
 unique(platform_account_id,livemode,kind,provider_id),check((kind='transfer' and order_id is null) or (kind='reversal' and order_id is not null and transfer_id is not null))
);
create unique index external_one_transfer on public.external_settlement_jobs(batch_id) where kind='transfer';
create unique index external_one_reversal on public.external_settlement_jobs(batch_id,order_id) where kind='reversal';
create table public.external_commission_ledger (
 id uuid primary key default gen_random_uuid(),award_id uuid references public.external_commission_awards,batch_id uuid references public.external_settlement_batches,
 affiliate_id uuid not null references public.affiliates,platform_account_id text not null,livemode boolean not null,currency text not null,
 kind text not null check(kind in('earned','reversed','transfer','transfer_reversal')),
 amount_minor bigint not null check(amount_minor<>0),source_key text not null unique,created_at timestamptz not null default clock_timestamp(),
 check((kind in('earned','transfer_reversal') and amount_minor>0) or (kind in('reversed','transfer') and amount_minor<0))
);
create table public.external_settlement_requests (
 request_id uuid primary key,actor_id uuid not null,input jsonb not null,result jsonb not null,created_at timestamptz not null default clock_timestamp()
);

create function kma_internal.external_terms_history() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or old.status='approved' or (to_jsonb(new)-array['status','revision','approved_by','approved_at']) is distinct from (to_jsonb(old)-array['status','revision','approved_by','approved_at']) then
  raise exception 'Approved terms and commercial history are immutable' using errcode='22023';
 end if;return new;
end $$;
create trigger external_terms_history before update or delete on public.external_commission_terms for each row execute function kma_internal.external_terms_history();
create trigger external_term_endings_history before update or delete on public.external_commission_term_endings for each row execute function kma_internal.external_commerce_immutable();
create trigger external_basis_history before update or delete on public.external_commission_bases for each row execute function kma_internal.external_commerce_immutable();
create trigger external_ledger_history before update or delete on public.external_commission_ledger for each row execute function kma_internal.external_commerce_immutable();
create trigger external_items_history before update or delete on public.external_settlement_items for each row execute function kma_internal.external_commerce_immutable();
create trigger external_holds_history before update or delete on public.external_commission_holds for each row execute function kma_internal.external_commerce_immutable();

create function public.record_external_commission_basis(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.external_commerce_orders;b public.external_commission_bases;v bigint;verified timestamptz;
begin
 select * into o from public.external_commerce_orders where external_order_id=(p_input->>'external_order_id')::uuid and stripe_account_id=p_input->>'stripe_account_id' and livemode=(p_input->>'livemode')::boolean;
 if not found then raise exception 'Verified order not found' using errcode='P0002';end if;
 v:=(p_input->>'eligible_basis_minor')::bigint;verified:=(p_input->>'verified_at')::timestamptz;
 if v is null or v<0 or v>o.amount_minor or (p_input->>'total_minor')::bigint is distinct from o.amount_minor or p_input->>'currency' is distinct from o.currency or p_input->>'basis_policy' is distinct from 'post_discount_excluding_tax_shipping' or verified is null or verified>clock_timestamp()+interval '5 minutes' then raise exception 'Invalid verified commission basis' using errcode='22023';end if;
 insert into public.external_commission_bases(order_id,eligible_basis_minor,total_minor,currency,basis_policy,verified_at) values(o.id,v,o.amount_minor,o.currency,p_input->>'basis_policy',verified) on conflict do nothing;
 select * into b from public.external_commission_bases where order_id=o.id;
 if b.eligible_basis_minor<>v or b.total_minor<>o.amount_minor or b.currency<>o.currency then raise exception 'Verified basis changed' using errcode='22023';end if;
 return jsonb_build_object('order_id',o.id,'eligible_basis_minor',b.eligible_basis_minor);
end $$;

create function public.configure_admin_external_commission_terms(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.external_commission_terms;product uuid;funnel uuid;affiliate uuid;account text;live boolean;curr text;prior integer;request uuid:=(p_input->>'request_id')::uuid;previous public.external_settlement_requests;
begin
 perform public.assert_admin_password(array['owner','finance'],'configure external commissions');
 perform pg_advisory_xact_lock(8154,42);
 select * into previous from public.external_settlement_requests where request_id=request;
 if found then if previous.actor_id<>auth.uid() or previous.input<>p_input then raise exception 'Request identity changed' using errcode='22023';end if;return previous.result;end if;
 if request is null or jsonb_typeof(p_input->'livemode') is distinct from 'boolean' or jsonb_typeof(p_input) is distinct from 'object' or not(p_input ?& array['request_id','product_id','funnel_id','affiliate_id','stripe_account_id','platform_account_id','livemode','currency','calculation','hold_days','attribution_window_days','effective_from','expected_version','reason']) or exists(select 1 from jsonb_object_keys(p_input) k where k not in('request_id','product_id','funnel_id','affiliate_id','stripe_account_id','platform_account_id','livemode','currency','calculation','basis_points','fixed_minor','hold_days','attribution_window_days','effective_from','effective_until','expected_version','reason')) then raise exception 'Invalid external terms input' using errcode='22023';end if;
 product:=(p_input->>'product_id')::uuid;funnel:=(p_input->>'funnel_id')::uuid;affiliate:=(p_input->>'affiliate_id')::uuid;account:=p_input->>'stripe_account_id';live:=(p_input->>'livemode')::boolean;curr:=p_input->>'currency';
 if account is distinct from p_input->>'platform_account_id' or not exists(select 1 from public.products where id=product and tracking_mode='commercial' and status='active') or not exists(select 1 from public.affiliates where id=affiliate and status='active') or not exists(select 1 from public.funnels where id=funnel and product_id=product and status='live') or not exists(select 1 from public.affiliate_links where affiliate_id=affiliate and product_id=product and funnel_id=funnel) or not exists(select 1 from public.external_commerce_merchants where product_id=product and funnel_id=funnel and stripe_account_id=account and livemode=live) then raise exception 'External terms scope is not configured' using errcode='22023';end if;
 select coalesce(max(version),0) into prior from public.external_commission_terms where product_id=product and funnel_id=funnel and affiliate_id=affiliate and stripe_account_id=account and livemode=live and currency=curr;
 if (p_input->>'expected_version')::integer is distinct from prior then raise exception 'Terms changed; reload before saving' using errcode='40001';end if;
 insert into public.external_settlement_platforms(platform_account_id,livemode) values(account,live) on conflict do nothing;
 insert into public.external_commission_terms(product_id,funnel_id,affiliate_id,stripe_account_id,platform_account_id,livemode,currency,version,calculation,basis_points,fixed_minor,hold_days,attribution_window_days,effective_from,effective_until,reason,created_by)
 values(product,funnel,affiliate,account,account,live,curr,prior+1,p_input->>'calculation',(p_input->>'basis_points')::integer,(p_input->>'fixed_minor')::bigint,(p_input->>'hold_days')::integer,(p_input->>'attribution_window_days')::integer,(p_input->>'effective_from')::timestamptz,(p_input->>'effective_until')::timestamptz,trim(p_input->>'reason'),auth.uid()) returning * into t;
 insert into public.audit_logs(actor_user_id,actor_type,action,target_table,target_id,after_data) values(auth.uid(),'admin','external_terms_created','external_commission_terms',t.id,to_jsonb(t));
 insert into public.external_settlement_requests(request_id,actor_id,input,result) values(request,auth.uid(),p_input,to_jsonb(t));
 return to_jsonb(t);
end $$;

-- An account's immutable earning/reversal entries expose debt without treating a
-- refund after transfer as money still available to spend.
create function kma_internal.external_debt(p_affiliate uuid,p_platform text,p_live boolean,p_currency text) returns bigint language sql stable set search_path='' as $$
 select greatest(
  (select greatest(0,-coalesce(sum(amount_minor),0))::bigint from public.external_commission_ledger where affiliate_id=p_affiliate and platform_account_id=p_platform and livemode=p_live and currency=p_currency),
  (select coalesce(sum(i.amount_minor),0)::bigint from public.external_settlement_items i join public.external_commission_awards a on a.id=i.award_id join public.external_settlement_batches b on b.id=i.batch_id join public.external_settlement_jobs j on j.batch_id=b.id and j.kind='transfer' where b.affiliate_id=p_affiliate and b.platform_account_id=p_platform and b.livemode=p_live and b.currency=p_currency and a.status='reversed' and j.first_attempt_at is not null and not exists(select 1 from public.external_settlement_jobs r where r.batch_id=b.id and r.order_id=a.order_id and r.kind='reversal' and r.state='succeeded'))
 );
$$;
create function kma_internal.external_scope_review_frozen(p_affiliate uuid,p_platform text,p_live boolean,p_currency text) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.external_commerce_orders o join public.external_commission_awards a on a.order_id=o.id join public.external_settlement_items i on i.award_id=a.id join public.external_settlement_jobs j on j.batch_id=i.batch_id and j.kind='transfer' and j.first_attempt_at is not null where o.affiliate_id=p_affiliate and o.stripe_account_id=p_platform and o.livemode=p_live and o.currency=p_currency and exists(select 1 from public.external_commission_holds h where h.order_id=o.id and h.hold_type in('refund_partial','dispute')) and not exists(select 1 from public.external_commerce_events e where e.order_id=o.id and e.kind='refund') and not exists(select 1 from public.external_commission_holds h where h.order_id=o.id and h.hold_type='refund_full'));
$$;
create function kma_internal.external_order_payable(p_order uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.external_commerce_orders o join public.clicks c on c.id=o.click_record_id join public.acquisitions a on a.id=o.acquisition_id join public.products p on p.id=o.product_id join public.funnels f on f.id=o.funnel_id join public.affiliates partner on partner.id=o.affiliate_id where o.id=p_order and c.commercial_eligible and a.commercial_eligible and p.tracking_mode='commercial' and p.status='active' and f.status='live' and partner.status='active');
$$;
create function kma_internal.external_reverse_award(p_award uuid,p_reason text) returns void language plpgsql set search_path='' as $$
declare a public.external_commission_awards;o public.external_commerce_orders;b public.external_settlement_batches;j public.external_settlement_jobs;
begin
 select * into a from public.external_commission_awards where id=p_award for update;
 select * into o from public.external_commerce_orders where id=a.order_id;
 if a.commission_minor>0 then
  insert into public.external_commission_ledger(award_id,affiliate_id,platform_account_id,livemode,currency,kind,amount_minor,source_key) values(a.id,o.affiliate_id,o.stripe_account_id,o.livemode,o.currency,'reversed',-a.commission_minor,'reversed:'||a.id) on conflict(source_key) do nothing;
 end if;
 update public.external_commission_awards set status='reversed',blocker=p_reason,revision=revision+1 where id=a.id and status<>'reversed';
 for b in select x.* from public.external_settlement_batches x join public.external_settlement_items i on i.batch_id=x.id where i.award_id=a.id and x.status<>'cancelled' for update of x loop
  if b.status<>'transferred' then update public.external_settlement_batches set status='held',reason=p_reason,revision=revision+1 where id=b.id and status<>'held';end if;
  select * into j from public.external_settlement_jobs where batch_id=b.id and kind='transfer' and state='succeeded';
  if found then
   insert into public.external_settlement_jobs(batch_id,order_id,kind,platform_account_id,livemode,amount_minor,currency,destination,transfer_id,idempotency_key,transfer_group)
   values(b.id,a.order_id,'reversal',b.platform_account_id,b.livemode,a.commission_minor,b.currency,j.destination,j.provider_id,'external-reversal:'||b.id||':'||a.order_id,j.transfer_group) on conflict do nothing;
  end if;
 end loop;
end $$;

create function public.process_external_commissions(p_limit integer default 100) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.external_commerce_orders;a public.external_commission_awards;t public.external_commission_terms;basis public.external_commission_bases;purchase_at timestamptz;purchase_received_at timestamptz;click_at timestamptz;amount bigint;n integer:=0;
begin
 if p_limit not between 1 and 500 then raise exception 'Invalid processing limit' using errcode='22023';end if;
 perform pg_advisory_xact_lock(8154,42);
 if to_regprocedure('public.reconcile_creator_commercial_holds(integer)') is not null then execute 'select public.reconcile_creator_commercial_holds($1)' using p_limit;end if;
 for o in select x.* from public.external_commerce_orders x left join public.external_commission_awards z on z.order_id=x.id where z.id is null or z.status in('unconfigured','held') or (z.status<>'reversed' and exists(select 1 from public.external_commerce_events e where e.order_id=x.id and e.kind='refund')) order by coalesce(z.last_checked_at,'-infinity'::timestamptz),x.created_at,x.id limit p_limit loop
  select provider_occurred_at,created_at into purchase_at,purchase_received_at from public.external_commerce_events where order_id=o.id and kind='purchase';
  if purchase_at is null then continue;end if;
  insert into public.external_commission_awards(order_id,blocker) values(o.id,'terms_unconfigured') on conflict(order_id) do nothing;
  update public.external_commission_awards set last_checked_at=clock_timestamp() where order_id=o.id returning * into a;
  if not kma_internal.external_order_payable(o.id) and a.terms_id is null then update public.external_commission_awards set status='held',blocker='commercial_scope_ineligible' where id=a.id;continue;end if;
  if a.terms_id is null then
   select * into t from public.external_commission_terms where status='approved' and product_id=o.product_id and funnel_id=o.funnel_id and affiliate_id=o.affiliate_id and stripe_account_id=o.stripe_account_id and livemode=o.livemode and currency=o.currency and purchase_at>=effective_from and (effective_until is null or purchase_at<effective_until) and approved_at<=purchase_at and not exists(select 1 from public.external_commission_term_endings ending where ending.terms_id=external_commission_terms.id and purchase_at>=ending.effective_until) order by version desc limit 1;
   if not found then continue;end if;
   select * into basis from public.external_commission_bases where order_id=o.id;
   if not found then update public.external_commission_awards set status='held',blocker='verified_basis_missing' where id=a.id;continue;end if;
   select occurred_at into click_at from public.clicks where id=o.click_record_id;
   if click_at>purchase_at or purchase_at>click_at+make_interval(days=>t.attribution_window_days) then update public.external_commission_awards set status='held',blocker='outside_attribution_window' where id=a.id;continue;end if;
   if t.calculation='fixed' and t.fixed_minor>basis.eligible_basis_minor then update public.external_commission_awards set status='held',blocker='fixed_commission_exceeds_basis' where id=a.id;continue;end if;
   amount:=case when t.calculation='percentage' then floor(basis.eligible_basis_minor::numeric*t.basis_points/10000)::bigint else t.fixed_minor end;
   update public.external_commission_awards set terms_id=t.id,terms_snapshot=to_jsonb(t),basis_minor=basis.eligible_basis_minor,commission_minor=amount,eligible_at=greatest(purchase_at,purchase_received_at)+make_interval(days=>t.hold_days),status='held',blocker=case when amount=0 then 'zero_eligible_basis' else 'hold_period' end,revision=revision+1 where id=a.id returning * into a;
   if amount>0 then insert into public.external_commission_ledger(award_id,affiliate_id,platform_account_id,livemode,currency,kind,amount_minor,source_key) values(a.id,o.affiliate_id,t.platform_account_id,o.livemode,o.currency,'earned',amount,'earned:'||a.id) on conflict(source_key) do nothing;end if;
  end if;
  if exists(select 1 from public.external_commerce_events where order_id=o.id and kind='refund') then perform kma_internal.external_reverse_award(a.id,'full_refund');
  elsif exists(select 1 from public.external_commission_holds where order_id=o.id and hold_type='refund_full') then perform kma_internal.external_reverse_award(a.id,'verified_full_refund_hold');
  elsif exists(select 1 from public.external_commission_holds where order_id=o.id) then update public.external_commission_awards set status='held',blocker=case when exists(select 1 from public.external_commission_holds h where h.order_id=o.id and h.hold_type='dispute') then 'dispute_requires_review' else 'partial_refund_requires_review' end where id=a.id;
  elsif a.commission_minor>0 and a.eligible_at<=clock_timestamp() and a.status='held' then update public.external_commission_awards set status='eligible',blocker=null,revision=revision+1 where id=a.id;
  end if;n:=n+1;
 end loop;
 return jsonb_build_object('processed',n);
end $$;

create function public.hold_external_commission_order(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare order_id_value uuid:=(p_input->>'order_id')::uuid;a uuid;existing public.external_commission_holds;hold_type_value text:=coalesce(p_input->>'hold_type','dispute');o public.external_commerce_orders;
begin
 perform pg_advisory_xact_lock(8154,42);
 if length(coalesce(p_input->>'provider_event_id','')) not between 5 and 150 or length(coalesce(p_input->>'reason','')) not between 5 and 500 then raise exception 'Provider hold evidence is required' using errcode='22023';end if;
 select * into o from public.external_commerce_orders where id=order_id_value;
 if not found or hold_type_value not in('refund_full','refund_partial','dispute') or (hold_type_value='refund_full' and (p_input->>'verified_amount_minor')::bigint is distinct from o.amount_minor) or (hold_type_value='refund_partial' and ((p_input->>'verified_amount_minor')::bigint is null or (p_input->>'verified_amount_minor')::bigint<=0 or (p_input->>'verified_amount_minor')::bigint>=o.amount_minor)) then raise exception 'Invalid verified provider hold' using errcode='22023';end if;
 insert into public.external_commission_holds(order_id,provider_event_id,reason,hold_type,verified_amount_minor) values(order_id_value,p_input->>'provider_event_id',p_input->>'reason',hold_type_value,(p_input->>'verified_amount_minor')::bigint) on conflict(provider_event_id) do nothing;
 select * into existing from public.external_commission_holds where provider_event_id=p_input->>'provider_event_id';
 if existing.order_id<>order_id_value or existing.hold_type<>hold_type_value or existing.verified_amount_minor is distinct from (p_input->>'verified_amount_minor')::bigint then raise exception 'Provider hold identity changed' using errcode='22023';end if;
 select id into a from public.external_commission_awards where order_id=order_id_value;
 if a is not null then
  if exists(select 1 from public.external_commission_holds where order_id=order_id_value and hold_type='refund_full') or exists(select 1 from public.external_commerce_events where order_id=order_id_value and kind='refund') then perform kma_internal.external_reverse_award(a,'verified_full_refund_hold');
  else update public.external_commission_awards set status='held',blocker=case when exists(select 1 from public.external_commission_holds h where h.order_id=order_id_value and h.hold_type='dispute') then 'dispute_requires_review' else 'partial_refund_requires_review' end,revision=revision+1 where id=a and status<>'reversed';update public.external_settlement_batches set status='held',reason='Provider refund or dispute requires review',revision=revision+1 where id in(select batch_id from public.external_settlement_items where award_id=a) and status not in('transferred','cancelled');end if;
 end if;
 return jsonb_build_object('order_id',order_id_value,'held',true);
end $$;

create function public.creator_connect_context(p_platform_account_id text,p_livemode boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare affiliate uuid:=public.current_partner_affiliate_id(true);a public.external_creator_accounts;
begin
 if not public.current_user_has_affiliate_role(affiliate,array['owner','finance'],true) or not exists(select 1 from public.external_commission_terms where affiliate_id=affiliate and platform_account_id=p_platform_account_id and livemode=p_livemode and status='approved') then raise exception 'No authorized external payout scope' using errcode='42501';end if;
 insert into public.external_creator_accounts(affiliate_id,platform_account_id,livemode) values(affiliate,p_platform_account_id,p_livemode) on conflict do nothing;
 select * into a from public.external_creator_accounts where affiliate_id=affiliate and platform_account_id=p_platform_account_id and livemode=p_livemode;
 return to_jsonb(a)||jsonb_build_object('account_key',a.id);
end $$;
create function public.reserve_creator_connect_account(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.external_creator_accounts;country_value text:=p_input->>'country';
begin
 select * into a from public.external_creator_accounts where id=(p_input->>'account_key')::uuid for update;
 if not found or country_value is null or country_value!~'^[A-Z]{2}$' then raise exception 'Invalid creator account reservation' using errcode='22023';end if;
 if not exists(select 1 from public.external_settlement_platforms where platform_account_id=a.platform_account_id and livemode=a.livemode and enabled) then raise exception 'Provider connection is disabled' using errcode='55000';end if;
 if a.country is not null and a.country<>country_value then raise exception 'Reserved account country changed' using errcode='22023';end if;
 update public.external_creator_accounts set country=country_value,first_account_attempt_at=coalesce(first_account_attempt_at,clock_timestamp()) where id=a.id returning * into a;
 return to_jsonb(a)||jsonb_build_object('account_key',a.id);
end $$;
create function public.set_creator_connect_account(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.external_creator_accounts;verified timestamptz:=(p_input->>'verified_at')::timestamptz;
begin
 select * into a from public.external_creator_accounts where id=(p_input->>'account_key')::uuid for update;
 if not found or a.affiliate_id is distinct from (p_input->>'affiliate_id')::uuid or a.platform_account_id is distinct from p_input->>'platform_account_id' or a.livemode is distinct from (p_input->>'livemode')::boolean or coalesce(p_input->>'connect_account_id','')!~'^acct_[A-Za-z0-9]+$' or p_input->>'connect_account_id'=a.platform_account_id or verified is null or verified>clock_timestamp()+interval '5 minutes' then raise exception 'Invalid provider account scope' using errcode='22023';end if;
 if a.connect_account_id is not null and a.connect_account_id<>p_input->>'connect_account_id' then raise exception 'Creator destination cannot be reassigned' using errcode='22023';end if;
 if not(p_input ?& array['charges_enabled','payouts_enabled','transfers_enabled','details_submitted','requirements_due']) or jsonb_typeof(p_input->'requirements_due')<>'array' or jsonb_array_length(p_input->'requirements_due')>100 or exists(select 1 from jsonb_array_elements(p_input->'requirements_due') x where jsonb_typeof(x)<>'string') then raise exception 'Invalid account status' using errcode='22023';end if;
 if a.verified_at is not null and verified<a.verified_at then return to_jsonb(a)||jsonb_build_object('account_key',a.id,'stale',true);end if;
 update public.external_creator_accounts set connect_account_id=p_input->>'connect_account_id',charges_enabled=(p_input->>'charges_enabled')::boolean,payouts_enabled=(p_input->>'payouts_enabled')::boolean,transfers_enabled=(p_input->>'transfers_enabled')::boolean,details_submitted=(p_input->>'details_submitted')::boolean,requirements_due=p_input->'requirements_due',disabled_reason=left(p_input->>'disabled_reason',200),verified_at=verified,revision=revision+case when row(connect_account_id,charges_enabled,payouts_enabled,transfers_enabled,details_submitted,requirements_due,disabled_reason) is distinct from row(p_input->>'connect_account_id',(p_input->>'charges_enabled')::boolean,(p_input->>'payouts_enabled')::boolean,(p_input->>'transfers_enabled')::boolean,(p_input->>'details_submitted')::boolean,p_input->'requirements_due',left(p_input->>'disabled_reason',200)) then 1 else 0 end,status=case when coalesce(p_input->>'disabled_reason','')<>'' then 'restricted' when (p_input->>'transfers_enabled')::boolean and (p_input->>'payouts_enabled')::boolean and (p_input->>'details_submitted')::boolean then 'ready' else 'pending' end where id=a.id returning * into a;
 return to_jsonb(a)||jsonb_build_object('account_key',a.id);
end $$;

create function kma_internal.external_batch_valid(p_batch uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.external_settlement_batches b join public.external_creator_accounts a on a.affiliate_id=b.affiliate_id and a.platform_account_id=b.platform_account_id and a.livemode=b.livemode join public.external_settlement_platforms p on p.platform_account_id=b.platform_account_id and p.livemode=b.livemode
 where b.id=p_batch and p.enabled and a.status='ready' and a.verified_at>clock_timestamp()-interval '24 hours' and (b.destination is null or b.destination=a.connect_account_id)
 and not kma_internal.external_scope_review_frozen(b.affiliate_id,b.platform_account_id,b.livemode,b.currency)
 and kma_internal.external_debt(b.affiliate_id,b.platform_account_id,b.livemode,b.currency)=0
 and b.amount_minor=(select sum(i.amount_minor) from public.external_settlement_items i where i.batch_id=b.id)
 and not exists(select 1 from public.external_settlement_items i join public.external_commission_awards w on w.id=i.award_id where i.batch_id=b.id and (w.status<>'eligible' or not kma_internal.external_order_payable(w.order_id) or w.commission_minor<>i.amount_minor or exists(select 1 from public.external_commerce_events e where e.order_id=w.order_id and e.kind='refund') or exists(select 1 from public.external_commission_holds h where h.order_id=w.order_id)))
 );
$$;

create function public.perform_admin_external_settlement_action(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare action_value text:=p_input->>'action';actor uuid;request uuid:=(p_input->>'request_id')::uuid;prior public.external_settlement_requests;t public.external_commission_terms;b public.external_settlement_batches;a public.external_creator_accounts;result jsonb;ids uuid[];amount bigint;target uuid:=(p_input->>'id')::uuid;reason_value text:=trim(p_input->>'reason');
begin
 perform public.assert_admin_password(array['owner','finance'],'operate external settlement');actor:=auth.uid();perform pg_advisory_xact_lock(8154,42);
 if jsonb_typeof(p_input) is distinct from 'object' or action_value is null or exists(select 1 from jsonb_object_keys(p_input) k where k not in('request_id','action','id','expected_revision','reason','product_id','funnel_id','affiliate_id','platform_account_id','livemode','currency','enabled')) or request is null or length(coalesce(reason_value,'')) not between 5 and 500 or action_value not in('approve_terms','prepare_batch','review_batch','approve_batch','hold_batch','cancel_batch','reconcile_batch','set_platform_enabled') then raise exception 'Invalid settlement action' using errcode='22023';end if;
 select * into prior from public.external_settlement_requests where request_id=request;
 if found then if prior.actor_id<>actor or prior.input<>p_input then raise exception 'Request identity changed' using errcode='22023';end if;return prior.result;end if;
 if action_value='approve_terms' then
  select * into t from public.external_commission_terms where id=target for update;
  if not found then raise exception 'Terms not found' using errcode='P0002';end if;
  if not exists(select 1 from public.products p join public.funnels f on f.product_id=p.id where p.id=t.product_id and p.status='active' and p.tracking_mode='commercial' and f.id=t.funnel_id and f.status='live') or not exists(select 1 from public.affiliates where id=t.affiliate_id and status='active') then raise exception 'Commercial scope is not active' using errcode='55000';end if;
  if t.revision is distinct from (p_input->>'expected_revision')::integer or t.status<>'draft' then raise exception 'Terms changed; reload before approval' using errcode='40001';end if;
  if t.effective_until is not null and t.effective_until<=clock_timestamp() then raise exception 'Terms are already expired' using errcode='22023';end if;
  if exists(select 1 from public.external_commission_terms x where x.id<>t.id and x.status='approved' and x.product_id=t.product_id and x.funnel_id=t.funnel_id and x.affiliate_id=t.affiliate_id and x.stripe_account_id=t.stripe_account_id and x.livemode=t.livemode and x.currency=t.currency and (x.effective_from>=t.effective_from or t.effective_from<clock_timestamp())) then raise exception 'A new approved version must start prospectively after prior versions' using errcode='22023';end if;
  insert into public.external_commission_term_endings(terms_id,successor_id,effective_until) select x.id,t.id,t.effective_from from public.external_commission_terms x where x.id<>t.id and x.status='approved' and x.product_id=t.product_id and x.funnel_id=t.funnel_id and x.affiliate_id=t.affiliate_id and x.stripe_account_id=t.stripe_account_id and x.livemode=t.livemode and x.currency=t.currency and (x.effective_until is null or x.effective_until>t.effective_from) and not exists(select 1 from public.external_commission_term_endings e where e.terms_id=x.id);
  update public.external_commission_terms set status='approved',revision=revision+1,approved_at=clock_timestamp(),approved_by=actor where id=t.id returning to_jsonb(external_commission_terms.*) into result;
 elsif action_value='set_platform_enabled' then
  if jsonb_typeof(p_input->'enabled') is distinct from 'boolean' then raise exception 'Explicit provider mode required' using errcode='22023';end if;
  update public.external_settlement_platforms set enabled=(p_input->>'enabled')::boolean,revision=revision+1 where platform_account_id=p_input->>'platform_account_id' and livemode=(p_input->>'livemode')::boolean and revision=(p_input->>'expected_revision')::integer returning to_jsonb(external_settlement_platforms.*) into result;
  if result is null then raise exception 'Platform changed or is not configured' using errcode='40001';end if;
 elsif action_value='prepare_batch' then
  perform public.process_external_commissions(500);
  if kma_internal.external_scope_review_frozen((p_input->>'affiliate_id')::uuid,p_input->>'platform_account_id',(p_input->>'livemode')::boolean,p_input->>'currency') then raise exception 'Provider refund or dispute requires financial review before further settlement' using errcode='55000';end if;
  if kma_internal.external_debt((p_input->>'affiliate_id')::uuid,p_input->>'platform_account_id',(p_input->>'livemode')::boolean,p_input->>'currency')>0 then raise exception 'Unresolved creator debt blocks settlement' using errcode='55000';end if;
  select array_agg(w.id order by w.id),sum(w.commission_minor) into ids,amount from public.external_commission_awards w join public.external_commerce_orders o on o.id=w.order_id where w.status='eligible' and kma_internal.external_order_payable(o.id) and o.product_id=(p_input->>'product_id')::uuid and o.funnel_id=(p_input->>'funnel_id')::uuid and o.affiliate_id=(p_input->>'affiliate_id')::uuid and o.stripe_account_id=p_input->>'platform_account_id' and o.livemode=(p_input->>'livemode')::boolean and o.currency=p_input->>'currency' and not exists(select 1 from public.external_settlement_items i join public.external_settlement_batches b0 on b0.id=i.batch_id where i.award_id=w.id and b0.status<>'cancelled');
  if amount is null or amount<=0 or cardinality(ids)>500 then raise exception 'No bounded positive eligible settlement' using errcode='55000';end if;
  insert into public.external_settlement_batches(product_id,funnel_id,affiliate_id,platform_account_id,livemode,currency,amount_minor,reason,created_by) values((p_input->>'product_id')::uuid,(p_input->>'funnel_id')::uuid,(p_input->>'affiliate_id')::uuid,p_input->>'platform_account_id',(p_input->>'livemode')::boolean,p_input->>'currency',amount,reason_value,actor) returning * into b;
  insert into public.external_settlement_items(batch_id,award_id,amount_minor) select b.id,w.id,w.commission_minor from public.external_commission_awards w where w.id=any(ids);
  result:=to_jsonb(b);
 else
  select * into b from public.external_settlement_batches where id=target for update;
  if not found then raise exception 'Settlement batch not found' using errcode='P0002';end if;
  if b.revision is distinct from (p_input->>'expected_revision')::integer then raise exception 'Batch changed; reload before acting' using errcode='40001';end if;
  if action_value='reconcile_batch' then
   if not exists(select 1 from public.external_settlement_jobs where batch_id=b.id and first_attempt_at is not null and state in('reconcile','failed','pending')) then raise exception 'No attempted provider operation needs reconciliation' using errcode='55000';end if;
   update public.external_settlement_jobs set state='reconcile',last_error='Admin requested read-only provider reconciliation',last_reconciled_at=null where batch_id=b.id and first_attempt_at is not null and state in('reconcile','failed','pending');
   update public.external_settlement_batches set reason=reason_value,revision=revision+1 where id=b.id returning to_jsonb(external_settlement_batches.*) into result;
  elsif action_value in('hold_batch','cancel_batch') then
   if b.status in('transferred','cancelled') or exists(select 1 from public.external_settlement_jobs where batch_id=b.id and kind='transfer' and first_attempt_at is not null) then raise exception 'Provider attempt requires reconciliation; cancellation cannot erase it' using errcode='55000';end if;
   update public.external_settlement_batches set status=case when action_value='hold_batch' then 'held' else 'cancelled' end,reason=reason_value,revision=revision+1 where id=b.id returning to_jsonb(external_settlement_batches.*) into result;
  else
   if (action_value='review_batch' and b.status not in('draft','held')) or (action_value='approve_batch' and b.status<>'reviewed') then raise exception 'Review this batch before approval' using errcode='55000';end if;
   if not kma_internal.external_batch_valid(b.id) then raise exception 'Settlement blocked by refund, debt, destination or provider configuration' using errcode='55000';end if;
   select * into a from public.external_creator_accounts where affiliate_id=b.affiliate_id and platform_account_id=b.platform_account_id and livemode=b.livemode;
   if action_value='approve_batch' and b.account_revision<>a.revision then raise exception 'Destination status changed; review again' using errcode='40001';end if;
   update public.external_settlement_batches set status=case when action_value='review_batch' then 'reviewed' else 'approved' end,reason=reason_value,revision=revision+1,destination=a.connect_account_id,account_revision=a.revision,reviewed_at=case when action_value='review_batch' then clock_timestamp() else reviewed_at end,approved_at=case when action_value='approve_batch' then clock_timestamp() else null end,approved_by=case when action_value='approve_batch' then actor else null end where id=b.id returning * into b;
   if action_value='approve_batch' then insert into public.external_settlement_jobs(batch_id,kind,platform_account_id,livemode,amount_minor,currency,destination,idempotency_key,transfer_group) values(b.id,'transfer',b.platform_account_id,b.livemode,b.amount_minor,b.currency,b.destination,'external-transfer:'||b.id,'external-batch:'||b.id) on conflict do nothing;end if;
   result:=to_jsonb(b);
  end if;
 end if;
 insert into public.external_settlement_requests(request_id,actor_id,input,result) values(request,actor,p_input,result);
 insert into public.audit_logs(actor_user_id,actor_type,action,target_table,target_id,after_data) values(actor,'admin','external_'||action_value,'external_settlement_batches',target,jsonb_build_object('reason',reason_value,'request_id',request,'result',result));
 return result;
end $$;

create function public.claim_creator_transfer_jobs(p_platform_account_id text,p_livemode boolean,p_limit integer default 10,p_lease_seconds integer default 120) returns setof jsonb language plpgsql security definer set search_path='' as $$
declare j public.external_settlement_jobs;b public.external_settlement_batches;
begin
 if p_limit not between 1 and 50 or p_lease_seconds not between 30 and 300 then raise exception 'Invalid worker lease' using errcode='22023';end if;
 perform pg_advisory_xact_lock(8154,42);perform public.process_external_commissions(500);
 if not exists(select 1 from public.external_settlement_platforms where platform_account_id=p_platform_account_id and livemode=p_livemode and enabled) then return;end if;
 for j in select * from public.external_settlement_jobs where platform_account_id=p_platform_account_id and livemode=p_livemode and ((state='pending' and next_attempt_at<=clock_timestamp()) or (state='leased' and lease_expires_at<clock_timestamp())) order by created_at,id for update skip locked limit p_limit loop
  select * into b from public.external_settlement_batches where id=j.batch_id for update;
  if j.kind='transfer' and j.first_attempt_at is null and (b.status<>'approved' or not kma_internal.external_batch_valid(b.id)) then update public.external_settlement_batches set status='held',reason='Settlement eligibility changed',revision=revision+1 where id=b.id and status not in('cancelled','transferred');continue;end if;
  if j.kind='transfer' and j.first_attempt_at is not null and not kma_internal.external_batch_valid(b.id) then update public.external_settlement_jobs set state='reconcile',last_error='Eligibility changed during provider attempt; retrieve evidence before any retry' where id=j.id;continue;end if;
  -- A provider attempt may already have succeeded. Never invent a new operation
  -- or lose its receipt because a refund/disable happened during network I/O.
  if j.first_attempt_at is not null and j.first_attempt_at<clock_timestamp()-interval '23 hours' then update public.external_settlement_jobs set state='reconcile',last_error='Provider idempotency window requires reconciliation' where id=j.id;continue;end if;
  update public.external_settlement_jobs set state='leased',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),first_attempt_at=coalesce(first_attempt_at,clock_timestamp()),attempt_count=attempt_count+1 where id=j.id returning * into j;
  if j.kind='transfer' and b.status='approved' then update public.external_settlement_batches set status='processing',revision=revision+1 where id=b.id;end if;
  return next to_jsonb(j);
 end loop;
end $$;

create function public.claim_creator_reconciliation_jobs(p_platform_account_id text,p_livemode boolean,p_limit integer default 10) returns setof jsonb language plpgsql security definer set search_path='' as $$
declare j public.external_settlement_jobs;
begin
 if p_limit not between 1 and 50 then raise exception 'Invalid reconciliation limit' using errcode='22023';end if;
 perform pg_advisory_xact_lock(8154,42);
 for j in select * from public.external_settlement_jobs where platform_account_id=p_platform_account_id and livemode=p_livemode and state in('reconcile','failed') and first_attempt_at is not null and (last_reconciled_at is null or last_reconciled_at<clock_timestamp()-interval '5 minutes') order by last_reconciled_at nulls first,created_at,id for update skip locked limit p_limit loop
  update public.external_settlement_jobs set last_reconciled_at=clock_timestamp() where id=j.id returning * into j;
  return next to_jsonb(j);
 end loop;
end $$;

create function public.finish_creator_transfer_job(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.external_settlement_jobs;b public.external_settlement_batches;state_value text:=p_input->>'status';provider text:=p_input->>'provider_id';a public.external_commission_awards;
begin
 perform pg_advisory_xact_lock(8154,42);
 select * into j from public.external_settlement_jobs where id=(p_input->>'id')::uuid for update;
 if not found then raise exception 'Provider operation not found' using errcode='P0002';end if;
 if j.state='succeeded' and state_value='succeeded' and j.provider_id=provider then return jsonb_build_object('id',j.id,'state',j.state,'provider_id',j.provider_id,'duplicate',true);end if;
 if j.state<>'leased' or j.lease_token is distinct from (p_input->>'lease_token')::uuid then raise exception 'Provider lease changed' using errcode='40001';end if;
 if state_value is null or state_value not in('succeeded','retry','reconcile','failed') then raise exception 'Invalid provider result' using errcode='22023';end if;
 if state_value='succeeded' and (provider is null or (j.kind='transfer' and provider!~'^tr_[A-Za-z0-9]+$') or (j.kind='reversal' and provider!~'^trr_[A-Za-z0-9]+$')) then raise exception 'Provider receipt is required' using errcode='22023';end if;
 select * into b from public.external_settlement_batches where id=j.batch_id for update;
 update public.external_settlement_jobs set state=case state_value when 'retry' then 'pending' else state_value end,provider_id=case when state_value='succeeded' then provider else null end,last_error=case when state_value='succeeded' then null else left(coalesce(p_input->>'safe_error','Provider reconciliation required'),200) end,lease_expires_at=null,next_attempt_at=case when state_value='retry' then clock_timestamp()+make_interval(secs=>least(3600,60*power(2,least(greatest(j.attempt_count-1,0),6)))::integer) else next_attempt_at end where id=j.id returning * into j;
 if state_value='succeeded' then
  insert into public.external_commission_ledger(batch_id,affiliate_id,platform_account_id,livemode,currency,kind,amount_minor,source_key) values(b.id,b.affiliate_id,b.platform_account_id,b.livemode,b.currency,case j.kind when 'transfer' then 'transfer' else 'transfer_reversal' end,case j.kind when 'transfer' then -j.amount_minor else j.amount_minor end,'provider:'||j.id) on conflict(source_key) do nothing;
  if j.kind='transfer' then
   update public.external_settlement_batches set status='transferred',transferred_at=clock_timestamp(),revision=revision+1 where id=b.id;
   for a in select w.* from public.external_commission_awards w join public.external_settlement_items i on i.award_id=w.id where i.batch_id=b.id and (w.status='reversed' or exists(select 1 from public.external_commerce_events e where e.order_id=w.order_id and e.kind='refund') or exists(select 1 from public.external_commission_holds h where h.order_id=w.order_id and h.hold_type='refund_full')) loop perform kma_internal.external_reverse_award(a.id,'refund_or_dispute_after_transfer');end loop;
  end if;
 end if;
 return jsonb_build_object('id',j.id,'state',j.state,'provider_id',j.provider_id,'duplicate',false);
end $$;

create function public.reconcile_creator_transfer_evidence(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.external_settlement_jobs;token uuid;result jsonb;reversed bigint;known bigint;observed timestamptz;
begin
 perform pg_advisory_xact_lock(8154,42);
 select * into j from public.external_settlement_jobs where id=(p_input->>'id')::uuid for update;
 reversed:=(p_input->>'amount_reversed')::bigint;observed:=(p_input->>'observed_at')::timestamptz;
 if not found or j.kind<>'transfer' or j.first_attempt_at is null or j.platform_account_id is distinct from p_input->>'platform_account_id' or j.livemode is distinct from (p_input->>'livemode')::boolean or j.destination is distinct from p_input->>'destination' or j.amount_minor is distinct from (p_input->>'amount_minor')::bigint or j.currency is distinct from upper(p_input->>'currency') or j.transfer_group is distinct from p_input->>'transfer_group' or coalesce(p_input->>'provider_id','')!~'^tr_[A-Za-z0-9]+$' or reversed is null or reversed<0 or reversed>j.amount_minor or observed is null or observed>clock_timestamp()+interval '5 minutes' then raise exception 'Transfer evidence does not match the frozen operation' using errcode='22023';end if;
 if j.state='succeeded' then
  if j.provider_id is distinct from p_input->>'provider_id' then raise exception 'Provider identity changed' using errcode='22023';end if;
  result:=jsonb_build_object('id',j.id,'state',j.state,'provider_id',j.provider_id,'duplicate',true);
 else
  token:=gen_random_uuid();update public.external_settlement_jobs set state='leased',lease_token=token where id=j.id;
  result:=public.finish_creator_transfer_job(jsonb_build_object('id',j.id,'lease_token',token,'status','succeeded','provider_id',p_input->>'provider_id'));
 end if;
 select coalesce(sum(amount_minor),0) into known from public.external_settlement_jobs where batch_id=j.batch_id and kind='reversal' and state='succeeded';
 -- Uncorrelated manual reversals are evidence for investigation. Never guess
 -- which order they reversed or credit the same recovery twice. Keep the warning
 -- visible even if a later-delivered, older provider event contains a lower total.
 if reversed>known then
  update public.external_settlement_jobs set last_error='Provider reversal does not match recorded recoveries; financial review required' where id=j.id;
 end if;
 return result||jsonb_build_object('reconciliation_required',reversed<>known or exists(select 1 from public.external_settlement_jobs where id=j.id and last_error='Provider reversal does not match recorded recoveries; financial review required'),'observed_amount_reversed',reversed);
end $$;

create function public.reconcile_creator_reversal_evidence(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.external_settlement_jobs;token uuid;observed timestamptz;
begin
 perform pg_advisory_xact_lock(8154,42);
 select * into j from public.external_settlement_jobs where id=(p_input->>'id')::uuid for update;
 observed:=(p_input->>'observed_at')::timestamptz;
 if not found or j.kind<>'reversal' or j.first_attempt_at is null or j.platform_account_id is distinct from p_input->>'platform_account_id' or j.livemode is distinct from (p_input->>'livemode')::boolean or j.destination is distinct from p_input->>'destination' or j.amount_minor is distinct from (p_input->>'amount_minor')::bigint or j.currency is distinct from upper(p_input->>'currency') or j.transfer_id is distinct from p_input->>'transfer_id' or coalesce(p_input->>'provider_id','')!~'^trr_[A-Za-z0-9]+$' or observed is null or observed>clock_timestamp()+interval '5 minutes' then raise exception 'Reversal evidence does not match the frozen operation' using errcode='22023';end if;
 if j.state='succeeded' then
  if j.provider_id is distinct from p_input->>'provider_id' then raise exception 'Provider identity changed' using errcode='22023';end if;
  return jsonb_build_object('id',j.id,'state',j.state,'provider_id',j.provider_id,'duplicate',true);
 end if;
 token:=gen_random_uuid();update public.external_settlement_jobs set state='leased',lease_token=token where id=j.id;
 return public.finish_creator_transfer_job(jsonb_build_object('id',j.id,'lease_token',token,'status','succeeded','provider_id',p_input->>'provider_id'));
end $$;

create function kma_internal.external_settlement_workspace(p_input jsonb,p_admin boolean) returns jsonb language plpgsql stable set search_path='' as $$
declare affiliate uuid;product uuid:=(p_input->>'product_id')::uuid;funnel uuid:=(p_input->>'funnel_id')::uuid;live boolean:=(p_input->>'livemode')::boolean;result jsonb;bank jsonb;
begin
 if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input) k where k not in('product_id','funnel_id','affiliate_id','livemode')) then raise exception 'Invalid settlement filter' using errcode='22023';end if;
 if p_admin then if not public.current_user_is_admin(array['owner','finance','operations','analyst']) then raise exception 'Admin role required' using errcode='42501';end if;affiliate:=(p_input->>'affiliate_id')::uuid;
 else affiliate:=public.current_partner_affiliate_id(false);if p_input?'affiliate_id' and (p_input->>'affiliate_id')::uuid is distinct from affiliate then raise exception 'Foreign creator scope' using errcode='42501';end if;end if;
 with scopes as (select distinct m.product_id,p.name product_name,m.funnel_id,f.name funnel_name,l.affiliate_id,a.public_name affiliate_name,m.stripe_account_id,m.stripe_account_id platform_account_id,m.livemode,t.currency currency from public.external_commerce_merchants m join public.products p on p.id=m.product_id join public.funnels f on f.id=m.funnel_id join public.affiliate_links l on l.product_id=m.product_id and l.funnel_id=m.funnel_id join public.affiliates a on a.id=l.affiliate_id left join public.external_commission_terms t on t.product_id=m.product_id and t.funnel_id=m.funnel_id and t.affiliate_id=l.affiliate_id and t.stripe_account_id=m.stripe_account_id and t.livemode=m.livemode where (affiliate is null or l.affiliate_id=affiliate) and (product is null or m.product_id=product) and (funnel is null or m.funnel_id=funnel) and (live is null or m.livemode=live) limit 100),
 terms as(select t.* from public.external_commission_terms t where (p_admin or t.status='approved') and (affiliate is null or t.affiliate_id=affiliate) and (product is null or t.product_id=product) and (funnel is null or t.funnel_id=funnel) and (live is null or t.livemode=live) order by t.created_at desc limit 100),
 commissions as(select w.id,w.order_id,o.product_id,o.funnel_id,o.affiliate_id,o.livemode,o.currency,w.commission_minor,w.basis_minor,w.status,w.blocker,w.eligible_at,w.terms_id,w.revision from public.external_commission_awards w join public.external_commerce_orders o on o.id=w.order_id where (affiliate is null or o.affiliate_id=affiliate) and (product is null or o.product_id=product) and (funnel is null or o.funnel_id=funnel) and (live is null or o.livemode=live) order by w.created_at desc limit 100),
 batches as(select b.id,b.revision,b.status,b.product_id,b.funnel_id,b.affiliate_id,b.platform_account_id,b.livemode,b.currency,b.amount_minor,b.created_at,b.reviewed_at,b.approved_at,b.transferred_at,case when p_admin then b.reason else null end reason,(select coalesce(jsonb_agg(jsonb_build_object('award_id',w.id,'order_id',w.order_id,'amount_minor',i.amount_minor,'status',w.status,'eligible_at',w.eligible_at) order by w.id),'[]') from public.external_settlement_items i join public.external_commission_awards w on w.id=i.award_id where i.batch_id=b.id) items,(select coalesce(jsonb_agg(jsonb_build_object('kind',j.kind,'state',j.state,'last_error',case when p_admin then j.last_error else null end,'attempts',j.attempt_count,'first_attempt_at',j.first_attempt_at,'next_attempt_at',j.next_attempt_at) order by j.created_at),'[]') from public.external_settlement_jobs j where j.batch_id=b.id) provider_jobs from public.external_settlement_batches b where (affiliate is null or b.affiliate_id=affiliate) and (product is null or b.product_id=product) and (funnel is null or b.funnel_id=funnel) and (live is null or b.livemode=live) order by b.created_at desc limit 100),
 accounts as(select a.affiliate_id,a.platform_account_id,a.livemode,a.status,a.details_submitted,a.transfers_enabled,a.payouts_enabled,a.requirements_due,a.revision,a.verified_at from public.external_creator_accounts a where exists(select 1 from scopes s where s.affiliate_id=a.affiliate_id and s.platform_account_id=a.platform_account_id and s.livemode=a.livemode) limit 100),
 balances as(select l.affiliate_id,l.platform_account_id,l.livemode,l.currency,coalesce(sum(l.amount_minor) filter(where l.kind='earned'),0) earned_minor,-coalesce(sum(l.amount_minor) filter(where l.kind='reversed'),0) reversed_minor,-coalesce(sum(l.amount_minor) filter(where l.kind='transfer'),0) transferred_minor,coalesce(sum(l.amount_minor) filter(where l.kind='transfer_reversal'),0) recovered_minor,sum(l.amount_minor) balance_minor,kma_internal.external_debt(l.affiliate_id,l.platform_account_id,l.livemode,l.currency) debt_minor,kma_internal.external_scope_review_frozen(l.affiliate_id,l.platform_account_id,l.livemode,l.currency) review_required from public.external_commission_ledger l where exists(select 1 from scopes s where s.affiliate_id=l.affiliate_id and s.platform_account_id=l.platform_account_id and s.livemode=l.livemode) group by l.affiliate_id,l.platform_account_id,l.livemode,l.currency limit 100)
 select jsonb_build_object('scopes',coalesce((select jsonb_agg(to_jsonb(s)) from scopes s),'[]'),'platforms',coalesce((select jsonb_agg(to_jsonb(p)) from public.external_settlement_platforms p where exists(select 1 from scopes s where s.platform_account_id=p.platform_account_id and s.livemode=p.livemode)),'[]'),'terms',coalesce((select jsonb_agg(to_jsonb(t)-case when p_admin then array[]::text[] else array['created_by','approved_by','reason'] end) from terms t),'[]'),'commissions',coalesce((select jsonb_agg(to_jsonb(c)) from commissions c),'[]'),'batches',coalesce((select jsonb_agg(to_jsonb(b)) from batches b),'[]'),'accounts',coalesce((select jsonb_agg(to_jsonb(a)) from accounts a),'[]'),'balances',coalesce((select jsonb_agg(to_jsonb(b)) from balances b),'[]'),'balance_scope','funding_account','bank_payouts','[]'::jsonb,'truncated',(select count(*)>=100 from scopes) or (select count(*)>=100 from terms) or (select count(*)>=100 from commissions) or (select count(*)>=100 from batches)) into result;
 if to_regprocedure('kma_internal.external_bank_payout_rows(uuid,text,boolean)') is not null then
  execute 'select kma_internal.external_bank_payout_rows($1,$2,$3)' into bank using affiliate,null::text,live;
  result:=jsonb_set(result,'{bank_payouts}',coalesce(bank,'[]'::jsonb));
 end if;
 return result;
end $$;
create function public.get_admin_external_settlement_workspace(p_input jsonb default '{}') returns jsonb language sql stable security definer set search_path='' as $$select kma_internal.external_settlement_workspace(p_input,true);$$;
create function public.get_partner_external_settlement_workspace(p_input jsonb default '{}') returns jsonb language sql stable security definer set search_path='' as $$select kma_internal.external_settlement_workspace(p_input,false);$$;

do $$declare table_name text;function_name text;begin
 foreach table_name in array array['external_settlement_platforms','external_commission_terms','external_commission_term_endings','external_commission_bases','external_creator_accounts','external_commission_awards','external_commission_holds','external_settlement_batches','external_settlement_items','external_settlement_jobs','external_commission_ledger','external_settlement_requests'] loop
  execute format('alter table public.%I enable row level security',table_name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',table_name);execute format('grant select on public.%I to service_role',table_name);
 end loop;
 foreach function_name in array array['record_external_commission_basis(jsonb)','configure_admin_external_commission_terms(jsonb)','process_external_commissions(integer)','hold_external_commission_order(jsonb)','creator_connect_context(text,boolean)','reserve_creator_connect_account(jsonb)','set_creator_connect_account(jsonb)','perform_admin_external_settlement_action(jsonb)','claim_creator_transfer_jobs(text,boolean,integer,integer)','claim_creator_reconciliation_jobs(text,boolean,integer)','finish_creator_transfer_job(jsonb)','reconcile_creator_transfer_evidence(jsonb)','reconcile_creator_reversal_evidence(jsonb)','get_admin_external_settlement_workspace(jsonb)','get_partner_external_settlement_workspace(jsonb)'] loop
  execute 'revoke all on function public.'||function_name||' from public,anon,authenticated,service_role';
 end loop;
end $$;
grant execute on function public.configure_admin_external_commission_terms(jsonb),public.creator_connect_context(text,boolean),public.perform_admin_external_settlement_action(jsonb),public.get_admin_external_settlement_workspace(jsonb),public.get_partner_external_settlement_workspace(jsonb) to authenticated;
grant execute on function public.record_external_commission_basis(jsonb),public.process_external_commissions(integer),public.hold_external_commission_order(jsonb),public.reserve_creator_connect_account(jsonb),public.set_creator_connect_account(jsonb),public.claim_creator_transfer_jobs(text,boolean,integer,integer),public.claim_creator_reconciliation_jobs(text,boolean,integer),public.finish_creator_transfer_job(jsonb),public.reconcile_creator_transfer_evidence(jsonb),public.reconcile_creator_reversal_evidence(jsonb) to service_role;
revoke all on function kma_internal.external_terms_history(),kma_internal.external_scope_review_frozen(uuid,text,boolean,text),kma_internal.external_order_payable(uuid),kma_internal.external_debt(uuid,text,boolean,text),kma_internal.external_reverse_award(uuid,text),kma_internal.external_batch_valid(uuid),kma_internal.external_settlement_workspace(jsonb,boolean) from public,anon,authenticated,service_role;
commit;
