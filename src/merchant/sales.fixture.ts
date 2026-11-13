// What the Phase 5 database functions are to return for the merchant console, written by hand
// to the shapes in the Phase 5 contract: `workspace_program_creators` with its money keys and
// `workspace_program_sales`. The Creators and Sales readers are tested against it.
// At integration it is replaced by output captured from the database suite
// supabase/tests/database/83_program_links.sql (one "capture <name>" line per answer), so the
// reader tests rely on the shapes here and not on these exact figures.

const PROGRAM = {
  id: 'ffd99d2b-7de8-4861-9c3d-42b0d07731c5',
  slug: 'speaksix',
  name: 'SpeakSix',
  status: 'live',
}

const ADA = '0a6f2f4e-58d1-4a62-9a35-2f1c6f0d7a11'
const LENA = '3c1d9b7a-6e52-4f0b-8d44-90b1e2a7c522'
const KWAME = '7e2a4c18-1b93-4d6e-a5f7-c3d8094be633'
const MEI = 'b84d5e02-9c17-4a3b-b6e8-1d7f2a60c744'
const JONAS = 'd95e6f13-ad28-4b4c-87f9-2e803b71d855'

/** One sale as `workspace_program_sales` lists it. */
const sale = (over: Record<string, unknown>) => ({
  sale_id: '00000000-0000-4000-8000-000000000000',
  paid_at: '2026-11-13T09:41:07.120045+00:00',
  amount_minor: 4900,
  refunded_minor: 0,
  member_id: ADA,
  creator_name: 'Ada Okafor',
  link_name: 'TikTok',
  match_source: 'metadata',
  status: 'pending',
  reason: null,
  commission_minor: 1470,
  fee_minor: 147,
  hold_until: '2026-12-13T09:41:07.120045+00:00',
  ...over,
})

/** A creator as `workspace_program_creators` lists them from Phase 5 on. */
const creator = (over: Record<string, unknown>) => ({
  member_id: ADA,
  status: 'active',
  name: 'Ada Okafor',
  handle: 'ada-okafor',
  country_code: 'NG',
  channels: ['tiktok', 'instagram'],
  website_url: null,
  requested_at: '2026-10-20T10:00:00.000000+00:00',
  activated_at: '2026-10-20T10:00:00.000000+00:00',
  ended_at: null,
  decision_note: null,
  terms_version: 1,
  needs_new_terms: false,
  clicks: 0,
  sales: 0,
  last_click_at: null,
  sales_amount_minor: 0,
  commission_minor: 0,
  pending_minor: 0,
  ...over,
})

const adaTikTok = sale({ sale_id: '5f0c1a10-0001-4c00-8a00-0000000000a1' })
const lenaMain = sale({
  sale_id: '5f0c1a10-0002-4c00-8a00-0000000000a2',
  paid_at: '2026-11-12T18:02:44.501200+00:00',
  amount_minor: 14900,
  member_id: LENA,
  creator_name: 'Lena Hoffmann',
  link_name: 'Main link',
  commission_minor: 4470,
  fee_minor: 447,
  hold_until: '2026-12-12T18:02:44.501200+00:00',
})
const kwameApproved = sale({
  sale_id: '5f0c1a10-0003-4c00-8a00-0000000000a3',
  paid_at: '2026-10-09T07:15:30.000000+00:00',
  amount_minor: 9900,
  member_id: KWAME,
  creator_name: 'Kwame Mensah',
  link_name: 'YouTube',
  match_source: 'client_reference_id',
  status: 'approved',
  commission_minor: 2970,
  fee_minor: 297,
  hold_until: '2026-11-08T07:15:30.000000+00:00',
})
const lenaReturned = sale({
  sale_id: '5f0c1a10-0004-4c00-8a00-0000000000a4',
  paid_at: '2026-11-07T14:54:10.000000+00:00',
  refunded_minor: 4900,
  member_id: LENA,
  creator_name: 'Lena Hoffmann',
  link_name: 'Newsletter',
  status: 'returned',
  commission_minor: 0,
  fee_minor: 0,
  hold_until: '2026-12-07T14:54:10.000000+00:00',
})
const meiBalanceEmpty = sale({
  sale_id: '5f0c1a10-0005-4c00-8a00-0000000000a5',
  paid_at: '2026-11-06T11:20:00.000000+00:00',
  member_id: MEI,
  creator_name: 'Mei Tanaka',
  link_name: 'Instagram',
  status: 'not_earned',
  reason: 'balance_empty',
  commission_minor: 0,
  fee_minor: 0,
  hold_until: null,
})
const meiPaused = sale({
  sale_id: '5f0c1a10-0006-4c00-8a00-0000000000a6',
  paid_at: '2026-11-05T16:45:00.000000+00:00',
  member_id: MEI,
  creator_name: 'Mei Tanaka',
  link_name: 'Podcast episode 12',
  status: 'not_earned',
  reason: 'program_paused',
  commission_minor: 0,
  fee_minor: 0,
  hold_until: null,
})
const jonasNotMember = sale({
  sale_id: '5f0c1a10-0007-4c00-8a00-0000000000a7',
  paid_at: '2026-11-04T08:05:00.000000+00:00',
  member_id: JONAS,
  creator_name: 'Jonas Berg',
  link_name: 'Main link',
  match_source: 'subscription',
  status: 'not_earned',
  reason: 'not_a_member',
  commission_minor: 0,
  fee_minor: 0,
  hold_until: null,
})
const adaPartRefund = sale({
  sale_id: '5f0c1a10-0008-4c00-8a00-0000000000a8',
  paid_at: '2026-11-03T20:31:00.000000+00:00',
  amount_minor: 9900,
  refunded_minor: 2000,
  link_name: 'Instagram',
  commission_minor: 2370,
  fee_minor: 237,
  hold_until: '2026-12-03T20:31:00.000000+00:00',
})
const adaEarly = sale({
  sale_id: '5f0c1a10-0009-4c00-8a00-0000000000a9',
  paid_at: '2026-10-21T12:00:00.000000+00:00',
  link_name: null,
  match_source: 'email',
  status: 'not_judged',
  commission_minor: null,
  fee_minor: null,
  hold_until: null,
})
const kwameOlder = sale({
  sale_id: '5f0c1a10-0010-4c00-8a00-0000000000b0',
  paid_at: '2026-10-02T10:10:10.000000+00:00',
  member_id: KWAME,
  creator_name: 'Kwame Mensah',
  link_name: 'YouTube',
  status: 'approved',
  hold_until: '2026-11-01T10:10:10.000000+00:00',
})

