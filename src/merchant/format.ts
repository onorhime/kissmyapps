const integer = new Intl.NumberFormat('en-US')
const oneDecimal = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})
const twoDecimals = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatCount(value: number): string {
  return integer.format(Math.round(value))
}

export function formatDecimal(value: number): string {
  return twoDecimals.format(value)
}

/** Axis ticks: 0, 500, 1K, 2.5K, 1.2M. */
export function formatCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (abs >= 1_000) return `${trim(value / 1_000)}K`
  return trim(value)
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : oneDecimal.format(value).replace(/\.0$/, '')
}

export type Tone = 'positive' | 'negative' | 'neutral'

/** A change with its sign, coloured by whether the move is good for this metric. */
export function formatChange(
  current: number,
  previous: number,
  goodWhenUp = true,
): { text: string; tone: Tone } {
  if (previous === 0) {
    return current === 0
      ? { text: '0%', tone: 'neutral' }
      : { text: `+${formatCount(current)} (new)`, tone: 'neutral' }
  }
  // Percentages on small counts swing wildly, so show the difference instead.
  if (Number.isInteger(current) && Number.isInteger(previous) && Math.max(current, previous) < 20) {
    const difference = current - previous
    if (difference === 0) return { text: 'No change', tone: 'neutral' }
    return {
      text: `${difference > 0 ? '+' : '−'}${formatCount(Math.abs(difference))}`,
      tone: difference > 0 === goodWhenUp ? 'positive' : 'negative',
    }
  }
  const change = ((current - previous) / previous) * 100
  if (Math.abs(change) < 0.05) return { text: '0.0%', tone: 'neutral' }
  const up = change > 0
  return {
    text: `${up ? '+' : '−'}${oneDecimal.format(Math.abs(change))}%`,
    tone: up === goodWhenUp ? 'positive' : 'negative',
  }
}

export function formatAgo(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  return formatDate(time)
}

const clockFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
const shortTime = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const longDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

export function formatClock(time: number): string {
  return clockFormat.format(time)
}

export function formatTime(time: number): string {
  return shortTime.format(time)
}

export function formatDate(time: number): string {
  return dateFormat.format(time)
}

export function formatLongDate(time: number | string): string {
  return longDate.format(typeof time === 'string' ? new Date(`${time}T12:00:00`) : time)
}

export function formatDateTime(time: number): string {
  return `${formatLongDate(time)}, ${formatClock(time)}`
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`
}
