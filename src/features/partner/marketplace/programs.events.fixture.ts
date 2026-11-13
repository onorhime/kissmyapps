// Sample answers of `partner_marketplace` and `partner_program_detail` for programs that pay
// for events, written by hand to the shape in the Phase 6 contract (Piece 1, item 4): a card
// and a detail gain `earn_from` and `rewards`, and a program that pays for events only has no
// commission. To be joined by output captured from the database. The agreements here only
// stand in for what the database writes: read nothing into their wording.

const rewards = {
  fluent: [
    { key: 'signup_completed', label: 'Account created', amount_minor: 200 },
    { key: 'trial_started', label: 'Trial started', amount_minor: 500 },
  ],
  loopHabits: [{ key: 'account_created', label: 'Account created', amount_minor: 150 }],
  every: [
    { key: 'signup_completed', label: 'Account created', amount_minor: 100 },
    { key: 'profile_completed', label: 'Profile completed', amount_minor: 150 },
    { key: 'first_lesson_finished', label: 'First lesson finished', amount_minor: 250 },
    { key: 'trial_started', label: 'Trial started', amount_minor: 400 },
    { key: 'friend_invited', label: 'Friend invited to a shared study plan', amount_minor: 75 },
  ],
}

const noCommission = {
  commission_type: null,
  commission_rate_bps: null,
  commission_fixed_minor: null,
  commission_duration: null,
  commission_months: null,
}

/** Pays for sales, as a Phase 6 database sends such a card. */
const speaksix = {
  slug: 'speaksix',
  name: 'SpeakSix',
  category: 'education',
  tagline: 'Speak English with confidence in six weeks.',
  logo_path: null,
  brand_name: 'SpeakSix Ltd',
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
  terms_version: 1,
  earn_from: 'sales',
  rewards: [],
}

/** Pays for events only: a web funnel with no payment. */
const fluent = {
  slug: 'fluent',
  name: 'Fluent',
  category: 'education',
  tagline: 'Ten minutes of Spanish a day, free to start.',
  logo_path: null,
  brand_name: 'Fluent Labs',
  ...noCommission,
  currency: 'USD',
  attribution_window_days: 30,
  hold_days: 14,
  minimum_payout_minor: 2000,
  approval_mode: 'manual',
  terms_version: 1,
  earn_from: 'events',
  rewards: rewards.fluent,
}

/** Pays a commission on sales and a reward for an event. */
const loopHabits = {
  slug: 'loop-habits',
  name: 'Loop Habits',
  category: 'health_fitness',
  tagline: 'Build one habit at a time, with a streak that forgives a bad day.',
  logo_path: null,
  brand_name: 'Loop Habits GmbH',
  commission_type: 'percent',
  commission_rate_bps: 3000,
  commission_fixed_minor: null,
  currency: 'USD',
  commission_duration: 'first_payment',
  commission_months: null,
  attribution_window_days: 30,
  hold_days: 14,
  minimum_payout_minor: 2000,
  approval_mode: 'automatic',
  terms_version: 2,
  earn_from: 'both',
  rewards: rewards.loopHabits,
}

/** Every reward a program can have, one with a long name. */
const studyCircle = {
  ...fluent,
  slug: 'study-circle',
  name: 'Study Circle',
  tagline: 'Study plans you share with friends.',
  brand_name: 'Study Circle Oy',
  approval_mode: 'automatic',
  rewards: rewards.every,
}

/** Not a real hash: sixty-four characters of the right kind, made here. */
const AGREEMENT_HASH = '0123456789abcdef'.repeat(4)

function agreement(
  program: { name: string; brand_name: string; hold_days: number },
  summary: { label: string; value: string }[],
  earning: string[],
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
      { heading: '2. What you earn', paragraphs: earning },
      {
        heading: '3. How a reward is credited to you',
        paragraphs: [
          'Each reward is earned once per person, by the last creator link that person opened in the 30 days before.',
          `${program.brand_name} sets a monthly budget and KissMyApps a daily limit per creator. Rewards stop when either is reached.`,
          'Your own actions earn nothing.',
        ],
      },
      {
        heading: '4. Hold',
        paragraphs: [
          `A reward is held for ${program.hold_days} days. In that time ${program.brand_name} may reject it when it is fake, a duplicate or your own.`,
        ],
      },
    ],
    brand_name: program.brand_name,
    extra_terms: null,
    program_name: program.name,
  }
}

const fluentDetail = {
  ...fluent,
  id: '00000000-0000-4000-8000-000000000006',
  status: 'live',
  landing_url: 'https://fluent.example.test/start',
  agreement: agreement(
    fluent,
    [
      { label: 'Rewards', value: '$2.00 per Account created, $5.00 per Trial started' },
      { label: 'Counting window', value: '30 days' },
      { label: 'Hold before payout', value: '14 days' },
      { label: 'Minimum payout', value: '$20.00' },
    ],
    [
      'You earn $2.00 for each Account created and $5.00 for each Trial started.',
      'Sales earn nothing in this program.',
    ],
  ),
  agreement_sha256: AGREEMENT_HASH,
}

const loopHabitsDetail = {
  ...loopHabits,
  id: '00000000-0000-4000-8000-000000000003',
  status: 'live',
  landing_url: 'https://loophabits.example.test/',
  agreement: agreement(
    loopHabits,
    [
      { label: 'Commission', value: '30% of the first payment' },
      { label: 'Rewards', value: '$1.50 per Account created' },
      { label: 'Counting window', value: '30 days' },
      { label: 'Hold before payout', value: '14 days' },
    ],
    [
      'You earn 30% of the first payment credited to you.',
      'You also earn $1.50 for each Account created.',
    ],
  ),
  agreement_sha256: AGREEMENT_HASH,
}

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

const fluentMembership = membership(1, fluent, fluentDetail.id, 'active')
const loopHabitsMembership = membership(2, loopHabits, loopHabitsDetail.id, 'active')

export const programsEventsFixture: Record<string, unknown> = {
  /** Programs of each kind to join, and none joined yet. */
  marketplace_programs: {
    tracking_ready: true,
    programs: [speaksix, fluent, loopHabits, studyCircle].map((program) => ({
      ...program,
      membership_status: null,
    })),
    memberships: [],
  },
  /** A creator in a program of each kind. */
  marketplace_mixed: {
    tracking_ready: true,
    programs: [
      { ...speaksix, membership_status: 'active' },
      { ...fluent, membership_status: 'active' },
      { ...loopHabits, membership_status: 'active' },
      { ...studyCircle, membership_status: null },
    ],
    memberships: [
      fluentMembership,
      loopHabitsMembership,
      membership(3, speaksix, '00000000-0000-4000-8000-000000000001', 'active'),
    ],
  },
  /** A program that pays for events, before joining. The brand approves each creator. */
  detail_events: { program: fluentDetail, membership: null, accept_name: 'Ada Okafor' },
  /** The same program for a member with a link. */
  detail_events_member: {
    program: fluentDetail,
    membership: fluentMembership,
    accept_name: 'Ada Okafor',
  },
  /** A program that pays for sales and events, before joining. */
  detail_both: { program: loopHabitsDetail, membership: null, accept_name: 'Ada Okafor' },
  /** The same program for a member with a link. */
  detail_both_member: {
    program: loopHabitsDetail,
    membership: loopHabitsMembership,
    accept_name: 'Ada Okafor',
  },
}
