import { describe, expect, it } from 'vitest'
import { creatorBackendFixture as backend } from '../../../merchant/creator-backend.fixture'
import {
  programHeadline,
  programTermsLine,
  readProgramDetail,
  readProgramList,
} from '../../marketplace/model'
import {
  membershipStanding,
  readMembershipAnswer,
  readPartnerMarketplace,
  readPartnerProgramView,
  shareableLink,
} from './programs'

// The marketplace readers against what the database functions really return.
describe('marketplace readers and the real backend answers', () => {
  it('reads the public list', () => {
    const programs = readProgramList(backend.marketplace_programs)
    expect(programs.length).toBeGreaterThan(0)
    const speaksix = programs.find((program) => program.slug === 'speaksix')
    expect(speaksix).toMatchObject({
      name: 'SpeakSix',
      category: 'education',
      brand_name: 'SpeakSix Ltd',
      commission_type: 'percent',
      commission_rate_bps: 3000,
      commission_duration: 'months',
      commission_months: 12,
      currency: 'USD',
      attribution_window_days: 30,
      hold_days: 30,
      minimum_payout_minor: 2000,
      approval_mode: 'automatic',
      terms_version: 1,
    })
    expect(programHeadline(speaksix!)).toBe('30% of every payment for 12 months')
    expect(programTermsLine(speaksix!)).toContain('30-day attribution')
  })

  it('reads one public program with its agreement', () => {
    const real = backend.marketplace_program as { program: unknown }
    const program = readProgramDetail(real.program)
    expect(program.status).toBe('live')
    expect(program.landing_url).toBe('https://speaksix.com/start')
    expect(program.agreement.title).toBe('SpeakSix Affiliate Agreement')
    expect(program.agreement.sections.length).toBeGreaterThan(5)
    expect(program.agreement_sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("reads a creator's marketplace and memberships", () => {
    const first = readPartnerMarketplace(backend.partner_marketplace)
    expect(first.tracking_ready).toBe(true)
    expect(first.programs.length).toBeGreaterThan(0)
    const mixed = readPartnerMarketplace(backend.partner_marketplace_mixed)
    expect(mixed.memberships.length).toBeGreaterThan(0)
    for (const membership of mixed.memberships) {
      expect(membership.program_id).toMatch(/^[0-9a-f-]{36}$/)
      expect(membership.program.slug).not.toBe('')
      expect(
        membershipStanding(membership.status, membership.program_status, membership.needs_new_terms)
          .label,
      ).not.toBe('')
    }
    expect(mixed.programs.some((program) => program.membership_status !== null)).toBe(true)
  })

  it('reads the program page of a member', () => {
    const view = readPartnerProgramView(backend.partner_program_detail)
    expect(view.program.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(view.program.agreement.title).toBe('SpeakSix Affiliate Agreement')
    expect(view.accept_name).toBeTruthy()
    expect(view.membership?.status).toBe('active')
    expect(view.membership?.program_id).toBe(view.program.id)
  })

  it('reads the answer to accepting on a program that approves automatically', () => {
    const membership = readMembershipAnswer(backend.join_automatic)
    expect(membership.status).toBe('active')
    expect(membership.link?.working).toBe(true)
    expect(shareableLink(membership.link!)).toMatch(/^https:\/\/go\.kissmyapps\.dev\//)
    expect(Number.isNaN(new Date(membership.accepted_at!).getTime())).toBe(false)
  })

  it('reads the answer to asking to join a program that approves each creator', () => {
    const membership = readMembershipAnswer(backend.join_manual)
    expect(membership.status).toBe('pending')
    expect(membership.link).toBeNull()
  })

  it('reads the answers to leaving and to accepting new terms', () => {
    const left = readMembershipAnswer(backend.leave)
    expect(left.status).toBe('left')
    expect(left.ended_at).not.toBeNull()
    expect(left.link?.working).toBe(false)
    const accepted = readMembershipAnswer(backend.accept_terms)
    expect(accepted.terms_version).toBe(2)
    expect(accepted.needs_new_terms).toBe(false)
  })
})
