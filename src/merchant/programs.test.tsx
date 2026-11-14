import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Project, Role } from './api'
import { MerchantApp } from './MerchantApp'
import {
  agreementReady,
  bpsToPercent,
  categoryLabels,
  changedInput,
  changesAgreement,
  checkLogoFile,
  commissionExample,
  commissionHeadline,
  currencies,
  describeProblem,
  dollarsToMinor,
  draftFromProgram,
  draftProgress,
  fallbackMessages,
  fieldMessages,
  formatDay,
  formatMoney,
  initials,
  inputFromDraft,
  LOGO_MAX_BYTES,
  minorToDollars,
  optionsSummary,
  percentToBps,
  problemMessages,
  ProgramError,
  readAgreement,
  readFailure,
  readState,
  readTracking,
  trackingLine,
  trackingSnippet,
  trackingSnippetNote,
  validateDraft,
} from './programs'
import type {
  CommissionTerms,
  Program,
  ProgramDraft,
  ProgramState,
  ProgramStep,
  Tracking,
} from './programs'
import { href, parseRoute } from './routes'

type Args = Record<string, unknown>
type Answer = unknown | ((args: Args) => unknown)

// A stand-in for the Supabase client: auth with listeners, the context rpcs, the
// workspace_program_* functions answered from a table, and the logo bucket.
const fake = vi.hoisted(() => {
  type Session = { user: { id: string; email: string } } | null
  type Listener = (event: string, session: Session) => void
  const state = {
    session: null as Session,
    listeners: new Set<Listener>(),
    context: null as unknown,
    table: {} as Record<string, unknown>,
    calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    uploads: [] as Array<{ bucket: string; path: string; file: File; options: unknown }>,
    uploadFails: false,
  }
  const emit = (event: string) =>
    state.listeners.forEach((listener) => listener(event, state.session))
  const auth = {
    onAuthStateChange(listener: Listener) {
      state.listeners.add(listener)
      setTimeout(() => listener('INITIAL_SESSION', state.session), 0)
      return { data: { subscription: { unsubscribe: () => state.listeners.delete(listener) } } }
    },
    async signInWithPassword({ email }: { email: string; password: string }) {
      state.session = { user: { id: 'user-1', email } }
      emit('SIGNED_IN')
      return { error: null }
    },
    async signOut() {
      state.session = null
      emit('SIGNED_OUT')
      return { error: null }
    },
  }
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    if (!name.startsWith('workspace_program_')) return { data: state.context, error: null }
    state.calls.push({ name, args })
    const answer = state.table[name]
    const value =
      typeof answer === 'function'
        ? await (answer as (args: Record<string, unknown>) => unknown)(args)
        : answer
    // A refusal is what PostgREST sends for a raised exception: errcode, message, DETAIL.
    const refusal = value as { refused?: boolean; code?: string; details?: string | null } | null
    if (refusal && refusal.refused)
      return {
        data: null,
        error: { code: refusal.code, details: refusal.details, message: 'From the database.' },
      }
    // An Error stands for a request that never got an answer.
    if (value instanceof Error) return { data: null, error: { message: value.message } }
    if (value === undefined)
      return { data: null, error: { code: 'XX000', details: null, message: `No answer: ${name}` } }
    return { data: value, error: null }
  }
  const storage = {
    from: (bucket: string) => ({
      async upload(path: string, file: File, options: unknown) {
        state.uploads.push({ bucket, path, file, options })
        return state.uploadFails
          ? { data: null, error: { message: 'new row violates row-level security policy' } }
          : { data: { path }, error: null }
      },
      getPublicUrl: (path: string) => ({
        data: { publicUrl: `https://files.example/${bucket}/${path}` },
      }),
    }),
  }
  return { state, client: { auth, rpc, storage } }
})

vi.mock('../lib/supabase', () => ({
  supabase: fake.client,
  getSupabaseConfigurationIssue: () => null,
  requireSupabaseClient: () => fake.client,
}))

const project: Project = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'SpeakSix',
  platforms: ['web', 'ios'],
  timezone: 'Europe/London',
  allowed_origins: [],
  replay_enabled: true,
  created_at: '2026-10-01T09:00:00Z',
}

const context = (role: Role, projects: Project[] = [project]): Context => ({
  user: { id: 'user-1', email: 'victory@example.com', name: 'Victory Onorhime' },
  workspaces: [{ id: 'ws-1', name: 'No Brainer Lab', role, projects }],
})

/** A complete draft program, as the database returns it. */
const program = (over: Partial<Program> = {}): Program => ({
  id: 'prog-1',
  revision: 3,
  status: 'draft',
  pause_reason: null,
  review_note: null,
  slug: 'speaksix',
  name: 'SpeakSix',
  category: 'education',
  tagline: 'Speak a new language in six weeks',
  logo_path: null,
  landing_url: 'https://speaksix.app',
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
  marketplace_listed: true,
  extra_terms: null,
  agreement_read: false,
  has_unpublished_changes: false,
  live_terms_version: null,
  submitted_at: null,
  first_published_at: null,
  updated_at: '2026-11-13T12:34:21.550058+00:00',
  ...over,
})

const live = (over: Partial<Program> = {}) =>
  program({
    status: 'live',
    revision: 9,
    agreement_read: true,
    live_terms_version: 1,
    submitted_at: '2026-10-30T10:00:00.120000+00:00',
    first_published_at: '2026-11-01T09:00:00.550058+00:00',
    ...over,
  })

/** A ProgramState whose checklist and can_submit follow from the program, as the database's do. */
function programState(
  row: Program | null = program(),
  over: Partial<Pick<ProgramState, 'can_manage' | 'stripe_connected' | 'can_submit'>> = {},
): ProgramState {
  const stripe = over.stripe_connected ?? true
  const checklist = {
    stripe_connected: stripe,
    details: Boolean(row?.name && row.category && row.tagline),
    landing_page: Boolean(row?.landing_url),
    commission: Boolean(row?.commission_type),
    agreement_read: Boolean(row?.agreement_read),
  }
  const published = row?.status === 'live' || row?.status === 'paused'
  return {
    can_manage: over.can_manage ?? true,
    stripe_connected: stripe,
    brand_name: stripe ? 'SpeakSix Ltd' : null,
    program: row,
    checklist,
    can_submit:
      over.can_submit ??
      (Boolean(row) &&
        row?.status !== 'in_review' &&
        Object.values(checklist).every(Boolean) &&
        (!published || Boolean(row?.has_unpublished_changes))),
  }
}

const SHA = 'a3f1c2d4e5b697887766554433221100ffeeddccbbaa99887766554433221100'

const agreement = (extraTerms: string | null = null) => ({
  complete: true,
  sha256: SHA,
  agreement: {
    title: 'SpeakSix affiliate agreement',
    brand_name: 'SpeakSix Ltd',
    program_name: 'SpeakSix',
    summary: [
      { label: 'Commission', value: '30% of every payment for 12 months' },
      { label: 'Minimum payout', value: '$20.00' },
    ],
    sections: [
      ...Array.from({ length: 11 }, (_, index) => ({
        heading: `${index + 1}. Section ${index + 1}`,
        paragraphs: [`Paragraph one of section ${index + 1}.`, 'A second paragraph.'],
      })),
      ...(extraTerms
        ? [
            {
              heading: '12. Additional terms from SpeakSix Ltd',
              paragraphs: ['SpeakSix Ltd has added the following terms.'],
            },
          ]
        : []),
    ],
    extra_terms: extraTerms,
  },
})

const tracking = (over: Partial<Tracking> = {}): Tracking => ({
  connected: true,
  payments_seen: 0,
  tagged_payments: 0,
  sales: 0,
  matched_sales: 0,
  last_sale_at: null,
  last_matched_at: null,
  last_match_source: null,
  sdk_click_seen_at: null,
  ...over,
})

/** What the database raises: errcode 22023 with a stable code in DETAIL, unless said otherwise. */
const refuse = (details: string | null, code = '22023') => ({ refused: true, code, details })

function signedInAs(role: Role, projects?: Project[]) {
  fake.state.session = { user: { id: 'user-1', email: 'victory@example.com' } }
  fake.state.context = context(role, projects)
}

function answers(table: Record<string, Answer>) {
  fake.state.table = { workspace_program_tracking: tracking(), ...table }
}

const sent = (name: string) =>
  fake.state.calls.filter((call) => call.name === `workspace_program_${name}`).map((c) => c.args)

async function openProgram(get: Answer = programState()) {
  answers({ ...fake.state.table, workspace_program_get: get })
  window.location.hash = '#program'
  render(<MerchantApp />)
  await screen.findByRole('heading', { name: 'Affiliate program', level: 1 })
  await waitFor(() =>
    expect(screen.queryByRole('status', { name: 'Loading your program' })).not.toBeInTheDocument(),
  )
  return userEvent.setup()
}

const page = () => document.querySelector('.mc-prog') as HTMLElement
const form = () => screen.getByRole('form', { name: 'Program details' })
const side = () => screen.getByRole('complementary', { name: 'Preview and publishing' })
const button = (name: string) => screen.getByRole('button', { name })
const field = (name: string) => screen.getByLabelText(name)
const steps = () =>
  within(side())
    .getAllByRole('listitem')
    .map((item) => item.textContent)

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  fake.state.uploads = []
  fake.state.uploadFails = false
  fake.state.context = context('owner')
  answers({})
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

