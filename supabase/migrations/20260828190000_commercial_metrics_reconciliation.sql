-- Production commercial calculation, reporting, reconciliation, and statement
-- preparation. This migration never schedules or executes an external payout.

create table public.commercial_fact_processing (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null check (source_kind in ('transaction', 'refund', 'dispute')),
  source_id uuid not null,
  occurred_at timestamptz not null,
  status public.processing_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  processing_error text,
  claimed_by text,
  claim_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_kind, source_id),
  check (
    (status = 'processing' and claimed_by is not null and claim_token is not null
      and claimed_at is not null and lease_expires_at > claimed_at and processed_at is null)
    or (status <> 'processing' and claimed_by is null and claim_token is null
      and claimed_at is null and lease_expires_at is null)
  ),
  check ((status = 'processed' and processed_at is not null and processing_error is null)
    or status <> 'processed'),
  check ((status = 'failed' and processing_error is not null) or status <> 'failed')
);

create unique index commercial_fact_processing_claim_token_unique
  on public.commercial_fact_processing (claim_token) where claim_token is not null;
create index commercial_fact_processing_ready_idx
  on public.commercial_fact_processing (status, next_attempt_at, occurred_at, id);

create table public.commercial_transaction_states (
  transaction_id uuid primary key references public.transactions (id),
  affiliate_id uuid not null references public.affiliates (id),
  product_id uuid not null references public.products (id),
  agreement_id uuid not null references public.agreements (id),
  commission_rule_id uuid not null references public.commission_rules (id),
  conversion_id uuid not null references public.conversions (id),
  original_commission_entry_id uuid not null unique references public.commission_entries (id),
  original_eligible_basis_minor bigint not null check (original_eligible_basis_minor > 0),
  applied_balance_impact_minor bigint not null default 0,
  current_eligible_basis_minor bigint not null check (current_eligible_basis_minor >= 0),
  current_commission_minor bigint not null check (current_commission_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (current_eligible_basis_minor <= original_eligible_basis_minor)
);

-- Stripe can repeat the same dispute balance transaction in created, updated,
-- and closed event snapshots. The Stripe balance transaction ID, not the
-- webhook event ID, is the durable money idempotency key.
create table public.commercial_dispute_balance_evidence (
  stripe_balance_transaction_id text primary key check (
    stripe_balance_transaction_id ~ '^txn_[A-Za-z0-9_]{8,160}$'
  ),
  stripe_dispute_id text not null,
  transaction_id uuid not null references public.transactions (id),
  first_dispute_id uuid not null references public.disputes (id),
  first_provider_event_id uuid not null references public.provider_events (id),
  amount_minor bigint not null,
  fee_minor bigint not null check (fee_minor >= 0),
  balance_net_minor bigint not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check (balance_net_minor = amount_minor - fee_minor)
);

create index commercial_dispute_balance_evidence_metric_idx
  on public.commercial_dispute_balance_evidence (transaction_id, occurred_at, currency);

create table public.commercial_source_applications (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null check (source_kind in ('transaction', 'refund', 'dispute')),
  source_id uuid not null,
  source_subkey text not null default '' check (char_length(source_subkey) <= 180),
  transaction_id uuid not null references public.transactions (id),
  affiliate_id uuid not null references public.affiliates (id),
  product_id uuid not null references public.products (id),
  agreement_id uuid not null references public.agreements (id),
  commission_rule_id uuid not null references public.commission_rules (id),
  conversion_id uuid not null references public.conversions (id),
  commission_entry_id uuid references public.commission_entries (id),
  source_balance_impact_minor bigint not null,
  eligible_basis_before_minor bigint not null check (eligible_basis_before_minor >= 0),
  eligible_basis_after_minor bigint not null check (eligible_basis_after_minor >= 0),
  commission_before_minor bigint not null check (commission_before_minor >= 0),
  commission_after_minor bigint not null check (commission_after_minor >= 0),
  applied_amount_minor bigint not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null,
  processed_at timestamptz not null default now(),
  unique (source_kind, source_id, source_subkey),
  check (applied_amount_minor = commission_after_minor - commission_before_minor),
  check ((applied_amount_minor = 0 and commission_entry_id is null)
    or (applied_amount_minor <> 0 and commission_entry_id is not null))
);

create index commercial_source_applications_metric_idx
  on public.commercial_source_applications (affiliate_id, product_id, occurred_at);

create table public.commercial_metric_refresh_queue (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates (id),
  product_id uuid not null references public.products (id),
  metric_date date not null,
  status public.processing_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  processing_error text,
  claimed_by text,
  claim_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (affiliate_id, product_id, metric_date),
  check (
    (status = 'processing' and claimed_by is not null and claim_token is not null
      and claimed_at is not null and lease_expires_at > claimed_at and processed_at is null)
    or (status <> 'processing' and claimed_by is null and claim_token is null
      and claimed_at is null and lease_expires_at is null)
  ),
  check ((status = 'processed' and processed_at is not null and processing_error is null)
    or status <> 'processed'),
  check ((status = 'failed' and processing_error is not null) or status <> 'failed')
);

create unique index commercial_metric_refresh_claim_token_unique
  on public.commercial_metric_refresh_queue (claim_token) where claim_token is not null;
create index commercial_metric_refresh_ready_idx
  on public.commercial_metric_refresh_queue (status, next_attempt_at, metric_date, id);

create table public.commercial_reconciliation_evidence (
  reconciliation_run_id uuid primary key references public.reconciliation_runs (id),
  provider_total_minor bigint not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz not null default now()
);

create table public.commercial_reconciliation_processing (
  reconciliation_run_id uuid primary key references public.reconciliation_runs (id),
  status public.processing_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  processing_error text,
  claimed_by text,
  claim_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (status = 'processing' and claimed_by is not null and claim_token is not null
      and claimed_at is not null and lease_expires_at > claimed_at and processed_at is null)
    or (status <> 'processing' and claimed_by is null and claim_token is null
      and claimed_at is null and lease_expires_at is null)
  ),
  check ((status = 'processed' and processed_at is not null and processing_error is null)
    or status <> 'processed'),
  check ((status = 'failed' and processing_error is not null) or status <> 'failed')
);

create unique index commercial_reconciliation_claim_token_unique
  on public.commercial_reconciliation_processing (claim_token) where claim_token is not null;

create or replace function public.enqueue_commercial_fact()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  kind_value text;
  occurred_at_value timestamptz;
  provider_payload jsonb;
