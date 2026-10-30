-- Merchant analytics: merchants sign in to a workspace, create one project per
-- app, issue API keys, and see the people, sessions, events and session replays
-- their apps send. Apps write only through the analytics-ingest Edge Function
-- (service role). The console reads and changes data only through the
-- security-definer RPCs below, each checking workspace membership and role.
begin;

-- Workspaces and the people who manage them -----------------------------------

create table public.analytics_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.analytics_workspace_members (
  workspace_id uuid not null references public.analytics_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'developer', 'analyst')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index analytics_workspace_members_user on public.analytics_workspace_members(user_id);
create unique index analytics_workspace_single_owner on public.analytics_workspace_members(workspace_id) where role = 'owner';

create table public.analytics_workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.analytics_workspaces(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  role text not null check (role in ('admin', 'developer', 'analyst')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null
);
create unique index analytics_workspace_open_invite on public.analytics_workspace_invites(workspace_id, email) where accepted_at is null;
create index analytics_workspace_invites_email on public.analytics_workspace_invites(email) where accepted_at is null;

-- Projects and keys -------------------------------------------------------------

create table public.analytics_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.analytics_workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  platforms text[] not null default '{}' check (platforms <@ array['ios', 'android', 'web', 'server']::text[]),
  timezone text not null default 'UTC' check (length(timezone) between 1 and 64),
  allowed_origins text[] not null default '{}' check (cardinality(allowed_origins) <= 50),
  replay_enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index analytics_projects_workspace on public.analytics_projects(workspace_id, created_at);

create table public.analytics_api_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  kind text not null check (kind in ('client', 'server')),
  environment text not null check (environment in ('production', 'development')),
  token_hash bytea not null unique check (length(token_hash) = 32),
  token_prefix text not null check (token_prefix ~ '^kma_(pk|sk)_(live|test)_$'),
  token_last4 text not null check (length(token_last4) = 4),
  -- Client keys ship inside apps and web pages, so they can be shown again.
  -- Server keys are only ever returned once, when created.
  public_token text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  check ((kind = 'client') = (public_token is not null))
);
create index analytics_api_keys_project on public.analytics_api_keys(project_id, created_at);

-- What apps send -----------------------------------------------------------------

create table public.analytics_people (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  -- The app's own user ID once identified, otherwise the SDK's anonymous ID.
  distinct_id text not null check (length(distinct_id) between 1 and 200),
  user_id text check (length(user_id) between 1 and 200),
  anonymous_ids text[] not null default '{}',
  traits jsonb not null default '{}' check (jsonb_typeof(traits) = 'object'),
  environment text not null check (environment in ('production', 'development')),
  first_seen timestamptz not null,
  last_seen timestamptz not null,
  platform text,
  country text,
  region text,
  city text,
  timezone text,
  language text,
  device_type text,
  device_model text,
  os_name text,
  os_version text,
  browser text,
  browser_version text,
  app_version text,
  sdk text,
  screen_width integer,
  screen_height integer,
  initial_referrer text,
  initial_utm_source text,
  initial_utm_medium text,
  initial_utm_campaign text,
  initial_landing text,
  sessions_count integer not null default 0,
  events_count bigint not null default 0,
  unique (project_id, distinct_id)
);
create index analytics_people_last_seen on public.analytics_people(project_id, last_seen desc);
create index analytics_people_first_seen on public.analytics_people(project_id, first_seen);
create index analytics_people_anonymous on public.analytics_people using gin(anonymous_ids);

create table public.analytics_sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  person_id uuid not null references public.analytics_people(id) on delete cascade,
  session_key text not null check (length(session_key) between 1 and 100),
  environment text not null check (environment in ('production', 'development')),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  platform text not null check (platform in ('ios', 'android', 'web', 'server')),
  country text,
  region text,
  city text,
  location_source text,
  timezone text,
  language text,
  device_type text,
  device_model text,
  os_name text,
  os_version text,
  browser text,
  browser_version text,
  app_version text,
  sdk text,
  screen_width integer,
  screen_height integer,
  network text,
  carrier text,
  user_agent text,
  ip_hash text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  landing text,
  entry_screen text,
  exit_screen text,
  screens_count integer not null default 0,
  events_count integer not null default 0,
  errors_count integer not null default 0,
  interactions integer not null default 0,
  webdriver boolean not null default false,
  bot_reasons text[] not null default '{}',
  replay_chunks integer not null default 0,
  replay_bytes bigint not null default 0,
  unique (project_id, session_key),
  check (ended_at >= started_at)
);
create index analytics_sessions_started on public.analytics_sessions(project_id, started_at desc);
create index analytics_sessions_ended on public.analytics_sessions(project_id, ended_at desc);
create index analytics_sessions_person on public.analytics_sessions(person_id, started_at desc);
create index analytics_sessions_ip on public.analytics_sessions(project_id, ip_hash);

create table public.analytics_events (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  person_id uuid not null references public.analytics_people(id) on delete cascade,
  session_id uuid references public.analytics_sessions(id) on delete cascade,
  environment text not null check (environment in ('production', 'development')),
  name text not null check (name ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$'),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  insert_id text not null check (length(insert_id) between 1 and 100),
  screen text,
  properties jsonb not null default '{}' check (jsonb_typeof(properties) = 'object'),
  unique (project_id, insert_id)
);
create index analytics_events_time on public.analytics_events(project_id, occurred_at desc);
create index analytics_events_name on public.analytics_events(project_id, name, occurred_at desc);
create index analytics_events_session on public.analytics_events(session_id, occurred_at);
create index analytics_events_person on public.analytics_events(person_id, occurred_at desc);

create table public.analytics_event_definitions (
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  name text not null,
  status text not null default 'live' check (status in ('live', 'blocked')),
  description text check (length(description) <= 200),
  first_seen timestamptz not null,
  last_seen timestamptz not null,
  primary key (project_id, name)
);

create table public.analytics_replay_chunks (
  session_id uuid not null references public.analytics_sessions(id) on delete cascade,
  seq integer not null check (seq between 0 and 9999),
  first_ts timestamptz not null,
  last_ts timestamptz not null,
  events jsonb not null check (jsonb_typeof(events) = 'array'),
  bytes integer not null,
  received_at timestamptz not null default now(),
  primary key (session_id, seq)
);

-- Bot filtering -------------------------------------------------------------------

create table public.analytics_bot_rules (
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  rule text not null check (rule in ('automation', 'crawler', 'too_fast', 'no_interaction')),
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (project_id, rule)
);

create table public.analytics_bot_overrides (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  -- 'human' keeps a person in reports whatever the rules say; 'bot' drops their
  -- past sessions from reports and refuses their new events.
  verdict text not null check (verdict in ('human', 'bot')),
  person_id uuid references public.analytics_people(id) on delete cascade,
  ip_hash text,
  note text check (length(note) <= 200),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((person_id is null) <> (ip_hash is null)),
  check (verdict = 'bot' or person_id is not null)
);
create unique index analytics_bot_override_person on public.analytics_bot_overrides(project_id, person_id) where person_id is not null;
create unique index analytics_bot_override_ip on public.analytics_bot_overrides(project_id, ip_hash) where ip_hash is not null;

do $$
declare t text;
begin
  foreach t in array array[
    'analytics_workspaces', 'analytics_workspace_members', 'analytics_workspace_invites',
    'analytics_projects', 'analytics_api_keys', 'analytics_people', 'analytics_sessions',
    'analytics_events', 'analytics_event_definitions', 'analytics_replay_chunks',
    'analytics_bot_rules', 'analytics_bot_overrides'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Internal helpers ------------------------------------------------------------------

create function kma_internal.analytics_role_rank(p_role text) returns integer
language sql immutable set search_path = '' as $$
  select case p_role when 'owner' then 4 when 'admin' then 3 when 'developer' then 2 when 'analyst' then 1 else 0 end
$$;

create function kma_internal.analytics_require_workspace(p_workspace uuid, p_min_role text default 'analyst')
returns text language plpgsql stable set search_path = '' as $$
declare v_role text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  select role into v_role from public.analytics_workspace_members
  where workspace_id = p_workspace and user_id = auth.uid();
  if v_role is null then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  if kma_internal.analytics_role_rank(v_role) < kma_internal.analytics_role_rank(p_min_role) then
    raise exception 'Your role cannot make this change' using errcode = '42501';
  end if;
  return v_role;
end $$;

create function kma_internal.analytics_require_project(p_project uuid, p_min_role text default 'analyst')
returns public.analytics_projects language plpgsql stable set search_path = '' as $$
declare v public.analytics_projects;
begin
  select * into v from public.analytics_projects where id = p_project;
  if v.id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  perform kma_internal.analytics_require_workspace(v.workspace_id, p_min_role);
  return v;
end $$;

create function kma_internal.analytics_random_token(p_length integer) returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  bytes bytea := extensions.gen_random_bytes(p_length);
  result text := '';
begin
  for i in 0 .. p_length - 1 loop
    result := result || substr(alphabet, (get_byte(bytes, i) % length(alphabet)) + 1, 1);
  end loop;
  return result;
end $$;

-- Creates a key and returns its token. Only callers that already checked access use it.
create function kma_internal.analytics_issue_key(
  p_project uuid, p_name text, p_kind text, p_environment text, p_actor uuid
) returns jsonb language plpgsql volatile set search_path = '' as $$
declare
  v_prefix text := 'kma_' || case p_kind when 'client' then 'pk' else 'sk' end || '_'
    || case p_environment when 'production' then 'live' else 'test' end || '_';
  v_token text := v_prefix || kma_internal.analytics_random_token(case p_kind when 'client' then 24 else 40 end);
  v_key public.analytics_api_keys;
begin
  if p_kind not in ('client', 'server') or p_environment not in ('production', 'development') then
    raise exception 'Choose a key type and environment' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 60 then
    raise exception 'Name the key in 1 to 60 characters' using errcode = '22023';
  end if;
  insert into public.analytics_api_keys(project_id, name, kind, environment, token_hash, token_prefix, token_last4, public_token, created_by)
  values (p_project, btrim(p_name), p_kind, p_environment, extensions.digest(v_token, 'sha256'), v_prefix, right(v_token, 4),
    case when p_kind = 'client' then v_token end, p_actor)
  returning * into v_key;
  return kma_internal.analytics_key_view(v_key) || jsonb_build_object('token', v_token);
end $$;

create function kma_internal.analytics_key_view(k public.analytics_api_keys) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', k.id, 'project_id', k.project_id, 'name', k.name, 'kind', k.kind, 'environment', k.environment,
    'prefix', k.token_prefix, 'last4', k.token_last4, 'token', k.public_token,
    'created_at', k.created_at, 'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at,
    'created_by', (select coalesce(u.raw_user_meta_data->>'full_name', u.email) from auth.users u where u.id = k.created_by)
  )
$$;

create function kma_internal.analytics_project_view(p public.analytics_projects) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'workspace_id', p.workspace_id, 'name', p.name, 'platforms', to_jsonb(p.platforms),
    'timezone', p.timezone, 'allowed_origins', to_jsonb(p.allowed_origins), 'replay_enabled', p.replay_enabled,
    'created_at', p.created_at
  )
