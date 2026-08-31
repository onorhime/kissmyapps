import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { Links } from './features/partner/Links'
import { Profile } from './features/partner/Profile'
import {
  defaultProfile,
  mainPreviewUrl,
  previewLinks,
  trackedPreviewUrl,
} from './features/partner/data'
import type { PreviewState, ProfileSection } from './features/partner/data'
import {
  documentStatuses,
  notificationOptions,
  partnerDocuments,
} from './features/partner/profileData'
import { previewQrDataUrl } from './features/partner/qrData'
import * as previewData from './features/partner/data'

vi.mock('./features/partner/qrData', () => ({ previewQrDataUrl: vi.fn() }))
const fakeQr =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGJ8AAAAASUVORK5CYII='
beforeEach(() => {
  window.history.replaceState(null, '', '/#links')
  vi.mocked(previewQrDataUrl).mockReset().mockResolvedValue(fakeQr)
})
function openPage(route: string) {
  window.history.replaceState(null, '', `/#${route}`)
  return render(<App />)
}
const nav = () => within(screen.getByRole('navigation', { name: 'Partner navigation' }))
const linkProps = {
  links: previewLinks,
  onAdd: vi.fn(),
  onStatusChange: vi.fn(),
  onViewPerformance: vi.fn(),
  notify: vi.fn(),
  onRetry: vi.fn(),
}
const profileProps = {
  profile: defaultProfile,
  onSave: vi.fn(),
  notify: vi.fn(),
  onRetry: vi.fn(),
  onSectionChange: vi.fn(),
}

