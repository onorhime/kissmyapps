import { noise } from './random'
import { eventCatalogs } from './sample'
import type { EventDefinition, Platform, Project } from './sample'

export const HISTORY_DAYS = 180
export const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

export type Range = 'today' | '7d' | '30d' | '90d'
export const rangeDays: Record<Range, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90 }
export const rangeLabels: Record<Range, string> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
}

/** Evening-heavy day for consumer apps; the shares sum to 1. */
const hourShape = [
  1.1, 0.7, 0.5, 0.4, 0.4, 0.6, 1.4, 2.8, 4.1, 4.6, 4.7, 4.8, 5.1, 5.0, 4.8, 4.9, 5.2, 5.8, 6.6,
  7.4, 7.9, 7.4, 5.6, 3.0,
]
const hourTotal = hourShape.reduce((sum, value) => sum + value, 0)
const hourShare = hourShape.map((value) => value / hourTotal)
const weekdayFactor = [0.86, 1.04, 1.06, 1.05, 1.02, 0.97, 0.88]

export type Dataset = {
  project: Project
  events: EventDefinition[]
  platforms: Platform[]
  now: number
  /** Local midnight for each history day, oldest first; the last one is today. */
  dayStarts: number[]
  /** counts[event][platform][day]; today's value is the sum of its elapsed hours. */
  counts: number[][][]
  /** todayHours[event][platform][hour]; future hours are 0. */
  todayHours: number[][][]
  dau: number[]
  newUsers: number[]
  quietSince: number | null
  /** Index of the first day with any events. */
  firstDay: number
}

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Share of a day that has passed by `time`, weighted by the hourly traffic shape. */
export function elapsedShare(time: number): number {
  const date = new Date(time)
  const hour = date.getHours()
  const minuteShare = (date.getMinutes() + date.getSeconds() / 60) / 60
  let share = 0
  for (let index = 0; index < hour; index += 1) share += hourShare[index]
  return share + hourShare[hour] * minuteShare
}

/**
 * Share of a day's active people already seen by `elapsed`. Each person counts once, so
 * the count climbs faster than events do early in the day.
 */
function activeShare(elapsed: number): number {
  return Math.min(1, Math.pow(elapsed, 0.55))
}

function dayLevel(
  project: Project,
  event: EventDefinition | null,
  dayIndex: number,
  start: number,
) {
  const age = HISTORY_DAYS - 1 - dayIndex
  const trend = 0.78 + 0.22 * (1 - age / (HISTORY_DAYS - 1))
  const weekday = weekdayFactor[new Date(start).getDay()]
  const lift =
    event?.releaseLift && project.release && age < project.release.daysAgo ? event.releaseLift : 1
  return trend * weekday * lift
}

const datasetCache = new Map<string, Dataset>()