describe('program route', () => {
  it('lives at #program', () => {
    expect(parseRoute('#program')).toEqual({ name: 'program' })
    expect(parseRoute('#/program')).toEqual({ name: 'program' })
    expect(href({ name: 'program' })).toBe('#program')
    expect(parseRoute(href({ name: 'program' }))).toEqual({ name: 'program' })
  })

  it('has an Affiliates group in the menu, before Settings', async () => {
    signedInAs('owner')
    await openProgram()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    const link = within(nav).getByRole('link', { name: 'Program' })
    expect(link).toHaveAttribute('href', '#program')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(document.title).toContain('Program')
    const groups = within(nav)
      .getAllByRole('button')
      .map((group) => group.textContent)
    expect(groups.indexOf('Affiliates')).toBeGreaterThan(-1)
    expect(groups.indexOf('Affiliates')).toBe(groups.indexOf('Settings') - 1)
    // The project the person was in keeps its menu.
    expect(within(nav).getByRole('link', { name: 'Overview' })).toBeInTheDocument()
  })

  it('is reachable in a workspace with no project', async () => {
    signedInAs('owner', [])
    await openProgram(programState(null))
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).getByRole('link', { name: 'Program' })).toHaveAttribute('href', '#program')
    expect(within(nav).queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument()
    expect(field('Name')).toBeEnabled()
  })
})

describe('numbers as people type them', () => {
  it('turns a typed percentage into what the database stores, and back', () => {
    expect(percentToBps('30')).toBe(3000)
    expect(percentToBps('12.5')).toBe(1250)
    expect(percentToBps(' 7.25% ')).toBe(725)
    expect(percentToBps('100')).toBe(10000)
    expect(percentToBps('0.01')).toBe(1)
    for (const wrong of ['', '0', '100.01', '101', '-5', '12.345', 'thirty', '1e2', '3000'])
      expect(percentToBps(wrong)).toBeNull()
    expect(bpsToPercent(3000)).toBe('30')
    expect(bpsToPercent(1250)).toBe('12.5')
    expect(bpsToPercent(725)).toBe('7.25')
    for (const bps of [1, 50, 725, 1250, 3000, 10000])
      expect(percentToBps(bpsToPercent(bps))).toBe(bps)
  })

  it('turns typed money into whole cents, and back', () => {
    expect(dollarsToMinor('20')).toBe(2000)
    expect(dollarsToMinor('20.00')).toBe(2000)
    expect(dollarsToMinor('19.9')).toBe(1990)
    expect(dollarsToMinor('$1,250.50')).toBe(125050)
    expect(dollarsToMinor('0')).toBe(0)
    // Cents are counted, never multiplied, so 0.29 is 29 and not 28.999.
    expect(dollarsToMinor('0.29')).toBe(29)
    expect(dollarsToMinor('1.15')).toBe(115)
    for (const wrong of ['', '-1', '20.001', 'twenty', '2000 cents', '1.2.3'])
      expect(dollarsToMinor(wrong)).toBeNull()
    expect(minorToDollars(2000)).toBe('20.00')
    expect(minorToDollars(1990)).toBe('19.90')
    expect(minorToDollars(0)).toBe('0.00')
    for (const minor of [0, 29, 115, 2000, 125050])
      expect(dollarsToMinor(minorToDollars(minor))).toBe(minor)
  })

  it('writes money the way the agreement does', () => {
    expect(formatMoney(2000, 'USD')).toBe('$20.00')
    expect(formatMoney(123450, 'USD')).toBe('$1,234.50')
    expect(formatMoney(2000, 'EUR')).toBe('20.00 EUR')
    expect(formatMoney(150, 'GBP')).toBe('1.50 GBP')
  })
})

describe('commission wording', () => {
  const terms = (over: Partial<CommissionTerms>): CommissionTerms => ({
    commission_type: 'percent',
    commission_rate_bps: 3000,
    commission_fixed_minor: null,
    currency: 'USD',
    commission_duration: 'months',
    commission_months: 12,
    ...over,
  })
  const fixed = {
    commission_type: 'fixed',
    commission_rate_bps: null,
    commission_fixed_minor: 2000,
  }

  it.each([
    [{ commission_duration: 'first_payment' }, '30% of the first payment'],
    [{ commission_duration: 'months' }, '30% of every payment for 12 months'],
    [{ commission_duration: 'lifetime' }, '30% of every payment'],
    [{ ...fixed, commission_duration: 'first_payment' }, '$20.00 on the first payment'],
    [{ ...fixed, commission_duration: 'months' }, '$20.00 on every payment for 12 months'],
    [{ ...fixed, commission_duration: 'lifetime' }, '$20.00 on every payment'],
  ] as Array<[Partial<CommissionTerms>, string]>)('%o reads "%s"', (over, headline) => {
    expect(commissionHeadline(terms(over))).toBe(headline)
  })

  it('handles one month, part percentages and other currencies', () => {
    expect(commissionHeadline(terms({ commission_months: 1 }))).toBe(
      '30% of every payment for 1 month',
    )
    expect(commissionHeadline(terms({ commission_rate_bps: 1250 }))).toBe(
      '12.5% of every payment for 12 months',
    )
    expect(
      commissionHeadline(
        terms({ ...fixed, currency: 'EUR', commission_duration: 'lifetime' } as CommissionTerms),
      ),
    ).toBe('20.00 EUR on every payment')
  })

  it('says nothing until the commission is complete', () => {
    expect(commissionHeadline(terms({ commission_type: null }))).toBeNull()
    expect(commissionHeadline(terms({ commission_rate_bps: null }))).toBeNull()
    expect(commissionHeadline(terms({ commission_duration: null }))).toBeNull()
    expect(commissionHeadline(terms({ commission_months: null }))).toBeNull()
    expect(
      commissionHeadline(terms({ commission_type: 'fixed', commission_fixed_minor: null })),
    ).toBeNull()
  })

  it('works one example through', () => {
    expect(commissionExample(terms({}))).toBe('On a $50.00 sale a creator earns $15.00.')
    expect(commissionExample(terms(fixed as Partial<CommissionTerms>))).toBe(
      'A creator earns $20.00 on a sale of any size.',
    )
    expect(commissionExample(terms({ commission_type: null }))).toBeNull()
  })

  it('sums up the options in plain words', () => {
    expect(optionsSummary(draftFromProgram(null))).toEqual([
      '30-day attribution',
      '30-day hold',
      '$20.00 minimum payout',
      'Creators approved automatically',
      'Listed in the marketplace',
    ])
    expect(
      optionsSummary({
        ...draftFromProgram(null),
        attributionDays: '60',
        holdDays: '0',
        minimumPayout: '0',
        approvalMode: 'manual',
        marketplaceListed: false,
        currency: 'EUR',
        extraTerms: 'No coupon sites.',
      }),
    ).toEqual([
      '60-day attribution',
      'No hold',
      'No minimum payout',
      'You approve each creator',
      'Not listed in the marketplace',
      'Paid in EUR',
      'Extra terms added',
    ])
  })

  it('makes a mark from the product name and a date a person can read', () => {
    expect(initials('SpeakSix')).toBe('SS')
    expect(initials('No Brainer Lab')).toBe('NB')
    expect(initials('  ')).toBe('')
    // Timestamps arrive with microseconds and an offset.
    expect(formatDay('2026-11-13T12:34:21.550058+00:00')).toBe('13 Nov 2026')
  })
})

