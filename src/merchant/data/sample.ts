/**
 * Preview fixtures for the merchant console. Nothing here is sent anywhere: the
 * projects, keys, people and event catalogues exist only in browser memory until
 * the merchant backend replaces them section by section.
 */

export type Platform = 'ios' | 'android' | 'web' | 'server'
export type ProjectHue = 'yellow' | 'pink' | 'green' | 'blue'
export type EventStatus = 'live' | 'planned' | 'blocked'

export type PropertySpec = {
  name: string
  type: 'string' | 'number' | 'boolean'
  description?: string
  values?: Array<string | number | boolean>
  range?: [number, number]
  decimals?: number
  coverage: number
}

export type EventDefinition = {
  name: string
  description: string
  category: 'Automatic' | 'Funnel' | 'Account' | 'Learning' | 'Watching' | 'Revenue' | 'Growth'
  status: EventStatus
  /** Full-day events at today's level, before weekday and trend adjustments. */
  daily: number
  /** Share of volume per platform, in the project's platform order. */
  share: number[]
  /** Average times one active user sends this event on a day they send it. */
  perUser: number
  firstSeenDaysAgo: number
  properties: PropertySpec[]
  /** Multiplier applied from the project's release day onwards. */
  releaseLift?: number
}

export type CountryShare = { name: string; code: string; share: number }

export type Project = {
  id: string
  name: string
  description: string
  hue: ProjectHue
  platforms: Platform[]
  timezone: string
  createdAt: string
  sdk: Partial<Record<Platform, string>>
  /** Projects created in this session have no generated history. */
  sample: boolean
  dau: number
  newUsers: number
  countries: CountryShare[]
  versions: { current: string; previous: string; older: string }
  release?: { label: string; daysAgo: number }
  /** A source that stopped sending, so the overview has something true to flag. */
  quietSource?: { platform: Platform; minutes: number }
  allowedOrigins: string[]
}

export type ApiKeyKind = 'client' | 'server'
export type ApiEnvironment = 'production' | 'development'

export type ApiKey = {
  id: string
  projectId: string
  name: string
  kind: ApiKeyKind
  environment: ApiEnvironment
  /** Client keys are public by design; server keys are only held as a suffix after creation. */
  token: string | null
  suffix: string
  createdAt: string
  createdBy: string
  lastUsedMinutesAgo: number | null
  revokedAt: string | null
}

export type MemberRole = 'Owner' | 'Admin' | 'Developer' | 'Analyst'

export type Member = {
  id: string
  name: string
  email: string
  role: MemberRole
  status: 'active' | 'invited'
  lastActive: string
}

export const platformLabels: Record<Platform, string> = {
  ios: 'iOS',
  android: 'Android',
  web: 'Web',
  server: 'Server',
}

export const merchant = {
  name: 'Nobrainer Lab',
  owner: 'Victory Onorhime',
  ownerEmail: 'victory@nobrainerlab.com',
}

const contextNote = 'Sent automatically by the SDK on every event.'

export const contextProperties: PropertySpec[] = [
  { name: 'platform', type: 'string', coverage: 1, description: contextNote },
  { name: 'app_version', type: 'string', coverage: 1, description: contextNote },
  { name: 'os_version', type: 'string', coverage: 1, description: contextNote },
  { name: 'device_model', type: 'string', coverage: 0.97, description: contextNote },
  { name: 'country', type: 'string', coverage: 0.99, description: contextNote },
  { name: 'library', type: 'string', coverage: 1, description: contextNote },
]

