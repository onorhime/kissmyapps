create or replace function public.is_production_https_url(
  url_value text,
  allow_path boolean default true
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    char_length(url_value) <= 2000
    and position('#' in url_value) = 0
    and url_value !~ '[[:space:][:cntrl:]]'
    and url_value ~ '^https://(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?::[0-9]{1,5})?(?:[/?].*)?$'
    and url_value !~* '\.(?:test|invalid|example|localhost|local)(?::[0-9]{1,5})?(?:[/?]|$)'
    and url_value !~* '^https://(?:[A-Za-z0-9-]+\.)*example\.(?:com|net|org)(?::[0-9]{1,5})?(?:[/?]|$)'
    and (
      allow_path
      or url_value ~ '^https://(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?::[0-9]{1,5})?$'
    );
$$;

revoke all on function public.is_production_https_url(text, boolean)
  from public, anon, authenticated, service_role;

alter table public.sources
  add column active boolean not null default true,
  add column archived_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add constraint sources_archive_state_valid check (
    (active and archived_at is null)
    or (not active and archived_at is not null)
  );

alter table public.commission_rules
  add constraint commission_rules_amounts_complete check (
    (
      model in ('cpl', 'cpa')
      and fixed_amount_minor is not null
      and fixed_amount_minor > 0
      and rate_basis_points is null
      and currency is not null
    )
    or (
      model = 'revenue_share'
      and fixed_amount_minor is null
      and rate_basis_points is not null
      and rate_basis_points between 1 and 10000
      and currency is null
    )
    or (
      model = 'hybrid'
      and fixed_amount_minor is not null
      and fixed_amount_minor > 0
      and rate_basis_points is not null
      and rate_basis_points between 1 and 10000
      and currency is not null
    )
  );

drop trigger if exists sources_set_updated_at on public.sources;
create trigger sources_set_updated_at
  before update on public.sources
  for each row execute function public.set_updated_at();

drop trigger if exists sources_audit_mutation on public.sources;
create trigger sources_audit_mutation
  after insert or update or delete on public.sources
  for each row execute function public.audit_mutation();

create or replace function public.validate_active_link_source()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'active'
     and auth.uid() is not null
     and not exists (
       select 1
       from public.platform_settings as setting
       where setting.singleton and setting.tracking_enabled
     ) then
    raise exception 'active links require production tracking to be enabled'
      using errcode = '23514';
  end if;
  if new.status = 'active'
     and new.source_id is not null
     and not exists (
       select 1
       from public.sources as source
       where source.id = new.source_id and source.active
     ) then
    raise exception 'active links require an active source' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists affiliate_links_validate_active_source on public.affiliate_links;
create trigger affiliate_links_validate_active_source
  before insert or update on public.affiliate_links
  for each row execute function public.validate_active_link_source();

create or replace function public.assert_admin_password(
  required_roles text[],
  action_label text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;

  if required_roles is null
     or cardinality(required_roles) = 0
     or not public.current_user_is_admin(required_roles) then
    raise exception 'admin role cannot %', coalesce(action_label, 'perform this action')
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(
      case
        when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr'
        else '[]'::jsonb
      end
    ) as authentication_method(entry)
    where authentication_method.entry ->> 'method' = 'password'
  ) then
    raise exception '% requires a password-authenticated session',
      initcap(coalesce(action_label, 'this action'))
      using errcode = '42501';
  end if;
end;
$$;

create or replace function public.get_admin_affiliates()
returns table (
  id uuid,
  public_name text,
  slug text,
  status public.affiliate_status,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(array['owner', 'operations', 'finance', 'analyst']::text[]) then
    raise exception 'admin role cannot view partners' using errcode = '42501';
  end if;

  return query
  select
    affiliate.id,
    affiliate.public_name,
    affiliate.slug,
    affiliate.status,
    affiliate.created_at,
    affiliate.updated_at
  from public.affiliates as affiliate
  order by affiliate.public_name, affiliate.id;
end;
$$;

create or replace function public.get_admin_sources()
returns table (
  id uuid,
  key text,
  name text,
  active boolean,
  archived_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(array['owner', 'operations', 'finance', 'analyst']::text[]) then
    raise exception 'admin role cannot view sources' using errcode = '42501';
  end if;

  return query
  select
    source.id,
    source.key,
    source.name,
    source.active,
    source.archived_at,
    source.created_at,
    source.updated_at
  from public.sources as source
  order by source.active desc, source.name, source.id;
end;
$$;

create or replace function public.get_admin_product_configuration(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  product_record public.products%rowtype;
  tracking_record public.platform_settings%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(array['owner', 'operations', 'finance', 'analyst']::text[]) then
    raise exception 'admin role cannot view product configuration' using errcode = '42501';
  end if;

  select * into product_record
  from public.products as product
  where product.id = p_product_id;
  if product_record.id is null then
    raise exception 'product not found' using errcode = 'P0002';
  end if;

  select * into tracking_record
  from public.platform_settings as setting
  where setting.singleton;

  return jsonb_build_object(
    'product', jsonb_build_object(
      'id', product_record.id,
      'slug', product_record.slug,
      'name', product_record.name,
      'status', product_record.status,
      'created_at', product_record.created_at,
      'updated_at', product_record.updated_at
    ),
    'tracking', jsonb_build_object(
      'enabled', coalesce(tracking_record.tracking_enabled, false),
      'base_url', tracking_record.tracking_base_url
    ),
    'readiness', jsonb_build_object(
      'has_live_default_funnel', exists (
        select 1
        from public.funnels as funnel
        where funnel.product_id = p_product_id
          and funnel.is_default
          and funnel.status = 'live'
          and funnel.destination_url is not null
      ),
      'has_active_agreement', exists (
        select 1
        from public.agreements as agreement
        where agreement.product_id = p_product_id
          and agreement.status = 'active'
      ),
      'tracking_ready', coalesce(tracking_record.tracking_enabled, false)
        and tracking_record.tracking_base_url is not null
    ),
    'funnels', coalesce((
      select jsonb_agg(to_jsonb(funnel) order by funnel.is_default desc, funnel.name, funnel.id)
      from public.funnels as funnel
      where funnel.product_id = p_product_id
    ), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(to_jsonb(campaign) order by campaign.name, campaign.id)
      from public.campaigns as campaign
      where campaign.product_id = p_product_id
    ), '[]'::jsonb),
    'agreements', coalesce((
      select jsonb_agg(
        to_jsonb(agreement) || jsonb_build_object(
          'partner_name', affiliate.public_name,
          'partner_slug', affiliate.slug,
          'has_signed_document', exists (
            select 1
            from public.documents as document
            where document.agreement_id = agreement.id
              and document.affiliate_id = agreement.affiliate_id
              and document.status in ('signed', 'active')
              and document.signed_by_partner_at is not null
              and document.signed_by_partner_at <= now()
              and document.signed_by_kissmyapps_at is not null
              and document.signed_by_kissmyapps_at <= now()
              and (document.effective_at is null or document.effective_at <= now())
              and (document.expires_at is null or document.expires_at > now())
              and document.terminated_at is null
          ),
          'launch_ready', public.agreement_is_launch_ready(agreement.id, now()),
          'rules', coalesce((
            select jsonb_agg(to_jsonb(rule) order by rule.version, rule.id)
            from public.commission_rules as rule
            where rule.agreement_id = agreement.id
          ), '[]'::jsonb)
        )
        order by affiliate.public_name, agreement.version desc, agreement.id
      )
      from public.agreements as agreement
      join public.affiliates as affiliate on affiliate.id = agreement.affiliate_id
      where agreement.product_id = p_product_id
    ), '[]'::jsonb),
    'main_links', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', link.id,
          'affiliate_id', link.affiliate_id,
          'partner_name', affiliate.public_name,
          'funnel_id', link.funnel_id,
          'status', link.status,
          'tracking_url', link.tracking_url,
          'created_at', link.created_at
        ) order by affiliate.public_name, link.created_at, link.id
      )
      from public.affiliate_links as link
      join public.affiliates as affiliate on affiliate.id = link.affiliate_id
      where link.product_id = p_product_id and link.is_main
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.configure_admin_tracking(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['base_url', 'enabled'];
  base_url_value text;
  enabled_value boolean;
  stored public.platform_settings%rowtype;
begin
  perform public.assert_admin_password(array['owner']::text[], 'configure tracking');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'tracking input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) as input_key(key_name)
    where input_key.key_name <> all(allowed_keys)
  ) or not (p_input ? 'base_url') or not (p_input ? 'enabled') then
    raise exception 'tracking input must contain exactly base_url and enabled' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'enabled') <> 'boolean'
     or (jsonb_typeof(p_input -> 'base_url') not in ('string', 'null')) then
    raise exception 'tracking input types are invalid' using errcode = '22023';
  end if;

  base_url_value := nullif(trim(p_input ->> 'base_url'), '');
  enabled_value := (p_input ->> 'enabled')::boolean;
  if base_url_value is not null
     and not public.is_production_https_url(base_url_value, false) then
    raise exception 'tracking base URL must be an HTTPS origin without a path or trailing slash'
      using errcode = '22023';
  end if;
  if enabled_value and base_url_value is null then
    raise exception 'tracking cannot be enabled without an HTTPS base URL' using errcode = '22023';
  end if;

  insert into public.platform_settings (singleton, tracking_base_url, tracking_enabled)
  values (true, base_url_value, enabled_value)
  on conflict (singleton) do update
  set tracking_base_url = excluded.tracking_base_url,
      tracking_enabled = excluded.tracking_enabled
  returning * into stored;

  return jsonb_build_object(
    'base_url', stored.tracking_base_url,
    'enabled', stored.tracking_enabled,
    'updated_at', stored.updated_at
  );
end;
$$;

create or replace function public.create_admin_funnel(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['product_id', 'key', 'name', 'destination_url', 'is_default'];
  product_id_value uuid;
  key_value text;
  name_value text;
  destination_value text;
  default_value boolean;
  stored public.funnels%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'create funnels');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'funnel input must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) as input_key(key_name)
    where input_key.key_name <> all(allowed_keys)
  ) then
    raise exception 'funnel input contains unsupported fields' using errcode = '22023';
  end if;
  if not (p_input ? 'product_id') or not (p_input ? 'key') or not (p_input ? 'name') then
    raise exception 'product_id, key, and name are required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'product_id') <> 'string'
     or jsonb_typeof(p_input -> 'key') <> 'string'
     or jsonb_typeof(p_input -> 'name') <> 'string'
     or (p_input ? 'destination_url' and jsonb_typeof(p_input -> 'destination_url') not in ('string', 'null'))
     or (p_input ? 'is_default' and jsonb_typeof(p_input -> 'is_default') <> 'boolean') then
    raise exception 'funnel input types are invalid' using errcode = '22023';
  end if;

  begin
    product_id_value := nullif(p_input ->> 'product_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'product_id must be a UUID' using errcode = '22023';
  end;
  key_value := trim(p_input ->> 'key');
  name_value := trim(p_input ->> 'name');
  destination_value := nullif(trim(p_input ->> 'destination_url'), '');
  default_value := coalesce((p_input ->> 'is_default')::boolean, false);

  if not exists (select 1 from public.products as product where product.id = product_id_value) then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if key_value !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or char_length(key_value) > 120 then
    raise exception 'funnel key must be a canonical lowercase slug' using errcode = '22023';
  end if;
  if char_length(name_value) not between 1 and 120 then
    raise exception 'funnel name must contain between 1 and 120 characters' using errcode = '22023';
  end if;
  if destination_value is not null
     and not public.is_production_https_url(destination_value, true) then
    raise exception 'funnel destination must be an HTTPS URL' using errcode = '22023';
  end if;
  if default_value and exists (
    select 1 from public.funnels as funnel
    where funnel.product_id = product_id_value and funnel.is_default and funnel.status <> 'archived'
  ) then
    raise exception 'product already has a default funnel' using errcode = '23505';
  end if;

  insert into public.funnels (product_id, key, name, destination_url, status, is_default)
  values (product_id_value, key_value, name_value, destination_value, 'draft', default_value)
  returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace function public.update_admin_funnel(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['funnel_id', 'name', 'destination_url', 'is_default'];
  p_funnel_id uuid;
  patch_value jsonb;
  existing public.funnels%rowtype;
  destination_value text;
  default_value boolean;
  stored public.funnels%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'update funnels');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'funnel update must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) as input_key(key_name)
    where input_key.key_name <> all(allowed_keys)
  ) or not (p_input ? 'funnel_id') then
    raise exception 'funnel update contains unsupported or missing fields' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'funnel_id') <> 'string'
     or (p_input ? 'name' and jsonb_typeof(p_input -> 'name') <> 'string')
     or (p_input ? 'destination_url' and jsonb_typeof(p_input -> 'destination_url') not in ('string', 'null'))
     or (p_input ? 'is_default' and jsonb_typeof(p_input -> 'is_default') <> 'boolean') then
    raise exception 'funnel update types are invalid' using errcode = '22023';
  end if;
  begin
    p_funnel_id := nullif(trim(p_input ->> 'funnel_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'funnel_id must be a UUID' using errcode = '22023';
  end;
  patch_value := p_input - 'funnel_id';
  if p_funnel_id is null or patch_value = '{}'::jsonb then
    raise exception 'funnel update requires funnel_id and at least one change' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(patch_value) as input_key(key_name)
    where input_key.key_name not in ('name', 'destination_url', 'is_default')
  ) then
    raise exception 'funnel patch contains unsupported fields' using errcode = '22023';
  end if;

  select * into existing from public.funnels as funnel where funnel.id = p_funnel_id for update;
  if existing.id is null then raise exception 'funnel not found' using errcode = 'P0002'; end if;
  if existing.status not in ('draft', 'paused') then
    raise exception 'pause a live funnel before editing its routing configuration' using errcode = 'P0001';
  end if;

  destination_value := case
    when patch_value ? 'destination_url' then nullif(trim(patch_value ->> 'destination_url'), '')
    else existing.destination_url
  end;
  default_value := case
    when patch_value ? 'is_default' then (patch_value ->> 'is_default')::boolean
    else existing.is_default
  end;
  if destination_value is not null
     and not public.is_production_https_url(destination_value, true) then
    raise exception 'funnel destination must be an HTTPS URL' using errcode = '22023';
  end if;
  if default_value and not existing.is_default and exists (
    select 1 from public.funnels as funnel
    where funnel.product_id = existing.product_id
      and funnel.id <> existing.id
      and funnel.is_default
      and funnel.status <> 'archived'
  ) then
    raise exception 'product already has a default funnel' using errcode = '23505';
  end if;
  if default_value is distinct from existing.is_default and exists (
    select 1
    from public.affiliate_links as link
    where link.funnel_id = existing.id
      and link.is_main
      and link.status <> 'archived'
  ) then
    raise exception 'archive the current main links before changing the default funnel'
      using errcode = 'P0001';
  end if;

  update public.funnels as funnel
  set
    name = case when patch_value ? 'name' then trim(patch_value ->> 'name') else funnel.name end,
    destination_url = destination_value,
    is_default = default_value
  where funnel.id = p_funnel_id
  returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace function public.set_admin_funnel_status(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p_funnel_id uuid;
  p_status text;
  existing public.funnels%rowtype;
  stored public.funnels%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'change funnel status');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'funnel status input must contain exactly funnel_id and status'
      using errcode = '22023';
  end if;
  if not (p_input ? 'funnel_id')
     or not (p_input ? 'status')
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key not in ('funnel_id', 'status')
     ) then
    raise exception 'funnel status input must contain exactly funnel_id and status'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'funnel_id') <> 'string'
     or jsonb_typeof(p_input -> 'status') <> 'string' then
    raise exception 'funnel status input types are invalid' using errcode = '22023';
  end if;
  begin
    p_funnel_id := nullif(trim(p_input ->> 'funnel_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'funnel_id must be a UUID' using errcode = '22023';
  end;
  p_status := trim(p_input ->> 'status');
  if p_status not in ('live', 'paused', 'archived') then
    raise exception 'unsupported funnel status' using errcode = '22023';
  end if;
  select * into existing from public.funnels as funnel where funnel.id = p_funnel_id for update;
  if existing.id is null then raise exception 'funnel not found' using errcode = 'P0002'; end if;
  if p_status = existing.status then raise exception 'new funnel status must be different' using errcode = '22023'; end if;
  if not (
    (existing.status = 'draft' and p_status in ('live', 'archived'))
    or (existing.status = 'live' and p_status = 'paused')
    or (existing.status = 'paused' and p_status in ('live', 'archived'))
  ) then
    raise exception 'invalid funnel status transition: % -> %', existing.status, p_status using errcode = 'P0001';
  end if;
  if p_status = 'live' and existing.destination_url is null then
    raise exception 'a live funnel requires an HTTPS destination' using errcode = 'P0001';
  end if;
  if p_status = 'live'
     and not public.is_production_https_url(existing.destination_url, true) then
    raise exception 'a live funnel requires a production HTTPS destination' using errcode = 'P0001';
  end if;
  if p_status = 'archived' and exists (
    select 1 from public.affiliate_links as link
    where link.funnel_id = existing.id and link.status <> 'archived'
  ) then
    raise exception 'archive or move active links before archiving this funnel' using errcode = 'P0001';
  end if;

  update public.funnels as funnel
  set status = p_status
  where funnel.id = p_funnel_id
  returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace function public.create_admin_source(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['key', 'name'];
  stored public.sources%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'create sources');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'source input must contain exactly key and name' using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_object_keys(p_input) as input_key(key_name)
       where input_key.key_name <> all(allowed_keys)
     ) or not (p_input ? 'key') or not (p_input ? 'name') then
    raise exception 'source input must contain exactly key and name' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'key') <> 'string'
     or jsonb_typeof(p_input -> 'name') <> 'string'
     or trim(p_input ->> 'key') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or char_length(trim(p_input ->> 'key')) > 120
     or char_length(trim(p_input ->> 'name')) not between 1 and 120 then
    raise exception 'source key and name are invalid' using errcode = '22023';
  end if;
  insert into public.sources (key, name)
  values (trim(p_input ->> 'key'), trim(p_input ->> 'name'))
  returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace function public.archive_admin_source(p_source_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare stored public.sources%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'archive sources');
  if exists (
    select 1
    from public.affiliate_links as link
    where link.source_id = p_source_id and link.status = 'active'
  ) then
    raise exception 'pause or archive active links before archiving this source'
      using errcode = 'P0001';
  end if;
  update public.sources as source
  set active = false, archived_at = now()
  where source.id = p_source_id and source.active
  returning * into stored;
  if stored.id is null then raise exception 'active source not found' using errcode = 'P0002'; end if;
  return to_jsonb(stored);
