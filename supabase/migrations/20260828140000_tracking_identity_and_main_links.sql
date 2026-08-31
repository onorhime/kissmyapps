create type public.event_trust as enum ('browser', 'funnel_server', 'provider', 'admin');

alter table public.platform_settings
  add column tracking_enabled boolean not null default false;

alter table public.funnels
  add column is_default boolean not null default false;

create unique index funnels_one_default_per_product
  on public.funnels (product_id)
  where is_default and status <> 'archived';

alter table public.affiliate_links
  add column is_main boolean not null default false;

alter table public.affiliate_links
  alter column sub1 drop not null;

create unique index affiliate_links_one_current_main_per_partner_product
  on public.affiliate_links (affiliate_id, product_id)
  where is_main and status <> 'archived';

alter table public.clicks
  add column sub1 text,
  add column sub2 text,
  add column sub3 text,
  add column destination_url_snapshot text not null;

alter table public.clicks
  add constraint clicks_sub1_format check (
    sub1 is null or (char_length(sub1) <= 64 and sub1 ~ '^[A-Za-z0-9_-]+$')
  ),
  add constraint clicks_sub2_format check (
    sub2 is null or (char_length(sub2) <= 64 and sub2 ~ '^[A-Za-z0-9_-]+$')
  ),
  add constraint clicks_sub3_format check (
    sub3 is null or (char_length(sub3) <= 64 and sub3 ~ '^[A-Za-z0-9_-]+$')
  ),
  add constraint clicks_destination_url_snapshot_valid check (
    destination_url_snapshot ~ '^https://' and char_length(destination_url_snapshot) <= 2000
  );

alter table public.events
  add column trust public.event_trust not null default 'browser',
  add column commercial_eligible boolean not null default false,
  add constraint events_commercial_trust_valid check (
    not commercial_eligible or trust in ('funnel_server', 'provider', 'admin')
  );

create or replace function public.agreement_is_launch_ready(
  p_agreement_id uuid,
  p_at timestamptz default now()
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select
      agreement.status = 'active'
      and agreement.starts_at <= p_at
      and (agreement.ends_at is null or agreement.ends_at > p_at)
      and (
        select count(*) = 1
        from public.commission_rules as rule
        where rule.agreement_id = agreement.id
          and rule.status = 'active'
      )
      and exists (
        select 1
        from public.commission_rules as rule
        where rule.agreement_id = agreement.id
          and rule.status = 'active'
          and rule.model = agreement.model
          and rule.model in ('cpa', 'revenue_share', 'hybrid')
          and rule.trigger_event = 'purchase.completed'
          and (rule.currency is null or rule.currency = agreement.payout_currency)
      )
      and exists (
        select 1
        from public.documents as document
        where document.agreement_id = agreement.id
          and document.affiliate_id = agreement.affiliate_id
          and document.status in ('signed', 'active')
          and document.signed_by_partner_at is not null
          and document.signed_by_partner_at <= p_at
          and document.signed_by_kissmyapps_at is not null
          and document.signed_by_kissmyapps_at <= p_at
          and (document.effective_at is null or document.effective_at <= p_at)
          and (document.expires_at is null or document.expires_at > p_at)
          and document.terminated_at is null
      )
    from public.agreements as agreement
    where agreement.id = p_agreement_id
  ), false);
$$;

create or replace function public.validate_affiliate_link()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  funnel_product uuid;
  funnel_state text;
  funnel_is_default boolean;
  product_state public.product_status;
  campaign_product uuid;
  campaign_state text;
  parent_record public.affiliate_links%rowtype;
  old_status public.link_status;
  expected_tracking_url text;
