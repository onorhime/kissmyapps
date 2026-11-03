-- Merchant attribution, foundation. A project can switch attribution on, describe its
-- apps and website, and get a link domain: a subdomain under the platform's link root,
-- plus any domains of its own. The link service (deploy/link-service) answers on those
-- domains and serves the Apple and Android files that let links open the app; it reads
-- them through the attribution-links function, which calls the two service functions at
-- the end. Links, matching and reports build on these tables in later migrations.
begin;

-- Platform-wide settings -------------------------------------------------------------

-- One row: the root that new subdomains are made under. Moving every merchant to a new
-- root later means changing link_root and adding the new hosts; existing hosts keep working.
create table public.attribution_config (
  id boolean primary key default true check (id),
  link_root text not null,
  updated_at timestamptz not null default now()
);
insert into public.attribution_config(link_root) values ('go.kissmyapps.dev');

-- Hosts -------------------------------------------------------------------------------

create function kma_internal.attribution_valid_host(p_host text) returns boolean
language sql immutable set search_path = '' as $$
  select p_host is not null and length(p_host) between 4 and 253 and p_host = lower(p_host)
    and p_host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
$$;

-- Lowercase, without a scheme, path, port or trailing dot.
create function kma_internal.attribution_host(p_value text) returns text
language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(regexp_replace(regexp_replace(lower(btrim(coalesce(p_value, ''))),
    '^[a-z]+://', ''), '[/:?#].*$', ''), '\.$', ''), '')
$$;

-- Names kept for KissMyApps itself, so a merchant cannot take them.
create function kma_internal.attribution_reserved_label(p_label text) returns boolean
language sql immutable set search_path = '' as $$
  select p_label = any(array[
    'admin', 'api', 'app', 'apps', 'assets', 'auth', 'billing', 'blog', 'cdn', 'cname', 'dashboard',
    'dev', 'docs', 'events', 'go', 'help', 'internal', 'kissmyapps', 'kma', 'link', 'links', 'login',
    'mail', 'merchant', 'merchants', 'partner', 'partners', 'root', 'secure', 'staging', 'static',
    'status', 'support', 'test', 'www'
  ])
$$;

alter table public.attribution_config
  add constraint attribution_config_link_root_valid check (kma_internal.attribution_valid_host(link_root));

-- Settings per project ---------------------------------------------------------------