const speakSixEvents: EventDefinition[] = [
  {
    name: 'session_started',
    description: 'A person opened the app or site after 30 minutes away.',
    category: 'Automatic',
    status: 'live',
    daily: 9800,
    share: [0.52, 0.38, 0.1],
    perUser: 3.1,
    firstSeenDaysAgo: 200,
    properties: [
      { name: 'session_id', type: 'string', coverage: 1 },
      { name: 'referrer', type: 'string', values: ['direct', 'push', 'email'], coverage: 0.64 },
    ],
  },
  {
    name: 'screen_viewed',
    description: 'A screen or page came into view.',
    category: 'Automatic',
    status: 'live',
    daily: 21400,
    share: [0.55, 0.4, 0.05],
    perUser: 7.2,
    firstSeenDaysAgo: 200,
    releaseLift: 1.18,
    properties: [
      {
        name: 'screen_name',
        type: 'string',
        values: ['Home', 'Lesson', 'Speaking drill', 'Progress', 'Paywall', 'Settings'],
        coverage: 1,
      },
      { name: 'previous_screen', type: 'string', values: ['Home', 'Lesson'], coverage: 0.91 },
    ],
  },
  {
    name: 'app_installed',
    description: 'First open after a fresh install.',
    category: 'Automatic',
    status: 'live',
    daily: 210,
    share: [0.58, 0.42, 0],
    perUser: 1,
    firstSeenDaysAgo: 200,
    properties: [
      {
        name: 'install_source',
        type: 'string',
        values: ['App Store', 'Google Play', 'KissMyApps link'],
        coverage: 0.88,
      },
    ],
  },
  {
    name: 'funnel_entered',
    description: 'A visitor landed on the web funnel.',
    category: 'Funnel',
    status: 'live',
    daily: 1450,
    share: [0, 0, 1],
    perUser: 1.1,
    firstSeenDaysAgo: 33,
    properties: [
      { name: 'funnel_version', type: 'string', values: ['speaksix_v6'], coverage: 1 },
      {
        name: 'utm_source',
        type: 'string',
        values: ['tiktok', 'instagram', 'kissmyapps'],
        coverage: 0.76,
      },
      { name: 'kma_click', type: 'string', coverage: 0.42 },
    ],
  },
  {
    name: 'slide_1_passed',
    description: 'Answered the first funnel question.',
    category: 'Funnel',
    status: 'live',
    daily: 1120,
    share: [0, 0, 1],
    perUser: 1,
    firstSeenDaysAgo: 33,
    properties: [
      {
        name: 'answer',
        type: 'string',
        values: ['Work meetings', 'Travel', 'Exams', 'Confidence'],
        coverage: 1,
      },
    ],
  },
  {
    name: 'slide_2_passed',
    description: 'Answered the second funnel question.',
    category: 'Funnel',
    status: 'live',
    daily: 930,
    share: [0, 0, 1],
    perUser: 1,
    firstSeenDaysAgo: 33,
    properties: [
      { name: 'english_level', type: 'string', values: ['A2', 'B1', 'B2', 'C1'], coverage: 1 },
    ],
  },
  {
    name: 'slide_3_passed',
    description: 'Picked a daily routine in the funnel.',
    category: 'Funnel',
    status: 'live',
    daily: 810,
    share: [0, 0, 1],
    perUser: 1,
    firstSeenDaysAgo: 33,
    properties: [
      { name: 'routine', type: 'string', values: ['5 min', '10 min', '20 min'], coverage: 1 },
    ],
  },
  {
    name: 'email_entered',
    description: 'Left an email address on the funnel.',
    category: 'Funnel',
    status: 'live',
    daily: 520,
    share: [0, 0, 1],
    perUser: 1,
    firstSeenDaysAgo: 33,
    properties: [{ name: 'consent_marketing', type: 'boolean', coverage: 1 }],
  },
  {
    name: 'preferences_saved',
    description: 'Saved practice days and a time window.',
    category: 'Funnel',
    status: 'live',
    daily: 340,
    share: [0, 0, 1],
    perUser: 1,
    firstSeenDaysAgo: 33,
    properties: [
      {
        name: 'time_window',
        type: 'string',
        values: ['Morning', 'Lunch', 'Evening'],
        coverage: 1,
      },
      { name: 'preferred_weekdays', type: 'number', range: [2, 7], coverage: 1 },
    ],
  },
  {
    name: 'sign_up_completed',
    description: 'Created an account in the app or on the web.',
    category: 'Account',
    status: 'live',
    daily: 230,
    share: [0.5, 0.36, 0.14],
    perUser: 1,
    firstSeenDaysAgo: 200,
    properties: [
      { name: 'method', type: 'string', values: ['Apple', 'Google', 'Email'], coverage: 1 },
    ],
  },
  {
    name: 'lesson_started',
    description: 'Opened a lesson.',
    category: 'Learning',
    status: 'live',
    daily: 5200,
    share: [0.56, 0.4, 0.04],
    perUser: 2.4,
    firstSeenDaysAgo: 200,
    properties: [
      {
        name: 'lesson_id',
        type: 'string',
        values: ['b1-07', 'b1-08', 'a2-15', 'b2-03'],
        coverage: 1,
      },
      { name: 'lesson_level', type: 'string', values: ['A2', 'B1', 'B2'], coverage: 1 },
    ],
  },
  {
    name: 'lesson_completed',
    description: 'Finished every drill in a lesson.',
    category: 'Learning',
    status: 'live',
    daily: 4100,
    share: [0.56, 0.4, 0.04],
    perUser: 2.1,
    firstSeenDaysAgo: 200,
    properties: [
      {
        name: 'lesson_id',
        type: 'string',
        values: ['b1-07', 'b1-08', 'a2-15', 'b2-03'],
        coverage: 1,
      },
      { name: 'duration_s', type: 'number', range: [180, 960], coverage: 1 },
      { name: 'score', type: 'number', range: [52, 99], coverage: 1 },
    ],
  },
  {
    name: 'speaking_score_recorded',
    description: 'The coach scored one spoken answer.',
    category: 'Learning',
    status: 'live',
    daily: 3700,
    share: [0.55, 0.42, 0.03],
    perUser: 2.6,
    firstSeenDaysAgo: 75,
    properties: [
      { name: 'score', type: 'number', range: [41, 100], coverage: 1 },
      { name: 'pronunciation', type: 'number', range: [38, 100], coverage: 0.96 },
    ],
  },
  {
    name: 'streak_extended',
    description: 'Practised on another day in a row.',
    category: 'Growth',
    status: 'live',
    daily: 1900,
    share: [0.57, 0.41, 0.02],
    perUser: 1,
    firstSeenDaysAgo: 70,
    properties: [{ name: 'streak_days', type: 'number', range: [2, 64], coverage: 1 }],
  },
  {
    name: 'paywall_viewed',
    description: 'Saw the subscription offer.',
    category: 'Revenue',
    status: 'live',
    daily: 760,
    share: [0.55, 0.38, 0.07],
    perUser: 1.3,
    firstSeenDaysAgo: 200,
    releaseLift: 1.35,
    properties: [
      {
        name: 'placement',
        type: 'string',
        values: ['After lesson', 'Streak goal', 'Settings'],
        coverage: 1,
      },
      { name: 'offer_id', type: 'string', values: ['monthly_999', 'annual_5999'], coverage: 1 },
    ],
  },
  {
    name: 'trial_started',
    description: 'Started a free trial through the store.',
    category: 'Revenue',
    status: 'live',
    daily: 96,
    share: [0.6, 0.36, 0.04],
    perUser: 1,
    firstSeenDaysAgo: 200,
    releaseLift: 1.3,
    properties: [
      { name: 'plan_id', type: 'string', values: ['monthly_999', 'annual_5999'], coverage: 1 },
    ],
  },
  {
    name: 'subscription_started',
    description: 'First paid charge after a trial or directly.',
    category: 'Revenue',
    status: 'live',
    daily: 41,
    share: [0.6, 0.34, 0.06],
    perUser: 1,
    firstSeenDaysAgo: 200,
    releaseLift: 1.2,
    properties: [
      { name: 'plan_id', type: 'string', values: ['monthly_999', 'annual_5999'], coverage: 1 },
      { name: 'price_usd', type: 'number', values: [9.99, 59.99], decimals: 2, coverage: 1 },
    ],
  },
  {
    name: 'referral_sent',
    description: 'Shared an invite link. Planned for 2.5.0.',
    category: 'Growth',
    status: 'planned',
    daily: 0,
    share: [0, 0, 0],
    perUser: 1,
    firstSeenDaysAgo: 0,
    properties: [
      { name: 'channel', type: 'string', values: ['WhatsApp', 'Copy link'], coverage: 1 },
    ],
  },
  {
    name: 'debug_tap',
    description: 'Left in a test build. Blocked, so new ones are dropped.',
    category: 'Automatic',
    status: 'blocked',
    daily: 0,
    share: [0, 0, 0],
    perUser: 1,
    firstSeenDaysAgo: 19,
    properties: [],
  },
]

