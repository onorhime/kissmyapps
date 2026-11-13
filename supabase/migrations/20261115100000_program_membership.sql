-- Affiliate self-serve, Phase 3: creators join a merchant's program.
-- This migration creates the membership tables and teaches the existing link and click
-- rules one new case: a creator who is an active member of a live affiliate program has a
-- working link, with no signed document, no countersignature and no KissMyApps offer.
-- Every other rule of the functions replaced below is unchanged; each is a copy of its
-- latest definition with the marked program branch added.
begin;

-- One row per creator per program. `terms_version` is the version of the program's terms
-- the creator last accepted; commission is always worked out under an accepted version.
create table public.affiliate_program_members (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.affiliate_programs(id),
  affiliate_id uuid not null references public.affiliates(id),
  -- pending: waiting for the merchant (programs that approve each creator).
  -- active: may promote. declined: the merchant said no. removed: the merchant ended it.
  -- left: the creator ended it.
  status text not null check (status in ('pending', 'active', 'declined', 'removed', 'left')),
  terms_version integer not null,
  -- The creator's main link, issued the first time the membership becomes active.
  main_link_id uuid unique references public.affiliate_links(id),
  joined_by uuid not null references auth.users(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text check (length(decision_note) between 1 and 500),
  activated_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (program_id, affiliate_id),
  foreign key (program_id, terms_version) references public.affiliate_program_terms(program_id, version),
  constraint affiliate_program_member_active_has_link check (status <> 'active' or (main_link_id is not null and activated_at is not null)),
  constraint affiliate_program_member_ended check ((status in ('declined', 'removed', 'left')) = (ended_at is not null))
);
create index affiliate_program_members_by_affiliate on public.affiliate_program_members(affiliate_id, status);
create index affiliate_program_members_by_program on public.affiliate_program_members(program_id, status, requested_at desc);

-- Each time a creator accepts a version of the agreement. Rows never change: this is the
-- record that the creator agreed to exactly this text.
create table public.affiliate_program_acceptances (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.affiliate_program_members(id),
  program_id uuid not null,
  terms_version integer not null,
  agreement_sha256 text not null check (agreement_sha256 ~ '^[a-f0-9]{64}$'),
  accepted_by uuid not null references auth.users(id),
  -- The name the creator accepted under, as shown on the acceptance screen.
  accepted_name text not null check (length(btrim(accepted_name)) between 1 and 200),
  accepted_at timestamptz not null default now(),
  unique (member_id, terms_version),
  foreign key (program_id, terms_version) references public.affiliate_program_terms(program_id, version)
);
create trigger affiliate_program_acceptances_are_append_only
  before update or delete on public.affiliate_program_acceptances
  for each row execute function public.reject_mutation();

alter table public.affiliate_program_members enable row level security;
alter table public.affiliate_program_acceptances enable row level security;
revoke all on public.affiliate_program_members, public.affiliate_program_acceptances
  from public, anon, authenticated, service_role;

-- True when the product belongs to a live affiliate program and the creator is an active
-- member of it. This is the whole "ready" test for a program link.
create function kma_internal.program_link_is_ready(p_affiliate uuid, p_product uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.affiliate_programs as program
    join public.affiliate_program_members as member
      on member.program_id = program.id and member.affiliate_id = p_affiliate and member.status = 'active'
    where program.product_id = p_product and program.status = 'live')
$$;
revoke all on function kma_internal.program_link_is_ready(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Links: an active link may also be a program member's link ----------------------------------

create or replace function public.validate_affiliate_link()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  funnel_record public.funnels%rowtype;
  product_record public.products%rowtype;
  campaign_product uuid;
  campaign_state text;
  parent_record public.affiliate_links%rowtype;
  old_status public.link_status;
  expected_tracking_url text;
  commercial_scope_ready boolean := false;
  tracking_scope_ready boolean := false;
  program_scope_ready boolean := false;
begin
  select * into funnel_record
  from public.funnels as funnel
  where funnel.id = new.funnel_id;

  select * into product_record
  from public.products as product
  where product.id = new.product_id;

  if funnel_record.product_id is distinct from new.product_id then
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
    or new.commercial_eligible <> old.commercial_eligible
  ) then
    raise exception 'issued link attribution, commercial scope, and routing are immutable'
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    select setting.tracking_base_url || '/r/' || affiliate.slug || '/' || new.public_code
    into expected_tracking_url
    from public.affiliates as affiliate
    cross join public.platform_settings as setting
    where affiliate.id = new.affiliate_id and setting.singleton;

    if expected_tracking_url is null or new.tracking_url <> expected_tracking_url then
      raise exception 'tracking URL must be issued from the configured tracking domain'
        using errcode = '23514';
    end if;
    if new.commercial_eligible <> (product_record.tracking_mode = 'commercial') then
      raise exception 'link commercial scope must match the product mode at issuance'
        using errcode = '23514';
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
    if not coalesce(funnel_record.is_default, false) then
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
       or parent_record.status <> 'active'
       or parent_record.affiliate_id <> new.affiliate_id
       or parent_record.product_id <> new.product_id
       or parent_record.commercial_eligible <> new.commercial_eligible then
      raise exception 'parent link must be the current active main link with the same scope'
        using errcode = '23514';
    end if;
  elsif not new.is_main and not new.commercial_eligible then
    raise exception 'tracking-only derived links require the current main parent link'
      using errcode = '23514';
  end if;

  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    commercial_scope_ready :=
      new.commercial_eligible
      and product_record.tracking_mode = 'commercial'
      and exists (
        select 1
        from public.agreements as agreement
        where agreement.affiliate_id = new.affiliate_id
          and agreement.product_id = new.product_id
          and public.agreement_is_launch_ready(agreement.id, now())
      );

    tracking_scope_ready :=
      not new.commercial_eligible
      and public.tracking_only_product_is_ready(new.product_id)
      and product_record.tracking_only_funnel_id = new.funnel_id
      and product_record.tracking_only_destination_url_snapshot = funnel_record.destination_url;

    -- A creator's link in a merchant's affiliate program: the program is live and the
    -- creator is an active member. No agreement document or KissMyApps offer is involved.
    program_scope_ready :=
      new.commercial_eligible
      and product_record.tracking_mode = 'commercial'
      and coalesce(new.tracking_environment, 'live') = 'live'
      and kma_internal.program_link_is_ready(new.affiliate_id, new.product_id);

    if product_record.status <> 'active'
       or funnel_record.status <> 'live'
       or not (commercial_scope_ready or tracking_scope_ready or program_scope_ready) then
      raise exception 'active link requires a ready commercial chain, a live affiliate program membership or an approved tracking-only funnel'
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

create or replace function public.validate_active_link_billing_readiness() returns trigger language plpgsql set search_path='' as $$
begin
 if new.status='active' then
  if new.commercial_eligible then
   if not (kma_internal.product_has_environment_offer(new.product_id,new.tracking_environment)
     or (coalesce(new.tracking_environment,'live')='live' and kma_internal.program_link_is_ready(new.affiliate_id,new.product_id))) then raise exception 'active links require an active verified offer for their TEST or LIVE environment, or a live affiliate program membership' using errcode='P0001';end if;
  elsif not public.tracking_only_product_is_ready(new.product_id) then raise exception 'noncommercial links require a valid Owner-approved tracking-only product' using errcode='P0001';end if;
 end if;return new;
end;$$;

-- Clicks: a program member's link registers clicks; a program link that cannot be credited
-- still redirects, untracked --------------------------------------------------------------

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
        -- A creator's link in a live affiliate program they are an active member of.
        link.commercial_eligible
        and product.tracking_mode = 'commercial'
        and coalesce(link.tracking_environment, 'live') = 'live'
        and kma_internal.program_link_is_ready(link.affiliate_id, product.id)
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
    -- A program link that cannot be credited right now (the program is paused, the creator
    -- left or was removed, or the link is paused) still sends the visitor to the merchant's
    -- landing page. No click is recorded and no click id is returned, so nothing is credited.
    select funnel.destination_url into destination_value
    from public.affiliate_links as link
    join public.affiliates as affiliate on affiliate.id = link.affiliate_id
    join public.affiliate_programs as program
      on program.product_id = link.product_id and program.status in ('live', 'paused')
    join public.funnels as funnel
      on funnel.id = program.funnel_id and funnel.destination_url is not null
    where affiliate.slug = trim(p_affiliate_slug)
      and link.public_code = trim(p_public_code)
      and coalesce(link.tracking_environment, 'live') = 'live';
    if destination_value is not null then
      return query select null::text, destination_value, bot_value;
      return;
    end if;
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

-- Tracking may be switched on when a live affiliate program exists ---------------------------

create or replace function public.platform_tracking_enablement_ready(p_base_url text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select
    coalesce(p_base_url = 'https://go.kissmyapps.dev', false)
    and exists (
      select 1
      from public.products as product
      where product.status = 'active'
        and (
          (
            product.tracking_mode = 'commercial'
            and exists (
              select 1
              from public.funnels as funnel
              where funnel.product_id = product.id
                and funnel.is_default
                and funnel.status = 'live'
                and public.is_production_https_url(funnel.destination_url, true)
            )
            and exists (
              select 1
              from public.agreements as agreement
              join public.affiliates as affiliate
                on affiliate.id = agreement.affiliate_id
               and affiliate.status = 'active'
              where agreement.product_id = product.id
                and public.agreement_is_launch_ready(agreement.id, statement_timestamp())
            )
            and public.product_has_launch_ready_billing_offer(product.id)
          )
          or (
            product.tracking_mode = 'tracking_only'
            and public.tracking_only_product_is_ready(product.id)
          )
          or (
            -- A live affiliate program with its landing page.
            product.tracking_mode = 'commercial'
            and exists (
              select 1
              from public.affiliate_programs as program
              join public.funnels as funnel on funnel.id = program.funnel_id
              where program.product_id = product.id
                and program.status = 'live'
                and funnel.is_default
                and funnel.status = 'live'
                and public.is_production_https_url(funnel.destination_url, true)
            )
          )
        )
    )
    and not exists (
      select 1
      from public.affiliate_links as link
      where link.is_main
        and link.status <> 'archived'
        and link.tracking_url not like 'https://go.kissmyapps.dev/r/%'
    );
$$;

commit;