begin
  select funnel.product_id, funnel.status, funnel.is_default
  into funnel_product, funnel_state, funnel_is_default
  from public.funnels as funnel
  where funnel.id = new.funnel_id;

  if funnel_product is distinct from new.product_id then
    raise exception 'funnel does not belong to the selected product' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and (
    new.affiliate_id <> old.affiliate_id
    or new.product_id <> old.product_id
    or new.funnel_id <> old.funnel_id
    or new.source_id is distinct from old.source_id
    or new.campaign_id is distinct from old.campaign_id
    or new.public_code <> old.public_code
    or new.tracking_url <> old.tracking_url
    or new.parent_link_id is distinct from old.parent_link_id
    or new.sub1 is distinct from old.sub1
    or new.sub2 is distinct from old.sub2
    or new.sub3 is distinct from old.sub3
    or new.is_main <> old.is_main
  ) then
    raise exception 'issued link attribution identity and routing are immutable' using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    select setting.tracking_base_url || '/r/' || affiliate.slug || '/' || new.public_code
    into expected_tracking_url
    from public.affiliates as affiliate
    cross join public.platform_settings as setting
    where affiliate.id = new.affiliate_id and setting.singleton;

    if expected_tracking_url is null or new.tracking_url <> expected_tracking_url then
      raise exception 'tracking URL must be issued from the configured tracking domain' using errcode = '23514';
    end if;
  end if;

  if new.is_main then
    if new.parent_link_id is not null
       or new.source_id is not null
       or new.campaign_id is not null
       or new.sub1 is not null
       or new.sub2 is not null
       or new.sub3 is not null then
      raise exception 'main links cannot contain parent, source, campaign, or Sub ID dimensions'
        using errcode = '23514';
    end if;
    if not coalesce(funnel_is_default, false) then
      raise exception 'a main link must route through the product default funnel'
        using errcode = '23514';
    end if;
  end if;

  if new.campaign_id is not null then
    select campaign.product_id, campaign.status
    into campaign_product, campaign_state
    from public.campaigns as campaign
    where campaign.id = new.campaign_id;

    if campaign_product is distinct from new.product_id then
      raise exception 'campaign does not belong to the selected product' using errcode = '23514';
    end if;
    if new.status = 'active' and campaign_state <> 'active' then
      raise exception 'active links require an active campaign' using errcode = '23514';
    end if;
  end if;

  if new.parent_link_id is not null then
    select * into parent_record
    from public.affiliate_links
    where id = new.parent_link_id;

    if parent_record.id is null
       or not parent_record.is_main
       or parent_record.status = 'archived'
       or parent_record.affiliate_id <> new.affiliate_id
       or parent_record.product_id <> new.product_id then
      raise exception 'parent link must be the current main link in the same partner product'
        using errcode = '23514';
    end if;
  end if;

  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    select product.status into product_state
    from public.products as product
    where product.id = new.product_id;

    if product_state <> 'active'
       or funnel_state <> 'live'
       or not exists (
         select 1
         from public.agreements as agreement
         where agreement.affiliate_id = new.affiliate_id
           and agreement.product_id = new.product_id
           and public.agreement_is_launch_ready(agreement.id, now())
       ) then
      raise exception 'active link requires an active product, live funnel, and launch-ready signed agreement'
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    old_status := old.status;
    if not (
      (old_status = 'active' and new.status in ('paused', 'archived'))
      or (old_status = 'paused' and new.status in ('active', 'archived'))
      or (old_status = 'archived' and new.status = 'paused')
    ) then
      raise exception 'invalid affiliate link status transition: % -> %', old.status, new.status
        using errcode = 'P0001';
    end if;
    new.status_changed_at := now();
    if new.status = 'archived' then
      new.archived_at := now();
    elsif old.status = 'archived' then
      new.archived_at := null;
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.validate_click_dimensions()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  link_record public.affiliate_links%rowtype;
  funnel_destination text;
begin
  select * into link_record
  from public.affiliate_links
  where id = new.affiliate_link_id;

  select funnel.destination_url into funnel_destination
  from public.funnels as funnel
  where funnel.id = new.funnel_id;

  if link_record.id is null
     or link_record.affiliate_id <> new.affiliate_id
     or link_record.product_id <> new.product_id
     or link_record.funnel_id <> new.funnel_id
     or link_record.source_id is distinct from new.source_id
     or link_record.campaign_id is distinct from new.campaign_id
     or link_record.sub1 is distinct from new.sub1
     or link_record.sub2 is distinct from new.sub2
     or link_record.sub3 is distinct from new.sub3
     or funnel_destination is null
     or funnel_destination is distinct from new.destination_url_snapshot then
    raise exception 'click dimensions and destination must match the issued affiliate link'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_event_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  acquisition_record public.acquisitions%rowtype;
  provider_record public.provider_events%rowtype;
