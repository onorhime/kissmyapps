import { describe, expect, it } from 'vitest'
import { amplitudeBackendFixture as amplitude } from './amplitude-backend.fixture'
import { AMPLITUDE_KEY, readDestinations } from './api'

type Body = Record<string, unknown>
const answer = (name: string) => structuredClone(amplitude[name]) as Body
const unreadable = expect.objectContaining({ code: 'response_unreadable' })

// The Amplitude reader against what the Phase 8 database functions really return
// (suite 92_analytics_destinations.sql).
describe('Amplitude reader and the real backend answers', () => {
  it('reads a saved Amplitude project: its region, the key’s last four and how sending goes', () => {
    expect(readDestinations(answer('analytics_destinations_get.saved'))).toEqual([
      {
        provider: 'amplitude',
        region: 'us',
        key_last4: 'beef',
        status: 'active',
        last_sent_at: null,
        last_error: null,
        sent_30d: 0,
        failed_30d: 0,
      },
    ])
    expect(readDestinations(answer('analytics_destinations_get.none'))).toEqual([])
  })

  it('reads a key Amplitude refused, and leaves out tools it has no card for', () => {
    const [saved] = (answer('analytics_destinations_get.saved') as { destinations: Body[] })
      .destinations
    const read = readDestinations({
      destinations: [
        { ...saved, status: 'paused', last_error: 'invalid_key', region: 'eu' },
        { ...saved, provider: 'mixpanel' },
      ],
    })
    expect(read).toHaveLength(1)
    expect(read[0]).toMatchObject({ status: 'paused', last_error: 'invalid_key', region: 'eu' })
  })

  it('refuses an answer it cannot trust, and never a whole key', () => {
    const [saved] = (answer('analytics_destinations_get.saved') as { destinations: Body[] })
      .destinations
    for (const change of [
      { region: 'asia' },
      { status: 'sending' },
      { key_last4: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaabeef' },
      { key_last4: null },
      { sent_30d: -1 },
      { failed_30d: '3' },
      { last_sent_at: 'today' },
    ])
      expect(() => readDestinations({ destinations: [{ ...saved, ...change }] })).toThrow(
        unreadable,
      )
    expect(() => readDestinations({})).toThrow(unreadable)
  })

  it('checks a key the way the database does: 32 letters 0-9 and a-f', () => {
    expect(AMPLITUDE_KEY.test('a'.repeat(28) + 'beef')).toBe(true)
    expect(AMPLITUDE_KEY.test('A'.repeat(28) + 'BEEF')).toBe(true)
    expect(AMPLITUDE_KEY.test('a'.repeat(31))).toBe(false)
    expect(AMPLITUDE_KEY.test('g'.repeat(32))).toBe(false)
  })
})
