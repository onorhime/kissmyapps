import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { JourneyPerformance } from './JourneyPerformance'
import { mapFunnelJourney } from './journey'
import { journeyPayload } from './journey.test-fixtures'

const valueFor = (container: HTMLElement, label: string) =>
  within(container).getByText(label, { selector: 'dt' }).nextElementSibling

describe('same-cohort journey presentation', () => {
  it('renders a partial transfer recovery separately from pending commission and net approved earnings', () => {
    const payload = journeyPayload()
    Object.assign(payload.commerce[0], {
      pending_commission_minor: 0,
      approved_commission_minor: 1400,
      paid_commission_minor: 1400,
      reversed_commission_minor: 600,
    })
    render(<JourneyPerformance report={mapFunnelJourney(payload)} timeZone="UTC" />)
    const earnings = screen.getByRole('region', { name: 'USD cohort revenue and earnings' })
    expect(valueFor(earnings, 'Pending commission')).toHaveTextContent('$0.00')
    expect(valueFor(earnings, 'Commission reversals')).toHaveTextContent('$6.00')
    expect(valueFor(earnings, 'Approved earnings, including transferred')).toHaveTextContent(
      '$14.00',
    )
    expect(valueFor(earnings, 'Transferred to Stripe')).toHaveTextContent('$14.00')
  })
  it('preserves net earned commission including transferred funds without adding transfer as new earnings', () => {
    render(
      <JourneyPerformance report={mapFunnelJourney(journeyPayload())} timeZone="Africa/Lagos" />,
    )
    const earnings = screen.getByRole('region', { name: 'USD cohort revenue and earnings' })
    expect(valueFor(earnings, 'Approved earnings, including transferred')).toHaveTextContent(
      '$507.00',
    )
    expect(valueFor(earnings, 'Transferred to Stripe')).toHaveTextContent('$300.00')
    expect(valueFor(earnings, 'Approved EPC')).toHaveTextContent('$0.507')
    expect(valueFor(earnings, 'Approved earnings per 1,000 clicks')).toHaveTextContent('$507.00')
    expect(screen.queryByText('$807.00')).not.toBeInTheDocument()
    expect(
      screen.getByText(/Transfers to Stripe are not confirmation of a bank payout/),
    ).toBeInTheDocument()
    expect(screen.getByText('TEST data — no real earnings')).toBeInTheDocument()
    expect(
      screen.getByText(/9 clicks have no verified Test\/Live classification/),
    ).toBeInTheDocument()
  })
  it('keeps unknown attendance separate, uses distinct refunded orders, and renders zero denominators unavailable', () => {
    const report = mapFunnelJourney(journeyPayload())
    render(
      <JourneyPerformance
        report={{
          ...report,
          definitionVersion: 2,
          configuredStages: [
            { key: 'attendance_unknown', label: 'Attendance unknown', people: 6 },
            { key: 'attendance_missed', label: 'Confirmed no-shows', people: 2 },
          ],
          configuredRates: report.rates,
          configuredPaths: [
            { key: 'paid_matching', label: 'Payment → matching → group', people: 4 },
          ],
        }}
        timeZone="UTC"
      />,
    )
    expect(screen.getByText('Attendance unknown').nextElementSibling).toHaveTextContent('6')
    expect(screen.getByText('Confirmed no-shows').nextElementSibling).toHaveTextContent('2')
    expect(
      screen.getByText('Orders with a successful refund').nextElementSibling,
    ).toHaveTextContent('1')
    const recovery = screen.getByRole('row', { name: /Webinar recovery conversion/ })
    expect(within(recovery).getByText(/No eligible audience yet/).parentElement).toHaveTextContent(
      '—',
    )
    expect(
      screen.getByText(/Some people are still within their conversion window/),
    ).toBeInTheDocument()
    expect(screen.getByText('Payment → matching → group').nextElementSibling).toHaveTextContent(
      '4 people',
    )
    expect(screen.getByText(/same person may qualify for more than one path/)).toBeInTheDocument()
  })
  it('shows only configured stages and ordered paths for another product', () => {
    const report = mapFunnelJourney(journeyPayload())
    render(
      <JourneyPerformance
        report={{
          ...report,
          definitionVersion: 3,
          configuredStages: [
            { key: 'trial', label: 'Trial users', people: 12 },
            { key: 'activated', label: 'Activated workspaces', people: 8 },
          ],
          configuredRates: [
            {
              key: 'activation',
              label: 'Trial activation',
              numerator: 8,
              denominator: 12,
              value: 66.67,
              status: 'available',
            },
          ],
          configuredPaths: [
            { key: 'trial_purchase', label: 'Trial → activation → purchase', people: 3 },
          ],
        }}
        timeZone="UTC"
      />,
    )
    expect(screen.getByText('Configured journey · version 3')).toBeInTheDocument()
    expect(screen.getByText('Trial users').nextElementSibling).toHaveTextContent('12')
    expect(screen.getByText('Activated workspaces').nextElementSibling).toHaveTextContent('8')
    expect(screen.getByRole('row', { name: /Trial activation/ })).toHaveTextContent('66.7%')
    expect(screen.getByText('Trial → activation → purchase').nextElementSibling).toHaveTextContent(
      '3 people',
    )
    for (const label of [
      'Email leads',
      'Webinar registrations',
      'Confirmed attendees',
      'Assessment started',
      'Payment before assessment or webinar',
    ])
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    expect(screen.getByText('Valid attributed clicks').nextElementSibling).toHaveTextContent(
      '1,000',
    )
    expect(
      screen.getByRole('region', { name: 'USD cohort revenue and earnings' }),
    ).toBeInTheDocument()
  })
  it('does not fall back to hidden built-in webinar definitions when no configurable journey is published', () => {
    render(<JourneyPerformance report={mapFunnelJourney(journeyPayload())} timeZone="UTC" />)
    expect(screen.getByText(/No configurable journey is published/)).toBeInTheDocument()
    expect(screen.queryByText('Webinar registrations')).not.toBeInTheDocument()
    expect(screen.queryByText('Email leads')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('region', { name: 'Cohort conversion rates' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'USD cohort revenue and earnings' }),
    ).toBeInTheDocument()
  })
  it('never displays missing journey data as zeros or combines currencies', () => {
    const view = render(<JourneyPerformance timeZone="UTC" />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'does not mean activity or earnings are zero',
    )
    const source = journeyPayload()
    source.commerce.push({
      ...source.commerce[0],
      currency: 'EUR',
      approved_commission_minor: 10000,
    })
    view.rerender(<JourneyPerformance report={mapFunnelJourney(source)} timeZone="UTC" />)
    expect(
      screen.getByRole('region', { name: 'USD cohort revenue and earnings' }),
    ).toBeInTheDocument()
    expect(
      valueFor(
        screen.getByRole('region', { name: 'EUR cohort revenue and earnings' }),
        'Approved earnings, including transferred',
      ),
    ).toHaveTextContent('€100.00')
  })
})
