export type PortalPage = 'performance' | 'payouts' | 'links' | 'profile'
export type ProfileSection = 'details' | 'payment' | 'terms' | 'documents' | 'security'
export type PreviewState = 'sample' | 'empty' | 'loading' | 'error' | 'partial'
export type ReportingPeriod = '7' | '30' | '90'
export type ReportMetric = 'earningsMinor' | 'purchases' | 'clicks'

export type PerformanceRecord = {
  date: string
  source: string
  campaign: string
  funnel: string
  country: string
  subId: string
  clicks: number
  visitors: number
  leads: number
  trials: number
  installs: number
  purchases: number
  renewals: number
  cancellations: number
  activations: number
  refunds: number
  eligibleRevenueMinor: number
  earningsMinor: number
}

export type ReportFilters = {
  period: ReportingPeriod
  source: string
  country: string
  campaign: string
  funnel: string
  subId: string
}

export const defaultFilters: ReportFilters = {
  period: '30',
  source: 'all',
  country: 'all',
  campaign: 'all',
  funnel: 'all',
  subId: '',
}

export const previewSources = [
  'Social media',
  'Paid search',
  'Newsletter',
  'Content & SEO',
  'Direct / untagged',
]
export const previewCountries = ['United States', 'United Kingdom', 'Canada']
export const previewCampaigns = ['Example launch', 'Example evergreen']
export const previewFunnels = ['Example funnel A', 'Example funnel B']

// UI-only, deterministic fixtures. These records are never sent to Supabase.
export const previewRecords: PerformanceRecord[] = Array.from({ length: 90 }, (_, day) => {
  const date = new Date(Date.UTC(2026, 7, 26 - 89 + day)).toISOString().slice(0, 10)
  return previewSources.map((source, sourceIndex) => {
    const wave = Math.sin(day / 3.2 + sourceIndex) * 19
    const clicks = Math.max(12, Math.round(225 - sourceIndex * 39 + day * 0.9 + wave))
    const purchases = Math.round(clicks * (0.016 + sourceIndex * 0.0018))
    const renewals = (day + sourceIndex) % 3 === 0 ? 2 : 1
    const refunds = (day + sourceIndex) % 19 === 0 ? 1 : 0
    const eligibleRevenueMinor = (purchases + renewals) * 2490 - refunds * 2490
    return {
      date,
      source,
      campaign: previewCampaigns[sourceIndex % 2],
      funnel: previewFunnels[sourceIndex % 2],
      country: previewCountries[(day + sourceIndex) % 3],
      subId: sourceIndex === 4 ? 'untagged' : `placement-${sourceIndex + 1}`,
      clicks,
      visitors: Math.round(clicks * 0.82),
      leads: Math.round(clicks * 0.16),
      trials: Math.round(clicks * 0.06),
      installs: Math.round(clicks * 0.07),
      purchases,
      renewals,
      cancellations: (day + sourceIndex) % 11 === 0 ? 1 : 0,
      activations: Math.round(clicks * 0.048),
      refunds,
      eligibleRevenueMinor,
      earningsMinor: Math.round(eligibleRevenueMinor * 0.3),
    }
  })
}).flat()

export function filterRecords(filters: ReportFilters): PerformanceRecord[] {
  const firstDate = new Date(Date.UTC(2026, 7, 27 - Number(filters.period)))
    .toISOString()
    .slice(0, 10)
  return previewRecords.filter(
    (row) =>
      row.date >= firstDate &&
      row.date <= '2026-08-26' &&
      (filters.source === 'all' || row.source === filters.source) &&
      (filters.country === 'all' || row.country === filters.country) &&
      (filters.campaign === 'all' || row.campaign === filters.campaign) &&
      (filters.funnel === 'all' || row.funnel === filters.funnel) &&
      (!filters.subId || row.subId.toLowerCase().includes(filters.subId.toLowerCase())),
  )
}

