import { requireSupabaseClient } from '../lib/supabase'
import { ProgramError, readFailure } from './programs'

export type Platform = 'ios' | 'android' | 'web' | 'server'
export type Role = 'owner' | 'admin' | 'developer' | 'analyst'
export type Range = 'today' | '7d' | '30d' | '90d'
export type KeyKind = 'client' | 'server'
export type KeyEnvironment = 'production' | 'development'
export type BotRule = 'automation' | 'crawler' | 'too_fast' | 'no_interaction'

export type Traits = Record<string, unknown>

export interface Project {
  id: string
  workspace_id: string
  name: string
  platforms: Platform[]
  timezone: string
  allowed_origins: string[]
  replay_enabled: boolean
  created_at: string
  last_event_at?: string | null
  online_now?: number
  users_today?: number
  /** Whether attribution is on for the project. */
  attribution_enabled?: boolean
}

export interface Workspace {
  id: string
  name: string
  role: Role
  projects: Project[]
}

export interface Context {
  user: { id: string; email: string; name: string }
  workspaces: Workspace[]
}

export interface ApiKey {
  id: string
  project_id: string
  name: string
  kind: KeyKind
  environment: KeyEnvironment
  prefix: string
  last4: string
  /** Client keys only; server keys are returned once, when created. */
  token: string | null
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  created_by: string | null
}

export interface Kpis {
  users: number
  new_users: number
  returning_users: number
  sessions: number
  avg_session_seconds: number
  sessions_per_user: number
  events: number
  errors: number
  daily_users: number
}

export interface Ranked {
  key: string
  users: number
  [extra: string]: string | number
}

export interface Overview {
  range: {
    key: Range
    from: string
    to: string
    prev_from: string
    prev_to: string
    bucket: 'hour' | 'day'
    timezone: string
  }
  current: Kpis
  previous: Kpis
  comparable: boolean
  online_now: number
  series: { start: string; users: number; new_users: number; sessions: number; partial: boolean }[]
  breakdowns: {
    countries: Ranked[]
    unknown_country: number
    cities: (Ranked & { country: string })[]
    platforms: Ranked[]
    device_types: Ranked[]
    devices: Ranked[]
    os: Ranked[]
    browsers: Ranked[]
    app_versions: (Ranked & { platform: Platform })[]
    languages: Ranked[]
    referrers: Ranked[]
    entry_screens: { key: string; sessions: number }[]
    actions: (Ranked & { events: number })[]
    screens: (Ranked & { views: number })[]
    errors: (Ranked & { events: number })[]
  }
  bots: { excluded_sessions: number; flagged_sessions: number; sessions: number }
  last_event_at: string | null
  has_data: boolean
  sources: { platform: Platform; environment: KeyEnvironment; last_seen: string }[]
}

export interface Person {
  id: string
  distinct_id: string
  user_id: string | null
  anonymous_ids: string[]
  traits: Traits
  environment: KeyEnvironment
  first_seen: string
  last_seen: string
  platform: Platform | null
  country: string | null
  region: string | null
  city: string | null
  timezone: string | null
  language: string | null
  device_type: string | null
  device_model: string | null
  os_name: string | null
  os_version: string | null
  browser: string | null
  browser_version: string | null
  app_version: string | null
  sdk: string | null
  screen_width: number | null
  screen_height: number | null
  initial_referrer: string | null
  initial_utm_source: string | null
  initial_utm_medium: string | null
  initial_utm_campaign: string | null
  initial_landing: string | null
  sessions_count: number
  events_count: number
  online: boolean
  sessions_in_range?: number
}

export interface Session {
  id: string
  person_id: string
  session_key: string
  environment: KeyEnvironment
  started_at: string
  ended_at: string
  duration_seconds: number
  platform: Platform
  country: string | null
  region: string | null
  city: string | null
  location_source: string | null
  timezone: string | null
  language: string | null
  device_type: string | null
  device_model: string | null
  os_name: string | null
  os_version: string | null
  browser: string | null
  browser_version: string | null
  app_version: string | null
  sdk: string | null
  screen_width: number | null
  screen_height: number | null
  network: string | null
  carrier: string | null
  user_agent: string | null
  referrer: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  landing: string | null
  entry_screen: string | null
  exit_screen: string | null
  screens_count: number
  events_count: number
  errors_count: number
  interactions: number
  bot_reasons: BotRule[]
  excluded: boolean
  has_replay: boolean
  replay_bytes: number
  live: boolean
  distinct_id?: string
  user_id?: string | null
  traits?: Traits
}

export interface EventRow {
  id: number
  name: string
  time: string
  screen: string | null
  properties: Record<string, unknown>
  session_id?: string | null
}

