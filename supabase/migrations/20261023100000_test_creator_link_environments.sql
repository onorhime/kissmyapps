-- Explicit creator-link environments. Existing links and issued URLs remain untouched.
-- TEST uses the same signed agreement and rules; never tracking-only and never LIVE money.
begin;
alter table public.affiliate_links add column tracking_environment text check(tracking_environment in('test','live'));
comment on column public.affiliate_links.tracking_environment is 'Immutable issuance environment. Null preserves legacy link behaviour; new admin main links explicitly choose test/live.';
drop index public.affiliate_links_one_current_main_per_partner_product;
create unique index affiliate_links_one_current_main_per_partner_product on public.affiliate_links(affiliate_id,product_id,coalesce(tracking_environment,'live')) where is_main and status<>'archived';
drop index public.affiliate_links_active_dimensions_unique;
create unique index affiliate_links_active_dimensions_unique on public.affiliate_links(affiliate_id,product_id,coalesce(tracking_environment,'live'),coalesce(source_id,'00000000-0000-0000-0000-000000000000'::uuid),coalesce(campaign_id,'00000000-0000-0000-0000-000000000000'::uuid),funnel_id,coalesce(sub1,''),coalesce(sub2,''),coalesce(sub3,'')) where status<>'archived';
create function kma_internal.billing_offer_is_test_ready(p_offer_id uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.billing_offers offer
 join public.products product on product.id=offer.product_id and product.status='active' and product.tracking_mode='commercial'
 join public.managed_payment_products managed on managed.product_id=product.id and managed.enabled
 where offer.id=p_offer_id and offer.status='active' and offer.billing_mode='payment'
 and offer.stripe_price_id is not null and offer.currency is not null and offer.unit_amount_minor is not null
 and position('{CHECKOUT_SESSION_ID}' in offer.success_url_template)>0
 and public.is_production_https_url(offer.success_url_template,true) and public.is_production_https_url(offer.cancel_url,true)
 and exists(select 1 from public.managed_payment_offer_prices proof where proof.offer_id=offer.id and not proof.livemode
 and proof.offer_version=offer.version and proof.configured_price_id=offer.stripe_price_id and proof.currency=offer.currency and proof.unit_amount_minor=offer.unit_amount_minor and proof.verified_at is not null
 and (not exists(select 1 from public.product_merchant_connections assignment where assignment.product_id=offer.product_id and not assignment.livemode)
 or exists(select 1 from public.product_merchant_connections assignment join public.merchant_connections connection on connection.id=assignment.connection_id
 where assignment.product_id=offer.product_id and not assignment.livemode and not connection.livemode and connection.account_id=proof.account_id and connection.status='active' and connection.charges_enabled and connection.details_submitted))));
$$;
create function kma_internal.product_has_environment_offer(p_product uuid,p_environment text) returns boolean language sql stable set search_path='' as $$
 select case when p_environment='test' then exists(select 1 from public.billing_offers o where o.product_id=p_product and kma_internal.billing_offer_is_test_ready(o.id)) else public.product_has_launch_ready_billing_offer(p_product) end;
$$;
create function kma_internal.validate_link_environment() returns trigger language plpgsql set search_path='' as $$
declare parent_environment text;
begin
 if tg_op='UPDATE' and new.tracking_environment is distinct from old.tracking_environment then raise exception 'Issued link environment is immutable' using errcode='23514';end if;
 if tg_op='INSERT' and new.parent_link_id is not null then
  select tracking_environment into parent_environment from public.affiliate_links where id=new.parent_link_id;
  if new.tracking_environment is not null and new.tracking_environment is distinct from parent_environment then raise exception 'Child link must inherit its parent environment' using errcode='23514';end if;
  new.tracking_environment:=parent_environment;
 end if;
 if new.tracking_environment='test' and not new.commercial_eligible then raise exception 'TEST links require the normal commercial agreement and price configuration' using errcode='23514';end if;
 return new;