$$;

create function kma_internal.analytics_valid_timezone(p_timezone text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone)
$$;

create function kma_internal.analytics_valid_platforms(p_platforms text[]) returns boolean
language sql immutable set search_path = '' as $$
  select p_platforms is not null and cardinality(p_platforms) between 1 and 4
    and p_platforms <@ array['ios', 'android', 'web', 'server']::text[]
$$;

-- The reasons a session looks automated. Mobile and server traffic only trips the
-- speed rule; browser rules apply to web sessions.
create function kma_internal.analytics_bot_reasons(s public.analytics_sessions) returns text[]
language sql immutable set search_path = '' as $$
  select array_remove(array[
    case when s.platform = 'web' and (s.webdriver or coalesce(s.user_agent, '') ~* '(HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|Cypress|Electron/.*Headless|Lighthouse)')
      then 'automation' end,
    case when s.platform = 'web' and coalesce(s.user_agent, '') ~* '(bot\y|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|embedly|whatsapp|telegrambot|discordbot|slackbot|python-requests|python-urllib|curl/|wget/|go-http-client|node-fetch|axios/|scrapy|httpclient|java/|libwww|ahrefs|semrush|mj12bot|petalbot|bytespider|gptbot|claudebot|ccbot)'
      then 'crawler' end,
    case when s.events_count >= 20 and s.events_count / greatest(extract(epoch from (s.ended_at - s.started_at)), 1) > 3
      then 'too_fast' end,
    case when s.platform = 'web' and s.screens_count >= 5 and s.interactions = 0
      then 'no_interaction' end
  ], null)
$$;

-- Production sessions that count as people in reports: not caught by an enabled
-- bot rule (unless marked human) and not blocked.
create function kma_internal.analytics_report_sessions(p_project uuid, p_from timestamptz, p_to timestamptz)
returns setof public.analytics_sessions language sql stable set search_path = '' as $$
  select s.* from public.analytics_sessions s
  where s.project_id = p_project and s.environment = 'production'
    and s.started_at >= p_from and s.started_at < p_to
    and not exists (
      select 1 from public.analytics_bot_overrides o
      where o.project_id = p_project and o.verdict = 'bot' and (o.person_id = s.person_id or o.ip_hash = s.ip_hash)
    )
    and (
      not (s.bot_reasons && coalesce((select array_agg(r.rule) from public.analytics_bot_rules r where r.project_id = p_project and r.enabled), '{}'::text[]))
      or exists (select 1 from public.analytics_bot_overrides o where o.project_id = p_project and o.verdict = 'human' and o.person_id = s.person_id)
    )
$$;

create function kma_internal.analytics_session_excluded(s public.analytics_sessions) returns boolean
language sql stable set search_path = '' as $$
  select exists (
      select 1 from public.analytics_bot_overrides o
      where o.project_id = s.project_id and o.verdict = 'bot' and (o.person_id = s.person_id or o.ip_hash = s.ip_hash)
    )
    or (
      s.bot_reasons && coalesce((select array_agg(r.rule) from public.analytics_bot_rules r where r.project_id = s.project_id and r.enabled), '{}'::text[])
      and not exists (select 1 from public.analytics_bot_overrides o where o.project_id = s.project_id and o.verdict = 'human' and o.person_id = s.person_id)
    )
$$;

-- A window and its preceding window of the same length, in the project's time zone.
create function kma_internal.analytics_window(p_range text, p_timezone text)
returns table (from_at timestamptz, to_at timestamptz, prev_from timestamptz, prev_to timestamptz, bucket text, days integer)
language plpgsql stable set search_path = '' as $$
declare
  v_days integer := case p_range when 'today' then 1 when '7d' then 7 when '30d' then 30 when '90d' then 90 end;
  v_start timestamptz;
begin
  if v_days is null then
    raise exception 'Choose today, 7d, 30d or 90d' using errcode = '22023';
  end if;
  v_start := (date_trunc('day', now() at time zone p_timezone) - make_interval(days => v_days - 1)) at time zone p_timezone;
  return query select v_start, now(), v_start - make_interval(days => v_days), now() - make_interval(days => v_days),
    case when v_days = 1 then 'hour' else 'day' end, v_days;
end $$;

-- Chart buckets: the last 24 clock hours for today, otherwise the window's local days.
create function kma_internal.analytics_buckets(p_range text, p_timezone text)
returns table (bucket_start timestamptz, bucket_end timestamptz) language sql stable set search_path = '' as $$
  select b, b + interval '1 hour'
  from generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') b
  where p_range = 'today'
  union all
  select d at time zone p_timezone, (d + interval '1 day') at time zone p_timezone
  from generate_series(
    ((now() at time zone p_timezone)::date - (case p_range when '7d' then 6 when '30d' then 29 when '90d' then 89 end))::timestamp,
    (now() at time zone p_timezone)::date::timestamp, interval '1 day') d
  where p_range in ('7d', '30d', '90d')
  order by 1
$$;

create function kma_internal.analytics_person_view(p public.analytics_people) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'distinct_id', p.distinct_id, 'user_id', p.user_id, 'anonymous_ids', to_jsonb(p.anonymous_ids),
    'traits', p.traits, 'environment', p.environment, 'first_seen', p.first_seen, 'last_seen', p.last_seen,
    'platform', p.platform, 'country', p.country, 'region', p.region, 'city', p.city, 'timezone', p.timezone,
    'language', p.language, 'device_type', p.device_type, 'device_model', p.device_model, 'os_name', p.os_name,
    'os_version', p.os_version, 'browser', p.browser, 'browser_version', p.browser_version, 'app_version', p.app_version,
    'sdk', p.sdk, 'screen_width', p.screen_width, 'screen_height', p.screen_height,
    'initial_referrer', p.initial_referrer, 'initial_utm_source', p.initial_utm_source,
    'initial_utm_medium', p.initial_utm_medium, 'initial_utm_campaign', p.initial_utm_campaign,
    'initial_landing', p.initial_landing, 'sessions_count', p.sessions_count, 'events_count', p.events_count,
    'online', exists (select 1 from public.analytics_sessions s where s.person_id = p.id and s.ended_at >= now() - interval '5 minutes')
  )
$$;

create function kma_internal.analytics_session_view(s public.analytics_sessions) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id, 'person_id', s.person_id, 'session_key', s.session_key, 'environment', s.environment,
    'started_at', s.started_at, 'ended_at', s.ended_at,
    'duration_seconds', round(extract(epoch from (s.ended_at - s.started_at)))::integer,
    'platform', s.platform, 'country', s.country, 'region', s.region, 'city', s.city,
    'location_source', s.location_source, 'timezone', s.timezone, 'language', s.language,
    'device_type', s.device_type, 'device_model', s.device_model, 'os_name', s.os_name, 'os_version', s.os_version,
    'browser', s.browser, 'browser_version', s.browser_version, 'app_version', s.app_version, 'sdk', s.sdk,
    'screen_width', s.screen_width, 'screen_height', s.screen_height, 'network', s.network, 'carrier', s.carrier,
    'user_agent', s.user_agent, 'referrer', s.referrer, 'utm_source', s.utm_source, 'utm_medium', s.utm_medium,
    'utm_campaign', s.utm_campaign, 'landing', s.landing, 'entry_screen', s.entry_screen, 'exit_screen', s.exit_screen,
    'screens_count', s.screens_count, 'events_count', s.events_count, 'errors_count', s.errors_count,
    'interactions', s.interactions, 'bot_reasons', to_jsonb(s.bot_reasons),
    'excluded', kma_internal.analytics_session_excluded(s),
    'has_replay', s.replay_chunks > 0, 'replay_bytes', s.replay_bytes,
    'live', s.ended_at >= now() - interval '5 minutes'
  )
$$;

-- Ingest (service role only) ------------------------------------------------------------

