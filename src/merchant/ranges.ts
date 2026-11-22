import type { CustomRange, PresetRange, Range } from './api'

export const rangeOptions: Array<{ value: Range; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
]

const presetPhrases: Record<PresetRange, string> = {
  today: 'today',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
  '90d': 'in the last 90 days',
}

const previousPhrases: Record<PresetRange, string> = {
  today: 'vs the same time yesterday',
  '7d': 'vs the 7 days before',
  '30d': 'vs the 30 days before',
  '90d': 'vs the 90 days before',
}

export function isCustomRange(range: string): range is CustomRange {
  if (!/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(range)) return false
  const [from, to] = range.split('..')
  const dates = [new Date(from), new Date(to)]
  return (
    dates.every(
      (date, i) =>
        Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === [from, to][i],
    ) &&
    from <= to &&
    dates[1].getTime() - dates[0].getTime() < 366 * 86_400_000
  )
}

export function rangePhrase(range: Range): string {
  return isCustomRange(range)
    ? `from ${range.split('..').join(' to ')}`
    : presetPhrases[range as PresetRange]
}

export function previousPhrase(range: Range): string {
  return isCustomRange(range)
    ? 'vs the preceding period of the same length'
    : previousPhrases[range as PresetRange]
}
