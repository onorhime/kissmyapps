-- Attribution Phase 2: matching an app install to the click that brought it.
--
-- The app SDK calls /v1/attribution/install once, on its first launch, and
-- /v1/attribution/open each time a link opens the app later. The analytics-ingest edge
-- function checks the body, swaps an Apple Ads token for Apple's answer and calls
-- attribution_install or attribution_open with the same envelope as analytics_ingest.
--
-- An install is matched, in this order, stopping at the first hit:
--   0. the person already has an install: the same answer again;
--   1. the same phone installed the app inside the reinstall window (live keys only);
--   2. a link of the project opened the app on its first launch;
--   3. Google Play's install referrer names a click (kma_lc) of the project;
--   4. Apple says the install came from an Apple Ads campaign;
--   5. the click ID the landing page put on the clipboard;
--   6. the signed-in person came to the website through a link of the project;
--   7. otherwise it is organic.
-- attribution_tick tries step 6 again for organic installs whose person signs in later.
-- Each install keeps how it was matched, so every number can say whether it is exact. No
-- install is ever matched by address and browser (no fingerprinting), and nothing is matched
-- across projects.
begin;

-- A reinstall keeps its source when the install it repeats is deleted with its person; the
-- base check made deleting that person fail.
alter table public.attribution_installs drop constraint attribution_install_reinstall;
alter table public.attribution_installs add constraint attribution_install_reinstall
  check (reinstall_of is null or method = 'reinstall');

-- Helpers ------------------------------------------------------------------------------------

-- One percent-encoded value of an address ('+' is a space), or null when it is not UTF-8.
create function kma_internal.attribution_url_decode(p_value text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_out bytea := ''::bytea;
  v_part text;
begin
  if p_value is null then
    return null;
  end if;
  for v_part in
    select m[1] from regexp_matches(replace(p_value, '+', ' '), '(%[0-9A-Fa-f]{2}|[^%]+|%)', 'g') with ordinality t(m, n)
    order by n
  loop
    if v_part ~ '^%[0-9A-Fa-f]{2}$' then
      v_out := v_out || decode(substr(v_part, 2), 'hex');
    else
      v_out := v_out || convert_to(v_part, 'UTF8');
    end if;
  end loop;
  return convert_from(v_out, 'UTF8');
exception when others then
  return null;
end $$;

-- A query string as an object of each name's first value, decoded.
create function kma_internal.attribution_query(p_query text) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
    select distinct on (k) k, v from (
      select kma_internal.attribution_url_decode(split_part(pair, '=', 1)) k,
        kma_internal.attribution_url_decode(substr(pair, length(split_part(pair, '=', 1)) + 2)) v, n
      from regexp_split_to_table(coalesce(p_query, ''), '&') with ordinality t(pair, n)
      where pair <> ''
    ) x
    where k is not null and k <> '' and v is not null
    order by k, n
  ) y
$$;

-- A link address taken apart: its host, its path as links store it, and its query.
create function kma_internal.attribution_parse_url(p_url text) returns jsonb
language sql immutable set search_path = '' as $$
  select case when m is not null then jsonb_build_object(
    'host', kma_internal.attribution_host(m[1]),
    'path', lower(btrim(coalesce(m[2], ''), '/')),
    'query', kma_internal.attribution_query(m[3])) end
  from (select regexp_match(p_url, '^https://([^/?#]+)([^?#]*)(?:\?([^#]*))?') m) x
$$;

-- The project's active link an address names (on any of its domains), or null.
create function kma_internal.attribution_find_link(p_project uuid, p_url jsonb) returns public.attribution_links
language sql stable set search_path = '' as $$
  select l.* from public.attribution_domains d
  join public.attribution_links l on l.project_id = d.project_id
  where d.project_id = p_project and d.host = p_url->>'host' and l.path = p_url->>'path' and l.status = 'active'
$$;

