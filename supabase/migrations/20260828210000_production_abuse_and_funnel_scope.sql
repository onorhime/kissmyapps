-- Production request-scope verification and durable abuse bounds.
-- HMAC secrets and key-to-product/funnel bindings remain in the Edge runtime.
-- The database independently verifies that the asserted binding matches the
-- canonical, non-bot click without returning any tenant-owned data.

alter table public.clicks
  add constraint clicks_session_id_hash_sha256 check (
    session_id_hash is null or session_id_hash ~ '^[a-f0-9]{64}$'
  ),
  add constraint clicks_user_agent_hash_sha256 check (
    user_agent_hash is null or user_agent_hash ~ '^[a-f0-9]{64}$'
  ),
  add constraint clicks_ip_hash_sha256 check (
    ip_hash is null or ip_hash ~ '^[a-f0-9]{64}$'
  );

create index clicks_link_ip_created_idx
  on public.clicks (affiliate_link_id, ip_hash, created_at desc)
  where ip_hash is not null;

create index clicks_link_session_created_idx
  on public.clicks (affiliate_link_id, session_id_hash, created_at desc)
  where session_id_hash is not null;

create index events_browser_acquisition_created_idx
  on public.events (acquisition_id, created_at desc)
  where trust = 'browser';

create or replace function public.assert_funnel_request_scope(
  p_key_id text,
  p_click_id text,
  p_product_id uuid,
  p_funnel_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_key_id is null
     or p_key_id !~ '^[A-Za-z0-9_-]{1,64}$'
     or p_click_id is null
     or p_click_id !~ '^[A-Za-z0-9_-]{16,128}$'
     or p_product_id is null
     or p_funnel_id is null then
    raise exception 'funnel request scope input is invalid' using errcode = '22023';
  end if;

  -- The Edge has already authenticated p_key_id and resolved its configured
  -- binding. This check deliberately returns no row identity or dimensions.
  if not exists (
    select 1
    from public.clicks as click
    join public.acquisitions as acquisition
      on acquisition.click_record_id = click.id
    where click.public_click_id = p_click_id
      and not click.is_bot
      and acquisition.status in ('open', 'resolved')
      and click.product_id = p_product_id
      and click.funnel_id = p_funnel_id
      and acquisition.product_id = p_product_id
      and acquisition.funnel_id = p_funnel_id
  ) then
    raise exception 'funnel request scope is unavailable' using errcode = 'P0002';
  end if;

  return true;
end;
$$;

create or replace function public.register_tracking_click(
  p_affiliate_slug text,
  p_public_code text,
  p_context jsonb
)
returns table (
  click_id text,
  destination_url text,
  is_bot boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'country_code', 'session_id_hash', 'user_agent_hash', 'ip_hash', 'is_bot'
  ];
  ip_clicks_per_minute constant integer := 300;
  session_clicks_per_minute constant integer := 30;
  link_id_value uuid;
  affiliate_id_value uuid;
  product_id_value uuid;
  source_id_value uuid;
  campaign_id_value uuid;
  funnel_id_value uuid;
  sub1_value text;
  sub2_value text;
  sub3_value text;
  destination_value text;
  country_value text;
  session_hash_value text;
  user_agent_hash_value text;
  ip_hash_value text;
  bot_value boolean := false;
  generated_click_id text;
  click_record_id uuid;
  rate_now timestamptz := statement_timestamp();
  recent_count bigint;
begin
  p_context := coalesce(p_context, '{}'::jsonb);
  if jsonb_typeof(p_context) <> 'object' then
    raise exception 'tracking context must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(p_context) as input_key
    where input_key <> all(allowed_keys)
  ) then
    raise exception 'tracking context contains unsupported fields' using errcode = '22023';
  end if;
  if nullif(trim(p_affiliate_slug), '') is null or nullif(trim(p_public_code), '') is null then
    raise exception 'affiliate slug and public code are required' using errcode = '22023';
  end if;

  country_value := nullif(upper(trim(p_context ->> 'country_code')), '');
  session_hash_value := nullif(lower(trim(p_context ->> 'session_id_hash')), '');
  user_agent_hash_value := nullif(lower(trim(p_context ->> 'user_agent_hash')), '');
  ip_hash_value := nullif(lower(trim(p_context ->> 'ip_hash')), '');

  if country_value is not null and country_value !~ '^[A-Z]{2}$' then
    raise exception 'country code must be ISO alpha-2 uppercase' using errcode = '22023';
  end if;
  if session_hash_value is not null and session_hash_value !~ '^[a-f0-9]{64}$' then
    raise exception 'session hash must be a lowercase SHA-256 digest' using errcode = '22023';
  end if;
  if user_agent_hash_value is not null and user_agent_hash_value !~ '^[a-f0-9]{64}$' then
    raise exception 'user-agent hash must be a lowercase SHA-256 digest' using errcode = '22023';
  end if;
  if ip_hash_value is not null and ip_hash_value !~ '^[a-f0-9]{64}$' then
    raise exception 'IP hash must be a lowercase SHA-256 digest' using errcode = '22023';
  end if;
  if p_context ? 'is_bot' then
    if jsonb_typeof(p_context -> 'is_bot') <> 'boolean' then
      raise exception 'is_bot must be a boolean' using errcode = '22023';
    end if;
    bot_value := (p_context ->> 'is_bot')::boolean;
  end if;

  select
    link.id,
    link.affiliate_id,
    link.product_id,
    link.source_id,
    link.campaign_id,
    link.funnel_id,
    link.sub1,
    link.sub2,
    link.sub3,
    funnel.destination_url
  into
    link_id_value,
    affiliate_id_value,
    product_id_value,
    source_id_value,
    campaign_id_value,
    funnel_id_value,
    sub1_value,
    sub2_value,
    sub3_value,
    destination_value
  from public.affiliate_links as link
  join public.affiliates as affiliate
    on affiliate.id = link.affiliate_id and affiliate.status = 'active'
  join public.products as product
    on product.id = link.product_id and product.status = 'active'
  join public.funnels as funnel
    on funnel.id = link.funnel_id
   and funnel.product_id = link.product_id
   and funnel.status = 'live'
   and funnel.destination_url is not null
  left join public.campaigns as campaign on campaign.id = link.campaign_id
  join public.platform_settings as setting
    on setting.singleton and setting.tracking_enabled
  where affiliate.slug = trim(p_affiliate_slug)
    and link.public_code = trim(p_public_code)
    and link.status = 'active'
    and (link.campaign_id is null or campaign.status = 'active')
    and exists (
      select 1
      from public.agreements as agreement
      where agreement.affiliate_id = link.affiliate_id
        and agreement.product_id = link.product_id
        and public.agreement_is_launch_ready(agreement.id, now())
    )
  for share of link;

  if link_id_value is null then
    raise exception 'tracking route is unavailable' using errcode = 'P0002';
  end if;

  -- Per-link scoping avoids one busy partner route consuming another route's
  -- allowance. Advisory transaction locks make the count-and-insert boundary
  -- deterministic under concurrent production requests.
  if ip_hash_value is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'tracking-click:ip:' || link_id_value::text || ':' || ip_hash_value,
        0
      )
    );
    select count(*) into recent_count
    from public.clicks as click
    where click.affiliate_link_id = link_id_value
      and click.ip_hash = ip_hash_value
      and click.created_at >= rate_now - interval '1 minute';
    if recent_count >= ip_clicks_per_minute then
      raise exception 'tracking click rate limit exceeded' using errcode = 'KMA29';
    end if;
  end if;

  if session_hash_value is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'tracking-click:session:' || link_id_value::text || ':' || session_hash_value,
        0
      )
    );
    select count(*) into recent_count
    from public.clicks as click
    where click.affiliate_link_id = link_id_value
      and click.session_id_hash = session_hash_value
      and click.created_at >= rate_now - interval '1 minute';
    if recent_count >= session_clicks_per_minute then
      raise exception 'tracking click rate limit exceeded' using errcode = 'KMA29';
    end if;
  end if;

  generated_click_id := encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.clicks (
    public_click_id,
    affiliate_link_id,
    affiliate_id,
    product_id,
    source_id,
    campaign_id,
    funnel_id,
    sub1,
    sub2,
    sub3,
    destination_url_snapshot,
    country_code,
    session_id_hash,
    user_agent_hash,
    ip_hash,
    is_bot
  ) values (
    generated_click_id,
    link_id_value,
    affiliate_id_value,
    product_id_value,
    source_id_value,
    campaign_id_value,
    funnel_id_value,
    sub1_value,
    sub2_value,
    sub3_value,
    destination_value,
    country_value,
    session_hash_value,
    user_agent_hash_value,
    ip_hash_value,
    bot_value
  ) returning id into click_record_id;

  insert into public.acquisitions (
    product_id,
    affiliate_id,
    click_record_id,
    source_id,
    campaign_id,
    funnel_id,
    click_country,
    attribution_method,
    status,
    rejection_reason
  ) values (
    product_id_value,
    affiliate_id_value,
    click_record_id,
    source_id_value,
    campaign_id_value,
    funnel_id_value,
    country_value,
    'deterministic_web',
    case when bot_value then 'rejected'::public.acquisition_status else 'open'::public.acquisition_status end,
    case when bot_value then 'automated_traffic' else null end
  );

  return query select generated_click_id, destination_value, bot_value;
