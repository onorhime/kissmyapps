import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FunnelMetricsPanel } from './FunnelMetricsPanel'
import { funnelMetricTemplate } from '../templates'
import type {
  FunnelMetricConfiguration,
  FunnelMetricReport,
  FunnelMetricsGateway,
  FunnelMetricsResult,
} from '../types'

const ready = <T,>(data: T): FunnelMetricsResult<T> => ({ data, status: 'ready', error: null })
const config = (funnelId = 'funnel-a'): FunnelMetricConfiguration => ({
  productId: 'product-a',
  funnelId,
  draft: {
    revision: 3,
    template: 'sales',
    metrics: funnelMetricTemplate('sales'),
    updatedAt: null,
  },
  published: null,
  versions: [],
  eventKeys: ['lead_registered', 'checkout_started'],
})
const error = (code: 'conflict' | 'unavailable') => ({
  data: null,
  status: 'error' as const,
  error: {
    code,
    message:
      code === 'conflict'
        ? 'This draft changed in another tab. Reload before saving.'
        : 'Network unavailable. Your edits are still here.',
    retryable: code === 'unavailable',
  },
})
function gateway(initial = config()): FunnelMetricsGateway {
  return {
    getConfiguration: vi.fn(async () => ready(initial)),
    saveDraft: vi.fn(async (input) =>
      ready({
        ...initial,
        draft: {
          ...initial.draft,
          revision: input.expectedRevision + 1,
          metrics: input.metrics,
          template: input.template,
        },
      }),
    ),
    publish: vi.fn(async (input) =>
      ready({
        ...initial,
        draft: { ...initial.draft, revision: input.expectedRevision + 1 },
        published: {
          version: 1,
          publishedAt: '2026-10-14T10:00:00Z',
          metrics: initial.draft.metrics,
        },
        versions: [{ version: 1, publishedAt: '2026-10-14T10:00:00Z' }],
      }),
    ),
    validateEvent: vi.fn(async () =>
      ready({ valid: true, errors: [], matchedMetricKeys: [], warnings: [] }),
    ),
    preview: vi.fn(async () =>
      ready<FunnelMetricReport>({
        productId: 'product-a',
        funnelId: 'funnel-a',
        version: null,
        status: 'unpublished',
        publishedAt: null,
        effectiveUntil: null,
        lastReceivedAt: null,
        asOf: null,
        externalCommerceStatus: 'unconnected',
        commissionStatus: 'held',
        externalCommerceUpdatedAt: null,
        warnings: [],
        metrics: [
          {
            key: 'registered_leads',
            label: 'Registered leads',
            kind: 'unique_people',
            value: 1,
            status: 'available',
            updatedAt: null,
          },
        ],
      }),
    ),
    getAdminReport: vi.fn(async () => error('unavailable')),
    getReport: vi.fn(async () => error('unavailable')),
  }
}
const props = {
  productId: 'product-a',
  funnelId: 'funnel-a',
  funnelName: 'Product launch',
  canManage: true,
  onClose: vi.fn(),
}
async function nameInput() {
  return within(await screen.findByRole('region', { name: 'Metric 1' })).getByLabelText('Name')
}

