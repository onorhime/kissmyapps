import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import * as previewData from './features/partner/data'
import {
  aggregateReport,
  defaultReportingFilters,
  filterReportingRecords,
  formatMetric,
} from './features/partner/reporting'

beforeEach(() => window.history.replaceState(null, '', '/#performance'))
const reportTable = () => screen.getByRole('region', { name: 'Performance breakdown table' })
const totalRow = () =>
  within(reportTable()).getByRole('row', { name: /^Total · All filtered rows/ })

describe('reporting v2 UI', () => {
  it('exposes the eight primary definitions and shared illustrative commercial context', async () => {
    const user = userEvent.setup()
    render(<App />)
    const summary = screen.getByRole('region', { name: 'Performance summary' })
    expect(within(summary).getAllByRole('article')).toHaveLength(8)
    expect(screen.getByRole('combobox', { name: 'Product' })).toHaveValue('sample-product')
    expect(
      screen.getByRole('region', { name: 'Product and partnership context' }),
    ).toHaveTextContent('Example terms only · Not a live agreement')
    const definition = within(summary).getByRole('button', { name: 'About Active subscriptions' })
    expect(definition).toHaveAttribute(
      'title',
      expect.stringContaining('date range does not change'),
    )
    await user.click(definition)
    expect(screen.getByRole('dialog', { name: 'Active subscriptions' })).toHaveTextContent(
      'Daily subscription counts must never be added together',
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(definition).toHaveFocus())
    await user.click(
      within(screen.getByRole('navigation', { name: 'Partner navigation' })).getByRole('link', {
        name: 'Payouts',
      }),
    )
    expect(
      screen.getByRole('region', { name: 'Product and partnership context' }),
    ).toHaveTextContent('30% Revenue share · USD')
  })

  it('keeps product and agreement placeholders truthful for an empty account', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Empty account' }))
    const context = screen.getByRole('region', { name: 'Product and partnership context' })
    expect(within(context).getByRole('combobox', { name: 'Product' })).toBeDisabled()
    expect(context).toHaveTextContent('No active products')
    expect(context).toHaveTextContent('No agreement configured')
    expect(context).not.toHaveTextContent('Example product')
    expect(
      within(screen.getByRole('region', { name: 'Data freshness' })).getAllByText('Not configured'),
    ).toHaveLength(5)
    expect(screen.getByRole('article', { name: 'Active subscriptions' })).toHaveTextContent('0')
  })

  it('validates custom dates, focuses the error, and applies inclusive endpoints', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reporting period' }), 'custom')
    const start = screen.getByLabelText('Start date')
    const end = screen.getByLabelText('End date')
    fireEvent.change(start, { target: { value: '' } })
    await user.click(screen.getByRole('button', { name: 'Apply dates' }))
    expect(start).toHaveFocus()
    expect(start).toHaveAccessibleDescription('Enter a valid start date.')
    fireEvent.change(start, { target: { value: '2026-08-10' } })
    fireEvent.change(end, { target: { value: '2026-08-09' } })
    await user.click(screen.getByRole('button', { name: 'Apply dates' }))
    expect(end).toHaveFocus()
    expect(end).toHaveAttribute('aria-invalid', 'true')
    expect(end).toHaveAccessibleDescription('The end date must be on or after the start date.')
    fireEvent.change(end, { target: { value: '2026-08-10' } })
    await user.click(screen.getByRole('button', { name: 'Apply dates' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Reporting period' })).toHaveValue('custom')
    expect(screen.getByText('Aug 10 – Aug 10, 2026')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View chart data' }))
    expect(within(reportTable()).getAllByRole('rowheader')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'Where your results come from' })).toHaveFocus()
  })

  it('cancels custom-date drafts without changing the applied range and supports editing again', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reporting period' }), 'custom')
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-01' } })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('combobox', { name: 'Reporting period' })).toHaveValue('30')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reporting period' }), 'custom')
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-07-28')
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-01' } })
    await user.click(screen.getByRole('button', { name: 'Apply dates' }))
    const edit = screen.getByRole('button', { name: 'Edit dates' })
    await user.click(edit)
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-08-15' } })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(edit).toHaveFocus())
    expect(screen.getByText('Aug 1 – Aug 26, 2026')).toBeInTheDocument()
    await user.click(edit)
    expect(screen.getByLabelText('End date')).toHaveValue('2026-08-26')
  })

  it('validates the native date values at submission even before a change event is committed', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reporting period' }), 'custom')
    const start = screen.getByLabelText('Start date') as HTMLInputElement
    const end = screen.getByLabelText('End date') as HTMLInputElement
    start.value = '2026-08-10'
    end.value = '2026-08-09'
    await user.click(screen.getByRole('button', { name: 'Apply dates' }))
    expect(end).toHaveFocus()
    expect(end).toHaveAccessibleDescription('The end date must be on or after the start date.')
    end.value = '2026-08-16'
    await user.click(screen.getByRole('button', { name: 'Apply dates' }))
    expect(screen.getByText('Aug 10 – Aug 16, 2026')).toBeInTheDocument()
  })

  it('reveals a focused table control beyond the pinned first column with space for its ring', async () => {
    const user = userEvent.setup()
    render(<App />)
    const region = reportTable()
    const pinned = region.querySelector('thead th')!
    const button = screen.getByRole('button', { name: 'Sort by New paid customers' })
    region.scrollLeft = 200
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue(new DOMRect(19, 100, 282, 425))
    vi.spyOn(pinned, 'getBoundingClientRect').mockReturnValue(new DOMRect(19, 100, 140, 94))
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 120, 80, 44))
    await user.click(button)
    expect(button).toHaveFocus()
    expect(region.scrollLeft).toBe(133)
  })

  it('preserves a current subscription snapshot when reporting dates change', async () => {
    const user = userEvent.setup()
    render(<App />)
    const snapshot = screen.getByRole('article', { name: 'Active subscriptions' }).textContent
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reporting period' }), 'year')
    expect(screen.getByRole('article', { name: 'Active subscriptions' })).toHaveTextContent(
      snapshot!,
    )
    expect(screen.getByText('Jan 1 – Aug 26, 2026')).toBeInTheDocument()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Traffic source' }),
      'Social media',
    )
    expect(screen.getByRole('article', { name: 'Active subscriptions' }).textContent).not.toBe(
      snapshot,
    )
  })

  it('enforces three series while leaving selected metrics removable and missing data explicit', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Traffic' }))
    const choices = within(screen.getByRole('group', { name: 'Visible chart metrics' }))
    expect(choices.getAllByRole('checkbox', { checked: true })).toHaveLength(2)
    await user.click(choices.getByRole('checkbox', { name: 'Funnel starts' }))
    expect(choices.getAllByRole('checkbox', { checked: true })).toHaveLength(3)
    expect(choices.getByRole('checkbox', { name: 'Payment views' })).toBeDisabled()
    expect(choices.getByRole('checkbox', { name: 'Link clicks' })).toBeEnabled()
    await user.click(choices.getByRole('checkbox', { name: 'Link clicks' }))
    expect(choices.getByRole('checkbox', { name: 'Payment views' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Revenue' }))
    expect(choices.getAllByRole('checkbox', { checked: true })).toHaveLength(1)
    await user.click(choices.getByRole('checkbox', { name: 'Partner earnings' }))
    expect(screen.getByText('Choose a metric to explore')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export report' })).toBeEnabled()
  })

  it('keeps dimension tables independent of chart grain and offers exact date-bucket values', async () => {
    const user = userEvent.setup()
    render(<App />)
    const totals = totalRow().textContent
    await user.click(screen.getByRole('button', { name: 'Week' }))
    expect(screen.getByRole('combobox', { name: 'Report breakdown' })).toHaveValue('source')
    expect(within(reportTable()).getAllByRole('rowheader')).toHaveLength(6)
    expect(totalRow()).toHaveTextContent(totals!)
    await user.click(screen.getByRole('button', { name: 'View chart data' }))
    expect(screen.getByRole('combobox', { name: 'Report breakdown' })).toHaveValue('date')
    expect(screen.getByRole('rowheader', { name: 'Jul 28 – Aug 2' })).toBeInTheDocument()
    expect(totalRow()).toHaveTextContent(totals!)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Report breakdown' }), 'country')
    expect(within(reportTable()).getAllByRole('rowheader')).toHaveLength(4)
    expect(screen.getByRole('rowheader', { name: 'Canada' })).toBeInTheDocument()
  })

  it('sorts numerically with visible aria-sort and retains a sorted optional column', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('checkbox', { name: 'Show all metrics' }))
    const button = screen.getByRole('button', { name: 'Sort by Disputes' })
    await user.click(button)
    expect(button.closest('th')).toHaveAttribute('aria-sort', 'ascending')
    await user.click(button)
    expect(button.closest('th')).toHaveAttribute('aria-sort', 'descending')
    await user.click(screen.getByRole('checkbox', { name: 'Show all metrics' }))
    expect(screen.getByRole('button', { name: 'Sort by Disputes' }).closest('th')).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    expect(reportTable().querySelectorAll('[aria-sort]')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Sort by Partner earnings' }))
    expect(screen.queryByRole('button', { name: 'Sort by Disputes' })).not.toBeInTheDocument()
  })

  it('retains the active sort header when switching away from its chart group', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Traffic' }))
    await user.click(screen.getByRole('checkbox', { name: 'Funnel starts' }))
    await user.click(screen.getByRole('button', { name: 'Sort by Funnel starts' }))
    await user.click(screen.getByRole('button', { name: 'Conversion' }))
    expect(
      screen.getByRole('button', { name: 'Sort by Funnel starts' }).closest('th'),
    ).toHaveAttribute('aria-sort', 'ascending')
    expect(reportTable().querySelectorAll('[aria-sort]')).toHaveLength(1)
  })

  it('keeps full totals across pages and exports all date rows in the current sort order', async () => {
    const user = userEvent.setup()
    const download = vi.spyOn(previewData, 'downloadCsv').mockImplementation(() => {})
    render(<App />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Report breakdown' }), 'date')
    const totals = totalRow().textContent
    await user.click(screen.getByRole('button', { name: 'Next report rows' }))
    expect(screen.getByRole('rowheader', { name: 'Aug 4' })).toBeInTheDocument()
    expect(totalRow()).toHaveTextContent(totals!)
    await user.click(screen.getByRole('button', { name: 'Export report' }))
    expect(download).toHaveBeenCalledOnce()
    const [filename, headers, rows] = download.mock.calls[0]
    expect(filename).toBe('SAMPLE-partner-date-2026-07-28-2026-08-26.csv')
    expect(rows).toHaveLength(31)
    expect(rows[0][11]).toBe('Jul 28')
    expect(rows.at(-1)?.[headers.indexOf('Partner earnings (USD)')]).toBe(
      aggregateReport(filterReportingRecords(defaultReportingFilters)).earningsMinor! / 100,
    )
  })

  it('uses unavailable values in KPIs, table, totals, chart legend, freshness, and CSV', async () => {
    const user = userEvent.setup()
    const download = vi.spyOn(previewData, 'downloadCsv').mockImplementation(() => {})
    render(<App />)
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Preview data state' }),
      'partial',
    )
    expect(screen.getByRole('article', { name: 'Confirmed installs' })).toHaveTextContent('—')
    expect(within(reportTable()).getAllByRole('cell', { name: 'Unavailable' })).toHaveLength(12)
    await user.click(screen.getByRole('button', { name: 'Traffic' }))
    await user.click(screen.getByRole('checkbox', { name: 'Confirmed installs (unavailable)' }))
    expect(screen.getByText('Confirmed installs · Unavailable')).toBeInTheDocument()
    const freshness = screen.getByRole('region', { name: 'Data freshness' })
    expect(within(freshness).getAllByText('Unavailable')).toHaveLength(2)
    expect(screen.getByRole('combobox', { name: 'Sample reconciliation status' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Export report' }))
    const [, headers, rows] = download.mock.calls[0]
    expect(rows.every((row) => row[headers.indexOf('Confirmed installs')] === 'Unavailable')).toBe(
      true,
    )
    expect(rows.every((row) => row[headers.indexOf('App activations')] === 'Unavailable')).toBe(
      true,
    )
    await user.click(screen.getByRole('checkbox', { name: 'Link clicks' }))
    await user.click(screen.getByRole('checkbox', { name: 'Unique visitors' }))
    expect(screen.getByText('Selected metrics are unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('figure', { name: 'Traffic chart' })).not.toBeInTheDocument()
  })

  it('previews reconciled and closed-period finalized reports without changing payout data', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<App />)
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Sample reconciliation status' }),
      'reconciled',
    )
    expect(screen.getByRole('button', { name: 'Reconciled' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Finalized' })).toBeDisabled()
    await user.click(
      screen.getByRole('button', { name: 'Reporting timezone and status information' }),
    )
    await user.click(screen.getByRole('button', { name: 'Preview a finalized report' }))
    expect(screen.getByRole('button', { name: 'Finalized' })).toBeInTheDocument()
    expect(screen.getByText('Aug 3 – Aug 16, 2026')).toBeInTheDocument()
    expect(screen.getByText('Current period · All sources').parentElement).toHaveTextContent(
      formatMetric('earningsMinor', previewData.previewPayouts[0].earningsMinor),
    )
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reporting period' }), '14')
    expect(screen.getByRole('button', { name: 'Preliminary' })).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
