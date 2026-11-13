/**
 * Program review rows as `list_admin_program_reviews` returns them (the Phase 2 contract's
 * JSON, with timestamps as Postgres writes them), for tests and local previews. Not
 * production data.
 */
export const programWorkspaceId = '7c3f2f6e-52c1-4c9a-9d0b-3f6c1a2b4d5e'

export const agreementFixture = {
  title: 'SpeakSix Affiliate Agreement',
  brand_name: 'SpeakSix Ltd',
  program_name: 'SpeakSix',
  summary: [
    { label: 'Commission', value: '30% of every payment for 12 months' },
    { label: 'Attribution window', value: '30 days' },
    { label: 'Hold before payout', value: '30 days' },
    { label: 'Minimum payout', value: '$20.00' },
  ],
  sections: [
    {
      heading: '1. Who this agreement is between',
      paragraphs: [
        'This agreement is between you, the creator, and SpeakSix Ltd. KissMyApps tracks sales and pays commission on behalf of SpeakSix Ltd.',
        'Accepting this agreement on KissMyApps is your signature. Nobody countersigns it.',
      ],
    },
    {
      heading: '2. Commission',
      paragraphs: [
        'You earn 30% of every payment a customer you referred makes in their first 12 months.',
      ],
    },
  ],
  extra_terms: null as string | null,
}

export function programRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    revision: 3,
    status: 'in_review',
    pause_reason: null,
    review_note: null,
    slug: 'speaksix',
    name: 'SpeakSix',
    category: 'education',
    tagline: 'Speak English with confidence in six weeks.',
    logo_path: `${programWorkspaceId}/logo.png`,
    landing_url: 'https://speaksix.com/start',
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
    marketplace_listed: true,
    extra_terms: null,
    agreement_read: true,
    has_unpublished_changes: false,
    live_terms_version: null,
    submitted_at: '2026-11-14T08:00:00.550058+00:00',
    reviewed_at: null,
    first_published_at: null,
    updated_at: '2026-11-14T08:00:00.550058+00:00',
    workspace_id: programWorkspaceId,
    workspace_name: 'SpeakSix',
    brand_name: 'SpeakSix Ltd',
    stripe_account_id: 'acct_1QK7dLSpeakSix01',
    stripe_country: 'GB',
    agreement: agreementFixture,
    ...overrides,
  }
}

/** A second program in the queue: a fixed amount, extra terms and no logo. */
export function fixedProgramRow(overrides: Record<string, unknown> = {}) {
  return programRow({
    id: 'a1b2c3d4-0000-4000-8000-000000000002',
    slug: 'ledgerly',
    name: 'Ledgerly',
    category: 'finance',
    tagline: 'Bookkeeping for freelancers who would rather be working.',
    logo_path: null,
    landing_url: 'https://ledgerly.app/',
    commission_type: 'fixed',
    commission_rate_bps: null,
    commission_fixed_minor: 2000,
    commission_duration: 'first_payment',
    commission_months: null,
    marketplace_listed: false,
    extra_terms: 'No discount codes in paid ads.',
    submitted_at: '2026-11-13T15:30:00.104233+00:00',
    workspace_id: '9d8c7b6a-1111-4222-8333-444455556666',
    workspace_name: 'Ledgerly Studio',
    brand_name: 'Ledgerly Inc',
    stripe_account_id: 'acct_1PZ3xQLedgerly02',
    stripe_country: 'US',
    agreement: {
      ...agreementFixture,
      title: 'Ledgerly Affiliate Agreement',
      brand_name: 'Ledgerly Inc',
      program_name: 'Ledgerly',
      summary: [{ label: 'Commission', value: '$20.00 on the first payment' }],
      sections: [
        ...agreementFixture.sections,
        {
          heading: '12. Additional terms from Ledgerly Inc',
          paragraphs: [
            'Ledgerly Inc added the terms below. They are part of this agreement, but they cannot reduce commission you have already earned.',
          ],
        },
      ],
      extra_terms: 'No discount codes in paid ads.',
    },
    ...overrides,
  })
}

export function reviewedRows(): Record<string, unknown>[] {
  return [
    programRow({
      id: 'a1b2c3d4-0000-4000-8000-000000000011',
      slug: 'habitloop',
      name: 'HabitLoop',
      status: 'live',
      workspace_name: 'HabitLoop',
      live_terms_version: 1,
      reviewed_at: '2026-11-12T10:00:00.811420+00:00',
      first_published_at: '2026-11-12T10:00:00.811420+00:00',
    }),
    programRow({
      id: 'a1b2c3d4-0000-4000-8000-000000000012',
      slug: 'mealmap',
      name: 'MealMap',
      status: 'paused',
      pause_reason: 'admin',
      workspace_name: 'MealMap Kitchen',
      live_terms_version: 1,
      reviewed_at: '2026-11-10T10:00:00.300127+00:00',
      first_published_at: '2026-11-10T10:00:00.300127+00:00',
    }),
    programRow({
      id: 'a1b2c3d4-0000-4000-8000-000000000013',
      slug: 'trailnotes',
      name: 'TrailNotes',
      status: 'paused',
      pause_reason: 'merchant',
      workspace_name: 'TrailNotes',
      live_terms_version: 2,
      reviewed_at: '2026-11-08T10:00:00.925501+00:00',
      first_published_at: '2026-11-08T10:00:00.925501+00:00',
    }),
    programRow({
      id: 'a1b2c3d4-0000-4000-8000-000000000014',
      slug: 'penpal',
      name: 'PenPal',
      status: 'changes_requested',
      review_note: 'The landing page returns a 404.',
      reviewed_at: '2026-11-07T16:20:00.044918+00:00',
      workspace_name: 'PenPal Labs',
    }),
  ]
}

export function reviewsResponse(
  waiting: Record<string, unknown>[] = [programRow()],
  reviewed: Record<string, unknown>[] = reviewedRows(),
) {
  return { programs: [...waiting, ...reviewed] }
}
