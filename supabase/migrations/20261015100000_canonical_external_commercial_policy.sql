-- One signed commercial policy, separate operational merchant/funding binding.
-- No provider is enabled and no money is moved by this migration.
begin;
alter table public.commission_rules
 add column policy_version smallint not null default 1 check(policy_version in(1,2)),
 add column refund_cutoff_days integer check(refund_cutoff_days between 0 and 3650),
 add column commission_basis_policy text not null default 'net_after_fees' check(commission_basis_policy in('net_after_fees','subtotal_ex_tax_shipping')),
 add constraint commission_policy_v1_compatibility check(policy_version=2 or (refund_cutoff_days is null and commission_basis_policy='net_after_fees'));
-- Existing signed revisions retain their exact JSON/hash. Only new rules include
-- explicit policy-v2 fields in the bilateral commercial snapshot.
create or replace function public.agreement_terms_snapshot(p_agreement_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'agreement_id', a.id, 'affiliate_id', a.affiliate_id, 'product_id', a.product_id,
    'version', a.version, 'model', a.model,
    'attribution_window_days', a.attribution_window_days,
    'renewal_duration_days', a.renewal_duration_days,
    'payout_frequency_days', a.payout_frequency_days, 'payout_currency', a.payout_currency,
    'minimum_payout_minor', a.minimum_payout_minor,
    'rules', coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'version', r.version, 'name', r.name, 'model', r.model,
      'trigger_event', r.trigger_event, 'fixed_amount_minor', r.fixed_amount_minor,
      'rate_basis_points', r.rate_basis_points, 'currency', r.currency,
      'validation_window_hours', r.validation_window_hours
    ) || case when r.policy_version=2 then jsonb_build_object('policy_version',2,'refund_cutoff_days',r.refund_cutoff_days,'commission_basis_policy',r.commission_basis_policy,'external_refund_calculation','proportional_commission') else '{}'::jsonb end order by r.id) from public.commission_rules r
      where r.agreement_id = a.id and r.status = 'active'), '[]'::jsonb)
  ) from public.agreements a where a.id = p_agreement_id;
$$;
create or replace function public.create_admin_commission_rule(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'agreement_id', 'name', 'model', 'trigger_event', 'fixed_amount_minor',
    'rate_basis_points', 'currency', 'validation_window_hours', 'refund_cutoff_days', 'commission_basis_policy'
  ];
  agreement_id_value uuid;
  next_version integer;
  stored public.commission_rules%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'create commission rules');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'commission rule input is invalid' using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_object_keys(p_input) as input_key(key_name)
       where input_key.key_name <> all(allowed_keys)
     ) then
    raise exception 'commission rule input is invalid' using errcode = '22023';
  end if;
  if not (p_input ? 'agreement_id') or not (p_input ? 'name') or not (p_input ? 'trigger_event') then
    raise exception 'agreement_id, name, and trigger_event are required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'agreement_id') <> 'string'
     or jsonb_typeof(p_input -> 'name') <> 'string'
     or jsonb_typeof(p_input -> 'trigger_event') <> 'string'
     or (p_input ? 'model' and jsonb_typeof(p_input -> 'model') not in ('string', 'null'))
     or (p_input ? 'fixed_amount_minor' and jsonb_typeof(p_input -> 'fixed_amount_minor') not in ('number', 'null'))
     or (p_input ? 'rate_basis_points' and jsonb_typeof(p_input -> 'rate_basis_points') not in ('number', 'null'))
     or (p_input ? 'currency' and jsonb_typeof(p_input -> 'currency') not in ('string', 'null'))
     or (p_input ? 'refund_cutoff_days' and jsonb_typeof(p_input->'refund_cutoff_days') not in ('number','null'))
     or (p_input ? 'commission_basis_policy' and (jsonb_typeof(p_input->'commission_basis_policy') <> 'string' or p_input->>'commission_basis_policy' not in ('net_after_fees','subtotal_ex_tax_shipping')))
     or (p_input ? 'validation_window_hours' and jsonb_typeof(p_input -> 'validation_window_hours') <> 'number') then
    raise exception 'commission rule input types are invalid' using errcode = '22023';
  end if;
  begin
    agreement_id_value := nullif(p_input ->> 'agreement_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'agreement_id must be a UUID' using errcode = '22023';
  end;
  if agreement_id_value is null
     or char_length(trim(p_input ->> 'name')) not between 1 and 120
     or trim(p_input ->> 'trigger_event') !~ '^[a-z][a-z0-9_.-]{0,99}$'
     or (nullif(p_input ->> 'model', '') is not null and (p_input ->> 'model') not in ('cpl', 'cpa', 'revenue_share', 'hybrid'))
     or (nullif(trim(p_input ->> 'currency'), '') is not null and upper(trim(p_input ->> 'currency')) !~ '^[A-Z]{3}$') then
    raise exception 'commission rule values are invalid' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commission-rule-version:' || agreement_id_value::text || ':' || trim(p_input ->> 'name'),
      0
    )
  );
  select coalesce(max(rule.version), 0) + 1 into next_version
  from public.commission_rules as rule
  where rule.agreement_id = agreement_id_value and rule.name = trim(p_input ->> 'name');

  insert into public.commission_rules (
    agreement_id, name, version, status, model, trigger_event,
    fixed_amount_minor, rate_basis_points, currency, validation_window_hours, refund_cutoff_days, commission_basis_policy, policy_version
  )
  select
    agreement.id,
    trim(p_input ->> 'name'),
    next_version,
    'draft',
    coalesce(nullif(p_input ->> 'model', '')::public.commission_model, agreement.model),
    trim(p_input ->> 'trigger_event'),
    nullif(p_input ->> 'fixed_amount_minor', '')::bigint,
    nullif(p_input ->> 'rate_basis_points', '')::integer,
    upper(nullif(trim(p_input ->> 'currency'), '')),
    coalesce((p_input ->> 'validation_window_hours')::integer, 72),
    (p_input->>'refund_cutoff_days')::integer,coalesce(p_input->>'commission_basis_policy','net_after_fees'),2
  from public.agreements as agreement
  where agreement.id = agreement_id_value
  returning * into stored;
  if stored.id is null then raise exception 'agreement not found' using errcode = 'P0002'; end if;
  return to_jsonb(stored);
end;
$$;

alter table public.external_commission_terms
 add column agreement_id uuid references public.agreements,
 add column commission_rule_id uuid references public.commission_rules,
 add column signed_document_id uuid references public.documents,
 add column terms_sha256 text,
 add column canonical_snapshot jsonb,
 add column policy_version smallint,
 add column validation_window_hours integer,
 add column refund_cutoff_days integer,
 add column commission_basis_policy text,
 add column minimum_payout_minor bigint,
 add column payout_frequency_days integer,
 add column funding_model text check(funding_model in('merchant_direct','prefunded_platform'));
-- Old independently configured terms remain immutable history, but cannot create
-- new payable awards without a signed canonical binding.
do $$declare c record;begin
 for c in select conname from pg_constraint where conrelid='public.external_commission_terms'::regclass and contype='c' and (pg_get_constraintdef(oid) like '%calculation%' or pg_get_constraintdef(oid) like '%stripe_account_id = platform_account_id%') loop
  execute format('alter table public.external_commission_terms drop constraint %I',c.conname);
 end loop;