end;
$$;

create or replace function public.ingest_browser_event(p_input jsonb)
returns table (
  event_id uuid,
  duplicate boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'event_id', 'event_name', 'click_id', 'occurred_at', 'properties'
  ];
  allowed_event_names constant text[] := array[
    'landing_viewed', 'funnel_started', 'payment_viewed', 'app_store_clicked'
  ];
  browser_events_per_minute constant integer := 30;
  browser_events_per_click constant integer := 200;
  external_event_id uuid;
  event_name_value text;
  occurred_at_value timestamptz;
  properties_value jsonb;
  source_event_key text;
  click_record public.clicks%rowtype;
  acquisition_record public.acquisitions%rowtype;
  existing_event public.events%rowtype;
  inserted_event_id uuid;
  rate_now timestamptz := statement_timestamp();
  recent_count bigint;
  lifetime_count bigint;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'browser event input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(p_input) as input_key
    where input_key <> all(allowed_keys)
  ) then
    raise exception 'browser event input contains unsupported fields' using errcode = '22023';
  end if;
  if not (p_input ? 'event_id')
     or not (p_input ? 'event_name')
     or not (p_input ? 'click_id')
     or not (p_input ? 'occurred_at') then
    raise exception 'event_id, event_name, click_id, and occurred_at are required'
      using errcode = '22023';
  end if;

  begin
    external_event_id := (p_input ->> 'event_id')::uuid;
    occurred_at_value := (p_input ->> 'occurred_at')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception 'event_id and occurred_at must use canonical UUID and timestamp values'
      using errcode = '22023';
  end;

  event_name_value := trim(p_input ->> 'event_name');
  if event_name_value <> all(allowed_event_names) then
    raise exception 'browser event name is not allowed' using errcode = '22023';
  end if;

  properties_value := coalesce(p_input -> 'properties', '{}'::jsonb);
  if jsonb_typeof(properties_value) <> 'object' or octet_length(properties_value::text) > 8192 then
    raise exception 'browser event properties must be a JSON object no larger than 8 KiB'
      using errcode = '22023';
  end if;
  if properties_value ?| array[
    'affiliate_id', 'product_id', 'funnel_id', 'source_id', 'campaign_id',
    'amount', 'amount_minor', 'currency', 'price', 'revenue'
  ] then
    raise exception 'browser event properties contain reserved commercial or identity fields'
      using errcode = '22023';
  end if;

  -- Serializing on the canonical click closes the concurrent duplicate/rate
  -- race without creating another table that could drift from event evidence.
  select * into click_record
  from public.clicks
  where public_click_id = p_input ->> 'click_id'
  for update;

  if click_record.id is null or click_record.is_bot then
    raise exception 'click is unavailable for event ingestion' using errcode = 'P0002';
  end if;

  select * into acquisition_record
  from public.acquisitions
  where click_record_id = click_record.id;

  if acquisition_record.id is null or acquisition_record.status = 'rejected' then
    raise exception 'acquisition is unavailable for event ingestion' using errcode = 'P0002';
  end if;
  if occurred_at_value < click_record.occurred_at - interval '5 minutes'
     or occurred_at_value > now() + interval '5 minutes' then
    raise exception 'event timestamp is outside the accepted clock bounds' using errcode = '22023';
  end if;

  source_event_key := 'browser:' || external_event_id::text;
  select * into existing_event
  from public.events
  where source = 'first_party' and source_event_id = source_event_key;

  -- An exact retry is a successful no-op even after this click has reached a
  -- rate boundary. A conflicting retry remains a uniqueness violation.
  if existing_event.id is not null then
    if existing_event.acquisition_id is distinct from acquisition_record.id
       or existing_event.event_name <> event_name_value
       or existing_event.schema_version <> 1
       or existing_event.product_id <> acquisition_record.product_id
       or existing_event.affiliate_id is distinct from acquisition_record.affiliate_id
       or existing_event.account_id is distinct from acquisition_record.account_id
       or existing_event.source_id is distinct from acquisition_record.source_id
       or existing_event.campaign_id is distinct from acquisition_record.campaign_id
       or existing_event.funnel_id is distinct from acquisition_record.funnel_id
       or existing_event.provider_event_id is not null
       or existing_event.occurred_at <> occurred_at_value
       or existing_event.properties <> properties_value
       or existing_event.trust <> 'browser'
       or existing_event.commercial_eligible then
      raise exception 'event ID has already been used for different browser evidence'
        using errcode = '23505';
    end if;
    return query select existing_event.id, true;
    return;
  end if;

  select count(*) into recent_count
  from public.events as event
  where event.acquisition_id = acquisition_record.id
    and event.trust = 'browser'
    and event.created_at >= rate_now - interval '1 minute';

  select count(*) into lifetime_count
  from public.events as event
  where event.acquisition_id = acquisition_record.id
    and event.trust = 'browser';

  if recent_count >= browser_events_per_minute
     or lifetime_count >= browser_events_per_click then
    raise exception 'browser event rate limit exceeded' using errcode = 'KMA29';
  end if;

  insert into public.events (
    source,
    source_event_id,
    event_name,
    product_id,
    affiliate_id,
    acquisition_id,
    account_id,
    source_id,
    campaign_id,
    funnel_id,
    properties,
    occurred_at,
    trust,
    commercial_eligible
  ) values (
    'first_party',
    source_event_key,
    event_name_value,
    acquisition_record.product_id,
    acquisition_record.affiliate_id,
    acquisition_record.id,
    acquisition_record.account_id,
    acquisition_record.source_id,
    acquisition_record.campaign_id,
    acquisition_record.funnel_id,
    properties_value,
    occurred_at_value,
    'browser',
    false
  )
  on conflict (source, source_event_id) do nothing
  returning id into inserted_event_id;

  if inserted_event_id is null then
    -- The unique index may have been won concurrently by a request for a
    -- different click. Re-read and accept only byte-for-byte equivalent
    -- canonical evidence; no existing event row is ever updated.
    select * into existing_event
    from public.events
    where source = 'first_party' and source_event_id = source_event_key;

    if existing_event.id is null
       or existing_event.acquisition_id is distinct from acquisition_record.id
       or existing_event.event_name <> event_name_value
       or existing_event.schema_version <> 1
       or existing_event.product_id <> acquisition_record.product_id
       or existing_event.affiliate_id is distinct from acquisition_record.affiliate_id
       or existing_event.account_id is distinct from acquisition_record.account_id
       or existing_event.source_id is distinct from acquisition_record.source_id
       or existing_event.campaign_id is distinct from acquisition_record.campaign_id
       or existing_event.funnel_id is distinct from acquisition_record.funnel_id
       or existing_event.provider_event_id is not null
       or existing_event.occurred_at <> occurred_at_value
       or existing_event.properties <> properties_value
       or existing_event.trust <> 'browser'
       or existing_event.commercial_eligible then
      raise exception 'event ID has already been used for different browser evidence'
        using errcode = '23505';
    end if;

    return query select existing_event.id, true;
    return;
  end if;

  return query select inserted_event_id, false;
