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

// Attribution Phase 3: revenue, costs, return on ad spend and cohorts ---------------------------
//
// Money is in normal units (4.99, not 499), rounded to cents by the database. Every report is in
// the project's currency, converted at the European Central Bank's daily rates; a cost row keeps
// the currency it was entered in. Ratios (ROAS, retention) are fractions: 0.86 is 86%. The
// readers at the end of this file turn each answer into these shapes.

/** The ranges the money reports cover: the last 7, 30 or 90 days, today included. */
export type MoneyRange = '7d' | '30d' | '90d'

/** How a payment event names its amount: major is 4.99, minor is 499 cents. */
export type RevenueUnit = 'major' | 'minor'

/** An event the merchant says is a payment, and where in it the amount and currency are. */
export interface RevenueEvent {
  event: string
  amount_property: string
  unit: RevenueUnit
  /** Exactly one of these two: the property with the currency code, or the one fixed currency. */
  currency_property: string | null
  currency: string | null
}

/** What `attribution_revenue_setup` answers: how revenue reaches the project, and how it is going. */
export interface RevenueSetup {
  currency: string
  events: RevenueEvent[]
  /** RevenueCat and Adapty connections of this project. */
  stores: Array<{ provider: StoreProvider; connected: boolean }>
  /** Production payments in the last 7 days, in the project's currency. */
  last_7d: {
    payments: number
    refunds: number
    payers: number
    revenue: number
    unconverted: number
  }
  last_received_at: string | null
  /** The latest payment from a development build: kept, never counted in reports. */
  last_development_at: string | null
  by_origin: Array<{ origin: 'event' | 'store'; payments: number }>
  /** Payments that could not be counted in the last 7 days, by reason. */
  skipped_7d: Array<{ reason: string; events: number }>
  /** The latest day of exchange rates stored. */
  rates_day: string | null
}

export type CostOrigin = 'manual' | 'csv' | 'meta' | 'tiktok'
export type CostRuleKind = 'install' | 'click'

/** A day's spend for a source and campaign, typed in or uploaded. Names are '' when not split. */
export interface CostRow {
  id: string
  day: string
  source: string
  campaign: string
  adset: string
  ad: string
  amount: number
  currency: string
  origin: CostOrigin
  import_id: string | null
  updated_at: string | null
}

/** What a link's price per install or click added on one day. */
export interface LinkCost {
  day: string
  link_id: string
  link_name: string
  source: string
  campaign: string
  kind: CostRuleKind
  count: number
  amount: number
  currency: string
}

/** One spreadsheet upload; remaining is how many of its rows are still its own. */
export interface CostImport {
  id: string
  file_name: string | null
  rows: number
  created_at: string | null
  remaining: number
}

/** A link's fixed price per install or per click. */
export interface CostRule {
  id: string
  link_id: string
  link_name: string
  link_source: string
  link_campaign: string
  kind: CostRuleKind
  amount: number
  currency: string
  starts_on: string
  ends_on: string | null
  updated_at: string | null
}

/** What `attribution_costs` answers. Totals are in the project's currency. */
export interface CostsReport {
  currency: string
  range: MoneyRange
  from: string | null
  to: string | null
  rows: CostRow[]
  link_costs: LinkCost[]
  totals: { cost: number; typed: number; uploaded: number; links: number; unconverted: number }
  imports: CostImport[]
  rules: CostRule[]
  /** Source names seen in this project, to suggest while typing one. */
  sources: string[]
}

/** One day's spend to save; with an id it changes that row. */
export interface CostInput {
  id?: string
  day: string
  source: string
  campaign?: string
  adset?: string
  ad?: string
  amount: number
  currency?: string
}

/** What an upload answers: nothing written and the problems by row, or what was written. */
export interface CostImportResult {
  import_id: string | null
  imported: number
  replaced: number
  /** Row is the 1-based position in the rows sent. */
  errors: Array<{ row: number; message: string }>
}