end;
$$;

create or replace function public.create_admin_campaign(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['product_id', 'key', 'name', 'starts_at', 'ends_at'];
  stored public.campaigns%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'create campaigns');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'campaign input is invalid' using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_object_keys(p_input) as input_key(key_name)
       where input_key.key_name <> all(allowed_keys)
     ) or not (p_input ? 'product_id') or not (p_input ? 'key') or not (p_input ? 'name') then
    raise exception 'campaign input is invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'product_id') <> 'string'
     or jsonb_typeof(p_input -> 'key') <> 'string'
     or jsonb_typeof(p_input -> 'name') <> 'string'
     or (p_input ? 'starts_at' and jsonb_typeof(p_input -> 'starts_at') not in ('string', 'null'))
     or (p_input ? 'ends_at' and jsonb_typeof(p_input -> 'ends_at') not in ('string', 'null'))
     or trim(p_input ->> 'key') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or char_length(trim(p_input ->> 'key')) > 120
     or char_length(trim(p_input ->> 'name')) not between 1 and 120 then
    raise exception 'campaign product, key, and name are invalid' using errcode = '22023';
  end if;
  insert into public.campaigns (product_id, key, name, starts_at, ends_at, status)
  values (
    (p_input ->> 'product_id')::uuid,
    trim(p_input ->> 'key'),
    trim(p_input ->> 'name'),
    nullif(p_input ->> 'starts_at', '')::timestamptz,
    nullif(p_input ->> 'ends_at', '')::timestamptz,
    'draft'
  ) returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace function public.set_admin_campaign_status(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p_campaign_id uuid;
  p_status text;
  existing public.campaigns%rowtype;
  stored public.campaigns%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'change campaign status');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'campaign status input must contain exactly campaign_id and status'
      using errcode = '22023';
  end if;
  if not (p_input ? 'campaign_id')
     or not (p_input ? 'status')
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key not in ('campaign_id', 'status')
     ) then
    raise exception 'campaign status input must contain exactly campaign_id and status'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'campaign_id') <> 'string'
     or jsonb_typeof(p_input -> 'status') <> 'string' then
    raise exception 'campaign status input types are invalid' using errcode = '22023';
  end if;
  begin
    p_campaign_id := nullif(trim(p_input ->> 'campaign_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'campaign_id must be a UUID' using errcode = '22023';
  end;
  p_status := trim(p_input ->> 'status');
  if p_status not in ('active', 'completed', 'archived') then
    raise exception 'unsupported campaign status' using errcode = '22023';
  end if;
  select * into existing from public.campaigns as campaign where campaign.id = p_campaign_id for update;
  if existing.id is null then raise exception 'campaign not found' using errcode = 'P0002'; end if;
  if not (
    (existing.status = 'draft' and p_status in ('active', 'archived'))
    or (existing.status = 'active' and p_status in ('completed', 'archived'))
    or (existing.status = 'completed' and p_status = 'archived')
  ) then
    raise exception 'invalid campaign status transition: % -> %', existing.status, p_status using errcode = 'P0001';
  end if;
  update public.campaigns as campaign set status = p_status
  where campaign.id = p_campaign_id returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace function public.create_admin_agreement(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'affiliate_id', 'product_id', 'model', 'attribution_window_days',
    'renewal_duration_days', 'payout_frequency_days', 'payout_currency',
    'minimum_payout_minor'
  ];
  affiliate_id_value uuid;
  product_id_value uuid;
  next_version integer;
  stored public.agreements%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'create agreements');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'agreement input is invalid' using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_object_keys(p_input) as input_key(key_name)
       where input_key.key_name <> all(allowed_keys)
     ) then
    raise exception 'agreement input is invalid' using errcode = '22023';
  end if;
  if not (p_input ? 'affiliate_id') or not (p_input ? 'product_id')
     or not (p_input ? 'model') or not (p_input ? 'payout_currency') then
    raise exception 'affiliate_id, product_id, model, and payout_currency are required'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'affiliate_id') <> 'string'
     or jsonb_typeof(p_input -> 'product_id') <> 'string'
     or jsonb_typeof(p_input -> 'model') <> 'string'
     or jsonb_typeof(p_input -> 'payout_currency') <> 'string'
     or (p_input ? 'attribution_window_days' and jsonb_typeof(p_input -> 'attribution_window_days') <> 'number')
     or (p_input ? 'renewal_duration_days' and jsonb_typeof(p_input -> 'renewal_duration_days') not in ('number', 'null'))
     or (p_input ? 'payout_frequency_days' and jsonb_typeof(p_input -> 'payout_frequency_days') <> 'number')
     or (p_input ? 'minimum_payout_minor' and jsonb_typeof(p_input -> 'minimum_payout_minor') <> 'number') then
    raise exception 'agreement input types are invalid' using errcode = '22023';
  end if;
  begin
    affiliate_id_value := nullif(p_input ->> 'affiliate_id', '')::uuid;
    product_id_value := nullif(p_input ->> 'product_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'affiliate_id and product_id must be UUIDs' using errcode = '22023';
  end;
  if affiliate_id_value is null or product_id_value is null then
    raise exception 'affiliate_id and product_id are required' using errcode = '22023';
  end if;
  if (p_input ->> 'model') not in ('cpl', 'cpa', 'revenue_share', 'hybrid')
     or upper(trim(p_input ->> 'payout_currency')) !~ '^[A-Z]{3}$' then
    raise exception 'agreement model or payout currency is invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.affiliates as affiliate
    where affiliate.id = affiliate_id_value and affiliate.status in ('active', 'paused')
  ) then raise exception 'partner is not available for an agreement' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.products as product where product.id = product_id_value) then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'agreement-version:' || affiliate_id_value::text || ':' || product_id_value::text,
      0
    )
  );
  select coalesce(max(agreement.version), 0) + 1 into next_version
  from public.agreements as agreement
  where agreement.affiliate_id = affiliate_id_value and agreement.product_id = product_id_value;

  insert into public.agreements (
    affiliate_id, product_id, version, model, status, attribution_window_days,
    renewal_duration_days, payout_frequency_days, payout_currency, minimum_payout_minor
  ) values (
    affiliate_id_value,
    product_id_value,
    next_version,
    (p_input ->> 'model')::public.commission_model,
    'draft',
    coalesce((p_input ->> 'attribution_window_days')::integer, 30),
    nullif(p_input ->> 'renewal_duration_days', '')::integer,
    coalesce((p_input ->> 'payout_frequency_days')::integer, 14),
    upper(trim(p_input ->> 'payout_currency')),
    coalesce((p_input ->> 'minimum_payout_minor')::bigint, 10000)
  ) returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace function public.create_admin_commission_rule(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array[
    'agreement_id', 'name', 'model', 'trigger_event', 'fixed_amount_minor',
    'rate_basis_points', 'currency', 'validation_window_hours'
  ];
  agreement_id_value uuid;
  next_version integer;
  stored public.commission_rules%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'create commission rules');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'commission rule input is invalid' using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_object_keys(p_input) as input_key(key_name)
       where input_key.key_name <> all(allowed_keys)
     ) then
    raise exception 'commission rule input is invalid' using errcode = '22023';
  end if;
  if not (p_input ? 'agreement_id') or not (p_input ? 'name') or not (p_input ? 'trigger_event') then
    raise exception 'agreement_id, name, and trigger_event are required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'agreement_id') <> 'string'
     or jsonb_typeof(p_input -> 'name') <> 'string'
     or jsonb_typeof(p_input -> 'trigger_event') <> 'string'
     or (p_input ? 'model' and jsonb_typeof(p_input -> 'model') not in ('string', 'null'))
     or (p_input ? 'fixed_amount_minor' and jsonb_typeof(p_input -> 'fixed_amount_minor') not in ('number', 'null'))
     or (p_input ? 'rate_basis_points' and jsonb_typeof(p_input -> 'rate_basis_points') not in ('number', 'null'))
     or (p_input ? 'currency' and jsonb_typeof(p_input -> 'currency') not in ('string', 'null'))
     or (p_input ? 'validation_window_hours' and jsonb_typeof(p_input -> 'validation_window_hours') <> 'number') then
    raise exception 'commission rule input types are invalid' using errcode = '22023';
  end if;
  begin
    agreement_id_value := nullif(p_input ->> 'agreement_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'agreement_id must be a UUID' using errcode = '22023';
  end;
  if agreement_id_value is null
     or char_length(trim(p_input ->> 'name')) not between 1 and 120
     or trim(p_input ->> 'trigger_event') !~ '^[a-z][a-z0-9_.-]{0,99}$'
     or (nullif(p_input ->> 'model', '') is not null and (p_input ->> 'model') not in ('cpl', 'cpa', 'revenue_share', 'hybrid'))
     or (nullif(trim(p_input ->> 'currency'), '') is not null and upper(trim(p_input ->> 'currency')) !~ '^[A-Z]{3}$') then
    raise exception 'commission rule values are invalid' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commission-rule-version:' || agreement_id_value::text || ':' || trim(p_input ->> 'name'),
      0
    )
  );
  select coalesce(max(rule.version), 0) + 1 into next_version
  from public.commission_rules as rule
  where rule.agreement_id = agreement_id_value and rule.name = trim(p_input ->> 'name');

  insert into public.commission_rules (
    agreement_id, name, version, status, model, trigger_event,
    fixed_amount_minor, rate_basis_points, currency, validation_window_hours
  )
  select
    agreement.id,
    trim(p_input ->> 'name'),
    next_version,
    'draft',
    coalesce(nullif(p_input ->> 'model', '')::public.commission_model, agreement.model),
    trim(p_input ->> 'trigger_event'),
    nullif(p_input ->> 'fixed_amount_minor', '')::bigint,
    nullif(p_input ->> 'rate_basis_points', '')::integer,
    upper(nullif(trim(p_input ->> 'currency'), '')),
    coalesce((p_input ->> 'validation_window_hours')::integer, 72)
  from public.agreements as agreement
  where agreement.id = agreement_id_value
  returning * into stored;
  if stored.id is null then raise exception 'agreement not found' using errcode = 'P0002'; end if;
  return to_jsonb(stored);
