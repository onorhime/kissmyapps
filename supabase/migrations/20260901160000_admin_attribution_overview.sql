-- Admin attribution is exposed only through a bounded, aggregate-only read boundary.
-- Raw click identity, event properties, provider payloads, account identifiers,
-- destination snapshots, and payment identifiers remain private.

create index if not exists admin_clicks_occurred_product_source_idx
  on public.clicks (occurred_at desc, product_id, source_id, id desc);

create index if not exists admin_acquisitions_created_product_source_idx
  on public.acquisitions (created_at desc, product_id, source_id, id desc);

create index if not exists admin_events_occurred_product_source_idx
  on public.events (occurred_at desc, product_id, source_id, id desc);

create index if not exists admin_conversions_occurred_product_idx
  on public.conversions (occurred_at desc, product_id, id desc);

create or replace function public.get_admin_attribution_overview(p_input jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'starts_at', 'ends_at', 'product_id', 'source_id', 'limit', 'offset'
  ];
  starts_at_value timestamptz;
  ends_at_value timestamptz;
  product_id_value uuid;
  source_id_value uuid;
  limit_value integer := 25;
  offset_value integer := 0;
  readiness_value jsonb;
  summary_value jsonb;
  breakdown_value jsonb;
  event_types_value jsonb;
  recent_items_value jsonb;
  recent_total_value bigint;
  sources_value jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(
    array['owner', 'operations', 'finance', 'analyst']::text[]
  ) then
    raise exception 'admin role cannot view attribution' using errcode = '42501';
  end if;

  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'attribution input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(p_input) as input_key(key_name)
    where input_key.key_name <> all(allowed_keys)
  ) or not (p_input ?& array['starts_at', 'ends_at']) then
    raise exception 'attribution input contains unsupported or missing fields'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'starts_at') <> 'string'
     or jsonb_typeof(p_input -> 'ends_at') <> 'string' then
    raise exception 'attribution window timestamps must be strings' using errcode = '22023';
  end if;

  begin
    starts_at_value := (p_input ->> 'starts_at')::timestamptz;
    ends_at_value := (p_input ->> 'ends_at')::timestamptz;
  exception when others then
    raise exception 'attribution window timestamps are invalid' using errcode = '22023';
  end;

  if ends_at_value <= starts_at_value then
    raise exception 'attribution window must end after it starts' using errcode = '22023';
  end if;
  if ends_at_value - starts_at_value > interval '90 days' then
    raise exception 'attribution window cannot exceed 90 days' using errcode = '22023';
  end if;

  if p_input ? 'product_id'
     and jsonb_typeof(p_input -> 'product_id') not in ('string', 'null') then
    raise exception 'product_id must be a UUID or null' using errcode = '22023';
  end if;
  if p_input ? 'source_id'
     and jsonb_typeof(p_input -> 'source_id') not in ('string', 'null') then
    raise exception 'source_id must be a UUID or null' using errcode = '22023';
  end if;

  begin
    product_id_value := nullif(trim(p_input ->> 'product_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'product_id must be a UUID or null' using errcode = '22023';
  end;
  begin
    source_id_value := nullif(trim(p_input ->> 'source_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'source_id must be a UUID or null' using errcode = '22023';
  end;

  if product_id_value is not null and not exists (
    select 1 from public.products as product where product.id = product_id_value
  ) then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if source_id_value is not null and not exists (
    select 1 from public.sources as source where source.id = source_id_value
  ) then
    raise exception 'source not found' using errcode = 'P0002';
  end if;

  if p_input ? 'limit' and jsonb_typeof(p_input -> 'limit') <> 'null' then
    if jsonb_typeof(p_input -> 'limit') <> 'number'
       or (p_input ->> 'limit') !~ '^[0-9]+$' then
      raise exception 'attribution limit must be an integer' using errcode = '22023';
    end if;
    begin
      limit_value := (p_input ->> 'limit')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'attribution limit must be an integer' using errcode = '22023';
    end;
  end if;
  if limit_value not between 1 and 100 then
    raise exception 'attribution limit must be between 1 and 100' using errcode = '22023';
  end if;

  if p_input ? 'offset' and jsonb_typeof(p_input -> 'offset') <> 'null' then
    if jsonb_typeof(p_input -> 'offset') <> 'number'
       or (p_input ->> 'offset') !~ '^[0-9]+$' then
      raise exception 'attribution offset must be an integer' using errcode = '22023';
    end if;
    begin
      offset_value := (p_input ->> 'offset')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'attribution offset must be an integer' using errcode = '22023';
    end;
  end if;
  if offset_value not between 0 and 10000 then
    raise exception 'attribution offset must be between 0 and 10000' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'tracking_enabled', coalesce(setting.tracking_enabled, false),
    'base_url_configured', setting.tracking_base_url is not null,
    'active_product_count', (
      select count(*) from public.products as product where product.status = 'active'
    ),
    'live_funnel_count', (
      select count(*) from public.funnels as funnel where funnel.status = 'live'
    ),
    'active_link_count', (
      select count(*) from public.affiliate_links as link where link.status = 'active'
    ),
    'last_click_at', (select max(click.occurred_at) from public.clicks as click),
    'last_event_at', (select max(event.occurred_at) from public.events as event),
    'last_conversion_at', (
      select max(conversion.occurred_at) from public.conversions as conversion
    )
  )
  into readiness_value
  from (select 1) as singleton
  left join public.platform_settings as setting on setting.singleton;

  select jsonb_build_object(
    'clicks', click_summary.clicks,
    'bot_clicks', click_summary.bot_clicks,
    'acquisitions', acquisition_summary.acquisitions,
    'resolved_acquisitions', acquisition_summary.resolved_acquisitions,
    'rejected_acquisitions', acquisition_summary.rejected_acquisitions,
    'events', event_summary.events,
    'trusted_events', event_summary.trusted_events,
    'commercial_eligible_events', event_summary.commercial_eligible_events,
    'qualified_conversions', conversion_summary.qualified_conversions
  )
  into summary_value
  from (
    select
      (count(*) filter (where not click.is_bot))::bigint as clicks,
      (count(*) filter (where click.is_bot))::bigint as bot_clicks
    from public.clicks as click
    where click.occurred_at >= starts_at_value
      and click.occurred_at < ends_at_value
      and (product_id_value is null or click.product_id = product_id_value)
      and (source_id_value is null or click.source_id = source_id_value)
  ) as click_summary
  cross join (
    select
      count(*)::bigint as acquisitions,
      (count(*) filter (where acquisition.status = 'resolved'))::bigint
        as resolved_acquisitions,
      (count(*) filter (where acquisition.status = 'rejected'))::bigint
        as rejected_acquisitions
    from public.acquisitions as acquisition
    where acquisition.created_at >= starts_at_value
      and acquisition.created_at < ends_at_value
      and (product_id_value is null or acquisition.product_id = product_id_value)
      and (source_id_value is null or acquisition.source_id = source_id_value)
  ) as acquisition_summary
  cross join (
    select
      count(*)::bigint as events,
      (count(*) filter (where event.trust <> 'browser'))::bigint as trusted_events,
      (count(*) filter (where event.commercial_eligible))::bigint
        as commercial_eligible_events
    from public.events as event
    where event.occurred_at >= starts_at_value
      and event.occurred_at < ends_at_value
      and (product_id_value is null or event.product_id = product_id_value)
      and (source_id_value is null or event.source_id = source_id_value)
  ) as event_summary
  cross join (
    select (count(*) filter (where conversion.qualified))::bigint
      as qualified_conversions
    from public.conversions as conversion
    join public.acquisitions as acquisition on acquisition.id = conversion.acquisition_id
    where conversion.occurred_at >= starts_at_value
      and conversion.occurred_at < ends_at_value
      and (product_id_value is null or conversion.product_id = product_id_value)
      and (source_id_value is null or acquisition.source_id = source_id_value)
  ) as conversion_summary;

  with fact_counts as (
    select
      click.product_id,
      click.source_id,
      count(*)::bigint as clicks,
      0::bigint as acquisitions,
      0::bigint as qualified_conversions
    from public.clicks as click
    where click.occurred_at >= starts_at_value
      and click.occurred_at < ends_at_value
      and not click.is_bot
      and (product_id_value is null or click.product_id = product_id_value)
      and (source_id_value is null or click.source_id = source_id_value)
    group by click.product_id, click.source_id

    union all

    select
      acquisition.product_id,
      acquisition.source_id,
      0::bigint,
      count(*)::bigint,
      0::bigint
    from public.acquisitions as acquisition
    where acquisition.created_at >= starts_at_value
      and acquisition.created_at < ends_at_value
      and (product_id_value is null or acquisition.product_id = product_id_value)
      and (source_id_value is null or acquisition.source_id = source_id_value)
    group by acquisition.product_id, acquisition.source_id

    union all

    select
      conversion.product_id,
      acquisition.source_id,
      0::bigint,
      0::bigint,
      count(*)::bigint
    from public.conversions as conversion
    join public.acquisitions as acquisition on acquisition.id = conversion.acquisition_id
    where conversion.occurred_at >= starts_at_value
      and conversion.occurred_at < ends_at_value
      and conversion.qualified
      and (product_id_value is null or conversion.product_id = product_id_value)
      and (source_id_value is null or acquisition.source_id = source_id_value)
    group by conversion.product_id, acquisition.source_id
  ), breakdown_counts as (
    select
      fact.product_id,
      fact.source_id,
      sum(fact.clicks)::bigint as clicks,
      sum(fact.acquisitions)::bigint as acquisitions,
      sum(fact.qualified_conversions)::bigint as qualified_conversions
    from fact_counts as fact
    group by fact.product_id, fact.source_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'product_id', count_row.product_id,
      'product_name', product.name,
      'source_id', count_row.source_id,
      'source_name', coalesce(source.name, 'Direct / untagged'),
      'clicks', count_row.clicks,
      'acquisitions', count_row.acquisitions,
      'qualified_conversions', count_row.qualified_conversions
    ) order by product.name, coalesce(source.name, 'Direct / untagged'),
      count_row.product_id, count_row.source_id
  ), '[]'::jsonb)
  into breakdown_value
  from breakdown_counts as count_row
  join public.products as product on product.id = count_row.product_id
  left join public.sources as source on source.id = count_row.source_id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'event_name', event_count.event_name,
      'event_count', event_count.event_count,
      'commercial_eligible_count', event_count.commercial_eligible_count,
      'last_occurred_at', event_count.last_occurred_at
    ) order by event_count.event_count desc, event_count.event_name
  ), '[]'::jsonb)
  into event_types_value
  from (
    select
      event.event_name,
      count(*)::bigint as event_count,
      (count(*) filter (where event.commercial_eligible))::bigint
        as commercial_eligible_count,
      max(event.occurred_at) as last_occurred_at
    from public.events as event
    where event.occurred_at >= starts_at_value
      and event.occurred_at < ends_at_value
      and (product_id_value is null or event.product_id = product_id_value)
      and (source_id_value is null or event.source_id = source_id_value)
    group by event.event_name
    order by count(*) desc, event.event_name
    limit 100
  ) as event_count;

  select count(*)::bigint
  into recent_total_value
  from public.acquisitions as acquisition
  where acquisition.created_at >= starts_at_value
    and acquisition.created_at < ends_at_value
    and (product_id_value is null or acquisition.product_id = product_id_value)
    and (source_id_value is null or acquisition.source_id = source_id_value);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'product_name', product.name,
      'partner_name', affiliate.public_name,
      'source_name', coalesce(source.name, 'Direct / untagged'),
      'campaign_name', campaign.name,
      'funnel_name', funnel.name,
      'attribution_method', acquisition.attribution_method,
      'status', acquisition.status,
      'click_country', acquisition.click_country,
      'install_country', acquisition.install_country,
      'created_at', acquisition.created_at,
      'resolved_at', acquisition.resolved_at
    ) order by acquisition.created_at desc, acquisition.id desc
  ), '[]'::jsonb)
  into recent_items_value
  from (
    select stored.*
    from public.acquisitions as stored
    where stored.created_at >= starts_at_value
      and stored.created_at < ends_at_value
      and (product_id_value is null or stored.product_id = product_id_value)
      and (source_id_value is null or stored.source_id = source_id_value)
    order by stored.created_at desc, stored.id desc
    limit limit_value
    offset offset_value
  ) as acquisition
  join public.products as product on product.id = acquisition.product_id
  left join public.affiliates as affiliate on affiliate.id = acquisition.affiliate_id
  left join public.sources as source on source.id = acquisition.source_id
  left join public.campaigns as campaign on campaign.id = acquisition.campaign_id
  left join public.funnels as funnel on funnel.id = acquisition.funnel_id;

  select coalesce(jsonb_agg(
    jsonb_build_object('id', source.id, 'name', source.name)
    order by source.active desc, source.name, source.id
  ), '[]'::jsonb)
  into sources_value
  from public.sources as source;

  return jsonb_build_object(
    'generated_at', now(),
    'window', jsonb_build_object(
      'starts_at', starts_at_value,
      'ends_at', ends_at_value
    ),
    'filters', jsonb_build_object(
      'product_id', product_id_value,
      'source_id', source_id_value
    ),
    'readiness', readiness_value,
    'summary', summary_value,
    'breakdown', breakdown_value,
    'event_types', event_types_value,
    'recent_acquisitions', jsonb_build_object(
      'items', recent_items_value,
      'total_count', recent_total_value
    ),
    'sources', sources_value
  );
end;
$$;

revoke all on function public.get_admin_attribution_overview(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.get_admin_attribution_overview(jsonb) to authenticated;

comment on function public.get_admin_attribution_overview(jsonb) is
  'Returns bounded aggregate attribution and redacted acquisition context to owner, operations, finance, and analyst admins. Raw attribution and provider evidence is never emitted.';
