import { describe, expect, it } from 'vitest'
import { marketplaceBackendFixture as backend } from './marketplace-backend.fixture'
import {
  programHeadline,
  programRewardsLine,
  programTermsLine,
  readProgramDetail,
  readProgramList,
} from './model'

// The marketplace readers against what the database functions really return for programs that
// pay per event.
describe('marketplace readers and the real answers for programs that pay per event', () => {
  it('reads a list with a sales, an events and a both program, and says what each pays', () => {
    const programs = readProgramList(backend.marketplace_programs_mixed)
    expect(programs.map((program) => [program.slug, program.earn_from])).toEqual([
      ['rival-reader', 'both'],
      ['fluent', 'events'],
      ['quiet-club', 'sales'],
    ])
    const [both, events, sales] = programs
    expect(events).toMatchObject({
      commission_type: null,
      rewards: [
        { key: 'account_created', label: 'Account created', amount_minor: 300 },
        { key: 'trial_started', label: 'Trial started', amount_minor: 500 },
        { key: 'lesson_finished', label: 'First lesson', amount_minor: 100 },
      ],
    })
    expect(programHeadline(events)).toBe(
      '$3.00 per Account created, $5.00 per Trial started and 1 more reward',
    )
    expect(programRewardsLine(events)).toBeNull()
    expect(programHeadline(both)).toBe('20% of every payment for 6 months, plus rewards')
    expect(programRewardsLine(both)).toBe('$1.50 per First chapter read')
    expect(programHeadline(sales)).toBe('20% of every payment')
    expect(sales.rewards).toEqual([])
    expect(programTermsLine(sales)).toBe('30-day attribution · 14-day hold')
  })

  it('reads an events program and a both program with their agreements', () => {
    const events = readProgramDetail(backend.marketplace_program_events.program)
    expect(events).toMatchObject({ slug: 'fluent', earn_from: 'events', status: 'live' })
    expect(events.agreement.summary[0]).toEqual({
      label: 'Rewards',
      value: '$3.00 per Account created, $5.00 per Trial started, $1.00 per First lesson',
    })
    const both = readProgramDetail(backend.marketplace_program_both.program)
    expect(both).toMatchObject({ slug: 'rival-reader', earn_from: 'both' })
    // The agreement and the page say the same about the commission.
    expect(both.agreement.summary[0]).toEqual({
      label: 'Commission',
      value: '20% of every payment for 6 months',
    })
    expect(programHeadline(both)).toBe(`${both.agreement.summary[0].value}, plus rewards`)
    expect(programRewardsLine(both)).toBe(both.agreement.summary[1].value)
  })
})