end;
$$;

create or replace function public.set_admin_commission_rule_status(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p_rule_id uuid;
  p_status text;
  existing public.commission_rules%rowtype;
  stored public.commission_rules%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'change commission rule status');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'commission-rule status input must contain exactly commission_rule_id and status'
      using errcode = '22023';
  end if;
  if not (p_input ? 'commission_rule_id')
     or not (p_input ? 'status')
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key not in ('commission_rule_id', 'status')
     ) then
    raise exception 'commission-rule status input must contain exactly commission_rule_id and status'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'commission_rule_id') <> 'string'
     or jsonb_typeof(p_input -> 'status') <> 'string' then
    raise exception 'commission-rule status input types are invalid' using errcode = '22023';
  end if;
  begin
    p_rule_id := nullif(trim(p_input ->> 'commission_rule_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'commission_rule_id must be a UUID' using errcode = '22023';
  end;
  p_status := trim(p_input ->> 'status');
  if p_status not in ('active', 'superseded') then
    raise exception 'unsupported commission rule status' using errcode = '22023';
  end if;
  select * into existing from public.commission_rules as rule where rule.id = p_rule_id for update;
  if existing.id is null then raise exception 'commission rule not found' using errcode = 'P0002'; end if;
  if not (
    (existing.status = 'draft' and p_status = 'active')
    or (existing.status = 'active' and p_status = 'superseded')
  ) then
    raise exception 'invalid commission rule status transition: % -> %', existing.status, p_status using errcode = 'P0001';
  end if;
  update public.commission_rules as rule set status = p_status::public.rule_status
  where rule.id = p_rule_id returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace function public.activate_admin_agreement(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p_agreement_id uuid;
  existing public.agreements%rowtype;
  stored public.agreements%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'activate agreements');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'agreement activation input must contain exactly agreement_id'
      using errcode = '22023';
  end if;
  if not (p_input ? 'agreement_id')
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> 'agreement_id'
     ) then
    raise exception 'agreement activation input must contain exactly agreement_id'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'agreement_id') <> 'string' then
    raise exception 'agreement_id must be a UUID' using errcode = '22023';
  end if;
  begin
    p_agreement_id := nullif(trim(p_input ->> 'agreement_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'agreement_id must be a UUID' using errcode = '22023';
  end;
  select * into existing from public.agreements as agreement where agreement.id = p_agreement_id for update;
  if existing.id is null then raise exception 'agreement not found' using errcode = 'P0002'; end if;
  if existing.status not in ('draft', 'awaiting_signature') then
    raise exception 'only a draft or awaiting-signature agreement can be activated' using errcode = 'P0001';
  end if;
  if (
    select count(*)
    from public.commission_rules as rule
    where rule.agreement_id = existing.id
      and rule.status = 'active'
  ) <> 1 or not exists (
    select 1
    from public.commission_rules as rule
    where rule.agreement_id = existing.id
      and rule.status = 'active'
      and rule.model = existing.model
      and rule.model in ('cpa', 'revenue_share', 'hybrid')
      and rule.trigger_event = 'purchase.completed'
      and (rule.currency is null or rule.currency = existing.payout_currency)
  ) then
    raise exception 'agreement activation requires exactly one supported active purchase rule'
      using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from public.documents as document
    where document.agreement_id = existing.id
      and document.affiliate_id = existing.affiliate_id
      and document.status in ('signed', 'active')
      and document.signed_by_partner_at is not null
      and document.signed_by_partner_at <= now()
      and document.signed_by_kissmyapps_at is not null
      and document.signed_by_kissmyapps_at <= now()
      and (document.effective_at is null or document.effective_at <= now())
      and (document.expires_at is null or document.expires_at > now())
      and document.terminated_at is null
  ) then
    raise exception 'agreement activation requires a current bilaterally signed document'
      using errcode = 'P0001';
  end if;

  update public.agreements as agreement
  set status = 'superseded', ends_at = now()
  where agreement.affiliate_id = existing.affiliate_id
    and agreement.product_id = existing.product_id
    and agreement.id <> existing.id
    and agreement.status = 'active';

  update public.agreements as agreement
  set status = 'active', starts_at = coalesce(agreement.starts_at, now()), ends_at = null
  where agreement.id = existing.id
  returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace function public.activate_admin_product(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p_product_id uuid;
  existing public.products%rowtype;
  stored public.products%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'activate products');
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'product activation input must contain exactly product_id'
      using errcode = '22023';
  end if;
  if not (p_input ? 'product_id')
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> 'product_id'
     ) then
    raise exception 'product activation input must contain exactly product_id'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'product_id') <> 'string' then
    raise exception 'product_id must be a UUID' using errcode = '22023';
  end if;
  begin
    p_product_id := nullif(trim(p_input ->> 'product_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'product_id must be a UUID' using errcode = '22023';
  end;
  select * into existing from public.products as product where product.id = p_product_id for update;
  if existing.id is null then raise exception 'product not found' using errcode = 'P0002'; end if;
  if existing.status not in ('draft', 'paused') then
    raise exception 'only a draft or paused product can be activated' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.platform_settings as setting
    where setting.singleton and setting.tracking_enabled and setting.tracking_base_url is not null
  ) then
    raise exception 'production tracking must be configured and enabled first' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.funnels as funnel
    where funnel.product_id = existing.id
      and funnel.is_default
      and funnel.status = 'live'
      and funnel.destination_url is not null
  ) then
    raise exception 'product requires one live default HTTPS funnel' using errcode = 'P0001';
  end if;
  update public.products as product set status = 'active'
  where product.id = existing.id returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace function public.issue_admin_main_link(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['affiliate_id', 'product_id'];
  affiliate_id_value uuid;
  product_id_value uuid;
  existing public.affiliate_links%rowtype;
  funnel_record public.funnels%rowtype;
  affiliate_record public.affiliates%rowtype;
  product_record public.products%rowtype;
  tracking_base text;
  generated_code text;
  stored public.affiliate_links%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'issue main links');

  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'main-link input must contain exactly affiliate_id and product_id'
      using errcode = '22023';
  end if;
  if exists (
       select 1
       from jsonb_object_keys(p_input) as input_key(key_name)
       where input_key.key_name <> all(allowed_keys)
     )
     or not (p_input ? 'affiliate_id')
     or not (p_input ? 'product_id') then
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

  select * into existing
  from public.affiliate_links as link
  where link.affiliate_id = affiliate_id_value
    and link.product_id = product_id_value
    and link.is_main
    and link.status <> 'archived'
  order by link.created_at desc
  limit 1;
  if existing.id is not null then return to_jsonb(existing); end if;

  select * into affiliate_record from public.affiliates as affiliate
  where affiliate.id = affiliate_id_value and affiliate.status = 'active';
  select * into product_record from public.products as product
  where product.id = product_id_value and product.status = 'active';
  select * into funnel_record from public.funnels as funnel
  where funnel.product_id = product_id_value
    and funnel.is_default and funnel.status = 'live' and funnel.destination_url is not null;
  select setting.tracking_base_url into tracking_base
  from public.platform_settings as setting
  where setting.singleton and setting.tracking_enabled;

  if affiliate_record.id is null or product_record.id is null
     or funnel_record.id is null or tracking_base is null then
    raise exception 'partner, product, default funnel, and production tracking must all be active'
      using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from public.agreements as agreement
    where agreement.affiliate_id = affiliate_id_value
      and agreement.product_id = product_id_value
      and public.agreement_is_launch_ready(agreement.id, now())
  ) then
    raise exception 'partner requires an effective signed agreement and one supported purchase rule'
      using errcode = 'P0001';
  end if;

  generated_code := encode(extensions.gen_random_bytes(18), 'hex');
  insert into public.affiliate_links (
    affiliate_id, product_id, funnel_id, name, public_code, tracking_url,
    parent_link_id, sub1, sub2, sub3, is_main, created_by
  ) values (
    affiliate_id_value,
    product_id_value,
    funnel_record.id,
    product_record.name || ' · Main',
    generated_code,
    tracking_base || '/r/' || affiliate_record.slug || '/' || generated_code,
    null,
    null,
    null,
    null,
    true,
    auth.uid()
  ) returning * into stored;
  return to_jsonb(stored);