describe('the form and what is sent', () => {
  const filled: ProgramDraft = {
    ...draftFromProgram(null),
    name: ' SpeakSix ',
    category: 'education',
    tagline: 'Speak a new language in six weeks',
    landingUrl: 'https://speaksix.app',
    percent: '30',
  }

  it('starts a new program with the defaults already filled', () => {
    expect(draftFromProgram(null)).toEqual({
      name: '',
      category: '',
      tagline: '',
      logoPath: null,
      landingUrl: '',
      commissionType: 'percent',
      percent: '',
      fixed: '',
      duration: 'months',
      months: '12',
      attributionDays: '30',
      holdDays: '30',
      minimumPayout: '20.00',
      approvalMode: 'automatic',
      marketplaceListed: true,
      currency: 'USD',
      extraTerms: '',
    })
  })

  it('shows a saved program in normal units', () => {
    const draft = draftFromProgram(
      program({
        commission_type: 'fixed',
        commission_rate_bps: null,
        commission_fixed_minor: 1550,
        commission_duration: 'first_payment',
        commission_months: null,
        minimum_payout_minor: 5000,
        hold_days: 14,
      }),
    )
    expect(draft).toMatchObject({
      commissionType: 'fixed',
      fixed: '15.50',
      percent: '',
      duration: 'first_payment',
      minimumPayout: '50.00',
      holdDays: '14',
    })
  })

  it('converts at the edge', () => {
    expect(inputFromDraft(filled)).toEqual({
      name: 'SpeakSix',
      category: 'education',
      tagline: 'Speak a new language in six weeks',
      logo_path: null,
      landing_url: 'https://speaksix.app',
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
      marketplace_listed: true,
      extra_terms: null,
    })
    expect(
      inputFromDraft({ ...filled, commissionType: 'fixed', fixed: '15', duration: 'lifetime' }),
    ).toMatchObject({
      commission_type: 'fixed',
      commission_rate_bps: null,
      commission_fixed_minor: 1500,
      commission_duration: 'lifetime',
      commission_months: null,
    })
  })

  it('saves a commission type only together with its amount', () => {
    expect(inputFromDraft({ ...filled, percent: '' })).toMatchObject({
      commission_type: null,
      commission_rate_bps: null,
      commission_fixed_minor: null,
    })
  })

  it('sends everything it has for a new program, and no revision', () => {
    const input = changedInput(filled, null)
    expect(input).not.toHaveProperty('revision')
    expect(input).not.toHaveProperty('logo_path')
    expect(input).not.toHaveProperty('extra_terms')
    expect(input).toMatchObject({
      name: 'SpeakSix',
      commission_type: 'percent',
      commission_rate_bps: 3000,
      commission_duration: 'months',
      commission_months: 12,
      minimum_payout_minor: 2000,
    })
  })

  it('sends only what changed for a saved program, with its revision', () => {
    const saved = program()
    expect(changedInput(draftFromProgram(saved), saved)).toEqual({ revision: 3 })
    expect(changedInput({ ...draftFromProgram(saved), tagline: 'New words' }, saved)).toEqual({
      tagline: 'New words',
      revision: 3,
    })
    expect(changedInput({ ...draftFromProgram(saved), tagline: '' }, saved)).toEqual({
      tagline: null,
      revision: 3,
    })
  })

  it('never sends half of a pair the database checks together', () => {
    const saved = program()
    expect(changedInput({ ...draftFromProgram(saved), months: '6' }, saved)).toEqual({
      commission_duration: 'months',
      commission_months: 6,
      revision: 3,
    })
    expect(changedInput({ ...draftFromProgram(saved), duration: 'lifetime' }, saved)).toEqual({
      commission_duration: 'lifetime',
      commission_months: null,
      revision: 3,
    })
    expect(changedInput({ ...draftFromProgram(saved), percent: '25' }, saved)).toEqual({
      commission_type: 'percent',
      commission_rate_bps: 2500,
      commission_fixed_minor: null,
      revision: 3,
    })
    expect(
      changedInput({ ...draftFromProgram(saved), commissionType: 'fixed', fixed: '15' }, saved),
    ).toEqual({
      commission_type: 'fixed',
      commission_rate_bps: null,
      commission_fixed_minor: 1500,
      revision: 3,
    })
  })

  it('knows which edits change what creators agree to', () => {
    const saved = program()
    const draft = draftFromProgram(saved)
    expect(changesAgreement(draft, saved)).toBe(false)
    for (const cosmetic of [
      { tagline: 'New words' },
      { category: 'games' },
      { logoPath: 'ws-1/a.png' },
      { marketplaceListed: false },
    ] as Array<Partial<ProgramDraft>>)
      expect(changesAgreement({ ...draft, ...cosmetic }, saved)).toBe(false)
    for (const term of [
      { name: 'SpeakSeven' },
      { landingUrl: 'https://speaksix.app/start' },
      { percent: '25' },
      { duration: 'lifetime' },
      { months: '6' },
      { attributionDays: '60' },
      { holdDays: '14' },
      { minimumPayout: '50' },
      { approvalMode: 'manual' },
      { currency: 'EUR' },
      { extraTerms: 'No coupon sites.' },
    ] as Array<Partial<ProgramDraft>>)
      expect(changesAgreement({ ...draft, ...term }, saved)).toBe(true)
  })

  it('lets a draft be unfinished but not wrong', () => {
    expect(validateDraft(draftFromProgram(null))).toEqual({})
    expect(validateDraft(filled)).toEqual({})
    expect(
      validateDraft({
        ...filled,
        name: 'x'.repeat(121),
        tagline: 'x'.repeat(161),
        landingUrl: 'http://speaksix.app',
        percent: '130',
        months: '40',
        attributionDays: '0',
        holdDays: '91',
        minimumPayout: 'lots',
        extraTerms: 'x'.repeat(4001),
      }),
    ).toEqual({
      name: fieldMessages.name,
      tagline: fieldMessages.tagline,
      landingUrl: fieldMessages.landingUrl,
      amount: fieldMessages.amount,
      months: fieldMessages.months,
      attributionDays: fieldMessages.attributionDays,
      holdDays: fieldMessages.holdDays,
      minimumPayout: fieldMessages.minimumPayout,
      extraTerms: fieldMessages.extraTerms,
    })
    expect(validateDraft({ ...filled, commissionType: 'fixed', fixed: '0' }).amount).toBe(
      'Enter an amount like 20.00.',
    )
    // The months are only checked when the commission runs for months.
    expect(validateDraft({ ...filled, duration: 'lifetime', months: '' })).toEqual({})
    for (const address of ['speaksix.app', 'https://localhost', 'ftp://speaksix.app', 'https://'])
      expect(validateDraft({ ...filled, landingUrl: address }).landingUrl).toBeDefined()
  })

  it('does not let a published program lose its main fields', () => {
    const emptied = { ...filled, name: ' ', category: '', tagline: '', landingUrl: '', percent: '' }
    expect(validateDraft(emptied as ProgramDraft)).toEqual({})
    expect(validateDraft(emptied as ProgramDraft, true)).toEqual({
      name: fieldMessages.name,
      category: fieldMessages.category,
      tagline: fieldMessages.tagline,
      landingUrl: fieldMessages.landingUrl,
      amount: fieldMessages.amount,
    })
    expect(validateDraft(filled, true)).toEqual({})
  })

  it('answers the checklist from the form before anything is saved', () => {
    expect(draftProgress(draftFromProgram(null))).toEqual({
      details: false,
      landing_page: false,
      commission: false,
    })
    expect(draftProgress(filled)).toEqual({ details: true, landing_page: true, commission: true })
    expect(draftProgress({ ...filled, category: '' }).details).toBe(false)
    expect(draftProgress({ ...filled, months: '' }).commission).toBe(false)
  })

  it('can show the agreement without a category or a description', () => {
    expect(agreementReady(filled)).toBe(true)
    expect(agreementReady({ ...filled, category: '', tagline: '' })).toBe(true)
    expect(agreementReady({ ...filled, name: ' ' })).toBe(false)
    expect(agreementReady({ ...filled, landingUrl: '' })).toBe(false)
    expect(agreementReady({ ...filled, percent: '' })).toBe(false)
  })

  it('pays creators in US dollars only, for now', () => {
    expect(currencies).toEqual(['USD'])
  })
})

describe('reading answers from the database', () => {
  it('reads a program state', () => {
    const answer = programState(live({ has_unpublished_changes: true }))
    expect(readState(JSON.parse(JSON.stringify(answer)))).toEqual(answer)
    expect(readState({ can_manage: false, program: null })).toEqual({
      can_manage: false,
      stripe_connected: false,
      brand_name: null,
      program: null,
      checklist: {
        stripe_connected: false,
        details: false,
        landing_page: false,
        commission: false,
        agreement_read: false,
      },
      can_submit: false,
    })
  })

  it('treats an archived program as none', () => {
    expect(readState(programState(program({ status: 'archived' }))).program).toBeNull()
  })

  it('refuses an answer it cannot trust', () => {
    for (const wrong of [
      null,
      'ok',
      [],
      {},
      { can_manage: 'yes' },
      { can_manage: true, program: { id: 'p', status: 'sideways', revision: 1 } },
      { can_manage: true, program: { id: 'p', status: 'draft' } },
      { can_manage: true, program: { status: 'draft', revision: 1 } },
    ])
      expect(() => readState(wrong)).toThrow(ProgramError)
  })

  it('reads the agreement only when it is complete and hashed', () => {
    expect(readAgreement(agreement())).toEqual(agreement())
    expect(readAgreement(agreement()).agreement?.sections).toHaveLength(11)
    expect(readAgreement(agreement('No coupon sites.')).agreement?.sections).toHaveLength(12)
    const none = { agreement: null, sha256: null, complete: false }
    expect(readAgreement({ agreement: null, sha256: null, complete: false })).toEqual(none)
    expect(readAgreement({ ...agreement(), sha256: 'short' })).toEqual(none)
    expect(readAgreement({ ...agreement(), complete: false })).toEqual(none)
    expect(() => readAgreement(null)).toThrow(ProgramError)
    expect(() =>
      readAgreement({ complete: true, sha256: SHA, agreement: { title: 'No sections' } }),
    ).toThrow(ProgramError)
  })

  it('reads the tracking counts, filling what is missing', () => {
    expect(readTracking({ connected: true, payments_seen: 4, tagged_payments: 1 })).toEqual(
      tracking({ payments_seen: 4, tagged_payments: 1 }),
    )
    expect(
      readTracking({ connected: true, last_matched_at: '2026-11-13T12:34:21.550058+00:00' })
        .last_matched_at,
    ).toBe('2026-11-13T12:34:21.550058+00:00')
    expect(readTracking({ payments_seen: -3, last_sale_at: 'soon' })).toEqual(
      tracking({ connected: false }),
    )
    expect(() => readTracking(undefined)).toThrow(ProgramError)
  })

  it('keeps the stable code from DETAIL', () => {
    expect(readFailure({ code: '22023', details: 'invalid_landing_url', message: 'x' }).code).toBe(
      'invalid_landing_url',
    )
    expect(readFailure({ code: '40001', details: 'program_changed' }).code).toBe('program_changed')
    expect(readFailure({ code: 'P0002', details: 'program_not_found' }).code).toBe(
      'program_not_found',
    )
  })

  it('reads the errors that come with no DETAIL', () => {
    expect(readFailure({ code: '40001', details: null }).code).toBe('program_changed')
    expect(readFailure({ code: '42501', details: null }).code).toBe('not_allowed')
    expect(readFailure({ code: 'P0002', details: null }).code).toBe('not_found')
    expect(readFailure({ code: '28000', details: null }).code).toBe('unauthorized')
    expect(readFailure({ code: 'PGRST301' }).code).toBe('unauthorized')
    expect(readFailure({ message: 'TypeError: Failed to fetch' }).code).toBe('unreachable')
    expect(readFailure({ code: '23505', details: 'Key (slug)=(x) already exists.' }).code).toBe(
      'unknown',
    )
    expect(readFailure({ code: 'XX000', message: 'boom' }).code).toBe('unknown')
  })
})

