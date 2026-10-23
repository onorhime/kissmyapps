import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { JourneyConfiguration } from './JourneyConfiguration'
import type { FunnelJourneyConfiguration, FunnelMetricsGateway } from '../types'

const ready = <T,>(data: T) => ({ status: 'ready' as const, data, error: null })
const saved: FunnelJourneyConfiguration = {
  funnelId: 'funnel-a',
  environment: 'test',
  conversionWindowDays: 45,
  updatedAt: '2026-10-22T10:00:00Z',
}
const gateway = (initial: FunnelJourneyConfiguration | null = null) => ({
  getJourneyConfiguration: vi.fn(async () => ready(initial)),
  saveJourneyConfiguration: vi.fn(async () => ready(saved)),
})
describe('future journey click configuration', () => {
  it('requires an explicit environment and saves only reporting settings', async () => {
    const user = userEvent.setup(),
      api = gateway()
    render(
      <JourneyConfiguration
        funnelId="funnel-a"
        canManage
        gateway={api as unknown as FunnelMetricsGateway}
      />,
    )
    await user.click(screen.getByText('Journey tracking settings'))
    const environment = await screen.findByLabelText('Tracked-click environment')
    expect(environment).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Save journey settings' })).toBeDisabled()
    await user.selectOptions(environment, 'test')
    await user.clear(screen.getByLabelText('Default reporting window (days)'))
    await user.type(screen.getByLabelText('Default reporting window (days)'), '45')
    await user.click(screen.getByRole('button', { name: 'Save journey settings' }))
    await waitFor(() =>
      expect(api.saveJourneyConfiguration).toHaveBeenCalledWith({
        funnelId: 'funnel-a',
        environment: 'test',
        conversionWindowDays: 45,
      }),
    )
    expect(
      await screen.findByText(/previous unclassified clicks remain excluded/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save journey settings' }))
    await waitFor(() =>
      expect(api.saveJourneyConfiguration).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedUpdatedAt: saved.updatedAt }),
      ),
    )
  })
  it('ignores a previous funnel response and keeps readers unable to change settings', async () => {
    let resolve!: (value: ReturnType<typeof ready<FunnelJourneyConfiguration>>) => void
    const api = gateway()
    api.getJourneyConfiguration.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const view = render(
      <JourneyConfiguration
        funnelId="funnel-a"
        canManage
        gateway={api as unknown as FunnelMetricsGateway}
      />,
    )
    await userEvent.click(screen.getByText('Journey tracking settings'))
    view.rerender(
      <JourneyConfiguration
        funnelId="funnel-b"
        canManage={false}
        gateway={api as unknown as FunnelMetricsGateway}
      />,
    )
    await screen.findByLabelText('Tracked-click environment')
    await act(async () => resolve(ready(saved)))
    expect(screen.getByLabelText('Tracked-click environment')).toHaveValue('')
    expect(screen.getByLabelText('Tracked-click environment')).toBeDisabled()
    expect(api.saveJourneyConfiguration).not.toHaveBeenCalled()
  })
})