create function kma_internal.analytics_text(p_value jsonb, p_max integer default 200) returns text
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_value) = 'string' and length(p_value #>> '{}') between 1 and p_max then p_value #>> '{}' end
$$;

create function kma_internal.analytics_int(p_value jsonb) returns integer
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_value) = 'number' and (p_value #>> '{}')::numeric between 0 and 100000
    then round((p_value #>> '{}')::numeric)::integer end
$$;

create function kma_internal.analytics_resolve_person(
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
      country = coalesce(p_geo->>'country', p.country),
      region = coalesce(p_geo->>'region', p.region),
      city = coalesce(p_geo->>'city', p.city),
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

create function kma_internal.analytics_touch_session(
  p_project uuid, p_environment text, p_person uuid, p_session_key text, p_started_at timestamptz,
  p_at timestamptz, p_context jsonb, p_geo jsonb, p_ip_hash text, p_user_agent text
) returns uuid language plpgsql volatile set search_path = '' as $$
declare
  v_session uuid;
  v_inserted boolean;
begin
  insert into public.analytics_sessions(
    project_id, person_id, session_key, environment, started_at, ended_at, platform,
    country, region, city, location_source, timezone, language, device_type, device_model, os_name, os_version,
    browser, browser_version, app_version, sdk, screen_width, screen_height, network, carrier, user_agent, ip_hash,
    referrer, utm_source, utm_medium, utm_campaign, landing, interactions, webdriver
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
    country = coalesce(public.analytics_sessions.country, excluded.country),
    city = coalesce(public.analytics_sessions.city, excluded.city),
    ip_hash = coalesce(public.analytics_sessions.ip_hash, excluded.ip_hash)
  returning id, (xmax = 0) into v_session, v_inserted;
  if v_inserted then
    update public.analytics_people set sessions_count = sessions_count + 1 where id = p_person;
  end if;
  return v_session;
end $$;

create function public.analytics_ingest(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key public.analytics_api_keys;
  v_project public.analytics_projects;
  v_body jsonb := p->'body';
  v_context jsonb := coalesce(p->'body'->'context', '{}'::jsonb);
  v_geo jsonb := coalesce(p->'geo', '{}'::jsonb);
  v_ip_hash text;
  v_user_agent text := left(p->>'user_agent', 400);
  v_body_user text := kma_internal.analytics_text(p->'body'->'user_id');
  v_now timestamptz := clock_timestamp();
  v_skew interval := make_interval(secs => coalesce((p->>'clock_skew_ms')::numeric, 0) / 1000);
  v_event jsonb;
  v_index integer := -1;
  v_at timestamptz;
  v_name text;
  v_screen text;
  v_user_id text;
  v_anon_id text;
  v_person uuid;
  v_session uuid;
  v_session_key text := kma_internal.analytics_text(p->'body'->'session'->'id', 100);
  v_session_started timestamptz;
  v_status text;
  v_event_id bigint;
  v_stored integer := 0;
  v_duplicates integer := 0;
  v_rejected jsonb := '[]'::jsonb;
  v_touched uuid[] := '{}';
  v_people uuid[] := '{}';
  v_last_identity text;
  v_oldest interval;
  v_chunk jsonb;
  v_bytes integer;
  v_first timestamptz;
  v_last timestamptz;
begin
  select * into v_key from public.analytics_api_keys
  where token_hash = decode(p->>'key_hash', 'hex') and revoked_at is null;
  if v_key.id is null then
    raise exception 'invalid_key' using errcode = '28000';
  end if;
  select * into v_project from public.analytics_projects where id = v_key.project_id;
  if v_key.kind = 'client' and cardinality(v_project.allowed_origins) > 0 and p->>'origin' is not null
     and not (p->>'origin' = any(v_project.allowed_origins)) then
    raise exception 'origin_not_allowed' using errcode = '42501';
  end if;
  update public.analytics_api_keys set last_used_at = v_now
  where id = v_key.id and (last_used_at is null or last_used_at < v_now - interval '1 minute');

  -- Server keys call from the merchant's own servers, so the request's network,
  -- place and browser say nothing about the person. They may pass them instead.
  if v_key.kind = 'server' then
    v_geo := jsonb_strip_nulls(jsonb_build_object(
      'country', case when upper(v_context->>'country') ~ '^[A-Z]{2}$' then upper(v_context->>'country') end,
      'region', kma_internal.analytics_text(v_context->'region', 80),
      'city', kma_internal.analytics_text(v_context->'city', 80),
      'source', case when upper(v_context->>'country') ~ '^[A-Z]{2}$' then 'api' end));
    v_user_agent := kma_internal.analytics_text(v_context->'user_agent', 400);
    p := p - 'ip_sha';
  end if;

  if p->>'ip_sha' is not null then
    v_ip_hash := encode(extensions.digest(v_project.id::text || ':' || (p->>'ip_sha'), 'sha256'), 'hex');
    if exists (select 1 from public.analytics_bot_overrides where project_id = v_project.id and verdict = 'bot' and ip_hash = v_ip_hash) then
      return jsonb_build_object('stored', 0, 'duplicates', 0, 'blocked', true, 'rejected', '[]'::jsonb);
    end if;
  end if;
  -- Server keys may import history; apps may only send recent events.
  v_oldest := case when v_key.kind = 'server' then interval '400 days' else interval '7 days' end;
  if coalesce(v_body->'session'->>'started_at', '') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
    v_session_started := (v_body->'session'->>'started_at')::timestamptz + v_skew;
  end if;

  if p->>'kind' = 'replay' then
    if not v_project.replay_enabled then
      raise exception 'replay_disabled' using errcode = '55000';
    end if;
    if v_session_key is null then
      raise exception 'A replay needs a session' using errcode = '22023';
    end if;
    v_chunk := v_body->'replay';
    if jsonb_typeof(v_chunk->'events') is distinct from 'array' or jsonb_typeof(v_chunk->'first_ts') is distinct from 'number'
       or jsonb_typeof(v_chunk->'last_ts') is distinct from 'number' or jsonb_typeof(v_chunk->'seq') is distinct from 'number'
       or (v_chunk->>'seq')::numeric not between 0 and 9999 then
      raise exception 'Replay chunk is malformed' using errcode = '22023';
    end if;
    v_bytes := length((v_chunk->'events')::text);
    v_first := to_timestamp(((v_chunk->>'first_ts')::numeric) / 1000) + v_skew;
    v_last := to_timestamp(((v_chunk->>'last_ts')::numeric) / 1000) + v_skew;
    if v_first is null or v_last < v_first or v_last > v_now + interval '5 minutes' or v_first < v_now - interval '1 day' then
      raise exception 'Replay times are out of range' using errcode = '22023';
    end if;
    v_person := kma_internal.analytics_resolve_person(v_project.id, v_key.environment,
      kma_internal.analytics_text(v_body->'user_id'), kma_internal.analytics_text(v_body->'anonymous_id'), v_last, v_context, v_geo, null);
    if exists (select 1 from public.analytics_bot_overrides where project_id = v_project.id and verdict = 'bot' and person_id = v_person) then
      return jsonb_build_object('stored', 0, 'blocked', true);
    end if;
    v_session := kma_internal.analytics_touch_session(v_project.id, v_key.environment, v_person, v_session_key,
      v_session_started, v_last, v_context, v_geo, v_ip_hash, v_user_agent);
    if (select replay_bytes from public.analytics_sessions where id = v_session) + v_bytes > 20 * 1024 * 1024 then
      raise exception 'replay_too_large' using errcode = '54000';
    end if;
    insert into public.analytics_replay_chunks(session_id, seq, first_ts, last_ts, events, bytes)
    values (v_session, (v_chunk->>'seq')::integer, v_first, v_last, v_chunk->'events', v_bytes)
    on conflict do nothing;
    if found then
      update public.analytics_sessions set replay_chunks = replay_chunks + 1, replay_bytes = replay_bytes + v_bytes
      where id = v_session;
      return jsonb_build_object('stored', 1, 'duplicates', 0);
    end if;
    return jsonb_build_object('stored', 0, 'duplicates', 1);
  end if;

  for v_event in select value from jsonb_array_elements(coalesce(v_body->'events', '[]'::jsonb)) loop
    v_index := v_index + 1;
    v_name := v_event->>'name';
    if jsonb_typeof(v_event) <> 'object' or coalesce(v_name, '') !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$'
       or length(coalesce(v_event->>'insert_id', '')) not between 1 and 100
       or coalesce(v_event->>'time', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
       or coalesce(jsonb_typeof(v_event->'properties'), 'object') <> 'object' then
      v_rejected := v_rejected || jsonb_build_object('index', v_index, 'reason', 'invalid_event');
      continue;
    end if;
    v_at := (v_event->>'time')::timestamptz + v_skew;
    if v_at > v_now + interval '5 minutes' or v_at < v_now - v_oldest then
      v_rejected := v_rejected || jsonb_build_object('index', v_index, 'reason', 'time_out_of_range');
      continue;
    end if;
    select status into v_status from public.analytics_event_definitions where project_id = v_project.id and name = v_name;
    if v_status = 'blocked' then
      v_rejected := v_rejected || jsonb_build_object('index', v_index, 'reason', 'event_blocked');
      continue;
    end if;
    -- An event may name its own user (the SDK does when identify happens mid-batch,
    -- servers do when importing many users); otherwise the batch's identity applies.
    v_user_id := case when v_event ? 'user_id' then kma_internal.analytics_text(v_event->'user_id') else v_body_user end;
    v_anon_id := coalesce(kma_internal.analytics_text(v_event->'anonymous_id'), kma_internal.analytics_text(v_body->'anonymous_id'));
    if coalesce(v_user_id, v_anon_id) is null then
      v_rejected := v_rejected || jsonb_build_object('index', v_index, 'reason', 'identity_required');
      continue;
    end if;
    if v_last_identity is distinct from (coalesce(v_user_id, '') || '|' || coalesce(v_anon_id, '')) then
      v_person := kma_internal.analytics_resolve_person(v_project.id, v_key.environment, v_user_id, v_anon_id, v_at,
        coalesce(v_event->'context', v_context), v_geo,
        case when v_user_id is not distinct from v_body_user then v_body->'traits' end);
      v_last_identity := coalesce(v_user_id, '') || '|' || coalesce(v_anon_id, '');
      if exists (select 1 from public.analytics_bot_overrides where project_id = v_project.id and verdict = 'bot' and person_id = v_person) then
        v_rejected := v_rejected || jsonb_build_object('index', v_index, 'reason', 'blocked');
        v_person := null;
        continue;
      end if;
      v_session := null;
      if v_session_key is not null then
        v_session := kma_internal.analytics_touch_session(v_project.id, v_key.environment, v_person, v_session_key,
          v_session_started, v_at, v_context, v_geo, v_ip_hash, v_user_agent);
      end if;
    elsif v_person is null then
      v_rejected := v_rejected || jsonb_build_object('index', v_index, 'reason', 'blocked');
      continue;
    end if;
    if v_session is not null then
      update public.analytics_sessions set ended_at = greatest(ended_at, v_at), started_at = least(started_at, v_at) where id = v_session;
    end if;

    insert into public.analytics_event_definitions(project_id, name, first_seen, last_seen)
    values (v_project.id, v_name, v_at, v_at)
    on conflict (project_id, name) do update set
      last_seen = greatest(public.analytics_event_definitions.last_seen, excluded.last_seen),
      first_seen = least(public.analytics_event_definitions.first_seen, excluded.first_seen);

    v_screen := kma_internal.analytics_text(v_event->'screen', 300);
    insert into public.analytics_events(project_id, person_id, session_id, environment, name, occurred_at, insert_id, screen, properties)
    values (v_project.id, v_person, v_session, v_key.environment, v_name, v_at, v_event->>'insert_id', v_screen,
      coalesce(v_event->'properties', '{}'::jsonb))
    on conflict (project_id, insert_id) do nothing
    returning id into v_event_id;
    if v_event_id is null then
      v_duplicates := v_duplicates + 1;
      continue;
    end if;
    v_event_id := null;
    v_stored := v_stored + 1;
    update public.analytics_people set events_count = events_count + 1, last_seen = greatest(last_seen, v_at) where id = v_person;
    if not v_person = any(v_people) then v_people := v_people || v_person; end if;
    if v_session is not null then
      update public.analytics_sessions s set
        events_count = s.events_count + 1,
        screens_count = s.screens_count + case when v_name in ('page_viewed', 'screen_viewed') then 1 else 0 end,
        errors_count = s.errors_count + case when v_name = 'error_thrown' then 1 else 0 end,
        entry_screen = case when v_name in ('page_viewed', 'screen_viewed') and (s.entry_screen is null or v_at <= s.started_at) then v_screen else s.entry_screen end,
        exit_screen = case when v_name in ('page_viewed', 'screen_viewed') and v_at >= s.ended_at then v_screen else s.exit_screen end
      where s.id = v_session;
      if not v_session = any(v_touched) then v_touched := v_touched || v_session; end if;
    end if;
  end loop;

  -- A heartbeat with no events still keeps the session (and the person) current.
  if v_index = -1 and v_session_key is not null then
    v_anon_id := kma_internal.analytics_text(v_body->'anonymous_id');
    v_user_id := kma_internal.analytics_text(v_body->'user_id');
    if coalesce(v_user_id, v_anon_id) is not null then
      v_at := v_now;
      if coalesce(v_body->>'sent_at', '') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
        v_at := least(greatest((v_body->>'sent_at')::timestamptz + v_skew, v_now - interval '1 day'), v_now);
      end if;
      v_person := kma_internal.analytics_resolve_person(v_project.id, v_key.environment, v_user_id, v_anon_id, v_at, v_context, v_geo, v_body->'traits');
      if not exists (select 1 from public.analytics_bot_overrides where project_id = v_project.id and verdict = 'bot' and person_id = v_person) then
        v_session := kma_internal.analytics_touch_session(v_project.id, v_key.environment, v_person, v_session_key,
          v_session_started, v_at, v_context, v_geo, v_ip_hash, v_user_agent);
        v_touched := v_touched || v_session;
      end if;
    end if;
  end if;

  update public.analytics_sessions s set bot_reasons = kma_internal.analytics_bot_reasons(s) where s.id = any(v_touched);

  return jsonb_build_object('stored', v_stored, 'duplicates', v_duplicates, 'rejected', v_rejected);
end $$;

revoke all on function public.analytics_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.analytics_ingest(jsonb) to service_role;

-- Account and workspace ---------------------------------------------------------------

create function public.analytics_bootstrap(p_workspace_name text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user auth.users;
  v_workspace uuid;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  select * into v_user from auth.users where id = auth.uid();
  -- Invitations are accepted by signing in with the invited, confirmed address.
  if v_user.email is not null and v_user.email_confirmed_at is not null then
    insert into public.analytics_workspace_members(workspace_id, user_id, role)
    select i.workspace_id, v_user.id, i.role from public.analytics_workspace_invites i
    where i.email = lower(v_user.email) and i.accepted_at is null
    on conflict do nothing;
    update public.analytics_workspace_invites set accepted_at = now(), accepted_by = v_user.id
    where email = lower(v_user.email) and accepted_at is null;
  end if;
  if not exists (select 1 from public.analytics_workspace_members where user_id = v_user.id) then
    v_name := btrim(coalesce(nullif(btrim(p_workspace_name), ''), v_user.raw_user_meta_data->>'company',
      split_part(coalesce(v_user.email, 'My'), '@', 1) || ' workspace'));
    insert into public.analytics_workspaces(name, created_by) values (left(v_name, 80), v_user.id) returning id into v_workspace;
    insert into public.analytics_workspace_members(workspace_id, user_id, role) values (v_workspace, v_user.id, 'owner');
  end if;
  return public.analytics_context();
end $$;

create function public.analytics_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user auth.users;
begin
  if auth.uid() is null then
    raise exception 'Sign in to continue' using errcode = '42501';
  end if;
  select * into v_user from auth.users where id = auth.uid();
  return jsonb_build_object(
    'user', jsonb_build_object('id', v_user.id, 'email', v_user.email,
      'name', coalesce(v_user.raw_user_meta_data->>'full_name', split_part(v_user.email, '@', 1))),
    'workspaces', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', w.id, 'name', w.name, 'role', m.role,
        'projects', coalesce((
          select jsonb_agg(kma_internal.analytics_project_view(p) || jsonb_build_object(
            'last_event_at', (select max(s.ended_at) from public.analytics_sessions s where s.project_id = p.id),
            'online_now', (select count(distinct s.person_id) from public.analytics_sessions s
              where s.project_id = p.id and s.environment = 'production' and s.ended_at >= now() - interval '5 minutes'
              and not kma_internal.analytics_session_excluded(s)),
            'users_today', (select count(distinct s.person_id) from kma_internal.analytics_report_sessions(p.id,
              (date_trunc('day', now() at time zone p.timezone)) at time zone p.timezone, now()) s)
          ) order by p.created_at)
          from public.analytics_projects p where p.workspace_id = w.id), '[]'::jsonb)
      ) order by w.created_at)
      from public.analytics_workspace_members m join public.analytics_workspaces w on w.id = m.workspace_id
      where m.user_id = v_user.id), '[]'::jsonb)
  );
end $$;

create function public.analytics_rename_workspace(p_workspace uuid, p_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_workspace(p_workspace, 'admin');
  if length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'Name the workspace in 1 to 80 characters' using errcode = '22023';
  end if;
  update public.analytics_workspaces set name = btrim(p_name) where id = p_workspace;
  return public.analytics_context();
end $$;

-- Projects and keys ---------------------------------------------------------------------------

create function public.analytics_create_project(p_workspace uuid, p_name text, p_platforms text[], p_timezone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_project public.analytics_projects;
  v_key jsonb;
begin
  perform kma_internal.analytics_require_workspace(p_workspace, 'admin');
  if length(btrim(coalesce(p_name, ''))) not between 1 and 60 then
    raise exception 'Name the project in 1 to 60 characters' using errcode = '22023';
  end if;
  if not kma_internal.analytics_valid_platforms(p_platforms) then
    raise exception 'Pick at least one platform' using errcode = '22023';
  end if;
  if not kma_internal.analytics_valid_timezone(coalesce(p_timezone, '')) then
    raise exception 'Choose a valid time zone' using errcode = '22023';
  end if;
  if (select count(*) from public.analytics_projects where workspace_id = p_workspace) >= 50 then
    raise exception 'A workspace can have up to 50 projects' using errcode = '54000';
  end if;
  insert into public.analytics_projects(workspace_id, name, platforms, timezone, created_by)
  values (p_workspace, btrim(p_name), (select array_agg(distinct x order by x) from unnest(p_platforms) x), p_timezone, auth.uid())
  returning * into v_project;
  insert into public.analytics_bot_rules(project_id, rule)
  select v_project.id, r from unnest(array['automation', 'crawler', 'too_fast', 'no_interaction']) r;
  v_key := kma_internal.analytics_issue_key(v_project.id,
    case when 'web' = any(v_project.platforms) and cardinality(v_project.platforms) = 1 then 'Website' else 'Apps' end,
    'client', 'production', auth.uid());
  return jsonb_build_object('project', kma_internal.analytics_project_view(v_project), 'key', v_key);
end $$;

create function public.analytics_update_project(p_project uuid, p_patch jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project, 'developer');
  v_origins text[];
  v_origin text;
begin
  if jsonb_typeof(p_patch) <> 'object' or exists (
    select 1 from jsonb_object_keys(p_patch) k where k <> all(array['name', 'platforms', 'timezone', 'allowed_origins', 'replay_enabled'])
  ) then
    raise exception 'Unknown project setting' using errcode = '22023';
  end if;
  if p_patch ? 'name' then
    if length(btrim(coalesce(p_patch->>'name', ''))) not between 1 and 60 then
      raise exception 'Name the project in 1 to 60 characters' using errcode = '22023';
    end if;
    v.name := btrim(p_patch->>'name');
  end if;
  if p_patch ? 'platforms' then
    if jsonb_typeof(p_patch->'platforms') <> 'array'
       or not kma_internal.analytics_valid_platforms(array(select jsonb_array_elements_text(p_patch->'platforms'))) then
      raise exception 'Pick at least one platform' using errcode = '22023';
    end if;
    v.platforms := array(select distinct x from jsonb_array_elements_text(p_patch->'platforms') x order by x);
  end if;
  if p_patch ? 'timezone' then
    if not kma_internal.analytics_valid_timezone(coalesce(p_patch->>'timezone', '')) then
      raise exception 'Choose a valid time zone' using errcode = '22023';
    end if;
    v.timezone := p_patch->>'timezone';
  end if;
  if p_patch ? 'allowed_origins' then
    if jsonb_typeof(p_patch->'allowed_origins') <> 'array' or jsonb_array_length(p_patch->'allowed_origins') > 50 then
      raise exception 'List up to 50 websites' using errcode = '22023';
    end if;
    v_origins := '{}';
    for v_origin in select lower(btrim(x)) from jsonb_array_elements_text(p_patch->'allowed_origins') x loop
      if v_origin !~ '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$' then
        raise exception 'Use full website origins such as https://example.com' using errcode = '22023';
      end if;
      if not v_origin = any(v_origins) then v_origins := v_origins || v_origin; end if;
    end loop;
    v.allowed_origins := v_origins;
  end if;
  if p_patch ? 'replay_enabled' then
    if jsonb_typeof(p_patch->'replay_enabled') <> 'boolean' then
      raise exception 'Replay setting must be on or off' using errcode = '22023';
    end if;
    v.replay_enabled := (p_patch->>'replay_enabled')::boolean;
  end if;
  update public.analytics_projects set name = v.name, platforms = v.platforms, timezone = v.timezone,
    allowed_origins = v.allowed_origins, replay_enabled = v.replay_enabled
  where id = p_project returning * into v;
  return kma_internal.analytics_project_view(v);
end $$;

create function public.analytics_delete_project(p_project uuid, p_confirm_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v public.analytics_projects := kma_internal.analytics_require_project(p_project, 'admin');
begin
  if p_confirm_name is distinct from v.name then
    raise exception 'Type the project name exactly to delete it' using errcode = '22023';
  end if;
  delete from public.analytics_projects where id = p_project;
  return jsonb_build_object('deleted', p_project);
end $$;

create function public.analytics_project_settings(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  v_role text := kma_internal.analytics_require_workspace(v.workspace_id);
begin
  return jsonb_build_object(
    'project', kma_internal.analytics_project_view(v),
    'role', v_role,
    'keys', coalesce((select jsonb_agg(kma_internal.analytics_key_view(k) order by k.created_at)
      from public.analytics_api_keys k where k.project_id = p_project), '[]'::jsonb)
  );
end $$;

create function public.analytics_create_key(p_project uuid, p_name text, p_kind text, p_environment text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  if (select count(*) from public.analytics_api_keys where project_id = p_project and revoked_at is null) >= 20 then
    raise exception 'A project can have up to 20 active keys' using errcode = '54000';
  end if;
  return kma_internal.analytics_issue_key(p_project, p_name, p_kind, p_environment, auth.uid());
end $$;

create function public.analytics_revoke_key(p_key uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_key public.analytics_api_keys;
begin
  select * into v_key from public.analytics_api_keys where id = p_key;
  if v_key.id is null then
    raise exception 'Key not found' using errcode = 'P0002';
  end if;
  perform kma_internal.analytics_require_project(v_key.project_id, 'developer');
  update public.analytics_api_keys set revoked_at = coalesce(revoked_at, now()) where id = p_key returning * into v_key;
  return kma_internal.analytics_key_view(v_key);
end $$;

-- Members ----------------------------------------------------------------------------------------

create function public.analytics_members(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_role text := kma_internal.analytics_require_workspace(p_workspace);
begin
  return jsonb_build_object(
    'role', v_role,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', m.user_id, 'email', u.email,
        'name', coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)),
        'role', m.role, 'joined_at', m.created_at, 'last_sign_in_at', u.last_sign_in_at,
        'is_you', m.user_id = auth.uid()
      ) order by kma_internal.analytics_role_rank(m.role) desc, m.created_at)
      from public.analytics_workspace_members m join auth.users u on u.id = m.user_id
      where m.workspace_id = p_workspace), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'created_at', i.created_at) order by i.created_at)
      from public.analytics_workspace_invites i where i.workspace_id = p_workspace and i.accepted_at is null), '[]'::jsonb)
  );
end $$;

create function public.analytics_invite_member(p_workspace uuid, p_email text, p_role text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  perform kma_internal.analytics_require_workspace(p_workspace, 'admin');
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if p_role not in ('admin', 'developer', 'analyst') then
    raise exception 'Choose admin, developer or analyst' using errcode = '22023';
  end if;
  if exists (select 1 from public.analytics_workspace_members m join auth.users u on u.id = m.user_id
             where m.workspace_id = p_workspace and lower(u.email) = v_email) then
    raise exception 'That person is already in this workspace' using errcode = '23505';
  end if;
  insert into public.analytics_workspace_invites(workspace_id, email, role, invited_by)
  values (p_workspace, v_email, p_role, auth.uid())
  on conflict (workspace_id, email) where accepted_at is null do update set role = excluded.role;
  return public.analytics_members(p_workspace);
end $$;

create function public.analytics_set_member_role(p_workspace uuid, p_user uuid, p_role text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_workspace(p_workspace, 'admin');
  if p_role not in ('admin', 'developer', 'analyst') then
    raise exception 'Choose admin, developer or analyst' using errcode = '22023';
  end if;
  if (select role from public.analytics_workspace_members where workspace_id = p_workspace and user_id = p_user) = 'owner' then
    raise exception 'The owner''s role cannot change' using errcode = '42501';
  end if;
  update public.analytics_workspace_members set role = p_role where workspace_id = p_workspace and user_id = p_user;
  if not found then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;
  return public.analytics_members(p_workspace);
end $$;

create function public.analytics_remove_member(p_workspace uuid, p_user uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_workspace(p_workspace, 'admin');
  if (select role from public.analytics_workspace_members where workspace_id = p_workspace and user_id = p_user) = 'owner' then
    raise exception 'The owner cannot be removed' using errcode = '42501';
  end if;
  delete from public.analytics_workspace_members where workspace_id = p_workspace and user_id = p_user;
  if not found then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;
  return public.analytics_members(p_workspace);
end $$;

create function public.analytics_cancel_invite(p_invite uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_workspace uuid;
begin
  select workspace_id into v_workspace from public.analytics_workspace_invites where id = p_invite and accepted_at is null;
  if v_workspace is null then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;
  perform kma_internal.analytics_require_workspace(v_workspace, 'admin');
  delete from public.analytics_workspace_invites where id = p_invite;
  return public.analytics_members(v_workspace);
end $$;

-- Reports ------------------------------------------------------------------------------------------

create function kma_internal.analytics_kpis(p_project uuid, p_from timestamptz, p_to timestamptz, p_timezone text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'users', count(distinct s.person_id),
    'new_users', count(distinct s.person_id) filter (where p.first_seen >= p_from),
    'returning_users', count(distinct s.person_id) filter (where p.first_seen < p_from),
    'sessions', count(*),
    'avg_session_seconds', coalesce(round(avg(extract(epoch from (s.ended_at - s.started_at)))), 0),
    'sessions_per_user', coalesce(round(count(*)::numeric / nullif(count(distinct s.person_id), 0), 2), 0),
    'events', coalesce(sum(s.events_count), 0),
    'errors', coalesce(sum(s.errors_count), 0),
    -- Average of each local day's distinct people, counting today as a day.
    'daily_users', coalesce(round(count(distinct (s.person_id, (s.started_at at time zone p_timezone)::date))::numeric
      / greatest(1, ((p_to at time zone p_timezone)::date - (p_from at time zone p_timezone)::date) + 1), 1), 0)
  )
  from kma_internal.analytics_report_sessions(p_project, p_from, p_to) s
  join public.analytics_people p on p.id = s.person_id
$$;

create function public.analytics_overview(p_project uuid, p_range text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  w record;
  v_series jsonb;
  v_breakdowns jsonb;
  v_bots jsonb;
  v_series_from timestamptz;
begin
  select * into w from kma_internal.analytics_window(p_range, v.timezone);
  select min(bucket_start) into v_series_from from kma_internal.analytics_buckets(p_range, v.timezone);

  with sessions as (
    select s.person_id, s.started_at, p.first_seen
    from kma_internal.analytics_report_sessions(p_project, v_series_from, now()) s
    join public.analytics_people p on p.id = s.person_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'start', b.bucket_start,
    'users', (select count(distinct x.person_id) from sessions x where x.started_at >= b.bucket_start and x.started_at < b.bucket_end),
    'new_users', (select count(distinct x.person_id) from sessions x where x.started_at >= b.bucket_start and x.started_at < b.bucket_end
      and x.first_seen >= b.bucket_start and x.first_seen < b.bucket_end),
    'sessions', (select count(*) from sessions x where x.started_at >= b.bucket_start and x.started_at < b.bucket_end),
    'partial', b.bucket_end > now()
  ) order by b.bucket_start), '[]'::jsonb) into v_series
  from kma_internal.analytics_buckets(p_range, v.timezone) b;

  with s as (select * from kma_internal.analytics_report_sessions(p_project, w.from_at, w.to_at)),
  ev as (
    select e.name, e.screen, e.person_id from public.analytics_events e join s on s.id = e.session_id
  )
  select jsonb_build_object(
    'countries', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'users', n) order by n desc, k) from (
      select country k, count(distinct person_id) n from s where country is not null group by 1 order by 2 desc, 1 limit 15) t), '[]'::jsonb),
    'unknown_country', (select count(distinct person_id) from s where country is null),
    'cities', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'country', c, 'users', n) order by n desc, k) from (
      select city k, country c, count(distinct person_id) n from s where city is not null group by 1, 2 order by 3 desc, 1 limit 15) t), '[]'::jsonb),
    'platforms', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'users', n) order by n desc, k) from (
      select platform k, count(distinct person_id) n from s group by 1) t), '[]'::jsonb),
    'device_types', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'users', n) order by n desc, k) from (
      select coalesce(device_type, 'unknown') k, count(distinct person_id) n from s group by 1) t), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'users', n) order by n desc, k) from (
      select device_model k, count(distinct person_id) n from s where device_model is not null group by 1 order by 2 desc, 1 limit 12) t), '[]'::jsonb),
    'os', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'users', n) order by n desc, k) from (
      select concat_ws(' ', os_name, nullif(split_part(coalesce(os_version, ''), '.', 1), '')) k, count(distinct person_id) n
      from s where os_name is not null group by 1 order by 2 desc, 1 limit 12) t), '[]'::jsonb),
    'browsers', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'users', n) order by n desc, k) from (
      select concat_ws(' ', browser, nullif(split_part(coalesce(browser_version, ''), '.', 1), '')) k, count(distinct person_id) n
      from s where platform = 'web' and browser is not null group by 1 order by 2 desc, 1 limit 12) t), '[]'::jsonb),
    'app_versions', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'platform', pl, 'users', n) order by n desc, k) from (
      select app_version k, platform pl, count(distinct person_id) n
      from s where platform in ('ios', 'android') and app_version is not null group by 1, 2 order by 3 desc, 1 limit 12) t), '[]'::jsonb),
    'languages', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'users', n) order by n desc, k) from (
      select split_part(language, '-', 1) k, count(distinct person_id) n from s where language is not null group by 1 order by 2 desc, 1 limit 12) t), '[]'::jsonb),
    'referrers', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'users', n) order by n desc, k) from (
      select coalesce(utm_source, nullif(substring(referrer from '^[a-z]+://(?:www\.)?([^/:?#]+)'), ''), 'Direct') k, count(distinct person_id) n
      from s where platform = 'web' group by 1 order by 2 desc, 1 limit 12) t), '[]'::jsonb),
    'entry_screens', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'sessions', n) order by n desc, k) from (
      select entry_screen k, count(*) n from s where entry_screen is not null group by 1 order by 2 desc, 1 limit 10) t), '[]'::jsonb),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'users', u, 'events', n) order by u desc, k) from (
      select name k, count(distinct person_id) u, count(*) n from ev
      where name not in ('session_started', 'page_viewed', 'screen_viewed', 'error_thrown')
      group by 1 order by 2 desc, 1 limit 12) t), '[]'::jsonb),
    'screens', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'users', u, 'views', n) order by u desc, k) from (
      select screen k, count(distinct person_id) u, count(*) n from ev
      where name in ('page_viewed', 'screen_viewed') and screen is not null group by 1 order by 2 desc, 1 limit 12) t), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'users', u, 'events', n) order by u desc, k) from (
      select coalesce(screen, 'Unknown screen') k, count(distinct person_id) u, count(*) n from ev
      where name = 'error_thrown' group by 1 order by 2 desc, 1 limit 8) t), '[]'::jsonb)
  ) into v_breakdowns;

  select jsonb_build_object(
    'excluded_sessions', count(*) filter (where kma_internal.analytics_session_excluded(s)),
    'flagged_sessions', count(*) filter (where cardinality(s.bot_reasons) > 0),
    'sessions', count(*)
  ) into v_bots
  from public.analytics_sessions s
  where s.project_id = p_project and s.environment = 'production' and s.started_at >= w.from_at and s.started_at < w.to_at;

  return jsonb_build_object(
    'range', jsonb_build_object('key', p_range, 'from', w.from_at, 'to', w.to_at, 'prev_from', w.prev_from,
      'prev_to', w.prev_to, 'bucket', w.bucket, 'timezone', v.timezone),
    'current', kma_internal.analytics_kpis(p_project, w.from_at, w.to_at, v.timezone),
    'previous', kma_internal.analytics_kpis(p_project, w.prev_from, w.prev_to, v.timezone),
    'comparable', v.created_at <= w.prev_from or exists (
      select 1 from public.analytics_sessions s where s.project_id = p_project and s.started_at < w.prev_from + interval '1 hour'),
    'online_now', (select count(distinct s.person_id) from public.analytics_sessions s
      where s.project_id = p_project and s.environment = 'production' and s.ended_at >= now() - interval '5 minutes'
      and not kma_internal.analytics_session_excluded(s)),
    'series', v_series,
    'breakdowns', v_breakdowns,
    'bots', v_bots,
    'last_event_at', (select max(received_at) from public.analytics_events where project_id = p_project),
    'has_data', exists (select 1 from public.analytics_events where project_id = p_project),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('platform', platform, 'environment', environment, 'last_seen', last_seen)
      order by platform, environment) from (
      select s.platform, s.environment, max(s.ended_at) last_seen from public.analytics_sessions s where s.project_id = p_project
      group by s.platform, s.environment) t), '[]'::jsonb)
  );