export interface CostRuleInput {
  link_id: string
  kind: CostRuleKind
  amount: number
  currency?: string
  starts_on: string
  ends_on?: string | null
}

export type RoiGroup = 'source' | 'campaign' | 'adset' | 'ad' | 'day'

/**
 * Which part of the report to open. A key that is there with null means "none": direct and
 * organic, or no campaign. A key left out does not filter.
 */
export interface RoiFilters {
  source?: string | null
  campaign?: string | null
  adset?: string | null
}

/** The figures of a whole report or one of its rows. Money in the project's currency. */
export interface RoiMetrics {
  users: number
  installs: number
  cost: number
  payers: number
  revenue: number
  revenue_d0: number
  revenue_d7: number
  revenue_d30: number
  cpi: number | null
  cost_per_user: number | null
  cost_per_payer: number | null
  arpu: number | null
  roas: number | null
  roas_d0: number | null
  roas_d7: number | null
  roas_d30: number | null
}

export interface RoiRow extends RoiMetrics {
  /** A source, campaign, ad set or ad name, or a YYYY-MM-DD day; null for none. */
  key: string | null
}

/** Revenue and cost rows left out because their currency had no exchange rate. */
export interface Unconverted {
  revenue: number
  cost: number
  currencies: string[]
}

/** What `attribution_roi` answers. */
export interface RoiReport {
  currency: string
  range: MoneyRange
  from: string | null
  to: string | null
  timezone: string
  group: RoiGroup
  filters: RoiFilters
  /** Whether every person in the range has finished day 0, 7 and 30. */
  complete: { d0: boolean; d7: boolean; d30: boolean }
  totals: RoiMetrics
  rows: RoiRow[]
  unconverted: Unconverted
  has_costs: boolean
  has_revenue: boolean
}

export type CohortInterval = 'day' | 'week' | 'month'

export interface CohortCell {
  day: number
  state: 'complete' | 'partial' | 'future'
  /** The cohort's people who have finished this day. */
  complete_users: number
  /** What the cohort's people paid by the end of this day, together. */
  revenue: number
  revenue_per_user: number | null
  roas: number | null
  /** People active on this day after they arrived. */
  returned: number
  retention: number | null
}

export interface Cohort {
  /** The first day of the cohort, YYYY-MM-DD, in the project's time zone. */
  start: string
  users: number
  cost: number
  cells: CohortCell[]
}

