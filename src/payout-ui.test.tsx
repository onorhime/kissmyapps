import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { Payouts } from './features/partner/Payouts'
import * as previewData from './features/partner/data'
import { payoutDetails, payoutStateExamples } from './features/partner/payoutData'

beforeEach(() => window.history.replaceState(null, '', '/#payouts'))
const summary = () => screen.getByRole('region', { name: 'Payout summary' })

describe('payout transparency UI', () => {
  it('shows four defined summary values, agreement context and the exact UTC review window', () => {
    render(<App />)
    expect(within(summary()).getAllByRole('article')).toHaveLength(4)
    expect(summary()).toHaveTextContent('$2,099.07')
    expect(summary()).toHaveTextContent('$12,564.54')
    expect(
      within(summary()).getByRole('article', { name: 'Approved & scheduled' }),
    ).toHaveTextContent('$0.00')
    expect(
      within(summary()).getByRole('article', { name: 'Next expected payout' }),
    ).toHaveTextContent('Sep 4, 2026')
    expect(screen.getByText('Aug 31 – Sep 3')).toBeInTheDocument()
    expect(screen.getByText('Aug 30 · 23:59:59 UTC')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10')
    expect(
      within(screen.getByRole('list', { name: 'Payout lifecycle' })).getByText('Open'),
    ).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText('Read-only terms · Not a live agreement')).toBeInTheDocument()
  })

  it('opens a keyboard/touch metric definition and restores the exact opener', async () => {
    const user = userEvent.setup()
    render(<App />)
    const button = screen.getByRole('button', { name: 'About next expected payout' })
    await user.click(button)
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      /not a confirmed scheduled transfer/,
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(button).toHaveFocus())
  })

  it('explores all eight statuses without changing balances or adding history records', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Explore payout states' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleDescription(/excluded from balances/)
    for (const [status, example] of Object.entries(payoutStateExamples)) {
      await user.selectOptions(
        screen.getByRole('combobox', { name: 'Example payout status' }),
        status,
      )
      expect(dialog).toHaveTextContent(example.explanation)
      expect(dialog).toHaveTextContent(example.next)
      if (!example.date) expect(within(dialog).getByText('Not set')).toBeInTheDocument()
    }
    await user.keyboard('{Escape}')
    expect(summary()).toHaveTextContent('$2,099.07')
    expect(summary()).toHaveTextContent('$12,564.54')
    expect(screen.getAllByRole('rowheader')).toHaveLength(6)
  })

  it('keeps a no-match history separate from the selected status example', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Payout status' }),
      'carried_forward',
    )
    expect(screen.getByText('No payouts with this status')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export history' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Explore this status' }))
    expect(screen.getByRole('combobox', { name: 'Example payout status' })).toHaveValue(
      'carried_forward',
    )
    expect(screen.getByRole('dialog')).toHaveTextContent(
      '$75.00 carried in + $60.00 newly earned = $135.00',
    )
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Show all payouts' }))
    expect(screen.getAllByRole('rowheader')).toHaveLength(6)
  })

  it('shows explicit model inputs and count-times-rate without changing the account agreement', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'How are payouts calculated?' }))
    const model = screen.getByRole('combobox', { name: 'Example commission model' })
    const example = screen.getByRole('region', { name: 'Commission calculation example' })
    expect(example).toHaveTextContent('$1,000.00 × 30%')
    await user.selectOptions(model, 'cpl')
    expect(example).toHaveTextContent('40 × $5.00')
    expect(example).toHaveTextContent('$200.00')
    await user.selectOptions(model, 'cpa')
    expect(example).toHaveTextContent('12 × $18.00')
    expect(example).toHaveTextContent('$216.00')
    await user.selectOptions(model, 'hybrid')
    expect(example).toHaveTextContent('$1,000.00 × 30%')
    expect(example).toHaveTextContent('$716.00')
    await user.keyboard('{Escape}')
    expect(
      screen.getByRole('region', { name: 'Product and partnership context' }),
    ).toHaveTextContent('30% Revenue share')
    expect(summary()).toHaveTextContent('$2,099.07')
  })

  it('shows a reconciled bridge, versioned payment snapshot, correction and change history', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'View payout for Jul 20' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('$8,988.90')
    expect(dialog).toHaveTextContent('-$124.50')
    expect(dialog).toHaveTextContent('$8,864.40')
    expect(dialog).toHaveTextContent('$2,659.32')
    expect(dialog).toHaveTextContent('-$14.94')
    expect(dialog).toHaveTextContent('$2,644.38')
    expect(dialog).toHaveTextContent('SAMPLE-2026-0005-TRANSFER')
    expect(dialog).toHaveTextContent('Aug 7, 2026')
    await user.click(within(dialog).getByText('Calculation notes', { exact: true }))
    expect(within(dialog).getByText(/No fee deduction in this fixture/)).toBeVisible()
    await user.click(within(dialog).getByText('Money-affecting history', { exact: true }))
    expect(within(dialog).getByText(/Separate \$14.94 commission reversal/)).toBeVisible()
    await user.click(within(dialog).getByText('Change history', { exact: true }))
    expect(within(dialog).getByText('Scheduled · destination snapshot locked')).toBeVisible()
  })

  it('exposes matching sample CSV/PDF downloads only for issued statements', async () => {
    const user = userEvent.setup()
    const download = vi.spyOn(previewData, 'downloadCsv').mockImplementation(() => {})
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'View payout for Jul 20' }))
    expect(screen.getByRole('link', { name: 'Download sample PDF' })).toHaveAttribute(
      'href',
      '/statements/SAMPLE-2026-0005.pdf',
    )
    expect(screen.getByRole('link', { name: 'Download sample PDF' })).toHaveAttribute(
      'download',
      'SAMPLE-2026-0005.pdf',
    )
    await user.click(screen.getByRole('button', { name: 'Download sample CSV' }))
    expect(download).toHaveBeenCalledOnce()
    expect(download.mock.calls[0][0]).toBe('SAMPLE-2026-0005.csv')
    expect(download.mock.calls[0][2].find((row) => row[8] === 'Approved adjustments')?.[9]).toBe(
      -14.94,
    )
    expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent(
      'Sample CSV prepared',
    )
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'View payout for Aug 17' }))
    expect(screen.getByRole('button', { name: 'Download sample PDF' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Download sample CSV' })).toBeDisabled()
    expect(screen.getByText('No payment recorded')).toBeInTheDocument()
  })

  it('exports filtered history with numeric adjustments and no scenario rows', async () => {
    const user = userEvent.setup()
    const download = vi.spyOn(previewData, 'downloadCsv').mockImplementation(() => {})
    render(<App />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payout status' }), 'paid')
    await user.click(screen.getByRole('button', { name: 'Export history' }))
    const [, headers, rows] = download.mock.calls[0]
    expect(rows).toHaveLength(5)
    expect(rows[1][headers.indexOf('Adjustments (USD)')]).toBe(-14.94)
  })

  it('keeps missing breakdowns unknown while preserving finalized statement snapshots', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Preview data state' }),
      'partial',
    )
    await user.click(screen.getByRole('button', { name: 'View payout for Aug 17' }))
    expect(screen.getAllByLabelText('Unavailable')).toHaveLength(7)
    expect(screen.getByRole('dialog')).toHaveTextContent('Eligible net revenue · ledger snapshot')
    expect(screen.getByRole('dialog')).toHaveTextContent('$2,099.07')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'View payout for Aug 3' }))
    expect(screen.queryByLabelText('Unavailable')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download sample PDF' })).toBeInTheDocument()
  })

  it('does not invent agreement, method or dates for an empty account', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Empty account' }))
    expect(screen.getByRole('main')).not.toHaveTextContent('Bank transfer')
    expect(screen.getByRole('main')).not.toHaveTextContent('Sep 4')
    expect(screen.queryByText('30% Revenue share')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export history' })).toBeDisabled()
    expect(screen.getByText('Agreement and payment method not configured')).toBeInTheDocument()
  })

  it.each(['loading', 'error'])(
    'keeps %s payouts unavailable rather than showing false zeros',
    async (state) => {
      const user = userEvent.setup()
      render(<App />)
      await user.selectOptions(screen.getByRole('combobox', { name: 'Preview data state' }), state)
      expect(screen.queryByRole('region', { name: 'Payout summary' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Export history' })).toBeDisabled()
    },
  )
})

describe('local-only discrepancy preview', () => {
  it('discards an open report when its dataset disappears and does not reopen it later', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    const onRetry = vi.fn()
    const view = render(<Payouts state="sample" navigate={navigate} onRetry={onRetry} />)
    await user.click(screen.getByRole('button', { name: 'View payout for Aug 3' }))
    await user.click(screen.getByRole('button', { name: 'Report a discrepancy' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Describe the issue' }),
      'Discard this fictional draft',
    )
    view.rerender(<Payouts state="empty" navigate={navigate} onRetry={onRetry} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    view.rerender(<Payouts state="sample" navigate={navigate} onRetry={onRetry} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View payout for Aug 3' }))
    await user.click(screen.getByRole('button', { name: 'Report a discrepancy' }))
    expect(screen.getByRole('textbox', { name: 'Describe the issue' })).toHaveValue('')
  })

  async function openForm() {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'View payout for Aug 3' }))
    await user.click(screen.getByRole('button', { name: 'Report a discrepancy' }))
    return user
  }

  it('commits associated errors before focusing and does not steal focus on edits', async () => {
    const user = await openForm()
    const reason = screen.getByRole('combobox', { name: 'What needs reviewing?' })
    const description = screen.getByRole('textbox', { name: 'Describe the issue' })
    expect(reason).toHaveFocus()
    const associations: string[] = []
    reason.addEventListener('focus', () =>
      associations.push(
        document.getElementById(reason.getAttribute('aria-describedby') ?? '')?.textContent ??
          'missing',
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Preview report' }))
    expect(associations).toEqual(['Choose what you would like reviewed.'])
    expect(reason).toHaveAccessibleDescription('Choose what you would like reviewed.')
    expect(reason).toHaveAttribute('aria-invalid', 'true')
    await user.type(description, '    ')
    expect(description).toHaveFocus()
    await user.selectOptions(reason, 'adjustment')
    await user.click(screen.getByRole('button', { name: 'Preview report' }))
    expect(description).toHaveFocus()
    expect(description).toHaveAccessibleDescription(/Describe the issue in 10–1,000 characters/)
    expect(description).toHaveAttribute('maxLength', '1000')
  })

  it('previews a bounded local message without network traffic, payment changes or fake case IDs', async () => {
    const user = await openForm()
    const network = vi.spyOn(globalThis, 'fetch')
    const before = JSON.stringify(payoutDetails)
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'What needs reviewing?' }),
      'statement',
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe the issue' }), {
      target: { value: '  Please explain this fictional statement adjustment.  ' },
    })
    await user.click(screen.getByRole('button', { name: 'Preview report' }))
    expect(screen.getByRole('heading', { name: 'Your discrepancy preview' })).toHaveFocus()
    expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent(
      'Your report has not been sent or saved.',
    )
    expect(
      screen.getByText('Please explain this fictional statement adjustment.'),
    ).toBeInTheDocument()
    expect(network).not.toHaveBeenCalled()
    expect(JSON.stringify(payoutDetails)).toBe(before)
    await user.click(screen.getByRole('button', { name: 'Edit preview' }))
    expect(screen.getByRole('combobox', { name: 'What needs reviewing?' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Back to payout details' }))
    expect(screen.getByRole('button', { name: 'Report a discrepancy' })).toHaveFocus()
  })

  it('clears the report on close and restores the original payout opener', async () => {
    const user = await openForm()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'What needs reviewing?' }),
      'payment',
    )
    await user.type(
      screen.getByRole('textbox', { name: 'Describe the issue' }),
      'Fictional test report',
    )
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'View payout for Aug 3' })).toHaveFocus(),
    )
    await user.click(screen.getByRole('button', { name: 'View payout for Jul 20' }))
    await user.click(screen.getByRole('button', { name: 'Report a discrepancy' }))
    expect(screen.getByRole('combobox', { name: 'What needs reviewing?' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Describe the issue' })).toHaveValue('')
  })

  it('reveals focused controls when the dialog wraps through its last action', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'View payout for Aug 3' }))
    const dialog = screen.getByRole('dialog')
    const last = screen.getByRole('button', { name: 'Download sample CSV' })
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, 24, 288, 692))
    vi.spyOn(last, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 1100, 200, 44))
    await user.tab({ shift: true })
    expect(last).toHaveFocus()
    expect(dialog.scrollTop).toBeGreaterThan(400)
  })
})

describe('portalled payout accessibility structure, not visual or screen-reader proof', () => {
  it.each(['statement', 'calculation', 'status', 'report', 'report-errors', 'report-preview'])(
    'has no detected violations in the %s dialog',
    async (view) => {
      const user = userEvent.setup()
      render(<App />)
      const button =
        view === 'calculation'
          ? 'How are payouts calculated?'
          : view === 'status'
            ? 'Explore payout states'
            : 'View payout for Aug 3'
      await user.click(screen.getByRole('button', { name: button }))
      if (view.startsWith('report')) {
        await user.click(screen.getByRole('button', { name: 'Report a discrepancy' }))
        if (view === 'report-errors')
          await user.click(screen.getByRole('button', { name: 'Preview report' }))
        if (view === 'report-preview') {
          await user.selectOptions(
            screen.getByRole('combobox', { name: 'What needs reviewing?' }),
            'earnings',
          )
          fireEvent.change(screen.getByRole('textbox', { name: 'Describe the issue' }), {
            target: { value: 'Fictional earnings review question' },
          })
          await user.click(screen.getByRole('button', { name: 'Preview report' }))
        }
      }
      const results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false } },
      })
      expect(
        results.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map((node) => node.target),
        })),
      ).toEqual([])
    },
  )
})
