-- Reuse signed canonical policy for legacy commissions as well as external orders.
-- No provider activation, historical monetary rewrite or transfer is performed.
begin;
alter table public.commercial_transaction_states
  add column commission_policy_snapshot jsonb check(commission_policy_snapshot is null or jsonb_typeof(commission_policy_snapshot)='object');
alter table public.commercial_source_applications
  add column refund_policy jsonb check(refund_policy is null or (source_kind='refund' and jsonb_typeof(refund_policy)='object'));

create function kma_internal.guard_commercial_policy_snapshot() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.commission_policy_snapshot is distinct from old.commission_policy_snapshot then
  raise exception 'Recorded commission policy is immutable' using errcode='55000';
 end if;
 return new;
end $$;
revoke all on function kma_internal.guard_commercial_policy_snapshot() from public,anon,authenticated,service_role;
create trigger commercial_policy_snapshot_immutable before update on public.commercial_transaction_states
for each row execute function kma_internal.guard_commercial_policy_snapshot();

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

create or replace function kma_internal.payout_review_state(p_id uuid)
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
  -- A payable statement cannot bypass the signed rule's validation waiting time.
  -- Ordinary-refund cutoff is independent and never used as a payout delay.
  if exists(select 1 from public.commission_entries e
    join public.transactions t on t.id=e.transaction_id
    join public.commission_rules r on r.id=e.commission_rule_id
    left join public.commercial_transaction_states s on s.transaction_id=t.id
    where e.affiliate_id=p.affiliate_id and e.product_id=p.product_id
      and e.payout_period_id=p.payout_period_id and e.entry_type='commission'
      and t.occurred_at + coalesce((s.commission_policy_snapshot->>'validation_window_hours')::integer,
        r.validation_window_hours)*interval '1 hour' > now()) then
    common_blocks:=array_append(common_blocks,'validation_window_pending');
  end if;
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

commit;
