import { describe, expect, it } from 'vitest'
import { linksBackendFixture as backend } from './links.fixture'
import {
  LINK_NAME_MAX,
  LinksUnreadable,
  addedLink,
  conversionRate,
  customLinksLeft,
  customLinksUsed,
  displayAddress,
  formatCount,
  linkEarnings,
  linkError,
  linkErrorMessage,
  linkFailure,
  linkNameProblem,
  linkStatusLine,
  linksUnavailable,
  mainLink,
  otherLinks,
  readLinkProgram,
  readProgramLinks,
  staleAfter,
  withProgram,
} from './links'
import type { ProgramLinksErrorCode } from './links'

/** One link exactly as the contract writes it. */
function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    link_id: 'link-main',
    kind: 'main',
    channel: null,
    name: 'Main link',
    url: 'https://go.kissmyapps.dev/speaksix/ada',
    created_at: '2026-11-02T09:14:07.512846+00:00',
    clicks: 58,
    sales: 0,
    earnings_minor: 0,
    removable: false,
    ...overrides,
  }
}

function programRow(overrides: Record<string, unknown> = {}) {
  return {
    program_id: 'prog-1',
    slug: 'speaksix',
    name: 'SpeakSix',
    currency: 'USD',
    working: true,
    paused_reason: null,
    custom_links: 1,
    links: [
      linkRow(),
      linkRow({
        link_id: 'link-tiktok',
        kind: 'channel',
        channel: 'tiktok',
        name: 'TikTok',
        url: 'https://go.kissmyapps.dev/speaksix/ada/tiktok',
        clicks: 1840,
        sales: 46,
        earnings_minor: 27600,
      }),
      linkRow({
        link_id: 'link-podcast',
        kind: 'custom',
        name: 'Podcast',
        url: 'https://go.kissmyapps.dev/speaksix/ada/podcast',
        clicks: 0,
        removable: true,
      }),
    ],
    ...overrides,
  }
}

function answer(overrides: Record<string, unknown> = {}) {
  return {
    stats_days: 30,
    max_custom_links: 20,
    channels: [{ key: 'tiktok', name: 'TikTok' }],
    programs: [programRow()],
    ...overrides,
  }
}

