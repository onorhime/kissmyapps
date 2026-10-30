import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  eventComparable,
  eventSummaries,
  getDataset,
  lastHours,
  rangeTotals,
  volumeSeries,
} from './data/model'
import { eventCatalogs, initialProjects } from './data/sample'
import { formatChange } from './format'
import { isMerchantConsole } from './host'
import { MerchantApp } from './MerchantApp'
import { href, parseRoute } from './routes'
import type { Route } from './routes'

const owner = {
  name: 'Victory Onorhime',
  email: 'victory@nobrainerlab.com',
  merchant: 'Nobrainer Lab',
}
const location = (hostname: string, search = '', pathname = '/') => ({ hostname, search, pathname })

describe('merchant console host', () => {
  it('opens on the merchant subdomain and with ?app=merchant elsewhere', () => {
    expect(isMerchantConsole(location('merchant.kissmyapps.dev'))).toBe(true)
    expect(isMerchantConsole(location('merchant.localhost'))).toBe(true)
    expect(isMerchantConsole(location('localhost', '?app=merchant'))).toBe(true)
    expect(isMerchantConsole(location('localhost'))).toBe(false)
  })

  it('leaves the partner and admin hosts and the Stripe connect pages alone', () => {
    expect(isMerchantConsole(location('partners.kissmyapps.dev', '?app=merchant'))).toBe(false)
    expect(isMerchantConsole(location('admin.kissmyapps.dev', '?app=merchant'))).toBe(false)
    expect(isMerchantConsole(location('merchant.kissmyapps.dev', '', '/merchant/callback'))).toBe(
      false,
    )
  })
})

describe('merchant routes', () => {
  it('round-trips every page through the hash', () => {
    const routes: Route[] = [
      { name: 'sign-in' },
      { name: 'projects' },
      { name: 'overview', projectId: 'speaksix' },
      { name: 'event', projectId: 'speaksix', eventName: 'trial_started' },
      { name: 'explore', projectId: 'speaksix', eventName: 'paywall_viewed' },
      { name: 'users', projectId: 'speaksix', userId: 'usr_1' },
      { name: 'install', projectId: 'speaksix', platform: 'flutter' },
      { name: 'settings', projectId: 'speaksix', section: 'keys' },
    ]
    for (const route of routes) expect(parseRoute(href(route))).toEqual(route)
  })

  it('falls back to safe pages for unknown hashes', () => {
    expect(parseRoute('#nowhere')).toEqual({ name: 'projects' })
    expect(parseRoute('#p/speaksix/settings/billing')).toEqual({
      name: 'settings',
      projectId: 'speaksix',
      section: 'general',
    })
  })
})

describe('sample data', () => {
  const speakSix = initialProjects.find((project) => project.id === 'speaksix')!
  const noon = new Date(2026, 9, 30, 12, 0).getTime()

  it('keeps event totals equal to the sum of their rows', () => {
    const dataset = getDataset(speakSix, noon)!
    const totals = rangeTotals(dataset, '30d')
    const rows = eventSummaries(dataset, '30d').reduce((sum, row) => sum + row.total, 0)
    expect(rows).toBe(totals.events)
    expect(totals.comparable).toBe(true)
  })

  it('charts the last 24 clock hours, even just after midnight', () => {
    const justAfterMidnight = new Date(2026, 9, 30, 0, 10).getTime()
    expect(lastHours(justAfterMidnight)).toHaveLength(24)
    const series = volumeSeries(getDataset(speakSix, justAfterMidnight)!, 'today')
    expect(series).toHaveLength(24)
    expect(series.at(-1)?.partial).toBe(true)
    expect(series.slice(0, -1).every((point) => point.value > 0)).toBe(true)
  })

  it('only compares events that existed for the whole earlier window', () => {
    const funnel = eventCatalogs.speaksix.find((event) => event.name === 'funnel_entered')!
    expect(eventComparable(funnel, '7d')).toBe(true)
    expect(eventComparable(funnel, '30d')).toBe(false)
  })

  it('shows differences instead of percentages on small counts', () => {
    expect(formatChange(3, 1).text).toBe('+2')
    expect(formatChange(1, 1).text).toBe('No change')
    expect(formatChange(1200, 1000)).toEqual({ text: '+20.0%', tone: 'positive' })
  })
})

describe('merchant console', () => {
  beforeEach(() => {
    sessionStorage.clear()
    window.location.hash = ''
  })

  it('signs in and lists the workspace projects', async () => {
    const user = userEvent.setup()
    window.location.hash = '#sign-in'
    render(<MerchantApp />)

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByText('Enter the email you use for your merchant account.')).toBeVisible()

    await user.type(screen.getByLabelText('Work email'), 'victory@nobrainerlab.com')
    await user.type(screen.getByLabelText('Password'), 'correct horse battery')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
    const table = screen.getByRole('table')
    expect(within(table).getByText('SpeakSix')).toBeVisible()
    expect(within(table).getByText('Waiting for first event')).toBeVisible()
  })

  it('creates a server key and shows it only once', async () => {
    const user = userEvent.setup()
    window.location.hash = '#p/speaksix/settings/keys'
    render(<MerchantApp initialSession={owner} />)

    await user.click(await screen.findByRole('button', { name: 'New key' }))
    await user.type(screen.getByLabelText('Name'), 'Backend import')
    await user.click(screen.getByRole('button', { name: 'Server key' }))
    await user.click(screen.getByRole('button', { name: 'Create key' }))

    const token = await screen.findByText(/^kma_sk_live_[A-Za-z0-9]{32}$/)
    expect(token).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'I have stored it' }))
    await waitFor(() => expect(screen.queryByText(token.textContent ?? '')).toBeNull())
    expect(screen.getByText('Backend import')).toBeVisible()
  })
})