begin
  kind_value := case tg_table_name
    when 'transactions' then 'transaction'
    when 'refunds' then 'refund'
    when 'disputes' then 'dispute'
    else null
  end;
  if kind_value is null then
    raise exception 'unsupported commercial fact queue source' using errcode = '23514';
  end if;
  occurred_at_value := new.occurred_at;
  if kind_value = 'dispute' then
    select provider.payload into provider_payload
    from public.provider_events as provider
    where provider.id = new.provider_event_id;
    if provider_payload is null
       or jsonb_typeof(provider_payload #> '{data,object,balance_transactions}') <> 'array' then
      raise exception 'dispute processing chronology is unavailable' using errcode = '23514';
    end if;
    select greatest(
      coalesce(
        max(public.stripe_epoch_timestamp(item.value -> 'created')),
        public.stripe_epoch_timestamp(provider_payload -> 'created')
      ),
      public.stripe_epoch_timestamp(provider_payload -> 'created')
    ) into occurred_at_value
    from jsonb_array_elements(provider_payload #> '{data,object,balance_transactions}') as item(value);
  end if;
  insert into public.commercial_fact_processing (source_kind, source_id, occurred_at)
  values (kind_value, new.id, occurred_at_value)
  on conflict (source_kind, source_id) do nothing;
  return new;
end;
$$;

create trigger transactions_enqueue_commercial_fact
  after insert on public.transactions for each row execute function public.enqueue_commercial_fact();
create trigger refunds_enqueue_commercial_fact
  after insert on public.refunds for each row execute function public.enqueue_commercial_fact();
create trigger disputes_enqueue_commercial_fact
  after insert on public.disputes for each row execute function public.enqueue_commercial_fact();

insert into public.commercial_fact_processing (source_kind, source_id, occurred_at)
select 'transaction', transaction.id, transaction.occurred_at from public.transactions as transaction
on conflict (source_kind, source_id) do nothing;
insert into public.commercial_fact_processing (source_kind, source_id, occurred_at)
select 'refund', refund.id, refund.occurred_at from public.refunds as refund
on conflict (source_kind, source_id) do nothing;
insert into public.commercial_fact_processing (source_kind, source_id, occurred_at)
select 'dispute', dispute.id,
  case
    when jsonb_typeof(provider.payload #> '{data,object,balance_transactions}') = 'array'
      then greatest(
        coalesce(
          (
            select max(public.stripe_epoch_timestamp(item.value -> 'created'))
            from jsonb_array_elements(provider.payload #> '{data,object,balance_transactions}') as item(value)
          ),
          public.stripe_epoch_timestamp(provider.payload -> 'created')
        ),
        public.stripe_epoch_timestamp(provider.payload -> 'created')
      )
    else public.stripe_epoch_timestamp(provider.payload -> 'created')
  end
from public.disputes as dispute
join public.provider_events as provider on provider.id = dispute.provider_event_id
on conflict (source_kind, source_id) do nothing;

create or replace function public.claim_commercial_facts(
  p_worker text,
  p_limit integer default 25,
  p_lease_seconds integer default 120
)
returns table (
  processing_id uuid,
  source_kind text,
  source_id uuid,
  claim_token uuid,
  attempt_count integer,
  occurred_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  p_worker := trim(coalesce(p_worker, ''));
  if p_worker !~ '^[a-z][a-z0-9_-]{1,63}$'
     or p_limit not between 1 and 100
     or p_lease_seconds not between 15 and 900 then
    raise exception 'commercial worker claim bounds are invalid' using errcode = '22023';
  end if;
  return query
  with candidates as (
    select processing.id
    from public.commercial_fact_processing as processing
    where (processing.status = 'pending' and processing.next_attempt_at <= now())
       or (processing.status = 'processing' and processing.lease_expires_at <= now())
    order by processing.occurred_at, processing.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.commercial_fact_processing as processing
    set status = 'processing', attempt_count = processing.attempt_count + 1,
      processing_error = null, claimed_by = p_worker, claim_token = gen_random_uuid(),
      claimed_at = now(), lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
    from candidates where processing.id = candidates.id
    returning processing.*
  )
  select claimed.id, claimed.source_kind, claimed.source_id, claimed.claim_token,
    claimed.attempt_count, claimed.occurred_at
  from claimed order by claimed.occurred_at, claimed.id;
end;
$$;

create or replace function public.commercial_commission_amount(
  p_model public.commission_model,
  p_fixed_amount_minor bigint,
  p_rate_basis_points integer,
  p_eligible_basis_minor bigint
)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_eligible_basis_minor is null or p_eligible_basis_minor < 0 then
    raise exception 'eligible commission basis must be a non-negative integer' using errcode = '22023';
  end if;
  if p_eligible_basis_minor = 0 then return 0; end if;
  return case p_model
    when 'cpa' then p_fixed_amount_minor
    when 'revenue_share' then floor(p_eligible_basis_minor::numeric * p_rate_basis_points / 10000)::bigint
    when 'hybrid' then p_fixed_amount_minor
      + floor(p_eligible_basis_minor::numeric * p_rate_basis_points / 10000)::bigint
    else null
  end;
end;
$$;

-- Ledger posting periods are operational buckets, while occurred_at remains the
-- immutable economic date. A late fact never mutates a closed period: it rolls
-- into the one period that is open now, if its original period is no longer open.
create or replace function public.commercial_posting_payout_period_id(
  p_source_occurred_at timestamptz
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  matching_ids uuid[];
begin
  if p_source_occurred_at is null or p_source_occurred_at > now() + interval '5 minutes' then
    raise exception 'commercial source occurrence time is invalid' using errcode = '22023';
  end if;
  select array_agg(period.id order by period.id) into matching_ids
  from public.payout_periods as period
  where period.status = 'open'
    and period.starts_at <= p_source_occurred_at
    and period.ends_at > p_source_occurred_at;
  if cardinality(coalesce(matching_ids, '{}'::uuid[])) = 1 then
    return matching_ids[1];
  elsif cardinality(coalesce(matching_ids, '{}'::uuid[])) > 1 then
    raise exception 'commercial source occurrence overlaps multiple open payout periods'
      using errcode = '23514';
  end if;

  select array_agg(period.id order by period.id) into matching_ids
  from public.payout_periods as period
  where period.status = 'open'
    and period.starts_at <= now()
    and period.ends_at > now();
  if cardinality(coalesce(matching_ids, '{}'::uuid[])) <> 1 then
    raise exception 'late commercial fact requires one current open payout period'
      using errcode = 'P0001';
  end if;
  return matching_ids[1];
end;
$$;

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
      current_eligible_basis_minor, current_commission_minor, currency
    ) values (
      transaction_record.id, acquisition_record.affiliate_id, acquisition_record.product_id,
      agreement_record.id, rule_record.id, conversion_record.id, entry_record.id,
      transaction_record.eligible_net_minor, transaction_record.eligible_net_minor,
      applied_amount, agreement_record.payout_currency
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
      source_impact := refund_record.balance_impact_minor;
      select * into period_record from public.payout_periods
      where id = public.commercial_posting_payout_period_id(source_occurred_at);

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
        commission_after_minor, applied_amount_minor, currency, occurred_at
      ) values (
        'refund', refund_record.id, transaction_record.id,
        state_record.affiliate_id, state_record.product_id, state_record.agreement_id,
        state_record.commission_rule_id, state_record.conversion_id, entry_record.id,
        source_impact, state_record.current_eligible_basis_minor, basis_after,
        state_record.current_commission_minor, commission_after, applied_amount,
        state_record.currency, source_occurred_at
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
  return jsonb_build_object('status', 'processed', 'commercial_result', 'applied',
    'source_kind', processing_record.source_kind, 'source_id', processing_record.source_id);
end;
$$;

create or replace function public.fail_commercial_fact(
  p_processing_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_retry_delay_seconds integer default 60,
  p_terminal boolean default false
)
returns public.processing_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare resulting_status public.processing_status;
begin
  if trim(coalesce(p_error_code, '')) !~ '^[a-z][a-z0-9_.-]{0,99}$'
     or p_retry_delay_seconds not between 0 and 86400 then
    raise exception 'commercial retry input is invalid' using errcode = '22023';
  end if;
  update public.commercial_fact_processing set
    status = case when p_terminal then 'failed'::public.processing_status else 'pending'::public.processing_status end,
    processing_error = trim(p_error_code), claimed_by = null, claim_token = null,
    claimed_at = null, lease_expires_at = null,
    next_attempt_at = case when p_terminal then next_attempt_at
      else now() + make_interval(secs => p_retry_delay_seconds) end,
    updated_at = now()
  where id = p_processing_id and status = 'processing' and claim_token = p_claim_token
    and lease_expires_at > now()
  returning status into resulting_status;
  if resulting_status is null then raise exception 'commercial fact claim is unavailable' using errcode = 'P0002'; end if;
  return resulting_status;
end;
$$;

create or replace function public.commercial_has_unprocessed_facts(
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.commercial_fact_processing as processing
    where processing.status <> 'processed'
      and (
        (
          processing.source_kind in ('transaction', 'refund')
          and processing.occurred_at >= p_starts_at
          and processing.occurred_at < p_ends_at
        )
        or (
          processing.source_kind = 'dispute'
          and exists (
            select 1
            from public.disputes as dispute
            join public.provider_events as provider on provider.id = dispute.provider_event_id
            where dispute.id = processing.source_id
              and case
                when jsonb_typeof(provider.payload #> '{data,object,balance_transactions}') = 'array'
                  and jsonb_array_length(provider.payload #> '{data,object,balance_transactions}') > 0
                then exists (
                  select 1
                  from jsonb_array_elements(
                    provider.payload #> '{data,object,balance_transactions}'
                  ) as item(value)
                  where public.stripe_epoch_timestamp(item.value -> 'created') >= p_starts_at
                    and public.stripe_epoch_timestamp(item.value -> 'created') < p_ends_at
                )
                else public.stripe_epoch_timestamp(provider.payload -> 'created') >= p_starts_at
                  and public.stripe_epoch_timestamp(provider.payload -> 'created') < p_ends_at
              end
          )
        )
      )
  );
$$;

create or replace function public.queue_commercial_metric(
  p_affiliate_id uuid,
  p_product_id uuid,
  p_occurred_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare timezone_value text; date_value date;
begin
  if p_affiliate_id is null or p_product_id is null or p_occurred_at is null then return; end if;
  select affiliate.reporting_timezone into timezone_value
  from public.affiliates as affiliate where affiliate.id = p_affiliate_id;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = timezone_value) then
    timezone_value := 'UTC';
  end if;
  date_value := (p_occurred_at at time zone timezone_value)::date;
  insert into public.commercial_metric_refresh_queue (affiliate_id, product_id, metric_date)
  values (p_affiliate_id, p_product_id, date_value)
  on conflict (affiliate_id, product_id, metric_date) do update set
    status = case when commercial_metric_refresh_queue.status = 'processing'
      then commercial_metric_refresh_queue.status else 'pending'::public.processing_status end,
    processed_at = case when commercial_metric_refresh_queue.status = 'processing'
      then commercial_metric_refresh_queue.processed_at else null end,
    processing_error = null, next_attempt_at = now(), updated_at = now();
end;
$$;

create or replace function public.enqueue_commercial_metric_from_fact()
returns trigger
language plpgsql
set search_path = ''
as $$
declare affiliate_id_value uuid; product_id_value uuid; occurred_at_value timestamptz;
begin
  if tg_table_name = 'clicks' then
    affiliate_id_value := new.affiliate_id; product_id_value := new.product_id; occurred_at_value := new.occurred_at;
  elsif tg_table_name = 'events' then
    affiliate_id_value := new.affiliate_id; product_id_value := new.product_id; occurred_at_value := new.occurred_at;
  elsif tg_table_name = 'transactions' then
    select acquisition.affiliate_id, acquisition.product_id into affiliate_id_value, product_id_value
    from public.acquisitions as acquisition where acquisition.id = new.acquisition_id;
    occurred_at_value := new.occurred_at;
  elsif tg_table_name = 'refunds' then
    select acquisition.affiliate_id, acquisition.product_id into affiliate_id_value, product_id_value
    from public.transactions as transaction join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
    where transaction.id = new.transaction_id;
    occurred_at_value := new.occurred_at;
  elsif tg_table_name = 'disputes' then
    select acquisition.affiliate_id, acquisition.product_id into affiliate_id_value, product_id_value
    from public.transactions as transaction join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
    where transaction.id = new.transaction_id;
    select public.stripe_epoch_timestamp(provider.payload -> 'created') into occurred_at_value
    from public.provider_events as provider where provider.id = new.provider_event_id;
  elsif tg_table_name = 'commercial_dispute_balance_evidence' then
    select acquisition.affiliate_id, acquisition.product_id into affiliate_id_value, product_id_value
    from public.transactions as transaction join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
    where transaction.id = new.transaction_id;
    occurred_at_value := new.occurred_at;
  elsif tg_table_name = 'subscriptions' then
    select acquisition.affiliate_id, acquisition.product_id into affiliate_id_value, product_id_value
    from public.acquisitions as acquisition where acquisition.id = new.acquisition_id;
    occurred_at_value := now();
  end if;
  perform public.queue_commercial_metric(affiliate_id_value, product_id_value, occurred_at_value);
  return new;
end;
$$;

create trigger clicks_enqueue_commercial_metric after insert on public.clicks
  for each row execute function public.enqueue_commercial_metric_from_fact();
create trigger events_enqueue_commercial_metric after insert on public.events
  for each row execute function public.enqueue_commercial_metric_from_fact();
create trigger transactions_enqueue_commercial_metric after insert on public.transactions
  for each row execute function public.enqueue_commercial_metric_from_fact();
create trigger refunds_enqueue_commercial_metric after insert on public.refunds
  for each row execute function public.enqueue_commercial_metric_from_fact();
create trigger disputes_enqueue_commercial_metric after insert on public.disputes
  for each row execute function public.enqueue_commercial_metric_from_fact();
create trigger commercial_dispute_balance_evidence_enqueue_metric
  after insert on public.commercial_dispute_balance_evidence
  for each row execute function public.enqueue_commercial_metric_from_fact();
create trigger subscriptions_enqueue_commercial_metric after insert or update on public.subscriptions
  for each row execute function public.enqueue_commercial_metric_from_fact();

create or replace function public.claim_commercial_metric_refreshes(
  p_worker text, p_limit integer default 25, p_lease_seconds integer default 120
)
returns table (refresh_id uuid, affiliate_id uuid, product_id uuid, metric_date date,
  claim_token uuid, attempt_count integer)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  p_worker := trim(coalesce(p_worker, ''));
  if p_worker !~ '^[a-z][a-z0-9_-]{1,63}$' or p_limit not between 1 and 100
     or p_lease_seconds not between 15 and 900 then
    raise exception 'metrics worker claim bounds are invalid' using errcode = '22023';
  end if;
  return query
  with candidates as (
    select queue.id from public.commercial_metric_refresh_queue as queue
    where (queue.status = 'pending' and queue.next_attempt_at <= now())
       or (queue.status = 'processing' and queue.lease_expires_at <= now())
    order by queue.metric_date, queue.id for update skip locked limit p_limit
  ), claimed as (
    update public.commercial_metric_refresh_queue as queue set status = 'processing',
      attempt_count = queue.attempt_count + 1, processing_error = null,
      claimed_by = p_worker, claim_token = gen_random_uuid(), claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
    from candidates where queue.id = candidates.id returning queue.*
  )
  select claimed.id, claimed.affiliate_id, claimed.product_id, claimed.metric_date,
    claimed.claim_token, claimed.attempt_count from claimed order by claimed.metric_date, claimed.id;
end;
$$;

create or replace function public.process_commercial_metric_refresh(
  p_refresh_id uuid, p_claim_token uuid
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  queue_record public.commercial_metric_refresh_queue%rowtype;
  timezone_value text;
  currency_values text[];
  currency_value text;
  inserted_count integer;
begin
  select * into queue_record from public.commercial_metric_refresh_queue
  where id = p_refresh_id for update;
  if queue_record.id is null or queue_record.status <> 'processing'
     or queue_record.claim_token is distinct from p_claim_token
     or queue_record.lease_expires_at <= now() then
    raise exception 'metric refresh claim is unavailable' using errcode = 'P0002';
  end if;
  select affiliate.reporting_timezone into timezone_value from public.affiliates as affiliate
  where affiliate.id = queue_record.affiliate_id;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = timezone_value) then
    raise exception 'affiliate reporting timezone is invalid' using errcode = 'P0001';
  end if;
  select array_agg(distinct agreement.payout_currency order by agreement.payout_currency)
  into currency_values
  from public.agreements as agreement
  where agreement.affiliate_id = queue_record.affiliate_id
    and agreement.product_id = queue_record.product_id and agreement.status = 'active'
    and agreement.starts_at < ((queue_record.metric_date + 1)::timestamp at time zone timezone_value)
    and (agreement.ends_at is null or agreement.ends_at >= (queue_record.metric_date::timestamp at time zone timezone_value))
    and exists (
      select 1 from public.documents as document where document.agreement_id = agreement.id
        and document.status in ('signed', 'active')
        and document.signed_by_partner_at is not null and document.signed_by_kissmyapps_at is not null
        and document.terminated_at is null
    );
  if cardinality(coalesce(currency_values, '{}'::text[])) <> 1 then
    raise exception 'metrics require one signed agreement payout currency' using errcode = 'P0001';
  end if;
  currency_value := currency_values[1];

  delete from public.affiliate_daily_metrics as metric
  where metric.affiliate_id = queue_record.affiliate_id
    and metric.product_id = queue_record.product_id
    and metric.metric_date = queue_record.metric_date;

  with link_keys as (
    select distinct click.affiliate_link_id
    from public.clicks as click
    where click.affiliate_id = queue_record.affiliate_id
      and click.product_id = queue_record.product_id
      and (click.occurred_at at time zone timezone_value)::date = queue_record.metric_date
    union
    select distinct click.affiliate_link_id
    from public.commercial_source_applications as application
    join public.transactions as transaction on transaction.id = application.transaction_id
    join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
    join public.clicks as click on click.id = acquisition.click_record_id
    where application.affiliate_id = queue_record.affiliate_id
      and application.product_id = queue_record.product_id
      and (application.occurred_at at time zone timezone_value)::date = queue_record.metric_date
  )
  insert into public.affiliate_daily_metrics (
    affiliate_id, product_id, affiliate_link_id, metric_date, source_id, campaign_id,
    funnel_id, sub1, sub2, sub3, clicks, visitors, funnel_starts, payment_views,
    app_store_clicks, leads, trials, installs, purchases, renewals, cancellations,
    activations, refunds, disputes, gross_collected_minor, eligible_revenue_minor,
    earnings_minor, currency, completeness, reconciliation_stage, source_freshness,
    calculated_at
  )
  select
    link.affiliate_id, link.product_id, link.id, queue_record.metric_date,
    link.source_id, link.campaign_id, link.funnel_id, link.sub1, link.sub2, link.sub3,
    (select count(*) from public.clicks as click where click.affiliate_link_id = link.id
      and not click.is_bot and (click.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select count(distinct coalesce(click.session_id_hash, click.id::text)) from public.clicks as click
      where click.affiliate_link_id = link.id and not click.is_bot
        and (click.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select count(*) from public.events as event join public.acquisitions as acquisition on acquisition.id = event.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and event.event_name = 'funnel_started'
        and (event.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select count(*) from public.events as event join public.acquisitions as acquisition on acquisition.id = event.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and event.event_name = 'payment_viewed'
        and (event.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select count(*) from public.events as event join public.acquisitions as acquisition on acquisition.id = event.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and event.event_name = 'app_store_clicked'
        and (event.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select count(*) from public.conversions as conversion join public.commission_rules as rule on rule.id = conversion.commission_rule_id
      join public.acquisitions as acquisition on acquisition.id = conversion.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and conversion.qualified and rule.model = 'cpl'
        and (conversion.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select count(*) from public.events as event join public.acquisitions as acquisition on acquisition.id = event.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and event.event_name = 'subscription.trialing'
        and (event.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    0,
    (select count(*) from public.transactions as transaction join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and transaction.kind = 'first_purchase'
        and (transaction.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select count(*) from public.transactions as transaction join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and transaction.kind = 'renewal'
        and (transaction.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select count(*) from public.events as event join public.acquisitions as acquisition on acquisition.id = event.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and event.event_name = 'subscription.cancelled'
        and (event.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select count(*) from public.events as event join public.acquisitions as acquisition on acquisition.id = event.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and event.event_name = 'subscription.active'
        and (event.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select count(*) from public.refunds as refund join public.transactions as transaction on transaction.id = refund.transaction_id
      join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and (refund.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select count(*) from public.disputes as dispute
      join public.provider_events as provider on provider.id = dispute.provider_event_id
      join public.transactions as transaction on transaction.id = dispute.transaction_id
      join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and provider.event_type = 'charge.dispute.created'
        and (public.stripe_epoch_timestamp(provider.payload -> 'created')
          at time zone timezone_value)::date = queue_record.metric_date),
    (select coalesce(sum(transaction.gross_minor), 0) from public.transactions as transaction
      join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and transaction.currency = currency_value
        and (transaction.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select coalesce(sum(fact.amount_minor), 0) from (
      select transaction.eligible_net_minor as amount_minor, transaction.occurred_at, acquisition.click_record_id
      from public.transactions as transaction join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
      where transaction.settled_currency = currency_value
      union all
      select refund.balance_impact_minor, refund.occurred_at, acquisition.click_record_id
      from public.refunds as refund join public.transactions as transaction on transaction.id = refund.transaction_id
      join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id where refund.currency = currency_value
      union all
      select evidence.balance_net_minor, evidence.occurred_at, acquisition.click_record_id
      from public.commercial_dispute_balance_evidence as evidence
      join public.transactions as transaction on transaction.id = evidence.transaction_id
      join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id where evidence.currency = currency_value
    ) as fact join public.clicks as click on click.id = fact.click_record_id
      where click.affiliate_link_id = link.id
        and (fact.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    (select coalesce(sum(application.applied_amount_minor), 0)
      from public.commercial_source_applications as application
      join public.transactions as transaction on transaction.id = application.transaction_id
      join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and application.currency = currency_value
        and (application.occurred_at at time zone timezone_value)::date = queue_record.metric_date),
    currency_value, 'partial', 'preliminary',
    jsonb_build_object('click_tracker', 'complete', 'first_party', 'complete',
      'stripe', 'complete', 'singular', 'unavailable'), now()
  from public.affiliate_links as link join link_keys on link_keys.affiliate_link_id = link.id;
  get diagnostics inserted_count = row_count;

  if queue_record.metric_date = (now() at time zone timezone_value)::date then
    insert into public.affiliate_daily_metrics (
      affiliate_id, product_id, metric_date, active_subscriptions,
      is_subscription_snapshot, currency, completeness, reconciliation_stage,
      source_freshness, calculated_at
    ) values (
      queue_record.affiliate_id, queue_record.product_id, queue_record.metric_date,
      (select count(*) from public.subscriptions as subscription
        join public.acquisitions as acquisition on acquisition.id = subscription.acquisition_id
        where acquisition.affiliate_id = queue_record.affiliate_id
          and acquisition.product_id = queue_record.product_id
          and subscription.status in ('trialing', 'active')),
      true, currency_value, 'partial', 'preliminary',
      jsonb_build_object('stripe', 'complete', 'snapshot_at', now()), now()
    );
    inserted_count := inserted_count + 1;
  end if;

  update public.commercial_metric_refresh_queue set status = 'processed', processing_error = null,
    claimed_by = null, claim_token = null, claimed_at = null, lease_expires_at = null,
    processed_at = now(), updated_at = now() where id = queue_record.id;
  return jsonb_build_object('status', 'processed', 'rows', inserted_count,
    'completeness', 'partial', 'singular', 'unavailable');
end;
$$;

create or replace function public.fail_commercial_metric_refresh(
  p_refresh_id uuid, p_claim_token uuid, p_error_code text,
  p_retry_delay_seconds integer default 60, p_terminal boolean default false
)
returns public.processing_status language plpgsql volatile security definer set search_path = ''
as $$
declare resulting_status public.processing_status;
begin
  if trim(coalesce(p_error_code, '')) !~ '^[a-z][a-z0-9_.-]{0,99}$'
     or p_retry_delay_seconds not between 0 and 86400 then
    raise exception 'metrics retry input is invalid' using errcode = '22023';
  end if;
  update public.commercial_metric_refresh_queue set
    status = case when p_terminal then 'failed'::public.processing_status else 'pending'::public.processing_status end,
    processing_error = trim(p_error_code), claimed_by = null, claim_token = null,
    claimed_at = null, lease_expires_at = null,
    next_attempt_at = case when p_terminal then next_attempt_at else now() + make_interval(secs => p_retry_delay_seconds) end,
    updated_at = now()
  where id = p_refresh_id and status = 'processing' and claim_token = p_claim_token
    and lease_expires_at > now() returning status into resulting_status;
  if resulting_status is null then raise exception 'metric refresh claim is unavailable' using errcode = 'P0002'; end if;
  return resulting_status;
end;
$$;

create or replace function public.queue_commercial_reconciliation(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare starts_value timestamptz; ends_value timestamptz; currency_value text;
  key_value text; run_record public.reconciliation_runs%rowtype;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& array['starts_at','ends_at','currency','idempotency_key'])
     or exists (select 1 from jsonb_object_keys(p_input) as key where key not in ('starts_at','ends_at','currency','idempotency_key')) then
    raise exception 'reconciliation input is invalid' using errcode = '22023';
  end if;
  begin starts_value := (p_input ->> 'starts_at')::timestamptz; ends_value := (p_input ->> 'ends_at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'reconciliation window is invalid' using errcode = '22023'; end;
  currency_value := upper(trim(p_input ->> 'currency')); key_value := trim(p_input ->> 'idempotency_key');
  if ends_value <= starts_value or ends_value > now() or currency_value !~ '^[A-Z]{3}$'
     or key_value !~ '^[A-Za-z0-9:_-]{16,160}$' then
    raise exception 'reconciliation values are invalid' using errcode = '22023';
  end if;
  insert into public.reconciliation_runs (provider, starts_at, ends_at, currency, idempotency_key, scheduled_for)
  values ('stripe', starts_value, ends_value, currency_value, key_value, now())
  on conflict (idempotency_key) do nothing;
  select * into run_record from public.reconciliation_runs where idempotency_key = key_value;
  if run_record.starts_at <> starts_value or run_record.ends_at <> ends_value or run_record.currency <> currency_value then
    raise exception 'reconciliation idempotency key conflicts with another window' using errcode = '23505';
  end if;
  insert into public.commercial_reconciliation_processing (reconciliation_run_id)
  values (run_record.id) on conflict do nothing;
  return jsonb_build_object('reconciliation_run_id', run_record.id, 'status', run_record.status);
end;
$$;

create or replace function public.record_commercial_reconciliation_evidence(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare run_id_value uuid; total_value bigint; digest_value text;
  evidence_record public.commercial_reconciliation_evidence%rowtype;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& array['reconciliation_run_id','provider_total_minor','evidence_sha256'])
     or exists (select 1 from jsonb_object_keys(p_input) as key where key not in ('reconciliation_run_id','provider_total_minor','evidence_sha256')) then
    raise exception 'reconciliation evidence input is invalid' using errcode = '22023';
  end if;
  begin run_id_value := (p_input ->> 'reconciliation_run_id')::uuid;
    total_value := (p_input ->> 'provider_total_minor')::bigint;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'reconciliation evidence values are invalid' using errcode = '22023'; end;
  digest_value := lower(trim(p_input ->> 'evidence_sha256'));
  if digest_value !~ '^[a-f0-9]{64}$' then raise exception 'reconciliation evidence digest is invalid' using errcode = '22023'; end if;
  if not exists (select 1 from public.reconciliation_runs where id = run_id_value and status = 'queued') then
    raise exception 'queued reconciliation run is unavailable' using errcode = 'P0002';
  end if;
  insert into public.commercial_reconciliation_evidence (reconciliation_run_id, provider_total_minor, evidence_sha256)
  values (run_id_value, total_value, digest_value) on conflict (reconciliation_run_id) do nothing;
  select * into evidence_record from public.commercial_reconciliation_evidence where reconciliation_run_id = run_id_value;
  if evidence_record.provider_total_minor <> total_value or evidence_record.evidence_sha256 <> digest_value then
    raise exception 'reconciliation evidence conflicts with the immutable record' using errcode = '23505';
  end if;
  return to_jsonb(evidence_record);
end;
$$;

create or replace function public.claim_commercial_reconciliations(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 180
)
returns table (reconciliation_run_id uuid, claim_token uuid, attempt_count integer)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  p_worker := trim(coalesce(p_worker, ''));
  if p_worker !~ '^[a-z][a-z0-9_-]{1,63}$' or p_limit not between 1 and 50
     or p_lease_seconds not between 15 and 900 then
    raise exception 'reconciliation worker claim bounds are invalid' using errcode = '22023';
  end if;
  return query
  with candidates as (
    select processing.reconciliation_run_id
    from public.commercial_reconciliation_processing as processing
    join public.reconciliation_runs as run on run.id = processing.reconciliation_run_id
    join public.commercial_reconciliation_evidence as evidence on evidence.reconciliation_run_id = run.id
    where run.status in ('queued','running') and run.scheduled_for <= now()
      and ((processing.status = 'pending' and processing.next_attempt_at <= now())
        or (processing.status = 'processing' and processing.lease_expires_at <= now()))
    order by run.starts_at, run.id for update of processing skip locked limit p_limit
  ), claimed as (
    update public.commercial_reconciliation_processing as processing set status = 'processing',
      attempt_count = processing.attempt_count + 1, processing_error = null,
      claimed_by = p_worker, claim_token = gen_random_uuid(), claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
    from candidates where processing.reconciliation_run_id = candidates.reconciliation_run_id
    returning processing.*
  ), started as (
    update public.reconciliation_runs as run set status = 'running', started_at = coalesce(run.started_at, now()), updated_at = now()
    from claimed where run.id = claimed.reconciliation_run_id and run.status = 'queued'
    returning run.id
  )
  select claimed.reconciliation_run_id, claimed.claim_token, claimed.attempt_count
  from claimed order by claimed.reconciliation_run_id;
end;
$$;

create or replace function public.process_commercial_reconciliation(
  p_reconciliation_run_id uuid, p_claim_token uuid
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare run_record public.reconciliation_runs%rowtype;
  processing_record public.commercial_reconciliation_processing%rowtype;
  evidence_record public.commercial_reconciliation_evidence%rowtype;
  internal_total bigint; difference_value bigint; exception_total integer;
begin
  select * into processing_record from public.commercial_reconciliation_processing
  where reconciliation_run_id = p_reconciliation_run_id for update;
  select * into run_record from public.reconciliation_runs where id = p_reconciliation_run_id for update;
  select * into evidence_record from public.commercial_reconciliation_evidence where reconciliation_run_id = p_reconciliation_run_id;
  if processing_record.status <> 'processing' or processing_record.claim_token is distinct from p_claim_token
     or processing_record.lease_expires_at <= now() or run_record.status <> 'running'
     or evidence_record.reconciliation_run_id is null then
    raise exception 'reconciliation claim or evidence is unavailable' using errcode = 'P0002';
  end if;
  if run_record.ends_at > now() then raise exception 'reconciliation window has not ended' using errcode = 'P0001'; end if;
  if public.commercial_has_unprocessed_facts(run_record.starts_at, run_record.ends_at) then
    raise exception 'commercial facts in the reconciliation window are not fully processed'
      using errcode = 'P0001';
  end if;

  select coalesce(sum(fact.amount_minor), 0)::bigint into internal_total from (
    select transaction.eligible_net_minor as amount_minor from public.transactions as transaction
    where transaction.occurred_at >= run_record.starts_at and transaction.occurred_at < run_record.ends_at
      and transaction.settled_currency = run_record.currency
    union all
    select refund.balance_impact_minor from public.refunds as refund
    where refund.occurred_at >= run_record.starts_at and refund.occurred_at < run_record.ends_at
      and refund.currency = run_record.currency
    union all
    select evidence.balance_net_minor from public.commercial_dispute_balance_evidence as evidence
    where evidence.occurred_at >= run_record.starts_at and evidence.occurred_at < run_record.ends_at
      and evidence.currency = run_record.currency
  ) as fact;
  difference_value := evidence_record.provider_total_minor - internal_total;
  if difference_value <> 0 then
    insert into public.reconciliation_exceptions (
      reconciliation_run_id, source_key, category, amount_minor, currency, summary
    ) values (
      run_record.id, 'window-total', 'provider_internal_total_mismatch', difference_value,
      run_record.currency, 'Provider evidence does not match the canonical internal money ledger.'
    ) on conflict (reconciliation_run_id, source_key) do nothing;
  end if;
  select count(*)::integer into exception_total from public.reconciliation_exceptions
  where reconciliation_run_id = run_record.id and status in ('open','investigating');
  update public.reconciliation_runs set
    status = case when difference_value = 0 and exception_total = 0
      then 'passed'::public.reconciliation_status else 'failed'::public.reconciliation_status end,
    provider_total_minor = evidence_record.provider_total_minor,
    internal_total_minor = internal_total, unexplained_difference_minor = difference_value,
    exception_count = exception_total,
    details = jsonb_build_object('evidence_sha256', evidence_record.evidence_sha256,
      'calculation', 'canonical_transactions_plus_refunds_plus_disputes'),
    completed_at = now(), updated_at = now()
  where id = run_record.id returning * into run_record;
  update public.commercial_reconciliation_processing set status = 'processed',
    processing_error = null, claimed_by = null, claim_token = null, claimed_at = null,
    lease_expires_at = null, processed_at = now(), updated_at = now()
  where reconciliation_run_id = run_record.id;
  return jsonb_build_object('status', run_record.status, 'provider_total_minor', run_record.provider_total_minor,
    'internal_total_minor', run_record.internal_total_minor,
    'unexplained_difference_minor', run_record.unexplained_difference_minor,
    'exception_count', run_record.exception_count);
end;
$$;

create or replace function public.fail_commercial_reconciliation(
  p_reconciliation_run_id uuid, p_claim_token uuid, p_error_code text,
  p_retry_delay_seconds integer default 60, p_terminal boolean default false
)
returns public.processing_status language plpgsql volatile security definer set search_path = ''
as $$
declare resulting_status public.processing_status;
begin
  if trim(coalesce(p_error_code, '')) !~ '^[a-z][a-z0-9_.-]{0,99}$'
     or p_retry_delay_seconds not between 0 and 86400 then
    raise exception 'reconciliation retry input is invalid' using errcode = '22023';
  end if;
  update public.commercial_reconciliation_processing set
    status = case when p_terminal then 'failed'::public.processing_status else 'pending'::public.processing_status end,
    processing_error = trim(p_error_code), claimed_by = null, claim_token = null,
    claimed_at = null, lease_expires_at = null,
    next_attempt_at = case when p_terminal then next_attempt_at else now() + make_interval(secs => p_retry_delay_seconds) end,
    updated_at = now()
  where reconciliation_run_id = p_reconciliation_run_id and status = 'processing'
    and claim_token = p_claim_token and lease_expires_at > now()
  returning status into resulting_status;
  if resulting_status is null then raise exception 'reconciliation claim is unavailable' using errcode = 'P0002'; end if;
  if p_terminal then
    update public.reconciliation_runs set status = 'failed', completed_at = now(), updated_at = now(),
      details = details || jsonb_build_object('worker_error_code', trim(p_error_code))
    where id = p_reconciliation_run_id and status = 'running';
  end if;
  return resulting_status;
end;
$$;

create or replace function public.prevent_payout_period_overlap()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.payout_periods as period where period.id <> new.id
    and tstzrange(period.starts_at, period.ends_at, '[)') && tstzrange(new.starts_at, new.ends_at, '[)')) then
    raise exception 'payout periods cannot overlap' using errcode = '23P01';
  end if;
  return new;
end;
$$;
create trigger payout_periods_prevent_overlap before insert or update on public.payout_periods
  for each row execute function public.prevent_payout_period_overlap();

create or replace function public.create_admin_payout_period(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare starts_value timestamptz; ends_value timestamptz; review_value timestamptz;
  due_value timestamptz; stored public.payout_periods%rowtype;
begin
  perform public.assert_admin_password(array['owner','finance']::text[], 'create payout periods');
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& array['starts_at','ends_at','review_starts_at','payout_due_at'])
     or exists (select 1 from jsonb_object_keys(p_input) as key where key not in ('starts_at','ends_at','review_starts_at','payout_due_at')) then
    raise exception 'payout period input is invalid' using errcode = '22023';
  end if;
  begin starts_value := (p_input ->> 'starts_at')::timestamptz; ends_value := (p_input ->> 'ends_at')::timestamptz;
    review_value := (p_input ->> 'review_starts_at')::timestamptz; due_value := (p_input ->> 'payout_due_at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'payout period timestamps are invalid' using errcode = '22023'; end;
  insert into public.payout_periods (starts_at, ends_at, review_starts_at, payout_due_at)
  values (starts_value, ends_value, review_value, due_value) returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace function public.advance_admin_payout_period(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare period_id_value uuid; status_value text; stored public.payout_periods%rowtype;
begin
  perform public.assert_admin_password(array['owner','finance']::text[], 'advance payout periods');
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& array['payout_period_id','status'])
     or exists (select 1 from jsonb_object_keys(p_input) as key where key not in ('payout_period_id','status')) then
    raise exception 'payout period transition input is invalid' using errcode = '22023';
  end if;
  begin period_id_value := (p_input ->> 'payout_period_id')::uuid;
  exception when invalid_text_representation then raise exception 'payout_period_id is invalid' using errcode = '22023'; end;
  status_value := trim(p_input ->> 'status');
  if status_value not in ('review','closed') then raise exception 'payout period status is invalid' using errcode = '22023'; end if;
  select * into stored from public.payout_periods where id = period_id_value for update;
  if stored.id is null then raise exception 'payout period is unavailable' using errcode = 'P0002'; end if;
  if public.commercial_has_unprocessed_facts(stored.starts_at, stored.ends_at) then
    raise exception 'payout period has unprocessed commercial facts' using errcode = 'P0001';
  end if;
  if status_value = 'closed' and exists (
    select currency from (
      select transaction.settled_currency as currency from public.transactions as transaction
      where transaction.occurred_at >= stored.starts_at and transaction.occurred_at < stored.ends_at
      union select refund.currency from public.refunds as refund
      where refund.occurred_at >= stored.starts_at and refund.occurred_at < stored.ends_at
      union select evidence.currency from public.commercial_dispute_balance_evidence as evidence
      where evidence.occurred_at >= stored.starts_at and evidence.occurred_at < stored.ends_at
    ) as money where not exists (
      select 1 from public.reconciliation_runs as run where run.provider = 'stripe'
        and run.starts_at = stored.starts_at and run.ends_at = stored.ends_at
        and run.currency = money.currency and run.status = 'passed'
        and run.unexplained_difference_minor = 0 and run.exception_count = 0
    )
  ) then raise exception 'payout period requires passed exact-window reconciliation for every currency' using errcode = 'P0001'; end if;
  update public.payout_periods set status = status_value::public.period_status,
    closed_at = case when status_value = 'closed' then now() else null end
  where id = stored.id returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace function public.prepare_admin_payout_statements(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare period_id_value uuid; period_record public.payout_periods%rowtype;
  ledger record; payout_record public.payouts%rowtype; prepared_count integer := 0;
begin
  perform public.assert_admin_password(array['owner','finance']::text[], 'prepare payout statements');
  if p_input is null or jsonb_typeof(p_input) <> 'object' or not (p_input ? 'payout_period_id')
     or exists (select 1 from jsonb_object_keys(p_input) as key where key <> 'payout_period_id') then
    raise exception 'statement preparation input is invalid' using errcode = '22023';
  end if;
  begin period_id_value := (p_input ->> 'payout_period_id')::uuid;
  exception when invalid_text_representation then raise exception 'payout_period_id is invalid' using errcode = '22023'; end;
  select * into period_record from public.payout_periods where id = period_id_value for update;
  if period_record.status <> 'closed' then raise exception 'statements require a closed payout period' using errcode = 'P0001'; end if;
  if exists (select 1 from public.commission_entries where payout_period_id = period_record.id
    group by affiliate_id, product_id having count(distinct currency) <> 1) then
    raise exception 'statement preparation cannot combine currencies' using errcode = 'P0001';
  end if;
  for ledger in
    select entry.affiliate_id, entry.product_id, entry.currency,
      coalesce(sum(entry.amount_minor) filter (where entry.entry_type = 'commission'),0)::bigint as earnings,
      coalesce(sum(entry.amount_minor) filter (where entry.entry_type not in ('commission','carry_forward')),0)::bigint as adjustments,
      coalesce(sum(entry.amount_minor) filter (where entry.entry_type = 'carry_forward'),0)::bigint as carry_in,
      coalesce(sum(transaction.eligible_net_minor),0)::bigint as eligible_net
    from public.commission_entries as entry
    left join public.transactions as transaction on transaction.id = entry.transaction_id and entry.entry_type = 'commission'
    where entry.payout_period_id = period_record.id
    group by entry.affiliate_id, entry.product_id, entry.currency
  loop
    insert into public.payouts (affiliate_id, product_id, payout_period_id, currency)
    values (ledger.affiliate_id, ledger.product_id, period_record.id, ledger.currency)
    on conflict (affiliate_id, product_id, payout_period_id) do nothing;
    select * into payout_record from public.payouts where affiliate_id = ledger.affiliate_id
      and product_id = ledger.product_id and payout_period_id = period_record.id for update;
    if payout_record.calculation_finalized_at is not null then
      raise exception 'a finalized payout statement cannot be recalculated' using errcode = 'P0001';
    end if;
    insert into public.payout_agreement_snapshots (
      payout_id, agreement_id, agreement_version, model, attribution_window_days,
      payout_frequency_days, payout_currency, minimum_payout_minor, rules_snapshot
    )
    select payout_record.id, agreement.id, agreement.version, agreement.model,
      agreement.attribution_window_days, agreement.payout_frequency_days,
      agreement.payout_currency, agreement.minimum_payout_minor,
      coalesce((select jsonb_agg(jsonb_build_object(
        'name', rule.name, 'version', rule.version, 'status', rule.status,
        'model', rule.model, 'trigger_event', rule.trigger_event,
        'fixed_amount_minor', rule.fixed_amount_minor, 'rate_basis_points', rule.rate_basis_points,
        'currency', rule.currency, 'validation_window_hours', rule.validation_window_hours
      ) order by rule.name, rule.version) from public.commission_rules as rule
        where rule.agreement_id = agreement.id), '[]'::jsonb)
    from public.agreements as agreement
    where agreement.id in (select distinct entry.agreement_id from public.commission_entries as entry
      where entry.affiliate_id = ledger.affiliate_id and entry.product_id = ledger.product_id
        and entry.payout_period_id = period_record.id)
    on conflict (payout_id, agreement_id) do nothing;
    update public.payouts set eligible_net_minor = ledger.eligible_net,
      earnings_minor = ledger.earnings, adjustments_minor = ledger.adjustments,
      carry_in_minor = ledger.carry_in,
      carry_out_minor = case when ledger.earnings + ledger.adjustments + ledger.carry_in < 0
        then ledger.earnings + ledger.adjustments + ledger.carry_in else 0 end,
      final_payout_minor = greatest(0::bigint, ledger.earnings + ledger.adjustments + ledger.carry_in),
      statement_number = coalesce(statement_number,
        'KMA-' || to_char(period_record.ends_at at time zone 'UTC', 'YYYYMMDD') || '-' || upper(substr(payout_record.id::text,1,8))),
      updated_at = now()
    where id = payout_record.id;
    prepared_count := prepared_count + 1;
  end loop;
  return jsonb_build_object('status', 'prepared', 'payout_period_id', period_record.id,
    'statement_count', prepared_count, 'external_transfer', false);
end;
$$;

alter table public.commercial_fact_processing enable row level security;
alter table public.commercial_transaction_states enable row level security;
alter table public.commercial_dispute_balance_evidence enable row level security;
alter table public.commercial_source_applications enable row level security;
alter table public.commercial_metric_refresh_queue enable row level security;
alter table public.commercial_reconciliation_evidence enable row level security;
alter table public.commercial_reconciliation_processing enable row level security;

revoke all on public.commercial_fact_processing, public.commercial_transaction_states,
  public.commercial_dispute_balance_evidence,
  public.commercial_source_applications, public.commercial_metric_refresh_queue,
  public.commercial_reconciliation_evidence, public.commercial_reconciliation_processing
  from public, anon, authenticated, service_role;

revoke all on function public.enqueue_commercial_fact() from public, anon, authenticated, service_role;
revoke all on function public.claim_commercial_facts(text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.commercial_commission_amount(public.commission_model,bigint,integer,bigint) from public, anon, authenticated, service_role;
revoke all on function public.commercial_posting_payout_period_id(timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.process_commercial_fact(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.fail_commercial_fact(uuid,uuid,text,integer,boolean) from public, anon, authenticated, service_role;
revoke all on function public.commercial_has_unprocessed_facts(timestamptz,timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.queue_commercial_metric(uuid,uuid,timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.enqueue_commercial_metric_from_fact() from public, anon, authenticated, service_role;
revoke all on function public.claim_commercial_metric_refreshes(text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.process_commercial_metric_refresh(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.fail_commercial_metric_refresh(uuid,uuid,text,integer,boolean) from public, anon, authenticated, service_role;
revoke all on function public.queue_commercial_reconciliation(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.record_commercial_reconciliation_evidence(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.claim_commercial_reconciliations(text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.process_commercial_reconciliation(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.fail_commercial_reconciliation(uuid,uuid,text,integer,boolean) from public, anon, authenticated, service_role;
revoke all on function public.prevent_payout_period_overlap() from public, anon, authenticated, service_role;
revoke all on function public.create_admin_payout_period(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.advance_admin_payout_period(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.prepare_admin_payout_statements(jsonb) from public, anon, authenticated, service_role;

grant execute on function public.claim_commercial_facts(text,integer,integer) to service_role;
grant execute on function public.process_commercial_fact(uuid,uuid) to service_role;
grant execute on function public.fail_commercial_fact(uuid,uuid,text,integer,boolean) to service_role;
grant execute on function public.claim_commercial_metric_refreshes(text,integer,integer) to service_role;
grant execute on function public.process_commercial_metric_refresh(uuid,uuid) to service_role;
grant execute on function public.fail_commercial_metric_refresh(uuid,uuid,text,integer,boolean) to service_role;
grant execute on function public.queue_commercial_reconciliation(jsonb) to service_role;
grant execute on function public.record_commercial_reconciliation_evidence(jsonb) to service_role;
grant execute on function public.claim_commercial_reconciliations(text,integer,integer) to service_role;
grant execute on function public.process_commercial_reconciliation(uuid,uuid) to service_role;
grant execute on function public.fail_commercial_reconciliation(uuid,uuid,text,integer,boolean) to service_role;
grant execute on function public.create_admin_payout_period(jsonb) to authenticated;
grant execute on function public.advance_admin_payout_period(jsonb) to authenticated;
grant execute on function public.prepare_admin_payout_statements(jsonb) to authenticated;

comment on table public.commercial_source_applications is
  'Immutable explanation of each exact canonical money fact applied to partner commission.';
comment on table public.commercial_dispute_balance_evidence is
  'One immutable Stripe dispute balance transaction per global Stripe balance transaction ID; lifecycle snapshots never duplicate money.';
comment on table public.commercial_reconciliation_evidence is
  'Immutable independently supplied provider total and digest; no reconciliation passes without it.';
comment on function public.prepare_admin_payout_statements(jsonb) is
  'Prepares internal statement rows only. It never approves, schedules, or transfers money.';
