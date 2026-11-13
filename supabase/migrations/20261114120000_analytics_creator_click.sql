-- Affiliate self-serve, Phase 2: a visit keeps the creator click that opened it.
-- The tracking redirect adds kma_click to the landing page address and the web SDK sends
-- it with the visit, beside the other click IDs. It goes to analytics_sessions.creator_click
-- (added with the program tables), never to click_ids, so the Sources report and the ad
-- platforms' click IDs are untouched. A sale with no creator tag of its own can then be
-- matched through the buyer's visits.
begin;

-- The definition from 20261103120000_merchant_attribution_links.sql with creator_click added.
create or replace function kma_internal.analytics_touch_session(
  p_project uuid, p_environment text, p_person uuid, p_session_key text, p_started_at timestamptz,
  p_at timestamptz, p_context jsonb, p_geo jsonb, p_ip_hash text, p_user_agent text
) returns uuid language plpgsql volatile set search_path = '' as $$
declare
  v_session uuid;
  v_inserted boolean;
  v_link_click text := kma_internal.analytics_text(p_context#>'{click,kma_lc}', 40);
  v_creator_click text := kma_internal.analytics_text(p_context#>'{click,kma_click}', 128);
  v_click_ids jsonb := '{}'::jsonb;
  k text;
begin
  if v_link_click !~ '^[A-Za-z0-9_-]{16,40}$' then
    v_link_click := null;
  end if;
  if v_creator_click !~ '^[A-Za-z0-9_-]{16,128}$' then
    v_creator_click := null;
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
    creator_click, landing, interactions, webdriver
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
    v_creator_click, kma_internal.analytics_text(p_context->'page_path', 500),
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
    creator_click = coalesce(public.analytics_sessions.creator_click, excluded.creator_click),
    click_ids = case when public.analytics_sessions.click_ids = '{}'::jsonb then excluded.click_ids
      else public.analytics_sessions.click_ids end
  returning id, (xmax = 0) into v_session, v_inserted;
  if v_inserted then
    update public.analytics_people set sessions_count = sessions_count + 1 where id = p_person;
  end if;
  return v_session;
end $$;

commit;