export function getDataset(project: Project, now: number): Dataset | null {
  const catalog = eventCatalogs[project.id]
  if (!project.sample || !catalog) return null
  const cacheKey = `${project.id}:${Math.floor(now / 60_000)}`
  const cached = datasetCache.get(cacheKey)
  if (cached) return cached

  const today = startOfDay(now)
  const dayStarts = Array.from({ length: HISTORY_DAYS }, (_, index) => {
    const date = new Date(today)
    date.setDate(date.getDate() - (HISTORY_DAYS - 1 - index))
    return date.getTime()
  })
  const quietSince = project.quietSource ? now - project.quietSource.minutes * 60_000 : null
  const quietPlatform = project.platforms.indexOf(project.quietSource?.platform ?? 'server')
  const todayIndex = HISTORY_DAYS - 1

  const counts: number[][][] = []
  const todayHours: number[][][] = []
  catalog.forEach((event, eventIndex) => {
    const byPlatform: number[][] = []
    const hoursByPlatform: number[][] = []
    project.platforms.forEach((platform, platformIndex) => {
      const share = event.share[platformIndex] ?? 0
      const days: number[] = []
      const hours = new Array<number>(24).fill(0)
      const born = HISTORY_DAYS - 1 - event.firstSeenDaysAgo
      dayStarts.forEach((start, dayIndex) => {
        if (event.status !== 'live' || share === 0 || dayIndex < born) {
          days.push(0)
          return
        }
        const level = dayLevel(project, event, dayIndex, start)
        const wobble = 0.94 + 0.12 * noise(project.id, event.name, platform, dayIndex)
        const full = event.daily * share * level * wobble
        if (dayIndex < todayIndex) {
          days.push(Math.round(full))
          return
        }
        // Today: integrate each elapsed hour, and stop a quiet source at the moment it went quiet.
        let total = 0
        for (let hour = 0; hour < 24; hour += 1) {
          const hourStart = start + hour * HOUR_MS
          const stop =
            platformIndex === quietPlatform && quietSince !== null ? Math.min(now, quietSince) : now
          const covered = Math.max(0, Math.min(HOUR_MS, stop - hourStart)) / HOUR_MS
          if (covered <= 0) continue
          const value = Math.round(
            full * hourShare[hour] * covered * (0.9 + 0.2 * noise(event.name, platform, hour)),
          )
          hours[hour] = value
          total += value
        }
        days.push(total)
      })
      byPlatform.push(days)
      hoursByPlatform.push(hours)
    })
    counts[eventIndex] = byPlatform
    todayHours[eventIndex] = hoursByPlatform
  })

  const elapsed = elapsedShare(now)
  const dau = dayStarts.map((start, dayIndex) => {
    const value =
      project.dau *
      dayLevel(project, null, dayIndex, start) *
      (0.95 + 0.1 * noise(project.id, 'dau', dayIndex))
    return Math.round(dayIndex === todayIndex ? value * activeShare(elapsed) : value)
  })
  const newUsers = dayStarts.map((start, dayIndex) => {
    const value =
      project.newUsers *
      dayLevel(project, null, dayIndex, start) *
      (0.85 + 0.3 * noise(project.id, 'new', dayIndex))
    return Math.round(dayIndex === todayIndex ? value * elapsed : value)
  })

  const dataset: Dataset = {
    project,
    events: catalog,
    platforms: project.platforms,
    now,
    dayStarts,
    counts,
    todayHours,
    dau,
    newUsers,
    quietSince,
    firstDay: firstDayWithData(counts),
  }
  datasetCache.set(cacheKey, dataset)
  return dataset
}

export type Filter = {
  events?: string[]
  platforms?: Platform[]
}

function included(dataset: Dataset, filter: Filter, eventIndex: number, platformIndex: number) {
  const event = dataset.events[eventIndex]
  if (filter.events && !filter.events.includes(event.name)) return false
  if (filter.platforms && !filter.platforms.includes(dataset.platforms[platformIndex])) return false
  return true
}

export type Point = { time: number; value: number; partial?: boolean }

/** Daily points for multi-day ranges, hourly points for today. */
export function volumeSeries(dataset: Dataset, range: Range, filter: Filter = {}): Point[] {
  const todayIndex = HISTORY_DAYS - 1
  if (range === 'today') {
    // The last 24 clock hours, so the chart has a shape just after midnight too.
    const todayStart = dataset.dayStarts[todayIndex]
    return lastHours(dataset.now).map((time, index, hours) => {
      const hour = new Date(time).getHours()
      let value = 0
      dataset.todayHours.forEach((platforms, eventIndex) =>
        platforms.forEach((hoursToday, platformIndex) => {
          if (!included(dataset, filter, eventIndex, platformIndex)) return
          if (time >= todayStart) {
            value += hoursToday[hour]
            return
          }
          const yesterday = dataset.counts[eventIndex][platformIndex][todayIndex - 1]
          const name = dataset.events[eventIndex].name
          const platform = dataset.platforms[platformIndex]
          value += Math.round(
            yesterday * hourShare[hour] * (0.9 + 0.2 * noise(name, platform, hour, 'yesterday')),
          )
        }),
      )
      return { time, value, partial: index === hours.length - 1 }
    })
  }
  const days = rangeDays[range]
  return dataset.dayStarts.slice(HISTORY_DAYS - days).map((time, offset) => {
    const dayIndex = HISTORY_DAYS - days + offset
    let value = 0
    dataset.counts.forEach((platforms, eventIndex) =>
      platforms.forEach((series, platformIndex) => {
        if (included(dataset, filter, eventIndex, platformIndex)) value += series[dayIndex]
      }),
    )
    return { time, value, partial: dayIndex === todayIndex }
  })
}