end;
$$;

create or replace view public.partner_link_option_directory
with (security_barrier = true)
as
with launch_ready_agreements as materialized (
  select distinct agreement.affiliate_id, agreement.product_id
  from public.agreements as agreement
  join public.affiliate_users as membership
    on membership.affiliate_id = agreement.affiliate_id
  where membership.user_id = auth.uid()
    and membership.active
    and agreement.status = 'active'
    and agreement.starts_at <= now()
    and (agreement.ends_at is null or agreement.ends_at > now())
    and (
      select count(*) = 1
      from public.commission_rules as active_rule
      where active_rule.agreement_id = agreement.id
        and active_rule.status = 'active'
    )
    and exists (
      select 1
      from public.commission_rules as purchase_rule
      where purchase_rule.agreement_id = agreement.id
        and purchase_rule.status = 'active'
        and purchase_rule.model = agreement.model
        and purchase_rule.model in ('cpa', 'revenue_share', 'hybrid')
        and purchase_rule.trigger_event = 'purchase.completed'
        and (purchase_rule.currency is null or purchase_rule.currency = agreement.payout_currency)
    )
    and exists (
      select 1
      from public.documents as document
      where document.agreement_id = agreement.id
        and document.affiliate_id = agreement.affiliate_id
        and document.status in ('signed', 'active')
        and document.signed_by_partner_at is not null
        and document.signed_by_partner_at <= now()
        and document.signed_by_kissmyapps_at is not null
        and document.signed_by_kissmyapps_at <= now()
        and (document.effective_at is null or document.effective_at <= now())
        and (document.expires_at is null or document.expires_at > now())
        and document.terminated_at is null
    )
)
select
  funnel.id,
  'funnel'::text as kind,
  funnel.product_id,
  funnel.key,
  funnel.name,
  (
    affiliate.status = 'active'
    and product.status = 'active'
    and funnel.status = 'live'
    and coalesce(setting.tracking_enabled, false)
    and exists (
      select 1
      from launch_ready_agreements as agreement
      where agreement.affiliate_id = membership.affiliate_id
        and agreement.product_id = funnel.product_id
    )
  ) as available