export interface PersonDetail {
  person: Person
  override: { id: string; verdict: 'human' | 'bot'; note: string | null; created_at: string } | null
  stats: {
    sessions: number
    total_seconds: number
    avg_seconds: number
    replays: number
    countries: string[]
    devices: string[]
    bot_sessions: number
  }
  sessions: Session[]
  top_events: { name: string; count: number; last: string }[]
  recent_events: EventRow[]
  /** Where an app install came from; null without one, missing from older databases. */
  acquisition?: Acquisition | null
}

export interface SessionDetail {
  session: Session
  person: Person
  events: EventRow[]
  replay: { chunks: number; bytes: number }
}

export interface Page<T> {
  total: number
  range: { key: Range; from: string; to: string }
  facets: {
    platforms: Platform[]
    countries: string[]
    /** The chosen country's regions and cities, on the Users list only. */
    places?: { region: string | null; city: string | null }[]
  }
  rows: T[]
}

/** Where the people in a range were: a country's regions and cities, or every city. */
export interface Places {
  range: { key: Range; from: string; to: string }
  country: string | null
  users: number
  unknown_region: number
  unknown_city: number
  regions: Ranked[]
  cities: { key: string; region: string | null; country: string; users: number }[]
}

export interface PeopleQuery {
  range: Range
  search?: string
  status?: 'all' | 'online' | 'new' | 'returning'
  platform?: string
  country?: string
  /** Region and city need a country. */
  region?: string
  city?: string
  sort?: 'last_seen' | 'first_seen' | 'sessions' | 'events'
  direction?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface SessionsQuery {
  range: Range
  search?: string
  platform?: string
  country?: string
  person_id?: string
  replay_only?: boolean
  live_only?: boolean
  min_seconds?: number
  bots?: 'exclude' | 'include' | 'only'
  limit?: number
  offset?: number
}

export interface CatalogEvent {
  name: string
  status: 'live' | 'blocked'
  description: string | null
  first_seen: string
  last_seen: string
  users: number
  events: number
  users_prev: number
  events_prev: number
  comparable: boolean
}

export type Breakdown = 'none' | 'platform' | 'country' | 'app_version' | 'browser'

export interface EventDetail {
  definition: {
    name: string
    status: 'live' | 'blocked'
    description: string | null
    first_seen: string
    last_seen: string
  }
  range: { key: Range; from: string; to: string; bucket: 'hour' | 'day'; timezone: string }
  totals: { users: number; events: number; sessions: number }
  active_users: number
  keys: string[]
  series: {
    start: string
    partial: boolean
    users: Record<string, number>
    events: Record<string, number>
  }[]
  breakdown: { key: string; users: number; events: number }[]
  properties: {
    key: string
    seen: number
    types: string[]
    values: { value: string | null; count: number }[] | null
  }[]
  sample_size: number
  recent: {
    id: number
    time: string
    person_id: string
    distinct_id: string
    user_id: string | null
    traits: Traits
    session_id: string | null
    platform: Platform | null
    country: string | null
    properties: Record<string, unknown>
  }[]
}

export interface LiveEvent {
  id: number
  name: string
  time: string
  received_at: string
  screen: string | null
  properties: Record<string, unknown>
  environment: KeyEnvironment
  person_id: string
  distinct_id: string
  user_id: string | null
  traits: Traits
  session_id: string | null
  platform: Platform
  country: string | null
  city: string | null
  device_model: string | null
  device_type: string | null
  os_name: string | null
  os_version: string | null
  browser: string | null
  app_version: string | null
  bot: boolean
}

export interface OnlinePerson {
  person_id: string
  distinct_id: string
  user_id: string | null
  traits: Traits
  session_id: string
  started_at: string
  last_seen: string
  platform: Platform
  country: string | null
  city: string | null
  device_model: string | null
  device_type: string | null
  os_name: string | null
  browser: string | null
  app_version: string | null
  screen: string | null
  events_count: number
}

export interface BotsReport {
  totals: {
    sessions: number
    excluded_sessions: number
    flagged_sessions: number
    excluded_events: number
    excluded_people: number
  }
  rules: { rule: BotRule; enabled: boolean; updated_at: string; sessions: number }[]
  flagged: {
    session_id: string
    person_id: string
    distinct_id: string
    user_id: string | null
    traits: Traits
    started_at: string
    duration_seconds: number
    reasons: BotRule[]
    excluded: boolean
    platform: Platform
    country: string | null
    city: string | null
    user_agent: string | null
    browser: string | null
    os_name: string | null
    events_count: number
    screens_count: number
    ip_hash: string | null
    override: 'human' | 'bot' | null
  }[]
  overrides: {
    id: string
    verdict: 'human' | 'bot'
    person_id: string | null
    distinct_id: string | null
    ip_hash: string | null
    note: string | null
    created_at: string
    created_by: string | null
  }[]
}

export interface ProjectStatus {
  events_total: number
  last_event_at: string | null
  sources: { platform: Platform; environment: KeyEnvironment; last_seen: string }[]
}

export interface Members {
  role: Role
  members: {
    user_id: string
    email: string
    name: string
    role: Role
    joined_at: string
    last_sign_in_at: string | null
    is_you: boolean
  }[]
  invites: { id: string; email: string; role: Exclude<Role, 'owner'>; created_at: string }[]
}

export type FunnelMatch = 'is' | 'starts_with' | 'contains'

export type FunnelStep = (
  { kind: 'event'; event: string } | { kind: 'screen'; match: FunnelMatch; value: string }
) & { label?: string; filter?: { property: string; value: string } }

/** How long after the first step a person has to finish: 30 min, 1 h, 1 day, 7 or 30 days. */
export type FunnelWindow = 1800 | 3600 | 86400 | 604800 | 2592000

export type FunnelBreakdown = 'none' | 'country' | 'device' | 'platform' | 'browser' | 'source'

export interface FunnelDefinition {
  steps: FunnelStep[]
  window_seconds: FunnelWindow
}

export interface Funnel extends FunnelDefinition {
  id: string
  name: string
  created_at: string
  updated_at: string
  created_by: string | null
}

export interface FunnelOptions {
  events: { name: string; description: string | null; last_seen: string }[]
  screens: { screen: string; users: number }[]
  /** Per event: its common property keys, each with its frequent values. */
  properties: Record<string, { key: string; values: string[] | null }[]>
}

export interface FunnelReport {
  range: { key: Range; from: string; to: string; bucket: 'hour' | 'day'; timezone: string }
  window_seconds: FunnelWindow
  steps: {
    index: number
    step: FunnelStep
    people: number
    from_start: number | null
    from_previous: number | null
    /** People who reached this step and went no further; null on the last step. */
    dropped: number | null
    median_seconds: number | null
  }[]
  started: number
  converted: number
  series: { start: string; partial: boolean; started: number; converted: number }[]
  /** The ten largest groups, each with how many reached every step. */
  breakdown: { key: string; steps: number[] }[]
  other_groups: number
}

export interface FunnelPerson {
  id: string
  distinct_id: string
  user_id: string | null
  traits: Traits
  country: string | null
  city: string | null
  platform: Platform | null
  device_type: string | null
  last_seen: string
  /** When they did the chosen step, and in which session. */
  at: string
  session_id: string | null
  replay: boolean
}

export type RetentionInterval = 'day' | 'week' | 'month'

export interface RetentionDefinition {
  interval: RetentionInterval
  /** When people start: their first visit, or the first time they do a step. */
  start: { kind: 'first_seen' } | FunnelStep
  /** What counts as coming back: any activity, or doing a step. */
  return: { kind: 'any' } | FunnelStep
}

export interface RetentionReport {
  definition: RetentionDefinition
  timezone: string
  today: string
  periods: number
  started: number
  /** Day 1, 7 and 30, over everyone who started in the last 90 days and has reached that day. */
  headline: { day: number; people: number; returned: number }[]
  cohorts: {
    start: string
    people: number
    /** Future periods have no count; the period in progress is partial. */
    values: { period: number; state: 'complete' | 'partial' | 'future'; people: number | null }[]
  }[]
  /** Per period, across the cohorts that have finished it. */
  curve: { period: number; people: number; returned: number }[]
  breakdown: {
    key: string
    people: number
    values: { period: number; people: number; returned: number }[]
  }[]
  other_groups: number
}

export interface RetentionPerson {
  id: string
  distinct_id: string
  user_id: string | null
  traits: Traits
  country: string | null
  city: string | null
  platform: Platform | null
  device_type: string | null
  started_at: string
  last_seen: string
  /** Days they came back on, after the day they started. */
  days_back: number
}

export interface RetentionSummary {
  day: number
  from: string
  to: string
  people: number
  returned: number
}

export type AttributionStep = 'apps' | 'domain' | 'sdk' | 'conversions' | 'partners' | 'skan'

export interface AttributionDomain {
  id: string
  host: string
  /** kma: the project's subdomain of the link root. custom: a domain of the merchant's own. */
  kind: 'kma' | 'custom'
  /** A custom domain is live once a request for it has reached KissMyApps over HTTPS. */
  status: 'live' | 'waiting'
  verified_at: string | null
  last_seen_at: string | null
  created_at: string
}

export interface AttributionSettings {
  ios_app_store_id: string | null
  ios_bundle_id: string | null
  ios_team_id: string | null
  android_package: string | null
  android_sha256: string[]
  web_url: string | null
  click_lookback_days: number
  view_through_enabled: boolean
  view_lookback_hours: number
  reengagement_days: number
  reattribution_days: number
  currency: string
  /** The events that count as conversions in the attribution reports. */
  conversion_events: string[]
  /** How many days a website visit's source counts for a later conversion. */
  web_lookback_days: number
  /**
   * iPhone: a link's page copies the click before opening the App Store, so the app can match
   * the install on its first launch. Missing from a database older than app installs.
   */
  ios_clipboard_handoff?: boolean
  enabled_at: string
  disabled_at: string | null
  updated_at: string
}

export type AttributionPatch = Partial<
  Omit<
    AttributionSettings,
    'enabled_at' | 'disabled_at' | 'updated_at' | 'conversion_events' | 'web_lookback_days'
  >
>

export interface Attribution {
  project_id: string
  enabled: boolean
  /** Turned on at some point: settings and domains are kept while it is off. */
  ever_enabled: boolean
  /** The domain project subdomains are made under, such as go.kissmyapps.dev. */
  link_root: string
  /** Where a merchant's own domain points its CNAME record. */
  cname_target: string
  settings: AttributionSettings | null
  domains: AttributionDomain[]
  /** The project's events, newest first, to choose conversions from. */
  events: Array<{ name: string; last_seen: string }>
  /** sdk: true once the first app install has arrived. */
  setup: Record<AttributionStep, boolean>
  /** App installs matched so far. Missing from a database older than app installs. */
  installs?: { total: number; last_at: string | null }
}

export interface AttributionLink {
  id: string
  /** The part after the domain. */
  path: string
  /** The link on the project's main link domain; null when it has none live. */
  url: string | null
  name: string
  source: string
  campaign: string | null
  channel: string | null
  adset: string | null
  ad: string | null
  deep_link_value: string | null
  deep_link_params: Record<string, string>
  web_url: string | null
  ios_url: string | null
  android_url: string | null
  social_title: string | null
  social_description: string | null
  social_image: string | null
  status: 'active' | 'paused'
  created_at: string
  updated_at: string
  /** In the report's range. */
  clicks?: number
  visits?: number
  conversions?: number
  /** App installs and re-engagements the link brought in the range; missing from older databases. */
  installs?: number
  reengagements?: number
}

export type AttributionLinkFields = Partial<
  Pick<
    AttributionLink,
    | 'path'
    | 'name'
    | 'source'
    | 'campaign'
    | 'channel'
    | 'adset'
    | 'ad'
    | 'deep_link_value'
    | 'deep_link_params'
    | 'web_url'
    | 'ios_url'
    | 'android_url'
    | 'social_title'
    | 'social_description'
    | 'social_image'
  >
>

export interface AttributionLinks {
  range: Range
  /** The domain links are shown on. */
  host: string | null
  /** Every live domain the links work on. */
  hosts: string[]
  links: AttributionLink[]
}

/** last: the latest visit with a source before the conversion. first: the person's first. */
export type AttributionModel = 'last' | 'first'

export interface SourceRow {
  /** A media source, or a campaign within one; null for direct visits and conversions. */
  key: string | null
  clicks: number
  visits: number
  people: number
  conversions: number
  converters: number
  /** Counted app installs (rejected ones never count); missing from older databases. */
  installs?: number
}

export interface AttributionSources {
  range: Range
  model: AttributionModel
  source: string | null
  conversion_events: string[]
  web_lookback_days: number
  totals: {
    clicks: number
    visits: number
    people: number
    conversions: number
    converters: number
    installs?: number
  }
  rows: SourceRow[]
}

/** How an app install was matched to the click that brought it. */
export type InstallMethod =
  'link_open' | 'install_referrer' | 'apple_ads' | 'clipboard' | 'login' | 'organic' | 'reinstall'

/** What `attribution_test_device` saw for one link over the last 30 minutes. */
export interface AttributionTestDevice {
  link: { id: string; url: string | null }
  click: { at: string; platform: 'ios' | 'android' | 'desktop' } | null
  install: { at: string; method: InstallMethod; platform: 'ios' | 'android'; exact: boolean } | null
  deep_link_delivered: boolean
}

/** Where a person who installed the app came from. */
export interface Acquisition {
  source: string | null
  campaign: string | null
  method: InstallMethod
  exact: boolean
  installed_at: string | null
  link_name: string | null
  /** counted; flagged (counts, marked for review); rejected (never counts). */
  verdict: 'counted' | 'flagged' | 'rejected'
}

export interface SubdomainCheck {
  subdomain: string
  host: string
  available: boolean
  reason: string | null
}

export class ApiError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

const friendly: Record<string, string> = {
  '42501': 'Your role cannot make this change.',
  P0002: 'This was not found. It may have been deleted.',
  PGRST301: 'Your session has expired. Sign in again.',
  PGRST303: 'Your session has expired. Sign in again.',
}

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await requireSupabaseClient().rpc(name, args)
  if (error) {
    // Database checks raise messages written for people (22023, 23505, 54000); others get a plain one.
    const ownMessage = ['22023', '23505', '54000', '42501', 'P0002'].includes(error.code ?? '')
    const message =
      ownMessage && error.message && !/^(permission denied|new row violates)/i.test(error.message)
        ? error.message
        : (friendly[error.code ?? ''] ?? 'Something went wrong. Try again.')
    throw new ApiError(message, error.code)
  }
  return data as T
}

