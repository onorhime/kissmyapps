-- Optional eligibility belongs to new signed versions of the existing commission rule.
-- Existing signed policies, attribution, refund cutoff, payout cadence and approval stay unchanged.
begin;
alter table public.commission_rules drop constraint commission_rules_policy_version_check;
alter table public.commission_rules drop constraint commission_policy_v1_compatibility;
alter table public.commission_rules add constraint commission_rules_policy_version_check check(policy_version in(1,2,3)),
 add constraint commission_policy_v1_compatibility check(policy_version>=2 or (refund_cutoff_days is null and commission_basis_policy='net_after_fees')),
 add column first_purchase_only boolean not null default false,
 add column fulfilment_required boolean not null default false,
 add constraint commission_eligibility_signed check(policy_version=3 or (not first_purchase_only and not fulfilment_required));
alter table public.external_commission_terms add column first_purchase_only boolean not null default false,add column fulfilment_required boolean not null default false;
create table public.external_order_eligibility_identity(
 order_id uuid primary key references public.external_commerce_orders,
 product_id uuid not null references public.products,livemode boolean not null,
 subject_id text not null check(subject_id~'^[A-Za-z0-9_-]{16,128}$'),
 purchase_sequence integer not null check(purchase_sequence between 1 and 1000000),
 context_id text not null check(context_id~'^[A-Za-z0-9_-]{1,128}$'),
 dimensions jsonb not null default '{}',
 unique(product_id,livemode,subject_id,purchase_sequence)
);
create table public.external_order_eligibility_events(
 id uuid primary key default gen_random_uuid(),product_id uuid not null references public.products,funnel_id uuid not null references public.funnels,
 external_event_id uuid not null,order_id uuid not null references public.external_order_eligibility_identity,
 status text not null check(status in('pending','fulfilled','cancelled')),occurred_at timestamptz not null,evidence jsonb not null,
 received_at timestamptz not null default clock_timestamp(),unique(product_id,funnel_id,external_event_id)
);
create index external_eligibility_order_state on public.external_order_eligibility_events(order_id,status,occurred_at);
alter table public.external_order_eligibility_identity enable row level security;
alter table public.external_order_eligibility_events enable row level security;
revoke all on public.external_order_eligibility_identity,public.external_order_eligibility_events from public,anon,authenticated,service_role;
grant select on public.external_order_eligibility_identity,public.external_order_eligibility_events to service_role;
create trigger external_order_identity_immutable before update or delete on public.external_order_eligibility_identity for each row execute function kma_internal.external_commerce_immutable();
create trigger external_order_eligibility_immutable before update or delete on public.external_order_eligibility_events for each row execute function kma_internal.external_commerce_immutable();
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
    ) || case when r.policy_version>=2 then jsonb_build_object('policy_version',r.policy_version,'refund_cutoff_days',r.refund_cutoff_days,'commission_basis_policy',r.commission_basis_policy,'external_refund_calculation','proportional_commission') else '{}'::jsonb end || case when r.policy_version=3 then jsonb_build_object('first_purchase_only',r.first_purchase_only,'fulfilment_required',r.fulfilment_required,'validation_hold_origin',case when r.fulfilment_required then 'verified_fulfilment' else 'purchase' end) else '{}'::jsonb end order by r.id) from public.commission_rules r
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
    'rate_basis_points', 'currency', 'validation_window_hours', 'refund_cutoff_days', 'commission_basis_policy', 'first_purchase_only', 'fulfilment_required'
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
  if (p_input ? 'first_purchase_only' and jsonb_typeof(p_input->'first_purchase_only')<>'boolean') or (p_input ? 'fulfilment_required' and jsonb_typeof(p_input->'fulfilment_required')<>'boolean') then raise exception 'Eligibility options must be boolean' using errcode='22023';end if;
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
    fixed_amount_minor, rate_basis_points, currency, validation_window_hours, refund_cutoff_days, commission_basis_policy, policy_version, first_purchase_only, fulfilment_required
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
    (p_input->>'refund_cutoff_days')::integer,coalesce(p_input->>'commission_basis_policy','net_after_fees'),case when coalesce((p_input->>'first_purchase_only')::boolean,false) or coalesce((p_input->>'fulfilment_required')::boolean,false) then 3 else 2 end,coalesce((p_input->>'first_purchase_only')::boolean,false),coalesce((p_input->>'fulfilment_required')::boolean,false)
  from public.agreements as agreement
  where agreement.id = agreement_id_value
  returning * into stored;
  if stored.id is null then raise exception 'agreement not found' using errcode = 'P0002'; end if;
  return to_jsonb(stored);