from public.affiliate_users as membership
join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
join public.funnels as funnel on exists (
  select 1
  from public.agreements as agreement
  where agreement.affiliate_id = membership.affiliate_id
    and agreement.product_id = funnel.product_id
)
join public.products as product on product.id = funnel.product_id
left join public.platform_settings as setting on setting.singleton
where membership.user_id = auth.uid()
  and membership.active
  and affiliate.status in ('active', 'paused')
union all
select
  campaign.id,
  'campaign'::text,
  campaign.product_id,
  campaign.key,
  campaign.name,
  (
    affiliate.status = 'active'
    and product.status = 'active'
    and campaign.status = 'active'
    and coalesce(setting.tracking_enabled, false)
    and exists (
      select 1
      from launch_ready_agreements as agreement
      where agreement.affiliate_id = membership.affiliate_id
        and agreement.product_id = campaign.product_id
    )
  )
from public.affiliate_users as membership
join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
join public.campaigns as campaign on exists (
  select 1
  from public.agreements as agreement
  where agreement.affiliate_id = membership.affiliate_id
    and agreement.product_id = campaign.product_id
)
join public.products as product on product.id = campaign.product_id
left join public.platform_settings as setting on setting.singleton
where membership.user_id = auth.uid()
  and membership.active
  and affiliate.status in ('active', 'paused')
