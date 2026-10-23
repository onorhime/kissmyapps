-- Traffic availability is independent of unconnected analytics and unsettled money.
-- Preserve product/member checks, filters, return types, grants, financial gates
-- and tracking-only routing. Subscription snapshots are not traffic evidence.
-- Missing/malformed source freshness remains unknown; never promote whole rows
-- to complete or turn unavailable measurements into fabricated zeros.
begin;

create or replace function public.get_partner_dashboard_summary_commercial(
  p_product_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_timezone text,
  p_source_id uuid,
  p_campaign_id uuid,
  p_funnel_id uuid,
  p_country_code text,
  p_sub_id text
)
returns table (
  starts_on date,
  ends_on date,
  timezone text,
  currency text,
  has_data boolean,
  reconciliation_stage public.reconciliation_stage,
  reconciled_through date,
  clicks bigint,
  visitors bigint,
  funnel_starts bigint,
  payment_views bigint,
  app_store_clicks bigint,
  leads bigint,
  trials bigint,
  installs bigint,
  purchases bigint,
  activations bigint,
  renewals bigint,
  cancellations bigint,
  refunds bigint,
  disputes bigint,
  gross_collected_minor bigint,
  eligible_revenue_minor bigint,
  earnings_minor bigint,
  active_subscriptions bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  partner_id uuid;
  partner_timezone text;
begin
  partner_id := public.current_partner_affiliate_id(false);
  select affiliate.reporting_timezone into partner_timezone
  from public.affiliates as affiliate where affiliate.id = partner_id;

  if p_product_id is null or not public.current_user_can_view_product(p_product_id) then
    raise exception 'an authorized product is required' using errcode = '42501';
  end if;

  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on
     or p_ends_on - p_starts_on > 366 then
    raise exception 'reporting period must contain between 1 and 367 days' using errcode = '22023';
  end if;
  if p_timezone is null or p_timezone <> partner_timezone then
    raise exception 'reporting timezone must match the partner profile' using errcode = '22023';
  end if;
  if p_country_code is not null and p_country_code !~ '^[A-Z]{2}$' then
    raise exception 'country code must be ISO alpha-2 uppercase' using errcode = '22023';
  end if;
  if p_sub_id is not null and char_length(p_sub_id) > 64 then
    raise exception 'sub ID filter is too long' using errcode = '22023';
  end if;

  return query
  with filtered as (
    select metric.*
    from public.affiliate_daily_metrics as metric
    where metric.affiliate_id = partner_id
      and metric.metric_date between p_starts_on and p_ends_on
      and (p_product_id is null or metric.product_id = p_product_id)
      and (p_source_id is null or metric.source_id = p_source_id)
      and (p_campaign_id is null or metric.campaign_id = p_campaign_id)
      and (p_funnel_id is null or metric.funnel_id = p_funnel_id)
      and (p_country_code is null or metric.country_code = p_country_code)
      and (
        p_sub_id is null
        or metric.sub1 ilike '%' || p_sub_id || '%'
        or metric.sub2 ilike '%' || p_sub_id || '%'
        or metric.sub3 ilike '%' || p_sub_id || '%'
      )
  )
  select
    p_starts_on,
    p_ends_on,
    p_timezone,
    case when count(filtered.id) = 0 or count(distinct filtered.currency) <> 1 then null else min(filtered.currency) end,
    count(filtered.id) > 0,
    case
      when count(filtered.id) = 0 then null
      when not bool_and(filtered.completeness = 'complete') then 'preliminary'::public.reconciliation_stage
      when bool_or(filtered.reconciliation_stage = 'preliminary') then 'preliminary'::public.reconciliation_stage
      when bool_or(filtered.reconciliation_stage = 'reconciled') then 'reconciled'::public.reconciliation_stage
      else 'finalized'::public.reconciliation_stage
    end,
    min(filtered.reconciled_through),
    case when count(*) filter (where not filtered.is_subscription_snapshot) > 0
      and bool_and(coalesce(filtered.completeness = 'complete'
        or filtered.source_freshness ->> 'click_tracker' = 'complete', false))
        filter (where not filtered.is_subscription_snapshot)
      then sum(filtered.clicks) filter (where not filtered.is_subscription_snapshot)::bigint end,
    case when count(*) filter (where not filtered.is_subscription_snapshot) > 0
      and bool_and(coalesce(filtered.completeness = 'complete'
        or filtered.source_freshness ->> 'click_tracker' = 'complete', false))
        filter (where not filtered.is_subscription_snapshot)
      then sum(filtered.visitors) filter (where not filtered.is_subscription_snapshot)::bigint end,
    case when count(*) filter (where not filtered.is_subscription_snapshot) > 0
      and bool_and(coalesce(filtered.completeness = 'complete'
        or filtered.source_freshness ->> 'first_party' = 'complete', false))
        filter (where not filtered.is_subscription_snapshot)
      then sum(filtered.funnel_starts) filter (where not filtered.is_subscription_snapshot)::bigint end,
    case when count(*) filter (where not filtered.is_subscription_snapshot) > 0
      and bool_and(coalesce(filtered.completeness = 'complete'
        or filtered.source_freshness ->> 'first_party' = 'complete', false))
        filter (where not filtered.is_subscription_snapshot)
      then sum(filtered.payment_views) filter (where not filtered.is_subscription_snapshot)::bigint end,
    case when count(*) filter (where not filtered.is_subscription_snapshot) > 0
      and bool_and(coalesce(filtered.completeness = 'complete'
        or filtered.source_freshness ->> 'first_party' = 'complete', false))
        filter (where not filtered.is_subscription_snapshot)
      then sum(filtered.app_store_clicks) filter (where not filtered.is_subscription_snapshot)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.leads)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.trials)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.installs)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.purchases)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.activations)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.renewals)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.cancellations)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.refunds)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else sum(filtered.disputes)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') or count(distinct filtered.currency) <> 1 then null else sum(filtered.gross_collected_minor)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') or count(distinct filtered.currency) <> 1 then null else sum(filtered.eligible_revenue_minor)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') or count(distinct filtered.currency) <> 1 then null else sum(filtered.earnings_minor)::bigint end,
    case when count(filtered.id) = 0 or not bool_and(filtered.completeness = 'complete') then null else
      (array_agg(filtered.active_subscriptions order by filtered.metric_date desc, filtered.id desc)
        filter (where filtered.is_subscription_snapshot))[1]
    end
  from filtered;