describe('Links and QR preview', () => {
  it('provides a main link, complete historical columns and no remote request', async () => {
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText')
    const fetch = vi.spyOn(globalThis, 'fetch')
    openPage('links')
    expect(screen.getByRole('textbox', { name: 'Main sample link' })).toHaveValue(mainPreviewUrl)
    await user.click(screen.getByRole('button', { name: 'Copy main link' }))
    expect(copy).toHaveBeenCalledWith(mainPreviewUrl)
    for (const name of ['Leads', 'Confirmed Installs', 'New Paid', 'Earnings'])
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Link summary' })).toHaveTextContent('28,101')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('uses the exact URL for the main QR image and PNG download', async () => {
    const user = userEvent.setup()
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'Download main QR' }))
    expect(await screen.findByRole('img', { name: /Sample QR/ })).toHaveAttribute('src', fakeQr)
    expect(previewQrDataUrl).toHaveBeenCalledWith(mainPreviewUrl)
    const download = screen.getByRole('link', { name: 'Download sample QR PNG' })
    expect(download).toHaveAttribute('href', fakeQr)
    expect(download).toHaveAttribute('download', 'SAMPLE-partner-main-QR.png')
    await user.click(screen.getByRole('button', { name: 'Back to link' }))
    expect(screen.getByRole('heading', { name: 'Your main sample link' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Sample tracked URL' })).toHaveValue(mainPreviewUrl)
  })
  it('uses the same URL for a source QR and copy details', async () => {
    const user = userEvent.setup()
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'Download QR for Weekly newsletter' }))
    await screen.findByRole('img', { name: /Sample QR/ })
    expect(previewQrDataUrl).toHaveBeenCalledWith(trackedPreviewUrl(previewLinks[2]))
    expect(screen.getByRole('textbox', { name: 'QR destination' })).toHaveValue(
      trackedPreviewUrl(previewLinks[2]),
    )
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Download QR for Weekly newsletter' })).toHaveFocus()
  })
  it('keeps a selectable URL and offers retry after QR failure', async () => {
    const user = userEvent.setup()
    vi.mocked(previewQrDataUrl).mockRejectedValueOnce(new Error('unavailable'))
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'Download main QR' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be prepared')
    expect(screen.getByRole('button', { name: 'Download sample QR PNG' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'QR destination' })).toHaveValue(mainPreviewUrl)
    await user.click(screen.getByRole('button', { name: 'Retry QR' }))
    expect(await screen.findByRole('img', { name: /Sample QR/ })).toBeInTheDocument()
  })
  it('ignores a QR completion after its dialog closes', async () => {
    const user = userEvent.setup()
    let finish!: (value: string) => void
    vi.mocked(previewQrDataUrl).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'Download main QR' }))
    await user.keyboard('{Escape}')
    await act(async () => finish(fakeQr))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('associates Sub ID hints and errors before invalid-field focus', async () => {
    const user = userEvent.setup()
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'Create sample link' }))
    const sub3 = screen.getByRole('textbox', { name: 'Sub 3' })
    expect(sub3).toHaveAccessibleDescription(/Optional creative.*no personal data/)
    fireEvent.change(screen.getByRole('textbox', { name: 'Link name' }), {
      target: { value: 'Example source' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Sub ID' }), {
      target: { value: 'example_new' },
    })
    fireEvent.change(sub3, { target: { value: 'bad value' } })
    let atFocus = ''
    sub3.addEventListener('focus', () => {
      atFocus = (sub3.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent)
        .join(' ')
    })
    await user.click(screen.getByRole('button', { name: 'Add to preview' }))
    expect(sub3).toHaveFocus()
    expect(sub3).toHaveAttribute('aria-invalid', 'true')
    expect(atFocus).toContain('Use 1–64 letters')
    expect(atFocus).toContain('no personal data')
  })
  it('creates all tracking dimensions and preserves them in the sample URL', async () => {
    const user = userEvent.setup()
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'Create source link' }))
    for (const [name, value] of [
      ['Link name', 'Example complete link'],
      ['Sub ID', 'video_18'],
      ['Sub 2', 'description'],
      ['Sub 3', 'creative_a'],
    ])
      fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Campaign' }),
      'Example evergreen',
    )
    await user.selectOptions(screen.getByRole('combobox', { name: 'Funnel' }), 'Example funnel B')
    await user.click(screen.getByRole('button', { name: 'Add to preview' }))
    await user.click(
      screen.getByRole('button', { name: 'View Example complete link link details' }),
    )
    const url = new URL(
      (screen.getByRole('textbox', { name: 'Sample tracked URL' }) as HTMLTextAreaElement).value,
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      campaign: 'Example evergreen',
      funnel: 'Example funnel B',
      sub1: 'video_18',
      sub2: 'description',
      sub3: 'creative_a',
    })
    expect(screen.getByRole('dialog')).toHaveTextContent('$0.00')
  })
  it('creates a zero-history variant and never inherits the original report', async () => {
    const user = userEvent.setup()
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'View Social bio link details' }))
    await user.click(screen.getByRole('button', { name: 'Create variant' }))
    expect(screen.getByRole('textbox', { name: 'Link name' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Sub ID' })).toHaveValue('placement-1-variant')
    await user.click(screen.getByRole('button', { name: 'Add to preview' }))
    expect(screen.getByRole('region', { name: 'Link summary' })).toHaveTextContent('28,101')
    await user.click(screen.getByRole('button', { name: 'View Social bio · variant link details' }))
    await user.click(screen.getByRole('button', { name: 'View Performance' }))
    expect(screen.getByRole('region', { name: 'Selected link report' })).toHaveTextContent(
      'No activity for this new sample link',
    )
    expect(screen.getByRole('button', { name: 'Export report' })).toBeDisabled()
    expect(screen.queryByRole('rowheader', { name: 'Social media' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Traffic source' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Show all performance' }))
    expect(screen.getByRole('main')).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Export report' })).toBeEnabled()
    expect(screen.queryByRole('region', { name: 'Selected link report' })).not.toBeInTheDocument()
  })
  it('exports the exact original-link scope with its identity in CSV metadata', async () => {
    const user = userEvent.setup()
    const csv = vi.spyOn(previewData, 'downloadCsv').mockImplementation(() => {})
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'View Social bio link details' }))
    await user.click(screen.getByRole('button', { name: 'View Performance' }))
    expect(screen.getByRole('region', { name: 'Selected link report' })).toHaveTextContent(
      'Viewing link: Social bio',
    )
    expect(screen.getByRole('combobox', { name: 'Reporting period' })).toHaveValue('30')
    const row = screen.getByRole('rowheader', { name: 'Social media' }).closest('tr')!
    expect(row).toHaveTextContent('8,878')
    await user.click(screen.getByRole('button', { name: 'Export report' }))
    expect(csv).toHaveBeenCalledOnce()
    const [, headers, rows] = csv.mock.calls[0]
    expect(headers.slice(-2)).toEqual(['Sample link', 'Sample tracking URL'])
    expect(
      rows.every(
        (row) => row.at(-2) === 'Social bio' && row.at(-1) === trackedPreviewUrl(previewLinks[0]),
      ),
    ).toBe(true)
  })
  it('archives without deleting history and restores only as paused', async () => {
    const user = userEvent.setup()
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'View Social bio link details' }))
    await user.click(screen.getByRole('button', { name: 'Archive…' }))
    await user.click(screen.getByRole('button', { name: 'Archive sample link' }))
    const dialog = screen.getByRole('dialog', { name: 'Social bio' })
    expect(dialog).toHaveTextContent('$1,359.54')
    expect(within(dialog).getByRole('status')).toHaveTextContent('retained')
    expect(within(dialog).getByRole('button', { name: 'Copy sample URL' })).toBeDisabled()
    await user.keyboard('{Escape}')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Link status' }), 'Archived')
    expect(screen.getAllByRole('rowheader')).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'Link summary' })).toHaveTextContent('28,101')
    await user.click(screen.getByRole('button', { name: 'View Social bio link details' }))
    await user.click(screen.getByRole('button', { name: 'Restore as paused' }))
    expect(screen.getByRole('button', { name: 'Activate sample link' })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveTextContent('$1,359.54')
  })
  it('restores links and focus to search when clearing an empty filter result', async () => {
    const user = userEvent.setup()
    openPage('links')
    const search = screen.getByRole('textbox', { name: 'Search links' })
    await user.type(search, 'no_matching_example')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Link status' }), 'Archived')
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter links by source' }),
      'Newsletter',
    )
    await user.click(screen.getByRole('button', { name: 'Clear search & filters' }))
    expect(search).toHaveFocus()
    expect(search).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Link status' })).toHaveValue('all')
    expect(screen.getByRole('combobox', { name: 'Filter links by source' })).toHaveValue('all')
    expect(screen.getAllByRole('rowheader')).toHaveLength(previewLinks.length)
  })
  it('shows missing installs without erasing available link earnings', async () => {
    openPage('links')
    fireEvent.change(screen.getByRole('combobox', { name: 'Preview data state' }), {
      target: { value: 'partial' },
    })
    expect(screen.getAllByLabelText('Confirmed installs unavailable')).toHaveLength(4)
    expect(screen.getByRole('region', { name: 'Tracked links table' })).toHaveTextContent(
      '$1,359.54',
    )
  })
  it.each(['empty', 'loading', 'error'] as PreviewState[])(
    'removes link/QR creation and stale dialogs when data becomes %s',
    async (state) => {
      const user = userEvent.setup()
      const view = render(<Links {...linkProps} state="sample" />)
      await user.click(screen.getByRole('button', { name: 'Create sample link' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Link name' }), {
        target: { value: 'Discard this draft' },
      })
      view.rerender(<Links {...linkProps} state={state} />)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Create sample link' })).toBeDisabled()
      if (state === 'empty')
        expect(screen.getByRole('textbox', { name: 'Main sample link' })).toHaveValue(
          'No product or funnel configured',
        )
      else
        expect(screen.queryByRole('textbox', { name: 'Main sample link' })).not.toBeInTheDocument()
      view.rerender(<Links {...linkProps} state="sample" />)
      await user.click(screen.getByRole('button', { name: 'Create sample link' }))
      expect(screen.getByRole('textbox', { name: 'Link name' })).toHaveValue('')
    },
  )
})

