begin;

-- Aggregate-only operational visibility for the protected Admin Data Health
-- workspace. No provider payloads, row identifiers, claim metadata, errors,
-- destinations, customer data, or monetary values cross this boundary.

create index if not exists commercial_reconciliation_processing_ready_idx
  on public.commercial_reconciliation_processing (status, next_attempt_at, updated_at);

create index if not exists reconciliation_runs_status_scheduled_idx
  on public.reconciliation_runs (status, scheduled_for desc, id desc);

create or replace function public.get_admin_data_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  generated_at_value timestamptz := statement_timestamp();
  setting_record public.platform_settings%rowtype;
  catalog_record record;
  click_provider record;
  funnel_provider record;
  stripe_provider record;
  singular_provider record;
  stripe_queue record;
  fact_queue record;
  metric_queue record;
  reconciliation_queue record;
  metric_record record;
  reconciliation_record record;
  recent_runs_value jsonb;
  click_status text;
  funnel_status text;
  stripe_status text;
  singular_status text;
  stripe_queue_status text;
  fact_queue_status text;
  metric_queue_status text;
  reconciliation_queue_status text;
  overall_status_value text;
  has_operational_evidence boolean;
  has_attention boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(
    array['owner', 'operations', 'finance', 'analyst']::text[]
  ) then
    raise exception 'admin role cannot view data health' using errcode = '42501';
  end if;

  select * into setting_record
  from public.platform_settings as setting
  where setting.singleton;

  select
    (select count(*)::bigint
       from public.products as product
      where product.status = 'active') as active_product_count,
    (select count(*)::bigint
       from public.funnels as funnel
      where funnel.status = 'live') as live_funnel_count,
    (select count(*)::bigint
       from public.affiliate_links as link
      where link.status = 'active') as active_link_count,
    (select count(*)::bigint
       from public.billing_offers as offer
      where offer.status = 'active'
        and offer.billing_mode = 'subscription'
        and offer.stripe_price_id is not null
        and offer.currency is not null
        and offer.unit_amount_minor is not null
        and offer.success_url_template is not null
        and offer.cancel_url is not null
        and position('{CHECKOUT_SESSION_ID}' in offer.success_url_template) > 0
        and public.is_production_https_url(offer.success_url_template, true)
        and public.is_production_https_url(offer.cancel_url, true)
        and offer.stripe_livemode_verified_at is not null
        and offer.verified_stripe_price_id is not distinct from offer.stripe_price_id
        and offer.verified_currency is not distinct from offer.currency
        and offer.verified_unit_amount_minor is not distinct from offer.unit_amount_minor
        and offer.verified_billing_mode = offer.billing_mode) as verified_active_offer_count,
    (select count(*)::bigint
       from public.agreements as agreement
      where agreement.status = 'active'
        and public.agreement_is_launch_ready(agreement.id, generated_at_value))
      as launch_ready_agreement_count
  into catalog_record;

  select
    count(*)::bigint as observed_count,
    count(*) filter (where not click.is_bot)::bigint as verified_count,
    count(*) filter (where click.is_bot)::bigint as failed_count,
    max(click.occurred_at) as last_observed_at
  into click_provider
  from public.clicks as click;

  select
    count(*)::bigint as observed_count,
    count(*)::bigint as verified_count,
    0::bigint as failed_count,
    max(event.occurred_at) as last_observed_at
  into funnel_provider
  from public.events as event
  where event.trust = 'funnel_server';

  select
    count(*)::bigint as observed_count,
    count(*) filter (
      where provider.signature_verified and provider.livemode
    )::bigint as verified_count,
    count(*) filter (
      where not (provider.signature_verified and provider.livemode)
        or processing.status = 'failed'
    )::bigint as failed_count,
    max(provider.received_at) as last_observed_at
  into stripe_provider
  from public.provider_events as provider
  left join public.provider_event_processing as processing
    on processing.provider_event_id = provider.id
  where provider.provider = 'stripe';

  select
    count(*)::bigint as observed_count,
    count(*) filter (where acquisition.status = 'resolved')::bigint as verified_count,
    count(*) filter (where acquisition.status = 'rejected')::bigint as failed_count,
    max(acquisition.created_at) as last_observed_at
  into singular_provider
  from public.acquisitions as acquisition
  where acquisition.attribution_method = 'singular';

  select
    count(*) filter (where processing.status = 'pending')::bigint as pending_count,
    count(*) filter (where processing.status = 'processing')::bigint as processing_count,
    count(*) filter (where processing.status = 'processed')::bigint as processed_count,
    count(*) filter (where processing.status = 'failed')::bigint as failed_count,
    count(*) filter (
      where processing.status = 'pending'
        and processing.processing_error is not null
        and processing.next_attempt_at <= generated_at_value
    )::bigint as retry_ready_count,
    count(*) filter (
      where processing.status = 'processing'
        and processing.lease_expires_at <= generated_at_value
    )::bigint as stale_lease_count,
    min(provider.received_at) filter (where processing.status = 'pending') as oldest_pending_at,
    max(processing.processed_at) filter (where processing.status = 'processed')
      as last_processed_at
  into stripe_queue
  from public.provider_event_processing as processing
  join public.provider_events as provider
    on provider.id = processing.provider_event_id
  where provider.provider = 'stripe'
    and provider.signature_verified
    and provider.livemode;

  select
    count(*) filter (where processing.status = 'pending')::bigint as pending_count,
    count(*) filter (where processing.status = 'processing')::bigint as processing_count,
    count(*) filter (where processing.status = 'processed')::bigint as processed_count,
    count(*) filter (where processing.status = 'failed')::bigint as failed_count,
    count(*) filter (
      where processing.status = 'pending'
        and processing.processing_error is not null
        and processing.next_attempt_at <= generated_at_value
    )::bigint as retry_ready_count,
    count(*) filter (
      where processing.status = 'processing'
        and processing.lease_expires_at <= generated_at_value
    )::bigint as stale_lease_count,
    min(processing.created_at) filter (where processing.status = 'pending')
      as oldest_pending_at,
    max(processing.processed_at) filter (where processing.status = 'processed')
      as last_processed_at
  into fact_queue
  from public.commercial_fact_processing as processing;

  select
    count(*) filter (where processing.status = 'pending')::bigint as pending_count,
    count(*) filter (where processing.status = 'processing')::bigint as processing_count,
    count(*) filter (where processing.status = 'processed')::bigint as processed_count,
    count(*) filter (where processing.status = 'failed')::bigint as failed_count,
    count(*) filter (
      where processing.status = 'pending'
        and processing.processing_error is not null
        and processing.next_attempt_at <= generated_at_value
    )::bigint as retry_ready_count,
    count(*) filter (
      where processing.status = 'processing'
        and processing.lease_expires_at <= generated_at_value
    )::bigint as stale_lease_count,
    min(processing.created_at) filter (where processing.status = 'pending')
      as oldest_pending_at,
    max(processing.processed_at) filter (where processing.status = 'processed')
      as last_processed_at
  into metric_queue
  from public.commercial_metric_refresh_queue as processing;

  select
    count(*) filter (where processing.status = 'pending')::bigint as pending_count,
    count(*) filter (where processing.status = 'processing')::bigint as processing_count,
    count(*) filter (where processing.status = 'processed')::bigint as processed_count,
    count(*) filter (where processing.status = 'failed')::bigint as failed_count,
    count(*) filter (
      where processing.status = 'pending'
        and processing.processing_error is not null
        and processing.next_attempt_at <= generated_at_value
    )::bigint as retry_ready_count,
    count(*) filter (
      where processing.status = 'processing'
        and processing.lease_expires_at <= generated_at_value
    )::bigint as stale_lease_count,
    min(run.scheduled_for) filter (where processing.status = 'pending')
      as oldest_pending_at,
    max(processing.processed_at) filter (where processing.status = 'processed')
      as last_processed_at
  into reconciliation_queue
  from public.commercial_reconciliation_processing as processing
  join public.reconciliation_runs as run
    on run.id = processing.reconciliation_run_id;

  select
    count(*)::bigint as row_count,
    count(*) filter (where metric.completeness = 'partial')::bigint as partial_count,
    count(*) filter (where metric.reconciliation_stage = 'reconciled')::bigint
      as reconciled_count,
    count(*) filter (where metric.reconciliation_stage = 'finalized')::bigint
      as finalized_count,
    max(metric.metric_date) as latest_metric_date,
    max(metric.calculated_at) as latest_calculated_at
  into metric_record
  from public.affiliate_daily_metrics as metric;

  select
    (select count(*)::bigint from public.reconciliation_runs) as run_count,
    (select count(*)::bigint
       from public.reconciliation_exceptions as exception
      where exception.status in ('open', 'investigating')) as open_exception_count
  into reconciliation_record;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'provider', recent.provider,
        'status', recent.status,
        'scheduled_for', recent.scheduled_for,
        'started_at', recent.started_at,
        'completed_at', recent.completed_at,
        'exception_count', recent.exception_count
      ) order by recent.scheduled_for desc, recent.id desc
    ),
    '[]'::jsonb
  )
  into recent_runs_value
  from (
    select
      run.id,
      run.provider,
      run.status,
      run.scheduled_for,
      run.started_at,
      run.completed_at,
      run.exception_count
    from public.reconciliation_runs as run
    order by run.scheduled_for desc, run.id desc
    limit 5
  ) as recent;

  click_status := case
    when not coalesce(setting_record.tracking_enabled, false) then 'disabled'
    when click_provider.observed_count = 0 then 'unobserved'
    else 'ready'
  end;
  funnel_status := case
    when not coalesce(setting_record.tracking_enabled, false) then 'disabled'
    when funnel_provider.observed_count = 0 then 'unobserved'
    when funnel_provider.failed_count > 0 then 'attention'
    else 'ready'
  end;
  stripe_status := case
    when stripe_provider.observed_count = 0 then 'unobserved'
    when stripe_provider.failed_count > 0 then 'attention'
    else 'ready'
  end;
  singular_status := case
    when singular_provider.observed_count = 0 then 'unobserved'
    when singular_provider.failed_count > 0 then 'attention'
    else 'ready'
  end;

  stripe_queue_status := case
    when stripe_queue.pending_count + stripe_queue.processing_count
      + stripe_queue.processed_count + stripe_queue.failed_count = 0 then 'unobserved'
    when stripe_queue.failed_count > 0
      or stripe_queue.retry_ready_count > 0
      or stripe_queue.stale_lease_count > 0 then 'attention'
    else 'ready'
  end;
  fact_queue_status := case
    when fact_queue.pending_count + fact_queue.processing_count
      + fact_queue.processed_count + fact_queue.failed_count = 0 then 'unobserved'
    when fact_queue.failed_count > 0
      or fact_queue.retry_ready_count > 0
      or fact_queue.stale_lease_count > 0 then 'attention'
    else 'ready'
  end;
  metric_queue_status := case
    when metric_queue.pending_count + metric_queue.processing_count
      + metric_queue.processed_count + metric_queue.failed_count = 0 then 'unobserved'
    when metric_queue.failed_count > 0
      or metric_queue.retry_ready_count > 0
      or metric_queue.stale_lease_count > 0 then 'attention'
    else 'ready'
  end;
  reconciliation_queue_status := case
    when reconciliation_queue.pending_count + reconciliation_queue.processing_count
      + reconciliation_queue.processed_count + reconciliation_queue.failed_count = 0
      then 'unobserved'
    when reconciliation_queue.failed_count > 0
      or reconciliation_queue.retry_ready_count > 0
      or reconciliation_queue.stale_lease_count > 0 then 'attention'
    else 'ready'
  end;

  has_operational_evidence :=
    click_provider.observed_count + funnel_provider.observed_count
      + stripe_provider.observed_count + singular_provider.observed_count
      + stripe_queue.pending_count + stripe_queue.processing_count
      + stripe_queue.processed_count + stripe_queue.failed_count
      + fact_queue.pending_count + fact_queue.processing_count
      + fact_queue.processed_count + fact_queue.failed_count
      + metric_queue.pending_count + metric_queue.processing_count
      + metric_queue.processed_count + metric_queue.failed_count
      + reconciliation_queue.pending_count + reconciliation_queue.processing_count
      + reconciliation_queue.processed_count + reconciliation_queue.failed_count
      + metric_record.row_count + reconciliation_record.run_count > 0;

  has_attention :=
    stripe_status = 'attention'
      or singular_status = 'attention'
      or stripe_queue_status = 'attention'
      or fact_queue_status = 'attention'
      or metric_queue_status = 'attention'
      or reconciliation_queue_status = 'attention'
      or reconciliation_record.open_exception_count > 0;

  overall_status_value := case
    when has_attention then 'attention'
    when not coalesce(setting_record.tracking_enabled, false) then 'disabled'
    when not has_operational_evidence then 'unobserved'
    else 'ready'
  end;

  return jsonb_build_object(
    'generated_at', generated_at_value,
    'overall_status', overall_status_value,
    'catalog', jsonb_build_object(
      'tracking_enabled', coalesce(setting_record.tracking_enabled, false),
      'base_url_configured', setting_record.tracking_base_url is not null,
      'active_product_count', catalog_record.active_product_count,
      'live_funnel_count', catalog_record.live_funnel_count,
      'active_link_count', catalog_record.active_link_count,
      'verified_active_offer_count', catalog_record.verified_active_offer_count,
      'launch_ready_agreement_count', catalog_record.launch_ready_agreement_count
    ),
    'providers', jsonb_build_array(
      jsonb_build_object(
        'id', 'click_tracker',
        'status', click_status,
        'observed_count', click_provider.observed_count,
        'verified_count', click_provider.verified_count,
        'failed_count', click_provider.failed_count,
        'last_observed_at', click_provider.last_observed_at
      ),
      jsonb_build_object(
        'id', 'funnel_events',
        'status', funnel_status,
        'observed_count', funnel_provider.observed_count,
        'verified_count', funnel_provider.verified_count,
        'failed_count', funnel_provider.failed_count,
        'last_observed_at', funnel_provider.last_observed_at
      ),
      jsonb_build_object(
        'id', 'stripe',
        'status', stripe_status,
        'observed_count', stripe_provider.observed_count,
        'verified_count', stripe_provider.verified_count,
        'failed_count', stripe_provider.failed_count,
        'last_observed_at', stripe_provider.last_observed_at
      ),
      jsonb_build_object(
        'id', 'singular',
        'status', singular_status,
        'observed_count', singular_provider.observed_count,
        'verified_count', singular_provider.verified_count,
        'failed_count', singular_provider.failed_count,
        'last_observed_at', singular_provider.last_observed_at
      )
    ),
    'queues', jsonb_build_array(
      jsonb_build_object(
        'id', 'stripe_events',
        'status', stripe_queue_status,
        'pending_count', stripe_queue.pending_count,
        'processing_count', stripe_queue.processing_count,
        'processed_count', stripe_queue.processed_count,
        'failed_count', stripe_queue.failed_count,
        'retry_ready_count', stripe_queue.retry_ready_count,
        'stale_lease_count', stripe_queue.stale_lease_count,
        'oldest_pending_at', stripe_queue.oldest_pending_at,
        'last_processed_at', stripe_queue.last_processed_at
      ),
      jsonb_build_object(
        'id', 'commercial_facts',
        'status', fact_queue_status,
        'pending_count', fact_queue.pending_count,
        'processing_count', fact_queue.processing_count,
        'processed_count', fact_queue.processed_count,
        'failed_count', fact_queue.failed_count,
        'retry_ready_count', fact_queue.retry_ready_count,
        'stale_lease_count', fact_queue.stale_lease_count,
        'oldest_pending_at', fact_queue.oldest_pending_at,
        'last_processed_at', fact_queue.last_processed_at
      ),
      jsonb_build_object(
        'id', 'reporting_metrics',
        'status', metric_queue_status,
        'pending_count', metric_queue.pending_count,
        'processing_count', metric_queue.processing_count,
        'processed_count', metric_queue.processed_count,
        'failed_count', metric_queue.failed_count,
        'retry_ready_count', metric_queue.retry_ready_count,
        'stale_lease_count', metric_queue.stale_lease_count,
        'oldest_pending_at', metric_queue.oldest_pending_at,
        'last_processed_at', metric_queue.last_processed_at
      ),
      jsonb_build_object(
        'id', 'reconciliation',
        'status', reconciliation_queue_status,
        'pending_count', reconciliation_queue.pending_count,
        'processing_count', reconciliation_queue.processing_count,
        'processed_count', reconciliation_queue.processed_count,
        'failed_count', reconciliation_queue.failed_count,
        'retry_ready_count', reconciliation_queue.retry_ready_count,
        'stale_lease_count', reconciliation_queue.stale_lease_count,
        'oldest_pending_at', reconciliation_queue.oldest_pending_at,
        'last_processed_at', reconciliation_queue.last_processed_at
      )
    ),
    'metrics', jsonb_build_object(
      'row_count', metric_record.row_count,
      'partial_count', metric_record.partial_count,
      'reconciled_count', metric_record.reconciled_count,
      'finalized_count', metric_record.finalized_count,
      'latest_metric_date', metric_record.latest_metric_date,
      'latest_calculated_at', metric_record.latest_calculated_at
    ),
    'reconciliation', jsonb_build_object(
      'run_count', reconciliation_record.run_count,
      'open_exception_count', reconciliation_record.open_exception_count,
      'recent_runs', recent_runs_value
    )
  );
end;
$$;

revoke all on function public.get_admin_data_health()
  from public, anon, authenticated, service_role;
grant execute on function public.get_admin_data_health()
  to authenticated;

comment on function public.get_admin_data_health() is
  'Returns privacy-safe aggregate catalog, provider, queue, metric, and reconciliation health for Owner, Operations, Finance, and Analyst admins. Zero operational evidence remains unobserved; no provider payload, row identity, raw error, lease identity, URL, customer data, or money is returned.';

commit;
