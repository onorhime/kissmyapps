// Sample answers of `partner_marketplace` and `partner_program_detail` for programs with a
// checkout link or a buyer discount, written by hand to the shape in the Phase 8 contract
// (Piece A, "Creator readers"): the cards and details are the public ones of
// marketplace/marketplace.phase8.fixture.ts, and the creator's membership gains
// `promo_code: {"code", "discount_bps", "status"} | null` (the reader also takes it beside the
// membership). To be joined by output captured from
// supabase/tests/database/90_program_checkout_promo.sql.
import {
  marketplacePhase8Cards as cards,
  marketplacePhase8Details as details,
} from '../../marketplace/marketplace.phase8.fixture'

const WHEN = '2026-11-02T09:14:07.512846+00:00'

function membership(
  number: number,
  program: Record<string, unknown>,
  programId: string,
  status: 'active' | 'pending',
) {
  return {
    id: `00000000-0000-4000-a000-${String(number).padStart(12, '0')}`,
    program_id: programId,
    program,
    program_status: 'live',
    status,
    terms_version: program.terms_version,
    accepted_at: WHEN,
    needs_new_terms: false,
    link:
      status === 'active'
        ? {
            url: `https://go.kissmyapps.dev/${String(program.slug)}/ada`,
            short_url: null,
            working: true,
          }
        : null,
    requested_at: WHEN,
    activated_at: status === 'active' ? WHEN : null,
    ended_at: null,
    decision_note: null,
  }
}

const code = (text: string, discountBps: number, status: string) => ({
  code: text,
  discount_bps: discountBps,
  status,
})

const fluentMember = membership(81, cards.fluentPro, details.fluentPro.id, 'active')
const speaksixMember = membership(82, cards.speaksix, details.speaksix.id, 'active')
const pocketChefWaiting = membership(83, cards.pocketChef, details.pocketChef.id, 'pending')

const member = (
  detail: Record<string, unknown>,
  membershipRow: Record<string, unknown>,
  promoCode: unknown,
) => ({
  program: detail,
  membership: { ...membershipRow, promo_code: promoCode },
  accept_name: 'Ada Okafor',
})

export const programsPhase8Fixture: Record<string, unknown> = {
  /** Every kind of program to join, and none joined yet. */
  marketplace_programs: {
    tracking_ready: true,
    programs: Object.values(cards).map((program) => ({ ...program, membership_status: null })),
    memberships: [],
  },
  /** A creator in three programs: a code ready, a code that could not be made, no discount. */
  marketplace_members: {
    tracking_ready: true,
    programs: Object.values(cards).map((program) => ({
      ...program,
      membership_status: ['fluent-pro', 'speaksix', 'pocket-chef'].includes(program.slug)
        ? 'active'
        : null,
    })),
    memberships: [
      { ...fluentMember, promo_code: code('ADAOKAFOR10', 1000, 'active') },
      { ...speaksixMember, promo_code: code('ADAOKAFOR15', 1500, 'failed') },
      {
        ...membership(84, cards.pocketChef, details.pocketChef.id, 'active'),
        promo_code: null,
      },
    ],
  },
  /** A checkout-link program before joining: the product, its price and the discount. */
  detail_checkout: { program: details.fluentPro, membership: null, accept_name: 'Ada Okafor' },
  /** A member of the checkout-link program whose code is ready to share. */
  detail_checkout_member: member(
    details.fluentPro,
    fluentMember,
    code('ADAOKAFOR10', 1000, 'active'),
  ),
  /** The same member while the code is being made on the brand's Stripe account. */
  detail_checkout_member_pending: member(
    details.fluentPro,
    fluentMember,
    code('ADAOKAFOR10', 1000, 'pending'),
  ),
  /** The same member when Stripe refused the code. */
  detail_checkout_member_failed: member(
    details.fluentPro,
    fluentMember,
    code('ADAOKAFOR10', 1000, 'failed'),
  ),
  /** A member of a program on its own checkout, with 15% off and a code ready to share. */
  detail_discount_member: member(
    details.speaksix,
    speaksixMember,
    code('ADAOKAFOR15', 1500, 'active'),
  ),
  /** Waiting for approval in a one-time checkout-link program with no discount. */
  detail_one_time_waiting: member(details.pocketChef, pocketChefWaiting, null),
}