begin
  if jsonb_typeof(new.properties) <> 'object' or octet_length(new.properties::text) > 16384 then
    raise exception 'event properties must be a JSON object no larger than 16 KiB'
      using errcode = '22023';
  end if;

  if new.acquisition_id is not null then
    select * into acquisition_record
    from public.acquisitions
    where id = new.acquisition_id;

    if acquisition_record.id is null
       or acquisition_record.product_id <> new.product_id
       or acquisition_record.affiliate_id is distinct from new.affiliate_id
       or acquisition_record.account_id is distinct from new.account_id
       or acquisition_record.source_id is distinct from new.source_id
       or acquisition_record.campaign_id is distinct from new.campaign_id
       or acquisition_record.funnel_id is distinct from new.funnel_id then
      raise exception 'event dimensions must match its canonical acquisition'
        using errcode = '23514';
    end if;
  elsif new.trust in ('browser', 'funnel_server') then
    raise exception 'browser and funnel events require a canonical acquisition'
      using errcode = '23514';
  end if;

  if new.trust = 'browser' then
    if new.source <> 'first_party' or new.provider_event_id is not null or new.commercial_eligible then
      raise exception 'browser events are non-commercial first-party evidence only'
        using errcode = '23514';
    end if;
  elsif new.trust = 'funnel_server' then
    if new.source <> 'first_party' or new.provider_event_id is not null then
      raise exception 'funnel-server events must be first-party evidence'
        using errcode = '23514';
    end if;
  elsif new.trust = 'provider' then
    select * into provider_record
    from public.provider_events
    where id = new.provider_event_id;

    if provider_record.id is null
       or not provider_record.signature_verified
       or (new.source = 'stripe' and provider_record.provider <> 'stripe')
       or (new.source = 'singular' and provider_record.provider <> 'singular')
       or new.source not in ('stripe', 'singular') then
      raise exception 'provider events require matching signature-verified provider evidence'
        using errcode = '23514';
    end if;
  elsif new.trust = 'admin' then
    if new.source <> 'manual' or new.provider_event_id is not null then
      raise exception 'administrator events must be manual evidence without a provider callback'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists events_validate_identity on public.events;
create trigger events_validate_identity
  before insert on public.events
  for each row execute function public.validate_event_identity();

create or replace function public.validate_conversion()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  acquisition_record public.acquisitions%rowtype;
  agreement_record public.agreements%rowtype;
  rule_record public.commission_rules%rowtype;
  event_record public.events%rowtype;
  transaction_record public.transactions%rowtype;
  subscription_record public.subscriptions%rowtype;
