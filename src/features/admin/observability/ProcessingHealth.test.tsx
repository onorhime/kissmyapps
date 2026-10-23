import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminGateway } from '../api'
import { createAdminGateway } from '../api/gateway'
import { mapAdminProcessingHealth, PROCESSING_ALERT_LABELS } from '../api/processingHealth'
import { ProcessingHealth } from './ProcessingHealth'

const row = () => ({
  generated_at: new Date().toISOString(),
  attention_required: false,
  reasons: [],
  enabled: true,
  current_worker: 'stripe-worker',
  last_tick_at: new Date().toISOString(),
  last_cycle_at: new Date().toISOString(),
  external_alerts_configured: false,
  queues: ['stripe', 'commercial', 'metrics'].map((worker) => ({
    worker,
    pending: 0,
    processing: 0,
    failed: 0,
    expired_leases: 0,
    oldest_unfinished_at: null,
  })),
  last_incident: null,
})
const ready = (value = row()) => ({
  status: 'ready' as const,
  data: mapAdminProcessingHealth(value),
  error: null,
})
const gateway = (load = vi.fn(async () => ready())) =>
  ({ getProcessingHealth: load }) as unknown as AdminGateway
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('processing health', () => {
  it('maps bare/enveloped responses without accepting unknown as zero', () => {
    const value = row()
    expect(mapAdminProcessingHealth([{ get_admin_processing_health: value }])).toEqual(
      mapAdminProcessingHealth(value),
    )
    for (const change of [
      { reasons: undefined },
      { attention_required: null },
      { reasons: ['untrusted'] },
      { reasons: ['scheduler_paused'], attention_required: false },
      { enabled: false },
      { queues: [] },
      { queues: [value.queues[0], value.queues[0], value.queues[0]] },
      { queues: [{ ...value.queues[0], failed: -1 }, ...value.queues.slice(1)] },
      { last_incident: {} },
      { generated_at: 'bad' },
      { last_tick_at: undefined },
      { last_tick_at: null },
      { last_cycle_at: null },
      { last_tick_at: new Date(Date.now() - 240_000).toISOString() },
      { last_cycle_at: new Date(Date.now() - 660_000).toISOString() },
      { external_alerts_configured: undefined },
    ])
      expect(() => mapAdminProcessingHealth({ ...value, ...change })).toThrow()
  })
  it('reports healthy evidence without claiming external delivery or reconciliation', async () => {
    render(<ProcessingHealth gateway={gateway()} />)
    expect(await screen.findByText(/Processing is healthy/)).toBeVisible()
    expect(screen.getByText('Not configured')).toBeVisible()
    expect(screen.getByText(/do not notify you while it is closed/)).toBeVisible()
    expect(screen.getByText(/not payment or payout reconciliation/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /restart|resume|replay/i })).not.toBeInTheDocument()
  })
  it.each(Object.entries(PROCESSING_ALERT_LABELS))(
    'surfaces %s with an alert',
    async (reason, text) => {
      const value = { ...row(), attention_required: true, reasons: [reason] }
      render(
        <ProcessingHealth
          gateway={gateway(vi.fn(async () => ready(value as ReturnType<typeof row>)))}
        />,
      )
      expect(await screen.findByRole('alert')).toHaveTextContent(text)
      expect(screen.queryByText(/Processing is healthy/)).not.toBeInTheDocument()
    },
  )
  it('shows managed delivery and includes its failures in existing attention', async () => {
    const value = {
      ...row(),
      attention_required: true,
      reasons: ['managed_checkout_issue'],
      managed_checkout: {
        attention_required: true,
        schedule: {
          enabled: false,
          paused_reason: 'worker_lease_expired',
          last_tick_at: new Date().toISOString(),
          last_success_at: null,
        },
        callbacks: { pending: 2, leased: 1, retrying: 2, expired_leases: 1 },
      },
    }
    const data = mapAdminProcessingHealth(value)
    render(
      <ProcessingHealth
        gateway={gateway(vi.fn(async () => ({ status: 'ready' as const, data, error: null })))}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Managed checkout delivery')
    expect(screen.getByRole('article', { name: 'Managed checkout delivery' })).toHaveTextContent(
      'Needs attention',
    )
    expect(screen.getByRole('article', { name: 'Managed checkout delivery' })).toHaveTextContent(
      'Waiting: 2',
    )
    expect(screen.getByText('Sales and creator payouts have separate controls.')).toBeVisible()
    expect(() =>
      mapAdminProcessingHealth({ ...value, reasons: [], attention_required: false }),
    ).toThrow()
    expect(() =>
      mapAdminProcessingHealth({
        ...value,
        managed_checkout: {
          ...value.managed_checkout,
          callbacks: { ...value.managed_checkout.callbacks, expired_leases: 2 },
        },
      }),
    ).toThrow()
  })
  it('marks a stale server snapshot unknown', async () => {
    const value = { ...row(), generated_at: new Date(Date.now() - 240_000).toISOString() }
    render(<ProcessingHealth gateway={gateway(vi.fn(async () => ready(value)))} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('snapshot is stale')
  })
  it('shows configured notifications without claiming inbox delivery', async () => {
    const value = {
      ...row(),
      external_alerts_configured: true,
      notifications: {
        enabled: true,
        last_checked_at: new Date().toISOString(),
        pending: 0,
        failed: 0,
        last_accepted_at: new Date().toISOString(),
      },
    }
    render(<ProcessingHealth gateway={gateway(vi.fn(async () => ready(value)))} />)
    expect(await screen.findByText('Configured')).toBeVisible()
    expect(screen.getByText(/Acceptance is not proof of inbox delivery/)).toBeVisible()
  })
  it('warns when notification monitoring or delivery fails', async () => {
    const value = {
      ...row(),
      external_alerts_configured: true,
      notifications: {
        enabled: true,
        last_checked_at: null,
        pending: 1,
        failed: 1,
        last_accepted_at: null,
      },
    }
    render(<ProcessingHealth gateway={gateway(vi.fn(async () => ready(value)))} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('email monitor is stale')
    expect(screen.getByRole('alert')).toHaveTextContent('need operator review')
    expect(() => mapAdminProcessingHealth({ ...row(), external_alerts_configured: true })).toThrow()
  })
  it('shows errors and retries without fabricating healthy evidence', async () => {
    const load = vi.fn().mockRejectedValueOnce(Error('private')).mockResolvedValue(ready())
    render(<ProcessingHealth gateway={gateway(load)} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    await userEvent.click(screen.getByRole('button', { name: 'Refresh processing health' }))
    expect(await screen.findByText(/Processing is healthy/)).toBeVisible()
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('does not expose health to unauthorized users or unconfigured clients', async () => {
    expect(await createAdminGateway(null).getProcessingHealth?.()).toMatchObject({
      status: 'unconfigured',
      data: null,
    })
    const rpc = vi.fn(async () => ({ data: null, error: { code: '42501', message: 'private' } }))
    const g = createAdminGateway({ rpc })
    render(<ProcessingHealth gateway={g} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Owner or Operations')
    expect(rpc).toHaveBeenCalledWith('get_admin_processing_health', undefined)
  })
  it('distinguishes historical issues from current health and unknown worker HTTP from zero', async () => {
    const value = {
      ...row(),
      last_incident: {
        run_id: '409f4981-dad5-4fbd-817e-87811be6ad37',
        worker: 'metrics-worker',
        outcome: 'failed',
        dispatched_at: '2026-09-07T09:17:00Z',
        finished_at: '2026-09-07T09:18:00Z',
        error_code: 'worker_http_failure',
        dispatch_http_status: 503,
        diagnostic_code: null,
        upstream_http_status: null,
        duration_ms: null,
      },
    }
    render(
      <ProcessingHealth
        gateway={gateway(vi.fn(async () => ready(value as unknown as ReturnType<typeof row>)))}
      />,
    )
    expect(await screen.findByText(/Processing is healthy/)).toBeVisible()
    await userEvent.click(screen.getByText(/Last recorded worker issue/))
    expect(screen.getByText(/Worker HTTP: Not recorded/)).toBeVisible()
  })
  it('periodically refreshes only in a visible page and cleans up timers', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => ready())
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const view = render(<ProcessingHealth gateway={gateway(load)} />)
    await act(async () => {})
    expect(load).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(load).toHaveBeenCalledTimes(2)
    visible.mockReturnValue('hidden')
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(load).toHaveBeenCalledTimes(2)
    visible.mockReturnValue('visible')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(load).toHaveBeenCalledTimes(3)
    view.unmount()
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(load).toHaveBeenCalledTimes(3)
  })
})
