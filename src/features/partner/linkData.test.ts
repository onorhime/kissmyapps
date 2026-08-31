import { describe, expect, it } from 'vitest'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { mainPreviewUrl, previewLinks, trackedPreviewUrl } from './data'
import {
  changeLinkStatus,
  createLinkPreview,
  linkHasHistory,
  linkReportingRecords,
  linkStatus,
  newLinkDraft,
  normalizeLinkDraft,
  scopeLinkFilters,
  validateLinkDraft,
  variantDraft,
} from './linkData'
import { defaultReportingFilters } from './reporting'
import { previewQrDataUrl } from './qrData'

describe('link management fixture contract', () => {
  it('retains original counts, currency, history and derived leads/installs', () => {
    expect(previewLinks.map((link) => link.clicks)).toEqual([8878, 7681, 6400, 5142])
    expect(previewLinks.map((link) => link.purchases)).toEqual([143, 139, 126, 111])
    expect(previewLinks.map((link) => link.earningsMinor)).toEqual([135954, 132966, 123255, 112050])
    expect(previewLinks.map((link) => link.leads)).toEqual([1416, 1231, 1023, 826])
    expect(previewLinks.map((link) => link.installs)).toEqual([619, 537, 447, 363])
    expect(previewLinks.reduce((sum, link) => sum + link.clicks, 0)).toBe(28101)
    expect(previewLinks.reduce((sum, link) => sum + link.earningsMinor, 0)).toBe(504225)
  })
  it('encodes every dimension without letting labels inject identity or destinations', () => {
    const link = {
      ...previewLinks[0],
      campaign: 'Test & affiliate_id=other',
      funnel: 'Example / A',
      subId: 'a/b c',
      sub2: 'description&x=1',
      sub3: 'creative_ä',
    }
    const url = new URL(trackedPreviewUrl(link))
    expect(url.origin).toBe('https://go.example.invalid')
    expect(url.pathname).toBe('/r/preview-partner/social-media')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      campaign: link.campaign,
      funnel: link.funnel,
      sub1: link.subId,
      sub2: link.sub2,
      sub3: link.sub3,
    })
    expect(url.searchParams.has('affiliate_id')).toBe(false)
    expect(new URL(mainPreviewUrl).search).toBe('')
  })
  it('changes URL when campaign, funnel or any Sub ID changes', () => {
    for (const field of ['campaign', 'funnel', 'subId', 'sub2', 'sub3'] as const)
      expect(trackedPreviewUrl({ ...previewLinks[0], [field]: 'different' })).not.toBe(
        trackedPreviewUrl(previewLinks[0]),
      )
  })
  it('normalizes a valid draft and allows optional sub2/sub3 to remain empty', () => {
    const draft = { ...newLinkDraft, name: '  Example  ', subId: ' placement_new ' }
    expect(validateLinkDraft(draft, previewLinks)).toEqual({})
    expect(normalizeLinkDraft(draft)).toMatchObject({
      name: 'Example',
      subId: 'placement_new',
      sub2: '',
      sub3: '',
    })
    expect(draft.name).toBe('  Example  ')
  })
  it.each(['subId', 'sub2', 'sub3'] as const)(
    'validates %s and enforces 64 character limit',
    (field) => {
      expect(
        validateLinkDraft(
          { ...newLinkDraft, name: 'Example', subId: 'new', [field]: 'not valid' },
          [],
        ),
      ).toHaveProperty(field)
      expect(
        validateLinkDraft(
          { ...newLinkDraft, name: 'Example', subId: 'new', [field]: 'x'.repeat(65) },
          [],
        ),
      ).toHaveProperty(field)
    },
  )
  it('rejects unconfigured dimensions and blank names', () => {
    expect(
      validateLinkDraft(
        {
          ...newLinkDraft,
          source: 'other',
          campaign: 'other',
          funnel: 'https://actual.invalid',
          subId: 'new',
        },
        [],
      ),
    ).toMatchObject({
      name: expect.any(String),
      source: expect.any(String),
      campaign: expect.any(String),
      funnel: expect.any(String),
    })
  })
  it('rejects duplicate tracking combinations including archived ones', () => {
    expect(
      validateLinkDraft({ ...previewLinks[0], name: 'Different name' }, [
        changeLinkStatus(previewLinks[0], 'archive'),
      ]),
    ).toHaveProperty('subId', expect.stringContaining('already exists'))
  })
  it('creates a new zero-history variant and respects field limits', () => {
    const original = { ...previewLinks[0], name: 'n'.repeat(80), subId: 'x'.repeat(64) }
    const draft = variantDraft(original)
    expect(draft.name.length).toBeLessThanOrEqual(80)
    expect(draft.subId.length).toBeLessThanOrEqual(64)
    const variant = createLinkPreview(draft, 'new-variant', original.id)
    expect(variant).toMatchObject({
      parentId: original.id,
      active: true,
      archived: false,
      clicks: 0,
      leads: 0,
      installs: 0,
      purchases: 0,
      earningsMinor: 0,
    })
    expect(trackedPreviewUrl(variant)).not.toBe(trackedPreviewUrl(original))
  })
  it('archive and restoration never mutate history or silently reactivate', () => {
    const link = previewLinks[0]
    const archived = changeLinkStatus(link, 'archive')
    expect(linkStatus(archived)).toBe('Archived')
    expect(changeLinkStatus(archived, 'toggle')).toBe(archived)
    const restored = changeLinkStatus(archived, 'restore')
    expect(linkStatus(restored)).toBe('Paused')
    for (const item of [archived, restored, changeLinkStatus(restored, 'toggle')])
      for (const key of ['clicks', 'leads', 'installs', 'purchases', 'earningsMinor'] as const)
        expect(item[key]).toBe(link[key])
    expect(link.active).toBe(true)
  })
  it.each(previewLinks)('drills into exact historical records for $name', (link) => {
    const records = linkReportingRecords(link, defaultReportingFilters)
    expect(records).toHaveLength(30)
    expect(
      records.every(
        (row) =>
          row.source === link.source &&
          row.campaign === link.campaign &&
          row.funnel === link.funnel &&
          row.subId === link.subId,
      ),
    ).toBe(true)
    for (const metric of ['clicks', 'leads', 'installs', 'purchases', 'earningsMinor'] as const) {
      expect(records.every((row) => row[metric] !== null)).toBe(true)
      expect(records.reduce((sum, row) => sum + row[metric]!, 0)).toBe(link[metric])
    }
    expect(
      linkReportingRecords(changeLinkStatus(link, 'archive'), defaultReportingFilters),
    ).toEqual(records)
  })
  it('never assigns seeded history to a new identity with the same tags', () => {
    const newLink = createLinkPreview(previewLinks[0], 'new-identity')
    expect(linkHasHistory(newLink)).toBe(false)
    expect(linkReportingRecords(newLink, defaultReportingFilters)).toEqual([])
    expect(linkHasHistory({ ...previewLinks[0], sub2: 'new' })).toBe(false)
  })
  it('keeps the selected link scope when broad filters are reset', () => {
    const scoped = scopeLinkFilters(
      { ...defaultReportingFilters, country: 'Canada', period: '90' },
      previewLinks[1],
    )
    expect(scoped).toMatchObject({
      country: 'Canada',
      period: '90',
      source: 'Paid search',
      campaign: 'Example evergreen',
      funnel: 'Example funnel B',
      subId: 'placement-2',
    })
    expect(
      linkReportingRecords(previewLinks[1], scoped).every((row) => row.country === 'Canada'),
    ).toBe(true)
  })
})

describe('real locally generated QR content', () => {
  it.each([
    mainPreviewUrl,
    trackedPreviewUrl(previewLinks[0]),
    trackedPreviewUrl({
      ...previewLinks[2],
      subId: 'x'.repeat(64),
      sub2: 'y'.repeat(64),
      sub3: 'z'.repeat(64),
    }),
  ])('decodes the PNG to its exact tracked URL: %s', async (url) => {
    const data = await previewQrDataUrl(url)
    expect(data.startsWith('data:image/png;base64,')).toBe(true)
    const png = PNG.sync.read(Buffer.from(data.split(',')[1], 'base64'))
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
    expect(decoded?.data).toBe(url)
  })
  it.each([
    'https://example.com/r/preview-partner',
    'https://go.example.invalid/other',
    'https://go.example.invalid/r/preview-partner-evil',
    'https://user:password@go.example.invalid/r/preview-partner',
  ])('rejects non-preview targets %s', async (url) => {
    await expect(previewQrDataUrl(url)).rejects.toThrow('Only reserved sample')
  })
})