/** What `attribution_cohorts` answers. */
export interface CohortsReport {
  currency: string
  interval: CohortInterval
  timezone: string
  today: string | null
  filters: RoiFilters
  days: number[]
  /** Newest first. */
  cohorts: Cohort[]
  /** Day 0 to 30, over the people who have finished each day. */
  curve: Array<{
    day: number
    users: number
    revenue_per_user: number | null
    retention: number | null
  }>
  totals: { users: number; cost: number; revenue: number; payers: number }
  unconverted: Unconverted
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
  revenueSetup: async (project: string) =>
    readRevenueSetup(await rpc<unknown>('attribution_revenue_setup', { p_project: project })),
  /** Replaces the project's payment events with these; answers the setup as it is after. */
  saveRevenueEvents: async (project: string, events: RevenueEvent[]) =>
    readRevenueSetup(
      await rpc<unknown>('attribution_revenue_events_save', {
        p_project: project,
        p_events: events.map(revenueEventInput),
      }),
    ),
  attributionCosts: async (project: string, input: { range: MoneyRange; source?: string }) =>
    readCosts(await rpc<unknown>('attribution_costs', { p_project: project, p_input: input })),
  saveCosts: async (project: string, rows: CostInput[]) =>
    countIn(
      await rpc<unknown>('attribution_cost_save', { p_project: project, p_input: { rows } }),
      'saved',
    ),
  deleteCosts: async (project: string, ids: string[]) =>
    countIn(
      await rpc<unknown>('attribution_cost_delete', { p_project: project, p_ids: ids }),
      'deleted',
    ),
  importCosts: async (project: string, input: { file_name?: string; rows: CostInput[] }) =>
    readCostImport(
      await rpc<unknown>('attribution_cost_import', { p_project: project, p_input: input }),
    ),
  undoCostImport: async (project: string, importId: string) =>
    countIn(
      await rpc<unknown>('attribution_cost_import_undo', {
        p_project: project,
        p_import: importId,
      }),
      'deleted',
    ),
  saveCostRule: async (project: string, input: CostRuleInput) => {
    const rule = readCostRule(
      await rpc<unknown>('attribution_cost_rule_save', { p_project: project, p_input: input }),
    )
    if (!rule) throw unreadable()
    return rule
  },
  deleteCostRule: async (project: string, rule: string) =>
    countIn(
      await rpc<unknown>('attribution_cost_rule_delete', { p_project: project, p_rule: rule }),
      'deleted',
    ),
  attributionRoi: async (
    project: string,
    input: { range: MoneyRange; group: RoiGroup } & RoiFilters,
  ) => readRoi(await rpc<unknown>('attribution_roi', { p_project: project, p_input: input })),
  attributionCohorts: async (project: string, input: { interval: CohortInterval } & RoiFilters) =>
    readCohorts(await rpc<unknown>('attribution_cohorts', { p_project: project, p_input: input })),
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
  /** Where the tool sends events. Not a secret, so it can be shown again; null when not sent. */
  webhook_url: string | null
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
    webhook_url: webhookAddress(row.webhook_url),
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
    connection: row ? { ...readStoreConnection(row, new Map()), webhook_url: address } : null,
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

// Attribution Phase 3 readers ------------------------------------------------------------------
//
// Each answer is read defensively, like the other attribution readers: a missing number is 0, a
// missing ratio is null (nothing to divide by), a row that cannot be used is left out. An answer
// that is not a report at all fails with a plain message, so the screen says it could not load
// instead of showing an empty report.

const unreadable = () => new ApiError('The answer could not be read. Try again in a moment.')

function reportBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unreadable()
  return value as Record<string, unknown>
}

const recordOrNull = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const listIn = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** A number sent as JSON or as text (Postgres numeric); anything else is null. */
function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const amountIn = (value: unknown) => numberOrNull(value) ?? 0

const wholeIn = (value: unknown) => {
  const parsed = numberOrNull(value)
  return parsed !== null && parsed > 0 ? Math.round(parsed) : 0
}

const textOrNull = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/** A name that may be empty ('' means not split further). */
const nameIn = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const dayOrNull = (value: unknown) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : null

const momentOrNull = (value: unknown) => {
  const text = textOrNull(value)
  return text && Number.isFinite(Date.parse(text)) ? text : null
}

const currencyOr = (value: unknown, fallback: string) =>
  typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim())
    ? value.trim().toUpperCase()
    : fallback

const moneyRangeOf = (value: unknown): MoneyRange =>
  value === '7d' || value === '90d' ? value : '30d'

function unconvertedOf(value: unknown): Unconverted {
  const body = recordOrNull(value) ?? {}
  return {
    revenue: wholeIn(body.revenue),
    cost: wholeIn(body.cost),
    currencies: listIn(body.currencies).flatMap((item) => {
      const code = currencyOr(item, '')
      return code ? [code] : []
    }),
  }
}

function filtersOf(value: unknown): RoiFilters {
  const body = recordOrNull(value) ?? {}
  const filters: RoiFilters = {}
  for (const key of ['source', 'campaign', 'adset'] as const)
    if (key in body) filters[key] = typeof body[key] === 'string' ? (body[key] as string) : null
  return filters
}