end;
$$;
create or replace function kma_internal.external_binding_versions() returns trigger language plpgsql set search_path='' as $$begin
 if new.agreement_id is not null then new.agreement_version:=(new.canonical_snapshot#>>'{agreement,version}')::integer;new.commission_rule_version:=(new.canonical_snapshot#>>'{rule,version}')::integer;end if;new.first_purchase_only:=coalesce((new.canonical_snapshot#>>'{rule,first_purchase_only}')::boolean,false);new.fulfilment_required:=coalesce((new.canonical_snapshot#>>'{rule,fulfilment_required}')::boolean,false);return new;end $$;

create function kma_internal.external_eligibility_blocker(p_order uuid,p_terms uuid) returns text language plpgsql stable set search_path='' as $$
declare t public.external_commission_terms;i public.external_order_eligibility_identity;
begin
 select * into t from public.external_commission_terms where id=p_terms;
 if not(coalesce(t.first_purchase_only,false) or coalesce(t.fulfilment_required,false)) then return null;end if;
 select * into i from public.external_order_eligibility_identity where order_id=p_order;
 if not found then return 'verified_order_identity_required';end if;
 if t.first_purchase_only and i.purchase_sequence<>1 then return 'first_purchase_only';end if;
 if t.fulfilment_required then
  if exists(select 1 from public.external_order_eligibility_events where order_id=p_order and status='cancelled') then return 'fulfilment_cancelled';end if;
  if not exists(select 1 from public.external_order_eligibility_events where order_id=p_order and status='fulfilled') then return 'awaiting_verified_fulfilment';end if;
 end if;
 return null;
end $$;
create function kma_internal.external_eligibility_at(p_order uuid,p_terms uuid) returns timestamptz language sql stable set search_path='' as $$
 select (case when t.fulfilment_required then (select min(occurred_at) from public.external_order_eligibility_events where order_id=p_order and status='fulfilled') else (select provider_occurred_at from public.external_commerce_events where order_id=p_order and kind='purchase') end)+make_interval(hours=>t.validation_window_hours) from public.external_commission_terms t where id=p_terms;
$$;
create or replace function kma_internal.refresh_external_award(p_order uuid) returns void language plpgsql set search_path='' as $$
declare o public.external_commerce_orders;a public.external_commission_awards;t public.external_commission_terms;purchase_at timestamptz;cutoff timestamptz;refunded bigint:=0;lost bigint:=0;deduction bigint;next_amount bigint;delta bigint;blocked boolean:=false;why text;desired_status text;b public.external_settlement_batches;j public.external_settlement_jobs;i public.external_settlement_items;reserved bigint;target bigint;pending_partial boolean;eligibility_problem text;
begin
 select * into o from public.external_commerce_orders where id=p_order;
 select * into a from public.external_commission_awards where order_id=p_order for update;
 if a.id is null or a.terms_id is null then return;end if;
 select * into t from public.external_commission_terms where id=a.terms_id;
 if t.agreement_id is null or a.original_commission_minor is null then update public.external_commission_awards set status='held',blocker='canonical_policy_binding_required' where id=a.id;return;end if;
 eligibility_problem:=kma_internal.external_eligibility_blocker(o.id,t.id);
 if eligibility_problem is not null then blocked:=true;why:=eligibility_problem;end if;
 update public.external_commission_awards set eligible_at=coalesce(kma_internal.external_eligibility_at(o.id,t.id),a.eligible_at) where id=a.id returning * into a;
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
create or replace function kma_internal.external_order_payable(p_order uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.external_commerce_orders o join public.clicks c on c.id=o.click_record_id join public.acquisitions a on a.id=o.acquisition_id join public.products p on p.id=o.product_id join public.funnels f on f.id=o.funnel_id join public.affiliates partner on partner.id=o.affiliate_id where o.id=p_order and c.commercial_eligible and a.commercial_eligible and p.tracking_mode='commercial' and p.status='active' and f.status='live' and partner.status='active' and not exists(select 1 from public.external_commission_awards award where award.order_id=o.id and award.terms_id is not null and (kma_internal.external_eligibility_blocker(o.id,award.terms_id) is not null or kma_internal.external_eligibility_at(o.id,award.terms_id)>clock_timestamp())));
$$;

-- Deliberately separate from analytics: only product-scoped authenticated servers may attest fulfilment.
create function public.ingest_external_order_eligibility(p_product_id uuid,p_funnel_id uuid,p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.external_commerce_orders;i public.external_order_eligibility_identity;e public.external_order_eligibility_events;
 event_id uuid;sequence_value integer;at_value timestamptz;purchase_at timestamptz;dims jsonb;k text;
begin
 if jsonb_typeof(p_event) is distinct from 'object' or pg_column_size(p_event)>8192 or not(p_event ?& array['event_id','click_id','external_order_id','stripe_account_id','livemode','subject_id','purchase_sequence','context_id','status','occurred_at']) or exists(select 1 from jsonb_object_keys(p_event) x where x not in('event_id','click_id','external_order_id','stripe_account_id','livemode','subject_id','purchase_sequence','context_id','status','occurred_at','channel','entry_variant','webinar_id','intake_id')) then raise exception 'Invalid eligibility evidence fields' using errcode='22023';end if;
 if exists(select 1 from jsonb_each(p_event) x where x.key not in('livemode','purchase_sequence') and jsonb_typeof(x.value)<>'string') or jsonb_typeof(p_event->'livemode')<>'boolean' or jsonb_typeof(p_event->'purchase_sequence')<>'number' then raise exception 'Invalid eligibility evidence types' using errcode='22023';end if;
 event_id:=(p_event->>'event_id')::uuid;sequence_value:=(p_event->>'purchase_sequence')::integer;at_value:=(p_event->>'occurred_at')::timestamptz;
 if sequence_value not between 1 and 1000000 or sequence_value::numeric<>(p_event->>'purchase_sequence')::numeric or p_event->>'subject_id'!~'^[A-Za-z0-9_-]{16,128}$' or p_event->>'context_id'!~'^[A-Za-z0-9_-]{1,128}$' or p_event->>'status' not in('pending','fulfilled','cancelled') or not isfinite(at_value) or at_value>clock_timestamp()+interval '5 minutes' or p_event->>'occurred_at'!~'^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' then raise exception 'Invalid eligibility evidence values' using errcode='22023';end if;
 dims:=jsonb_build_object('context_id',p_event->>'context_id');
 foreach k in array array['channel','entry_variant','webinar_id','intake_id'] loop if p_event ? k then if p_event->>k!~'^[A-Za-z0-9_-]{1,128}$' then raise exception 'Invalid opaque dimension' using errcode='22023';end if;dims:=dims||jsonb_build_object(k,p_event->>k);end if;end loop;
 perform public.assert_funnel_request_scope('order-eligibility',p_event->>'click_id',p_product_id,p_funnel_id);
 perform pg_advisory_xact_lock(8154,42);
 select * into o from public.external_commerce_orders where external_order_id=(p_event->>'external_order_id')::uuid and product_id=p_product_id and funnel_id=p_funnel_id and stripe_account_id=p_event->>'stripe_account_id' and livemode=(p_event->>'livemode')::boolean and click_record_id=(select id from public.clicks where public_click_id=p_event->>'click_id');
 select provider_occurred_at into purchase_at from public.external_commerce_events where order_id=o.id and kind='purchase';
 if o.id is null or purchase_at is null then raise exception 'Verified purchase not received; retry later' using errcode='P0002';end if;
 if at_value<purchase_at then raise exception 'Eligibility cannot precede the verified purchase' using errcode='22023';end if;
 select * into e from public.external_order_eligibility_events where product_id=p_product_id and funnel_id=p_funnel_id and external_event_id=event_id;
 if found then if e.evidence<>p_event then raise exception 'Eligibility event identity changed' using errcode='23505';end if;return jsonb_build_object('event_id',e.id,'duplicate',true);end if;
 insert into public.external_order_eligibility_identity(order_id,product_id,livemode,subject_id,purchase_sequence,context_id,dimensions) values(o.id,o.product_id,o.livemode,p_event->>'subject_id',sequence_value,p_event->>'context_id',dims) on conflict(order_id) do nothing;
 select * into i from public.external_order_eligibility_identity where order_id=o.id;
 if row(i.product_id,i.livemode,i.subject_id,i.purchase_sequence,i.context_id,i.dimensions) is distinct from row(o.product_id,o.livemode,p_event->>'subject_id',sequence_value,p_event->>'context_id',dims) then raise exception 'Order eligibility identity changed' using errcode='23505';end if;
 insert into public.external_order_eligibility_events(product_id,funnel_id,external_event_id,order_id,status,occurred_at,evidence) values(p_product_id,p_funnel_id,event_id,o.id,p_event->>'status',at_value,p_event) returning * into e;
 perform kma_internal.refresh_external_award(o.id);
 return jsonb_build_object('event_id',e.id,'duplicate',false);
end $$;
revoke all on function kma_internal.external_eligibility_blocker(uuid,uuid),kma_internal.external_eligibility_at(uuid,uuid),public.ingest_external_order_eligibility(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.ingest_external_order_eligibility(uuid,uuid,jsonb) to service_role;
-- Legacy billing must not silently bypass signed fulfilment eligibility.
create or replace function public.process_commercial_fact(
  p_processing_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  processing_record public.commercial_fact_processing%rowtype;
  transaction_record public.transactions%rowtype;
  refund_record public.refunds%rowtype;
  dispute_record public.disputes%rowtype;
  acquisition_record public.acquisitions%rowtype;
  event_record public.events%rowtype;
  agreement_record public.agreements%rowtype;
  rule_record public.commission_rules%rowtype;
  period_record public.payout_periods%rowtype;
  state_record public.commercial_transaction_states%rowtype;
  conversion_record public.conversions%rowtype;
  entry_record public.commission_entries%rowtype;
  event_ids uuid[];
  agreement_ids uuid[];
  rule_ids uuid[];
  provider_record public.provider_events%rowtype;
  balance_record record;
  existing_balance public.commercial_dispute_balance_evidence%rowtype;
  inserted_balance_id text;
  canonical_dispute_impact bigint;
  source_occurred_at timestamptz;
  source_impact bigint;
  basis_after bigint;
  commission_after bigint;
  applied_amount bigint;
  entry_type_value public.ledger_entry_type;
  source_key_value text;
  refund_cutoff_days_value integer;
  refund_cutoff_at_value timestamptz;
  refund_excluded boolean := false;
begin
  select * into processing_record
  from public.commercial_fact_processing as processing
  where processing.id = p_processing_id
  for update;
  if processing_record.id is null
     or processing_record.status <> 'processing'
     or processing_record.claim_token is distinct from p_claim_token
     or processing_record.lease_expires_at <= now() then
    raise exception 'commercial fact claim is unavailable' using errcode = 'P0002';
  end if;

  if processing_record.source_kind = 'transaction' then
    select * into transaction_record from public.transactions
    where id = processing_record.source_id;
    if transaction_record.id is null then
      raise exception 'canonical transaction is unavailable' using errcode = 'P0002';
    end if;
  elsif processing_record.source_kind = 'refund' then
    select * into refund_record from public.refunds where id = processing_record.source_id;
    if refund_record.id is null then raise exception 'canonical refund is unavailable' using errcode = 'P0002'; end if;
    select * into transaction_record from public.transactions where id = refund_record.transaction_id;
  else
    select * into dispute_record from public.disputes where id = processing_record.source_id;
    if dispute_record.id is null then raise exception 'canonical dispute is unavailable' using errcode = 'P0002'; end if;
    select * into transaction_record from public.transactions where id = dispute_record.transaction_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('commercial-transaction:' || transaction_record.id::text, 0)
  );
  select * into acquisition_record from public.acquisitions
  where id = transaction_record.acquisition_id;

  -- Organic sales are reconciled but never silently assigned to a partner.
  if acquisition_record.id is null or acquisition_record.affiliate_id is null then
    update public.commercial_fact_processing set status = 'processed', processing_error = null,
      claimed_by = null, claim_token = null, claimed_at = null, lease_expires_at = null,
      processed_at = now(), updated_at = now()
    where id = processing_record.id;
    return jsonb_build_object('status', 'processed', 'commercial_result', 'organic');
  end if;

  if processing_record.source_kind = 'transaction' then
    if transaction_record.eligible_net_minor <= 0
       or acquisition_record.status <> 'resolved'
       or acquisition_record.account_id is null
       or not exists (select 1 from public.affiliates where id = acquisition_record.affiliate_id and status = 'active')
       or not exists (select 1 from public.products where id = acquisition_record.product_id and status = 'active') then
      raise exception 'commercial transaction identity or eligible basis is unavailable' using errcode = 'P0001';
    end if;

    select array_agg(event.id order by event.id) into event_ids
    from public.events as event
    join public.provider_events as provider on provider.id = event.provider_event_id
    where event.provider_event_id = transaction_record.provider_event_id
      and event.source = 'stripe' and event.trust = 'provider' and event.commercial_eligible
      and event.event_name = 'purchase.completed'
      and event.product_id = acquisition_record.product_id
      and event.affiliate_id = acquisition_record.affiliate_id
      and event.acquisition_id = acquisition_record.id
      and event.account_id = acquisition_record.account_id
      and event.properties ->> 'transaction_id' = transaction_record.id::text
      and provider.provider = 'stripe' and provider.signature_verified and provider.livemode;
    if cardinality(coalesce(event_ids, '{}'::uuid[])) <> 1 then
      raise exception 'transaction requires one exact live Stripe commercial event' using errcode = 'P0001';
    end if;
    select * into event_record from public.events where id = event_ids[1];

    select array_agg(agreement.id order by agreement.id) into agreement_ids
    from public.agreements as agreement
    where agreement.affiliate_id = acquisition_record.affiliate_id
      and agreement.product_id = acquisition_record.product_id
      and agreement.status = 'active'
      and agreement.starts_at <= transaction_record.occurred_at
      and (agreement.ends_at is null or agreement.ends_at > transaction_record.occurred_at)
      and agreement.payout_currency = transaction_record.settled_currency
      and public.agreement_is_launch_ready(agreement.id, transaction_record.occurred_at)
      and exists (
        select 1 from public.documents as document
        where document.agreement_id = agreement.id
          and document.status in ('signed', 'active')
          and document.signed_by_partner_at is not null
          and document.signed_by_kissmyapps_at is not null
          and (document.effective_at is null or document.effective_at <= transaction_record.occurred_at)
          and (document.expires_at is null or document.expires_at > transaction_record.occurred_at)
          and document.terminated_at is null
      );
    if cardinality(coalesce(agreement_ids, '{}'::uuid[])) <> 1 then
      raise exception 'transaction requires one effective active signed agreement' using errcode = 'P0001';
    end if;
    select * into agreement_record from public.agreements where id = agreement_ids[1];

    select array_agg(rule.id order by rule.id) into rule_ids
    from public.commission_rules as rule
    where rule.agreement_id = agreement_record.id and rule.status = 'active'
      and rule.trigger_event = event_record.event_name
      and rule.model = agreement_record.model
      and rule.model in ('cpa', 'revenue_share', 'hybrid')
      and (rule.currency is null or rule.currency = agreement_record.payout_currency);
    if cardinality(coalesce(rule_ids, '{}'::uuid[])) <> 1 then
      raise exception 'transaction requires one active matching commission rule' using errcode = 'P0001';
    end if;
    select * into rule_record from public.commission_rules where id = rule_ids[1];
    if rule_record.first_purchase_only or rule_record.fulfilment_required then
      raise exception 'this signed rule requires the verified external order eligibility integration' using errcode='P0001';
    end if;
    if rule_record.commission_basis_policy <> 'net_after_fees' then
      raise exception 'this purchase source requires the net-after-fees commission basis; shipping-exclusive evidence is unavailable' using errcode='P0001';
    end if;

    select * into period_record from public.payout_periods
    where id = public.commercial_posting_payout_period_id(transaction_record.occurred_at);

    insert into public.conversions (
      acquisition_id, affiliate_id, product_id, agreement_id, commission_rule_id,
      event_id, event_name, account_id, transaction_id, qualified, occurred_at
    ) values (
      acquisition_record.id, acquisition_record.affiliate_id, acquisition_record.product_id,
      agreement_record.id, rule_record.id, event_record.id, event_record.event_name,
      acquisition_record.account_id, transaction_record.id, true, event_record.occurred_at
    ) on conflict (acquisition_id, agreement_id, commission_rule_id, event_name, transaction_id)
      where transaction_id is not null do nothing;
    select * into conversion_record from public.conversions as conversion
    where conversion.acquisition_id = acquisition_record.id
      and conversion.agreement_id = agreement_record.id
      and conversion.commission_rule_id = rule_record.id
      and conversion.event_name = event_record.event_name
      and conversion.transaction_id = transaction_record.id;
    if conversion_record.id is null or not conversion_record.qualified then
      raise exception 'qualified conversion could not be persisted' using errcode = '23505';
    end if;

    applied_amount := public.commercial_commission_amount(
      rule_record.model, rule_record.fixed_amount_minor, rule_record.rate_basis_points,
      transaction_record.eligible_net_minor
    );
    if applied_amount <= 0 then
      raise exception 'commission rule produced no payable integer amount' using errcode = 'P0001';
    end if;
    source_key_value := 'commercial:transaction:' || transaction_record.id::text;
    insert into public.commission_entries (
      affiliate_id, product_id, agreement_id, commission_rule_id, conversion_id,
      transaction_id, payout_period_id, entry_type, amount_minor, currency,
      source_key, partner_visible_description, internal_note
    ) values (
      acquisition_record.affiliate_id, acquisition_record.product_id, agreement_record.id,
      rule_record.id, conversion_record.id, transaction_record.id, period_record.id,
      'commission', applied_amount, agreement_record.payout_currency, source_key_value,
      'Commission earned from a verified purchase.',
      'Deterministic calculation from live Stripe eligible net and immutable rule.'
    ) on conflict (source_key) do nothing;
    select * into entry_record from public.commission_entries where source_key = source_key_value;
    if entry_record.amount_minor <> applied_amount
       or entry_record.commission_rule_id <> rule_record.id
       or entry_record.transaction_id <> transaction_record.id then
      raise exception 'commercial transaction conflicts with an existing ledger result' using errcode = '23505';
    end if;

    insert into public.commercial_transaction_states (
      transaction_id, affiliate_id, product_id, agreement_id, commission_rule_id,
      conversion_id, original_commission_entry_id, original_eligible_basis_minor,
      current_eligible_basis_minor, current_commission_minor, currency, commission_policy_snapshot
    ) values (
      transaction_record.id, acquisition_record.affiliate_id, acquisition_record.product_id,
      agreement_record.id, rule_record.id, conversion_record.id, entry_record.id,
      transaction_record.eligible_net_minor, transaction_record.eligible_net_minor,
      applied_amount, agreement_record.payout_currency,
      jsonb_build_object('rule_id',rule_record.id,'rule_version',rule_record.version,
        'refund_cutoff_days',rule_record.refund_cutoff_days,
        'commission_basis_policy',rule_record.commission_basis_policy,
        'validation_window_hours',rule_record.validation_window_hours)
    ) on conflict (transaction_id) do nothing;

    insert into public.commercial_source_applications (
      source_kind, source_id, transaction_id, affiliate_id, product_id, agreement_id,
      commission_rule_id, conversion_id, commission_entry_id, source_balance_impact_minor,
      eligible_basis_before_minor, eligible_basis_after_minor, commission_before_minor,
      commission_after_minor, applied_amount_minor, currency, occurred_at
    ) values (
      'transaction', transaction_record.id, transaction_record.id,
      acquisition_record.affiliate_id, acquisition_record.product_id, agreement_record.id,
      rule_record.id, conversion_record.id, entry_record.id, transaction_record.eligible_net_minor,
      0, transaction_record.eligible_net_minor, 0, applied_amount, applied_amount,
      agreement_record.payout_currency, transaction_record.occurred_at
    ) on conflict (source_kind, source_id, source_subkey) do nothing;
  else
    select * into state_record from public.commercial_transaction_states
    where transaction_id = transaction_record.id for update;
    if state_record.transaction_id is null then
      raise exception 'commercial adjustment is waiting for its transaction commission' using errcode = 'P0002';
    end if;
    select * into rule_record from public.commission_rules where id = state_record.commission_rule_id;
    if rule_record.id is null then
      raise exception 'immutable commission rule is unavailable' using errcode = 'P0002';
    end if;
    if transaction_record.settled_currency <> state_record.currency
       or (processing_record.source_kind = 'refund' and refund_record.currency <> state_record.currency)
       or (processing_record.source_kind = 'dispute' and dispute_record.currency <> state_record.currency) then
      raise exception 'commercial adjustment currency conflicts with its transaction' using errcode = '23514';
    end if;
    if processing_record.source_kind = 'refund' then
      source_occurred_at := refund_record.occurred_at;
      if source_occurred_at < transaction_record.occurred_at then
        raise exception 'Refund occurrence precedes its purchase' using errcode='23514';
      end if;
      source_impact := refund_record.balance_impact_minor;
      -- The provider's occurrence time determines policy. Late delivery does not
      -- move an otherwise qualifying refund outside its original signed cutoff.
      refund_cutoff_days_value := case when state_record.commission_policy_snapshot is not null
        then (state_record.commission_policy_snapshot->>'refund_cutoff_days')::integer
        else rule_record.refund_cutoff_days end;
      refund_cutoff_at_value := transaction_record.occurred_at + refund_cutoff_days_value * interval '24 hours';
      refund_excluded := refund_cutoff_at_value is not null and source_occurred_at > refund_cutoff_at_value;
      if refund_excluded then source_impact := 0;
      else
        select * into period_record from public.payout_periods
        where id = public.commercial_posting_payout_period_id(source_occurred_at);
      end if;

      basis_after := least(
        state_record.original_eligible_basis_minor,
        greatest(0::bigint,
          state_record.original_eligible_basis_minor
            + state_record.applied_balance_impact_minor + source_impact)
      );
      commission_after := public.commercial_commission_amount(
        rule_record.model, rule_record.fixed_amount_minor, rule_record.rate_basis_points,
        basis_after
      );
      applied_amount := commission_after - state_record.current_commission_minor;
      entry_record := null;
      if applied_amount <> 0 then
        entry_type_value := case when applied_amount > 0
          then 'adjustment'::public.ledger_entry_type
          else 'refund_reversal'::public.ledger_entry_type end;
        source_key_value := 'commercial:refund:' || refund_record.id::text;
        insert into public.commission_entries (
          affiliate_id, product_id, agreement_id, commission_rule_id, conversion_id,
          transaction_id, payout_period_id, entry_type, amount_minor, currency,
          source_key, partner_visible_description, internal_note
        ) values (
          state_record.affiliate_id, state_record.product_id, state_record.agreement_id,
          state_record.commission_rule_id, state_record.conversion_id, transaction_record.id,
          period_record.id, entry_type_value, applied_amount, state_record.currency,
          source_key_value,
          case when applied_amount > 0
            then 'Commission restored after a verified refund correction.'
            else 'Commission reversed after a verified refund.' end,
          'Deterministic recalculation from canonical Stripe balance impact.'
        ) on conflict (source_key) do nothing;
        select * into entry_record from public.commission_entries where source_key = source_key_value;
        if entry_record.amount_minor <> applied_amount
           or entry_record.transaction_id <> transaction_record.id
           or entry_record.payout_period_id <> period_record.id then
          raise exception 'commercial adjustment conflicts with an existing ledger result' using errcode = '23505';
        end if;
      end if;

      insert into public.commercial_source_applications (
        source_kind, source_id, transaction_id, affiliate_id, product_id, agreement_id,
        commission_rule_id, conversion_id, commission_entry_id, source_balance_impact_minor,
        eligible_basis_before_minor, eligible_basis_after_minor, commission_before_minor,
        commission_after_minor, applied_amount_minor, currency, occurred_at, refund_policy
      ) values (
        'refund', refund_record.id, transaction_record.id,
        state_record.affiliate_id, state_record.product_id, state_record.agreement_id,
        state_record.commission_rule_id, state_record.conversion_id, entry_record.id,
        source_impact, state_record.current_eligible_basis_minor, basis_after,
        state_record.current_commission_minor, commission_after, applied_amount,
        state_record.currency, source_occurred_at,
        jsonb_build_object('cutoff_days',refund_cutoff_days_value,'cutoff_at',refund_cutoff_at_value,
          'excluded',refund_excluded,'provider_balance_impact_minor',refund_record.balance_impact_minor,
          'calculation','verified_balance_impact')
      ) on conflict (source_kind, source_id, source_subkey) do nothing;

      update public.commercial_transaction_states set
        applied_balance_impact_minor = state_record.applied_balance_impact_minor + source_impact,
        current_eligible_basis_minor = basis_after,
        current_commission_minor = commission_after,
        updated_at = now()
      where transaction_id = transaction_record.id;
    else
      select * into provider_record from public.provider_events
      where id = dispute_record.provider_event_id;
      if provider_record.id is null or provider_record.provider <> 'stripe'
         or provider_record.event_type not in (
           'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed'
         )
         or not provider_record.signature_verified or not provider_record.livemode
         or provider_record.payload #>> '{data,object,id}' <> dispute_record.stripe_dispute_id
         or jsonb_typeof(provider_record.payload #> '{data,object,balance_transactions}') <> 'array' then
        raise exception 'dispute requires exact live Stripe balance transaction evidence'
          using errcode = '23514';
      end if;
      if exists (
        select 1
        from jsonb_array_elements(provider_record.payload #> '{data,object,balance_transactions}') as item(value)
        where jsonb_typeof(item.value) <> 'object'
          or (item.value ->> 'id') !~ '^txn_[A-Za-z0-9_]{8,160}$'
          or (item.value ->> 'amount') !~ '^-?[0-9]+$'
          or (item.value ->> 'fee') !~ '^[0-9]+$'
          or (item.value ->> 'net') !~ '^-?[0-9]+$'
          or (item.value ->> 'currency') !~ '^[a-z]{3}$'
          or jsonb_typeof(item.value -> 'created') <> 'number'
          or upper(item.value ->> 'currency') <> dispute_record.currency
          or (item.value ->> 'net')::bigint
            <> (item.value ->> 'amount')::bigint - (item.value ->> 'fee')::bigint
          or public.stripe_epoch_timestamp(item.value -> 'created') > now() + interval '5 minutes'
      ) or (
        select count(*) <> count(distinct item.value ->> 'id')
        from jsonb_array_elements(provider_record.payload #> '{data,object,balance_transactions}') as item(value)
      ) then
        raise exception 'dispute balance transaction evidence is invalid or duplicated'
          using errcode = '23514';
      end if;

      select coalesce(sum((item.value ->> 'net')::bigint), 0)::bigint
      into canonical_dispute_impact
      from jsonb_array_elements(provider_record.payload #> '{data,object,balance_transactions}') as item(value)
      where (dispute_record.status = 'open' and (item.value ->> 'amount')::bigint < 0)
         or (dispute_record.status = 'won' and (item.value ->> 'amount')::bigint > 0);
      if canonical_dispute_impact <> dispute_record.balance_impact_minor then
        raise exception 'dispute balance transaction evidence conflicts with its canonical impact'
          using errcode = '23514';
      end if;

      for balance_record in
        select
          item.value ->> 'id' as balance_id,
          (item.value ->> 'amount')::bigint as amount_minor,
          (item.value ->> 'fee')::bigint as fee_minor,
          (item.value ->> 'net')::bigint as net_minor,
          public.stripe_epoch_timestamp(item.value -> 'created') as occurred_at
        from jsonb_array_elements(provider_record.payload #> '{data,object,balance_transactions}') as item(value)
        order by public.stripe_epoch_timestamp(item.value -> 'created'), item.value ->> 'id'
      loop
        inserted_balance_id := null;
        insert into public.commercial_dispute_balance_evidence (
          stripe_balance_transaction_id, stripe_dispute_id, transaction_id,
          first_dispute_id, first_provider_event_id, amount_minor, fee_minor,
          balance_net_minor, currency, occurred_at
        ) values (
          balance_record.balance_id, dispute_record.stripe_dispute_id,
          transaction_record.id, dispute_record.id, dispute_record.provider_event_id,
          balance_record.amount_minor, balance_record.fee_minor, balance_record.net_minor,
          dispute_record.currency, balance_record.occurred_at
        ) on conflict (stripe_balance_transaction_id) do nothing
        returning stripe_balance_transaction_id into inserted_balance_id;
        if inserted_balance_id is null then
          select * into existing_balance
          from public.commercial_dispute_balance_evidence
          where stripe_balance_transaction_id = balance_record.balance_id;
          if existing_balance.stripe_dispute_id <> dispute_record.stripe_dispute_id
             or existing_balance.transaction_id <> transaction_record.id
             or existing_balance.amount_minor <> balance_record.amount_minor
             or existing_balance.fee_minor <> balance_record.fee_minor
             or existing_balance.balance_net_minor <> balance_record.net_minor
             or existing_balance.currency <> dispute_record.currency
             or existing_balance.occurred_at <> balance_record.occurred_at then
            raise exception 'Stripe balance transaction conflicts with existing dispute evidence'
              using errcode = '23505';
          end if;
          continue;
        end if;

        select * into period_record from public.payout_periods
        where id = public.commercial_posting_payout_period_id(balance_record.occurred_at);

        source_impact := balance_record.net_minor;
        basis_after := least(
          state_record.original_eligible_basis_minor,
          greatest(0::bigint,
            state_record.original_eligible_basis_minor
              + state_record.applied_balance_impact_minor + source_impact)
        );
        commission_after := public.commercial_commission_amount(
          rule_record.model, rule_record.fixed_amount_minor, rule_record.rate_basis_points,
          basis_after
        );
        applied_amount := commission_after - state_record.current_commission_minor;
        entry_record := null;
        if applied_amount <> 0 then
          entry_type_value := case when applied_amount > 0
            then 'adjustment'::public.ledger_entry_type
            else 'dispute_reversal'::public.ledger_entry_type end;
          source_key_value := 'commercial:dispute-balance:' || balance_record.balance_id;
          insert into public.commission_entries (
            affiliate_id, product_id, agreement_id, commission_rule_id, conversion_id,
            transaction_id, payout_period_id, entry_type, amount_minor, currency,
            source_key, partner_visible_description, internal_note
          ) values (
            state_record.affiliate_id, state_record.product_id, state_record.agreement_id,
            state_record.commission_rule_id, state_record.conversion_id, transaction_record.id,
            period_record.id, entry_type_value, applied_amount, state_record.currency,
            source_key_value,
            case when applied_amount > 0
              then 'Commission restored after a payment dispute recovery.'
              else 'Commission reversed after a verified payment dispute.' end,
            'Deterministic recalculation from one immutable Stripe balance transaction.'
          ) on conflict (source_key) do nothing;
          select * into entry_record from public.commission_entries where source_key = source_key_value;
          if entry_record.amount_minor <> applied_amount
             or entry_record.transaction_id <> transaction_record.id
             or entry_record.payout_period_id <> period_record.id then
            raise exception 'commercial adjustment conflicts with an existing ledger result' using errcode = '23505';
          end if;
        end if;

        insert into public.commercial_source_applications (
          source_kind, source_id, source_subkey, transaction_id, affiliate_id, product_id,
          agreement_id, commission_rule_id, conversion_id, commission_entry_id,
          source_balance_impact_minor, eligible_basis_before_minor,
          eligible_basis_after_minor, commission_before_minor, commission_after_minor,
          applied_amount_minor, currency, occurred_at
        ) values (
          'dispute', dispute_record.id, balance_record.balance_id, transaction_record.id,
          state_record.affiliate_id, state_record.product_id, state_record.agreement_id,
          state_record.commission_rule_id, state_record.conversion_id, entry_record.id,
          source_impact, state_record.current_eligible_basis_minor, basis_after,
          state_record.current_commission_minor, commission_after, applied_amount,
          state_record.currency, balance_record.occurred_at
        ) on conflict (source_kind, source_id, source_subkey) do nothing;

        update public.commercial_transaction_states set
          applied_balance_impact_minor = state_record.applied_balance_impact_minor + source_impact,
          current_eligible_basis_minor = basis_after,
          current_commission_minor = commission_after,
          updated_at = now()
        where transaction_id = transaction_record.id;
        state_record.applied_balance_impact_minor :=
          state_record.applied_balance_impact_minor + source_impact;
        state_record.current_eligible_basis_minor := basis_after;
        state_record.current_commission_minor := commission_after;
      end loop;
    end if;
  end if;

  update public.commercial_fact_processing set status = 'processed', processing_error = null,
    claimed_by = null, claim_token = null, claimed_at = null, lease_expires_at = null,
    processed_at = now(), updated_at = now()
  where id = processing_record.id;
  return jsonb_build_object('status', 'processed', 'commercial_result',
    case when refund_excluded then 'refund_outside_cutoff' else 'applied' end,
    'source_kind', processing_record.source_kind, 'source_id', processing_record.source_id);
end;
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
        'first_purchase_only',rule.first_purchase_only,'fulfilment_required',rule.fulfilment_required,'policy_version',rule.policy_version,'refund_cutoff_days',rule.refund_cutoff_days,'commission_basis_policy',rule.commission_basis_policy,'external_refund_calculation',case when rule.policy_version>=2 then 'proportional_commission' else null end
      ) order by rule.name, rule.version
    )
    from public.commission_rules as rule
    where rule.agreement_id = agreement.id
  ), '[]'::jsonb) as rules
from public.agreements as agreement
join public.products as product on product.id = agreement.product_id
where public.current_user_has_affiliate(agreement.affiliate_id);


commit;
