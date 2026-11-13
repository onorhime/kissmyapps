import { describe, expect, it } from 'vitest'
import { programBackendFixture as before } from './program-backend.fixture'
import { programRewardsBackendFixture as backend } from './program-rewards-backend.fixture'
import {
  asksEarnFrom,
  changedInput,
  draftEarning,
  draftFromProgram,
  draftProgress,
  earnHeadline,
  inputFromDraft,
  readAgreement,
  readRewardEvents,
  readState,
  validateDraft,
} from './programs'

// The program form's readers against what the Phase 6 database functions really return
// (suite 84_program_reward_terms.sql), and against an answer from before Phase 6.
describe('program readers and the real backend answers, paying for events', () => {
  it('reads an answer from before Phase 6 exactly as it did, and keeps today’s form', () => {
    const state = readState(before.state_draft)
    expect(state).not.toHaveProperty('events_available')
    for (const key of ['earn_from', 'rewards', 'reward_budget_minor'])
      expect(state.program).not.toHaveProperty(key)
    expect(asksEarnFrom(state)).toBe(false)
    // No question, no rewards, no budget, and nothing new is sent.
    const draft = draftFromProgram(state.program, asksEarnFrom(state))
    expect(draft).toEqual(draftFromProgram(state.program))
    for (const key of ['earnFrom', 'rewards', 'budget']) expect(draft).not.toHaveProperty(key)
    expect(changedInput(draft, state.program)).toEqual({ revision: state.program?.revision })
    const input = inputFromDraft(draft)
    for (const key of ['earn_from', 'rewards', 'reward_budget_minor'])
      expect(input).not.toHaveProperty(key)
  })

  it('reads an events draft: what it pays for, its rewards and its budget', () => {
    const state = readState(backend['workspace_program_get.events_draft'])
    expect(state.events_available).toBe(true)
    expect(asksEarnFrom(state)).toBe(true)
    expect(state.checklist.commission).toBe(true)
    expect(state.program).toMatchObject({
      status: 'draft',
      earn_from: 'events',
      approval_mode: 'manual',
      rewards: [
        { key: 'signup_completed', label: 'Account created', amount_minor: 200 },
        { key: 'trial_started', label: 'Trial started', amount_minor: 500 },
      ],
      reward_budget_minor: 50000,
    })
  })

  it('goes by what the program pays for, not by the commission it still has stored', () => {
    const program = readState(backend['workspace_program_get.events_draft']).program
    // An events program keeps the commission it once had, to come back if it pays for sales again.
    expect(program).toMatchObject({ commission_type: 'percent', commission_rate_bps: 3000 })
    const draft = draftFromProgram(program, true)
    expect(draft).toMatchObject({
      earnFrom: 'events',
      rewards: [
        { key: 'signup_completed', label: 'Account created', amount: '2.00' },
        { key: 'trial_started', label: 'Trial started', amount: '5.00' },
      ],
      budget: '500.00',
    })
    expect(validateDraft(draft)).toEqual({})
    expect(draftProgress(draft).commission).toBe(true)
    expect(draftEarning(draft)).toMatchObject({ commission_type: null, commission_rate_bps: null })
    // Untouched, nothing is sent; a commission typed while events are chosen is not sent either.
    expect(changedInput(draft, program)).toEqual({ revision: program?.revision })
    expect(changedInput({ ...draft, percent: '45' }, program)).toEqual({
      revision: program?.revision,
    })
    // Paying for both brings the stored commission back as it was, so only the choice is sent.
    expect(changedInput({ ...draft, earnFrom: 'both' }, program)).toEqual({
      earn_from: 'both',
      revision: program?.revision,
    })
  })

  it('says what creators earn in the words of the agreement', () => {
    const summary = (name: string, label: string) =>
      readAgreement(backend[name]).agreement?.summary.find((row) => row.label === label)?.value
    const events = draftFromProgram(
      readState(backend['workspace_program_get.events_draft']).program,
      true,
    )
    expect(earnHeadline(draftEarning(events))).toBe(
      summary('workspace_program_agreement.events', 'Rewards'),
    )
    expect(earnHeadline(draftEarning(events))).toBe(
      '$2.00 per Account created, $5.00 per Trial started',
    )
    const both = draftFromProgram(
      readState(backend['workspace_program_get.both_live']).program,
      true,
    )
    expect(earnHeadline(draftEarning(both))).toBe(
      `${summary('workspace_program_agreement.both', 'Commission')}, plus rewards`,
    )
    // The agreement for events is read like any other: whatever sections the database writes.
    const agreement = readAgreement(backend['workspace_program_agreement.events'])
    expect(agreement.complete).toBe(true)
    expect(agreement.agreement?.sections.map((section) => section.heading)).toContain('3. Rewards')
  })

  it('reads a live events program, one that pays for both, and one that pays for sales', () => {
    expect(readState(backend['workspace_program_get.events_live']).program).toMatchObject({
      status: 'live',
      earn_from: 'events',
      live_terms_version: 1,
      has_unpublished_changes: false,
    })
    const both = readState(backend['workspace_program_get.both_live']).program
    expect(both).toMatchObject({
      earn_from: 'both',
      commission_rate_bps: 2000,
      commission_months: 6,
      rewards: [{ key: 'chapter_read', label: 'First chapter read', amount_minor: 150 }],
      reward_budget_minor: 30000,
    })
    const sales = readState(backend['workspace_program_get.sales_live'])
    expect(sales.program?.earn_from).toBe('sales')
    // A sales program keeps rewards it once had; the form neither shows nor sends them.
    expect(sales.program?.rewards).toHaveLength(1)
    const draft = draftFromProgram(sales.program, asksEarnFrom(sales))
    expect(draftEarning(draft).rewards).toEqual([])
    expect(earnHeadline(draftEarning(draft))).toBe('20% of every payment')
    expect(changedInput({ ...draft, budget: '1' }, sales.program)).toEqual({
      revision: sales.program?.revision,
    })
    // The question is asked because the workspace can pay for events.
    expect(asksEarnFrom(sales)).toBe(true)
  })

  it('reads the events a reward can be tied to, newest first as they come', () => {
    const events = readRewardEvents(backend['workspace_program_reward_events.listed'])
    expect(events.map((event) => event.name)).toEqual([
      'trial_started',
      'signup_completed',
      'lesson_finished',
    ])
    expect(events[1]).toEqual({
      name: 'signup_completed',
      description: 'An account was made',
      first_seen: '2026-09-20T08:00:00+00:00',
      last_seen: '2026-11-13T07:15:00+00:00',
    })
    expect(readRewardEvents(backend['workspace_program_reward_events.none'])).toEqual([])
  })
})