function metricsOf(value: unknown): RoiMetrics {
  const row = recordOrNull(value) ?? {}
  return {
    users: wholeIn(row.users),
    installs: wholeIn(row.installs),
    cost: amountIn(row.cost),
    payers: wholeIn(row.payers),
    revenue: amountIn(row.revenue),
    revenue_d0: amountIn(row.revenue_d0),
    revenue_d7: amountIn(row.revenue_d7),
    revenue_d30: amountIn(row.revenue_d30),
    cpi: numberOrNull(row.cpi),
    cost_per_user: numberOrNull(row.cost_per_user),
    cost_per_payer: numberOrNull(row.cost_per_payer),
    arpu: numberOrNull(row.arpu),
    roas: numberOrNull(row.roas),
    roas_d0: numberOrNull(row.roas_d0),
    roas_d7: numberOrNull(row.roas_d7),
    roas_d30: numberOrNull(row.roas_d30),
  }
}

const ROI_GROUPS: readonly RoiGroup[] = ['source', 'campaign', 'adset', 'ad', 'day']

/** Reads an `attribution_roi` answer. */
export function readRoi(value: unknown): RoiReport {
  const body = reportBody(value)
  if (!Array.isArray(body.rows)) throw unreadable()
  const complete = recordOrNull(body.complete) ?? {}
  return {
    currency: currencyOr(body.currency, 'USD'),
    range: moneyRangeOf(body.range),
    from: dayOrNull(body.from),
    to: dayOrNull(body.to),
    timezone: textOrNull(body.timezone) ?? 'UTC',
    group: ROI_GROUPS.includes(body.group as RoiGroup) ? (body.group as RoiGroup) : 'source',
    filters: filtersOf(body.filters),
    // A day the answer does not vouch for is still filling.
    complete: { d0: complete.d0 === true, d7: complete.d7 === true, d30: complete.d30 === true },
    totals: metricsOf(body.totals),
    rows: body.rows.flatMap((item) => {
      const row = recordOrNull(item)
      if (!row) return []
      return [{ key: typeof row.key === 'string' ? row.key : null, ...metricsOf(row) }]
    }),
    unconverted: unconvertedOf(body.unconverted),
    has_costs: body.has_costs === true,
    has_revenue: body.has_revenue === true,
  }
}

const CELL_STATES = ['complete', 'partial', 'future'] as const

/** Reads an `attribution_cohorts` answer. */
export function readCohorts(value: unknown): CohortsReport {
  const body = reportBody(value)
  if (!Array.isArray(body.cohorts)) throw unreadable()
  const interval = body.interval === 'week' || body.interval === 'month' ? body.interval : 'day'
  const days = listIn(body.days).flatMap((item) => {
    const day = numberOrNull(item)
    return day !== null && Number.isInteger(day) && day >= 0 ? [day] : []
  })
  const totals = recordOrNull(body.totals) ?? {}
  return {
    currency: currencyOr(body.currency, 'USD'),
    interval,
    timezone: textOrNull(body.timezone) ?? 'UTC',
    today: dayOrNull(body.today),
    filters: filtersOf(body.filters),
    days: days.length ? days : [0, 1, 3, 7, 14, 30, 60, 90],
    cohorts: body.cohorts.flatMap((item) => {
      const row = recordOrNull(item)
      const start = dayOrNull(row?.start)
      if (!row || !start) return []
      return [
        {
          start,
          users: wholeIn(row.users),
          cost: amountIn(row.cost),
          cells: listIn(row.cells).flatMap((entry) => {
            const cell = recordOrNull(entry)
            const day = numberOrNull(cell?.day)
            if (!cell || day === null) return []
            return [
              {
                day,
                // A state the console has no word for is drawn as a day still to come.
                state: CELL_STATES.includes(cell.state as CohortCell['state'])
                  ? (cell.state as CohortCell['state'])
                  : 'future',
                complete_users: wholeIn(cell.complete_users),
                revenue: amountIn(cell.revenue),
                revenue_per_user: numberOrNull(cell.revenue_per_user),
                roas: numberOrNull(cell.roas),
                returned: wholeIn(cell.returned),
                retention: numberOrNull(cell.retention),
              },
            ]
          }),
        },
      ]
    }),
    curve: listIn(body.curve).flatMap((item) => {
      const point = recordOrNull(item)
      const day = numberOrNull(point?.day)
      if (!point || day === null) return []
      return [
        {
          day,
          users: wholeIn(point.users),
          revenue_per_user: numberOrNull(point.revenue_per_user),
          retention: numberOrNull(point.retention),
        },
      ]
    }),
    totals: {
      users: wholeIn(totals.users),
      cost: amountIn(totals.cost),
      revenue: amountIn(totals.revenue),
      payers: wholeIn(totals.payers),
    },
    unconverted: unconvertedOf(body.unconverted),
  }
}

