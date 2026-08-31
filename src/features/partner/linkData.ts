import {
  defaultFilters,
  filterRecords,
  previewCampaigns,
  previewFunnels,
  previewLinks,
  previewSources,
  trackedPreviewUrl,
} from './data'
import type { PreviewLink } from './data'
import { filterReportingRecords } from './reporting'
import type { ReportingFilters } from './reporting'

export type LinkDraft = Pick<
  PreviewLink,
  'name' | 'source' | 'campaign' | 'funnel' | 'subId' | 'sub2' | 'sub3'
>
export type LinkErrors = Partial<Record<keyof LinkDraft, string>>
export const newLinkDraft: LinkDraft = {
  name: '',
  source: previewSources[0],
  campaign: previewCampaigns[0],
  funnel: previewFunnels[0],
  subId: '',
  sub2: '',
  sub3: '',
}

export function linkStatus(link: PreviewLink) {
  return link.archived ? 'Archived' : link.active ? 'Active' : 'Paused'
}

export function normalizeLinkDraft(draft: LinkDraft): LinkDraft {
  return Object.fromEntries(
    (Object.keys(newLinkDraft) as (keyof LinkDraft)[]).map((key) => [key, draft[key].trim()]),
  ) as LinkDraft
}

export function validateLinkDraft(draft: LinkDraft, links: PreviewLink[]): LinkErrors {
  const value = normalizeLinkDraft(draft)
  const errors: LinkErrors = {}
  if (!value.name || value.name.length > 80) errors.name = 'Enter a name for this sample link.'
  if (!previewSources.slice(0, 4).includes(value.source))
    errors.source = 'Choose a configured sample source.'
  if (!previewCampaigns.includes(value.campaign))
    errors.campaign = 'Choose a configured sample campaign.'
  if (!previewFunnels.includes(value.funnel)) errors.funnel = 'Choose a configured sample funnel.'
  for (const key of ['subId', 'sub2', 'sub3'] as const) {
    if ((key === 'subId' || value[key]) && !/^[a-zA-Z0-9_-]{1,64}$/.test(value[key])) {
      errors[key] = 'Use 1–64 letters, numbers, hyphens, or underscores for the Sub ID.'
    }
  }
  if (
    !Object.keys(errors).length &&
    links.some((link) => trackedPreviewUrl(link) === trackedPreviewUrl(value))
  ) {
    errors.subId =
      'This tracking combination already exists, including archived links. Use a different Sub ID.'
  }
  return errors
}

export function createLinkPreview(draft: LinkDraft, id: string, parentId?: string): PreviewLink {
  return {
    ...normalizeLinkDraft(draft),
    id,
    parentId,
    active: true,
    archived: false,
    clicks: 0,
    leads: 0,
    installs: 0,
    purchases: 0,
    earningsMinor: 0,
  }
}

export function variantDraft(link: PreviewLink): LinkDraft {
  return {
    name: `${link.name.slice(0, 70)} · variant`,
    source: link.source,
    campaign: link.campaign,
    funnel: link.funnel,
    subId: `${link.subId.slice(0, 56)}-variant`,
    sub2: link.sub2,
    sub3: link.sub3,
  }
}

export function changeLinkStatus(
  link: PreviewLink,
  action: 'toggle' | 'archive' | 'restore',
): PreviewLink {
  if (action === 'archive') return { ...link, active: false, archived: true }
  if (action === 'restore') return { ...link, active: false, archived: false }
  return link.archived ? link : { ...link, active: !link.active }
}

// Identity matters: new/variant links do not inherit a seeded link's traffic,
// even if dimensions resemble an older placement. This is fixture-only mapping.
export function linkHasHistory(link: PreviewLink) {
  const seed = previewLinks.find((value) => value.id === link.id)
  return Boolean(seed && trackedPreviewUrl(seed) === trackedPreviewUrl(link))
}

export function scopeLinkFilters(
  filters: ReportingFilters,
  link?: PreviewLink | null,
): ReportingFilters {
  return link
    ? {
        ...filters,
        source: link.source,
        campaign: link.campaign,
        funnel: link.funnel,
        subId: link.subId,
      }
    : filters
}

export function linkReportingRecords(link: PreviewLink, filters: ReportingFilters) {
  return linkHasHistory(link)
    ? filterReportingRecords(scopeLinkFilters(filters, link)).filter(
        (row) => row.subId === link.subId,
      )
    : []
}

export const sourceSnapshot = filterRecords(defaultFilters)
