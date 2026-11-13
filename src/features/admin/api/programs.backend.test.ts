import { describe, expect, it } from 'vitest'
import { programBackendFixture as backend } from '../../../merchant/program-backend.fixture'
import {
  mapAdminProgramReviews,
  mapAdminProgramStatusChange,
  mapAdminProgramStatusResult,
} from './programs'

// The admin mappers against what the database functions really return.
describe('admin program mappers and the real backend answers', () => {
  it('reads the review queue', () => {
    const { waiting, reviewed } = mapAdminProgramReviews(backend.admin_reviews_waiting)
    expect(reviewed).toHaveLength(0)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({
      status: 'in_review',
      name: 'Lingo',
      category: 'education',
      landingUrl: 'https://lingo-app.io/start',
      commissionType: 'percent',
      commissionRateBps: 3000,
      commissionDuration: 'months',
      commissionMonths: 12,
      currency: 'USD',
      marketplaceListed: true,
      brandName: 'Lingo Ltd',
      stripeAccountId: 'acct_LingoE2E',
      stripeCountry: 'GB',
    })
    expect(waiting[0].workspaceName).toBeTruthy()
    expect(waiting[0].submittedAt).toBeTruthy()
    expect(waiting[0].agreement?.title).toBe('Lingo Affiliate Agreement')
    expect(waiting[0].agreement?.sections).toHaveLength(11)
  })

  it('reads an approval, a pause and a lifted pause', () => {
    const id = mapAdminProgramReviews(backend.admin_reviews_waiting).waiting[0].id
    expect(mapAdminProgramStatusResult(backend.admin_review_result, id, ['live'])).toMatchObject({
      programId: id,
      status: 'live',
    })
    expect(mapAdminProgramStatusChange(backend.admin_pause_result, id, 'paused')).toMatchObject({
      status: 'paused',
      pauseReason: 'admin',
    })
    expect(mapAdminProgramStatusChange(backend.admin_lift_result, id, 'live')).toMatchObject({
      status: 'live',
      pauseReason: null,
    })
  })

  it('reads a reviewed program whose Stripe account was disconnected', () => {
    const { waiting, reviewed } = mapAdminProgramReviews(backend.admin_reviews_reviewed)
    expect(waiting).toHaveLength(0)
    expect(reviewed).toHaveLength(1)
    expect(reviewed[0]).toMatchObject({
      status: 'paused',
      pauseReason: 'stripe_disconnected',
      stripeAccountId: null,
      brandName: null,
    })
    expect(reviewed[0].reviewedAt).toBeTruthy()
    expect(reviewed[0].agreement?.title).toBe('Lingo Affiliate Agreement')
  })
})