end $$;
alter table public.external_commission_terms
 add constraint external_canonical_calculation check(calculation in('percentage','fixed','hybrid')),
 add constraint external_canonical_amounts check((calculation='percentage' and basis_points between 1 and 10000 and fixed_minor is null) or (calculation='fixed' and fixed_minor>0 and basis_points is null) or (calculation='hybrid' and fixed_minor>0 and basis_points between 1 and 10000)),
 add constraint external_funding_model check(funding_model is null or funding_model='prefunded_platform' or stripe_account_id=platform_account_id);
alter table public.external_commission_awards add column original_commission_minor bigint,add column reversed_minor bigint not null default 0;
drop index public.external_one_reversal;

create table public.external_commission_cost_evidence(
 order_id uuid primary key references public.external_commerce_orders,
 total_minor bigint not null,tax_minor bigint not null check(tax_minor>=0),shipping_minor bigint not null check(shipping_minor>=0),
 fee_minor bigint not null check(fee_minor>=0),currency text not null,
 balance_transaction_id text not null check(balance_transaction_id~'^txn_[A-Za-z0-9]+$'),
 provider_charge_id text not null check(provider_charge_id~'^ch_[A-Za-z0-9]+$'),verified_at timestamptz not null,
 check(total_minor>=tax_minor+shipping_minor and total_minor>=tax_minor+fee_minor)
);
-- Missing fees are a mutable operational diagnostic, not financial evidence.
create table public.external_commission_fee_diagnostics(order_id uuid primary key references public.external_commerce_orders,reason text not null check(reason in('provider_fee_pending','settlement_currency_mismatch','invalid_provider_fee_evidence')),observed_at timestamptz not null);
alter table public.external_commission_fee_diagnostics enable row level security;
revoke all on public.external_commission_fee_diagnostics from public,anon,authenticated,service_role;
grant select on public.external_commission_fee_diagnostics to service_role;
create table public.external_commission_adjustments(
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.external_commerce_orders,
 provider_event_id text not null,kind text not null check(kind in('refund','dispute_open','dispute_won','dispute_lost')),
 provider_object_id text not null,amount_minor bigint not null check(amount_minor>0),occurred_at timestamptz not null,
 received_at timestamptz not null default clock_timestamp(),unique(order_id,provider_event_id,provider_object_id,kind),
 check((kind='refund' and provider_object_id~'^re_[A-Za-z0-9]+$') or (kind<>'refund' and provider_object_id~'^dp_[A-Za-z0-9]+$'))
);
create unique index external_refund_identity on public.external_commission_adjustments(order_id,provider_object_id) where kind='refund';
create trigger external_cost_history before update or delete on public.external_commission_cost_evidence for each row execute function kma_internal.external_commerce_immutable();
create trigger external_adjustment_history before update or delete on public.external_commission_adjustments for each row execute function kma_internal.external_commerce_immutable();
alter table public.external_commission_cost_evidence enable row level security;
alter table public.external_commission_adjustments enable row level security;
revoke all on public.external_commission_cost_evidence,public.external_commission_adjustments from public,anon,authenticated,service_role;
grant select on public.external_commission_cost_evidence,public.external_commission_adjustments to service_role;

create function kma_internal.external_canonical_policy(p_agreement uuid,p_rule uuid,p_at timestamptz default clock_timestamp()) returns jsonb language plpgsql stable set search_path='' as $$
declare a public.agreements;r public.commission_rules;d public.documents;s jsonb;
begin
 select * into a from public.agreements where id=p_agreement;
 select * into r from public.commission_rules where id=p_rule and agreement_id=a.id;
 if a.id is null or r.id is null or r.status<>'active' or r.model<>a.model or r.model not in('cpa','revenue_share','hybrid') or r.trigger_event<>'purchase.completed' or not public.agreement_is_launch_ready(a.id,p_at) then raise exception 'An active signed agreement and matching purchase rule are required' using errcode='55000';end if;
 s:=public.agreement_terms_snapshot(a.id);
 select * into d from public.documents where agreement_id=a.id and status in('signed','active') and signed_by_partner_at<=p_at and signed_by_kissmyapps_at<=p_at and (effective_at is null or effective_at<=p_at) and (expires_at is null or expires_at>p_at) and terminated_at is null and terms_snapshot=s and terms_sha256=encode(extensions.digest(s::text,'sha256'),'hex') order by version desc,id limit 1;
 if not found then raise exception 'The signed document does not match this commercial revision' using errcode='55000';end if;
 return jsonb_build_object('agreement',to_jsonb(a),'rule',to_jsonb(r),'signed_document_id',d.id,'terms_sha256',d.terms_sha256,'signed_snapshot',s);
end $$;

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
 if a.product_id is distinct from product or a.affiliate_id is distinct from affiliate or a.payout_currency is distinct from currency_value or platform is null or platform!~'^acct_[A-Za-z0-9]+$' or funding is null or funding not in('merchant_direct','prefunded_platform') or (funding='merchant_direct' and merchant<>platform) or not exists(select 1 from public.products where id=product and tracking_mode='commercial' and status='active') or not exists(select 1 from public.affiliates where id=affiliate and status='active') or not exists(select 1 from public.funnels where id=funnel and product_id=product and status='live') or not exists(select 1 from public.affiliate_links where affiliate_id=affiliate and product_id=product and funnel_id=funnel) or not exists(select 1 from public.external_commerce_merchants where product_id=product and funnel_id=funnel and stripe_account_id=merchant and livemode=live) then raise exception 'Canonical agreement or funding scope does not match' using errcode='22023';end if;
 select coalesce(max(version),0) into prior from public.external_commission_terms where product_id=product and funnel_id=funnel and affiliate_id=affiliate and stripe_account_id=merchant and livemode=live and currency=currency_value;
 if (p_input->>'expected_version')::integer is distinct from prior then raise exception 'Binding changed; reload before saving' using errcode='40001';end if;
 insert into public.external_settlement_platforms(platform_account_id,livemode) values(platform,live) on conflict do nothing;
 insert into public.external_commission_terms(product_id,funnel_id,affiliate_id,stripe_account_id,platform_account_id,livemode,currency,version,calculation,basis_points,fixed_minor,hold_days,attribution_window_days,effective_from,effective_until,reason,created_by,agreement_id,commission_rule_id,signed_document_id,terms_sha256,canonical_snapshot,policy_version,validation_window_hours,refund_cutoff_days,commission_basis_policy,minimum_payout_minor,payout_frequency_days,funding_model)
 values(product,funnel,affiliate,merchant,platform,live,currency_value,prior+1,case r.model when 'cpa' then 'fixed' when 'revenue_share' then 'percentage' else 'hybrid' end,r.rate_basis_points,r.fixed_amount_minor,ceil(r.validation_window_hours::numeric/24),a.attribution_window_days,(p_input->>'effective_from')::timestamptz,(p_input->>'effective_until')::timestamptz,trim(p_input->>'reason'),auth.uid(),a.id,r.id,(policy->>'signed_document_id')::uuid,policy->>'terms_sha256',policy,r.policy_version,r.validation_window_hours,r.refund_cutoff_days,r.commission_basis_policy,a.minimum_payout_minor,a.payout_frequency_days,funding) returning * into t;
 insert into public.audit_logs(actor_user_id,actor_type,action,target_table,target_id,after_data) values(auth.uid(),'admin','external_canonical_binding_created','external_commission_terms',t.id,to_jsonb(t));
 insert into public.external_settlement_requests(request_id,actor_id,input,result) values(request,auth.uid(),p_input,to_jsonb(t));return to_jsonb(t);