describe('Profile, commercial terms and document lifecycle', () => {
  it('provides full identity/audience fields and only six notification choices', () => {
    openPage('profile')
    for (const name of [
      'Full name',
      'Public partner name',
      'Legal individual / company name',
      'Website',
      'Audience description',
      'Channel names / example URLs',
    ])
      expect(screen.getByRole('textbox', { name })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /Primary contact email/ })).toHaveAttribute(
      'readonly',
    )
    expect(screen.getByRole('group', { name: 'Primary audience countries' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Professional channels' })).toBeInTheDocument()
    for (const option of notificationOptions)
      expect(screen.getByRole('checkbox', { name: option.label })).toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', { name: /Performance summaries/ }),
    ).not.toBeInTheDocument()
  })
  it('validates the legal name and website with errors associated at focus time', async () => {
    const user = userEvent.setup()
    openPage('profile')
    const legal = screen.getByRole('textbox', { name: 'Legal individual / company name' })
    fireEvent.change(legal, { target: { value: ' ' } })
    let described = ''
    legal.addEventListener('focus', () => {
      described =
        document.getElementById(legal.getAttribute('aria-describedby') ?? '')?.textContent ?? ''
    })
    await user.click(screen.getByRole('button', { name: 'Save preview changes' }))
    expect(legal).toHaveFocus()
    expect(described).toContain('fictional legal')
    fireEvent.change(legal, { target: { value: 'Example Company' } })
    const website = screen.getByRole('textbox', { name: 'Website' })
    fireEvent.change(website, { target: { value: 'https://real.example.com' } })
    await user.click(screen.getByRole('button', { name: 'Save preview changes' }))
    expect(website).toHaveFocus()
    expect(website).toHaveAccessibleDescription(/ending in .invalid/)
  })
  it('saves new fields and notification choices only in memory without changing money', async () => {
    const user = userEvent.setup()
    const fetch = vi.spyOn(globalThis, 'fetch')
    const local = vi.spyOn(Storage.prototype, 'setItem')
    openPage('profile')
    fireEvent.change(screen.getByRole('textbox', { name: 'Legal individual / company name' }), {
      target: { value: '  Example Company  ' },
    })
    await user.selectOptions(screen.getByRole('combobox', { name: /^Preferred currency/ }), 'NGN')
    await user.selectOptions(
      screen.getByRole('combobox', { name: /^Preferred timezone/ }),
      'Africa/Lagos',
    )
    await user.click(screen.getByRole('checkbox', { name: 'Statements' }))
    await user.click(screen.getByRole('button', { name: 'Save preview changes' }))
    expect(screen.getByRole('textbox', { name: 'Legal individual / company name' })).toHaveValue(
      'Example Company',
    )
    expect(screen.getByRole('button', { name: 'Save preview changes' })).toBeDisabled()
    await user.click(nav().getByRole('link', { name: 'Payouts' }))
    expect(screen.getByRole('region', { name: 'Payout summary' })).toHaveTextContent('$2,099.07')
    expect(screen.getByText('Aug 30 · 23:59:59 UTC')).toBeInTheDocument()
    await user.click(nav().getByRole('link', { name: 'Profile & Documents' }))
    expect(screen.getByRole('combobox', { name: /^Preferred currency/ })).toHaveValue('NGN')
    expect(screen.getByRole('checkbox', { name: 'Statements' })).not.toBeChecked()
    expect(fetch).not.toHaveBeenCalled()
    expect(local).not.toHaveBeenCalled()
  })
  it('retains new drafts across terms/documents and discards all fields and preferences together', async () => {
    const user = userEvent.setup()
    openPage('profile')
    fireEvent.change(screen.getByRole('textbox', { name: 'Audience description' }), {
      target: { value: 'Unsaved example audience' },
    })
    await user.click(screen.getByRole('checkbox', { name: 'Payouts' }))
    await user.click(screen.getByRole('button', { name: 'Commercial terms' }))
    await user.click(screen.getByRole('button', { name: 'Documents' }))
    await user.click(screen.getByRole('button', { name: 'Partner details' }))
    expect(screen.getByRole('textbox', { name: 'Audience description' })).toHaveValue(
      'Unsaved example audience',
    )
    expect(screen.getByRole('checkbox', { name: 'Payouts' })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByRole('textbox', { name: 'Audience description' })).toHaveValue(
      defaultProfile.audienceDescription,
    )
    expect(screen.getByRole('checkbox', { name: 'Payouts' })).toBeChecked()
  })
  it('reviews an ineffective draft version without modifying current terms or payouts', async () => {
    const user = userEvent.setup()
    openPage('profile/terms')
    expect(screen.getByRole('button', { name: 'Commercial terms' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByText('30% of eligible net revenue')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agreement version' }), 'v2')
    expect(screen.getByText(/Draft example only/)).toBeInTheDocument()
    expect(screen.getByText('Not set · draft')).toBeInTheDocument()
    expect(screen.getByText('Current sample: Example agreement · v1')).toBeInTheDocument()
    await user.click(nav().getByRole('link', { name: 'Payouts' }))
    expect(screen.getByRole('region', { name: 'Payout summary' })).toHaveTextContent('$12,564.54')
  })
  it('moves focus to the persistent Documents control after the commercial terms CTA unmounts', async () => {
    const user = userEvent.setup()
    openPage('profile/terms')
    await user.click(screen.getByRole('button', { name: 'Review partnership documents' }))
    const documents = screen.getByRole('button', { name: 'Documents' })
    expect(documents).toHaveFocus()
    expect(documents).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: 'Partnership documents' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Review partnership documents' }),
    ).not.toBeInTheDocument()
  })
  it('shows no agreement or document records for an empty account', async () => {
    const user = userEvent.setup()
    openPage('profile/terms')
    await user.click(screen.getByRole('button', { name: 'Empty account' }))
    expect(screen.getByText('No commercial agreement yet')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Agreement version' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Documents' }))
    expect(screen.getByText('A fresh start. No paperwork yet.')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Preview Partner agreement v1' }),
    ).not.toBeInTheDocument()
  })
  it('restores document records and filter focus after clearing a no-match combination', async () => {
    const user = userEvent.setup()
    openPage('profile/documents')
    const status = screen.getByRole('combobox', { name: 'Document status' })
    const type = screen.getByRole('combobox', { name: 'Document type' })
    await user.selectOptions(status, 'Expired')
    await user.selectOptions(type, 'Partnership Agreement')
    expect(
      screen.getByRole('heading', { name: 'No documents match these filters' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear document filters' }))
    expect(status).toHaveFocus()
    expect(status).toHaveValue('all')
    expect(type).toHaveValue('all')
    expect(screen.getAllByRole('button', { name: /^Preview .+ v\d$/ })).toHaveLength(
      partnerDocuments.length,
    )
  })
  it('filters all eight lifecycle states while keeping signatures independent', async () => {
    const user = userEvent.setup()
    openPage('profile/documents')
    for (const value of documentStatuses) {
      await user.selectOptions(screen.getByRole('combobox', { name: 'Document status' }), value)
      expect(screen.getAllByRole('button', { name: /^Preview .+ v\d$/ }).length).toBeGreaterThan(0)
    }
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Document status' }),
      'Awaiting KissMyApps Signature',
    )
    await user.click(screen.getByRole('button', { name: 'Preview Partner program terms v1' }))
    const signatures = within(screen.getByRole('region', { name: 'Signature metadata' }))
    expect(signatures.getByText('Partner · Signed')).toBeInTheDocument()
    expect(signatures.getByText('KissMyApps · Awaiting signature')).toBeInTheDocument()
    expect(signatures.getByText('Awaiting signature · No timestamp yet')).toBeInTheDocument()
  })
  it('shows all dates, version relationships, private-file gates and a metadata-only export', async () => {
    const user = userEvent.setup()
    const download = vi.spyOn(previewData, 'downloadCsv').mockImplementation(() => {})
    openPage('profile/documents')
    await user.click(screen.getByRole('button', { name: 'Preview Content and brand usage v1' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Superseded (sample)')
    expect(dialog).toHaveTextContent('Jun 30, 2026')
    expect(dialog).toHaveTextContent('Superseded byv2')
    expect(screen.getByRole('button', { name: 'Sign document' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Download signed PDF' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Download sample record' }))
    expect(download.mock.calls[0][1]).toContain('Partner signed at (UTC)')
    expect(within(dialog).getByRole('status')).toHaveTextContent('not a signed document')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Preview Content and brand usage v1' })).toHaveFocus()
  })
  it.each([
    ['documents', 'Preview Partner agreement v1'],
    ['payment', 'Preview verification steps'],
  ] as const)('closes %s panels for unavailable datasets', async (section, action) => {
    const user = userEvent.setup()
    const view = render(
      <Profile {...profileProps} state="sample" section={section as ProfileSection} />,
    )
    await user.click(screen.getByRole('button', { name: action }))
    view.rerender(<Profile {...profileProps} state="loading" section={section as ProfileSection} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Example Partner Studio (fictional)')).not.toBeInTheDocument()
    view.rerender(<Profile {...profileProps} state="empty" section={section as ProfileSection} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('gives every expanded document a unique action name', () => {
    openPage('profile/documents')
    const buttons = screen.getAllByRole('button', { name: /^Preview .+ v\d$/ })
    expect(buttons).toHaveLength(partnerDocuments.length)
    expect(new Set(buttons.map((value) => value.getAttribute('aria-label'))).size).toBe(
      partnerDocuments.length,
    )
  })
})

describe('new management surfaces have no detected structural accessibility violations', () => {
  it.each([
    'create',
    'details',
    'archive',
    'qr',
    'terms',
    'awaiting-partner',
    'awaiting-company',
    'superseded',
    'profile-errors',
  ])('%s, including portalled content', async (scenario) => {
    const user = userEvent.setup()
    openPage(
      scenario === 'terms'
        ? 'profile/terms'
        : scenario === 'profile-errors'
          ? 'profile'
          : ['awaiting-partner', 'awaiting-company', 'superseded'].includes(scenario)
            ? 'profile/documents'
            : 'links',
    )
    if (scenario === 'create') {
      await user.click(screen.getByRole('button', { name: 'Create sample link' }))
      await user.click(screen.getByRole('button', { name: 'Add to preview' }))
    }
    if (scenario === 'details' || scenario === 'archive') {
      await user.click(screen.getByRole('button', { name: 'View Social bio link details' }))
      if (scenario === 'archive') await user.click(screen.getByRole('button', { name: 'Archive…' }))
    }
    if (scenario === 'qr') {
      await user.click(screen.getByRole('button', { name: 'Download main QR' }))
      await screen.findByRole('img', { name: /Sample QR/ })
    }
    if (scenario === 'awaiting-partner')
      await user.click(screen.getByRole('button', { name: 'Preview Partner declaration v1' }))
    if (scenario === 'awaiting-company')
      await user.click(screen.getByRole('button', { name: 'Preview Partner program terms v1' }))
    if (scenario === 'superseded')
      await user.click(screen.getByRole('button', { name: 'Preview Content and brand usage v1' }))
    if (scenario === 'profile-errors') {
      fireEvent.change(screen.getByRole('textbox', { name: 'Legal individual / company name' }), {
        target: { value: '' },
      })
      await user.click(screen.getByRole('button', { name: 'Save preview changes' }))
    }
    const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
    ).toEqual([])
  })
})
