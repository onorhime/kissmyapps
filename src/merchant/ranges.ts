import type { Range } from './api'

export const rangeOptions: Array<{ value: Range; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
]

export const rangePhrase: Record<Range, string> = {
  today: 'today',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
  '90d': 'in the last 90 days',
}

export const previousPhrase: Record<Range, string> = {
  today: 'vs the same time yesterday',
  '7d': 'vs the 7 days before',
  '30d': 'vs the 30 days before',
  '90d': 'vs the 90 days before',
}
