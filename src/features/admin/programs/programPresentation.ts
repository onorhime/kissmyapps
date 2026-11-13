import type { AdminProgramReview } from '../api/programs'

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  education: 'Education',
  productivity: 'Productivity',
  health_fitness: 'Health and fitness',
  lifestyle: 'Lifestyle',
  finance: 'Finance',
  entertainment: 'Entertainment',
  games: 'Games',
  social: 'Social',
  utilities: 'Utilities',
  business: 'Business',
  shopping: 'Shopping',
  travel: 'Travel',
  food_drink: 'Food and drink',
  developer_tools: 'Developer tools',
  other: 'Other',
}

export function categoryLabel(category: string | null): string | null {
  if (!category) return null
  return (
    CATEGORY_LABELS[category] ??
    category.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
  )
}

/** Money in normal units: $20.00 for US dollars, 20.00 EUR for anything else. */
export function programMoney(minor: number, currency: string): string {
  const amount = (minor / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`
}

/** Basis points as a percentage: 3000 is 30%, 1250 is 12.5%. */
export function programPercent(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`
}

/**
 * What a creator earns, in one line: "30% of every payment for 12 months". Null when the
 * commission fields are incomplete.
 */
export function commissionHeadline(
  program: Pick<
    AdminProgramReview,
    | 'commissionType'
    | 'commissionRateBps'
    | 'commissionFixedMinor'
    | 'currency'
    | 'commissionDuration'
    | 'commissionMonths'
  >,
): string | null {
  const percent = program.commissionType === 'percent'
  const amount = percent
    ? program.commissionRateBps && programPercent(program.commissionRateBps)
    : program.commissionType === 'fixed' && program.commissionFixedMinor
      ? programMoney(program.commissionFixedMinor, program.currency)
      : null
  if (!amount) return null
  const join = percent ? 'of' : 'on'
  if (program.commissionDuration === 'first_payment') return `${amount} ${join} the first payment`
  if (program.commissionDuration === 'lifetime') return `${amount} ${join} every payment`
  if (program.commissionDuration === 'months' && program.commissionMonths) {
    const months = program.commissionMonths
    return `${amount} ${join} every payment for ${months} ${months === 1 ? 'month' : 'months'}`
  }
  return null
}

/** The commission line a reviewer reads: from the fields, or else from the agreement. */
export function commissionLine(program: AdminProgramReview): string | null {
  return (
    commissionHeadline(program) ??
    program.agreement?.summary.find((row) => row.label.toLowerCase() === 'commission')?.value ??
    null
  )
}

/** A landing page as a safe link: https only, shown without the scheme. */
export function landingLink(url: string | null): { href: string; label: string } | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return { href: parsed.toString(), label: `${parsed.host}${path}${parsed.search}` }
  } catch {
    return null
  }
}

export function countryName(code: string | null): string | null {
  if (!code) return null
  if (!/^[A-Z]{2}$/.test(code)) return code
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** "5 minutes ago", "2 hours ago", "3 days ago", then the date. */
export function relativeTime(iso: string | null, now: number): string | null {
  if (!iso) return null
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return null
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hours / 24)
  if (days <= 14) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  return `on ${fullDate(iso)}`
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export type ProgramStatusTone = 'live' | 'paused' | 'changes' | 'waiting' | 'quiet'

/** The status a reviewer sees on a reviewed program. */
export function programStatus(
  program: Pick<AdminProgramReview, 'status' | 'pauseReason'>,
): Readonly<{ label: string; tone: ProgramStatusTone }> {
  if (program.status === 'live') return { label: 'Live', tone: 'live' }
  if (program.status === 'changes_requested') return { label: 'Changes requested', tone: 'changes' }
  if (program.status === 'in_review') return { label: 'Waiting for review', tone: 'waiting' }
  if (program.status === 'paused') {
    if (program.pauseReason === 'admin') return { label: 'Paused by KissMyApps', tone: 'paused' }
    if (program.pauseReason === 'stripe_disconnected')
      return { label: 'Paused, Stripe disconnected', tone: 'paused' }
    return { label: 'Paused by merchant', tone: 'paused' }
  }
  return { label: program.status === 'draft' ? 'Draft' : 'Archived', tone: 'quiet' }
}

/** The first letter of a name, for a program with no logo. */
export function monogram(name: string): string {
  return (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? 'P').toUpperCase()
}