describe('reading partner_program_links', () => {
  it('reads every field of the answer the contract describes', () => {
    expect(readProgramLinks(answer())).toEqual({
      stats_days: 30,
      max_custom_links: 20,
      channels: [{ key: 'tiktok', name: 'TikTok' }],
      programs: [
        {
          program_id: 'prog-1',
          slug: 'speaksix',
          name: 'SpeakSix',
          currency: 'USD',
          working: true,
          paused_reason: null,
          custom_links: 1,
          links: [
            {
              link_id: 'link-main',
              kind: 'main',
              channel: null,
              name: 'Main link',
              url: 'https://go.kissmyapps.dev/speaksix/ada',
              created_at: '2026-11-02T09:14:07.512846+00:00',
              clicks: 58,
              sales: 0,
              earnings_minor: 0,
              removable: false,
            },
            expect.objectContaining({ kind: 'channel', channel: 'tiktok', earnings_minor: 27600 }),
            expect.objectContaining({ kind: 'custom', channel: null, removable: true }),
          ],
        },
      ],
    })
  })

  it('reads every backend answer in the fixture, whatever its numbers', () => {
    const answers = Object.values(backend).filter(
      (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
    )
    expect(answers.length).toBeGreaterThan(0)
    for (const body of answers) {
      // The whole page has `programs`; adding and removing answer with one program.
      const whole = 'programs' in body ? readProgramLinks(body) : null
      if (whole) {
        expect(whole.stats_days).toBeGreaterThan(0)
        expect(whole.max_custom_links).toBeGreaterThan(0)
      }
      for (const program of whole ? whole.programs : [readLinkProgram(body)]) {
        // The main link first, then the channels, then custom links.
        const kinds = program.links.map((link) => link.kind)
        expect(kinds[0]).toBe('main')
        expect(kinds.filter((kind) => kind === 'main')).toHaveLength(1)
        expect(kinds.join(' ')).toMatch(/^main( channel)*( custom)*$/)
        if (whole) {
          // A channel may be listed without a link here, never the other way round.
          const listed = whole.channels.map((channel) => channel.key)
          for (const link of program.links)
            if (link.kind === 'channel') expect(listed).toContain(link.channel)
        }
        expect(program.custom_links).toBe(kinds.filter((kind) => kind === 'custom').length)
        for (const link of program.links) {
          expect(link.url).toMatch(/^https:\/\//)
          expect(link.removable && link.kind !== 'custom').toBe(false)
          expect(link.removable && link.clicks > 0).toBe(false)
        }
        // No buyer ever reaches a creator's page.
        expect(JSON.stringify(program)).not.toContain('@')
      }
    }
  })

  it('reads a creator with no program as no programs', () => {
    expect(readProgramLinks(answer({ programs: [] })).programs).toEqual([])
  })

  it('reads a program that has no link for a listed channel', () => {
    const links = readProgramLinks(
      answer({
        channels: [
          { key: 'tiktok', name: 'TikTok' },
          { key: 'instagram', name: 'Instagram' },
        ],
      }),
    )
    const program = links.programs[0]
    const listed = links.channels.map((channel) => channel.key)
    const linked = program.links.map((link) => link.channel).filter(Boolean)
    expect(listed.length).toBeGreaterThan(linked.length)
    expect(otherLinks(program).map((link) => link.name)).toEqual(['TikTok', 'Podcast'])
  })

  it('reads why a program is paused, and nothing for one that is working', () => {
    for (const reason of ['program_paused', 'balance_empty'] as const)
      expect(readLinkProgram(programRow({ working: false, paused_reason: reason }))).toMatchObject({
        working: false,
        paused_reason: reason,
      })
    expect(readLinkProgram(programRow())).toMatchObject({ working: true, paused_reason: null })
    // A reason the page has no words for is read as paused without one.
    expect(
      readLinkProgram(programRow({ working: false, paused_reason: 'under_review' })),
    ).toMatchObject({ working: false, paused_reason: null })
    // A working program has no reason, whatever the answer carries.
    expect(
      readLinkProgram(programRow({ paused_reason: 'program_paused' })).paused_reason,
    ).toBeNull()
  })

  it('accepts sums that Postgres sends as digits', () => {
    const program = readLinkProgram(
      programRow({ links: [linkRow({ clicks: '58', sales: '2', earnings_minor: '1200' })] }),
    )
    expect(program.links[0]).toMatchObject({ clicks: 58, sales: 2, earnings_minor: 1200 })
  })

  it('never calls a main or channel link removable', () => {
    const program = readLinkProgram(
      programRow({
        links: [
          linkRow({ removable: true }),
          linkRow({
            link_id: 'c',
            kind: 'channel',
            channel: 'x',
            name: 'X',
            removable: true,
          }),
          linkRow({ link_id: 'd', kind: 'custom', name: 'Podcast', removable: 'yes' }),
        ],
      }),
    )
    expect(program.links.map((link) => link.removable)).toEqual([false, false, false])
  })

  it('counts at least the custom links that are on the page', () => {
    expect(readLinkProgram(programRow({ custom_links: undefined })).custom_links).toBe(1)
    expect(readLinkProgram(programRow({ custom_links: 7 })).custom_links).toBe(7)
  })

  it.each([
    ['nothing', null],
    ['a list', []],
    ['text', 'ok'],
    ['no programs', answer({ programs: undefined })],
    ['programs that are not a list', answer({ programs: {} })],
    ['no channels', answer({ channels: null })],
    ['a channel without a name', answer({ channels: [{ key: 'tiktok' }] })],
    ['no number of days', answer({ stats_days: undefined })],
    ['zero days', answer({ stats_days: 0 })],
    ['days that are not whole', answer({ stats_days: 30.5 })],
    ['no limit', answer({ max_custom_links: null })],
    ['a negative limit', answer({ max_custom_links: -1 })],
  ])('refuses an answer with %s', (_, value) => {
    expect(() => readProgramLinks(value)).toThrow(LinksUnreadable)
  })

  it.each([
    ['no id', { program_id: null }],
    ['no slug', { slug: '' }],
    ['no name', { name: '   ' }],
    ['a currency that is not a code', { currency: 'dollars' }],
    ['no word on whether it works', { working: undefined }],
    ['a working that is not yes or no', { working: 'true' }],
    ['links that are not a list', { links: null }],
    ['no links', { links: [] }],
    ['no main link', { links: [linkRow({ kind: 'custom', name: 'Podcast' })] }],
    ['two main links', { links: [linkRow(), linkRow({ link_id: 'again' })] }],
  ])('refuses a program with %s', (_, overrides) => {
    expect(() => readLinkProgram(programRow(overrides))).toThrow(LinksUnreadable)
    expect(() => readProgramLinks(answer({ programs: [programRow(overrides)] }))).toThrow(
      LinksUnreadable,
    )
  })

  it.each([
    ['no id', { link_id: undefined }],
    ['a kind the page does not know', { kind: 'campaign' }],
    ['no name', { name: null }],
    ['no address', { url: null }],
    ['an address that is not https', { url: 'http://go.kissmyapps.dev/speaksix/ada' }],
    ['an address that is a script', { url: 'javascript:alert(1)' }],
    ['an address with a sign-in part', { url: 'https://ada@go.kissmyapps.dev/speaksix' }],
    ['an address with a space', { url: 'https://go.kissmyapps.dev/speak six' }],
    ['no clicks', { clicks: undefined }],
    ['negative clicks', { clicks: -1 }],
    ['clicks that are not whole', { clicks: 1.5 }],
    ['sales in words', { sales: 'four' }],
    ['no earnings', { earnings_minor: null }],
    ['negative earnings', { earnings_minor: -100 }],
    ['a channel link without its channel', { kind: 'channel', channel: null }],
  ])('refuses a link with %s', (_, overrides) => {
    expect(() => readLinkProgram(programRow({ links: [linkRow(overrides)] }))).toThrow(
      LinksUnreadable,
    )
  })

  it('reads a time it cannot parse as unknown rather than refusing the link', () => {
    const program = readLinkProgram(programRow({ links: [linkRow({ created_at: 'yesterday' })] }))
    expect(program.links[0].created_at).toBeNull()
  })
})

describe('reading what adding and removing a link answer', () => {
  const newsletter = linkRow({
    link_id: 'link-footer',
    kind: 'custom',
    name: 'Newsletter footer',
    url: 'https://go.kissmyapps.dev/speaksix/ada/newsletter-footer',
    clicks: 0,
    removable: true,
  })

  it('reads the program as it is after a link was added', () => {
    const before = readLinkProgram(programRow())
    const row = programRow()
    const after = readLinkProgram({
      ...row,
      custom_links: 2,
      links: [...(row.links as unknown[]), newsletter],
    })
    expect(after.program_id).toBe(before.program_id)
    expect(after.custom_links).toBe(before.custom_links + 1)
    const added = addedLink(before, after)
    // The address is the one the answer gives, never one built from the name.
    expect(added).toMatchObject({
      kind: 'custom',
      name: 'Newsletter footer',
      url: 'https://go.kissmyapps.dev/speaksix/ada/newsletter-footer',
      clicks: 0,
      removable: true,
    })
    expect(after.links[after.links.length - 1]).toEqual(added)
    expect(addedLink(before, before)).toBeNull()
  })

  it('reads the program as it is after a link was removed, and puts it in its place', () => {
    const other = programRow({ program_id: 'prog-2', slug: 'dramapal', name: 'DramaPal' })
    const links = readProgramLinks(answer({ programs: [other, programRow()] }))
    const before = links.programs.find((program) => program.slug === 'speaksix')!
    const row = programRow()
    const after = readLinkProgram({
      ...row,
      custom_links: 0,
      links: (row.links as { kind: string }[]).filter((link) => link.kind !== 'custom'),
    })
    expect(after.links).toHaveLength(before.links.length - 1)
    expect(after.custom_links).toBe(before.custom_links - 1)

    const replaced = withProgram(links, after)
    expect(replaced.programs.map((program) => program.slug)).toEqual(['dramapal', 'speaksix'])
    expect(replaced.programs.find((program) => program.slug === 'speaksix')).toEqual(after)
    expect(replaced.programs.filter((program) => program.slug !== 'speaksix')).toEqual(
      links.programs.filter((program) => program.slug !== 'speaksix'),
    )
  })

  it('refuses the whole-page answer where one program is expected', () => {
    expect(() => readLinkProgram(answer())).toThrow(LinksUnreadable)
    expect(() => readLinkProgram({ ok: true })).toThrow(LinksUnreadable)
  })
})

describe('what there is to show', () => {
  const program = readLinkProgram(programRow())

  it('separates the main link from the ones copied for a channel', () => {
    expect(mainLink(program).link_id).toBe('link-main')
    expect(otherLinks(program).map((link) => link.name)).toEqual(['TikTok', 'Podcast'])
  })

  it('shows an address without its scheme', () => {
    expect(displayAddress('https://go.kissmyapps.dev/speaksix/ada')).toBe(
      'go.kissmyapps.dev/speaksix/ada',
    )
    expect(displayAddress('https://go.kissmyapps.dev/speaksix/ada/')).toBe(
      'go.kissmyapps.dev/speaksix/ada',
    )
  })

  it('works out conversion from the counts, with a dash when there are no clicks', () => {
    expect(conversionRate(1840, 46)).toBe('2.5%')
    expect(conversionRate(304, 9)).toBe('3.0%')
    expect(conversionRate(58, 0)).toBe('0.0%')
    expect(conversionRate(0, 0)).toBe('—')
    // A sale whose click was before the window: still a dash, never NaN or Infinity.
    expect(conversionRate(0, 2)).toBe('—')
    expect(conversionRate(3, 3)).toBe('100.0%')
  })

  it('writes counts with separators and money in normal units', () => {
    expect(formatCount(1840)).toBe('1,840')
    expect(formatCount(0)).toBe('0')
    expect(linkEarnings(program.links[1], 'USD')).toBe('$276.00')
    expect(linkEarnings(program.links[1], 'EUR')).toBe('276.00 EUR')
    expect(linkEarnings(program.links[0], 'USD')).toBe('$0.00')
  })

  it('says Live, or in one sentence why sales are not credited', () => {
    expect(linkStatusLine({ working: true, paused_reason: null })).toBe('Live')
    expect(linkStatusLine({ working: false, paused_reason: 'program_paused' })).toBe(
      'Paused by the brand: sales are not credited right now.',
    )
    expect(linkStatusLine({ working: false, paused_reason: 'balance_empty' })).toBe(
      'Paused: the brand’s balance is empty, so sales are not credited right now.',
    )
    expect(linkStatusLine({ working: false, paused_reason: null })).toBe(
      'Paused: sales are not credited right now.',
    )
  })

  it('counts the custom links that are used and left', () => {
    expect(customLinksUsed(program, 20)).toBe('1 of 20 custom links used')
    expect(customLinksLeft(program, 20)).toBe(19)
    const full = readLinkProgram(programRow({ custom_links: 23 }))
    expect(customLinksLeft(full, 20)).toBe(0)
    expect(customLinksUsed(full, 20)).toBe('20 of 20 custom links used')
  })

  it('checks a name before it is sent', () => {
    expect(linkNameProblem('', program)).toBe('Give the link a name.')
    expect(linkNameProblem('   ', program)).toBe('Give the link a name.')
    expect(linkNameProblem('x'.repeat(LINK_NAME_MAX), program)).toBeNull()
    expect(linkNameProblem('x'.repeat(LINK_NAME_MAX + 1), program)).toBe(
      'Use a name of 1 to 40 characters.',
    )
    // Forty characters, however many bytes each one takes.
    expect(linkNameProblem('é'.repeat(LINK_NAME_MAX), program)).toBeNull()
    for (const taken of ['Podcast', ' podcast ', 'TIKTOK', 'main link', 'Main   link'])
      expect(linkNameProblem(taken, program)).toBe(
        'You already have a link with that name. Pick another name.',
      )
    expect(linkNameProblem('Bio link', program)).toBeNull()
  })
})

describe('what each failure means', () => {
  const words: Record<ProgramLinksErrorCode, string> = {
    invalid_input: 'That could not be sent. Reload the page and try again.',
    invalid_name: 'Use a name of 1 to 40 characters.',
    name_taken: 'You already have a link with that name. Pick another name.',
    too_many_links: 'This program has all the custom links it can have.',
    not_member: 'You are no longer a member of this program.',
    link_in_use: 'This link has been opened, so it stays.',
    not_removable: 'This link cannot be removed.',
    link_not_found: 'This link is no longer there.',
    not_authenticated: 'Your session has expired. Sign in again to continue.',
    not_authorized: 'Your creator account is not active, so links are not available to it.',
    contract_unavailable: 'Links are not available yet.',
    not_configured: 'Links are not available yet.',
    temporarily_unavailable: 'That did not go through. Check your connection and try again.',
    invalid_response: 'The answer could not be read. Try again.',
    unknown: 'That did not go through. Try again.',
    not_found: 'That did not go through. Try again.',
    conflict: 'That did not go through. Try again.',
  }

  it.each(Object.entries(words) as [ProgramLinksErrorCode, string][])(
    'has plain words for %s',
    (code, sentence) => {
      const error = linkError(code)
      expect(error.code).toBe(code)
      expect(error.message).toBe(sentence)
      expect(linkErrorMessage(error)).toBe(sentence)
      // Never a code, never the database's own words.
      expect(sentence).not.toMatch(/_|SQL|permission denied|P0002|22023|42501/i)
    },
  )

  it('says who can change links when a change is refused', () => {
    expect(linkErrorMessage(linkError('not_authorized'), 'change')).toBe(
      'Your role on this creator account cannot change links.',
    )
    expect(linkErrorMessage(linkError('not_member'), 'change')).toBe(words.not_member)
    expect(linkErrorMessage(null)).toBe(words.unknown)
  })

  it('never shows a message it did not write', () => {
    expect(
      linkErrorMessage({ code: 'name_taken', message: 'duplicate key value', retryable: false }),
    ).toBe(words.name_taken)
    expect(
      linkErrorMessage({ code: 'unknown', message: 'relation does not exist', retryable: true }),
    ).toBe(words.unknown)
  })

  it.each([
    [{ code: '22023', details: 'invalid_input' }, 'invalid_input'],
    [{ code: '22023', details: 'invalid_name' }, 'invalid_name'],
    [{ code: '22023', details: 'name_taken' }, 'name_taken'],
    [{ code: '22023', details: 'too_many_links' }, 'too_many_links'],
    [{ code: '42501', details: 'not_member' }, 'not_member'],
    [{ code: '22023', details: 'link_in_use' }, 'link_in_use'],
    [{ code: '22023', details: 'not_removable' }, 'not_removable'],
    [{ code: 'P0002', details: 'link_not_found' }, 'link_not_found'],
    [{ code: 'P0002' }, 'link_not_found'],
    [{ code: '22023', details: ' name_taken\n' }, 'name_taken'],
    [{ code: '22023', details: 'invalid_link_id' }, 'invalid_input'],
  ] as const)('reads the database failure %o as %s', (failure, code) => {
    expect(linkFailure(failure)?.code).toBe(code)
  })

  it('leaves every other failure to the general mapping', () => {
    for (const failure of [
      { code: '42501' },
      { code: '42501', details: null },
      { code: '22023', details: 'Something else went wrong' },
      { code: 'PGRST301' },
      {},
    ])
      expect(linkFailure(failure)).toBeNull()
  })

  it('knows when links do not exist here, and when the page is out of date', () => {
    for (const code of ['contract_unavailable', 'not_configured', 'not_authorized'] as const)
      expect(linksUnavailable(linkError(code))).toBe(true)
    for (const code of ['temporarily_unavailable', 'invalid_response', 'unknown'] as const)
      expect(linksUnavailable(linkError(code))).toBe(false)
    expect(linksUnavailable(null)).toBe(false)

    for (const code of [
      'name_taken',
      'too_many_links',
      'not_member',
      'link_in_use',
      'not_removable',
      'link_not_found',
    ] as const)
      expect(staleAfter(linkError(code))).toBe(true)
    for (const code of ['invalid_name', 'temporarily_unavailable', 'unknown'] as const)
      expect(staleAfter(linkError(code))).toBe(false)
  })

  it('offers another try only where one can help', () => {
    expect(linkError('temporarily_unavailable').retryable).toBe(true)
    expect(linkError('unknown').retryable).toBe(true)
    for (const code of ['name_taken', 'link_in_use', 'not_authenticated'] as const)
      expect(linkError(code).retryable).toBe(false)
  })
})
