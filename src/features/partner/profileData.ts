import { sampleAgreement } from './payoutData'
import type { NotificationCategory, PreviewProfile } from './data'

export const profileCountries = [
  'United States',
  'United Kingdom',
  'Canada',
  'Nigeria',
  'Germany',
  'Other',
]
export const profileTimezones = [
  'UTC',
  'Africa/Lagos',
  'America/New_York',
  'Europe/London',
  'Asia/Dubai',
]
export const profileCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'NGN']
export const partnerCategories = [
  'Education',
  'Technology',
  'Lifestyle',
  'Entertainment',
  'Business',
  'Other',
]
export const professionalChannels = [
  'YouTube',
  'Instagram',
  'TikTok',
  'Newsletter',
  'Website / blog',
  'Paid ads',
  'Other',
]
export const notificationOptions: {
  id: NotificationCategory
  label: string
  description: string
}[] = [
  { id: 'statements', label: 'Statements', description: 'A new statement is available to review.' },
  {
    id: 'payouts',
    label: 'Payouts',
    description: 'A payout moves through review, scheduling, or payment.',
  },
  {
    id: 'verification',
    label: 'Verification',
    description: 'Account or payment-destination verification needs attention.',
  },
  {
    id: 'signatures',
    label: 'Signatures',
    description: 'A partnership document is ready for signature or countersignature.',
  },
  {
    id: 'adjustments',
    label: 'Refund & dispute adjustments',
    description: 'A refund or dispute affects your commission ledger.',
  },
  {
    id: 'inactiveLinks',
    label: 'Inactive links',
    description: 'A tracked link is paused, archived, or otherwise unavailable.',
  },
]

export type ProfileErrors = Partial<Record<keyof PreviewProfile, string>>
export function normalizeProfile(profile: PreviewProfile): PreviewProfile {
  return {
    ...profile,
    fullName: profile.fullName.trim(),
    publicName: profile.publicName.trim(),
    legalName: profile.legalName.trim(),
    website: profile.website.trim(),
    audienceDescription: profile.audienceDescription.trim(),
    channelDetails: profile.channelDetails.trim(),
    audienceCountries: [...new Set(profile.audienceCountries)],
    channels: [...new Set(profile.channels)],
    notifications: { ...profile.notifications },
  }
}
export function validateProfile(profile: PreviewProfile): ProfileErrors {
  const value = normalizeProfile(profile)
  const errors: ProfileErrors = {}
  if (!value.fullName || value.fullName.length > 80)
    errors.fullName = 'Enter a name and public partner name.'
  if (!value.publicName || value.publicName.length > 100)
    errors.publicName = 'Enter a name and public partner name.'
  if (!value.legalName || value.legalName.length > 120)
    errors.legalName = 'Enter a fictional legal individual or company name.'
  if (value.website) {
    try {
      const url = new URL(value.website)
      if (
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.invalid') ||
        url.username ||
        url.password ||
        value.website.length > 200
      )
        throw new Error('Not a fictional HTTPS website')
    } catch {
      errors.website =
        'Use an https:// website ending in .invalid, or leave it blank. No real websites in this preview.'
    }
  }
  if (value.audienceDescription.length > 1000)
    errors.audienceDescription = 'Keep the audience description to 1,000 characters.'
  if (value.channelDetails.length > 1000)
    errors.channelDetails = 'Keep channel details to 1,000 characters.'
  return errors
}

export const agreementVersions = [
  {
    id: 'v1',
    label: 'Example agreement · v1',
    status: 'Active',
    current: true,
    effective: '2026-01-01',
    expires: null,
    created: '2025-12-29',
    agreement: sampleAgreement,
  },
  {
    id: 'v2',
    label: 'Example agreement · v2',
    status: 'Draft',
    current: false,
    effective: null,
    expires: null,
    created: '2026-08-20',
    agreement: sampleAgreement,
  },
] as const