end $$;

create function public.analytics_online(p_project uuid, p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_project(p_project);
  return coalesce((
    select jsonb_agg(row_data order by (row_data->>'last_seen') desc) from (
      select distinct on (s.person_id) jsonb_build_object(
        'person_id', s.person_id, 'distinct_id', p.distinct_id, 'user_id', p.user_id, 'traits', p.traits,
        'session_id', s.id, 'started_at', s.started_at, 'last_seen', s.ended_at,
        'platform', s.platform, 'country', s.country, 'city', s.city, 'device_model', s.device_model,
        'device_type', s.device_type, 'os_name', s.os_name, 'browser', s.browser, 'app_version', s.app_version,
        'screen', (select e.screen from public.analytics_events e where e.session_id = s.id and e.screen is not null order by e.occurred_at desc limit 1),
        'events_count', s.events_count
      ) as row_data
      from public.analytics_sessions s join public.analytics_people p on p.id = s.person_id
      where s.project_id = p_project and s.environment = 'production' and s.ended_at >= now() - interval '5 minutes'
        and not kma_internal.analytics_session_excluded(s)
      order by s.person_id, s.ended_at desc
      limit greatest(1, least(coalesce(p_limit, 20), 200))
    ) t), '[]'::jsonb);
end $$;

create function public.analytics_people_page(p_project uuid, p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  w record;
  v_search text := nullif(btrim(coalesce(p_query->>'search', '')), '');
  v_status text := coalesce(p_query->>'status', 'all');
  v_platform text := nullif(p_query->>'platform', '');
  v_country text := nullif(p_query->>'country', '');
  v_sort text := coalesce(p_query->>'sort', 'last_seen');
  v_desc boolean := coalesce(p_query->>'direction', 'desc') = 'desc';
  v_limit integer := greatest(1, least(coalesce((p_query->>'limit')::integer, 50), 1000));
  v_offset integer := greatest(0, coalesce((p_query->>'offset')::integer, 0));
  v_result jsonb;
begin
  select * into w from kma_internal.analytics_window(coalesce(p_query->>'range', '30d'), v.timezone);
  if v_status not in ('all', 'online', 'new', 'returning') or v_sort not in ('last_seen', 'first_seen', 'sessions', 'events') then
    raise exception 'Unknown filter' using errcode = '22023';
  end if;
  with active as (
    select s.person_id, count(*) sessions_in_range
    from kma_internal.analytics_report_sessions(p_project, w.from_at, w.to_at) s
    group by s.person_id
  ), matched as (
    -- A search looks through everyone the project has seen; otherwise the people active in the range.
    select p.id, p.last_seen, p.first_seen, p.sessions_count, p.events_count, p.platform, p.country,
      coalesce(a.sessions_in_range, 0) sessions_in_range,
      exists (select 1 from public.analytics_sessions s where s.person_id = p.id and s.ended_at >= now() - interval '5 minutes') online
    from public.analytics_people p left join active a on a.person_id = p.id
    where p.project_id = p_project and (a.person_id is not null or v_search is not null)
      and (v_search is null or p.distinct_id ilike '%' || v_search || '%' or p.user_id ilike '%' || v_search || '%'
        or p.traits->>'email' ilike '%' || v_search || '%' or p.traits->>'name' ilike '%' || v_search || '%'
        or exists (select 1 from unnest(p.anonymous_ids) x where x ilike '%' || v_search || '%'))
      and (v_status <> 'new' or p.first_seen >= w.from_at)
      and (v_status <> 'returning' or p.first_seen < w.from_at)
  ), filtered as (
    select * from matched
    where (v_status <> 'online' or online)
      and (v_platform is null or platform = v_platform)
      and (v_country is null or country = v_country)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'range', jsonb_build_object('key', coalesce(p_query->>'range', '30d'), 'from', w.from_at, 'to', w.to_at),
    'facets', jsonb_build_object(
      'platforms', coalesce((select jsonb_agg(distinct platform) from matched where platform is not null), '[]'::jsonb),
      'countries', coalesce((select jsonb_agg(distinct country) from matched where country is not null), '[]'::jsonb)),
    'rows', coalesce((select jsonb_agg(kma_internal.analytics_person_view(p)
        || jsonb_build_object('sessions_in_range', f.sessions_in_range) order by f.ord)
      from (select id, sessions_in_range, row_number() over (order by
        case when v_sort = 'last_seen' and v_desc then last_seen end desc nulls last,
        case when v_sort = 'last_seen' and not v_desc then last_seen end asc nulls last,
        case when v_sort = 'first_seen' and v_desc then first_seen end desc nulls last,
        case when v_sort = 'first_seen' and not v_desc then first_seen end asc nulls last,
        case when v_sort = 'sessions' and v_desc then sessions_count end desc nulls last,
        case when v_sort = 'sessions' and not v_desc then sessions_count end asc nulls last,
        case when v_sort = 'events' and v_desc then events_count end desc nulls last,
        case when v_sort = 'events' and not v_desc then events_count end asc nulls last,
        last_seen desc, id) ord
        from filtered order by ord limit v_limit offset v_offset) f
      join public.analytics_people p on p.id = f.id), '[]'::jsonb)
  ) into v_result;
  return v_result;
end $$;

create function public.analytics_person(p_project uuid, p_person uuid) returns jsonb
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
      from (select * from public.analytics_events where person_id = p_person order by occurred_at desc, id desc limit 50) e), '[]'::jsonb)
  );
