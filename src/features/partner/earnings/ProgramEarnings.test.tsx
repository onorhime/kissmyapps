import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import {
  PARTNER_RPCS,
  createPartnerDataGateway,
  emptyPartnerDashboardSummary,
  emptyPartnerPayoutSummary,
} from '../api'
import type {
  PartnerDataErrorCode,
  PartnerDataGateway,
  PartnerDataResult,
  PartnerSupabaseClient,
} from '../api'
import { LivePartnerPortal } from '../live/LivePartnerPortal'
import { PartnerLiveWorkspaceProvider } from '../live/PartnerLiveWorkspace'
import { PartnerMarketplace } from '../marketplace/PartnerMarketplace'
import { readPartnerMarketplace } from '../marketplace/programs'
import {
  EarningsUnreadable,
  commissionAmount,
  commissionStatusLine,
  earningsErrorMessage,
  earningsLine,
  earningsOfProgram,
  hasEarnings,
  nothingToShow,
  readProgramEarnings,
  salesCount,
  shortDay,
} from './earnings'
import type { ProgramEarnings, ProgramEarningsResult } from './earnings'
import { ProgramEarningsPanel } from './ProgramEarningsPanel'

/** The moment the tests pretend it is. Midday, so the day is the same in any time zone. */
const NOW = new Date('2026-11-13T12:00:00Z')
/** A timestamp exactly as the database sends it. */
const WHEN = '2026-11-13T13:52:14.059098+00:00'

// The answer as the contract writes it --------------------------------------------------------

const speaksixRow = {
  program_id: 'prog-1',
  slug: 'speaksix',
  name: 'SpeakSix',
  currency: 'USD',
  pending_minor: 4410,
  approved_minor: 1470,
  paid_minor: 0,
  sales: 4,
  next_release_at: '2026-12-14T12:00:00.000000+00:00',
}

const fieldnoteRow = {
  program_id: 'prog-2',
  slug: 'fieldnote',
  name: 'Fieldnote',
  currency: 'EUR',
  pending_minor: 1500,
  approved_minor: 0,
  paid_minor: 0,
  sales: 1,
  next_release_at: '2026-11-25T12:00:00.000000+00:00',
}

function commissionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'com-1',
    program_id: 'prog-1',
    program_name: 'SpeakSix',
    status: 'held',
    amount_minor: 1470,
    earned_minor: 1470,
    currency: 'USD',
    sale_amount_minor: 4900,
    paid_at: WHEN,
    hold_until: '2026-12-14T12:00:00.000000+00:00',
    approved_at: null,
    ...overrides,
  }
}

const answer = {
  programs: [speaksixRow, fieldnoteRow],
  recent: [
    commissionRow(),
    commissionRow({
      id: 'com-2',
      status: 'approved',
      paid_at: '2026-10-06T12:00:00+00:00',
      hold_until: '2026-11-05T12:00:00+00:00',
      approved_at: '2026-11-05T12:10:00+00:00',
    }),
    commissionRow({
      id: 'com-3',
      status: 'reversed',
      amount_minor: 0,
      paid_at: '2026-10-19T12:00:00+00:00',
    }),
    commissionRow({
      id: 'com-4',
      program_id: 'prog-2',
      program_name: 'Fieldnote',
      currency: 'EUR',
      amount_minor: 1500,
      earned_minor: 1500,
      sale_amount_minor: 9900,
      hold_until: '2026-11-25T12:00:00+00:00',
    }),
  ],
}

const earnings = (value: unknown = answer): ProgramEarnings => readProgramEarnings(value)

function ok(data: ProgramEarnings): ProgramEarningsResult {
  return { data, status: 'ready', error: null }
}

function failed(code: PartnerDataErrorCode): ProgramEarningsResult {
  return { data: null, status: 'error', error: { code, message: 'x', retryable: true } }
}

