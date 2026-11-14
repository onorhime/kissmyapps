import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attribution, Context, Project, Role } from './api'
import { attributionBackendFixture as captured } from './attribution-backend.fixture'
import { attributionCostsBackendFixture as costsBackend } from './attribution-costs-backend.fixture'
import { attributionRevenueBackendFixture as revenueBackend } from './attribution-revenue-backend.fixture'
import { attributionRoiBackendFixture as roiBackend } from './attribution-roi-backend.fixture'
import { attributionRoiFixture as hand } from './attribution-roi.fixture'
import { downloadCsv } from './csv'
import { MerchantApp } from './MerchantApp'

// Ids change on every run of the database suite, so the tests look them up in the captured answer.
const costsAnswer = costsBackend.costs as {
  rows: Array<{ id: string; day: string; source: string; campaign: string }>
  rules: Array<{ id: string; link_name: string }>
  imports: Array<{ id: string; file_name: string }>
}
const spendId = (day: string, source: string, campaign = '') =>
  costsAnswer.rows.find(
    (row) => row.day === day && row.source === source && row.campaign === campaign,
  )?.id
const ruleId = (linkName: string) =>
  costsAnswer.rules.find((rule) => rule.link_name === linkName)?.id
const uploadId = (fileName: string) =>
  costsAnswer.imports.find((upload) => upload.file_name === fileName)?.id

// A stand-in for the Supabase client: a signed-in session, and rpc calls answered by handlers.
const fake = vi.hoisted(() => {
  type Session = { user: { id: string; email: string } } | null
  type Listener = (event: string, session: Session) => void
  const state = {
    session: null as Session,
    listeners: new Set<Listener>(),
    handlers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
    calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  }
  const auth = {
    onAuthStateChange(listener: Listener) {
      state.listeners.add(listener)
      setTimeout(() => listener('INITIAL_SESSION', state.session), 0)
      return { data: { subscription: { unsubscribe: () => state.listeners.delete(listener) } } }
    },
    async signOut() {
      state.session = null
      return { error: null }
    },
  }
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    state.calls.push({ name, args })
    const handler = state.handlers[name]
    if (!handler) return { data: null, error: { code: 'P0002', message: `No handler for ${name}` } }
    try {
      return { data: await handler(args), error: null }
    } catch (problem) {
      return { data: null, error: problem }
    }
  }
  return { state, client: { auth, rpc } }
})

vi.mock('../lib/supabase', () => ({
  supabase: fake.client,
  getSupabaseConfigurationIssue: () => null,
  requireSupabaseClient: () => fake.client,
}))

vi.mock('./csv', async (original) => ({
  ...(await original<typeof import('./csv')>()),
  downloadCsv: vi.fn(),
}))

const project: Project = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'SpeakSix',
  platforms: ['ios', 'android'],
  timezone: 'Africa/Lagos',
  allowed_origins: [],
  replay_enabled: true,
  created_at: '2026-10-01T09:00:00Z',
  last_event_at: '2026-11-13T08:30:00Z',
  attribution_enabled: true,
}

const context = (role: Role): Context => ({
  user: { id: 'user-1', email: 'victory@example.test', name: 'Victory Onorhime' },
  workspaces: [{ id: 'ws-1', name: 'No Brainer Lab', role, projects: [project] }],
})

function signedInAs(role: Role) {
  fake.state.session = { user: { id: 'user-1', email: 'victory@example.test' } }
  fake.state.handlers.analytics_bootstrap = () => context(role)
  fake.state.handlers.analytics_context = () => context(role)
}

const copy = <T = unknown,>(value: unknown) => structuredClone(value) as T
const calls = (name: string) => fake.state.calls.filter((call) => call.name === name)
const inputOf = (name: string) => calls(name).map((call) => call.args.p_input)
const failure = (message: string) => ({ code: '22023', message, details: 'invalid_input' })

// The phase 2 capture is a project with its apps, domain and conversions set up.
const view = (): Attribution => {
  const answer = copy<Attribution>(captured.attribution_get_with_installs)
  answer.events = [
    { name: 'order_paid', last_seen: '2026-11-13T08:00:00Z' },
    { name: 'coins_bought', last_seen: '2026-11-13T07:00:00Z' },
    { name: 'lesson_completed', last_seen: '2026-11-13T08:20:00Z' },
  ]
  return answer
}

const roiAnswer = ({ p_input }: Record<string, unknown>) => {
  const input = p_input as { group: string }
  if (input.group === 'day') return copy(hand.roi_days)
  if (input.group === 'campaign') return copy(hand.roi_campaigns)
  return copy(hand.roi_sources)
}

