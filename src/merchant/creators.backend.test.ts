import { describe, expect, it } from 'vitest'
import { creatorBackendFixture as backend } from './creator-backend.fixture'
import { canApproveAgain, groupCreators, inviteLink, readCreators, readDecision } from './creators'

// The Creators page readers against what the database functions really return.
describe('creator readers and the real backend answers', () => {
  it('reads a program with pending and active creators', () => {
    const state = readCreators(backend.creators_mixed)
    expect(state.can_manage).toBe(true)
    expect(state.program).toMatchObject({
      slug: 'rival-reader',
      name: 'Rival Reader',
      status: 'live',
      approval_mode: 'manual',
      marketplace_listed: true,
    })
    expect(inviteLink(state.program!.slug!)).toBe('https://kissmyapps.dev/marketplace/rival-reader')
    expect(state.counts).toEqual({ pending: 2, active: 2, ended: 0 })
    expect(state.creators).toHaveLength(4)
    const groups = groupCreators(state.creators)
    expect(groups.pending.map((creator) => creator.name)).toEqual(['Dee Vale', 'Cy Park'])
    expect(groups.active).toHaveLength(2)
    const ada = state.creators.find((creator) => creator.handle === 'ada-okafor')
    expect(ada).toMatchObject({
      status: 'active',
      name: 'Ada Okafor',
      country_code: 'NG',
      channels: ['tiktok', 'instagram'],
      website_url: null,
      clicks: 0,
      sales: 0,
      last_click_at: null,
      terms_version: 1,
      needs_new_terms: false,
      decision_note: null,
    })
    expect(Number.isNaN(new Date(ada!.requested_at!).getTime())).toBe(false)
  })

  it('keeps a creator who asked again pending even though they were active before', () => {
    const cy = readCreators(backend.creators_mixed).creators.find(
      (creator) => creator.handle === 'cy-park',
    )
    expect(cy?.status).toBe('pending')
    expect(cy?.activated_at).not.toBeNull()
    expect(canApproveAgain(cy!)).toBe(false)
  })

  it('reads a program with one active creator and one that is waiting', () => {
    expect(readCreators(backend.creators_one_active).counts.active).toBe(1)
    const waiting = readCreators(backend.creators_pending)
    expect(waiting.counts.pending).toBeGreaterThan(0)
    expect(waiting.creators.some((creator) => creator.status === 'pending')).toBe(true)
  })

  it('reads the answer to an approval', () => {
    const creator = readDecision(backend.decide_approve)
    expect(creator).toMatchObject({
      status: 'active',
      name: 'Ben Creator',
      handle: 'ben-creator',
      website_url: 'https://ben.example.com',
      channels: ['youtube'],
    })
    expect(creator.member_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('never carries an email address', () => {
    expect(JSON.stringify(readCreators(backend.creators_mixed))).not.toContain('@')
  })
})