function gatewayAnswering(...answers: (ProgramEarningsResult | Promise<ProgramEarningsResult>)[]): {
  gateway: PartnerDataGateway
  getProgramEarnings: ReturnType<typeof vi.fn>
} {
  let call = 0
  const getProgramEarnings = vi.fn(() =>
    Promise.resolve(answers[Math.min(call++, answers.length - 1)]),
  )
  return { gateway: { getProgramEarnings } as unknown as PartnerDataGateway, getProgramEarnings }
}

const panel = () => screen.getByRole('region', { name: 'Program earnings' })

// Reading -----------------------------------------------------------------------------------

describe('reading what partner_program_earnings answers', () => {
  it('reads the programs and the recent commissions with database timestamps', () => {
    const read = earnings()
    expect(read.programs[0]).toEqual(speaksixRow)
    expect(read.recent[0]).toEqual(commissionRow())
    expect(read.recent.map((commission) => commission.status)).toEqual([
      'held',
      'approved',
      'reversed',
      'held',
    ])
    expect(read.recent[1].approved_at).toBe('2026-11-05T12:10:00+00:00')
  })

  it('reads an empty answer and fills what an older answer leaves out', () => {
    expect(earnings({ programs: [], recent: [] })).toEqual({ programs: [], recent: [] })
    const read = earnings({
      programs: [
        { program_id: 'p', name: 'SpeakSix', currency: 'USD', pending_minor: 5, approved_minor: 0 },
      ],
      recent: [{ id: 'c', status: 'held', amount_minor: 5, currency: 'USD' }],
    })
    expect(read.programs[0]).toMatchObject({
      slug: null,
      paid_minor: 0,
      sales: 0,
      next_release_at: null,
    })
    expect(read.recent[0]).toMatchObject({
      program_id: null,
      program_name: 'Program',
      earned_minor: 5,
      sale_amount_minor: null,
      paid_at: null,
      hold_until: null,
      approved_at: null,
    })
  })

  it('reads a sum that arrives as a string of digits', () => {
    const read = earnings({
      programs: [{ ...speaksixRow, pending_minor: '4410', approved_minor: '1470' }],
      recent: [],
    })
    expect(read.programs[0].pending_minor).toBe(4410)
    expect(read.programs[0].approved_minor).toBe(1470)
  })

  it('leaves out a commission whose status it has no words for', () => {
    const read = earnings({
      programs: [],
      recent: [commissionRow({ status: 'not_earned' }), commissionRow({ id: 'com-9' })],
    })
    expect(read.recent.map((commission) => commission.id)).toEqual(['com-9'])
  })

  it('drops a time that is not one', () => {
    const read = earnings({
      programs: [{ ...speaksixRow, next_release_at: 'soon' }],
      recent: [commissionRow({ hold_until: 7, paid_at: '' })],
    })
    expect(read.programs[0].next_release_at).toBeNull()
    expect(read.recent[0].hold_until).toBeNull()
    expect(read.recent[0].paid_at).toBeNull()
  })

  it('refuses a body that is not the answer and a row of money that is not whole', () => {
    for (const body of [
      null,
      [],
      'x',
      { programs: [] },
      { recent: [] },
      { programs: {}, recent: [] },
    ])
      expect(() => readProgramEarnings(body)).toThrow(EarningsUnreadable)
    for (const row of [
      { ...speaksixRow, pending_minor: null },
      { ...speaksixRow, approved_minor: 14.7 },
      { ...speaksixRow, currency: 'usd' },
      { ...speaksixRow, program_id: null },
      { ...speaksixRow, name: '' },
      'row',
    ])
      expect(() => readProgramEarnings({ programs: [row], recent: [] })).toThrow(EarningsUnreadable)
    for (const row of [
      commissionRow({ amount_minor: undefined }),
      commissionRow({ currency: null }),
      commissionRow({ id: null }),
    ])
      expect(() => readProgramEarnings({ programs: [], recent: [row] })).toThrow(EarningsUnreadable)
  })
})