begin
  select * into acquisition_record from public.acquisitions where id = new.acquisition_id;
  select * into agreement_record from public.agreements where id = new.agreement_id;
  select * into rule_record from public.commission_rules where id = new.commission_rule_id;
  select * into event_record from public.events where id = new.event_id;

  if acquisition_record.product_id <> new.product_id
     or acquisition_record.affiliate_id is distinct from new.affiliate_id
     or agreement_record.product_id <> new.product_id
     or agreement_record.affiliate_id <> new.affiliate_id
     or rule_record.agreement_id <> new.agreement_id
     or event_record.product_id <> new.product_id
     or event_record.affiliate_id is distinct from new.affiliate_id
     or event_record.acquisition_id is distinct from new.acquisition_id
     or event_record.account_id is distinct from new.account_id
     or acquisition_record.account_id is distinct from new.account_id then
    raise exception 'conversion identity does not match acquisition, agreement, rule, and event'
      using errcode = '23514';
  end if;
  if acquisition_record.status <> 'resolved'
     or (new.qualified and acquisition_record.account_id is null)
     or new.event_name <> event_record.event_name
     or new.event_name <> rule_record.trigger_event
     or new.occurred_at <> event_record.occurred_at then
    raise exception 'conversion requires a resolved acquisition and the exact qualifying trigger event'
      using errcode = '23514';
  end if;
  if agreement_record.status not in ('active', 'superseded', 'expired', 'terminated')
     or rule_record.status <> 'active'
     or agreement_record.starts_at > new.occurred_at
     or (agreement_record.ends_at is not null and agreement_record.ends_at <= new.occurred_at) then
    raise exception 'conversion requires an immutable agreement version and active rule effective at the event time'
      using errcode = '23514';
  end if;
  if event_record.source not in ('first_party', 'stripe', 'singular', 'manual') then
    raise exception 'behavioral analytics sources cannot qualify commercial conversions'
      using errcode = '23514';
  end if;
  if new.occurred_at < acquisition_record.created_at
     or new.occurred_at > acquisition_record.created_at
       + make_interval(days => agreement_record.attribution_window_days) then
    raise exception 'conversion is outside its agreement attribution window'
      using errcode = '23514';
  end if;
  if rule_record.model in ('cpa', 'revenue_share', 'hybrid') and new.transaction_id is null then
    raise exception 'CPA, revenue-share, and hybrid conversions require a canonical transaction'
      using errcode = '23514';
  end if;
  if rule_record.model = 'cpl' and new.transaction_id is not null then
    raise exception 'CPL conversions cannot be qualified from a billing transaction'
      using errcode = '23514';
  end if;
  if rule_record.model = 'cpl'
     and new.qualified
     and (not event_record.commercial_eligible or event_record.trust = 'browser') then
    raise exception 'non-transaction conversions require trusted commercial event evidence'
      using errcode = '23514';
  end if;
  if new.transaction_id is not null then
    select * into transaction_record from public.transactions where id = new.transaction_id;
    select * into subscription_record from public.subscriptions where id = transaction_record.subscription_id;
    if transaction_record.id is null
       or transaction_record.acquisition_id is distinct from new.acquisition_id
       or subscription_record.id is null
       or subscription_record.acquisition_id is distinct from new.acquisition_id
       or subscription_record.account_id is distinct from new.account_id
       or subscription_record.product_id <> new.product_id
       or subscription_record.currency <> agreement_record.payout_currency
       or transaction_record.currency <> agreement_record.payout_currency
       or transaction_record.settled_currency <> agreement_record.payout_currency then
      raise exception 'conversion transaction and subscription must match acquisition, account, product, and payout currency'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace view public.partner_product_directory
with (security_barrier = true)
as
select distinct
  product.id,
  product.slug,
  product.name,
  product.status,
  agreement.status as agreement_status,
  agreement.model as commercial_model,
  agreement.payout_currency,
  exists (
    select 1
    from public.funnels as live_funnel
    where live_funnel.product_id = product.id and live_funnel.status = 'live'
  ) as has_live_funnel,
  case
    when affiliate.status = 'active'
      and product.status = 'active'
      and exists (
        select 1
        from public.agreements as ready_agreement
        where ready_agreement.id = agreement.id
          and ready_agreement.status = 'active'
          and ready_agreement.starts_at <= now()
          and (ready_agreement.ends_at is null or ready_agreement.ends_at > now())
          and (
            select count(*) = 1
            from public.commission_rules as active_rule
            where active_rule.agreement_id = ready_agreement.id
              and active_rule.status = 'active'
          )
          and exists (
            select 1
            from public.commission_rules as purchase_rule
            where purchase_rule.agreement_id = ready_agreement.id
              and purchase_rule.status = 'active'
              and purchase_rule.model = ready_agreement.model
              and purchase_rule.model in ('cpa', 'revenue_share', 'hybrid')
              and purchase_rule.trigger_event = 'purchase.completed'
              and (
                purchase_rule.currency is null
                or purchase_rule.currency = ready_agreement.payout_currency
              )
          )
          and exists (
            select 1
            from public.documents as signed_document
            where signed_document.agreement_id = ready_agreement.id
              and signed_document.affiliate_id = ready_agreement.affiliate_id
              and signed_document.status in ('signed', 'active')
              and signed_document.signed_by_partner_at is not null
              and signed_document.signed_by_partner_at <= now()
              and signed_document.signed_by_kissmyapps_at is not null
              and signed_document.signed_by_kissmyapps_at <= now()
              and (signed_document.effective_at is null or signed_document.effective_at <= now())
              and (signed_document.expires_at is null or signed_document.expires_at > now())
              and signed_document.terminated_at is null
          )
      )
      and setting.tracking_enabled
      and main_link.tracking_url is not null
    then main_link.tracking_url
    else null
  end as main_tracking_url
