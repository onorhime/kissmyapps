// Sample answers of `partner_program_links` with promo codes, written by hand to the shape in
// the Phase 8 contract (Piece A, "Creator readers"): each program gains
// `promo_code: {"code", "discount_bps", "status"} | null`, null when the program gives buyers no
// discount. To be replaced by the capture `partner_program_links.with_code` of
// supabase/tests/database/90_program_checkout_promo.sql.
import { linksSampleFixture } from './links.fixture'

type Answer = { programs: Record<string, unknown>[] } & Record<string, unknown>

const sample = linksSampleFixture.partner_program_links as Answer
/** DramaPal, Loop Habits (paused: the balance is empty) and SpeakSix, as the Phase 5 sample. */
const [dramapal, loopHabits, speaksix] = sample.programs

const code = (text: string, discountBps: number, status: string) => ({
  code: text,
  discount_bps: discountBps,
  status,
})

const answer = (...programs: Record<string, unknown>[]) => ({ ...sample, programs })

export const linksPhase8Fixture: Record<string, unknown> = {
  /** A code of each state: DramaPal's is being made, Loop Habits gives none, SpeakSix's is ready. */
  with_codes: answer(
    { ...dramapal, promo_code: code('ADAOKAFOR15', 1500, 'pending') },
    { ...loopHabits, promo_code: null },
    { ...speaksix, promo_code: code('ADAOKAFOR10', 1000, 'active') },
  ),
  /** SpeakSix with a code ready to share. */
  promo_active: answer({ ...speaksix, promo_code: code('ADAOKAFOR10', 1000, 'active') }),
  /** SpeakSix while the code is being made on the brand's Stripe account. */
  promo_pending: answer({ ...speaksix, promo_code: code('ADAOKAFOR10', 1000, 'pending') }),
  /** SpeakSix when Stripe refused the code. */
  promo_failed: answer({ ...speaksix, promo_code: code('ADAOKAFOR10', 1000, 'failed') }),
  /** A code that was switched off: nothing to show. */
  promo_retired: answer({ ...speaksix, promo_code: code('ADAOKAFOR10', 1000, 'retired') }),
  /** A program with no buyer discount. */
  promo_none: answer({ ...speaksix, promo_code: null }),
  /** The longest code there can be, and the largest discount, on the narrowest screen. */
  promo_longest: answer({ ...speaksix, promo_code: code('ADAOKAFORCREATOR9099', 9000, 'active') }),
  /** SpeakSix after a custom link was added: the code comes back with the program. */
  link_create_with_code: {
    ...(linksSampleFixture.partner_program_link_create as Record<string, unknown>),
    promo_code: code('ADAOKAFOR10', 1000, 'active'),
  },
}