export function sumMetric(rows: PerformanceRecord[], key: keyof PerformanceRecord): number {
  return rows.reduce(
    (total, row) => total + (typeof row[key] === 'number' ? (row[key] as number) : 0),
    0,
  )
}

export function money(minorUnits: number, currency = 'USD'): string {
  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency })
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2
  return formatter.format(minorUnits / 10 ** digits)
}

export function number(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`))
}

export function periodLabel(period: ReportingPeriod): string {
  const start = new Date(Date.UTC(2026, 7, 27 - Number(period))).toISOString().slice(0, 10)
  return `${shortDate(start)} – Aug 26, 2026`
}

export function chartData(
  rows: PerformanceRecord[],
  metric: ReportMetric,
  period: ReportingPeriod,
) {
  // Fixture records are complete; a filtered day with no matches is a known zero.
  // A live adapter must preserve null for unavailable data instead of filling it with zero.
  const byDay = new Map<string, number>()
  for (let day = 0; day < Number(period); day++) {
    const date = new Date(Date.UTC(2026, 7, 27 - Number(period) + day)).toISOString().slice(0, 10)
    byDay.set(date, 0)
  }
  rows.forEach((row) => byDay.set(row.date, (byDay.get(row.date) ?? 0) + row[metric]))
  return Array.from(byDay, ([date, value]) => ({
    date: shortDate(date),
    value: metric === 'earningsMinor' ? value / 100 : value,
  }))
}

export function csvContent(headers: string[], rows: (string | number)[][]): string {
  const escape = (value: string | number) => {
    const text = String(value)
    const safe = /^[=+@\-\t\r]/.test(text) && typeof value !== 'number' ? `'${text}` : text
    return `"${safe.replaceAll('"', '""')}"`
  }
  return [headers, ...rows].map((row) => row.map(escape).join(',')).join('\r\n')
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const url = URL.createObjectURL(
    new Blob([csvContent(headers, rows)], { type: 'text/csv;charset=utf-8;' }),
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export type PayoutStatus =
  'open' | 'review' | 'approved' | 'scheduled' | 'paid' | 'on_hold' | 'failed' | 'carried_forward'
export const payoutStatusLabels: Record<PayoutStatus, string> = {
  open: 'Open',
  review: 'Pending review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  paid: 'Paid',
  on_hold: 'On hold',
  failed: 'Failed',
  carried_forward: 'Carried forward',
}

export type PreviewPayout = {
  id: string
  start: string
  end: string
  due: string
  status: PayoutStatus
  earningsMinor: number
  adjustmentsMinor: number
  finalMinor: number
  eligibleRevenueMinor: number
  statement: string | null
}

export const previewPayouts: PreviewPayout[] = Array.from({ length: 6 }, (_, index) => {
  const start = new Date(Date.UTC(2026, 7, 17 - index * 14)).toISOString().slice(0, 10)
  const end = new Date(Date.UTC(2026, 7, 30 - index * 14)).toISOString().slice(0, 10)
  const due = new Date(Date.UTC(2026, 8, 4 - index * 14)).toISOString().slice(0, 10)
  const rows = previewRecords.filter((row) => row.date >= start && row.date <= end)
  const earningsMinor = sumMetric(rows, 'earningsMinor')
  const adjustmentsMinor = index === 2 ? -1494 : 0
  return {
    id: `sample-payout-${index + 1}`,
    start,
    end,
    due,
    status: index === 0 ? 'open' : 'paid',
    earningsMinor,
    adjustmentsMinor,
    finalMinor: earningsMinor + adjustmentsMinor,
    eligibleRevenueMinor: sumMetric(rows, 'eligibleRevenueMinor'),
    statement: index === 0 ? null : `SAMPLE-2026-${String(7 - index).padStart(4, '0')}`,
  }
})

export type PreviewLink = {
  id: string
  name: string
  source: string
  campaign: string
  subId: string
  sub2: string
  sub3: string
  funnel: string
  archived: boolean
  parentId?: string
  active: boolean
  clicks: number
  leads: number
  installs: number
  purchases: number
  earningsMinor: number
}

export const previewLinks: PreviewLink[] = previewSources.slice(0, 4).map((source, index) => {
  const rows = filterRecords(defaultFilters).filter((row) => row.source === source)
  return {
    id: `sample-link-${index + 1}`,
    name: ['Social bio', 'Search campaign', 'Weekly newsletter', 'Content partnership'][index],
    source,
    campaign: previewCampaigns[index % 2],
    subId: `placement-${index + 1}`,
    sub2: '',
    sub3: '',
    funnel: previewFunnels[index % 2],
    archived: false,
    active: index !== 3,
    clicks: sumMetric(rows, 'clicks'),
    leads: sumMetric(rows, 'leads'),
    installs: sumMetric(rows, 'installs'),
    purchases: sumMetric(rows, 'purchases'),
    earningsMinor: sumMetric(rows, 'earningsMinor'),
  }
})

export const mainPreviewUrl = 'https://go.example.invalid/r/preview-partner'

export function trackedPreviewUrl(
  link: Pick<PreviewLink, 'source' | 'subId' | 'campaign' | 'funnel' | 'sub2' | 'sub3'>,
): string {
  const slug = link.source.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')
  const params = new URLSearchParams({
    campaign: link.campaign,
    funnel: link.funnel,
    sub1: link.subId,
  })
  if (link.sub2) params.set('sub2', link.sub2)
  if (link.sub3) params.set('sub3', link.sub3)
  return `${mainPreviewUrl}/${slug}?${params}`
}

export type NotificationCategory =
  'statements' | 'payouts' | 'verification' | 'signatures' | 'adjustments' | 'inactiveLinks'
export type PreviewProfile = {
  fullName: string
  publicName: string
  legalName: string
  entityType: 'Individual' | 'Company'
  country: string
  timezone: string
  preferredCurrency: string
  website: string
  category: string
  audienceDescription: string
  audienceCountries: string[]
  channels: string[]
  channelDetails: string
  notifications: Record<NotificationCategory, boolean>
}

export const defaultProfile: PreviewProfile = {
  fullName: 'Preview partner',
  publicName: 'Example partner studio',
  legalName: 'Example Partner Studio (fictional)',
  entityType: 'Company',
  country: 'United States',
  timezone: 'UTC',
  preferredCurrency: 'USD',
  website: 'https://studio.example.invalid',
  category: 'Education',
  audienceDescription: 'An example community exploring useful apps and digital learning.',
  audienceCountries: ['United States', 'United Kingdom'],
  channels: ['Newsletter', 'Website / blog'],
  channelDetails: 'Example weekly newsletter and studio.example.invalid. Fictional channels only.',
  notifications: {
    statements: true,
    payouts: true,
    verification: true,
    signatures: true,
    adjustments: true,
    inactiveLinks: true,
  },
}

export type ReportGrouping = 'source' | 'day' | 'week' | 'month'
export function groupedReport(rows: PerformanceRecord[], grouping: ReportGrouping) {
  const groups = new Map<string, PerformanceRecord[]>()
  for (const row of rows) {
    let group = row.source
    if (grouping === 'day') group = row.date
    if (grouping === 'month') group = row.date.slice(0, 7)
    if (grouping === 'week') {
      const date = new Date(`${row.date}T00:00:00Z`)
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
      group = date.toISOString().slice(0, 10)
    }
    groups.set(group, [...(groups.get(group) ?? []), row])
  }
  return Array.from(groups, ([key, values]) => ({
    key,
    label:
      grouping === 'source'
        ? key
        : grouping === 'month'
          ? new Intl.DateTimeFormat('en-US', {
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC',
            }).format(new Date(`${key}-01T00:00:00Z`))
          : `${grouping === 'week' ? 'Week of ' : ''}${shortDate(key)}`,
    clicks: sumMetric(values, 'clicks'),
    leads: sumMetric(values, 'leads'),
    purchases: sumMetric(values, 'purchases'),
    earningsMinor: sumMetric(values, 'earningsMinor'),
  }))
}