export const api = {
  bootstrap: () => rpc<Context>('analytics_bootstrap'),
  context: () => rpc<Context>('analytics_context'),
  renameWorkspace: (workspace: string, name: string) =>
    rpc<Context>('analytics_rename_workspace', { p_workspace: workspace, p_name: name }),
  createProject: (workspace: string, name: string, platforms: Platform[], timezone: string) =>
    rpc<{ project: Project; key: ApiKey }>('analytics_create_project', {
      p_workspace: workspace,
      p_name: name,
      p_platforms: platforms,
      p_timezone: timezone,
    }),
  updateProject: (
    project: string,
    patch: Partial<
      Pick<Project, 'name' | 'platforms' | 'timezone' | 'allowed_origins' | 'replay_enabled'>
    >,
  ) => rpc<Project>('analytics_update_project', { p_project: project, p_patch: patch }),
  deleteProject: (project: string, confirmName: string) =>
    rpc<{ deleted: string }>('analytics_delete_project', {
      p_project: project,
      p_confirm_name: confirmName,
    }),
  projectSettings: (project: string) =>
    rpc<{ project: Project; role: Role; keys: ApiKey[] }>('analytics_project_settings', {
      p_project: project,
    }),
  createKey: (project: string, name: string, kind: KeyKind, environment: KeyEnvironment) =>
    rpc<ApiKey & { token: string }>('analytics_create_key', {
      p_project: project,
      p_name: name,
      p_kind: kind,
      p_environment: environment,
    }),
  revokeKey: (key: string) => rpc<ApiKey>('analytics_revoke_key', { p_key: key }),
  members: (workspace: string) => rpc<Members>('analytics_members', { p_workspace: workspace }),
  inviteMember: (workspace: string, email: string, role: Exclude<Role, 'owner'>) =>
    rpc<Members>('analytics_invite_member', {
      p_workspace: workspace,
      p_email: email,
      p_role: role,
    }),
  setMemberRole: (workspace: string, user: string, role: Exclude<Role, 'owner'>) =>
    rpc<Members>('analytics_set_member_role', {
      p_workspace: workspace,
      p_user: user,
      p_role: role,
    }),
  removeMember: (workspace: string, user: string) =>
    rpc<Members>('analytics_remove_member', { p_workspace: workspace, p_user: user }),
  cancelInvite: (invite: string) => rpc<Members>('analytics_cancel_invite', { p_invite: invite }),
  overview: (project: string, range: Range) =>
    rpc<Overview>('analytics_overview', { p_project: project, p_range: range }),
  online: (project: string, limit = 20) =>
    rpc<OnlinePerson[]>('analytics_online', { p_project: project, p_limit: limit }),
  people: (project: string, query: PeopleQuery) =>
    rpc<Page<Person>>('analytics_people_page', { p_project: project, p_query: query }),
  person: (project: string, person: string) =>
    rpc<PersonDetail>('analytics_person', { p_project: project, p_person: person }),
  sessions: (project: string, query: SessionsQuery) =>
    rpc<Page<Session>>('analytics_sessions_page', { p_project: project, p_query: query }),
  session: (project: string, session: string) =>
    rpc<SessionDetail>('analytics_session', { p_project: project, p_session: session }),
  replay: (project: string, session: string, fromSeq = 0) =>
    rpc<{
      chunks: { seq: number; first_ts: number; events: unknown[] }[]
      next_seq: number | null
    }>('analytics_session_replay', {
      p_project: project,
      p_session: session,
      p_from_seq: fromSeq,
    }),
  catalog: (project: string, range: Range) =>
    rpc<{ active_users: number; events: CatalogEvent[] }>('analytics_events_catalog', {
      p_project: project,
      p_range: range,
    }),
  event: (project: string, name: string, range: Range, breakdown: Breakdown) =>
    rpc<EventDetail>('analytics_event', {
      p_project: project,
      p_name: name,
      p_range: range,
      p_breakdown: breakdown,
    }),
  setEvent: (project: string, name: string, status: 'live' | 'blocked', description?: string) =>
    rpc<{ name: string; status: 'live' | 'blocked'; description: string | null }>(
      'analytics_set_event',
      {
        p_project: project,
        p_name: name,
        p_status: status,
        p_description: description ?? null,
      },
    ),
  live: (project: string, after: number | null, limit = 100) =>
    rpc<LiveEvent[]>('analytics_live', { p_project: project, p_after: after, p_limit: limit }),
  status: (project: string) =>
    rpc<ProjectStatus>('analytics_project_status', { p_project: project }),
  bots: (project: string, range: Range) =>
    rpc<BotsReport>('analytics_bots', { p_project: project, p_range: range }),
  setBotRule: (project: string, rule: BotRule, enabled: boolean) =>
    rpc<{ rule: BotRule; enabled: boolean }>('analytics_set_bot_rule', {
      p_project: project,
      p_rule: rule,
      p_enabled: enabled,
    }),
  setOverride: (
    project: string,
    verdict: 'human' | 'bot',
    person: string | null,
    session: string | null = null,
    note?: string,
  ) =>
    rpc<{ id: string; verdict: string }>('analytics_set_override', {
      p_project: project,
      p_verdict: verdict,
      p_person: person,
      p_session: session,
      p_note: note ?? null,
    }),
  deleteOverride: (override: string) =>
    rpc<{ deleted: string }>('analytics_delete_override', { p_override: override }),
  funnels: (project: string) => rpc<Funnel[]>('analytics_funnels', { p_project: project }),
  saveFunnel: (
    project: string,
    funnel: string | null,
    name: string,
    definition: FunnelDefinition,
  ) =>
    rpc<Funnel>('analytics_save_funnel', {
      p_project: project,
      p_funnel: funnel,
      p_name: name,
      p_steps: definition.steps,
      p_window_seconds: definition.window_seconds,
    }),
  deleteFunnel: (funnel: string) =>
    rpc<{ deleted: string }>('analytics_delete_funnel', { p_funnel: funnel }),
  funnelOptions: (project: string) =>
    rpc<FunnelOptions>('analytics_funnel_options', { p_project: project }),
  funnelReport: (
    project: string,
    definition: FunnelDefinition,
    range: Range,
    breakdown: FunnelBreakdown,
  ) =>
    rpc<FunnelReport>('analytics_funnel_report', {
      p_project: project,
      p_definition: definition,
      p_range: range,
      p_breakdown: breakdown,
    }),
  funnelPeople: (
    project: string,
    definition: FunnelDefinition,
    range: Range,
    step: number,
    outcome: 'reached' | 'dropped',
    group: { breakdown: FunnelBreakdown; key: string } | null,
    offset = 0,
  ) =>
    rpc<{ total: number; people: FunnelPerson[] }>('analytics_funnel_people', {
      p_project: project,
      p_definition: definition,
      p_range: range,
      p_step: step,
      p_outcome: outcome,
      p_breakdown: group?.breakdown ?? 'none',
      p_group: group?.key ?? null,
      p_offset: offset,
    }),
  retention: (project: string, definition: RetentionDefinition, breakdown: FunnelBreakdown) =>
    rpc<RetentionReport>('analytics_retention_report', {
      p_project: project,
      p_definition: definition,
      p_breakdown: breakdown,
    }),
  retentionPeople: (
    project: string,
    definition: RetentionDefinition,
    cell: {
      cohort: string | null
      period: number
      group: { breakdown: FunnelBreakdown; key: string } | null
    },
    offset = 0,
  ) =>
    rpc<{ total: number; people: RetentionPerson[] }>('analytics_retention_people', {
      p_project: project,
      p_definition: definition,
      p_cohort: cell.cohort,
      p_period: cell.period,
      p_breakdown: cell.group?.breakdown ?? 'none',
      p_group: cell.group?.key ?? null,
      p_offset: offset,
    }),
  retentionSummary: (project: string) =>
    rpc<RetentionSummary>('analytics_retention_summary', { p_project: project }),
  places: (project: string, range: Range, country: string | null = null) =>
    rpc<Places>('analytics_places', { p_project: project, p_range: range, p_country: country }),
  attribution: (project: string) => rpc<Attribution>('attribution_get', { p_project: project }),
  checkSubdomain: (project: string, subdomain: string) =>
    rpc<SubdomainCheck>('attribution_check_subdomain', {
      p_project: project,
      p_subdomain: subdomain,
    }),
  /** The subdomain is only needed the first time; turning on again keeps the one it had. */
  enableAttribution: (project: string, subdomain: string | null) =>
    rpc<Attribution>('attribution_enable', { p_project: project, p_subdomain: subdomain }),
  disableAttribution: (project: string) =>
    rpc<Attribution>('attribution_disable', { p_project: project }),
  updateAttribution: (project: string, patch: AttributionPatch) =>
    rpc<Attribution>('attribution_update', { p_project: project, p_patch: patch }),
  setSubdomain: (project: string, subdomain: string) =>
    rpc<Attribution>('attribution_set_subdomain', { p_project: project, p_subdomain: subdomain }),
  addDomain: (project: string, host: string) =>
    rpc<Attribution>('attribution_add_domain', { p_project: project, p_host: host }),
  setConversions: (project: string, events: string[], webLookbackDays: number) =>
    rpc<Attribution>('attribution_set_conversions', {
      p_project: project,
      p_events: events,
      p_web_lookback_days: webLookbackDays,
    }),
  attributionLinks: (project: string, range: Range) =>
    rpc<AttributionLinks>('attribution_links', { p_project: project, p_range: range }),
  saveLink: (project: string, link: string | null, fields: AttributionLinkFields) =>
    rpc<AttributionLink>('attribution_save_link', {
      p_project: project,
      p_link: link,
      p_fields: fields,
    }),
  setLinkStatus: (link: string, status: AttributionLink['status']) =>
    rpc<AttributionLink>('attribution_set_link_status', { p_link: link, p_status: status }),
  deleteLink: (link: string) =>
    rpc<{ deleted: boolean }>('attribution_delete_link', { p_link: link }),
  attributionSources: (
    project: string,
    range: Range,
    model: AttributionModel,
    source: string | null,
  ) =>
    rpc<AttributionSources>('attribution_sources', {
      p_project: project,
      p_range: range,
      p_model: model,
      p_source: source,
    }),
  removeDomain: (domain: string) =>
    rpc<Attribution>('attribution_remove_domain', { p_domain: domain }),
  /** Raw: read it with readTestDevice, which tolerates a missing or partial answer. */
  attributionTestDevice: (project: string, link: string) =>
    rpc<unknown>('attribution_test_device', { p_project: project, p_link: link }),
}