end;
$$;

create or replace function public.ingest_funnel_event(p_input jsonb)
returns table (
  event_id uuid,
  duplicate boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'event_id', 'event_name', 'click_id', 'occurred_at', 'properties'
  ];
  external_event_id uuid;
  event_name_value text;
  occurred_at_value timestamptz;
  properties_value jsonb;
  source_event_key text;
  click_record public.clicks%rowtype;
  acquisition_record public.acquisitions%rowtype;
  existing_event public.events%rowtype;
  inserted_event_id uuid;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'funnel event input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(p_input) as input_key
    where input_key <> all(allowed_keys)
  ) then
    raise exception 'funnel event input contains unsupported fields' using errcode = '22023';
  end if;
  if not (p_input ? 'event_id')
     or not (p_input ? 'event_name')
     or not (p_input ? 'click_id')
     or not (p_input ? 'occurred_at') then
    raise exception 'event_id, event_name, click_id, and occurred_at are required'
      using errcode = '22023';
  end if;

  begin
    external_event_id := (p_input ->> 'event_id')::uuid;
    occurred_at_value := (p_input ->> 'occurred_at')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception 'event_id and occurred_at must use canonical UUID and timestamp values'
      using errcode = '22023';
  end;

  event_name_value := trim(p_input ->> 'event_name');
  if event_name_value !~ '^[a-z][a-z0-9_.-]{0,99}$' then
    raise exception 'funnel event name is invalid' using errcode = '22023';
  end if;

  properties_value := coalesce(p_input -> 'properties', '{}'::jsonb);
  if jsonb_typeof(properties_value) <> 'object' or octet_length(properties_value::text) > 16384 then
    raise exception 'funnel event properties must be a JSON object no larger than 16 KiB'
      using errcode = '22023';
  end if;
  if properties_value ?| array[
    'affiliate_id', 'product_id', 'funnel_id', 'source_id', 'campaign_id',
    'amount', 'amount_minor', 'currency', 'price', 'revenue'
  ] then
    raise exception 'funnel event properties contain reserved commercial or identity fields'
      using errcode = '22023';
  end if;

  -- Serialize requests for one click. This guarantees that an exact retry for
  -- that click observes the committed event before doing any later work.
  select * into click_record
  from public.clicks
  where public_click_id = p_input ->> 'click_id'
  for update;

  if click_record.id is null or click_record.is_bot then
    raise exception 'click is unavailable for event ingestion' using errcode = 'P0002';
  end if;

  select * into acquisition_record
  from public.acquisitions
  where click_record_id = click_record.id;

  if acquisition_record.id is null or acquisition_record.status = 'rejected' then
    raise exception 'acquisition is unavailable for event ingestion' using errcode = 'P0002';
  end if;
  if occurred_at_value < click_record.occurred_at - interval '5 minutes'
     or occurred_at_value > now() + interval '5 minutes' then
    raise exception 'event timestamp is outside the accepted clock bounds' using errcode = '22023';
  end if;

  source_event_key := 'funnel:' || external_event_id::text;
  select * into existing_event
  from public.events
  where source = 'first_party' and source_event_id = source_event_key;

  if existing_event.id is not null then
    if existing_event.acquisition_id is distinct from acquisition_record.id
       or existing_event.event_name <> event_name_value
       or existing_event.schema_version <> 1
       or existing_event.product_id <> acquisition_record.product_id
       or existing_event.affiliate_id is distinct from acquisition_record.affiliate_id
       or existing_event.account_id is distinct from acquisition_record.account_id
       or existing_event.source_id is distinct from acquisition_record.source_id
       or existing_event.campaign_id is distinct from acquisition_record.campaign_id
       or existing_event.funnel_id is distinct from acquisition_record.funnel_id
       or existing_event.provider_event_id is not null
       or existing_event.occurred_at <> occurred_at_value
       or existing_event.properties <> properties_value
       or existing_event.trust <> 'funnel_server'
       or not existing_event.commercial_eligible then
      raise exception 'event ID has already been used for different funnel evidence'
        using errcode = '23505';
    end if;
    return query select existing_event.id, true;
    return;
  end if;

  insert into public.events (
    source,
    source_event_id,
    event_name,
    product_id,
    affiliate_id,
    acquisition_id,
    account_id,
    source_id,
    campaign_id,
    funnel_id,
    properties,
    occurred_at,
    trust,
    commercial_eligible
  ) values (
    'first_party',
    source_event_key,
    event_name_value,
    acquisition_record.product_id,
    acquisition_record.affiliate_id,
    acquisition_record.id,
    acquisition_record.account_id,
    acquisition_record.source_id,
    acquisition_record.campaign_id,
    acquisition_record.funnel_id,
    properties_value,
    occurred_at_value,
    'funnel_server',
    true
  )
  on conflict (source, source_event_id) do nothing
  returning id into inserted_event_id;

  if inserted_event_id is null then
    select * into existing_event
    from public.events
    where source = 'first_party' and source_event_id = source_event_key;

    if existing_event.id is null
       or existing_event.acquisition_id is distinct from acquisition_record.id
       or existing_event.event_name <> event_name_value
       or existing_event.schema_version <> 1
       or existing_event.product_id <> acquisition_record.product_id
       or existing_event.affiliate_id is distinct from acquisition_record.affiliate_id
       or existing_event.account_id is distinct from acquisition_record.account_id
       or existing_event.source_id is distinct from acquisition_record.source_id
       or existing_event.campaign_id is distinct from acquisition_record.campaign_id
       or existing_event.funnel_id is distinct from acquisition_record.funnel_id
       or existing_event.provider_event_id is not null
       or existing_event.occurred_at <> occurred_at_value
       or existing_event.properties <> properties_value
       or existing_event.trust <> 'funnel_server'
       or not existing_event.commercial_eligible then
      raise exception 'event ID has already been used for different funnel evidence'
        using errcode = '23505';
    end if;

    return query select existing_event.id, true;
    return;
  end if;

  return query select inserted_event_id, false;