end;$$;
create trigger affiliate_links_00_environment before insert or update on public.affiliate_links for each row execute function kma_internal.validate_link_environment();
create or replace function public.validate_active_link_billing_readiness() returns trigger language plpgsql set search_path='' as $$
begin
 if new.status='active' then
  if new.commercial_eligible then
   if not kma_internal.product_has_environment_offer(new.product_id,new.tracking_environment) then raise exception 'active links require an active verified offer for their TEST or LIVE environment' using errcode='P0001';end if;
  elsif not public.tracking_only_product_is_ready(new.product_id) then raise exception 'noncommercial links require a valid Owner-approved tracking-only product' using errcode='P0001';end if;
 end if;return new;
end;$$;


create or replace function public.issue_admin_main_link(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['affiliate_id', 'product_id', 'environment'];
  affiliate_id_value uuid;
  product_id_value uuid;
  existing public.affiliate_links%rowtype;
  funnel_record public.funnels%rowtype;
  affiliate_record public.affiliates%rowtype;
  product_record public.products%rowtype;
  tracking_base text;
  generated_code text;
  stored public.affiliate_links%rowtype;
  commercial_scope boolean;
  environment_value text:=coalesce(p_input->>'environment','live');
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'issue main links');
  if environment_value not in('test','live') or (p_input ? 'environment' and jsonb_typeof(p_input->'environment')<>'string') then raise exception 'Choose TEST or LIVE environment' using errcode='22023';end if;

  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'main-link input must contain exactly affiliate_id and product_id'
      using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     ) or not (p_input ?& array['affiliate_id','product_id']) then
    raise exception 'main-link input must contain exactly affiliate_id and product_id'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'affiliate_id') <> 'string'
     or jsonb_typeof(p_input -> 'product_id') <> 'string' then
    raise exception 'affiliate_id and product_id must be UUIDs' using errcode = '22023';
  end if;

  begin
    affiliate_id_value := nullif(trim(p_input ->> 'affiliate_id'), '')::uuid;
    product_id_value := nullif(trim(p_input ->> 'product_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'affiliate_id and product_id must be UUIDs' using errcode = '22023';
  end;

  if affiliate_id_value is null or product_id_value is null then
    raise exception 'affiliate_id and product_id are required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'main-link:' || affiliate_id_value::text || ':' || product_id_value::text,
      0
    )
  );

  select * into product_record
  from public.products as product
  where product.id = product_id_value and product.status = 'active'
  for share;
  commercial_scope := product_record.tracking_mode = 'commercial';

  select * into existing
  from public.affiliate_links as link
  where link.affiliate_id = affiliate_id_value
    and link.product_id = product_id_value
    and link.is_main
    and coalesce(link.tracking_environment,'live')=environment_value
    and link.status <> 'archived'
  order by link.created_at desc
  limit 1
  for share;

  select * into affiliate_record
  from public.affiliates as affiliate
  where affiliate.id = affiliate_id_value and affiliate.status = 'active'
  for share;

  select * into funnel_record
  from public.funnels as funnel
  where funnel.product_id = product_id_value
    and funnel.is_default
    and funnel.status = 'live'
    and funnel.destination_url is not null
  for share;

  select setting.tracking_base_url into tracking_base
  from public.platform_settings as setting
  where setting.singleton
    and setting.tracking_enabled
    and setting.tracking_base_url = 'https://go.kissmyapps.dev'
  for share;

  if affiliate_record.id is null or product_record.id is null
     or funnel_record.id is null or tracking_base is null then
    raise exception 'partner, product, default funnel, and production tracking must all be active'
      using errcode = 'P0001';
  end if;

  if commercial_scope then
    if not exists (
      select 1
      from public.agreements as agreement
      where agreement.affiliate_id = affiliate_id_value
        and agreement.product_id = product_id_value
        and public.agreement_is_launch_ready(agreement.id, now())
    ) then
      raise exception 'commercial main links require a signed agreement and purchase rule'
        using errcode = 'P0001';
    end if;
  elsif not public.tracking_only_product_is_ready(product_id_value)
        or product_record.tracking_only_funnel_id <> funnel_record.id
        or product_record.tracking_only_destination_url_snapshot <> funnel_record.destination_url then
    raise exception 'tracking-only main links require the exact Owner-approved funnel snapshot'
      using errcode = 'P0001';
  end if;

  if environment_value='test' and not commercial_scope then raise exception 'TEST links require a commercial product' using errcode='P0001';end if;
  if commercial_scope and not kma_internal.product_has_environment_offer(product_id_value,environment_value) then raise exception 'Main links require an active verified offer for the selected environment' using errcode='P0001';end if;

  -- Never return a previously issued demo link until its live product, exact
  -- approved funnel snapshot, and canonical gateway have all been rechecked.
  if existing.id is not null then
    if existing.commercial_eligible <> commercial_scope then
      raise exception 'current main link belongs to another commercial scope and must be archived'
        using errcode = 'P0001';
    end if;
    if not commercial_scope and existing.funnel_id <> funnel_record.id then
      raise exception 'current tracking-only main link belongs to a stale approved funnel'
        using errcode = 'P0001';
    end if;
    return to_jsonb(existing)||jsonb_build_object('environment',environment_value,'short_url',kma_internal.ensure_tracking_link_alias(existing.id));
  end if;

  generated_code := encode(extensions.gen_random_bytes(18), 'hex');
  insert into public.affiliate_links (
    affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
    parent_link_id, sub1, sub2, sub3, is_main, commercial_eligible, tracking_environment, created_by
  ) values (
    affiliate_id_value,
    product_id_value,
    funnel_record.id,
    product_record.name || ' · Main',
    generated_code,
    tracking_base || '/r/' || affiliate_record.slug || '/' || generated_code,
    null, null, null, null, true, commercial_scope, environment_value, auth.uid()
  ) returning * into stored;

  return to_jsonb(stored)||jsonb_build_object('environment',environment_value,'short_url',kma_internal.ensure_tracking_link_alias(stored.id));
