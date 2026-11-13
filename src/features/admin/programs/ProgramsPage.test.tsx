import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminDataError, AdminDataResult, AdminGateway, AdminRole } from '../api/types'
import {
  mapAdminProgramReviews,
  type AdminProgramReviewInput,
  type AdminProgramReviews,
  type AdminProgramStatusInput,
  type AdminProgramStatusResult,
} from '../api/programs'
import { ProgramsPage } from './ProgramsPage'
import { programReviewsBackendFixture } from './reviews-backend.fixture'
import {
  bothProgramRow,
  eventsProgramRow,
  fixedProgramRow,
  programRow,
  reviewedRows,
  reviewsResponse,
  rewardRows,
  salesProgramRow,
} from './fixtures'

type Reviews = AdminDataResult<AdminProgramReviews | null>
type Outcome = AdminDataResult<AdminProgramStatusResult | null>

const ready = (
  waiting: Record<string, unknown>[] = [programRow()],
  reviewed: Record<string, unknown>[] = reviewedRows(),
): Reviews => ({
  data: mapAdminProgramReviews(reviewsResponse(waiting, reviewed), 'https://project.supabase.co'),
  status: 'ready',
  error: null,
})

const failed = (
  code: AdminDataError['code'],
  message = 'Admin data could not be loaded.',
  status: Outcome['status'] = 'error',
): AdminDataResult<null> => ({
  data: null,
  status,
  error: { code, message, retryable: code === 'temporarily_unavailable' },
})

const done = (
  programId: string,
  status: AdminProgramStatusResult['status'],
  pauseReason: AdminProgramStatusResult['pauseReason'] = status === 'paused' ? 'admin' : null,
): Outcome => ({
  data: { programId, status, pauseReason },
  status: 'ready',
  error: null,
})

function setup({
  role = 'owner' as AdminRole,
  list = vi.fn(async (): Promise<Reviews> => ready()),
  review = vi.fn(async (input: AdminProgramReviewInput): Promise<Outcome> =>
    done(input.programId, input.decision === 'approve' ? 'live' : 'changes_requested'),
  ),
  setStatus = vi.fn(async (input: AdminProgramStatusInput): Promise<Outcome> =>
    done(input.programId, input.status),
  ),
} = {}) {
  const gateway = {
    getProgramReviews: list,
    reviewProgram: review,
    setProgramStatus: setStatus,
  } as unknown as AdminGateway
  const rendered = render(
    <div className="admin-portal">
      <ProgramsPage role={role} gateway={gateway} />
    </div>,
  )
  return { list, review, setStatus, user: userEvent.setup(), ...rendered }
}

const speakSixId = 'a1b2c3d4-0000-4000-8000-000000000001'

afterEach(() => {
  document.getElementById('action-notice-stack')?.remove()
})