export type Api = typeof api

// In-app purchase tools and Amplitude (Phase 8) ---------------------------------------------
//
// The answers below come from newer database functions that raise a stable code in DETAIL, as
// the program functions do, so they are read strictly and fail as a ProgramError carrying it.

/** The tools that report App Store and Google Play purchases, one webhook per app each. */
export type StoreProvider = 'revenuecat' | 'adapty'
export const STORE_PROVIDERS: readonly StoreProvider[] = ['revenuecat', 'adapty']

export interface StoreConnection {
  id: string
  provider: StoreProvider
  /** The app (analytics project) the tool reports purchases for. */
  project_id: string
  project_name: string
  status: 'active' | 'revoked'
  created_at: string | null
  last_event_at: string | null
  events_30d: number
  sales_30d: number
  /** Events that became no sale: test purchases, other events, purchases no creator brought. */
  ignored_30d: number
}

export interface StoreConnections {
  /** Live connections only: a removed one is history and is not listed. */
  connections: StoreConnection[]
  /** The workspace's apps a tool can be connected to. */
  projects: Array<{ id: string; name: string }>
  /** Whether the person can connect and remove tools, when the answer says. */
  can_manage?: boolean
}

/** What connecting a tool, or making a new header value, returns: shown once, never again. */
export interface StoreWebhook {
  /** The connection it is for, when the answer carries it. */
  connection: StoreConnection | null
  webhook_url: string
  header_value: string
}