const summary = {
  days: 30,
  sales: 70,
  sales_amount_minor: 343000,
  commission_minor: 102900,
  fee_minor: 10290,
}

export const salesFixture: Record<string, unknown> = {
  // workspace_program_creators, Phase 5: money per creator, the currency and the totals.
  creators_money: {
    can_manage: true,
    program: {
      id: PROGRAM.id,
      slug: PROGRAM.slug,
      name: PROGRAM.name,
      status: 'live',
      approval_mode: 'manual',
      marketplace_listed: true,
    },
    counts: { pending: 0, active: 4, ended: 1 },
    currency: 'USD',
    totals: {
      clicks: 4071,
      sales: 76,
      sales_amount_minor: 426400,
      commission_minor: 127920,
      pending_minor: 51450,
    },
    creators: [
      creator({
        member_id: LENA,
        name: 'Lena Hoffmann',
        handle: 'lena-hoffmann',
        country_code: 'DE',
        clicks: 1248,
        sales: 31,
        last_click_at: '2026-11-13T09:02:11.000000+00:00',
        sales_amount_minor: 151900,
        commission_minor: 45570,
        pending_minor: 14700,
      }),
      creator({
        clicks: 1840,
        sales: 32,
        last_click_at: '2026-11-13T11:48:00.000000+00:00',
        sales_amount_minor: 203800,
        commission_minor: 61140,
        pending_minor: 30870,
      }),
      creator({
        member_id: KWAME,
        name: 'Kwame Mensah',
        handle: 'kwame-mensah',
        country_code: 'GH',
        needs_new_terms: true,
        clicks: 412,
        sales: 7,
        last_click_at: '2026-11-11T12:00:00.000000+00:00',
        sales_amount_minor: 34300,
        commission_minor: 10290,
        pending_minor: 5880,
      }),
      creator({
        member_id: MEI,
        name: 'Mei Tanaka',
        handle: 'mei-tanaka',
        country_code: 'JP',
        activated_at: '2026-11-10T09:00:00.000000+00:00',
        clicks: 86,
        sales: 0,
      }),
      creator({
        member_id: JONAS,
        status: 'removed',
        name: 'Jonas Berg',
        handle: 'jonas-berg',
        country_code: 'SE',
        ended_at: '2026-11-09T12:00:00.000000+00:00',
        decision_note: 'Ads were bidding on the SpeakSix name.',
        clicks: 485,
        sales: 6,
        last_click_at: '2026-11-08T12:00:00.000000+00:00',
        sales_amount_minor: 36400,
        commission_minor: 10920,
        pending_minor: 0,
      }),
    ],
  },

  // workspace_program_sales, first page: every status, and more to ask for.
  sales_mixed: {
    program: PROGRAM,
    currency: 'USD',
    summary,
    sales: [
      adaTikTok,
      lenaMain,
      kwameApproved,
      lenaReturned,
      meiBalanceEmpty,
      meiPaused,
      jonasNotMember,
      adaPartRefund,
      adaEarly,
    ],
    next_before: adaEarly.paid_at,
  },

  // The page after it: asked with "before" = the next_before above. The last one.
  sales_next: {
    program: PROGRAM,
    currency: 'USD',
    summary,
    sales: [kwameOlder],
    next_before: null,
  },

  // Asked with member_id = Ada's. The summary still covers every creator.
  sales_one_creator: {
    program: PROGRAM,
    currency: 'USD',
    summary,
    sales: [adaTikTok, adaPartRefund, adaEarly],
    next_before: null,
  },

  // A program nobody has sold for yet.
  sales_empty: {
    program: PROGRAM,
    currency: 'USD',
    summary: { days: 30, sales: 0, sales_amount_minor: 0, commission_minor: 0, fee_minor: 0 },
    sales: [],
    next_before: null,
  },

  // A workspace without a program.
  sales_no_program: {
    program: null,
    currency: null,
    summary: { days: 30, sales: 0, sales_amount_minor: 0, commission_minor: 0, fee_minor: 0 },
    sales: [],
    next_before: null,
  },
}

/** The member the filtered answer was asked for. */
export const salesFixtureMember = ADA