end;
$$;

revoke all on function public.assert_funnel_request_scope(text, text, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.register_tracking_click(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.ingest_browser_event(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.ingest_funnel_event(jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.assert_funnel_request_scope(text, text, uuid, uuid)
  to service_role;
grant execute on function public.register_tracking_click(text, text, jsonb)
  to service_role;
grant execute on function public.ingest_browser_event(jsonb)
  to service_role;
grant execute on function public.ingest_funnel_event(jsonb)
  to service_role;

comment on function public.assert_funnel_request_scope(text, text, uuid, uuid) is
  'After Edge HMAC authentication and key binding resolution, verifies that a non-bot canonical click and acquisition exactly match the asserted product and funnel without exposing tenant data.';
comment on function public.register_tracking_click(text, text, jsonb) is
  'Registers a canonical redirect click and acquisition with per-link hashed-IP and hashed-session one-minute abuse bounds (300 and 30 respectively).';
comment on function public.ingest_browser_event(jsonb) is
  'Records allowlisted non-commercial browser evidence with exact retry idempotency, a 30-per-minute rate bound, and a 200-event lifetime bound per canonical click.';
comment on function public.ingest_funnel_event(jsonb) is
  'Records trusted funnel-server evidence with atomic insert-or-compare idempotency; exact retries succeed and conflicting event identifiers fail closed.';