describe('the words for earnings', () => {
  it('writes the line for a program card', () => {
    const read = earnings()
    expect(earningsLine(read.programs[0])).toBe('Pending $44.10 · Approved $14.70')
    expect(earningsLine(read.programs[1])).toBe('Pending 15.00 EUR · Approved 0.00 EUR')
    expect(earningsLine({ ...read.programs[0], pending_minor: 0, approved_minor: 0 })).toBeNull()
    expect(earningsLine(null)).toBeNull()
  })

  it('finds a program by its id, then by its slug', () => {
    const read = earnings()
    expect(earningsOfProgram(read, { id: 'prog-2', slug: 'other' })?.name).toBe('Fieldnote')
    expect(earningsOfProgram(read, { id: null, slug: 'speaksix' })?.name).toBe('SpeakSix')
    expect(earningsOfProgram(read, { id: 'prog-9', slug: 'lumen' })).toBeNull()
    expect(earningsOfProgram(null, { id: 'prog-1', slug: 'speaksix' })).toBeNull()
  })

  it('says where a commission stands', () => {
    const [held, approved, reversed] = earnings().recent
    expect(commissionStatusLine(held, NOW)).toBe('Pending until 14 Dec')
    expect(commissionStatusLine(approved, NOW)).toBe('Approved')
    expect(commissionStatusLine(reversed, NOW)).toBe('Returned to the brand after a refund')
    // Past its hold and not approved yet, or with no hold date: no date is promised.
    expect(
      commissionStatusLine({ status: 'held', hold_until: '2026-11-01T12:00:00+00:00' }, NOW),
    ).toBe('Pending')
    expect(commissionStatusLine({ status: 'held', hold_until: null }, NOW)).toBe('Pending')
    expect(
      commissionStatusLine({ status: 'held', hold_until: '2027-01-03T12:00:00+00:00' }, NOW),
    ).toBe('Pending until 3 Jan 2027')
  })

  it('writes days with the year only when it is another year', () => {
    expect(shortDay('2026-12-14T12:00:00+00:00', NOW)).toBe('14 Dec')
    expect(shortDay('2027-01-03T12:00:00+00:00', NOW)).toBe('3 Jan 2027')
    expect(shortDay(WHEN, NOW)).toBe('13 Nov')
  })

  it('shows what a commission is worth now, and what it was before a refund', () => {
    const [held, , reversed] = earnings().recent
    expect(commissionAmount(held)).toEqual({ amount: '$14.70', was: null })
    expect(commissionAmount({ ...held, amount_minor: 735 })).toEqual({
      amount: '$7.35',
      was: '$14.70',
    })
    // A returned commission shows what went back, not $0.00.
    expect(commissionAmount(reversed)).toEqual({ amount: '$14.70', was: null })
  })

  it('counts sales and knows when there is nothing', () => {
    expect(salesCount(1)).toBe('1 sale')
    expect(salesCount(1204)).toBe('1,204 sales')
    expect(hasEarnings(earnings())).toBe(true)
    expect(hasEarnings(earnings({ programs: [], recent: [] }))).toBe(false)
    expect(hasEarnings(null)).toBe(false)
  })

  it('shows nothing, rather than an error, where program money does not exist', () => {
    expect(nothingToShow(failed('contract_unavailable'))).toBe(true)
    expect(nothingToShow(failed('not_configured'))).toBe(true)
    expect(nothingToShow(failed('not_authorized'))).toBe(true)
    expect(nothingToShow({ data: null, status: 'unconfigured', error: null })).toBe(true)
    expect(nothingToShow(failed('temporarily_unavailable'))).toBe(false)
    expect(nothingToShow(failed('invalid_response'))).toBe(false)
    expect(nothingToShow(failed('unknown'))).toBe(false)
  })

  it('never passes on the database’s own words for a failure', () => {
    for (const code of [
      'not_authenticated',
      'invalid_response',
      'temporarily_unavailable',
      'unknown',
    ] as const) {
      const message = earningsErrorMessage({
        code,
        message: 'permission denied for function partner_program_earnings',
        retryable: true,
      })
      expect(message).not.toMatch(/_|permission denied|function/i)
    }
    expect(earningsErrorMessage(null)).toBe('That did not go through. Try again.')
  })
})