from public.affiliate_users as membership
join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
join public.products as product on (
  exists (
    select 1
    from public.agreements as agreement
    where agreement.affiliate_id = membership.affiliate_id
      and agreement.product_id = product.id
  )
  or exists (
    select 1
    from public.affiliate_links as link
    where link.affiliate_id = membership.affiliate_id
      and link.product_id = product.id
  )
  or exists (
    select 1
    from public.payouts as payout
    where payout.affiliate_id = membership.affiliate_id
      and payout.product_id = product.id
  )
  or exists (
    select 1
    from public.affiliate_daily_metrics as metric
    where metric.affiliate_id = membership.affiliate_id
      and metric.product_id = product.id
  )
)
left join lateral (
  select candidate.id, candidate.status, candidate.model, candidate.payout_currency
  from public.agreements as candidate
  where candidate.affiliate_id = membership.affiliate_id
    and candidate.product_id = product.id
  order by (candidate.status = 'active') desc, candidate.version desc
  limit 1
) as agreement on true
left join lateral (
  select link.tracking_url
  from public.affiliate_links as link
  join public.funnels as funnel
    on funnel.id = link.funnel_id
   and funnel.product_id = link.product_id
   and funnel.is_default
   and funnel.status = 'live'
  where link.affiliate_id = membership.affiliate_id
    and link.product_id = product.id
    and link.is_main
    and link.status = 'active'
  order by link.created_at desc, link.id desc
  limit 1
) as main_link on true
left join public.platform_settings as setting on setting.singleton
where membership.user_id = auth.uid()
  and membership.active
  and affiliate.status in ('active', 'paused');

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

  select * into click_record
  from public.clicks
  where public_click_id = p_input ->> 'click_id';

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

  if existing_event.id is not null then
    if existing_event.acquisition_id is distinct from acquisition_record.id
       or existing_event.event_name <> event_name_value
       or existing_event.occurred_at <> occurred_at_value
       or existing_event.properties <> properties_value then
      raise exception 'event ID has already been used for different browser evidence'
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
    'browser',
    false
  ) returning id into inserted_event_id;

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

  select * into click_record
  from public.clicks
  where public_click_id = p_input ->> 'click_id';

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
       or existing_event.occurred_at <> occurred_at_value
       or existing_event.properties <> properties_value then
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
  ) returning id into inserted_event_id;

  return query select inserted_event_id, false;
end;
$$;

revoke all on function public.validate_event_identity() from public, anon, authenticated, service_role;
revoke all on function public.agreement_is_launch_ready(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.register_tracking_click(text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.ingest_browser_event(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.ingest_funnel_event(jsonb) from public, anon, authenticated, service_role;

grant usage on schema public to service_role;
grant execute on function public.register_tracking_click(text, text, jsonb) to service_role;
grant execute on function public.ingest_browser_event(jsonb) to service_role;
grant execute on function public.ingest_funnel_event(jsonb) to service_role;

comment on column public.platform_settings.tracking_enabled is
  'Production traffic kill switch. False keeps every redirect unavailable without creating a sandbox data mode.';
comment on column public.funnels.is_default is
  'Marks the sole default funnel eligible for a partner-product main link.';
comment on column public.affiliate_links.is_main is
  'True only for the canonical partner-product link through the default funnel.';
comment on column public.clicks.destination_url_snapshot is
  'Exact HTTPS funnel destination resolved atomically when the click was accepted.';
comment on column public.events.trust is
  'Evidence origin used to separate browser behavior from authenticated funnel, provider, or administrator facts.';
comment on column public.events.commercial_eligible is
  'True only for trusted evidence that may support a non-transaction commercial conversion.';
comment on function public.register_tracking_click(text, text, jsonb) is
  'Service-only production redirect boundary; atomically records one immutable click and acquisition and returns the destination.';
comment on function public.ingest_browser_event(jsonb) is
  'Service-only idempotent browser behavior boundary. Browser evidence is always non-commercial.';
comment on function public.ingest_funnel_event(jsonb) is
  'Service-only idempotent persistence boundary called only after the Edge layer authenticates a funnel server.';