end;
$$;

create or replace function kma_internal.ensure_tracking_link_alias(p_link_id uuid)
returns text language plpgsql volatile security definer set search_path='' as $$
declare
 link public.affiliate_links; creator public.affiliates; product public.products;
 creator_handle text; product_handle text; base text; candidate text; suffix integer;
 variant text; alias_path text;
begin
 select path into alias_path from kma_internal.tracking_link_aliases where link_id=p_link_id;
 if alias_path is not null then return 'https://go.kissmyapps.dev'||alias_path;end if;
 -- Issuance is rare; one transaction lock serializes readable namespace claims.
 -- Unique constraints are the final guard, including simultaneous name collisions.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('readable-tracking-alias-allocation',0));
 select path into alias_path from kma_internal.tracking_link_aliases where link_id=p_link_id;
 if alias_path is not null then return 'https://go.kissmyapps.dev'||alias_path;end if;
 select * into link from public.affiliate_links where id=p_link_id;
 if link.id is null then raise exception 'link unavailable' using errcode='P0002';end if;
 select * into creator from public.affiliates where id=link.affiliate_id;
 select * into product from public.products where id=link.product_id;
 select handle into creator_handle from kma_internal.creator_tracking_handles where affiliate_id=creator.id;
 if creator_handle is null then
  base:=kma_internal.readable_handle(case when creator.slug ~ '^partner-[0-9a-f]{24}$' then creator.public_name else creator.slug end,'creator',48);
  candidate:=base;suffix:=1;
  while exists(select 1 from kma_internal.creator_tracking_handles where handle=candidate) loop
   suffix:=suffix+1;if suffix>100000 then raise exception 'creator handle namespace exhausted' using errcode='54000';end if;
   candidate:=base||'-'||suffix;
  end loop;
  insert into kma_internal.creator_tracking_handles values(creator.id,candidate);creator_handle:=candidate;
 end if;
 select handle into product_handle from kma_internal.product_tracking_handles where product_id=product.id;
 if product_handle is null then
  base:=kma_internal.readable_handle(product.slug,'product',48);
  if base in ('r','tracking-redirect') then base:=base||'-product';end if;
  candidate:=base;suffix:=1;
  while exists(select 1 from kma_internal.product_tracking_handles where handle=candidate) loop
   suffix:=suffix+1;if suffix>100000 then raise exception 'product handle namespace exhausted' using errcode='54000';end if;
   candidate:=base||'-'||suffix;
  end loop;
  insert into kma_internal.product_tracking_handles values(product.id,candidate);product_handle:=candidate;
 end if;
 base:='/'||product_handle||'/'||creator_handle;
 if link.is_main then
  alias_path:=base||case when link.tracking_environment='test' then '/test' else '' end;suffix:=1;
  while exists(select 1 from kma_internal.tracking_link_aliases where path=alias_path) loop
   suffix:=suffix+1;if suffix>100000 then raise exception 'link alias namespace exhausted' using errcode='54000';end if;
   alias_path:=base||case when link.tracking_environment='test' then '/test-' else '/' end||suffix;
  end loop;
 else
  variant:=kma_internal.readable_handle(link.name,'link',40);
  alias_path:=base||'/'||variant;suffix:=1;
  while exists(select 1 from kma_internal.tracking_link_aliases where path=alias_path) loop
   suffix:=suffix+1;if suffix>100000 then raise exception 'link alias namespace exhausted' using errcode='54000';end if;
   alias_path:=base||'/'||variant||'-'||suffix;
  end loop;
 end if;
 insert into kma_internal.tracking_link_aliases(link_id,path) values(link.id,alias_path);
 return 'https://go.kissmyapps.dev'||alias_path;
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
  commercial_scope_value boolean;
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
    select 1 from jsonb_object_keys(p_context) as input_key
    where input_key <> all(allowed_keys)
  ) then
    raise exception 'tracking context contains unsupported fields' using errcode = '22023';
  end if;
  if nullif(trim(p_affiliate_slug), '') is null
     or nullif(trim(p_public_code), '') is null then
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
    funnel.destination_url,
    link.commercial_eligible
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
    destination_value,
    commercial_scope_value
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
    on setting.singleton
   and setting.tracking_enabled
   and setting.tracking_base_url = 'https://go.kissmyapps.dev'
  where affiliate.slug = trim(p_affiliate_slug)
    and link.public_code = trim(p_public_code)
    and link.status = 'active'
    and (link.campaign_id is null or campaign.status = 'active')
    and (
      (
        link.commercial_eligible
        and product.tracking_mode = 'commercial'
        and kma_internal.product_has_environment_offer(product.id,link.tracking_environment)
        and exists (
          select 1
          from public.agreements as agreement
          where agreement.affiliate_id = link.affiliate_id
            and agreement.product_id = link.product_id
            and public.agreement_is_launch_ready(agreement.id, now())
        )
      )
      or (
        not link.commercial_eligible
        and product.tracking_mode = 'tracking_only'
        and public.tracking_only_product_is_ready(product.id)
        and product.tracking_only_funnel_id = funnel.id
        and product.tracking_only_destination_url_snapshot = funnel.destination_url
      )
    )
  for share of link, product, funnel;

  if link_id_value is null then
    raise exception 'tracking route is unavailable' using errcode = 'P0002';
  end if;

  if ip_hash_value is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'tracking-click:ip:' || link_id_value::text || ':' || ip_hash_value, 0
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
        'tracking-click:session:' || link_id_value::text || ':' || session_hash_value, 0
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
    public_click_id, affiliate_link_id, affiliate_id, product_id, source_id,
    campaign_id, funnel_id, sub1, sub2, sub3, destination_url_snapshot,
    country_code, session_id_hash, user_agent_hash, ip_hash, is_bot,
    commercial_eligible
  ) values (
    generated_click_id, link_id_value, affiliate_id_value, product_id_value,
    source_id_value, campaign_id_value, funnel_id_value, sub1_value, sub2_value,
    sub3_value, destination_value, country_value, session_hash_value,
    user_agent_hash_value, ip_hash_value, bot_value, commercial_scope_value
  ) returning id into click_record_id;

  insert into public.acquisitions (
    product_id, affiliate_id, click_record_id, source_id, campaign_id, funnel_id,
    click_country, attribution_method, status, rejection_reason, commercial_eligible
  ) values (
    product_id_value, affiliate_id_value, click_record_id, source_id_value,
    campaign_id_value, funnel_id_value, country_value, 'deterministic_web',
    case when bot_value then 'rejected'::public.acquisition_status
      else 'open'::public.acquisition_status end,
    case when bot_value then 'automated_traffic' else null end,
    commercial_scope_value
  );

  return query select generated_click_id, destination_value, bot_value;
