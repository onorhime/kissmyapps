import { requireSupabaseClient } from '../lib/supabase'

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
}

export type Api = typeof api