end $$;

create function public.analytics_sessions_page(p_project uuid, p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  w record;
  v_platform text := nullif(p_query->>'platform', '');
  v_country text := nullif(p_query->>'country', '');
  v_person uuid := nullif(p_query->>'person_id', '')::uuid;
  v_replay boolean := coalesce((p_query->>'replay_only')::boolean, false);
  v_live boolean := coalesce((p_query->>'live_only')::boolean, false);
  v_min integer := greatest(0, coalesce((p_query->>'min_seconds')::integer, 0));
  v_bots text := coalesce(p_query->>'bots', 'exclude');
  v_search text := nullif(btrim(coalesce(p_query->>'search', '')), '');
  v_limit integer := greatest(1, least(coalesce((p_query->>'limit')::integer, 50), 1000));
  v_offset integer := greatest(0, coalesce((p_query->>'offset')::integer, 0));
  v_result jsonb;
begin
  select * into w from kma_internal.analytics_window(coalesce(p_query->>'range', '7d'), v.timezone);
  if v_bots not in ('exclude', 'include', 'only') then
    raise exception 'Unknown filter' using errcode = '22023';
  end if;
  with matched as (
    select s.id, s.started_at, s.platform, s.country, kma_internal.analytics_session_excluded(s) excluded
    from public.analytics_sessions s join public.analytics_people p on p.id = s.person_id
    where s.project_id = p_project and s.environment = 'production'
      and s.started_at >= w.from_at and s.started_at < w.to_at
      and (v_person is null or s.person_id = v_person)
      and (not v_replay or s.replay_chunks > 0)
      and (not v_live or s.ended_at >= now() - interval '5 minutes')
      and extract(epoch from (s.ended_at - s.started_at)) >= v_min
      and (v_search is null or p.distinct_id ilike '%' || v_search || '%' or p.traits->>'email' ilike '%' || v_search || '%'
        or p.traits->>'name' ilike '%' || v_search || '%' or s.entry_screen ilike '%' || v_search || '%'
        or s.exit_screen ilike '%' || v_search || '%')
  ), botted as (
    select * from matched
    where (v_bots = 'include') or (v_bots = 'exclude' and not excluded) or (v_bots = 'only' and excluded)
  ), filtered as (
    select * from botted where (v_platform is null or platform = v_platform) and (v_country is null or country = v_country)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'range', jsonb_build_object('key', coalesce(p_query->>'range', '7d'), 'from', w.from_at, 'to', w.to_at),
    'facets', jsonb_build_object(
      'platforms', coalesce((select jsonb_agg(distinct platform) from botted), '[]'::jsonb),
      'countries', coalesce((select jsonb_agg(distinct country) from botted where country is not null), '[]'::jsonb)),
    'rows', coalesce((select jsonb_agg(kma_internal.analytics_session_view(s)
        || jsonb_build_object('distinct_id', p.distinct_id, 'user_id', p.user_id, 'traits', p.traits) order by s.started_at desc, s.id)
      from (select id from filtered order by started_at desc, id limit v_limit offset v_offset) f
      join public.analytics_sessions s on s.id = f.id
      join public.analytics_people p on p.id = s.person_id), '[]'::jsonb)
  ) into v_result;
  return v_result;
end $$;

create function public.analytics_session(p_project uuid, p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_session public.analytics_sessions;
begin
  perform kma_internal.analytics_require_project(p_project);
  select * into v_session from public.analytics_sessions where id = p_session and project_id = p_project;
  if v_session.id is null then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'session', kma_internal.analytics_session_view(v_session),
    'person', (select kma_internal.analytics_person_view(p) from public.analytics_people p where p.id = v_session.person_id),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'time', e.occurred_at,
        'screen', e.screen, 'properties', e.properties) order by e.occurred_at, e.id)
      from (select * from public.analytics_events where session_id = p_session order by occurred_at, id limit 2000) e), '[]'::jsonb),
    'replay', jsonb_build_object('chunks', v_session.replay_chunks, 'bytes', v_session.replay_bytes)
  );