beforeEach(() => {
  // Mid-afternoon in Lagos on 2026-11-13, so "today" is the day the answers were made on.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T14:20:00Z') })
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  vi.mocked(downloadCsv).mockClear()
  fake.state.handlers = {
    analytics_project_settings: () => ({ project, role: 'owner', keys: [] }),
    attribution_get: () => view(),
    attribution_links: () => copy(captured.attribution_links_with_installs),
    attribution_roi: roiAnswer,
    attribution_cohorts: ({ p_input }) =>
      copy(
        (p_input as { interval: string }).interval === 'week'
          ? hand.cohorts_week
          : hand.cohorts_day,
      ),
    attribution_costs: () => copy(costsBackend.costs),
    attribution_revenue_setup: () => copy(revenueBackend.revenue_setup),
  }
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('attribution tabs', () => {
  it('lists ROI, Cohorts and Costs between Sources and Settings', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/roi'
    render(<MerchantApp />)
    const tabs = await screen.findByRole('navigation', { name: 'Attribution' })
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Setup', 'Links', 'Sources', 'ROI', 'Cohorts', 'Costs', 'Settings'])
    expect(within(tabs).getByRole('link', { name: 'ROI' })).toHaveAttribute('aria-current', 'page')
    expect(within(tabs).getByRole('link', { name: 'Costs' })).toHaveAttribute(
      'href',
      '#p/proj-1/attribution/costs',
    )
    expect(await screen.findByRole('heading', { name: 'ROI', level: 1 })).toBeInTheDocument()
  })
})

describe('ROI', () => {
  it('shows spend, revenue and ROAS by source, with day 7 and day 30 still filling', async () => {
    signedInAs('analyst')
    window.location.hash = '#p/proj-1/attribution/roi'
    render(<MerchantApp />)
    const tiles = await screen.findByRole('group', { name: 'Totals' })
    expect(await within(tiles).findByText('$4,330.50')).toBeInTheDocument()
    const table = await screen.findByRole('table')
    expect(within(tiles).getByText('$5,120.40')).toBeInTheDocument()
    expect(within(tiles).getByText('118%')).toBeInTheDocument()
    expect(within(tiles).getByText('Cost per install')).toBeInTheDocument()
    expect(within(tiles).getByText('$5.04')).toBeInTheDocument()
    expect(within(tiles).getByText('$45.11 of spend each')).toBeInTheDocument()
    expect(inputOf('attribution_roi')).toEqual(
      expect.arrayContaining([
        { range: '30d', group: 'source' },
        { range: '30d', group: 'day' },
      ]),
    )
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual([
      'MetaFrom an fbclid: a Facebook or Instagram ad or post',
      'TikTok',
      'influencer',
      'Google AdsFrom a gclid on the landing page',
      'Direct and organic',
    ])
    const meta = within(rows[0])
    expect(meta.getByText('$2,600.00')).toBeInTheDocument()
    expect(meta.getByText('$6.34')).toBeInTheDocument()
    expect(meta.getAllByText('130%')).toHaveLength(2)
    // Without spend there is nothing to divide: dashes, not 0%.
    expect(within(rows[4]).getAllByText('—').length).toBeGreaterThanOrEqual(5)
    expect(
      within(table).getByRole('columnheader', { name: /ROAS D7.*still filling/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Still filling: some people here arrived less than 7 or 30 days ago/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "1 spend line in NGN isn't included: the European Central Bank publishes no daily rate for it.",
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: /^Spend and revenue by day in the last 30 days\./ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'How ROI is counted' })).toBeInTheDocument()
    expect(screen.getByText(/in USD at the European Central Bank/)).toBeInTheDocument()
  })

  it('opens a source to its campaigns and goes back from the trail', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/roi'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await user.click(await screen.findByRole('button', { name: 'Meta: see its campaigns' }))
    expect(await screen.findByRole('heading', { name: 'Campaigns in Meta' })).toBeInTheDocument()
    expect(inputOf('attribution_roi')).toEqual(
      expect.arrayContaining([
        { range: '30d', group: 'campaign', source: 'meta' },
        { range: '30d', group: 'day', source: 'meta' },
      ]),
    )
    const trail = screen.getByRole('navigation', { name: 'Where you are in the report' })
    expect(within(trail).getByText('Meta')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('group', { name: 'Meta totals' })).toBeInTheDocument()
    expect(screen.getByText('No campaign')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'spring_sale: see its ad sets' }))
    await waitFor(() =>
      expect(inputOf('attribution_roi')).toContainEqual({
        range: '30d',
        group: 'adset',
        source: 'meta',
        campaign: 'spring_sale',
      }),
    )
    await user.click(within(trail).getByRole('button', { name: 'All sources' }))
    expect(await screen.findByRole('heading', { name: 'By source' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Where you are in the report' })).toBeNull()
  })

  it('changes the range and exports the rows shown as CSV', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/roi'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByRole('button', { name: 'Meta: see its campaigns' })
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    const [name, rows] = vi.mocked(downloadCsv).mock.calls[0]
    expect(name).toBe('SpeakSix-roi-source-30d.csv')
    expect(rows[0]).toEqual([
      'source',
      'people',
      'installs',
      'spend_usd',
      'cpi_usd',
      'paying_people',
      'revenue_usd',
      'revenue_d0_usd',
      'revenue_d7_usd',
      'revenue_d30_usd',
      'roas_d0',
      'roas_d7',
      'roas_d30',
      'roas',
    ])
    expect(rows[1].slice(0, 5)).toEqual(['meta', 520, 410, 2600, 6.34])
    expect(rows[5].slice(0, 5)).toEqual(['direct', 320, 150, 0, ''])

    await user.click(screen.getByRole('button', { name: '7 days' }))
    await waitFor(() =>
      expect(inputOf('attribution_roi')).toContainEqual({ range: '7d', group: 'source' }),
    )
  })

  it('says what to set up when there is nothing to count', async () => {
    fake.state.handlers.attribution_roi = () => copy(hand.roi_empty)
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/roi'
    render(<MerchantApp />)
    expect(
      await screen.findByRole('heading', { name: 'Nothing to count in the last 30 days yet' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Share a link' })).toHaveAttribute(
      'href',
      '#p/proj-1/attribution/links',
    )
    expect(screen.getByRole('link', { name: 'Track revenue' })).toHaveAttribute(
      'href',
      '#p/proj-1/attribution',
    )
    expect(screen.getByRole('link', { name: 'Add your spend' })).toHaveAttribute(
      'href',
      '#p/proj-1/attribution/costs',
    )
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('says where to add revenue or spend when one of them is missing', async () => {
    fake.state.handlers.attribution_roi = (args) => ({
      ...(roiAnswer(args) as object),
      has_revenue: false,
    })
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/roi'
    render(<MerchantApp />)
    expect(await screen.findByText(/No revenue has arrived yet/)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Send payments with the SDK’s revenue call' }),
    ).toHaveAttribute('href', '#p/proj-1/attribution')
    expect(
      screen.getByRole('link', {
        name: 'name the payment event your app already sends in Settings',
      }),
    ).toHaveAttribute('href', '#p/proj-1/attribution/settings')
    expect(screen.queryByText(/No spend is added yet/)).toBeNull()
  })

  it('says it could not load, and loads again on Try again', async () => {
    let fail = true
    fake.state.handlers.attribution_roi = (args) => {
      if (fail) throw failure('The report is busy.')
      return roiAnswer(args)
    }
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/roi'
    const user = userEvent.setup()
    render(<MerchantApp />)
    expect(await screen.findByText("Couldn't load ROI. The report is busy.")).toBeInTheDocument()
    fail = false
    await user.click(screen.getAllByRole('button', { name: 'Retry' })[0])
    expect(
      await screen.findByRole('button', { name: 'Meta: see its campaigns' }),
    ).toBeInTheDocument()
  })
})

describe('Cohorts', () => {
  it('shows each day’s people with revenue per person, and switches to ROAS and retention', async () => {
    signedInAs('analyst')
    window.location.hash = '#p/proj-1/attribution/cohorts'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const table = await screen.findByRole('table')
    expect(inputOf('attribution_cohorts')[0]).toEqual({ interval: 'day' })
    expect(within(table).getByRole('columnheader', { name: 'Day 0' })).toBeInTheDocument()
    // No group is 30 days old yet, so day 30 and later are left off.
    expect(within(table).queryByRole('columnheader', { name: 'Day 30' })).toBeNull()
    expect(within(table).getByRole('rowheader', { name: 'Fri, Nov 13' })).toBeInTheDocument()
    expect(within(table).getByLabelText(/^Fri, Nov 13, day 0: \$0\.90/)).toHaveClass('is-partial')
    expect(within(table).getByLabelText(/^Thu, Oct 22, day 0: nothing to show/)).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Totals' })).toHaveTextContent('918')

    await user.click(screen.getByRole('button', { name: 'ROAS' }))
    expect(within(table).getByRole('columnheader', { name: 'Spend' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retention' }))
    expect(within(table).getByLabelText(/^Thu, Nov 12, day 0: 100%/)).toBeInTheDocument()
    expect(screen.getByRole('group', { name: /^Share of people active again/ })).toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: /^Revenue per person by each day/ }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Weekly' }))
    await waitFor(() => expect(inputOf('attribution_cohorts')).toContainEqual({ interval: 'week' }))
    expect(await screen.findByRole('rowheader', { name: 'Week of Nov 9' })).toBeInTheDocument()
  })

  it('narrows to a source and one of its campaigns, from what ROI lists', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/cohorts'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByRole('table')
    expect(inputOf('attribution_roi')).toContainEqual({ range: '90d', group: 'source' })
    const sources = screen.getByLabelText('Source')
    expect(
      within(sources)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All sources', 'Meta', 'TikTok', 'influencer', 'Google Ads', 'Direct and organic'])
    await user.selectOptions(sources, 'Meta')
    await waitFor(() =>
      expect(inputOf('attribution_cohorts')).toContainEqual({ interval: 'day', source: 'meta' }),
    )
    const campaigns = await screen.findByLabelText('Campaign')
    await user.selectOptions(campaigns, 'No campaign')
    await waitFor(() =>
      expect(inputOf('attribution_cohorts')).toContainEqual({
        interval: 'day',
        source: 'meta',
        campaign: null,
      }),
    )
    await user.selectOptions(screen.getByLabelText('Source'), 'Direct and organic')
    await waitFor(() =>
      expect(inputOf('attribution_cohorts')).toContainEqual({ interval: 'day', source: null }),
    )
  })

  it('says nobody arrived, and offers every source again when one is chosen', async () => {
    fake.state.handlers.attribution_cohorts = () => copy(hand.cohorts_empty)
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/cohorts'
    const user = userEvent.setup()
    render(<MerchantApp />)
    expect(
      await screen.findByText(
        'Nobody arrived in the last 30 days yet. Rows fill in as people arrive.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    await user.selectOptions(screen.getByLabelText('Source'), 'TikTok')
    await user.click(await screen.findByRole('button', { name: 'Show all sources' }))
    expect(screen.getByLabelText('Source')).toHaveValue('all')
  })
})

describe('ROI and Cohorts with the real backend answers', () => {
  beforeEach(() => {
    // Just after midnight in Lagos on 2026-11-14, when the database suite ran.
    vi.setSystemTime(new Date('2026-11-14T00:10:00Z'))
    fake.state.handlers.attribution_roi = ({ p_input }) => {
      const input = p_input as { group: string }
      if (input.group === 'day') return copy(roiBackend.roi_days)
      if (input.group === 'campaign') return copy(roiBackend.roi_campaigns)
      return copy(roiBackend.roi_sources)
    }
    fake.state.handlers.attribution_cohorts = ({ p_input }) =>
      copy(
        (p_input as { interval: string }).interval === 'week'
          ? roiBackend.cohorts_week
          : roiBackend.cohorts_day,
      )
  })

  it('shows each source, what was left out for want of a rate, and its campaigns', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/roi'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const tiles = await screen.findByRole('group', { name: 'Totals' })
    expect(await within(tiles).findByText('$270.00')).toBeInTheDocument()
    expect(within(tiles).getByText('$117.58')).toBeInTheDocument()
    expect(within(tiles).getByText('44%')).toBeInTheDocument()
    expect(
      screen.getByText(
        "1 payment and 1 spend line in NGN aren't included: the European Central Bank publishes no daily rate for it.",
      ),
    ).toBeInTheDocument()
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual([
      'MetaFrom an fbclid: a Facebook or Instagram ad or post',
      'TikTok',
      'Google AdsFrom a gclid on the landing page',
      'Direct and organic',
    ])
    // Spend with nobody arriving earns back nothing: 0%, with no cost per install.
    expect(within(rows[2]).getAllByText('0%').length).toBeGreaterThan(0)
    expect(within(rows[2]).getByText('$25.00')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Meta: see its campaigns' }))
    await waitFor(() =>
      expect(inputOf('attribution_roi')).toContainEqual({
        range: '30d',
        group: 'campaign',
        source: 'meta',
      }),
    )
    const campaigns = await screen.findByRole('button', { name: 'spring: see its ad sets' })
    expect(campaigns).toBeInTheDocument()
    expect(screen.getByText('speaksix-funnel')).toBeInTheDocument()
    expect(screen.getByText('No campaign')).toBeInTheDocument()
  })

  it("shows today's people with what they paid so far, still filling, and leaves days to come blank", async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/cohorts'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const table = await screen.findByRole('table')
    expect(
      screen.getByText(
        "1 payment and 1 spend line in NGN aren't included: the European Central Bank publishes no daily rate for it.",
      ),
    ).toBeInTheDocument()
    // The newest group with people down to the oldest; earlier empty days are left off.
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual([
      'Sat, Nov 14',
      'Fri, Nov 13',
      'Thu, Nov 12',
      'Wed, Nov 11',
      'Tue, Nov 10',
      'Mon, Nov 9',
      'Sun, Nov 8',
    ])
    const today = within(table).getByRole('rowheader', { name: 'Sat, Nov 14' }).closest('tr')!
    const cells = within(today).getAllByRole('cell')
    // People, then day 0, 1, 3 and 7.
    expect(cells[0]).toHaveTextContent('1')
    const dayZero = within(cells[1]).getByLabelText(/^Sat, Nov 14, day 0: \$3\.00, still filling\./)
    expect(dayZero).toHaveClass('is-partial')
    expect(dayZero).toHaveTextContent('$3.00')
    // The answer carries what was paid so far on days still to come too; they stay blank.
    for (const cell of cells.slice(2)) expect(cell).toBeEmptyDOMElement()
    expect(within(table).getByLabelText(/^Thu, Nov 12, day 1: \$15\.00\. /)).not.toHaveClass(
      'is-partial',
    )

    await user.click(screen.getByRole('button', { name: 'Retention' }))
    expect(
      within(table).getByLabelText('Sat, Nov 14, day 0: still filling, nobody has finished it yet'),
    ).toBeInTheDocument()
    expect(
      within(table).getByLabelText(/^Fri, Nov 13, day 0: 100%, still filling\./),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Still filling: some of the group have not finished that day yet/),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Weekly' }))
    expect(
      await within(table).findByLabelText(/^Week of Nov 9, day 0: 86%, still filling\./),
    ).toBeInTheDocument()
  })
})

describe('Costs', () => {
  it('lists typed and uploaded spend, link prices and uploads, in each row’s currency', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/costs'
    render(<MerchantApp />)
    const totals = await screen.findByRole('group', { name: 'Spend totals' })
    await within(totals).findByText('$343.06')
    expect(within(totals).getByText('$320.88')).toBeInTheDocument()
    expect(within(totals).getByText('$15.00')).toBeInTheDocument()
    expect(within(totals).getByText('$7.18')).toBeInTheDocument()
    expect(
      screen.getByText(
        "1 spend line in NGN isn't included: the European Central Bank publishes no daily rate for it.",
      ),
    ).toBeInTheDocument()
    expect(inputOf('attribution_costs')[0]).toEqual({ range: '30d' })

    const panel = screen.getByRole('region', { name: 'Spend by day' })
    const rows = within(panel).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(7)
    expect(within(rows[0]).getByText('Facebook')).toBeInTheDocument()
    expect(within(rows[0]).getByText('adset-a')).toBeInTheDocument()
    expect(within(rows[2]).getByText('10.00 NGN')).toBeInTheDocument()
    expect(within(rows[4]).getByText('meta-oct.csv')).toBeInTheDocument()
    expect(within(rows[5]).getByText('All campaigns')).toBeInTheDocument()

    const prices = screen.getByRole('region', { name: 'Link prices' })
    expect(within(prices).getByText('0.05 EUR')).toBeInTheDocument()
    expect(within(prices).getByText('0.15 EUR')).toBeInTheDocument()
    expect(within(prices).getByText('Ended')).toBeInTheDocument()
    const uploads = screen.getByRole('region', { name: 'Recent uploads' })
    expect(within(uploads).getByText(/1 still from this file/)).toBeInTheDocument()
  })

  it('lets analysts read spend without changing it', async () => {
    signedInAs('analyst')
    window.location.hash = '#p/proj-1/attribution/costs'
    render(<MerchantApp />)
    await screen.findByText('$343.06')
    expect(
      screen.getByText('Developers, admins and the owner can add, upload and change spend.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add spend' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Upload CSV' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Change the amount/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add a link price' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('adds a day of spend, checking it first', async () => {
    fake.state.handlers.attribution_cost_save = () => ({ saved: 1 })
    signedInAs('developer')
    window.location.hash = '#p/proj-1/attribution/costs'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await user.click(await screen.findByRole('button', { name: 'Add spend' }))
    const form = screen.getByRole('form', { name: 'Add spend' })
    expect(within(form).getByLabelText('Day')).toHaveValue('2026-11-13')
    await user.type(within(form).getByLabelText('Ad set'), 'lagos')
    await user.click(within(form).getByRole('button', { name: 'Save spend' }))
    expect(
      within(form).getByText('Name the source in letters, numbers and _ . -, such as meta.'),
    ).toBeInTheDocument()
    expect(within(form).getByText('An ad set needs its campaign.')).toBeInTheDocument()
    expect(within(form).getByText('Enter what was spent, such as 120.50.')).toBeInTheDocument()
    expect(calls('attribution_cost_save')).toHaveLength(0)

    const day = within(form).getByLabelText('Day')
    await user.clear(day)
    await user.type(day, '2026-11-12')
    await user.type(within(form).getByLabelText('Source'), 'Google Ads')
    await user.type(within(form).getByLabelText('Campaign'), 'brand')
    await user.type(within(form).getByLabelText('Amount'), '1,250.50')
    await user.selectOptions(within(form).getByLabelText('Currency'), 'EUR')
    await user.click(within(form).getByRole('button', { name: 'Save spend' }))
    expect(await screen.findByText('Spend for Google Ads on Nov 12 saved')).toBeInTheDocument()
    expect(calls('attribution_cost_save')[0].args).toEqual({
      p_project: 'proj-1',
      p_input: {
        rows: [
          {
            day: '2026-11-12',
            source: 'google_ads',
            campaign: 'brand',
            adset: 'lagos',
            amount: 1250.5,
            currency: 'EUR',
          },
        ],
      },
    })
    // The form stays open for the next day, with the amount cleared.
    expect(within(form).getByLabelText('Amount')).toHaveValue('')
    expect(calls('attribution_costs').length).toBeGreaterThan(1)
  })

  it('changes an amount in its row, and deletes a row once confirmed', async () => {
    fake.state.handlers.attribution_cost_save = () => ({ saved: 1 })
    fake.state.handlers.attribution_cost_delete = () => ({ deleted: 1 })
    signedInAs('admin')
    window.location.hash = '#p/proj-1/attribution/costs'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const edit = await screen.findAllByRole('button', {
      name: 'Change the amount for Meta on Nov 13',
    })
    await user.click(edit[0])
    const field = screen.getByLabelText('Amount for Meta on Nov 13, in USD')
    expect(field).toHaveFocus()
    await user.clear(field)
    await user.type(field, 'lots')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Enter what was spent, such as 120.50.')).toBeInTheDocument()
    await user.clear(field)
    await user.type(field, '120{Enter}')
    expect(await screen.findByText('Spend for Meta on Nov 13 saved')).toBeInTheDocument()
    expect(calls('attribution_cost_save')[0].args.p_input).toEqual({
      rows: [
        {
          id: spendId('2026-11-13', 'meta', 'spring'),
          day: '2026-11-13',
          source: 'meta',
          campaign: 'spring',
          amount: 120,
          currency: 'USD',
        },
      ],
    })

    await user.click(screen.getByRole('button', { name: 'Delete the spend for TikTok on Nov 12' }))
    await user.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(calls('attribution_cost_delete')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Delete the spend for TikTok on Nov 12' }))
    expect(screen.getByText('Delete this spend?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Spend for TikTok on Nov 12 deleted')).toBeInTheDocument()
    expect(calls('attribution_cost_delete')[0].args).toEqual({
      p_project: 'proj-1',
      p_ids: [spendId('2026-11-12', 'tiktok')],
    })
  })

  it('uploads a spreadsheet: lines to fix first, then what the database refused, then the rows', async () => {
    const answers = [costsBackend.cost_import_errors, costsBackend.cost_import_ok]
    fake.state.handlers.attribution_cost_import = () => copy(answers.shift())
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/costs'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await user.click(await screen.findByRole('button', { name: 'Upload CSV' }))
    const panel = screen.getByRole('region', { name: 'Upload spend' })

    await user.click(within(panel).getByRole('button', { name: 'Download the template' }))
    expect(vi.mocked(downloadCsv)).toHaveBeenCalledWith('spend-template.csv', [
      ['day', 'source', 'campaign', 'adset', 'ad', 'amount', 'currency'],
    ])

    const file = (name: string, text: string) => new File([text], name, { type: 'text/csv' })
    const picker = panel.querySelector('input[type=file]') as HTMLInputElement
    await user.upload(
      picker,
      file('meta-nov.csv', 'Date,Source,Spend\n2026-11-10,meta,"1,250.00"\n2026-11-11,meta,abc\n'),
    )
    expect(await within(panel).findByText('2 rows, 1 line to fix')).toBeInTheDocument()
    expect(
      within(panel).getByRole('table', { name: 'The first rows of the file' }),
    ).toHaveTextContent('$1,250.00')
    expect(within(panel).getByText('Line 3')).toBeInTheDocument()
    expect(within(panel).getByText('The amount “abc” is not a number.')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Upload' })).toBeDisabled()

    await user.upload(
      picker,
      file(
        'meta-nov.csv',
        'day,source,amount\n2026-11-10,meta,10\n2026-11-11,meta,11\n2026-11-12,meta,12\n',
      ),
    )
    await user.click(await within(panel).findByRole('button', { name: 'Upload 3 rows' }))
    // The database counts rows from the first one sent; the file counts its heading too.
    expect(await within(panel).findByText('Line 3')).toBeInTheDocument()
    expect(within(panel).getByText('Day 2026-13-01 is not a date')).toBeInTheDocument()
    expect(within(panel).getByText(/Nothing was uploaded/)).toBeInTheDocument()
    expect(calls('attribution_cost_import')[0].args).toEqual({
      p_project: 'proj-1',
      p_input: {
        file_name: 'meta-nov.csv',
        rows: [
          { day: '2026-11-10', source: 'meta', amount: 10 },
          { day: '2026-11-11', source: 'meta', amount: 11 },
          { day: '2026-11-12', source: 'meta', amount: 12 },
        ],
      },
    })

    await user.upload(picker, file('meta-nov.csv', 'day,source,amount\n2026-11-10,meta,10\n'))
    await user.click(await within(panel).findByRole('button', { name: 'Upload 1 row' }))
    expect(
      await screen.findByText('4 rows uploaded, 1 replacing spend already there'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Upload spend' })).toBeNull()
  })

  it('says what is wrong with a file that is not spend', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/costs'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await user.click(await screen.findByRole('button', { name: 'Upload CSV' }))
    const panel = screen.getByRole('region', { name: 'Upload spend' })
    await user.upload(
      panel.querySelector('input[type=file]') as HTMLInputElement,
      new File(['name,email\nAda,ada@example.test\n'], 'people.csv', { type: 'text/csv' }),
    )
    expect(
      await within(panel).findByText(
        'people.csv: The first line names the columns, and needs day, source, amount. Download the template to see them.',
      ),
    ).toBeInTheDocument()
  })

  it('undoes an upload once confirmed', async () => {
    fake.state.handlers.attribution_cost_import_undo = () => ({ deleted: 1 })
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/costs'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const uploads = await screen.findByRole('region', { name: 'Recent uploads' })
    await user.click(within(uploads).getByRole('button', { name: 'Undo' }))
    expect(within(uploads).getByText('Delete its 1 row?')).toBeInTheDocument()
    await user.click(within(uploads).getByRole('button', { name: 'Undo upload' }))
    expect(await screen.findByText('meta-oct.csv undone: 1 row deleted')).toBeInTheDocument()
    expect(calls('attribution_cost_import_undo')[0].args).toEqual({
      p_project: 'proj-1',
      p_import: uploadId('meta-oct.csv'),
    })
  })

  it('gives a link a price per install, and removes a price once confirmed', async () => {
    fake.state.handlers.attribution_cost_rule_save = () => copy(costsBackend.cost_rule)
    fake.state.handlers.attribution_cost_rule_delete = () => ({ deleted: 1 })
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/costs'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const prices = await screen.findByRole('region', { name: 'Link prices' })
    await user.click(within(prices).getByRole('button', { name: 'Add a link price' }))
    const form = await within(prices).findByRole('form', { name: 'A price for a link' })
    const link = await within(form).findByLabelText('Link')
    expect(calls('attribution_links').at(-1)?.args).toEqual({ p_project: 'proj-1', p_range: '7d' })
    const first = within(link).getAllByRole('option')[0] as HTMLOptionElement
    expect(link).toHaveValue(first.value)
    await user.click(within(form).getByRole('button', { name: 'Save price' }))
    expect(within(form).getByText('Enter the price, such as 2.00.')).toBeInTheDocument()
    await user.type(within(form).getByLabelText('Price'), '2')
    await user.click(within(form).getByRole('button', { name: 'Save price' }))
    expect(await screen.findByText("Ada's reels costs $2.00 per install")).toBeInTheDocument()
    expect(calls('attribution_cost_rule_save')[0].args).toEqual({
      p_project: 'proj-1',
      p_input: {
        link_id: first.value,
        kind: 'install',
        amount: 2,
        currency: 'USD',
        starts_on: '2026-11-13',
        ends_on: null,
      },
    })

    await user.click(
      within(prices).getByRole('button', { name: 'Remove the price for Newsletter' }),
    )
    await user.click(within(prices).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('The price for Newsletter is removed')).toBeInTheDocument()
    expect(calls('attribution_cost_rule_delete')[0].args).toEqual({
      p_project: 'proj-1',
      p_rule: ruleId('Newsletter'),
    })
  })

  it('offers a first spend when there is none', async () => {
    fake.state.handlers.attribution_costs = () => copy(costsBackend.costs_empty)
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/costs'
    const user = userEvent.setup()
    render(<MerchantApp />)
    expect(await screen.findByText(/No spend added in the last 30 days/)).toBeInTheDocument()
    expect(screen.getByText(/No link prices/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add your first spend' }))
    expect(screen.getByRole('form', { name: 'Add spend' })).toBeInTheDocument()
  })
})

describe('Settings > Revenue', () => {
  it('shows how payments arrive, and what was not counted, in plain words', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/settings'
    render(<MerchantApp />)
    const card = (await screen.findByRole('heading', { name: 'Revenue', level: 2 })).closest(
      'section',
    )!
    await within(card).findByText('$34.38')
    expect(within(card).getByText(/^Last payment/)).toBeInTheDocument()
    expect(
      within(card).getByText('3 payments from your apps and website, 1 payment from RevenueCat.'),
    ).toBeInTheDocument()
    expect(within(card).getByText(/RevenueCat is connected/)).toBeInTheDocument()
    expect(within(card).getByText(/the latest from Nov 6, 2026/)).toBeInTheDocument()
    expect(
      within(card).getByText(
        "1 payment isn't included: the European Central Bank publishes no daily rate for its currency.",
      ),
    ).toBeInTheDocument()
    const skipped = within(card).getByRole('group', { name: 'Payments not counted' })
    expect(
      within(skipped)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      '2 payments had an amount that was zero or not a number',
      '1 payment came without a currency',
    ])
    // The currency control above stays where it was.
    expect(screen.getByRole('heading', { name: 'Revenue currency' })).toBeInTheDocument()
  })

  it('edits the payment events and saves the list', async () => {
    fake.state.handlers.attribution_revenue_events_save = () => copy(revenueBackend.revenue_setup)
    signedInAs('developer')
    window.location.hash = '#p/proj-1/attribution/settings'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const first = await screen.findByRole('group', { name: 'order_paid' })
    expect(within(first).getByLabelText('Amount property')).toHaveValue('value')
    expect(within(first).getByLabelText('Currency')).toHaveValue('property')
    expect(within(first).getByLabelText('Currency property')).toHaveValue('currency')
    const second = screen.getByRole('group', { name: 'coins_bought' })
    expect(within(second).getByLabelText('Currency')).toHaveValue('USD')
    expect(within(second).getByRole('checkbox', { name: /Amount is in cents/ })).toBeChecked()

    const save = screen.getByRole('button', { name: 'Save payment events' })
    expect(save).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Add a payment event' }))
    const added = screen.getByRole('group', { name: 'payment event 3' })
    await user.click(save)
    expect(within(added).getByText(/starting with a letter/)).toBeInTheDocument()
    expect(within(added).getByText(/holds the amount/)).toBeInTheDocument()
    expect(calls('attribution_revenue_events_save')).toHaveLength(0)

    await user.type(within(added).getByLabelText('Event'), 'plan_bought')
    const now = screen.getByRole('group', { name: 'plan_bought' })
    await user.type(within(now).getByLabelText('Amount property'), 'price')
    await user.selectOptions(within(now).getByLabelText('Currency'), 'NGN')
    await user.click(within(now).getByRole('checkbox', { name: /Amount is in cents/ }))
    await user.click(within(second).getByRole('button', { name: 'Remove coins_bought' }))
    await user.click(save)
    expect(await screen.findByText('2 payment events saved')).toBeInTheDocument()
    expect(calls('attribution_revenue_events_save')[0].args).toEqual({
      p_project: 'proj-1',
      p_events: [
        {
          event: 'order_paid',
          amount_property: 'value',
          unit: 'major',
          currency_property: 'currency',
        },
        { event: 'plan_bought', amount_property: 'price', unit: 'minor', currency: 'NGN' },
      ],
    })
  })

  it('passes on what the database refuses', async () => {
    fake.state.handlers.attribution_revenue_events_save = () => {
      throw failure('order_paid is listed twice; list each event once')
    }
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/settings'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const first = await screen.findByRole('group', { name: 'order_paid' })
    await user.click(within(first).getByRole('checkbox', { name: /Amount is in cents/ }))
    await user.click(screen.getByRole('button', { name: 'Save payment events' }))
    expect(
      await screen.findAllByText('order_paid is listed twice; list each event once'),
    ).not.toHaveLength(0)
  })

  it('lets analysts read the revenue setup without changing it', async () => {
    signedInAs('analyst')
    window.location.hash = '#p/proj-1/attribution/settings'
    render(<MerchantApp />)
    const first = await screen.findByRole('group', { name: 'order_paid' })
    expect(within(first).getByLabelText('Event')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save payment events' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add a payment event' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull()
    expect(
      screen.getByText('Developers, admins and the owner can change payment events.'),
    ).toBeInTheDocument()
  })

  it('points to Connections with no store tool, and warns of a currency without daily rates', async () => {
    fake.state.handlers.attribution_revenue_setup = () => ({
      ...copy<object>(revenueBackend.revenue_setup_empty),
      currency: 'NGN',
    })
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/settings'
    render(<MerchantApp />)
    expect(await screen.findByText(/No store tool connected/)).toBeInTheDocument()
    const card = screen.getByRole('heading', { name: 'Revenue', level: 2 }).closest('section')!
    expect(within(card).getByRole('link', { name: 'Connections' })).toHaveAttribute(
      'href',
      '#connections',
    )
    expect(
      screen.getByText(/The European Central Bank has no daily rate for NGN/),
    ).toBeInTheDocument()
    expect(screen.getByText('No payments from SpeakSix yet.')).toBeInTheDocument()
    expect(screen.getByText(/None listed/)).toBeInTheDocument()
  })
})

describe('Setup > Track revenue', () => {
  it('shows the revenue call for each platform, waiting for the first payment', async () => {
    fake.state.handlers.attribution_revenue_setup = () => ({
      ...copy<object>(revenueBackend.revenue_setup_empty),
      last_development_at: '2026-11-13T14:10:00Z',
    })
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const step = (await screen.findByRole('heading', { name: 'Track revenue', level: 2 })).closest(
      'section',
    )!
    expect(within(step).getByText('To do')).toBeInTheDocument()
    expect(screen.getByText('3 of 5 steps done')).toBeInTheDocument()
    expect(within(step).getByRole('button', { name: 'iOS' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(step).getByLabelText('Swift')).toHaveTextContent('KissMyApps.revenue(')
    await user.click(within(step).getByRole('button', { name: 'Website' }))
    expect(within(step).getByLabelText('JavaScript')).toHaveTextContent(
      "kma('revenue', 59.99, 'USD'",
    )
    await user.click(within(step).getByRole('button', { name: 'Server' }))
    expect(within(step).getByLabelText('Terminal')).toHaveTextContent('"kma_revenue": 59.99')
    expect(
      within(step).getByText(/A payment sent with a development key arrived 10 min ago/),
    ).toBeInTheDocument()
    expect(within(step).getByRole('link', { name: 'name it in Settings' })).toHaveAttribute(
      'href',
      '#p/proj-1/attribution/settings',
    )
    // Revenue is ready now, so it is no longer listed as coming later.
    expect(screen.queryByText('Revenue and ad spend')).toBeNull()
  })

  it('is done once the first live payment arrives', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution'
    render(<MerchantApp />)
    const step = (await screen.findByRole('heading', { name: 'Track revenue', level: 2 })).closest(
      'section',
    )!
    expect(await within(step).findByText('Done')).toBeInTheDocument()
    expect(screen.getByText('4 of 5 steps done')).toBeInTheDocument()
    expect(within(step).getByText(/4 payments in the last 7 days/)).toBeInTheDocument()
    expect(within(step).getByRole('link', { name: 'See ROI' })).toHaveAttribute(
      'href',
      '#p/proj-1/attribution/roi',
    )
  })
})