// The gateway -------------------------------------------------------------------------------

type RpcAnswer = {
  data: unknown
  error: { code?: string; message?: string; details?: string; status?: number } | null
  status?: number
}

function clientAnswering(rpcAnswer: RpcAnswer | (() => Promise<RpcAnswer>)) {
  const rpc = vi.fn((functionName: string, args?: Record<string, unknown>) => {
    void functionName
    void args
    return typeof rpcAnswer === 'function' ? rpcAnswer() : Promise.resolve(rpcAnswer)
  })
  const client: PartnerSupabaseClient = {
    from: () => {
      throw new Error('Earnings read no views.')
    },
    rpc,
  }
  return { rpc, gateway: createPartnerDataGateway(client) }
}

describe('the earnings function through the partner gateway', () => {
  it('names the function exactly as the backend does and sends no arguments', async () => {
    expect(PARTNER_RPCS.programEarnings).toBe('partner_program_earnings')
    const { gateway, rpc } = clientAnswering({ data: answer, error: null, status: 200 })
    const result = await gateway.getProgramEarnings!()

    expect(rpc).toHaveBeenCalledExactlyOnceWith('partner_program_earnings')
    expect(result.status).toBe('ready')
    expect(result.error).toBeNull()
    expect(result.data?.programs.map((row) => row.name)).toEqual(['SpeakSix', 'Fieldnote'])
    expect(result.data?.recent).toHaveLength(4)
  })

  it('marks an answer with no earnings as empty', async () => {
    const { gateway } = clientAnswering({ data: { programs: [], recent: [] }, error: null })
    const result = await gateway.getProgramEarnings!()
    expect(result.status).toBe('empty')
    expect(result.data).toEqual({ programs: [], recent: [] })
  })

  it.each([
    [{ code: 'PGRST202', status: 404 }, 'contract_unavailable'],
    [{ code: '42883', status: 404 }, 'contract_unavailable'],
    [{ code: '42501', status: 403 }, 'not_authorized'],
    [{ code: 'PGRST301', status: 401 }, 'not_authenticated'],
    [{ code: '57014', status: 503 }, 'temporarily_unavailable'],
    [{ code: 'XX000', status: 400 }, 'unknown'],
  ] as const)('turns the failure %o into %s', async (error, code) => {
    const { gateway } = clientAnswering({ data: null, error, status: error.status })
    const result = await gateway.getProgramEarnings!()
    expect(result.data).toBeNull()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe(code)
  })

  it('reports an answer it cannot read and a request that never arrived', async () => {
    const unreadable = await clientAnswering({
      data: { programs: 'none' },
      error: null,
    }).gateway.getProgramEarnings!()
    expect(unreadable.error?.code).toBe('invalid_response')

    const offline = await clientAnswering(() => Promise.reject(new TypeError('Failed to fetch')))
      .gateway.getProgramEarnings!()
    expect(offline.error?.code).toBe('temporarily_unavailable')

    const unconfigured = await createPartnerDataGateway(null).getProgramEarnings!()
    expect(unconfigured.status).toBe('unconfigured')
    expect(unconfigured.data).toBeNull()
  })
})

// The panel ---------------------------------------------------------------------------------