end $$;

create function public.analytics_session_replay(p_project uuid, p_session uuid, p_from_seq integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_next integer;
begin
  perform kma_internal.analytics_require_project(p_project);
  if not exists (select 1 from public.analytics_sessions where id = p_session and project_id = p_project) then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  select min(seq) into v_next from (
    select seq, sum(bytes) over (order by seq) running from public.analytics_replay_chunks
    where session_id = p_session and seq >= coalesce(p_from_seq, 0)
  ) t where running > 4 * 1024 * 1024;
  return jsonb_build_object(
    'chunks', coalesce((select jsonb_agg(jsonb_build_object('seq', c.seq, 'events', c.events) order by c.seq)
      from public.analytics_replay_chunks c
      where c.session_id = p_session and c.seq >= coalesce(p_from_seq, 0) and (v_next is null or c.seq < v_next)), '[]'::jsonb),
    'next_seq', v_next
  );
end $$;

create function public.analytics_events_catalog(p_project uuid, p_range text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  w record;
  v_users integer;
begin
  select * into w from kma_internal.analytics_window(p_range, v.timezone);
  select count(distinct person_id) into v_users from kma_internal.analytics_report_sessions(p_project, w.from_at, w.to_at);
  return jsonb_build_object(
    'active_users', v_users,
    'events', coalesce((
      with cur as (
        select e.name, count(distinct e.person_id) users, count(*) events
        from public.analytics_events e
        left join public.analytics_sessions s on s.id = e.session_id
        where e.project_id = p_project and e.environment = 'production' and e.occurred_at >= w.from_at and e.occurred_at < w.to_at
          and (s.id is null or not kma_internal.analytics_session_excluded(s))
        group by e.name
      ), prev as (
        select e.name, count(distinct e.person_id) users, count(*) events
        from public.analytics_events e
        left join public.analytics_sessions s on s.id = e.session_id
        where e.project_id = p_project and e.environment = 'production' and e.occurred_at >= w.prev_from and e.occurred_at < w.prev_to
          and (s.id is null or not kma_internal.analytics_session_excluded(s))
        group by e.name
      )
      select jsonb_agg(jsonb_build_object(
        'name', d.name, 'status', d.status, 'description', d.description, 'first_seen', d.first_seen, 'last_seen', d.last_seen,
        'users', coalesce(c.users, 0), 'events', coalesce(c.events, 0),
        'users_prev', coalesce(pv.users, 0), 'events_prev', coalesce(pv.events, 0),
        'comparable', d.first_seen <= w.prev_from
      ) order by coalesce(c.users, 0) desc, d.name)
      from public.analytics_event_definitions d
      left join cur c on c.name = d.name left join prev pv on pv.name = d.name
      where d.project_id = p_project), '[]'::jsonb)
  );
end $$;

create function public.analytics_event(p_project uuid, p_name text, p_range text, p_breakdown text default 'none') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  w record;
  v_def public.analytics_event_definitions;
  v_series_from timestamptz;
begin
  select * into w from kma_internal.analytics_window(p_range, v.timezone);
  select min(bucket_start) into v_series_from from kma_internal.analytics_buckets(p_range, v.timezone);
  select * into v_def from public.analytics_event_definitions where project_id = p_project and name = p_name;
  if v_def.name is null then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  if p_breakdown not in ('none', 'platform', 'country', 'app_version', 'browser') then
    raise exception 'Unknown breakdown' using errcode = '22023';
  end if;
  return (
    with base as (
      select e.id, e.person_id, e.session_id, e.occurred_at, e.properties, s.platform, s.country, s.app_version, s.browser,
        case p_breakdown
          when 'platform' then coalesce(s.platform, 'server')
          when 'country' then coalesce(s.country, 'Unknown')
          when 'app_version' then coalesce(s.app_version, 'Unknown')
          when 'browser' then coalesce(s.browser, 'Unknown')
          else 'all' end as key
      from public.analytics_events e
      left join public.analytics_sessions s on s.id = e.session_id
      where e.project_id = p_project and e.name = p_name and e.environment = 'production'
        and e.occurred_at >= least(w.from_at, v_series_from) and e.occurred_at < w.to_at
        and (s.id is null or not kma_internal.analytics_session_excluded(s))
    ), ev as (
      select * from base where occurred_at >= w.from_at
    ), top_keys as (
      select key from ev group by key order by count(distinct person_id) desc, key limit 5
    )
    select jsonb_build_object(
      'definition', jsonb_build_object('name', v_def.name, 'status', v_def.status, 'description', v_def.description,
        'first_seen', v_def.first_seen, 'last_seen', v_def.last_seen),
      'range', jsonb_build_object('key', p_range, 'from', w.from_at, 'to', w.to_at, 'bucket', w.bucket, 'timezone', v.timezone),
      'totals', (select jsonb_build_object('users', count(distinct person_id), 'events', count(*), 'sessions', count(distinct session_id)) from ev),
      'active_users', (select count(distinct person_id) from kma_internal.analytics_report_sessions(p_project, w.from_at, w.to_at)),
      'keys', coalesce((select jsonb_agg(key order by key) from top_keys), '[]'::jsonb),
      'series', coalesce((select jsonb_agg(jsonb_build_object(
          'start', b.bucket_start, 'partial', b.bucket_end > now(),
          'users', coalesce((select jsonb_object_agg(t.key, (select count(distinct x.person_id) from base x
            where x.key = t.key and x.occurred_at >= b.bucket_start and x.occurred_at < b.bucket_end)) from top_keys t), '{}'::jsonb),
          'events', coalesce((select jsonb_object_agg(t.key, (select count(*) from base x
            where x.key = t.key and x.occurred_at >= b.bucket_start and x.occurred_at < b.bucket_end)) from top_keys t), '{}'::jsonb)
        ) order by b.bucket_start) from kma_internal.analytics_buckets(p_range, v.timezone) b), '[]'::jsonb),
      'breakdown', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'users', users, 'events', events) order by users desc, key)
        from (select key, count(distinct person_id) users, count(*) events from ev group by key order by count(distinct person_id) desc, key limit 20) t), '[]'::jsonb),
      'properties', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'seen', seen, 'types', types, 'values', vals) order by seen desc, k)
        from (
          select k, count(*) seen, jsonb_agg(distinct t) types,
            (select jsonb_agg(jsonb_build_object('value', val, 'count', c) order by c desc, val) from (
              select r.properties->>k val, count(*) c from (select properties from ev order by occurred_at desc limit 1000) r
              where r.properties ? k group by r.properties->>k order by count(*) desc, 1 limit 6) vv) vals
          from (select key k, jsonb_typeof(value) t from (select properties from ev order by occurred_at desc limit 1000) r, jsonb_each(r.properties)) kv
          group by k order by count(*) desc, k limit 30) props), '[]'::jsonb),
      'sample_size', (select least(count(*), 1000) from ev),
      'recent', coalesce((select jsonb_agg(row_data order by (row_data->>'time') desc) from (
        select jsonb_build_object('id', ev.id, 'time', ev.occurred_at, 'person_id', ev.person_id, 'distinct_id', p.distinct_id,
          'traits', p.traits, 'session_id', ev.session_id, 'platform', ev.platform, 'country', ev.country,
          'properties', ev.properties) row_data
        from ev join public.analytics_people p on p.id = ev.person_id order by ev.occurred_at desc limit 25) t), '[]'::jsonb)
    )
  );
