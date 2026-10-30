import type { FunnelBreakdown, Platform } from './api'
import { countryName, deviceTypeLabels, platformLabels } from './format'

/** The ways a report can split people, by where each person was first seen. */
export type GroupBy = Exclude<FunnelBreakdown, 'none'>

export const groupOptions: Array<{ value: GroupBy; label: string }> = [
  { value: 'device', label: 'By device' },
  { value: 'platform', label: 'By platform' },
  { value: 'country', label: 'By country' },
  { value: 'browser', label: 'By browser' },
  { value: 'source', label: 'By source' },
]

export const groupNouns: Record<GroupBy, string> = {
  device: 'Device',
  platform: 'Platform',
  country: 'Country',
  browser: 'Browser',
  source: 'Source',
}

export function groupLabel(groupBy: GroupBy, key: string): string {
  if (key === 'Unknown') return 'Unknown'
  if (groupBy === 'country') return countryName(key)
  if (groupBy === 'device') return deviceTypeLabels[key] ?? key
  if (groupBy === 'platform') return platformLabels[key as Platform] ?? key
  return key
}