export type DestinationRegion = 'us' | 'eu'
export type DestinationStatus = 'active' | 'paused' | 'failing'

/** An app's Amplitude project, which installs are sent to. The key is never sent back whole. */
export interface AnalyticsDestination {
  provider: 'amplitude'
  region: DestinationRegion
  key_last4: string
  status: DestinationStatus
  last_sent_at: string | null
  last_error: string | null
  sent_30d: number
  failed_30d: number
}

const refused = () => new ProgramError('response_unreadable')

function objectOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refused()
  return value as Record<string, unknown>
}

function idOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw refused()
  return value
}

function countOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw refused()
  return value
}

/** A time that is there must be one; none is null. */
function timeOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw refused()
  return value
}

const nameOf = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback

function choiceOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw refused()
  return value as T
}

function readStoreConnection(value: unknown, names: Map<string, string>): StoreConnection {
  const row = objectOf(value)
  const projectId = idOf(row.project_id)
  return {
    id: idOf(row.id),
    provider: choiceOf(row.provider, STORE_PROVIDERS),
    project_id: projectId,
    project_name: nameOf(row.project_name, names.get(projectId) ?? 'Your app'),
    status: choiceOf(row.status, ['active', 'revoked'] as const),
    created_at: timeOf(row.created_at),
    last_event_at: timeOf(row.last_event_at),
    events_30d: countOf(row.events_30d),
    sales_30d: countOf(row.sales_30d),
    ignored_30d: countOf(row.ignored_30d),
  }
}

