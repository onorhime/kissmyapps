import { hashString, noise, pickWeighted, randomToken, seededRandom } from './random'
import { eventCatalogs } from './sample'
import type { EventDefinition, Platform, Project, PropertySpec } from './sample'
import { DAY_MS, platformName } from './model'

export type PropertyValue = string | number | boolean

export type TrackedEvent = {
  id: string
  name: string
  time: number
  receivedAt: number
  userId: string
  deviceId: string
  platform: Platform
  properties: Record<string, PropertyValue>
  context: Record<string, PropertyValue>
  test?: boolean
}

export type SampleUser = {
  id: string
  deviceId: string
  platform: Platform
  country: string
  appVersion: string
  osVersion: string
  deviceModel: string
  plan: 'Free' | 'Trial' | 'Pro'
  firstSeen: number
  lastSeen: number
  events30d: number
  sessions30d: number
}

const devices: Record<Platform, string[]> = {
  ios: ['iPhone 15', 'iPhone 13', 'iPhone 16 Pro', 'iPhone SE (3rd gen)'],
  android: ['Galaxy A54', 'Redmi Note 13', 'Pixel 8a', 'Tecno Spark 20'],
  web: ['Chrome 141', 'Safari 26', 'Chrome 140 (Android)'],
  server: ['Server'],
}
const osVersions: Record<Platform, string[]> = {
  ios: ['iOS 26.0', 'iOS 18.6', 'iOS 26.1'],
  android: ['Android 15', 'Android 14', 'Android 16'],
  web: ['macOS', 'Windows 11', 'Android 15'],
  server: ['Node 22'],
}

const userCache = new Map<string, SampleUser[]>()

export function sampleUsers(project: Project, now: number): SampleUser[] {
  if (!project.sample) return []
  const key = `${project.id}:${Math.floor(now / DAY_MS)}`
  const cached = userCache.get(key)
  if (cached) return cached
  const random = seededRandom(hashString(`users:${project.id}`))
  const count = project.id === 'dramapal' ? 900 : 600
  const planWeights = project.id === 'dramapal' ? [0.88, 0.02, 0.1] : [0.78, 0.09, 0.13]
  const users: SampleUser[] = Array.from({ length: count }, () => {
    const platform = pickWeighted(
      project.platforms,
      project.platforms.map((platform) =>
        platform === 'web' ? 0.16 : platform === 'ios' ? 0.48 : 0.36,
      ),
      random(),
    )
    const country = pickWeighted(
      [...project.countries.map((entry) => entry.name), 'United Kingdom', 'India', 'Ghana'],
      [...project.countries.map((entry) => entry.share), 0.08, 0.08, 0.04],
      random(),
    )
    const projectAge = Math.max(1, Math.floor((now - Date.parse(project.createdAt)) / DAY_MS))
    const ageDays = Math.floor(Math.pow(random(), 1.6) * Math.min(160, projectAge))
    const lastDays = Math.min(ageDays, Math.floor(Math.pow(random(), 3) * 9))
    const firstSeen = now - ageDays * DAY_MS - Math.floor(random() * DAY_MS)
    const lastSeen = Math.max(
      firstSeen,
      now - lastDays * DAY_MS - Math.floor(random() * 6 * 3_600_000),
    )
    const appVersion =
      platform === 'web'
        ? 'web'
        : random() < 0.74
          ? project.versions.current
          : random() < 0.8
            ? project.versions.previous
            : project.versions.older
    const sessions = 1 + Math.floor(random() * Math.min(40, (ageDays + 1) * 1.4))
    return {
      id: `usr_${randomToken(6, random).toLowerCase()}`,
      deviceId: `dev_${randomToken(10, random)}`,
      platform,
      country,
      appVersion,
      osVersion: osVersions[platform][Math.floor(random() * osVersions[platform].length)],
      deviceModel: devices[platform][Math.floor(random() * devices[platform].length)],
      plan: pickWeighted(['Free', 'Trial', 'Pro'] as const, planWeights, random()),
      firstSeen,
      lastSeen,
      events30d: sessions * (8 + Math.floor(random() * 14)),
      sessions30d: sessions,
    }
  })
  users.sort((a, b) => b.lastSeen - a.lastSeen)
  userCache.set(key, users)
  return users
}

function propertyValue(spec: PropertySpec, random: () => number): PropertyValue {
  if (spec.values) return spec.values[Math.floor(random() * spec.values.length)]
  if (spec.type === 'boolean') return random() < 0.62
  if (spec.range) {
    const [min, max] = spec.range
    const value = min + random() * (max - min)
    return spec.decimals ? Number(value.toFixed(spec.decimals)) : Math.round(value)
  }
  if (spec.name === 'session_id') return `ses_${randomToken(8, random)}`
  if (spec.name === 'kma_click') return `clk_${randomToken(10, random)}`
  return randomToken(8, random)
}

export function eventProperties(event: EventDefinition, random: () => number) {
  const properties: Record<string, PropertyValue> = {}
  for (const spec of event.properties) {
    if (random() <= spec.coverage) properties[spec.name] = propertyValue(spec, random)
  }
  return properties
}

export function eventContext(project: Project, user: SampleUser): Record<string, PropertyValue> {
  return {
    platform: platformName(user.platform),
    app_version: user.appVersion,
    os_version: user.osVersion,
    device_model: user.deviceModel,
    country: user.country,
    library: project.sdk[user.platform] ?? 'kma-js 1.3.1',
  }
}

