import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PublicMarketplace } from './PublicMarketplace'
import type { PublicMarketplaceApi } from './PublicMarketplace'
import {
  MarketplaceUnreadable,
  categoriesPresent,
  filterPrograms,
  programHeadline,
  programInitials,
  programLogoUrl,
  programRewardLine,
  programRewardsLine,
  programTermsLine,
  readProgram,
  readProgramDetail,
  readProgramList,
  sectionParts,
} from './model'
import type { MarketplaceProgram } from './model'
import { loadMarketplaceProgram, loadMarketplacePrograms } from './publicApi'
import {
  isMarketplacePath,
  isProgramSlug,
  marketplaceHash,
  marketplacePath,
  marketplaceRouteFromPath,
  partnerAppOrigin,
  partnerAppUrl,
  programSlugFromHash,
} from './routing'

const SHA = 'a'.repeat(64)

/** A `ProgramCard` exactly as the backend sends it. */
const speaksix = {
  slug: 'speaksix',
  name: 'SpeakSix',
  category: 'education',
  tagline: 'Speak English with confidence in six weeks.',
  logo_path: 'ws-1/logo.png',
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

const fieldnote = {
  ...speaksix,
  slug: 'fieldnote',
  name: 'Fieldnote',
  category: 'productivity',
  tagline: 'Voice notes that turn into tidy meeting minutes.',
  logo_path: null,
  brand_name: 'Fieldnote GmbH',
  commission_type: 'fixed',
  commission_rate_bps: null,
  commission_fixed_minor: 800,
  commission_duration: 'first_payment',
  commission_months: null,
  attribution_window_days: 60,
  hold_days: 0,
  approval_mode: 'manual',
}

const agreement = {
  title: 'SpeakSix Affiliate Agreement',
  brand_name: 'SpeakSix Ltd',
  program_name: 'SpeakSix',
  summary: [
    { label: 'Commission', value: '30% of every payment for 12 months' },
    { label: 'Attribution window', value: '30 days' },
    { label: 'Hold before payout', value: '30 days' },
    { label: 'Minimum payout', value: '$20.00' },
  ],
  sections: [
    {
      heading: '1. Who this agreement is between',
      paragraphs: ['This agreement is between you, the creator, and SpeakSix Ltd.'],
    },
    { heading: '2. Commission', paragraphs: ['You earn 30% of every payment.'] },
  ],
  extra_terms: null,
}

const detail = {
  ...speaksix,
  status: 'live',
  landing_url: 'https://speaksix.com/start',
  agreement,
  agreement_sha256: SHA,
}

const signup = { key: 'signup_completed', label: 'Account created', amount_minor: 200 }
const trial = { key: 'trial_started', label: 'Trial started', amount_minor: 500 }

/** A sales program as the backend sends it now that a program can pay for events. */
const speaksixNow = { ...speaksix, earn_from: 'sales', rewards: [] }

/** A program that pays for events only: no commission at all. */
const fluent = {
  ...speaksix,
  slug: 'fluent',
  name: 'Fluent',
  tagline: 'Five minutes of Spanish a day.',
  logo_path: null,
  brand_name: 'Fluent Labs',
  commission_type: null,
  commission_rate_bps: null,
  commission_fixed_minor: null,
  commission_duration: null,
  commission_months: null,
  approval_mode: 'manual',
  earn_from: 'events',
  rewards: [signup, trial],
}

/** A program that pays a commission and one reward. */
const pocketChef = {
  ...speaksix,
  slug: 'pocket-chef',
  name: 'Pocket Chef',
  category: 'food_drink',
  tagline: 'Dinner planned in the time it takes to boil water.',
  logo_path: null,
  brand_name: 'Pocket Chef Inc',
  earn_from: 'both',
  rewards: [signup],
}

function programs(...rows: unknown[]): MarketplaceProgram[] {
  return readProgramList({ programs: rows })
}

describe('reading marketplace answers', () => {
  it('reads a card and keeps every field the page shows', () => {
    expect(readProgram(speaksix)).toEqual({
      ...speaksix,
      earn_from: 'sales',
      rewards: [],
      membership_status: null,
    })
  })

  it('reads an answer from before programs could pay for events as a sales program', () => {
    expect(readProgram(speaksix)).toMatchObject({ earn_from: 'sales', rewards: [] })
    expect(readProgram({ ...speaksix, earn_from: null, rewards: null })).toMatchObject({
      earn_from: 'sales',
      rewards: [],
    })
    expect(readProgram(speaksixNow)).toEqual(readProgram(speaksix))
  })

  it('reads a program that pays for events, and one that pays for both', () => {
    expect(readProgram(fluent)).toMatchObject({
      commission_type: null,
      earn_from: 'events',
      rewards: [signup, trial],
    })
    expect(readProgram(pocketChef)).toMatchObject({
      commission_type: 'percent',
      earn_from: 'both',
      rewards: [signup],
    })
  })

  it('keeps only the three fields of a reward and tidies its label', () => {
    const read = readProgram({
      ...fluent,
      rewards: [{ ...signup, label: '  Account created ', person_id: 'p-1', count: 41 }],
    })
    expect(read?.rewards).toEqual([signup])
  })

  it.each([
    ['a commission is missing from a sales program', { ...speaksixNow, commission_type: null }],
    [
      'a commission is missing from a program that pays for both',
      { ...pocketChef, commission_type: null },
    ],
    ['an events program has a commission', { ...fluent, commission_type: 'percent' }],
    [
      'an events program has a commission type the page does not know',
      { ...fluent, commission_type: 'tiered' },
    ],
    ['an events program has no reward', { ...fluent, rewards: [] }],
    ['a program that pays for both has no reward', { ...pocketChef, rewards: [] }],
    ['a sales program has a reward', { ...speaksixNow, rewards: [signup] }],
    ['it earns from something the page does not know', { ...fluent, earn_from: 'installs' }],
    ['only one of the two keys is there', { ...speaksix, earn_from: 'sales' }],
    ['the rewards are not a list', { ...fluent, rewards: { 0: signup } }],
    [
      'there are more than five rewards',
      {
        ...fluent,
        rewards: Array.from({ length: 6 }, (_, index) => ({ ...signup, key: `event_${index}` })),
      },
    ],
    ['a reward is not an object', { ...fluent, rewards: ['signup_completed'] }],
    [
      'a reward has no event name',
      { ...fluent, rewards: [{ label: 'Account created', amount_minor: 200 }] },
    ],
    [
      'a reward has an event name that cannot be one',
      { ...fluent, rewards: [{ ...signup, key: '9 lives' }] },
    ],
    [
      'two rewards are for the same event',
      { ...fluent, rewards: [signup, { ...trial, key: signup.key }] },
    ],
    ['a reward has an empty label', { ...fluent, rewards: [{ ...signup, label: '   ' }] }],
    [
      'a reward has a label longer than 40 characters',
      { ...fluent, rewards: [{ ...signup, label: 'a'.repeat(41) }] },
    ],
    ['a reward pays nothing', { ...fluent, rewards: [{ ...signup, amount_minor: 0 }] }],
    [
      'a reward pays a fraction of a cent',
      { ...fluent, rewards: [{ ...signup, amount_minor: 199.5 }] },
    ],
    ['a reward amount is text', { ...fluent, rewards: [{ ...signup, amount_minor: '200' }] }],
    [
      'a reward pays more than the most a reward can',
      { ...fluent, rewards: [{ ...signup, amount_minor: 100_000_001 }] },
    ],
  ])('refuses a card when %s', (_name, row) => {
    expect(readProgram(row)).toBeNull()
    expect(programs(speaksix, row).map((program) => program.slug)).toEqual(['speaksix'])
    expect(() => readProgramDetail({ ...detail, ...row })).toThrow(MarketplaceUnreadable)
  })

  it('reads a reward at the limits: five of them, a 40-character label, the largest amount', () => {
    const rewards = Array.from({ length: 5 }, (_, index) => ({
      key: `step.${index}:done-ok_`,
      label: 'é'.repeat(40),
      amount_minor: index === 0 ? 1 : 100_000_000,
    }))
    expect(readProgram({ ...fluent, rewards })?.rewards).toEqual(rewards)
  })

  it('leaves out a row with no usable slug or name and refuses a body that is not a list', () => {
    expect(
      programs(speaksix, { ...speaksix, slug: 'Not A Slug' }, { name: 'x' }, null),
    ).toHaveLength(1)
    expect(() => readProgramList({ rows: [] })).toThrow(MarketplaceUnreadable)
    expect(() => readProgramList(null)).toThrow(MarketplaceUnreadable)
  })

  it('reads the signed-in status on a card and ignores one it does not know', () => {
    expect(readProgram({ ...speaksix, membership_status: 'pending' })?.membership_status).toBe(
      'pending',
    )
    expect(readProgram({ ...speaksix, membership_status: 'banned' })?.membership_status).toBeNull()
  })

  it('reads a program with its agreement, with or without an id', () => {
    const read = readProgramDetail(detail)
    expect(read).toMatchObject({
      slug: 'speaksix',
      status: 'live',
      id: null,
      agreement_sha256: SHA,
    })
    expect(read.agreement.sections).toHaveLength(2)
    expect(readProgramDetail({ ...detail, id: 'prog-1', status: 'archived' })).toMatchObject({
      id: 'prog-1',
      status: 'archived',
    })
  })

  it('refuses a program whose agreement, hash or version cannot be trusted', () => {
    expect(() => readProgramDetail({ ...detail, agreement: null })).toThrow(MarketplaceUnreadable)
    expect(() => readProgramDetail({ ...detail, agreement_sha256: 'nope' })).toThrow(
      MarketplaceUnreadable,
    )
    expect(() => readProgramDetail({ ...detail, terms_version: null })).toThrow(
      MarketplaceUnreadable,
    )
    expect(() => readProgramDetail({ ...detail, agreement: { title: 'x' } })).toThrow(
      MarketplaceUnreadable,
    )
  })
})

describe('the words on a card', () => {
  const [percent, fixed] = programs(speaksix, fieldnote)

  it('shows money in normal units, never minor units or basis points', () => {
    expect(programHeadline(percent)).toBe('30% of every payment for 12 months')
    expect(programHeadline(fixed)).toBe('$8.00 on the first payment')
  })

  it('says what an events program pays: its rewards, the first two named', () => {
    const [events] = programs(fluent)
    expect(programHeadline(events)).toBe('$2.00 per Account created, $5.00 per Trial started')
    expect(programHeadline({ ...events, rewards: [signup] })).toBe('$2.00 per Account created')
    const third = { key: 'subscribed', label: 'Subscribed', amount_minor: 1000 }
    expect(programHeadline({ ...events, rewards: [signup, trial, third] })).toBe(
      '$2.00 per Account created, $5.00 per Trial started and 1 more reward',
    )
    const fourth = { key: 'renewed', label: 'Renewed', amount_minor: 1250 }
    expect(programHeadline({ ...events, rewards: [signup, trial, third, fourth] })).toBe(
      '$2.00 per Account created, $5.00 per Trial started and 2 more rewards',
    )
    expect(programRewardLine({ ...signup, amount_minor: 125050 }, 'EUR')).toBe(
      '1,250.50 EUR per Account created',
    )
  })

  it('says what a program that pays for both pays: the commission, plus rewards', () => {
    const [both, sales, events] = programs(pocketChef, speaksixNow, fluent)
    expect(programHeadline(both)).toBe('30% of every payment for 12 months, plus rewards')
    expect(programRewardsLine(both)).toBe('$2.00 per Account created')
    expect(programHeadline(sales)).toBe('30% of every payment for 12 months')
    // Only a program that pays for both has a rewards line: the other headlines say it all.
    expect(programRewardsLine(sales)).toBeNull()
    expect(programRewardsLine(events)).toBeNull()
    const many = { ...both, rewards: [signup, trial, { ...signup, key: 'paid', label: 'Paid' }] }
    expect(programRewardsLine(many)).toBe(
      '$2.00 per Account created, $5.00 per Trial started and 1 more reward',
    )
  })

  it('names the rewards of a program that pays for both when its commission cannot be read', () => {
    const [both] = programs(pocketChef)
    const broken = { ...both, commission_rate_bps: null }
    expect(programHeadline(broken)).toBe('$2.00 per Account created')
    expect(programRewardsLine(broken)).toBeNull()
  })

  it('writes the small line from the attribution window and the hold', () => {
    expect(programTermsLine(percent)).toBe('30-day attribution · 30-day hold')
    expect(programTermsLine(fixed)).toBe('60-day attribution · No hold')
  })

  it('builds the logo address in the public bucket, or none', () => {
    expect(programLogoUrl('https://x.supabase.co/', 'ws-1/my logo.png')).toBe(
      'https://x.supabase.co/storage/v1/object/public/program-logos/ws-1/my%20logo.png',
    )
    expect(programLogoUrl('https://x.supabase.co', null)).toBeNull()
    expect(programLogoUrl(null, 'ws-1/logo.png')).toBeNull()
    expect(programLogoUrl('https://x.supabase.co', '../secrets/logo.png')).toBeNull()
    expect(programInitials('Pocket Chef')).toBe('PC')
  })

  it('lists only the categories present and filters by category and words', () => {
    const list = programs(speaksix, fieldnote, { ...speaksix, slug: 'bc', name: 'BC Learn' })
    expect(categoriesPresent(list)).toEqual(['education', 'productivity'])
    expect(filterPrograms(list, 'education', '').map((item) => item.slug)).toEqual([
      'speaksix',
      'bc',
    ])
    expect(filterPrograms(list, null, '  MEETING notes ').map((item) => item.slug)).toEqual([
      'fieldnote',
    ])
    expect(filterPrograms(list, 'education', 'meeting')).toEqual([])
  })

  it('splits a numbered agreement heading and leaves an unnumbered one whole', () => {
    expect(sectionParts('10. Ending this agreement')).toEqual({
      number: '10',
      title: 'Ending this agreement',
    })
    expect(sectionParts('Additional terms')).toEqual({ number: null, title: 'Additional terms' })
  })
})

describe('marketplace routes', () => {
  it('recognises the public paths on any host', () => {
    expect(isMarketplacePath('/marketplace')).toBe(true)
    expect(isMarketplacePath('/marketplace/speaksix')).toBe(true)
    expect(isMarketplacePath('/')).toBe(false)
    expect(isMarketplacePath('/merchant/connect')).toBe(false)
    expect(marketplaceRouteFromPath('/marketplace/')).toEqual({ name: 'list' })
    expect(marketplaceRouteFromPath('/marketplace/speak-six-2')).toEqual({
      name: 'program',
      slug: 'speak-six-2',
    })
    expect(marketplaceRouteFromPath('/marketplace/Speak_Six')).toEqual({ name: 'not-found' })
    expect(marketplaceRouteFromPath('/marketplace/a/b')).toEqual({ name: 'not-found' })
    expect(marketplacePath('speaksix')).toBe('/marketplace/speaksix')
  })

  it('applies the same slug rule as the public function', () => {
    expect(isProgramSlug('speaksix')).toBe(true)
    expect(isProgramSlug('a-1-b')).toBe(true)
    expect(isProgramSlug('-a')).toBe(false)
    expect(isProgramSlug('a--b')).toBe(false)
    expect(isProgramSlug('a'.repeat(81))).toBe(false)
    expect(isProgramSlug(null)).toBe(false)
  })

  it('reads the program from the partner hash', () => {
    expect(programSlugFromHash('#marketplace/speaksix')).toBe('speaksix')
    expect(programSlugFromHash('#marketplace')).toBeNull()
    expect(programSlugFromHash('#marketplace/Bad Slug')).toBeNull()
    expect(programSlugFromHash('#marketplace/a/b')).toBeNull()
    expect(programSlugFromHash('#links/speaksix')).toBeNull()
    expect(marketplaceHash('speaksix')).toBe('#marketplace/speaksix')
    expect(marketplaceHash()).toBe('#marketplace')
  })

  it('sends Join program to the partner host in production and to the same origin locally', () => {
    const production = { hostname: 'kissmyapps.dev', origin: 'https://kissmyapps.dev' }
    const local = { hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173' }
    expect(partnerAppOrigin(production)).toBe('https://partners.kissmyapps.dev')
    expect(
      partnerAppOrigin({
        hostname: 'merchant.kissmyapps.dev',
        origin: 'https://merchant.kissmyapps.dev',
      }),
    ).toBe('https://partners.kissmyapps.dev')
    expect(partnerAppUrl(production, { join: 'speaksix' })).toBe(
      'https://partners.kissmyapps.dev/#marketplace/speaksix',
    )
    expect(partnerAppUrl(local, { join: 'speaksix' })).toBe(
      'http://127.0.0.1:5173/#marketplace/speaksix',
    )
    expect(partnerAppUrl(production, { screen: 'sign-up', join: 'speaksix' })).toBe(
      'https://partners.kissmyapps.dev/?program=speaksix#auth/sign-up',
    )
    expect(partnerAppUrl(production, { screen: 'sign-in' })).toBe(
      'https://partners.kissmyapps.dev/#auth/sign-in',
    )
  })
})

describe('the public function', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('asks for the list with a plain GET that carries no key, session or cookies', async () => {
    const fetch = vi.fn(async () => json({ programs: [speaksix] }))
    const answer = await loadMarketplacePrograms({ baseUrl: 'https://x.supabase.co/', fetch })
    expect(answer).toMatchObject({ status: 'ready', data: [{ slug: 'speaksix' }] })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://x.supabase.co/functions/v1/marketplace')
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit' })
    expect(init.headers).toBeUndefined()
    expect(init.body).toBeUndefined()
  })

  it('asks for one program by slug and reads it', async () => {
    const fetch = vi.fn(async () => json({ program: detail }))
    const answer = await loadMarketplaceProgram('speaksix', {
      baseUrl: 'https://x.supabase.co',
      fetch,
    })
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe(
      'https://x.supabase.co/functions/v1/marketplace?slug=speaksix',
    )
    expect(answer).toMatchObject({ status: 'ready', data: { name: 'SpeakSix', id: null } })
  })

  it('treats 404 and a null program as not found, without asking for a malformed slug', async () => {
    const options = { baseUrl: 'https://x.supabase.co' }
    const missing = vi.fn(async () =>
      json({ error: 'not_found', message: 'No such program.', request_id: 'r1' }, 404),
    )
    expect(await loadMarketplaceProgram('gone', { ...options, fetch: missing })).toEqual({
      status: 'not-found',
    })
    const empty = vi.fn(async () => json({ program: null }))
    expect(await loadMarketplaceProgram('gone', { ...options, fetch: empty })).toEqual({
      status: 'not-found',
    })
    const never = vi.fn()
    expect(await loadMarketplaceProgram('Not A Slug', { ...options, fetch: never })).toEqual({
      status: 'not-found',
    })
    expect(never).not.toHaveBeenCalled()
  })

  it.each([
    ['the function is switched off', () => json({ error: 'marketplace_disabled' }, 503)],
    ['the database fails', () => json({ error: 'database_boundary_error' }, 503)],
    ['the list address answers 404', () => json({ error: 'not_found' }, 404)],
    ['the body is not the agreed shape', () => json({ rows: [] })],
    ['the body is not JSON', () => new Response('<html>', { status: 200 })],
  ])('reports a load error when %s', async (_name, respond) => {
    const answer = await loadMarketplacePrograms({
      baseUrl: 'https://x.supabase.co',
      fetch: vi.fn(async () => respond()),
    })
    expect(answer).toEqual({ status: 'error', reason: 'unavailable' })
  })

  it('reports a load error when the request never arrives or nothing is configured', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await loadMarketplacePrograms({ baseUrl: 'https://x.supabase.co', fetch })).toEqual({
      status: 'error',
      reason: 'unavailable',
    })
    expect(await loadMarketplaceProgram('speaksix', { baseUrl: null, fetch })).toEqual({
      status: 'error',
      reason: 'unavailable',
    })
  })
})