describe('what each failure means', () => {
  const contractCodes = [
    'program_changed',
    'program_incomplete',
    'stripe_not_connected',
    'agreement_not_read',
    'program_in_review',
    'program_paused_by_admin',
    'nothing_to_publish',
    'status_not_allowed',
    'invalid_input',
    'invalid_revision',
    'invalid_status',
    'program_not_found',
    'not_allowed',
    'not_found',
    'unauthorized',
  ]
  const allSteps = Object.keys(fallbackMessages) as ProgramStep[]

  it.each(contractCodes)('has its own words for %s', (code) => {
    const described = describeProblem(new ProgramError(code), 'save')
    expect(described.code).toBe(code)
    expect(described.message).toBe(problemMessages[code].message)
    expect(Object.values(fallbackMessages)).not.toContain(described.message)
    expect(described.field).toBeUndefined()
  })

  it.each([
    ['invalid_name', 'name', fieldMessages.name],
    ['invalid_category', 'category', fieldMessages.category],
    ['invalid_tagline', 'tagline', fieldMessages.tagline],
    ['invalid_logo_path', 'logo', fieldMessages.logo],
    ['invalid_landing_url', 'landingUrl', fieldMessages.landingUrl],
    ['invalid_commission_type', 'amount', fieldMessages.amount],
    ['invalid_commission_rate_bps', 'amount', fieldMessages.amount],
    ['invalid_commission_fixed_minor', 'amount', 'Enter an amount like 20.00.'],
    ['invalid_commission_months', 'months', fieldMessages.months],
    ['invalid_attribution_window_days', 'attributionDays', fieldMessages.attributionDays],
    ['invalid_hold_days', 'holdDays', fieldMessages.holdDays],
    ['invalid_minimum_payout_minor', 'minimumPayout', fieldMessages.minimumPayout],
    ['invalid_currency', 'currency', fieldMessages.currency],
    ['invalid_extra_terms', 'extraTerms', fieldMessages.extraTerms],
  ])('puts %s at the %s field', (code, target, message) => {
    expect(describeProblem(new ProgramError(code), 'save')).toEqual({
      code,
      field: target,
      message,
      recovery: 'none',
    })
  })

  it('says how to get past each one', () => {
    const recovery = (code: string) => describeProblem(new ProgramError(code), 'publish').recovery
    for (const code of [
      'program_changed',
      'invalid_revision',
      'program_in_review',
      'nothing_to_publish',
      'status_not_allowed',
      'invalid_status',
      'program_not_found',
    ])
      expect(recovery(code)).toBe('reload')
    expect(recovery('stripe_not_connected')).toBe('connections')
    expect(recovery('unauthorized')).toBe('sign-in')
    expect(recovery('offline')).toBe('retry')
    expect(recovery('unreachable')).toBe('retry')
    for (const code of ['program_incomplete', 'agreement_not_read', 'program_paused_by_admin'])
      expect(recovery(code)).toBe('none')
  })

  it.each(allSteps)('falls back to saying what did not happen while on "%s"', (step) => {
    for (const problem of [new ProgramError('something_new'), new Error('boom'), 'text', null]) {
      const described = describeProblem(problem, step)
      expect(described.message).toBe(fallbackMessages[step])
      expect(described.recovery).toBe(step === 'logo' ? 'none' : 'retry')
    }
  })

  it('repeats why a file was refused, at the logo', () => {
    expect(
      describeProblem(
        new ProgramError('logo_rejected', 'Choose a PNG, JPG or WebP image.'),
        'logo',
      ),
    ).toEqual({
      code: 'logo_rejected',
      field: 'logo',
      message: 'Choose a PNG, JPG or WebP image.',
      recovery: 'none',
    })
    expect(describeProblem(new ProgramError('logo_upload_failed'), 'logo').field).toBe('logo')
  })

  it('never uses database words, test-mode words or em-dashes', () => {
    const words = [
      ...Object.values(problemMessages).map((entry) => entry.message),
      ...Object.values(fallbackMessages),
      ...Object.values(fieldMessages),
      ...Object.values(categoryLabels),
      ...optionsSummary(draftFromProgram(null)),
    ]
    for (const message of words) {
      expect(message).not.toMatch(/bps|minor unit|revision|funnel|terms version|slug/i)
      expect(message).not.toMatch(/test mode|test account|sandbox|livemode/i)
      expect(message).not.toMatch(/[—–]/)
    }
  })
})

describe('choosing a logo file', () => {
  it('takes PNG, JPG and WebP up to 2 MB', () => {
    expect(checkLogoFile({ type: 'image/png', size: 40_000 })).toBeNull()
    expect(checkLogoFile({ type: 'image/jpeg', size: LOGO_MAX_BYTES })).toBeNull()
    expect(checkLogoFile({ type: 'image/webp', size: 1 })).toBeNull()
  })

  it('says why any other file cannot be used', () => {
    expect(checkLogoFile({ type: 'image/svg+xml', size: 900 })).toBe(
      'Choose a PNG, JPG or WebP image.',
    )
    expect(checkLogoFile({ type: 'image/gif', size: 900 })).toBe('Choose a PNG, JPG or WebP image.')
    expect(checkLogoFile({ type: '', size: 900 })).toBe('Choose a PNG, JPG or WebP image.')
    expect(checkLogoFile({ type: 'image/png', size: LOGO_MAX_BYTES + 1 })).toBe(
      'That image is larger than 2 MB. Choose a smaller one.',
    )
    expect(checkLogoFile({ type: 'image/png', size: 0 })).toBe(
      'That file is empty. Choose another image.',
    )
  })
})

describe('sale tracking in one line', () => {
  const now = Date.parse('2026-11-13T12:00:00Z')

  it('follows the payments Stripe has sent', () => {
    expect(trackingLine(tracking({ connected: false }), now)).toEqual({
      tone: 'off',
      text: 'Connect Stripe to start tracking sales.',
    })
    expect(trackingLine(tracking(), now)).toEqual({
      tone: 'waiting',
      text: 'Waiting for your first payment.',
    })
    expect(trackingLine(tracking({ payments_seen: 1 }), now).text).toBe(
      '1 payment seen, none tagged yet.',
    )
    expect(trackingLine(tracking({ payments_seen: 1240 }), now)).toEqual({
      tone: 'warning',
      text: '1,240 payments seen, none tagged yet.',
    })
  })

  it('counts sales rather than payments once there is a sale', () => {
    // One subscription checkout is several Stripe events but one sale.
    expect(trackingLine(tracking({ payments_seen: 3, sales: 1 }), now)).toEqual({
      tone: 'warning',
      text: '1 sale seen, none tagged yet.',
    })
    expect(trackingLine(tracking({ payments_seen: 40, sales: 12 }), now).text).toBe(
      '12 sales seen, none tagged yet.',
    )
    expect(trackingLine(tracking({ sales: 2 }), now).tone).toBe('warning')
  })

  it('says when the last sale was tied to a creator', () => {
    expect(
      trackingLine(
        tracking({
          payments_seen: 9,
          tagged_payments: 4,
          sales: 9,
          matched_sales: 4,
          last_sale_at: '2026-11-13T11:59:00+00:00',
          last_matched_at: '2026-11-13T09:00:00.550058+00:00',
        }),
        now,
      ),
    ).toEqual({ tone: 'on', text: 'Last tagged sale 3 h ago' })
    // Without a time for it, the count is given; the time of an untagged sale is never used.
    expect(
      trackingLine(
        tracking({
          payments_seen: 9,
          tagged_payments: 4,
          sales: 9,
          last_sale_at: '2026-11-13T11:59:00+00:00',
        }),
        now,
      ).text,
    ).toBe('4 tagged payments seen so far.')
    expect(
      trackingLine(
        tracking({ payments_seen: 9, tagged_payments: 4, sales: 9, matched_sales: 1 }),
        now,
      ).text,
    ).toBe('1 tagged sale so far.')
  })

  it('shows the two steps that carry the click ID to Stripe', () => {
    // The click ID lives in the visitor's browser; the Stripe call is made on the server.
    expect(trackingSnippet).toContain('const clickId = kma.getClickId()')
    expect(trackingSnippet).toContain('metadata: { kma_click: clickId }')
    expect(trackingSnippet.indexOf('In the browser')).toBeLessThan(
      trackingSnippet.indexOf('On your server'),
    )
    expect(trackingSnippetNote).toBe(
      'Send clickId with your checkout request. Works for PaymentIntents and Checkout Sessions.',
    )
  })
})