function weightsFor(project: Project, catalog: EventDefinition[], platform: Platform) {
  const platformIndex = project.platforms.indexOf(platform)
  return catalog.map((event) =>
    event.status === 'live' ? event.daily * (event.share[platformIndex] ?? 0) : 0,
  )
}

export type StreamOptions = {
  /** Platforms that are not sending right now. */
  silent?: Platform[]
}

/** One event for the live stream, from a person who would plausibly send it. */
export function nextEvent(
  project: Project,
  users: SampleUser[],
  time: number,
  random: () => number,
  options: StreamOptions = {},
): TrackedEvent | null {
  const catalog = eventCatalogs[project.id]
  if (!catalog || users.length === 0) return null
  const active = users.filter((user) => !options.silent?.includes(user.platform)).slice(0, 220)
  if (active.length === 0) return null
  const user = active[Math.floor(Math.pow(random(), 1.4) * active.length)]
  const event = pickWeighted(catalog, weightsFor(project, catalog, user.platform), random())
  if (event.status !== 'live') return null
  return {
    id: `evt_${randomToken(12, random)}`,
    name: event.name,
    time,
    receivedAt: time + 40 + Math.floor(random() * 900),
    userId: user.id,
    deviceId: user.deviceId,
    platform: user.platform,
    properties: eventProperties(event, random),
    context: eventContext(project, user),
  }
}

/** The last few minutes of traffic, so the live view opens full rather than empty. */
export function backfill(project: Project, users: SampleUser[], now: number, perSecond: number) {
  const random = seededRandom(hashString(`backfill:${project.id}:${Math.floor(now / 60_000)}`))
  const silent = project.quietSource ? [project.quietSource.platform] : []
  const events: TrackedEvent[] = []
  let time = now
  while (events.length < 120) {
    time -= Math.max(120, Math.round((-Math.log(1 - random()) / perSecond) * 1000))
    const event = nextEvent(project, users, time, random, { silent })
    if (event) events.push(event)
  }
  if (project.quietSource) {
    // The quiet source's final event, so "last event" and the stream agree.
    const quietUsers = users.filter((user) => user.platform === project.quietSource?.platform)
    const lastTime = now - project.quietSource.minutes * 60_000
    const event = nextEvent(project, quietUsers, lastTime, random)
    if (event) events.push(event)
  }
  return events.sort((a, b) => b.time - a.time)
}

export type TimelineSession = {
  start: number
  platform: Platform
  events: Array<{ name: string; time: number; detail: string }>
}

const journeys: Record<string, string[][]> = {
  speaksix: [
    [
      'session_started',
      'screen_viewed',
      'lesson_started',
      'speaking_score_recorded',
      'speaking_score_recorded',
      'lesson_completed',
      'streak_extended',
    ],
    [
      'session_started',
      'screen_viewed',
      'lesson_started',
      'speaking_score_recorded',
      'lesson_completed',
      'paywall_viewed',
    ],
    ['session_started', 'screen_viewed', 'screen_viewed', 'lesson_started'],
  ],
  speaksix_web: [
    [
      'funnel_entered',
      'slide_1_passed',
      'slide_2_passed',
      'slide_3_passed',
      'email_entered',
      'preferences_saved',
    ],
  ],
  dramapal: [
    [
      'session_started',
      'screen_viewed',
      'episode_started',
      'episode_completed',
      'episode_started',
      'episode_completed',
      'episode_unlocked',
    ],
    ['session_started', 'episode_started', 'ad_watched', 'episode_started', 'episode_completed'],
    ['session_started', 'screen_viewed', 'series_followed', 'episode_started', 'paywall_viewed'],
  ],
}

function detailFor(properties: Record<string, PropertyValue>): string {
  return Object.entries(properties)
    .filter(([key]) => key !== 'session_id')
    .slice(0, 2)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ')
}

export function userTimeline(project: Project, user: SampleUser): TimelineSession[] {
  const catalog = eventCatalogs[project.id] ?? []
  const random = seededRandom(hashString(`timeline:${user.id}`))
  const templates =
    user.platform === 'web' && journeys[`${project.id}_web`]
      ? journeys[`${project.id}_web`]
      : (journeys[project.id] ?? [])
  const sessionCount = Math.min(6, Math.max(1, Math.round(user.sessions30d / 3)))
  const sessions: TimelineSession[] = []
  let start = user.lastSeen - Math.floor(random() * 20 * 60_000)
  for (let index = 0; index < sessionCount && start >= user.firstSeen; index += 1) {
    const template = templates[Math.floor(random() * templates.length)] ?? []
    let time = start
    const events = template.map((name) => {
      const definition = catalog.find((event) => event.name === name)
      const entry = {
        name,
        time,
        detail: definition ? detailFor(eventProperties(definition, random)) : '',
      }
      time += 20_000 + Math.floor(random() * 150_000)
      return entry
    })
    sessions.push({ start, platform: user.platform, events: events.reverse() })
    start -= Math.floor((0.4 + random() * 1.8) * DAY_MS)
  }
  if (user.plan === 'Trial' || user.plan === 'Pro') {
    const first = sessions.at(-1)
    if (first) {
      const name = user.plan === 'Pro' ? 'subscription_started' : 'trial_started'
      if (catalog.some((event) => event.name === name)) {
        first.events.push({ name, time: first.start + 9 * 60_000, detail: 'plan_id monthly_999' })
        first.events.sort((a, b) => b.time - a.time)
      }
    }
  }
  return sessions
}

export function perSecond(project: Project, eventsPerDay: number): number {
  return Math.max(0.2, (eventsPerDay / 86_400) * (0.8 + 0.4 * noise(project.id, 'rate')))
}