describe('public marketplace page', () => {
  function api(overrides: Partial<PublicMarketplaceApi> = {}): PublicMarketplaceApi {
    return {
      loadPrograms: vi.fn(async () => ({
        status: 'ready' as const,
        data: programs(speaksix, fieldnote),
      })),
      loadProgram: vi.fn(async () => ({
        status: 'ready' as const,
        data: readProgramDetail(detail),
      })),
      ...overrides,
    }
  }

  function open(path: string, marketplaceApi = api()) {
    window.history.replaceState(null, '', path)
    return { api: marketplaceApi, ...render(<PublicMarketplace api={marketplaceApi} />) }
  }

  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, '', '/')
  })

  it('lists the live programs with what a creator earns and one action per card', async () => {
    open('/marketplace')
    expect(screen.getByRole('status', { name: 'Loading programs' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'SpeakSix', level: 3 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Marketplace', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('30% of every payment for 12 months')).toBeInTheDocument()
    expect(screen.getByText('$8.00 on the first payment')).toBeInTheDocument()
    expect(screen.getByText('30-day attribution · 30-day hold')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View program: SpeakSix' })).toHaveAttribute(
      'href',
      '/marketplace/speaksix',
    )
    expect(screen.getByText('2 programs')).toBeInTheDocument()
    expect(document.title).toBe('Marketplace · KissMyApps')
  })

  it('shows what each program pays on its card: sales, events and both', async () => {
    open(
      '/marketplace',
      api({
        loadPrograms: vi.fn(async () => ({
          status: 'ready' as const,
          data: programs(speaksixNow, fluent, pocketChef),
        })),
      }),
    )
    const card = async (name: string) =>
      (await screen.findByRole('heading', { name, level: 3 })).closest('article')!
    expect(
      within(await card('SpeakSix')).getByText('30% of every payment for 12 months'),
    ).toBeInTheDocument()
    expect(
      within(await card('Fluent')).getByText('$2.00 per Account created, $5.00 per Trial started'),
    ).toBeInTheDocument()
    expect(
      within(await card('Pocket Chef')).getByText(
        '30% of every payment for 12 months, plus rewards',
      ),
    ).toBeInTheDocument()
    expect(
      within(await card('Pocket Chef')).getByText('$2.00 per Account created'),
    ).toBeInTheDocument()
    // The rewards line belongs to a program that pays for both, and to no other card.
    expect(document.querySelectorAll('.mkt-card-rewards')).toHaveLength(1)
    expect(
      within(await card('Fluent')).getByText('30-day attribution · 30-day hold'),
    ).toBeInTheDocument()
    // Money is in normal units and the event's own name is never on the page.
    expect(document.body).not.toHaveTextContent(/signup_completed|trial_started|\b200\b|\b500\b/)
  })

  it('draws a card from before programs could pay for events exactly as one that says sales', async () => {
    const old = open(
      '/marketplace',
      api({
        loadPrograms: vi.fn(async () => ({ status: 'ready' as const, data: programs(speaksix) })),
      }),
    )
    await screen.findByRole('heading', { name: 'SpeakSix', level: 3 })
    const before = old.container.innerHTML
    old.unmount()
    const now = open(
      '/marketplace',
      api({
        loadPrograms: vi.fn(async () => ({
          status: 'ready' as const,
          data: programs(speaksixNow),
        })),
      }),
    )
    await screen.findByRole('heading', { name: 'SpeakSix', level: 3 })
    const strip = (html: string) => html.replace(/(id|for)="[^"]*"/g, '')
    expect(strip(now.container.innerHTML)).toBe(strip(before))
  })

  it('offers Sign in and Become a creator, both into the partner app, and nothing else', async () => {
    open('/marketplace')
    await screen.findByRole('heading', { name: 'SpeakSix', level: 3 })
    const account = screen.getByRole('navigation', { name: 'Creator account' })
    expect(within(account).getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      `${window.location.origin}/#auth/sign-in`,
    )
    expect(within(account).getByRole('link', { name: 'Become a creator' })).toHaveAttribute(
      'href',
      `${window.location.origin}/#auth/sign-up`,
    )
    expect(screen.queryByText(/for merchants|how payouts work|paid monthly/i)).toBeNull()
    expect(screen.queryByText(/test mode|sandbox/i)).toBeNull()
    expect(document.cookie).toBe('')
  })

  it('filters by category chip and by search, and can clear a filter with no match', async () => {
    const user = userEvent.setup()
    open('/marketplace')
    await screen.findByRole('heading', { name: 'SpeakSix', level: 3 })
    const chips = screen.getByRole('group', { name: 'Category' })
    expect(
      within(chips)
        .getAllByRole('button')
        .map((chip) => chip.textContent),
    ).toEqual(['All', 'Education', 'Productivity'])

    await user.click(within(chips).getByRole('button', { name: 'Productivity' }))
    expect(screen.queryByRole('heading', { name: 'SpeakSix', level: 3 })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Fieldnote', level: 3 })).toBeInTheDocument()
    expect(screen.getByText('1 of 2 programs')).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search programs' }), 'english')
    expect(screen.getByRole('heading', { name: 'No programs match' })).toBeInTheDocument()
    expect(screen.getByText('Nothing matches “english” in Productivity.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show all programs' }))
    expect(screen.getByRole('heading', { name: 'SpeakSix', level: 3 })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search programs' })).toHaveValue('')
  })

  it('says so when the marketplace has no programs yet', async () => {
    open(
      '/marketplace',
      api({ loadPrograms: vi.fn(async () => ({ status: 'ready' as const, data: [] })) }),
    )
    expect(await screen.findByRole('heading', { name: 'No programs yet' })).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('shows a load error and loads again on Try again', async () => {
    const user = userEvent.setup()
    const loadPrograms = vi
      .fn<PublicMarketplaceApi['loadPrograms']>()
      .mockResolvedValueOnce({ status: 'error', reason: 'unavailable' })
      .mockResolvedValue({ status: 'ready', data: programs(speaksix) })
    open('/marketplace', api({ loadPrograms }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The marketplace did not load')
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'SpeakSix', level: 3 })).toBeInTheDocument()
    expect(loadPrograms).toHaveBeenCalledTimes(2)
  })

  it('opens a program without a page load and comes back with the browser', async () => {
    const user = userEvent.setup()
    const { api: used } = open('/marketplace')
    await user.click(await screen.findByRole('link', { name: 'View program: SpeakSix' }))
    expect(window.location.pathname).toBe('/marketplace/speaksix')
    expect(await screen.findByRole('heading', { name: 'SpeakSix', level: 1 })).toBeInTheDocument()
    expect(used.loadProgram).toHaveBeenCalledWith('speaksix')
    await waitFor(() => expect(document.title).toBe('SpeakSix affiliate program · KissMyApps'))

    await user.click(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
        name: 'Marketplace',
      }),
    )
    expect(window.location.pathname).toBe('/marketplace')
    expect(
      await screen.findByRole('heading', { name: 'Marketplace', level: 1 }),
    ).toBeInTheDocument()
    expect(used.loadPrograms).toHaveBeenCalledTimes(1)
  })

  it('shows a program: its facts, the real agreement and one Join program action', async () => {
    open('/marketplace/speaksix')
    expect(await screen.findByRole('heading', { name: 'SpeakSix', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('Education · SpeakSix Ltd')).toBeInTheDocument()

    const document_ = screen.getByRole('article', { name: 'SpeakSix Affiliate Agreement' })
    expect(
      within(document_).getByText('Between you and SpeakSix Ltd · Version 1'),
    ).toBeInTheDocument()
    for (const [label, value] of [
      ['Commission', '30% of every payment for 12 months'],
      ['Attribution window', '30 days'],
      ['Hold before payout', '30 days'],
      ['Minimum payout', '$20.00'],
    ]) {
      expect(
        within(document_).getByText(label, { selector: 'dt' }).nextElementSibling,
      ).toHaveTextContent(value)
    }
    expect(
      within(document_).getByRole('heading', { name: '1 Who this agreement is between', level: 3 }),
    ).toBeInTheDocument()
    expect(
      within(document_).getByText('This agreement is between you, the creator, and SpeakSix Ltd.'),
    ).toBeInTheDocument()

    const join = screen.getByRole('link', { name: 'Join program' })
    expect(join).toHaveAttribute('href', `${window.location.origin}/#marketplace/speaksix`)
    expect(screen.getByRole('link', { name: 'Become a creator' })).toHaveAttribute(
      'href',
      `${window.location.origin}/?program=speaksix#auth/sign-up`,
    )
    expect(screen.queryByText(/download pdf|partner terms|documents/i)).toBeNull()
  })

  it('shows what an events program pays beside Join program, the same words as its card', async () => {
    const events = readProgramDetail({ ...detail, ...fluent })
    open(
      '/marketplace/fluent',
      api({ loadProgram: vi.fn(async () => ({ status: 'ready' as const, data: events })) }),
    )
    const side = await screen.findByRole('complementary', { name: 'Join this program' })
    expect(
      within(side).getByText('$2.00 per Account created, $5.00 per Trial started'),
    ).toBeInTheDocument()
    expect(within(side).getByText('30-day attribution · 30-day hold')).toBeInTheDocument()
    expect(within(side).getByRole('link', { name: 'Join program' })).toBeInTheDocument()
    expect(within(side).queryByText(/of every payment|on the first payment/)).toBeNull()
  })

  it('shows what a program that pays for both pays beside Join program', async () => {
    const both = readProgramDetail({ ...detail, ...pocketChef })
    open(
      '/marketplace/pocket-chef',
      api({ loadProgram: vi.fn(async () => ({ status: 'ready' as const, data: both })) }),
    )
    const side = await screen.findByRole('complementary', { name: 'Join this program' })
    expect(
      within(side).getByText('30% of every payment for 12 months, plus rewards'),
    ).toBeInTheDocument()
    expect(within(side).getByText('$2.00 per Account created')).toBeInTheDocument()
  })

  it('shows a reward label as plain text, never as markup', async () => {
    const label = '<img src=x onerror=alert(1)>'
    const markup = { ...fluent, rewards: [{ ...signup, label }] }
    open(
      '/marketplace',
      api({
        loadPrograms: vi.fn(async () => ({ status: 'ready' as const, data: programs(markup) })),
        loadProgram: vi.fn(async () => ({
          status: 'ready' as const,
          data: readProgramDetail({ ...detail, ...markup }),
        })),
      }),
    )
    expect(await screen.findByText(`$2.00 per ${label}`)).toBeInTheDocument()
    expect(document.querySelector('.mkt-main img')).toBeNull()
    await userEvent.setup().click(screen.getByRole('link', { name: 'View program: Fluent' }))
    const side = await screen.findByRole('complementary', { name: 'Join this program' })
    expect(within(side).getByText(`$2.00 per ${label}`)).toBeInTheDocument()
    expect(document.querySelector('.mkt-main img')).toBeNull()
  })

  it('says who approves when the program approves each creator', async () => {
    const manual = readProgramDetail({ ...detail, approval_mode: 'manual' })
    open(
      '/marketplace/speaksix',
      api({ loadProgram: vi.fn(async () => ({ status: 'ready' as const, data: manual })) }),
    )
    expect(
      await screen.findByText(/SpeakSix Ltd then approves each creator before a link is issued/),
    ).toBeInTheDocument()
  })

  it('shows extra terms after the last section', async () => {
    const withExtra = readProgramDetail({
      ...detail,
      agreement: { ...agreement, extra_terms: 'Do not promote next to gambling content.' },
    })
    open(
      '/marketplace/speaksix',
      api({ loadProgram: vi.fn(async () => ({ status: 'ready' as const, data: withExtra })) }),
    )
    expect(await screen.findByText('Do not promote next to gambling content.')).toBeInTheDocument()
  })

  it('says a paused program is not taking new creators and offers no Join', async () => {
    const paused = readProgramDetail({ ...detail, status: 'paused' })
    open(
      '/marketplace/speaksix',
      api({ loadProgram: vi.fn(async () => ({ status: 'ready' as const, data: paused })) }),
    )
    expect(await screen.findByText('Not taking new creators.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Join program' })).toBeNull()
    expect(
      screen.getByRole('article', { name: 'SpeakSix Affiliate Agreement' }),
    ).toBeInTheDocument()
  })

  it('shows a plain not-found state with a way back for an unknown program', async () => {
    const user = userEvent.setup()
    open(
      '/marketplace/gone',
      api({ loadProgram: vi.fn(async () => ({ status: 'not-found' as const })) }),
    )
    expect(await screen.findByRole('heading', { name: 'Program not found' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('Program not found · KissMyApps'))
    await user.click(screen.getByRole('link', { name: 'Back to the marketplace' }))
    expect(window.location.pathname).toBe('/marketplace')
    expect(await screen.findByRole('heading', { name: 'SpeakSix', level: 3 })).toBeInTheDocument()
  })

  it('shows not found for a malformed address without asking the server', async () => {
    const { api: used } = open('/marketplace/Not_A_Slug')
    expect(await screen.findByRole('heading', { name: 'Program not found' })).toBeInTheDocument()
    expect(used.loadProgram).not.toHaveBeenCalled()
  })

  it('shows a program load error and loads again on Try again', async () => {
    const user = userEvent.setup()
    const loadProgram = vi
      .fn<PublicMarketplaceApi['loadProgram']>()
      .mockResolvedValueOnce({ status: 'error', reason: 'offline' })
      .mockResolvedValue({ status: 'ready', data: readProgramDetail(detail) })
    open('/marketplace/speaksix', api({ loadProgram }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('You are offline')
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'SpeakSix', level: 1 })).toBeInTheDocument()
  })
})