const dramaPalEvents: EventDefinition[] = [
  {
    name: 'session_started',
    description: 'A person opened the app after 30 minutes away.',
    category: 'Automatic',
    status: 'live',
    daily: 38000,
    share: [0.46, 0.54],
    perUser: 3.4,
    firstSeenDaysAgo: 88,
    properties: [{ name: 'session_id', type: 'string', coverage: 1 }],
  },
  {
    name: 'screen_viewed',
    description: 'A screen came into view.',
    category: 'Automatic',
    status: 'live',
    daily: 61000,
    share: [0.45, 0.55],
    perUser: 5.8,
    firstSeenDaysAgo: 88,
    properties: [
      {
        name: 'screen_name',
        type: 'string',
        values: ['For you', 'Series', 'Player', 'Coins', 'Profile'],
        coverage: 1,
      },
    ],
  },
  {
    name: 'app_installed',
    description: 'First open after a fresh install.',
    category: 'Automatic',
    status: 'live',
    daily: 900,
    share: [0.41, 0.59],
    perUser: 1,
    firstSeenDaysAgo: 88,
    properties: [],
  },
  {
    name: 'episode_started',
    description: 'Pressed play on an episode.',
    category: 'Watching',
    status: 'live',
    daily: 52000,
    share: [0.44, 0.56],
    perUser: 6.1,
    firstSeenDaysAgo: 88,
    properties: [
      {
        name: 'series',
        type: 'string',
        values: ['The Heir Returns', 'Contract Bride', 'Midnight Ward'],
        coverage: 1,
      },
      { name: 'episode', type: 'number', range: [1, 80], coverage: 1 },
    ],
  },
  {
    name: 'episode_completed',
    description: 'Watched an episode to the end.',
    category: 'Watching',
    status: 'live',
    daily: 39000,
    share: [0.44, 0.56],
    perUser: 5.2,
    firstSeenDaysAgo: 88,
    properties: [{ name: 'watch_s', type: 'number', range: [60, 140], coverage: 1 }],
  },
  {
    name: 'episode_unlocked',
    description: 'Spent coins to open a locked episode.',
    category: 'Revenue',
    status: 'live',
    daily: 8800,
    share: [0.48, 0.52],
    perUser: 2.2,
    firstSeenDaysAgo: 88,
    properties: [{ name: 'coins', type: 'number', values: [40, 60, 80], coverage: 1 }],
  },
  {
    name: 'ad_watched',
    description: 'Finished a rewarded ad for free coins.',
    category: 'Revenue',
    status: 'live',
    daily: 14500,
    share: [0.38, 0.62],
    perUser: 2.7,
    firstSeenDaysAgo: 70,
    properties: [{ name: 'reward_coins', type: 'number', values: [10, 20], coverage: 1 }],
  },
  {
    name: 'series_followed',
    description: 'Added a series to My list.',
    category: 'Growth',
    status: 'live',
    daily: 3100,
    share: [0.47, 0.53],
    perUser: 1.2,
    firstSeenDaysAgo: 88,
    properties: [],
  },
  {
    name: 'coins_purchased',
    description: 'Bought a coin pack in the store.',
    category: 'Revenue',
    status: 'live',
    daily: 620,
    share: [0.55, 0.45],
    perUser: 1,
    firstSeenDaysAgo: 88,
    properties: [
      { name: 'pack', type: 'string', values: ['300 coins', '1,000 coins'], coverage: 1 },
      { name: 'price_usd', type: 'number', values: [4.99, 14.99], decimals: 2, coverage: 1 },
    ],
  },
  {
    name: 'paywall_viewed',
    description: 'Saw the VIP subscription offer.',
    category: 'Revenue',
    status: 'live',
    daily: 2900,
    share: [0.5, 0.5],
    perUser: 1.4,
    firstSeenDaysAgo: 60,
    properties: [{ name: 'placement', type: 'string', values: ['Locked episode'], coverage: 1 }],
  },
  {
    name: 'subscription_started',
    description: 'Started VIP weekly or monthly.',
    category: 'Revenue',
    status: 'live',
    daily: 140,
    share: [0.57, 0.43],
    perUser: 1,
    firstSeenDaysAgo: 60,
    properties: [
      { name: 'plan_id', type: 'string', values: ['vip_weekly', 'vip_monthly'], coverage: 1 },
    ],
  },
]