/** Reads a `workspace_store_connections` answer, refusing one that cannot draw the cards. */
export function readStoreConnections(value: unknown): StoreConnections {
  const body = objectOf(value)
  if (!Array.isArray(body.connections) || !Array.isArray(body.projects)) throw refused()
  if (body.can_manage !== undefined && typeof body.can_manage !== 'boolean') throw refused()
  const projects = body.projects.map((item) => {
    const row = objectOf(item)
    return { id: idOf(row.id), name: nameOf(row.name, 'Untitled app') }
  })
  const names = new Map(projects.map((project) => [project.id, project.name]))
  return {
    connections: body.connections
      .map((item) => readStoreConnection(item, names))
      .filter((connection) => connection.status === 'active'),
    projects,
    ...(body.can_manage === undefined ? {} : { can_manage: body.can_manage }),
  }
}

/**
 * The address a tool sends its webhook to, whole, as the database builds it. Only an https
 * address with a path is shown; anything else is not pasted anywhere.
 */
export function webhookAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  try {
    const url = new URL(raw)
    // No name or other sign-in part before the host: "https://name@host/..." is refused.
    const signIn = /^https:\/\/[^/?#]*@/i.test(raw)
    return url.protocol === 'https:' && !signIn && url.pathname !== '/' ? raw : null
  } catch {
    return null
  }
}

