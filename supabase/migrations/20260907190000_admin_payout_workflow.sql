-- Human-operated internal payout workflow. NO provider transfer or paid-state API.
begin;
create table kma_internal.payout_workflow_requests (
  request_id uuid primary key,
  actor_id uuid not null references auth.users(id),
  input jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table kma_internal.payout_workflow_requests enable row level security;
revoke all on kma_internal.payout_workflow_requests from public,anon,authenticated,service_role;

create function kma_internal.payout_processing_ready()
returns boolean language sql stable security definer set search_path='' as $$
  select cardinality(kma_internal.processing_health_reasons(public.processing_scheduler_health(),exists(
    select 1 from kma_internal.processing_stage_runs where outcome in ('degraded','failed') and dispatched_at>now()-interval '1 hour')))=0;
$$;
revoke all on function kma_internal.payout_processing_ready() from public,anon,authenticated,service_role;

create function kma_internal.payout_review_state(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p public.payouts%rowtype; period public.payout_periods%rowtype;
  destination public.payout_destinations%rowtype; reconciliation public.reconciliation_runs%rowtype;
  ledger record; snapshots record; blocks text[]:='{}'; common_blocks text[]:='{}';
  eligible bigint; latest_fact timestamptz;
begin
  select * into p from public.payouts where id=p_id;
  if p.id is null then raise exception 'Payout not found' using errcode='P0002'; end if;
  select * into period from public.payout_periods where id=p.payout_period_id;
  select count(*) n,coalesce(sum(amount_minor) filter(where entry_type='commission'),0)::bigint earnings,
    coalesce(sum(amount_minor) filter(where entry_type not in ('commission','carry_forward')),0)::bigint adjustments,
    coalesce(sum(amount_minor) filter(where entry_type='carry_forward'),0)::bigint carry,
    max(created_at) latest, count(distinct currency) currencies
  into ledger from public.commission_entries where affiliate_id=p.affiliate_id and product_id=p.product_id and payout_period_id=p.payout_period_id;
  select count(*) n,max(minimum_payout_minor) minimum,max(payout_frequency_days) frequency
  into snapshots from public.payout_agreement_snapshots where payout_id=p.id;
  if exists(select 1 from public.payout_agreement_snapshots where payout_id=p.id and payout_frequency_days<>14)
    then common_blocks:=array_append(common_blocks,'cadence_policy_required'); end if;
  select * into reconciliation from public.reconciliation_runs
    where provider='stripe' and starts_at=period.starts_at and ends_at=period.ends_at and currency=p.currency
    order by created_at desc,id desc limit 1;
  latest_fact:=greatest(ledger.latest,
    (select max(created_at) from public.transactions where occurred_at>=period.starts_at and occurred_at<period.ends_at and settled_currency=p.currency),
    (select max(created_at) from public.refunds where occurred_at>=period.starts_at and occurred_at<period.ends_at and currency=p.currency),
    (select max(recorded_at) from public.commercial_dispute_balance_evidence where occurred_at>=period.starts_at and occurred_at<period.ends_at and currency=p.currency));
  select * into destination from public.payout_destinations where affiliate_id=p.affiliate_id and currency=p.currency and status='active';
  select coalesce(sum(t.eligible_net_minor),0)::bigint into eligible from public.transactions t where t.id in (
    select distinct e.transaction_id from public.commission_entries e where e.affiliate_id=p.affiliate_id and e.product_id=p.product_id and e.payout_period_id=p.payout_period_id and e.entry_type='commission');
  if period.status<>'closed' then common_blocks:=array_append(common_blocks,'period_not_closed'); end if;
  if ledger.n=0 or ledger.currencies<>1 or exists(select 1 from public.commission_entries where affiliate_id=p.affiliate_id and product_id=p.product_id and payout_period_id=p.payout_period_id and currency<>p.currency)
    then common_blocks:=array_append(common_blocks,'ledger_unavailable'); end if;
  if p.earnings_minor<>ledger.earnings or p.adjustments_minor<>ledger.adjustments or p.carry_in_minor<>ledger.carry or p.eligible_net_minor<>eligible
    then common_blocks:=array_append(common_blocks,'statement_out_of_date'); end if;
  if snapshots.n=0 or exists(select 1 from public.commission_entries e where e.affiliate_id=p.affiliate_id and e.product_id=p.product_id and e.payout_period_id=p.payout_period_id
    and not exists(select 1 from public.payout_agreement_snapshots s where s.payout_id=p.id and s.agreement_id=e.agreement_id))
    then common_blocks:=array_append(common_blocks,'agreement_snapshot_missing'); end if;
  if reconciliation.id is null or reconciliation.status<>'passed' or reconciliation.unexplained_difference_minor is distinct from 0
    or reconciliation.exception_count<>0 or reconciliation.completed_at is null or reconciliation.completed_at<latest_fact
    then common_blocks:=array_append(common_blocks,'reconciliation_required'); end if;
  if not coalesce(kma_internal.payout_processing_ready(),false)
    or public.commercial_has_unprocessed_facts(period.starts_at,period.ends_at)
    then common_blocks:=array_append(common_blocks,'processing_not_ready'); end if;
  blocks:=common_blocks;
  if p.status<>'review' then blocks:=array_append(blocks,'review_required'); end if;
  if not exists(select 1 from public.affiliates where id=p.affiliate_id and status='active') then blocks:=array_append(blocks,'partner_not_active'); end if;
  if ledger.earnings+ledger.adjustments+ledger.carry<=0 then blocks:=array_append(blocks,'no_positive_balance');
  elsif ledger.earnings+ledger.adjustments+ledger.carry<coalesce(snapshots.minimum,0) then blocks:=array_append(blocks,'below_minimum'); end if;
  if destination.id is null or destination.verification_status<>'passed' or destination.verified_at is null or destination.effective_at is null
    or destination.effective_at>now() or destination.hold_until>now()
    or (destination.method='crypto' and (destination.test_transfer_status<>'passed' or destination.test_transfer_completed_at is null))
    then blocks:=array_append(blocks,'verified_destination_required'); end if;
  return jsonb_build_object('id',p.id,'period_id',period.id,'period_start',period.starts_at,'period_end',period.ends_at,'due_at',period.payout_due_at,
    'product_id',p.product_id,'product_name',(select name from public.products where id=p.product_id),
    'affiliate_id',p.affiliate_id,'partner_name',(select public_name from public.affiliates where id=p.affiliate_id),
    'status',p.status,'currency',p.currency,'eligible_net_minor',p.eligible_net_minor,'earnings_minor',p.earnings_minor,'adjustments_minor',p.adjustments_minor,
    'carry_in_minor',p.carry_in_minor,'carry_out_minor',p.carry_out_minor,'final_payout_minor',p.final_payout_minor,
    'minimum_minor',snapshots.minimum,'frequency_days',snapshots.frequency,'ledger_count',ledger.n,'snapshot_count',snapshots.n,
    'statement_number',p.statement_number,'updated_at',p.updated_at,'reviewed_at',p.reviewed_at,'approved_at',p.approved_at,
    'paid_at',p.paid_at,'hold_reason',p.hold_reason,'held_from_status',p.held_from_status,
    'destination_id',destination.id,'destination_label',destination.display_label,'destination_method',destination.method,
    'destination_version',destination.version,'destination_hold_until',destination.hold_until,
    'frozen_destination_label',p.destination_label_snapshot,'frozen_destination_version',p.destination_version_snapshot,
    'reconciliation_id',reconciliation.id,'reconciliation_status',reconciliation.status,'reconciled_at',reconciliation.completed_at,
    'common_blockers',to_jsonb(common_blocks),'approval_blockers',to_jsonb(blocks),'external_transfer_enabled',false);
end $$;
revoke all on function kma_internal.payout_review_state(uuid) from public,anon,authenticated,service_role;

create function public.get_admin_payout_workspace(p_period_id uuid default null,p_query text default null,p_status text default null,p_limit integer default 25,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare needle text:=lower(trim(coalesce(p_query,''))); selected uuid; result jsonb;
begin
  perform public.assert_admin_password(array['owner','finance','operations','analyst']::text[],'view payouts');
  if length(needle)>120 or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
    or (p_status is not null and p_status not in ('open','review','approved','scheduled','paid','on_hold','failed','carried_forward'))
    then raise exception 'Invalid payout filters' using errcode='22023'; end if;
  selected:=p_period_id;
  if selected is null then select id into selected from public.payout_periods order by starts_at desc,id limit 1; end if;
  if selected is not null and not exists(select 1 from public.payout_periods where id=selected) then raise exception 'Period unavailable' using errcode='P0002'; end if;
  with filtered as materialized (
    select p.id,p.created_at from public.payouts p join public.affiliates a on a.id=p.affiliate_id join public.products product on product.id=p.product_id
    where p.payout_period_id=selected and (p_status is null or p.status::text=p_status)
      and (needle='' or strpos(lower(a.public_name),needle)>0 or strpos(lower(product.name),needle)>0 or strpos(lower(coalesce(p.statement_number,'')),needle)>0)
  ), page as (select * from filtered order by created_at desc,id limit p_limit offset p_offset)
  select jsonb_build_object('generated_at',statement_timestamp(),'selected_period_id',selected,
    'periods',coalesce((select jsonb_agg(to_jsonb(t) order by starts_at desc,id) from (select id,starts_at,ends_at,review_starts_at,payout_due_at,status,updated_at from public.payout_periods order by starts_at desc,id limit 200)t),'[]'::jsonb),
    'periods_truncated',(select count(*)>200 from public.payout_periods),
    'total',(select count(*) from filtered),'items',coalesce((select jsonb_agg(kma_internal.payout_review_state(id) order by created_at desc,id) from page),'[]'::jsonb),
    'unprepared_groups',(select count(*) from (select affiliate_id,product_id from public.commission_entries e where payout_period_id=selected group by affiliate_id,product_id
      having not exists(select 1 from public.payouts p where p.affiliate_id=e.affiliate_id and p.product_id=e.product_id and p.payout_period_id=selected))t),
    'processing_attention',not coalesce(kma_internal.payout_processing_ready(),false),
    'external_transfer_enabled',false) into result;
  return result;
end $$;

create function public.get_admin_payout_statement(p_payout_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform public.assert_admin_password(array['owner','finance','operations','analyst']::text[],'view payout statement');
  return jsonb_build_object('payout',kma_internal.payout_review_state(p_payout_id),
    'agreements',coalesce((select jsonb_agg(jsonb_build_object('agreement_id',agreement_id,'version',agreement_version,'model',model,'minimum_minor',minimum_payout_minor,'frequency_days',payout_frequency_days,'currency',payout_currency) order by agreement_version,agreement_id) from public.payout_agreement_snapshots where payout_id=p_payout_id),'[]'::jsonb),
    'ledger',coalesce((select jsonb_agg(to_jsonb(t) order by created_at,id) from (select e.id,e.entry_type,e.amount_minor,e.currency,e.partner_visible_description as description,e.created_at,e.source_payout_id
      from public.commission_entries e join public.payouts p on p.id=p_payout_id and p.affiliate_id=e.affiliate_id and p.product_id=e.product_id and p.payout_period_id=e.payout_period_id order by e.created_at,e.id limit 500)t),'[]'::jsonb),
    'ledger_truncated',(select count(*)>500 from public.commission_entries e join public.payouts p on p.id=p_payout_id and p.affiliate_id=e.affiliate_id and p.product_id=e.product_id and p.payout_period_id=e.payout_period_id));
end $$;

create function public.perform_admin_payout_action(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid; request_id_value uuid; action_value text; target uuid; expected timestamptz;
  prior kma_internal.payout_workflow_requests%rowtype; p public.payouts%rowtype; period public.payout_periods%rowtype;
  destination public.payout_destinations%rowtype; next_period public.payout_periods%rowtype;
  review jsonb; result jsonb; reason_value text; available bigint; agreement uuid;
  starts_value timestamptz; ends_value timestamptz; review_value timestamptz; due_value timestamptz;
begin
  perform public.assert_admin_password(array['owner','finance']::text[],'operate payouts');
  actor:=auth.uid();
  if p_input is null or jsonb_typeof(p_input)<>'object' or not(p_input ?& array['request_id','action','reason'])
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('request_id','action','reason','id','expected_updated_at','starts_at','ends_at','review_starts_at','payout_due_at','next_period_id'))
    then raise exception 'Invalid payout action input' using errcode='22023'; end if;
  action_value:=p_input->>'action'; reason_value:=trim(p_input->>'reason');
  if action_value is null or action_value not in ('create_period','review_period','close_period','prepare_statements','review','approve','hold','resume','carry_forward')
    or reason_value is null or length(reason_value) not between 5 and 500 then raise exception 'Action and reason are required' using errcode='22023'; end if;
  begin request_id_value:=(p_input->>'request_id')::uuid; target:=(p_input->>'id')::uuid; expected:=(p_input->>'expected_updated_at')::timestamptz;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'Invalid action identity' using errcode='22023'; end;
  if request_id_value is null then raise exception 'Request ID required' using errcode='22023'; end if;
  -- Serialize human operations. Period row locks also interlock with ledger posting.
  perform pg_advisory_xact_lock(hashtextextended('kma-admin-payout-workflow',0));
  -- A queued operator may have lost authority while waiting for another action.
  perform public.assert_admin_password(array['owner','finance']::text[],'operate payouts');
  select * into prior from kma_internal.payout_workflow_requests where request_id=request_id_value;
  if prior.request_id is not null then
    if prior.actor_id<>actor or prior.input<>p_input then raise exception 'Conflicting request retry' using errcode='40001'; end if;
    return prior.result;
  end if;
  if action_value='create_period' then
    if p_input ?| array['id','expected_updated_at','next_period_id'] or not(p_input ?& array['starts_at','ends_at','review_starts_at','payout_due_at']) then raise exception 'Invalid period creation fields' using errcode='22023'; end if;
    if exists(select 1 from unnest(array['starts_at','ends_at','review_starts_at','payout_due_at']) k where jsonb_typeof(p_input->k) is distinct from 'string' or coalesce(p_input->>k,'') !~ '^\d{4}-\d{2}-\d{2}T') then raise exception 'Complete UTC dates required' using errcode='22023'; end if;
    begin
      starts_value:=(p_input->>'starts_at')::timestamptz; ends_value:=(p_input->>'ends_at')::timestamptz;
      review_value:=(p_input->>'review_starts_at')::timestamptz; due_value:=(p_input->>'payout_due_at')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Invalid UTC dates' using errcode='22023'; end;
    if ends_value-starts_value<>interval '14 days' or review_value<ends_value or due_value<=review_value
      or starts_value<>date_trunc('day',starts_value at time zone 'UTC') at time zone 'UTC'
      then raise exception 'Use a 14-day period starting at midnight UTC' using errcode='22023'; end if;
    result:=public.create_admin_payout_period(p_input-array['request_id','action','reason']); target:=(result->>'id')::uuid;
  else
    if target is null or expected is null or p_input ?| array['starts_at','ends_at','review_starts_at','payout_due_at']
      or (action_value<>'carry_forward' and p_input ? 'next_period_id') then raise exception 'Target and version required' using errcode='22023'; end if;
    if action_value in ('review_period','close_period','prepare_statements') then
      select * into period from public.payout_periods where id=target for update;
      if period.id is null then raise exception 'Period unavailable' using errcode='P0002'; end if;
      if period.updated_at<>expected then raise exception 'Period changed; refresh first' using errcode='40001'; end if;
      if action_value='prepare_statements' then
        if period.status<>'closed' then raise exception 'Close the period first' using errcode='P0001'; end if;
        if exists(select 1 from public.payouts where payout_period_id=target and calculation_finalized_at is not null) then
          if exists(select 1 from public.commission_entries e where e.payout_period_id=target and not exists(select 1 from public.payouts stored where stored.payout_period_id=target and stored.affiliate_id=e.affiliate_id and stored.product_id=e.product_id)) then raise exception 'Mixed preparation state requires investigation' using errcode='P0001'; end if;
          result:=jsonb_build_object('status','already_prepared');
        else
          result:=public.prepare_admin_payout_statements(jsonb_build_object('payout_period_id',target));
          -- Count eligible revenue once per transaction, even when several ledger
          -- entries reference it. Match the foundation's finalization invariant.
          update public.payouts stored set eligible_net_minor=(select coalesce(sum(t.eligible_net_minor),0)::bigint from public.transactions t
            where t.id in (select distinct e.transaction_id from public.commission_entries e where e.affiliate_id=stored.affiliate_id
              and e.product_id=stored.product_id and e.payout_period_id=target and e.entry_type='commission'))
            where stored.payout_period_id=target and stored.calculation_finalized_at is null;
        end if;
      else
        if not coalesce(kma_internal.payout_processing_ready(),false) then raise exception 'Resolve processing health first' using errcode='P0001'; end if;
        result:=public.advance_admin_payout_period(jsonb_build_object('payout_period_id',target,'status',case when action_value='review_period' then 'review' else 'closed' end));
      end if;
    else
      select * into p from public.payouts where id=target for update;
      if p.id is null then raise exception 'Payout unavailable' using errcode='P0002'; end if;
      if p.updated_at<>expected then raise exception 'Statement changed; refresh first' using errcode='40001'; end if;
      perform 1 from public.affiliates where id=p.affiliate_id for share;
      select * into period from public.payout_periods where id=p.payout_period_id for update;
      review:=kma_internal.payout_review_state(target);
      if action_value='review' then
        if p.status<>'open' or period.status<>'closed' or (review->>'ledger_count')::bigint=0 or (review->>'snapshot_count')::bigint=0 then raise exception 'Statement not ready for review' using errcode='P0001'; end if;
        update public.payouts set status='review',reviewed_at=now(),reviewed_by=actor where id=target;
      elsif action_value='hold' then
        if p.status not in ('open','review','approved','scheduled','failed') then raise exception 'Payout cannot be held' using errcode='P0001'; end if;
        update public.payouts set status='on_hold',hold_reason=reason_value,held_from_status=p.status where id=target;
      elsif action_value='resume' then
        if p.status<>'on_hold' or p.held_from_status not in ('open','review','approved') then raise exception 'This hold needs separate settlement investigation' using errcode='P0001'; end if;
        if p.held_from_status='approved' then
          -- Approval may resume only with its ORIGINAL destination and current evidence.
          if (review->'approval_blockers')-'review_required'<>'[]'::jsonb or p.payout_destination_id is distinct from (review->>'destination_id')::uuid
            then raise exception 'Revalidate original destination and reconciliation before resuming' using errcode='P0001'; end if;
        end if;
        update public.payouts set status=p.held_from_status where id=target;
      elsif action_value in ('approve','carry_forward') then
        if p.status<>'review' or review->'common_blockers'<>'[]'::jsonb then raise exception 'Review and reconciliation are required' using errcode='P0001'; end if;
        if action_value='approve' then
          if review->'approval_blockers'<>'[]'::jsonb then raise exception 'Approval readiness checks have not passed' using errcode='P0001'; end if;
          select * into destination from public.payout_destinations where id=(review->>'destination_id')::uuid for share;
          update public.payouts set status='approved',approved_at=now(),approved_by=actor,
            calculation_finalized_at=now(),calculation_finalized_by=actor,
            minimum_payout_minor_snapshot=(review->>'minimum_minor')::bigint,payout_frequency_days_snapshot=(review->>'frequency_days')::integer,
            reconciliation_run_id=(review->>'reconciliation_id')::uuid,payout_destination_id=destination.id,
            payment_method_snapshot=destination.method,destination_label_snapshot=destination.display_label,destination_version_snapshot=destination.version
          where id=target;
        else
          available:=p.earnings_minor+p.adjustments_minor+p.carry_in_minor;
          if available>=(review->>'minimum_minor')::bigint or (review->>'snapshot_count')::integer<>1 then raise exception 'Carry-forward requires below-minimum balance and one agreement; mixed agreements need a reviewed allocation policy' using errcode='P0001'; end if;
          select * into next_period from public.payout_periods where id=(p_input->>'next_period_id')::uuid for update;
          if next_period.id is null or next_period.status<>'open' or next_period.starts_at<period.ends_at then raise exception 'Choose a later open period' using errcode='P0001'; end if;
          select agreement_id into strict agreement from public.payout_agreement_snapshots where payout_id=target;
          update public.payouts set status='carried_forward',calculation_finalized_at=now(),calculation_finalized_by=actor,
            minimum_payout_minor_snapshot=(review->>'minimum_minor')::bigint,payout_frequency_days_snapshot=(review->>'frequency_days')::integer,
            reconciliation_run_id=(review->>'reconciliation_id')::uuid,final_payout_minor=0,carry_out_minor=available where id=target;
          if available<>0 then
            insert into public.commission_entries(affiliate_id,product_id,agreement_id,source_payout_id,payout_period_id,entry_type,amount_minor,currency,source_key,partner_visible_description)
            values(p.affiliate_id,p.product_id,agreement,target,next_period.id,'carry_forward',available,p.currency,'admin-carry:'||target::text,'Balance carried forward from '||coalesce(p.statement_number,target::text));
          end if;
        end if;
      end if;
    end if;
  end if;
  result:=jsonb_build_object('request_id',request_id_value,'action',action_value,'id',target,'external_transfer',false);
  insert into public.audit_logs(actor_user_id,actor_type,action,target_table,target_id,after_data)
    values(actor,'admin','payout_workflow_'||action_value,case when action_value in ('create_period','review_period','close_period','prepare_statements') then 'payout_periods' else 'payouts' end,target,jsonb_build_object('reason',reason_value,'request_id',request_id_value,'external_transfer',false));
  insert into kma_internal.payout_workflow_requests(request_id,actor_id,input,result) values(request_id_value,actor,p_input,result);
  return result;
end $$;

-- Browser operators must use the idempotent audited wrapper, never legacy writes.
revoke execute on function public.create_admin_payout_period(jsonb),public.advance_admin_payout_period(jsonb),public.prepare_admin_payout_statements(jsonb) from authenticated;
revoke all on function public.get_admin_payout_workspace(uuid,text,text,integer,integer),public.get_admin_payout_statement(uuid),public.perform_admin_payout_action(jsonb) from public,anon,service_role;
grant execute on function public.get_admin_payout_workspace(uuid,text,text,integer,integer),public.get_admin_payout_statement(uuid),public.perform_admin_payout_action(jsonb) to authenticated;
commit;