describe('program page', () => {
  it('shows that it is loading, then the form', async () => {
    signedInAs('owner')
    let finish: (value: ProgramState) => void = () => {}
    answers({
      workspace_program_get: () => new Promise<ProgramState>((resolve) => (finish = resolve)),
    })
    window.location.hash = '#program'
    render(<MerchantApp />)
    expect(await screen.findByRole('status', { name: 'Loading your program' })).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Program details' })).not.toBeInTheDocument()
    finish(programState())
    expect(await screen.findByRole('form', { name: 'Program details' })).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Loading your program' })).not.toBeInTheDocument()
    expect(sent('get')).toEqual([{ p_workspace_id: 'ws-1' }])
  })

  it('says when the program could not be loaded, and loads it on retry', async () => {
    signedInAs('owner')
    let fail = true
    const user = await openProgram(() => (fail ? refuse(null, 'XX000') : programState()))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your program could not be loaded. Try again.',
    )
    expect(screen.queryByRole('form', { name: 'Program details' })).not.toBeInTheDocument()
    fail = false
    await user.click(button('Retry'))
    expect(await screen.findByRole('form', { name: 'Program details' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers to sign in again when the session has ended', async () => {
    signedInAs('owner')
    await openProgram(refuse(null, '28000'))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your session has expired. Sign in again to continue.',
    )
    expect(button('Sign in again')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  describe('with no program yet', () => {
    it('opens an empty form with the defaults already filled', async () => {
      signedInAs('owner')
      const user = await openProgram(programState(null))
      expect(within(page()).getByText('Not published')).toBeInTheDocument()
      expect(field('Name')).toHaveValue('')
      expect(field('Category')).toHaveValue('')
      expect(field('One-line description')).toHaveValue('')
      expect(field('Landing page address')).toHaveValue('')
      expect(field('Commission percent')).toHaveValue('')
      const lasts = screen.getByRole('group', { name: 'Commission lasts' })
      expect(within(lasts).getByRole('button', { name: '12 months' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      const options = screen.getByRole('region', { name: 'More options' })
      expect(
        within(options)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        '30-day attribution',
        '30-day hold',
        '$20.00 minimum payout',
        'Creators approved automatically',
        'Listed in the marketplace',
      ])
      expect(within(form()).getByText('Nothing saved yet')).toBeInTheDocument()
      expect(button('Save')).toBeDisabled()
      expect(steps()).toEqual([
        'Done: Stripe connected',
        'To do: Product details',
        'To do: Landing page',
        'To do: Set a commission',
        'To do: Read your agreement',
      ])
      expect(button('Read agreement')).toBeDisabled()
      expect(button('Publish program')).toBeDisabled()
      expect(
        within(side()).getByText('Fill in the sections on this page to see your agreement.'),
      ).toBeInTheDocument()
      expect(within(side()).getByText('Your product')).toBeInTheDocument()
      expect(within(side()).getByText('Your commission')).toBeInTheDocument()

      await user.click(button('Change'))
      expect(field('Attribution window')).toHaveValue('30')
      expect(field('Hold before payout')).toHaveValue('30')
      expect(field('Minimum payout')).toHaveValue('20.00')
      const currency = within(screen.getByRole('region', { name: 'More options' }))
        .getByText('Currency')
        .closest('div') as HTMLElement
      expect(currency).toHaveTextContent('US dollars (USD)')
      expect(currency).toHaveTextContent('Other currencies are coming later.')
      expect(within(currency).queryByRole('combobox')).not.toBeInTheDocument()
      expect(field('Months of commission')).toHaveValue('12')
      expect(screen.getByRole('switch', { name: 'Listed in the marketplace' })).toBeChecked()
    })

    it('saves what was typed, converted, and ticks the checklist as it goes', async () => {
      signedInAs('owner')
      const user = await openProgram(programState(null))
      answers({
        ...fake.state.table,
        workspace_program_save: programState(program({ revision: 1 })),
      })
      await user.type(field('Name'), 'SpeakSix')
      await user.selectOptions(field('Category'), 'Education')
      await user.type(field('One-line description'), 'Speak a new language in six weeks')
      await user.type(field('Landing page address'), 'https://speaksix.app')
      await user.type(field('Commission percent'), '30')

      expect(within(side()).getByText('30% of every payment for 12 months')).toBeInTheDocument()
      expect(within(form()).getByText('On a $50.00 sale a creator earns $15.00.')).toBeVisible()
      expect(within(form()).getByText('Unsaved changes')).toBeInTheDocument()
      expect(steps()).toEqual([
        'Done: Stripe connected',
        'Done: Product details',
        'Done: Landing page',
        'Done: Commission set',
        'To do: Read your agreement',
      ])
      expect(button('Read agreement')).toBeEnabled()
      expect(button('Publish program')).toBeDisabled()

      await user.click(button('Save'))
      expect(await screen.findByText('Draft saved')).toBeInTheDocument()
      expect(sent('save')).toEqual([
        {
          p_workspace_id: 'ws-1',
          p_input: {
            name: 'SpeakSix',
            category: 'education',
            tagline: 'Speak a new language in six weeks',
            landing_url: 'https://speaksix.app',
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
            marketplace_listed: true,
          },
        },
      ])
      expect(within(form()).getByText('All changes saved')).toBeInTheDocument()
      expect(button('Save')).toBeDisabled()
    })

    it('takes a fixed amount in normal money', async () => {
      signedInAs('owner')
      const user = await openProgram(programState(null))
      answers({
        ...fake.state.table,
        workspace_program_save: programState(
          program({
            name: null,
            category: null,
            tagline: null,
            landing_url: null,
            commission_type: 'fixed',
            commission_rate_bps: null,
            commission_fixed_minor: 1500,
            commission_duration: 'first_payment',
            commission_months: null,
          }),
        ),
      })
      await user.click(button('Fixed amount'))
      await user.type(field('Commission amount'), '15')
      await user.click(button('First payment'))
      expect(within(side()).getByText('$15.00 on the first payment')).toBeInTheDocument()
      expect(
        within(form()).getByText('A creator earns $15.00 on a sale of any size.'),
      ).toBeInTheDocument()
      await user.click(button('Save'))
      await screen.findByText('Draft saved')
      expect(sent('save')[0].p_input).toMatchObject({
        commission_type: 'fixed',
        commission_rate_bps: null,
        commission_fixed_minor: 1500,
        commission_duration: 'first_payment',
        commission_months: null,
      })
      expect(field('Commission amount')).toHaveValue('15.00')
    })

    it('sends people to connect Stripe before they can publish', async () => {
      signedInAs('owner')
      await openProgram(programState(null, { stripe_connected: false }))
      const link = within(side()).getByRole('link', { name: 'Connect Stripe' })
      expect(link).toHaveAttribute('href', '#connections')
      expect(steps()[0]).toBe('To do: Connect Stripe')
      const track = screen.getByRole('region', { name: 'Sale tracking' })
      expect(within(track).getByRole('link', { name: 'Connect Stripe' })).toHaveAttribute(
        'href',
        '#connections',
      )
      expect(within(track).getByText(/to start tracking sales\./)).toBeInTheDocument()
    })
  })

  describe('with a draft', () => {
    it('shows the saved program in normal units', async () => {
      signedInAs('owner')
      await openProgram(programState(program({ minimum_payout_minor: 5000 })))
      expect(field('Name')).toHaveValue('SpeakSix')
      expect(field('Category')).toHaveValue('education')
      expect(field('Commission percent')).toHaveValue('30')
      expect(
        within(screen.getByRole('region', { name: 'More options' })).getByText(
          '$50.00 minimum payout',
        ),
      ).toBeInTheDocument()
      expect(within(page()).getByText('Not published')).toBeInTheDocument()
      expect(within(form()).getByText('All changes saved')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
      expect(page().textContent).not.toMatch(/3000|2000|5000/)
    })

    it('shows a currency saved before programs paid in US dollars only, and keeps it', async () => {
      signedInAs('owner')
      const user = await openProgram(programState(program({ currency: 'EUR' })))
      await user.click(button('Change'))
      const currency = within(screen.getByRole('region', { name: 'More options' }))
        .getByText('Currency')
        .closest('div') as HTMLElement
      expect(currency).toHaveTextContent('EUR')
      expect(currency).toHaveTextContent('Kept from before programs paid in US dollars only.')
      expect(currency).not.toHaveTextContent('US dollars (USD)')
      answers({
        ...fake.state.table,
        workspace_program_save: programState(
          program({ revision: 4, currency: 'EUR', tagline: 'Six weeks' }),
        ),
      })
      await user.clear(field('One-line description'))
      await user.type(field('One-line description'), 'Six weeks')
      await user.click(button('Save'))
      await screen.findByText('Draft saved')
      expect(sent('save')).toEqual([
        { p_workspace_id: 'ws-1', p_input: { tagline: 'Six weeks', revision: 3 } },
      ])
    })

    it('sends only what changed, with the revision it was given', async () => {
      signedInAs('owner')
      const user = await openProgram()
      answers({
        ...fake.state.table,
        workspace_program_save: programState(program({ revision: 4, tagline: 'Six weeks' })),
      })
      await user.clear(field('One-line description'))
      await user.type(field('One-line description'), 'Six weeks')
      await user.click(button('Save'))
      await screen.findByText('Draft saved')
      expect(sent('save')).toEqual([
        { p_workspace_id: 'ws-1', p_input: { tagline: 'Six weeks', revision: 3 } },
      ])

      // The next save carries the revision the last answer brought.
      await user.type(field('One-line description'), '!')
      await user.click(button('Save'))
      await waitFor(() => expect(sent('save')).toHaveLength(2))
      expect(sent('save')[1].p_input).toEqual({ tagline: 'Six weeks!', revision: 4 })
    })

    it('puts back what was saved on discard', async () => {
      signedInAs('owner')
      const user = await openProgram()
      await user.type(field('Name'), ' Pro')
      expect(within(side()).getByText('SpeakSix Pro')).toBeInTheDocument()
      await user.click(button('Discard'))
      expect(field('Name')).toHaveValue('SpeakSix')
      expect(button('Save')).toBeDisabled()
      expect(sent('save')).toEqual([])
    })

    it('opens the options, and closes them to one line again', async () => {
      signedInAs('owner')
      const user = await openProgram()
      await user.click(button('Change'))
      expect(field('Attribution window')).toHaveFocus()
      await user.clear(field('Hold before payout'))
      await user.type(field('Hold before payout'), '0')
      await user.click(button('I approve each creator'))
      await user.click(screen.getByRole('switch', { name: 'Listed in the marketplace' }))
      await user.type(field('Extra terms (optional)'), 'No coupon sites.')
      await user.click(button('Hide options'))
      expect(button('Change')).toHaveFocus()
      expect(screen.queryByLabelText('Attribution window')).not.toBeInTheDocument()
      expect(
        within(screen.getByRole('region', { name: 'More options' }))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        '30-day attribution',
        'No hold',
        '$20.00 minimum payout',
        'You approve each creator',
        'Not listed in the marketplace',
        'Extra terms added',
      ])
    })

    it('marks what is wrong before asking the database', async () => {
      signedInAs('owner')
      const user = await openProgram()
      await user.clear(field('Landing page address'))
      await user.type(field('Landing page address'), 'speaksix.app')
      await user.clear(field('Commission percent'))
      await user.type(field('Commission percent'), '130')
      await user.click(button('Save'))
      const address = field('Landing page address')
      expect(address).toHaveAttribute('aria-invalid', 'true')
      expect(address).toHaveAccessibleDescription(fieldMessages.landingUrl)
      expect(address).toHaveFocus()
      expect(field('Commission percent')).toHaveAccessibleDescription(fieldMessages.amount)
      expect(within(form()).getByText('Fix the marked fields, then save.')).toBeInTheDocument()
      expect(sent('save')).toEqual([])

      // Fixing a field clears its message.
      await user.clear(address)
      await user.type(address, 'https://speaksix.app/go')
      expect(address).not.toHaveAttribute('aria-invalid')
    })

    it('opens the options when the mistake is in there', async () => {
      signedInAs('owner')
      const user = await openProgram()
      await user.click(button('Change'))
      await user.clear(field('Attribution window'))
      await user.type(field('Attribution window'), '0')
      await user.click(button('Hide options'))
      await user.click(button('Save'))
      expect(field('Attribution window')).toHaveAccessibleDescription(fieldMessages.attributionDays)
      expect(field('Attribution window')).toHaveFocus()
      expect(sent('save')).toEqual([])
    })

    it('puts a refusal from the database at its field', async () => {
      signedInAs('owner')
      const user = await openProgram()
      answers({ ...fake.state.table, workspace_program_save: refuse('invalid_landing_url') })
      await user.type(field('Landing page address'), '/start')
      await user.click(button('Save'))
      await waitFor(() =>
        expect(field('Landing page address')).toHaveAccessibleDescription(fieldMessages.landingUrl),
      )
      // What was typed is kept.
      expect(field('Landing page address')).toHaveValue('https://speaksix.app/start')
      expect(screen.queryByText('Draft saved')).not.toBeInTheDocument()
    })

    it('shows the latest version when the program changed somewhere else', async () => {
      signedInAs('owner')
      let current = programState()
      const user = await openProgram(() => current)
      answers({
        ...fake.state.table,
        workspace_program_save: refuse('program_changed', '40001'),
      })
      current = programState(program({ revision: 7, name: 'SpeakSix Pro' }))
      await user.type(field('One-line description'), '!')
      await user.click(button('Save'))
      expect(
        await screen.findByText(
          'This program was changed somewhere else. You are now seeing the latest version.',
        ),
      ).toBeInTheDocument()
      expect(field('Name')).toHaveValue('SpeakSix Pro')
      expect(sent('get')).toHaveLength(2)

      // The next save uses the revision that was just read.
      answers({ ...fake.state.table, workspace_program_save: current })
      await user.type(field('One-line description'), '!')
      await user.click(button('Save'))
      await waitFor(() => expect(sent('save')).toHaveLength(2))
      expect(sent('save')[1].p_input).toMatchObject({ revision: 7 })
    })

    it('says a save did not happen and offers it again', async () => {
      signedInAs('owner')
      const user = await openProgram()
      let down = true
      answers({
        ...fake.state.table,
        workspace_program_save: () =>
          down ? new Error('TypeError: Failed to fetch') : programState(program({ revision: 4 })),
      })
      await user.type(field('One-line description'), '!')
      await user.click(button('Save'))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'KissMyApps could not be reached. Check your connection and try again.',
      )
      expect(field('One-line description')).toHaveValue('Speak a new language in six weeks!')
      down = false
      await user.click(button('Retry'))
      expect(await screen.findByText('Draft saved')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('turns read-only when the database says this person may not change it', async () => {
      signedInAs('owner')
      const user = await openProgram()
      answers({ ...fake.state.table, workspace_program_save: refuse(null, '42501') })
      await user.type(field('One-line description'), '!')
      await user.click(button('Save'))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Only an owner or admin can change the program. Ask one of them to do this.',
      )
      expect(field('Name')).toBeDisabled()
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    })
  })

  describe('the agreement', () => {
    it('is saved for, read to the end, marked as read, and then the program is published', async () => {
      signedInAs('owner')
      const user = await openProgram()
      answers({
        ...fake.state.table,
        workspace_program_save: programState(program({ revision: 4, hold_days: 14 })),
        workspace_program_agreement: agreement(),
        workspace_program_mark_agreement_read: programState(
          program({ revision: 5, hold_days: 14, agreement_read: true }),
        ),
        workspace_program_submit: programState(
          program({
            revision: 6,
            hold_days: 14,
            agreement_read: true,
            status: 'in_review',
            submitted_at: '2026-11-13T12:34:21.550058+00:00',
          }),
        ),
      })
      expect(button('Publish program')).toBeDisabled()
      expect(
        within(side()).getByText('Publish unlocks once you have read the agreement.'),
      ).toBeInTheDocument()

      // An unsaved change to the terms is saved first, because the agreement is written from it.
      await user.click(button('Change'))
      await user.clear(field('Hold before payout'))
      await user.type(field('Hold before payout'), '14')
      await user.click(button('Read agreement'))

      const dialog = await screen.findByRole('dialog', { name: 'SpeakSix affiliate agreement' })
      expect(sent('save')).toEqual([
        { p_workspace_id: 'ws-1', p_input: { hold_days: 14, revision: 3 } },
      ])
      expect(sent('agreement')).toEqual([{ p_workspace_id: 'ws-1' }])
      expect(within(dialog).getByText('30% of every payment for 12 months')).toBeInTheDocument()
      expect(within(dialog).getAllByRole('heading', { level: 3 })).toHaveLength(11)
      expect(within(dialog).getByText('Paragraph one of section 11.')).toBeInTheDocument()

      const confirm = within(dialog).getByRole('button', { name: 'I have read this' })
      expect(confirm).toBeDisabled()
      expect(within(dialog).getByText('Scroll to the end to continue.')).toBeInTheDocument()
      fireEvent.scroll(dialog.querySelector('.mc-prog-doc-body') as HTMLElement)
      expect(within(dialog).getByText('That is the whole agreement.')).toBeInTheDocument()
      expect(confirm).toBeEnabled()

      await user.click(confirm)
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(sent('mark_agreement_read')).toEqual([{ p_workspace_id: 'ws-1', p_sha256: SHA }])
      expect(
        await within(document.querySelector('.mc-toasts') as HTMLElement).findByText(
          'Agreement read',
        ),
      ).toBeInTheDocument()
      expect(steps()[4]).toBe('Done: Agreement read')
      expect(
        within(side()).getByText(
          'KissMyApps reviews your first listing once, usually within a day.',
        ),
      ).toBeInTheDocument()

      // Marking it read moved the revision on; publishing sends the new one.
      await user.click(button('Publish program'))
      expect(await screen.findByText('Sent for review')).toBeInTheDocument()
      expect(sent('submit')).toEqual([{ p_workspace_id: 'ws-1', p_revision: 5 }])
      expect(
        within(page()).getByText('In review', { selector: '.mc-pill, .mc-pill *' }),
      ).toBeTruthy()
      expect(
        within(page()).getByText('We are reviewing your listing. This usually takes a day.'),
      ).toBeInTheDocument()
      expect(within(side()).getByText('Sent on 13 Nov 2026.')).toBeInTheDocument()
    })

    it('prints extra terms straight after the last section, with no heading of its own', async () => {
      signedInAs('owner')
      const user = await openProgram(programState(program({ extra_terms: 'No coupon sites.' })))
      answers({
        ...fake.state.table,
        workspace_program_agreement: agreement('No coupon sites.\nNo paid search on our name.'),
      })
      await user.click(button('Read agreement'))
      const dialog = await screen.findByRole('dialog')
      const headings = within(dialog).getAllByRole('heading', { level: 3 })
      expect(headings).toHaveLength(12)
      expect(headings[11]).toHaveTextContent('12. Additional terms from SpeakSix Ltd')
      const extra = within(dialog).getByText(/No coupon sites\./)
      expect(extra).toHaveTextContent('No paid search on our name.')
      const last = headings[11].closest('section') as HTMLElement
      expect(last.nextElementSibling).toBe(extra)
      // Nothing was edited, so nothing was saved first.
      expect(sent('save')).toEqual([])
    })

    it('can be opened without a category or a description', async () => {
      signedInAs('owner')
      const user = await openProgram(programState(program({ category: null, tagline: null })))
      answers({ ...fake.state.table, workspace_program_agreement: agreement() })
      expect(steps()[1]).toBe('To do: Product details')
      expect(
        within(side()).getByText('Add a category and a one-line description to publish.'),
      ).toBeInTheDocument()
      expect(button('Publish program')).toBeDisabled()
      await user.click(button('Read agreement'))
      expect(await screen.findByRole('dialog')).toBeInTheDocument()
    })

    it('does not open when the form has a mistake', async () => {
      signedInAs('owner')
      const user = await openProgram()
      await user.clear(field('Commission percent'))
      await user.type(field('Commission percent'), '12.345')
      expect(button('Read agreement')).toBeDisabled()
      await user.clear(field('Commission percent'))
      await user.type(field('Commission percent'), '25')
      await user.type(field('Name'), 'x'.repeat(10))
      answers({ ...fake.state.table, workspace_program_save: refuse('invalid_name') })
      await user.click(button('Read agreement'))
      await waitFor(() => expect(field('Name')).toHaveAttribute('aria-invalid', 'true'))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(sent('agreement')).toEqual([])
    })

    it('says so when the database has no agreement to show yet', async () => {
      signedInAs('owner')
      const user = await openProgram()
      answers({
        ...fake.state.table,
        workspace_program_agreement: { agreement: null, sha256: null, complete: false },
      })
      await user.click(button('Read agreement'))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Fill in the product, landing page and commission before you publish.',
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('offers to try again when it cannot be opened', async () => {
      signedInAs('owner')
      const user = await openProgram()
      let broken = true
      answers({
        ...fake.state.table,
        workspace_program_agreement: () => (broken ? refuse(null, 'XX000') : agreement()),
      })
      await user.click(button('Read agreement'))
      const dialog = await screen.findByRole('dialog', { name: 'Your agreement' })
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'The agreement could not be opened. Try again.',
      )
      broken = false
      await user.click(within(dialog).getByRole('button', { name: 'Retry' }))
      expect(
        await screen.findByRole('dialog', { name: 'SpeakSix affiliate agreement' }),
      ).toBeInTheDocument()
    })

    it('shows the latest agreement when the terms changed while it was open', async () => {
      signedInAs('owner')
      const user = await openProgram()
      answers({
        ...fake.state.table,
        workspace_program_agreement: agreement(),
        workspace_program_mark_agreement_read: refuse('agreement_not_read'),
      })
      await user.click(button('Read agreement'))
      const dialog = await screen.findByRole('dialog')
      fireEvent.scroll(dialog.querySelector('.mc-prog-doc-body') as HTMLElement)
      await user.click(within(dialog).getByRole('button', { name: 'I have read this' }))
      expect(
        await screen.findByText(
          'The terms changed while this was open. This is the latest agreement.',
        ),
      ).toBeInTheDocument()
      expect(sent('agreement')).toHaveLength(2)
      expect(sent('get')).toHaveLength(2)
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('asks for the agreement to be read again after the terms are edited', async () => {
      signedInAs('owner')
      const user = await openProgram(programState(program({ agreement_read: true })))
      expect(button('Publish program')).toBeEnabled()
      await user.clear(field('Commission percent'))
      await user.type(field('Commission percent'), '25')
      expect(steps()[4]).toBe('To do: Read your agreement')
      expect(button('Publish program')).toBeDisabled()
      // A change to the card alone leaves the agreement as it was.
      await user.click(button('Discard'))
      await user.type(field('One-line description'), '!')
      expect(steps()[4]).toBe('Done: Agreement read')
    })

    it('is read-only for someone who cannot manage the program', async () => {
      signedInAs('analyst')
      const user = await openProgram(programState(live(), { can_manage: false }))
      answers({ ...fake.state.table, workspace_program_agreement: agreement() })
      await user.click(button('Read agreement'))
      const dialog = await screen.findByRole('dialog')
      expect(
        within(dialog).queryByRole('button', { name: 'I have read this' }),
      ).not.toBeInTheDocument()
      await user.click(within(dialog).getByText('Close'))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(sent('mark_agreement_read')).toEqual([])
    })
  })

  describe('publishing', () => {
    const ready = () => programState(program({ agreement_read: true }))

    it('saves unsaved card edits first, then sends the program for review', async () => {
      signedInAs('owner')
      const user = await openProgram(ready())
      answers({
        ...fake.state.table,
        workspace_program_save: programState(
          program({ revision: 4, agreement_read: true, tagline: 'Six weeks to fluent' }),
        ),
        workspace_program_submit: programState(
          program({ revision: 5, agreement_read: true, status: 'in_review' }),
        ),
      })
      await user.clear(field('One-line description'))
      await user.type(field('One-line description'), 'Six weeks to fluent')
      await user.click(button('Publish program'))
      expect(await screen.findByText('Sent for review')).toBeInTheDocument()
      expect(sent('save')[0].p_input).toEqual({ tagline: 'Six weeks to fluent', revision: 3 })
      expect(sent('submit')).toEqual([{ p_workspace_id: 'ws-1', p_revision: 4 }])
    })

    it('points to Connections when Stripe is not connected after all', async () => {
      signedInAs('owner')
      const user = await openProgram(ready())
      answers({ ...fake.state.table, workspace_program_submit: refuse('stripe_not_connected') })
      await user.click(button('Publish program'))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('Connect Stripe first, so sales can be tracked.')
      expect(within(alert).getByRole('link', { name: 'Connect Stripe' })).toHaveAttribute(
        'href',
        '#connections',
      )
    })

    it('asks for the agreement again when it changed since it was read', async () => {
      signedInAs('owner')
      const user = await openProgram(ready())
      answers({ ...fake.state.table, workspace_program_submit: refuse('agreement_not_read') })
      await user.click(button('Publish program'))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The agreement has changed. Read it again before you publish.',
      )
    })

    it('keeps the button off until Stripe is connected', async () => {
      signedInAs('owner')
      await openProgram(
        programState(program({ agreement_read: true }), { stripe_connected: false }),
      )
      expect(button('Publish program')).toBeDisabled()
      expect(within(side()).getByText('Connect Stripe to publish.')).toBeInTheDocument()
    })

    it('says what did not happen when the request never arrived, and retries', async () => {
      signedInAs('owner')
      const user = await openProgram(ready())
      let down = true
      answers({
        ...fake.state.table,
        workspace_program_submit: () =>
          down
            ? refuse(null, 'XX000')
            : programState(program({ revision: 4, agreement_read: true, status: 'in_review' })),
      })
      await user.click(button('Publish program'))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The program was not published. Try again.',
      )
      down = false
      await user.click(button('Retry'))
      expect(await screen.findByText('Sent for review')).toBeInTheDocument()
    })
  })

  describe('in review', () => {
    const reviewing = () =>
      programState(
        program({
          status: 'in_review',
          agreement_read: true,
          submitted_at: '2026-11-12T08:00:00.120000+00:00',
        }),
      )

    it('says so and cannot be edited', async () => {
      signedInAs('owner')
      await openProgram(reviewing())
      expect(within(page()).getAllByText('In review').length).toBeGreaterThan(0)
      expect(
        within(page()).getByText('We are reviewing your listing. This usually takes a day.'),
      ).toBeInTheDocument()
      expect(field('Name')).toBeDisabled()
      expect(field('Category')).toBeDisabled()
      expect(field('Commission percent')).toBeDisabled()
      expect(button('Percent')).toBeDisabled()
      expect(button('Change')).toBeDisabled()
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument()
      expect(within(side()).getByText('Sent on 12 Nov 2026.')).toBeInTheDocument()
      expect(button('Read agreement')).toBeEnabled()
    })

    it('shows the agreement without asking for it to be read again', async () => {
      signedInAs('owner')
      const user = await openProgram(reviewing())
      answers({ ...fake.state.table, workspace_program_agreement: agreement() })
      await user.click(button('Read agreement'))
      const dialog = await screen.findByRole('dialog')
      expect(
        within(dialog).queryByRole('button', { name: 'I have read this' }),
      ).not.toBeInTheDocument()
      expect(within(dialog).getByText('Close')).toBeInTheDocument()
    })
  })

  it('shows what KissMyApps asked for when changes are requested', async () => {
    signedInAs('owner')
    await openProgram(
      programState(
        program({
          status: 'changes_requested',
          review_note: 'The landing page does not mention the product yet.',
        }),
      ),
    )
    expect(within(page()).getByText('Changes requested')).toBeInTheDocument()
    expect(
      within(page()).getByText('KissMyApps asked for changes before this can go live.'),
    ).toBeInTheDocument()
    expect(
      within(page()).getByText('The landing page does not mention the product yet.'),
    ).toBeInTheDocument()
    expect(field('Name')).toBeEnabled()
    expect(within(side()).getByRole('heading', { name: 'Ready to publish' })).toBeInTheDocument()
    expect(button('Publish program')).toBeInTheDocument()
  })

  describe('live', () => {
    it('shows the live program and pauses it', async () => {
      signedInAs('owner')
      const user = await openProgram(programState(live()))
      answers({
        ...fake.state.table,
        workspace_program_set_status: programState(
          live({ status: 'paused', pause_reason: 'merchant', revision: 10 }),
        ),
      })
      expect(within(page()).getByText('Live')).toBeInTheDocument()
      expect(within(side()).getByRole('heading', { name: 'Published' })).toBeInTheDocument()
      expect(within(side()).getByText('Live since 1 Nov 2026.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument()
      expect(field('Name')).toBeEnabled()

      await user.click(button('Pause'))
      expect(await screen.findByText('Program paused')).toBeInTheDocument()
      expect(sent('set_status')).toEqual([
        { p_workspace_id: 'ws-1', p_status: 'paused', p_revision: 9 },
      ])
      expect(within(page()).getByText('Paused')).toBeInTheDocument()
      expect(button('Resume')).toBeInTheDocument()
    })

    it('offers to publish changes that are waiting', async () => {
      signedInAs('owner')
      const user = await openProgram(
        programState(
          live({ has_unpublished_changes: true, agreement_read: true, commission_rate_bps: 2500 }),
        ),
      )
      answers({
        ...fake.state.table,
        workspace_program_submit: programState(live({ revision: 10, commission_rate_bps: 2500 })),
      })
      expect(
        within(side()).getByRole('heading', { name: 'Changes to publish' }),
      ).toBeInTheDocument()
      expect(
        within(side()).getByText(
          'Creators keep the terms you last published until you publish these changes.',
        ),
      ).toBeInTheDocument()
      await user.click(button('Publish changes'))
      expect(await screen.findByText('Changes published')).toBeInTheDocument()
      expect(sent('submit')).toEqual([{ p_workspace_id: 'ws-1', p_revision: 9 }])
      expect(within(side()).getByRole('heading', { name: 'Published' })).toBeInTheDocument()
      expect(within(page()).getByText('Live')).toBeInTheDocument()
    })

    it('wants the updated agreement read before changes are published', async () => {
      signedInAs('owner')
      const user = await openProgram(programState(live()))
      // Renaming applies at once and reopens the agreement.
      answers({
        ...fake.state.table,
        workspace_program_save: programState(
          live({
            revision: 10,
            name: 'SpeakSix Pro',
            has_unpublished_changes: true,
            agreement_read: false,
          }),
        ),
      })
      await user.type(field('Name'), ' Pro')
      expect(
        within(side()).getByRole('heading', { name: 'Changes to publish' }),
      ).toBeInTheDocument()
      expect(button('Publish changes')).toBeDisabled()
      await user.click(button('Save'))
      expect(await screen.findByText('Changes saved')).toBeInTheDocument()
      expect(sent('save')[0].p_input).toEqual({ name: 'SpeakSix Pro', revision: 9 })
      expect(button('Publish changes')).toBeDisabled()
      expect(
        within(side()).getByText('Publish unlocks once you have read the updated agreement.'),
      ).toBeInTheDocument()
    })

    it('applies card edits without anything to publish', async () => {
      signedInAs('owner')
      const user = await openProgram(programState(live()))
      answers({
        ...fake.state.table,
        workspace_program_save: programState(live({ revision: 10, category: 'productivity' })),
      })
      await user.selectOptions(field('Category'), 'Productivity')
      expect(within(side()).getByRole('heading', { name: 'Published' })).toBeInTheDocument()
      await user.click(button('Save'))
      expect(await screen.findByText('Changes saved')).toBeInTheDocument()
      expect(sent('save')[0].p_input).toEqual({ category: 'productivity', revision: 9 })
      expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument()
    })

    it('does not let the main fields be emptied', async () => {
      signedInAs('owner')
      const user = await openProgram(programState(live()))
      await user.clear(field('Name'))
      await user.clear(field('Commission percent'))
      await user.click(button('Save'))
      expect(field('Name')).toHaveAccessibleDescription(fieldMessages.name)
      expect(field('Commission percent')).toHaveAccessibleDescription(fieldMessages.amount)
      expect(sent('save')).toEqual([])
    })

    it('reads the program again when it cannot be paused in its state', async () => {
      signedInAs('owner')
      let current = programState(live())
      const user = await openProgram(() => current)
      answers({ ...fake.state.table, workspace_program_set_status: refuse('status_not_allowed') })
      current = programState(live({ status: 'paused', pause_reason: 'admin', revision: 11 }))
      await user.click(button('Pause'))
      expect(
        await screen.findByText('That is not possible while the program is in this state.'),
      ).toBeInTheDocument()
      expect(within(page()).getByText('Paused')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    })
  })

  describe('paused', () => {
    it('by the business: says so and resumes', async () => {
      signedInAs('owner')
      const user = await openProgram(
        programState(live({ status: 'paused', pause_reason: 'merchant' })),
      )
      answers({
        ...fake.state.table,
        workspace_program_set_status: programState(live({ revision: 10 })),
      })
      expect(within(page()).getByText('Paused')).toBeInTheDocument()
      expect(
        within(page()).getByText('You paused this program. Resume it when you are ready.'),
      ).toBeInTheDocument()
      expect(within(side()).getByText('First published 1 Nov 2026.')).toBeInTheDocument()
      await user.click(button('Resume'))
      expect(await screen.findByText('Program is live again')).toBeInTheDocument()
      expect(sent('set_status')).toEqual([
        { p_workspace_id: 'ws-1', p_status: 'live', p_revision: 9 },
      ])
      expect(within(page()).getByText('Live')).toBeInTheDocument()
      expect(button('Pause')).toBeInTheDocument()
    })

    it('because Stripe was disconnected: links to Connections, with nothing to resume', async () => {
      signedInAs('owner')
      await openProgram(
        programState(live({ status: 'paused', pause_reason: 'stripe_disconnected' }), {
          stripe_connected: false,
        }),
      )
      const banner = within(page())
        .getByText(/This program is paused because Stripe was disconnected\./)
        .closest('[role="status"]') as HTMLElement
      expect(within(banner).getByRole('link', { name: 'Connect Stripe' })).toHaveAttribute(
        'href',
        '#connections',
      )
      expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    })

    it('because Stripe was disconnected: can be resumed once Stripe is back', async () => {
      signedInAs('owner')
      await openProgram(
        programState(live({ status: 'paused', pause_reason: 'stripe_disconnected' })),
      )
      expect(
        within(page()).getByText(/Stripe is connected again, so you can resume it\./),
      ).toBeInTheDocument()
      expect(button('Resume')).toBeEnabled()
    })

    it('by KissMyApps: shows the note and cannot be resumed from here', async () => {
      signedInAs('owner')
      await openProgram(
        programState(
          live({
            status: 'paused',
            pause_reason: 'admin',
            review_note: 'Several creators reported unpaid commissions.',
          }),
        ),
      )
      expect(within(page()).getByText('KissMyApps paused this program.')).toBeInTheDocument()
      expect(
        within(page()).getByText('Several creators reported unpaid commissions.'),
      ).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    })

    it('says why a resume was refused', async () => {
      signedInAs('owner')
      const user = await openProgram(
        programState(live({ status: 'paused', pause_reason: 'merchant' })),
      )
      answers({
        ...fake.state.table,
        workspace_program_set_status: refuse('program_paused_by_admin'),
      })
      await user.click(button('Resume'))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'KissMyApps paused this program, so it cannot be resumed from here. Contact us.',
      )
    })
  })

  describe('for a member who cannot manage it', () => {
    it('is read-only', async () => {
      signedInAs('analyst')
      await openProgram(programState(live(), { can_manage: false }))
      expect(
        within(page()).getByText(
          'Only an owner or admin of No Brainer Lab can change the program.',
        ),
      ).toBeInTheDocument()
      expect(field('Name')).toBeDisabled()
      expect(field('Name')).toHaveValue('SpeakSix')
      expect(field('Landing page address')).toBeDisabled()
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument()
      expect(within(page()).getByText('Live')).toBeInTheDocument()
      expect(button('Read agreement')).toBeEnabled()
    })

    it('says there is no program yet instead of an empty form', async () => {
      signedInAs('analyst')
      await openProgram(programState(null, { can_manage: false }))
      expect(
        within(page()).getByText(
          'No Brainer Lab has no affiliate program yet. An owner or admin can set one up here.',
        ),
      ).toBeInTheDocument()
      expect(screen.queryByRole('form', { name: 'Program details' })).not.toBeInTheDocument()
    })
  })

  describe('the logo', () => {
    const choose = (file: File) =>
      fireEvent.change(screen.getByLabelText('Logo file'), { target: { files: [file] } })
    const png = (size = 2048) => {
      const file = new File(['x'], 'logo.png', { type: 'image/png' })
      Object.defineProperty(file, 'size', { value: size })
      return file
    }

    it('refuses a file that is not an image it takes, before uploading anything', async () => {
      signedInAs('owner')
      await openProgram()
      choose(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }))
      expect(await screen.findByText('Choose a PNG, JPG or WebP image.')).toBeInTheDocument()
      choose(png(LOGO_MAX_BYTES + 1))
      expect(
        await screen.findByText('That image is larger than 2 MB. Choose a smaller one.'),
      ).toBeInTheDocument()
      expect(fake.state.uploads).toEqual([])
      expect(button('Upload logo')).toBeInTheDocument()
    })

    it("uploads into the workspace's folder and saves the path with the form", async () => {
      signedInAs('owner')
      const user = await openProgram()
      choose(png())
      expect(await screen.findByRole('button', { name: 'Replace logo' })).toBeInTheDocument()
      expect(fake.state.uploads).toHaveLength(1)
      const upload = fake.state.uploads[0]
      expect(upload.bucket).toBe('program-logos')
      expect(upload.path).toMatch(/^ws-1\/[A-Za-z0-9-]+\.png$/)
      expect(upload.options).toMatchObject({ contentType: 'image/png', upsert: false })
      const shown = page().querySelector('img.mc-prog-logo') as HTMLImageElement
      expect(shown.src).toBe(`https://files.example/program-logos/${upload.path}`)

      answers({
        ...fake.state.table,
        workspace_program_save: programState(program({ revision: 4, logo_path: upload.path })),
      })
      await user.click(button('Save'))
      await screen.findByText('Draft saved')
      expect(sent('save')[0].p_input).toEqual({ logo_path: upload.path, revision: 3 })
    })

    it('says when the upload did not work', async () => {
      signedInAs('owner')
      await openProgram()
      fake.state.uploadFails = true
      choose(new File(['x'], 'logo.webp', { type: 'image/webp' }))
      expect(
        await screen.findByText('The logo could not be uploaded. Try again.'),
      ).toBeInTheDocument()
      expect(fake.state.uploads[0].path).toMatch(/\.webp$/)
      expect(button('Upload logo')).toBeEnabled()
    })
  })

  describe('sale tracking', () => {
    const track = () => screen.getByRole('region', { name: 'Sale tracking' })

    it('shows how to pass the click ID to Stripe', async () => {
      signedInAs('owner')
      await openProgram()
      expect(within(track()).getByLabelText('Pass the click ID to Stripe')).toHaveTextContent(
        'const clickId = kma.getClickId()',
      )
      expect(within(track()).getByLabelText('Pass the click ID to Stripe')).toHaveTextContent(
        'metadata: { kma_click: clickId }',
      )
      expect(within(track()).getByText(trackingSnippetNote)).toBeInTheDocument()
      await waitFor(() => expect(sent('tracking')).toEqual([{ p_workspace_id: 'ws-1' }]))
      expect(await within(track()).findByText('Waiting for your first payment.')).toBeVisible()
    })

    it('says when payments arrive without the tag', async () => {
      signedInAs('owner')
      answers({ workspace_program_tracking: tracking({ payments_seen: 3 }) })
      await openProgram()
      expect(
        await within(track()).findByText('3 payments seen, none tagged yet.'),
      ).toBeInTheDocument()
    })

    it('says when the last tagged sale came in', async () => {
      signedInAs('owner')
      answers({
        workspace_program_tracking: tracking({
          payments_seen: 12,
          tagged_payments: 5,
          sales: 5,
          matched_sales: 5,
          last_matched_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        }),
      })
      await openProgram()
      expect(await within(track()).findByText('Last tagged sale 3 h ago')).toBeInTheDocument()
    })

    it('offers a retry when the status could not be loaded', async () => {
      signedInAs('owner')
      let broken = true
      answers({
        workspace_program_tracking: () => (broken ? refuse(null, 'XX000') : tracking()),
      })
      const user = await openProgram()
      expect(
        await within(track()).findByText('The tracking status could not be loaded.'),
      ).toBeInTheDocument()
      broken = false
      await user.click(within(track()).getByRole('button', { name: 'Retry' }))
      expect(
        await within(track()).findByText('Waiting for your first payment.'),
      ).toBeInTheDocument()
    })
  })

  it('never shows database words, test-mode words or em-dashes', async () => {
    signedInAs('owner')
    const user = await openProgram(
      programState(live({ has_unpublished_changes: true, minimum_payout_minor: 2500 })),
    )
    answers({ ...fake.state.table, workspace_program_agreement: agreement('No coupon sites.') })
    await user.click(button('Change'))
    const shown = () => `${page().textContent} ${screen.queryByRole('dialog')?.textContent ?? ''}`
    const clean = (text: string) => {
      expect(text).not.toMatch(/bps|minor unit|revision|funnel|terms version|slug/i)
      expect(text).not.toMatch(/test mode|test account|sandbox|livemode/i)
      expect(text).not.toMatch(/[—–]/)
      // Money is shown in normal units: never the stored 2500 or 3000.
      expect(text).not.toMatch(/2500|3000/)
    }
    clean(shown())
    await user.click(button('Read agreement'))
    await screen.findByRole('dialog')
    clean(shown())
  })
})