end $$;

create function public.analytics_set_event(p_project uuid, p_name text, p_status text, p_description text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_def public.analytics_event_definitions;
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  if p_status not in ('live', 'blocked') or length(coalesce(p_description, '')) > 200 then
    raise exception 'Invalid event settings' using errcode = '22023';
  end if;
  update public.analytics_event_definitions
  set status = p_status, description = coalesce(nullif(btrim(p_description), ''), description)
  where project_id = p_project and name = p_name returning * into v_def;
  if v_def.name is null then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('name', v_def.name, 'status', v_def.status, 'description', v_def.description);
end $$;

create function public.analytics_live(p_project uuid, p_after bigint default null, p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_project(p_project);
  return coalesce((
    select jsonb_agg(row_data order by (row_data->>'id')::bigint desc) from (
      select jsonb_build_object(
        'id', e.id, 'name', e.name, 'time', e.occurred_at, 'received_at', e.received_at, 'screen', e.screen,
        'properties', e.properties, 'environment', e.environment,
        'person_id', e.person_id, 'distinct_id', p.distinct_id, 'traits', p.traits,
        'session_id', e.session_id, 'platform', coalesce(s.platform, 'server'), 'country', s.country, 'city', s.city,
        'device_model', s.device_model, 'device_type', s.device_type, 'os_name', s.os_name, 'os_version', s.os_version,
        'browser', s.browser, 'app_version', s.app_version,
        'bot', s.id is not null and kma_internal.analytics_session_excluded(s)
      ) row_data
      from public.analytics_events e
      join public.analytics_people p on p.id = e.person_id
      left join public.analytics_sessions s on s.id = e.session_id
      where e.project_id = p_project and (p_after is null or e.id > p_after)
        and e.received_at >= now() - interval '1 day'
      order by e.id desc
      limit greatest(1, least(coalesce(p_limit, 100), 500))
    ) t), '[]'::jsonb);
end $$;

create function public.analytics_project_status(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_project(p_project);
  return jsonb_build_object(
    'events_total', (select count(*) from public.analytics_events where project_id = p_project),
    'last_event_at', (select max(received_at) from public.analytics_events where project_id = p_project),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('platform', platform, 'environment', environment, 'last_seen', last_seen) order by platform) from (
      select s.platform, s.environment, max(s.ended_at) last_seen from public.analytics_sessions s where s.project_id = p_project
      group by s.platform, s.environment) t), '[]'::jsonb)
  );