/** "Bearer " and the random value the tool sends back in its Authorization header. */
const HEADER_VALUE = /^Bearer [A-Za-z0-9_-]{16,128}={0,2}$/

/**
 * Reads what `workspace_store_connection_create` and `_rotate` answer: the connection with the
 * webhook address and the header value beside it (or under `connection`).
 */
export function readStoreWebhook(value: unknown): StoreWebhook {
  const body = objectOf(value)
  const address = webhookAddress(body.webhook_url)
  const header = body.header_value
  if (!address || typeof header !== 'string' || !HEADER_VALUE.test(header)) throw refused()
  const inner = body.connection
  const row = inner && typeof inner === 'object' ? inner : 'id' in body ? body : null
  return {
    connection: row ? readStoreConnection(row, new Map()) : null,
    webhook_url: address,
    header_value: header,
  }
}

function readDestination(value: unknown): AnalyticsDestination | null {
  const row = objectOf(value)
  // A destination this console has no card for yet is left out, not refused.
  if (row.provider !== 'amplitude') return null
  const last4 = row.key_last4
  if (typeof last4 !== 'string' || !/^[A-Za-z0-9]{4}$/.test(last4)) throw refused()
  const error = typeof row.last_error === 'string' ? row.last_error.trim().slice(0, 300) : ''
  return {
    provider: 'amplitude',
    region: choiceOf(row.region, ['us', 'eu'] as const),
    key_last4: last4,
    status: choiceOf(row.status, ['active', 'paused', 'failing'] as const),
    last_sent_at: timeOf(row.last_sent_at),
    last_error: error || null,
    sent_30d: countOf(row.sent_30d),
    failed_30d: countOf(row.failed_30d),
  }
}

