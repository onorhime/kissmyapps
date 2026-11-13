import { describe, expect, it } from 'vitest'
import { programBackendFixture as backend } from './program-backend.fixture'
import {
  commissionHeadline,
  draftFromProgram,
  readAgreement,
  readState,
  readTracking,
  trackingLine,
} from './programs'

// The readers against what the database functions really return.
describe('program readers and the real backend answers', () => {
  it('reads a first draft', () => {
    const state = readState(backend.state_draft)
    expect(state.can_manage).toBe(true)
    expect(state.stripe_connected).toBe(true)
    expect(state.brand_name).toBe('Lingo Ltd')
    expect(state.can_submit).toBe(false)
    expect(state.checklist).toEqual({
      stripe_connected: true,
      details: true,
      landing_page: true,
      commission: true,
      agreement_read: false,
    })
    expect(state.program).toMatchObject({
      status: 'draft',
      name: 'Lingo',
      category: 'education',
      landing_url: 'https://lingo-app.io/start',
      commission_type: 'percent',
      commission_rate_bps: 3000,
      commission_fixed_minor: null,
      commission_duration: 'months',
      commission_months: 12,
      currency: 'USD',
      attribution_window_days: 30,
      hold_days: 30,
      minimum_payout_minor: 2000,
      approval_mode: 'automatic',
      marketplace_listed: true,
      agreement_read: false,
      has_unpublished_changes: false,
      live_terms_version: null,
    })
    expect(state.program?.revision).toBeGreaterThan(0)
    expect(state.program?.updated_at).not.toBeNull()
  })

  it('turns the saved program back into the form and its headline', () => {
    const program = readState(backend.state_draft).program
    const draft = draftFromProgram(program)
    expect(draft.name).toBe('Lingo')
    expect(commissionHeadline(program!)).toBe('30% of every payment for 12 months')
  })

  it('reads the generated agreement', () => {
    const answer = readAgreement(backend.agreement)
    expect(answer.complete).toBe(true)
    expect(answer.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(answer.agreement?.title).toBe('Lingo Affiliate Agreement')
    expect(answer.agreement?.brand_name).toBe('Lingo Ltd')
    expect(answer.agreement?.summary[0]).toEqual({
      label: 'Commission',
      value: '30% of every payment for 12 months',
    })
    expect(answer.agreement?.sections).toHaveLength(11)
    expect(answer.agreement?.sections.every((section) => section.paragraphs.length > 0)).toBe(true)
    expect(answer.agreement?.extra_terms).toBeNull()
  })

  it('reads each status the program passes through', () => {
    expect(readState(backend.state_in_review).program).toMatchObject({
      status: 'in_review',
      agreement_read: true,
    })
    const live = readState(backend.state_live)
    expect(live.program).toMatchObject({
      status: 'live',
      pause_reason: null,
      live_terms_version: 1,
      has_unpublished_changes: false,
    })
    expect(live.program?.first_published_at).not.toBeNull()
    expect(live.can_submit).toBe(false)
    expect(readState(backend.state_admin_paused).program).toMatchObject({
      status: 'paused',
      pause_reason: 'admin',
      review_note: 'The landing page is down.',
    })
    const disconnected = readState(backend.state_stripe_paused)
    expect(disconnected.stripe_connected).toBe(false)
    expect(disconnected.program).toMatchObject({
      status: 'paused',
      pause_reason: 'stripe_disconnected',
    })
  })

  it('reads the sale tracking status and says a tagged sale was seen', () => {
    const tracking = readTracking(backend.tracking)
    expect(tracking).toMatchObject({
      connected: true,
      payments_seen: 2,
      tagged_payments: 1,
      sales: 2,
      matched_sales: 2,
      last_match_source: 'metadata',
    })
    expect(tracking.last_matched_at).not.toBeNull()
    expect(tracking.sdk_click_seen_at).not.toBeNull()
    expect(trackingLine(tracking, Date.parse(tracking.last_matched_at!) + 3_600_000).tone).toBe(
      'on',
    )
  })
})