describe('admin funnel reporting builder', () => {
  it('keeps saved revision and publishes only after explicit confirmation', async () => {
    const api = gateway(),
      user = userEvent.setup()
    render(<FunnelMetricsPanel {...props} gateway={api} />)
    const input = await nameInput()
    await user.clear(input)
    await user.type(input, 'New registered leads')
    expect(screen.getByRole('button', { name: 'Publish reporting version' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save reporting draft' }))
    await screen.findByText('Reporting draft saved. Creators still see the published version.')
    expect(api.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'product-a',
        funnelId: 'funnel-a',
        expectedRevision: 3,
        metrics: expect.arrayContaining([
          expect.objectContaining({ label: 'New registered leads' }),
        ]),
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Publish reporting version' }))
    expect(api.publish).not.toHaveBeenCalled()
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Publish version' }),
    )
    await screen.findByText('Published version 1')
    expect(api.publish).toHaveBeenCalledWith({
      productId: 'product-a',
      funnelId: 'funnel-a',
      expectedRevision: 4,
    })
  })
  it('retains edits after failed save and allows a deliberate retry', async () => {
    const api = gateway()
    vi.mocked(api.saveDraft).mockResolvedValueOnce(error('unavailable'))
    const user = userEvent.setup()
    render(<FunnelMetricsPanel {...props} gateway={api} />)
    const input = await nameInput()
    await user.clear(input)
    await user.type(input, 'Keep my draft')
    await user.click(screen.getByRole('button', { name: 'Save reporting draft' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable')
    expect(input).toHaveValue('Keep my draft')
    await user.click(screen.getByRole('button', { name: 'Save reporting draft' }))
    await screen.findByText('Reporting draft saved. Creators still see the published version.')
    expect(api.saveDraft).toHaveBeenCalledTimes(2)
  })
  it('blocks stale overwrite after revision conflict until explicit reload/discard', async () => {
    const api = gateway()
    vi.mocked(api.saveDraft).mockResolvedValueOnce(error('conflict'))
    const user = userEvent.setup()
    render(<FunnelMetricsPanel {...props} gateway={api} />)
    const input = await nameInput()
    await user.clear(input)
    await user.type(input, 'Local unsaved')
    await user.click(screen.getByRole('button', { name: 'Save reporting draft' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('changed in another tab')
    expect(input).toHaveValue('Local unsaved')
    expect(screen.getByRole('button', { name: 'Save reporting draft' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Publish reporting version' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reload reporting draft' }))
    expect(api.getConfiguration).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Discard and reload' }))
    await waitFor(() => expect(api.getConfiguration).toHaveBeenCalledTimes(2))
    expect(await nameInput()).toHaveValue('Registered leads')
  })
  it('applies creation template only to an empty unpublished draft', async () => {
    const existing = gateway()
    const mounted = render(
      <FunnelMetricsPanel {...props} gateway={existing} initialTemplate="webinar" />,
    )
    expect(await nameInput()).toHaveValue('Registered leads')
    mounted.unmount()
    const empty = config()
    empty.draft.metrics = []
    empty.draft.template = 'blank'
    const api = gateway(empty)
    render(<FunnelMetricsPanel {...props} gateway={api} initialTemplate="webinar" />)
    expect(await nameInput()).toHaveValue('Webinar registrations')
    expect(api.saveDraft).not.toHaveBeenCalled()
    expect(api.publish).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save reporting draft' })).toBeEnabled()
  })
  it('sample validation and report previews never save or publish', async () => {
    const api = gateway(),
      user = userEvent.setup()
    render(<FunnelMetricsPanel {...props} gateway={api} />)
    await nameInput()
    await user.click(screen.getByRole('button', { name: 'Insert example event' }))
    expect(api.validateEvent).not.toHaveBeenCalled()
    expect(api.preview).not.toHaveBeenCalled()
    expect(api.getAdminReport).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Validate sample event' }))
    expect(await screen.findByText(/Sample event structure is valid/)).toHaveTextContent(
      'This does not verify your product connection, creator attribution or which report cards will count the event.',
    )
    expect(
      screen.getByText(/Standard v2 journey events do not need a custom card/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Preview sample report' }))
    await screen.findByText(/Sample preview only. No events/)
    expect(api.validateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'product-a',
        funnelId: 'funnel-a',
        event: expect.objectContaining({ event_name: 'lead_registered' }),
      }),
    )
    expect(api.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleEvents: [expect.objectContaining({ subject_id: 'sample_person_0001' })],
      }),
    )
    expect(api.saveDraft).not.toHaveBeenCalled()
    expect(api.publish).not.toHaveBeenCalled()
  })
  it('uses confirmed attendance without an incompatible default snapshot ratio', async () => {
    const empty = config()
    empty.draft.metrics = []
    empty.draft.template = 'blank'
    const api = gateway(empty),
      user = userEvent.setup()
    render(<FunnelMetricsPanel {...props} gateway={api} initialTemplate="webinar" />)
    await nameInput()
    const attendance = within(screen.getByRole('region', { name: 'Metric 2' }))
    expect(attendance.getByLabelText(/^Event key/)).toHaveValue('webinar_attendance_updated')
    expect(attendance.getByLabelText(/^State to count/)).toHaveValue('attended')
    expect(screen.getByRole('button', { name: 'Save reporting draft' })).toBeEnabled()
    expect(screen.queryByRole('region', { name: 'Metric 4' })).not.toBeInTheDocument()
    expect(attendance.getByRole('option', { name: 'People active right now' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save reporting draft' }))
    await screen.findByText('Reporting draft saved. Creators still see the published version.')
    expect(api.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: funnelMetricTemplate('webinar') }),
    )
    expect(api.publish).not.toHaveBeenCalled()
  })
  it('does not replace an existing saved webinar card with the changed starter template', async () => {
    const saved = config()
    saved.draft.template = 'webinar'
    saved.draft.metrics = [
      {
        ...funnelMetricTemplate('webinar')[0],
        key: 'my_attendees',
        label: 'My existing attendees',
        eventKey: 'webinar_attended',
      },
    ]
    const api = gateway(saved)
    render(<FunnelMetricsPanel {...props} gateway={api} initialTemplate="webinar" />)
    expect(await nameInput()).toHaveValue('My existing attendees')
    expect(screen.getByLabelText(/^Event key/)).toHaveValue('webinar_attended')
    expect(api.saveDraft).not.toHaveBeenCalled()
    expect(api.publish).not.toHaveBeenCalled()
  })
  it('requests explicit Test performance without saving any reporting settings', async () => {
    const api = gateway(),
      user = userEvent.setup()
    render(<FunnelMetricsPanel {...props} gateway={api} />)
    await nameInput()
    await user.click(screen.getByText('Recorded performance'))
    await user.selectOptions(screen.getByLabelText('Performance environment'), 'test')
    await user.click(screen.getByRole('button', { name: 'Load recorded performance' }))
    await waitFor(() =>
      expect(api.getAdminReport).toHaveBeenCalledWith(
        expect.objectContaining({
          productId: 'product-a',
          funnelId: 'funnel-a',
          environment: 'test',
        }),
      ),
    )
    expect(
      screen.getByText(/older events without a verified Test\/Live classification/),
    ).toBeInTheDocument()
    expect(api.saveDraft).not.toHaveBeenCalled()
    expect(api.publish).not.toHaveBeenCalled()
  })
  it('ignores a late response from the previous product/funnel scope', async () => {
    let resolveFirst!: (value: FunnelMetricsResult<FunnelMetricConfiguration>) => void
    const api = gateway()
    vi.mocked(api.getConfiguration)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValueOnce(
        ready({
          ...config('funnel-b'),
          draft: {
            ...config().draft,
            metrics: [{ ...funnelMetricTemplate('sales')[0], label: 'Second funnel' }],
          },
        }),
      )
    const mounted = render(<FunnelMetricsPanel {...props} gateway={api} />)
    mounted.rerender(<FunnelMetricsPanel {...props} funnelId="funnel-b" gateway={api} />)
    expect(await nameInput()).toHaveValue('Second funnel')
    await act(async () => resolveFirst(ready(config())))
    expect(await nameInput()).toHaveValue('Second funnel')
  })
  it('read-only accounts cannot edit, save or publish definitions', async () => {
    const api = gateway()
    render(<FunnelMetricsPanel {...props} gateway={api} canManage={false} />)
    expect(await nameInput()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save reporting draft' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Publish reporting version' })).toBeDisabled()
    expect(api.saveDraft).not.toHaveBeenCalled()
  })
  it('warns before closing unsaved configuration and leaves the draft if cancelled', async () => {
    const api = gateway(),
      close = vi.fn(),
      user = userEvent.setup()
    render(<FunnelMetricsPanel {...props} gateway={api} onClose={close} />)
    await user.type(await nameInput(), ' updated')
    await user.click(screen.getByRole('button', { name: 'Close reporting metrics' }))
    expect(close).not.toHaveBeenCalled()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(await nameInput()).toHaveValue('Registered leads updated')
    await user.click(screen.getByRole('button', { name: 'Close reporting metrics' }))
    await user.click(screen.getByRole('button', { name: 'Discard and close' }))
    expect(close).toHaveBeenCalledOnce()
  })
})