/** Reads an `analytics_destinations_get` answer (also what saving answers). */
export function readDestinations(value: unknown): AnalyticsDestination[] {
  const body = objectOf(value)
  if (!Array.isArray(body.destinations)) throw refused()
  return body.destinations.flatMap((item) => readDestination(item) ?? [])
}

/** An Amplitude project API key: 32 letters 0-9 and a-f. */
export const AMPLITUDE_KEY = /^[0-9a-f]{32}$/i

/** The field the database reads the key from, written so no scanner takes it for a leak. */
const KEY_FIELD = 'api_' + 'key'

async function strictRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  let response
  try {
    response = await requireSupabaseClient().rpc(name, args)
  } catch {
    throw new ProgramError(
      typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'unreachable',
    )
  }
  if (response.error) throw readFailure(response.error)
  return response.data
}

/** RevenueCat and Adapty, connected per app. Owners and admins change them. */
export const storeConnections = {
  list: async (workspaceId: string) =>
    readStoreConnections(
      await strictRpc('workspace_store_connections', { p_workspace_id: workspaceId }),
    ),
  create: async (workspaceId: string, projectId: string, provider: StoreProvider) =>
    readStoreWebhook(
      await strictRpc('workspace_store_connection_create', {
        p_workspace_id: workspaceId,
        p_project_id: projectId,
        p_provider: provider,
      }),
    ),
  /** A new header value; the old one stops working. */
  rotate: async (connectionId: string) =>
    readStoreWebhook(
      await strictRpc('workspace_store_connection_rotate', { p_connection_id: connectionId }),
    ),
  /** Answers the list as it is after the removal, or null when the answer carries none. */
  remove: async (connectionId: string): Promise<StoreConnections | null> => {
    const answer = await strictRpc('workspace_store_connection_remove', {
      p_connection_id: connectionId,
    })
    const body = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : null
    return Array.isArray(body?.connections) ? readStoreConnections(answer) : null
  },
}

/** An app's Amplitude project. Developers, admins and owners change it. */
export const analyticsDestinations = {
  get: async (projectId: string) =>
    readDestinations(await strictRpc('analytics_destinations_get', { p_project_id: projectId })),
  /** A key left out keeps the saved one; the region can change on its own. */
  save: async (projectId: string, input: { key?: string; region: DestinationRegion }) =>
    readDestinations(
      await strictRpc('analytics_destination_save', {
        p_project_id: projectId,
        p_provider: 'amplitude',
        p_input: { region: input.region, ...(input.key ? { [KEY_FIELD]: input.key } : {}) },
      }),
    ),
  remove: async (projectId: string) => {
    const answer = await strictRpc('analytics_destination_remove', {
      p_project_id: projectId,
      p_provider: 'amplitude',
    })
    // Removing may answer the destinations left, or nothing to read: then they are read again.
    const body = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : null
    return Array.isArray(body?.destinations)
      ? readDestinations(answer)
      : analyticsDestinations.get(projectId)
  },
}