export const documentTypes = [
  'Partnership Agreement',
  'Partner Program Terms',
  'Commission or Revenue Share Schedule',
  'Content and Brand Usage Addendum',
  'Amendment',
  'Renewal',
  'Tax / invoice document',
] as const
export const documentStatuses = [
  'Draft',
  'Awaiting Partner Signature',
  'Awaiting KissMyApps Signature',
  'Signed',
  'Active',
  'Superseded',
  'Expired',
  'Terminated',
] as const
export type DocumentStatus = (typeof documentStatuses)[number]
export type DocumentSignature = {
  status: 'Not requested' | 'Awaiting signature' | 'Signed'
  at: string | null
}
export type PartnerDocument = {
  id: string
  name: string
  type: (typeof documentTypes)[number]
  version: string
  status: DocumentStatus
  created: string
  effective: string | null
  expires: string | null
  terminated: string | null
  partner: DocumentSignature
  company: DocumentSignature
  supersedes?: string
  supersededBy?: string
  privateStoragePath: null
}
const notRequested: DocumentSignature = { status: 'Not requested', at: null }
const awaiting: DocumentSignature = { status: 'Awaiting signature', at: null }
const signed = (at: string): DocumentSignature => ({ status: 'Signed', at })
export const partnerDocuments: PartnerDocument[] = [
  {
    id: 'sample-doc-1',
    name: 'Partner agreement',
    type: 'Partnership Agreement',
    version: 'v1',
    status: 'Active',
    created: '2025-12-29',
    effective: '2026-01-01',
    expires: null,
    terminated: null,
    partner: signed('2025-12-30T09:00:00Z'),
    company: signed('2025-12-31T10:00:00Z'),
    privateStoragePath: null,
  },
  {
    id: 'sample-doc-2',
    name: 'Commercial terms addendum',
    type: 'Amendment',
    version: 'v2',
    status: 'Draft',
    created: '2026-08-20',
    effective: null,
    expires: null,
    terminated: null,
    partner: notRequested,
    company: notRequested,
    privateStoragePath: null,
  },
  {
    id: 'sample-doc-3',
    name: 'Partner declaration',
    type: 'Tax / invoice document',
    version: 'v1',
    status: 'Awaiting Partner Signature',
    created: '2026-08-21',
    effective: null,
    expires: null,
    terminated: null,
    partner: awaiting,
    company: notRequested,
    privateStoragePath: null,
  },
  {
    id: 'sample-doc-4',
    name: 'Partner program terms',
    type: 'Partner Program Terms',
    version: 'v1',
    status: 'Awaiting KissMyApps Signature',
    created: '2026-08-18',
    effective: null,
    expires: null,
    terminated: null,
    partner: signed('2026-08-20T11:15:00Z'),
    company: awaiting,
    privateStoragePath: null,
  },
  {
    id: 'sample-doc-5',
    name: 'Commission schedule',
    type: 'Commission or Revenue Share Schedule',
    version: 'v1',
    status: 'Signed',
    created: '2026-08-17',
    effective: '2026-09-14',
    expires: null,
    terminated: null,
    partner: signed('2026-08-19T10:00:00Z'),
    company: signed('2026-08-20T14:00:00Z'),
    privateStoragePath: null,
  },
  {
    id: 'sample-doc-6',
    name: 'Content and brand usage',
    type: 'Content and Brand Usage Addendum',
    version: 'v1',
    status: 'Superseded',
    created: '2026-05-05',
    effective: '2026-05-10',
    expires: '2026-06-30',
    terminated: null,
    partner: signed('2026-05-08T09:00:00Z'),
    company: signed('2026-05-09T10:00:00Z'),
    supersededBy: 'sample-doc-7',
    privateStoragePath: null,
  },
  {
    id: 'sample-doc-7',
    name: 'Content and brand usage',
    type: 'Content and Brand Usage Addendum',
    version: 'v2',
    status: 'Active',
    created: '2026-06-25',
    effective: '2026-07-01',
    expires: null,
    terminated: null,
    partner: signed('2026-06-29T09:00:00Z'),
    company: signed('2026-06-30T10:00:00Z'),
    supersedes: 'sample-doc-6',
    privateStoragePath: null,
  },
  {
    id: 'sample-doc-8',
    name: 'Limited campaign renewal',
    type: 'Renewal',
    version: 'v1',
    status: 'Expired',
    created: '2026-04-28',
    effective: '2026-05-01',
    expires: '2026-05-31',
    terminated: null,
    partner: signed('2026-04-29T09:00:00Z'),
    company: signed('2026-04-30T10:00:00Z'),
    privateStoragePath: null,
  },
  {
    id: 'sample-doc-9',
    name: 'Limited campaign amendment',
    type: 'Amendment',
    version: 'v1',
    status: 'Terminated',
    created: '2026-05-20',
    effective: '2026-06-01',
    expires: null,
    terminated: '2026-07-15',
    partner: signed('2026-05-28T09:00:00Z'),
    company: signed('2026-05-29T10:00:00Z'),
    privateStoragePath: null,
  },
]
export function documentMatchesStatus(document: PartnerDocument, status: string) {
  return (
    status === 'all' ||
    document.status === status ||
    (status === 'Signed' &&
      document.partner.status === 'Signed' &&
      document.company.status === 'Signed')
  )
}
export function documentDate(value: string | null, fallback = 'Not set') {
  if (!value) return fallback
  return (
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
      ...(value.includes('T') ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
    }).format(new Date(value.includes('T') ? value : `${value}T00:00:00Z`)) +
    (value.includes('T') ? ' UTC' : '')
  )
}
export function documentRecordCsv(document: PartnerDocument) {
  return {
    headers: [
      'Dataset',
      'Document',
      'Type',
      'Version',
      'Lifecycle status',
      'Created (UTC)',
      'Effective (UTC)',
      'Expires (UTC)',
      'Terminated (UTC)',
      'Partner signature',
      'Partner signed at (UTC)',
      'KissMyApps signature',
      'KissMyApps signed at (UTC)',
      'Supersedes',
      'Superseded by',
      'Private file',
    ],
    rows: [
      [
        'UI PREVIEW - NOT A LEGAL DOCUMENT OR SIGNATURE',
        document.name,
        document.type,
        document.version,
        document.status,
        document.created,
        document.effective ?? 'Not set',
        document.expires ?? 'Not set',
        document.terminated ?? 'Not set',
        document.partner.status,
        document.partner.at ?? 'Not signed',
        document.company.status,
        document.company.at ?? 'Not signed',
        partnerDocuments.find((value) => value.id === document.supersedes)?.version ?? 'None',
        partnerDocuments.find((value) => value.id === document.supersededBy)?.version ?? 'None',
        'No file uploaded; private authorized access required',
      ],
    ],
  }
}