describe('the Program earnings panel', () => {
  it('shows pending and approved per program with the date the first hold ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    try {
      const { gateway } = gatewayAnswering(ok(earnings()))
      render(<ProgramEarningsPanel gateway={gateway} />)

      const programs = within(await screen.findByRole('list', { name: 'Earnings by program' }))
      const [speaksix, fieldnote] = programs.getAllByRole('listitem')
      expect(within(speaksix).getByRole('link', { name: 'SpeakSix' })).toHaveAttribute(
        'href',
        '#marketplace/speaksix',
      )
      expect(speaksix).toHaveTextContent('4 sales')
      expect(speaksix).toHaveTextContent('Pending$44.10First hold ends 14 Dec')
      expect(speaksix).toHaveTextContent('Approved$14.70')
      expect(fieldnote).toHaveTextContent('1 sale')
      expect(fieldnote).toHaveTextContent('Pending15.00 EURFirst hold ends 25 Nov')
      expect(fieldnote).toHaveTextContent('Approved0.00 EUR')
      // Nothing has been paid out, so no "Paid out" figure is shown.
      expect(panel()).not.toHaveTextContent('Paid out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists recent commissions with the sale, the commission and the status in words', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    try {
      const { gateway } = gatewayAnswering(ok(earnings()))
      render(<ProgramEarningsPanel gateway={gateway} />)

      const table = within(await screen.findByRole('table', { name: 'Recent commissions' }))
      expect(table.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
        'Sale date',
        'Program',
        'Sale',
        'Your commission',
        'Status',
      ])
      const rows = table.getAllByRole('row').slice(1)
      expect(rows.map((row) => row.textContent)).toEqual([
        '13 NovSpeakSix$49.00$14.70Pending until 14 Dec',
        '6 OctSpeakSix$49.00$14.70Approved',
        '19 OctSpeakSix$49.00$14.70Returned to the brand after a refund',
        '13 NovFieldnote99.00 EUR15.00 EURPending until 25 Nov',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a commission a partial refund reduced with what it was before', async () => {
    const { gateway } = gatewayAnswering(
      ok(earnings({ programs: [], recent: [commissionRow({ amount_minor: 735 })] })),
    )
    render(<ProgramEarningsPanel gateway={gateway} />)
    const table = await screen.findByRole('table', { name: 'Recent commissions' })
    expect(table).toHaveTextContent('$7.35$14.70 before a refund')
    // Only reversed commissions: the list still shows, with no per-program figures.
    expect(screen.queryByRole('list', { name: 'Earnings by program' })).not.toBeInTheDocument()
  })

  it('says payouts are coming and offers no way to be paid', async () => {
    const { gateway } = gatewayAnswering(ok(earnings()))
    render(<ProgramEarningsPanel gateway={gateway} />)
    await screen.findByRole('table', { name: 'Recent commissions' })

    expect(panel()).toHaveTextContent(
      'Payouts of approved earnings are coming. Approved money has already been collected from the brand.',
    )
    expect(within(panel()).queryByRole('button')).not.toBeInTheDocument()
    expect(panel().textContent).not.toMatch(/test mode|sandbox|withdraw|pay ?out now|paid on/i)
  })

  it('shows eight commissions and the rest on request', async () => {
    const user = userEvent.setup()
    const recent = Array.from({ length: 11 }, (_, index) => commissionRow({ id: `com-${index}` }))
    const { gateway } = gatewayAnswering(ok(earnings({ programs: [speaksixRow], recent })))
    render(<ProgramEarningsPanel gateway={gateway} />)

    const table = await screen.findByRole('table', { name: 'Recent commissions' })
    expect(within(table).getAllByRole('row')).toHaveLength(9)
    await user.click(screen.getByRole('button', { name: 'Show all 11' }))
    expect(within(table).getAllByRole('row')).toHaveLength(12)
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument()
  })

  it('shows a paid-out figure only once something was paid', async () => {
    const { gateway } = gatewayAnswering(
      ok(earnings({ programs: [{ ...speaksixRow, paid_minor: 2000 }], recent: [] })),
    )
    render(<ProgramEarningsPanel gateway={gateway} />)
    expect(await screen.findByText('Paid out')).toBeInTheDocument()
    expect(panel()).toHaveTextContent('Paid out$20.00')
  })

  it('leaves out the hold date when it has passed or nothing is pending', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    try {
      const { gateway } = gatewayAnswering(
        ok(
          earnings({
            programs: [
              { ...speaksixRow, next_release_at: '2026-11-01T12:00:00+00:00' },
              { ...fieldnoteRow, pending_minor: 0, approved_minor: 1500 },
            ],
            recent: [],
          }),
        ),
      )
      render(<ProgramEarningsPanel gateway={gateway} />)
      await screen.findByRole('list', { name: 'Earnings by program' })
      expect(panel()).not.toHaveTextContent('First hold ends')
    } finally {
      vi.useRealTimers()
    }
  })

  it('announces loading while the answer is on its way', async () => {
    let arrive: (result: ProgramEarningsResult) => void = () => {}
    const { gateway } = gatewayAnswering(
      new Promise<ProgramEarningsResult>((resolve) => {
        arrive = resolve
      }),
    )
    render(<ProgramEarningsPanel gateway={gateway} />)

    expect(panel()).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Loading your program earnings')
    arrive(ok(earnings()))
    await screen.findByRole('table', { name: 'Recent commissions' })
    expect(panel()).toHaveAttribute('aria-busy', 'false')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says nothing is earned yet and points to the marketplace', async () => {
    // Programs the creator joined but has not sold through count as nothing earned.
    const { gateway } = gatewayAnswering(
      ok(
        earnings({
          programs: [{ ...speaksixRow, pending_minor: 0, approved_minor: 0, sales: 0 }],
          recent: [],
        }),
      ),
    )
    render(<ProgramEarningsPanel gateway={gateway} />)

    expect(await screen.findByRole('heading', { name: 'Nothing earned yet' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the marketplace' })).toHaveAttribute(
      'href',
      '#marketplace',
    )
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(panel()).not.toHaveTextContent('Payouts of approved earnings')
  })

  it('offers another try when the earnings did not load, and loads them then', async () => {
    const user = userEvent.setup()
    const { gateway, getProgramEarnings } = gatewayAnswering(
      failed('temporarily_unavailable'),
      ok(earnings()),
    )
    render(<ProgramEarningsPanel gateway={gateway} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Program earnings did not load')
    expect(alert).toHaveTextContent('Check your connection and try again.')
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('table', { name: 'Recent commissions' })).toBeInTheDocument()
    expect(getProgramEarnings).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('treats a request that throws and an unreadable answer as a failure to retry', async () => {
    const thrown = {
      getProgramEarnings: vi.fn(() => Promise.reject(new Error('offline'))),
    } as unknown as PartnerDataGateway
    const first = render(<ProgramEarningsPanel gateway={thrown} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Program earnings did not load')
    first.unmount()

    render(<ProgramEarningsPanel gateway={gatewayAnswering(failed('invalid_response')).gateway} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('The answer could not be read.')
  })

  it('asks for a new sign-in, with no retry, when the session has expired', async () => {
    render(<ProgramEarningsPanel gateway={gatewayAnswering(failed('not_authenticated')).gateway} />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Your session has expired.')
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument()
  })

  it.each([
    ['the function does not exist yet', failed('contract_unavailable')],
    ['the connection is not set up', failed('not_configured')],
    ['the account is not an active creator', failed('not_authorized')],
  ])('shows nothing at all when %s', async (_, result) => {
    const { gateway, getProgramEarnings } = gatewayAnswering(result)
    const view = render(<ProgramEarningsPanel gateway={gateway} />)
    await waitFor(() => expect(getProgramEarnings).toHaveBeenCalled())
    await waitFor(() => expect(view.container).toBeEmptyDOMElement())
  })

  it('shows nothing when the gateway has no earnings at all', async () => {
    const view = render(<ProgramEarningsPanel gateway={{} as PartnerDataGateway} />)
    await waitFor(() => expect(view.container).toBeEmptyDOMElement())
  })

  it('has no accessibility violations with earnings on screen', async () => {
    const { gateway } = gatewayAnswering(ok(earnings()))
    const view = render(<ProgramEarningsPanel gateway={gateway} />)
    await screen.findByRole('table', { name: 'Recent commissions' })
    const results = await axe.run(view.container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(results.violations).toEqual([])
  })
})

// Where the panel and the card line sit ------------------------------------------------------

function result<T>(data: T, status: PartnerDataResult<T>['status']): PartnerDataResult<T> {
  return { data, status, error: null }
}

/** A creator who joined programs in the marketplace and has no product of the older kind. */
function portalGateway(getProgramEarnings?: PartnerDataGateway['getProgramEarnings']) {
  const gateway: PartnerDataGateway = {
    getCurrentPartnerProfile: async () =>
      result(
        {
          email: 'ana@example.test',
          fullName: 'Ana Creator',
          publicName: 'Ana Creator',
          legalName: 'Ana Creator',
          entityType: 'Individual',
          countryCode: 'PT',
          timezone: 'Europe/Lisbon',
          preferredCurrency: 'USD',
          website: null,
          category: null,
          audienceDescription: null,
          audienceCountries: [],
          channels: [],
          channelDetails: null,
          role: 'owner',
          status: 'active',
          notifications: {
            statements: true,
            payouts: true,
            verification: true,
            signatures: true,
            adjustments: true,
            inactiveLinks: true,
          },
        },
        'ready',
      ),
    getProducts: async () => result([], 'empty'),
    getLinkDirectory: async () =>
      result({ products: [], funnels: [], sources: [], campaigns: [] }, 'empty'),
    getPartnerLinks: async () => result([], 'empty'),
    createPartnerLink: async () => result(null, 'empty'),
    updatePartnerLink: async () => result(null, 'empty'),
    setPartnerLinkStatus: async () => result(null, 'empty'),
    getPayoutSummary: async () => result(emptyPartnerPayoutSummary(), 'empty'),
    getPayoutHistory: async () => result([], 'empty'),
    getPayoutDetail: async () => result(null, 'empty'),
    getDocuments: async () => result([], 'empty'),
    getAgreements: async () => result([], 'empty'),
    getDashboardSummary: async () => result(emptyPartnerDashboardSummary(), 'empty'),
    getDashboardTrends: async () => result([], 'empty'),
    updatePartnerProfile: async () => result(null, 'empty'),
    updatePartnerSettings: async () => result(null, 'empty'),
    getProgramEarnings,
  }
  return gateway
}

function portal(gateway: PartnerDataGateway, page: 'payouts' | 'performance' | 'links') {
  return (
    <PartnerLiveWorkspaceProvider
      gateway={gateway}
      client={null}
      sessionUserId="user-1"
      reporting={{
        startsOn: '2026-10-15',
        endsOn: '2026-11-13',
        timezone: 'Europe/Lisbon',
        grain: 'day',
        breakdown: 'source',
      }}
    >
      <LivePartnerPortal page={page} />
    </PartnerLiveWorkspaceProvider>
  )
}

describe('the Payouts page of the live dashboard', () => {
  it('shows Program earnings above what the page already had', async () => {
    const getProgramEarnings = vi.fn(async () => ok(earnings()))
    render(portal(portalGateway(getProgramEarnings), 'payouts'))

    const earningsPanel = await screen.findByRole('region', { name: 'Program earnings' })
    await screen.findByRole('table', { name: 'Recent commissions' })
    const existing = screen.getByRole('heading', { name: 'No products are connected yet' })
    expect(
      earningsPanel.compareDocumentPosition(existing) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: /Payouts/ })).toBeInTheDocument()
  })

  it('leaves the page as it was when the earnings function does not exist yet', async () => {
    const getProgramEarnings = vi.fn(async () => failed('contract_unavailable'))
    render(portal(portalGateway(getProgramEarnings), 'payouts'))

    expect(
      await screen.findByRole('heading', { name: 'No products are connected yet' }),
    ).toBeInTheDocument()
    await waitFor(() => expect(getProgramEarnings).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Program earnings' })).not.toBeInTheDocument(),
    )
  })

  it('does not read earnings on the other pages', async () => {
    const getProgramEarnings = vi.fn(async () => ok(earnings()))
    render(portal(portalGateway(getProgramEarnings), 'performance'))
    await screen.findByRole('heading', { name: 'No products are connected yet' })
    expect(getProgramEarnings).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: 'Program earnings' })).not.toBeInTheDocument()
  })
})

const card = {
  slug: 'speaksix',
  name: 'SpeakSix',
  category: 'education',
  tagline: 'Speak English with confidence in six weeks.',
  logo_path: null,
  brand_name: 'SpeakSix Ltd',
  commission_type: 'percent',
  commission_rate_bps: 3000,
  commission_fixed_minor: null,
  currency: 'USD',
  commission_duration: 'months',
  commission_months: 12,
  attribution_window_days: 30,
  hold_days: 30,
  minimum_payout_minor: 2000,
  approval_mode: 'automatic',
  terms_version: 1,
}

function membershipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-1',
    program_id: 'prog-1',
    program: card,
    program_status: 'live',
    status: 'active',
    terms_version: 1,
    accepted_at: WHEN,
    needs_new_terms: false,
    link: { url: 'https://go.kissmyapps.dev/speaksix/ana', short_url: null, working: true },
    requested_at: WHEN,
    activated_at: WHEN,
    ended_at: null,
    decision_note: null,
    ...overrides,
  }
}

function marketplaceGateway(getProgramEarnings?: PartnerDataGateway['getProgramEarnings']) {
  const marketplace = readPartnerMarketplace({
    tracking_ready: true,
    programs: [card],
    memberships: [
      membershipRow(),
      membershipRow({
        id: 'mem-2',
        program_id: 'prog-2',
        program: { ...card, slug: 'fieldnote', name: 'Fieldnote', currency: 'EUR' },
      }),
      membershipRow({
        id: 'mem-3',
        program_id: 'prog-3',
        program: { ...card, slug: 'lumen', name: 'Lumen Sleep' },
      }),
    ],
  })
  return {
    getMarketplace: vi.fn(async () => ({ data: marketplace, status: 'ready', error: null })),
    getProgramEarnings,
  } as unknown as PartnerDataGateway
}

function memberCard(program: string) {
  const yours = screen.getByRole('region', { name: 'Your programs' })
  const article = within(yours).getByRole('link', { name: program }).closest('article')
  if (!article) throw new Error(`No card for ${program}`)
  return article
}

describe('earnings on the Marketplace page’s "Your programs" cards', () => {
  it('adds the pending and approved line to a program with earnings', async () => {
    const gateway = marketplaceGateway(vi.fn(async () => ok(earnings())))
    render(<PartnerMarketplace gateway={gateway} slug={null} />)
    await screen.findByRole('heading', { name: 'Your programs' })

    await waitFor(() =>
      expect(memberCard('SpeakSix')).toHaveTextContent('Pending $44.10 · Approved $14.70'),
    )
    expect(memberCard('Fieldnote')).toHaveTextContent('Pending 15.00 EUR · Approved 0.00 EUR')
    // Joined, nothing earned: the card stays as it was.
    expect(memberCard('Lumen Sleep')).not.toHaveTextContent('Pending')
  })

  it('shows the cards without the line when earnings fail, are missing or are slow', async () => {
    for (const getProgramEarnings of [
      vi.fn(async () => failed('temporarily_unavailable')),
      vi.fn(async () => failed('contract_unavailable')),
      vi.fn(() => Promise.reject(new Error('offline'))),
      vi.fn(() => new Promise<ProgramEarningsResult>(() => {})),
      undefined,
    ]) {
      const view = render(
        <PartnerMarketplace gateway={marketplaceGateway(getProgramEarnings)} slug={null} />,
      )
      await screen.findByRole('heading', { name: 'Your programs' })
      if (getProgramEarnings) await waitFor(() => expect(getProgramEarnings).toHaveBeenCalled())
      expect(memberCard('SpeakSix')).not.toHaveTextContent('Pending')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      view.unmount()
    }
  })
})
