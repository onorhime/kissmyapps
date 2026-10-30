import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import { ProductStatsPage } from './ProductStatsPage'
import { statsGateway, statsOwner } from './productStats.fixture'

function renderStats(gateway = statsGateway(), role = statsOwner.role) {
  const props = {
    productId: 'product-1',
    context: { ...statsOwner, role },
    gateway,
    onBack: vi.fn(),
    onOpenSetup: vi.fn(),
    onOpenSubscriptions: vi.fn(),
  }
  return { ...render(<ProductStatsPage {...props} />), props }
}

describe('Product stats page', () => {
  it('explains traffic, conversions, sources, and subscriptions for one product', async () => {
    const { container } = renderStats()

    expect(await screen.findByRole('heading', { name: 'Daily Planner', level: 1 })).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'Human clicks', level: 3 })).toBeVisible()
    // 1,340 recorded clicks minus 140 bots.
    expect(screen.getAllByText('1,200')[0]).toBeVisible()
    expect(screen.getByText('140 bot clicks filtered out')).toBeVisible()
    expect(screen.getByText('4.5%')).toBeVisible()
    expect(screen.getByText('32% of previous step')).toBeVisible()

    const tiktok = screen.getByRole('row', { name: /TikTok/ })
    expect(within(tiktok).getByText('3.7%')).toBeVisible()

    expect(await screen.findByText('Paying right now')).toBeVisible()
    expect(screen.getByText(/Setup is 2 of 4 steps complete/)).toBeVisible()
    const audit = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(
      audit.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
    ).toEqual([])
  })

  it('reloads for a new period and links back to setup', async () => {
    const user = userEvent.setup()
    const gateway = statsGateway()
    const read = vi.spyOn(gateway, 'getAttributionOverview')
    const { props } = renderStats(gateway)
    await screen.findByRole('heading', { name: 'From click to customer' })

    await user.click(screen.getByRole('button', { name: '7 days' }))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    const input = read.mock.calls[1][0]
    expect(input.productId).toBe('product-1')
    expect(Date.parse(input.endsAt) - Date.parse(input.startsAt)).toBe(7 * 86_400_000)
    expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Open setup' }))
    expect(props.onOpenSetup).toHaveBeenCalledOnce()
  })

  it('shows a clear message instead of zeros when reporting fails', async () => {
    const gateway = statsGateway()
    gateway.getAttributionOverview = vi.fn(async () => ({
      data: null,
      status: 'error' as const,
      error: {
        code: 'temporarily_unavailable' as const,
        message: 'Operational reporting is temporarily unavailable.',
        retryable: true,
      },
    }))
    renderStats(gateway)

    expect(
      await screen.findByText('Operational reporting is temporarily unavailable.'),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: /Try again/ })).toBeVisible()
    expect(screen.queryByText('Human clicks')).not.toBeInTheDocument()
  })

  it('keeps reporting closed for support accounts', async () => {
    const gateway = statsGateway()
    const read = vi.spyOn(gateway, 'getSubscriptions')
    renderStats(gateway, 'support')

    expect(await screen.findByText(/Your role cannot view product reporting/)).toBeVisible()
    expect(read).not.toHaveBeenCalled()
  })
})