end;
$$;

create or replace function kma_internal.classify_journey_click() returns trigger language plpgsql security definer set search_path='' as $$
declare env text;
begin
 select coalesce(l.tracking_environment,c.environment) into env from public.affiliate_links l join public.funnel_journey_configuration c on c.funnel_id=l.funnel_id where l.id=new.affiliate_link_id;
 if env is not null then insert into public.funnel_journey_clicks(click_record_id,environment) values(new.id,env);end if;return new;
end;$$;
create function public.resolve_funnel_journey_click(p_product_id uuid,p_funnel_id uuid,p_click_id text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform public.assert_funnel_request_scope('journey-context',p_click_id,p_product_id,p_funnel_id);
 select jsonb_build_object('click_id',c.public_click_id,'link_id',l.id,'product_id',c.product_id,'funnel_id',c.funnel_id,'environment',l.tracking_environment)
 into result from public.clicks c join public.affiliate_links l on l.id=c.affiliate_link_id
 join public.funnel_journey_clicks j on j.click_record_id=c.id and j.environment=l.tracking_environment
 join public.products p on p.id=l.product_id and p.status='active' and p.tracking_mode='commercial'
 join public.funnels f on f.id=l.funnel_id and f.status='live' join public.affiliates a on a.id=l.affiliate_id and a.status='active'
 where c.public_click_id=p_click_id and c.product_id=p_product_id and c.funnel_id=p_funnel_id and l.status='active'
 and l.tracking_environment is not null and c.commercial_eligible and l.commercial_eligible and not c.is_bot
 and kma_internal.product_has_environment_offer(p.id,l.tracking_environment)
 and exists(select 1 from public.agreements ag where ag.affiliate_id=l.affiliate_id and ag.product_id=l.product_id and public.agreement_is_launch_ready(ag.id,now()));
 if result is null then raise exception 'Verified journey click unavailable' using errcode='P0002';end if;return result;
end;$$;
revoke all on function public.resolve_funnel_journey_click(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.resolve_funnel_journey_click(uuid,uuid,text) to service_role;


create or replace view public.partner_link_directory
with (security_barrier = true)
as
select
  link.id,
  link.name,
  link.product_id,
  product.name as product_name,
  product.slug as product_slug,
  link.funnel_id,
  funnel.name as funnel_name,
  link.source_id,
  source.name as source_name,
  link.campaign_id,
  campaign.name as campaign_name,
  link.sub1,
  coalesce(link.sub2, '') as sub2,
  coalesce(link.sub3, '') as sub3,
  link.status,
  link.tracking_url,
  link.parent_link_id,
  metric.clicks,
  case when link.commercial_eligible then metric.leads else null end as leads,
  metric.installs,
  case when link.commercial_eligible then metric.purchases else null end as purchases,
  case when link.commercial_eligible then metric.earnings_minor else null end as earnings_minor,
  case when link.commercial_eligible then agreement.payout_currency else null end as currency,
  link.created_at,
  product.tracking_mode,
  link.commercial_eligible,
  public.partner_link_short_url(link.id) as short_url,
  coalesce(link.tracking_environment,'live') as environment
from public.affiliate_links as link
join public.affiliates as affiliate on affiliate.id = link.affiliate_id
join public.products as product on product.id = link.product_id
join public.funnels as funnel on funnel.id = link.funnel_id
left join public.sources as source on source.id = link.source_id
left join public.campaigns as campaign on campaign.id = link.campaign_id
left join lateral (
  select candidate.payout_currency
  from public.agreements as candidate
  where candidate.affiliate_id = link.affiliate_id
    and candidate.product_id = link.product_id
  order by (candidate.status = 'active') desc, candidate.version desc
  limit 1
) as agreement on true
left join lateral (
  select
    (select count(*)::bigint from public.clicks as click
      where click.affiliate_link_id = link.id) as clicks,
    (
      select count(*)::bigint
      from public.conversions as conversion
      join public.commission_rules as rule
        on rule.id = conversion.commission_rule_id and rule.model = 'cpl'
      join public.acquisitions as acquisition on acquisition.id = conversion.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and conversion.qualified
    ) as leads,
    (
      select case when count(*) = 0 then null else count(*)::bigint end
      from public.acquisitions as acquisition
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id
        and acquisition.attribution_method = 'singular'
    ) as installs,
    (
      select count(*)::bigint
      from public.transactions as transaction
      join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id
    ) as purchases,
    (
      select coalesce(sum(entry.amount_minor), 0)::bigint
      from public.commission_entries as entry
      join public.conversions as conversion on conversion.id = entry.conversion_id
      join public.acquisitions as acquisition on acquisition.id = conversion.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id
        and entry.entry_type = 'commission'
        and agreement.payout_currency is not null
        and entry.currency = agreement.payout_currency
    ) as earnings_minor
) as metric on true
where public.current_user_has_affiliate(link.affiliate_id)
  and not link.is_main;



create or replace view public.partner_product_directory
with (security_barrier = true)
as
select distinct
  product.id,
  product.slug,
  product.name,
  product.status,
  case when product.tracking_mode = 'commercial' then agreement.status else null end
    as agreement_status,
  case when product.tracking_mode = 'commercial' then agreement.model else null end
    as commercial_model,
  case when product.tracking_mode = 'commercial' then agreement.payout_currency else null end
    as payout_currency,
  exists (
    select 1
    from public.funnels as live_funnel
    where live_funnel.product_id = product.id and live_funnel.status = 'live'
  ) as has_live_funnel,
  case
    when affiliate.status = 'active'
      and product.status = 'active'
      and coalesce(setting.tracking_enabled, false)
      and setting.tracking_base_url = 'https://go.kissmyapps.dev'
      and main_link.tracking_url is not null
      and (
        (
          product.tracking_mode = 'commercial'
          and main_link.commercial_eligible
          and agreement.id is not null
          and public.partner_agreement_is_launch_ready(agreement.id)
        )
        or (
          product.tracking_mode = 'tracking_only'
          and not main_link.commercial_eligible
          and public.partner_tracking_only_product_is_ready(product.id)
          and main_link.funnel_id = product.tracking_only_funnel_id
        )
      )
    then main_link.tracking_url
    else null
  end as main_tracking_url,
  product.tracking_mode,
  public.partner_tracking_only_product_is_ready(product.id) as tracking_only_ready,
  main_link.commercial_eligible as main_link_commercial_eligible,
  main_link.id as main_link_id,
  case
    when affiliate.status = 'active'
      and product.status = 'active'
      and coalesce(setting.tracking_enabled, false)
      and setting.tracking_base_url = 'https://go.kissmyapps.dev'
      and main_link.tracking_url is not null
      and (
        (
          product.tracking_mode = 'commercial'
          and main_link.commercial_eligible
          and agreement.id is not null
          and public.partner_agreement_is_launch_ready(agreement.id)
        )
        or (
          product.tracking_mode = 'tracking_only'
          and not main_link.commercial_eligible
          and public.partner_tracking_only_product_is_ready(product.id)
          and main_link.funnel_id = product.tracking_only_funnel_id
        )
      )
    then public.partner_link_short_url(main_link.id)
    else null
  end as main_short_url,
 test_link.id as test_main_link_id, test_link.tracking_url as test_main_tracking_url,
 public.partner_link_short_url(test_link.id) as test_main_short_url
from public.affiliate_users as membership
join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
join public.products as product on (
  exists (
    select 1 from public.agreements as related_agreement
    where related_agreement.affiliate_id = membership.affiliate_id
      and related_agreement.product_id = product.id
  )
  or exists (
    select 1 from public.affiliate_links as related_link
    where related_link.affiliate_id = membership.affiliate_id
      and related_link.product_id = product.id
  )
  or exists (
    select 1 from public.payouts as related_payout
    where related_payout.affiliate_id = membership.affiliate_id
      and related_payout.product_id = product.id
  )
  or exists (
    select 1 from public.affiliate_daily_metrics as related_metric
    where related_metric.affiliate_id = membership.affiliate_id
      and related_metric.product_id = product.id
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
  select link.id, link.tracking_url, link.funnel_id, link.commercial_eligible
  from public.affiliate_links as link
  join public.funnels as funnel
    on funnel.id = link.funnel_id
   and funnel.product_id = link.product_id
   and funnel.is_default
   and funnel.status = 'live'
  where link.affiliate_id = membership.affiliate_id
    and link.product_id = product.id
    and link.is_main
    and coalesce(link.tracking_environment,'live')='live'
    and link.status = 'active'
  order by link.created_at desc, link.id desc
  limit 1
) as main_link on true
left join lateral (
 select l.id,l.tracking_url from public.affiliate_links l
 join public.funnels f on f.id=l.funnel_id and f.status='live' and f.is_default
 join public.platform_settings ps on ps.singleton and ps.tracking_enabled and ps.tracking_base_url='https://go.kissmyapps.dev'
 where l.affiliate_id=membership.affiliate_id and l.product_id=product.id and l.is_main and l.status='active' and l.tracking_environment='test'
 and affiliate.status='active' and product.status='active' and product.tracking_mode='commercial' and l.commercial_eligible
 and agreement.id is not null and public.partner_agreement_is_launch_ready(agreement.id)
 order by l.created_at desc limit 1
) test_link on true
left join public.platform_settings as setting on setting.singleton
where membership.user_id = auth.uid()
  and membership.active
  and affiliate.status in ('active', 'paused');



alter function public.get_admin_product_configuration(uuid) rename to get_admin_product_configuration_before_link_environments;
revoke all on function public.get_admin_product_configuration_before_link_environments(uuid) from public,anon,authenticated,service_role;
create function public.get_admin_product_configuration(p_product_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 result:=public.get_admin_product_configuration_before_link_environments(p_product_id);
 result:=jsonb_set(result,'{billing_offers}',coalesce((select jsonb_agg(o||jsonb_build_object('main_link_test_ready',kma_internal.billing_offer_is_test_ready((o->>'id')::uuid))) from jsonb_array_elements(result->'billing_offers') o),'[]'));
 result:=jsonb_set(result,'{readiness,has_active_test_billing_offer}',to_jsonb(kma_internal.product_has_environment_offer(p_product_id,'test')));
 result:=jsonb_set(result,'{readiness,test_tracking_ready}',to_jsonb(coalesce((result#>>'{tracking,enabled}')::boolean,false) and result#>>'{tracking,base_url}'='https://go.kissmyapps.dev' and kma_internal.product_has_environment_offer(p_product_id,'test') and exists(select 1 from public.agreements ag where ag.product_id=p_product_id and public.agreement_is_launch_ready(ag.id,now()))));
 return jsonb_set(result,'{main_links}',coalesce((select jsonb_agg(l||jsonb_build_object('environment',coalesce(a.tracking_environment,'live'))) from jsonb_array_elements(result->'main_links') l join public.affiliate_links a on a.id=(l->>'id')::uuid),'[]'));
end;$$;
revoke all on function public.get_admin_product_configuration(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_admin_product_configuration(uuid) to authenticated;

-- Financial APIs must agree with the immutable click environment before a provider call.
alter function public.prepare_managed_checkout(jsonb,jsonb,text) rename to prepare_managed_checkout_before_link_environments;
revoke all on function public.prepare_managed_checkout_before_link_environments(jsonb,jsonb,text) from public,anon,authenticated,service_role;
create function public.prepare_managed_checkout(p_scope jsonb,p_input jsonb,p_attribution_sha256 text) returns jsonb language plpgsql security definer set search_path='' as $$
declare env text;
begin
 select l.tracking_environment into env from public.clicks c join public.affiliate_links l on l.id=c.affiliate_link_id where c.public_click_id=p_input->>'click_id';
 if env is not null and (p_scope->>'livemode')::boolean is distinct from (env='live') then raise exception 'Checkout and creator link environments must match' using errcode='22023';end if;
 return public.prepare_managed_checkout_before_link_environments(p_scope,p_input,p_attribution_sha256);
end;$$;
revoke all on function public.prepare_managed_checkout(jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_managed_checkout(jsonb,jsonb,text) to service_role;
create function kma_internal.enforce_creator_commerce_environment() returns trigger language plpgsql set search_path='' as $$
declare env text;click_record uuid;
begin
 if tg_table_name in('external_commerce_orders','checkout_attempts') then click_record:=new.click_record_id;
 else select click_record_id into click_record from public.acquisitions where id=new.acquisition_id;end if;
 select tracking_environment into env from public.affiliate_links l join public.clicks c on c.affiliate_link_id=l.id where c.id=click_record;
 if env is null then return new;end if;
 if tg_table_name='external_commerce_orders' then
  if new.livemode is distinct from (env='live') then raise exception 'Order and creator link environments must match' using errcode='23514';end if;
 elsif env='test' then raise exception 'TEST creator links cannot enter the legacy LIVE commerce ledger' using errcode='23514';end if;
 return new;
end;$$;
create trigger external_orders_environment before insert on public.external_commerce_orders for each row execute function kma_internal.enforce_creator_commerce_environment();
create trigger checkout_attempts_environment before insert on public.checkout_attempts for each row execute function kma_internal.enforce_creator_commerce_environment();
create trigger transactions_environment before insert on public.transactions for each row execute function kma_internal.enforce_creator_commerce_environment();
create trigger conversions_environment before insert on public.conversions for each row execute function kma_internal.enforce_creator_commerce_environment();
revoke all on function kma_internal.billing_offer_is_test_ready(uuid),kma_internal.product_has_environment_offer(uuid,text),kma_internal.validate_link_environment(),kma_internal.enforce_creator_commerce_environment() from public,anon,authenticated,service_role;
-- Legacy collectors cannot silently treat a new TEST link as LIVE, even before
-- a journey configuration is enabled. Explicit link mode is authoritative.
alter function public.ingest_funnel_metric_event(uuid,uuid,jsonb) rename to ingest_funnel_metric_event_before_link_environments;
revoke all on function public.ingest_funnel_metric_event_before_link_environments(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.ingest_funnel_metric_event(p_product_id uuid,p_funnel_id uuid,p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare env text;
begin
 select l.tracking_environment into env from public.clicks c join public.affiliate_links l on l.id=c.affiliate_link_id where c.public_click_id=p_event->>'click_id';
 if env is not null and ((p_event->>'schema_version'='2' and p_event->>'environment' is distinct from env) or (coalesce(p_event->>'schema_version','1')<>'2' and env='test')) then raise exception 'Event and creator link environments must match' using errcode='22023';end if;
 return public.ingest_funnel_metric_event_before_link_environments(p_product_id,p_funnel_id,p_event);
end;$$;
revoke all on function public.ingest_funnel_metric_event(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.ingest_funnel_metric_event(uuid,uuid,jsonb) to service_role;
commit;
