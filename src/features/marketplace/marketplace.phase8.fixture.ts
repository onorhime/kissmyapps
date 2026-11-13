// Sample answers of the public marketplace functions (`marketplace_programs`,
// `marketplace_program`) for programs with a checkout link or a buyer discount, written by hand
// to the shape in the Phase 8 contract (Piece A, program fields and "Creator readers"): a card
// and a detail gain `payment_mode` ('own_checkout' | 'kma_checkout'), `checkout` (the product a
// checkout link sells: name, amount_minor, interval) and `buyer_discount_bps` (null, or 100 to
// 9000). To be replaced by the capture `marketplace_program.with_checkout` of
// supabase/tests/database/90_program_checkout_promo.sql. The dashboard's answers in
// partner/marketplace/programs.phase8.fixture.ts are built from these cards. The agreements
// only stand in for what the database writes: read nothing into their wording.

/** Not a real hash: sixty-four characters of the right kind, made here. */
const AGREEMENT_HASH = 'fedcba9876543210'.repeat(4)

/** A checkout link for a monthly plan, and 10% off with each creator's code. */
const fluentPro = {
  slug: 'fluent-pro',
  name: 'Fluent',
  category: 'education',
  tagline: 'Ten minutes of Spanish a day, with a tutor who answers back.',
  logo_path: null,
  brand_name: 'Fluent Labs',
  commission_type: 'percent',
  commission_rate_bps: 3000,
  commission_fixed_minor: null,
  currency: 'USD',
  commission_duration: 'months',
  commission_months: 12,
  attribution_window_days: 30,
  hold_days: 30,
  minimum_payout_minor: 2000,
  approval_mode: 'automatic',
  terms_version: 3,
  earn_from: 'sales',
  rewards: [],
  payment_mode: 'kma_checkout',
  checkout: { name: 'Fluent Pro', amount_minor: 999, interval: 'month' },
  buyer_discount_bps: 1000,
}

/** The merchant's own checkout, and 15% off with each creator's code. */
const speaksix = {
  ...fluentPro,
  slug: 'speaksix',
  name: 'SpeakSix',
  tagline: 'Speak English with confidence in six weeks.',
  brand_name: 'SpeakSix Ltd',
  terms_version: 2,
  payment_mode: 'own_checkout',
  checkout: null,
  buyer_discount_bps: 1500,
}

/** A checkout link for a one-time product, and no discount. */
const pocketChef = {
  ...fluentPro,
  slug: 'pocket-chef',
  name: 'Pocket Chef',
  category: 'food_drink',
  tagline: 'Recipes for what is already in your fridge.',
  brand_name: 'Pocket Chef Inc.',
  commission_type: 'fixed',
  commission_rate_bps: null,
  commission_fixed_minor: 1200,
  commission_duration: 'first_payment',
  commission_months: null,
  approval_mode: 'manual',
  terms_version: 1,
  checkout: { name: 'Pocket Chef Lifetime', amount_minor: 4900, interval: null },
  buyer_discount_bps: null,
}

/** A yearly plan in euros with a long product name, and the largest discount, 90%. */
const loopHabits = {
  ...fluentPro,
  slug: 'loop-habits',
  name: 'Loop Habits',
  category: 'health_fitness',
  tagline: 'Build one habit at a time, with a streak that forgives a bad day.',
  brand_name: 'Loop Habits GmbH',
  currency: 'EUR',
  commission_duration: 'lifetime',
  commission_months: null,
  terms_version: 1,
  checkout: {
    name: 'Loop Habits Premium for Families and Small Teams, Yearly',
    amount_minor: 7900,
    interval: 'year',
  },
  buyer_discount_bps: 9000,
}

/** The merchant's own checkout and no discount, as a Phase 8 database sends it. */
const fieldnote = {
  ...speaksix,
  slug: 'fieldnote',
  name: 'Fieldnote',
  category: 'productivity',
  tagline: 'Voice notes that turn into tidy meeting minutes.',
  brand_name: 'Fieldnote GmbH',
  commission_type: 'fixed',
  commission_rate_bps: null,
  commission_fixed_minor: 800,
  commission_duration: 'first_payment',
  commission_months: null,
  buyer_discount_bps: null,
}

function agreement(
  program: { name: string; brand_name: string },
  summary: { label: string; value: string }[],
  buying: string[],
) {
  return {
    title: `${program.name} Affiliate Agreement`,
    summary,
    sections: [
      {
        heading: '1. Who this agreement is between',
        paragraphs: [
          `This agreement is between you, the creator, and ${program.brand_name}, the business behind ${program.name}. KissMyApps is the platform the program runs on.`,
        ],
      },
      {
        heading: '2. What you earn',
        paragraphs: ['You earn 30% of every payment credited to you for 12 months.'],
      },
      { heading: '3. How buyers pay', paragraphs: buying },
      {
        heading: '4. Hold',
        paragraphs: [
          `A commission is held for 30 days. In that time ${program.brand_name} may reject it when the payment is refunded.`,
        ],
      },
    ],
    brand_name: program.brand_name,
    extra_terms: null,
    program_name: program.name,
  }
}

const summary = [
  { label: 'Commission', value: '30% of every payment for 12 months' },
  { label: 'Attribution window', value: '30 days' },
  { label: 'Hold before payout', value: '30 days' },
  { label: 'Minimum payout', value: '$20.00' },
]

const fluentProDetail = {
  ...fluentPro,
  id: '00000000-0000-4000-8000-000000000081',
  status: 'live',
  landing_url: 'https://kissmyapps.dev/checkout/fluent-pro',
  agreement: agreement(fluentPro, summary, [
    'Your link opens a checkout for Fluent Pro at $9.99 a month, on Fluent Labs’ own Stripe account.',
    'Buyers get 10% off with your promo code. A sale that uses your code is credited to you.',
  ]),
  agreement_sha256: AGREEMENT_HASH,
}

const speaksixDetail = {
  ...speaksix,
  id: '00000000-0000-4000-8000-000000000082',
  status: 'live',
  landing_url: 'https://speaksix.example.test/start',
  agreement: agreement(speaksix, summary, [
    'Buyers pay on SpeakSix’s own checkout.',
    'Buyers get 15% off with your promo code. A sale that uses your code is credited to you.',
  ]),
  agreement_sha256: AGREEMENT_HASH,
}

const pocketChefDetail = {
  ...pocketChef,
  id: '00000000-0000-4000-8000-000000000083',
  status: 'live',
  landing_url: 'https://kissmyapps.dev/checkout/pocket-chef',
  agreement: agreement(pocketChef, summary, [
    'Your link opens a checkout for Pocket Chef Lifetime at $49.00, paid once.',
  ]),
  agreement_sha256: AGREEMENT_HASH,
}

export const marketplacePhase8Cards = { fluentPro, speaksix, pocketChef, loopHabits, fieldnote }

export const marketplacePhase8Details = {
  fluentPro: fluentProDetail,
  speaksix: speaksixDetail,
  pocketChef: pocketChefDetail,
}

export const marketplacePhase8Fixture: Record<string, unknown> = {
  /** The list: two checkout links, one own checkout with a discount, one with neither. */
  marketplace_programs: { programs: [fluentPro, speaksix, pocketChef, loopHabits, fieldnote] },
  /** A checkout link for a monthly plan with 10% off. */
  marketplace_program_with_checkout: { program: fluentProDetail },
  /** The merchant's own checkout with 15% off. */
  marketplace_program_discount: { program: speaksixDetail },
  /** A checkout link for a one-time product with no discount. */
  marketplace_program_one_time: { program: pocketChefDetail },
}