end;
$$;

create or replace function public.get_partner_dashboard_trends_commercial(
  p_product_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_timezone text,
  p_source_id uuid,
  p_campaign_id uuid,
  p_funnel_id uuid,
  p_country_code text,
  p_sub_id text,
  p_grain text,
  p_breakdown text
)
returns table (
  bucket_start date,
  bucket_end date,
  dimension_key text,
  dimension_label text,
  reconciliation_stage public.reconciliation_stage,
  clicks bigint,
  visitors bigint,
  funnel_starts bigint,
  payment_views bigint,
  app_store_clicks bigint,
  leads bigint,
  trials bigint,
  installs bigint,
  purchases bigint,
  activations bigint,
  renewals bigint,
  cancellations bigint,
  refunds bigint,
  disputes bigint,
  gross_collected_minor bigint,
  eligible_revenue_minor bigint,
  earnings_minor bigint,
  active_subscriptions bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  partner_id uuid;
  partner_timezone text;
begin
  partner_id := public.current_partner_affiliate_id(false);
  select affiliate.reporting_timezone into partner_timezone
  from public.affiliates as affiliate where affiliate.id = partner_id;

  if p_product_id is null or not public.current_user_can_view_product(p_product_id) then
    raise exception 'an authorized product is required' using errcode = '42501';
  end if;

  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on
     or p_ends_on - p_starts_on > 366 then
    raise exception 'reporting period must contain between 1 and 367 days' using errcode = '22023';
  end if;
  if p_timezone is null or p_timezone <> partner_timezone then
    raise exception 'reporting timezone must match the partner profile' using errcode = '22023';
  end if;
  if p_country_code is not null and p_country_code !~ '^[A-Z]{2}$' then
    raise exception 'country code must be ISO alpha-2 uppercase' using errcode = '22023';
  end if;
  if p_sub_id is not null and char_length(p_sub_id) > 64 then
    raise exception 'sub ID filter is too long' using errcode = '22023';
  end if;
  if p_grain not in ('day', 'week', 'month') then
    raise exception 'unsupported reporting grain' using errcode = '22023';
  end if;
  if p_breakdown not in ('date', 'source', 'country', 'campaign', 'funnel', 'subId') then
    raise exception 'unsupported reporting breakdown' using errcode = '22023';
  end if;

  return query
  with filtered as (
    select
      metric.*,
      source.key as source_key,
      source.name as source_name,
      campaign.key as campaign_key,
      campaign.name as campaign_name,
      funnel.key as funnel_key,
      funnel.name as funnel_name,
      date_trunc(p_grain, metric.metric_date::timestamp)::date as grouped_date
    from public.affiliate_daily_metrics as metric
    left join public.sources as source on source.id = metric.source_id
    left join public.campaigns as campaign on campaign.id = metric.campaign_id
    left join public.funnels as funnel on funnel.id = metric.funnel_id
    where metric.affiliate_id = partner_id
      and metric.metric_date between p_starts_on and p_ends_on
      and (p_breakdown = 'date' or not metric.is_subscription_snapshot)
      and (p_product_id is null or metric.product_id = p_product_id)
      and (p_source_id is null or metric.source_id = p_source_id)
      and (p_campaign_id is null or metric.campaign_id = p_campaign_id)
      and (p_funnel_id is null or metric.funnel_id = p_funnel_id)
      and (p_country_code is null or metric.country_code = p_country_code)
      and (
        p_sub_id is null
        or metric.sub1 ilike '%' || p_sub_id || '%'
        or metric.sub2 ilike '%' || p_sub_id || '%'
        or metric.sub3 ilike '%' || p_sub_id || '%'
      )
  ), labelled as (
    select
      filtered.*,
      case p_breakdown
        when 'date' then filtered.grouped_date::text
        when 'source' then coalesce(filtered.source_key, 'untagged')
        when 'country' then coalesce(filtered.country_code, 'unknown')
        when 'campaign' then coalesce(filtered.campaign_key, 'untagged')
        when 'funnel' then coalesce(filtered.funnel_key, 'unknown')
        when 'subId' then coalesce(filtered.sub1, 'untagged')
      end as grouped_key,
      case p_breakdown
        when 'date' then filtered.grouped_date::text
        when 'source' then coalesce(filtered.source_name, 'Direct / untagged')
        when 'country' then coalesce(filtered.country_code, 'Unknown')
        when 'campaign' then coalesce(filtered.campaign_name, 'Untagged')
        when 'funnel' then coalesce(filtered.funnel_name, 'Unknown')
        when 'subId' then coalesce(filtered.sub1, 'Untagged')
      end as grouped_label
    from filtered
  )
  select
    labelled.grouped_date,
    case p_grain
      when 'day' then labelled.grouped_date
      when 'week' then (labelled.grouped_date + 6)
      when 'month' then (labelled.grouped_date + interval '1 month - 1 day')::date
    end,
    labelled.grouped_key,
    labelled.grouped_label,
    case
      when not bool_and(labelled.completeness = 'complete') then 'preliminary'::public.reconciliation_stage
      when bool_or(labelled.reconciliation_stage = 'preliminary') then 'preliminary'::public.reconciliation_stage
      when bool_or(labelled.reconciliation_stage = 'reconciled') then 'reconciled'::public.reconciliation_stage
      else 'finalized'::public.reconciliation_stage
    end,
    case when count(*) filter (where not labelled.is_subscription_snapshot) > 0
      and bool_and(coalesce(labelled.completeness = 'complete'
        or labelled.source_freshness ->> 'click_tracker' = 'complete', false))
        filter (where not labelled.is_subscription_snapshot)
      then sum(labelled.clicks) filter (where not labelled.is_subscription_snapshot)::bigint end,
    case when count(*) filter (where not labelled.is_subscription_snapshot) > 0
      and bool_and(coalesce(labelled.completeness = 'complete'
        or labelled.source_freshness ->> 'click_tracker' = 'complete', false))
        filter (where not labelled.is_subscription_snapshot)
      then sum(labelled.visitors) filter (where not labelled.is_subscription_snapshot)::bigint end,
    case when count(*) filter (where not labelled.is_subscription_snapshot) > 0
      and bool_and(coalesce(labelled.completeness = 'complete'
        or labelled.source_freshness ->> 'first_party' = 'complete', false))
        filter (where not labelled.is_subscription_snapshot)
      then sum(labelled.funnel_starts) filter (where not labelled.is_subscription_snapshot)::bigint end,
    case when count(*) filter (where not labelled.is_subscription_snapshot) > 0
      and bool_and(coalesce(labelled.completeness = 'complete'
        or labelled.source_freshness ->> 'first_party' = 'complete', false))
        filter (where not labelled.is_subscription_snapshot)
      then sum(labelled.payment_views) filter (where not labelled.is_subscription_snapshot)::bigint end,
    case when count(*) filter (where not labelled.is_subscription_snapshot) > 0
      and bool_and(coalesce(labelled.completeness = 'complete'
        or labelled.source_freshness ->> 'first_party' = 'complete', false))
        filter (where not labelled.is_subscription_snapshot)
      then sum(labelled.app_store_clicks) filter (where not labelled.is_subscription_snapshot)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.leads)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.trials)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.installs)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.purchases)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.activations)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.renewals)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.cancellations)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.refunds)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then sum(labelled.disputes)::bigint end,
    case when bool_and(labelled.completeness = 'complete') and count(distinct labelled.currency) = 1 then sum(labelled.gross_collected_minor)::bigint end,
    case when bool_and(labelled.completeness = 'complete') and count(distinct labelled.currency) = 1 then sum(labelled.eligible_revenue_minor)::bigint end,
    case when bool_and(labelled.completeness = 'complete') and count(distinct labelled.currency) = 1 then sum(labelled.earnings_minor)::bigint end,
    case when bool_and(labelled.completeness = 'complete') then
      (array_agg(labelled.active_subscriptions order by labelled.metric_date desc, labelled.id desc)
        filter (where labelled.is_subscription_snapshot))[1]
    end
  from labelled
  group by labelled.grouped_date, labelled.grouped_key, labelled.grouped_label
  order by labelled.grouped_date, labelled.grouped_label;
end;
$$;

commit;