export const initialProjects: Project[] = [
  {
    id: 'speaksix',
    name: 'SpeakSix',
    description: 'English speaking practice on iOS, Android and the web funnel.',
    hue: 'yellow',
    platforms: ['ios', 'android', 'web'],
    timezone: 'UTC',
    createdAt: '2026-04-08',
    sdk: { ios: 'kma-swift 1.2.0', android: 'kma-android 1.2.0', web: 'kma-js 1.3.1' },
    sample: true,
    dau: 3100,
    newUsers: 240,
    countries: [
      { name: 'Nigeria', code: 'NG', share: 0.31 },
      { name: 'Brazil', code: 'BR', share: 0.17 },
      { name: 'Vietnam', code: 'VN', share: 0.12 },
      { name: 'Mexico', code: 'MX', share: 0.09 },
      { name: 'Egypt', code: 'EG', share: 0.07 },
    ],
    versions: { current: '2.4.0', previous: '2.3.2', older: '2.2.5' },
    release: { label: '2.4.0 released', daysAgo: 12 },
    quietSource: { platform: 'web', minutes: 38 },
    allowedOrigins: ['speaksix.app', 'bc-learn-funnel.vercel.app'],
  },
  {
    id: 'dramapal',
    name: 'DramaPal',
    description: 'Short drama series with coins and a VIP pass.',
    hue: 'pink',
    platforms: ['ios', 'android'],
    timezone: 'UTC',
    createdAt: '2026-07-30',
    sdk: { ios: 'kma-swift 1.2.0', android: 'kma-android 1.1.4' },
    sample: true,
    dau: 12400,
    newUsers: 900,
    countries: [
      { name: 'United States', code: 'US', share: 0.34 },
      { name: 'Philippines', code: 'PH', share: 0.14 },
      { name: 'Indonesia', code: 'ID', share: 0.11 },
      { name: 'United Kingdom', code: 'GB', share: 0.08 },
      { name: 'Nigeria', code: 'NG', share: 0.06 },
    ],
    versions: { current: '3.8.1', previous: '3.8.0', older: '3.7.4' },
    allowedOrigins: [],
  },
  {
    id: 'gymlinx',
    name: 'GymLinx',
    description: 'Gym memberships and class bookings.',
    hue: 'green',
    platforms: ['ios'],
    timezone: 'UTC',
    createdAt: '2026-10-28',
    sdk: {},
    sample: false,
    dau: 0,
    newUsers: 0,
    countries: [],
    versions: { current: '1.0.0', previous: '1.0.0', older: '1.0.0' },
    allowedOrigins: [],
  },
]