/** Start times of the last 24 clock hours, oldest first, ending with the current hour. */
export function lastHours(now: number): number[] {
  const current = new Date(now)
  current.setMinutes(0, 0, 0)
  return Array.from({ length: 24 }, (_, index) => current.getTime() - (23 - index) * HOUR_MS)
}

function sumWindow(dataset: Dataset, fromDay: number, toDay: number, filter: Filter): number {
  let total = 0
  dataset.counts.forEach((platforms, eventIndex) =>
    platforms.forEach((series, platformIndex) => {
      if (!included(dataset, filter, eventIndex, platformIndex)) return
      for (let day = Math.max(0, fromDay); day <= toDay; day += 1) total += series[day]
    }),
  )
  return total
}

export type Totals = {
  events: number
  previousEvents: number
  activeUsers: number
  previousActiveUsers: number
  newUsers: number
  previousNewUsers: number
  /** False when the project is younger than the current and previous windows together. */
  comparable: boolean
}

function stickiness(days: number) {
  return days <= 1 ? 1 : 1 + 0.55 * Math.log(days)
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

/**
 * Current window ends now; the previous window is the same length ending at the same
 * time of day, so a part-finished today is compared with a part-finished day.
 */
export function rangeTotals(dataset: Dataset, range: Range, filter: Filter = {}): Totals {
  const days = rangeDays[range]
  const todayIndex = HISTORY_DAYS - 1
  const elapsed = elapsedShare(dataset.now)
  const events = sumWindow(dataset, todayIndex - days + 1, todayIndex, filter)
  const previousFull = sumWindow(dataset, todayIndex - 2 * days + 1, todayIndex - days - 1, filter)
  const previousLastDay = sumWindow(dataset, todayIndex - days, todayIndex - days, filter)
  const previousEvents = Math.round(previousFull + previousLastDay * elapsed)

  const currentDau = dataset.dau.slice(todayIndex - days + 1)
  const previousDau = dataset.dau.slice(
    Math.max(0, todayIndex - 2 * days + 1),
    todayIndex - days + 1,
  )
  const activeUsers = Math.round(average(currentDau) * stickiness(days))
  const previousActiveUsers = Math.round(
    average(previousDau) * stickiness(days) * (days === 1 ? activeShare(elapsed) : 1),
  )
  const newUsers = dataset.newUsers
    .slice(todayIndex - days + 1)
    .reduce((sum, value) => sum + value, 0)
  const previousNew = dataset.newUsers.slice(
    Math.max(0, todayIndex - 2 * days + 1),
    todayIndex - days + 1,
  )
  const previousNewUsers = Math.round(
    previousNew.slice(0, -1).reduce((sum, value) => sum + value, 0) +
      (previousNew.at(-1) ?? 0) * elapsed,
  )
  return {
    events,
    previousEvents,
    activeUsers,
    previousActiveUsers,
    newUsers,
    previousNewUsers,
    comparable: dataset.firstDay <= previousStart(range),
  }
}

/** Index of the first day of the window before the current one. */
function previousStart(range: Range): number {
  return HISTORY_DAYS - 2 * rangeDays[range]
}

function firstDayWithData(counts: number[][][]): number {
  let first = HISTORY_DAYS - 1
  for (const platforms of counts) {
    for (const series of platforms) {
      const index = series.findIndex((value) => value > 0)
      if (index >= 0 && index < first) first = index
    }
  }
  return first
}

/** Whether an event existed for the whole previous window, so a change is meaningful. */
export function eventComparable(event: EventDefinition, range: Range): boolean {
  return HISTORY_DAYS - 1 - event.firstSeenDaysAgo <= previousStart(range)
}

export type EventSummary = {
  event: EventDefinition
  total: number
  previous: number
  users: number
  lastSeen: number | null
  platforms: Platform[]
}

export function eventSummaries(dataset: Dataset, range: Range): EventSummary[] {
  const days = rangeDays[range]
  const todayIndex = HISTORY_DAYS - 1
  const elapsed = elapsedShare(dataset.now)
  return dataset.events.map((event, eventIndex) => {
    const filter = { events: [event.name] }
    const total = sumWindow(dataset, todayIndex - days + 1, todayIndex, filter)
    const previous = Math.round(
      sumWindow(dataset, todayIndex - 2 * days + 1, todayIndex - days - 1, filter) +
        sumWindow(dataset, todayIndex - days, todayIndex - days, filter) * elapsed,
    )
    const perDay = dataset.counts[eventIndex]
      .reduce(
        (sums, series) => sums.map((sum, day) => sum + series[day]),
        new Array<number>(HISTORY_DAYS).fill(0),
      )
      .slice(todayIndex - days + 1)
    const dailyUsers = perDay.map((count, offset) =>
      Math.min(dataset.dau[todayIndex - days + 1 + offset], count / event.perUser),
    )
    const totalUsers = rangeTotals(dataset, range).activeUsers
    const users =
      total === 0 ? 0 : Math.min(totalUsers, Math.round(average(dailyUsers) * stickiness(days)))
    const platforms = dataset.platforms.filter(
      (_, platformIndex) => (event.share[platformIndex] ?? 0) > 0,
    )
    const lastSeen = lastSeenFor(dataset, event, eventIndex)
    return { event, total, previous, users, lastSeen, platforms }
  })
}

function lastSeenFor(dataset: Dataset, event: EventDefinition, eventIndex: number): number | null {
  if (event.status === 'blocked') return dataset.now - (event.firstSeenDaysAgo - 2) * DAY_MS
  if (event.status !== 'live') return null
  const onlyQuiet =
    dataset.quietSince !== null &&
    dataset.platforms.every(
      (platform, platformIndex) =>
        (event.share[platformIndex] ?? 0) === 0 ||
        platform === dataset.project.quietSource?.platform,
    )
  if (onlyQuiet && dataset.quietSince !== null) {
    return dataset.quietSince - Math.round(noise(event.name, 'last') * 90_000)
  }
  const perSecond =
    dataset.counts[eventIndex].reduce((sum, series) => sum + series[HISTORY_DAYS - 2], 0) / 86_400
  const gap =
    perSecond > 0
      ? Math.min(3_600_000, (1 / perSecond) * 1000 * (0.4 + noise(event.name, 'gap')))
      : 0
  return dataset.now - Math.round(gap)
}

export type Breakdown = 'none' | 'platform' | 'country' | 'version'
export type Measure = 'uniques' | 'totals' | 'perUser'

export type SeriesLine = { key: string; label: string; points: Point[]; total: number }

/** Splits a count into named parts that always add back up to the count. */
function splitCount(count: number, shares: number[], salt: string): number[] {
  const parts = shares.map((share, index) =>
    Math.floor(count * share * (0.96 + 0.08 * noise(salt, index))),
  )
  const assigned = parts.reduce((sum, value) => sum + value, 0)
  parts.push(Math.max(0, count - assigned))
  return parts
}

function versionShares(project: Project, dayIndex: number): number[] {
  const releaseDay = project.release ? HISTORY_DAYS - 1 - project.release.daysAgo : HISTORY_DAYS
  const since = dayIndex - releaseDay
  const current = since < 0 ? 0 : Math.min(0.82, 0.18 + since * 0.06)
  const older = 0.06
  return [current, Math.max(0, 0.94 - current - older), older]
}

export function exploreSeries(
  dataset: Dataset,
  eventName: string,
  range: Exclude<Range, 'today'>,
  measure: Measure,
  breakdown: Breakdown,
  /** Days back: the previous window uses offset = the range length. */
  offset = 0,
): SeriesLine[] {
  const eventIndex = dataset.events.findIndex((event) => event.name === eventName)
  if (eventIndex < 0) return []
  const event = dataset.events[eventIndex]
  const days = rangeDays[range]
  const first = HISTORY_DAYS - days - offset
  if (first < 0) return []
  const dayIndexes = Array.from({ length: days }, (_, index) => first + index)
  // A previous window ends on a whole day; trim it to the share of today that has passed.
  const lastScale = offset > 0 ? elapsedShare(dataset.now) : 1
  const platforms = dataset.platforms

  // Raw counts per group per day, before the chosen measure is applied.
  let groups: Array<{ key: string; label: string; counts: number[] }>
  if (breakdown === 'platform') {
    groups = platforms
      .map((platform, platformIndex) => ({
        key: platform,
        label: platformName(platform),
        counts: dayIndexes.map((day) => dataset.counts[eventIndex][platformIndex][day]),
      }))
      .filter((group) => group.counts.some((value) => value > 0))
  } else if (breakdown === 'country' || breakdown === 'version') {
    const labels =
      breakdown === 'country'
        ? [...dataset.project.countries.slice(0, 3).map((country) => country.name), 'Other']
        : [
            dataset.project.versions.current,
            dataset.project.versions.previous,
            dataset.project.versions.older,
            'Web',
          ]
    const columns = dayIndexes.map((day) => {
      const count = dataset.counts[eventIndex].reduce((sum, series) => sum + series[day], 0)
      if (breakdown === 'country') {
        return splitCount(
          count,
          dataset.project.countries.slice(0, 3).map((country) => country.share),
          `${event.name}:${day}`,
        )
      }
      const webIndex = platforms.indexOf('web')
      const web = webIndex >= 0 ? dataset.counts[eventIndex][webIndex][day] : 0
      const mobile = splitCount(
        count - web,
        versionShares(dataset.project, day).slice(0, 2),
        `${event.name}:v:${day}`,
      )
      return [...mobile, web]
    })
    groups = labels
      .map((label, index) => ({
        key: label,
        label,
        counts: columns.map((column) => column[index] ?? 0),
      }))
      .filter((group) => group.counts.some((value) => value > 0))
  } else {
    groups = [
      {
        key: 'all',
        label: event.name,
        counts: dayIndexes.map((day) =>
          dataset.counts[eventIndex].reduce((sum, series) => sum + series[day], 0),
        ),
      },
    ]
  }

  return groups.map((group) => {
    const values = group.counts.map((rawCount, index) => {
      const count = index === days - 1 ? Math.round(rawCount * lastScale) : rawCount
      const dau = dataset.dau[dayIndexes[index]]
      const users = Math.min(dau, Math.round(count / event.perUser))
      if (measure === 'totals') return count
      if (measure === 'uniques') return users
      return users === 0 ? 0 : Math.round((count / users) * 100) / 100
    })
    const points = values.map((value, index) => ({
      time: dataset.dayStarts[dayIndexes[index]],
      value,
      partial: dayIndexes[index] === HISTORY_DAYS - 1,
    }))
    const total =
      measure === 'perUser'
        ? Math.round(average(values.filter((value) => value > 0)) * 100) / 100
        : values.reduce((sum, value) => sum + value, 0)
    return { key: group.key, label: group.label, points, total }
  })
}

export function platformName(platform: Platform): string {
  return { ios: 'iOS', android: 'Android', web: 'Web', server: 'Server' }[platform]
}

/** Expected events per minute for one platform at a moment, for the arriving-now strip. */
export function minuteRate(dataset: Dataset, platform: Platform, time: number): number {
  const platformIndex = dataset.platforms.indexOf(platform)
  if (platformIndex < 0) return 0
  const hour = new Date(time).getHours()
  let daily = 0
  dataset.events.forEach((_event, eventIndex) => {
    daily += dataset.counts[eventIndex][platformIndex][HISTORY_DAYS - 2]
  })
  return (daily * hourShare[hour]) / 60
}

export function minuteStrip(dataset: Dataset, platform: Platform, minutes = 60): Point[] {
  const end = Math.floor(dataset.now / 60_000) * 60_000
  return Array.from({ length: minutes }, (_, index) => {
    const time = end - (minutes - 1 - index) * 60_000
    const quiet =
      dataset.project.quietSource?.platform === platform &&
      dataset.quietSince !== null &&
      time >= dataset.quietSince
    const rate = minuteRate(dataset, platform, time)
    const value = quiet ? 0 : Math.round(rate * (0.75 + 0.5 * noise(platform, time)))
    return { time, value, partial: index === minutes - 1 }
  })
}