create function kma_internal.attribution_time(p_value text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  return p_value::timestamptz;
exception when others then
  return null;
end $$;

-- Apple's campaign, ad group, keyword and ad IDs are whole numbers.
create function kma_internal.attribution_apple_id(p_value jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_value) in ('number', 'string') and (p_value #>> '{}') ~ '^[0-9]{1,20}$'
    then p_value #>> '{}' end
$$;

-- The field of an app's attribution body that breaks the contract
-- (integrations/analytics-mobile/contract/app-events.json, "attribution"), as the DETAIL code
-- the request is refused with; null when the body keeps it. p_kind is install or open. An
-- optional field may be left out or null. The edge function has already replaced
-- apple_ads_token with Apple's answer, apple_ads, so a token here is refused.
create function kma_internal.attribution_body_problem(p_body jsonb, p_kind text) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_time text := case p_kind when 'install' then 'installed_at' else 'opened_at' end;
  v_url text := case p_kind when 'install' then 'link_url' else 'url' end;
  v_allowed text[] := case p_kind
    when 'install' then array['anonymous_id', 'session_id', 'platform', 'installed_at', 'sdk', 'user_id', 'app_version',
      'device_key', 'link_url', 'referrer', 'referrer_click_ts', 'install_begin_ts', 'apple_ads', 'clipboard_click']
    else array['anonymous_id', 'session_id', 'platform', 'url', 'opened_at', 'sdk', 'user_id', 'app_version', 'device_key'] end;
  v_android boolean;
  k text;
begin
  if jsonb_typeof(p_body) is distinct from 'object' then
    return 'invalid_body';
  end if;
  if exists (select 1 from jsonb_object_keys(p_body) x where x <> all(v_allowed)) then
    return 'unknown_field';
  end if;
  -- Left out and null are the same for an optional field.
  p_body := jsonb_strip_nulls(p_body);
  if kma_internal.analytics_text(p_body->'anonymous_id', 200) is null then return 'invalid_anonymous_id'; end if;
  if kma_internal.analytics_text(p_body->'session_id', 100) is null then return 'invalid_session_id'; end if;
  if jsonb_typeof(p_body->'platform') is distinct from 'string' or p_body->>'platform' not in ('ios', 'android') then
    return 'invalid_platform';
  end if;
  v_android := p_body->>'platform' = 'android';
  if jsonb_typeof(p_body->v_time) is distinct from 'string'
     or p_body->>v_time !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     or kma_internal.attribution_time(p_body->>v_time) is null then
    return 'invalid_' || v_time;
  end if;
  if kma_internal.analytics_text(p_body->'sdk', 60) is null then return 'invalid_sdk'; end if;
  if p_body ? 'user_id' and kma_internal.analytics_text(p_body->'user_id', 200) is null then return 'invalid_user_id'; end if;
  if p_body ? 'app_version' and kma_internal.analytics_text(p_body->'app_version', 40) is null then return 'invalid_app_version'; end if;
  if p_body ? 'device_key' and (jsonb_typeof(p_body->'device_key') <> 'string' or p_body->>'device_key' !~ '^[0-9a-f]{64}$') then
    return 'invalid_device_key';
  end if;
  if (p_kind = 'open' or p_body ? v_url) and (jsonb_typeof(p_body->v_url) is distinct from 'string'
     or length(p_body->>v_url) > 2048 or p_body->>v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$') then
    return 'invalid_' || v_url;
  end if;
  if p_kind = 'open' then
    return null;
  end if;
  -- Google Play's install referrer, Android only.
  if p_body ? 'referrer' and (not v_android or kma_internal.analytics_text(p_body->'referrer', 1024) is null) then
    return 'invalid_referrer';
  end if;
  foreach k in array array['referrer_click_ts', 'install_begin_ts'] loop
    if p_body ? k and (not v_android or jsonb_typeof(p_body->k) <> 'number' or p_body->>k !~ '^[0-9]{1,11}$') then
      return 'invalid_' || k;
    end if;
  end loop;
  -- Apple's answer for the Apple Ads token, iOS only.
  if p_body ? 'apple_ads' and (v_android or jsonb_typeof(p_body->'apple_ads') <> 'object'
     or jsonb_typeof(p_body->'apple_ads'->'attribution') is distinct from 'boolean') then
    return 'invalid_apple_ads';
  end if;
  if p_body ? 'clipboard_click' and (jsonb_typeof(p_body->'clipboard_click') <> 'string'
     or p_body->>'clipboard_click' !~ '^[A-Za-z0-9_-]{16,40}$') then
    return 'invalid_clipboard_click';
  end if;
  return null;
end $$;

-- The app's key, checked exactly as analytics_ingest checks it: an unknown or revoked key is
-- refused (28000), a live client key from a website the project does not allow too (42501).
create function kma_internal.attribution_app_key(p jsonb) returns public.analytics_api_keys
language plpgsql volatile set search_path = '' as $$
declare
  v_key public.analytics_api_keys;
  v_origins text[];
begin
  if coalesce(p->>'key_hash', '') ~ '^[0-9A-Fa-f]{64}$' then
    select * into v_key from public.analytics_api_keys
    where token_hash = decode(p->>'key_hash', 'hex') and revoked_at is null;
  end if;
  if v_key.id is null then
    raise exception 'invalid_key' using errcode = '28000';
  end if;
  select allowed_origins into v_origins from public.analytics_projects where id = v_key.project_id;
  if v_key.kind = 'client' and v_key.environment = 'production' and cardinality(v_origins) > 0 and p->>'origin' is not null
     and not (p->>'origin' = any(v_origins)) then
    raise exception 'origin_not_allowed' using errcode = '42501';
  end if;
  update public.analytics_api_keys set last_used_at = clock_timestamp()
  where id = v_key.id and (last_used_at is null or last_used_at < clock_timestamp() - interval '1 minute');
  return v_key;
end $$;

-- Refuses a body that breaks the contract (22023, the field in DETAIL) and returns the
-- install or open time, corrected by the clock skew the edge function measured. Apps send
-- times from the last 7 days, servers from the last 400, as for events.
create function kma_internal.attribution_app_time(p jsonb, p_kind text, k public.analytics_api_keys) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_problem text := kma_internal.attribution_body_problem(p->'body', p_kind);
  v_at timestamptz;
begin
  if v_problem is not null then
    raise exception '%', case v_problem
      when 'invalid_body' then 'The body must be a JSON object'
      when 'unknown_field' then 'The body has a field the attribution contract does not list'
      else format('%s is missing or malformed', substr(v_problem, 9)) end
      using errcode = '22023', detail = v_problem;
  end if;
  v_at := (p->'body'->>(case p_kind when 'install' then 'installed_at' else 'opened_at' end))::timestamptz
    + make_interval(secs => coalesce((p->>'clock_skew_ms')::numeric, 0) / 1000);
  if v_at > clock_timestamp() + interval '5 minutes'
     or v_at < clock_timestamp() - (case when k.kind = 'server' then interval '400 days' else interval '7 days' end) then
    raise exception 'The % time is too far in the past or the future', p_kind using errcode = '22023', detail = 'time_out_of_range';
  end if;
  return v_at;
end $$;

-- Records a link opened inside the app as a click, the way the link service records one:
-- the link's source with the address's own (src, cmp, chn, adset, ad), sub1 to sub5, dl, the
-- ad platforms' click IDs and a creator's click (kma_click). The destination is the app.
create function kma_internal.attribution_app_click(
  l public.attribution_links, p_query jsonb, p_platform text, p_at timestamptz, p_ip_hash text, p_user_agent text
) returns public.attribution_clicks language plpgsql volatile set search_path = '' as $$
declare
  c public.attribution_clicks;
  v_params jsonb := '{}';
  v_ids jsonb := '{}';
  v_value text;
  k text;
begin
  foreach k in array array['sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'dl', 'kma_aid', 'kma_from'] loop
    v_value := left(btrim(p_query->>k), 500);
    if v_value <> '' then
      v_params := v_params || jsonb_build_object(case k when 'kma_aid' then 'web_id' when 'kma_from' then 'from' else k end, v_value);
    end if;
  end loop;
  if p_query->>'kma_click' ~ '^[0-9a-f]{48}$' then
    v_params := v_params || jsonb_build_object('creator_click', p_query->>'kma_click');
  end if;
  foreach k in array array['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'] loop
    v_value := btrim(p_query->>k);
    if length(v_value) between 1 and 300 then
      v_ids := v_ids || jsonb_build_object(k, v_value);
    end if;
  end loop;
  insert into public.attribution_clicks(id, project_id, link_id, clicked_at, platform, in_app, destination,
    source, campaign, channel, adset, ad, params, click_ids, ip_hash, user_agent)
  values (
    -- 16 random bytes, base64url without padding, like the link service's click IDs.
    translate(encode(extensions.gen_random_bytes(16), 'base64'), '+/=', '-_'),
    l.project_id, l.id, p_at, p_platform, null, 'app',
    coalesce(case when lower(btrim(p_query->>'src')) ~ '^[a-z0-9][a-z0-9_.-]{0,59}$' then lower(btrim(p_query->>'src')) end, l.source),
    coalesce(case when length(btrim(p_query->>'cmp')) between 1 and 200 then btrim(p_query->>'cmp') end, l.campaign),
    coalesce(case when length(btrim(p_query->>'chn')) between 1 and 100 then btrim(p_query->>'chn') end, l.channel),
    coalesce(case when length(btrim(p_query->>'adset')) between 1 and 200 then btrim(p_query->>'adset') end, l.adset),
    coalesce(case when length(btrim(p_query->>'ad')) between 1 and 200 then btrim(p_query->>'ad') end, l.ad),
    v_params, v_ids, p_ip_hash, p_user_agent)
  returning * into c;
  return c;
end $$;

-- The deep link a click leads to: its link's, with the click's dl as the value when it has
-- one. Null when the link has none.
create function kma_internal.attribution_click_deep_link(c public.attribution_clicks, p_deferred boolean) returns jsonb
language sql stable set search_path = '' as $$
  select case when coalesce(c.params->>'dl', l.deep_link_value) is not null or l.deep_link_params <> '{}'::jsonb then
    jsonb_build_object('value', coalesce(c.params->>'dl', l.deep_link_value), 'params', l.deep_link_params,
      'deferred', p_deferred) end
  from public.attribution_links l where l.id = c.link_id
$$;

-- The latest click of the project that opened a live website visit of the person, inside the
-- click window before p_at (step 6, login).
create function kma_internal.attribution_login_click(p_project uuid, p_person uuid, p_at timestamptz, p_lookback interval)
returns public.attribution_clicks language sql stable set search_path = '' as $$
  select c.* from public.analytics_sessions s
  join public.attribution_clicks c on c.id = s.link_click and c.project_id = s.project_id
  where s.person_id = p_person and s.project_id = p_project and s.environment = 'production' and s.platform = 'web'
    and s.link_click is not null and c.clicked_at > p_at - p_lookback and c.clicked_at <= p_at
  order by c.clicked_at desc limit 1
$$;

-- What the app is told about its install: the contract's answer.
create function kma_internal.attribution_answer(i public.attribution_installs, p_deep_link jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'matched', i.method <> 'organic' and i.verdict <> 'rejected' and i.source is not null,
    'method', i.method, 'source', i.source, 'campaign', i.campaign, 'channel', i.channel, 'adset', i.adset, 'ad', i.ad,
    'reinstall', i.method = 'reinstall', 'deep_link', p_deep_link)
$$;

-- The answer when nothing is stored: attribution is off, the address is not a link of the
-- project, or the merchant marked the person or their network as a bot.
create function kma_internal.attribution_unmatched(p_method text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('matched', false, 'method', p_method, 'deep_link', null)
$$;

-- Sets where the person was first acquired, once.
create function kma_internal.attribution_acquired(i public.attribution_installs) returns void
language sql volatile set search_path = '' as $$
  update public.analytics_people set acquisition_source = i.source, acquisition_campaign = i.campaign,
    acquisition_method = i.method, installed_at = i.installed_at
  where id = i.person_id and installed_at is null
$$;

-- An anonymous person folded into the signed-in user (analytics_resolve_person) brings their
-- install and re-engagements. A person keeps one install: the earliest of the two.
create function kma_internal.attribution_fold_person(p_from uuid, p_into uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare
  f public.attribution_installs;
  t public.attribution_installs;
begin
  update public.attribution_engagements set person_id = p_into where person_id = p_from;
  select * into f from public.attribution_installs where person_id = p_from;
  if f.id is null then
    return;
  end if;
  select * into t from public.attribution_installs where person_id = p_into;
  if t.id is not null and t.installed_at <= f.installed_at then
    return;
  end if;
  delete from public.attribution_installs where id = t.id;
  update public.attribution_installs set person_id = p_into where id = f.id returning * into f;
  update public.analytics_people set acquisition_source = f.source, acquisition_campaign = f.campaign,
    acquisition_method = f.method, installed_at = f.installed_at
  where id = p_into;
end $$;

-- People: the definition from 20261030160000_merchant_places.sql, keeping the install of a
-- device whose anonymous person is folded into the signed-in user.
create or replace function kma_internal.analytics_resolve_person(
  p_project uuid, p_environment text, p_user_id text, p_anonymous_id text, p_at timestamptz,
  p_context jsonb, p_geo jsonb, p_traits jsonb
) returns uuid language plpgsql volatile set search_path = '' as $$
declare
  v_user_person uuid;
  v_anon_person uuid;
  v_person uuid;
  v_distinct text := coalesce(p_user_id, p_anonymous_id);
begin
  if v_distinct is null then
    raise exception 'Each event needs a user ID or an anonymous ID' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('analytics-person:' || p_project::text || ':' || v_distinct, 0));
  if p_user_id is not null then
    select id into v_user_person from public.analytics_people where project_id = p_project and distinct_id = p_user_id;
    if p_anonymous_id is not null then
      select id into v_anon_person from public.analytics_people
      where project_id = p_project and distinct_id = p_anonymous_id and user_id is null;
    end if;
    if v_user_person is null and v_anon_person is not null then
      -- First identify on this device: the anonymous person becomes the user.
      update public.analytics_people
      set distinct_id = p_user_id, user_id = p_user_id,
          anonymous_ids = (select array_agg(distinct a) from unnest(anonymous_ids || p_anonymous_id) a)
      where id = v_anon_person;
      v_user_person := v_anon_person;
    elsif v_user_person is not null and v_anon_person is not null and v_anon_person <> v_user_person then
      -- The user was already known from another device: fold this device's history in.
      update public.analytics_sessions set person_id = v_user_person where person_id = v_anon_person;
      update public.analytics_events set person_id = v_user_person where person_id = v_anon_person;
      delete from public.analytics_bot_overrides o
      where o.person_id = v_anon_person
        and exists (select 1 from public.analytics_bot_overrides x where x.person_id = v_user_person);
      update public.analytics_bot_overrides set person_id = v_user_person where person_id = v_anon_person;
      update public.analytics_people u
      set first_seen = least(u.first_seen, a.first_seen),
          last_seen = greatest(u.last_seen, a.last_seen),
          sessions_count = u.sessions_count + a.sessions_count,
          events_count = u.events_count + a.events_count,
          anonymous_ids = (select array_agg(distinct x) from unnest(u.anonymous_ids || a.anonymous_ids || p_anonymous_id) x),
          traits = a.traits || u.traits,
          environment = case when 'production' in (u.environment, a.environment) then 'production' else 'development' end,
          initial_referrer = case when a.first_seen < u.first_seen then a.initial_referrer else u.initial_referrer end,
          initial_utm_source = case when a.first_seen < u.first_seen then a.initial_utm_source else u.initial_utm_source end,
          initial_utm_medium = case when a.first_seen < u.first_seen then a.initial_utm_medium else u.initial_utm_medium end,
          initial_utm_campaign = case when a.first_seen < u.first_seen then a.initial_utm_campaign else u.initial_utm_campaign end,
          initial_landing = case when a.first_seen < u.first_seen then a.initial_landing else u.initial_landing end
      from public.analytics_people a
      where u.id = v_user_person and a.id = v_anon_person;
      perform kma_internal.attribution_fold_person(v_anon_person, v_user_person);
      delete from public.analytics_people where id = v_anon_person;
    end if;
    v_person := v_user_person;
  else
    -- An anonymous ID that was later identified still belongs to that user.
    select id into v_person from public.analytics_people
    where project_id = p_project and (distinct_id = p_anonymous_id or anonymous_ids @> array[p_anonymous_id])
    order by (distinct_id = p_anonymous_id) desc limit 1;
  end if;

  if v_person is null then
    insert into public.analytics_people(
      project_id, distinct_id, user_id, anonymous_ids, environment, first_seen, last_seen,
      initial_referrer, initial_utm_source, initial_utm_medium, initial_utm_campaign, initial_landing
    ) values (
      p_project, v_distinct, p_user_id,
      case when p_anonymous_id is not null then array[p_anonymous_id] else '{}' end,
      p_environment, p_at, p_at,
      kma_internal.analytics_text(p_context->'referrer', 500),
      kma_internal.analytics_text(p_context#>'{utm,source}'),
      kma_internal.analytics_text(p_context#>'{utm,medium}'),
      kma_internal.analytics_text(p_context#>'{utm,campaign}'),
      kma_internal.analytics_text(p_context->'page_path', 500)
    )
    on conflict (project_id, distinct_id) do update set last_seen = public.analytics_people.last_seen
    returning id into v_person;
  end if;

  update public.analytics_people p set
    last_seen = greatest(p.last_seen, p_at),
    first_seen = least(p.first_seen, p_at),
    environment = case when p_environment = 'production' then 'production' else p.environment end,
    anonymous_ids = case
      when p_anonymous_id is null or p_anonymous_id = any(p.anonymous_ids) or cardinality(p.anonymous_ids) >= 20 then p.anonymous_ids
      else p.anonymous_ids || p_anonymous_id end,
    traits = case when p_traits is not null and jsonb_typeof(p_traits) = 'object' then p.traits || p_traits else p.traits end
  where p.id = v_person;

  -- Latest known device and place, only when this is the newest thing we heard.
  if p_context is not null then
    update public.analytics_people p set
      platform = coalesce(kma_internal.analytics_text(p_context->'platform', 20), p.platform),
      -- A place is one thing: a new city brings its own region, and a new country without
      -- a city (say, from the time zone) drops the old country's region and city.
      country = coalesce(p_geo->>'country', p.country),
      region = case when p_geo->>'country' is null or (p_geo->>'city' is null and p_geo->>'country' = p.country)
        then p.region else p_geo->>'region' end,
      city = case when p_geo->>'country' is null or (p_geo->>'city' is null and p_geo->>'country' = p.country)
        then p.city else p_geo->>'city' end,
      timezone = coalesce(kma_internal.analytics_text(p_context->'timezone', 64), p.timezone),
      language = coalesce(kma_internal.analytics_text(p_context->'language', 35), p.language),
      device_type = coalesce(kma_internal.analytics_text(p_context->'device_type', 20), p.device_type),
      device_model = coalesce(kma_internal.analytics_text(p_context->'device_model', 80), p.device_model),
      os_name = coalesce(kma_internal.analytics_text(p_context->'os_name', 40), p.os_name),
      os_version = coalesce(kma_internal.analytics_text(p_context->'os_version', 40), p.os_version),
      browser = coalesce(kma_internal.analytics_text(p_context->'browser', 40), p.browser),
      browser_version = coalesce(kma_internal.analytics_text(p_context->'browser_version', 40), p.browser_version),
      app_version = coalesce(kma_internal.analytics_text(p_context->'app_version', 40), p.app_version),
      sdk = coalesce(kma_internal.analytics_text(p_context->'sdk', 60), p.sdk),
      screen_width = coalesce(kma_internal.analytics_int(p_context->'screen_width'), p.screen_width),
      screen_height = coalesce(kma_internal.analytics_int(p_context->'screen_height'), p.screen_height)
    where p.id = v_person and p.last_seen <= p_at;
  end if;
  return v_person;
end $$;

-- The app's calls (service role only) ----------------------------------------------------------

-- POST /v1/attribution/install, once on the app's first launch.
-- Input: the analytics_ingest envelope {key_hash, origin, body, geo, ip_sha, user_agent,
-- clock_skew_ms} with the contract's install body (apple_ads in place of apple_ads_token).
-- Output: {matched, method, source, campaign, channel, adset, ad, reinstall, deep_link}, or
-- {matched: false, method: "off", deep_link: null} while attribution is off.
create function public.attribution_install(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key public.analytics_api_keys := kma_internal.attribution_app_key(p);
  v_at timestamptz := kma_internal.attribution_app_time(p, 'install', v_key);
  v_body jsonb := jsonb_strip_nulls(p->'body');
  s public.attribution_settings;
  v_geo jsonb := coalesce(p->'geo', '{}'::jsonb);
  v_user_agent text := left(p->>'user_agent', 400);
  v_ip_hash text;
  v_person uuid;
  v_lookback interval;
  v_url jsonb;
  v_query jsonb;
  v_deep jsonb;
  v_open jsonb;
  i public.attribution_installs;
  n public.attribution_installs;
  o public.attribution_installs;
  l public.attribution_links;
  c public.attribution_clicks;
begin
  select * into s from public.attribution_settings where project_id = v_key.project_id;
  if s.project_id is null or not s.enabled then
    return kma_internal.attribution_unmatched('off');
  end if;
  -- A server key calls from the merchant's own server: its network says nothing about the phone.
  if v_key.kind = 'server' then
    v_geo := '{}';
    v_user_agent := null;
    p := p - 'ip_sha';
  end if;
  if p->>'ip_sha' is not null then
    v_ip_hash := encode(extensions.digest(v_key.project_id::text || ':' || (p->>'ip_sha'), 'sha256'), 'hex');
    if exists (select 1 from public.analytics_bot_overrides
        where project_id = v_key.project_id and verdict = 'bot' and ip_hash = v_ip_hash) then
      return kma_internal.attribution_unmatched('organic');
    end if;
  end if;
  v_person := kma_internal.analytics_resolve_person(v_key.project_id, v_key.environment,
    v_body->>'user_id', v_body->>'anonymous_id', v_at,
    jsonb_strip_nulls(jsonb_build_object('platform', v_body->'platform', 'app_version', v_body->'app_version', 'sdk', v_body->'sdk')),
    v_geo, null);
  if exists (select 1 from public.analytics_bot_overrides
      where project_id = v_key.project_id and verdict = 'bot' and person_id = v_person) then
    return kma_internal.attribution_unmatched('organic');
  end if;

  -- 0. Asked before: the same answer. A deferred deep link goes out with the first answer only.
  select * into i from public.attribution_installs where project_id = v_key.project_id and person_id = v_person;
  if i.id is not null then
    if i.deep_link_delivered_at is null and (i.deep_link_value is not null or i.deep_link_params <> '{}'::jsonb) then
      v_deep := jsonb_build_object('value', i.deep_link_value, 'params', i.deep_link_params, 'deferred', true);
      update public.attribution_installs set deep_link_delivered_at = now() where id = i.id;
    end if;
    return kma_internal.attribution_answer(i, v_deep);
  end if;

  n.project_id := v_key.project_id;
  n.person_id := v_person;
  n.environment := v_key.environment;
  n.platform := v_body->>'platform';
  n.installed_at := v_at;
  n.session_key := v_body->>'session_id';
  n.app_version := v_body->>'app_version';
  -- The SDK's hash of the phone's vendor ID, hashed again with the project.
  n.device_hash := case when v_body ? 'device_key'
    then encode(extensions.digest(v_key.project_id::text || ':' || (v_body->>'device_key'), 'sha256'), 'hex') end;
  n.exact := false;
  n.verdict := 'counted';
  n.deep_link_params := '{}';
  v_lookback := make_interval(days => s.click_lookback_days);
  if v_body ? 'link_url' then
    v_url := kma_internal.attribution_parse_url(v_body->>'link_url');
    l := kma_internal.attribution_find_link(v_key.project_id, v_url);
  end if;

  -- 1. The same phone installed the app inside the reinstall window: the first install's
  -- source again. Development keys skip this, so a merchant can test on one phone again.
  if n.device_hash is not null and n.environment = 'production' then
    select * into o from public.attribution_installs x
    where x.project_id = n.project_id and x.device_hash = n.device_hash and x.environment = 'production'
      and x.method <> 'reinstall' and x.installed_at > v_at - make_interval(days => s.reattribution_days)
    order by x.installed_at desc limit 1;
    if o.id is not null then
      n.method := 'reinstall';
      n.reinstall_of := o.id;
      n.exact := o.exact;
      n.click_id := o.click_id;
      n.link_id := o.link_id;
      n.source := o.source;
      n.campaign := o.campaign;
      n.channel := o.channel;
      n.adset := o.adset;
      n.ad := o.ad;
      n.apple_ads := o.apple_ads;
      n.creator_click := o.creator_click;
      n.verdict := o.verdict;
      n.fraud_reason := o.fraud_reason;
      -- A link that opened the reinstalled app still counts as a click and opens its screen.
      if l.id is not null then
        c := kma_internal.attribution_app_click(l, v_url->'query', n.platform, v_at, v_ip_hash, v_user_agent);
        v_open := kma_internal.attribution_click_deep_link(c, false);
      end if;
    end if;
  end if;

  -- 2. A link of the project opened the app.
  if n.method is null and l.id is not null then
    c := kma_internal.attribution_app_click(l, v_url->'query', n.platform, v_at, v_ip_hash, v_user_agent);
    n.method := 'link_open';
  end if;

  -- 3. Google Play's install referrer names a click. Play may hand it back encoded once more.
  if n.method is null and v_body ? 'referrer' then
    v_query := kma_internal.attribution_query(case when v_body->>'referrer' !~ '=' and v_body->>'referrer' ~* '%3D'
      then kma_internal.attribution_url_decode(v_body->>'referrer') else v_body->>'referrer' end);
    if v_query->>'kma_lc' ~ '^[A-Za-z0-9_-]{16,40}$' then
      select * into c from public.attribution_clicks x
      where x.id = v_query->>'kma_lc' and x.project_id = n.project_id
        and x.clicked_at > v_at - v_lookback and x.clicked_at <= v_at + interval '5 minutes';
      if c.id is not null then
        n.method := 'install_referrer';
        -- The click came after the install began (whole seconds): a click injected by another
        -- app. The install is kept, but credits nobody. Play answers 0 for a time it does not
        -- know, so a time on 1970-01-01 is unknown, never a click after the install.
        if (v_body->>'install_begin_ts')::bigint > 86400 and c.clicked_at >= to_timestamp((v_body->>'install_begin_ts')::bigint)
            + make_interval(secs => coalesce((p->>'clock_skew_ms')::numeric, 0) / 1000) + interval '1 second' then
          n.verdict := 'rejected';
          n.fraud_reason := 'click_after_install';
        end if;
      end if;
    end if;
  end if;

  -- 4. Apple Ads: Apple's campaign, ad group, keyword and ad IDs, never a person.
  if n.method is null and v_body#>>'{apple_ads,attribution}' = 'true' then
    n.method := 'apple_ads';
    n.exact := true;
    n.source := 'apple_ads';
    n.campaign := kma_internal.attribution_apple_id(v_body->'apple_ads'->'campaignId');
    n.adset := kma_internal.attribution_apple_id(v_body->'apple_ads'->'adGroupId');
    n.ad := kma_internal.attribution_apple_id(v_body->'apple_ads'->'adId');
    n.apple_ads := jsonb_strip_nulls(jsonb_build_object(
      'orgId', kma_internal.attribution_apple_id(v_body->'apple_ads'->'orgId')::numeric,
      'campaignId', n.campaign::numeric,
      'adGroupId', n.adset::numeric,
      'keywordId', kma_internal.attribution_apple_id(v_body->'apple_ads'->'keywordId')::numeric,
      'adId', n.ad::numeric,
      'clickDate', kma_internal.analytics_text(v_body->'apple_ads'->'clickDate', 40)));
  end if;

  -- 5. The click ID the landing page put on the clipboard.
  if n.method is null and v_body ? 'clipboard_click' then
    select * into c from public.attribution_clicks x
    where x.id = v_body->>'clipboard_click' and x.project_id = n.project_id
      and x.clicked_at > v_at - v_lookback and x.clicked_at <= v_at + interval '5 minutes';
    if c.id is not null then
      n.method := 'clipboard';
    end if;
  end if;

  -- 6. The signed-in person came to the website through a link of the project.
  if n.method is null and exists (select 1 from public.analytics_people where id = v_person and user_id is not null) then
    c := kma_internal.attribution_login_click(n.project_id, v_person, v_at, v_lookback);
    if c.id is not null then
      n.method := 'login';
    end if;
  end if;

  if n.method is null then
    n.method := 'organic';
  elsif n.method in ('link_open', 'install_referrer', 'clipboard', 'login') then
    n.exact := true;
    n.click_id := c.id;
    n.link_id := c.link_id;
    if n.verdict <> 'rejected' then
      n.source := c.source;
      n.campaign := c.campaign;
      n.channel := c.channel;
      n.adset := c.adset;
      n.ad := c.ad;
      n.creator_click := case when c.params->>'creator_click' ~ '^[0-9a-f]{48}$' then c.params->>'creator_click' end;
      -- A click the link service saw less than 10 seconds before the app opened.
      if n.method <> 'link_open' and c.clicked_at > v_at - interval '10 seconds' then
        n.verdict := 'flagged';
        n.fraud_reason := 'too_fast';
      end if;
      v_deep := kma_internal.attribution_click_deep_link(c, true);
      n.deep_link_value := v_deep->>'value';
      n.deep_link_params := coalesce(v_deep->'params', '{}'::jsonb);
      n.deep_link_delivered_at := case when v_deep is not null then now() end;
    end if;
  end if;

  insert into public.attribution_installs(project_id, person_id, environment, platform, installed_at, session_key,
    app_version, device_hash, method, exact, click_id, link_id, source, campaign, channel, adset, ad, apple_ads,
    reinstall_of, verdict, fraud_reason, creator_click, deep_link_value, deep_link_params, deep_link_delivered_at)
  values (n.project_id, n.person_id, n.environment, n.platform, n.installed_at, n.session_key,
    n.app_version, n.device_hash, n.method, n.exact, n.click_id, n.link_id, n.source, n.campaign, n.channel, n.adset, n.ad,
    n.apple_ads, n.reinstall_of, n.verdict, n.fraud_reason, n.creator_click, n.deep_link_value, n.deep_link_params,
    n.deep_link_delivered_at)
  on conflict (project_id, person_id) do nothing
  returning * into i;
  if i.id is null then
    -- Another call for the same person stored its install first.
    select * into i from public.attribution_installs where project_id = v_key.project_id and person_id = v_person;
    return kma_internal.attribution_answer(i, null);
  end if;
  perform kma_internal.attribution_acquired(i);
  perform kma_internal.attribution_install_matched(i.id);
  return kma_internal.attribution_answer(i, coalesce(v_open, v_deep));
end $$;

-- POST /v1/attribution/open, each time a Universal Link or App Link opens the app after the
-- first launch. Same envelope; the contract's open body.
-- Output: as for an install, with method link_open and the link's deep link (deferred false);
-- {matched: false, method: "organic", deep_link: null} for an address that is not one of the
-- project's links (nothing is stored); off while attribution is off.
create function public.attribution_open(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key public.analytics_api_keys := kma_internal.attribution_app_key(p);
  v_at timestamptz := kma_internal.attribution_app_time(p, 'open', v_key);
  v_body jsonb := jsonb_strip_nulls(p->'body');
  s public.attribution_settings;
  v_geo jsonb := coalesce(p->'geo', '{}'::jsonb);
  v_user_agent text := left(p->>'user_agent', 400);
  v_ip_hash text;
  v_person uuid;
  v_url jsonb;
  v_deep jsonb;
  i public.attribution_installs;
  l public.attribution_links;
  c public.attribution_clicks;
begin
  select * into s from public.attribution_settings where project_id = v_key.project_id;
  if s.project_id is null or not s.enabled then
    return kma_internal.attribution_unmatched('off');
  end if;
  v_url := kma_internal.attribution_parse_url(v_body->>'url');
  l := kma_internal.attribution_find_link(v_key.project_id, v_url);
  if l.id is null then
    return kma_internal.attribution_unmatched('organic');
  end if;
  if v_key.kind = 'server' then
    v_geo := '{}';
    v_user_agent := null;
    p := p - 'ip_sha';
  end if;
  if p->>'ip_sha' is not null then
    v_ip_hash := encode(extensions.digest(v_key.project_id::text || ':' || (p->>'ip_sha'), 'sha256'), 'hex');
    if exists (select 1 from public.analytics_bot_overrides
        where project_id = v_key.project_id and verdict = 'bot' and ip_hash = v_ip_hash) then
      return kma_internal.attribution_unmatched('organic');
    end if;
  end if;
  v_person := kma_internal.analytics_resolve_person(v_key.project_id, v_key.environment,
    v_body->>'user_id', v_body->>'anonymous_id', v_at,
    jsonb_strip_nulls(jsonb_build_object('platform', v_body->'platform', 'app_version', v_body->'app_version', 'sdk', v_body->'sdk')),
    v_geo, null);
  if exists (select 1 from public.analytics_bot_overrides
      where project_id = v_key.project_id and verdict = 'bot' and person_id = v_person) then
    return kma_internal.attribution_unmatched('organic');
  end if;

  c := kma_internal.attribution_app_click(l, v_url->'query', v_body->>'platform', v_at, v_ip_hash, v_user_agent);
  v_deep := kma_internal.attribution_click_deep_link(c, false);
  select * into i from public.attribution_installs where project_id = v_key.project_id and person_id = v_person;
  if i.id is null then
    -- No install yet: the app had no SDK when it was installed, or its install call was
    -- lost. The link that opened it is where the person came from.
    insert into public.attribution_installs(project_id, person_id, environment, platform, installed_at, session_key,
      app_version, device_hash, method, exact, click_id, link_id, source, campaign, channel, adset, ad, creator_click,
      deep_link_value, deep_link_params, deep_link_delivered_at)
    values (v_key.project_id, v_person, v_key.environment, v_body->>'platform', v_at, v_body->>'session_id',
      v_body->>'app_version',
      case when v_body ? 'device_key'
        then encode(extensions.digest(v_key.project_id::text || ':' || (v_body->>'device_key'), 'sha256'), 'hex') end,
      'link_open', true, c.id, c.link_id, c.source, c.campaign, c.channel, c.adset, c.ad,
      case when c.params->>'creator_click' ~ '^[0-9a-f]{48}$' then c.params->>'creator_click' end,
      v_deep->>'value', coalesce(v_deep->'params', '{}'::jsonb), case when v_deep is not null then now() end)
    on conflict (project_id, person_id) do nothing
    returning * into i;
    if i.id is not null then
      perform kma_internal.attribution_acquired(i);
      perform kma_internal.attribution_install_matched(i.id);
    end if;
  elsif i.installed_at < v_at - interval '1 minute' then
    -- Someone who already has the app came back through a link: a re-engagement. Where
    -- they were first acquired does not change.
    insert into public.attribution_engagements(project_id, person_id, click_id, link_id, opened_at, ends_at,
      source, campaign, channel, creator_click)
    values (v_key.project_id, v_person, c.id, c.link_id, v_at, v_at + make_interval(days => s.reengagement_days),
      c.source, c.campaign, c.channel,
      case when c.params->>'creator_click' ~ '^[0-9a-f]{48}$' then c.params->>'creator_click' end);
  end if;
  return jsonb_build_object('matched', true, 'method', 'link_open', 'source', c.source, 'campaign', c.campaign,
    'channel', c.channel, 'adset', c.adset, 'ad', c.ad, 'reinstall', false, 'deep_link', v_deep);
end $$;

-- Run every minute by pg_cron (job kma-attribution), as the service role or the database
-- owner. Organic installs of the last 72 hours whose person has since signed in are matched
-- again to the person's website visits (step 6, login). Safe to run again; a second call
-- while one is running returns at once.
-- Input: {"limit": 1..1000} (default 500), the most installs it upgrades in one run.
-- Output: {"checked": organic installs of signed-in people it looked at, "upgraded": n}.
create function public.attribution_tick(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_input jsonb := coalesce(p, '{}'::jsonb);
  v_limit integer;
  v_checked integer;
  v_upgraded integer := 0;
  r record;
  c public.attribution_clicks;
  i public.attribution_installs;
begin
  if jsonb_typeof(v_input) <> 'object'
     or exists (select 1 from jsonb_object_keys(v_input) k where k <> 'limit')
     or (v_input ? 'limit' and (jsonb_typeof(v_input->'limit') <> 'number' or v_input->>'limit' !~ '^[0-9]{1,4}$'
       or (v_input->>'limit')::integer not between 1 and 1000)) then
    raise exception 'The tick takes a limit from 1 to 1000' using errcode = '22023', detail = 'invalid_input';
  end if;
  v_limit := coalesce((v_input->>'limit')::integer, 500);
  if not pg_try_advisory_xact_lock(hashtextextended('kma-attribution-tick', 0)) then
    return jsonb_build_object('checked', 0, 'upgraded', 0);
  end if;
  select count(*) into v_checked
  from public.attribution_installs x
  join public.attribution_settings s on s.project_id = x.project_id and s.enabled
  join public.analytics_people pe on pe.id = x.person_id and pe.user_id is not null
  where x.method = 'organic' and x.installed_at > now() - interval '72 hours';
  for r in
    select x.id, m.c
    from public.attribution_installs x
    join public.attribution_settings s on s.project_id = x.project_id and s.enabled
    join public.analytics_people pe on pe.id = x.person_id and pe.user_id is not null
    cross join lateral (select kma_internal.attribution_login_click(x.project_id, x.person_id, x.installed_at,
      make_interval(days => s.click_lookback_days)) c) m
    where x.method = 'organic' and x.installed_at > now() - interval '72 hours' and (m.c).id is not null
    order by x.installed_at
    limit v_limit
    for update of x skip locked
  loop
    c := r.c;
    update public.attribution_installs x set method = 'login', exact = true, click_id = c.id, link_id = c.link_id,
      source = c.source, campaign = c.campaign, channel = c.channel, adset = c.adset, ad = c.ad,
      creator_click = case when c.params->>'creator_click' ~ '^[0-9a-f]{48}$' then c.params->>'creator_click' end,
      verdict = case when c.clicked_at > x.installed_at - interval '10 seconds' then 'flagged' else 'counted' end,
      fraud_reason = case when c.clicked_at > x.installed_at - interval '10 seconds' then 'too_fast' end,
      matched_at = now()
    where x.id = r.id
    returning * into i;
    update public.analytics_people set acquisition_source = i.source, acquisition_campaign = i.campaign,
      acquisition_method = i.method, installed_at = coalesce(installed_at, i.installed_at)
    where id = i.person_id and coalesce(acquisition_method, 'organic') = 'organic';
    perform kma_internal.attribution_install_matched(i.id);
    v_upgraded := v_upgraded + 1;
  end loop;
  return jsonb_build_object('checked', v_checked, 'upgraded', v_upgraded);
end $$;

-- Settings: clipboard handoff ------------------------------------------------------------------

-- What the attribution screens show: the definition from 20261103120000 with clipboard
-- handoff in the settings, the SDK step done once an install arrived, and the installs.
create or replace function kma_internal.attribution_view(p_project uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  p public.analytics_projects;
  s public.attribution_settings;
  v_root text := kma_internal.attribution_link_root();
  v_domains jsonb;
  v_live boolean;
  v_installs bigint;
  v_last_install timestamptz;
begin
  select * into p from public.analytics_projects where id = p_project;
  select * into s from public.attribution_settings where project_id = p_project;
  select coalesce(jsonb_agg(kma_internal.attribution_domain_view(d) order by d.kind = 'custom', d.created_at), '[]'::jsonb),
    coalesce(bool_or(d.kind = 'kma' or d.verified_at is not null), false)
  into v_domains, v_live
  from public.attribution_domains d where d.project_id = p_project;
  -- Every install, from live and development keys: the SDK works once one arrived.
  select count(*), max(i.installed_at) into v_installs, v_last_install
  from public.attribution_installs i where i.project_id = p_project;
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
      'ios_clipboard_handoff', s.ios_clipboard_handoff,
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
      'sdk', v_installs > 0,
      'conversions', coalesce(cardinality(s.conversion_events) > 0, false),
      'partners', false, 'skan', false
    ),
    'installs', jsonb_build_object('total', v_installs, 'last_at', v_last_install)
  );
end $$;

-- The definition from 20261103100000 with ios_clipboard_handoff: the iPhone landing page
-- whose button copies the click ID before it opens the App Store.
create or replace function public.attribution_update(p_project uuid, p_patch jsonb) returns jsonb
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
      'reattribution_days', 'currency', 'ios_clipboard_handoff'
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
  if p_patch ? 'ios_clipboard_handoff' then
    if jsonb_typeof(p_patch->'ios_clipboard_handoff') is distinct from 'boolean' then
      raise exception 'Turn clipboard handoff on or off' using errcode = '22023';
    end if;
    s.ios_clipboard_handoff := (p_patch->>'ios_clipboard_handoff')::boolean;
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
    ios_clipboard_handoff = s.ios_clipboard_handoff,
    updated_at = now(), updated_by = auth.uid()
  where project_id = p_project;
  return kma_internal.attribution_view(p_project);
end $$;

-- What a link domain should answer: the definition from 20261103100000 with
-- ios_clipboard_handoff, which the link service reads to show the iPhone landing page.
create or replace function public.attribution_link_host(p_host text) returns jsonb
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
    'web_url', s.web_url,
    'ios_clipboard_handoff', coalesce(s.ios_clipboard_handoff, false)
  );
end $$;

-- Reports ---------------------------------------------------------------------------------------
-- Installs count when they are live, not rejected and not a reinstall of the same phone.

-- The project's links, with clicks, visits, conversions, installs and re-engagements in the
-- range: the definition from 20261103120000 with the last two.
create or replace function public.attribution_links(p_project uuid, p_range text) returns jsonb
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
      ), installs as (
        select i.link_id, count(*) n from public.attribution_installs i
        where i.project_id = p_project and i.environment = 'production' and i.link_id is not null
          and i.verdict <> 'rejected' and i.method <> 'reinstall'
          and i.installed_at >= w.from_at and i.installed_at < w.to_at
        group by 1
      ), reengagements as (
        select e.link_id, count(*) n from public.attribution_engagements e
        join public.analytics_people pe on pe.id = e.person_id and pe.environment = 'production'
        where e.project_id = p_project and e.link_id is not null and e.opened_at >= w.from_at and e.opened_at < w.to_at
        group by 1
      )
      select jsonb_agg(kma_internal.attribution_link_view(l, v_host) || jsonb_build_object(
          'clicks', coalesce(ck.n, 0), 'visits', coalesce(vs.n, 0), 'conversions', coalesce(cv.n, 0),
          'installs', coalesce(it.n, 0), 'reengagements', coalesce(re.n, 0))
        order by l.status = 'paused', l.created_at desc)
      from public.attribution_links l
      left join clicks ck on ck.link_id = l.id
      left join visits vs on vs.link_id = l.id
      left join conversions cv on cv.link_id = l.id
      left join installs it on it.link_id = l.id
      left join reengagements re on re.link_id = l.id
      where l.project_id = p_project
    ), '[]'::jsonb)
  );
end $$;

-- Where people came from in the range: the definition from 20261103120000 with each source's
-- (or campaign's) installs. Organic installs have no source, like direct visits.
create or replace function public.attribution_sources(p_project uuid, p_range text, p_model text default 'last', p_source text default null)
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
  ), installs as (
    select case when p_source is null then i.source else i.campaign end k, count(*) installs
    from public.attribution_installs i
    where i.project_id = p_project and i.environment = 'production' and i.verdict <> 'rejected' and i.method <> 'reinstall'
      and i.installed_at >= w.from_at and i.installed_at < w.to_at
      and (p_source is null or i.source = p_source)
    group by 1
  ), keys as (
    select k from clicks union select k from visits union select k from conversions union select k from installs
  ), grouped as (
    select k.k, coalesce(ck.clicks, 0) clicks, coalesce(vs.visits, 0) visits, coalesce(vs.people, 0) people,
      coalesce(cv.conversions, 0) conversions, coalesce(cv.converters, 0) converters, coalesce(it.installs, 0) installs
    from keys k
    left join clicks ck on ck.k is not distinct from k.k
    left join visits vs on vs.k is not distinct from k.k
    left join conversions cv on cv.k is not distinct from k.k
    left join installs it on it.k is not distinct from k.k
  )
  select coalesce(jsonb_agg(jsonb_build_object('key', r.k, 'clicks', r.clicks, 'visits', r.visits, 'people', r.people,
      'conversions', r.conversions, 'converters', r.converters, 'installs', r.installs)
      order by r.k is null, r.conversions desc, r.visits desc, r.clicks desc, r.installs desc, r.k), '[]'::jsonb),
    jsonb_build_object('clicks', coalesce(sum(r.clicks), 0), 'visits', coalesce(sum(r.visits), 0),
      'conversions', coalesce(sum(r.conversions), 0), 'installs', coalesce(sum(r.installs), 0))
  into v_rows, v_totals
  from (select * from grouped order by k is null, conversions desc, visits desc, clicks desc, installs desc, k limit 200) r;
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

-- "Test on your phone": what happened on one link in the last 30 minutes, from live and
-- development builds. The console asks every few seconds while the test is open.
create function public.attribution_test_device(p_project uuid, p_link uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  l public.attribution_links;
  v_since timestamptz := now() - interval '30 minutes';
  v_host text;
  i public.attribution_installs;
begin
  perform kma_internal.analytics_require_project(p_project);
  perform kma_internal.attribution_require_settings(p_project);
  select * into l from public.attribution_links where id = p_link and project_id = p_project;
  if l.id is null then
    raise exception 'Link not found' using errcode = 'P0002';
  end if;
  v_host := kma_internal.attribution_primary_host(p_project);
  select * into i from public.attribution_installs x
  where x.link_id = l.id and x.received_at >= v_since
  order by x.received_at desc limit 1;
  return jsonb_build_object(
    'link', jsonb_build_object('id', l.id, 'url', case when v_host is not null then 'https://' || v_host || '/' || l.path end),
    'click', (select jsonb_build_object('at', c.clicked_at, 'platform', c.platform)
      from public.attribution_clicks c where c.link_id = l.id and c.clicked_at >= v_since
      order by c.clicked_at desc limit 1),
    'install', case when i.id is not null then jsonb_build_object('at', i.installed_at, 'method', i.method,
      'platform', i.platform, 'exact', i.exact) end,
    'deep_link_delivered', i.deep_link_delivered_at is not null
  );
end $$;

-- A person, with where they were acquired: the definition from 20261030100000 with acquisition.
create or replace function public.analytics_person(p_project uuid, p_person uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_person public.analytics_people;
begin
  perform kma_internal.analytics_require_project(p_project);
  select * into v_person from public.analytics_people where id = p_person and project_id = p_project;
  if v_person.id is null then
    raise exception 'Person not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'person', kma_internal.analytics_person_view(v_person),
    'override', (select jsonb_build_object('id', o.id, 'verdict', o.verdict, 'note', o.note, 'created_at', o.created_at)
      from public.analytics_bot_overrides o where o.person_id = p_person),
    'stats', (select jsonb_build_object(
        'sessions', count(*), 'total_seconds', coalesce(round(sum(extract(epoch from (s.ended_at - s.started_at)))), 0),
        'avg_seconds', coalesce(round(avg(extract(epoch from (s.ended_at - s.started_at)))), 0),
        'replays', count(*) filter (where s.replay_chunks > 0),
        'countries', coalesce(jsonb_agg(distinct s.country) filter (where s.country is not null), '[]'::jsonb),
        'devices', coalesce(jsonb_agg(distinct coalesce(s.device_model, concat_ws(' ', s.browser, 'on', s.os_name))), '[]'::jsonb),
        'bot_sessions', count(*) filter (where cardinality(s.bot_reasons) > 0))
      from public.analytics_sessions s where s.person_id = p_person),
    'sessions', coalesce((select jsonb_agg(kma_internal.analytics_session_view(s) order by s.started_at desc)
      from (select * from public.analytics_sessions where person_id = p_person order by started_at desc limit 100) s), '[]'::jsonb),
    'top_events', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'count', c, 'last', l) order by c desc, name) from (
      select name, count(*) c, max(occurred_at) l from public.analytics_events where person_id = p_person
      group by name order by count(*) desc, name limit 15) t), '[]'::jsonb),
    'recent_events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'time', e.occurred_at,
        'screen', e.screen, 'session_id', e.session_id, 'properties', e.properties) order by e.occurred_at desc, e.id desc)
      from (select * from public.analytics_events where person_id = p_person order by occurred_at desc, id desc limit 50) e), '[]'::jsonb),
    -- The app install: where it came from and how it was matched. A rejected install
    -- (verdict) credits nobody, so it has no source.
    'acquisition', (select jsonb_build_object('source', i.source, 'campaign', i.campaign, 'method', i.method,
        'exact', i.exact, 'installed_at', i.installed_at, 'link_name', l.name, 'verdict', i.verdict)
      from public.attribution_installs i left join public.attribution_links l on l.id = i.link_id
      where i.person_id = p_person and i.project_id = p_project)
  );
end $$;

do $$
declare f text;
begin
  foreach f in array array['attribution_install(jsonb)', 'attribution_open(jsonb)', 'attribution_tick(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  revoke all on function public.attribution_test_device(uuid, uuid) from public, anon;
  grant execute on function public.attribution_test_device(uuid, uuid) to authenticated;
end $$;

commit;