union all
select
  source.id,
  'source'::text,
  null::uuid,
  source.key,
  source.name,
  (
    affiliate.status = 'active'
    and source.active
    and coalesce(setting.tracking_enabled, false)
  )
from public.affiliate_users as membership
join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
cross join public.sources as source
left join public.platform_settings as setting on setting.singleton
where membership.user_id = auth.uid()
  and membership.active
  and affiliate.status in ('active', 'paused')
  and source.active
  and exists (
    select 1
    from launch_ready_agreements as agreement
    where agreement.affiliate_id = membership.affiliate_id
  );

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
  metric.leads,
  metric.installs,
  metric.purchases,
  metric.earnings_minor,
  agreement.payout_currency as currency,
  link.created_at
from public.affiliate_links as link
join public.affiliates as affiliate on affiliate.id = link.affiliate_id
join public.products as product on product.id = link.product_id
join public.funnels as funnel on funnel.id = link.funnel_id
left join public.sources as source on source.id = link.source_id
left join public.campaigns as campaign on campaign.id = link.campaign_id
join lateral (
  select candidate.payout_currency
  from public.agreements as candidate
  where candidate.affiliate_id = link.affiliate_id
    and candidate.product_id = link.product_id
  order by (candidate.status = 'active') desc, candidate.version desc
  limit 1
) as agreement on true
left join lateral (
  select
    (select count(*)::bigint from public.clicks as click where click.affiliate_link_id = link.id) as clicks,
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
        and entry.currency = agreement.payout_currency
    ) as earnings_minor
) as metric on true
where public.current_user_has_affiliate(link.affiliate_id)
  and not link.is_main;

