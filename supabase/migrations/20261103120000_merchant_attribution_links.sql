-- Merchant attribution, phase 1: smart links and web attribution.
--
-- A project makes links on its link domains. The link service (deploy/link-service) sends
-- each person on to the App Store, Google Play or the website, records the click, and adds
-- kma_lc=<click id> to website addresses. The web SDK keeps that click ID, the ad
-- platforms' click IDs (gclid, fbclid, ttclid and others) and the UTM tags of each visit's
-- landing page, so every session says where it came from.
--
-- Reports give a conversion (an event the project counts, such as a sign-up) to the last
-- visit with a source in the web window before it, or to the person's first visit with a
-- source. Credit is worked out when a report is read, from the person's sessions as they
-- are now, so a visitor who signs in on another device later still joins up.
begin;

-- Conversions and the web window ----------------------------------------------------------

alter table public.attribution_settings
  add column conversion_events text[] not null default '{}' check (
    cardinality(conversion_events) <= 20
    and array_to_string(conversion_events, ',') ~ '^([A-Za-z][A-Za-z0-9_.:-]{0,79}(,|$))*$'
  ),
  add column web_lookback_days integer not null default 30 check (web_lookback_days between 1 and 90);

-- Where each visit came from --------------------------------------------------------------

alter table public.analytics_sessions
  add column utm_content text,
  add column utm_term text,
  -- The smart link click that opened this visit (kma_lc on the landing page).
  add column link_click text,
  -- Ad platforms' click IDs on the landing page: gclid, gbraid, wbraid, fbclid, ttclid, msclkid.
  add column click_ids jsonb not null default '{}' check (jsonb_typeof(click_ids) = 'object');
create index analytics_sessions_link_click on public.analytics_sessions(project_id, link_click) where link_click is not null;

-- Links and clicks -------------------------------------------------------------------------