export const eventCatalogs: Record<string, EventDefinition[]> = {
  speaksix: speakSixEvents,
  dramapal: dramaPalEvents,
}

export const initialKeys: ApiKey[] = [
  {
    id: 'key_ios',
    projectId: 'speaksix',
    name: 'Mobile apps',
    kind: 'client',
    environment: 'production',
    token: 'kma_pk_live_7Hq2Lx9VbN4tRw8cZm3K',
    suffix: 'Zm3K',
    createdAt: '2026-09-14',
    createdBy: 'Victory Onorhime',
    lastUsedMinutesAgo: 0,
    revokedAt: null,
  },
  {
    id: 'key_web',
    projectId: 'speaksix',
    name: 'Web funnel',
    kind: 'client',
    environment: 'production',
    token: 'kma_pk_live_Qe5Ty1Ua8Ws3Dk6Pf2Gh',
    suffix: 'f2Gh',
    createdAt: '2026-09-26',
    createdBy: 'Victory Onorhime',
    lastUsedMinutesAgo: 38,
    revokedAt: null,
  },
  {
    id: 'key_server',
    projectId: 'speaksix',
    name: 'Billing webhooks',
    kind: 'server',
    environment: 'production',
    token: null,
    suffix: '3f9a',
    createdAt: '2026-09-30',
    createdBy: 'Ada Nwosu',
    lastUsedMinutesAgo: 4,
    revokedAt: null,
  },
  {
    id: 'key_dev',
    projectId: 'speaksix',
    name: 'Local testing',
    kind: 'client',
    environment: 'development',
    token: 'kma_pk_test_Mn4Bv7Cx2Za9Sd1Fg5Hj',
    suffix: 'g5Hj',
    createdAt: '2026-09-14',
    createdBy: 'Victory Onorhime',
    lastUsedMinutesAgo: 8640,
    revokedAt: null,
  },
  {
    id: 'key_old',
    projectId: 'speaksix',
    name: 'Funnel v5',
    kind: 'client',
    environment: 'production',
    token: 'kma_pk_live_Lp0Ok9Ij8Uh7Yg6Tf5Rd',
    suffix: 'f5Rd',
    createdAt: '2026-09-15',
    createdBy: 'Victory Onorhime',
    lastUsedMinutesAgo: 31680,
    revokedAt: '2026-10-06',
  },
  {
    id: 'key_drama_mobile',
    projectId: 'dramapal',
    name: 'Mobile apps',
    kind: 'client',
    environment: 'production',
    token: 'kma_pk_live_Dp4Rm8Ql2Xs6Vn1Bk9Wc',
    suffix: 'k9Wc',
    createdAt: '2026-07-30',
    createdBy: 'Victory Onorhime',
    lastUsedMinutesAgo: 0,
    revokedAt: null,
  },
  {
    id: 'key_gym_ios',
    projectId: 'gymlinx',
    name: 'iOS app',
    kind: 'client',
    environment: 'production',
    token: 'kma_pk_live_Gy3Ln7Kx5Cv2Hb8Jm4Pq',
    suffix: 'm4Pq',
    createdAt: '2026-10-28',
    createdBy: 'Victory Onorhime',
    lastUsedMinutesAgo: null,
    revokedAt: null,
  },
]

export const initialMembers: Member[] = [
  {
    id: 'm_owner',
    name: 'Victory Onorhime',
    email: 'victory@nobrainerlab.com',
    role: 'Owner',
    status: 'active',
    lastActive: 'Now',
  },
  {
    id: 'm_ada',
    name: 'Ada Nwosu',
    email: 'ada@nobrainerlab.com',
    role: 'Developer',
    status: 'active',
    lastActive: '2 hours ago',
  },
  {
    id: 'm_tolu',
    name: 'Tolu Bakare',
    email: 'tolu@nobrainerlab.com',
    role: 'Analyst',
    status: 'invited',
    lastActive: 'Invited Oct 27',
  },
]

/** Time zones offered when creating a project; days and hours in charts follow it. */
export const timezones = [
  { value: 'UTC', label: 'UTC' },
  { value: 'Africa/Lagos', label: 'Lagos (WAT)' },
  { value: 'Europe/London', label: 'London' },
  { value: 'America/New_York', label: 'New York' },
  { value: 'America/Sao_Paulo', label: 'São Paulo' },
  { value: 'Asia/Ho_Chi_Minh', label: 'Ho Chi Minh City' },
]
