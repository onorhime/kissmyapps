import { discountPercent, oneOf, record } from '../../marketplace/model'

/**
 * A creator's promo code in one program: what the `partner_program_links` programs and the
 * `partner_program_detail` answer carry as `promo_code`, read into a shape the pages can trust,
 * and the words for each of its states. The code is made on the merchant's Stripe account by a
 * worker, so it is first being made, then ready to share, or it could not be made.
 */

/** Being made, ready to share, or refused by Stripe. A retired code is never shown. */
export type PromoCodeStatus = 'pending' | 'active' | 'failed'

export interface PromoCode {
  /** What a buyer types: capitals and digits, 3 to 20 of them ("ANNA10"). */
  code: string
  /** The discount it gives buyers, 100 to 9000 (10% is 1000). */
  discount_bps: number
  status: PromoCodeStatus
}

/** What a page shows of a code: only a ready code is shown with its letters. */
export type PromoCodeShown =
  | { status: 'active'; code: string; discount_bps: number }
  | { status: 'pending' | 'failed'; discount_bps: number }

const CODE = /^[A-Z0-9]{3,20}$/
const STATUSES = ['pending', 'active', 'failed', 'retired'] as const

/**
 * The code to show; undefined when there is none (no key, null, or a retired code); null when
 * the value is not a promo code, so the caller refuses the whole answer as it does any other
 * malformed part of it.
 */
export function readPromoCode(value: unknown): PromoCode | undefined | null {
  if (value === undefined || value === null) return undefined
  const row = record(value)
  const status = oneOf(row?.status, STATUSES)
  const bps = row?.discount_bps
  if (
    !row ||
    !status ||
    typeof row.code !== 'string' ||
    !CODE.test(row.code) ||
    typeof bps !== 'number' ||
    !Number.isSafeInteger(bps) ||
    bps < 100 ||
    bps > 9000
  )
    return null
  if (status === 'retired') return undefined
  return { code: row.code, discount_bps: bps, status }
}

// Words -------------------------------------------------------------------------------------

/** "Your code ANNA10 gives buyers 10% off", and what being made or failing means. */
export function promoCodeLine(promo: PromoCodeShown, brand: string | null = null): string {
  const off = `${discountPercent(promo.discount_bps)}\u00a0off`
  if (promo.status === 'active') return `Your code ${promo.code} gives buyers ${off}`
  if (promo.status === 'pending')
    return `Your code for ${off} is being made. It shows here when it is ready to share.`
  return `Your code for ${off} could not be made. ${brand ?? 'The brand'} has been told.`
}

/**
 * The quieter line under a code: how a sale that uses it finds the creator, and on a checkout
 * link that the link applies it by itself. Null while it is being made.
 */
export function promoCodeNote(promo: PromoCodeShown, appliedByLink = false): string | null {
  if (promo.status === 'pending') return null
  if (promo.status === 'failed') return 'Your link still works.'
  const credited = 'A sale that uses your code is credited to you, even without your link.'
  return appliedByLink
    ? `Buyers who open your link get the discount without typing it. ${credited}`
    : credited
}