create or replace function public.update_partner_link(p_link_id uuid, p_patch jsonb)
returns setof public.partner_link_directory
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing public.affiliate_links%rowtype;
  name_value text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'issued link attribution is immutable; only name may be updated'
      using errcode = '22023';
  end if;
  if p_patch = '{}'::jsonb
     or exists (
       select 1
       from jsonb_object_keys(p_patch) as input_key
       where input_key <> 'name'
     )
     or not (p_patch ? 'name')
     or jsonb_typeof(p_patch -> 'name') <> 'string' then
    raise exception 'issued link attribution is immutable; only name may be updated'
      using errcode = '22023';
  end if;

  select * into existing
  from public.affiliate_links as link
  where link.id = p_link_id;
  if existing.id is null
     or existing.is_main
     or not public.current_user_has_affiliate_role(
       existing.affiliate_id,
       array['owner', 'member']::text[],
       true
     ) then
    raise exception 'link not found or role cannot edit it' using errcode = '42501';
  end if;
  if existing.status = 'archived' then
    raise exception 'archived link must be restored before editing' using errcode = 'P0001';
  end if;

  name_value := trim(p_patch ->> 'name');
  if char_length(name_value) not between 1 and 120 then
    raise exception 'link name must contain between 1 and 120 characters'
      using errcode = '22023';
  end if;

  update public.affiliate_links as link
  set name = name_value
  where link.id = p_link_id;

  return query
  select directory.*
  from public.partner_link_directory as directory
  where directory.id = p_link_id;