describe('Admin program review', () => {
  it('shows a placeholder while the queue loads, never an empty queue', async () => {
    let resolve!: (value: Reviews) => void
    setup({ list: vi.fn(() => new Promise<Reviews>((next) => (resolve = next))) })
    expect(screen.getByRole('status')).toHaveTextContent('Loading programs…')
    expect(screen.queryByText('Nothing to review')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
    resolve(ready())
    expect(await screen.findByRole('heading', { name: 'SpeakSix' })).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says there is nothing to review and still lists what was reviewed', async () => {
    setup({ list: vi.fn(async () => ready([])) })
    expect(await screen.findByRole('heading', { name: 'Nothing to review' })).toBeVisible()
    expect(screen.getByText('Nothing waiting for review')).toBeVisible()
    const reviewed = screen.getByRole('complementary', { name: 'Recently reviewed' })
    expect(within(reviewed).getByText('HabitLoop')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument()
  })

  it('handles a platform with no programs at all', async () => {
    setup({ list: vi.fn(async () => ready([], [])) })
    expect(await screen.findByRole('heading', { name: 'Nothing to review' })).toBeVisible()
    expect(screen.getByText('No programs have been reviewed yet.')).toBeVisible()
  })

  it('gives the reviewer the facts for each program, with money in normal units', async () => {
    setup({ list: vi.fn(async () => ready([programRow(), fixedProgramRow()])) })
    const card = (await screen.findByRole('heading', { name: 'SpeakSix' })).closest('article')!
    expect(screen.getByText('2 waiting for review')).toBeVisible()
    const facts = within(card)
    expect(facts.getByText('Speak English with confidence in six weeks.')).toBeVisible()
    expect(facts.getByText('30% of every payment for 12 months')).toBeVisible()
    expect(facts.getByText('Education')).toBeVisible()
    expect(facts.getByText('SpeakSix Ltd')).toBeVisible()
    expect(facts.getByText('acct_1QK7dLSpeakSix01')).toBeVisible()
    expect(facts.getByText('United Kingdom')).toBeVisible()
    expect(facts.getByText('Listed')).toBeVisible()
    expect(facts.getByText(/^Submitted /)).toBeVisible()
    const link = facts.getByRole('link', { name: /speaksix\.com\/start/ })
    expect(link).toHaveAttribute('href', 'https://speaksix.com/start')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(card.querySelector('img')).toHaveAttribute(
      'src',
      expect.stringContaining('/storage/v1/object/public/program-logos/'),
    )

    const second = screen.getByRole('heading', { name: 'Ledgerly' }).closest('article')!
    expect(within(second).getByText('$20.00 on the first payment')).toBeVisible()
    expect(within(second).getByText('Not listed')).toBeVisible()
    expect(within(second).getByText('Has extra terms')).toBeVisible()
    expect(within(second).getByText('Ledgerly Studio')).toBeVisible()
    expect(second.querySelector('img')).toBeNull()

    // No raw units, no test-mode wording, no em dashes anywhere on the screen.
    const copy = document.body.textContent ?? ''
    expect(copy).not.toMatch(/3000|2000|bps|minor|basis point/i)
    expect(copy).not.toMatch(/test mode|sandbox|livemode/i)
    expect(copy).not.toContain('—')
  })

  /** The value under a fact's label in a card. */
  const fact = (card: HTMLElement, label: string) =>
    within(card).getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement

  it('shows what an events listing pays: no commission, each reward and the monthly budget', async () => {
    setup({ list: vi.fn(async () => ready([eventsProgramRow()])) })
    const card = (await screen.findByRole('heading', { name: 'Fluent' })).closest('article')!
    expect(fact(card, 'Creators earn from')).toHaveTextContent(/^Events$/)
    expect(fact(card, 'Commission')).toHaveTextContent(/^None$/)
    expect(fact(card, 'Monthly budget')).toHaveTextContent(/^\$500\.00$/)

    const rewards = within(card).getByRole('table', { name: 'Rewards of Fluent' })
    expect(
      within(rewards)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Shown to creators', 'Event', 'Amount'])
    expect(
      within(rewards)
        .getAllByRole('row')
        .slice(1)
        .map((row) =>
          within(row)
            .getAllByRole('cell')
            .map((cell) => cell.textContent),
        ),
    ).toEqual([
      ['Account created', 'signup_completed', '$2.00'],
      ['Trial started', 'trial_started', '$5.00'],
    ])

    // The rest of the listing is still there, and nothing is in raw units.
    expect(fact(card, 'Category')).toHaveTextContent('Education')
    expect(fact(card, 'Stripe account')).toHaveTextContent('Fluent Labs')
    expect(within(card).getByRole('button', { name: 'Approve Fluent' })).toBeEnabled()
    const copy = card.textContent ?? ''
    expect(copy).not.toMatch(/50000|(?<!\$)\b(200|500)\b|bps|minor/i)
    expect(copy).not.toMatch(/test mode|sandbox|livemode/i)
    expect(copy).not.toContain('—')
  })

  it('reviews the real events listing by what it pays, not by the commission it once had', async () => {
    setup({
      list: vi.fn(async () => ({
        data: mapAdminProgramReviews(programReviewsBackendFixture),
        status: 'ready' as const,
        error: null,
      })),
    })
    const card = (await screen.findByRole('heading', { name: 'Fluent' })).closest('article')!
    expect(fact(card, 'Creators earn from')).toHaveTextContent(/^Events$/)
    expect(fact(card, 'Commission')).toHaveTextContent(/^None$/)
    expect(fact(card, 'Monthly budget')).toHaveTextContent(/^\$500\.00$/)
    expect(within(card).queryByText(/30% of every payment/)).not.toBeInTheDocument()
    expect(within(card).getByRole('table', { name: 'Rewards of Fluent' })).toHaveTextContent(
      'Account createdsignup_completed$2.00Trial startedtrial_started$5.00',
    )
    const reviewed = screen.getByRole('complementary', { name: 'Recently reviewed' })
    expect(within(reviewed).getByText('Quiet Club')).toBeVisible()
    expect(within(reviewed).queryByText(/reward|budget/i)).not.toBeInTheDocument()
  })

  it('shows what a listing that pays for both pays: the commission and the rewards', async () => {
    setup({ list: vi.fn(async () => ready([bothProgramRow()])) })
    const card = (await screen.findByRole('heading', { name: 'Pocket Chef' })).closest('article')!
    expect(fact(card, 'Creators earn from')).toHaveTextContent(/^Sales and events$/)
    expect(fact(card, 'Commission')).toHaveTextContent(/^20% of every payment$/)
    expect(fact(card, 'Monthly budget')).toHaveTextContent(/^\$1,200\.00$/)
    const rewards = within(card).getByRole('table', { name: 'Rewards of Pocket Chef' })
    expect(within(rewards).getAllByRole('row')).toHaveLength(2)
    expect(within(rewards).getByText('signup_completed')).toBeVisible()
    expect(within(rewards).getByText('$1.50')).toBeVisible()
  })

  it('draws a sales listing exactly as before, with or without the new keys', async () => {
    const old = setup({ list: vi.fn(async () => ready([programRow()])) })
    await screen.findByRole('heading', { name: 'SpeakSix' })
    expect(screen.queryByText('Creators earn from')).not.toBeInTheDocument()
    expect(screen.queryByText('Monthly budget')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(
      [...old.container.querySelectorAll('.admin-prog-card dt')].map((label) => label.textContent),
    ).toEqual([
      'Commission',
      'Landing page',
      'Category',
      'Workspace',
      'Stripe account',
      'Marketplace',
    ])
    const strip = (html: string) => html.replace(/ (id|aria-labelledby|aria-controls)="[^"]*"/g, '')
    const before = strip(old.container.querySelector('.admin-prog-card')!.outerHTML)
    old.unmount()

    // A stored budget and rewards are not used by a program that pays for sales only.
    const now = setup({
      list: vi.fn(async () =>
        ready([salesProgramRow({ rewards: rewardRows, reward_budget_minor: 50000 })]),
      ),
    })
    await screen.findByRole('heading', { name: 'SpeakSix' })
    expect(strip(now.container.querySelector('.admin-prog-card')!.outerHTML)).toBe(before)
  })

  it('shows the gaps in an events listing instead of hiding them', async () => {
    setup({
      list: vi.fn(async () =>
        ready([
          eventsProgramRow({
            rewards: [{ key: 'trial_started', label: null, amount_minor: null }, {}],
            reward_budget_minor: null,
          }),
          bothProgramRow({ rewards: [], commission_type: null, agreement: null }),
        ]),
      ),
    })
    const card = (await screen.findByRole('heading', { name: 'Fluent' })).closest('article')!
    expect(fact(card, 'Monthly budget')).toHaveTextContent('Not set')
    const rows = within(within(card).getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((row) => row.textContent)).toEqual([
      'Not settrial_startedNot set',
      'Not setNot setNot set',
    ])
    const second = screen.getByRole('heading', { name: 'Pocket Chef' }).closest('article')!
    expect(fact(second, 'Commission')).toHaveTextContent('Not set')
    expect(within(second).getByText('No rewards set')).toBeVisible()
    expect(within(second).queryByRole('table')).not.toBeInTheDocument()
  })

  it('keeps long reward words, long event names and five rewards inside the card', async () => {
    const rewards = Array.from({ length: 5 }, (_, index) => ({
      key: `onboarding.questionnaire_step_${index}:${'completed_'.repeat(4)}ok`,
      label: `Finished onboarding questionnaire step ${index}`,
      amount_minor: 100_000_000,
    }))
    setup({
      list: vi.fn(async () =>
        ready([eventsProgramRow({ rewards, reward_budget_minor: 100_000_000 })]),
      ),
    })
    const card = (await screen.findByRole('heading', { name: 'Fluent' })).closest('article')!
    const table = within(card).getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(6)
    expect(within(table).getAllByText('$1,000,000.00')).toHaveLength(5)
    expect(within(table).getByText(rewards[4].key)).toBeVisible()
  })

  it('flags a program whose workspace has no Stripe account and tolerates missing details', async () => {
    setup({
      list: vi.fn(async () =>
        ready([
          programRow({
            stripe_account_id: null,
            stripe_country: null,
            landing_url: 'javascript:alert(1)',
            category: null,
            logo_path: null,
            agreement: null,
            submitted_at: null,
          }),
        ]),
      ),
    })
    const card = (await screen.findByRole('heading', { name: 'SpeakSix' })).closest('article')!
    expect(within(card).getByText('Not connected')).toBeVisible()
    expect(within(card).queryByRole('link')).not.toBeInTheDocument()
    expect(within(card).getByText('Agreement not available')).toBeVisible()
    expect(within(card).getByText('Not set')).toBeVisible()
    expect(within(card).queryByText(/^Submitted/)).not.toBeInTheDocument()
  })

  it('opens the generated agreement in place', async () => {
    const { user } = setup({ list: vi.fn(async () => ready([fixedProgramRow()])) })
    const toggle = await screen.findByRole('button', { name: 'Read agreement for Ledgerly' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Ledgerly Affiliate Agreement')).not.toBeInTheDocument()
    await user.click(toggle)
    const agreement = screen.getByRole('region', { name: 'Agreement for Ledgerly' })
    expect(
      within(agreement).getByRole('heading', { name: 'Ledgerly Affiliate Agreement' }),
    ).toBeVisible()
    expect(within(agreement).getByText('1. Who this agreement is between')).toBeVisible()
    expect(within(agreement).getByText(/Accepting this agreement on KissMyApps/)).toBeVisible()
    // The brand's own terms follow the last section, whose heading already introduces them.
    const headings = within(agreement).getAllByRole('heading', { level: 4 })
    expect(headings.map((heading) => heading.textContent)).toEqual([
      '1. Who this agreement is between',
      '2. Commission',
      '12. Additional terms from Ledgerly Inc',
    ])
    const last = headings[2].closest('section')!
    expect(last.lastElementChild).toHaveTextContent('No discount codes in paid ads.')
    expect(last.children).toHaveLength(3)
    expect(agreement.querySelectorAll('section')).toHaveLength(3)
    const hide = screen.getByRole('button', { name: 'Hide agreement for Ledgerly' })
    expect(hide).toHaveAttribute('aria-expanded', 'true')
    await user.click(hide)
    expect(screen.queryByRole('region', { name: 'Agreement for Ledgerly' })).not.toBeInTheDocument()
  })

  it('approves after one confirmation and refreshes the queue', async () => {
    const list = vi
      .fn<() => Promise<Reviews>>()
      .mockResolvedValueOnce(ready())
      .mockResolvedValue(ready([], [programRow({ status: 'live' }), ...reviewedRows()]))
    const { user, review } = setup({ list })
    await user.click(await screen.findByRole('button', { name: 'Approve SpeakSix' }))
    const dialog = screen.getByRole('dialog', { name: 'Approve SpeakSix?' })
    expect(within(dialog).getByText(/goes live with the terms in its agreement/)).toBeVisible()
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    expect(review).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Approve program' }))
    expect(review).toHaveBeenCalledExactlyOnceWith({
      programId: speakSixId,
      decision: 'approve',
      note: null,
    })
    expect(await screen.findByText('SpeakSix is live.')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Nothing to review' })).toBeVisible()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('shows the action in progress and cannot be sent twice', async () => {
    let finish!: (value: Outcome) => void
    const review = vi.fn(() => new Promise<Outcome>((next) => (finish = next)))
    const { user } = setup({ review })
    await user.click(await screen.findByRole('button', { name: 'Approve SpeakSix' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Approve program' }))
    const pending = within(dialog).getByRole('button', { name: 'Approving…' })
    expect(pending).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(review).toHaveBeenCalledTimes(1)
    finish(done(speakSixId, 'live'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('needs a note before requesting changes and sends it to the merchant', async () => {
    const { user, review } = setup()
    await user.click(await screen.findByRole('button', { name: 'Request changes to SpeakSix' }))
    const dialog = screen.getByRole('dialog', { name: 'Request changes' })
    const note = within(dialog).getByRole('textbox', { name: 'What needs to change' })
    expect(note).toHaveFocus()
    expect(within(dialog).getByText('The merchant sees this note.')).toBeVisible()
    expect(note).toHaveAttribute('maxlength', '1000')

    await user.click(within(dialog).getByRole('button', { name: 'Send to merchant' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Write at least 5 characters.')
    expect(note).toHaveAttribute('aria-invalid', 'true')
    expect(note).toHaveFocus()
    expect(review).not.toHaveBeenCalled()

    await user.type(note, '  no  ')
    await user.click(within(dialog).getByRole('button', { name: 'Send to merchant' }))
    expect(review).not.toHaveBeenCalled()

    await user.clear(note)
    await user.type(note, ' The landing page returns a 404. ')
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Send to merchant' }))
    expect(review).toHaveBeenCalledExactlyOnceWith({
      programId: speakSixId,
      decision: 'request_changes',
      note: 'The landing page returns a 404.',
    })
    expect(await screen.findByText('SpeakSix was sent back to the merchant.')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps the note and offers a retry when the request does not go through', async () => {
    const review = vi
      .fn<(input: AdminProgramReviewInput) => Promise<Outcome>>()
      .mockResolvedValueOnce(failed('temporarily_unavailable'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(done(speakSixId, 'changes_requested'))
    const { user, list } = setup({ review })
    await user.click(await screen.findByRole('button', { name: 'Request changes to SpeakSix' }))
    const dialog = screen.getByRole('dialog')
    const note = within(dialog).getByRole('textbox')
    await user.type(note, 'Logo is unreadable.')
    await user.click(within(dialog).getByRole('button', { name: 'Send to merchant' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That did not go through. Check your connection and try again.',
    )
    expect(note).toHaveValue('Logo is unreadable.')
    await user.click(within(dialog).getByRole('button', { name: 'Send to merchant' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That did not go through.')
    expect(list).toHaveBeenCalledTimes(1)
    await user.click(within(dialog).getByRole('button', { name: 'Send to merchant' }))
    expect(await screen.findByText('SpeakSix was sent back to the merchant.')).toBeVisible()
    expect(review).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['not_authorized', 'unauthorized', /This needs a password sign-in\. Sign out, sign in again/],
    ['not_authenticated', 'unauthorized', /Your session ended\. Sign in again/],
  ] as const)(
    'asks for a fresh password sign-in when an action is %s',
    async (code, status, message) => {
      const review = vi.fn(async (): Promise<Outcome> => failed(code, 'generic', status))
      const { user, list } = setup({ review })
      await user.click(await screen.findByRole('button', { name: 'Approve SpeakSix' }))
      const dialog = screen.getByRole('dialog')
      await user.click(within(dialog).getByRole('button', { name: 'Approve program' }))
      const alert = await within(dialog).findByRole('alert')
      expect(alert).toHaveTextContent(message)
      expect(alert).toHaveTextContent('Nothing was changed.')
      expect(alert).not.toHaveTextContent('generic')
      expect(list).toHaveBeenCalledTimes(1)
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      expect(screen.getByRole('button', { name: 'Approve SpeakSix' })).toBeEnabled()
    },
  )

  it.each([
    [
      'Stripe was disconnected',
      'Stripe is no longer connected for this workspace, so the program cannot go live. The merchant has to reconnect Stripe first.',
    ],
    [
      'the agreement changed after the merchant read it',
      'The agreement changed after the merchant read it. Request changes so they read it again.',
    ],
  ])(
    'closes, explains and refreshes when approval is refused because %s',
    async (_why, message) => {
      const review = vi.fn(async (): Promise<Outcome> => failed('invalid_state', message))
      const { user, list } = setup({ review })
      await user.click(await screen.findByRole('button', { name: 'Approve SpeakSix' }))
      await user.click(screen.getByRole('button', { name: 'Approve program' }))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('Nothing was changed')
      expect(alert).toHaveTextContent(message)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
      // The program is still in the queue, so the reviewer can request changes next.
      expect(screen.getByRole('button', { name: 'Request changes to SpeakSix' })).toBeVisible()
    },
  )

  it('keeps the dialog open when the request itself was refused', async () => {
    const review = vi.fn(async (): Promise<Outcome> =>
      failed('invalid_input', 'Write a note of 5 to 1000 characters.'),
    )
    const { user, list } = setup({ review })
    await user.click(await screen.findByRole('button', { name: 'Request changes to SpeakSix' }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByRole('textbox'), 'Fix the logo.')
    await user.click(within(dialog).getByRole('button', { name: 'Send to merchant' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Write a note of 5 to 1000 characters.',
    )
    expect(within(dialog).getByRole('textbox')).toHaveValue('Fix the logo.')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('does not claim an outcome it could not confirm', async () => {
    const review = vi.fn(async (): Promise<Outcome> => failed('invalid_response'))
    const { user, list } = setup({ review })
    await user.click(await screen.findByRole('button', { name: 'Approve SpeakSix' }))
    await user.click(screen.getByRole('button', { name: 'Approve program' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Not confirmed')
    expect(alert).toHaveTextContent('check the program before trying again')
    expect(screen.queryByText('SpeakSix is live.')).not.toBeInTheDocument()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('lists recently reviewed programs with the right action for each', async () => {
    setup()
    const reviewed = await screen.findByRole('complementary', { name: 'Recently reviewed' })
    const rows = within(reviewed).getAllByRole('listitem')
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual([
      'HabitLoop',
      'MealMap',
      'TrailNotes',
      'PenPal',
    ])
    expect(within(rows[0]).getByText('Live')).toBeVisible()
    expect(within(rows[0]).getByRole('button', { name: 'Pause HabitLoop' })).toBeVisible()
    expect(within(rows[1]).getByText('Paused by KissMyApps')).toBeVisible()
    expect(within(rows[1]).getByText(/MealMap Kitchen/)).toBeVisible()
    // Each row says when it was reviewed, in words a screen reader gets in full.
    for (const row of rows) expect(row).toHaveTextContent(/Reviewed \S+/)
    expect(within(rows[1]).getByRole('button', { name: 'Lift pause on MealMap' })).toBeVisible()
    expect(within(rows[2]).getByText('Paused by merchant')).toBeVisible()
    expect(within(rows[2]).queryByRole('button')).not.toBeInTheDocument()
    expect(within(rows[3]).getByText('Changes requested')).toBeVisible()
    expect(within(rows[3]).queryByRole('button')).not.toBeInTheDocument()
  })

  it('pauses a live program with a reason the merchant will see', async () => {
    const { user, setStatus, list } = setup()
    await user.click(await screen.findByRole('button', { name: 'Pause HabitLoop' }))
    const dialog = screen.getByRole('dialog', { name: 'Pause HabitLoop?' })
    expect(
      within(dialog).getByText(/cannot resume the program until you lift the pause/),
    ).toBeVisible()
    const note = within(dialog).getByRole('textbox', { name: 'Reason for the pause (optional)' })
    expect(note).not.toBeRequired()
    expect(within(dialog).getByText('The merchant sees this note.')).toBeVisible()
    // A reason is optional, but one that is given has to say something.
    await user.type(note, 'ads')
    await user.click(within(dialog).getByRole('button', { name: 'Pause program' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Write at least 5 characters, or leave it empty.',
    )
    expect(setStatus).not.toHaveBeenCalled()
    await user.clear(note)
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    await user.type(note, 'Misleading claims in ads.')
    await user.click(within(dialog).getByRole('button', { name: 'Pause program' }))
    expect(setStatus).toHaveBeenCalledExactlyOnceWith({
      programId: 'a1b2c3d4-0000-4000-8000-000000000011',
      status: 'paused',
      note: 'Misleading claims in ads.',
    })
    expect(await screen.findByText('HabitLoop is paused.')).toBeVisible()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('pauses without a reason', async () => {
    const { user, setStatus } = setup()
    await user.click(await screen.findByRole('button', { name: 'Pause HabitLoop' }))
    await user.click(screen.getByRole('button', { name: 'Pause program' }))
    expect(setStatus).toHaveBeenCalledExactlyOnceWith({
      programId: 'a1b2c3d4-0000-4000-8000-000000000011',
      status: 'paused',
      note: null,
    })
    expect(await screen.findByText('HabitLoop is paused.')).toBeVisible()
  })

  it('lifts a KissMyApps pause', async () => {
    const { user, setStatus } = setup()
    await user.click(await screen.findByRole('button', { name: 'Lift pause on MealMap' }))
    const dialog = screen.getByRole('dialog', { name: 'Lift the pause on MealMap?' })
    expect(within(dialog).getByText('The program goes live again.')).toBeVisible()
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Lift pause' }))
    expect(setStatus).toHaveBeenCalledExactlyOnceWith({
      programId: 'a1b2c3d4-0000-4000-8000-000000000012',
      status: 'live',
      note: null,
    })
    expect(await screen.findByText('MealMap is live again.')).toBeVisible()
  })

  it('says a program stays paused when Stripe was disconnected, and does not call it live', async () => {
    const mealMap = 'a1b2c3d4-0000-4000-8000-000000000012'
    const disconnected = { brand_name: null, stripe_account_id: null, stripe_country: null }
    const rows = reviewedRows().map((row) =>
      row.id === mealMap ? { ...row, ...disconnected } : row,
    )
    const list = vi
      .fn<() => Promise<Reviews>>()
      .mockResolvedValueOnce(ready([], rows))
      .mockResolvedValue(
        ready(
          [],
          rows.map((row) =>
            row.id === mealMap ? { ...row, pause_reason: 'stripe_disconnected' } : row,
          ),
        ),
      )
    const setStatus = vi.fn(async (input: AdminProgramStatusInput): Promise<Outcome> =>
      done(input.programId, 'paused', 'stripe_disconnected'),
    )
    const { user } = setup({ list, setStatus })
    await user.click(await screen.findByRole('button', { name: 'Lift pause on MealMap' }))
    const dialog = screen.getByRole('dialog', { name: 'Lift the pause on MealMap?' })
    expect(within(dialog).getByText(/Stripe is disconnected for this workspace/)).toBeVisible()
    expect(within(dialog).queryByText('The program goes live again.')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Lift pause' }))
    expect(await screen.findByText('Still paused')).toBeVisible()
    expect(screen.getByText(/MealMap stays paused because Stripe is disconnected/)).toBeVisible()
    expect(screen.queryByText('MealMap is live again.')).not.toBeInTheDocument()
    expect(await screen.findByText('Paused, Stripe disconnected')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Lift pause on MealMap' })).not.toBeInTheDocument()
  })

  it('cancels a dialog without calling the backend and returns focus', async () => {
    const { user, review } = setup()
    const open = await screen.findByRole('button', { name: 'Request changes to SpeakSix' })
    await user.click(open)
    await user.type(screen.getByRole('textbox'), 'Half a thought')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(review).not.toHaveBeenCalled()
    expect(open).toHaveFocus()
    // A reopened dialog starts clean.
    await user.click(open)
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('tells a load failure apart from an empty queue and retries', async () => {
    const list = vi
      .fn<() => Promise<Reviews>>()
      .mockResolvedValueOnce(failed('temporarily_unavailable'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(ready())
    const { user } = setup({ list })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'Programs are unavailable' })).toBeVisible()
    expect(alert).toHaveTextContent('This is not an empty queue.')
    expect(screen.queryByText('Nothing to review')).not.toBeInTheDocument()
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Programs are unavailable')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'SpeakSix' })).toBeVisible()
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('treats a gateway without the review functions as unavailable', async () => {
    render(
      <div className="admin-portal">
        <ProgramsPage role="owner" gateway={{} as AdminGateway} />
      </div>,
    )
    expect(await screen.findByRole('heading', { name: 'Programs are unavailable' })).toBeVisible()
  })

  it('keeps the list on screen while it refreshes', async () => {
    let resolve!: (value: Reviews) => void
    const list = vi
      .fn<() => Promise<Reviews>>()
      .mockResolvedValueOnce(ready())
      .mockImplementationOnce(() => new Promise<Reviews>((next) => (resolve = next)))
    const { user } = setup({ list })
    await screen.findByRole('heading', { name: 'SpeakSix' })
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled()
    expect(screen.getByRole('heading', { name: 'SpeakSix' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Approve SpeakSix' })).toBeDisabled()
    resolve(ready([fixedProgramRow()]))
    expect(await screen.findByRole('heading', { name: 'Ledgerly' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'SpeakSix' })).not.toBeInTheDocument()
  })

  it('asks for a password sign-in when the session is not password-authenticated', async () => {
    setup({
      list: vi.fn(async () => failed('not_authorized', 'generic', 'unauthorized')),
    })
    expect(await screen.findByRole('heading', { name: 'Sign in with your password' })).toBeVisible()
    expect(
      screen.getByText(/Owner or Operations session that was started with a password/),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument()
    expect(screen.queryByText('Nothing to review')).not.toBeInTheDocument()
  })

  it('asks a signed-out admin to sign in', async () => {
    setup({
      list: vi.fn(async () => failed('not_authenticated', 'generic', 'unauthorized')),
    })
    expect(await screen.findByRole('heading', { name: 'Sign in to review programs' })).toBeVisible()
  })

  it.each(['finance', 'analyst', 'support'] as const)(
    'does not read programs for the %s role',
    (role) => {
      const { list } = setup({ role })
      expect(screen.getByRole('heading', { name: 'Program review is restricted' })).toBeVisible()
      expect(
        screen.getByText('Only Owner and Operations admins can review programs.'),
      ).toBeVisible()
      expect(list).not.toHaveBeenCalled()
    },
  )

  it('lets Operations review', async () => {
    const { list } = setup({ role: 'operations' })
    expect(await screen.findByRole('button', { name: 'Approve SpeakSix' })).toBeEnabled()
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('has no accessibility violations in the queue or the request-changes dialog', async () => {
    const { user, container } = setup({
      list: vi.fn(async () => ready([programRow(), fixedProgramRow()])),
    })
    await user.click(await screen.findByRole('button', { name: 'Read agreement for SpeakSix' }))
    const page = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(page.violations).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Request changes to SpeakSix' }))
    const dialog = await axe.run(screen.getByRole('dialog'), {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(dialog.violations).toEqual([])
  })

  it('has no accessibility violations in listings that pay per event', async () => {
    const { container } = setup({
      list: vi.fn(async () =>
        ready([eventsProgramRow(), bothProgramRow(), eventsProgramRow({ id: 'x', rewards: [] })]),
      ),
    })
    await screen.findByRole('heading', { name: 'Pocket Chef' })
    const page = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(page.violations).toEqual([])
  })
})