create table public.attribution_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  -- The part after the domain: https://speaksix.go.kissmyapps.dev/<path>
  path text not null check (path ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name text not null check (length(name) between 1 and 120),
  -- Who sent the person (media source), and the campaign's parts.
  source text not null check (source ~ '^[a-z0-9][a-z0-9_.-]{0,59}$'),
  campaign text check (length(campaign) between 1 and 200),
  channel text check (length(channel) between 1 and 100),
  adset text check (length(adset) between 1 and 200),
  ad text check (length(ad) between 1 and 200),
  -- What the app opens; the app SDKs deliver it once they support links.
  deep_link_value text check (length(deep_link_value) between 1 and 500),
  deep_link_params jsonb not null default '{}' check (jsonb_typeof(deep_link_params) = 'object'),
  -- Where each device goes instead of the project's defaults.
  web_url text check (length(web_url) <= 2000 and web_url ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$'),
  ios_url text check (length(ios_url) <= 2000 and ios_url ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$'),
  android_url text check (length(android_url) <= 2000 and android_url ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$'),
  -- What a shared link shows in a chat or a feed.
  social_title text check (length(social_title) between 1 and 120),
  social_description text check (length(social_description) between 1 and 300),
  social_image text check (length(social_image) <= 2000 and social_image ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$'),
  status text not null default 'active' check (status in ('active', 'paused')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (project_id, path)
);
create index attribution_links_project on public.attribution_links(project_id, created_at desc);

create table public.attribution_clicks (
  -- Made by the link service and carried on as kma_lc.
  id text primary key check (id ~ '^[A-Za-z0-9_-]{16,40}$'),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  link_id uuid not null references public.attribution_links(id) on delete cascade,
  clicked_at timestamptz not null,
  platform text not null check (platform in ('ios', 'android', 'desktop')),
  -- The app whose own browser opened the link, such as instagram.
  in_app text check (in_app ~ '^[a-z0-9_]{1,30}$'),
  destination text not null check (destination in ('app_store', 'play_store', 'web', 'custom', 'page')),
  -- The link's source and campaign as they were at the click, with any the address set.
  source text not null,
  campaign text,
  channel text,
  adset text,
  ad text,
  -- sub1 to sub5, dl (a deep link value for this click), web_id and from (web to app).
  params jsonb not null default '{}' check (jsonb_typeof(params) = 'object'),
  click_ids jsonb not null default '{}' check (jsonb_typeof(click_ids) = 'object'),
  ip_hash text,
  user_agent text,
  referrer text,
  received_at timestamptz not null default now()
);
create index attribution_clicks_project on public.attribution_clicks(project_id, clicked_at desc);
create index attribution_clicks_link on public.attribution_clicks(link_id, clicked_at desc);

do $$
declare t text;
begin
  foreach t in array array['attribution_links', 'attribution_clicks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Sessions keep the landing page's click IDs and every UTM tag -----------------------------

create or replace function kma_internal.analytics_touch_session(
  p_project uuid, p_environment text, p_person uuid, p_session_key text, p_started_at timestamptz,
  p_at timestamptz, p_context jsonb, p_geo jsonb, p_ip_hash text, p_user_agent text
) returns uuid language plpgsql volatile set search_path = '' as $$
declare
  v_session uuid;
  v_inserted boolean;
  v_link_click text := kma_internal.analytics_text(p_context#>'{click,kma_lc}', 40);
  v_click_ids jsonb := '{}'::jsonb;
  k text;
begin
  if v_link_click !~ '^[A-Za-z0-9_-]{16,40}$' then
    v_link_click := null;
  end if;
  foreach k in array array['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'] loop
    if kma_internal.analytics_text(p_context#>array['click', k], 300) is not null then
      v_click_ids := v_click_ids || jsonb_build_object(k, kma_internal.analytics_text(p_context#>array['click', k], 300));
    end if;
  end loop;
  insert into public.analytics_sessions(
    project_id, person_id, session_key, environment, started_at, ended_at, platform,
    country, region, city, location_source, timezone, language, device_type, device_model, os_name, os_version,
    browser, browser_version, app_version, sdk, screen_width, screen_height, network, carrier, user_agent, ip_hash,
    referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term, link_click, click_ids,
    landing, interactions, webdriver
  ) values (
    p_project, p_person, p_session_key, p_environment, least(coalesce(p_started_at, p_at), p_at), p_at,
    coalesce(kma_internal.analytics_text(p_context->'platform', 20), 'web'),
    p_geo->>'country', p_geo->>'region', p_geo->>'city', p_geo->>'source',
    kma_internal.analytics_text(p_context->'timezone', 64),
    kma_internal.analytics_text(p_context->'language', 35),
    kma_internal.analytics_text(p_context->'device_type', 20),
    kma_internal.analytics_text(p_context->'device_model', 80),
    kma_internal.analytics_text(p_context->'os_name', 40),
    kma_internal.analytics_text(p_context->'os_version', 40),
    kma_internal.analytics_text(p_context->'browser', 40),
    kma_internal.analytics_text(p_context->'browser_version', 40),
    kma_internal.analytics_text(p_context->'app_version', 40),
    kma_internal.analytics_text(p_context->'sdk', 60),
    kma_internal.analytics_int(p_context->'screen_width'),
    kma_internal.analytics_int(p_context->'screen_height'),
    kma_internal.analytics_text(p_context->'network', 20),
    kma_internal.analytics_text(p_context->'carrier', 60),
    left(p_user_agent, 400), p_ip_hash,
    kma_internal.analytics_text(p_context->'referrer', 500),
    kma_internal.analytics_text(p_context#>'{utm,source}'),
    kma_internal.analytics_text(p_context#>'{utm,medium}'),
    kma_internal.analytics_text(p_context#>'{utm,campaign}'),
    kma_internal.analytics_text(p_context#>'{utm,content}'),
    kma_internal.analytics_text(p_context#>'{utm,term}'),
    v_link_click, v_click_ids,
    kma_internal.analytics_text(p_context->'page_path', 500),
    coalesce(kma_internal.analytics_int(p_context->'interactions'), 0),
    coalesce((p_context->>'webdriver')::boolean, false)
  )
  on conflict (project_id, session_key) do update set
    ended_at = greatest(public.analytics_sessions.ended_at, excluded.ended_at),
    started_at = least(public.analytics_sessions.started_at, excluded.started_at),
    person_id = excluded.person_id,
    environment = case when excluded.environment = 'production' then 'production' else public.analytics_sessions.environment end,
    interactions = greatest(public.analytics_sessions.interactions, excluded.interactions),
    webdriver = public.analytics_sessions.webdriver or excluded.webdriver,
    app_version = coalesce(excluded.app_version, public.analytics_sessions.app_version),
    -- A session keeps its first place, unless a later event knows more: a place where it
    -- had none, or a city where it had only a country. The place moves as a whole.
    country = case when (public.analytics_sessions.country is null and excluded.country is not null)
      or (public.analytics_sessions.city is null and excluded.city is not null)
      then excluded.country else public.analytics_sessions.country end,
    region = case when (public.analytics_sessions.country is null and excluded.country is not null)
      or (public.analytics_sessions.city is null and excluded.city is not null)
      then excluded.region else public.analytics_sessions.region end,
    city = case when (public.analytics_sessions.country is null and excluded.country is not null)
      or (public.analytics_sessions.city is null and excluded.city is not null)
      then excluded.city else public.analytics_sessions.city end,
    location_source = case when (public.analytics_sessions.country is null and excluded.country is not null)
      or (public.analytics_sessions.city is null and excluded.city is not null)
      then excluded.location_source else public.analytics_sessions.location_source end,
    ip_hash = coalesce(public.analytics_sessions.ip_hash, excluded.ip_hash),
    -- The landing page's source stays; a later request only fills in what the first lacked.
    link_click = coalesce(public.analytics_sessions.link_click, excluded.link_click),
    click_ids = case when public.analytics_sessions.click_ids = '{}'::jsonb then excluded.click_ids
      else public.analytics_sessions.click_ids end
  returning id, (xmax = 0) into v_session, v_inserted;
  if v_inserted then
    update public.analytics_people set sessions_count = sessions_count + 1 where id = p_person;
  end if;
  return v_session;
end $$;

-- Where a visit came from -------------------------------------------------------------------

-- An ad platform named by the click ID it added to the landing page.
create function kma_internal.attribution_click_source(p_ids jsonb) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_ids ?| array['gclid', 'gbraid', 'wbraid'] then 'google_ads'
    when p_ids ? 'fbclid' then 'meta'
    when p_ids ? 'ttclid' then 'tiktok'
    when p_ids ? 'msclkid' then 'microsoft_ads'
  end
$$;

-- The project's own hosts: its allowed websites, its default website and its link domains.
-- A visit from one of them is the person moving around the merchant's own site.
create function kma_internal.attribution_own_hosts(p_project uuid) returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(distinct h), '{}') from (
    select regexp_replace(lower(substring(o from '^[a-z][a-z0-9+.-]*://([^/:?#]+)')), '^www\.', '') h
    from public.analytics_projects p, unnest(p.allowed_origins) o where p.id = p_project
    union all
    select regexp_replace(lower(substring(s.web_url from '^https://([^/:?#]+)')), '^www\.', '')
    from public.attribution_settings s where s.project_id = p_project
    union all
    select d.host from public.attribution_domains d where d.project_id = p_project
  ) x where h is not null
$$;

-- The site a visitor came from, or null for their own site, a payment or sign-in page
-- (returning from checkout is not a new source), or no referrer.
create function kma_internal.attribution_referrer_source(p_referrer text, p_own text[]) returns text
language plpgsql immutable set search_path = '' as $$
declare v_host text := lower(substring(p_referrer from '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#]+)'));
begin
  if v_host is null then
    return null;
  end if;
  v_host := regexp_replace(v_host, '^(www|m|l|lm|mobile)\.', '');
  if v_host = any(p_own) or exists (select 1 from unnest(p_own) o where v_host like '%.' || o)
     or v_host ~ '(^|\.)(stripe\.com|paypal\.com|paystack\.com|paystack\.co|flutterwave\.com|checkout\.com|klarna\.com|appleid\.apple\.com|accounts\.google\.com)$' then
    return null;
  end if;
  return v_host;
end $$;

-- A visit's source, or null when it came direct. A smart link click wins, then UTM tags,
-- then an ad platform's click ID, then the referring site.
create function kma_internal.attribution_touch(s public.analytics_sessions, p_own text[]) returns jsonb
language sql stable set search_path = '' as $$
  select case
    when c.id is not null then jsonb_strip_nulls(jsonb_build_object('method', 'link', 'source', c.source,
      'campaign', c.campaign, 'channel', c.channel, 'adset', c.adset, 'ad', c.ad, 'link_id', c.link_id))
    when nullif(btrim(s.utm_source), '') is not null then jsonb_strip_nulls(jsonb_build_object('method', 'utm',
      'source', lower(btrim(s.utm_source)), 'campaign', s.utm_campaign, 'channel', s.utm_medium, 'ad', s.utm_content))
    when kma_internal.attribution_click_source(s.click_ids) is not null then
      jsonb_build_object('method', 'click_id', 'source', kma_internal.attribution_click_source(s.click_ids))
    when kma_internal.attribution_referrer_source(s.referrer, p_own) is not null then
      jsonb_build_object('method', 'referrer', 'source', kma_internal.attribution_referrer_source(s.referrer, p_own))
  end
  from (select 1) one
  left join public.attribution_clicks c on c.id = s.link_click and c.project_id = s.project_id
$$;

-- Report sessions in a window, each with its source (null when direct).
create function kma_internal.attribution_visits(p_project uuid, p_from timestamptz, p_to timestamptz)
returns table (session_id uuid, person_id uuid, started_at timestamptz, touch jsonb)
language sql stable set search_path = '' as $$
  select s.id, s.person_id, s.started_at, kma_internal.attribution_touch(s, o.hosts)
  from kma_internal.analytics_report_sessions(p_project, p_from, p_to) s
  cross join (select kma_internal.attribution_own_hosts(p_project) hosts) o
$$;

-- Conversions in a window, each with the visit that gets the credit (touch is null when
-- none did). last: the latest visit with a source in the web window before it. first: the
-- person's first visit with a source.
create function kma_internal.attribution_credit(p_project uuid, p_from timestamptz, p_to timestamptz, p_model text)
returns table (event_id bigint, person_id uuid, occurred_at timestamptz, name text, touch jsonb)
language sql stable set search_path = '' as $$
  select e.id, e.person_id, e.occurred_at, e.name, t.touch
  from public.attribution_settings st
  cross join (select kma_internal.attribution_own_hosts(p_project) hosts) o
  join public.analytics_events e on e.project_id = st.project_id
  left join public.analytics_sessions es on es.id = e.session_id
  left join lateral (
    select kma_internal.attribution_touch(s, o.hosts) touch
    from public.analytics_sessions s
    where s.person_id = e.person_id and s.environment = 'production'
      and s.started_at <= e.occurred_at
      and (p_model = 'first' or s.started_at >= e.occurred_at - make_interval(days => st.web_lookback_days))
      and kma_internal.attribution_touch(s, o.hosts) is not null
    order by case when p_model = 'first' then extract(epoch from s.started_at) else -extract(epoch from s.started_at) end
    limit 1
  ) t on true
  where st.project_id = p_project and e.environment = 'production'
    and e.occurred_at >= p_from and e.occurred_at < p_to
    and e.name = any(st.conversion_events)
    and (es.id is null or not kma_internal.analytics_session_excluded(es))
    and not exists (select 1 from public.analytics_bot_overrides b
      where b.project_id = p_project and b.verdict = 'bot' and b.person_id = e.person_id)
$$;

-- Links ------------------------------------------------------------------------------------

-- The address people see for the project's links: its first live domain of its own, else
-- its subdomain of the link root.
create function kma_internal.attribution_primary_host(p_project uuid) returns text
language sql stable set search_path = '' as $$
  select d.host from public.attribution_domains d
  where d.project_id = p_project and (d.kind = 'kma' or d.verified_at is not null)
  order by d.kind = 'kma', d.created_at limit 1
$$;

create function kma_internal.attribution_link_view(l public.attribution_links, p_host text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', l.id, 'path', l.path, 'url', case when p_host is not null then 'https://' || p_host || '/' || l.path end,
    'name', l.name, 'source', l.source, 'campaign', l.campaign, 'channel', l.channel, 'adset', l.adset, 'ad', l.ad,
    'deep_link_value', l.deep_link_value, 'deep_link_params', l.deep_link_params,
    'web_url', l.web_url, 'ios_url', l.ios_url, 'android_url', l.android_url,
    'social_title', l.social_title, 'social_description', l.social_description, 'social_image', l.social_image,
    'status', l.status, 'created_at', l.created_at, 'updated_at', l.updated_at
  )
$$;

-- A short random path, without letters and numbers that look alike.
create function kma_internal.attribution_random_path() returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('abcdefghijkmnpqrstuvwxyz23456789', 1 + get_byte(b, i) % 32, 1), '' order by i)
  from extensions.gen_random_bytes(7) b, generate_series(0, 6) i
$$;

-- An https address typed with or without its scheme; empty clears it.
create function kma_internal.attribution_https_url(p_value text, p_label text) returns text
language plpgsql immutable set search_path = '' as $$
declare v_text text := nullif(btrim(coalesce(p_value, '')), '');
begin
  if v_text is null then
    return null;
  end if;
  if v_text !~ '^[A-Za-z][A-Za-z0-9+.-]*://' then
    v_text := 'https://' || v_text;
  end if;
  v_text := lower(substring(v_text from '^[^/?#]*//[^/?#]*')) || coalesce(substring(v_text from '^[^/?#]*//[^/?#]*(.*)$'), '');
  if v_text !~ '^https://' then
    raise exception '% needs an address that starts with https://', p_label using errcode = '22023';
  end if;
  if length(v_text) > 2000 or v_text !~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$' then
    raise exception '% needs a full address, such as https://speaksix.app/start', p_label using errcode = '22023';
  end if;
  return v_text;
end $$;

-- What the attribution screens show, with conversions and the project's events to pick from.
create or replace function kma_internal.attribution_view(p_project uuid) returns jsonb
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
      'conversion_events', to_jsonb(s.conversion_events), 'web_lookback_days', s.web_lookback_days,
      'enabled_at', s.enabled_at, 'disabled_at', s.disabled_at, 'updated_at', s.updated_at
    ) end,
    'domains', v_domains,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('name', e.name, 'last_seen', e.last_seen) order by e.last_seen desc)
      from (select * from public.analytics_event_definitions d
        where d.project_id = p_project and d.status = 'live'
        order by d.last_seen desc limit 200) e
    ), '[]'::jsonb),
    'setup', jsonb_build_object(
      'apps', kma_internal.attribution_apps_ready(p, s),
      'domain', s.project_id is not null and v_live,
      'sdk', false,
      'conversions', coalesce(cardinality(s.conversion_events) > 0, false),
      'partners', false, 'skan', false
    )
  );
end $$;

-- Console RPCs ------------------------------------------------------------------------------

-- Which events count as conversions, and how long a visit's source counts for them.
create function public.attribution_set_conversions(p_project uuid, p_events text[], p_web_lookback_days integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_events text[];
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  perform kma_internal.attribution_require_settings(p_project);
  select coalesce(array_agg(distinct btrim(x)), '{}') into v_events
  from unnest(coalesce(p_events, '{}')) x where btrim(x) <> '';
  if cardinality(v_events) > 20 then
    raise exception 'Choose up to 20 conversion events' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_events) x where x !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$') then
    raise exception 'Event names use letters, numbers and _ . : -, starting with a letter' using errcode = '22023';
  end if;
  if p_web_lookback_days is null or p_web_lookback_days not between 1 and 90 then
    raise exception 'The website window is 1 to 90 days' using errcode = '22023';
  end if;
  update public.attribution_settings
  set conversion_events = coalesce((select array_agg(x order by x) from unnest(v_events) x), '{}'),
    web_lookback_days = p_web_lookback_days, updated_at = now(), updated_by = auth.uid()
  where project_id = p_project;
  return kma_internal.attribution_view(p_project);
end $$;

-- The project's links, with clicks, visits and conversions in the range.
create function public.attribution_links(p_project uuid, p_range text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.analytics_projects := kma_internal.analytics_require_project(p_project);
  w record;
  v_host text := kma_internal.attribution_primary_host(p_project);
begin
  perform kma_internal.attribution_require_settings(p_project);
  select * into w from kma_internal.analytics_window(p_range, p.timezone);
  return jsonb_build_object(
    'range', p_range,
    'host', v_host,
    'hosts', coalesce((select jsonb_agg(d.host order by d.kind = 'kma', d.created_at) from public.attribution_domains d
      where d.project_id = p_project and (d.kind = 'kma' or d.verified_at is not null)), '[]'::jsonb),
    'links', coalesce((
      with clicks as (
        select c.link_id, count(*) n from public.attribution_clicks c
        where c.project_id = p_project and c.clicked_at >= w.from_at and c.clicked_at < w.to_at group by 1
      ), visits as (
        select (v.touch->>'link_id')::uuid link_id, count(*) n from kma_internal.attribution_visits(p_project, w.from_at, w.to_at) v
        where v.touch->>'method' = 'link' group by 1
      ), conversions as (
        select (c.touch->>'link_id')::uuid link_id, count(*) n from kma_internal.attribution_credit(p_project, w.from_at, w.to_at, 'last') c
        where c.touch->>'method' = 'link' group by 1
      )
      select jsonb_agg(kma_internal.attribution_link_view(l, v_host) || jsonb_build_object(
          'clicks', coalesce(ck.n, 0), 'visits', coalesce(vs.n, 0), 'conversions', coalesce(cv.n, 0))
        order by l.status = 'paused', l.created_at desc)
      from public.attribution_links l
      left join clicks ck on ck.link_id = l.id
      left join visits vs on vs.link_id = l.id
      left join conversions cv on cv.link_id = l.id
      where l.project_id = p_project
    ), '[]'::jsonb)
  );
end $$;

-- Creates a link (p_link null) or changes one. Fields left out stay as they are; an empty
-- value clears an optional one.
create function public.attribution_save_link(p_project uuid, p_link uuid, p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  l public.attribution_links;
  v_text text;
  v_key text;
  v_params jsonb;
  k text;
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  perform kma_internal.attribution_require_settings(p_project);
  if jsonb_typeof(p_fields) is distinct from 'object' or exists (
    select 1 from jsonb_object_keys(p_fields) x where x <> all(array[
      'path', 'name', 'source', 'campaign', 'channel', 'adset', 'ad', 'deep_link_value', 'deep_link_params',
      'web_url', 'ios_url', 'android_url', 'social_title', 'social_description', 'social_image'
    ])
  ) then
    raise exception 'Unknown link field' using errcode = '22023';
  end if;
  if p_link is null then
    if (select count(*) from public.attribution_links where project_id = p_project) >= 1000 then
      raise exception 'A project can have up to 1,000 links' using errcode = '22023';
    end if;
    l.project_id := p_project;
    l.deep_link_params := '{}';
    l.status := 'active';
  else
    select * into l from public.attribution_links where id = p_link and project_id = p_project;
    if l.id is null then
      raise exception 'Link not found' using errcode = 'P0002';
    end if;
  end if;

  if p_fields ? 'name' or p_link is null then
    v_text := btrim(coalesce(p_fields->>'name', ''));
    if length(v_text) not between 1 and 120 then
      raise exception 'Give the link a name of up to 120 characters' using errcode = '22023';
    end if;
    l.name := v_text;
  end if;
  if p_fields ? 'source' or p_link is null then
    v_text := regexp_replace(lower(btrim(coalesce(p_fields->>'source', ''))), '\s+', '_', 'g');
    if v_text !~ '^[a-z0-9][a-z0-9_.-]{0,59}$' then
      raise exception 'Name the media source in up to 60 letters, numbers and _ . -, such as tiktok or influencer' using errcode = '22023';
    end if;
    l.source := v_text;
  end if;
  if p_fields ? 'path' or p_link is null then
    v_text := lower(btrim(coalesce(p_fields->>'path', ''), ' /'));
    if v_text = '' then
      if p_link is not null then
        raise exception 'A link needs an address' using errcode = '22023';
      end if;
      loop
        v_text := kma_internal.attribution_random_path();
        exit when not exists (select 1 from public.attribution_links where project_id = p_project and path = v_text);
      end loop;
    elsif v_text !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
      raise exception 'Use up to 64 lowercase letters, numbers, hyphens and underscores for the address' using errcode = '22023';
    elsif v_text in ('healthz', 'well-known', 'robots', 'favicon') then
      raise exception 'That address is kept for KissMyApps. Try another.' using errcode = '22023';
    end if;
    l.path := v_text;
  end if;
  foreach k in array array['campaign', 'channel', 'adset', 'ad', 'deep_link_value', 'social_title', 'social_description'] loop
    continue when not p_fields ? k;
    v_text := nullif(btrim(coalesce(p_fields->>k, '')), '');
    if v_text is not null and length(v_text) > (case k when 'channel' then 100 when 'social_title' then 120
        when 'social_description' then 300 when 'deep_link_value' then 500 else 200 end) then
      raise exception '%', case k
        when 'channel' then 'The channel is up to 100 characters'
        when 'social_title' then 'The preview title is up to 120 characters'
        when 'social_description' then 'The preview description is up to 300 characters'
        when 'deep_link_value' then 'The in-app screen is up to 500 characters'
        else 'Campaigns, ad sets and ads are up to 200 characters' end using errcode = '22023';
    end if;
    case k
      when 'campaign' then l.campaign := v_text;
      when 'channel' then l.channel := v_text;
      when 'adset' then l.adset := v_text;
      when 'ad' then l.ad := v_text;
      when 'deep_link_value' then l.deep_link_value := v_text;
      when 'social_title' then l.social_title := v_text;
      else l.social_description := v_text;
    end case;
  end loop;
  if p_fields ? 'web_url' then l.web_url := kma_internal.attribution_https_url(p_fields->>'web_url', 'The website page'); end if;
  if p_fields ? 'ios_url' then l.ios_url := kma_internal.attribution_https_url(p_fields->>'ios_url', 'The iPhone destination'); end if;
  if p_fields ? 'android_url' then l.android_url := kma_internal.attribution_https_url(p_fields->>'android_url', 'The Android destination'); end if;
  if p_fields ? 'social_image' then l.social_image := kma_internal.attribution_https_url(p_fields->>'social_image', 'The preview image'); end if;
  if p_fields ? 'deep_link_params' then
    v_params := coalesce(p_fields->'deep_link_params', '{}'::jsonb);
    if jsonb_typeof(v_params) = 'null' then v_params := '{}'; end if;
    if jsonb_typeof(v_params) <> 'object' or (select count(*) from jsonb_object_keys(v_params)) > 10 then
      raise exception 'Add up to 10 in-app parameters' using errcode = '22023';
    end if;
    for v_key in select jsonb_object_keys(v_params) loop
      if v_key !~ '^[A-Za-z][A-Za-z0-9_]{0,39}$' or jsonb_typeof(v_params->v_key) <> 'string'
         or length(v_params->>v_key) > 500 then
        raise exception 'In-app parameters are names of letters, numbers and _ with text values up to 500 characters' using errcode = '22023';
      end if;
    end loop;
    l.deep_link_params := v_params;
  end if;

  begin
    if p_link is null then
      insert into public.attribution_links(project_id, path, name, source, campaign, channel, adset, ad, deep_link_value,
        deep_link_params, web_url, ios_url, android_url, social_title, social_description, social_image, created_by, updated_by)
      values (p_project, l.path, l.name, l.source, l.campaign, l.channel, l.adset, l.ad, l.deep_link_value,
        l.deep_link_params, l.web_url, l.ios_url, l.android_url, l.social_title, l.social_description, l.social_image, auth.uid(), auth.uid())
      returning * into l;
    else
      update public.attribution_links set path = l.path, name = l.name, source = l.source, campaign = l.campaign,
        channel = l.channel, adset = l.adset, ad = l.ad, deep_link_value = l.deep_link_value,
        deep_link_params = l.deep_link_params, web_url = l.web_url, ios_url = l.ios_url, android_url = l.android_url,
        social_title = l.social_title, social_description = l.social_description, social_image = l.social_image,
        updated_at = now(), updated_by = auth.uid()
      where id = l.id
      returning * into l;
    end if;
  exception when unique_violation then
    raise exception 'Another link already uses that address' using errcode = '23505';
  end;
  return kma_internal.attribution_link_view(l, kma_internal.attribution_primary_host(p_project));
end $$;

-- Pausing a link sends its visitors to the website without counting them.
create function public.attribution_set_link_status(p_link uuid, p_status text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare l public.attribution_links;
begin
  select * into l from public.attribution_links where id = p_link;
  if l.id is null then
    raise exception 'Link not found' using errcode = 'P0002';
  end if;
  perform kma_internal.analytics_require_project(l.project_id, 'developer');
  if p_status is null or p_status not in ('active', 'paused') then
    raise exception 'A link is active or paused' using errcode = '22023';
  end if;
  update public.attribution_links set status = p_status, updated_at = now(), updated_by = auth.uid()
  where id = p_link returning * into l;
  return kma_internal.attribution_link_view(l, kma_internal.attribution_primary_host(l.project_id));
end $$;

-- A link nobody has clicked can be deleted; one with clicks is paused instead, so its
-- visits keep their source.
create function public.attribution_delete_link(p_link uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare l public.attribution_links;
begin
  select * into l from public.attribution_links where id = p_link;
  if l.id is null then
    raise exception 'Link not found' using errcode = 'P0002';
  end if;
  perform kma_internal.analytics_require_project(l.project_id, 'developer');
  if exists (select 1 from public.attribution_clicks c where c.link_id = p_link) then
    raise exception 'This link has clicks, so it can only be paused' using errcode = '22023';
  end if;
  delete from public.attribution_links where id = p_link;
  return jsonb_build_object('deleted', true);
end $$;

-- Where people came from in the range: clicks on links, visits, the people visiting, and
-- the conversions each source gets credit for. With p_source, that source's campaigns.
create function public.attribution_sources(p_project uuid, p_range text, p_model text default 'last', p_source text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.analytics_projects := kma_internal.analytics_require_project(p_project);
  s public.attribution_settings := kma_internal.attribution_require_settings(p_project);
  w record;
  v_rows jsonb;
  v_totals jsonb;
begin
  if p_model is null or p_model not in ('last', 'first') then
    raise exception 'Choose last or first touch' using errcode = '22023';
  end if;
  select * into w from kma_internal.analytics_window(p_range, p.timezone);
  with clicks as (
    select case when p_source is null then c.source else c.campaign end k, count(*) clicks
    from public.attribution_clicks c
    where c.project_id = p_project and c.clicked_at >= w.from_at and c.clicked_at < w.to_at
      and (p_source is null or c.source = p_source)
    group by 1
  ), visits as (
    select case when p_source is null then v.touch->>'source' else v.touch->>'campaign' end k,
      count(*) visits, count(distinct v.person_id) people
    from kma_internal.attribution_visits(p_project, w.from_at, w.to_at) v
    where p_source is null or v.touch->>'source' = p_source
    group by 1
  ), conversions as (
    select case when p_source is null then c.touch->>'source' else c.touch->>'campaign' end k,
      count(*) conversions, count(distinct c.person_id) converters
    from kma_internal.attribution_credit(p_project, w.from_at, w.to_at, p_model) c
    where p_source is null or c.touch->>'source' = p_source
    group by 1
  ), keys as (
    select k from clicks union select k from visits union select k from conversions
  ), grouped as (
    select k.k, coalesce(ck.clicks, 0) clicks, coalesce(vs.visits, 0) visits, coalesce(vs.people, 0) people,
      coalesce(cv.conversions, 0) conversions, coalesce(cv.converters, 0) converters
    from keys k
    left join clicks ck on ck.k is not distinct from k.k
    left join visits vs on vs.k is not distinct from k.k
    left join conversions cv on cv.k is not distinct from k.k
  )
  select coalesce(jsonb_agg(jsonb_build_object('key', r.k, 'clicks', r.clicks, 'visits', r.visits, 'people', r.people,
      'conversions', r.conversions, 'converters', r.converters)
      order by r.k is null, r.conversions desc, r.visits desc, r.clicks desc, r.k), '[]'::jsonb),
    jsonb_build_object('clicks', coalesce(sum(r.clicks), 0), 'visits', coalesce(sum(r.visits), 0),
      'conversions', coalesce(sum(r.conversions), 0))
  into v_rows, v_totals
  from (select * from grouped order by k is null, conversions desc, visits desc, clicks desc, k limit 200) r;
  return jsonb_build_object(
    'range', p_range, 'model', p_model, 'source', p_source,
    'conversion_events', to_jsonb(s.conversion_events), 'web_lookback_days', s.web_lookback_days,
    -- People are counted once over the whole range, so rows can add up to more.
    'totals', v_totals || jsonb_build_object(
      'people', (select count(distinct v.person_id) from kma_internal.attribution_visits(p_project, w.from_at, w.to_at) v
        where p_source is null or v.touch->>'source' = p_source),
      'converters', (select count(distinct c.person_id) from kma_internal.attribution_credit(p_project, w.from_at, w.to_at, p_model) c
        where p_source is null or c.touch->>'source' = p_source)),
    'rows', v_rows
  );
end $$;

-- Link service functions ---------------------------------------------------------------------

-- What a link on a host leads to: null when the host or the path is unknown.
create function public.attribution_link_target(p_host text, p_path text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d public.attribution_domains;
  s public.attribution_settings;
  l public.attribution_links;
  v_project_name text;
begin
  select * into d from public.attribution_domains where host = kma_internal.attribution_host(p_host);
  if d.id is null then
    return null;
  end if;
  select * into l from public.attribution_links
  where project_id = d.project_id and path = lower(btrim(coalesce(p_path, ''), '/'));
  if l.id is null then
    return null;
  end if;
  select * into s from public.attribution_settings where project_id = d.project_id;
  select name into v_project_name from public.analytics_projects where id = d.project_id;
  return jsonb_build_object(
    'id', l.id, 'project_id', l.project_id, 'project_name', v_project_name, 'path', l.path,
    'status', case when coalesce(s.enabled, false) then l.status else 'paused' end,
    'source', l.source, 'campaign', l.campaign, 'channel', l.channel, 'adset', l.adset, 'ad', l.ad,
    'deep_link_value', l.deep_link_value, 'deep_link_params', l.deep_link_params,
    'web_url', coalesce(l.web_url, s.web_url),
    'ios_url', coalesce(l.ios_url, case when s.ios_app_store_id is not null then 'https://apps.apple.com/app/id' || s.ios_app_store_id end),
    'ios_custom', l.ios_url is not null,
    'android_url', l.android_url,
    'android_package', s.android_package,
    'social', case when l.social_title is not null or l.social_description is not null or l.social_image is not null then
      jsonb_strip_nulls(jsonb_build_object('title', coalesce(l.social_title, v_project_name),
        'description', l.social_description, 'image', l.social_image)) end
  );
end $$;

-- Clicks from the link service, in batches. Each names its link; unknown links and clicks
-- seen before are skipped. The function hashes each address with the analytics salt; it is
-- hashed again here with the project, as sessions' addresses are.
create function public.attribution_record_clicks(p_clicks jsonb) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  c jsonb;
  l public.attribution_links;
  v_stored integer := 0;
  v_at timestamptz;
  v_params jsonb;
  v_ids jsonb;
  k text;
begin
  if jsonb_typeof(p_clicks) is distinct from 'array' or jsonb_array_length(p_clicks) > 500 then
    raise exception 'Send up to 500 clicks' using errcode = '22023';
  end if;
  for c in select value from jsonb_array_elements(p_clicks) loop
    continue when jsonb_typeof(c) <> 'object' or coalesce(c->>'id', '') !~ '^[A-Za-z0-9_-]{16,40}$'
      or coalesce(c->>'link_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(c->>'platform', '') not in ('ios', 'android', 'desktop')
      or coalesce(c->>'destination', '') not in ('app_store', 'play_store', 'web', 'custom', 'page')
      or coalesce(c->>'clicked_at', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$';
    v_at := (c->>'clicked_at')::timestamptz;
    continue when v_at > now() + interval '5 minutes' or v_at < now() - interval '7 days';
    select * into l from public.attribution_links where id = (c->>'link_id')::uuid;
    continue when l.id is null;
    v_params := '{}';
    foreach k in array array['sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'dl', 'web_id', 'from'] loop
      if kma_internal.analytics_text(c->'params'->k, 500) is not null then
        v_params := v_params || jsonb_build_object(k, kma_internal.analytics_text(c->'params'->k, 500));
      end if;
    end loop;
    v_ids := '{}';
    foreach k in array array['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'] loop
      if kma_internal.analytics_text(c->'click_ids'->k, 300) is not null then
        v_ids := v_ids || jsonb_build_object(k, kma_internal.analytics_text(c->'click_ids'->k, 300));
      end if;
    end loop;
    insert into public.attribution_clicks(id, project_id, link_id, clicked_at, platform, in_app, destination,
      source, campaign, channel, adset, ad, params, click_ids, ip_hash, user_agent, referrer)
    values (c->>'id', l.project_id, l.id, v_at, c->>'platform',
      case when c->>'in_app' ~ '^[a-z0-9_]{1,30}$' then c->>'in_app' end, c->>'destination',
      -- The address may set the source and campaign for one ad (src, cmp, chn, adset, ad).
      coalesce(case when lower(c#>>'{overrides,source}') ~ '^[a-z0-9][a-z0-9_.-]{0,59}$' then lower(c#>>'{overrides,source}') end, l.source),
      coalesce(kma_internal.analytics_text(c->'overrides'->'campaign'), l.campaign),
      coalesce(kma_internal.analytics_text(c->'overrides'->'channel', 100), l.channel),
      coalesce(kma_internal.analytics_text(c->'overrides'->'adset'), l.adset),
      coalesce(kma_internal.analytics_text(c->'overrides'->'ad'), l.ad),
      v_params, v_ids,
      case when c->>'ip_sha' ~ '^[0-9a-f]{64}$'
        then encode(extensions.digest(l.project_id::text || ':' || (c->>'ip_sha'), 'sha256'), 'hex') end,
      kma_internal.analytics_text(c->'user_agent', 400),
      kma_internal.analytics_text(c->'referrer', 500))
    on conflict (id) do nothing;
    if found then
      v_stored := v_stored + 1;
    end if;
  end loop;
  return v_stored;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'attribution_set_conversions(uuid,text[],integer)', 'attribution_links(uuid,text)',
    'attribution_save_link(uuid,uuid,jsonb)', 'attribution_set_link_status(uuid,text)',
    'attribution_delete_link(uuid)', 'attribution_sources(uuid,text,text,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['attribution_link_target(text,text)', 'attribution_record_clicks(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

commit;