end;
$$;

create or replace function public.set_partner_link_status(
  p_link_id uuid,
  p_status public.link_status
)
returns setof public.partner_link_directory
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing public.affiliate_links%rowtype;
begin
  select * into existing
  from public.affiliate_links as link
  where link.id = p_link_id;
  if existing.id is null
     or existing.is_main
     or not public.current_user_has_affiliate_role(
       existing.affiliate_id,
       array['owner', 'member']::text[],
       true
     ) then
    raise exception 'link not found or role cannot change its status' using errcode = '42501';
  end if;
  if p_status is null or p_status = existing.status then
    raise exception 'new link status must be different' using errcode = '22023';
  end if;

  update public.affiliate_links as link
  set status = p_status
  where link.id = p_link_id;

  return query
  select directory.*
  from public.partner_link_directory as directory
  where directory.id = p_link_id;
end;
$$;

do $$
declare function_signature text;
begin
  foreach function_signature in array array[
    'public.assert_admin_password(text[],text)',
    'public.is_production_https_url(text,boolean)',
    'public.validate_active_link_source()',
    'public.get_admin_affiliates()',
    'public.get_admin_sources()',
    'public.get_admin_product_configuration(uuid)',
    'public.configure_admin_tracking(jsonb)',
    'public.create_admin_funnel(jsonb)',
    'public.update_admin_funnel(jsonb)',
    'public.set_admin_funnel_status(jsonb)',
    'public.create_admin_source(jsonb)',
    'public.archive_admin_source(uuid)',
    'public.create_admin_campaign(jsonb)',
    'public.set_admin_campaign_status(jsonb)',
    'public.create_admin_agreement(jsonb)',
    'public.create_admin_commission_rule(jsonb)',
    'public.set_admin_commission_rule_status(jsonb)',
    'public.activate_admin_agreement(jsonb)',
    'public.activate_admin_product(jsonb)',
    'public.issue_admin_main_link(jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', function_signature);
  end loop;
end;
$$;

grant execute on function public.get_admin_affiliates() to authenticated;
grant execute on function public.get_admin_sources() to authenticated;
grant execute on function public.get_admin_product_configuration(uuid) to authenticated;
grant execute on function public.configure_admin_tracking(jsonb) to authenticated;
grant execute on function public.create_admin_funnel(jsonb) to authenticated;
grant execute on function public.update_admin_funnel(jsonb) to authenticated;
grant execute on function public.set_admin_funnel_status(jsonb) to authenticated;
grant execute on function public.create_admin_source(jsonb) to authenticated;
grant execute on function public.archive_admin_source(uuid) to authenticated;
grant execute on function public.create_admin_campaign(jsonb) to authenticated;
grant execute on function public.set_admin_campaign_status(jsonb) to authenticated;
grant execute on function public.create_admin_agreement(jsonb) to authenticated;
grant execute on function public.create_admin_commission_rule(jsonb) to authenticated;
grant execute on function public.set_admin_commission_rule_status(jsonb) to authenticated;
grant execute on function public.activate_admin_agreement(jsonb) to authenticated;
grant execute on function public.activate_admin_product(jsonb) to authenticated;
grant execute on function public.issue_admin_main_link(jsonb) to authenticated;

comment on function public.get_admin_product_configuration(uuid) is
  'Returns the production configuration and readiness state for one product to authorized administrators.';
comment on function public.configure_admin_tracking(jsonb) is
  'Configures the production tracking origin; only an Owner with password AMR may enable it.';
comment on function public.issue_admin_main_link(jsonb) is
  'Idempotently issues a real coded main link only after every production readiness gate is satisfied.';
