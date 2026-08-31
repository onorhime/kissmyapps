import { describe, expect, it } from 'vitest'
import { csvContent, defaultProfile } from './data'
import { sampleAgreement } from './payoutData'
import {
  agreementVersions,
  documentDate,
  documentMatchesStatus,
  documentRecordCsv,
  documentStatuses,
  documentTypes,
  normalizeProfile,
  notificationOptions,
  partnerDocuments,
  validateProfile,
} from './profileData'

describe('profile and document fixture contract', () => {
  it('limits preferences to the six permitted categories', () => {
    expect(notificationOptions.map((value) => value.id)).toEqual([
      'statements',
      'payouts',
      'verification',
      'signatures',
      'adjustments',
      'inactiveLinks',
    ])
    expect(Object.keys(defaultProfile.notifications)).toEqual(
      notificationOptions.map((value) => value.id),
    )
  })
  it('normalizes all new text fields and copies collections without mutating input', () => {
    const draft = {
      ...defaultProfile,
      fullName: ' Example ',
      legalName: ' Company ',
      publicName: ' Public ',
      website: ' https://test.example.invalid ',
      audienceDescription: ' Community ',
      channelDetails: ' Newsletter ',
      audienceCountries: ['Canada', 'Canada'],
      channels: ['Newsletter', 'Newsletter'],
    }
    const result = normalizeProfile(draft)
    expect(result).toMatchObject({
      fullName: 'Example',
      legalName: 'Company',
      publicName: 'Public',
      website: 'https://test.example.invalid',
      audienceDescription: 'Community',
      channelDetails: 'Newsletter',
      audienceCountries: ['Canada'],
      channels: ['Newsletter'],
    })
    expect(result.notifications).not.toBe(draft.notifications)
    expect(draft.fullName).toBe(' Example ')
  })
  it('requires separate contact, public and legal identities', () => {
    expect(
      Object.keys(
        validateProfile({ ...defaultProfile, fullName: ' ', publicName: '', legalName: '' }),
      ),
    ).toEqual(['fullName', 'publicName', 'legalName'])
  })
  it.each([
    'javascript:alert(1)',
    'http://test.invalid',
    'https://example.com',
    'https://user:secret@test.invalid',
    'not a url',
  ])('rejects an unsafe or non-fictional website %s', (website) => {
    expect(validateProfile({ ...defaultProfile, website })).toHaveProperty('website')
  })
  it.each(['', 'https://studio.example.invalid/path?label=sample'])(
    'allows blank or fictional HTTPS website %s',
    (website) => {
      expect(validateProfile({ ...defaultProfile, website })).toEqual({})
    },
  )
  it('enforces text limits', () => {
    expect(
      validateProfile({
        ...defaultProfile,
        audienceDescription: 'x'.repeat(1001),
        channelDetails: 'x'.repeat(1001),
      }),
    ).toMatchObject({ audienceDescription: expect.any(String), channelDetails: expect.any(String) })
  })
  it('shares current terms with payouts while drafts remain ineffective', () => {
    expect(agreementVersions[0].agreement).toBe(sampleAgreement)
    expect(agreementVersions.filter((value) => value.current)).toHaveLength(1)
    expect(agreementVersions[1]).toMatchObject({ status: 'Draft', current: false, effective: null })
    expect(sampleAgreement).toMatchObject({ rateBps: 3000, currency: 'USD', minimumMinor: 10000 })
  })
  it('covers every required document type and lifecycle status', () => {
    expect(new Set(partnerDocuments.map((value) => value.type))).toEqual(new Set(documentTypes))
    expect(new Set(partnerDocuments.map((value) => value.status))).toEqual(
      new Set(documentStatuses),
    )
    expect(new Set(partnerDocuments.map((value) => `${value.name} ${value.version}`)).size).toBe(
      partnerDocuments.length,
    )
  })
  it('keeps signatures separate from activation and never invents pending timestamps', () => {
    for (const document of partnerDocuments) {
      for (const signature of [document.partner, document.company]) {
        expect(Boolean(signature.at)).toBe(signature.status === 'Signed')
        if (signature.at) expect(signature.at.slice(0, 10) >= document.created).toBe(true)
      }
      if (['Signed', 'Active', 'Superseded', 'Expired', 'Terminated'].includes(document.status)) {
        expect(document.partner.status).toBe('Signed')
        expect(document.company.status).toBe('Signed')
      }
      expect(document.privateStoragePath).toBeNull()
    }
  })
  it('preserves both sides of supersession and explicit expiry/termination dates', () => {
    const old = partnerDocuments.find((value) => value.supersededBy)!
    const next = partnerDocuments.find((value) => value.id === old.supersededBy)!
    expect(next.supersedes).toBe(old.id)
    expect(old.status).toBe('Superseded')
    expect(partnerDocuments.find((value) => value.status === 'Expired')?.expires).toBeTruthy()
    expect(partnerDocuments.find((value) => value.status === 'Terminated')?.terminated).toBeTruthy()
  })
  it('can filter every status and includes historical signed documents without relabelling them', () => {
    for (const status of documentStatuses)
      expect(partnerDocuments.some((value) => documentMatchesStatus(value, status))).toBe(true)
    expect(documentMatchesStatus(partnerDocuments[0], 'Signed')).toBe(true)
    expect(partnerDocuments[0].status).toBe('Active')
    expect(documentMatchesStatus(partnerDocuments[1], 'Signed')).toBe(false)
  })
  it('exports complete, formula-safe metadata without a private URL or invented signature', () => {
    const csv = documentRecordCsv({ ...partnerDocuments[2], name: '=formula' })
    expect(csv.rows[0]).toHaveLength(csv.headers.length)
    expect(csv.rows[0][csv.headers.indexOf('Partner signed at (UTC)')]).toBe('Not signed')
    expect(csvContent(csv.headers, csv.rows)).toContain("'=formula")
    expect(csv.rows[0].at(-1)).toContain('No file uploaded')
  })
  it('formats dates in UTC and retains missing metadata', () => {
    expect(documentDate(null)).toBe('Not set')
    expect(documentDate('2026-08-20T11:15:00Z')).toBe('Aug 20, 2026, 11:15 UTC')
  })
})