end $$;

-- Bots -----------------------------------------------------------------------------------------------

create function public.analytics_bots(p_project uuid, p_range text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.analytics_projects := kma_internal.analytics_require_project(p_project);
  w record;
begin
  select * into w from kma_internal.analytics_window(p_range, v.timezone);
  return (
    with s as (
      select s.*, kma_internal.analytics_session_excluded(s) excluded
      from public.analytics_sessions s
      where s.project_id = p_project and s.environment = 'production' and s.started_at >= w.from_at and s.started_at < w.to_at
    )
    select jsonb_build_object(
      'totals', (select jsonb_build_object(
        'sessions', count(*), 'excluded_sessions', count(*) filter (where excluded),
        'flagged_sessions', count(*) filter (where cardinality(bot_reasons) > 0),
        'excluded_events', coalesce(sum(events_count) filter (where excluded), 0),
        'excluded_people', count(distinct person_id) filter (where excluded)) from s),
      'rules', coalesce((select jsonb_agg(jsonb_build_object('rule', r.rule, 'enabled', r.enabled, 'updated_at', r.updated_at,
          'sessions', (select count(*) from s where r.rule = any(s.bot_reasons))) order by array_position(array['automation', 'crawler', 'too_fast', 'no_interaction'], r.rule))
        from public.analytics_bot_rules r where r.project_id = p_project), '[]'::jsonb),
      'flagged', coalesce((select jsonb_agg(row_data order by (row_data->>'started_at') desc) from (
        select jsonb_build_object('session_id', s.id, 'person_id', s.person_id, 'distinct_id', p.distinct_id,
          'started_at', s.started_at, 'duration_seconds', round(extract(epoch from (s.ended_at - s.started_at)))::integer,
          'reasons', to_jsonb(s.bot_reasons), 'excluded', s.excluded, 'platform', s.platform, 'country', s.country, 'city', s.city,
          'user_agent', s.user_agent, 'browser', s.browser, 'os_name', s.os_name, 'events_count', s.events_count,
          'screens_count', s.screens_count, 'ip_hash', left(s.ip_hash, 10),
          'override', (select o.verdict from public.analytics_bot_overrides o where o.project_id = p_project
            and (o.person_id = s.person_id or o.ip_hash = s.ip_hash) order by o.created_at desc limit 1)) row_data
        from s join public.analytics_people p on p.id = s.person_id
        where cardinality(s.bot_reasons) > 0 or s.excluded
        order by s.started_at desc limit 200) t), '[]'::jsonb),
      'overrides', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'verdict', o.verdict, 'person_id', o.person_id,
          'distinct_id', p.distinct_id, 'ip_hash', left(o.ip_hash, 10), 'note', o.note, 'created_at', o.created_at,
          'created_by', (select coalesce(u.raw_user_meta_data->>'full_name', u.email) from auth.users u where u.id = o.created_by))
          order by o.created_at desc)
        from public.analytics_bot_overrides o left join public.analytics_people p on p.id = o.person_id
        where o.project_id = p_project), '[]'::jsonb)
    )
  );
end $$;

create function public.analytics_set_bot_rule(p_project uuid, p_rule text, p_enabled boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  update public.analytics_bot_rules set enabled = p_enabled, updated_at = now(), updated_by = auth.uid()
  where project_id = p_project and rule = p_rule;
  if not found or p_enabled is null then
    raise exception 'Unknown rule' using errcode = '22023';
  end if;
  return jsonb_build_object('rule', p_rule, 'enabled', p_enabled);
end $$;

create function public.analytics_set_override(p_project uuid, p_verdict text, p_person uuid, p_session uuid default null, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ip text;
  v_id uuid;
begin
  perform kma_internal.analytics_require_project(p_project, 'developer');
  if p_verdict not in ('human', 'bot') or length(coalesce(p_note, '')) > 200 then
    raise exception 'Invalid verdict' using errcode = '22023';
  end if;
  if p_session is not null then
    -- Block the network a session came from.
    if p_verdict <> 'bot' then
      raise exception 'Only blocks apply to a network' using errcode = '22023';
    end if;
    select ip_hash into v_ip from public.analytics_sessions where id = p_session and project_id = p_project;
    if v_ip is null then
      raise exception 'That session has no network to block' using errcode = 'P0002';
    end if;
    insert into public.analytics_bot_overrides(project_id, verdict, ip_hash, note, created_by)
    values (p_project, 'bot', v_ip, nullif(btrim(p_note), ''), auth.uid())
    on conflict (project_id, ip_hash) where ip_hash is not null do update set note = excluded.note
    returning id into v_id;
  else
    if not exists (select 1 from public.analytics_people where id = p_person and project_id = p_project) then
      raise exception 'Person not found' using errcode = 'P0002';
    end if;
    insert into public.analytics_bot_overrides(project_id, verdict, person_id, note, created_by)
    values (p_project, p_verdict, p_person, nullif(btrim(p_note), ''), auth.uid())
    on conflict (project_id, person_id) where person_id is not null
    do update set verdict = excluded.verdict, note = excluded.note, created_at = now(), created_by = excluded.created_by
    returning id into v_id;
  end if;
  return jsonb_build_object('id', v_id, 'verdict', p_verdict);
end $$;

create function public.analytics_delete_override(p_override uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_project uuid;
begin
  select project_id into v_project from public.analytics_bot_overrides where id = p_override;
  if v_project is null then
    raise exception 'Override not found' using errcode = 'P0002';
  end if;
  perform kma_internal.analytics_require_project(v_project, 'developer');
  delete from public.analytics_bot_overrides where id = p_override;
  return jsonb_build_object('deleted', p_override);
end $$;

-- Replays older than 30 days are dropped by the scheduled maintenance job.
create function public.analytics_purge_replays(p_older_than interval default interval '30 days') returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare v_count integer;
begin
  with gone as (
    delete from public.analytics_replay_chunks where received_at < now() - p_older_than returning session_id, bytes
  ), totals as (
    select session_id, count(*) chunks, sum(bytes) bytes from gone group by session_id
  )
  update public.analytics_sessions s set replay_chunks = greatest(0, s.replay_chunks - t.chunks), replay_bytes = greatest(0, s.replay_bytes - t.bytes)
  from totals t where s.id = t.session_id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'analytics_bootstrap(text)', 'analytics_context()', 'analytics_rename_workspace(uuid,text)',
    'analytics_create_project(uuid,text,text[],text)', 'analytics_update_project(uuid,jsonb)',
    'analytics_delete_project(uuid,text)', 'analytics_project_settings(uuid)',
    'analytics_create_key(uuid,text,text,text)', 'analytics_revoke_key(uuid)',
    'analytics_members(uuid)', 'analytics_invite_member(uuid,text,text)', 'analytics_set_member_role(uuid,uuid,text)',
    'analytics_remove_member(uuid,uuid)', 'analytics_cancel_invite(uuid)',
    'analytics_overview(uuid,text)', 'analytics_online(uuid,integer)', 'analytics_people_page(uuid,jsonb)',
    'analytics_person(uuid,uuid)', 'analytics_sessions_page(uuid,jsonb)', 'analytics_session(uuid,uuid)',
    'analytics_session_replay(uuid,uuid,integer)', 'analytics_events_catalog(uuid,text)',
    'analytics_event(uuid,text,text,text)', 'analytics_set_event(uuid,text,text,text)',
    'analytics_live(uuid,bigint,integer)', 'analytics_project_status(uuid)', 'analytics_bots(uuid,text)',
    'analytics_set_bot_rule(uuid,text,boolean)', 'analytics_set_override(uuid,text,uuid,uuid,text)',
    'analytics_delete_override(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  revoke all on function public.analytics_purge_replays(interval) from public, anon, authenticated;
  grant execute on function public.analytics_purge_replays(interval) to service_role;
end $$;

commit;