function readRevenueEvent(value: unknown): RevenueEvent[] {
  const row = recordOrNull(value)
  const event = textOrNull(row?.event)
  const amount = textOrNull(row?.amount_property)
  if (!row || !event || !amount) return []
  const currencyProperty = textOrNull(row.currency_property)
  const fixed = currencyProperty ? null : currencyOr(row.currency, '') || null
  return [
    {
      event,
      amount_property: amount,
      unit: row.unit === 'minor' ? 'minor' : 'major',
      currency_property: currencyProperty,
      currency: fixed,
    },
  ]
}

/** Reads what `attribution_revenue_setup` and `attribution_revenue_events_save` answer. */
export function readRevenueSetup(value: unknown): RevenueSetup {
  const body = reportBody(value)
  const last = recordOrNull(body.last_7d) ?? {}
  return {
    currency: currencyOr(body.currency, 'USD'),
    events: listIn(body.events).flatMap(readRevenueEvent),
    stores: listIn(body.stores).flatMap((item) => {
      const row = recordOrNull(item)
      return row && STORE_PROVIDERS.includes(row.provider as StoreProvider)
        ? [{ provider: row.provider as StoreProvider, connected: row.connected !== false }]
        : []
    }),
    last_7d: {
      payments: wholeIn(last.payments),
      refunds: wholeIn(last.refunds),
      payers: wholeIn(last.payers),
      revenue: amountIn(last.revenue),
      unconverted: wholeIn(last.unconverted),
    },
    last_received_at: momentOrNull(body.last_received_at),
    last_development_at: momentOrNull(body.last_development_at),
    by_origin: listIn(body.by_origin).flatMap((item) => {
      const row = recordOrNull(item)
      return row && (row.origin === 'event' || row.origin === 'store')
        ? [{ origin: row.origin, payments: wholeIn(row.payments) }]
        : []
    }),
    skipped_7d: listIn(body.skipped_7d).flatMap((item) => {
      const row = recordOrNull(item)
      const reason = textOrNull(row?.reason)
      return row && reason && wholeIn(row.events) > 0
        ? [{ reason, events: wholeIn(row.events) }]
        : []
    }),
    rates_day: dayOrNull(body.rates_day),
  }
}

/** What saving sends for one event: the currency property or the fixed currency, never both. */
function revenueEventInput(event: RevenueEvent): Record<string, string> {
  return {
    event: event.event,
    amount_property: event.amount_property,
    unit: event.unit,
    ...(event.currency_property
      ? { currency_property: event.currency_property }
      : { currency: event.currency ?? '' }),
  }
}

const COST_ORIGINS: readonly CostOrigin[] = ['manual', 'csv', 'meta', 'tiktok']
const ruleKindOf = (value: unknown): CostRuleKind | null =>
  value === 'install' || value === 'click' ? value : null

