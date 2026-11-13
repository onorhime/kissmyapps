import { describe, expect, it } from 'vitest'
import { countKinds, countOf, conversionOf, earnFromOf } from './earnFrom'
import {
  conversionRate,
  linkStatusLine,
  LinksUnreadable,
  readLinkProgram,
  readProgramLinks,
} from './links'
import { linksRewardsBackendFixture as backend } from './links.rewards-backend.fixture'

type Answer = { programs: Record<string, unknown>[] }

const programOf = (key: string, slug: string) =>
  (backend[key] as Answer).programs.find((program) => program.slug === slug)!

/** A copy of one program of a real answer with one part changed. */
function changedProgram(change: (program: Record<string, unknown>) => void) {
  const program = structuredClone(programOf('partner_program_links_both_program', 'rival-reader'))
  change(program)
  return program
}

// The creator's Links reader against what partner_program_links returns once a program can pay
// per event (suite 86 of the database tests).
describe("a creator's links and the real answers for programs that pay per event", () => {
  it('reads a program that pays for events: every link counts its events', () => {
    const links = readProgramLinks(backend.partner_program_links_events_program)
    expect(links.programs).toHaveLength(1)
    const [speaksix] = links.programs
    expect(speaksix).toMatchObject({ slug: 'speaksix', earn_from: 'events', working: true })
    expect(speaksix.links.every((link) => typeof link.events === 'number')).toBe(true)
    const main = speaksix.links.find((link) => link.kind === 'main')!
    expect([main.clicks, main.sales, main.events, main.earnings_minor]).toEqual([1, 0, 2, 700])
    expect(countKinds(earnFromOf(speaksix))).toEqual(['events'])
    // Events per click: two events from one click.
    expect(conversionRate(main.clicks, countOf(main, conversionOf('events')))).toBe('200.0%')
  })

  it('reads a creator in one program of each kind', () => {
    const links = readProgramLinks(backend.partner_program_links_both_program)
    expect(links.programs.map((program) => [program.name, program.earn_from])).toEqual([
      ['Quiet Club', 'sales'],
      ['Rival Reader', 'both'],
      ['SpeakSix', 'events'],
    ])
    const rival = links.programs[1]
    expect(
      rival.links
        .filter((link) => link.clicks > 0)
        .map((link) => [link.name, link.clicks, link.sales, link.events]),
    ).toEqual([
      ['Main link', 1, 2, 1],
      ['TikTok', 1, 0, 1],
    ])
    // A program that pays for both keeps converting clicks into sales.
    expect(conversionOf('both')).toBe('sales')
    const speaksix = links.programs[2]
    expect(speaksix.links.find((link) => link.kind === 'custom')).toMatchObject({
      name: 'Podcast',
      events: 1,
      earnings_minor: 200,
    })
    expect(speaksix.custom_links).toBe(1)
  })

  it('reads the program a link was made in or removed from, with what it pays for', () => {
    // partner_program_link_create and partner_program_link_remove answer with one program
    // exactly as it is in the list.
    const program = readLinkProgram(programOf('partner_program_links_both_program', 'speaksix'))
    expect(program.earn_from).toBe('events')
    expect(program.links.map((link) => link.events)).toEqual([0, 3, 1, 0, 0, 0, 0, 1])
  })

  it('says what a paused program does not credit, in its own words', () => {
    expect(
      linkStatusLine({ working: false, paused_reason: 'program_paused', earn_from: 'events' }),
    ).toBe('Paused by the brand: events are not credited right now.')
    expect(
      linkStatusLine({ working: false, paused_reason: 'balance_empty', earn_from: 'both' }),
    ).toBe('Paused: the brand’s balance is empty, so sales and events are not credited right now.')
    expect(linkStatusLine({ working: false, paused_reason: 'program_paused' })).toBe(
      'Paused by the brand: sales are not credited right now.',
    )
  })

  it('finds nobody in the answers: no email, no person, no event id', () => {
    for (const answer of Object.values(backend)) {
      const text = JSON.stringify(answer)
      expect(text).not.toContain('@')
      expect(text).not.toMatch(/"(event_id|session_id|person_id|external_id|user_id)"/)
    }
  })

  it('refuses a program it cannot read rather than guessing', () => {
    const refusals = [
      changedProgram((program) => {
        program.earn_from = 'installs'
      }),
      changedProgram((program) => {
        ;(program.links as Record<string, unknown>[])[0].events = -2
      }),
      changedProgram((program) => {
        ;(program.links as Record<string, unknown>[])[1].events = 'many'
      }),
    ]
    for (const program of refusals) expect(() => readLinkProgram(program)).toThrow(LinksUnreadable)
  })

  it('reads a program from before Phase 6 to the same object as ever', () => {
    const now = programOf('partner_program_links_both_program', 'quiet-club')
    const before = {
      ...now,
      earn_from: undefined,
      links: (now.links as Record<string, unknown>[]).map(({ events: _events, ...link }) => link),
    }
    const read = readLinkProgram(before)
    expect(Object.keys(read)).not.toContain('earn_from')
    expect(read.links.every((link) => !('events' in link))).toBe(true)
  })
})