end $$;

create or replace function public.record_external_commission_basis(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.external_commerce_orders;b public.external_commission_bases;c public.external_commission_cost_evidence;v bigint;tax bigint;shipping bigint;fee bigint;verified timestamptz;
begin
 select * into o from public.external_commerce_orders where external_order_id=(p_input->>'external_order_id')::uuid and stripe_account_id=p_input->>'stripe_account_id' and livemode=(p_input->>'livemode')::boolean;
 if not found then raise exception 'Verified order not found' using errcode='P0002';end if;
 v:=(p_input->>'eligible_basis_minor')::bigint;verified:=(p_input->>'verified_at')::timestamptz;
 if v is null or v<0 or v>o.amount_minor or (p_input->>'total_minor')::bigint is distinct from o.amount_minor or p_input->>'currency' is distinct from o.currency or p_input->>'basis_policy' is distinct from 'post_discount_excluding_tax_shipping' or verified is null or verified>clock_timestamp()+interval '5 minutes' then raise exception 'Invalid verified commission basis' using errcode='22023';end if;
 insert into public.external_commission_bases(order_id,eligible_basis_minor,total_minor,currency,basis_policy,verified_at) values(o.id,v,o.amount_minor,o.currency,p_input->>'basis_policy',verified) on conflict do nothing;
 select * into b from public.external_commission_bases where order_id=o.id;
 if b.eligible_basis_minor<>v or b.total_minor<>o.amount_minor or b.currency<>o.currency then raise exception 'Verified basis changed' using errcode='22023';end if;
 if p_input ? 'fee_unavailable_reason' and coalesce(p_input->>'fee_unavailable_reason','') not in('provider_fee_pending','settlement_currency_mismatch','invalid_provider_fee_evidence') then raise exception 'Invalid missing fee reason' using errcode='22023';end if;
 if p_input->'fee_verified'='false'::jsonb and p_input ? 'fee_unavailable_reason' and not exists(select 1 from public.external_commission_cost_evidence where order_id=o.id) then insert into public.external_commission_fee_diagnostics values(o.id,p_input->>'fee_unavailable_reason',verified) on conflict(order_id) do update set reason=excluded.reason,observed_at=excluded.observed_at where excluded.observed_at>external_commission_fee_diagnostics.observed_at;end if;
 if p_input->'fee_verified'='true'::jsonb then
  tax:=(p_input->>'tax_minor')::bigint;shipping:=(p_input->>'shipping_minor')::bigint;fee:=(p_input->>'fee_minor')::bigint;
  if tax is null or shipping is null or fee is null or tax<0 or shipping<0 or fee<0 or o.amount_minor-tax-shipping<>v or o.amount_minor-tax-fee<0 or p_input->>'fee_currency' is distinct from o.currency or coalesce(p_input->>'balance_transaction_id','')!~'^txn_[A-Za-z0-9]+$' or coalesce(p_input->>'provider_charge_id','')!~'^ch_[A-Za-z0-9]+$' then raise exception 'Complete same-currency provider fee evidence is required' using errcode='22023';end if;
  insert into public.external_commission_cost_evidence(order_id,total_minor,tax_minor,shipping_minor,fee_minor,currency,balance_transaction_id,provider_charge_id,verified_at) values(o.id,o.amount_minor,tax,shipping,fee,o.currency,p_input->>'balance_transaction_id',p_input->>'provider_charge_id',verified) on conflict do nothing;
  select * into c from public.external_commission_cost_evidence where order_id=o.id;
  if row(c.tax_minor,c.shipping_minor,c.fee_minor,c.currency,c.balance_transaction_id,c.provider_charge_id) is distinct from row(tax,shipping,fee,o.currency,p_input->>'balance_transaction_id',p_input->>'provider_charge_id') then raise exception 'Verified fee evidence changed' using errcode='22023';end if;
 end if;
 return jsonb_build_object('order_id',o.id,'eligible_basis_minor',b.eligible_basis_minor,'net_after_fees_verified',exists(select 1 from public.external_commission_cost_evidence where order_id=o.id));
end $$;

alter table public.external_commission_terms add column agreement_version integer,add column commission_rule_version integer;
-- Derived labels are populated without editing a prior approved commercial row.
create function kma_internal.external_binding_versions() returns trigger language plpgsql set search_path='' as $$begin
 if new.agreement_id is not null then new.agreement_version:=(new.canonical_snapshot#>>'{agreement,version}')::integer;new.commission_rule_version:=(new.canonical_snapshot#>>'{rule,version}')::integer;end if;return new;end $$;
create trigger external_binding_version_labels before insert on public.external_commission_terms for each row execute function kma_internal.external_binding_versions();

create function kma_internal.refresh_external_award(p_order uuid) returns void language plpgsql set search_path='' as $$
declare o public.external_commerce_orders;a public.external_commission_awards;t public.external_commission_terms;purchase_at timestamptz;cutoff timestamptz;refunded bigint:=0;lost bigint:=0;deduction bigint;next_amount bigint;delta bigint;blocked boolean:=false;why text;desired_status text;b public.external_settlement_batches;j public.external_settlement_jobs;i public.external_settlement_items;reserved bigint;target bigint;pending_partial boolean;
begin
 select * into o from public.external_commerce_orders where id=p_order;
 select * into a from public.external_commission_awards where order_id=p_order for update;
 if a.id is null or a.terms_id is null then return;end if;
 select * into t from public.external_commission_terms where id=a.terms_id;
 if t.agreement_id is null or a.original_commission_minor is null then update public.external_commission_awards set status='held',blocker='canonical_policy_binding_required' where id=a.id;return;end if;
 select provider_occurred_at into purchase_at from public.external_commerce_events where order_id=o.id and kind='purchase';
 cutoff:=case when t.refund_cutoff_days is null then null else purchase_at+t.refund_cutoff_days*interval '24 hours' end;
 select coalesce(sum(amount_minor),0) into refunded from public.external_commission_adjustments where order_id=o.id and kind='refund' and (cutoff is null or occurred_at<=cutoff);
 -- The legacy ingress represents only a completed full refund. Deduplicate its
 -- cumulative proof against individual verified refund IDs, never add both.
 if exists(select 1 from public.external_commerce_events where order_id=o.id and kind='refund' and (cutoff is null or provider_occurred_at<=cutoff)) then refunded:=o.amount_minor;end if;
 if exists(select 1 from public.external_commission_holds where order_id=o.id and hold_type='refund_full') then
  if cutoff is null then refunded:=o.amount_minor;else blocked:=true;why:='refund_occurrence_evidence_required';end if;
 end if;
 refunded:=least(o.amount_minor,refunded);
 select exists(select 1 from public.external_commission_holds h where h.order_id=o.id and h.hold_type='refund_partial') into pending_partial;
 if refunded<o.amount_minor and (pending_partial or (t.policy_version=1 and refunded>0)) then blocked:=true;why:='partial_refund_requires_review';end if;
 if exists(select 1 from public.external_commission_holds h where h.order_id=o.id and h.hold_type='dispute') then blocked:=true;why:='dispute_requires_review';end if;
 -- A verified terminal state dominates older/later open snapshots. Conflicting
 -- terminal observations require review rather than guessed financial recovery.
 if exists(select 1 from public.external_commission_adjustments where order_id=o.id and kind in('dispute_won','dispute_lost') group by provider_object_id having count(distinct kind)>1) then blocked:=true;why:='conflicting_dispute_evidence';end if;
 if exists(select 1 from public.external_commission_adjustments x where x.order_id=o.id and x.kind='dispute_open' and not exists(select 1 from public.external_commission_adjustments z where z.order_id=x.order_id and z.provider_object_id=x.provider_object_id and z.kind in('dispute_won','dispute_lost'))) then blocked:=true;why:='dispute_open';end if;
 select coalesce(sum(amount_minor),0) into lost from (select distinct on(provider_object_id) amount_minor from public.external_commission_adjustments where order_id=o.id and kind='dispute_lost' order by provider_object_id,occurred_at desc,id desc) losses;
 if t.policy_version=1 and lost>0 then blocked:=true;why:='dispute_requires_review';lost:=0;end if;
 -- Ordinary refund cutoff never suppresses verified lost-dispute adjustments.
 deduction:=floor(a.original_commission_minor::numeric*least(o.amount_minor,refunded+lost)/o.amount_minor)::bigint;
 if t.policy_version=1 and refunded<o.amount_minor then deduction:=0;end if;
 deduction:=greatest(a.reversed_minor,deduction);next_amount:=a.original_commission_minor-deduction;delta:=deduction-a.reversed_minor;
 if delta>0 then insert into public.external_commission_ledger(award_id,affiliate_id,platform_account_id,livemode,currency,kind,amount_minor,source_key) values(a.id,o.affiliate_id,t.platform_account_id,o.livemode,o.currency,'reversed',-delta,'canonical-adjustment:'||a.id||':'||deduction) on conflict(source_key) do nothing;end if;
 desired_status:=case when next_amount=0 and a.original_commission_minor>0 then 'reversed' when blocked or a.eligible_at>clock_timestamp() or next_amount=0 then 'held' else 'eligible' end;
 why:=case when desired_status='reversed' then 'verified_refund_or_lost_dispute' when blocked then why when next_amount=0 then 'zero_eligible_basis' when desired_status='held' then 'validation_window' else null end;
 update public.external_commission_awards set commission_minor=next_amount,reversed_minor=deduction,status=desired_status,blocker=why,revision=revision+1 where id=a.id and row(commission_minor,reversed_minor,status,blocker) is distinct from row(next_amount,deduction,desired_status,why);
 for i in select x.* from public.external_settlement_items x where x.award_id=a.id loop
  select * into b from public.external_settlement_batches where id=i.batch_id for update;
  if b.status='cancelled' then continue;end if;
  if (next_amount<>i.amount_minor or blocked) and b.status not in('transferred','held') then update public.external_settlement_batches set status='held',reason=coalesce(why,'Commission adjusted after batch review'),revision=revision+1 where id=b.id;end if;
  select * into j from public.external_settlement_jobs where batch_id=b.id and kind='transfer' and state='succeeded';
  if found then
   target:=greatest(0,i.amount_minor-next_amount);
   select coalesce(sum(amount_minor),0) into reserved from public.external_settlement_jobs where batch_id=b.id and order_id=o.id and kind='reversal';
   if target>reserved then insert into public.external_settlement_jobs(batch_id,order_id,kind,platform_account_id,livemode,amount_minor,currency,destination,transfer_id,idempotency_key,transfer_group) values(b.id,o.id,'reversal',b.platform_account_id,b.livemode,target-reserved,b.currency,j.destination,j.provider_id,'canonical-reversal:'||b.id||':'||o.id||':'||target,j.transfer_group) on conflict do nothing;end if;
  end if;
 end loop;
end $$;

create function public.record_external_commission_adjustment(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.external_commerce_orders;kind_value text:=p_input->>'kind';obj text;amount bigint;occurred timestamptz;stored public.external_commission_adjustments;total bigint;purchase_at timestamptz;
begin
 perform pg_advisory_xact_lock(8154,42);
 if p_input is null or jsonb_typeof(p_input)<>'object' or exists(select 1 from jsonb_object_keys(p_input) k where k not in('order_id','provider_event_id','kind','amount_minor','occurred_at','refund_id','dispute_id')) then raise exception 'Invalid adjustment evidence' using errcode='22023';end if;
 select * into o from public.external_commerce_orders where id=(p_input->>'order_id')::uuid;
 amount:=(p_input->>'amount_minor')::bigint;occurred:=(p_input->>'occurred_at')::timestamptz;obj:=case when kind_value='refund' then p_input->>'refund_id' else p_input->>'dispute_id' end;
 select provider_occurred_at into purchase_at from public.external_commerce_events where order_id=o.id and kind='purchase';
 if o.id is null or kind_value is null or kind_value not in('refund','dispute_open','dispute_won','dispute_lost') or coalesce(p_input->>'provider_event_id','')!~'^evt_[A-Za-z0-9]+$' or amount is null or amount<=0 or amount>o.amount_minor or occurred is null or occurred>clock_timestamp()+interval '5 minutes' or (purchase_at is not null and occurred<purchase_at) or obj is null or (kind_value='refund' and obj!~'^re_[A-Za-z0-9]+$') or (kind_value<>'refund' and obj!~'^dp_[A-Za-z0-9]+$') then raise exception 'Provider adjustment does not match verified purchase' using errcode='22023';end if;
 select * into stored from public.external_commission_adjustments where order_id=o.id and ((provider_event_id=p_input->>'provider_event_id' and provider_object_id=obj and kind=kind_value) or (kind_value='refund' and kind='refund' and provider_object_id=obj)) limit 1;
 if found then
  if stored.kind<>kind_value or stored.provider_object_id<>obj or stored.amount_minor<>amount or stored.occurred_at<>occurred then raise exception 'Adjustment evidence identity changed' using errcode='22023';end if;
  return jsonb_build_object('id',stored.id,'duplicate',true);
 end if;
 if kind_value='refund' then select coalesce(sum(amount_minor),0) into total from public.external_commission_adjustments where order_id=o.id and kind='refund';if total+amount>o.amount_minor then raise exception 'Cumulative refunds exceed verified purchase' using errcode='22023';end if;end if;
 insert into public.external_commission_adjustments(order_id,provider_event_id,kind,provider_object_id,amount_minor,occurred_at) values(o.id,p_input->>'provider_event_id',kind_value,obj,amount,occurred) returning * into stored;
 perform kma_internal.refresh_external_award(o.id);
 return jsonb_build_object('id',stored.id,'duplicate',false);
end $$;

create or replace function public.process_external_commissions(p_limit integer default 100) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.external_commerce_orders;a public.external_commission_awards;t public.external_commission_terms;basis public.external_commission_bases;cost public.external_commission_cost_evidence;purchase_at timestamptz;click_at timestamptz;amount bigint;eligible_basis bigint;n integer:=0;
begin
 if p_limit not between 1 and 500 then raise exception 'Invalid processing limit' using errcode='22023';end if;
 perform pg_advisory_xact_lock(8154,42);
 if to_regprocedure('public.reconcile_creator_commercial_holds(integer)') is not null then execute 'select public.reconcile_creator_commercial_holds(500)';end if;
 for o in select x.* from public.external_commerce_orders x left join public.external_commission_awards z on z.order_id=x.id order by coalesce(z.last_checked_at,'-infinity'::timestamptz),x.created_at,x.id limit p_limit loop
  select provider_occurred_at into purchase_at from public.external_commerce_events where order_id=o.id and kind='purchase';if purchase_at is null then continue;end if;
  insert into public.external_commission_awards(order_id,blocker) values(o.id,'terms_unconfigured') on conflict do nothing;
  update public.external_commission_awards set last_checked_at=clock_timestamp() where order_id=o.id returning * into a;
  if a.terms_id is null then
   if not kma_internal.external_order_payable(o.id) then update public.external_commission_awards set status='held',blocker='commercial_scope_ineligible' where id=a.id;continue;end if;
   select * into t from public.external_commission_terms where status='approved' and agreement_id is not null and product_id=o.product_id and funnel_id=o.funnel_id and affiliate_id=o.affiliate_id and stripe_account_id=o.stripe_account_id and livemode=o.livemode and currency=o.currency and purchase_at>=effective_from and (effective_until is null or purchase_at<effective_until) and approved_at<=purchase_at
   and exists(select 1 from public.agreements ca join public.documents cd on cd.id=external_commission_terms.signed_document_id and cd.agreement_id=ca.id where ca.id=external_commission_terms.agreement_id and ca.starts_at<=purchase_at and (ca.ends_at is null or purchase_at<ca.ends_at) and cd.signed_by_partner_at<=purchase_at and cd.signed_by_kissmyapps_at<=purchase_at and (cd.effective_at is null or cd.effective_at<=purchase_at) and (cd.expires_at is null or purchase_at<cd.expires_at) and (cd.terminated_at is null or purchase_at<cd.terminated_at) and cd.terms_sha256=external_commission_terms.terms_sha256 and cd.terms_snapshot=external_commission_terms.canonical_snapshot->'signed_snapshot')
   and purchase_at>=(canonical_snapshot#>>'{agreement,starts_at}')::timestamptz and ((canonical_snapshot#>>'{agreement,ends_at}') is null or purchase_at<(canonical_snapshot#>>'{agreement,ends_at}')::timestamptz) and not exists(select 1 from public.external_commission_term_endings ending where ending.terms_id=external_commission_terms.id and purchase_at>=ending.effective_until) order by version desc limit 1;
   if not found then continue;end if;
   select * into basis from public.external_commission_bases where order_id=o.id;
   if not found then update public.external_commission_awards set status='held',blocker='verified_basis_missing' where id=a.id;continue;end if;
   eligible_basis:=basis.eligible_basis_minor;
   if t.commission_basis_policy='net_after_fees' then
    select * into cost from public.external_commission_cost_evidence where order_id=o.id;
    if not found then update public.external_commission_awards set status='held',blocker=coalesce((select reason from public.external_commission_fee_diagnostics where order_id=o.id),'verified_fee_evidence_missing') where id=a.id;continue;end if;
    eligible_basis:=cost.total_minor-cost.fee_minor-cost.tax_minor;
   end if;
   select created_at into click_at from public.acquisitions where id=o.acquisition_id;
   if purchase_at<click_at or purchase_at>click_at+make_interval(days=>t.attribution_window_days) then update public.external_commission_awards set status='held',blocker='outside_attribution_window' where id=a.id;continue;end if;
   amount:=public.commercial_commission_amount((t.canonical_snapshot#>>'{rule,model}')::public.commission_model,t.fixed_minor,t.basis_points,eligible_basis);
   update public.external_commission_awards set terms_id=t.id,terms_snapshot=to_jsonb(t),basis_minor=eligible_basis,commission_minor=amount,original_commission_minor=amount,eligible_at=purchase_at+make_interval(hours=>t.validation_window_hours),status='held',blocker='validation_window',revision=revision+1 where id=a.id returning * into a;
   if amount>0 then insert into public.external_commission_ledger(award_id,affiliate_id,platform_account_id,livemode,currency,kind,amount_minor,source_key) values(a.id,o.affiliate_id,t.platform_account_id,o.livemode,o.currency,'earned',amount,'earned:'||a.id) on conflict do nothing;end if;
  end if;
  perform kma_internal.refresh_external_award(o.id);n:=n+1;
 end loop;
 return jsonb_build_object('processed',n);
end $$;

create or replace function kma_internal.external_debt(p_affiliate uuid,p_platform text,p_live boolean,p_currency text) returns bigint language sql stable set search_path='' as $$
 select greatest(
 (select greatest(0,-coalesce(sum(amount_minor),0))::bigint from public.external_commission_ledger where affiliate_id=p_affiliate and platform_account_id=p_platform and livemode=p_live and currency=p_currency),
 (select coalesce(sum(greatest(0,i.amount_minor-a.commission_minor-coalesce((select sum(r.amount_minor) from public.external_settlement_jobs r where r.batch_id=b.id and r.order_id=a.order_id and r.kind='reversal' and r.state='succeeded'),0))),0)::bigint from public.external_settlement_items i join public.external_commission_awards a on a.id=i.award_id join public.external_settlement_batches b on b.id=i.batch_id join public.external_settlement_jobs j on j.batch_id=b.id and j.kind='transfer' where b.affiliate_id=p_affiliate and b.platform_account_id=p_platform and b.livemode=p_live and b.currency=p_currency and j.first_attempt_at is not null));
$$;
create or replace function kma_internal.external_scope_review_frozen(p_affiliate uuid,p_platform text,p_live boolean,p_currency text) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.external_commission_awards a join public.external_commission_terms t on t.id=a.terms_id join public.external_settlement_items i on i.award_id=a.id join public.external_settlement_jobs j on j.batch_id=i.batch_id and j.kind='transfer' and j.first_attempt_at is not null where t.affiliate_id=p_affiliate and t.platform_account_id=p_platform and t.livemode=p_live and t.currency=p_currency and a.status='held' and a.blocker in('partial_refund_requires_review','refund_occurrence_evidence_required','dispute_requires_review','dispute_open','conflicting_dispute_evidence','canonical_policy_binding_required')) or exists(select 1 from public.external_settlement_jobs j join public.external_settlement_batches b on b.id=j.batch_id where b.affiliate_id=p_affiliate and b.platform_account_id=p_platform and b.livemode=p_live and b.currency=p_currency and j.last_error='Provider reversal does not match recorded recoveries; financial review required');
$$;
create or replace function kma_internal.external_reverse_award(p_award uuid,p_reason text) returns void language plpgsql set search_path='' as $$declare order_id uuid;begin select a.order_id into order_id from public.external_commission_awards a where id=p_award;perform kma_internal.refresh_external_award(order_id);end $$;

create function kma_internal.external_payout_boundary(p_term uuid) returns timestamptz language sql stable set search_path='' as $$
 select (t.canonical_snapshot#>>'{agreement,starts_at}')::timestamptz+floor(extract(epoch from(clock_timestamp()-(t.canonical_snapshot#>>'{agreement,starts_at}')::timestamptz))/(t.payout_frequency_days*86400))*interval '1 second'*(t.payout_frequency_days*86400) from public.external_commission_terms t where t.id=p_term and t.agreement_id is not null;
$$;
create function kma_internal.external_award_cadence_ready(p_award uuid,p_batch uuid default null) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.external_commission_awards a join public.external_commission_terms t on t.id=a.terms_id join public.external_commerce_events e on e.order_id=a.order_id and e.kind='purchase' where a.id=p_award and t.agreement_id is not null and kma_internal.external_payout_boundary(t.id)>=(t.canonical_snapshot#>>'{agreement,starts_at}')::timestamptz+t.payout_frequency_days*interval '24 hours' and e.provider_occurred_at<kma_internal.external_payout_boundary(t.id) and not exists(select 1 from public.external_settlement_items i join public.external_settlement_batches b on b.id=i.batch_id join public.external_commission_awards w on w.id=i.award_id join public.external_commission_terms previous on previous.id=w.terms_id where previous.agreement_id=t.agreement_id and b.platform_account_id=t.platform_account_id and b.livemode=t.livemode and b.status<>'cancelled' and b.id is distinct from p_batch and b.created_at>=kma_internal.external_payout_boundary(t.id)));
$$;
create or replace function kma_internal.external_batch_valid(p_batch uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.external_settlement_batches b join public.external_creator_accounts a on a.affiliate_id=b.affiliate_id and a.platform_account_id=b.platform_account_id and a.livemode=b.livemode join public.external_settlement_platforms p on p.platform_account_id=b.platform_account_id and p.livemode=b.livemode where b.id=p_batch and p.enabled and a.status='ready' and a.verified_at>clock_timestamp()-interval '24 hours' and (b.destination is null or b.destination=a.connect_account_id) and not kma_internal.external_scope_review_frozen(b.affiliate_id,b.platform_account_id,b.livemode,b.currency) and kma_internal.external_debt(b.affiliate_id,b.platform_account_id,b.livemode,b.currency)=0
 and b.amount_minor=(select sum(i.amount_minor) from public.external_settlement_items i where i.batch_id=b.id)
 and not exists(select 1 from public.external_settlement_items i join public.external_commission_awards w on w.id=i.award_id join public.external_commission_terms term on term.id=w.terms_id where i.batch_id=b.id group by term.agreement_id having sum(i.amount_minor)<max(term.minimum_payout_minor))
 and not exists(select 1 from public.external_settlement_items i join public.external_commission_awards w on w.id=i.award_id join public.external_commission_terms t on t.id=w.terms_id where i.batch_id=b.id and (w.status<>'eligible' or not kma_internal.external_order_payable(w.order_id) or w.commission_minor<>i.amount_minor or t.agreement_id is null or t.platform_account_id<>b.platform_account_id )));
$$;
create function kma_internal.external_commission_fact_refresh() returns trigger language plpgsql set search_path='' as $$begin if new.kind='refund' then perform pg_advisory_xact_lock(8154,42);perform kma_internal.refresh_external_award(new.order_id);end if;return new;end $$;
create trigger external_commission_verified_refund after insert on public.external_commerce_events for each row execute function kma_internal.external_commission_fact_refresh();

create or replace function public.perform_admin_external_settlement_action(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare action_value text:=p_input->>'action';actor uuid;request uuid:=(p_input->>'request_id')::uuid;prior public.external_settlement_requests;t public.external_commission_terms;b public.external_settlement_batches;a public.external_creator_accounts;result jsonb;ids uuid[];amount bigint;target uuid:=(p_input->>'id')::uuid;reason_value text:=trim(p_input->>'reason');
begin
 perform public.assert_admin_password(array['owner','finance'],'operate external settlement');actor:=auth.uid();perform pg_advisory_xact_lock(8154,42);
 if jsonb_typeof(p_input) is distinct from 'object' or action_value is null or exists(select 1 from jsonb_object_keys(p_input) k where k not in('request_id','action','id','expected_revision','reason','product_id','funnel_id','affiliate_id','platform_account_id','livemode','currency','enabled')) or request is null or length(coalesce(reason_value,'')) not between 5 and 500 or action_value not in('approve_terms','prepare_batch','review_batch','approve_batch','hold_batch','cancel_batch','reconcile_batch','set_platform_enabled') then raise exception 'Invalid settlement action' using errcode='22023';end if;
 select * into prior from public.external_settlement_requests where request_id=request;
 if found then if prior.actor_id<>actor or prior.input<>p_input then raise exception 'Request identity changed' using errcode='22023';end if;return prior.result;end if;
 if action_value='approve_terms' then
  select * into t from public.external_commission_terms where id=target for update;
  if not found then raise exception 'Terms not found' using errcode='P0002';end if;
  if t.agreement_id is null or t.canonical_snapshot is distinct from kma_internal.external_canonical_policy(t.agreement_id,t.commission_rule_id) then raise exception 'Canonical signed policy changed; recreate the binding' using errcode='40001';end if;
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
  select array_agg(w.id order by w.id),sum(w.commission_minor) into ids,amount from public.external_commission_awards w join public.external_commerce_orders o on o.id=w.order_id join public.external_commission_terms term on term.id=w.terms_id where w.status='eligible' and kma_internal.external_order_payable(o.id) and o.product_id=(p_input->>'product_id')::uuid and o.funnel_id=(p_input->>'funnel_id')::uuid and o.affiliate_id=(p_input->>'affiliate_id')::uuid and term.platform_account_id=p_input->>'platform_account_id' and kma_internal.external_award_cadence_ready(w.id) and o.livemode=(p_input->>'livemode')::boolean and o.currency=p_input->>'currency' and not exists(select 1 from public.external_settlement_items i join public.external_settlement_batches b0 on b0.id=i.batch_id where i.award_id=w.id and b0.status<>'cancelled');
  if amount is null or amount<=0 or cardinality(ids)>500 then raise exception 'No mature positive earnings are available for this agreed payout period' using errcode='55000';end if;
  if exists(select 1 from public.external_commission_awards w join public.external_commission_terms tm on tm.id=w.terms_id where w.id=any(ids) group by tm.agreement_id having sum(w.commission_minor)<max(tm.minimum_payout_minor)) then raise exception 'Earnings are below the signed agreement minimum payout' using errcode='55000';end if;
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

create or replace function public.claim_creator_transfer_jobs(p_platform_account_id text,p_livemode boolean,p_limit integer default 10,p_lease_seconds integer default 120) returns setof jsonb language plpgsql security definer set search_path='' as $$
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
  update public.external_settlement_jobs set state='leased',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempt_count=attempt_count+1 where id=j.id returning * into j;
  return next to_jsonb(j);
 end loop;
end $$;


create function public.begin_creator_transfer_attempt(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.external_settlement_jobs;b public.external_settlement_batches;
begin
 perform pg_advisory_xact_lock(8154,42);
 if jsonb_typeof(p_input) is distinct from 'object' or not(p_input ?& array['id','lease_token']) or exists(select 1 from jsonb_object_keys(p_input) k where k not in('id','lease_token')) then raise exception 'Invalid provider attempt identity' using errcode='22023';end if;
 select * into j from public.external_settlement_jobs where id=(p_input->>'id')::uuid for update;
 if not found or j.state<>'leased' or j.lease_token is distinct from (p_input->>'lease_token')::uuid or j.lease_expires_at<=clock_timestamp() then raise exception 'Provider lease changed' using errcode='40001';end if;
 select * into b from public.external_settlement_batches where id=j.batch_id for update;
 if not exists(select 1 from public.external_settlement_platforms where platform_account_id=j.platform_account_id and livemode=j.livemode and enabled) or (j.kind='transfer' and (b.status not in('approved','processing') or not kma_internal.external_batch_valid(b.id))) then raise exception 'Settlement eligibility changed before provider mutation' using errcode='55000';end if;
 if j.first_attempt_at<clock_timestamp()-interval '23 hours' then raise exception 'Provider idempotency window requires read-only reconciliation' using errcode='55000';end if;
 update public.external_settlement_jobs set first_attempt_at=coalesce(first_attempt_at,clock_timestamp()) where id=j.id returning * into j;
 if j.kind='transfer' and b.status='approved' then update public.external_settlement_batches set status='processing',revision=revision+1 where id=b.id;end if;
 return to_jsonb(j);
end $$;
revoke all on function public.begin_creator_transfer_attempt(jsonb) from public,anon,authenticated;
grant execute on function public.begin_creator_transfer_attempt(jsonb) to service_role;

create or replace function public.finish_creator_transfer_job(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
 update public.external_settlement_jobs set state=case state_value when 'retry' then 'pending' else state_value end,provider_id=case when state_value='succeeded' then provider else null end,first_attempt_at=case when state_value='succeeded' then coalesce(first_attempt_at,clock_timestamp()) else first_attempt_at end,last_error=case when state_value='succeeded' then null else left(coalesce(p_input->>'safe_error','Provider reconciliation required'),200) end,lease_expires_at=null,next_attempt_at=case when state_value='retry' then clock_timestamp()+make_interval(secs=>least(3600,60*power(2,least(greatest(j.attempt_count-1,0),6)))::integer) else next_attempt_at end where id=j.id returning * into j;
 if state_value='succeeded' then
  insert into public.external_commission_ledger(batch_id,affiliate_id,platform_account_id,livemode,currency,kind,amount_minor,source_key) values(b.id,b.affiliate_id,b.platform_account_id,b.livemode,b.currency,case j.kind when 'transfer' then 'transfer' else 'transfer_reversal' end,case j.kind when 'transfer' then -j.amount_minor else j.amount_minor end,'provider:'||j.id) on conflict(source_key) do nothing;
  if j.kind='transfer' then
   update public.external_settlement_batches set status='transferred',transferred_at=clock_timestamp(),revision=revision+1 where id=b.id;
   for a in select w.* from public.external_commission_awards w join public.external_settlement_items i on i.award_id=w.id where i.batch_id=b.id loop perform kma_internal.refresh_external_award(a.order_id);end loop;
  end if;
 end if;
 return jsonb_build_object('id',j.id,'state',j.state,'provider_id',j.provider_id,'duplicate',false);
end $$;

create or replace function public.hold_external_commission_order(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
 if a is not null then perform kma_internal.refresh_external_award(order_id_value);end if;
 return jsonb_build_object('order_id',order_id_value,'held',true);
end $$;

create or replace function kma_internal.external_settlement_workspace(p_input jsonb,p_admin boolean) returns jsonb language plpgsql stable set search_path='' as $$
declare affiliate uuid;product uuid:=(p_input->>'product_id')::uuid;funnel uuid:=(p_input->>'funnel_id')::uuid;live boolean:=(p_input->>'livemode')::boolean;result jsonb;bank jsonb;
begin
 if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input) k where k not in('product_id','funnel_id','affiliate_id','livemode')) then raise exception 'Invalid settlement filter' using errcode='22023';end if;
 if p_admin then if not public.current_user_is_admin(array['owner','finance','operations','analyst']) then raise exception 'Admin role required' using errcode='42501';end if;affiliate:=(p_input->>'affiliate_id')::uuid;
 else affiliate:=public.current_partner_affiliate_id(false);if p_input?'affiliate_id' and (p_input->>'affiliate_id')::uuid is distinct from affiliate then raise exception 'Foreign creator scope' using errcode='42501';end if;end if;
 with scopes as (select distinct m.product_id,p.name product_name,m.funnel_id,f.name funnel_name,l.affiliate_id,a.public_name affiliate_name,m.stripe_account_id,coalesce(t.platform_account_id,m.stripe_account_id) platform_account_id,m.livemode,coalesce(t.currency,(select payout_currency from public.agreements ag where ag.affiliate_id=l.affiliate_id and ag.product_id=m.product_id and ag.status='active' limit 1)) currency from public.external_commerce_merchants m join public.products p on p.id=m.product_id join public.funnels f on f.id=m.funnel_id join public.affiliate_links l on l.product_id=m.product_id and l.funnel_id=m.funnel_id join public.affiliates a on a.id=l.affiliate_id left join public.external_commission_terms t on t.product_id=m.product_id and t.funnel_id=m.funnel_id and t.affiliate_id=l.affiliate_id and t.stripe_account_id=m.stripe_account_id and t.livemode=m.livemode where (affiliate is null or l.affiliate_id=affiliate) and (product is null or m.product_id=product) and (funnel is null or m.funnel_id=funnel) and (live is null or m.livemode=live) limit 100),
 terms as(select t.* from public.external_commission_terms t where (p_admin or t.status='approved') and (affiliate is null or t.affiliate_id=affiliate) and (product is null or t.product_id=product) and (funnel is null or t.funnel_id=funnel) and (live is null or t.livemode=live) order by t.created_at desc limit 100),
 commissions as(select w.id,w.order_id,o.product_id,o.funnel_id,o.affiliate_id,o.livemode,o.currency,w.commission_minor,w.original_commission_minor,w.reversed_minor,w.basis_minor,w.status,w.blocker,w.eligible_at,w.terms_id,w.revision,kma_internal.external_payout_boundary(w.terms_id) payout_period_end,case when w.status='eligible' and not kma_internal.external_award_cadence_ready(w.id) then kma_internal.external_payout_boundary(w.terms_id)+(w.terms_snapshot->>'payout_frequency_days')::integer*interval '24 hours' else null end payout_next_at,case when w.status='eligible' and not kma_internal.external_award_cadence_ready(w.id) then 'next_agreed_payout_period' else null end payout_blocker from public.external_commission_awards w join public.external_commerce_orders o on o.id=w.order_id where (affiliate is null or o.affiliate_id=affiliate) and (product is null or o.product_id=product) and (funnel is null or o.funnel_id=funnel) and (live is null or o.livemode=live) order by w.created_at desc limit 100),
 batches as(select b.id,b.revision,b.status,b.product_id,b.funnel_id,b.affiliate_id,b.platform_account_id,b.livemode,b.currency,b.amount_minor,b.created_at,b.reviewed_at,b.approved_at,b.transferred_at,case when p_admin then b.reason else null end reason,(select coalesce(jsonb_agg(jsonb_build_object('award_id',w.id,'order_id',w.order_id,'amount_minor',i.amount_minor,'status',w.status,'eligible_at',w.eligible_at) order by w.id),'[]') from public.external_settlement_items i join public.external_commission_awards w on w.id=i.award_id where i.batch_id=b.id) items,(select coalesce(jsonb_agg(jsonb_build_object('kind',j.kind,'state',j.state,'last_error',case when p_admin then j.last_error else null end,'attempts',j.attempt_count,'first_attempt_at',j.first_attempt_at,'next_attempt_at',j.next_attempt_at) order by j.created_at),'[]') from public.external_settlement_jobs j where j.batch_id=b.id) provider_jobs from public.external_settlement_batches b where (affiliate is null or b.affiliate_id=affiliate) and (product is null or b.product_id=product) and (funnel is null or b.funnel_id=funnel) and (live is null or b.livemode=live) order by b.created_at desc limit 100),
 accounts as(select a.affiliate_id,a.platform_account_id,a.livemode,a.status,a.details_submitted,a.transfers_enabled,a.payouts_enabled,a.requirements_due,a.revision,a.verified_at from public.external_creator_accounts a where exists(select 1 from scopes s where s.affiliate_id=a.affiliate_id and s.platform_account_id=a.platform_account_id and s.livemode=a.livemode) limit 100),
 balances as(select l.affiliate_id,l.platform_account_id,l.livemode,l.currency,coalesce(sum(l.amount_minor) filter(where l.kind='earned'),0) earned_minor,-coalesce(sum(l.amount_minor) filter(where l.kind='reversed'),0) reversed_minor,-coalesce(sum(l.amount_minor) filter(where l.kind='transfer'),0) transferred_minor,coalesce(sum(l.amount_minor) filter(where l.kind='transfer_reversal'),0) recovered_minor,sum(l.amount_minor) balance_minor,kma_internal.external_debt(l.affiliate_id,l.platform_account_id,l.livemode,l.currency) debt_minor,kma_internal.external_scope_review_frozen(l.affiliate_id,l.platform_account_id,l.livemode,l.currency) review_required from public.external_commission_ledger l where exists(select 1 from scopes s where s.affiliate_id=l.affiliate_id and s.platform_account_id=l.platform_account_id and s.livemode=l.livemode) group by l.affiliate_id,l.platform_account_id,l.livemode,l.currency limit 100)
 select jsonb_build_object('scopes',coalesce((select jsonb_agg(to_jsonb(s)) from scopes s),'[]'),'platforms',coalesce((select jsonb_agg(to_jsonb(p)) from public.external_settlement_platforms p where exists(select 1 from scopes s where s.platform_account_id=p.platform_account_id and s.livemode=p.livemode)),'[]'),'terms',coalesce((select jsonb_agg(to_jsonb(t)-case when p_admin then array[]::text[] else array['created_by','approved_by','reason'] end) from terms t),'[]'),'commissions',coalesce((select jsonb_agg(to_jsonb(c)) from commissions c),'[]'),'batches',coalesce((select jsonb_agg(to_jsonb(b)) from batches b),'[]'),'accounts',coalesce((select jsonb_agg(to_jsonb(a)) from accounts a),'[]'),'balances',coalesce((select jsonb_agg(to_jsonb(b)) from balances b),'[]'),'balance_scope','funding_account','bank_payouts','[]'::jsonb,'truncated',(select count(*)>=100 from scopes) or (select count(*)>=100 from terms) or (select count(*)>=100 from commissions) or (select count(*)>=100 from batches)) into result;
 if to_regprocedure('kma_internal.external_bank_payout_rows(uuid,text,boolean)') is not null then
  execute 'select kma_internal.external_bank_payout_rows($1,$2,$3)' into bank using affiliate,null::text,live;
  result:=jsonb_set(result,'{bank_payouts}',coalesce(bank,'[]'::jsonb));
 end if;
 if p_admin then
  result:=result||jsonb_build_object('agreements',coalesce((select jsonb_agg(to_jsonb(q)) from (select a.id,a.version,a.product_id,a.affiliate_id,a.status,a.model,a.payout_currency,a.attribution_window_days,a.renewal_duration_days,a.payout_frequency_days,a.minimum_payout_minor,a.starts_at,a.ends_at,d.id signed_document_id,d.terms_sha256,public.agreement_is_launch_ready(a.id,clock_timestamp()) and d.id is not null eligible,(select coalesce(jsonb_agg(to_jsonb(r) order by r.version,r.id),'[]') from public.commission_rules r where r.agreement_id=a.id) rules from public.agreements a left join lateral(select z.* from public.documents z where z.agreement_id=a.id and z.status in('signed','active') and z.signed_by_partner_at is not null and z.signed_by_kissmyapps_at is not null and z.terminated_at is null and z.terms_snapshot=public.agreement_terms_snapshot(a.id) and z.terms_sha256=encode(extensions.digest(z.terms_snapshot::text,'sha256'),'hex') order by z.version desc,z.id limit 1) d on true where (affiliate is null or a.affiliate_id=affiliate) and (product is null or a.product_id=product) order by a.created_at desc,a.id limit 100) q),'[]'));
 else result:=result||jsonb_build_object('agreements','[]'::jsonb);end if;
 return result;
end $$;

create or replace function public.get_partner_agreement_signature_queue()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'document_id', document.id,
        'name', document.name,
        'version', document.version,
        'agreement_id', agreement.id,
        'product_id', agreement.product_id,
        'product_name', product.name,
        'model', agreement.model,
        'attribution_window_days', agreement.attribution_window_days,
        'payout_frequency_days', agreement.payout_frequency_days,
        'payout_currency', agreement.payout_currency,
        'minimum_payout_minor', agreement.minimum_payout_minor,
        'file_path', document.file_path,
        'rules',coalesce(document.terms_snapshot->'rules','[]'), 'terms_sha256',document.terms_sha256,
        'requested_at', document.created_at
      ) order by document.created_at, document.id
    ),
    '[]'::jsonb
  )
  from public.documents as document
  join public.agreements as agreement on agreement.id = document.agreement_id
  join public.products as product on product.id = agreement.product_id
  where document.affiliate_id = public.current_partner_affiliate_id(true)
    and public.current_user_has_affiliate_role(document.affiliate_id, array['owner']::text[], true)
    and document.status = 'awaiting_partner_signature'
    and agreement.status not in ('superseded', 'expired', 'terminated')
$$;

create or replace view public.partner_agreement_directory
with (security_barrier = true)
as
select
  agreement.product_id,
  product.name as product_name,
  agreement.version,
  agreement.model,
  agreement.status,
  agreement.attribution_window_days,
  agreement.renewal_duration_days,
  agreement.payout_frequency_days,
  agreement.payout_currency,
  agreement.minimum_payout_minor,
  agreement.starts_at,
  agreement.ends_at,
  coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'name', rule.name,
        'version', rule.version,
        'status', rule.status,
        'model', rule.model,
        'trigger_event', rule.trigger_event,
        'fixed_amount_minor', rule.fixed_amount_minor,
        'rate_basis_points', rule.rate_basis_points,
        'currency', rule.currency,
        'validation_window_hours', rule.validation_window_hours,
        'policy_version',rule.policy_version,'refund_cutoff_days',rule.refund_cutoff_days,'commission_basis_policy',rule.commission_basis_policy,'external_refund_calculation',case when rule.policy_version=2 then 'proportional_commission' else null end
      ) order by rule.name, rule.version
    )
    from public.commission_rules as rule
    where rule.agreement_id = agreement.id
  ), '[]'::jsonb) as rules
from public.agreements as agreement
join public.products as product on product.id = agreement.product_id
where public.current_user_has_affiliate(agreement.affiliate_id);

revoke all on function public.record_external_commission_adjustment(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_external_commission_adjustment(jsonb) to service_role;
revoke all on function kma_internal.external_canonical_policy(uuid,uuid,timestamptz),kma_internal.external_binding_versions(),kma_internal.refresh_external_award(uuid),kma_internal.external_payout_boundary(uuid),kma_internal.external_award_cadence_ready(uuid,uuid),kma_internal.external_commission_fact_refresh() from public,anon,authenticated,service_role;
commit;