create table public.attribution_settings (
  project_id uuid primary key references public.analytics_projects(id) on delete cascade,
  enabled boolean not null default true,
  enabled_at timestamptz not null default now(),
  enabled_by uuid references auth.users(id) on delete set null,
  disabled_at timestamptz,
  -- The apps and website links lead to.
  ios_app_store_id text check (ios_app_store_id ~ '^[0-9]{6,12}$'),
  ios_bundle_id text check (length(ios_bundle_id) <= 155 and ios_bundle_id ~ '^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'),
  ios_team_id text check (ios_team_id ~ '^[A-Z0-9]{10}$'),
  android_package text check (length(android_package) <= 150 and android_package ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  android_sha256 text[] not null default '{}' check (
    cardinality(android_sha256) <= 10
    and array_to_string(android_sha256, ',') ~ '^([0-9A-F]{2}(:[0-9A-F]{2}){31}(,|$))*$'
  ),
  web_url text check (length(web_url) <= 2000 and web_url ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$'),
  -- How credit is given; later phases read these.
  click_lookback_days integer not null default 7 check (click_lookback_days between 1 and 30),
  view_through_enabled boolean not null default false,
  view_lookback_hours integer not null default 24 check (view_lookback_hours between 1 and 168),
  reengagement_days integer not null default 30 check (reengagement_days between 1 and 90),
  reattribution_days integer not null default 90 check (reattribution_days between 1 and 365),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table public.attribution_domains (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  host text not null unique check (kma_internal.attribution_valid_host(host)),
  -- kma: the project's subdomain under the link root. custom: a domain of the merchant's
  -- own, live once a request reaches us over HTTPS for it (proof its DNS points here).
  kind text not null check (kind in ('kma', 'custom')),
  verified_at timestamptz,
  last_seen_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index attribution_domains_one_kma on public.attribution_domains(project_id) where kind = 'kma';
create index attribution_domains_project on public.attribution_domains(project_id, created_at);

do $$
declare t text;
begin
  foreach t in array array['attribution_config', 'attribution_settings', 'attribution_domains'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Internal helpers ---------------------------------------------------------------------

create function kma_internal.attribution_link_root() returns text
language sql stable set search_path = '' as $$
  select link_root from public.attribution_config where id
$$;

-- Why a subdomain cannot be used, or null when it can.
create function kma_internal.attribution_subdomain_problem(p_label text, p_project uuid) returns text
language plpgsql stable set search_path = '' as $$
begin
  if p_label is null or p_label !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' or p_label like '%--%' then
    return 'Use 3 to 40 lowercase letters, numbers and single hyphens, starting and ending with a letter or number.';
  end if;
  if kma_internal.attribution_reserved_label(p_label) then
    return 'That name is kept for KissMyApps. Try another.';
  end if;
  if exists (
    select 1 from public.attribution_domains d
    where d.host = p_label || '.' || kma_internal.attribution_link_root()
      and d.project_id is distinct from p_project
  ) then
    return 'Another project already uses that name. Try another.';
  end if;
  return null;
end $$;

create function kma_internal.attribution_domain_view(d public.attribution_domains) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', d.id, 'host', d.host, 'kind', d.kind,
    'status', case when d.kind = 'kma' or d.verified_at is not null then 'live' else 'waiting' end,
    'verified_at', d.verified_at, 'last_seen_at', d.last_seen_at, 'created_at', d.created_at
  )
$$;

-- Every app platform the project lists is described, and at least one thing is.
create function kma_internal.attribution_apps_ready(p public.analytics_projects, s public.attribution_settings)
returns boolean language sql stable set search_path = '' as $$
  select s.project_id is not null
    and (not ('ios' = any(p.platforms))
      or (s.ios_app_store_id is not null and s.ios_bundle_id is not null and s.ios_team_id is not null))
    and (not ('android' = any(p.platforms))
      or (s.android_package is not null and cardinality(s.android_sha256) > 0))
    and (not ('web' = any(p.platforms)) or s.web_url is not null)
    and (s.ios_bundle_id is not null or s.android_package is not null or s.web_url is not null)
$$;

create function kma_internal.attribution_view(p_project uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  p public.analytics_projects;
  s public.attribution_settings;
  v_root text := kma_internal.attribution_link_root();
  v_domains jsonb;
  v_live boolean;
begin
  select * into p from public.analytics_projects where id = p_project;
  select * into s from public.attribution_settings where project_id = p_project;
  select coalesce(jsonb_agg(kma_internal.attribution_domain_view(d) order by d.kind = 'custom', d.created_at), '[]'::jsonb),
    coalesce(bool_or(d.kind = 'kma' or d.verified_at is not null), false)
  into v_domains, v_live
  from public.attribution_domains d where d.project_id = p_project;
  return jsonb_build_object(
    'project_id', p_project,
    'enabled', coalesce(s.enabled, false),
    'ever_enabled', s.project_id is not null,
    'link_root', v_root,
    'cname_target', 'cname.' || v_root,
    'settings', case when s.project_id is null then null else jsonb_build_object(
      'ios_app_store_id', s.ios_app_store_id, 'ios_bundle_id', s.ios_bundle_id, 'ios_team_id', s.ios_team_id,
      'android_package', s.android_package, 'android_sha256', to_jsonb(s.android_sha256), 'web_url', s.web_url,
      'click_lookback_days', s.click_lookback_days, 'view_through_enabled', s.view_through_enabled,
      'view_lookback_hours', s.view_lookback_hours, 'reengagement_days', s.reengagement_days,
      'reattribution_days', s.reattribution_days, 'currency', s.currency,
      'enabled_at', s.enabled_at, 'disabled_at', s.disabled_at, 'updated_at', s.updated_at
    ) end,
    'domains', v_domains,
    'setup', jsonb_build_object(
      'apps', kma_internal.attribution_apps_ready(p, s),
      'domain', s.project_id is not null and v_live,
      'sdk', false, 'conversions', false, 'partners', false, 'skan', false
    )
  );
end $$;

create function kma_internal.attribution_require_settings(p_project uuid) returns public.attribution_settings
language plpgsql stable set search_path = '' as $$
declare s public.attribution_settings;
begin
  select * into s from public.attribution_settings where project_id = p_project;
  if s.project_id is null then
    raise exception 'Turn on attribution for this project first' using errcode = '22023';
  end if;
  return s;
end $$;

-- A SHA-256 certificate fingerprint as Android's assetlinks.json wants it: 32 uppercase
-- hex pairs joined by colons. Accepts it with or without colons, in any case.
create function kma_internal.attribution_fingerprint(p_value text) returns text
language plpgsql immutable set search_path = '' as $$
declare v_hex text := upper(regexp_replace(coalesce(p_value, ''), '[\s:]', '', 'g'));
begin
  if v_hex !~ '^[0-9A-F]{64}$' then
    raise exception 'A signing certificate fingerprint is 64 hex characters (SHA-256), with or without colons' using errcode = '22023';
  end if;
  return regexp_replace(v_hex, '(..)(?!$)', '\1:', 'g');
end $$;

-- The project list in the console says whether each project has attribution on.
create or replace function kma_internal.analytics_project_view(p public.analytics_projects) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'workspace_id', p.workspace_id, 'name', p.name, 'platforms', to_jsonb(p.platforms),
    'timezone', p.timezone, 'allowed_origins', to_jsonb(p.allowed_origins), 'replay_enabled', p.replay_enabled,
    'created_at', p.created_at,
    'attribution_enabled', coalesce((select s.enabled from public.attribution_settings s where s.project_id = p.id), false)
  )
$$;

-- Console RPCs ----------------------------------------------------------------------------

create function public.attribution_get(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_project(p_project);
  return kma_internal.attribution_view(p_project);
end $$;

create function public.attribution_check_subdomain(p_project uuid, p_subdomain text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_label text := lower(btrim(coalesce(p_subdomain, '')));
  v_problem text;
begin
  perform kma_internal.analytics_require_project(p_project);
  v_problem := kma_internal.attribution_subdomain_problem(v_label, p_project);
  return jsonb_build_object(
    'subdomain', v_label, 'host', v_label || '.' || kma_internal.attribution_link_root(),
    'available', v_problem is null, 'reason', v_problem
  );
end $$;

-- Turns attribution on. The first time, it reserves the project's subdomain; after
-- that it switches it back on with everything as it was.
create function public.attribution_enable(p_project uuid, p_subdomain text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.analytics_projects := kma_internal.analytics_require_project(p_project, 'admin');
  v_label text := lower(btrim(coalesce(p_subdomain, '')));
  v_problem text;
  v_web text;
begin
  perform pg_advisory_xact_lock(hashtextextended('attribution:' || p_project::text, 0));
  if exists (select 1 from public.attribution_settings where project_id = p_project) then
    update public.attribution_settings
    set enabled = true, enabled_at = now(), enabled_by = auth.uid(), disabled_at = null,
      updated_at = now(), updated_by = auth.uid()
    where project_id = p_project;
  else
    v_problem := kma_internal.attribution_subdomain_problem(v_label, p_project);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '22023';
    end if;
    -- A website the project already allows is the likely place links lead on a computer.
    v_web := (select o || '/' from unnest(p.allowed_origins) o where o like 'https://%' and o !~ ':[0-9]+$' limit 1);
    insert into public.attribution_settings(project_id, enabled_by, web_url, updated_by)
    values (p_project, auth.uid(), v_web, auth.uid());
  end if;
  if not exists (select 1 from public.attribution_domains where project_id = p_project and kind = 'kma') then
    v_problem := kma_internal.attribution_subdomain_problem(v_label, p_project);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '22023';
    end if;
    begin
      insert into public.attribution_domains(project_id, host, kind, created_by)
      values (p_project, v_label || '.' || kma_internal.attribution_link_root(), 'kma', auth.uid());
    exception when unique_violation then
      raise exception 'Another project already uses that name. Try another.' using errcode = '23505';
    end;
  end if;
  return kma_internal.attribution_view(p_project);
end $$;

-- Turns attribution off. Settings, domains and data stay, so turning it on again carries on.
create function public.attribution_disable(p_project uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_project(p_project, 'admin');
  perform kma_internal.attribution_require_settings(p_project);
  update public.attribution_settings
  set enabled = false, disabled_at = now(), updated_at = now(), updated_by = auth.uid()
  where project_id = p_project;
  return kma_internal.attribution_view(p_project);
end $$;

create function public.attribution_update(p_project uuid, p_patch jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.attribution_settings;
  v_text text;
  v_list text[];
  v_item text;
  v_number integer;
  k text;
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  s := kma_internal.attribution_require_settings(p_project);
  if jsonb_typeof(p_patch) is distinct from 'object' or exists (
    select 1 from jsonb_object_keys(p_patch) x where x <> all(array[
      'ios_app_store_id', 'ios_bundle_id', 'ios_team_id', 'android_package', 'android_sha256', 'web_url',
      'click_lookback_days', 'view_through_enabled', 'view_lookback_hours', 'reengagement_days',
      'reattribution_days', 'currency'
    ])
  ) then
    raise exception 'Unknown attribution setting' using errcode = '22023';
  end if;

  -- Apps and website: an empty value clears it.
  if p_patch ? 'ios_app_store_id' then
    v_text := nullif(regexp_replace(btrim(coalesce(p_patch->>'ios_app_store_id', '')), '^id', '', 'i'), '');
    if v_text is not null and v_text !~ '^[0-9]{6,12}$' then
      raise exception 'The App Store ID is the number in your app''s App Store address, such as 1234567890' using errcode = '22023';
    end if;
    s.ios_app_store_id := v_text;
  end if;
  if p_patch ? 'ios_bundle_id' then
    v_text := nullif(btrim(coalesce(p_patch->>'ios_bundle_id', '')), '');
    if v_text is not null and (length(v_text) > 155 or v_text !~ '^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$') then
      raise exception 'A bundle ID looks like com.yourcompany.app' using errcode = '22023';
    end if;
    s.ios_bundle_id := v_text;
  end if;
  if p_patch ? 'ios_team_id' then
    v_text := nullif(upper(btrim(coalesce(p_patch->>'ios_team_id', ''))), '');
    if v_text is not null and v_text !~ '^[A-Z0-9]{10}$' then
      raise exception 'An Apple Team ID is 10 letters and numbers, shown in your Apple Developer account' using errcode = '22023';
    end if;
    s.ios_team_id := v_text;
  end if;
  if p_patch ? 'android_package' then
    v_text := nullif(btrim(coalesce(p_patch->>'android_package', '')), '');
    if v_text is not null and (length(v_text) > 150 or v_text !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$') then
      raise exception 'A package name looks like com.yourcompany.app' using errcode = '22023';
    end if;
    s.android_package := v_text;
  end if;
  if p_patch ? 'android_sha256' then
    if jsonb_typeof(p_patch->'android_sha256') is distinct from 'array' or jsonb_array_length(p_patch->'android_sha256') > 10 then
      raise exception 'List up to 10 signing certificate fingerprints' using errcode = '22023';
    end if;
    v_list := '{}';
    for v_item in select jsonb_array_elements_text(p_patch->'android_sha256') loop
      continue when btrim(v_item) = '';
      v_item := kma_internal.attribution_fingerprint(v_item);
      if not v_item = any(v_list) then v_list := v_list || v_item; end if;
    end loop;
    s.android_sha256 := v_list;
  end if;
  if p_patch ? 'web_url' then
    v_text := nullif(btrim(coalesce(p_patch->>'web_url', '')), '');
    if v_text is not null then
      -- An address typed without its scheme is taken as https; the scheme and host are lowercased.
      if v_text !~ '^[A-Za-z][A-Za-z0-9+.-]*://' then
        v_text := 'https://' || v_text;
      end if;
      v_text := lower(substring(v_text from '^[^/?#]*//[^/?#]*')) || coalesce(substring(v_text from '^[^/?#]*//[^/?#]*(.*)$'), '');
      if v_text !~ '^https://' then
        raise exception 'Use a website address that starts with https://' using errcode = '22023';
      end if;
      if length(v_text) > 2000 or v_text !~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$' then
        raise exception 'Enter a full website address, such as https://speaksix.app' using errcode = '22023';
      end if;
    end if;
    s.web_url := v_text;
  end if;

  -- Windows: whole numbers in their ranges.
  foreach k in array array['click_lookback_days', 'view_lookback_hours', 'reengagement_days', 'reattribution_days'] loop
    continue when not p_patch ? k;
    v_number := case when jsonb_typeof(p_patch->k) = 'number' and (p_patch->>k) ~ '^[0-9]+$' then (p_patch->>k)::integer end;
    if k = 'click_lookback_days' and v_number between 1 and 30 then s.click_lookback_days := v_number;
    elsif k = 'view_lookback_hours' and v_number between 1 and 168 then s.view_lookback_hours := v_number;
    elsif k = 'reengagement_days' and v_number between 1 and 90 then s.reengagement_days := v_number;
    elsif k = 'reattribution_days' and v_number between 1 and 365 then s.reattribution_days := v_number;
    else
      raise exception '%', case k
        when 'click_lookback_days' then 'The click window is 1 to 30 days'
        when 'view_lookback_hours' then 'The view window is 1 to 168 hours'
        when 'reengagement_days' then 'The re-engagement window is 1 to 90 days'
        else 'The reinstall window is 1 to 365 days' end using errcode = '22023';
    end if;
  end loop;
  if p_patch ? 'view_through_enabled' then
    if jsonb_typeof(p_patch->'view_through_enabled') is distinct from 'boolean' then
      raise exception 'Turn view-through on or off' using errcode = '22023';
    end if;
    s.view_through_enabled := (p_patch->>'view_through_enabled')::boolean;
  end if;
  if p_patch ? 'currency' then
    v_text := upper(btrim(coalesce(p_patch->>'currency', '')));
    if v_text !~ '^[A-Z]{3}$' then
      raise exception 'Choose a currency by its three-letter code, such as USD' using errcode = '22023';
    end if;
    s.currency := v_text;
  end if;

  update public.attribution_settings set
    ios_app_store_id = s.ios_app_store_id, ios_bundle_id = s.ios_bundle_id, ios_team_id = s.ios_team_id,
    android_package = s.android_package, android_sha256 = s.android_sha256, web_url = s.web_url,
    click_lookback_days = s.click_lookback_days, view_through_enabled = s.view_through_enabled,
    view_lookback_hours = s.view_lookback_hours, reengagement_days = s.reengagement_days,
    reattribution_days = s.reattribution_days, currency = s.currency,
    updated_at = now(), updated_by = auth.uid()
  where project_id = p_project;
  return kma_internal.attribution_view(p_project);
end $$;

-- Renames the project's subdomain. Links made on the old one stop working, so the console
-- says so before it asks.
create function public.attribution_set_subdomain(p_project uuid, p_subdomain text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_label text := lower(btrim(coalesce(p_subdomain, '')));
  v_problem text;
begin
  perform kma_internal.analytics_require_project(p_project, 'admin');
  perform kma_internal.attribution_require_settings(p_project);
  v_problem := kma_internal.attribution_subdomain_problem(v_label, p_project);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;
  begin
    update public.attribution_domains
    set host = v_label || '.' || kma_internal.attribution_link_root(), last_seen_at = null
    where project_id = p_project and kind = 'kma';
  exception when unique_violation then
    raise exception 'Another project already uses that name. Try another.' using errcode = '23505';
  end;
  return kma_internal.attribution_view(p_project);
end $$;

create function public.attribution_add_domain(p_project uuid, p_host text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_host text := kma_internal.attribution_host(p_host);
  v_root text := kma_internal.attribution_link_root();
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  perform kma_internal.attribution_require_settings(p_project);
  if not kma_internal.attribution_valid_host(coalesce(v_host, '')) then
    raise exception 'Enter a domain such as go.yourbrand.com' using errcode = '22023';
  end if;
  if v_host = v_root or v_host like '%.' || v_root then
    raise exception 'Your % subdomain is already set up; add a domain of your own here', v_root using errcode = '22023';
  end if;
  if v_host ~ '(^|\.)kissmyapps\.dev$' then
    raise exception 'Use a domain your company owns' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('attribution:' || p_project::text, 0));
  if (select count(*) from public.attribution_domains where project_id = p_project and kind = 'custom') >= 5 then
    raise exception 'A project can have up to 5 domains of its own' using errcode = '22023';
  end if;
  begin
    insert into public.attribution_domains(project_id, host, kind, created_by)
    values (p_project, v_host, 'custom', auth.uid());
  exception when unique_violation then
    raise exception 'That domain is already connected to a project' using errcode = '23505';
  end;
  return kma_internal.attribution_view(p_project);
end $$;

create function public.attribution_remove_domain(p_domain uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare d public.attribution_domains;
begin
  select * into d from public.attribution_domains where id = p_domain;
  if d.id is null then
    raise exception 'Domain not found' using errcode = 'P0002';
  end if;
  perform kma_internal.analytics_require_project(d.project_id, 'developer');
  if d.kind = 'kma' then
    raise exception 'The KissMyApps subdomain stays with the project; rename it instead' using errcode = '22023';
  end if;
  delete from public.attribution_domains where id = p_domain;
  return kma_internal.attribution_view(d.project_id);
end $$;

-- Link service functions ----------------------------------------------------------------
-- Only the attribution-links function calls these, for deploy/link-service; never people.

-- What a link domain should answer: null when no project uses the host.
create function public.attribution_link_host(p_host text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_host text := kma_internal.attribution_host(p_host);
  d public.attribution_domains;
  s public.attribution_settings;
begin
  select * into d from public.attribution_domains where host = v_host;
  if d.id is null then
    return null;
  end if;
  select * into s from public.attribution_settings where project_id = d.project_id;
  return jsonb_build_object(
    'host', d.host,
    'project_id', d.project_id,
    'kind', d.kind,
    'enabled', coalesce(s.enabled, false),
    'ios_app_ids', case when s.ios_team_id is not null and s.ios_bundle_id is not null
      then jsonb_build_array(s.ios_team_id || '.' || s.ios_bundle_id) else '[]'::jsonb end,
    'android', case when s.android_package is not null and cardinality(s.android_sha256) > 0
      then jsonb_build_object('package', s.android_package, 'sha256', to_jsonb(s.android_sha256)) end,
    'web_url', s.web_url
  );
end $$;

-- A request for the host reached the link service over HTTPS, so its DNS points here.
-- Marks a custom domain live, and notes when any domain was last used (hourly at most).
create function public.attribution_link_seen(p_host text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v_host text := kma_internal.attribution_host(p_host);
begin
  update public.attribution_domains
  set last_seen_at = now(), verified_at = coalesce(verified_at, now())
  where host = v_host and (last_seen_at is null or last_seen_at < now() - interval '1 hour' or verified_at is null);
  return found;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'attribution_get(uuid)', 'attribution_check_subdomain(uuid,text)', 'attribution_enable(uuid,text)',
    'attribution_disable(uuid)', 'attribution_update(uuid,jsonb)', 'attribution_set_subdomain(uuid,text)',
    'attribution_add_domain(uuid,text)', 'attribution_remove_domain(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['attribution_link_host(text)', 'attribution_link_seen(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

commit;