/** A link price from `attribution_costs` or `attribution_cost_rule_save`; null if unusable. */
export function readCostRule(value: unknown): CostRule | null {
  const row = recordOrNull(value)
  const id = textOrNull(row?.id)
  const link = textOrNull(row?.link_id)
  const kind = ruleKindOf(row?.kind)
  const starts = dayOrNull(row?.starts_on)
  if (!row || !id || !link || !kind || !starts) return null
  return {
    id,
    link_id: link,
    link_name: textOrNull(row.link_name) ?? 'A link',
    link_source: nameIn(row.link_source),
    link_campaign: nameIn(row.link_campaign),
    kind,
    amount: amountIn(row.amount),
    currency: currencyOr(row.currency, 'USD'),
    starts_on: starts,
    ends_on: dayOrNull(row.ends_on),
    updated_at: momentOrNull(row.updated_at),
  }
}

/** Reads an `attribution_costs` answer. */
export function readCosts(value: unknown): CostsReport {
  const body = reportBody(value)
  if (!Array.isArray(body.rows)) throw unreadable()
  const currency = currencyOr(body.currency, 'USD')
  const totals = recordOrNull(body.totals) ?? {}
  return {
    currency,
    range: moneyRangeOf(body.range),
    from: dayOrNull(body.from),
    to: dayOrNull(body.to),
    rows: body.rows.flatMap((item) => {
      const row = recordOrNull(item)
      const id = textOrNull(row?.id)
      const day = dayOrNull(row?.day)
      const source = textOrNull(row?.source)
      if (!row || !id || !day || !source) return []
      return [
        {
          id,
          day,
          source,
          campaign: nameIn(row.campaign),
          adset: nameIn(row.adset),
          ad: nameIn(row.ad),
          amount: amountIn(row.amount),
          currency: currencyOr(row.currency, currency),
          origin: COST_ORIGINS.includes(row.origin as CostOrigin)
            ? (row.origin as CostOrigin)
            : 'manual',
          import_id: textOrNull(row.import_id),
          updated_at: momentOrNull(row.updated_at),
        },
      ]
    }),
    link_costs: listIn(body.link_costs).flatMap((item) => {
      const row = recordOrNull(item)
      const day = dayOrNull(row?.day)
      const link = textOrNull(row?.link_id)
      const kind = ruleKindOf(row?.kind)
      if (!row || !day || !link || !kind) return []
      return [
        {
          day,
          link_id: link,
          link_name: textOrNull(row.link_name) ?? 'A link',
          source: nameIn(row.source),
          campaign: nameIn(row.campaign),
          kind,
          count: wholeIn(row.count),
          amount: amountIn(row.amount),
          currency: currencyOr(row.currency, currency),
        },
      ]
    }),
    totals: {
      cost: amountIn(totals.cost),
      typed: amountIn(totals.typed),
      uploaded: amountIn(totals.uploaded),
      links: amountIn(totals.links),
      unconverted: wholeIn(totals.unconverted),
    },
    imports: listIn(body.imports).flatMap((item) => {
      const row = recordOrNull(item)
      const id = textOrNull(row?.id)
      if (!row || !id) return []
      return [
        {
          id,
          file_name: textOrNull(row.file_name),
          rows: wholeIn(row.rows),
          created_at: momentOrNull(row.created_at),
          remaining: wholeIn(row.remaining),
        },
      ]
    }),
    rules: listIn(body.rules).flatMap((item) => readCostRule(item) ?? []),
    sources: [
      ...new Set(listIn(body.sources).flatMap((item) => textOrNull(item)?.toLowerCase() ?? [])),
    ],
  }
}

/** Reads what `attribution_cost_import` answers, whether it wrote the rows or not. */
export function readCostImport(value: unknown): CostImportResult {
  const body = reportBody(value)
  return {
    import_id: textOrNull(body.import_id),
    imported: wholeIn(body.imported),
    replaced: wholeIn(body.replaced),
    errors: listIn(body.errors).flatMap((item) => {
      const row = recordOrNull(item)
      const message = textOrNull(row?.message)
      return row && message ? [{ row: wholeIn(row.row), message }] : []
    }),
  }
}

/** A count in a small answer such as {"saved": 3}; 0 when it is not there. */
function countIn(value: unknown, key: string): number {
  return wholeIn(recordOrNull(value)?.[key])
}
